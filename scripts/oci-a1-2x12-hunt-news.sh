#!/usr/bin/env bash
# Always Free Ampere A1: target 2 OCPU / 12 GB. Never 4/24 (paid).
# If 2/12 is rejected, try 1/6 then resize up. Hunt only — no marketplace migrate.
set -euo pipefail

TEN='ocid1.tenancy.oc1..aaaaaaaak3zcl33wj3lazht44cwa5rhm7uazxlqok22tfdfngrwtkoni67ia'
SUB='ocid1.subnet.oc1.eu-frankfurt-1.aaaaaaaampqmvhj52olkjyrmof3hlbjyz7a54nu4gprdo3hxsptn35dfniyq'
IMG='ocid1.image.oc1.eu-frankfurt-1.aaaaaaaatnudwzlqzctpx5rrxohiionypan5fngceqdbybtw6ve7oyhmnnqq'
KEY=/home/nez/.ssh/id_ed25519.pub
LOG=/tmp/pokoin-a1-news-hunt.log
IDFILE=/tmp/pokoin-a1.instance.id
ADS=(
  'xNiL:EU-FRANKFURT-1-AD-1'
  'xNiL:EU-FRANKFURT-1-AD-2'
  'xNiL:EU-FRANKFURT-1-AD-3'
)

log() { echo "$(date -Is) $*" | tee -a "$LOG"; }

a1_row() {
  oci compute instance list -c "$TEN" --all \
    --query "data[?\"display-name\"=='pokoin-a1'] | [0]" --output json 2>/dev/null || echo null
}

try_launch() {
  local ad="$1" ocpu="$2" mem="$3"
  local err
  err=$(mktemp)
  rm -f /tmp/pokoin-a1-launch.json
  set +e
  timeout -k 5 25 oci compute instance launch \
    --availability-domain "$ad" \
    --compartment-id "$TEN" \
    --display-name pokoin-a1 \
    --shape VM.Standard.A1.Flex \
    --shape-config "{\"ocpus\":${ocpu},\"memoryInGBs\":${mem}}" \
    --subnet-id "$SUB" \
    --image-id "$IMG" \
    --assign-public-ip true \
    --ssh-authorized-keys-file "$KEY" \
    --freeform-tags '{"pokoin":"always-free-a1","role":"hypemeter-news"}' \
    --output json > /tmp/pokoin-a1-launch.json 2>"$err"
  local rc=$?
  set -e
  cp "$err" /tmp/pokoin-a1-launch.err || true
  local msg
  msg=$(tr '\n' ' ' < "$err" | tail -c 400)
  rm -f "$err"
  log "launch $ad ${ocpu}x${mem} rc=$rc ${msg:0:180}"
  return "$rc"
}

launch_accepted() {
  python3 -c 'import json; json.load(open("/tmp/pokoin-a1-launch.json"))["data"]["id"]' 2>/dev/null
}

maybe_scale_2x12() {
  local id="$1" row="$2"
  local ocpu mem
  ocpu="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "null") or {}; print((d.get("shape-config") or {}).get("ocpus") or 0)' "$row")"
  mem="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "null") or {}; print((d.get("shape-config") or {}).get("memory-in-gbs") or 0)' "$row")"
  python3 -c "import sys; sys.exit(0 if float('$ocpu')>=2 and float('$mem')>=12 else 1)" && return 0
  log "scaling $id from ${ocpu}x${mem} to 2/12"
  set +e
  oci compute instance update --instance-id "$id" \
    --shape-config '{"ocpus":2.0,"memoryInGBs":12.0}' \
    --force --wait-for-state RUNNING --max-wait-seconds 180 >/tmp/pokoin-a1-scale.json 2>/tmp/pokoin-a1-scale.err
  local rc=$?
  set -e
  log "scale rc=$rc $(tr '\n' ' ' < /tmp/pokoin-a1-scale.err | tail -c 160)"
  return 0
}

log "start A1 hunt (news only, no marketplace migrate; prefer 2/12)"
i=0
while true; do
  row="$(a1_row)"
  st="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "null"); print((d or {}).get("lifecycle-state") or "")' "$row")"
  id="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "null"); print((d or {}).get("id") or "")' "$row")"
  log "state=${st:-none}"
  if [[ "$st" == "RUNNING" && -n "$id" ]]; then
    echo "$id" > "$IDFILE"
    maybe_scale_2x12 "$id" "$row" || true
    log "RUNNING $id"
    exit 0
  fi
  if [[ "$st" == "PROVISIONING" || "$st" == "STARTING" ]]; then
    sleep 20
    continue
  fi
  ad="${ADS[$((i % 3))]}"
  i=$((i + 1))
  try_launch "$ad" 2 12 || true
  if launch_accepted; then
    log "launch accepted 2/12, waiting for RUNNING"
    sleep 15
    continue
  fi
  try_launch "$ad" 1 6 || true
  if launch_accepted; then
    log "launch accepted 1/6 (will scale to 2/12), waiting for RUNNING"
    sleep 15
    continue
  fi
  sleep 8
done
