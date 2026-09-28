# ADR 0004: Linux, as a systemd user unit

Status: accepted (2026-09-28). Amends ADR 0003, which said Linux serves in the foreground, and the macOS-only gate that replaced that.

## Context

After ADR 0003 the entrypoint refused every OS but macOS. The reason was in a comment: half a Linux story is worse than none. A foreground daemon that stops when the terminal closes teaches people a wakeman that does not exist.

Most of the code never depended on macOS. The daemon is plain Node. The wildcard bind and both loopback guards from ADR 0002 already expected Linux to get EACCES on :80 and fall back to :4000. `lib/pty.py` uses the POSIX `pty` module. What tied it to the Mac was the service (a LaunchAgent driven by `launchctl`), three `lsof` calls, and copy about macOS privacy prompts and the Xcode tools.

The hard part is :80. macOS lets any process bind the wildcard address on a port under 1024. Linux does not, unless `net.ipv4.ip_unprivileged_port_start` is 80 or lower, or the binary holds `CAP_NET_BIND_SERVICE`. Without one of those every URL carries `:4000`, which was the first complaint from real use (ADR 0002).

## Decision

Linux gets the same one way in, with a systemd user unit where macOS has a LaunchAgent.

1. `npx wakeman` writes `~/.config/systemd/user/wakeman.service` and starts it with `systemctl --user`. Same scan, same state dir, same app copy, same PATH baked in from the install shell. The unit starts with the user's session. Linger is not enabled, so a logged-out machine does not serve.
2. A machine where `systemctl --user` does not work (no systemd, WSL without it, a container) gets one line naming the requirement and exit 2 before anything is read or written.
3. Port 80: when the sysctl already allows it, nothing to do. Otherwise the capability goes on wakeman's own pinned copy of node in `<state>/bin/node`, never on the user's node. An interactive install asks once before running `sudo setcap cap_net_bind_service=+ep` on that file. No, a pipe, `--yes` or a failed sudo leave the daemon on :4000, and the banner prints the command to run later. The pin is only rewritten when its bytes differ from the running node, because a copy drops the capability.
4. The daemon finds a port's listener and its cwd from `/proc` on Linux (`lib/procnet.mjs`), since minimal distros ship no `lsof`. macOS keeps `lsof`.
5. The macOS checks (privacy-guarded folders, the Xcode tool stubs) answer "not applicable" off macOS, and the copy that names System Settings or Xcode only prints on a Mac.

Any other OS still gets one line and exit 2.

## Consequences

- `npx wakeman` on a desktop Linux with systemd serves `http://<name>.localhost`. With the sudo step declined it serves `http://<name>.localhost:4000`, and the banner says why.
- The capability is on a file wakeman owns. `wakeman uninstall` deletes it with the state dir. A dev server the daemon spawns runs the user's own node, which never has it.
- A binary with file capabilities runs in secure-execution mode, so the daemon ignores `NODE_OPTIONS` and `LD_LIBRARY_PATH`. It needs neither.
- Name resolution is the browser's job, as on macOS. Chrome, Firefox and curl resolve `*.localhost` to loopback themselves. Other tools depend on the system resolver: systemd-resolved answers it, a bare glibc setup may not.
- CI runs the suite on Ubuntu, plus a job that installs from the checkout on a real systemd, reaches a project through the front door on :4000 and then on :80, reruns, and uninstalls.
