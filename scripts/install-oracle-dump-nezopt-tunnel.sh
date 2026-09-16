#!/usr/bin/env bash
# User-unit on nezopt: Oracle 127.0.0.1:15543 → local NVMe Postgres :25432.
# The CardTrader GET job stays on Oracle. Persist/SQL is this host.
# Run as nez (Linger=yes). No sudo.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
install -d "$UNIT_DIR"
install -m 644 "$ROOT/pokoin-oracle-dump-pg-tunnel.service" \
  "$UNIT_DIR/pokoin-oracle-dump-pg-tunnel.service"
systemctl --user daemon-reload
systemctl --user enable --now pokoin-oracle-dump-pg-tunnel.service
systemctl --user --no-pager --full status pokoin-oracle-dump-pg-tunnel.service
echo "Oracle dump persist tunnel: marketplace 127.0.0.1:15543 → nezopt 127.0.0.1:25432"
