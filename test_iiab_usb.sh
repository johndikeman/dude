#!/usr/bin/env bash
# tests for scripts/iiab-usb-download.sh (pure helpers + plan flow with shims)
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/scripts/iiab-usb-download.sh"
TMP="$(mktemp -d)"
SHIM="$TMP/bin"
mkdir -p "$SHIM"

pass=0; fail=0
check() { # check <name> <cmd...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass+1)); echo "ok - $name";
  else fail=$((fail+1)); echo "FAIL - $name"; fi
}
check_ne() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then fail=$((fail+1)); echo "FAIL - $name";
  else pass=$((pass+1)); echo "ok - $name"; fi
}

# source without running main
bash -c "source '$SCRIPT'; type size_to_mb >/dev/null" 2>/dev/null

# --- size_to_mb -------------------------------------------------------------
source "$SCRIPT"
check "6.5G -> 6656mb"  test "$(size_to_mb 6.5G)" = 6656
check "104M -> 104mb"   test "$(size_to_mb 104M)" = 104
check "512K -> 0mb"     test "$(size_to_mb 512K)" = 1
check "3T -> mb"        test "$(size_to_mb 3T)" = 3145728

# --- parse_manifest ---------------------------------------------------------
MAN="$TMP/m.txt"
cat > "$MAN" <<'EOF'
# comment line
2;200;b;http://x/b.zim

1;50;a;http://x/a.zim
3;-;c;http://x/c.zim
EOF
check "manifest sorted by priority" test "$(parse_manifest "$MAN" | head -1)" = "1;50;a;http://x/a.zim"
check "manifest drops comments" test "$(parse_manifest "$MAN" | wc -l)" = 3

# --- list_usb_devices (fake lsblk) ------------------------------------------
cat > "$SHIM/lsblk" <<'EOF'
#!/usr/bin/env bash
cat <<'TBL'
sda   0  75G disk /
sdb   1  32G disk
sr0   1   1G rom  /media/cdrom
sdc   1   0G disk
TBL
EOF
chmod +x "$SHIM/lsblk"
PATH="$SHIM:/usr/bin:/bin" bash -c "source '$SCRIPT'; list_usb_devices" > "$TMP/devs.txt"
check "removable unmounted disks only, root+mounted excluded" \
  test "$(tail -1 "$TMP/devs.txt")" = "32G /dev/sdb" && \
  test "$(grep -c 'sda\|sr0' "$TMP/devs.txt")" = 0

# --- dry-run plan: budget skip + skip-already-present ------------------------
TARGET="$TMP/target"; mkdir -p "$TARGET"
cat > "$TMP/plan.txt" <<EOF
1;900;a;http://fake/a.zim
2;200;b;http://fake/b.zim
3;-;c;http://fake/c.zim
EOF
assert_contains() { # assert_contains <name> <haystack> <needle>
  local name="$1" hay="$2" needle="$3"
  if printf '%s\n' "$hay" | grep -qF "$needle"; then
    pass=$((pass+1)); echo "ok - $name"
  else
    fail=$((fail+1)); echo "FAIL - $name (missing: $needle)"; echo "$hay" | head -5
  fi
}

OUT="$(bash "$SCRIPT" --dir "$TARGET" --manifest "$TMP/plan.txt" --budget 1 --dry-run 2>&1)" \
  || { echo "$OUT"; exit 1; }
assert_contains "a planned first" "$OUT" "would download: a.zim"
assert_contains "b skipped over budget" "$OUT" "skip (over budget): b.zim"
assert_contains "c planned (no size)" "$OUT" "would download: c.zim"
check "manifest copied to target" test -f "$TARGET/iiab-content/MANIFEST"
check "nothing downloaded in dry-run" test ! -f "$TARGET/iiab-content/a.zim"

# rerun with a.zim already in place -> skipped
touch "$TARGET/iiab-content/a.zim"
OUT2="$(bash "$SCRIPT" --dir "$TARGET" --manifest "$TMP/plan.txt" --dry-run 2>&1)"
assert_contains "present file skipped" "$OUT2" "skip (already present): a.zim"

# --- download flow with fake curl -------------------------------------------
cat > "$SHIM/curl" <<'EOF'
#!/usr/bin/env bash
# fake curl: support -sIL (HEAD -> content-length 100mb) and -fL -C - -o FILE URL
while [ $# -gt 0 ]; do
  case "$1" in
    -sIL)
      shift 2
      printf 'HTTP/2 200\r\ncontent-length: 104857600\r\n\r\n'
      exit 0 ;;
    -fL) shift ;;
    -C) shift 2 ;;
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
head -c 104857600 /dev/zero > "$out"
EOF
chmod +x "$SHIM/curl"
T2="$TMP/target2"; mkdir -p "$T2"
PATH="$SHIM:/usr/bin:/bin" bash "$SCRIPT" --dir "$T2" --manifest "$TMP/plan.txt" >/dev/null 2>&1
check "download lands in iiab-content" test -f "$T2/iiab-content/a.zim"
check "download is full size" test "$(stat -c %s "$T2/iiab-content/a.zim")" = 104857600
check "staging cleaned up" test ! -e "$T2/.iiab-staging"

# truncated download must die
cat > "$SHIM/curl" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -sIL) shift 2; printf 'HTTP/2 200\r\ncontent-length: 104857600\r\n\r\n'; exit 0 ;;
    -fL) shift ;;
    -C) shift 2 ;;
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
head -c 10485760 /dev/zero > "$out"   # 10% of expected
EOF
chmod +x "$SHIM/curl"
T3="$TMP/target3"; mkdir -p "$T3"
check_ne "truncated download fails" env PATH="$SHIM:/usr/bin:/bin" bash "$SCRIPT" --dir "$T3" --manifest "$TMP/plan.txt"

rm -rf "$TMP"
echo "---- $pass passed, $fail failed"
[ "$fail" = 0 ]
