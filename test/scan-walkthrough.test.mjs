// Integration test for the walk itself: spawn scan.mjs against a fixture tree
// and read the registry it writes. Two behaviors only this level can prove:
//
// 1. A dependency-only package.json does not end the walk. The original blind
//    spot: a stub package.json at the top of a tree (~/life) hid every real
//    project underneath it.
// 2. scanDeclined is honored and preserved: a directory the user skipped in
//    the picker is never registered and never dropped from the registry.
//
// The child runs without a TTY, so the picker never raises and the scan
// registers everything it finds — the same path CI and the daemon use.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const ROOT = mkdtempSync(join(os.tmpdir(), 'wakeman-scanwalk-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const SCANNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scan.mjs');

function write(rel, content) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  if (content === null) mkdirSync(p, { recursive: true });
  else writeFileSync(p, content);
}

test('the walk descends past a stub package.json and honors scanDeclined', () => {
  const scanRoot = join(ROOT, 'home');
  const stateDir = join(ROOT, 'state');

  // The ~/life shape: a dependency-only package.json at the root...
  write('home/package.json', JSON.stringify({ dependencies: { 'just-bash': '^3.1.0' } }));
  // ...hiding a static site that is its own repo...
  write('home/projects/portfolio/index.html', '<html></html>');
  write('home/projects/portfolio/.git', null);
  // ...a next app...
  write('home/projects/webapp/package.json', JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '14.0.0' } }));
  // ...and a next app the user already declined in the picker.
  write('home/projects/declined-app/package.json', JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '14.0.0' } }));

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({
    port: 4000,
    scanRoots: [scanRoot],
    scanDeclined: [join(scanRoot, 'projects', 'declined-app')],
    projects: [],
  }));

  const r = spawnSync(process.execPath, [SCANNER], {
    env: { ...process.env, WAKEMAN_STATE_DIR: stateDir, WAKEMAN_SCAN_QUIET: '1' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);

  const reg = JSON.parse(readFileSync(join(stateDir, 'projects.json'), 'utf8'));
  const byHost = new Map(reg.projects.map((p) => [p.host, p]));

  assert.ok(byHost.has('webapp'), 'the next app under the stub was found');
  assert.ok(byHost.has('portfolio'), 'the static repo under the stub was found');
  assert.equal(byHost.get('portfolio').enabled, false, 'a blind scan still parks static folders');
  assert.ok(!byHost.has('declined-app'), 'a declined dir is never registered');
  assert.deepEqual(reg.scanDeclined, [join(scanRoot, 'projects', 'declined-app')], 'the "no" survives the rescan');
  assert.ok(!byHost.has('home'), 'the stub itself never registers');
});
