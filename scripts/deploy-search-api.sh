#!/usr/bin/env bash
# Pokoin-web-owned marketplace search-page API rollout (Pi release overlay).
# Run on nezopt:
#
#   scripts/deploy-search-api.sh
#
# Ships ONLY the files this repository owns into a copy of the
# live Pi release, restarts pokoin-oracle-api, verifies health, and rolls
# back automatically. Nothing is read from any other checkout, so unrelated
# work in other trees can never ship. See scripts/deploy-web.sh for the web
# side and docs/DEPLOY.md for why this is gated.
set -euo pipefail

API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
REPO="$(git rev-parse --show-toplevel)"
git -C "$REPO" fetch -q origin
COMMIT="$(git -C "$REPO" rev-parse "${1:-origin/main}^{commit}")"
[[ "$COMMIT" == "$(git -C "$REPO" rev-parse origin/main)" ]] \
  || { echo 'deploy-search-api: use the exact pushed origin/main commit' >&2; exit 1; }
HERE="$(mktemp -d /tmp/pokoin-search-api-source-XXXXXX)"
trap 'rm -rf "$HERE"' EXIT
# Contract/parity tests read tracked web and maintained API sources too.
# Archive the whole commit for tests; only API_FILES below enter the release.
git -C "$REPO" archive "$COMMIT" | tar -C "$HERE" -xf -
export NODE_PATH="${REPO}/server/node_modules${NODE_PATH:+:$NODE_PATH}"
# The shared pipeline helper is maintained under server/pokoin-api; the live
# release loads it from api/. Keep the legacy Pi HTTP probe and support the
# overflow pod's real HTTPS CDN probe.
cp "$HERE/server/pokoin-api/_pipeline_health.js" "$HERE/server/api/_pipeline_health.js"

# Files this repository owns, at their release-relative paths.
# Multigame SQL is the satellite TCG search/suggest engine (Magic, OP, …) —
# previously only on the Pi via CardVault copies; source of truth is here.
# The candidate/autocomplete helper layer (marketplace-search-candidates,
# marketplace-autocomplete and their ./ deps) is vendored from CardVault's
# api/ and is pokoin-web-owned from now on; CardVault's api/ copies are
# deprecated for the webpage. Overlay order still wins: these files replace
# the CardVault release copies byte-for-byte except where fixed here.
API_FILES=(
  api/marketplace-search-page.js
  api/marketplace-cards.js
  api/marketplace-search-candidates.js
  api/marketplace-autocomplete.js
  api/_print_bucket.js
  api/_marketplace_multigame_sql.js
  api/marketplace-suggest.js
  api/_meili_suggest.js
  api/_meili_document.js
  api/_expansion_nationality.js
  api/_suggest_western_priority.js
  api/_suggest_hot_query.js
  api/_card_visual_theme.js
  api/_cardtrader_game_ingest.js
  api/_catalog_title_language.js
  api/_firebase.js
  api/_marketplace_canonical_path.js
  api/_marketplace_card_emoji.js
  api/_marketplace_card_rarity.js
  api/_marketplace_cart_analytics.js
  api/_marketplace_db.js
  api/_marketplace_game.js
  api/_marketplace_image_log.js
  api/_marketplace_react_sql.js
  api/_marketplace_row.js
  api/_marketplace_search_engine.js
  api/_marketplace_watchlist_analytics.js
  api/_meili_client.js
  api/_meili_marketplace.js
  api/_redis_search.js
  api/_search_debug_auth.js
  api/_searchbar_session.js
  api/_slug.js
  api/_supabase.js
  api/_pipeline_health.js
)

die() { echo "deploy-search-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

for f in "${API_FILES[@]}"; do [[ -f "$HERE/server/$f" ]] || die "missing $HERE/server/$f"; done

say "pokoin-web unit tests"
(cd "$HERE" && node --test server/api/*.test.js server/pokoin-api/_pipeline_health.test.js >"/tmp/search-api-tests-$STAMP.log" 2>&1) \
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
  if universe_json="$(ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/marketplace-search-page?query=blastoise&productSearchOnly=1&limit=6&offset=0&includeFacets=0&lang=en'" 2>/dev/null)" \
    && aisle_json="$(ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/marketplace-search-page?query=blastoise&productType=jumbo&limit=3&offset=0&includeFacets=0&lang=en'" 2>/dev/null)" \
    && magic_json="$(ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/marketplace-search-page?query=reality%20fracture&game=magic&productType=card&limit=6&offset=0&includeFacets=0&lang=en'" 2>/dev/null)" \
    && magic_typo_json="$(ssh pi-home "curl -fsS 'http://127.0.0.1:18080/api/marketplace-suggest?q=relity%20fracture&game=magic&limit=8'" 2>/dev/null)"; then
    if printf '%s\n%s\n%s\n%s\n' "$universe_json" "$aisle_json" "$magic_json" "$magic_typo_json" | python3 -c '
import json, sys
universe, aisle, magic, typo = [json.loads(line) for line in sys.stdin if line.strip()]
total = universe.get("total")
assert total is not None and total > 0, f"product universe total missing: {total!r}"
assert universe.get("cards"), "product universe returned no rows"
jumbo = (aisle.get("cards") or [])
assert jumbo, "productType=jumbo probe returned no rows"
assert all("Jumbo Oversized" in str(c.get("number") or "") for c in jumbo), "narrow jumbo filter leaked non-jumbo rows"
magic_cards = magic.get("cards") or []
assert magic_cards, "Magic Singles reality fracture returned no rows"
assert all(str(c.get("productType") or "") == "card" for c in magic_cards), "Magic Singles leaked non-card rows"
assert any("reality fracture" in str(c.get("set") or c.get("set_name") or "").lower() for c in magic_cards), "Magic Singles missed Reality Fracture set"
typo_groups = typo.get("groups") or []
assert typo_groups, "Magic suggest typo relity fracture returned no groups"
' ; then
      listings="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18080/api/marketplace-listings?cardId=220962&nativeOnly=1&limit=1'")"
      pair="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{\"pin\":\"0000\"}' http://127.0.0.1:18080/api/scan-pair")"
      say "search-page universe total OK · jumbo OK · magic Singles OK · magic typo suggest OK · listings → $listings (expect 200) · scan-pair wrong code → $pair (expect 400)"
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
