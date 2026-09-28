// The ONE place a registry entry is created, changed, or deleted.
//
// Two callers ask for the same edits and must never drift: `xerb add /
// remove / enable / disable / port / rename` in bin/xerb.mjs, and the
// add-project skill's scripts/registry.mjs (which is now a re-export of
// runCli below). The daemon watches projects.json and hot-reloads on write,
// so a write here IS the deployment, which is exactly why the validation
// (host shape, reserved host, absolute existing dir, unclaimed port) lives in
// one module instead of being retyped per caller.
//
// Everything mutating takes the parsed registry object and mutates it; the
// caller reads, mutates, writes. Failures throw RegistryError so a library
// caller can print in its own voice; runCli turns them into the skill
// script's exit-1 contract.
//
// Zero npm dependencies — Node built-ins only.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectRails, detectDjango, detectStatic, detectNode, VITE_BASED } from './detect.mjs';
import { VIEWABLE, viewablesRoot, isUnder } from './viewables.mjs';

// Package root: where serve_static.py lives, next to xerb.mjs.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same pool scan.mjs assigns from, so a hand-added entry and a scanned one
// never collide.
export const POOL_START = 3010;
export const POOL_STEP = 10;

// The host the daemon owns; no project may take it.
export const RESERVED_HOST = 'xerb';

// What a static-folder project stores as its startCmd. Not a path: the daemon
// expands this to `python3 <dir of the running xerb.mjs>/serve_static.py` at
// spawn time. Writing the absolute path here used to pin the entry to wherever
// the writer ran from, and under npx that is ~/.npm/_npx/<hash>/, which npm
// prunes. scan.mjs writes the same string for the same reason.
export const STATIC_PLACEHOLDER = '$XERB_STATIC';

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegistryError';
  }
}

const bad = (msg) => {
  throw new RegistryError(msg);
};

// ---------------------------------------------------------------------------
// file IO
// ---------------------------------------------------------------------------

// Same resolution order the skill documents: env override, XDG state dir, the
// default state dir, then a checkout-local projects.json. The entrypoint does
// NOT use this: it already resolved one state dir through lib/state.mjs and
// passes that path in.
export function findRegistry({ env = process.env, home = os.homedir(), checkoutRoot = APP_ROOT } = {}) {
  const cands = [];
  if (env.XERB_STATE_DIR) cands.push(path.join(env.XERB_STATE_DIR, 'projects.json'));
  if (env.XDG_STATE_HOME) cands.push(path.join(env.XDG_STATE_HOME, 'xerb', 'projects.json'));
  cands.push(path.join(home, '.local', 'state', 'xerb', 'projects.json'));
  cands.push(path.join(checkoutRoot, 'projects.json'));
  for (const p of cands) if (fs.existsSync(p)) return p;
  bad(`no registry found; looked at:\n  ${cands.join('\n  ')}\nstart xerb once so it creates one, or pass XERB_STATE_DIR.`);
}

export function readRegistry(file) {
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    bad(`${file} is not valid JSON (${err.message}); fix it before writing anything.`);
  }
  if (!Array.isArray(reg.projects)) bad(`${file} has no projects array.`);
  return reg;
}

export function writeRegistry(file, reg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// ports and names
// ---------------------------------------------------------------------------

// A port is usable when no registry entry claims it and nothing is listening
// on it right now (test-bind, loopback).
export function portListening(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

export async function pickPort(reg) {
  const used = new Set(reg.projects.map((p) => p.port));
  for (let port = POOL_START; port < 65000; port += POOL_STEP) {
    if (used.has(port)) continue;
    if (await portListening(port)) continue;
    return port;
  }
  bad(`no free port found in the ${POOL_START}+ pool.`);
}

// The same shape scan.mjs's sanitizeHost produces: a lowercase DNS label.
export function sanitizeHost(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function expandTilde(p, home = os.homedir()) {
  const s = String(p || '');
  if (s === '~') return home;
  if (s.startsWith('~/')) return path.join(home, s.slice(2));
  return s;
}

function assertHost(host) {
  if (!/^[a-z0-9-]+$/.test(host)) bad(`host must be lowercase a-z0-9- (got "${host}").`);
  if (host === RESERVED_HOST) bad(`the host "${RESERVED_HOST}" is reserved for the daemon.`);
}

function find(reg, host) {
  const entry = reg.projects.find((p) => p.host === host);
  if (!entry) bad(`no project named "${host}".`);
  return entry;
}

// ---------------------------------------------------------------------------
// detection for one directory: what `xerb add` runs when given no --cmd
// ---------------------------------------------------------------------------

// The detectors scan.mjs runs per directory, in the same order and for the
// same reasons (rails/django name the app; a package.json beside them is
// asset tooling; static never runs beside a package.json). Returns the
// detector result or null when nothing is provable.
export function detectOne(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = new Set(entries.map((e) => e.name));
  const det = detectRails(dir, names) || detectDjango(dir, names);
  if (det) return det;
  if (entries.some((e) => e.isFile() && e.name === 'package.json')) return detectNode(dir, names);
  return detectStatic(dir, names);
}

// What each detector needs, for the message `xerb add` prints when a
// directory proves nothing. Evidence, not advice: the user can check each line
// against their own folder.
export const DETECTOR_EVIDENCE = [
  ['rails', 'Gemfile + bin/rails + config/application.rb'],
  ['django', 'manage.py that mentions django + .venv, venv, uv.lock or poetry.lock'],
  ['node', 'package.json with a "dev" script that runs a server'],
  ['static', 'index.html at the root of its own git repo, and no package.json'],
];

function pmRun(pm) {
  switch (pm) {
    case 'pnpm': return 'pnpm dev';
    case 'yarn': return 'yarn dev';
    case 'bun': return 'bun run dev';
    default: return 'npm run dev';
  }
}

// Detector result to start command. The bulk path (scan.mjs) has its own copy
// for the whole candidate set; the two must agree, so change both together.
export function startCmdFor(det, port) {
  switch (det.framework) {
    case 'django':
      return `${det.interpreter} manage.py runserver 127.0.0.1:${port}`;
    case 'rails':
      return `bin/rails server -p ${port}`;
    case 'static':
      // The placeholder, not the path to serve_static.py — see STATIC_PLACEHOLDER.
      return STATIC_PLACEHOLDER;
  }
  const run = pmRun(det.pm);
  if (VITE_BASED.has(det.framework)) return `${run} -- --port ${port} --strictPort`;
  return run;
}

// ---------------------------------------------------------------------------
// the edits
// ---------------------------------------------------------------------------

// Register a project, or update the one already pointing at this directory.
// Re-adding a known folder updates instead of failing: the common case is a
// start command that changed, and making the user remove first would drop the
// port they have bookmarked.
//
// Returns { entry, updated }.
export async function addEntry(reg, { host, dir, startCmd, port, framework = 'node', parked = false, fixedPort } = {}) {
  host = String(host || '').trim();
  dir = String(dir || '').trim().replace(/\/+$/, '');
  startCmd = String(startCmd || '').trim();
  assertHost(host);
  if (!path.isAbsolute(dir)) bad(`the project directory must be absolute (got "${dir}").`);
  if (!fs.existsSync(dir)) bad(`no such directory: ${dir}`);
  if (!startCmd) bad('a start command is required.');

  const byDir = reg.projects.find((p) => p.dir === dir) || null;
  const byHost = reg.projects.find((p) => p.host === host) || null;
  if (byHost && byHost !== byDir) bad(`"${host}" is already registered for ${byHost.dir}; pick another name or remove it first.`);

  let resolved;
  if (port !== undefined && port !== null && port !== '') {
    resolved = Number(port);
    if (!Number.isInteger(resolved) || resolved <= 0 || resolved > 65535) bad(`port must be 1-65535 (got "${port}").`);
    if (reg.projects.some((p) => p !== byDir && p.port === resolved)) bad(`port ${resolved} is already claimed in the registry.`);
  } else {
    resolved = byDir ? byDir.port : await pickPort(reg);
  }

  const entry = byDir || {};
  entry.host = host;
  entry.dir = dir;
  entry.port = resolved;
  entry.startCmd = startCmd.includes('<port>') ? startCmd.replaceAll('<port>', String(resolved)) : startCmd;
  entry.framework = String(framework || 'node');
  entry.enabled = !parked;
  if (fixedPort) entry.fixedPort = fixedPort;
  // A folder under the viewables root is a throwaway page, not a project; see
  // lib/viewables.mjs. Re-adding one also brings it back out of the archive.
  if (isUnder(dir, viewablesRoot())) entry.kind = VIEWABLE;
  delete entry.archived;
  if (!byDir) reg.projects.push(entry);
  return { entry, updated: Boolean(byDir) };
}

export function removeEntry(reg, host) {
  const entry = find(reg, host);
  reg.projects = reg.projects.filter((p) => p !== entry);
  return entry;
}

export function setEnabled(reg, host, enabled) {
  const entry = find(reg, host);
  entry.enabled = Boolean(enabled);
  return entry;
}

export function setPort(reg, host, port) {
  const entry = find(reg, host);
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) bad(`port must be 1-65535 (got "${port}").`);
  if (reg.projects.some((p) => p !== entry && p.port === n)) bad(`port ${n} is already claimed in the registry.`);
  entry.port = n;
  return entry;
}

export function setStartCmd(reg, host, startCmd) {
  const entry = find(reg, host);
  const cmd = String(startCmd || '').trim();
  if (!cmd) bad('a start command is required.');
  entry.startCmd = cmd.includes('<port>') ? cmd.replaceAll('<port>', String(entry.port)) : cmd;
  return entry;
}

// Archive = parked and out of the way. `enabled: false` is what makes every
// runtime guard refuse it; `archived` (when) is what the dashboard sorts by.
export function archiveEntry(reg, host, now = Date.now()) {
  const entry = find(reg, host);
  entry.archived = now;
  entry.enabled = false;
  return entry;
}

export function restoreEntry(reg, host) {
  const entry = find(reg, host);
  delete entry.archived;
  entry.enabled = true;
  return entry;
}

export function renameEntry(reg, from, to) {
  const entry = find(reg, from);
  to = String(to || '').trim();
  assertHost(to);
  if (to === from) return entry;
  if (reg.projects.some((p) => p.host === to)) bad(`"${to}" is taken.`);
  entry.host = to;
  return entry;
}

// ---------------------------------------------------------------------------
// the skill's CLI, kept here so the skill script and the xerb subcommands
// share one implementation. Exit codes: 0 ok, 1 validation/registry error,
// 2 verify timeout.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'parked') args.parked = true;
      else args[key] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

// Stop a dev server over the daemon's control API, before the entry it runs
// under disappears. `xerb remove` and the dashboard's remove route both do
// this and for the same reason: the runtime record is keyed by host, so a
// server left running under a host the registry no longer has can never be
// stopped or reaped again, and the port it holds blocks whatever takes its
// place. Best effort — no daemon answering means nothing is running.
//
// The token lives beside the registry (the same default lib/state.mjs derives),
// and the front door is :80 with the registry's own port as the fallback-run
// case, which is what `verify` below polls too.
async function stopOverControlApi(file, reg, host) {
  const tokenPath = (process.env.XERB_CONTROL_TOKEN_PATH || '').trim()
    || path.join(path.dirname(file), 'control-token');
  let token;
  try {
    token = fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return; // no daemon ever minted one, so nothing of ours is running
  }
  if (!token) return;
  const ports = new Set([
    Number(process.env.XERB_PORT) || 80,
    Number(process.env.XERB_FALLBACK_PORT) || Number(reg.port) || 4000,
  ]);
  for (const port of ports) {
    const answered = await new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/__xerb/stop/${encodeURIComponent(host)}`,
          headers: { host: 'xerb.localhost', 'x-xerb-token': token },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
      req.on('error', () => resolve(false));
      req.setTimeout(3000, () => req.destroy());
      req.end();
    });
    if (answered) return;
  }
}

// Poll through the front door. :80 first (the portless happy path), then the
// registry's own configured port as the fallback-run case.
async function verify(args, reg) {
  const host = String(args.host || '').trim();
  const entry = reg.projects.find((p) => p.host === host);
  if (!entry) bad(`no entry with host "${host}".`);
  const timeoutS = Number(args['timeout-s']) || 120;
  const bases = [`http://${host}.localhost/`, `http://${host}.localhost:${reg.port || 4000}/`];
  const deadline = Date.now() + timeoutS * 1000;
  let last = 'no response';
  while (Date.now() < deadline) {
    for (const url of bases) {
      try {
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        last = `${res.status} at ${url}`;
        if (res.status >= 200 && res.status < 400) {
          process.stdout.write(`ok: ${url} answered ${res.status}\n`);
          return 0;
        }
      } catch (err) {
        last = `${err.cause?.code || err.name} at ${url}`;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  process.stderr.write(`verify timed out after ${timeoutS}s (last: ${last}).\nread the server's own output: <state-dir>/logs/${host}.log\n`);
  return 2;
}

// The whole script, minus the shebang. Returns the exit code.
export async function runCli(argv, { scriptPath = 'scripts/registry.mjs' } = {}) {
  // Piping into `head` closes stdout early; that is fine, not a crash.
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
  });

  const args = parseArgs(argv);
  const cmd = args._[0];
  try {
    const file = findRegistry();
    const reg = readRegistry(file);

    if (cmd === 'list') {
      for (const p of reg.projects) {
        const tag = p.archived ? '  (archived)' : p.kind ? `  (${p.kind})` : '';
        process.stdout.write(`${p.enabled === false ? '○' : '●'} ${p.host}  :${p.port}  ${p.startCmd}  ${p.dir}${tag}\n`);
      }
      return 0;
    }

    if (cmd === 'add') {
      const { entry } = await addEntry(reg, {
        host: args.host,
        dir: args.dir,
        startCmd: args['start-cmd'],
        port: args.port,
        framework: args.framework || 'node',
        parked: Boolean(args.parked),
      });
      writeRegistry(file, reg);
      process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
      process.stdout.write(`registered in ${file}; the daemon hot-reloads on write.\n`);
      process.stdout.write(entry.enabled
        ? `next: node ${scriptPath} verify --host ${entry.host}\n`
        : `parked (enabled: false); flip enabled to true in the registry to activate.\n`);
      return 0;
    }

    if (cmd === 'remove') {
      const host = String(args.host || '').trim();
      removeEntry(reg, host); // throws before anything is stopped
      await stopOverControlApi(file, reg, host);
      writeRegistry(file, reg);
      process.stdout.write(`removed "${host}"; ${reg.projects.length} projects remain. Its dev server was stopped; ${file} is the only thing that changed.\n`);
      return 0;
    }

    if (cmd === 'verify') return await verify(args, reg);

    bad('usage: registry.mjs <list|add|remove|verify> [--host --dir --start-cmd --framework --port --parked --timeout-s]');
  } catch (err) {
    if (err instanceof RegistryError) {
      process.stderr.write(`registry.mjs: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
