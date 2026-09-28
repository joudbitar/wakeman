// pty shim tests: the terminal the daemon hands a dev server.
//
// lib/pty.py is spawned exactly the way the daemon spawns it, with four pipes
// (stdin, stdout, stderr, and fd 3 for resizes), and driven from here. What is
// proved: the command really runs on a tty, bytes written to stdin arrive at
// it, a "<rows> <cols>" line on fd 3 changes what stty reports inside, the
// exit code is the command's own, and SIGTERM to python leaves nothing behind
// (the master closes, the child gets SIGHUP). The whole file skips when there
// is no python3, which is the same condition that makes the daemon fall back
// to plain pipes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PTY_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'pty.py');

// PATH first, then the Xcode command line tools copy, which is what a machine
// with git but no homebrew python has.
function findPython() {
  for (const candidate of ['python3', '/usr/bin/python3']) {
    const probe = spawnSync(candidate, ['-c', ''], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

const PYTHON = findPython();
const skip = PYTHON ? false : 'no python3 on this machine';

function startPty(args) {
  const child = spawn(PYTHON, [PTY_PY, ...args], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const out = { text: '' };
  const waiters = [];
  child.stdout.on('data', (b) => {
    out.text += b.toString('utf8');
    for (const w of waiters.splice(0)) w();
  });
  // The exit code is the whole point of one of these tests, so capture it the
  // moment it lands rather than racing a later listener.
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  // Resolves once the accumulated output matches, or rejects after 10s with
  // what did arrive, which is far easier to read than a bare test timeout.
  const until = (re) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const m = out.text.match(re);
        if (m) {
          clearTimeout(timer);
          resolve(m);
        } else waiters.push(check);
      };
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${re}; saw: ${JSON.stringify(out.text)}`)),
        10_000,
      );
      check();
    });
  return { child, out, until, exited, resize: (rows, cols) => child.stdio[3].write(`${rows} ${cols}\n`) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the command runs on a real tty', { skip }, async () => {
  const p = startPty(['24', '80', 'test -t 0 && test -t 1 && tty']);
  await p.until(/\/dev\/(tty|pts\/)/); // /dev/ttys003 on macOS, /dev/pts/1 on Linux
  const { code } = await p.exited;
  assert.equal(code, 0);
});

test('stdin reaches the child, and the exit code comes back', { skip }, async () => {
  const p = startPty(['24', '80', 'read x; echo got $x; exit 3']);
  p.child.stdin.write('hello\n');
  await p.until(/got hello/);
  const { code } = await p.exited;
  assert.equal(code, 3);
});

test('a resize on fd 3 changes stty size inside', { skip }, async () => {
  // `read` holds the command at the gate until the resize has been applied.
  const p = startPty(['24', '80', 'stty size; read x; stty size']);
  const first = await p.until(/(\d+) (\d+)\r/);
  assert.equal(`${first[1]} ${first[2]}`, '24 80');
  p.resize(40, 100);
  await sleep(100);
  p.child.stdin.write('\n');
  await p.until(/40 100\r/);
  await p.exited;
});

test('SIGTERM to python takes the child with it', { skip }, async () => {
  // exec, so the pid the shell prints is the pid of the process that survives
  // long enough to be checked.
  const p = startPty(['24', '80', 'echo PID $$; exec sleep 300']);
  const pid = Number((await p.until(/PID (\d+)\r/))[1]);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(), 'the sleeper should be running before the kill');
  try {
    p.child.kill('SIGTERM');
    const { signal } = await p.exited;
    assert.equal(signal, 'SIGTERM');
    // SIGHUP travels through the closed master, not through us, so give it a
    // beat rather than asserting on the same tick.
    for (let i = 0; i < 40 && alive(); i++) await sleep(50);
    assert.equal(alive(), false, `pid ${pid} outlived the pty`);
  } finally {
    if (alive()) process.kill(pid, 'SIGKILL');
  }
});
