#!/bin/bash
# From nezopt: recover pi-home origin, install 5-minute watchdog, ship pipeline /healthz.
set -euo pipefail
HOST="${1:-pi-home}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
API_SRC="${POKOIN_API_SRC:-/home/nez/Projects/cardvault/pokemon_card_vault}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)

echo "copying watchdog"
scp "${SSH_OPTS[@]}" \
  "$ROOT/pokoin-pi-watchdog.sh" \
  "$ROOT/pokoin-pi-ro-watch.sh" \
  "$ROOT/pokoin-pi-watchdog.service" \
  "$ROOT/pokoin-pi-watchdog.timer" \
  "$ROOT/pokoin-pi-ro-watch.service" \
  "$ROOT/install-pokoin-pi-watchdog.sh" \
  "$HOST:/tmp/"

echo "copying pipeline health"
scp "${SSH_OPTS[@]}" \
  "$API_SRC/api/_pipeline_health.js" \
  "$API_SRC/server/oracle-api-server.js" \
  "$HOST:/tmp/"

ssh "${SSH_OPTS[@]}" "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
systemctl reset-failed docker.service cloudflared.service pokoin-card-images.service pokoin-api-edge.service ssh.service sshd.service 2>/dev/null || true
systemctl start docker.service
sleep 2
docker start pokoin-marketplace-postgres-replica pokoin-oracle-api pokoin-meili pokoin-valkey 2>/dev/null || true
# Do not start pokoin-card-images docker; CDN is systemd Node on :18081.
systemctl start pokoin-card-images.service pokoin-api-edge.service cloudflared.service ssh.service 2>/dev/null || true

# Ship pipeline /healthz into the live API bind-mount if present.
mount_src="$(docker inspect pokoin-oracle-api --format '{{range .Mounts}}{{if eq .Destination "/app"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
if [ -n "${mount_src:-}" ] && [ -d "$mount_src" ]; then
  mkdir -p "$mount_src/api" "$mount_src/server"
  cp /tmp/_pipeline_health.js "$mount_src/api/_pipeline_health.js"
  cp /tmp/oracle-api-server.js "$mount_src/server/oracle-api-server.js"
  docker restart pokoin-oracle-api >/dev/null
  echo "pipeline health copied to $mount_src"
else
  echo "pokoin-oracle-api bind-mount not found; healthz not updated yet"
fi

install -o root -g root -m 755 /tmp/pokoin-pi-watchdog.sh /usr/local/sbin/pokoin-pi-watchdog.sh
install -o root -g root -m 755 /tmp/pokoin-pi-ro-watch.sh /usr/local/sbin/pokoin-pi-ro-watch.sh
install -o root -g root -m 644 /tmp/pokoin-pi-watchdog.service /etc/systemd/system/pokoin-pi-watchdog.service
install -o root -g root -m 644 /tmp/pokoin-pi-watchdog.timer /etc/systemd/system/pokoin-pi-watchdog.timer
install -o root -g root -m 644 /tmp/pokoin-pi-ro-watch.service /etc/systemd/system/pokoin-pi-ro-watch.service
bash /tmp/install-pokoin-pi-watchdog.sh

sleep 3
echo '--- ports ---'
ss -tlnp | grep -E '5432|18079|18080|18081|6379|7700' || true
echo '--- healthz ---'
curl -sS --max-time 8 http://127.0.0.1:18080/healthz || true
echo
echo '--- units ---'
systemctl is-active docker cloudflared pokoin-card-images pokoin-api-edge pokoin-pi-watchdog.timer || true
REMOTE
