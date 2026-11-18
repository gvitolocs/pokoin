# Portfolio segments (one graph per slice of the collection)

`GET /api/marketplace-portfolio-history` prices the whole collection into one
daily series. A **segment** is a slice of that collection the seller dashboard can
draw as its own graph on the same days: a Pokémon era, sealed product, graded
slabs, or a non-Pokémon game. The existing totals, their stored history and every
existing response field are untouched — segments are added beside them.

Code: `pokoin-rust/crates/accounts/src/domain/portfolio_segments.rs` (the table
and the rules), `.../domain/portfolio_history.rs` (days and freezing),
`.../handlers/portfolio.rs` (read, store, respond).

## The keys

A key is an opaque string. Nothing parses it back; it only travels from the
server to the client and back again.

| Shape | Holds |
| --- | --- |
| `pokemon:era:<id>` | The Pokémon holdings of one era band (`vintage`, `mid`, `xy`, `sm`, `swsh`, `sv`, `post-sv`, `other`). |
| `pokemon:sealed`, `pokemon:graded` | Sealed / graded Pokémon, cutting across the bands. |
| `game:<game id>` | Everything listed under that game (`game:pokemon` is the whole Pokémon collection). |
| `all:sealed`, `all:graded` | Sealed / graded of **every** game. |

The era bands partition the Pokémon holdings, so their values add up to
`game:pokemon`. Sealed and graded cut across them: one sealed Booster Box is in
`pokemon:era:sv`, `pokemon:sealed`, `all:sealed`, `game:pokemon`.

*Sealed* means the listing says so (`sealed`) or the catalog product type is not a
loose single (`card`, `jumbo`, `accessory`). *Graded* is the row's own `graded`
flag, the same truthiness the price slices use.

## The era table

`BANDS` in `portfolio_segments.rs` is the only place the era split lives: id,
label, years, and the `era_for_code` names that fall in the band. Moving XY or
Black & White is a one-line change there. A unit test fails if `era_for_code` can
answer with a name no band lists, and everything unmatched (promos, subsets, an
unknown or empty set code) lands in `other`.

## What the days and the response carry

Every day gains one optional field, appended after the existing ones:

```json
{ "date": "2026-10-08", "cardsValuePkn": 25, "totalPkn": 125,
  "segments": { "game:pokemon": [25, 3, 3], "pokemon:era:sv": [5, 1, 1],
                "pokemon:era:vintage": [20, 2, 2] } }
```

Each entry is `[valuePkn, cardsPriced, cardsHeld]`. A segment with nothing held on
a day is left out; a day with no segment at all has no `segments` field. The
response gains `"segmentDefs"`, the ordered list the client draws — the games that
appear in the days (Pokémon first), then `all:sealed` / `all:graded`, then all
eight bands in table order, then `pokemon:sealed` / `pokemon:graded`. A series
without segments answers `{ "ok": true, "days": [...] }` exactly as before, with
no `segmentDefs` key.

## Freezing, and when a day's segments can miss its total

The holdings query carries four more columns (`game`, `set_code`, `product_type`,
`listed_sealed`); the eight columns that make a row are unchanged, and
`marketplace_card_versions.card_id` is unique, so no row is duplicated and no
total moves.

Past days keep their stored **totals** forever: the 1-DR table only knows today's
stock, so re-pricing yesterday would erase cards that have since sold. Segments are
frozen separately, under `SEGMENTS_REVISION` next to `seriesRevision` in the stored
document — bump it and the stored per-segment days are rebuilt while every user's
totals stay exactly as they are. `SERIES_REVISION` and `PRICE_BASIS` are unchanged,
so no history is thrown away.

A stored day therefore reuses its stored `segments` when the document is on the
current basis, series revision **and** segments revision. **A day whose totals are
frozen but which has no stored segments gets segments priced from today's holdings
under that frozen total** — for those days the segments need not add up to
`cardsValuePkn`. That is intended: rebuilding the totals of past days is what must
never happen.
