# Contributing

The daemon is one Node file with zero npm dependencies, and it stays that way; a PR that adds a dependency will be asked to lose it. `npm test` runs the whole suite with `node --test`, no setup. CI runs it on macOS, Node 22 and 24.

wakeman is macOS only and staying that way: on anything else the entrypoint prints one line and exits 2. A Linux port is not a PR I'd merge, so don't spend a weekend on one.

Ground rules:

- New behavior comes with a test next to the others in `test/`.
- Loopback-only is not negotiable. Read [SECURITY.md](SECURITY.md) before touching anything that listens.
- For anything bigger than a fix, open an issue first so you don't build something that won't merge.
