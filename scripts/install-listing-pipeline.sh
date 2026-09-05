#!/usr/bin/env bash
# Install listing stats → Oracle weights → (rails sync already publishes to Supabase).
# Does not cut DNS. Does not stop a CardTrader refresh that is already running.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS='-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20'
HOST="${1:-pokoin-marketplace}"

scp $SSH_OPTS \
  "$ROOT/scripts/sql/listing-pipeline.sql" \
  "$ROOT/scripts/sql/listing-weight-formulas.sql" \
  "$ROOT/scripts/refresh-listing-weights.py" \
  "$ROOT/scripts/listing-weights.service" \
  "$ROOT/scripts/listing-weights.timer" \
  "$ROOT/scripts/pokoin-cardtrader-daily-lock.conf" \
  "$ROOT/scripts/sync-supabase-rails.py" \
  "$ROOT/scripts/valkey_cache.py" \
  "$HOST:/tmp/"

ssh $SSH_OPTS "$HOST" 'set -euo pipefail
mkdir -p /home/ubuntu/bin /home/ubuntu/pokoin-oracle-api/logs \
  /etc/systemd/system/pokoin-cardtrader-daily-market-refresh.service.d \
  /home/ubuntu/pokoin-oracle-api/current/oracle-postgres/schema
sudo install -m 0755 /tmp/refresh-listing-weights.py /home/ubuntu/bin/refresh-listing-weights.py
sudo install -m 0755 /tmp/sync-supabase-rails.py /home/ubuntu/bin/sync-supabase-rails.py
sudo install -m 0644 /tmp/valkey_cache.py /home/ubuntu/bin/valkey_cache.py
sudo install -m 0644 /tmp/listing-weights.service /etc/systemd/system/listing-weights.service
sudo install -m 0644 /tmp/listing-weights.timer /etc/systemd/system/listing-weights.timer
sudo install -m 0644 /tmp/pokoin-cardtrader-daily-lock.conf \
  /etc/systemd/system/pokoin-cardtrader-daily-market-refresh.service.d/lock.conf
sudo install -m 0644 /tmp/listing-pipeline.sql \
  /home/ubuntu/pokoin-oracle-api/current/oracle-postgres/schema/027_listing_pipeline.sql
sudo install -m 0644 /tmp/listing-weight-formulas.sql \
  /home/ubuntu/pokoin-oracle-api/current/oracle-postgres/schema/028_listing_weight_formulas.sql
echo "Applying listing-pipeline.sql"
sudo docker exec -i pokoin-marketplace-postgres \
  psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1 \
  < /tmp/listing-pipeline.sql
echo "Applying listing-weight-formulas.sql"
sudo docker exec -i pokoin-marketplace-postgres \
  psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1 \
  < /tmp/listing-weight-formulas.sql
sudo systemctl daemon-reload
sudo systemctl enable --now listing-weights.timer
sudo systemctl start listing-weights.service || true
systemctl is-enabled listing-weights.timer
systemctl show pokoin-cardtrader-daily-market-refresh.timer -p NextElapse --value
'
