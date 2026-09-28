// Boot smoke for the daemon (issue #9).
//
// Scans a throwaway $HOME with the real scan.mjs, then runs the real
// wakeman.mjs on a random WAKEMAN_PORT, and asserts:
//   - the scan writes the registry INTO the state dir and discovers the
//     planted project;
//   - http://<host>.localhost:<port> proxies to the dev server the daemon
//     spawns from that entry;
//   - nothing was written into the project directory or the checkout — every
//     artifact (registry, logs, control token) landed in the state dir.
// Then Ctrl-C (SIGINT) stops it cleanly. Zero deps: node:test + built-ins.
//
// It drives wakeman.mjs rather than bin/wakeman.mjs because the entrypoint's
// one path is now a launchd install, and a GitHub runner has no GUI domain to
// bootstrap into. The entrypoint's own surface (consent, scan, help, version,
// the platform gate, every subcommand) is test/cli.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON = path.join(ROOT, 'wakeman.mjs');
const SCANNER = path.join(ROOT, 'scan.mjs');

// A free 127.0.0.1 port (opened then closed), for forcing a non-privileged
// front door the daemon can actually bind under a test runner.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// GET path via the daemon on 127.0.0.1:port with a Host header. Resolves
// { status, body }.
function get(hostHeader, port, reqPath = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: reqPath, headers: { host: hostHeader } },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Poll until predicate(get result) is true or timeout.
async function poll(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fn();
      if (r) return r;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

test('scan discovers a project and the daemon proxies to it on a forced port', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-npx-state-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-npx-home-'));

  // Plant ONE discoverable project under the temp HOME: a package.json with a
  // `dev` script whose name looks like a server (so scan keeps it), and a
  // node_modules dir so ensureUp skips `npm install`. The dev script is a node
  // one-liner that listens on the injected PORT and answers a fixed body — no
  // framework, no deps, deterministic.
  const projDir = path.join(homeDir, 'demoapp');
  fs.mkdirSync(path.join(projDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'package.json'),
    JSON.stringify({
      name: 'demoapp',
      scripts: {
        // `dev-server` keyword satisfies scan's SERVER_HINT for a plain node project.
        dev: `node -e "require('http').createServer((q,s)=>s.end('DEMO-OK')).listen(process.env.PORT,'127.0.0.1');/*dev-server*/"`,
      },
    })
  );

  const frontPort = await freePort();

  // Pin the demo project's dev-server port to a per-run free port BEFORE the
  // scan runs. Concurrent copies of this suite each used to get the SAME pool
  // port (3010) from mergeRegistry, so one run's dev server held the port while
  // the others' died on EADDRINUSE — and worse, waitForPort then saw the
  // winner's listener and declared the loser "ready". Pre-planting
  // { host, dir, port } goes through the registry's documented hand-edit path:
  // scan preserves a known host's port but still derives startCmd itself, so
  // the discovery assertion below can tell a real scan hit (startCmd present)
  // from a mere carry-over of this stub (startCmd absent).
  const devPort = await freePort();
  fs.writeFileSync(
    path.join(stateDir, 'projects.json'),
    JSON.stringify({ projects: [{ host: 'demoapp', dir: projDir, port: devPort }] })
  );

  const childEnv = {
    ...process.env,
    HOME: homeDir, // scan walks HOME; keep it tiny and contained
    WAKEMAN_STATE_DIR: stateDir,
    WAKEMAN_PORT: String(frontPort), // force a bindable non-privileged front door
    WAKEMAN_FALLBACK_PORT: String(frontPort),
    WAKEMAN_SCAN_QUIET: '1',
    // Fail a stuck start fast so the test can't hang on a bad spawn.
    WAKEMAN_REAP_INTERVAL_MS: '60000',
  };

  // The scan runs first, exactly as the entrypoint runs it: a child of this
  // process with the state dir pinned, no terminal, so no picker.
  const scan = spawnSync(process.execPath, [SCANNER], { cwd: ROOT, env: childEnv, encoding: 'utf8', timeout: 60000 });
  assert.equal(scan.status, 0, `scan exited 0\n${scan.stderr || ''}`);

  const child = spawn(process.execPath, [DAEMON], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));

  // Terminal signal for the polls below: once the daemon is gone there is
  // nothing left to wait for, however much deadline remains.
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  t.after(async () => {
    try {
      child.kill('SIGINT');
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 400));
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  // Wait for the daemon to answer on the front port (dashboard control plane).
  // Generous cap: under a parallel `node --test` load the boot (spawn + bind)
  // stretches well past any "reasonable" figure while still being fine. A dead
  // daemon ends the wait immediately instead of burning the cap.
  const up = await poll(async () => {
    if (exited) return { exited: true };
    const r = await get('wakeman.localhost', frontPort);
    return r && r.status ? r : null;
  }, 30000);
  assert.ok(up && up.status, `daemon should answer on 127.0.0.1:${frontPort}\n--- child output ---\n${out}`);

  // The scan wrote the registry INTO the state dir (not the checkout, not the
  // project dir), and it discovered our planted project.
  const regPath = path.join(stateDir, 'projects.json');
  assert.ok(fs.existsSync(regPath), 'registry written into the state dir');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  const demo = (reg.projects || []).find((p) => p.host === 'demoapp');
  assert.ok(demo, `planted project discovered by scan (got hosts: ${(reg.projects || []).map((p) => p.host).join(',')})`);
  // The pre-planted stub had NO startCmd; only a real scan discovery derives
  // one. This keeps the assertion meaning "the walk found the project", not
  // "the stub survived the merge as a carry-over".
  assert.equal(typeof demo.startCmd, 'string', 'scan derived a startCmd (discovery, not carry-over)');
  assert.equal(demo.port, devPort, 'scan preserved the pre-planted per-run port');

  // Hit the project through the daemon: the first cold hit spawns the dev server
  // (cwd == projDir, so no adopt/conflict), then subsequent hits proxy to it.
  //
  // No absolute wall-clock deadline here: with three `npm test` suites running
  // concurrently the planted dev server has taken >12s just to open its port
  // while everything still worked. The honest bound is the daemon's OWN
  // bring-up deadline — scan wrote startTimeoutMs into the registry and
  // ensureUp waits exactly that long for the port — so poll up to that plus
  // headroom for the proxy hop. Real failures don't wait it out: the moment
  // the daemon records a terminal verdict in daemon.log (start-timeout /
  // spawn-error) or the daemon dies, the poll ends and the assert shows
  // the verdict. What the test proves is unchanged; only the deadline now
  // scales with the daemon's instead of guessing a wall-clock figure.
  const startTimeoutMs = Number.isFinite(reg.startTimeoutMs) ? reg.startTimeoutMs : 120000;
  const daemonLogPath = path.join(stateDir, 'logs', 'daemon.log');
  const readDaemonLog = () => {
    try {
      return fs.readFileSync(daemonLogPath, 'utf8');
    } catch {
      return '';
    }
  };
  const outcome = await poll(async () => {
    if (exited) return { fail: 'daemon exited before the proxy came up' };
    const verdict = readDaemonLog().match(/(?:start-timeout|spawn-error): demoapp[^\n]*/);
    if (verdict) return { fail: `daemon gave up on the dev server: ${verdict[0]}` };
    const r = await get('demoapp.localhost', frontPort);
    return r && r.status === 200 && r.body === 'DEMO-OK' ? { res: r } : null;
  }, startTimeoutMs + 10000);
  assert.ok(
    outcome && outcome.res,
    `proxy reached the spawned dev server at demoapp.localhost:${frontPort}` +
      (outcome && outcome.fail ? `\n--- terminal verdict ---\n${outcome.fail}` : '') +
      `\n--- daemon.log ---\n${readDaemonLog()}\n--- child output ---\n${out}`
  );

  // Nothing was written into the project directory beyond what we planted: no
  // registry, no control token, no logs dir leaked into it.
  assert.ok(!fs.existsSync(path.join(projDir, 'projects.json')), 'no registry in the project dir');
  assert.ok(!fs.existsSync(path.join(projDir, 'control-token')), 'no control token in the project dir');
  assert.ok(!fs.existsSync(path.join(projDir, 'logs')), 'no logs dir in the project dir');

  // Everything landed in the state dir instead.
  assert.ok(fs.existsSync(path.join(stateDir, 'control-token')), 'control token in the state dir');
  assert.ok(fs.existsSync(path.join(stateDir, 'logs')), 'logs dir in the state dir');

  // SIGINT stops the daemon cleanly (its own handler exits 0). The claim is
  // "exits on SIGINT", not "exits fast" — the cap only exists so a hung
  // handler can't stall the suite, so keep it wide enough for a loaded box.
  child.kill('SIGINT');
  const sigintExited = await new Promise((resolve) => {
    child.once('exit', () => resolve(true));
    setTimeout(() => resolve(exited), 10000).unref?.();
  });
  assert.ok(sigintExited, 'the daemon exits on SIGINT');
});
