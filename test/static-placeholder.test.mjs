// Static placeholder tests: spec 0.3.0 section 8, "Static sites survive an npx
// cache prune".
//
// The scanner used to write `python3 "/abs/path/serve_static.py"` into the
// registry. Under npx that path is ~/.npm/_npx/<hash>/..., npm prunes it, and
// the static site dies with an ENOENT nobody reads. Now the registry holds the
// literal `$XERB_STATIC` and the daemon resolves it against the xerb.mjs
// that is running. These tests pin both halves: the expansion at spawn time
// (a real python3 serving a real file through the front door) and the one-time
// rewrite of a legacy entry on config load.
//
// ISOLATION: XERB_CONFIG / XERB_LOGS_DIR are read at module load, so they
// are assigned BEFORE the dynamic import of ../xerb.mjs. Everything lands in
// a temp dir: no real state dir, no LaunchAgent, no `xerb` binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-static-'));
const CONFIG_FILE = path.join(tmpDir, 'projects.json');
const LOGS = path.join(tmpDir, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

// The site the placeholder is supposed to serve: a folder with an index.html
// and no package.json, so bring-up goes straight to the spawn.
const SITE_DIR = path.join(tmpDir, 'site');
fs.mkdirSync(SITE_DIR, { recursive: true });
const INDEX_BODY = '<h1>served by the placeholder</h1>\n';
fs.writeFileSync(path.join(SITE_DIR, 'index.html'), INDEX_BODY);

fs.writeFileSync(CONFIG_FILE, JSON.stringify({ port: 0, projects: [] }));
process.env.XERB_CONFIG = CONFIG_FILE;
process.env.XERB_LOGS_DIR = LOGS;

const {
  createDaemonServer,
  loadConfig,
  getRuntime,
  stop,
  upstreamAgent,
  tailLog,
  STATIC_PLACEHOLDER,
  expandStartCmd,
  rewriteStaticStartCmds,
} = await import('../xerb.mjs');

// --- helpers ----------------------------------------------------------------

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

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function httpGet(port, hostHeader, reqPath = '/', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: reqPath, headers: { host: hostHeader, ...headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// A browser navigation: what gets the wake page instead of the plain 503.
const NAV = { accept: 'text/html', 'sec-fetch-mode': 'navigate' };

async function waitFor(pred, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function writeRegistry(reg) {
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(reg, null, 2)}\n`);
  loadConfig('test');
}

function closeServer(server) {
  try { server.closeAllConnections?.(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
}

// --- expansion --------------------------------------------------------------

test('the placeholder expands to serve_static.py next to the running xerb.mjs', () => {
  const expected = `python3 "${path.join(REPO_ROOT, 'serve_static.py')}"`;
  assert.equal(expandStartCmd(STATIC_PLACEHOLDER), expected);
  assert.equal(STATIC_PLACEHOLDER, '$XERB_STATIC', 'the placeholder string is the one the registry stores');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'serve_static.py')), 'the file it expands to ships in the package');
  // Surrounding whitespace is a hand-edited registry, not a different command.
  assert.equal(expandStartCmd(`  ${STATIC_PLACEHOLDER}\n`), expected);
});

test('every other startCmd passes through untouched', () => {
  for (const cmd of ['npm run dev', 'python3 /somewhere/else.py', 'bin/rails server -p 3000', '', null, undefined]) {
    assert.equal(expandStartCmd(cmd), cmd, `${JSON.stringify(cmd)} is not the placeholder`);
  }
  // A command that merely MENTIONS the placeholder is left alone: sh would
  // expand it to the empty string, and a half-expansion is worse than none.
  assert.equal(expandStartCmd('python3 $XERB_STATIC --port 3000'), 'python3 $XERB_STATIC --port 3000');
});

test('a placeholder project starts and serves its folder through the front door', async (t) => {
  const port = await freePort();
  writeRegistry({
    port: 0,
    startTimeoutMs: 10_000,
    projects: [{ host: 'placeholder-site', dir: SITE_DIR, port, startCmd: STATIC_PLACEHOLDER, framework: 'static', enabled: true }],
  });

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(async () => {
    closeServer(daemon);
    stop('placeholder-site');
    const r = getRuntime('placeholder-site');
    if (r.startPromise) await r.startPromise.catch(() => {});
    upstreamAgent.destroy();
  });

  const first = await httpGet(daemonPort, 'placeholder-site.localhost', '/', NAV);
  assert.equal(first.status, 200, 'the first navigation gets the wake page, not a hang');

  const up = await waitFor(() => getRuntime('placeholder-site').state === 'running');
  assert.ok(up, 'the expanded command brought the port up');

  const served = await httpGet(daemonPort, 'placeholder-site.localhost', '/index.html');
  assert.equal(served.status, 200);
  assert.equal(served.body, INDEX_BODY, 'the bytes come from serve_static.py serving the project dir');

  // The expansion happens at spawn, so the log quotes the real command while
  // the registry on disk still holds the placeholder.
  assert.match(tailLog('placeholder-site', 40, { all: true }), /start: python3 ".*serve_static\.py" \(PORT=\d+\)/);
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  assert.equal(onDisk.projects[0].startCmd, STATIC_PLACEHOLDER, 'the registry is not rewritten by a start');
});

// --- the one-time rewrite on load -------------------------------------------

test('a legacy absolute-path static entry is rewritten on load, once', () => {
  writeRegistry({
    port: 0,
    idleTimeoutMs: 60_000,
    projects: [
      { host: 'oldstatic', dir: SITE_DIR, port: 3999, startCmd: 'python3 "/Users/x/.npm/_npx/deadbeef/serve_static.py"', framework: 'static', enabled: true },
      { host: 'unquoted', dir: SITE_DIR, port: 3998, startCmd: 'python3 /Users/x/.npm/_npx/deadbeef/serve_static.py', framework: 'static', enabled: false },
      { host: 'node-app', dir: SITE_DIR, port: 3997, startCmd: 'npm run dev', framework: 'next', enabled: true },
      { host: 'oldname', dir: SITE_DIR, port: 3996, startCmd: '$LAZYDEV_STATIC', framework: 'static', enabled: true },
    ],
  });

  const after = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  assert.equal(after.projects[3].startCmd, STATIC_PLACEHOLDER, 'the placeholder from the lazydev days is respelled');
  assert.equal(after.projects[0].startCmd, STATIC_PLACEHOLDER, 'the quoted form is rewritten');
  assert.equal(after.projects[1].startCmd, STATIC_PLACEHOLDER, 'so is the unquoted one');
  assert.equal(after.projects[2].startCmd, 'npm run dev', 'a non-static startCmd is left alone');

  // The save-back rewrites the whole file, so everything else must survive it.
  assert.equal(after.idleTimeoutMs, 60_000);
  assert.equal(after.projects[1].enabled, false);
  assert.equal(after.projects[0].port, 3999);
  assert.equal(after.projects[0].dir, SITE_DIR);

  // ...and the in-memory registry the daemon spawns from agrees with the file.
  const mtimeAfterRewrite = fs.statSync(CONFIG_FILE).mtimeMs;
  assert.ok(loadConfig('test-second-pass'), 'a second load succeeds');
  assert.equal(
    fs.statSync(CONFIG_FILE).mtimeMs,
    mtimeAfterRewrite,
    'the second load finds nothing to migrate and does not touch the file (this is what stops the fs.watch loop)'
  );
});

test('the rewrite is idempotent and ignores non-static commands', () => {
  const reg = {
    projects: [
      { host: 'a', startCmd: 'python3 "/x/serve_static.py"' },
      { host: 'b', startCmd: 'npm run dev' },
      { host: 'c', startCmd: STATIC_PLACEHOLDER },
      { host: 'd' }, // hand-edited entry with no startCmd at all
      null,
    ],
  };
  assert.equal(rewriteStaticStartCmds(reg), 1, 'only the legacy entry counts as changed');
  assert.equal(reg.projects[0].startCmd, STATIC_PLACEHOLDER);
  assert.equal(rewriteStaticStartCmds(reg), 0, 'a second pass changes nothing, so nothing is saved back');
  assert.equal(rewriteStaticStartCmds({}), 0, 'a registry with no projects array is not a crash');
});
