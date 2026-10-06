#!/bin/bash
# Repair a down listener, then record livez/readyz.
# A failed postgres, redis, or CDN check must not reboot the Pi.
# Host reboot stays in pokoin-pi-ro-watch (USB root emergency_ro) and the
# kernel watchdog. Meili is retired.
set -u
LOG="${POKOIN_WATCHDOG_LOG:-/var/log/pokoin-watchdog.log}"
# tmpfs so consecutive_fails still increments when USB root is emergency_ro.
STATE="${POKOIN_WATCHDOG_STATE:-/run/pokoin-watchdog}"
FAIL_FILE="$STATE/consecutive_fails"
REBOOT_FILE="$STATE/last_reboot"

if grep -q emergency_ro /proc/mounts 2>/dev/null; then
  echo b > /proc/sysrq-trigger 2>/dev/null || true
  /sbin/reboot -f 2>/dev/null || true
  exit 1
fi

mkdir -p "$STATE" 2>/dev/null || true
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { printf '%s %s\n' "$(ts)" "$*" | tee -a "$LOG" >/dev/null; }

port_up() {
  local port="$1"
  timeout 1 bash -c "echo >/dev/tcp/127.0.0.1/${port}" 2>/dev/null
}

ssh_banner_ok() {
  timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/22; read -t 1 -n 8 banner <&3; [[ "$banner" == SSH-* ]]' 2>/dev/null
}

reset_unit() {
  local unit="$1"
  systemctl reset-failed "$unit" 2>/dev/null || true
  systemctl start "$unit" 2>/dev/null || true
}

start_units() {
  reset_unit docker.service
  for unit in cloudflared.service pokoin-card-images.service pokoin-api-edge.service ssh.service sshd.service; do
    reset_unit "$unit"
  done
}

start_containers() {
  command -v docker >/dev/null || return 0
  if ! docker info >/dev/null 2>&1; then
    reset_unit docker.service
    sleep 2
  fi
  docker start pokoin-marketplace-postgres-replica pokoin-oracle-api pokoin-redis pokoin-rust-api 2>/dev/null || true
}

repaired=0
repair() {
  local why="$1"
  log "repair ${why}"
  start_units
  start_containers
  repaired=1
}

if ! docker info >/dev/null 2>&1; then
  repair "docker down"
  sleep 2
fi

if ! port_up 5432; then
  repair "postgres :5432 down"
  sleep 2
  if ! port_up 5432; then
    docker restart pokoin-marketplace-postgres-replica 2>/dev/null || true
    sleep 3
  fi
fi

if ! port_up 18080; then
  repair "api :18080 down"
  docker restart pokoin-oracle-api 2>/dev/null || true
  sleep 2
fi

if ! port_up 18081; then
  repair "cdn :18081 down"
  systemctl reset-failed pokoin-card-images.service 2>/dev/null || true
  systemctl restart pokoin-card-images.service 2>/dev/null || true
  sleep 1
fi

if ! port_up 18079; then
  repair "api-edge :18079 down"
  systemctl reset-failed pokoin-api-edge.service 2>/dev/null || true
  systemctl restart pokoin-api-edge.service 2>/dev/null || true
  sleep 1
fi

if ! port_up 6380; then
  repair "redis :6380 down"
  docker restart pokoin-redis 2>/dev/null || true
fi

if ! port_up 18082; then
  repair "rust :18082 down"
  systemctl reset-failed pokoin-rust-api.service 2>/dev/null || true
  systemctl restart pokoin-rust-api.service 2>/dev/null || true
fi

if ! systemctl is-active --quiet cloudflared.service; then
  repair "cloudflared inactive"
  systemctl reset-failed cloudflared.service 2>/dev/null || true
  systemctl restart cloudflared.service 2>/dev/null || true
fi

if ! ssh_banner_ok; then
  repair "sshd banner missing"
  systemctl reset-failed ssh.service 2>/dev/null || true
  systemctl reset-failed sshd.service 2>/dev/null || true
  systemctl restart ssh.service 2>/dev/null || systemctl restart sshd.service 2>/dev/null || true
fi

live_code="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/livez 2>/dev/null || echo 000)"
ready="$(curl -sS --max-time 5 http://127.0.0.1:18080/readyz 2>/dev/null || echo '{"ok":false,"error":"readyz_unreachable"}')"
log "livez ${live_code} readyz ${ready}"

if [ "$live_code" != "200" ]; then
  repair "node livez ${live_code}"
  sleep 2
  live_code="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/livez 2>/dev/null || echo 000)"
  log "livez-retry ${live_code}"
fi

ready_ok=0
if printf '%s' "$ready" | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("ok") else 1)' 2>/dev/null; then
  ready_ok=1
fi

if [ "$live_code" = "200" ] && [ "$ready_ok" -eq 1 ]; then
  echo 0 >"$FAIL_FILE"
  exit 0
fi

if [ "$ready_ok" -eq 0 ]; then
  log "degraded readyz; application dependencies do not reboot the host"
fi
if [ "$live_code" != "200" ]; then
  log "node livez still ${live_code}; listener repair only, no host reboot"
  exit 1
fi
exit 1
