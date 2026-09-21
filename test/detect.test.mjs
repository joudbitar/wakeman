// Fixture tests for the non-Node detectors (lib/detect.mjs).
//
// Each test builds a real directory tree under a mkdtemp root and calls the
// detector the way scan.mjs does: with the dir path plus the Set of entry
// names the walk would have read. The negatives matter more than the
// positives here — every false positive is a startCmd the daemon would
// happily execute, so the cases below lean on the things that must NOT
// register.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { detectRails, detectDjango, detectStatic, detectNode, normalizeScanRoots, hardcodedPort } from '../lib/detect.mjs';

const ROOT = mkdtempSync(join(os.tmpdir(), 'xerb-detect-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
// Build a fixture dir from a spec: keys are relative paths, string values are
// file contents, null values are directories. Returns [dir, names] ready to
// hand to a detector.
function fixture(spec) {
  const dir = join(ROOT, `f${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(spec)) {
    const p = join(dir, rel);
    if (content === null) {
      mkdirSync(p, { recursive: true });
    } else {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, content);
    }
  }
  return [dir, new Set(readdirSync(dir))];
}

const MANAGE_PY = '#!/usr/bin/env python\nimport django\n';

// --- django ---------------------------------------------------------------

test('django with .venv/bin/python registers with that interpreter', () => {
  const [dir, names] = fixture({ 'manage.py': MANAGE_PY, '.venv/bin/python': '' });
  assert.deepEqual(detectDjango(dir, names), { framework: 'django', interpreter: '.venv/bin/python' });
});

test('django with venv/bin/python registers with that interpreter', () => {
  const [dir, names] = fixture({ 'manage.py': MANAGE_PY, 'venv/bin/python': '' });
  assert.deepEqual(detectDjango(dir, names), { framework: 'django', interpreter: 'venv/bin/python' });
});

test('django with only uv.lock registers via uv run', () => {
  const [dir, names] = fixture({ 'manage.py': MANAGE_PY, 'uv.lock': '' });
  assert.deepEqual(detectDjango(dir, names), { framework: 'django', interpreter: 'uv run python' });
});

test('django with only poetry.lock registers via poetry run', () => {
  const [dir, names] = fixture({ 'manage.py': MANAGE_PY, 'poetry.lock': '' });
  assert.deepEqual(detectDjango(dir, names), { framework: 'django', interpreter: 'poetry run python' });
});

test('django with no provable interpreter must NOT register', () => {
  // manage.py alone — no venv, no lockfile. A bare `python` guess is exactly
  // what the scanner must never emit.
  const [dir, names] = fixture({ 'manage.py': MANAGE_PY, 'requirements.txt': 'django\n' });
  assert.equal(detectDjango(dir, names), null);
});

test('a manage.py that never mentions django must NOT register', () => {
  const [dir, names] = fixture({ 'manage.py': '#!/usr/bin/env python\nprint("hi")\n', '.venv/bin/python': '' });
  assert.equal(detectDjango(dir, names), null);
});

// --- rails ----------------------------------------------------------------

test('rails app (Gemfile + bin/rails + config/application.rb) registers', () => {
  const [dir, names] = fixture({ Gemfile: '', 'bin/rails': '', 'config/application.rb': '' });
  assert.deepEqual(detectRails(dir, names), { framework: 'rails' });
});

test('rails engine (bin/rails but no config/application.rb) must NOT register', () => {
  // `rails plugin new` generates bin/rails too; its `server` command does not
  // exist, so an engine or plugin is not startable.
  const [dir, names] = fixture({ Gemfile: '', 'bin/rails': '' });
  assert.equal(detectRails(dir, names), null);
});

test('plain ruby gem (Gemfile only) must NOT register', () => {
  const [dir, names] = fixture({ Gemfile: '', 'mygem.gemspec': '' });
  assert.equal(detectRails(dir, names), null);
});

// --- static ---------------------------------------------------------------

test('static site at its own repo root registers, parked', () => {
  const [dir, names] = fixture({ 'index.html': '<html></html>', '.git': null });
  assert.deepEqual(detectStatic(dir, names), { framework: 'static', enabled: false });
});

test('a .git worktree file (not a dir) still counts as a repo root', () => {
  const [dir, names] = fixture({ 'index.html': '<html></html>', '.git': 'gitdir: /elsewhere\n' });
  assert.deepEqual(detectStatic(dir, names), { framework: 'static', enabled: false });
});

test('docs folder with an index.html must NOT register', () => {
  // The classic false positive: generated docs, coverage output, gh-pages
  // build products. None of them is a repo root of its own.
  const [dir, names] = fixture({ 'index.html': '<html></html>', 'other.html': '' });
  assert.equal(detectStatic(dir, names), null);
});

test('index.html at the root of another ecosystem repo must NOT register', () => {
  const [dir, names] = fixture({ 'index.html': '<html></html>', '.git': null, 'Cargo.toml': '' });
  assert.equal(detectStatic(dir, names), null);
});

test('index.html beside a package.json is the node path, not static', () => {
  const [dir, names] = fixture({ 'index.html': '', '.git': null, 'package.json': '{}' });
  assert.equal(detectStatic(dir, names), null);
});

// --- node -------------------------------------------------------------------
// detectNode returning null must NOT end the walk (scan.mjs descends past it),
// so the negatives here are about not registering, not about hiding subtrees.

test('package.json with a next dev script registers', () => {
  const [dir, names] = fixture({
    'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '14.0.0' } }),
  });
  assert.deepEqual(detectNode(dir, names), { framework: 'next', pm: 'npm', dev: 'next dev' });
});

test('a dependency-only package.json must NOT register', () => {
  // The blind spot that hid a whole home subtree: a stub package.json with
  // one dependency and no scripts at the top of ~/life.
  const [dir, names] = fixture({ 'package.json': JSON.stringify({ dependencies: { 'just-bash': '^3.1.0' } }) });
  assert.equal(detectNode(dir, names), null);
});

test('a plain-node dev script that does not look like a server must NOT register', () => {
  const [dir, names] = fixture({ 'package.json': JSON.stringify({ scripts: { dev: 'tsc --watch' } }) });
  assert.equal(detectNode(dir, names), null);
});

test('a plain-node dev script with a server hint registers', () => {
  const [dir, names] = fixture({ 'package.json': JSON.stringify({ scripts: { dev: 'nodemon server.js' } }) });
  assert.deepEqual(detectNode(dir, names), { framework: 'node', pm: 'npm', dev: 'nodemon server.js' });
});

test('a pinned port in a PORT-env framework rides along as fixedPort', () => {
  const [dir, names] = fixture({
    'package.json': JSON.stringify({ scripts: { dev: 'next dev -p 3000' }, dependencies: { next: '14.0.0' } }),
  });
  assert.deepEqual(detectNode(dir, names), { framework: 'next', pm: 'npm', dev: 'next dev -p 3000', fixedPort: 3000 });
});

test('a pinned port in a vite dev script is NOT a fixedPort (scan appends --port, last flag wins)', () => {
  const [dir, names] = fixture({
    'package.json': JSON.stringify({ scripts: { dev: 'vite --port 5173' }, devDependencies: { vite: '5.0.0' } }),
  });
  assert.deepEqual(detectNode(dir, names), { framework: 'vite', pm: 'npm', dev: 'vite --port 5173' });
});

test('the lockfile picks the package manager', () => {
  const [dir, names] = fixture({
    'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '14.0.0' } }),
    'pnpm-lock.yaml': '',
  });
  assert.equal(detectNode(dir, names).pm, 'pnpm');
});

test('malformed or absent package.json must NOT register', () => {
  const [dir, names] = fixture({ 'package.json': '{not json' });
  assert.equal(detectNode(dir, names), null);
  const [dir2, names2] = fixture({ 'index.html': '' });
  assert.equal(detectNode(dir2, names2), null);
});

// --- scanRoots ------------------------------------------------------------

test('scanRoots defaults to ~ and expands ~ prefixes', () => {
  assert.deepEqual(normalizeScanRoots(undefined, '/home/u'), ['/home/u']);
  assert.deepEqual(normalizeScanRoots([], '/home/u'), ['/home/u']);
  assert.deepEqual(normalizeScanRoots(['~', '~/code'], '/home/u'), ['/home/u']);
  assert.deepEqual(normalizeScanRoots(['~/code', '/srv/sites/'], '/home/u'), ['/home/u/code', '/srv/sites']);
});

test('scanRoots drops junk: non-strings, relative paths, nested and duplicate roots', () => {
  assert.deepEqual(
    normalizeScanRoots([42, null, 'relative/path', '/opt/a', '/opt/a', '/opt/a/nested'], '/home/u'),
    ['/opt/a']
  );
});

// --- hardcodedPort --------------------------------------------------------
// A dev script that pins its own port ignores the injected PORT, so the
// scanner must register the pinned port or every start times out (the
// tradepulse incident: `next dev -p 3000` registered on 3110).

test('hardcodedPort reads -p / --port / --port= as standalone tokens', () => {
  assert.equal(hardcodedPort('next dev -p 3000'), 3000);
  assert.equal(hardcodedPort('next dev --turbopack -p 3000'), 3000);
  assert.equal(hardcodedPort('react-scripts start --port 4200'), 4200);
  assert.equal(hardcodedPort('node server.js --port=8080'), 8080);
});

test('hardcodedPort returns null when the script leaves the port to the env', () => {
  assert.equal(hardcodedPort('next dev'), null);
  assert.equal(hardcodedPort('next dev --turbopack'), null);
  assert.equal(hardcodedPort(undefined), null);
});

test('hardcodedPort never matches flags glued inside other words or junk values', () => {
  assert.equal(hardcodedPort('serve --no-port 3000'), null, '--no-port is not --port');
  assert.equal(hardcodedPort('run top-p 3000'), null, 'suffix of another word');
  assert.equal(hardcodedPort('next dev -p 99999'), null, 'out of range');
  assert.equal(hardcodedPort('next dev -p 0'), null, 'port 0 is not a real pin');
  assert.equal(hardcodedPort('next dev -p'), null, 'flag with no value');
});
