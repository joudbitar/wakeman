// Section 6, the CLI half: `lazydev attach <host>` and `lazydev logs -f <host>`.
//
// The daemon half (the pty, the ring buffer, GET /__lazydev/term/<host>) has
// its own tests in test/term.test.mjs and is taken as given here. What this
// file proves is the other end of that socket: the real entrypoint, spawned as
// a child, driving a real daemon on an OS-assigned port with a throwaway state
// dir.
//
//   - attach forwards what it reads on stdin into the dev server's terminal and
//     writes what comes back out, which is the spec's acceptance case: a dev
//     server that will not open its port until someone answers it.
//   - Ctrl-] detaches and leaves the dev server running. That is the whole
//     promise of the command, so it is asserted on the daemon's own status
//     rather than on the CLI's exit code alone.
//   - `logs -f` streams the same socket with the escapes stripped.
//   - no daemon: the section 1 message and exit 3, for both commands.
//
// A pipe stands in for the tty. That is deliberate: attach must work when its
// stdin is not a terminal (it is what makes this testable at all), and the
// raw-mode half cannot be proven without a real tty, so it is skipped with a
// reason rather than faked.
//
// Nothing here installs a LaunchAgent or touches the developer's own daemon:
// LAZYDEV_STATE_DIR, LAZYDEV_PORT and LAZYDEV_FALLBACK_PORT are all pinned.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'lazydev.mjs');
const DAEMON = path.join(ROOT, 'lazydev.mjs');

// Without a python3 there is no pty, so there is nothing to type into: the
// typing tests are skipped with a reason instead of failing on a machine that
// cannot run lib/pty.py.
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
const NO_PTY = findPython() ? false : 'no python3 on this machine: lib/pty.py cannot run';

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

async function poll(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fn();
      if (r) return r;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

let stateDir;
let homeDir;
let frontPort;
let readbackPort;
let chattyPort;
let daemon;

function env(extra = {}) {
  return {
    ...process.env,
    HOME: homeDir,
    LAZYDEV_STATE_DIR: stateDir,
    LAZYDEV_PORT: String(frontPort),
    LAZYDEV_FALLBACK_PORT: String(frontPort),
    LAZYDEV_REAP_INTERVAL_MS: '60000',
    LAZYDEV_QUIET: '1',
    NO_COLOR: '1', // plain output, so assertions read exact text
    ...extra,
  };
}

// The entrypoint, run to completion. For attach and logs -f this is only used
// on the paths that answer and exit.
function cli(args, extra) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: env(extra),
    encoding: 'utf8',
    input: '',
    timeout: 20_000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// The entrypoint, left running with its stdin open: this is how attach and
// `logs -f` are actually used. Returns a handle that accumulates stdout and
// can wait for a needle to show up in it.
function cliLive(args, extra) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: env(extra),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    exited,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    write: (data) => child.stdin.write(data),
    async waitFor(needle, timeoutMs = 20_000) {
      const hit = await poll(() => (stdout.includes(needle) ? true : null), timeoutMs);
      if (!hit) throw new Error(`waited ${timeoutMs}ms for ${JSON.stringify(needle)}; saw ${JSON.stringify(stdout.slice(-500))}`);
    },
    kill: (sig = 'SIGKILL') => {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    },
  };
}

function statusJson() {
  return new Promise((resolve, reject) => {
    const token = fs.readFileSync(path.join(stateDir, 'control-token'), 'utf8').trim();
    const req = http.request(
      {
        host: '127.0.0.1',
        port: frontPort,
        path: '/__lazydev/status',
        headers: { host: 'lazydev.localhost', 'x-lazydev-token': token },
      },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(b));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function stateOf(status, host) {
  const row = status.projects.find((p) => p.host === host);
  return row ? row.state : null;
}

before(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-attach-state-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-attach-home-'));
  frontPort = await freePort();
  readbackPort = await freePort();
  chattyPort = await freePort();

  // Both projects bind the PORT the daemon injects and answer 200. The planted
  // node_modules is what makes ensureUp skip the install step, so nothing here
  // shells out to a real npm.
  const serverJs = `require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT,'127.0.0.1');\n`;
  const plant = (name) => {
    const dir = path.join(homeDir, name);
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server.js'), serverJs);
    return dir;
  };
  const readbackDir = plant('readback');
  const chattyDir = plant('chatty');

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'projects.json'),
    JSON.stringify(
      {
        port: frontPort,
        // readback does not open its port until it has been typed into, so the
        // start timeout has to outlast the test's own round trip.
        startTimeoutMs: 25_000,
        idleTimeoutMs: 300_000,
        projects: [
          {
            host: 'readback',
            dir: readbackDir,
            port: readbackPort,
            // The spec's acceptance command: nothing but a real tty passes it,
            // because with pipes the `read` gets EOF and the server never runs.
            startCmd: "sh -c 'read x; echo got $x; node server.js'",
            framework: 'node',
            enabled: true,
          },
          {
            host: 'chatty',
            dir: chattyDir,
            port: chattyPort,
            // A colored line before the port opens: `logs -f` has to show the
            // word and not the escape that colored it.
            startCmd: `node -e "process.stdout.write('\\x1b[31mCRIMSON\\x1b[0m\\n')" && node server.js`,
            framework: 'node',
            enabled: true,
          },
        ],
      },
      null,
      2
    ) + '\n'
  );

  daemon = spawn(process.execPath, [DAEMON], {
    cwd: ROOT,
    env: env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.resume();
  daemon.stderr.resume();
  const up = await poll(() => statusJson(), 20_000);
  assert.ok(up, `daemon answered on 127.0.0.1:${frontPort}`);
});

after(async () => {
  try {
    daemon.kill('SIGINT');
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 600));
  try {
    daemon.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the refusals: no host, unknown host, no daemon
// ---------------------------------------------------------------------------

test('attach with no host says what it needs, exit 1', () => {
  const r = cli(['attach']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: lazydev attach <host>/);
});

test('logs -f with no host says what it needs, exit 1', () => {
  const r = cli(['logs', '-f']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: lazydev logs <host> -f/);
});

test('attach to an unknown host names the command that lists them, exit 1', () => {
  const r = cli(['attach', 'nope']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no project named "nope"/);
  assert.match(r.stderr, /lazydev status/);
});

test('no daemon: attach and logs -f both give the section 1 line and exit 3', async () => {
  // A port nothing answers on, so this cannot find the developer's own lazydev.
  const dead = String(await freePort());
  for (const args of [['attach', 'readback'], ['logs', 'readback', '-f']]) {
    const r = cli(args, { LAZYDEV_PORT: dead, LAZYDEV_FALLBACK_PORT: dead });
    assert.equal(r.code, 3, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /lazydev is not running; run `lazydev` to start it/);
  }
});

// ---------------------------------------------------------------------------
// the socket
// ---------------------------------------------------------------------------

test('attach types into the dev server and prints what it says back', { skip: NO_PTY, timeout: 90_000 }, async () => {
  const a = cliLive(['attach', 'readback']);
  try {
    // The hint is printed once, on connect, and says the key AND that leaving
    // does not stop anything.
    await a.waitFor('attached to readback');
    assert.match(a.stdout, /ctrl-\] detaches/);
    assert.match(a.stdout, /keeps running/);

    // Attaching is itself the wake request, so the spawn happens because of
    // this socket. The separator the daemon echoes is the sign it has started.
    await a.waitFor('start:');

    // The pty is set on the runtime record a tick after the spawn, and a line
    // typed before that lands nowhere, so keep offering it until it is read.
    // Extra lines are harmless: `read x` consumes one and the rest sit in the
    // tty buffer.
    const typed = await poll(() => {
      if (a.stdout.includes('got hello')) return true;
      a.write('hello\n');
      return null;
    }, 30_000);
    assert.ok(typed, `dev server echoed the typed line; saw ${JSON.stringify(a.stdout.slice(-400))}`);

    // And only then does it open its port, the half of the acceptance case
    // that proves the input actually reached the child rather than a pipe.
    const running = await poll(async () => (stateOf(await statusJson(), 'readback') === 'running' ? true : null), 30_000);
    assert.ok(running, 'readback came up after being typed into');

    // Ctrl-] detaches. The dev server is lazydev's, so it survives.
    a.write(Buffer.from([0x1d]));
    const { code } = await a.exited;
    assert.equal(code, 0, `detach exit: ${a.stderr}`);
    assert.match(a.stdout, /detached/);
    assert.match(a.stdout, /readback keeps running/);

    assert.equal(stateOf(await statusJson(), 'readback'), 'running', 'the dev server outlived the attach');
  } finally {
    a.kill();
  }
});

test('logs -f streams the same socket with the escapes stripped', { timeout: 90_000 }, async () => {
  const f = cliLive(['logs', 'chatty', '-f']);
  try {
    await f.waitFor('CRIMSON');
    // The color is gone, the word is not. `logs -f` is the follow of a log
    // file, not a terminal, so it carries no escapes at all.
    assert.ok(!f.stdout.includes('\u001b'), `no escapes: ${JSON.stringify(f.stdout.slice(-200))}`);
    assert.ok(!f.stdout.includes('\r'), 'CRLF folded to newlines');
    // No raw mode and no attach hint: this end of the socket is output only.
    assert.ok(!f.stdout.includes('ctrl-]'), 'follow does not print the detach key');

    // Opening the socket is itself the wake request, so the dev server is on
    // its way up; wait for the port before leaving, or "did it survive?" is
    // asking about a project that had not finished starting.
    const running = await poll(async () => (stateOf(await statusJson(), 'chatty') === 'running' ? true : null), 30_000);
    assert.ok(running, 'chatty came up');

    // The follow does not own the dev server either: Ctrl-C ends the follow.
    f.kill('SIGINT');
    const { code, signal } = await f.exited;
    assert.ok(code === 130 || signal === 'SIGINT', `left on SIGINT (code=${code} signal=${signal})`);
    assert.equal(stateOf(await statusJson(), 'chatty'), 'running', 'the dev server outlived the follow');
  } finally {
    f.kill();
  }
});

// The raw-mode half needs a controlling terminal, and `node --test` gives its
// children pipes. Faking one would assert nothing about the code that runs in a
// user's shell, so it is skipped with its reason instead.
test(
  'attach puts the local tty in raw mode and restores it',
  { skip: process.stdin.isTTY ? false : 'stdin is not a tty under node --test' },
  () => {
    const before = spawnSync('stty', ['-g'], { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' }).stdout;
    const a = cliLive(['attach', 'readback']);
    a.kill();
    const after = spawnSync('stty', ['-g'], { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' }).stdout;
    assert.equal(after, before, 'the tty is back the way it was');
  }
);
