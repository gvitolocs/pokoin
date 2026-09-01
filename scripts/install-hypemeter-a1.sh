#!/usr/bin/env bash
# Install Hypemeter + cloudflared on RUNNING pokoin-a1. Does not migrate marketplace.
set -euo pipefail

TEN='ocid1.tenancy.oc1..aaaaaaaak3zcl33wj3lazht44cwa5rhm7uazxlqok22tfdfngrwtkoni67ia'
VCN='ocid1.vcn.oc1.eu-frankfurt-1.amaaaaaaswfd3oiat73cnguklj4frboo6u76htuixsiwyypgap6hwschmfna'
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HYPE="${HYPEMETER_SRC:-/home/nez/Projects/hypemeter}"
SECRETS="${HYPEMETER_SECRETS:-/home/nez/secrets/deploy/hypemeter}"
SSH_KEY="${HYPEMETER_SSH_KEY:-$HOME/.ssh/id_ed25519}"
CUTOVER="${HYPEMETER_CUTOVER_DNS:-1}"

log() { echo "$(date -Is) $*"; }

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 1; }; }
need oci
need rsync
need ssh
need python3

mkdir -p "$SECRETS"
chmod 700 "$SECRETS"
if [[ ! -s "$SECRETS/cron.env" ]]; then
  umask 077
  printf 'CRON_SECRET=%s\n' "$(openssl rand -hex 32)" > "$SECRETS/cron.env"
  log "wrote $SECRETS/cron.env"
fi
if [[ ! -s "$SECRETS/tunnel.token" || ! -s "$SECRETS/tunnel.id" ]]; then
  bash "$ROOT/scripts/create-pokoin-news-tunnel.sh"
fi
# shellcheck disable=SC1091
source "$SECRETS/cron.env"
TUNNEL_ID="$(tr -d '[:space:]' < "$SECRETS/tunnel.id")"
[[ -n "${CRON_SECRET:-}" && -n "$TUNNEL_ID" ]]

row="$(oci compute instance list -c "$TEN" --all \
  --query "data[?\"display-name\"=='pokoin-a1'] | [0]" --output json)"
STATE="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "null"); print((d or {}).get("lifecycle-state") or "")' "$row")"
IID="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "null"); print((d or {}).get("id") or "")' "$row")"
[[ "$STATE" == "RUNNING" && -n "$IID" ]] || { echo "pokoin-a1 is not RUNNING (state=${STATE:-none})" >&2; exit 1; }
echo "$IID" > /tmp/pokoin-a1.instance.id

NSG_ID=""
if [[ -s "$SECRETS/nsg.id" ]]; then
  NSG_ID="$(tr -d '[:space:]' < "$SECRETS/nsg.id")"
fi
if [[ -z "$NSG_ID" ]]; then
  existing="$(oci network nsg list -c "$TEN" --vcn-id "$VCN" --all \
    --query "data[?\"display-name\"=='pokoin-a1-hypemeter'] | [0].id" --raw-output 2>/dev/null || true)"
  if [[ -n "$existing" && "$existing" != "null" ]]; then
    NSG_ID="$existing"
  else
    NSG_ID="$(oci network nsg create --compartment-id "$TEN" --vcn-id "$VCN" \
      --display-name pokoin-a1-hypemeter \
      --wait-for-state AVAILABLE --query data.id --raw-output)"
    oci network nsg rules add --nsg-id "$NSG_ID" --security-rules '[
      {"description":"SSH from nezopt","direction":"INGRESS","protocol":"6","source":"84.238.78.250/32","source-type":"CIDR_BLOCK","tcp-options":{"destination-port-range":{"min":22,"max":22}}},
      {"description":"egress all for tunnel","direction":"EGRESS","protocol":"all","destination":"0.0.0.0/0","destination-type":"CIDR_BLOCK"}
    ]' >/dev/null
  fi
  echo "$NSG_ID" > "$SECRETS/nsg.id"
  log "nsg $NSG_ID"
fi

VNIC="$(oci compute instance list-vnics --instance-id "$IID" --query 'data[0].{id:id,ip:"public-ip"}' --output json)"
VNIC_ID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$VNIC")"
IP="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["ip"] or "")' "$VNIC")"
[[ -n "$IP" ]] || { echo "no public IP on pokoin-a1" >&2; exit 1; }
echo "$IP" > /tmp/pokoin-a1.public.ip
log "pokoin-a1 $IID $IP"

oci network vnic update --vnic-id "$VNIC_ID" --nsg-ids "[\"$NSG_ID\"]" --force >/dev/null || true

SSH_CFG="$HOME/.ssh/config"
if grep -q '^Host pokoin-a1$' "$SSH_CFG" 2>/dev/null; then
  python3 - "$SSH_CFG" "$IP" <<'PY'
import pathlib, sys
p, ip = pathlib.Path(sys.argv[1]), sys.argv[2]
text = p.read_text()
out, in_host, done = [], False, False
for line in text.splitlines(True):
    if line.startswith("Host ") and in_host:
        in_host = False
    if line.strip() == "Host pokoin-a1":
        in_host = True
    if in_host and line.strip().startswith("HostName "):
        line = f"  HostName {ip}\n"
        done = True
    out.append(line)
p.write_text("".join(out))
if not done:
    raise SystemExit("pokoin-a1 HostName not updated")
PY
else
  cat >> "$SSH_CFG" <<EOF

Host pokoin-a1
  HostName $IP
  User ubuntu
  IdentityFile $SSH_KEY
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 4
EOF
fi

export SSH_AUTH_SOCK=""
ssh_opts=(-o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -i "$SSH_KEY" -o ConnectTimeout=10)
log "waiting for ssh"
for i in $(seq 1 60); do
  if ssh "${ssh_opts[@]}" ubuntu@"$IP" 'echo ssh_ok' 2>/dev/null; then
    break
  fi
  sleep 10
  [[ "$i" -eq 60 ]] && { echo "ssh timeout" >&2; exit 1; }
done

rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .git --exclude .vercel --exclude .data \
  --exclude .env --exclude .env.* \
  "$HYPE"/ ubuntu@"$IP":/home/ubuntu/hypemeter/
scp "${ssh_opts[@]}" "$SECRETS/cron.env" ubuntu@"$IP":/home/ubuntu/hypemeter/.env
# CRON_SECRET=... is valid compose env
printf 'CRON_SECRET=%s\n' "$CRON_SECRET" | ssh "${ssh_opts[@]}" ubuntu@"$IP" 'cat > /home/ubuntu/hypemeter/.env'

ssh "${ssh_opts[@]}" ubuntu@"$IP" 'bash -s' <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if [[ "$(uname -m)" != "aarch64" ]]; then
  echo "expected aarch64, got $(uname -m)" >&2
  exit 1
fi
sudo apt-get update -y
sudo apt-get install -y docker.io docker-compose-v2 curl ca-certificates
sudo usermod -aG docker ubuntu || true
sudo systemctl enable --now docker
cd /home/ubuntu/hypemeter
sudo docker compose --env-file /home/ubuntu/hypemeter/.env up -d --build
REMOTE

log "waiting for localhost:3000 on A1"
for i in $(seq 1 60); do
  if ssh "${ssh_opts[@]}" ubuntu@"$IP" 'curl -fsS -o /dev/null -w "%{http_code}" --max-time 8 http://127.0.0.1:3000/' | grep -qE '^(200|307|308)$'; then
    log "hypemeter localhost ok"
    break
  fi
  sleep 10
  [[ "$i" -eq 60 ]] && { echo "hypemeter did not become ready" >&2; exit 1; }
done

# cloudflared + timer
scp "${ssh_opts[@]}" \
  "$ROOT/scripts/hypemeter-a1/cloudflared-news.service" \
  "$ROOT/scripts/hypemeter-a1/hypemeter-revalidate.service" \
  "$ROOT/scripts/hypemeter-a1/hypemeter-revalidate.timer" \
  ubuntu@"$IP":/tmp/
scp "${ssh_opts[@]}" "$SECRETS/tunnel.token" ubuntu@"$IP":/tmp/pokoin-news.token
scp "${ssh_opts[@]}" "$SECRETS/cron.env" ubuntu@"$IP":/tmp/hypemeter-cron.env

ssh "${ssh_opts[@]}" ubuntu@"$IP" 'bash -s' <<'REMOTE'
set -euo pipefail
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL -o /tmp/cloudflared.deb \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
  sudo dpkg -i /tmp/cloudflared.deb
  rm -f /tmp/cloudflared.deb
fi
sudo mkdir -p /etc/cloudflared /etc/hypemeter
sudo install -m 600 /tmp/pokoin-news.token /etc/cloudflared/pokoin-news.token
sudo install -m 600 /tmp/hypemeter-cron.env /etc/hypemeter/cron.env
rm -f /tmp/pokoin-news.token /tmp/hypemeter-cron.env
sudo install -m 644 /tmp/cloudflared-news.service /etc/systemd/system/cloudflared-news.service
sudo install -m 644 /tmp/hypemeter-revalidate.service /etc/systemd/system/hypemeter-revalidate.service
sudo install -m 644 /tmp/hypemeter-revalidate.timer /etc/systemd/system/hypemeter-revalidate.timer
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-news.service
sudo systemctl enable --now hypemeter-revalidate.timer
sudo systemctl start hypemeter-revalidate.service || true
REMOTE

# Confirm nothing listens on public 80/443
ssh "${ssh_opts[@]}" ubuntu@"$IP" 'ss -lnt | awk "{print \$4}" | grep -E ":80$|:443$|:3000$" || true' | tee /tmp/pokoin-a1-listen.txt
if grep -qE '0\.0\.0\.0:3000|:::3000' /tmp/pokoin-a1-listen.txt; then
  echo "3000 is bound on all interfaces; expected 127.0.0.1 only" >&2
  exit 1
fi

log "waiting for cloudflared connector"
python3 - "$TUNNEL_ID" <<'PY'
import json, os, sys, time, urllib.request, urllib.error

acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
tid = sys.argv[1]

def headers():
    if os.environ.get("CLOUDFLARE_EMAIL") and os.environ.get("CLOUDFLARE_API_KEY"):
        return {
            "X-Auth-Email": os.environ["CLOUDFLARE_EMAIL"],
            "X-Auth-Key": os.environ["CLOUDFLARE_API_KEY"],
            "Content-Type": "application/json",
        }
    return {
        "Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}",
        "Content-Type": "application/json",
    }

for i in range(36):
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{acct}/cfd_tunnel/{tid}",
        headers=headers(),
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = json.load(resp)
    status = (out.get("result") or {}).get("status")
    print(f"tunnel_status={status}")
    if status in ("healthy", "up"):
        break
    time.sleep(5)
else:
    raise SystemExit("tunnel not healthy")
PY

if [[ "$CUTOVER" == "1" ]]; then
  log "cutting over news.pokoin.com CNAME to tunnel"
  python3 - "$TUNNEL_ID" <<'PY'
import json, os, sys, urllib.request

def headers():
    if os.environ.get("CLOUDFLARE_EMAIL") and os.environ.get("CLOUDFLARE_API_KEY"):
        return {
            "X-Auth-Email": os.environ["CLOUDFLARE_EMAIL"],
            "X-Auth-Key": os.environ["CLOUDFLARE_API_KEY"],
            "Content-Type": "application/json",
        }
    return {
        "Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}",
        "Content-Type": "application/json",
    }

zone = os.environ["CLOUDFLARE_ZONE_ID"]
tid = sys.argv[1]
target = f"{tid}.cfargotunnel.com"
req = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/zones/{zone}/dns_records?name=news.pokoin.com",
    headers=headers(),
)
with urllib.request.urlopen(req, timeout=30) as resp:
    listed = json.load(resp)
recs = listed.get("result") or []
if not recs:
    raise SystemExit("news.pokoin.com DNS record missing")
rid = recs[0]["id"]
body = json.dumps({
    "type": "CNAME",
    "name": "news",
    "content": target,
    "proxied": True,
    "comment": "pokoin-news named tunnel; origin IP hidden",
}).encode()
req = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/zones/{zone}/dns_records/{rid}",
    data=body,
    method="PATCH",
    headers=headers(),
)
with urllib.request.urlopen(req, timeout=30) as resp:
    out = json.load(resp)
if not out.get("success"):
    raise SystemExit("dns_patch_failed " + json.dumps(out.get("errors"))[:400])
print("dns", out["result"]["name"], out["result"]["content"], "proxied", out["result"]["proxied"])
PY
fi

if [[ "$CUTOVER" == "1" ]]; then
  log "verifying https://news.pokoin.com is A1 (no x-vercel-id)"
  ok=0
  for i in $(seq 1 36); do
    hdr="$(curl -sSI --max-time 20 https://news.pokoin.com/ || true)"
    if echo "$hdr" | grep -qi '^x-vercel-id:'; then
      log "still_vercel attempt=$i"
      sleep 5
      continue
    fi
    code="$(echo "$hdr" | awk 'NR==1 { print $2 }')"
    if echo "$hdr" | grep -qi '^cf-ray:' && [[ "$code" =~ ^2 ]]; then
      log "news.pokoin.com HTTP $code no x-vercel-id"
      ok=1
      break
    fi
    sleep 5
  done
  [[ "$ok" == "1" ]] || { echo "cutover verify failed" >&2; exit 1; }
fi

log "HYPEMETER_A1_READY ip=$IP tunnel=$TUNNEL_ID"
echo "$IP"
