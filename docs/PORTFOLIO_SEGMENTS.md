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
ends, twenty-four characters at most. A name that leaves no ASCII letter at all
(`拡張パック`) is slugged `s` plus the first eight hex digits of its FNV-1a 32 hash,
so two Japanese sets of one game draw two lines; only a row with no set name is
`unknown`, and that line is labelled `Unknown set`.

Only the **four games whose sellers hold the most cards** are cut by set at all;
every other game keeps its `game:`, `<game>:sealed` and `<game>:graded` lines.
Inside one of those four, only the **six sets with the most cards held** get a key
of their own; the rest of the game's sets share `<game>:set:other`, labelled
`Other sets`. Ties break on the slug, so the cut is the same on every request. Four
games and six sets keeps a seller with a scattergun collection to lines a screen can
actually show, and keeps the stored document inside its budget.

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

At most **eight** games are priced this way — the ones the seller holds the most
cards in, biggest first. A game whose id the platform's own game table
(`domain/marketplace_game.rs`) does not know is called `unknown` and is never
priced, because `normalize_game` answers Pokémon for a name it cannot place and
reading the Pokémon catalog for a foreign card is exactly what must not happen;
same for an id that would collide with the key scheme's reserved words (`all`,
`game`). Every game is named by the table's id, so a listing written `one-piece`
or `One Piece` finds the `one_piece` database.

A game that is not priced — past the cap, or `unknown` — is treated like a game
whose database failed: its rows go through `apply_catalog_rows` with an empty
answer, so their blueprint id, set name and product type are cleared rather than
keeping what the Pokémon join matched. Every non-Pokémon row is therefore either
priced by its own game or held unpriced; nothing is priced, called sealed, or
given a set line from a Pokémon card.

A game whose database is not configured, has no catalog table, or answers with an
error is logged once with its id and its cards stay **held and unpriced**: their
blueprint id is cleared, so they count in `cardsHeld` and in their game's line at
0 rather than being priced by a colliding Pokémon blueprint. One broken game
never fails the series or another game.

What is *not* here: the other games' CardTrader **1-Day Ready stock** is still not
imported, so only what the seller lists themselves is priced and held.

## The stored document's budget

A Firestore document is capped at 1 MiB, and a segments day is a map of long keys,
so a collection spread over enough games and sets could outgrow it. Before the
write, `fit_segments_budget(days, 600_000)` estimates the stored size —
`key len + 1 + 27` bytes per entry, 16 bytes per day — and while the series is over
budget it drops keys from the **oldest** days first, in this order:

1. `<game>:set:*` keys, oldest day first;
2. then the non-Pokémon `<game>:sealed` / `<game>:graded` keys;
3. then the non-Pokémon `game:<id>` keys.

`pokemon:*`, `game:pokemon` and `all:*` keys are never dropped, so every Pokémon
era band and both cross-game cuts always survive; with a collection of only
Pokémon the estimate is far under budget and the series comes back untouched.
Whatever trimming happened is applied **before** the write and before the response
is built, so the days the client sees are exactly the days that were stored, and a
seller loses the oldest sets of the least-held games rather than the whole graph.
The budget is measured on the estimate, not the serialized document: 600 000 is
comfortably under 1 MiB (1 048 576) with the totals, labels and metadata beside it.

If the Firestore write itself fails, the handler logs it and still answers the days
it computed: a collection too large to store must not turn into a 500 that repeats
on every request. Every other error path of the recompute is unchanged.

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

## Other games on past days

Freezing a day is right for the cards it was valued with and wrong for the games that
only came to be priced later. `frozen_card_days` copies each past day unchanged, so
every day stored before each game began to be priced out of its **own** database (PR
#640, deployed 2026-11-18 21:26 UTC) stayed Pokémon-only forever: one seller with
1,482 Riftbound cards read 2,370 DKK a day from 20 Oct to 18 Nov and 5,556 DKK on
19 Nov, his Riftbound line appearing on the last day alone. DGRAPH-02.

**Once, on the frozen map, before the series is built.**
`add_other_games_to_frozen_days` runs in `recompute_series` between `frozen_card_days`
and `build_daily_series_with_segments`: a qualifying day gains
`value_holdings_on(other_games, book, day)` — its value added to `cardsValuePkn` with
the same rounding the series uses, its quantity added to `cardsPriced`. `cardsHeld` and
`cardsMove` stay exactly as stored: the holdings query has no game filter, so the day
already counted those rows as held while pricing none of them, and a card that has
since sold was still held on a day it is being valued for. `totalPkn` is derived from
the raised value as always. A day nothing was added to is left byte-for-byte as it was
stored, and because `compact_day` caps a day's priced count at its held count, a day
stored with only the Pokémon cards as `cardsHeld` gains the value and keeps the cap.

**The two dates.** Qualifying days are every frozen day before `OTHER_GAMES_LIVE_DAY`
(`2026-11-18`), plus `2026-11-18` itself *only* while its own stored count still looks
Pokémon-only — `cardsPriced < p + (o + 1) / 2` in integer arithmetic, with `p` and `o`
the Pokémon and other-game cards priced today. No day after `2026-11-18` is ever
touched: whatever wrote those days already priced every game.

Whether a *document* is backfilled at all is `needs_games_coverage`: it is on the
current basis and `SERIES_REVISION`, carries no `gamesCoverage` of at least 1, and
Firestore's own `createTime` for it is before `OTHER_GAMES_LIVE_MS`
(`2026-11-18T21:26:00Z`, 1 795 037 160 000). A document created at or after that
instant came from the code that prices every game; one whose create time cannot be read
is left alone, because raising it twice would be a graph the seller cannot explain. The
create time travels *beside* the JSON, in `StoredHistory`, and is never written into the
document. `recompute_series` marks every series it writes with `gamesCoverage: 1`, and
`plan_with_games_coverage` will not serve an unmarked pre-deploy document as fresh —
such a visit becomes `ServeStaleAndRefresh`, so the line is raised on the visit that
reads it and never again. `history_plan`, `stored_is_fresh` and `stored_is_current` keep
answering exactly as before.

**Why the revision stayed 4.** A `SERIES_REVISION` bump throws away every user's stored
totals and rebuilds history from today's stock — the one thing this must not do, since
the days being repaired hold the right Pokémon totals already. The repair adds the
missing games to those totals and nothing else, on the same basis, so the marker records
it instead of a new revision. `SEGMENTS_REVISION` stays 3 for the same reason.

**What the backfill cannot know.** It adds a game's *last sold* price as of today,
carried back to the day the way the Pokémon series carries its own prices back; the
price that card sold for on 2026-10-14 is not recoverable. A card that has left the
collection prices nothing, a game whose catalog names no blueprint prices nothing, and a
slice that never sold leaves its days untouched. The stored `segments` of past days are
not re-derived — they stay stored, or stay missing and are drawn from today's holdings
under the frozen total, as the section above describes. And a document of another basis
or revision is not repaired at all: the ordinary rebuild replaces it.

This supersedes the sentence above saying a seller of another game "sees one step up on
the day this ships and a flat line afterwards": the step is now folded back into the days
those cards were already listed on.
