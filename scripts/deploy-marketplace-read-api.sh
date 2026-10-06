#!/usr/bin/env bash
# Deploy the marketplace read-side Redis overlay from an exact origin/main commit:
# marketplace-home-page.js (TTL-unified, empty-snapshot-cacheable home snapshot),
# the shared best-effort limiter versions of marketplace-image-log.js and
# trainingai-card-classify.js, and the helpers they require (_redis_cache.js,
# _rate_limit.js). These files were CardVault api/ legacy
# copies; the Pokoin overlay replaces them on the Pi release.
set -euo pipefail

die() { echo "deploy-marketplace-read-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-marketplace-read-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

READ_FILES=(
  marketplace-home-page.js
  marketplace-home-page.test.js
  marketplace-image-log.js
  trainingai-card-classify.js
  _redis_cache.js
  _redis_ns.js
  _redis_ns.test.js
  _read_model_cache.js
  _seller_shop_cache.js
  _seller_shop_cache.test.js
  _marketplace_cache_invalidate.js
  _pipeline_health.js
  _redis_cache.test.js
  _rate_limit.js
  _rate_limit.test.js
)

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in "${READ_FILES[@]}"; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "marketplace read unit tests"
REDIS_CACHE_TEST_PORT="${REDIS_CACHE_TEST_PORT:-6390}" \
  node --test --test-force-exit \
  "$SRC/marketplace-home-page.test.js" \
  "$SRC/_redis_cache.test.js" \
  "$SRC/_redis_ns.test.js" \
  "$SRC/_rate_limit.test.js"
for file in "${READ_FILES[@]}"; do
  [[ "$file" == *.js ]] || continue
  [[ "$file" == *.test.js ]] && continue
  node --check "$SRC/$file"
done

release="releases/marketplace-read-$SHORT-$STAMP"
say "Pi release $release (overlay; preserves other handlers)"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .marketplace-read-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - "${READ_FILES[@]}" | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "printf '%s\\n' '$COMMIT' > '/srv/pokoin/api/$release/.marketplace-read-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

# Health plus the two behaviors this overlay changes: the home snapshot must
# answer with a cards array (Redis-backed, 20s TTL), and the redis client
# must PING (healthz covers postgres/redis/cdn).
say "verify health and home snapshot"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  home="$(ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/marketplace-home-page?limit=12'" 2>/dev/null || true)"
  if [[ "$health" == "200" ]] && printf '%s' "$home" | python3 -c '
import json, sys
body = json.loads(sys.stdin.read())
assert isinstance(body.get("cards"), list), "home snapshot has no cards array"
'; then
    healthy=1
    break
  fi
  sleep 2
done
[[ "$healthy" == 1 ]] || { say "rollback: health or home snapshot did not recover"; ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .marketplace-read-previous); ln -sfn \"\$prev\" current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"; die "post-deploy verification failed"; }

say "deployed marketplace-read overlay $SHORT to the Pi"
