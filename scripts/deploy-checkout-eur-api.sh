#!/usr/bin/env bash
# Deploy EUR checkout (addresses, quote, Connect, Stripe order session) + order/webhook overlays.
# Source of truth: server/pokoin-api/ in pokoin-web. Requires origin/main ancestry.
set -euo pipefail

die() { echo "deploy-checkout-eur-api: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$COMMIT")"
STAMP="$(date -u +%Y%m%d%H%M%S)"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-checkout-eur-api-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

FILES=(
  _checkout_core.js
  _checkout_core.test.js
  _address_crypto.js
  _client_country.js
  _client_country.test.js
  _packlink.js
  _packlink.test.js
  shipping-rates.json
  account-addresses.js
  marketplace-checkout-quote.js
  marketplace-shipping-options.js
  marketplace-seller-settings.js
  marketplace-seller-settings.test.js
  _seller_profile_cache.js
  _redis_cache.js
  _valkey.js
  _seller_pkn_policy.js
  _seller_pkn_policy.test.js
  stripe-connect-onboard.js
  create-order-checkout-session.js
  _marketplace_order_stripe.js
  _marketplace_order_stripe.test.js
  _eur_order_inventory.js
  _eur_order_inventory.test.js
  _native_sales.js
  _native_sales.test.js
  _order_refund.js
  _order_refund.test.js
  _firestore_fake.js
  eur-orders-sweep.js
  marketplace-native-sales.js
  stripe-webhook.js
  marketplace-orders.js
  pokoin-partner.js
  pokoin-partner.test.js
  marketplace-listings.js
  route-definitions.json
  patch-route-manifest.js
)

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"

say "stage exact origin/main commit $COMMIT"
git -C "$REPO" archive "$COMMIT" server/pokoin-api | tar -C "$STAGE" -xf -
SRC="$STAGE/server/pokoin-api"
for file in "${FILES[@]}"; do
  [[ -f "$SRC/$file" ]] || die "commit is missing server/pokoin-api/$file"
done

say "unit tests"
ADDRESS_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  node --test --test-force-exit \
    "$SRC/_checkout_core.test.js" \
    "$SRC/_client_country.test.js" \
    "$SRC/_packlink.test.js" \
    "$SRC/_marketplace_order_stripe.test.js" \
    "$SRC/_eur_order_inventory.test.js" \
    "$SRC/_native_sales.test.js" \
    "$SRC/_order_refund.test.js" \
    "$SRC/pokoin-partner.test.js" \
    "$SRC/_seller_pkn_policy.test.js" \
    "$SRC/marketplace-seller-settings.test.js" \
    "$SRC/patch-route-manifest.test.js"
for file in account-addresses.js marketplace-checkout-quote.js marketplace-shipping-options.js \
  marketplace-seller-settings.js \
  stripe-connect-onboard.js create-order-checkout-session.js stripe-webhook.js marketplace-orders.js \
  _eur_order_inventory.js _native_sales.js _order_refund.js eur-orders-sweep.js marketplace-native-sales.js \
  _seller_profile_cache.js _redis_cache.js _valkey.js _packlink.js; do
  node --check "$SRC/$file"
done

release="releases/checkout-eur-$SHORT-$STAMP"
say "Pi release $release"
ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(readlink current); echo \$prev > .checkout-eur-previous; cp -a \$prev '$release'; mkdir -p '$release/api'"
tar -C "$SRC" -cf - "${FILES[@]}" \
  | ssh pi-home "tar -C '/srv/pokoin/api/$release/api' -xf -"
ssh pi-home "node '/srv/pokoin/api/$release/api/patch-route-manifest.js' '/srv/pokoin/api/$release/server/api-route-manifest.js' '/srv/pokoin/api/$release/api/route-definitions.json'; rm -f '/srv/pokoin/api/$release/api/patch-route-manifest.js' '/srv/pokoin/api/$release/api/route-definitions.json' '/srv/pokoin/api/$release/api/'*.test.js '/srv/pokoin/api/$release/api/_firestore_fake.js'"
ssh pi-home "printf '%s\n' '$COMMIT' > '/srv/pokoin/api/$release/.pokoin-checkout-eur-commit'"

# Packlink PRO key from Infisical (pokoin/dev `packlink`) — not committed.
if [[ -z "${PACKLINK_API_KEY:-}" && -f /home/nez/secrets/infisical/admin.password ]]; then
  PACKLINK_API_KEY="$(python3 - <<'PY'
import json,urllib.request
email="vitologiuseppe17@gmail.com"
password=open("/home/nez/secrets/infisical/admin.password").read().strip()
tok=json.load(urllib.request.urlopen(urllib.request.Request(
  "http://127.0.0.1:8088/api/v3/auth/login",
  data=json.dumps({"email":email,"password":password}).encode(),
  headers={"Content-Type":"application/json"}, method="POST")))["accessToken"]
tok=json.load(urllib.request.urlopen(urllib.request.Request(
  "http://127.0.0.1:8088/api/v3/auth/select-organization",
  data=json.dumps({"organizationId":"4963c8aa-39de-42e8-a945-380ce729b0f0"}).encode(),
  headers={"Content-Type":"application/json","Authorization":f"Bearer {tok}"}, method="POST")))["token"]
data=json.load(urllib.request.urlopen(urllib.request.Request(
  "http://127.0.0.1:8088/api/v3/secrets/raw?environment=dev&workspaceId=f957a939-90f0-4ee1-b490-9afff162b64e&recursive=true",
  headers={"Authorization":f"Bearer {tok}"})))
for s in data.get("secrets") or []:
  if s.get("secretKey")=="packlink":
    print(s.get("secretValue") or "", end="")
    break
PY
)" || true
fi
if [[ -n "${PACKLINK_API_KEY:-}" ]]; then
  say "install Packlink API key into release (mode 600)"
  printf '%s\n' "$PACKLINK_API_KEY" | ssh pi-home "umask 077; cat > '/srv/pokoin/api/$release/api/.packlink-key'"
fi

# Ensure ADDRESS_ENCRYPTION_KEY exists in the container env (idempotent).
ssh pi-home "set -e
  if ! docker exec '$API_CONTAINER' printenv ADDRESS_ENCRYPTION_KEY >/dev/null 2>&1; then
    key=\$(openssl rand -hex 32)
    echo \"ADDRESS_ENCRYPTION_KEY=\$key\" >> /srv/pokoin/api/$release/.env.checkout-eur
    # Prefer docker compose / unit drop-in if present; otherwise inject via restart env file.
    mkdir -p /etc/pokoin
    if [[ ! -f /etc/pokoin/address-encryption.env ]]; then
      umask 077
      printf 'ADDRESS_ENCRYPTION_KEY=%s\n' \"\$key\" > /etc/pokoin/address-encryption.env
      echo \"wrote /etc/pokoin/address-encryption.env — wire into $API_CONTAINER env and restart\"
    fi
  fi
"

ssh pi-home "set -e; cd /srv/pokoin/api; ln -sfn '$release' current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"

say "verify health + auth guards + Packlink options"
healthy=0
for _ in $(seq 1 45); do
  health="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/healthz" || true)"
  quote="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18080/api/marketplace-checkout-quote" || true)"
  addresses="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/account-addresses" || true)"
  connect="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/stripe-connect-onboard" || true)"
  ship="$(ssh pi-home "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18080/api/marketplace-shipping-options?fromCountry=IT&toCountry=DK&cards=1'" || true)"
  if [[ "$health" == "200" && "$quote" =~ ^(401|403)$ && "$addresses" =~ ^(401|403)$ && "$connect" =~ ^(401|403)$ && "$ship" == "200" ]]; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "health failed (health=$health quote=$quote addresses=$addresses connect=$connect ship=$ship) — rolling back" >&2
  ssh pi-home "set -e; cd /srv/pokoin/api; prev=\$(cat .checkout-eur-previous); ln -sfn \$prev current.new; mv -Tf current.new current; docker restart '$API_CONTAINER' >/dev/null"
  die "Pi API verification failed; previous release restored"
fi

say "API live: $(ssh pi-home 'readlink /srv/pokoin/api/current')"
say "health=$health quote=$quote addresses=$addresses connect=$connect ship=$ship"
