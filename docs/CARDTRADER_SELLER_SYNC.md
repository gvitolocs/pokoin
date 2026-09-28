# CardTrader connected-seller stock

This is the stock mirror for a seller who connects a CardTrader app token to
Pokoin. It is separate from the global CardTrader market dump, sold-comps
inference, and `cardtrader_blueprint_listing_cache`.

## Contract

For every `marketplace_user_listings` row whose `source_listing_id` is
`ct:<product_id>`:

- a CardTrader order webhook is the immediate quantity-decrement path;
- a complete `GET /products/export` is the authoritative convergence path;
- a product absent from a **complete** export becomes `quantity_available=0`
  and `status=sold_out`;
- a failed, malformed, or explicitly incomplete export must never remove
  stock; and
- Pokoin-only rows are outside this reconciliation and must never be changed.

`sold_out` rows remain in Postgres for audit/history but are excluded from the
seller shop and inventory UI.

## Delivery and fallback

Connect registers this exact callback and requires CardTrader to echo it:

```text
https://api.pokoin.com/api/cardtrader-webhook/<firebase-uid>
```

Registration health is stored as non-secret `webhookRegistration` metadata on
the seller integration. Failures do not discard a valid encrypted token, but
they are no longer silently forgotten. Every periodic run retries registration.

`pokoin-cardtrader-seller-reconcile.timer` runs on `pi-home` every five
minutes. Its oneshot service uses `flock` to prevent overlap and runs
`/app/api/cardtrader-reconcile-all.js` inside `pokoin-oracle-api`. Each run:

1. reads enabled CardTrader integrations;
2. repairs/verifies each seller-scoped webhook URL; and
3. reconciles the complete export.

Unchanged product links are not rewritten, keeping frequent safety runs cheap.

Deploy the API first, then the timer:

```bash
bash scripts/deploy-cardtrader-sync-api.sh <origin-main-commit>
bash scripts/deploy-cardtrader-reconcile-timer.sh <origin-main-commit>
```

## Webhook idempotency

The webhook accepts signed `order.create` and `order.update` seller orders.
Direct orders decrement at `paid`; CardTrader Zero orders decrement at
`hub_pending`. The HMAC is checked against the raw request body.

An event is claimed by seller + order + order-item only after its linked Pokoin
listing is resolved. A failed Postgres decrement releases the claim so a retry
can succeed. Flat and nested CardTrader product-id/user-data shapes are
accepted. Unknown links enqueue a complete-export reconcile.

Successful processing writes a structured log with uid, cause, order id,
counts, and reason codes—never the token, shared secret, or raw order payload.

## 2026-09-27 Gumshoos incident

Card `703340`, Gumshoos Illustration Rare 153/132, had redshakkio listing
`460c87d1-b7d2-454c-8eea-f844b2238619` linked to CardTrader product
`420555233`. The product was absent from CardTrader's complete seller export,
but Pokoin still exposed it because:

- CardTrader had no webhook URL registered for the connected app;
- Firestore had zero claimed webhook events for the seller; and
- there was no periodic connected-seller reconcile.

The 2026-09-27 complete reconcile set the row to `sold_out`, quantity `0`, and
`missing_from_ct=true`. The public card API then returned no redshakkio offer.
The card itself remains in the catalog and can still show global CardTrader
market availability from other sellers; catalog presence is not this seller's
stock.

## 2026-09-28 webhook never verified a delivery

Every real CardTrader delivery was rejected with a silent `401`. The Pi API
server hands `rawBody: true` routes the untouched request stream — it sets
neither `req.rawBody` nor `req.body` — and `cardtrader-webhook.js` only read
those two, so it signed an empty buffer. A correctly signed self-test through
`https://api.pokoin.com` reproduced the `401`; the stored shared secrets matched
CardTrader's `GET /info` for all three connected sellers. Firestore had zero
`cardtrader_webhook_events`, and every CardTrader sale since the import
(redshakkio: 235 order items over 141 orders) was removed from Pokoin only by
the 5-minute complete-export reconcile.

Fix: `rawBodyBuffer` (in `_cardtrader_webhook_core.js`) reads the exact bytes
from the stream when nothing buffered them, and rejections now log
`cardtrader-webhook rejected` with the reason and body size.

A CardTrader sale of a linked listing is now a **real sale**: the webhook
writes `marketplace_sales/ct_{order}__{item}` (`source: cardtrader`, seller
price, condition, language, CardTrader order code) next to the stock decrement,
and it shows in the seller's Sold history. A cancelled CardTrader order puts
the quantity back and voids that row, once, via the claimed event.

Historic sales are backfilled from CardTrader's seller orders — never from
"vanished from the export":

```bash
# dry run (read-only), then --apply
docker exec -w /app pokoin-oracle-api node /app/api/cardtrader-sales-backfill.js --uid <firebaseUid>
docker exec -w /app pokoin-oracle-api node /app/api/cardtrader-sales-backfill.js --uid <firebaseUid> --apply
```

Only items sold after the listing was imported count. Linked listings that left
CardTrader with no seller order are delistings, not sales: `--apply` sets them
`inactive`, not `sold_out`.

## Sold vs delisted (2026-09-28)

The seller's CardTrader account is theirs; Pokoin only mirrors it with the API
token they gave us.

- **Sold** = a CardTrader seller order (`GET /orders?order_as=seller`) for that
  product, not `pending`/cancelled, placed after the listing was linked. The
  webhook records it immediately; when a product leaves the complete export,
  the reconcile looks at the last 30 days of seller orders and records any sale
  the webhook missed (same `cardtrader_webhook_events` claim, same
  `marketplace_sales` row id). Listing → `sold_out`.
- **Delisted** = gone from the export with no such order: the seller removed it
  on CardTrader. Listing → `inactive`, quantity 0, **no sale**. If the seller
  relists that product on CardTrader it comes back; a listing the seller hid on
  Pokoin stays hidden.
- Order data unavailable → treated as delisted (off sale, nothing claimed).
- **Never written back:** reconcile only reads CardTrader. A Pokoin sale takes
  exactly the sold quantity off CardTrader with `POST /products/:id/increment`
  (`delta_quantity: -n`), never an absolute quantity, so stock the seller
  changed on CardTrader is not overwritten; if CardTrader refuses (already
  gone), nothing else is touched. Other marketplaces are never touched.
- Webhook `order.destroy` restocks like a cancellation.

## PlusCal / TLC

[`../specs/CardTraderSellerInventory.tla`](../specs/CardTraderSellerInventory.tla)
models failed initial registration, later repair, a sell-out, webhook delivery,
and the complete-export fallback. TLC checks:

- bounded/type-correct stock state;
- no stale Pokoin quantity after an observation has fully settled; and
- every CardTrader sell-out eventually reaches zero Pokoin stock under fair
  webhook/reconcile scheduling.

See [`../specs/README.md`](../specs/README.md) for the commands.

## Operations

```bash
ssh pi-home 'systemctl status pokoin-cardtrader-seller-reconcile.timer --no-pager'
ssh pi-home 'journalctl -u pokoin-cardtrader-seller-reconcile.service -n 100 --no-pager'
```

A manual seller sync remains available from the Profile UI or authenticated
`POST /api/cardtrader-sync`. Never infer removal from an incomplete export.
