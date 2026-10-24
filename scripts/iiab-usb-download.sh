#!/usr/bin/env bash
# iiab-usb-download.sh — download internet-in-a-box style content (kiwix zims)
# onto a connected usb drive, sized to fit a 32gb stick.
#
# internet-in-a-box (https://internet-in-a-box.org) content is mostly kiwix
# zim archives. this script curates a ~26gb english bundle (priority-ordered)
# and downloads it straight onto the drive, resuming partial downloads.
#
# usage:
#   ./iiab-usb-download.sh                     # auto-detect a usb drive, ask to confirm
#   ./iiab-usb-download.sh --device /dev/sdb   # explicit device (gets mounted)
#   ./iiab-usb-download.sh --dir /media/usb    # use an already-mounted dir, no mount needed
#   ./iiab-usb-download.sh --budget 32 --yes
#
# flags:
#   --device PATH    block device to mount (refuses non-removable disks)
#   --dir PATH       already-mounted directory to target instead
#   --budget GB      total content budget in gb (default: 30)
#   --manifest FILE  custom manifest (default: bundled manifest next to script)
#   --yes / -y       skip the confirmation prompt
#   --dry-run        show the plan, download nothing
#   --staging DIR    download staging dir inside the target (default: <target>/.iiab-staging)
#
# layout written to the drive:
#   <target>/iiab-content/<name>.zim    the archives (drop-in for kiwix/iiab)
#   <target>/iiab-content/MANIFEST      the manifest actually used
#   <target>/iiab-download.log          run log
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DEFAULT_MANIFEST="$SCRIPT_DIR/iiab-manifest.txt"
DEFAULT_BUDGET_GB=30

log() { echo "[iiab] $*"; }
die() { echo "[iiab] ERROR: $*" >&2; exit 1; }

# --- pure helpers (exported for tests) --------------------------------------

# kb/gb-ish si suffix -> mb, integer.
size_to_mb() {
  local s="$1"
  local n="${s%[a-zA-Z]*}" unit="${s: -1}"
  case "$unit" in
    K|k) n="$(awk "BEGIN{print $n/1024}")" ; unit=M ;;
  esac
  case "$unit" in
    M|m) awk -v n="$n" 'BEGIN{printf "%d", n+0.5}' ;;
    G|g) awk -v n="$n" 'BEGIN{printf "%d", n*1024+0.5}' ;;
    T|t) awk -v n="$n" 'BEGIN{printf "%d", n*1048576+0.5}' ;;
    *)   echo "$s" ;;
  esac
}

# manifest format: one entry per line, `#` comments ignored:
#   <priority>;<expected_mb|->;<category>;<url>
parse_manifest() {
  local file="$1"
  grep -vE '^\s*(#|$)' "$file" | sort -t';' -k1,1n
}

# list candidate usb block devices: removable disks only, never mounted `/`.
# requires lsblk.
list_usb_devices() {
  # mountpoint is last so an empty one doesn't shift the other columns
  lsblk -dn -o NAME,RM,SIZE,TYPE,MOUNTPOINT 2>/dev/null | awk '
    $2=="1" && $4=="disk" && ($5=="" || $5=="-") { print $3, "/dev/"$1 }
  ' | sort -h
}

# yes/no prompt, non-interactive friendly (default no).
confirm() {
  [ "${YES:-0}" = "1" ] && return 0
  [ ! -t 0 ] && return 1
  local reply
  read -r -p "$1 [y/N] " reply </dev/tty
  case "$reply" in y|Y|yes) return 0 ;; *) return 1 ;; esac
}

# expected remote size in mb via HEAD request (curl).
remote_size_mb() {
  local url="$1" len
  len="$(curl -sIL --max-time 30 "$url" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}' | tail -1)"
  [ -n "$len" ] || { echo ""; return 1; }
  awk -v b="$len" 'BEGIN{printf "%d", b/1048576+0.5}'
}

# --- plan + run -------------------------------------------------------------

print_usage() { grep '^#   ' "$SCRIPT_DIR/iiab-usb-download.sh" | head -14; }

main() {
  DEVICE=""; DIR=""; BUDGET_GB="$DEFAULT_BUDGET_GB"; MANIFEST="$DEFAULT_MANIFEST"
  YES="${IIAB_YES:-0}"; DRY_RUN=0
  STAGING=""
  TARGET=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --device)  DEVICE="$2"; shift 2 ;;
      --dir)     DIR="$2"; shift 2 ;;
      --budget)  BUDGET_GB="$2"; shift 2 ;;
      --manifest) MANIFEST="$2"; shift 2 ;;
      --staging) STAGING="$2"; shift 2 ;;
      --yes|-y)  YES=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h|--help) print_usage; exit 0 ;;
      *) die "unknown arg: $1 (see --help)" ;;
    esac
  done
  export YES

  [ -r "$MANIFEST" ] || die "manifest not readable: $MANIFEST"

  # resolve the target directory
  if [ -n "$DIR" ]; then
    mountpoint -q "$DIR" 2>/dev/null || [ -d "$DIR" ] || die "--dir $DIR does not exist"
    TARGET="$DIR"
  else
    if [ -n "$DEVICE" ]; then
      TARGET="$(mount_device "$DEVICE")"
    else
      # auto-detect: biggest removable unmounted disk
      mapfile -t candidates < <(list_usb_devices | awk '{print $2}')
      [ "${#candidates[@]}" -gt 0 ] || die "no connected usb drive found (pass --device or --dir)"
      DEVICE="${candidates[${#candidates[@]}-1]}"
      log "detected usb drive: $DEVICE ($(lsblk -dn -o SIZE "$DEVICE" 2>/dev/null | head -1))"
      confirm "use $DEVICE?" || die "aborted by user"
      TARGET="$(mount_device "$DEVICE")"
    fi
  fi
  log "target: $TARGET"

  STAGING="${STAGING:-$TARGET/.iiab-staging}"
  FINAL="$TARGET/iiab-content"
  mkdir -p "$STAGING" "$FINAL"

  LOG="$TARGET/iiab-download.log"
  plan_and_download | tee -a "$LOG"
}

mount_device() {
  local dev="$1"
  command -v mount >/dev/null 2>&1 || die "mount not available"
  # refuse the root device
  local rootdev
  rootdev="$(findmnt -n -o SOURCE / 2>/dev/null | sed 's/[0-9]*$//' || true)"
  [ "$dev" = "$rootdev" ] && die "refusing to touch the root device ($dev)"
  # refuse non-removable disks (mounted vps disk etc.)
  local rm_flag
  rm_flag="$(lsblk -dn -o RM "$dev" 2>/dev/null || echo 0)"
  [ "$rm_flag" = "1" ] || [ "${IIAB_ALLOW_FIXED:-0}" = "1" ] || die "$dev is not removable — refusing. export IIAB_ALLOW_FIXED=1 to override."

  TARGET="$dev"
  if [ "${DRY_RUN:-0}" = "1" ]; then echo "/mnt/iiab-usb (dry-run)"; return 0; fi
  local mnt=/mnt/iiab-usb
  [ -e "$mnt" ] || { sudo mkdir -p "$mnt" || mkdir -p "$mnt"; }
  sudo mount "$dev" "$mnt" 2>/dev/null || mount "$dev" "$mnt" || die "failed to mount $dev at $mnt"
  echo "$mnt"
}

plan_and_download() {
  local budget_mb
  budget_mb="$(size_to_mb "${BUDGET_GB}G")"
  log "budget: ${BUDGET_GB}gb  manifest: $MANIFEST  staging: $STAGING"

  cp "$MANIFEST" "$FINAL/MANIFEST"

  local total_planned=0 skipped=0 line prio size_mb cat url name expected_bytes mb_left
  mb_left="$budget_mb"

  while IFS=';' read -r prio size_mb cat url; do
    [ -n "$url" ] || continue
    name="$(basename "$url")"

    # already fully downloaded and moved into place?
    if [ -f "$FINAL/$name" ]; then
      log "skip (already present): $name"
      skipped=$((skipped+1))
      continue
    fi

    # remote size: trust the listing column in the manifest when '-' is absent,
    # else ask the server
    if [ "$size_mb" != "-" ] && [ -n "$size_mb" ]; then
      total_planned=$((total_planned + size_mb))
    fi

    # budget enforcement (manifest is priority-ordered)
    if [ "$size_mb" != "-" ] && [ "$size_mb" -gt "$mb_left" ]; then
      log "skip (over budget): $name needs ${size_mb}mb, ${mb_left}mb left"
      continue
    fi
    if [ "$DRY_RUN" = "1" ]; then
      log "would download: $name (${size_mb:-?}mb) [$cat]"
      if [ "$size_mb" != "-" ] && [ -n "$size_mb" ]; then mb_left=$((mb_left - size_mb)); fi
      continue
    fi

    # download (resumable) into staging, then move into final position
    local part="$STAGING/$name.part"
    log "downloading: $name (${size_mb:-?}mb) [$cat]"
    curl -fL -C - --retry 5 --retry-delay 10 --retry-all-errors -o "$part" "$url" \
      || die "download failed: $name"

    # verify size: authoritative = server content-length, fallback = manifest size
    local local_mb expected_mb
    local_mb="$(awk -v b="$(stat -c %s "$part")" 'BEGIN{printf "%d", b/1048576+0.5}')"
    expected_mb="$(remote_size_mb "$url" || true)"
    if [ -z "$expected_mb" ]; then expected_mb="$size_mb"; fi
    if [ "$expected_mb" != "-" ] && [ -n "$expected_mb" ] && [ "$local_mb" -lt $((expected_mb - expected_mb/20)) ]; then
      die "$name looks truncated ($local_mb vs expected ~${expected_mb}mb)"
    fi
    mv "$part" "$FINAL/$name"
    log "done: $name -> $FINAL/"
    if [ "$size_mb" != "-" ] && [ -n "$size_mb" ]; then mb_left=$((mb_left - size_mb)); fi
  done < <(parse_manifest "$MANIFEST")

  rm -rf "$STAGING"
  log "finished. content at: $FINAL/  ($(ls "$FINAL" 2>/dev/null | wc -l) files)"
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run: nothing was downloaded)"
  else
    log "to serve these: install kiwix (kiwix-serve) or run iiab and point \$content at $FINAL"
  fi
  return 0
}

# entrypoint guard so sourcing for tests doesn't execute main
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
