# Card Rails ↔ Pokoin: one pricer (contract)

Agreed between the Pokoin and CardRails sessions on 2026-11-05, on the
owner's request for "the same pricer on Pokoin and CardRails". Live since
2026-11-06 (Pokoin PR #526). The price sources of 2026-11-07 (Cardmarket,
TCGplayer, Pokoin sold, CardTrader sold with switches) are on the Pokoin
branch `pricer-sources` and not deployed until it is merged.

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
- **One pricer when connected** (owner, 2026-11-08). When Card Rails is
  connected to a Pokoin account, Pokoin prices and Card Rails mirrors: every
  pulled listing says which pricing group prices it, a manual price takes a
  listing out of its group in both apps, and an unpriced item with no choice
  is priced by the account default. Connected sellers leave CardTrader
  listing to Pokoin's own CardTrader sync.

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

- `source` and `basis` (price sources, 2026-11-07; docs/PRICING.md "Price
  sources"). The first basis of each source is its default; a basis the
  source does not have is saved as that default.

  | `source` | `basis` | The number | Switches it honours |
  | --- | --- | --- | --- |
  | `cardtrader` | `offers` | the cheapest current offer | condition, language, finish, 1st edition |
  | `cardtrader` | `sold` | the 30-day sold median | condition, language, finish, 1st edition |
  | `pokoin` | `offers` | the cheapest Pokoin ask, else CardTrader's sold median | none (any copy) |
  | `pokoin` | `sold` | Pokoin's own sold median, 90 days | condition, language |
  | `cardmarket` | `trend` · `low` · `avg1` · `avg7` · `avg30` | Cardmarket's daily price guide: trend, lowest ask, average sale price over 1/7/30 days (EUR) | finish (regular or foil) |
  | `tcgplayer` | `market` · `low` · `mid` | TCGplayer's market price, lowest listing, mid price (USD → EUR at the ECB rate of the day) | finish, 1st edition |
- `match`: the per-detail switches. A comp prices a card only if it has the
  same condition (other games: that condition or better), language, finish
  (reverse/foil) and 1st edition (Pokémon only), for each switch that is on
  **and that the source honours** (table above). A switch the source cannot
  honour stays saved as sent and counts as off; show it greyed out ("Not in
  Cardmarket’s data"). **All exact** = all four on; all off = any copy of
  the card. Signed, altered and graded copies are never CardTrader comps.
  Strategies saved before 2026-11-05 with `basis: "matched"` read as all on;
  `basis: "cheapest"` reads as all off.
- `rules`: `2` on every strategy saved since 2026-11-07 (Pokoin sets it;
  ignored on save). Before 2, a `sold` strategy ignored the switches and a
  Pokoin `sold` one priced from CardTrader's sold median; Pokoin reads such a
  strategy as CardTrader `sold` with every switch off, which is the same price.
- `feeExclusive`: price from what the seller nets on CardTrader after its
  commission (at their own rate when connected), not from the ask. Only
  CardTrader numbers have fees; the other sources ignore it.
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
  `feeExclusive`), in PKN for every source (Cardmarket's EUR × 200,
  TCGplayer's USD at the day's ECB rate × 200). `askPkn`: the CardTrader ask
  of that offer, CardTrader offers only (null otherwise).
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

### `listings` / `update` (existing): pricing on the pull

Every listing of a `listings` page, and the `listing` of an `update`
answer, carries its pricing group:

```json
{ "listingId": "…", "pricePkn": 26, "priceEurCents": 13, …,
  "pricingGroupId": "pg_…", "pricingGroupName": "Riftbound bulk",
  "pricingStrategyId": "st_…", "pricingStrategyName": "Undercut 5% · CardTrader net",
  "pricingAutoDaily": true }
```

- In no group: all four ids and names are `null` and `pricingAutoDaily` is
  `false`. The seller prices that listing.
- While `pricingGroupId` is set, Pokoin prices the listing (on Apply, and
  every day when `pricingAutoDaily`). Card Rails shows "Priced by Pokoin ·
  <pricingGroupName>", locks its price field and mirrors `pricePkn`.
- `pricingStrategyName` is `null` when the group's strategy was deleted (the
  group prices nothing until it gets another) or the names could not be read.
- `listings` reads the groups of the whole page in one query.

### `update` (existing): a manual price leaves the group

```json
{ "action": "update", "listingId": "…", "item": { "pricePkn": 30 } }
```

- A price in the item (`pricePkn`, or `priceEurCents` > 0) that differs from
  the listing's current price takes it out of its group. Otherwise the
  group's next Apply, or the daily `pricing-groups-daily` run, would
  overwrite it.
- Resending the price the listing already has is not a manual price, and the
  group stays. For a listing priced by Pokoin, send no price unless the seller
  chose "Price myself".
- An `update` with no price, or price 0 (which pauses), keeps both the price
  and the group.
- `item.pricingGroupId`:
  - the listing's own group: it stays in it, even with a new price (the next
    apply may change that price);
  - another of the seller's groups: it moves there and keeps its price until
    that group's next apply. An unknown id → 400 `pricing_group_unknown`, and
    nothing is written;
  - `null` or `""`: it leaves its group even without a price ("Price myself"
    at the same price).
- The group is left before the price is written, so a retried `update` never
  leaves a manual price in a group.
- The response adds `leftPricingGroupId` (string | null): the group this
  update took the listing out of. `changed` is also `true` when only the
  group moved; repeating the same update answers `changed: false`.
- MyPokoin follows the same rule: a new price typed in the listing edit
  (`PATCH /api/marketplace-listings`) takes the listing out of its group, and
  the answer carries `leftPricingGroup: { id, name } | null`. Pokoin's own
  Apply and daily run never take listings out of groups.

### `list` (existing): pricing on arrival

- `pricingGroupId` / `pricingStrategyId` per item or for the call, with the
  same precedence as `price-quote`. An unknown id → 400
  `pricing_group_unknown` / `pricing_strategy_unknown` before the key is
  claimed.
- **The account default** (2026-11-08): an item sent unpriced
  (`status: "paused"`, price 0) with no choice on the item or the call is
  priced by the seller's account default, the `pricingGroupId` /
  `pricingStrategyId` of `scan-settings`. With no default, or one whose group
  or strategy no longer exists, the item stays paused at 0 as before, and the
  `list` is never refused for it. A priced item with no choice keeps its price
  and joins no group.
- With a group, the new listing joins it, moving out of any other group.
- An item sent unpriced (`status: "paused"`, price 0) is priced right away by
  the strategy. It goes live when the strategy's `activatePaused` is on and a
  comp exists; otherwise it stays paused.
- An item sent with a price keeps it.
- The response adds `pricingGroupId` | `pricingStrategyId`, `priced`,
  `pricePkn`, `priceEurCents` (`round(pricePkn / 2)`), `status`, and `pricingError` if pricing failed. The listing
  exists either way. It also adds `pricingFromAccountDefault` (bool): `true`
  when the account default chose the pricing.

Pokoin tests: `crates/commerce/src/handlers/seller_api.rs` (`pricing_tests`,
`tool_listing_says_which_group_prices_it`), `crates/commerce/src/handlers/pricer.rs`
(`group_move`, `is_manual_price`), `crates/commerce/tests/seller_api_flow.rs`
(the "one pricer" and account-default sections), `crates/external/src/pricing.rs`,
`crates/external/tests/scan_batch_pricing_flow.rs`, `market/src/pricing-group-note.test.js`.
