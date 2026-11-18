# PRICE-06 — prices printed as bare PKN where the visitor's currency belongs

Run **PH-R036** · Change **PH-C023** · Refs **PRICE-06** · Lead **PH** · swept 2026-11-18
Worktree `pkn-display-sweep` (from `origin/main`), branch `pkn-display-sweep`. JavaScript only;
nothing Rust was built. Nothing pushed, no PR.

Owner (production, 2026-11-18), on MyPokoin → Live listings with the pricer chip on
**CardTrader**: the PRICE column read `29.33 DKK` while the column next to it,
**CARDTRADER MARKET**, read `63 PKN` with `ask 66 PKN` under it — on every row.
"wtf also here pkn". A moment earlier the same class of defect in the card graph's tooltip:
"that is against the specifics".

## 1. The MyPokoin market column — fixed

`market/src/inventory-price.js` produced the cell's two figures as pre-spelled PKN strings:
`inventoryMarketLabel` ended every PKN comp with `" PKN"`, and the CardTrader ask arrived on the
value as `askLabel: '240 PKN'`. `MarketCell` printed both.

- `marketAmountLabel(pkn, currency)` is the new print helper: it converts through
  `formatFiatFromPkn` — the formatter `formatSellerPrice` (the row's own Price cell) uses — and
  prints the stored unit only when the currency *is* PKN or when there is no rate to convert
  with (`market/src/inventory-price.js:103`).
- `inventoryMarketLabel(value, currency)` takes that currency (`market/src/inventory-price.js:187`).
  The TCGplayer branch still prints its own USD quotes: those are source USD figures that Pokoin
  never converts, `docs/PRICING.md` and `market/src/inventory-price.test.js:147` both say so.
- `inventoryMarketValue` now carries the ask as `askPkn`, the number, not a label
  (`market/src/inventory-price.js:172`). The net it returns stays `value` in PKN.
- `MarketCell` prints both figures with `props.currency`
  (`solid/src/components/inventory/InventoryBoard.jsx:124`), and the board is handed the very
  currency its Price cell prints in: `priceCurrency={sellerCurrency()}` beside
  `formatPrice={formatPrice}` (`solid/src/pages/Inventory.jsx:457`). Table, Stacks and Titles
  render the cell; the Grid tile shows the price alone, so it had nothing to convert.
- Unchanged on purpose: the sort reads `row.pricePkn` / the comp numbers, the pricer dry-run
  plans in PKN, and every PATCH/POST body sends `pricePkn`. Only printed text changed.
- The listing edit drawer already followed the rule: its "From the market" preset chips print
  through `presetPrice(row.pkn)` in the form's own unit switch
  (`solid/src/components/desk/ListingForm.jsx:991`, `:217`), and `= N PKN` on the line under the
  price field is that switch's bracketed companion. No change there.

For the owner's row, in DKK: `63 PKN` / `ask 66 PKN` → **`2.4 DKK` / `ask 2.48 DKK`**; with
currency PKN the same row still reads `63 PKN` / `ask 66 PKN`.

## 2. The sweep

Method: every `formatPkn(` / `formatPknNumber(` / `formatLocalFromPkn(` / `localAndPknFromPkn(` /
`visitorParts(` / `buyerParts(` / `buyerFormat(` / `formatSellerPrice(` / `formatAssetsValue(` /
`formatOrderMoney(` call site and every `…} PKN` literal in `solid/src` and `market/src`, comments
and test files excluded, taken at the branch base `ce1bc6ee` so the denominator is what shipped —
**203 hits in 54 files**. 24 of them are the formatters themselves (`market/src/pkn.js` 12,
`market/src/seller-currency.js` 8, `solid/src/stores/buyer.js` 4) and are not classifiable
surfaces: the brief says call them, do not change them, and PH-R035 owns the last of them.

**Counts over the 179 real sites** (+5 the pattern itself misses, named below):

| class | meaning | sites |
| --- | --- | --- |
| (a) | correct as it stands | **127** |
| (b) | wrong, fixed in this run | **31** |
| (c) | wrong, not fixed here | **20** |
| (o) | wrong or arguable, for the owner to decide | **6** |

### (b) Wrong, fixed here — 6 surfaces, 31 printed amounts

| surface | file:line | what it shows | now |
| --- | --- | --- | --- |
| MyPokoin market column | `market/src/inventory-price.js:103` `marketAmountLabel`, `:187` `inventoryMarketLabel`; `solid/src/components/inventory/InventoryBoard.jsx:129` and `:132` (the two render sites a `} PKN` pattern cannot see) | the comp and `ask …` under it | the Price cell's own pinned currency; PKN only when that is the currency |
| Collection history chart | `solid/src/components/dashboard/CollectionHistoryPanel.jsx` 8 sites (big figure, delta, legend, peak label, 3 table cells, summary aria-label) through `market/src/portfolio-history.js:214` `formatHistoryAmount`, `:220` `formatHistoryDelta`, `:616` `formatHistoryTip` (4 spellings) | "Your collection, last 30 days" and the hover day | the seller's display currency |
| Dashboard value tiles | `solid/src/components/dashboard/SellerDashboardView.jsx` 5 sites: mover chip, mover title, 1-DR header total, "Total asking", 1-DR value | the tiles' valuation line | `props.moverCurrency`, the same channel the movers tiles use |
| Sync review | `solid/src/pages/SyncReview.jsx:314`, `:375` | the CardTrader / Power Tools ask on each row | `formatSellerPrice(pkn, sellerCurrency())` |
| CardGTS board | `solid/src/pages/BuySell.jsx:64` + 6 sites (board price ×2 doors, own-listing chip and its title, the fill price, the history row) | what a buyer offers and what a fill sold at | `offerPriceLabel(pkn, buyerCurrency() \|\| 'PKN')`, the desk buy panel's own label |
| Artwork pile | `solid/src/components/ArtworkPile.jsx:147` | the price of the opened card | `buyerFormat`, the rule the tiles behind it follow |

`solid/src/pages/Inventory.jsx:457` is the 31st in the sense that it is the one line that hands the
board its `priceCurrency`; it prints nothing itself.

### (a) Correct as it stands — 127 sites

| family | sites | why PKN is the right print |
| --- | --- | --- |
| `solid/src/pages/Checkout.jsx` 16, `components/basket/Basket.jsx` 10 | 26 | a PKN-balance order is settled in PKN; the documented affordability rule and its brackets (`docs/MARKET.md:809`) |
| `solid/src/pages/Wallet.jsx` 13, `market/src/wallet-activity.js` 9, `market/src/money-requests.js` 1, `solid/src/pages/Messages.jsx` 5 | 28 | the wallet, its ledger and chat transfers move PKN itself — the amount *is* PKN, not a price |
| `solid/src/pages/Sales.jsx` 9, `market/src/order-rows.js` 6, `market/src/order-status.js` 2, `ZeroPicked.jsx` 1, `zero-bits.jsx` 1, `CardTraderOneDay.jsx` 2, `CardTraderZero.jsx` 1 | 22 | order money in the order's own currency; the PKN line is the companion to the EUR net |
| `solid/src/pages/Invite.jsx` 8, `Join.jsx` 1, `AmbassadorProgram.jsx` 1, `ambassador-program.js` 2, `SilverHead.jsx` 1, `ExtensionDownload.jsx` 1, `Buy.jsx` 3 | 17 | a fixed PKN reward / Silver price / PKN package: the product is denominated in PKN |
| `solid/src/components/desk/ListingForm.jsx` 6 | 6 | the price field already runs the form's own unit switch; `= N PKN` is its bracketed companion |
| `solid/src/pages/Profile.jsx` 4 | 4 | "Site PKN" metrics and the ledger, labelled with the unit they hold |
| `solid/src/components/CardTile.jsx` 2, `NavPreviews.jsx` 1, `Chrome.jsx` 1, `QuickSellDialog.jsx` 1, `ShopListing.jsx` 1, `desk/NativeSales.jsx` 2, `inventory/CollectionHoldings.jsx` 3 | 11 | already currency-aware (`visitorParts`/`buyerParts`/`formatSellerPrice`/`formatAssetsValue`) or a guard that never paints |
| `market/src/portfolio-movers.js` 3, `SegmentTable.jsx` 1, `SellerDashboardView.jsx:370` 1, `Exchange.jsx` 2, `buy-orders.js` 1, `portfolio-history.js:213` 1 | 9 | movers/segments follow the seller currency already; the site balance and the PKN↔wPKN asset codes are PKN by nature; `:213` is a percent, not money |
| `market/src/inventory-listings.js` 2 | 2 | `inventoryListingMeta` has no caller outside its own test, and there the PKN formatter is injected by the caller |

### (c) Wrong, not fixed here — 20 sites

| file:line | what it shows | why it stays |
| --- | --- | --- |
| `solid/src/pages/Card.jsx:897-903` (5) and `solid/src/components/desk/SoldPriceGraph.jsx:420` (1) | the desk graph tooltip / axis fallback | **PH-R035's boundary** — the brief names both files and forbids editing them or the formatter they call. These are the owner's original graph complaint. `origin/main` already carries the fix in `10a25aa5` "Card graph: … every row says the visitor's currency"; this worktree is 10 commits behind that merge, so it still shows the base text |
| `solid/src/pages/SiteMap.jsx:171,209,519,542,586,598,990` (9) | `/sitemap`: cheapest ask, medians, hover ask, comparison prose | a whole routed surface with 9 prints and no currency plumbing at all; it needs its own surface commit and a decision on whether the board is a market report (PKN by design) or a price list |
| `solid/src/pages/Portfolio.jsx:18` (1) | `/marketplace/portfolio` money() | same: no currency in scope; its lede says "in PKN" |
| `solid/src/pages/Explore.jsx:19` (1) | `/marketplace/explore` money() | its own header text says "the Pokoin catalog dump in PKN" — changing the unit means changing the stated purpose |
| `solid/src/pages/Signal.jsx:44` (1) | "Native asking" metric | a market-stats snapshot labelled "Native … PKN" in its own lede |
| `solid/src/pages/BuySell.jsx:427` (2) | `Price (PKN)` field + `Enter a price above 0 PKN.` | a *typed* amount, not a printed one: fixing it needs `offerPriceInput`/`offerPricePkn` plus a pending→resolved re-fill of the editor, which is a form behaviour change, not "calling the formatter". The field labels its own unit, so it never lies |

### (o) For the owner to decide — 6 sites

1. `market/src/inventory-price.js:141` and `:167` — the market cell's **hover text** still says
   "The other kind of seller asks 66 PKN" and "(ask 66 PKN)" while the cell itself now reads
   `2.48 DKK`. `docs/PRICING.md:98` documents that tooltip as naming both figures in PKN, so
   either the doc or the cell's prose is the one to change. Same for
   `market/src/listing-row-edit.js:137-141`, where `presetTitle` deliberately calls
   `marketAmountLabel(value.askPkn)` with the default PKN.
2. `market/src/buy-orders.js:434` — "Pokoin's starting offer: 50 PKN" is painted as the house
   offer title inside the sell dialog, which now shows every other figure in the visitor's
   currency. It is a constant (`HOUSE_OFFER_PKN`), so PKN may well be intended.
3. `solid/src/pages/Associate.jsx:61` and `:379` — the associate hero headline reads
   "1.5 PKN + €0.32": two payouts in two real units, but the PKN half is what a DKK reader would
   expect converted. Worth one deliberate answer rather than a sweep.

## 3. Is the rule written down?

Partly, and never as one rule. What `docs/` actually says:

- `docs/MARKET.md:837`, in "Segment graphs": *"Amounts follow the seller's display currency, like
  the movers tiles."* — the seller-side rule, stated for the Dashboard segment table and the
  movers tiles only. Nothing extends it to the MyPokoin board.
- `docs/MARKET.md:809` "Buyer display currency (affordability threshold)": *"Buyers see prices in
  PKN while their balance can afford them, and local-currency-first (DKK for a Danish buyer, from
  the profile country; browser locale only as fallback) once it cannot … Settlement stays PKN; the
  cart/checkout display keeps the PKN value in brackets (`formatLocalFromPkn`)."* — the buyer-side
  rule, and the brackets exception, but it is an affordability rule, not "always the visitor's
  currency".
- `docs/SCAN_LISTING_WORKFLOW.md:134`: *"Price | Seller's local currency (stored in PKN)"*.
- `docs/BUYSELL.md:93`: *"the price field is in the visitor's display currency
  (`buyerCurrency(pinned)`: the `?currency=` pin, else the account country's), labelled
  'Price (DKK)'"*, and `docs/BUYSELL.md:96`: *"a PKN display currency shows PKN."*
- `docs/MARKET.md:637`, on marketplace tiles: *"Tiles show `formatPkn` (2642 PKN, no thousands
  comma)"* — a bare-PKN instruction, and stale: `solid/src/components/CardTile.jsx:57` paints
  `visitorParts`/`buyerParts` (local first) today.
- `docs/PRICING.md:98`: *"The board's tooltip names both."* — the market column's hover text is
  documented as carrying the net and the ask, in PKN. Nothing documents what unit the *cell*
  prints.

So: **no document states the general rule the owner described** — "a price shown to a person is in
their currency, PKN is the internal unit and appears only in brackets or when their currency is
PKN". It exists in code comments (`solid/src/components/pricer/pricer-ui.js:303` "Pricer money:
stored PKN shown in the seller's currency, never PKN", `market/src/seller-currency.js:1-4`) and in
locked decision D000014 (digits, not the unit), but not in `docs/`. The MyPokoin market column had
no stated display unit at all, which is how it shipped `63 PKN` next to `29.33 DKK`.

Nothing in `docs/` was edited: the brief asked whether the rule is written down, not for a doc
change. If the owner wants the rule to bind the next surface, one paragraph in `docs/MARKET.md`
before the "Buyer display currency" section covers it, and `docs/MARKET.md:637` (tiles in
`formatPkn`) needs to be retired at the same time — it currently instructs the opposite of the rule.

## 4. Commits

Six surfaces, one commit each, all on `pkn-display-sweep`, none pushed, no PR. Each carries
`Lead: PH`, `Run: PH-R036`, `Change: PH-C023`, `Fixes: PRICE-06`; the hook's secret scan reported
no leaks on every one of them.

| commit | surface |
| --- | --- |
| `66fdffce` | MyPokoin market column prints the seller's currency, not PKN |
| `247bb930` | Collection history prints the seller's currency, not PKN |
| `ea6c8e22` | Dashboard value tiles print the seller's currency, not PKN |
| `68080ec9` | Sync review prints the stored ask in the seller currency |
| `d16f8d1b` | CardGTS board prices read in the visitor's currency |
| `e18051ab` | The artwork pile prices like the tiles it opened from |

Code: 19 files, +303/−60 against the merge base `ce1bc6ee`. `docs/FEATURES.toml` and this report
are the seventh commit (`money` flags unchanged; the flows that carry these surfaces gained the
files and the proofs: `listing-edit-stock`, `cardtrader-connect`, `dashboard-segment-graphs`,
`cheapest-price-stamps`; `buy-orders` and `collection-portfolio` already listed their proofs).

Nothing about a *value* changed: every stored, sorted, POSTed and PATCHed amount is still PKN
(`value`, `askPkn`, `pricePkn`, `pricePkn` in bodies). Only printed text changed.

## 5. Checks

Both commands from the brief, run in this worktree with `TMPDIR=$HOME/scratch/tmp`:

```
$ scripts/js-run-group.sh market        # exactly the market line of scripts/js-test-groups.txt
1..1964
# tests 2018
# suites 0
# pass 2018
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 26814.894249

$ cd solid && npm test                  # the solid line of the same inventory
1..420
# tests 420
# suites 0
# pass 419
# fail 1
```

The one failure is pre-existing and unrelated: `src/lib/effects-shape.test.js` dies with
`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@babel/parser'` because this worktree has no
`node_modules` installed. `npm ci` was deliberately not run — `solid/node_modules/` is not
gitignored, and dropping it in a shared worktree is exactly the litter `AGENTS.md` forbids.

`scripts/check-features.sh` — exit 0, 59 flows, 32 money flows, 1 money flow unproved.
`scripts/check-fast` — SKIPPED: this run edits JavaScript only and built no Rust, so the
`pokoin-rust/` fast gate has nothing to check.

## 6. Assertions replaced

Four assertions pinned a bare-PKN string this run changed on purpose. Nothing else in any test was
edited, deleted or skipped.

| file:line | was | now | why |
| --- | --- | --- | --- |
| `market/src/inventory-price.test.js:119` | `assert.equal(value.askLabel, '240 PKN', 'the ask shows under the net in the cell')` | `assert.equal(value.askPkn, 240, '… in the cell currency')` | the value object no longer pre-spells a label: spelling is the cell's job and needs its currency |
| `market/src/inventory-price.test.js:121` | `assert.equal(plain.askLabel, '')` | `assert.equal(plain.askPkn, null)` | same field change on the no-ask row |
| `solid/src/pages/SellerHome.test.js:153` | `assert.match(viewSrc, /<CardTraderAssetsPanel assets=\{assets\(\)\} \/>/)` | `… assets=\{assets\(\)\} currency=\{props\.moverCurrency\} \/>` | it pins the call shape, and the fix necessarily adds the currency prop the panel's amounts now need |
| `solid/src/pages/BuySell.test.js:134` | `assert.match(facts, /<TagGlyph \/>\{formatPknNumber\(item\(\)\.my_price_pkn\)\}/)` | `assert.match(facts, /<TagGlyph \/>\{priceLabel\(item\(\)\.my_price_pkn\)\}/)` | it pinned the bare-PKN printer by name in the own-listing chip |

New proofs, in the style of the file each sits in:
`solid/src/components/inventory/market-cell.test.js`, `solid/src/components/dashboard/collection-history-currency.test.js`,
`solid/src/components/dashboard/dashboard-amount-currency.test.js`, `solid/src/pages/SyncReview.test.js`
(4 new files) plus new tests inside `market/src/inventory-price.test.js`,
`market/src/portfolio-history.test.js`, `solid/src/pages/BuySell.test.js`, `solid/src/components/tiles.test.js`.
Each one either calls the label helper with a DKK rate (63 PKN → `2.4 DKK`, 66 PKN → `2.48 DKK`,
and `63 PKN` / `66 PKN` when the currency is PKN) or pins the formatter call at every painted site.

## 7. What this could not verify

No dev server and no browser: `solid/node_modules` is absent in this worktree, so nothing was
rendered or clicked. Everything here is helper output and source-text proof. Two consequences the
owner should know before merging:

1. **The DKK numbers are arithmetic, not observation.** `2.4 DKK` for 63 PKN follows
   `market/src/seller-currency.js` and the EUR-cent rounding documented in `docs/MARKET.md`; no
   pixel confirms it.
2. **The `buysell-fact` chip got wider.** `d16f8d1b` puts a currency code inside the CardGTS row's
   price chip (`2.4 DKK` where `63 PKN` was). `.buysell-fact` has no fixed width, but a phone row
   that now wraps would not show up in any test here.

