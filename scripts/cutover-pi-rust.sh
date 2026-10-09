#!/usr/bin/env bash
# Switch the Pi from the Node backend to the native Rust unit, or roll back.
#
#   scripts/cutover-pi-rust.sh            # apply: Rust owns :18079 edge, :18081 CDN, :18090 ct-deals + jobs
#   scripts/cutover-pi-rust.sh --rollback # restore the Node edge/CDN/ct-deals/API and Node timers
#
# Run from a clean checkout of the exact origin/main commit that is already
# deployed with scripts/deploy-pokoin-rust.sh. Node units are disabled, not
# deleted, so --rollback works until they are removed from the host.
set -euo pipefail
die() { echo "cutover-pi-rust: $*" >&2; exit 1; }
REPO="$(git rev-parse --show-toplevel)"
PI="${PI_HOST:-pi-home}"
MODE=apply
[[ "${1:-}" == "--rollback" ]] && MODE=rollback
git -C "$REPO" fetch -q origin
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$(git -C "$REPO" rev-parse origin/main)" ]] || die "checkout must be origin/main"
git -C "$REPO" diff --quiet HEAD -- || die "tracked changes must be committed"

STAGE="/tmp/pokoin-rust-cutover-$$"
ssh "$PI" "mkdir -p '$STAGE'"
scp -q "$REPO/deploy/systemd/pokoin-rust-api.service" "$REPO/deploy/systemd/pokoin-rust-job@.service" \
  "$REPO"/deploy/systemd/pokoin-rust-job-*.timer "$REPO/scripts/pokoin-pi-watchdog.sh" "$PI:$STAGE/"

ssh "$PI" "MODE=$MODE STAGE=$STAGE bash -s" <<'REMOTE'
set -euo pipefail
NODE_UNITS="pokoin-api-edge.service pokoin-card-images.service pokoin-ct-deals.service"
NODE_TIMERS="pokoin-eur-orders-sweep.timer pokoin-referral-reconcile.timer pokoin-cardtrader-seller-reconcile.timer pokoin-meili-marketplace-delta.timer"
RUST_TIMERS="pokoin-rust-job-eur-orders-sweep.timer pokoin-rust-job-referral-reconcile.timer pokoin-rust-job-cardtrader-seller-reconcile.timer pokoin-rust-job-search-delta.timer"
ENV=/srv/pokoin/rust/pokoin-api.env
BACKUP_ROOT=/srv/pokoin/rollbacks
log() { echo "{\"event\":\"cutover\",\"mode\":\"$MODE\",\"step\":\"$*\"}"; }

wait_rust() {
  for _ in $(seq 1 40); do
    if curl -fsS -m 2 -o /dev/null http://127.0.0.1:18079/livez \
      && curl -fsS -m 2 -o /dev/null http://127.0.0.1:18081/health \
      && curl -fsS -m 2 -o /dev/null http://127.0.0.1:18090/ \
      && curl -fsS -m 2 http://127.0.0.1:18082/health | grep -q '"ok":true'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  local backup="$1"
  log "rollback from $backup"
  systemctl disable --now $RUST_TIMERS 2>/dev/null || true
  install -m 0644 "$backup/pokoin-rust-api.service" /etc/systemd/system/pokoin-rust-api.service
  [[ -f "$backup/pokoin-pi-watchdog.sh" ]] && install -m 0755 "$backup/pokoin-pi-watchdog.sh" /usr/local/sbin/pokoin-pi-watchdog.sh
  [[ -f "$backup/pokoin-api.env" ]] && install -m 0640 -o root -g nes "$backup/pokoin-api.env" "$ENV"
  systemctl daemon-reload
  systemctl stop pokoin-rust-api.service
  docker update --restart=unless-stopped pokoin-oracle-api >/dev/null
  docker start pokoin-oracle-api >/dev/null
  systemctl enable --now $NODE_UNITS
  systemctl start pokoin-rust-api.service
  systemctl enable --now $NODE_TIMERS
  log "node restored"
}

if [[ "$MODE" == rollback ]]; then
  latest="$(ls -1d $BACKUP_ROOT/node-cutover-* 2>/dev/null | tail -1)"
  [[ -n "$latest" ]] || { echo "no cutover backup" >&2; exit 1; }
  rollback "$latest"
  exit 0
fi

backup="$BACKUP_ROOT/node-cutover-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
cp -p /etc/systemd/system/pokoin-rust-api.service "$backup/"
cp -p /usr/local/sbin/pokoin-pi-watchdog.sh "$backup/" 2>/dev/null || true
cp -p "$ENV" "$backup/pokoin-api.env"
log "backup $backup"

install -m 0644 "$STAGE/pokoin-rust-api.service" /etc/systemd/system/pokoin-rust-api.service
install -m 0644 "$STAGE/pokoin-rust-job@.service" /etc/systemd/system/
install -m 0644 "$STAGE"/pokoin-rust-job-*.timer /etc/systemd/system/
rm -f /etc/systemd/system/pokoin-rust-api.service.d/20-edge-cutover.conf
# The Rust outbox worker owns listing sync once Node stops.
# Any spelling: 0, "0" or '0' (the Pi env file quotes every value).
sed -i -E "/^POKOIN_LISTING_SYNC_WORKER=[\"']?0[\"']?[[:space:]]*\$/d" "$ENV"
systemctl daemon-reload

log "stop node"
systemctl disable --now $NODE_TIMERS 2>/dev/null || true
systemctl disable --now $NODE_UNITS
docker update --restart=no pokoin-oracle-api >/dev/null
docker stop pokoin-oracle-api >/dev/null || true
systemctl restart pokoin-rust-api.service

if ! wait_rust; then
  log "rust listeners not healthy"
  rollback "$backup"
  exit 1
fi
systemctl enable --now $RUST_TIMERS
install -m 0755 "$STAGE/pokoin-pi-watchdog.sh" /usr/local/sbin/pokoin-pi-watchdog.sh
log "done: rust owns 18079 18081 18090 18082 and the jobs"
REMOTE
ssh "$PI" "rm -rf '$STAGE'"
