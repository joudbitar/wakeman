# 0.3.0 leftovers

Six small things the 2026-09-21 sandbox run turned up after the main spec was built. None blocks daily use. All of them land before the v0.3.0 tag, in one PR, because nothing is published yet and a 0.3.1 for copy fixes is noise.

Each section: what the sandbox showed, the change, the test.

## 1. `wakeman status` hides failures

Seen: crash-app (exits with code 1) and hang-app (never binds) both printed as `. crash-app  stopped  :4620`. The status JSON already carries `lastError: { kind, errorLine }`, and the dashboard shows a red failed badge from it. The CLI drops it.

Where: `cmdStatus` in [bin/wakeman.mjs:1064](../bin/wakeman.mjs). The state is computed as `disabled`, `conflict`, or `r.state`, and the mark is `*`, `!`, or `.`.

Change:

- State becomes `failed` when `r.state === 'stopped'` and `r.lastError` is set. Mark is a red `x`.
- The note after the port is the kind in words plus the error line when there is one, cut to the terminal width:
  - exited: `exited with code 1 · Error: Cannot find module "left-pad"`
  - timeout: `nothing on :4630 after 120s`
  - dir-missing: `folder is gone`
  - install-failed: `npm install failed · <errorLine>`
- Last line of the table, only when something failed: `` `wakeman logs <host>` shows why · `wakeman restart <host>` tries again ``.
- Exit code stays 0. A failed project is a fact about the project, not about the command.

Test, in `test/cli.test.mjs`: seed a runtime record with `lastError.kind = 'exited'` through `__setRuntimeForTest`, run `status`, assert the row contains `failed` and the error line, and that a clean registry prints no hint line.

## 2. A refused first run leaves a folder behind

Seen: `wakeman </dev/null` on a fresh state dir prints "first run needs a terminal" and exits 1, which is right, but `<state>/logs/` now exists. The spec for `--help` promised no state dir side effects, and a refusal should keep the same promise.

Where: `main()` calls `ensureStateDir()` at [bin/wakeman.mjs:1482](../bin/wakeman.mjs), sixteen lines before the non-interactive check.

Change: move `ensureStateDir()` below the `firstRun && !interactive && !assumeYes` return, and below the consent prompt's "no" branch too, so declining consent also writes nothing. `migrateLegacyRegistry()` creates the directory it needs on its own (`fs.mkdirSync(path.dirname(configPath), { recursive: true })`), so it can stay where it is. `firstRun` only reads.

Test, in `test/cli.test.mjs`: run the entrypoint with stdin closed against a state dir path that does not exist, assert exit 1 and `fs.existsSync(stateDir) === false`. Same assertion for a pty run that answers `n`, if the pty helper from `test/attach.test.mjs` makes that cheap. Otherwise the non-tty case is enough.

## 3. `npm install` on every wake for projects with nothing to install

Seen: plain-app has a `package.json` with a `dev` script and no dependencies. `npm install` creates no `node_modules` for it, so the gate at [wakeman.mjs:1479](../wakeman.mjs) (`!haveModules && package.json exists`) is true forever. Every wake runs the install first: about a second each time, an "installing" phase on the wake page that is a lie, and an `install:` separator in the log per start.

Change: before installing, read `package.json` and count the keys of `dependencies`, `devDependencies`, and `optionalDependencies`. Zero across all three: skip the install, go straight to start. Unreadable or invalid JSON: skip too, and let the start command produce the real error. `workspaces` present: install as today, since a workspace root can have no direct dependencies and still need one.

Test, in `test/coldstart.test.mjs`: a fixture project with `{"scripts":{"dev":"node server.js"}}` and no `node_modules` reaches `running` without an `install:` line in the daemon log. A second fixture with one dependency and no `node_modules` still installs.

## 4. The add route ignores fields it does not know

Seen: `POST /__wakeman/add` with `{"dir": ".../hang-app", "host": "plain-app", "startCmd": "..."}` answered `{"ok":true,"host":"hang-app","updated":true}`. The route reads the name from `body.name` ([wakeman.mjs, the `/__wakeman/add` handler](../wakeman.mjs)); `host` fell on the floor and the folder name was used. The registry key is `host`, the CLI flag is `--name`, the form field is `name`. Anyone scripting against the route guesses wrong half the time, and a wrong guess silently renames nothing.

Change:

- Accept both: `const rawName = body.name ?? body.host`. Both present and different: 400, `send "name" or "host", not both`.
- Unknown keys are a 400 that names them: `unknown field "hots"; known: dir, name, host, startCmd, port, framework, parked`. Same rule on `/__wakeman/set/<host>` (`port`, `startCmd`) and `/__wakeman/detect` (`dir`). One helper, `rejectUnknown(body, allowed)`, used by all three.
- The existing collision rule in `addEntry` then does its job: a name that belongs to a different folder is refused with the message it already has.

Test, in `test/dashboard-routes.test.mjs`: `host` works as an alias, `name` plus a different `host` is a 400, an unknown key is a 400 naming the key, and the sandbox request above now gets the "already registered for" refusal instead of a silent update.

## 5. The unprovable-folder hint suggests the wrong command

Seen: `wakeman add ~/code/flask-app` lists what the detectors looked for, then says:

```
say how it starts and it is registered either way:
  wakeman add ~/code/flask-app --cmd "npm run dev"
```

The folder has `app.py` and `requirements.txt`. The one command it cannot be is `npm run dev`.

Where: [bin/wakeman.mjs:935](../bin/wakeman.mjs).

Change: pick the example from what is in the folder, first match wins. This is a hint for a human to edit, not a detector, so likelihood is fine here where it is not in `lib/detect.mjs`.

| marker in the folder | example shown |
| --- | --- |
| `manage.py` | `python manage.py runserver <port>` |
| `app.py`, `wsgi.py`, or `flask` in `requirements.txt` | `flask run --port <port>` |
| `main.py` with `fastapi` or `uvicorn` in `requirements.txt` / `pyproject.toml` | `uvicorn main:app --port <port>` |
| `go.mod` | `go run . ` with a note that the app must read `PORT` |
| `Cargo.toml` | `cargo run` with the same note |
| `docker-compose.yml` or `compose.yaml` | `docker compose up` plus `--port` set to the published port |
| `Gemfile` | `bundle exec rackup -p <port>` |
| `package.json` without a provable `dev` script | `npm start` |
| nothing matched | `your-start-command --port <port>` |

Add one line under it: `` `<port>` is replaced with the port wakeman assigns. `` That substitution already exists in `addEntry` and nothing in the CLI output mentions it.

Test, in `test/cli.test.mjs`: a temp folder with `app.py` gets the flask line, an empty folder gets the generic line, and neither output contains `npm run dev`.

## 6. A spinner frame at the end of the log tail

Seen: the tail for crash-app ended with `⠙`. Under a pty npm draws its progress spinner, a braille glyph rewritten in place with `\r`. The log writer at [wakeman.mjs:1060](../wakeman.mjs) strips escape sequences and holds a trailing `\r`, but a `\r` in the middle of a chunk passes through, so every frame the spinner drew is in `<host>.log` and the last one sits at the end of the tail. The xterm ring buffer is right to keep them. The plain-text log is not.

Change, in the log writer only (the ring buffer and the socket stay byte-exact):

- Apply carriage returns the way a terminal would, per line: for each `\n`-terminated line, keep the text after the last `\r` that is not part of `\r\n`. A progress bar that redraws forty times becomes its final state.
- After that, drop a line that is empty or consists only of characters in U+2800 to U+28FF and whitespace. That is every frame of npm's, pnpm's, and ora's spinners.
- The carry logic for an unfinished line stays: a line is only processed once its `\n` arrives, or at `end()`.

Test, in `test/term.test.mjs` or next to the existing log-strip tests: feed `"⠋\r⠙\r⠹\rdone\n"` and assert the log has exactly `done`. Feed `"10%\r50%\r100%\n"` and assert `100%`. Feed `"line one\r\nline two\r\n"` and assert both lines survive untouched. Feed a chunk split in the middle of a redraw (`"⠋\r⠙"` then `"\rok\n"`) and assert `ok`.

## Order and size

Sections 2, 5, 1 are entrypoint-only and take an hour together. Section 3 is ten lines in `ensureUp`. Section 4 is one helper and three call sites. Section 6 is the only one with a real edge (chunk boundaries), so it goes last with its four tests. Half a day, one PR onto the `v0.3.0` branch, then the sandbox run is not needed again: every item has a test that fails today.
