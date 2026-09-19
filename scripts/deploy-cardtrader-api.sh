#!/usr/bin/env bash
# Deploy CardTrader linked-inventory API handlers to the Pi oracle API.
# Copies only the allowlisted files from the local CardVault tree into a new
# /srv/pokoin/api release and restarts pokoin-oracle-api.
#
#   scripts/deploy-cardtrader-api.sh
set -euo pipefail

die() { echo "deploy-cardtrader-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

PROJECTS="${PROJECTS:-/home/nez/Projects}"
CARDVAULT="$PROJECTS/cardvault/pokemon_card_vault"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"

API_FILES=(
  api/_cardtrader_client.js
  api/_cardtrader_integration.js
  api/_cardtrader_seller_listings.js
  api/cardtrader-connect.js
  api/cardtrader-disconnect.js
  api/cardtrader-webhook.js
  api/cardtrader-clean-listings.js
  api/marketplace-listings.js
  api/marketplace-orders.js
  api/scan-batch.js
  api/_scan_store.js
  server/api-route-manifest.js
  vercel.json
)

for f in "${API_FILES[@]}"; do
  [[ -f "$CARDVAULT/$f" ]] || die "missing $CARDVAULT/$f"
done

say "CardTrader unit tests"
(cd "$CARDVAULT" && node --test \
    api/cardtrader-seller-listings.test.js \
    api/cardtrader-connect.test.js \
    >/tmp/ct-api-tests.log 2>&1) \
  || { tail -30 /tmp/ct-api-tests.log; die "CardTrader tests failed"; }

release="releases/cardtrader-link-$STAMP"
say "Pi release $release = live release + ${#API_FILES[@]} files"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .cardtrader-link-previous; cp -a \$prev $release"
tar -C "$CARDVAULT" -cf - "${API_FILES[@]}" | ssh pi-home "tar -C /srv/pokoin/api/$release -xf -"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn $release current.new && mv -Tf current.new current; docker restart $API_CONTAINER >/dev/null"

say "verify health + CardTrader routes"
healthy=0
health=""; status=""; webhook=""
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  status="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/cardtrader-status" || true)"
  webhook="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18080/api/cardtrader-webhook/test-uid" || true)"
  # status requires auth → 401/403; webhook missing secret/signature → 401/404/400; health 200
  if [[ "$health" == "200" && "$status" =~ ^(401|403)$ && "$webhook" =~ ^(400|401|404)$ ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health status=$status webhook=$webhook) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .cardtrader-link-previous); ln -sfn \$prev current.new && mv -Tf current.new current; docker restart $API_CONTAINER >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "health=$health cardtrader-status=$status webhook=$webhook"
