# ADR 0003: one way in

Status: accepted (2026-07-22). Supersedes the try/install split in ADR 0001. Its Linux paragraph is replaced by ADR 0004.

## Context

By July 2026 there were three documented ways to get wakeman: `npx
wakeman` (a throwaway foreground run), `git clone` + `install.sh` (the
persistent daemon behind Caddy), and `brew install joudbitar/tap/wakeman` (an
alias for the npx command). Three paths for a tool whose whole pitch is "stop
babysitting your dev servers" is a joke at the tool's own expense, and each
path existed for a reason that has since expired:

- The clone + shell script existed because portless URLs needed Caddy on :80,
  and Caddy needed a config file and a brew install.
- ADR 0002 removed that: the daemon binds :80 itself, wildcard with a
  per-connection loopback guard. Caddy is now dead weight.
- The Homebrew tap was added as a convenience alias before anyone asked
  whether the thing it aliased should be the only path.

The remaining difference between "try" and "install" was that the npx run died
with its terminal. That is not a feature; it is a missing launchd plist.

## Decision

One command, one flow, one place everything lands.

`npx wakeman` (and the installed `wakeman` command, which is the same
entrypoint) does the whole thing:

1. On the first run it asks before touching anything: what it will scan (any
   directory under `~` with a package.json and a `dev` script, reading
   package.json files only), what it will serve (loopback-only URLs, nothing
   reachable from the network, nothing sent anywhere), and what it will
   install (a user LaunchAgent, no sudo). Declining exits with nothing read
   and nothing written.
2. It scans, copies the package into `~/.local/state/wakeman/app` (the npm
   cache can be pruned, so the LaunchAgent points at a copy wakeman owns),
   writes the plist, loads it, and symlinks `wakeman` into `~/.local/bin`.
3. When `~/.claude` exists, it copies the bundled add-project skill into
   `~/.claude/skills`, so the user's coding agent can register anything the
   scanner cannot prove. The skill ships inside the npm package (not pulled
   from a repo at install time) so its instructions always match the daemon
   version they describe; users of other agents install the same skill with
   `npx skills add joudbitar/wakeman`.
4. It prints the URLs that answer and exits. The daemon keeps running through
   reboots.

`wakeman` re-runs are the maintenance surface: rescan, refresh the install.
`wakeman uninstall` reverses all of it: boots out the agent, deletes the
plist, the symlink, the skill (only when its SKILL.md mentions wakeman), and
the state dir, and strips the wakeman block from a Caddyfile left by the old
installer.

Non-interactive runs (CI, pipes) and Linux serve in the foreground instead,
because installing a background service with nobody at the terminal is wrong
and launchd does not exist on Linux. Same command, same scan, same state dir.

Retired: `install.sh`, `uninstall.sh`, the Caddy topology, the Homebrew tap as
a documented path, and the README section explaining which install to pick.

The plist keeps the label `com.wakeman.proxy`, so installing over an old
checkout install replaces the agent instead of fighting it. A machine that
keeps its old Caddy on :80 still works: the daemon loses the :80 bind, lands
on :4000, and Caddy keeps forwarding `*.localhost` there.

## Consequences

- Publishing to npm stops being optional. The one command is the npm package;
  until `wakeman` is published, the README describes something that
  does not exist.
- The bash CLI (`wakeman` in the repo root) is deleted. Its daily-use surface
  moved to the dashboard (status, sleep) and to the entrypoint (`wakeman`
  rescans, `wakeman uninstall` removes); it assumed the old checkout layout
  and a daemon fixed on :4000, both gone.
- Linux persistence is still the systemd unit from issue #10. Until then the
  foreground run is the Linux story, stated plainly in the consent prompt.
- The install can no longer be curl-piped or read as one shell file. The
  trade is deliberate: the consent prompt, not the script's readability, is
  the trust surface now.
