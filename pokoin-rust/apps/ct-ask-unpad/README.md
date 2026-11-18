# ct-ask-unpad

Takes the 200 PKN shipping pad out of the stored CardTrader lowest ask in
`public.cardtrader_blueprint_daily_analytics` (database `pokoin_marketplace`).

Until 2026-09-21 the CardTrader price cache converted a EUR ask to PKN and then
added a flat 1 EUR — 200 PKN — on top. The job is fixed; the history it had
already written is not, so a card page reads a "CT lowest ask" 200 PKN too high
for the days below.

## The rule

One row per `(observed_day, blueprint_id)`. A row is corrected when

* `observed_day` is between **2026-08-31** and **2026-09-19** (the days the pad
  covers — 2026-09-20 to 2026-09-22 hold no rows),
* it carries a price, and
* `min_price_pkn >= 200`, so no price goes negative, and
* that stored price is **not** also the price of a Pokoin native listing of the
  same card that existed on that day (`marketplace_user_listings`, joined to the
  blueprint through `marketplace_search_candidates.ct_id`). A native ask was
  never padded, so such a row may be right as it stands and is skipped, counted
  and printed by `plan`.

A corrected row loses 200 PKN in all four price columns — `min_price_pkn`,
`median_price_pkn`, `average_price_pkn`, `max_price_pkn`, which the job always
wrote with the same value. No other column is named in the update, so
`refreshed_at` and everything else stays.

`previous_min_price_pkn` and `price_change_pct` are then re-derived from the
corrected series, exactly as `scripts/sql/listing-pipeline.sql` defines them: the
same blueprint's `min_price_pkn` on the nearest earlier `observed_day`, and
`(min - previous) / previous`. That applies to the priced rows of the window and
to **2026-09-23**, whose own prices are right but which compares itself against a
2026-09-19 that carries the pad. **2026-08-10** and **2026-09-24** are outside the
change, and `verify` proves 2026-08-10 was never written.

## The backup table

`apply` writes into the table named by `--backup-table` (1 to 51 characters of
`[a-z_][a-z0-9_]`, always in `public`, always quoted) before it writes the live
row, in the same transaction: the key plus the six old values plus `fixed_at`.
That table is what makes the run idempotent — a row it holds is never touched
again, so a second `apply` changes 0 rows — and what makes it reversible.

Do not name it with the `cardtrader_` prefix: those relations are the
Oracle-to-Pi replica set, and this table belongs to the writer only.

## Commands

The connection URL comes from the environment variable named by
`--database-url-env`, default `MARKETPLACE_DATABASE_URL`. It is never an
argument, and it is never printed: a connect failure is reported with the URL
redacted. Run the writes on the writer; `apply` and `revert` refuse a host that
answers `pg_is_in_recovery()`.

```bash
cd pokoin-rust

# read only, sets default_transaction_read_only = on
cargo run --release -p ct-ask-unpad -- plan
cargo run --release -p ct-ask-unpad -- plan --backup-table ct_ask_unpad_backup

# the change: one observed_day per transaction, lock_timeout = 3 s
cargo run --release -p ct-ask-unpad -- apply  --backup-table ct_ask_unpad_backup

# read only; exit status 1 when anything does not match the rule
cargo run --release -p ct-ask-unpad -- verify --backup-table ct_ask_unpad_backup

# every old value back, the backup rows deleted, one day per transaction
cargo run --release -p ct-ask-unpad -- revert --backup-table ct_ask_unpad_backup
```

`plan` is the default verb and reads exactly the SQL text `apply` writes, so the
counts and the samples are what the change will do. It reports per day: rows,
priced rows, rows to change, blueprints, rows un-padded, rows whose previous
value only is what moves, rows skipped for a native ask, rows already recorded in
the backup table, and rows with no price. Days of the window that hold no rows at
all are printed as such, and the ten sample rows are the five cheapest and five
dearest by the new price, before and after.

A run that dies half way is continued, not undone: the days already recorded are
skipped and the rest are still to do. `verify` reads the whole window again, so
`verify` — not a second `apply` — is how you confirm the work.

## Tests

```bash
cargo test -p ct-ask-unpad                                  # unit tests only
apps/ct-ask-unpad/tests/container.sh                        # end to end on Postgres 17
apps/ct-ask-unpad/tests/container.sh --nocapture            # and show the plan it read
```

On nezopt both go through the build queue:
`~/.local/bin/bq run --class long --who <slug> --max-wait 5400 -- apps/ct-ask-unpad/tests/container.sh`.

`container.sh` starts its own throwaway `postgres:17-alpine` on a loopback port,
runs `tests/fixture.rs` against it and removes the container whichever way the
test went. The fixture seeds 21 rows over 2026-08-10, 08-31, 09-01, 09-17, 09-18,
09-19, 09-23 and 09-24 — a cheap card (222 → 22), an expensive one
(40328 → 40128), a native-priced row that must be left alone, a card that first
appears on 2026-09-01, a card under the pad, a card with no price — and asserts
every value of the table after `plan`, after `apply`, after a second `apply`,
after `verify` on a hand-corrupted row, and after `revert`. It only runs when
`CT_ASK_UNPAD_TEST_DATABASE_URL` names a database it owns; the unit tests need no
database.
