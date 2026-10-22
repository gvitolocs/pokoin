# CardTrader Zero list

Pokoin page: `/mypokoin/zero` (MyPokoin → **CardTrader Zero**).
API: `GET /api/cardtrader-zero`, `POST /api/cardtrader-zero-pick`,
`GET/POST/DELETE /api/powertools-connect`.

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
- `picked` / `issue`: the server-side picked state;
- `powerTools`: Power Tools order state, picked quantity, location, bin, and its picking
  position, when a Power Tools session is connected.

Each weekly order adds `ptPicking`, `pickedLines`, and `issueCount`; top-level
`powerTools.picking` is `{ok, source: "articlesToPick" | "orders" | "none", error}`.

### One line per box

Since one CardTrader product carries all of a seller's identical copies
(`source_listing_id = ct:<productId>` on every member), a 5-copy sale can leave from
five boxes. Each CardTrader item becomes one line per box:

1. **`event`**: the sale's webhook event doc `cardtrader_webhook_events/{uid}_{order}_{item}`
   lists `allocations: [{listingId, quantity}]` (the copies the decrement took: the named
   listing first, then oldest). Zero decrements on the `hub_pending` order, so the doc of
   the item's `hub_pending_order_id` is read first, then the weekly order's. One line per
   allocation; a short sum puts the remainder on the first line.
2. **`members`**: no allocations and several members: one line at the named listing,
   else the oldest member, for the full quantity; `alsoIn` lists the other members'
   locations.
3. **`listing`**: a single member, or the listing `user_data_field` names.
4. **`none`**: no Pokoin listing.

Rows are read without a status filter: a `sold_out` row still says which box the copy
left. `lineKey` is `<itemId>@<listingId>` for a linked line, else `<itemId>`.

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

### Power Tools picking order

With a Power Tools session, Pokoin reads (never writes) Power Tools' own order:

1. `GET user/order` (as before), matched to the weekly order by `sourceOrderId`;
2. once, `GET user/order/getUserPickingLists?state=open`; per weekly order the open list
   holding its `ptOrderId` (or named by `picking.pickingList`), a `cardtrader_zero` list first;
3. per chosen list, `PUT user/order/getArticlesToPick` with `{pickingListId}` **only**.
   `pickings[]` comes back in Power Tools picking order.

Never send `sortingFields` (Power Tools re-sorts and saves the seller's sort on that
list) and never call `updateSorting` or any other Power Tools write. Each item gets its
1-based `position` in that order, its picked count (sum over its pickings), its locations,
and the bin (`article.pickingId`). `mismatch` flags items whose rank in Pokoin's order
differs from Power Tools'; `ptPicking.ctZeroClosed` mirrors the "Ct Zero closed" tag.
Ids arrive as strings or numbers and are compared as text. Any Power Tools failure keeps
the CardTrader list and falls back to the `user/order` article overlay (position null,
bin from the order's `picking.pickingId`).

### Picked state

`POST /api/cardtrader-zero-pick`, Firebase bearer:
`{orderId, lineKey, picked?, issue?}` or `{orderId, reset: true}`.
`orderId` is digits (≤ 40, else `400 invalid_order`), `lineKey` ≤ 120 chars of
`[0-9A-Za-z@_:.-]`, `picked` is clamped to 0..999, and `issue` is null (clears) or
`{type, note ≤ 280}` with type `missing`, `wrong_condition`, `wrong_language`,
`wrong_foil`, `wrong_first_edition`, or `other`. Answers
`{ok, orderId, line: {lineKey, picked, issue, updatedAt}}`.

Stored on Firestore `cardtrader_zero_picks/{uid}_{orderId}`, one top-level field per line,
`l_<hex of lineKey>`, because a Firestore merge replaces a nested map wholesale.
`reset` deletes the doc. `GET /api/cardtrader-zero` reads it back, clamping `picked` to
the line, so ticks follow the seller across devices.

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
`powertools.rs`; `scripts/deploy-pokoin-rust.sh`). Without a bearer each answers `401`.
The SPA page ships with the web deploy.
