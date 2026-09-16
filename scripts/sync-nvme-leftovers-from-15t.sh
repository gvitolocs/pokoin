#!/usr/bin/env bash
# One-time catch-up: leftover JPEGs + CLIP artcut onto nezopt NVMe.
# After this, edge classify / OCR / CLIP read NVMe. 15T HDD is Postgres
# historicization only — do not scandir mybook objects on every pass.
#
# Existing NVMe trees are hardlinked (same filesystem). Files only on the
# 15T replica are copied. Newer NVMe files are not overwritten.
set -euo pipefail

NVME="${POKOIN_NVME_LEFTOVERS:-/home/nez/data/pokoin-leftovers}"
MYBOOK="${POKOIN_MYBOOK_LEFTOVERS:-/home/nez/mnt/mybook/pokoin-pi-card-images}"
DEST_OBJECTS="$NVME/objects"
DEST_ARTCUT="$NVME/artcut"

NVME_SEEDS=(
  /home/nez/Projects/pokoin/PokoinTest/index/cdn_images
  /home/nez/Projects/pokoin/PokoinTest/index/cdn_images_delta
  /home/nez/pokoincdn/cdn_images_digest/2026-08-30
  /home/nez/pokoincdn/cdn_images_digest/2026-08-31-jpg
  /home/nez/data/pokoin-artwork-layout-objects
)

if [[ ! -d /home/nez/mnt/mybook ]]; then
  echo "15T mybook is not mounted at /home/nez/mnt/mybook" >&2
  exit 1
fi

mkdir -p "$DEST_OBJECTS" "$DEST_ARTCUT"

seed_link() {
  local src=$1
  [[ -d "$src" ]] || return 0
  echo "hardlink-seed $src -> $DEST_OBJECTS"
  rsync -a --ignore-existing --link-dest="$src" "$src"/ "$DEST_OBJECTS/"
}

for src in "${NVME_SEEDS[@]}"; do
  seed_link "$src"
done

echo "HDD catch-up $MYBOOK/objects -> $DEST_OBJECTS"
ionice -c2 -n7 nice -n 10 rsync -a --ignore-existing --info=stats2 \
  --include='*/' \
  --include='*.jpg' \
  --include='*.jpeg' \
  --include='*.png' \
  --include='*.webp' \
  --exclude='*' \
  "$MYBOOK/objects/" "$DEST_OBJECTS/"

if [[ -d "$MYBOOK/artcut" ]]; then
  echo "HDD catch-up $MYBOOK/artcut -> $DEST_ARTCUT"
  ionice -c2 -n7 nice -n 10 rsync -a --ignore-existing --info=stats2 \
    "$MYBOOK/artcut/" "$DEST_ARTCUT/"
fi

echo "nvme leftovers $DEST_OBJECTS"
echo "nvme artcut $DEST_ARTCUT"
