#!/usr/bin/env bash
# Deploy Pokoin-owned CardTrader domain API from an exact origin/main commit.
# Source of truth: server/pokoin-api/ (CardTrader + messages). Pi receives an
# atomic overlay release that replaces legacy CardVault CT handlers with the
# Pokoin copies and adds /api/cardtrader-sync.
#
# Runtime artifact = server/pokoin-api/ only. Repo scripts such as
# scripts/e2e-cardtrader-inventory-sync.sh are never staged into the release;
# a main tip that differs only in e2e/tooling does not require this deploy.
#
#   scripts/deploy-cardtrader-sync-api.sh [commit]
set -euo pipefail

die() { echo "deploy-cardtrader-sync-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-ct-sync-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

CT_FILES=(
  _cardtrader_crypto.js
  _cardtrader_client.js
  _cardtrader_integration.js
  _cardtrader_seller_listings.js
  _cardtrader_inventory_sync_core.js
  _cardtrader_inventory_sync.js
  _cardtrader_inventory_async.js
  _redis_cache.js
  _seller_profile_cache.js
  _cardtrader_webhook_core.js
  _cardtrader_webhook_registration.js
  cardtrader-connect.js
  cardtrader-disconnect.js
  cardtrader-status.js
  cardtrader-webhook.js
  cardtrader-import-dry-run.js
  cardtrader-clean-listings.js
  cardtrader-sync.js
  cardtrader-assets.js
  cardtrader-reconcile-all.js
  cardtrader-sales-backfill.js
  _cardtrader_zero.js
  cardtrader-zero.js
  _powertools_session.js
  powertools-connect.js
  _native_sales.js
  _stock_csv.js
  _powertools_ct_match.js
  marketplace-listings.js
  marketplace-portfolio-history.js
  _portfolio_history_core.js
  route-definitions.json
  patch-route-manifest.js
)

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in "${CT_FILES[@]}"; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "CardTrader sync unit tests"
node --test \
  "$SRC/_cardtrader_inventory_sync_core.test.js" \
  "$SRC/_cardtrader_webhook_core.test.js" \
  "$SRC/_cardtrader_webhook_registration.test.js" \
  "$SRC/cardtrader-reconcile-all.test.js" \
  "$SRC/cardtrader-sales-backfill.test.js" \
  "$SRC/cardtrader-delist-vs-sold.test.js" \
  "$SRC/cardtrader-one-day-ready.test.js" \
  "$SRC/_portfolio_history_core.test.js" \
  "$SRC/patch-route-manifest.test.js" \
  "$SRC/_powertools_ct_match.test.js" \
  "$SRC/_cardtrader_zero.test.js" \
  "$SRC/powertools-connect.test.js"
node --test "$SRC/marketplace-listings.test.js" "$SRC/_seller_profile_cache.test.js"
for file in "${CT_FILES[@]}"; do
  [[ "$file" == *.js ]] || continue
  [[ "$file" == *.test.js ]] && continue
  node --check "$SRC/$file"
done

release="releases/cardtrader-sync-$SHORT-$STAMP"
say "Pi release $release (overlay; preserves other handlers)"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .cardtrader-sync-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"

# Overlay Pokoin CT domain files onto api/ (replaces legacy CardVault copies).
# Use CT_FILES so new helpers (Power Tools match, stock CSV) cannot be forgotten.
overlay_js=()
for file in "${CT_FILES[@]}"; do
  [[ "$file" == *.js ]] || continue
  [[ "$file" == *.test.js ]] && continue
  [[ "$file" == patch-route-manifest.js ]] && continue
  overlay_js+=("$file")
done
tar -C "$SRC" -cf - \
  "${overlay_js[@]}" \
  route-definitions.json \
  patch-route-manifest.js \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"

ssh pi-home "node '/srv/pokoin/api/$release/api/patch-route-manifest.js' \
  '/srv/pokoin/api/$release/server/api-route-manifest.js' \
  '/srv/pokoin/api/$release/api/route-definitions.json' \
  '--api-dir=/srv/pokoin/api/$release/api' && \
  rm -f '/srv/pokoin/api/$release/api/patch-route-manifest.js' \
        '/srv/pokoin/api/$release/api/route-definitions.json' \
        '/srv/pokoin/api/$release/api/'*.test.js"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-cardtrader-sync-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + CardTrader routes + shared marketplace listings"
healthy=0
health=""; status=""; sync=""; assets=""; history=""; webhook=""; zero=""; ptconnect=""; unknown=""
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  listings="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18080/api/marketplace-listings?cardId=633380&limit=5'" || true)"
  status="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/cardtrader-status" || true)"
  sync="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/cardtrader-sync" || true)"
  assets="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/cardtrader-assets" || true)"
  history="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/marketplace-portfolio-history" || true)"
  webhook="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18080/api/cardtrader-webhook/test-uid" || true)"
  zero="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/cardtrader-zero" || true)"
  ptconnect="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/powertools-connect" || true)"
  # A broken route manifest 500s on unknown paths instead of 404.
  unknown="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/route-manifest-healthcheck" || true)"
  # status/sync/assets/history/zero/powertools-connect require auth → 401/403; webhook missing secret → 401/404/400; health 200
  if [[ "$health" == "200" && "$listings" == "200" && "$status" =~ ^(401|403)$ && "$sync" =~ ^(401|403)$ && "$assets" =~ ^(401|403)$ && "$history" =~ ^(401|403)$ && "$webhook" =~ ^(400|401|404)$ && "$zero" =~ ^(401|403)$ && "$ptconnect" =~ ^(401|403)$ && "$unknown" == "404" ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health status=$status sync=$sync assets=$assets history=$history webhook=$webhook zero=$zero powertools-connect=$ptconnect unknown=${unknown:-}) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .cardtrader-sync-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "commit=$COMMIT health=$health cardtrader-status=$status cardtrader-sync=$sync cardtrader-assets=$assets portfolio-history=$history webhook=$webhook cardtrader-zero=$zero powertools-connect=$ptconnect"
