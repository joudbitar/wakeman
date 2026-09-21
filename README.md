# lazydev

A local proxy that starts dev servers on demand behind permanent URLs.

You have ten projects. Each has a dev server that grabs a port and eats RAM whether or not you're using it, so you either keep fifteen terminal tabs alive or keep restarting things and guessing which port is which. lazydev's deal: every project gets a permanent URL, `http://portfolio.localhost`, and the server behind it runs only while you're actually using it.

There is one way to get it, and it asks before it does anything:

```
$ npx @jbitar/lazydev

   _                         _                      Z
  | |  __ _  ____ _   _   __| |  ___ __   __      z
  | | / _` ||_  /| | | | / _` | / _ \\ \ / /    z
  | || (_| | / / | |_| || (_| ||  __/ \ V /
  |_| \__,_|/___| \__, | \__,_| \___|  \_/
                  |___/

  v0.3.0 · starts dev servers when you open their URL, stops them when idle

  this will:
  scan your home folder for dev projects · reads config files, writes nothing
  let you pick which get a URL: http://<name>.localhost · works only on this machine
  install a background service · no sudo, keeps the URLs working after reboot
  add the add-project skill to ~/.claude/skills · for projects the scan misses

  everything is stored in ~/.local/state/lazydev · `lazydev uninstall` deletes all of it

  proceed? [Y/n] y

  3 new projects found — pick which get a URL
  ❯ ◉ portfolio  node · ~/code/portfolio
    ◉ shop  next · ~/code/shop
    ◉ notes  static · ~/code/notes
  ↑↓ move · space toggle · a all · enter confirm · q not now
  unchecked ones are not asked about again · undo: "scanDeclined" in ~/.local/state/lazydev/projects.json

  ✓ found 3 projects
  ✓ service running

  lazydev v0.3.0  installed in 1214 ms

  dashboard  http://lazydev.localhost
  projects   http://<name>.localhost for each of 3 projects, e.g. http://portfolio.localhost

  runs in the background and survives reboots · registry: ~/.local/state/lazydev/projects.json · logs: ~/.local/state/lazydev/logs
  `lazydev` rescans for new projects · `lazydev uninstall` removes everything
  agent skill: add-project installed to ~/.claude/skills · other agents: npx skills add joudbitar/lazydev
```

That's the whole install. Answering `n` exits with nothing read and nothing written.

<!-- gif: record `npx @jbitar/lazydev` in a terminal (consent prompt, y, installed banner), then visit a sleeping project in the browser. the tab spins a few seconds while the server boots, then the app appears. ~12s with QuickTime or Kap, crop to terminal + browser. -->

The dashboard at `http://lazydev.localhost`:

![the lazydev dashboard: five projects, two awake, sleep buttons for the running ones](docs/dashboard.png)

## How it works

You open `http://portfolio.localhost`. Addresses ending in `.localhost` reach your own machine by web standard, no /etc/hosts edits, no DNS tools, so the request lands on lazydev, which reads the host name and looks `portfolio` up in its registry: one JSON file of name, folder, port, start command.

If portfolio's server is running, the request is piped straight through and you never notice lazydev was there. If it's asleep, you get an instant page with a spinner while lazydev runs the project's start command; the moment the port answers you're handed to the real app, no manual reload. A Next app cold-starts in about 8 seconds on my machine, timed with curl. Thirty minutes after the last request, the server is killed and its RAM freed. The URL keeps working; the next visit wakes it again.

Sleeping a project kills the whole process tree (pnpm, the framework under it, its workers), not just the top pid. WebSockets are piped raw, so hot-module reload works through the proxy. `tenant.myapp.localhost` routes to `myapp` with the Host header intact, so multi-tenant apps still see their subdomain. And a dev server you started yourself in a terminal gets adopted, not fought.

`npx @jbitar/lazydev` scans your home directory (or the `scanRoots` you set in the registry) for projects it can prove how to run: Node projects with a `dev` script, Rails apps, Django projects with a visible venv or lockfile, and static folders that are their own git repo. In a terminal, new finds go through a picker before anything registers: space skips one, `a` toggles all, enter confirms. A project you uncheck is remembered in `scanDeclined` and never asked about again; delete its line from the registry to undo. Static folders you confirm register on. Without a picker (pipes, CI, `--yes`) everything registers, static finds parked until you switch them on, since build output and docs folders look the same on disk. Each project gets a free port, and a user LaunchAgent keeps the daemon alive through reboots; the daemon itself owns :80, loopback-only, so there is no Caddy and no sudo anywhere. All state lives in `~/.local/state/lazydev`; nothing touches your project folders. Anything the scan can't prove (a Flask app, a Go server, docker-compose) is one JSON entry in the registry, and the install puts an agent skill ([add-project](.claude/skills/add-project/SKILL.md)) into `~/.claude/skills` that teaches a coding agent to write that entry end to end: read the project, pick the start command and port, register it, and poll the URL until it wakes. Tell your agent "add my flask app to lazydev" and it does the rest. On Cursor, Codex, or another agent, `npx skills add joudbitar/lazydev` installs the same skill where your agent looks for it. The scanner covers the provable case; your agent covers yours.

## Day to day

The dashboard at `http://lazydev.localhost` lists every project with its state, a switch that puts a running one to sleep, and a terminal button per row. Names, ports and start commands are edited in place; you can add a project by path there, or drop one, which removes the registry entry and never the folder.

Every one of those edits is a subcommand too, and so is everything about a running server:

```
lazydev                     first run: consent, scan, install. later: rescan
lazydev status              every project, state, port, idle, one line each
lazydev add [dir] [--cmd "..."] [--port N] [--name host] [--parked]
lazydev remove <host>
lazydev enable <host> | disable <host>
lazydev port <host> <N>
lazydev rename <host> <new>
lazydev stop <host> | restart <host> | wake <host>
lazydev open <host>         open http://<host>.localhost in the default browser
lazydev logs <host> [-n N] [-f]
lazydev attach <host>       your terminal becomes the dev server's terminal
lazydev install             force a reinstall (rebake the service PATH)
lazydev uninstall
```

Each project runs under a real pty, so its dev server has a tty: colors survive and you can type back at it. `lazydev attach portfolio` hands your terminal to that dev server, which is how you answer Next's "port in use, use 3001 instead?" or press `r` at Vite. Ctrl-] detaches and the server keeps running, because it is lazydev's process and not your shell's. The `terminal` button on a dashboard row is the same session in the page, with a pop-out into its own tab, and `lazydev logs <host> -f` is the same stream with the escapes stripped and nothing going back. Without `python3` on PATH there is no pty: the output still shows, what you type goes nowhere, and the panel says so on its first line.

Logs are plain files: `~/.local/state/lazydev/logs/daemon.log` for the proxy, `<host>.log` per project. The registry at `~/.local/state/lazydev/projects.json` is yours to edit: rename a project, change its port, park it, or add `scanRoots` and `scanExclude` to steer the scanner. A rescan merges; it never clobbers what you fixed by hand.

## How it's built

The daemon is one Node file with no npm dependencies: router, reverse proxy, process supervisor, terminal sockets and idle reaper in about 4,500 lines of built-ins. The one piece of vendored code is xterm.js, checked into `lib/vendor/` so the dashboard works offline.

- Everything is loopback-only and fails closed: a connection from off the machine is dropped at accept, and a request that somehow gets further is refused with a 403. The control plane requires a token the daemon mints at boot. How :80 gets bound is in [docs/adr/0002-wildcard-bind-loopback-guard.md](docs/adr/0002-wildcard-bind-loopback-guard.md).
- Health probes try `127.0.0.1` and `::1` separately, because plenty of dev servers listen on one family only.
- `scan` merges instead of overwriting, so a rescan never clobbers the port or start command you fixed by hand.
- The pty is `lib/pty.py`, run by the `python3` that comes with the Xcode command line tools, because macOS `script(1)` refuses a stdin that is not a tty. No python3 on PATH and the terminal falls back to pipes, read-only.

## What it doesn't do

- Any OS but macOS. The install is a user LaunchAgent holding :80; on anything else lazydev prints one line and exits.
- https, yet.
- Anything except dev servers. Databases, Docker, queues, and tunnels are out of scope, and stopping idle servers is the opposite of what a production process manager wants.

## Alternatives

[hotel](https://github.com/typicode/hotel) proved people want this (10k stars) and then went quiet; it starts servers on access but never stops them. [chalet](https://github.com/jeansaad/chalet) is its maintained fork, same model. [puma-dev](https://github.com/puma/puma-dev) has real wake and sleep but is built around Rails and installs its own DNS resolver. [rpx](https://github.com/stacksjs/rpx) is the closest living tool, part of the Stacks ecosystem. Use lazydev if you want a permanent URL for every project, your RAM back, and a codebase you can read in one sitting.

## License

MIT
