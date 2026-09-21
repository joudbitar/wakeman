# start commands per ecosystem

The daemon runs `startCmd` with `cwd` set to the project directory and
`PORT=<port>` in the environment, then probes the port on `127.0.0.1` and
`::1`. The command must put an HTTP server on that exact port, bound to
loopback. `<port>` in a command below is replaced by `registry.mjs add`
automatically.

## honors the PORT env var (plain command, no flag)

- Next.js: `npm run dev` / `pnpm dev`
- Create React App: `npm run dev`
- Express-style Node servers that read `process.env.PORT`
- xerb's own `serve_static.py` (static folders)

## needs the port written into the command

- Vite / Astro / SvelteKit / Remix: `pnpm dev -- --port <port> --strictPort`
  (`--strictPort` matters: without it Vite silently moves to another port and
  the daemon's probe never sees it)
- Django: `.venv/bin/python manage.py runserver 127.0.0.1:<port>`
- Flask: `.venv/bin/flask run --port <port>`
- FastAPI/uvicorn: `.venv/bin/uvicorn main:app --port <port>`
- Rails: `bin/rails server -p <port>`
- php built-in: `php -S 127.0.0.1:<port>`
- static folder: `python3 <serve_static.py>` (reads PORT, serves cwd with
  clean URLs). The script ships with xerb: an installed machine has it at
  `~/.local/state/xerb/app/serve_static.py`, a checkout at its root. Use
  the absolute path that exists.

## interpreters and environments

Python and Ruby commands must not rely on the shell finding the right
interpreter. Spell the project's own environment into the command, in
preference order of what you find evidence for:

- `.venv/bin/python` or `venv/bin/python` in the project
- `poetry run python` when pyproject.toml has `[tool.poetry]`
- `uv run python` when uv.lock exists
- `bin/rails` (binstub) over a bare `rails`

No provable interpreter, no entry. Ask the user instead.

## install steps

The daemon runs an npm-style install automatically before first start, but
only when the project has a `package.json`. Everything else must be
pre-installed: if a Django project's venv is missing, creating it is your
job (with the user's consent), not the daemon's.
