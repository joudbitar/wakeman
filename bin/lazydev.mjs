#!/usr/bin/env node
// lazydev entrypoint — the ONE way in.
//
//   npx @jbitar/lazydev        first run: ask consent, scan ~, install the
//                              background service, print the URLs, exit
//   lazydev                    (the installed command) rescan + refresh
//   lazydev logs <host>        tail a project's dev-server log
//   lazydev uninstall          stop the service and remove every trace
//
// Interactive runs on macOS install a user LaunchAgent (no sudo) so the URLs
// survive reboots; the daemon serves :80 itself with a per-connection loopback
// guard (ADR 0002), so there is no Caddy and no shell installer. Non-
// interactive runs (CI, pipes) and Linux serve in the FOREGROUND instead —
// same scan, same state dir, Ctrl-C stops it. See docs/adr/0003-one-way-in.md.
//
// Nothing is ever written into a project directory. Everything lands in the
// state dir (registry, logs, control token, the installed app copy) plus, when
// installed, one plist in ~/Library/LaunchAgents and one symlink in
// ~/.local/bin. `lazydev uninstall` removes all of it.
//
// Zero npm dependencies — Node built-ins only.

import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStateDir, resolveStatePaths } from '../lib/state.mjs';
import { decideBindFallback, formatProjectUrl } from '../lib/bind.mjs';
import { makeStyler, makeSpinner, LOGO } from '../lib/ui.mjs';
import { LAUNCHD_LABEL, assembleLaunchdPath, renderPlist, stripCaddyBlock, extractWorkingDirectory, toolsToVerify } from '../lib/install.mjs';

const ui = makeStyler({ isTTY: process.stdout.isTTY, env: process.env });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // package root — where lazydev.mjs / scan.mjs live
const DAEMON = path.join(ROOT, 'lazydev.mjs');
const SCANNER = path.join(ROOT, 'scan.mjs');

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// The front-door port, and the numbered port to fall back to when :80 can't be
// bound. Both overridable so the boot smoke test can force a non-privileged
// port on CI (no :80 there).
const FRONT_PORT = Number(process.env.LAZYDEV_PORT) || 80;
const FALLBACK_PORT = Number(process.env.LAZYDEV_FALLBACK_PORT) || 4000;

// Resolve ONE state directory: LAZYDEV_STATE_DIR wins, else the XDG state home
// (preferXdg), else ~/.local/state/lazydev. Everything derives from it.
const stateDir = resolveStateDir({
  env: process.env,
  home: os.homedir(),
  scriptDir: ROOT, // only used if preferXdg were false; here XDG default wins
  preferXdg: true,
});
const { configPath, logsDir } = resolveStatePaths({ env: process.env, stateDir });

// Where the installed app copy lives: inside the state dir, so "everything
// lazydev creates" stays one directory (plus the plist and the PATH symlink,
// which uninstall removes).
const APP_DIR = path.join(stateDir, 'app');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const CLI_LINK = path.join(os.homedir(), '.local', 'bin', 'lazydev');

// The agent skill that teaches a coding agent to register what the scanner
// can't prove. It ships in the package so the skill version always matches the
// daemon it describes; the install copies it for Claude Code when ~/.claude
// exists. Other agents get it with `npx skills add joudbitar/lazydev`.
const SKILL_SRC = path.join(ROOT, '.claude', 'skills', 'add-project');
const SKILL_DEST = path.join(os.homedir(), '.claude', 'skills', 'add-project');

const tilde = (p) => p.replace(os.homedir(), '~');

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
}

// A machine that ran the pre-ADR-0003 checkout install has its registry next
// to the old checkout, full of hand-added entries a scan cannot rediscover.
// The old plist's WorkingDirectory says where that was; copy the registry into
// the state dir once, before the first scan, and the scan merge preserves
// every entry. Only runs when the state dir has no registry yet — an existing
// registry is never overwritten. Returns the legacy path when migrated.
function migrateLegacyRegistry() {
  if (fs.existsSync(configPath)) return null;
  try {
    const wd = extractWorkingDirectory(fs.readFileSync(PLIST_PATH, 'utf8'));
    if (!wd || wd === stateDir) return null;
    const legacy = path.join(wd, 'projects.json');
    if (!fs.existsSync(legacy)) return null;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.copyFileSync(legacy, configPath);
    return legacy;
  } catch {
    return null; // no old plist — nothing to migrate
  }
}

// ---------------------------------------------------------------------------
// port probes
// ---------------------------------------------------------------------------

// Can WE bind this port right now? Used by the foreground path to decide the
// port before the daemon does the real bind (ADR 0002's one rule).
function probeBind(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve({ ok: false, code: err && err.code }));
    probe.listen(port, () => probe.close(() => resolve({ ok: true })));
  });
}

// Is SOMETHING listening on this port? Used after the install to report the
// URLs that actually work (the daemon on :80, or on the fallback behind a
// legacy Caddy that still owns :80).
function probeListen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(400);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

async function decideServePort() {
  const r = await probeBind(FRONT_PORT);
  if (r.ok) return FRONT_PORT;
  const d = decideBindFallback({ attemptedPort: FRONT_PORT, errorCode: r.code, fallbackPort: FALLBACK_PORT });
  return d.fallback ? d.port : FRONT_PORT; // nothing bindable — let the daemon surface the real error
}

// ---------------------------------------------------------------------------
// scan + registry
// ---------------------------------------------------------------------------

// The environment a child (scan or daemon) inherits: pin the SAME state dir so
// scan writes the registry where the daemon reads it, and force the port the
// daemon serves on.
function childEnvFor(servePort) {
  return {
    ...process.env,
    LAZYDEV_STATE_DIR: stateDir,
    LAZYDEV_PORT: String(servePort),
    LAZYDEV_FALLBACK_PORT: String(FALLBACK_PORT),
    // Keep the terminal clean: the scanner skips its report table and the
    // daemon logs to daemon.log only. The banner is the whole startup output.
    LAZYDEV_SCAN_QUIET: '1',
    LAZYDEV_QUIET: '1',
  };
}

// Run scan.mjs as a child so the EXACT scan logic runs and writes the registry
// into the state dir. Resolves on exit code 0, rejects otherwise.
function runScan(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCANNER], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`scan exited ${code}`))));
  });
}

// Read the enabled projects the scan just wrote, for the URL summary.
function readProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return Array.isArray(parsed.projects) ? parsed.projects.filter((p) => p && p.enabled !== false) : [];
  } catch {
    return [];
  }
}

async function scanWithStatus(env) {
  const spin = makeSpinner({ isTTY: process.stdout.isTTY, styler: ui });
  spin.start(`scanning ${tilde(os.homedir())} for projects`);
  try {
    await runScan(env);
  } catch (err) {
    spin.fail();
    process.stderr.write(`lazydev: scan failed (${err.message}); continuing with whatever registry exists.\n`);
    return;
  }
  const n = readProjects().length;
  await spin.done(`${ui.green('✓')} ${ui.dim(`found ${n} project${n === 1 ? '' : 's'}`)}`);
}

// ---------------------------------------------------------------------------
// consent
// ---------------------------------------------------------------------------

// The first-run prompt: exactly what will happen, in checkable terms, before a
// single directory is read. Declining exits with nothing scanned and nothing
// installed. Re-runs (a registry already exists) skip it — consent was given.
async function askConsent({ willInstall, willInstallSkill }) {
  const { bold, dim, cyan } = ui;
  const out = (s = '') => process.stdout.write(s + '\n');
  out();
  for (const line of LOGO) out(`  ${cyan(line)}`);
  out();
  out(`  ${dim(`v${VERSION} · dev servers on demand behind permanent URLs`)}`);
  out();
  out(`  scan ~ for projects it can prove how to run ${dim('· reads marker files, writes nothing')}`);
  out(`  serve each at ${bold('http://<name>.localhost')} ${dim('· this machine only, nothing leaves it')}`);
  if (willInstall) {
    out(`  install a user LaunchAgent ${dim('· no sudo, the URLs survive reboots')}`);
    if (willInstallSkill) {
      out(`  add the add-project skill to ~/.claude/skills ${dim("· for what the scan can't prove")}`);
    }
    out();
    out(dim(`  everything lands in ${tilde(stateDir)} · \`lazydev uninstall\` removes every trace`));
  } else {
    out(`  serve them in the foreground ${dim('· Ctrl-C stops it; a systemd port is the PR I\'d merge first')}`);
    out();
    out(dim(`  everything lands in ${tilde(stateDir)} · deleting it removes every trace`));
  }
  out();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = (await rl.question('  proceed? [Y/n] ')).trim().toLowerCase();
  } finally {
    rl.close();
  }
  return answer === '' || answer === 'y' || answer === 'yes';
}

// ---------------------------------------------------------------------------
// install (macOS, launchd)
// ---------------------------------------------------------------------------

function which(cmd) {
  for (const d of (process.env.PATH || '').split(':')) {
    if (!d) continue;
    const p = path.join(d, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  return null;
}

function launchctl(args) {
  return spawnSync('launchctl', args, { stdio: 'ignore' }).status === 0;
}

// Async twin for the install path. The spinner redraws on an event-loop timer,
// so any spawnSync under it freezes the animation mid-frame; everything that
// runs while a spinner is up must yield. Uninstall keeps the sync one — it has
// no spinner to starve.
function launchctlAsync(args) {
  return new Promise((resolve) => {
    const c = spawn('launchctl', args, { stdio: 'ignore' });
    c.on('error', () => resolve(false));
    c.on('exit', (code) => resolve(code === 0));
  });
}

// Copy the running package into the state dir. npx runs from a cache that can
// be pruned at any time, so the LaunchAgent must point at a copy we own. The
// list comes from package.json "files" — exactly what the published package
// ships — because a checkout has more (tests, docs, .git) that must NOT be
// dragged along.
async function copyApp() {
  if (fs.existsSync(APP_DIR) && fs.realpathSync(APP_DIR) === fs.realpathSync(ROOT)) return; // running from the installed copy
  await fs.promises.rm(APP_DIR, { recursive: true, force: true });
  await fs.promises.mkdir(APP_DIR, { recursive: true });
  let files = ['bin', 'lib', 'lazydev.mjs', 'scan.mjs'];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (Array.isArray(pkg.files) && pkg.files.length) files = pkg.files.map((f) => f.replace(/\/+$/, ''));
  } catch { /* fall back to the core list */ }
  for (const entry of [...files, 'package.json']) {
    const src = path.join(ROOT, entry);
    if (fs.existsSync(src)) await fs.promises.cp(src, path.join(APP_DIR, entry), { recursive: true });
  }
}

// The version of the copy the LaunchAgent runs, or null when nothing is
// installed. A re-run compares this against its own VERSION to decide whether
// the daemon needs replacing at all.
function installedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

async function installPersistent({ onStep = () => {} } = {}) {
  const domain = `gui/${process.getuid()}`;

  // Stop any existing agent first (this label covers the old checkout install
  // too, so an npx install cleanly supersedes it), then refresh the app copy.
  await launchctlAsync(['bootout', `${domain}/${LAUNCHD_LABEL}`]);
  await copyApp();

  const nodeBin = process.execPath;
  const plist = renderPlist({
    nodeBin,
    daemonPath: path.join(APP_DIR, 'lazydev.mjs'),
    workDir: APP_DIR,
    stateDir,
    logsDir,
    home: os.homedir(),
    // The daemon must resolve every project's start command to the same binary
    // the user's shell would — so it inherits this install shell's PATH.
    pathEnv: assembleLaunchdPath({
      userPath: process.env.PATH || '',
      nodeDir: path.dirname(nodeBin),
      home: os.homedir(),
    }),
    frontPort: FRONT_PORT,
    fallbackPort: FALLBACK_PORT,
  });
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.writeFileSync(PLIST_PATH, plist);

  if (!(await launchctlAsync(['bootstrap', domain, PLIST_PATH]))) {
    // Legacy fallback, same as the old installer.
    await launchctlAsync(['unload', PLIST_PATH]);
    if (!(await launchctlAsync(['load', '-w', PLIST_PATH]))) {
      throw new Error(`launchctl could not load ${PLIST_PATH}`);
    }
  }
  await launchctlAsync(['enable', `${domain}/${LAUNCHD_LABEL}`]);
  await launchctlAsync(['kickstart', '-k', `${domain}/${LAUNCHD_LABEL}`]);

  // Put `lazydev` on PATH: a symlink to this same entrypoint in the app copy.
  fs.mkdirSync(path.dirname(CLI_LINK), { recursive: true });
  try { fs.rmSync(CLI_LINK, { force: true }); } catch { /* fine */ }
  fs.symlinkSync(path.join(APP_DIR, 'bin', 'lazydev.mjs'), CLI_LINK);

  // The add-project skill, for machines that run Claude Code (~/.claude
  // exists). Replaced wholesale on every install so it tracks the daemon.
  let skillInstalled = false;
  if (fs.existsSync(SKILL_SRC) && fs.existsSync(path.join(os.homedir(), '.claude'))) {
    await fs.promises.rm(SKILL_DEST, { recursive: true, force: true });
    await fs.promises.mkdir(path.dirname(SKILL_DEST), { recursive: true });
    await fs.promises.cp(SKILL_SRC, SKILL_DEST, { recursive: true });
    skillInstalled = true;
  }

  // Wait for the daemon: :80 when it won the front door (or a legacy Caddy is
  // forwarding), else the fallback port. Report the port that answers.
  onStep('waking the daemon');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await probeListen(FRONT_PORT)) return { up: true, port: FRONT_PORT, skillInstalled };
    if (await probeListen(FALLBACK_PORT)) return { up: true, port: FALLBACK_PORT, skillInstalled };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { up: false, port: FRONT_PORT, skillInstalled };
}

function printInstalledBanner({ projects, port, startedAt, skillInstalled, verb = 'installed' }) {
  const { bold, dim, cyan } = ui;
  const out = (s = '') => process.stdout.write(s + '\n');
  const readyMs = Date.now() - startedAt;
  out();
  out(`  ${cyan(bold('lazydev'))} ${dim(`v${VERSION}`)}  ${verb} ${dim(`in ${readyMs} ms`)}`);
  out();
  if (!projects.length) {
    out(`  no projects found under ${tilde(os.homedir())}.`);
    out(dim('  a project is anything the scan can prove how to run: package.json with a "dev" script, rails, django with a venv, a static folder; add one and run `lazydev` again.'));
  } else {
    const example = projects[0].host;
    out(`  ${dim('dashboard')}  ${bold(formatProjectUrl('lazydev', port))}`);
    out(`  ${dim('projects')}   ${bold(formatProjectUrl('<name>', port))} ${dim(`for each of ${projects.length} projects, e.g. ${formatProjectUrl(example, port)}`)}`);
  }
  out();
  out(dim(`  runs in the background and survives reboots · registry: ${tilde(configPath)} · logs: ${tilde(logsDir)}`));
  out(dim('  `lazydev` rescans for new projects · `lazydev uninstall` removes everything'));
  if (skillInstalled) {
    out(dim('  agent skill: add-project installed to ~/.claude/skills · other agents: npx skills add joudbitar/lazydev'));
  }
  const pathDirs = (process.env.PATH || '').split(':');
  if (!pathDirs.includes(path.dirname(CLI_LINK))) {
    out(dim(`  note: add ${tilde(path.dirname(CLI_LINK))} to your PATH to get the \`lazydev\` command.`));
  }
  out();
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

async function uninstall({ assumeYes }) {
  const { bold, dim } = ui;
  const out = (s = '') => process.stdout.write(s + '\n');
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (interactive && !assumeYes) {
    out();
    out(`  this stops the background service and deletes ${bold(tilde(stateDir))}`);
    out('  (registry, logs, the installed app copy), the LaunchAgent plist, the');
    out('  `lazydev` command, and the add-project skill. your projects are not');
    out('  touched.');
    out();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      answer = (await rl.question('  remove lazydev? [y/N] ')).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (answer !== 'y' && answer !== 'yes') {
      out('  kept everything as it was.');
      return 0;
    }
  }

  if (process.platform === 'darwin') {
    const domain = `gui/${process.getuid()}`;
    launchctl(['bootout', `${domain}/${LAUNCHD_LABEL}`]) || launchctl(['unload', PLIST_PATH]);
    fs.rmSync(PLIST_PATH, { force: true });
    // bootout returns before the daemon has fully exited, and a dying daemon
    // can flush a last log line AFTER the state dir is deleted, resurrecting
    // it. Wait for the label to leave launchd before touching the filesystem.
    const gone = Date.now() + 5000;
    while (launchctl(['print', `${domain}/${LAUNCHD_LABEL}`]) && Date.now() < gone) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // The PATH symlink, but only if it is ours: a symlink whose target mentions
  // lazydev. A real file someone else put there is left alone.
  try {
    const target = fs.readlinkSync(CLI_LINK);
    if (target.includes('lazydev')) fs.rmSync(CLI_LINK, { force: true });
  } catch { /* not a symlink or absent — leave it */ }

  // The agent skill, but only if it is ours: its SKILL.md must mention
  // lazydev. A same-named skill from somewhere else is left alone.
  try {
    if (fs.readFileSync(path.join(SKILL_DEST, 'SKILL.md'), 'utf8').includes('lazydev')) {
      fs.rmSync(SKILL_DEST, { recursive: true, force: true });
    }
  } catch { /* absent — nothing to remove */ }

  // A machine installed the old Caddy way still has a lazydev block in its
  // Caddyfile; strip it and reload so :80 is truly released. Best-effort — a
  // machine without brew or caddy skips all of this silently.
  const brewPrefix = spawnSync('brew', ['--prefix'], { encoding: 'utf8' }).stdout?.trim() || '/opt/homebrew';
  const caddyfile = path.join(brewPrefix, 'etc', 'Caddyfile');
  try {
    const before = fs.readFileSync(caddyfile, 'utf8');
    const { text, changed } = stripCaddyBlock(before);
    if (changed) {
      fs.copyFileSync(caddyfile, `${caddyfile}.bak.lazydev-uninstall`);
      fs.writeFileSync(caddyfile, text);
      const caddy = which('caddy');
      if (caddy) spawnSync(caddy, ['reload', '--config', caddyfile], { stdio: 'ignore' });
      out(dim(`  removed the lazydev block from ${caddyfile} (backup alongside).`));
    }
  } catch { /* no Caddyfile — nothing to clean */ }

  fs.rmSync(stateDir, { recursive: true, force: true });

  out();
  out('  lazydev is gone: service stopped, state removed. thanks for trying it.');
  out();
  return 0;
}

// ---------------------------------------------------------------------------
// foreground run (non-interactive contexts and Linux)
// ---------------------------------------------------------------------------

function printForegroundBanner({ projects, servePort, diff, firstRun, startedAt }) {
  const { bold, dim, cyan } = ui;
  const out = (s = '') => process.stdout.write(s + '\n');
  const readyMs = Date.now() - startedAt;
  out();
  out(`  ${cyan(bold('lazydev'))} ${dim(`v${VERSION}`)}  ${dim(`ready in ${readyMs} ms`)}`);
  out();
  if (!projects.length) {
    out(`  no projects found under ${tilde(os.homedir())}.`);
    out(dim(`  a project is anything the scan can prove how to run: package.json with a "dev" script, rails, django with a venv, a static folder; add one and re-run.`));
  } else {
    const names = projects.map((p) => p.host);
    const example = names[0];
    out(`  ${dim('dashboard')}  ${bold(formatProjectUrl('lazydev', servePort))}`);
    out(`  ${dim('projects')}   ${bold(formatProjectUrl('<name>', servePort))} ${dim(`for each of ${names.length} projects, e.g. ${formatProjectUrl(example, servePort)}`)}`);
    if (diff && (diff.added.length || diff.removed.length)) {
      const part = [];
      if (diff.added.length) part.push(`+${diff.added.length} new: ${diff.added.slice(0, 3).join(', ')}${diff.added.length > 3 ? ', ...' : ''}`);
      if (diff.removed.length) part.push(`${diff.removed.length} gone: ${diff.removed.slice(0, 3).join(', ')}${diff.removed.length > 3 ? ', ...' : ''}`);
      out(`  ${dim('scan')}       ${part.join(dim(' · '))}`);
    }
  }
  if (servePort !== FRONT_PORT) {
    out();
    out(dim(`  :${FRONT_PORT} is busy, so URLs carry :${servePort} for this run.`));
  }
  if (firstRun) {
    out();
    out(dim(`  first run: the registry lives at ${tilde(configPath)}; edit it to rename, re-port, or exclude projects.`));
  }
  out();
  out(dim(`  Ctrl-C stops this foreground run · logs: ${tilde(logsDir)}`));
  out();
}

// Spawn the daemon in the foreground, stdio inherited. It stays attached to this
// process group, so Ctrl-C (SIGINT) reaches it and its own SIGINT/SIGTERM
// handler shuts the children down cleanly. Resolves with the exit code.
function runDaemon(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DAEMON], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    });
    // Forward the signals a user or supervisor might send, so the daemon child
    // gets them even if this launcher is the one signalled directly.
    const forward = (sig) => {
      try { child.kill(sig); } catch { /* already gone */ }
    };
    process.on('SIGINT', () => forward('SIGINT'));
    process.on('SIGTERM', () => forward('SIGTERM'));
    child.on('error', (err) => {
      process.stderr.write(`lazydev: could not start the daemon: ${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(signal ? 0 : code || 0));
  });
}

// ---------------------------------------------------------------------------
// Tool preflight. The daemon resolves start commands under the plist PATH,
// not the user's shell PATH. Those must agree BINARY BY BINARY, not just
// name by name: the tradepulse incident was two pnpms on one machine —
// /usr/local/bin/pnpm (v9, rejects a config-only pnpm-workspace.yaml) ahead
// of ~/.npm-global/bin/pnpm (v10, the one the shell ran) — so the daemon
// crash-looped a project the user's own terminal started fine, and nothing
// said why until someone read the log. A version probe can't catch that
// class (both pnpms pass --version); resolving each tool under BOTH paths
// and comparing does, at install time, while the user is still watching.
// ---------------------------------------------------------------------------

// Tools whose `--version` is a cheap, universal liveness probe (catches the
// genuinely-broken-binary case). Anything not listed only gets resolution
// checks — an arbitrary tool may not know the flag, and a false "broken" is
// worse than a missed one.
const VERSION_PROBED = new Set(['npm', 'pnpm', 'yarn', 'bun', 'node', 'python3', 'uv', 'poetry']);

// Resolve `tool` under `pathEnv`; optionally prove the resolved binary runs.
// Distinct exit codes keep "missing" (40) and "broken" (41) apart.
function probeTool(tool, pathEnv, withVersion) {
  return new Promise((resolve) => {
    const script = withVersion
      ? `p="$(command -v ${tool})" || exit 40; echo "$p"; "$p" --version >/dev/null 2>&1 || exit 41`
      : `command -v ${tool} || exit 40`;
    const c = spawn('sh', ['-c', script], {
      env: { ...process.env, PATH: pathEnv },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let outBuf = '';
    c.stdout.on('data', (d) => (outBuf += d));
    const timer = setTimeout(() => {
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }, 8000);
    const done = (result) => { clearTimeout(timer); resolve(result); };
    c.on('error', () => done({ code: 40, bin: null }));
    c.on('exit', (code) => {
      done({ code, bin: outBuf.trim().split('\n')[0] || null });
    });
  });
}

async function checkTool(tool, servicePath) {
  const [service, shell] = await Promise.all([
    probeTool(tool, servicePath, VERSION_PROBED.has(tool)),
    probeTool(tool, process.env.PATH || '', false),
  ]);
  if (service.code === 40 || (service.code !== 0 && service.code !== 41)) {
    return { tool, ok: false, reason: 'missing' };
  }
  if (service.code === 41) {
    return { tool, ok: false, reason: 'broken', bin: service.bin };
  }
  if (shell.code === 0 && shell.bin && service.bin && shell.bin !== service.bin) {
    // fs.realpathSync both sides before declaring divergence: a symlinked dir
    // (say /usr/local/bin -> /opt/tools) makes different strings name the
    // same binary, and that must not warn.
    try {
      if (fs.realpathSync(shell.bin) === fs.realpathSync(service.bin)) {
        return { tool, ok: true, bin: service.bin };
      }
    } catch { /* unreadable link — treat as divergent and warn */ }
    return { tool, ok: false, reason: 'mismatch', bin: service.bin, shellBin: shell.bin };
  }
  return { tool, ok: true, bin: service.bin };
}

function preflightTools(tools, servicePath) {
  return Promise.all(tools.map((t) => checkTool(t, servicePath)));
}

// The PATH the daemon is REALLY running with: the deployed plist's, when one
// is installed. Preflighting the plist we would write instead of the plist
// that exists would miss the stale case — a shell PATH that changed since
// install, with the service still resolving yesterday's binaries.
function deployedPathEnv() {
  try {
    const m = fs.readFileSync(PLIST_PATH, 'utf8').match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/);
    if (m && m[1]) return m[1];
  } catch { /* no plist yet — fresh install */ }
  return assembleLaunchdPath({
    userPath: process.env.PATH || '',
    nodeDir: path.dirname(process.execPath),
    home: os.homedir(),
  });
}

function printToolWarnings(results) {
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) return;
  const { bold, dim, red } = ui;
  const out = (s = '') => process.stdout.write(s + '\n');
  for (const r of bad) {
    if (r.reason === 'mismatch') {
      out(`  ${red('⚠')} ${bold(r.tool)}: the service runs ${tilde(r.bin)}, your shell runs ${tilde(r.shellBin)}.`);
      out(dim(`    two installs of one tool can behave differently — \`lazydev install\` rebakes the service PATH from this shell.`));
    } else if (r.reason === 'broken') {
      out(`  ${red('⚠')} ${bold(r.tool)} resolves to ${tilde(r.bin || '?')} for the service, but \`${r.tool} --version\` fails there.`);
      out(dim(`    projects whose start command uses ${r.tool} will not come up until this is fixed.`));
    } else {
      out(`  ${red('⚠')} ${bold(r.tool)} is not on the service PATH — projects that start with it will not come up.`);
    }
  }
  out();
}

// ---------------------------------------------------------------------------
// logs — the command the daemon's status page points users at. The browser
// page redacts log tails (they leak filesystem paths to any caller without the
// control token); this reads the same file locally, where the user's own shell
// IS the authorization. Kept dependency-free and daemon-free on purpose: logs
// must be readable precisely when the daemon is wedged or dead.
// ---------------------------------------------------------------------------

function cmdLogs(args) {
  const { bold, dim } = ui;
  const out = (s = '') => process.stdout.write(s + '\n');
  const rest = args.filter((a) => a !== 'logs');

  // -n N: how many trailing lines (default 40, same tail the status page shows
  // an authorized caller).
  let lines = 40;
  const nAt = rest.indexOf('-n');
  if (nAt !== -1) {
    const v = Number(rest[nAt + 1]);
    if (Number.isFinite(v) && v > 0) lines = Math.floor(v);
    rest.splice(nAt, 2);
  }

  const raw = rest.find((a) => !a.startsWith('-')) || '';
  // Accept the URL form too: `lazydev logs tradepulse.localhost`.
  const host = raw.replace(/\.localhost$/, '');

  const available = () => {
    try {
      return fs.readdirSync(logsDir).filter((f) => /\.(log|err)$/.test(f)).sort();
    } catch {
      return [];
    }
  };

  const listAvailable = () => {
    const names = available();
    if (!names.length) {
      out(dim(`  no logs yet in ${tilde(logsDir)} — a project writes its log on first start.`));
      return;
    }
    out(dim(`  logs in ${tilde(logsDir)}:`));
    for (const f of names) out(`    ${f.replace(/\.log$/, '')}`);
  };

  out();
  if (!host || host.includes('/') || host.includes('..')) {
    out(`  usage: ${bold('lazydev logs <host>')} ${dim('[-n lines]')}`);
    out();
    listAvailable();
    out();
    return host ? 1 : 0;
  }

  // `lazydev logs daemon` reads the daemon's own log; everything else is a
  // per-project log written by that project's dev server.
  const file = path.join(logsDir, `${host}.log`);
  if (!fs.existsSync(file)) {
    out(`  no log for ${bold(host)} yet.`);
    out();
    listAvailable();
    out();
    return 1;
  }

  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`lazydev: could not read ${file}: ${err.message}\n`);
    return 1;
  }
  const all = content.split('\n');
  if (all[all.length - 1] === '') all.pop(); // trailing newline is not a line
  const tail = all.slice(-lines);
  out(`  ${tilde(file)} ${dim(`— last ${tail.length} of ${all.length} lines`)}`);
  out();
  for (const l of tail) out(l);
  out();
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const assumeYes = args.includes('--yes') || args.includes('-y');
  const cmd = args.find((a) => !a.startsWith('-')) || '';

  if (cmd === 'uninstall') return uninstall({ assumeYes });
  if (cmd === 'logs') return cmdLogs(args.slice(args.indexOf('logs') + 1));
  if (cmd && cmd !== 'install') {
    process.stderr.write(`lazydev: unknown command "${cmd}". run with no arguments to install/rescan, \`lazydev logs <host>\`, or \`lazydev uninstall\`.\n`);
    return 1;
  }

  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  // The install needs launchd, so it is macOS + a human at the terminal (or an
  // explicit --yes / `install`). Everything else — CI, pipes, Linux — serves in
  // the foreground with the same scan and the same state dir.
  const willInstall =
    process.platform === 'darwin' &&
    (interactive || assumeYes || cmd === 'install') &&
    process.env.LAZYDEV_NO_INSTALL !== '1';

  ensureStateDir();
  const startedAt = Date.now();
  // Migration counts as prior consent: these users already installed lazydev
  // once, so a migrated run skips the first-run prompt like any re-run.
  const migratedFrom = migrateLegacyRegistry();
  if (migratedFrom) {
    process.stdout.write(ui.dim(`  carried your registry over from ${tilde(migratedFrom)}.\n`));
  }
  const firstRun = !fs.existsSync(configPath);

  const willInstallSkill =
    willInstall && fs.existsSync(SKILL_SRC) && fs.existsSync(path.join(os.homedir(), '.claude'));

  if (firstRun && interactive && !assumeYes) {
    const ok = await askConsent({ willInstall, willInstallSkill });
    if (!ok) {
      process.stdout.write('  ok. nothing was scanned, nothing was installed.\n\n');
      return 0;
    }
    process.stdout.write('\n');
  }

  if (willInstall) {
    await scanWithStatus(childEnvFor(FRONT_PORT));
    const projects = readProjects();

    // A re-run with a healthy daemon of this same version IS the rescan: the
    // daemon watches projects.json and reloads on its own, so replacing the
    // LaunchAgent here would only kill the dev servers it is holding. The
    // full install runs when nothing answers, the version changed (an npx of
    // a newer release supersedes the installed copy), or the user typed
    // `lazydev install` — the explicit form is the sanctioned way to force a
    // plist rewrite, e.g. after the preflight flags a stale service PATH.
    if (cmd !== 'install' && installedVersion() === VERSION) {
      for (const port of [FRONT_PORT, FALLBACK_PORT]) {
        if (await probeListen(port)) {
          printInstalledBanner({ projects, port, startedAt, skillInstalled: false, verb: 'rescanned' });
          // Preflight against the DEPLOYED plist PATH — what the daemon is
          // actually resolving with right now. A tool that broke or diverged
          // since install surfaces here, on the next casual `lazydev`, not at
          // 3am via a start timeout.
          printToolWarnings(await preflightTools(toolsToVerify(projects), deployedPathEnv()));
          return 0;
        }
      }
    }

    let result;
    const spin = makeSpinner({ isTTY: process.stdout.isTTY, styler: ui });
    spin.start('installing the LaunchAgent');
    try {
      result = await installPersistent({ onStep: (t) => spin.update(t) });
    } catch (err) {
      spin.fail();
      process.stderr.write(`lazydev: install failed: ${err.message}\n`);
      return 1;
    }
    if (!result.up) {
      spin.fail();
      process.stderr.write(
        `lazydev: the service was installed but the daemon did not answer within 10s.\n` +
        `check ${tilde(logsDir)}/daemon.err and daemon.log, then run \`lazydev\` again.\n`
      );
      return 1;
    }
    await spin.done(`${ui.green('✓')} ${ui.dim('service running')}`);
    printInstalledBanner({ projects, port: result.port, startedAt, skillInstalled: result.skillInstalled });
    // The plist was just written, so deployedPathEnv() reads the fresh PATH:
    // this proves what the daemon will resolve, on the install that baked it.
    printToolWarnings(await preflightTools(toolsToVerify(projects), deployedPathEnv()));
    return 0;
  }

  // Foreground path. Decide the real serving port up front so scan, the
  // daemon, and the printed URLs all agree.
  const before = new Set(readProjects().map((p) => p.host));
  const servePort = await decideServePort();
  const env = childEnvFor(servePort);
  await scanWithStatus(env);
  const projects = readProjects();
  const after = new Set(projects.map((p) => p.host));
  const diff = firstRun
    ? { added: [], removed: [] }
    : { added: [...after].filter((h) => !before.has(h)), removed: [...before].filter((h) => !after.has(h)) };
  printForegroundBanner({ projects, servePort, diff, firstRun, startedAt });

  return runDaemon(env);
}

main().then((code) => {
  if (typeof code === 'number' && code !== 0) process.exitCode = code;
});
