#!/usr/bin/env node
// lazydev — on-demand local dev-server proxy daemon.
// Zero npm dependencies. Node v22 built-ins only.
//
// See ./SPEC.md (project root) for the full build contract.

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStateDir, resolveStatePaths } from './lib/state.mjs';
import { decideBindFallback, formatProjectUrl } from './lib/bind.mjs';
import { LOGO } from './lib/ui.mjs';

// The port the front door actually bound (set at boot). config.port is what we
// ASK for; after a fallback they differ, and every URL the daemon renders must
// carry the port that works. null until the listen succeeds (tests importing
// this module never bind, so they render from config.port).
let activePort = null;

// The port URLs should be rendered with. The bound port is wrong whenever a
// front-door proxy sits between the browser and the daemon: the installed path
// has Caddy on :80 proxying to the daemon on :4000, and links must say what
// the BROWSER can reach. The request's own Host header knows — whatever port
// it carries (none means :80) demonstrably reaches us. Updated at request
// entry; rendering happens inside that same request, so a mid-await overwrite
// from a concurrent caller can only substitute another port that also works.
let renderPort = null;
function noteRenderPort(hostHeader) {
  if (!hostHeader) return;
  const h = String(hostHeader).trim();
  // "[::1]:4000" | "name:4000" | "name" — an absent :port on an http Host
  // header means the default port, 80.
  const m = h.includes(']') ? h.match(/\]:(\d+)$/) : h.match(/:(\d+)$/);
  const p = m ? Number(m[1]) : 80;
  if (Number.isFinite(p) && p > 0) renderPort = p;
}

// Front-door URL for a host, with the :port suffix whenever we are not on :80.
function frontUrl(host) {
  return formatProjectUrl(host, renderPort ?? activePort ?? config.port);
}

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

// This file's own directory — the next-to-script default state location, so the
// whole project is relocatable: move or clone it anywhere and the registry,
// logs, and daemon travel together. (Was hardcoded to ~/.config/lazydev before
// centralizing.)
const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));

// One state directory holds the registry, logs, and control token. When
// LAZYDEV_STATE_DIR is set (the npx entrypoint sets it), all three derive from
// it, so an npx run and a persistent install share one layout. When it is NOT
// set, the state dir IS CONFIG_DIR — the existing next-to-script layout — so an
// installed daemon and every existing self-test are unchanged.
//
// preferXdg stays false here: the daemon must not silently relocate an existing
// install to ~/.local/state on a bare boot. The npx path opts into the XDG
// default by resolving it (bin/lazydev.mjs) and exporting LAZYDEV_STATE_DIR
// before this module loads.
const STATE_DIR = resolveStateDir({ env: process.env, home: os.homedir(), scriptDir: CONFIG_DIR, preferXdg: false });

// The three state paths. Each still honors its OWN override env var
// (LAZYDEV_CONFIG / LAZYDEV_LOGS_DIR / LAZYDEV_CONTROL_TOKEN_PATH) so every
// existing self-test hook keeps pointing its file at a temp dir; the per-path
// override wins over the derived-from-state-dir default. The control token
// defaults next to the registry, so a test that points LAZYDEV_CONFIG at a temp
// file also gets an isolated token beside it.
const { configPath: CONFIG_PATH, logsDir: LOGS_DIR, tokenPath: CONTROL_TOKEN_PATH } = resolveStatePaths({ env: process.env, stateDir: STATE_DIR });
const DAEMON_LOG = path.join(LOGS_DIR, 'daemon.log');

const DEFAULTS = {
  port: 4000,
  idleTimeoutMs: 1_800_000, // 30 min
  startTimeoutMs: 120_000, // 2 min
  installTimeoutMs: 300_000, // 5 min
  connectionHardCapMs: 7_200_000, // 2h — a connection silent this long stops deferring the reaper
};

// Loopback families to try, in order. `localhost` on this machine resolves
// ::1 (IPv6) first; Next binds 0.0.0.0 (reachable via 127.0.0.1) but Vite binds
// `localhost` -> ::1 ONLY, so we must try both families everywhere we connect.
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

// How long a cold request waits for bring-up to SETTLE before it stops blocking
// and hands off to the status page / 503-retry. It covers the fast decisions —
// adopting an already-listening server, or rejecting a cwd-mismatch port
// conflict (a local probe + a synchronous lsof) — so those answer on the first
// hit, while a real spawn+startup (far longer) stays non-blocking. Kept well
// under the cold-nav responsiveness budget.
const COLD_SETTLE_GRACE_MS = 120;

const STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

// Make sure logs/ exists — but never RESURRECT a state dir that has been
// deleted out from under us. `lazydev uninstall` removes the whole state dir;
// a daemon still winding down used to rebuild it on its very next line (one
// ENOENT config-watch message was enough), so an uninstall that had just said
// "every trace removed" left a logs/daemon.log behind. A missing logs/ inside
// a state dir that still EXISTS is healed as before, which is the first-boot
// case. Returns whether the dir is there to write into.
function ensureLogsDir() {
  try {
    if (fs.existsSync(LOGS_DIR)) return true;
    if (!fs.existsSync(path.dirname(LOGS_DIR))) return false;
    ensureDir(LOGS_DIR);
    return fs.existsSync(LOGS_DIR);
  } catch {
    return false;
  }
}

function ts() {
  return new Date().toISOString();
}

// Cap a log file at maxBytes, keeping at most `keep` rotated generations
// (x.log -> x.log.1 -> ... -> x.log.<keep>, pruning older). Best-effort: any
// fs error is swallowed so logging can never crash the daemon. Called at the
// ONE place each log is opened for append (daemon.log in log(); per-project
// logs in logFdFor). Per-project logs are written by the spawned CHILD via the
// inherited fd, not by the daemon continuously, so rotating at fd-open time
// (each spawn/install) is the correct single choke point.
function rotateIfNeeded(file, maxBytes = 1_000_000, keep = 3) {
  try {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // file does not exist yet -> nothing to rotate
    }
    if (size < maxBytes) return;

    // Prune the oldest generation, then shift each generation up by one:
    // x.log.(keep-1) -> x.log.keep, ..., x.log.1 -> x.log.2, x.log -> x.log.1.
    try {
      fs.rmSync(`${file}.${keep}`, { force: true });
    } catch {
      /* ignore */
    }
    for (let i = keep - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
        /* generation absent — ignore */
      }
    }
    try {
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* ignore */
    }
  } catch {
    /* never throw into the daemon */
  }
}

// LAZYDEV_QUIET=1 keeps the terminal clean: log lines go to daemon.log only.
// The npx entrypoint sets it — it prints its own short banner, and the
// timestamped stream stays available in the state dir. FATAL lines still hit
// stderr so a failed boot is never silent.
const QUIET = process.env.LAZYDEV_QUIET === '1';

function log(...parts) {
  const line = `[${ts()}] ${parts.join(' ')}`;
  // stdout (stderr for FATAL when quiet — those precede an exit)
  try {
    if (!QUIET) process.stdout.write(line + '\n');
    else if (String(parts[0]).startsWith('FATAL')) process.stderr.write(line + '\n');
  } catch {
    /* ignore */
  }
  // daemon.log (best-effort). Ensure LOGS_DIR here rather than at import so a
  // bare `import` of this module writes nothing; mkdirSync recursive is
  // idempotent+cheap, so the running daemon's cost/behavior is unchanged.
  try {
    if (!ensureLogsDir()) return; // uninstalled underneath us — write nothing
    rotateIfNeeded(DAEMON_LOG);
    fs.appendFileSync(DAEMON_LOG, line + '\n');
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Config / registry
// ---------------------------------------------------------------------------

// config: { port, idleTimeoutMs, startTimeoutMs, projects: [...] }
let config = { ...DEFAULTS, projects: [] };

// Per-host live runtime state. Keyed by project host.
//   { project, state: 'stopped'|'installing'|'starting'|'running', owned: bool,
//     child: ChildProcess|null, pid: number|null, startPromise: Promise|null,
//     upstreamHost: string|null }  // loopback family that accepted the port
const runtime = new Map();
// lastAccess[host] = epoch ms of last proxied request
const lastAccess = new Map();
// connections[host] = Set of live connection records { lastByteAt }. A record is
// one proxied keep-alive HTTP socket or one WS/HMR upgrade; `lastByteAt` is the
// last time a byte crossed in either direction. `set.size` is the live count the
// user sees; the reaper only counts records whose silence is within the hard cap.
const connections = new Map();
// Guard so a keep-alive HTTP socket carrying many requests is counted ONCE (add
// a record on first request, decrement on socket close), not once per request.
const CONN_TRACKED = Symbol('lazydevConnTracked');

function projectByHost(host) {
  return config.projects.find((p) => p.host === host);
}

function getRuntime(host) {
  let r = runtime.get(host);
  if (!r) {
    // lastError persists on the record after startPromise clears, so the cold
    // status page can read WHY a background bring-up failed (see ensureUp). phase
    // is derived from `state` by phaseLabel(); we keep a slot but state is truth.
    // conflictDir holds the foreign cwd when a port-conflict is detected on adopt.
    r = { state: 'stopped', owned: false, child: null, pid: null, startPromise: null, upstreamHost: null, lastError: null, phase: null, conflictDir: null };
    runtime.set(host, r);
  }
  return r;
}

// Lazily create + return the host's live-connection Set (mirrors getRuntime).
function connSet(host) {
  let s = connections.get(host);
  if (!s) {
    s = new Set();
    connections.set(host, s);
  }
  return s;
}

// Add a live-connection record; returns it so the caller can bump lastByteAt and
// later remove it on socket close.
function addConn(host) {
  const rec = { lastByteAt: Date.now() };
  connSet(host).add(rec);
  return rec;
}

// Remove a record on socket close. Set.delete is idempotent, so wiring this to
// both 'close' and 'error' teardown paths cannot double-count.
function removeConn(host, rec) {
  connSet(host).delete(rec);
}

// Total live sockets for the host — what the status/CLI/dashboard display.
function connCount(host) {
  return connSet(host).size;
}

// Records that still DEFER the reaper: those with a byte within the hard cap. A
// connection silent longer than connectionHardCapMs no longer counts, so an
// abandoned-but-open tab stops protecting the project from the idle reaper.
function activeConnCount(host, now) {
  let n = 0;
  for (const rec of connSet(host)) {
    if (now - rec.lastByteAt <= config.connectionHardCapMs) n++;
  }
  return n;
}

function loadConfig(reason) {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    log(`config: could not read ${CONFIG_PATH} (${err.code || err.message}); keeping previous registry`);
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log(`config: invalid JSON in ${CONFIG_PATH} (${err.message}); keeping previous registry`);
    return false;
  }
  // LAZYDEV_PORT forces the listen port regardless of what the registry says.
  // The npx entrypoint sets it to 80 to serve the front door directly; applying
  // it HERE (not just once at boot) keeps the override across config reloads
  // (SIGHUP / control:reload) instead of snapping back to the registry's port.
  // Production install leaves it unset, so the registry's port wins as before.
  const envPort = Number(process.env.LAZYDEV_PORT);
  const next = {
    port: Number.isFinite(envPort) && envPort > 0
      ? envPort
      : (Number.isFinite(parsed.port) ? parsed.port : DEFAULTS.port),
    idleTimeoutMs: Number.isFinite(parsed.idleTimeoutMs) ? parsed.idleTimeoutMs : DEFAULTS.idleTimeoutMs,
    startTimeoutMs: Number.isFinite(parsed.startTimeoutMs) ? parsed.startTimeoutMs : DEFAULTS.startTimeoutMs,
    installTimeoutMs: Number.isFinite(parsed.installTimeoutMs) ? parsed.installTimeoutMs : DEFAULTS.installTimeoutMs,
    connectionHardCapMs: Number.isFinite(parsed.connectionHardCapMs) ? parsed.connectionHardCapMs : DEFAULTS.connectionHardCapMs,
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
  };
  config = next;
  log(`config: loaded ${config.projects.length} project(s) from ${CONFIG_PATH}${reason ? ` (${reason})` : ''}`);
  return true;
}

// fs.watch with debounce — wrapped so a watch failure cannot crash the daemon.
let watchTimer = null;
let watcher = null;
function startConfigWatch() {
  try {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      watcher = null;
    }
    watcher = fs.watch(CONFIG_PATH, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        try {
          loadConfig('fs.watch');
        } catch (err) {
          log(`config: reload via watch failed: ${err.message}`);
        }
      }, 200);
    });
    watcher.on('error', (err) => {
      log(`config: watcher error: ${err.message}`);
    });
  } catch (err) {
    // Watch failure (e.g. file does not exist yet) must NOT crash the daemon.
    log(`config: fs.watch unavailable for ${CONFIG_PATH} (${err.message}); SIGHUP still works`);
  }
}

// ---------------------------------------------------------------------------
// Host -> project key resolution (SPEC rule)
// ---------------------------------------------------------------------------

function resolveHostKey(hostHeader) {
  if (!hostHeader) return null;
  // strip :port
  let h = String(hostHeader).trim().toLowerCase();
  // host may be "name:4000" or "[::1]:4000"; we only care about the name part
  const colon = h.lastIndexOf(':');
  if (colon !== -1 && h.indexOf(']') === -1) {
    h = h.slice(0, colon);
  }
  // strip trailing .localhost
  if (h.endsWith('.localhost')) {
    h = h.slice(0, -'.localhost'.length);
  } else if (h === 'localhost') {
    return null;
  }
  // IP literals name no project: 127.0.0.1:4000 or [::1]:4000 in the address
  // bar should land on the dashboard, not on a project keyed "1" or "[::1]".
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[')) return null;
  if (!h) return null;
  const labels = h.split('.').filter(Boolean);
  if (labels.length === 0) return null;
  // project key is the LAST remaining dotted label
  return labels[labels.length - 1];
}

// ---------------------------------------------------------------------------
// Port probing
// ---------------------------------------------------------------------------

// Open a single TCP connection to `host:port`, resolving the live socket on
// connect or rejecting on error/timeout. Caller owns the returned socket.
function connectOnce(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let done = false;
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => {
      if (done) return;
      done = true;
      sock.setTimeout(0);
      resolve(sock);
    });
    const fail = (err) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      reject(err || new Error('connect failed'));
    };
    sock.once('timeout', () => fail(new Error('timeout')));
    sock.once('error', fail);
  });
}

// Happy-Eyeballs-style loopback connect: try 127.0.0.1 then ::1 (sequential
// fallback). Resolves { socket, host } with the family that actually accepted,
// so callers can pin the proxy/HMR upstream to the right family. The caller
// owns and must consume/destroy the socket.
async function connectLoopback(port, timeoutMs = 300) {
  let lastErr;
  for (const host of LOOPBACK_HOSTS) {
    try {
      const socket = await connectOnce(host, port, timeoutMs);
      return { socket, host };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`no loopback family accepted :${port}`);
}

// Single TCP probe — resolves a host string (127.0.0.1 or ::1) if EITHER
// loopback family has a listener within `timeoutMs`, else null.
async function probePort(port, timeoutMs = 300) {
  try {
    const { socket, host } = await connectLoopback(port, timeoutMs);
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
    return host;
  } catch {
    return null;
  }
}

// Resolve the working directory of the process LISTENing on `port`, via lsof
// (macOS). Returns the cwd string, or null when it cannot be determined (lsof
// missing/ENOENT, non-zero exit, timeout, or unparseable output). NEVER throws
// — a null return means "unknown", and ensureUp degrades to the legacy adopt
// instead of blocking. Two -F (field) queries: first the listening PID on the
// port, then that PID's cwd file descriptor.
function defaultResolvePidCwd(port) {
  let pid;
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fpn'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    // -F output is one field per line; a `p<pid>` line starts each process
    // record. A listener may show multiple fds but the same pid repeats — take
    // the first.
    for (const line of out.split('\n')) {
      if (line[0] === 'p') {
        pid = line.slice(1).trim();
        break;
      }
    }
    if (!pid) return null;
  } catch {
    return null;
  }
  try {
    const out = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    // The `n<path>` line carries the cwd path for the cwd fd.
    for (const line of out.split('\n')) {
      if (line[0] === 'n') {
        const p = line.slice(1).trim();
        return p || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Mutable binding so the bundled self-test can swap in a fake resolver (same
// spirit as LAZYDEV_CONFIG / LAZYDEV_REAP_INTERVAL_MS) and never spawn lsof.
// ensureUp calls through this binding, so the setter must reassign it in place.
let resolvePidCwd = defaultResolvePidCwd;
function __setResolvePidCwd(fn) {
  resolvePidCwd = typeof fn === 'function' ? fn : defaultResolvePidCwd;
}

// True if two directory paths refer to the same directory. Resolves both (so
// trailing-slash / `.` segments don't matter) and, best-effort, dereferences
// symlinks — lsof reports the real path, but project.dir may be a symlink, so a
// plain string compare would wrongly flag a legitimate manual server.
function sameDir(a, b) {
  if (!a || !b) return false;
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (ra === rb) return true;
  let realA = ra;
  let realB = rb;
  try {
    realA = fs.realpathSync(ra);
  } catch {
    /* path may not exist locally (e.g. lsof's view); fall back to resolved */
  }
  try {
    realB = fs.realpathSync(rb);
  } catch {
    /* ignore */
  }
  return realA === realB;
}

// Poll until SOME loopback family accepts a connection or we time out. Resolves
// the host string that worked (so ensureUp can pin state.upstreamHost).
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      const host = await probePort(port, 250);
      if (host) return resolve(host);
      if (Date.now() >= deadline) {
        return reject(new Error(`timeout waiting for loopback:${port} after ${timeoutMs}ms`));
      }
      setTimeout(attempt, 250);
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// Lifecycle: ensureUp / stop
// ---------------------------------------------------------------------------

// Open (append) the per-project log fd handed to the spawned child via stdio.
// This is the SOLE opener of per-project logs — called once per install spawn
// (runInstall) and once per start spawn (ensureUp). The daemon never appends to
// this fd itself; the child owns it continuously. So fd-open time is the only
// choke point the daemon controls: we rotate here, capping the log at each
// spawn/install. Deliberate limitation: a single long-running dev server whose
// log grows past 1 MB is only rotated on its NEXT spawn, not mid-run.
function logFdFor(host) {
  const file = path.join(LOGS_DIR, `${host}.log`);
  try {
    rotateIfNeeded(file);
    return fs.openSync(file, 'a');
  } catch (err) {
    log(`spawn: cannot open log fd for ${host}: ${err.message}`);
    return 'ignore';
  }
}

function tailLog(host, lines = 40) {
  const file = path.join(LOGS_DIR, `${host}.log`);
  try {
    const data = fs.readFileSync(file, 'utf8');
    const all = data.split('\n');
    return all.slice(-lines).join('\n');
  } catch {
    return '(no log output captured)';
  }
}

// Infer the dependency-install command from the FIRST token of startCmd.
//   pnpm dev    -> pnpm install
//   npm run dev -> npm install
//   yarn dev    -> yarn install
//   bun dev     -> bun install
//   (anything else / empty) -> npm install
function inferInstallCmd(startCmd) {
  const first = String(startCmd || '').trim().split(/\s+/)[0] || '';
  switch (first) {
    case 'pnpm':
      return 'pnpm install';
    case 'yarn':
      return 'yarn install';
    case 'bun':
      return 'bun install';
    case 'npm':
    default:
      return 'npm install';
  }
}

// Run the install step for a project whose node_modules is missing. Streams to
// logs/<host>.log, has its own timeout, and resolves true ONLY on exit code 0.
// On non-zero/timeout it kills the install process and resolves false.
function runInstall(project, r) {
  const host = project.host;
  const installCmd = inferInstallCmd(project.startCmd);
  return new Promise((resolve) => {
    const logFd = logFdFor(host);
    log(`install: ${host} -> sh -c '${installCmd}' (cwd=${project.dir})`);
    let child;
    try {
      child = spawn('sh', ['-c', installCmd], {
        cwd: project.dir,
        env: {
          ...process.env,
          PORT: String(project.port),
          FORCE_COLOR: '1',
          BROWSER: 'none',
          NEXT_TELEMETRY_DISABLED: '1',
        },
        detached: true, // group leader -> kill -pid kills the whole install tree
        stdio: ['ignore', logFd, logFd],
      });
    } catch (err) {
      if (typeof logFd === 'number') {
        try {
          fs.closeSync(logFd);
        } catch {
          /* ignore */
        }
      }
      log(`install-spawn-error: ${host}: ${err.message}`);
      return resolve(false);
    }

    if (typeof logFd === 'number') {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
    }

    // Track the install child so a shutdown/stop can reach it.
    r.child = child;
    r.pid = child.pid;
    r.owned = true;

    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      log(`install-timeout: ${host} exceeded ${config.installTimeoutMs}ms -> SIGKILL`);
      killGroup(r, 'SIGKILL');
      finish(false);
    }, config.installTimeoutMs);

    child.on('error', (err) => {
      log(`install-error: ${host}: ${err.message}`);
      finish(false);
    });
    child.on('exit', (code, signal) => {
      log(`install-exit: ${host} pid=${child.pid} code=${code} signal=${signal}`);
      finish(code === 0);
    });
  });
}

// Idempotent, concurrency-safe. Returns the runtime state object.
async function ensureUp(project) {
  const host = project.host;
  const r = getRuntime(host);
  r.project = project;

  // If a start is already in flight, share it.
  if (r.startPromise) {
    await r.startPromise;
    return r;
  }

  // Already known running with a live owned child? done.
  if (r.state === 'running' && r.owned && r.child && r.child.exitCode === null) {
    return r;
  }

  // Claim the bring-up mutex synchronously — BEFORE any await — so N concurrent
  // requests to a cold project share ONE promise instead of each spawning its
  // own dev server (which then collide on the project's fixed port). The port
  // probe and the adopt-or-spawn decision all live inside this closure; there
  // must be no `await` between the `r.startPromise` check above and this line.
  r.startPromise = (async () => {
    // Fresh attempt — clear any failure recorded by a previous bring-up so the
    // status page doesn't show stale wording while this one is in flight.
    r.lastError = null;
    // Probe the port (both loopback families). If something is already
    // listening, decide whether to adopt it (do NOT spawn) by verifying the
    // listener's working directory. All of this runs inside the mutex closure.
    const openHost = await probePort(project.port, 300);
    if (openHost) {
      // Our own live child re-probed: keep it (no ownership check needed).
      if (r.owned && r.child && r.child.exitCode === null) {
        r.upstreamHost = openHost;
        r.state = 'running';
        r.conflictDir = null;
        return;
      }
      // External listener: verify ownership by cwd before adopting. A dev server
      // you started by hand FROM the project dir is yours (matching cwd); a
      // stray process squatting the port is not.
      const cwd = resolvePidCwd(project.port); // null when lsof unavailable/unresolved
      if (cwd === null) {
        // Cannot determine cwd (lsof missing, etc.) -> degrade to the legacy
        // adopt rather than blocking a possibly-legitimate server.
        log(`adopt: ${host} port ${project.port} busy, cwd unresolved -> adopting (external, unverified)`);
        r.upstreamHost = openHost;
        r.state = 'running';
        r.owned = false;
        r.child = null;
        r.pid = null;
        r.conflictDir = null;
        return;
      }
      if (sameDir(cwd, project.dir)) {
        log(`adopt: ${host} external listener cwd matches ${project.dir} -> adopting`);
        r.upstreamHost = openHost;
        r.state = 'running';
        r.owned = false;
        r.child = null;
        r.pid = null;
        r.conflictDir = null;
        return;
      }
      // Mismatch: someone else owns this port. Do NOT proxy — surface a visible
      // conflict and reject so no caller ever pipes a request to the foreigner.
      log(`conflict: ${host} port ${project.port} held by process in ${cwd} (expected ${project.dir}) -> conflict`);
      r.state = 'conflict';
      r.owned = false;
      r.child = null;
      r.pid = null;
      r.upstreamHost = null;
      r.conflictDir = cwd; // remember foreign cwd for status/dashboard detail
      const e = new Error('portConflict');
      e.code = 'PORT_CONFLICT';
      e.host = host;
      e.conflictDir = cwd;
      throw e; // rejects startPromise -> handleRequest/handleUpgrade/up never proxy
    }

    // Need to spawn. Install (if needed) and start are ONE atomic operation, so
    // a second concurrent request never launches a second install.
    // First start with no deps installed -> install them before starting.
    // Only Node projects get an install step: "no node_modules" means nothing
    // in a project that has no package.json (a static folder, a Python
    // server), and forcing `npm install` there fails and blocks the start.
    const nodeModules = path.join(project.dir, 'node_modules');
    const packageJson = path.join(project.dir, 'package.json');
    if (!fs.existsSync(nodeModules) && fs.existsSync(packageJson)) {
      r.state = 'installing';
      const ok = await runInstall(project, r);
      if (!ok) {
        // Install failed/timed out — runInstall already killed it on timeout,
        // but a non-zero exit leaves the child reaped; make sure the group dies.
        killGroup(r, 'SIGKILL');
        r.state = 'stopped';
        r.owned = false;
        r.child = null;
        r.pid = null;
        const e = new Error('installFailed');
        e.code = 'START_TIMEOUT'; // route through the existing 502-with-log page
        e.host = host;
        // Record before throwing: handleRequest no longer awaits us on the cold
        // path, so the status page reads r.lastError after startPromise clears.
        r.lastError = { code: e.code, message: e.message, at: Date.now() };
        throw e;
      }
    }

    const logFd = logFdFor(host);
    log(`start: ${host} -> sh -c '${project.startCmd}' (cwd=${project.dir}, PORT=${project.port})`);
    let child;
    try {
      child = spawn('sh', ['-c', project.startCmd], {
        cwd: project.dir,
        env: {
          ...process.env,
          PORT: String(project.port),
          FORCE_COLOR: '1',
          BROWSER: 'none',
          NEXT_TELEMETRY_DISABLED: '1',
        },
        detached: true, // own process-group leader -> kill -pid kills the group
        stdio: ['ignore', logFd, logFd],
      });
    } catch (err) {
      if (typeof logFd === 'number') {
        try {
          fs.closeSync(logFd);
        } catch {
          /* ignore */
        }
      }
      r.state = 'stopped';
      r.owned = false;
      r.child = null;
      r.pid = null;
      throw err;
    }

    // We hold the fd open via the child's stdio; close our copy.
    if (typeof logFd === 'number') {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
    }

    r.child = child;
    r.pid = child.pid;
    r.owned = true;
    r.state = 'starting';

    child.on('exit', (code, signal) => {
      log(`exit: ${host} pid=${child.pid} code=${code} signal=${signal}`);
      // Only flip to stopped if this is still the active child.
      if (r.child === child) {
        r.state = 'stopped';
        r.child = null;
        r.pid = null;
        r.owned = false;
      }
    });
    child.on('error', (err) => {
      log(`spawn-error: ${host}: ${err.message}`);
    });

    // Ready means OUR child opened the port. waitForPort alone can't tell whose
    // listener answered: if the child dies before the port opens and a foreign
    // process (say, another test run's dev server on the same fixed port) is
    // listening, the bare wait would mark the project running/owned with a dead
    // pid — then every proxy ECONNREFUSEDs once the foreigner leaves, wedged in
    // 'running'. So race the wait against the child's exit and treat any exit
    // before the port opens — nonzero OR zero — as a failed start; a child that
    // daemonizes and exits breaks stop/reap ownership anyway. Pre-existing
    // listeners are still adopted, cwd-verified, by the probe BEFORE the spawn.
    const exitedBeforeReady = new Promise((_resolve, reject) => {
      child.once('exit', (code, signal) => {
        const e = new Error(
          `dev server exited (code=${code}, signal=${signal}) before opening 127.0.0.1:${project.port}`
        );
        e.code = 'START_EXITED';
        e.exitCode = code;
        e.signal = signal;
        reject(e);
      });
    });

    try {
      const upHost = await Promise.race([
        waitForPort(project.port, config.startTimeoutMs),
        exitedBeforeReady,
      ]);
      r.upstreamHost = upHost; // pin the family that answered (Vite -> ::1)
      r.state = 'running';
      r.owned = true;
      log(`ready: ${host} listening on ${upHost}:${project.port}`);
    } catch (err) {
      const exited = err && err.code === 'START_EXITED';
      if (exited) {
        // The 'exit' handler above already flipped the record to stopped and
        // cleared child/pid; sweep group stragglers via the child's own pgid
        // (killGroup reads r.pid, which is null by now).
        log(`start-failed: ${host} ${err.message}`);
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* group already gone */
        }
      } else {
        // Start timed out — kill the whole group and surface logs to the caller.
        log(`start-timeout: ${host} did not open :${project.port} within ${config.startTimeoutMs}ms`);
        killGroup(r, 'SIGKILL');
      }
      r.state = 'stopped';
      r.owned = false;
      r.child = null;
      r.pid = null;
      const e = new Error(exited ? err.message : 'startTimeout');
      e.code = exited ? 'START_EXITED' : 'START_TIMEOUT';
      e.host = host;
      if (exited) {
        e.exitCode = err.exitCode;
        e.signal = err.signal;
      }
      // Record before throwing (see install-failed site): the cold status page
      // reads r.lastError after startPromise clears in the finally below.
      r.lastError = { code: e.code, message: e.message, at: Date.now() };
      throw e;
    }
  })();

  try {
    await r.startPromise;
  } finally {
    r.startPromise = null;
  }
  return r;
}

function killGroup(r, signal) {
  const pid = r.pid;
  if (!pid) return;
  try {
    // negative pid => the whole process group (child is group leader via detached)
    process.kill(-pid, signal);
  } catch {
    // group gone or single process — try the bare pid
    try {
      process.kill(pid, signal);
    } catch {
      /* already dead */
    }
  }
}

// Stop an OWNED project. No-op (with reason) for external / already-stopped.
function stop(host, reason = 'manual') {
  const r = runtime.get(host);
  if (!r) return { ok: false, reason: 'unknown host' };
  if (!r.owned || !r.pid) {
    return { ok: false, reason: 'not owned by lazydev' };
  }
  const pid = r.pid;
  log(`stop: ${host} (pid group ${pid}, ${reason}) -> SIGTERM`);
  killGroup(r, 'SIGTERM');
  // Escalate to SIGKILL if still alive after 5s. unref() so this lone timer can
  // never keep the process alive on its own — the daemon stays up via its
  // listeners in production, and a test that stop()s a child shouldn't have to
  // wait out this timer to exit.
  const escalate = setTimeout(() => {
    try {
      // signal 0 = liveness check
      process.kill(-pid, 0);
      log(`stop: ${host} still alive after 5s -> SIGKILL`);
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* already gone */
    }
  }, 5000);
  escalate.unref?.();
  r.state = 'stopped';
  r.owned = false;
  r.child = null;
  r.pid = null;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function htmlPage(title, bodyInner) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         margin: 0; padding: 3rem 1.5rem; max-width: 860px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: #1115; padding: 1rem; border-radius: 8px; overflow:auto; font-size: 12.5px; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  ul { padding-left: 1.2rem; }
  .muted { opacity: 0.65; }
</style></head><body>${bodyInner}</body></html>`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function availableList() {
  const items = config.projects
    .filter((p) => p.enabled)
    .map((p) => `<li><a href="${esc(frontUrl(p.host))}/">${esc(frontUrl(p.host))}</a> <span class="muted">(${esc(p.framework || 'node')})</span></li>`)
    .join('');
  return `<ul>${items || '<li class="muted">no enabled projects</li>'}</ul>`;
}

function sendHtml(res, status, title, inner) {
  const body = htmlPage(title, inner);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Small JSON bodies for control POSTs. Resolves null (never rejects) on bad
// JSON, oversize, or a broken stream, so callers can treat all three as one
// "no usable body" case.
function readJsonBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > limit) {
        resolve(null);
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// Decide whether a cold-hit request should get the HTML status page (a human in
// a browser navigating) or a plain 503 (curl / XHR / webhook that wants data).
// A real navigation sets Sec-Fetch-Mode: navigate; failing that, the request is
// HTML only if Accept asks for text/html and did NOT lead with application/json
// (curl sends */*, fetch/XHR that wants JSON leads with application/json).
function wantsHtml(req) {
  const sfm = String((req.headers && req.headers['sec-fetch-mode']) || '').toLowerCase();
  if (sfm === 'navigate') return true;
  const accept = String((req.headers && req.headers['accept']) || '');
  const first = accept.split(',')[0].trim().toLowerCase();
  return /text\/html/i.test(accept) && !first.startsWith('application/json');
}

// Map the runtime `state` (the source of truth) to a human phase word for the
// status page. 'failed' is state==='stopped' WITH a recorded lastError; a plain
// 'stopped' before the first probe reads as 'waking'.
function phaseLabel(r) {
  if (r.state === 'installing') return 'installing';
  if (r.state === 'starting') return 'starting';
  if (r.state === 'stopped' && r.lastError) return 'failed';
  return 'waking';
}

// Self-refreshing HTML served on a cold navigation hit. Names the project + its
// phase, tails the install/start log, and — unless the start already failed —
// polls the SAME url with Accept: application/json and reloads once that stops
// returning 503 (i.e. the port answered and the request proxied to the app).
// `r` may be the live runtime record OR a {state, lastError} snapshot taken by
// handleRequest before it re-kicked bring-up; only those two fields are read.
//
// Log tails and the raw failure message can leak filesystem paths, so they are
// shown ONLY to an authorized caller (same-origin + capability token). An
// ordinary browser navigation carries no token, so `authorized` is false and the
// page redacts the log, pointing the user at `lazydev logs <host>` instead.
function statusPageHtml(project, r, authorized = false) {
  const host = project.host;
  const phase = phaseLabel(r);
  // Either the real log tail (authorized) or a redaction notice pointing at the
  // CLI, which reads the log locally where the token isn't needed.
  const logBlock = (lines) =>
    authorized
      ? `<p>Last lines of <code>logs/${esc(host)}.log</code>:</p><pre>${esc(tailLog(host, lines))}</pre>`
      : `<p class="muted">Log output is hidden. Check it with <code>lazydev logs ${esc(host)}</code>.</p>`;
  if (phase === 'failed') {
    // The raw error message can leak paths too — redact it for the unauthorized.
    const reason = authorized
      ? (r.lastError && (r.lastError.message || r.lastError.code)) || 'unknown error'
      : 'The dev server failed to start.';
    // Terminal page: no auto-refresh. Mirror the START_TIMEOUT copy so wording
    // stays consistent, and offer a manual retry link to the same URL.
    return htmlPage(
      `${host} — failed to start`,
      `<h1>${esc(host)} failed to start</h1>
       <p>The dev server did not open <code>127.0.0.1:${project.port}</code> within ${Math.round(config.startTimeoutMs / 1000)}s.</p>
       <p class="muted">${esc(reason)}</p>
       ${logBlock(40)}
       <p><a href="${esc('/')}">Retry</a></p>${dashboardHomeLink()}`
    );
  }
  // Non-terminal: waking / installing / starting. A minimal centered card — a
  // spinner, one line of copy, and a way back — plus a poll loop that hands off
  // to the app without a manual reload once the port answers.
  const phraseByPhase = {
    installing: 'Installing dependencies, then starting the dev server.',
    starting: 'The dev server is being turned on.',
    waking: 'The dev server is being turned on.',
  };
  return htmlPage(
    `${host} — ${phase}`,
    `<style>
       .wake { min-height: calc(100vh - 6rem); display: flex; flex-direction: column;
               align-items: center; justify-content: center; text-align: center; gap: 0.25rem; }
       .spinner { width: 34px; height: 34px; border-radius: 50%; margin-bottom: 1.25rem;
                  border: 3px solid #8884; border-top-color: #2563eb;
                  animation: wake-spin 0.8s linear infinite; }
       @keyframes wake-spin { to { transform: rotate(360deg); } }
       @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
       .back { display: inline-block; margin-top: 1.75rem; padding: 0.45rem 1.1rem;
               border: 1px solid #8886; border-radius: 8px; }
       .back:hover { text-decoration: none; background: #8881; }
     </style>
     <div class="wake">
       <div class="spinner" aria-hidden="true"></div>
       <h1>${esc(host)}</h1>
       <p class="muted">${phraseByPhase[phase] || phraseByPhase.waking} This page opens the app automatically once it&#39;s ready.</p>
       <a class="back" href="${esc(frontUrl('lazydev'))}/">&larr; Back to dashboard</a>
     </div>
     <noscript><meta http-equiv="refresh" content="2"></noscript>
     <script>
       // Poll the same URL asking for JSON: while bringing up, handleRequest
       // returns 503; once the port answers the request proxies to the app and
       // the status is no longer 503 — that edge is our cue to reload.
       setInterval(async () => {
         try {
           const res = await fetch(location.href, { headers: { 'accept': 'application/json' }, cache: 'no-store' });
           if (res.status !== 503) location.reload();
         } catch (e) { /* daemon momentarily unreachable; keep polling */ }
       }, 1000);
     </script>`
  );
}

// Cold-hit answer for non-navigation clients (curl / XHR / webhook): a plain
// 503 with Retry-After and NO HTML body, so simple clients keep retrying and
// the status-page poll gets its 503 signal.
function sendRetry(res, project, r) {
  res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' });
  res.end(phaseLabel(r) + '\n');
}

// Terminal answer for a port CONFLICT: the project's port is held by a foreign
// process (a dev server started from some OTHER directory). We must never proxy
// to it and never invite a retry, so this is a hard 502 — NOT the transient 503.
// A browser navigation gets an HTML explanation; curl/XHR gets a plain 502. The
// foreign cwd is a filesystem path, so it is shown only to an authorized caller
// (same-origin + token); an ordinary navigation gets it redacted.
function sendConflict(req, res, project, r, authorized = false) {
  const host = project.host;
  const dir = r && r.conflictDir;
  if (wantsHtml(req)) {
    const detail = authorized && dir
      ? `<p class="muted">Port <code>${project.port}</code> is held by a process running in <code>${esc(dir)}</code>, not <code>${esc(project.dir)}</code>.</p>`
      : `<p class="muted">Its port is held by another process that lazydev did not start. Stop that process, or point this project at a free port.</p>`;
    return sendHtml(
      res,
      502,
      `lazydev — ${host} port conflict`,
      `<h1>${esc(host)} has a port conflict</h1>
       <p>lazydev refused to proxy: something else is already listening on <code>127.0.0.1:${project.port}</code> and it was not started from this project's directory.</p>
       ${detail}${dashboardHomeLink()}`
    );
  }
  res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('port conflict\n');
}

// True only for loopback: IPv4 127.0.0.0/8, IPv6 ::1, and IPv4-mapped IPv6 like
// ::ffff:127.0.0.1. Everything else (LAN IPs, 0.0.0.0, '', undefined) is false.
// Used to fail-closed on any request that did not arrive on a loopback bind.
function isLoopbackAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  let a = addr;
  // Strip an IPv4-mapped IPv6 prefix so ::ffff:127.0.0.1 is judged as 127.0.0.1.
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) a = mapped[1];
  if (a === '::1') return true;
  // IPv4 127.0.0.0/8
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) return Number(m[1]) === 127;
  return false;
}

// ---------------------------------------------------------------------------
// Control-plane authorization: capability token + same-origin check
// ---------------------------------------------------------------------------

// The token authorizes every mutating control action (reload / stop / up) and
// the log-tail exposure on error pages. It is minted lazily — never at import
// time — so a bare `import` in a unit test writes nothing to disk unless that
// test opts in by calling ensureControlToken().
let CONTROL_TOKEN = null;
function ensureControlToken() {
  if (CONTROL_TOKEN) return CONTROL_TOKEN;
  // Reuse a token already on disk (survives daemon restarts so open CLI/tabs
  // keep working); otherwise mint one.
  try {
    const existing = fs.readFileSync(CONTROL_TOKEN_PATH, 'utf8').trim();
    if (existing) {
      CONTROL_TOKEN = existing;
      return CONTROL_TOKEN;
    }
  } catch {
    /* not present yet */
  }
  const tok = crypto.randomBytes(32).toString('hex');
  try {
    ensureDir(path.dirname(CONTROL_TOKEN_PATH));
    fs.writeFileSync(CONTROL_TOKEN_PATH, tok + '\n', { mode: 0o600 });
    try {
      fs.chmodSync(CONTROL_TOKEN_PATH, 0o600);
    } catch {
      /* ignore */
    }
  } catch (err) {
    log(`control-token: could not persist to ${CONTROL_TOKEN_PATH} (${err.message}); using in-memory token`);
  }
  CONTROL_TOKEN = tok;
  return CONTROL_TOKEN;
}

// A control request is same-origin when it has NO Origin header (non-browser
// caller, e.g. the CLI) OR its Origin host matches the daemon's own Host header.
// A foreign Origin (some other site's page POSTing here) is refused. CSRF only
// applies to browser-driven cross-site requests; the CLI is not a browser, so
// the token alone is its proof.
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / CLI — no browser Origin to forge
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const selfHost = String(req.headers.host || '').toLowerCase();
  return originHost.toLowerCase() === selfHost;
}

// Authorized == same-origin AND correct token. Both are required for every
// mutating control action and for exposing log tails on error pages.
function isControlAuthorized(req) {
  if (!isSameOrigin(req)) return false;
  const tok = req.headers['x-lazydev-token'];
  return typeof tok === 'string' && tok.length > 0 && tok === ensureControlToken();
}

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

function liveState(host, project) {
  const r = runtime.get(host);
  const la = lastAccess.get(host) || 0;
  let state = r ? r.state : 'stopped';
  let owned = r ? r.owned : false;
  return {
    host,
    url: frontUrl(host),
    port: project.port,
    enabled: project.enabled !== false,
    framework: project.framework || 'node',
    state,
    owned,
    conflict: state === 'conflict',
    conflictDir: r ? r.conflictDir || null : null,
    lastAccess: la || null,
    idleForMs: la ? Date.now() - la : null,
    connCount: connCount(host),
    activeConnCount: activeConnCount(host, Date.now()),
  };
}

function statusPayload() {
  return {
    uptimeMs: Date.now() - STARTED_AT,
    idleTimeoutMs: config.idleTimeoutMs,
    projects: config.projects.map((p) => liveState(p.host, p)),
  };
}

async function handleControl(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  // Dashboard home (host key === lazydev, path /)
  if (method === 'GET' && (pathname === '/' || pathname === '')) {
    return sendHtml(res, 200, 'lazydev', dashboardHtml());
  }

  if (method === 'GET' && pathname === '/__lazydev/status') {
    return sendJson(res, 200, statusPayload());
  }

  // One guard for every mutating control action: reject any POST /__lazydev/*
  // that is not both same-origin AND carrying the capability token. GET / and
  // GET /__lazydev/status stay ungated so the CLI's read path and the dashboard
  // load keep working; neither exposes anything sensitive.
  if (method === 'POST' && pathname.startsWith('/__lazydev/') && !isControlAuthorized(req)) {
    return sendJson(res, 403, { ok: false, reason: 'unauthorized' });
  }

  if (method === 'POST' && pathname === '/__lazydev/reload') {
    const ok = loadConfig('control:reload');
    return sendJson(res, ok ? 200 : 500, { ok });
  }

  if (method === 'POST' && pathname.startsWith('/__lazydev/stop/')) {
    const host = decodeURIComponent(pathname.slice('/__lazydev/stop/'.length));
    const result = stop(host, 'control');
    return sendJson(res, 200, result);
  }

  if (method === 'POST' && pathname.startsWith('/__lazydev/up/')) {
    const host = decodeURIComponent(pathname.slice('/__lazydev/up/'.length));
    const project = projectByHost(host);
    if (!project) return sendJson(res, 404, { ok: false, reason: 'unknown host' });
    if (project.enabled === false) return sendJson(res, 409, { ok: false, reason: 'disabled' });
    try {
      await ensureUp(project);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 502, { ok: false, reason: err.code || err.message });
    }
  }

  // Rename a project: the dashboard's inline editor POSTs { to }. The daemon
  // rewrites the registry file itself because that file is the single source
  // of truth — a rename that only touched in-memory state would be undone by
  // the next reload, and a later rescan preserves the new name through the
  // ordinary host-merge path.
  if (method === 'POST' && pathname.startsWith('/__lazydev/rename/')) {
    const from = decodeURIComponent(pathname.slice('/__lazydev/rename/'.length));
    const body = await readJsonBody(req);
    const to = body && typeof body.to === 'string' ? body.to.trim() : '';
    const project = projectByHost(from);
    if (!project) return sendJson(res, 404, { ok: false, reason: 'unknown host' });
    // Same shape sanitizeHost produces: a DNS label, lowercase.
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(to)) {
      return sendJson(res, 400, { ok: false, reason: 'lowercase letters, digits, and hyphens only' });
    }
    if (to === 'lazydev') return sendJson(res, 400, { ok: false, reason: '"lazydev" is the dashboard' });
    if (to === from) return sendJson(res, 200, { ok: true, host: to });
    if (projectByHost(to)) return sendJson(res, 409, { ok: false, reason: `"${to}" is taken` });
    // The runtime record is keyed by host, so an owned running server is
    // stopped and the next hit on the new URL is an ordinary cold start.
    // stop() no-ops (with reason) for external/stopped — exactly right here.
    stop(from, 'rename');
    let reg;
    try {
      reg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      return sendJson(res, 500, { ok: false, reason: 'could not read the registry' });
    }
    const entry = Array.isArray(reg.projects) ? reg.projects.find((p) => p.host === from) : null;
    if (!entry) return sendJson(res, 500, { ok: false, reason: 'host missing from the registry file' });
    entry.host = to;
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(reg, null, 2) + '\n');
    } catch (err) {
      return sendJson(res, 500, { ok: false, reason: 'could not write the registry' });
    }
    runtime.delete(from);
    lastAccess.delete(from);
    loadConfig('control:rename');
    log(`rename: ${from} -> ${to}`);
    return sendJson(res, 200, { ok: true, host: to });
  }

  // GET requests to /__lazydev/* that aren't matched, or anything else.
  return sendHtml(res, 404, 'lazydev — not found', `<h1>lazydev</h1><p class="muted">No such control endpoint: <code>${esc(method)} ${esc(pathname)}</code></p>${dashboardHomeLink()}`);
}

function dashboardHomeLink() {
  return `<p><a href="${esc(frontUrl('lazydev'))}/">&larr; lazydev dashboard</a></p>`;
}

// Badge classes live in dashboardHtml's <style>; the poll script rebuilds the
// same markup client-side, so label/class logic changed here must change there.
function stateBadge(state, owned) {
  const known = ['running', 'starting', 'installing', 'conflict'];
  const k = state === 'running' && !owned ? 'external' : known.includes(state) ? state : 'stopped';
  const label = k === 'external' ? 'running (external)' : k === 'stopped' ? 'sleeping' : k;
  return `<span class="badge b-${k}">${label}</span>`;
}

// Framework marks: colored chips with the glyph inlined as SVG, because the
// dashboard is a single self-contained response — no assets, no CDN; the
// "nothing leaves this machine" rule covers the UI too. Letter chips where a
// faithful brand path isn't worth the bytes; the text label next to the chip
// carries the name either way.
function frameworkIcon(fw) {
  const chip = (bg, inner) =>
    `<svg class="fwicon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect width="20" height="20" rx="5" fill="${bg}"/>${inner}</svg>`;
  const letter = (bg, text, fg = '#fff') => {
    const size = text.length > 1 ? 9 : 11;
    return chip(bg, `<text x="10" y="${(10 + size * 0.36).toFixed(1)}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-weight="700" font-size="${size}" fill="${fg}">${esc(text)}</text>`);
  };
  switch (fw) {
    case 'next': return letter('#000', 'N');
    case 'vite': return chip('#646cff', '<path d="M11.5 3 5.5 11h4l-1 6 6-8h-4z" fill="#fff"/>');
    case 'cra': return chip('#23272f', '<g fill="none" stroke="#61dafb"><ellipse cx="10" cy="10" rx="7" ry="2.8"/><ellipse cx="10" cy="10" rx="7" ry="2.8" transform="rotate(60 10 10)"/><ellipse cx="10" cy="10" rx="7" ry="2.8" transform="rotate(120 10 10)"/></g><circle cx="10" cy="10" r="1.4" fill="#61dafb"/>');
    case 'astro': return letter('#7c3aed', 'A');
    case 'remix': return letter('#3992ff', 'R');
    case 'sveltekit': return letter('#ff3e00', 'S');
    case 'rails': return letter('#cc0000', 'R');
    case 'django': return letter('#092e20', 'dj', '#44b78b');
    case 'node': return chip('#5fa04e', '<path d="M10 4l5.2 3v6L10 16l-5.2-3V7z" fill="none" stroke="#fff" stroke-width="1.4"/>');
    case 'static': return chip('#64748b', '<g stroke="#fff" stroke-width="1.4" stroke-linecap="round"><path d="M6 7h8M6 10h8M6 13h5"/></g>');
    default: return letter('#64748b', String(fw || '?').slice(0, 1).toUpperCase());
  }
}

function fmtIdle(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function dashboardHtml() {
  // The dashboard is served same-origin, so injecting the control token into its
  // inline script is safe: the browser's same-origin policy stops other sites
  // reading this HTML. The switches and the rename editor send it back as a
  // header, which authorizes their POSTs. JSON.stringify escapes it for JS use.
  const token = ensureControlToken();
  const rows = config.projects
    .map((p) => {
      const ls = liveState(p.host, p);
      const on = ls.state === 'running' || ls.state === 'starting' || ls.state === 'installing';
      // The switch is inert where flipping it couldn't work: a disabled project
      // (enable it in the registry), a port conflict, and an external server
      // lazydev didn't start and therefore can't stop.
      const locked = !ls.enabled || ls.state === 'conflict' || (ls.state === 'running' && !ls.owned);
      const lockReason = !ls.enabled ? 'disabled in the registry'
        : ls.state === 'conflict' ? 'resolve the port conflict first'
        : ls.state === 'running' && !ls.owned ? 'started outside lazydev' : '';
      // On conflict, hovering the state cell explains which foreign cwd holds it.
      const stateTitle = ls.state === 'conflict' && ls.conflictDir
        ? ` title="port held by ${esc(ls.conflictDir)}"`
        : '';
      return `<tr data-host="${esc(p.host)}">
        <td class="c-proj"><a href="${esc(frontUrl(p.host))}/">${esc(frontUrl(p.host))}</a>${ls.enabled ? '' : ' <span class="muted">(disabled)</span>'} <button class="edit" title="rename" aria-label="rename ${esc(p.host)}" onclick="editHost(this)">&#9998;</button></td>
        <td class="c-fw">${frameworkIcon(ls.framework)} ${esc(ls.framework)}</td>
        <td class="c-state"${stateTitle}>${stateBadge(ls.state, ls.owned)}</td>
        <td class="c-idle">${ls.state === 'running' ? fmtIdle(ls.idleForMs) : '—'}</td>
        <td class="c-conn">${ls.connCount}</td>
        <td><label class="switch"${lockReason ? ` title="${lockReason}"` : ''}><input type="checkbox" role="switch" aria-label="run ${esc(p.host)}"${on ? ' checked' : ''}${locked ? ' disabled' : ''} onchange="toggleHost(this)"><span class="track"></span></label></td>
      </tr>`;
    })
    .join('');

  return `<pre class="logo" role="img" aria-label="lazydev">${esc(LOGO.join('\n'))}</pre>
  <p class="muted">On-demand local dev proxy · uptime <span id="uptime">${fmtIdle(Date.now() - STARTED_AT)}</span> · idle sleep after ${Math.round(config.idleTimeoutMs / 60000)}m</p>
  <style>
    .logo { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
            line-height: 1.25; color: #0891b2; background: none; padding: 0;
            margin: 0 0 0.35rem; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { text-align: left; padding: 0.5rem 0.7rem; border-bottom: 1px solid #8884; }
    th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
    .badge { color: #fff; padding: 2px 8px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
    .b-running { background: #16a34a; } .b-external { background: #0891b2; }
    .b-starting { background: #d97706; } .b-installing { background: #7c3aed; }
    .b-conflict { background: #dc2626; } .b-stopped { background: #64748b; }
    .c-fw { white-space: nowrap; }
    .fwicon { vertical-align: -3px; margin-right: 2px; }
    .switch { position: relative; display: inline-block; width: 40px; height: 22px; vertical-align: middle; }
    .switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
    .switch .track { position: absolute; inset: 0; border-radius: 999px; background: #8885;
                     transition: background .15s; pointer-events: none; }
    .switch .track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
                            border-radius: 50%; background: #fff; box-shadow: 0 1px 2px #0003;
                            transition: transform .15s; }
    .switch input:checked + .track { background: #16a34a; }
    .switch input:checked + .track::after { transform: translateX(18px); }
    .switch input:disabled { cursor: default; }
    .switch input:disabled + .track { opacity: .35; }
    .switch input:focus-visible + .track { outline: 2px solid #2563eb; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .switch .track, .switch .track::after { transition: none; } }
    .edit { border: none; background: none; cursor: pointer; opacity: 0; font: inherit; padding: 0 4px; color: inherit; }
    tr:hover .edit, .edit:focus-visible { opacity: .55; }
    .edit:hover { opacity: 1; }
    .rename { font: inherit; width: 12ch; padding: 1px 6px; border: 1px solid #8886;
              border-radius: 6px; background: transparent; color: inherit; }
    .rename.bad { border-color: #dc2626; outline: none; }
  </style>
  <table>
    <thead><tr><th>Project</th><th>Framework</th><th>State</th><th>Idle</th><th>Conn</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="muted">No projects registered.</td></tr>'}</tbody>
  </table>
  <script>
    const TOKEN = ${JSON.stringify(token)};
    const ON_STATES = ['running', 'starting', 'installing'];
    // host -> { on, at }: what the user just asked for, so the poll doesn't
    // snap the switch back before the daemon's state catches up.
    const pending = new Map();

    // Mirrors the server's stateBadge — change both together.
    function badgeHtml(state, owned) {
      const known = ['running', 'starting', 'installing', 'conflict'];
      const k = state === 'running' && !owned ? 'external' : known.includes(state) ? state : 'stopped';
      const label = k === 'external' ? 'running (external)' : k === 'stopped' ? 'sleeping' : k;
      return '<span class="badge b-' + k + '">' + label + '</span>';
    }

    function fmtIdle(ms) {
      if (ms == null) return '—';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm';
      const h = Math.floor(m / 60);
      return h + 'h ' + (m % 60) + 'm';
    }

    function toggleHost(input) {
      const row = input.closest('tr');
      const host = row.dataset.host;
      const on = input.checked;
      pending.set(host, { on, at: Date.now() });
      // The switch itself already flipped (native checkbox); reflect it in the
      // badge immediately and let the poll settle the truth.
      row.querySelector('.c-state').innerHTML = badgeHtml(on ? 'starting' : 'stopped', true);
      fetch('/__lazydev/' + (on ? 'up/' : 'stop/') + encodeURIComponent(host), {
        method: 'POST',
        headers: { 'X-Lazydev-Token': TOKEN },
      }).catch(() => {});
    }

    function editHost(btn) {
      const td = btn.closest('td');
      const host = btn.closest('tr').dataset.host;
      if (td.querySelector('.rename')) return;
      const saved = td.innerHTML;
      td.innerHTML = '';
      const input = document.createElement('input');
      input.className = 'rename';
      input.value = host;
      input.setAttribute('aria-label', 'new name');
      const suffix = document.createElement('span');
      suffix.className = 'muted';
      suffix.textContent = '.localhost';
      td.append(input, suffix);
      input.focus();
      input.select();
      const bail = () => { td.innerHTML = saved; };
      input.onblur = () => setTimeout(() => { if (td.querySelector('.rename') === input) bail(); }, 150);
      input.onkeydown = async (e) => {
        if (e.key === 'Escape') return bail();
        if (e.key !== 'Enter') { input.classList.remove('bad'); return; }
        const to = input.value.trim();
        if (to === host) return bail();
        if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(to) || to === 'lazydev') {
          input.classList.add('bad');
          input.title = 'lowercase letters, digits, and hyphens';
          return;
        }
        try {
          const res = await fetch('/__lazydev/rename/' + encodeURIComponent(host), {
            method: 'POST',
            headers: { 'X-Lazydev-Token': TOKEN, 'content-type': 'application/json' },
            body: JSON.stringify({ to }),
          });
          const j = await res.json();
          if (j.ok) { location.reload(); return; }
          input.classList.add('bad');
          input.title = j.reason || 'rename failed';
        } catch (err) {
          input.classList.add('bad');
          input.title = 'daemon unreachable';
        }
      };
    }

    async function poll() {
      try {
        const res = await fetch('/__lazydev/status', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        document.getElementById('uptime').textContent = fmtIdle(data.uptimeMs);
        for (const p of data.projects) {
          const row = document.querySelector('tr[data-host="' + CSS.escape(p.host) + '"]');
          if (!row || row.querySelector('.rename')) continue;
          const on = ON_STATES.includes(p.state);
          const pend = pending.get(p.host);
          if (pend && Date.now() - pend.at < 10000 && on !== pend.on) continue;
          pending.delete(p.host);
          row.querySelector('.c-state').innerHTML = badgeHtml(p.state, p.owned);
          row.querySelector('.c-idle').textContent = p.state === 'running' ? fmtIdle(p.idleForMs) : '—';
          row.querySelector('.c-conn').textContent = p.connCount;
          const sw = row.querySelector('.switch input');
          if (sw && document.activeElement !== sw) {
            sw.checked = on;
            sw.disabled = !p.enabled || p.state === 'conflict' || (p.state === 'running' && !p.owned);
          }
        }
      } catch (err) { /* daemon momentarily unreachable; keep polling */ }
    }
    setInterval(poll, 2000);
  </script>`;
}

// ---------------------------------------------------------------------------
// Reverse proxy (HTTP)
// ---------------------------------------------------------------------------

// Order the loopback families to try: the one we detected first, the other as
// fallback. `::1` must be passed as the `host` option (never embedded in a URL
// string) so Node connects over IPv6 correctly.
function loopbackOrder(preferred) {
  if (preferred === '::1') return ['::1', '127.0.0.1'];
  if (preferred === '127.0.0.1') return ['127.0.0.1', '::1'];
  return [...LOOPBACK_HOSTS];
}

// Keep-alive pool for upstream connections. Reusing sockets is the right call
// for a local proxy (asset bursts, HMR polling) — but ONLY because we now pipe
// the request immediately below. The previous version gated `req.pipe()` on the
// socket's 'connect' event; a pooled (already-connected) socket never re-emits
// 'connect', so every reused request stalled until the upstream's ~5s
// keepAliveTimeout closed it. That was the "weirdly slow" bug.
const upstreamAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 256 });

function proxyHttp(req, res, project) {
  const host = project.host;
  const r = runtime.get(host);

  // Count the client SOCKET once, not per request: a browser holds a keep-alive
  // socket open across navigations (often with zero in-flight requests) — those
  // are exactly the "live tab" sockets the reaper must defer to. Guard with a
  // symbol so a reused socket doesn't add a second record (only one 'close'
  // fires, so per-request counting would inflate the count and leak records).
  const cs = req.socket;
  if (cs && !cs[CONN_TRACKED]) {
    cs[CONN_TRACKED] = true;
    const rec = addConn(host);
    cs.__lazydevRec = rec;
    cs.once('close', () => removeConn(host, rec));
    // A single 'data' listener keeps lastByteAt fresh on real traffic; a truly
    // silent keep-alive socket ages past the hard cap and stops deferring.
    cs.on('data', () => {
      rec.lastByteAt = Date.now();
    });
  }
  if (cs && cs.__lazydevRec) cs.__lazydevRec.lastByteAt = Date.now();

  // ensureUp() already probed both loopback families and pinned the one that
  // answered (Vite -> ::1, Next -> 127.0.0.1), so we proxy straight to it — no
  // per-request family race, which lets us pipe the body immediately.
  const upHost = (r && r.upstreamHost) || loopbackOrder(r && r.upstreamHost)[0];

  const upstream = http.request(
    {
      host: upHost,
      port: project.port,
      method: req.method,
      path: req.url,
      headers: req.headers, // preserve original Host header for multi-tenant apps
      agent: upstreamAgent,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
      upRes.on('error', () => {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      });
    }
  );

  upstream.on('error', (err) => {
    log(`proxy-error: ${host}: ${err.code || err.message} on ${upHost}:${project.port}`);

    // Adopt-then-die heal. An ADOPTED upstream (owned=false, no child) that
    // dies leaves nothing to flip the record: the exit handler only covers
    // children we spawned, so state stays 'running' and every request lands
    // here — a 502 forever, wedged until a daemon restart. A connection-level
    // failure with no live owned child behind the record means the "running"
    // claim is stale: drop it and kick a fresh bring-up, which re-probes the
    // port (re-adopting if something answered after all — a false trip costs
    // one probe) or respawns. Guarded on the owned child precisely because a
    // live child's blips are its exit handler's business, and healing there
    // would spawn a second process group behind a healthy server.
    const gone = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EPIPE';
    const ownedAlive = r && r.owned && r.child && r.child.exitCode === null;
    if (gone && r && r.state === 'running' && !ownedAlive) {
      log(`heal: ${host} adopted upstream on ${upHost}:${project.port} is gone -> stopped + fresh bring-up`);
      r.state = 'stopped';
      r.owned = false;
      r.child = null;
      r.pid = null;
      r.upstreamHost = null;
      r.lastError = { code: err.code, message: `upstream ${upHost}:${project.port} stopped answering`, at: Date.now() };
      if (!r.startPromise) ensureUp(project).catch(() => {});
      if (!res.headersSent) {
        // Answer like the cold path so the browser self-recovers: the status
        // page polls until the fresh bring-up lands, then reloads into the app.
        if (wantsHtml(req)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(statusPageHtml(project, { state: 'starting' }, isControlAuthorized(req)));
        } else {
          sendRetry(res, project, { state: 'starting' });
        }
      } else {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (!res.headersSent) {
      sendHtml(
        res,
        502,
        'lazydev — upstream error',
        `<h1>Upstream connection failed</h1>
         <p>Could not reach <code>${esc(host)}</code> on <code>${esc(upHost)}:${project.port}</code>.</p>
         <p class="muted">${esc(err.message)}</p>${dashboardHomeLink()}`
      );
    } else {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
  });

  req.on('error', () => {
    try {
      upstream.destroy();
    } catch {
      /* ignore */
    }
  });

  // Pipe immediately — correct for BOTH a fresh socket and a pooled
  // already-connected one. (Piping also calls upstream.end() when req ends,
  // which flushes bodyless GETs.)
  req.pipe(upstream);
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

// Every loopback listener we bind under RUN_AS_MAIN, so shutdown() can close
// them all (127.0.0.1 primary + ::1 best-effort).
const daemonServers = [];

// Build a daemon HTTP server: the request try/catch wrapper plus the upgrade
// (WebSocket/HMR) handler, both fail-closed against non-loopback binds. Called
// once per loopback listener under RUN_AS_MAIN, and directly by the self-test.
function createDaemonServer() {
  const srv = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (err) {
      log(`request-handler crash: ${err && err.stack ? err.stack : err}`);
      try {
        if (!res.headersSent) {
          sendHtml(res, 500, 'lazydev — error', `<h1>Internal error</h1><pre>${esc(String(err && err.message))}</pre>`);
        } else {
          res.destroy();
        }
      } catch {
        /* ignore */
      }
    }
  });

  srv.on('upgrade', (req, clientSocket, head) => {
    handleUpgrade(req, clientSocket, head).catch((err) => {
      log(`upgrade-handler crash: ${err && err.message}`);
      try {
        clientSocket.destroy();
      } catch {
        /* ignore */
      }
    });
  });

  return srv;
}

async function handleRequest(req, res) {
  // Fail-closed: only serve requests that arrived on a loopback address. Even if
  // a listener ends up bound to a routable interface, a request from off-box is
  // rejected here rather than reaching the control plane or a dev server.
  if (!isLoopbackAddress(req.socket && req.socket.localAddress)) {
    log(`forbidden: non-loopback request on ${req.socket && req.socket.localAddress}`);
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden\n');
    return;
  }

  const hostHeader = req.headers.host || '';
  noteRenderPort(hostHeader);
  const key = resolveHostKey(hostHeader);
  // Parse URL relative to a dummy base; we only need pathname.
  const url = new URL(req.url, 'http://localhost');

  // Control plane: key === lazydev OR path starts with /__lazydev/.
  // Control plane: the lazydev host, a host naming no project (bare localhost
  // or an IP literal — serve the dashboard rather than a 502), or /__lazydev/.
  if (key === 'lazydev' || key === null || url.pathname.startsWith('/__lazydev/')) {
    return handleControl(req, res, url);
  }

  const project = projectByHost(key);
  if (!project) {
    return sendHtml(
      res,
      502,
      'lazydev — no such project',
      `<h1>No project for <code>${esc(key)}</code></h1>
       <p>Nothing is registered under that host. Available projects:</p>${availableList()}`
    );
  }

  if (project.enabled === false) {
    return sendHtml(
      res,
      404,
      'lazydev — disabled',
      `<h1>${esc(project.host)} is disabled</h1>
       <p class="muted">This project is marked <code>enabled: false</code> in the registry.</p>${dashboardHomeLink()}`
    );
  }

  const r = getRuntime(project.host);

  // Warm path: the project is running AND a probe/adopt already pinned the
  // family that answered. upstreamHost is the honest "port answered" signal, so
  // this is the only case where we proxy straight through (WS/HMR keep working).
  if (r.state === 'running' && r.upstreamHost) {
    lastAccess.set(project.host, Date.now());
    return proxyHttp(req, res, project);
  }

  // A prior bring-up found the port held by a foreign process (cwd mismatch).
  // A conflict is TERMINAL, not transient — never proxy to the foreigner and
  // never tell the client to retry. Surface it as a 502 straight away.
  if (r.state === 'conflict') {
    return sendConflict(req, res, project, r, isControlAuthorized(req));
  }

  // Cold path.
  //
  // Snapshot the phase + failure reason BEFORE kicking a fresh attempt below,
  // because kicking ensureUp synchronously clears r.lastError (fresh-attempt
  // reset) — so a page rendered off the live record after the kick would never
  // show the failure that just occurred. The snapshot is what a slow-path client
  // sees; the kick starts a new bring-up behind it so a reload lands on the app.
  const snapshot = { state: r.state, lastError: r.lastError };

  // Kick bring-up in the background exactly once. ensureUp claims r.startPromise
  // synchronously before any await (the #9cb548a fix), so kicking it here yields
  // exactly ONE child for N concurrent hits. The .catch is MANDATORY: a
  // start-timeout / conflict rejection would otherwise surface as an
  // unhandledRejection. lastError is recorded inside ensureUp before it throws,
  // so swallowing the rejection here loses nothing.
  if (!r.startPromise) {
    ensureUp(project).catch(() => {});
  }
  // Wait only a GRACE window for the attempt to settle — long enough for the
  // fast decisions (adopt an already-listening server, or reject as a port
  // conflict: a local probe + a synchronous lsof) but NOT for a real
  // spawn+startup, which must stay non-blocking (a cold nav answers <200ms,
  // never ~startTimeout). The timer firing leaves the attempt mid-flight.
  if (r.startPromise) {
    await Promise.race([
      r.startPromise.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, COLD_SETTLE_GRACE_MS)),
    ]);
  }

  // Adopt settled within the grace -> the port answered; proxy straight through.
  if (r.state === 'running' && r.upstreamHost) {
    lastAccess.set(project.host, Date.now());
    return proxyHttp(req, res, project);
  }
  // Conflict settled within the grace -> terminal 502, never proxy.
  if (r.state === 'conflict') {
    return sendConflict(req, res, project, r, isControlAuthorized(req));
  }

  // Still bringing up (or the fresh attempt already failed): answer immediately
  // and let the client (or the status page's poll) drive the retry, rendering
  // from the PRE-KICK snapshot so a reload after a failure shows that failure.

  // Navigation (browser) -> self-refreshing status page (200 so the browser
  // renders it and runs the poll script instead of showing its own error UI).
  // A failed start renders the failure reason + log tail in that same page, but
  // only for an authorized caller — an ordinary navigation carries no token, so
  // the log/error is redacted (see statusPageHtml).
  if (wantsHtml(req)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(statusPageHtml(project, snapshot, isControlAuthorized(req)));
    return;
  }

  // Everything else (curl / XHR / webhook, including the status page's own poll)
  // -> plain 503 with Retry-After, no HTML. Also covers the failed state: keep
  // it 503 so simple clients keep retrying; the failure detail is for humans.
  return sendRetry(res, project, snapshot);
}

// ---------------------------------------------------------------------------
// WebSocket / HMR upgrade proxy
// ---------------------------------------------------------------------------

async function handleUpgrade(req, clientSocket, head) {
  // Fail-closed: same loopback gate as handleRequest, for WS/HMR upgrades.
  if (!isLoopbackAddress(clientSocket && clientSocket.localAddress)) {
    log(`forbidden upgrade: non-loopback on ${clientSocket && clientSocket.localAddress}`);
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    return;
  }

  const hostHeader = req.headers.host || '';
  noteRenderPort(hostHeader);
  const key = resolveHostKey(hostHeader);

  // Never proxy the control plane over websockets.
  if (key === 'lazydev') {
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    return;
  }

  const project = key ? projectByHost(key) : null;
  if (!project || project.enabled === false) {
    try {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    await ensureUp(project);
  } catch (err) {
    try {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    return;
  }

  lastAccess.set(project.host, Date.now());

  // Connect to the upstream over the detected loopback family (Vite -> ::1),
  // with sequential fallback to the other family on connection failure.
  const r = runtime.get(project.host);
  const hosts = loopbackOrder(r && r.upstreamHost);

  let upstream;
  try {
    let connectErr;
    for (const upHost of hosts) {
      try {
        upstream = await connectOnce(upHost, project.port, 3000);
        if (r) r.upstreamHost = upHost; // remember the family that worked
        break;
      } catch (err) {
        connectErr = err;
      }
    }
    if (!upstream) throw connectErr || new Error('no loopback family accepted');
  } catch (err) {
    log(`ws-connect-error: ${project.host}: ${err.message}`);
    try {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    return;
  }

  // Count this WS/HMR socket as one live connection. The record is created here,
  // after the upstream connected, so a failed-connect path above never leaks one.
  // teardown runs on 'error'/'close'/'end' of either socket; Set.delete is
  // idempotent, so removeConn is safe to call more than once.
  const rec = addConn(project.host);

  const teardown = () => {
    removeConn(project.host, rec);
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    try {
      upstream.destroy();
    } catch {
      /* ignore */
    }
  };

  upstream.on('error', (err) => {
    log(`ws-upstream-error: ${project.host}: ${err.message}`);
    teardown();
  });
  upstream.on('close', teardown);
  upstream.on('end', teardown);
  clientSocket.on('error', teardown);
  clientSocket.on('close', teardown);
  // A closed browser tab FIN-half-closes its HMR socket. Because the upstream
  // pipe keeps the socket's writable side open, 'close' never fires — so without
  // also tearing down on 'end', the record (and the socket pair) would leak and
  // the connection would keep deferring the reaper forever. Reap on either FIN.
  clientSocket.on('end', teardown);

  // Socket is already connected — replay the original request line + headers.
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  const h = req.rawHeaders;
  for (let i = 0; i < h.length; i += 2) {
    lines.push(`${h[i]}: ${h[i + 1]}`);
  }
  upstream.write(lines.join('\r\n') + '\r\n\r\n');
  if (head && head.length) upstream.write(head);

  // Bidirectional pipe.
  clientSocket.pipe(upstream);
  upstream.pipe(clientSocket);

  // Bump keeps both the idle clock (lastAccess) and this connection's byte clock
  // (rec.lastByteAt) fresh, so an actively-used HMR socket keeps deferring the
  // reaper while a silent one ages past the hard cap.
  const bump = () => {
    const t = Date.now();
    lastAccess.set(project.host, t);
    rec.lastByteAt = t;
  };
  clientSocket.on('data', bump);
  upstream.on('data', bump);
}

// ---------------------------------------------------------------------------
// Idle reaper
// ---------------------------------------------------------------------------

function reapIdle() {
  const now = Date.now();
  for (const project of config.projects) {
    const host = project.host;
    const r = runtime.get(host);
    if (!r) continue;
    // Only reap things WE started (adoption sets owned=false), so an external /
    // adopted dev server is never touched no matter how idle it looks.
    if (r.state !== 'running' || !r.owned) continue;
    // A live tab or active HMR socket (bytes within the hard cap) defers the
    // reap. A socket silent past connectionHardCapMs drops out of `active`, so an
    // abandoned tab stops protecting the project — it does NOT gate byte activity.
    const active = activeConnCount(host, now);
    if (active > 0) continue;
    const la = lastAccess.get(host) || 0;
    if (la === 0) continue; // never accessed; leave it
    const idle = now - la;
    if (idle > config.idleTimeoutMs) {
      const mins = Math.round(idle / 60000);
      const result = stop(host, 'idle');
      if (result.ok) {
        log(`slept ${host} (idle ${mins}m)`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Signals & global error handling — the daemon must never die.
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

process.on('SIGHUP', () => {
  log('SIGHUP -> reloading config');
  try {
    loadConfig('SIGHUP');
  } catch (err) {
    log(`SIGHUP reload failed: ${err.message}`);
  }
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig} -> stopping all owned children`);
  for (const [host, r] of runtime.entries()) {
    if (r.owned && r.pid) {
      killGroup(r, 'SIGTERM');
      log(`shutdown: SIGTERM ${host} (pid group ${r.pid})`);
    }
  }
  // Give children a moment to exit, then go.
  setTimeout(() => {
    for (const srv of daemonServers) {
      try {
        srv.close();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  }, 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Only auto-boot when run directly (e.g. via launchd / CLI). When imported by a
// unit test, skip listening so pure helpers (inferInstallCmd, connectLoopback…)
// can be exercised without occupying :4000 or spawning anything.
const RUN_AS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_AS_MAIN) {
  loadConfig('boot');
  // Mint (or reuse) the control token before the first request, so the file
  // exists for the CLI to read and the dashboard HTML can embed it.
  ensureControlToken();
  startConfigWatch();
  // Reaper cadence is 30s in production. LAZYDEV_REAP_INTERVAL_MS exists solely so
  // the bundled self-test can exercise the idle reaper quickly (same spirit as the
  // LAZYDEV_CONFIG override). Production never sets it.
  const REAP_INTERVAL_MS = Number(process.env.LAZYDEV_REAP_INTERVAL_MS) || 30_000;
  setInterval(reapIdle, REAP_INTERVAL_MS).unref?.();

  // The numbered port to fall back to when the front-door port cannot be bound.
  // On the npx path the front door is :80; macOS grants an unprivileged process
  // that bind, Linux does not (no CAP_NET_BIND_SERVICE), so a plain `npx lazydev`
  // on Linux gets EACCES and lands here. EADDRINUSE (port already held) falls back
  // the same way. LAZYDEV_FALLBACK_PORT exists so the npx path and the self-test
  // can force the fallback deterministically (same spirit as LAZYDEV_CONFIG).
  const FALLBACK_PORT = Number(process.env.LAZYDEV_FALLBACK_PORT) || 4000;

  // Bind ONE loopback family+port. Resolves { server } on listen, rejects with
  // the bind error (its .code intact) on failure — the one-time error/listening
  // pair is removed on whichever fires, so the surviving error handler below is
  // the only one left for later runtime errors.
  const bindOne = (server, host, port) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

  // Serve the front door directly (no Caddy). One bind rule on every platform
  // (ADR 0002): the wildcard address on the front-door port, loopback-only
  // enforced per connection — off-box connections are destroyed at accept,
  // and handleRequest/handleUpgrade fail closed on top of that. A wildcard
  // bind is the one :80 a non-root process gets on macOS, it is dual-stack
  // (no separate ::1 listener), and the guard makes it exactly as private as
  // a loopback bind. When the OS refuses the port (Linux without the
  // capability, or something already holds it), fall back to the numbered
  // port, same rule.
  const bindFrontDoor = async (server) => {
    try {
      await bindOne(server, undefined, config.port);
      return config.port;
    } catch (err) {
      const code = (err && err.code) || (err && err.message);
      const d = decideBindFallback({ attemptedPort: config.port, errorCode: err && err.code, fallbackPort: FALLBACK_PORT });
      if (!d.fallback) {
        log(`FATAL: could not bind :${config.port} (${code}); exiting`);
        process.exit(1);
      }
      log(`note: :${config.port} unavailable (${code}); falling back to :${d.port}`);
      try {
        await bindOne(server, undefined, d.port);
        return d.port;
      } catch (err2) {
        log(`FATAL: could not bind :${d.port} on fallback (${(err2 && err2.code) || (err2 && err2.message)}); exiting`);
        process.exit(1);
      }
    }
  };

  (async () => {
    const server = createDaemonServer();
    daemonServers.push(server);
    // Destroy any connection that is not from loopback before a byte is read.
    server.on('connection', (sock) => {
      if (!isLoopbackAddress(sock.remoteAddress)) sock.destroy();
    });

    const servePort = await bindFrontDoor(server);
    activePort = servePort;
    // Later runtime errors must not crash the daemon.
    server.on('error', (err) => log(`server error: ${err && err.message}`));

    log(`lazydev listening on :${servePort}, loopback-only enforced per connection (config=${CONFIG_PATH})`);
    log(`dashboard: ${frontUrl('lazydev')}/`);
    for (const p of config.projects) {
      if (p && p.enabled !== false) log(`  ${frontUrl(p.host)}`);
    }
  })();
}

// ---------------------------------------------------------------------------
// Self-test accessors
// ---------------------------------------------------------------------------
// The bundled node --test suite drives the reaper deterministically without
// RUN_AS_MAIN (which would listen and set the 30s interval). These expose just
// enough state to force ownership, inject connection presence, and age the idle
// clock — the raw Maps stay encapsulated. Prefixed `__` to signal test-only,
// matching the LAZYDEV_CONFIG / LAZYDEV_REAP_INTERVAL_MS self-test hooks.

// Force runtime fields on a host (e.g. {state:'running', owned:true,
// upstreamHost:'127.0.0.1'}). Needed because adoption forces owned=false, so a
// test that must exercise the REAP path cannot get owned=true via a real GET.
function __setRuntimeForTest(host, patch) {
  Object.assign(getRuntime(host), patch);
  return runtime.get(host);
}

// Inject a live-connection record and return it, so a test can age its
// lastByteAt into the past to synthesize a "silent past the hard cap" socket.
function __addConnForTest(host) {
  return addConn(host);
}

// Drive the idle clock directly for the pure-reaper unit test.
function __setLastAccessForTest(host, ms) {
  lastAccess.set(host, ms);
}

// Snapshot the connection counters for assertions: total live vs. deferring.
function __liveConnInfo(host) {
  return { count: connCount(host), active: activeConnCount(host, Date.now()) };
}

// Exported for the bundled self-test (no behavior change for the daemon itself).
// upstreamAgent is exposed so a test can destroy its pooled keep-alive sockets
// on teardown (they'd otherwise keep the test process from exiting). log,
// logFdFor, and LOGS_DIR are exposed (with the LAZYDEV_LOGS_DIR override) so a
// test can prove the daemon rotates through its real logging call sites.
export {
  resolveHostKey,
  loadConfig,
  inferInstallCmd,
  connectLoopback,
  probePort,
  LOOPBACK_HOSTS,
  createDaemonServer,
  isLoopbackAddress,
  wantsHtml,
  phaseLabel,
  statusPageHtml,
  getRuntime,
  ensureUp,
  stop,
  upstreamAgent,
  reapIdle,
  __setRuntimeForTest,
  __addConnForTest,
  __setLastAccessForTest,
  __liveConnInfo,
  ensureControlToken,
  isSameOrigin,
  isControlAuthorized,
  CONTROL_TOKEN_PATH,
  sameDir,
  __setResolvePidCwd,
  rotateIfNeeded,
  log,
  logFdFor,
  LOGS_DIR,
  // #9 — npx front door: state-dir resolution + bind fallback. Re-exported from
  // their libs so a test importing ../lazydev.mjs reaches the same helpers the
  // daemon uses, and STATE_DIR/CONFIG_PATH expose what this module resolved.
  resolveStateDir,
  resolveStatePaths,
  decideBindFallback,
  formatProjectUrl,
  STATE_DIR,
  CONFIG_PATH,
};
