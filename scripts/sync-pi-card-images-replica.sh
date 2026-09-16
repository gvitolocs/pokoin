#!/usr/bin/env bash
# Fill the 15T mybook replica from data already on nezopt, then optionally
# finish from the Pi over LAN rsync (not SSH).
#
# 15T dest is local: /home/nez/mnt/mybook/pokoin-pi-card-images
# Protocol:
#   1. rsync on this machine (NVMe leftover trees → mybook)
#   2. rsync://192.168.178.46/card-images/ when the Pi daemon is up
# SSH is login, not the copy protocol. Do not rsync 200k files over sshd.
set -euo pipefail

DEST="${DEST:-/home/nez/mnt/mybook/pokoin-pi-card-images}"
OBJECTS="$DEST/objects"
RSYNC_URL="${RSYNC_URL:-rsync://192.168.178.46/card-images/}"

LOCAL_SOURCES=(
  /home/nez/Projects/pokoin/PokoinTest/index/cdn_images
  /home/nez/Projects/pokoin/PokoinTest/index/cdn_images_delta
  /home/nez/pokoincdn/cdn_images_digest/2026-08-30
  /home/nez/pokoincdn/cdn_images_digest/2026-08-31-jpg
)

if [[ ! -d /home/nez/mnt/mybook ]]; then
  echo "15T mybook is not mounted at /home/nez/mnt/mybook" >&2
  exit 1
fi

mkdir -p "$OBJECTS" "$DEST/artcut"

rsync_leftovers() {
  local src=$1
  [[ -d "$src" ]] || return 0
  echo "local rsync $src -> $OBJECTS"
  rsync -a --ignore-existing --info=stats2 \
    --include='*/' \
    --include='*.jpg' \
    --include='*.jpeg' \
    --include='*_homepage.webp' \
    --exclude='*' \
    "$src"/ "$OBJECTS/"
}

for src in "${LOCAL_SOURCES[@]}"; do
  rsync_leftovers "$src"
done

if rsync --list-only "$RSYNC_URL" >/dev/null 2>&1; then
  echo "LAN rsync $RSYNC_URL -> $DEST"
  rsync -aH --delete --partial --timeout=180 --info=stats2 \
    --exclude '/artcut/' \
    --exclude '/lost+found' \
    "$RSYNC_URL" "$DEST/"
else
  echo "Pi rsyncd not listening on $RSYNC_URL (expected). Local seed done."
  echo "On the Pi, install scripts/pi-card-images.rsyncd.conf and:"
  echo "  rsync --daemon --config /etc/rsyncd.conf"
fi
