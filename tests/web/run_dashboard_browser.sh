#!/bin/bash
# Browser test of the owner dashboard against the TEST server (never the real FMD on :8090/:8443).
# Serves server/web/dist through the test container (tests/web/docker-compose.web.yml, only
# quitfind-test is recreated), starts headless Firefox (own temporary profile, UI language nl,
# at most 2500 MB) and runs tests/web/dashboard_browser.mjs. Build the web UI first:
#   cd server/web && npx --offline corepack pnpm run build
# Usage: tests/web/run_dashboard_browser.sh [baseUrl]   (screenshot: SHOT_DIR=/some/dir)
set -euo pipefail
cd "$(dirname "$0")/../.."
BASE=${1:-http://127.0.0.1:8096}
case "$BASE" in *:8090*|*:8443*|*debian.*) echo "weiger: dat is de echte FMD-server" >&2; exit 2 ;; esac
[ -f server/web/dist/index.html ] || { echo "server/web/dist ontbreekt: eerst de web-UI bouwen" >&2; exit 2; }

docker compose -f test-instance/docker-compose.yml -f tests/web/docker-compose.web.yml up -d
for i in $(seq 1 30); do curl -sf "$BASE/version" >/dev/null && break; sleep 1; done

export BIDI_PORT=${BIDI_PORT:-9334}
T=$(mktemp -d); mkdir -p "$T/profiel"
echo 'user_pref("intl.accept_languages", "nl");' > "$T/profiel/user.js"
FF=
cleanup() { [ -n "$FF" ] && kill "$FF" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 nice -n 10 \
  firefox-esr --headless --no-remote -profile "$T/profiel" --remote-debugging-port "$BIDI_PORT" about:blank \
  >/dev/null 2>&1 & FF=$!
for i in $(seq 1 30); do (echo > "/dev/tcp/127.0.0.1/$BIDI_PORT") 2>/dev/null && break; sleep 1; done
node tests/web/dashboard_browser.mjs "$BASE"
