#!/usr/bin/env bash
# Keep uploading QA-passed SAM figure masks while build-artwork-figure-masks.py
# runs. Exits after one final QA + upload once the builder process is gone.
#
#   nohup bash scripts/upload-figure-masks-loop.sh <builder-pid> &
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER_PID="${1:?builder pid required}"
MASKS="${MASKS:-/home/nez/data/pokoin-leftovers/figure-masks}"
JSONL="$ROOT/scripts/out/qwen-artwork-figures.jsonl"
REPORT="$ROOT/scripts/out/figure-masks-qa.jsonl"
PASS="$ROOT/scripts/out/figure-masks-pass.txt"
LOG="$ROOT/scripts/out/figure-masks-upload.log"
PY=/home/nez/Projects/ai-toolkit/venv/bin/python

qa() {
  "$PY" "$ROOT/scripts/qa-figure-masks.py" \
    --jsonl "$JSONL" --masks "$MASKS" \
    --report "$REPORT" --pass-list "$PASS"
}

upload() {
  # shellcheck disable=SC2016  # remote side needs the pipe
  rsync -a --info=stats1 --files-from="$PASS" "$MASKS"/ \
    pi-home:/srv/pokoin/card-images/objects/figure-masks/
}

while kill -0 "$BUILDER_PID" 2>/dev/null; do
  if qa >> "$LOG" 2>&1; then upload >> "$LOG" 2>&1 || true; fi
  sleep 900
done
qa >> "$LOG" 2>&1
upload >> "$LOG" 2>&1
echo "final upload done $(date -u +%FT%TZ)" >> "$LOG"
