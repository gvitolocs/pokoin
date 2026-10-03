#!/usr/bin/env bash
# Deploy the game-scoped public seller shop API from an exact pokoin-web commit.
set -euo pipefail

die() { echo "deploy-seller-shop-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-seller-shop-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
SHOP_FILES=(
  marketplace-seller-shop.js
  marketplace-seller-shop.test.js
  _seller_shop_cache.js
  _seller_shop_cache.test.js
  _redis_cache.js
  _redis_ns.js
  _read_model_cache.js
  _marketplace_cache_invalidate.js
  _valkey.js
)
for file in "${SHOP_FILES[@]}"; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "seller shop unit tests"
REDIS_CACHE_TEST_PORT="${REDIS_CACHE_TEST_PORT:-6390}" \
  node --test --test-force-exit \
  "$SRC/marketplace-seller-shop.test.js" \
  "$SRC/_seller_shop_cache.test.js"
for file in "${SHOP_FILES[@]}"; do
  [[ "$file" == *.test.js ]] && continue
  node --check "$SRC/$file"
done

release="releases/seller-shop-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .seller-shop-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - "${SHOP_FILES[@]}" \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-seller-shop-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + selected-game seller isolation"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  pokemon_json="$(ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/marketplace-seller-shop?sellerUsername=redshakkio&game=pokemon&limit=1'" 2>/dev/null || true)"
  sorcery_json="$(ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/marketplace-seller-shop?sellerUsername=redshakkio&game=sorcery&limit=1'" 2>/dev/null || true)"
  riftbound_json="$(ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/marketplace-seller-shop?sellerUsername=redshakkio&game=riftbound&limit=1'" 2>/dev/null || true)"
  if [[ "$health" == "200" ]] && printf '%s\n%s\n%s\n' "$pokemon_json" "$sorcery_json" "$riftbound_json" | python3 -c '
import json, sys
pokemon, sorcery, riftbound = [json.loads(line) for line in sys.stdin if line.strip()]
assert pokemon.get("game") == "pokemon", pokemon
assert sorcery.get("game") == "sorcery", sorcery
assert riftbound.get("game") == "riftbound", riftbound
assert isinstance(pokemon.get("listings"), list), pokemon
assert isinstance(sorcery.get("listings"), list), sorcery
assert int(riftbound.get("total") or 0) > 0, riftbound
'; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .seller-shop-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "health=$health pokemon total=$(printf '%s' "$pokemon_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("total"))') sorcery total=$(printf '%s' "$sorcery_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("total"))') riftbound total=$(printf '%s' "$riftbound_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("total"))')"
