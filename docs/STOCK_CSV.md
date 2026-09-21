# Stock CSV import / export

Seller stock on `/inventory` can export and import CSV in three formats:

| Format | Header anchor | External id |
| --- | --- | --- |
| **PowerTools** | `cardmarketId`, `finishType`, `location` | `cardmarketId` |
| **Cardmarket** | `idProduct`, `expansion`, `isFoil` | `idProduct` |
| **CardTrader** | `blueprint_id`, `price_cents` | `product_id` or `blueprint_id` |

API (CardVault): `GET/POST /api/marketplace-listings-csv` (bearer required).

## PowerTools location → stack / position

PowerTools stores the physical slot in the **`location`** string (no separate Position column).

On import, Pokoin applies **stack size** (default 1):

- **Size 1** — each row in a box becomes `box·N` (N = order in file). Position UI stays hidden; no stack-full flash.
- **Size &gt; 1** — rows fill `box·stack·pos`, spilling to the next stack when full.

Structured strings already using `·` (`box·2·5`) are kept.

Bare names like `FUOCOBOMBA 006 - 16` stay the box name (not parsed as stack/position).

## Price

- `eur_to_pkn` (default): EUR × **200** → PKN (same ratio as CardTrader inventory sync).
- `as_pkn`: values are already PKN.
- CardTrader `price_cents`: treated as EUR cents × 200.

## Card resolution

1. Name + collector number against `marketplace_cards` (ignores Poké Ball / Master Ball set twins unless needed).
2. Ambiguous / missing → failed row (downloadable CSV with `importError`).
3. Successful imports set `source` + `source_listing_id` for idempotent re-import.

## Condition map (CM/PT → Pokoin)

`MT/NM→NM`, `EX→SP`, `GD/LP→MP`, `PL/HP→PL`, `PO→Poor`.
