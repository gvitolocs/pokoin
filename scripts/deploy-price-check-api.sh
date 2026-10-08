#!/usr/bin/env bash
# Deploy MyPokoin PowerTools-style price check from an exact pokoin-web commit.
# Source of truth: server/pokoin-api/marketplace-price-check.js
# Pi runtime receives an overlay on /srv/pokoin/api/current — shared by Web and
# CardVault app clients. This is not a CardVault-app deploy.
set -euo pipefail

die() { echo "deploy-price-check-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-price-check-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in marketplace-price-check.js _tcgcsv_prices.js marketplace-tcgplayer-history.js _card_price_history.js marketplace-card-price-history.js; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "price check unit tests"
node --test "$SRC/marketplace-price-check.test.js"
node --test "$SRC/_tcgcsv_prices.test.js"
node --test "$SRC/marketplace-tcgplayer-history.test.js"
node --test "$SRC/marketplace-card-price-history.test.js"
node --check "$SRC/marketplace-price-check.js"
node --check "$SRC/marketplace-card-price-history.js"

release="releases/price-check-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .price-check-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - marketplace-price-check.js _tcgcsv_prices.js marketplace-tcgplayer-history.js _card_price_history.js marketplace-card-price-history.js \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-price-check-commit'"
# The Pi API mounts routes from server/api-route-manifest.js — keep the entry
# in the NEW release (copy of the previous current) in sync with this repo's
# route-definitions.json.
scp -q "$SRC/route-definitions.json" pi-home:/tmp/price-check-routes.json
scp -q "$SRC/../../server/pokoin-api/patch-route-manifest.js" pi-home:/tmp/patch-route-manifest.js 2>/dev/null \
  || git -C "$REPO" show "$COMMIT":server/pokoin-api/patch-route-manifest.js | ssh pi-home 'cat > /tmp/patch-route-manifest.js'
ssh pi-home "node /tmp/patch-route-manifest.js /srv/pokoin/api/$release/server/api-route-manifest.js /tmp/price-check-routes.json --api-dir=/srv/pokoin/api/$release/api && rm -f /tmp/patch-route-manifest.js /tmp/price-check-routes.json"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + price-check and recents auth guards (missing game → 400, missing auth → 401)"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  noauth="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18080/api/marketplace-recents?game=pokemon'" || true)"
  # No Authorization header → auth fails before game check (401). Explicit invalid game with no auth also 401.
  nogame="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18080/api/marketplace-recents'" || true)"
  pricecheck="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18080/api/marketplace-price-check?items=1'" || true)"
  # A broken route manifest 500s on unknown paths instead of 404.
  unknown="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/route-manifest-healthcheck" || true)"
  if [[ "$health" == "200" && "$noauth" =~ ^(401|403)$ && "$nogame" =~ ^(400|401|403)$ && "$pricecheck" =~ ^(401|403)$ && "$unknown" == "404" ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health noauth=$noauth nogame=$nogame price-check=${pricecheck:-} unknown=${unknown:-}) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .price-check-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "health=$health marketplace-recents noauth=$noauth nogame=$nogame price-check=$pricecheck"
say "Apply scripts/sql/090_marketplace_user_recents_game.sql on the nezopt writer before relying on game-scoped writes:"
say "  docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/090_marketplace_user_recents_game.sql"
