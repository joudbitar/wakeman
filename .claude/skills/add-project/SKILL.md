---
name: add-project
description: Register any project with wakeman so it gets a permanent http://<name>.localhost URL with on-demand start and idle sleep. Use when the user asks to add or register a project with wakeman, when a project the scanner cannot detect (Flask, FastAPI, Go, docker-compose, a Django project without a visible interpreter, anything whose start command is not provable from its files) needs a URL, or when a registered project's entry is broken and needs fixing.
---

# add a project to wakeman

wakeman's scanner auto-detects the common cases. Everything else is one JSON
entry in its registry, and you are the detection logic: read the project,
work out how it serves HTTP, and register it. The bundled script does the
mechanical part (find the registry, validate, pick a free port, write valid
JSON, poll the URL); your job is the judgment part (the right start command).

All script paths below are relative to this skill directory.

## quick start

```bash
# a static folder: $WAKEMAN_STATIC is a placeholder the daemon expands to
# its own serve_static.py at spawn time, so the entry keeps working wherever
# wakeman itself lives
node scripts/registry.mjs add --host myblog --dir /abs/path/to/blog \
  --start-cmd '$WAKEMAN_STATIC'

# a Django app with a project venv
node scripts/registry.mjs add --host crm --dir /abs/path/to/crm \
  --start-cmd ".venv/bin/python manage.py runserver 127.0.0.1:<port>"

node scripts/registry.mjs verify --host myblog
```

`<port>` is replaced with the assigned port at add time. The daemon watches
the registry file, so `add` is the whole deployment — no restart, no signal.

## workflow

1. **Inspect the project.** Find how it serves HTTP: README, Procfile,
   Makefile, manage.py, package.json scripts. The start command must come
   from evidence, not guessing — a wrong command executes arbitrary code
   every time the URL is visited. Thin evidence: ask the user, or register
   with `--parked` so it waits on the dashboard for confirmation.
2. **Make the command port-correct.** The daemon injects `PORT` but many
   stacks ignore it and need the port in the command; interpreters must be
   spelled out (`.venv/bin/python`, `bin/rails`), never left to the shell.
   Per-ecosystem commands: [PORTS.md](PORTS.md).
3. **Register.** `scripts/registry.mjs add` as above. Hosts are lowercase
   `a-z0-9-`, unique, never `wakeman`; dirs are absolute. The script picks
   the port unless you pass `--port`.
4. **Verify.** `scripts/registry.mjs verify --host <host>` polls through the
   front door for up to two minutes; a 503 meanwhile is the cold-start page,
   not a failure. On timeout, read `<state-dir>/logs/<host>.log` (the
   server's own output), fix the startCmd, and re-verify.
5. **Leave it clean.** If it cannot be made to work,
   `scripts/registry.mjs remove --host <host>` rather than leaving a broken
   URL, and tell the user what evidence was missing.

## facts you can rely on

- Registry location: `$WAKEMAN_STATE_DIR/projects.json`, else
  `~/.local/state/wakeman/projects.json`, else `projects.json` in the
  checkout. The script resolves this; a running daemon's boot line in
  `<state-dir>/logs/daemon.log` says `config=<path>` if in doubt.
- Rescans never clobber this entry: the merge preserves port, startCmd, and
  enabled for known hosts, and keeps hand-added entries whose directory
  still exists.
- URLs are portless when the daemon holds :80; on a fallback run they carry
  the port the daemon printed at startup. `verify` tries both.
- Thirty minutes idle and the project's whole process tree is killed; the
  URL stays and the next visit restarts it. Nothing is ever written into
  the project directory.
