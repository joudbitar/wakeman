// The macOS facts a fresh machine trips over, in one place: which folders the
// privacy system (TCC) guards, whether python3 is real or the stub that pops
// an "install developer tools" dialog, and a node binary the LaunchAgent can
// keep running after a version manager or `brew upgrade` deletes the one the
// install ran under.
//
// Zero npm dependencies. Every function takes what it needs as arguments so
// the tests can drive it without touching the real machine.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The oldest node the CLI runs on: `wakeman attach` uses the global WebSocket
// client, which is stable from 22.
export const MIN_NODE_MAJOR = 22;

// null when `version` (process.versions.node) is new enough, else the line to
// print before exiting. npx does not enforce package.json "engines", so this
// is the only thing that stops an old node from failing somewhere confusing.
export function nodeTooOld(version, min = MIN_NODE_MAJOR, platform = process.platform) {
  const major = Number(String(version).split('.')[0]);
  if (Number.isFinite(major) && major >= min) return null;
  const where = platform === 'darwin' ? 'brew install node, or nodejs.org' : 'nodejs.org, or your package manager';
  return `wakeman needs node ${min} or newer, and this is node ${version}. ` +
    `install a current node (${where}) and run it again.`;
}

// Folders macOS will not let a process read until the person allows it, once
// per app: the first readdir blocks on a dialog, and a "no" (or a background
// process nobody answered for) turns into EPERM. Returns the guarded folder
// in ~ form for the copy, or null. Always null off macOS: Linux has no such
// system, and ~/Documents there is an ordinary folder.
export function protectedRoot(dir, home, platform = process.platform) {
  if (platform !== 'darwin') return null;
  const d = path.resolve(dir);
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const root = path.join(home, name);
    if (d === root || d.startsWith(root + path.sep)) return `~/${name}`;
  }
  const icloud = path.join(home, 'Library', 'Mobile Documents');
  if (d === icloud || d.startsWith(icloud + path.sep)) return 'iCloud Drive';
  if (d.startsWith('/Volumes/')) return d.split(path.sep).slice(0, 3).join(path.sep);
  return null;
}

// Is this error the privacy system saying no? readdir on a guarded folder
// fails with EPERM ("Operation not permitted"), which a plain permission bit
// problem reports as EACCES. Both mean "exists, not yours to read".
export function isAccessDenied(err) {
  return Boolean(err) && (err.code === 'EPERM' || err.code === 'EACCES');
}

// Whether the Xcode command line tools (or Xcode) are installed. Without them
// /usr/bin/python3, /usr/bin/git and friends are stubs that open an install
// dialog instead of running. `xcode-select -p` only reads a setting, so it is
// safe to call on a machine that has neither. Off macOS there are no stubs,
// so the answer is always yes.
export function hasDeveloperTools({ run = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') return true;
  try {
    const r = run('xcode-select', ['-p'], { encoding: 'utf8', timeout: 5000 });
    const dir = r && r.status === 0 ? String(r.stdout || '').trim() : '';
    return Boolean(dir) && fs.existsSync(dir);
  } catch {
    return false;
  }
}

// Resolve `cmd` on `pathEnv` the way a shell would, or null.
export function whichOn(cmd, pathEnv) {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null;
  for (const d of String(pathEnv || '').split(':')) {
    if (!d) continue;
    const p = path.join(d, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* next */ }
  }
  return null;
}

// The /usr/bin commands that are stubs until the developer tools are
// installed. /usr/bin/ruby and friends are real binaries, so the list is
// explicit rather than "anything in /usr/bin".
const TOOL_STUBS = new Set(['python3', 'pip3', 'git', 'make', 'clang', 'gcc', 'cc', 'swift']);

// Would running this binary pop the developer-tools dialog? True only for
// the /usr/bin stubs on a machine without the tools.
export function isToolStub(bin, { devTools, platform = process.platform } = {}) {
  if (platform !== 'darwin') return false;
  if (!bin || path.dirname(bin) !== '/usr/bin' || !TOOL_STUBS.has(path.basename(bin))) return false;
  return !(devTools ?? hasDeveloperTools());
}

// The node binary the LaunchAgent should run, given the one the install is
// running under. process.execPath is the resolved binary, so under Homebrew
// it is .../Cellar/node/<version>/bin/node and under nvm or fnm
// ~/.nvm/versions/node/<version>/bin/node: both vanish on the next upgrade or
// uninstall, and launchd would then respawn a daemon that cannot start, once
// a second, with every URL dead.
//
// Homebrew: the formula's opt/ link, which brew repoints on every upgrade.
// The binary cannot be copied there, because it loads libnode.dylib from
// beside itself. Everything else (nodejs.org, nvm, fnm, volta and asdf
// downloads) is one self-contained file, so it is copied to `dest`, a path
// wakeman owns; on APFS that is a clone and costs no disk. The copy is run once
// before it is trusted, and if it does not start, the original path is used
// as before.
export function stableNode(execPath, dest, { run = spawnSync } = {}) {
  const brew = execPath.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/);
  if (brew) {
    const opt = path.join(brew[1], 'opt', brew[2], 'bin', 'node');
    if (fs.existsSync(opt)) return opt;
  }
  try {
    pinNode(execPath, dest);
    const r = run(dest, ['-e', ''], { stdio: 'ignore', timeout: 15_000 });
    if (r && r.status === 0) return dest;
  } catch { /* fall through */ }
  fs.rmSync(dest, { force: true });
  return execPath;
}

// Copy `execPath` to `dest`. Written beside the target and renamed over it,
// so a binary that is running keeps its old inode.
export function pinNode(execPath, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(execPath, tmp, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return dest;
}
