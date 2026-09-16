#!/bin/bash
# Install Pi pipeline watchdog + never-give-up restart policy on origin units.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "run as root on pi-home" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")" && pwd)"
install -o root -g root -m 755 "$ROOT/pokoin-pi-watchdog.sh" /usr/local/sbin/pokoin-pi-watchdog.sh
install -o root -g root -m 755 "$ROOT/pokoin-pi-ro-watch.sh" /usr/local/sbin/pokoin-pi-ro-watch.sh
install -o root -g root -m 644 "$ROOT/pokoin-pi-watchdog.service" /etc/systemd/system/pokoin-pi-watchdog.service
install -o root -g root -m 644 "$ROOT/pokoin-pi-watchdog.timer" /etc/systemd/system/pokoin-pi-watchdog.timer
install -o root -g root -m 644 "$ROOT/pokoin-pi-ro-watch.service" /etc/systemd/system/pokoin-pi-ro-watch.service

dropin() {
  local unit="$1"
  mkdir -p "/etc/systemd/system/${unit}.d"
  cat >"/etc/systemd/system/${unit}.d/restart.conf" <<'EOF'
[Service]
Restart=always
RestartSec=2
StartLimitIntervalSec=0
EOF
}

dropin pokoin-api-edge.service
dropin pokoin-card-images.service
dropin cloudflared.service
dropin ssh.service
dropin docker.service

# Hardware watchdog at 3 minutes. 20s reboot-looped USB root + Docker start.
# A USB stall leaves ping up and disk in D-state; without a pet, reboot.
mkdir -p /etc/systemd/system.conf.d /etc/modules-load.d
cat >/etc/systemd/system.conf.d/99-pokoin-watchdog.conf <<'EOF'
[Manager]
RuntimeWatchdogSec=180s
RebootWatchdogSec=3min
EOF
echo bcm2835_wdt >/etc/modules-load.d/pokoin-wdt.conf
for cfg in /boot/firmware/config.txt /boot/config.txt; do
  if [ -f "$cfg" ]; then
    grep -q '^dtparam=watchdog=on' "$cfg" 2>/dev/null && continue
    printf '\n# Pokoin: reboot if the kernel/systemd hang (USB root stall)\ndtparam=watchdog=on\n' >>"$cfg"
  fi
done

cat >/etc/sysctl.d/99-pokoin-panic.conf <<'EOF'
kernel.panic = 10
kernel.hung_task_timeout_secs = 120
kernel.hung_task_panic = 1
EOF
sysctl -p /etc/sysctl.d/99-pokoin-panic.conf >/dev/null 2>&1 || true

if command -v docker >/dev/null; then
  systemctl enable docker.service >/dev/null 2>&1 || true
  for name in pokoin-marketplace-postgres-replica pokoin-oracle-api pokoin-meili pokoin-valkey; do
    docker update --restart always "$name" 2>/dev/null || true
  done
fi

systemctl daemon-reload
systemctl enable ssh.service >/dev/null 2>&1 || systemctl enable sshd.service >/dev/null 2>&1 || true
systemctl enable --now pokoin-pi-watchdog.timer
systemctl enable --now pokoin-pi-ro-watch.service
systemctl start pokoin-pi-watchdog.service || true
for unit in pokoin-api-edge.service pokoin-card-images.service cloudflared.service; do
  systemctl reset-failed "$unit" 2>/dev/null || true
  systemctl start "$unit" 2>/dev/null || true
done
echo "watchdog timer enabled (every 5 minutes); first run kicked"
systemctl list-timers pokoin-pi-watchdog.timer --no-pager
