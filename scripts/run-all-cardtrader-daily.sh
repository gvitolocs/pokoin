#!/usr/bin/env bash
# Runs all supported catalogues, JPEG backfill and raw listing books on nezopt.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=scripts/cardtrader-daily-paths.sh
source scripts/cardtrader-daily-paths.sh
export POKOIN_CATALOG_RUN_ROOT="${POKOIN_CATALOG_RUN_ROOT:-/home/nez/data/pokoin-catalog-refresh/daily/$(date -u +%F)}"
mkdir -p "$POKOIN_CATALOG_RUN_ROOT"
run_started_at=$(date -u +%FT%TZ)
result=0
# Stages report only once they have finished, so an interrupted run never shows a
# stage that did not run as passed.
stage_args=()
dump_pid=""
# The unit runs the clean checkout ~/pokoin-deploy/cardtrader-daily, moved to origin/main
# by scripts/deploy-cardtrader-daily-checkout.sh. The summary names its commit and how
# many newer commits to the job's own files are waiting there (shared refs, no fetch).
job_paths=(scripts/cardtrader-daily-preflight.sh scripts/cardtrader-daily-paths.sh
  scripts/run-all-cardtrader-daily.sh scripts/refresh-all-cardtrader-catalogues.cjs
  scripts/cardtrader-fetch-bridge.py scripts/refresh-all-cardtrader-pictures.py
  scripts/satellite-scan-ingest.py scripts/ingest-missing-product-images.py
  scripts/cardtrader-scan-fetch.py scripts/sync-catalog-pictures.py
  scripts/match-refreshed-pokemon-artwork.py scripts/cardtrader-daily-notify.py
  scripts/dump-all-cardtrader-listings.py deploy/systemd/pokoin-all-cardtrader-daily.service
  deploy/systemd/pokoin-all-cardtrader-daily.timer)
code_commit=$(git rev-parse --short=12 HEAD 2>/dev/null) || code_commit=""
code_undeployed=$(git rev-list --count HEAD..origin/main -- "${job_paths[@]}" 2>/dev/null) || code_undeployed=""

notify() {
  # Delivery is best effort; the notifier queues failures for later retry.
  python3 scripts/cardtrader-daily-notify.py \
    --run-root "$POKOIN_CATALOG_RUN_ROOT" --started-at "$run_started_at" \
    --code-commit "$code_commit" --code-undeployed "$code_undeployed" \
    --exit-code "$1" "${stage_args[@]}" "${@:2}" \
    || echo "CardTrader notification pending; import result is unchanged." >&2
}

# `systemctl stop`, a timeout or a shutdown sends SIGTERM to the whole unit. Still send
# the summary, marked interrupted: the run killed at 06:44 UTC on 2026-10-15 sent nothing.
# shellcheck disable=SC2317,SC2329 # invoked by trap
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

preflight_result=0
bash scripts/cardtrader-daily-preflight.sh || preflight_result=$?
(( preflight_result == 0 )) || result=1
stage_args+=(--stage-result "preflight=$preflight_result")

catalog_result=0
node scripts/refresh-all-cardtrader-catalogues.cjs --apply || catalog_result=$?
(( catalog_result == 0 )) || result=1
stage_args+=(--stage-result "catalog=$catalog_result")
# Listing books: the Rust dump (docs/CARDTRADER_DAILY_DUMP.md) once installed,
# else the Python one. Both write listing-dump-status.json for the notifier.
if [[ -x "$DUMP_BIN" ]]; then
  "$DUMP_BIN" &
else
  python3 scripts/dump-all-cardtrader-listings.py &
fi
dump_pid=$!
# GPU stages hold a VRAM lease (/home/nez/bin/gpu-lease): an unguarded GPU job
# racing a Qwen load panicked amdgpu on 2026-10-06. They queue (up to 4 h) and
# llama-server-qwen-watch yields Qwen while they wait.
GPU_LEASE=("$GPU_LEASE_BIN" run --mb "${CATALOG_GPU_MB:-4000}" --wait 14400)
pictures_result=0
"${GPU_LEASE[@]}" --name catalog-pictures -- "$AI_PYTHON" scripts/refresh-all-cardtrader-pictures.py || pictures_result=$?
(( pictures_result == 0 )) || result=1
stage_args+=(--stage-result "pictures=$pictures_result")
picture_sync_result=0
python3 scripts/sync-catalog-pictures.py || picture_sync_result=$?
(( picture_sync_result == 0 )) || result=1
stage_args+=(--stage-result "picture-sync=$picture_sync_result")
artwork_result=0
# The artwork stage runs CLIP on the CPU by default (POKOIN_ARTWORK_DEVICE=gpu opts in):
# on the GPU it segfaulted in libamdhip64 every night from 2026-11-08, with Qwen holding the card.
if [[ "${POKOIN_ARTWORK_DEVICE:-cpu}" == gpu ]]; then
  "${GPU_LEASE[@]}" --name catalog-artwork -- "$AI_PYTHON" scripts/match-refreshed-pokemon-artwork.py || artwork_result=$?
else
  "$AI_PYTHON" scripts/match-refreshed-pokemon-artwork.py || artwork_result=$?
fi
(( artwork_result == 0 )) || result=1
stage_args+=(--stage-result "artwork=$artwork_result")
# Card pictures (BattleScan server-rs `scripts/daily-card-refresh.sh`, installed by its
# install-card-refresh.sh): CDN faces that are a placeholder get the real picture from the
# first source that has it, new and recovered cards are embedded into the scan index (swapped
# after a health check) and an app catalog revision is staged. Skipped when not installed;
# POKOIN_CARD_REFRESH=off skips it.
cards_result=0
if [[ -x "$CARD_REFRESH_BIN" && "${POKOIN_CARD_REFRESH:-on}" != off ]]; then
  DAILY="$POKOIN_CATALOG_RUN_ROOT" "$CARD_REFRESH_BIN" || cards_result=$?
fi
(( cards_result == 0 )) || result=1
stage_args+=(--stage-result "cards=$cards_result")
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
if [[ -x "$PRICE_BIN" ]]; then
  "$PRICE_BIN" || prices_result=$?
fi
(( prices_result == 0 )) || result=1
stage_args+=(--stage-result "prices=$prices_result")
# Sold graph of the other games, replayed from the stored books (docs/CARDTRADER_DAILY_DUMP.md
# "Sold graph"). Pokémon's comes from the Oracle job. POKOIN_CT_SOLD=off skips it.
sold_result=0
if [[ -x "$SOLD_BIN" && "${POKOIN_CT_SOLD:-on}" != off ]]; then
  "$SOLD_BIN" || sold_result=$?
fi
(( sold_result == 0 )) || result=1
stage_args+=(--stage-result "sold=$sold_result")
notify "$result"
exit "$result"
