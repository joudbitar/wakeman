// Failure-kind tests: spec 0.3.0 section 4, "Failures you can see".
//
// Before this, every failure rendered one sentence, "did not open
// 127.0.0.1:3010 within 30s", whether the child died in 100 ms, the folder had
// been moved, or `npm install` 404'd. These tests pin the five kinds
// (exited, timeout, dir-missing, install-failed, conflict), the copy each one
// gets with its numbers interpolated, the lastError the dashboard reads from
// /__xerb/status, the separator line every start writes to <host>.log, and
// the tail endpoint that slices from it.
//
// ISOLATION: XERB_CONFIG / XERB_LOGS_DIR are read at module load, so they
// are assigned BEFORE the dynamic import of ../xerb.mjs (static imports are
// hoisted; a dynamic one is not). Everything lands in a throwaway temp dir:
// no real state dir, no LaunchAgent, no `xerb` binary. Pure node:test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- temp state, wired up before the module loads ---------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-failures-'));
const CONFIG_FILE = path.join(tmpDir, 'projects.json');
const LOGS = path.join(tmpDir, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

// A project dir with an (empty) node_modules so ensureUp skips the install step
// for every project that points at it. The install-failed test gets its own
// dir without one.
const PROJECT_DIR = path.join(tmpDir, 'app');
fs.mkdirSync(path.join(PROJECT_DIR, 'node_modules'), { recursive: true });

fs.writeFileSync(CONFIG_FILE, JSON.stringify({ port: 0, projects: [] }));
process.env.XERB_CONFIG = CONFIG_FILE;
process.env.XERB_LOGS_DIR = LOGS;

const {
  createDaemonServer,
  loadConfig,
  getRuntime,
  stop,
  upstreamAgent,
  failureCopy,
  tailLog,
  firstErrorLine,
  ensureControlToken,
} = await import('../xerb.mjs');

// --- helpers ----------------------------------------------------------------

// Reserve an OS-assigned port and release it: the project then points at a port
// nothing listens on, so probePort always misses and ensureUp always spawns.
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
    const started = Date.now();
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: reqPath, headers: { host: hostHeader, ...headers } },
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

// A browser navigation: what gets the HTML page instead of the plain 503.
const NAV = { accept: 'text/html', 'sec-fetch-mode': 'navigate' };

// The dashboard and `xerb status` both read this with the control token, and
// the payload's failure detail (the raw message, the log line) is only served to
// a caller that has it — so the helper carries it, like its real callers do.
async function statusFor(daemonPort, host) {
  const res = await httpGet(daemonPort, 'xerb.localhost', '/__xerb/status', { 'x-xerb-token': ensureControlToken() });
  assert.equal(res.status, 200, 'status endpoint answers');
  return JSON.parse(res.body).projects.find((p) => p.host === host);
}

async function waitFor(pred, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function failedRecord(host) {
  return () => {
    const r = getRuntime(host);
    return r.state === 'stopped' && !!r.lastError && !r.startPromise;
  };
}

function writeRegistry(project, extra = {}) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ port: 0, startTimeoutMs: 1200, installTimeoutMs: 4000, ...extra, projects: [project] }));
  loadConfig('test');
}

// Drain any in-flight background bring-up so its timers cannot outlive the test
// and run under the NEXT test's config (handleRequest kicks ensureUp without
// awaiting it, which is the whole point of the cold path).
async function drain(host) {
  stop(host);
  const r = getRuntime(host);
  if (r.startPromise) await r.startPromise.catch(() => {});
}

function closeServer(server) {
  try { server.closeAllConnections?.(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
}

// Bring one project to its terminal failure and hand back the failure page, the
// status entry, and the runtime record. Every kind test goes through here, so
// they differ only in the registry entry and the assertions.
async function failAndRead(t, project, extra = {}) {
  writeRegistry(project, extra);
  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(async () => {
    closeServer(daemon);
    await drain(project.host);
    upstreamAgent.destroy();
  });

  const first = await httpGet(daemonPort, `${project.host}.localhost`, '/', NAV);
  assert.equal(first.status, 200, 'the first navigation gets a page, not a hang');

  const settled = await waitFor(failedRecord(project.host), 8000);
  assert.ok(settled, 'the bring-up reached a terminal failure');

  const page = await httpGet(daemonPort, `${project.host}.localhost`, '/', NAV);
  const entry = await statusFor(daemonPort, project.host);
  return { daemonPort, page, entry, r: getRuntime(project.host), firstMs: first.ms };
}

// --- kind: exited -----------------------------------------------------------

test('exited: the page quotes the exit code and how long the child lived', async (t) => {
  const port = await freePort();
  const { page, entry } = await failAndRead(t, {
    host: 'diesfast',
    dir: PROJECT_DIR,
    port,
    startCmd: "sh -c 'echo \"Error: boom from the child\" >&2; exit 7'",
    enabled: true,
  });

  assert.match(page.body, /diesfast failed to start/, 'the page names the project');
  assert.match(
    page.body,
    /The dev server exited with code 7 after \d+\.\ds\./,
    'exited copy carries the exit code and the seconds it lived'
  );
  assert.doesNotMatch(page.body, /did not open/, 'the old one-size timeout sentence is gone');

  assert.equal(entry.lastError.kind, 'exited', 'status carries the kind for the badge tooltip');
  assert.equal(entry.state, 'stopped');
  assert.match(entry.lastError.errorLine, /Error: boom from the child/, 'status carries the first error line of the tail');
});

// --- kind: timeout ----------------------------------------------------------

test('timeout: the page quotes the port and the timeout it rode out', async (t) => {
  const port = await freePort();
  const { page, entry } = await failAndRead(t, {
    host: 'neverbinds',
    dir: PROJECT_DIR,
    port,
    startCmd: "sh -c 'sleep 20'",
    enabled: true,
  });

  assert.match(
    page.body,
    new RegExp(`Nothing answered on port ${port} within 1s\\. The process is still being killed\\.`),
    'timeout copy carries the port and the configured timeout'
  );
  assert.equal(entry.lastError.kind, 'timeout');
});

// --- kind: dir-missing ------------------------------------------------------

test('dir-missing: a moved folder fails instantly and the copy carries both fixes', async (t) => {
  const port = await freePort();
  const gone = path.join(tmpDir, 'moved-away');
  assert.equal(fs.existsSync(gone), false, 'the folder really is not there');

  // A log from the last time this project DID start, so the stale-tail read the
  // assertion below rules out has something to find.
  fs.writeFileSync(
    path.join(LOGS, 'moved.log'),
    '\u2500\u2500 2026-09-12 17:31:17 \u00b7 start: npm run dev (PORT=1) \u2500\u2500\n> app@0.1.0 dev\nready in 300 ms\n'
  );

  // A 30s start timeout: pre-fix this project sat in 'starting' for the whole
  // of it, because spawn() with a missing cwd fails asynchronously on 'error'
  // and never fires 'exit'. The statSync check must beat it by two orders.
  const { page, entry, firstMs } = await failAndRead(
    t,
    { host: 'moved', dir: gone, port, startCmd: 'npm run dev', enabled: true },
    { startTimeoutMs: 30_000 }
  );

  assert.ok(firstMs < 3000, `failed without riding out the start timeout (took ${firstMs}ms)`);
  assert.match(
    page.body,
    new RegExp(`The folder <code>${gone}</code> is gone\\. Move it back, or <code>xerb remove moved</code> / <code>xerb add /new/path --name moved</code>\\.`),
    'dir-missing copy names the folder and both commands'
  );
  assert.doesNotMatch(page.body, /id="term"/, 'no log box: this attempt never spawned anything');
  assert.equal(entry.lastError.kind, 'dir-missing');
  // Same reason the page shows no log box: this attempt wrote no separator and
  // no output, so a tail read here returns the PREVIOUS run's lines — and
  // firstErrorLine falls back to the last one, which is how a failed row ended
  // up captioned with "ready in 300 ms" from a start that worked.
  assert.equal(entry.lastError.errorLine, null, 'no error line: this attempt wrote nothing to the log');
});

// --- kind: install-failed ---------------------------------------------------

test('install-failed: the page quotes the install command and its code, and a reload does not reinstall', async (t) => {
  const port = await freePort();
  // A project with a dependency to fetch and NO node_modules, so ensureUp
  // installs. (With nothing to install there is no install to fail.)
  const dir = path.join(tmpDir, 'needsdeps');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'needsdeps', scripts: { dev: 'true' }, dependencies: { 'left-pad': '1.3.0' } }));

  // A fake `npm` earlier on PATH than the real one: it fails the way a 404 or a
  // dead network does (no node_modules left behind) and records every call, so
  // the test can count installs instead of guessing.
  const bin = path.join(tmpDir, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(tmpDir, 'npm-calls');
  fs.writeFileSync(
    path.join(bin, 'npm'),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\necho "npm ERR! code E404"\necho "npm ERR! 404 Not Found - GET http://127.0.0.1:1/nope"\nexit 1\n`
  );
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${bin}:${realPath}`;
  t.after(() => { process.env.PATH = realPath; });

  const countCalls = () =>
    (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);

  const { daemonPort, page, entry } = await failAndRead(t, {
    host: 'needsdeps',
    dir,
    port,
    startCmd: 'npm run dev',
    enabled: true,
  });

  assert.match(page.body, /<code>npm install<\/code> exited with code 1\./, 'install-failed copy quotes the command and the code');
  assert.equal(entry.lastError.kind, 'install-failed');
  assert.match(entry.lastError.errorLine, /npm ERR! code E404/, 'the dashboard line is the first error line of the install log');
  assert.equal(countCalls(), 1, 'exactly one install ran');
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false, 'the failed install left no node_modules');

  // The whole point of the memo: node_modules is STILL missing, so the old code
  // reinstalled on every hit and paid installTimeoutMs again each time.
  const reload = await httpGet(daemonPort, 'needsdeps.localhost', '/', NAV);
  await new Promise((r) => setTimeout(r, 300));
  assert.match(reload.body, /<code>npm install<\/code> exited with code 1\./, 'the reload re-reports the same failure');
  assert.equal(countCalls(), 1, 'the reload did NOT re-run the install');

  // An explicit Retry is the deliberate act that re-arms it.
  await httpGet(daemonPort, 'needsdeps.localhost', '/?retry=1', NAV);
  const reinstalled = await waitFor(() => countCalls() === 2, 8000);
  assert.ok(reinstalled, 'Retry re-runs the install');
});

// --- kind: conflict ---------------------------------------------------------

test('conflict: the kind is recorded with the port it names', () => {
  // The conflict PAGE is sendConflict's, not the failure page's (a conflict is
  // a 502 with a free-port button, never a retry invitation). What section 4
  // adds is the kind on the record, so the copy table and the status JSON cover
  // all five. Asserted against failureCopy directly, the same call the page makes.
  const project = { host: 'squatted', dir: '/x', port: 3020 };
  const copy = failureCopy(project, { kind: 'conflict', port: 3020, conflictDir: '/tmp/other' });
  assert.match(copy, /Port 3020 is held by another process/);
  assert.doesNotMatch(copy, /\/tmp\/other/, 'the foreign cwd stays on the conflict page, which gates it');
});

// --- the copy table, kind by kind ------------------------------------------

test('failureCopy renders one sentence per kind, numbers included', () => {
  const project = { host: 'app', dir: '/Users/x/code/app', port: 3010 };

  assert.equal(
    failureCopy(project, { kind: 'exited', exitCode: 1, elapsedMs: 100 }),
    'The dev server exited with code 1 after 0.1s.'
  );
  assert.equal(
    failureCopy(project, { kind: 'timeout', port: 3020, timeoutMs: 120_000 }),
    'Nothing answered on port 3020 within 120s. The process is still being killed.'
  );
  assert.equal(
    failureCopy(project, { kind: 'dir-missing', dir: '/Users/x/code/app' }),
    'The folder <code>/Users/x/code/app</code> is gone. Move it back, or <code>xerb remove app</code> / <code>xerb add /new/path --name app</code>.'
  );
  assert.equal(
    failureCopy(project, { kind: 'install-failed', installCmd: 'npm install', exitCode: 1 }),
    '<code>npm install</code> exited with code 1.'
  );
  // A signal-killed child has no exit code to quote, and a record with no kind
  // at all (one written before 0.3.0) still gets a sentence.
  assert.match(failureCopy(project, { kind: 'exited', signal: 'SIGKILL', elapsedMs: 2500 }), /killed by SIGKILL after 2\.5s/);
  assert.match(failureCopy(project, {}), /did not open <code>127\.0\.0\.1:3010<\/code>/);
});

// --- the log separator ------------------------------------------------------

test('every start writes the separator line to <host>.log', async (t) => {
  const port = await freePort();
  const startCmd = "sh -c 'echo first-run; exit 3'";
  const { daemonPort } = await failAndRead(t, { host: 'sepcheck', dir: PROJECT_DIR, port, startCmd, enabled: true });

  const file = path.join(LOGS, 'sepcheck.log');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const seps = lines.filter((l) => l.startsWith('── '));
  assert.equal(seps.length, 1, 'one start, one separator');
  assert.match(
    seps[0],
    new RegExp(`^── \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} · start: ${startCmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(PORT=${port}\\) ──$`),
    'exactly the format the spec words'
  );
  assert.ok(lines.indexOf(seps[0]) < lines.indexOf('first-run'), 'the separator precedes the run it introduces');

  // A second attempt gets its own separator, which is what stopped two
  // `compiling...` runs reading as one.
  await httpGet(daemonPort, 'sepcheck.localhost', '/?retry=1', NAV);
  await waitFor(() => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('── ')).length === 2, 8000);
  const after = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(after.filter((l) => l.startsWith('── ')).length, 2, 'the retry wrote its own separator');
  assert.equal(after.filter((l) => l === 'first-run').length, 2, 'both runs are still in the file');
});

// --- tail since the last separator -----------------------------------------

test('the tail endpoint returns this attempt by default and everything with ?all=1', async (t) => {
  const port = await freePort();
  writeRegistry({ host: 'tailcheck', dir: PROJECT_DIR, port, startCmd: 'true', enabled: true });
  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(async () => { closeServer(daemon); await drain('tailcheck'); });

  // Hand-written so the assertion is about the slicing, not about what some
  // child happened to print.
  const file = path.join(LOGS, 'tailcheck.log');
  fs.writeFileSync(
    file,
    [
      '── 2026-09-12 17:30:01 · start: npm run dev (PORT=3030) ──',
      'compiling...',
      'older attempt line',
      '── 2026-09-12 17:31:17 · start: npm run dev (PORT=3030) ──',
      'compiling...',
      'this attempt line',
      '',
    ].join('\n')
  );

  const res = await httpGet(daemonPort, 'tailcheck.localhost', '/__xerb/tail');
  assert.equal(res.status, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.ok, true);
  assert.equal(j.all, false);
  assert.match(j.tail, /this attempt line/, 'this attempt is in the tail');
  assert.doesNotMatch(j.tail, /older attempt line/, 'the previous attempt is not');
  assert.doesNotMatch(j.tail, /──/, 'the separator itself is not echoed back');
  assert.equal(j.tail.split('\n').filter((l) => l === 'compiling...').length, 1, 'one compile, not two runs read as one');

  const all = JSON.parse((await httpGet(daemonPort, 'tailcheck.localhost', '/__xerb/tail?all=1')).body);
  assert.equal(all.all, true);
  assert.match(all.tail, /older attempt line/, '?all=1 reaches back past the separator');
  assert.equal(all.tail.split('\n').filter((l) => l === 'compiling...').length, 2);

  // The same slicing the CLI and the dashboard use directly.
  assert.doesNotMatch(tailLog('tailcheck', 40), /older attempt line/);
  assert.match(tailLog('tailcheck', 40, { all: true }), /older attempt line/);
  // A log with no separator at all (a project last started by an older daemon)
  // still tails, rather than coming back empty.
  fs.writeFileSync(file, 'no separator here\nsecond line\n');
  assert.match(tailLog('tailcheck', 40), /no separator here/);
});

// --- the dashboard's one-line summary --------------------------------------

test('firstErrorLine picks the error line, strips color, and falls back to the last line', () => {
  assert.equal(
    firstErrorLine('[32mready in 300ms[0m\n[31mError: Cannot find module \'vite\'[0m\nat foo'),
    "Error: Cannot find module 'vite'"
  );
  assert.equal(firstErrorLine('compiling...\nstill compiling...'), 'still compiling...');
  assert.equal(firstErrorLine(''), '');
  assert.equal(
    firstErrorLine('── 2026-09-12 17:31:17 · start: npm run dev (PORT=3030) ──\nplain output'),
    'plain output',
    'the separator is never mistaken for output'
  );
});

// --- a stop is not a failure ------------------------------------------------

// The dashboard switch is live during 'starting' and 'installing', and so is
// `xerb stop`. Flipping it off there used to land as kind 'exited' with
// signal SIGTERM: a red `failed` badge for something the user asked for, and
// worse, a URL that stopped waking, because handleRequest refuses to kick a
// record that is stopped-with-lastError.
test('a stop while the project is still starting is not recorded as a failure', async (t) => {
  const port = await freePort();
  writeRegistry(
    { host: 'stopmid', dir: PROJECT_DIR, port, startCmd: "sh -c 'sleep 20'", enabled: true },
    { startTimeoutMs: 30_000 }
  );
  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(async () => {
    closeServer(daemon);
    await drain('stopmid');
    upstreamAgent.destroy();
  });

  await httpGet(daemonPort, 'stopmid.localhost', '/', NAV); // kicks the bring-up
  assert.ok(await waitFor(() => getRuntime('stopmid').state === 'starting', 5000), 'reached starting');

  // Exactly what the dashboard switch and `xerb stop` post.
  assert.deepEqual(stop('stopmid', 'control'), { ok: true });
  const r = getRuntime('stopmid');
  if (r.startPromise) await r.startPromise.catch(() => {});

  assert.equal(r.lastError, null, 'a deliberate stop records no failure');
  assert.equal(r.state, 'stopped');
  assert.equal((await statusFor(daemonPort, 'stopmid')).lastError, null, 'the row reads sleeping, not failed');

  // And the URL still wakes it: a stopped-with-lastError record does not kick.
  await httpGet(daemonPort, 'stopmid.localhost', '/', NAV);
  const rekicked = await waitFor(() => !!getRuntime('stopmid').startPromise || getRuntime('stopmid').state === 'starting', 5000);
  assert.ok(rekicked, 'the next visit wakes it again instead of rendering a failure page');
});

// --- the dashboard badge ----------------------------------------------------

test('a failed project renders a red failed badge, not "sleeping"', async (t) => {
  const port = await freePort();
  const { daemonPort, entry } = await failAndRead(t, {
    host: 'badged',
    dir: PROJECT_DIR,
    port,
    startCmd: "sh -c 'echo \"Error: nope\" >&2; exit 2'",
    enabled: true,
  });
  assert.equal(entry.lastError.kind, 'exited');

  const dash = await httpGet(daemonPort, 'xerb.localhost', '/', NAV);
  assert.equal(dash.status, 200);
  const row = (dash.body.split('<tr data-host="badged">')[1] || '').split('</tr>')[0];
  assert.match(row, /<span class="badge b-failed" title="exited">failed<\/span>/, 'red failed badge with the kind as its tooltip');
  assert.doesNotMatch(row, /sleeping/, 'a dead dev server no longer reads as asleep');
  assert.match(row, /class="errline" onclick="openTerm\(this\)"/, 'the error line is the terminal panel click target');
  assert.match(row, /Error: nope/, 'and it shows the first error line of the log');
});

test('cleanup', () => {
  upstreamAgent.destroy();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
