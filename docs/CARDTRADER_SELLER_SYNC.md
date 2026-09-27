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

## Sale accounting invariant

A connected seller's `ct:<product_id>` row is an inventory mirror. When its
quantity decreases through an order webhook or complete-export reconcile, the
listing audit trigger records `cardtrader_synced`, never Pokoin-native `sold`
or `quantity_decreased`. The same transaction is already represented by the
global CardTrader sold-comps pipeline; counting the mirror update as a native
sale would double its price/weight evidence.

Migration `scripts/sql/092_cardtrader_sale_dedupe.sql` reclassifies historical
linked mirror events, rebuilds native daily sold counters from the remaining
genuine Pokoin events, and refreshes marketplace weights. It deliberately
preserves the audit rows and CardTrader sold-comps history.

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

## PlusCal / TLC

[`../specs/CardTraderSellerInventory.tla`](../specs/CardTraderSellerInventory.tla)
models failed initial registration, later repair, a sell-out, webhook delivery,
and the complete-export fallback. TLC checks:

- bounded/type-correct stock state;
- no stale Pokoin quantity after an observation has fully settled; and
- zero Pokoin-native sold evidence for CardTrader mirror updates; and
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

Deploy the sale-accounting guard from an exact `origin/main` commit:

```bash
bash scripts/deploy-cardtrader-sale-dedupe.sh <origin-main-commit>
```
