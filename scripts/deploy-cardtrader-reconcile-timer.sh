#!/usr/bin/env bash
# Install the connected-seller CardTrader reconciliation timer from an exact
# origin/main commit. The runtime JS must already be present in the API release.
set -euo pipefail

die() { echo "deploy-cardtrader-reconcile-timer: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
STAGE="$(mktemp -d /tmp/pokoin-ct-reconcile-timer-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

for file in pokoin-cardtrader-seller-reconcile.service pokoin-cardtrader-seller-reconcile.timer; do
  git -C "$REPO" show "$COMMIT:scripts/$file" > "$STAGE/$file"
done

say "install timer from $COMMIT"
scp -q "$STAGE/"* pi-home:/tmp/
ssh pi-home "set -e; \
  sudo install -m 0644 /tmp/pokoin-cardtrader-seller-reconcile.service /etc/systemd/system/; \
  sudo install -m 0644 /tmp/pokoin-cardtrader-seller-reconcile.timer /etc/systemd/system/; \
  sudo systemctl daemon-reload; \
  sudo systemctl enable --now pokoin-cardtrader-seller-reconcile.timer; \
  sudo systemctl start pokoin-cardtrader-seller-reconcile.service"

say "verify timer and last service result"
ssh pi-home "systemctl is-active pokoin-cardtrader-seller-reconcile.timer; \
  systemctl show pokoin-cardtrader-seller-reconcile.service -p Result -p ExecMainStatus --value; \
  systemctl list-timers pokoin-cardtrader-seller-reconcile.timer --no-pager"
