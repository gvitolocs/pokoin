#!/usr/bin/env bash
# Deploy cardtrader-game-ingest-api onto pokoin-marketplace.
# Does not restart cardtrader-oracle-api or the Pi Pokemon public API.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${CARDVAULT_SRC:-/home/nez/Projects/cardvault/pokemon_card_vault}"
HOST="${CARDTRADER_ORACLE_HOST:-pokoin-marketplace}"
SSH_OPTS='-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20'
REMOTE_ROOT=/home/ubuntu/cardtrader-oracle-api

if [[ ! -f "$SRC/server/cardtrader-game-ingest-server.js" ]]; then
  echo "cardvault missing ingest server at $SRC" >&2
  exit 1
fi

ssh $SSH_OPTS "$HOST" "mkdir -p $REMOTE_ROOT/current $REMOTE_ROOT/logs"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .env --exclude '.env.*' \
  --exclude build --exclude android --exclude ios --exclude macos \
  --exclude assets --exclude data --exclude integrations --exclude tools \
  --exclude web --exclude logs --exclude .dart_tool --exclude coverage \
  -e "ssh $SSH_OPTS" \
  "$SRC/" "$HOST:$REMOTE_ROOT/current/"
scp $SSH_OPTS "$ROOT/scripts/run-cardtrader-game-ingest-api-docker.sh" \
  "$HOST:$REMOTE_ROOT/run-cardtrader-game-ingest-api-docker.sh"

ssh $SSH_OPTS "$HOST" "bash -s" <<REMOTE
set -euo pipefail
chmod +x $REMOTE_ROOT/run-cardtrader-game-ingest-api-docker.sh
python3 - <<'PY'
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
src = Path("$REMOTE_ROOT/.env")
dst = Path("$REMOTE_ROOT/.env.ingest")
if not src.exists():
    raise SystemExit("missing $REMOTE_ROOT/.env")
lines = src.read_text().splitlines()
url = ""
out = []
seen = set()
for line in lines:
    if line.startswith("MARKETPLACE_DATABASE_URL="):
        url = line.split("=", 1)[1].strip()
    if line.startswith("POKOIN_API_SERVICE_NAME="):
        continue
    out.append(line)
if not url:
    raise SystemExit("MARKETPLACE_DATABASE_URL missing")
parsed = urlsplit(url)
dbs = {
    "MAGIC_MARKETPLACE_DATABASE_URL": "pokoin_magic",
    "YUGIOH_MARKETPLACE_DATABASE_URL": "pokoin_yugioh",
    "FLESH_AND_BLOOD_MARKETPLACE_DATABASE_URL": "pokoin_flesh_and_blood",
    "DIGIMON_MARKETPLACE_DATABASE_URL": "pokoin_digimon",
    "DRAGON_BALL_SUPER_MARKETPLACE_DATABASE_URL": "pokoin_dragon_ball_super",
    "VANGUARD_MARKETPLACE_DATABASE_URL": "pokoin_vanguard",
    "ONE_PIECE_MARKETPLACE_DATABASE_URL": "pokoin_one_piece",
    "LORCANA_MARKETPLACE_DATABASE_URL": "pokoin_lorcana",
    "STAR_WARS_MARKETPLACE_DATABASE_URL": "pokoin_star_wars",
    "UNION_ARENA_MARKETPLACE_DATABASE_URL": "pokoin_union_arena",
    "RIFTBOUND_MARKETPLACE_DATABASE_URL": "pokoin_riftbound",
    "GUNDAM_MARKETPLACE_DATABASE_URL": "pokoin_gundam",
    "SORCERY_MARKETPLACE_DATABASE_URL": "pokoin_sorcery",
}
for key, db in dbs.items():
    derived = urlunsplit((parsed.scheme, parsed.netloc, "/" + db, parsed.query, parsed.fragment))
    out = [line for line in out if not line.startswith(key + "=")]
    out.append(f"{key}={derived}")
out.append("POKOIN_API_SERVICE_NAME=cardtrader-game-ingest-api")
if not any(line.startswith("MARKETPLACE_DATABASE_SSL=") for line in out):
    out.append("MARKETPLACE_DATABASE_SSL=0")
dst.write_text("\\n".join(out) + "\\n")
dst.chmod(0o600)
print(f"ingest_env host={parsed.hostname} port={parsed.port} games={len(dbs)}")
PY
"$REMOTE_ROOT/run-cardtrader-game-ingest-api-docker.sh"
sleep 2
curl -sS --max-time 8 http://127.0.0.1:18082/healthz || true
echo
curl -sS --max-time 8 http://127.0.0.1:18082/api/ingest || true
echo
REMOTE
