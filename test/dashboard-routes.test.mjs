// Section 7: the dashboard edits everything the registry holds.
//
// Covers the seven control routes the dashboard calls — add, remove, enable,
// disable, set, restart, detect — plus the page polish that went with them.
// Every route is driven against a REAL daemon on an OS-assigned port with a
// throwaway state dir, and every route is also asserted to refuse a bad token
// (spec section 10), because these are the routes that write the registry.
//
// The writes themselves go through lib/registry-cli.mjs, the same module the
// subcommands use, so what is asserted here is the daemon's half: the right
// status code, the right stop-before-write, and the file on disk afterwards.
//
// WAKEMAN_CONFIG is captured at module load, so the env vars are set and the
// registry written BEFORE the dynamic import of ../wakeman.mjs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- fixtures ---------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-dash-'));
const CONFIG_PATH = path.join(TMP, 'projects.json');

// Project dirs. node_modules is what makes ensureUp skip the install step, so
// nothing here ever shells out to a real npm.
const dirFor = (name) => {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  return dir;
};
const ALPHA_DIR = dirFor('alpha');
const PARKED_DIR = dirFor('parked');
const SPARE_DIR = dirFor('spare');
// One folder per project, always: addEntry keys on the directory, so two
// entries pointing at one folder is an UPDATE, not a second project.
const STOPME_DIR = dirFor('stopme');
const RESTART_DIR = dirFor('restartme');

// A folder the detectors can prove something about: package.json with a dev
// script that names a server runner.
const NODE_DIR = dirFor('detectme');
fs.writeFileSync(
  path.join(NODE_DIR, 'package.json'),
  JSON.stringify({ name: 'detectme', scripts: { dev: 'nodemon server.js' } })
);

// A static folder: index.html at the root of its own git repo, no package.json.
const STATIC_DIR = path.join(TMP, 'site');
fs.mkdirSync(path.join(STATIC_DIR, '.git'), { recursive: true });
fs.writeFileSync(path.join(STATIC_DIR, 'index.html'), '<h1>hi</h1>');

// A dev server that binds the PORT the daemon injects and answers 200.
const SERVER_CMD = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT,'127.0.0.1');/*dev-server*/"`;

// Reserve an OS-assigned port, then release it: the registry points at
// something nothing is listening on.
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
const PARKED_PORT = await freePort();

function writeRegistry(extra = []) {
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        port: 0,
        // 45s proves the idle line formats seconds instead of rounding to "0m".
        idleTimeoutMs: 45_000,
        startTimeoutMs: 4000,
        projects: [
          { host: 'alpha', dir: ALPHA_DIR, port: ALPHA_PORT, startCmd: SERVER_CMD, enabled: true, framework: 'node' },
          { host: 'parked', dir: PARKED_DIR, port: PARKED_PORT, startCmd: 'true', enabled: false, framework: 'static' },
          ...extra,
        ],
      },
      null,
      2
    ) + '\n'
  );
}
writeRegistry();

process.env.WAKEMAN_CONFIG = CONFIG_PATH;
process.env.WAKEMAN_CONTROL_TOKEN_PATH = path.join(TMP, 'control-token');
process.env.WAKEMAN_LOGS_DIR = path.join(TMP, 'logs');

const {
  createDaemonServer,
  loadConfig,
  ensureControlToken,
  getRuntime,
  ensureUp,
  stop,
  statusPageHtml,
  upstreamAgent,
} = await import('../wakeman.mjs');

// --- helpers ----------------------------------------------------------------

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// One request to the daemon's control plane on the dashboard host.
function req(pathname, { method = 'POST', token, body, host = 'wakeman.localhost', origin } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers = { host, 'content-type': 'application/json' };
  if (token) headers['x-wakeman-token'] = token;
  if (origin) headers.origin = origin;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: daemonPort, method, path: pathname, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* HTML page, not JSON */
        }
        resolve({ status: res.statusCode, json, body: text });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

// Every POST carries the real token unless the caller passes one (or null, for
// the no-token case) of its own.
const post = (pathname, opts = {}) =>
  req(pathname, { ...opts, method: 'POST', token: opts.token === undefined ? token : opts.token || undefined });
const readReg = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const entryFor = (host) => readReg().projects.find((p) => p.host === host) || null;

async function statusFor(host) {
  const res = await req('/__wakeman/status', { method: 'GET' });
  return res.json.projects.find((p) => p.host === host) || null;
}

// Poll until nothing answers on the port (a stopped child releases it a beat
// after SIGTERM returns).
async function portQuiet(port, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.setTimeout(200);
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('timeout', () => {
        sock.destroy();
        resolve(false);
      });
      sock.once('error', () => resolve(false));
    });
    if (!busy) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let daemon;
let daemonPort;
let token;

before(async () => {
  writeRegistry();
  loadConfig('test:dashboard');
  token = ensureControlToken();
  daemon = createDaemonServer();
  daemonPort = await listen(daemon);
});

after(() => {
  for (const host of ['alpha', 'restartme', 'stopme']) stop(host, 'test-teardown');
  daemon.close();
  upstreamAgent.destroy();
});

// --- the token gate (spec section 10) ---------------------------------------

const ROUTES = [
  ['/__wakeman/add', { dir: SPARE_DIR, name: 'sneaky', startCmd: 'true' }],
  ['/__wakeman/remove/alpha', undefined],
  ['/__wakeman/enable/parked', undefined],
  ['/__wakeman/disable/alpha', undefined],
  ['/__wakeman/set/alpha', { port: 65001 }],
  ['/__wakeman/restart/alpha', undefined],
  ['/__wakeman/detect', { dir: NODE_DIR }],
];

test('every section 7 route refuses a missing or wrong token, and writes nothing', async () => {
  const before = fs.readFileSync(CONFIG_PATH, 'utf8');
  for (const [pathname, body] of ROUTES) {
    const none = await post(pathname, { token: null, body });
    assert.equal(none.status, 403, `${pathname} without a token`);
    assert.equal(none.json.ok, false);

    const wrong = await post(pathname, { token: 'deadbeef', body });
    assert.equal(wrong.status, 403, `${pathname} with a wrong token`);
    assert.equal(wrong.json.ok, false);
  }
  // A page on another site holding the token is still refused: the same guard,
  // asserted here because these routes are the ones that write.
  const crossSite = await post('/__wakeman/remove/alpha', { origin: 'http://evil.example' });
  assert.equal(crossSite.status, 403, 'foreign Origin, correct token');

  assert.equal(fs.readFileSync(CONFIG_PATH, 'utf8'), before, 'no rejected call touched the registry');
});

// --- detect ------------------------------------------------------------------

test('detect prefills name, port and start command from a folder, and writes nothing', async () => {
  const before = fs.readFileSync(CONFIG_PATH, 'utf8');
  const res = await post('/__wakeman/detect', { body: { dir: NODE_DIR } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.name, 'detectme');
  assert.equal(res.json.framework, 'node');
  assert.equal(res.json.startCmd, 'npm run dev');
  assert.ok(Number.isInteger(res.json.port) && res.json.port >= 3010, 'a port out of the pool');
  assert.equal(fs.readFileSync(CONFIG_PATH, 'utf8'), before, 'detect is read-only');
});

test('detect expands ~, refuses a relative path, and names a folder that is not there', async () => {
  const tilde = await post('/__wakeman/detect', { body: { dir: '~' } });
  assert.equal(tilde.status, 200);
  assert.equal(tilde.json.dir, os.homedir(), '~ expands to the home dir');

  const relative = await post('/__wakeman/detect', { body: { dir: 'code/app' } });
  assert.equal(relative.status, 400);
  assert.match(relative.json.reason, /absolute/);

  const missing = path.join(TMP, 'not-here');
  const gone = await post('/__wakeman/detect', { body: { dir: missing } });
  assert.equal(gone.status, 404);
  assert.equal(gone.json.reason, `no such folder: ${missing}`);
});

test('detect hands back the static placeholder, not an absolute serve_static.py path', async () => {
  const res = await post('/__wakeman/detect', { body: { dir: STATIC_DIR } });
  assert.equal(res.status, 200);
  assert.equal(res.json.framework, 'static');
  assert.equal(res.json.startCmd, '$WAKEMAN_STATIC');
});

test('detect says what it looked for when a folder proves nothing', async () => {
  const res = await post('/__wakeman/detect', { body: { dir: SPARE_DIR } });
  assert.equal(res.status, 200);
  assert.equal(res.json.startCmd, null);
  assert.deepEqual(
    res.json.evidence.map((e) => e[0]),
    ['rails', 'django', 'node', 'static'],
    'the form can list every detector by name'
  );
});

// --- add ---------------------------------------------------------------------

test('add registers a project, and the daemon serves it without a restart', async () => {
  const port = await freePort();
  const res = await post('/__wakeman/add', {
    body: { dir: NODE_DIR, name: 'added', startCmd: 'npm run dev', port, parked: false },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    { ok: res.json.ok, host: res.json.host, port: res.json.port, updated: res.json.updated },
    { ok: true, host: 'added', port, updated: false }
  );

  const entry = entryFor('added');
  assert.ok(entry, 'the registry file holds the new entry');
  assert.equal(entry.dir, NODE_DIR);
  assert.equal(entry.startCmd, 'npm run dev');
  assert.equal(entry.enabled, true);

  const live = await statusFor('added');
  assert.ok(live, 'the daemon reloaded the registry as part of the write');
  assert.equal(live.port, port);
});

test('add on an already-registered folder updates the entry instead of failing', async () => {
  const res = await post('/__wakeman/add', {
    body: { dir: NODE_DIR, name: 'added', startCmd: 'npm run dev -- --host' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.updated, true);
  assert.equal(readReg().projects.filter((p) => p.dir === NODE_DIR).length, 1, 'still one entry for the folder');
  assert.equal(entryFor('added').startCmd, 'npm run dev -- --host');
});

test('add errors land inline: missing folder, taken name, port already in use', async () => {
  const missing = path.join(TMP, 'nope');
  const gone = await post('/__wakeman/add', { body: { dir: missing, name: 'ghost', startCmd: 'true' } });
  assert.equal(gone.status, 400);
  assert.equal(gone.json.reason, `no such directory: ${missing}`);

  const taken = await post('/__wakeman/add', { body: { dir: SPARE_DIR, name: 'alpha', startCmd: 'true' } });
  assert.equal(taken.status, 409);
  assert.match(taken.json.reason, /already registered/);

  // Something really listening on the port the form asked for.
  const squatter = net.createServer();
  const busyPort = await new Promise((resolve) => squatter.listen(0, '127.0.0.1', () => resolve(squatter.address().port)));
  const inUse = await post('/__wakeman/add', {
    body: { dir: SPARE_DIR, name: 'busy', startCmd: 'true', port: busyPort },
  });
  squatter.close();
  assert.equal(inUse.status, 409);
  assert.equal(inUse.json.reason, `port ${busyPort} is in use right now`);

  assert.equal(entryFor('ghost'), null);
  assert.equal(entryFor('busy'), null);
});

test('add takes "host" as another spelling of "name", and refuses the two disagreeing', async () => {
  const aliased = await post('/__wakeman/add', { body: { dir: NODE_DIR, host: 'added', startCmd: 'npm run dev' } });
  assert.equal(aliased.status, 200, JSON.stringify(aliased.json));
  assert.equal(aliased.json.host, 'added', 'the name came from "host", not the folder');

  const both = await post('/__wakeman/add', { body: { dir: NODE_DIR, name: 'added', host: 'other', startCmd: 'npm run dev' } });
  assert.equal(both.status, 400);
  assert.equal(both.json.reason, 'send "name" or "host", not both');

  // The sandbox request: a folder that is already registered, sent with a
  // `host` that belongs to a different folder. It used to answer ok/updated
  // under the folder's own name.
  const stolen = await post('/__wakeman/add', { body: { dir: NODE_DIR, host: 'alpha', startCmd: 'npm run dev' } });
  assert.equal(stolen.status, 409);
  assert.match(stolen.json.reason, /"alpha" is already registered for /);
  assert.equal(entryFor('alpha').dir, ALPHA_DIR, 'alpha still points at its own folder');
});

test('add, set and detect name a field they do not know instead of dropping it', async () => {
  const before = JSON.stringify(readReg());
  const add = await post('/__wakeman/add', { body: { dir: SPARE_DIR, hots: 'spare', startCmd: 'true' } });
  assert.equal(add.status, 400);
  assert.equal(add.json.reason, 'unknown field "hots"; known: dir, name, host, startCmd, port, framework, parked');

  const set = await post('/__wakeman/set/alpha', { body: { cmd: 'true' } });
  assert.equal(set.status, 400);
  assert.equal(set.json.reason, 'unknown field "cmd"; known: port, startCmd');

  const detect = await post('/__wakeman/detect', { body: { dir: NODE_DIR, path: NODE_DIR } });
  assert.equal(detect.status, 400);
  assert.equal(detect.json.reason, 'unknown field "path"; known: dir');

  assert.equal(JSON.stringify(readReg()), before, 'none of the three wrote anything');
});

test('add parks a project when the checkbox is ticked', async () => {
  const res = await post('/__wakeman/add', {
    body: { dir: STATIC_DIR, name: 'site', startCmd: '$WAKEMAN_STATIC', parked: true },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.enabled, false);
  assert.equal(entryFor('site').enabled, false);
});

// --- enable / disable ---------------------------------------------------------

test('enable and disable rewrite the registry and show up in status', async () => {
  const on = await post('/__wakeman/enable/parked');
  assert.equal(on.status, 200);
  assert.equal(entryFor('parked').enabled, true);
  assert.equal((await statusFor('parked')).enabled, true);

  const off = await post('/__wakeman/disable/parked');
  assert.equal(off.status, 200);
  assert.equal(entryFor('parked').enabled, false);
  assert.equal((await statusFor('parked')).enabled, false);

  const ghost = await post('/__wakeman/disable/nosuchhost');
  assert.equal(ghost.status, 404);
});

test('disabling a running project stops it first', async () => {
  const port = await freePort();
  await post('/__wakeman/add', { body: { dir: STOPME_DIR, name: 'stopme', startCmd: SERVER_CMD, port } });
  await ensureUp(entryFor('stopme'));
  assert.equal(getRuntime('stopme').state, 'running');

  const res = await post('/__wakeman/disable/stopme');
  assert.equal(res.status, 200);
  assert.equal(entryFor('stopme').enabled, false);
  assert.equal(await portQuiet(port), true, 'the dev server let go of its port');
});

// --- set ----------------------------------------------------------------------

test('set changes the start command, and the port while the project is asleep', async () => {
  const cmd = await post('/__wakeman/set/parked', { body: { startCmd: 'python3 -m http.server' } });
  assert.equal(cmd.status, 200);
  assert.equal(entryFor('parked').startCmd, 'python3 -m http.server');

  const port = await freePort();
  const moved = await post('/__wakeman/set/parked', { body: { port } });
  assert.equal(moved.status, 200);
  assert.equal(entryFor('parked').port, port);
  assert.equal((await statusFor('parked')).port, port);

  const nothing = await post('/__wakeman/set/parked', { body: {} });
  assert.equal(nothing.status, 400);
  assert.equal(nothing.json.reason, 'nothing to change');

  const ghost = await post('/__wakeman/set/nosuchhost', { body: { port: 3100 } });
  assert.equal(ghost.status, 404);
});

test('set refuses to move the port while the project runs, and names the fix', async () => {
  const port = await freePort();
  await post('/__wakeman/add', { body: { dir: RESTART_DIR, name: 'restartme', startCmd: SERVER_CMD, port } });
  await ensureUp(entryFor('restartme'));
  assert.equal(getRuntime('restartme').state, 'running');

  const blocked = await post('/__wakeman/set/restartme', { body: { port: await freePort() } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.reason, 'restartme is running; stop it first');
  assert.equal(entryFor('restartme').port, port, 'the registry kept the port it is actually serving');

  // The start command is editable either way: it applies at the next start.
  const cmd = await post('/__wakeman/set/restartme', { body: { startCmd: SERVER_CMD } });
  assert.equal(cmd.status, 200);
});

test('set refuses a port something else is listening on', async () => {
  const squatter = net.createServer();
  const busyPort = await new Promise((resolve) => squatter.listen(0, '127.0.0.1', () => resolve(squatter.address().port)));
  const res = await post('/__wakeman/set/parked', { body: { port: busyPort } });
  squatter.close();
  assert.equal(res.status, 409);
  assert.equal(res.json.reason, `port ${busyPort} is in use right now`);
});

// --- restart -------------------------------------------------------------------

test('restart gives the project a new process', async () => {
  const before = getRuntime('restartme');
  assert.equal(before.state, 'running');
  const beforePid = before.pid;
  assert.ok(beforePid, 'the running server is one wakeman spawned');

  const res = await post('/__wakeman/restart/restartme');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);

  const after = getRuntime('restartme');
  assert.equal(after.state, 'running');
  assert.ok(after.pid, 'a process is running after the restart');
  assert.notEqual(after.pid, beforePid, 'a NEW process, not the old one');
  // The old process group is gone.
  assert.throws(() => process.kill(-beforePid, 0), 'the previous process group was killed');
});

test('restart refuses a disabled project and an unknown host', async () => {
  const disabled = await post('/__wakeman/restart/parked');
  assert.equal(disabled.status, 409);
  assert.equal(disabled.json.reason, 'disabled');

  const ghost = await post('/__wakeman/restart/nosuchhost');
  assert.equal(ghost.status, 404);
});

// --- remove ---------------------------------------------------------------------

test('remove stops a running project, drops its entry, and leaves the folder alone', async () => {
  const running = getRuntime('restartme');
  assert.equal(running.state, 'running');
  const port = entryFor('restartme').port;

  const res = await post('/__wakeman/remove/restartme');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(entryFor('restartme'), null, 'gone from the registry file');
  assert.equal(await statusFor('restartme'), null, 'gone from the daemon');
  assert.equal(await portQuiet(port), true, 'its dev server was stopped first');
  assert.equal(fs.existsSync(path.join(RESTART_DIR, 'node_modules')), true, 'the folder is never touched');

  const ghost = await post('/__wakeman/remove/nosuchhost');
  assert.equal(ghost.status, 404);
});

// --- the page itself --------------------------------------------------------------

test('the dashboard draws a word mark, the real idle time, and every per-row action', async () => {
  const page = await req('/', { method: 'GET' });
  assert.equal(page.status, 200);
  const html = page.body;

  // Polish 1: the word, in the monospace stack, with the sleeping z's. The
  // ASCII block art stays in lib/ui.mjs for the terminal.
  assert.match(html, /<h1 class="logo">wakeman<span class="zzz"/);
  assert.equal(html.includes('_ __ _ ___') || /<pre class="logo"/.test(html), false, 'no ASCII logo in the page');

  // Polish 2: idle sleep reads 45s, not "0m".
  assert.match(html, /idle sleep after 45s/);

  // The add form and its fields.
  assert.match(html, /id="addtoggle"[^>]*>add project</);
  for (const id of ['a-dir', 'a-name', 'a-cmd', 'a-port', 'a-parked']) {
    assert.match(html, new RegExp(`id="${id}"`), `the add form has ${id}`);
  }

  // Per-row actions.
  const rowFor = (host) => (html.split('<tr data-host="' + host + '">')[1] || '').split('</tr>')[0];
  const row = rowFor('alpha');
  assert.match(row, /class="rowbtn restart"/, 'restart button beside the switch');
  assert.match(row, /onclick="toggleEnabled\(this\)">disable</, 'enable/disable replaces the "(disabled)" text');
  assert.match(row, /onclick="removeHost\(this\)">remove</, 'remove button');
  assert.match(row, /onclick="editHost\(this\)"/, 'the pencil is still the way in');
  assert.match(row, /class="c-proj" data-port="\d+" data-cmd="/, 'the edit panel prefills from the row');

  // A disabled row is greyed cell by cell, and says so with a button, not text.
  const parkedRow = rowFor('parked');
  assert.match(parkedRow, /class="c-proj off"/);
  assert.match(parkedRow, /class="c-act off"/);
  assert.equal(parkedRow.includes('(disabled)'), false);
  assert.match(parkedRow, /onclick="toggleEnabled\(this\)">enable</);
});

test('the dashboard script parses as JavaScript', async () => {
  const page = await req('/', { method: 'GET' });
  const script = page.body.split('<script>').pop().split('</script>')[0];
  // new Function throws a SyntaxError on anything the browser would refuse.
  assert.doesNotThrow(() => new Function(script), 'the inline dashboard script is valid JS');
});

// --- wake / failed page polish -----------------------------------------------------

test('the wake page titles itself from phraseByPhase and counts from 0s', () => {
  const project = { host: 'alpha', dir: ALPHA_DIR, port: ALPHA_PORT };
  const installing = statusPageHtml(project, { state: 'installing', lastError: null });
  assert.match(installing, /<title>alpha — installing<\/title>/);
  assert.match(installing, /Installing dependencies, then starting the dev server\./);

  const starting = statusPageHtml(project, { state: 'starting', lastError: null });
  assert.match(starting, /<title>alpha — starting up<\/title>/);
  assert.match(starting, /The dev server is being turned on\./);

  // One table feeds both, and the poll rewrites the title as the phase moves.
  assert.match(starting, /const ph = PHRASES\[j\.phase\] \|\| PHRASES\.waking;/);
  assert.match(starting, /document\.title = HOST \+ ' — ' \+ ph\.title;/);

  // The counter is on screen from the first paint.
  assert.match(starting, /id="elapsed" aria-hidden="true">0s</);
  assert.equal(starting.includes("s >= 3 ? s + 's'"), false, 'no 3s dead zone');
});

test('the failed page gives its log box a dark-mode colour of its own', () => {
  const failed = statusPageHtml(
    { host: 'alpha', dir: ALPHA_DIR, port: ALPHA_PORT },
    { state: 'stopped', lastError: { kind: 'exited', exitCode: 1, elapsedMs: 100, message: 'boom' } }
  );
  assert.match(failed, /failed to start/);
  assert.match(failed, /@media \(prefers-color-scheme: dark\) \{\s*pre \{ background: #0d1117;/);
});
