# Scan desk race analysis — part c: submit and persistence

Scope: everything between pressing **Add N cards to Pokoin + CardTrader** and those
listings existing (plus the price-suggestion writes that race with it, the batch
defaults that decide pricing membership, and the reload / intent-switch persistence
around a submit). Area assigned: the submit code in `solid/src/pages/ScanDesk.jsx` and
its helpers, the Pokoin / CardTrader "Add to" toggles, double submit and retry, partial
failure, rows edited while a submit is in flight, how pricing group / strategy membership
is written for the batch, and the Rust handlers that create the scan batch, the listings
(`source = 'pokoin_scan_batch'`), the CardTrader push and the post-submit pricing — plus
draft/batch persistence across reload and the "List for sale" / "Add to collection" switch.

Read-only pass. No source file and no test was changed. Files read in full or in the
relevant ranges: `solid/src/pages/ScanDesk.jsx`, `solid/src/pages/scan-desk/{price-requests,pricing,watch,version-sets,bars,rows}.js(x)`,
`solid/src/components/desk/InventoryTargets.jsx`, `market/src/{scan-api,scan-model,scan-pricing,scan-stream,scan-artwork-versions,api}.js`,
`pokoin-rust/crates/external/src/{scan_store,scan_connect,routes/scan}.rs`,
`pokoin-rust/crates/commerce/src/handlers/pricer.rs`,
`pokoin-rust/crates/external/src/pricing_store.rs`, `pokoin-rust/apps/api/src/jobs/{unpriced,pricing_groups}.rs`,
`pokoin-rust/crates/api-common/src/pg.rs`, `pokoin-rust/crates/external/tests/fixtures/scan_schema.sql`,
`docs/CI.md`, `docs/SCAN_CONNECT.md`, and the deleted React/Node desk + backend via `git show`.

Severity classes are the ones in the brief: **data loss / wrong listing**, **wrong price
shown**, **stuck row**, **cosmetic**.

---

## 1. Submit builds, prices, groups and pushes CardTrader from a row snapshot that stops being true halfway through

**Severity:** data loss / wrong listing (the highest-stakes class: the seller's stock goes on sale at a price and in a condition they did not approve, or does not go on sale at all).

**Interleaving**

1. Desktop: `submit()` → `scanApi.submit(t, b.id, submitKey, intent, nextTargets)` — `solid/src/pages/ScanDesk.jsx:1437`, body built at `market/src/scan-api.js:83-88`.
2. Server: `submit_batch` locks the batch and reads **all active rows with `for update`** — `pokoin-rust/crates/external/src/scan_store.rs:1760`. From here on every decision about price, condition, language, quantity and pricing choice is made from `rows` / `created[i].row` clones (`:1834`, `:1925-1931`).
3. Server: listings are inserted/updated with the **row values as of step 2**, including `price_pkn` (`scan_store.rs:1864`) and `location` (`:1839`, `:1880`), then **`tx.commit()`** — `scan_store.rs:1933`.
4. Server: **phase 2 is a network loop outside any transaction** — `ownership.upsert(...).await?` per created row, `scan_store.rs:1937-1947`. On a 40-row batch this is tens to hundreds of milliseconds, during which the batch is still `status='open'` and the rows are still `status='active'`.
5. Meanwhile: the seller finishes typing a price (or the price effect lands a suggestion, or they switch the printing) → `patchRows` → `POST /api/scan-batch?action=item` → `mutate_batch` → `patch_item` — `scan_store.rs:2217`, `:1433`. `lock_item` locks row **and** batch (`:1336`), `require_open_batch` **passes** (`:1453`, batch flips to `submitted` only at `:2058-2067`) and the status guard **passes** (rows are still `active`, checked at `:1455`). The new price is committed to `scan_items`.
6. Server: phase 3 re-locks the batch (`:1950-1968`) and then, for every entry, decides the listing's initial state from the **stale** clone: `let status = if rules::row_priced(&entry.row) { "active" } else { "paused" }` — `scan_store.rs:1975`; the row is closed with an **unguarded** `update scan_items set status='submitted' … where id=$1::uuid` (`:1998`); group membership is filtered from `row_pricing(&entry.row)` (`:2010-2016`); the desk's post-submit pricing list is built from `entry.row` too (`:2019-2032`); the CardTrader push set is `created.iter().filter(|entry| rules::row_priced(&entry.row))` (`:2053-2057`).
7. Result on the seller's screen: the row shows the price they typed (the desk re-reads the snapshot at `ScanDesk.jsx:1464-1465`), and the **listing** holds the pre-edit value.

**Concrete outcomes of one lost race**

* The seller raised 150 → 400 PKN while submit ran → the listing is live at 150 (`:1864`, `:1975`).
* The row had **no** price at step 2 and its suggestion landed at step 5 → `row_priced(&entry.row)` is false → the listing is written `paused` at 0 (`:1975`), it is **excluded from the CardTrader push** (`:2053-2057`) even though the seller ticked CardTrader, and the desk's `applyPricing` gets `priced:false` only for the group case — see finding 9 for the strategy case.
* The seller switched the printing (which clears `price_pkn`/`price_suggested` server-side, `scan_store.rs:1470-1472`) → the listing keeps the **old** card id/`card_id`-derived fields and the old price.
* The seller changed condition/language after step 2 → the listing and the CardTrader payload (`:2113-2125`) carry the old facet, so the comp the seller sees on the desk is not the offer that exists.

**Why the code allows it:** submit is a three-phase operation whose phase 1 commits and whose phase 2 is an external call, but the *decisions* are made once from the phase-1 snapshot instead of being re-derived under the phase-3 lock. Phase 3 does re-lock the batch and re-check its **status** (`:1951-1968`) — it never re-checks the **rows**, and `patch_item` is not blocked because `require_open_batch` is still satisfied until `:2058`. There is no version/`seq` token on the row → listing write and no `where seq = …` guard.

**Evidence** (all *confirmed by reading*): `scan_store.rs:1760` (`select … for update`), `:1864` (`price_pkn` bound from the snapshot row), `:1933` (commit), `:1937-1947` (ownership awaits outside the tx), `:1975` (`status` from `entry.row`), `:1998` (`update scan_items … where id = $1::uuid` with no status/seq guard), `:2010-2016` (group members from `entry.row`), `:2019-2032` (`rowPricing` echo from `entry.row`), `:2053-2057` (CardTrader set from `entry.row`), `:1453-1455` (`patch_item` passes both guards during the window). Nothing here is inferred; the only *suspected* part is how often it happens — it needs a submit overlapping an edit, which the desk makes likely because the price effect keeps writing rows until `closed()` flips (`ScanDesk.jsx:1253`).

**Does it explain a symptom above?** Partly symptom 1: a row that got its suggestion during the submit window is listed `paused` at 0 and never reaches CardTrader, so the seller sees "priced on the desk, nothing on sale". It does not explain the price box display.

**Fix sketch:** in phase 3, re-read each row under the lock (`select … from scan_items where id = any(…) for update`) and recompute price/status/pricing choice from the fresh row, or re-run the listing `update` from the fresh row before activating; add `and status = 'active'` to `:1998`; take the batch to a `submitting` status (or hold `for update` on the rows into phase 3) so `require_open_batch` fails for concurrent edits.

**Regression test:** `pokoin-rust/crates/external/tests/scan_batch_pricing_flow.rs` (flow-db tier), new test
`an_edit_during_submit_reaches_the_listing`: create a batch with one active row at 100 PKN, start `submit_batch` and, while phase 2 is blocked (inject a slow `ScanOwnership` in the test seam, the same way `batch_with_rows` at `:52` builds state), `patch_item` the same row to 400 PKN; assert `marketplace_user_listings.price_pkn = 400`, `status='active'`, that the row's `pricing` group membership came from the new row, and that a row whose price only appeared during the window is **not** left `paused` at 0.

---

## 2. A phone scan that arrives while submit is running is inserted into the batch that submit closes, and is never listed

**Severity:** data loss (stock the seller physically scanned silently disappears from every list).

**Interleaving**

1. Phone: `POST /api/scan-phone?action=scan` → `ingest_scan` — `scan_store.rs:899`; the session row (and only the session row) is locked with `for update of s` (`:559`, `:478`), so `batch_status` is the value **as of that read**.
2. `ingest_scan` checks `if session.get("batch_status") != Some("open") → batch_closed` — `scan_store.rs:1020-1022`. The desktop's submit is still in phase 1 or 2, so the batch is `open` and the check passes.
3. Desktop submit commits phase 3 and sets the batch `submitted` — `scan_store.rs:2058-2067`, `tx.commit()` at `:2076`.
4. Phone: `ingest_scan` now executes `select * from scan_batches where id = $1::uuid for update` — `scan_store.rs:1024-1027`. It **blocks** on the batch lock submit has held since `:1748`; when it acquires it, it reads the fresh batch row but only checks `item_position >= MAX_BATCH_ROWS` (`:1029`) — **it never re-checks `status`**.
5. Phone: the row is inserted with `status='active'` — `scan_store.rs:1127`, commit `:1218`.
6. That row is now `active` inside a `submitted` batch: submit's row query already ran (`:1760`), no later submit can include it (`:1757-1758` returns `batch_closed`), `set_defaults`/`patch_item`/`set_status` all refuse it (`require_open_batch`, `:1350-1355`), and `list_open_batches` (`:770`) will never offer it again. A desk reload still shows it in the snapshot (`read_batch_snapshot`, `:696-725`, selects by `batch_id` only) — so the card is visible forever and unsellable forever.

**Why the code allows it:** the open/closed decision is taken from a **denormalised copy** (`scan_sessions` join's `batch_status`) read before the lock, instead of from the locked batch row read after it. Every other writer (`patch_item`, `set_status`, `duplicate_item`, `add_manual`) uses `lock_item`/`lock_batch(open = true)`, which read the status from the locked row, so they fail correctly — `ingest_scan` is the one insert path that checks early and writes late.

**Evidence:** `scan_store.rs:1020` (status check), `:1024` (lock taken afterwards, `select * from scan_batches … for update`, no seller filter and no status check), `:1029` (the only post-lock check), `:1127` + `:1218` (insert and commit), `:1757-1760` (submit reads rows once and refuses a non-open batch), `:696-725` and `:770` (snapshot vs open-list semantics). *Confirmed by reading.* The window is real but short — the phone insert must start before submit's phase-3 commit and block on the batch lock; with Scan Connect running during an upload that is exactly the common case.

**Does it explain a symptom above?** No, none of the three reported symptoms. It is a separate, worse bug found in the same window.

**Fix sketch:** pass `open = true` semantics at `:1024` (call `lock_batch(&mut tx, seller_uid, &batch_id, true)`) so the post-lock status check produces `batch_closed`, and let the phone retry into a new batch; or re-check `batch_row.status` immediately after `:1027`.

**Regression test:** `pokoin-rust/crates/external/tests/scan_rows_flow.rs` (flow-db tier), new test
`a_scan_that_lands_while_submit_closes_the_batch_is_rejected`: pair a session to a batch, start `submit_batch` with a blocked ownership seam, call `ingest_scan` for that session during the block, and assert it returns `409 batch_closed` and that `select count(*) from scan_items where status='active' and batch_id in (select id from scan_batches where status='submitted')` is 0.

---

## 3. The "only fill an empty price" guard is dead: the client sends it inside `patch`, the server reads it from the top level (this is the price-box regression)

**Severity:** wrong price shown **and** wrong price listed — a background suggestion silently replaces a price the seller just typed, and because `priceTouched` then blocks that row for the rest of the mount, nothing corrects it before the batch is submitted.

**Interleaving**

1. Prices effect claims a row that has no price yet: `claimRows(want, books)` — `solid/src/pages/ScanDesk.jsx:1265`; `row.pricePkn == null` at filter time (`:1258`).
2. Effect starts the comps request (`:1283`) — an await that can take a while.
3. Seller clicks the price box of that row: `onFocus` → `props.onPriceFocus(row().id)` → `priceTouched.add(id)` (`solid/src/pages/scan-desk/rows.jsx:454-457` wired at `ScanDesk.jsx:1801`), types `400`, blurs → `priceFieldCommit` → `action:'set'` (`rows.jsx:461-466`) → `patchRows([id], {pricePkn: 400, priceSuggested:false})` (`ScanDesk.jsx:613`).
4. The effect's in-flight run then reaches `if (row.pricePkn == null) patch.onlyIfEmptyPrice = true;` — `ScanDesk.jsx:1313` (and the same line in the fallback pass, `:1342`) — using the row object captured at claim time, so it still believes the box is empty, and sets the flag **inside `patch`**.
5. Wire shape: `scanApi.patch(token, itemId, patch, batchId)` → `post('/api/scan-batch?action=item', withBatch({ itemId, patch }, batchId))` — `market/src/scan-api.js:77`. The JSON body is `{"batchId":…,"itemId":…,"patch":{…,"onlyIfEmptyPrice":true}}`.
6. Server: `mutate_batch` reads the flag from the **top level** of that body: `patch_item(db, seller_uid, item_id, &patch, payload.get("onlyIfEmptyPrice") == Some(&Value::Bool(true)))` — `pokoin-rust/crates/external/src/scan_store.rs:2217`. The key is not there, so `only_if_empty_price` is **`false`**.
7. `patch_item` therefore skips its guard (`:1456`) and writes `price_pkn = 320` over the 400 the seller just saved (`:1477-1491`). The desk shows the suggestion, the listing will be created with it (`scan_store.rs:1864`).

**Why the code allows it:** the flag's position in the payload is a wire contract with two owners and no test on the boundary. `parse_item_patch` (`scan_connect.rs:928-1025`) deliberately does not know about the flag, so the nested key is silently dropped rather than rejected, and nothing logs an unknown body key. The server's response echoes the *pre-update* row when the guard does fire (`:1475-1477` returns `item_view(&row)`), so even when it works the desk cannot tell "skipped" from "written" except by the returned value — and `patchRows` ignores the response body entirely (`ScanDesk.jsx:686-689`).

**Evidence**

* *Confirmed by reading:* `ScanDesk.jsx:1313`, `:1342` (flag placed inside `patch`), `market/src/scan-api.js:77` (nested body), `scan_store.rs:2217` (top-level read), `:1438`/`:1456` (the guard the flag controls), `scan_connect.rs:928-1025` (`parse_item_patch` ignores the key). A repo-wide grep for `onlyIfEmptyPrice` returns exactly three hits — the two client writes and the one server read above, in that mismatched shape, so **no caller in this repository can ever enable the guard**.
* *Confirmed by reading, as a port regression:* the retired Node backend read it from inside the patch — `git show 001b4783^:server/pokoin-api/_scan_store.js`, `patchItem({ sellerUid, itemId, patch })` at line ~971: `const onlyIfEmptyPrice = patch?.onlyIfEmptyPrice === true;` — and the deleted React desk sent it nested in the same way (`git show e8927e01^:market/src/pages/ScanDesk.jsx:1225`, `:1240`). So the client kept its side of the old contract and the Rust port changed the read.
* **Introduced by `21ba8cef` (2026-10-08, "feat(rust): integrate accounts, commerce, external and catalog-routes crates into pokoin-api").**

**Does it explain a symptom above?** Yes, symptom 2 ("the price box no longer shows the suggested price and clearing it no longer restores it, as it was some commits ago"): the CAS is what made an empty box fillable and a filled box untouchable. With it dead, any late suggestion overwrites what the seller typed, `priceTouched` (`ScanDesk.jsx:1256`) then suppresses every further suggestion for that row, and `restoreDefaultPrice` (`:594-611`) restores from `lastSuggested` — which was recorded for the *stale* signature before the save (`:1311`, `:1341`) — so clearing no longer gives back the number the seller expects. It also contributes to symptom 1 (the suggestion the seller is waiting for can be dropped/replaced by the next write instead of landing once).

**Fix sketch:** one line — read the nested key in `mutate_batch`: `patch.get("onlyIfEmptyPrice") == Some(&Value::Bool(true))` (keeping the top-level read for compatibility is not needed: no caller sends it), or hoist the flag to the top level in `market/src/scan-api.js:77` and keep the server as-is. Whichever side moves, assert the shape in a test so the two cannot drift again.

**Regression test (server, primary):** `pokoin-rust/crates/external/tests/scan_rows_flow.rs` (flow-db tier), new test
`only_if_empty_price_is_read_from_the_patch_the_desk_sends`: `patch_item` a price onto a row that already has one with the payload exactly as `scan-api.js:77` builds it (`{"itemId":…,"patch":{"pricePkn":300,"priceSuggested":true,"onlyIfEmptyPrice":true}}`) and assert `price_pkn` is unchanged; then repeat with `onlyIfEmptyPrice` on the row that has `price_pkn IS NULL` and assert it became 300. Both directions belong in one test: today the first silently passes as a write and the second silently works.
**Regression test (client, JS tier):** `solid/src/pages/scan-desk/price-requests.test.js` — see finding 17 for why the desk effect needs a helper extracted first; assert that the object handed to `scanApi.patch` carries the flag **inside** the patch only, so a future change to either side is caught by the pair.

---

## 4. "List for sale" / "Add to collection" is not persisted anywhere, and the batch has no intent

**Severity:** data loss / wrong listing — after a reload the desk silently defaults to *listing* stock the seller meant to collect (and can push it to CardTrader).

**Interleaving**

1. Seller switches to "Add to collection" (`ScanDesk.jsx:1596-1609`, `setSubmitIntent('collection')`) and scans 40 cards. `submitIntent` is a plain local signal: `const [submitIntent, setSubmitIntent] = createSignal('list')` — `ScanDesk.jsx:136`.
2. Seller reloads (or navigates away and back). `start()` restores the **batch** from the server — a reload is not lossy for the rows, because `start_session` with an empty `batchId` reuses the newest open batch (`scan_store.rs:266-273`) and `read_batch_snapshot` re-reads the rows (`:696-725`), and `rememberActiveSession` puts the session id in localStorage (`market/src/scan-api.js:101-108`).
3. Nothing restores the intent: there is no `intent` column on `scan_batches` (`pokoin-rust/crates/external/tests/fixtures/scan_batches` columns: `id, seller_uid, status, title, defaults, defaults_version, defaults_history, item_seq, item_position, submit_key, submit_result, created_at, updated_at, submitted_at`), `start_session`/`submit` take intent only as a per-call parameter (`:1737`), and the desk never writes it to storage.
4. The button now reads "Add 40 cards to Pokoin" (`:1692`, `submitLabel`), `hidePrice`/`priceOnLoad` flip back to the listing semantics (`:1787-1788`), the prices effect starts running for rows it must not price (`:1253` returns early only while `intent === 'collection'`), and `InventoryTargets` re-seeds the CardTrader tick from its localStorage cache (`solid/src/components/desk/InventoryTargets.jsx`, `readCachedCardTraderStatus`).
5. One press lists all 40 collection cards for sale, optionally on CardTrader (`ScanDesk.jsx:1424-1437`, `scan_store.rs:1737-1743`).

**Why the code allows it:** intent is modelled as a UI toggle instead of a property of the batch, while every other piece of desk state (rows, defaults, session) is server- or localStorage-backed. The reload path is therefore "half-restored" and the failure direction is the destructive one.

**Evidence:** *confirmed by reading* `ScanDesk.jsx:136` (signal, default `'list'`), `:1424-1431` (intent read at submit time), `:1596-1609` (the toggle has no storage), `scan_store.rs:1737-1743` (intent only a parameter), the fixture column list above (no intent). *Suspected, not confirmed:* whether the seller in symptom 1 actually reloaded — no log or repro was given, so this is reported as a reachable wrong-listing path, not as the proven cause of their session.

**Does it explain a symptom above?** It explains a class of "it listed what I was collecting" and, if the session included a reload, it also matches symptom 1's two rows being priced at all (`intent === 'collection'` is the only list-side guard at `:1253`): a reload flips a collection batch into listing mode and the desk begins suggesting prices on rows the seller is not selling.

**Fix sketch:** persist the intent with the batch — either a `defaults.intent`/`submit_intent` field written by `set_defaults` and returned by `batch_view`, or (minimal, browser-only) `localStorage` keyed by batch id, read in `start()` like `rememberActiveSession`. Default the restore to the value the batch was created with, never silently to `'list'`.

**Regression test (client, JS tier):** `solid/src/pages/scan-desk/intent.test.js` (new; `solid` runs `node --test "src/**/*.test.js"`) over a small pure helper `readStoredIntent(batchId, storage)` / `storeIntent(batchId, intent, storage)` extracted from `ScanDesk.jsx`: assert a stored `collection` survives a re-read for the same batch id, and that a **different** batch id does not inherit it.
**Regression test (server, flow-db tier):** `pokoin-rust/crates/external/tests/scan_batch_pricing_flow.rs` — `a_batch_remembers_whether_it_lists_or_collects`: `set_defaults({intent:'collection'})`, re-read via `read_batch_snapshot`, assert `batch_view.defaults.intent === 'collection'`, and assert `submit_batch` with no explicit intent keeps collection semantics (no `marketplace_user_listings` rows).

---

## 5. Any row change cancels the cheapest-listed / fallback pass, so rows with no sold comps can be starved indefinitely — the best match for symptom 1

**Severity:** stuck row (and, because the desk gate is per-row, it blocks the whole upload: `submit_problem` returns `no_price` when the batch names no pricing group — `scan_connect.rs:1053-1058`, surfaced as "N need a price" at `ScanDesk.jsx:1679`).

**Interleaving**

1. Prices effect runs for the two fresh rows: `watch(() => [list(), closed(), submitIntent(), priceRetry()], …)` — `ScanDesk.jsx:1251`. Both rows have `pricePkn == null`, so `want` includes them (`:1258`) and `claimRows` marks them asked (`:1265`).
2. Neither card has sold comps, so `suggestPriceFromSlices` returns 0 and the rows are parked in `cheapestIds` (`:1309-1318`). The `/api/marketplace-card-sales?slices=1` answer for a no-data card is `200 {slices: []}` — confirmed by `pokoin-rust/crates/catalog-api/tests/satellite_marketplace_flow.rs:262-266` — so this is the *normal* path for a fresh uncommon, not an error path.
3. To price them the run must survive the **second** pass: `await fetchCheapestPricePknMap([...cheapestIds], {strict:true})` (`:1324`) — one network round trip — and then `if (cancelled) return;` at `:1329`.
4. Phone scans the next card / any SSE `items` frame lands / `patchRows` pushes a `pending` overlay → `displayRows` recomputes (`:340-347`) → `list()` is a new array → the `watch` deps differ → the cleanup `cancelled = true; release();` runs (`:1349-1352`).
5. `releaseUnsettled(want, settled, books)` (`:1273-1277`, `solid/src/pages/scan-desk/price-requests.js:25-35`) un-marks the rows because they were never settled — the second pass had not started.
6. The next run re-claims them and repeats from step 1. Each run only ever completes the **comps** pass (`:1296-1319`), because that pass is synchronous over an already-cached promise, while the fallback pass always needs a fresh request that outlives the scan cadence. While the phone keeps scanning, the two rows never receive any price: the box stays empty, the chip keeps saying "2 need a price", and submit refuses with `no_price`.
7. `settle-before-land` makes a variant permanent: `settled.add(row.id)` happens **before** the save (`:1314`, `:1339`), so if the run is cancelled in that window the row is treated as done by `releaseUnsettled` and is never re-asked — the seller's only recovery is a reload.

**Why the code allows it:** the cancellation granularity is the whole effect, but the work has two very different costs: comps (cached, per printing) and the cheapest/fallback pass (one request, and the *only* way a no-comp row gets a price). Re-triggering on `list()` — which changes for any field of any row, including the `pending` overlay and the defaults fan (finding 8) — turns a continuous scan stream into a permanent preemption of the cheap-but-late pass. There is no per-row token, no separate effect keyed by printing, and no "this row already got a fallback attempt" marker other than `settled`, which is set before the write is known to have landed.

**Evidence:** *confirmed by reading* `ScanDesk.jsx:1251` (deps include `list()`), `:1266`, `:1273-1277`, `:1296-1319`, `:1322-1329`, `:1330-1344`, `:1349-1352`, `price-requests.js:25-35`, `:340-347` + `:348` (`displayRows`/`list` memos). *Confirmed:* `market/src/api.js:711-732` (`strict` rethrows only on a request failure, so a missing listing entry correctly reaches `scanFallbackPricePkn()` at `ScanDesk.jsx:1338`). *Suspected, not confirmed:* that the owner's session was scan-driven at the time — the interleaving is proven from the code, the trigger frequency is not measured here.

**Does it explain a symptom above?** **Yes — symptom 1 is this shape exactly**: two freshly added rows, `Pricing = "Suggested prices"` (the empty choice in the batch select, `solid/src/pages/scan-desk/bars.jsx:388`, renamed by `513688ed`), empty price box, state "Needs a price", counter "2 need a price" — i.e. rows that have neither comps nor a listed offer and therefore depend entirely on the pass that keeps getting cancelled. (Commit `513688ed` is label-only; it tells us which control the owner was looking at, it is not the cause.)

**Fix sketch:** make the fallback pass cancellable *per row* instead of per run: keep one long-lived pricer loop over an id queue (add-on-change, never restart), or drop `list()` from the deps and use a "rows needing a price" memo that only changes when a row enters/leaves the set. Also move `settled.add(row.id)` into the `saved(...)` continuation after `patchRows` resolved truthy, so a cancelled or failed save always releases.

**Regression test (client, JS tier):** extract the run into a pure module (see finding 17) and add `solid/src/pages/scan-desk/price-requests.test.js::a_no_comp_row_survives_a_re_scan_while_its_fallback_request_is_in_flight` — feed the helper a claim, cancel it, re-claim, and assert the no-comps row is eventually handed the `scanFallbackPricePkn()` patch; assert `settled` is only marked after a save that returned `true`.

---

## 6. After four failed attempts a row is never asked again in that mount, and nothing tells the seller

**Severity:** stuck row, silently.

**Interleaving**

1. A comps request fails (`ScanDesk.jsx:1300-1306`) or the cheapest request fails (`:1324-1328` → `byId = null` → `:1332-1334` pushes **every** no-comp row of the run into `failed`).
2. `retryPrices(failed)` (`:1345`, `:581-591`) → `nextPriceRetry(priceFailures, rows, facetSignature)` (`price-requests.js:46-57`) increments the per-`${rowId}:${signature}` counter and returns the rows still under `PRICE_RETRY_MAX = 4` (`:38`, `:52`) with a 2/4/8/16 s delay (`:55`).
3. `releaseUnsettled(retry, new Set(), books)` at `ScanDesk.jsx:585` releases **only the rows in `retry`**. The rows that just crossed the limit are `continue`d at `price-requests.js:52` and are therefore *not* released — their `pricesAsked` key stays in the set forever (`:18`), so the filter at `:1258` rejects them for the rest of the mount, and their `suggestedFor` entry stays too.
4. The desk shows "Needs a price" with no explanation; the only recovery is a reload or typing a price by hand. The `error` banner is never set for this (`retryPrices` does not surface anything; the note at `price-requests.js:37` calls it out in a comment: "then the row waits for a reload").

**Why the code allows it:** give-up is expressed as "don't include the row in `retry`" rather than as an explicit release-and-mark-failed, so the row is left in the claimed state, which the effect reads as "already handled". A transient outage (Meili/Postgres restart, a 502 from the edge, the flaky `card-cheapest-price` route) that lasts ~30 s permanently strands every unpriced row in the batch.

**Evidence:** *confirmed by reading* `price-requests.js:37-57` (the max, the `continue`), `ScanDesk.jsx:581-591` (release only of `retry`), `:1258` (the asked-filter), `:1332-1334` (one failed cheapest read condemns the whole no-comp group), `:1345`.

**Does it explain a symptom above?** Yes, as a second path to symptom 1 — including the case where the two rows are the only ones with no comps and the cheapest request is what failed.

**Fix sketch:** on give-up, keep the claim but mark it visibly (`priceGaveUp.add(key)` → the row's problem label becomes "price lookup failed — retry") and offer a per-row retry; and in `releaseUnsettled`, release the given-up rows too so a later list change asks again. Also stop condemning the whole group at `:1332`: fall back to `scanFallbackPricePkn()` per row when `byId` is null, and let the retry only apply to the rows that still have no price after it.

**Regression test (client, JS tier):** `solid/src/pages/scan-desk/price-requests.test.js::a_given_up_row_is_released_so_a_later_change_can_ask_again` (extend the existing `PRICE_RETRY_MAX` tests): assert `nextPriceRetry` reports which rows it gave up on, and that after give-up the row is no longer present in `pricesAsked`.

---

## 7. Two batch-defaults writes are unsequenced, so an older response overwrites the newer one — the best match for symptom 3

**Severity:** wrong batch state that then writes wrong values onto every row and into every listing (defaults are inherited at scan time, `scan_store.rs:1033-1055`).

**Interleaving**

1. Seller changes the batch Pricing select from a group to "Suggested prices" → `setDefaults({pricingGroupId:'', pricingStrategyId:''})` (`bars.jsx:375-378` → `pricing.js:26-32`, `ScanDesk.jsx:714`). Optimistic paint `setBatch(prev => ({...prev, defaults:{...prev.defaults, ...nextPatch}}))` at `:764`, then `await token()` and `await scanApi.defaults(...)` (`:781-782`).
2. Seller immediately changes Condition (`bars.jsx:193`) → a second `setDefaults({condition:'LP'})`. Nothing serialises these calls (unlike row edits, which go through `patchChain`, `ScanDesk.jsx:686-689`), and each one re-reads `current = untrack(batch)` at `:715`.
3. If request A's response arrives **after** B's — likely, because a defaults change is server-side fan-out over every active row (`scan_store.rs:1386-1416`) and B may have queued behind it, and because `setDefaults` awaits `fetchSellerBoxSlots` first when `location` is involved (`:724-746`) — then A's `data.batch` is a snapshot taken **before** B applied.
4. `setBatch(prev => ({ ...prev, ...data.batch }))` (`:783`) spreads the *whole* `defaults` object of that older snapshot over the current one, so the pricing group comes back and the new condition is lost. `defaultsVersion` is exposed by `batch_view` (`scan_connect.rs:1140-1153`) and the desk already receives it, but is never compared.
5. If the second request **fails**, the `catch` at `:785-786` only sets `error` and does not roll back the optimistic write from `:764` — so the desk shows defaults the server never took, and the next reload brings the old values back: exactly "I cannot switch it off".
6. Finally, an empty/invalid value is not a clear on the server: `normalize_defaults` falls back to the **current** value for anything it does not recognise — `pick()` `scan_connect.rs:190-196` (so `game`/`language`/`condition`/`foilState` keep the old value if the payload says `""`), `clamp_int` `:198-213` (so `stack`/`stackSize`/`startPosition`/`quantity` keep the old number for an empty or unparseable input). `pricingGroupId`/`pricingStrategyId` **are** clearable (`clean_pricing_id` `:69-76` returns `""`, and the merge at `:267-280` honours it), as are the booleans (`:259-265`) and `location` (`:298-300`) — so a select/number default that snaps back is this fallback, not a refusal to clear.

**Why the code allows it:** `setDefaults` is the only write path in the desk without a sequencing token or a chain; the response is applied as a blind object spread, so "latest request" and "latest response" are conflated, and the optimistic state has no rollback on error. The server is intentionally last-write-wins (merge under the batch lock, `scan_store.rs:1360-1404`) and hands the desk a version number it does not use.

**Evidence:** *confirmed by reading* `ScanDesk.jsx:714-799` (`:764` optimistic, `:783` blind spread, `:785-786` no rollback, `:724-746` extra await), `bars.jsx:375-378`/`:193`/`:118-139` (two independent default controls in one batch), `scan_connect.rs:190-196`, `:198-213`, `:267-280`, `scan_store.rs:1406-1416`, `scan_connect.rs:1140-1153` (`defaultsVersion` present in `batch_view`). *Suspected, not confirmed:* which control the owner actually toggled — "a Batch default cannot be switched off" fits (7) response-clobbering for the pricing select and (6)/step-4 `pick`/`clamp_int` fallback for a select or number field; I could not reproduce, and no repro steps were given.

**Does it explain a symptom above?** Yes — symptom 3, by either of the two mechanisms above. It also feeds symptom 1: a clobbered `condition`/`language` default changes `facetSignature`, which invalidates suggestions and re-arms the effect at the worst moment.

**Fix sketch:** serialise `setDefaults` through the existing `patchChain` (keyed by batch id) or attach `expectedDefaultsVersion` and ignore a response whose `defaults_version` is below the highest already applied; roll back the optimistic `setBatch` in the `catch`; and make an empty string an explicit clear for the enumerated fields (`""` → the control's "no value") rather than a `pick` fallback, so the response cannot snap the old value back.

**Regression test (server, unit tier — no DB, so it runs in the GitHub `test` job):** `pokoin-rust/crates/external/src/scan_connect.rs` `mod tests` — `normalize_defaults_clears_rather_than_reuses_the_current_value`: assert `normalize_defaults(json!({"condition":""}), &prev_with_NM)` today keeps `"NM"` (pin the current contract in the test) and, after the fix, that it either clears or is rejected loudly; plus `a_patch_with_both_pricing_ids_cleared_removes_the_group` for the `""` case.
**Regression test (client, JS tier):** `solid/src/pages/scan-desk/defaults-sequence.test.js` (new) over a pure `applyDefaultsResponse(prev, response)` helper extracted from `ScanDesk.jsx:783`: given `prev.defaults_version = 8` and a response with `defaults_version = 7`, assert the response is dropped and the newer condition/pricing survive; given a failed request, assert the optimistic defaults are rolled back.

---

## 8. The batch-defaults fan bumps the batch counter once but `seq = seq + 1` per row, so fanned rows fall behind the stream cursor and are never delivered again

**Severity:** wrong price shown, plus stale rows on any second view of the same batch.

**Interleaving**

1. `set_defaults` merges and writes the batch under the lock, then fans the 7 editable fields onto every active row: `let _ = bump_batch(&mut tx, batch_id, 0).await?;` — the **new `item_seq` result is discarded** (`scan_store.rs:1406`, `bump_batch` at `:800-819`) — and the row update uses `set …, seq = seq + 1` (`:1410`), i.e. **each row's own previous seq + 1**, not the batch counter.
2. Rows age apart: a row last touched at seq 5 and another at seq 12 (`item_seq = 12`) become seq 6 and 13 after one defaults change, while `item_seq` is 13.
3. The stream's only row query is `select … from scan_items where batch_id = $1 and seq > $2 order by seq asc` — `scan_store.rs:743-753` — and the cursor starts at the batch counter: `hello` carries `"cursor": cursor` taken from `batch_view.cursor` (= `item_seq`, `scan_connect.rs:1147`) and `bye` replays the same counter (`routes/scan.rs:361-372`, `:394-397`). `items_after` is polled once a second and the cursor advances to `max(seq)` of the delivered page (`routes/scan.rs:400-417`).
4. So the row sitting at seq 6 is **below the cursor and never returned again**: the other desktop / the reconnecting stream / the phone-linked second view keeps the pre-change `language`, `condition`, `foilState`, `firstEdition`, `signed`, `altered`, `location` for that row, while the server and the initiating desk (whose HTTP response does carry the fanned `items`, `scan_store.rs:1421` + `ScanDesk.jsx:784`) show the new ones.
5. Downstream: `facetSignature(row)` (`market/src/scan-pricing.js:37-45`) is computed from those stale fields, so the second view asks for comps with the wrong condition/language and writes the resulting price onto a row whose facets are the new ones (`ScanDesk.jsx:1308-1315`) — and with finding 3's dead guard, that write is unconditional.
6. It also breaks the row-store CAS: `applyItems` only replaces a row with a **lower** `seq` (`market/src/scan-model.js:41-51`), so a fanned row delivered at seq 6 against an in-store row at seq 13 is silently dropped.

**Why the code allows it:** the fan reuses the row's own counter instead of the batch's monotonic `item_seq`, and the batch's `item_seq` is used as the stream cursor even though row `seq`s are not guaranteed to track it. One of the two must be the single source of truth; today neither is. The discarded `bump_batch` result at `:1406` is the tell.

**Evidence:** *confirmed by reading* `scan_store.rs:1406` (`let _ = bump_batch(...)`, result thrown away), `:1410` (`seq = seq + 1` inside the fan `update`), `:743-753` (`items_after` `seq > cursor`), `:800-819`, `scan_connect.rs:1146-1147`, `routes/scan.rs:361-372` + `:394-417`, `scan-model.js:41-51`. *Suspected, not confirmed:* the field parity of the fan is *also* worth noting as intentional — `BATCH_ROW_FIELDS` (`market/src/scan-artwork-versions.js:50`) lists exactly the same 7 fields, and pricing is deliberately not fanned — so the fan itself is correct, only its sequencing is not.

**Does it explain a symptom above?** Directly, no. It is the mechanism behind "the desk shows one thing and prices another", and it makes findings 3, 5 and 7 hit more rows.

**Fix sketch:** use the bumped value: `let (seq, _) = bump_batch(...).await?;` and fan with `set …, seq = $n` (one parameter, same for all fanned rows) — matching what `patch_item` (`:1478`) and `set_status` (`:1514-1520`) already do. Alternatively make `items_after`'s cursor a per-row watermark, but the one-line fan fix is enough.

**Regression test (server, flow-db tier):** `pokoin-rust/crates/external/tests/scan_rows_flow.rs::the_defaults_fan_keeps_every_row_ahead_of_the_stream_cursor` — build a batch with two rows at different seqs (patch one after the other), call `set_defaults({condition:'LP'})`, then assert `items_after(cursor = batch.item_seq_before)` returns **both** rows with `condition='LP'` and that `max(items.seq) == batch.item_seq`. The existing `a_removed_row_comes_back_newer_than_the_one_on_screen` (`:22`) covers `set_status`, which is already correct.

---

## 9. Post-submit pricing is a one-shot browser call; if it does not happen, listings stay `paused` at 0 and only a group with `auto_daily` heals them

**Severity:** stuck row / wrong listing (stock created but never on sale, with no server-side trace).

**Interleaving**

1. With batch pricing, unpriced rows are listed `paused` at 0 PKN on purpose: `let status = if rules::row_priced(&entry.row) { "active" } else { "paused" }` (`scan_store.rs:1975`, comment `:1971-1974`), and the row is exempted from the `no_price` gate by `submit_problem(row, intent, !row_pricing(row).is_null())` (`:1791`, `scan_connect.rs:1031-1058`).
2. The **only** thing that then prices them is the desktop: `pricingApplyBodies(data.result)` and a sequential loop `for (const body of pricingBodies) { answers.push(await applyPricing(body, await token())) }` — `ScanDesk.jsx:1446-1461`.
3. Any of: the seller closes the tab or navigates after the submit succeeded; one request errors (caught at `:1454-1456` and reduced to a note, `:1461`); `applyPricing` has no timeout, no abort and no idempotency key (`market/src/api.js:3337-3343`) so a hung request just never completes — leaves those listings `paused` at 0.
4. No server job picks them up: `pricing_groups::run_daily` iterates `daily_groups`, which is `select seller_uid, id from seller_pricing_groups where auto_daily` (`pokoin-rust/crates/external/src/pricing_store.rs:222-229`, used by `crates/commerce/src/handlers/pricer.rs:498-511`). A group with `auto_daily = false` is never re-priced. A **strategy**-priced batch never joins a group at all (`scan_store.rs:2007-2017` filters on `groupId` only), so nothing scheduled covers it. The only catch-all is the operator CLI `job price-unpriced-listings --seller=… --apply` (`apps/api/src/jobs/unpriced.rs:1-17`, `UNPRICED_SQL`/`ACTIVATE_SQL`), which is manual and per-seller.
5. The desk forgets: `rememberActiveSession('')` runs at `:1463`, and the batch is `submitted`, so reopening shows the done state, not a "these N listings still have no price" action.

**Why the code allows it:** the pricing decision is split — the server knows the group/strategy and creates the listings, but the *apply* call is left to the client as a follow-up with no outbox, no retry and no "pending pricing" state on the batch. The `result.rowPricing` echo (`scan_store.rs:2019-2032`) is precisely the data a server-side job would need, and it is only ever read by a browser.

**Evidence:** *confirmed by reading* `ScanDesk.jsx:1444-1462` (comment "the submit stands whatever happens here"), `market/src/api.js:3337-3343`, `scan_store.rs:1971-1975`, `:2007-2017`, `:2019-2032`, `pricing_store.rs:222-229`, `pricer.rs:498-511`, `jobs/unpriced.rs` (manual `--seller` CLI, dry-run by default). *Suspected, not confirmed:* that `push_and_link`'s own retry semantics could duplicate a CardTrader product in this scenario — `push_created_to_cardtrader` runs once, after the commit (`scan_store.rs:2079-2093`), and its result is persisted by a **separate non-transactional** `update … set submit_result` whose failure is only logged (`:2082-2089`), so a later `alreadySubmitted` replay (`:1749-1756`) can return a `submit_result` without the `cardtrader` block even though products were created. I did not trace `push::push_and_link` itself, so the duplication risk is stated as suspected only.

**Does it explain a symptom above?** Not the reported empty price boxes (that is pre-submit), but it is the same class of failure one step later and would be the next complaint after a successful add.

**Fix sketch:** price inside submit — phase 3 already holds the group/strategy and the created listing ids, so call the same `apply_group`/strategy path there (or write a `scan_pending_pricing` outbox row consumed by a job), and make the desk's call an optimisation rather than the mechanism. Independently: `auto_daily` should not be the only server-side heal, so include scan-created `paused`-at-0 listings in a scheduled pass.

**Regression test (server, flow-db tier):** `pokoin-rust/crates/external/tests/scan_batch_pricing_flow.rs::an_unpriced_row_is_listed_paused_and_joins_the_batch_group` (`:78`) already pins the paused-at-0 creation; extend it (or add `paused_scan_listings_are_priced_without_the_desk`) to assert that after `submit_batch` returns, a `paused` at 0 listing in the group is priced by a server-side path alone — i.e. with no `applyPricing` call — and, for the strategy case, that `rowPricing` in `submit_result` is enough to identify every listing still needing a price.

---

## 10. A partly-failed remove leaves the removed rows with no undo entry and no toast

**Severity:** data loss (small, but unrecoverable by the seller's own controls).

**Interleaving**

1. `removeRows(ids)` removes **sequentially** with a single `try` around the loop: `for (const id of ids) await runApi(t => scanApi.remove(t, id, batch()?.id))` — `ScanDesk.jsx:889-893`.
2. Row 3 of 5 fails (a 409 `batch_closed` because the phone's submit landed, or `wrong_status` because the row was already submitted — `scan_store.rs:1350-1355`, `:1508-1512`).
3. `catch` sets the error and **returns** before the `undoStack.push` (`:898-902`) and before `pushToast` with the "Undo" action (`:903-907`).
4. Rows 1-2 are removed on the server with no undo affordance anywhere in the UI, and Ctrl+Z cannot help because nothing was pushed.

**Why the code allows it:** the undo record is built after the whole batch of writes instead of being pushed as each write succeeds, and a mid-loop failure discards the record of the writes that already landed. `set_status` is per-row and idempotent (`from`/`to` compare-and-set), so a partial removal is a normal outcome the caller does not model.

**Evidence:** *confirmed by reading* `ScanDesk.jsx:889-908`, `scan-api.js:79-80` (`remove`/`restore` per item), `scan_store.rs:1498-1526` (per-row CAS status write, so the first rows really did commit).

**Does it explain a symptom above?** No.

**Fix sketch:** push the undo entry (and the toast) **before** the loop, then remove rows and collect the ids that failed; or use a single batched `action=remove` with an id array so it is one transaction. On failure, keep the toast for what was actually removed.

**Regression test (client, JS tier):** `solid/src/pages/scan-desk/duplicates.test.js` is the natural neighbour; better, extract the loop into a pure `removeRowsWithUndo(ids, removeOne, pushUndo, toast)` helper and test `a_partial_remove_still_offers_undo_for_the_rows_it_removed`: `removeOne` succeeds twice then rejects, assert `pushUndo` was called with exactly the two removed ids and the toast ran.

---

## 11. Background save failures are reported with the human-facing "Change not saved." banner

**Severity:** cosmetic, but it makes the desk look broken and hides the real message.

**Interleaving**

1. The prices effect saves silently with `{record:false}` (`ScanDesk.jsx:1315`, `:1343`) — no user gesture, no undo entry.
2. `patchRows`'s `catch` calls `setError(err.message || 'Change not saved.')` (`:690-692`) — the same red banner used for the seller's own edits.
3. A suggestion saved after the batch closed (409 `batch_closed`, `scan_store.rs:1350-1355`) or after the row was removed (409 `not_active`, `:1453-1455`) therefore shows the seller a scary banner about a change they never made, while the *real* problem (this row was never priced) is silent, per finding 6.
4. `patchRows` returns `false` in that `catch` (`:693`), which is what `saved(...)` uses to retry (`:1268-1270`) — so the retry bookkeeping and the banner disagree about who is responsible.

**Why the code allows it:** `patchRows` has one error surface for user edits and machine writes; the `record: false` flag suppresses the undo entry but not the banner.

**Evidence:** *confirmed by reading* `ScanDesk.jsx:613-700` (`:619` early return `undefined` for a non-active row, `:686-693`), `:1268-1270`, `scan_store.rs:1453`, `:1350-1355`. Note the corollary at `:619`: when a row is no longer `active`, `patchRows` returns `undefined` — neither `true` nor `false` — so `saved(...)` does **not** retry it and the row stays claimed in `pricesAsked` (finding 6's permanent strand) with no message at all.

**Does it explain a symptom above?** No; it is noise on the way to one.

**Fix sketch:** give background saves a quiet channel (`patchRows(ids, changes, { background: true })` → a counter/notification instead of `setError`), and make `patchRows` return `false` (not `undefined`) when it declines to write, so callers can release the row.

**Regression test (client, JS tier):** with the helper extracted (finding 17), `solid/src/pages/scan-desk/price-requests.test.js::a_declined_patch_reports_false_so_the_row_is_released` — call the save helper for a row whose status is `submitted` and assert the return is `false` and that the row is no longer in `pricesAsked` after the run.

---

## 12. `submitKey` is inert on both ends

**Severity:** cosmetic today, but it is the guard the design says exists.

**Interleaving / evidence**

1. The desk mints one key per mount (`ScanDesk.jsx:171`, `newSubmitKey()` from `market/src/scan-model.js:468-471`) and re-mints only in `newBatch()` (`:1482`); every submit — including a retry after a timeout — sends the **same** key (`:1437`).
2. `mutate_batch` reads it (`scan_store.rs:2225`), `submit_batch` only cleans it (`:1744`) and stores it (`:2060`). There is **no lookup by `submit_key`**: the replay guard is `batch.status === 'submitted'` (`:1749-1756`, and again in phase 3 at `:1951-1957`).
3. So the idempotency actually comes from the batch status, which is per-batch rather than per-attempt. That happens to be sufficient for a double click and for two desktops on one batch, but it cannot distinguish "same attempt retried" from "a second, deliberate add of a re-opened batch" — and the field suggests a protection that does not exist.

**Why the code allows it:** the port kept the wire field and the column but not the lookup; nothing tests that a replayed attempt is deduped by key.

*Confirmed by reading* all lines above. **Does it explain a symptom above?** No.

**Fix sketch:** either use it (`select submit_result from scan_batches where id=$1 and submit_key=$2` before doing work, plus a per-attempt key minted inside `submit()` and retired after success) or delete the field and document that status is the guard.

**Regression test (server, flow-db tier):** `pokoin-rust/crates/external/tests/scan_batch_pricing_flow.rs::a_replayed_submit_attempt_creates_no_second_listing` — submit, then submit again with a *different* `submitKey` after re-opening the batch (`update scan_batches set status='open'` in the fixture), and assert one listing per `source_listing_id` (`'scan:' || item_id`) and no `seq` jump for the already-`submitted` rows.

---

## 13. Smaller ordering defects in the same window

* **`lastSuggested` is recorded before the write is known to have landed** (`ScanDesk.jsx:1311`, `:1341` precede `:1315`/`:1343`). A rejected suggestion therefore still becomes "the default price" that `restoreDefaultPrice` writes back on an emptied blur (`:599-601`). Severity: wrong price shown. *Confirmed by reading.* Fix: set it in the `saved(...)` continuation.
* **`versionSetCache` stores a Promise and then replaces it with the payload** (`solid/src/pages/scan-desk/version-sets.js:26` then `:15`). `patchRows` reads `versionSetCache.get(nextId)` and expects `.printings` (`ScanDesk.jsx:627-630`), so during the in-flight window the nationality lookup is `undefined` and it silently falls back to `cand?.nationality || targets[0].nationality` (`:631-633`) — a printing switch can write the previous row's nationality, which is what feeds `listing_language` on the phone path and the language on the listing. Severity: wrong listing (suspected impact, *confirmed* code shape). Fix: store one shape (a promise) and make every reader `await` it, or expose a `syncCacheEntry()` that returns `null` while pending.
* **A failed post-submit snapshot read is reported as a failed submit** (`ScanDesk.jsx:1464` sits inside the same `try` as the submit; its failure falls into `:1467-1475` and sets "Could not add to inventory." even though the batch is `submitted`). The rows then look un-submitted until the stream catches up; pressing Add again is healed by `alreadySubmitted` (`scan_store.rs:1749`). Severity: cosmetic-to-confusing, and it is the reason a seller hand-retries an upload that already worked. *Confirmed by reading.* Fix: move the snapshot read into its own `try`, or treat `code === 'batch_closed'` on retry as success.
* **`props.preview` early-returns from `setDefaults` *after* the optimistic writes** (`ScanDesk.jsx:764-780`): the batch defaults are painted and the localStorage stop-positions recorded (`:756-762`) but nothing is fanned onto rows, so preview rows diverge from the defaults the panel shows. Severity: cosmetic. *Confirmed by reading.*

---

## Async sources in this area (exhaustive list of what I found)

**Client**

1. Prices `watch` effect — deps `[list(), closed(), submitIntent(), priceRetry()]` (`ScanDesk.jsx:1251`); owns `fetchCardSales` slice fan-out (4 in flight, `:1291-1293`), `fetchCheapestPricePknMap` (`:1324`), per-row `patchRows` (`:1315`, `:1343`), and a cancel-on-redeploy cleanup (`:1349-1352`).
2. `priceRetryTimer` `setTimeout` backoff (`:587-590`) driving `setPriceRetry`, i.e. a timer that re-triggers source 1.
3. `patchRows`: optimistic `pending` overlay + `createPatchChain()` per-row serialisation + `finally` overlay drop (`:620`, `:686-700`, `market/src/scan-model.js:478-489`); its `record` undo/redo stacks (`:660-668`).
4. `setDefaults`: awaited `fetchSellerBoxSlots` (`:730`), optimistic `setBatch` (`:764`), fan overlay token `defaults-${Date.now()}` (`:770-777`), unsequenced response spread (`:783`), non-rolling `catch` (`:785-786`).
5. `location` debounce in the defaults bar — `setTimeout(…, 700)` (`solid/src/pages/scan-desk/bars.jsx:107`) plus the `commitLocation`/`commitStack`/`commitPos`/`commitSize` writers (`:90`, `:101`, `:118-139`).
6. SSE change stream (`market/src/scan-stream.js`, consumed at `ScanDesk.jsx` `dispatch`) — `hello|items|batch|session|bye`, 55 s server lifetime (`pokoin-rust/crates/external/src/routes/scan.rs:380`, `:394-397`), `backoffMs` reconnect, cursor advanced only on `items` frames (`scan-stream.js:57-59`) → `applyItems` seq CAS (`scan-model.js:41-51`).
7. Server-side stream poll loop: a 1 s timer per connected desk (`routes/scan.rs:386-433`) calling `items_after`, `batch_for_stream`, `latest_session` on separate pool connections.
8. `submit()`: `token()` → `scanApi.submit` → sequential `applyPricing` loop → `scanApi.batch` snapshot read (`ScanDesk.jsx:1436-1466`), guarded only by `submitting()` (`:1423`, `:1432`).
9. `removeRows`/`duplicate`/`unmerge`/`undo`/`redo` sequential awaits (`:889-908`, `:910+`, `:801+`); the unmerge toast's own Undo button (`:1842`).
10. `commitDraft` manual add (`:996-1034`) → `scanApi.add`, plus the `qtyBuffer` type-ahead debounce (`:152`, `:1196-1204`) that writes `quantity` per keystroke batch.
11. `InventoryTargets`: async `fetchCardTraderStatus` with a `cancelled` flag and a `touched` guard, seeded from `readCachedCardTraderStatus` localStorage; `targets` is a local signal read at submit time via `onSubmit` (`ScanDesk.jsx:1696-1708`, `solid/src/components/desk/InventoryTargets.jsx`).
12. `loadVersionSet` promise cache and the `fetchPricingStrategies` load (`loadPricing()` at `:1484`, `version-sets.js:7-28`) — both feed values into submit-time patches.
13. `now()` 1 s tick, `serverOffset`, the session/pairing refresh, `rememberActiveSession` / `loadStoppedPositions` localStorage reads and writes (`market/src/scan-api.js:101-108`, `version-sets.js:36-49`).
14. Keyboard shortcuts (`ScanDesk.jsx:1233-1247` → `handleCommand`, incl. `submit` at `:1226-1228`) and the confirm dialog (`:1849-1862`) — a second path into the same `submit()`.

**Server (each `await` between a read and its dependent write)**

15. `submit_batch`: row snapshot (`scan_store.rs:1760`) → per-row `scan_listing_location` awaited on a *different* pool connection mid-loop (`:1839`, `:2150-2176`) → listing upsert (`:1840-1883`) → commit (`:1933`) → ownership loop (`:1937-1947`) → tx #3 re-lock (`:1950-1968`) → activate + `status='submitted'` from the stale rows (`:1970-2004`) → group membership (`:2007-2017`) → `rowPricing`/`created_rows` (`:2019-2057`) → batch `submitted` + sessions ended + commit (`:2058-2076`) → CardTrader push (`:2079-2080`) → non-transactional `submit_result` rewrite (`:2082-2089`).
16. `ingest_scan`: session/batch status read (`:1020`) → batch lock without a status re-check (`:1024`) → insert/commit (`:1127`, `:1218`); defaults chosen from `defaults_history` by the phone's capture timestamp (`:1033-1035`).
17. `set_defaults`: batch lock → merged defaults → single `bump_batch` whose result is discarded + per-row `seq = seq + 1` fan (`:1360-1421`).
18. `patch_item`: `lock_item` (row **and** batch) → guard → `bump_batch` → update → commit (`:1449-1493`).
19. `set_status` / `duplicate_item` / `unmerge_item` / `add_manual` / `discard_batch`: each lock-then-write with a status guard (`:1498-1625`, `:1627-1675`).
20. The pricing apply path the desk calls after submit: `handlers::pricer.rs::apply_group`/`apply_post` (`:71-220`, `:643`) and `daily_groups` (`pricing_store.rs:222-229`), plus the manual `job price-unpriced-listings` (`apps/api/src/jobs/unpriced.rs`).

---

## What I could not determine

* **No repro or logs.** Which of findings 5, 6, 3 and 7 the owner actually hit is inferred from code shape, not measured. A perf/stream trace (`window.__pokoinScanPerf`, `version-sets.js:63-77`, and `docs/SCAN_PERFORMANCE.md`) on a real session with two no-comp rows would settle whether the fallback pass ever completed.
* **Whether the two reported rows had a batch pricing choice at all.** "Pricing = Suggested prices" is the empty option (`bars.jsx:388`), which means *no* group and *no* strategy — so their price had to come from the inline suggestion effect, not from `applyPricing`. If the batch in fact named a group, the empty box is expected behaviour (the row is priced at submit, `priceOnLoad` placeholder "on load", `ScanDesk.jsx:1788`, `rows.jsx:223`, `:451-453`) and the symptom is a wording problem, not a bug.
* **`specs/tla/` findings.** `specs/tla/FINDINGS.md` and `specs/tla/price-ownership/README.md` discuss price ownership and reference the retired Node behaviour. I did **not** use them as evidence for anything above, and did not check whether their findings still apply to the Rust port.
* **`push::push_and_link` internals** (`scan_store.rs:2128-2130`) — needed only for the CardTrader-duplication note in finding 9, marked suspected.
* **The confirm dialog's click-outside / Esc semantics.** `.scan-modal` is rendered without a backdrop handler (`ScanDesk.jsx:1849-1862`, unlike `HelpOverlay` which takes `onClose`), so intent or targets could in principle change under the open dialog; I could not confirm the CSS blocks pointer events, so I raise no finding on it.
* **Test tier caveat, stated plainly:** `docs/CI.md` documents **only the Rust tiers** (Fast check `scripts/check-fast`, GitHub `rust-gate` with `changes`/`test`/`changed`, the informational `flow-db`, and the release gate). It says nothing about JavaScript. The JS tiers below come from the package scripts: `npm --prefix solid test` → `node --test "src/**/*.test.js"` (`solid/package.json:9`) and `npm --prefix market test` → `node --test src/*.test.js` (`market/package.json:7`). Per `docs/CI.md`, `flow-db` is `continue-on-error` and the `*_flow` binaries self-skip without `POKOIN_TEST_DATABASE_URL`, so **the Rust tests I recommend for findings 1, 2, 3, 8, 9 and 12 are not gating checks** — the only gating Rust tier available to them is `cargo test -p pokoin-external` (used above for finding 7's `normalize_defaults` unit test, which needs no database). The JS tests named above are not run by `rust-gate` at all.

## Commits I believe produced the price-box behaviour

1. **`21ba8cef` (2026-10-08) — "feat(rust): integrate accounts, commerce, external and catalog-routes crates into pokoin-api".** The regression: `mutate_batch` reads `onlyIfEmptyPrice` from the top level (`scan_store.rs:2217`) where the retired Node read it from inside `patch` (`git show 001b4783^:server/pokoin-api/_scan_store.js`, `patchItem`), and the Solid desk still sends it nested (`ScanDesk.jsx:1313`, `:1342`, `market/src/scan-api.js:77`). The CAS has been dead for every desk write since this commit. **Primary cause of symptom 2.**
2. **`99ba5eaa` (2026-11-01) — "keep price suggestions alive when a run is cancelled"** created `solid/src/pages/scan-desk/price-requests.js` (`claimRows` / `releaseUnsettled`) and wired the `settled` set into the effect (`ScanDesk.jsx:1264-1277`, `:1314`). **`4629f1bc` (2026-11-13) — "a failed price lookup or save is retried, not taken for 'no price'"** then added `PRICE_RETRY_MAX` / `nextPriceRetry` / `retryPrices` (`price-requests.js:38-57`, `ScanDesk.jsx:581-591`) and the `{strict:true}` cheapest-listed read. Between them they fixed the "row stayed at Needs a price and blocked the upload" case their messages name, and left two others open: the give-up path keeps the claim forever (finding 6), and `settled` / `lastSuggested` are recorded before the save lands (findings 5, 13). `restoreDefaultPrice` and `lastSuggested` (`:594-611`) are older than both — they arrived with the Solid port `9101a2d4`, and before that in the React desk.
3. **`19fafa88` (2026-11-13, 18:31) — "no comps and no listing default the row to 10,000 EUR in PKN"** put the fallback at `ScanDesk.jsx:1338` (`const pkn = listed > 0 ? listed : scanFallbackPricePkn();`). **24 minutes later `4629f1bc` (18:55) inserted `if (!byId) { failed.push(row); continue; }` in front of it** — see `git show 4629f1bc -- solid/src/pages/ScanDesk.jsx`, where `const byId = await fetchCheapestPricePknMap([...cheapestIds])` becomes `let byId = null` + `{strict:true}` + the new skip. From that commit on, a failed cheapest-listed request means the €10,000 fallback **never runs once** for the rows that need it: they go to four retries and then to finding 6's permanent strand. This is the most likely origin of symptom 1's "2 need a price".
4. **`513688ed` (2026-11-13) — label-only:** renamed the empty pricing choice to "Suggested prices" (`bars.jsx:388`). Not a cause; it identifies the control the owner is describing in symptom 1.
5. **`6f01ed58` (2026-11-15) — "Stop effect callbacks from returning their last expression" (`solid/src/pages/scan-desk/watch.js`).** Behaviour-neutral for the prices effect (it already returned `undefined` or a cleanup), but it is the most recent commit that touched this exact effect's re-run semantics, so it is worth ruling out explicitly rather than leaving the reader to suspect it.

For symptom 3 ("a Batch default cannot be switched off") the blame is **architectural, not a single commit**: the unsequenced `setDefaults` response spread (`ScanDesk.jsx:783`) and its non-rolling `catch` (`:785-786`) have existed since the Solid port `9101a2d4` (2026-10-11), and the `pick`/`clamp_int` "empty means keep the current value" fallback came over from Node in `21ba8cef` (`scan_connect.rs:190-213`).
