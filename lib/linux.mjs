// The Linux facts the install trips over, in one place: where the systemd
// user unit goes, whether `systemctl --user` works at all, whether :80 is open
// to a plain user, and a node copy that can carry CAP_NET_BIND_SERVICE
// without touching the node the user installed.
//
// Zero npm dependencies. Every function takes what it needs as arguments so
// the tests can drive it from a Mac.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pinNode } from './macos.mjs';

// Where systemd looks for a user's own units: $XDG_CONFIG_HOME/systemd/user,
// ~/.config/systemd/user by default.
export function unitPathFor({ env = {}, home, unit = 'wakeman.service' }) {
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
  return path.join(xdg || path.join(home, '.config'), 'systemd', 'user', unit);
}

// Can this session talk to a systemd user manager? `show-environment` is the
// cheapest call that has to reach the manager over the bus, and it exits 0
// whenever that works, unlike `is-system-running`, which also fails for a
// manager that is up but degraded. Failure modes worth naming: no systemctl
// at all (Alpine, most containers), and a systemctl that cannot connect (WSL
// with systemd off, an ssh session without a user session, a chroot). Returns
// { ok, detail }, detail being the first line systemctl said.
export function systemdUsable({ run = spawnSync } = {}) {
  let r;
  try {
    r = run('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    return { ok: false, detail: err && err.message ? err.message : 'systemctl failed' };
  }
  if (!r || r.error) {
    const code = r && r.error && r.error.code;
    return { ok: false, detail: code === 'ENOENT' ? 'systemctl is not installed' : (r && r.error && r.error.message) || 'systemctl failed' };
  }
  if (r.status === 0) return { ok: true, detail: '' };
  const first = String(r.stderr || r.stdout || '').split('\n').find((l) => l.trim()) || `systemctl exited ${r.status}`;
  return { ok: false, detail: first.trim() };
}

// The one line printed before exit 2 when systemd is not there for us.
export function systemdRequirementLine(detail) {
  const why = detail ? ` (${detail})` : '';
  return `wakeman needs a systemd user session to install its background service, and \`systemctl --user\` does not work here${why}. on WSL, turn systemd on in /etc/wsl.conf and restart the distro.`;
}

// /proc/sys/net/ipv4/ip_unprivileged_port_start: the first port a plain user
// may bind. 1024 on stock kernels, 0 on some containers and hardened distros
// that open everything. Null when unreadable.
export function parsePortStart(text) {
  const t = String(text ?? '').trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

// Does this getcap output grant cap_net_bind_service? libcap prints either
// `/path = cap_net_bind_service+ep` (2.2x) or `/path cap_net_bind_service=ep`
// (2.4x); both name the capability and end with an `e` in the flag set,
// which is what makes it apply when the file runs.
export function hasBindCapability(getcapOutput) {
  return /cap_net_bind_service[^\n]*[=+][a-z]*e/i.test(String(getcapOutput ?? ''));
}

// Whether :frontPort needs the capability, and whether the pin has it.
//   'unneeded'  the kernel lets any user bind it
//   'granted'   getcap shows the capability on the pin
//   'missing'   nobody granted it yet (or getcap is not installed, and then
//               the daemon's own port tells the truth)
//   'unsupported' the pin's filesystem cannot store file capabilities (an
//               NFS home), so setcap would fail even after the sudo prompt
export function bindCapState({ portStartText, frontPort = 80, getcapOutput = '', getcapError = '' }) {
  const start = parsePortStart(portStartText);
  if (start !== null && start <= frontPort) return 'unneeded';
  if (hasBindCapability(getcapOutput)) return 'granted';
  return /operation not supported/i.test(String(getcapError ?? '')) ? 'unsupported' : 'missing';
}

// What an admin can run instead when the pin cannot hold the capability: let
// every user bind from :80 up. Machine-wide, which is why wakeman never offers
// to run it.
export const PORT_START_COMMAND = 'sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80';

// setcap's argument list, and the same as one line a person can paste. The
// capability goes on wakeman's own node copy, never the user's node: a file
// capability is a permission, and the copy is the only binary wakeman owns.
export function setcapArgs(pin) {
  return ['setcap', 'cap_net_bind_service=+ep', pin];
}

export function setcapCommand(pin) {
  return `sudo ${setcapArgs(pin).map(shellQuote).join(' ')}`;
}

// A word a shell reads back as itself. Plain paths stay plain so the printed
// command reads like the one in every tutorial.
export function shellQuote(s) {
  const w = String(s);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`;
}

// Are these two files the same bytes? Size first, then a streamed sha256, so
// two 100 MB node binaries cost one read each and no memory.
export function sameBytes(a, b) {
  let sa;
  let sb;
  try {
    sa = fs.statSync(a);
    sb = fs.statSync(b);
  } catch {
    return false;
  }
  if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
  return sha256File(a) === sha256File(b);
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// The node the unit should run: always wakeman's own copy at `dest`. Two
// reasons, where stableNode on macOS has one. The copy outlives a version
// manager or a distro upgrade removing the original, and it is the file that
// carries CAP_NET_BIND_SERVICE for :80. A copy drops file capabilities, so
// when the pin already holds the same bytes as the running node it is kept as
// is, capability and all, and a rerun does not ask for sudo again. Falls back
// to `execPath` when the copy will not run (a node that is not one
// self-contained file), in which case the capability offer is off the table.
export function linuxNode(execPath, dest, { run = spawnSync } = {}) {
  const runs = () => {
    const r = run(dest, ['-e', ''], { stdio: 'ignore', timeout: 15_000 });
    return Boolean(r && r.status === 0);
  };
  try {
    if (sameBytes(execPath, dest) && runs()) return dest;
    pinNode(execPath, dest);
    if (runs()) return dest;
  } catch { /* fall through */ }
  fs.rmSync(dest, { force: true });
  return execPath;
}
