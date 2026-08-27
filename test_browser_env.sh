#!/usr/bin/env bash
# Regression test for the browser/fontconfig setup.
#
# Chromium's renderer aborts in Skia (SkFontMgr_FontConfigInterface "Not
# implemented") on hosts with no fontconfig config (e.g. Ubuntu + home-manager,
# where /etc/fonts does not exist). The flake ships `packages.browser-env` with
# a fonts.conf pointing at dejavu + noto fonts, and the agent services export
# FONTCONFIG_FILE pointing at it.
#
# Usage: ./test_browser_env.sh [path-to-browser-env]
#   (defaults to a `nix build .#packages.x86_64-linux.browser-env` result)
set -euo pipefail

cd "$(dirname "$0")"

BROWSER_ENV_DIR="${1:-}"
if [ -z "$BROWSER_ENV_DIR" ]; then
  echo "building browser-env..."
  BROWSER_ENV_DIR=$(nix build .#packages.x86_64-linux.browser-env --print-out-paths)
fi

FONTS_CONF="$BROWSER_ENV_DIR/fonts.conf"
BROWSER_BIN="${WEB_BROWSE_BROWSER_BIN:-chromium}"

echo "using fonts.conf: $FONTS_CONF"
echo "using browser:    $BROWSER_BIN"

if [ ! -f "$FONTS_CONF" ]; then
  echo "FAIL: $FONTS_CONF not found" >&2
  exit 1
fi

PROFILE=$(mktemp -d)
OUT=$(mktemp)
trap 'rm -rf "$PROFILE" "$OUT"' EXIT

env FONTCONFIG_FILE="$FONTS_CONF" "$BROWSER_BIN" \
  --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --dump-dom "data:text/html,<html><body><script>document.body.textContent='render-ok-'+(2+2)</script></body></html>" \
  > "$OUT" 2>/dev/null

if grep -q "render-ok-4" "$OUT"; then
  echo "PASS: chromium rendered a JS page with the shipped fontconfig env"
else
  echo "FAIL: chromium did not render the JS page (renderer crash? fonts missing?)" >&2
  exit 1
fi
