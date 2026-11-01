# Inventory origin and cross-channel duplicates (2026-11-01)

A seller may have listed the same card through more than one channel: Card
Rails before Pokoin, a CardTrader sync, a Power Tools (Cardmarket) CSV. Every
inventory row on `/mypokoin` now carries a source tag, and the board flags
live listings that look like the same copy from two channels.

## Origin

No new column: the origin is derived from what each channel already writes on
`marketplace_user_listings`. Rules, first match wins. Code:
`market/src/inventory-origin.js` `listingOrigin` and its Rust twin
`pokoin-rust/crates/commerce/src/listing_origin.rs` (same rules, both tested).

| Origin | Label | How it is recognised |
| --- | --- | --- |
| (any) | | the API's `origin` field, when it is a known id |
| `cardrails` | Card Rails | a `cardrails:<item>` key in `seller_api_listing_keys` whose grant belongs to the row's seller (the Seller API connector keeps the default `source`) |
| `cardtrader` | CardTrader | `source` `cardtrader_seller_import`, `cardtrader_csv_import`, `cardtrader_live`, `cardtrader` |
| `cardmarket` | Cardmarket | `source` `powertools_csv_import`, `cardmarket_csv_import`, or `source_listing_id` `pt:` / `cm:` |
| `tcgplayer` | TCGplayer | `source` `tcgplayer_csv_import`, or `source_listing_id` `tp:` |
| `csv` | CSV import | `source` `stock_csv_import` |
| `pokoin` | Pokoin | everything else: `pokoin_scan_batch`, `pokoin_user_listing`, empty |

A `ct:` `source_listing_id` alone never decides: Pokoin and Card Rails rows
pushed to CardTrader get one too and keep their own `source`.

`GET /api/marketplace-listings?sellerUid=` (the owner's book) adds the Card
Rails flag with one `exists` semi-join per query and emits `origin` on every
row. Before migration 115 the key table is missing and the read falls back to
no flag. Migration 137 indexes the key table by `listing_id` for that join.

Not derivable: a Card Rails card that reached Pokoin through a CardTrader
import (before the connector existed, or listed on CardTrader by Card Rails)
shows as CardTrader; a Card Rails item created by hand on Pokoin shows as
Pokoin.

## Duplicate rule

Two **live** listings (active or paused, quantity > 0) are a likely duplicate
when they share card id, condition (default NM), language (default EN),
finish (`foilState`, `reverse: true` counts as reverse), first edition, and
for graded copies the slab (certification id, else company + grade), **and**
come from different origins. Three scans of one card are one origin: not a
duplicate.

- Inventory board: a "Source" select, a "Possible duplicates" toggle, and a
  "Possible duplicate" tag whose tooltip names the other channels and their
  quantities.
- Scan Desk: a row about to list a copy the book already holds from another
  channel shows "Already listed from Card Rails (qty 1)". It never blocks the
  submit or changes its payload.

Flagged duplicates are read-only: nothing is merged, paused or deleted. The
owner decides how to resolve them later.
