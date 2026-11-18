# Portfolio segments (one graph per slice of the collection)

`GET /api/marketplace-portfolio-history` prices the whole collection into one
daily series. A **segment** is a slice of that collection the seller dashboard can
draw as its own graph on the same days: a Pokémon era, sealed product, graded
slabs, or one set of another game. Every existing response field stays, and stored
days keep the value they were written with; segments are added beside them.

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
| `<game>:sealed`, `<game>:graded` | Sealed / graded of one game, for every game the days carry. |
| `<game>:set:<slug>` | One set of a non-Pokémon game (`riftbound:set:dawn-of-a-new-era`). |

The era bands partition the Pokémon holdings, so their values add up to
`game:pokemon`. Sealed and graded cut across them: one sealed Booster Box is in
`pokemon:era:sv`, `pokemon:sealed`, `all:sealed`, `game:pokemon`. Pokémon is cut
by era and gets no set keys; every other game is cut by set instead of by era,
because a Riftbound collection has no Scarlet & Violet band to fall in.

*Sealed* means the listing says so (`sealed`) or the catalog product type is not a
loose single (`card`, `jumbo`, `accessory`). *Graded* is the row's own `graded`
flag, the same truthiness the price slices use.

## Sets of another game

A non-Pokémon game's sets come from its own catalog (see the next section), slug
lower-cased: every run outside `[a-z0-9]` becomes one `-`, `-` trimmed from both
ends, forty characters at most, `unknown` when nothing is left.

Only the **six sets with the most cards held** get a key of their own; the rest of
the game's sets share `<game>:set:other`, labelled `Other sets`. Ties break on the
slug, so the cut is the same on every request. Six keeps a seller with a
scattergun collection to lines a screen can actually show.

The slug is not the set's name, so the handler stores a `segmentLabels` map
(key → set name) next to `segmentsRevision` in the Firestore document. It is
merged over the stored map on every recompute, so a day frozen under an old cut
still answers with the label it was drawn with, and a set that dropped out of the
six keeps its name for as long as its frozen days carry it.

## How another game is priced

Every listing lives in the Pokémon database, and the join that names a blueprint
there answers with a Pokémon card of the same id. So the holdings query carries
the public `card_id` and each non-Pokémon game is priced out of **its own**
database (`game_db`, one pool per game): its `marketplace_search_candidates` rows
say which CardTrader blueprint, set and product type a held card is, and its
`cardtrader_sold_daily` says what that blueprint sold for. CardTrader blueprint
ids are unique across games, so every game's sold prices join one shared price
book.

At most twelve games are priced this way — the ones the seller holds the most
cards in. A game whose database is not configured, has no catalog table, or
answers with an error is logged once with its id and its cards stay **held and
unpriced**: their blueprint id is cleared, so they count in `cardsHeld` and in
their game's line at 0 rather than being priced by a colliding Pokémon blueprint.
One broken game never fails the series or another game.

What is *not* here: the other games' CardTrader **1-Day Ready stock** is still not
imported, so only what the seller lists themselves is priced and held.

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
response gains `"segmentDefs"`, the ordered list the client draws. One game's block
comes before the next game's, Pokémon first and the others in id order:

1. `game:<id>` — that game's whole collection.
2. `all:sealed`, `all:graded` — once, before the per-game blocks.
3. per game, in the order the games were listed: Pokémon's eight era bands
   (group `era`) or that game's set lines (group `set`), `Other sets` last;
   then that game's `:sealed` and `:graded` (group `type`).

A game only appears when a day carries one of its keys, so a seller with no
Riftbound cards sees no Riftbound line. Each def is
`{ "key", "group", "label", "color" }`, plus `"game"` on another game's set and
type lines; a set line's label is the stored `segmentLabels` name when the map has
one, else the slug read back with spaces and capitalised words. A series without
segments answers `{ "ok": true, "days": [...] }` exactly as before, with no
`segmentDefs` key.

## Freezing, and when a day's segments can miss its total

The holdings query carries five more columns than the series needs (`game`,
`set_code`, `product_type`, `listed_sealed`, and the public `card_id` another
game's catalog is looked up by); the eight columns that make a row are unchanged,
and `marketplace_card_versions.card_id` is unique, so no row is duplicated.

**`cardsValuePkn` counts the other games' priced cards from now on.** A Pokémon
listing whose `card_id` matches a Riftbound card used to be priced by the Pokémon
blueprint the join answered with, or left unpriced; now its own game prices it.
Past days keep the value they were stored with, so a seller whose collection holds
another game sees one step up on the day this ships and a flat line afterwards.
That is the intended change, not a re-pricing of history.

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
