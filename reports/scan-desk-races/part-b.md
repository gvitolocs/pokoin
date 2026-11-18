# Scan desk races — part b: intake and row creation

Read-only analysis of the pokoin.com/scan pipeline, area **b**: pairing, the
change stream, row creation/re-key/merge/removal, the printing remap, "Merge
repeats", the Location/Stack/Position counters, the Game switch, and the server
side of the scan session in `pokoin-rust/`.

Workspace: `/home/nez/Projects/.worktrees/pokoin-web/scan-races-b` at
`scan-races-b` (`8e0e9a02`). Nothing outside it was read. No source file or test
was changed.

Files read completely or in the relevant regions: `solid/src/pages/ScanDesk.jsx`,
`solid/src/pages/scan-desk/{watch.js,rows.jsx,bars.jsx,price-requests.js,pricing.js,version-sets.js,duplicate-book.js,duplicates.js}`,
`market/src/{scan-model.js,scan-api.js,scan-stream.js,scan-pricing.js,scan-artwork-versions.js,game.js,api.js}`,
`pokoin-rust/crates/external/src/{routes/scan.rs,scan_store.rs,scan_connect.rs}`,
`pokoin-rust/crates/external/tests/fixtures/scan_schema.sql`,
`docs/CI.md`, `docs/SCAN_LISTING_WORKFLOW.md` (via `scan-pricing.js`'s spec pointer).

Severity classes: **data loss** > **wrong listing** > **wrong price shown** >
**stuck row** > **cosmetic**.

---

## 1. The "only overwrite an empty price" guard never reaches the server — a late suggestion overwrites a typed price

**Severity:** wrong price shown → wrong listing (real money).

**Interleaving**

1. Desk adds row `R` from a scan or from Add card; `R.pricePkn == null`
   (`ScanDesk.jsx:1258`, server inserts no price columns: `add_manual`
   `scan_store.rs:1627-1674`).
2. The prices effect claims `R` (`ScanDesk.jsx:1265`, `claimRows`
   `price-requests.js:15`) and takes the row **from the `list()` snapshot it was
   built from** — that same `row` object is used all the way down
   (`ScanDesk.jsx:1296-1315`).
3. `fetchCardSales(cardId, {slices:true})` is in flight, 200-600 ms
   (`ScanDesk.jsx:1283`).
4. During that window the seller clicks the price box (`rows.jsx:454-459`) and
   types `500`, then blurs: `priceFieldCommit` → `{action:'set'}` →
   `onPatch({pricePkn:500, priceSuggested:false})` (`rows.jsx:464`) →
   `patchRows` → `POST /api/scan-batch?action=item` → the server stores 500.
5. Step 3's run resolves with the sold-comps median, say `300`. It builds
   `patch = {pricePkn:300, priceSuggested:true}` and, because the **snapshot**
   row from step 2 still has `pricePkn == null`, adds
   `patch.onlyIfEmptyPrice = true` (`ScanDesk.jsx:1313`).
6. `patchRows([R.id], patch, {record:false})` posts
   `{itemId, patch:{pricePkn, priceSuggested, onlyIfEmptyPrice}}`
   (`scan-api.js:77`).
7. `mutate_batch` reads the flag from the **payload root**:
   `payload.get("onlyIfEmptyPrice")` (`scan_store.rs:2217`) → absent → `false`.
   `parse_item_patch` is a whitelist with no `onlyIfEmptyPrice` arm
   (`scan_connect.rs:928-1024`), so the key inside `patch` is silently dropped.
8. `patch_item` therefore skips its only protection —
   `if only_if_empty_price && row.price_pkn IS NOT NULL { drop the price columns }`
   (`scan_store.rs:1456-1458`) — and writes 300 over the seller's 500, marking
   it `price_suggested = true` (`scan_connect.rs:1005`).

The same dead guard also loses the **version-remap** ordering that the desk
explicitly tried to protect: `patchRows` serialises per row "or the server
applies them out of order and wipes the fresh suggestion"
(`ScanDesk.jsx:683-689`). Because a card change clears the price server-side
(`scan_store.rs:1470-1473`), the queued price write now lands *after* the change
and re-prices the new printing with the old printing's comps — the guard that
was meant to allow exactly that case (empty price) is the one that is dead, so
the *protective* use is also broken.

**Why the code allows it:** the flag lives in a different JSON level than the
reader, and `parse_item_patch` ignores unknown keys instead of rejecting them.
There is no contract test for the request shape at all — `grep -rn
onlyIfEmptyPrice` over the repo returns exactly the 2 client writes
(`ScanDesk.jsx:1313`, `:1342`) and 3 server occurrences (the `patch_item`
parameter `scan_store.rs:1438`, the guard `:1456`, the root read `:2217`), and
**no test file** — neither in `pokoin-rust/crates/external/tests/` nor any
`*.test.js`.

**Evidence:** confirmed by reading `ScanDesk.jsx:1310-1315`,
`scan-api.js:77`, `scan_store.rs:2217`, `scan_store.rs:1438/1456-1458`,
`scan_connect.rs:928-1024`. The client/server mismatch is present in the tree as
it stands. Blame: **`21ba8cef` (2026-10-08, Rust integration) introduced the
root-level read against an already-nested write.** The nesting is not a Solid
regression — `git show 9101a2d4^:market/src/scan-api.js` line 72 already posted
`{ itemId, patch }`, and `git show 9101a2d4^:market/src/pages/ScanDesk.jsx:1225`
already set `patch.onlyIfEmptyPrice` inside the patch in the React desk.
`9101a2d4` (2026-10-11, Solid port) only carried that shape forward.
`git log -S onlyIfEmptyPrice` lists no other writer. What the retired Node
`_scan_store.js` read is **suspected, not confirmed** — that file lives in
`gvitolocs/cardvault`, outside this workspace; if it read `patch` (which the
long-standing client shape implies), then the Rust port is the deviation.

**Does it explain a symptom above?** Not the empty boxes; it is the mechanism
behind "a price I typed is not the price on the row any more". It is also why
the desk's `onlyIfEmptyPrice` comment ("Fresh rows race only with an empty
price", `ScanDesk.jsx:1312`) is false reassurance.

**Fix sketch:** read the flag from the patch as well as the root in
`mutate_batch` (`payload.get("onlyIfEmptyPrice")
.or_else(|| patch.get("onlyIfEmptyPrice"))`), and delete the key inside
`parse_item_patch`'s whitelist so it is not treated as a row column.
Alternatively make the client send it as a sibling of `patch`. Either way, re-read
the row's `signature`/`seq` after the awaits in the prices run and skip the
write when the live row no longer matches the snapshot row that produced it.

**Regression test:** `pokoin-rust/crates/external/tests/scan_rows_flow.rs`,
`item_patch_only_if_empty_price_from_the_desk_shape_is_honoured` — POST
`/api/scan-batch?action=item` with the exact desk body
`{"itemId":…,"patch":{"pricePkn":300,"priceSuggested":true,"onlyIfEmptyPrice":true}}`
against a row whose `price_pkn` is already 500; assert the row keeps 500 and
`price_suggested` stays false, and that the same body with an empty price does
write 300. Tier: `flow-db` (informational) and `cargo test -p pokoin-external`
under `scripts/check-fast --db`; the non-DB part lands in GitHub `rust-gate`
(`test` + `changed`) because it is a `pokoin-rust/` change (`docs/CI.md:9,26,63`).

---

## 2. A scan that lands between the stream opening and the snapshot fetch is erased and never comes back

**Severity:** data loss (the row exists server-side and is submitted, but the desk no longer shows it).

**Interleaving**

1. `startSession` gets the session/batch and paints them
   (`ScanDesk.jsx:193-199`), then `flush()` (`:200`) — which runs the stream
   `watch` (`:252`) and opens `connectScanStream` **before** the snapshot
   request is issued.
2. The phone scans a card → `ingest_scan` → `bump_batch` → the row is committed
   with `seq = 1` (`scan_store.rs:1111,1149`).
3. The stream's 1 s poll picks it up (`routes/scan.rs:402`), sends an `items`
   frame; the client advances its cursor to 1 (`scan-stream.js:57-58`) and
   `dispatch({type:'items'})` puts the row in the store (`ScanDesk.jsx:269`).
4. The snapshot `GET /api/scan-batch?batchId=…` issued at `ScanDesk.jsx:204`
   — whose SQL read (`scan_store.rs:708`) happened **before** step 2 — now
   returns without that row, and `dispatch({type:'reset', items: snapshot.items})`
   rebuilds the store from an empty map (`:178` → `applyItems({}, items)`
   `scan-model.js:41-51`). The row is gone from the queue.
5. It can never be re-delivered: the stream only emits `seq > cursor`
   (`scan_store.rs:746`, `routes/scan.rs:412`) and the cursor is already 1.
   `read_batch_snapshot` is only called from `startSession`, so only a page
   reload heals it.
6. Meanwhile the row is still in the batch: submit lists it
   (`submit_batch` reads the DB, not the desk), so the seller gets N listings
   from N-1 visible rows. `batchCounts` (`:354`) and the "no price / needs
   review" chips are also short by one row.

The same wipe happens on every account switch (`:218-227`).

**Why the code allows it:** the snapshot reset discards the seq guard
(`applyItems({}, …)`) instead of merging, the stream is opened before the
snapshot, and the server already returns the authoritative counter
(`read_batch_snapshot` `"cursor": item_seq`, `scan_store.rs:723`; `hello` also
carries `cursor`, `routes/scan.rs:371`) which the client never reads —
`connectScanStream` starts at `initialCursor = 0` and `ScanDesk.jsx:255-258`
passes none.

**Evidence:** confirmed by reading `ScanDesk.jsx:185-216,252,178`,
`scan-model.js:41-51`, `scan-stream.js:51-58`, `scan_store.rs:708,723,746`,
`routes/scan.rs:364-371,402-417`. `grep -n cursor solid/src/pages/ScanDesk.jsx`
shows no cursor plumbing.

**Does it explain a symptom above?** It explains "a card I scanned is not in
the list" after a reload-while-scanning, and it explains a *missing* price row
rather than the reported stuck-price rows.

**Fix sketch:** either merge the snapshot (`dispatch({type:'items', items:
snapshot.items})` — the seq guard already makes it safe because every snapshot
row carries its stored `seq`), or seed the stream from the snapshot: open the
stream *after* `:205` with `initialCursor: snapshot.cursor`. The one-line
version is to pass `snapshot.cursor` and move `connectScanStream` behind the
fetch.

**Regression test:** `solid/src/pages/scan-desk/intake-reset.test.js`,
`reset_from_a_stale_snapshot_keeps_a_newer_stream_row` — build
`applyItems(applyItems({}, [rowA(seq 1)]), {})`-style calls directly against
`market/src/scan-model.js`: dispatch a store containing `A{seq:1}`, then apply
the stale snapshot `[B{seq:2}]` without `A`, and assert `A` is still present.
Add the mirror case in `routes/scan.rs`'s unit module only if the cursor is
threaded server-side. Tier: JS tests beside source (`node --test`);
`docs/CI.md` has **no** CI tier that runs front-end tests (`check-fast` steps
are rustfmt/clippy/cargo/shellcheck/actionlint/gitleaks, `docs/CI.md:21-28`), so
this test guards nothing in CI until it is wired — noted as a gap, not a fix.

---

## 3. Batch-default fan-out stamps rows with `seq + 1`, which the change stream can no longer deliver

**Severity:** wrong listing (rows shown with the old condition/language, and priced off it).

**Interleaving** (arithmetic, not timing-dependent)

1. Phone scans three cards: rows A, B, C get `seq` 1, 2, 3 and the batch
   `item_seq` is 3 (`scan_store.rs:1111`, `bump_batch` `:800-819`). The desk's
   stream cursor is 3.
2. The seller changes a Batch default (Condition, Language, Finish, a flag, or
   Location). `set_defaults` computes `next` and bumps the counter but
   **discards the returned seq**: `let _ = bump_batch(&mut tx, batch_id, 0)`
   (`scan_store.rs:1406`) → `item_seq` is now 4.
3. The fan-out then writes rows with `seq = seq + 1` (`scan_store.rs:1410`) →
   A=2, B=3, C=4. **Exactly one row out of N ends up above the cursor.**
4. The stream poll `items_after(cursor=3)` (`scan_store.rs:743-757`) can only
   ever return C. A and B are permanently below the cursor.
5. The calling tab is covered by the POST response `items` (`:1427`), so this
   does not hurt it — **unless that POST fails**: `setDefaults` only calls
   `setError` (`ScanDesk.jsx:786`), the optimistic per-row pending patch is
   dropped in `finally` (`:788-797`), and nothing re-delivers A and B.
6. A second desk window (the same batch is opened from `rememberActiveSession`,
   `ScanDesk.jsx:201`) or the next 55 s reconnect now shows A and B with the
   **old** condition/language while the DB has the new one.
7. The prices effect then suggests from the stale facets
   (`facetSignature(row)` = `cardId:condition:language:foilState:firstEdition`,
   `scan-pricing.js:37-45`) and **saves that price onto the server row**
   (`ScanDesk.jsx:1310-1315`) — a JP row priced with EN comps, an MP row priced
   NM. The listing itself is created from server rows, so the desk's stale
   display silently corrupts the stored price.

**Why the code allows it:** two different `seq` regimes. Every single-row
mutation sets `seq` to the fresh batch counter (`patch_item`
`scan_store.rs:1479-1481`, `add_manual`, `ingest_scan` `:1111/1149`, merge head
`:1174-1181`, `duplicate_item` `:1550-1567`); only the defaults fan-out
increments the row's own value. `stream_inner` has no per-row revision and no
gap detection, and the batch view's authoritative `cursor`
(`scan_connect.rs:1140-1153`) is ignored by the client, so nothing notices that
rows were rewritten behind the cursor.

**Evidence:** confirmed by reading `scan_store.rs:1404-1423` vs `:1479-1481`,
`:743-757`, `routes/scan.rs:400-417`. `scan-stream.js:1-3` states the opposite
contract ("we reconnect with the cursor, so duplicates and replays are harmless
(rows carry `seq`)"), and `:24` ("the next reconnect replays from cursor") is
false for fan-out rows. Which side deviated from the retired Node store is
**suspected, not confirmed** (`_scan_store.js` is outside this workspace).

**Does it explain a symptom above?** Partially: it is a second way a row can sit
at a stale facet signature, which then makes finding 8's signature comparison
fail. It does not by itself produce "2 need a price".

**Fix sketch:** in `set_defaults`, use the discarded `bump_batch` value for all
fan-out rows (`set {}, seq = $n`) or bump the batch once per row — anything that
keeps every fan-out row strictly above the previous `item_seq`. Cheap and safe
version: `let (fan_seq, _) = bump_batch(...)` and bind `seq = $k` with
`fan_seq`.

**Regression test:** `pokoin-rust/crates/external/tests/scan_rows_flow.rs`,
`defaults_fanout_rows_are_above_the_stream_cursor` — create a batch, `add` three
rows while recording `batch_view.cursor`, call `action=defaults` with a
condition change, then `items_after(cursor_before_fanout)` and assert **all**
active rows are returned (each row's `seq` strictly greater than the pre-change
cursor). Tier: `flow-db` informational plus `cargo test -p pokoin-external` in
`check-fast --db`; `rust-gate` `test`/`changed` cover the compile/unit part
(`docs/CI.md:9,26,61-64`).

---

## 4. A failed defaults POST is never rolled back, and the controls derive the next value from the rolled-forward state — "a Batch default cannot be switched off"

**Severity:** stuck setting → wrong listing (every later scan stamps the wrong default).

**Interleaving**

1. Batch defaults: `mergeRepeats = true` (server, desk, DOM checkbox all agree;
   `bars.jsx:366` renders `checked={Boolean(d().mergeRepeats)}`).
2. The seller unchecks "Merge repeats". The DOM checkbox goes off, `onChange`
   posts `{mergeRepeats:false}` (`bars.jsx:366`) → `setDefaults` applies the
   optimistic value to the store (`ScanDesk.jsx:764`).
3. The POST fails — a 401/403 after a server-side revocation (`token()` =
   `getBearer(force)` (`:183`) refreshes an *expired* token, but nothing in the
   desk ever calls `token(true)`, so a rejected bearer is never retried), a
   dropped request, or a 5xx. `catch` only does `setError` (`:786`);
   `batch.defaults` keeps `false`.
4. Nothing reconciles: `defaults_version` never moved server-side, so the
   stream's `batch` frame is never emitted — `batch_signature` is
   `status:defaults_version` (`routes/scan.rs:317-323`) and the update failed.
   The desk is now permanently inverted against the DB for this page session.
5. The phone keeps scanning; the **server** stamps `mergeRepeats = true`, so
   consecutive identical cards merge while the desk's checkbox reads "off".
6. The seller, seeing the switch "not take", clicks it again. The DOM checkbox
   now reports `checked=true`, so the client sends `{mergeRepeats:true}` — the
   value the server already has → `prev.get(key) == next.get(key)`
   (`scan_store.rs:1398`) → no fan-out, and the desk flips to "on". Clicking a
   third time sends `false`, and the cycle repeats. **The control toggles the
   desk's copy; it can no longer be observed to switch the batch off.**
7. For the flag chips the same inversion is worse, because the next value comes
   from the stale copy rather than the DOM: `onClick={() =>
   props.onChange({ [field]: !d()[field] })}` (`bars.jsx:213`), so
   `firstEdition`/`signed`/`altered` also march out of step with the server.

**Why the code allows it:** `setDefaults` is fire-and-forget optimistic with no
rollback and no request token; the failed write is reported only through the
shared `error()` signal, the value fed back into the control is the unvalidated
optimistic state, and there is no
`defaults_version` handshake on any of the four merge sites (`:197`, `:263`,
`:331`, `:764/:783`). `normalize_defaults` itself is fine — it honours an
explicit `false` (`scan_connect.rs:259-265,307-309`), so this is not a
normalization bug.

**Evidence:** confirmed by reading `ScanDesk.jsx:714-799` (no rollback,
`await token()` + direct `scanApi.defaults` at `:781-782`, `setError` only),
`bars.jsx:213,366`
(next value from `d()`/DOM), `scan_store.rs:1398` (no-op when unchanged),
`routes/scan.rs:317-323` (sig gate), `solid/src/stores/auth.js:137-149` and
`grep -n "token(true)"` over the desk (no call site). The specific failing call (401 vs network)
is inferred from the code paths; it is not reproducible from a log here.

**Does it explain a symptom above?** **Yes — symptom (c) "a Batch default
cannot be switched off"** is this, and finding 5 is its second, timing-only form.

**Fix sketch:** make `setDefaults` (a) retry once with `await token(true)` when
the response status is 401/403 (`request` attaches `error.status`,
`scan-api.js:50-55`), and (b) on error
re-apply the pre-patch defaults: capture `const before = current.defaults`
before `:764` and `setBatch(prev => ({...prev, defaults: before}))` in the
`catch`, then bump a `defaultsRetry` signal the way `retryPrices` does. Keep the
flag chips reading a reconciled value by sending an explicit
`{[field]: checked}` like the checkbox does.

**Regression test:** `solid/src/pages/scan-desk/set-defaults.test.js`,
`failed_defaults_post_rolls_the_optimistic_value_back` — extract `setDefaults`
into a testable seam (it already only needs injected `batch/patch/scanApi`),
stub `scanApi.defaults` to reject, assert that after the await
`batch().defaults.mergeRepeats` equals the pre-click value and `error()` is set.
If extraction is refused, use the source-text convention already in
`solid/src/pages/scan-desk/pick-remap-source.test.js`:
`defaults_failure_restores_previous_defaults`, asserting the `catch` block of
`setDefaults` contains a `defaults:` restore. Tier: `node --test` beside source
(no CI tier runs JS tests — see finding 2).

---

## 5. Last-arrival-wins on every `setBatch` merge: a reconnect's `hello` frame can revert a default the server already changed

**Severity:** stuck setting (usually self-heals in ~1 s; permanent when the POST response is slower than the stream poll).

**Interleaving**

1. The server closes every stream at 55 s (`routes/scan.rs:380`) and
   `scan-stream.js:97` reconnects immediately; a reconnect also follows any blip
   or tab suspend.
2. At `t=20 ms` the new connection's `stream_inner` reads the batch for `hello`
   (`:364-372`) — `mergeRepeats = true`, `defaults_version = 7`.
3. At `t=30 ms` the seller's `POST action=defaults` commits
   `mergeRepeats = false`, `defaults_version = 8` (`scan_store.rs:1373-1381`).
4. At `t=45 ms` the POST response lands: `setBatch(prev => ({...prev,
   ...data.batch}))` (`ScanDesk.jsx:783`) → desk shows off. ✓
5. At `t=50 ms` the `hello` frame (built at `t=20`) lands:
   `setBatch(current => ({...current, ...data.batch}))` (`ScanDesk.jsx:263`) →
   desk shows **on** again. No version comparison at either site.
6. Normally the stream's next 1 s poll reads v8, sees
   `batch_signature` change from `st.batch_sig` (`routes/scan.rs:418-425`) and
   sends a correcting `batch` frame. But if the API is slow enough that step 4
   arrives *after* that frame, the desk keeps the stale value with no further
   correction — the loop compares against **its own** last-read signature, not
   the client's.
7. Same shape for `stack`/`startPosition` (finding 10) and for `status`.

**Why the code allows it:** `batch_view` is merged with object spread at four
sites with no `defaults_version`/`cursor` guard, and the server's change
detector is per-connection state (`StreamState.batch_sig`) rather than
client-supplied, so it cannot tell that the client went backwards. `hello` also
carries the authoritative `cursor` that nobody reads (`:371`,
`scan-stream.js:57`).

**Evidence:** confirmed by reading `ScanDesk.jsx:263,331,783`,
`routes/scan.rs:317-323,364-372,418-425`, `scan-stream.js:51-58,97`. The
sub-100 ms window is inferred from the two request paths; the permanent variant
in step 6 depends on response latency — **suspected, not confirmed** as a
frequent occurrence.

**Does it explain a symptom above?** It is the second face of symptom (c), and
it is the reason a "cannot be switched off" report may not reproduce with one
click.

**Fix sketch:** apply `data.batch` only when it is not older: keep
`lastDefaultsVersion` and in the three merge sites (`:263`, `:331`, `:783`) do
`if ((data.batch.defaults_version ?? 0) >= untrack(lastDefaultsVersion))`, and
advance the stream cursor from `hello.cursor`/`snapshot.cursor` so a
reconnecting client never claims rows it has not seen.

**Regression test:** `solid/src/pages/scan-desk/batch-merge.test.js`,
`stale_batch_view_does_not_revert_a_newer_defaults_version` — pure function
`mergeBatch(current, incoming)` (extract the spread) with
`current.defaults_version = 8, mergeRepeats=false` and `incoming.defaults_version
= 7, mergeRepeats=true`; assert the result keeps 8/false. Tier: `node --test`.

---

## 6. A failed sold-comps read no longer falls through to the cheapest-listed / €10,000 rung; after 4 tries the row is dropped with its "already asked" claim still set — the price box regression

**Severity:** stuck row (empty price box, "Needs a price", "2 need a price").

**Interleaving**

1. Two fresh rows Vulpix (Call of Legends 75/95) and Ninjask (Dragons Exalted
   11/124) are added with `cardId` set and `pricePkn == null` — Pricing is
   "Suggested prices", so `rowPriced` is false, `priceOnLoad` is false
   (`ScanDesk.jsx:353,1788`) and `unpricedOnLoad()` is false
   (`rows.jsx:223`). With no price the placeholder branch falls through to
   `currency()` (`rows.jsx:451-453`) → **an empty box**.
2. The prices effect claims both (`:1265`) and queues one
   `fetchCardSales(id,{slices:true})` per printing, 4 in flight
   (`:1280-1290`, drained by `:1291-1293`).
3. The read **rejects** (a 5xx, an aborted fetch, a bearer blip). The wrapper
   swallows the rejection and deletes the cache entry
   (`:1287-1289`), so the later `await slicesCache.get(String(row.cardId))`
   yields `undefined` (`:1300`) → `!Array.isArray(slices)` (`:1304`) →
   `failed.push(row)` (`:1305`).
4. **`failed` rows skip both remaining rungs**: the cheapest-listed call
   (`:1322-1328`) and `scanFallbackPricePkn()` (`:1338`) are only reached by
   rows that are neither `settled` nor `failed` — the pricing loop at `:1330`
   bails at `:1331`. So a row whose *read* failed can never reach the fallback
   that `scan-pricing.js:5-6` promises: "the chain is
   sold comps → cheapest listed PKN → the €10,000 fallback below, so a scanned
   row always reaches the upload with a default price."
5. `retryPrices(failed)` (`:1345`) → `nextPriceRetry` bumps
   `priceFailures[{row}:{signature}]` and schedules 2 s, 4 s, 8 s, 16 s
   (`price-requests.js:46-58`). Each retry re-issues the same failing read.
6. After `PRICE_RETRY_MAX = 4` the row is dropped from `retry`
   (`price-requests.js:52`) — and because `retryPrices` returns early when
   `retry` is empty (`ScanDesk.jsx:584`), `releaseUnsettled` is never called for
   it, so `{row}:{signature}` stays in `pricesAsked` and `suggestedFor` keeps the
   same signature. (The release at `:585` only runs for rows that *are* in
   `retry`, so an exhausted row sharing the run with a still-retryable row is
   left claimed too.)
7. Every later run filters it out at `:1258`
   (`row.pricePkn == null` → `!pricesAsked.has(priceKey(...))` is false). The
   row sits at `rowProblem = 'no_price'` → "Needs a price" and
   `counts().noPrice` → **"2 need a price"** (`:1679`), with an empty box.
   Nothing in the give-up path schedules another tick, so with every row of the
   run exhausted the desk goes quiet and the claim survives **until a different
   dependency changes** (any row edit, close, intent switch — that run's cleanup
   `release()` at `:1273-1276` does clear it) **or the page reloads**. Only a
   focus+empty cycle in the field (finding 8) or a facet change (a new
   signature) can revive it sooner.

**Why the code allows it:** "no data" and "could not read data" were merged into
a single third state that is neither priced nor retried indefinitely; the
give-up path does not release the `pricesAsked` claim it made in `claimRows`,
and no rung of the documented chain is guaranteed to run.

**Evidence:** confirmed by reading `ScanDesk.jsx:1296-1345`,
`price-requests.js:15-22,25-35,46-58`, `ScanDesk.jsx:581-591`,
`market/src/scan-pricing.js:29-32`. The **regression commit is `4629f1bc`
(2026-11-13, "fix(scan-desk): a failed price lookup or save is retried, not
taken for 'no price'")**: before it, `fetchCardSales(...).catch(() => [])`
cached an empty array, so `Array.isArray(slices)` was true, the row fell to
`cheapestIds`, and `:1338` guaranteed `scanFallbackPricePkn()`. `git show
4629f1bc -- solid/src/pages/ScanDesk.jsx` shows exactly that `.catch(() => [])`
being removed and `failed`/`nextPriceRetry`/`PRICE_RETRY_MAX` added, and
`market/src/api.js` gaining `strict` for `fetchCheapestPricePknMap`.

**Does it explain a symptom above?** **Yes — symptoms (a) and (b)**: fresh rows
with Pricing = "Suggested prices" that never show a suggested price, stay empty,
and count up in "N need a price". It needs the sold-comps read to fail 5 times
for those two printings (plausible for a freshly imported printing where the
endpoint 500s or a proxy hiccups), so the *trigger* is inferred; the code path
is confirmed.

**Fix sketch:** give the give-up path a real last rung — on exhaustion, price
from `fetchCheapestPricePknMap`/`scanFallbackPricePkn()` once (never 10,000 EUR
silently if a listing exists) instead of abandoning the row, or at minimum
`releaseUnsettled` the row and surface "pricing unavailable, click to retry".
Keep `pricesAsked` and `priceFailures` in step: one clear set, no orphan claim.

**Regression test:** `solid/src/pages/scan-desk/price-requests.test.js`,
`exhausted_price_retry_does_not_leave_the_row_claimed` — call the seam twice
beyond `PRICE_RETRY_MAX` and assert (a) `nextPriceRetry` returns an empty
`retry`, (b) `releaseUnsettled` for that row was performed, i.e.
`pricesAsked` no longer contains `${rowId}:${signature}`. Plus
`rows_whose_comps_read_failed_still_reach_the_fallback_rung` asserting the
effect's decision helper routes a `failed` row to the cheapest/fallback chain
once retries are exhausted. Tier: `node --test` beside source.

---

## 7. Focusing the price box opts the row out of auto-pricing for the whole page session

**Severity:** stuck row → wrong listing (an unpriced row is listed paused at 0 by
the batch-pricing path, or blocks submit).

**Interleaving**

1. The seller clicks into row `R`'s price box — intending to look, or to type
   and then changing their mind. `onFocus` fires `props.onPriceFocus?.(row().id)`
   (`rows.jsx:457`) → `priceTouched.add(rowId)` (`ScanDesk.jsx:1801`).
2. The prices effect's first filter is now permanently false for `R`:
   `if (!row.cardId || priceTouched.has(row.id)) return false` (`:1256`).
3. If `R` had no suggestion yet, it never gets one → the same empty box and
   "Needs a price" as finding 6, but **without any server error**: a single
   stray click is enough.
4. If `R` *was* priced, the row later loses the price through the normal
   printing change path — the server clears `price_pkn`/`price_suggested` on a
   card change (`scan_store.rs:1470-1473`) and the auto-remap does change cards
   (`rows.jsx:107` → `onPick` → `ScanDesk.jsx:1818` `patchRows({cardId})`) — the
   effect will not re-suggest, because `priceTouched` is still set.
   `priceTouched` is deleted in exactly one place: `restoreDefaultPrice`
   (`:595`), i.e. only by emptying the field and blurring.
5. The in-flight run is not protected either: `priceTouched` is consulted only
   when the `want` list is built, so the suggestion computed before the click is
   written after it — which is finding 1.

**Why the code allows it:** `priceTouched` is a per-page-session blacklist keyed
by row id, set by focus rather than by an edit, and never deleted except in
`restoreDefaultPrice`. The three `dispatch({type:'reset'})` sites (`:178`, `:205`,
`:224`) leave every book in place, so a sign-out/sign-in or a snapshot arrival
keeps the opt-out of rows that no longer exist. `newBatch` (`:1481-1493`) *does*
re-assign `pricesAsked`, `priceTouched`, `suggestedFor`, `priceFailures` and
`lastSuggested` (`:1485-1489`), but not `slicesCache` (`:155`) or `remapTried`
(`:165`). Row ids are UUIDs so there is no collision, but the memory grows and
stale entries survive every reset.

**Evidence:** confirmed by reading `rows.jsx:454-459`, `ScanDesk.jsx:1801,1256`,
`:595`, `:154-165`, `:1484-1488` and `grep -n "priceTouched"
solid/src/pages/ScanDesk.jsx` (add at 1801, delete at 595, read at 1256 only,
re-created at 1486). No clearing at the `reset` sites.

**Does it explain a symptom above?** Yes, as an alternate cause of (a)/(b) that
requires no server error at all — and it is the mechanism that makes the
"suggested price no longer appears in a box I once clicked" complaint stick.
`onPriceFocus` was introduced by the port `9101a2d4`; it became user-visible
harm once `4629f1bc` removed the guaranteed fallback rung.

**Fix sketch:** set `priceTouched` on a real edit (in `priceFieldCommit`'s
`set`/`keep` outcome), not on focus; and clear the whole intake set together at
the batch-change points — add `slicesCache.clear()` and `remapTried.clear()` to
`newBatch` (`:1485-1489` already re-creates the five price books), and clear all
seven at the `dispatch({type:'reset'})` sites (`:178`, `:205`, `:224`).

**Regression test:** `solid/src/pages/scan-desk/price-touch.test.js`,
`focus_alone_does_not_opt_a_row_out_of_pricing` — assert the row-selection
predicate (extract it as `wantsPrice(row, books)`) returns true for a row whose
id is in the touched set only when `priceFieldCommit` returned `set`/`keep`.
And `batch_change_clears_price_books`. Tier: `node --test`.

---

## 8. "Clearing the box restores the default price" fails whenever the recorded signature is the snapshot's, not the row's

**Severity:** stuck row / cosmetic → wrong price shown.

**Interleaving**

1. A run claims `R` with signature `S1` and, when it computes a price, records
   `lastSuggested.set(R.id, {signature: facetSignature(row), pkn})` where `row`
   is the **snapshot object captured at claim time** (`ScanDesk.jsx:1311`,
   `:1341`), while the patch itself is addressed to the row id.
2. Meanwhile the row's facets change: an artwork remap (`rows.jsx:107` →
   `ScanDesk.jsx:1818`, which also rewrites `language` via
   `listingLanguageForPrint`, `ScanDesk.jsx:648`), a Batch-defaults fan-out
   (`scan_store.rs:1410`), or a chip edit. The live signature is now `S2`.
3. The seller focuses and empties the box and blurs: `priceFieldCommit(r,'')` →
   `{action:'default'}` (`scan-pricing.js:116-118`) →
   `props.onPriceEmptied?.(r)` (`rows.jsx:468`) → `restoreDefaultPrice(r)`.
4. `if (last?.signature === signature)` compares the recorded `S1` against the
   live `S2` → false (`:599`).
5. The fall-through tries to re-ask: `pricesAsked.delete(R:S2)` — but `pricesAsked`
   holds `R:S1` (`claimRows` used the snapshot signature, `price-requests.js:18`),
   so the delete misses; `suggestedFor.delete(R.id)` removes the entry that
   would have triggered the `:1259` re-suggest branch.
6. The fall-through branches at `:606`. **If the row carries a price**, it is
   cleared with `{pricePkn:null, priceSuggested:false}` (`:607`) and the function
   returns without touching any signal — the box is empty and the suggested value
   is gone. The row is technically eligible again (the filter at `:1258` looks up
   `R:S2`, which `claimRows` never wrote because it used `S1`), but **nothing has
   changed a dependency**, so no run starts: the empty box persists until some
   unrelated row edit, a close/intent switch, or a reload re-runs the effect.
   **If the row has no price**, `setPriceRetry((n) => n + 1)` (`:609`) bumps a
   dependency right there, the next run re-asks and the row heals. So the same
   user gesture either self-heals or sticks, depending on a value the seller
   cannot see — and note `priceTouched.delete(row.id)` at `:595` happens on both
   paths, which is why this is the only way out of finding 7.
7. In addition, `lastSuggested` holds `{S1, pkn_of_the_old_printing}`; if the
   signatures ever match again the *old* price is restored to the new printing
   (`:600`), bypassing the whole facet-relaxation chain.

**Why the code allows it:** `lastSuggested`, `pricesAsked` and `suggestedFor`
are all written from the run's row snapshot but read from the live row, with no
`seq` check and no re-read; `facetSignature` includes `cardId`, so any printing
change silently invalidates every recorded value for that row.

**Evidence:** confirmed by reading `ScanDesk.jsx:1310-1315,1338-1343,594-611`,
`price-requests.js:15-22`, `rows.jsx:460-470`, `scan-pricing.js:37-45,116-126`,
`scan_store.rs:1470-1473`, `ScanDesk.jsx:635-650`.

**Does it explain a symptom above?** **Yes — symptom (b) "clearing it no longer
restores it"**, and it is the reason "Suggested" appears/disappears erratically
in the chip (`rows.jsx:440`).

**Fix sketch:** re-read the live row inside `restoreDefaultPrice` and record
`lastSuggested`/`pricesAsked` keyed by `(rowId, seq)` or recompute the signature
at write time from `displayRows()` rather than from the snapshot; on a signature
mismatch, prefer "ask again" over "delete the price" and delete **both** the
snapshot and live keys.

**Regression test:** `solid/src/pages/scan-desk/price-restore.test.js`,
`clearing_a_priced_row_after_a_printing_change_asks_instead_of_empting` — drive
the extracted decision helper with `row{cardId:C2,…}`, `lastSuggested = {S1,pkn}`,
`pricesAsked = {C1-sig}` and assert the returned action is `re-ask`, that the
price is not cleared, and that both the `S1` and `S2` keys are released. Tier:
`node --test`.

---

## 9. The artwork remap blacklist is marked before its awaits and never un-marked on failure or cancellation

**Severity:** wrong listing (a JP/KO printing stays listed under a western
language, or a western row never remaps back).

**Interleaving**

1. `ArtworkVersionSelect`'s `watch` fires for row `R` with
   `tryKey = R.id \0 lang \0 cardId` (`rows.jsx:83`).
2. `remapTried.add(tryKey)` happens at `:85` — **before** the
   `fetchExactNameCards(cardName)` await at `:92`.
3. That fetch rejects; `.catch(() => [])` turns it into "no exact-name
   candidates", `preferred` stays null, no pick is issued (`:107`). The key is
   still blacklisted.
4. The next run of the same watch (a fan-out re-render, a language chip edit
   that lands back on the same `lang`) returns at `:84` — so for the rest of the
   page session the row can never be remapped, and it is submitted with the
   wrong-region printing while the batch language says otherwise
   (`scan-artwork-versions.js:159-177,237-253`).
5. Symmetrically, the "picked" half is pre-marked by `markPick` on a manual
   search-add (`ScanDesk.jsx:1015`, `:569-573`), which is intended
   (`51bf1feb`, `1632d88e`) — but because the keys include the language, a
   `EN → JP → EN` batch-language round trip finds `R\0EN\0C1` already in the set
   and skips the remap back to the western sibling for the whole session.
6. Cancellation has the same effect: `:107` bails out on `cancelled` after the
   await, leaving the mark behind.

**Why the code allows it:** `remapTried` is a monotonically growing page-session
`Set` with no failure branch and no reset on batch change or row re-key; the
guard was added to stop a *bounce*, and it also stops the *retry*.

**Evidence:** confirmed by reading `rows.jsx:61-111` (`:84` read, `:85` write,
`:92` await, `:107` cancelled branch). `:107` checks a *separate* key,
`tryKey + "\0picked"`, so the guard that keeps a user's own pick from bouncing is
not the `:85` mark: moving `remapTried.add(tryKey)` down to just before the
`onPick` call does not re-introduce the bounce the `51bf1feb` guard was written
for. `markPick` and the set itself: `ScanDesk.jsx:165,569-573,1015,1800,1818`.
Which of `51bf1feb` / `1632d88e` added each half is from those commits'
diffs; the "EN→JP→EN skip" consequence is derived by reading the key shape —
**suspected, not confirmed** by an executed repro.

**Does it explain a symptom above?** Not directly, but it is an intake-side
wrong-listing risk and it silently re-prices (or, with finding 7, fails to
re-price) rows via `scan_store.rs:1470-1473`.

**Fix sketch:** move `remapTried.add(tryKey)` from `:85` to immediately before
the `props.onPick(nextId)` call at `:107` — the rejected lookup and the
`cancelled` branch then leave no mark, so the next watch run re-asks. The cost is
one extra `fetchExactNameCards` after a real failure, which is not the bounce
`51bf1feb` was guarding against (that guard belongs to `tryKey + "\0picked"`).
Clear `remapTried` with the other intake books on batch change.

**Regression test:** the convention for this module is already source-text
(`solid/src/pages/scan-desk/pick-remap-source.test.js`): add
`remap_guard_is_marked_only_around_a_real_pick`, asserting that in
`rows.jsx` no `remapTried.add(` appears before the `fetchExactNameCards(` await
and that a `cancelled`/reject path removes the key. A behavioural version needs
the watch extracted into a function. Tier: `node --test`.

---

## 10. Two independent writers of `stack`/`startPosition`, one of them behind an await

**Severity:** wrong listing (two cards land in the same divider slot) / cosmetic.

**Interleaving**

1. Writer A: the auto-advance watch fires on every `list()` growth and posts
   `setDefaults({stack, startPosition})` computed from the **client's** row list
   (`ScanDesk.jsx:421-447`, `nextBoxPositions(rowsNow, {occupiedAbs})`).
2. Writer B: the Location field applies 700 ms after typing stops
   (`bars.jsx:105-109`) → `setDefaults({location})`, which then awaits
   `fetchSellerBoxSlots(sellerUid, …, {box, stackSize})`
   (`ScanDesk.jsx:730`) — a network read taken **after** `current`/`d` were
   captured at `:715-717` — and overwrites `stack`/`startPosition` from live
   inventory when the patch did not name them (`:736-743`).
3. A scan lands between B's read and B's write. Writer A posts the new cursor
   (based on 1 more row), then B posts its cursor (based on inventory only,
   which does not know about the unsubmitted batch row).
4. Both go through `normalize_defaults`/`batch` merge with no ordering token, so
   whichever response arrives last wins (`:783`) — and the losing value is also
   persisted to localStorage: `store[loc] = {stack, startPosition, stackSize}`
   (`:757-762`) from `nextPatch`, i.e. from the pre-await plan.
5. The desk's slot map is derived from the *rows*, not from the cursor
   (`scan-model.js` `boxSlots`, seeded by `occupiedAbs`, `ScanDesk.jsx:349-350`),
   so the on-screen `·stack·position` labels and the phone's next
   `location/position` stamp disagree: two cards in one divider, or a gap.
6. `DefaultsBar`'s `createEffect` resyncs the drafts from the (possibly stale)
   defaults on every batch write (`bars.jsx:84-87`), so the "Current stack"
   field the seller is typing in is silently rewritten mid-edit.
7. Because the phone takes `stack`/`startPosition` from the batch defaults at
   capture time, a lost update means the *next* scan is stamped into a slot the
   desk already shows as taken.

**Why the code allows it:** `setDefaults` is neither serialized (unlike row
patches, which use `patchChain`, `:686`) nor versioned; there is no request
token to drop a late response, and the inventory hint is read outside any
transaction, so it is a classic read-await-write. `commitStack` also computes
its own `positionForStack` (`bars.jsx:110-127`, `ScanDesk.jsx:529-546`) from the
same racing values.

**Evidence:** confirmed by reading `ScanDesk.jsx:421-447,714-799`,
`bars.jsx:84-87,105-127`, `scan_store.rs:1358-1430`,
`scan_connect.rs:230-254,316-334`. Whether a colliding slot actually reaches the
inventory writer is part c's territory (submit) and was not traced — **suspected,
not confirmed**.

**Does it explain a symptom above?** No — it explains Location-gear weirdness,
which the brief put in this area.

**Fix sketch:** route all defaults writes through one per-batch chain (the same
`createPatchChain` helper already used for rows), and compare
`data.batch.defaults_version` before merging (finding 5's guard) so a late
response cannot roll the cursor back; persist `scan:box-positions` from the
*response*, not from `nextPatch`.

**Regression test:** `solid/src/pages/scan-desk/defaults-chain.test.js`,
`overlapping_setDefaults_writes_serialize_and_the_newer_version_wins` — two
concurrent calls with stubbed `scanApi.defaults` (the first resolves later),
assert the final `batch().defaults.startPosition` equals the later-committed
response's version, not the slower-arriving one. Tier: `node --test`.

---

## 11. `removeRows` removes sequentially and only records undo after all succeed

**Severity:** data loss (an undone removal is unrecoverable) / stuck row.

**Interleaving**

1. `removeRows(['A','B'])` awaits `scanApi.remove` per id
   (`ScanDesk.jsx:889-893`) — A is removed server-side (`set_status`,
   `scan_store.rs:1498-1526`).
2. B's request fails → `catch { setError(...); return; }` (`:894-897`) → the
   undo entry (`:898-902`) and the "2 removed" toast (`:903-907`) are never
   pushed.
3. The seller sees an error and assumes nothing happened; A is gone from the
   batch with no restore path in this session (rows are `status='removed'`, so
   `restore` still works but nothing in the UI offers it).
4. There is also no optimistic mark: while the loop runs, A and B stay in
   `list()`, so they are counted in `counts()` and are still submittable — a
   submit fired in that window lists a row the seller was deleting. `removeRows`
   does not take the row `patchChain`, so the two interleave freely (the server
   serialises them via `lock_item`, `scan_store.rs:1325`, so the *last* write
   wins rather than corrupting, but the desk's counts and the batch contents
   disagree in the meantime).

**Evidence:** confirmed by reading `ScanDesk.jsx:889-908`,
`scan-api.js` remove/restore calls, `scan_store.rs:1498-1526`. The submit-window
consequence is stated by the row-status contract only — the submit side is part
c.

**Does it explain a symptom above?** No.

**Fix sketch:** dispatch an optimistic `status:'removing'` before the loop, push
the undo entry for whatever actually got removed (per id, inside the loop), and
run the removals through `patchChain` so a queued price patch cannot resurrect a
row.

**Regression test:** `solid/src/pages/scan-desk/remove-rows.test.js`,
`partial_remove_records_undo_for_the_rows_that_went` — stub `scanApi.remove` to
succeed for A and reject for B, assert an undo entry containing only A exists and
that the error is surfaced. Tier: `node --test`.

---

## 12. Fractional copy positions exhaust double precision

**Severity:** cosmetic → stuck row (queue order and slot indices collide).

**Interleaving**

1. `duplicate_item` positions the copy at the midpoint
   `(position + next) / 2.0` (`scan_store.rs:1546-1548`), `position` being
   `double precision` (fixture `scan_schema.sql:37`) and `ORDER BY position`
   used for both the neighbour lookup (`:1539`) and `read_batch_snapshot`.
2. Duplicating repeatedly between the same two neighbours halves the gap each
   time; after ~50 iterations the midpoint rounds back to `position` (f64 has 53
   mantissa bits), so the copy gets the **same** position as its source.
3. The desk sorts by position (`scan-model.js:54-56`) and derives queue indices
   and `nextAttentionIndex` from that order, so a tie reorders arbitrarily
   between renders; `rows.jsx:179`'s `data-row={props.row.id}` keeps the DOM
   keyed, but the Position column and `slots` mapping for those rows disagree.

**Evidence:** confirmed by reading `scan_store.rs:1537-1568`,
`scan_schema.sql:37`, `scan-model.js:53-56`. Reaching the limit requires ~50
copies in one gap; the phone path always uses integer `item_position`
(`bump_batch`, `scan_store.rs:1111`) so it does not contribute. **Suspected,
not confirmed** as an observed occurrence.

**Does it explain a symptom above?** No.

**Fix sketch:** when `next` and `position` have no representable midpoint
(`(position + next) / 2.0 === position`), renumber the tail (or fall back to
`position + 0.5` and shift the rest), or store positions as scaled integers /
fractional-index strings.

**Regression test:** `pokoin-rust/crates/external/tests/scan_rows_flow.rs`,
`repeated_duplicate_never_shares_a_position` — duplicate the head row 60 times
and assert all 61 `position` values are distinct and strictly ordered. Tier:
`flow-db` informational (needs Postgres) + `rust-gate` compile/unit.

---

## 13. `scan:box-positions` is written by two racing writers and never read back — the persisted Start cursor is dead state

**Severity:** cosmetic (a stored setting that promises a behaviour it does not
have), plus a lost-update race on the same blob.

**Interleaving**

1. `version-sets.js:34-35` documents the map as "Where the seller stopped in each
   box, so the next session's Start position defaults there", with
   `loadStoppedPositions()` (`:36-42`) / `rememberStoppedPositions(next)`
   (`:45-48`) reading and writing the **whole JSON blob** under
   `scan:box-positions` (`:32`).
2. `grep -rn "loadStoppedPositions\|rememberStoppedPositions"` over the repo
   returns exactly two call sites, both in the desk: the stopped-positions watch
   (`ScanDesk.jsx:402`, `:415`) and `setDefaults` (`:756`, `:762`). **Neither ever
   applies a stored cursor to `defaults`.** The watch reads `store[box]` only to
   decide `dirty` (`:405-413`); `setDefaults` writes `store[loc]` and moves on
   (`:757-761`). A fresh page takes its cursor from the batch defaults and the
   box inventory instead (`:449-497`, `:501-526`, `positionForStack`
   `:529-546`) — the Location seed at `:502-526` only fills the *box name* from
   `fetchSellerBoxSlots`, never a position. The documented "next session"
   behaviour therefore does not exist.
3. Within one session the two writers still race on the blob. Writer A recomputes
   every box from the **rows** (`nextBoxPositions(rowsNow, …)`, `:401`) and
   overwrites `store[box]` whenever it disagrees (`:406-412`), then writes the
   whole map back (`if (dirty) rememberStoppedPositions(store)`, `:415`); writer B
   stores the cursor the seller just typed (`:757-761`). Because A re-runs on
   every change of `list()` (`:397`) — that is, on every scan — the value that
   survives in storage is A's row-derived cursor, not the explicit one, so even
   the write-mostly state quietly contradicts the comment at `:390-394`
   ("Explicit Stack/Position edits are remembered in setDefaults").
4. With the desk open twice (the batch is re-opened from `pokoin.scan.session`,
   `:201`; the Location seed at `:502-526` then re-fills the field), each
   whole-blob write drops the other window's boxes: window 1 reads the map at T1,
   window 2 writes `{A:…, B:7}` at T2,
   window 1 writes its T1 copy plus its own box at T3 and `B` is gone. There is no
   `storage` listener for this key (`grep -rn "'storage'"` finds only
   `solid/src/stores/cart.js:73` and `solid/src/stores/session.js:13`).

**Why the code allows it:** the persistence unit is the whole object, not the
box; nothing compares versions and nothing consumes the value it stores, so no
test or render path ever notices a lost entry. The comment at `:449-450` ("That
inventory slot wins even when a saved cursor ran ahead into an empty stack")
shows a saved cursor was meant to be consulted at all — the read was simply never
wired, so the precedence rule has nothing to override.

**Evidence:** confirmed by reading `version-sets.js:32-48`,
`ScanDesk.jsx:390-416,452-526,754-762` and by the two greps above. That nobody
reads the map back is a negative result over the whole repo — **confirmed by
reading**; whether Giuseppe considers the missing seed a bug or a dropped idea is
the owner's call. Step 4 needs two open windows — the code path is confirmed, the
usage pattern inferred from `rememberActiveSession`.

**Does it explain a symptom above?** No. It does explain a "Start position
resets after reload" class of report, which is a missing read, not a lost write.

**Fix sketch:** pick one. (a) Delete the persistence — it is dead state, and the
box-inventory path already continues after the last card in the box
(`:449-451`). (b) Make the contract real: when the Location first becomes
non-empty for a batch (the one-shot shape already at `:502-526`), seed
`stack`/`startPosition` from `loadStoppedPositions()[box]` unless the seller has
typed one in this session; mark entries written by `setDefaults` with
`explicit: true` so the rows-derived watch skips them (`:406`); and store per box
(`scan:box-positions/<box>`) or
`rememberStoppedPositions({ ...loadStoppedPositions(), [loc]: value })` so a write
never erases another box.

**Regression test:** `solid/src/pages/scan-desk/box-positions.test.js`,
`remember_stopped_positions_merges_rather_than_replacing_the_map` (seed `{A:…}`,
write box `B`, assert `A` survives) and
`stored_cursor_is_the_one_the_desk_reads_back` — assert a `stoppedPositionFor(box)`
seam exists and returns the stored entry, or (option (a)) that nothing writes the
key at all. Tier: `node --test`.

---

## 14. A late pairing refetch reinstates a spent or foreign session's QR, and nothing heals it

**Severity:** stuck row (the desk advertises a PIN/secret no phone can claim —
no scan can arrive at all until reload).

**Interleaving**

1. A `session` frame reports `status: 'waiting'`, so the desk fires a refetch
   with no cancellation and no identity check —
   `if (next?.status === 'waiting') { token().then((t) => scanApi.session(t, next.id)).then((res) => { setPairing(() => res.pairing); … }).catch(() => {}); }`
   (`ScanDesk.jsx:324-328`, inside the `name === 'session'` branch at `:312`).
   `scanApi.session` is a plain GET (`market/src/scan-api.js:73`).
2. Order A (session identity changes underneath it): the account-switch watch
   nulls the pairing (`:223`) and calls `startSession()` (`:225`), or New batch
   does the same (`:1492`), and `startSession` paints the fresh pairing after its
   own await (`:198`). The older GET resolves **last** and writes `pairing()`
   with the *previous* session's row while `session()` is the new one.
3. Order B (same session, worse): the frame fires the GET at T1; at T2 the seller
   clicks "New code" → `regenerate` (`:1377-1385`) → `scanApi.regenerate`
   (`market/src/scan-api.js:69`, `POST /api/scan-session?action=pairing`) →
   `regenerate_pairing` (`scan_store.rs:359`) → `create_pairing` (`:99`), which
   first deletes every pairing row of the session (`:104`) and then inserts the
   new secret. `setPairing(P2)` lands at `:1382`. The T1 GET read the row before
   that delete (`pairing_for_session`, `:141-156`), answers with the now-deleted
   P1 and overwrites P2 at `:326`. Because both concern the *same* session id,
   the identity check that fixes order A cannot catch order B.
4. Either way the tile now advertises a dead secret: `waiting()` is
   `session()?.status === 'waiting' && pairing()` (`:1497`), so the block renders
   (`:1545`) with the stale `pin` (`:1570`) and `QrBlock secret={pairing().qrSecret}`
   (`:1579`), while `expiresIn()` (`:1498-1501`) counts the stale `expiresAt`.
5. The phone scans it → `claim_pairing`'s `delete … returning session_id`
   (`scan_store.rs:538-545`) matches nothing (P1 was deleted at `:104`/`:164`,
   or belongs to an ended session), `claimed_session_id` stays `None` and the
   whole branch falls through to
   `ApiError::bad_request("Code not valid or expired.").with_code("invalid_code")`
   (`scan_store.rs:572-579`) — one 400 text for wrong, expired **and already
   used** codes, exactly as `docs/SCAN_CONNECT.md:57` states. `docs/SCAN_CONNECT.md:279`
   already lists "QR from another tab after **New code**" as a known cause of
   that message, so this family of stale-code reports is documented but
   unguarded on the client. No scan can reach the desk until the seller presses
   "New code".
6. No self-heal, and the answer also throws away its own cure: the refetch
   response carries the authoritative `session` (`scan_store.rs:408-413`) and the
   client uses only `res.pairing` (`:326`) and `res.justIdleDisconnected`
   (`:327`) — `res.session` is **discarded**, so `session()` keeps the frame's
   `waiting` even when the GET already idle-disconnected or ended the session it
   was asked about (`get_session` performs those writes itself: `:394-400`).
   A `session` frame is emitted only when `session_signature` changes
   (`routes/scan.rs:426-432`, `session_signature` `:326-331`), and the status the
   client last heard was already `waiting`, so no further frame re-fires `:324`.
   Only a reload (`startSession` `:1492`) or an explicit regenerate repairs it.
   The refetch is also a *lifecycle* read, not a passive one: an action-less GET
   goes to `get_session` (`routes/scan.rs:274-279`), which is where those
   idle-disconnect/expiry writes happen.

**Why the code allows it:** `pairing()` has four independent post-`await` writers
— `:198` (start), `:326` (this refetch), `:1382` (`regenerate`), `:1400`
(`sessionAction` disconnect/pause/end) — each a whole-signal overwrite with no
sequence number, no abort and no compare against what is on screen; only `:223`
clears it synchronously. The stream next door does have a teardown (`:335`
`handle.stop()`), so the pattern exists in the file. The same read is also
**side-effecting** (`get_session` writes the session it is only asked to look at,
`scan_store.rs:394-400`), so overlapping refetches reorder server state too.

**Evidence:** confirmed by reading `ScanDesk.jsx:196-201,218-227,312-328,1377-1385,
1400,1492,1497-1501,1545,1570,1576,1579`, `market/src/scan-api.js:69,73`,
`scan_store.rs:99-104,141-156,164,359,385-414,538-545,572-579`,
`routes/scan.rs:275-279,292`, `docs/SCAN_CONNECT.md:57,279`. The missing identity
check, the missing cancellation and the discarded `res.session` are confirmed by
reading; that the two orders overlap in a real browser session is **suspected,
not confirmed** (no repro run here — order B needs one click inside a GET's
round trip, which is exactly the window the desk's other awaits show is
hundreds of ms).

**Does it explain a symptom above?** Not the price symptoms. It is the candidate
for "I signed in again / pressed New batch / pressed New code and now the phone
says the code is invalid" — intake stops completely.

**Fix sketch:** serialise the writers. Keep a monotonic counter
(`let pairingReq = 0`) bumped by `startSession` (`:198`), `regenerate` (`:1382`)
and `sessionAction` (`:1400`); the frame refetch captures
`const asked = ++pairingReq` before `token()` and applies its answer only while
it is still the newest and the session it asked about is the current one —
`if (asked !== pairingReq || untrack(session)?.id !== id || untrack(session)?.status !== 'waiting') return; setSession(() => res.session); setPairing(() => res.pairing);`
— so order B is dropped by the counter and order A by the id. Applying
`res.session` at the same time also stops the desk rendering a `waiting` tile for
a session the same response reported as idle-ended.

**Regression test:** extract the handler as
`applyPairingResponse(currentSession, res)` and add
`solid/src/pages/scan-desk/pairing-refetch.test.js`,
`a_pairing_response_for_another_session_is_dropped` — assert the returned patch
is `null` when `res.session.id !== currentSession.id` or the status is not
`waiting`. Tier: `node --test` beside source; per `docs/CI.md:21-28` no CI tier
runs front-end tests, so this guards nothing in CI until wired (same gap as
finding 2).

---

## 15. Intake side notes worth one line each

- **Owner book is never re-read after a failure.** `scanOwnerBook` creates the
  entry and fires one `loadOwnerBook` in a `queueMicrotask` whose rejection is
  swallowed (`duplicate-book.js:20`), so the rows signal of that map entry never
  leaves `null`. `inventoryBooks` itself does allow a retry — `revalidate` clears
  its `pending` entry in a `finally` (`market/src/inventory-book.js:293-296`) —
  but nothing re-enters `loadOwnerBook`, because the `books` map entry created at
  `duplicate-book.js:14-16` short-circuits every later call. So `QueueRow`'s
  `duplicateNote` memo (`rows.jsx:251-252`), rendered at `:325-326`, gets `null`
  forever: duplicate notes ("listed", qty in stock) silently vanish from every
  row for that uid+game until reload. **Confirmed by reading.** Fix: on failure
  delete the map entry (or store a `retryAt`) so the next render re-asks.
  Test: `duplicate-book.test.js`, `failed_owner_book_read_is_attempted_again`.
- **Two books survive a batch change; all of them survive a `reset`.**
  `newBatch` (`:1481-1493`) does re-create `pricesAsked`, `priceTouched`,
  `suggestedFor`, `priceFailures`, `lastSuggested` (all `let`, `:154-163`), but
  `slicesCache` (`:155`) and `remapTried` (`:165`) are `const` and are never
  cleared — so a new batch keeps the previous batch's sold-comps promises (harmless,
  keyed by card id) and the previous batch's artwork-remap blacklist (not
  harmless: row ids are new, but the set only grows). Independently, none of the
  books is cleared by the three `dispatch({type:'reset'})` sites
  (`:178`, `:205`, `:224`) — so a sign-out/sign-in or a snapshot arrival keeps
  claims, `priceTouched` opt-outs and failures of rows that no longer exist.
  Unbounded growth plus stale claims (finding 6's orphan `pricesAsked` key).
  **Confirmed by reading.**
- **Scan images leak.** `fetchScanImage` creates object URLs that are stored in
  the `images` signal and never revoked — not on row removal
  (`removeRows:889`), not on batch change (`:1481`), not on unmount
  (`ScanDesk.jsx:1355-1374` cancels only the fetch). A memory finding, not a
  race. **Confirmed by reading; `grep revokeObjectURL` returns nothing in
  `scan-api.js`.**
- **`ingest_scan`'s duplicate check is a plain SELECT.** `scan_store.rs:946-951`
  reads `scan_event_id` without `FOR UPDATE`, so a phone retry racing the
  original relies on the DB unique index; the fixture has
  `ADD CONSTRAINT scan_items_scan_event_id_key UNIQUE (scan_event_id)`
  (`tests/fixtures/scan_schema.sql:96`) so the loser gets a constraint error and
  the `?` returns before `tx.commit()` — a rollback, so no duplicate row, but a
  500 to the phone for a legitimate retry. Whether production carries the same
  index is **not confirmed** (production schema lives in the retired CardTrader
  ingest tree, outside this workspace).
- **`unmerge_item` clamps with `greatest(1, quantity - $2)`**
  (`scan_store.rs:1577-1624`): after a partial unmerge the head can retain more
  than the arithmetic says, because the split quantity is not re-derived from the
  merged children. Cosmetic-to-wrong-quantity; **confirmed by reading the SQL
  only, not traced end to end.**
- **`purge_expired` only cleans pairings and rate limits**
  (`scan_store.rs:822-831`); expired *batches* are not in scope, so
  `MAX_BATCH_ROWS`/`scan_items` growth is unbounded here. Out of area (jobs).
- **The Game switch reloads the document mid-flight.**
  `setScanGameOverride(next)` then `window.location.assign(...)`
  (`bars.jsx:163-179`) — the old document keeps running until unload: the 1 s
  clock (`ScanDesk.jsx:243`), the stream, `priceRetryTimer` (`:587`) and the
  game-push watch (`:360-365`, which calls `setDefaults({game})`) all stay live
  and can write to the batch during teardown. The new document then re-reads
  `pokoin.scan.session` and the same batch, so the writes are usually
  idempotent — but `defaults.game` can be stamped by the *old* page's
  interpretation of the override. **Confirmed by reading; the exact bad outcome
  was not reproduced.**

---

## Async sources found in this area

Client (`solid/src/pages/ScanDesk.jsx`, `scan-desk/*`, `market/src/scan-*.js`):

1. `getBearer` / `token()` — auth reads (`:190`, `:781`, `:258`), plus
   `runApi`'s force-refresh path (`:559-564`).
2. `POST /api/scan-session?action=start` (`:193`) → session, batch, pairing,
   serverTime (`:196-199`).
3. `GET /api/scan-batch?batchId=` snapshot (`:204`) → `dispatch({type:'reset'})`
   (`:178`).
4. The SSE-over-fetch change stream (`:252-336`, `scan-stream.js`), with `hello`
   / `items` / `session` / `batch` / `bye`, jittered reconnect, 55 s server
   lifetime, 1 s server poll.
5. `GET /api/scan-session?sessionId=` pairing refetch on a `waiting` session
   frame (`:324-329`) and `regenerate` (`:1378-1414`).
6. `setInterval(setNow, 1000)` (`:243`) — drives `sessionPhase`, idle notes.
7. `priceRetryTimer` backoff timer (`:587-590`).
8. Prices effect (`:1251-1353`): `fetchCardSales` (≤4 in flight),
   `fetchCheapestPricePknMap({strict:true})`, per-row `patchRows`; cancelled by
   any `list()` change, `closed`, `submitIntent`, `priceRetry`.
9. Images effect (`:1355-1374`): sequential `fetchScanImage` ≤6, object URLs.
10. `ArtworkVersionSelect` per-row watch (`rows.jsx:61-111`): `loadVersionSet`,
    `fetchExactNameCards`, `remapTried`; `CandidateAlts` watch (`rows.jsx:153`).
11. `patchChain` per-row serialization (`:686`, `scan-model.js`
    `createPatchChain`).
12. `setDefaults`: `fetchSellerBoxSlots` await then `POST action=defaults`
    (`:730`, `:782`); unserialized.
13. DefaultsBar: four `createEffect` draft syncs (`bars.jsx:84-87`), the 700 ms
    location debounce (`:105-109`), the `sizeOpen` document `mousedown` listener
    (`:76-83`), `commitStack`/`commitPos`/`pickSize` (`:110-145`).
14. Auto-advance + stack-full timers (`:421-447`, `stackFullTimer` 2800/3200 ms).
15. Stopped-positions watch writing `scan:box-positions` localStorage
    (`:396-416`), the one-shot Location-seed watch on
    `fetchSellerBoxSlots` (`:502-526`, `locationSeeded`), box-stock effect with
    `cancelled` (`:452-497`).
16. `queueMicrotask` owner-book load (`duplicate-book.js:18`) → row duplicate
    notes (`duplicates.js` WeakMap index).
17. `requestAnimationFrame(focusDraftQty)` (`:990-994`, `:1026`), draft
    typeahead (`rows.jsx` `ManualAddBar`, `ReplacePrinting`).
18. `window` scroll listener setting `followTail` (`:381-389`) → `setFocusId` on
    `added` events (`:308-310`).
19. Game switch: `pokoin.scanGame` localStorage write +
    `window.location.assign` (`bars.jsx:163-179`).
20. Sign-in/uid watch (`:218-227`), `onSettled` teardown (`:242-248`).
21. `rememberActiveSession` / `endActiveScanSessionForSignOut`
    (`pokoin.scan.session`, 1500 ms race, `scan-api.js`).
22. Toast/undo stack timers (`:550-557`, `pushToast({ms})`).

Server (`pokoin-rust/crates/external/src/`):

a. `claim_pairing` — PIN select, `scan_rate_limits` read/write, session insert
   (`routes/scan.rs:211-226`, `scan_store.rs:488-660`), `purge_expired`.
b. `ingest_scan` — `lookup_cards_from_catalog` await **before** `pool.begin()`
   (`scan_store.rs:912` vs `:939`), unlocked dedup SELECT (`:946`),
   `session_for_token(..., true)` lock, captured-at/defaults-history pick
   (`:968-1000`), head/last-row reads (`:1057-1109`), `bump_batch` (`:1111`),
   insert (`:1126-1168`), merge-head update (`:1172-1185`), session bump
   (`:1186-1194`), `box_slots` recompute (`:1195-1217`), `tx.commit()` (`:1218`).
c. `set_defaults` — `lock_batch`, normalize prev/next, `bump_batch` (seq
   discarded), fan-out `seq = seq + 1`, commit (`:1358-1430`).
d. `patch_item` — catalog await before the tx (`:1446`), `lock_item`, the dead
   price guard (`:1456`), card-change metadata (`:1459-1473`), `bump_batch`,
   update, commit (`:1433-1495`).
e. `set_status` / `duplicate_item` / `unmerge_item` / `add_manual` /
   `remove_manual` / `submit_batch` (`:1498-1726`), `submit_batch`'s ownership
   writes and the commit/recheck region (`:1727+`, part c's boundary).
f. `stream_inner` — ownership check, `hello` read, `items_after` 1 s poll with
   `*last > st.cursor`, per-connection `batch_sig`/`session_sig` gates, 55 s
   deadline, 15 s keep-alive (`routes/scan.rs:347-438`).
g. `heartbeat` / `leave` / `update_session` / `regenerate_pairing` — idle
   disconnect rules (`scan_store.rs:1743-2017`, `scan_connect.rs:11-12`).

---

## Undeterminable from inside this workspace

- **The phone page (`scan.pokoin.com/connect`).** It lives in
  `/home/nez/Projects/BattleScan`, outside the allowed root, so the client half
  of pairing/QR, the `capturedAt` clock, `clientSequence` numbering and the
  retry-on-500 behaviour of `action=scan` could not be read. Anything that
  depends on what the phone does with a rejected scan is therefore unverified.
- **The retired Node `_scan_store.js` / `_scan_connect.js`.** Several findings
  (the `onlyIfEmptyPrice` level, the fan-out `seq` regime, the
  `scan_event_id` lock) can only be *attributed* to a divergence between the JS
  client and the Rust port, not to a specific porting mistake, because the
  reference implementation is in `gvitolocs/cardvault`.
- **The production `scan_items` indexes.** Only
  `pokoin-rust/crates/external/tests/fixtures/scan_schema.sql` was readable; it
  has `UNIQUE (scan_event_id)` (`:96`) and **no unique index on `submit_key`**
  (`:13`, a plain `text` column), so `newSubmitKey` idempotency is client-side
  bookkeeping only. Whether production matches is not confirmable here — and the
  submit consequence is part c's area.
- **`applyPricing` post-submit bodies** (`pricing.js:143-189`) write
  `listingId`/`pricePkn` from the desk: whether a stale desk copy can overwrite
  a server-side price at that point belongs to part c.
- **Real user-visible timing.** No dev server or browser run was attempted (this
  is a read-only pass), so every "narrow window" claim is a statement about code
  order, not a measured frequency.

---

## Commit(s) blamed for the price box regression

Primary: **`4629f1bc`** (2026-11-13, "fix(scan-desk): a failed price lookup or
save is retried, not taken for 'no price'"). It removed the guaranteed last rung
(`.catch(() => [])` on the sold-comps read → cheapest listed → `scanFallbackPricePkn()`)
and replaced it with `failed` → `priceFailures` → `PRICE_RETRY_MAX = 4` → abandon,
leaving the abandoned row's `pricesAsked` claim in place (finding 6 step 6: the
early return at `ScanDesk.jsx:584` skips the release at `:585`). This is exactly
the owner's "the box no longer shows the suggested price … as it was some
commits ago", and it is what turns a transient failure into "2 need a price".

Contributing / adjacent:

- **`99ba5eaa`** (2026-11-01, "keep price suggestions alive when a run is
  cancelled") — introduced `claimRows`/`releaseUnsettled` keyed by the run's
  **row snapshot**, so `lastSuggested`, `pricesAsked` and `suggestedFor` can be
  recorded under a signature the live row no longer has (finding 8).
- **`ae992ec3`** (2026-11-05, batch pricing) — made `unpricedOnLoad()` take
  precedence in the placeholder ternary (`rows.jsx:451-453`), so a row under a
  pricing group/strategy shows "on load" instead of any number; with
  Pricing = "Suggested prices" the box falls through to the bare currency code.
- **`19fafa88`** (2026-11-13, "no comps and no listing default the row to
  10,000 EUR in PKN", merged as PR #564) — added the rung that `4629f1bc`, two
  commits later on the same day, made unreachable when the comps *read* fails.
  The two changes are adjacent in history, which is why the box went from "always
  gets a number" to "can stay empty" in one day.
- **`51bf1feb`** and **`1632d88e`** (2026-11-13, `markPick` / the manual-pick
  guard) — the printing path those two Vulpix/Ninjask rows took: an explicit
  search-add pre-marks `remapTried` (`ScanDesk.jsx:1015`), so no region remap
  runs, and a later remap attempt for the same triple is blacklisted even after a
  failed fetch (finding 9).
- **`9101a2d4`** (2026-10-11, the Solid port) — introduced `priceTouched`
  set-on-focus (`:1801`). It did **not** nest `onlyIfEmptyPrice`: the React desk
  already sent it inside `patch` (`9101a2d4^:market/src/scan-api.js:72`,
  `9101a2d4^:market/src/pages/ScanDesk.jsx:1225`). **`21ba8cef`** (2026-10-08, the
  Rust port) put the read at the payload root (`scan_store.rs:2217`), so within
  this repository the guard has never been honoured by any code path (finding 1).
