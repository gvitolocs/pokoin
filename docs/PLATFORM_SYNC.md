# Sync with other platforms

A seller connects the other places they sell (Shopify, Cardmarket, TCGplayer,
…) and Pokoin keeps one stock across all of them: a sale anywhere takes exactly
the sold quantity off every other connected platform. The seller never has to
split their inventory and the same physical card is never sold twice.

CardTrader is the first and reference integration
([CARDTRADER_SELLER_SYNC.md](CARDTRADER_SELLER_SYNC.md)); it keeps its own
routes, webhook and reconcile. Everything below generalises that contract to
the other providers and plugs CardTrader into the same fan-out.

## Invariants (same as CardTrader)

1. **Relative deltas only.** Every write to another platform is "take *n*
   off" / "put *n* back", never an absolute quantity, so stock the seller
   changed directly on that platform is never overwritten.
2. **Exactly once per external order item.** An external sale is claimed in
   `marketplace_platform_sync_events` (primary key seller + provider + order +
   item + kind) before Pokoin stock moves; a failed decrement deletes the
   claim so a retry can succeed. A cancel restores at most once and only if
   the sale claim exists.
3. **No echo loops.** A change that came from provider X is fanned out to
   every linked provider *except* X.
4. **A failed or incomplete read never removes stock.** Pollers only act on
   individual sold order items, never on "absent from a listing".
5. **External sales are not Pokoin-native sales.** The Pokoin decrement runs
   with `set_config('pokoin.platform_sync', '<provider>', true)` in the same
   transaction; the listing audit trigger then records `platform_synced`
   (sold_qty 0), exactly like `cardtrader_synced`. The sale itself is stored
   in Firestore `marketplace_sales/{provider}_{order}__{item}` with
   `source: <provider>` so it shows in the seller's Sold history.
6. **Secrets.** Tokens are AES-256-GCM encrypted with the existing
   `CARDTRADER_TOKEN_ENCRYPTION_KEY` helper (`_cardtrader_crypto.js`).
   Passwords are never asked for or stored. Status responses and logs never
   contain a secret.
7. **Revoke** wipes the encrypted credentials, removes the provider's webhook
   when it has one, and deletes that provider's links. Pokoin listings stay
   as they are; nothing is changed on the other platform.

## Providers

| id | Label | Connect | Sold detection | Stock write | Pokoin env |
| --- | --- | --- | --- | --- | --- |
| `cardtrader` | CardTrader | existing token panel | existing webhook + reconcile | existing `/products/:id/increment` | existing |
| `shopify` | Shopify | shop domain + Admin API access token + API secret key (custom app) | `orders/paid` + `orders/cancelled` webhook (HMAC) and 5-min order poll | GraphQL `inventoryAdjustQuantities` delta | — |
| `binderpos` | BinderPOS | same as Shopify (BinderPOS stores are Shopify stores) | same as Shopify | same as Shopify | — |
| `cardmarket` | Cardmarket | **Pokoin widget app** OAuth: "Log in to Cardmarket" redirect | 5-min poll of paid seller orders | `PUT /stock/decrease` / `/stock/increase` | `CARDMARKET_APP_TOKEN`, `CARDMARKET_APP_SECRET` |
| `tcgplayer` | TCGplayer | seller pastes the store authorization code from TCGplayer | 5-min poll of store orders | `POST /stores/{storeKey}/inventory/skus/{skuId}/quantity` delta | `TCGPLAYER_PUBLIC_KEY`, `TCGPLAYER_PRIVATE_KEY` |
| `ccgseller` | CCGSeller | partner request (API key + store id) | — until partner API is configured | — | `PLATFORM_CCGSELLER_API_BASE` |
| `storepass` | Storepass | partner request | — | — | `PLATFORM_STOREPASS_API_BASE` |
| `sortswift` | Sortswift | partner request | — | — | `PLATFORM_SORTSWIFT_API_BASE` |
| `magus` | Magus Shop | partner request | — | — | `PLATFORM_MAGUS_API_BASE` |

A provider whose Pokoin env is missing is listed with `available: false`
("Not available yet"); connecting it returns `503 platform_unavailable`.
Partner providers accept the request, store the encrypted key with
`state: 'pending_activation'` and write `platform_sync_requests/{uid}__{id}`
for staff — "The sync will not start immediately; our staff will contact you
at <email>" — exactly like CardTrader's own Cardmarket row.

### Shopify / BinderPOS

- Validate: `GET https://{shop}.myshopify.com/admin/api/2025-07/shop.json`
  with `X-Shopify-Access-Token`. `shop` must match `^[a-z0-9][a-z0-9-]*$`
  (accept `name`, `name.myshopify.com`, or an https URL of it).
- Location: first active location from `GET /locations.json`, stored in
  integration metadata.
- Webhooks (REST `POST /webhooks.json`): `orders/paid` and `orders/cancelled`
  to `https://api.pokoin.com/api/platform-webhook/{provider}/{uid}`. Verify
  `X-Shopify-Hmac-Sha256` = base64 HMAC-SHA256(raw body, API secret key),
  timing-safe compare. Revoke deletes the registered webhook ids.
- Sold items: each `line_items[]` → `{ orderId: order.id, itemId: line.id,
  externalId: line.variant_id, sku: line.sku, quantity }`.
- Inventory list (link by SKU): GraphQL `productVariants(first: 250, after:)`
  → `{ externalId: variant legacyResourceId, sku, inventoryItemId,
  quantity: inventoryQuantity, title }`.
- Adjust: GraphQL `inventoryAdjustQuantities(input: { reason: "correction",
  name: "available", changes: [{ delta, inventoryItemId, locationId }] })`.

### Cardmarket (MKM API 2.0, widget app)

- Pokoin registers one **Widget App** at Cardmarket with callback
  `https://api.pokoin.com/api/platform-oauth/cardmarket/callback`.
- Authorize: `POST /api/platform-integrations/cardmarket` with `{}` returns
  `{ redirectUrl: "https://api.cardmarket.com/ws/v2.0/authenticate/{appToken}" }`
  and stores a one-time `state` (10-minute TTL) on the integration doc; the
  browser goes there, the seller logs in **on Cardmarket**, and Cardmarket
  redirects to the callback with `?request_token=…`.
- Callback: exchange with `POST https://api.cardmarket.com/ws/v2.0/output.json/access`
  (OAuth 1.0a HMAC-SHA1 header, `oauth_token=request_token`, empty token
  secret, `realm` = request URL, XML body
  `<request><app_key>{appToken}</app_key><request_token>{rt}</request_token></request>`)
  → `oauth_token`, `oauth_token_secret` (stored encrypted). Then
  `GET /output.json/account` for the username, then redirect the browser to
  `https://pokoin.com/profile?platform=cardmarket&connected=1` (or `&error=`).
  The seller's Pokoin uid is carried in the state, never trusted from the
  query alone: the callback looks the state up across `seller_integrations`
  (`oauthState == state`, not expired).
- Sold items: `GET /output.json/orders/1/2` (actor seller, state paid), each
  `article[]` → `{ orderId: idOrder, itemId: idArticle, externalId:
  idArticle, idProduct, quantity: count }`. Cancelled:
  `GET /output.json/orders/1/128`.
- Inventory list: `GET /output.json/stock` → articles with `idArticle`,
  `idProduct`, `count`, `language`, `condition`, `isFoil`, `price`,
  `product.enName`, `product.expansion`, `product.nr`.
- Adjust: `PUT /output.json/stock/decrease` (or `/increase`) with XML body
  `<request><article><idArticle>{id}</idArticle><count>{n}</count></article></request>`.

### TCGplayer

- Bearer: `POST https://api.tcgplayer.com/token` form
  `grant_type=client_credentials&client_id={public}&client_secret={private}`
  (cached until `expires_in`).
- Connect: `POST /app/authorize/{authCode}` → store `accessToken`; then
  `GET /stores/self` (header `X-Tcg-Access-Token`) → `storeKey`, name.
- Sold items: `GET /stores/{storeKey}/orders?limit=100&sort=OrderDate%20Desc`
  then `GET /stores/{storeKey}/orders/{orderNumber}/items` →
  `{ orderId: orderNumber, itemId: skuId, externalId: skuId, quantity }`.
- Inventory list: `GET /stores/{storeKey}/inventory/products?limit=100&offset=`.
- Adjust: `POST /stores/{storeKey}/inventory/skus/{skuId}/quantity`
  `{ "quantity": delta }`.

## Data model

Postgres writer, migration `scripts/sql/111_marketplace_platform_sync.sql`:

- `marketplace_platform_links(listing_id uuid → marketplace_user_listings on
  delete cascade, seller_uid, provider, external_id, external_meta jsonb,
  match_method 'sku'|'import'|'manual', last_pushed_at, last_error,
  created_at, updated_at)`, PK `(listing_id, provider)`, unique
  `(seller_uid, provider, external_id)`.
- `marketplace_platform_sync_events(seller_uid, provider, external_order_id,
  external_item_id, kind 'sale'|'cancel', listing_id, quantity, created_at)`,
  PK `(seller_uid, provider, external_order_id, external_item_id, kind)`.
- The listing audit trigger function gains: when
  `current_setting('pokoin.platform_sync', true)` is non-empty and the change
  is a sale, `ev := 'platform_synced'; sold_qty := 0; is_sold := false;`.

Firestore `seller_integrations/{uid}__{provider}` (same collection as
CardTrader): `{ uid, provider, enabled, state: 'connected'|'pending_activation'|'disconnected',
metadata (non-secret account info), encryptedSecrets: { name: ciphertext },
oauthState, oauthStateExpiresAt, webhookRegistration, lastPolledAt,
inventorySync, connectedAt, updatedAt, disconnectedAt }`.

## Code layout (`server/pokoin-api/`)

| File | Role |
| --- | --- |
| `_platform_providers.js` | Registry: id, label, authType (`token_panel`, `fields`, `oauth_redirect`, `partner`), fields, docsUrl, capabilities, `isAvailable(env)` |
| `_platform_integration.js` | Generic Firestore store: store/read/disconnect, encrypted secrets, safe status |
| `_platform_links.js` | Postgres link + event-claim CRUD |
| `_platform_fanout.js` | `fanOutStockChange`, `applyExternalSale`, `applyExternalCancel`, `pollProvider` (all deps injectable) |
| `_platform_import.js` | `linkAndImportInventory` (SKU match, then optional catalog import) |
| `_platform_adapters/{shopify,cardmarket,tcgplayer,partner}.js` + `index.js` | One adapter per provider; `binderpos` reuses shopify |
| `_stock_listing_import.js` | `resolveCard` + `insertListing` moved out of `marketplace-listings-csv.js` |
| `platform-integrations.js` | `GET /api/platform-integrations`, `POST|DELETE /api/platform-integrations/:provider` |
| `platform-oauth-callback.js` | `GET /api/platform-oauth/:provider/callback` |
| `platform-webhook.js` | `POST /api/platform-webhook/:provider/:uid` (rawBody) |
| `platform-links.js` | `GET|POST|DELETE /api/platform-links` (manual link/unlink, re-run link/import) |
| `platform-sync-poll-all.js` | Timer CLI: poll every enabled provider with `fetchSoldItems` |

Adapter interface (every function receives `{ credentials, metadata, fetchFn }`):

```js
{
  validate(input)            // → { credentials, metadata }  (connect)
  registerWebhooks?(ctx, url) // → { ids: [...] }
  removeWebhooks?(ctx)
  verifyWebhook?(rawBody, headers, credentials) // → boolean
  parseWebhook?(body, headers) // → { kind: 'sale'|'cancel', items: [...] }
  fetchSoldItems?(ctx, { since }) // → { complete: bool, sales: [...], cancels: [...] }
  listInventory?(ctx)        // → { complete: bool, items: [...] }
  adjustStock(ctx, { link, delta }) // → { ok, remaining? }
}
```

Sold item shape: `{ orderId, itemId, externalId, sku, quantity,
unitPriceCents, currency, soldAt }`.

## Flows

- **Pokoin sale**: `syncPlatformsAfterPokoinSale` (`marketplace-orders.js`)
  runs `fanOutStockChange({ origin: 'pokoin', delta: -qty })` after a paid
  PKN order, and `_eur_order_inventory.js` runs it once per line for EUR
  orders (`fulfillment.platformDone`, marked done even when a platform
  refuses, so a retry never subtracts twice where it worked; the refusal
  stays on the link as `last_error`). CardTrader keeps its existing path.
  Checkout restores only release unpaid reservations, which never reached
  another platform, so they do not fan out.
- **CardTrader sale**: `cardtrader-webhook.js` fans out `-qty` after the
  Pokoin decrement and `+qty` after a cancel restore; the 5-minute
  reconcile fans out a missed sale it claims from CardTrader's seller
  orders (`_cardtrader_inventory_sync.js`). Origin `cardtrader` is never
  pushed back to CardTrader.
- **Other platform sale** (webhook or poll): `applyExternalSale` → claim →
  decrement Pokoin listing (guarded `quantity_available >= qty`, status
  active/paused) → Firestore sale row → fan out to every other link,
  CardTrader included (via `decrementLinkedCardTraderProduct` when the
  listing's `source_listing_id` is `ct:`) → price summary refresh + cache
  invalidation.
- **Connect** → validate → store → register webhooks → enqueue
  `linkAndImportInventory`: SKU equal to the Pokoin listing id (uuid) or its
  `source_listing_id` links `sku`; Cardmarket/TCGplayer items not matched by
  SKU are imported through `resolveCard` (name + collector number + set) as
  new listings (`source: '<provider>_sync'`) and linked `import`; Shopify
  stays link-only. Unmatched items are reported, never guessed.

## Operations

`pokoin-platform-sync-poll.timer` on `pi-home` runs
`/app/api/platform-sync-poll-all.js` in `pokoin-oracle-api` every five
minutes under `flock`. Deploy the API first, then the timer, from the exact
`origin/main` commit:

```bash
bash scripts/deploy-platform-sync-api.sh <origin-main-commit>
bash scripts/deploy-platform-sync-timer.sh <origin-main-commit>
```

Production also needs migration 111 applied on the nezopt writer and the
Cardmarket widget app / TCGplayer developer keys in the API env before those
providers turn `available`.

## Production checklist

1. Apply `scripts/sql/111_marketplace_platform_sync.sql` on the nezopt writer
   (link + event tables, `platform_synced` audit branch). Idempotent.
2. Provider env in the `pokoin-oracle-api` container env:
   - Cardmarket: register one **Widget App** at Cardmarket with callback
     `https://api.pokoin.com/api/platform-oauth/cardmarket/callback`, then set
     `CARDMARKET_APP_TOKEN` / `CARDMARKET_APP_SECRET`.
   - TCGplayer: `TCGPLAYER_PUBLIC_KEY` / `TCGPLAYER_PRIVATE_KEY` (developer
     keys; TCGplayer no longer issues them to new developers by default).
   - Optional: `POKOIN_PUBLIC_API_BASE` (webhook/OAuth base, default
     `https://api.pokoin.com`), `POKOIN_WEB_BASE` (OAuth return, default
     `https://pokoin.com`).
   Shopify / BinderPOS need nothing: each seller brings a custom-app token.
3. Deploy the API, then the poll timer, from the same `origin/main` commit:
   `scripts/deploy-platform-sync-api.sh <commit>`, then
   `scripts/deploy-platform-sync-timer.sh <commit>`.
4. Partner rows (CCGSeller, Storepass, Sortswift, Magus Shop) only collect
   requests (`platform_sync_requests`) until a partner API is obtained, a
   real adapter replaces `_platform_adapters/partner.js` for that id, and
   `PLATFORM_<ID>_API_BASE` is set.

## Known limits (v1)

- Shopify/BinderPOS listings are linked only when the variant SKU is the
  Pokoin listing id or its `source_listing_id`, or by a manual link
  (`POST /api/platform-links`); Shopify products are never imported.
- Cardmarket/TCGplayer items without a unique catalog match (name + collector
  number + set) are reported as unmatched, never guessed.
- The Cardmarket and TCGplayer adapters are built against their documented
  APIs but untested against live accounts until Pokoin has the app keys.
