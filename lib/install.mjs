// lazydev persistent-install helpers — the pure half of "one command installs".
//
// The npx entrypoint (bin/lazydev.mjs) is the only install path: it scans,
// copies the app into the state dir, writes a launchd plist, and loads it.
// Everything here is pure (strings in, strings out) so the plist shape, the
// launchd PATH assembly, and the Caddyfile cleanup are testable without
// touching launchctl or the filesystem. The impure orchestration lives in
// bin/lazydev.mjs.

// The one launchd label lazydev has ever used. Reusing it means an npx install
// on a machine with the old checkout install REPLACES the agent instead of
// fighting it — one lazydev per machine.
export const LAUNCHD_LABEL = 'com.lazydev.proxy';

export function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// Assemble the PATH a launchd-spawned daemon needs. launchd hands processes a
// minimal PATH, but the daemon spawns whatever start command each project
// registered — pnpm, uv, cargo, docker, anything — so the only PATH that is
// guaranteed to resolve every one of them is the PATH of the shell the user
// installed from, in the SAME order. Order is load-bearing, not cosmetic: a
// machine can hold two copies of a tool (say a broken pnpm in /usr/local/bin
// and a working one in ~/.npm-global/bin), and the user's ordering is the one
// that picks the copy their shell has been using all along. So the inherited
// PATH leads verbatim; node's own dir and the standard dirs are appended only
// as a net for entries the inherited PATH is missing.
//
// Inherited entries are dropped when they are not absolute (meaningless under
// launchd) or were injected by the npx run itself (node_modules/.bin and the
// npx cache — those dirs vanish when the cache is pruned).
// The tools the daemon will actually spawn, extracted from the registry: the
// first token of every enabled project's startCmd. Only bare command names
// come back — a token with a slash (`bin/rails`, `.venv/bin/python`) is
// project-relative and only resolvable from that project's cwd, and anything
// with shell metacharacters is not a name to hand back to a shell. The
// install preflights each of these under the exact PATH being baked into the
// plist, because a binary that is broken THERE fails silently at request time
// — the daemon crash-loops it while the browser waits out a timeout.
export function toolsToVerify(projects) {
  const tools = new Set();
  for (const p of projects || []) {
    if (!p || p.enabled === false || typeof p.startCmd !== 'string') continue;
    const first = p.startCmd.trim().split(/\s+/)[0];
    if (!first || first.includes('/')) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(first)) continue;
    tools.add(first);
  }
  return [...tools].sort();
}

export function assembleLaunchdPath({ userPath = '', nodeDir = '', home }) {
  const inherited = String(userPath).split(':').filter((d) =>
    d.startsWith('/') && !d.endsWith('/node_modules/.bin') && !d.includes('/_npx/'));
  const dirs = [
    ...inherited,
    nodeDir,
    `${home}/Library/pnpm`,
    `${home}/.local/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.join(':');
}

// Render the LaunchAgent plist. The daemon is started from the app copy inside
// the state dir, with LAZYDEV_STATE_DIR pinned so registry, logs, and control
// token all land in ONE directory, and LAZYDEV_PORT=80 so it serves the front
// door directly (wildcard bind + loopback guard, ADR 0002). If something else
// owns :80 — including a legacy Caddy install, which keeps proxying
// *.localhost to :4000 — the daemon's own bind fallback lands it on the
// fallback port and everything still works.
export function renderPlist({
  label = LAUNCHD_LABEL,
  nodeBin,
  daemonPath,
  workDir,
  stateDir,
  logsDir,
  home,
  pathEnv,
  frontPort = 80,
  fallbackPort = 4000,
  devWatch = false,
}) {
  const e = escapeXml;
  // Checkout installs run the repo directly and the daemon exits when its
  // source changes (LAZYDEV_WATCH_SOURCE); KeepAlive brings it back with the
  // new code. ThrottleInterval 1 keeps that restart snappy — launchd's default
  // 10s gap would turn every edit into a ten-second wait.
  const devEnv = devWatch
    ? `
        <key>LAZYDEV_WATCH_SOURCE</key>
        <string>1</string>`
    : '';
  const devThrottle = devWatch
    ? `
    <key>ThrottleInterval</key>
    <integer>1</integer>
`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${e(label)}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${e(nodeBin)}</string>
        <string>${e(daemonPath)}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>
${devThrottle}
    <key>WorkingDirectory</key>
    <string>${e(workDir)}</string>

    <key>StandardOutPath</key>
    <string>${e(logsDir)}/daemon.out</string>

    <key>StandardErrorPath</key>
    <string>${e(logsDir)}/daemon.err</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${e(home)}</string>
        <key>PATH</key>
        <string>${e(pathEnv)}</string>
        <key>LAZYDEV_STATE_DIR</key>
        <string>${e(stateDir)}</string>
        <key>LAZYDEV_PORT</key>
        <string>${e(String(frontPort))}</string>
        <key>LAZYDEV_FALLBACK_PORT</key>
        <string>${e(String(fallbackPort))}</string>${devEnv}
    </dict>
</dict>
</plist>
`;
}

// The pid launchd reports for a job, or null when the text names none (the job
// is loaded but not running, or the label is unknown). `launchctl print
// gui/<uid>/<label>` prints one `pid = 1234` line for a live job. Uninstall
// reads this BEFORE it boots the job out, because once the label leaves the
// domain nothing is left to name the process that is still winding down.
export function parseLaunchdPid(printOutput) {
  const m = String(printOutput ?? '').match(/^[ \t]*pid[ \t]*=[ \t]*(\d+)[ \t]*$/m);
  return m ? Number(m[1]) : null;
}

// Poll `isAlive` until it says the thing is gone, or until timeoutMs is spent.
// Returns true when the exit was observed, false on timeout — the caller
// decides what a timeout means. The clock and the sleep are injected, so the
// uninstall wait is testable without launchctl, a real process, or real time.
export async function waitForExit({
  isAlive,
  timeoutMs = 5_000,
  intervalMs = 100,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (!(await isAlive())) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

// Pull the WorkingDirectory out of a launchd plist. The pre-ADR-0003 install
// ran the daemon from its checkout, with projects.json in that directory; the
// plist is the one durable pointer to where that was. Used by the installer to
// migrate the old registry (hand-added entries can't be rediscovered by a
// scan) into the state dir. Returns null when the text has no such key.
export function extractWorkingDirectory(plistText) {
  const m = String(plistText).match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
  return m ? m[1] : null;
}

// Remove the lazydev-managed block from a Caddyfile's text. Handles both the
// sentinel form the last installer wrote (between the >>> and <<< marker
// lines) and the legacy form (a `# Managed by lazydev` comment through the
// following closing `}`). Returns { text, changed } and never touches other
// sites in the file. Used by `lazydev uninstall` to clean a machine that was
// installed the old Caddy way.
export function stripCaddyBlock(text) {
  const lines = String(text).split('\n');
  const out = [];
  let inSentinel = false;
  let inLegacy = false;
  let changed = false;
  for (const line of lines) {
    if (/^# >>> lazydev managed block >>>/.test(line)) {
      inSentinel = true;
      changed = true;
      continue;
    }
    if (inSentinel) {
      if (/^# <<< lazydev managed block <<</.test(line)) inSentinel = false;
      continue;
    }
    if (/^# Managed by lazydev/.test(line)) {
      inLegacy = true;
      changed = true;
      continue;
    }
    if (inLegacy) {
      if (/^}/.test(line)) inLegacy = false;
      continue;
    }
    out.push(line);
  }
  return { text: out.join('\n'), changed };
}
