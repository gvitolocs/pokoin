#!/usr/bin/env bash
# Install the Supabase rails publisher on pokoin-marketplace. Does not cut DNS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS='-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20'
HOST="${1:-pokoin-marketplace}"

scp $SSH_OPTS "$ROOT/scripts/sync-supabase-rails.py" "$HOST:/tmp/sync-supabase-rails.py"
scp $SSH_OPTS "$ROOT/scripts/supabase-rails-sync.service" "$HOST:/tmp/supabase-rails-sync.service"
scp $SSH_OPTS "$ROOT/scripts/supabase-rails-sync.timer" "$HOST:/tmp/supabase-rails-sync.timer"

ssh $SSH_OPTS "$HOST" 'set -euo pipefail
mkdir -p /home/ubuntu/bin
sudo install -m 0755 /tmp/sync-supabase-rails.py /home/ubuntu/bin/sync-supabase-rails.py
sudo install -m 0644 /tmp/supabase-rails-sync.service /etc/systemd/system/supabase-rails-sync.service
sudo install -m 0644 /tmp/supabase-rails-sync.timer /etc/systemd/system/supabase-rails-sync.timer
sudo systemctl daemon-reload
sudo systemctl enable --now supabase-rails-sync.timer
sudo systemctl start supabase-rails-sync.service || true
systemctl is-enabled supabase-rails-sync.timer
'
