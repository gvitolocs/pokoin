#!/usr/bin/env bash
# Branded fallback art for Pokoin News.
#
# Writes news/assets/art/fallback-<section>-{1600x900,1200x900,1200x1200}.jpg
# and news/assets/art/manifest.json (section -> ImageRef-like hero with 16x9,
# 4x3 and 1x1 variants). Requires ImageMagick `convert`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/news/assets/art"
LOGO="$ROOT/home/logo.png"

if ! command -v convert >/dev/null 2>&1; then
  echo "make-news-fallback-art: ImageMagick 'convert' not found; install ImageMagick and re-run." >&2
  exit 1
fi
if [ ! -f "$LOGO" ]; then
  echo "make-news-fallback-art: logo not found at $LOGO" >&2
  exit 1
fi

sections=(sets cards market competitive collectors fact-check analysis industry)
labels=("Sets" "Cards" "Market" "Competitive" "Collectors" "Fact Check" "Analysis" "Industry")
widths=(1600 1200 1200)
heights=(900 900 1200)
ratios=("16x9" "4x3" "1x1")

mkdir -p "$OUT_DIR"

for i in "${!sections[@]}"; do
  section="${sections[$i]}"
  label="${labels[$i]}"
  for s in "${!widths[@]}"; do
    w="${widths[$s]}"
    h="${heights[$s]}"
    out="$OUT_DIR/fallback-$section-${w}x${h}.jpg"
    pointsize=$(( h * 11 / 100 ))
    labelsize=$(( h * 7 / 100 ))
    rule="$(( w * 52 / 100 )),$(( h * 60 / 100 + 3 ))"
    convert -size "${w}x${h}" "xc:#0b0a10" \
      -fill 'rgba(255,211,61,0.12)' -draw "polygon 0,$(( h * 66 / 100 )) $w,$(( h * 30 / 100 )) $w,$(( h * 52 / 100 )) 0,$(( h * 88 / 100 ))" \
      -fill '#ffd33d' -draw "rectangle $(( w * 7 / 100 )),$(( h * 60 / 100 )) $rule" \
      \( "$LOGO" -resize 120x120 \) -gravity NorthWest -geometry "+$(( w * 7 / 100 ))+$(( h * 18 / 100 ))" -composite \
      -font DejaVu-Sans-Bold -fill white -pointsize "$pointsize" \
      -annotate "+$(( w * 7 / 100 ))+$(( h * 48 / 100 ))" 'POKOIN NEWS' \
      -font DejaVu-Sans-Bold -fill '#ffd33d' -pointsize "$labelsize" \
      -annotate "+$(( w * 7 / 100 ))+$(( h * 56 / 100 ))" "$label" \
      -strip -sampling-factor 4:2:0 -quality 82 "$out"
  done
done

{
  printf '{\n'
  first=1
  for i in "${!sections[@]}"; do
    section="${sections[$i]}"
    label="${labels[$i]}"
    if [ "$first" -eq 1 ]; then first=0; else printf ',\n'; fi
    printf '  "%s": {\n' "$section"
    printf '    "url": "/news/assets/art/fallback-%s-1600x900.jpg",\n' "$section"
    printf '    "width": 1600,\n'
    printf '    "height": 900,\n'
    printf '    "variants": [\n'
    for s in "${!widths[@]}"; do
      comma=','
      [ "$s" -eq $(( ${#widths[@]} - 1 )) ] && comma=''
      printf '      { "url": "/news/assets/art/fallback-%s-%sx%s.jpg", "width": %s, "height": %s, "ratio": "%s" }%s\n' \
        "$section" "${widths[$s]}" "${heights[$s]}" "${widths[$s]}" "${heights[$s]}" "${ratios[$s]}" "$comma"
    done
    printf '    ],\n'
    printf '    "alt": "Pokoin News — %s",\n' "$label"
    printf '    "origin": "branded_fallback",\n'
    printf '    "rights": "owned",\n'
    printf '    "credit": "Pokoin",\n'
    printf '    "caption": ""\n'
    printf '  }'
  done
  printf '\n}\n'
} > "$OUT_DIR/manifest.json"

echo "make-news-fallback-art: wrote $(find "$OUT_DIR" -name 'fallback-*.jpg' | wc -l | tr -d ' ') JPGs and manifest.json"
