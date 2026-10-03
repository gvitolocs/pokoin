#!/usr/bin/env bash
# Redis Open Source 8.10.2 with Search, on the Pi, loopback only.
# Cache keys carry a TTL. The search index does not, so volatile-lru
# cannot evict it. Postgres stays the source of truth.
set -euo pipefail

PI="${PI_HOST:-pi-home}"
IMAGE="redis:8.10.2"
NAME="pokoin-redis"
PORT="${POKOIN_REDIS_PORT:-6380}"

say() { echo "== $*"; }

say "Redis Open Source 8.10.2 on $PI port $PORT"
ssh "$PI" "set -euo pipefail
docker pull $IMAGE >/dev/null
mkdir -p /srv/pokoin/redis/data
if [[ ! -f /srv/pokoin/redis/redis.conf ]]; then
  cat > /srv/pokoin/redis/redis.conf <<'EOF'
bind 0.0.0.0
port 6379
protected-mode no
daemonize no
dir /data
appendonly yes
appendfsync everysec
save 3600 1
maxmemory 1400mb
maxmemory-policy volatile-lru
timeout 0
tcp-keepalive 60
loglevel notice
EOF
fi
sysctl -w vm.overcommit_memory=1 >/dev/null || true
docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME --restart unless-stopped \
  --memory=1600m --memory-swap=1600m \
  -p 127.0.0.1:${PORT}:6379 \
  -v /srv/pokoin/redis/data:/data \
  -v /srv/pokoin/redis/redis.conf:/usr/local/etc/redis/redis.conf:ro \
  $IMAGE \
  redis-server /usr/local/etc/redis/redis.conf
for i in \$(seq 1 20); do
  if docker exec $NAME redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG; then
    docker exec $NAME redis-cli -h 127.0.0.1 INFO server | awk -F: '/redis_version|redis_mode/{print}'
    docker exec $NAME redis-cli -h 127.0.0.1 MODULE LIST
    exit 0
  fi
  sleep 0.4
done
docker logs $NAME | tail -40
exit 1
"
say "pokoin-redis listening on 127.0.0.1:$PORT"
