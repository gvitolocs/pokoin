# EUR order fulfilment

`Model.tla` models EUR (Stripe Checkout) marketplace orders from reservation to
fulfilment: the buyer paying or abandoning the session, Stripe expiring it, the
Stripe webhook, the buyer cancelling, the 5-minute sweep, and two concurrent
`fulfil_paid_eur_order` callers (the API and the sweep job) with their
10-minute Firestore lease. Native lines buy from one Pokoin listing; CardTrader
live lines are bought through the single Pokoin CardTrader cart. Any process can
die at any step. `Fixed = FALSE` is origin/main at `00bc3d2c`; `Fixed = TRUE` is
this branch. Findings: [`../FINDINGS.md`](../FINDINGS.md).

## What is modelled

| Spec | Rust code (this branch) |
| --- | --- |
| `Init` | `create_order_checkout_session` (`pokoin-rust/crates/commerce/src/handlers/orders.rs:2803`): hold + decrement (`:2876`), `inventory.state = reserved`, `paymentStatus = pending_stripe`, PKN discount held |
| `Pay`, `StripeExpire`, `Redeliver` | Stripe Checkout and its at-least-once events |
| `Deliver` | `stripe_webhook_inner`: `stripe_event:<id>` idempotency claim **before** processing (`handlers/stripe.rs:255`) |
| `WebhookPaid` | `handle_marketplace_order_paid` (`stripe.rs:331`): paid patch (`:407`), then `fulfil_paid_eur_order` (`:373`, `:432`) |
| `WebhookExpired`, `ReleaseTxn`, `RestoreStock` | `checkout.session.expired` → `release_eur_reservation` (`stripe.rs:319`, `orders.rs:883`, `release_plan` `:971`, `RELEASABLE_STATUSES` `:875`) → `release_order_stock` (`:303`, delete-holds-and-restore in one statement) |
| `Cancel` | `order_cancel` (`orders.rs:1071`). origin releases `pending_stripe/processing/expired/failed` without touching the session; fixed is Node's `cancelPendingEurOrder`: `cancel_plan` (`:1040`), expire the session first (`:1103`), a session Stripe already completed is recovered as paid |
| `SweepPending` | `jobs/eur.rs` `sweep` (`apps/api/src/jobs/eur.rs:150`): `recover_paid` (`on_paid`, transactional `paid_plan` `:67`) or `release_expired` (expire, then release, `:176`) |
| `SweepResume` | the sweep's unfinished orders: origin `fulfillment.state in [running, partial]`; fixed also paid orders whose fulfilment never started (`unfinished_queries`, `:128`) |
| `Lease` | the lease transaction and `fulfilment_skip` (`orders.rs:1208`, `:1524`, 10 minutes `:1550`) |
| `Inv` | inventory: committed / reserved / re-take (`retake_eur_inventory` `:1569` → `verify_and_decrement_listings` `:192` → `take_line` `:151`; fixed: `HOLD_SQL` first `:141`, decrement only if the hold row was inserted) or conflict ⇒ `needs_refund` |
| `Commit`, `DropHold` | `inventory.state = committed` (`:1263`), `drop_eur_hold` (`:1310`, `:1555`) |
| `Own`, `OwnMark` | `decrement_seller_ownership_for_sale` (`:1324`, `:1736`) then `ownershipDone` (`:1330`); fixed: decrement + sale key in one transaction (`decrement_ownership_once`, `:1810`) |
| `Buy` … `BUnlock` | `buy_through` (`crates/commerce/src/cardtrader_adapter.rs:429`): fixed cart lock (`:473`, `CART_LOCK_DOC` `:121`), marker claim (`claim_for` `:112`), cart check, add, purchase (`:524`), marker; failure status `purchase_failure_status` (`:547`) |
| `Final` | the last `set_document`: `done`/`partial`, `fulfillmentStatus` (`orders.rs:1496`) |
| `CrashFulfil`, `CrashHandler`, `LeaseExpire` | process death or a failed Firestore/SQL call; the lease of a dead call expires, a live call's lease expires only `MaxLeaseExpiry` times |

`taken`, `restored`, `returned`, `consumed`, `purchases`, `ownDec` are ghost
counters for the properties.

## Properties

| Property | Meaning |
| --- | --- |
| `ReserveOnce` | Stock is taken at most once per order line and given back at most once. |
| `FulfilledHoldsStock` | A fulfilled native order still holds its unit: it was not released and resold. |
| `NotReleasedAndFulfilled` | An order is never both cancelled/expired and fulfilled. |
| `DiscountOnce` | The held PKN discount is returned or consumed, never both. |
| `BuyOnce` | A CardTrader buy-through is executed at most once per line. |
| `OwnershipOnce` | The seller's ownership row loses a sold unit once. |
| `PaidEventuallyTerminal` (liveness) | A paid order eventually ends `done`, `conflict` or `needs_refund`. |
| witnesses `Never*` | Must be *violated* by the fixed model: fulfilment, release, buy-through and a fulfilment left `partial` (busy cart, resumed later) all happen. |

## Configs

| Config | Expectation | Result on nezopt (12 cores) |
| --- | --- | --- |
| `Model.cfg` | fixed, native lines, all safety invariants | 1,594,579 distinct states, depth 41, 11 s |
| `buy.cfg` | fixed, CardTrader live lines, all safety invariants | 8,033,545 distinct states, depth 69, 45 s |
| `liveness.cfg` | fixed, `PaidEventuallyTerminal` under weak fairness (two orders, a crash, a redelivery) | 251,783 distinct states, depth 35 |
| `bugs/cancel-then-paid.cfg` | origin: `NotReleasedAndFulfilled` | counterexample, 15 states |
| `bugs/discount-returned-and-consumed.cfg` | origin: `DiscountOnce` | counterexample, 6 states |
| `bugs/double-retake.cfg` | origin: `ReserveOnce` | counterexample, 9 states |
| `bugs/ownership-twice.cfg` | origin: `OwnershipOnce` | counterexample, 15 states |
| `bugs/buy-shared-cart.cfg` | origin: `BuyOnce` (two orders share the cart) | counterexample, 36 states |
| `bugs/buy-lost-answer.cfg` | origin: `BuyOnce` (purchase answer lost) | counterexample, 23 states |
| `bugs/paid-never-fulfilled.cfg` | origin: `PaidEventuallyTerminal` | lasso counterexample |
| `witness/*.cfg` | fixed: behaviour reachable | violations found |

Constants of `Model.cfg`: two orders on one listing with two units, one crash,
one lease expiring under a live worker, one Stripe redelivery. In the fixed model
`needs_refund` is unreachable: a conflict needs a payment landing after a
release, which C17 rules out. `buy.cfg`: two
CardTrader live orders, one crash, one lost purchase answer, one lease expiry.

Run: `specs/tla/run.sh eur-fulfilment` (add `--regressions` for the rest).
