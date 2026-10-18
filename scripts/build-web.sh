#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Output directory: dist-web by default, or the first argument (emptied first,
# so never the repo, a folder inside it, or one of its parents).
OUT="${1:-$ROOT/dist-web}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
out_dir="${OUT%/}"
case "$ROOT/" in "$out_dir"/*) echo "build-web: refusing to empty $OUT" >&2; exit 1 ;; esac
case "$OUT/" in "$ROOT"/*) [[ "$OUT" == "$ROOT/dist-web" ]] || { echo "build-web: refusing to empty $OUT" >&2; exit 1; } ;; esac
cd "$ROOT"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$ROOT/index.html" "$OUT/landing.html"
cp -a "$ROOT/home" "$OUT/home"
node "$ROOT/scripts/build-product-pages.mjs" "$OUT"
cp "$ROOT/home/favicon.ico" "$OUT/favicon.ico"
cp "$ROOT/home/favicon-32x32.png" "$OUT/favicon-32x32.png"
cp "$ROOT/home/favicon-48x48.png" "$OUT/favicon-48x48.png"
cp "$ROOT/home/favicon-96x96.png" "$OUT/favicon-96x96.png"
cp "$ROOT/home/apple-touch-icon.png" "$OUT/apple-touch-icon.png"
cp "$ROOT/home/pokoin-192.png" "$OUT/pokoin-192.png"
cp "$ROOT/home/logo.png" "$OUT/pokoin-512.png"
cp "$ROOT/robots.txt" "$OUT/robots.txt"
cp "$ROOT/llms.txt" "$OUT/llms.txt"
node "$ROOT/scripts/build-catalog-discovery.mjs" || echo "warning: catalog discovery left the previous card sitemaps in place" >&2
node "$ROOT/scripts/build-seo-sitemaps.mjs"
cp "$ROOT/sitemap.xml" "$OUT/sitemap.xml"
cp "$ROOT/sitemap-hubs.xml" "$OUT/sitemap-hubs.xml"
cp "$ROOT/sitemap-pokemon.xml" "$OUT/sitemap-pokemon.xml"
cp "$ROOT/sitemap-sets.xml" "$OUT/sitemap-sets.xml"
shopt -s nullglob
discovery=("$ROOT"/sitemap-cards-*.xml "$ROOT"/google-shopping-*.xml)
if [[ -f "$ROOT/google-shopping.txt" ]]; then
  discovery+=("$ROOT/google-shopping.txt")
fi
if ((${#discovery[@]})); then
  cp "${discovery[@]}" "$OUT/"
fi
shopt -u nullglob
cp "$ROOT/site.webmanifest" "$OUT/site.webmanifest"
# The landing and marketplace both link to the official PokoinPOS audit. Keep
# it in the deployment artifact so the published URL cannot regress to 404.
if [[ -d "$ROOT/audit" ]]; then
  cp -a "$ROOT/audit" "$OUT/audit"
else
  echo "warning: missing $ROOT/audit (security audit URL will 404)" >&2
fi
# BIMI logo for inbox brand avatars (DNS: default._bimi.pokoin.com)
if [[ -f "$ROOT/bimi.svg" ]]; then
  cp "$ROOT/bimi.svg" "$OUT/bimi.svg"
elif [[ -f "$ROOT/home/bimi.svg" ]]; then
  cp "$ROOT/home/bimi.svg" "$OUT/bimi.svg"
fi
cp "$ROOT/home/working.html" "$OUT/working.html"
# PokoinPoS explorer UI served on explorer.pokoin.com (host-based rewrites in
# vercel.json). Vendored from pokoinpos/explorer — see explorer/README.md.
if [[ -d "$ROOT/explorer" ]]; then
  cp -a "$ROOT/explorer" "$OUT/explorer"
else
  echo "warning: missing $ROOT/explorer (explorer.pokoin.com will 404)" >&2
fi
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
p = Path("$OUT/landing.html")
t = p.read_text()
t = t.replace('href="home/', 'href="/home/').replace('src="home/', 'src="/home/')
p.write_text(t)
print("landing", p)
PY
# The marketplace SPA is the Solid app (solid/). Its shared modules live in
# market/src, so market/ installs their packages (firebase, jsqr); market/public
# is Solid's publicDir. It talks to api.pokoin.com. Do not source supabase-pokoin.env.
for pkg in market solid; do
  if [[ -f "$ROOT/$pkg/package-lock.json" ]]; then
    (cd "$ROOT/$pkg" && npm ci)
  else
    (cd "$ROOT/$pkg" && npm install)
  fi
done
(cd "$ROOT/solid" && npm run build)
mkdir -p "$OUT/market"
cp -a "$ROOT/solid/dist/." "$OUT/market/"
# White-edge-pass dumps stay off the production SPA. Keep /review for
# test.pokoin.com boards (sanitize, espurr, ocr).
rm -rf "$OUT/market/review/white-edge-pass"
# The landing loads its Solid island (hero typeahead, Best sellers rail) as
# /market/landing-island.js; point it at the hashed entry the island build wrote.
python3 - <<PY
import json
from pathlib import Path
manifest = Path("$OUT/market/landing-manifest.json")
entry = json.loads(manifest.read_text())["src/landing/island.jsx"]["file"]
for page in (Path("$OUT/landing.html"),):
    t = page.read_text()
    if 'src="/market/landing-island.js"' not in t:
        raise SystemExit(f"build-web: {page} has no landing island script")
    page.write_text(t.replace('src="/market/landing-island.js"', f'src="/market/{entry}"'))
manifest.unlink()
print("landing island", entry)
PY
echo "built $OUT"
