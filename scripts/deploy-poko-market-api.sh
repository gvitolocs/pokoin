#!/usr/bin/env bash
# Deploy the Poko market intelligence API from an exact pokoin-web commit.
# Source of truth stays in this repository under server/pokoin-api; the Pi
# runtime receives only these handlers in a cloned, atomic API release.
set -euo pipefail

die() { echo "deploy-poko-market-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-poko-market-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
# Multiple agents deploy this overlay family; wait until two consecutive
# fetches agree on origin/main so we never ship a stale tip.
prev_main=""
for _ in $(seq 1 10); do
  cur_main="$(git -C "$REPO" rev-parse origin/main)"
  [ "$cur_main" = "$prev_main" ] && break
  prev_main="$cur_main"
  sleep 3
  git -C "$REPO" fetch -q origin || true
done
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
PRICE_FILES=(_card_price_history.js marketplace-card-price-history.js marketplace-card-price-history.test.js _tcgcsv_prices.js _tcgcsv_prices.test.js marketplace-tcgplayer-history.js marketplace-tcgplayer-history.test.js)
for file in poko-market.js poko-market.test.js poko-connect.js poko-connect.test.js poko-bets.js poko-bets.test.js poko-chat.js poko-chat.test.js _poko_reply_cards.js poko-reply-cards.test.js poko-personal-context.js poko-personal-context.test.js _poko_personal_context.js _rate_limit.js _valkey.js route-definitions.json patch-route-manifest.js "${PRICE_FILES[@]}"; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "poko-market + poko-connect + poko-bets + poko-chat + personal-context tests"
node --test "$SRC/poko-market.test.js" "$SRC/poko-connect.test.js" "$SRC/poko-bets.test.js" "$SRC/poko-chat.test.js" "$SRC/poko-reply-cards.test.js" "$SRC/poko-personal-context.test.js"
node --test "$SRC/marketplace-card-price-history.test.js" "$SRC/_tcgcsv_prices.test.js" "$SRC/marketplace-tcgplayer-history.test.js"
node --check "$SRC/poko-market.js" "$SRC/poko-connect.js" "$SRC/poko-bets.js" "$SRC/poko-chat.js" "$SRC/_poko_reply_cards.js" "$SRC/poko-personal-context.js" "$SRC/_poko_personal_context.js" "$SRC/_rate_limit.js" "$SRC/_valkey.js"

release="releases/poko-market-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .poko-market-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - poko-market.js poko-market.test.js poko-connect.js poko-connect.test.js poko-bets.js poko-bets.test.js poko-chat.js poko-chat.test.js _poko_reply_cards.js poko-reply-cards.test.js poko-personal-context.js poko-personal-context.test.js _poko_personal_context.js _rate_limit.js _valkey.js route-definitions.json patch-route-manifest.js "${PRICE_FILES[@]}" \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "node '/srv/pokoin/api/$release/api/patch-route-manifest.js' '/srv/pokoin/api/$release/server/api-route-manifest.js' '/srv/pokoin/api/$release/api/route-definitions.json'; rm '/srv/pokoin/api/$release/api/patch-route-manifest.js' '/srv/pokoin/api/$release/api/route-definitions.json'"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.poko-market-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify route and authentication guard"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  unauth="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{\"tool\":\"market_snapshot\"}' http://127.0.0.1:18080/api/poko-market" || true)"
  if [[ "$health" == "200" && "$unauth" == "401" ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health poko-market=$unauth) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .poko-market-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "health=$health poko-market unauthenticated=$unauth (expect 401)"
say "remember: POKO_MARKET_SERVICE_TOKEN must be set in the pokoin-oracle-api env before first use"
