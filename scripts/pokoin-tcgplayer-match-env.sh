#!/usr/bin/env bash
# Runs pokoin-tcgplayer-match against the local nezopt writer + tcgprices DBs.
set -euo pipefail
eval "$(docker exec pokoin-marketplace-postgres-15t sh -c "printf \"MU=%s\nMP=%s\n\" \"\$POSTGRES_USER\" \"\$POSTGRES_PASSWORD\"")"
set -a; . /home/nez/mnt/mybook/tcgprices/postgres/postgres.env; set +a
enc() { python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=\"\"))" "$1"; }
export MARKET_DATABASE_URL="postgres://$(enc "$MU"):$(enc "$MP")@127.0.0.1:25433/pokoin_marketplace?sslmode=disable"
export TCGPRICES_DATABASE_URL="postgres://$(enc "$POSTGRES_USER"):$(enc "$POSTGRES_PASSWORD")@127.0.0.1:27432/$POSTGRES_DB?sslmode=disable"
exec "${POKOIN_TCGPLAYER_MATCH_BIN:-$HOME/.local/bin/pokoin-tcgplayer-match}" "$@"
