# Listings outbox sync engine

`Model.tla` models one seller listing `L` through the durable outbox: HTTP
mutations that write the row and enqueue a `listing.changed` event in one writer
transaction, two API instances draining the outbox, the CardTrader product the
listing is pushed to and destroyed from, the lagging Pi replica, and the read
cache filled from it. Any worker can die or error at any step, and a 30-second
lease can expire under a worker that is still running. `Fixed = FALSE` is
origin/main at `00bc3d2c`; `Fixed = TRUE` is this branch. Findings:
[`../FINDINGS.md`](../FINDINGS.md).

## What is modelled

| Spec | Rust code (this branch) |
| --- | --- |
| `CreateListing` | `create_listing` with `targets.cardtrader` (`pokoin-rust/crates/commerce/src/handlers/listings.rs:596`): insert + `sync::enqueue` in one transaction (`:650`, `listing_sync.rs:244`, `INSERT_SQL` `:15`) |
| `UpdateListing`, `DeactivateListing` | `update_listing` (`listings.rs:828`). origin decides `destroyCardtrader` from `existing`, read on the replica before the transaction; fixed reads the source under the row lock on the writer (`listings.rs:873`) |
| `RequestBump` | `finish_write` → `sync::invalidate` after commit (`listings.rs:473`, `listing_sync.rs:310`) |
| `Replicate` | Pi hot-standby streaming replica (`MARKETPLACE_DATABASE_URL`) |
| `FillStart`, `FillEnd` | `read_cache.rs`: read the generation (`apps/api/src/read_cache.rs:57`), render from the replica, `SET … EX` (`:101`) |
| `Claim` | `CLAIM_SQL` (`listing_sync.rs:18`): lowest pending id, `attempts + 1`, `available_at = now() + 30s`, `attempts < 8` (`MAX_ATTEMPTS`, `:17`, scaled to `MaxAttempts`) |
| `LeaseExpire` | `available_at` passes; with `SlowWorkers` the holder may still be running (two instances, Pi + k3s) |
| `Price` | `refresh_price` (`listing_sync.rs:495`) |
| `Gen` | card/search `INCR` + `publish_listing` (`listing_sync.rs:501`, `:512`); fixed first waits for the replica (`await_replica`, `:337`) |
| `CtStep` | origin: source from payload or writer row, empty ⇒ `push_listing(link)`; fixed: `push_cardtrader` (`:403`) claims `""` → `ct:pending:<event>` (`CLAIM_PUSH_SQL` `:390`, `push_plan` `:379`) |
| `CtCreate` | `POST /products` via `push_product_outcome` (`crates/external/src/cardtrader/push.rs:159`): created, rejected (`RELEASE_PUSH_SQL` `:391` frees the claim), or in doubt (`client.rs:393` `write_in_doubt`: no answer or 5xx) |
| `Link` | origin: unconditional `source_listing_id` update; fixed: `LINK_PUSH_SQL` (`:388`) over our claim only and, if the listing went off sale (or the claim is gone), a destroy event enqueued in the same transaction (`:440`) |
| `Destroy`, `DestroyCall` | `destroy_product` (`listing_sync.rs:66`); fixed: `destroy_result` (`:104`) — a 404 is done, any other failure retries |
| `Finish` | `processed_at = now()` (`:569`) |
| `Crash` | process death, or `apply_event` returning `Err` (the claimed payload is kept, so in-memory steps are lost) |
| `ReconcileLink`, `ReconcileImport` | the 5-minute CardTrader reconcile (see `../ct-reconcile`): `LinkExisting` by `user_data_field = pokoin:<listing>` for an active listing, otherwise an import that mirrors the live product |

`pushes[e]`, `syncedVer`, `mirror` are ghost variables for the properties.

## Properties

| Property | Meaning |
| --- | --- |
| `AtMostOncePush` | The CardTrader create is issued at most once per event and per listing. |
| `NoGhostProduct` | Once every event is applied and the reconcile has run, every live CardTrader product is mirrored by an active Pokoin listing (no card left for sale on CardTrader after the seller removed it on Pokoin). |
| `NoStaleCacheAfterSync` | After the consumer applied version `v`, no cache entry under the current generation shows the listing older than `v` (no invalidation before the write is visible to the readers that refill the cache). |
| `AllApplied` (liveness, `FairSpec`) | Every committed change is eventually applied, with a crash below the attempt budget. |
| `NoDeadLetter` | **Accepted residual**: failures (or slow workers) that use up every attempt dead-letter the event (`design/dead-letter.cfg`); this branch logs `pokoin_sync_dead_letter` as Node did. |
| destroy idempotence | `DestroyCall` destroys a live product or answers 404 for a destroyed one: issuing it twice is harmless, so destroy is shown idempotent rather than at-most-once. |

## Configs

| Config | Expectation | Result on nezopt (12 cores) |
| --- | --- | --- |
| `Model.cfg` | fixed, CardTrader side (`AtMostOncePush`, `NoGhostProduct`) | 122,462,169 distinct states, depth 81, ~12 min |
| `cache.cfg` | fixed, read cache (`NoStaleCacheAfterSync`) | 7,138,295 distinct states, depth 54, 34 s |
| `liveness.cfg` | fixed, `AllApplied` under weak fairness | 211,965 distinct states, depth 33 |
| `bugs/duplicate-push-crash.cfg` | origin: `AtMostOncePush` (worker dies between create and link) | counterexample, 15 states |
| `bugs/duplicate-push-ambiguous.cfg` | origin: `AtMostOncePush` (create answer lost) | counterexample |
| `bugs/duplicate-push-slow-lease.cfg` | origin: `AtMostOncePush` (lease expires under a slow push) | counterexample, 14 states |
| `bugs/ghost-after-deactivate.cfg` | origin: `NoGhostProduct` (deactivated while the push was in flight) | counterexample, 18 states |
| `bugs/ghost-destroy-failure.cfg` | origin: `NoGhostProduct` (destroy failure reported as done) | counterexample, 19 states |
| `bugs/stale-cache-after-sync.cfg` | origin: `NoStaleCacheAfterSync` | counterexample, 8 states |
| `design/dead-letter.cfg`, `design/replica-timeout.cfg` | fixed: accepted residuals reproduced | counterexamples |
| `witness/*.cfg` | fixed: push, destroy, full processing and a fresh cache fill are reachable | violations found |

Constants of `Model.cfg`: two workers, a create plus two updates/deactivations,
three attempts, one crash, one lost and one rejected create, one failed destroy,
leases that can expire under a live worker. Symmetry over the workers (not in
`liveness.cfg`).

Run: `specs/tla/run.sh listing-outbox` (add `--regressions` for the rest).
