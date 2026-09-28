#!/usr/bin/env node
// xerb — on-demand local dev-server proxy daemon.
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
// The WebSocket server half, built-ins only (spec section 6). Aliased on import
// because this file already has a handleUpgrade: that one is the HMR proxy for
// project hosts, this one completes a handshake on the control plane.
import { handleUpgrade as wsAccept, isWebSocketUpgrade } from './lib/ws.mjs';
// Every registry WRITE in this file goes through these, because the dashboard
// and the `xerb add/remove/enable/disable/port/rename` subcommands must not
// drift: one module owns what a valid entry is, and the daemon only decides
// when to call it. (The terminal logo lives in lib/ui.mjs and stays there —
// the dashboard draws its own word mark; see dashboardHtml.)
import {
  RegistryError,
  addEntry,
  removeEntry,
  renameEntry,
  setEnabled,
  setPort,
  setStartCmd,
  readRegistry,
  writeRegistry,
  pickPort,
  portListening,
  sanitizeHost,
  expandTilde,
  detectOne,
  startCmdFor,
  DETECTOR_EVIDENCE,
  STATIC_PLACEHOLDER,
  archiveEntry,
  restoreEntry,
} from './lib/registry-cli.mjs';
import {
  viewablesRoot,
  isViewable,
  isArchived,
  tagViewables,
  archiveDays,
  lastSeen,
  dueForArchive,
  newestFileTime,
  readOpened,
  writeOpened,
  trashFolder,
} from './lib/viewables.mjs';

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
// logs, and daemon travel together. (Was hardcoded to ~/.config/xerb before
// centralizing.)
const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));

// One state directory holds the registry, logs, and control token. When
// XERB_STATE_DIR is set (the npx entrypoint sets it), all three derive from
// it, so an npx run and a persistent install share one layout. When it is NOT
// set, the state dir IS CONFIG_DIR — the existing next-to-script layout — so an
// installed daemon and every existing self-test are unchanged.
//
// preferXdg stays false here: the daemon must not silently relocate an existing
// install to ~/.local/state on a bare boot. The npx path opts into the XDG
// default by resolving it (bin/xerb.mjs) and exporting XERB_STATE_DIR
// before this module loads.
const STATE_DIR = resolveStateDir({ env: process.env, home: os.homedir(), scriptDir: CONFIG_DIR, preferXdg: false });

// The three state paths. Each still honors its OWN override env var
// (XERB_CONFIG / XERB_LOGS_DIR / XERB_CONTROL_TOKEN_PATH) so every
// existing self-test hook keeps pointing its file at a temp dir; the per-path
// override wins over the derived-from-state-dir default. The control token
// defaults next to the registry, so a test that points XERB_CONFIG at a temp
// file also gets an isolated token beside it.
const { configPath: CONFIG_PATH, logsDir: LOGS_DIR, tokenPath: CONTROL_TOKEN_PATH } = resolveStatePaths({ env: process.env, stateDir: STATE_DIR });
const DAEMON_LOG = path.join(LOGS_DIR, 'daemon.log');
// When each viewable was last opened, beside the registry rather than in it:
// a page view is not a registry edit, and writing projects.json on every
// visit would fire the config watch each time. See lib/viewables.mjs.
const OPENED_PATH = path.join(path.dirname(CONFIG_PATH), 'opened.json');
const VIEWABLES_ROOT = viewablesRoot();

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
// deleted out from under us. `xerb uninstall` removes the whole state dir;
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

// XERB_QUIET=1 keeps the terminal clean: log lines go to daemon.log only.
// The npx entrypoint sets it — it prints its own short banner, and the
// timestamped stream stays available in the state dir. FATAL lines still hit
// stderr so a failed boot is never silent.
const QUIET = process.env.XERB_QUIET === '1';

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
// opened[host] = epoch ms a viewable was last requested. Persisted to
// OPENED_PATH by the reaper tick (at most every 30s), not per request.
let opened = {};
let openedDirty = false;
function noteOpened(host, now = Date.now()) {
  opened[host] = now;
  openedDirty = true;
}
function flushOpened() {
  if (!openedDirty) return;
  try {
    writeOpened(OPENED_PATH, opened);
    openedDirty = false;
  } catch (err) {
    log(`viewables: could not save ${OPENED_PATH} (${err.code || err.message})`);
  }
}
// connections[host] = Set of live connection records { lastByteAt }. A record is
// one proxied keep-alive HTTP socket or one WS/HMR upgrade; `lastByteAt` is the
// last time a byte crossed in either direction. `set.size` is the live count the
// user sees; the reaper only counts records whose silence is within the hard cap.
const connections = new Map();
// Guard so a keep-alive HTTP socket carrying many requests is counted ONCE (add
// a record on first request, decrement on socket close), not once per request.
const CONN_TRACKED = Symbol('xerbConnTracked');

function projectByHost(host) {
  return config.projects.find((p) => p.host === host);
}

function getRuntime(host) {
  let r = runtime.get(host);
  if (!r) {
    // lastError persists on the record after startPromise clears, so the cold
    // status page can read WHY a background bring-up failed (see ensureUp). Its
    // `kind` is the closed set the failure copy switches on: 'exited',
    // 'timeout', 'dir-missing', 'install-failed', 'conflict'. phase is derived
    // from `state` by phaseLabel(); we keep a slot but state is truth.
    // conflictDir holds the foreign cwd when a port-conflict is detected on adopt.
    // installFailed remembers a dependency install that already failed on this
    // record, so a reload does not pay installTimeoutMs again (see ensureUp).
    // adoptedPid is the pid that held the port when we ADOPTED it (owned=false);
    // verifiedAt is when we last confirmed that pid still holds it. Together they
    // are the re-verification the adopt path used to lack — see
    // verifyAdoptedUpstream(). Both stay null/0 for a server we spawned ourselves.
    // pty holds the two writable ends of the terminal the dev server runs in
    // ({ stdin, resize }, null when it runs on plain pipes). It lives on the
    // record rather than inside a socket handler so a panel that stays open
    // across a restart types into the NEW child (see attachTermSocket).
    // stopSeq counts deliberate stops. ensureUp reads it before it spawns and
    // again if the bring-up fails: a different value means WE killed the child,
    // so the failure is the stop, not something to paint red (see ensureUp).
    r = { state: 'stopped', owned: false, child: null, pid: null, startPromise: null, upstreamHost: null, lastError: null, phase: null, conflictDir: null, installFailed: null, adoptedPid: null, verifiedAt: 0, pty: null, stopSeq: 0 };
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

// ---------------------------------------------------------------------------
// Static sites: the registry holds a placeholder, not a path
// ---------------------------------------------------------------------------

// STATIC_PLACEHOLDER is what a static-folder project stores as its startCmd.
// It is defined in lib/registry-cli.mjs, with the writers, and imported here
// because this is the only module that resolves it: the old scanner wrote
// `python3 "<abs path>/serve_static.py"`, and under npx that path lives in
// ~/.npm/_npx/<hash>/, which npm prunes whenever it feels like it, and the
// entry then dies with an ENOENT no one can read. The placeholder survives,
// because it is resolved against the xerb.mjs that is running right now.

// Expand the placeholder to the command that actually runs. serve_static.py
// ships next to this file, so CONFIG_DIR is the answer wherever the checkout
// sits (npx cache, <state>/app, a clone). Quoted: the npx cache path can
// contain spaces. Anything else is returned untouched.
//
// The match is the WHOLE command, not a substring: `$XERB_STATIC` inside a
// longer command would also be expanded by `sh -c` (to the empty string, since
// it is not in the environment), so a half-expansion would be a trap. One
// project, one placeholder, one command.
function expandStartCmd(startCmd) {
  const cmd = String(startCmd || '').trim();
  if (cmd !== STATIC_PLACEHOLDER) return startCmd;
  return `python3 "${path.join(CONFIG_DIR, 'serve_static.py')}"`;
}

// True for the forms older versions wrote: the absolute path from the old
// scanner (with or without the quotes it wrapped the path in), and the
// placeholder as it was spelled when xerb was lazydev.
function isLegacyStaticCmd(startCmd) {
  const cmd = String(startCmd || '').trim();
  return cmd === '$LAZYDEV_STATIC' || /serve_static\.py"?\s*$/.test(cmd);
}

// Rewrite every legacy absolute-path static startCmd in a parsed registry to
// the placeholder, in place. Returns the number of entries changed.
function rewriteStaticStartCmds(parsed) {
  if (!Array.isArray(parsed?.projects)) return 0;
  let changed = 0;
  for (const entry of parsed.projects) {
    if (entry && isLegacyStaticCmd(entry.startCmd)) {
      entry.startCmd = STATIC_PLACEHOLDER;
      changed += 1;
    }
  }
  return changed;
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
  // Migrate the pruned-path static entries the old scanner wrote, and save the
  // file back so the fix outlives this process. This runs on every load but
  // writes at most once per stale registry: the rewrite is idempotent, so the
  // fs.watch event our own write fires reloads, finds nothing left ending in
  // serve_static.py, and stops there. A write we cannot do (read-only state
  // dir) is logged and otherwise ignored: the in-memory registry is already
  // correct, so the project still starts, it just gets migrated again next boot.
  const rewritten = rewriteStaticStartCmds(parsed);
  // Same idempotent write-back for viewables registered before the tag existed.
  const tagged = tagViewables(parsed, VIEWABLES_ROOT);
  if (rewritten + tagged > 0) {
    try {
      fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(parsed, null, 2)}\n`);
      if (rewritten) log(`config: rewrote ${rewritten} static startCmd(s) to ${STATIC_PLACEHOLDER} in ${CONFIG_PATH}`);
      if (tagged) log(`config: tagged ${tagged} entr${tagged === 1 ? 'y' : 'ies'} under ${VIEWABLES_ROOT} as viewable`);
    } catch (err) {
      log(`config: could not save the registry migration to ${CONFIG_PATH} (${err.code || err.message})`);
    }
  }
  // XERB_PORT forces the listen port regardless of what the registry says.
  // The npx entrypoint sets it to 80 to serve the front door directly; applying
  // it HERE (not just once at boot) keeps the override across config reloads
  // (SIGHUP / control:reload) instead of snapping back to the registry's port.
  // Production install leaves it unset, so the registry's port wins as before.
  const envPort = Number(process.env.XERB_PORT);
  const next = {
    port: Number.isFinite(envPort) && envPort > 0
      ? envPort
      : (Number.isFinite(parsed.port) ? parsed.port : DEFAULTS.port),
    idleTimeoutMs: Number.isFinite(parsed.idleTimeoutMs) ? parsed.idleTimeoutMs : DEFAULTS.idleTimeoutMs,
    startTimeoutMs: Number.isFinite(parsed.startTimeoutMs) ? parsed.startTimeoutMs : DEFAULTS.startTimeoutMs,
    installTimeoutMs: Number.isFinite(parsed.installTimeoutMs) ? parsed.installTimeoutMs : DEFAULTS.installTimeoutMs,
    connectionHardCapMs: Number.isFinite(parsed.connectionHardCapMs) ? parsed.connectionHardCapMs : DEFAULTS.connectionHardCapMs,
    viewableArchiveDays: archiveDays(parsed),
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

// Dev-mode source watch, for installs that run a git checkout directly: the
// plist sets XERB_WATCH_SOURCE=1 and launchd's KeepAlive restarts whatever
// exits, so "reload on change" is just "exit on change". Owned dev servers go
// down with the daemon: each one's terminal is a pair of pipes this process
// holds, so a survivor would come back adopted as external with a panel that
// can never show or send anything, and its pty.py dies of EPIPE on the dev
// server's next line of output anyway. The next request starts it fresh.
function startSourceWatch() {
  if (process.env.XERB_WATCH_SOURCE !== '1') return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  let t = null;
  const kick = (file) => {
    if (t) clearTimeout(t);
    // Debounced past the editor's write burst; ThrottleInterval in the plist
    // keeps a pathological loop from thrashing launchd.
    t = setTimeout(() => {
      log(`source: ${file || 'a file'} changed; exiting so launchd restarts with the new code`);
      shutdown('source change');
    }, 300);
  };
  for (const target of [path.join(here, 'xerb.mjs'), path.join(here, 'lib')]) {
    try {
      const w = fs.watch(target, (ev, file) => kick(file || path.basename(target)));
      w.on('error', () => { /* watch died; the next install re-arms it */ });
    } catch {
      /* missing target — nothing to watch */
    }
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

// Resolve the PID of the process LISTENing on `port`, via lsof (macOS).
// Returns a positive number, or null when it cannot be determined (lsof
// missing/ENOENT, non-zero exit, timeout, or unparseable output). NEVER throws.
function defaultResolveListenerPid(port) {
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
        const pid = Number(line.slice(1).trim());
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Resolve the working directory of the process LISTENing on `port`. Returns
// the cwd string, or null for "unknown" — ensureUp degrades to the legacy
// adopt instead of blocking, and freePort refuses to kill. NEVER throws. Two
// -F (field) queries: the listening PID first, then that PID's cwd descriptor.
function defaultResolvePidCwd(port) {
  const pid = defaultResolveListenerPid(port);
  if (!pid) return null;
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
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
// spirit as XERB_CONFIG / XERB_REAP_INTERVAL_MS) and never spawn lsof.
// ensureUp calls through this binding, so the setter must reassign it in place.
let resolvePidCwd = defaultResolvePidCwd;
function __setResolvePidCwd(fn) {
  resolvePidCwd = typeof fn === 'function' ? fn : defaultResolvePidCwd;
}

// Same swap points for freePort: the listener-pid lookup and the kill itself,
// so a test can prove the guards without lsof and without signalling anything.
let resolveListenerPid = defaultResolveListenerPid;
function __setResolveListenerPid(fn) {
  resolveListenerPid = typeof fn === 'function' ? fn : defaultResolveListenerPid;
}
// Bare pid, no process group: the foreigner's group is unknown and could
// contain a shell or editor that must not be touched.
function defaultKillForeign(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    /* already dead */
  }
}
let killForeign = defaultKillForeign;
function __setKillForeign(fn) {
  killForeign = typeof fn === 'function' ? fn : defaultKillForeign;
}

// ---------------------------------------------------------------------------
// Adoption re-verification
// ---------------------------------------------------------------------------

// How long an adoption stays trusted before the listening pid is resolved
// again. The cwd check at adoption is a statement about one process; this is
// how stale that statement is allowed to get. Two seconds is the spec's number:
// long enough that a busy project pays one lsof every two seconds instead of
// one per request, short enough that a stranger on the port is caught on the
// next navigation rather than at the next daemon restart.
const ADOPT_VERIFY_TTL_MS = 2000;

// Forget an adoption. Called wherever a record stops representing an adopted
// listener: it was replaced by a child we own, it became a conflict, it was
// stopped, or its upstream went away.
function clearAdoption(r) {
  if (!r) return;
  r.adoptedPid = null;
  r.verifiedAt = 0;
}

// Gate in front of every proxy to an ADOPTED upstream (owned=false). Returns
// true when the record may be used as-is, false when it was dropped and the
// caller must fall through to the cold path, which re-runs ensureUp and lands
// on adopt, spawn or conflict exactly as a first request would.
//
// The port answering is not proof the server we vetted is still behind it: it
// dies, something from /tmp binds the same port, and pre-fix the daemon kept
// proxying the stranger forever because the cwd check ran once, at adoption.
//
// Cost: `Date.now() - r.verifiedAt < ADOPT_VERIFY_TTL_MS` on the line below is
// the only read of the timestamp, and it returns BEFORE resolveListenerPid is
// reached — so a project serving a hundred requests a second still runs at most
// one lsof per two seconds. test/adopt.test.mjs ('G: ... the 2s cache holds')
// counts the resolver calls across a burst to keep that true.
function verifyAdoptedUpstream(project, r) {
  if (!r || r.state !== 'running' || r.owned) return true; // a child we spawned has an exit handler
  if (!r.adoptedPid) return true; // adopted without a pid (no lsof): nothing to compare against
  const now = Date.now();
  if (now - (r.verifiedAt || 0) < ADOPT_VERIFY_TTL_MS) return true;

  const pid = resolveListenerPid(project.port);
  if (pid === r.adoptedPid) {
    r.verifiedAt = now;
    return true;
  }
  log(
    `adopt-stale: ${project.host} port ${project.port} was pid ${r.adoptedPid}, now ${pid || 'nothing'} -> dropping the record`
  );
  // Drop it the same way the heal path does, then say so. No lastError: the
  // fresh bring-up decides what this is (a re-adopt, a spawn, or a conflict)
  // and records its own failure if it has one.
  r.state = 'stopped';
  r.owned = false;
  r.child = null;
  r.pid = null;
  r.upstreamHost = null;
  r.conflictDir = null;
  clearAdoption(r);
  return false;
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

// The inverse of waitForPort: resolve true once NOTHING answers on the port.
// A restart needs it — SIGTERM returns long before the child lets go of the
// port, and a bring-up that races it would probe, find the dying server, match
// its cwd, and "adopt" a process that is about to exit. Resolves false on
// timeout; the caller carries on and lands on the ordinary conflict path.
async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await probePort(port, 200))) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  return !(await probePort(port, 200));
}

// ---------------------------------------------------------------------------
// Lifecycle: ensureUp / stop
// ---------------------------------------------------------------------------

// Open (append) the per-project log fd. This is the SOLE opener of per-project
// logs — called once per install spawn (runInstall) and once per start spawn
// (ensureUp). The install child still holds it as its own stdout/stderr; the
// start path hands it to a terminal sink instead, because since section 6 the
// dev server's stdout is a tty and the daemon writes the escape-stripped copy
// itself (see makeTermSink). Either way fd-open time is the one choke point the
// daemon controls: we rotate here, capping the log at each spawn/install.
// Deliberate limitation: a single long-running dev server whose log grows past
// 1 MB is only rotated on its NEXT spawn, not mid-run.
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

// The one line the DAEMON writes into a per-project log. Everything else in the
// file is the child's own stdout/stderr, so without this every attempt was
// concatenated onto the last with nothing between them and two `compiling...`
// runs read as one. Written before the fd is handed to the child, at both spawn
// sites (install and start). Rendered exactly as the 0.3.0 spec words it:
//   -- 2026-09-12 17:31:17 . start: npm run dev (PORT=3030) --
// with box-drawing rules and a middle dot, the one place the ASCII-only rule
// for terminal output does not apply (this is a file, read back through the
// terminal panel and `xerb logs`).
const LOG_RULE = '──';
const LOG_DOT = '·';
const SEPARATOR_RE = new RegExp(`^${LOG_RULE} .* ${LOG_RULE}$`);

function isSeparatorLine(line) {
  return SEPARATOR_RE.test(line);
}

function logStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function separatorLine(label, cmd, port) {
  return `${LOG_RULE} ${logStamp()} ${LOG_DOT} ${label}: ${cmd} (PORT=${port}) ${LOG_RULE}`;
}

// Write the separator into an open append fd. `label` is 'start' or 'install'.
// A blank line goes in front whenever the file already has bytes, so a child
// that ended mid-line cannot glue itself onto the rule.
function writeLogSeparator(host, logFd, label, cmd, port) {
  const line = separatorLine(label, cmd, port);
  // The terminal gets the same rule the file gets, so a restart with a panel
  // open draws a line between the run that stopped and the run that started
  // instead of running the two together (the bug section 4 opens with). CRLF:
  // this one is going to a terminal, where a bare LF only moves down a row.
  termEcho(host, `\r\n${line}\r\n`);
  if (typeof logFd !== 'number') return line;
  const file = path.join(LOGS_DIR, `${host}.log`);
  let lead = '';
  try {
    if (fs.statSync(file).size > 0) lead = '\n';
  } catch {
    /* first attempt: no file yet */
  }
  try {
    fs.writeSync(logFd, `${lead}${line}\n`);
  } catch (err) {
    log(`log-separator: ${host}: ${err.message}`);
  }
  return line;
}

// Tail the per-project log. By default only THIS attempt: the lines after the
// last separator, so the terminal panel shows the run that just failed instead
// of the three before it. `all` returns the whole file, separators included,
// which is what `?all=1` on the tail endpoint asks for.
function tailLog(host, lines = 40, { all = false } = {}) {
  const file = path.join(LOGS_DIR, `${host}.log`);
  try {
    const data = fs.readFileSync(file, 'utf8');
    let out = data.split('\n');
    if (!all) {
      for (let i = out.length - 1; i >= 0; i--) {
        if (isSeparatorLine(out[i])) {
          out = out.slice(i + 1);
          break;
        }
      }
    }
    return out.slice(-lines).join('\n');
  } catch {
    return '(no log output captured)';
  }
}

// The one line the dashboard shows next to a failed badge. Prefer a line that
// announces itself as an error; fall back to the last thing the process said,
// because "Killed: 9" with no error keyword is still the answer.
function firstErrorLine(tail) {
  const lines = String(tail || '')
    .split('\n')
    .map((l) => l.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').trim()) // children run with FORCE_COLOR=1
    .filter((l) => l && !isSeparatorLine(l));
  const hit = lines.find((l) => /\b(error|failed|fatal|cannot|unable|not found|refused|ENOENT|EADDRINUSE|EACCES)\b|ERR!/i.test(l));
  return (hit || lines[lines.length - 1] || '').slice(0, 200);
}

// ---------------------------------------------------------------------------
// A terminal per dev server (spec section 6)
// ---------------------------------------------------------------------------

// The reason to install xerb instead of keeping a tab open is that the tab
// is gone, so the tab has to come back on demand, and a log tail is not a tab.
// Next asks "port in use, use 3001 instead? (y/n)", Vite has keyboard
// shortcuts, Rails drops into byebug, and a stack trace without its colors is a
// worse stack trace. All of that needs a real tty behind the dev server.
//
// macOS script(1) refuses a non-tty stdin, so the pty is lib/pty.py, run by the
// python3 that ships with the Xcode command line tools. The daemon keeps
// ordinary pipes on both ends of it:
//
//   stdout  raw terminal bytes -> the ring buffer, every open term socket, and
//           an escape-stripped copy into <host>.log
//   stdin   what someone types in a panel or in `xerb attach`
//   fd 3    one "<rows> <cols>\n" line per resize
const PTY_SCRIPT = path.join(CONFIG_DIR, 'lib', 'pty.py');

// The size the dev server sees until a client resizes it: what the dashboard
// panel opens at, and what pty.py defaults to.
const PTY_ROWS = 24;
const PTY_COLS = 80;

// Per project, the last 256 KB of raw output with the escapes intact: what a
// freshly-opened panel replays. Keyed by host and not cleared on restart, so
// the panel keeps the run that just died above the run that just started.
const TERM_RING_BYTES = 256 * 1024;

// The one line a read-only panel opens with, and the one `xerb status`
// prints when there is no python3. ASCII: it is drawn in a terminal.
const NO_PTY_NOTE = 'no python3, so terminals are read-only: output shows, nothing you type reaches the dev server';
// What a panel says about a dev server somebody else started. ASCII, as above.
const EXTERNAL_TERM_NOTE = 'this dev server was started outside xerb, so its output is in the terminal that started it. Stop it there and xerb starts its own, with a terminal here';

// undefined = never looked, null = looked and there is none.
let ptyPython;

// The interpreter that runs lib/pty.py, or null for the pipe fallback. Resolved
// once and remembered: this is a fact about the machine, and paying a fork per
// wake to re-learn it would be silly. XERB_PYTHON overrides the search, and
// an empty XERB_PYTHON is how a test asks for the fallback path on a machine
// that does have python3.
function ptyInterpreter() {
  if (ptyPython !== undefined) return ptyPython;
  const override = process.env.XERB_PYTHON;
  if (typeof override === 'string') {
    ptyPython = override.trim() || null;
  } else if (!fs.existsSync(PTY_SCRIPT)) {
    // A checkout without lib/pty.py (a partial package, an old <state>/app) is
    // the same situation as a machine without python: pipes, read-only panel.
    ptyPython = null;
  } else {
    ptyPython = null;
    // PATH first, then the Xcode command line tools' copy, which is on any
    // machine that has git.
    for (const candidate of ['python3', '/usr/bin/python3']) {
      try {
        execFileSync(candidate, ['-c', ''], { stdio: 'ignore', timeout: 10_000 });
        ptyPython = candidate;
        break;
      } catch {
        /* next candidate */
      }
    }
  }
  log(ptyPython ? `pty: ${ptyPython} ${PTY_SCRIPT}` : `pty: ${NO_PTY_NOTE}`);
  return ptyPython;
}

// What the status JSON carries, so `xerb status` prints the read-only line
// without going looking for python itself.
function ptyStatus() {
  const python = ptyInterpreter();
  return { available: !!python, python, note: python ? null : NO_PTY_NOTE };
}

// host -> { chunks: Buffer[], size } of raw pty bytes.
const termRings = new Map();
// host -> Set of { conn, rec }: one entry per open terminal socket (a dashboard
// panel, a `xerb attach`), with the live-connection record it holds.
const termSockets = new Map();
// host -> { rows, cols } last asked for by a client. Remembered so the NEXT
// child is born the size the panel already is: a resize only reaches a running
// pty, and without this a restart would drop every panel back to 24x80.
const termSizes = new Map();

function appendTermRing(host, buf) {
  let ring = termRings.get(host);
  if (!ring) termRings.set(host, (ring = { chunks: [], size: 0 }));
  ring.chunks.push(buf);
  ring.size += buf.length;
  // Drop whole chunks off the front, then slice the one straddling the cap. The
  // slice can land mid-escape; a terminal emulator swallows one broken sequence
  // at the top of a replay, and the alternative is parsing 256 KB on every read.
  while (ring.size > TERM_RING_BYTES) {
    const first = ring.chunks[0];
    const over = ring.size - TERM_RING_BYTES;
    if (first.length <= over) {
      ring.chunks.shift();
      ring.size -= first.length;
    } else {
      ring.chunks[0] = first.subarray(over);
      ring.size -= over;
    }
  }
}

function termRingBytes(host) {
  const ring = termRings.get(host);
  if (!ring || !ring.size) return Buffer.alloc(0);
  return Buffer.concat(ring.chunks, ring.size);
}

// Live bytes to every open panel for this host. Both clocks move, exactly as
// they do for a proxied HMR socket: a byte crossing in either direction is the
// project being used, and an open terminal defers the reaper until it goes
// quiet for the hard cap.
function broadcastTerm(host, buf) {
  const socks = termSockets.get(host);
  if (!socks || !socks.size) return;
  const now = Date.now();
  lastAccess.set(host, now);
  for (const s of socks) {
    s.rec.lastByteAt = now;
    try {
      s.conn.send(buf);
    } catch {
      /* a dying socket cleans itself up on 'close' */
    }
  }
}

// Say something to the terminal that the dev server did not say. Today that is
// only the start/install separator. It joins the scrollback too, so a panel
// opened later still sees it.
function termEcho(host, text) {
  const buf = Buffer.from(text, 'utf8');
  appendTermRing(host, buf);
  broadcastTerm(host, buf);
}

// Complete escape sequences, in the order they have to be recognised: OSC
// (window titles, shell integration) ends at BEL or ST; CSI is what colors and
// cursor moves are; the two- and three-character forms are charset selects and
// friends. ESC [ and ESC ] are deliberately outside ESC2_RE so an OSC or CSI cut
// in half by a chunk boundary is carried, not eaten one character at a time.
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_RE = /\u001b\[[0-9;:?<>=!]*[ -\/]*[@-~]/g;
const ESC2_RE = /\u001b[()#][0-9A-Za-z]|\u001b[@A-Z\\^_=><]/g;
// Everything else a terminal uses that a text file has no use for. CR is absent
// on purpose: it is handled first, because it carries line structure.
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// One spawn's output sink. Raw bytes go to the scrollback and the panels; a
// plain-text copy goes into <host>.log, which is what `xerb logs` and grep
// read. The daemon does that write itself now, because the child's own stdout
// is the tty, not the file, and it writes SYNCHRONOUSLY so that a failure page
// rendered the instant a child dies finds the last thing it said already there.
function makeTermSink(host, logFd) {
  // The log is written a finished line at a time: a redraw is only known to be
  // over once its newline arrives. Whatever follows the last newline waits
  // here for the next chunk, which also covers an escape sequence or a CR cut
  // in half by a chunk boundary.
  let carry = '';
  const toLog = (text) => {
    if (typeof logFd !== 'number' || !text) return;
    try {
      fs.writeSync(logFd, text);
    } catch {
      /* a log we cannot write is never a reason to lose the terminal */
    }
  };
  return {
    write(buf) {
      appendTermRing(host, buf);
      broadcastTerm(host, buf);
      carry += buf.toString('utf8');
      const nl = carry.lastIndexOf('\n');
      if (nl < 0) {
        // A progress bar that never ends its line cannot grow without bound:
        // only what follows the last CR can still be on screen.
        if (carry.length > LOG_CARRY_MAX) carry = carry.slice(carry.lastIndexOf('\r', carry.length - 2) + 1);
        if (carry.length > LOG_CARRY_MAX) {
          toLog(logLines(carry + '\n'));
          carry = '';
        }
        return;
      }
      const done = carry.slice(0, nl + 1);
      carry = carry.slice(nl + 1);
      toLog(logLines(done));
    },
    end() {
      const rest = carry;
      carry = '';
      toLog(logLines(rest));
      if (typeof logFd === 'number') {
        try {
          fs.closeSync(logFd);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

const LOG_CARRY_MAX = 64 * 1024;
// Braille patterns, U+2800 to U+28FF: every frame of npm's, pnpm's and ora's
// spinners.
const SPINNER_ONLY_RE = /^[\u2800-\u28ff\s]*$/;

// Terminal output to log text. The scrollback and the panels get the bytes as
// they came; the text file gets what a terminal would be SHOWING. A pty ends
// lines with CRLF, and a progress line redraws itself in place with a bare CR,
// so each line keeps only what follows its last CR: a bar that redrew forty
// times is its final state, not forty lines. A line that was nothing but
// redraws or spinner frames is dropped. A line that was blank to begin with is
// spacing the program asked for, and stays.
function logLines(text) {
  if (!text) return '';
  const clean = text.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC2_RE, '').replace(/\u001b/g, '');
  const open = !clean.endsWith('\n');
  const lines = clean.split('\n');
  const last = lines.pop(); // '' after a final newline, else the unfinished line
  if (open) lines.push(last);
  const out = [];
  for (const raw of lines) {
    const body = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const line = body.slice(body.lastIndexOf('\r') + 1).replace(CTRL_RE, '');
    if (body !== '' && SPINNER_ONLY_RE.test(line)) continue;
    out.push(line);
  }
  if (!out.length) return '';
  return out.join('\n') + (open ? '' : '\n');
}

// GET /__xerb/term/<host>, a WebSocket upgrade on the dashboard's own host.
const TERM_PATH = '/__xerb/term/';

// The terminal socket's handshake. Called from handleUpgrade before it hands
// anything to the HMR proxy, because an http server gets exactly one 'upgrade'
// listener and both paths live under it.
function handleTermUpgrade(req, socket, head, url, key) {
  const refuse = (code, why) => {
    log(`term-refused: ${code} (${why})`);
    try {
      const text = code === 401 ? 'Unauthorized' : code === 404 ? 'Not Found' : 'Bad Request';
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    } catch {
      /* ignore */
    }
  };
  // The terminal lives on the control plane: the xerb host, or a host naming
  // no project (bare localhost, an IP literal), which is where the dashboard is
  // also served. Anywhere else is a project host, and a page a dev server
  // serves must not be able to ask for anybody's terminal, its own included.
  if (key !== 'xerb' && key !== null) return refuse(401, `term socket asked for on ${key}`);
  if (!isWebSocketUpgrade(req)) return refuse(400, 'not a websocket upgrade');
  if (!isSameOrigin(req)) return refuse(401, 'cross-origin');
  // A browser cannot set headers on a WebSocket, so the control token rides in
  // Sec-WebSocket-Protocol, which it can set. We echo back exactly the value we
  // accepted and nothing else, because RFC 6455 wants one of the offered ones.
  const offered = String(req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const accepted = offered.find((p) => p === ensureControlToken());
  if (!accepted) return refuse(401, 'missing or wrong token');
  let host = url.pathname.slice(TERM_PATH.length);
  try {
    host = decodeURIComponent(host);
  } catch {
    /* keep the raw value; the lookup below fails it */
  }
  const project = projectByHost(host);
  if (!project) return refuse(404, `unknown host ${host}`);
  const conn = wsAccept(req, socket, head, { protocol: accepted });
  if (conn) attachTermSocket(conn, project);
}

// One open terminal: replay, live bytes out, `i:`/`r:` frames in.
function attachTermSocket(conn, project) {
  const host = project.host;
  // An open terminal is a live connection, so the reaper leaves the project
  // alone while a panel watches it. The 2 h hard cap still retires an abandoned
  // tab: a record with no byte in that long stops counting as active.
  const rec = addConn(host);
  const entry = { conn, rec };
  let socks = termSockets.get(host);
  if (!socks) termSockets.set(host, (socks = new Set()));
  socks.add(entry);
  const bump = () => {
    const now = Date.now();
    lastAccess.set(host, now);
    rec.lastByteAt = now;
  };
  bump();
  log(`term: ${host} attached (${socks.size} open)`);

  // First frame is the scrollback, so a panel opens showing what already
  // happened instead of an empty box. The read-only line goes in front of it
  // when there is no pty to type into.
  const opening = [];
  if (!ptyInterpreter()) opening.push(Buffer.from(`\r\n[xerb] ${NO_PTY_NOTE}\r\n\r\n`, 'utf8'));
  const ring = termRingBytes(host);
  if (ring.length) opening.push(ring);
  conn.send(opening.length === 1 ? opening[0] : Buffer.concat(opening));

  conn.on('message', (data) => {
    bump();
    handleTermFrame(host, typeof data === 'string' ? data : data.toString('utf8'));
  });
  // Listening at all keeps a protocol error from reaching the daemon as an
  // unhandled 'error' (see lib/ws.mjs); 'close' does the cleanup either way.
  conn.on('error', () => {});
  conn.on('close', () => {
    socks.delete(entry);
    removeConn(host, rec);
    log(`term: ${host} detached (${socks.size} open)`);
  });

  // Opening a terminal is a wake request, and deliberately not awaited: the
  // case this whole section exists for is a dev server that will not finish
  // starting until someone answers a question, and waiting for the bring-up
  // would mean the panel could not show the question.
  if (project.enabled !== false) {
    ensureUp(project).then((r) => {
      // A server xerb did not start has no terminal here to show. Say so, to
      // this panel only, instead of leaving an empty box under a green badge.
      if (r.state !== 'running' || r.owned || !socks.has(entry)) return;
      conn.send(Buffer.from(`\r\n\x1b[2m[xerb] ${EXTERNAL_TERM_NOTE}\x1b[0m\r\n`, 'utf8'));
    }).catch(() => {
      /* the failure is on the page and in the log; the socket stays open */
    });
  }
}

// How long after a spawn a resize needs re-sending (see handleTermFrame).
const PTY_SIZE_SETTLE_MS = 300;

// Push the size a host's clients last asked for down to its running pty.
function writePtySize(host) {
  const r = runtime.get(host);
  const pty = r && r.pty;
  const size = termSizes.get(host);
  if (!size || !pty || !pty.resize || !pty.resize.writable) return;
  try {
    // pty.py ioctls the master; the kernel raises SIGWINCH on the child itself.
    pty.resize.write(`${size.rows} ${size.cols}\n`);
  } catch {
    /* the child is on its way out */
  }
}

// The client half of the protocol, in full: `i:<bytes>` is input, `r:<rows>,
// <cols>` is a resize. Anything else is ignored rather than closed on, so a
// later client that knows one more verb is not hung up on by an older daemon.
function handleTermFrame(host, msg) {
  const r = runtime.get(host);
  const pty = r && r.pty;
  if (msg.startsWith('i:')) {
    // No pty (no python3, or the project is not running): read-only, and the
    // panel already said so on its first frame.
    if (!pty || !pty.stdin || !pty.stdin.writable) return;
    try {
      pty.stdin.write(msg.slice(2));
    } catch {
      /* the child is on its way out */
    }
    return;
  }
  if (msg.startsWith('r:')) {
    const m = /^r:(\d+),(\d+)$/.exec(msg.trim());
    if (!m) return;
    // Clamped before it reaches an ioctl: these numbers come off a socket, and
    // a terminal 0 rows tall is a dev server drawing into nothing.
    const rows = Math.min(1000, Math.max(1, Number(m[1])));
    const cols = Math.min(1000, Math.max(1, Number(m[2])));
    termSizes.set(host, { rows, cols });
    writePtySize(host);
    // A resize that lands in the first moments of a spawn can be undone: the
    // child pty.py forks stamps the startup size on the slave just before exec,
    // and it can get there after our line does. Send it again past that window;
    // re-applying a size a terminal already has costs one no-op ioctl.
    if (pty && Date.now() - (pty.startedAt || 0) < PTY_SIZE_SETTLE_MS) {
      setTimeout(() => writePtySize(host), PTY_SIZE_SETTLE_MS).unref?.();
    }
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

// Is there anything for an install to fetch? A package.json with no
// dependencies never grows a node_modules, so "node_modules is missing" stays
// true forever and every wake paid for an install that does nothing. A
// workspace root still installs: its dependencies live in the member packages.
// An unreadable or invalid file skips too, and the start command gets to
// produce the real error.
function hasDepsToInstall(packageJson) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
  } catch {
    return false;
  }
  if (!pkg || typeof pkg !== 'object') return false;
  if (pkg.workspaces) return true;
  return ['dependencies', 'devDependencies', 'optionalDependencies'].some(
    (k) => pkg[k] && typeof pkg[k] === 'object' && Object.keys(pkg[k]).length > 0
  );
}

// Run the install step for a project whose node_modules is missing. Streams to
// logs/<host>.log, has its own timeout, and resolves { ok: true } ONLY on exit
// code 0. On non-zero/timeout it kills the install process and resolves
// { ok: false, cmd, exitCode, timedOut }, because the failure page quotes the
// command and the code and a bare boolean cannot carry either.
function runInstall(project, r) {
  const host = project.host;
  // Expanded first, so the install command is inferred from the real first
  // token (`python3` for a static site) rather than from the placeholder.
  const installCmd = inferInstallCmd(expandStartCmd(project.startCmd));
  return new Promise((resolve) => {
    const logFd = logFdFor(host);
    writeLogSeparator(host, logFd, 'install', installCmd, project.port);
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
      return resolve({ ok: false, cmd: installCmd, exitCode: null, timedOut: false, message: err.message });
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
      finish({ ok: false, cmd: installCmd, exitCode: null, timedOut: true });
    }, config.installTimeoutMs);

    child.on('error', (err) => {
      log(`install-error: ${host}: ${err.message}`);
      finish({ ok: false, cmd: installCmd, exitCode: null, timedOut: false, message: err.message });
    });
    child.on('exit', (code, signal) => {
      log(`install-exit: ${host} pid=${child.pid} code=${code} signal=${signal}`);
      finish(code === 0 ? { ok: true, cmd: installCmd } : { ok: false, cmd: installCmd, exitCode: code, signal, timedOut: false });
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
    // A stop that lands while this attempt is in flight is not a failure: the
    // switch flipped off, `xerb stop` ran, the project was renamed. Every
    // failure path below checks this before recording anything, because a
    // record left stopped-with-lastError shows a red `failed` badge AND stops
    // the URL from waking the project (see handleRequest's kick gate).
    const stopSeq = r.stopSeq || 0;
    const stoppedByUs = () => (r.stopSeq || 0) !== stopSeq;
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
        clearAdoption(r); // a child we own is tracked by its exit handler, not by pid polling
        return;
      }
      // External listener: verify ownership by cwd before adopting. A dev server
      // you started by hand FROM the project dir is yours (matching cwd); a
      // stray process squatting the port is not.
      //
      // Resolve the pid FIRST and keep it on the record: the cwd check below is
      // a statement about THAT process, and it stops being true the moment that
      // process dies and something else takes the port. verifyAdoptedUpstream()
      // re-checks the pid before each proxy so the adoption cannot be inherited
      // by a stranger. One extra lsof, at adoption only.
      const listenerPid = resolveListenerPid(project.port); // null when lsof unavailable
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
        // No cwd means no lsof, which means no pid either: nothing to re-verify
        // against, so leave adoptedPid null and let verifyAdoptedUpstream pass
        // this record through (an unverified adopt cannot get more verified by
        // asking the same broken tool again every two seconds).
        r.adoptedPid = listenerPid;
        r.verifiedAt = listenerPid ? Date.now() : 0;
        return;
      }
      if (sameDir(cwd, project.dir)) {
        log(`adopt: ${host} external listener cwd matches ${project.dir} -> adopting (pid ${listenerPid || '?'})`);
        r.upstreamHost = openHost;
        r.state = 'running';
        r.owned = false;
        r.child = null;
        r.pid = null;
        r.conflictDir = null;
        r.adoptedPid = listenerPid;
        r.verifiedAt = listenerPid ? Date.now() : 0;
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
      clearAdoption(r);
      r.conflictDir = cwd; // remember foreign cwd for status/dashboard detail
      r.lastError = { code: 'PORT_CONFLICT', kind: 'conflict', message: `port ${project.port} is held by a process in ${cwd}`, at: Date.now(), port: project.port, conflictDir: cwd };
      const e = new Error('portConflict');
      e.code = 'PORT_CONFLICT';
      e.host = host;
      e.conflictDir = cwd;
      throw e; // rejects startPromise -> handleRequest/handleUpgrade/up never proxy
    }

    // Need to spawn. Before anything else: does the folder still exist? A moved
    // or deleted project dir is a start that CANNOT work, and spawn() does not
    // tell us so in time: posix_spawn's ENOENT for a missing cwd surfaces
    // asynchronously on 'error' and (on this Node/macOS pair) never fires
    // 'exit', so the exit race below never settles and the old code sat in
    // 'starting' for the full startTimeoutMs. One statSync fails it in a
    // millisecond, with copy that names the folder and the way back.
    let dirExists = false;
    try {
      dirExists = fs.statSync(project.dir).isDirectory();
    } catch {
      dirExists = false;
    }
    if (!dirExists) {
      log(`dir-missing: ${host} ${project.dir} is gone -> failed`);
      r.state = 'stopped';
      r.owned = false;
      r.child = null;
      r.pid = null;
      const e = new Error(`project folder ${project.dir} does not exist`);
      e.code = 'DIR_MISSING';
      e.host = host;
      r.lastError = { code: e.code, kind: 'dir-missing', message: e.message, at: Date.now(), dir: project.dir };
      throw e;
    }

    // Install (if needed) and start are ONE atomic operation, so a second
    // concurrent request never launches a second install.
    // First start with no deps installed -> install them before starting.
    // Only Node projects get an install step: "no node_modules" means nothing
    // in a project that has no package.json (a static folder, a Python
    // server), and forcing `npm install` there fails and blocks the start.
    const nodeModules = path.join(project.dir, 'node_modules');
    const packageJson = path.join(project.dir, 'package.json');
    const haveModules = fs.existsSync(nodeModules);
    // Deps arrived (the install worked, or the user ran it by hand): forget any
    // remembered failure so a later one can install again.
    if (haveModules) r.installFailed = null;
    if (!haveModules && fs.existsSync(packageJson) && hasDepsToInstall(packageJson)) {
      // An install that already failed on this record is not retried by a plain
      // reload: node_modules is still missing, so the condition above is still
      // true, and without this memo every refresh paid installTimeoutMs again
      // (5 minutes, by default) to reach the same failure. Re-report the
      // remembered failure instead, instantly. The failure page's Retry link
      // clears the memo (see handleRequest), so a deliberate retry does install.
      if (r.installFailed) {
        log(`install-skipped: ${host} install already failed at ${new Date(r.installFailed.at).toISOString()} -> failing fast`);
        r.state = 'stopped';
        r.owned = false;
        r.child = null;
        r.pid = null;
        const e = new Error(r.installFailed.message);
        e.code = 'INSTALL_FAILED';
        e.host = host;
        r.lastError = { ...r.installFailed, at: Date.now() };
        throw e;
      }
      r.state = 'installing';
      const result = await runInstall(project, r);
      if (!result.ok) {
        // Install failed/timed out — runInstall already killed it on timeout,
        // but a non-zero exit leaves the child reaped; make sure the group dies.
        killGroup(r, 'SIGKILL');
        r.state = 'stopped';
        r.owned = false;
        r.child = null;
        r.pid = null;
        const message = result.timedOut
          ? `\`${result.cmd}\` did not finish within ${config.installTimeoutMs}ms`
          : result.exitCode === null
            ? `\`${result.cmd}\` could not be run${result.message ? `: ${result.message}` : ''}`
            : `\`${result.cmd}\` exited with code ${result.exitCode}`;
        const e = new Error(message);
        e.code = 'INSTALL_FAILED';
        e.host = host;
        // Record before throwing: handleRequest no longer awaits us on the cold
        // path, so the status page reads r.lastError after startPromise clears.
        // Unless the install died because someone stopped the project: that is
        // an interrupted install, not a broken one, and memoizing it would make
        // the next visit re-report a failure nobody had.
        if (!stoppedByUs()) {
          r.lastError = {
            code: e.code,
            kind: 'install-failed',
            message,
            at: Date.now(),
            installCmd: result.cmd,
            exitCode: result.exitCode,
            timedOut: !!result.timedOut,
            timeoutMs: config.installTimeoutMs, // the limit in force at failure time
          };
          r.installFailed = r.lastError; // the memo the next request reads
        }
        throw e;
      }
    }

    const logFd = logFdFor(host);
    // Expansion happens here, at spawn time, not at registry-read time: the
    // separator and the daemon log then quote the command that actually ran.
    const startCmd = expandStartCmd(project.startCmd);
    writeLogSeparator(host, logFd, 'start', startCmd, project.port);
    const startedAt = Date.now();
    // The dev server runs inside a real terminal when this machine has a python3
    // for lib/pty.py, and on plain pipes when it does not (spec section 6). The
    // command is `sh -c <startCmd>` either way, reached through pty.py in the
    // first case; whichever of the two we spawn is the process-group leader, so
    // stop()'s SIGTERM-group, 5s, SIGKILL order is untouched by the choice.
    const python = ptyInterpreter();
    const size = termSizes.get(host) || { rows: PTY_ROWS, cols: PTY_COLS };
    const [file, args] = python
      ? [python, [PTY_SCRIPT, String(size.rows), String(size.cols), startCmd]]
      : ['sh', ['-c', startCmd]];
    log(`start: ${host} -> sh -c '${startCmd}' (cwd=${project.dir}, PORT=${project.port}, ${python ? 'pty' : 'pipes'})`);
    let child;
    try {
      child = spawn(file, args, {
        cwd: project.dir,
        env: {
          ...process.env,
          PORT: String(project.port),
          FORCE_COLOR: '1',
          BROWSER: 'none',
          NEXT_TELEMETRY_DISABLED: '1',
        },
        detached: true, // own process-group leader -> kill -pid kills the group
        // With a pty: stdin and stdout are the terminal's two ends, stderr is
        // pty.py's own (the command's is merged into the tty), and fd 3 takes
        // `<rows> <cols>` resize lines. Without one: no stdin at all, which is
        // exactly what makes the panel read-only, and the same output pipes so
        // the panel and the log still get everything the dev server says.
        stdio: python ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
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
      // A synchronous spawn throw (no /bin/sh, EMFILE, a bad cwd caught early)
      // used to leave lastError null, so the page said 'waking' forever. It is
      // the same thing to the person waiting as a child that died on contact:
      // report it as 'exited' with no code to quote.
      r.lastError = { code: 'START_EXITED', kind: 'exited', message: err.message, at: Date.now(), exitCode: null, elapsedMs: Date.now() - startedAt };
      throw err;
    }

    // The child's stdout is a tty (or a pipe) now, never the log file, so the
    // daemon owns the log fd for as long as this child lives and the sink is
    // what writes it. sink.end() closes it once both output streams are done.
    const sink = makeTermSink(host, logFd);
    child.stdout.on('data', (buf) => sink.write(buf));
    // pty.py's own stderr is its usage line or a python traceback, and that
    // belongs in the same place for the same reason. On the pipe path this is
    // the dev server's real stderr, as before.
    child.stderr.on('data', (buf) => sink.write(buf));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    // 'close' rather than 'exit': it fires once the stdio is drained too, so
    // nothing the dying child said is lost between the last read and the close.
    child.on('close', () => sink.end());

    r.child = child;
    r.pid = child.pid;
    r.owned = true;
    r.state = 'starting';
    if (python) {
      const resize = child.stdio[3] || null;
      // EPIPE on a child that has already gone is expected, not fatal.
      child.stdin.on('error', () => {});
      resize?.on('error', () => {});
      // startedAt is read by writePtySize: a resize asked for in the first
      // moments of a spawn needs sending twice (see PTY_SIZE_SETTLE_MS).
      r.pty = { stdin: child.stdin, resize, startedAt: Date.now() };
    } else {
      r.pty = null;
    }
    clearAdoption(r); // this port is ours now; no adopted pid to re-verify

    child.on('exit', (code, signal) => {
      log(`exit: ${host} pid=${child.pid} code=${code} signal=${signal}`);
      // Only flip to stopped if this is still the active child.
      if (r.child === child) {
        r.state = 'stopped';
        r.child = null;
        r.pid = null;
        r.owned = false;
        r.pty = null; // nothing to type into until the next start
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
      const deliberate = stoppedByUs();
      if (exited) {
        // The 'exit' handler above already flipped the record to stopped and
        // cleared child/pid; sweep group stragglers via the child's own pgid
        // (killGroup reads r.pid, which is null by now).
        log(deliberate ? `start-stopped: ${host} stopped while starting` : `start-failed: ${host} ${err.message}`);
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
      // reads r.lastError after startPromise clears in the finally below. The
      // numbers the copy quotes are captured here, not re-derived at render
      // time: how long the child actually lived, or the timeout it rode out.
      // ...but not when we are the ones who killed it: `deliberate` means a
      // stop landed after this attempt began, so the record stays a plain
      // 'stopped' one and the URL keeps waking the project.
      if (!deliberate) {
        r.lastError = exited
          ? { code: e.code, kind: 'exited', message: e.message, at: Date.now(), exitCode: err.exitCode, signal: err.signal, elapsedMs: Date.now() - startedAt }
          : { code: e.code, kind: 'timeout', message: e.message, at: Date.now(), port: project.port, timeoutMs: config.startTimeoutMs };
      }
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
    return { ok: false, reason: 'not owned by xerb' };
  }
  const pid = r.pid;
  // Before the signal, so a bring-up that is mid-await when the child dies can
  // tell our SIGTERM from a dev server that fell over on its own.
  r.stopSeq = (r.stopSeq || 0) + 1;
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
  // Forget the terminal handles here and not only in the exit handler: the
  // record stops pointing at this child the moment we ask it to die, and a
  // panel that is still open must not type into a process on its way out.
  r.pty = null;
  clearAdoption(r);
  return { ok: true };
}

// Free a project's port by stopping the FOREIGN process squatting it — the
// conflict page's call to action. Every check runs at action time against the
// live listener, never against the remembered conflict record: a conflict page
// left open for hours must not kill whatever grabbed the port since. The rules:
//   - nothing listening        -> the conflict is stale; clear it, done
//   - cwd unresolved           -> refuse (never kill what we cannot identify)
//   - cwd matches project.dir  -> nothing to kill; clear the conflict so the
//                                 next request adopts the project's own server
//   - cwd mismatch             -> SIGTERM the listener, wait, SIGKILL if needed
// The pid is resolved before the cwd check and re-checked after it, so a
// listener that changes mid-decision aborts the kill instead of hitting a
// process nobody looked at.
async function freePort(project, r) {
  // A bring-up in flight owns the probe/adopt decision; let it settle first.
  if (r.startPromise) await r.startPromise.catch(() => {});
  // Settled into running (owned or adopted)? The port belongs to the project
  // now — there is nothing to free, and clearing the record here would orphan
  // an owned child.
  if (r.state === 'running') {
    return { ok: true, freed: false, reason: 'already running' };
  }
  const host = project.host;
  const clear = () => {
    r.state = 'stopped';
    r.owned = false;
    r.child = null;
    r.pid = null;
    r.upstreamHost = null;
    r.conflictDir = null;
    // The conflict is over, so its lastError must go with it. Left standing it
    // reads as a terminal failure (stopped + lastError), which handleRequest
    // never re-kicks: the page's "Free port and open" reloaded into a stuck
    // "failed to start" instead of the wake page.
    if (r.lastError && r.lastError.kind === 'conflict') r.lastError = null;
    clearAdoption(r);
  };
  if (!(await probePort(project.port, 300))) {
    clear();
    return { ok: true, freed: false, reason: 'nothing listening' };
  }
  const pid = resolveListenerPid(project.port);
  if (!pid || pid === process.pid) {
    return { ok: false, reason: 'could not identify the listening process' };
  }
  const cwd = resolvePidCwd(project.port);
  if (cwd === null) {
    return { ok: false, reason: 'could not identify the listening process' };
  }
  if (sameDir(cwd, project.dir)) {
    clear();
    return { ok: true, freed: false, reason: 'listener is this project' };
  }
  if (resolveListenerPid(project.port) !== pid) {
    return { ok: false, reason: 'the listener changed mid-check; try again' };
  }
  log(`free: ${host} port ${project.port} held by pid ${pid} in ${cwd} -> SIGTERM`);
  const goneWithin = async (ms) => {
    const deadline = Date.now() + ms;
    do {
      if (!(await probePort(project.port, 200))) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    return !(await probePort(project.port, 200));
  };
  killForeign(pid, 'SIGTERM');
  if (!(await goneWithin(4000))) {
    log(`free: ${host} pid ${pid} still listening after SIGTERM -> SIGKILL`);
    killForeign(pid, 'SIGKILL');
    if (!(await goneWithin(2000))) {
      return { ok: false, reason: 'the process did not release the port' };
    }
  }
  log(`free: ${host} port ${project.port} is free`);
  clear();
  return { ok: true, freed: true };
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
  /* The log box on the failed page is the only block of dark-on-light here,
     and #1115 (black at 7%) landed as the same flat grey in both themes, so in
     dark mode the log read as a slightly different background instead of a
     panel. Give it a real surface + edge of its own. */
  @media (prefers-color-scheme: dark) {
    pre { background: #0d1117; border: 1px solid #ffffff1f; }
  }
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

// One sentence per failure kind, with the numbers that make it checkable.
// This is the whole of section 4's complaint: before it, every failure rendered
// the start-timeout sentence, so a dev server that died in 100ms read as "did
// not open 127.0.0.1:3010 within 30s" and the log was the only way to tell.
// `kind` is the closed set ensureUp writes: exited, timeout, dir-missing,
// install-failed, conflict. Returns HTML; every interpolated value is escaped.
//
// The dir-missing sentence names the folder even for an unauthorized caller,
// unlike the raw `reason` line below it. Deliberate: the path IS the fix, the
// two commands are useless without it, and this response is readable only from
// the project's own origin (a cross-origin page can navigate a browser here but
// cannot read what comes back). /__xerb/status already ships conflictDir on
// the same reasoning.
function failureCopy(project, lastError) {
  const le = lastError || {};
  const lived = le.elapsedMs == null ? null : (le.elapsedMs / 1000).toFixed(1);
  switch (le.kind) {
    case 'exited':
      if (le.exitCode != null) return `The dev server exited with code ${esc(String(le.exitCode))} after ${lived ?? '?'}s.`;
      if (le.signal) return `The dev server was killed by ${esc(String(le.signal))} after ${lived ?? '?'}s.`;
      return `The dev server exited before it opened <code>127.0.0.1:${project.port}</code>.`;
    case 'timeout':
      return `Nothing answered on port ${esc(String(le.port ?? project.port))} within ${Math.round((le.timeoutMs ?? config.startTimeoutMs) / 1000)}s. The process is still being killed.`;
    case 'dir-missing':
      return `The folder <code>${esc(le.dir || project.dir)}</code> is gone. Move it back, or <code>xerb remove ${esc(project.host)}</code> / <code>xerb add /new/path --name ${esc(project.host)}</code>.`;
    case 'install-failed':
      if (le.timedOut) return `<code>${esc(le.installCmd || 'npm install')}</code> did not finish within ${Math.round((le.timeoutMs ?? config.installTimeoutMs) / 1000)}s.`;
      if (le.exitCode == null) return `<code>${esc(le.installCmd || 'npm install')}</code> could not be run.`;
      return `<code>${esc(le.installCmd || 'npm install')}</code> exited with code ${esc(String(le.exitCode))}.`;
    case 'conflict':
      return `Port ${esc(String(le.port ?? project.port))} is held by another process, so this project was never started.`;
    default:
      // No kind recorded (a pre-0.3.0 record, or a failure path added without
      // one): fall back to the sentence every failure used to get.
      return `The dev server did not open <code>127.0.0.1:${project.port}</code> within ${Math.round(config.startTimeoutMs / 1000)}s.`;
  }
}

// Self-refreshing HTML served on a cold navigation hit. Names the project + its
// phase, and polls the host-scoped GET /__xerb/tail once a second. That one
// poll drives everything: the phase line updates in place (installing turns
// into starting without a reload), an optional terminal panel shows the live
// log tail, and a state that left the bring-up phases reloads the page — into
// the app when the port answered, or into the failed/conflict page otherwise.
// `r` may be the live runtime record OR a {state, lastError} snapshot taken by
// handleRequest before it re-kicked bring-up; only those two fields are read.
//
// The raw failure message can leak filesystem paths, so it is shown ONLY to an
// authorized caller (same-origin + capability token). The log tail itself is
// no longer gated: /__xerb/tail serves it host-scoped to the project's own
// origin (its handler explains why that is sound), because "why is this taking
// so long" is exactly the question this page exists to answer.
function statusPageHtml(project, r, authorized = false) {
  const host = project.host;
  const phase = phaseLabel(r);
  // The terminal panel + its dim pointer at the CLI twin. Shared by the failed
  // page (open, fetched once) and the wake page (toggled, polled live).
  const termNote = `<p class="muted">The same lines as <code>xerb logs ${esc(host)}</code>.</p>`;
  if (phase === 'failed') {
    // The raw error message can leak paths too — redact it for the unauthorized.
    const reason = authorized
      ? (r.lastError && (r.lastError.message || r.lastError.code)) || 'unknown error'
      : 'The dev server failed to start.';
    // A dir-missing failure never reached a spawn, so this attempt wrote nothing
    // to the log; showing the previous run's tail under it would answer a
    // question nobody asked. Every other kind ends in output worth reading.
    const kind = (r.lastError && r.lastError.kind) || null;
    const withLog = kind !== 'dir-missing';
    const logBlock = withLog
      ? `<pre id="term">loading the log&hellip;</pre>
       ${termNote}
       <script>
         fetch('/__xerb/tail', { cache: 'no-store' })
           .then((res) => res.json())
           .then((j) => {
             const t = document.getElementById('term');
             t.textContent = (j.ok && j.tail) || '(no log output captured)';
             t.scrollTop = t.scrollHeight;
           })
           .catch(() => {});
       </script>`
      : '';
    // Terminal page: no auto-refresh. The headline sentence comes from
    // failureCopy, so each kind says what actually happened, and a manual retry
    // link points at the same URL. The log tail arrives via /__xerb/tail so
    // this page shows the WHY by default.
    return htmlPage(
      `${host} — failed to start`,
      `<h1>${esc(host)} failed to start</h1>
       <p>${failureCopy(project, r.lastError)}</p>
       <p class="muted">${esc(reason)}</p>
       ${logBlock}
       <p><a href="${esc('/?retry=1')}">Retry</a></p>${dashboardHomeLink()}`
    );
  }
  // Non-terminal: waking / installing / starting. A minimal centered card — a
  // spinner, the phase in plain words, a seconds counter, and a "show the
  // terminal" toggle for when the seconds keep climbing.
  // One table, both places. The tab used to say "installing" while the body
  // said "being turned on", because the title was rendered once from the phase
  // at request time and only the body followed the poll. Now the title and the
  // sentence come from the same entry, and the poll below rewrites both.
  const phraseByPhase = {
    installing: { title: 'installing', body: 'Installing dependencies, then starting the dev server.' },
    starting: { title: 'starting up', body: 'The dev server is being turned on.' },
    waking: { title: 'starting up', body: 'The dev server is being turned on.' },
  };
  const phrase = phraseByPhase[phase] || phraseByPhase.waking;
  return htmlPage(
    `${host} — ${phrase.title}`,
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
       .termbtn { font: inherit; font-size: 13px; margin-top: 1.1rem; padding: 0.3rem 0.9rem;
                  border: 1px solid #8886; border-radius: 8px; background: none;
                  color: inherit; cursor: pointer; opacity: 0.8; }
       .termbtn:hover { background: #8881; opacity: 1; }
       #term { display: none; width: min(46rem, 92vw); max-height: 42vh; overflow: auto;
               text-align: left; margin: 1rem 0 0; }
       #termnote { display: none; }
     </style>
     <div class="wake">
       <div class="spinner" aria-hidden="true"></div>
       <h1>${esc(host)}</h1>
       <p class="muted" id="phrase">${phrase.body} This page opens the app automatically once it&#39;s ready.</p>
       <p class="muted" id="elapsed" aria-hidden="true">0s</p>
       <button class="termbtn" id="termbtn">show the terminal</button>
       <pre id="term"></pre>
       <div id="termnote">${termNote}</div>
       <a class="back" href="${esc(frontUrl('xerb'))}/">&larr; Back to dashboard</a>
     </div>
     <noscript><meta http-equiv="refresh" content="2"></noscript>
     <script>
       const PHRASES = ${JSON.stringify(phraseByPhase)};
       const SUFFIX = ${JSON.stringify(" This page opens the app automatically once it's ready.")};
       const HOST = ${JSON.stringify(host)};
       const started = Date.now();
       const term = document.getElementById('term');
       const termbtn = document.getElementById('termbtn');
       let showTerm = false;
       termbtn.onclick = () => {
         showTerm = !showTerm;
         term.style.display = showTerm ? 'block' : 'none';
         document.getElementById('termnote').style.display = showTerm ? 'block' : 'none';
         termbtn.textContent = showTerm ? 'hide the terminal' : 'show the terminal';
         if (showTerm) tick();
       };
       // Seconds waited, from 0s. A first start legitimately installs for
       // minutes; the counter plus the terminal separate "slow" from "stuck".
       // It used to appear at 3s, which read as the page fixing a glitch.
       setInterval(() => {
         const s = Math.round((Date.now() - started) / 1000);
         document.getElementById('elapsed').textContent = s + 's';
       }, 1000);
       // One poll drives the phase line, the terminal, and the handoff. Any
       // state outside the bring-up phases means this page is stale: reload,
       // and land on the app, the failed page, or the conflict page. A lone
       // 'stopped' can also be the daemon mid-decision, so it must repeat
       // before it counts.
       let stoppedTicks = 0;
       async function tick() {
         try {
           const res = await fetch('/__xerb/tail', { cache: 'no-store' });
           if (!res.ok) return;
           const j = await res.json();
           stoppedTicks = j.state === 'stopped' ? stoppedTicks + 1 : 0;
           if (j.state === 'running' || j.state === 'conflict' || j.phase === 'failed' || stoppedTicks >= 2) {
             location.reload();
             return;
           }
           const ph = PHRASES[j.phase] || PHRASES.waking;
           document.getElementById('phrase').textContent = ph.body + SUFFIX;
           document.title = HOST + ' — ' + ph.title;
           if (showTerm) {
             // Keep the view pinned to the newest lines unless the user
             // scrolled up to read something.
             const stick = term.scrollTop + term.clientHeight >= term.scrollHeight - 4;
             term.textContent = j.tail || '(no log output yet)';
             if (stick) term.scrollTop = term.scrollHeight;
           }
         } catch (e) { /* daemon momentarily unreachable; keep polling */ }
       }
       setInterval(tick, 1000);
     </script>`
  );
}

// Cold-hit answer for non-navigation clients (curl / XHR / webhook): a plain
// 503 with Retry-After and NO HTML body, so simple clients keep retrying.
function sendRetry(res, project, r) {
  res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' });
  res.end(phaseLabel(r) + '\n');
}

// Terminal answer for a port CONFLICT: the project's port is held by a foreign
// process (a dev server started from some OTHER directory). We must never proxy
// to it and never invite a retry, so this is a hard 502 — NOT the transient 503.
// But for the person standing in front of it this is a decision point, not a
// dead end, so the page carries the fix: one button that POSTs the host-scoped
// /__xerb/free (no token needed; see handleControl) and reloads into the
// normal wake flow. A browser navigation gets that page; curl/XHR gets a plain
// 502. The foreign cwd is a filesystem path, so it is shown only to an
// authorized caller (same-origin + token); an ordinary navigation gets the
// button without the path.
function sendConflict(req, res, project, r, authorized = false) {
  const host = project.host;
  const dir = r && r.conflictDir;
  if (wantsHtml(req)) {
    const detail = authorized && dir
      ? `<p class="muted">It runs from <code>${esc(dir)}</code>. This project lives in <code>${esc(project.dir)}</code>.</p>`
      : '';
    const freeLabel = `Free port ${project.port} and open ${host}`;
    return sendHtml(
      res,
      502,
      `xerb · ${host} port in use`,
      `<style>
         .conflict { min-height: calc(100vh - 6rem); display: flex; flex-direction: column;
                     align-items: center; justify-content: center; text-align: center; gap: 0.25rem; }
         .conflict p { max-width: 34rem; margin: 0.25rem 0; }
         .freebtn { font: inherit; margin-top: 1.5rem; padding: 0.55rem 1.3rem;
                    border: 1px solid #2563eb; border-radius: 8px;
                    background: #2563eb; color: #fff; cursor: pointer; }
         .freebtn:hover { filter: brightness(1.1); }
         .freebtn:disabled { opacity: 0.6; cursor: default; filter: none; }
         .back { display: inline-block; margin-top: 1.5rem; }
       </style>
       <div class="conflict">
         <h1>${esc(host)} is blocked, not broken</h1>
         <p>Another process is sitting on port ${project.port}, and it is not this project's dev server. xerb stopped here instead of showing you the wrong app.</p>
         ${detail}
         <button class="freebtn" id="free">${esc(freeLabel)}</button>
         <p class="muted">This sends that process a normal quit signal. To keep it, give ${esc(host)} a different port in the registry instead.</p>
         <a class="back" href="${esc(frontUrl('xerb'))}/">&larr; xerb dashboard</a>
       </div>
       <script>
         const btn = document.getElementById('free');
         btn.onclick = async () => {
           btn.disabled = true;
           btn.textContent = ${JSON.stringify(`Freeing port ${project.port}…`)};
           // Same-origin POST, host-scoped server-side: this page can only ever
           // free the port of the project it is served for.
           let failed = 'The daemon did not answer.';
           try {
             const res = await fetch('/__xerb/free', { method: 'POST' });
             const j = await res.json();
             if (j.ok) {
               btn.textContent = ${JSON.stringify(`Starting ${host}…`)};
               location.reload(); // cold path takes over: wake page, then the app
               return;
             }
             failed = j.reason || failed;
           } catch (e) { /* daemon unreachable; fall through */ }
           btn.textContent = failed;
           setTimeout(() => {
             btn.disabled = false;
             btn.textContent = ${JSON.stringify(freeLabel)};
           }, 3000);
         };
       </script>`
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
  const tok = req.headers['x-xerb-token'];
  return typeof tok === 'string' && tok.length > 0 && tok === ensureControlToken();
}

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

// `authorized` is the caller's own (same-origin + control token), not the
// daemon's: GET /__xerb/status answers on every project host, so a page a
// dev server renders can read it same-origin. The fields that name the machine
// (the start command, the raw failure message, a raw line of the dev server's
// log) are therefore served only to a caller holding the token, the same rule
// the failure page applies to the same strings. Everything the dashboard needs
// to paint a row without the token (state, port, kind) stays.
function liveState(host, project, authorized = false) {
  const r = runtime.get(host);
  const la = lastAccess.get(host) || 0;
  let state = r ? r.state : 'stopped';
  let owned = r ? r.owned : false;
  // A dir-missing failure never reached a spawn, so this attempt wrote no
  // separator and no output: a tail read here returns the PREVIOUS run's lines
  // and firstErrorLine falls back to the last of them, which captioned a red
  // row with a line from a start that worked. Same rule statusPageHtml uses to
  // leave the log box off that page.
  const errorLine = r && r.lastError && r.lastError.kind !== 'dir-missing'
    ? firstErrorLine(tailLog(host, 40))
    : null;
  return {
    host,
    url: frontUrl(host),
    port: project.port,
    enabled: project.enabled !== false,
    framework: project.framework || 'node',
    kind: project.kind || null,
    archived: project.archived || null,
    // A viewable's last sign of life, what its archive clock runs from.
    lastSeenAt: isViewable(project) ? lastSeen(project, opened, newestFileTime) || null : null,
    // What the row's edit panel prefills its "start command" field with.
    startCmd: authorized ? project.startCmd || '' : '',
    state,
    owned,
    conflict: state === 'conflict',
    conflictDir: r ? r.conflictDir || null : null,
    // The dashboard's red `failed` badge reads this: `kind` is its tooltip and
    // `errorLine` the line it shows beside it. Only carried for a record that
    // actually failed, so the common poll stays a pure in-memory map and the log
    // read happens for failed projects only.
    lastError: r && r.lastError
      ? {
          kind: r.lastError.kind || null,
          code: r.lastError.code || null,
          message: authorized ? r.lastError.message || null : null,
          at: r.lastError.at || null,
          // What `xerb status` quotes in a failed row.
          exitCode: r.lastError.exitCode ?? null,
          signal: r.lastError.signal || null,
          timeoutMs: r.lastError.timeoutMs ?? null,
          installCmd: r.lastError.installCmd || null,
          errorLine: authorized ? errorLine : null,
        }
      : null,
    lastAccess: la || null,
    idleForMs: la ? Date.now() - la : null,
    connCount: connCount(host),
    activeConnCount: activeConnCount(host, Date.now()),
  };
}

function statusPayload(authorized = false) {
  return {
    uptimeMs: Date.now() - STARTED_AT,
    idleTimeoutMs: config.idleTimeoutMs,
    viewableArchiveDays: config.viewableArchiveDays,
    // Whether dev servers get a real terminal on this machine. `xerb status`
    // prints `pty.note` once at the top when there is none, which is the same
    // line a read-only panel opens with: one sentence, one source.
    pty: ptyStatus(),
    projects: config.projects.map((p) => liveState(p.host, p, authorized)),
  };
}

// ---------------------------------------------------------------------------
// Dashboard edits (section 7): add / remove / enable / disable / set / restart
// ---------------------------------------------------------------------------

// Read the registry file, mutate it with one of lib/registry-cli.mjs's edits,
// write it back, reload. The file is the source of truth — an in-memory edit
// would be undone by the next reload — and going through the shared module is
// what keeps the dashboard and the subcommands from growing two ideas of what
// a valid entry is. The explicit loadConfig is so the response we are about to
// send already reflects the write; fs.watch would get there a beat later.
async function editRegistry(reason, mutate) {
  const reg = readRegistry(CONFIG_PATH);
  const out = await mutate(reg);
  writeRegistry(CONFIG_PATH, reg);
  loadConfig(reason);
  return out;
}

// A RegistryError carries the sentence the CLI prints; the dashboard shows the
// same words under the field. A name or port someone else already holds is a
// 409 (the request was well formed, the value is taken); everything else is a
// 400 the user can retype.
function sendRegistryError(res, err) {
  const status = /already (registered|claimed)|is taken|is reserved/.test(err.message) ? 409 : 400;
  return sendJson(res, status, { ok: false, reason: err.message });
}

// The host part of /__xerb/<verb>/<host>, decoded.
function hostFromPath(pathname, prefix) {
  return decodeURIComponent(pathname.slice(prefix.length));
}

// Handles the section 7 POSTs; returns true when it answered, false when the
// path is not one of them. Every caller is already past handleControl's token
// guard. Grouped in one function so a RegistryError from any of them turns
// into the same inline JSON the form and the edit panel render.
// A field the route does not know is a 400 that names it. A typo that falls on
// the floor looks like success and changes nothing, which is worse than an
// error. Answers true when it refused (the response is already sent).
function rejectUnknown(res, body, allowed) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (!unknown.length) return false;
  const named = unknown.map((k) => `"${k}"`).join(', ');
  sendJson(res, 400, { ok: false, reason: `unknown field${unknown.length > 1 ? 's' : ''} ${named}; known: ${allowed.join(', ')}` });
  return true;
}

let pickerChild = null;
function chooseFolder(res) {
  return new Promise((resolve) => {
    // "tell me to activate" brings osascript's own dialog to the front without
    // asking for any automation permission; without it the dialog opens
    // behind the browser.
    const child = spawn('osascript', [
      '-e', 'tell me to activate',
      '-e', 'POSIX path of (choose folder with prompt "Add a project to xerb")',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    pickerChild = child;
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    // The tab that asked went away: nobody is left to read the answer.
    res.on('close', () => { if (!res.writableEnded) child.kill(); });
    child.on('error', (e) => {
      pickerChild = null;
      resolve({ ok: false, reason: 'could not open a folder dialog: ' + e.message });
    });
    child.on('close', (code) => {
      pickerChild = null;
      const dir = out.trim().replace(/(.)\/+$/, '$1');
      if (code === 0 && dir) return resolve({ ok: true, dir });
      // -128 is AppleScript's "User canceled".
      if (/-128/.test(err)) return resolve({ ok: false, canceled: true });
      resolve({ ok: false, reason: 'the folder dialog failed: ' + (err.trim() || 'exit ' + code) });
    });
  });
}

async function handleEditControl(req, res, url) {
  const pathname = url.pathname;
  try {
    // POST /__xerb/detect — the add form's prefill, and nothing else: it
    // writes nothing. Runs the same detectors `xerb add` runs on one
    // directory and hands back what the form should show.
    if (pathname === '/__xerb/detect') {
      const body = (await readJsonBody(req)) || {};
      if (rejectUnknown(res, body, ['dir'])) return true;
      const raw = typeof body.dir === 'string' ? body.dir.trim() : '';
      if (!raw) {
        sendJson(res, 400, { ok: false, reason: 'a folder path is required' });
        return true;
      }
      const dir = expandTilde(raw).replace(/(.)\/+$/, '$1');
      if (!path.isAbsolute(dir)) {
        sendJson(res, 400, { ok: false, reason: 'the folder path must be absolute (~ is allowed)' });
        return true;
      }
      let stat = null;
      try {
        stat = fs.statSync(dir);
      } catch {
        /* missing — reported below */
      }
      if (!stat || !stat.isDirectory()) {
        sendJson(res, 404, { ok: false, reason: `no such folder: ${dir}` });
        return true;
      }
      // Against the live registry plus a real bind probe, same as the CLI.
      const port = await pickPort({ projects: config.projects });
      const det = detectOne(dir);
      // Exactly what `xerb add` would store for this folder, placeholder and
      // all, so the form prefills with the string that is going to be written.
      const detected = det ? startCmdFor(det, port) : null;
      sendJson(res, 200, {
        ok: true,
        dir,
        name: sanitizeHost(path.basename(dir)),
        port,
        framework: det ? det.framework : null,
        startCmd: detected,
        // Nothing provable: the form says what was looked for, in the same
        // words `xerb add` prints, and waits for a typed command.
        evidence: det ? null : DETECTOR_EVIDENCE,
      });
      return true;
    }

    // POST /__xerb/pick — a browser cannot hand a page a folder's absolute
    // path, and the daemon is on the same Mac as the person clicking, so it
    // opens Finder's own folder dialog and answers with what was chosen.
    // Writes nothing. Awaited, never execFileSync: the dialog stays up for as
    // long as someone browses, and the proxy keeps serving meanwhile.
    if (pathname === '/__xerb/pick') {
      if (pickerChild) {
        sendJson(res, 409, { ok: false, reason: 'a folder dialog is already open' });
        return true;
      }
      const picked = await chooseFolder(res);
      sendJson(res, picked.ok ? 200 : picked.canceled ? 200 : 500, picked);
      return true;
    }

    if (pathname === '/__xerb/add') {
      const body = (await readJsonBody(req)) || {};
      if (rejectUnknown(res, body, ['dir', 'name', 'host', 'startCmd', 'port', 'framework', 'parked'])) return true;
      // The registry key is `host`, the CLI flag is `--name`, the form field is
      // `name`. Both spellings mean the same thing here.
      if (body.name != null && body.host != null && String(body.name).trim() !== String(body.host).trim()) {
        sendJson(res, 400, { ok: false, reason: 'send "name" or "host", not both' });
        return true;
      }
      const rawName = body.name ?? body.host;
      const dir = expandTilde(String(body.dir || '').trim()).replace(/(.)\/+$/, '$1');
      if (!dir) {
        sendJson(res, 400, { ok: false, reason: 'a folder path is required' });
        return true;
      }
      if (!path.isAbsolute(dir)) {
        sendJson(res, 400, { ok: false, reason: 'the folder path must be absolute (~ is allowed)' });
        return true;
      }
      const host = sanitizeHost(String(rawName || '').trim() || path.basename(dir));
      const wantPort = body.port === undefined || body.port === null || body.port === ''
        ? null
        : Number(body.port);
      if (wantPort !== null && !Number.isInteger(wantPort)) {
        sendJson(res, 400, { ok: false, reason: `port must be a number (got "${body.port}")` });
        return true;
      }
      // The registry this folder may already have an entry in, remembered
      // before the write so we can tell a re-add from a first add.
      const before = config.projects.find((p) => p.dir === dir) || null;
      // A port no entry claims can still be busy right now. addEntry cannot see
      // that, and finding out at the first request would be a conflict page
      // instead of an inline error next to the field.
      if (wantPort !== null && (!before || before.port !== wantPort) && (await portListening(wantPort))) {
        sendJson(res, 409, { ok: false, reason: `port ${wantPort} is in use right now` });
        return true;
      }
      const det = body.framework ? null : detectOne(dir);
      const { entry, updated } = await editRegistry('control:add', (reg) => addEntry(reg, {
        host,
        dir,
        startCmd: String(body.startCmd || '').trim(),
        port: wantPort === null ? undefined : wantPort,
        framework: body.framework ? String(body.framework) : (det && det.framework) || 'node',
        parked: Boolean(body.parked),
      }));
      // Re-adding a folder that moved port or name leaves the old server
      // listening where nothing routes to it. Stop it; the next request cold
      // starts under the entry as it now reads.
      if (before && (before.port !== entry.port || before.host !== entry.host)) {
        stop(before.host, 'add');
        if (before.host !== entry.host) {
          runtime.delete(before.host);
          lastAccess.delete(before.host);
        }
      }
      log(`add: ${entry.host} -> ${entry.dir} :${entry.port}${entry.enabled ? '' : ' (parked)'}${updated ? ' (updated)' : ''}`);
      sendJson(res, 200, { ok: true, host: entry.host, port: entry.port, enabled: entry.enabled, updated });
      return true;
    }

    if (pathname.startsWith('/__xerb/remove/')) {
      const host = hostFromPath(pathname, '/__xerb/remove/');
      const project = projectByHost(host);
      if (!project) {
        sendJson(res, 404, { ok: false, reason: 'unknown host' });
        return true;
      }
      // Removing a running project stops it first: its entry is about to go,
      // and a child nothing can route to or stop again is a leak.
      stop(host, 'remove');
      await editRegistry('control:remove', (reg) => removeEntry(reg, host));
      runtime.delete(host);
      lastAccess.delete(host);
      connections.delete(host);
      log(`remove: ${host} (registry entry only; ${project.dir} untouched)`);
      sendJson(res, 200, { ok: true, host });
      return true;
    }

    if (pathname.startsWith('/__xerb/enable/') || pathname.startsWith('/__xerb/disable/')) {
      const on = pathname.startsWith('/__xerb/enable/');
      const host = hostFromPath(pathname, on ? '/__xerb/enable/' : '/__xerb/disable/');
      if (!projectByHost(host)) {
        sendJson(res, 404, { ok: false, reason: 'unknown host' });
        return true;
      }
      // Disabling stops what is running: "disabled" has to mean nothing is
      // listening, or the row lies about the state of the machine.
      if (!on) stop(host, 'disable');
      await editRegistry(`control:${on ? 'enable' : 'disable'}`, (reg) => setEnabled(reg, host, on));
      log(`${on ? 'enable' : 'disable'}: ${host}`);
      sendJson(res, 200, { ok: true, host, enabled: on });
      return true;
    }

    // POST /__xerb/archive/<host>, /__xerb/restore/<host> — a viewable's row
    // and the archived list. Restoring counts as opening it, or the next
    // sweep would put a stale page straight back.
    if (pathname.startsWith('/__xerb/archive/') || pathname.startsWith('/__xerb/restore/')) {
      const archiving = pathname.startsWith('/__xerb/archive/');
      const host = hostFromPath(pathname, archiving ? '/__xerb/archive/' : '/__xerb/restore/');
      if (!projectByHost(host)) {
        sendJson(res, 404, { ok: false, reason: 'unknown host' });
        return true;
      }
      if (archiving) stop(host, 'archive');
      else noteOpened(host);
      await editRegistry(`control:${archiving ? 'archive' : 'restore'}`, (reg) =>
        archiving ? archiveEntry(reg, host) : restoreEntry(reg, host));
      flushOpened();
      log(`${archiving ? 'archive' : 'restore'}: ${host}`);
      sendJson(res, 200, { ok: true, host, archived: archiving });
      return true;
    }

    // POST /__xerb/delete/<host> — the one route that touches a folder. Only
    // an archived viewable, only a folder strictly inside the viewables root,
    // and the folder goes to the Trash (see trashFolder).
    if (pathname.startsWith('/__xerb/delete/')) {
      const host = hostFromPath(pathname, '/__xerb/delete/');
      const project = projectByHost(host);
      if (!project) {
        sendJson(res, 404, { ok: false, reason: 'unknown host' });
        return true;
      }
      if (!isViewable(project) || !isArchived(project)) {
        sendJson(res, 409, { ok: false, reason: 'only an archived viewable can be deleted; use remove for a project' });
        return true;
      }
      stop(host, 'delete');
      let where = null;
      if (fs.existsSync(project.dir)) {
        try {
          where = trashFolder(project.dir, VIEWABLES_ROOT);
        } catch (err) {
          sendJson(res, 409, { ok: false, reason: err.message });
          return true;
        }
      }
      await editRegistry('control:delete', (reg) => removeEntry(reg, host));
      runtime.delete(host);
      lastAccess.delete(host);
      connections.delete(host);
      delete opened[host];
      openedDirty = true;
      flushOpened();
      log(`delete: ${host} (${where ? (where.trashed ? `folder moved to ${where.trashed}` : `folder deleted`) : 'folder already gone'})`);
      sendJson(res, 200, { ok: true, host, ...(where || {}) });
      return true;
    }

    // POST /__xerb/set/<host> { port?, startCmd? } — the row's edit panel.
    if (pathname.startsWith('/__xerb/set/')) {
      const host = hostFromPath(pathname, '/__xerb/set/');
      const project = projectByHost(host);
      if (!project) {
        sendJson(res, 404, { ok: false, reason: 'unknown host' });
        return true;
      }
      const body = (await readJsonBody(req)) || {};
      if (rejectUnknown(res, body, ['port', 'startCmd'])) return true;
      const wantsPort = body.port !== undefined && body.port !== null && body.port !== '';
      const wantsCmd = typeof body.startCmd === 'string' && body.startCmd.trim() !== '';
      if (!wantsPort && !wantsCmd) {
        sendJson(res, 400, { ok: false, reason: 'nothing to change' });
        return true;
      }
      if (wantsPort && Number(body.port) !== project.port) {
        // A live server is bound to the OLD port; moving the entry under it
        // would leave the daemon proxying to a port the registry no longer
        // names. The fix is one word long, so the message is the fix.
        const r = runtime.get(host);
        if (r && (r.state === 'running' || r.state === 'starting' || r.state === 'installing')) {
          sendJson(res, 409, { ok: false, reason: `${host} is running; stop it first` });
          return true;
        }
        if (await portListening(Number(body.port))) {
          sendJson(res, 409, { ok: false, reason: `port ${body.port} is in use right now` });
          return true;
        }
      }
      // Port first: setStartCmd expands a <port> placeholder against the
      // entry's port, which must already be the new one.
      const entry = await editRegistry('control:set', (reg) => {
        let e;
        if (wantsPort) e = setPort(reg, host, Number(body.port));
        if (wantsCmd) e = setStartCmd(reg, host, body.startCmd);
        return e;
      });
      // A start command changed under a running server applies at its next
      // start; nothing is killed here, because the person editing the command
      // is usually fixing a start that already failed.
      log(`set: ${host} :${entry.port} ${entry.startCmd}`);
      sendJson(res, 200, { ok: true, host, port: entry.port, startCmd: entry.startCmd });
      return true;
    }

    // POST /__xerb/restart/<host> — the row's restart button, and what the
    // CLI's `xerb restart` should call instead of stop-then-up (one call,
    // one log separator).
    if (pathname.startsWith('/__xerb/restart/')) {
      const host = hostFromPath(pathname, '/__xerb/restart/');
      const project = projectByHost(host);
      if (!project) {
        sendJson(res, 404, { ok: false, reason: 'unknown host' });
        return true;
      }
      if (project.enabled === false) {
        sendJson(res, 409, { ok: false, reason: 'disabled' });
        return true;
      }
      stop(host, 'restart');
      await waitForPortFree(project.port, 5000);
      // A restart is as deliberate as the switch, so it re-arms a dependency
      // install that ensureUp is otherwise skipping.
      getRuntime(host).installFailed = null;
      try {
        await ensureUp(project);
        sendJson(res, 200, { ok: true, host });
      } catch (err) {
        sendJson(res, 502, { ok: false, reason: err.code || err.message });
      }
      return true;
    }

    return false;
  } catch (err) {
    if (err instanceof RegistryError) {
      sendRegistryError(res, err);
      return true;
    }
    log(`control: ${pathname} failed: ${err.message}`);
    sendJson(res, 500, { ok: false, reason: err.message });
    return true;
  }
}

async function handleControl(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  // Dashboard home (host key === xerb, path /)
  if (method === 'GET' && (pathname === '/' || pathname === '')) {
    return sendHtml(res, 200, 'xerb', dashboardHtml());
  }

  if (method === 'GET' && pathname === '/__xerb/status') {
    return sendJson(res, 200, statusPayload(isControlAuthorized(req)));
  }

  // GET /__xerb/tail — the wake page's terminal view. Host-scoped and
  // tokenless for the same reasons as POST /__xerb/free: the person staring
  // at a slow start is standing on the project's origin, where the dashboard's
  // token cannot reach; the same-origin policy keeps other sites from reading
  // the response; and a local same-user process could already read the log
  // file directly. Returns the live phase plus the log tail, so the page can
  // say WHY a start is slow, not just that it is.
  if (method === 'GET' && pathname === '/__xerb/tail') {
    if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, reason: 'unauthorized' });
    const key = resolveHostKey(String(req.headers.host || ''));
    const project = key ? projectByHost(key) : null;
    if (!project) return sendJson(res, 404, { ok: false, reason: 'not a project host' });
    const r = getRuntime(project.host);
    // Default: this attempt only (the lines after the last separator), because
    // the question the panel answers is "what did the run I am watching say".
    // ?all=1 hands back the whole file, separators included, for the times the
    // interesting line is in the run before this one.
    const all = url.searchParams.get('all') === '1';
    return sendJson(res, 200, { ok: true, state: r.state, phase: phaseLabel(r), all, tail: tailLog(project.host, all ? 400 : 60, { all }) });
  }

  // GET /__xerb/vendor/<file> — the two xterm files the terminal panel
  // needs, straight off disk. Ungated like the dashboard itself: these are
  // published npm bytes, identical on every machine, and the panel they draw is
  // useless without the token anyway (the socket checks it).
  if ((method === 'GET' || method === 'HEAD') && pathname.startsWith(VENDOR_PATH)) {
    return sendVendorFile(req, res, pathname);
  }

  // GET /term/<host> — the panel's "pop out" target: one terminal, its own tab.
  // On the control plane, so it carries the same token the dashboard does.
  if (method === 'GET' && pathname.startsWith('/term/')) {
    let host = pathname.slice('/term/'.length);
    try {
      host = decodeURIComponent(host);
    } catch {
      /* keep the raw value; the lookup below fails it */
    }
    const project = host ? projectByHost(host) : null;
    if (!project) {
      return sendHtml(res, 404, 'xerb — not found', `<h1>xerb</h1><p class="muted">No project registered as <code>${esc(host)}</code>.</p>${dashboardHomeLink()}`);
    }
    return sendHtml(res, 200, `${project.host} — terminal`, termPageHtml(project));
  }

  // One guard for every mutating control action: reject any POST /__xerb/*
  // that is not both same-origin AND carrying the capability token. GET / and
  // GET /__xerb/status stay ungated so the CLI's read path and the dashboard
  // load keep working; status answers a tokenless caller with the fields that
  // name no secret and redacts the rest (see liveState), because that route is
  // reachable from every project origin, not just this one. The one exemption is
  // the exact path /__xerb/free (its handler explains why); the token-gated
  // /__xerb/free/<host> form still falls under this guard.
  if (method === 'POST' && pathname.startsWith('/__xerb/') && pathname !== '/__xerb/free' && !isControlAuthorized(req)) {
    return sendJson(res, 403, { ok: false, reason: 'unauthorized' });
  }

  if (method === 'POST' && pathname === '/__xerb/reload') {
    const ok = loadConfig('control:reload');
    return sendJson(res, ok ? 200 : 500, { ok });
  }

  if (method === 'POST' && pathname.startsWith('/__xerb/stop/')) {
    const host = decodeURIComponent(pathname.slice('/__xerb/stop/'.length));
    const result = stop(host, 'control');
    return sendJson(res, 200, result);
  }

  if (method === 'POST' && pathname.startsWith('/__xerb/up/')) {
    const host = decodeURIComponent(pathname.slice('/__xerb/up/'.length));
    const project = projectByHost(host);
    if (!project) return sendJson(res, 404, { ok: false, reason: 'unknown host' });
    if (project.enabled === false) return sendJson(res, 409, { ok: false, reason: 'disabled' });
    try {
      // Flipping the dashboard switch is as deliberate as clicking Retry, so it
      // re-arms a dependency install that ensureUp is otherwise skipping.
      getRuntime(host).installFailed = null;
      await ensureUp(project);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 502, { ok: false, reason: err.code || err.message });
    }
  }

  // POST /__xerb/free — the conflict page's button. Host-scoped: it acts on
  // the project whose host the request ARRIVED on, so a page served on
  // proj.localhost can free proj's port and nobody else's. This is the one
  // mutating action without the capability token, because the token lives only
  // in the dashboard's origin and the person who needs this fix is standing on
  // the project's origin, where it can never reach. Tokenless is sound here:
  // the same-origin check pins browser callers to pages xerb itself served
  // on this host, a non-browser local caller could already kill the user's own
  // processes without our help, and freePort refuses to touch any listener
  // except a cwd-verified squatter, checked again at click time.
  if (method === 'POST' && pathname === '/__xerb/free') {
    if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, reason: 'unauthorized' });
    const key = resolveHostKey(String(req.headers.host || ''));
    const project = key ? projectByHost(key) : null;
    if (!project) return sendJson(res, 404, { ok: false, reason: 'not a project host' });
    const result = await freePort(project, getRuntime(project.host));
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  // POST /__xerb/free/<host> — the dashboard's form of the same action,
  // token-gated by the blanket guard above. Frees the port and immediately
  // re-arms bring-up: the dashboard user who clicked "free port" wants the
  // project running, not merely unblocked.
  if (method === 'POST' && pathname.startsWith('/__xerb/free/')) {
    const host = decodeURIComponent(pathname.slice('/__xerb/free/'.length));
    const project = projectByHost(host);
    if (!project) return sendJson(res, 404, { ok: false, reason: 'unknown host' });
    const result = await freePort(project, getRuntime(project.host));
    if (result.ok && project.enabled !== false) ensureUp(project).catch(() => {});
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  // Rename a project: the dashboard's inline editor POSTs { to }. The daemon
  // rewrites the registry file itself because that file is the single source
  // of truth — a rename that only touched in-memory state would be undone by
  // the next reload, and a later rescan preserves the new name through the
  // ordinary host-merge path.
  if (method === 'POST' && pathname.startsWith('/__xerb/rename/')) {
    const from = decodeURIComponent(pathname.slice('/__xerb/rename/'.length));
    const body = await readJsonBody(req);
    const to = body && typeof body.to === 'string' ? body.to.trim() : '';
    const project = projectByHost(from);
    if (!project) return sendJson(res, 404, { ok: false, reason: 'unknown host' });
    // Same shape sanitizeHost produces: a DNS label, lowercase.
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(to)) {
      return sendJson(res, 400, { ok: false, reason: 'lowercase letters, digits, and hyphens only' });
    }
    if (to === 'xerb') return sendJson(res, 400, { ok: false, reason: '"xerb" is the dashboard' });
    if (to === from) return sendJson(res, 200, { ok: true, host: to });
    if (projectByHost(to)) return sendJson(res, 409, { ok: false, reason: `"${to}" is taken` });
    // The runtime record is keyed by host, so an owned running server is
    // stopped and the next hit on the new URL is an ordinary cold start.
    // stop() no-ops (with reason) for external/stopped — exactly right here.
    stop(from, 'rename');
    runtime.delete(from);
    lastAccess.delete(from);
    // The checks above already rejected everything renameEntry rejects, with
    // the status codes this endpoint promises; a throw from here is the file
    // disagreeing with the loaded config, which is a 500, not a user error.
    try {
      await editRegistry('control:rename', (reg) => renameEntry(reg, from, to));
    } catch (err) {
      if (err instanceof RegistryError) return sendJson(res, 500, { ok: false, reason: err.message });
      throw err;
    }
    log(`rename: ${from} -> ${to}`);
    return sendJson(res, 200, { ok: true, host: to });
  }

  // Section 7's edits: add, remove, enable, disable, set, restart, detect. Past
  // the token guard above, like every other mutating action.
  if (method === 'POST' && (await handleEditControl(req, res, url))) return;

  // GET requests to /__xerb/* that aren't matched, or anything else.
  return sendHtml(res, 404, 'xerb — not found', `<h1>xerb</h1><p class="muted">No such control endpoint: <code>${esc(method)} ${esc(pathname)}</code></p>${dashboardHomeLink()}`);
}

function dashboardHomeLink() {
  return `<p><a href="${esc(frontUrl('xerb'))}/">&larr; xerb dashboard</a></p>`;
}

// Badge classes live in dashboardHtml's <style>; the poll script rebuilds the
// same markup client-side, so label/class logic changed here must change there.
// A stopped project that carries a lastError is 'failed', not 'sleeping'. The
// dashboard used to show a dead dev server as asleep and you only found out by
// opening the URL. Same rule as phaseLabel, so page and dashboard agree.
function stateBadge(state, owned, lastError) {
  const known = ['running', 'starting', 'installing', 'conflict'];
  const k = state === 'running' && !owned ? 'external'
    : state === 'stopped' && lastError ? 'failed'
    : known.includes(state) ? state : 'stopped';
  const label = k === 'external' ? 'running (external)' : k === 'stopped' ? 'sleeping' : k;
  const title = k === 'failed' && lastError && lastError.kind ? ` title="${esc(lastError.kind)}"` : '';
  return `<span class="badge b-${k}"${title}>${label}</span>`;
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

// Coarse "how long ago" for the viewables shelves, where days are the unit
// that matters (the archive clock is counted in them).
function fmtAgo(ms) {
  if (ms == null || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Terminal panel: the vendored xterm files, the client that drives them, and
// the pop-out page (spec 0.3.0 section 6)
// ---------------------------------------------------------------------------

// GET /__xerb/vendor/<file>. xterm.js, its stylesheet, and the fit addon are
// checked into lib/vendor/ instead of being an npm dependency or a CDN link:
// the dashboard has to draw a terminal on a laptop with no network, and a
// runtime dependency would put an install step between a git pull and a working
// page. scripts/vendor.sh fetched what is in there and records the versions.
const VENDOR_PATH = '/__xerb/vendor/';
const VENDOR_DIR = path.join(CONFIG_DIR, 'lib', 'vendor');
const VENDOR_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function sendVendorFile(req, res, pathname) {
  let name = pathname.slice(VENDOR_PATH.length);
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep the raw value; the shape check below fails it */
  }
  // One flat directory of two file types, so a legal name is a plain basename
  // and nothing else: no slash, no dot segment, nothing that came in
  // percent-encoded to get past the URL parser's own normalization. The
  // dirname check below is the second lock on the same door.
  const type = VENDOR_TYPES[path.extname(name)];
  const shaped = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
  const file = path.resolve(VENDOR_DIR, shaped ? name : '.');
  if (!type || !shaped || path.dirname(file) !== VENDOR_DIR) {
    // A name that is not a plain basename is somebody probing; that is worth a
    // line. An unknown or unserved name is not: devtools asks for
    // xterm.js.map on every open panel, and the log is a thing people read.
    if (!shaped) log(`vendor-refused: ${pathname}`);
    return sendJson(res, 404, { ok: false, reason: 'no such vendor file' });
  }
  let body;
  let stat;
  try {
    stat = fs.statSync(file);
    body = fs.readFileSync(file);
  } catch {
    // Missing means lib/vendor/ was never populated (a checkout that skipped
    // scripts/vendor.sh). The panel says so on the page; here it is a 404.
    return sendJson(res, 404, { ok: false, reason: 'no such vendor file' });
  }
  // Long, because these bytes only change when someone runs scripts/vendor.sh
  // and restarts the daemon — but NOT `immutable`, because the URL carries no
  // version, so a bump has to be able to reach a tab that cached the old one.
  // The ETag makes that reload a 304 instead of 300 KB.
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = { 'content-type': type, 'cache-control': 'public, max-age=604800', etag };
  if (String(req.headers['if-none-match'] || '') === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  return res.end(req.method === 'HEAD' ? undefined : body);
}

// The browser half of the terminal, shared verbatim by the dashboard's row
// panels and the pop-out page: they differ only in where the box lives and who
// else is on the page. Both define TOKEN above this script, which is the value
// the term socket wants as its subprotocol.
function termClientScript() {
  return `
    // Loaded on the first panel anyone opens, never on page load: the dashboard
    // is a page you leave open all day and most of those days nobody asks for a
    // terminal. One promise, so ten rows opened at once load it once.
    let vendorReady = null;
    function loadTermVendor() {
      if (vendorReady) return vendorReady;
      const add = (tag, attrs) => new Promise((resolve, reject) => {
        const el = document.createElement(tag);
        Object.assign(el, attrs);
        el.onload = () => resolve();
        el.onerror = () => reject(new Error('could not load ' + (attrs.href || attrs.src)));
        document.head.append(el);
      });
      // The stylesheet and xterm.js are independent; the addon needs the global
      // xterm.js defines, so it goes after.
      vendorReady = Promise.all([
        add('link', { rel: 'stylesheet', href: '/__xerb/vendor/xterm.css' }),
        add('script', { src: '/__xerb/vendor/xterm.js' }),
      ]).then(() => add('script', { src: '/__xerb/vendor/addon-fit.js' }));
      return vendorReady;
    }

    // Dark regardless of the page theme, and that is deliberate: a dev server
    // picks its colors for a dark background, so a terminal that followed a
    // light page would render half of them unreadable.
    const TERM_THEME = {
      background: '#0d1117', foreground: '#d5dae2',
      cursor: '#d5dae2', cursorAccent: '#0d1117', selectionBackground: '#2f4f7f',
    };

    // Draw a terminal into box and wire it to the host's term socket. Returns a
    // handle: clear(), refit(), close().
    function openXerbTerm(box, host, opts) {
      opts = opts || {};
      const term = new Terminal({
        rows: opts.rows || 24,
        cols: 80,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        cursorBlink: true,
        scrollback: 5000,
        theme: TERM_THEME,
      });
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(box);
      // Pin the box to the height xterm just drew, so every later fit() changes
      // columns only. Without it the panel gains or loses a row each time the
      // browser rounds the division the other way. The pop-out passes false:
      // there the terminal is supposed to fill the window.
      if (opts.lockRows !== false) box.style.height = box.clientHeight + 'px';
      const refit = () => {
        try { fit.fit(); } catch (err) { /* not laid out yet; the next one wins */ }
        sendSize();
      };
      try { fit.fit(); } catch (err) { /* see above */ }
      term.focus();

      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      // Relative to this page's own origin: in a real install that IS
      // xerb.localhost, and in a test it is whatever port the daemon got.
      const ws = new WebSocket(proto + location.host + '/__xerb/term/' + encodeURIComponent(host), [TOKEN]);
      ws.binaryType = 'arraybuffer';
      let live = false;
      function sendSize() {
        if (!live) return;
        try { ws.send('r:' + term.rows + ',' + term.cols); } catch (err) { /* closing */ }
      }
      ws.onopen = () => {
        live = true;
        // The daemon remembers this size for the NEXT spawn too, so a restart
        // does not drop the panel back to 24x80.
        sendSize();
      };
      // Every frame is raw terminal bytes, escapes and all — that is the whole
      // point of the pty. Binary arrives as an ArrayBuffer.
      ws.onmessage = (ev) => {
        term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
      };
      ws.onerror = () => { /* onclose says the same thing, once */ };
      ws.onclose = () => {
        live = false;
        term.write('\\r\\n\\x1b[2m[xerb] terminal disconnected\\x1b[0m\\r\\n');
      };
      // xterm hands us exactly the bytes a tty would get: arrow keys, Ctrl-C,
      // a pasted block. They go through unread.
      term.onData((d) => {
        if (!live) return;
        try { ws.send('i:' + d); } catch (err) { /* closing */ }
      });
      window.addEventListener('resize', refit);
      return {
        term,
        refit,
        clear() { term.clear(); },
        close() {
          window.removeEventListener('resize', refit);
          try { ws.close(); } catch (err) { /* already gone */ }
          term.dispose();
        },
      };
    }
  `;
}

// The dark chrome around a terminal, shared by the panel and the pop-out.
function termPanelCss() {
  return `
    /* The panel is dark in both page themes; see TERM_THEME for why. */
    .termrow td { padding: 0 0.7rem 0.8rem; }
    .termpanel { border: 1px solid #ffffff24; border-radius: 10px; overflow: hidden;
                 background: #0d1117; }
    .termhead { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.5rem 0.35rem 0.7rem;
                background: #161b22; color: #d5dae2; font-size: 12px; }
    .termtitle { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .85; }
    .termbtns { margin-left: auto; white-space: nowrap; }
    .termhead .rowbtn { color: #d5dae2; border-color: #ffffff33; margin-left: 6px; }
    .termhead .rowbtn:hover { background: #ffffff14; }
    /* border-box so the height the panel pins on open (see openXerbTerm) is
       the height fit() reads back: with content-box the padding would buy an
       extra row on every refit. */
    .termbox { padding: 6px 4px 6px 8px; box-sizing: border-box; }
    .termbox .xterm { height: 100%; }
    .termfail { color: #f0a4a4; font-size: 12px; padding: 0.6rem 0.8rem; }
  `;
}

// GET /term/<host> — the pop-out. Same terminal, its own tab, nothing else on
// the page, which is what the panel's "pop out" button opens.
function termPageHtml(project) {
  const token = ensureControlToken();
  const host = project.host;
  return `<style>
    body { max-width: none; padding: 0; background: #0d1117; }
    .popwrap { display: flex; flex-direction: column; height: 100vh; }
    .popwrap .termpanel { flex: 1; display: flex; flex-direction: column;
                          border: 0; border-radius: 0; }
    .popwrap .termbox { flex: 1; min-height: 0; }
    ${termPanelCss()}
  </style>
  <div class="popwrap"><div class="termpanel">
    <div class="termhead">
      <span class="termtitle">${esc(host)}</span>
      <span class="termbtns">
        <button class="rowbtn" onclick="popAction('restart')">restart</button>
        <button class="rowbtn" onclick="popAction('stop')">stop</button>
        <button class="rowbtn" onclick="panel && panel.clear()">clear</button>
        <a class="rowbtn" href="/" style="text-decoration:none">dashboard</a>
      </span>
    </div>
    <div class="termbox" id="termbox"></div>
  </div></div>
  <script>
    const TOKEN = ${JSON.stringify(token)};
    const HOST = ${JSON.stringify(host)};
    ${termClientScript()}
    let panel = null;
    const box = document.getElementById('termbox');
    loadTermVendor().then(() => {
      panel = openXerbTerm(box, HOST, { lockRows: false });
      panel.refit();
    }).catch((err) => {
      box.innerHTML = '<p class="termfail">' + err.message + '. Run scripts/vendor.sh in the xerb checkout.</p>';
    });
    // restart and stop are the same token-gated endpoints the dashboard calls.
    async function popAction(verb) {
      try {
        await fetch('/__xerb/' + verb + '/' + encodeURIComponent(HOST), {
          method: 'POST',
          headers: { 'X-Xerb-Token': TOKEN },
        });
      } catch (err) { /* the terminal shows what happened next */ }
    }
  </script>`;
}

function dashboardHtml() {
  // The dashboard is served same-origin, so injecting the control token into its
  // inline script is safe: the browser's same-origin policy stops other sites
  // reading this HTML. The switches and the rename editor send it back as a
  // header, which authorizes their POSTs. JSON.stringify escapes it for JS use.
  const token = ensureControlToken();
  const rowFor = (p) => {
      // Authorized rows: this page is only ever served on the control host, it
      // already carries the token in its own script, and the same-origin policy
      // is what keeps another site from reading it — the same reasoning the
      // failure page uses before it prints a raw error.
      const ls = liveState(p.host, p, true);
      const on = ls.state === 'running' || ls.state === 'starting' || ls.state === 'installing';
      // The switch is inert where flipping it couldn't work: a disabled project
      // (enable it in the registry), a port conflict, and an external server
      // xerb didn't start and therefore can't stop.
      const locked = !ls.enabled || ls.state === 'conflict' || (ls.state === 'running' && !ls.owned);
      const lockReason = !ls.enabled ? 'disabled in the registry'
        : ls.state === 'conflict' ? 'free the port first'
        : ls.state === 'running' && !ls.owned ? 'started outside xerb' : '';
      // On conflict, hovering the state cell explains which foreign cwd holds it,
      // and the cell offers the fix: free the port, then start the project.
      // Mirrored client-side in stateCellHtml — change both together.
      const stateTitle = ls.state === 'conflict' && ls.conflictDir
        ? ` title="port held by ${esc(ls.conflictDir)}"`
        : '';
      const freeBtn = ls.state === 'conflict'
        ? ` <button class="freebtn" onclick="freeHost(this)">free port</button>`
        : '';
      // Failed row: the badge carries the kind as its tooltip, and the first
      // error line of this attempt's log sits next to it so the table answers
      // "what broke" without a click. Clicking it opens the row's terminal
      // panel, where the rest of the output is.
      // Mirrored client-side in stateCellHtml. Change both together.
      const errLine = ls.lastError && ls.lastError.errorLine
        ? ` <button class="errline" onclick="openTerm(this)" title="open the terminal">${esc(ls.lastError.errorLine)}</button>`
        : '';
      // target=_blank: the dashboard is the control room; opening a project
      // must not navigate away from it, and staying here is what lets the row
      // show the wake progressing. linkClicked flips the row optimistically.
      // Restart sits beside the switch, and only while there is something to
      // restart. The enable/disable button replaces the old "(disabled)" text
      // next to the link: the state it reports is now the state you change.
      const restartBtn = `<button class="rowbtn restart" title="stop it and start it again"${ls.state === 'running' ? '' : ' hidden'} onclick="restartHost(this)">restart</button>`;
      // The terminal button is on every row, running or not: opening a panel IS
      // a wake request (the socket calls ensureUp), which is the point for a
      // dev server that will not finish starting until someone answers it.
      const termBtn = `<button class="rowbtn term" title="open this project's terminal" onclick="openTerm(this)">terminal</button>`;
      const enableBtn = `<button class="rowbtn" onclick="toggleEnabled(this)">${ls.enabled ? 'disable' : 'enable'}</button>`;
      const removeBtn = `<button class="rowbtn danger" onclick="removeHost(this)">remove</button>`;
      const viewable = isViewable(p);
      // A viewable is a static page: no terminal worth opening, no enable
      // toggle (archive is its off switch). The framework cell becomes how long
      // ago it was last seen, which is what its archive clock runs from.
      const archiveBtn = `<button class="rowbtn" title="hide it in the archived list; the folder stays" onclick="archiveHost(this)">archive</button>`;
      const switchHtml = `<label class="switch"${lockReason ? ` title="${lockReason}"` : ''}><input type="checkbox" role="switch" aria-label="run ${esc(p.host)}"${on ? ' checked' : ''}${locked ? ' disabled' : ''} onchange="toggleHost(this)"><span class="track"></span></label>`;
      const actions = viewable
        ? `${restartBtn}${switchHtml}${archiveBtn}${removeBtn}`
        : `${termBtn}${restartBtn}${switchHtml}${enableBtn}${removeBtn}`;
      // A disabled project is greyed cell by cell rather than by a class on the
      // <tr>: the row tag carries data-host and nothing else, because that is
      // the handle everything else in this file (and the tests) grabs a row by.
      // Its registry values ride on the first cell, where the edit panel reads
      // them without a second request.
      const dim = ls.enabled ? '' : ' off';
      const secondCell = viewable
        ? `<td class="c-fw${dim}" title="last opened or edited">${ls.lastSeenAt ? fmtAgo(Date.now() - ls.lastSeenAt) : '—'}</td>`
        : `<td class="c-fw${dim}">${frameworkIcon(ls.framework)} ${esc(ls.framework)}</td>`;
      return `<tr data-host="${esc(p.host)}">
        <td class="c-proj${dim}" data-port="${esc(String(ls.port))}" data-cmd="${esc(ls.startCmd)}"><a href="${esc(frontUrl(p.host))}/" target="_blank" rel="noopener" onclick="linkClicked(this)">${esc(frontUrl(p.host).replace(/^https?:\/\//, ''))}</a> <button class="edit" title="edit name, port, start command" aria-label="edit ${esc(p.host)}" onclick="editHost(this)">&#9998;</button></td>
        ${secondCell}
        <td class="c-state${dim}"${stateTitle}>${stateBadge(ls.state, ls.owned, ls.lastError)}${freeBtn}${errLine}</td>
        <td class="c-idle${dim}">${ls.state === 'running' ? fmtIdle(ls.idleForMs) : '—'}</td>
        <td class="c-conn${dim}">${ls.connCount}</td>
        <td class="c-act${dim}">${actions}</td>
      </tr>`;
  };
  const rows = config.projects.filter((p) => !isViewable(p)).map(rowFor).join('');
  const liveViewables = config.projects.filter((p) => isViewable(p) && !isArchived(p));
  // Newest first: the page you were just handed is the one you are looking for.
  const seen = (p) => lastSeen(p, opened, newestFileTime);
  const viewRows = liveViewables.sort((a, b) => seen(b) - seen(a)).map(rowFor).join('');
  // Archived rows carry data-archived, not data-host, so the status poll (which
  // finds rows by data-host) leaves them alone: nothing about them is live.
  const archivedList = config.projects
    .filter(isArchived)
    .sort((a, b) => (b.archived || 0) - (a.archived || 0));
  const archivedRows = archivedList.map((p) => `<tr data-archived="${esc(p.host)}">
        <td class="c-proj off">${esc(p.host)}</td>
        <td class="off" title="${esc(p.dir)}">archived ${typeof p.archived === 'number' ? fmtAgo(Date.now() - p.archived) : ''}</td>
        <td class="c-act"><button class="rowbtn" onclick="restoreHost(this)">restore</button>${isViewable(p) ? '<button class="rowbtn danger" onclick="deleteHost(this)">delete</button>' : ''}</td>
      </tr>`).join('');

  // The ASCII LOGO stays in lib/ui.mjs for the terminal, where it is drawn with
  // a fixed cell grid. A browser is not that: every mac font stack smeared it
  // into a grey block. The word itself, set in the monospace stack, plus the
  // sleeping z's, says the same thing and survives a font substitution.
  return `<h1 class="logo">xerb<span class="zzz" aria-hidden="true">z<b>z</b><i>z</i></span></h1>
  <p class="muted">On-demand local dev proxy · uptime <span id="uptime">${fmtIdle(Date.now() - STARTED_AT)}</span> · idle sleep after ${fmtIdle(config.idleTimeoutMs)}</p>
  <style>
    .logo { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 28px;
            font-weight: 600; letter-spacing: -0.02em; color: #0891b2;
            margin: 0 0 0.35rem; }
    /* The z's drift up and grow, the way a comic draws sleep. */
    .zzz { font-size: 11px; opacity: .7; margin-left: 4px; }
    .zzz b, .zzz i { font-weight: inherit; font-style: normal; }
    .zzz b { font-size: 1.3em; vertical-align: 0.35em; }
    .zzz i { font-size: 1.7em; vertical-align: 0.75em; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { text-align: left; padding: 0.5rem 0.7rem; border-bottom: 1px solid #8884; }
    th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
    .badge { color: #fff; padding: 2px 8px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
    .b-running { background: #16a34a; } .b-external { background: #0891b2; }
    .b-starting { background: #d97706; } .b-installing { background: #7c3aed; }
    .b-conflict { background: #dc2626; } .b-stopped { background: #64748b; }
    .b-failed { background: #dc2626; }
    .errline { font: inherit; font-size: 12px; margin-left: 6px; padding: 0; border: 0;
               background: none; color: inherit; opacity: .7; cursor: pointer;
               max-width: 34ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
               vertical-align: bottom; text-align: left; }
    .errline:hover { opacity: 1; text-decoration: underline; }
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
    .freebtn { font: inherit; font-size: 12px; margin-left: 6px; padding: 1px 9px;
               border: 1px solid #8886; border-radius: 999px; background: none;
               color: inherit; cursor: pointer; white-space: nowrap; }
    .freebtn:hover { background: #8881; }
    .freebtn:disabled { opacity: .5; cursor: default; }
    .edit { border: none; background: none; cursor: pointer; opacity: 0; font: inherit; padding: 0 4px; color: inherit; }
    tr:hover .edit, .edit:focus-visible { opacity: .55; }
    .edit:hover { opacity: 1; }
    .rename { font: inherit; width: 12ch; padding: 1px 6px; border: 1px solid #8886;
              border-radius: 6px; background: transparent; color: inherit; }
    .rename.bad { border-color: #dc2626; outline: none; }
    .rowbtn { font: inherit; font-size: 12px; margin-left: 8px; padding: 1px 9px;
              border: 1px solid #8886; border-radius: 999px; background: none;
              color: inherit; cursor: pointer; white-space: nowrap; }
    .rowbtn:hover { background: #8881; }
    .rowbtn:disabled { opacity: .5; cursor: default; }
    .rowbtn.danger:hover { border-color: #dc2626; color: #dc2626; background: none; }
    .c-act { white-space: nowrap; text-align: right; }
    /* A disabled project is registered and parked: still listed, still
       editable, but nothing about it is going to run, so the switch that
       would lie about that is not drawn at all. */
    td.off { opacity: .55; }
    td.off .switch { display: none; }
    td.c-idle.off, td.c-conn.off { visibility: hidden; }
    .editrow td { padding-top: 0; }
    .editpanel { display: flex; flex-wrap: wrap; gap: 0.6rem 1.1rem; align-items: center;
                 padding: 0.1rem 0 0.45rem; font-size: 13px; }
    .editpanel label { display: inline-flex; align-items: center; gap: 0.35rem; opacity: .75; }
    .editpanel input { font: inherit; padding: 2px 6px; border: 1px solid #8886;
                       border-radius: 6px; background: transparent; color: inherit; }
    .editpanel input.bad { border-color: #dc2626; outline: none; }
    .editpanel input:disabled { opacity: .5; }
    .f-name { width: 12ch; } .f-port { width: 8ch; } .f-cmd { width: 34ch; }
    .ederr { flex-basis: 100%; margin: 0; font-size: 12px; opacity: .6; }
    .ederr.bad { opacity: 1; color: #dc2626; }
    .shelf { margin-top: 1.4rem; }
    .shelf summary { cursor: pointer; font-size: 13px; font-weight: 600; }
    .shelf summary .muted { font-weight: 400; margin-left: 0.4rem; }
    .shelf table { margin-top: 0.4rem; }
    .addbar { margin-top: 1.2rem; }
    .addbar .rowbtn { margin-left: 0; }
    /* The add form is one question first: which folder. Everything else is
       an answer the daemon can usually give, so it stays folded away until
       the folder has been read, then opens already filled in. */
    .addform { --line: #8884; --ring: #0891b2; margin-top: 0.8rem; padding: 1.1rem 1.2rem 1rem;
               border: 1px solid var(--line); border-radius: 14px; background: #8881;
               font-size: 13px; animation: addin .18s ease-out; }
    @keyframes addin { from { opacity: 0; transform: translateY(-4px); } }
    .addform .lbl { display: block; font-size: 11px; text-transform: uppercase;
                    letter-spacing: .05em; opacity: .55; margin-bottom: 0.3rem; }
    .addform .field { display: flex; align-items: center; gap: 0.45rem; padding: 0 0.7rem;
                      border: 1px solid var(--line); border-radius: 9px; background: Canvas;
                      transition: border-color .12s; }
    .addform .field:focus-within { border-color: var(--ring); }
    .addform .field.bad { border-color: #dc2626; }
    .addform .field input { flex: 1; min-width: 0; font: inherit; padding: 0.5rem 0; border: 0;
                            outline: 0; background: none; color: inherit; }
    .addform .field input::placeholder { color: inherit; opacity: .35; }
    .addform .mono, .addform .mono input { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
    .addform .affix { opacity: .45; white-space: nowrap; }
    .addform .field.url { gap: 0; }
    .addform input[type=number] { appearance: textfield; -moz-appearance: textfield; }
    .addform input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
    .dirfield { padding: 0 0.85rem; }
    .dirfield input { font-size: 14px; padding: 0.7rem 0; }
    .dirfield svg { flex: none; opacity: .5; }
    .found { flex: none; display: inline-flex; align-items: center; gap: 0.3rem; font-size: 12px;
             padding: 2px 9px 2px 5px; border-radius: 999px; background: #8882; white-space: nowrap;
             font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    .found .fwicon { margin: 0; vertical-align: 0; }
    .found[hidden] { display: none; }
    .spin { flex: none; width: 13px; height: 13px; border-radius: 50%; border: 2px solid #8885;
            border-top-color: var(--ring); animation: spin .6s linear infinite; }
    .spin[hidden] { display: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* 0fr -> 1fr animates to the content's own height without measuring it. */
    .addmore { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .22s ease; }
    .addform.ready .addmore { grid-template-rows: 1fr; }
    /* The padding is room for the focus ring, which overflow would clip. */
    .addmore > div { overflow: hidden; min-height: 0; padding: 0 4px; margin: 0 -4px; }
    .addgrid { display: grid; grid-template-columns: 1fr 1fr 7rem; gap: 0.8rem; padding-top: 0.9rem; }
    .addgrid .wide { grid-column: 1 / -1; }
    .addgrid .two { grid-column: span 2; }
    .addopts { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .2s ease; }
    .addform.opts .addopts { grid-template-rows: 1fr; }
    .addopts > div { overflow: hidden; min-height: 0; padding: 0 4px; margin: 0 -4px; }
    .choose { flex: none; font: inherit; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
              font-size: 12px; padding: 3px 10px; border-radius: 7px; border: 1px solid var(--line);
              background: none; color: inherit; cursor: pointer; }
    .choose:hover { background: #8881; }
    .linkbtn { font: inherit; font-size: 12px; padding: 0; margin-left: 0.6rem; border: 0; background: none;
               color: inherit; opacity: .5; cursor: pointer; }
    .linkbtn:hover { opacity: 1; text-decoration: underline; }
    .optbtn::before { content: '▸'; display: inline-block; margin-right: 0.35rem; font-size: 10px;
                      transition: transform .15s; }
    .addform.opts .optbtn::before { transform: rotate(90deg); }
    .addfoot .optbtn { border-color: transparent; padding-left: 0.3rem; opacity: .7; }
    @media (max-width: 620px) {
      .addgrid { grid-template-columns: 1fr; }
      .addgrid .wide, .addgrid .two { grid-column: auto; }
    }
    .addfoot { display: flex; align-items: center; gap: 0.6rem; padding: 1rem 0 4px; }
    .parklbl { display: inline-flex; justify-self: start; align-items: center; gap: 0.5rem; opacity: .8; cursor: pointer; }
    .parklbl .switch { width: 32px; height: 18px; }
    .parklbl .switch .track::after { width: 14px; height: 14px; }
    .parklbl .switch input:checked + .track { background: #64748b; }
    .parklbl .switch input:checked + .track::after { transform: translateX(14px); }
    .addfoot button { font: inherit; font-size: 13px; padding: 0.4rem 0.95rem; border-radius: 9px;
                      border: 1px solid var(--line); background: none; color: inherit; cursor: pointer; }
    .addfoot button:hover { background: #8881; }
    .addfoot .cancel { margin-left: auto; }
    .addfoot button[type=submit] { border-color: #0891b2; background: #0891b2;
                                   color: #fff; font-weight: 500; }
    .addfoot button[type=submit]:hover { background: #0e7490; border-color: #0e7490; }
    .addfoot button:disabled { opacity: .5; cursor: default; }
    .adderr { margin: 0.55rem 0 0; font-size: 12px; opacity: .6; }
    .adderr.bad { opacity: 1; color: #dc2626; }
    @media (prefers-reduced-motion: reduce) {
      .addform, .addmore, .addopts, .optbtn::before { animation: none; transition: none; }
      .spin { animation-duration: 2s; }
    }
    ${termPanelCss()}
  </style>
  <div class="addbar"><button class="rowbtn" id="addtoggle" onclick="addClick()">add project</button><button class="linkbtn" id="addtype" onclick="toggleAdd()">or type a path</button></div>
  <form class="addform" id="addform" hidden onsubmit="return submitAdd(event)">
    <label class="lbl" for="a-dir">folder</label>
    <div class="field dirfield mono" id="a-dirfield">
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.4l1.6 1.8H16a1.5 1.5 0 0 1 1.5 1.5v7.2A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
      <input type="text" id="a-dir" placeholder="~/code/app" autocomplete="off" spellcheck="false">
      <span class="spin" id="a-spin" hidden></span>
      <span class="found" id="a-found" hidden></span>
      <button type="button" class="choose" onclick="pickFolder()">choose…</button>
    </div>
    <p class="adderr" id="a-err">Choose a folder or paste its path. xerb only reads it.</p>
    <div class="addmore" id="a-more" inert><div>
      <div class="addgrid">
        <div class="wide">
          <label class="lbl" for="a-name">url</label>
          <div class="field url mono"><span class="affix">http://</span><input type="text" id="a-name" autocomplete="off" spellcheck="false"><span class="affix">.localhost</span></div>
        </div>
      </div>
      <div class="addopts" id="a-opts" inert><div>
        <div class="addgrid">
          <div class="two">
            <label class="lbl" for="a-cmd">start command</label>
            <div class="field mono"><input type="text" id="a-cmd" autocomplete="off" spellcheck="false"></div>
          </div>
          <div>
            <label class="lbl" for="a-port">port</label>
            <div class="field mono"><input type="number" id="a-port" autocomplete="off"></div>
          </div>
          <label class="parklbl wide" title="Registered and listed, but never started"><span class="switch"><input type="checkbox" id="a-parked"><span class="track"></span></span>parked</label>
        </div>
      </div></div>
      <div class="addfoot">
        <button type="button" class="optbtn" id="a-optbtn" onclick="addOpts()" aria-expanded="false">options</button>
        <button type="button" class="cancel" onclick="toggleAdd()">cancel</button>
        <button type="submit">add project</button>
      </div>
    </div></div>
  </form>
  <table>
    <thead><tr><th>Project</th><th>Framework</th><th>State</th><th>Idle</th><th>Conn</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="muted">No projects registered.</td></tr>'}</tbody>
  </table>
  ${liveViewables.length ? `<details class="shelf" id="shelf-viewables">
    <summary>viewables <span class="muted">${liveViewables.length} · archived after ${config.viewableArchiveDays} days unopened</span></summary>
    <table>
      <thead><tr><th>Viewable</th><th>Seen</th><th>State</th><th>Idle</th><th>Conn</th><th></th></tr></thead>
      <tbody>${viewRows}</tbody>
    </table>
  </details>` : ''}
  ${archivedList.length ? `<details class="shelf" id="shelf-archived">
    <summary>archived <span class="muted">${archivedList.length} · folders untouched until you delete</span></summary>
    <table><tbody>${archivedRows}</tbody></table>
  </details>` : ''}
  <script>
    const TOKEN = ${JSON.stringify(token)};
    const ON_STATES = ['running', 'starting', 'installing'];
    // host -> { on, at }: what the user just asked for, so the poll doesn't
    // snap the switch back before the daemon's state catches up.
    const pending = new Map();

    // Mirrors the server's stateBadge — change both together.
    function badgeHtml(state, owned, lastError) {
      const known = ['running', 'starting', 'installing', 'conflict'];
      const k = state === 'running' && !owned ? 'external'
        : state === 'stopped' && lastError ? 'failed'
        : known.includes(state) ? state : 'stopped';
      const label = k === 'external' ? 'running (external)' : k === 'stopped' ? 'sleeping' : k;
      const title = k === 'failed' && lastError && lastError.kind ? ' title="' + escAttr(lastError.kind) + '"' : '';
      return '<span class="badge b-' + k + '"' + title + '>' + label + '</span>';
    }

    // Mirrors the server's state cell (badge + the free-port button on
    // conflict + the failed row's first error line). Change both together.
    function stateCellHtml(state, owned, lastError) {
      let h = badgeHtml(state, owned, lastError);
      if (state === 'conflict') h += ' <button class="freebtn" onclick="freeHost(this)">free port</button>';
      if (lastError && lastError.errorLine) {
        h += ' <button class="errline" onclick="openTerm(this)" title="open the terminal">' + escAttr(lastError.errorLine) + '</button>';
      }
      return h;
    }

    function escAttr(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    ${termClientScript()}

    // --- terminal panels -----------------------------------------------------

    // host -> the handle openXerbTerm returned. One per row, so a second
    // click on the same row closes and disposes instead of stacking a second
    // terminal on the same socket. Several different rows can be open at once.
    const panels = new Map();

    // Both click targets land here: the row's terminal button and, on a failed
    // row, the error line next to the badge.
    function openTerm(el) {
      const row = el.closest('tr');
      const host = row.dataset.host;
      if (panels.has(host) || termRowFor(host)) { closeTerm(host); return; }
      const tr = document.createElement('tr');
      tr.className = 'termrow';
      tr.dataset.termHost = host;
      const td = document.createElement('td');
      td.colSpan = 6;
      td.innerHTML =
        '<div class="termpanel">' +
          '<div class="termhead">' +
            '<span class="termtitle">' + escAttr(host) + '</span>' +
            '<span class="termbtns">' +
              '<button class="rowbtn" onclick="termAction(this, \\'restart\\')">restart</button>' +
              '<button class="rowbtn" onclick="termAction(this, \\'stop\\')">stop</button>' +
              '<button class="rowbtn" onclick="termClear(this)">clear</button>' +
              '<button class="rowbtn" onclick="termPop(this)">pop out</button>' +
              '<button class="rowbtn" onclick="termClose(this)">close</button>' +
            '</span>' +
          '</div>' +
          '<div class="termbox"></div>' +
        '</div>';
      tr.append(td);
      // Under the edit panel when that one is open, so a row's two panels stay
      // in the order they were asked for.
      const edit = row.nextElementSibling;
      (edit && edit.classList.contains('editrow') ? edit : row).after(tr);
      loadTermVendor().then(() => {
        // The row may have been closed again while 300 KB loaded.
        if (!tr.isConnected) return;
        panels.set(host, openXerbTerm(td.querySelector('.termbox'), host, { rows: 24 }));
      }).catch((err) => {
        td.querySelector('.termbox').innerHTML =
          '<p class="termfail">' + escAttr(err.message) + '. Run scripts/vendor.sh in the xerb checkout.</p>';
      });
    }

    function termRowFor(host) {
      return document.querySelector('tr.termrow[data-term-host="' + CSS.escape(host) + '"]');
    }

    function hostOfPanel(btn) {
      return btn.closest('tr.termrow').dataset.termHost;
    }

    function closeTerm(host) {
      const panel = panels.get(host);
      if (panel) { panel.close(); panels.delete(host); }
      const tr = termRowFor(host);
      if (tr) tr.remove();
    }

    function termClose(btn) { closeTerm(hostOfPanel(btn)); }
    function termClear(btn) {
      const panel = panels.get(hostOfPanel(btn));
      if (panel) panel.clear();
    }

    // Pop out to this page's own origin: in an install that is
    // http://xerb.localhost/term/<host>, and in a test it is whatever port
    // the daemon got. Closing the panel behind it keeps one terminal per host.
    function termPop(btn) {
      const host = hostOfPanel(btn);
      closeTerm(host);
      window.open('/term/' + encodeURIComponent(host), '_blank', 'noopener');
    }

    // restart and stop from the panel header. The daemon echoes its own
    // separator line into the terminal, so nothing is written here: what the
    // panel shows is what actually happened.
    async function termAction(btn, verb) {
      const host = hostOfPanel(btn);
      btn.disabled = true;
      if (verb === 'restart') pending.set(host, { on: true, at: Date.now() });
      const j = await post('/__xerb/' + verb + '/' + encodeURIComponent(host));
      btn.disabled = false;
      if (!j.ok) btn.title = j.reason || (verb + ' failed');
      schedulePoll(300);
    }

    // The conflict fix: free the port, and the endpoint re-arms bring-up, so
    // one click takes the row from conflict to starting to running.
    async function freeHost(btn) {
      const row = btn.closest('tr');
      const host = row.dataset.host;
      btn.disabled = true;
      btn.textContent = 'freeing…';
      try {
        const res = await fetch('/__xerb/free/' + encodeURIComponent(host), {
          method: 'POST',
          headers: { 'X-Xerb-Token': TOKEN },
        });
        const j = await res.json();
        if (j.ok) {
          pending.set(host, { on: true, at: Date.now() });
          row.querySelector('.c-state').innerHTML = stateCellHtml('starting', true);
          return;
        }
        btn.textContent = j.reason || 'failed';
      } catch (err) {
        btn.textContent = 'daemon unreachable';
      }
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
      schedulePoll(400);
      fetch('/__xerb/' + (on ? 'up/' : 'stop/') + encodeURIComponent(host), {
        method: 'POST',
        headers: { 'X-Xerb-Token': TOKEN },
      }).catch(() => {});
    }

    // Clicking a sleeping project's link IS a wake request — show it starting
    // now, not a poll from now. The disabled switch screens out rows a click
    // cannot wake (registry-disabled, conflict, external), and only a
    // 'sleeping' badge flips, so a running project's row is left alone.
    function linkClicked(a) {
      const row = a.closest('tr');
      const sw = row.querySelector('.switch input');
      if (sw && sw.disabled) return;
      const badge = row.querySelector('.badge');
      if (!badge || badge.textContent !== 'sleeping') return;
      pending.set(row.dataset.host, { on: true, at: Date.now() });
      row.querySelector('.c-state').innerHTML = stateCellHtml('starting', true);
      if (sw) sw.checked = true;
      schedulePoll(400); // catch the real phase (installing vs starting) fast
    }

    // Every mutating call carries the capability token and never throws: a
    // daemon that went away is just another inline message.
    async function post(pathname, body) {
      const headers = { 'X-Xerb-Token': TOKEN };
      if (body !== undefined) headers['content-type'] = 'application/json';
      try {
        const res = await fetch(pathname, {
          method: 'POST',
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        try {
          return await res.json();
        } catch (err) {
          return { ok: res.ok, reason: 'the daemon answered ' + res.status };
        }
      } catch (err) {
        return { ok: false, reason: 'daemon unreachable' };
      }
    }

    // The row's registry values (port, start command) ride on its first cell;
    // the <tr> carries data-host and nothing else. See the server's comment.
    function rowData(row) {
      return row.querySelector('.c-proj').dataset;
    }

    // Is this row's dev server up or coming up? The badge is the truth the
    // page already shows, so read it instead of keeping a second copy.
    function rowBusy(row) {
      const badge = row.querySelector('.badge');
      const label = badge ? badge.textContent : '';
      return label === 'running' || label === 'running (external)' || label === 'starting' || label === 'installing';
    }

    // Stop and start again in one call, so the log gets one separator and the
    // daemon owns the wait for the old port to go quiet.
    async function restartHost(btn) {
      const row = btn.closest('tr');
      const host = row.dataset.host;
      btn.disabled = true;
      btn.textContent = 'restarting…';
      pending.set(host, { on: true, at: Date.now() });
      row.querySelector('.c-state').innerHTML = stateCellHtml('starting', true);
      schedulePoll(400);
      const j = await post('/__xerb/restart/' + encodeURIComponent(host));
      btn.disabled = false;
      btn.textContent = 'restart';
      if (!j.ok) btn.title = j.reason || 'restart failed';
      schedulePoll(200);
    }

    // enable / disable. Both change the shape of the row (the switch appears or
    // goes, the greying flips), so the answer is a reload rather than six lines
    // of DOM surgery that would have to mirror the server's markup.
    async function toggleEnabled(btn) {
      const row = btn.closest('tr');
      const host = row.dataset.host;
      const enable = row.querySelector('.c-proj').classList.contains('off');
      btn.disabled = true;
      const j = await post('/__xerb/' + (enable ? 'enable/' : 'disable/') + encodeURIComponent(host));
      if (j.ok) { location.reload(); return; }
      btn.disabled = false;
      btn.title = j.reason || 'failed';
    }

    // The confirm names the host and says what is NOT deleted, because that is
    // the question anyone hesitates over: the folder stays exactly where it is.
    async function removeHost(btn) {
      const row = btn.closest('tr');
      const host = row.dataset.host;
      if (!confirm('Remove ' + host + ' from xerb?\\n\\nThis deletes the registry entry only. The project folder on disk is never touched, and you can add it back any time.')) return;
      btn.disabled = true;
      const j = await post('/__xerb/remove/' + encodeURIComponent(host));
      if (j.ok) { location.reload(); return; }
      btn.disabled = false;
      btn.title = j.reason || 'failed';
    }

    // Viewables shelves. Archive and restore change which table a row lives
    // in, so like enable/disable the answer is a reload. Delete is the one
    // action on this page that touches a folder, so its confirm says where the
    // folder goes.
    async function archiveHost(btn) {
      btn.disabled = true;
      const j = await post('/__xerb/archive/' + encodeURIComponent(btn.closest('tr').dataset.host));
      if (j.ok) { location.reload(); return; }
      btn.disabled = false;
      btn.title = j.reason || 'failed';
    }
    async function restoreHost(btn) {
      btn.disabled = true;
      const j = await post('/__xerb/restore/' + encodeURIComponent(btn.closest('tr').dataset.archived));
      if (j.ok) { location.reload(); return; }
      btn.disabled = false;
      btn.title = j.reason || 'failed';
    }
    async function deleteHost(btn) {
      const host = btn.closest('tr').dataset.archived;
      if (!confirm('Delete ' + host + '?\\n\\nThis removes it from xerb and moves its folder to the Trash.')) return;
      btn.disabled = true;
      const j = await post('/__xerb/delete/' + encodeURIComponent(host));
      if (j.ok) { location.reload(); return; }
      btn.disabled = false;
      btn.title = j.reason || 'failed';
    }
    // Remember which shelves are open across the reloads the actions above do.
    for (const d of document.querySelectorAll('details.shelf')) {
      try { if (localStorage.getItem('xerb:' + d.id) === '1') d.open = true; } catch {}
      d.addEventListener('toggle', () => {
        try { localStorage.setItem('xerb:' + d.id, d.open ? '1' : '0'); } catch {}
      });
    }

    // The pencil opens one panel under the row holding everything the registry
    // has for it. Enter saves the field you are in, Esc closes — the two keys
    // rename has always used. Clicking the pencil again closes it, so nothing
    // here hangs off blur: tabbing between three fields would fight it.
    function editHost(btn) {
      const row = btn.closest('tr');
      const open = row.nextElementSibling;
      if (open && open.classList.contains('editrow')) { open.remove(); return; }
      const host = row.dataset.host;
      const busy = rowBusy(row);
      const tr = document.createElement('tr');
      tr.className = 'editrow';
      const td = document.createElement('td');
      td.colSpan = 6;
      td.innerHTML =
        '<div class="editpanel">' +
          '<label>name <input class="f-name" value="' + escAttr(host) + '" aria-label="new name" spellcheck="false"><span class="muted">.localhost</span></label>' +
          '<label>port <input class="f-port" type="number" value="' + escAttr(rowData(row).port) + '" aria-label="port"' + (busy ? ' disabled' : '') + '></label>' +
          '<label>start command <input class="f-cmd" value="' + escAttr(rowData(row).cmd) + '" aria-label="start command" spellcheck="false"></label>' +
          '<p class="ederr"></p>' +
        '</div>';
      tr.append(td);
      row.after(tr);

      const hint = busy
        ? 'Enter saves, Esc cancels. The port cannot move while it runs: stop it first.'
        : 'Enter saves, Esc cancels.';
      const note = td.querySelector('.ederr');
      note.textContent = hint;
      const close = () => { tr.remove(); row.querySelector('.edit').focus(); };
      const fail = (input, msg) => {
        input.classList.add('bad');
        note.classList.add('bad');
        note.textContent = msg;
      };

      const saveName = async (input) => {
        const to = input.value.trim();
        if (to === host) return close();
        if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(to) || to === 'xerb') {
          return fail(input, 'lowercase letters, digits, and hyphens');
        }
        const j = await post('/__xerb/rename/' + encodeURIComponent(host), { to });
        if (j.ok) { location.reload(); return; }
        fail(input, j.reason || 'rename failed');
      };
      const savePort = async (input) => {
        const port = Number(input.value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(input, 'port must be 1-65535');
        if (port === Number(rowData(row).port)) return close();
        const j = await post('/__xerb/set/' + encodeURIComponent(host), { port });
        if (j.ok) { location.reload(); return; }
        fail(input, j.reason || 'could not set the port');
      };
      const saveCmd = async (input) => {
        const startCmd = input.value.trim();
        if (!startCmd) return fail(input, 'a start command is required');
        if (startCmd === rowData(row).cmd) return close();
        const j = await post('/__xerb/set/' + encodeURIComponent(host), { startCmd });
        if (j.ok) { location.reload(); return; }
        fail(input, j.reason || 'could not set the start command');
      };

      const wire = (sel, save) => {
        const input = td.querySelector(sel);
        input.onkeydown = (e) => {
          if (e.key === 'Escape') return close();
          if (e.key !== 'Enter') {
            input.classList.remove('bad');
            note.classList.remove('bad');
            note.textContent = hint;
            return;
          }
          e.preventDefault();
          save(input);
        };
        return input;
      };
      wire('.f-port', savePort);
      wire('.f-cmd', saveCmd);
      const name = wire('.f-name', saveName);
      name.focus();
      name.select();
    }

    // --- add project ---------------------------------------------------------

    const addForm = document.getElementById('addform');
    const addErr = document.getElementById('a-err');
    const ADD_HINT = addErr.textContent;
    // Fields the user typed into: a later detect must not overwrite them.
    const typed = new Set();
    for (const id of ['a-name', 'a-cmd', 'a-port']) {
      document.getElementById(id).addEventListener('input', (e) => typed.add(e.target.id));
    }

    const FW_ICONS = ${JSON.stringify(Object.fromEntries(
      ['next', 'vite', 'cra', 'astro', 'remix', 'sveltekit', 'rails', 'django', 'node', 'static'].map((fw) => [fw, frameworkIcon(fw)]),
    ))};
    const dirEl = document.getElementById('a-dir');
    const dirField = document.getElementById('a-dirfield');
    const addMore = document.getElementById('a-more');
    const addSpin = document.getElementById('a-spin');
    const addFound = document.getElementById('a-found');

    function toggleAdd() {
      addForm.hidden = !addForm.hidden;
      document.getElementById('addtoggle').textContent = addForm.hidden ? 'add project' : 'close';
      document.getElementById('addtype').hidden = !addForm.hidden;
      if (!addForm.hidden) dirEl.focus();
    }

    // The button goes straight to Finder: for most projects the only thing
    // worth asking is which folder, and the form that follows arrives filled.
    function addClick() {
      if (addForm.hidden) pickFolder();
      else toggleAdd();
    }

    let picking = false;
    async function pickFolder() {
      if (picking) return;
      picking = true;
      const j = await post('/__xerb/pick', {});
      picking = false;
      if (j.canceled) return;
      if (addForm.hidden) toggleAdd();
      if (!j.ok) { addSay(j.reason || 'could not open a folder dialog', true); return; }
      dirEl.value = j.dir;
      clearTimeout(detectTimer);
      detectDir(false);
    }

    // Start command, port and parked are answers the detector already gave;
    // they stay folded unless someone asks, or unless it had no answer.
    function addOpts(on) {
      const open = on === undefined ? !addForm.classList.contains('opts') : on;
      addForm.classList.toggle('opts', open);
      document.getElementById('a-opts').inert = !open;
      document.getElementById('a-optbtn').setAttribute('aria-expanded', String(open));
    }

    function addSay(msg, bad) {
      addErr.textContent = msg;
      addErr.classList.toggle('bad', !!bad);
    }

    // The rest of the form is inert while folded, so Tab cannot land in a
    // field nobody can see.
    function addReady(on) {
      addForm.classList.toggle('ready', on);
      addMore.inert = !on;
    }

    // Asks the daemon what the folder proves and fills in every field the user
    // has not touched. The same detectors "xerb add" runs, so the form and the
    // CLI agree about what a folder is before anything is written. It runs as
    // the path is typed; "quiet" is that case, where a path that does not
    // exist yet is a path half typed, not a mistake to paint red.
    let detectSeq = 0;
    let detectedDir = null;
    async function detectDir(quiet) {
      const dir = dirEl.value.trim();
      if (!dir || dir === detectedDir) return;
      const seq = ++detectSeq;
      addSpin.hidden = false;
      const j = await post('/__xerb/detect', { dir });
      // A slower answer about an older path must not overwrite a newer one.
      if (seq !== detectSeq) return;
      addSpin.hidden = true;
      if (!j.ok) {
        detectedDir = null;
        addFound.hidden = true;
        if (quiet) return;
        dirField.classList.add('bad');
        addSay(j.reason || 'could not read that folder', true);
        return;
      }
      detectedDir = dir;
      dirField.classList.remove('bad');
      const fill = (id, value) => {
        if (typed.has(id) || value === null || value === undefined || value === '') return;
        document.getElementById(id).value = value;
      };
      fill('a-name', j.name);
      fill('a-port', j.port);
      fill('a-cmd', j.startCmd);
      addFound.hidden = !j.startCmd;
      if (j.startCmd) {
        addFound.innerHTML = (FW_ICONS[j.framework] || '') + escAttr(j.framework);
        addSay('Detected ' + j.framework + '. Change anything before you add it.');
      } else {
        addSay('Nothing provable there (looked for ' + (j.evidence || []).map((e) => e[0]).join(', ') + '). Type a start command.', true);
      }
      addReady(true);
      if (!j.startCmd) addOpts(true);
      if (!quiet) (j.startCmd ? addForm.querySelector('button[type=submit]') : document.getElementById('a-cmd')).focus();
    }

    let detectTimer = null;
    dirEl.addEventListener('input', () => {
      dirField.classList.remove('bad');
      if (addErr.classList.contains('bad')) addSay(ADD_HINT);
      clearTimeout(detectTimer);
      const v = dirEl.value.trim();
      // Only a path the daemon would accept is worth a round trip.
      if (v[0] !== '/' && v[0] !== '~') return;
      detectTimer = setTimeout(() => detectDir(true), 350);
    });
    dirEl.addEventListener('change', () => { clearTimeout(detectTimer); detectDir(false); });
    dirEl.addEventListener('keydown', (e) => {
      // Enter in the folder field means "look at this folder", not "submit".
      if (e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(detectTimer);
      detectDir(false);
    });

    async function submitAdd(e) {
      e.preventDefault();
      const btn = addForm.querySelector('button[type=submit]');
      btn.disabled = true;
      addSay('adding…');
      const j = await post('/__xerb/add', {
        dir: document.getElementById('a-dir').value.trim(),
        name: document.getElementById('a-name').value.trim(),
        startCmd: document.getElementById('a-cmd').value.trim(),
        port: document.getElementById('a-port').value.trim(),
        parked: document.getElementById('a-parked').checked,
      });
      if (j.ok) { location.reload(); return false; }
      btn.disabled = false;
      addSay(j.reason || 'could not add it', true);
      return false;
    }

    async function poll() {
      try {
        // With the token, because the payload's start command and failure
        // detail are served only to a caller that has it, and this table shows
        // both. Same header every mutating call here sends.
        const res = await fetch('/__xerb/status', { cache: 'no-store', headers: { 'X-Xerb-Token': TOKEN } });
        if (!res.ok) return;
        const data = await res.json();
        document.getElementById('uptime').textContent = fmtIdle(data.uptimeMs);
        for (const p of data.projects) {
          const row = document.querySelector('tr[data-host="' + CSS.escape(p.host) + '"]');
          if (!row) continue;
          // The registry can change under us (the CLI writes the same file), so
          // keep the edit panel's prefill fresh — unless the panel is open, in
          // which case the values must not shift while someone types in them.
          const editing = row.nextElementSibling && row.nextElementSibling.classList.contains('editrow');
          if (!editing) {
            const data = rowData(row);
            data.port = p.port;
            data.cmd = p.startCmd || '';
          }
          const on = ON_STATES.includes(p.state);
          const pend = pending.get(p.host);
          if (pend && Date.now() - pend.at < 10000 && on !== pend.on) continue;
          pending.delete(p.host);
          row.querySelector('.c-state').innerHTML = stateCellHtml(p.state, p.owned, p.lastError);
          row.querySelector('.c-idle').textContent = p.state === 'running' ? fmtIdle(p.idleForMs) : '—';
          row.querySelector('.c-conn').textContent = p.connCount;
          // Restart only makes sense against something that is running.
          const rb = row.querySelector('.restart');
          if (rb && document.activeElement !== rb) rb.hidden = p.state !== 'running';
          const sw = row.querySelector('.switch input');
          if (sw && document.activeElement !== sw) {
            sw.checked = on;
            sw.disabled = !p.enabled || p.state === 'conflict' || (p.state === 'running' && !p.owned);
          }
        }
      } catch (err) { /* daemon momentarily unreachable; keep polling */ }
    }

    // Adaptive cadence: fast while anything is in flight (a wake the user just
    // clicked, an install, a start), settled otherwise. One self-scheduling
    // timer instead of setInterval so an action can pull the next poll forward.
    let pollTimer = null;
    function schedulePoll(ms) {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(runPoll, ms);
    }
    async function runPoll() {
      await poll();
      const busy = pending.size > 0 || !!document.querySelector('.b-starting, .b-installing');
      schedulePoll(busy ? 700 : 2000);
    }
    schedulePoll(700);
    // Coming back to the tab deserves fresh truth immediately.
    window.addEventListener('focus', () => schedulePoll(0));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(0); });
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
    cs.__xerbRec = rec;
    cs.once('close', () => removeConn(host, rec));
    // A single 'data' listener keeps lastByteAt fresh on real traffic; a truly
    // silent keep-alive socket ages past the hard cap and stops deferring.
    cs.on('data', () => {
      rec.lastByteAt = Date.now();
    });
  }
  if (cs && cs.__xerbRec) cs.__xerbRec.lastByteAt = Date.now();

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
      clearAdoption(r);
      r.lastError = { code: err.code, kind: 'exited', message: `upstream ${upHost}:${project.port} stopped answering`, at: Date.now(), exitCode: null };
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
        'xerb — upstream error',
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
    // .catch, not try/catch: handleRequest is async, so anything it throws past
    // its first await comes back as a rejected promise. A plain try/catch here
    // saw none of it, and the request was left hanging with no response at all
    // (the only trace was an unhandledRejection line in daemon.log). Same shape
    // as the upgrade handler below.
    Promise.resolve()
      .then(() => handleRequest(req, res))
      .catch((err) => {
        log(`request-handler crash: ${err && err.stack ? err.stack : err}`);
        try {
          if (!res.headersSent) {
            sendHtml(res, 500, 'xerb — error', `<h1>Internal error</h1><pre>${esc(String(err && err.message))}</pre>`);
          } else {
            res.destroy();
          }
        } catch {
          /* ignore */
        }
      });
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

  // Control plane: key === xerb OR path starts with /__xerb/.
  // Control plane: the xerb host, a host naming no project (bare localhost
  // or an IP literal — serve the dashboard rather than a 502), or /__xerb/.
  if (key === 'xerb' || key === null || url.pathname.startsWith('/__xerb/')) {
    return handleControl(req, res, url);
  }

  const project = projectByHost(key);
  if (!project) {
    return sendHtml(
      res,
      502,
      'xerb — no such project',
      `<h1>No project for <code>${esc(key)}</code></h1>
       <p>Nothing is registered under that host. Available projects:</p>${availableList()}`
    );
  }

  if (isArchived(project)) {
    return sendHtml(
      res,
      410,
      'xerb — archived',
      `<h1>${esc(project.host)} is archived</h1>
       <p class="muted">Nobody opened it for ${config.viewableArchiveDays} days, so xerb put it away. The folder is still at <code>${esc(project.dir)}</code>. Restore it from the dashboard's archived list.</p>${dashboardHomeLink()}`
    );
  }

  if (isViewable(project)) noteOpened(project.host);

  if (project.enabled === false) {
    return sendHtml(
      res,
      404,
      'xerb — disabled',
      `<h1>${esc(project.host)} is disabled</h1>
       <p class="muted">This project is marked <code>enabled: false</code> in the registry.</p>${dashboardHomeLink()}`
    );
  }

  const r = getRuntime(project.host);

  // Warm path: the project is running AND a probe/adopt already pinned the
  // family that answered. upstreamHost is the honest "port answered" signal, so
  // this is the only case where we proxy straight through (WS/HMR keep working).
  //
  // For an ADOPTED upstream that signal is stale by construction: nothing tells
  // us when a server we did not spawn goes away. verifyAdoptedUpstream re-checks
  // the listening pid (at most once every ADOPT_VERIFY_TTL_MS) and returns false
  // after dropping a record whose pid changed — falling through to the cold path
  // below, which re-runs bring-up and lands on adopt, spawn or conflict.
  if (r.state === 'running' && r.upstreamHost && verifyAdoptedUpstream(project, r)) {
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
  const wantsRetry = url.searchParams.has('retry');

  // Kick bring-up in the background exactly once. ensureUp claims r.startPromise
  // synchronously before any await (the #9cb548a fix), so kicking it here yields
  // exactly ONE child for N concurrent hits. The .catch is MANDATORY: a
  // start-timeout / conflict rejection would otherwise surface as an
  // unhandledRejection. lastError is recorded inside ensureUp before it throws,
  // so swallowing the rejection here loses nothing.
  //
  // A terminal failure (stopped + lastError) is left alone so the wake page's
  // reload lands on the failure page instead of spawning another child. Only
  // an explicit ?retry=1 (the failure page's Retry link) starts over.
  const kicked =
    !r.startPromise && (wantsRetry || !(r.state === 'stopped' && r.lastError));
  if (kicked) {
    // An explicit Retry is the one thing that re-arms a dependency install that
    // already failed: ensureUp skips the install while this memo stands, so a
    // plain reload of a broken project answers instantly instead of paying
    // installTimeoutMs again (spec 4: "does not re-run npm install on the next
    // request"). A human who just fixed their network clicks Retry and gets it.
    if (wantsRetry) r.installFailed = null;
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
  // No verifyAdoptedUpstream here: ensureUp just resolved the listener's pid AND
  // its cwd a few milliseconds ago, which is the stronger check, and it stamped
  // verifiedAt — so calling the pid check now would short-circuit on the cache
  // anyway.
  if (r.state === 'running' && r.upstreamHost) {
    lastAccess.set(project.host, Date.now());
    return proxyHttp(req, res, project);
  }
  // Conflict settled within the grace -> terminal 502, never proxy.
  if (r.state === 'conflict') {
    return sendConflict(req, res, project, r, isControlAuthorized(req));
  }

  // Still bringing up (or the fresh attempt already failed): answer immediately
  // and let the client (or the status page's poll) drive the retry.
  //
  // When THIS request kicked a fresh attempt, render from the live record so a
  // Retry click shows the wake page (installing/starting) instead of immediately
  // re-showing the stale failure from the pre-kick snapshot. A concurrent hit
  // that shares an in-flight startPromise keeps the snapshot so an idle reload
  // after a terminal failure still names that failure.
  const renderState = kicked ? r : snapshot;

  // Navigation (browser) -> self-refreshing status page (200 so the browser
  // renders it and runs the poll script instead of showing its own error UI).
  // A failed start renders the failure reason + log tail in that same page, but
  // only for an authorized caller — an ordinary navigation carries no token, so
  // the log/error is redacted (see statusPageHtml).
  if (wantsHtml(req)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(statusPageHtml(project, renderState, isControlAuthorized(req)));
    return;
  }

  // Everything else (curl / XHR / webhook, including the status page's own poll)
  // -> plain 503 with Retry-After, no HTML. Also covers the failed state: keep
  // it 503 so simple clients keep retrying; the failure detail is for humans.
  return sendRetry(res, project, renderState);
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

  // The terminal socket (section 6). An http server takes exactly one 'upgrade'
  // listener and the HMR proxy below owns the rest of it, so this is a branch
  // here rather than a second listener. It has to come before the control-plane
  // destroy below, since the terminal IS on the control plane.
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname.startsWith(TERM_PATH)) {
    return handleTermUpgrade(req, clientSocket, head, url, key);
  }

  // Never proxy the control plane over websockets.
  if (key === 'xerb') {
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

// Archive every viewable nobody has opened in viewableArchiveDays, and save
// the opened times. Runs on the reaper's tick; the file-time stat is a couple
// of syscalls per viewable, so there is no reason to run it less often.
let sweeping = false;
async function sweepViewables(now = Date.now()) {
  flushOpened();
  if (sweeping) return [];
  const due = dueForArchive(config.projects, {
    opened,
    now,
    days: config.viewableArchiveDays,
    touched: newestFileTime,
  });
  if (!due.length) return [];
  sweeping = true;
  try {
    for (const host of due) stop(host, 'archive');
    await editRegistry('archive', (reg) => {
      for (const host of due) if (reg.projects.some((p) => p.host === host)) archiveEntry(reg, host, now);
    });
    for (const host of due) log(`archived ${host} (unopened ${config.viewableArchiveDays}d)`);
    return due;
  } catch (err) {
    log(`viewables: archive sweep failed: ${err.message}`);
    return [];
  } finally {
    sweeping = false;
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
  flushOpened();
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
  startSourceWatch();
  // Reaper cadence is 30s in production. XERB_REAP_INTERVAL_MS exists solely so
  // the bundled self-test can exercise the idle reaper quickly (same spirit as the
  // XERB_CONFIG override). Production never sets it.
  const REAP_INTERVAL_MS = Number(process.env.XERB_REAP_INTERVAL_MS) || 30_000;
  setInterval(reapIdle, REAP_INTERVAL_MS).unref?.();
  opened = readOpened(OPENED_PATH);
  sweepViewables();
  setInterval(() => sweepViewables(), REAP_INTERVAL_MS).unref?.();

  // The numbered port to fall back to when the front-door port cannot be bound.
  // On the npx path the front door is :80; macOS grants an unprivileged process
  // that bind, Linux does not (no CAP_NET_BIND_SERVICE), so a plain `npx xerb`
  // on Linux gets EACCES and lands here. EADDRINUSE (port already held) falls back
  // the same way. XERB_FALLBACK_PORT exists so the npx path and the self-test
  // can force the fallback deterministically (same spirit as XERB_CONFIG).
  const FALLBACK_PORT = Number(process.env.XERB_FALLBACK_PORT) || 4000;

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

    log(`xerb listening on :${servePort}, loopback-only enforced per connection (config=${CONFIG_PATH})`);
    log(`dashboard: ${frontUrl('xerb')}/`);
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
// matching the XERB_CONFIG / XERB_REAP_INTERVAL_MS self-test hooks.

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
// logFdFor, and LOGS_DIR are exposed (with the XERB_LOGS_DIR override) so a
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
  sweepViewables,
  dashboardHtml,
  __setRuntimeForTest,
  makeTermSink,
  __addConnForTest,
  __setLastAccessForTest,
  __liveConnInfo,
  ensureControlToken,
  isSameOrigin,
  isControlAuthorized,
  CONTROL_TOKEN_PATH,
  sameDir,
  __setResolvePidCwd,
  __setResolveListenerPid,
  __setKillForeign,
  freePort,
  rotateIfNeeded,
  log,
  logFdFor,
  LOGS_DIR,
  // Section 4 (failures you can see): the per-kind copy table, the
  // since-the-last-separator tail, and the dashboard's one-line error summary,
  // exposed so test/failures.test.mjs can assert each without a browser.
  failureCopy,
  tailLog,
  firstErrorLine,
  statusPayload,
  // Section 6 (a terminal per dev server): which interpreter runs lib/pty.py
  // (null on the read-only fallback), the line a read-only panel opens with,
  // and the scrollback a fresh socket replays.
  ptyStatus,
  NO_PTY_NOTE,
  termRingBytes,
  // Section 5 (adoption that re-checks): the pid gate in front of an adopted
  // upstream, and the TTL a test needs to know to step over the cache.
  verifyAdoptedUpstream,
  ADOPT_VERIFY_TTL_MS,
  // Section 8 (static sites survive an npx cache prune): the placeholder, its
  // spawn-time expansion, and the one-time registry migration.
  STATIC_PLACEHOLDER,
  expandStartCmd,
  rewriteStaticStartCmds,
  // #9 — npx front door: state-dir resolution + bind fallback. Re-exported from
  // their libs so a test importing ../xerb.mjs reaches the same helpers the
  // daemon uses, and STATE_DIR/CONFIG_PATH expose what this module resolved.
  resolveStateDir,
  resolveStatePaths,
  decideBindFallback,
  formatProjectUrl,
  STATE_DIR,
  CONFIG_PATH,
};
