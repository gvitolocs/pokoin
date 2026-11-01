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
| `cardtrader` | CardTrader | `source` `cardtrader_seller_import`, `cardtrader_csv_import`, `cardtrader_live`, `cardtrader` |
| `cardmarket` | Cardmarket | `source` `powertools_csv_import`, `cardmarket_csv_import` |
| `tcgplayer` | TCGplayer | `source` `tcgplayer_csv_import` |
| `csv` | CSV import | `source` `stock_csv_import` |
| `cardrails` | Card Rails | a `cardrails:<item>` key in `seller_api_listing_keys` whose grant belongs to the row's seller (the Seller API connector keeps the default `source`) |
| `cardmarket`, `tcgplayer` | | `source_listing_id` `pt:` / `cm:`, `tp:` |
| `pokoin` | Pokoin | everything else: `pokoin_scan_batch`, `pokoin_user_listing`, empty |

An import `source` beats a Card Rails key: Card Rails also binds keys to
listings it pulled in from an existing CardTrader import (12,061 live rows on
2026-11-01; its own items say `source = cardtrader` and have no photo), and
those came from CardTrader. A `ct:` `source_listing_id` alone never decides:
Pokoin and Card Rails rows pushed to CardTrader get one too and keep their own
`source`.

`GET /api/marketplace-listings?sellerUid=` (the owner's book) adds the Card
Rails flag with one `exists` semi-join per query and emits `origin` on every
row. Before migration 115 the key table is missing and the read falls back to
no flag. Migration 137 indexes the key table by `listing_id` for that join.

Not derivable: a card Card Rails scanned and listed on CardTrader itself, which
then reached Pokoin through a CardTrader import, shows as CardTrader; a Card
Rails item created by hand on Pokoin shows as Pokoin.

## Duplicate rule

Two **live** listings (active or paused, quantity > 0) are a likely duplicate
when they share card id, condition (default NM), language (default EN),
finish (`foilState`, `reverse: true` counts as reverse), first edition, and
for graded copies the slab (certification id, else company + grade), **and**
come from different origins. Three scans of one card are one origin: not a
duplicate.

Different exact slots prove separate copies: both locations must be
`<box>·<stack>·<position>` (non-empty box, integer stack and position),
trimmed and lowercased. The box cannot contain `·`. Same slots stay flagged;
missing locations and free-form labels never prove separation because
channels may name the same shelf differently. Flags are per row: only
other-origin rows not proven separate appear as its possible duplicates.

- Inventory board: a "Source" select, a "Possible duplicates" toggle, and a
  "Possible duplicate" tag whose tooltip names the other channels and their
  quantities.
- Scan Desk: a row about to list a copy the book already holds from another
  channel shows "Already listed from Card Rails (qty 1) · megaevoluzionietb·6·31"
  (up to two locations, then `+N more`; omitted when none exist). The Scan
  Desk assigns the new row's location itself, so a differing scan slot is
  not evidence of separate copies and the warning still applies. It never
  blocks the submit or changes its payload.

## Resolution (2026-11-01)

- Flag only. No merge and no import blocking; nothing is paused or deleted.
- Measured: the 15 rows flagged by the old rule are separate cards. Pokoin
  scanned stacks 1 to 3; Card Rails continued from 3 to 41. No slot was shared
  by one card across origins. Merging to the largest quantity would have
  removed 10 real copies; blocking at import would have refused them.
- With this rule, 0 of the 15,518 live listings are flagged (CardTrader 12,279,
  Card Rails 3,030, Pokoin 209). The CardTrader imports are on another seller
  account than the scanned rows, so they cannot overlap.
- Revisit if a flagged row ever turns out to be one physical card.
