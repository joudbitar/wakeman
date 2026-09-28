// The daemon boots when its path runs through a symlink. On NFS lab machines
// /home/you is a link to /home3/you, so the service's ExecStart named a path
// whose real form differed from import.meta.url; the daemon decided it was
// not main, exited 0, and systemd restarted it forever with nothing logged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function status(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'wakeman.localhost' }, timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}

test('the daemon boots when started through a symlinked path', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-symlink-'));
  const link = path.join(tmp, 'app');
  fs.symlinkSync(ROOT, link);
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, 'projects.json'), JSON.stringify({ projects: [] }));
  const port = await freePort();

  const child = spawn(process.execPath, [path.join(link, 'wakeman.mjs')], {
    cwd: link,
    env: { ...process.env, WAKEMAN_STATE_DIR: stateDir, WAKEMAN_PORT: String(port), WAKEMAN_FALLBACK_PORT: String(port), WAKEMAN_QUIET: '1' },
    stdio: 'ignore',
  });
  let exitCode;
  child.once('exit', (code) => { exitCode = code; });
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  let code = null;
  for (let i = 0; i < 100 && code === null && exitCode === undefined; i++) {
    code = await status(port);
    if (code === null) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(exitCode, undefined, `the daemon exited (code ${exitCode}) instead of serving`);
  assert.ok(code, 'the daemon answered on its port');
});
