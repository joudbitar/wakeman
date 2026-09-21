// The CLI surface: flags before anything else, and every subcommand in the
// help table exercised against a real daemon on a random port.
//
// Two groups. The first runs the entrypoint with NO daemon and NO state dir
// and asserts the answer AND that the machine was left alone. `npx
// xerb --help` that creates ~/.local/state/xerb has already
// failed, whatever it printed. The second boots xerb.mjs against a throwaway
// state dir on an OS-assigned port and drives the subcommands through it, so
// the registry edits and the control-API calls are the real ones.
//
// Not covered here: `install` and `uninstall`, which bootstrap and boot out a
// user LaunchAgent under a fixed label; running either would reach past the
// temp state dir and stop the developer's own daemon. `open` IS covered, with
// a shim named `open` earlier on PATH than macOS's: the URL it is handed is the
// whole of that command, and a real one would put a browser window on the
// screen mid-test.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'xerb.mjs');
const DAEMON = path.join(ROOT, 'xerb.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// group 1: flags and errors, no daemon, no state dir
// ---------------------------------------------------------------------------

// A port nothing is listening on, so the "daemon not running" assertions below
// cannot accidentally find the developer's OWN xerb on :80.
const DEAD_PORT = await freePort();

// Each of these runs with XERB_STATE_DIR pointed at a path that does NOT
// exist, so "did the run create it?" is a one-line assertion.
function runClean(args, { platform } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-clean-'));
  const stateDir = path.join(tmp, 'state');
  const extra = [];
  if (platform) {
    // The only way to exercise the non-darwin exit on a mac: define
    // process.platform before the entrypoint's first line runs. `--import`
    // evaluates this module ahead of the main one.
    const stub = path.join(tmp, 'platform.mjs');
    fs.writeFileSync(stub, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true });\n`);
    extra.push('--import', `file://${stub}`);
  }
  const r = spawnSync(process.execPath, [...extra, BIN, ...args], {
    env: {
      ...process.env,
      XERB_STATE_DIR: stateDir,
      XERB_PORT: String(DEAD_PORT),
      XERB_FALLBACK_PORT: String(DEAD_PORT),
      NO_COLOR: '1',
      HOME: tmp,
    },
    encoding: 'utf8',
    timeout: 20000,
  });
  const madeState = fs.existsSync(stateDir);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', madeState };
}

test('--help / -h / help print the table, exit 0, and touch no state dir', () => {
  for (const args of [['--help'], ['-h'], ['help']]) {
    const r = runClean(args);
    assert.equal(r.code, 0, `${args[0]} exits 0`);
    assert.match(r.stdout, /xerb status\s+every project/, `${args[0]} prints the table`);
    assert.match(r.stdout, /xerb attach <host>/);
    assert.match(r.stdout, /xerb uninstall/);
    assert.equal(r.madeState, false, `${args[0]} left no state dir behind`);
  }
});

test('--version / -v print the version and touch no state dir', () => {
  for (const args of [['--version'], ['-v']]) {
    const r = runClean(args);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), VERSION);
    assert.equal(r.madeState, false);
  }
});

test('non-darwin: one line, exit 2, nothing else', () => {
  const r = runClean([], { platform: 'linux' });
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'xerb runs on macOS. Linux support is not planned.\n');
  assert.equal(r.stdout, '', 'nothing else runs');
  assert.equal(r.madeState, false);
});

test('non-darwin gate does not swallow --help', () => {
  const r = runClean(['--help'], { platform: 'linux' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /xerb status/);
});

test('unknown command: says which, reprints the table, exit 1, no state dir', () => {
  const r = runClean(['frobnicate']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command frobnicate/);
  assert.match(r.stderr, /xerb status\s+every project/, 'the table is the fix for a typo');
  assert.equal(r.madeState, false);
});

test('a refused first run (no terminal, no --yes) exits 1 and leaves no state dir', () => {
  const r = runClean([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /first run needs a terminal/);
  assert.equal(r.madeState, false, 'not even an empty logs folder');
});

test('every runtime subcommand with no daemon: the same line, exit 3', () => {
  for (const args of [['status'], ['stop', 'x'], ['restart', 'x'], ['wake', 'x'], ['open', 'x'], ['attach', 'x'], ['logs', 'x', '-f']]) {
    const r = runClean(args);
    assert.equal(r.code, 3, `${args.join(' ')} exits 3`);
    assert.match(r.stderr, /xerb is not running; run `xerb` to start it/, args.join(' '));
  }
});

test('registry subcommands with no registry say so instead of writing one', () => {
  for (const args of [['remove', 'x'], ['enable', 'x'], ['disable', 'x'], ['rename', 'x', 'y']]) {
    const r = runClean(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /no registry yet/, args.join(' '));
  }
});

// ---------------------------------------------------------------------------
// group 2: the subcommands against a live daemon
// ---------------------------------------------------------------------------

let stateDir;
let homeDir;
let frontPort;
let daemon;
let demoPort;
const configPath = () => path.join(stateDir, 'projects.json');
const registry = () => JSON.parse(fs.readFileSync(configPath(), 'utf8'));

function cli(args) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: {
      ...process.env,
      HOME: homeDir,
      XERB_STATE_DIR: stateDir,
      XERB_PORT: String(frontPort),
      XERB_FALLBACK_PORT: String(frontPort),
      NO_COLOR: '1',
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// The same entrypoint, left running with its pipes open. `attach` and
// `logs -f` do not return on their own, so the only way to exercise them is to
// hold the child, read what it writes, and end it the way a person would.
function cliLive(args) {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: {
      ...process.env,
      HOME: homeDir,
      XERB_STATE_DIR: stateDir,
      XERB_PORT: String(frontPort),
      XERB_FALLBACK_PORT: String(frontPort),
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return {
    exited,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    write: (data) => child.stdin.write(data),
    waitFor: (needle, ms = 30000) => poll(() => (stdout.includes(needle) ? true : null), ms),
    kill: (sig = 'SIGKILL') => { try { child.kill(sig); } catch { /* already gone */ } },
  };
}

function statusJson() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: frontPort, path: '/__xerb/status', headers: { host: 'xerb.localhost' } },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try { resolve(JSON.parse(b)); } catch (err) { reject(err); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Is anything answering on this port right now? The dev server is the only
// thing that would be.
function listening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(400);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
  });
}

async function poll(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fn();
      if (r) return r;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

// A project dir whose dev script is a one-line node listener: no framework, no
// install step (node_modules is planted), deterministic body.
function plantNodeProject(dir, body) {
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: path.basename(dir),
      scripts: {
        dev: `node -e "require('http').createServer((q,s)=>s.end('${body}')).listen(process.env.PORT,'127.0.0.1');/*dev-server*/"`,
      },
    })
  );
}

before(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-cli-state-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-cli-home-'));
  frontPort = await freePort();
  demoPort = await freePort();

  const demoDir = path.join(homeDir, 'demo');
  plantNodeProject(demoDir, 'DEMO-OK');
  const parkedDir = path.join(homeDir, 'parked');
  fs.mkdirSync(parkedDir, { recursive: true });

  fs.writeFileSync(
    configPath(),
    JSON.stringify({
      port: frontPort,
      startTimeoutMs: 20000,
      projects: [
        { host: 'demo', dir: demoDir, port: demoPort, startCmd: 'npm run dev', framework: 'node', enabled: true },
        { host: 'parked', dir: parkedDir, port: demoPort + 1, startCmd: 'true', framework: 'static', enabled: false },
      ],
    }, null, 2) + '\n'
  );

  daemon = spawn(process.execPath, [DAEMON], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      XERB_STATE_DIR: stateDir,
      XERB_PORT: String(frontPort),
      XERB_FALLBACK_PORT: String(frontPort),
      XERB_REAP_INTERVAL_MS: '60000',
      XERB_QUIET: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.resume();
  daemon.stderr.resume();
  const up = await poll(() => statusJson(), 20000);
  assert.ok(up, `daemon answered on 127.0.0.1:${frontPort}`);
});

after(async () => {
  try { daemon.kill('SIGINT'); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 600));
  try { daemon.kill('SIGKILL'); } catch { /* already gone */ }
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('status: one line per project, with the disabled one marked', () => {
  const r = cli(['status']);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /tries again/, 'nothing failed, so no hint line');
  assert.match(r.stdout, new RegExp(`demo\\s+\\S+\\s+:${demoPort}`));
  assert.match(r.stdout, /parked\s+disabled/);
  assert.match(r.stdout, /dashboard http:\/\/xerb\.localhost:/);
});

test('wake starts the dev server, status sees it running, stop stops it', async () => {
  const woke = cli(['wake', 'demo']);
  assert.equal(woke.code, 0, `wake: ${woke.stderr}`);
  assert.match(woke.stdout, /woke demo/);

  const running = await poll(async () => {
    const s = await statusJson();
    const row = s.projects.find((p) => p.host === 'demo');
    return row && row.state === 'running' ? row : null;
  }, 20000);
  assert.ok(running, 'daemon reports demo running');
  assert.match(cli(['status']).stdout, /demo\s+running/);

  const stopped = cli(['stop', 'demo']);
  assert.equal(stopped.code, 0);
  assert.match(stopped.stdout, /stopped demo/);
});

test('restart brings it back up', async () => {
  const r = cli(['restart', 'demo']);
  assert.equal(r.code, 0, `restart: ${r.stderr}`);
  assert.match(r.stdout, /restarted demo/);
  const s = await statusJson();
  assert.equal(s.projects.find((p) => p.host === 'demo').state, 'running');
  cli(['stop', 'demo']);
});

// A dev server that holds its port for a moment past the kill: Next, Vite and
// Rails all do, and the node one-liner here makes it deterministic (it delays
// on SIGHUP too, because the signal that reaches a child inside the pty is the
// master closing, not the group SIGTERM). Stop-then-up
// from the CLI raced that: the wake probed a port the dying server still held,
// matched its cwd, and ADOPTED the process it had just killed — "restarted"
// printed over a project that was never restarted, and owned flipped to false.
// The daemon's own /__xerb/restart waits for the port, which is why the CLI
// has to call it.
test('restart waits for the old server to let go of the port', { timeout: 60000 }, async () => {
  const dir = path.join(homeDir, 'lingerer');
  fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const cmd =
    'node -e "' +
    "const s=require('http').createServer((q,r)=>r.end('LINGER'));" +
    "s.listen(process.env.PORT,'127.0.0.1');" +
    "const bye=()=>setTimeout(()=>process.exit(0),1200);" +
    "process.on('SIGHUP',bye);process.on('SIGTERM',bye);" +
    '"';
  const added = cli(['add', dir, '--cmd', cmd, '--name', 'lingerer', '--port', String(port)]);
  assert.equal(added.code, 0, `add: ${added.stderr}`);

  const logFile = path.join(stateDir, 'logs', 'lingerer.log');
  const separators = () =>
    (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
      .split('\n')
      .filter((l) => l.startsWith('──')).length;

  // The daemon picks the new entry up from its fs.watch, which debounces.
  assert.ok(
    await poll(async () => (await statusJson()).projects.some((p) => p.host === 'lingerer'), 10000),
    'the daemon reloaded the registry'
  );
  const woke = cli(['wake', 'lingerer']);
  assert.equal(woke.code, 0, `wake: ${woke.stderr}`);
  const first = await poll(async () => {
    const row = (await statusJson()).projects.find((p) => p.host === 'lingerer');
    return row && row.state === 'running' && row.owned ? row : null;
  }, 20000);
  assert.ok(first, 'lingerer came up owned by xerb');
  assert.equal(separators(), 1, 'one start so far');

  const r = cli(['restart', 'lingerer']);
  assert.equal(r.code, 0, `restart: ${r.stderr}`);
  assert.match(r.stdout, /restarted lingerer/);
  const row = (await statusJson()).projects.find((p) => p.host === 'lingerer');
  assert.equal(row.state, 'running');
  assert.equal(row.owned, true, 'the restart spawned a server xerb owns, it did not adopt the dying one');
  assert.equal(separators(), 2, 'the restart wrote a second start separator');

  cli(['stop', 'lingerer']);
  cli(['remove', 'lingerer']);
});

test('status shows a failed start as failed, with the reason, and still exits 0', async () => {
  const dir = path.join(homeDir, 'crash-app');
  fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const crash = `node -e "console.error('Error: Cannot find module left-pad'); process.exit(1)"`;
  assert.equal(cli(['add', dir, '--cmd', crash, '--port', String(port)]).code, 0);

  // The daemon picks the new entry up from its file watch, a moment later.
  assert.ok(await poll(async () => (await statusJson()).projects.some((p) => p.host === 'crash-app'), 5000));
  const woke = cli(['wake', 'crash-app']);
  assert.notEqual(woke.code, 0, `the wake itself reports the failure: ${woke.stdout}${woke.stderr}`);
  const failed = await poll(async () => {
    const row = (await statusJson()).projects.find((p) => p.host === 'crash-app');
    return row && row.state === 'stopped' && row.lastError ? row : null;
  }, 20000);
  assert.ok(failed, 'the daemon recorded the failure');
  assert.equal(failed.lastError.kind, 'exited');

  const r = cli(['status']);
  assert.equal(r.code, 0, 'a failed project is a fact about the project, not the command');
  assert.match(r.stdout, /x crash-app\s+failed\s+:\d+\s+exited with code 1 · Error: Cannot find module left-pad/);
  assert.match(r.stdout, /`xerb logs <host>` shows why · `xerb restart <host>` tries again/);

  assert.equal(cli(['remove', 'crash-app']).code, 0);
  assert.ok(await poll(async () => !(await statusJson()).projects.some((p) => p.host === 'crash-app'), 5000));
  assert.doesNotMatch(cli(['status']).stdout, /tries again/, 'the hint goes with the failure');
});

test('wake refuses a disabled project, and names the fix', () => {
  const r = cli(['wake', 'parked']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /parked is disabled/);
  assert.match(r.stderr, /xerb enable parked/);
});

test('runtime commands on an unknown host: exit 1, not 3', () => {
  for (const cmd of ['stop', 'restart', 'wake', 'open', 'attach']) {
    const r = cli([cmd, 'nosuchproject']);
    assert.equal(r.code, 1, cmd);
    assert.match(r.stderr, /no project named "nosuchproject"/, cmd);
  }
});

// attach and `logs -f` are the two CLI clients of the per-project terminal
// socket. The deep half (typing into a dev server that will not open its port
// until it is answered, and the escapes `logs -f` strips) is test/attach.test.mjs;
// what belongs in the command-table file is that both entries reach a live
// daemon, say what they are, and leave the dev server running on the way out.
// The success path, with macOS's `open` replaced by a shim on PATH: the URL it
// is handed is the whole contract, and a real `open` would put a browser window
// on the developer's screen mid-test.
test('open hands the project URL to the system opener', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-openbin-'));
  const record = path.join(bin, 'opened');
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(record)}\n`);
  fs.chmodSync(path.join(bin, 'open'), 0o755);

  const r = spawnSync(process.execPath, [BIN, 'open', 'demo'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: homeDir,
      XERB_STATE_DIR: stateDir,
      XERB_PORT: String(frontPort),
      XERB_FALLBACK_PORT: String(frontPort),
      NO_COLOR: '1',
    },
    encoding: 'utf8',
    timeout: 20000,
  });
  try {
    assert.equal(r.status, 0, `open: ${r.stderr}`);
    assert.equal(fs.readFileSync(record, 'utf8'), `http://demo.localhost:${frontPort}`, 'the opener got the project URL on the port the daemon answers on');
    assert.match(r.stdout, /http:\/\/demo\.localhost/, 'and the URL is printed, for a terminal that swallowed the window');
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('attach opens the terminal socket, and ctrl-] leaves the dev server running', { timeout: 90000 }, async () => {
  const a = cliLive(['attach', 'demo']);
  try {
    assert.ok(await a.waitFor('attached to demo'), `attach connected; saw ${JSON.stringify(a.stdout)} ${a.stderr}`);
    assert.match(a.stdout, /ctrl-\] detaches/);

    a.write(Buffer.from([0x1d])); // ctrl-]
    const { code } = await a.exited;
    assert.equal(code, 0, `detach exit: ${a.stderr}`);
    assert.match(a.stdout, /detached/);
    assert.match(a.stdout, /demo keeps running/);

    // Attaching is itself the wake request, so demo is on its way up; the
    // point of the detach copy is that it stays up.
    const running = await poll(async () => {
      const s = await statusJson();
      const row = s.projects.find((p) => p.host === 'demo');
      return row && row.state === 'running' ? row : null;
    }, 30000);
    assert.ok(running, 'demo outlived the attach');
  } finally {
    a.kill();
  }
});

test('logs -f follows the same socket, and ctrl-c ends the follow, not the server', { timeout: 90000 }, async () => {
  const f = cliLive(['logs', 'demo', '-f']);
  try {
    // The socket's first frame is the scrollback, which carries the separator
    // the daemon wrote when it started demo.
    assert.ok(await f.waitFor('start:'), `follow saw the start separator; saw ${JSON.stringify(f.stdout.slice(-300))}`);
    assert.ok(!f.stdout.includes('\u001b'), 'a follow carries no escapes');

    f.kill('SIGINT');
    const { code, signal } = await f.exited;
    assert.ok(code === 130 || signal === 'SIGINT', `left on SIGINT (code=${code} signal=${signal})`);
    const s = await statusJson();
    assert.equal(s.projects.find((p) => p.host === 'demo').state, 'running', 'the dev server outlived the follow');
  } finally {
    f.kill();
  }
  cli(['stop', 'demo']); // back to the state the tests after this one expect
});

test('logs without -f reads the file, no daemon involved', () => {
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'logs', 'demo.log'), 'alpha\nbeta\n');
  const r = cli(['logs', 'demo']);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('beta'));
});

test('add runs the detectors on one directory and registers what they prove', async () => {
  const dir = path.join(homeDir, 'shop');
  plantNodeProject(dir, 'SHOP-OK');
  const port = await freePort();
  const r = cli(['add', dir, '--port', String(port)]);
  assert.equal(r.code, 0, `add: ${r.stderr}`);
  assert.match(r.stdout, /registered shop/);
  const entry = registry().projects.find((p) => p.host === 'shop');
  assert.ok(entry, 'shop is in the registry');
  assert.equal(entry.port, port);
  assert.equal(entry.startCmd, 'npm run dev', 'the detector derived the start command');
  assert.equal(entry.enabled, true);
});

test('add on an unprovable directory prints what it looked for and exits 1', () => {
  const dir = path.join(homeDir, 'mystery');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.py'), 'print("hi")\n');
  const r = cli(['add', dir]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /nothing provable/);
  assert.match(r.stdout, /rails\s+Gemfile/);
  assert.match(r.stdout, /django\s+manage\.py/);
  assert.match(r.stdout, /--cmd "flask run --port <port>"/, 'the fix is the --cmd form, for what is in the folder');
  assert.match(r.stdout, /`<port>` is replaced with the port xerb assigns\./);
  assert.doesNotMatch(r.stdout, /npm run dev/, 'app.py is the one thing `npm run dev` cannot start');
  assert.ok(!registry().projects.some((p) => p.dir === dir), 'nothing was written');
});

test('the unprovable hint is picked from the folder, and an empty one gets the generic line', () => {
  const hintFor = (name, files) => {
    const dir = path.join(homeDir, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
    const r = cli(['add', dir]);
    assert.equal(r.code, 1, name);
    assert.doesNotMatch(r.stdout, /npm run dev/, name);
    return r.stdout;
  };
  assert.match(hintFor('hint-empty', {}), /--cmd "your-start-command --port <port>"/);
  assert.match(hintFor('hint-fastapi', { 'main.py': '', 'requirements.txt': 'fastapi\nuvicorn\n' }), /--cmd "uvicorn main:app --port <port>"/);
  const go = hintFor('hint-go', { 'go.mod': 'module x\n' });
  assert.match(go, /--cmd "go run \."/);
  assert.match(go, /has to read PORT/);
  assert.match(hintFor('hint-compose', { 'compose.yaml': 'services: {}\n' }), /--cmd "docker compose up" --port <published port>/);
  assert.match(hintFor('hint-node', { 'package.json': '{"scripts":{"start":"node ."}}' }), /--cmd "npm start"/);
});

test('add --cmd registers the unprovable one, --name and --parked apply', async () => {
  const dir = path.join(homeDir, 'mystery');
  const port = await freePort();
  const r = cli(['add', dir, '--cmd', 'python3 app.py', '--name', 'flaskapp', '--port', String(port), '--parked']);
  assert.equal(r.code, 0, r.stderr);
  const entry = registry().projects.find((p) => p.host === 'flaskapp');
  assert.ok(entry);
  assert.equal(entry.startCmd, 'python3 app.py');
  assert.equal(entry.enabled, false);
  assert.match(r.stdout, /parked/);
});

test('add on an already-registered folder updates instead of failing', () => {
  const dir = path.join(homeDir, 'mystery');
  const before = registry().projects.find((p) => p.host === 'flaskapp').port;
  const r = cli(['add', dir, '--cmd', 'python3 wsgi.py', '--name', 'flaskapp']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /updated flaskapp/);
  const entry = registry().projects.find((p) => p.host === 'flaskapp');
  assert.equal(entry.startCmd, 'python3 wsgi.py');
  assert.equal(entry.port, before, 'the port it already had is kept');
  assert.equal(registry().projects.filter((p) => p.dir === dir).length, 1, 'one entry, not two');
});

// `add` on a folder already registered updates the entry in place, which means
// it is also the fourth way to change a running project's port or host. The
// other three (`xerb port`, the dashboard's set route, the dashboard's add
// route) all deal with the running server first; this one used to write and
// return, leaving a dev server on a port nothing routes to, or under a host
// that is no longer in the registry (so `stop` cannot find it and the reaper
// never visits it).
test('add on a running project stops it before moving its port or its name', { timeout: 60000 }, async () => {
  const dir = path.join(homeDir, 'mover');
  plantNodeProject(dir, 'MOVER-OK');
  const first = await freePort();
  assert.equal(cli(['add', dir, '--name', 'mover', '--port', String(first)]).code, 0);
  assert.ok(await poll(async () => (await statusJson()).projects.some((p) => p.host === 'mover'), 10000));

  const wake = async (host) => {
    assert.equal(cli(['wake', host]).code, 0);
    const row = await poll(async () => {
      const r = (await statusJson()).projects.find((p) => p.host === host);
      return r && r.state === 'running' && r.owned ? r : null;
    }, 20000);
    assert.ok(row, `${host} came up`);
  };

  await wake('mover');
  const second = await freePort();
  const moved = cli(['add', dir, '--name', 'mover', '--port', String(second)]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.match(moved.stdout, /updated mover/);
  assert.ok(await poll(async () => ((await listening(first)) ? null : true), 10000), 'the server let go of the old port');

  // The same for a name change: the runtime record is keyed by host, so a
  // server left running under the old one can never be stopped or reaped again.
  await wake('mover');
  const renamed = cli(['add', dir, '--name', 'movedon']);
  assert.equal(renamed.code, 0, renamed.stderr);
  assert.ok(await poll(async () => ((await listening(second)) ? null : true), 10000), 'and under the old name too');
  assert.ok(
    await poll(async () => (!(await statusJson()).projects.some((p) => p.host === 'mover') ? true : null), 10000),
    'the old host is gone from the registry'
  );

  cli(['remove', 'movedon']);
});

// Section 8: a static folder's entry stores the placeholder, never the absolute
// path to serve_static.py. Under npx that path is ~/.npm/_npx/<hash>/, which
// npm prunes, and the entry then dies with an ENOENT nobody can read. The
// daemon rewrites the path form on config load, but only once a daemon loads
// the file — and a `--parked` add never has to be loaded at all.
test('add on a static folder registers the placeholder, not a path into the npx cache', async () => {
  const dir = path.join(homeDir, 'site');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>\n');
  const r = cli(['add', dir, '--name', 'site', '--port', String(await freePort())]);
  assert.equal(r.code, 0, r.stderr);
  const entry = registry().projects.find((p) => p.host === 'site');
  assert.ok(entry, 'the static folder registered');
  assert.equal(entry.framework, 'static');
  assert.equal(entry.startCmd, '$XERB_STATIC');
  assert.match(r.stdout, /\$XERB_STATIC/, 'and that is what it printed too');
  cli(['remove', 'site']);
});

test('enable and disable flip the flag', () => {
  assert.equal(cli(['enable', 'flaskapp']).code, 0);
  assert.equal(registry().projects.find((p) => p.host === 'flaskapp').enabled, true);
  assert.equal(cli(['disable', 'flaskapp']).code, 0);
  assert.equal(registry().projects.find((p) => p.host === 'flaskapp').enabled, false);
});

test('port changes the registered port, and refuses a claimed one', async () => {
  const port = await freePort();
  const r = cli(['port', 'flaskapp', String(port)]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(registry().projects.find((p) => p.host === 'flaskapp').port, port);
  const clash = cli(['port', 'flaskapp', String(demoPort)]);
  assert.equal(clash.code, 1);
  assert.match(clash.stderr, /already claimed/);
});

test('port refuses while the project is running, and names the fix', async () => {
  assert.equal(cli(['wake', 'demo']).code, 0);
  await poll(async () => {
    const s = await statusJson();
    return s.projects.find((p) => p.host === 'demo').state === 'running';
  }, 20000);
  const p = await freePort();
  const r = cli(['port', 'demo', String(p)]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /stop it first: xerb stop demo/);
  cli(['stop', 'demo']);
});

test('rename moves the host and refuses a taken one', () => {
  const r = cli(['rename', 'flaskapp', 'flask']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(registry().projects.some((p) => p.host === 'flask'));
  assert.ok(!registry().projects.some((p) => p.host === 'flaskapp'));
  const taken = cli(['rename', 'flask', 'demo']);
  assert.equal(taken.code, 1);
  assert.match(taken.stderr, /"demo" is taken/);
  const reserved = cli(['rename', 'flask', 'xerb']);
  assert.equal(reserved.code, 1);
  assert.match(reserved.stderr, /reserved/);
});

// The add-project skill's script is a re-export of the same module, so its
// `remove` writes the same registry — but it used to write it and walk away,
// telling the user to go find the orphaned server with lsof. Nothing else can
// reach that child afterwards: `xerb stop` looks the host up in the registry
// it was just dropped from, and the reaper iterates the registry too.
test('the skill script stops a running project before dropping its entry', { timeout: 60000 }, async () => {
  const script = path.join(ROOT, '.claude', 'skills', 'add-project', 'scripts', 'registry.mjs');
  const dir = path.join(homeDir, 'skilldrop');
  plantNodeProject(dir, 'SKILL-OK');
  const port = await freePort();
  assert.equal(cli(['add', dir, '--name', 'skilldrop', '--port', String(port)]).code, 0);
  assert.ok(await poll(async () => (await statusJson()).projects.some((p) => p.host === 'skilldrop'), 10000));
  assert.equal(cli(['wake', 'skilldrop']).code, 0);
  assert.ok(
    await poll(async () => {
      const row = (await statusJson()).projects.find((p) => p.host === 'skilldrop');
      return row && row.state === 'running' && row.owned ? row : null;
    }, 20000),
    'skilldrop came up'
  );

  const r = spawnSync(process.execPath, [script, 'remove', '--host', 'skilldrop'], {
    env: {
      ...process.env,
      HOME: homeDir,
      XERB_STATE_DIR: stateDir,
      XERB_PORT: String(frontPort),
      XERB_FALLBACK_PORT: String(frontPort),
      NO_COLOR: '1',
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, `skill remove: ${r.stderr}`);
  assert.ok(!registry().projects.some((p) => p.host === 'skilldrop'), 'the entry is gone');
  assert.ok(await poll(async () => ((await listening(port)) ? null : true), 10000), 'and so is the dev server');
  assert.doesNotMatch(r.stdout, /lsof/, 'nobody is sent hunting for a pid');
});

test('remove drops the entry and says the folder was left alone', () => {
  const r = cli(['remove', 'flask']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /removed flask/);
  assert.match(r.stdout, /was not touched/);
  assert.ok(!registry().projects.some((p) => p.host === 'flask'));
  const again = cli(['remove', 'flask']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /no project named "flask"/);
});
