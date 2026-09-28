#!/usr/bin/env node
// xerb entrypoint — the ONE way in.
//
//   npx xerb        first run: ask consent, scan ~, install the
//                              background service, print the URLs, exit
//   xerb                    (the installed command) rescan + refresh
//   xerb --help             the whole command table
//
// Every run installs a user LaunchAgent (no sudo) so the URLs survive reboots;
// the daemon serves :80 itself with a per-connection loopback guard (ADR 0002),
// so there is no Caddy and no shell installer. macOS only: the install IS a
// LaunchAgent, and half a Linux story is worse than none.
// See docs/adr/0003-one-way-in.md.
//
// The subcommands split in two. Registry edits (add, remove, enable, disable,
// port, rename) write projects.json through lib/registry-cli.mjs and stop
// there: the daemon watches the file, so the write is the deployment. Runtime
// actions (status, stop, restart, wake, attach, logs -f) go over the control
// API with the token from <state>/control-token, because only the live daemon
// knows what is running.
//
// Nothing is ever written into a project directory. Everything lands in the
// state dir (registry, logs, control token, the installed app copy) plus, when
// installed, one plist in ~/Library/LaunchAgents and one symlink in
// ~/.local/bin. `xerb uninstall` removes all of it.
//
// Zero npm dependencies — Node built-ins only.

import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStateDir, resolveStatePaths } from '../lib/state.mjs';
import { formatProjectUrl } from '../lib/bind.mjs';
import { makeStyler, makeSpinner, columnize, frameworkTally, paintLogo } from '../lib/ui.mjs';
import { CANCEL_EXIT } from '../lib/picker.mjs';
import {
  RegistryError, readRegistry, writeRegistry, addEntry, removeEntry, setEnabled,
  setPort, renameEntry, pickPort, sanitizeHost, expandTilde, detectOne, startCmdFor,
  DETECTOR_EVIDENCE,
} from '../lib/registry-cli.mjs';
import { nodeTooOld, protectedRoot, isToolStub, whichOn, stableNode } from '../lib/macos.mjs';
import { LAUNCHD_LABEL, LEGACY_NAME, LEGACY_LAUNCHD_LABEL, assembleLaunchdPath, renderPlist, stripCaddyBlock, legacyRegistryCandidates, toolsToVerify, parseLaunchdPid, waitForExit } from '../lib/install.mjs';

const ui = makeStyler({ isTTY: process.stdout.isTTY, env: process.env });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // package root — where xerb.mjs / scan.mjs live
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
const FRONT_PORT = Number(process.env.XERB_PORT) || 80;
const FALLBACK_PORT = Number(process.env.XERB_FALLBACK_PORT) || 4000;

// Resolve ONE state directory: XERB_STATE_DIR wins, else the XDG state home
// (preferXdg), else ~/.local/state/xerb. Everything derives from it.
const stateDir = resolveStateDir({
  env: process.env,
  home: os.homedir(),
  scriptDir: ROOT, // only used if preferXdg were false; here XDG default wins
  preferXdg: true,
});
const { configPath, logsDir, tokenPath } = resolveStatePaths({ env: process.env, stateDir });

// Where the installed app copy lives: inside the state dir, so "everything
// xerb creates" stays one directory (plus the plist and the PATH symlink,
// which uninstall removes).
const APP_DIR = path.join(stateDir, 'app');
// Where the LaunchAgent's node is copied when it is not a Homebrew one.
const NODE_PIN = path.join(stateDir, 'bin', 'node');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const CLI_LINK = path.join(os.homedir(), '.local', 'bin', 'xerb');

// Where a pre-0.3.0 install (the lazydev name) left its three traces.
const LEGACY_PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LEGACY_LAUNCHD_LABEL}.plist`);
const LEGACY_STATE_DIR = path.join(path.dirname(resolveStateDir({ env: { XDG_STATE_HOME: process.env.XDG_STATE_HOME }, home: os.homedir(), preferXdg: true })), LEGACY_NAME);
const LEGACY_CLI_LINK = path.join(os.homedir(), '.local', 'bin', LEGACY_NAME);

// The agent skill that teaches a coding agent to register what the scanner
// can't prove. It ships in the package so the skill version always matches the
// daemon it describes; the install copies it for Claude Code when ~/.claude
// exists. Other agents get it with `npx skills add joudbitar/xerb`.
const SKILL_SRC = path.join(ROOT, '.claude', 'skills', 'add-project');
const SKILL_DEST = path.join(os.homedir(), '.claude', 'skills', 'add-project');

const tilde = (p) => p.replace(os.homedir(), '~');

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
}

// A machine that ran xerb under its old name has a registry full of
// hand-added entries a scan cannot rediscover. It sits in the lazydev state
// dir, or (the pre-ADR-0003 checkout install) next to the old checkout, which
// the old plist's WorkingDirectory names. Copy it into the state dir once,
// before the first scan, and the scan merge preserves every entry. Only runs
// when the state dir has no registry yet — an existing registry is never
// overwritten. Returns the legacy path when migrated.
function migrateLegacyRegistry() {
  if (fs.existsSync(configPath)) return null;
  let legacyPlistText = '';
  try { legacyPlistText = fs.readFileSync(LEGACY_PLIST_PATH, 'utf8'); } catch { /* no old plist */ }
  for (const legacy of legacyRegistryCandidates({ legacyStateDir: LEGACY_STATE_DIR, legacyPlistText, stateDir })) {
    try {
      if (!fs.existsSync(legacy)) continue;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.copyFileSync(legacy, configPath);
      return legacy;
    } catch { /* unreadable — try the next one */ }
  }
  return null;
}

// Take a lazydev-era install down: its agent would fight this one for :80,
// and its command would run a daemon that no longer exists. The old state dir
// is left alone (logs and registry backups are the user's to delete).
async function retireLegacyInstall() {
  if (fs.existsSync(LEGACY_PLIST_PATH)) {
    await launchctlAsync(['bootout', `gui/${process.getuid()}/${LEGACY_LAUNCHD_LABEL}`]);
    fs.rmSync(LEGACY_PLIST_PATH, { force: true });
  }
  try {
    if (fs.lstatSync(LEGACY_CLI_LINK).isSymbolicLink()) fs.rmSync(LEGACY_CLI_LINK, { force: true });
  } catch { /* no old command */ }
}

// ---------------------------------------------------------------------------
// scan + registry
// ---------------------------------------------------------------------------

// The environment a child (scan or daemon) inherits: pin the SAME state dir so
// scan writes the registry where the daemon reads it, and force the port the
// daemon serves on.
function childEnvFor(servePort, { scanAll = false } = {}) {
  return {
    ...process.env,
    XERB_STATE_DIR: stateDir,
    XERB_PORT: String(servePort),
    XERB_FALLBACK_PORT: String(FALLBACK_PORT),
    // Keep the terminal clean: the scanner skips its report table and the
    // daemon logs to daemon.log only. The banner is the whole startup output.
    XERB_SCAN_QUIET: '1',
    XERB_QUIET: '1',
    // `--yes` promised no prompts: the scan registers everything it finds
    // instead of raising the project picker.
    ...(scanAll ? { XERB_SCAN_ALL: '1' } : {}),
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

// The scan's one-line result: the count, then what kinds they are, as chips.
function foundLine(projects) {
  const n = projects.length;
  const tally = n ? `  ${frameworkTally(projects.map((p) => p.framework), ui)}` : '';
  return `${ui.green('✓')} ${ui.dim(`found ${n} project${n === 1 ? '' : 's'}`)}${tally}`;
}

// Interactive runs hand the terminal to the scan child: it may raise the
// project picker, and a parent spinner redrawing over the child's raw-mode
// input would garble both. Two ways out of that picker come back as exit
// codes: 130 (Ctrl-C, an abort) and CANCEL_EXIT (q/Esc, "not now"). Either
// way nothing was written, so the caller stops instead of installing over it;
// the difference is only what the user sees and what the shell gets.
async function scanWithStatus(env, interactive) {
  if (interactive) {
    try {
      await runScan(env);
    } catch (err) {
      // The picker already printed its one line; saying it twice would read
      // like two different things happened.
      if (new RegExp(`exited ${CANCEL_EXIT}`).test(String(err.message))) return 'declined';
      if (/exited 130/.test(String(err.message))) {
        process.stdout.write(ui.dim('  cancelled; nothing was changed.\n'));
        return 'cancelled';
      }
      process.stderr.write(`xerb: scan failed (${err.message}); continuing with whatever registry exists.\n`);
      return;
    }
    process.stdout.write(`  ${foundLine(readProjects())}\n`);
    return;
  }
  const spin = makeSpinner({ isTTY: process.stdout.isTTY, styler: ui });
  spin.start(`scanning ${tilde(os.homedir())} for projects`);
  try {
    await runScan(env);
  } catch (err) {
    spin.fail();
    process.stderr.write(`xerb: scan failed (${err.message}); continuing with whatever registry exists.\n`);
    return;
  }
  await spin.done(foundLine(readProjects()));
}

// ---------------------------------------------------------------------------
// consent
// ---------------------------------------------------------------------------

// The first-run prompt: exactly what will happen, in checkable terms, before a
// single directory is read. Declining exits with nothing scanned and nothing
// installed. Re-runs (a registry already exists) skip it — consent was given.
async function askConsent({ willInstallSkill }) {
  const { bold, dim, cyan, green, yellow, magenta } = ui;
  const out = (s = '') => process.stdout.write(s + '\n');
  out();
  for (const line of paintLogo(ui)) out(`  ${line}`);
  out();
  out(`  ${dim(`v${VERSION} · starts dev servers when you open their URL, stops them when idle`)}`);
  out();
  // One colored verb per action, in a column: the eye lands on four verbs
  // first and reads a line only if it wants the detail.
  const step = (color, verb, what, note) => out(`  ${bold(color(verb.padEnd(9)))}${what} ${dim(`· ${note}`)}`);
  step(cyan, 'scan', 'your home folder for dev projects', 'reads config files, writes nothing');
  out(dim(`           macOS may ask to let your terminal read Desktop, Documents or Downloads; Don't Allow skips that folder`));
  step(magenta, 'pick', `which get a URL like ${bold(cyan('http://<name>.localhost'))}`, 'works only on this machine');
  step(green, 'install', 'a background service', 'no sudo, keeps the URLs working after reboot');
  if (willInstallSkill) {
    step(yellow, 'add', 'the add-project skill to ~/.claude/skills', 'for projects the scan misses');
  }
  out();
  out(`  ${dim('everything is stored in')} ${tilde(stateDir)} ${dim('·')} ${cyan('xerb uninstall')} ${dim('deletes all of it')}`);
  out();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = (await rl.question(`  ${bold('proceed?')} ${dim('[')}${green('Y')}${dim('/n]')} `)).trim().toLowerCase();
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

// launchctl's stdout, for the one place we need to READ it rather than just
// check its exit status: the daemon's pid, before uninstall boots it out.
function launchctlOut(args) {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '') : '';
}

// Is the launchd daemon still running? A pid captured before the bootout is
// the direct answer — signal 0 asks the kernel whether it exists without
// touching it. EPERM means it exists and merely isn't ours to signal, which is
// still alive. With no pid (launchd had none to give) fall back to asking
// whether the job is in the domain at all.
function daemonAlive(pid, domain) {
  if (pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return !!err && err.code === 'EPERM';
    }
  }
  return launchctl(['print', `${domain}/${LAUNCHD_LABEL}`]);
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

// A git checkout is a dev install: the LaunchAgent runs the checkout directly
// (no app copy — the repo is not a cache that vanishes) and the daemon watches
// its own source, so an edit here is live at xerb.localhost a moment later.
const IS_CHECKOUT = fs.existsSync(path.join(ROOT, '.git'));

// A checkout install is "current" when the deployed plist already runs THIS
// checkout — the version comparison below is meaningless when the code
// live-reloads out from under it.
function plistRunsCheckout() {
  try {
    return fs.readFileSync(PLIST_PATH, 'utf8').includes(`<string>${path.join(ROOT, 'xerb.mjs')}</string>`);
  } catch {
    return false;
  }
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
  let files = ['bin', 'lib', 'xerb.mjs', 'scan.mjs'];
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

  // Stop any existing agent first (under this name or the old one), then
  // refresh the app copy. A checkout runs in place instead: no copy, and the
  // daemon live-reloads.
  await retireLegacyInstall();
  await launchctlAsync(['bootout', `${domain}/${LAUNCHD_LABEL}`]);
  const appDir = IS_CHECKOUT ? ROOT : APP_DIR;
  if (!IS_CHECKOUT) await copyApp();

  // The daemon runs a node that outlives a version manager or a brew upgrade
  // removing this one (see stableNode). Project start commands still find
  // the user's own node on PATH.
  const nodeBin = stableNode(process.execPath, NODE_PIN);
  const plist = renderPlist({
    nodeBin,
    daemonPath: path.join(appDir, 'xerb.mjs'),
    workDir: appDir,
    stateDir,
    logsDir,
    home: os.homedir(),
    // The daemon must resolve every project's start command to the same binary
    // the user's shell would — so it inherits this install shell's PATH.
    pathEnv: assembleLaunchdPath({
      userPath: process.env.PATH || '',
      nodeDir: path.dirname(process.execPath),
      home: os.homedir(),
    }),
    frontPort: FRONT_PORT,
    fallbackPort: FALLBACK_PORT,
    devWatch: IS_CHECKOUT,
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

  // Put `xerb` on PATH: a symlink to this same entrypoint in the app copy
  // (or the checkout, on a dev install).
  fs.mkdirSync(path.dirname(CLI_LINK), { recursive: true });
  try { fs.rmSync(CLI_LINK, { force: true }); } catch { /* fine */ }
  fs.symlinkSync(path.join(appDir, 'bin', 'xerb.mjs'), CLI_LINK);

  // The add-project skill, for machines that run Claude Code (~/.claude
  // exists). Replaced wholesale on every install so it tracks the daemon.
  let skillInstalled = false;
  if (fs.existsSync(SKILL_SRC) && fs.existsSync(path.join(os.homedir(), '.claude'))) {
    await fs.promises.rm(SKILL_DEST, { recursive: true, force: true });
    await fs.promises.mkdir(path.dirname(SKILL_DEST), { recursive: true });
    await fs.promises.cp(SKILL_SRC, SKILL_DEST, { recursive: true });
    skillInstalled = true;
  }

  // Wait for the daemon: :80 when it won the front door, else the fallback
  // port. It has to be xerb answering, not just something: Herd, Valet, MAMP
  // or a Docker container on :80 would otherwise get the printed URLs.
  onStep('waking the daemon');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const live = await findDaemon();
    if (live) return { up: true, port: live.port, skillInstalled };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { up: false, port: FRONT_PORT, skillInstalled };
}

function printInstalledBanner({ projects, port, startedAt, skillInstalled, verb = 'installed' }) {
  const { bold, dim, cyan, yellow } = ui;
  const out = (s = '') => process.stdout.write(s + '\n');
  const readyMs = Date.now() - startedAt;
  out();
  out(`  ${cyan(bold('xerb'))} ${dim(`v${VERSION}`)}  ${verb} ${dim(`in ${readyMs} ms`)}`);
  out();
  if (!projects.length) {
    out(`  no projects found under ${tilde(os.homedir())}.`);
    out(dim('  a project is anything the scan can prove how to run: package.json with a "dev" script, rails, django with a venv, a static folder; add one and run `xerb` again.'));
  } else {
    out(`  ${dim('dashboard')}  ${bold(formatProjectUrl('xerb', port))}`);
    out(`  ${dim('projects')}   ${projects.length} ${dim('· open a URL and its dev server starts')}`);
    out();
    const urls = projects.map((p) => formatProjectUrl(p.host, port)).sort();
    // The host is the part that differs row to row, so it alone stays bright.
    const paint = (url) => url.replace(/^(http:\/\/)(.+?)(\.localhost(?::\d+)?)$/, (_, a, host, b) => dim(a) + host + dim(b));
    const { lines, hidden } = columnize(urls, { width: process.stdout.columns || 80, paint });
    for (const line of lines) out(line);
    if (hidden) out(dim(`  and ${hidden} more · \`xerb status\` lists them all`));
  }
  if (port !== 80) {
    const holder = portHolder(80);
    out();
    out(`  ${yellow('!')} port 80 is taken${holder ? ` by ${bold(holder)}` : ''}, so every URL ends in :${port}.`);
    out(dim(`    stop it, then \`xerb install\` moves xerb to plain http://<name>.localhost URLs.`));
  }
  const guarded = [...new Set(projects.map((p) => protectedRoot(p.dir, os.homedir())).filter(Boolean))];
  if (guarded.length) {
    out();
    out(`  ${yellow('!')} some projects live in ${guarded.join(', ')}. if macOS asks whether ${bold('node')} may access`);
    out(`    ${guarded.length === 1 ? 'that folder' : 'those folders'}, click Allow: the service cannot start them otherwise.`);
  }
  out();
  out(dim(`  runs in the background and survives reboots · registry: ${tilde(configPath)} · logs: ${tilde(logsDir)}`));
  out(dim('  `xerb` rescans for new projects · `xerb uninstall` removes everything'));
  if (skillInstalled) {
    out(dim('  agent skill: add-project installed to ~/.claude/skills · other agents: npx skills add joudbitar/xerb'));
  }
  const pathDirs = (process.env.PATH || '').split(':');
  if (!pathDirs.includes(path.dirname(CLI_LINK))) {
    // A stock macOS zsh does not have ~/.local/bin on PATH, so this is most
    // first installs: hand over the exact line rather than the idea of it.
    out();
    out(`  ${yellow('!')} the ${bold('xerb')} command is in ${tilde(path.dirname(CLI_LINK))}, which is not on your PATH. to fix it:`);
    const rc = /bash$/.test(process.env.SHELL || '') ? '~/.bash_profile' : '~/.zshrc';
    out(`    ${cyan(`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${rc}`)} ${dim('then open a new terminal')}`);
    out(dim('    until then, `npx xerb <command>` does the same thing.'));
  }
  out();
}

// The name of whatever holds `port`, or null. lsof without sudo only sees
// this user's processes, so a root nginx comes back null and the copy says
// "taken" without a name.
function portHolder(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fc'], { encoding: 'utf8', timeout: 3000 });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('c'));
  return line ? line.slice(1) : null;
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
    out('  `xerb` command, and the add-project skill. your projects are not');
    out('  touched.');
    out();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      answer = (await rl.question('  remove xerb? [y/N] ')).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (answer !== 'y' && answer !== 'yes') {
      out('  kept everything as it was.');
      return 0;
    }
  }

  // True unless the daemon outlived the wait below; only then does the closing
  // "state removed" need a caveat.
  let daemonExited = true;

  if (process.platform === 'darwin') {
    const domain = `gui/${process.getuid()}`;
    // Ask launchd who the daemon IS before booting it out: once the label
    // leaves the domain, nothing is left to name the process still winding
    // down.
    const pid = parseLaunchdPid(launchctlOut(['print', `${domain}/${LAUNCHD_LABEL}`]));
    launchctl(['bootout', `${domain}/${LAUNCHD_LABEL}`]) || launchctl(['unload', PLIST_PATH]);
    fs.rmSync(PLIST_PATH, { force: true });
    // bootout returns once launchd has ACCEPTED the request, not once the
    // process is gone — and a daemon in that window still writes. Deleting the
    // state dir underneath it is how "removes every trace" left one: the
    // config watch fired on the vanishing projects.json, logged one ENOENT
    // line, and rebuilt logs/ a second after uninstall said the machine was
    // clean. So wait for the process to actually exit before anything below
    // deletes its state. A daemon that outlives the wait still gets its state
    // dir removed — the ordering is what we can fix, not a wedged process.
    daemonExited = await waitForExit({ isAlive: () => daemonAlive(pid, domain), timeoutMs: 5_000 });
  }

  // The PATH symlink, but only if it is ours: a symlink whose target mentions
  // xerb. A real file someone else put there is left alone.
  try {
    const target = fs.readlinkSync(CLI_LINK);
    if (target.includes('xerb')) fs.rmSync(CLI_LINK, { force: true });
  } catch { /* not a symlink or absent — leave it */ }

  // The agent skill, but only if it is ours: its SKILL.md must mention
  // xerb. A same-named skill from somewhere else is left alone.
  try {
    if (fs.readFileSync(path.join(SKILL_DEST, 'SKILL.md'), 'utf8').includes('xerb')) {
      fs.rmSync(SKILL_DEST, { recursive: true, force: true });
    }
  } catch { /* absent — nothing to remove */ }

  // A machine installed the old Caddy way still has a xerb block in its
  // Caddyfile; strip it and reload so :80 is truly released. Best-effort — a
  // machine without brew or caddy skips all of this silently.
  const brewPrefix = spawnSync('brew', ['--prefix'], { encoding: 'utf8' }).stdout?.trim() || '/opt/homebrew';
  const caddyfile = path.join(brewPrefix, 'etc', 'Caddyfile');
  try {
    const before = fs.readFileSync(caddyfile, 'utf8');
    const { text, changed } = stripCaddyBlock(before);
    if (changed) {
      fs.copyFileSync(caddyfile, `${caddyfile}.bak.xerb-uninstall`);
      fs.writeFileSync(caddyfile, text);
      const caddy = which('caddy');
      if (caddy) spawnSync(caddy, ['reload', '--config', caddyfile], { stdio: 'ignore' });
      out(dim(`  removed the xerb block from ${caddyfile} (backup alongside).`));
    }
  } catch { /* no Caddyfile — nothing to clean */ }

  fs.rmSync(stateDir, { recursive: true, force: true });

  out();
  out('  xerb is gone: service stopped, state removed. thanks for trying it.');
  if (!daemonExited) {
    out(dim(`  the daemon was still running 5s after being stopped; if ${tilde(stateDir)} comes back, remove it once it has exited.`));
  }
  out();
  return 0;
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
  // `--version` on a /usr/bin stub opens the "install developer tools" dialog
  // in the middle of the install. Name the fix instead of running it.
  if (isToolStub(whichOn(tool, servicePath))) return { tool, ok: false, reason: 'no-devtools' };
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
      out(dim(`    two installs of one tool can behave differently — \`xerb install\` rebakes the service PATH from this shell.`));
    } else if (r.reason === 'no-devtools') {
      out(`  ${red('⚠')} ${bold(r.tool)} needs the Xcode command line tools, which this Mac does not have yet.`);
      out(dim(`    run \`xcode-select --install\`; projects that start with ${r.tool} will not come up until then.`));
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
  // Accept the URL form too: `xerb logs tradepulse.localhost`.
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
    out(`  usage: ${bold('xerb logs <host>')} ${dim('[-n lines]')}`);
    out();
    listAvailable();
    out();
    return host ? 1 : 0;
  }

  // `xerb logs daemon` reads the daemon's own log; everything else is a
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
    process.stderr.write(`xerb: could not read ${file}: ${err.message}\n`);
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
// control API: the runtime half of the CLI.
//
// `status`, `stop`, `restart`, `wake`, `attach` and `logs -f` ask the LIVE
// daemon, because only it knows what is running, on which pid, and how long it
// has been idle. The capability token in <state>/control-token is the
// authorization (the daemon also wants same-origin, which a request carrying
// no Origin header satisfies); a CLI on this machine can read that file
// precisely because it is the user's own shell.
// ---------------------------------------------------------------------------

const NOT_RUNNING = 'xerb is not running; run `xerb` to start it';

function controlToken() {
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return ''; // no daemon has ever minted one, so the request 403s and we say so
  }
}

// timeoutMs is the CLI's own backstop, not the daemon's: a bring-up POST
// (`up`, `restart`) answers only once the start has settled, and the daemon
// caps that itself with startTimeoutMs, so those callers pass a longer one
// than the read paths need.
function controlRequest(port, method, pathname, body, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: {
          // The daemon routes by Host; the control plane lives on its own host.
          host: 'xerb.localhost',
          'x-xerb-token': controlToken(),
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(b); } catch { /* an HTML error page, not JSON */ }
          resolve({ status: res.statusCode, body: b, json });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('control request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

// Which port is the daemon actually on: the front door, or the numbered
// fallback it took when :80 was spoken for? GET /__xerb/status is the probe
// rather than a bare TCP connect, because "something is listening" is not
// "xerb is listening". Returns { port, status } or null.
async function findDaemon() {
  for (const port of new Set([FRONT_PORT, FALLBACK_PORT])) {
    try {
      const r = await controlRequest(port, 'GET', '/__xerb/status');
      if (r.status === 200 && r.json && Array.isArray(r.json.projects)) return { port, status: r.json };
    } catch { /* nothing of ours there */ }
  }
  return null;
}

function notRunning() {
  process.stderr.write(`xerb: ${NOT_RUNNING}\n`);
  return 3;
}

function needHost(cmd, usage) {
  process.stderr.write(`xerb: ${cmd} needs a project name. usage: ${usage}\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// the command table, printed by -h/--help/help and again under any unknown
// command, because the fix for a typo is the list of what exists.
// ---------------------------------------------------------------------------

function helpText() {
  const { bold, dim } = ui;
  return [
    '',
    `  ${bold('xerb')} ${dim(`v${VERSION}`)}  ${dim('every project gets a URL that starts its dev server on request')}`,
    '',
    `  xerb                     ${dim('first run: consent, scan, install. later: rescan')}`,
    `  xerb status              ${dim('every project, state, port, idle, one line each')}`,
    `  xerb add [dir] [--cmd "..."] [--port N] [--name host] [--parked]`,
    `  xerb remove <host>`,
    `  xerb enable <host> | disable <host>`,
    `  xerb port <host> <N>`,
    `  xerb rename <host> <new>`,
    `  xerb stop <host> | restart <host> | wake <host>`,
    `  xerb open <host>         ${dim('open http://<host>.localhost in the default browser')}`,
    `  xerb logs <host> [-n N] [-f]`,
    `  xerb attach <host>       ${dim("your terminal becomes the dev server's terminal")}`,
    `  xerb install             ${dim('force a reinstall (rebake the service PATH)')}`,
    `  xerb uninstall`,
    '',
    `  ${dim('-h, --help     this table')}`,
    `  ${dim('-v, --version  print the version')}`,
    '',
    '',
  ].join('\n');
}

// argv into flags and positionals. A flag with no value (--parked, -f, -y) is
// a boolean; anything else takes the next argument, so `--cmd "npm run dev"`
// keeps its quoted value and `--port=3010` works too.
const BOOLEAN_FLAGS = new Set(['--parked', '--yes', '-y', '-f', '--follow', '-h', '--help', '-v', '--version', '--all']);

function parseArgv(argv) {
  const flags = new Map();
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.length > 1 && a.startsWith('-')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags.set(a.slice(0, eq), a.slice(eq + 1));
      } else if (BOOLEAN_FLAGS.has(a)) {
        flags.set(a, true);
      } else {
        flags.set(a, argv[++i]);
      }
      continue;
    }
    rest.push(a);
  }
  return { flags, rest };
}

// ---------------------------------------------------------------------------
// registry subcommands. Every one writes projects.json through
// lib/registry-cli.mjs and stops. The daemon watches that file, so there is no
// second step; where a change would strand a running server (a removed
// project, a renamed host, a disabled one) the server is stopped first over
// the control API.
// ---------------------------------------------------------------------------

function loadRegistry() {
  if (!fs.existsSync(configPath)) {
    throw new RegistryError(`no registry yet at ${tilde(configPath)}; run \`xerb\` once first.`);
  }
  return readRegistry(configPath);
}

// Best-effort stop: used before an edit that would otherwise leave a dev
// server running under a name the registry no longer has. A dead daemon means
// nothing is running, which is the same outcome.
async function stopIfRunning(host) {
  const live = await findDaemon();
  if (!live) return;
  try {
    await controlRequest(live.port, 'POST', `/__xerb/stop/${encodeURIComponent(host)}`);
  } catch { /* it was not running */ }
}

// The example command under "nothing provable". A hint for a human to edit,
// not a detector: first marker wins, and likelihood is good enough here where
// it is not in lib/detect.mjs.
function startHint(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const read = (f) => {
    try { return fs.readFileSync(path.join(dir, f), 'utf8').toLowerCase(); } catch { return ''; }
  };
  const reqs = read('requirements.txt');
  const pyDeps = reqs + read('pyproject.toml');
  const readsPort = 'the app has to read PORT from the environment.';
  if (has('manage.py')) return { cmd: 'python manage.py runserver <port>' };
  if (has('app.py') || has('wsgi.py') || reqs.includes('flask')) return { cmd: 'flask run --port <port>' };
  if (has('main.py') && /fastapi|uvicorn/.test(pyDeps)) return { cmd: 'uvicorn main:app --port <port>' };
  if (has('go.mod')) return { cmd: 'go run .', note: readsPort };
  if (has('Cargo.toml')) return { cmd: 'cargo run', note: readsPort };
  if (has('docker-compose.yml') || has('compose.yaml')) {
    return { cmd: 'docker compose up', port: true, note: 'set --port to the port the compose file publishes.' };
  }
  if (has('Gemfile')) return { cmd: 'bundle exec rackup -p <port>' };
  if (has('package.json')) return { cmd: 'npm start' };
  return { cmd: 'your-start-command --port <port>' };
}

async function cmdAdd({ flags, rest }) {
  const { bold, dim } = ui;
  const out = (s = '') => process.stdout.write(s + '\n');

  const dir = path.resolve(expandTilde(rest[0] || process.cwd()));
  if (!fs.existsSync(dir)) {
    process.stderr.write(`xerb: no such directory: ${dir}\n`);
    return 1;
  }
  const nameFlag = flags.get('--name');
  const host = sanitizeHost(typeof nameFlag === 'string' && nameFlag ? nameFlag : path.basename(dir));
  const cmdFlag = flags.get('--cmd');
  const portFlag = flags.get('--port');
  const parked = flags.get('--parked') === true;

  // The detectors only run when the user did not say how to start the project.
  // A wrong startCmd executes arbitrary code on every visit to the URL, so the
  // bar here is the same proof scan.mjs demands, and an unprovable folder
  // gets the evidence list, not a guess.
  let det = null;
  if (typeof cmdFlag !== 'string' || !cmdFlag.trim()) {
    det = detectOne(dir);
    if (!det) {
      out();
      out(`  nothing provable in ${bold(tilde(dir))}. the detectors looked for:`);
      for (const [name, evidence] of DETECTOR_EVIDENCE) out(`    ${name.padEnd(7)} ${dim(evidence)}`);
      out();
      out(`  say how it starts and it is registered either way:`);
      const hint = startHint(dir);
      out(`    ${bold(`xerb add ${tilde(dir)} --cmd "${hint.cmd}"${hint.port ? ' --port <published port>' : ''}`)}`);
      if (hint.note) out(dim(`    ${hint.note}`));
      out(dim('    the command runs with cwd set to that folder and PORT in the environment.'));
      out(dim('    `<port>` is replaced with the port xerb assigns.'));
      out();
      return 1;
    }
  }

  ensureStateDir();
  const reg = fs.existsSync(configPath) ? readRegistry(configPath) : { projects: [] };
  const known = reg.projects.find((p) => p.dir === dir) || null;

  // The port has to be settled BEFORE the start command: rails and django
  // ignore the injected PORT, so their command carries the number.
  let port;
  if (portFlag !== undefined && portFlag !== true) port = Number(portFlag);
  else if (det && det.fixedPort) port = det.fixedPort;
  else if (known) port = known.port;
  else port = await pickPort(reg);

  // Re-adding a folder updates its entry in place, so this is also a port
  // change and a rename. Remember what it was: a running server under the old
  // host or on the old port has to be stopped, or the daemon proxies to a port
  // nothing answers on, and a record keyed by a host the registry no longer has
  // can never be stopped or reaped again.
  const wasHost = known ? known.host : null;
  const wasPort = known ? known.port : null;

  const startCmd = det ? startCmdFor(det, port) : String(cmdFlag).trim();
  const { entry, updated } = await addEntry(reg, {
    host,
    dir,
    startCmd,
    port,
    framework: det ? det.framework : 'node',
    parked,
    fixedPort: det && det.fixedPort,
  });
  if (wasHost !== null && (wasHost !== entry.host || wasPort !== entry.port)) {
    await stopIfRunning(wasHost);
  }
  writeRegistry(configPath, reg);

  const live = await findDaemon();
  out();
  out(`  ${updated ? 'updated' : 'registered'} ${bold(entry.host)} ${dim(`:${entry.port}`)}`);
  out(`    ${dim('dir')}    ${tilde(entry.dir)}`);
  out(`    ${dim('start')}  ${entry.startCmd}`);
  if (entry.enabled === false) {
    out(`    ${dim(`parked · \`xerb enable ${entry.host}\` turns it on`)}`);
  } else if (live) {
    out(`    ${dim('url')}    ${bold(formatProjectUrl(entry.host, live.port))}`);
  } else {
    out(`    ${dim(NOT_RUNNING)}`);
  }
  out();
  return 0;
}

async function cmdRemove(host) {
  if (!host) return needHost('remove', 'xerb remove <host>');
  const reg = loadRegistry();
  const entry = removeEntry(reg, host); // throws before anything is stopped
  await stopIfRunning(host);
  writeRegistry(configPath, reg);
  process.stdout.write(`  removed ${ui.bold(host)}. ${ui.dim(`${tilde(entry.dir)} was not touched.`)}\n`);
  return 0;
}

async function cmdEnable(host, enabled) {
  const verb = enabled ? 'enable' : 'disable';
  if (!host) return needHost(verb, `xerb ${verb} <host>`);
  const reg = loadRegistry();
  setEnabled(reg, host, enabled);
  if (!enabled) await stopIfRunning(host);
  writeRegistry(configPath, reg);
  process.stdout.write(`  ${host} is ${enabled ? 'enabled' : 'disabled'}.\n`);
  return 0;
}

async function cmdPort(host, value) {
  if (!host || value === undefined) {
    process.stderr.write('xerb: usage: xerb port <host> <N>\n');
    return 1;
  }
  // A running server is bound to the old port; changing the registry under it
  // would leave the daemon proxying to a port nothing answers on.
  const live = await findDaemon();
  const row = live ? live.status.projects.find((p) => p.host === host) : null;
  if (row && row.state === 'running') {
    process.stderr.write(`xerb: ${host} is running on :${row.port}. stop it first: xerb stop ${host}\n`);
    return 1;
  }
  const reg = loadRegistry();
  const entry = setPort(reg, host, value);
  writeRegistry(configPath, reg);
  process.stdout.write(`  ${host} now starts on :${entry.port}.\n`);
  return 0;
}

async function cmdRename(from, to) {
  if (!from || !to) {
    process.stderr.write('xerb: usage: xerb rename <host> <new>\n');
    return 1;
  }
  const reg = loadRegistry();
  renameEntry(reg, from, to); // validates before anything is stopped
  // The runtime record is keyed by host, so an owned server under the old name
  // is stopped; the next hit on the new URL is an ordinary cold start.
  await stopIfRunning(from);
  writeRegistry(configPath, reg);
  const live = await findDaemon();
  process.stdout.write(`  ${from} is now ${ui.bold(to)}${live ? ` ${ui.dim(formatProjectUrl(to, live.port))}` : ''}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// runtime subcommands
// ---------------------------------------------------------------------------

function fmtIdle(ms) {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// A failed row's note: the kind in words, then the log's error line when the
// daemon found one.
function failureNote(r) {
  const le = r.lastError;
  const line = le.errorLine ? ` · ${le.errorLine}` : '';
  switch (le.kind) {
    case 'exited':
      if (le.exitCode != null) return `exited with code ${le.exitCode}${line}`;
      return `${le.signal ? `exited on ${le.signal}` : 'exited'}${line}`;
    case 'timeout':
      return `nothing on :${r.port} after ${Math.round((le.timeoutMs ?? 120_000) / 1000)}s`;
    case 'dir-missing':
      return 'folder is gone';
    case 'blocked':
      return 'macOS blocked the folder · allow node in System Settings › Privacy & Security › Files and Folders';
    case 'no-devtools':
      return 'python3 needs the Xcode command line tools · run xcode-select --install';
    case 'install-failed':
      return `${le.installCmd || 'npm install'} failed${line}`;
    default:
      return `${le.kind || 'failed'}${line}`;
  }
}

async function cmdStatus() {
  const { bold, dim, green, red } = ui;
  const out = (s = '') => process.stdout.write(s + '\n');
  const live = await findDaemon();
  if (!live) return notRunning();
  const rows = live.status.projects;
  out();
  // Spec section 6: with no python3 the dev servers run on plain pipes, the
  // terminal panel is read-only, and this is the one line that says so. The
  // daemon works it out (it is the process that looks for the interpreter) and
  // ships it in the status payload; printing it once, above the rows, is the
  // whole of the CLI's half.
  if (live.status.pty && live.status.pty.note) {
    out(dim(`  ${live.status.pty.note}`));
    out();
  }
  if (!rows.length) {
    out(`  no projects registered. ${dim('`xerb add [dir]` registers one, `xerb` rescans.')}`);
    out();
    return 0;
  }
  const w = Math.max(...rows.map((r) => r.host.length));
  // Cut to the terminal, so a long error line never wraps the table. A pipe
  // has no width and gets the whole line.
  const cols = process.stdout.isTTY ? process.stdout.columns : 0;
  let anyFailed = false;
  for (const r of rows) {
    const state = !r.enabled ? 'disabled'
      : r.conflict ? 'conflict'
        : r.state === 'stopped' && r.lastError ? 'failed'
          : r.state;
    const mark = state === 'running' ? green('*')
      : state === 'conflict' ? red('!')
        : state === 'failed' ? red('x')
          : dim('.');
    const notes = [];
    if (state === 'failed') {
      anyFailed = true;
      const used = 4 + w + 2 + 9 + `:${r.port}`.length + 2;
      const note = failureNote(r);
      notes.push(cols && used + note.length > cols ? `${note.slice(0, Math.max(0, cols - used - 1))}…` : note);
    }
    if (state === 'running' && !r.owned) notes.push('external');
    if (state === 'running' && r.idleForMs != null) notes.push(`idle ${fmtIdle(r.idleForMs)}`);
    if (state === 'conflict' && r.conflictDir) notes.push(`port held by ${tilde(r.conflictDir)}`);
    out(`  ${mark} ${r.host.padEnd(w)}  ${state.padEnd(8)} ${dim(`:${r.port}`)}${notes.length ? dim(`  ${notes.join(' · ')}`) : ''}`);
  }
  if (anyFailed) out(dim('  `xerb logs <host>` shows why · `xerb restart <host>` tries again'));
  out();
  out(dim(`  dashboard ${formatProjectUrl('xerb', live.port)} · sleeps after ${fmtIdle(live.status.idleTimeoutMs)} idle · \`xerb logs <host>\``));
  out();
  return 0;
}

// stop / wake / restart. restart is ONE daemon call, not stop-then-wake: stop()
// returns as soon as the SIGTERM is sent, and a dev server that holds its port
// for even a moment after that (Next, Vite, Rails all do) is still listening
// when the wake probes it, so the wake finds a listener in the project's own
// folder and adopts the process we just killed. /__xerb/restart waits for
// the port to go quiet in between, and writes one log separator for the start
// that follows.
async function cmdRuntime(action, host) {
  if (!host) return needHost(action, `xerb ${action} <host>`);
  const live = await findDaemon();
  if (!live) return notRunning();
  const row = live.status.projects.find((p) => p.host === host);
  if (!row) {
    process.stderr.write(`xerb: no project named "${host}". \`xerb status\` lists them.\n`);
    return 1;
  }
  const post = (p, opts) => controlRequest(live.port, 'POST', p, undefined, opts);
  // A wake or a restart holds the connection open for the whole bring-up
  // (install included), so the CLI waits out anything the daemon is willing
  // to wait out rather than reporting a timeout the daemon never hit.
  const bringUp = { timeoutMs: 15 * 60_000 };

  if (action === 'stop') {
    const r = await post(`/__xerb/stop/${encodeURIComponent(host)}`);
    if (r.status === 403) {
      process.stderr.write('xerb: the daemon refused the control token; run `xerb` to reinstall it.\n');
      return 1;
    }
    const ok = r.json && r.json.ok;
    process.stdout.write(ok ? `  stopped ${host}.\n` : `  ${host} was not running (${(r.json && r.json.reason) || 'stopped'}).\n`);
    return 0;
  }

  const r = await post(
    action === 'restart'
      ? `/__xerb/restart/${encodeURIComponent(host)}`
      : `/__xerb/up/${encodeURIComponent(host)}`,
    bringUp
  );
  if (r.status === 403) {
    process.stderr.write('xerb: the daemon refused the control token; run `xerb` to reinstall it.\n');
    return 1;
  }
  if (r.status === 200) {
    process.stdout.write(`  ${action === 'restart' ? 'restarted' : 'woke'} ${host} ${ui.dim(formatProjectUrl(host, live.port))}\n`);
    return 0;
  }
  if (r.status === 409) {
    process.stderr.write(`xerb: ${host} is disabled. \`xerb enable ${host}\` first.\n`);
    return 1;
  }
  process.stderr.write(`xerb: ${host} did not come up (${(r.json && r.json.reason) || r.status}). \`xerb logs ${host}\` has its output.\n`);
  return 1;
}

// `open` uses macOS's own `open`, so the URL lands in whatever the user set as
// their default browser. The port is the one the daemon actually answers on.
async function cmdOpen(host) {
  if (!host) return needHost('open', 'xerb open <host>');
  const live = await findDaemon();
  if (!live) return notRunning();
  if (!live.status.projects.some((p) => p.host === host) && host !== 'xerb') {
    process.stderr.write(`xerb: no project named "${host}". \`xerb status\` lists them.\n`);
    return 1;
  }
  const url = formatProjectUrl(host, live.port);
  const r = spawnSync('open', [url], { stdio: 'ignore' });
  if (r.status !== 0) {
    process.stderr.write(`xerb: could not open ${url}\n`);
    return 1;
  }
  process.stdout.write(`  ${url}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// attach / logs -f: the two CLI clients of the per-project terminal socket.
//
// Both open GET /__xerb/term/<host>, a WebSocket upgrade the daemon serves
// on its control plane (spec 0.3.0 section 6). The daemon's first frame is the
// scrollback, then live pty bytes; the client speaks `i:<bytes>` for input and
// `r:<rows>,<cols>` for a resize.
//
// attach puts the local tty in raw mode and relays both ways, so Ctrl-C, a
// Vite keystroke and a `(y/n)` prompt all reach the dev server. `logs -f` is
// the same socket with the escapes stripped and no raw mode, so it reads like
// the log file it is following.
//
// Neither one owns the dev server: it is xerb's child, started before this
// shell and outliving it. Detaching stops nothing.
// ---------------------------------------------------------------------------

const TERM_PATH = '/__xerb/term/';
const DETACH_BYTE = 0x1d; // Ctrl-]
// Signals worth cleaning up for. Ctrl-C is NOT one of them while attached: raw
// mode turns it into a 0x03 byte for the dev server, which is the point.
const LEAVE_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// Complete escape sequences, the same four patterns the daemon runs before it
// writes <host>.log, so a `logs -f` and a `xerb logs` of one run read alike.
// ESC [ and ESC ] stay out of ESC2_RE so a CSI or OSC split across two frames
// is carried rather than eaten one character at a time.
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_RE = /\u001b\[[0-9;:?<>=!]*[ -\/]*[@-~]/g;
const ESC2_RE = /\u001b[()#][0-9A-Za-z]|\u001b[@A-Z\\^_=><]/g;
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// Frames in, plain text out. Stateful: whatever might still be the start of a
// sequence is held back until the next frame completes it.
function makeStripper() {
  let carry = '';
  return (buf) => {
    let text = carry + buf.toString('utf8');
    carry = '';
    text = text.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC2_RE, '');
    // A leftover ESC is an incomplete sequence. Capped, so one stray ESC byte
    // cannot stall the stream forever.
    const esc = text.lastIndexOf('\u001b');
    if (esc >= 0 && text.length - esc <= 64) {
      carry = text.slice(esc);
      text = text.slice(0, esc);
    }
    if (text.endsWith('\r')) {
      carry = '\r' + carry;
      text = text.slice(0, -1);
    }
    // A pty ends lines with CRLF and redraws a progress line with a bare CR.
    // Both become newlines, which is what makes the output greppable.
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(CTRL_RE, '');
  };
}

// Every frame the daemon sends is terminal bytes: binary for pty output, text
// for the lines the daemon writes itself (the start separator, the read-only
// note).
function frameBytes(data) {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

// Open the terminal socket, resolved once the handshake is up.
//
// 127.0.0.1 and not xerb.localhost: the daemon routes on the Host header,
// an IP literal names no project (which IS the control plane the terminal
// socket demands), and it skips a DNS lookup that answers ::1 on a machine
// whose daemon is bound to 127.0.0.1.
//
// The token rides in Sec-WebSocket-Protocol rather than a header because the
// dashboard's panel cannot set headers on a WebSocket, and one auth path for
// both clients is one path to keep right.
function openTermSocket(port, host) {
  const token = controlToken();
  if (!token) throw new Error('no control token in the state dir; run `xerb` to mint one');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${TERM_PATH}${encodeURIComponent(host)}`, [token]);
  ws.binaryType = 'arraybuffer'; // raw pty bytes, not a Blob to await
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws), { once: true });
    // A refused handshake reaches the client as a bare Event with no status on
    // it, so the message says what the caller can act on instead of guessing.
    ws.addEventListener('error', () => reject(new Error('the daemon refused the terminal socket')), { once: true });
  });
}

// `xerb attach <host>`: this terminal becomes the dev server's terminal.
function attachTerm(ws, host) {
  const { bold, dim } = ui;
  const stdin = process.stdin;
  let rawOn = false;

  // One restore, idempotent, reachable from every way out: Ctrl-], the socket
  // closing, a signal, and process exit itself. A tty left in raw mode is a
  // shell that stopped echoing, which is the worst thing this could leave
  // behind, so the 'exit' hook stays registered even after a clean detach.
  const restore = () => {
    if (!rawOn) return;
    rawOn = false;
    try {
      stdin.setRawMode(false);
    } catch {
      /* the tty went away before we did */
    }
  };
  process.on('exit', restore);

  return new Promise((resolve) => {
    let done = false;

    const sendSize = () => {
      const { rows, columns } = process.stdout;
      if (!rows || !columns) return; // not a tty: the daemon's startup size stands
      try {
        ws.send(`r:${rows},${columns}`);
      } catch {
        /* the socket is on its way out */
      }
    };

    const onInput = (chunk) => {
      const at = chunk.indexOf(DETACH_BYTE);
      const upto = at === -1 ? chunk : chunk.subarray(0, at);
      // utf8 on purpose: the daemon writes the frame's text straight into the
      // pty, and the dashboard panel sends strings too, so both clients decode
      // the same way.
      if (upto.length) {
        try {
          ws.send('i:' + upto.toString('utf8'));
        } catch {
          /* the socket is on its way out */
        }
      }
      if (at !== -1) leave(0, `\r\n  detached. ${host} keeps running; \`xerb stop ${host}\` stops it.\n`);
    };

    const onWinch = () => sendSize();
    const onSignal = () => leave(130, `\r\n  detached. ${host} keeps running.\n`);

    function leave(code, note) {
      if (done) return;
      done = true;
      restore();
      process.removeListener('SIGWINCH', onWinch);
      for (const sig of LEAVE_SIGNALS) process.removeListener(sig, onSignal);
      stdin.removeListener('data', onInput);
      // pause() stops the reading; unref() is what lets the process actually
      // exit. A resumed stdin pipe stays refed on its own, so without this the
      // shell hangs on a detach that has already printed its goodbye.
      stdin.pause();
      if (stdin.unref) stdin.unref();
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      if (note) process.stdout.write(note);
      resolve(code);
    }

    ws.addEventListener('message', (ev) => process.stdout.write(frameBytes(ev.data)));
    ws.addEventListener('close', () => leave(0, `\r\n  ${host}: the terminal socket closed.\n`));
    ws.addEventListener('error', () => leave(1, `\r\n  ${host}: the terminal socket dropped.\n`));

    if (stdin.isTTY && stdin.setRawMode) {
      stdin.setRawMode(true);
      rawOn = true;
    }
    stdin.on('data', onInput);
    stdin.resume();
    process.on('SIGWINCH', onWinch);
    for (const sig of LEAVE_SIGNALS) process.on(sig, onSignal);

    // Tell the pty how big this window is before anything draws into it.
    sendSize();
    process.stdout.write(
      `  attached to ${bold(host)}. ${dim("ctrl-] detaches. the dev server is xerb's, not this shell's, so it keeps running.")}\n`
    );
  });
}

// `xerb logs -f <host>`: the same socket, one direction, escapes stripped.
// Ctrl-C is the way out and reports 130, like every other follow.
function followTerm(ws, host) {
  const strip = makeStripper();
  return new Promise((resolve) => {
    let done = false;
    const onSignal = () => leave(130);
    function leave(code) {
      if (done) return;
      done = true;
      for (const sig of LEAVE_SIGNALS) process.removeListener(sig, onSignal);
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve(code);
    }
    ws.addEventListener('message', (ev) => {
      const text = strip(frameBytes(ev.data));
      if (text) process.stdout.write(text);
    });
    ws.addEventListener('close', () => leave(0));
    ws.addEventListener('error', () => {
      process.stderr.write(`xerb: ${host}: the terminal socket dropped.\n`);
      leave(1);
    });
    for (const sig of LEAVE_SIGNALS) process.on(sig, onSignal);
  });
}

async function cmdTerminal(host, { follow = false } = {}) {
  const what = follow ? 'logs -f' : 'attach';
  if (!host) return needHost(what, follow ? 'xerb logs <host> -f' : 'xerb attach <host>');
  const live = await findDaemon();
  if (!live) return notRunning();
  if (!live.status.projects.some((p) => p.host === host)) {
    process.stderr.write(`xerb: no project named "${host}". \`xerb status\` lists them.\n`);
    return 1;
  }
  let ws;
  try {
    ws = await openTermSocket(live.port, host);
  } catch (err) {
    process.stderr.write(`xerb: ${what} could not open ${host}'s terminal: ${err.message}\n`);
    return 1;
  }
  return follow ? await followTerm(ws, host) : await attachTerm(ws, host);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const { flags, rest } = parseArgv(argv);
  const cmd = rest[0] || '';

  // First, and before the state dir exists: these two answer questions ABOUT
  // xerb rather than doing anything with it, so `npx xerb --help`
  // on a fresh machine leaves that machine exactly as it was.
  if (cmd === 'help' || flags.has('-h') || flags.has('--help')) {
    process.stdout.write(helpText());
    return 0;
  }
  if (flags.has('-v') || flags.has('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // macOS only. The install IS a user LaunchAgent and the front door is :80
  // with a per-connection loopback guard; there is no half of that worth
  // shipping elsewhere, and a foreground fallback taught people a xerb that
  // stops when the terminal closes.
  if (process.platform !== 'darwin') {
    process.stderr.write('xerb runs on macOS. Linux support is not planned.\n');
    return 2;
  }
  const oldNode = nodeTooOld(process.versions.node);
  if (oldNode) {
    process.stderr.write(`${oldNode}\n`);
    return 2;
  }

  const assumeYes = flags.has('--yes') || flags.has('-y');
  const host = rest[1] || '';

  try {
    switch (cmd) {
      case '':
      case 'install':
        break; // the install / rescan path below
      case 'uninstall': return await uninstall({ assumeYes });
      case 'status': return await cmdStatus();
      case 'add': return await cmdAdd({ flags, rest: rest.slice(1) });
      case 'remove': return await cmdRemove(host);
      case 'enable': return await cmdEnable(host, true);
      case 'disable': return await cmdEnable(host, false);
      case 'port': return await cmdPort(host, rest[2]);
      case 'rename': return await cmdRename(host, rest[2]);
      case 'stop':
      case 'restart':
      case 'wake': return await cmdRuntime(cmd, host);
      case 'open': return await cmdOpen(host);
      case 'attach': return await cmdTerminal(host);
      case 'logs':
        // Plain `logs` reads the file off disk and never asks the daemon, so a
        // wedged daemon is exactly when it still works. `-f` is the live
        // stream, which only the daemon has.
        return flags.has('-f') || flags.has('--follow')
          ? await cmdTerminal(host, { follow: true })
          : cmdLogs(argv.slice(argv.indexOf('logs') + 1));
      default:
        process.stderr.write(`xerb: unknown command ${cmd}\n`);
        process.stderr.write(helpText());
        return 1;
    }
  } catch (err) {
    if (err instanceof RegistryError) {
      process.stderr.write(`xerb: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  // ---- the bare run: consent, scan, install (or rescan) --------------------
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  const startedAt = Date.now();
  // Migration counts as prior consent: these users already installed xerb
  // once, so a migrated run skips the first-run prompt like any re-run.
  const migratedFrom = migrateLegacyRegistry();
  if (migratedFrom) {
    process.stdout.write(ui.dim(`  carried your registry over from ${tilde(migratedFrom)}.\n`));
    if (migratedFrom.startsWith(LEGACY_STATE_DIR + path.sep)) {
      process.stdout.write(ui.dim(`  xerb used to be lazydev. ${tilde(LEGACY_STATE_DIR)} is no longer read; delete it when you like.\n`));
    }
  }
  const firstRun = !fs.existsSync(configPath);

  // A first run asks before it installs a LaunchAgent, and a pipe has nobody
  // to ask. `--yes` is that answer given up front, which is how a script
  // installs. With a registry already there, consent is on record and a
  // non-interactive run just rescans, as it always did.
  if (firstRun && !interactive && !assumeYes) {
    process.stderr.write('xerb: first run needs a terminal (it asks before installing)\n');
    return 1;
  }

  const willInstallSkill = fs.existsSync(SKILL_SRC) && fs.existsSync(path.join(os.homedir(), '.claude'));

  if (firstRun && interactive && !assumeYes) {
    const ok = await askConsent({ willInstallSkill });
    if (!ok) {
      process.stdout.write('  ok. nothing was scanned, nothing was installed.\n\n');
      return 0;
    }
    process.stdout.write('\n');
  }

  // Only now: a refused or declined first run leaves nothing on disk, the same
  // promise `--help` makes.
  ensureStateDir();

  const outcome = await scanWithStatus(childEnvFor(FRONT_PORT, { scanAll: assumeYes }), interactive);
  if (outcome === 'declined') return 0; // picker q/Esc, which printed its own line
  if (outcome === 'cancelled') return 130;
  const projects = readProjects();

  // A re-run with a healthy daemon of this same version IS the rescan: the
  // daemon watches projects.json and reloads on its own, so replacing the
  // LaunchAgent here would only kill the dev servers it is holding. The
  // full install runs when nothing answers, the version changed (an npx of
  // a newer release supersedes the installed copy), or the user typed
  // `xerb install` — the explicit form is the sanctioned way to force a
  // plist rewrite, e.g. after the preflight flags a stale service PATH.
  if (cmd !== 'install' && (IS_CHECKOUT ? plistRunsCheckout() : installedVersion() === VERSION)) {
    const live = await findDaemon();
    if (live) {
      printInstalledBanner({ projects, port: live.port, startedAt, skillInstalled: false, verb: 'rescanned' });
      // Preflight against the DEPLOYED plist PATH — what the daemon is
      // actually resolving with right now. A tool that broke or diverged
      // since install surfaces here, on the next casual `xerb`, not at
      // 3am via a start timeout.
      printToolWarnings(await preflightTools(toolsToVerify(projects), deployedPathEnv()));
      return 0;
    }
  }

  let result;
  const spin = makeSpinner({ isTTY: process.stdout.isTTY, styler: ui });
  spin.start('installing the LaunchAgent');
  try {
    result = await installPersistent({ onStep: (t) => spin.update(t) });
  } catch (err) {
    spin.fail();
    process.stderr.write(`xerb: install failed: ${err.message}\n`);
    return 1;
  }
  if (!result.up) {
    spin.fail();
    process.stderr.write(
      `xerb: the service was installed but the daemon did not answer within 10s.\n` +
      `check ${tilde(logsDir)}/daemon.err and daemon.log, then run \`xerb\` again.\n`
    );
    return 1;
  }
  await spin.done(`${ui.green('✓')} ${ui.dim('service running')}`);
  printInstalledBanner({ projects, port: result.port, startedAt, skillInstalled: result.skillInstalled });
  if (IS_CHECKOUT) {
    process.stdout.write(ui.dim('  dev install: the service runs this checkout and restarts itself when the source changes.\n'));
  }
  // The plist was just written, so deployedPathEnv() reads the fresh PATH:
  // this proves what the daemon will resolve, on the install that baked it.
  printToolWarnings(await preflightTools(toolsToVerify(projects), deployedPathEnv()));
  return 0;
}

main().then((code) => {
  if (typeof code === 'number' && code !== 0) process.exitCode = code;
});
