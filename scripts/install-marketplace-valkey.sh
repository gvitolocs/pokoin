#!/usr/bin/env bash
# Tiny Valkey on pokoin-marketplace for CT asks + non-empty home snapshots.
# Does not go on pokoin-peer1. Does not replace Postgres or Supabase rails.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS='-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20'
HOST="${1:-pokoin-marketplace}"

scp $SSH_OPTS "$ROOT/scripts/valkey.conf" "$HOST:/tmp/pokoin-valkey.conf"

ssh $SSH_OPTS "$HOST" 'set -euo pipefail
sudo mkdir -p /home/ubuntu/valkey
sudo install -m 0644 /tmp/pokoin-valkey.conf /home/ubuntu/valkey/valkey.conf
if ! docker image inspect valkey/valkey:8 >/dev/null 2>&1; then
  docker pull valkey/valkey:8
fi
docker rm -f pokoin-valkey >/dev/null 2>&1 || true
docker run -d --name pokoin-valkey --restart unless-stopped \
  --memory=48m --memory-swap=48m \
  --network host \
  -v /home/ubuntu/valkey/valkey.conf:/etc/valkey/valkey.conf:ro \
  valkey/valkey:8 \
  valkey-server /etc/valkey/valkey.conf
sleep 1
docker exec pokoin-valkey valkey-cli -h 127.0.0.1 ping
'
