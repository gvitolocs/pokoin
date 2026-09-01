#!/usr/bin/env bash
# Always Free Ampere A1: 2 OCPU / 12 GB only. Never 4/24 (paid).
# When the instance is RUNNING, migrate marketplace onto it.
set -euo pipefail

TEN='ocid1.tenancy.oc1..aaaaaaaak3zcl33wj3lazht44cwa5rhm7uazxlqok22tfdfngrwtkoni67ia'
SUB='ocid1.subnet.oc1.eu-frankfurt-1.aaaaaaaampqmvhj52olkjyrmof3hlbjyz7a54nu4gprdo3hxsptn35dfniyq'
IMG='ocid1.image.oc1.eu-frankfurt-1.aaaaaaaatnudwzlqzctpx5rrxohiionypan5fngceqdbybtw6ve7oyhmnnqq'
KEY=/home/nez/.ssh/id_ed25519.pub
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/pokoin-a1-2x12-hunt.log
ADS=(
  'xNiL:EU-FRANKFURT-1-AD-1'
  'xNiL:EU-FRANKFURT-1-AD-2'
  'xNiL:EU-FRANKFURT-1-AD-3'
)

log() { echo "$(date -Is) $*" | tee -a "$LOG"; }

a1_state() {
  oci compute instance list -c "$TEN" --all \
    --query "data[?\"display-name\"=='pokoin-a1'] | [0].\"lifecycle-state\"" --raw-output 2>/dev/null || true
}

try_launch() {
  local ad="$1"
  local err
  err=$(mktemp)
  set +e
  timeout -k 5 20 oci compute instance launch \
    --availability-domain "$ad" \
    --compartment-id "$TEN" \
    --display-name pokoin-a1 \
    --shape VM.Standard.A1.Flex \
    --shape-config '{"ocpus":2.0,"memoryInGBs":12.0}' \
    --subnet-id "$SUB" \
    --image-id "$IMG" \
    --assign-public-ip true \
    --ssh-authorized-keys-file "$KEY" \
    --freeform-tags '{"pokoin":"always-free-a1"}' \
    --output json > /tmp/pokoin-a1-launch.json 2>"$err"
  local rc=$?
  set -e
  local msg
  msg=$(tr '\n' ' ' < "$err" | tail -c 400)
  rm -f "$err"
  log "launch $ad rc=$rc ${msg:0:220}"
  return "$rc"
}

log "start 2/12 hunt"
i=0
while true; do
  st="$(a1_state)"
  log "state=${st:-none}"
  if [[ "$st" == "RUNNING" ]]; then
    log "RUNNING — migrating"
    exec bash "$ROOT/scripts/migrate-marketplace-to-a1.sh"
  fi
  if [[ "$st" == "PROVISIONING" || "$st" == "STARTING" ]]; then
    sleep 20
    continue
  fi
  ad="${ADS[$((i % 3))]}"
  i=$((i + 1))
  try_launch "$ad" && true
  # success json with id
  if python3 -c 'import json,sys; json.load(open("/tmp/pokoin-a1-launch.json"))["data"]["id"]' 2>/dev/null; then
    log "launch accepted, waiting for RUNNING"
    sleep 15
    continue
  fi
  sleep 90
done
