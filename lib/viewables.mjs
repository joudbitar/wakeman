// Viewables: throwaway static pages registered only so they have a URL.
//
// A report, a mockup, a one-off chart. They are registered the same way a
// project is, but nobody comes back to most of them, so they get their own
// rules: a separate section on the dashboard, and an automatic archive once
// nobody has opened one in `viewableArchiveDays` (default 14). Archiving
// never touches the folder. Deleting the folder is a button, never a timer.
//
// What makes an entry a viewable is its folder: anything under the viewables
// root (~/viewables, or XERB_VIEWABLES_DIR) is tagged `kind: "viewable"` when
// it is added, and entries registered before the tag existed are tagged on
// the daemon's next config load.
//
// An archived entry is `archived: <epoch ms>` plus `enabled: false`. The
// second half is what makes every existing "is it disabled?" guard (the
// switch, the terminal, the WS proxy, the install) refuse it without a new
// check at each site.
//
// Pure except for the small fs helpers at the bottom, which take their paths
// as arguments. Zero npm dependencies.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VIEWABLE = 'viewable';
export const DEFAULT_ARCHIVE_DAYS = 14;
const DAY_MS = 86_400_000;

export function viewablesRoot({ env = process.env, home = os.homedir() } = {}) {
  const override = typeof env.XERB_VIEWABLES_DIR === 'string' ? env.XERB_VIEWABLES_DIR.trim() : '';
  return path.resolve(override || path.join(home, 'viewables'));
}

// Strictly inside root: the root itself is never a viewable, and never a
// thing the delete button may remove.
export function isUnder(dir, root) {
  if (!dir || !root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isViewable(p) {
  return Boolean(p) && p.kind === VIEWABLE;
}

export function isArchived(p) {
  return Boolean(p) && Boolean(p.archived);
}

// Tag every untagged entry whose folder sits under root. Returns how many
// changed, so the caller writes the file back only when something did.
export function tagViewables(parsed, root) {
  if (!Array.isArray(parsed?.projects)) return 0;
  let changed = 0;
  for (const p of parsed.projects) {
    if (p && !p.kind && isUnder(p.dir, root)) {
      p.kind = VIEWABLE;
      changed += 1;
    }
  }
  return changed;
}

export function archiveDays(parsed) {
  const n = Number(parsed?.viewableArchiveDays);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ARCHIVE_DAYS;
}

// The last sign of life a viewable has given: the latest of when it was last
// opened through xerb and when its folder or index.html last changed. The
// file times count because rewriting a viewable in place (same slug, new
// content) is handing it over again, and the clock should restart then.
//   touched   (dir) -> epoch ms of the newest file time, or 0   [injected]
export function lastSeen(p, opened, touched) {
  return Math.max(Number(opened?.[p.host]) || 0, touched(p.dir) || 0);
}

// Hosts to archive now. Only live viewables are candidates; an entry with no
// sign of life at all (folder gone, never opened) is left alone rather than
// archived on a zero, because "gone" is a different problem than "stale".
export function dueForArchive(projects, { opened = {}, now = Date.now(), days = DEFAULT_ARCHIVE_DAYS, touched }) {
  const cutoff = now - days * DAY_MS;
  const due = [];
  for (const p of projects || []) {
    if (!isViewable(p) || isArchived(p)) continue;
    const seen = lastSeen(p, opened, touched);
    if (seen > 0 && seen < cutoff) due.push(p.host);
  }
  return due;
}

// --- fs helpers -------------------------------------------------------------

export function newestFileTime(dir) {
  let t = 0;
  for (const f of [dir, path.join(dir, 'index.html')]) {
    try {
      t = Math.max(t, fs.statSync(f).mtimeMs);
    } catch {
      /* missing: contributes nothing */
    }
  }
  return t;
}

export function readOpened(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

export function writeOpened(file, opened) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(opened, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Move a viewable's folder to the Trash rather than unlinking it, so a wrong
// click is a drag back out of the Trash. Falls back to a real delete only
// where there is no ~/.Trash (Linux). Refuses anything outside root.
export function trashFolder(dir, root, { home = os.homedir(), now = Date.now() } = {}) {
  if (!isUnder(dir, root)) throw new Error(`${dir} is not inside ${root}; refusing to delete it`);
  const real = fs.realpathSync(dir);
  if (!isUnder(real, fs.realpathSync(root))) throw new Error(`${dir} resolves outside ${root}; refusing to delete it`);
  const trash = path.join(home, '.Trash');
  if (fs.existsSync(trash)) {
    let dest = path.join(trash, path.basename(real));
    if (fs.existsSync(dest)) dest = `${dest}-${now}`;
    fs.renameSync(real, dest);
    return { trashed: dest };
  }
  fs.rmSync(real, { recursive: true, force: true });
  return { deleted: real };
}
