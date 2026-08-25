#!/usr/bin/env bash
# Unit test for obsidian-sync resilience changes in flake.nix
set -euo pipefail

FLAKE_NIX="${1:-./flake.nix}"

echo "=== checking obsidian sync resilience in $FLAKE_NIX ==="

# check 1: login script clears the old auth token before login
if ! grep -q 'rm -f "\$AUTH_TOKEN_FILE"' "$FLAKE_NIX"; then
  echo "FAIL: obLoginScript does not clear stale auth token"
  exit 1
fi
echo "PASS: obLoginScript clears stale auth token"

# check 2: login script targets the correct file path
if ! grep -q 'obsidian-headless/auth_token' "$FLAKE_NIX"; then
  echo "FAIL: obLoginScript does not target auth_token file"
  exit 1
fi
echo "PASS: obLoginScript targets correct auth_token path"

# check 3: runtimeMaxSec option exists under obsidianSync
if ! grep -q 'runtimeMaxSec = lib.mkOption' "$FLAKE_NIX"; then
  echo "FAIL: runtimeMaxSec option not found"
  exit 1
fi
echo "PASS: runtimeMaxSec option is defined"

# check 4: RuntimeMaxSec is applied to the obsidian-sync service
if ! grep -q 'RuntimeMaxSec = cfg.obsidianSync.runtimeMaxSec' "$FLAKE_NIX"; then
  echo "FAIL: RuntimeMaxSec not applied to obsidian-sync service"
  exit 1
fi
echo "PASS: RuntimeMaxSec applied to obsidian-sync service"

# check 5: default value is reasonable (30m)
if ! grep -A3 'runtimeMaxSec = lib.mkOption' "$FLAKE_NIX" | grep -q 'default = "30m"'; then
  echo "FAIL: runtimeMaxSec default is not '30m'"
  exit 1
fi
echo "PASS: runtimeMaxSec defaults to 30m"

echo "=== all resilience checks passed ==="
