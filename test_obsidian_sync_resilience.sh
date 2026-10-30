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

# check 6: sync-setup is conditional (skip when vault already configured)
if ! grep -q 'ensureSyncSetupScript' "$FLAKE_NIX"; then
  echo "FAIL: ensureSyncSetupScript wrapper not found (sync-setup re-runs on every restart)"
  exit 1
fi
echo "PASS: ensureSyncSetupScript wrapper exists"

# check 7: wrapper must gate on sync-status (exit code), not run unconditionally
if ! grep -q 'ob sync-status' "$FLAKE_NIX"; then
  echo "FAIL: sync-setup wrapper does not check sync-status before setup"
  exit 1
fi
echo "PASS: sync-setup gated on ob sync-status"

# check 8: no unit ExecStartPre runs raw sync-setup anymore
if grep -qE 'ob sync-setup --vault' "$FLAKE_NIX"; then
  echo "FAIL: raw sync-setup still present in an ExecStartPre"
  exit 1
fi
echo "PASS: no raw sync-setup in ExecStartPre"

echo "=== all resilience checks passed ==="
