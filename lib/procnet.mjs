// Who is listening on a TCP port, answered from /proc on Linux. macOS asks
// lsof; minimal Linux installs (Debian, containers, most servers) do not ship
// it, and /proc holds the same answer without a subprocess.
//
// Zero npm dependencies. Every function takes the fs calls it needs as an
// argument, so the tests drive it with fixture text on any OS.

import fs from 'node:fs';
import path from 'node:path';

// TCP_LISTEN in the kernel's state numbering (include/net/tcp_states.h).
const LISTEN = '0A';

// The socket inodes LISTENing on `port` in the text of /proc/net/tcp or
// /proc/net/tcp6. Rows look like
//   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 41234 ...
// where the port is the hex after the colon of the local address and the
// inode is the tenth column. The address itself does not matter: loopback,
// wildcard and v4-mapped binds all hold the port.
export function parseListenInodes(text, port) {
  const inodes = new Set();
  for (const line of String(text).split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== LISTEN) continue;
    const hexPort = cols[1].split(':')[1];
    if (parseInt(hexPort, 16) !== port) continue;
    if (cols[9] !== '0') inodes.add(cols[9]);
  }
  return inodes;
}

const realFs = {
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  readdir: (p) => fs.readdirSync(p),
  readlink: (p) => fs.readlinkSync(p),
};

// The pid of a process holding a LISTEN socket on `port`, or null. Walks
// /proc/<pid>/fd for a link to one of the port's socket inodes. Another
// user's fd directory is unreadable, so like lsof without sudo this only
// finds this user's processes. NEVER throws.
export function listenerPid(port, { procRoot = '/proc', io = realFs } = {}) {
  const inodes = new Set();
  for (const table of ['tcp', 'tcp6']) {
    try {
      for (const i of parseListenInodes(io.readFile(path.join(procRoot, 'net', table)), port)) inodes.add(i);
    } catch { /* no v6, or no /proc */ }
  }
  if (!inodes.size) return null;
  let pids;
  try {
    pids = io.readdir(procRoot).filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  for (const pid of pids) {
    let fds;
    try {
      fds = io.readdir(path.join(procRoot, pid, 'fd'));
    } catch {
      continue; // not ours, or exited between the two reads
    }
    for (const fd of fds) {
      let target;
      try {
        target = io.readlink(path.join(procRoot, pid, 'fd', fd));
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && inodes.has(m[1])) return Number(pid);
    }
  }
  return null;
}

// A process's working directory, or null when it is gone or not ours.
export function processCwd(pid, { procRoot = '/proc', io = realFs } = {}) {
  try {
    return io.readlink(path.join(procRoot, String(pid), 'cwd')) || null;
  } catch {
    return null;
  }
}

// A process's command name (what lsof prints as the c field), or null.
export function processName(pid, { procRoot = '/proc', io = realFs } = {}) {
  try {
    return io.readFile(path.join(procRoot, String(pid), 'comm')).trim() || null;
  } catch {
    return null;
  }
}
