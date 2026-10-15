# Pokoin's CardTrader reference price

Since 2026-10-15 every place that prices a card from CardTrader uses one rule
(`pokoin-rust/crates/external/src/price_check.rs`, `pro_floor_sql`):

> the cheapest **current** offer of a **professional** CardTrader seller
> (`seller_type = 'pro'`) of the **same printing**, with the same
> **condition**, **language**, **reverse** and **first edition**.

- Offers come from `cardtrader_market_listing_snapshots` (the complete daily
  book). Offers not seen in the last 3 days and sellers on vacation
  (`cardtrader_seller_vacation.on_vacation`) do not count.
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
  are `card:CONDITION:LANGUAGE[:FLAGS]` with flags `R` (reverse) and `F`
  (first edition); each comp is also returned under that key so two copies of
  one card never share a comp.
- MyPokoin board market column, pricing strategies with the CardTrader source,
  the collection's suggested asks, and the card desk's suggested price (the
  sold graph only fills in when no professional offer exists).

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
