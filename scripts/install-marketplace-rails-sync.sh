#!/usr/bin/env bash
# Install the rails publisher beside the writable primary Postgres.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
HOST="${1:-nezopt-remote}"

ssh "${SSH_OPTS[@]}" "$HOST" 'mkdir -p "$HOME/scratch/set-pipeline"'

scp "${SSH_OPTS[@]}" \
  "$ROOT/scripts/sync-marketplace-rails.py" \
  "$ROOT/market/src/data/featured-set.json" \
  "$ROOT/scripts/marketplace-rails-sync.service" \
  "$ROOT/scripts/marketplace-rails-sync.timer" \
  "$HOST:scratch/set-pipeline/"

# pokoin_public_card.py lives in cardvault; copy if present next to this repo's scripts.
if [[ -f "$ROOT/scripts/pokoin_public_card.py" ]]; then
  scp "${SSH_OPTS[@]}" "$ROOT/scripts/pokoin_public_card.py" "$HOST:scratch/set-pipeline/pokoin_public_card.py"
elif [[ -f "$ROOT/../cardvault/pokemon_card_vault/scripts/pokoin_public_card.py" ]]; then
  scp "${SSH_OPTS[@]}" "$ROOT/../cardvault/pokemon_card_vault/scripts/pokoin_public_card.py" "$HOST:scratch/set-pipeline/pokoin_public_card.py"
fi

ssh "${SSH_OPTS[@]}" "$HOST" 'set -euo pipefail
install -d -m 0755 /srv/pokoin/scripts
install -m 0755 "$HOME/scratch/set-pipeline/sync-marketplace-rails.py" /srv/pokoin/scripts/sync-marketplace-rails.py
install -m 0644 "$HOME/scratch/set-pipeline/featured-set.json" /srv/pokoin/scripts/featured-set.json
if [[ -f "$HOME/scratch/set-pipeline/pokoin_public_card.py" ]]; then
  install -m 0644 "$HOME/scratch/set-pipeline/pokoin_public_card.py" /srv/pokoin/scripts/pokoin_public_card.py
fi
install -m 0644 "$HOME/scratch/set-pipeline/marketplace-rails-sync.service" /etc/systemd/system/marketplace-rails-sync.service
install -m 0644 "$HOME/scratch/set-pipeline/marketplace-rails-sync.timer" /etc/systemd/system/marketplace-rails-sync.timer
systemctl daemon-reload
systemctl enable --now marketplace-rails-sync.timer
systemctl start marketplace-rails-sync.service || true
systemctl is-enabled marketplace-rails-sync.timer
'
