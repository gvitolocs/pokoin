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
python3 scripts/dump-all-cardtrader-listings.py &
dump_pid=$!
pictures_result=0
/home/nez/Projects/ai-toolkit/venv/bin/python scripts/refresh-all-cardtrader-pictures.py || pictures_result=$?
(( pictures_result == 0 )) || result=1
picture_sync_result=0
python3 scripts/sync-catalog-pictures.py || picture_sync_result=$?
(( picture_sync_result == 0 )) || result=1
artwork_result=0
/home/nez/Projects/ai-toolkit/venv/bin/python scripts/match-refreshed-pokemon-artwork.py || artwork_result=$?
(( artwork_result == 0 )) || result=1
search_result=0
node scripts/sync-refreshed-catalogue-search.cjs || search_result=$?
(( search_result == 0 )) || result=1
dump_result=0
wait "$dump_pid" || dump_result=$?
(( dump_result == 0 )) || result=1
# Delivery is best effort; the notifier queues failures for later retry.
python3 scripts/cardtrader-daily-notify.py \
  --run-root "$POKOIN_CATALOG_RUN_ROOT" --started-at "$run_started_at" \
  --exit-code "$result" \
  --stage-result "catalog=$catalog_result" --stage-result "pictures=$pictures_result" \
  --stage-result "picture-sync=$picture_sync_result" --stage-result "artwork=$artwork_result" \
  --stage-result "search=$search_result" --stage-result "dump=$dump_result" \
  || echo "CardTrader notification pending; import result is unchanged." >&2
exit "$result"
