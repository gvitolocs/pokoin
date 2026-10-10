# TLA+ findings — native Rust API (2026-10-10)

Three TLC-checked models of the concurrent, stateful parts of the native Rust
Pokoin API, written against origin/main `00bc3d2c` (after PRs #274–#280):

| Model | Folder | Code |
| --- | --- | --- |
| CardTrader seller reconcile racing the order webhook | [`ct-reconcile/`](ct-reconcile/README.md) | `crates/external/src/cardtrader/{sync,sync_core,async_sync,webhook}.rs` |
| Listings outbox sync engine | [`listing-outbox/`](listing-outbox/README.md) | `crates/commerce/src/listing_sync.rs`, `handlers/listings.rs` |
| EUR order fulfilment, Stripe webhook and sweep | [`eur-fulfilment/`](eur-fulfilment/README.md) | `crates/commerce/src/handlers/{orders,stripe}.rs`, `cardtrader_adapter.rs`, `apps/api/src/jobs/eur.rs` |

Every spec has a `Fixed` constant. `Fixed = FALSE` is origin/main; every
code finding below has a `bugs/*.cfg` that reproduces its counterexample there
(`run.sh --regressions` checks that each one still does). `Fixed = TRUE` is this
branch; the top-level `*.cfg` of each folder must pass. `witness/*.cfg` show the
fixed models are not vacuous (removals, imports, pushes, destroys, purchases,
releases and fulfilments still happen). `design/*.cfg` reproduce the races that
are accepted and documented below rather than fixed.

How each finding was found: **TLC** = a counterexample from the model;
**mapping** = noticed while mapping the spec to the Rust code (TLC cannot see a
parsing bug), fixed and unit-tested the same way.

## Results

TLC 2026.10.06 (`tla2tools.jar` from the v1.8.0 release), Java 21, 12 workers on nezopt.

| Config | Result | Distinct states | Depth |
| --- | --- | --- | --- |
| `ct-reconcile/Model.cfg` | pass | 48,360,531 | 31 |
| `listing-outbox/Model.cfg` | pass | 122,462,169 | 81 |
| `listing-outbox/cache.cfg` | pass | 7,138,295 | 54 |
| `listing-outbox/liveness.cfg` | pass (liveness) | 211,965 | 33 |
| `eur-fulfilment/Model.cfg` | pass | 1,594,579 | 41 |
| `eur-fulfilment/buy.cfg` | pass | 8,033,545 | 69 |
| `eur-fulfilment/liveness.cfg` | pass (liveness) | 251,783 | 35 |
| 19 `bugs/*.cfg` | each reports its counterexample on origin/main | | |
| 4 `design/*.cfg` | each reports the accepted race on the fixed model | | |
| 12 `witness/*.cfg` | each finds the behaviour reachable | | |

`specs/tla/run.sh --regressions` runs all 42 configs in 21 minutes on nezopt.

Rust: `cargo test --workspace` passes (1,382 tests, 0 failed). The new SQL
(raise guard, advisory-locked import, push claim/link/release, hold-first take,
atomic rollback, LSN probe) was also run against a throwaway local Postgres 17
container — never against the production writer or the Pi.

---

## CardTrader seller reconcile (`ct-reconcile`)

### C1 — An export with *some* unreadable ids removes the listings of products it contains (TLC)
`bugs/empty-ids-partial.cfg`: two linked listings; the export has both products
but one row's id is read as empty. Origin's `unparsed_export` guard only fired
when **every** row was unreadable, so the plan saw one product "missing" and
delisted its listing (1 of 2 is under the mass-removal guard). The 2026-10-09
incident was the all-rows case; a partial misread (ids of one type, a field
missing on some rows) slipped through. Node behaved the same (`filter(p => p.id)`,
no guard at all).
**Fix** (`sync_core.rs` `plan_inventory_reconcile`, `sync.rs`): any row whose id is
not understood blocks every destructive step (`gate_reason = unparsed_export`,
`summary.unparsedRows`); unreadable rows are neither imported nor updated; the
1-Day Ready asset delete obeys the same gate.
**Test**: `sync_core::tests::partially_unread_export_never_removes`.

### C2 — Ids read in another format count as absent *and* as new products (TLC)
`bugs/alien-ids.cfg`: an id read as `"12.0"` (any non-integer text) is not empty,
so origin treated it as a new product (junk import with `ct:12.0`) while the real
`ct:12` listing looked absent and was delisted.
**Fix**: `is_ct_product_id` — a CardTrader product id is a positive integer;
anything else is an unparsed row (C1).
**Test**: `sync_core::tests::non_integer_ids_are_unparsed_not_new_products`.

### C3 — A product skipped for its game is treated as vanished (TLC)
`bugs/nogame-not-seen.cfg`: a product whose game is unsupported or unreadable is
skipped **before** it is recorded in `seen_product_ids`, so its linked listing is
a removal candidate although the product is in the export. Node had the same
ordering.
**Fix**: record every understood product as seen before the game filter.
**Test**: `sync_core::tests::skipped_game_products_are_still_present`.

### C4 — Planned imports dilute the mass-removal guard (TLC)
`bugs/guard-dilution.cfg`: the guard divided removals by `by_source_id.len()`
**after** planning, which includes the synthetic entries of planned imports. A
misread that maps every id to a different valid number makes every linked
listing vanish *and* every product look new: N removals over N + N entries is
exactly half, so the guard let all N go (and N duplicates were imported).
**Fix**: the denominator is the number of listings linked before the run.
**Test**: `sync_core::tests::planned_imports_do_not_dilute_the_mass_removal_guard`.

### C5 — Two reconcilers import the same product twice (TLC)
`bugs/duplicate-import.cfg`: the Redis lock has a 15-minute TTL with no renewal,
and when Redis is unreachable `acquire` hands out a degraded lock, so the API's
`SyncJobs` and the timer job (or Pi and k3s) can reconcile one seller at once.
`create_imported_listing` found by source (on the **replica**) and then inserted;
there is no unique index on `(seller_uid, source_listing_id)`. Both runs missed
the row and both inserted: two Pokoin listings for one CardTrader product, i.e.
twice its stock for sale.
**Fix** (`sync.rs` `create_imported_listing`): find and insert run in one writer
transaction under `pg_advisory_xact_lock(hashtextextended('ct-import:<seller>:<source>', 0))`;
the find reads the writer. Checked on a scratch Postgres 17.
**Follow-up**: a unique partial index on `(seller_uid, source_listing_id) where
source_listing_id like 'ct:%' and status <> 'inactive'` would make this a schema
guarantee (needs a migration on the writer; not applied here).

### C6 — A stale export puts sold stock back on sale (TLC)
`bugs/stale-resurrection.cfg`: the reconcile fetches the export, a CardTrader sale
arrives, the webhook decrements the listing, and then the reconcile writes the
export's older, higher quantity. Pokoin shows a unit CardTrader already sold until
the next run. The window is the whole run (minutes for a 12,000-listing seller),
so for an active seller this is likely, not rare.
**Fix** (`sync.rs`): the writer's clock is read just before the export request
(`writer_clock`); `APPLY_CT_QUANTITY_SQL` refuses to **raise** a row whose
`updated_at` is later (lowering always applies); refusals are counted as
`staleSkipped` and the next complete export settles them. Same clock as
`updated_at`, so no skew. Checked on a scratch Postgres 17.

### C7 — Non-Pokémon imports were written where the reconcile never looks (mapping)
`create_imported_listing` wrote non-Pokémon products to the per-game writer
(`db.write(marketplace_game, …)`), but `load_seller_listings` and every other
listing path use the shared marketplace writer (`marketplace_game` column), as
Node did. The product was never seen as linked and was imported again on every
run. **Fix**: the insert uses the shared writer, inside C5's transaction.

### C8 — The webhook read numeric product ids as empty (mapping)
Same class as the 12,918 incident: `item_product_id` used `as_str()`, so a
numeric `product_id` became `""`, no sale found its `ct:<id>` listing, and every
webhook fell back to "no linked listing". Node used `String(value)`.
**Fix**: read scalars as text and let an explicit `null` fall through like JS `??`.
**Test**: `webhook::tests::numeric_product_ids_are_read`.

### C9 — A webhook miss never started the fallback reconcile (mapping)
Node's webhook route enqueued the complete-export sync when an item had no
linked listing or its decrement was refused; the Rust route returned
`retrySync: true` and did nothing, leaving the sale to the 5-minute timer.
**Fix** (`routes/cardtrader.rs`): `wants_fallback_sync` → `enqueue_cardtrader_sync`
(best effort, like Node). **Test**: in `numeric_product_ids_are_read`.

### C10 — A blocked mass removal was recorded as a complete sync (mapping)
`record_seller_sync` and the response used the HTTP-level gate (always
complete), not the plan's, so an `unparsed_export` or `mass_removal_guard` run
was recorded as complete and the timer job reported `syncOk`. **Fix**: record
the plan's gate and return `gateReason`.

### D1 — Webhook deltas on top of an export that already reflected them (TLC, accepted)
`design/double-decrement.cfg`, `design/double-restore.cfg`: the reconcile writes
absolute quantities from an export, the webhook applies relative deltas. A
webhook sale delivered after a reconcile wrote an export that already reflected
that sale is applied twice (the listing shows one unit too few); a cancellation
delivered the same way restocks twice (one unit too many, which needs a
CardTrader cancellation and a delayed webhook). Both last until the next
complete export (5-minute timer), and sale records are never double counted
(one `marketplace_sales` doc per order item). Node has the same design.
Removing it needs one serialization point for both writers — e.g. webhook
events recorded in the same Postgres transaction as the decrement, with the
reconcile subtracting events newer than its export — which is a schema change.
**Recommended follow-up**, not done here.

## Listings outbox (`listing-outbox`)

### C11 — The CardTrader push is issued twice (TLC)
Three counterexamples on origin (Node the same): the worker dies between
`POST /products` and the link write (`bugs/duplicate-push-crash.cfg`); the
create's answer is lost (`bugs/duplicate-push-ambiguous.cfg`); the 30-second
lease expires during the push — two Firestore reads with 10 s timeouts plus a
20 s CardTrader call — and another instance pushes too
(`bugs/duplicate-push-slow-lease.cfg`). Two CardTrader products for one listing
put twice the stock on sale, and the reconcile then flips the link between them.
**Fix** (`listing_sync.rs` `push_cardtrader`, `push.rs` `push_product_outcome`,
`client.rs` `write_in_doubt`): before calling CardTrader the row moves from no
source to `ct:pending:<event>` (compare-and-set; every other worker and retry
loses it); the product is linked over that claim only; a rejected create (4xx,
bad listing, no token) frees the claim; a create in doubt (no answer, 5xx, no id)
keeps it — never a second push — and the reconcile links the product by its
`user_data_field = pokoin:<listing>`. `ct:pending:` is not a `ct:<digits>` id, so
no removal, destroy or sale sync acts on it.
**Tests**: `listing_sync::tests::push_claim_is_decided_from_the_row_as_it_is_now`,
`push::tests::create_outcomes_tell_rejected_from_in_doubt` (against a fake
CardTrader server). SQL checked on a scratch Postgres 17.

### C12 — A listing deactivated during its push stays for sale on CardTrader (TLC)
`bugs/ghost-after-deactivate.cfg`: the seller deactivates while the create event's
push is in flight. The source is still empty, so the deactivation's event has no
`destroyCardtrader`; the push then links the new product to an inactive listing.
The reconcile finds the inactive row by its source and leaves it, so CardTrader
sells the card indefinitely. (Separately, `destroyCardtrader` was decided from
`existing`, read on the replica, which can predate the link.)
**Fix**: `update_listing` reads the source under the row lock on the writer;
the push's link, in one transaction, enqueues a destroy event when the listing
is off sale (inactive or sold out) or the claim is gone.

### C13 — TLC refuted the first version of the C12 fix
The first fix destroyed the product inline after linking. TLC found: the lease
expires under the pushing worker, a second worker finishes the event as "push in
doubt", and the first worker's inline destroy then fails — nobody retries it.
**Resolution**: the compensation is a durable outbox event of its own (above),
retried until it succeeds.

### C14 — A failed destroy was reported as done (TLC)
`bugs/ghost-destroy-failure.cfg`: `destroy_product` turned any CardTrader error
into `{"ok": false}`, so a 5xx or a timeout completed the event and the product
stayed on sale (Node logged and moved on too).
**Fix**: `destroy_result` — a 404 (already gone) is done, any other failure is an
error and the event is retried. Destroy is thereby idempotent.
**Test**: `listing_sync::tests::destroy_failures_are_retried_unless_the_product_is_gone`.

### C15 — Read-cache invalidation ran before the replica had the write (TLC)
`bugs/stale-cache-after-sync.cfg`: the consumer bumped the card/search generation
right after claiming the event, but the read cache renders from the Pi hot
standby. A reader between the bump and replica replay cached the old row under
the new generation for the TTL (30 s card page, 60 s search).
**Fix** (`await_replica`): before the consumer bump, wait (≤ 5 s, 100 ms polls)
until the replica's `pg_last_wal_replay_lsn()` reaches the writer's
`pg_current_wal_lsn()`, which covers the event's commit and its price refresh.
The request-path bump stays immediate; anything cached from the lagging replica
in between is orphaned by the consumer's later bump.
**Residual** (`design/replica-timeout.cfg`): lag beyond 5 s falls back to the old
behaviour, bounded by the TTL.

### C16 — Dead letters were silent (mapping, accepted residual)
`design/dead-letter.cfg`: crashes, errors or slow workers can use up the 8
attempts; `CLAIM_SQL` then never picks the event again. Node logged
`pokoin_sync_dead_letter`; the port did not. **Fix**: the same log line.
**Follow-up**: a re-drive (reset `attempts` on dead letters after an alert).

Not changed: on error the outbox keeps the claimed payload, so a retry re-runs
completed steps (Node did the same). With C11 and C14 every step is idempotent,
which the model checks.

## EUR fulfilment (`eur-fulfilment`)

### C17 — Buyer cancel released an order the buyer could still pay (TLC)
`bugs/cancel-then-paid.cfg`: the Rust `order_cancel` released the reservation
without expiring the Stripe Checkout session, and also released `processing`
(async payment in flight), `expired` and `failed` orders. Node's
`cancelPendingEurOrder` expired the session first. A buyer who paid in another
tab ended with an order that is paid and fulfilled from re-taken stock but
`fulfillmentStatus = cancelled`, and whose PKN discount was both returned and
consumed (`bugs/discount-returned-and-consumed.cfg`).
**Fix** (`orders.rs` `order_cancel`, `StripeClient::expire_checkout_session`):
Node parity — paid ⇒ 409; anything but `pending_stripe` ⇒ `already_closed`;
expire the session first; if Stripe already completed it, recover it as paid
and 409. Defence in depth: a fulfilled paid order never keeps a stale
`cancelled` status.
**Test**: `orders::tests::cancel_expires_the_session_and_never_releases_a_payable_order`.

### C18 — Re-taking stock decremented a unit the order already held (TLC)
`bugs/double-retake.cfg`: the hold insert was `ON CONFLICT DO UPDATE`, after an
unconditional decrement, so taking a line the order already held (a release
whose stock restore never ran, a failed Firestore `committed` write followed by
the sweep's resume) decremented again: one unit sold, two gone.
**Fix** (`orders.rs` `take_line`): in one transaction, insert the order's hold
first (`ON CONFLICT DO NOTHING`) and decrement only if it was inserted; the
unique key makes a concurrent take wait and then do nothing. `rollback_decrements`
gives back a held line in one statement (delete-hold-and-restore), like
`release_order_stock`. Checked on a scratch Postgres 17, including two concurrent
takes.

### C19 — The seller's ownership lost a sold unit twice (TLC)
`bugs/ownership-twice.cfg`: the decrement and `ownershipDone` were separate
writes; a fulfilment that died in between (or two fulfilments of one order)
decremented again.
**Fix** (`decrement_ownership_once`): the decrement and a `saleKeys` entry
(`<order>:<listing>`, last 50 kept) commit in one Firestore transaction.
**Tests**: `orders::tests::ownership_sale_keys_apply_once_and_stay_bounded`,
`firestore_flow::a_sale_key_decrements_the_ownership_row_once`.

### C20 — Two orders sharing the CardTrader cart are bought twice (TLC)
`bugs/buy-shared-cart.cfg`: Pokoin buys through one CardTrader account, i.e. one
cart. Two fulfilments (API and sweep) both see an empty cart and both add; the
first purchase buys both items; the second purchase fails on the empty cart, is
marked `failed`, and the sweep buys that line again. Real money, twice. Node had
the same design.
**Fix** (`cardtrader_adapter.rs`): a cart lock (Firestore transaction on
`cardtrader_purchase_locks/cart`, per-call owner, 5-minute TTL) held from before
the marker claim to after the last marker write; a busy cart fails the step and
the sweep retries.
**Test**: `cardtrader_adapter::tests::a_held_cart_is_never_shared_by_two_purchases`.

### C21 — A purchase whose answer was lost was bought again (TLC)
`bugs/buy-lost-answer.cfg`: any error after `POST /cart/purchase` (a timeout, or
the `purchased` marker write failing after a successful purchase) marked the
line `failed`, which the next claim re-acquires. Node the same.
**Fix**: errors after the purchase request was sent mark `purchase_unknown`,
which is busy (never retried automatically) until someone reconciles the
CardTrader order.
**Test**: `cardtrader_adapter::tests::a_lost_purchase_answer_is_never_bought_again`.

### C22 — A paid order could stay unfulfilled forever (TLC, liveness)
`bugs/paid-never-fulfilled.cfg`: if the process dies between the paid write and
the fulfil call, or the fulfil call fails before taking its lease, the order is
`paid` with `fulfillment.state = pending`. The webhook already answered 200, and
the sweep only resumes `running`/`partial`. Node the same.
**Fix** (`jobs/eur.rs` `unfinished_queries`): the sweep also resumes `channel =
eur`, `paymentStatus = paid`, `fulfillment.state = pending` (equality filters
only, no composite index).
**Test**: `jobs::eur::tests::sweep_resumes_paid_orders_whose_fulfilment_never_started`.

Not changed, by design: the CardTrader stock decrement after a Pokoin sale
(`sync_line`) stays at-least-once — a missed decrement oversells on CardTrader,
a doubled one under-lists and is mirrored by the reconcile. The Stripe event id
is still claimed before processing (a failed handler's retry is a duplicate);
recovery is the sweep's `recover_paid` plus C22.

## Spec corrections (the model was wrong, not the code)

- `eur-fulfilment` liveness first failed because the lease owner was the caller,
  so a crashed sweep call that the sweep re-ran looked alive. The code's lease
  belongs to one call (`startedAt`); the spec now orphans a dead call's lease.
- `listing-outbox` `bugs/ghost-destroy-failure.cfg` first reproduced the
  deactivation race of C12 (BFS finds it first); the scenario constant
  `LinkedDeactivate` isolates the destroy failure.
- `listing-outbox` was split into `Model.cfg` (CardTrader side) and `cache.cfg`:
  together the state space did not finish (over 120 million states and growing),
  and the read cache does not interact with the CardTrader push.
