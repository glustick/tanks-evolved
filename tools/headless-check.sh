#!/usr/bin/env bash
#
# tools/headless-check.sh — load the game in real (headless) Chrome twice and
# fail on any page-level console error.
#
#   mode 1: index.html        — the interactive page, animation loop running
#   mode 2: index.html#selftest — the in-page assertion suite (16 checks)
#
# Usage:   tools/headless-check.sh [path-to-chrome]
# Env:     CHROME=/path/to/chrome   BUDGET=<virtual-time-budget-ms>
#
# Exit codes: 0 = clean, 1 = console error / self-test failure, 2 = no browser.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
URL_ROOT="file://$ROOT/index.html"
BUDGET="${BUDGET:-20000}"

# Locate a Chromium-family browser.
find_chrome() {
  local candidates=(
    "${CHROME:-}"
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    "$(command -v google-chrome 2>/dev/null || true)"
    "$(command -v chromium 2>/dev/null || true)"
    "$(command -v chromium-browser 2>/dev/null || true)"
  )
  for candidate in "${candidates[@]}"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

CHROME_BIN="$(find_chrome)" || {
  echo "SKIP: no Chrome/Chromium found. Set CHROME=/path/to/chrome and retry."
  exit 2
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Chrome's own noise on macOS/headless is unrelated to the page under test.
NOISE='cv_display_link|task_policy_set|sqlite_persistent_store|FlushAndNotify|GPU|gpu_|VoiceTranscription|DEPRECATED_ENDPOINT|policy'

status=0
summary=()

run_mode() {
  local name="$1" url="$2" budget="$3"
  local err="$TMP/$name.err" dom="$TMP/$name.dom"

  echo "== $name =="
  echo "   $url"
  "$CHROME_BIN" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=1600,1000 --virtual-time-budget="$budget" \
    --enable-logging=stderr --v=0 --dump-dom "$url" >"$dom" 2>"$err"
  local rc=$?

  # Page-level console output (INFO:CONSOLE) pulled out of Chrome's stderr log.
  grep -E "INFO:CONSOLE|ERROR:CONSOLE|SEVERE" "$err" 2>/dev/null | grep -Ev "$NOISE" > "$TMP/$name.console" || true
  local console_lines
  console_lines="$(wc -l < "$TMP/$name.console" | tr -d ' ')"

  # Anything that looks like a real JS failure.
  local errors
  errors="$(grep -E "Uncaught|Unhandled|Unchecked runtime|SEVERE|ERROR:CONSOLE" "$TMP/$name.console" || true)"

  echo "   chrome exit $rc, $console_lines page console line(s)"

  if [ -n "$errors" ]; then
    echo "   FAIL console errors:"
    printf '     %s\n' "$errors"
    status=1
    summary+=("$name: CONSOLE ERRORS")
  else
    echo "   PASS no uncaught errors on the console"
    summary+=("$name: console clean")
  fi

  # The page must have actually booted: the HUD is populated by the game loop.
  if grep -q 'id="version-tag">v0\.' "$dom"; then
    echo "   PASS HUD booted (version tag rendered: $(grep -o 'id="version-tag">[^<]*' "$dom" | head -1 | sed 's/.*>//'))"
  else
    echo "   FAIL the HUD never rendered — the game did not boot"
    status=1
    summary+=("$name: NO BOOT")
  fi
  echo
}

echo "Tanks Evolved — headless browser check"
echo "browser: $CHROME_BIN"
echo

run_mode "interactive (animation loop)" "$URL_ROOT" "$BUDGET"
run_mode "self-test (#selftest)" "$URL_ROOT#selftest" "$BUDGET"

# The self-test must print its verdict.
SELFTEST_ERR="$TMP/self-test (#selftest).err"
if grep -q "SELFTEST PASS" "$SELFTEST_ERR" 2>/dev/null; then
  grep -E "checks passed" "$SELFTEST_ERR" | tail -1 | sed 's/^/   /'
  summary+=("selftest: PASS")
elif grep -q "SELFTEST FAIL" "$SELFTEST_ERR" 2>/dev/null; then
  echo "self-test reported FAIL:"
  sed -n '/Tanks Evolved self-test/,/SELFTEST FAIL/p' "$SELFTEST_ERR" | sed 's/^/   /'
  status=1
  summary+=("selftest: FAIL")
else
  echo "self-test produced no verdict (expected 'SELFTEST PASS' in the console)"
  status=1
  summary+=("selftest: NO VERDICT")
fi

echo
echo "---- summary ----"
for line in "${summary[@]}"; do echo "  $line"; done
echo
if [ "$status" -eq 0 ]; then
  echo "RESULT: PASS"
else
  echo "RESULT: FAIL"
fi
exit "$status"
