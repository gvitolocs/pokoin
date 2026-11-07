# Pokoin's CardTrader reference price

Since 2026-10-15 every place that prices a card from CardTrader uses one rule
(`pokoin-rust/crates/external/src/price_check.rs`, `pro_floor_sql`):

> the cheapest **current** offer of a **professional** CardTrader seller
> (`seller_type = 'pro'`) of the **same printing**, with the same
> **condition**, **language**, **reverse** and **first edition**.

- Offers come from `cardtrader_market_listing_snapshots` (the complete daily
  book). Offers not seen in the last 3 days, sellers on vacation
  (`cardtrader_seller_vacation.on_vacation`) and graded, signed or altered
  copies do not count. A graded, signed or altered listing has no CardTrader
  price.
- Private (`normal`) sellers do not count: their one-off asks undercut the
  market and made every comp too low.
- No fallback to another facet. A reverse holo is never priced from the plain
  copy (card 128540: NM EN 64 PKN, NM EN reverse 590 PKN), a first edition
  never from the unlimited one. No matching professional offer means no
  CardTrader price.
- Pokoin conditions map to CardTrader's: NM → NM, LP/SP → Slightly Played,
  MP → Moderately Played, HP/PL → Played, PO/Poor → Poor
  (`condition_key`, mirrored by `pricerCondition` in
  `market/src/inventory-price.js`). Before, LP, HP and PO matched nothing and
  were priced from offers of any condition.

Where it is used:

- `GET /api/marketplace-price-check` (`ctMatchedPkn`, `ctBasis: "pro"`). Items
  are `card:CONDITION:LANGUAGE[:FLAGS]` with flags `R` (reverse), `F` (first
  edition), `H` (foil), `G` (graded), `S` (signed) and `A` (altered); each
  comp is also returned under that key so two copies of one card never share
  a comp.
- MyPokoin board market column, pricing strategies with the CardTrader source,
  the collection's suggested asks, and the card desk's suggested price (the
  sold graph only fills in when no professional offer exists).

## Net of CardTrader's commission (2026-10-21)

A CardTrader ask (`price_cents` in `/marketplace/products`, the listing books
and the PKP3 file) is the price the seller set. CardTrader adds the buyer's
Safeguard fee on top (€0.09–€0.64 per item) and takes its commission, plus VAT
on it, from the seller. Every CardTrader figure Pokoin shows or prices from is
what the seller **nets** (`pokoin-rust/crates/external/src/ct_fees.rs`):

```text
fee = max(1 cent, ask × rate)    rate: 5 % direct (Pokémon pro floor, sold medians, tile minimum)
                                       7 % CardTrader Zero (the other games' price file)
net = ask − fee × (1 + 22 % VAT)
```

A connected seller's own sales use their own rate from CardTrader's full
table (`ct_fees::Tier`, `Channel::Plan`): EU direct / Zero 5.0 / 7.0 % for
subscriptions before March 2026 (kept by active sellers until 2026-12-31),
5.3 / 7.3 % from March 2026; outside the EU 6 / 8 % (7 / 10 %); 1-Day Ready
16.5 %. The country and Zero status come from the seller's own offers in the market
book (`country_code`, `can_sell_via_hub`). VAT on the commission is per seller
(`ct_fees::vat_of`): a private EU seller pays their own country's rate (a
Danish one: 25 %); a VAT-registered business pays none outside Italy (reverse
charge) and 22 % in Italy (a domestic sale); outside the EU, none. Whether a
seller is a VAT-registered business is only the integration's
`metadata.vatRegistered` (`seller_integrations/{uid}__cardtrader`), set when the
seller confirms it; unset is private, the costlier case. On 2026-10-22 PeppeV /
Flareon99 (Denmark) confirmed a VAT-registered business: 5 % direct, no VAT.
redshakkio (Italy) pays 22 % either way.

```bash
# on the Pi, with the API's environment: show the plan, then set the flag
/srv/pokoin/rust/current job cardtrader-fee-profile --seller=<uid>
/srv/pokoin/rust/current job cardtrader-fee-profile --seller=<uid> --vat-registered=true --apply
```

An unknown country is
priced, at each price, at the worse of outside the EU (7 / 10 %, no VAT) and
the EU at 27 % VAT (Hungary): on the 1-cent minimum the VAT costs more (a
14 c ask nets 12.73 c, Denmark's 5 % + 25 % nets 12.75 c), on dearer cards
the outside-EU rate does. The gross-up is the larger of the two asks. The
subscription date
comes from the integration's `metadata.feeEra` (`before-2026-03`), else
`CARDTRADER_FEE_ERA`, else the current, higher rate. CardTrader shows no
account date anywhere Pokoin reads, so this is set when the seller confirms
it. Below €0.19 direct (€0.14 Zero) the 1-cent minimum applies at every EU
rate, so the tier changes nothing on cheap cards.

Rates from CardTrader's "Payments, fees and refunds" page
(static.cardtrader.com/en/pages/payments-fees-and-refunds, 2026-10-21): EU
sellers 5.0 % direct / 7.0 % Zero, minimum 1 cent, VAT added, for
subscriptions before March 2026 (guaranteed to active sellers until
2026-12-31); 5.3 % / 7.3 % after; extra-EU 6/8 % (7/10 %); 1-Day Ready 16.5 %.
`CARDTRADER_FEE_DIRECT_PCT`, `CARDTRADER_FEE_ZERO_PCT` and
`CARDTRADER_FEE_VAT_PCT` change them. Example: a €0.11 Zero ask (22 PKN) nets
€0.0978 (the 1-cent minimum plus VAT), shown as 20 PKN.

- The price check returns the net as `ctMatchedPkn` / `ctCheapestPkn` /
  `soldMedianPkn`, the asks as `ctMatchedGrossPkn` / `ctCheapestGrossPkn` /
  `soldMedianGrossPkn`, and the rule as `ctFee`. The board's tooltip names both.
- The price store keeps the asks; the commission is taken at read time, so a
  rate change needs no refill.
- The Seller API quote (Card Rails), `job price-unpriced-listings` and
  `job cardtrader-pro-floor-reprice` price Pokoin at the net. The reprice job
  still sets a linked CardTrader product to the floor itself, so the seller's
  CardTrader ask is not cut by the commission.
- A connected seller's own CardTrader products: the reconcile gives an import
  or a link the product's ask net of the commission the seller pays
  (`ct_fees::resolve_seller_channel`: 7 % for an account that can sell
  through CardTrader Zero, 5 % otherwise. The stored `/info` user has no such
  flag, so it is read from `can_sell_via_hub` on the seller's own offers in
  the market book; unknown is 7 %. On 2026-10-21 redshakkio, CardTrader user
  180405, was Zero-enabled and PeppeV, 595699, was not). Listings linked before this change are set once with
  `pokoin-api job cardtrader-net-prices --seller=<uid> [--csv=…] [--apply]`: one
  `/products/export` read, the target always computed from the CardTrader
  ask (a rerun changes nothing), compare-and-set per listing, nothing
  written to CardTrader. Only the seller's own products (`import`, `match`);
  `--origin=push` does the products Pokoin pushed instead: they keep their
  CardTrader ask and Pokoin takes its net (PeppeV, 2026-10-22: Spiderling
  stays €0.13 on CardTrader, 5 % without VAT, Pokoin 24 PKN).

## Writing to CardTrader: the fee once (2026-10-21)

A Pokoin price is already net, so it is never the CardTrader ask. Every
write to CardTrader (the push of a new product, an edit from the listing
outbox, the re-send after a create, `cardtrader-fee-once`) lists the
**gross-up**: the smallest whole-cent ask whose net, rounded to whole PKN,
is at least the Pokoin price, at the seller's own rate
(`FeeRule::gross_cents`; the channel is resolved once per push and stored on
the listing as `ctChannel`). Before this, the push listed the net as the ask
and CardTrader took its fee a second time.

Worked row, Spiderling, PeppeV (direct, 5 %), Pokoin 26 PKN:

| | cents | PKN |
| --- | --- | --- |
| CardTrader ask (gross-up) | 14 | 28 |
| commission: max(1 c, 5 % × 14 c) = 1 c, + 22 % VAT | 1.22 | 2.44 |
| the seller nets | 12.78 | 25.56 → 26 |
| the buyer pays: ask + Safeguard (€0.09 up to €0.25) | 23 | 46 |

Listing €0.13 instead (the old push) nets 11.78 c = 24 PKN: 2 PKN short.

- The board shows the net with the ask under it (`ask 28`) when they differ.
- The price check, the Seller API quote and the Card Rails price check net a
  connected seller's comps at the seller's own channel (5 % or 7 %);
  everyone else sees the 5 % pro floor and the 7 % Zero file as before.
- A Pokoin reprice while a CardTrader create is in flight is caught after
  the create links: the repriced copy leaves the product and the next
  reconcile pushes it at its new price (`detachedAfterPush` in the reconcile
  summary), so the stale ask of the create does not stay on CardTrader.
- Products listed before the fix are raised once:
  `pokoin-api job cardtrader-fee-once --seller=<uid> [--csv=…] [--apply]`.
  One `/products/export` read; each active linked listing whose ask does not
  net its Pokoin price is raised to the gross-up (never lowered; at most 5
  PUTs a second, stops at a 429). A rerun changes nothing.
- The integer core (PKN, basis points, 10⁻⁸ PKN) is proved with Verus:
  `pokoin-rust/verus/README.md`.

## The Pricer (MyPokoin → Pricer, rebuilt 2026-11-04)

The seller picks listings into **pricing groups**, and each group is priced
by one **named strategy**.

- **Strategies** (`users/{uid}.pricingStrategies`, at most 50) are named
  rules for *how* to price. They have no scope. Names are required and unique
  per seller, ignoring case. The fields are:
  - **Source and basis**: CardTrader (current offers, or the 30-day sold
    median), Pokoin (the cheapest Pokoin ask, or Pokoin's own 90-day sold
    median), Cardmarket (its price guide: trend, lowest ask, 1/7/30-day
    averages) or TCGplayer (market, lowest listing, mid, in USD converted at
    the day's ECB rate). See "Price sources" below.
  - **Switches**: same condition, language, finish, 1st edition, and "All
    exact". Only the switches the source's data can honour count; the rest
    are greyed out and stay saved. **Fee-exclusive** (on by default) prices
    from what the seller nets on CardTrader; off, it prices from the
    CardTrader ask. Only CardTrader numbers have fees.
  - **Action**: match, undercut or above, by % and by a fixed PKN amount.
  - **Rounding**: exact (cents), nearest, down or up to whole PKN.
  - **Never below**: a minimum that rounding never goes under. A target at or
    below 0 is skipped.
  - **Put paused listings on sale** when they get a price.

  A strategy that a group uses can't be deleted (409 `strategy_in_use`).
- **Pricing groups** (Postgres `seller_pricing_groups` and
  `seller_pricing_group_members`, `scripts/sql/138_seller_pricing_groups.sql`,
  at most 200) are named sets of listings picked on the Listings board, with
  "Add to group" on the selection bar. A listing is in at most one group:
  adding it to another group moves it, and deleting the listing takes it out.
  A group has one strategy and an optional **Reprice every day** switch.
- **Apply** (`POST /api/marketplace-pricing-groups/apply`, with `dryRun` for
  the plan shown first) prices the group's live and paused listings:
  1. It reads the same market comps as the board's price check, net of the
     seller's own CardTrader commission.
  2. It plans each listing: the comp, the strategy's target, and whether the
     listing goes on sale. Listings with no comp are counted, never guessed;
     sold-out and removed listings are skipped.
  3. It writes each change through the seller's own listing update, so a
     CardTrader-linked listing reaches CardTrader through the outbox edit at
     the gross-up.

  The group keeps a summary of its last apply (`last_applied`, with a trigger
  of `apply`, `daily` or `batch`).
- **Daily**: `pokoin-api job pricing-groups-daily [--dry-run]`
  (`deploy/systemd/pokoin-rust-job-pricing-groups-daily.timer`, 05:15 UTC,
  after the 04:30 price-store refill) applies every group with the daily
  switch on, oldest apply first. It writes by default. A failing group is
  counted and the run goes on.
- **One rule, three places**: `market/src/pricer.js` (web, tests in
  `pricer.test.js`), `crates/external/src/pricing.rs` (server) and the
  rounding-and-floor core `ct_fees::floor_price_rounded`, which Verus proves
  never goes under the minimum in any rounding mode
  (`pokoin-rust/verus/README.md`). The web uses the same fixed-point
  arithmetic, and both test files use the same examples.
- **Migration**: on the first read after the deploy, a strategy saved with a
  scope (game, live/paused, condition, language) becomes a group of the same
  name, holding the listings that scope took at that moment. A strategy
  without a scope keeps its rule and gets no group. Names that clashed get a
  " (2)" suffix.

Routes: `GET/POST/DELETE /api/marketplace-pricing-strategies` (strategies,
groups and board defaults), `GET/POST/DELETE /api/marketplace-pricing-groups`
(groups and moves: `{ group }`, `{ groupId, add }`, `{ remove }`), and
`POST /api/marketplace-pricing-groups/apply`. Card Rails picks a group or a
strategy per batch through the connector (docs/SELLER_API.md, "Batch
pricing").

### Price sources (2026-11-07)

Every price-check comp carries a `sources` block next to the CardTrader
offers (`ctMatch`). Each entry is keyed by the switches the source honours
(`price_check::Match::key`, letters C L F E; `""` = any copy) and holds
`grossPkn` and `pkn` (net of fees for CardTrader, equal otherwise). A feed
that fails, is not configured or is stale is left out and named in
`sourceStatus`; the rest of the comp is unchanged.

| Source | Data | Freshness | Switches |
| --- | --- | --- | --- |
| CardTrader sold | `cardtrader_sold_daily` in each game's database, last 30 days, median of the daily medians. The any-copy entry includes graded sales (as `soldMedianPkn` always did); the others leave them out. | Nightly | condition (other games: or better), language, finish, 1st edition |
| Pokoin sold | Firestore `marketplace_sales`, last 90 days, voided sales left out; EUR sales at 2 PKN per cent. Cached for 10 minutes per API process. | Live, 10-minute cache | condition, language |
| Cardmarket | Cardmarket's public price guide (`price_guide_<idGame>.json`) for every game: `pokoin-cardmarket-catalog guides --apply` (nezopt timer `pokoin-cardmarket-guides`, 02:45 UTC) stores the products our catalogs reference (`card_market_ids`) in `pokoin_marketplace.cardmarket_price_guide`, a row only when a product's values change, and one `cardmarket_price_guide_runs` row per game and day. The pricer uses a game's guide while its last run is at most 4 days old. Regular and foil columns; the lowest value when a card has several Cardmarket products. | Daily | finish |
| TCGplayer | The TCGCSV store (docs/TCGCSV_PRICES.md) through `pokoin_product_links`; market, low and mid of each subtype. USD → EUR at the newest ECB rate (`fx_rates_daily`, `pokoin-api job fx-rates-daily`, 16:30 UTC), used while it is at most 10 days old; the comp shows `usdPerEur` and `rateDay`. | Daily | finish (Pokémon: reverse holo), 1st edition |

Cardmarket idGames (measured from the overlap of our `card_market_ids` with
each guide): Pokémon 6, Magic 1, Yu-Gi-Oh! 3, Flesh and Blood 16, Digimon 17,
Dragon Ball Super 13, Vanguard 8, One Piece 18, Lorcana 19, Star Wars
Unlimited 21, Riftbound 22, Cyberpunk 23, Gundam 24, Sorcery 25, and the
Cardmarket-only games Final Fantasy 9, Star Wars Destiny 15, Weiss Schwarz
10, Force of Will 7, World of Warcraft 2, Battle Spirits Saga 20, My Little
Pony 12, The Spoils 5. Union Arena, Palworld and Dragoborne have no
Cardmarket ids yet.

Strategies saved before these sources (`rules` below 2) keep their price: a
`sold` strategy reads with every switch off, which is the old median, and a
Pokoin `sold` strategy, which priced from CardTrader's sold median, reads as
CardTrader `sold`.

Not built, the owner's call: eBay (the sold API needs eBay's approval; page
scraping is against its terms) and Cardmarket listings scraped by CTCMDeals.

**Batch upload.** A Scan desk batch can pick a group or a strategy before it
loads. Unpriced cards are listed paused at 0 and priced once by `applyPricing`
after submit. A group keeps them for later applies or the daily job. See
[SCAN_CONNECT.md](SCAN_CONNECT.md) "Batch pricing" for details.

## Games other than Pokémon

The satellite game databases have no per-offer book (only the cheapest offer
per blueprint in `cardtrader_blueprint_listing_cache`), so the price check
prices them from the CardRails price file the Pokoin extension reads:
`GET https://cardrails-api.pokoin.com/v1/prices/{game}` (PKP3, built twice a
day on nezopt by `price-book.timer`, pokoin-scanner `native/price_book`).
`pokoin-rust/crates/external/src/price_book.rs` keeps its source 7 and
applies the extension's rule (`pricebook.rs` `grid`):

> the cheapest current offer of a **CardTrader Zero / hub** (or "1 day
> ready") seller of the same card, in the same **language** and **finish**
> (foil), in the listing's **condition or a better one**.

- Graded, signed and altered offers are not in the file; such a listing has
  no CardTrader price. The file does not split first edition from unlimited.
- No matching offer means no CardTrader price (`—`); the extension's sold
  median fallback is not used.
- The SPA sends one price check per game (`?game=`): card ids are per game.
  Comps carry `ctBasis: "zero"`. The API caches each game's file for an hour
  (`POKOIN_PRICE_FILE_ORIGIN` overrides the host).

## Price store (2026-10-20)

Both rules above are also kept per facet in Postgres, so a page of listings
is priced with one indexed lookup instead of the pro floor over the book or a
price-file download:

- `public.cardtrader_facet_prices` (`scripts/sql/132_cardtrader_facet_prices.sql`):
  `(game, card_id, language, condition, foil, first_edition) → min_pkn,
  offers, basis`. Pokémon rows are the professional floor (`basis = 'pro'`,
  `foil` = reverse, keyed by public card id through
  `marketplace_search_candidates.ct_id`); the other games are source 7 of
  their PKP3 file (`basis = 'zero'`). `cardtrader_facet_price_runs` has one row
  per game with its last refill.
- Refill: `pokoin-api job cardtrader-facet-prices [--game=<slug>] [--dry-run]`
  (`pokoin-rust/apps/api/src/jobs/facet_prices.rs`, `pokoin_external::facet_store`),
  timer `pokoin-rust-job-cardtrader-facet-prices.timer` at 04:30 and 18:30 UTC,
  an hour after each price-book build (the 04:30 run also follows the 23:00
  daily dump). Pokémon is one statement on the writer (4.5 s, ~320k rows on
  2026-10-20); each other game downloads its file. Every game is one
  transaction that writes only changed rows, deletes the vanished ones and
  refuses to drop more than half of a game's rows; a game without a file is
  skipped. Market prices come from the books, not from the seller webhook or
  reconcile: those only carry the seller's own products.
- Read: `price_check::read_prices` asks the store for the page's cards
  (`facet_store::LOOKUP_SQL`, one round trip with the run row) in parallel
  with the page's other queries. With no run for the game, a run older than
  3 days, or the tables not migrated, it prices live as before. Comps from the
  store carry `ctAsOf` (the refill time; the board's tooltip shows it). The
  Seller API `sold-prices` quote (Card Rails) falls back to the store for
  every game (`priceSource: "cardtrader_facet_floor"`) before the Pokémon
  tile minimum.
- `pokoin-api job price-unpriced-listings --seller=<uid> [--game=…] [--csv=…] [--apply]`
  prices a seller's listings that are paused at 0 (Card Rails could not quote
  them) from the store and puts them on sale; a dry run unless `--apply`.

A listing still shows `—` when the store (like the live rule) has no offer of
its facets: no professional (Pokémon) or CardTrader Zero (other games) copy
in its language and finish, and for Pokémon in its exact condition. Graded,
signed and altered copies never have a CardTrader comp.

## Repricing a seller

```bash
# on the Pi, with the API's environment
/srv/pokoin/rust/current job cardtrader-pro-floor-reprice --seller=<uid> --csv=/tmp/reprice.csv            # dry run
/srv/pokoin/rust/current job cardtrader-pro-floor-reprice --seller=<uid> --csv=/tmp/reprice.csv --apply    # write
```

The dry run prints how many listings have a professional offer, how many move
up or down, and the stock value before and after. `--apply`:

- updates each changed CardTrader-linked listing on CardTrader first
  (`PUT /products/:id`, at most 5 a second, stops at a 429); a failed update
  leaves the Pokoin price alone so a rerun retries it;
- then sets the Pokoin price with a compare-and-set on the price the plan read
  (a seller's own edit in the meantime wins) and queues
  `LISTING_PRICE_CHANGED` on the listing outbox (price summary, caches, seller
  API events, shop book).

The CSV lists every listing with its old and new price in PKN and EUR and its
CardTrader product id: the list a Cardmarket update works from. 1 PKN = €0.005.
