# CardTrader Zero list

Pokoin page: `/mypokoin/zero` (MyPokoin → **CardTrader Zero**).
API: `GET /api/cardtrader-zero`, `POST /api/cardtrader-zero-pick`,
`GET /api/cardtrader-zero-picked`, `POST /api/cardtrader-zero-sort`,
`POST /api/cardtrader-zero-pt-sort`, `GET/POST/DELETE /api/powertools-connect`.

## What the Thursday list is

CardTrader API v2 Orders, Zero lifecycle:

| Seller order state | `via_cardtrader_zero` | Meaning |
|---|---|---|
| `hub_pending` | `true` | One Zero sale during the week |
| `closed` | `true` | A `hub_pending` order merged into the weekly batch |
| `paid` | `true` | **The weekly merged order**: every item of the week, to ship to the hub |
| `sent` → … | `true` | The weekly order after shipping |

The list Power Tools loads on Thursday is that weekly merged `paid` order.
Power Tools does not compute it. Its `GET /api/user/order` mirrors CardTrader orders keyed by
`sourceOrderId` (= CardTrader order id). Articles are keyed by `sourceArticleId`, and the order
carries `isCtZero` / `isCtZeroClosing`. The merged order becomes a picking list with
`variant: "cardtrader_zero"` ("Ct Zero closed", which can't be deleted). Source: the Power Tools
3.10.0 bundle in `~/Projects/candyext/dump` (`Order`/`OrderArticle` models).

So Pokoin reads the same list directly from CardTrader with the seller's connected
CardTrader token: `GET /orders?order_as=seller&state=paid` and `&state=hub_pending`,
keeping `via_cardtrader_zero === true`. `closed` sources and direct orders are ignored,
so no item is counted twice.

Not verified on live data yet: the 17 Sep dump and the owner's Power Tools accounts
(2026-10-01) have no Zero orders (`/api/user/order` → `[]`). The first seller with a
Zero week should compare `/mypokoin/zero` with CardTrader's Zero page and with the Power
Tools Thursday list.

## `GET /api/cardtrader-zero`

Firebase bearer, seller must have CardTrader connected (`404 cardtrader_not_connected`).
Returns `weekly[]` (merged orders with `items[]`), `pending.items[]`, `totals`, and
`powerTools`. Each line has the CardTrader order/item/product/blueprint ids, name,
expansion, collector number, condition/language (blank when CardTrader has none, per
D00000F), quantity, seller price, and:

- `location` / `slot`: the seller's MyPokoin location of the copy, and its parse
  (`{box, stack, position}`, the port of `parseListingLocation`);
- `game` and `gameSource`, `listedAt` (when the copy entered the inventory), `nameEn`, `rarity`;
- `locationSource` (`pokoin` | `powertools` | `""`), `sortLocation` (the location actually
  ranked), and `ptLocation` (this line's Power Tools location);
- `lineKey`, `quantity` (copies on this line), `itemQuantity`, `allocation`, `alsoIn`;
- `picked` / `issue`: the server-side picked state, and `picks`: the line's live
  Postgres picks `[{id, itemId, listingId, allocatedListingId, kind, quantity,
  locationFrom}]` (the copy to undo can differ from the line's listing after a swap);
- `quantityAvailable`: the stock of the line's own listing row (null when unlinked). The tile
  shows it as "N more in this box" only when N > 0: the sale already took that copy, so 0 is
  the normal count of a line's own box and naming it reads as "this box is empty";
- `candidates`, on every line: the identical copies in other boxes
  `[{listingId, location, quantityAvailable}]` (the other members of the item's CardTrader
  product: members fallback, or a grouped product), the listing the item names first, then
  oldest; the line's own listing excluded; only rows with `quantity_available > 0` and
  status `active` / `paused`, and only copies of the line's own identity — see
  "The finish is part of the copy". `[]` when there are none. Weekly lines add `taken` to
  each (see "One copy, one line" and "One line, one box"), and keep a member other lines
  of the order claimed even at 0 stock, as `taken`, located from the pick that cleared it.
  Used for the box chooser and "Picked from another box…";
- weekly lines only: `ownTaken` (the line's own box is taken: its plain Pick is off),
  `homeLocation` (the box the line's own copy sits in: its `location`, or the location the
  pick stored when a live pick emptied and cleared that listing) and
  `pickedFrom` `[{listingId, location, quantity}]`, the line's live picks from another
  box than its own (location recovered from `location_from` when the pick cleared it);
- `powerTools`: Power Tools order state, picked quantity, location, bin, and its picking
  position, when a Power Tools session is connected.

Each weekly order adds `ptPicking`, `pickedLines`, and `issueCount`; top-level
`powerTools.picking` is `{ok, source: "articlesToPick" | "orders" | "none", error}`, and
`sorting` is `{fields, defaultFields, smartLocations}` (the seller's saved sort, below).
`picksUnavailable` is true when the Postgres picks could not be read: the list then
marks no box taken and the page says so; the pick handler still checks the claims on the
writer, so a taken box is refused on save either way. `listingsUnavailable` is true when
the seller's listing rows could not be read: the list keeps its lines, but no copy is
marked `taken`, no `candidates[].taken` is stated and no picked box gets its location back
— the list does not claim to know about stock it cannot see — and the page says that too.
Both flags are display only; the pick handler is the guard either way.

### One line per box

Without product grouping each Pokoin listing has its own CardTrader product, so an item
maps to one listing (`listing` below). With grouping (PR #494, reverted in #495 and being
re-landed), one CardTrader product carries all of a seller's identical copies
(`source_listing_id = ct:<productId>` on every member), and a 5-copy sale can leave from
five boxes. Both work: each CardTrader item becomes one line per box:

1. **`event`**: the sale's webhook event doc `cardtrader_webhook_events/{uid}_{order}_{item}`
   lists `allocations: [{listingId, quantity}]` (the copies the decrement took: the named
   listing first, then oldest). Zero decrements on the `hub_pending` order, so the doc of
   the item's `hub_pending_order_id` is read first, then the weekly order's. One line per
   allocation; a short sum puts the remainder on the first line.
2. **`members`**: no allocations and several members: one line for the full quantity at
   the item's default box (below); `alsoIn` lists the other members' locations.
3. **`listing`**: a single member, or the listing `user_data_field` names.
4. **`none`**: no Pokoin listing.

Rows are read without a status filter: a `sold_out` row still says which box the copy
left. `lineKey` is `<itemId>@<listingId>` for a linked line, else `<itemId>`. Boxes the
live picks name are read too, even outside the lines' products.

**Default box of a `members` line (one copy per box per pass).** Without allocations
Pokoin cannot know which box each sale took from, so identical items no longer all name
the oldest member. Per scope (each weekly shipment, and the pending list, apart) and per
product, items are taken in natural `itemId` order, in two stages:

1. an item naming a member (`user_data_field`) gets it only while that member's load is
   the lowest of the product (its copy of the current pass is still free); a repeated
   name falls through to stage 2;
2. every other item gets the member with the lowest load, oldest first on ties
   (`created_at`, then id).

An item of quantity q stays one line and adds q to its box's load; with more items than
boxes the loads wrap. A `members` item spreads; a single-member product is not counted.
An `event` item is not spread either — its allocation names its box — but the copies its
allocation names are charged into that box's load first, so a `members` line of the same
product does not land on a box whose only copy the sale already took. The
inputs are only the member set, the names, the item ids and quantities: stock, status,
locations, picks, sort settings, Smart locations and the response order never move a
default, so `lineKey` stays the same across reloads. A changed member set (a listing
added or deleted) can move defaults, as before.

### One copy, one line

> requirement C: a box whose copies are all picked for other lines of the same order is
> refused, `409 copy_already_picked`, "That box's copy was already picked for another
> line; choose another box".

Scope: the seller and the CardTrader order (`order_id`); another line is another
`(itemId, lineKey)`, so two lines of one item (`event` over two boxes) are two lines.
`pokoin_external::cardtrader::zero_claims::check_claim` decides, for the handler and for
the list's `taken` flags alike. With S = the box's `quantity_available` (already net of
sales and of live swaps *from* it) and F = the copies other lines' live `finalize`
picks hold on it:

| Pick | Allowed when | Else |
|---|---|---|
| finalize (own box), no other live pick on it | always, any quantity (it takes the copies the sale took, which Pokoin cannot count after the sale) | — |
| finalize, other live picks on it | S − F ≥ quantity | `copy_already_picked` |
| swap (another box) | S − F ≥ quantity (other swaps are already out of S) | `copy_already_picked` when other lines' picks are on it and either S − F ≤ 0 or S alone would cover the request; else `insufficient_quantity` |

So a finalize after another line's swap took the box's last copy is refused, the first
finalize of a sold-out box refuses every other line until it is undone, a box of 3 serves
swaps of 2 and then 1, and a request larger than what is left stays
`insufficient_quantity`. A live pick of the same item and copy on another line key is
refused too, never answered as a replay. Known limits: capacity is per order, not across
orders; a box restocked after a finalize still counts that finalize; orders picked only
in Firestore have no claims.

The guard is conservative, because Pokoin keeps no original stock or sold count per box:
at 0 stock it cannot tell how many copies the sales took from that box. After the first
finalize on a sold-out box, every other line of the order is refused on it, even when
the box really sold one copy to each of those lines. That includes separate items with
their own webhook allocations to the same box (their lines and allocations are unchanged;
only the pick is refused). A single line of q copies is allowed as the first finalize.
Such a line has to wait until the earlier pick is undone, or be picked from a box with
stock. The remaining quantity says nothing exact about a box's physical history.

### One line, one box

> requirement C, second half: one shipment line is picked from one box.

A line of `quantity` copies is one box's `quantity` copies: picking the same line from a
second box would split one line over two boxes, which is not what the pick list means and
leaves no way to undo one box without undoing the line. After the listing locks the pick
handler reads the line's own live picks on **all** its copies
(`seller_uid, order_id, item_id, state = 'picked'`) and refuses, with
`409 line_already_picked`, "This line was already picked from another box; undo it first",
a request that would put more live picked copies on the line than its `quantity`.

Order of the checks matters, and is fixed: the replay of the same copy answers
`inventory: "unchanged"` first (idempotence never became a refusal), then the per-copy
claim (`copy_already_picked`), then identity (`not_identical`), then this line rule, then
capacity (`insufficient_quantity`). A pick that only adds copies to the box the line
already picked from is not refused here — the box and capacity rules cover it.

The list mirrors it: a line with a live pick on another copy has every box that is not
already carrying that line marked `taken`, so its chooser offers nothing free, and the
page keeps the line's own box labelled with what it picked. `line_already_picked` is also
what a page left open since the pick answered. Known limit: the line's live quantity comes
from Postgres rows, so a line ticked only in Firestore (before the deploy) does not hold
this rule.

### The finish is part of the copy

A Zero line is a copy of one printing, so a box holding another finish is not a box that
line can pick. The pick handler already refused a swap whose two rows differed in
`card_id`, `condition`, `language`, `reverse`, `first_edition`, `signed` or `graded`
(`409 not_identical`); it said nothing about the foil and variant state, so a reverse-holo
box could answer for a plain line. `foil_state` and `variant_state` are in that comparison
now, and the weekly list uses the same function
(`pokoin_external::cardtrader::zero::listing_identity`, which `zero_picks::identity` calls)
to pick the member set a line is defaulted onto and the boxes it is offered. Condition and
language ignore case and blanks; the flags read a JSON `true`.

`LISTINGS_SQL` therefore selects `condition, language, reverse, first_edition, signed,
graded, foil_state, variant_state` beside the columns the list already showed. Rows that
carry none of them compare equal to each other, so a list built from a narrower read keeps
its behaviour instead of offering nothing. A line whose item names no listing of its own has
no row to compare against, so the item states it instead: `zero_item_row` maps the CardTrader
`condition` and `pokemon_language` properties onto the line's own `condition` / `language`, and
a member is refused only when the row records a different value for a facet the item states —
an unrecorded row facet stays a match. The finish facets stay outside that comparison: a
CardTrader item names a foil `Foil` while a row stores `foil_state` (`reverse` / `holo` /
`standard`), and nothing maps one onto the other.

### Picking order

> "the picking list should always start with magic cards, pokemon, yugioh, riftbound and
> all the other games, and assume the position according to when they have been added to
> the inventory of the seller."

Lines of one order (and the pending list) sort by:

1. game: magic, pokemon, yugioh, riftbound, every other game (by slug), unknown last;
2. located lines before lines with no location;
3. box (text before the first `·`/`•`), natural and case-insensitive (`box2` < `box10`);
4. lines with a stack number before bare-box lines, then stack ascending;
5. explicit position ascending, lines without one after;
6. listing `created_at` ascending (when the copy entered the inventory), missing last;
7. listing id (numeric when both are digits);
8. unlinked lines: expansion, collector number (`2/102` < `10/102`), name, item id, `lineKey`.

Stack and position follow `parseListingLocation`: `box·3·5-9` is stack 3 position 5,
`box·2-4` is stack 2, `box1·47` is box `box1` stack 47.

**Effective location.** A line ranks by its Pokoin location; with none, by its Power
Tools location (`locationMap[locationId].name` of its picking, or in the `user/order`
fallback `locationInfo.name`, else the `locations[]` holding copies). A line with only a
Power Tools location is located and takes its place in the box order; a line with both
always uses the Pokoin one. When Power Tools splits an item over several locations, the
item's first line takes the first location, the second the second, and so on. Power
Tools names are free text: a trailing `: n (m available)`, `(m available)`, or `:` is
stripped, and `""` / `unknown…` count as no location. Names with `·`/`•` parse like
Pokoin locations; others use the Power Tools import grammar (`trailing_stack`):
`FUOCOBOMBA 001 - 131` is box `FUOCOBOMBA 001` stack 131, `BINDER 7` is box `BINDER`
stack 7, `DANDANDECK` is a bare box. So `FUOCOBOMBA 001 - 2` sorts between Pokoin
`FUOCOBOMBA 001·1` and `FUOCOBOMBA 001·3`.

**Game per line**, first answer wins (`gameSource`):

1. `cardtrader`: the order item's `game_id`;
2. `blueprint`: the blueprint id found in exactly one game catalog (one bulk query per
   catalog, the same registry as the Power Tools CSV import);
3. `powertools`: the Power Tools article's `product.idGame` (Cardmarket ids: 1 Magic,
   3 Yu-Gi-Oh!, 6 Pokémon, 8 Vanguard, 13 Dragon Ball Super, 16 Flesh and Blood,
   17 Digimon, 18 One Piece, 19 Lorcana, 21 Star Wars, 22 Riftbound, 23 Cyberpunk);
4. `listing`: the linked listing's `marketplace_game`. It is last because that
   column defaults to `pokemon`, so older non-Pokémon imports can carry the wrong game;
5. none: `""`, sorted last.

### Sort model (saved per seller)

The order above is the default. A seller can choose their own, with Power Tools'
picking sort model: level 0 (category) is locked, then up to four levels, each a Power
Tools value with `.asc` / `.desc` (`none` and `extras` take none): `none`, `extras`,
`game`, `location`, `cn`, `condition`, `language`, `comment`, `price`, `orderBin`,
`color`, `releaseDate`, `set`, `releaseExpCode`, `product.expansion`, `product.rarity`,
`product.enName`, `product.locName`.

Rules (`parse_sorting_fields`): at most four entries (`400 invalid_sorting_fields`), known
values only (`400 invalid_sorting_field`), `none` only after the last real level
(`invalid_sorting_fields`), no field twice whatever its direction
(`400 duplicate_sorting_field`). The answer is padded with `none` to four levels.
Default: `["game.asc", "location.asc", "none", "none"]`, exactly the order above.

Each level (`compare_with_fields`):

| Value | Compares |
|---|---|
| `game` | magic, pokemon, yugioh, riftbound, others by slug, unknown last; `desc` reverses all of it |
| `location` | located first (both directions), box natural, stacked before bare box, stack, positioned first, position, listed date, listing id; `desc` reverses box, stack and position values only |
| `cn` | collector number, natural |
| `condition` | NM < SP < MP < PL < Poor |
| `language` | language code |
| `price` | `unitCents` |
| `orderBin` | `powerTools.bin`, natural |
| `product.rarity` | Common, Uncommon, Rare, Holo Rare (= Rare Holo, MTG Mythic), Reverse Holo, Double Rare, Ultra Rare, Illustration Rare, Special Illustration Rare, Hyper/Secret Rare, Promo |
| `set`, `product.expansion` | expansion name, natural |
| `product.enName` | `nameEn`, else `name`, natural |
| `product.locName` | `name`, natural |
| `comment`, `color`, `releaseDate`, `releaseExpCode`, `extras` | that line field when lines carry it |

Blank or unknown values sort last in both directions, so the order stays total. After the
chosen levels the full default comparator always breaks ties.

Parity: `pokoin-rust/crates/external/src/cardtrader/fixtures/zero-sort-cases.json` is
`[{name, fields, lines, expected: [lineKey…]}]` or `[{name, fields, error: <code>}]`, with
lines in the API's line shape. The Rust test and `market/src/zero-sort.js` both run it.

Saved on Firestore `cardtrader_zero_settings/{uid}`: `sortingFields`, `smartLocations`
(default true), `ptSortAt`, `updatedAt`. A stored sort that no longer validates falls back
to the default. `POST /api/cardtrader-zero-sort` `{fields?, smartLocations?}` or
`{reset: true}` (default sort, `smartLocations` kept) validates, saves, and answers
`{ok, sorting}`; it calls neither CardTrader nor Power Tools.

**Smart locations** is a display preference only (default on): the API answer is the same
either way. `alsoIn` (location strings) and `candidates` are always sent, and the box
chooser (own box first, then the other boxes, each with its location and available count;
taken ones disabled) shows on image tiles, list rows and the single image whatever the
setting. Read-only pending tiles and single-box lines have none.

### Power Tools picking order

With a Power Tools session, the Zero list reads Power Tools' own order (the list never
writes; the only Power Tools write is Apply sort, below):

1. `GET user/order` (as before), matched to the weekly order by `sourceOrderId`;
2. once, `GET user/order/getUserPickingLists?state=open`; per weekly order the open list
   holding its `ptOrderId` (or named by `picking.pickingList`), a `cardtrader_zero` list first;
3. per chosen list, `PUT user/order/getArticlesToPick` with `{pickingListId}` **only**.
   `pickings[]` comes back in Power Tools picking order.

Never send `sortingFields` (Power Tools re-sorts and saves the seller's sort on that
list) on these reads. Each item gets its
1-based `position` in that order, its picked count (sum over its pickings), its locations,
and the bin (`article.pickingId`). `mismatch` flags items whose rank in Pokoin's order
differs from Power Tools'; `ptPicking.ctZeroClosed` mirrors the "Ct Zero closed" tag.
Ids arrive as strings or numbers and are compared as text. Any Power Tools failure keeps
the CardTrader list and falls back to the `user/order` article overlay (position null,
bin from the order's `picking.pickingId`).

### Apply sort to Power Tools

`POST /api/cardtrader-zero-pt-sort` writes the Pokoin order to the seller's Power Tools
picking list, the way Power Tools' own **Apply sort** does: `PUT user/order/updateSorting
{pickingListId, sortingFields, items}`. Power Tools forwards it to CardTrader ("The sorting
of the picking list has been changed also on Cardtrader"). User-triggered only: never on a
read, a job, or a retry. Uses the seller's stored encrypted Power Tools session.

Body `{orderId, listId, sequence: [itemId…], dryRun?, expectCount}`:

1. At most one write per seller per 15 s (`ptSortAt`): `429 pt_sort_throttled`. A dry
   run is not throttled.
2. Fresh `getArticlesToPick {pickingListId}` (no `sortingFields`). The list's own
   `sortingFields` from that answer go back unchanged.
3. `items`: picked articles (every picking `picked`) by `updatedAt` ascending, then the
   to-pick articles in `sequence` order (CardTrader item id = `sourceArticleId`, compared
   as text); to-pick articles `sequence` misses keep Power Tools' order after them. One
   entry per article, only `{source, sourceArticleId, sourceOrderId}` exactly as Power
   Tools sent them. An id the list does not hold: `409 pt_sort_mismatch` with
   `problems.unknownIds`. `expectCount` (the count the seller confirmed) must equal
   `items.length`, else `409 pt_sort_count_changed`.
4. `dryRun`: `{ok, dryRun: true, before, items}`, no write.
5. Write, read back once: `{ok, before, after, requested, applied: after == requested}`.
   **Restore previous order** is the same route with `sequence = before`.
6. Errors, never retried: 401/403 → `409 powertools_session_expired` (session marked
   expired: reconnect Power Tools); an error mentioning a token →
   `409 powertools_cardtrader_not_connected`; `Invalid Picking List` →
   `409 pt_picking_list_missing`; anything else `502`.

Not verified live: whether Power Tools keeps an order no sort field produces, and
whether CardTrader's Zero page shows it. The reversible probe answers both:
`pokoin-rust/crates/external/examples/pt_sort_probe.rs` (`PT_JWT=<jwt cookie>`, never
printed; `--list <ptId> [--order <ctOrderId>]`). It only reads by default. With
`--apply-permutation` it reverses the to-pick part, writes it, reads back, prints whether
Power Tools kept it, then restores the original sequence and reads back again. Run it by
hand on a list you own and check CardTrader's Zero page between the write and the restore.

### Pick → inventory

> "when a card is picked from the picking list, it leaves the inventory so it can no
> longer be sold"

A Zero sale already took the copy off Pokoin (the CardTrader webhook decrement; its
event doc lists the `allocations`). A pick never decrements again. It records which copy
physically left the box in Postgres `public.cardtrader_zero_picks` and settles the
difference when that is not the copy the sale took.

`POST /api/cardtrader-zero-pick` `{orderId, itemId, lineKey, listingId (the copy
picked), allocatedListingId (the line's allocation, may be empty), quantity 1..999,
action: "pick" | "undo", orderCode?, unitCents?, currency?}`, one transaction, the
listing rows locked in id order:

| Case | What changes |
|---|---|
| pick, same copy (or no allocation): `finalize` | No quantity change. When the copy now holds none (0 / `sold_out`), its location goes to `location_from` and the listing's `location` is cleared, so the location page and board stop showing it. A multi-copy listing keeps its location. |
| pick, another copy: `swap` | Same seller, `card_id`, condition, language, reverse, first edition, signed, graded, foil state, variant state, else `409 not_identical`. Picked copy −quantity (`409 insufficient_quantity` when it has fewer, `409 copy_already_picked` when other lines hold its copies, `409 line_already_picked` when this line already picked another box: "One copy, one line" and "One line, one box"), allocated copy +quantity. Net −quantity across the seller's copies of that card, i.e. the sale's copy. CardTrader gets −n on one product and +n on the other (increments, never totals). A picked copy left at 0 also leaves its box (as finalize). |
| undo `finalize` | `location_from` comes back if the listing's location is still blank. |
| undo `swap` | Picked copy +n, the **stored** allocated copy −n (`409 allocated_copy_gone` when it no longer has n: nothing changes), location restored as above. |

Every quantity change goes through `handlers::listings::apply_stock_delta`, the
transactional twin of a board quantity edit: `quantity_available` never below 0 (SQL
guard), 0 is `sold_out`, a `sold_out` row that gets copies back is `active` again
(`LISTING_REACTIVATED`, `+n` on its product like a board edit; a product CardTrader no
longer has settles `gone` and the reconcile copies CardTrader's quantity). At 0 a linked
product is destroyed as on the board, unless another copy still for sale shares that
product (product grouping): that product gets `−n` instead. Each change queues its
listing.changed outbox event in the same transaction; a location clear queues
`LISTING_UPDATED`.

Every pick also runs the "One copy, one line" check (a finalize included) and the "One
line, one box" check. The
transaction sets READ COMMITTED explicitly, locks the listing rows, then reads the live
pick of its copy, the other lines' claims and the line's own live picks with plain reads:
every claim on a copy is written under that copy's row lock, so a claim committed first is
seen and the next one waits. Undo reads its row unlocked to learn which copies to lock,
then again `for update` after the listing locks (always listings before pick rows, so no
lock cycle); a row
undone and picked again from another sold copy in between answers `409 pick_changed`.

Idempotent: a live pick is unique per (seller, order, item, copy) (partial unique index
on `state = 'picked'`). A replay or a double click of the same line (same `lineKey`)
answers the existing row and changes nothing; concurrent clicks collapse on the listing
lock and the index. Undo marks the row `undone`; undoing
an undone row is a no-op. Undo finds the row by (seller, order, item, picked copy) and
always restores the allocated copy stored on it; an `allocatedListingId` the client
sends with an undo is ignored. An issue report never touches stock.

Answer: `{ok, pick: {id, orderId, itemId, lineKey, listingId, allocatedListingId, kind,
state, quantity, locationFrom, …}, listings: [changed rows], inventory: "removed" |
"swapped" | "restored" | "unchanged"}`.

PR A's bodies stay on Firestore and never touch stock: `{orderId, lineKey, picked?,
issue?}` or `{orderId, reset: true}` (validation and storage below), and a pick or undo
of a line with no Pokoin listing (no `listingId`) is a Firestore picked count
(`quantity` or 0).

`GET /api/cardtrader-zero` reads picked counts from Postgres: an order with any live
Postgres pick takes its counts from there (the line's `picks`); an order without keeps its
Firestore counts (orders ticked before the deploy). Issues always come from Firestore.
A missing table or a failed read is no rows, with `picksUnavailable: true`. A failed
listing read is not "no listings": the rows stay missing, the taken flags and the recovered
box locations are skipped, and the answer carries `listingsUnavailable: true`.

After a pick, an undo, a refused `copy_already_picked` or `line_already_picked`, or an undo
that reversed only some
copies, the page reads the list again (cached CardTrader orders; Power Tools only when its
overlay is shown) so other lines' boxes show what is taken now. The client also refuses a
pick of a box the server marked taken before sending (buttons, drag, keyboard, single
image); it never works out a capacity itself. A swapped line shows "picked from
<location>" at once and after a reload, and its undo sends the copies its stored picks
name.

### Picked section

`GET /api/cardtrader-zero-picked?offset=` → `{rows, nextOffset}`: the seller's live picks,
newest first, 100 a page, joined with the listing: `{id, orderId, orderCode, itemId,
lineKey, listingId, allocatedListingId ("" when none), kind, quantity, locationFrom, cardId, name, expansion,
collectorNumber, condition, language, reverse, firstEdition, imageUrl, game, unitCents,
currency, pickedAt}`. Picked rows are not listings: they never count in live listings,
cards in stock, or total asking, and are never pushed.

### Issues and Firestore picked counts

`{orderId, lineKey, picked?, issue?}` or `{orderId, reset: true}`.
`orderId` is digits (≤ 40, else `400 invalid_order`), `lineKey` ≤ 120 chars of
`[0-9A-Za-z@_:.-]`, `picked` is clamped to 0..999, and `issue` is null (clears) or
`{type, note ≤ 280}` with type `missing`, `wrong_condition`, `wrong_language`,
`wrong_foil`, `wrong_first_edition`, or `other`. Answers
`{ok, orderId, line: {lineKey, picked, issue, updatedAt}}`.

Stored on Firestore `cardtrader_zero_picks/{uid}_{orderId}`, one top-level field per line,
`l_<hex of lineKey>`, because a Firestore merge replaces a nested map wholesale.
`reset` deletes the doc (issues and Firestore counts only; Postgres picks are undone one
by one). `GET /api/cardtrader-zero` reads it back, clamping `picked` to the line.

### Speed

A 135-line pack took 3.5–4.4 s (Pi log `slow_http_request`, 2026-10-22), and the
page waited for it with nothing on screen. Now:

- **Query flags.** `powertools=0` answers without any Power Tools call
  (`powerTools.deferred: true`). `refresh=1` skips the per-seller cache.
- **Two-phase page.** The page asks for `powertools=0` first and paints the pack,
  then asks again for the Power Tools overlay. Before either answer it paints the
  seller's last pack from `localStorage` (`pokoin.ctZero.last.<uid>`, kept 7 days,
  at most 2 MB). One load runs at a time. Refresh sends `refresh=1`.
- **Parallel reads.** The CardTrader and Power Tools integration docs are read once,
  together. The CardTrader orders run beside Power Tools `user/order` and the picking
  lists. Then the webhook allocations, blueprint games, picks and getArticlesToPick
  run together, followed by one listing query.
- **Batched Firestore.** Allocations and picks use Firestore `documents:batchGet`
  (100 ids per request) instead of one GET per line.
- **Bounded CardTrader paging.** Orders are read with `from` = 60 days ago. The
  weekly merged `paid` order is at most a week old, so direct orders no seller ships
  any more no longer cost pages.
- **Cache.** The CardTrader orders and Power Tools reads are kept in-process for
  60 s per seller. A refresh still reuses a read under 3 s old: the overlay request
  right after it. One lock per seller makes concurrent requests share one fetch.
  Picks, allocations and listing rows are never cached.
- **Timings.** The response carries `Server-Timing` (`docs`, `ct_orders`,
  `pt_orders`, `allocations`, `games`, `picks`, `pt_articles`, `listings`, `total`,
  plus `ct_cache`/`pt_cache` on a hit). The API logs `zero_list_timing` with the
  same steps.
- **Rendering.** Tiles and rows use `content-visibility: auto`. The print-only list
  is rendered only while printing. Picking mode and the dialogs load on first use,
  and images decode async.

## Power Tools session

Power Tools has no OAuth for third-party apps. Its own sign-in is Outseta
(`POST https://mtg-powertools.outseta.com/api/v1/tokens`, form `username`/`password`
→ `access_token`, or a two-factor challenge), then
`POST https://new.tcgpowertools.com/api/auth/login {accessToken}` → `Set-Cookie: jwt=…`.
That `jwt` cookie is the whole session (no CSRF, no bearer).

`POST /api/powertools-connect` does the same with `{email, password}`. It also accepts
`{session}`, a pasted `jwt` cookie, for Google or two-factor accounts. It validates
against `GET /api/user` and stores only the session, AES-GCM encrypted with
`CARDTRADER_TOKEN_ENCRYPTION_KEY`, on `seller_integrations/{uid}__powertools`.

- The password is never stored or logged; request bodies are never logged.
- Power Tools' `/api/user` returns the seller's CardTrader OAuth and refresh tokens
  (`assignedCardtraderUser`). Only `_id`, `username`, `cardtraderUserId`, and
  `cardtraderUserName` are kept. `cardtraderMatch` warns when that CardTrader seller differs
  from the one connected to Pokoin.
- Failed password sign-ins are capped at 5 per hour per Pokoin user (`429`).
- An expired session never fails the CardTrader list. The overlay reports
  `powertools_session_expired` and the page asks the seller to sign in again.
- `DELETE` forgets the session.

Power Tools session JWTs carry `iat`/`exp` in milliseconds, and the server accepted a
13-day-old session on 2026-10-01. Treat a stored session as long-lived: that is why it
is encrypted and why it can be deleted.

## Deploy

The routes ship in the Rust release (`pokoin-rust/crates/external`: `cardtrader/zero.rs`,
`powertools.rs`; `pokoin-rust/crates/commerce`: `handlers/zero_picks.rs`;
`scripts/deploy-pokoin-rust.sh`). Without a bearer each answers `401`.
The SPA page ships with the web deploy.

Migration: apply `scripts/sql/135_cardtrader_zero_picks.sql` on the nezopt writer before
the release (idempotent; the Pi replica receives it). Without it the list falls back to
Firestore counts and inventory picks fail with a missing-table error.

Tests: `cargo test -p pokoin-external zero` / `powertools` (fixtures and a local fake
Power Tools; nothing calls CardTrader or Power Tools), `cargo test -p pokoin-commerce
zero_picks`, and the real-Postgres flow `tests/zero_picks_flow.rs`
(`POKOIN_TEST_DATABASE_URL`, see its header).
