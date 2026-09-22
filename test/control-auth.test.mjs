// Control-plane authorization tests: capability token + same-origin check.
//
// Proves that every mutating control POST is refused without the token or with a
// foreign Origin, succeeds with the token on a clean origin, that GET /status
// stays readable (so the CLI keeps working), that error pages redact the raw
// failure reason for unauthorized callers while the log tail is served by the
// host-scoped GET /__xerb/tail, and that the token file is owner-only (0600).
//
// ISOLATION: the env vars below MUST be set BEFORE xerb.mjs is imported,
// because the module evaluates CONTROL_TOKEN_PATH / CONFIG_PATH at import time.
// ESM hoists static `import` above all other code, so we assign the envs first
// and then load the module with a dynamic `await import()`. That points the
// registry AND the token file at throwaway temp files, leaving the real repo's
// projects.json / control-token / logs untouched. Pure node:test + node:assert.

import './isolate-logs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reserve an OS-assigned TCP port, then release it, so the fake project points at
// a port nothing is listening on — probePort always misses and ensureUp always
// spawns then times out. (Tiny TOCTOU window, but far safer than a hardcoded
// port that might collide with a real listener and make ensureUp adopt it.)
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

// --- temp state dir, wired up before the module loads --------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-auth-'));
const CONFIG_FILE = path.join(tmpDir, 'projects.json');
const TOKEN_FILE = path.join(tmpDir, 'control-token');

// A project dir with an (empty) node_modules so ensureUp skips the install step
// and goes straight to spawn + start-timeout on the error-page test.
const PROJECT_DIR = path.join(tmpDir, 'fakeapp');
fs.mkdirSync(path.join(PROJECT_DIR, 'node_modules'), { recursive: true });

// Registry with one project whose startCmd opens no port, plus a short
// startTimeoutMs so the timeout path resolves fast and deterministically.
const FAKE_PROJECT_PORT = await freePort();
fs.writeFileSync(
  CONFIG_FILE,
  JSON.stringify({
    port: 0,
    startTimeoutMs: 300,
    projects: [
      { host: 'fake', dir: PROJECT_DIR, port: FAKE_PROJECT_PORT, startCmd: 'sleep 5', enabled: true },
    ],
  })
);

process.env.XERB_CONFIG = CONFIG_FILE;
process.env.XERB_CONTROL_TOKEN_PATH = TOKEN_FILE;

const {
  createDaemonServer,
  loadConfig,
  ensureControlToken,
  isSameOrigin,
  isControlAuthorized,
  CONTROL_TOKEN_PATH,
} = await import('../xerb.mjs');

// Load the temp registry so the project + short startTimeoutMs are live.
loadConfig('test');

// --- helpers -------------------------------------------------------------------

// Listen on 127.0.0.1:0 and resolve the OS-assigned port.
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

// HTTP request over a fresh loopback connection; resolve { status, body }.
function httpReq(port, { method = 'GET', pathname = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// --- tests ---------------------------------------------------------------------

test('isSameOrigin: missing/matching origin ok, foreign/malformed refused', () => {
  // No Origin at all (CLI / curl) -> allowed.
  assert.equal(isSameOrigin({ headers: { host: 'xerb.localhost' } }), true);
  // Matching Origin host -> allowed.
  assert.equal(
    isSameOrigin({ headers: { origin: 'http://xerb.localhost', host: 'xerb.localhost' } }),
    true
  );
  // Matching Origin host including port -> allowed.
  assert.equal(
    isSameOrigin({ headers: { origin: 'http://127.0.0.1:4000', host: '127.0.0.1:4000' } }),
    true
  );
  // Foreign Origin -> refused.
  assert.equal(
    isSameOrigin({ headers: { origin: 'http://evil.com', host: 'xerb.localhost' } }),
    false
  );
  // Malformed Origin -> refused.
  assert.equal(
    isSameOrigin({ headers: { origin: 'not a url', host: 'xerb.localhost' } }),
    false
  );
});

test('POST /__xerb/reload without token is refused', async (t) => {
  const server = createDaemonServer();
  t.after(() => server.close());
  const port = await listen(server);

  const res = await httpReq(port, {
    method: 'POST',
    pathname: '/__xerb/reload',
    headers: { host: 'xerb.localhost' },
  });
  assert.equal(res.status, 403, `no-token POST should be 403 (got ${res.status})`);
  assert.match(res.body, /"ok":false/);
});

test('POST with correct token but foreign Origin is refused', async (t) => {
  const server = createDaemonServer();
  t.after(() => server.close());
  const port = await listen(server);

  const token = ensureControlToken();
  const res = await httpReq(port, {
    method: 'POST',
    pathname: '/__xerb/reload',
    headers: {
      host: 'xerb.localhost',
      'x-xerb-token': token,
      origin: 'http://evil.example',
    },
  });
  assert.equal(res.status, 403, `foreign-Origin POST should be 403 even with token (got ${res.status})`);
});

test('POST with token + clean origin succeeds', async (t) => {
  const server = createDaemonServer();
  t.after(() => server.close());
  const port = await listen(server);

  const token = ensureControlToken();
  const res = await httpReq(port, {
    method: 'POST',
    pathname: '/__xerb/reload',
    headers: {
      host: 'xerb.localhost',
      'x-xerb-token': token,
      origin: 'http://xerb.localhost',
    },
  });
  assert.equal(res.status, 200, `token + clean origin should be 200 (got ${res.status})`);
  assert.match(res.body, /"ok":true/);
});

test('GET /__xerb/status stays readable without a token', async (t) => {
  const server = createDaemonServer();
  t.after(() => server.close());
  const port = await listen(server);

  const res = await httpReq(port, {
    method: 'GET',
    pathname: '/__xerb/status',
    headers: { host: 'xerb.localhost' },
  });
  assert.equal(res.status, 200, `status GET should be 200 (got ${res.status})`);
  const parsed = JSON.parse(res.body);
  assert.ok(Array.isArray(parsed.projects), 'status payload has a projects array');
  assert.equal(typeof parsed.uptimeMs, 'number', 'status payload has uptimeMs');
});

test('start-error page redacts the failure reason for unauthorized callers, shows it for authorized', async (t) => {
  const server = createDaemonServer();
  t.after(() => server.close());
  const port = await listen(server);

  // The dev server ('sleep 5') never opens its port, so the cold-start bring-up
  // times out (startTimeoutMs=300) and records lastError. The cold-start path
  // answers navigations with a 200 self-refreshing status page (not the old
  // blocking 502) — once the start has failed, that page renders the failure
  // reason + log tail, but only for an AUTHORIZED caller. A `sec-fetch-mode:
  // navigate` header makes wantsHtml() serve the HTML page instead of a bare 503.
  const navHit = (headers) =>
    httpReq(port, {
      method: 'GET',
      pathname: '/',
      headers: { host: 'fake.localhost', 'sec-fetch-mode': 'navigate', accept: 'text/html', ...headers },
    });

  // First nav hit kicks bring-up; poll (re-kicking as needed) until a hit renders
  // the terminal FAILURE page (identified by "failed to start"), meaning the
  // background start has timed out and recorded lastError.
  let unauth;
  for (let i = 0; i < 40; i++) {
    unauth = await navHit();
    if (/failed to start/i.test(unauth.body)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(unauth.status, 200, `failed start renders the 200 status page (got ${unauth.status})`);
  assert.match(unauth.body, /failed to start/i, 'failure page reached (start timed out)');
  // The raw failure reason (which can leak paths) stays behind the token; the
  // log tail is no longer inlined for anyone — the page fetches it from the
  // host-scoped GET /__xerb/tail instead.
  assert.match(unauth.body, /The dev server failed to start\./, 'unauthorized page shows the generic reason only');
  assert.match(unauth.body, /__xerb\/tail/, 'the page fetches the tail from the host-scoped endpoint');

  // Authorized caller (valid token): same nav, but the raw reason is included.
  // Poll the same way so we land on the failure page even if a fresh re-kick
  // was in flight.
  const token = ensureControlToken();
  let auth;
  for (let i = 0; i < 40; i++) {
    auth = await navHit({ 'x-xerb-token': token });
    if (/failed to start/i.test(auth.body)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(auth.status, 200, `failed start renders the 200 status page (got ${auth.status})`);
  assert.doesNotMatch(auth.body, /The dev server failed to start\./, 'authorized page shows the raw reason, not the generic one');
});

test('GET /__xerb/tail is host-scoped and same-origin: project host ok, dashboard host 404, foreign origin 403', async (t) => {
  const server = createDaemonServer();
  t.after(() => server.close());
  const port = await listen(server);

  const onProj = await httpReq(port, { pathname: '/__xerb/tail', headers: { host: 'fake.localhost' } });
  assert.equal(onProj.status, 200, 'the project origin may read its own tail');
  const j = JSON.parse(onProj.body);
  assert.equal(j.ok, true);
  assert.equal(typeof j.tail, 'string', 'tail is the log text');
  assert.equal(typeof j.state, 'string', 'state rides along for the wake page poll');

  const onDash = await httpReq(port, { pathname: '/__xerb/tail', headers: { host: 'xerb.localhost' } });
  assert.equal(onDash.status, 404, 'the dashboard host names no project to tail');

  const crossOrigin = await httpReq(port, {
    pathname: '/__xerb/tail',
    headers: { host: 'fake.localhost', origin: 'http://evil.example' },
  });
  assert.equal(crossOrigin.status, 403, 'a foreign Origin is refused');
});

// /__xerb/* is routed to the control plane whatever Host it arrives on, so a
// page any registered dev server renders can fetch the status JSON same-origin.
// What that page may read is therefore the same question the failure page
// already answers: the start command, the raw failure message and a raw line of
// another project's log stay behind the token.
test('GET /__xerb/status redacts start commands and failure detail for a tokenless caller', async (t) => {
  const server = createDaemonServer();
  t.after(() => server.close());
  const port = await listen(server);

  // Reach the failure, so there is a lastError with a message to leak.
  for (let i = 0; i < 40; i++) {
    const hit = await httpReq(port, {
      pathname: '/',
      headers: { host: 'fake.localhost', 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    });
    if (/failed to start/i.test(hit.body)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  // A page served by a dev server, reading the control plane on its own origin.
  const open = await httpReq(port, {
    pathname: '/__xerb/status',
    headers: { host: 'fake.localhost', origin: 'http://fake.localhost' },
  });
  assert.equal(open.status, 200, 'status stays readable, as the CLI needs');
  const row = JSON.parse(open.body).projects.find((p) => p.host === 'fake');
  assert.ok(row, 'the row is still there');
  assert.equal(row.state, 'stopped', 'the state a row needs to paint itself is not a secret');
  assert.equal(row.lastError.kind, 'timeout', 'nor is the failure kind');
  assert.equal(row.startCmd, '', 'the start command is not served to a tokenless caller');
  assert.equal(row.lastError.message, null, 'nor the raw failure message');
  assert.equal(row.lastError.errorLine, null, 'nor a raw line of the log');

  // The dashboard and the CLI hold the token, and they get all of it.
  const authed = await httpReq(port, {
    pathname: '/__xerb/status',
    headers: { host: 'xerb.localhost', 'x-xerb-token': ensureControlToken() },
  });
  const full = JSON.parse(authed.body).projects.find((p) => p.host === 'fake');
  assert.equal(full.startCmd, 'sleep 5', 'the edit panel still prefills');
  assert.equal(full.lastError.message, 'startTimeout', 'and the raw reason is there');
});

test('control-token file is created readable only by the owner (0600)', () => {
  ensureControlToken();
  assert.equal(CONTROL_TOKEN_PATH, TOKEN_FILE, 'token path derives from XERB_CONTROL_TOKEN_PATH');
  if (process.platform === 'win32') {
    // Mode bits aren't meaningful on Windows; skip gracefully.
    return;
  }
  const st = fs.statSync(CONTROL_TOKEN_PATH);
  assert.equal(st.mode & 0o777, 0o600, `token file mode should be 0600 (got ${(st.mode & 0o777).toString(8)})`);
});
