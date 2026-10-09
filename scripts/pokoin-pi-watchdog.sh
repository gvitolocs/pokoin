#!/bin/bash
# Repair a down listener, then record livez/readyz.
# A failed postgres, redis, or CDN check must not reboot the Pi.
# Host reboot stays in pokoin-pi-ro-watch (USB root emergency_ro) and the
# kernel watchdog. The API, edge, CDN and ct-deals are one native Rust unit
# (pokoin-rust-api); the Node backend is retired.
set -u
LOG="${POKOIN_WATCHDOG_LOG:-/var/log/pokoin-watchdog.log}"
# tmpfs so consecutive_fails still increments when USB root is emergency_ro.
STATE="${POKOIN_WATCHDOG_STATE:-/run/pokoin-watchdog}"
FAIL_FILE="$STATE/consecutive_fails"
RUST_UNIT=pokoin-rust-api.service

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

restart_rust() {
  systemctl reset-failed "$RUST_UNIT" 2>/dev/null || true
  systemctl restart "$RUST_UNIT" 2>/dev/null || true
}

start_units() {
  reset_unit docker.service
  for unit in cloudflared.service "$RUST_UNIT" ssh.service sshd.service; do
    reset_unit "$unit"
  done
}

start_containers() {
  command -v docker >/dev/null || return 0
  if ! docker info >/dev/null 2>&1; then
    reset_unit docker.service
    sleep 2
  fi
  docker start pokoin-marketplace-postgres-replica pokoin-redis pokoin-scan 2>/dev/null || true
}

repair() {
  local why="$1"
  log "repair ${why}"
  start_units
  start_containers
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

if ! port_up 6380; then
  repair "redis :6380 down"
  docker restart pokoin-redis 2>/dev/null || true
fi

# One process owns every listener: any port down means the unit needs a restart.
rust_down=""
for port in 18082 18079 18081 18090; do
  port_up "$port" || rust_down="${rust_down} :${port}"
done
if [ -n "$rust_down" ]; then
  log "repair rust listeners down${rust_down}"
  restart_rust
  sleep 3
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

live_code="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:18079/livez 2>/dev/null || echo 000)"
ready="$(curl -sS --max-time 5 http://127.0.0.1:18079/readyz 2>/dev/null || echo '{"ok":false,"error":"readyz_unreachable"}')"
log "livez ${live_code} readyz ${ready}"

if [ "$live_code" != "200" ]; then
  log "repair rust livez ${live_code}"
  restart_rust
  sleep 3
  live_code="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:18079/livez 2>/dev/null || echo 000)"
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
  log "rust livez still ${live_code}; listener repair only, no host reboot"
  exit 1
fi
exit 1
