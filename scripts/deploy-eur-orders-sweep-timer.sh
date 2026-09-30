#!/usr/bin/env bash
# Install the EUR order sweep timer from an exact origin/main commit. The
# runtime JS (api/eur-orders-sweep.js) must already be in the API release
# (scripts/deploy-checkout-eur-api.sh).
set -euo pipefail

die() { echo "deploy-eur-orders-sweep-timer: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
STAGE="$(mktemp -d /tmp/pokoin-eur-sweep-timer-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

for file in pokoin-eur-orders-sweep.service pokoin-eur-orders-sweep.timer; do
  git -C "$REPO" show "$COMMIT:scripts/$file" > "$STAGE/$file"
done

ssh pi-home "test -f /srv/pokoin/api/current/api/eur-orders-sweep.js" \
  || die "api/eur-orders-sweep.js is not in the live API release; run deploy-checkout-eur-api.sh first"

say "dry run against live orders"
ssh pi-home "docker exec -w /app pokoin-oracle-api node /app/api/eur-orders-sweep.js --dry-run"

say "install timer from $COMMIT"
scp -q "$STAGE/"* pi-home:/tmp/
ssh pi-home "set -e; \
  sudo install -m 0644 /tmp/pokoin-eur-orders-sweep.service /etc/systemd/system/; \
  sudo install -m 0644 /tmp/pokoin-eur-orders-sweep.timer /etc/systemd/system/; \
  sudo systemctl daemon-reload; \
  sudo systemctl enable --now pokoin-eur-orders-sweep.timer; \
  sudo systemctl start pokoin-eur-orders-sweep.service"

say "verify timer and last service result"
ssh pi-home "systemctl is-active pokoin-eur-orders-sweep.timer; \
  systemctl show pokoin-eur-orders-sweep.service -p Result -p ExecMainStatus --value; \
  systemctl list-timers pokoin-eur-orders-sweep.timer --no-pager"
