#!/usr/bin/env bash
# Deploy the Instant Architecture API overlay from an origin/main commit.
#
#   scripts/deploy-instant-api.sh [commit]
#
# The artifact is the require() closure of scripts/instant-api-manifest.json,
# not a hand-copied file list. Refuses to switch if a module, route handler,
# or required migration is missing. Rolls the Pi release back if health fails.
set -euo pipefail

die() { echo "deploy-instant-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
PI="${PI_HOST:-pi-home}"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
WRITER="${POKOIN_WRITER_CONTAINER:-pokoin-marketplace-postgres-15t}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; merge it first"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git -C "$REPO" archive "$COMMIT" | tar -C "$STAGE" -xf -
node "$STAGE/scripts/collect-instant-api.js" --json >"$STAGE/artifact.json" \
  || die "artifact validation failed"
node --test \
  "$STAGE/scripts/collect-instant-api.test.js" \
  "$STAGE/server/pokoin-api/_listing_inventory.test.js" \
  "$STAGE/server/pokoin-api/_redis_cache.test.js" \
  "$STAGE/server/pokoin-api/_read_model_cache.test.js" \
  "$STAGE/server/pokoin-api/_instant_architecture.test.js" \
  "$STAGE/server/api/_suggest_catalog.test.js" \
  "$STAGE/server/api/marketplace-search-page.test.js" \
  "$STAGE/scripts/pokoin-api-edge.test.js" \
  || die "tests failed"

python3 - "$STAGE/artifact.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
if not doc["ok"]:
    raise SystemExit("\n".join(doc["errors"]))
open("/tmp/pokoin-instant-files.txt", "w").write("\n".join(doc["files"]) + "\n")
open("/tmp/pokoin-instant-external.txt", "w").write("\n".join(doc["external"]) + "\n")
PY

say "writer tables"
for table in marketplace_outbox marketplace_artist_summary; do
  found="$(docker exec "$WRITER" psql -U pokoin_marketplace -d pokoin_marketplace -Atc "select to_regclass('public.$table')")" \
    || die "cannot read writer"
  [[ "$found" == "$table" || "$found" == "public.$table" ]] || die "writer is missing public.$table — apply scripts/sql/096 then 097 first"
done

say "live release has external modules"
ssh "$PI" "set -e; root=\$(readlink -f /srv/pokoin/api/current); test -f \"\$root/server/api-route-manifest.js\""
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  if grep -qx "server/pokoin-api/$name" /tmp/pokoin-instant-files.txt \
    || grep -qx "server/api/$name" /tmp/pokoin-instant-files.txt; then
    continue
  fi
  ssh "$PI" "root=\$(readlink -f /srv/pokoin/api/current); test -f \"\$root/api/$name\"" \
    || die "live release is missing api/$name"
done </tmp/pokoin-instant-external.txt

release="releases/instant-api-$SHORT-$STAMP"
say "Pi release $release"
ssh "$PI" "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .instant-api-previous; cp -a \$prev '$release'"
tar -C "$STAGE" -T /tmp/pokoin-instant-files.txt -cf - \
  | ssh "$PI" "tar -C /srv/pokoin/api/$release/api --transform='s|.*/||' -xf -"
scp -q "$STAGE/server/pokoin-api/instant-routes.json" "$STAGE/server/pokoin-api/patch-route-manifest.js" \
  "$PI:/srv/pokoin/api/$release/api/"
ssh "$PI" "set -e
  node /srv/pokoin/api/$release/api/patch-route-manifest.js \
    /srv/pokoin/api/$release/server/api-route-manifest.js \
    /srv/pokoin/api/$release/api/instant-routes.json
  rm -f /srv/pokoin/api/$release/api/patch-route-manifest.js \
    /srv/pokoin/api/$release/api/instant-routes.json \
    /srv/pokoin/api/$release/api/*.test.js
  printf '%s\n' '$COMMIT' > /srv/pokoin/api/$release/.pokoin-instant-commit
  cd /srv/pokoin/api
  ln -sfn '$release' current.new
  mv -Tf current.new current
  docker restart '$API_CONTAINER' >/dev/null"

say "health"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh "$PI" "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18080/api/healthz" || true)"
  listings="$(ssh "$PI" "curl -s -o /dev/null -w '%{http_code}' --max-time 8 'http://127.0.0.1:18080/api/marketplace-listings?cardId=693360&nativeOnly=1&limit=1'" || true)"
  decrement="$(ssh "$PI" "curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST -H 'content-type: application/json' -d '{\"quantity\":1}' 'http://127.0.0.1:18080/api/marketplace-listings?action=decrement&id=1'" || true)"
  card="$(ssh "$PI" "curl -s -o /dev/null -w '%{http_code}' --max-time 15 'http://127.0.0.1:18080/api/marketplace-card-page?cardId=693360&lang=en'" || true)"
  suggest="$(ssh "$PI" "curl -s -o /dev/null -w '%{http_code}' --max-time 8 'http://127.0.0.1:18080/api/marketplace-suggest?q=pikachu&limit=3'" || true)"
  live_headers="$(ssh "$PI" "curl -s -D - -o /dev/null --max-time 2 -H 'accept: text/event-stream' 'http://127.0.0.1:18080/api/marketplace-live?cardId=693360'" || true)"
  live=000
  printf '%s' "$live_headers" | grep -q '200' && printf '%s' "$live_headers" | grep -qi 'text/event-stream' && live=200
  if [[ "$health" == "200" && "$listings" == "200" && "$decrement" == "401" && "$card" == "200" && "$suggest" == "200" && "$live" == "200" ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed health=$health listings=$listings decrement=$decrement card=$card suggest=$suggest live=$live — rolling back" >&2
  ssh "$PI" "set -e; cd /srv/pokoin/api; prev=\$(cat .instant-api-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "previous release restored"
fi

say "API live: $(ssh "$PI" 'readlink /srv/pokoin/api/current') @ $SHORT"
say "health=$health listings=$listings decrement=$decrement card=$card suggest=$suggest live=$live"
