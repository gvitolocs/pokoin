#!/usr/bin/env bash
# Contact sheet for lang-scans sample.tsv: each pair is the current leftover
# scan (left) next to the mapped language scan (right), labelled
# "ct_id lang name". Needs curl + ImageMagick montage.
# usage: contact-sheet.sh cards.tsv sample.tsv OUT_DIR [per_sheet]
set -euo pipefail
cards=$1 sample=$2 out=$3 per=${4:-50}
mkdir -p "$out/img"
cdn=https://cdn.pokoin.com
n=0
while IFS=$'\t' read -r ct_id name lang key; do
  url=$(awk -F'\t' -v id="$ct_id" '$1==id{print $7; exit}' "$cards")
  left="$out/img/$ct_id-en.jpg" right="$out/img/$ct_id-$lang.webp"
  [ -s "$left" ] || curl -fsS -m 30 -o "$left" "${url/\/card-images/$cdn}" || true
  [ -s "$right" ] || curl -fsS -m 30 -o "$right" "$cdn/$key" || true
  printf '%s\t%s\t%s\t%s\n' "$left" "$right" "$ct_id $lang" "${name:0:22}"
  n=$((n + 1))
done < "$sample" > "$out/pairs.tsv"
split -l "$per" -d "$out/pairs.tsv" "$out/part-"
for part in "$out"/part-*; do
  args=()
  while IFS=$'\t' read -r left right label name; do
    args+=(-label "$label en" "$left" -label "$name" "$right")
  done < "$part"
  montage "${args[@]}" -tile 10x -geometry 150x210+4+4 -background '#222' -fill white -pointsize 11 "$out/sheet-${part##*-}.jpg"
done
ls "$out"/sheet-*.jpg
