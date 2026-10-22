#!/usr/bin/env bash
# CLIP same-art groups for newly imported leftovers, then reverse-holo pattern
# siblings (scripts/sql/20261022_reverse_pattern_version_joins.sql). Apply on nezopt 15T.
# After leftover ingest, or on its own:
#   scripts/match-imported-version-sets.sh --expansion "30th Celebration JP"
#   scripts/match-imported-version-sets.sh --ids 790994
set -euo pipefail
export HIP_VISIBLE_DEVICES="${HIP_VISIBLE_DEVICES:-0}"
PYTHON="${PYTHON:-/home/nez/Projects/ai-toolkit/venv/bin/python}"
SCRIPT="${CLUSTER:-/home/nez/Projects/pokemon-card-extension/scripts/cluster-name-version-sets.py}"
"$PYTHON" "$SCRIPT" --refresh-candidates "$@"
# Reverse-holo patterns are the same card; CLIP misses them under the foil
# and a re-cluster resets them. Skip on --dry-run (nothing was applied).
case " $* " in *" --dry-run "*) exit 0 ;; esac
docker exec -i "${POKOIN_MARKETPLACE_POSTGRES:-pokoin-marketplace-postgres-15t}" \
  psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1 -At -c \
  "SELECT count(*) AS joined_sets, coalesce(sum(moved_rows), 0) AS moved_rows FROM public.marketplace_join_reverse_pattern_versions(true);"
