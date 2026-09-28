# ADR 0001: the front door, per platform

Status: accepted (2026-07-21). The npx bind decision ("it never binds
`0.0.0.0`") is superseded by ADR 0002, which binds the wildcard address on
macOS with a per-connection loopback guard. The try/install split (npx as a
throwaway foreground run, the persistent daemon as a separate clone +
install.sh path) is superseded by ADR 0003: one command does both.

## Context

Trying wakeman used to cost a git clone, a Caddy install, and a bash script that
edits system files. The goal is `npx wakeman`: one command on a machine with
nothing but Node. The daemon already reverse-proxies HTTP and WebSocket and
routes by Host, so it can serve as its own front door with no second proxy.

The catch is port 80. Pretty URLs (`http://name.localhost`, no port) need a
listener on :80, and binding :80 is not the same everywhere:

- macOS lets a non-root user bind `0.0.0.0:80` but returns `EACCES` for a
  specific loopback address on :80 — both `127.0.0.1:80` and `[::1]:80` fail.
  This was found by installing on a real Mac; the port-0 unit tests never hit it.
- Linux forbids any non-root bind below 1024 unless the process holds
  `CAP_NET_BIND_SERVICE`, which a systemd unit can grant.

So a Node daemon cannot bind a loopback address on :80 as a normal macOS user.
It can only bind `0.0.0.0:80`, which would expose every dev server to the LAN and
defeat the loopback-only model from ADR-less issue #2.

## Decision

The front door depends on the path and the platform.

`npx wakeman` serves directly, in the foreground, from one named state directory
(`$WAKEMAN_STATE_DIR`, else `$XDG_STATE_HOME/wakeman`, else `~/.local/state/wakeman`).
It tries to bind the front-door port on loopback and, when it can't (macOS on
:80, or the port is taken), falls back to a numbered port and prints URLs with
the port: `http://name.localhost:7420`. It never binds `0.0.0.0`, so it stays
loopback-only. Nothing is written into a project directory; deleting the state
directory removes every trace; it installs no service.

The persistent install is separate and platform-specific:

- macOS keeps Caddy on :80 as the privileged front door. Caddy binds
  `0.0.0.0:80` (the one privileged-port bind a non-root user gets on macOS) and
  refuses any client that is not loopback with a `remote_ip` matcher, then
  reverse-proxies to the daemon on `127.0.0.1:4000`. Same loopback-only
  reachability the daemon enforces, and it actually starts without root. This is
  the proven, working macOS setup.
- Linux persistent is a systemd user unit that grants the daemon
  `CAP_NET_BIND_SERVICE` so it binds `127.0.0.1:80` directly, no Caddy. This is
  tracked in issue #10 and not part of this change.

## Consequences

- The npx quick-try works on any machine with Node, with `:port` URLs on macOS
  and port-less URLs anywhere the daemon can bind loopback:80 (Linux with the
  capability). It is a throwaway foreground run, not the persistent daemon, and
  keeps its own state directory.
- The persistent macOS experience keeps port-less pretty URLs by keeping Caddy.
  The earlier plan to drop Caddy everywhere does not hold on macOS, because the
  daemon cannot bind loopback:80 there without root, and running the daemon as
  root would mean spawning every dev server as root.
- Publishing to npm as a real `npx wakeman` is a separate maintainer step. The
  `bin` entry in package.json makes the command exist and run from a local
  checkout (`node bin/wakeman.mjs`) today.
