#!/usr/bin/env bash
# Draw the expansion symbol SVGs (tools/expansion-symbols) and copy them to
# both cdn.pokoin.com origins: the nezopt mirror and the Pi object store.
# market/src/set-logos.js loads expansions/symbols/{slug}.svg first and falls
# back to {slug}.png; market/src/expansion-symbols-png.js lists the sets that
# only have a raster mark.
#
# Usage (nezopt):
#   bash scripts/publish-expansion-symbols.sh            # draw only, print the staging dir
#   bash scripts/publish-expansion-symbols.sh --init     # re-propose symbols.tsv from the catalog first
#   bash scripts/publish-expansion-symbols.sh --apply    # draw + back up + rsync to both origins
#
# --apply never deletes: every PNG it replaces is first copied, on its own
# origin, to expansions/symbols-backup-cm1/. Redrawing needs a new
# SYMBOL_CACHE in market/src/set-logos.js: the CDN serves these as immutable.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOL="$ROOT/tools/expansion-symbols"
STAGING="${POKOIN_SYMBOL_DIR:-/tmp/pokoin-expansion-symbols}"
NEZ_OBJECTS="${POKOIN_NEZ_OBJECTS:-/home/nez/data/pokoin-leftovers/objects}"
PI_HOST="${POKOIN_PI_HOST:-pi-home}"
PI_OBJECTS="${POKOIN_PI_OBJECTS:-/srv/pokoin/card-images/objects}"
PG_CONTAINER="${POKOIN_MARKETPLACE_POSTGRES:-pokoin-marketplace-postgres-15t}"
DEST=expansions/symbols
BACKUP=expansions/symbols-backup-cm1
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/expansion-symbols-target}"

cargo build --release -q --manifest-path "$TOOL/Cargo.toml"
BIN="$CARGO_TARGET_DIR/release/expansion-symbols"

if [ "${1:-}" = "--init" ]; then
  # Catalog slugs (setSlug), nationality, CardTrader code, official id.
  docker exec -i "$PG_CONTAINER" psql -U pokoin_marketplace -d pokoin_marketplace -At -F $'\t' -c "
    select trim(both '-' from lower(regexp_replace(replace(public.unaccent(name), '&', ' and '), '[^a-zA-Z0-9]+', '-', 'g'))),
      name, nationality, coalesce(code, ''), coalesce(official_id, ''), kind, catalog_card_count
    from public.pokoin_pokemon_expansions where catalog_card_count > 0 order by 1" > "$TOOL/catalog.tsv"
  "$BIN" init --catalog "$TOOL/catalog.tsv" --symbols "$NEZ_OBJECTS/$DEST" \
    --overrides "$TOOL/overrides.tsv" > "$TOOL/symbols.tsv"
  echo "proposed $TOOL/symbols.tsv: review it (sheet below), then run --apply"
fi

rm -rf "$STAGING"
"$BIN" build --manifest "$TOOL/symbols.tsv" --symbols "$NEZ_OBJECTS/$DEST" --out "$STAGING" \
  --catalog "$TOOL/catalog.tsv"
"$BIN" emit-js --out "$STAGING" --js "$ROOT/market/src/expansion-symbols-png.js"
"$BIN" sheet --manifest "$TOOL/symbols.tsv" --symbols "$NEZ_OBJECTS/$DEST" --out "$STAGING" \
  --slugs "$TOOL/sheet-slugs.txt" --html "$STAGING/sheet.html"
echo "drew $(ls "$STAGING/svg" | wc -l) SVGs and $(ls "$STAGING/png" | wc -l) plate PNGs in $STAGING"
echo "review: node scripts/expansion-symbols-sheet.mjs $STAGING/sheet.html $STAGING/sheet (needs playwright)"

if [ "${1:-}" != "--apply" ]; then
  echo "dry run: pass --apply to copy them to $NEZ_OBJECTS/$DEST and $PI_HOST:$PI_OBJECTS/$DEST"
  exit 0
fi

# Back up the PNGs about to be replaced, on each origin.
(cd "$STAGING/png" && ls) > "$STAGING/replaced.txt"
mkdir -p "$NEZ_OBJECTS/$BACKUP"
rsync -a --ignore-missing-args --files-from="$STAGING/replaced.txt" "$NEZ_OBJECTS/$DEST/" "$NEZ_OBJECTS/$BACKUP/"
ssh -n "$PI_HOST" "mkdir -p $PI_OBJECTS/$BACKUP && chown nes:nes $PI_OBJECTS/$BACKUP && chmod 775 $PI_OBJECTS/$BACKUP"
rsync -a --ignore-missing-args --files-from="$STAGING/replaced.txt" "$PI_HOST:$PI_OBJECTS/$DEST/" "$STAGING/pi-before/"
rsync -a --chown=nes:nes --chmod=D775,F664 "$STAGING/pi-before/" "$PI_HOST:$PI_OBJECTS/$BACKUP/"

# Same modes as the neighbouring expansions trees on each origin.
for sub in svg png; do
  rsync -a --checksum --chmod=D775,F664 "$STAGING/$sub/" "$NEZ_OBJECTS/$DEST/"
  rsync -a --checksum --chown=nes:nes --chmod=D775,F664 "$STAGING/$sub/" "$PI_HOST:$PI_OBJECTS/$DEST/"
done

# Both origins must serve the same bytes (cdn-two-origins-drift).
nez=$(cd "$NEZ_OBJECTS/$DEST" && md5sum *.svg *.png | sort -k2 | md5sum)
pi=$(ssh -n "$PI_HOST" "cd $PI_OBJECTS/$DEST && md5sum *.svg *.png | sort -k2 | md5sum")
if [ "$nez" != "$pi" ]; then
  echo "origins differ after publish: compare md5sum of $DEST on both" >&2
  exit 1
fi
echo "published $DEST to the nezopt mirror and $PI_HOST (backups in $BACKUP)"
