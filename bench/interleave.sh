#!/usr/bin/env bash
# Interleaved A/B/C benchmark: one run of each variant per round, so host drift
# spreads evenly across builds. Then merges each variant's runs.
#   bash interleave.sh <label> <profile> <rounds> <journeys> name=url [name=url …]
set -euo pipefail
cd "$(dirname "$0")"
label=$1 profile=$2 rounds=$3 journeys=$4
shift 4
dir="results/$label-$profile"
mkdir -p "$dir"
for round in $(seq 1 "$rounds"); do
  for pair in "$@"; do
    name=${pair%%=*} base=${pair#*=}
    node run.mjs --base "$base" --profile "$profile" --runs 1 --journeys "$journeys" \
      --label "$name" --out "$dir/$name-r$round.json" > "$dir/$name-r$round.log" 2>&1 \
      || echo "round $round $name failed (see $dir/$name-r$round.log)"
  done
  echo "round $round done $(date -u +%H:%M:%S)"
done
for pair in "$@"; do
  name=${pair%%=*}
  node merge.mjs --out "$dir/$name.json" "$dir/$name"-r*.json
done
