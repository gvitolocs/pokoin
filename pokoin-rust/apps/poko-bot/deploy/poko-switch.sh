#!/usr/bin/env bash
# Flip Poko chat between this daemon and Hermes. Root only.
set -euo pipefail

SWITCH=/etc/poko-bot/switch.env
DROPIN_DIR=/etc/systemd/system/hermes-poko.service.d
DROPIN=$DROPIN_DIR/poko-bot-switch.conf
HERMES_HEALTH=http://127.0.0.1:8789/health
BOT_HEALTH=http://127.0.0.1:8790/health

if [[ "$(id -u)" -ne 0 ]]; then
  echo "poko-switch must run as root" >&2
  exit 1
fi

usage() {
  echo "usage: poko-switch status" >&2
  echo "       poko-switch <telegram|discord> <rust|hermes>" >&2
  echo "       poko-switch brain <hermes|canary|rust>" >&2
  echo "       poko-switch canary-add <uid|telegram:ID|discord:ID>" >&2
  exit 1
}

read_kv() {
  local file=$1 key=$2 default=$3 line
  if [[ -f "$file" ]]; then
    line=$(grep -E "^${key}=" "$file" | tail -n 1 || true)
    if [[ -n "$line" ]]; then
      printf '%s' "${line#*=}"
      return
    fi
  fi
  printf '%s' "$default"
}

append_csv() {
  local current=$1 value=$2 rest item
  if [[ -z "$current" ]]; then
    printf '%s' "$value"
    return
  fi
  rest=$current
  while [[ -n "$rest" ]]; do
    item=${rest%%,*}
    if [[ "$item" == "$value" ]]; then
      printf '%s' "$current"
      return
    fi
    if [[ "$rest" == *,* ]]; then
      rest=${rest#*,}
    else
      break
    fi
  done
  printf '%s,%s' "$current" "$value"
}

write_switch() {
  local telegram=$1 discord=$2 mode=$3
  local uids tg_ids discord_ids tmp
  uids=$(read_kv "$SWITCH" POKO_BOT_CANARY_UIDS "")
  tg_ids=$(read_kv "$SWITCH" POKO_BOT_CANARY_TELEGRAM_IDS "")
  discord_ids=$(read_kv "$SWITCH" POKO_BOT_CANARY_DISCORD_IDS "")
  tmp=$(mktemp)
  {
    printf 'POKO_BOT_TELEGRAM=%s\n' "$telegram"
    printf 'POKO_BOT_DISCORD=%s\n' "$discord"
    printf 'POKO_BOT_BRAIN_MODE=%s\n' "$mode"
    printf 'POKO_BOT_CANARY_UIDS=%s\n' "$uids"
    printf 'POKO_BOT_CANARY_TELEGRAM_IDS=%s\n' "$tg_ids"
    printf 'POKO_BOT_CANARY_DISCORD_IDS=%s\n' "$discord_ids"
  } >"$tmp"
  install -o root -g poko-bot -m 0640 "$tmp" "$SWITCH"
  rm -f "$tmp"
}

set_canary() {
  local key=$1 value=$2
  local telegram discord mode uids tg_ids discord_ids current updated tmp
  telegram=$(read_kv "$SWITCH" POKO_BOT_TELEGRAM off)
  discord=$(read_kv "$SWITCH" POKO_BOT_DISCORD off)
  mode=$(read_kv "$SWITCH" POKO_BOT_BRAIN_MODE canary)
  uids=$(read_kv "$SWITCH" POKO_BOT_CANARY_UIDS "")
  tg_ids=$(read_kv "$SWITCH" POKO_BOT_CANARY_TELEGRAM_IDS "")
  discord_ids=$(read_kv "$SWITCH" POKO_BOT_CANARY_DISCORD_IDS "")
  case "$key" in
    POKO_BOT_CANARY_UIDS) current=$uids ;;
    POKO_BOT_CANARY_TELEGRAM_IDS) current=$tg_ids ;;
    POKO_BOT_CANARY_DISCORD_IDS) current=$discord_ids ;;
    *)
      echo "unknown canary key: $key" >&2
      return 1
      ;;
  esac
  updated=$(append_csv "$current" "$value")
  case "$key" in
    POKO_BOT_CANARY_UIDS) uids=$updated ;;
    POKO_BOT_CANARY_TELEGRAM_IDS) tg_ids=$updated ;;
    POKO_BOT_CANARY_DISCORD_IDS) discord_ids=$updated ;;
  esac
  tmp=$(mktemp)
  {
    printf 'POKO_BOT_TELEGRAM=%s\n' "$telegram"
    printf 'POKO_BOT_DISCORD=%s\n' "$discord"
    printf 'POKO_BOT_BRAIN_MODE=%s\n' "$mode"
    printf 'POKO_BOT_CANARY_UIDS=%s\n' "$uids"
    printf 'POKO_BOT_CANARY_TELEGRAM_IDS=%s\n' "$tg_ids"
    printf 'POKO_BOT_CANARY_DISCORD_IDS=%s\n' "$discord_ids"
  } >"$tmp"
  install -o root -g poko-bot -m 0640 "$tmp" "$SWITCH"
  rm -f "$tmp"
}

hermes_flag() {
  local key=$1 line
  if [[ ! -f "$DROPIN" ]]; then
    printf 'on'
    return
  fi
  line=$(grep -E "^Environment=${key}=" "$DROPIN" | tail -n 1 || true)
  if [[ -z "$line" ]]; then
    printf 'on'
  else
    printf '%s' "${line##*=}"
  fi
}

write_dropin() {
  local telegram=$1 discord=$2
  install -d -o root -g root -m 0755 "$DROPIN_DIR"
  cat >"$DROPIN" <<EOF
[Service]
Environment=POKO_TELEGRAM_CHAT=${telegram}
Environment=POKO_DISCORD_MESSAGES=${discord}
EOF
}

wait_url() {
  local url=$1 seconds=$2 i=0
  echo "waiting up to ${seconds}s for ${url}"
  while [[ "$i" -lt "$seconds" ]]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "ok ${url}"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "timed out waiting for ${url}" >&2
  return 1
}

platform_live() {
  local platform=$1 body=$2
  if command -v jq >/dev/null 2>&1; then
    if [[ "$platform" == "telegram" ]]; then
      [[ "$(printf '%s' "$body" | jq -r '.telegram.polling')" == "true" ]]
    else
      [[ "$(printf '%s' "$body" | jq -r '.discord.connected')" == "true" ]]
    fi
    return
  fi
  case "$platform" in
    telegram) [[ "$body" == *'"polling":true'* ]] ;;
    discord) [[ "$body" == *'"connected":true'* ]] ;;
    *) return 1 ;;
  esac
}

wait_platform() {
  local platform=$1 seconds=$2 i=0 body
  echo "waiting up to ${seconds}s for poko-bot ${platform} to be live"
  while [[ "$i" -lt "$seconds" ]]; do
    if body=$(curl -fsS "$BOT_HEALTH" 2>/dev/null); then
      if platform_live "$platform" "$body"; then
        echo "ok poko-bot ${platform} live"
        return 0
      fi
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "timed out waiting for poko-bot ${platform} to be live" >&2
  return 1
}

print_health() {
  local title=$1 url=$2 body
  echo "=== ${title} ==="
  if body=$(curl -fsS "$url" 2>/dev/null); then
    if command -v jq >/dev/null 2>&1; then
      printf '%s\n' "$body" | jq .
    else
      printf '%s\n' "$body"
    fi
  else
    echo "${title} unavailable"
  fi
}

cmd_status() {
  echo "=== ${SWITCH} ==="
  if [[ -f "$SWITCH" ]]; then
    cat "$SWITCH"
  else
    echo "(missing)"
  fi
  echo "=== ${DROPIN} ==="
  if [[ -f "$DROPIN" ]]; then
    cat "$DROPIN"
  else
    echo "(missing; Hermes telegram chat and discord messages stay on)"
  fi
  print_health "hermes health" "$HERMES_HEALTH"
  print_health "poko-bot health" "$BOT_HEALTH"
  echo "=== systemd ==="
  systemctl is-active hermes-poko poko-bot || true
}

cmd_rust() {
  local platform=$1
  local tg_hermes dc_hermes tg_bot dc_bot mode
  tg_hermes=$(hermes_flag POKO_TELEGRAM_CHAT)
  dc_hermes=$(hermes_flag POKO_DISCORD_MESSAGES)
  tg_bot=$(read_kv "$SWITCH" POKO_BOT_TELEGRAM off)
  dc_bot=$(read_kv "$SWITCH" POKO_BOT_DISCORD off)
  mode=$(read_kv "$SWITCH" POKO_BOT_BRAIN_MODE canary)
  if [[ "$platform" == "telegram" ]]; then
    tg_hermes=off
    tg_bot=on
  else
    dc_hermes=off
    dc_bot=on
  fi
  echo "switching ${platform} to rust: Hermes off, then poko-bot on"
  write_dropin "$tg_hermes" "$dc_hermes"
  systemctl daemon-reload
  systemctl restart hermes-poko
  wait_url "$HERMES_HEALTH" 90
  write_switch "$tg_bot" "$dc_bot" "$mode"
  systemctl restart poko-bot
  wait_platform "$platform" 45
}

cmd_hermes() {
  local platform=$1
  local tg_hermes dc_hermes tg_bot dc_bot mode
  tg_hermes=$(hermes_flag POKO_TELEGRAM_CHAT)
  dc_hermes=$(hermes_flag POKO_DISCORD_MESSAGES)
  tg_bot=$(read_kv "$SWITCH" POKO_BOT_TELEGRAM off)
  dc_bot=$(read_kv "$SWITCH" POKO_BOT_DISCORD off)
  mode=$(read_kv "$SWITCH" POKO_BOT_BRAIN_MODE canary)
  if [[ "$platform" == "telegram" ]]; then
    tg_hermes=on
    tg_bot=off
  else
    dc_hermes=on
    dc_bot=off
  fi
  echo "switching ${platform} to hermes: poko-bot off, then Hermes on"
  write_switch "$tg_bot" "$dc_bot" "$mode"
  systemctl restart poko-bot
  write_dropin "$tg_hermes" "$dc_hermes"
  systemctl daemon-reload
  systemctl restart hermes-poko
  wait_url "$HERMES_HEALTH" 90
}

cmd_brain() {
  local mode=$1
  local telegram discord
  telegram=$(read_kv "$SWITCH" POKO_BOT_TELEGRAM off)
  discord=$(read_kv "$SWITCH" POKO_BOT_DISCORD off)
  echo "setting POKO_BOT_BRAIN_MODE=${mode} and restarting poko-bot"
  write_switch "$telegram" "$discord" "$mode"
  systemctl restart poko-bot
  wait_url "$BOT_HEALTH" 30
}

cmd_canary_add() {
  local spec=$1 key value
  case "$spec" in
    telegram:*)
      value=${spec#telegram:}
      [[ -n "$value" && "$value" != *:* ]] || usage
      key=POKO_BOT_CANARY_TELEGRAM_IDS
      ;;
    discord:*)
      value=${spec#discord:}
      [[ -n "$value" && "$value" != *:* ]] || usage
      key=POKO_BOT_CANARY_DISCORD_IDS
      ;;
    *:*)
      usage
      ;;
    "")
      usage
      ;;
    *)
      value=$spec
      key=POKO_BOT_CANARY_UIDS
      ;;
  esac
  echo "adding ${spec} to ${key} and restarting poko-bot"
  set_canary "$key" "$value"
  systemctl restart poko-bot
  wait_url "$BOT_HEALTH" 30
}

if [[ $# -lt 1 ]]; then
  usage
fi

case "$1" in
  status)
    [[ $# -eq 1 ]] || usage
    cmd_status
    ;;
  telegram | discord)
    [[ $# -eq 2 ]] || usage
    case "$2" in
      rust) cmd_rust "$1" ;;
      hermes) cmd_hermes "$1" ;;
      *) usage ;;
    esac
    ;;
  brain)
    [[ $# -eq 2 ]] || usage
    case "$2" in
      hermes | canary | rust) cmd_brain "$2" ;;
      *) usage ;;
    esac
    ;;
  canary-add)
    [[ $# -eq 2 ]] || usage
    cmd_canary_add "$2"
    ;;
  *)
    usage
    ;;
esac
