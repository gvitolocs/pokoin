# Card Rails copy → Pokoin listing → one CardTrader product

`Model.tla` follows one Card Rails copy from the Seller API `list` call to one
CardTrader product, for a seller whose inventory link pushes (`pokoin_to_ct`
or `both`). Card Rails retries `list` with one idempotency key, up to three
attempts run at once, and the server can die between any two steps. The
listing is created active when Pokoin quotes a price and paused at 0
otherwise; a later price puts it on sale. The seller reconcile takes a
complete export, links products that name the listing, settles vanished
ones from seller orders, releases stale in-doubt claims, and creates the
product of an active unlinked listing behind a compare-and-set claim. A
CardTrader create is answered, refused, or in doubt (applied, not applied,
or still in flight and applied later). The product can sell on CardTrader,
and the order webhook can arrive late, twice, or never.

`Fixed = FALSE` is origin/main `1259f2c2`; `Fixed = TRUE` is
`feature/inventory-price-store`. `OtherGame = TRUE` makes the copy a
Riftbound card (any game but Pokémon).

## What is modelled

| Spec | Rust code |
| --- | --- |
| `ListStart` | `seller_api.rs` `list`: a bound key answers its listing; origin claims the key (`insert … on conflict do nothing`) and answers `list_in_doubt` when it was claimed and unbound; fixed claims it after `listing_body` validated the item and goes on |
| `ListInsert` | origin: `create_listing` commits the row, the key is bound afterwards. Fixed: `listings.rs` `create_listing_keyed` binds the key in the insert's transaction with `BIND_API_KEY_SQL` (`… where listing_id is null`); losing that compare-and-set rolls the insert back (`409 list_key_bound`) and `list` answers the bound listing |
| `ListAnswer` | the answer reaches Card Rails (`inventory_items.pokoin_listing_id`) |
| `ListCrash` | process death mid-call |
| `CrPull` | Card Rails' own re-list guard (`CardRails backend/src/pokoin_sync.rs` `push_local_only_items`): exactly one Pokoin listing with the copy's facets and location links the copy |
| `NewStatus`, `Price` | `sold-prices` quote (`seller_api.rs` `sold_prices`, now with `facet_quote` from the price store for every game); Seller API `update` with a price (`activate_priced`) and `job price-unpriced-listings` (`ACTIVATE_SQL`) put a listing paused at 0 on sale |
| `RcExport` | `sync.rs`: `writer_clock` then `fetch_products_export`; the push only runs behind `push_gate` (complete export, shared lock) |
| `RcPlan` | `sync_core.rs` `resolve_product_attachment` (`LinkExisting` by `user_data_field`), vanished linked products settled from seller orders (`classify_vanished_product`) |
| `RcRelease` | `link.rs` `release_stale_claims`: `STALE_CLAIMS_SQL`, one seller-orders read, `SETTLE_SOLD_CLAIMS_SQL` for claims an order names, `RELEASE_STALE_CLAIMS_SQL` for the others |
| `RcPush` | `link.rs` `push_unlisted`: `PUSH_CANDIDATES_WHERE` (origin: Pokémon only), `CLAIM_SQL` `"" → ct:pending:link-<ms>` |
| `CreateAnswered`, `CreateRefused`, `CreateInDoubt` | `push.rs` `create_with_token_for` → `PushOutcome::{Created, Rejected, InDoubt}`; `LINK_SQL` over the claim, `RELEASE_SQL` on a refusal, the claim kept when in doubt |
| `CtLand` | CardTrader applies a create whose answer was lost |
| `CtSell`, `HookDeliver`, `HookLost` | a CardTrader order; `webhook.rs` finds the listing by `user_data_field`, claims the order item once (`cardtrader_webhook_events`) and decrements |
| `Tick` | time since the claim, against `STALE_CLAIM_GRACE_SECS` (15 min) |
| `Reprice` | the Pricer dialog, the seller desk or Seller API `update` changes the Pokoin price; `update_listing` queues `cardtraderEdit` only for a linked listing (a `ct:pending:*` push sends nothing) |
| `EditDeliver` | `listing_sync::edit_cardtrader`: `PUT /products/:id` with `push::price_body`, the gross-up `Gross(p)` |
| `FeeOnceJob` | `job cardtrader-fee-once`: raises a linked ask that does not net the price, never lowers one |
| `CreateAnswered` re-send | `link.rs` `repriced_while_pushing` and the outbox's `LISTING_PRICE_CHANGED` after `LINK_PUSH_SQL`: a price that moved while the create was in flight is sent again |

`made`, `rows` and `decs` are ghost counters for the properties. Prices are
abstract units and the fee is one unit: `Gross(p) = p + 1` in the fixed
code, `p` on origin/main (the push listed the net price as the ask).

## Properties

| Property | Meaning |
| --- | --- |
| `NoDuplicateRow` | One Card Rails copy is at most one Pokoin row, whatever the retries, races and crashes. |
| `NoDuplicateProduct` | One Pokoin listing is at most one CardTrader product, ever: an in-doubt create is never followed by a second while the first may exist or may still land, and a copy sold on CardTrader is never listed again. |
| `NoDoubleDecrement` | A CardTrader sale takes the stock down once (webhook replay, reconcile settling the same order). |
| `FeeOnce` | Once the listing is linked, live, on sale, with no edit or push in flight, the CardTrader ask is the gross-up of the Pokoin price: the fee is counted once, after any reprice, any reprice during a create, and the fee-once job. |
| `EventuallyListed` (`FairSpec`) | Every copy ends up on Pokoin, Card Rails linked, and listed on CardTrader by exactly one live product, or sold there. |

Assumption (`LandsInGrace`): a CardTrader create lands within
`STALE_CLAIM_GRACE_SECS` of its claim. The HTTP client gives up after
seconds; 15 minutes is the margin for CardTrader applying a request it
already received. `design/create-lands-after-grace.cfg` shows the duplicate
that follows if CardTrader ever applied a create later than that.

## Configs

| Config | Expectation | Result on nezopt (TLC, 2026-10-21) |
| --- | --- | --- |
| `Model.cfg` | fixed, Riftbound copy quoted, one reprice: every invariant | 1,547,148 distinct states, depth 59 |
| `unquoted.cfg` | fixed, unquoted copy (paused at 0, priced later): every invariant | 1,548,396 distinct states, depth 60 |
| `liveness.cfg` | fixed, `EventuallyListed` under weak fairness | 525,264 distinct states, depth 51 |
| `bugs/other-game-never-pushed.cfg` | origin: a Riftbound listing is never a push candidate | `EventuallyListed` violated |
| `bugs/paused-forever.cfg` | origin: a listing paused at 0 stays paused when priced | `EventuallyListed` violated |
| `bugs/stuck-in-doubt-claim.cfg` | origin: an in-doubt create that never happened keeps `ct:pending` for ever | `EventuallyListed` violated |
| `bugs/list-key-in-doubt.cfg` | origin: a crash between key claim and insert answers `list_in_doubt` for ever | `EventuallyListed` violated |
| `bugs/double-fee.cfg` | origin: the push lists the net Pokoin price as the ask | `FeeOnce` violated |
| `design/create-lands-after-grace.cfg` | fixed, the grace assumption dropped | `NoDuplicateProduct` violated (accepted residual) |
| `witness/*.cfg` | fixed: a stale claim is released, a listing is linked after an in-doubt create, a copy sells out, a listing repriced during its create settles at the right ask | each invariant violated |

```bash
specs/tla/run.sh listing-ct-sync                 # the fixed configs: must pass
specs/tla/run.sh --regressions listing-ct-sync   # also bugs/, design/, witness/: each must report its violation
```

## Second checker: tla-rs (Rust)

[tla-rs](https://github.com/fabracht/tla-rs) 0.24.9, a TLA+ model checker
written in Rust, checks the same `Model.tla` and configs. Built from source
on nezopt (`cargo build --release --bin tla`, target on the 15T disk), then:

```bash
tla Model.tla --config Model.cfg --allow-unassigned-stutter --max-states 50000000 --max-depth 1000
```

`--allow-unassigned-stutter` is needed because tla-rs does not follow
assignments into `IF … THEN … ELSE` branches (`ListInsert` assigns `key`
and `req` in every branch). For it the spec states `UNCHANGED CtVars`
inline (not through an operator parameter) and parenthesises one-line
`IF … ELSE x` before a `/\` bullet: same meaning, and TLC reruns on the
same file.

Result on 2026-10-21, identical to TLC on every config:

| Config | TLC | tla-rs (one thread) |
| --- | --- | --- |
| `Model.cfg` | pass, 1,547,148 states, depth 59 | pass, 1,547,148 states, depth 59, 250 s |
| `unquoted.cfg` | pass, 1,548,396, depth 60 | pass, 1,548,396, depth 60, 237 s |
| `liveness.cfg` | pass, 525,264, depth 51 | pass, 525,264, depth 51, 175 s |
| `bugs/double-fee.cfg` | `FeeOnce` violated | `FeeOnce` violated (8-state trace) |
| other 4 `bugs/` | `EventuallyListed` violated | `EventuallyListed` violated |
| `design/create-lands-after-grace.cfg` | `NoDuplicateProduct` violated | violated |
| 4 `witness/` | each reached | each reached |

TLC stays the checker of record (`run.sh`); tla-rs is a cross-check.

## What TLC found while writing it

The first fixed run broke `NoDuplicateProduct`: `Tick` let time pass the
grace while the create request itself was still being sent, so an export
taken after the grace missed a product that landed later. The code's grace
(15 minutes) is far longer than the client's request timeout, so the spec
was wrong, not the code: the assumption now covers a create being sent as
well as one in flight at CardTrader. Writing the model also showed that a
stale claim whose product sold before any export saw it, with its webhook
lost, would have been left for sale on Pokoin; `SETTLE_SOLD_CLAIMS_SQL`
settles such a claim sold out instead of releasing it.

Adding the pricer's write path to the model showed that a reprice while
the CardTrader create was in flight left the create's old ask on
CardTrader: the edit of a `ct:pending:*` listing sends nothing and the link
did not re-send. The reconcile and the outbox now re-send a price that moved
after the link, and `FeeOnce` holds in `Model.cfg` with that path.
