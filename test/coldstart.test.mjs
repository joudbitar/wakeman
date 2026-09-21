// Cold-start status-page tests for the daemon.
//
// Proves that a cold hit answers IMMEDIATELY instead of blocking on ensureUp:
// a browser navigation gets a self-refreshing status page, curl/XHR gets a
// plain 503 + Retry-After, the page hands off to the app once the port answers,
// a start that never opens the port surfaces its failure, and N concurrent hits
// still spawn exactly one child. Pure node:test + node:assert, zero deps.
//
// XERB_CONFIG is read at module load (CONFIG_PATH, captured once), so we set
// it and write the temp registry BEFORE the dynamic import of ../xerb.mjs,
// then call the exported loadConfig() explicitly (the daemon only auto-loads
// under RUN_AS_MAIN, which a test import deliberately skips).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- temp registry + import (must precede importing the module) -------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-coldstart-'));
const configPath = path.join(tmpDir, 'projects.json');
// A node_modules dir makes ensureUp skip the install step for every project that
// uses tmpDir as its cwd — so the tests never shell out to a real `npm install`
// (which would be slow, non-deterministic, and PATH-dependent). Projects here
// go straight to spawn+start-then-timeout.
fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });

// A cheap default config so the import + first loadConfig has a valid file. Each
// test rewrites it with its own project(s) and calls loadConfig() again.
function writeConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg));
}
writeConfig({ port: 0, projects: [] });

process.env.XERB_CONFIG = configPath;

const {
  createDaemonServer,
  loadConfig,
  wantsHtml,
  phaseLabel,
  statusPageHtml,
  getRuntime,
  ensureUp,
  stop,
  upstreamAgent,
  __setResolvePidCwd,
} = await import('../xerb.mjs');

// These tests adopt fake HTTP servers whose real working directory is the test
// runner's cwd, not the project dir. Under the cwd-verified adoption added later,
// that mismatch would be flagged as a port CONFLICT instead of an adopt. Force
// the PID->cwd resolver to "unresolved" (null) so every adopt here degrades to
// the legacy unverified adopt — the behavior these cold-start tests were written
// against. Spawn-path tests never listen first, so the resolver is never hit.
__setResolvePidCwd(() => null);

// --- helpers ----------------------------------------------------------------

// Listen on an OS-assigned port and resolve it (or reject on bind error).
function listen(server, host) {
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
    server.listen(0, host);
  });
}

// GET path over a fresh connection to host:port with the given headers.
// Resolves { status, headers, body } and records elapsed ms.
function httpReq(host, port, headers = {}, reqPath = '/') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request(
      { host, port, method: 'GET', path: reqPath, headers: { host: headers.host || 'demo.localhost', ...headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, ms: Date.now() - started }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Spin up a trivial HTTP server that answers 200 'ok', bound to 127.0.0.1:port
// (or an OS-assigned port when port is 0). Returns { server, port }.
function fakeServer(port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_q, s) => {
      s.writeHead(200, { 'content-type': 'text/plain' });
      s.end('ok');
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Poll a predicate against getRuntime(host) until true or timeout.
async function waitFor(host, pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred(getRuntime(host))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// Stop an owned child and await any in-flight background bring-up so its
// waitForPort poll loop can't outlive the test. handleRequest kicks ensureUp
// WITHOUT awaiting it (the whole point of the cold path), so tests that trigger
// a cold hit must drain the promise here or it leaks a timer into a later test.
async function cleanup(host) {
  stop(host);
  const r = getRuntime(host);
  if (r.startPromise) await r.startPromise.catch(() => {});
}

// Close a server AND drop its live connections. server.close() alone leaves
// keep-alive / upgraded sockets open (they'd keep the process alive past the
// last test); closeAllConnections() forces them shut so `node --test` exits.
function closeServer(server) {
  try { server.closeAllConnections?.(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
}

// --- pure unit: wantsHtml negotiation ---------------------------------------

test('wantsHtml: navigate header and Accept negotiation', () => {
  assert.equal(wantsHtml({ headers: { 'sec-fetch-mode': 'navigate' } }), true, 'navigate -> html');
  assert.equal(wantsHtml({ headers: { accept: 'text/html,application/xhtml+xml' } }), true, 'text/html first -> html');
  assert.equal(wantsHtml({ headers: { accept: 'application/json' } }), false, 'json -> not html');
  // A JSON-leading Accept that also lists text/html (some XHR libs) is NOT html.
  assert.equal(wantsHtml({ headers: { accept: 'application/json, text/html' } }), false, 'json-first -> not html');
  assert.equal(wantsHtml({ headers: { accept: '*/*' } }), false, '*/* (curl) -> not html');
  assert.equal(wantsHtml({ headers: {} }), false, 'no headers -> not html');
  // navigate wins even if Accept looks like JSON.
  assert.equal(wantsHtml({ headers: { 'sec-fetch-mode': 'navigate', accept: 'application/json' } }), true, 'navigate overrides');
});

test('phaseLabel maps state to phase words', () => {
  assert.equal(phaseLabel({ state: 'installing' }), 'installing');
  assert.equal(phaseLabel({ state: 'starting' }), 'starting');
  assert.equal(phaseLabel({ state: 'stopped', lastError: { message: 'boom' } }), 'failed');
  assert.equal(phaseLabel({ state: 'stopped', lastError: null }), 'waking');
  assert.equal(phaseLabel({ state: 'running' }), 'waking'); // running never renders a status page
});

// --- criterion: cold nav hit answers before the bring-up attempt settles ----

test('cold navigation gets an immediate status page (no blocking on ensureUp)', async (t) => {
  // startCmd sleeps so the port never opens -> the background attempt can only
  // end by hitting startTimeoutMs. A handler that awaited ensureUp could
  // therefore never respond before that deadline, and by the time it did,
  // ensureUp's finally would have cleared r.startPromise and set r.lastError.
  // That gives two load-proof assertions in place of a wall-clock target:
  // the response must arrive while startPromise is still pending, and in under
  // startTimeoutMs. No absolute bound like "<200ms" — under a parallel
  // `node --test` run this response has been measured near 500ms on a loaded
  // machine while still being perfectly non-blocking. startTimeoutMs is 3000
  // to keep that headroom wide; cleanup drains the attempt so the wait is
  // bounded by the same number.
  const START_TIMEOUT_MS = 3000;
  writeConfig({
    port: 0,
    startTimeoutMs: START_TIMEOUT_MS,
    projects: [{ host: 'slow', dir: tmpDir, port: 0, startCmd: "sh -c 'sleep 30'", enabled: true }],
  });
  loadConfig('test');

  const server = createDaemonServer();
  t.after(async () => { closeServer(server); await cleanup('slow'); });
  const port = await listen(server, '127.0.0.1');

  const res = await httpReq('127.0.0.1', port, { host: 'slow.localhost', accept: 'text/html', 'sec-fetch-mode': 'navigate' });
  // Snapshot the runtime the instant the response is in hand (no awaits between).
  const r = getRuntime('slow');

  assert.equal(res.status, 200, 'nav cold hit -> 200 status page');
  assert.match(res.headers['content-type'] || '', /text\/html/, 'content-type is html');
  assert.match(res.body, /slow/, 'names the project host');
  assert.match(res.body, /waking|installing|starting/, 'names a bring-up phase');
  // The true intent: it did not block on the start path. Blocking would mean
  // the wake attempt already settled (startPromise null, lastError recorded)
  // before we ever got a byte.
  assert.ok(r.startPromise, 'bring-up attempt still in flight when the response arrived');
  assert.equal(r.lastError, null, 'no failure recorded yet at response time');
  assert.ok(res.ms < START_TIMEOUT_MS, `response beat the start timeout (took ${res.ms}ms, timeout ${START_TIMEOUT_MS}ms)`);
});

// --- criterion: Accept: application/json during bring-up -> 503, no HTML -----

test('cold JSON/XHR hit gets 503 + Retry-After, no HTML', async (t) => {
  writeConfig({
    port: 0,
    startTimeoutMs: 800,
    projects: [{ host: 'jsonp', dir: tmpDir, port: 0, startCmd: "sh -c 'sleep 30'", enabled: true }],
  });
  loadConfig('test');

  const server = createDaemonServer();
  t.after(async () => { closeServer(server); await cleanup('jsonp'); });
  const port = await listen(server, '127.0.0.1');

  const res = await httpReq('127.0.0.1', port, { host: 'jsonp.localhost', accept: 'application/json' });

  assert.equal(res.status, 503, 'json cold hit -> 503');
  assert.equal(res.headers['retry-after'], '1', 'Retry-After: 1 present');
  assert.doesNotMatch(res.headers['content-type'] || '', /text\/html/, 'not html content-type');
  assert.doesNotMatch(res.body, /</, 'body has no HTML markup');
  assert.match(res.body, /waking|installing|starting/, 'plain phase word body');
});

// --- criterion: hands off to the app once the port answers (adopt flavor) ---

test('running project (adopted) proxies straight through, not the status page', async (t) => {
  const fake = await fakeServer(0); // OS-assigned port, already listening
  writeConfig({
    port: 0,
    projects: [{ host: 'adopt', dir: tmpDir, port: fake.port, startCmd: "sh -c 'sleep 30'", enabled: true }],
  });
  loadConfig('test');

  const server = createDaemonServer();
  t.after(() => { closeServer(server); closeServer(fake.server); stop('adopt'); });
  const port = await listen(server, '127.0.0.1');

  // Drive the adopt: ensureUp probes the port, sees the fake, adopts -> running.
  await ensureUp({ host: 'adopt', dir: tmpDir, port: fake.port, startCmd: "sh -c 'sleep 30'", enabled: true });
  const r = getRuntime('adopt');
  assert.equal(r.state, 'running', 'adopted -> running');
  assert.equal(r.owned, false, 'external listener is not owned');
  assert.ok(r.upstreamHost, 'upstreamHost pinned after adopt');

  // A nav GET now takes the warm path and proxies to the fake ('ok'), NOT the
  // status page. This is the "hands off once the port answers" edge: the poll
  // loop's Accept:json request would likewise proxy (non-503) and reload.
  const res = await httpReq('127.0.0.1', port, { host: 'adopt.localhost', accept: 'text/html', 'sec-fetch-mode': 'navigate' });
  assert.equal(res.status, 200, 'warm nav -> 200 from app');
  assert.equal(res.body, 'ok', 'body is the proxied app response, not the status page');

  // And the poll edge: Accept:json against a running project proxies (non-503).
  const poll = await httpReq('127.0.0.1', port, { host: 'adopt.localhost', accept: 'application/json' });
  assert.notEqual(poll.status, 503, 'poll against running project is not 503');
  assert.equal(poll.body, 'ok', 'poll proxies to the app');
});

// --- criterion: a start that never opens the port surfaces its failure ------

test('failed start surfaces the reason + log tail in the status page', async (t) => {
  writeConfig({
    port: 0,
    startTimeoutMs: 300, // tiny: fail fast
    installTimeoutMs: 300,
    projects: [{ host: 'broke', dir: tmpDir, port: 0, startCmd: "sh -c 'sleep 5'", enabled: true }],
  });
  loadConfig('test');

  // tmpDir already has node_modules (created at top of file), so install is
  // skipped and we go straight to start-then-timeout (the port at :0 never
  // opens because sleep never listens).

  const server = createDaemonServer();
  // Drain any in-flight re-kick before the test ends so no stray background
  // attempt (which reads config.startTimeoutMs at call time) outlives this test
  // and pollutes a later one's config/event loop.
  t.after(async () => { closeServer(server); await cleanup('broke'); });
  const port = await listen(server, '127.0.0.1');

  // First nav hit kicks bring-up and returns the (non-terminal) waking page.
  const first = await httpReq('127.0.0.1', port, { host: 'broke.localhost', accept: 'text/html', 'sec-fetch-mode': 'navigate' });
  assert.equal(first.status, 200, 'first nav -> status page');

  // Wait for the background start to time out and record lastError.
  const failed = await waitFor('broke', (r) => r.state === 'stopped' && r.lastError, 3000);
  assert.ok(failed, 'background start reached stopped+lastError');

  // A reload without ?retry=1 lands on the terminal failure page (no re-kick).
  const failure = await httpReq('127.0.0.1', port, { host: 'broke.localhost', accept: 'text/html', 'sec-fetch-mode': 'navigate' });
  assert.equal(failure.status, 200, 'failure nav -> 200 status page');
  assert.match(failure.body, /failed to start/i, 'names the failure');
  assert.match(failure.body, /The dev server failed to start\./, 'unauthorized failure page keeps the generic reason');
  // Section 4: the headline sentence is the one for THIS kind. `sleep 5` never
  // binds, so this is the timeout kind, and the sentence must say so with the
  // port and the timeout in it, not the one-size copy every kind used to get.
  assert.equal(getRuntime('broke').lastError.kind, 'timeout', 'a start that never binds is the timeout kind');
  assert.match(
    failure.body,
    /Nothing answered on port \d+ within \d+s\. The process is still being killed\./,
    'timeout copy carries the port and the timeout'
  );
  assert.match(failure.body, /\?retry=1/, 'Retry link carries the explicit retry flag');

  // /?retry=1 kicks a fresh attempt and shows the wake page instead of the
  // stale failure snapshot. Drain the re-kick in t.after so it can't leak.
  const res = await httpReq(
    '127.0.0.1',
    port,
    { host: 'broke.localhost', accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    '/?retry=1'
  );
  assert.equal(res.status, 200, 'retry nav -> 200 status page');
  assert.doesNotMatch(res.body, /failed to start/i, 'retry does not immediately re-show the failure page');
  assert.match(res.body, /being turned on/i, 'retry shows the wake page while bring-up runs');
  assert.match(res.body, /__xerb\/tail/, 'wake page wires up the terminal panel');

  // Settle the re-kicked attempt now (config is still 300ms here) so it times
  // out fast and doesn't run under a later test's larger startTimeout.
  const r2 = getRuntime('broke');
  if (r2.startPromise) await r2.startPromise.catch(() => {});
});

// --- criterion: N concurrent first hits spawn exactly one child (real spawn) -

test('N concurrent cold hits spawn exactly one child', async (t) => {
  // A throwaway project dir so its node_modules presence is independent of the
  // shared tmpDir (which other tests mutate). startCmd is a node one-liner that
  // (a) appends a unique line to a marker file on boot and (b) listens on the
  // project port, so we can count how many children actually launched.
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-spawn-'));
  fs.mkdirSync(path.join(projDir, 'node_modules'), { recursive: true }); // skip install
  const markerFile = path.join(projDir, 'boot-marker.txt');

  // Reserve an OS-assigned free port by opening then closing a listener.
  const probe = await fakeServer(0);
  const projPort = probe.port;
  await new Promise((r) => probe.server.close(r));

  const startCmd =
    `node -e "require('fs').appendFileSync('${markerFile}','boot\\n');` +
    `require('http').createServer((q,s)=>s.end('ok')).listen(${projPort},'127.0.0.1')"`;

  writeConfig({
    port: 0,
    startTimeoutMs: 10_000,
    projects: [{ host: 'spawn', dir: projDir, port: projPort, startCmd, enabled: true }],
  });
  loadConfig('test');

  const server = createDaemonServer();
  t.after(async () => {
    closeServer(server);
    await cleanup('spawn');
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  const port = await listen(server, '127.0.0.1');

  // Fire 20 concurrent hits, mixing navigation and non-navigation clients.
  const hits = [];
  for (let i = 0; i < 20; i++) {
    const headers = i % 2 === 0
      ? { host: 'spawn.localhost', accept: 'text/html', 'sec-fetch-mode': 'navigate' }
      : { host: 'spawn.localhost', accept: 'application/json' };
    hits.push(httpReq('127.0.0.1', port, headers).catch(() => null));
  }
  await Promise.all(hits);

  // Wait for the single child to actually open the port.
  const up = await waitFor('spawn', (r) => r.state === 'running', 8000);
  assert.ok(up, 'project reached running');

  const r = getRuntime('spawn');
  assert.equal(r.owned, true, 'we own the spawned child');
  assert.ok(r.pid, 'a child pid is set');

  // The decisive assertion: exactly ONE boot marker line -> exactly one child
  // launched despite 20 concurrent hits (the r.startPromise mutex held).
  const marker = fs.readFileSync(markerFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(marker.length, 1, `exactly one child booted (marker lines: ${JSON.stringify(marker)})`);

  // And no second listener collided on the port (EADDRINUSE would appear if a
  // second child had raced the first).
  const logTail = (() => {
    try { return fs.readFileSync(path.join(path.dirname(new URL('../xerb.mjs', import.meta.url).pathname), 'logs', 'spawn.log'), 'utf8'); } catch { return ''; }
  })();
  assert.doesNotMatch(logTail, /EADDRINUSE/, 'no port collision in the child log');
});

// --- criterion: WebSocket upgrade works once the server is up ---------------

test('WS upgrade reaches the app once running (adopt flavor)', async (t) => {
  // A fake server that speaks the raw upgrade handshake: on 'upgrade' it writes
  // 101 Switching Protocols. Adopt it so the project is running, then send an
  // Upgrade through the daemon and assert the 101 comes back. Track every
  // upgraded socket so teardown can destroy them — an upgraded socket is
  // detached from the HTTP server, so closeAllConnections() won't reach it.
  const upgraded = [];
  const wsPort = await new Promise((resolve, reject) => {
    const srv = http.createServer((_q, s) => s.end('ok'));
    srv.on('upgrade', (_req, socket) => {
      upgraded.push(socket);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      t.after(() => { for (const s of upgraded) { try { s.destroy(); } catch { /* ignore */ } } closeServer(srv); });
      resolve(srv.address().port);
    });
  });

  writeConfig({
    port: 0,
    projects: [{ host: 'wsapp', dir: tmpDir, port: wsPort, startCmd: "sh -c 'sleep 30'", enabled: true }],
  });
  loadConfig('test');

  const server = createDaemonServer();
  t.after(() => { closeServer(server); stop('wsapp'); });
  const port = await listen(server, '127.0.0.1');

  await ensureUp({ host: 'wsapp', dir: tmpDir, port: wsPort, startCmd: "sh -c 'sleep 30'", enabled: true });
  assert.equal(getRuntime('wsapp').state, 'running', 'adopted ws app -> running');

  // Raw upgrade request through the daemon.
  const handshake = await new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.write(
        'GET / HTTP/1.1\r\n' +
        'Host: wsapp.localhost\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let buf = '';
    sock.setEncoding('utf8');
    sock.setTimeout(3000);
    sock.on('data', (c) => {
      buf += c;
      if (buf.includes('\r\n\r\n')) { sock.destroy(); resolve(buf); }
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('ws handshake timeout')); });
    sock.on('error', reject);
  });

  assert.match(handshake, /101 Switching Protocols/, 'daemon proxied the WS upgrade to the app');
});

// --- criterion: a child that dies pre-port never adopts a foreign listener ---

test('child exiting before the port opens fails the start, even with a foreign listener', async (t) => {
  // Reproduces the npx-boot flake: our spawned child exits code 1 within ms,
  // then ANOTHER process (here a fake server; in real life a concurrent test
  // run's dev server) starts listening on the project port. The old bare
  // waitForPort found that foreign listener, logged "ready", and marked the
  // project running/owned with a dead pid — wedging every later proxy on
  // ECONNREFUSED once the foreigner left. ensureUp now races the port wait
  // against the child's exit, so the exit must win: fast rejection carrying
  // the exit code, no ownership claimed.
  const probe = await fakeServer(0);
  const projPort = probe.port;
  await new Promise((r) => probe.server.close(r));

  // The child must OUTLIVE the spawn long enough for the test to see
  // state==='starting' and bind the foreign listener (waitForPort's probe #1
  // fires at spawn time and must miss it), yet exit BEFORE probe #2 at +250ms —
  // reproducing the real ordering: exit first, foreign listener found by a
  // later probe. sleep 0.1 sits between those edges.
  const START_TIMEOUT_MS = 5000;
  const project = { host: 'earlyexit', dir: tmpDir, port: projPort, startCmd: "sh -c 'sleep 0.1; exit 7'", enabled: true };
  writeConfig({ port: 0, startTimeoutMs: START_TIMEOUT_MS, projects: [project] });
  loadConfig('test');

  let foreign;
  t.after(async () => { if (foreign) closeServer(foreign.server); await cleanup('earlyexit'); });

  const attempt = ensureUp(project);
  attempt.catch(() => {}); // re-awaited below; keep the rejection handled meanwhile

  // Once the child is spawned (state 'starting' — the fresh runtime's initial
  // state is 'stopped', so only 'starting' proves the spawn happened; the
  // lastError arm covers a loaded machine where the child exits before our
  // first 25ms poll), occupy the port with a foreign listener so the old
  // code's next waitForPort probe would find it and falsely report ready.
  const spawned = await waitFor(
    'earlyexit',
    (r) => r.state === 'starting' || (r.lastError && r.lastError.code === 'START_EXITED'),
    3000
  );
  assert.ok(spawned, 'child spawned');
  foreign = await fakeServer(projPort);

  const started = Date.now();
  const err = await attempt.then(() => null, (e) => e);
  assert.ok(err, 'ensureUp rejected instead of adopting the foreign listener');
  assert.equal(err.code, 'START_EXITED', `failure is the child exit, not a timeout (got ${err && err.code})`);
  assert.equal(err.exitCode, 7, 'carries the child exit code');
  assert.ok(Date.now() - started < START_TIMEOUT_MS, 'failed fast, not by riding out the start timeout');

  const r = getRuntime('earlyexit');
  assert.equal(r.state, 'stopped', 'not wedged in running');
  assert.equal(r.owned, false, 'no ownership claimed over a dead pid');
  assert.equal(r.pid, null, 'no stale pid retained');
  assert.equal(r.lastError && r.lastError.code, 'START_EXITED', 'lastError records the exit for the status page');
  // Section 4: the numbers the failure copy quotes are captured at failure
  // time, not re-derived when the page renders.
  assert.equal(r.lastError.kind, 'exited', 'the kind the copy table switches on');
  assert.equal(r.lastError.exitCode, 7, 'the code the page quotes');
  assert.equal(typeof r.lastError.elapsedMs, 'number', 'how long the child lived, for "after 0.1s"');
});

// --- the install gate: nothing to install means no install -------------------

// A listener that reads PORT, as a dev script. No framework, no dependencies.
const DEV_SERVER = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT,'127.0.0.1')"`;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Everything xerb's own log() printed while fn ran.
async function daemonLogDuring(fn) {
  let text = '';
  const orig = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    text += String(chunk);
    return orig.call(this, chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return text;
}

test('a package.json with no dependencies starts without an install', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-nodeps-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  const port = await freePort();
  const project = { host: 'nodeps', dir, port, startCmd: DEV_SERVER, enabled: true };
  writeConfig({ port: 0, startTimeoutMs: 15000, projects: [project] });
  loadConfig('test');
  t.after(async () => {
    await cleanup('nodeps');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seen = [];
  const watch = setInterval(() => seen.push(getRuntime('nodeps').state), 5);
  t.after(() => clearInterval(watch));
  const logged = await daemonLogDuring(() => ensureUp(project));
  clearInterval(watch);

  assert.equal(getRuntime('nodeps').state, 'running');
  assert.ok(!seen.includes('installing'), 'the wake page never says "installing"');
  assert.doesNotMatch(logged, /install:/, 'no install line in the daemon log');
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false, 'the gate would still be open on the next wake');
});

test('one dependency and no node_modules still installs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-onedep-'));
  // A file: dependency, so the install is real and never touches the network.
  const dep = path.join(dir, 'dep');
  fs.mkdirSync(dep);
  fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'onedep', version: '1.0.0', dependencies: { dep: 'file:./dep' } }));
  const port = await freePort();
  const project = { host: 'onedep', dir, port, startCmd: DEV_SERVER, enabled: true };
  writeConfig({ port: 0, startTimeoutMs: 15000, installTimeoutMs: 60000, projects: [project] });
  loadConfig('test');
  t.after(async () => {
    await cleanup('onedep');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const logged = await daemonLogDuring(() => ensureUp(project));
  assert.match(logged, /install:/, 'the install ran');
  assert.equal(getRuntime('onedep').state, 'running');
});

test('a workspace root installs, and a package.json that will not parse does not', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-ws-'));
  fs.mkdirSync(path.join(ws, 'packages'));
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }));
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-badjson-'));
  fs.writeFileSync(path.join(bad, 'package.json'), '{ not json');
  const wsProject = { host: 'wsroot', dir: ws, port: await freePort(), startCmd: DEV_SERVER, enabled: true };
  const badProject = { host: 'badjson', dir: bad, port: await freePort(), startCmd: DEV_SERVER, enabled: true };
  writeConfig({
    port: 0,
    startTimeoutMs: 15000,
    installTimeoutMs: 60000,
    projects: [wsProject, badProject],
  });
  loadConfig('test');
  t.after(async () => {
    await cleanup('wsroot');
    await cleanup('badjson');
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(bad, { recursive: true, force: true });
  });

  assert.match(await daemonLogDuring(() => ensureUp(wsProject)), /install:/);
  assert.doesNotMatch(await daemonLogDuring(() => ensureUp(badProject)), /install:/);
  assert.equal(getRuntime('badjson').state, 'running', 'the start command gets to speak for itself');
});

// --- cleanup ----------------------------------------------------------------

test('cleanup temp registry and pooled sockets', () => {
  // Destroy the module-shared keep-alive agent's pooled upstream sockets — they
  // outlive the proxy tests' fake servers and would otherwise keep the test
  // process alive past the last test.
  try { upstreamAgent.destroy(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
