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
  cardtrader-connect.js
  cardtrader-disconnect.js
  cardtrader-status.js
  cardtrader-webhook.js
  cardtrader-import-dry-run.js
  cardtrader-clean-listings.js
  cardtrader-sync.js
  cardtrader-assets.js
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
  "$SRC/patch-route-manifest.test.js"
for file in "${CT_FILES[@]}"; do
  [[ "$file" == *.js ]] || continue
  [[ "$file" == *.test.js ]] && continue
  node --check "$SRC/$file"
done

release="releases/cardtrader-sync-$SHORT-$STAMP"
say "Pi release $release (overlay; preserves other handlers)"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .cardtrader-sync-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"

# Overlay Pokoin CT domain files onto api/ (replaces legacy CardVault copies).
tar -C "$SRC" -cf - \
  _cardtrader_crypto.js \
  _cardtrader_client.js \
  _cardtrader_integration.js \
  _cardtrader_seller_listings.js \
  _cardtrader_inventory_sync_core.js \
  _cardtrader_inventory_sync.js \
  _cardtrader_inventory_async.js \
  cardtrader-connect.js \
  cardtrader-disconnect.js \
  cardtrader-status.js \
  cardtrader-webhook.js \
  cardtrader-import-dry-run.js \
  cardtrader-clean-listings.js \
  cardtrader-sync.js \
  cardtrader-assets.js \
  route-definitions.json \
  patch-route-manifest.js \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"

ssh pi-home "node '/srv/pokoin/api/$release/api/patch-route-manifest.js' \
  '/srv/pokoin/api/$release/server/api-route-manifest.js' \
  '/srv/pokoin/api/$release/api/route-definitions.json'; \
  rm -f '/srv/pokoin/api/$release/api/patch-route-manifest.js' \
        '/srv/pokoin/api/$release/api/route-definitions.json' \
        '/srv/pokoin/api/$release/api/'*.test.js"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-cardtrader-sync-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + CardTrader routes"
healthy=0
health=""; status=""; sync=""; assets=""; webhook=""
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  status="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/cardtrader-status" || true)"
  sync="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/cardtrader-sync" || true)"
  assets="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/cardtrader-assets" || true)"
  webhook="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18080/api/cardtrader-webhook/test-uid" || true)"
  # status/sync/assets require auth → 401/403; webhook missing secret → 401/404/400; health 200
  if [[ "$health" == "200" && "$status" =~ ^(401|403)$ && "$sync" =~ ^(401|403)$ && "$assets" =~ ^(401|403)$ && "$webhook" =~ ^(400|401|404)$ ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health status=$status sync=$sync assets=$assets webhook=$webhook) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .cardtrader-sync-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "commit=$COMMIT health=$health cardtrader-status=$status cardtrader-sync=$sync cardtrader-assets=$assets webhook=$webhook"
