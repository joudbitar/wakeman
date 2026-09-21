// Uninstall leaves no trace — the daemon's half of it.
//
// `xerb uninstall` stops the launchd job and deletes the state dir. The
// entrypoint now waits for the daemon process to exit first (lib/install.mjs
// waitForExit, covered in install.test.mjs), but a daemon that outlives that
// wait must still not resurrect what was just deleted: on a real machine the
// state dir reappeared one second after uninstall, holding nothing but
// logs/daemon.log with "config: could not read .../projects.json (ENOENT)" —
// the dying daemon's config watch firing on the vanishing registry, and log()
// recreating the whole tree to record it.
//
// XERB_LOGS_DIR is set BEFORE importing the daemon (LOGS_DIR is resolved at
// load), so this touches only a throwaway temp tree.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-uninstall-'));
const LOGS_DIR = path.join(STATE_DIR, 'logs');
process.env.XERB_LOGS_DIR = LOGS_DIR;
after(() => fs.rmSync(STATE_DIR, { recursive: true, force: true }));

const { log } = await import('../xerb.mjs');

test('log() creates a missing logs dir while the state dir is still there', () => {
  assert.equal(fs.existsSync(LOGS_DIR), false, 'logs/ starts absent — this is the first-boot shape');
  log('first line');
  assert.equal(fs.existsSync(path.join(LOGS_DIR, 'daemon.log')), true, 'daemon.log written');
});

test('log() does not rebuild a state dir that uninstall deleted', () => {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  // Exactly what happened on the real machine: the config watch fires on the
  // deleted registry and the daemon tries to say so.
  log('config: could not read /gone/projects.json (ENOENT); keeping previous registry');
  assert.equal(
    fs.existsSync(STATE_DIR),
    false,
    'a daemon still winding down must not resurrect the state dir uninstall just removed'
  );
});
