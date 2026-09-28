// State-directory + bind-fallback + URL-formatting tests (issue #9).
//
// The npx front door needs three pure decisions to be exactly right: where the
// ONE state directory is (and that registry/logs/token derive from it), whether
// a bind error falls back to a numbered port (and whether URLs must then carry
// the port), and how a project URL is formatted. Those are pure functions with
// no fs/net, so this file exercises them directly. Zero deps: node:test only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveStateDir, resolveStatePaths } from '../lib/state.mjs';
import { decideBindFallback, includePortForUrl, formatProjectUrl } from '../lib/bind.mjs';

// --- state dir resolution ---------------------------------------------------

test('resolveStateDir: explicit WAKEMAN_STATE_DIR wins over everything', () => {
  const dir = resolveStateDir({
    env: { WAKEMAN_STATE_DIR: '/tmp/custom-state', XDG_STATE_HOME: '/tmp/xdg' },
    home: '/home/j',
    scriptDir: '/opt/wakeman',
    preferXdg: true,
  });
  assert.equal(dir, path.resolve('/tmp/custom-state'));
});

test('resolveStateDir: preferXdg uses XDG_STATE_HOME/wakeman when set', () => {
  const dir = resolveStateDir({
    env: { XDG_STATE_HOME: '/tmp/xdg' },
    home: '/home/j',
    scriptDir: '/opt/wakeman',
    preferXdg: true,
  });
  assert.equal(dir, path.resolve('/tmp/xdg', 'wakeman'));
});

test('resolveStateDir: preferXdg with no XDG_STATE_HOME defaults to ~/.local/state/wakeman', () => {
  const dir = resolveStateDir({ env: {}, home: '/home/j', scriptDir: '/opt/wakeman', preferXdg: true });
  assert.equal(dir, path.resolve('/home/j', '.local', 'state', 'wakeman'));
});

test('resolveStateDir: preferXdg false keeps the next-to-script default (unchanged install)', () => {
  // No WAKEMAN_STATE_DIR + preferXdg false => scriptDir, so an installed daemon
  // and every existing self-test resolve exactly as before.
  const dir = resolveStateDir({ env: { XDG_STATE_HOME: '/tmp/xdg' }, home: '/home/j', scriptDir: '/opt/wakeman', preferXdg: false });
  assert.equal(dir, '/opt/wakeman');
});

test('resolveStateDir: an empty/whitespace WAKEMAN_STATE_DIR is ignored', () => {
  const dir = resolveStateDir({ env: { WAKEMAN_STATE_DIR: '   ' }, home: '/home/j', scriptDir: '/opt/wakeman', preferXdg: false });
  assert.equal(dir, '/opt/wakeman');
});

// --- registry / logs / token derive from the state dir ----------------------

test('resolveStatePaths: registry, logs, and token all derive from the state dir', () => {
  const p = resolveStatePaths({ env: {}, stateDir: '/state/wakeman' });
  assert.equal(p.stateDir, '/state/wakeman');
  assert.equal(p.configPath, path.join('/state/wakeman', 'projects.json'));
  assert.equal(p.logsDir, path.join('/state/wakeman', 'logs'));
  // token defaults next to the registry (its directory == the state dir here).
  assert.equal(p.tokenPath, path.join('/state/wakeman', 'control-token'));
});

test('resolveStatePaths: each per-path override still wins over the state-dir default', () => {
  // Every existing self-test hook (WAKEMAN_CONFIG / WAKEMAN_LOGS_DIR /
  // WAKEMAN_CONTROL_TOKEN_PATH) must keep pointing its own file at a temp dir.
  const env = {
    WAKEMAN_CONFIG: '/tmp/t/reg.json',
    WAKEMAN_LOGS_DIR: '/tmp/t/logs',
    WAKEMAN_CONTROL_TOKEN_PATH: '/tmp/t/tok',
  };
  const p = resolveStatePaths({ env, stateDir: '/state/wakeman' });
  assert.equal(p.configPath, path.resolve('/tmp/t/reg.json'));
  assert.equal(p.logsDir, path.resolve('/tmp/t/logs'));
  assert.equal(p.tokenPath, path.resolve('/tmp/t/tok'));
});

test('resolveStatePaths: token follows WAKEMAN_CONFIG when only the config is overridden', () => {
  // A test that points only WAKEMAN_CONFIG at a temp file gets an isolated token
  // beside it — the pre-state-dir behavior, preserved.
  const p = resolveStatePaths({ env: { WAKEMAN_CONFIG: '/tmp/iso/projects.json' }, stateDir: '/state/wakeman' });
  assert.equal(p.configPath, path.resolve('/tmp/iso/projects.json'));
  assert.equal(p.tokenPath, path.join(path.resolve('/tmp/iso'), 'control-token'));
});

// --- bind fallback decision -------------------------------------------------

test('decideBindFallback: EACCES on :80 falls back to the numbered port, URLs include port', () => {
  const d = decideBindFallback({ attemptedPort: 80, errorCode: 'EACCES', fallbackPort: 4000 });
  assert.deepEqual(d, { fallback: true, port: 4000, includePort: true });
});

test('decideBindFallback: EADDRINUSE on :80 falls back too', () => {
  const d = decideBindFallback({ attemptedPort: 80, errorCode: 'EADDRINUSE', fallbackPort: 7420 });
  assert.deepEqual(d, { fallback: true, port: 7420, includePort: true });
});

test('decideBindFallback: a non-fallback error code is not a fallback', () => {
  const d = decideBindFallback({ attemptedPort: 80, errorCode: 'EADDRNOTAVAIL', fallbackPort: 4000 });
  assert.deepEqual(d, { fallback: false });
});

test('decideBindFallback: fallback port equal to the attempted port is not recoverable', () => {
  // A same-port EADDRINUSE cannot be fixed by retrying the same number.
  const d = decideBindFallback({ attemptedPort: 4000, errorCode: 'EADDRINUSE', fallbackPort: 4000 });
  assert.deepEqual(d, { fallback: false });
});

test('decideBindFallback: falling back to 80 itself would not include the port', () => {
  // Degenerate but locked in: if the fallback IS 80, no port suffix is needed.
  const d = decideBindFallback({ attemptedPort: 3000, errorCode: 'EACCES', fallbackPort: 80 });
  assert.deepEqual(d, { fallback: true, port: 80, includePort: false });
});

// --- URL formatting ---------------------------------------------------------

test('includePortForUrl: only :80 is suffix-free', () => {
  assert.equal(includePortForUrl(80), false);
  assert.equal(includePortForUrl(4000), true);
  assert.equal(includePortForUrl(7420), true);
});

test('formatProjectUrl: front-door port omits the suffix, others include it', () => {
  assert.equal(formatProjectUrl('webapp', 80), 'http://webapp.localhost');
  assert.equal(formatProjectUrl('webapp', 7420), 'http://webapp.localhost:7420');
  assert.equal(formatProjectUrl('wakeman', 4000), 'http://wakeman.localhost:4000');
});
