// Section 6, the dashboard half: the vendored xterm files, the terminal panel
// markup, and the /term/<host> pop-out page.
//
// What is asserted here is everything a browser would need before it could draw
// a terminal, checked without one:
//
//   - GET /__wakeman/vendor/<file> serves the three checked-in files with their
//     content type and a long cache header, and revalidates on the ETag.
//   - the same route 404s anything that is not a plain name in lib/vendor/,
//     including the percent-encoded traversal the URL parser does NOT normalize
//     away, and a real file next to the directory.
//   - the dashboard carries the panel: a terminal button on every row, an
//     openTerm that opens one (it was a documented no-op before this), the
//     vendor URLs, and the pop-out link.
//   - GET /term/<host> is a page for that host and nothing else; an unknown
//     host is a 404.
//   - both pages' inline scripts PARSE. The panel client is a JS string built
//     inside a template literal inside another template literal, which is
//     exactly where a lost backslash hides, and the repo owner checks the UI
//     himself: this is the check a browser would otherwise be needed for.
//
// WAKEMAN_CONFIG and friends are set at module load, BEFORE the dynamic import
// of ../wakeman.mjs, so the daemon reads this file's throwaway state dir.
// Nothing here starts a dev server: every assertion is about bytes the daemon
// serves, and the rows render from the registry alone.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// --- fixtures ---------------------------------------------------------------

const ROOT = path.dirname(fileURLToPath(new URL('../wakeman.mjs', import.meta.url)));
const VENDOR_DIR = path.join(ROOT, 'lib', 'vendor');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-vendor-'));
const CONFIG_PATH = path.join(TMP, 'projects.json');

function projectDir(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  return dir;
}
const ALPHA_DIR = projectDir('alpha');
const BETA_DIR = projectDir('beta');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const ALPHA_PORT = await freePort();
const BETA_PORT = await freePort();

fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify(
    {
      port: 0,
      idleTimeoutMs: 300_000,
      projects: [
        { host: 'alpha', dir: ALPHA_DIR, port: ALPHA_PORT, startCmd: 'node server.js', enabled: true, framework: 'node' },
        { host: 'beta', dir: BETA_DIR, port: BETA_PORT, startCmd: 'node server.js', enabled: false, framework: 'node' },
      ],
    },
    null,
    2
  ) + '\n'
);

process.env.WAKEMAN_CONFIG = CONFIG_PATH;
process.env.WAKEMAN_CONTROL_TOKEN_PATH = path.join(TMP, 'control-token');
process.env.WAKEMAN_LOGS_DIR = path.join(TMP, 'logs');

const { createDaemonServer, loadConfig, ensureControlToken } = await import('../wakeman.mjs');

// --- plumbing ---------------------------------------------------------------

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Raw path on purpose: http.request does not re-encode what it is handed, so a
// test can ask for `..%2Ffoo` and have the daemon see exactly that.
function req(port, pathname, { host = 'wakeman.localhost', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    r.on('error', reject);
    r.end();
  });
}

// Every <script> block in a page, in order.
function scriptsIn(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

let daemon;
let port;
let token;

before(async () => {
  loadConfig('test:vendor');
  token = ensureControlToken();
  daemon = createDaemonServer();
  port = await listen(daemon);
});

after(() => {
  try {
    daemon.close();
  } catch {
    /* already down */
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// --- the vendored files -----------------------------------------------------

test('lib/vendor holds the pinned xterm files scripts/vendor.sh fetched', () => {
  for (const name of ['xterm.js', 'xterm.css', 'addon-fit.js', 'VERSIONS']) {
    assert.ok(fs.statSync(path.join(VENDOR_DIR, name)).size > 0, `${name} is missing or empty`);
  }
  const versions = fs.readFileSync(path.join(VENDOR_DIR, 'VERSIONS'), 'utf8');
  assert.match(versions, /@xterm\/xterm@5\.5\.0/);
  assert.match(versions, /@xterm\/addon-fit@/);
  // --check re-hashes what is on disk and exits non-zero for a missing file. It
  // touches the network for nothing, which is why it can run in the suite.
  execFileSync(path.join(ROOT, 'scripts', 'vendor.sh'), ['--check'], { stdio: 'pipe' });
});

test('the vendor route serves each file with a long cache header', async () => {
  const expect = {
    'xterm.js': 'text/javascript',
    'addon-fit.js': 'text/javascript',
    'xterm.css': 'text/css',
  };
  for (const [name, type] of Object.entries(expect)) {
    const res = await req(port, `/__wakeman/vendor/${name}`);
    assert.equal(res.status, 200, name);
    assert.match(res.headers['content-type'], new RegExp(type));
    // Long, and public: these bytes only change when someone runs vendor.sh.
    const cache = res.headers['cache-control'];
    assert.match(cache, /public/);
    const maxAge = Number(/max-age=(\d+)/.exec(cache)[1]);
    assert.ok(maxAge >= 86_400, `max-age ${maxAge} is not a long cache header`);
    // The bytes are the checked-in file, not a re-encoding of it.
    assert.deepEqual(res.body, fs.readFileSync(path.join(VENDOR_DIR, name)), name);
  }
});

test('a cached tab revalidates on the ETag instead of refetching 300 KB', async () => {
  const first = await req(port, '/__wakeman/vendor/xterm.js');
  const etag = first.headers.etag;
  assert.ok(etag, 'no ETag on the vendor response');
  const second = await req(port, '/__wakeman/vendor/xterm.js', { headers: { 'if-none-match': etag } });
  assert.equal(second.status, 304);
  assert.equal(second.body.length, 0);
});

test('the vendor route 404s anything outside lib/vendor/', async () => {
  // `..%2F` survives the URL parser (it normalizes `..` segments, not an
  // encoded slash), so this is the traversal that actually reaches the handler.
  const outside = [
    '/__wakeman/vendor/..%2Fpty.py',
    '/__wakeman/vendor/..%2F..%2Fpackage.json',
    '/__wakeman/vendor/%2Fetc%2Fpasswd',
    '/__wakeman/vendor/pty.py', // a real file, one directory up, right extension shape
    '/__wakeman/vendor/nope.js',
    '/__wakeman/vendor/VERSIONS', // served by neither type: this is a note to a human
    '/__wakeman/vendor/',
  ];
  for (const pathname of outside) {
    const res = await req(port, pathname);
    assert.equal(res.status, 404, `${pathname} was not refused`);
    assert.ok(!res.body.includes('import'), `${pathname} leaked file content`);
  }
  // And the file it was aiming at is really there to be leaked.
  assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'pty.py')));
});

// --- the panel in the dashboard ---------------------------------------------

test('the dashboard carries the terminal panel', async () => {
  const res = await req(port, '/');
  assert.equal(res.status, 200);
  const html = res.body.toString('utf8');

  // A terminal button on every row, disabled projects included: opening the
  // panel is itself the wake request.
  const buttons = html.match(/onclick="openTerm\(this\)">terminal<\/button>/g) || [];
  assert.equal(buttons.length, 2, 'expected one terminal button per row');
  // The failed row's error line is the same click target (section 4 left it as
  // a marked no-op waiting for this).
  assert.match(html, /class="errline" onclick="openTerm\(this\)"/);

  // openTerm opens a panel now. The old no-op said so in its own comment.
  assert.ok(!/section 6: open the row's terminal panel/.test(html), 'openTerm is still the no-op');
  assert.match(html, /function openTerm\(el\)/);
  assert.match(html, /openWakemanTerm\(/);
  assert.match(html, /loadTermVendor\(\)/);

  // The panel's own markup and header buttons.
  assert.match(html, /class="termpanel"/);
  assert.match(html, /class="termbox"/);
  for (const label of ['restart', 'stop', 'clear', 'pop out', 'close']) {
    assert.ok(html.includes('>' + label + '</button>'), `panel header is missing "${label}"`);
  }
  assert.match(html, /window\.open\('\/term\/' \+ encodeURIComponent\(host\)/);

  // The vendored files it loads, and the socket it opens.
  assert.match(html, /\/__wakeman\/vendor\/xterm\.js/);
  assert.match(html, /\/__wakeman\/vendor\/xterm\.css/);
  assert.match(html, /\/__wakeman\/vendor\/addon-fit\.js/);
  assert.match(html, /'\/__wakeman\/term\/' \+ encodeURIComponent\(host\)/);

  // Dark regardless of the page theme (spec section 6's stated default): the
  // panel paints its own background instead of inheriting the page's.
  assert.match(html, /\.termpanel \{[^}]*background: #0d1117/);
});

// --- the pop-out ------------------------------------------------------------

test('GET /term/<host> is that project and nothing else', async () => {
  const res = await req(port, '/term/alpha');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  const html = res.body.toString('utf8');
  assert.match(html, /<title>alpha — terminal<\/title>/);
  assert.match(html, /id="termbox"/);
  assert.match(html, /\/__wakeman\/vendor\/xterm\.js/);
  assert.match(html, /const HOST = "alpha"/);
  assert.ok(!html.includes('"beta"'), 'the pop-out page mentions another project');
  // Its own token, same as the dashboard's: the term socket takes it as the
  // WebSocket subprotocol.
  assert.ok(html.includes(JSON.stringify(token)));

  // A parked project still has a terminal page; opening it is how you find out
  // why it is parked.
  assert.equal((await req(port, '/term/beta')).status, 200);
});

test('GET /term/<unknown> is a 404 with the way back', async () => {
  const res = await req(port, '/term/nosuch');
  assert.equal(res.status, 404);
  const html = res.body.toString('utf8');
  assert.match(html, /No project registered as/);
  assert.match(html, /wakeman dashboard/);
});

// --- the part a browser would otherwise have to prove ------------------------

test('the inline scripts on both pages parse', async () => {
  for (const pathname of ['/', '/term/alpha']) {
    const html = (await req(port, pathname)).body.toString('utf8');
    const scripts = scriptsIn(html);
    assert.ok(scripts.length >= 1, `${pathname} has no inline script`);
    for (const [i, src] of scripts.entries()) {
      // Parse only; nothing here runs, and nothing here could (there is no
      // document). A thrown SyntaxError is the bug this test exists for.
      assert.doesNotThrow(() => new Function(src), `${pathname} script ${i} does not parse`);
    }
    // The terminal client is on both pages, from the one copy of it.
    assert.ok(scripts.some((s) => s.includes('function openWakemanTerm(')), `${pathname} is missing the terminal client`);
  }
});
