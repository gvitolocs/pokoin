#!/usr/bin/env bash
# Draw the deck mascot stamp plates (tools/expansion-stamps) and copy them to
# both cdn.pokoin.com origins: the nezopt mirror and the Pi object store.
# market/src/expansion-stamps.js reads them from expansions/stamps/{key}.png.
#
# Usage (nezopt):
#   bash scripts/publish-expansion-stamps.sh            # draw only, print the staging dir
#   bash scripts/publish-expansion-stamps.sh --apply    # draw + rsync to both origins
#
# Redrawing a plate needs a new STAMP_CACHE in market/src/expansion-stamps.js:
# the CDN serves these objects as immutable.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING="${POKOIN_STAMP_DIR:-/tmp/pokoin-expansion-stamps}"
NEZ_OBJECTS="${POKOIN_NEZ_OBJECTS:-/home/nez/data/pokoin-leftovers/objects}"
PI_HOST="${POKOIN_PI_HOST:-pi-home}"
PI_OBJECTS="${POKOIN_PI_OBJECTS:-/srv/pokoin/card-images/objects}"
DEST=expansions/stamps

rm -rf "$STAGING"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/expansion-stamps-target}" \
  cargo run --release -q --manifest-path "$ROOT/tools/expansion-stamps/Cargo.toml" -- --out "$STAGING"
echo "drew $(ls "$STAGING" | wc -l) plates in $STAGING"

if [ "${1:-}" != "--apply" ]; then
  echo "dry run: pass --apply to copy them to $NEZ_OBJECTS/$DEST and $PI_HOST:$PI_OBJECTS/$DEST"
  exit 0
fi

mkdir -p "$NEZ_OBJECTS/$DEST"
rsync -a --checksum "$STAGING/" "$NEZ_OBJECTS/$DEST/"
rsync -a --checksum --chown=nes:nes \
  --rsync-path="mkdir -p $PI_OBJECTS/$DEST && chown nes:nes $PI_OBJECTS/$DEST && rsync" \
  "$STAGING/" "$PI_HOST:$PI_OBJECTS/$DEST/"
echo "published $DEST to the nezopt mirror and $PI_HOST"
