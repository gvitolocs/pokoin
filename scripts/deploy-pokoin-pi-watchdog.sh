#!/bin/bash
# From nezopt: recover pi-home origin and install the 5-minute watchdog.
# The API, edge, CDN and ct-deals are one native Rust unit (pokoin-rust-api);
# /healthz and /readyz ship inside the Rust release (scripts/deploy-pokoin-rust.sh).
set -euo pipefail
HOST="${1:-pi-home}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
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

ssh "${SSH_OPTS[@]}" "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
systemctl reset-failed docker.service cloudflared.service pokoin-rust-api.service ssh.service sshd.service 2>/dev/null || true
systemctl start docker.service
sleep 2
docker start pokoin-marketplace-postgres-replica pokoin-redis 2>/dev/null || true
systemctl start pokoin-rust-api.service cloudflared.service ssh.service 2>/dev/null || true

install -o root -g root -m 755 /tmp/pokoin-pi-watchdog.sh /usr/local/sbin/pokoin-pi-watchdog.sh
install -o root -g root -m 755 /tmp/pokoin-pi-ro-watch.sh /usr/local/sbin/pokoin-pi-ro-watch.sh
install -o root -g root -m 644 /tmp/pokoin-pi-watchdog.service /etc/systemd/system/pokoin-pi-watchdog.service
install -o root -g root -m 644 /tmp/pokoin-pi-watchdog.timer /etc/systemd/system/pokoin-pi-watchdog.timer
install -o root -g root -m 644 /tmp/pokoin-pi-ro-watch.service /etc/systemd/system/pokoin-pi-ro-watch.service
bash /tmp/install-pokoin-pi-watchdog.sh

sleep 3
echo '--- ports ---'
ss -tlnp | grep -E '5432|6380|18079|18081|18082|18090' || true
echo '--- readyz ---'
curl -sS --max-time 8 http://127.0.0.1:18079/readyz || true
echo
echo '--- units ---'
systemctl is-active docker cloudflared pokoin-rust-api pokoin-pi-watchdog.timer || true
REMOTE
