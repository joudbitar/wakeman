// Pure-merge tests for the scanner's registry merge (lib/registry.mjs).
//
// mergeRegistry is the fs-free half of scan.mjs: it takes the already-scanned
// candidate rows plus the existing registry and returns the merged projects
// array. These tests call it in-memory with injected helpers and an injected
// dirExists predicate — no fs walk, no network, fully deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { mergeRegistry } from '../lib/registry.mjs';

// Repo root really exists on disk; use it as the "dir still exists" case.
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

// Local test doubles mirroring scan.mjs semantics. The exact startCmd string is
// irrelevant to these assertions — they only check that a NEW host gets a
// generated command and a KNOWN host keeps its hand-edited one.
const sanitizeHost = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const startCmdFor = (c, port) =>
  c.framework === 'vite' ? `${c.pm} run dev -- --port ${port} --strictPort` : `${c.pm} run dev`;

// Only REPO_ROOT is considered a real directory; everything else is "gone".
const dirExists = (d) => d === REPO_ROOT;

function byHost(projects, host) {
  return projects.find((p) => p.host === host);
}

test('preserves hand-edited port, startCmd, and enabled for a known host', () => {
  const existing = {
    projects: [
      { host: 'webapp', dir: REPO_ROOT, port: 3000, startCmd: 'custom-start', framework: 'next', enabled: false },
    ],
  };
  const candidates = [{ dir: REPO_ROOT, name: 'webapp', framework: 'next', pm: 'pnpm' }];

  const projects = mergeRegistry({
    existing,
    candidates,
    reservedHost: 'wakeman',
    poolStart: 3010,
    poolStep: 10,
    startCmdFor,
    sanitizeHost,
    dirExists,
  });

  const webapp = byHost(projects, 'webapp');
  assert.ok(webapp, 'rediscovered host should be present');
  // All three hand-edited values are preserved, not regenerated.
  assert.equal(webapp.port, 3000);
  assert.equal(webapp.startCmd, 'custom-start');
  assert.equal(webapp.enabled, false);
});

test('assigns fresh pool ports only to new hosts, never colliding with existing', () => {
  const existing = {
    projects: [
      { host: 'webapp', dir: REPO_ROOT, port: 3000, startCmd: 'custom-start', framework: 'next', enabled: true },
    ],
  };
  const candidates = [
    { dir: REPO_ROOT, name: 'webapp', framework: 'next', pm: 'pnpm' },
    { dir: '/tmp/x/newapp', name: 'newapp', framework: 'vite', pm: 'npm' },
  ];

  const projects = mergeRegistry({
    existing,
    candidates,
    reservedHost: 'wakeman',
    poolStart: 3010,
    poolStep: 10,
    startCmdFor,
    sanitizeHost,
    dirExists,
  });

  const webapp = byHost(projects, 'webapp');
  const newapp = byHost(projects, 'newapp');
  // Existing host keeps its hand-assigned port.
  assert.equal(webapp.port, 3000);
  // New host gets a pool port: >= poolStart, on the pool stride, and never the
  // existing port.
  assert.ok(newapp.port >= 3010, `newapp.port ${newapp.port} should be >= 3010`);
  assert.equal((newapp.port - 3010) % 10, 0, 'newapp.port should be on the pool stride');
  assert.notEqual(newapp.port, 3000);
  // A brand-new host gets a generated startCmd (not carried over from anywhere).
  assert.equal(newapp.startCmd, `npm run dev -- --port ${newapp.port} --strictPort`);
  assert.equal(newapp.enabled, true);
});

test('never emits the reserved host (candidate literally named wakeman is remapped)', () => {
  const candidates = [{ dir: '/tmp/x/wakeman', name: 'wakeman', framework: 'node', pm: 'npm' }];

  const projects = mergeRegistry({
    existing: null,
    candidates,
    reservedHost: 'wakeman',
    poolStart: 3010,
    poolStep: 10,
    startCmdFor,
    sanitizeHost,
    dirExists,
  });

  // The candidate named 'wakeman' is remapped to 'wakeman-2'...
  assert.ok(byHost(projects, 'wakeman-2'), 'wakeman candidate should be remapped to wakeman-2');
  // ...and no result entry ever uses the bare reserved host.
  assert.equal(byHost(projects, 'wakeman'), undefined, 'no entry may use the reserved host');
  assert.equal(projects.filter((p) => p.host === 'wakeman').length, 0);
});

test('candidate enabled: false registers parked, and a hand-flip survives the next rescan', () => {
  // First scan: a static-folder candidate arrives with enabled: false.
  const candidates = [{ dir: REPO_ROOT, name: 'site', framework: 'static', enabled: false }];
  const first = mergeRegistry({
    existing: null,
    candidates,
    reservedHost: 'wakeman',
    poolStart: 3010,
    poolStep: 10,
    startCmdFor,
    sanitizeHost,
    dirExists,
  });
  assert.equal(byHost(first, 'site').enabled, false, 'static candidate should start parked');

  // The user flips it on by hand; the rescan rediscovers the same candidate
  // (still carrying enabled: false) but the hand-set flag must win.
  const existing = { projects: first.map((p) => (p.host === 'site' ? { ...p, enabled: true } : p)) };
  const second = mergeRegistry({
    existing,
    candidates,
    reservedHost: 'wakeman',
    poolStart: 3010,
    poolStep: 10,
    startCmdFor,
    sanitizeHost,
    dirExists,
  });
  assert.equal(byHost(second, 'site').enabled, true, 'hand-enabled flag must survive a rescan');
});

test('carries over hand-added entries whose dir exists and drops those whose dir is gone', () => {
  const existing = {
    projects: [
      // Not rediscovered by the scan; dir exists -> carried over unchanged.
      { host: 'static', dir: REPO_ROOT, port: 5000, startCmd: 'python serve', framework: 'node', enabled: true },
      // Not rediscovered; dir gone -> dropped.
      { host: 'ghost', dir: '/gone', port: 5010, startCmd: 'x', framework: 'node', enabled: true },
    ],
  };
  // The scan rediscovers a different, brand-new project.
  const candidates = [{ dir: '/tmp/x/newapp', name: 'newapp', framework: 'next', pm: 'npm' }];

  const projects = mergeRegistry({
    existing,
    candidates,
    reservedHost: 'wakeman',
    poolStart: 3010,
    poolStep: 10,
    startCmdFor,
    sanitizeHost,
    dirExists,
  });

  // Carry-over whose dir exists: present and unchanged.
  const staticEntry = byHost(projects, 'static');
  assert.ok(staticEntry, 'static entry should be carried over');
  assert.equal(staticEntry.port, 5000);
  assert.equal(staticEntry.startCmd, 'python serve');
  assert.equal(staticEntry.dir, REPO_ROOT);
  assert.equal(staticEntry.enabled, true);

  // Carry-over whose dir is gone: dropped entirely.
  assert.equal(byHost(projects, 'ghost'), undefined, 'ghost entry should be dropped');
});

// --- fixedPort ------------------------------------------------------------
// fixedPort rides on a candidate whose dev script hardcodes its own port
// (scan.mjs parses the script). The app binds that port no matter what the
// registry says, so the merge must follow the script — except when the user
// hand-replaced the startCmd, which makes the port their call again.

test('a new host with fixedPort registers on it, and pool assignment steers around it', () => {
  const candidates = [
    { dir: '/tmp/x/pinned', name: 'pinned', framework: 'next', pm: 'pnpm', fixedPort: 3010 },
    { dir: '/tmp/x/other', name: 'other', framework: 'next', pm: 'npm' },
  ];
  const projects = mergeRegistry({
    existing: null,
    candidates,
    reservedHost: 'wakeman',
    poolStart: 3010,
    poolStep: 10,
    startCmdFor,
    sanitizeHost,
    dirExists,
  });
  assert.equal(byHost(projects, 'pinned').port, 3010, 'script-pinned port wins');
  assert.notEqual(byHost(projects, 'other').port, 3010, 'pool skips the pinned port');
});

test('a known host whose script pins a port is corrected away from a stale pool port', () => {
  // The tradepulse case: registered on pool port 3110, but the dev script says
  // -p 3000. The registered port is a guaranteed start timeout; the rescan
  // must repair it.
  const existing = {
    projects: [
      { host: 'tradepulse', dir: REPO_ROOT, port: 3110, startCmd: 'pnpm run dev', framework: 'next', enabled: true },
    ],
  };
  const candidates = [
    { dir: REPO_ROOT, name: 'tradepulse', framework: 'next', pm: 'pnpm', fixedPort: 3000 },
  ];
  const projects = mergeRegistry({
    existing,
    candidates,
    reservedHost: 'wakeman',
    poolStart: 3010,
    poolStep: 10,
    startCmdFor,
    sanitizeHost,
    dirExists,
  });
  assert.equal(byHost(projects, 'tradepulse').port, 3000, 'registry follows the script');
});

test('a hand-set startCmd keeps its hand-set port even when the package.json script pins one', () => {
  // The user replaced the command entirely; the package.json dev script is no
  // longer what runs, so its port pin is not evidence about anything.
  const existing = {
    projects: [
      { host: 'webapp', dir: REPO_ROOT, port: 4500, startCmd: 'pnpm run dev:custom -- -p 4500', framework: 'next', enabled: true },
    ],
  };
  const candidates = [
    { dir: REPO_ROOT, name: 'webapp', framework: 'next', pm: 'pnpm', fixedPort: 3000 },
  ];
  const projects = mergeRegistry({
    existing,
    candidates,
    reservedHost: 'wakeman',
    poolStart: 3010,
    poolStep: 10,
    startCmdFor,
    sanitizeHost,
    dirExists,
  });
  const webapp = byHost(projects, 'webapp');
  assert.equal(webapp.port, 4500, 'hand-set port survives');
  assert.equal(webapp.startCmd, 'pnpm run dev:custom -- -p 4500', 'hand-set cmd survives');
});
