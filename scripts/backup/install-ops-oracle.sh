#!/usr/bin/env bash
# Installs failure mail + dead-man pings for the Oracle CardTrader market refresh, run
# from nezopt. A host change that needs Giuseppe's OK first (docs/BACKUPS_AND_ALERTS.md).
#
#   scripts/backup/install-ops-oracle.sh
set -euo pipefail
HOST="${POKOIN_ORACLE_HOST:-pokoin-marketplace}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
ops="$repo/deploy/ops/oracle"
bin="${POKOIN_OPS_DIST:-$HOME/pokoin-deploy/pokoin-ops}/x86_64/pokoin-ops"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST")
die() { echo "install-ops-oracle: $*" >&2; exit 1; }

[[ -x "$bin" ]] || die "build first: scripts/backup/build-pokoin-ops.sh"
"${SSH[@]}" systemctl cat pokoin-cardtrader-daily-market-refresh.service >/dev/null || die "unit not found on $HOST"
scp -q -o BatchMode=yes "$bin" "$HOST:/tmp/pokoin-ops.new"
scp -q -o BatchMode=yes "$ops/pokoin-notify@.service" "$HOST:/tmp/pokoin-notify@.service"
scp -q -o BatchMode=yes "$ops/pokoin-cardtrader-daily-market-refresh.service.d-alerts.conf" "$HOST:/tmp/ct-alerts.conf"
if ! "${SSH[@]}" sudo -n test -f /etc/pokoin/alerts.env; then
  key="$(grep -E '^(POKOIN_UPTIME_RESEND_API_KEY|RESEND_API_KEY)=' "$HOME/.config/pokoin/uptime-mail.env" | head -1 | cut -d= -f2- | tr -d "\"'")"
  [[ -n "$key" ]] || die "no Resend key in ~/.config/pokoin/uptime-mail.env"
  hc="$(grep -E '^POKOIN_HC_PING_KEY=' "$HOME/.config/pokoin/alerts.env" 2>/dev/null | cut -d= -f2- || true)"
  printf 'RESEND_API_KEY=%s\nPOKOIN_HC_PING_KEY=%s\nPOKOIN_HC_SLUG_PREFIX=oracle-\n' "$key" "$hc" \
    | "${SSH[@]}" 'sudo -n install -d -m 755 /etc/pokoin && sudo -n sh -c "umask 077; cat > /etc/pokoin/alerts.env"'
fi
"${SSH[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
sudo -n install -o root -g root -m 755 /tmp/pokoin-ops.new /usr/local/bin/pokoin-ops
sudo -n install -m 644 /tmp/pokoin-notify@.service /etc/systemd/system/pokoin-notify@.service
sudo -n install -D -m 644 /tmp/ct-alerts.conf /etc/systemd/system/pokoin-cardtrader-daily-market-refresh.service.d/alerts.conf
rm -f /tmp/pokoin-ops.new /tmp/pokoin-notify@.service /tmp/ct-alerts.conf
sudo -n systemctl daemon-reload
/usr/local/bin/pokoin-ops --version
systemctl show pokoin-cardtrader-daily-market-refresh.service -p OnFailure -p ExecStartPre --no-pager | cut -c1-160
REMOTE
