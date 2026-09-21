// Port-ownership verification tests for the adopt-or-conflict decision.
//
// Before adopting a listener lazydev did not spawn, the daemon resolves the
// listening PID's cwd and compares it to project.dir. Match -> adopt (external);
// mismatch -> a visible `conflict` state that is NEVER proxied; unresolved cwd
// (e.g. lsof missing) -> degrade to the legacy adopt. These tests prove all
// three paths end-to-end (real daemon, real proxied HTTP) plus the pure sameDir
// helper. The PID->cwd resolver is swapped via __setResolvePidCwd so no real
// lsof runs — deterministic in CI. No real projects, no fixed ports.
//
// Adoption is also re-checked, not just decided once (spec 0.3.0 section 5): the
// pid that held the port at adoption is stored on the record and re-resolved
// before proxying, at most once every ADOPT_VERIFY_TTL_MS. Tests F and G cover
// the stranger-takes-the-port case and the cache that keeps it to one lsof every
// two seconds. Both swap __setResolveListenerPid, which is also why every adopt
// test below pins a pid: the adopt path resolves one now.

import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// LAZYDEV_CONFIG is read at module load, so the temp registry must exist and the
// env var must point at it BEFORE importing lazydev.mjs. node --test runs the
// whole file in one process, so we set both at top-level here.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-adopt-'));
const CONFIG_PATH = path.join(TMP_ROOT, 'projects.json');
// A real directory to use as the matching project.dir (so realpath in sameDir
// has something to resolve). The mismatching case uses a bogus path on purpose.
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-projdir-'));

// The registry port is rewritten per-test to the fake server's OS-assigned port.
function writeRegistry(port, dir) {
  const registry = {
    port: 0, // daemon listen port is irrelevant here; we listen on an ephemeral port
    projects: [
      { host: 'proj', dir, port, startCmd: 'true', enabled: true, framework: 'node' },
    ],
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(registry));
}

// Seed a placeholder so the import-time load doesn't warn; real values per-test.
writeRegistry(0, PROJECT_DIR);
process.env.LAZYDEV_CONFIG = CONFIG_PATH;
// Point the control-token at a temp file so minting one here never touches the
// real repo's control-token (issue-5 gates mutating control POSTs on this token).
process.env.LAZYDEV_CONTROL_TOKEN_PATH = path.join(TMP_ROOT, 'control-token');

const {
  createDaemonServer,
  loadConfig,
  sameDir,
  __setResolvePidCwd,
  __setResolveListenerPid,
  ensureControlToken,
  __setRuntimeForTest,
  ADOPT_VERIFY_TTL_MS,
} = await import('../lazydev.mjs');

// Listen on an OS-assigned loopback port; resolve the actual port.
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// GET path over a fresh 127.0.0.1 connection with a Host header; resolve
// { status, body }. 127.0.0.1 so the daemon's loopback guard admits the request.
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

function httpPost(port, hostHeader, reqPath, token) {
  const headers = { host: hostHeader };
  // issue-5 gates mutating control POSTs on the capability token; send it when
  // provided so /__lazydev/up reaches its handler instead of a 403.
  if (token) headers['x-lazydev-token'] = token;
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

// A fake dev server that records how many requests it received. `port` is
// OS-assigned; the registry points a project at it.
function fakeDevServer(bodyText) {
  let count = 0;
  const srv = http.createServer((req, res) => {
    count += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(bodyText);
  });
  return {
    srv,
    get count() {
      return count;
    },
  };
}

function statusFor(port, host) {
  return httpGet(port, 'lazydev.localhost', '/__lazydev/status').then((r) => {
    const parsed = JSON.parse(r.body);
    return parsed.projects.find((p) => p.host === host);
  });
}

before(() => {
  loadConfig('adopt-test');
});

// Reset the injected resolver after each test so overrides never leak. Also
// clear the runtime record for the shared 'proj' host: these tests deliberately
// reuse one host across adopt/conflict scenarios, and the warm-path short-circuit
// (proxy straight through when state==='running' with a pinned upstream) would
// otherwise carry an earlier test's adopted state into the next one — so the
// next request would proxy instead of re-running the adopt-or-conflict decision.
afterEach(() => {
  __setResolvePidCwd(null); // null -> restores defaultResolvePidCwd
  __setResolveListenerPid(null); // same, for the adopt-time / re-verify pid lookup
  __setRuntimeForTest('proj', {
    state: 'stopped',
    owned: false,
    child: null,
    pid: null,
    startPromise: null,
    upstreamHost: null,
    lastError: null,
    conflictDir: null,
    adoptedPid: null,
    verifiedAt: 0,
  });
});

test('A: sameDir normalizes trailing slash and . segments', () => {
  assert.equal(sameDir('/a/b', '/a/b/'), true);
  assert.equal(sameDir('/a/b/', '/a/b'), true);
  assert.equal(sameDir('/a/b', '/a/./b'), true);
  assert.equal(sameDir('/a/b', '/a/c'), false);
  assert.equal(sameDir('/a/b', '/a/b/c'), false);
  assert.equal(sameDir('', '/a/b'), false);
  assert.equal(sameDir('/a/b', ''), false);
});

test('B: external listener with matching cwd is adopted and proxied', async (t) => {
  const fake = fakeDevServer('hello-from-fake');
  const fakePort = await listen(fake.srv);
  writeRegistry(fakePort, PROJECT_DIR);
  loadConfig('test-B');

  // Fake resolvers: the listener's cwd equals project.dir -> match -> adopt.
  // The pid is pinned too, because the adopt path records it for re-verification.
  __setResolvePidCwd(() => PROJECT_DIR);
  __setResolveListenerPid(() => 1111);

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(() => {
    daemon.close();
    fake.srv.close();
  });

  const res = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(res.status, 200, `expected proxied 200, got ${res.status}`);
  assert.equal(res.body, 'hello-from-fake', 'body should be the fake server response');
  assert.ok(fake.count >= 1, 'fake server should have received the proxied request');

  const entry = await statusFor(daemonPort, 'proj');
  assert.equal(entry.state, 'running', 'adopted external server is running');
  assert.equal(entry.owned, false, 'adopted external server is not owned');
  assert.equal(entry.conflict, false, 'adopted server is not a conflict');
});

test('C: external listener with mismatching cwd is a conflict, never proxied', async (t) => {
  const fake = fakeDevServer('hello-from-fake');
  const fakePort = await listen(fake.srv);
  writeRegistry(fakePort, '/some/project/dir');
  loadConfig('test-C');

  // Fake resolvers: the listener's cwd differs from project.dir -> conflict.
  __setResolvePidCwd(() => '/totally/different/dir');
  __setResolveListenerPid(() => 2222);

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(() => {
    daemon.close();
    fake.srv.close();
  });

  const res = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(res.status, 502, `conflict should surface as 502, got ${res.status}`);
  assert.notEqual(res.body, 'hello-from-fake', 'must NOT return the foreign server body');
  assert.equal(fake.count, 0, 'the foreign server must NEVER be proxied to');

  const entry = await statusFor(daemonPort, 'proj');
  assert.equal(entry.state, 'conflict', 'state is conflict');
  assert.equal(entry.owned, false, 'conflict is not owned');
  assert.equal(entry.conflict, true, 'conflict convenience flag is set');
  assert.equal(entry.conflictDir, '/totally/different/dir', 'conflictDir records the foreign cwd');

  // The `up` control endpoint reports the conflict reason. It mutates state, so
  // issue-5 requires the capability token — send it so we reach the handler.
  const up = await httpPost(daemonPort, 'lazydev.localhost', '/__lazydev/up/proj', ensureControlToken());
  const upBody = JSON.parse(up.body);
  assert.equal(upBody.ok, false, 'up should fail on conflict');
  assert.equal(upBody.reason, 'PORT_CONFLICT', 'up reports PORT_CONFLICT');

  // Still zero requests to the foreign server after the up attempt.
  assert.equal(fake.count, 0, 'up attempt must not proxy to the foreign server either');
});

test('E: adopted upstream that dies is healed, and re-adopted when it returns', async (t) => {
  // The adopt-then-die wedge: an ADOPTED server (owned=false, no child) has no
  // exit handler, so when it dies the record stays 'running' and — pre-fix —
  // every request 502'd until a daemon restart. The fix flips the record on a
  // connection-level proxy failure and kicks a fresh bring-up, so the next
  // attempt re-probes the port and re-adopts whatever answers.
  const fake = fakeDevServer('hello-before');
  const fakePort = await listen(fake.srv);
  writeRegistry(fakePort, PROJECT_DIR);
  loadConfig('test-E');
  __setResolvePidCwd(() => PROJECT_DIR);
  __setResolveListenerPid(() => 1111); // same pid throughout: this is a restart, not a stranger

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  let fake2;
  t.after(() => {
    daemon.close();
    try { fake.srv.close(); } catch { /* already closed mid-test */ }
    if (fake2) fake2.srv.close();
  });

  const res1 = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(res1.status, 200, 'sanity: the external server is adopted and proxied');
  assert.equal(res1.body, 'hello-before');

  // The adopted server dies, keep-alive sockets and all.
  await new Promise((resolve) => {
    fake.srv.close(resolve);
    fake.srv.closeAllConnections();
  });

  // Pre-fix this request was the start of the forever-502. Post-fix the daemon
  // notices the stale 'running', answers like a cold start (plain 503 for a
  // non-HTML client), and re-arms bring-up behind it.
  const res2 = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(res2.status, 503, `dead adopted upstream should heal to a cold 503, got ${res2.status}`);

  // The server comes back on the same port from the same dir — the user
  // restarted the dev server they had started by hand. Poll briefly: the
  // heal's own background bring-up may still be settling.
  fake2 = fakeDevServer('hello-again');
  await new Promise((resolve, reject) => {
    fake2.srv.once('error', reject);
    fake2.srv.listen(fakePort, '127.0.0.1', resolve);
  });
  // Poll with ?retry=1, which is what the wake page's Retry link sends. The
  // heal's own bring-up probed the port in the gap before fake2 was listening,
  // so it spawned this project's startCmd ('true') instead, which exits at once.
  // Whether that respawn or the returned listener wins is a coin-flip, and a
  // respawn that loses leaves a terminal failure the cold path deliberately does
  // NOT re-kick on a plain reload (spec 4). An explicit retry re-arms it, and
  // then the probe finds fake2 and re-adopts. This is what makes E stop flaking.
  let res3;
  for (let i = 0; i < 20; i++) {
    res3 = await httpGet(daemonPort, 'proj.localhost', '/?retry=1');
    if (res3.status === 200) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(res3.status, 200, `upstream returned; expected re-adopt + 200, got ${res3.status}`);
  assert.equal(res3.body, 'hello-again', 'the proxied body comes from the returned server');

  const entry = await statusFor(daemonPort, 'proj');
  // Whether recovery landed as a re-adopt or as the respawn racing the
  // returned listener is a timing coin-flip; the guarantee is 'running', not
  // how it got there. (And if the record is stale-owned, the NEXT connection
  // failure trips the same heal — ownedAlive checks the child's exitCode.)
  assert.equal(entry.state, 'running', 'healed record is running again');
});

test('F: a stranger that takes the port after adoption gets a conflict, not a proxy', async (t) => {
  // The spec-5 hole, end to end. lazydev adopts a dev server you started by hand
  // from the project folder. That server dies. Something else — a python
  // one-liner in /tmp, a rebased container, anything — binds the same port.
  // Pre-fix the record still said "running (external)" and the daemon happily
  // piped your browser to the stranger, because the cwd check ran once, at
  // adoption. Post-fix the adopted pid is re-resolved before the proxy, and a
  // pid that changed drops the record into a normal bring-up, which does the cwd
  // check again and lands here on a conflict.
  const mine = fakeDevServer('hello-from-mine');
  const port = await listen(mine.srv);
  writeRegistry(port, PROJECT_DIR);
  loadConfig('test-F');

  // Adoption: cwd matches, and pid 1111 is the process we vetted.
  __setResolvePidCwd(() => PROJECT_DIR);
  __setResolveListenerPid(() => 1111);

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  let stranger;
  t.after(async () => {
    daemon.close();
    try { mine.srv.close(); } catch { /* already closed mid-test */ }
    if (stranger) await new Promise((r) => stranger.srv.close(r));
  });

  const res1 = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(res1.status, 200, 'sanity: my own server is adopted and proxied');
  assert.equal(res1.body, 'hello-from-mine');

  // My server dies, keep-alive sockets and all.
  await new Promise((resolve) => {
    mine.srv.close(resolve);
    mine.srv.closeAllConnections();
  });

  // A foreign process from a different cwd takes the port.
  stranger = fakeDevServer('hello-from-stranger');
  await new Promise((resolve, reject) => {
    stranger.srv.once('error', reject);
    stranger.srv.listen(port, '127.0.0.1', resolve);
  });
  __setResolvePidCwd(() => '/tmp/some-stranger');
  __setResolveListenerPid(() => 9999);

  // Age the verification stamp past the TTL instead of sleeping two seconds.
  // This is exactly the state the record is in when the next navigation arrives
  // more than ADOPT_VERIFY_TTL_MS after the last one, which is every real case.
  __setRuntimeForTest('proj', { verifiedAt: Date.now() - ADOPT_VERIFY_TTL_MS - 1 });

  const res2 = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(res2.status, 502, `a stranger on the port is a conflict 502, got ${res2.status}`);
  assert.ok(
    !res2.body.includes('hello-from-stranger'),
    'the stranger\'s body must never reach the client'
  );
  assert.equal(stranger.count, 0, 'the stranger must NEVER be proxied to');

  const entry = await statusFor(daemonPort, 'proj');
  assert.equal(entry.state, 'conflict', 'the record lands in conflict, not running');
  assert.equal(entry.owned, false);
  assert.equal(entry.conflictDir, '/tmp/some-stranger', 'conflictDir names the stranger\'s cwd');
});

test('G: the 2s cache holds — one pid lookup per window, not one per request', async (t) => {
  // The whole feature is affordable only if the verification is cached: a busy
  // project serves hundreds of requests in two seconds and must not pay an lsof
  // for each. The counter below is the proof; the cache itself is the
  // `Date.now() - r.verifiedAt < ADOPT_VERIFY_TTL_MS` early return in
  // verifyAdoptedUpstream, which sits ahead of the resolver call.
  const fake = fakeDevServer('hello-cached');
  const port = await listen(fake.srv);
  writeRegistry(port, PROJECT_DIR);
  loadConfig('test-G');

  let pidLookups = 0;
  __setResolvePidCwd(() => PROJECT_DIR);
  __setResolveListenerPid(() => {
    pidLookups += 1;
    return 1111;
  });

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(() => {
    daemon.close();
    fake.srv.close();
  });

  const first = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(first.status, 200, 'sanity: adopted and proxied');
  // Adoption itself resolved the pid once; that is the baseline the re-checks
  // compare against, and it stamps the verification clock.
  assert.equal(pidLookups, 1, 'adoption resolves the pid exactly once');

  pidLookups = 0;
  for (let i = 0; i < 8; i++) {
    const res = await httpGet(daemonPort, 'proj.localhost', '/');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'hello-cached');
  }
  assert.equal(pidLookups, 0, 'eight requests inside the window cost zero lsof calls');

  // Step over the TTL: the next request pays for one lookup, the ones behind it
  // ride the refreshed stamp.
  __setRuntimeForTest('proj', { verifiedAt: Date.now() - ADOPT_VERIFY_TTL_MS - 1 });
  const after = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(after.status, 200, 'same pid -> keep proxying');
  assert.equal(after.body, 'hello-cached');
  assert.equal(pidLookups, 1, 'an expired window costs exactly one lookup');

  await httpGet(daemonPort, 'proj.localhost', '/');
  await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(pidLookups, 1, 'the refreshed stamp opens a new window, it does not re-check');
});

test('D: unresolved cwd (lsof unavailable) degrades to legacy adopt', async (t) => {
  const fake = fakeDevServer('hello-from-fake');
  const fakePort = await listen(fake.srv);
  writeRegistry(fakePort, '/some/project/dir');
  loadConfig('test-D');

  // Fake resolvers return null: nothing is knowable about the listener -> legacy
  // adopt, still proxies. With no pid there is nothing to re-verify against, so
  // the record is trusted as-is rather than being dropped every two seconds.
  __setResolvePidCwd(() => null);
  __setResolveListenerPid(() => null);

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(() => {
    daemon.close();
    fake.srv.close();
  });

  const res = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(res.status, 200, `fallback adopt should proxy (200), got ${res.status}`);
  assert.equal(res.body, 'hello-from-fake', 'fallback adopt proxies the server body');
  assert.ok(fake.count >= 1, 'fallback adopt reaches the server');

  const entry = await statusFor(daemonPort, 'proj');
  assert.equal(entry.state, 'running', 'fallback adopt is running');
  assert.equal(entry.owned, false, 'fallback adopt is external (not owned)');
  assert.equal(entry.conflict, false, 'fallback adopt is not a conflict');
});
