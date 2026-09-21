// xerb state-directory resolution — the pure half of "where does state live".
//
// The daemon keeps three things on disk: the registry (projects.json), the logs
// dir, and the control-plane token. Historically each defaulted to sitting next
// to the module (CONFIG_DIR), which is what the persistent install still wants.
// The npx path instead wants ONE named state directory under the user's home, so
// an npx run and an install can share a layout without writing into a checkout.
//
// This module is pure: no fs, no import-time side effects. It takes the inputs
// (env, home dir, the next-to-script default) and returns the resolved paths.
// The callers (xerb.mjs, scan.mjs, bin/xerb.mjs) do the fs work.

import path from 'node:path';

// Resolve the base state directory.
//
//   env             a process.env-shaped object (reads XERB_STATE_DIR,
//                   XDG_STATE_HOME)
//   home            the user's home dir (os.homedir()); only used for the XDG
//                   default
//   scriptDir       the next-to-script default (CONFIG_DIR) — where the
//                   persistent install keeps state today
//   preferXdg       when true (the npx entrypoint sets this), an unset
//                   XERB_STATE_DIR resolves to the XDG state home instead of
//                   scriptDir. When false (a plain `import`/daemon boot), an
//                   unset state dir keeps the existing next-to-script layout, so
//                   an installed daemon is unaffected.
//
// Precedence: XERB_STATE_DIR (explicit) > XDG_STATE_HOME/xerb or
// ~/.local/state/xerb (only when preferXdg) > scriptDir.
export function resolveStateDir({ env = {}, home = '', scriptDir, preferXdg = false } = {}) {
  const explicit = typeof env.XERB_STATE_DIR === 'string' ? env.XERB_STATE_DIR.trim() : '';
  if (explicit) return path.resolve(explicit);
  if (preferXdg) {
    const xdg = typeof env.XDG_STATE_HOME === 'string' ? env.XDG_STATE_HOME.trim() : '';
    if (xdg) return path.resolve(xdg, 'xerb');
    return path.resolve(home || '', '.local', 'state', 'xerb');
  }
  return scriptDir;
}

// Derive the three state paths from a base state dir. Each individual path can
// still be overridden by its own env var (XERB_CONFIG / XERB_LOGS_DIR /
// XERB_CONTROL_TOKEN_PATH) so every existing self-test hook keeps working;
// the per-path override always wins over the derived-from-state-dir default.
//
// The control token defaults NEXT TO the registry (its directory), matching the
// pre-state-dir behavior where the token lived beside projects.json. When the
// registry is the state dir's own projects.json that is the state dir itself;
// when XERB_CONFIG points elsewhere the token follows it, keeping a
// test-isolated config and token together.
export function resolveStatePaths({ env = {}, stateDir }) {
  const configPath = (typeof env.XERB_CONFIG === 'string' && env.XERB_CONFIG.trim())
    ? path.resolve(env.XERB_CONFIG.trim())
    : path.join(stateDir, 'projects.json');
  const logsDir = (typeof env.XERB_LOGS_DIR === 'string' && env.XERB_LOGS_DIR.trim())
    ? path.resolve(env.XERB_LOGS_DIR.trim())
    : path.join(stateDir, 'logs');
  const tokenPath = (typeof env.XERB_CONTROL_TOKEN_PATH === 'string' && env.XERB_CONTROL_TOKEN_PATH.trim())
    ? path.resolve(env.XERB_CONTROL_TOKEN_PATH.trim())
    : path.join(path.dirname(configPath), 'control-token');
  return { stateDir, configPath, logsDir, tokenPath };
}
