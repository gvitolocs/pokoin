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

## Inventory link direction (2026-10-14)

Connecting CardTrader links the two inventories; it is not a one-off import.
Profile → CardTrader → **Inventory link** stores which way *new* stock is
copied as `inventorySync.direction` on `seller_integrations/{uid}__cardtrader`
(`POST /api/cardtrader-sync {"direction": …}` stores it and runs a sync; the
status carries it as `inventorySync`). Code: `pokoin-rust/crates/external/src/cardtrader/link.rs`.

| Direction | Reconcile imports CardTrader-only products | Reconcile lists Pokoin-only listings on CardTrader |
| --- | --- | --- |
| `ct_to_pokoin` (default; the behavior before the setting) | yes | no |
| `pokoin_to_ct` | no (counted as `notImported`) | yes |
| `both` | yes | yes |

Linked rows stay in sync both ways on a sale in every direction (webhook +
reconcile for CardTrader sales, `increment -n` for Pokoin sales). A seller's
price or quantity **edit** on Pokoin reaches CardTrader only in `pokoin_to_ct`
and `both` (next section). 1-Day Ready accounts are always CardTrader → Pokoin
(`409 cardtrader_one_day_ready` for the others).

The push runs after the plan applied its links, in the same periodic job and
manual sync, and only when the export passed the plan's gate and the run holds
the shared Redis reconcile lock (`blocked`: `incomplete_export` /
`no_shared_lock`; on 2026-10-14 21:15 UTC two syncs of one seller ran at once,
each reading an export without the other's creates). Candidates are active
Pokémon listings with stock whose `source_listing_id` is not `ct:…` (empty, or
another channel's id such as `scan:<item>`), never CardTrader imports. Since
2026-10-20 that is every CardTrader game, not only Pokémon (a Card Rails
Riftbound listing was never a candidate). Pokémon products keep their fixed
properties (`pokemon_language`, `pokemon_reverse`, …); every other game's are
read from the blueprint's `editable_properties` in
`marketplace_<game>.cardtrader_blueprints` (`push::product_body_for_blueprint`:
`riftbound_language` `en`/`zh-CN`/`fr`/`kr`, `riftbound_foil`, `mtg_foil`,
`first_edition`, …). A facet the blueprint cannot carry (an Italian Riftbound
card, a first edition where there is none) is refused before CardTrader is
called, so nothing is created as another copy; it counts as `failed` and
waits in the queue. Each candidate is:

- **linked** (`linkedToExisting`) when the same card + facets is on CardTrader
  as a product no listing holds: no duplicate is created;
- otherwise **created** as its own product. CardTrader accepts several products
  of the same card from one seller (one seller's 12,923 linked products cover
  12,792 facets), so a second copy is a second product. Until 2026-10-15 such a
  copy was skipped and, keeping its old `updated_at`, stayed first in the queue:
  76 of every 100 candidates, ~24 listed per run.

Creates are claimed with the outbox's compare-and-set (`<source read> →
ct:pending:link-<ms>`), sent with `user_data_field = pokoin:<listing id>`, then
linked over the claim (`origin = 'push'`). A refused create puts the old source
back; an in-doubt create keeps the claim and the next reconcile links it by its
`user_data_field`. A claim whose create never reached CardTrader used to stay
pending for ever (never listed). Before each push pass the reconcile now looks
for claims older than 15 minutes when its complete export was taken
(`STALE_CLAIM_GRACE_SECS`) that no exported product names; it reads the
seller's orders of the last 2 days once, settles a claim an order names as
sold out (`staleClaimsSold`: it sold on CardTrader before any export saw it),
and releases the others to `""` (`releasedStaleClaims`) so this pass lists
them. Orders it cannot read release nothing. The outbox's own push
(`targets.cardtrader` on create) is Pokémon-only; the other games are left to
this pass (`steps.cardtrader = "reconcile_push"`). A run pages through candidates (never one it already tried)
until none is left or its budget is spent: `CARDTRADER_PUSH_PER_RUN` (2,000),
`CARDTRADER_PUSH_SECONDS` (480, inside the 15-minute lock), at most 5 creates a
second, and it stops at the first CardTrader 429 (`stoppedBy`). `remaining`
counts what the next run picks up. A database error while pushing fails the
sync instead of reporting nothing to list.
Results land in the sync summary as `pushedToCardTrader`.

## Card Rails listings: from `list` to one CardTrader product (2026-10-20)

Card Rails (the seller's scanning app) creates Pokoin listings through the
Seller API connector (`POST /api/cardrails/connector`,
`pokoin-rust/crates/commerce/src/handlers/seller_api.rs`). Each step, its
idempotency key, and what a retry, a crash or a replay does:

| Step | Idempotency key | Retry | Crash | Replay / race |
| --- | --- | --- | --- | --- |
| Card Rails asks `sold-prices` for unpriced copies | none (read) | same answer | nothing written | — |
| Card Rails `list` → `seller_api_listing_keys` + `marketplace_user_listings` | `(grant_id, idempotency_key)`, Card Rails sends `cardrails:<item id>` | a bound key answers its listing (`created: false`) | the key is bound in the insert's own transaction (`BIND_API_KEY_SQL`, compare-and-set on `listing_id is null`): a crash leaves no row and an unbound key (the retry creates it) or both | two attempts at once both insert; one binds, the other rolls back (`409 list_key_bound`) and answers the bound row |
| Card Rails attaches the listing id | Card Rails `inventory_items.pokoin_listing_id is null` | — | its pull links a copy to the one listing with its facets and location | — |
| Price → on sale | the row's state: `paused` and `price_pkn = 0` | `update` with the same price: `changed: false` | single statement | `job price-unpriced-listings` compares-and-sets on "still paused at 0 with stock" |
| Reconcile push claim | `source_listing_id` compare-and-set `"" → ct:pending:link-<ms>` | a claimed listing is not a candidate | the claim stays; see in-doubt | the outbox push uses the same claim (`ct:pending:<event>`), so only one of them ever creates |
| CardTrader `POST /products` | `user_data_field = pokoin:<listing id>` | refused: claim released, retried next run; in doubt: claim kept | in doubt | the next complete export links the product by `user_data_field`; a stale claim is released only when no product and no order names it |
| Link back (`ct:<product id>`, `marketplace_cardtrader_product_links`) | `LINK_SQL` over the claim; link row `(seller_uid, ct_product_id)` | upsert | the next export links it by `user_data_field` | a product already linked to another listing is never relinked (`listing_linked_elsewhere`) |
| CardTrader sale → Pokoin stock | `cardtrader_webhook_events` seller + order + order item | the claim answers "already applied" | a failed decrement releases the claim | the reconcile records a missed sale with the same claim id |

Why the Vendetta copies of 2026-10-20 stayed paused: Pokoin's quote read only
Pokémon tables, so Card Rails got no price for any Riftbound copy and listed
it `paused` at 0 ("never guessed"), and nothing ever activated it. The quote
now reads the price store for every game (`priceSource:
"cardtrader_facet_floor"`), a later price activates a listing paused at 0, and
`job price-unpriced-listings --seller=<uid>` (dry run unless `--apply`) prices
the existing ones. The TLA+ model is
[`../specs/tla/listing-ct-sync`](../specs/tla/listing-ct-sync/README.md).

## Pokoin edits of linked listings (2026-10-14)

In `pokoin_to_ct` and `both`, a price or quantity edit of a `ct:<product_id>`
listing on Pokoin reaches its CardTrader product. Every edit path goes through
`update_listing` (`pokoin-rust/crates/commerce/src/handlers/listings.rs`): the
seller desk, the MyPokoin board, and Seller API `update` / `stock`. In
`ct_to_pokoin` CardTrader stays the source of truth: the edit stays on Pokoin
and the reconcile copies CardTrader's quantity back. 1-Day Ready accounts never
get a write.

- `update_listing` measures the edit against the row as it was under its row
  lock (not the replica) and puts `cardtraderEdit: {productId, pricePkn?,
  quantityDelta?}` on the `listing.changed` event. A listing taken off sale
  (inactive, sold out, quantity 0) gets the existing destroy instead. An edit
  of the link itself, or of a listing whose push is still `ct:pending:*`,
  sends nothing. Sales, webhook and reconcile writes never carry an edit, so
  nothing echoes back to CardTrader.
- The outbox step (`listing_sync::edit_cardtrader`) reads
  `seller_integrations/{uid}__cardtrader` and sends:
  - **price**: `PUT /products/:id {"price": <eur>}`, converted like the push
    (200 PKN = €1, to the cent). It is absolute, so a write in doubt (no answer,
    a 5xx) is retried by the outbox.
  - **quantity**: `POST /products/:id/increment` with the change
    (`delta_quantity: new − old`), never the new total: the same rule as a
    Pokoin sale (see "Never written back"). Example: CardTrader and Pokoin
    both at 3, one copy sells on CardTrader, and before Pokoin hears of it the
    seller edits Pokoin from 3 to 5. The increment leaves CardTrader at 4. An
    absolute write of 5 would put the sold copy back on sale.
- The increment is not idempotent. Before sending it, the step claims
  `steps.cardtraderQuantity = "sending"` on the event row (compare-and-set).
  An attempt that finds `sending` (a crash or a lost answer earlier, or a
  second worker) never sends again and records `in_doubt`. So a write in doubt
  can lose the edit (the next reconcile copies CardTrader's quantity back,
  where the seller sees it) but never applies it twice.
- `gone` (404) and `refused` (another 4xx, a rejected token) are final;
  retrying cannot change CardTrader's answer, and the reconcile settles the
  listing.
- Step labels on the event: `steps.cardtraderPrice` / `cardtraderQuantity` =
  `updated` | `gone` | `refused` | `in_doubt` (`invalid_price` when the price
  converts to less than a cent); `steps.cardtraderEdit` = `done` or why it was
  skipped (`ct_to_pokoin`, `one_day_ready`, `not_connected`). Failures log
  `cardtrader_edit_not_applied`.
- A failed outbox attempt keeps the steps it finished. It used to write the
  claimed payload back, which would also have erased the `sending` claim.
- A reconcile whose export was taken before the increment landed may lower a
  raised quantity back for one run (rows written after the export may only go
  down); the next run raises it again.
- Not covered: price changes made on CardTrader are not copied to Pokoin (the
  reconcile copies quantity only), and `POST /api/marketplace-listings?action=decrement`
  does not reach CardTrader.

## Power Tools location import

Profile → CardTrader → **Import locations** uploads one Power Tools stock CSV
per game (`powerToolsCsv: {game: csv}` with `stackSize`, `numberedInStack`,
`locationParse`). `previewGames` lists the games in the export,
`previewPowerTools` shows how the locations read and sample matches without
writing; the import itself is a normal sync whose rows are matched to
CardTrader products (`reconcile_power_tools_with_cardtrader`) and whose
locations go onto the linked Pokoin listings. Unmatched rows on either side are
`summary.powerToolsReconcile.ctOnly` / `ptOnly` for `/inventory/sync-review`.

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

`pokoin-rust-job-cardtrader-seller-reconcile.timer` runs on `pi-home` ten
minutes after the previous run ends (`OnUnitInactiveSec`; counted from the
start, 7-minute runs chained back to back). Its oneshot service (`pokoin-rust-job@cardtrader-seller-reconcile`)
uses `flock` to prevent overlap and runs the native job
`/srv/pokoin/rust/current job cardtrader-seller-reconcile`. Each run:

1. reads enabled CardTrader integrations;
2. repairs/verifies each seller-scoped webhook URL; and
3. reconciles the complete export.

Unchanged product links are not rewritten, keeping frequent safety runs cheap.
A listing can carry a `ct:<product>` source that another channel set (Card
Rails' own CardTrader push) with no `marketplace_cardtrader_product_links` row:
the webhook still finds it by source, but the first reconcile that sees its
product in the export records the row (`origin = 'match'`, summary
`linksRecorded`), so link counts and settled removals include it. On
2026-10-14 2 of PeppeV's 1,463 linked listings had no row; both products were
in his export, so they were never stale.
A linked listing an earlier run already settled (sold out at zero, its link
`missing_from_ct`) is not removed again, and seller orders are fetched only
when a product newly left the export. The export is parsed while it downloads
and only the fields the reconcile reads are kept: read whole as JSON, a
12,523-product export took the job to 1.77 GB on the 4 GB Pi (2026-10-10).

The sync ships in the Rust release (`scripts/deploy-pokoin-rust.sh`). The
periodic run is the native job `pokoin-rust-job@cardtrader-seller-reconcile`
(`deploy/systemd/pokoin-rust-job-cardtrader-seller-reconcile.timer`, installed
by `scripts/cutover-pi-rust.sh`); see [RUST_RUNTIME.md](RUST_RUNTIME.md).

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

The backfill was an operator CLI inside the retired Node container
(`cardtrader-sales-backfill.js --uid <firebaseUid> [--apply]`). It has no Rust
port yet; see [rust-migration/NODE_REMAINING.md](rust-migration/NODE_REMAINING.md).

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
  gone), nothing else is touched. A seller's Pokoin quantity edit (push
  directions only) goes the same way, as `delta_quantity: new − old`; only the
  price is written as a value. Other marketplaces are never touched.
- Webhook `order.destroy` restocks like a cancellation.
- **Disconnect** wipes the token and secret, so Pokoin can no longer see
  CardTrader sales. `cardtrader-disconnect` therefore takes the
  CardTrader-imported listings off Pokoin (`inactive`, never deleted; `sold_out`
  rows keep their label) and drops their import links. Nothing changes on
  CardTrader, and the seller's own Pokoin listings stay live. Reconnecting
  re-imports them with fresh quantities and prices. 2026-09-28: redshakkio
  disconnected at 13:01 UTC with 12,028 imported listings still live; they were
  taken off the same way.

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
ssh pi-home 'systemctl status pokoin-rust-job-cardtrader-seller-reconcile.timer --no-pager'
ssh pi-home 'journalctl -u pokoin-rust-job@cardtrader-seller-reconcile.service -n 100 --no-pager'
```

A manual seller sync remains available from the Profile UI (Sync now) or
authenticated `POST /api/cardtrader-sync`. Never infer removal from an
incomplete export.

Deploy the sale-accounting guard from an exact `origin/main` commit:

```bash
bash scripts/deploy-cardtrader-sale-dedupe.sh <origin-main-commit>
```
