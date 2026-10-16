#!/usr/bin/env bash
# Runs all supported catalogues, JPEG backfill and raw listing books on nezopt.
set -uo pipefail
cd "$(dirname "$0")/.."
export POKOIN_CATALOG_RUN_ROOT="${POKOIN_CATALOG_RUN_ROOT:-/home/nez/data/pokoin-catalog-refresh/daily/$(date -u +%F)}"
mkdir -p "$POKOIN_CATALOG_RUN_ROOT"
run_started_at=$(date -u +%FT%TZ)
result=0
# Stages report only once they have finished, so an interrupted run never shows a
# stage that did not run as passed.
stage_args=()
dump_pid=""

notify() {
  # Delivery is best effort; the notifier queues failures for later retry.
  python3 scripts/cardtrader-daily-notify.py \
    --run-root "$POKOIN_CATALOG_RUN_ROOT" --started-at "$run_started_at" \
    --exit-code "$1" "${stage_args[@]}" "${@:2}" \
    || echo "CardTrader notification pending; import result is unchanged." >&2
}

# `systemctl stop`, a timeout or a shutdown sends SIGTERM to the whole unit. Still send
# the summary, marked interrupted: the run killed at 06:44 UTC on 2026-10-15 sent nothing.
# shellcheck disable=SC2317 # invoked by trap
on_signal() {
  local sig="$1" code="$2"
  trap - TERM INT
  [[ -n "$dump_pid" ]] && kill "$dump_pid" 2>/dev/null
  echo "run-all-cardtrader-daily: stopped by SIG$sig" >&2
  notify "$code" --stage-result "interrupted=$code"
  exit "$code"
}
trap 'on_signal TERM 143' TERM
trap 'on_signal INT 130' INT

catalog_result=0
node scripts/refresh-all-cardtrader-catalogues.cjs --apply || catalog_result=$?
(( catalog_result == 0 )) || result=1
stage_args+=(--stage-result "catalog=$catalog_result")
# Listing books: the Rust dump (docs/CARDTRADER_DAILY_DUMP.md) once installed,
# else the Python one. Both write listing-dump-status.json for the notifier.
DUMP_BIN="${POKOIN_CT_DUMP_BIN:-/home/nez/pokoin-cardtrader/current/pokoin-cardtrader-listing-dump}"
if [[ -x "$DUMP_BIN" ]]; then
  "$DUMP_BIN" &
else
  python3 scripts/dump-all-cardtrader-listings.py &
fi
dump_pid=$!
# GPU stages hold a VRAM lease (/home/nez/bin/gpu-lease): an unguarded GPU job
# racing a Qwen load panicked amdgpu on 2026-10-06. They queue (up to 4 h) and
# llama-server-qwen-watch yields Qwen while they wait.
GPU_LEASE=("${POKOIN_GPU_LEASE:-/home/nez/bin/gpu-lease}" run --mb "${CATALOG_GPU_MB:-4000}" --wait 14400)
AI_PYTHON="${POKOIN_AI_PYTHON:-/home/nez/Projects/ai-toolkit/venv/bin/python}"
pictures_result=0
"${GPU_LEASE[@]}" --name catalog-pictures -- "$AI_PYTHON" scripts/refresh-all-cardtrader-pictures.py || pictures_result=$?
(( pictures_result == 0 )) || result=1
stage_args+=(--stage-result "pictures=$pictures_result")
picture_sync_result=0
python3 scripts/sync-catalog-pictures.py || picture_sync_result=$?
(( picture_sync_result == 0 )) || result=1
stage_args+=(--stage-result "picture-sync=$picture_sync_result")
artwork_result=0
"${GPU_LEASE[@]}" --name catalog-artwork -- "$AI_PYTHON" scripts/match-refreshed-pokemon-artwork.py || artwork_result=$?
(( artwork_result == 0 )) || result=1
stage_args+=(--stage-result "artwork=$artwork_result")
# Search stage removed 2026-10-06: it fed Meilisearch on pi-home, retired on
# 2026-10-03 (_pipeline_health.js retired: ['meili', 'valkey']); every run since
# failed with ConnectionRefused. sync-refreshed-catalogue-search.cjs is unused.
dump_result=0
wait "$dump_pid" || dump_result=$?
dump_pid=""
(( dump_result == 0 )) || result=1
stage_args+=(--stage-result "dump=$dump_result")
# Price the books this run actually stored. A dump that stopped at its deadline
# still has a price cache: only fetched expansions are in scope.
prices_result=0
PRICE_BIN="${POKOIN_CT_PRICE_BIN:-/home/nez/pokoin-cardtrader/current/pokoin-cardtrader-price-cache}"
if [[ -x "$PRICE_BIN" ]]; then
  "$PRICE_BIN" || prices_result=$?
fi
(( prices_result == 0 )) || result=1
stage_args+=(--stage-result "prices=$prices_result")
notify "$result"
exit "$result"
