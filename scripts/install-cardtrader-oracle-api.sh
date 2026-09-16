#!/usr/bin/env bash
# Deploy cardtrader-oracle-api onto pokoin-marketplace from this machine (nezopt).
# Does not restart a running CardTrader dump. Does not touch the Pi public API.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${CARDVAULT_SRC:-/home/nez/Projects/cardvault/pokemon_card_vault}"
HOST="${CARDTRADER_ORACLE_HOST:-pokoin-marketplace}"
SSH_OPTS='-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20'
REMOTE_ROOT=/home/ubuntu/cardtrader-oracle-api
OLD_ROOT=/home/ubuntu/pokoin-oracle-api

if [[ ! -f "$SRC/server/oracle-api-server.js" ]]; then
  echo "cardvault missing at $SRC" >&2
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
scp $SSH_OPTS "$ROOT/scripts/run-cardtrader-oracle-api-docker.sh" \
  "$HOST:$REMOTE_ROOT/run-cardtrader-oracle-api-docker.sh"
scp $SSH_OPTS "$ROOT/scripts/pokoin-cardtrader-daily-nezopt.conf" \
  "$HOST:/tmp/pokoin-cardtrader-daily-nezopt.conf"

ssh $SSH_OPTS "$HOST" "bash -s" <<REMOTE
set -euo pipefail
chmod +x $REMOTE_ROOT/run-cardtrader-oracle-api-docker.sh
if [[ ! -d $REMOTE_ROOT/current/node_modules && -d $OLD_ROOT/current/node_modules ]]; then
  cp -a $OLD_ROOT/current/node_modules $REMOTE_ROOT/current/node_modules
fi
# Env: dump already talks to nezopt :15543. Reuse that file; point name-search at the same DB.
python3 - <<'PY'
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, quote
src = Path("$OLD_ROOT/.env.cardtrader-nezopt")
dst = Path("$REMOTE_ROOT/.env")
if not src.exists():
    raise SystemExit("missing $OLD_ROOT/.env.cardtrader-nezopt")
out = []
saw_name = False
saw_service = False
saw_skip = False
url = None
for line in src.read_text().splitlines():
    if line.startswith("MARKETPLACE_DATABASE_URL="):
        url = line.split("=", 1)[1].strip()
        out.append(line)
        continue
    if line.startswith("MARKETPLACE_NAME_SEARCH_DATABASE_URL=") and url:
        out.append("MARKETPLACE_NAME_SEARCH_DATABASE_URL=" + url)
        saw_name = True
        continue
    if line.startswith("POKOIN_API_SERVICE_NAME="):
        out.append("POKOIN_API_SERVICE_NAME=cardtrader-oracle-api")
        saw_service = True
        continue
    if line.startswith("PIPELINE_HEALTH_SKIP="):
        out.append("PIPELINE_HEALTH_SKIP=meili,cdn")
        saw_skip = True
        continue
    out.append(line)
if url and not saw_name:
    out.append("MARKETPLACE_NAME_SEARCH_DATABASE_URL=" + url)
if not saw_service:
    out.append("POKOIN_API_SERVICE_NAME=cardtrader-oracle-api")
if not saw_skip:
    out.append("PIPELINE_HEALTH_SKIP=meili,cdn")
if not any(ln.startswith("MARKETPLACE_DATABASE_SSL=") for ln in out):
    out.append("MARKETPLACE_DATABASE_SSL=0")
dst.write_text("\\n".join(out) + "\\n")
dst.chmod(0o600)
u = urlsplit(url)
print(f"api_env host={u.hostname} port={u.port} service=cardtrader-oracle-api")
PY
# Dump wrapper: next refresh uses this tree. Running dump keeps its existing mount.
if [[ -f $OLD_ROOT/run-cardtrader-daily-market-refresh-docker.sh ]]; then
  python3 - <<'PY'
from pathlib import Path
p = Path("$OLD_ROOT/run-cardtrader-daily-market-refresh-docker.sh")
t = p.read_text()
old = 'APP_ROOT="\$HOME/pokoin-oracle-api"'
new = 'APP_ROOT="\${CARDTRADER_ORACLE_API_ROOT:-\$HOME/cardtrader-oracle-api}"'
if old in t:
    p.write_text(t.replace(old, new, 1))
    print("dump_wrapper_root cardtrader-oracle-api")
elif "CARDTRADER_ORACLE_API_ROOT" in t:
    print("dump_wrapper already patched")
else:
    # already using CARDTRADER_DUMP_ENV_FILE; still force APP_ROOT if hardcoded current
    t2 = t.replace('APP_ROOT="\$HOME/pokoin-oracle-api"', new)
    if t2 != t:
        p.write_text(t2)
        print("dump_wrapper_root cardtrader-oracle-api")
    else:
        print("dump_wrapper left unchanged")
PY
fi
if [[ -f /tmp/pokoin-cardtrader-daily-nezopt.conf ]]; then
  sudo install -m 644 /tmp/pokoin-cardtrader-daily-nezopt.conf \
    /etc/systemd/system/pokoin-cardtrader-daily-market-refresh.service.d/zz-nezopt.conf
  sudo systemctl daemon-reload
  echo dump_dropin_updated
fi
# Free :18080 then start the named API. Dump does not bind this port.
sudo docker rm -f pokoin-oracle-api >/dev/null 2>&1 || true
"$REMOTE_ROOT/run-cardtrader-oracle-api-docker.sh"
sleep 3
curl -sS --max-time 5 http://127.0.0.1:18080/healthz || true
echo
REMOTE
