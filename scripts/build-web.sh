#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-web"
cd "$ROOT"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$ROOT/index.html" "$OUT/index.html"
cp -a "$ROOT/home" "$OUT/home"
cp "$ROOT/home/favicon.ico" "$OUT/favicon.ico"
cp "$ROOT/home/favicon-32x32.png" "$OUT/favicon-32x32.png"
cp "$ROOT/home/favicon-48x48.png" "$OUT/favicon-48x48.png"
cp "$ROOT/home/favicon-96x96.png" "$OUT/favicon-96x96.png"
cp "$ROOT/home/apple-touch-icon.png" "$OUT/apple-touch-icon.png"
cp "$ROOT/home/pokoin-192.png" "$OUT/pokoin-192.png"
cp "$ROOT/home/logo.png" "$OUT/pokoin-512.png"
cp "$ROOT/robots.txt" "$OUT/robots.txt"
node "$ROOT/scripts/build-seo-sitemaps.mjs"
cp "$ROOT/sitemap.xml" "$OUT/sitemap.xml"
cp "$ROOT/sitemap-hubs.xml" "$OUT/sitemap-hubs.xml"
cp "$ROOT/sitemap-pokemon.xml" "$OUT/sitemap-pokemon.xml"
cp "$ROOT/sitemap-sets.xml" "$OUT/sitemap-sets.xml"
cp "$ROOT/site.webmanifest" "$OUT/site.webmanifest"
# BIMI logo for inbox brand avatars (DNS: default._bimi.pokoin.com)
if [[ -f "$ROOT/bimi.svg" ]]; then
  cp "$ROOT/bimi.svg" "$OUT/bimi.svg"
elif [[ -f "$ROOT/home/bimi.svg" ]]; then
  cp "$ROOT/home/bimi.svg" "$OUT/bimi.svg"
fi
cp "$ROOT/home/working.html" "$OUT/working.html"
# Chrome extension zip from Mac Desktop (highest FULL build). Served at
# /download/extension.zip and the /download/extention.zip alias.
if [[ -f "$ROOT/download/extension.zip" ]]; then
  mkdir -p "$OUT/download"
  cp "$ROOT/download/extension.zip" "$OUT/download/extension.zip"
  cp "$ROOT/download/extension.zip" "$OUT/download/extention.zip"
  echo "extension zip $(wc -c < "$OUT/download/extension.zip") bytes"
else
  echo "warning: missing $ROOT/download/extension.zip" >&2
fi
python3 - <<PY
from pathlib import Path
p = Path("$OUT/index.html")
t = p.read_text()
t = t.replace('href="home/', 'href="/home/').replace('src="home/', 'src="/home/')
p.write_text(t)
print("landing", p)
PY
cd "$ROOT/market"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
# Marketplace SPA talks to api.pokoin.com. Do not source supabase-pokoin.env.
npm run build
mkdir -p "$OUT/market"
cp -a "$ROOT/market/dist/." "$OUT/market/"
# White-edge-pass dumps stay off the production SPA. Keep /review for
# test.pokoin.com boards (sanitize, espurr, ocr).
rm -rf "$OUT/market/review/white-edge-pass"
echo "built $OUT"
