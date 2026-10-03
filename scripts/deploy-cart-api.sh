#!/usr/bin/env bash
# Deploy the account cart + personal recommendations from an exact pokoin-web commit.
# Source of truth: server/pokoin-api/marketplace-cart-sync.js,
#                  server/pokoin-api/marketplace-recommendations.js (+ helpers below).
# Pi runtime receives an overlay on /srv/pokoin/api/current — shared by Web and
# CardVault app clients. This is not a CardVault-app deploy.
#
# Schema first (writer only, Pi replica streams it):
#   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d pokoin_marketplace \
#     -v ON_ERROR_STOP=1 < scripts/sql/101_marketplace_user_carts.sql
set -euo pipefail

die() { echo "deploy-cart-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-cart-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

# Every helper the two handlers require that is not part of the Pi base
# (_marketplace_db, _firebase, _marketplace_game, _marketplace_react_card).
CART_FILES=(
  marketplace-cart-sync.js
  marketplace-recommendations.js
  _cart_store.js
  _recommend.js
  _seller_profile_cache.js
  _rate_limit.js
  _valkey.js
)

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in "${CART_FILES[@]}" route-definitions.json patch-route-manifest.js; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "cart + recommendations unit tests"
node --test "$SRC/_cart_store.test.js" "$SRC/marketplace-cart-sync.test.js" \
  "$SRC/_recommend.test.js" "$SRC/marketplace-recommendations.test.js"
for file in "${CART_FILES[@]}"; do
  node --check "$SRC/$file"
done

release="releases/cart-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .cart-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - "${CART_FILES[@]}" \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-cart-commit'"
# The Pi API mounts routes from server/api-route-manifest.js — add the two
# routes to the NEW release (a copy of the previous current).
scp -q "$SRC/route-definitions.json" pi-home:/tmp/cart-routes.json
scp -q "$SRC/patch-route-manifest.js" pi-home:/tmp/cart-patch-route-manifest.js
ssh pi-home "node /tmp/cart-patch-route-manifest.js /srv/pokoin/api/$release/server/api-route-manifest.js /tmp/cart-routes.json && rm -f /tmp/cart-patch-route-manifest.js /tmp/cart-routes.json"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health, cart auth guard, preflight, anonymous recommendations"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  noauth="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/marketplace-cart-sync" || true)"
  preflight="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -X OPTIONS http://127.0.0.1:18080/api/marketplace-cart-sync" || true)"
  recs="$(ssh pi-home "curl -s -o /tmp/cart-recs.json -w '%{http_code}' 'http://127.0.0.1:18080/api/marketplace-recommendations?limit=6'" || true)"
  rails="$(ssh pi-home "node -e 'const b=JSON.parse(require(\"fs\").readFileSync(\"/tmp/cart-recs.json\",\"utf8\"));console.log(Array.isArray(b.rails)?b.rails.length:-1)' 2>/dev/null" || echo -1)"
  if [[ "$health" == "200" && "$noauth" =~ ^(401|403)$ && "$preflight" == "204" && "$recs" == "200" && "$rails" -ge 1 ]]; then
    healthy=1
    break
  fi
  sleep 2
done
ssh pi-home "rm -f /tmp/cart-recs.json" || true

if [[ "$healthy" != "1" ]]; then
  echo "verification failed (health=$health cart-noauth=$noauth preflight=$preflight recs=$recs rails=$rails) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .cart-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "health=$health cart-sync noauth=$noauth preflight=$preflight recommendations=$recs rails=$rails"
