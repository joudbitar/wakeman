// Unit tests for lib/install.mjs — the pure half of the one-command install.
// Zero deps: node:test + built-ins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCHD_LABEL, assembleLaunchdPath, renderPlist, stripCaddyBlock, extractWorkingDirectory, toolsToVerify, parseLaunchdPid, waitForExit } from '../lib/install.mjs';

test('assembleLaunchdPath preserves the user shell PATH order verbatim', () => {
  // The bug this guards against: the machine has a broken pnpm in
  // /usr/local/bin and the working one in ~/.npm-global/bin. The user's shell
  // orders .npm-global first, so it never sees the broken copy — the daemon
  // must inherit that exact ordering or it launches the wrong binary.
  const p = assembleLaunchdPath({
    userPath: '/Users/x/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    nodeDir: '/usr/local/bin',
    home: '/Users/x',
  });
  const dirs = p.split(':');
  assert.deepEqual(dirs.slice(0, 3), ['/Users/x/.npm-global/bin', '/opt/homebrew/bin', '/usr/local/bin']);
  assert.ok(
    dirs.indexOf('/Users/x/.npm-global/bin') < dirs.indexOf('/usr/local/bin'),
    'user ordering wins over node dir and standard-dir defaults'
  );
  assert.equal(new Set(dirs).size, dirs.length, 'no duplicates');
});

test('assembleLaunchdPath keeps nonstandard tool dirs the daemon would otherwise miss', () => {
  // Projects register arbitrary start commands (uv, cargo, mise shims, ...).
  // Whatever dir serves them in the user's shell must reach the daemon too.
  const p = assembleLaunchdPath({
    userPath: '/Users/x/.local/share/mise/shims:/Users/x/.cargo/bin:/usr/bin:/bin',
    nodeDir: '/opt/homebrew/Cellar/node/24.1.0/bin',
    home: '/Users/x',
  });
  const dirs = p.split(':');
  assert.equal(dirs[0], '/Users/x/.local/share/mise/shims');
  assert.equal(dirs[1], '/Users/x/.cargo/bin');
  assert.ok(dirs.includes('/opt/homebrew/Cellar/node/24.1.0/bin'), 'node dir appended when PATH lacks it');
});

test('assembleLaunchdPath drops npx-injected and relative entries', () => {
  // Under `npx lazydev` the inherited PATH carries the npx cache and
  // node_modules/.bin dirs — they vanish when the cache is pruned, so baking
  // them into a plist that outlives the run would leave dangling entries.
  const p = assembleLaunchdPath({
    userPath: [
      '/Users/x/.npm/_npx/abc123/node_modules/.bin',
      '/Users/x/proj/node_modules/.bin',
      '.',
      'relative/bin',
      '/usr/bin',
    ].join(':'),
    nodeDir: '/usr/local/bin',
    home: '/Users/x',
  });
  const dirs = p.split(':');
  assert.ok(!dirs.some((d) => d.includes('node_modules')), 'node_modules/.bin filtered');
  assert.ok(!dirs.some((d) => d.includes('_npx')), 'npx cache filtered');
  assert.ok(dirs.every((d) => d.startsWith('/')), 'relative entries filtered');
  assert.equal(dirs[0], '/usr/bin');
});

test('assembleLaunchdPath still covers the basics when the install PATH is minimal', () => {
  const p = assembleLaunchdPath({ userPath: '', nodeDir: '/opt/node/bin', home: '/Users/x' });
  const dirs = p.split(':');
  assert.equal(dirs[0], '/opt/node/bin');
  for (const d of ['/Users/x/Library/pnpm', '/Users/x/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    assert.ok(dirs.includes(d), `${d} present`);
  }
});

test('renderPlist pins the state dir, the front door, and the daemon path', () => {
  const plist = renderPlist({
    nodeBin: '/opt/node/bin/node',
    daemonPath: '/Users/x/.local/state/lazydev/app/lazydev.mjs',
    workDir: '/Users/x/.local/state/lazydev/app',
    stateDir: '/Users/x/.local/state/lazydev',
    logsDir: '/Users/x/.local/state/lazydev/logs',
    home: '/Users/x',
    pathEnv: '/opt/node/bin:/usr/bin:/bin',
  });
  assert.ok(plist.includes(`<string>${LAUNCHD_LABEL}</string>`));
  assert.ok(plist.includes('<string>/opt/node/bin/node</string>'));
  assert.ok(plist.includes('<string>/Users/x/.local/state/lazydev/app/lazydev.mjs</string>'));
  assert.ok(plist.includes('<key>LAZYDEV_STATE_DIR</key>'));
  assert.ok(plist.includes('<string>/Users/x/.local/state/lazydev</string>'));
  assert.ok(plist.includes('<key>LAZYDEV_PORT</key>'));
  assert.ok(plist.includes('<string>80</string>'));
  assert.ok(plist.includes('<key>LAZYDEV_FALLBACK_PORT</key>'));
  assert.ok(plist.includes('<string>4000</string>'));
  assert.ok(plist.includes('<key>KeepAlive</key>'));
  assert.ok(plist.includes('<key>RunAtLoad</key>'));
});

test('renderPlist escapes XML-special characters in paths', () => {
  const plist = renderPlist({
    nodeBin: '/odd & strange/<node>',
    daemonPath: '/d',
    workDir: '/w',
    stateDir: '/s',
    logsDir: '/l',
    home: '/h',
    pathEnv: '/a:/b',
  });
  assert.ok(plist.includes('/odd &amp; strange/&lt;node&gt;'));
  assert.ok(!plist.includes('/odd & strange/<node>'));
});

test('stripCaddyBlock removes the sentinel-marked block and nothing else', () => {
  const file = [
    'example.test {',
    '    respond "hi"',
    '}',
    '# >>> lazydev managed block >>>',
    '# Managed by lazydev. *.localhost routes to the daemon.',
    'http://*.localhost, http://*.*.localhost {',
    '    reverse_proxy 127.0.0.1:4000',
    '}',
    '# <<< lazydev managed block <<<',
    'other.test {',
    '    respond "bye"',
    '}',
  ].join('\n');
  const { text, changed } = stripCaddyBlock(file);
  assert.equal(changed, true);
  assert.ok(!text.includes('lazydev'));
  assert.ok(text.includes('example.test {'));
  assert.ok(text.includes('other.test {'));
});

test('stripCaddyBlock removes the legacy comment-through-brace form', () => {
  const file = [
    '# Managed by lazydev',
    'http://*.localhost {',
    '    reverse_proxy 127.0.0.1:4000',
    '}',
    'kept.test {',
    '}',
  ].join('\n');
  const { text, changed } = stripCaddyBlock(file);
  assert.equal(changed, true);
  assert.ok(!text.includes('localhost'));
  assert.ok(text.includes('kept.test {'));
});

test('extractWorkingDirectory round-trips through renderPlist and rejects garbage', () => {
  const plist = renderPlist({
    nodeBin: '/opt/node/bin/node',
    daemonPath: '/d/lazydev.mjs',
    workDir: '/Users/x/lazydev checkout',
    stateDir: '/s',
    logsDir: '/l',
    home: '/Users/x',
    pathEnv: '/a:/b',
  });
  assert.equal(extractWorkingDirectory(plist), '/Users/x/lazydev checkout');
  assert.equal(extractWorkingDirectory('not a plist'), null);
  assert.equal(extractWorkingDirectory(''), null);
});

test('stripCaddyBlock leaves an unmanaged Caddyfile untouched', () => {
  const file = 'a.test {\n    respond "a"\n}\n';
  const { text, changed } = stripCaddyBlock(file);
  assert.equal(changed, false);
  assert.equal(text, file);
});

test('toolsToVerify extracts bare tool names from enabled startCmds only', () => {
  const tools = toolsToVerify([
    { host: 'a', startCmd: 'pnpm dev', enabled: true },
    { host: 'b', startCmd: 'npm run dev', enabled: true },
    { host: 'c', startCmd: 'pnpm dev', enabled: true },            // dupe collapses
    { host: 'd', startCmd: 'bin/rails server -p 3200', enabled: true },   // project-relative: skip
    { host: 'e', startCmd: '.venv/bin/python manage.py runserver', enabled: true }, // ditto
    { host: 'f', startCmd: 'bun run dev', enabled: false },        // parked: never spawned
    { host: 'g', startCmd: '$(evil) dev', enabled: true },         // not a name we shell out with
    { host: 'h' },                                                 // no startCmd at all
  ]);
  assert.deepEqual(tools, ['npm', 'pnpm']);
});

test('toolsToVerify is calm about junk input', () => {
  assert.deepEqual(toolsToVerify(undefined), []);
  assert.deepEqual(toolsToVerify([]), []);
  assert.deepEqual(toolsToVerify([null, { startCmd: '   ' }]), []);
});

test('parseLaunchdPid finds the running job pid in launchctl print output', () => {
  // Shape of the real thing, trimmed: uninstall needs the pid so it can watch
  // the daemon actually exit before it deletes the state dir.
  const out = [
    'com.lazydev.proxy = {',
    '\tactive count = 1',
    '\tpath = /Users/x/Library/LaunchAgents/com.lazydev.proxy.plist',
    '\tstate = running',
    '',
    '\tprogram = /opt/node/bin/node',
    '\tpid = 54321',
    '\truntime = 921',
    '}',
  ].join('\n');
  assert.equal(parseLaunchdPid(out), 54321);
});

test('parseLaunchdPid returns null when no job is running', () => {
  // A loaded-but-idle job prints no pid line, and an unknown label prints
  // nothing at all. Both mean "nothing to wait for".
  assert.equal(parseLaunchdPid('com.lazydev.proxy = {\n\tstate = not running\n}'), null);
  assert.equal(parseLaunchdPid(''), null);
  assert.equal(parseLaunchdPid(undefined), null);
  // A pid mentioned inside another key is not the job's pid.
  assert.equal(parseLaunchdPid('\tspawn stats = last exit pid = 42'), null);
});

test('waitForExit returns once the process is gone, without burning the timeout', async () => {
  // The uninstall case: bootout returned, the daemon takes a few polls to die.
  let alive = 3;
  const slept = [];
  const ok = await waitForExit({
    isAlive: () => alive-- > 0,
    timeoutMs: 5000,
    intervalMs: 100,
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(ok, true, 'saw the exit');
  assert.equal(slept.length, 3, 'polled until gone, then stopped');
});

test('waitForExit gives up at the deadline instead of hanging', async () => {
  // The wedged-daemon case: uninstall must still finish. A fake clock keeps
  // this test instant and deterministic.
  let clock = 0;
  const ok = await waitForExit({
    isAlive: () => true,
    timeoutMs: 5000,
    intervalMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(ok, false, 'timed out rather than waiting forever');
  assert.ok(clock >= 5000 && clock < 5200, `stopped near the deadline (was ${clock}ms)`);
});

test('waitForExit checks before it sleeps at all', async () => {
  // Nothing to wait for (launchd had no pid) must cost zero time.
  let slept = 0;
  const ok = await waitForExit({ isAlive: () => false, sleep: async () => { slept++; } });
  assert.equal(ok, true);
  assert.equal(slept, 0);
});
