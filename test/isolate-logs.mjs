// Import this BEFORE ../wakeman.mjs. The daemon captures its logs dir at module
// load, and with no WAKEMAN_LOGS_DIR that is the checkout's own logs/, which on a
// run-in-place install is the live daemon's log. Imports evaluate in order, so
// a side-effect import above the daemon's is early enough, static or dynamic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.WAKEMAN_LOGS_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-testlogs-'));
  process.env.WAKEMAN_LOGS_DIR = dir;
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a temp dir we could not remove is the OS's to sweep */
    }
  });
}
