// lib/linux.mjs: the facts a Linux install trips over, driven from any OS.
// Pure where it can be; the pin half runs in a temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  unitPathFor, systemdUsable, systemdRequirementLine, parsePortStart, hasBindCapability, bindCapState,
  setcapArgs, setcapCommand, shellQuote, sameBytes, linuxNode,
} from '../lib/linux.mjs';

test('unitPathFor follows XDG_CONFIG_HOME and falls back to ~/.config', () => {
  assert.equal(unitPathFor({ env: {}, home: '/home/a' }), '/home/a/.config/systemd/user/wakeman.service');
  assert.equal(unitPathFor({ env: { XDG_CONFIG_HOME: '/cfg' }, home: '/home/a' }), '/cfg/systemd/user/wakeman.service');
  assert.equal(unitPathFor({ env: { XDG_CONFIG_HOME: '  ' }, home: '/home/a' }), '/home/a/.config/systemd/user/wakeman.service', 'blank is unset');
});

test('systemdUsable: a reachable user manager is ok, every other shape names why', () => {
  const calls = [];
  const ok = systemdUsable({ run: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: 'PATH=/usr/bin\n' }; } });
  assert.deepEqual(ok, { ok: true, detail: '' });
  assert.deepEqual(calls, [['systemctl', '--user', 'show-environment']], 'the cheapest call that has to reach the bus');

  // WSL with systemd off, or an ssh session with no user session: systemctl
  // exists and cannot connect.
  const bus = systemdUsable({ run: () => ({ status: 1, stderr: 'Failed to connect to bus: No medium found\n' }) });
  assert.equal(bus.ok, false);
  assert.equal(bus.detail, 'Failed to connect to bus: No medium found');

  // Alpine, a container: no systemctl at all.
  const none = systemdUsable({ run: () => ({ error: Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' }) }) });
  assert.equal(none.ok, false);
  assert.equal(none.detail, 'systemctl is not installed');

  const thrown = systemdUsable({ run: () => { throw new Error('boom'); } });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.detail, 'boom');
});

test('systemdRequirementLine is one line that names systemctl --user and the WSL fix', () => {
  const line = systemdRequirementLine('systemctl is not installed');
  assert.ok(!line.includes('\n'));
  assert.match(line, /systemctl --user/);
  assert.match(line, /\(systemctl is not installed\)/);
  assert.match(line, /wsl\.conf/);
  assert.ok(!systemdRequirementLine('').includes('()'), 'no empty parens without a detail');
});

test('parsePortStart reads the sysctl and rejects garbage', () => {
  assert.equal(parsePortStart('1024\n'), 1024);
  assert.equal(parsePortStart('0'), 0);
  assert.equal(parsePortStart(''), null);
  assert.equal(parsePortStart(undefined), null);
  assert.equal(parsePortStart('-1'), null);
  assert.equal(parsePortStart('lots'), null);
});

test('hasBindCapability reads both getcap output formats and nothing else', () => {
  assert.equal(hasBindCapability('/home/a/.local/state/wakeman/bin/node cap_net_bind_service=ep\n'), true, 'libcap 2.4x');
  assert.equal(hasBindCapability('/home/a/.local/state/wakeman/bin/node = cap_net_bind_service+ep\n'), true, 'libcap 2.2x');
  assert.equal(hasBindCapability('/x/node cap_net_bind_service=p\n'), false, 'permitted but not effective does not bind');
  assert.equal(hasBindCapability('/x/node cap_net_raw=ep\n'), false, 'a different capability');
  assert.equal(hasBindCapability(''), false, 'getcap missing, or the file has none');
  assert.equal(hasBindCapability(undefined), false);
});

test('bindCapState: the kernel setting first, then getcap', () => {
  assert.equal(bindCapState({ portStartText: '0\n', frontPort: 80 }), 'unneeded', 'a kernel that opens every port');
  assert.equal(bindCapState({ portStartText: '80\n', frontPort: 80 }), 'unneeded', 'the boundary is inclusive');
  assert.equal(bindCapState({ portStartText: '1024\n', frontPort: 4000 }), 'unneeded', 'a numbered front door never needs it');
  assert.equal(bindCapState({ portStartText: '1024\n', frontPort: 80, getcapOutput: '/p/node cap_net_bind_service=ep' }), 'granted');
  assert.equal(bindCapState({ portStartText: '1024\n', frontPort: 80, getcapOutput: '' }), 'missing');
  assert.equal(bindCapState({ portStartText: '', frontPort: 80 }), 'missing', 'an unreadable sysctl is treated as the stock 1024');
});

test('setcapCommand is the pasteable line, on the pin only, quoted when the path needs it', () => {
  assert.deepEqual(setcapArgs('/home/a/.local/state/wakeman/bin/node'), ['setcap', 'cap_net_bind_service=+ep', '/home/a/.local/state/wakeman/bin/node']);
  assert.equal(setcapCommand('/home/a/.local/state/wakeman/bin/node'), 'sudo setcap cap_net_bind_service=+ep /home/a/.local/state/wakeman/bin/node');
  assert.equal(setcapCommand('/home/a b/state/bin/node'), "sudo setcap cap_net_bind_service=+ep '/home/a b/state/bin/node'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote('/plain/path-1.2_3'), '/plain/path-1.2_3');
});

test('sameBytes is size then content, and false for anything missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-same-'));
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  const c = path.join(dir, 'c');
  fs.writeFileSync(a, 'node binary v1');
  fs.writeFileSync(b, 'node binary v1');
  fs.writeFileSync(c, 'node binary v2'); // same size, different bytes
  assert.equal(sameBytes(a, b), true);
  assert.equal(sameBytes(a, c), false);
  assert.equal(sameBytes(a, path.join(dir, 'missing')), false);
  assert.equal(sameBytes(a, dir), false, 'a directory is not a file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('linuxNode keeps a byte-identical pin in place, so a file capability survives a rerun', () => {
  // setcap writes the capability into the file's xattrs, and a copy drops
  // them. The inode staying put is the proof that no copy happened.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-lnode-'));
  const src = path.join(root, '.nvm', 'versions', 'node', 'v22.1.0', 'bin', 'node');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const dest = path.join(root, 'state', 'bin', 'node');
  const runs = [];
  const run = (bin, args) => { runs.push([bin, ...args]); return { status: 0 }; };

  assert.equal(linuxNode(src, dest, { run }), dest, 'first run pins');
  const before = fs.statSync(dest);
  assert.equal(linuxNode(src, dest, { run }), dest, 'second run keeps it');
  const after = fs.statSync(dest);
  assert.equal(after.ino, before.ino, 'same inode: nothing was copied over it');
  assert.equal(after.mtimeMs, before.mtimeMs, 'not even rewritten in place');
  assert.ok(runs.every(([bin]) => bin === dest), 'the copy is what gets proven to run');
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['node'], 'no temp file left behind');

  // A new node (a version manager switched) replaces the pin.
  fs.writeFileSync(src, '#!/bin/sh\nexit 0 # v2\n', { mode: 0o755 });
  assert.equal(linuxNode(src, dest, { run }), dest);
  assert.notEqual(fs.statSync(dest).ino, before.ino, 'replaced by a fresh copy');
  assert.equal(fs.readFileSync(dest, 'utf8'), '#!/bin/sh\nexit 0 # v2\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('linuxNode always pins, even a Homebrew-shaped path, and falls back to the original when the copy will not run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-lnode2-'));
  // Linuxbrew's layout looks like macOS Homebrew's; stableNode's opt/ shortcut
  // is macOS logic, and on Linux the pin is what carries the capability.
  const cellar = path.join(root, 'Cellar', 'node', '24.1.0', 'bin', 'node');
  const opt = path.join(root, 'opt', 'node', 'bin', 'node');
  for (const f of [cellar, opt]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const dest = path.join(root, 'state', 'bin', 'node');
  assert.equal(linuxNode(cellar, dest, { run: () => ({ status: 0 }) }), dest);
  assert.equal(fs.existsSync(dest), true);

  assert.equal(linuxNode(cellar, dest, { run: () => ({ status: 1 }) }), cellar);
  assert.equal(fs.existsSync(dest), false, 'a copy that does not run is removed');
  fs.rmSync(root, { recursive: true, force: true });
});
