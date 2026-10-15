# CardTrader daily listing dump

`pokoin-all-cardtrader-daily` (nezopt user unit, 23:00 UTC) runs
`scripts/run-all-cardtrader-daily.sh`: catalogues, pictures, artwork, and in
parallel the raw listing books of every live game, one book per expansion,
into `/home/nez/data/pokoin-catalog-refresh/daily/<UTC date>/listing-books/`.

## Pieces

| Where | What |
|---|---|
| nezopt | `pokoin-cardtrader-listing-dump` (`pokoin-rust/apps/cardtrader-listing-dump`): order, resume, deadline, status, storage |
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
  (`ctb1`) and `inFlight`. Exit 1 when any book failed, 0 when all were stored.

## `.ctb` books

Lossless: `ctbook decode <file>.ctb` prints exactly the JSON CardTrader sent.
Header `CTB1` + blueprint count + listing count + payload length, then brotli
(q9) of a columnar document (see `crates/ctbook/src/lib.rs`). About 5x smaller
than the old gzip JSON. `ctbook stats <book.json.gz>…` measures sizes, timings
and the round trip.

## Deploy

```bash
scripts/deploy-cardtrader-dump.sh   # clean origin/main checkout on nezopt
```

It builds the three binaries, installs the bridge on Oracle (checks glibc ≤ 2.35
and a dry start), and switches `/home/nez/pokoin-cardtrader/current`. Rollback:
point `current` at the previous release, or remove it to fall back to Python.
