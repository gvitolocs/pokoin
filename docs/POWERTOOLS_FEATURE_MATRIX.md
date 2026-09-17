# PowerTools feature matrix (seller listing and inventory)

TCG PowerTools mapped against Pokoin, from the local mirror only:
`candyext/dump/` (captured 2026-09-17). Verified sources, in order of trust:

| Source | What it proves |
| --- | --- |
| `site/new.tcgpowertools.com/static/js/main.1fff971d.chunk.js` | Game config (`idGame`, `cardExtraAttribute`, `finishType`, `countryEdition`), hotkey JSON modules 944–958, key handlers, `getIdentityKeyFromFields`, template defaults, i18n (`en` strings) |
| `kb_articles.json` (41 support articles) | Documented workflows |
| `api_manifest.json` | Routes and endpoints actually called |
| `shots/new.tcgpowertools.com/*.png` | Layout |

Nothing here comes from screenshots alone or from memory of the live site.
Pokoin columns cite pokoin-web / CardVault paths. Audit:
[SCAN_SYSTEM_AUDIT.md](SCAN_SYSTEM_AUDIT.md). Shortcuts:
[KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md).

## Inventory identity (verified)

`getIdentityKeyFromFields` in the main bundle joins:

```
condition | idLanguage | finishType | isSigned | isFirstEd | countryEdition | gradingCompany | grade
```

and the "same article" comparator adds `card._id` (the printing). **Location
is not in the key**: an article carries `locations: [{ name, quantity,
deltaQuantity, totalPickedQuantity, totalQuantityWithIssues }]`, so one
identity can be split across boxes. The add-article template also carries
`isPlayset`, `isAltered`, `comment`, `location`, `quantity`, `price`,
`buyPrice`, `taxationScheme` — none of those are identity.

Per game (Pokémon block of the config):

| Dimension | Pokémon in PowerTools | Pokoin today |
| --- | --- | --- |
| Condition | `MT NM EX GD LP PL PO` (Cardmarket scale) | `NM SP MP PL Poor` |
| Language | 18 `CardLanguage` values; Pokémon hotkeys bind 15 | 16 codes in `Card.jsx LIST_LANGS`, filtered by expansion nationality |
| Finish type | `Regular`, `ReverseHolo`, `StampedHolo`, `IceCrackedHolo`, `CosmosHolo`, `MasterballHolo`, `PokeballHolo` and the `Reverse*` of each | `foil_state`: `standard holo reverse stamped promo other` (+ `reverse` bool) |
| Extras | `FirstEd`, `Signed`, `Playset` | `first_edition`, `signed` (column only), no playset |
| Country edition | **empty list for Pokémon** (only Yu-Gi-Oh! has `US`) | none |
| Grading | `gradingCompany` + `grade` | `graded`, `grading_company`, `grade`, `certification_id` |
| Altered | template field only, not identity, no Pokémon hotkey | none |

So "country edition" is not a Pokémon dimension in PowerTools, and
"version" is not a PowerTools concept at all: the printing is the Cardmarket
product (`card._id`), everything else is the identity key above.

## Matrix

Columns: **PT behaviour** is what the bundle/KB does. **Status**: ✅ exists,
🟡 partial, ❌ missing. **Scan** = relevant to this scanning/listing PR.

### Adding articles

| PowerTools feature | PT behaviour | Pokoin equivalent | Status | Scan | Implementation location | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Single card mode | Type a name (also `SET 069`, `069 name`, set + name), arrows + Enter pick, hotkeys set attributes, digits = quantity, Enter/Space create | Card desk **List your card**, one card per page | 🟡 | Yes | `market/src/pages/Card.jsx` `ListingForm` → scan queue manual add | Scan queue row "Replace printing" search reuses `/api/marketplace-suggest` |
| By expansion | Walk a sorted expansion; Enter creates and advances, **B** skips, **V** goes back, jump-to by number | none | ❌ | Partly | follow-up | Scan Connect replaces this for piles; the ‹ › set walk on the desk is browse only |
| Bulk (whole expansion × quantity per rarity) | One click adds every card of a set using the template | none | ❌ | No | follow-up | |
| Import a file | CSV/XLS/XLSX/ODS; required Quantity + an id or name/number/expansion; missing language/condition default EN/NM; failed rows downloadable | none | ❌ | No | follow-up | |
| Template | Default values prefilled for every new article | none (desk resets to NM + nationality language) | ❌ | **Yes** | **Batch Defaults Bar** ([SCAN_LISTING_WORKFLOW.md](SCAN_LISTING_WORKFLOW.md#batch-defaults)) | PT template is not snapshotted per article history; Pokoin snapshots per scan |
| Create & copy (**C**) | Adds the article and keeps it selected to add another identity of the same card | none | ❌ | **Yes** | scan queue `duplicate row` | Same card, different condition/language |
| Listing tabs | Staging tabs ("Tab 1 · Singles n · Acc. n"), rename, merge, close deletes items, link to purchase | none — listings go live on POST | ❌ | **Yes** | **Scan Batch** (`scan_batches`) | Pokoin persists server-side; PT tabs are client state until SAVE |
| Save / Publish | Review changes, checkbox "I have reviewed…", push to channels, spinner gear, transaction table | none | ❌ | **Yes** | `POST /api/scan-batch?action=submit` | Idempotent; PT errors per article become per-row results |
| Similar articles in your stock | While adding, list same/similar stock; prefill price/comment | none | ❌ | Useful | follow-up | v1 shows nothing; see follow-ups |
| Daily publish limit (free tier) | 50/100 new articles/day | n/a | — | No | — | Billing |

### Editing inventory

| PowerTools feature | PT behaviour | Pokoin equivalent | Status | Scan | Implementation location | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Edit panel (pencil) | Qty, Change q.ty (delta), language, condition, country edition, signed, first ed, location, Reset / **Add new card** / Reset all / Confirm | `PATCH /api/marketplace-listings` exists; `/inventory` is read-only | 🟡 | Row edit only | scan queue inline cells | Inventory page editing is a follow-up |
| Set quantity (bulk) | Select → type qty → Enter; 0 deletes | `PATCH quantityAvailable` one at a time | 🟡 | No | follow-up | |
| Set price (bulk, number or %) | Select → value or % → Enter | `PATCH pricePkn` one at a time | 🟡 | No | follow-up | |
| Set comment (bulk, `+` appends) | | `PATCH sellerComment` | 🟡 | No | follow-up | |
| Set condition (bulk) | | `PATCH condition` | 🟡 | No | follow-up | |
| Set location (bulk) | Select → type location → Save | none | ❌ | **Yes** (per scan) | Batch Defaults `location`, row cell | Bulk set-location on inventory is a follow-up |
| Selection | Click, Shift+Click range, Select results (+ filters) | none | ❌ | Partial | scan queue: arrow/`v` `b` focus, Shift+Click range for bulk row edits | |
| Filters | Name, location, comment (`""`, `!`, `;`, multiline OR), expansion, condition, rarity, qty, language, price range, foil/signed/playset/bulk/selected/reverse/first ed/graded/US edition/failed pricing/edited | none on `/inventory` | ❌ | No | follow-up | Comment-search grammar is verified in the KB |
| Delete | Set quantity 0 | `PATCH status inactive` (`cancelListing`) | ✅ | Row delete only | — | |
| Undo / discard changes | Discard selected edits before Save | none | ❌ | **Yes** | scan queue undo stack | |
| Grading | Company + grade (max 10.0) | `graded` + company + grade + cert | ✅ | Row cell | — | Pokoin requires a cert id |
| Inventory transactions | Per-channel quantity/price/reservation/tax transactions, errors (wrong attributes, cart lock, min price…) | none | ❌ | No | follow-up | Needed for multi-channel sync |
| Unique articles / tabs Your Stock, Edited, Failed autopricing… | Views over stock | none | ❌ | No | follow-up | |

### Identification and printing

| PowerTools feature | PT behaviour | Pokoin equivalent | Status | Scan | Implementation location | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Card identification | **Typed search only.** No camera, no `getUserMedia`, no scanner code in the bundle | BattleScan camera identify + `/scan` upload | ✅ (Pokoin ahead) | **Yes** | BattleScan `web/index.html`, `server/app.py` | |
| Search language (EN/DE/IT/FR/ES names) | Switch search language | `marketplace-suggest` with localized names | ✅ | Yes (manual replace) | `market/src/suggest-rank.js` | |
| Printing selection | Choose the Cardmarket product in the search list | Desk rarity `<select>`, set-symbol circles, versions page | 🟡 | **Yes** | scan row candidates + `marketplace-version-set` | No modal |
| Other finish types (Pokémon) | `<select>` of Stamped / Ice-cracked / Cosmos / Masterball / Pokéball holo and reverses; Regular + Reverse via hotkey | `foil_state` six values, no Poké Ball / Master Ball / Cosmos | 🟡 | **Yes** | row finish cell uses Pokoin values | Adding PT's finish list to `foil_state` is a follow-up; `variant_state` exists unused |

### Pricing (separate domain)

| PowerTools feature | PT behaviour | Pokoin equivalent | Status | Scan | Notes |
| --- | --- | --- | --- | --- | --- |
| Price Suggest | 5 cheapest competitors' offers, same-language filter | Desk Best Deal, sold median (`marketplace-card-sales`) | 🟡 | Prefill only | Scan rows prefill last-day median PKN when present |
| Autoprice (Price Guide: Trend/AVG1/7/30 ± cents/%) | | none | ❌ | No | follow-up |
| Competition strategy (1st–9th or % cheapest; NM↔EX, playset, strict language) | | none | ❌ | No | follow-up |
| Competitors (seller type, countries, reputation, min sales, ignore list) | | none | ❌ | No | follow-up |
| Minimum prices by rarity | | none | ❌ | No | follow-up |
| Pricing bot (rules: printing, expansion, language, price guide, extras, condition, comment, quantity, rarity, your price → strategy/ignore) | | none | ❌ | No | follow-up |
| Failed pricing filter | | none | ❌ | No | follow-up |

### Orders, picking, channels, accounting (separate domains)

| PowerTools feature | PT behaviour | Pokoin equivalent | Status | Scan | Notes |
| --- | --- | --- | --- | --- | --- |
| Orders list, search, CSV | Cardmarket orders | `/orders` (Firestore, escrow) | 🟡 | No | |
| Picking list | Picked / Checked / Packed, **Smart locations**, show empty locations, issues (missing, wrong condition/language/foil/1st ed) | none | ❌ | No | **Depends on Location** (this PR adds the column) |
| Relisting | Relist after cancellations | none | ❌ | No | |
| Channels | Cardmarket, CardTrader (OAuth), Shopify, eBay, Amazon; ActionCable live sync | CardTrader token connect + snapshots | 🟡 | No | |
| Taxation, purchases (buy price, margin scheme), exports | | none | ❌ | No | |
| Export stock CSV | Entire stock or selected | none | ❌ | No | follow-up |

## Implemented in the Scan Connect PR

Template → Batch Defaults · listing tabs → Scan Batch · Save/Publish →
idempotent submit · create & copy → duplicate row · hotkeys (condition,
language, reverse, first edition, signed, confirm, delete, prev/next) ·
location per article · signed and altered in the listing form path ·
undo in the queue · camera identification (Pokoin-only).

## Follow-up tasks

Each is a separate PR; none blocks scanning.

| # | Task | Depends on |
| --- | --- | --- |
| 1 | **Security:** `POST /api/marketplace-listings?action=decrement` must check the caller owns the listing or is the checkout service (CardVault `api/marketplace-listings.js` `decrementListing`) | — |
| 2 | Inventory page editing: inline qty/price/condition/comment/location, Shift+Click selection, bulk Set … actions | Location column |
| 3 | Inventory filters incl. PT comment-search grammar | 2 |
| 4 | "Similar articles in your stock" while scanning; merge a submitted row into an identical existing stack | Identity key helper from this PR |
| 5 | Location breakdown per stack (`locations[]` with per-location qty) and picking list with smart locations | Location column, orders |
| 6 | Pokémon finish list parity (Poké Ball / Master Ball / Cosmos / Ice-cracked, stamped reverse) in `foil_state` or `variant_state` | catalog decision on CardTrader separate reverse blueprints |
| 7 | CSV import/export of stock | 2 |
| 8 | By-expansion listing mode (Enter / B / V walk) | — |
| 9 | Pricing: price guide strategies, competitors, minimum prices, bot | sold series, CardTrader asks |
| 10 | Channel sync (CardTrader push of a submitted batch, transactions table) | CardTrader integration |
