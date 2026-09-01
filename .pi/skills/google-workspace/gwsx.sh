#!/usr/bin/env bash
# gwsx.sh — thin wrapper around Google's `gws` CLI (@googleworkspace/cli).
#
# responsibilities:
#   1. make sure the gws binary exists at $GWS_BIN (download latest release if not)
#   2. plumb oauth credentials: $GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE env var,
#      or ~/.config/gws/credentials.json, or 1password item "gws credentials"
#      (field "credential") in vault AI, exported to a temp file per invocation.
#   3. exec gws with all passed args.
#
# overridable for tests:
#   GWS_BIN              path to gws binary        (default ~/bin/gws)
#   GWS_OP               1password binary          (default op)
#   GWS_OP_ITEM          1password item reference  (default op://AI/gws credentials/credential)
#   GWS_CREDENTIALS_FILE local credentials file     (default ~/.config/gws/credentials.json)
#   GWS_SKIP_DOWNLOAD=1  don't auto-download binary (test mode)
#   GWS_CURL             curl binary override      (default curl)

set -euo pipefail

GWS_BIN="${GWS_BIN:-$HOME/bin/gws}"
GWS_CURL="${GWS_CURL:-curl}"
GWS_OP="${GWS_OP:-op}"
GWS_OP_ITEM="${GWS_OP_ITEM:-op://AI/gws credentials/credential}"
GWS_CREDENTIALS_FILE="${GWS_CREDENTIALS_FILE:-$HOME/.config/gws/credentials.json}"

ensure_binary() {
  if [[ -x "$GWS_BIN" ]]; then
    return 0
  fi
  if [[ "${GWS_SKIP_DOWNLOAD:-0}" == "1" ]]; then
    echo "error: gws binary not found at $GWS_BIN (GWS_SKIP_DOWNLOAD set)" >&2
    return 1
  fi
  local arch tarball_url tmpdir
  case "$(uname -m)" in
    x86_64) arch="x86_64-unknown-linux-gnu" ;;
    aarch64|arm64) arch="aarch64-unknown-linux-gnu" ;;
    *) echo "error: unsupported arch $(uname -m) for gws auto-download" >&2; return 1 ;;
  esac
  tarball_url="$($GWS_CURL -fsSL https://api.github.com/repos/googleworkspace/cli/releases/latest \
    | grep -o "https://[^\"]*google-workspace-cli-${arch}\.tar\.gz" | head -n1)"
  if [[ -z "$tarball_url" ]]; then
    echo "error: could not resolve latest gws release url" >&2
    return 1
  fi
  mkdir -p "$(dirname "$GWS_BIN")"
  tmpdir="$(mktemp -d)"
  "$GWS_CURL" -fsSL "$tarball_url" -o "$tmpdir/gws.tar.gz"
  tar xzf "$tmpdir/gws.tar.gz" -C "$tmpdir"
  mv "$tmpdir/gws" "$GWS_BIN"
  chmod +x "$GWS_BIN"
  rm -rf "$tmpdir"
}

ensure_credentials() {
  # 1. explicit env var wins (gws reads it natively)
  if [[ -n "${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:-}" ]]; then
    return 0
  fi
  # 2. local plaintext credentials file
  if [[ -f "$GWS_CREDENTIALS_FILE" ]]; then
    export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE="$GWS_CREDENTIALS_FILE"
    return 0
  fi
  # 3. 1password item -> temp file
  if command -v "$GWS_OP" >/dev/null 2>&1; then
    local tmp
    tmp="$(mktemp)"
    if "$GWS_OP" read "$GWS_OP_ITEM" > "$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
      chmod 600 "$tmp"
      export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE="$tmp"
      # clean up on exit so credentials don't linger
      trap 'rm -f "$tmp"' EXIT
      return 0
    fi
    rm -f "$tmp"
  fi
  cat >&2 <<'EOF'
error: no gws credentials found.

set up one of:
  1. export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/credentials.json
     (run `gws auth login` then `gws auth export --unmasked` on a machine with a browser)
  2. put credentials json in 1password vault AI, item "gws credentials", field "credential"
  3. place the file at ~/.config/gws/credentials.json

see SKILL.md for the full setup guide.
EOF
  return 1
}

main() {
  ensure_binary
  if [[ $# -gt 0 && ( "$1" == "help" || "$1" == "--help" || "$1" == "-h" ) ]]; then
    echo "usage: gwsx.sh [gws args...]"
    echo "wrapper that ensures the gws binary + credentials are present, then execs gws."
    exit 0
  fi
  ensure_credentials
  exec "$GWS_BIN" "$@"
}

main "$@"
