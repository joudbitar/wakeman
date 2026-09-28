#!/usr/bin/env node
// wakeman registry helper for the add-project skill. Zero deps, Node 22+.
//
//   node registry.mjs list
//   node registry.mjs add --host myapp --dir /abs/path --start-cmd "cmd" \
//        [--framework node] [--port 3200] [--parked]
//   node registry.mjs remove --host myapp
//   node registry.mjs verify --host myapp [--timeout-s 120]
//
// The daemon watches the registry file and hot-reloads on write, so `add`
// IS the deployment. `verify` polls the URL through the front door until the
// project answers 200 (503 means the daemon is cold-starting it — keep
// waiting). Exit codes: 0 ok, 1 validation/registry error, 2 verify timeout.
//
// The implementation is lib/registry-cli.mjs, the same module `wakeman add`
// and the dashboard write through, so the skill and the CLI cannot drift.
// This file only has to FIND that module: the install copies the skill to
// ~/.claude/skills/add-project, where the package's lib/ is no longer a
// relative hop away.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// In order: the package or checkout this file ships inside; the app the
// installed `wakeman` command points at (the symlink's target is
// <app>/bin/wakeman.mjs); the npx install's app copy under the state dir.
function findLib() {
  const cands = [path.resolve(HERE, '..', '..', '..', '..', 'lib', 'registry-cli.mjs')];
  try {
    const link = fs.realpathSync(path.join(os.homedir(), '.local', 'bin', 'wakeman'));
    cands.push(path.resolve(path.dirname(link), '..', 'lib', 'registry-cli.mjs'));
  } catch { /* not installed on PATH */ }
  const stateDir = process.env.WAKEMAN_STATE_DIR
    || (process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, 'wakeman') : path.join(os.homedir(), '.local', 'state', 'wakeman'));
  cands.push(path.join(stateDir, 'app', 'lib', 'registry-cli.mjs'));
  for (const p of cands) if (fs.existsSync(p)) return p;
  process.stderr.write(`registry.mjs: could not find wakeman's lib/registry-cli.mjs; looked at:\n  ${cands.join('\n  ')}\ninstall wakeman (npx wakeman) so the skill has a package to talk to.\n`);
  process.exit(1);
}

const { runCli } = await import(pathToFileURL(findLib()).href);
process.exitCode = await runCli(process.argv.slice(2), {
  scriptPath: path.relative(process.cwd(), fileURLToPath(import.meta.url)),
});
