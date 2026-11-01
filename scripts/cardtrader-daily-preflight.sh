#!/usr/bin/env bash
# Local prerequisites only: never contact hosts, load GPU models or run job stages.
set -uo pipefail
# shellcheck source=scripts/cardtrader-daily-paths.sh
source "$(dirname "$0")/cardtrader-daily-paths.sh"
result=0
problem() { printf 'ERROR [%s] %s: %s\n' "$1" "$2" "$3"; result=1; }
warning() { printf 'WARNING [%s] %s: %s\n' "$1" "$2" "$3"; }
readable() { [[ -f "$2" && -r "$2" ]] || problem "$1" "$2" 'missing or unreadable file'; }
executable() { command -v "$2" >/dev/null 2>&1 || problem "$1" "$2" 'missing executable'; }
optional() { [[ -x "$2" ]] || warning "$1" "$2" 'not installed; stage uses its fallback or skips'; }

executable 'pictures,artwork' "$AI_PYTHON"
if command -v "$AI_PYTHON" >/dev/null 2>&1; then
  # Bound even a broken interpreter; suppress its traceback and name the path once.
  if ! PYTHONDONTWRITEBYTECODE=1 timeout 30 "$AI_PYTHON" -c 'import numpy, PIL' >/dev/null 2>&1; then
    problem 'pictures,artwork' "$AI_PYTHON" 'cannot import numpy, PIL within 30 seconds'
  fi
fi
executable 'pictures,artwork' "$GPU_LEASE_BIN"
for tool in node docker python3 ssh rsync scp timeout; do
  case "$tool" in
    node) stages=catalog ;;
    docker) stages=catalog,pictures,artwork,dump ;;
    python3) stages=catalog,picture-sync,dump,notification ;;
    ssh) stages=catalog,pictures,artwork,dump ;;
    rsync|scp) stages=pictures,picture-sync ;;
    timeout) stages=preflight ;;
  esac
  executable "$stages" "$tool"
done
cardvault=/home/nez/Projects/Startup/Pokoin/cardvault/pokemon_card_vault
readable catalog "$cardvault/scripts/cardtrader-multigame-import.js"
readable catalog "$cardvault/node_modules/pg/package.json"
cluster=/home/nez/Projects/Startup/Pokoin/pokemon-card-extension/scripts/cluster-name-version-sets.py
readable artwork "$cluster"
cache_dir="${CLUSTER_SETS_OUT_DIR:-$(dirname "$cluster")/out}"
readable artwork "$cache_dir/artbox-clip.npz"
readable artwork "$cache_dir/artbox-pixel.npz"
for objects in "${POKOIN_NVME_LEFTOVERS:-/home/nez/data/pokoin-leftovers}/objects" /home/nez/data/pokoin-leftovers/objects; do
  [[ -d "$objects" && -r "$objects" && -w "$objects" && -x "$objects" ]] \
    || problem 'pictures,picture-sync,artwork' "$objects" 'missing or inaccessible objects directory'
done
# Check the nearest existing output ancestor without creating anything.
run_root="${POKOIN_CATALOG_RUN_ROOT:-/home/nez/data/pokoin-catalog-refresh/daily/$(date -u +%F)}"
ancestor="$run_root"
while [[ ! -e "$ancestor" && "$ancestor" != / ]]; do ancestor=$(dirname "$ancestor"); done
[[ -d "$ancestor" && -w "$ancestor" && -x "$ancestor" ]] \
  || problem 'catalog,pictures,artwork,dump,notification' "$run_root" "inaccessible output ancestor $ancestor"
# Delivery is best effort, just like the optional installed stages.
notifier="${POKOIN_PRICE_NOTIFIER:-/home/nez/Projects/Startup/Pokoin/tcgprices/notify_flareon.py}"
[[ -f "$notifier" && -r "$notifier" ]] || warning notification "$notifier" 'missing notifier; delivery will be pending'
optional dump "$DUMP_BIN"
optional prices "$PRICE_BIN"
optional sold "$SOLD_BIN"
[[ "${POKOIN_CARD_REFRESH:-on}" == off ]] || optional cards "$CARD_REFRESH_BIN"
exit "$result"
