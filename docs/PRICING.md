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
