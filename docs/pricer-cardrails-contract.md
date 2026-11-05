# Card Rails ↔ Pokoin: one pricer (contract)

Agreed between the Pokoin and CardRails sessions on 2026-11-05, on the
owner's request for "the same pricer on Pokoin and CardRails". It is
implemented on the Pokoin branch `pricer-rebuild` and **not deployed** until
that branch is merged and deployed. CardRails does not deploy its side
before that.

- **One engine, on Pokoin.** CardRails keeps no copy of the rules. It reads
  the strategies of the connected Pokoin account and asks Pokoin for prices
  (`price-quote`). The rules are `pokoin-rust/crates/external/src/pricing.rs`
  (server) and `market/src/pricer.js` (Pokoin web). Both pass the shared
  examples in `market/src/pricer.vectors.json`.
- **Strategies per account.** A CardRails user without a Pokoin account
  has no strategies for now. Strategies are game-agnostic by design: comps
  are looked up per card in its own game, so `pricing-groups` sends no `games`.
- **Endpoint:** the existing connector, `POST /api/cardrails/connector`
  (or `/api/seller-api/v1`), `Authorization: Bearer pkn_…` with a Card Rails grant.

## The strategy object

```json
{ "id": "st_…", "name": "Undercut 5% · CardTrader net",
  "source": "cardtrader",
  "basis": "offers",
  "match": { "condition": true, "language": true, "finish": true, "firstEdition": true },
  "feeExclusive": true,
  "action": "undercut", "amountPct": 5, "amountPkn": 0,
  "rounding": "integer", "minPkn": 1,
  "activatePaused": true,
  "createdAt": "…", "updatedAt": "…",
  "summary": "CardTrader · all exact · net of CardTrader fees · undercut 5% · whole PKN · min 1 PKN" }
```

- `source`: `cardtrader` | `pokoin` (the cheapest Pokoin ask, else the sold median).
- `basis`: `offers` (the current offers) | `sold` (the 30-day sold median).
- `match`: the per-detail switches for CardTrader offers. An offer prices a
  card only if it has the same condition (other games: that condition or
  better), language, finish (reverse/foil) and 1st edition (Pokémon only),
  for each switch that is on. **All exact** = all four on; all off = any copy
  of the card. Signed, altered and graded copies are never CardTrader comps.
  Strategies saved before 2026-11-05 with `basis: "matched"` read as all on;
  `basis: "cheapest"` reads as all off.
- `feeExclusive`: price from what the seller nets on CardTrader after its
  commission (at their own rate when connected), not from the ask.
- `action`: `match` | `undercut` | `premium`, by `amountPct` (0–90) % and
  `amountPkn` PKN.
- `rounding`: `none` (cents) | `integer` (nearest PKN) | `down` | `up`.
- `minPkn`: never below this, after rounding.
- `activatePaused`: a paused listing that gets a price goes on sale.
- `summary` is sent by Pokoin and ignored on save.

## Actions

### `pricing-groups` (read)

```json
{ "groups": [ { "id": "pg_…", "name": "Riftbound bulk", "strategyId": "st_…", "strategyName": "…",
                "summary": "…", "autoDaily": true, "listingCount": 38 } ],
  "strategies": [ <strategy object>, … ] }
```

A group whose strategy was deleted has `strategyName: null`.

### `scan-settings` (read)

`scanSettings` carries `pricingGroupId` and `pricingStrategyId`
(string | null, at most one set): the default pricing of the seller's latest
Pokoin Scan desk batch.

### `price-quote` (read-only: nothing is written, no key is claimed)

Request:
```json
{ "action": "price-quote",
  "pricingGroupId": "pg_…",
  "items": [ { "itemId": "<CardRails queue row id>", "identity": { "publicId": "220962", "game": "riftbound" },
               "game": "riftbound",
               "condition": "NM", "language": "EN", "printing": "Reverse Holo", "firstEdition": false,
               "signed": false, "altered": false,
               "pricingStrategyId": "st_…" } ] }
```

- Use `pricingGroupId` or `pricingStrategyId`, at the top level for the batch
  default, or on an item. The item's choice wins, and a group wins over a
  strategy. A group's rows use the group's strategy.
- Items carry the same identity and details as `list`; there are 1–500 per call.
- The game comes from `identity.game`, else `game`, else Pokémon.
- An unknown top-level id → `400` with code `pricing_group_unknown` /
  `pricing_strategy_unknown`. On an item it is that row's `status` instead.

Response:
```json
{ "pknPerEurCent": 2,
  "quotes": [ { "itemId": "…", "strategyId": "st_…", "pricingGroupId": "pg_…",
                "status": "priced", "compPkn": 25.56, "askPkn": 28, "pricePkn": 26, "priceEurCents": 13 } ] }
```

- `itemId` is echoed as sent. Quotes come back in the order of `items`.
- `compPkn`: the market number the strategy started from (net of fees when
  `feeExclusive`). `askPkn`: the CardTrader ask of that offer.
- `pricePkn`: the strategy's price. `priceEurCents` = `round(pricePkn / 2)`
  (half away from zero).
- `status`, which explains a null price:
  - `priced`;
  - `no_comp`: no offer matches the strategy's switches, or no market number;
  - `no_price`: the rule went to 0 or below with no minimum;
  - `no_pricing`: neither the row nor the call named a group or strategy;
  - `unknown_group`, `unknown_strategy`;
  - `card_unmapped`: no Pokoin card id.

**Currency.** 1 PKN = €0.005, i.e. 2 PKN per euro cent (`pknPerEurCent`).
A price that is an odd number of PKN has no exact cent. To keep both sides
equal to the cent, list on Pokoin either:
- with `item.pricePkn` (which `list` and `update` accept) rather than
  `priceEurCents`; or
- unpriced with the group or strategy, so Pokoin prices it on arrival (see
  `list` below).

### `pricing-strategy-save` / `pricing-strategy-delete` (write)

- `{ "action": "pricing-strategy-save", "strategy": <strategy object without id to create> }`
  → `{ "strategy", "strategies" }`. With an `id` it edits that strategy, and an unknown
  id → 404 `pricing_strategy_unknown`.
- `{ "action": "pricing-strategy-delete", "id": "st_…" }` → `{ "strategies" }`.
- The checks are the same as on Pokoin:
  - a name is required (`strategy_name_required`) and unique, ignoring case
    (409 `strategy_name_taken`);
  - at most 50 strategies;
  - a strategy a group uses can't be deleted (409 `strategy_in_use`, the
    message names the groups).

### `list` (existing): pricing on arrival

- `pricingGroupId` / `pricingStrategyId` per item or for the call, with the
  same precedence as `price-quote`. An unknown id → 400
  `pricing_group_unknown` / `pricing_strategy_unknown` before the key is
  claimed.
- With a group, the new listing joins it, moving out of any other group.
- An item sent unpriced (`status: "paused"`, price 0) is priced right away by
  the strategy. It goes live when the strategy's `activatePaused` is on and a
  comp exists; otherwise it stays paused.
- An item sent with a price keeps it.
- The response adds `pricingGroupId` | `pricingStrategyId`, `priced`,
  `pricePkn`, `priceEurCents` (`round(pricePkn / 2)`), `status`, and `pricingError` if pricing failed. The listing
  exists either way.

Pokoin tests: `crates/commerce/src/handlers/seller_api.rs` (`pricing_tests`),
`crates/external/src/pricing.rs`, `crates/external/tests/scan_batch_pricing_flow.rs`.
