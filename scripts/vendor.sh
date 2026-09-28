#!/bin/bash
# vendor.sh — refetch the xterm.js files the dashboard's terminal panel serves.
#
#   scripts/vendor.sh            refetch the pinned versions below
#   scripts/vendor.sh --check    re-hash what is checked in, fetch nothing
#
# The panel loads xterm from /__wakeman/vendor/*, which is lib/vendor/ on disk.
# Those files are CHECKED IN on purpose: wakeman is a local proxy that has to
# work on a plane, and an npm runtime dependency would put an install step
# between a git pull and a working dashboard. The cost is about 300 KB in the
# package (spec 0.3.0 section 6).
#
# Nothing here runs at install time or at runtime. Run it by hand when a version
# below moves, commit what changed, and check the panel still draws.

set -euo pipefail

# The pinned pair. addon-fit 0.10.0 is the last release whose peer range is
# @xterm/xterm ^5.0.0; 0.11 wants xterm 6.
XTERM_VERSION="5.5.0"
FIT_VERSION="0.10.0"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/lib/vendor"
REGISTRY="https://registry.npmjs.org"

# short name | package | version | path inside the tarball | file we write
WANT="xterm|@xterm/xterm|$XTERM_VERSION|lib/xterm.js|xterm.js
xterm|@xterm/xterm|$XTERM_VERSION|css/xterm.css|xterm.css
addon-fit|@xterm/addon-fit|$FIT_VERSION|lib/addon-fit.js|addon-fit.js"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

if [ "${1:-}" = "--check" ]; then
  status=0
  while IFS='|' read -r _short pkg version _member out; do
    if [ ! -s "$DEST/$out" ]; then
      echo "missing: lib/vendor/$out ($pkg@$version) — run scripts/vendor.sh"
      status=1
      continue
    fi
    echo "ok: lib/vendor/$out  sha256:$(sha "$DEST/$out")  $pkg@$version"
  done <<< "$WANT"
  exit $status
fi

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# One tarball per package, not one per file: two fetches, and both files of a
# pair provably come from the same published build. Each unpacks into package/,
# so it is renamed to its short name before the next one lands on top of it.
for spec in "xterm|@xterm/xterm|$XTERM_VERSION" "addon-fit|@xterm/addon-fit|$FIT_VERSION"; do
  IFS='|' read -r short pkg version <<< "$spec"
  echo "fetching $pkg@$version"
  curl -fsSL --max-time 60 "$REGISTRY/$pkg/-/$short-$version.tgz" -o "$TMP/$short.tgz"
  tar -xzf "$TMP/$short.tgz" -C "$TMP"
  mv "$TMP/package" "$TMP/$short"
done

{
  echo "# Written by scripts/vendor.sh. Do not edit by hand."
  echo "# Fetched $(date -u '+%Y-%m-%d %H:%M:%SZ') from $REGISTRY"
  echo
} > "$TMP/VERSIONS"

while IFS='|' read -r short pkg version member out; do
  src="$TMP/$short/$member"
  [ -s "$src" ] || { echo "not in the tarball: $member ($pkg@$version)" >&2; exit 1; }
  cp "$src" "$DEST/$out"
  echo "$pkg@$version  $member  ->  lib/vendor/$out  sha256:$(sha "$DEST/$out")" >> "$TMP/VERSIONS"
done <<< "$WANT"

cp "$TMP/VERSIONS" "$DEST/VERSIONS"
echo
cat "$DEST/VERSIONS"
echo "wrote $(du -sh "$DEST" | cut -f1) into lib/vendor/ — commit it, then reload the dashboard."
