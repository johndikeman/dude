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
check "nothing written in dry-run" test ! -e "$TARGET/iiab-content"

# rerun with a.zim already in place -> skipped
mkdir -p "$TARGET/iiab-content"; touch "$TARGET/iiab-content/a.zim"
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
      printf 'HTTP/2 200\r\ncontent-length: 1048576\r\n\r\n'
      exit 0 ;;
    -fL) shift ;;
    -C) shift 2 ;;
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
head -c 1048576 /dev/zero > "$out"
EOF
chmod +x "$SHIM/curl"
T2="$TMP/target2"; mkdir -p "$T2"
PATH="$SHIM:/usr/bin:/bin" bash "$SCRIPT" --dir "$T2" --manifest "$TMP/plan.txt" >/dev/null 2>&1
check "download lands in iiab-content" test -f "$T2/iiab-content/a.zim"
check "download is full size" test "$(stat -c %s "$T2/iiab-content/a.zim")" = 1048576
check "staging cleaned up" test ! -e "$T2/.iiab-staging"

# truncated download must die
cat > "$SHIM/curl" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -sIL) shift 2; printf 'HTTP/2 200\r\ncontent-length: 1048576\r\n\r\n'; exit 0 ;;
    -fL) shift ;;
    -C) shift 2 ;;
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
head -c 104857 /dev/zero > "$out"   # 10% of expected
EOF
chmod +x "$SHIM/curl"
T3="$TMP/target3"; mkdir -p "$T3"
check_ne "truncated download fails" env PATH="$SHIM:/usr/bin:/bin" bash "$SCRIPT" --dir "$T3" --manifest "$TMP/plan.txt"

# --- format step -------------------------------------------------------------
# fake mkfs: records invocations, must exist for command -v via PATH shim
cat > "$SHIM/mkfs.ext4" <<'EOF'
#!/usr/bin/env bash
echo "mkfs.ext4 $*" >> "${MKFS_LOG:-/tmp/iiab-mkfs-unknown.log}"
exit 0
EOF
chmod +x "$SHIM/mkfs.ext4"
cat > "$SHIM/mount" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SHIM/mount"
# fake lsblk that knows a whole device (partition table + mountpoint query)
# arg-aware lsblk shim: disk enumeration + per-device column queries
cat > "$SHIM/lsblk" <<'EOF'
#!/usr/bin/env bash
shift 1 # drop -dn
[ "$1" = "-o" ] && shift
[ -n "${1:-}" ] || { echo "sdb   1  32G disk"; exit 0; } # device enum
[ -n "${2:-}" ] || exit 0                                # no device arg
asked="$1"; dev="$2"
# the fake device has one partition, unmounted
if [ "$asked" = "RM" ]; then echo 1
elif [ "$asked" = "SIZE" ]; then echo "32G"
elif [ "$asked" = "NAME,TYPE" ]; then echo "sdb1 part"
elif [ "$asked" = "MOUNTPOINT" ]; then echo ""
else echo "sdb1 part"
fi
EOF
chmod +x "$SHIM/lsblk"
export MKFS_LOG="$TMP/mkfs.log"
# non-interactive (no tty) + no --yes -> confirm() fails -> must abort before mkfs runs
check_ne "--format refuses without --yes" \
  env PATH="$SHIM:/usr/bin:/bin" bash "$SCRIPT" --device /dev/sdb --format --manifest "$TMP/plan.txt"
check_ne "refusal happens before mkfs" test -s "$TMP/mkfs.log"
# run format_drive directly (function-level) with --yes, fake mkfs/mount via PATH
run_format() { # run_format <fs>
  PATH="$SHIM:/usr/bin:/bin" FORMAT_FS="${1:-ext4}" DUDE_SCRIPT="$SCRIPT" \
    bash -c 'source "$DUDE_SCRIPT"; DRY_RUN=0; YES=1; format_drive /dev/sdb'
}
OUT3="$(run_format ext4 2>&1)" || { echo "$OUT3"; exit 1; }
check "mkfs invoked with -F on the device" grep -q 'mkfs.ext4 -F /dev/sdb' "$TMP/mkfs.log"
assert_contains "format logged" "$OUT3" "formatted /dev/sdb (ext4)"
# --format vfat honored
cat > "$SHIM/mkfs.vfat" <<'EOF'
#!/usr/bin/env bash
echo "mkfs.vfat $*" >> "${MKFS_LOG:-/tmp/iiab-mkfs-unknown.log}"
exit 0
EOF
chmod +x "$SHIM/mkfs.vfat"
OUT4="$(run_format vfat 2>&1)" || { echo "$OUT4"; exit 1; }
check "mkfs.vfat used when filesystem specified" grep -q 'mkfs.vfat -F /dev/sdb' "$TMP/mkfs.log"
# dry-run: plan mentions formatting, no mkfs call
BEFORE="$(wc -l < "$TMP/mkfs.log")"
OUT5="$(env PATH="$SHIM:/usr/bin:/bin" bash "$SCRIPT" --device /dev/sdb --format --manifest "$TMP/plan.txt" --dry-run 2>&1)"
assert_contains "dry-run announces format" "$OUT5" "would format /dev/sdb as ext4"
check "dry-run does not run mkfs" test "$(wc -l < "$TMP/mkfs.log")" = "$BEFORE"

rm -rf "$TMP"
echo "---- $pass passed, $fail failed"
[ "$fail" = 0 ]
