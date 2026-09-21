// Free-the-port tests: the conflict page's call to action.
//
// A conflicted project's port can be freed two ways: POST /__xerb/free
// (tokenless, same-origin, scoped to the host the request arrived on — the
// conflict page's button) and POST /__xerb/free/<host> (token-gated — the
// dashboard's button). Both funnel into freePort, which only ever signals a
// listener whose cwd mismatches the project, re-verified at action time. These
// tests prove the kill path end-to-end against a real daemon and a real fake
// listener, plus every refusal: cross-origin, wrong host, unresolved cwd, and
// the project's own server. The lsof seams (__setResolvePidCwd,
// __setResolveListenerPid) and the kill seam (__setKillForeign) are swapped so
// no real lsof runs and no real signal is ever sent — deterministic in CI.

import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// XERB_CONFIG is read at module load, so the temp registry must exist and the
// env var must point at it BEFORE importing xerb.mjs.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-free-'));
const CONFIG_PATH = path.join(TMP_ROOT, 'projects.json');
// A real directory for the matching-cwd case (sameDir realpaths its inputs).
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-projdir-'));

function writeRegistry(port, dir) {
  const registry = {
    port: 0,
    projects: [
      { host: 'proj', dir, port, startCmd: 'true', enabled: true, framework: 'node' },
    ],
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(registry));
}

writeRegistry(0, PROJECT_DIR);
process.env.XERB_CONFIG = CONFIG_PATH;
process.env.XERB_CONTROL_TOKEN_PATH = path.join(TMP_ROOT, 'control-token');
// Contain any accidental spawn's log writes to the temp dir.
process.env.XERB_LOGS_DIR = path.join(TMP_ROOT, 'logs');

const {
  createDaemonServer,
  loadConfig,
  ensureControlToken,
  __setResolvePidCwd,
  __setResolveListenerPid,
  __setKillForeign,
  __setRuntimeForTest,
} = await import('../xerb.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function httpGet(port, hostHeader, reqPath = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: reqPath, headers: { host: hostHeader } },
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

// POST with optional token and optional Origin header, so one helper covers
// the tokenless same-origin path, the token-gated path, and the CSRF refusal.
function httpPost(port, hostHeader, reqPath, { token, origin } = {}) {
  const headers = { host: hostHeader };
  if (token) headers['x-xerb-token'] = token;
  if (origin) headers.origin = origin;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: reqPath, headers },
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

// A fake foreign listener whose "death" is our kill seam closing it — the
// daemon's post-kill probe then finds the port free, exactly like a real kill.
function fakeListener() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('foreign');
  });
  return srv;
}

function closeServer(srv) {
  return new Promise((resolve) => {
    srv.close(resolve);
    srv.closeAllConnections?.();
  });
}

before(() => {
  loadConfig('free-test');
});

afterEach(() => {
  __setResolvePidCwd(null);
  __setResolveListenerPid(null);
  __setKillForeign(null);
  __setRuntimeForTest('proj', {
    state: 'stopped',
    owned: false,
    child: null,
    pid: null,
    startPromise: null,
    upstreamHost: null,
    lastError: null,
    conflictDir: null,
  });
});

test('A: tokenless POST /__xerb/free on the project host kills the squatter and clears the conflict', async (t) => {
  const fake = fakeListener();
  const fakePort = await listen(fake);
  writeRegistry(fakePort, '/some/project/dir');
  loadConfig('free-A');
  __setResolvePidCwd(() => '/totally/different/dir');
  __setResolveListenerPid(() => 424242);
  const kills = [];
  __setKillForeign((pid, sig) => {
    kills.push([pid, sig]);
    closeServer(fake); // "dies" -> the port frees, the daemon's probe sees it
  });

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(async () => {
    daemon.close();
    await closeServer(fake);
  });

  // Land in the conflict state the same way a user does: a plain request.
  const nav = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(nav.status, 502, 'sanity: the mismatched listener is a conflict');

  const res = await httpPost(daemonPort, 'proj.localhost', '/__xerb/free');
  const j = JSON.parse(res.body);
  assert.equal(res.status, 200, `free should succeed, got ${res.status}: ${res.body}`);
  assert.equal(j.ok, true);
  assert.equal(j.freed, true, 'the squatter was actually signalled');
  assert.deepEqual(kills[0], [424242, 'SIGTERM'], 'SIGTERM to the resolved listener pid');

  const status = await httpGet(daemonPort, 'xerb.localhost', '/__xerb/status');
  const entry = JSON.parse(status.body).projects.find((p) => p.host === 'proj');
  assert.equal(entry.conflict, false, 'the conflict is cleared');
  assert.equal(entry.conflictDir, null, 'the foreign cwd is forgotten');
  // The freed project must wake on the next request. A conflict lastError left
  // behind made it a terminal failure that nothing re-kicked.
  assert.equal(entry.lastError, null, 'the conflict error is forgotten with the conflict');
  // The next request must start a fresh bring-up. This fixture's folder does
  // not exist, so the fresh attempt ends as dir-missing: a NEW failure, which
  // proves the old conflict no longer blocks the kick.
  await httpGet(daemonPort, 'proj.localhost', '/');
  const status2 = await httpGet(daemonPort, 'xerb.localhost', '/__xerb/status');
  const entry2 = JSON.parse(status2.body).projects.find((p) => p.host === 'proj');
  assert.equal(entry2.lastError && entry2.lastError.kind, 'dir-missing', 'bring-up ran again after the free');
});

test('B: a cross-origin POST /__xerb/free is refused and nothing is killed', async (t) => {
  const fake = fakeListener();
  const fakePort = await listen(fake);
  writeRegistry(fakePort, '/some/project/dir');
  loadConfig('free-B');
  __setResolvePidCwd(() => '/totally/different/dir');
  __setResolveListenerPid(() => 424242);
  const kills = [];
  __setKillForeign((pid, sig) => kills.push([pid, sig]));

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(async () => {
    daemon.close();
    await closeServer(fake);
  });

  const res = await httpPost(daemonPort, 'proj.localhost', '/__xerb/free', {
    origin: 'http://evil.example',
  });
  assert.equal(res.status, 403, 'foreign Origin is refused');
  assert.equal(kills.length, 0, 'no signal was sent');
});

test('C: POST /__xerb/free is scoped to the arrival host — the dashboard host has no project to free', async (t) => {
  const fake = fakeListener();
  const fakePort = await listen(fake);
  writeRegistry(fakePort, '/some/project/dir');
  loadConfig('free-C');
  __setResolvePidCwd(() => '/totally/different/dir');
  __setResolveListenerPid(() => 424242);
  const kills = [];
  __setKillForeign((pid, sig) => kills.push([pid, sig]));

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(async () => {
    daemon.close();
    await closeServer(fake);
  });

  const res = await httpPost(daemonPort, 'xerb.localhost', '/__xerb/free');
  assert.equal(res.status, 404, 'xerb.localhost names no project');
  assert.equal(kills.length, 0, 'no signal was sent');
});

test('D: a listener that IS the project is never killed; the conflict clears for adoption instead', async (t) => {
  const fake = fakeListener();
  const fakePort = await listen(fake);
  writeRegistry(fakePort, PROJECT_DIR);
  loadConfig('free-D');
  __setResolvePidCwd(() => PROJECT_DIR);
  __setResolveListenerPid(() => 424242);
  const kills = [];
  __setKillForeign((pid, sig) => kills.push([pid, sig]));

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(async () => {
    daemon.close();
    await closeServer(fake);
  });

  const res = await httpPost(daemonPort, 'proj.localhost', '/__xerb/free');
  const j = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.freed, false, 'nothing was killed');
  assert.equal(kills.length, 0, 'no signal was sent to the project\'s own server');
});

test('E: an unresolved cwd refuses to kill', async (t) => {
  const fake = fakeListener();
  const fakePort = await listen(fake);
  writeRegistry(fakePort, '/some/project/dir');
  loadConfig('free-E');
  __setResolvePidCwd(() => null);
  __setResolveListenerPid(() => 424242);
  const kills = [];
  __setKillForeign((pid, sig) => kills.push([pid, sig]));

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(async () => {
    daemon.close();
    await closeServer(fake);
  });

  const res = await httpPost(daemonPort, 'proj.localhost', '/__xerb/free');
  const j = JSON.parse(res.body);
  assert.equal(res.status, 409, 'refusal is a 409, not a success');
  assert.equal(j.ok, false);
  assert.equal(kills.length, 0, 'never kill what we cannot identify');
});

test('F: POST /__xerb/free/<host> requires the token; with it, the guards still hold', async (t) => {
  const fake = fakeListener();
  const fakePort = await listen(fake);
  writeRegistry(fakePort, '/some/project/dir');
  loadConfig('free-F');
  __setResolvePidCwd(() => null); // cwd unresolved -> the handler refuses (no spawn kick)
  __setResolveListenerPid(() => 424242);
  const kills = [];
  __setKillForeign((pid, sig) => kills.push([pid, sig]));

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(async () => {
    daemon.close();
    await closeServer(fake);
  });

  const noToken = await httpPost(daemonPort, 'xerb.localhost', '/__xerb/free/proj');
  assert.equal(noToken.status, 403, 'the per-host form is token-gated');

  const withToken = await httpPost(daemonPort, 'xerb.localhost', '/__xerb/free/proj', {
    token: ensureControlToken(),
  });
  const j = JSON.parse(withToken.body);
  assert.equal(withToken.status, 409, 'authorized, but the unresolved-cwd guard still refuses');
  assert.equal(j.ok, false);
  assert.equal(kills.length, 0, 'no signal was sent');
});
