#!/usr/bin/env bash
# Pokoin-web-owned marketplace search-page API rollout (Pi release overlay).
# Run on nezopt:
#
#   scripts/deploy-search-api.sh
#
# Ships ONLY the files this repository owns (server/api/*) into a copy of the
# live Pi release, restarts pokoin-oracle-api, verifies health, and rolls
# back automatically. Nothing is read from any other checkout, so unrelated
# work in other trees can never ship. See scripts/deploy-web.sh for the web
# side and docs/DEPLOY.md for why this is gated.
set -euo pipefail

API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

# Files this repository owns, at their release-relative paths.
API_FILES=(
  api/marketplace-search-page.js
  api/marketplace-cards.js
  api/_print_bucket.js
)

die() { echo "deploy-search-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

for f in "${API_FILES[@]}"; do [[ -f "$HERE/server/$f" ]] || die "missing $HERE/server/$f"; done

say "pokoin-web unit tests"
(cd "$HERE" && node --test server/api/*.test.js >"/tmp/search-api-tests-$STAMP.log" 2>&1) \
  || { tail -30 "/tmp/search-api-tests-$STAMP.log" >&2; die "server tests failed"; }
grep -E "^# (tests|pass|fail)" "/tmp/search-api-tests-$STAMP.log"

release="releases/search-api-$STAMP"
say "Pi release $release = live release + ${#API_FILES[@]} pokoin-web files"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .search-api-previous; cp -a \$prev $release"
tar -C "$HERE/server" -cf - "${API_FILES[@]}" | ssh pi-home "tar -C /srv/pokoin/api/$release -xf -"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn $release current.new && mv -Tf current.new current; docker restart $API_CONTAINER >/dev/null"

say "health"
health_ok=0
for i in $(seq 1 45); do
  if search_json="$(ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/marketplace-search-page?query=blastoise&productSearchOnly=1&limit=6&offset=0&includeFacets=0&lang=en'" 2>/dev/null)"; then
    if echo "$search_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
rows = d.get("cards") or []
jumbo = any("Jumbo Oversized" in str(c.get("number") or "") for c in rows)
total = d.get("total")
assert total is not None and total > 0, f"total missing: {total!r}"
assert jumbo, "no jumbo rows in the Product (productSearchOnly) universe"
' ; then
      listings="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18080/api/marketplace-listings?cardId=220962&nativeOnly=1&limit=1'")"
      pair="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{\"pin\":\"0000\"}' http://127.0.0.1:18080/api/scan-pair")"
      say "search-page total+jumbo OK · listings → $listings (expect 200) · scan-pair wrong code → $pair (expect 400)"
      if [[ "$listings" == "200" && "$pair" == "400" ]]; then
        health_ok=1
        break
      fi
    fi
  fi
  sleep 2
done

if [[ "$health_ok" == "1" ]]; then
  say "api live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
  exit 0
fi
echo "health failed — rolling back" >&2
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .search-api-previous); ln -sfn \$prev current.new && mv -Tf current.new current; docker restart $API_CONTAINER >/dev/null; echo restored \$prev"
exit 1
