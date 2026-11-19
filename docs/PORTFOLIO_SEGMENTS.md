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

## Custom collections

A seller names lists of cards — a wishlist, a tournament bound, "what I would buy
back" — and sees each one valued per day as if they had held it all along. Storage
and maths live in `domain/portfolio_collections.rs`, the HTTP hop and the catalog
reads in `handlers/portfolio_collections.rs`.

```
GET  /api/marketplace-portfolio-collections
POST /api/marketplace-portfolio-collections?action=save    { "id"?, "name", "items": [...] }
POST /api/marketplace-portfolio-collections?action=delete  { "id" }
```

All three answer one body — the lists with each card priced as of the last day of
its series, `segmentDefs` in creation order, and `days` — and a `POST` answers it
*after* its write, so a save returns the list as it now is. `saved` names the id a
save wrote and is absent otherwise. `OPTIONS` and any other method are answered as
the history route answers them; the body of every answer is `private, no-store`,
which is what makes one read safe to answer from.

The lists are **Firestore only** (`portfolio_collections`, one document per list:
`uid`, `name`, `items`, `createdAt`, `updatedAt`) — no table, no migration, because
nothing here is a fact about the market. Limits are what one seller's browser can be
trusted with: 20 lists, 300 items per list, quantity ≤999, name ≤40 characters, all
four echoed in `limits`. A write's `id` is a list this seller already has or the read
of it is a 404, a name another of their lists carries is a 409, a missing name or an
over-budget list is a 400 that says which limit it hit, and an item whose `cardId` is
not a positive integer or whose quantity is out of range is a 400 naming its index.
The read asks for more documents than it answers — 64, because a write's check has to
count every list it would overwrite or evict — and the answer then values and names
only the 20 oldest of what it got: pricing a seller's whole stored history on every
request is not a thing this route does, and what falls past the ceiling is the newest,
never a hole in the middle.
A `cardId` is canonicalised before anything else reads it: the leading zeros come
off, so `0012` is stored, answered, merged and looked up as `12` rather than
becoming two lines of one card that each price. The read of a stored list merges by
the same rule a write uses: a document written before some rule existed still
answers one line per slice, with the copies added.
`?action=` outside those two writes is a 400 too: there is no third verb. An unknown
id and someone else's id answer byte-identically, so no read of the store can tell a
list that exists from one that does not. A name the store reserves for its own
markers — `__` on both ends, as `__namespace__` is spelled — is refused by that same
404 out of the id shape, before the store is asked about it at all.

A write's body is read strictly: JSON that cannot be parsed, or that parses to
anything but an object, is the 400 the rest of this API answers unreadable input with
— `Invalid JSON request body.`, no `code` — because `{"name":` is not a save that
forgot its name and a body of garbage is not a delete of a list that does not exist.
An absent body is not malformed input: it is the empty object, which each write then
refuses for what it actually is. Every answer of the route, refusals included, is
`private, no-store`.

**A write is one Firestore transaction.** Its reads — the document being replaced
and every other list of this seller — its checks (ownership, the name, the cap) and
its write commit together, so two saves that would each be legal alone cannot both
land: whichever commits second either reads the other's document or has its commit
aborted for having read a collection that has since moved, and retries from its
reads. That is also why a replace cannot bring back a list someone deleted in
between: the read that proved it existed belongs to the transaction that is aborted,
so the retry reads nothing and answers 404. The answer of a committed save is that
same read with the write applied in memory — never a second listing read after the
commit — so a store that fails one call later cannot turn a write that did happen
into an error the client would retry.

`priceBasis` is `"ct-last-sold"`, the same as `SERIES_REVISION`'s basis: the last
CardTrader sold median of the exact slice, carried forward, with the 20× outlier
filter already applied by the book. Nothing is computed twice. A collection's items
become holdings rows with an empty `since`, and `value_holdings_on` prices them out
of the one sold query the request makes. Which blueprint a `cardId` is gets resolved
**server-side only** — Pokémon through `marketplace_card_versions`, every other game
through its own catalog and its own sold book — so a client cannot name a blueprint
and price its graph off a card it does not hold, and a Riftbound card whose public
id collides with a pricey Pokémon one still answers its own game's price.

An item's facets are keys into that book, so they are stored as the book is filed.
Condition is answered and stored as one of the five the listing forms and the sold
rows use — `NM`, `SP`, `MP`, `PL`, `Poor` — and the spellings `condition_key` already
understands map onto them, so `Near Mint`, `nm`, `NM`, `mint` are one slice and
`poor`, `PO`, `damaged`, `Poor` one more. The slice key still goes through
`condition_key`, so the stored name and the sold row reach the same slice either way.
Language is answered as the code the sold rows carry: `English`, `english`, `en` and
`EN` are the one `EN` slice, `ja` and `Japanese` the one `JP`, `zh-tw` the one `ZHT`.
A `game` may be written as its id or the display name the marketplace uses. Absent
means `NM` / `EN`, Pokémon.

The two vocabularies are closed: a `condition` outside those five, a `language` that is
not one of the fourteen codes the marketplace's vocabulary carries (`vi` and `fi` are
refused for all that they are two letters — the shape of a code is not its membership),
and either written past 24 characters — counted before anything is normalised — is a
`collection_item_invalid` that names the card and the facet, because such a slice has
no sales to carry a series and a save that quietly stored it would draw a line that
can only ever read zero. A `game` the platform's own game table does not list is a 400
on the save for the same reason: it has no database to price from. A list that stored
any of these before the rule existed keeps the line — held at nothing, and with a game
no longer listed the row reads as `unknown`, so it is never looked up in the Pokémon
tables by a card id that only looks alike.

**The series is not stored.** It is a question about a list, not a fact: the day a
card last sold changes under it, the seller renames or re-orders the list, and a
stored answer would need a revision bump and a rebuild per collection. So a read
walks the days itself, from the earliest priced day of any of its slices (never more
than the 400 days the main graph draws) to today; a card whose slice has never sold
counts as held, not priced, and shows no `pricePkn`. With no price anywhere in the
book the series is today alone. An empty collection keeps its `segmentDefs` entry and
appears in no day's `segments`, exactly as an empty era does.

**A price read that did not happen is reported, not drawn.** The market is down, the
query ran out its window or there is no read model at all: the answer is still a 200 with
the seller's own lists — those are Firestore data, and an outage is no reason to tell
someone their collection is gone — but it draws no series and carries
`"seriesError": "prices_unavailable"`. A line drawn beneath cards this request never
priced would be read as the seller's worth having collapsed to zero, and a client that
keeps the last good graph is the correct response to a market it cannot see. `days: []`
*without* that key still means what it always meant: nothing is held.

Half a market is not a market. When one game answered its sales and the Pokémon did not,
the rows that came back are dropped rather than used: the book prices a Riftbound card
from a Riftbound sale and a Pokémon card from nothing, which is the same collapsed line
in one colour instead of the whole list. So `seriesError` and `pricePkn` are mutually
exclusive — with the key present every card of every game answers unpriced, whatever the
request did manage to read. The same answer covers the maths dying rather than the read:
the series is computed on the blocking pool, and a task that goes down there after the
write committed would otherwise turn a save that *did* happen into a 500 the client
retries into a duplicate. It is logged, and the lists are answered without prices.

**What the reads may cost.** The two Pokémon queries of one request share a single
eight-second deadline; the other games are asked **beside them**, never between them, each
inside its own four-second window, so a seller who collects several games waits on their
slowest card server rather than on all of them and the whole market read costs at most
those eight seconds. A game that runs out keeps its cards held and unpriced,
its rows losing the blueprint the Pokémon join matched on their card ids. The day-by-day
maths — every list against every day of the window, at the full allowance of 20 lists and
300 cards — runs on the blocking pool, and a slice key, being a fact about a row rather
than about a day, is built once per collection instead of once per day.
