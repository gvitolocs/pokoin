#!/usr/bin/env bash
# Review sheets: before | after | aligned difference, 8 pairs per sheet.
# usage: sheets.sh <run dir> <name> <ids file>
set -euo pipefail
run=$1; name=$2; ids=$3
bin=~/tmp/hd-card-images/target/release/hd-scan-upgrade
panels=$run/panels
out=$run/sheets/$name
mkdir -p "$panels" "$out"
$bin render --pairs "$run/pairs.tsv" --objects /home/nez/data/pokoin-leftovers/objects --ids "$ids" --out "$panels"
mapfile -t list < "$ids"
per=8
for ((i = 0; i < ${#list[@]}; i += per)); do
  args=()
  for id in "${list[@]:i:per}"; do
    [[ -f $panels/$id.jpg ]] || continue
    label=$(awk -F'\t' -v id="$id" '$3==id {sub(/https:\/\/www.artofpkm.com/, "ap", $15); printf "%s %s | %s | %s %s\n%s %sx%s -> %s %sx%s | full %.2f art %.2f tile %.2f stamp %.2f col %.0f sharp %.2f | %s %s", $3, $5, $6, $7, $10, $14, $12, $13, $15, $18, $19, $21, $22, $23, $25, $26, $27, $1, $2}' "$run/pairs.tsv")
    args+=(-label "$label" "$panels/$id.jpg")
  done
  ((${#args[@]})) || continue
  montage "${args[@]}" -tile 2x -geometry 640x296+6+4 -pointsize 11 -background '#f2f2f2' \
    "$out/$(printf '%s-%03d' "$name" $((i / per))).jpg"
done
ls "$out" | wc -l
