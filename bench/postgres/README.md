# Postgres version benchmark

Compares two Postgres servers holding the same marketplace data: today's
writer major (17) against the next one (19), on the queries and jobs Pokoin
actually runs. The results feed the upgrade decision in
[docs/POSTGRES_VERSION.md](../../docs/POSTGRES_VERSION.md).

## What it measures

| Workload | What it is | Where it comes from |
| --- | --- | --- |
| `sold_daily_rebuild` | `refresh_cardtrader_sold_daily(null)`, the nightly full rebuild | `oracle-postgres/schema/102_sold_daily_set_based_rebuild.sql` |
| `observations_analytics` | median price per blueprint over every price observation | sold-graph style aggregate |
| `book_create_index`, `book_vacuum_analyze` | index build and vacuum on the 1.5M-row CardTrader book | maintenance |
| `card_desk` | one card page: printing, Pokoin listings, sold graph, CardTrader book | card-page reads |
| `search` | trigram match on `search_text`, then the name-prefix index | search fallback and typeahead hydration |
| `set_page` | every printing of one expansion | set desk |
| `listing_writes` | create a listing, reprice the card's newest one (audit trigger) | listing writes |
| `book_upsert` | upsert of a live CardTrader listing | the daily dump persist |
| `tpcb`, `select_only` | pgbench's built-ins, scale 50 | generic reference |

pgbench workloads run 8 clients on 4 threads for 30 s after a 5 s warm-up;
each workload and job runs 3 rounds, alternating which server goes first.
The report gives the median round, with min and max.

## Data

`load-schema.sh` replays every migration from CardVault's
`oracle-postgres/schema` and this repo's `scripts/sql` in order (138 of 142
files apply on an empty database; the rest need production rows or objects
only production has, see the report it writes), after `base-stubs.sql`.
`seed.sql` then fills the tables the workloads touch, deterministically:
70,728 printings built from the real typeahead dictionary (one per unit of a
name's prior, which is its printing count), a 1.5M-listing CardTrader book,
1.2M removals with 1.37M removed-sale observations over 60 days, and 200k
Pokoin listings, with popularity skewed so most traffic hits a few cards.

## Running it

```bash
OUT=/path/to/pg          # outside the repo
bench/postgres/build-pg.sh REL_17_11 17 "$OUT"
bench/postgres/build-pg.sh REL_19_BETA4 19 "$OUT"
# initdb the 17 cluster (-U pokoin_marketplace, UTF8), include postgresql.bench.conf, start it, createdb pokoin_marketplace
bench/postgres/load-schema.sh "$OUT/inst17/bin/psql" "host=... port=... user=pokoin_marketplace dbname=pokoin_marketplace" ../cardvault schema.tsv
psql ... -v scale=1 -v names_tsv=names.tsv -v sets_tsv=sets.tsv -f bench/postgres/seed.sql
# stop it, copy the data dir, initdb 19 with --no-data-checksums, pg_upgrade --link the copy, start both
bench/postgres/run.py --pgbench "$OUT/inst19/bin/pgbench" --psql "$OUT/inst19/bin/psql" \
  --server "17=host=/sock,port=54317" --server "19=host=/sock,port=54319" \
  --out bench/postgres/results/<date>.json
```

`names.tsv` and `sets.tsv` are `display<TAB>prior[<TAB>nationality]` dumps of
`market/src/data/suggest-names.js` and `suggest-sets.js`.

On production data, `scripts/postgres-major-upgrade.sh rehearse <version>`
leaves a 17 copy and its 19 upgrade side by side on nezopt; point `run.py` at
those two to repeat the comparison on the real catalogue.
