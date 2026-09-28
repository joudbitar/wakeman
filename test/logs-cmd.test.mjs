// `wakeman logs <host>` — the command every redacted status page points at.
// The daemon hides log tails from unauthorized browsers, so this CLI read is
// the sanctioned way to see WHY a start failed; it must work with the daemon
// wedged, dead, or never installed. These tests spawn the real entrypoint
// against a temp state dir — the same code path a user's shell runs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const BIN = path.join(ROOT, 'bin', 'wakeman.mjs');
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-logs-'));
const LOGS = path.join(STATE, 'logs');
after(() => fs.rmSync(STATE, { recursive: true, force: true }));

function run(args) {
  const r = spawnSync(process.execPath, [BIN, 'logs', ...args], {
    env: {
      ...process.env,
      WAKEMAN_STATE_DIR: STATE,
      NO_COLOR: '1', // plain output — assertions read exact text
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('no host: prints usage, exits 0 (asking how is not an error)', () => {
  const r = run([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: wakeman logs <host>/);
});

test('unknown host: says so, lists what exists, exits 1', () => {
  fs.mkdirSync(LOGS, { recursive: true });
  fs.writeFileSync(path.join(LOGS, 'someproj.log'), 'line\n');
  const r = run(['nope']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no log for nope yet/);
  assert.match(r.stdout, /someproj/);
});

test('tails the last -n lines of the host log', () => {
  fs.mkdirSync(LOGS, { recursive: true });
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
  fs.writeFileSync(path.join(LOGS, 'proj.log'), lines.join('\n') + '\n');
  const r = run(['proj', '-n', '10']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /last 10 of 50 lines/);
  assert.ok(r.stdout.includes('line-50'), 'newest line present');
  assert.ok(r.stdout.includes('line-41'), 'tenth-from-last present');
  assert.ok(!r.stdout.includes('line-40\n'), 'older lines cut');
});

test('accepts the URL form: host.localhost maps to the same log', () => {
  const r = run(['proj.localhost', '-n', '5']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /proj\.log/);
  assert.ok(r.stdout.includes('line-50'));
});

test('path traversal in the host is rejected as usage, exit 1', () => {
  const r = run(['../secrets']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /usage: wakeman logs <host>/);
});

// `-f` is a different command with the same name: it needs the live daemon,
// where plain `logs` deliberately does not. The contrast is the whole reason
// the file read stays daemon-free, so it is asserted in one place.
test('-f needs the daemon and says so, while the file read still works', async () => {
  fs.mkdirSync(LOGS, { recursive: true });
  fs.writeFileSync(path.join(LOGS, 'proj.log'), 'line-1\nline-2\n');

  // A port nothing answers on, so this cannot reach the developer's own
  // wakeman on :80 and pass for the wrong reason.
  const dead = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(String(port)));
    });
  });

  const follow = spawnSync(process.execPath, [BIN, 'logs', 'proj', '-f'], {
    env: { ...process.env, WAKEMAN_STATE_DIR: STATE, WAKEMAN_PORT: dead, WAKEMAN_FALLBACK_PORT: dead, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(follow.status, 3);
  assert.match(follow.stderr, /wakeman is not running; run `wakeman` to start it/);

  const plain = run(['proj']);
  assert.equal(plain.code, 0, 'the file read never asks the daemon');
  assert.ok(plain.stdout.includes('line-2'));
});
