#!/usr/bin/env bash
# Poll until pokoin-a1 is RUNNING, then install Hypemeter (no marketplace migrate).
set -euo pipefail
TEN='ocid1.tenancy.oc1..aaaaaaaak3zcl33wj3lazht44cwa5rhm7uazxlqok22tfdfngrwtkoni67ia'
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/pokoin-a1-wait-hypemeter.log

echo "$(date -Is) watching for pokoin-a1 (news only)" | tee -a "$LOG"
while true; do
  state=$(oci compute instance list -c "$TEN" --all \
    --query "data[?\"display-name\"=='pokoin-a1'] | [0].\"lifecycle-state\"" --raw-output 2>/dev/null || true)
  echo "$(date -Is) a1_state=${state:-none}" | tee -a "$LOG"
  if [[ "$state" == "RUNNING" ]]; then
    if bash "$ROOT/scripts/install-hypemeter-a1.sh"; then
      echo "$(date -Is) install ok" | tee -a "$LOG"
      exit 0
    fi
    echo "$(date -Is) install failed; retry in 90s" | tee -a "$LOG"
    sleep 90
    continue
  fi
  sleep 45
done
