# PH-05 — the search popup shows the first word's results for a two-word query

Run **PH-R019** · Change **PH-C012** · Refs **PH-05** · Lead **PH** · measured 2026-11-18
Read-only analysis: no code changed, nothing built. Every `file:line` below was opened and
read in this worktree (`typeahead-analysis`, from `origin/main`).

## 0. The symptom and the trace being explained

Owner (production, 2026-11-18):

| typed | popup rows | "View all" |
| --- | --- | --- |
| `dark jolteo` | Dark Jolteon (Team Rocket 38/82), Jolteon and Joltik of Dark Explorers | 215 |
| `dark jolteon` | Dark Jolteon, Dark Jolteon Lv.23 (Rocket Gang, JP), **then only Darkrai cards** | **1,909** |

Lead's request order (relative ms, typing `dark jolteon` in the header popup):

| t | request | answer |
| --- | --- | --- |
| 9056–9083 | `suggest?q=dark&limit=50&hydrate=1&progressive=1&format=c1` | 50 groups, `count` 2002 |
| 9086–9222 | `suggest?q=dark&limit=100&offset=50` | — |
| 9179–9397 | `search-page?query=dark&limit=96` | — |
| 9179–9435 | `search-page?query=dark+jolteon&limit=96` | — |
| 9223–9377 | `suggest?q=dark&limit=100&offset=150,250,350,450,550,650` | — |
| 9378–9415 | `suggest?q=dark+jolteon&limit=50&hydrate=1&progressive=1` | **`count` 5, 5 printings** |

Direct probes: `suggest?q=dark jolteon` → 5 · `suggest?q=dark jolteo` → 12 · `suggest?q=dark` →
2002 · `search-page?query=dark&limit=1&productType=card` → 2002 ·
`search-page?query=dark+jolteon&limit=1&productType=card` → **5** ·
`…&productType=cards` → **0** (also for `query=dark`) ·
`search-page?query=red+hair+charizard&…` → **274**.

The rows and the number are **two different defects with two different causes**, and the
request ordering is not the cause of either: replaying the trace strictly serially reproduces
the reported popup exactly (§2.D).

---

## 1. The asynchronous sources of the popup

`solid/src/components/SearchBox.jsx` (1 195 lines) is the only orchestrator. The engine
(ranker + name catalog) is one lazy chunk loaded on search intent
(`SearchBox.jsx:68-85`, `:99-102`; `solid/src/lib/suggest-engine.js:1-11` — *"Nothing here
starts rank workers: the header ranks on the main thread (`paintCatalogGroups`), and ScanDesk
spawns its workers on demand"*). The worker path is real but belongs to another surface:
`market/src/suggest-rank-runtime.js:18-36` (`warmupSuggestRankWorkers`) and `:41`
(`rankChunkOnWorker`) are reached only through `solid/src/lib/live-suggest.js:12`, `:76` — used by
`solid/src/pages/scan-desk/rows.jsx:31`, never imported by `SearchBox.jsx`. So the popup has no
worker hand-off, no second ranking thread and no post-message ordering to race over (D000026).

### 1.A Requests

| # | request | fired from | abort / generation guard | writes |
| --- | --- | --- | --- | --- |
| R1 | `GET /api/marketplace-suggest?q&offset&limit&hydrate=1&progressive=1&search_language&format=c1` — progressive chunk stream: 50, then 100s, ≤ 8 chunks, ≤ 2000 rows (`market/src/suggest-pool.js:32-38`, `chunkSize` `:40-42`) | pool effect `SearchBox.jsx:511-572` → `pageUniverse` `:192-220` → page memo `:88` → `market/src/api.js:470-498` | generation `:548` (`pool.generation === generation`, clock `:523`) + `AbortController` `:533` aborted in cleanup `:566-570`; `alive()` re-checked before *and* between pages `:194`, `:199`, `:204` | `rememberSuggestGroups` `:205` → global store; `onPage` `:549-554` → **`setHitCount(page.count)`** `:552` + repaint gate → `setEpoch`; `setProgressivePending` `:541`, `:560-564`; `pool.transferred` `:550` |
| R2 | `…/api/marketplace-suggest?...&hydrate=1&limit=1000`, one page per **catalog target** (artist / expansion) | `hydrateTarget` `:250-265` → `api.js:1461` (`fetchArtist`, `limit: 80`), `api.js:2074` (`fetchExpansionCards`) | **none**: no `signal` argument at the call sites; only the effect-wide abort of the *catalog* effect can stop it | `rememberPrintings(target.key, cards)` `:252` + `rememberSuggestGroups(groupsFromCards)` `:253` → store; then `setLiveTick` `:634` |
| R3 | `…/api/marketplace-card-versions?query&limit&productType=card&search_language` — every printing of one **name** (`prefix-name:` target) | `hydrateTarget` `:258` → `api.js:461-467` (`createNamePrintingsFetcher`, `market/src/name-printings.js:2` limit **1000**) | **no signal is passed at all** (`api.js:465`) | `rememberPrintings` `:252` (`remember: false` → no `rememberSuggestGroups`); `setLiveTick` `:634` |
| R4 | `…/api/marketplace-suggest?q&limit=20` — **satellite** universe (sealed / accessory), non-Pokémon games | `:601-626` (only when `!isPokemon`) | `AbortController` `:601` aborted in cleanup `:623-626` + `controller.signal.aborted` re-checks `:610`, `:620`; **no generation / term re-check** | `setOtherGroups` `:611`, **`setHitCount`** `:612`, `setActiveIndex(-1)` `:613`, `prefetchSearchPage` `:614` |
| R5 | `GET /api/marketplace-search-page?query&limit=48&offset&includeFacets=0&lang&search_language[&productType=card\|productSearchOnly=1]` — the **count** | count effect `:667-685` → `market/src/search-hot.js:37-89` → `api.js:354-389` (`searchFetchOptions`, `market/src/search-kind.js:53-64`) | `cancelled` flag + `clearTimeout` only `:669-684`; **no signal → never aborted** | **`setHitCount`** `:676` *only when `total > 0`* `:674`; `countedQuery = text` `:675`; hot-cache `row.count` `search-hot.js:68` |
| R6 | the **recall union**: one R5 per lookup in parallel — the two `search-page` requests at t=9179 | `market/src/search-recall-core.js:80-101` (`start`), reached via `fetchSearchRecall` (`market/src/search-recall.js:35-42`) | generation head-check only (`market/src/search-warmup.js:107`); everything after an `await` in that module is unguarded; session key omits `printLang` (`search-recall-core.js:130-133`) | recall session rows/offsets/totals; `...session.base` payload fields of the **first** lookup `:143` |
| R7 | `…/api/marketplace-suggest?q&limit=20\|12&progressive=1&hydrate=1` — the universe **warmup** | `search-warmup.js:53-125` (`WARM_SEED 'p'` `:9`, 45 s dedupe `:83-85`, previous warmup aborted `:86`) from `SearchBox.jsx:494-501` | generation `:89`, `:107`; abort `:86-88` | `rememberSuggestGroups` `:108` → store; `prefetchSearchPage(typed, …)` `:115-121` → hot cache |
| R8 | Users tab, **two** calls in one `Promise.all` — `GET /api/marketplace-listings?sellerUsername&nativeOnly=1&limit=20` (`api.js:3162-3187`, served from `peekSellerListings` when warm) and `GET /api/marketplace-associate-suggest?q` (`api.js:3199`) | `:641-660` → `api.js:3206` (`fetchSellerSearchWithAssociates`, `signal` is a parameter but the popup never passes one) | 160 ms timer + `cancelled` flag `:646-659`; no abort, so both requests always complete | `setSellerHits` `:650`, `:653` (+ the seller-listings module cache `api.js:3183`) |
| R9 | another R5 for the Enter / View-all hand-off | `goSearch` `:860-867` → `prefetchSearchPage` `:865` | joins an in-flight row (`search-hot.js:51-53`) | hot cache, read back by `fillWhole` `:447` |
| R10 | `warmupCard(card)` + `handOffCard(card)` when a row is picked | `pick` `:869-881` (`:878-879`) | none (fire and forget) | card-page cache, not popup state |
| R11 | the **idle** warmup: `suggest?q=m&limit=4` and `GET /api/searchbar-token-predict?warmup=1&limit=1&search_language=` | `api.js:512-546` (`:530`, `:540`), called from `solid/src/pages/Home.jsx:304` after the rails paint, 5-min TTL, `engine: false` | idle callback + TTL | with `engine: false` **nothing** in the popup; token-predict is a separate endpoint (`pokoin-rust/crates/search-api/src/lookup/token_predict.rs:25`, route `lookup/mod.rs:25`) and the suggest handler never reads a token cache — per-keystroke continuation prediction is not part of this popup |

There is **no** batch-tiles or batch-price call behind the popup: thumbs are plain `<img>`
warms (`market/src/suggest-images.js:89`, 128-entry cache `:7`, 4 in flight `:8`/`:44`,
`SUGGEST_THUMB_EAGER` 8 `:9`), the hover panel swaps to a leftover-scan src
(`market/src/suggest-hover.js`), and artwork shades come from local OKLCH buckets
(`market/src/art-shade.js`, subscription at `SearchBox.jsx:464`).

**R12 — the landing page's "Popular" chips feed the very same caches before the visitor types
a character.** `solid/src/landing/island.jsx:99-101` (`pointerenter` / `focus` / `touchstart`, each
`once`) → `LandingSearch.jsx:17-19 warmPopular` → the exported `prewarmSuggest`
(`SearchBox.jsx:315-347`), which runs `catalogTargets`/`hydrateTarget` (`:327`, i.e. R2/R3 with
**no signal and no generation**) plus `prefetchSearchPage` (`:328`, hot row under
`lang\0print\0singles\0q`, `:318`) and, with `thumbs`, a second `paintCatalogGroups` pass
(`:338-345`). So a hovered chip's printings are in `byCompact`, and its search-page `count` is in
the hot cache, while the query in the box is something else entirely — a second way A2's
query-agnostic pool gets filled (§2.A2, §6.8).

### 1.B Timers

| timer | where | writes |
| --- | --- | --- |
| `afterPaint` = rAF → `setTimeout(…, 0)` | `SearchBox.jsx:124-127`; `solid/src/lib/yield-nav.js:19` for navigation | every deferred write below |
| engine load on intent (pointerdown / focus / first key) | `:99-102`, `:388-390` | `setEngine` |
| localized-name chunk | `:112-118`, `:503-505` | `setNamesTick` |
| `commitTerm` — `term` trails `query` by one paint | `:454-462` | `setTerm`, `setActiveIndex(-1)` |
| `rankPrint` — trails the print chip by one paint | `:468-479` | `setRankPrint` |
| repaint gate, **300 ms** trailing (`SUGGEST_REPAINT_MS`) | `:537-540`, `market/src/suggest-repaint.js:2`, `:11-49` | `setEpoch` |
| 120 ms satellite delay | `:602`, `:622` | `setOtherPending` `:603`/`:620`, R4 |
| 160 ms users delay | `:647`, `:655` | `setSellerHits` |
| **150 ms count delay** (`RESULTS_COUNT_DELAY_MS` `:90`) | `:670`, `:680` | R5 → `setHitCount` |
| 800 ms idle timeout / `setTimeout(run, 0)` fallback (warmup) | `api.js:543-547` | R11 |
| cache expiries (no timer): page memo 60 s, hot page 60 s, live store 30 min, warmup dedupe 45 s | `suggest-page-memo.js:16`, `search-hot.js:14`, `suggest-live.js:54`, `search-warmup.js:10` | — |

### 1.C Caches and stored pools

- **`byCompact` — the one shared stored pool.** `market/src/suggest-live.js:54-56`: 30-minute
  TTL, `MAX_NAMES` 2500, pruned by TTL/size only (`:78-88`). Key is **`compactQuery(group.name)`
  and nothing else** (`rememberSuggestGroups` `:90-119`) — no query, no tab, no print chip, no
  search language; the fetch language is stamped onto each row instead (`:92`, `:100-103`) and
  rows are merged field-wise so an empty hydration cannot erase a known identity
  (`mergePrintingFields`, `market/src/print-bucket.js:125-140`). `resetSuggestLive` exists
  (`:58-60`) but has **no production caller**, and `onFocus` only opens the popup
  (`:929-932`) — so one visitor's 2 002 `dark` printings sit in the pool for half an hour and
  are scored against every later query.
- **Page memo for suggest pages** — `market/src/suggest-page-memo.js:33-56`; key =
  `q\0JSON(sorted options minus signal)` (`:19-27`), TTL 60 s, LRU 400. **Only finished answers
  are stored** (`:9-11`, `:47-51`): a page still in flight is not shared, so a new keystroke
  starts its own duplicate request that the previous one cannot feed.
- **Hot search-page cache** — `market/src/search-hot.js`: TTL 60 s (`:14`), key
  `lang\0tab\0printLang\0query` (`:17-19`) with `printLang` taken **raw** while the request
  never sends it (`api.js:378-382`); in-flight join (`:51-53`); `row.count = Number(data?.total) || 0`
  (`:68`) — an absent/`null` total is cached as **0**; a rejection deletes the row (`:76-79`)
  but an **abort leaves `count: 0` behind** (`:73-75`); `resetHotSearchPage` (`:21-23`) has no
  production caller either.
- **Recall session** — `market/src/search-recall-core.js:46-69`: deduped union rows, per-lookup
  offsets/totals/`more`, 120 s, 8 sessions, one queued request at a time per key (`:136`).
  Key `:130-133` = `[query, lang, productType, productSearchOnly, typeof head==='function']` —
  no `printLang`, no generation.
- **Warmup state** — `search-warmup.js`: module-level `lastKey`/`lastAt` 45 s dedupe (`:81-85`),
  one module-wide `controller` (`:86-88`) and `generation` (`:89`), plus `resetSearchWarmupForTests`
  (`:39-45`, tests only). `redisSuggestWarmKey` (`:33-37`) builds a `pokoin:search:v1:suggest:…`
  Redis key in the client and has **no production caller**; nothing in `pokoin-rust` produces that
  prefix (grep: no match) and the Rust suggest handler caches only through HTTP `Cache-Control`
  (`apps/api/src/suggest.rs:692-738`) — the client neither reads nor fills any server store, so the
  only shared cache behind the popup is whatever the edge/browser honours of those headers (§6.9).
- **Token universe `pool` + `clock`** — `SearchBox.jsx:509-511`, `suggest-pool.js:101-110`
  (`buildScope`), `:132-152` (`reuseDecision`), `:164-175` (`createGenerationClock`). In the
  popup the pool is used only as a generation counter plus `transferred`/`stale`/`cancelled`
  tallies (`:522-527`, `:548-561`); **the whole row-pool half of the module
  (`prepareCandidate`, `filterCandidates`, `rankCandidates`, `groupCandidates`,
  `candidatesFromSuggestPayload`, `mergeCandidates`, `paintSource`, `consumePage`,
  `shouldContinue`, `projectPoolGroups`) has no production caller at all** — only tests. So
  `search-page` answers never reach the popup through a pool.
- Others: `prewarmed` Map `:304-347` (`prewarmSuggest`, key `lang\0print\0tab\0q` `:318`, entry
  dropped on rejection `:334`; it starts the *same* `catalogTargets`/`hydrateTarget` hydration
  `:327` and the same hot-page prefetch `:328` as the popup, from the outside); the **bundled**
  name catalog — `NAME_POOL` is a generated module, not a fetch
  (`market/src/data/suggest-names.js`, 10 011 lines → `suggest-rank.js:63`, `:626`), with a
  rank memo (`:943-944`); `cardCache` `:131` and `thumbCache` `:140` WeakMaps (row objects, never
  evicted explicitly); rotate state
  `:705-706`; hover box `:398`; FLIP snapshot `:770`; `interestTick` `:420`.

### 1.D Which signal each source writes

| signal | line | writers |
| --- | --- | --- |
| `query` | `:392` | `onInput` `:924`, `fillWhole` `:443`, route sync `:487`, `pick` `:875` |
| `term` | `:393` | `commitTerm` paint `:459` (one paint late), `fillWhole` `:444`, route sync `:488` |
| `searchTab` | `:395` | `SearchTabs` `:954`, route sync `:490` |
| **`hitCount`** | `:399` | R1 `:552`, R4 `:612`, R5 `:676`, `fillWhole` `:450`, reset-to-0 `:582`, `:589`, `:598` — **five writers, no owner**; `countedQuery` `:400` only suppresses one of them |
| `liveTick` | `:401` | R2/R3 `:634` |
| `epoch` | `:402` | `:530` (empty text), `:539` (repaint gate) |
| `shadeTick` | `:403` | `:464` |
| `progressivePending` | `:404` | `:515`, `:529`, `:541`, `:563` |
| `sellerHits` / `otherGroups` / `otherPending` | `:405-407` | R8 `:650`, `:653`; R4 `:611`; `:603`, `:620` |
| `hoverBox` · `activeIndex` · `open` · `intent` | `:398` · `:396` · `:394` · `:387` | hover effect `:822-858`; keyboard `:883-905`; focus/blur/input `:925`, `:929-932` |
| **`visibleGroups`** | `:687-701` | `paintCatalogGroups(searchTerm(), {printLang: rankPrint(), searchLang, kind: catalogTab(), limit})` — reads `term` (`:690`), **not** `query`; deps `epoch()` `:692`, `liveTick()` `:693`, `namesTick()` `:694` |

### 1.E One more text source nobody re-checks

`searchTerm()` = `predicted()?.text || term()` (`:431`): for a query below the live-ready gate
(3 compact chars, 2 for CJK — `market/src/compact-query.js:46-55`) the visitor's own interest
profile may **replace the search text** (`:426-430`,
`market/src/interest-profile.js:160-174`) and the popup prints "Because you viewed X"
(`:994-997`). Every row is painted from `searchTerm`, while the empty-state message
(`:1007-1009`) and the "View all …" label (`:1032-1038`) are built from `query`.

---

## 2. Every way the wrong list can appear

Verdict per item: **[D]** deterministic rule (reproducible from a fixed request order) or
**[R]** real race (needs a different interleaving). The reported defect is [D]; the races below
only change the number.

### 2.A Deterministic rules

**A1 — the stem tops up (and thereby owns) a compound answer. [D] ← the symptom**

1. `parseTypedQuery('dark jolteon')` returns **empty**: `suggest-rank.js:1699-1701`
   `if (namePoolHasCompact(compactQuery(raw))) return empty;` — an exact name in `NAME_POOL`
   is never decomposed, so `parsed.nameQuery` stays `dark jolteon` and **no set token peels**.
2. `firstNameToken` (`suggest-live.js:652-657`) takes the first non-modifier word of
   `parsed.nameQuery || query` → **`dark`**.
3. `catalogRecall` (`suggest-pool.js:68-99`) takes the stem from `nameQuery`, which the empty
   parse left as the raw text; `rankNames('dark')` scores `darkrai` at **distance 0** because
   `prefixEditDistance` charges nothing for the name's trailing characters (`:662-740`, used by
   `nameDistance` `:357-366`; `rankNames` `suggest-rank.js:1014-1052`), so the distance-0 branch
   returns **`['dark', 'dark jolteon']`** (`:81-83`, stem first — `catalogRecall` ranks the *stem
   token* only, `:77`; the compound never reaches the ranker). `pageUniverse` iterates lookups in
   that order (`SearchBox.jsx:193`) and pages the stem until `SAFETY_BUDGET`/`MAX_CHUNKS`
   (`:213`, 2 000 rows / 8 chunks, `suggest-pool.js:32-38`) while the compound gets one page and
   then breaks on `exhaustive` (`:211-212`, B3) — the trace's **eight** `q=dark` requests
   (`limit=50`, `offset=50`, then `offset=150…650`) are exactly `MAX_CHUNKS`, so the stem stopped
   only because the budget said so, finishing at 9377 while the compound request started at 9378
   (322 ms after the keystroke that needed it).
4. `paintCatalogGroups` (`suggest-live.js:664-699`): the compound's own contribution is the two
   rows the owner counted — one printing each from the two pool names `Dark Jolteon` and
   `Dark Jolteon Lv.23` (`market/src/data/suggest-names.js:5943-5944`) — so `have` (`:669`) is far
   below `limit` — 20, the `SUGGEST_RESULT_FLOOR` default (`:668`; `market/src/suggest-rank.js:78`)
   — and the fill runs from `rank('dark')` printings already in the store
   (`:674-679`) and returns the merged list (`:683-698`). Darkrai, Dark Patch, Darkness Energy …
   take rows 3-20.
5. `visibleGroups` prints exactly that (`SearchBox.jsx:697-701`).

This is specified behaviour, not an accident: the code comment says the stem "tops up the
whole-query rows, it never replaces them" (`suggest-live.js:680-682`), and the shipped
regression test **asserts the top-up** — `market/src/suggest-two-word-names.test.js:84-89`
("the popup still fills toward twenty printings of the first word", `rows.length === 20`, every
name starting `Dark`), while `:54-57` only pins `rows[0]`. So the compound's list is *defined*
to become the stem's list from row 3 down.

**A2 — the ranking input is a query-agnostic store. [D], amplifies A1**

`liveSuggestGroups` scores `allCachedGroups()` (`suggest-live.js:138-158` → `:508`, `:521`,
`:545`): every name in `byCompact` regardless of which query put it there (§1.C). Arrival order
therefore cannot save the compound: the pool already holds 2 002 stem printings from any earlier
`d`/`da`/`dark` keystroke, and the fill at A1 step 4 reads them without re-asking the network.

**A3 — the same stem-first recall reorders the results page. [D]**

`recallOrder` puts the typed query first (`search-recall-core.js:11-23`), so the *rows* of the
union lead with the compound; but `fill` appends the remaining lookups in order
(`:103-123`) and `total` is the max over them (`:140`, §2.C). On the results page a
set-aware `head()` can also be prepended (`solid/src/pages/Search.jsx:430`,
`search-recall-core.js:97-99`), whose count feeds the same max.

**A4 — the warmup writes the Singles key for a Product-tab query. [D]**

`search-warmup.js:115-121` calls `prefetchSearchPage(typed, requestLang, {fetchSearchPage,
signal, printLang})` **with no `tab`**, so it lands under `tab='singles'`
(`search-hot.js:17-19`, `:44`); the count effect asks with the real tab (`SearchBox.jsx:671`).
For the Product tab the two are different cache rows for different universes, and the
`fillWhole`/`goSearch` read-back (`:447`, `:865`) always uses the current `searchTab()`.

**A5 — the popup rows are painted from `searchTerm`, the labels from `query`. [D]**

See §1.E. During the one-paint `commitTerm` defer (`:454-462`) the label and the empty-state
message already name the new text while the rows are still the old text's (and
`suggestPending()` `:739-741` is what hides that: it reports pending exactly while
`term() !== query()` or `rankPrint() !== printLang()`).

### 2.B Real interleavings

**B1 — the count and the suggest stream fight over `hitCount`. [R] (number only)**
1. keystroke → `setQuery` `:924` → paint → `setTerm` `:459`;
2. pool effect restarts `:511-572`: new `generation` `:523`, `setProgressivePending(true)` `:541`;
   the catalog effect zeroes the count when the text isn't ready (`:582`, `:589`, `:598`);
3. 150 ms later R5 fires with the new `term` (`:670-671`, after the `:668` guard);
4. R1 chunks keep landing → `onPage` `:552` writes `page.count` **of the lookup that chunk
   belongs to** (2002 for `dark`) whenever `countedQuery !== text` — and `countedQuery` is written
   only by R5 `:675` and `fillWhole` `:449`, never by R1 or R4 `:612`;
5. R5 resolves → `setHitCount(total)` `:676`.
Whoever writes last wins, so the number can be 5, 1 909 or 2 002 with identical rows. Real, but
not the cause of the reported rows.

**B2 — a `0`/`null` total is refused, so a foreign number survives. [D]**
`:674` applies the payload total only when `Number.isFinite(total) && total > 0`. The endpoint
legitimately answers `total: null` for the whole SQL family (`search_page.rs:61-62`, `:398` →
`crates/search/src/page.rs:315` `"total": total` where `total: Option<i64>`, `:301`), so Product-tab
counts are *always* refused and always show a suggest-side number.

**B3 — the search-page payload is never a fallback for the rows. [premise correction]**
There is no path from an R5/R6 answer into the list: the popup reads `payload.total` only
(`SearchBox.jsx:673-676`) and the `cards` of the union only in `Search.jsx`
(`solid/src/pages/Search.jsx:430`). So "`total: 0` fell back to the stem" cannot happen. What
*does* end the compound's own paging is the suggest-side break
`exhaustive = page?.exhaustive === true || incoming < size` (`:211-212`, `exhaustive` from
`pokoin-rust/apps/api/src/suggest.rs:209`): 5 < 50 → the compound stops after one page while the
stem keeps paging. That asymmetry, not a 0, is what the trace shows.

**B4 — catalog hydration writes the pool of whatever the resolver pointed at, then repaints. [R]**
`hydrateCatalog` `:630-638` starts R2/R3 with **no generation and no term check** and no
`signal` (R3 not even one, `api.js:465`); its `.then` tests the *current* `searchTerm` and bumps
`liveTick` `:634`. `rememberPrintings` (`suggest-live.js:121-123`) writes under the *target* key
and `rememberSuggestGroups` merges per printing id (`:110-116`), so a late artist/set page adds
rows the new query never asked for, which A2 then scores. It cannot delete the compound.

**B5 — the page memo cannot share an in-flight page. [R]**
`suggest-page-memo.js:35-51` stores only finished answers and deliberately excludes `signal`
from the key (`:19-27`, comment `:9-11`). Two keystrokes 60 ms apart therefore issue two
independent `suggest?q=dark&offset=50` requests; whichever finishes first fills the pool, the
other's rows merge in (`print-bucket.js:125-140`) and bump `epoch` through the 300 ms gate
(`:537-540`) — a repaint of a half-updated pool, plus duplicated traffic. No wrong rows.
The duplicate traffic may not reach the origin: suggest answers are `public, max-age=5,
s-maxage=30, stale-while-revalidate=120` (`pokoin-rust/apps/api/src/suggest.rs:210-212`) and
search-page `public, max-age=15, s-maxage=60, stale-while-revalidate=120`
(`search_page.rs:124`, `:403`), while neither `fetchSuggest` (`api.js:470-498`) nor `fetchSearch`
(`api.js:354-389`) passes `cache: 'no-store'` — many other calls in the same module do (e.g.
`:966`, `:3201`). So an identical URL repeated inside 5 s (or 15 s) is silently answered from the
HTTP cache, and a count that is up to 15 s stale can be the number next to a freshly painted list —
with the browser's private cache, not the client caches above, deciding. §6.9.

**B6 — a warmup for the previous term still writes caches. [R, bounded]**
`search-warmup.js` re-checks the generation only before storing rows (`:107-108`); its
`prefetchSearchPage` (`:115-121`) and the underlying recall session
(`search-recall-core.js:80-101`) are unguarded afterwards, so an obsolete universe's hot row
(`count`, `:68`) can be the one `fillWhole` reads back (`SearchBox.jsx:447`).

**B7 — the print chip re-ranks one paint later. [R]**
`:468-479` defers `rankPrint`; `visibleGroups` filters with `rankPrint()` (`:695`, `:698`) while
`search-hot` keys with the print value it is handed (`:671` → `search-hot.js:49`, `:17-19`) —
`printLang()` from the count effect and `fillWhole`, the canonicalised universe print from the
warmup (`search-warmup.js:94-96`, `:119`), the literal `'all'` from the satellite (`:614`) — while
`fetchSearch` never sends it at all (`api.js:378-382`, `void printLang`). So every one of those
keys addresses **the same server answer**: moving the print chip re-requests an identical query
under a fresh key, and the rows on screen are filtered by `rankPrint()` a paint behind it.

**B8 — rotation paints a deeper list than the head. [D, opt-in]**
`flat` `:707-736` re-runs `paintCatalogGroups` at `SUGGEST_ROTATE_POOL` 50
(`market/src/suggest-rotate.js:4`), merges the tail and mutates `rotateState` **inside the memo**
(`:731`). Flagged off by default (`suggest-rotate.js:6`, `:12-20`), so it is not the owner's
path — but it is a second, independent paint of the same pool.

### 2.C The number: why 1 909 and not 5

1. `pageUniverse`'s lookups are `['dark','dark jolteon']` (A1 step 3).
2. The count path is `prefetchSearchPage` → `fetchSearchRecall` → `createRecallSearch`;
   `recallLookups` (`search-recall.js:8-28`) = `recallOrder(query, catalogRecall(query))` =
   `['dark jolteon', 'dark']` (`search-recall-core.js:11-23`).
3. `start()` fetches **both lookups in parallel** — the two `search-page` requests at
   t=9179 (`search-recall-core.js:85-87`) — and stores each payload's own total
   (`:92`) → `[5, 1909]`.
4. `:140-141` `const known = Math.max(session.headTotal, ...session.totals, 0); const total =
   session.done ? session.rows.length : Math.max(known, session.rows.length);` → **1 909**:
   the *stem's* universe, reported as the compound's count. The returned object also spreads the
   first lookup's payload over the union (`:143`).
5. R5 applies it (`SearchBox.jsx:674-676`) and the footer renders
   `View all 1,909 results` (`:1032-1038`).

So the count is a **deterministic rule** (`:140`), and the 2 002 variant of it comes from B1
(`page.count` of a `dark` chunk — the engine-side candidate estimate,
`crates/search/src/suggest.rs:890-894` `count = global.max(shown)` with
`global = page.estimated_total` from `apps/api/src/suggest.rs:297`/`:416-423`, i.e. *cards
matching the word anywhere*, which is exactly the 2 002 the search page also reports for
`dark`). Neither number is the count of the list on screen.

### 2.D Replaying the measured order — no race needed

Serial replay: stem chunks fill `byCompact` with ~2 002 `dark` printings (A2) → the recall
session publishes `max(5, 1909)` = 1 909 into the hot row for the compound (B/C above) → the
compound's 5 printings land at 9415 → `paintCatalogGroups` tops 2 compound rows up to 20 from
`rank('dark')` (A1 step 4) → the footer says 1 909 (step 5). Identical to the owner's report.
**Attribution: rows = A1 (+A2); count = `search-recall-core.js:140-141` (+B1 for the 2 002
variant, +B2 for refusals); request order = A1 step 3.** B4–B8 are reachable from the shipped
code but are not required by this symptom; §6 lists what would confirm them.

---

## 3. Why `search-page?query=dark+jolteon` returns 0 while suggest returns 5

**Because of `productType=cards`, not because of the two words.** The trace separates the two
variables cleanly: `query=dark+jolteon&productType=card` → **5**,
`query=dark&productType=cards` → **0**, `query=red+hair+charizard&…` → **274**. Every request
carrying the plural is 0 whatever it searches; every request carrying the singular is non-zero,
including multi-word and apostrophe queries. The two-word AND-join is also not a plausible
cause on either engine: RediSearch joins the per-token clauses with a space — **AND**
(`pokoin-rust/crates/search/src/redis_query.rs:2-16`; clause `:50-73` =
`(@name:t* | @name_compact:t* | @name_normalized:t* | @nicknames:t* | @card_number:t* |
@set_name:t* | @expansion_name:t*)` plus a contain form `%%t%%` for len ≥ 6 / `%t%` for len ≥ 4),
and the engine's answer for the compound is the 5 rows
(`suggest?q=dark jolteon` → 5, `search-page?query=dark+jolteon&productType=card` → 5).

The exact condition, in three steps:

1. `pokoin-rust/apps/api/src/search_page.rs:40` — `product_type = clean_text(param("productType"), 60)`:
   trimmed and length-capped only (`crates/search/src/suggest.rs:35-37` is `trim` + `take`), with
   **no validation against the domain** and no alias mapping, unlike `print_language` (`:55-58`)
   or the language param (`:43-50`).
2. `search_page.rs:61-62` — anything pokemon + non-empty query that is not `productSearchOnly`
   and not `jumbo` stays on the Redis path, so the unknown value is never rejected.
3. `search_page.rs:250` — the candidate ids are filtered by
   `… and card_id = any($1::bigint[]) and product_type = $2` with `$2 = 'cards'` **exact
   equality**, and again in memory at `:86-88` (`rows.retain(|row| row.product_type == product_type)`).
   The column stores the singular (`card`, `jumbo`, …); the search index has no `product_type`
   field at all (`pokoin-rust/apps/api/src/jobs/search.rs:10-26`), so the filter is SQL-only.
   `:253` retains nothing → `:255` `total = Some(0)` → `:106` → `page.rs:315` `"total": 0`.
   The same unvalidated value is bound straight into the SQL family as well — `$3 = product_type`
   with `and ($3='' or c.product_type=$3)` (`search_page.rs:359`, satellite `:371`, bound `:383`) —
   so `productType=cards` empties the PostgreSQL path too, only there with `total: null` (`:398`).
   `filtered_candidates:247` is the one honest case: an **empty** `productType` skips the product
   filter entirely.

No first-party caller sends the plural: Singles sends `productType: 'card'`
(`market/src/search-kind.js:61` → `api.js:372-374`), the Product tab sends no `productType` but
`productSearchOnly: 1` (`search-kind.js:58`), which `search_page.rs:61` routes to SQL. The only
`'cards'` literal in the app is a client-side filter value on `/marketplace/explore`
(`solid/src/pages/Explore.jsx:14`, never sent). So the reported 0 is a **probe artifact** — and a
live footgun: an unvalidated equality filter turns a pluralised parameter into a silent empty
search instead of a 400.

Three other ways this endpoint legitimately answers empty-or-absent, all of which the client
reads as "no count":

- `search_page.rs:255` — when the engine matched more than `PRODUCT_CANDIDATES` = 5 000
  candidates (`:201`, fetched `WITHSCORES LIMIT 0 <cap>` at `:204-213` with `TIMEOUT 1500`),
  `total` is `None` → JSON `null` (`page.rs:293-320`) — and every client coerces `null` → 0:
  `search-hot.js:68`, `search-recall-core.js:92`, `SearchBox.jsx:674`.
- The product filter runs **after** the capped window (`:248-253`): a query whose first 5 000
  candidates are mostly another product type comes back short or empty with a recomputed total.
- A language/print filter with no matching rows — known hard enough that `fetchSearch`
  deliberately never sends `printLang`: "marketplace-search-page drops every row once
  print_language is set" (`api.js:378-382`).
- Redis failure is a **503**, not a 0 (`search_page.rs:66-72`); the rejection deletes the hot
  row (`search-hot.js:76-79`) and the count keeps whatever R1 last wrote (B1/B2).

---

## 4. Why `dark jolteo` behaves better than `dark jolteon`

One branch decides it, in `market/src/suggest-rank.js`:

| step | `dark jolteon` | `dark jolteo` |
| --- | --- | --- |
| `parseTypedQuery` (`:1658`) | `words.length ≥ 2` (`:1696`) **and** the whole compact is an exact `NAME_POOL` name (`namePoolHasCompact`, `:184-187`; `data/suggest-names.js:5943`) → `return empty` at **`:1699-1701`**: nothing peels, `parsed.nameQuery` is empty and every consumer falls back to the raw text | `:1699` does not fire (no pool name compacts to `darkjolteo`), so `classifyQueryWord` (`:1519`) runs on `dark`: not an art/rarity alias (`:1521-1535`), not an exact set alias (`:1537-1555` — and `dark` is not a `NAME_POOL` row, grep), not a collector number (`:1556`), but `packedFromExpansionPrefix('dark')` (`:1402-1428`) hits — `compact.length 4 = MIN_EXPANSION_PREFIX` (`:1371`, `:1403`) and `darkexplorers`/`darknessablaze` are prefix rows (`expansionPrefixRows`, `:1376-1400`) — so `dark` becomes a **set** token (`prefix: true` `:1569`) and `nameQuery = 'jolteo'` |
| stem token (`suggest-live.js:652-657`, `suggest-pool.js:75-76`) | **`dark`** | **`jolteo`** |
| `catalogRecall` (`suggest-pool.js:68-99`) | `prefixEditDistance` scores a name that merely *starts with* the token at distance 0 (`:662-740`, `nameDistance` `:357-366`) — `dark` is a prefix of `Darkrai`, so the distance-0 branch fires. `parsed.nameQuery` is the raw text here (`empty.nameQuery = raw`, `suggest-rank.js:1662`), so `words.length = 2` and `full` is kept (`:80`): **`['dark', 'dark jolteon']`** (`:81-83`), stem first → the eight large stem chunks of the trace before the compound | The peel makes `nameQuery = 'jolteo'` **one word**, so `words.length = 1` and the `full` guard at `:80` fails: the recall is **`['jolteo']` alone** — this stream never asks the engine for `dark jolteo`. The Dark Jolteon rows on screen are the ones **A2's store** already holds (`rank(token='jolteo', pool)` scores the stored `Dark Jolteon` at 0), topped up by the single-species page. So `dark jolteo` looks better while actually relying on the cache, not on the compound being understood. `rankNames` skips its memo (`suggest-rank.js:1014-1052`), so no `dark jolteon` ↔ `dark jolteo` crossover exists |
| engine answer for the compound | `suggest?q=dark jolteon` → **5** printings, of which 2 reach the screen (§6.10) | `suggest?q=dark jolteo` → **12** printings, already Dark Jolteon + Dark Explorers Jolteon/Joltik — but reached only when the whole text is sent, which is what `hydrateTarget` and the count request do (`SearchBox.jsx:258`, `:671`), not the recall |
| fill in `paintCatalogGroups` (`:683-697`) | `have` ≈ 2 « 20 → topped up from `rank('dark')` → **Darkrai / Dark-\*** on rows 3-20 | `have` ≈ 12 → topped up from `rank('jolteo')` → **Jolteon-family**, so the top-up is invisible |
| count | union `max(5, 1909)` → **1 909** | union over `['dark jolteo','jolteo']` → **215** (right neighbourhood, still not the on-screen list) |

The typo is better for **two accidental reasons, and neither is the compound being understood**.
The peel moves the ranking stem from the 2 002-card prefix `dark` to the species `jolteo`, so the
store top-up that owns rows 3-20 in the correct spelling is itself about the right Pokémon; and the
stem's page is small (`rankNames('jolteo')` accepts the Jolteon family) so the pool is not polluted
with an unrelated genus. Both spellings send `dark jolte…` as a *whole* string only to the
one-shot paths — the catalog-name hydration (`SearchBox.jsx:258`, R3) and the count request
(`:671`, R5) — and the typo's suggest stream never sends it at all. What the owner saw as "the typo
works" is the local name pool plus whatever the earlier chips already cached (`:667`), i.e. **A2
carrying the typo**, not the engine understanding it: fix A1 and both spellings are served by the
same path.

`MIN_BARE_SET_PREFIX = 8` (`:1372-1373`, "*Bare set browse (`expedition`). Shorter tokens stay
names (`dark`, `plasma`)*") only guards the **single-word** browse path (`:1676`); inside a
multi-word query `dark` peels freely, and `packedFromExpansionPrefix`'s own name guard
(`:1409-1411`) cannot fire because `dark` is not a pool name. So the exact-name branch
`:1699-1701` is the only branch that keeps the first word as the ranking stem — and it is the
branch every correctly-typed compound name takes.

---

## 5. Proposed fix, per file, and the regression tests `docs/CI.md` requires

### 5.1 `market/src/suggest-live.js` — the stem may not own a compound answer
- `paintCatalogGroups` (`:664-699`): the top-up token must be the query's **name** token, not
  its first word. When `parsed` is empty because the whole query is one exact pool name, fill
  from the species word (`jolteon`) — or, better, first fill only from rows consistent with
  **all** typed tokens and relax to the stem last, keeping the "always reach 20" contract
  (D000024/D000016) but ordering the fill by token coverage: exact full-query rows, then
  same-species printings, then stem printings.
- `firstNameToken` (`:652-657`): document and implement it as "the stem the fill may widen to",
  never "the first word"; return the compound's head name.
- Gate the query-agnostic branches: `allCachedGroups()` (`:138-158`, used at `:508`, `:521`,
  `:545`) must not be a candidate source when the typed text is already an exact name.

### 5.2 `market/src/suggest-pool.js` + `solid/src/components/SearchBox.jsx` — the compound before the stem
- `catalogRecall` (`:68-99`): for an exact compound name emit `[fullQuery, stem]` and bound the
  stem's chunk budget (`:32-38`) so the compound's hydration is not scheduled after 8 stem
  pages — the trace's 322 ms delay (`SearchBox.jsx:193`, `:213`).
- `SearchBox.jsx:549-554`: `onPage` must not write `hitCount` from a page whose `q` is not the
  committed text — delete the `page.count` stamp at `:552` (the server's `count` is an engine
  candidate estimate, `crates/search/src/suggest.rs:890-894`, never a results total) and keep
  exactly one count owner.
- `SearchBox.jsx:673-677`: distinguish "answered 0" from "no answer": apply a legitimate 0
  instead of refusing it, and treat `total: null` as unknown rather than 0.
- `SearchBox.jsx:630-638` + `:250-265` + `:315-347`: pass the `signal`/generation into
  `hydrateTarget` (and into `api.js:461-467`, which accepts none), and let the landing's
  `prewarmSuggest` (R12) share that guard, so a stale catalog or chip page cannot repaint the popup.
- `api.js:354-389`, `:470-498`: give the count and the progressive chunk stream an explicit cache
  policy (`no-store` on the count so the footer matches the just-typed query, or a documented
  short reuse) instead of inheriting `max-age=5`/`max-age=15` (B5).
- `SearchBox.jsx:671` / `market/src/search-warmup.js:115-121`: pass `tab` from the warmup and
  use one normalised `printLang` in the hot key (`search-hot.js:17-19`), so one server answer
  has one cache row (A4, B7).
- `search-hot.js:63-68`, `:73-75`: never cache `0` as a count (leave it unknown) and drop the
  row on abort instead of leaving `count: 0`.

### 5.3 `market/src/search-recall-core.js` — one universe per number
- `:140-141`: a union's `total` must be the deduped union's own count (or the typed query's
  lookup total), never `Math.max(...totals)` over sibling lookups; stop spreading
  `...session.base` (`:143`) so the payload of one lookup is not presented as the union's.

### 5.4 `market/src/suggest-rank.js` — expose the compound decision
- `:1699-1701` must not return a bare `empty`: return a shape carrying
  `exactCompoundName: true` with `nameQuery` = the whole query, so `firstNameToken`,
  `catalogRecall` and the fill share one decision instead of each re-deriving it from
  `NAME_POOL` (`namePoolHasCompact` is a linear scan over 10k rows, `:184-187`).

### 5.5 `pokoin-rust/apps/api/src/search_page.rs` — fail loud, count honest
- `:40`, `:86-88`, `:250`, `:359`, `:371`: validate `product_type` against the known domain (alias
  the plurals, or 400 on an unknown value); the in-memory retain, the candidate SQL `= $2` and the
  two page-SQL `= $3` predicates must all use the same normalised value, or an unknown value keeps
  silently emptying four independent filters.
- `:255`: when the cap is exceeded return a bounded total plus an `approximate`/`capped` flag
  (or a real recount of the filtered ids) instead of `None` → `null`, which clients read as 0.
- `:398`: the SQL family answers `total: null` even though it has just counted rows (`:394`
  `has_more` proves the look-ahead exists) — a `count(*)` over the same predicate would make the
  Product tab's "View all N" a real number instead of a suggest estimate (B2).

### 5.6 Tests required by `docs/CI.md`
`docs/CI.md:13` — the `js-gate` workflow runs one job per line of
`scripts/js-test-groups.txt`: `market` (cwd `.`) = `node --test --test-force-exit` over the globs
`market/src/*.test.js market/src/*.test.mjs`, minus `search-token-triples.test.js` (its own
`market-sweep` job) and `gesture-exclusivity.test.js` (listed in
`scripts/js-tests-not-in-gate.txt`, so it runs on no runner and **cannot serve as a proof**), plus
`market/index.test.js`; `solid` (cwd `solid/`) = `node --test --test-force-exit
solid/src/**/*.test.js`. `docs/CI.md:11` — `scripts/check-features.sh` requires every proof to be a
tracked file that a gate job actually runs (`check-features.sh:176-239`), and
`docs/FEATURES.toml:328-341` lists the `search-page` and `typeahead` flows (both
`status = "partial"`). A new `market/src/*.test.js` or `solid/src/**` file is picked up by the
globs automatically; each must additionally be named in the flow's `proof`.

1. **`market/src/suggest-two-word-names.test.js` (extend)** — test *`compound tail belongs to
   the compound`*: feeds `paint('dark jolteon', [DARK_JOLTEON, DARK_JOLTEON_JP, DARKRAI,
   DARK_PATCH, DARKNESS_ENERGY, JOLTEON])` with `limit: 20` and asserts every printed row
   matches **all** typed tokens, that no bare-Darkrai row outranks a `Dark Jolteon`/`Jolteon`
   row, and that the exact group keeps row 0. Note `:84-89` currently asserts the **opposite**
   ("fills toward twenty printings of the first word") and must be rewritten to
   "fills toward twenty only after every compound-consistent printing is shown"; `:54-57` must
   be extended from `rows[0]` to the whole list.
2. **`market/src/suggest-two-word-names.test.js` (new) — *replays the measured request order*.**
   A fake transport records every call and answers exactly §0's table: `suggest q=dark` in
   chunks (50 then 100s to offset 650, `count` 2002, `exhaustive` false),
   `search-page query=dark&limit=96` → `total` 1909,
   `suggest q=dark jolteon&hydrate=1&progressive=1` → 5 printings/`count` 5,
   `search-page query=dark+jolteon&limit=96` → `total` 5 — delivered in the traced order, then
   again with the stem's chunks arriving **last** to pin the order-free invariant. It drives the
   real chain (`catalogRecall` → `rememberSuggestGroups` + an `onPage`-shaped count writer →
   `createRecallSearch` → `paintCatalogGroups`). Asserts: the popup shows all **five printings of
   the `dark jolteon` answer** — both compound groups, `Dark Jolteon` (Team Rocket 38/82) and
   `Dark Jolteon Lv.23` (Rocket Gang, JP) — **ahead of every stem row and with no Darkrai row**, and
   "View all" reads **5** — one number for one list, in both arrival orders.
   *Harness limit, and what it implies for the fix:* `pageUniverse` is a module-private function of
   `SearchBox.jsx` (`:192-220`) and this repo has no component-render harness —
   `solid/src/components/SearchBox.test.js` asserts on the **source text** (`:1-8`). So the replay
   can only drive the modules, with the test itself playing the chunk loop exactly as `:201-207`
   does. That pins `catalogRecall`/`rememberSuggestGroups`/`createRecallSearch`/
   `paintCatalogGroups`, but **not** the loop's own guards (`:204`, `:211-213`). If this test is
   wanted against the shipped component, the chunk loop has to move out of `SearchBox.jsx` into a
   `market/` module first — which §5.2 independently argues for, because the loop is also the part
   that cannot currently be given a generation guard (`:630-638`).
3. **`market/src/search-recall-core.test.js` (extend)** — *union count*: lookups
   `['dark jolteon','dark']` with totals 5 and 1909 → asserts the returned `total` is 5 (union /
   typed-lookup count) and that the payload's identity fields come from the typed query's page,
   not the stem's.
4. **`market/src/suggest-pool.test.js` (extend)** — *recall order and budget*:
   `catalogRecall('dark jolteon')` returns the full compound before the stem and caps the stem's
   chunk budget for an exact pool name.
5. **`market/src/suggest-rank.test.js` (extend)** — `parseTypedQuery('dark jolteon')` reports
   `exactCompoundName` with `nameQuery = 'dark jolteon'`, while `parseTypedQuery('dark jolteo')`
   keeps peeling `dark` as a set prefix — pinning §4's asymmetry as intended, and pinning
   `MIN_EXPANSION_PREFIX`/`MIN_BARE_SET_PREFIX` (`:1371-1373`) so a future shortening cannot
   silently re-break it.
6. **`solid/src/components/SearchBox.test.js` (edit)** — this file asserts against the source
   text by convention (`:1-8`) and its test *"View-all count prefers the payload total, keeps
   the suggest baseline"* (`:26-33`) currently **requires the two buggy constructs**
   (`Number.isFinite(total) && total > 0` at `:674`, `setHitCount(Number(page?.count) || 0)` at
   `:552`). It must be rewritten to require a single count owner: no `setHitCount` fed from a
   page whose `q` differs from the committed term, a zero applied rather than refused, and an
   unknown total distinguishable from 0.
7. **`pokoin-rust/apps/api/src/search_page.rs` unit tests** — one per filter that today fails
   silently: `productType=cards` rejected (or aliased, then asserting the 5 rows) on the Redis
   retain (`:86-88`), on `filtered_candidates` (`:250`, which already has a `mod` to grow at
   `:259`) and on the pokemon/satellite page SQL (`:359`, `:371`); and a query whose candidate
   window exceeds `PRODUCT_CANDIDATES` (`:201`) returning a bounded `total` + `capped` instead of
   `null`. Each case must feed the exact parameter string, not a `ProductType` value, because the
   defect lives in the parameter domain.
8. **`docs/FEATURES.toml:328-341`** — add each new proof file to the `typeahead` and
   `search-page` flows' `proof`, then run `scripts/check-fast` (`docs/CI.md:17-24`) for the
   `pokoin-rust/` change. This is not bookkeeping: **today neither `market/src/suggest-two-word-names.test.js`,
   `suggest-pool.test.js`, `suggest-live.test.js`, `search-hot.test.js` nor
   `solid/src/components/SearchBox.test.js` is named in any flow's `proof`** (grep over
   `docs/FEATURES.toml`: 0 hits each) — only `suggest-rank.test.js` (`typeahead`) and
   `search-recall-core.test.js` (`search-page`) are. So `scripts/check-features.sh` does not
   currently gate the popup's own regressions, and the fix above could be reverted without a CI
   signal. Every proof file added here must also exist and be run by a `js-gate` job, which
   `js-inventory` checks.

---

## 6. What could not be determined from reading the code

1. **The 2 002 → 1 909 gap.** `search-recall-core.js:140` takes a max, so some lookup in that
   session saw 1 909 while the direct probe of the same query and `productType=card` says 2 002.
   From source the two requests should be identical (`lang`/`search_language` both `en`,
   `printLang` never sent, `limit` does not enter `total`), so the difference must come from a
   runtime parameter, a cache age (60 s hot TTL, 120 s session TTL) or an index change between
   the trace and the probe. Not decidable here.
2. **What the popup's own compound `search-page` request returned** (5, 0 or `null`): the union
   max makes 1 909 regardless, and nothing in the code records which total won. The trace also
   cannot be read as literal URLs: it shows `search-page?query=dark&limit=96` with no
   `productType`, while `prefetchSearchPage` always sends `productType=card` on Singles
   (`search-kind.js:61` → `api.js:372-374`) and `limit=96` only because `start()` overrides the
   48 (`search-recall-core.js:86`, `pageSize` `:38`). So the recorded `…&productType=cards` probe
   is a *manual* URL, not the popup's request, and `SearchBox`'s real query string is not in the
   evidence — the full URLs are needed to rule out a parameter difference in what produced 0.
3. **Which engine answers production** — `MARKETPLACE_SEARCH_ENGINE`/`SEARCH_ENGINE`
   (`pokoin-rust/crates/config/src/lib.rs:44`) selected at `apps/api/src/suggest.rs:118`/`:129`.
   It matters for compounds: Meili defaults to `last` matching (drops a non-matching word) and
   only opts into `all` with `match=all` (`apps/api/src/suggest.rs:394-396`, `:391`
   `attributesToSearchOn`), while RediSearch AND-joins (`redis_query.rs:2-16`). The `count` 5 /
   12 / 2002 numbers are consistent with either, so an A/B measurement per engine is needed.
4. **Whether the `%t%` / `%%t%%` contain clauses (`redis_query.rs:65-71`) work against the
   shipped index**: `jobs/search.rs:10-26` creates no `WITHSUFFIXTRIE`, so the observable
   failure mode (error → 503 at `search_page.rs:66-72`) is measurable only against a live index.
5. **Whether production's index carries `nicknames`**: the Rust indexer writes the field
   **empty** for every document (`jobs/search.rs:109-115`) while the query clause and Meili's
   `SEARCH_ON` both use it (`redis_query.rs:60`, `apps/api/src/suggest.rs:36-43`) — D00000H
   expects card nicknames there. If the live index was built by the retired Node job it differs
   from what this binary would rebuild, which changes alias recall for a compound. Needs a
   live `FT.INFO`/doc read.
6. **Which `hitCount` writer produced the exact number the owner saw** — B1 makes that
   arrival-order dependent (5 / 1 909 / 2 002); a trace with per-callback timestamps or a session
   recording would settle it. Same for whether the recall session that published 1 909 was
   created by `warmupSearchUniverse` (its hot row is written under `tab: 'singles'`, A4) or by
   the 150 ms count effect.
7. **Whether B4/B5/B7 ever change the rows in practice** — from source they can only add or
   re-order pool entries (A2 decides whether they print); measuring that needs the popup's own
   stats (`pool.stale` / `pool.cancelled`, `:556`, `:558`) surfaced in a session.
8. **Whether the pool the owner typed into was already warm from the landing page.** R12
   (`island.jsx:99-101` → `prewarmSuggest`) puts whole Popular-chip universes into `byCompact` and
   the hot cache with no generation guard, and the pool survives 30 min (`suggest-live.js:54`).
   From source, the top-up at A1 step 4 cannot tell a `dark` row that arrived with this query from
   one left by a hovered chip, a previous keystroke or `pick`; only a session trace can say how much
   of the on-screen Darkrai list belonged to `dark jolteon`'s own traffic at all.
9. **What the caches in front of the API returned.** The count and chunk requests carry no
   `cache` option (B5), so `public, max-age=5/15` + `s-maxage=15/30/60` +
   `stale-while-revalidate=120` (`suggest.rs:210-212`, `search_page.rs:124`, `:403`) let an edge or
   the browser answer a URL without a network hit. This is the most likely explanation of the
   2 002-vs-1 909 gap in item 1 (a `dark` total served from a copy up to a minute old), but the
   headers alone do not prove which copy answered; that needs `age`/`x-cache`-style response headers
   from the live edge.
10. **Why only two of the compound's five printings were on screen.** The trace records
    `suggest?q=dark+jolteon` → **5 printings** but the owner counted two rows before the Darkrai
    run, and the pool holds **two different compound names** — `Dark Jolteon`
    (`market/src/data/suggest-names.js:5943`) and `Dark Jolteon Lv.23` (`:5944`) — which the
    owner's rows exactly match, one each. `rememberSuggestGroups` keys by `group.name`
    (`suggest-live.js:94`), so the payload's groups land as separate buckets. From there the
    compound's rows pass exactly two gates, in `liveSuggestGroups`'s name branch
    (`:502-533`, taken because `compactQuery(nameQuery) === compactQuery(query)` for the empty
    parse): `popupGroups(allCachedGroups(), printLang)` (`:521`) and the **name-eligibility** set
    `ranked.filter(withinCap !== false)` (`:520-522`) — `minCoverage: 0` (`:525`) rules coverage out
    as the culprit, and `paintCatalogGroups`' own `have`/`limit` (`:669-670`, `:683-686`) could only
    cut the tail. So the missing three are a printing the `printLang` filter removed, a group whose
    name `rank('dark jolteon')` did not accept, or a `limit` cut on the last rows — undecidable
    without that response body. This is also the one number §5 test 2 would assert blindly until the
    payload is recorded.
