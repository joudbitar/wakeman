# Contributing

The daemon is one Node file with zero npm dependencies, and it stays that way; a PR that adds a dependency will be asked to lose it. The only third-party code is xterm.js in `lib/vendor/`, checked in so the dashboard works offline. `scripts/vendor.sh` refetches it, and `--check` re-hashes what's there.

wakeman runs on macOS and on Linux with systemd. Anything else gets one line from the entrypoint and exit 2. A Windows port is not a PR I'd merge, so don't spend a weekend on one.

## Running it from a checkout

```
git clone https://github.com/joudbitar/wakeman
cd wakeman
node bin/wakeman.mjs
```

A checkout installs in place. The service (the LaunchAgent, or the systemd unit on Linux) runs the repo itself instead of a copy, `~/.local/bin/wakeman` links to it, and the daemon watches `wakeman.mjs` and `lib/`. Save a file and the daemon exits; launchd or systemd starts it again on your code about a second later. The dev servers it owned go down with it and start fresh on the next request.

This takes over from any wakeman you already had and uses the same registry in `~/.local/state/wakeman`. `wakeman uninstall` takes it off, and `npx wakeman` puts the published one back.

## Tests

`npm test` runs the whole suite with `node --test`, no setup. CI runs it on macOS and Ubuntu with Node 22 and 24, plus a real install and uninstall on Ubuntu's systemd, and a release runs it again before anything reaches npm.

Tests point `WAKEMAN_STATE_DIR` at a temp dir so they never read your registry. A test that imports `wakeman.mjs` imports `test/isolate-logs.mjs` above it, or on a checkout install it writes into the live daemon's log.

To see a change the way a new user meets it, `scripts/fresh-cycle.sh` uninstalls, checks nothing is left behind, reinstalls from the checkout, and saves every screen under `logs/cycles/`. `--pty` drives the consent prompt and picker through a real terminal. It deletes your state dir, so copy `projects.json` somewhere first.

## Before you open a PR

- New behavior comes with a test in `test/`, next to the others for the same area.
- Loopback-only is not negotiable. Read [SECURITY.md](SECURITY.md) before touching anything that listens.
- For anything bigger than a fix, open an issue first so you don't build something that won't merge. Decisions that already settled an argument are in [docs/adr/](docs/adr/).
- Commit subjects are lowercase and say what changed: `serve_static: open the port without a reverse DNS lookup first`.

How-do-I questions go to [Discussions](https://github.com/joudbitar/wakeman/discussions), bugs and feature requests to the issue templates, and security reports to the address in [SECURITY.md](SECURITY.md).
