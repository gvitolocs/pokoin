#!/usr/bin/env bash
# One-shot: wait for the Qwen grounding job to exit, build cleaned SAM masks
# for the new rows, QA them, and upload the pass list to the Pi CDN paths.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QWEN_PID="${1:?qwen pid required}"
MASKS="/home/nez/data/pokoin-leftovers/figure-masks-clean"
JSONL="$ROOT/scripts/out/qwen-artwork-figures.jsonl"
PY=/home/nez/Projects/ai-toolkit/venv/bin/python
LOG="$ROOT/scripts/out/figure-masks-ship.log"

while kill -0 "$QWEN_PID" 2>/dev/null; do sleep 60; done

"$PY" "$ROOT/scripts/build-artwork-figure-masks.py" \
  --jsonl "$JSONL" --out "$MASKS" >> "$LOG" 2>&1
"$PY" "$ROOT/scripts/qa-figure-masks.py" \
  --jsonl "$JSONL" --masks "$MASKS" \
  --report "$ROOT/scripts/out/figure-masks-qa-clean.jsonl" \
  --pass-list "$ROOT/scripts/out/figure-masks-clean-pass.txt" >> "$LOG" 2>&1
rsync -a --files-from="$ROOT/scripts/out/figure-masks-clean-pass.txt" \
  "$MASKS"/ pi-home:/srv/pokoin/card-images/objects/figure-masks-clean/ >> "$LOG" 2>&1
echo "shipped $(wc -l < "$ROOT/scripts/out/figure-masks-clean-pass.txt") masks $(date -u +%FT%TZ)" >> "$LOG"
