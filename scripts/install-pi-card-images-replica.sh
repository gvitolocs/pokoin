#!/usr/bin/env bash
# Install the hourly user timer that rsyncs Pi card-images onto mybook.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
install -m 644 "$ROOT/scripts/pi-card-images-replica.service" "$UNIT_DIR/"
install -m 644 "$ROOT/scripts/pi-card-images-replica.timer" "$UNIT_DIR/"
chmod +x "$ROOT/scripts/sync-pi-card-images-replica.sh"
chmod +x "$ROOT/scripts/export-leftover-artcut.py"
systemctl --user daemon-reload
systemctl --user enable --now pi-card-images-replica.timer
systemctl --user list-timers pi-card-images-replica.timer --no-pager
echo "replica dest: /home/nez/mnt/mybook/pokoin-pi-card-images"
echo "art-cut out:  /home/nez/mnt/mybook/pokoin-pi-card-images/artcut"
