#!/usr/bin/env bash
# Runs all supported catalogues, JPEG backfill and raw listing books on nezopt.
set -uo pipefail
cd "$(dirname "$0")/.."
export POKOIN_CATALOG_RUN_ROOT="${POKOIN_CATALOG_RUN_ROOT:-/home/nez/data/pokoin-catalog-refresh/daily/$(date -u +%F)}"
mkdir -p "$POKOIN_CATALOG_RUN_ROOT"
run_started_at=$(date -u +%FT%TZ)
result=0
catalog_result=0
node scripts/refresh-all-cardtrader-catalogues.cjs --apply || catalog_result=$?
(( catalog_result == 0 )) || result=1
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
GPU_LEASE=(/home/nez/bin/gpu-lease run --mb "${CATALOG_GPU_MB:-4000}" --wait 14400)
pictures_result=0
"${GPU_LEASE[@]}" --name catalog-pictures -- /home/nez/Projects/ai-toolkit/venv/bin/python scripts/refresh-all-cardtrader-pictures.py || pictures_result=$?
(( pictures_result == 0 )) || result=1
picture_sync_result=0
python3 scripts/sync-catalog-pictures.py || picture_sync_result=$?
(( picture_sync_result == 0 )) || result=1
artwork_result=0
"${GPU_LEASE[@]}" --name catalog-artwork -- /home/nez/Projects/ai-toolkit/venv/bin/python scripts/match-refreshed-pokemon-artwork.py || artwork_result=$?
(( artwork_result == 0 )) || result=1
# Search stage removed 2026-10-06: it fed Meilisearch on pi-home, retired on
# 2026-10-03 (_pipeline_health.js retired: ['meili', 'valkey']); every run since
# failed with ConnectionRefused. sync-refreshed-catalogue-search.cjs is unused.
dump_result=0
wait "$dump_pid" || dump_result=$?
(( dump_result == 0 )) || result=1
# Price the books this run actually stored. A dump that stopped at its deadline
# still has a price cache: only fetched expansions are in scope.
prices_result=0
PRICE_BIN="${POKOIN_CT_PRICE_BIN:-/home/nez/pokoin-cardtrader/current/pokoin-cardtrader-price-cache}"
if [[ -x "$PRICE_BIN" ]]; then
  "$PRICE_BIN" || prices_result=$?
fi
(( prices_result == 0 )) || result=1
# Delivery is best effort; the notifier queues failures for later retry.
python3 scripts/cardtrader-daily-notify.py \
  --run-root "$POKOIN_CATALOG_RUN_ROOT" --started-at "$run_started_at" \
  --exit-code "$result" \
  --stage-result "catalog=$catalog_result" --stage-result "pictures=$pictures_result" \
  --stage-result "picture-sync=$picture_sync_result" --stage-result "artwork=$artwork_result" \
  --stage-result "dump=$dump_result" \
  --stage-result "prices=$prices_result" \
  || echo "CardTrader notification pending; import result is unchanged." >&2
exit "$result"
