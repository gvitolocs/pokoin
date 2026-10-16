#!/usr/bin/env bash
# Install poko-bot on peer1. Idempotent. Does not start the service unless --start.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "install.sh must run as root" >&2
  exit 1
fi

START=0
REFRESH_ENV=0
BINARY=""
for arg in "$@"; do
  case "$arg" in
    --start) START=1 ;;
    --refresh-env) REFRESH_ENV=1 ;;
    --) ;;
    -*)
      echo "unknown option: $arg" >&2
      exit 1
      ;;
    *)
      if [[ -n "$BINARY" ]]; then
        echo "unexpected extra argument: $arg" >&2
        exit 1
      fi
      BINARY=$arg
      ;;
  esac
done

if [[ -z "$BINARY" || ! -f "$BINARY" ]]; then
  echo "usage: install.sh [--refresh-env] [--start] <binary>" >&2
  exit 1
fi

if ! id poko-bot >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/poko-bot --create-home --shell /usr/sbin/nologin poko-bot
fi

install -d -o root -g poko-bot -m 0750 /etc/poko-bot
install -d -o root -g root -m 0755 /opt/poko-bot/bin
install -o root -g root -m 0755 "$BINARY" /opt/poko-bot/bin/poko-bot

KEYS=(
  TELEGRAM_BOT_TOKEN_POKO
  DISCORD_BOT_TOKEN_POKO
  POKO_API_TOKEN
  POKO_MARKET_API_TOKEN
  GEMINI_API_KEY
  TELEGRAM_CHAT_ID_POKO
  DISCORD_ALLOWED_CHANNEL_IDS_POKO
  DISCORD_ALLOWED_USER_IDS_POKO
)
SRC=/opt/hermes-poko/.env.local
ENV_FILE=/etc/poko-bot/env

copy_selected_keys() {
  local tmp
  tmp=$(mktemp /etc/poko-bot/env.XXXXXX)
  : >"$tmp"
  local line key want
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    [[ -z "$line" || "$line" == \#* ]] && continue
    line=${line#export }
    key=${line%%=*}
    for want in "${KEYS[@]}"; do
      if [[ "$key" == "$want" ]]; then
        printf '%s\n' "$line" >>"$tmp"
        break
      fi
    done
  done <"$SRC"
  install -o root -g poko-bot -m 0640 "$tmp" "$ENV_FILE"
  rm -f "$tmp"
  echo "wrote $ENV_FILE from selected keys in $SRC"
}

if [[ -f "$ENV_FILE" && "$REFRESH_ENV" -eq 0 ]]; then
  echo "keeping existing $ENV_FILE"
elif [[ -f "$SRC" ]]; then
  copy_selected_keys
elif [[ ! -f "$ENV_FILE" ]]; then
  install -o root -g poko-bot -m 0640 /dev/null "$ENV_FILE"
  echo "created empty $ENV_FILE ($SRC is absent)"
else
  echo "keeping existing $ENV_FILE ($SRC is absent)"
fi

SWITCH=/etc/poko-bot/switch.env
if [[ ! -f "$SWITCH" ]]; then
  cat >"$SWITCH" <<'EOF'
POKO_BOT_TELEGRAM=off
POKO_BOT_DISCORD=off
POKO_BOT_BRAIN_MODE=canary
EOF
  chown root:poko-bot "$SWITCH"
  chmod 0640 "$SWITCH"
  echo "created $SWITCH with both platforms off"
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
install -o root -g root -m 0644 "$SCRIPT_DIR/poko-bot.service" /etc/systemd/system/poko-bot.service
install -o root -g root -m 0755 "$SCRIPT_DIR/poko-switch.sh" /usr/local/sbin/poko-switch

systemctl daemon-reload
if [[ "$START" -eq 1 ]]; then
  systemctl enable poko-bot.service
  systemctl restart poko-bot.service
  echo "enabled and restarted poko-bot"
else
  echo "unit installed; not started (pass --start)"
fi
