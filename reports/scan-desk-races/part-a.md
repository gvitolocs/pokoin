# Scan desk races — part A: suggested prices, row patches, Batch Defaults

Read-only analysis, branch `scan-races-a` at `origin/main` (`8e0e9a02`). No source file and no test was
changed; this file is the only output.

**Area.** `solid/src/pages/ScanDesk.jsx` (row store, `patchRows`, the prices effect, `restoreDefaultPrice`,
`retryPrices`, `setDefaults`), `solid/src/pages/scan-desk/price-requests.js`, `pricing.js`,
`rows.jsx` (price cell + version select), `bars.jsx` (`DefaultsBar`), `watch.js`, `scan-desk/version-sets.js`,
the client helpers in `market/src/` (`scan-pricing.js`, `scan-model.js`, `scan-api.js`, `api.js`,
`scan-stream.js`) and the server awaits they reach (`pokoin-rust/crates/external/src/scan_store.rs`,
`scan_connect.rs`) because the ordering depends on them.

**Owner-reported symptoms** (paraphrased from the brief):

- **S1** freshly added rows (Vulpix — Call of Legends 75/95; Ninjask — Dragons Exalted 11/124) with
  Pricing = "Suggested prices" keep an empty price box, state "Needs a price", chip "2 need a price".
- **S2** the price box no longer shows the suggested price, and clearing it no longer restores it —
  "as it was some commits ago".
- **S3** a Batch default cannot be switched off.

Every finding below is labelled **confirmed by reading** (the lines quoted are what the code does) or
**suspected, not confirmed** (the mechanism is real but a step depends on something I could not read here:
the Solid scheduler, the API's error behaviour under load, or a runtime value).

---

## A1. A cancelled price run still writes its suggestion — the previous printing's price lands on the newly picked printing

**Severity: wrong price shown → wrong listing uploaded.**

The prices effect checks its `cancelled` flag once per loop iteration, *before* the `await`. After the
`await` it computes and dispatches the patch without re-checking, and the patch body carries no identity
token — only the value-based `onlyIfEmptyPrice`.

### Interleaving

1. `ScanDesk.jsx:1265` — run **R** claims row `X` at signature `S1` (`cardId=P1, NM, EN, …`).
   `pricesAsked` gets `X:S1` (`price-requests.js:18`), `suggestedFor[X] = S1` (`:19`).
2. `ScanDesk.jsx:1300` — `slices = await slicesCache.get('P1')` suspends. The seller now has ~100 ms of
   sold-comps round trip to interact with the row.
3. `ScanDesk.jsx:1818` (`onPick`) → `markPick` (`:569-574`) → `patchRows([X], { cardId: 'P2' })` →
   `:655-659` adds the optimistic overlay → `displayRows` rebuilds `X` (`:344`) → `list()` changes
   (`:348`) → `watch` (`watch.js:19-24`) re-runs the prices effect → the previous run's cleanup
   `ScanDesk.jsx:1349-1352` sets `cancelled = true` and calls `release()`. Because `X` is in `settled`?
   No — `settled.add` happens at `:1314`, which has not run yet, so `releaseUnsettled`
   (`price-requests.js:25-35`) releases `X:S1`. A new run **R'** claims `X` at signature `S2`
   (`ScanDesk.jsx:1265`) and starts fetching P2's slices.
4. `ScanDesk.jsx:686-689` — R's pick patch is queued on `patchChain(X)`, so it is the first HTTP call.
   `scan_store.rs:1459-1473` rewrites the card columns and, because the patch has no `price_pkn` and the
   card id really changed, pushes `price_pkn = NULL`, `price_suggested = false` (`:1471-1472`). Row `X`
   on the server is now P2, unpriced.
5. The P1 slices promise resolves. R resumes **inside** its loop body, past the `cancelled` check of
   step 3 (`ScanDesk.jsx:1297` was before the `await`), and executes `:1308`
   (`suggestPriceFromSlices(P1 slices, scanFacets(P1 snapshot))`), `:1311`
   (`lastSuggested[X] = { signature: S1, pkn }`), `:1313` (`onlyIfEmptyPrice = true`, because R's snapshot
   `row.pricePkn == null`), `:1314`, `:1315` → a **second** patch is queued on `patchChain(X)` *after*
   the pick patch.
6. `scan_store.rs:1456-1458` — `only_if_empty_price` is evaluated against the **current** row. After
   step 4 the current price is `NULL`, so the guard passes and `price_pkn = <P1's suggestion>` is written
   onto the P2 printing, with `price_suggested = true`.
7. `ScanDesk.jsx:562` — the patch response dispatches `items`, so `X` renders P2 named with P1's price,
   greyed "suggested". `rowProblem` (`scan-model.js:279-281`) sees a price → no "Needs a price",
   `ScanDesk.jsx:1679` chip clears, submit is enabled.
8. R' (the correct run for `S2`) is still fetching. If it succeeds it overwrites with P2's price; if it
   fails (A2) `pricesAsked[X:S2]` stays claimed and **P1's price is the number the seller uploads**.

Also reachable without any interaction from the seller: `DefaultsBar` language change
(`bars.jsx:182`) → `setDefaults` (`ScanDesk.jsx:782`) → the server fans `language` onto every active row
(`scan_store.rs:1386-1416`) → the stream frame changes each row's signature → an in-flight run for the
*previous* language patches step 5's stale price onto the row, one row per row that was mid-`await`.
A batch language change over 30 rows is 30 independent windows.

### Why the code allows it

- The loop body between the last `await` (`:1300`) and the dispatch (`:1315`) has no `cancelled` re-check
  and no "is this row still the row I claimed?" comparison, although the run holds the claim-time row
  snapshot and the live store is one `untrack(displayRows)` call away (`:616`).
- `patchRows` sends the caller's `changes` verbatim (`:688`); there is no per-row version/sequence token in
  the patch body, so the server cannot tell "this price was computed for card P1".
- The server-side guard is a *value* guard on the target column (`scan_store.rs:1456`), not an identity
  guard on the row's `card_id`/`seq`. `patch_item` already holds the row lock and reads the current row
  (`:1451`) — it could compare, and does not.
- `onlyIfEmptyPrice` is chosen from the **claim-time** snapshot (`:1313`, `:1342`), so a row that was
  priced when claimed and emptied since is written unconditionally, and a row that was empty when claimed
  and manually priced since is correctly skipped — the flag answers the wrong question in the first case
  and only accidentally the right one in the second.

### Evidence

confirmed by reading — `ScanDesk.jsx:1296-1319` (the only `cancelled` test is at `:1297`, before the
`await` at `:1300`), `:1330-1344` (loop 2 *is* guarded, by `:1329`), `:1349-1352`, `:686-689`,
`scan_store.rs:1456-1458` and `:1469-1473`, `docs/SCAN_LISTING_WORKFLOW.md:151-153` ("Switching the
version … re-suggests for the new shape and clears the server-side price").
The comment at `ScanDesk.jsx:683-685` states the intended order explicitly ("the version-switch patch
(which clears the stale price) must land before the follow-up price suggestion") — the per-row
`patchChain` guarantees the *order*, which is exactly what makes step 6 win: the stale suggestion is
applied last, on top of the server's own clear.
suspected, not confirmed — whether Solid's `watch` cleanup (`watch.js:22-23`) always runs before the
fetch continuation in step 5. It does not matter for the outcome: whichever of the two runs first, R
still dispatches a price computed for `S1` onto a row whose signature is `S2`; the flag only decides
whether the *later* rows of the same run are also patched.

### Does it explain a symptom above?

Not S1/S2/S3 directly. It is the finding with money behind it: a price attached to a printing the seller
never priced, in the exact state (`price_suggested = true`) that suppresses the "Needs a price" blocker.

### Fix sketch

Re-check after the `await`, before computing: skip the row when
`untrack(displayRows)[row.id]` is missing, not `active`, or its `facetSignature` differs from the claimed
signature (`lastSuggested`'s `{ signature, pkn }` pair at `:1311` already models this comparison). Then
make the write self-describing: send `expectCardId` (or the claim-time `seq`) with the price patch and have
`patch_item` drop the price columns when the row's `card_id` no longer matches, alongside the existing
`only_if_empty_price` check.

### Regression test

- Tier: shared-module unit (`node --test market/src/*.test.js`, `docs/DEPLOY.md:80`, `paseo.json` `test`).
  File `market/src/scan-pricing.test.js`, test `facetSignature separates printings for the in-flight guard`
  — assert `facetSignature({ ...row, cardId: 'P2' }) !== facetSignature(row)` and expose the guard as a
  pure helper `staleSuggestion(claimed, live)` in `scan-pricing.js`; assert it returns `true` for
  `{ claimed: rowAt(P1), live: rowAt(P2) }` and `false` for a quantity-only change
  (`quantity` is not in the signature, `scan-pricing.js:37-45`).
- Tier: Rust flow (`cargo test -p pokoin-external`, `docs/CI.md:5-10`). File
  `pokoin-rust/crates/external/tests/scan_rows_flow.rs`, test
  `a_price_suggestion_for_a_printing_that_no_longer_matches_the_row_is_dropped` — patch `card_id`, then patch
  `pricePkn` with `onlyIfEmptyPrice: true` and an `expectCardId` of the old printing; assert the row keeps
  `pricePkn == null` and `priceSuggested == false`.
- Tier: desk source-shape (see A2 for why this tier exists). File
  `solid/src/pages/scan-desk/price-effect-source.test.js`, test `the prices effect re-checks its row after
  every await` — read `../ScanDesk.jsx`, take the body between `for (const row of want) {` and the loop's
  closing brace, and assert a `cancelled` or signature check appears **after**
  `await slicesCache.get(` and before `patchRows([row.id], patch`.

---

## A2. One failed cheapest-price read fails the whole run; after 4 tries the rows stay claimed and are never asked again — "Needs a price" until reload

**Severity: stuck row, blocks submit. This is the reported S1/S2.**

`docs/SCAN_LISTING_WORKFLOW.md:144-146` states the invariant: sold comps → cheapest listed → the €10,000
fallback, "so a row never needs a price before upload". Two `4629f1bc` changes made the last two rungs
skippable and made the give-up path silent.

### Interleaving (a two-row batch, the reported shape)

1. Two rows are scanned; neither printing has sold comps (old-set commons — Vulpix 75/95, Ninjask 11/124).
   `suggestPriceFromSlices` returns `null` (`scan-pricing.js:85` or `:105`) → both ids go to `cheapestIds`
   (`ScanDesk.jsx:1317`).
2. `ScanDesk.jsx:1324` — `await fetchCheapestPricePknMap([...], { strict: true })`. `api.js:729` rethrows
   on *any* error of that one batch call (timeout, 5xx, 429 — see A8 for why this endpoint is loaded).
3. `ScanDesk.jsx:1325-1327` — `byId = null`.
4. `ScanDesk.jsx:1332-1335` — loop 2: for **both** rows `!byId` → `failed.push(row)`; neither reaches the
   `scanFallbackPricePkn()` rung at `:1338`. One HTTP failure = 12 rows failed.
5. `ScanDesk.jsx:1345` → `retryPrices(failed)` → `nextPriceRetry` (`price-requests.js:46-58`) counts per
   `${rowId}:${signature}` and schedules one shared timer (`ScanDesk.jsx:587-590`).
6. `releaseUnsettled(retry, new Set(), books)` (`:585`) deletes the asked keys, so the next run re-claims
   them. The retry repeats steps 1-5 with delays 2 s, 4 s, 8 s, 16 s (`price-requests.js:55`).
7. On the 5th failure `price-requests.js:52` (`if (used >= PRICE_RETRY_MAX) continue;`) drops the rows
   from `retry` → `ScanDesk.jsx:584` returns before `releaseUnsettled` → **the `pricesAsked` keys are
   never deleted** and no timer is scheduled.
8. `ScanDesk.jsx:1258` — the filter for an unpriced row is `!pricesAsked.has(priceKey(row.id, signature))`;
   it is `has` → the row is excluded from every future run. The rows sit at `pricePkn = null`,
   `rowProblem` = `no_price` (`scan-model.js:279-281`, label `:290`), chip `2 need a price`
   (`ScanDesk.jsx:1679`), submit refused by the server (`:1469-1474`).
9. **S2's second half.** The seller clears the price box → `rows.jsx:468` (`commit.action === 'default'`)
   → `restoreDefaultPrice` (`:594-611`): `lastSuggested` has no entry for this signature (steps 1-7 never
   produced one) → `:604-605` delete the asked keys → but `priceFailures` is **not** touched, so the very
   next attempt hits step 7 immediately and the row is stuck again with an empty box. Before `4629f1bc`
   there was no failure map, no `strict`, and the fallback always priced the row.
10. Nothing else ever re-arms it: the effect's dependencies are `[list(), closed(), submitIntent(),
    priceRetry()]` (`:1251`); the 1 s clock (`:243`) is not a dependency, so an idle desk never retries.
    Only a reload or `newBatch` (`:1485-1489`) clears the books.

### Why the code allows it

- The retry budget is keyed by row+signature and is never reset when the row is re-armed from another path
  (`restoreDefaultPrice:604`, `retryPrices:585`), and the exhaustion branch releases nothing — so "gave up"
  and "already asked, nothing to do" are the same state in `pricesAsked`.
- The claim is the only dedupe token, so forgetting to release is indistinguishable from success.
- `failed` and "no data" are merged at the run level: `byId == null` (a transport failure for one batch
  request) condemns every unsettled row in that run rather than only the ids it covered.

### Evidence

confirmed by reading — `price-requests.js:38`, `:46-58` (`:52` is the give-up), `ScanDesk.jsx:581-591`
(`:584` early return before `:585`), `:1332-1335`, `:1345`, `:1258`, `api.js:711-732` (`:729` rethrow),
`ScanDesk.jsx:1324`. The pre-`4629f1bc` form is in the commit diff: `.catch(() => [])` on the slices read,
`await fetchCheapestPricePknMap([...cheapestIds])` without `strict`, and a bare
`patchRows(...)` with no `saved` wrapper — a failed read produced `byId = {}`, `listed = NaN`, and
`:1338` priced the row at the fallback.
suspected, not confirmed — that the *observed* failures were transport errors on
`/api/marketplace-card-cheapest-price` rather than the same endpoint answering 200 with no rows for those
card ids. Both end at step 4 only for the transport case; an empty 200 correctly reaches the fallback, so
if the seller saw this with the API healthy, look at A3 (silent patch drop) instead — it produces the same
screen.

### Does it explain a symptom above?

Yes, S1 and S2 exactly: empty price box, `Needs a price`, "2 need a price", clearing does not restore, and
"as it was some commits ago" (the behaviour changed on 2026-11-13).

### Fix sketch

Make give-up observable and reversible: in `nextPriceRetry`, release the asked keys when a row is dropped
at `price-requests.js:52` (or track give-up in its own set), and always schedule a run when
`releaseUnsettled` deleted anything (`ScanDesk.jsx:584-586` — today a released row without a timer waits
for an unrelated list change). Delete the `priceFailures` entry for the signature in
`restoreDefaultPrice` (`:604-605`). Fail one card id at a time: when the batch cheapest call throws, retry
the ids individually or price them with the fallback, so a single transport error does not strand 12 rows —
the documented chain (`docs/SCAN_LISTING_WORKFLOW.md:144-146`) ends at the fallback precisely so that no
row is left unpriced.

### Regression test

- Tier: shared unit (`cd solid && npm test`). File `solid/src/pages/scan-desk/price-requests.test.js`
  (it already imports `nextPriceRetry`, `PRICE_RETRY_MAX`, `releaseUnsettled`), test
  `a row that exhausts its retry budget stops being claimed` — claim a row, call `nextPriceRetry`
  `PRICE_RETRY_MAX + 1` times, assert `pricesAsked.has(priceKey(row, sig)) === false` after the exhausted
  call and that the returned `{ retry }` no longer contains the row.
- Tier: desk source-shape. New file `solid/src/pages/scan-desk/price-effect-source.test.js`, following the
  existing precedent `pick-remap-source.test.js:5-12` (`readFileSync` + `assert.match`; JSX cannot be
  imported by `node --test`), test `a failed cheapest-price read still reaches the fallback` — assert that
  between `if (!byId) {` and `continue;` the prices effect body contains `scanFallbackPricePkn(`, i.e. an
  unavailable cheapest read prices the row at the documented last rung instead of failing it.

---

## A3. `patchRows` returns `undefined` when the row is gone or not active, so the "save failed, ask again" path never fires

**Severity: stuck row; also the same screen as A2 from a different cause.**

### Interleaving

1. `ScanDesk.jsx:1314-1315` — row `X` is added to `settled` and its suggestion patch is dispatched
   (`saved(row, patchRows(...))`).
2. The seller removes (or pauses) the row: `rows.jsx:507` (`props.onRemove?.()`) → `removeRows`
   (`ScanDesk.jsx:889-908`) →
   `scanApi.remove` → the response's `items` are dispatched (`:562`) and the stream replays the row with
   `status: 'cancelled'`.
3. `ScanDesk.jsx:1315`'s patch now runs on `patchChain(X)` → `patchRows` re-reads the store
   (`:616-618`) → `row.status === 'active'` is false → `targets` is empty → `:619 return;` →
   **`undefined`**, not `false`.
4. `ScanDesk.jsx:1268-1270` — `saved` tests `ok === false`; `undefined !== false` → no `retryPrices`.
5. `X` is in `settled`, so `releaseUnsettled` (`:1276` → `price-requests.js:28`) skips it on cleanup. Its
   `pricesAsked` key and `suggestedFor[X]` stay, and `lastSuggested[X]` (`:1311`) claims a default that was
   never stored.
6. The seller hits Undo (`:900`/`:906` `scanApi.restore`). The row is `active` again with `pricePkn = null`,
   but `:1258` sees the surviving asked key and excludes it forever. `Needs a price` on a row the desk
   believes is priced.
7. Same shape for a batch switch: `newBatch` (`:1481-1493`) dispatches `reset` (`:1490`) so the old ids
   vanish from `rows()` → `:619` → `undefined` → no retry (harmless there, because `:1485-1489` resets the
   books — which is the only reason this path is not worse).

### Why the code allows it

`patchRows` has three outcomes (`undefined` = nothing to do / not sent, `true` = saved, `false` = rejected)
but its only caller that cares tests for one of them (`:1269`). `settled` is written before the save is
even dispatched (`:1314`), so "settled" means "computed", not "stored" — the one thing the retry protocol
needs to know.

### Evidence

confirmed by reading — `ScanDesk.jsx:618-619` (`if (!targets.length) return;`), `:690`
(`return true`), `:691-693` (`return false`), `:1268-1270`, `:1314`, `:1276`,
`price-requests.js:28`. Note the `preview` branch at `:681` also returns `undefined`; there the local
fixture is updated, so it is correct by accident.
suspected, not confirmed — whether the seller's two rows went through a remove/undo cycle; the mechanism
needs no server error, so it is reachable purely from desk interaction.

### Does it explain a symptom above?

Yes, S1/S2 for any row whose price patch raced a removal, a pause, or a `newBatch`.

### Fix sketch

Return an explicit result from `patchRows` — `{ ok: boolean, applied: boolean }` — or at minimum
`return false` at `:619` so the existing `ok === false` retry path fires; and move `settled.add(row.id)`
(`:1314`, `:1339`) to after the save resolves, releasing the claim when `applied` is false.

### Regression test

- Tier: shared unit (`cd solid && npm test`). File `solid/src/pages/scan-desk/price-requests.test.js`,
  test `a patch that found no live row releases its claim` — drive the intended helper
  (`markSettled(books, row, ok)` added next to `claimRows`) with `ok = undefined` and assert
  `pricesAsked` no longer holds the key.
- Tier: desk source-shape. File `solid/src/pages/scan-desk/price-effect-source.test.js`, test
  `patchRows never returns undefined on the not-sent path` — read `../ScanDesk.jsx`, take the
  `function patchRows(` body, assert `if (!targets.length)` is followed by `return false` and that
  `settled.add(` does not appear before `saved(row, patchRows(`.

---

## A4. Batch Defaults is last-response-wins: a just-chosen default reverts, and the revert re-fans onto the rows

**Severity: wrong listing metadata for every following scan. This is the reported S3.**

### Interleaving

1. The seller switches Pricing to a strategy (`bars.jsx:375-377` → `pricingChoicePatch`,
   `pricing.js:27-32`) → `setDefaults({ pricingGroupId: '', pricingStrategyId: 'S' })`
   (`ScanDesk.jsx:714`).
2. `:764` — optimistic `setBatch(prev => ({ ...prev, defaults: { ...prev.defaults, ...nextPatch } }))`.
   The select shows the strategy.
3. `:782` — request **B** is issued.
4. Meanwhile the stack-advance effect (`:421-447`), the box-stock effect (`:452-497`), the quantity reset
   (`:709-712`) or the 700 ms location debounce (`bars.jsx:105-108`) calls `setDefaults({ stack,
   startPosition })` — request **A** (`:446`/`:484`/`:711`). `untrack(batch)` is read at each call's own
   start (`:715`), so A's merge base may predate B's commit.
5. The server serializes both on the batch row (`scan_store.rs:1362`) and each response is a full
   `batch_view` (`:1425-1429`). Say A commits first, B second.
6. `ScanDesk.jsx:783` — responses can arrive out of order (two connections, no ordering guarantee):
   A's `data.batch` lands last → `setBatch(prev => ({ ...prev, ...data.batch }))` **replaces `defaults`
   wholesale with A's view**, which does not contain the strategy.
7. The select snaps back to "Suggested prices"; the seller switches it again and it snaps back again —
   "a Batch default cannot be switched off".
8. The screen is not merely stale: the server *has* the strategy (B committed) and a scan takes the
   defaults in force at its own capture time out of `defaults_history` (`scan_store.rs:1366-1372` append,
   `:1033-1034` → `scan_connect.rs:432` `pick_defaults`, `docs/SCAN_LISTING_WORKFLOW.md:56`), while the bar
   shows the reverted defaults. Two different truths in one session.
9. And if the stale response carries a changed fan-out field (`language`, `condition`, `foilState`,
   `firstEdition`, `signed`, `altered`, `location` — `scan_store.rs:1386-1394`), the server has *already*
   rewritten every active row (`:1408-1416`), so the rows keep the reverted value even after the desk
   repaints. A per-row edit made between the two requests is inside that bulk `UPDATE ... where
   batch_id = $ and status = 'active'` and is lost.
10. `setBatch` merges `data.batch` from four unguarded writers — `startSession` `:197`, stream `hello`
    `:263`, stream `batch` `:331`, `setDefaults` `:783`, plus `submit` `:1438` — with no `defaults_version`
    (`scan_store.rs:1365`) or `updated_at` comparison on the client. A delayed `setDefaults` response
    landing after `submit` re-applies `status: 'open'` on a batch the submit just closed: the queue becomes
    editable again, `closed()` (`:356`) flips false, the prices effect re-enters (`:1253`) and its patches
    then fail `require_open_batch` (`scan_store.rs:1452`).

### Why the code allows it

There is no request token on `setDefaults`: nothing compares the response to the state it was generated
from, and `setBatch(prev => ({ ...prev, ...data.batch }))` is a full-object merge for a value the server
owns and the client also writes optimistically. The optimistic write at `:764` is not rolled back either,
so a rejected request leaves the wrong default on screen until the next response (`:786` only sets an
error string).

### Evidence

confirmed by reading — `ScanDesk.jsx:714-799` (`:715`, `:764`, `:782`, `:783`), the four other `setBatch`
merge sites (`:197`, `:263`, `:331`, `:1438`), `scan_store.rs:1362-1372`, `:1386-1416`, `:1425-1429`,
`bars.jsx:105-108`, `:375-377`, `pricing.js:27-32`.
suspected, not confirmed — out-of-order arrival of two `POST /api/scan-batch?action=defaults` responses is
normal HTTP behaviour but was not reproduced here; the same loss also occurs strictly in-order when a
`scanApi.defaults` response is applied after a *later* stream `batch` frame, which needs no reordering
assumption. `normalize_defaults` (`scan_connect.rs:221`) was verified to clear booleans, and
`clean_pricing_id` (`:69`) maps a blank pricing choice to `""`, so S3 is not a server-side "false is
ignored" bug.

### Does it explain a symptom above?

Yes, S3, and it is the only mechanism found that matches "cannot be switched off".

### Fix sketch

Serialize defaults through the same per-key chain the row patches use (`scan-model.js:478-489`), or send a
monotonic client `defaultsVersion` and apply `data.batch` only when it is not older than
`batch().defaultsVersion`; alternatively merge only the keys the request actually touched
(`Object.fromEntries` of `nextPatch`) instead of the whole server defaults object.

### Regression test

- Tier: desk source-shape (`cd solid && npm test`). New file
  `solid/src/pages/scan-desk/defaults-write-source.test.js`, test `a defaults response only overwrites the
  keys it set` — read `../ScanDesk.jsx`, take the `function setDefaults(` body, assert `setBatch(` after
  `scanApi.defaults(` does not spread `data.batch` whole (i.e. the line matches a keys-limited merge) and
  that a version/`defaultsVersion` comparison guards it.
- Tier: Rust flow (`cargo test -p pokoin-external`, `--db` for `POKOIN_TEST_DATABASE_URL`,
  `docs/CI.md:17-27`). File `pokoin-rust/crates/external/tests/scan_batch_pricing_flow.rs`, test
  `two concurrent defaults writes both survive and the fan-out skips the untouched field` — issue
  `action=defaults` with `{ pricingStrategyId }` and `{ location }` back-to-back, assert the final
  `defaults` has both and that `items` from the second response carries no `language` change.

---

## A5. Location default: an unguarded box-stock write inside `setDefaults` prices/positions the next scans against the wrong box

**Severity: wrong inventory position.**

### Interleaving

1. The seller types `A1` in the Location field (`bars.jsx:228` → `locationDraft`, then the 700 ms debounce
   at `bars.jsx:105-108`) → `props.onChange({ location: 'A1' })` → `setDefaults` (`ScanDesk.jsx:714`).
2. `:724-730` — the location branch `await fetchSellerBoxSlots(...)` **before** any optimistic write; the
   seller keeps typing and the debounce fires again with `B2` (`bars.jsx:105-109` clears only its own
   timer, so the two calls now overlap) → a second `setDefaults` with its own stock request.
3. Responses land in the order `B2`, `A1`. `ScanDesk.jsx:732-734` has **no** `cancelled` flag, no key check
   and no "is this still the location I asked for" comparison: the stale `A1` handler overwrites the module
   `let boxStock` (`:451`) and `setBoxStockRows(A1 rows)` (`:733`).
4. The slot math the whole desk reads — `occupiedAbs` (`:349`) → `slots` (`:350`) → the Loc column
   (`rows.jsx`, `props.slot`) and `nextBoxPositions` (`:441`) — now mixes the current box `B2` with `A1`'s
   stock, so the next scan is anchored to a slot that is free in `A1` and taken in `B2`.
5. The dedicated box-stock effect *does* guard: `:459` (key), `:467` (`cancelled`), `:472`
   (`listingBox(d.location) !== box → return`), `:474` (`size !== askedSize → return`). Its guard covers
   only its own writes, and `:469-470` still write `boxStock`/`setBoxStockRows` before the location check.
6. `boxStock` is a plain `let` (`:451`), so a stale assignment is invisible to every dependency list and
   cannot be re-derived until the location changes again.

### Why the code allows it

`setDefaults` performs a read-modify-write of shared state (`boxStock`, `recentBoxNames`, the batch
defaults, the row overlay) across an `await` with no token, and `boxStock` is not part of the reactive
graph, so nothing re-validates it after the fact.

### Evidence

confirmed by reading — `ScanDesk.jsx:720-751` (`:730` await, `:732-734` unguarded writes, `:744-746` catch
swallows), `:451-497` (the guarded sibling), `bars.jsx:84`, `:90`, `:105-109`.
suspected, not confirmed — the exact timing of two `fetchSellerBoxSlots` responses. The window is the whole
round trip, and the two callers in step 2 are 700 ms apart by construction.

### Does it explain a symptom above?

No, not one of the reported three. It is adjacent (same `setDefaults`, same await) and it is what the
700 ms debounce in the brief asked about.

### Fix sketch

Give the branch the sibling's discipline: capture `const key = `${current.id}|${box}`` before the `await`
and bail out (`if (boxStock.key !== key || untrack(defaults).location !== loc) return;`) before writing
`boxStock`/`setBoxStockRows`, or move the whole stock hint into the existing guarded effect at `:452-497`
and let `setDefaults` only merge the returned `next` cursor.

### Regression test

- Tier: desk source-shape (`cd solid && npm test`). File
  `solid/src/pages/scan-desk/defaults-write-source.test.js`, test `the location stock hint cannot be
  written out of order` — assert the `function setDefaults(` body checks
  `boxStock.key` (or the current location) between `await fetchSellerBoxSlots(` and
  `boxStock = {`.
- Tier: e2e (`node scripts/scan-connect-e2e.mjs`, real SPA + Postgres; it already drives the Location field
  in the `Shift+G`/`Shift+A` steps). New step `retyping the box twice keeps one stock hint` — type two box
  names inside the debounce window with the second response forced to arrive first
  (`page.route` delay), then assert the Loc column of the next scan is the position of the second box.

---

## A6. Focusing the price box opts the row out of pricing permanently

**Severity: wrong price uploaded after a facet change.**

### Interleaving

1. The seller clicks into row `X`'s price box (`rows.jsx:454-459`) → `props.onPriceFocus` →
   `ScanDesk.jsx:1801` → `priceTouched.add(X)`.
2. The filter at `:1256` (`if (!row.cardId || priceTouched.has(row.id)) return false;`) now excludes `X`
   from every future run, for both branches (unpriced `:1258` and re-suggest `:1259`).
3. The only place that removes the mark is `restoreDefaultPrice` (`:595`), reached only from the blur path
   that ends in `onPriceEmptied` (`rows.jsx:468`). A blur with text in the field
   (`rows.jsx:463-465`), or a blur whose text equals the stored price, never clears it.
4. The seller then changes the row's facets with the keyboard (`condition`/`language`/finish/1st,
   `docs/SCAN_LISTING_WORKFLOW.md:128-131`) → a new signature, a new `pricesAsked` key would be needed, but
   the row is filtered at `:1256` before the signature is even computed → the price from the old facet
   combination stays on the row.
5. `spec`: `docs/SCAN_LISTING_WORKFLOW.md:151-153` says switching version or facets "re-suggests for the
   new shape"; for a once-focused row it does not.

### Why the code allows it

`priceTouched` is a per-row *sticky intent* flag with no expiry: it is not scoped to the signature it was
set for, is not cleared by `patchRows` when a facet changes, and is not part of the row or the claim books
that already track signatures (`suggestedFor`).

### Evidence

confirmed by reading — `ScanDesk.jsx:156`, `:1256`, `:1801`, `:595`; `rows.jsx:454-459`, `:460-470`;
`facetSignature` `scan-pricing.js:37-45`. The set is reset only in `newBatch` (`:1486`).
suspected, not confirmed — that a real seller hit this exact order; it needs only "click the price box,
then change the condition".

### Does it explain a symptom above?

Not S1-S3. It explains "the price box stopped tracking the row" in the opposite direction (a price that
will not move).

### Fix sketch

Key the mark by signature (`priceTouched: Map<rowId, signature>`) and treat a signature change as new
intent in the filter (`:1256`), or clear `priceTouched.delete(row.id)` inside `patchRows` when
`changes` touches a `facetSignature` field.

### Regression test

- Tier: shared unit (`node --test market/src/*.test.js`). File `market/src/scan-pricing.test.js`, test
  `a facet change invalidates the manual-price intent mark` — once the predicate is extracted as
  `rowNeedsPrice(row, { touched, asked, suggestedFor, signatureOf })`, assert it returns `true` for a row
  whose `condition` moved after it was touched and `false` for the same row at the untouched signature.
- Tier: desk source-shape. File `solid/src/pages/scan-desk/price-effect-source.test.js`, test
  `priceTouched is cleared when a facet changes` — assert `patchRows(` body contains a
  `priceTouched.delete(` inside the `if (changes.` facet branch, and that the filter at `:1256` is not a
  bare `priceTouched.has(`.

---

## A7. Leaving a suggested price box blurred flips it to a manual price, because both `keep` shortcuts require `!priceSuggested`

**Severity: wrong price semantics; the row stops being re-suggested.**

### Interleaving

1. Row `X` has a suggestion: `pricePkn = 320`, `priceSuggested = true`; the box shows `320`
   (`rows.jsx:445`, class `suggested` `:440`).
2. `rows.jsx:458` — focus empties the field (`if (row().priceSuggested) e.currentTarget.value = ''`); the
   number stays only as the placeholder (`:451-453`) and in `lastSuggested` (`ScanDesk.jsx:1311`).
3. While the field has focus, anything that rebuilds `X`'s object re-applies the `value` binding
   (`rows.jsx:445`): the pending overlay add (`ScanDesk.jsx:655-659`) and its removal in `finally`
   (`:694-702`), the response dispatch (`:562`), or a stream frame (`:269`). `displayRows` creates a new
   object for `X` (`:344`) → the input's value is written back to `320` — the seller's field refills itself
   without them typing.
4. The seller tabs away → `rows.jsx:462` `priceFieldCommit(X, '320', currency)`.
5. `scan-pricing.js:120` skips `keep` because `row.priceSuggested` is true; `:124` skips `keep` for the same
   reason → `:125` returns `{ action: 'set', pricePkn: 320 }`.
6. `rows.jsx:464` patches `{ pricePkn: 320, priceSuggested: false }` → `scan_connect.rs:1005` writes
   `price_suggested = false` (any patch containing `pricePkn` writes the flag from `priceSuggested`, which
   is now explicitly false) → the suggestion became a manual price without an edit.
7. `ScanDesk.jsx:1259` re-suggests only rows with `priceSuggested === true`; combined with A6
   (`priceTouched`) the row is now invisible to the price pipeline, and `rows.jsx:451-453`'s placeholder —
   the "suggestion stays visible while you type" affordance of `docs/SCAN_LISTING_WORKFLOW.md:154-155` — is
   gone (`priceSuggested` false → placeholder is just the currency).

### Why the code allows it

`priceFieldCommit` cannot distinguish "the DOM text is what we put there" from "the seller typed this",
because the input is written by the reactive `value` binding and the commit reads `e.currentTarget.value`
(`rows.jsx:462`) instead of a tracked edit flag. The `!row.priceSuggested` condition on both `keep`
shortcuts was the stand-in for "edited", and it is wrong for exactly the case the placeholder exists for.

### Evidence

confirmed by reading — `scan-pricing.js:116-126` (`:120`, `:124`), `rows.jsx:445`, `:451-459`, `:460-470`,
`ScanDesk.jsx:1259`, `:1311`, `scan_connect.rs:1005` (`parse_item_patch`, read in full at
`scan_connect.rs:928-1026`: a patch containing `pricePkn` always writes `price_suggested` from
`priceSuggested`).
suspected, not confirmed — step 3 requires the `value` binding to be re-applied on row-identity change;
that is how Solid compiles a `value` prop, but I did not execute the SPA to watch the refetch. The finding
stands without it: focus, retype the *same* number, blur → `action: 'set'`.

### Does it explain a symptom above?

Partly S2 — "the price box no longer shows the suggested price": after such a blur the row is no longer a
suggestion, so the greyed style, the placeholder and the re-suggestion path all stop.

### Fix sketch

Track the edit on the element (`onInput` sets `dirty = true`, cleared on focus-commit) and only return
`{ action: 'set' }` for a dirty field; keep the value-equality shortcut unconditional, i.e. drop
`!row.priceSuggested` from `scan-pricing.js:120` and `:124` and compare against the *displayed* value
captured at focus time.

### Regression test

- Tier: shared unit (`node --test market/src/*.test.js`). File `market/src/scan-pricing.test.js`, test
  `re-typing a suggested price unchanged is not a manual price` — assert
  `priceFieldCommit({ pricePkn: 320, priceSuggested: true }, '320', 'PKN').action === 'keep'`, and that
  `priceFieldCommit({ pricePkn: 320, priceSuggested: true }, '321', 'PKN').action === 'set'`.
- Tier: e2e. File `scripts/scan-connect-e2e.mjs`, new step after the existing `prices filled; submit with
  Ctrl+Enter then Enter` (`:353`) — focus a suggested price, blur without typing, assert the row keeps the
  `.suggested` class and `priceSuggested: true` in the submit payload.

---

## A8. Every price save re-runs the prices effect, and the cheapest-price read has no cache: 12 rows produce a wave of duplicate batch calls

**Severity: stuck-row amplifier (the failure source for A2) and wasted traffic.**

### Interleaving

1. `ScanDesk.jsx:1315` — run R dispatches the suggestion for row 1 (fire-and-forget).
2. `ScanDesk.jsx:686-689` → `runApi` → `:562` `if (data?.items) dispatch(...)` → `rows()` changes →
   `list()` (`:348`) → `watch` (`watch.js:19`, deps `ScanDesk.jsx:1251`) re-runs the prices effect.
3. `:1349-1352` — R is cancelled; every row R had not settled is released (`price-requests.js:25-35`) and
   immediately re-claimed by R' (`:1265`).
4. R' re-reads the sold-comps promises from `slicesCache` (`:1281`, cheap) but recomputes
   `cheapestIds` (`:1317`) from the rows still unresolved and calls
   `fetchCheapestPricePknMap` again (`:1324`) — `api.js:711-732` has **no** cache (unlike the slices cache at
   `ScanDesk.jsx:1280-1290`), so the same card ids are re-queried per wave, with the €10,000-fallback rows
   included every time.
5. With N unpriced rows, the queue churns up to N waves, each one `POST`-ing a new cheapest query while
   the previous wave's patches are still in flight. Each wave's own save (`:1315`) is what triggers the
   next wave (`:562`).
6. The load lands on a public API endpoint; more requests → more 429/timeouts → `strict` rethrow
   (`api.js:729`) → A2's give-up → rows stuck at `Needs a price`.

Related churn on the same path: `patchRows` adds an overlay (`:655-659`) and removes it (`:694-702`) for
the *same* patch — two `list()` changes per save, so step 2 happens twice per row.

### Why the code allows it

The effect's dependency is the entire derived list (`:1251`), not "the set of rows needing a price plus the
retry tick", and the response-dispatch at `:562` is indistinguishable from a phone-side change. There is no
in-flight marker per `(cardId)` for the cheapest read, unlike `slicesCache`.

### Evidence

confirmed by reading — `:562`, `:655-659`, `:694-702`, `:1251`, `:1280-1290` vs `:1320-1328`,
`api.js:711-732`, `watch.js:18-25`.
suspected, not confirmed — that this wave pattern is what actually errored the cheapest call in the owner's
session (no server logs read here).

### Does it explain a symptom above?

Indirectly, S1/S2 — it is the most likely source of the transient failure A2 refuses to recover from.

### Fix sketch

Cache the cheapest map per card id with the same shape as `slicesCache` (`:1280-1290`, delete on rejection),
and make the effect's dependency the price-relevant projection of the list (ids + signatures + price
state), so a save that only changes `pricePkn` does not cancel and restart the pipeline.

### Regression test

- Tier: desk source-shape (`cd solid && npm test`). File
  `solid/src/pages/scan-desk/price-effect-source.test.js`, test `cheapest prices are asked once per printing
  like sold comps` — assert that the call site of `fetchCheapestPricePknMap(` in the `function ScanDeskDesk`
  body is wrapped by a `Map`-backed guard named like `cheapestCache`, mirroring the
  `slicesCache.has(` filter at `:1281`.
- Tier: shared unit. File `market/src/scan-model.test.js`, test `rowsAffectingPrices ignores unrelated row
  churn` — once the projection helper exists, assert it is equal for two lists that differ only in
  `pricePkn`/`priceSuggested`, and different when a `facetSignature` field changes.

---

## A9. The prices effect does not depend on the batch defaults, so the Pricing select and batch facet changes never re-arm it

**Severity: stuck row / misleading "on load" label.**

### Interleaving

1. The Pricing select changes to a group (`bars.jsx:375-377`) → `setDefaults` → `batch()` updates
   (`:783`). The effect's dependencies are `[list(), closed(), submitIntent(), priceRetry()]` (`:1251`) —
   `defaults()` (`:351`) is read *inside* the untracked body (`watch.js:21-23`), so the select alone does
   not re-run it.
2. Nothing re-evaluates `want` (`:1254-1261`) and nothing clears `pricesAsked`/`suggestedFor`/`lastSuggested`
   (`:154-163`) — only `newBatch` does (`:1485-1489`).
3. `rows.jsx:223` (`unpricedOnLoad`) and `:451-453` repaint the box as `on load` because the batch now has
   pricing, but no lookup was started or stopped: a run still in flight keeps pricing rows the UI says will
   be priced on load, and its `saved` patch (`:1315`) gives them a price before the batch loads. At submit
   that only matters for a **strategy** choice: `pricingApplyBodies` queues a strategy row only when
   `entry.priced === false` (`pricing.js:150-151`), so the desk suggestion wins and the strategy rule is
   never applied to that listing; a **group** row is queued unconditionally (`:148-149`) and the group
   overwrites the desk price instead. Either way the row's price is decided by which of the two raced, not
   by what the bar shows.
4. Symmetrically, switching the batch **language/condition** does re-run the effect — but only because the
   server fan-out (`scan_store.rs:1408-1416`) or the client overlay (`ScanDesk.jsx:765-777`) changes
   `list()`. A row created *during* the `await` at `:730` is not in `rowIds` (`:718`, `:767`: rows captured
   at call time), so it paints the old language until its frame arrives, and its in-flight suggestion was
   computed for the old facets (A1).

### Why the code allows it

The effect's dependency list encodes "when does the price need recomputing" as "when does the list change",
and the batch-level pricing intent is deliberately non-reactive (`watch.js` untracks the body). There is no
invalidation on the pricing intent at all, and no pricing-mode gate inside `saved`/`patchRows`.

### Evidence

confirmed by reading — `:1251`, `:351`, `:353`, `watch.js:18-25`, `:1485-1489`, `:718`/`:767`,
`pricing.js:99-101`, `:140-166`, `rows.jsx:223`, `:449-453`, `scan_store.rs:1408-1416`.
suspected, not confirmed — that a seller switched Pricing mid-session with rows in flight and then
submitted; the payload difference needs a real pricing group to observe.

### Does it explain a symptom above?

No. It is the closest thing found to a "Pricing select does nothing" bug and it is in the same effect.

### Fix sketch

Add `defaults()`'s pricing intent (or a `pricingChoiceValue(d())`-style projection, `pricing.js:19-24`) to
the effect's dependencies at `:1251`, and when the batch has pricing, stop claiming rows at all
(`:1265`) instead of only relabelling them.

### Regression test

- Tier: shared unit (`cd solid && npm test`). File `solid/src/pages/scan-desk/pricing.test.js`, test
  `batch pricing suppresses desk suggestions for unpriced rows` — assert a new exported predicate
  `deskSuggestionsActive(defaults)` is false when `pricingGroupId` or `pricingStrategyId` is set, true for
  the "Suggested prices" choice (`pricing.js:19-32`).
- Tier: desk source-shape. File `solid/src/pages/scan-desk/price-effect-source.test.js`, test
  `the prices effect depends on the pricing intent` — assert the `watch(` dependency array at the
  `// ---- prices + images` marker contains a `defaults`/pricing projection, not only
  `[list(), closed(), submitIntent(), priceRetry()]`.

---

## A10. `submit`, `newBatch` and the account switch have no token against in-flight row patches

**Severity: cosmetic → wrong batch, depending on the API.**

### Interleaving

1. A price wave is in flight (`:1315`), each patch inside `patchChain(X)` (`:686-689`).
2. The seller submits (`:1416-1479`): `:1437` `scanApi.submit` closes the batch; `:1438` merges the closed
   `data.batch`; `:1464-1465` re-reads the snapshot.
3. A queued patch from step 1 fires after the close → `scan_store.rs:1452` `require_open_batch` → 409 →
   `patchRows:691-693` `setError('…')` **after submit**, so the success screen also shows a red error, and
   `saved` (`:1268-1270`) schedules retries for a batch that can never accept them.
4. `newBatch` (`:1481-1493`) does not stop the chain and does not reset `patchChain`'s queue or
   `slicesCache` (`:155`): the new batch's suggestions are computed from the previous batch's cached
   sold-comps promises (`:1281`), i.e. up to one session stale, and a queued patch for an *old* row id is
   sent with `batch()?.id` of the *new* batch (`:688`).
5. `scan-api.js:63-65` documents that the `batchId` is decorative ("Row actions resolve the batch from the
   seller-owned row") and `scan_store.rs:1451` looks the row up by `seller_uid` + `item_id`, so a late price
   patch really writes into the abandoned previous batch if that batch is still `open` (`newBatch` never
   closes or discards it).
6. The account switch path (`:218-227`) resets rows and starts a new session but leaves
   `pricesAsked`/`suggestedFor`/`priceTouched`/`priceFailures`/`lastSuggested`/`slicesCache` and
   `submitKey` (`:171`) in place, and `loadPricing` (`:229-240`) has no token: `fetchPricingStrategies` for
   seller A (`:235`) can resolve after seller B's and repaint B's Pricing select with A's strategy names.

### Why the code allows it

Nothing ties an in-flight patch to the batch generation that produced it; `patchChain`
(`scan-model.js:478-489`) serializes per row id with no way to drain or invalidate on batch change, and the
price books are component-scoped mutable state (`:154-165`) that only `newBatch` resets, partially.

### Evidence

confirmed by reading — `:686-689`, `:691-693`, `:1438`, `:1481-1493` (no `slicesCache`/`patchChain` reset),
`:218-227`, `:229-240`, `scan-api.js:63-65`, `scan_store.rs:1451-1455`, `docs/CI.md`-adjacent server test
`scan_rows_flow.rs:22` (`a_removed_row_comes_back_newer_than_the_one_on_screen`) shows the seq protocol the
client is expected to be able to violate.
suspected, not confirmed — that the abandoned batch stays `open` long enough to be written into (no
expiry/TTL read here); the "stale pricing select for account B" ordering is standard `fetch` behaviour but
was not reproduced.

### Does it explain a symptom above?

No.

### Fix sketch

Add a generation counter: bump it in `newBatch`/the account-switch watch and in `submit`, capture it at
claim (`:1265`) and drop `saved`/`retryPrices`/`patchRows` writes whose generation is stale; clear
`slicesCache` alongside the other books at `:1485-1489`; give `loadPricing` the same
`cancelled`-flag shape the other async effects use (`:461-495`, `:511-524`).

### Regression test

- Tier: desk source-shape (`cd solid && npm test`). File
  `solid/src/pages/scan-desk/price-effect-source.test.js`, test `newBatch resets every price book` —
  assert the `function newBatch(` body assigns all of `pricesAsked`, `priceTouched`, `suggestedFor`,
  `priceFailures`, `lastSuggested` **and** `slicesCache`.
- Tier: Rust flow (`cargo test -p pokoin-external`). File
  `pokoin-rust/crates/external/tests/scan_rows_flow.rs`, test
  `a row patch for a closed batch names the batch it belongs to` — patch an item of a submitted batch and
  assert the 409 code is `batch_closed`, not `not_active`, so the client can distinguish a retryable
  conflict from a terminal one.

---

## A11. A 409 from a non-active row is retried four times and shown as an error banner

**Severity: cosmetic / false error.**

1. `ScanDesk.jsx:1315` dispatches a suggestion for `X`; the seller pauses or removes `X` (`:889-908`).
2. `scan_store.rs:1453-1455` returns `409 { code: 'not_active', error: 'Only active rows can be edited.' }`;
   `scan-api.js:50-55` turns it into a thrown error.
3. `ScanDesk.jsx:691-693` → `setError(err.message)` → a red banner for an action the seller just took, then
   `return false` → `saved` (`:1269`) → `retryPrices` → four more identical 409s over 30 s
   (`price-requests.js:55`), each with its own banner.
4. After the budget the row is stuck claimed (A2's step 7-8), so this is also the least recoverable entry
   into the stuck state.

**Why the code allows it:** the price-save path treats every failure as transient; there is no terminal
error class (`code === 'not_active'`, `batch_closed`) and no silent-drop branch for a row the desk itself
deactivated. **Evidence:** confirmed by reading `scan_store.rs:1453-1455`, `ScanDesk.jsx:691-693`,
`:1268-1270`, `:581-591`. **Symptom:** contributes to S1's screen (banner + stuck rows after a remove).

**Fix sketch:** in `patchRows`, return a distinct value (or rethrow tagged) for
`err.code === 'not_active' | 'batch_closed' | 'not_found'`, and in `retryPrices` treat those as
"drop the claim, do not schedule" instead of counting them.
**Regression test:** tier shared unit, `solid/src/pages/scan-desk/price-requests.test.js`, test
`a terminal save error is not retried` — `nextPriceRetry(failures, [row], sig, { terminal: true })`
returns `{ retry: [], delay: 0 }` and releases the claim.

---

## A12. The input bindings are re-applied whenever the row object is rebuilt, so in-progress edits can be lost

**Severity: cosmetic, but it is how a typed price silently disappears.**

`displayRows` (`:340-347`) rebuilds an object only for rows with an overlay (`:344`), but `patchRows`
creates and removes an overlay for **every** patch of that row (`:655-659`, `:694-702`) and `runApi`
dispatches the response items (`:562`), so a row that is being priced, moved, merged or re-printed changes
identity three times per save. `rows.jsx` writes `value={priceInputFromPkn(row().pricePkn, currency())}`
(`:445`) and `value={String(row().quantity ?? '')}` (Qty, `:426`, `onFocus` selects at `:427`), and
re-assigns on blur (`:431`, `:469`). `bars.jsx:84-87` re-seeds `locationDraft`/`stackDraft`/`posDraft` from
`d().location`
whenever the defaults object changes. Interleaving: focus the price box (`:458` empties it), start typing,
and any patch of that row — including the suggestion the desk just fetched (A7 step 3) — replaces the text
with the stored value; the same shape applies to the Location field, whose 700 ms debounce
(`bars.jsx:105-109`) can then re-send the value `:84` just restored.

**Why:** the fields are uncontrolled DOM values mirrored by a reactive `value` binding with no
"this element is being edited" guard (no `document.activeElement` check, no dirty flag).
**Evidence:** confirmed by reading `:344`, `:655-659`, `:694-702`, `:562`; `rows.jsx:445`, `:451-470`,
`:420-436`; `bars.jsx:84-87`, `:105-109`. suspected, not confirmed — the exact repaint frequency during a
scan burst (needs a running desk).
**Fix sketch:** skip the write while the element has focus and holds a dirty value (or drive the field with
`onInput` state and only sync from the row when the field is clean).
**Regression test:** tier desk source-shape, `solid/src/pages/scan-desk/price-effect-source.test.js`, test
`row inputs never overwrite a focused dirty field` — assert `rows.jsx` carries a dirty/focus guard around
the price and qty `value=` bindings (the test already reads sibling `.jsx` sources, precedent
`pick-remap-source.test.js:22`).

---

## Async sources found in this area

Reads/writes that can land out of order relative to the row store, the price books or the batch object.

**Network — rows and batch**
1. `startSession` → `scanApi.start` (`ScanDesk.jsx:185-199`, `:193`) and the items snapshot inside it; its
   `setBatch` at `:197`.
2. SSE-over-fetch change stream: `connectScanStream` (`:252-336`; `market/src/scan-stream.js:41-117`) with
   cursor (`:51`), `hello`/`items`/`session`/`batch` handlers (`:261`, `:265`, `:312`, `:330`), a server-side
   close every ~55 s and an immediate reconnect (`scan-stream.js:98`), 401 token refresh (`:82-85`),
   404 → `gone` (`:78-81`), backoff `400·2^n` jittered (`:32-35`). `handle.stop()` only aborts the reader
   (`:109-112`); in-flight `patchRows` chains are untouched (A10).
3. `runApi` (`:559-564`) — every mutation's response dispatches `items` (`:562`), so every save is also an
   async row-store write.
4. `scanApi.patch` per row inside `patchChain(row.id)` (`:686-689`, `scan-model.js:478-489`) — serialized per
   row id, **not** across rows, and not across `defaults`.
5. `removeRows` / restore / duplicate / unmerge (`:889-908`) — sequential `await` per id, so a multi-select
   remove is a chain of partial states.
6. `submit` (`:1416-1479`) — `scanApi.submit` → `setBatch` → up to N sequential `applyPricing` calls
   (`:1451-1457`) → `scanApi.batch` snapshot → `dispatch` (`:1464-1465`); idempotent only by `submitKey`
   (`:171`, `:1482`).

**Network — prices (all in `market/src/api.js`). The two reads the prices effect depends on cannot be
cancelled at all — `fetchCardSales` (`:624-631`) and `fetchCheapestPricePknMap` (`:711`) take no `signal`;
`fetchVersionSet` (`:909`) and `fetchExactNameCards` (`:410`, `:412`) do accept one and the desk never
passes it.**
7. `fetchCardSales(cardId, { slices: true })` (`:624`) — 4 at a time (`ScanDesk.jsx:1291-1293`), memoized in
   `slicesCache` (`:155`, `:1280-1290`) which is **never** cleared except on rejection (`:1288`) and not by
   `newBatch`.
8. `fetchCheapestPricePknMap(ids, { strict: true })` (`:711-732`, called at `:1324`) — uncached, one call per
   run, and its rejection condemns the whole run (A2, A8).
9. `fetchVersionSet(cardId)` via `loadVersionSet` (`scan-desk/version-sets.js:7-28`, `versionSetCache:5`) —
   the cache stores the **pending Promise** at `:26`, so `patchRows`' `cached?.printings` read
   (`:627-630`) silently misses while in flight.
10. `fetchExactNameCards(name)` (`rows.jsx:92`).
11. `fetchSellerBoxSlots` from three places: `setDefaults`' location branch (`:730`), the box-stock effect
    (`:466`) and the location seed (`:514`).
12. `fetchPricingStrategies` in `loadPricing` (`:235`) — unguarded (A10 step 6); `savePricingGroup` /
    `applyPricing` from the "Price selected" pop-up path (`pricing.js:140-166`).
13. `fetchScanImage` / `token()` in the images effect (`:1355-1374`) — writes `images()` which every
    `QueueRow` reads (`:1793`).

**Timers and debounces**
14. `priceRetryTimer` — one shared `setTimeout` for all rows (`:587-590`), cleared only on unmount (`:246`).
15. `stackFullTimer` (`:436`).
16. The `DefaultsBar` location debounce, 700 ms (`bars.jsx:105-109`), plus `commitLocation` (`:89-91`) which
    can fire the same change twice.
17. The 1 s clock `setInterval` (`:243`) — drives `phaseInfo`/`expiresIn` only; deliberately not a
    dependency of the prices effect (A2 step 10).

**Reactive writes that behave like async sources**
18. The prices effect (`:1251-1353`) — claims, awaits, patches, releases; its cleanup is the only
    cancellation mechanism (`:1349-1352`).
19. `setDefaults` (`:714-799`) — optimistic `setBatch` (`:764`), optimistic row overlay (`:770-777`),
    response merge (`:783`), overlay removal (`:788-797`).
20. Stack-advance (`:421-447`), box-stock (`:452-497`), location seed (`:502-526`), quantity reset
    (`:709-712`) — all call `setDefaults`, i.e. four writers that can race the seller's own default edits
    (A4).
21. `ArtworkVersionSelect`'s watch (`rows.jsx:61-111`) — auto-`onPick` (`:107`) after two awaits, guarded by
    `cancelled` (`:79`, `:93`, `:107`) and the `remapTried` keys (`:83-85`, `ScanDesk.jsx:569-574`); each
    auto-pick clears the server-side price (`scan_store.rs:1470-1473`) and so re-arms A1.
22. Price cell blur/focus (`rows.jsx:454-470`) → `priceTouched` (`:1801`), `restoreDefaultPrice` (`:1802`).
23. `undoStack` / `redoStack` (`:660-668`, `:801+`) — replay patches **after** the row may have moved; the
    `before` snapshot is taken from merged rows (`:661`), i.e. it can capture an in-flight optimistic overlay
    value as "the previous value".
24. `localStorage` `scan:box-positions` (`version-sets.js:32-49`) read inside `setDefaults` (`:756`) and
    written at `:762`; a second tab (dashboard Scan card) changes defaults behind this tab's back and only
    the stream can tell.
25. Server-side awaits between read and write: `patch_item` looks the new card up in the catalog **before**
    the transaction (`scan_store.rs:1445-1448`) and the price columns are decided from the row it reads
    *inside* the tx (`:1451-1458`), so the guard is evaluated against a row the client never saw; the
    early-exit at `:1475-1478` commits without `bump_batch`, so a stripped price patch produces **no** stream
    frame and the client is left believing its optimistic overlay value.
26. `set_defaults` fan-out (`:1398-1421`) runs `update … where status = 'active'` under `lock_batch`
    (`:1362`) — it can stomp a per-row edit that committed between the two client calls (A4 step 9).

**Server→client ordering that the client must respect:** `applyItems` drops an incoming row whose `seq` is
not newer (`scan-model.js:41-51`), and every mutation bumps the batch cursor (`scan_store.rs:1406`,
`:1479`) — so the desk is *expected* to receive replays, which is why the client-side books (`:154-163`) are
the only place a "have I already asked for this?" answer lives. The bug family in this report is that
bookkeeping, not the store.

---

## Not determined

- Whether the owner's two rows reached the empty-price state through **A2** (transient cheapest-price
  failure + exhausted budget), **A3** (a silent `patchRows` no-op after a remove/pause/undo) or **A11** —
  all three end on the same screen, and none of them logs anything. A console line in `retryPrices`'
  give-up branch and in `patchRows:619` would separate them in one session.
- The failure source behind A2's step 2: no server log or `logs`/journal access was used in this analysis.
- Whether `fetchCardSales(id, { slices: true })` returns `slices: []` or `404` for a printing with no sold
  data — `api.js:624` was read for the id-validation and slice shape only; if it *throws* on empty, then
  `:1304-1307` (`!Array.isArray(slices)`) fails **every** no-comps row and A2 explains the symptom without
  any transient error at all. That single question is worth answering first.
- Solid 2.0 `createEffect` scheduling inside an async continuation (A1's step 3, A7's step 3): I read
  `watch.js:18-25` and reasoned from it, but did not run the SPA. Neither finding's conclusion depends on
  it, as noted.
- Whether the abandoned batch from `newBatch` (`:1481-1493`) really stays `open` (no TTL read), which decides
  how bad A10's step 5 is.
- Whether `rows.jsx`'s `value=` binding is re-applied by the Solid compiler on identity change or only on
  string change (A7 step 3, A12) — needs a build, not a read.
- Per-row `location` editing: `BATCH_ROW_FIELDS` includes `location` (`scan-artwork-versions.js:50`) and
  `set_defaults` fans it (`scan_store.rs:1393`), but I did not find a row-level Location input, so A4's step
  9 ("the bulk UPDATE lost a per-row edit") is stated for the fields I did see edited per row
  (`language`, `condition`, `foilState`, `firstEdition`, `signed`, `altered`).

---

## Commits: what changed the price box behaviour

Read with `git log -S` / `git show` on the area files.

| Commit | Date | What it did to this pipeline | Verdict |
| --- | --- | --- | --- |
| `4629f1bc` `fix(scan-desk): a failed price lookup or save is retried, not taken for "no price"` | **2026-11-13** | `api.js`: `fetchCheapestPricePknMap` gains `{ strict }` and rethrows (`api.js:729`). `ScanDesk.jsx`: adds `priceFailures` + `retryPrices` + `saved()`/`ok === false`, `failed` collection (`:1332-1335`) and removes the two forgiving paths — the slices `.catch(() => [])` and the non-strict `{}` cheapest map. Before it, an unavailable cheapest read yielded `byId = {}` → `listed = NaN` → the `scanFallbackPricePkn()` rung → **every row always got a price**. | **The regression for S1/S2.** It made "no data" and "could not look it up" different, and then left the give-up path (`price-requests.js:52`) unable to say so (A2, A11). The fix's intent was right; the missing half is releasing the claim and reaching the documented fallback. |
| `99ba5eaa` `fix(scan-desk): keep price suggestions alive when a run is cancelled` | 2026-11-01 | Introduced `price-requests.js` (`claimRows`, `releaseUnsettled`) and the `settled` protocol (`:1266`, `:1314`). | Contributing. This is where "computed" became `settled` (A3) and where a dropped release became permanent. |
| `19fafa88` `feat(scan): no comps and no listing default the row to 10,000 EUR in PKN` | — | Added `scanFallbackPricePkn` (`scan-pricing.js:22`, `:29-32`) and the `:1338` rung; `361a61bd` added the nightly repricer for it. | Context: the invariant `docs/SCAN_LISTING_WORKFLOW.md:144-146` that A2 breaks, and the reason a stuck-at-fallback row is recoverable server-side but a stuck-at-`null` row is not. |
| `ae992ec3` `feat(pricer): pricing groups, named strategies, per-detail switches, batch pricing` | — | Added the Pricing select (`bars.jsx:372-391`), `pricing.js`, `unpricedOnLoad` / the `on load` placeholder (`rows.jsx:223`, `:449-453`) and `hidePrice`. | Contributing to the "the box shows nothing and means nothing" reading of S2: the placeholder can now stand for "will be priced on load" while the suggestion pipeline is still running (A9). |
| `c8ee6330` `feat(pricer): Price selected pop-up, per-row Scan desk pricing, unsaved marker` | — | Row-own `pricing` and `pricingApplyBodies` at submit (`:1446`, `pricing.js:140-166`). | Context for A9 step 3 (a desk suggestion suppressing the group rule). |
| `9101a2d4` `feat(solid): port the Scan Connect desk` | — | Introduced `priceTouched` (`:156`, `:1256`, `:1801`). | A6 has existed since the port; it only became visible once `4629f1bc` stopped re-pricing rows on every churn. |

**Single answer to "which commit":** `4629f1bc` (2026-11-13) introduced the price box behaviour the owner
describes, with `99ba5eaa`'s claim/`settled` protocol as the precondition (A2 + A3), and it is the last
commit in the area that touched `market/src/api.js`.
