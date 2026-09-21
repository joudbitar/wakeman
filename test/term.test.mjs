// Section 6: a terminal per dev server, the daemon half.
//
// The acceptance criteria the spec words, against a real daemon on an
// OS-assigned port with a throwaway state dir:
//
//   - a dev server whose start command is `read x; echo got $x; node server.js`
//     answers `i:hello\n` typed into the term socket with "got hello", and THEN
//     opens its port. Nothing but a real tty can pass that test: with pipes the
//     `read` gets EOF and the server never starts.
//   - restart with a panel open produces a new pid and a new separator, and the
//     socket that was already open lands on the new child.
//   - no token, a wrong token, and a valid token asked for on a project host all
//     get 401 and a closed socket (spec section 10).
//   - an open terminal counts as an active connection, so the reaper leaves the
//     project alone while someone is watching it.
//   - with no python3 the panel is read-only and says so in its first line, and
//     `status` carries the same sentence for the CLI to print.
//
// The WebSocket client is hand-rolled (same shape as test/ws.test.mjs) rather
// than Node's global one, because these tests have to set the Host header: the
// term socket is refused anywhere but the control plane, and that is half of
// what is being asserted here.
//
// XERB_CONFIG and friends are set at module load, BEFORE the dynamic import
// of ../xerb.mjs, so the daemon reads this file's throwaway state dir.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// --- fixtures ---------------------------------------------------------------

const ROOT = path.dirname(fileURLToPath(new URL('../xerb.mjs', import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-term-'));
const CONFIG_PATH = path.join(TMP, 'projects.json');
const LOGS = path.join(TMP, 'logs');

// Is there a python3 for lib/pty.py? Without one the daemon is on its pipe
// fallback and the typing tests have nothing to type into, so they are skipped
// with a reason rather than failing on a machine that cannot run them.
function findPython() {
  for (const candidate of ['python3', '/usr/bin/python3']) {
    try {
      execFileSync(candidate, ['-c', ''], { stdio: 'ignore', timeout: 10_000 });
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}
const PYTHON = findPython();
const NO_PTY = PYTHON ? false : 'no python3 on this machine: lib/pty.py cannot run';

// A dev server that binds the PORT the daemon injects and answers 200.
const SERVER_JS = `require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT,'127.0.0.1');\n`;

function projectDir(name) {
  const dir = path.join(TMP, name);
  // node_modules is what makes ensureUp skip the install step, so nothing here
  // ever shells out to a real npm.
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), SERVER_JS);
  return dir;
}

const READBACK_DIR = projectDir('readback');
const RESTARTER_DIR = projectDir('restarter');
const WATCHED_DIR = projectDir('watched');
const CHATTY_DIR = projectDir('chatty');
const NOPY_DIR = projectDir('nopy');

// The spec's own acceptance command: it will not open its port until something
// types a line into its terminal.
// `stty size` on the end of it is how the resize frame is checked: the window
// it prints is the one the LAST `r:` frame asked for, not the 24x80 default.
const READBACK_CMD = "sh -c 'read x; echo got $x; stty size; node server.js'";
const PLAIN_CMD = 'node server.js';
// 400 KB of output, then a colored line, then the port. The ring buffer holds
// the last 256 KB of that, so the color is inside the window and the first of
// the x's is not.
const CHATTY_CMD =
  `node -e "process.stdout.write('x'.repeat(400000));process.stdout.write('\\x1b[31mred\\x1b[0m\\n')" && node server.js`;

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

const READBACK_PORT = await freePort();
const RESTARTER_PORT = await freePort();
const WATCHED_PORT = await freePort();
const CHATTY_PORT = await freePort();
const NOPY_PORT = await freePort();

const IDLE_MS = 300_000;

fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify(
    {
      port: 0,
      idleTimeoutMs: IDLE_MS,
      // The readback project does not bind until it has been typed into, so the
      // start timeout has to outlast the test's own round trip.
      startTimeoutMs: 20_000,
      projects: [
        { host: 'readback', dir: READBACK_DIR, port: READBACK_PORT, startCmd: READBACK_CMD, enabled: true, framework: 'node' },
        { host: 'restarter', dir: RESTARTER_DIR, port: RESTARTER_PORT, startCmd: PLAIN_CMD, enabled: true, framework: 'node' },
        { host: 'watched', dir: WATCHED_DIR, port: WATCHED_PORT, startCmd: PLAIN_CMD, enabled: true, framework: 'node' },
        { host: 'chatty', dir: CHATTY_DIR, port: CHATTY_PORT, startCmd: CHATTY_CMD, enabled: true, framework: 'node' },
      ],
    },
    null,
    2
  ) + '\n'
);

process.env.XERB_CONFIG = CONFIG_PATH;
process.env.XERB_CONTROL_TOKEN_PATH = path.join(TMP, 'control-token');
process.env.XERB_LOGS_DIR = LOGS;

const {
  createDaemonServer,
  loadConfig,
  ensureControlToken,
  getRuntime,
  stop,
  reapIdle,
  statusPayload,
  __setLastAccessForTest,
  __liveConnInfo,
  NO_PTY_NOTE,
  termRingBytes,
  upstreamAgent,
} = await import('../xerb.mjs');

// --- a WebSocket client that lets the test choose the Host header ------------

// One masked client frame. Every frame a client sends is masked (RFC 6455 5.1).
function maskedFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  const head = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = 0x80 | len;
  else if (len < 65536) {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, masked]);
}

// Whole server frames (never masked) out of a buffer, plus the leftover tail.
function parseFrames(buf) {
  const frames = [];
  let at = 0;
  while (buf.length - at >= 2) {
    const b0 = buf[at];
    let len = buf[at + 1] & 0x7f;
    let off = at + 2;
    if (len === 126) {
      if (buf.length < off + 2) break;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) break;
      len = Number(buf.readBigUInt64BE(off));
      off += 8;
    }
    if (buf.length < off + len) break;
    frames.push({ opcode: b0 & 0x0f, payload: buf.subarray(off, off + len) });
    at = off + len;
  }
  return { frames, rest: buf.subarray(at) };
}

// Open a term socket. Resolves as soon as the response head is parsed, so a
// refusal is inspected the same way a 101 is.
async function termSocket(port, host, { token, path: pathname = '/__xerb/term/readback' } = {}) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const key = crypto.randomBytes(16).toString('base64');
  const lines = [
    `GET ${pathname} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (token) lines.push(`Sec-WebSocket-Protocol: ${token}`);
  socket.write(lines.concat(['', '']).join('\r\n'));

  let buf = Buffer.alloc(0);
  let headText = null;
  let text = ''; // everything the server has sent as frame payloads, in order
  const firstFrames = [];
  let waiter = null;
  socket.on('error', () => {});
  // Attached now, not when a test asks: a refusal closes the socket before the
  // handshake has even been parsed, and a listener added later never fires.
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (headText === null) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      headText = buf.subarray(0, end).toString('utf8');
      buf = buf.subarray(end + 4);
    }
    const parsed = parseFrames(buf);
    buf = parsed.rest;
    for (const f of parsed.frames) {
      if (f.opcode === 0x1 || f.opcode === 0x2) {
        firstFrames.push(f.payload.toString('utf8'));
        text += f.payload.toString('utf8');
      }
    }
    if (waiter && text.includes(waiter.needle)) {
      const { resolve } = waiter;
      waiter = null;
      resolve();
    }
  });
  const deadline = Date.now() + 5000;
  while (headText === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  const status = headText === null ? 0 : Number(/^HTTP\/1\.1 (\d+)/.exec(headText)?.[1] || 0);

  return {
    socket,
    status,
    head: headText,
    frames: firstFrames,
    get text() {
      return text;
    },
    send: (s) => socket.write(maskedFrame(0x1, s)),
    close: () => socket.destroy(),
    closed,
    // Resolve once `needle` has shown up in everything received so far.
    waitForText(needle, timeoutMs = 15_000) {
      if (text.includes(needle)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(new Error(`waited ${timeoutMs}ms for ${JSON.stringify(needle)}; saw ${JSON.stringify(text.slice(-400))}`));
        }, timeoutMs);
        waiter = {
          needle,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        };
      });
    },
  };
}

// --- plumbing ---------------------------------------------------------------

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function req(port, pathname, { method = 'GET', host = 'xerb.localhost', token } = {}) {
  const headers = { host, 'content-type': 'application/json' };
  if (token) headers['x-xerb-token'] = token;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json, body: text });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

async function waitFor(fn, timeoutMs = 15_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await fn();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function get(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', () => resolve(null));
    r.setTimeout(1000, () => {
      r.destroy();
      resolve(null);
    });
  });
}

const logFor = (host) => {
  try {
    return fs.readFileSync(path.join(LOGS, `${host}.log`), 'utf8');
  } catch {
    return '';
  }
};
const separators = (host) => logFor(host).split('\n').filter((l) => l.startsWith('── ')).length;

let daemon;
let daemonPort;
let token;

before(async () => {
  loadConfig('test:term');
  token = ensureControlToken();
  daemon = createDaemonServer();
  daemonPort = await listen(daemon);
});

after(() => {
  for (const host of ['readback', 'restarter', 'watched', 'chatty']) stop(host, 'test-teardown');
  daemon.close();
  upstreamAgent.destroy();
});

// --- auth (spec section 10) -------------------------------------------------

test('the term socket refuses no token, a wrong token, and the wrong host', async () => {
  const cases = [
    ['no token at all', { token: undefined, host: 'xerb.localhost' }],
    ['a wrong token', { token: 'deadbeef', host: 'xerb.localhost' }],
    // The real token, asked for on a project's own host: a page a dev server
    // serves must not be able to open anybody's terminal.
    ['the right token on a project host', { token: () => token, host: 'readback.localhost' }],
  ];
  for (const [label, opts] of cases) {
    const ws = await termSocket(daemonPort, opts.host, {
      token: typeof opts.token === 'function' ? opts.token() : opts.token,
    });
    assert.equal(ws.status, 401, `${label} must be 401`);
    // 401 and a CLOSED socket, not a hung one.
    await ws.closed;
    assert.equal(ws.socket.destroyed, true, `${label} must leave the socket closed`);
  }

  // A valid token for a host that is not registered is a 404, not a terminal.
  const unknown = await termSocket(daemonPort, 'xerb.localhost', { token, path: '/__xerb/term/ghost' });
  assert.equal(unknown.status, 404);
  await unknown.closed;
});

// --- the acceptance test the spec words -------------------------------------

test('typing into the term socket reaches the dev server, and then its port comes up', { skip: NO_PTY }, async (t) => {
  const ws = await termSocket(daemonPort, 'xerb.localhost', { token });
  t.after(() => {
    ws.close();
    stop('readback', 'test');
  });
  assert.equal(ws.status, 101, ws.head);
  // The handshake echoes back exactly the protocol value we offered, which is
  // how a browser carries the token.
  assert.match(ws.head, new RegExp(`Sec-WebSocket-Protocol: ${token}`));

  // Opening the panel is the wake request: nothing else has touched this
  // project, and `read x` means it cannot finish starting on its own.
  const r = await waitFor(() => {
    const rt = getRuntime('readback');
    return rt.pty && rt.pty.stdin ? rt : null;
  }, 10_000, 'the pty to come up');
  assert.ok(r.pid, 'the daemon owns a pid');

  // Resize first, then type: `stty size` in the command then reports the window
  // the panel asked for instead of the 24x80 the child was born at. The pause
  // stands in for a person, who resizes a panel and types some time later: a
  // resize this soon after a spawn is re-sent once the child has settled
  // (PTY_SIZE_SETTLE_MS), and the input has to come after that, not before.
  ws.send('r:40,100');
  await new Promise((r) => setTimeout(r, 600));
  ws.send('i:hello\n');
  await ws.waitForText('got hello');
  await ws.waitForText('40 100', 5000);

  // ... and only now does the port open, because the dev server was blocked on
  // that line the whole time.
  const res = await waitFor(async () => {
    const hit = await get(READBACK_PORT);
    return hit && hit.status === 200 ? hit : null;
  }, 15_000, 'the dev server to bind its port');
  assert.equal(res.body, 'ok');
  await waitFor(() => getRuntime('readback').state === 'running', 5000, 'state running');

  // <host>.log keeps the plain-text copy: same output, escapes stripped, CRLF
  // from the tty folded back to newlines, so `xerb logs` and grep still work.
  const text = logFor('readback');
  assert.ok(text.split('\n').includes('got hello'), `log should hold a clean line: ${JSON.stringify(text)}`);
  assert.doesNotMatch(text, /\r/, 'no carriage returns survive into the log');
  assert.doesNotMatch(text, /\u001b/, 'no escape sequences survive into the log');

  // A second panel opens on the scrollback: the first frame is the ring buffer.
  const second = await termSocket(daemonPort, 'xerb.localhost', { token });
  t.after(() => second.close());
  assert.equal(second.status, 101);
  await second.waitForText('got hello', 5000);
  assert.ok(second.frames[0].includes('got hello'), 'the FIRST frame is the replay, not a later one');
});

// --- the reaper ------------------------------------------------------------

test('an open terminal counts as an active connection, so the project does not sleep', { skip: NO_PTY }, async (t) => {
  // Its own project: this one is about the reaper, and a project another test
  // has already started and stopped could be re-ADOPTED here (owned=false),
  // which the reaper skips for a reason that has nothing to do with terminals.
  const ws = await termSocket(daemonPort, 'xerb.localhost', { token, path: '/__xerb/term/watched' });
  t.after(() => {
    ws.close();
    stop('watched', 'test');
  });
  await waitFor(() => getRuntime('watched').state === 'running', 20_000, 'state running');
  assert.equal(getRuntime('watched').owned, true, 'the daemon owns this one');

  assert.ok(__liveConnInfo('watched').active >= 1, 'the open socket is one live connection');
  // Idle past the timeout with the panel open: the reaper leaves it alone.
  __setLastAccessForTest('watched', Date.now() - IDLE_MS * 3);
  reapIdle();
  assert.equal(getRuntime('watched').state, 'running', 'a watched project does not sleep');

  // Close the panel and the same reap sleeps it, which is what proves the
  // connection was the thing holding it up.
  ws.close();
  await waitFor(() => __liveConnInfo('watched').count === 0, 5000, 'the record to go');
  __setLastAccessForTest('watched', Date.now() - IDLE_MS * 3);
  reapIdle();
  assert.equal(getRuntime('watched').state, 'stopped', 'with nothing watching, it sleeps');
});

// --- the ring buffer --------------------------------------------------------

test('the ring keeps 256 KB of raw output while the log keeps the plain copy', { skip: NO_PTY }, async (t) => {
  const ws = await termSocket(daemonPort, 'xerb.localhost', { token, path: '/__xerb/term/chatty' });
  t.after(() => {
    ws.close();
    stop('chatty', 'test');
  });
  await waitFor(() => getRuntime('chatty').state === 'running', 20_000, 'the chatty server');

  const ring = await waitFor(() => {
    const buf = termRingBytes('chatty');
    return buf.includes('red') ? buf : null;
  }, 10_000, 'the colored line to reach the ring');
  assert.equal(ring.length, 256 * 1024, 'the ring is capped at exactly 256 KB');
  // Raw: the color the dev server asked for is still in there, byte for byte.
  assert.ok(ring.toString('utf8').includes('\u001b[31mred\u001b[0m'), 'ANSI survives in the ring');

  // The log is the same output with the escapes taken out, which is what makes
  // `xerb logs` and grep usable.
  const text = logFor('chatty');
  assert.match(text, /red/);
  assert.doesNotMatch(text, /\u001b/, 'no escapes in the log');
  assert.doesNotMatch(text, /\r/, 'no carriage returns in the log');
});

// --- restart with a panel open ----------------------------------------------

test('restart from an open panel gives a new pid and a new separator', { skip: NO_PTY }, async (t) => {
  const ws = await termSocket(daemonPort, 'xerb.localhost', { token, path: '/__xerb/term/restarter' });
  t.after(() => {
    ws.close();
    stop('restarter', 'test');
  });
  assert.equal(ws.status, 101);

  await waitFor(() => getRuntime('restarter').state === 'running', 20_000, 'the first start');
  const firstPid = getRuntime('restarter').pid;
  assert.ok(firstPid);
  assert.equal(separators('restarter'), 1, 'one start, one separator');

  const res = await req(daemonPort, '/__xerb/restart/restarter', { method: 'POST', token });
  assert.equal(res.status, 200, res.body);
  assert.equal(res.json.ok, true);

  const secondPid = getRuntime('restarter').pid;
  assert.ok(secondPid, 'something is running after the restart');
  assert.notEqual(secondPid, firstPid, 'a restart is a new process, not the old one');
  assert.equal(separators('restarter'), 2, 'the restart wrote its own separator');

  // The panel that was already open is attached to the new child: the socket is
  // keyed by host, not by pid, so it does not have to be reopened.
  await ws.waitForText('start: node server.js', 5000);
  assert.equal(getRuntime('restarter').state, 'running');
  const up = await waitFor(async () => {
    const hit = await get(RESTARTER_PORT);
    return hit && hit.status === 200 ? hit : null;
  }, 10_000, 'the restarted server to answer');
  assert.equal(up.body, 'ok');
});

// --- no python3: read-only, and it says so ----------------------------------

// A second daemon in its own process, because the interpreter is resolved once
// per process and this test is about what happens when there is none. Its
// registry has one project of its own, so nothing here collides with the
// daemon the tests above are driving.
test('with no python3 the panel is read-only, says so, and status carries the line', async (t) => {
  const configPath = path.join(TMP, 'nopy.json');
  const logsDir = path.join(TMP, 'nopy-logs');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      port: 0,
      idleTimeoutMs: IDLE_MS,
      startTimeoutMs: 20_000,
      projects: [{ host: 'nopy', dir: NOPY_DIR, port: NOPY_PORT, startCmd: PLAIN_CMD, enabled: true, framework: 'node' }],
    }) + '\n'
  );
  const bootScript = path.join(TMP, 'nopy-daemon.mjs');
  fs.writeFileSync(
    bootScript,
    `import { createDaemonServer, loadConfig, ensureControlToken } from ${JSON.stringify(path.join(ROOT, 'xerb.mjs'))};\n` +
      `loadConfig('test:nopy');\n` +
      `const token = ensureControlToken();\n` +
      `const srv = createDaemonServer();\n` +
      `srv.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: srv.address().port, token }) + '\\n'));\n`
  );

  const child = spawn(process.execPath, [bootScript], {
    env: {
      ...process.env,
      XERB_CONFIG: configPath,
      XERB_LOGS_DIR: logsDir,
      XERB_CONTROL_TOKEN_PATH: path.join(TMP, 'nopy-token'),
      // The switch that makes this machine look like one without python3.
      XERB_PYTHON: '',
      XERB_QUIET: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));

  let out = '';
  child.stdout.setEncoding('utf8');
  const boot = await new Promise((resolve, reject) => {
    child.stdout.on('data', (c) => {
      out += c;
      const nl = out.indexOf('\n');
      if (nl >= 0) resolve(JSON.parse(out.slice(0, nl)));
    });
    child.once('exit', (code) => reject(new Error(`daemon exited early (code=${code})`)));
    setTimeout(() => reject(new Error('the no-python daemon never printed its port')), 10_000).unref();
  });

  const status = await req(boot.port, '/__xerb/status');
  assert.equal(status.json.pty.available, false, 'no interpreter, no pty');
  assert.equal(status.json.pty.note, NO_PTY_NOTE, 'the one line `xerb status` prints');

  const ws = await termSocket(boot.port, 'xerb.localhost', { token: boot.token, path: '/__xerb/term/nopy' });
  assert.equal(ws.status, 101);
  // One line, at the top of the panel, before anything the dev server said.
  assert.ok(ws.frames[0].includes(NO_PTY_NOTE), `first frame should carry the note: ${JSON.stringify(ws.frames[0])}`);

  // Read-only means output only: the project still starts and still streams.
  await waitFor(async () => {
    const hit = await get(NOPY_PORT);
    return hit && hit.status === 200;
  }, 20_000, 'the fallback-spawned server to answer');
  ws.send('i:this goes nowhere\n');
  await new Promise((r) => setTimeout(r, 200));
  assert.doesNotMatch(ws.text, /this goes nowhere/, 'nothing typed is echoed: there is no tty to type into');

  // The other half of spec section 6's sentence: the panel says it in one line
  // at the top, and `xerb status` prints the same line once. The daemon has
  // shipped `pty.note` for a while; this is the CLI actually printing it.
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'xerb.mjs'), 'status'], {
    env: {
      ...process.env,
      XERB_PORT: String(boot.port),
      XERB_FALLBACK_PORT: String(boot.port),
      XERB_STATE_DIR: TMP,
      XERB_CONFIG: configPath,
      XERB_CONTROL_TOKEN_PATH: path.join(TMP, 'nopy-token'),
      NO_COLOR: '1',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(cli.status, 0, `xerb status: ${cli.stderr}`);
  assert.ok(cli.stdout.includes(NO_PTY_NOTE), `status prints the read-only line: ${JSON.stringify(cli.stdout)}`);
  assert.equal(
    cli.stdout.split(NO_PTY_NOTE).length - 1,
    1,
    'once, not once per project'
  );

  // Leave nothing running behind this test's own daemon.
  await req(boot.port, '/__xerb/stop/nopy', { method: 'POST', token: boot.token });
  ws.close();
});

// The statusPayload of the in-process daemon is the other half of the same
// line: on a machine WITH python3 there is nothing for the CLI to print.
test('status says whether dev servers get a real terminal', () => {
  const { pty } = statusPayload();
  assert.equal(typeof pty.available, 'boolean');
  assert.equal(pty.available, !!PYTHON);
  assert.equal(pty.note, PYTHON ? null : NO_PTY_NOTE);
});
