#!/usr/bin/env node
// lazydev REGISTRY scanner.
// Scans scanRoots (default ~) for projects whose start command is provable
// from marker files alone — Node with a `dev` script, Rails apps, Django with
// a visible interpreter, static folders that are their own repo — and
// writes/merges projects.json per the lazydev BUILD CONTRACT (SPEC.md).
// On an interactive run, newly found projects go through a picker first:
// registering is a choice, and a "no" is remembered in scanDeclined so a
// rescan never nags about the same directory twice.
// Everything unprovable is the add-project skill's job, on purpose.
// Zero npm deps — Node built-ins only.

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import os from 'node:os';
import { mergeRegistry } from './lib/registry.mjs';
import { detectRails, detectDjango, detectStatic, detectNode, normalizeScanRoots, VITE_BASED } from './lib/detect.mjs';
import { resolveStateDir, resolveStatePaths } from './lib/state.mjs';
import { makeStyler } from './lib/ui.mjs';
import { runPicker } from './lib/picker.mjs';
import { STATIC_PLACEHOLDER } from './lib/registry-cli.mjs';

const HOME = os.homedir();
// Self-locate: the registry lives next to this script (project root) by default,
// not a hardcoded ~/.config path, so the project is relocatable. HOME below is
// still the directory tree we SCAN for projects.
//
// When LAZYDEV_STATE_DIR is set (the npx entrypoint sets it), the registry is
// written into that state dir instead, so scan and the daemon agree on ONE
// location. preferXdg stays false: a bare `node scan.mjs` with no state dir
// keeps the existing next-to-script layout. The per-path LAZYDEV_CONFIG override
// still wins, matching the daemon's own resolution.
const CONFIG_DIR = import.meta.dirname;
const STATE_DIR = resolveStateDir({ env: process.env, home: HOME, scriptDir: CONFIG_DIR, preferXdg: false });
const { configPath: OUT } = resolveStatePaths({ env: process.env, stateDir: STATE_DIR });
const OUT_DIR = dirname(OUT);
const MAXDEPTH = 4;

const tilde = (p) => p.replace(HOME, '~');
const ui = makeStyler({ isTTY: process.stdout.isTTY, env: process.env });

// The picker runs when a human is at both ends of the terminal. Pipes, CI,
// and callers who asked for everything (`--all`, or LAZYDEV_SCAN_ALL=1 — the
// entrypoint sets it for `lazydev --yes`, which promised no prompts) keep the
// old register-everything behavior.
const PICK =
  process.stdin.isTTY === true &&
  process.stdout.isTTY === true &&
  !process.argv.includes('--all') &&
  process.env.LAZYDEV_SCAN_ALL !== '1';

// Heavy / irrelevant dirs we never descend into.
const SKIP = new Set([
  'node_modules', '.git', 'Library', '.Trash', '.cache', '.npm', '.pnpm-store',
  '.vscode', '.next', 'dist', 'build', '.turbo', 'vendor', '.venv', 'venv',
  '__pycache__', 'Applications', '.local', '.config', '.rustup', '.cargo',
  'go', '.docker', '.ollama', '.android', '.gradle', '.m2', 'Music', 'Movies',
  'Pictures', 'Photos Library.photoslibrary',
]);

// Host name we must never emit (the daemon owns it).
const RESERVED_HOST = 'lazydev';

const POOL_START = 3010;
const POOL_STEP = 10;

// ---------------------------------------------------------------------------
// 0. Load the existing registry up front: scan config lives there, and the
//    merge in step 6 preserves everything it already knows.
// ---------------------------------------------------------------------------
let existing = null;
if (existsSync(OUT)) {
  try { existing = JSON.parse(readFileSync(OUT, 'utf8')); } catch { existing = null; }
}
// Optional registry config: path substrings the scanner must skip.
const scanExclude = existing && Array.isArray(existing.scanExclude) ? existing.scanExclude : [];
// Directories the user said no to in the picker. Exact matches, never asked
// about again; deleting an entry from the registry re-asks on the next scan.
const scanDeclined = existing && Array.isArray(existing.scanDeclined)
  ? existing.scanDeclined.filter((s) => typeof s === 'string' && s)
  : [];

// ---------------------------------------------------------------------------
// 1. Walk each scan root, collecting project roots with their detector result.
// ---------------------------------------------------------------------------
const found = [];
const seenDirs = new Set(); // scanRoots may overlap; never register a dir twice
function walk(dir, depth) {
  if (depth > MAXDEPTH) return;
  // scanExclude prunes the walk itself, so it holds for every ecosystem and
  // for everything underneath the excluded path.
  if (scanExclude.some((s) => typeof s === 'string' && s && dir.includes(s))) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const names = new Set(entries.map((e) => e.name));

  // Detection order: rails and django before node, because manage.py and
  // bin/rails name the app itself while a package.json next to them is asset
  // tooling (jsbundling, vite_rails) — registering the bundler would serve
  // the wrong process. Static runs last and never beside a package.json.
  // Any PROVEN root stops the walk down that path (workspaces and embedded
  // frontends are the add-project skill's job). An unprovable package.json —
  // a dependency stub, tooling config — does not: it used to, and a stub at
  // ~/x silently hid every real project under ~/x/.
  const det = detectRails(dir, names) || detectDjango(dir, names);
  if (det) { addFound(dir, det); return; }
  if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
    const node = detectNode(dir, names);
    if (node) { addFound(dir, node); return; }
  } else {
    const staticDet = detectStatic(dir, names);
    if (staticDet) { addFound(dir, staticDet); return; }
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    if (SKIP.has(e.name)) continue;
    walk(join(dir, e.name), depth + 1);
  }
}
function addFound(dir, det) {
  if (seenDirs.has(dir)) return;
  seenDirs.add(dir);
  found.push({ dir, det });
}
// scanRoots: optional registry list of extra (or replacement) scan roots,
// default just ~. Normalization drops relative paths and nested duplicates;
// a root that doesn't exist is skipped, not an error, so a registry shared
// across machines still scans.
const scanRoots = existing && Array.isArray(existing.scanRoots) ? existing.scanRoots : undefined;
const roots = normalizeScanRoots(scanRoots, HOME).filter((r) => existsSync(r));
// The walk is synchronous, so no spinner can animate over it; a static line
// that is wiped afterwards is the honest version.
if (PICK) process.stdout.write(ui.dim(`  scanning ${roots.map(tilde).join(', ')} for projects`));
for (const root of roots) walk(root, 0);
if (PICK) process.stdout.write('\r\x1b[2K');

// ---------------------------------------------------------------------------
// 2. Helpers for hosts and start commands (detection lives in lib/detect.mjs).
// ---------------------------------------------------------------------------
function pmRun(pm) {
  switch (pm) {
    case 'pnpm': return 'pnpm dev';
    case 'yarn': return 'yarn dev';
    case 'bun': return 'bun run dev';
    default: return 'npm run dev';
  }
}

function sanitizeHost(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// 3. Candidate rows: every found root carries its detector result already.
// ---------------------------------------------------------------------------
const candidates = found.map(({ dir, det }) => ({ dir, name: basename(dir), ...det }));

// ---------------------------------------------------------------------------
// 4. The pick. Candidates the registry already knows (by dir) pass straight
//    through — the registry stays their source of truth. New ones are the
//    user's call on an interactive run: deselecting records the dir in
//    scanDeclined, q backs out without recording anything (asked again next
//    time). A static folder confirmed here registers enabled, not parked —
//    the parked default exists because a blind scan cannot tell a real site
//    from a look-alike, and a confirmed pick is not blind.
// ---------------------------------------------------------------------------
const declined = new Set(scanDeclined);
const knownDirs = new Set(
  existing && Array.isArray(existing.projects)
    ? existing.projects.filter((p) => p && typeof p.dir === 'string').map((p) => p.dir)
    : []
);
let rows = candidates.filter((c) => !declined.has(c.dir));
const fresh = rows.filter((c) => !knownDirs.has(c.dir)).sort((a, b) => a.dir.localeCompare(b.dir));
if (PICK && fresh.length) {
  const res = await runPicker({
    styler: ui,
    heading: `  ${fresh.length} new project${fresh.length === 1 ? '' : 's'} found — pick which get a URL`,
    notes: [
      ui.dim('  ↑↓ move · space toggle · a all · enter confirm · q not now'),
      ui.dim(`  unchecked ones are not asked about again · undo: "scanDeclined" in ${tilde(OUT)}`),
    ],
    items: fresh.map((c) => ({
      label: sanitizeHost(c.name) || 'project',
      hint: `${c.framework} · ${tilde(c.dir)}`,
    })),
  });
  if (res.cancelled) {
    rows = rows.filter((c) => knownDirs.has(c.dir));
  } else {
    for (let i = 0; i < fresh.length; i += 1) {
      if (res.selected[i]) {
        if (fresh[i].framework === 'static') fresh[i].enabled = true;
      } else {
        declined.add(fresh[i].dir);
        scanDeclined.push(fresh[i].dir);
      }
    }
    rows = rows.filter((c) => !declined.has(c.dir));
  }
}

// ---------------------------------------------------------------------------
// 5. Generate startCmd from a candidate row.
//    Vite-based: "<pmrun> -- --port <port> --strictPort".
//    PORT-env (next/cra/node/static): daemon injects PORT, no port in the cmd.
//    django/rails ignore PORT, so the port is written into the command.
// ---------------------------------------------------------------------------
function startCmdFor(c, port) {
  switch (c.framework) {
    case 'django':
      // Interpreter is evidence-derived (lib/detect.mjs), relative to the
      // project dir the daemon uses as cwd.
      return `${c.interpreter} manage.py runserver 127.0.0.1:${port}`;
    case 'rails':
      return `bin/rails server -p ${port}`;
    case 'static':
      // A placeholder, not a path: the daemon expands it to
      // `python3 <its own dir>/serve_static.py` at spawn time. Writing the
      // absolute path here used to pin the entry to wherever the scanner ran
      // from, and under npx that is ~/.npm/_npx/<hash>/, which npm prunes.
      return STATIC_PLACEHOLDER;
  }
  const run = pmRun(c.pm);
  if (VITE_BASED.has(c.framework)) {
    return `${run} -- --port ${port} --strictPort`;
  }
  return run;
}

// ---------------------------------------------------------------------------
// 6. Merge with the existing registry (loaded in step 0): assign unique hosts
//    (never RESERVED_HOST), preserve port/enabled/startCmd for known hosts,
//    fresh ports only for new hosts, and carry over hand-added entries whose
//    directory still exists. The merge itself is pure (lib/registry.mjs); we
//    inject the framework-aware helpers and the fs existence check.
// ---------------------------------------------------------------------------
const projects = mergeRegistry({
  existing,
  candidates: rows,
  reservedHost: RESERVED_HOST,
  poolStart: POOL_START,
  poolStep: POOL_STEP,
  startCmdFor,
  sanitizeHost,
  dirExists: existsSync,
});

const out = {
  port: existing && Number.isFinite(existing.port) ? existing.port : 4000,
  idleTimeoutMs: existing && Number.isFinite(existing.idleTimeoutMs) ? existing.idleTimeoutMs : 1800000,
  startTimeoutMs: existing && Number.isFinite(existing.startTimeoutMs) ? existing.startTimeoutMs : 120000,
  ...(scanExclude.length ? { scanExclude } : {}),
  // scanRoots is preserved exactly as the user wrote it (unnormalized), so a
  // rescan never rewrites hand-edited config.
  ...(scanRoots ? { scanRoots } : {}),
  // The remembered "no"s, old and new.
  ...(scanDeclined.length ? { scanDeclined } : {}),
  projects,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

// ---------------------------------------------------------------------------
// 7. Report. LAZYDEV_SCAN_QUIET=1 (set by the npx entrypoint, which prints its
//    own banner from the registry) skips the table; a direct `node scan.mjs`
//    or `lazydev scan` keeps it.
// ---------------------------------------------------------------------------
if (process.env.LAZYDEV_SCAN_QUIET === '1') process.exit(0);

const rowsOut = [...projects].sort((a, b) => a.port - b.port);
const w = {
  host: Math.max('HOST'.length, ...rowsOut.map((r) => r.host.length)),
  port: Math.max('PORT'.length, ...rowsOut.map((r) => String(r.port).length)),
  fw: Math.max('FRAMEWORK'.length, ...rowsOut.map((r) => r.framework.length)),
  cmd: Math.max('STARTCMD'.length, ...rowsOut.map((r) => r.startCmd.length)),
};
console.log(`\nWrote ${rowsOut.length} projects to ${tilde(OUT)}\n`);
console.log(
  '  ' + 'HOST'.padEnd(w.host) + '  ' + 'PORT'.padEnd(w.port) + '  ' +
  'FRAMEWORK'.padEnd(w.fw) + '  ' + 'STARTCMD'.padEnd(w.cmd) + '  ' + 'DIR'
);
for (const r of rowsOut) {
  console.log(
    '  ' + r.host.padEnd(w.host) + '  ' + String(r.port).padEnd(w.port) + '  ' +
    r.framework.padEnd(w.fw) + '  ' + r.startCmd.padEnd(w.cmd) + '  ' + tilde(r.dir)
  );
}
const parked = rowsOut.filter((r) => r.enabled === false).length;
console.log(`\nTotal: ${rowsOut.length} projects.`);
if (parked) {
  console.log(`${parked} parked with "enabled": false (static folders start parked). Flip the flag in ${tilde(OUT)} to serve them.`);
}
if (scanDeclined.length) {
  console.log(`${scanDeclined.length} skipped by choice ("scanDeclined" in ${tilde(OUT)}; remove an entry to be asked again).`);
}
console.log('');
