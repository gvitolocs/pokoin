#!/usr/bin/env bash
# Poll until pokoin-a1 is RUNNING, then migrate marketplace onto it.
set -euo pipefail
TEN='ocid1.tenancy.oc1..aaaaaaaak3zcl33wj3lazht44cwa5rhm7uazxlqok22tfdfngrwtkoni67ia'
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/pokoin-a1-wait-migrate.log

echo "$(date -Is) watching for pokoin-a1" | tee -a "$LOG"
while true; do
  state=$(oci compute instance list -c "$TEN" --all \
    --query "data[?\"display-name\"=='pokoin-a1'] | [0].\"lifecycle-state\"" --raw-output 2>/dev/null || true)
  echo "$(date -Is) a1_state=${state:-none}" | tee -a "$LOG"
  if [[ "$state" == "RUNNING" ]]; then
    exec bash "$ROOT/scripts/migrate-marketplace-to-a1.sh"
  fi
  sleep 45
done
