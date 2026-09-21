// Connection-aware idle-reaper tests for the daemon (issue #4).
//
// Proves reapIdle() only sleeps an OWNED, running project once it has zero
// deferring connections AND has been idle past the timeout; that a live socket
// (recent bytes) defers the reap; that a socket silent past the hard cap stops
// deferring; that an adopted/external project is never reaped; and that the live
// connection count shows up in the status JSON. Pure node:test + node:assert.
//
// Ordering gotcha: xerb.mjs captures CONFIG_PATH from process.env.XERB_CONFIG
// at module load, so we write a temp registry and set the env var BEFORE the
// dynamic import, then call the exported loadConfig() to read it.
//
// Isolation: the daemon's runtime/lastAccess/connection Maps are module-level
// singletons shared across every test in this file. Each test therefore uses a
// UNIQUE host and rewrites the registry to contain ONLY its own project, so
// reapIdle never touches another test's host and connection counts never bleed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- Scratch config, written before the daemon module loads ------------------

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-reaper-'));
const CONFIG_PATH = path.join(scratchDir, 'projects.json');

// Rewrite the registry to a SINGLE project on `host`, so reapIdle only ever sees
// the project under test. Returns nothing; caller follows with loadConfig().
function writeConfig({ host, port = 0, idleTimeoutMs = 50, connectionHardCapMs = 7_200_000 }) {
  const obj = {
    port: 0,
    idleTimeoutMs,
    connectionHardCapMs,
    projects: [{ host, port, dir: scratchDir, startCmd: 'true', framework: 'node', enabled: true }],
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj));
}

// Seed a valid file so the import-time boot path (if any) has something to read.
writeConfig({ host: 'seed', port: 0 });
process.env.XERB_CONFIG = CONFIG_PATH;

const {
  createDaemonServer,
  loadConfig,
  reapIdle,
  __setRuntimeForTest,
  __addConnForTest,
  __setLastAccessForTest,
  __liveConnInfo,
  __setResolvePidCwd,
} = await import('../xerb.mjs');

// The adopt-path tests here point projects at fake dev servers whose real cwd is
// the test runner's, not the project dir — which the cwd-verified adoption added
// later would flag as a port CONFLICT rather than an adopt. Force the PID->cwd
// resolver to "unresolved" (null) so those adopts degrade to the legacy adopt,
// the behavior these reaper tests assume. It never fires on spawn-only paths.
__setResolvePidCwd(() => null);

// --- Helpers -----------------------------------------------------------------

// A fake dev server: 200 to any GET, and on `upgrade` completes the handshake
// and holds the socket open (echoing back whatever it receives), so a WS/HMR
// proxy through the daemon has a real upstream that keeps the pipe alive.
function startFakeDevServer() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  srv.on('upgrade', (req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n\r\n'
    );
    socket.on('data', (chunk) => {
      try {
        socket.write(chunk);
      } catch {
        /* ignore */
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: srv.address().port, close: () => srv.close() });
    });
  });
}

// Bind a daemon server on 127.0.0.1:0 and resolve its assigned port.
function startDaemon() {
  const srv = createDaemonServer();
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, port: srv.address().port });
    });
  });
}

// GET path through the daemon with a host header; resolve { status, body }. By
// default sends `Connection: close` so the daemon-side client socket closes
// promptly after the response (otherwise Node's keepAliveTimeout holds it ~5s).
function httpGetThrough(daemonPort, host, pathname = '/', { agent, keepAlive = false } = {}) {
  const headers = { Host: `${host}.localhost` };
  if (!keepAlive) headers.Connection = 'close';
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: daemonPort, method: 'GET', path: pathname, headers, agent },
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

// GET the daemon's control-plane status JSON.
function statusThrough(daemonPort) {
  return httpGetThrough(daemonPort, 'xerb', '/__xerb/status').then((r) => JSON.parse(r.body));
}

// Find a project's live state in a status payload.
function findProject(status, host) {
  return status.projects.find((x) => x.host === host);
}

// Open a raw WS upgrade through the daemon to `host`; resolve the live client
// socket (already switched protocols) once the 101 is seen.
function openUpgrade(daemonPort, host) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: daemonPort });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sock.removeListener('data', onData);
        if (/HTTP\/1\.1 101/.test(buf)) resolve(sock);
        else {
          sock.destroy();
          reject(new Error(`upgrade failed: ${buf.split('\r\n')[0]}`));
        }
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
    sock.once('connect', () => {
      sock.write(
        `GET /hmr HTTP/1.1\r\n` +
          `Host: ${host}.localhost\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });
  });
}

// Spawn a detached, harmless `sleep` the reaper's stop() can actually signal.
function spawnSleep() {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

// True once the pid is gone (kill 0 throws). Polls up to ~2s.
async function waitDead(pid) {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(50);
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killQuietly(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

// --- Tests -------------------------------------------------------------------

test('an open HMR socket with recent bytes survives the idle timeout (criterion 1)', async (t) => {
  const host = 'survive';
  const fake = await startFakeDevServer();
  writeConfig({ host, port: fake.port, idleTimeoutMs: 50, connectionHardCapMs: 7_200_000 });
  loadConfig('test');
  const { srv, port } = await startDaemon();
  // A real child so that IF the reaper wrongly reaped, the process would die and
  // state would flip — the connection must keep both alive.
  const child = spawnSleep();
  t.after(() => {
    srv.close();
    fake.close();
    killQuietly(child);
  });

  __setRuntimeForTest(host, {
    state: 'running',
    owned: true,
    upstreamHost: '127.0.0.1',
    pid: child.pid,
    child,
  });

  const ws = await openUpgrade(port, host);
  t.after(() => ws.destroy());
  // Send a byte so the connection has a fresh lastByteAt (well within the cap).
  ws.write('ping');
  await sleep(80); // > idleTimeoutMs of 50ms

  // Idle clock is stale, but the live connection must defer the reap.
  __setLastAccessForTest(host, Date.now() - 10_000);
  const info = __liveConnInfo(host);
  assert.ok(info.count >= 1, `expected a live connection, got ${JSON.stringify(info)}`);
  assert.ok(info.active >= 1, `live connection should defer the reaper, got ${JSON.stringify(info)}`);

  reapIdle();
  await sleep(50);

  const status = await statusThrough(port);
  const p = findProject(status, host);
  assert.equal(p.state, 'running', 'project with a live socket must survive the idle timeout');
  assert.equal(p.owned, true, 'still owned by xerb');
  let dead = false;
  try {
    process.kill(child.pid, 0);
  } catch {
    dead = true;
  }
  assert.equal(dead, false, 'the dev-server child must NOT have been killed');
});

test('zero connections past the idle timeout is reaped (criterion 2)', async (t) => {
  const host = 'zeroconn';
  writeConfig({ host, port: 1, idleTimeoutMs: 50 });
  loadConfig('test');
  const { srv, port } = await startDaemon();
  const child = spawnSleep();
  t.after(() => {
    srv.close();
    killQuietly(child);
  });

  __setRuntimeForTest(host, {
    state: 'running',
    owned: true,
    upstreamHost: '127.0.0.1',
    pid: child.pid,
    child,
  });
  // No connections. Idle clock well past the 50ms timeout.
  __setLastAccessForTest(host, Date.now() - 10_000);

  assert.equal(__liveConnInfo(host).active, 0, 'no connections should defer');
  reapIdle();

  assert.ok(await waitDead(child.pid), 'the reaper should have killed the idle project');
  const status = await statusThrough(port);
  const p = findProject(status, host);
  assert.equal(p.state, 'stopped', 'idle project with no connections must be reaped');
  assert.equal(p.owned, false, 'reaped project is no longer owned');
});

test('a connection silent past the hard cap stops deferring the reaper (criterion 3)', async (t) => {
  const host = 'stale';
  // Tiny hard cap so we can age a record well past it.
  writeConfig({ host, port: 1, idleTimeoutMs: 50, connectionHardCapMs: 30 });
  loadConfig('test');
  const { srv, port } = await startDaemon();
  const child = spawnSleep();
  t.after(() => {
    srv.close();
    killQuietly(child);
  });

  __setRuntimeForTest(host, {
    state: 'running',
    owned: true,
    upstreamHost: '127.0.0.1',
    pid: child.pid,
    child,
  });

  // An open connection whose last byte is well past the hard cap.
  const rec = __addConnForTest(host);
  rec.lastByteAt = Date.now() - 10_000; // >> 30ms cap
  __setLastAccessForTest(host, Date.now() - 10_000);

  const info = __liveConnInfo(host);
  assert.equal(info.count, 1, 'the stale socket is still live (count reflects it)');
  assert.equal(info.active, 0, 'a socket past the hard cap must NOT defer the reaper');

  reapIdle();
  assert.ok(await waitDead(child.pid), 'a project whose only connection is stale must be reaped');
  const status = await statusThrough(port);
  const p = findProject(status, host);
  assert.equal(p.state, 'stopped', 'silent-past-hard-cap project must be reaped');
});

test('an adopted / external project is never reaped (criterion 4)', async (t) => {
  const host = 'adopted';
  const fake = await startFakeDevServer();
  writeConfig({ host, port: fake.port, idleTimeoutMs: 50 });
  loadConfig('test');
  const { srv, port } = await startDaemon();
  t.after(() => {
    srv.close();
    fake.close();
  });

  // A real GET through the daemon kicks ensureUp, which ADOPTs the already-
  // listening fake server -> owned=false. The cold-start path answers the first
  // hit immediately (503, no blocking) and adopts in the background, so poll the
  // status until the adopt lands before asserting. That adopted (unowned) server
  // must never be reaped, however idle.
  await httpGetThrough(port, host); // kicks the background adopt
  let status, p;
  for (let i = 0; i < 40; i++) {
    status = await statusThrough(port);
    p = findProject(status, host);
    if (p && p.state === 'running') break;
    await sleep(50);
  }
  assert.equal(p.state, 'running', 'adopted server should be running');
  assert.equal(p.owned, false, 'adopted server is not owned by xerb');

  // Once adopted, a real GET proxies straight through to the fake dev server.
  const res = await httpGetThrough(port, host);
  assert.equal(res.status, 200, 'proxied GET should reach the fake dev server');

  // Age it far past the idle timeout and reap.
  __setLastAccessForTest(host, Date.now() - 10_000);
  reapIdle();
  await sleep(50);

  status = await statusThrough(port);
  p = findProject(status, host);
  assert.equal(p.state, 'running', 'an unowned/adopted project must never be reaped');
  assert.equal(p.owned, false, 'still not owned');

  // Fake server is still up.
  const again = await httpGetThrough(port, host);
  assert.equal(again.status, 200, 'fake dev server should still be reachable');
});

test('connCount appears in the status JSON and tracks an open connection (criterion 5)', async (t) => {
  const host = 'counted';
  const fake = await startFakeDevServer();
  writeConfig({ host, port: fake.port, idleTimeoutMs: 1_800_000 });
  loadConfig('test');
  const { srv, port } = await startDaemon();
  t.after(() => {
    srv.close();
    fake.close();
  });

  // Baseline: adopt the server with a fresh (non-keep-alive) GET, which closes
  // immediately, so no held-open connection -> connCount 0.
  await httpGetThrough(port, host);
  let status = await statusThrough(port);
  let p = findProject(status, host);
  assert.ok('connCount' in p, 'status JSON must expose connCount');
  // The GET's socket may still be closing; poll down to 0 first.
  for (let i = 0; i < 20 && p.connCount !== 0; i++) {
    await sleep(50);
    status = await statusThrough(port);
    p = findProject(status, host);
  }
  assert.equal(p.connCount, 0, 'no held-open connection at baseline');

  // Open a WS/HMR upgrade and hold it -> connCount rises to at least 1.
  const ws = await openUpgrade(port, host);
  await sleep(50);
  status = await statusThrough(port);
  p = findProject(status, host);
  assert.ok(p.connCount >= 1, `open connection should raise connCount (got ${p.connCount})`);

  // Close it -> connCount returns to 0 (the 'close' teardown is async, so poll).
  ws.destroy();
  let back = false;
  for (let i = 0; i < 40; i++) {
    status = await statusThrough(port);
    p = findProject(status, host);
    if (p.connCount === 0) {
      back = true;
      break;
    }
    await sleep(50);
  }
  assert.ok(back, 'connCount should return to 0 after the connection closes');
});
