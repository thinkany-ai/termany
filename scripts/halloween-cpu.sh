#!/bin/bash
# Idle CPU of the packaged macOS app: default theme vs Halloween (docs/halloween/cpu.md).
#
#   bash scripts/halloween-cpu.sh            # rested: measure after the scene rests
#   bash scripts/halloween-cpu.sh --active   # animating: keep the pointer moving over the window
#
# Each variant is a release .app with its own bundle identifier, its own HOME
# (a temp dir) and its server on port 5184, so the installed Termany and its
# server on 5174 are never touched. The port and default-theme patches are
# applied only to clean files and reverted right after the build.
#
# You MUST keep the test window in front and uncovered while it measures:
# macOS stops rendering a covered WebView, which would make the number
# meaningless.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=rested
[ "${1:-}" = "--active" ] && MODE=active
LIB=apps/desktop/src-tauri/src/lib.rs
THEMES=apps/web/src/themes/index.ts
git diff --quiet -- "$LIB" "$THEMES" || { echo "$LIB or $THEMES has local changes; commit or stash them first"; exit 1; }
HOME_DIR=$(mktemp -d)
BUNDLE=apps/desktop/src-tauri/target/release/bundle/macos

webkit_pids() {
  for n in com.apple.WebKit.WebContent com.apple.WebKit.GPU com.apple.WebKit.Networking; do pgrep -x "$n" || true; done | sort
}

# Sum of the CPU time (s) of a set of pids.
cputime() {
  ps -o time= -p "$1" | awk '{
    n = split($1, d, "-"); t = (n == 2) ? d[2] : d[1]; days = (n == 2) ? d[1] : 0
    m = split(t, p, ":"); s = 0; for (i = 1; i <= m; i++) s = s * 60 + p[i]
    total += s + days * 86400 } END { printf "%.2f", total }'
}

build() { # theme name
  local theme=$1 name=$2
  sed -i '' 's/^const SERVER_PORT: u16 = 5174;/const SERVER_PORT: u16 = 5184;/' "$LIB"
  sed -i '' "s/^export const DEFAULT_THEME_ID = \"codex\";/export const DEFAULT_THEME_ID = \"$theme\";/" "$THEMES"
  trap 'git restore --source=HEAD -- "$LIB" "$THEMES"' EXIT
  VITE_API_URL=http://localhost:5184 npm run build:web >/dev/null
  npm run bundle:server >/dev/null
  npm -w @termany/desktop run tauri -- build --bundles app --no-sign \
    --config "{\"identifier\":\"ai.termany.cpu-$name\",\"productName\":\"TermanyCpu$name\",\"bundle\":{\"createUpdaterArtifacts\":false}}" >/dev/null
  git restore --source=HEAD -- "$LIB" "$THEMES"
  trap - EXIT
}

measure() { # name label
  local name=$1 label=$2 before after pid pids t0 t1 c0 c1
  before=$(webkit_pids)
  env HOME="$HOME_DIR" TERMANY_PORT=5184 "$BUNDLE/TermanyCpu$name.app/Contents/MacOS/app" >/dev/null 2>&1 &
  sleep 10
  after=$(webkit_pids)
  pid=$(pgrep -f "TermanyCpu$name.app/Contents/MacOS/app" | head -1)
  pids=$( (echo "$pid"; pgrep -P "$pid" || true; comm -13 <(echo "$before") <(echo "$after")) | grep . | paste -sd, -)
  if [ "$MODE" = active ]; then
    read -r -p "Bring the $label window to the front, then press Enter and keep moving the pointer over it for 60 s. "
    sleep 2
  else
    read -r -p "Bring the $label window to the front and leave it alone; press Enter. "
    echo "Waiting 40 s for the scene to rest..."; sleep 40
  fi
  t0=$(date +%s); c0=$(cputime "$pids"); sleep 60; c1=$(cputime "$pids"); t1=$(date +%s)
  awk -v a="$c0" -v b="$c1" -v t="$((t1 - t0))" -v l="$label" 'BEGIN { printf "%s: %.2f%% of one core over %d s\n", l, 100 * (b - a) / t, t }'
  kill "$pid"
  sleep 2
}

echo "Building the two variants (a few minutes)..."
build codex Base
build halloween Halloween
measure Base "default theme ($MODE)"
measure Halloween "Halloween ($MODE)"
# The test server outlives the app by design; stop it.
kill "$(lsof -nP -iTCP:5184 -sTCP:LISTEN -t)" 2>/dev/null || true
echo "Test data left in $HOME_DIR and ~/Library/{WebKit,Caches}/ai.termany.cpu-* (safe to delete)."
