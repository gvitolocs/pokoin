#!/bin/bash
# Install nezopt /healthz mailer. Does not run on the Pi — Pi cannot mail if it is dead.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "run as root on nezopt" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")" && pwd)"
install -o root -g root -m 755 "$ROOT/pokoin-uptime-mail.sh" /usr/local/sbin/pokoin-uptime-mail.sh
install -o root -g root -m 644 "$ROOT/pokoin-uptime-mail.service" /etc/systemd/system/pokoin-uptime-mail.service
install -o root -g root -m 644 "$ROOT/pokoin-uptime-mail.timer" /etc/systemd/system/pokoin-uptime-mail.timer
mkdir -p /etc/pokoin /var/lib/pokoin-uptime /var/log
touch /var/log/pokoin-uptime-mail.log
chmod 755 /var/lib/pokoin-uptime
if [ ! -f /etc/pokoin/uptime-mail.env ]; then
  umask 077
  if [ -f /home/nez/Projects/cardvault/pokemon_card_vault/.env.local ]; then
    python3 - <<'PY'
from pathlib import Path
src = Path("/home/nez/Projects/cardvault/pokemon_card_vault/.env.local")
dest = Path("/etc/pokoin/uptime-mail.env")
key = ""
for line in src.read_text().splitlines():
    if line.startswith("RESEND_API_KEY="):
        key = line.split("=", 1)[1].strip().strip('"').strip("'")
        break
if not key:
    raise SystemExit("RESEND_API_KEY missing")
dest.write_text(f"RESEND_API_KEY={key}\n")
dest.chmod(0o600)
print("wrote Resend key to /etc/pokoin/uptime-mail.env")
PY
  else
    echo "Resend key not copied; mailer will try SMTP/sendmail"
  fi
fi
systemctl daemon-reload
systemctl enable --now pokoin-uptime-mail.timer
systemctl start pokoin-uptime-mail.service || true
echo "uptime mail timer enabled (every 2 minutes) → vitologiuseppe17@gmail.com"
systemctl list-timers pokoin-uptime-mail.timer --no-pager
