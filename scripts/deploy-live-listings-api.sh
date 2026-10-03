#!/usr/bin/env bash
# Deploy the CardTrader live-offers handler (server/pokoin-api/cardtrader-live-listings.js +
# marketplace-listings.js)
# from an exact origin/main commit. It replaces the legacy CardVault copy on the Pi so
# every game resolves its CardTrader blueprint (One Piece etc. read the catalog ct_id).
set -euo pipefail

die() { echo "deploy-live-listings-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-live-listings-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in cardtrader-live-listings.js marketplace-listings.js _redis_cache.js _redis_ns.js _read_model_cache.js _seller_shop_cache.js _marketplace_cache_invalidate.js _valkey.js _seller_profile_cache.js; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "live listings unit tests"
node --test "$SRC/cardtrader-live-listings.test.js"
node --check "$SRC/cardtrader-live-listings.js"
node --check "$SRC/marketplace-listings.js"
node --check "$SRC/_redis_cache.js"
node --check "$SRC/_redis_ns.js"
node --check "$SRC/_marketplace_cache_invalidate.js"
node --check "$SRC/_valkey.js"
node --check "$SRC/_seller_profile_cache.js"

release="releases/live-listings-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .live-listings-previous; cp -a \$prev '$release'"
tar -C "$SRC" -cf - cardtrader-live-listings.js marketplace-listings.js _redis_cache.js _redis_ns.js _read_model_cache.js _seller_shop_cache.js _marketplace_cache_invalidate.js _valkey.js _seller_profile_cache.js \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-live-listings-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

# One Piece Luffy OP11-058 (card 710802 = CardTrader blueprint 355401) and a Pokemon card.
say "verify health + One Piece and Pokemon CardTrader offers"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  op="$(ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/marketplace-listings?cardId=710802&limit=40&game=one_piece'" 2>/dev/null || true)"
  pk="$(ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/marketplace-listings?cardId=633380&limit=40'" 2>/dev/null || true)"
  if [[ "$health" == "200" ]] && printf '%s\n%s\n' "$op" "$pk" | python3 -c '
import json, sys
op, pk = [json.loads(line) for line in sys.stdin if line.strip()]
assert len(op.get("listings") or []) > 0, "one piece has no offers"
assert len(pk.get("listings") or []) > 1, "pokemon has no CardTrader offers"
'; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "verification failed (health=$health) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .live-listings-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

count() { python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("listings") or []))'; }
say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "health=$health one_piece offers=$(printf '%s' "$op" | count) pokemon offers=$(printf '%s' "$pk" | count)"
