#!/usr/bin/env bash
# Move marketplace writer Postgres PGDATA onto nezopt NVMe.
# Keep container name pokoin-marketplace-postgres-15t and host port 25432
# so Oracle :15543, Pi replica LAN, and listing writes stay on the same hop.
set -euo pipefail

SRC="${POKOIN_PG_HDD:-/home/nez/mnt/mybook/pokoin-marketplace-postgres}"
DST="${POKOIN_PG_NVME:-/home/nez/data/pokoin-marketplace-postgres}"
NAME="${POKOIN_MARKETPLACE_POSTGRES:-pokoin-marketplace-postgres-15t}"
IMAGE="${POKOIN_POSTGRES_IMAGE:-postgres:17-alpine}"

if [[ ! -d "$SRC/data" ]]; then
  echo "missing HDD PGDATA $SRC/data" >&2
  exit 1
fi

if docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -qx true; then
  echo "stop $NAME (fast shutdown)"
  docker stop -t 60 "$NAME"
fi

mkdir -p "$DST/data" "$DST/run" "$DST/secrets"
echo "rsync PGDATA $SRC -> $DST"
set +e
ionice -c2 -n7 nice -n 5 rsync -aHAX --numeric-ids --info=stats2 \
  "$SRC/data/" "$DST/data/"
rs=$?
set -e
if [[ "$rs" -ne 0 && "$rs" -ne 24 ]]; then
  echo "rsync PGDATA failed with $rs" >&2
  exit "$rs"
fi
ionice -c2 -n7 rsync -aHAX --numeric-ids "$SRC/secrets/" "$DST/secrets/"
ionice -c2 -n7 rsync -aHAX --numeric-ids "$SRC/run/" "$DST/run/" || true

PASS="$(
  docker inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | awk -F= '$1=="POSTGRES_PASSWORD"{print substr($0, index($0,"=")+1); exit}'
)"
if [[ -z "$PASS" && -f "$DST/secrets/pgpass" ]]; then
  PASS="$(tr -d '\n' < "$DST/secrets/pgpass")"
fi
if [[ -z "$PASS" && -f "$SRC/secrets/pgpass" ]]; then
  PASS="$(tr -d '\n' < "$SRC/secrets/pgpass")"
fi
if [[ -z "$PASS" ]]; then
  echo "POSTGRES_PASSWORD missing on $NAME" >&2
  exit 1
fi

echo "recreate $NAME on NVMe, ports 127.0.0.1:25432 and 192.168.178.55:25432"
docker rm "$NAME" >/dev/null
docker run -d --name "$NAME" \
  --restart unless-stopped \
  --user 1000:1000 \
  --shm-size 5g \
  --memory 16g \
  --stop-signal SIGINT \
  -e POSTGRES_USER=pokoin_marketplace \
  -e POSTGRES_PASSWORD="$PASS" \
  -e POSTGRES_DB=pokoin_marketplace \
  -p 127.0.0.1:25432:5432 \
  -p 192.168.178.55:25432:5432 \
  -v "$DST/data:/var/lib/postgresql/data" \
  -v "$DST/run:/var/run/postgresql" \
  "$IMAGE" \
  postgres \
    -c listen_addresses=* \
    -c wal_level=replica \
    -c max_wal_senders=8 \
    -c max_replication_slots=8 \
    -c hot_standby=on \
    -c shared_buffers=4GB \
    -c effective_cache_size=12GB \
    -c work_mem=64MB \
    -c maintenance_work_mem=1GB \
    -c max_wal_size=4GB \
    -c checkpoint_timeout=15min

for i in $(seq 1 30); do
  if docker exec "$NAME" pg_isready -U pokoin_marketplace -d pokoin_marketplace >/dev/null 2>&1; then
    echo "ready after ${i}s"
    break
  fi
  sleep 1
done
docker exec "$NAME" pg_isready -U pokoin_marketplace -d pokoin_marketplace
ss -lptn | grep 25432 || true
echo "writer PGDATA $DST/data (HDD copy left at $SRC for rollback)"

ROOT="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
if [[ -f "$ROOT/pokoin-postgres-nvme.service" ]]; then
  install -d "$UNIT_DIR"
  install -m 644 "$ROOT/pokoin-postgres-nvme.service" \
    "$UNIT_DIR/pokoin-postgres-15t.service"
  systemctl --user daemon-reload
  systemctl --user disable --now pokoin-postgres-15t-night-off.timer 2>/dev/null || true
  systemctl --user disable --now pokoin-postgres-15t-day-on.timer 2>/dev/null || true
  systemctl --user enable --now pokoin-postgres-15t.service
fi
