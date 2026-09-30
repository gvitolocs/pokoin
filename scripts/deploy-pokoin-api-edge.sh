#!/usr/bin/env bash
# Deploy scripts/pokoin-api-edge.js to the Pi from an exact origin/main commit
# and turn on nezopt overflow (docs/NEZOPT_OVERFLOW.md).
#
#   scripts/deploy-pokoin-api-edge.sh [commit]
#   POKOIN_API_OVERFLOW_ORIGIN= scripts/deploy-pokoin-api-edge.sh   # overflow off
#
# Rolls back to the previous edge file if :18079 does not answer afterwards.
set -euo pipefail

die() { echo "deploy-pokoin-api-edge: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
PI="${PI_HOST:-pi-home}"
EDGE=/srv/pokoin/card-images/tools/pokoin-api-edge.js
OVERFLOW="${POKOIN_API_OVERFLOW_ORIGIN-http://192.168.178.55:30880}"
LOCAL_MAX="${POKOIN_API_LOCAL_MAX:-16}"

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; merge it first"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git -C "$REPO" show "$COMMIT:scripts/pokoin-api-edge.js" >"$STAGE/pokoin-api-edge.js"
git -C "$REPO" show "$COMMIT:scripts/pokoin-api-edge.test.js" >"$STAGE/pokoin-api-edge.test.js"
say "edge tests @ ${COMMIT:0:12}"
node --test "$STAGE/pokoin-api-edge.test.js" | grep -E "^# (pass|fail)"
node --check "$STAGE/pokoin-api-edge.js"

if [[ -n "$OVERFLOW" ]]; then
  say "overflow origin reachable from the Pi?"
  ssh "$PI" "curl -sf -o /dev/null --max-time 5 '$OVERFLOW/api/marketplace-suggest?q=pika&limit=1'" \
    || die "Pi cannot reach $OVERFLOW — start nezopt k3s first (scripts/nezopt-k3s.sh status)"
fi

say "install on $PI (previous kept as .prev)"
scp -q "$STAGE/pokoin-api-edge.js" "$PI:$EDGE.new"
ssh "$PI" "set -e
cp -a $EDGE $EDGE.prev
install -o nes -g nes -m 0644 $EDGE.new $EDGE && rm -f $EDGE.new
mkdir -p /etc/systemd/system/pokoin-api-edge.service.d
cat >/etc/systemd/system/pokoin-api-edge.service.d/overflow.conf <<CONF
[Service]
Environment=POKOIN_API_OVERFLOW_ORIGIN=$OVERFLOW
Environment=POKOIN_API_LOCAL_MAX=$LOCAL_MAX
CONF
systemctl daemon-reload
systemctl restart pokoin-api-edge.service"

check() {
  ssh "$PI" "for i in 1 2 3 4 5 6 7 8 9 10; do
    code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 'http://127.0.0.1:18079/api/marketplace-suggest?q=pika&limit=1') && [ \"\$code\" = 200 ] && exit 0
    sleep 1
  done; exit 1"
}

if ! check; then
  say "edge not answering — rolling back"
  ssh "$PI" "cp -a $EDGE.prev $EDGE && systemctl restart pokoin-api-edge.service"
  die "rolled back to the previous edge"
fi
ssh "$PI" "journalctl -u pokoin-api-edge.service -n 1 --no-pager -o cat"
say "edge live @ ${COMMIT:0:12} overflow=${OVERFLOW:-off} localMax=$LOCAL_MAX"
