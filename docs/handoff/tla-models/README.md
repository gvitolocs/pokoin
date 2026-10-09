# Handoff: TLA+ / TLC models

Saved from the nezopt session "TLA+ / TLC models of sync, reconcile, lease" (stopped 2026-10-09 to move the work to a cloud session). It had downloaded tla2tools.jar (4.5 MB, on nezopt at `~/.local/share/tla/tla2tools.jar`) and was reading the Rust code. No specs were written yet.

## Task (continue from here)
Repository gvitolocs/pokoin (Rust workspace pokoin-rust/). Goal: write TLA+ specifications of the concurrent and stateful parts of the Rust API, and check them with the TLC model checker. Fix in the Rust code every real violation TLC finds, and add a regression test for each fix.

Background: on 2026-10-09 a Rust port bug in the CardTrader seller reconcile read numeric product ids as empty strings, saw an "empty" inventory, and deactivated 12,918 listings until they were restored. The fix (PR #279) added the unparsed_export and mass_removal_guard checks. The concurrent state machines should be verified, not trusted.

Tooling: download tla2tools.jar from github.com/tlaplus/tlaplus/releases (Java 11+). Add specs/tla/run.sh, which runs TLC on every model with `java -XX:+UseParallelGC -jar tla2tools.jar -workers auto -config Model.cfg Model.tla` and exits non-zero on any violation. Use one folder per model under specs/tla/, each with Model.tla, Model.cfg and a README that maps the spec to the Rust code with file:line references. Use small constants and symmetry sets.

Models:

1. CardTrader seller reconcile.
   - Code: pokoin-rust/crates/external/src/cardtrader/sync.rs and sync_core.rs (plan_inventory_reconcile, the destructive gate, mass_removal_guard, unparsed_export), the Redis reconcile lock (async_sync.rs), and the concurrent webhook (webhook.rs).
   - Model: complete, failed, partial and unparseable exports; listings and links; concurrent webhook sales; two reconcilers racing (lock lost or expired).
   - Invariants:
     - A listing whose product is present in a complete export is never deactivated.
     - Removals stay within the guard.
     - No sale is double-counted or double-decremented.
     - Quantity is never negative.
     - An export read as empty cannot slip past the guards.

2. Listings outbox sync engine.
   - Code: pokoin-rust/crates/commerce/src/listing_sync.rs (enqueue in the writer transaction, CLAIM with FOR UPDATE SKIP LOCKED, attempts/available_at retries, apply_event: price refresh, generation bumps, invalidation, live publish, CardTrader push/link/destroy) and handlers/listings.rs.
   - Model: several workers, crashes between steps, retries.
   - Checks:
     - Every committed change is eventually applied (liveness, under fairness).
     - A CardTrader push/destroy is issued at most once per event, or is shown to be idempotent.
     - No cache invalidation happens before its write is visible.
     - No event is lost when a worker dies.

3. EUR order fulfilment.
   - Code: pokoin-rust/crates/commerce/src/handlers/orders.rs (fulfil_paid_eur_order: the Firestore transaction lease, inventory reserved → committed or conflict/needs_refund, ownership decrement, CardTrader buy-through/sync, the notifications marker), handlers/stripe.rs, and the sweep job pokoin-rust/apps/api/src/jobs/eur.rs. All of these race.
   - Invariants:
     - Stock is reserved at most once per line, and released or committed exactly once.
     - A CardTrader buy-through runs at most once per line.
     - An order is never both released and fulfilled.
     - A paid order eventually ends done, conflict or needs_refund.

Run TLC to completion. For every counterexample, decide whether the spec or the code is wrong and fix that side: the Rust code with a test, or the spec. Record every counterexample and its resolution in specs/tla/FINDINGS.md.

Verify: specs/tla/run.sh passes and `cd pokoin-rust && cargo test --workspace` passes.

Work on branch `feature/tla-models`. End commit messages with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". Open a DRAFT PR with the models, state counts and findings, with a body ending "🤖 Generated with [Claude Code](https://claude.com/claude-code)".

Do NOT merge or deploy.
