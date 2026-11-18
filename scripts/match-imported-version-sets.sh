#!/usr/bin/env bash
# CLIP same-art groups for newly imported leftovers, then reverse-holo pattern
# siblings (scripts/sql/20261022_reverse_pattern_version_joins.sql). Apply on nezopt 15T.
# After leftover ingest, or on its own:
#   scripts/match-imported-version-sets.sh --expansion "30th Celebration JP"
#   scripts/match-imported-version-sets.sh --ids 790994
set -euo pipefail
export HIP_VISIBLE_DEVICES="${HIP_VISIBLE_DEVICES:-0}"
PYTHON="${PYTHON:-/home/nez/Projects/AI/ai-toolkit/venv/bin/python}"
SCRIPT="${CLUSTER:-/home/nez/Projects/Startup/Pokoin/pokemon-card-extension/scripts/cluster-name-version-sets.py}"
# Leftover JPEGs from the current store, not the cluster script's default mybook
# replica, which can lag new imports by weeks (their printings then stay singletons).
LEFTOVERS="${POKOIN_LEFTOVERS:-/home/nez/data/pokoin-leftovers/objects}"
"$PYTHON" - "$SCRIPT" "$LEFTOVERS" --refresh-candidates "$@" <<'PY'
import importlib.util, pathlib, sys
script, leftovers = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
sys.path.insert(0, str(script.parent))
spec = importlib.util.spec_from_file_location("cluster_name_version_sets", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.PI_OBJECTS = leftovers
sys.argv = [str(script), *sys.argv[3:]]
module.main()
PY
# Reverse-holo patterns are the same card; CLIP misses them under the foil
# and a re-cluster resets them. Skip on --dry-run (nothing was applied).
case " $* " in *" --dry-run "*) exit 0 ;; esac
docker exec -i "${POKOIN_MARKETPLACE_POSTGRES:-pokoin-marketplace-postgres-15t}" \
  psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1 -At -c \
  "SELECT count(*) AS joined_sets, coalesce(sum(moved_rows), 0) AS moved_rows FROM public.marketplace_join_reverse_pattern_versions(true);"
