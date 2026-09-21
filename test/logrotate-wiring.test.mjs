// Log-rotation WIRING tests.
//
// logrotate.test.mjs proves rotateIfNeeded() rotates correctly in isolation.
// These prove the daemon actually CALLS it at both of its log choke points —
// log() for daemon.log, logFdFor() for a per-project log — so deleting either
// call site fails a test (the coverage gap that made isolated-helper tests
// insufficient). We point the daemon's whole log dir at a throwaway temp dir
// via XERB_LOGS_DIR (set BEFORE importing the module, since LOGS_DIR is
// resolved at load), so nothing touches the real logs/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const LOGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-wiring-'));
process.env.XERB_LOGS_DIR = LOGS_DIR;
after(() => fs.rmSync(LOGS_DIR, { recursive: true, force: true }));

const { log, logFdFor } = await import('../xerb.mjs');

test('log() rotates daemon.log at the 1 MB cap (wiring)', () => {
  const daemonLog = path.join(LOGS_DIR, 'daemon.log');
  fs.writeFileSync(daemonLog, 'X'.repeat(1_000_000)); // exactly the default cap
  log('trigger a daemon.log write');
  assert.equal(
    fs.existsSync(`${daemonLog}.1`),
    true,
    'daemon.log.1 must exist — proves log() calls rotateIfNeeded before appending'
  );
  assert.ok(
    fs.statSync(daemonLog).size < 1_000_000,
    'the fresh daemon.log holds only the new line after rotation'
  );
});

test('logFdFor() rotates a per-project log at the 1 MB cap (wiring)', () => {
  const projLog = path.join(LOGS_DIR, 'proj.log');
  fs.writeFileSync(projLog, 'Y'.repeat(1_000_000));
  const fd = logFdFor('proj');
  if (typeof fd === 'number') fs.closeSync(fd);
  assert.equal(
    fs.existsSync(`${projLog}.1`),
    true,
    'proj.log.1 must exist — proves logFdFor() calls rotateIfNeeded before opening the append fd'
  );
  assert.ok(
    fs.statSync(projLog).size < 1_000_000,
    'the fresh proj.log is empty/small after rotation'
  );
});
