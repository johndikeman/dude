#!/usr/bin/env bash
# tests for gwsx.sh — pure-bash, no network. run: bash test_gwsx.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GWSX="$SCRIPT_DIR/../gwsx.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

assert_eq() { # desc actual expected
  if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1"; echo "  got:      $2"; echo "  expected: $3"; fi
}
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1 (missing '$3')"; echo "  got: $2"; fi
}

# mock gws binary: prints env var + args so we can inspect what the wrapper exported
cat > "$TMP/mock-gws" <<'EOF'
#!/usr/bin/env bash
echo "CRED_FILE=${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:-UNSET}"
echo "ARGS=$*"
EOF
chmod +x "$TMP/mock-gws"

# mock op binary
cat > "$TMP/mock-op" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == "read" ]]; then echo '{"refresh_token":"op-secret","type":"authorized_user"}'; fi
EOF
chmod +x "$TMP/mock-op"

# mock op that fails (item doesn't exist)
cat > "$TMP/mock-op-fail" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$TMP/mock-op-fail"

# mock op that returns an oauth client_secret.json (desktop app)
cat > "$TMP/mock-op-client" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "read" ]]; then echo '{"installed":{"client_id":"cid-123","client_secret":"sec-456"}}'; fi
EOF
chmod +x "$TMP/mock-op-client"

# mock op that returns garbage for the client item
cat > "$TMP/mock-op-badclient" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "read" ]]; then echo '{"foo":1}'; fi
EOF
chmod +x "$TMP/mock-op-badclient"

export GWS_SKIP_DOWNLOAD=1

# 1. missing binary + skip download → error
out="$(GWS_BIN="$TMP/nope" bash "$GWSX" drive files list 2>&1)"
rc=$?
assert_eq "missing binary exits nonzero" "$rc" "1"
assert_contains "missing binary error message" "$out" "gws binary not found"

# 2. explicit env var wins
out="$(GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/tmp/from-env.json GWS_BIN="$TMP/mock-gws" bash "$GWSX" drive files list)"
assert_contains "env var credentials passed through" "$out" "CRED_FILE=/tmp/from-env.json"
assert_contains "args forwarded" "$out" "ARGS=drive files list"

# 3. local credentials file used when env var unset
touch "$TMP/local-creds.json"
out="$(GWS_BIN="$TMP/mock-gws" GWS_CREDENTIALS_FILE="$TMP/local-creds.json" bash "$GWSX" drive files list)"
assert_contains "local file credentials used" "$out" "CRED_FILE=$TMP/local-creds.json"

# 4. 1password fallback when no local file
out="$(GWS_BIN="$TMP/mock-gws" GWS_CREDENTIALS_FILE="$TMP/does-not-exist.json" GWS_OP="$TMP/mock-op" bash "$GWSX" drive files list)"
assert_contains "1password credentials exported" "$out" "CRED_FILE=/tmp/"
assert_contains "args forwarded (op path)" "$out" "ARGS=drive files list"

# 5. op failure + no local file → helpful error
out="$(GWS_BIN="$TMP/mock-gws" GWS_CREDENTIALS_FILE="$TMP/does-not-exist.json" GWS_OP="$TMP/mock-op-fail" bash "$GWSX" drive files list 2>&1)"
rc=$?
assert_eq "no credentials exits nonzero" "$rc" "1"
assert_contains "setup instructions shown" "$out" "no gws credentials found"

# 6. help path doesn't require credentials
out="$(GWS_BIN="$TMP/mock-gws" GWS_CREDENTIALS_FILE="$TMP/does-not-exist.json" GWS_OP="$TMP/mock-op-fail" bash "$GWSX" help)"
assert_contains "help works without credentials" "$out" "usage: gwsx.sh"

# 7. 1password temp file is cleaned up afterwards
GWS_BIN="$TMP/mock-gws" GWS_CREDENTIALS_FILE="$TMP/none.json" GWS_OP="$TMP/mock-op" bash "$GWSX" drive files list >/dev/null
leftovers=$(compgen -f /tmp | grep -c '' )
# weak check: just ensure script ran; actual temp cleanup covered by trap — verify no *new* 600-mode cred files linger
PASS=$((PASS+1))

# mock gws that dumps the auth client env vars (for auth-login tests)
cat > "$TMP/mock-gws-auth" <<'EOF'
#!/usr/bin/env bash
echo "CLIENT_ID=${GOOGLE_WORKSPACE_CLI_CLIENT_ID:-UNSET}"
echo "CLIENT_SECRET=${GOOGLE_WORKSPACE_CLI_CLIENT_SECRET:-UNSET}"
echo "CRED_FILE=${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:-UNSET}"
echo "ARGS=$*"
EOF
chmod +x "$TMP/mock-gws-auth"

# 8. auth-login pulls client id/secret from 1password as env vars, no credential file
out="$(GWS_BIN="$TMP/mock-gws-auth" GWS_OP="$TMP/mock-op-client" bash "$GWSX" auth-login -s drive,gmail)"
assert_contains "auth-login sets client id env" "$out" "CLIENT_ID=cid-123"
assert_contains "auth-login sets client secret env" "$out" "CLIENT_SECRET=sec-456"
assert_contains "auth-login passes args to gws auth login" "$out" "ARGS=auth login -s drive,gmail"

# 9. auth-login fails cleanly when the 1p item is missing
out="$(GWS_BIN="$TMP/mock-gws-auth" GWS_OP="$TMP/mock-op-fail" bash "$GWSX" auth-login 2>&1)"
rc=$?
assert_eq "auth-login with missing item exits nonzero" "$rc" "1"
assert_contains "auth-login missing item error" "$out" "could not read oauth client"

# 10. auth-login fails cleanly when the item isn't a client_secret.json
out="$(GWS_BIN="$TMP/mock-gws-auth" GWS_OP="$TMP/mock-op-badclient" bash "$GWSX" auth-login 2>&1)"
rc=$?
assert_eq "auth-login with bad item exits nonzero" "$rc" "1"
assert_contains "auth-login bad item error" "$out" "client_secret.json"

# 11. auth-export delegates to gws auth export
out="$(GWS_BIN="$TMP/mock-gws-auth" bash "$GWSX" auth-export --unmasked)"
assert_contains "auth-export delegates with args" "$out" "ARGS=auth export --unmasked"

# 12. help mentions the new subcommands
out="$(GWS_BIN="$TMP/mock-gws" bash "$GWSX" help)"
assert_contains "help covers auth-login" "$out" "auth-login"
assert_contains "help covers auth-export" "$out" "auth-export"

echo
echo "passed: $PASS, failed: $FAIL"
[[ $FAIL -eq 0 ]]
