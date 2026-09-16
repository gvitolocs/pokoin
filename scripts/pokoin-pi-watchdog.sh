#!/bin/bash
# Repair Pi marketplace pipeline, then record /healthz.
# Runs locally on pi-home via systemd timer (every 5 minutes).
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
  docker start pokoin-marketplace-postgres-replica pokoin-oracle-api pokoin-meili pokoin-valkey 2>/dev/null || true
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

if ! port_up 6379; then
  repair "valkey :6379 down"
  docker restart pokoin-valkey 2>/dev/null || true
fi

if ! port_up 7700; then
  repair "meili :7700 down"
  docker restart pokoin-meili 2>/dev/null || true
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

health="$(curl -sS --max-time 5 http://127.0.0.1:18080/healthz 2>/dev/null || echo '{"ok":false,"error":"healthz_unreachable"}')"
log "healthz ${health}"

health_ok=0
if printf '%s' "$health" | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("ok") else 1)' 2>/dev/null; then
  health_ok=1
fi

if [ "$health_ok" -eq 0 ] && [ "$repaired" -eq 0 ]; then
  repair "healthz not ok"
  sleep 2
  health="$(curl -sS --max-time 5 http://127.0.0.1:18080/healthz 2>/dev/null || echo '{"ok":false,"error":"healthz_unreachable"}')"
  log "healthz-retry ${health}"
  if printf '%s' "$health" | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("ok") else 1)' 2>/dev/null; then
    health_ok=1
  fi
fi

if [ "$health_ok" -eq 1 ]; then
  echo 0 >"$FAIL_FILE"
  exit 0
fi

fails=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" >"$FAIL_FILE"
log "consecutive_fails ${fails}"

# Three missed 5-minute checks (~15 min) → reboot once per hour.
if [ "$fails" -ge 3 ]; then
  now="$(date +%s)"
  last="$(cat "$REBOOT_FILE" 2>/dev/null || echo 0)"
  if [ $((now - last)) -gt 3600 ]; then
    echo "$now" >"$REBOOT_FILE"
    log "reboot after ${fails} failed healthz"
    /sbin/reboot
  else
    log "reboot skipped; last reboot $((now - last))s ago"
  fi
fi
exit 1
