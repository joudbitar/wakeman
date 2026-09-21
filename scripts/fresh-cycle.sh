#!/bin/bash
# fresh-cycle.sh — wipe lazydev off this machine and reinstall it from this
# checkout, verifying every trace on the way down and every promise on the way
# up. Each run writes full transcripts (raw ANSI + stripped) into
# logs/cycles/<stamp>/ so a reviewer can judge the exact screens a new user saw.
#
#   scripts/fresh-cycle.sh            uninstall → verify clean → install → verify up
#   scripts/fresh-cycle.sh --pty      same, but drive the install through a pty so
#                                     the consent prompt, spinner, and picker render
#                                     as they would for a human
#   scripts/fresh-cycle.sh --down     just uninstall + verify clean (leave it off)
#
# The machine ends installed (unless --down). Never run this on a machine whose
# registry you care about without a backup — uninstall deletes the state dir.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${LAZYDEV_STATE_DIR:-$HOME/.local/state/lazydev}"
PLIST="$HOME/Library/LaunchAgents/com.lazydev.proxy.plist"
CLI_LINK="$HOME/.local/bin/lazydev"
SKILL="$HOME/.claude/skills/add-project"
LABEL="gui/$(id -u)/com.lazydev.proxy"
STAMP="$(date +%Y%m%d-%H%M%S)"
CYCLE_DIR="$ROOT/logs/cycles/$STAMP"
mkdir -p "$CYCLE_DIR"

PTY=0
DOWN_ONLY=0
for a in "$@"; do
  case "$a" in
    --pty) PTY=1 ;;
    --down) DOWN_ONLY=1 ;;
    *) echo "usage: fresh-cycle.sh [--pty] [--down]" >&2; exit 2 ;;
  esac
done

FAILS=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILS=$((FAILS+1)); }

# Run a step, tee raw output to <name>.raw and an ANSI-stripped copy to
# <name>.txt, record duration and exit code.
step() {
  local name="$1"; shift
  local t0 t1 rc
  t0=$(date +%s)
  ( "$@" ) >"$CYCLE_DIR/$name.raw" 2>&1
  rc=$?
  t1=$(date +%s)
  perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g; s/\r/\n/g' "$CYCLE_DIR/$name.raw" >"$CYCLE_DIR/$name.txt"
  printf '%s exit=%d duration=%ds\n' "$name" "$rc" "$((t1 - t0))" >>"$CYCLE_DIR/steps.log"
  return $rc
}

http_code() { # http_code <host> — status of GET / with that Host header
  curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Host: $1" http://127.0.0.1/ 2>/dev/null
}

echo "cycle $STAMP — transcripts in ${CYCLE_DIR#$ROOT/}"

# ---------------------------------------------------------------- uninstall --
echo "down:"
step uninstall node "$ROOT/bin/lazydev.mjs" uninstall
[ ! -e "$STATE" ]            && pass "state dir gone" || fail "state dir still at $STATE"
[ ! -e "$PLIST" ]            && pass "plist gone" || fail "plist still at $PLIST"
[ ! -e "$CLI_LINK" ]         && pass "cli symlink gone" || fail "symlink still at $CLI_LINK"
[ ! -e "$SKILL" ]            && pass "add-project skill gone" || fail "skill still at $SKILL"
launchctl print "$LABEL" >/dev/null 2>&1 && fail "launchd job still loaded" || pass "launchd job gone"
sleep 2
[ ! -e "$STATE" ]            && pass "state dir stayed gone (no zombie writer)" || fail "state dir came back after uninstall"
code=$(http_code lazydev.localhost)
[ "$code" = "000" ] && pass "nothing answers on :80" || fail ":80 still answers ($code)"

if [ "$DOWN_ONLY" = 1 ]; then
  echo "down only; lazydev is now absent. summary: $FAILS failures"
  exit $((FAILS > 0))
fi

# ------------------------------------------------------------------ install --
echo "up:"
if [ "$PTY" = 1 ]; then
  # A pty makes isTTY true, so the real first-run screens render: consent
  # prompt, picker, spinner. Feed: y (consent), wait for the scan, enter
  # (confirm the picker's default selection).
  step install-pty sh -c "{ printf 'y\n'; sleep 25; printf '\n'; sleep 5; } | script -q /dev/null node '$ROOT/bin/lazydev.mjs'"
else
  # Explicit `install` works without a tty: no consent prompt (that is the
  # documented non-interactive contract), scan registers what it can prove.
  step install node "$ROOT/bin/lazydev.mjs" install
fi

[ -f "$STATE/projects.json" ] && pass "registry written" || fail "no registry at $STATE/projects.json"
[ -f "$PLIST" ]               && pass "plist written" || fail "no plist"
[ -L "$CLI_LINK" ]            && pass "cli symlink placed" || fail "no cli symlink"
launchctl print "$LABEL" 2>/dev/null | grep -q 'state = running' && pass "launchd job running" || fail "launchd job not running"

code=$(http_code lazydev.localhost)
[ "$code" = "200" ] && pass "dashboard answers 200" || fail "dashboard answered $code"
code=$(http_code no-such-project.localhost)
[ "$code" = "404" ] && pass "unknown host answers 404" || fail "unknown host answered $code"

# -------------------------------------------------------- day-two commands --
echo "day two:"
step rerun node "$ROOT/bin/lazydev.mjs"            # rescan against a live daemon
step logs-none node "$ROOT/bin/lazydev.mjs" logs
step logs-daemon node "$ROOT/bin/lazydev.mjs" logs daemon
step unknown-cmd node "$ROOT/bin/lazydev.mjs" frobnicate
grep -q 'unknown command' "$CYCLE_DIR/unknown-cmd.txt" && pass "unknown command explains itself" || fail "unknown command output is off"

echo "done: $FAILS failures — transcripts in ${CYCLE_DIR#$ROOT/}"
exit $((FAILS > 0))
