// wakeman persistent-install helpers — the pure half of "one command installs".
//
// The npx entrypoint (bin/wakeman.mjs) is the only install path: it scans,
// copies the app into the state dir, writes the service file (a launchd plist
// on macOS, a systemd user unit on Linux), and loads it. Everything here is
// pure (strings in, strings out) so the plist and unit shapes, the service
// PATH assembly, and the Caddyfile cleanup are testable without touching
// launchctl, systemctl or the filesystem. The impure orchestration lives in
// bin/wakeman.mjs.

// The launchd label. Reusing it means a reinstall REPLACES the agent instead
// of fighting it — one wakeman per machine.
export const LAUNCHD_LABEL = 'com.wakeman.proxy';

// The systemd unit name, same reasoning: one unit, replaced in place.
export const SYSTEMD_UNIT = 'wakeman.service';

// Before 0.3.0 wakeman was called lazydev, and a machine installed back then
// still has an agent under this label, state in a `lazydev` dir, and a
// `lazydev` command on PATH. The install takes the old agent down (two
// daemons would fight over :80) and carries the registry across.
export const LEGACY_NAME = 'lazydev';
export const LEGACY_LAUNCHD_LABEL = 'com.lazydev.proxy';

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

// The net itself differs per OS: where pnpm, Homebrew and the user's own bin
// land on a Mac is not where they land on Linux (Linuxbrew has one fixed
// prefix, pnpm follows XDG, snaps have their own dir). The ordering rule above
// is the same on both.
const NET_DIRS = {
  darwin: (home) => [
    `${home}/Library/pnpm`,
    `${home}/.local/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ],
  linux: (home) => [
    `${home}/.local/share/pnpm`,
    `${home}/.local/bin`,
    '/home/linuxbrew/.linuxbrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/snap/bin',
    '/usr/local/sbin',
    '/usr/sbin',
    '/sbin',
  ],
};

export function assembleServicePath({ userPath = '', nodeDir = '', home, platform = 'darwin' }) {
  const inherited = String(userPath).split(':').filter((d) =>
    d.startsWith('/') && !d.endsWith('/node_modules/.bin') && !d.includes('/_npx/'));
  const net = NET_DIRS[platform] || NET_DIRS.darwin;
  const dirs = [...inherited, nodeDir, ...net(home)];
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.join(':');
}

// The macOS name, kept: the plist tests and the daemon's copy pin this output.
export function assembleLaunchdPath(opts) {
  return assembleServicePath({ ...opts, platform: 'darwin' });
}

// Render the LaunchAgent plist. The daemon is started from the app copy inside
// the state dir, with WAKEMAN_STATE_DIR pinned so registry, logs, and control
// token all land in ONE directory, and WAKEMAN_PORT=80 so it serves the front
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
  // source changes (WAKEMAN_WATCH_SOURCE); KeepAlive brings it back with the
  // new code. ThrottleInterval 1 keeps that restart snappy — launchd's default
  // 10s gap would turn every edit into a ten-second wait.
  const devEnv = devWatch
    ? `
        <key>WAKEMAN_WATCH_SOURCE</key>
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
        <key>WAKEMAN_STATE_DIR</key>
        <string>${e(stateDir)}</string>
        <key>WAKEMAN_PORT</key>
        <string>${e(String(frontPort))}</string>
        <key>WAKEMAN_FALLBACK_PORT</key>
        <string>${e(String(fallbackPort))}</string>${devEnv}
    </dict>
</dict>
</plist>
`;
}

// systemd reads `%` as the start of a specifier (%h, %U ...) in every path and
// command setting, so a literal one is doubled. This is the only escape a bare
// path setting (WorkingDirectory=, append:) gets: those take the rest of the
// line as-is, and quoting them would put the quotes in the path.
export function escapeUnitPath(s) {
  return String(s).replaceAll('%', '%%');
}

// One word for a setting systemd splits on whitespace (ExecStart=,
// Environment=): double-quoted, with the C escapes systemd unquotes on read.
// ExecStart additionally expands `$VAR`, so a literal dollar is doubled there;
// Environment= never expands, and doubling it would land in the value.
export function quoteUnitWord(s, { exec = false } = {}) {
  let w = escapeUnitPath(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  if (exec) w = w.replaceAll('$', () => '$$'); // a function, since `$$` in a replacement string means one `$`
  return `"${w}"`;
}

// Render the systemd user unit, the Linux twin of renderPlist: same inputs,
// same environment, same intent (start on login, come back after any exit).
// Restart=always is KeepAlive; RestartSec is ThrottleInterval, and drops to 1s
// on a checkout install for the same reason. StartLimitIntervalSec=0 turns off
// systemd's start rate limit, which would otherwise give up on the daemon after
// five restarts in ten seconds (five quick saves in a checkout would do it);
// launchd never gives up, and neither should this. WantedBy=default.target is
// what makes a user unit start with the login session, and only then: no
// linger, so the daemon is exactly as alive as the user's session.
export function renderUnit({
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
  const env = (k, v) => `Environment=${quoteUnitWord(`${k}=${v}`)}`;
  const envLines = [
    env('HOME', home),
    env('PATH', pathEnv),
    env('WAKEMAN_STATE_DIR', stateDir),
    env('WAKEMAN_PORT', String(frontPort)),
    env('WAKEMAN_FALLBACK_PORT', String(fallbackPort)),
    ...(devWatch ? [env('WAKEMAN_WATCH_SOURCE', '1')] : []),
  ];
  return `[Unit]
Description=wakeman: on-demand dev-server proxy for *.localhost
StartLimitIntervalSec=0

[Service]
ExecStart=${quoteUnitWord(nodeBin, { exec: true })} ${quoteUnitWord(daemonPath, { exec: true })}
WorkingDirectory=${escapeUnitPath(workDir)}
${envLines.join('\n')}
Restart=always
RestartSec=${devWatch ? 1 : 2}
StandardOutput=append:${escapeUnitPath(logsDir)}/daemon.out
StandardError=append:${escapeUnitPath(logsDir)}/daemon.err

[Install]
WantedBy=default.target
`;
}

// Split a systemd word list (the right side of ExecStart= or Environment=) the
// way systemd does: whitespace separates, double quotes group and take the C
// escapes quoteUnitWord writes, single quotes group literally. `%%` folds back
// to `%`. Enough to read back what renderUnit wrote plus a hand edit.
export function splitUnitWords(s) {
  const words = [];
  let cur = null;
  let quote = null;
  const chars = String(s);
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && i + 1 < chars.length) { cur += chars[++i]; continue; }
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      if (cur === null) cur = '';
    } else if (/\s/.test(c)) {
      if (cur !== null) { words.push(cur); cur = null; }
    } else {
      cur = (cur ?? '') + c;
    }
  }
  if (cur !== null) words.push(cur);
  return words.map((w) => w.replaceAll('%%', '%'));
}

// The Environment= a unit sets, as a Map. Later lines win, like systemd.
export function unitEnvironment(unitText) {
  const env = new Map();
  for (const line of String(unitText).split('\n')) {
    const m = line.match(/^\s*Environment=(.*)$/);
    if (!m) continue;
    for (const word of splitUnitWords(m[1])) {
      const eq = word.indexOf('=');
      if (eq > 0) env.set(word.slice(0, eq), word.slice(eq + 1));
    }
  }
  return env;
}

// Does this unit start `daemonPath`? The Linux half of "is the installed
// service already running THIS checkout".
export function unitRunsDaemon(unitText, daemonPath) {
  for (const line of String(unitText).split('\n')) {
    const m = line.match(/^\s*ExecStart=(.*)$/);
    if (m && splitUnitWords(m[1]).includes(daemonPath)) return true;
  }
  return false;
}

// The pid systemd reports for the unit, or null when it is not running.
// `systemctl --user show -p MainPID --value wakeman.service` prints the bare
// number, and `0` for a unit that is loaded but has no process; without
// `--value` it prints `MainPID=1234`, which is accepted too. Read BEFORE the
// stop, for the same reason as parseLaunchdPid.
export function parseSystemdMainPid(showOutput) {
  const m = String(showOutput ?? '').match(/^\s*(?:MainPID=)?(\d+)\s*$/m);
  const pid = m ? Number(m[1]) : 0;
  return pid > 0 ? pid : null;
}

// The file the "~/.local/bin is not on your PATH" hint tells the user to
// append to. macOS opens every terminal tab as a login shell, so bash reads
// ~/.bash_profile there; a Linux terminal is an interactive non-login shell,
// which reads ~/.bashrc. zsh reads ~/.zshrc on both.
export function pathHintRc({ shell = '', platform = 'darwin' } = {}) {
  if (!/bash$/.test(shell)) return '~/.zshrc';
  return platform === 'linux' ? '~/.bashrc' : '~/.bash_profile';
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

// Where a lazydev-era registry could be, best first: the old state dir, then
// (the pre-ADR-0003 checkout install) next to the old checkout, which the old
// plist's WorkingDirectory names. Never the current state dir itself.
export function legacyRegistryCandidates({ legacyStateDir, legacyPlistText = '', stateDir }) {
  const dirs = [legacyStateDir, extractWorkingDirectory(legacyPlistText)];
  return [...new Set(dirs.filter((d) => d && d !== stateDir))].map((d) => `${d}/projects.json`);
}

// Remove the managed block from a Caddyfile's text (written back when wakeman
// was lazydev and sat behind Caddy, hence the name in the markers). Handles both the
// sentinel form the last installer wrote (between the >>> and <<< marker
// lines) and the legacy form (a `# Managed by lazydev` comment through the
// following closing `}`). Returns { text, changed } and never touches other
// sites in the file. Used by `wakeman uninstall` to clean a machine that was
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
