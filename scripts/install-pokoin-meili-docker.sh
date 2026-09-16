#!/usr/bin/env bash
# Pin Pi Docker pokoin-meili to getmeili/meilisearch:v1.53.1.
# Does not wipe /srv/pokoin/meili/data.ms. Recreate without --import-dump
# when that DB already exists (re-import would refuse a live data.ms).
set -euo pipefail
HOST="${1:-pi-home}"
MEILI_VERSION="${MEILI_VERSION:-v1.53.1}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)

ssh "${SSH_OPTS[@]}" "$HOST" "MEILI_VERSION='$MEILI_VERSION'" bash -s <<'REMOTE'
set -euo pipefail
MEILI_VERSION="${MEILI_VERSION:-v1.53.1}"
IMAGE="getmeili/meilisearch:${MEILI_VERSION}"
DIR=/srv/pokoin/meili
NAME=pokoin-meili
if [[ ! -f "${DIR}/docker.env" ]]; then
  echo "missing ${DIR}/docker.env" >&2
  exit 1
fi
if [[ ! -d "${DIR}/data.ms" ]]; then
  echo "missing ${DIR}/data.ms — restore or dump-import before pinning ${IMAGE}" >&2
  exit 1
fi

echo "=== pull ${IMAGE} ==="
docker pull "$IMAGE"

current="$(docker inspect "$NAME" --format '{{.Config.Image}}' 2>/dev/null || true)"
if [[ "$current" != "$IMAGE" ]]; then
  echo "=== recreate ${NAME} ${current:-missing} -> ${IMAGE} ==="
  systemctl stop pokoin-pi-watchdog.timer pokoin-meili-keepalive.timer pokoin-meili-marketplace-delta.timer 2>/dev/null || true
  docker stop "$NAME" 2>/dev/null || true
  docker rm "$NAME" 2>/dev/null || true
  docker run -d --name "$NAME" --network host --restart always \
    --env-file "${DIR}/docker.env" \
    -v "${DIR}:/meili_data" \
    "$IMAGE"
  systemctl start pokoin-pi-watchdog.timer pokoin-meili-keepalive.timer pokoin-meili-marketplace-delta.timer 2>/dev/null || true
else
  echo "=== ${NAME} already on ${IMAGE} ==="
  docker start "$NAME" >/dev/null 2>&1 || true
fi

mkdir -p /etc/systemd/system/pokoin-meili-keepalive.service.d
cat >/etc/systemd/system/pokoin-meili-keepalive.service.d/docker-data.conf <<'EOF'
[Service]
Environment=MEILI_DB_PATH=/srv/pokoin/meili/data.ms
EnvironmentFile=-/srv/pokoin/meili/docker.env
EOF
systemctl daemon-reload

echo "=== drop 1.10 leftovers ==="
rm -rf "${DIR}/data.ms.v1.10.3.bak"
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^getmeili/meilisearch:v1\.10' | while read -r old; do
  docker rmi "$old" || true
done

for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 http://127.0.0.1:7700/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:7700/health
echo
docker inspect "$NAME" --format 'image={{.Config.Image}} status={{.State.Status}}'
docker images getmeili/meilisearch
ls -d "${DIR}/data.ms.v1.10.3.bak" 2>/dev/null && echo "ERROR: 1.10 backup still present" >&2 || echo "no 1.10 data.ms backup"
REMOTE
