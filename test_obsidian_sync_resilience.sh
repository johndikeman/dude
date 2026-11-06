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

# check 9: each ob-login attempt is hard-capped so ExecStartPre fits inside
# TimeoutStartSec (2026-11-06: unbounded attempts during a 504 outage tripped
# the default 90s start-pre timeout and crash-looped dude-agent-watch)
if ! grep -qE '\$\{pkgs\.coreutils\}/bin/timeout 30' "$FLAKE_NIX"; then
  echo "FAIL: obLoginScript does not cap each attempt with timeout 30"
  exit 1
fi
echo "PASS: obLoginScript caps each attempt with timeout 30"

# check 10: dude-agent + dude-agent-watch treat ob login as graceful ("-"
# prefix): an obsidian auth outage must not prevent them from starting
if [ "$(grep -cE '"-\$\{obLoginScript\}"' "$FLAKE_NIX")" -lt 2 ]; then
  echo "FAIL: dude-agent/dude-agent-watch do not use a graceful ('-' prefixed) ob-login ExecStartPre"
  exit 1
fi
echo "PASS: dude-agent + dude-agent-watch use graceful ob-login"

# check 11: every ob-login-consuming unit sets an explicit TimeoutStartSec
# above the ~120s worst case of the retry loop
if [ "$(grep -c 'TimeoutStartSec = "5min"' "$FLAKE_NIX")" -lt 4 ]; then
  echo "FAIL: not all ob-login-consuming units set TimeoutStartSec = 5min"
  exit 1
fi
echo "PASS: all ob-login-consuming units set TimeoutStartSec"

# check 12: crash-looping units (watch + syncs) have a start limit that can
# actually trip during slow failure cycles, so the user manager's boot
# transaction can settle during an outage (2026-11-06: watch crash-looped
# every ~100s forever with 5-per-120s limits, holding the manager in
# "starting" for 3h47m, which made HM reloadSystemd skip daemon-reload)
if [ "$(grep -c 'StartLimitIntervalSec = "20min"' "$FLAKE_NIX")" -lt 3 ]; then
  echo "FAIL: watch + sync services lack a trippable StartLimitIntervalSec (20min)"
  exit 1
fi
echo "PASS: watch + sync services have a trippable start limit"

# check 13: checkDudeServices must daemon-reload itself (compensates HM's
# reloadSystemd skip while the manager reports "starting") and use
# --no-block restarts + a bounded poll so activation fits deploy-rs' window
if ! grep -qE '\$\{systemctl\} daemon-reload' "$FLAKE_NIX"; then
  echo "FAIL: checkDudeServices does not daemon-reload (stale units get activated when the manager is in 'starting')"
  exit 1
fi
if ! grep -q 'restart --no-block' "$FLAKE_NIX"; then
  echo "FAIL: checkDudeServices does not use --no-block restarts"
  exit 1
fi
echo "PASS: checkDudeServices reloads units and restarts without blocking"

echo "=== all resilience checks passed ==="
