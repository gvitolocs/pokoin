#!/usr/bin/env bash
# Deploy "Sync with other platforms" (docs/PLATFORM_SYNC.md) to the Pi API
# from an exact origin/main commit. Same overlay-release pattern as
# scripts/deploy-cardtrader-sync-api.sh: copy the live release, overlay the
# platform-sync files (plus the sale hooks in checkout / CardTrader webhook /
# reconcile), patch the route manifest, restart, verify, roll back on failure.
#
# Prerequisites (once): migration scripts/sql/111_marketplace_platform_sync.sql
# applied on the nezopt writer; provider env (CARDMARKET_APP_*, TCGPLAYER_*)
# in the pokoin-oracle-api env for the providers that should be available.
#
#   scripts/deploy-platform-sync-api.sh [commit]
set -euo pipefail

die() { echo "deploy-platform-sync-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-platform-sync-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

PLATFORM_FILES=(
  _platform_providers.js
  _platform_integration.js
  _platform_links.js
  _platform_fanout.js
  _platform_import.js
  _stock_listing_import.js
  _platform_adapters/index.js
  _platform_adapters/shopify.js
  _platform_adapters/cardmarket.js
  _platform_adapters/tcgplayer.js
  _platform_adapters/partner.js
  platform-integrations.js
  platform-oauth-callback.js
  platform-webhook.js
  platform-links.js
  platform-sync-poll-all.js
  # Sale hooks and their direct helpers (exact-commit copies).
  marketplace-listings-csv.js
  marketplace-orders.js
  _eur_order_inventory.js
  cardtrader-webhook.js
  _cardtrader_inventory_sync.js
  _cardtrader_webhook_core.js
  _cardtrader_crypto.js
  _stock_csv.js
  _outbox.js
  _marketplace_cache_invalidate.js
)

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in "${PLATFORM_FILES[@]}" route-definitions.json patch-route-manifest.js; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "platform sync unit tests"
# Targeted list on purpose: the full server/pokoin-api/*.test.js glob needs
# Pi-only modules and hangs outside the API image.
node --test \
  "$SRC"/_platform_*.test.js \
  "$SRC"/_platform_adapters/*.test.js \
  "$SRC"/platform-*.test.js \
  "$SRC/cardtrader-webhook.test.js" \
  "$SRC/_eur_order_inventory.test.js" \
  "$SRC/cardtrader-delist-vs-sold.test.js" \
  "$SRC/cardtrader-reconcile-all.test.js" \
  "$SRC/patch-route-manifest.test.js"
for file in "${PLATFORM_FILES[@]}"; do
  node --check "$SRC/$file"
done

release="releases/platform-sync-$SHORT-$STAMP"
say "Pi release $release (overlay; preserves other handlers)"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .platform-sync-previous; cp -a \$prev '$release'; mkdir -p '$release/api/_platform_adapters'"

tar -C "$SRC" -cf - \
  "${PLATFORM_FILES[@]}" \
  route-definitions.json \
  patch-route-manifest.js \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"

ssh pi-home "node '/srv/pokoin/api/$release/api/patch-route-manifest.js' \
  '/srv/pokoin/api/$release/server/api-route-manifest.js' \
  '/srv/pokoin/api/$release/api/route-definitions.json'; \
  rm -f '/srv/pokoin/api/$release/api/patch-route-manifest.js' \
        '/srv/pokoin/api/$release/api/route-definitions.json' \
        '/srv/pokoin/api/$release/api/'*.test.js \
        '/srv/pokoin/api/$release/api/_platform_adapters/'*.test.js"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-platform-sync-commit'"
ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + platform routes"
base=http://127.0.0.1:18080
healthy=0
health=""; list=""; links=""; webhook=""; oauth=""; ctstatus=""
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' $base/api/healthz" || true)"
  list="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' $base/api/platform-integrations" || true)"
  links="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' $base/api/platform-links" || true)"
  # Our handler answers a not-connected seller with this exact text; a
  # missing route would be a generic 404 instead.
  webhook="$(ssh pi-home "curl -s -X POST $base/api/platform-webhook/shopify/test-uid" || true)"
  oauth="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' '$base/api/platform-oauth/cardmarket/start?state=bad'" || true)"
  ctstatus="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' $base/api/cardtrader-status" || true)"
  if [[ "$health" == "200" && "$list" =~ ^(401|403)$ && "$links" =~ ^(401|403)$ \
     && "$webhook" == *"Platform is not connected."* && "$oauth" == "302" && "$ctstatus" =~ ^(401|403)$ ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health list=$list links=$links webhook=${webhook:0:80} oauth=$oauth cardtrader-status=$ctstatus) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .platform-sync-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "commit=$COMMIT health=$health platform-integrations=$list platform-links=$links oauth-start=$oauth"
