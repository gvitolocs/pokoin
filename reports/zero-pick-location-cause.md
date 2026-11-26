# Zero pick location: cause and design (PK-C046, phase one)

Baseline: `bd3e1b69` (branch `zero-pick-location`, before any source change).
No live data, database, Firestore, CardTrader or Power Tools was read. Every
claim below is either **EVIDENCE** (a baseline `file:line` I opened) or
**HYPOTHESIS** (needs live data to confirm; stated as such).

Short names for paths (all relative to the repo root):

| Short | Path |
| --- | --- |
| `zero.rs` | `pokoin-rust/crates/external/src/cardtrader/zero.rs` (package `pokoin-external`) |
| `picks.rs` | `pokoin-rust/crates/commerce/src/handlers/zero_picks.rs` (package `pokoin-commerce`) |
| `flow.rs` | `pokoin-rust/crates/commerce/tests/zero_picks_flow.rs` |
| `zp.js` | `market/src/zero-pick.js` |
| `Tile` | `solid/src/components/zero/ZeroTile.jsx` |
| `List` | `solid/src/components/zero/ZeroList.jsx` |
| `Pack` | `solid/src/components/ZeroPack.jsx` |
| `Page` | `solid/src/pages/CardTraderZero.jsx` |
| `Dialogs` | `solid/src/components/zero/ZeroDialogs.jsx` |

## Not read / only skimmed (honest list)

- `solid/src/components/zero/zero-bits.jsx`, `ZeroSortBar.jsx`: **not read**.
- `solid/src/components/zero/PickingMode.jsx`: grep only (no `lineCopies` or chooser hits, lines 14/39/46/133 are the only pick wiring).
- `flow.rs`: only the function list and the `pick()` helper (154-158) read; DB bodies **not read**; they need Postgres and are not run here.
- `solid/src/components/ZeroPack.test.js`, `solid/src/pages/ZeroPicked.test.js`, `market/src/zero-pick.test.js`: read the cited ranges only.
- `docs/MARKET.md`: grep for "zero" only; nothing about Zero picks. `docs/FEATURES.toml`: the `zero-picks` flow (lines 223-229) only.
- `zero.rs`: read 405-770 (lines), 905-1015, 1220-1260, 1685-1900, 2362-2570 and the tests at 2576-2610, 2792-2888, 3511-3564. The Power Tools overlay, PT sort and cache code were **not read** beyond what is cited.

## 1. Where the displayed line comes from (shared by both reports)

### 1.1 Item -> line (`split_lines`)

- `zero_list` reads the seller's listing rows with `LISTINGS_SQL` (`zero.rs:2163-2167`):
  `where seller_uid = $1 and (source_listing_id = any(ct:<product ids>) or id = any(named/allocated ids))`.
  There is **no status or stock filter**, so sold-out rows are members too (comment at `zero.rs:2481`, doc `docs/CARDTRADER_ZERO.md:86`).
  The product ids come from every item of the pack and the pending list (`linked_source_ids`, `zero.rs:391-401`).
- `split_lines` (`zero.rs:726-763`) builds one `ListingIndex` for the whole call (`zero.rs:732`) and then expands each weekly order's items (`747-753`) and the pending items (`754-756`) through `split_item` (`zero.rs:742`).
  The closure at `733-746` carries **no state between items**: each item is split in isolation.
- `ListingIndex::new` (`zero.rs:516-535`): `members[product]` = every row whose `source_listing_id` parses to that CT product, sorted oldest first (`oldest_first`, `zero.rs:511-514`: created_at, then `id_cmp`). `by_id` is the id map.
- `split_item_lines` (`zero.rs:681-719`), in order:
  1. webhook allocations present: `reconcile_allocations` and one line per listing, `allocation = "event"` (`684-692`);
  2. `members` for `item.productId` non-empty: one member -> `"listing"` (`694-698`); several -> `primary = named listing if it is a member, else members[0]` (`699-703`), one line for the **full item quantity**, `allocation = "members"`, `alsoIn` = the other members' non-empty, distinct locations (`704-713`);
  3. else the named listing row (`715-717`), else `"none"` (`718`).
- `make_line` (`zero.rs:542-602`): `lineKey = "<itemId>@<listingId>"` for a linked line (`546`); `quantityAvailable = row.quantity_available` of **that row** (`584-587`); `location = row.location` (`557`, `596`).
  The named listing comes from `user_data_field` (`zero.rs:251-258`, emitted as `listingId` at `zero.rs:299`).

### 1.2 Candidates (`line_candidates`, `zero.rs:634-664`)

For each line: the members of the item's product, **minus the line's own listing** (`649`), **only `quantity_available > 0`** (`650`), **only status `active`/`paused`** (`651`), named listing first then oldest (`654`).
`split_item` stores them as `candidates` (`zero.rs:672`) on **every** line, whatever the seller's `smartLocations` (`docs/CARDTRADER_ZERO.md:179-180`, `zero.rs:1243` only feeds `sorting_json`; `zero_list` never reads `smart_locations`: grep shows its only uses are `1227-1301` and the sort tests).

## 2. Staff report 1: Smart locations ON, one card, "FUOCOBOMBA 002-6: take 1 (0 available)", only one Pick

### EVIDENCE

1. The text is `locationTakeText` (`zp.js:313-318`) = `<line.location>: take <quantity> (<quantityAvailable> available)`; rendered by `Tile:141`. `location` and `quantityAvailable` are the line's **own** listing row (`zero.rs:557, 584-587`).
   "0 available" therefore means the row the line points to has `quantity_available = 0`. It is not a statement about the other boxes of the product.
2. Which row is the line's own row, when there is no webhook allocation: the named listing, else `members[0]` = the **oldest** member regardless of stock or status (`zero.rs:699-703`; sold-out rows are in the index, `zero.rs:2481`). Nothing in the default looks at `quantity_available`.
3. Why only one Pick, with Smart locations ON: `Tile:60` `choose = interactive && props.smartLocations === false && copies().length > 0 && !done`. With smart ON `choose()` is false, so the tile renders the single `Pick` button (`Tile:171-182`). The other boxes are reachable only through the small link "Picked from another box…" (`Tile:183-187`), shown when `copies().length` is non-zero, which opens `SwapDialog` (`Pack:550-559`, `Dialogs:106-129`). In the list view the same thing is "Other box…" (`List:100-102`); the per-box buttons there are also gated on `smartLocations === false` (`List:56`).
   The single image view (`PickingMode`) calls `onSetPicked` -> `setPicked` -> `onPick(line)` with no listing id (`Pack:307-310`, `Pack:524-534`; `PickingMode.jsx` has no `lineCopies`), so it has **no** way to choose a box at all.
4. `lineCopies` (`zp.js:271-289`) uses `candidates` if non-empty, else `alsoIn` entries carrying a listing id. The server's `alsoIn` is plain location strings (`zero.rs:706-712`), so `alsoIn` never yields a copy.
5. The server sends `candidates` regardless of smart (see 1.2), and the doc states smart is "a display preference only" (`docs/CARDTRADER_ZERO.md:179`). So the gate is purely the client `=== false` in `Tile:60` / `List:56`, and `Page:473-487` (`changeSmartLocations`) reloads the list only to "add or drop each line's candidate boxes", a comment that no longer matches the server (it always sends them).

### HYPOTHESIS (needs live data)

- The row behind "FUOCOBOMBA 002-6" is the sold-out oldest member (or the named listing) and the other identical copies are active members with stock > 0. That would give candidates > 0 (the link exists) and `0 available` on the own row, which fits the report. I cannot confirm which of named / `members[0]` it was, or the stock of the siblings.
- Alternative: if the siblings are not under the same `ct:<productId>` (e.g. a separate CT product per copy, `docs/CARDTRADER_ZERO.md:69-71`), `index.members` is keyed only by the item's `productId` (`zero.rs:693`), so `candidates` would be `[]` and no chooser could appear. `line_candidates` has a second lookup through the own listing's `source_listing_id` (`638-644`) but also within `members` only.

## 3. Staff report 2: three items of the same CT product, each "FUOCOBOMBA 002-33-1: take 1 (0 available)"

### EVIDENCE: why the three lines are identical

- The three items have different `itemId` but the same `productId`. `split_item` -> `split_item_lines` is called per item with the **same** `ListingIndex` and no memory of earlier items (`zero.rs:733-746`).
- Without allocations (branch 2 above) each item independently takes `named` or else `members[0]` (`zero.rs:699-703`). Same product -> same `members`, so unless the three items name three different listings, all three lines get the **same** row, hence the same location, the same `quantityAvailable`, and the same `alsoIn` (`704-713`).
  - If the three items name the same listing, `named` wins for all three (`702`). If they name nothing, `members[0]` for all three. Either way identical. If an item names a listing that is **not** a member, `find` fails and it falls back to `members[0]` (`699-703`).
- The three lines still differ in `lineKey` (`11@L`, `12@L`, `13@L`; `zero.rs:546`) so they are three separate tiles with three independent picked states.
- The same also holds in the **pending list** (`zero.rs:754-756` goes through the same closure), and for lines whose item has `quantity > 1` (one line, full quantity, `zero.rs:713`).
- Candidates of each of the three lines are the same set (the other members with stock) in the same order (`zero.rs:646-654`). They do not know about each other.

### EVIDENCE: why `(0 available)` although the product has stock

`quantityAvailable` is the stock of the **own** row only (`zero.rs:584-587`; documented `docs/CARDTRADER_ZERO.md:53-54`). The default row is the oldest member / named one, which a sale or earlier picks may have emptied. The other copies' stock appears only in `candidates[].quantityAvailable` (`zero.rs:660`), shown by the choosers (`Tile:165`, `Dialogs:119`).

### HYPOTHESIS

That the three items took stock from three different members (the sale decremented three 1-stock listings) while the default shows member #1 three times. The code cannot say which listings the CardTrader sale decremented when no webhook allocation exists (`read_allocations`, `zero.rs:459-485`, gives none when the event docs are missing); that is exactly why the fallback guesses.

## 4. Chooser gating (both reports)

| Surface | Gate | File:line |
| --- | --- | --- |
| Images tiles | per-box buttons only when `smartLocations === false && copies > 0 && !done && interactive` | `Tile:60, 155-170` |
| Images tiles, smart ON | one `Pick`/`Undo`; "Picked from another box…" if `copies > 0 && !done && !choose` | `Tile:171-187` |
| List view | per-box "Pick from X" only when smart is `false`; "Other box…" when `copies > 0` | `List:56-66, 100-102` |
| Single image | none (default listing only) | `Pack:524-534`, `Pack:305-310` |
| Read-only (pending, waiting list) | `interactive = Boolean(props.onPick)` is false: no buttons | `Tile:55`, `Pack:72-75`, `Pack:159-176` |
| Own listing in the smart-off chooser | the line's own location is the first button (`Tile:158-160`), then `copies()` | `Tile:158-168` |
| Existing test that pins the gate | `solid/src/components/ZeroPack.test.js:128-133` (source regex `props\.smartLocations === false && copies\(\)\.length > 0`) | see section 9 |

## 5. All pick / undo / swap writes

Client: `Pack:276-303` `runPick(line, action, listingId)`.

1. `pickFlight` guard per `lineKey` (`Pack:278`) so one click sends once.
2. `pickActionBody` (`zp.js:253-264`): `listingId = chosen || line.listingId`, `allocatedListingId = line.listingId`, `lineKey`, `itemId`, `quantity = whole line`. So a plain Pick has `listingId == allocatedListingId`; choosing another box sets `listingId` to it. **A new chooser needs no new endpoint**: it is `onPick(line, copy.listingId)` (already used at `Tile:163`, `List:60`, `Pack:556`).
3. `POST /api/cardtrader-zero-pick` -> `zero_pick` (`picks.rs:428-458`) -> `parse_pick_body` (`picks.rs:69-122`): with `action` and a valid `listingId` -> `Inventory`; without `listingId` the tick becomes a Firestore picked count (`picks.rs:101-106`).
4. `run_inventory_pick` (`picks.rs:304-411`), one transaction:
   - reads the live pick of **(seller, order, item, listing)** (`picks.rs:216-221`, `312-318`); the unique index in the insert is the same four columns (`picks.rs:229`). Therefore two lines of different items that point to the **same listing** do not collide, and two picks of the same item and listing replay.
   - locks picked and allocated rows in id order (`lock_pair`, `picks.rs:277-300`).
   - `plan_pick` (`picks.rs:172-188`): same listing (or none allocated) -> `Finalize { clear_location: holds_no_copy(picked) }` (`176-178`, `146-148`: stock <= 0 or `sold_out`); different listing -> must have identical facets (`identity`, `127-139`; else 409 `not_identical`), stock >= quantity (else 409 `insufficient_quantity`), `Swap` (`183-187`).
   - Finalize: no stock change; if `clear` and the picked row still has a location, `set_location(.., "")` (`picks.rs:375-377`), saving `location_from` (`351`).
   - Swap: picked -quantity and allocated +quantity (`picks.rs:370-374`), plus clearing the picked row's location if it reaches 0.
   - Undo uses the **stored** allocated id of the live row (`picks.rs:319-324`); `UndoSwap` reverses stock and `UndoFinalize` restores the location when the row is still blank (`picks.rs:191-206`, `385-407`).
5. The tile's picked state after the answer: `Pack:280-285` sets the cache entry for **that line key only** (`picked = quantity` or 0) and a note. `dropUnsentPicks` (`zp.js:236-250`) discards unsent picks on load.

## 6. Reload behaviour: does picking one line affect other lines?

### EVIDENCE

- Picked state is per line: `apply_picks_with` (`zero.rs:1860-1892`) joins `public.cardtrader_zero_picks` rows to lines **by `line_key`** (`1870-1877`; the SQL is `1818-1821`), summing `quantity`, clamped to the line quantity. So **the picked flag/count of a sibling line never changes** because a different `lineKey` was picked. After a reload a picked line is found again only if its `lineKey` is unchanged, i.e. only if its **default listing is unchanged** (`lineKey` embeds the listing id, `zero.rs:546`).
- The pick row stores the **physically picked** `listing_id` and the sale's `allocated_listing_id` (`picks.rs:226-228`, insert binds `341-357`), exposed as `line.picks[]` (`zero.rs:1843-1848`, `1878`). So the actually picked listing is already persisted. What is not shown after reload is *which box* the line's tile names: the tile still shows the **default** row's location (not `picks[0].listingId`'s).
- Side effects on **other** lines through shared rows (not through picked state):
  - Finalize on a sold-out default clears that row's location (`picks.rs:375-377`). Every sibling line that defaulted to the same row then reloads with `location = ""` (`zero.rs:557`), shows "No location" (`zp.js:314`), and changes sort slot (`stamp_sort_locations`, `zero.rs:954-960`), because the default is read from the row, which now has no location. So today **picking one of three same-product lines makes the other two lose their location after reload** (HYPOTHESIS about it appearing in production data: it follows from the code when the shared row is empty, which is the "(0 available)" case).
  - A swap decrements the picked row and increments the default row (`picks.rs:372-373`), so after reload `quantityAvailable` of siblings changes, and `candidates` of every line drops the emptied row (`zero.rs:650`) and ignores the default (`649`). Candidates and the "(N available)" text are therefore quantity-based and **not stable across picks**.
  - The default itself (`named`, else `members[0]`) is **not** quantity-based: it depends only on the member set and `created_at`/`id` order (`zero.rs:511-514, 699-703`). So the baseline default listing is stable across picks; that stability must be kept by the new default, which is why a default that reads stock is rejected below.
- Undo: `UndoFinalize` restores the location only when the row is still blank (`picks.rs:194`), so undoing the first pick of the shared row restores it for everyone; undoing the second does nothing to the location (its `location_from` was empty, `picks.rs:351` binds `""` when the location was already empty).

### HYPOTHESIS

- That the staff saw tiles lose their location after picking another tile (the shared-row clearing above). Plausible from the code; not observed.
- Double-use: a box chosen as a candidate on line A can be the default of line B (nothing links the two). Picking it on both is allowed by the unique key (different item ids) and the second one may hit `insufficient_quantity` (swap) or finalize on an emptied row. The server cannot know which sale took which copy in the fallback; see risks.

## 7. Proposed capacity rule (members fallback only)

Applies only to `split_item_lines` branch 2 (several members, no allocations). Branches 1 (webhook), 3 and 4 are unchanged, byte for byte.

**Scope.** Each shipment (each weekly order's `items`) is its own scope; the pending list is its own scope. Within a scope, a per-product **load** counter (`HashMap<member id, usize>`) starts at zero. Scopes never share counters (a shipment's pick does not depend on pending, and shipments do not depend on each other).

**Stable order.** Items of a scope are processed in `id_cmp` order of `itemId` (not the array order, and not the stock): the assignment is a pure function of (member set sorted oldest-first, named listings, item ids). It does not depend on `quantity_available`, status, `location`, picked state, Power Tools, the sort settings, or the order of the CT response.

**Two stages per product** (output lines keep the original item order, as now):

1. Items that **name** a listing that is a member take it (as baseline) and add 1 to its load.
2. The remaining items, in stable order, each take the member with the **lowest load**, ties broken by the oldest-first order (`created_at`, then `id_cmp`), then add 1 to its load.

So the first unnamed item gets the oldest member (the baseline default, so `several_members_never_last_row_wins` and every single-item case are unchanged), the next gets the next oldest, and so on. This is "one per member per pass, round-robin", counting lines because the real sold quantity per member is unknown. With more lines than members the lowest load wraps back to the oldest (safe reuse, no failure). An item with quantity > 1 stays **one line** for its whole quantity (no new splitting, no `lineKey` shape change, `itemQuantity`/`quantity` unchanged); it counts as one load unit.

**Items with a webhook allocation** keep their allocation lines and are **not** counted in the load (their listing was decided by the sale).

**alsoIn / candidates.** `alsoIn` stays computed from the chosen primary exactly as today (other members' distinct non-empty locations, `zero.rs:706-712`). `candidates` stays "members of the product minus own, `quantity_available > 0`, `active`/`paused`, named first then oldest" (`zero.rs:634-664`): own excluded, the sold-out default is not offered, and nothing else about it changes. The chooser (phase two) shows **own listing first, then candidates**, so the three lines of report 2 each offer their own box plus the other boxes.

## 8. Reload-stability design

1. **Defaults never read stock or location or picks.** The only inputs are the member rows' `id`, `created_at`, `source_listing_id`, the item ids, and the named listing. Picking, swapping, undoing, clearing a location or paying more sales (which change the `quantity_available` of rows but not the row set) cannot move any default. The `lineKey` (`item@listing`) is therefore stable across reloads, which is what the pick rows (`line_key`) and `picked` counts rely on (`zero.rs:1870-1877`).
2. **The picked listing is already persisted** per pick row (`listing_id`, `allocated_listing_id`), exposed as `picks[]` (`zero.rs:1878`). Planned display (phase two, UI only): when a line has a live pick whose `listingId` differs from the default, the tile may note "picked from <location>"; not required for correctness. Only that line changes.
3. **Siblings after reload.** With distinct defaults per sibling (stage 2) a pick/finalize/swap on one line empties or clears only the rows that line touched; the other lines have different default rows, so their location/slot do not change. When the row set is smaller than the items, siblings that share a default still share the location-clearing effect of section 6 (same as today); that is the unavoidable case of "more lines than members" and is documented, not hidden.
4. **Not stable by design:** the row set itself. A new listing, a deleted listing or a changed `source_listing_id` re-runs the cycle for **unpicked and picked** lines of the scope, and a picked line whose default moved loses its `line_key` match. Today the same is true for `members[0]` changing. Documented as a known limit.
5. **Swap.** A swap writes `listing_id` (picked) and `allocated_listing_id` (the line's default) to the pick row and moves stock. The default is unchanged by the swap (rule 1), so reload shows the same `lineKey` with `picked = quantity`. Tests (phase two): compute lines, mutate stock/location of one row (simulating the swap or finalize), recompute, and assert every `lineKey`/`listingId`/`allocation` is identical.

## 9. Conflict with an existing assertion (stop-and-document)

**`solid/src/components/ZeroPack.test.js:128-133`** (`smart locations off: every candidate box is a choice; choosing one is the swap pick`) asserts on source text:

```
assert.match(tile, /props\.smartLocations === false && copies\(\)\.length > 0/);
```

The required design makes the chooser **independent of `smartLocations`** whenever several boxes exist, which removes this exact expression from `Tile:60`. The owner's instruction says: "If an existing assertion contradicts the required behaviour, stop and write the conflict into the cause report instead." Implementation is stopped here. Only the owner can authorize revising that existing assertion; coordinator approval cannot override this instruction. Retaining redundant source text just to satisfy the regex is not an acceptable resolution.

Related regexes that stay valid with the new design: `ZeroPack.test.js:41` (`Picked from another box…` stays for the single-copy case or as is), `:130` and `:131` (`props.onPick(item(), copy.listingId)`, `props.onPick(line(), copy.listingId)` stay), `:132` (`onChoose(copy.listingId)` stays).
Existing Rust assertions checked against the capacity rule: `several_members_never_last_row_wins` (`zero.rs:2809-2837`: one item, qty 5 -> oldest member / named, `alsoIn` unchanged) and `candidates_on_every_line_with_other_copies` (`zero.rs:3511-3564`: one item, named-first ordering) hold; `webhook_allocations_split_one_line_per_box` (`2840-2872`) is branch 1, untouched; `named_listing_or_none` (`2875-2888`) is branch 3/4, untouched. `zp.js` `lineCopies`/`pickActionBody` tests (`zero-pick.test.js:253-278`) hold.

## 10. Phase-two plan (not implemented)

Red tests first (appended only): in `zero.rs` tests: three same-product items over three boxes (distinct defaults; each line's candidates are the other boxes with stock, own excluded); named listing first; overflow reuse (more items than members); webhook allocations exactly unchanged (the existing fixture plus a mixed pack where an allocated and an unallocated item share a product); shipment and pending are independent scopes; stability after the shared-row stock/location mutation (reload, including swap-shaped changes). `zero-pick.test.js`: chooser rows (own + copies) independent of smart, `pickActionBody` with a chosen `listingId`. Solid source tests: chooser shows with smart ON and 2+ boxes, none for a single box, none for read-only waiting tiles, chosen id passed to `pickActionBody`. Handler (`picks.rs`, `flow.rs`) is **not expected to change**: the chooser reuses the swap endpoint; if it does, extend `flow.rs` so it compiles (`--no-run`).

Then code, docs (`docs/CARDTRADER_ZERO.md` lines 55-59, 80-82, 179-180) and `docs/FEATURES.toml` `zero-picks` (money = true; add the new tests to `proof`, keep `status`).

### Risks / open questions for the coordinator

1. The existing source-regex test in section 9.
2. Money: a chosen candidate on line A may be the default on line B. Both picks are accepted by the unique key; the second can fail with `insufficient_quantity` (swap) or finalize an emptied row. The backend cannot tell which row a CT sale really decremented in the fallback. Proposed mitigation (not implemented, needs approval): none server-side; the cycle makes the defaults distinct, which makes collisions rare.
3. `quantityAvailable` text stays the own row's stock (a fact), so a sold default still reads "(0 available)"; the chooser shows the other boxes with their stock next to it.
4. The single image view has no chooser today (`PickingMode`); phase two should either add the same row or document that it picks the default only. Not required by the staff reports.

### Coordinator review: design remains incomplete

Sections 7-8 and the phase-two plan are worker proposals, not an approved implementation. No source or existing test has changed, and no checks were run. The source-regex conflict above requires stopping before implementation.

The proposed "no server-side mitigation" for candidate/default collisions is rejected: requirement C explicitly forbids two lines claiming the one copy a box held. Making this rare does not meet that requirement. Likewise, always honoring repeated named listings can still pile multiple lines onto one member, and counting an entire multi-copy item as one capacity unit needs reconciliation with requirement B's copy capacity. A later design must address these cases and actual chosen-box display after reload, rather than treating them as optional. The unchanged handler currently permits distinct items to finalize the same listing (`picks.rs:176-178, 216-221`), so distinct default assignments alone cannot establish C.

The single-image view is also part of the existing picking flow. Its lack of location choice cannot be accepted merely because the staff examples use another view. Scope and tests must cover the required behaviour throughout interactive picking while retaining read-only pending tiles.
