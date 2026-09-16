#!/usr/bin/env bash
# CLIP same-art groups for newly imported leftovers. Apply on nezopt 15T.
# After leftover ingest, or on its own:
#   scripts/match-imported-version-sets.sh --expansion "30th Celebration JP"
#   scripts/match-imported-version-sets.sh --ids 790994
set -euo pipefail
export HIP_VISIBLE_DEVICES="${HIP_VISIBLE_DEVICES:-0}"
PYTHON="${PYTHON:-/home/nez/Projects/ai-toolkit/venv/bin/python}"
SCRIPT="${CLUSTER:-/home/nez/Projects/pokemon-card-extension/scripts/cluster-name-version-sets.py}"
exec "$PYTHON" "$SCRIPT" --refresh-candidates "$@"
