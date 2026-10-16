#!/usr/bin/env bash
# Installs pokoin-ops pieces on the Pi, run from nezopt. Each step is a host change that
# needs Giuseppe's OK first (docs/BACKUPS_AND_ALERTS.md).
#
#   scripts/backup/install-ops-pi.sh alerts                      # notify@, OnFailure + dead-man drop-ins, sentinel
#   scripts/backup/install-ops-pi.sh walg <wal-g binary> <sha256> # wal-g, spool, wal-push + basebackup timers
#   scripts/backup/install-ops-pi.sh archiving --restart-replica # archive_mode=always on the standby (restarts it)
set -euo pipefail
HOST="${POKOIN_PI_HOST:-pi-home}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
ops="$repo/deploy/ops/pi"
bin="${POKOIN_OPS_DIST:-$HOME/pokoin-deploy/pokoin-ops}/aarch64/pokoin-ops"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST")
die() { echo "install-ops-pi: $*" >&2; exit 1; }
say() { echo "== $*"; }
put() { scp -q -o BatchMode=yes "$1" "$HOST:$2"; }

alerts() {
  [[ -x "$bin" ]] || die "build first: scripts/backup/build-pokoin-ops.sh"
  say "pokoin-ops → $HOST:/usr/local/bin"
  put "$bin" /tmp/pokoin-ops.new
  "${SSH[@]}" 'install -o root -g root -m 755 /tmp/pokoin-ops.new /usr/local/bin/pokoin-ops && rm /tmp/pokoin-ops.new && pokoin-ops --version'
  if ! "${SSH[@]}" test -f /etc/pokoin/alerts.env; then
    say "/etc/pokoin/alerts.env (Resend key from ~/.config/pokoin/uptime-mail.env)"
    key="$(grep -E '^(POKOIN_UPTIME_RESEND_API_KEY|RESEND_API_KEY)=' "$HOME/.config/pokoin/uptime-mail.env" | head -1 | cut -d= -f2- | tr -d "\"'")"
    [[ -n "$key" ]] || die "no Resend key in ~/.config/pokoin/uptime-mail.env"
    hc="$(grep -E '^POKOIN_HC_PING_KEY=' "$HOME/.config/pokoin/alerts.env" 2>/dev/null | cut -d= -f2- || true)"
    printf 'RESEND_API_KEY=%s\nPOKOIN_HC_PING_KEY=%s\nPOKOIN_HC_SLUG_PREFIX=pi-\n' "$key" "$hc" \
      | "${SSH[@]}" 'umask 077; mkdir -p /etc/pokoin && cat > /etc/pokoin/alerts.env'
  fi
  say "units"
  for f in pokoin-notify@.service pokoin-sentinel.service pokoin-sentinel.timer; do put "$ops/$f" "/tmp/$f"; done
  put "$ops/pokoin-rust-job@.service.d-alerts.conf" /tmp/rust-job-alerts.conf
  put "$ops/pokoin-pi-watchdog.service.d-alerts.conf" /tmp/watchdog-alerts.conf
  "${SSH[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
for f in pokoin-notify@.service pokoin-sentinel.service pokoin-sentinel.timer; do
  install -m 644 "/tmp/$f" "/etc/systemd/system/$f" && rm "/tmp/$f"
done
install -D -m 644 /tmp/rust-job-alerts.conf /etc/systemd/system/pokoin-rust-job@.service.d/alerts.conf
install -D -m 644 /tmp/watchdog-alerts.conf /etc/systemd/system/pokoin-pi-watchdog.service.d/alerts.conf
rm /tmp/rust-job-alerts.conf /tmp/watchdog-alerts.conf
systemctl daemon-reload
pokoin-ops sentinel --role pi --dry-run
systemctl enable --now pokoin-sentinel.timer
systemctl list-timers pokoin-sentinel.timer --no-pager
REMOTE
}

walg() {
  local walg_bin="${1:-}" sha="${2:-}"
  [[ -f "$walg_bin" && -n "$sha" ]] || die "usage: walg <wal-g aarch64 binary> <sha256 from the release page>"
  echo "$sha  $walg_bin" | sha256sum -c - || die "wal-g checksum mismatch"
  file "$walg_bin" | grep -q 'ARM aarch64' || die "$walg_bin is not an aarch64 binary"
  "${SSH[@]}" test -f /etc/pokoin/walg.env || die "create /etc/pokoin/walg.env on $HOST first (deploy/ops/pi/walg.env.example)"
  say "wal-g, spool and timers on $HOST"
  put "$walg_bin" /tmp/wal-g.new
  put "$repo/scripts/backup/walspool-archive.sh" /tmp/walspool-archive.sh
  for f in pokoin-wal-push.service pokoin-wal-push.timer pokoin-basebackup.service pokoin-basebackup.timer; do put "$ops/$f" "/tmp/$f"; done
  "${SSH[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
install -o root -g root -m 755 /tmp/wal-g.new /usr/local/bin/wal-g && rm /tmp/wal-g.new
chmod 600 /etc/pokoin/walg.env
# Spool next to PGDATA, on /srv/pokoin; written by the container's postgres (uid 70).
install -d -o 70 -g 70 -m 750 /srv/pokoin/postgres/wal-spool
install -d -o root -g root -m 755 /srv/pokoin/postgres/wal-spool-bin
install -o root -g root -m 755 /tmp/walspool-archive.sh /srv/pokoin/postgres/wal-spool-bin/walspool-archive.sh
rm /tmp/walspool-archive.sh
for f in pokoin-wal-push.service pokoin-wal-push.timer pokoin-basebackup.service pokoin-basebackup.timer; do
  install -m 644 "/tmp/$f" "/etc/systemd/system/$f" && rm "/tmp/$f"
done
systemctl daemon-reload
set -a; . /etc/pokoin/walg.env; set +a
wal-g --version
wal-g backup-list 2>&1 | tail -3 || true   # proves storage credentials and the bucket
systemctl enable --now pokoin-wal-push.timer pokoin-basebackup.timer
echo "archiving is still off: run 'install-ops-pi.sh archiving --restart-replica' next"
REMOTE
}

archiving() {
  [[ "${1:-}" == "--restart-replica" ]] || die "this restarts the Pi replica (the API answers 503 for a few seconds); pass --restart-replica"
  "${SSH[@]}" test -x /usr/local/bin/wal-g || die "run the walg step first"
  "${SSH[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
c=pokoin-marketplace-postgres-replica
q() { docker exec "$c" psql -X -q -At -U pokoin_marketplace -d postgres -c "$1"; }
[[ "$(q 'select pg_is_in_recovery()')" == t ]] || { echo "replica is not in recovery; stop" >&2; exit 1; }
q "alter system set archive_mode = 'always'"
q "alter system set archive_command = 'sh /var/lib/postgresql/data/wal-spool-bin/walspool-archive.sh %p %f'"
systemctl stop pokoin-pi-watchdog.timer
trap 'systemctl start pokoin-pi-watchdog.timer' EXIT
docker restart "$c" >/dev/null
for _ in $(seq 60); do q 'select 1' >/dev/null 2>&1 && break; sleep 1; done
q "select current_setting('archive_mode'), status from pg_stat_wal_receiver"
curl -fsS --max-time 10 http://127.0.0.1:18079/healthz; echo
sleep 90
q "select archived_count, failed_count, last_archived_wal from pg_stat_archiver"
ls /srv/pokoin/postgres/wal-spool | head
systemctl start pokoin-basebackup.service --no-block
echo "first base backup started: journalctl -fu pokoin-basebackup"
REMOTE
}

case "${1:-}" in
  alerts) alerts ;;
  walg) shift; walg "$@" ;;
  archiving) shift; archiving "$@" ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
