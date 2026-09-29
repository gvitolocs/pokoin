#!/usr/bin/env bash
# Copy every Pokoin brand/site asset into brand/ so there is one folder to grab
# logos, mascot, favicons, fonts, flags, condition chips, game icons and Flex
# art from. The files the site serves stay where they are; brand/ is a copy.
#
#   python3 scripts/build-brand-logo.py   # regenerate the SVG wordmark first
#   bash scripts/sync-brand-assets.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/brand"
mkdir -p "$OUT"/{logo,mascot,favicon,fonts,flex,conditions,flags,games,misc}

cp "$ROOT"/home/logo.png "$ROOT"/home/pokoin-192.png "$ROOT"/home/bimi.svg "$OUT/logo/"
cp "$ROOT"/home/pokoin-mascot.png "$ROOT"/market/src/assets/pokoin-mascot@8x.png "$OUT/mascot/"
cp "$ROOT"/market/public/brand/pokoin-mascot.svg "$OUT/mascot/"
cp "$ROOT"/home/favicon.ico "$ROOT"/home/favicon-*.png "$ROOT"/home/apple-touch-icon.png "$OUT/favicon/"
cp "$ROOT"/home/satoshi.woff2 "$ROOT"/home/fredoka-wordmark.ttf "$OUT/fonts/"
cp "$ROOT"/market/public/brand/flex/*.svg "$OUT/flex/"
cp "$ROOT"/market/public/conditions/*.svg "$OUT/conditions/"
cp "$ROOT"/market/public/flags/* "$OUT/flags/"
cp "$ROOT"/market/public/games/* "$OUT/games/"
cp "$ROOT"/home/missing-card.webp "$ROOT"/home/working.gif "$OUT/misc/"
echo "brand/: $(find "$OUT" -type f | wc -l) files, $(du -sh "$OUT" | cut -f1)"
