#!/usr/bin/env bash
# Runs all supported catalogues, JPEG backfill and raw listing books on nezopt.
set -uo pipefail
cd "$(dirname "$0")/.."
export POKOIN_CATALOG_RUN_ROOT="${POKOIN_CATALOG_RUN_ROOT:-/home/nez/data/pokoin-catalog-refresh/daily/$(date -u +%F)}"
mkdir -p "$POKOIN_CATALOG_RUN_ROOT"
result=0
node scripts/refresh-all-cardtrader-catalogues.cjs --apply || result=1
python3 scripts/dump-all-cardtrader-listings.py &
dump_pid=$!
/home/nez/Projects/ai-toolkit/venv/bin/python scripts/refresh-all-cardtrader-pictures.py || result=1
python3 scripts/sync-catalog-pictures.py || result=1
/home/nez/Projects/ai-toolkit/venv/bin/python scripts/match-refreshed-pokemon-artwork.py || result=1
node scripts/sync-refreshed-catalogue-search.cjs || result=1
wait "$dump_pid" || result=1
exit "$result"
