// lib/macos.mjs: the facts a fresh Mac trips over. Pure where it can be; the
// fs half runs in a temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeTooOld, protectedRoot, isAccessDenied, isToolStub, whichOn, pinNode, stableNode } from '../lib/macos.mjs';

test('nodeTooOld passes 22 and up and names the version it refuses', () => {
  assert.equal(nodeTooOld('22.0.0'), null);
  assert.equal(nodeTooOld('24.16.0'), null);
  const msg = nodeTooOld('20.11.1');
  assert.match(msg, /needs node 22 or newer, and this is node 20\.11\.1/);
});

test('protectedRoot names the guarded folder a project sits under', () => {
  const home = '/Users/a';
  assert.equal(protectedRoot('/Users/a/Documents/site', home), '~/Documents');
  assert.equal(protectedRoot('/Users/a/Desktop', home), '~/Desktop');
  assert.equal(protectedRoot('/Users/a/Downloads/x/y', home), '~/Downloads');
  assert.equal(protectedRoot('/Users/a/Library/Mobile Documents/com~apple~CloudDocs/app', home), 'iCloud Drive');
  assert.equal(protectedRoot('/Volumes/ext/code/app', home), '/Volumes/ext');
  assert.equal(protectedRoot('/Users/a/code/app', home), null);
  assert.equal(protectedRoot('/Users/a/Documentsx/app', home), null, 'a prefix is not a parent');
});

test('isAccessDenied is EPERM or EACCES and nothing else', () => {
  assert.equal(isAccessDenied({ code: 'EPERM' }), true);
  assert.equal(isAccessDenied({ code: 'EACCES' }), true);
  assert.equal(isAccessDenied({ code: 'ENOENT' }), false);
  assert.equal(isAccessDenied(null), false);
});

test('isToolStub is only the known /usr/bin stubs, only without developer tools', () => {
  assert.equal(isToolStub('/usr/bin/python3', { devTools: false }), true);
  assert.equal(isToolStub('/usr/bin/python3', { devTools: true }), false);
  assert.equal(isToolStub('/usr/bin/ruby', { devTools: false }), false, 'ruby is a real binary');
  assert.equal(isToolStub('/opt/homebrew/bin/python3', { devTools: false }), false);
  assert.equal(isToolStub(null, { devTools: false }), false);
});

test('whichOn resolves on the given PATH, not the process one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-which-'));
  const bin = path.join(dir, 'tool');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(whichOn('tool', `/nope:${dir}`), bin);
  assert.equal(whichOn('tool', '/nope'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pinNode leaves a runnable copy that outlives the original', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-pin-'));
  const src = path.join(dir, 'versions', '22', 'node');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, '#!/bin/sh\necho v1\n', { mode: 0o755 });
  const dest = path.join(dir, 'state', 'bin', 'node');
  assert.equal(pinNode(src, dest), dest);
  // A second install over a pinned copy replaces it.
  fs.writeFileSync(src, '#!/bin/sh\necho v2\n', { mode: 0o755 });
  pinNode(src, dest);
  fs.rmSync(path.join(dir, 'versions'), { recursive: true });
  assert.equal(fs.readFileSync(dest, 'utf8'), '#!/bin/sh\necho v2\n');
  assert.ok(fs.statSync(dest).mode & 0o100, 'executable');
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['node'], 'no temp file left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stableNode picks the Homebrew opt link over the versioned Cellar path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-brew-'));
  const cellar = path.join(root, 'Cellar', 'node@24', '24.16.0', 'bin', 'node');
  const opt = path.join(root, 'opt', 'node@24', 'bin', 'node');
  for (const f of [cellar, opt]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
  }
  const dest = path.join(root, 'state', 'bin', 'node');
  assert.equal(stableNode(cellar, dest), opt);
  assert.equal(fs.existsSync(dest), false, 'nothing copied for Homebrew');
  fs.rmSync(root, { recursive: true, force: true });
});

test('stableNode copies a self-contained node, and keeps the original if the copy will not run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-nvm-'));
  const src = path.join(root, '.nvm', 'versions', 'node', 'v22.1.0', 'bin', 'node');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const dest = path.join(root, 'state', 'bin', 'node');
  assert.equal(stableNode(src, dest), dest);
  assert.equal(stableNode(src, dest, { run: () => ({ status: 1 }) }), src);
  assert.equal(fs.existsSync(dest), false, 'a copy that does not run is removed');
  fs.rmSync(root, { recursive: true, force: true });
});
