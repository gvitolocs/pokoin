#!/usr/bin/env bash
# Deploy scripts/pokoin-api-edge.js plus the shared CORS/client-IP policy
# modules to the Pi from an exact origin/main commit. The nezopt overflow
# model is retired (the NodePort is being removed), so overflow defaults to
# off; set POKOIN_API_OVERFLOW_ORIGIN explicitly to re-enable it.
#
#   scripts/deploy-pokoin-api-edge.sh [commit]
#
# Rolls back to the previous edge + policy files if :18079 does not answer.
set -euo pipefail

die() { echo "deploy-pokoin-api-edge: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
PI="${PI_HOST:-pi-home}"
EDGE=/srv/pokoin/card-images/tools/pokoin-api-edge.js
CORS=/srv/pokoin/card-images/tools/pokoin-cors-policy.js
CLIENT_IP=/srv/pokoin/card-images/tools/pokoin-client-ip.js
OVERFLOW="${POKOIN_API_OVERFLOW_ORIGIN-}"
LOCAL_MAX="${POKOIN_API_LOCAL_MAX:-16}"

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; merge it first"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git -C "$REPO" show "$COMMIT:scripts/pokoin-api-edge.js" >"$STAGE/pokoin-api-edge.js"
git -C "$REPO" show "$COMMIT:scripts/pokoin-api-edge.test.js" >"$STAGE/pokoin-api-edge.test.js"
git -C "$REPO" show "$COMMIT:server/pokoin-api/_cors_policy.js" >"$STAGE/pokoin-cors-policy.js"
git -C "$REPO" show "$COMMIT:server/pokoin-api/_client_ip.js" >"$STAGE/pokoin-client-ip.js"
say "edge tests @ ${COMMIT:0:12}"
# The tests import the shared policy modules from the repo layout.
mkdir -p "$STAGE/repo"
git -C "$REPO" archive "$COMMIT" scripts/pokoin-api-edge.js scripts/pokoin-api-edge.test.js \
  server/pokoin-api/_cors_policy.js server/pokoin-api/_client_ip.js server/pokoin-api/_cardtrader_game_ingest.js \
  | tar -C "$STAGE/repo" -xf -
(cd "$STAGE/repo" && node --test scripts/pokoin-api-edge.test.js) | grep -E "^# (pass|fail)"
node --check "$STAGE/pokoin-api-edge.js"
node --check "$STAGE/pokoin-cors-policy.js"
node --check "$STAGE/pokoin-client-ip.js"

if [[ -n "$OVERFLOW" ]]; then
  say "overflow origin reachable from the Pi?"
  ssh "$PI" "curl -sf -o /dev/null --max-time 5 '$OVERFLOW/api/marketplace-suggest?q=pika&limit=1'" \
    || die "Pi cannot reach $OVERFLOW — start nezopt k3s first (scripts/nezopt-k3s.sh status)"
fi

say "install on $PI (previous kept as .prev)"
scp -q "$STAGE/pokoin-api-edge.js" "$PI:$EDGE.new"
scp -q "$STAGE/pokoin-cors-policy.js" "$PI:$CORS.new"
scp -q "$STAGE/pokoin-client-ip.js" "$PI:$CLIENT_IP.new"
ssh "$PI" "set -e
cp -a $EDGE $EDGE.prev
cp -a $CORS $CORS.prev
cp -a $CLIENT_IP $CLIENT_IP.prev
install -o nes -g nes -m 0644 $EDGE.new $EDGE && rm -f $EDGE.new
install -o nes -g nes -m 0644 $CORS.new $CORS && rm -f $CORS.new
install -o nes -g nes -m 0644 $CLIENT_IP.new $CLIENT_IP && rm -f $CLIENT_IP.new
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
  ssh "$PI" "cp -a $EDGE.prev $EDGE && cp -a $CORS.prev $CORS && cp -a $CLIENT_IP.prev $CLIENT_IP && systemctl restart pokoin-api-edge.service"
  die "rolled back to the previous edge"
fi
ssh "$PI" "journalctl -u pokoin-api-edge.service -n 1 --no-pager -o cat"
say "edge live @ ${COMMIT:0:12} overflow=${OVERFLOW:-off} localMax=$LOCAL_MAX"
