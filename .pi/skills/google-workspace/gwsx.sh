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
#   GWS_OP_CLIENT_ITEM   oauth client item ref     (default op://AI/gws oauth client secret/credential)
#   GWS_CREDENTIALS_FILE local credentials file     (default ~/.config/gws/credentials.json)
#   GWS_SKIP_DOWNLOAD=1  don't auto-download binary (test mode)
#   GWS_CURL             curl binary override      (default curl)

set -euo pipefail

GWS_BIN="${GWS_BIN:-$HOME/bin/gws}"
GWS_CURL="${GWS_CURL:-curl}"
GWS_OP="${GWS_OP:-op}"
GWS_OP_ITEM="${GWS_OP_ITEM:-op://AI/gws credentials/credential}"
GWS_CREDENTIALS_FILE="${GWS_CREDENTIALS_FILE:-$HOME/.config/gws/credentials.json}"
GWS_OP_CLIENT_ITEM="${GWS_OP_CLIENT_ITEM:-op://AI/gws oauth client secret/credential}"

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

# auth-login: run `gws auth login` using the oauth client pulled from 1password.
# gws natively supports GOOGLE_WORKSPACE_CLI_CLIENT_ID/CLIENT_SECRET env vars, so we
# never write a client_secret.json anywhere (john's feedback: keep secrets out of the
# home dir). gws listens on an auto-negotiated localhost port for the oauth redirect.
#
# on a headless vps the browser step has to happen somewhere that can reach this
# machine's localhost (e.g. ssh -L <port>:localhost:<port>), or run this same
# command on any machine with a browser + 1password and export from there.
auth_login() {
  ensure_binary
  if ! command -v "$GWS_OP" >/dev/null 2>&1; then
    echo "error: $GWS_OP not found; can't pull oauth client from 1password" >&2
    return 1
  fi
  local client_json client_id client_secret
  client_json="$("$GWS_OP" read "$GWS_OP_CLIENT_ITEM")" || {
    echo "error: could not read oauth client from 1password ($GWS_OP_CLIENT_ITEM)" >&2
    return 1
  }
  client_id="$(echo "$client_json" | jq -r '.installed.client_id // empty')"
  client_secret="$(echo "$client_json" | jq -r '.installed.client_secret // empty')"
  if [[ -z "$client_id" || -z "$client_secret" ]]; then
    echo "error: 1password item does not look like a desktop-app client_secret.json" >&2
    return 1
  fi
  export GOOGLE_WORKSPACE_CLI_CLIENT_ID="$client_id"
  export GOOGLE_WORKSPACE_CLI_CLIENT_SECRET="$client_secret"
  echo "==> starting gws auth login (oauth client from 1password, nothing written to ~)"
  echo "==> after login, run: gwsx.sh auth-export   (prints credentials for the 1p 'gws credentials' item)"
  "$GWS_BIN" auth login "$@"
}

# auth-export: print headless credentials (post-login) for pasting into 1password.
auth_export() {
  ensure_binary
  "$GWS_BIN" auth export --unmasked "$@"
}

main() {
  ensure_binary
  if [[ $# -gt 0 && ( "$1" == "help" || "$1" == "--help" || "$1" == "-h" ) ]]; then
    echo "usage: gwsx.sh [gws args...]"
    echo "       gwsx.sh auth-login [gws auth login args...]   oauth login w/ client from 1password"
    echo "       gwsx.sh auth-export [gws auth export args...] print headless credentials"
    echo "wrapper that ensures the gws binary + credentials are present, then execs gws."
    exit 0
  fi
  if [[ "${1:-}" == "auth-login" ]]; then
    shift
    auth_login "$@"
    return
  fi
  if [[ "${1:-}" == "auth-export" ]]; then
    shift
    auth_export "$@"
    return
  fi
  ensure_credentials
  exec "$GWS_BIN" "$@"
}

main "$@"
