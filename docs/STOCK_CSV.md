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

### CardTrader sync popup

1. Upload Power Tools CSV(s) per TCG — no location guesses yet.
2. **Analyze CSV** — the API reads the seller’s location column, detects the style
   (`as_is` / trailing stack index / already `box·stack`), and proposes cards-per-stack
   from how many rows share each box·stack.
3. Confirm mapping using **examples from that CSV**, then full import.

| Mode | Behaviour |
| --- | --- |
| **Location is the box name** | Keep the CSV string as the box label |
| **Last number is the stack index** | e.g. trailing ` - 16` → stack **#16** (which divider). Not card count. |
| **Already box·stack** | Parse existing `·` / `#` structured slots |

**Cards per stack (capacity)** is proposed from the fullest box·stack in the uploaded file.

### Inventory CSV import (legacy)

On `/inventory` import, Pokoin still applies **stack size** (default 1):

- **Size 1** — each row in a box becomes `box·N` (N = order in file).
- **Size &gt; 1** — rows fill `box·stack·pos`, spilling to the next stack when full.

Structured strings already using `·` (`box·2·5`) are kept.

Bare names like `FUOCOBOMBA 006 - 16` stay the box name (not parsed as stack/position) unless the sync popup uses “Last number is the stack index”.

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
