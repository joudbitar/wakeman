# lazydev 0.3.0: the release worth sharing

Written 2026-09-12 from a sandbox test of the npm 0.2.3 tarball and the current checkout: eight fake projects under a throwaway `$HOME` (plain node server, Vite, Vite with no `node_modules`, a pinned port, a server that exits on start, one that never binds, a Flask app, a static folder in git), the first-run screens through a pty, the pages in a browser. Everything below cites what that run showed.

## Decisions already made

- macOS only. The foreground path and the Linux story go away.
- One release. Nothing is published until every section here is done. Version 0.3.0, Node 22 or newer.
- Terminal interaction goes all the way: a real pty per dev server, a terminal panel in the dashboard you can type into, and `lazydev attach <host>` in your own shell.
- Editing lives in both places: subcommands for every registry change, and the same actions in the dashboard.

## 1. Flags and subcommands

What happens today: `npx @jbitar/lazydev --help` runs the full first-run flow (consent, scan, install). The command is the first argument that does not start with a dash, so every flag is invisible ([bin/lazydev.mjs:809](../bin/lazydev.mjs)). `lazydev status` answers "unknown command".

Change:

- `-h`, `--help`, `help` print the command table and exit 0. `-v`, `--version` print the version and exit 0. Both before anything else runs, before the state dir is touched.
- Unknown command prints "unknown command X" plus the same table, exit 1.
- Commands, all of them:

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

- `add` with no `--cmd` runs the detectors from `lib/detect.mjs` on that one directory. Provable: register. Not provable: print what it looked for and exit 1, with the `--cmd` form as the fix. `dir` defaults to the current directory, `--name` defaults to the folder name. `--parked` registers `enabled: false`.
- Registry writes go through one module. Move `.claude/skills/add-project/scripts/registry.mjs` to `lib/registry-cli.mjs`; the skill script becomes a two-line re-export so the skill and the CLI cannot drift. The daemon watches `projects.json`, so a write is the whole deployment.
- Runtime actions (`stop`, `restart`, `wake`, `status`, `logs -f`, `attach`) talk to the daemon over the control API on the front port with the token from `<state>/control-token`. Daemon not answering: "lazydev is not running; run `lazydev` to start it", exit 3.

Acceptance: `--help` on a machine with no state dir leaves no state dir behind. Every command in the table has a test that runs it against a daemon on a random port.

## 2. macOS only

What happens today: a non-TTY run, and any run on Linux, serves in the foreground. The consent copy on 0.2.3 says "a systemd port is the PR I'd merge first", which reads as a network port.

Change:

- `process.platform !== 'darwin'`: print "lazydev runs on macOS. Linux support is not planned." and exit 2. Nothing else.
- Delete the foreground branch in `main()`, `printForegroundBanner`, `runDaemon`, `decideServePort`, `LAZYDEV_NO_INSTALL`. Non-TTY on macOS with no registry: exit 1 with "first run needs a terminal (it asks before installing)". Non-TTY with a registry: rescan, no prompt, as now.
- CI matrix: `macos-latest`, Node 22 and 24. The boot smoke test (`test/npx-boot.test.mjs`) drives `lazydev.mjs` directly on a random `LAZYDEV_PORT` instead of the entrypoint, because a GitHub runner has no GUI launchd domain to bootstrap into. The entrypoint's own tests cover consent, scan, help, version, and the non-darwin exit by stubbing `process.platform`.
- Close issue #10 with a one-line comment. Remove the Linux paragraph from the README.

## 3. Picker: "not now"

What happens today: press `q` in the picker and the run continues with "found 0 projects", then "no projects found under ~", then it boots. It found seven.

Change: `q` exits the whole run with "ok, nothing registered. run `lazydev` again whenever." and exit 0, same as declining consent. `scanDeclined` is untouched. Esc does the same. Ctrl-C stays exit 130.

## 4. Failures you can see

What happens today, from the sandbox:

- A server that exits in 100 ms gets the page "did not open 127.0.0.1:3010 within 30s". The daemon log knows it exited (`start-failed ... exited (code=1)`) but the page shows the timeout copy for every failure.
- The dashboard shows a failed project as "sleeping". You find out by opening the URL.
- A project whose folder was moved shows "starting" until the 120 s timeout. The spawn ran `sh -c` in a directory that does not exist.
- The per-project log concatenates every attempt with no separator, so the terminal panel showed two `compiling...` runs as one.

Change:

- `r.lastError.kind` is one of `exited`, `timeout`, `dir-missing`, `install-failed`, `conflict`. Set `dir-missing` before spawning, with a `fs.statSync(project.dir)` check. Each kind has its own page copy:
  - exited: "The dev server exited with code 1 after 0.1s." then the log.
  - timeout: "Nothing answered on port 3020 within 120s. The process is still being killed." then the log.
  - dir-missing: "The folder /Users/x/code/app is gone. Move it back, or `lazydev remove app` / `lazydev add /new/path --name app`."
  - install-failed: "`npm install` exited with code 1." then the log.
- Dashboard: a red `failed` badge with the kind as its tooltip, the first error line of the log tail next to it, and the row's terminal panel opens on click. `status` JSON carries `lastError`.
- Every start writes a separator line to `<host>.log`: `── 2026-09-12 17:31:17 · start: npm run dev (PORT=3030) ──`. The tail endpoint returns only lines after the last separator by default; `?all=1` for everything.
- A failed project does not re-run `npm install` on the next request unless `node_modules` is still missing. Today every retry reinstalls.

## 5. Adoption that re-checks

What happens today: the daemon adopts a server you started by hand from the project folder (correct). That server dies. A different process from `/tmp` binds the same port. The daemon still says "running (external)" and proxies the stranger. The check runs once, at adoption.

Change: store the adopted pid in the runtime record. Before proxying to an adopted upstream, if more than 2 s passed since the last verification, resolve the listening pid again. Same pid: proxy. Different pid or none: drop the record and run the normal bring-up (which does the cwd check and lands on adopt, spawn, or conflict). The 2 s cache keeps this to one `lsof` every two seconds per busy project, which is what `resolvePidCwd` already costs at adoption.

Acceptance: test E in `test/adopt.test.mjs` gets a sibling: adopted upstream dies, a foreign listener takes the port, the next request is a conflict page, not the foreign body.

## 6. A terminal per dev server

The reason to install lazydev over running `npm run dev` in a tab is that the tab is gone. So the tab has to come back on demand. Log tails are not enough: Next asks "port in use, use 3001 instead? (y/n)", Vite has keyboard shortcuts, Rails drops into byebug, and colors matter when you read a stack trace.

Tested facts, this machine, 2026-09-12:

- macOS `script(1)` refuses a non-tty stdin (`tcgetattr/ioctl: Operation not supported on socket`), so it cannot be the pty.
- `python3 -c 'import pty; pty.spawn(...)'` gives the child a real tty (`/dev/ttys000`), and SIGTERM to the python process takes the whole tree with it (the master closes, the child gets SIGHUP). `/usr/bin/python3` ships with the Xcode command line tools, which anyone with git has.
- Node 22 has a global `WebSocket` client. That is the `attach` transport.

Design:

- `lib/pty.py`, about 60 lines, shipped in the package. `pty.fork()`, `TIOCSWINSZ` to the requested size, `TERM=xterm-256color`, `exec` of `sh -c <startCmd>`. Relays master to stdout and stdin to master. Reads `rows cols\n` lines on fd 3 for resizes. Exits with the child's exit code.
- The daemon spawns `python3 lib/pty.py` with `stdio: ['pipe','pipe','pipe','pipe']` instead of `sh -c` directly. The process group logic stays (python is the group leader, `detached: true`). Kill order on stop: SIGTERM to the group, 5 s, SIGKILL, unchanged.
- No `python3` on PATH: fall back to today's pipe spawn. The panel is read-only and says so in one line at the top. `lazydev status` prints the same line once.
- Per project, a ring buffer of the last 256 KB of raw pty output, ANSI intact. `<host>.log` keeps the plain-text copy with escapes stripped, as now, for `lazydev logs` and grep.
- `GET /__lazydev/term/<host>` is a WebSocket upgrade on the `lazydev` host. Auth: the control token as the `Sec-WebSocket-Protocol` value, because a browser cannot set headers on a WebSocket and the dashboard already holds the token same-origin. First frame from the server is the ring buffer, then live bytes. Client frames: `i:<bytes>` for input, `r:<rows>,<cols>` for resize. A minimal RFC 6455 server (masking, text and binary frames, ping/pong, close) is about 80 lines of built-ins, `lib/ws.mjs`, with its own tests against Node's client.
- Dashboard: each row has a `terminal` button. It expands the row into an xterm.js panel, 100% wide, 24 rows, focus on open. Vendor `@xterm/xterm` 5.5 and `@xterm/addon-fit` as files under `lib/vendor/` (about 330 KB, checked in, no npm runtime dependency; a `scripts/vendor.sh` records the version). Served at `/__lazydev/vendor/*` with a long cache header. Buttons in the panel header: restart, stop, clear, pop out (opens `http://lazydev.localhost/term/<host>` in its own tab). Multiple panels can be open.
- `lazydev attach <host>`: raw mode on the local tty, connect, forward bytes both ways, send a resize on SIGWINCH, detach on Ctrl-] (printed once on connect). The dev server keeps running after detach; it is lazydev's process, not the shell's.
- `lazydev logs -f <host>`: same socket, output only, escapes stripped, no raw mode.
- Reaper: an open terminal socket counts as an active connection, so a project with its terminal open in a tab does not sleep. The 2 h hard cap already covers an abandoned tab.

Acceptance: a test spawns a project whose dev script is `sh -c 'read x; echo got $x; node server.js'`, opens the term socket, sends `i:hello\n`, sees `got hello`, and the port comes up. A second test checks that `restart` from the socket produces a new pid and a new separator in the log.

## 7. Dashboard: edit everything the registry holds

What happens today: rename is the only edit. A parked static site says "(disabled)" and the only way to turn it on is editing JSON. No add, no remove, no port change.

Change, on the same single-file dashboard:

- `add project` button above the table opens a form: folder path (text field, `~` allowed), name (prefilled from the folder), start command (prefilled by running the detectors on the path via `POST /__lazydev/detect`, editable), port (prefilled from the pool), parked checkbox. Submit calls `POST /__lazydev/add`. Errors inline (folder does not exist, name taken, port in use).
- Per row, behind the existing pencil: name (as now), port (number field, blocked while running: stop it first), start command (text). Enter saves, Esc cancels, same as rename today.
- Per row: `enable` / `disable` replaces the "(disabled)" text. A disabled row is greyed, switch hidden.
- Per row: `remove`, with a confirm that names the host. Removes the registry entry only; the folder is never touched, the copy says so.
- Per row: `restart` next to the switch when running.
- Failed badge and terminal panel from sections 4 and 6.
- Routes: `POST /__lazydev/add`, `/__lazydev/remove/<host>`, `/__lazydev/enable/<host>`, `/__lazydev/disable/<host>`, `/__lazydev/set/<host>` (port and startCmd), `/__lazydev/restart/<host>`, `/__lazydev/detect`. All token-gated. All write through `lib/registry-cli.mjs`, the same code as the subcommands.

Polish, from the screenshots:

- The ASCII logo renders as a smeared block in Safari and Chrome. Replace it with the word `lazydev` in the monospace stack at 28 px and the sleeping `z` glyphs after it. Keep `LOGO` for the terminal.
- "idle sleep after 0m" for anything under a minute: format as `30s`, `5m`, `1h 30m` with the existing `fmtIdle`.
- Wake page: the title said "installing" while the body said "being turned on". One source of truth: `phraseByPhase` feeds both, and the title updates on each poll.
- Wake page counter: show from 0 s, not from 3 s. A number that appears late looks like a bug.
- Failed page: the log box is the same grey in dark mode as light. Use the page's `prefers-color-scheme` block for it.

## 8. Static sites survive an npx cache prune

What happens today: the scanner writes `startCmd: "python3 /abs/path/to/serve_static.py"`, and under npx that path is `~/.npm/_npx/<hash>/...`, which npm prunes. The install copies the app to `<state>/app`, but the registry still points at the cache.

Change: the registry stores `"startCmd": "$LAZYDEV_STATIC"`. The daemon expands it at spawn time to `python3 <dir of the running lazydev.mjs>/serve_static.py`. On config load, any `startCmd` that ends in `serve_static.py` is rewritten to the placeholder and the file is saved back, once, with a log line. The add-project skill docs drop the "find the absolute path" paragraph.

## 9. README, repo, package

- README: rerun the first-run screen after sections 1 to 3 land and paste the real transcript (the current sample says v0.2.2 and shows copy that no longer exists). Replace `docs/dashboard.png` (dated Jul 21, before the live rows) with the 0.3.0 dashboard showing one failed, one running, one external, one with the terminal open. Replace the gif comment with the gif (section 11). Drop the Linux paragraph and the "systemd" line. Add a "terminal" paragraph under "Day to day" with the `attach` command.
- `package.json`: version 0.3.0, `engines.node >=22`, `files` gains `lib/vendor/` and `lib/pty.py`.
- Repo: remove the `caddy` topic, set the homepage to the README, keep the rest. `gh repo edit` does both; I can run it when you say so.
- Publishing: the workflow publishes on a GitHub release, and the last release is v0.2.0. 0.2.2 and 0.2.3 reached npm some other way. For 0.3.0: tag, `gh release create v0.3.0 --generate-notes`, watch the publish job, then `npm view @jbitar/lazydev version` says 0.3.0.

## 10. Tests that must exist before the tag

- help, version, non-darwin exit, unknown command (entrypoint, no state dir side effects)
- every subcommand against a daemon on a random port
- picker `q` exits without booting
- failure kinds: exited, timeout, dir-missing, install-failed, each with its page copy and its dashboard badge
- log separator and tail-since-separator
- adoption re-verify (section 5)
- pty: input reaches the child, resize reaches the child, no python3 falls back to pipes
- ws framing round trip with Node's client, including a 70 KB frame and a masked close
- term socket auth: no token, wrong token, token on the wrong host all get 401 and a closed socket
- static placeholder expansion and the one-time rewrite
- dashboard routes: add, remove, enable, disable, set, restart, detect, each rejecting a bad token
- the existing 139 keep passing, and the suite runs on macos-latest for Node 22 and 24

## 11. Things only you can do

### Record the gif

Twelve seconds, two beats: the install, then a sleeping URL waking. Kap is the tool: free, records a region, exports gif directly.

1. `brew install --cask kap`. Open it once, allow screen recording in System Settings when it asks.
2. Prep, so the recording is clean: `lazydev uninstall` (say yes), then close every browser tab that points at a `.localhost` URL. Set the terminal to 100 columns by 30 rows, a plain prompt (`PS1='$ '` in that shell), font size 16.
3. Arrange: terminal on the left half of the screen, an empty browser window on the right half. Kap's region should cover both, about 1400 by 700.
4. Record. In the terminal, type `npx @jbitar/lazydev`, wait for the consent screen, press `y`, wait for the picker, press enter. As soon as the banner prints, click into the browser, type `http://portfolio.localhost` (or whichever of your projects cold-starts in under 8 s), press enter. Let the spinner run until the app shows. Stop after one second on the app.
5. Export: gif, 15 fps, width 1200, loop. Kap's gif export uses gifski; if the file is over 5 MB, drop to 12 fps or width 1000.
6. Save as `docs/install.gif`. The README line is `![...](docs/install.gif)` where the gif comment is now.

If Kap fights you, QuickTime works: File, New Screen Recording, pick the region, then `ffmpeg -i rec.mov -vf "fps=15,scale=1200:-1:flags=lanczos" -loop 0 docs/install.gif` (ffmpeg is already installed at `/opt/homebrew/bin/ffmpeg`).

### Retake the dashboard screenshot

After section 7 lands: open `http://lazydev.localhost` with five or six real projects, get one running, one running (external) by starting it yourself in a terminal, one failed (a project whose dev script is temporarily `exit 1`), and one terminal panel open showing colored output. Cmd-Shift-4, space, click the window. Save over `docs/dashboard.png`. Keep it under 300 KB; `pngquant` if needed.

### The release

I can do the tag and `gh release create` on your word, but the word has to be yours: the publish job pushes to npm with the `NPM_TOKEN` secret and that cannot be undone. Check the CI run on the tag is green first.

### Stars

Ask after they have used it for a day, not at install. The message that works is the specific one: "the thing I built so I stop keeping 15 terminal tabs open, try `npx @jbitar/lazydev`". Ten friends, ten stars is realistic; the README with the gif does the rest.

## Order of work

1. Sections 1, 2, 3: the CLI is the front door, and deleting the foreground path simplifies everything after. One day.
2. Sections 4, 5, 8: correctness. One day.
3. Section 6: pty, ws, panel, attach. Two days.
4. Section 7: dashboard editing and polish. One day.
5. Section 9 and the manual list. Half a day plus your recording.

Each phase is its own PR against main with its tests, so the checkout you run daily (the LaunchAgent runs the checkout in place) never has a half-built phase live.

## Defaults I chose, say if wrong

- The terminal panel is dark regardless of the page theme, like every terminal.
- `lazydev open` uses `open`, the macOS command, nothing else.
- Removing a project that is running stops it first.
- `lazydev add` on an already-registered folder updates the entry instead of failing.
- xterm.js is vendored, not loaded from a CDN, so the dashboard works offline. 330 KB in the package is the cost.
