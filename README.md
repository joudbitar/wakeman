# wakeman

A local proxy that starts dev servers on demand behind permanent URLs. Named for the wakeman, the town officer who kept the night watch.

You have ten projects. Each has a dev server that grabs a port and eats RAM whether or not you're using it, so you either keep fifteen terminal tabs alive or keep restarting things and guessing which port is which. wakeman's deal: every project gets a permanent URL, `http://portfolio.localhost`, and the server behind it runs only while you're actually using it.

There is one way to get it, and it asks before it does anything:

```
$ npx wakeman

                    _                                        Z
  __      __  __ _ | | __  ___  _ __ ___    __ _  _ __     z
  \ \ /\ / / / _` || |/ / / _ \| '_ ` _ \  / _` || '_ \  z
   \ V  V / | (_| ||   < |  __/| | | | | || (_| || | | |
    \_/\_/   \__,_||_|\_\ \___||_| |_| |_| \__,_||_| |_|

  v0.3.2 · starts dev servers when you open their URL, stops them when idle

  scan     your home folder for dev projects · reads config files, writes nothing
           macOS may ask to let your terminal read Desktop, Documents or Downloads; Don't Allow skips that folder
  pick     which get a URL like http://<name>.localhost · works only on this machine
  install  a background service · no sudo, keeps the URLs working after reboot
  add      the add-project skill to ~/.claude/skills · for projects the scan misses

  everything is stored in ~/.local/state/wakeman · wakeman uninstall deletes all of it

  proceed? [Y/n] y

  found 3 new projects · read 4,812 folders in 0.4s · pick which get a URL
  ❯ ◉  static  notes      ~/code/notes
    ◉  node    portfolio  ~/code/portfolio
    ◉  next    shop       ~/code/shop
  ↑↓ move · space toggle · a all · enter confirm · q not now
  unchecked ones are not asked about again · undo: "scanDeclined" in ~/.local/state/wakeman/projects.json

  ✓ found 3 projects  1 next  1 node  1 static
  ✓ service running

  wakeman v0.3.2  installed in 1214 ms

  dashboard  http://wakeman.localhost
  projects   3 · open a URL and its dev server starts

  http://notes.localhost         http://shop.localhost
  http://portfolio.localhost

  runs in the background and survives reboots · registry: ~/.local/state/wakeman/projects.json · logs: ~/.local/state/wakeman/logs
  `wakeman` rescans for new projects · `wakeman uninstall` removes everything
  agent skill: add-project installed to ~/.claude/skills · other agents: npx skills add joudbitar/wakeman
```

That's the whole install. Answering `n` exits with nothing read and nothing written. It needs macOS and node 22 or newer; an older node gets one line saying so.

<!-- gif: record `npx wakeman` in a terminal (consent prompt, y, installed banner), then visit a sleeping project in the browser. the tab spins a few seconds while the server boots, then the app appears. ~12s with QuickTime or Kap, crop to terminal + browser. -->

The dashboard at `http://wakeman.localhost`:

![the wakeman dashboard: five projects, two awake, sleep buttons for the running ones](docs/dashboard.png)

## How it works

You open `http://portfolio.localhost`. Addresses ending in `.localhost` reach your own machine by web standard, no /etc/hosts edits, no DNS tools, so the request lands on wakeman, which reads the host name and looks `portfolio` up in its registry: one JSON file of name, folder, port, start command.

If portfolio's server is running, the request is piped straight through and you never notice wakeman was there. If it's asleep, you get an instant page with a spinner while wakeman runs the project's start command; the moment the port answers you're handed to the real app, no manual reload. A Next app cold-starts in about 8 seconds on my machine, timed with curl. Thirty minutes after the last request, the server is killed and its RAM freed. The URL keeps working; the next visit wakes it again.

Sleeping a project kills the whole process tree (pnpm, the framework under it, its workers), not just the top pid. WebSockets are piped raw, so hot-module reload works through the proxy. `tenant.myapp.localhost` routes to `myapp` with the Host header intact, so multi-tenant apps still see their subdomain. And a dev server you started yourself in a terminal gets adopted, not fought.

`npx wakeman` scans your home directory (or the `scanRoots` you set in the registry) for projects it can prove how to run: Node projects with a `dev` script, Rails apps, Django projects with a visible venv or lockfile, and static folders that are their own git repo. In a terminal, new finds go through a picker before anything registers: space skips one, `a` toggles all, enter confirms. A project you uncheck is remembered in `scanDeclined` and never asked about again; delete its line from the registry to undo. Static folders you confirm register on. Without a picker (pipes, CI, `--yes`) everything registers, static finds parked until you switch them on, since build output and docs folders look the same on disk. Each project gets a free port, and a user LaunchAgent keeps the daemon alive through reboots; the daemon itself owns :80, loopback-only, so there is no Caddy and no sudo anywhere. If something else already holds :80 (Herd, Valet, MAMP, a Docker container), wakeman takes :4000 instead, the URLs end in `:4000`, and the install says which process is in the way. The LaunchAgent runs Homebrew's `opt/` link to node, or its own copy of any other node, so `brew upgrade` or `nvm uninstall` does not take the URLs down. All state lives in `~/.local/state/wakeman`; nothing touches your project folders. Anything the scan can't prove (a Flask app, a Go server, docker-compose) is one JSON entry in the registry, and the install puts an agent skill ([add-project](.claude/skills/add-project/SKILL.md)) into `~/.claude/skills` that teaches a coding agent to write that entry end to end: read the project, pick the start command and port, register it, and poll the URL until it wakes. Tell your agent "add my flask app to wakeman" and it does the rest. On Cursor, Codex, or another agent, `npx skills add joudbitar/wakeman` installs the same skill where your agent looks for it. The scanner covers the provable case; your agent covers yours.

## Day to day

The dashboard at `http://wakeman.localhost` lists every project with its state, a switch that puts a running one to sleep, and a terminal button per row. Names, ports and start commands are edited in place; you can add a project by path there, or drop one, which removes the registry entry and never the folder.

Every one of those edits is a subcommand too, and so is everything about a running server:

```
wakeman                     first run: consent, scan, install. later: rescan
wakeman status              every project, state, port, idle, one line each
wakeman add [dir] [--cmd "..."] [--port N] [--name host] [--parked]
wakeman remove <host>
wakeman enable <host> | disable <host>
wakeman port <host> <N>
wakeman rename <host> <new>
wakeman stop <host> | restart <host> | wake <host>
wakeman open <host>         open http://<host>.localhost in the default browser
wakeman logs <host> [-n N] [-f]
wakeman attach <host>       your terminal becomes the dev server's terminal
wakeman install             force a reinstall (rebake the service PATH)
wakeman uninstall
```

Each project runs under a real pty, so its dev server has a tty: colors survive and you can type back at it. `wakeman attach portfolio` hands your terminal to that dev server, which is how you answer Next's "port in use, use 3001 instead?" or press `r` at Vite. Ctrl-] detaches and the server keeps running, because it is wakeman's process and not your shell's. The `terminal` button on a dashboard row is the same session in the page, with a pop-out into its own tab, and `wakeman logs <host> -f` is the same stream with the escapes stripped and nothing going back. Without `python3` on PATH there is no pty: the output still shows, what you type goes nowhere, and the panel says so on its first line.

Anything registered from a folder under `~/viewables` (or `WAKEMAN_VIEWABLES_DIR`) is a viewable: a one-off page, like a report or a mockup, that only needs a URL. Viewables sit in their own collapsed list under the projects. When one hasn't been opened or edited in 14 days (`viewableArchiveDays` in the registry), wakeman archives it: the URL answers 410 and the entry moves to an archived list, where restore brings it back. Archiving never touches the folder. The archived list's delete button is the only thing that does, and it moves the folder to the Trash.

Projects under `~/Desktop`, `~/Documents`, `~/Downloads`, iCloud Drive or an external disk are behind macOS privacy prompts. The scan asks for your terminal, and the service asks for `node` right after the install. If either gets Don't Allow, the scan says which folder it skipped, and a project there fails with a page that names the setting to flip (System Settings › Privacy & Security › Files and Folders) instead of claiming the folder is gone.

Logs are plain files: `~/.local/state/wakeman/logs/daemon.log` for the proxy, `<host>.log` per project. The registry at `~/.local/state/wakeman/projects.json` is yours to edit: rename a project, change its port, park it, or add `scanRoots` and `scanExclude` to steer the scanner. A rescan merges; it never clobbers what you fixed by hand.

## How it's built

The daemon is one Node file with no npm dependencies: router, reverse proxy, process supervisor, terminal sockets and idle reaper in about 4,500 lines of built-ins. The one piece of vendored code is xterm.js, checked into `lib/vendor/` so the dashboard works offline.

- Everything is loopback-only and fails closed: a connection from off the machine is dropped at accept, and a request that somehow gets further is refused with a 403. The control plane requires a token the daemon mints at boot. How :80 gets bound is in [docs/adr/0002-wildcard-bind-loopback-guard.md](docs/adr/0002-wildcard-bind-loopback-guard.md).
- Health probes try `127.0.0.1` and `::1` separately, because plenty of dev servers listen on one family only.
- `scan` merges instead of overwriting, so a rescan never clobbers the port or start command you fixed by hand.
- The pty is `lib/pty.py`, run by the `python3` that comes with the Xcode command line tools, because macOS `script(1)` refuses a stdin that is not a tty. No python3 on PATH and the terminal falls back to pipes, read-only.

## What it doesn't do

- Any OS but macOS. The install is a user LaunchAgent holding :80; on anything else wakeman prints one line and exits.
- https, yet.
- Anything except dev servers. Databases, Docker, queues, and tunnels are out of scope, and stopping idle servers is the opposite of what a production process manager wants.

## Alternatives

[hotel](https://github.com/typicode/hotel) proved people want this (10k stars) and then went quiet; it starts servers on access but never stops them. [chalet](https://github.com/jeansaad/chalet) is its maintained fork, same model. [puma-dev](https://github.com/puma/puma-dev) has real wake and sleep but is built around Rails and installs its own DNS resolver. [rpx](https://github.com/stacksjs/rpx) is the closest living tool, part of the Stacks ecosystem. Use wakeman if you want a permanent URL for every project, your RAM back, and a codebase you can read in one sitting.

## License

MIT
