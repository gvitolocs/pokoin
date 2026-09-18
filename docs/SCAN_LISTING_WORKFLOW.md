# Scan listing workflow (Batch Defaults → queue → inventory)

How scanned cards become listings. Pairing and transport:
[SCAN_CONNECT.md](SCAN_CONNECT.md). Keys:
[KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md). PowerTools parity:
[POWERTOOLS_FEATURE_MATRIX.md](POWERTOOLS_FEATURE_MATRIX.md).

The seller sorts a pile physically, sets the pile once on the desktop, and
scans. Every extra click is multiplied by the pile size, so the default path
for a clean scan is **zero** desktop input until submit.

## Identity vs seller attributes

| Layer | Fields | Owner |
| --- | --- | --- |
| **Printing** (catalog) | public `card_id` → name, set, collector number, art (`marketplace_card_versions`) | Recognition, corrected by the seller |
| **Seller attributes** (article) | `language`, `condition`, `foil_state` (+ `reverse`), `first_edition`, `signed`, `altered`, `graded` + company / grade / cert, `location`, `seller_comment` | Batch Defaults snapshot, corrected per row |
| **Stock** | `quantity`, `price_pkn` | Row |

"Version" is not a field. Same-artwork groups and rarity lineups are
navigation over printings ([VERSIONS.md](VERSIONS.md)), not attributes.

Stack identity (used for merging consecutive scans and, later, for
"similar articles in stock"): `card_id | condition | language | foil_state
| first_edition | signed | altered | graded | grading_company | grade |
location` — PowerTools' key (`condition | language | finishType | signed |
firstEd | countryEdition | gradingCompany | grade`) mapped to Pokoin columns,
with **location added** because a Pokoin listing row has one location (see
[Location](#location)) and without country edition (PowerTools has none for
Pokémon). Code: CardVault `api/_scan_connect.js` `stackKey`, SPA
`market/src/scan-model.js` `stackKey` (same test vectors).

## Batch Defaults

Bar pinned above the queue:

`Language IT · Condition NM · Finish Standard · 1st Ed. · Signed · Location Box A12 · Qty 1 · Merge repeats ✓`

| Default | Values | Snapshotted |
| --- | --- | --- |
| Language | Pokoin list codes (`EN IT FR DE ES JP PT NL PL RU KO ZH ZHT ID TH VI`) | yes |
| Condition | `NM SP MP PL Poor` | yes |
| Finish | `standard holo reverse stamped promo other` | yes |
| First edition, Signed, Altered | on / off | yes |
| Location | free text ≤ 64 chars (`Box A12`, `Binder 3`) | yes |
| Quantity per scan | 1–99 | yes |
| Merge repeats | on / off | yes (the rule in force when the scan happened) |

Price is **not** a default: it depends on the printing. Grading is per slab,
not per pile.

### Snapshot rule

Every change appends `{version, changedAt (server clock), defaults}` to
`scan_batches.defaults_history`. A scan takes the defaults **in force when
the card was captured**, not when the upload arrived:

```
capturedAtServer = clamp(capturedAt(phone) + clockOffsetMs, pairedAt, receivedAt)
snapshot         = last history entry with changedAt ≤ capturedAtServer
```

The phone learns `clockOffsetMs` from `serverTime` on pairing and every
heartbeat (midpoint of the round trip). Consequences:

- Cards A, B, C scanned with Italian, then the seller switches to English:
  A–C keep Italian even if C's upload lands after the switch.
- A card captured just after the switch, from a phone that has not yet seen
  the new label, gets English.
- The snapshot is written once, into immutable `defaults_snapshot`; the
  row's editable `language` starts from it. Changing defaults never
  rewrites existing rows. Code: `api/_scan_connect.js` `pickDefaults`,
  tests "defaults changed while a scan is in flight".

## Recognition states

Server-side from the phone's hits (never the phone's own verdict):

| State | Rule | Queue |
| --- | --- | --- |
| `matched` | top score ≥ 0.80 **and** (no runner-up or top − second ≥ 0.08) | Normal row. Counts toward submit without a click. |
| `ambiguous` | top ≥ 0.60 but not matched | Amber row; scan thumbnail beside up to 5 candidates; `Enter` / click confirms. Blocks submit until confirmed. |
| `unmatched` | no hit ≥ 0.60 | Red row with the thumbnail and **Replace printing** search (`/`). Blocks submit until a printing is chosen or the row removed. |
| `manual` | row added from search | Normal. |

0.80 + 0.08 is BattleScan's own `_immediate` rule (`server/app.py`);
0.60 is its "possible match" floor. It is stricter than the 0.72 used to
open a card page, because a wrong listing costs more than a wrong page
view. The phone keeps scanning in every state.

Finish is **never** inferred from the photo (the embedding cannot see holo
foil). It comes from the snapshot and is corrected with `i` (reverse) or `.`
(cycle).

## Manual add (PowerTools single-card)

Bar between Batch Defaults and the queue. Uses the **same header typeahead
engine** (`liveSuggestGroups` + `fetchSuggestRanked`, docs/TYPEAHEAD.md) via
`market/src/use-live-suggest.js`.

Flow (candyext KB "How to add one or more unsorted cards: SINGLE CARD"):

1. Type a name in **Add card** (also `SET 069`, typos, set peels, …).
2. Enter / click a printing → **article being added** strip; **Qty** autofocuses.
3. PowerTools hotkeys edit the draft while Qty is focused (digits type qty).
   An on-screen **hotkey legend** (`data-testid="hotkey-legend"`) shows every
   key; clicking a chip dispatches the same keydown onto Qty (candyext PT
   behaviour). Active attributes get a gold border.
4. Enter / Space **Create** → `POST /api/scan-batch?action=add` with draft attrs.
5. `c` **Create & copy** → same POST, keep the printing for another identity.
6. Esc / Delete cancel the draft (never deletes queue rows).

Row **Replace printing** (`/`) uses the same suggest hook.

## Queue

Dense table, newest at the bottom, auto-scroll while the last row is in view.

| Column | Content | Edit |
| --- | --- | --- |
| # | batch order | — |
| Art | catalog thumbnail; scan thumbnail for ambiguous/unmatched | click → large |
| Card | name · set · collector number | `/` replace, `←` `→` candidates, `Alt+1…9` |
| Lang | code (+ warning if the print nationality does not allow it) | PT keys `a s d f g h j k l m n p ] z x` |
| Cond | NM… | `q w e r t y u` |
| Finish | Standard / Reverse … | `i`, `.` |
| Flags | 1st · Signed · Altered · Graded | `o`, `[` |
| Loc | location | inline text |
| Qty | 1–99 | digits, `+` `-` |
| Price | PKN; greyed "suggested" when prefilled | inline |
| State | matched / check / unmatched / merged ×n | `Enter` confirm |

Prices prefill once per row+facet signature, 4 printings at a time. The
suggestion follows the row's facets from
`GET /api/marketplace-card-sales?cardId=&slices=1` (per-day
condition × language × reverse × 1st-edition medians): exact facets first,
then relaxing the finish/1st flag, then the nearest condition in the same
language, then the same condition in any language (English preferred), then
anything. When the printing has no sold comps at all, the cheapest listed PKN
(`GET /api/marketplace-card-cheapest-price?cardIds=`) is the floor. Switching
the version (or language/condition/finish/1st facets) re-suggests for the new
shape and clears the server-side price; a suggestion stays greyed
`suggested` until edited or confirmed, and only clicking into the price field
empties it for a manual price.

Status line: `187 cards · 12 need review · 3 need a price · Add 187 cards to Inventory`.

## Duplicate physical cards

**Decision: consecutive identical scans merge into one row and increment
its quantity; anything else is a new row.**

A scan merges into the previous **active** row of the batch when all hold:

1. Merge repeats was on in the scan's snapshot.
2. Both are `matched` (or the previous one was confirmed) with the same top
   `card_id`.
3. The new scan's snapshot attributes equal the previous row's **current**
   attributes (stack key).
4. No other scan arrived between them.

The new event is stored as its own row with `status = 'merged'`,
`merged_into = head`; the head's `quantity += snapshot.quantity`. The desktop
flashes `Qty 1 → 2` with **Undo** (and `Mod+Z`), which restores the merged row
as a separate row with its own quantity.

Why:

- Pokoin listings are **one row per identical stack** with a quantity
  (`marketplace_user_listings.quantity_available`, checkout decrements). A
  per-copy row model would create four listings for four copies.
- Only **consecutive** scans merge, so the queue keeps the physical order of
  the pile; a seller correcting "the 40th card" finds it where it was.
- Non-consecutive repeats (A, B, A) stay separate rows, and submit creates
  one listing per row so the review screen matches inventory 1:1. Merging
  into existing stock is follow-up #4 in the matrix.
- Every physical scan is kept as an event row, so no quantity is lost to
  deduplication; only a **retry of the same `scanEventId`** is dropped.
- Ambiguous scans never merge: each needs its own decision.

Four copies of Charizard 4/102 (NM, EN, Box A12): scans 1–4 → one row
`Qty 4`, four event rows (1 active + 3 merged). A retry of scan 3 returns
`duplicate: true` and changes nothing.

## Staged batch and submit

`scan_batches.status`: `open` → `submitted` (or `discarded`). Nothing is live
until submit.

`POST /api/scan-batch?action=submit {batchId, submitKey}` in **one writer
transaction**:

1. `select … for update` the batch. Already `submitted` → return the stored
   result (double-click, refresh, retry, second tab all land here).
2. Validate active rows: printing set, not unreviewed ambiguous/unmatched,
   price > 0, qty 1–99. Any failure → `409 {problems:[{itemId, reason}]}`,
   nothing written.
3. Insert one `marketplace_user_listings` row per active row with
   `source = 'pokoin_scan_batch'`, `source_listing_id = 'scan:' || item.id`,
   `on conflict do nothing` on the partial unique index
   `(source_listing_id) where source = 'pokoin_scan_batch'`.
4. Stamp `listing_id` on rows, `status = 'submitted'` on the batch with
   `submit_result`.
5. Commit, then refresh price summaries for the touched `card_id`s (same
   function `createListing` calls).

The button reads **Add 187 cards to Inventory** where 187 is the sum of
active quantities; `Mod+Enter` opens the same confirmation.

## Location

No location existed in Pokoin. Added as `marketplace_user_listings.location
text not null default ''` and a Batch Default, snapshotted like language.
One location per listing row: the same card in two boxes is two rows.
PowerTools' `locations[]` per-stack breakdown is deferred to the picking
work (matrix follow-up #5). `location` is **private**: returned only when a
seller reads their own listings (`?sellerUid=` with bearer), never on public
card or seller pages.

## Autosave and recovery

Everything the seller does is a server write on the batch; there is no
client-only state except the undo stack and focus.

| Event | What survives |
| --- | --- |
| Browser refresh / tab closed / desktop crash | Batch and rows (server). Reopen `/inventory/scan` → resumes the newest open batch; stream replays from cursor 0. |
| Phone disconnects | Session shows "Connection lost"; phone outbox retries with the same ids on reconnect. |
| PIN expires | Only the pairing row. Regenerate. |
| Session expires | Batch stays `open`; **Start new session** resumes it. |
| Two tabs | Both stream the same batch; edits are last-write-wins per field with row `seq` ordering. |

## API actions

`POST /api/scan-batch?action=`

| Action | Body | Notes |
| --- | --- | --- |
| `defaults` | `{batchId, defaults}` | Appends history, bumps version. |
| `item` | `{itemId, patch}` | `patch` ⊆ `cardId, condition, language, foilState, firstEdition, signed, altered, graded, gradingCompany, grade, certificationId, location, quantity, pricePkn, sellerComment, confirm` |
| `add` | `{batchId, cardId, …attributes}` | Manual row; defaults fill missing attributes. |
| `remove` / `restore` | `{itemId}` | Soft delete (undo). Removing a merged head's run does not touch merged rows. |
| `duplicate` | `{itemId}` | PT **C**: copy printing + attributes, qty 1, new row after it. |
| `unmerge` | `{itemId}` | Undo a merge. |
| `submit` | `{batchId, submitKey}` | Above. |
| `discard` | `{batchId}` | Batch `discarded`; sessions end. |

## Files

| Path | Role |
| --- | --- |
| `market/src/pages/ScanDesk.jsx` | Page: connect card, Batch Defaults Bar, queue, submit |
| `market/src/scan-model.js` | Row reducer (seq ordering), stack key, counts, submit readiness |
| `market/src/scan-stream.js` | Stream client, reconnect, cursor |
| `market/src/scan-shortcuts.js` | Key → command map, focus guard |
| `market/src/scan-api.js` | HTTP calls |
| `market/src/scan-desk.css` | Styles |
| CardVault `api/scan-batch.js`, `api/_scan_store.js` | Server |
