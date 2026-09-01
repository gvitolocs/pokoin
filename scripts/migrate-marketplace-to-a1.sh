#!/usr/bin/env bash
# Move marketplace Postgres + oracle-api + Meili + Caddy from pokoin-marketplace
# (E2.1.Micro) onto pokoin-a1 (Always Free A1 2 OCPU / 12 GB).
# Does not terminate the old VM or delete volumes.
set -euo pipefail

TEN='ocid1.tenancy.oc1..aaaaaaaak3zcl33wj3lazht44cwa5rhm7uazxlqok22tfdfngrwtkoni67ia'
CF_ZONE='c34b54f800c8dce5511d47c552a33e46'
CF_RECORD='5b9cb6224aeb351dafc0a87f7e8c99ba'
OLD_HOST='pokoin-marketplace'
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS='-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20'

die() { echo "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null || die "missing $1"; }
need oci
need ssh
need rsync
need curl
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "CLOUDFLARE_API_TOKEN unset"

discover_a1() {
  oci compute instance list -c "$TEN" --all --output json | python3 -c '
import json,sys
items=json.load(sys.stdin)["data"]
for i in items:
    if i.get("display-name")=="pokoin-a1" and i.get("lifecycle-state")=="RUNNING":
        print(i["id"])
        break
'
}

a1_public_ip() {
  local id="$1"
  oci compute instance list-vnics --instance-id "$id" --query 'data[0]."public-ip"' --raw-output
}

wait_ssh() {
  local ip="$1"
  for _ in $(seq 1 60); do
    if ssh $SSH_OPTS -o ConnectTimeout=8 "ubuntu@${ip}" 'echo ok' >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  die "ssh to $ip never became ready"
}

ID="$(discover_a1)"
[[ -n "$ID" ]] || die "pokoin-a1 is not RUNNING yet"
IP="$(a1_public_ip "$ID")"
[[ -n "$IP" && "$IP" != "null" ]] || die "pokoin-a1 has no public IP"
echo "A1 $ID ip=$IP"

python3 - "$IP" <<'PY'
import sys
from pathlib import Path
ip = sys.argv[1]
p = Path.home() / ".ssh" / "config"
p.parent.mkdir(mode=0o700, exist_ok=True)
text = p.read_text() if p.exists() else ""
block = (
    f"Host pokoin-a1\n"
    f"  HostName {ip}\n"
    f"  User ubuntu\n"
    f"  IdentityFile ~/.ssh/id_ed25519\n"
    f"  StrictHostKeyChecking accept-new\n"
)
if "Host pokoin-a1" not in text:
    p.write_text(text.rstrip() + "\n\n" + block + "\n")
    raise SystemExit
lines = text.splitlines(True)
out = []
inh = False
replaced = False
for line in lines:
    if line.strip() == "Host pokoin-a1":
        inh = True
        out.append(line)
        continue
    if inh and line.startswith("Host "):
        inh = False
    if inh and line.strip().startswith("HostName"):
        out.append(f"  HostName {ip}\n")
        replaced = True
        continue
    out.append(line)
if not replaced:
    # Host exists but no HostName line
    rebuilt = []
    inh = False
    for line in out:
        rebuilt.append(line)
        if line.strip() == "Host pokoin-a1":
            rebuilt.append(f"  HostName {ip}\n")
    out = rebuilt
p.write_text("".join(out))
PY

wait_ssh "$IP"

# Stage docker env on the old box (never printed here)
ssh $SSH_OPTS "$OLD_HOST" 'docker exec pokoin-oracle-api printenv > /home/ubuntu/pokoin-oracle-api.docker.env && chmod 600 /home/ubuntu/pokoin-oracle-api.docker.env'

echo "== bootstrap packages =="
scp $SSH_OPTS "$ROOT/scripts/bootstrap-pokoin-a1.sh" "ubuntu@${IP}:/tmp/bootstrap-pokoin-a1.sh"
ssh $SSH_OPTS "ubuntu@${IP}" 'bash /tmp/bootstrap-pokoin-a1.sh'

echo "== rsync data/config =="
rsync -az --info=stats1 -e "ssh $SSH_OPTS" \
  "$OLD_HOST:/home/ubuntu/pokoin-oracle-api/" \
  "ubuntu@${IP}:/home/ubuntu/pokoin-oracle-api/"
rsync -az -e "ssh $SSH_OPTS" \
  "$OLD_HOST:/home/ubuntu/pokoin-oracle-api.env" \
  "$OLD_HOST:/home/ubuntu/pokoin-oracle-api.docker.env" \
  "$OLD_HOST:/home/ubuntu/postgres.migrate.env" \
  "ubuntu@${IP}:/home/ubuntu/"
rsync -az -e "ssh $SSH_OPTS" \
  "$OLD_HOST:/usr/local/bin/pokoin-meili-keepalive.sh" \
  "ubuntu@${IP}:/tmp/pokoin-meili-keepalive.sh"

ssh $SSH_OPTS "$OLD_HOST" 'sudo tar -C / -cf - \
  etc/pokemon-card-vault \
  etc/caddy/Caddyfile \
  etc/pokoinpos-postgres \
  etc/systemd/system/meilisearch.service \
  etc/systemd/system/pokoin-meili-keepalive.service \
  etc/systemd/system/pokoin-meili-keepalive.timer \
  etc/systemd/system/pokoin-meili-marketplace-delta.service \
  etc/systemd/system/pokoin-meili-marketplace-delta.timer \
  var/lib/meilisearch \
  var/backups/pokoinpos-postgres' \
| ssh $SSH_OPTS "ubuntu@${IP}" 'sudo tar -C / -xf -'

scp $SSH_OPTS /home/nez/backups/pokoin-marketplace/marketplace-20260830T165046Z.dump \
  "ubuntu@${IP}:/tmp/marketplace.dump"

echo "== start postgres (localhost only, 12GB-sized) =="
ssh $SSH_OPTS "ubuntu@${IP}" 'set -euo pipefail
sudo mkdir -p /var/lib/pokoinpos-postgres /var/backups/pokoinpos-postgres /etc/pokoinpos-postgres/certs
sudo chmod 600 /etc/pokoinpos-postgres/certs/server.key || true
docker rm -f pokoin-marketplace-postgres >/dev/null 2>&1 || true
docker pull postgres:17-alpine
docker run -d --name pokoin-marketplace-postgres --restart unless-stopped \
  --env-file /home/ubuntu/postgres.migrate.env \
  -p 127.0.0.1:5432:5432 \
  -v /var/lib/pokoinpos-postgres:/var/lib/postgresql/data \
  -v /etc/pokoinpos-postgres/certs:/var/lib/postgresql/certs:ro \
  -v /var/backups/pokoinpos-postgres:/backups \
  postgres:17-alpine \
  postgres \
    -c ssl=on \
    -c ssl_cert_file=/var/lib/postgresql/certs/server.crt \
    -c ssl_key_file=/var/lib/postgresql/certs/server.key \
    -c max_connections=80 \
    -c shared_buffers=2GB \
    -c effective_cache_size=6GB \
    -c work_mem=16MB \
    -c maintenance_work_mem=512MB \
    -c wal_level=minimal \
    -c max_wal_senders=0 \
    -c max_replication_slots=0 \
    -c statement_timeout=60000 \
    -c idle_in_transaction_session_timeout=30000
for i in $(seq 1 40); do
  docker exec pokoin-marketplace-postgres pg_isready && break
  sleep 2
done
docker exec pokoin-marketplace-postgres pg_isready
sudo cp /tmp/marketplace.dump /var/backups/pokoinpos-postgres/marketplace-pre-a1.dump
if ! docker exec pokoin-marketplace-postgres \
    sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT 1 FROM marketplace_search_candidates LIMIT 1\"" >/dev/null 2>&1; then
  docker exec pokoin-marketplace-postgres \
    sh -c "pg_restore -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" --no-owner --no-acl /backups/marketplace-pre-a1.dump" \
    || true
fi
docker exec pokoin-marketplace-postgres \
  sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM marketplace_search_candidates\""
'

echo "== meili + api =="
ssh $SSH_OPTS "ubuntu@${IP}" 'set -euo pipefail
sudo install -m 0755 /tmp/pokoin-meili-keepalive.sh /usr/local/bin/pokoin-meili-keepalive.sh
sudo chown -R meili:meili /opt/meilisearch /var/lib/meilisearch /etc/pokemon-card-vault
# Give Meili RAM now that we have 12 GB
sudo sed -i "s/MemoryMax=256M/MemoryMax=2G/" /etc/systemd/system/meilisearch.service || true
if grep -q max_indexing_memory /etc/pokemon-card-vault/meili.toml; then
  sudo sed -i "s/max_indexing_memory.*/max_indexing_memory = \"1Gb\"/" /etc/pokemon-card-vault/meili.toml
fi
sudo systemctl daemon-reload
sudo systemctl enable --now meilisearch.service
sudo systemctl enable --now pokoin-meili-keepalive.timer
sudo systemctl enable --now pokoin-meili-marketplace-delta.timer
docker pull node:20-bookworm
docker rm -f pokoin-oracle-api >/dev/null 2>&1 || true
docker run -d --name pokoin-oracle-api --restart unless-stopped --network host \
  --env-file /home/ubuntu/pokoin-oracle-api.docker.env \
  -v /home/ubuntu/pokoin-oracle-api/current:/app \
  -w /app \
  node:20-bookworm node server/oracle-api-server.js
sleep 2
curl -fsS --max-time 8 http://127.0.0.1:18080/api/__contract >/tmp/contract.json
python3 -c "import json; print(json.load(open(\"/tmp/contract.json\")).get(\"version\"))"
curl -fsS --max-time 12 "http://127.0.0.1:18080/api/marketplace-card-page?cardId=703358" >/dev/null
echo "on-box API ok"
'

echo "== cutover: stop old Caddy, point DNS, start new Caddy =="
ssh $SSH_OPTS "$OLD_HOST" 'sudo systemctl stop caddy'
curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/dns_records/${CF_RECORD}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"type\":\"A\",\"name\":\"api\",\"content\":\"${IP}\",\"ttl\":120,\"proxied\":false}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("dns", d.get("success"), (d.get("result") or {}).get("content"))'

ssh $SSH_OPTS "ubuntu@${IP}" 'set -euo pipefail
sudo mkdir -p /etc/caddy
sudo chown root:caddy /etc/caddy/Caddyfile || sudo chown root:root /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sleep 3
sudo systemctl is-active caddy
'

echo "wait for public HTTPS (TTL 120s)"
ok=0
for i in $(seq 1 40); do
  if curl -fsS --max-time 15 "https://api.pokoin.com/api/__contract" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 5
done
if [[ "$ok" != 1 ]]; then
  echo "public HTTPS failed — reverting DNS and old Caddy" >&2
  curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/dns_records/${CF_RECORD}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"type":"A","name":"api","content":"130.61.251.250","ttl":120,"proxied":false}' >/dev/null
  ssh $SSH_OPTS "$OLD_HOST" 'sudo systemctl start caddy'
  die "public https not answering; rolled back to marketplace micro"
fi
curl -sS --max-time 15 "https://api.pokoin.com/api/__contract" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version"))'
curl -sS --max-time 15 -o /dev/null -w "card %{http_code} %{time_total}\n" \
  "https://api.pokoin.com/api/marketplace-card-page?cardId=703358"
echo "migrate complete. old VM left running for rollback. do not delete volumes."
