# ADR 0002: wildcard bind with a per-connection loopback guard

Status: accepted (2026-07-22). Supersedes the npx bind decision in ADR 0001.

## Context

ADR 0001 kept the daemon loopback-only: try `127.0.0.1:80`, and when the OS
refuses, fall back to a numbered port. On macOS the OS always refuses — EACCES
for a specific loopback address on :80 to any non-root process — so the
fallback was not an edge case, it was every macOS run. Every URL carried
`:4000`, and `http://name.localhost` with no port never worked. That was the
first complaint from real use.

A first fix kept loopback as the preferred bind and added the wildcard as a
retry after the EACCES. That shape is wrong too: a flow whose first step is
guaranteed to fail on the primary platform is a fallback chain pretending to
be a design.

The reason ADR 0001 rejected the wildcard bind was exposure: `0.0.0.0:80`
accepts connections from the LAN. But the accepted macOS install already
answers this — Caddy binds `0.0.0.0:80` and refuses non-loopback clients with
a `remote_ip` matcher. The daemon has an equivalent check of its own: since
issue #2, `handleRequest` and `handleUpgrade` return 403 for any request that
did not arrive on a loopback address, precisely so a mistaken bind cannot
expose a dev server. The security model never depended on the bind address
alone.

## Decision

One bind rule, every platform, no OS detection:

1. Bind the wildcard address on the front-door port.
2. If the OS refuses (EACCES: Linux without `CAP_NET_BIND_SERVICE`;
   EADDRINUSE: something owns the port), bind the wildcard address on the
   numbered fallback port and say so in one line.

Every listener gets two guards, layered:

- at accept: a connection whose remote address is not loopback is destroyed
  before a byte is read;
- at request/upgrade: the existing fail-closed 403 stays.

The wildcard bind is dual-stack, which also deletes the old best-effort
separate `::1` listener.

## Consequences

- `npx wakeman` on macOS serves portless URLs: `http://portfolio.localhost`
  works with nothing installed, first try, no retries. Linux without the
  capability lands on `:4000`, and the banner says so.
- A LAN port scan sees the port open. A connection there is closed at accept
  with no response. This is the same posture as the accepted Caddy front
  door, enforced one layer lower.
- The daemon renders every URL (dashboard links, status JSON, log lines) from
  the port in the request's own Host header — whatever port reached us is a
  port that works — falling back to the bound port. A `:4000` run gets
  working links, and behind the installed Caddy the links stay portless.
- `decideBindFallback` in `lib/bind.mjs` stays the one pure bind decision;
  the daemon and the npx port probe both use it.
