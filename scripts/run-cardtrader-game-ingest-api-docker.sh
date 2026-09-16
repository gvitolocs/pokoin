#!/usr/bin/env bash
# Recreate Docker cardtrader-game-ingest-api on pokoin-marketplace.
# Per-game ingest HTTP APIs write isolated catalogs to nezopt 15T.
# Public Pokemon API stays on the Pi (pokoin-oracle-api).
set -euo pipefail
APP_ROOT="${CARDTRADER_ORACLE_API_ROOT:-$HOME/cardtrader-oracle-api}"
CURRENT="$APP_ROOT/current"
ENV_FILE="${CARDTRADER_GAME_INGEST_ENV_FILE:-$APP_ROOT/.env.ingest}"
FALLBACK_ENV="${CARDTRADER_ORACLE_API_ENV_FILE:-$APP_ROOT/.env}"
NAME="${CARDTRADER_GAME_INGEST_CONTAINER:-cardtrader-game-ingest-api}"
IMAGE="${CARDTRADER_ORACLE_API_IMAGE:-node:20-bookworm}"
PORT="${CARDTRADER_INGEST_PORT:-18082}"

if [[ ! -f "$ENV_FILE" && -f "$FALLBACK_ENV" ]]; then
  ENV_FILE="$FALLBACK_ENV"
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE" >&2
  exit 1
fi
if [[ ! -f "$CURRENT/server/cardtrader-game-ingest-server.js" ]]; then
  echo "missing $CURRENT/server/cardtrader-game-ingest-server.js" >&2
  exit 1
fi

sudo docker rm -f "$NAME" >/dev/null 2>&1 || true
sudo docker run -d --name "$NAME" --restart unless-stopped --network host \
  --env-file "$ENV_FILE" \
  -e POKOIN_API_SERVICE_NAME=cardtrader-game-ingest-api \
  -e MARKETPLACE_DATABASE_SSL=0 \
  -e PORT="$PORT" \
  -e CARDTRADER_INGEST_PORT="$PORT" \
  -e ORACLE_API_HOST=127.0.0.1 \
  -e PIPELINE_HEALTH_SKIP=valkey,meili,cdn \
  -v "$CURRENT:/app" \
  -w /app \
  "$IMAGE" \
  node server/cardtrader-game-ingest-server.js
echo "started $NAME :$PORT"
sudo docker ps --filter "name=$NAME" --format '{{.Names}} {{.Status}}'
