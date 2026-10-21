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
  written to CardTrader.

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
