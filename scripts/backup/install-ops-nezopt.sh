#!/usr/bin/env bash
# Installs pokoin-ops pieces on nezopt as user units (no sudo). Each step is a host
# change that needs Giuseppe's OK first (docs/BACKUPS_AND_ALERTS.md).
#
#   scripts/backup/install-ops-nezopt.sh alerts          # notify@, OnFailure + dead-man drop-ins, sentinel
#   scripts/backup/install-ops-nezopt.sh slot-cap        # writer max_slot_wal_keep_size = 50GB (reload only)
#   scripts/backup/install-ops-nezopt.sh backups         # nightly pg_dump, wal-g mirror, monthly restore tests
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
ops="$repo/deploy/ops/nezopt-user"
bin="${POKOIN_OPS_DIST:-$HOME/pokoin-deploy/pokoin-ops}/x86_64/pokoin-ops"
units="$HOME/.config/systemd/user"
cfg="$HOME/.config/pokoin"
die() { echo "install-ops-nezopt: $*" >&2; exit 1; }
say() { echo "== $*"; }

install_bin() {
  [[ -x "$bin" ]] || die "build first: scripts/backup/build-pokoin-ops.sh"
  install -D -m 755 "$bin" "$HOME/.local/bin/pokoin-ops"
  "$HOME/.local/bin/pokoin-ops" --version
}

dropin() { # unit
  install -D -m 644 "$ops/$1.d-alerts.conf" "$units/$1.d/alerts.conf"
}

alerts() {
  install_bin
  mkdir -p "$cfg"
  if [[ ! -f "$cfg/alerts.env" ]]; then
    ( umask 077; printf 'POKOIN_HC_PING_KEY=\nPOKOIN_HC_SLUG_PREFIX=nezopt-\n' >"$cfg/alerts.env" )
    say "wrote $cfg/alerts.env; add the healthchecks ping key when the project exists"
  fi
  install -m 644 "$ops/pokoin-notify@.service" "$ops/pokoin-sentinel.service" "$ops/pokoin-sentinel.timer" "$units/"
  for u in pokoin-all-cardtrader-daily.service pokoin-site-map-refresh.service pokoin-overflow-sync.service \
           pokoin-shipping-rates-sync.service pokoin-uptime-mail.service; do
    dropin "$u"
  done
  systemctl --user daemon-reload
  "$HOME/.local/bin/pokoin-ops" sentinel --role nezopt --dry-run
  systemctl --user enable --now pokoin-sentinel.timer
  systemctl --user list-timers pokoin-sentinel.timer --no-pager
}

slot_cap() {
  local c=pokoin-marketplace-postgres-15t
  q() { docker exec "$c" psql -X -q -At -U pokoin_marketplace -d pokoin_marketplace -c "$1"; }
  [[ "$(q 'select pg_is_in_recovery()')" == f ]] || die "$c is not the writer"
  q "alter system set max_slot_wal_keep_size = '50GB'"
  q "select pg_reload_conf()" >/dev/null
  sleep 1
  echo "max_slot_wal_keep_size = $(q 'show max_slot_wal_keep_size')"
  q "select slot_name, active, wal_status, safe_wal_size from pg_replication_slots"
}

backups() {
  install_bin
  [[ -f "$cfg/backup.env" ]] || die "create $cfg/backup.env first (deploy/ops/nezopt-user/backup.env.example)"
  chmod 600 "$cfg/backup.env"
  set -a; . "$cfg/backup.env"; set +a
  mountpoint -q "${POKOIN_BACKUP_REQUIRE_MOUNT:-/home/nez/mnt/mybook}" || die "mybook is not mounted"
  [[ -f "$cfg/backup-age.key" ]] || "$HOME/.local/bin/pokoin-ops" backup keygen
  mkdir -p "$POKOIN_BACKUP_DIR/dumps"
  ssh -o BatchMode=yes pi-home true || die "nezopt cannot ssh to pi-home"
  for f in pokoin-pgdump.service pokoin-pgdump.timer pokoin-backup-mirror.service pokoin-backup-mirror.timer \
           pokoin-restore-test.service pokoin-restore-test.timer; do
    install -m 644 "$ops/$f" "$units/"
  done
  systemctl --user daemon-reload
  systemctl --user enable --now pokoin-pgdump.timer
  if [[ -x "${POKOIN_WALG:-$HOME/.local/bin/wal-g}" && -f "${POKOIN_WALG_MIRROR_ENV:-$cfg/walg-mirror.env}" ]]; then
    systemctl --user enable --now pokoin-backup-mirror.timer pokoin-restore-test.timer
  else
    say "wal-g mirror not configured yet: pokoin-backup-mirror and pokoin-restore-test stay disabled"
  fi
  systemctl --user list-timers 'pokoin-pgdump*' 'pokoin-backup-mirror*' 'pokoin-restore-test*' --no-pager
}

case "${1:-}" in
  alerts) alerts ;;
  slot-cap) slot_cap ;;
  backups) backups ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
