#!/usr/bin/env bash
# Recreate Docker cardtrader-oracle-api on pokoin-marketplace.
# Public api.pokoin.com stays on the Pi. This process is the CardTrader GET
# host: full oracle-api-server against nezopt 15T via 127.0.0.1:15543.
set -euo pipefail
APP_ROOT="${CARDTRADER_ORACLE_API_ROOT:-$HOME/cardtrader-oracle-api}"
CURRENT="$APP_ROOT/current"
ENV_FILE="${CARDTRADER_ORACLE_API_ENV_FILE:-$APP_ROOT/.env}"
NAME="${CARDTRADER_ORACLE_API_CONTAINER:-cardtrader-oracle-api}"
IMAGE="${CARDTRADER_ORACLE_API_IMAGE:-node:20-bookworm}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE" >&2
  exit 1
fi
if [[ ! -f "$CURRENT/server/oracle-api-server.js" ]]; then
  echo "missing $CURRENT/server/oracle-api-server.js" >&2
  exit 1
fi

sudo docker rm -f "$NAME" >/dev/null 2>&1 || true
sudo docker run -d --name "$NAME" --restart unless-stopped --network host \
  --env-file "$ENV_FILE" \
  -e POKOIN_API_SERVICE_NAME=cardtrader-oracle-api \
  -e MARKETPLACE_DATABASE_SSL=0 \
  -e PIPELINE_HEALTH_SKIP=valkey,meili,cdn \
  -e PIPELINE_HEALTH_TIMEOUT_MS=4000 \
  -v "$CURRENT:/app" \
  -w /app \
  "$IMAGE" \
  node server/oracle-api-server.js
echo "started $NAME"
sudo docker ps --filter "name=$NAME" --format '{{.Names}} {{.Status}}'
