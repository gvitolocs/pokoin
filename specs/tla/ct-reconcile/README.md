# CardTrader seller reconcile vs the order webhook

`Model.tla` models one connected seller: CardTrader products with a quantity,
Pokoin listings linked to them (`source_listing_id = ct:<id>`), two reconcilers
and the CardTrader order webhook, all interleaved one SQL or Firestore call at a
time. `Fixed = FALSE` is origin/main at `00bc3d2c`; `Fixed = TRUE` is this
branch. Findings and their resolutions: [`../FINDINGS.md`](../FINDINGS.md).

## What is modelled

| Spec | Rust code (this branch) |
| --- | --- |
| `ct`, `CtSale`, `CtCancel`, `CtDelist` | CardTrader itself: a product leaves `/products/export` when sold out or removed |
| `lst` | `marketplace_user_listings` (`LOAD_SELLER_LISTINGS_SQL`, `pokoin-rust/crates/external/src/cardtrader/sync.rs:15`) |
| `links` | `marketplace_cardtrader_product_links` |
| `Start`, `LoseLock`, `Finish` | Redis lock `SET NX EX 900`, owner-checked release: `async_sync.rs:22`, `:47`, `:62`; the timer job's copy `apps/api/src/jobs/cardtrader.rs:173`. `LoseLock` is the 15-minute TTL expiring under a long run (no renewal) or Redis being down (`acquire` then hands out a degraded lock) |
| `Fetch`, `FetchFailed` | `fetch_products_export` (`sync.rs:696`); `ReadModes` is how `normalize_product` read each row's id: `ok`, `empty` (the 2026-10-09 class), `alien` (non-integer text such as `12.0`), `nogame` (game unreadable/unsupported), `wrong` (a valid but wrong integer) |
| `Load` | `load_seller_listings` (`sync.rs:750`) — a snapshot, taken after the export |
| `Plan` / `PlanOf` | `plan_inventory_reconcile` (`sync_core.rs:467`): id filter `:492`, `seen_product_ids` `:500`, `AlreadyLinked`/`UpdateQty` `:522`, `Import` `:544`, unparsed gate `:572`, removal candidates `:577`, `mass_removal_guard` `:603` (`MASS_REMOVAL_MIN` `:624`, scaled to `MassMin`) |
| `ApplyStep` `update` / `ApplyQty` | `apply_ct_quantity_since` / `APPLY_CT_QUANTITY_SQL` (`sync.rs:396`, `:95`, raise guard `:116`), export start from `writer_clock` (`sync.rs:411`, `:695`) |
| `ApplyStep` `import_find` + `import_insert` (origin) / `import_atomic` (fixed) | `create_imported_listing` (`sync.rs:455`): find by source then insert; fixed: one writer transaction under `pg_advisory_xact_lock` (`sync.rs:489`); `Reactivate` = `REACTIVATE_HIDDEN_SQL` |
| `Orders`, `Remove` | destructive pass (`sync.rs:870`): `fetch_seller_orders` (`:901`), `Sold` → quantity 0 + claim the missed sales (`:911`), `Delisted`/`Unknown` → `delist_ct_listing` (`:953`) |
| `WhFind` | `find_linked_listing` (`webhook.rs:123`) |
| `WhClaim` | `claim_webhook_event` (Firestore create = claim, `webhook.rs:189`) |
| `WhDecrement` | `DECREMENT_SQL` (`webhook.rs:155`); failure releases the claim (`webhook.rs:410`) |
| `WhRecord` | listingId merge + `record_cardtrader_sale` (`webhook.rs:419`, `:210`) |
| `WhCancelClaim`, `WhRestore` | `restore_cancelled_item` (`webhook.rs:263`) |
| `fallback` | `retrySync` → fallback reconcile (`webhook.rs:446`, `routes/cardtrader.rs:187`) |

Ghost variables (not in the code) carry the invariants: `acc[l]` is the set of
sales already reflected in listing `l`'s quantity, `dirty[r]` the listings
written after reconciler `r` fetched its export (`updated_at > export start`).

## Properties

| Property | Meaning |
| --- | --- |
| `NoFalseDeactivation` | A listing whose CardTrader product is present in the export is never delisted or zeroed by a removal. Covers an export read as empty, partly unreadable, garbled, or with skipped games. |
| `GuardBound` | No run removes more than `mass_removal_guard` allows, measured against the listings linked **before** the run. |
| `NoDoubleCount` | A sale is written to `marketplace_sales` at most once. |
| `NonNegative` | `quantity_available >= 0`. |
| `NoStaleResurrection` | A reconcile never raises a listing back above a sale the webhook already took off. |
| `UniqueLink` | At most one live Pokoin listing per CardTrader product (no duplicate imports by racing reconcilers). |
| `NoDoubleDecrement`, `NoDoubleRestore` | A webhook sale/cancel is not applied on top of an export that already reflected it. **Accepted design race**, see FINDINGS (checked by `design/*.cfg`). |
| witnesses `Never*` | Must be *violated* by the fixed model: delisting, importing, quantity updates and webhook sales all still happen. |

## Configs

| Config | Expectation | Result on nezopt (12 cores) |
| --- | --- | --- |
| `Model.cfg` | fixed, all safety invariants hold | 48,360,531 distinct states, depth 31, ~7 min |
| `bugs/empty-ids-partial.cfg` | origin: `NoFalseDeactivation` violated | counterexample, 8 states |
| `bugs/alien-ids.cfg` | origin: `NoFalseDeactivation` violated | counterexample |
| `bugs/nogame-not-seen.cfg` | origin: `NoFalseDeactivation` violated | counterexample |
| `bugs/guard-dilution.cfg` | origin: `GuardBound` violated | counterexample, 14 states |
| `bugs/duplicate-import.cfg` | origin: `UniqueLink` violated | counterexample, 14 states |
| `bugs/stale-resurrection.cfg` | origin: `NoStaleResurrection` violated | counterexample, 10 states |
| `design/double-decrement.cfg`, `design/double-restore.cfg` | fixed: accepted race reproduced | counterexamples |
| `witness/*.cfg` | fixed: behaviour reachable | violations found |

Constants of `Model.cfg`: two products (`p1` linked with quantity 2, `p2` on
CardTrader only), three listing rows, two reconcilers with one run each, one
lost lock, one sale, one cancellation, one delisting, one webhook redelivery,
read modes `ok/empty/alien/nogame`, `MassMin = 0` (so the guard is live with
one or two linked listings). Symmetry over the two reconcilers.

Run: `specs/tla/run.sh ct-reconcile` (add `--regressions` for the rest).
