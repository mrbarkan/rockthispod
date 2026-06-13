#!/bin/bash
# Repair a 5.5G iPod Video (2048-byte logical sectors) whose partition table
# was corrupted by a hand-written 512-unit MBR, then install Rockbox.
#
# The real Apple firmware still lives at device block 63 (byte 129024) — where
# the old APM Apple_MDFW partition was. This script:
#   1. Verifies the Apple firmware signature is really there (aborts if not)
#   2. Writes a correct MBR in 2048-byte units (p1=firmware@63, p2=FAT32@81983)
#   3. Formats the data partition FAT32
#   4. Patches the Rockbox bootloader into the firmware with stock ipodpatcher
#   5. Extracts the Rockbox build onto the FAT32 volume
#
# Must run as root. Expects the MBR image + tools next to this script.
set -euo pipefail

LOGFILE=/tmp/ipod-repair.log
exec > >(tee -a "$LOGFILE") 2>&1
echo "===== repair run: $(date) ====="
trap 'echo "[REPAIR][TRACE] aborted at line $LINENO (exit $?)"' ERR

DISK="${1:-disk5}"
DIR="$(cd "$(dirname "$0")" && pwd)"
MBR="$DIR/repair-mbr-2048.bin"
IPODPATCHER="$DIR/bin/ipodpatcher"
BL_URL="https://download.rockbox.org/bootloader/ipod/bootloader-ipodvideo.ipod"
RB_URL="https://build.rockbox.org/data/rockbox-ipodvideo.zip"
BL="/tmp/bootloader-ipodvideo.ipod"
RB="/tmp/rockbox-ipodvideo.zip"

log() { echo "[REPAIR] $*"; }
die() { echo "[REPAIR][FATAL] $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Run as root (sudo)."
[ -f "$MBR" ] || die "MBR image missing: $MBR"
[ -x "$IPODPATCHER" ] || die "ipodpatcher missing: $IPODPATCHER"

# --- Gate 1: device identity ---
INFO=$(diskutil info "$DISK") || die "diskutil info $DISK failed - is the iPod connected?"
echo "$INFO" | grep -q "Media Type:.*iPod" || die "$DISK is not an iPod. Refusing to touch it."
echo "$INFO" | grep -q "Device Block Size: *2048 Bytes" || die "$DISK does not report 2048-byte blocks."
echo "$INFO" | grep -q "exactly 374472704 512-Byte-Units" || die "Disk size mismatch - MBR image was built for a different device."
log "Device identity OK: $DISK is the 2048-byte-sector iPod this MBR was built for."

# --- Gate 2: real Apple firmware must still be at block 63 ---
FWSEC=/tmp/ipod-fw-sector.bin
rm -f "$FWSEC"
dd if="/dev/r$DISK" of="$FWSEC" bs=2048 skip=63 count=1 || die "Raw read of block 63 failed."
SIG=$(dd if="$FWSEC" bs=1 count=4 2>/dev/null)
[ "$SIG" = "{{~~" ] || die "Apple firmware signature not found at block 63 (got '$SIG'). Restore the iPod with Finder first, then re-run the installer app."
DIRMAGIC=$(dd if="$FWSEC" bs=1 skip=256 count=4 2>/dev/null)
[ "$DIRMAGIC" = "]ih[" ] || die "Firmware directory magic missing at block 63 (got '$DIRMAGIC'). Restore with Finder first."
log "Real Apple firmware confirmed intact at block 63."

# --- Downloads (before any write, so we can abort cleanly if offline) ---
log "Downloading Rockbox bootloader and build..."
curl -fsSL -o "$BL" "$BL_URL" || die "Bootloader download failed."
curl -fsSL -o "$RB" "$RB_URL" || die "Rockbox build download failed."
log "Downloads complete ($(stat -f%z "$BL") + $(stat -f%z "$RB") bytes)."

# --- Write the corrected MBR ---
log "Unmounting $DISK..."
diskutil unmountDisk force "/dev/$DISK" >/dev/null
log "Writing corrected MBR (2048-byte units)..."
dd if="$MBR" of="/dev/r$DISK" bs=2048 count=1 2>/dev/null || die "MBR write failed."

# --- Wait for the kernel to re-read the partition table ---
log "Waiting for macOS to pick up the new partition table..."
OK=""
for i in $(seq 1 20); do
  if diskutil info "${DISK}s2" 2>/dev/null | grep -q "Partition Offset: *167901184 Bytes"; then OK=1; break; fi
  sleep 1
done
[ -n "$OK" ] || die "Kernel did not re-read the partition table. Unplug and reconnect the iPod, then re-run this script."
log "New partition table active (data partition at block 81983)."

# --- Format the data partition ---
diskutil unmountDisk force "/dev/$DISK" >/dev/null 2>&1 || true
log "Formatting data partition FAT32..."
newfs_msdos -F 32 -v IPOD "/dev/r${DISK}s2" >/dev/null || die "FAT32 format failed."
log "FAT32 format complete."

# --- Install the bootloader into the real Apple firmware ---
diskutil unmountDisk force "/dev/$DISK" >/dev/null 2>&1 || true
log "Patching Rockbox bootloader into Apple firmware (ipodpatcher)..."
PATCH_OUT=$("$IPODPATCHER" "/dev/$DISK" --add-bootloader "$BL" 2>&1) || die "ipodpatcher exited with an error: $PATCH_OUT"
echo "$PATCH_OUT" | sed 's/^/[ipodpatcher] /'
if echo "$PATCH_OUT" | grep -q '\[ERR\]'; then
  die "ipodpatcher reported an error - aborting before touching anything else."
fi
"$IPODPATCHER" "/dev/$DISK" --list 2>&1 | sed 's/^/[ipodpatcher] /' || true

# --- Extract the Rockbox build ---
log "Mounting data partition..."
diskutil mount "${DISK}s2" >/dev/null || die "Could not mount ${DISK}s2."
MP=$(diskutil info "${DISK}s2" | sed -n 's/.*Mount Point: *//p')
[ -d "$MP" ] || die "Mount point not found."
log "Extracting Rockbox build to $MP ..."
unzip -oq "$RB" -d "$MP" || die "Extraction failed."
chflags nohidden "$MP/.rockbox" 2>/dev/null || true
log "Rockbox files installed."

log "DONE. Eject the iPod, unplug it, then hold MENU+SELECT ~6s to reboot."
log "It should show the Rockbox bootloader, then start Rockbox."
