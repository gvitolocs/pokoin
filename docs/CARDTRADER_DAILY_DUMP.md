# CardTrader daily listing dump

`pokoin-all-cardtrader-daily` (nezopt user unit, 23:00 UTC) runs
`scripts/run-all-cardtrader-daily.sh`: catalogues, pictures, artwork, and in
parallel the raw listing books of every live game, one book per expansion,
into `/home/nez/data/pokoin-catalog-refresh/daily/<UTC date>/listing-books/`.

## Pieces

| Where | What |
|---|---|
| nezopt | `pokoin-cardtrader-listing-dump` (`pokoin-rust/apps/cardtrader-listing-dump`): order, resume, deadline, status, storage |
| nezopt | `pokoin-cardtrader-price-cache` (`pokoin-rust/apps/cardtrader-price-cache`): those books → each game's price cache |
| nezopt | `pokoin-cardtrader-sold` (`pokoin-rust/apps/cardtrader-sold`): those books → the sold graph of every game except Pokémon |
| Oracle `pokoin-marketplace` | `pokoin-cardtrader-bridge` (`pokoin-rust/apps/cardtrader-bridge`): CardTrader GETs; the token never leaves Oracle |
| both | `ctbook` (`pokoin-rust/crates/ctbook`): the `.ctb` book format and a CLI |

The dump starts the bridge over ssh and talks one JSON line per request and
reply (the protocol of the Python originals, `scripts/dump-all-cardtrader-listings.py`
and `scripts/cardtrader-fetch-bridge.py`, which stay as the fallback: the run
script uses the Python dump when `/home/nez/pokoin-cardtrader/current` is missing).

## Behaviour

- Order: expansions with printings imported since the run date first, then
  Pokémon, then the other games, newest expansion first.
- Up to `POKOIN_DUMP_INFLIGHT` (3) books in flight; the bridge still starts
  listing requests 1.05 s apart and honours the shared 403/429 cooldown file
  (`/tmp/pokoin-catalog-cardtrader-cooldown.json` on Oracle, 5 min or the
  server's longer `Retry-After`). 401 is reported at once; a 403/401 reply
  stops the run with `blocked` in the status.
- The bridge streams each book to an unlinked temp file and then out, so its
  memory stays flat on the 1 GB VM.
- Wire compression: the dump asks for `"encoding":"zstd"`; the bridge
  compresses each book on the fly (level 3, a 32 MB book becomes ~1.2 MB in
  ~0.5 s) and answers `{"id":N,"encoding":"zstd","bytes":L}` + L bytes. The
  Oracle → nezopt link only moves ~4-5 MB/s, so this removes most of the
  transfer time. `POKOIN_CT_ENCODING=none` turns it off; plain line replies
  (the Python bridge) are always understood.
- Resume: books already in the folder (`.ctb`, or `.json.gz` from the Python
  dump) are counted and skipped; a truncated or unreadable one is renamed
  `.corrupt` and fetched again.
- Deadline: `POKOIN_DUMP_MAX_SECONDS` (36000) plus
  `POKOIN_DUMP_INFLIGHT_GRACE_SECONDS` (1800) for books in flight; then
  `stoppedAtDeadline` (or `abandonedExpansionId`) and exit 75.
- `listing-dump-status.json`: the Python fields (`completed`, `listings`,
  `errors`, `newPrintingExpansions…`, `finishedAt`, …) plus `bookFormat`
  (`ctb2`), `inFlight` and `sellerRecords`. Exit 1 when any book failed, 0 when
  all were stored.

## Sellers

The same few thousand sellers appear in every book of a night. Each listing's
`user` object is stored once per night in `listing-books/sellers.jsonl`
(append-only, one compact JSON record per line, line number = reference) and
the book keeps only the reference (header `CTB2`). Every distinct record is
kept, so it stays lossless. Keep `sellers.jsonl` with the books: a `CTB2` book
does not decode without it. About 16% smaller books and 44% less encode CPU.

## `.ctb` books

Lossless: `ctbook decode <file>.ctb` prints exactly the JSON CardTrader sent
(it reads `sellers.jsonl` from the same folder). Header `CTB1`/`CTB2` +
blueprint count + listing count + payload length, then brotli (q9) of a
columnar document (see `crates/ctbook/src/lib.rs`). About 5x smaller than the
old gzip JSON. `ctbook stats <book.json.gz>…` measures sizes, timings and the
round trip.

Converting stored `.json.gz` books: `ctbook convert --delete --jobs 4 <folder>/*.json.gz`
writes each `.ctb` with that folder's `sellers.jsonl`, reads it back from disk,
compares it byte for byte with the original, and only then deletes the
`.json.gz`; a mismatch keeps the original.

## Prices

After the dump, `run-all-cardtrader-daily.sh` runs `pokoin-cardtrader-price-cache`
when that binary is installed (`POKOIN_CT_PRICE_BIN` overrides the path). It
runs even if the dump stopped at its deadline: scope is only the expansions
whose book decoded, minus `listing-dump-status.json` `errors`.

For each game it creates `public.cardtrader_blueprint_listing_cache` and
`public.cheapest_homepage_cache_blueprint` if they are missing (a no-op on
Pokémon, where they already exist), then upserts one winner per in-scope
blueprint and deletes stale `cardtrader` / `pokoin_native` rows in that scope.
Rows outside the scope are left alone. A book that does not decode is skipped
and counted.

A CardTrader offer is eligible when the seller is Zero (`can_sell_via_hub` or
`can_sell_sealed_with_ct_zero`) or the name matches 1-day ready, quantity is a
positive integer, and the price is a positive EUR amount. The stored
`shipping_mode` label prefers 1-day ready when the name matches, otherwise
`zero` when a Zero flag is set. PKN is `eur / PKN_CHECKOUT_USDT_PRICE` (the
rate defaults to 0.005, so €1 is 200 PKN). The cheapest PKN wins; a Pokoin
native listing wins a tie, then the listing id. Counts are the winning
provider's rows. Native listings are the active shippable rows in
`pokoin_marketplace.marketplace_user_listings` for that game slug; listing
`card_id` is the public Pokoin id (blueprint × 2), so even ids compete on
`card_id / 2`. `pokoin_card_id` on each cache row is the search-candidate
`card_id` when present, otherwise `blueprint_id * 2`.

`--dry-run` computes the same winners and only reads the databases.
`--game <slug>` limits the run (`pokemon` for CardTrader game 5). The run
writes `<root>/price-cache-status.json`.

## Sold graph

The card desk's sold graph and "Market price" read `cardtrader_sold_daily` from
the card's game database (`GET /api/marketplace-card-sales`). For Pokémon the
Oracle job `pokoin-cardtrader-daily-market-refresh` fetches the Pokémon
expansions a second time and runs the writer's persist SQL (MARKET.md "Sold
comps"). Until 2026-10-20 nothing built it for the other games: their books
and price cache existed, but every desk said "No sold-card analytics yet".

After the price cache, `run-all-cardtrader-daily.sh` runs
`pokoin-cardtrader-sold` when installed (`POKOIN_CT_SOLD_BIN` overrides the
path, `POKOIN_CT_SOLD=off` skips it). It replays the last 16 nights of books of
every game but Pokémon through the same rules, one expansion book per persist
step and the finalize after each night:

- the seller stack is seller + blueprint + condition + language + reverse/foil +
  1st edition + graded (D00002Q, D00002S); a new listing id for the same stack is
  `listing_id_rotated`; `quantity_decreased` is a same-id drip;
- a vanished stack counts after 3 complete absences (093) and only when the
  listing was in the book at least 3 days (101); 088 continuity, the observation
  sanity freeze, seller vacation (D00003W) and store withdrawal (103) as in SQL;
- only removed-sale rows of one day per listing and no longer live, as
  `refresh_cardtrader_sold_daily`.

It writes only `cardtrader_sold_daily` (migration 131) for removed days
`[from + 4, to]`; the first four nights rebuild the live book. Older days keep
what earlier runs wrote, so a day stops changing once it leaves the 10-day
correction window. The per-listing history stays in memory: nothing but the
daily rows reaches the writer or the Pi replica. The graph's newest two days
fill in over the next nights (3 complete absences), as on Pokémon.

Two rules are new for the other games:

- The language is the game's own `<game>_language` property when none of the
  Pokémon/Magic keys is set (`yugioh_language`, `onepiece_language`, …). Foil
  (`<game>_foil`, `fab_foil_new`) is a stack facet and fills the `reverse`
  column; the desk labels that chip "Foil" outside Pokémon.
- An expansion whose book was missing on earlier nights (the partial dumps of
  8–11 Oct 2026) marks the next night's vanishes `complete_book_cutover`, not
  sales: what left over several nights would land on one day, like the
  11–12 Sep cutovers (D00000G, D00000R). Same-id drips still count.

`--dry-run` computes and reports without writing; `--compare` also reads the
stored rows of the same days, and `--game pokemon --dry-run --compare` is the
parity check against the Oracle job (it refuses to write Pokémon). On
2026-10-20, 8–19 Oct: 92,819 rows replayed vs 91,697 stored, 85,865 keys in
both, 84,188 of them with the same median; 12–19 Oct within a few percent per
day. `--sample <blueprint>` prints that printing's episodes and rows. `--from`,
`--to`, `--write-from` set the range (a backfill), `POKOIN_CT_SOLD_THREADS` the
decode threads (6). The run writes `<root>/sold-status.json`
(`sold-dry-status.json` for a dry run). About 13 s per Pokémon-sized night;
the 15 other games take about 20 minutes for 16 nights.

`pokoin-api job build-lists --kind=median` (the `build-lists-medians` CronJob)
now also stores each CardTrader game's tile medians in
`marketplace_card_daily_median`; Cardmarket-only games keep the Cardmarket
trend there.

## Deploy

```bash
scripts/deploy-cardtrader-dump.sh   # clean origin/main checkout on nezopt
```

It builds the binaries, installs the bridge on Oracle (checks glibc ≤ 2.35
and a dry start), and switches `/home/nez/pokoin-cardtrader/current`. Rollback:
point `current` at the previous release, or remove it to fall back to Python.

### Job code (the scripts)

The unit runs the scripts from `~/pokoin-deploy/cardtrader-daily`, a detached
checkout of `origin/main` (`deploy/systemd/pokoin-all-cardtrader-daily.service`,
`WorkingDirectory`). It never runs from the canonical checkout
`~/Projects/pokoin-web`: until 2026-10-19 it did, and ran another agent's
uncommitted, 850-commit-old copies of these scripts every night. After a merge
that changes the job's scripts or its unit:

```bash
scripts/deploy-cardtrader-daily-checkout.sh   # from any checkout; default origin/main, or pass a sha on main
```

It fetches, refuses a commit that is not on `origin/main`, waits for a running
job (it takes the job's `daily.lock`), moves the checkout with
`checkout --force` + `clean -ffdx`, installs the unit and timer from it and
checks that the unit's `WorkingDirectory` is that checkout. Rollback: run it
with the previous sha. The nightly summary names the job's commit and how many
newer commits to the job's files on `origin/main` are not deployed yet.

## Nightly summary

`scripts/cardtrader-daily-notify.py` runs at the end of the job (~00:55 UTC).
The Pokémon daily analytics (`cardtrader_blueprint_daily_analytics`) are built
later, by the Oracle `pokoin-cardtrader-daily-market-refresh` timer (01:00 UTC,
done ~02:40), which has its own failure mail. So the summary's analytics state is:

| State | Meaning | Status |
|---|---|---|
| `fresh` | refreshed after this run started | complete |
| `expected` | newest bucket is the previous night's (the normal case at ~00:55) | complete |
| `stale` | newest bucket is older: a refresh was missed (14 Oct 2026) | partial |
| `missing` / `unknown` | no rows, or the writer probe failed | partial |

A failed stage or an incomplete dump still makes the run `partial` / `failed`.
