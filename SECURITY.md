# Security

wakeman proxies browser traffic to dev servers on your own machine and starts those servers on demand. This file is the threat model: what the design defends against, what it deliberately does not, and how to report a hole.

## The model

Nothing off your machine can reach wakeman or anything behind it.

- The daemon binds the wildcard address on :80, because macOS refuses a non-root loopback bind there (ADR 0002). Two guards compensate, both fail closed: a connection whose remote address is not loopback is destroyed at accept before a byte is read, and every request and WebSocket upgrade that gets further is independently checked and 403d unless it arrived on a loopback address. A LAN port scan sees an open port that never answers. A mistake in one layer does not expose you.
- The control plane (the endpoints that wake, sleep, restart, or reconfigure projects) requires a capability token the daemon mints at boot, stored with mode 600 in the state directory, plus a same-origin check. That is the defense against a malicious web page driving `localhost:4000` from inside your own browser.
- No telemetry, no outbound network traffic, no sudo anywhere.

## Supply chain

The published package has zero npm dependencies: 16 files, all from this repository (`npm pack --dry-run` lists them). Releases are published from GitHub Actions with npm provenance, so the npm page links every version to the public commit it was built from. CI runs the test suite on every push, on macOS.

## What it does not defend against

- Your dev servers themselves. wakeman starts and proxies them; it does not sandbox them. A dev server on localhost is exactly as reachable as it was without wakeman.
- The code you choose to run. Visiting a project's URL runs that project's dev script, the same code `pnpm dev` would run. `wakeman scan` registers anything in your home directory with a dev script, so if you clone a repo you don't trust, visiting its URL executes its code. Don't register what you wouldn't run by hand.
- Privilege escalation. There is no privilege to escalate; no component runs as root.

## Reporting

Use GitHub's private vulnerability reporting on this repository, or mail bnbitar@gmail.com. There is no bounty program.
