#!/usr/bin/env bash
# Point the nightly CardTrader job at a clean checkout of origin/main.
#
#   scripts/deploy-cardtrader-daily-checkout.sh [<commit>]   # default: origin/main
#
# pokoin-all-cardtrader-daily runs scripts/run-all-cardtrader-daily.sh from the one
# detached checkout $POKOIN_DEPLOY_DIR/cardtrader-daily (default ~/pokoin-deploy), never
# from the canonical checkout, whose WIP ran at night until 2026-10-19. This moves that
# checkout to <commit> (it must be on origin/main) and installs the unit and timer from
# it. It holds the job's lock, so it waits for a running job and never switches code
# under one. The Rust dump and price cache binaries: scripts/deploy-cardtrader-dump.sh.
set -euo pipefail
die() { echo "deploy-cardtrader-daily-checkout: $*" >&2; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
DEPLOY="${POKOIN_DEPLOY_DIR:-$HOME/pokoin-deploy}"
SRC="$DEPLOY/cardtrader-daily"
UNITS="${POKOIN_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
LOCK="${POKOIN_CT_DAILY_LOCK:-/home/nez/data/pokoin-catalog-refresh/daily.lock}"
UNIT=pokoin-all-cardtrader-daily

git -C "$REPO" fetch -q origin
COMMIT="$(git -C "$REPO" rev-parse "${1:-origin/main}^{commit}")"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "${COMMIT:0:12} is not on origin/main"

# The unit's ExecStart takes this lock with flock -n.
mkdir -p "$(dirname "$LOCK")" "$DEPLOY" "$UNITS"
exec 9>>"$LOCK"
flock -n 9 || { echo "deploy-cardtrader-daily-checkout: waiting for the running job" >&2; flock 9; }

if ! git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$REPO" worktree prune
  git -C "$REPO" worktree add -q --detach "$SRC" "$COMMIT"
fi
git -C "$SRC" checkout -q --detach --force "$COMMIT"
git -C "$SRC" clean -q -ffdx
[[ "$(git -C "$SRC" rev-parse HEAD)" == "$COMMIT" ]] || die "checkout is not at ${COMMIT:0:12}"

for file in "$UNIT.service" "$UNIT.timer"; do
  install -m 0644 "$SRC/deploy/systemd/$file" "$UNITS/$file"
done
systemctl --user daemon-reload
workdir="$(systemctl --user show "$UNIT.service" -p WorkingDirectory --value)"
[[ "$workdir" == "$SRC" ]] || die "$UNIT.service runs in $workdir, not $SRC (POKOIN_DEPLOY_DIR must stay ~/pokoin-deploy)"
systemctl --user is-enabled -q "$UNIT.timer" || die "$UNIT.timer is not enabled"
echo "cardtrader daily job ${COMMIT:0:12} installed: $SRC; next run $(systemctl --user show "$UNIT.timer" -p NextElapseUSecRealtime --value)"
