// wakeman front-door bind decisions — the pure half of "which port do we serve
// on, and how do we print the URLs".
//
// The daemon serves the front door directly (no Caddy), binding the wildcard
// address with loopback-only enforced per connection (ADR 0002). One rule on
// every platform: :80, and when the OS refuses it (Linux without
// CAP_NET_BIND_SERVICE gets EACCES; EADDRINUSE means something already holds
// the port), the numbered fallback port. URLs are printed WITH the port
// whenever we are not on :80, so the printed URLs are the ones that work.
//
// Pure: no net, no fs, no side effects. The caller catches the real bind error
// and asks decideBindFallback what to do next.

// The bind error codes that trigger a fallback to the numbered port. EACCES:
// privileged port with no capability (Linux npx). EADDRINUSE: the port is taken.
const FALLBACK_CODES = new Set(['EACCES', 'EADDRINUSE']);

// Given the port we tried and the error code we got binding it, decide whether
// to fall back and to what.
//
//   attemptedPort   the port we just failed to bind (e.g. 80)
//   errorCode       the error's .code (e.g. 'EACCES', 'EADDRINUSE')
//   fallbackPort    the numbered port to retry on (default 4000)
//
// Returns:
//   { fallback: false }                              -> not a fallback-eligible
//                                                       error; caller handles it
//   { fallback: true, port, includePort }            -> retry on `port`;
//                                                       includePort is whether
//                                                       printed URLs must carry
//                                                       the :port suffix
//
// includePort is true whenever we are not serving on 80 — the front-door port is
// the only one a browser reaches without a suffix (http://name.localhost).
export function decideBindFallback({ attemptedPort, errorCode, fallbackPort = 4000 }) {
  if (!FALLBACK_CODES.has(errorCode)) return { fallback: false };
  // A same-port EADDRINUSE (fallback == attempted) is not recoverable by falling
  // back to the same number; report no fallback so the caller surfaces it.
  if (fallbackPort === attemptedPort) return { fallback: false };
  return { fallback: true, port: fallbackPort, includePort: fallbackPort !== 80 };
}

// Whether a URL printed for `port` needs the :port suffix. Port 80 is the
// front-door default a browser reaches with no suffix; anything else must be
// shown so the user copies a URL that works.
export function includePortForUrl(port) {
  return port !== 80;
}

// Format a project's front-door URL. host is the project host key (no
// `.localhost`), port the port the daemon is actually serving on.
//   formatProjectUrl('webapp', 80)   -> 'http://webapp.localhost'
//   formatProjectUrl('webapp', 7420) -> 'http://webapp.localhost:7420'
export function formatProjectUrl(host, port) {
  return includePortForUrl(port)
    ? `http://${host}.localhost:${port}`
    : `http://${host}.localhost`;
}
