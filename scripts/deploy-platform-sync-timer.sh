#!/usr/bin/env bash
# Install the platform sync order-poll timer (docs/PLATFORM_SYNC.md) from an exact
# origin/main commit. The runtime JS must already be present in the API release.
set -euo pipefail

die() { echo "deploy-platform-sync-timer: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
STAGE="$(mktemp -d /tmp/pokoin-platform-sync-timer-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

for file in pokoin-platform-sync-poll.service pokoin-platform-sync-poll.timer; do
  git -C "$REPO" show "$COMMIT:scripts/$file" > "$STAGE/$file"
done

say "install timer from $COMMIT"
scp -q "$STAGE/"* pi-home:/tmp/
ssh pi-home "set -e; \
  sudo install -m 0644 /tmp/pokoin-platform-sync-poll.service /etc/systemd/system/; \
  sudo install -m 0644 /tmp/pokoin-platform-sync-poll.timer /etc/systemd/system/; \
  sudo systemctl daemon-reload; \
  sudo systemctl enable --now pokoin-platform-sync-poll.timer; \
  sudo systemctl start pokoin-platform-sync-poll.service"

say "verify timer and last service result"
ssh pi-home "systemctl is-active pokoin-platform-sync-poll.timer; \
  systemctl show pokoin-platform-sync-poll.service -p Result -p ExecMainStatus --value; \
  systemctl list-timers pokoin-platform-sync-poll.timer --no-pager"
