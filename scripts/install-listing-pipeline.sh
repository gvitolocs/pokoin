#!/usr/bin/env bash
# Install listing stats → card weights on Pi Postgres. Rails publisher is separate.
# Does not cut DNS. Does not stop a CardTrader refresh that is already running.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS='-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20'
HOST="${1:-pi-home}"
POSTGRES="${POKOIN_MARKETPLACE_POSTGRES:-pokoin-marketplace-postgres-replica}"

# NOTE: this script deliberately does NOT apply
# scripts/sql/cardtrader-listing-qty-diff.sql. The listing/sold pipeline
# functions (refresh_cardtrader_market_listing_snapshots and friends) are owned
# by the cardvault repo, pokemon_card_vault/oracle-postgres/schema/, and are
# applied from there. The copy in this repo is an out-of-date snapshot; applying
# it would CREATE OR REPLACE the live function with an older definition and
# silently drop the quantity-aware attribution (stack_delta / suspicious /
# provisional) and the seller-stack continuity reconciliation.

scp $SSH_OPTS \
    "$ROOT/scripts/sql/cardtrader-population.sql" \
    "$ROOT/scripts/sql/listing-pipeline.sql" \
    "$ROOT/scripts/sql/listing-weight-formulas.sql" \
    "$ROOT/scripts/refresh-listing-weights.py" \
    "$ROOT/scripts/listing-weights.service" \
    "$ROOT/scripts/listing-weights.timer" \
    "$ROOT/scripts/valkey_cache.py" \
    "$HOST:/tmp/"

ssh $SSH_OPTS "$HOST" "set -euo pipefail
POSTGRES='$POSTGRES'
install -d -m 0755 /srv/pokoin/scripts /srv/pokoin/schema
install -m 0755 /tmp/refresh-listing-weights.py /srv/pokoin/scripts/refresh-listing-weights.py
install -m 0644 /tmp/valkey_cache.py /srv/pokoin/scripts/valkey_cache.py
install -m 0644 /tmp/listing-weights.service /etc/systemd/system/listing-weights.service
install -m 0644 /tmp/listing-weights.timer /etc/systemd/system/listing-weights.timer
install -m 0644 /tmp/cardtrader-population.sql /srv/pokoin/schema/cardtrader-population.sql
install -m 0644 /tmp/listing-pipeline.sql /srv/pokoin/schema/listing-pipeline.sql
install -m 0644 /tmp/listing-weight-formulas.sql /srv/pokoin/schema/listing-weight-formulas.sql
echo Applying cardtrader-population.sql
docker exec -i \"\$POSTGRES\" \
  psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1 \
  < /tmp/cardtrader-population.sql
echo Applying listing-pipeline.sql
docker exec -i \"\$POSTGRES\" \
  psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1 \
  < /tmp/listing-pipeline.sql
echo Applying listing-weight-formulas.sql
docker exec -i \"\$POSTGRES\" \
  psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1 \
  < /tmp/listing-weight-formulas.sql
systemctl daemon-reload
systemctl enable --now listing-weights.timer
systemctl start listing-weights.service || true
systemctl is-enabled listing-weights.timer
systemctl show listing-weights.timer -p NextElapse --value
"
