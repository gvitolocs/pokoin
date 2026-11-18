# PH-R029 — CARD-01: the collector-number arrows refetch what is already on the client, and the panels repaint while they wait

Run **PH-R029** · Lead **PH** · Refs **CARD-01** · measured 2026-11-18 · branch `card-arrows-analysis` at `origin/main` (`30601f15`)

Read-only analysis: no source file and no test was changed; this file is the only output.
Every `file:line` below was opened and read in this worktree. Labels: **proven** = the quoted lines do
this, read end to end; **hypothesis** = the mechanism is in the code but one step depends on something
not readable here (the Solid 2 scheduler, `@solidjs/router` 2.0.0-next.38 internals, IndexedDB latency,
or the lead's exact click).

---

## 0. The symptom and the trace being explained

Owner: on `/marketplace/en/cards/<id>/<slug>`, moving with the collector-number arrows
(`a.art-nav`, "Previous card in set" / "Next card in set") — "there are things that are getting fetched
that should just be cached; when moving with collector number arrows they glitch". His screenshot names
the price graph, **Cheapest listings**, **Buy offers**, the **Have this card?** bar and the **All <name>**
rail.

Lead's trace (production, signed out, 1440x900, card 813622 → next 813624; ms from the click):

| t | request | asked by |
| --- | --- | --- |
| 2 | `marketplace-event` | `solid/src/pages/Card.jsx:1452` (`track(Action.nextCard)`) → `market/src/track.js:46` → `market/src/api.js:2270` |
| 5 | `marketplace-listings?cardId=813624&nativeOnly=1&limit=40&_=<ts>` | `solid/src/pages/Card.jsx:417` → `market/src/api.js:962` |
| 6 | `marketplace-card-sales?cardId=813624&slices=1` | `solid/src/pages/Card.jsx:526` → `market/src/api.js:649` |
| 9 | `marketplace-native-sales?cardId=813624` | `solid/src/components/desk/NativeSales.jsx:21` → `market/src/api.js:2705` |
| 14 | `marketplace-card-page?cardId=813624&lang=en&slug=…` | `solid/src/pages/Card.jsx:423` → `market/src/api.js:876` |
| 15 | `marketplace-list?kind=name&key=…&format=c1v2&dict=…` | `solid/src/pages/Card.jsx:651` → `market/src/api.js:422` |
| 24 | `marketplace-version-set?cardId=813624` | `solid/src/pages/Card.jsx:544` → `market/src/api.js:914` |
| 279 | `marketplace-listings?cardId=813626&nativeOnly=1&limit=40` | `solid/src/pages/Card.jsx:371` → `market/src/api.js:2235` → `market/src/api.js:2217` |
| 285 | `marketplace-card-page?cardId=813626&lang=en&slug=…` | same warm → `market/src/api.js:2219` |
| 994 | `marketplace-buy-orders?card_id=813624` | `solid/src/lib/buy-book.js:87` ← `solid/src/lib/buy-book.js:163` (`whenIdle`) ← `solid/src/lib/buy-book.js:159` (`ready`) ← `solid/src/pages/Card.jsx:1017` |

Panels: **Cheapest listings** = `0` + blank body (84 px) until ~160 ms, then "No listings yet." (90 px);
**Buy offers** = nothing until ~1,260 ms, then the Pokoin starting-offer line. No `layout-shift` entry:
the glitch is content arriving late plus small height changes in a two-cell row.

Not asked, because a cache answered: `marketplace-artist-cards?summaries=1` (permanent memory slot,
`market/src/api.js:1443`), `marketplace-expansion-page?limit=1` (the set did not change, memo at
`solid/src/pages/Card.jsx:588`), `marketplace-card-url` (a slug was in the URL, `solid/src/pages/Card.jsx:554`),
`marketplace-card-price-history` (not Silver, `solid/src/pages/Card.jsx:478`).

---

## 1. What an arrow step actually is

1. `a.art-nav` is a plain anchor with `href` (`solid/src/pages/Card.jsx:1445-1456`); its `onClick` only
   hands the row to the next desk and tracks the click (`solid/src/pages/Card.jsx:1451`,
   `solid/src/pages/Card.jsx:1452`; `solid/src/lib/card-handoff.js:11`).
2. `solid/src/lib/yield-nav.js:66-89` claims the click (`event.preventDefault()` at
   `solid/src/lib/yield-nav.js:83`) and defers the route change by one painted frame with `afterPaint` =
   `requestAnimationFrame` + `setTimeout(…, 0)` (`solid/src/lib/yield-nav.js:20-29`). The click's own work
   (handoff, `marketplace-event`) therefore runs *before* the new desk exists — that is the 2 ms event in
   the trace. **proven**
3. `deskKey` is `lang:cardId` (`solid/src/pages/Card.jsx:202`) and the desk is rendered under
   `<Show when={deskKey()} keyed>` (`solid/src/pages/Card.jsx:225`), so an arrow step **disposes the whole
   `CardDesk` and mounts a new one** (`solid/src/pages/Card.jsx:237`). Every per-desk signal starts again
   from zero: `page` `solid/src/pages/Card.jsx:264`, `shop.offers` `solid/src/pages/Card.jsx:270`,
   `offersReady` `solid/src/pages/Card.jsx:272`, `salesSlices` `solid/src/pages/Card.jsx:316`,
   `graphDrawn` `solid/src/pages/Card.jsx:472`, `later` `solid/src/pages/Card.jsx:330`,
   `graphPicks` `solid/src/pages/Card.jsx:829`, and the buy book (`solid/src/lib/buy-book.js:67`). The
   header comment at `solid/src/pages/Card.jsx:189-194` says this is deliberate. **proven**
4. Consequence that shapes the whole analysis: "cached" for a neighbour step means only the *module*
   caches in `market/src/` and the local store — nothing survives the remount itself. Any panel whose
   first frame is decided by "did the peek return paintable rows" (`solid/src/pages/Card.jsx:261`,
   `:270`, `:272`, `:316`) repaints blank when that test is false, even when the client already holds an
   answer.

---

## 2. Map: everything the desk reads when the card id changes

Legend for the warm column: **hover** = `onPointerEnter` → `warm()` (`solid/src/pages/Card.jsx:1207-1210`,
wired at `:1410` / `:1449`) → `warmupCard` (`market/src/api.js:2227`) → `prefetchCardDesk`
(`market/src/api.js:2208-2225`); **intent** = the router's 60 ms hover preload
(`solid/src/lib/local-prefetch.js:44-46`) → the same `prefetchCardDesk`; **neighbours** = `warmupNeighbors`
(`market/src/api.js:2231-2242`) fired from `showCard` (`solid/src/pages/Card.jsx:371`). All three warm the
same three things and nothing else: hero art (`market/src/api.js:2214`), **listings**
(`market/src/api.js:2217`), **card page** (`market/src/api.js:2219`).

| # | data | asked by (file:line) | URL | where the answer is cached (key · lifetime) | warmed? | what the panel shows while it waits |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | desk page: identity, neighbors, rarities, versions, related | `solid/src/pages/Card.jsx:423` → `market/src/api.js:876`/`:879` (`fresh: Boolean(cached)` `solid/src/pages/Card.jsx:427`, `onUpdate: showCard` `:428`) | `/api/marketplace-card-page?cardId&lang&slug` | `cardCache` Map `market/src/api.js:550`, key `game:lang:id` `:553`, LRU 24 `:822`, no TTL of its own — freshness is the local-reader 30 s window (`market/src/api.js:793`, `market/src/local-read.js:29`); localStorage `pokoin.cardPage.v2.<game>:<lang>:<id>`, 12 h, 40 copies (`market/src/card-page-cache.js:7`, `:9`, `:13`); IndexedDB + memory via `localReader` (`market/src/local-read.js:43`); server Redis 30 s + `public, max-age=10, s-maxage=30, stale-while-revalidate=60` (`pokoin-rust/apps/api/src/catalog_api.rs:266`, `pokoin-rust/apps/api/src/read_cache.rs:41-50`) | hover + intent + neighbours | the URL stub + recent tile + handoff card, merged in place (`solid/src/pages/Card.jsx:249-255`, `:374`) — never blank |
| 2 | listings (Cheapest listings, Best Deal, Vault, Shop) | `solid/src/pages/Card.jsx:417` → `:345` → `market/src/api.js:962-965` | `/api/marketplace-listings?cardId&nativeOnly=1&limit=40` + `&_=<ts>` whenever `fresh` (`market/src/api.js:962`) | `listingsCache`/`listingsAt` Maps `market/src/listings-cache.js:9`, `:12`, key **bare card id** (`:134`, `:166`), cap 24, **no TTL** — only `listingsAgeMs` `:176`; localStorage `pokoin.deskListings.v1`, key `game:cardId`, 3 days / 24 desks / 600 KB (`market/src/desk-listings-store.js:12-14`, `:25`), written **only** by an opened desk (`solid/src/pages/Card.jsx:348`); HTTP: client `cache:'no-store'` (`market/src/api.js:966`) and server `private, no-store` (`pokoin-rust/crates/commerce/src/handlers/listings.rs:589` → `:113` → `pokoin-rust/crates/commerce/src/handlers/mod.rs:32`) — nothing is ever reused | hover/intent/neighbours, but adopted only when ≤ 10 s (`solid/src/pages/Card.jsx:170` → `market/src/api.js:941`) | `0` + an empty `<p class="status"> </p>` when the peek found no *rows* (`solid/src/components/deal/CheapestListings.jsx:30`, `:49`); the previous card's content never stays — the store is per-desk |
| 3 | sold slices (graph line, Market price pill, chips) | `solid/src/pages/Card.jsx:526` → `market/src/api.js:646-649` | `/api/marketplace-card-sales?cardId&slices=1` | **no cache in `market/src/api.js`** (`:624-667`); `market/src/sold-sales-cache.js`: memory Map cap 32 (`:3`, `:4`), localStorage `pokoin.cardSales.v12.<id>`, TTL 15 days (`:1`, `:2`), read at `solid/src/pages/Card.jsx:316`; HTTP `public, max-age=20, s-maxage=120` (`pokoin-rust/crates/catalog-api/src/sales/routes.rs:187`) | **no** | nothing is plotted until `graphDrawn` (`solid/src/components/desk/SoldPriceGraph.jsx:518`, `:549`; `solid/src/pages/Card.jsx:472`, `:810`); the pill reads `—` (`solid/src/pages/Card.jsx:1375`) |
| 4 | native sales ("Sold on Pokoin") | `solid/src/components/desk/NativeSales.jsx:21` → `market/src/api.js:2703-2705` | `/api/marketplace-native-sales?cardId` | **none anywhere**: no map, no storage, only the browser HTTP cache (`public, max-age=60, s-maxage=60, stale-while-revalidate=600`, `pokoin-rust/crates/commerce/src/handlers/orders.rs:3115-3121`) | **no** | renders nothing at all until it answers (`solid/src/components/desk/NativeSales.jsx:26`, `:27`) — a panel that pops in late when the card *has* Pokoin sales |
| 5 | version set (CLIP reprints, rarity circles) | `solid/src/pages/Card.jsx:544` → `market/src/api.js:914` | `/api/marketplace-version-set?cardId` | `localReader` memory 64 rows / 12 MB + IndexedDB (`market/src/local-read.js:36-37`, `:45`, `:82`); HTTP `public, max-age=60, s-maxage=600, stale-while-revalidate=3600` (`pokoin-rust/crates/catalog-api/src/pages/version_set.rs:132`); localStorage `pokoin.deskVersions.v1` rows only as this desk saved them (`solid/src/pages/Card.jsx:313`, `:918`) | **no** — `prefetchCardDesk` never asks it; only the `/versions` route warms it (`solid/src/lib/local-prefetch.js:52`) | the card-page `versions` + stored rows (`solid/src/pages/Card.jsx:314`, `:545`) |
| 6 | every printing with this exact name (rarity select, related fallback) | `solid/src/pages/Card.jsx:651` → `market/src/api.js:422` → `:1854-1859` | `/api/marketplace-list?kind=name&key=<hex>&format=c1v2[&dict=<id>]` (`market/src/api.js:1804`) | `localReader` only (`marketplace-list` is `ALWAYS` storable, `market/src/local-read.js:42`); no dedicated Map, no in-flight map of its own; HTTP `public, max-age=120, s-maxage=900, stale-while-revalidate=86400` (`pokoin-rust/apps/api/src/lists.rs:52`) | **no** | merged into the rows already painted (`solid/src/pages/Card.jsx:654`), invisible delay |
| 7 | buy-order book (Buy offers cell, OfferBar, Sell now) | `solid/src/lib/buy-book.js:87` → `market/src/buy-orders.js:52-55` | `/api/marketplace-buy-orders?card_id=<id>` (plus `fresh=<ms>-<n>` only after the visitor's own write, `market/src/buy-orders.js:54`) | **no memory map, no dedupe**; localStorage `pokoin.buybook.v1`, 40 cards, 30 min (`market/src/buy-orders.js:65-67`, `:88-111`), read at `solid/src/lib/buy-book.js:66`; HTTP `public, max-age=15` (`pokoin-rust/crates/commerce/src/handlers/buy_orders.rs:58`) | **no** | skeleton: `solid/src/components/deal/BuyOffers.jsx:58-63` (one shimmer row — `market/src/styles.css:4337` hides the 2nd/3rd), `solid/src/components/desk/OfferBar.jsx:419-424`, and **no note and no Sell-now button** on the Have-this-card bar (`solid/src/components/desk/ListingForm.jsx:529`, `:533`, fed by `solid/src/pages/Card.jsx:1598`, `:1599`, both null until the book is an array `:1034-1038`) |
| 8 | price history (Silver only) | `solid/src/pages/Card.jsx:489` → `market/src/price-history.js:92` | `/api/marketplace-card-price-history?cardId&from&to` | memory cap 32 + localStorage `pokoin.cardPriceHistory.v1.<id>.<range>`, TTL = the sales' 15 days (`market/src/price-history-cache.js:9-12`, `:15`); one ask per card+window per desk (`solid/src/pages/Card.jsx:475`, `:480`); gated on `accountSilver` (`:478`) | **no** | the graph draws without the extra lines; the 1,500 ms cap decides when it is drawn at all (`solid/src/pages/Card.jsx:458`, `:522`) |
| 9 | artist index (drag cover) | `solid/src/pages/Card.jsx:676` → `market/src/api.js:1525-1529` | `/api/marketplace-artist-cards?summaries=1&limit=1000&format=c1` | single-slot memory `artistSummariesCache` `market/src/api.js:1443`, returned with **no freshness test** (`:1522-1524`) + local store (`market/src/local-read.js:49`) | no, and it does not need to: this is the pattern that works | unchanged |
| 10 | print nationality | `solid/src/pages/Card.jsx:599` → `market/src/api.js:1668` | `/api/marketplace-expansion-page?slug&limit=1&format=c1` | unbounded Map `market/src/api.js:1605` + localStorage bag `pokoin.printNationality.v1` pruned past 2000 (`:1609-1627`), peek first (`solid/src/pages/Card.jsx:322`, `:596`) | no; keyed on the **set** name, so an in-set arrow step asks nothing (`solid/src/pages/Card.jsx:588`) | already known |
| 11 | canonical path | `solid/src/pages/Card.jsx:563` → `market/src/api.js:608` | `/api/marketplace-card-url?cardId&language` | `canonicalPathCache` LRU 48 + `canonicalPathInflight` (`market/src/api.js:578`, `:579`, `:612`) | no; only when landing without a slug (`solid/src/pages/Card.jsx:554-557`) | n/a |
| 12 | tile price overlay for the related rail | `solid/src/components/desk/RelatedCards.jsx:35` → `market/src/api.js:754` | `/api/marketplace-card-tiles?ids=…` | none | no | tiles paint without a price, then reconcile (`solid/src/components/desk/RelatedCards.jsx:37`) |
| 13 | view event | `solid/src/pages/Card.jsx:398`, `:1452` → `market/src/track.js:42-57` → `market/src/api.js:2257-2273` | `/api/marketplace-event` (sendBeacon, else `keepalive` fetch) | none, never deduped | n/a | n/a |
| 14 | recents rail | `solid/src/pages/Card.jsx:378-381` → `market/src/recents-rail.js:194` | rail tiles + `card-tiles` overlay | localStorage rail + `pokoin.recentRailAt` 10 min (`market/src/recents-rail.js:38`, `:42`) | n/a | off the critical path (`whenIdle`) |
| 15 | live listing rows | `solid/src/pages/Card.jsx:572` → `market/src/listing-live.js:31` | `/api/marketplace-live?cardId` (SSE) | none; one EventSource **per desk mount** | no | n/a |

---

## 3. The asynchronous sources and their races

Sources in this flow: (a) the router navigation, deferred one paint by
`solid/src/lib/yield-nav.js:20-29`, `:66-89`; (b) each fetch above; (c) three separate neighbour warmers —
hover `warm()` (`solid/src/pages/Card.jsx:1207-1210`), the router intent queue
(`solid/src/lib/local-prefetch.js:110-139`, `solid/src/lib/prefetch-queue.js:89-98`), and `warmupNeighbors`
(`market/src/api.js:2231-2242` from `solid/src/pages/Card.jsx:371`); (d) the hero gate
(`market/src/hero-gate.js:38-66`, closed at `solid/src/pages/Card.jsx:729`, opened only by
`solid/src/components/desk/DeskArtFrame.jsx:85`); (e) `whenIdle` (`solid/src/lib/idle.js:5-12`),
`afterPaint` (`solid/src/lib/yield-nav.js:20-29`), the `later` rAF+timeout
(`solid/src/pages/Card.jsx:568-571`), the 1,500 ms graph cap (`:458`, `:522`), the 40 ms stagger
(`market/src/api.js:2240`); (f) the effects that seed signals from the peeks at mount (`:257-316`);
(g) cache reads (`peekCard`, `peekListings`, `peekCardSales`, `readDeskListings`, `readBookCache`,
`localReader`).

**N1 — the mount read throws away the prefetched listings because the freshness window is 10 s and the
visitor spent longer than that reading. proven** (both branches are in the code)
1. `t=-N`: hover on the arrow → `solid/src/pages/Card.jsx:1449` → `warm()` (`:1207`) →
   `market/src/api.js:2227` → `market/src/api.js:2217` `fetchListings(id)` with no options → no `_=`, and
   `rememberListings` stamps `listingsAt[id] = now` (`market/src/listings-cache.js:165-173`). The intent
   queue does the same (`solid/src/lib/local-prefetch.js:44-46`).
2. `t=0`: click; new desk mounts. `solid/src/pages/Card.jsx:417` → `:345`
   `fetchListings(cardId, { fresh: true, maxAgeMs: 10_000 })` (`PREFETCH_FRESH_MS` `:170`).
3. `market/src/api.js:936-944`: the in-flight copy is gone, and `listingsAgeMs(id) <= maxAgeMs`
   (`market/src/api.js:941`, `market/src/listings-cache.js:176`) is false once the warm is >10 s old →
   falls through to `market/src/api.js:962-965`, appends `_=Date.now()` and fetches with `cache:'no-store'`.
4. `warmupNeighbors` (`market/src/api.js:2235`) warms the *next* neighbour at `t≈279` of the previous
   step, so any arrow press made more than 10 s later is by construction outside the adoption window. The
   trace's `t=5` `_=` request is this path.
   (Whether the lead's own click also skipped the hover warm because CDP does not fire `pointerenter` is
   **hypothesis**; either way the same line is reached.)

**N2 — a *known-empty* listings answer is not paintable, so the cell always opens blank and repaints.
proven**
1. `market/src/listings-cache.js:137-139` `peekHasListingRows` = `Array.isArray(listed?.listings) &&
   length > 0`. A prefetched `{listings: []}` — a real answer, "this card has nobody selling it" — is
   *not* rows. This split is deliberate and already pinned: `market/src/listings-cache.test.js:62-68`
   proves the empty answer *is* a cache hit and *is not* ready rows; the defect is that
   `solid/src/pages/Card.jsx:270-272` uses the second question to decide the first paint.
2. `solid/src/pages/Card.jsx:258` `listed = peekListings(cardId)` holds that answer; `:261` because
   `peekHasListingRows` is false it asks `readDeskListings`, which only an **opened** desk ever wrote
   (`solid/src/pages/Card.jsx:348`, `market/src/desk-listings-store.js:69`), so for a neighbour never
   opened it is `null`.
3. `solid/src/pages/Card.jsx:270` `shop.offers` therefore falls to `cached?.offers || []` — and `cached`
   cannot have offers: the desk asks for the page with `includeOffers: false`
   (`solid/src/pages/Card.jsx:426`, `market/src/api.js:858-861`).
4. `solid/src/pages/Card.jsx:272` `offersReady` initialises false → `CheapestListings` paints the count
   `0` (`solid/src/components/deal/CheapestListings.jsx:30`; `dealBookCount(0,0)` = `"0"`,
   `market/src/deal-book.js:105-107`) with the whitespace fallback
   (`solid/src/components/deal/CheapestListings.jsx:49`).
5. The answer (N1's `_=`) lands ~160 ms later → `solid/src/pages/Card.jsx:351` `setOffers([])` (a no-op) →
   `:353` `setOffersReady(true)` → the fallback switches to the text at
   `solid/src/components/deal/CheapestListings.jsx:50`. Same DOM slot, different content: the 84 → 90 px
   change.
   This fires on **every** visit to a zero-listing card, even when the client already knows it is empty,
   and even when the cached answer was adopted (the paint decision at `solid/src/pages/Card.jsx:270-272`
   uses `peekHasListingRows`, not "is there an answer").

**N3 — the buy book is serialized behind listings *and* behind an idle callback. proven**
1. `solid/src/pages/Card.jsx:1017` `createBuyBook({ cardId, ready: offersReady, … })`; the effect
   `solid/src/lib/buy-book.js:158-165` will not arm while `ready()` is false. Nothing can be asked before
   `offersReady` flips — which is `solid/src/pages/Card.jsx:353`, i.e. after the listings answer (~160 ms).
2. When it arms, `solid/src/lib/buy-book.js:162` re-seeds `setBook(() => stored())` and `:163` defers the
   request to `whenIdle(…)`, which is `requestIdleCallback(…, { timeout: 4000 })`
   (`solid/src/lib/idle.js:5-12`) — and the same turn already queued the recents rail
   (`solid/src/pages/Card.jsx:378-381`), the neighbour warm (`:371`), the rail thumbnails (`:941`) and the
   whole desk render.
3. `solid/src/lib/buy-book.js:87` → `market/src/buy-orders.js:52-55`: the request only then goes out —
   measured 994 ms. **proven** for the chain, **hypothesis** only for the exact 994 ms (that is when Chrome
   found idle).
4. The panel's own wait is a second, independent problem: `solid/src/lib/buy-book.js:66` reads the
   30-minute `pokoin.buybook.v1` slot (`market/src/buy-orders.js:65-67`, `:88-96`), which a
   prefetched-but-never-opened neighbour never filled — nothing writes it except
   `solid/src/lib/buy-book.js:92` in a desk that already answered.

**N4 — the neighbour prefetch competes with the page it follows, because the hero gate is already open.
proven**
`solid/src/pages/Card.jsx:369-371` `showCard` → `afterHero(() => warmupNeighbors(…))`. The gate is closed
at `solid/src/pages/Card.jsx:729` in an effect and opened by the hero `img` `onLoad`
(`solid/src/components/desk/DeskArtFrame.jsx:83-86`, `market/src/hero-gate.js:46-58`, `afterHero` `:63-66`).
For an arrow step the neighbour's scan was already downloaded on hover (`market/src/api.js:2214`, `:2221`),
so `onLoad` fires immediately and the gate opens within the same frame; the two warm requests go out at
279/285 ms — while the desk's own sales, version-set, name-list and (later) buy book are still owed.
`warmupNeighbors` is not idle-scheduled, not priority-tagged and not abortable: it calls `warmupCard`
directly (`market/src/api.js:2235`), which is outside the prefetch queue's 4-in-flight cap
(`solid/src/lib/prefetch-queue.js:54`) and its abort (`:100-107`), and it passes no `signal`, so
`market/src/local-read.js:203-207` has nothing to abort. `market/src/api.js:2240` staggers the second
neighbour by a fixed 40 ms, which is the only spacing it gets.

**N5 — three warmers for one target, none of them sharing bookkeeping. proven**
hover `warm()` (`solid/src/pages/Card.jsx:1207-1210`, immediate, unqueued), the router intent queue
(`solid/src/lib/local-prefetch.js:110-139` → `solid/src/lib/prefetch-queue.js:89-98`, idle + `repeatMs`
30 s at `:56`, `:91`), and `warmupNeighbors` (`market/src/api.js:2231-2242`). They overlap by design (dedup
is `listingsInflight` `market/src/api.js:950-953` for listings and the URL-keyed `localReader.inflight`
for the page, `market/src/local-read.js:190-198`), but the intent queue's capture-phase click handler
aborts everything except the clicked key on each click (`solid/src/lib/local-prefetch.js:121-126`,
`solid/src/lib/prefetch-queue.js:100-107`) — so pressing an arrow cancels the warm of the *other* arrow,
whose listings request however keeps running (it gets no `signal`, `market/src/api.js:2217`), leaving a
half-aborted warm that will not be re-queued for 30 s (`solid/src/lib/prefetch-queue.js:91`).

**N6 — a card-page the client already holds is re-read over the network by design, and the desk never
joins the route preload's request. proven (mechanism) / hypothesis (that it costs a full body here)**
`solid/src/pages/Card.jsx:257` `cached = peekCard(...)`; `:427` `fresh: Boolean(cached)` — precisely the
cached case forces `fresh`. `market/src/api.js:870` needs `!fresh` to return the hit; `:873` needs
`!fresh && !prefetch && !onUpdate` to adopt `cardInflight`, and the desk passes `onUpdate` (`:428`) — so
the desk neither registers into nor adopts that map, and `:901-903` returns the raw promise.
`market/src/local-read.js:277` then skips memory (`:283`) and store (`:290`) and goes to `network()` at
`:312`. The only remaining reuse is the browser HTTP cache (server `max-age=10`,
`pokoin-rust/apps/api/src/catalog_api.rs:266`). The `solid/src/router.js:36-38` comment ("the desk adopts
it (fetchCard dedupes in-flight requests)") is not what the code does on a desk mount; dedupe actually
happens one layer down, by exact URL, in `market/src/local-read.js:190-198` — and only while the preload is
still in flight and only for the identical `slug=` (compare `solid/src/router.js:48` with
`solid/src/pages/Card.jsx:425`).

**N7 — for `marketplace-list` and any read with the default freshness, a stored copy cannot prevent the
request. proven**
`market/src/local-read.js:298-300`: when the caller passed no `onUpdate`/`prefetch`, `maxStaleMs` is
`FRESH_MS` (`:278`), so the read *refuses to wait for IndexedDB* (`SLOW`) and calls `raceStore`
(`:240-269`), which dispatches the network first (`:241`). The store may still win and abort it (`:250`) —
but only if it answers before the response and the job has exactly one reader. This is the name-list
request at 15 ms, and it is why "cached in IndexedDB" does not mean "not fetched" for row 6 of the map.

**N8 — the version-set and name asks on the arrow step are warm-cache misses, not slow stores. proven
for version-set and the name list**
`market/src/api.js:2208-2225` `prefetchCardDesk` asks art + listings + card page only.
`marketplace-version-set` is storable (`market/src/local-read.js:45`) and would be served from the store
for a desk whose own `fetchVersionSet(…, { onUpdate })` revalidated it — `maxStaleMs` there is 3 days
(`market/src/local-read.js:278`, via `market/src/api.js:885` and `staleLimit` `:799-801`), and the store is
given 25 ms to answer (`STORE_WAIT_MS`, `market/src/local-read.js:33`; the measured 24 ms request sits
right at that boundary — **hypothesis** for this particular click, **proven** that a first-ever step for a
card has no row to serve).

**N9 — an answer that equals the painted one still re-plots the graph. proven**
`solid/src/pages/Card.jsx:533` `setSalesSlices(data.slices)` writes a fresh array with no equality check,
so `salesView` (`:627`), `salesSeries` (`:628`) and `solid/src/components/desk/SoldPriceGraph.jsx:245`'s
`plot` memo recompute — a full SVG re-render on every step even when the slices came from the cache
seconds earlier. The history path shows the intended discipline: `solid/src/pages/Card.jsx:497` keeps
`prev` when the JSON is equal.

**N10 — the graph's facet changes after the listings, so it draws once for the wrong facet and again for
the right one. proven**
`shownCond` (`solid/src/pages/Card.jsx:768-772`) returns the bare default while `!offersReady()`, then the
best *listed* facet; the effect at `:782-786` pushes those into
`salesCondition`/`salesLanguage`/`salesReverse`, which feed `salesFilterState` (`:619-626`) → `salesView`
→ the plot. Sequence on an arrow step: plot (from cached slices, default facet) → facet moves when
listings land (~160 ms) → slices replaced (N9). Three passes of one line, and all three are avoidable
because N2 alone fixes the first.
`graphDrawn` also cannot be true at the first frame for a non-Silver visitor: `priceHistory` initialises
`null` unless Silver (`solid/src/pages/Card.jsx:464-466`), the initial `graphDrawn` needs *both* (`:472-474`),
and only the effect at `:510-525` opens it after render — so the plot appears one commit after the desk
(`solid/src/components/desk/SoldPriceGraph.jsx:518` with `props.series == null`;
`solid/src/pages/Card.jsx:810` returns null).

**N11 — the "All <name>" rail is torn down and rebuilt on every step. proven**
`later` starts false (`solid/src/pages/Card.jsx:330`), is raised by `onSettled` → rAF → `setTimeout(…, 0)`
(`:568-571`), and gates the rail and the catalog fold (`:1902`). Because the desk remounts (`:225`), that
wait happens on every arrow press: the rail disappears with the old desk and returns a frame plus a task
later, rebuilt from `related()` (`:943-948`) — for a card whose page has no server related, from the
name/version pools that the step itself is still fetching (map row 6, N7).

**N12 — the live-listings channel is rebuilt per step and its first events are dropped. proven**
`solid/src/pages/Card.jsx:572` opens an EventSource per desk (`market/src/listing-live.js:29-40`), the
cleanup closes it (`:582`). Its handler returns immediately when the cell has no rows (`:573`), so any
listing event that arrives during the N2 blank window is discarded — the panel can miss a real change and
keep showing the pre-click state until the next read.

**N13 — no answer for a *previous* card can paint on the new desk; the guards hold. proven (a negative
finding, worth stating because it rules out the usual suspect)**
Each desk instance closes over its own `cardId` (`solid/src/pages/Card.jsx:238`), sets `disposed` in the
`onSettled` cleanup (`:578`) and re-checks it in every continuation (`:349`, `:368`, `:491`, `:527`,
`:540`, `:564`, `:600`, `:683`); the name-list effect aborts on change (`:650`, `:657`); the caches are
keyed by card id (`market/src/listings-cache.js:134`, `market/src/api.js:553`, `neighborCache` `:2080`).
The reported glitch is therefore **not** a stale-answer clobber; it is ordering (N1-N4), a too-narrow
definition of "known" (N2), and repaints of unchanged data (N9-N11).

---

## 4. Why each measured symptom happens

**Cheapest listings `0` + blank (84 px) → "No listings yet." (90 px), and the Buy offers cell moving with
it.**
Both states are the *same* slot: `solid/src/components/deal/CheapestListings.jsx:45-53`. `props.ready` is
`offersReady()` (`solid/src/pages/Card.jsx:1778`), which `solid/src/pages/Card.jsx:272` initialised false
for exactly the reason in N2 and which `:353` flips when the read answers. The two DOM states differ by
one text line: `<p class="status"> </p>` (`solid/src/components/deal/CheapestListings.jsx:49`) collapses
to an empty inline box (whitespace-only) and contributes no line box, while
`<p class="status">No listings yet.</p>` (`:50`) contributes one — the paddings around them are shared
(`market/src/styles.css:12093-12094`, `:3610`, `:1169`). The height then propagates sideways because
`cheap` and `offers` are one grid row of `.card-desk` with `align-items: stretch`
(`market/src/styles.css:3673-3678`; the two cells are `grid-area: cheap`/`offers` `market/src/styles.css:4033`,
`:4038`, both `.desk-cell` `:4280-4291`), which is the documented intent at `market/src/styles.css:4329-4336`
("the pair stays level because the grid stretches the shorter one to its neighbour"). The count `0` itself
is not a fetch artefact: `dealBookCount(0, 0)` = `"0"` (`market/src/deal-book.js:105-107`) is what an empty
`shop.offers` always says.

**Buy offers empty until ~1,260 ms.**
N3. `book()` is `null` (nothing stored for a never-opened neighbour, `solid/src/lib/buy-book.js:66` +
`market/src/buy-orders.js:88-96`), so `solid/src/components/deal/BuyOffers.jsx:53-64` renders the
`is-loading` cell: title only, no count (`:69` is in the other branch), and one shimmer row
(`market/src/styles.css:4337`, `:13117`). At ~994 ms the request goes out, ~1,260 ms
`solid/src/lib/buy-book.js:91` sets `[]`, and the cell renders the house-offer line
(`solid/src/components/deal/BuyOffers.jsx:76-90`) — a `.cell-empty` text line
(`market/src/styles.css:12096-12100`) rather than a 2.4 rem skeleton row, so the cell changes height again
and drags the listings cell with it (same grid row). Note the desk's own skeletons are *not* subject to the
"wait 250 ms before showing a skeleton" rule (`market/src/styles.css:2646-2665` lists `.tile-skel`,
`.shop-row-skel`, `.skeleton-*`, `.wait-text`; `.cell-skel` and `.offer-bar-skel` are absent), so the
visitor stares at a shimmer for 1.1 s. The Have-this-card bar is silent in the same window:
`solid/src/pages/Card.jsx:1034-1038` returns `null` while the book is `null`, so
`solid/src/components/desk/ListingForm.jsx:529` (note) and `:533` (Sell now button) are both missing, and
`solid/src/components/desk/OfferBar.jsx:78` keeps its skeleton (`:419-424`).

**The cache-busting `_=`.**
`market/src/api.js:962-964`, gated only by `fresh`. The desk always passes `fresh: true`
(`solid/src/pages/Card.jsx:345`) — the intent is "listings are live" (`solid/src/pages/Card.jsx:404-406`,
`docs/PAINT_FROM_LAST_ANSWER.md` rule 2) — and `maxAgeMs` 10 000 (`solid/src/pages/Card.jsx:170`, `:417`)
is the only thing that lets the prefetched copy stand in (N1 step 3). Nothing else about the request is
wasteful: the same path *without* `fresh` is exactly what the hover and neighbour warm ask
(`market/src/api.js:2217`), and the server says `private, no-store`
(`pokoin-rust/crates/commerce/src/handlers/listings.rs:589` → `pokoin-rust/crates/commerce/src/handlers/mod.rs:32`)
with the client forcing `cache:'no-store'` (`market/src/api.js:966`), so a `_=` URL is never cached and
never deduped either. The bug is the window, not the parameter.

**The graph redraw on navigation.**
N9 (`solid/src/pages/Card.jsx:533`, no equality guard), N10 (`:768-772` + `:782-786` + `:627`), and the
one-frame hold in `:472-474` / `:510-525`. Plus the Silver variant: `:487` paints the stored window, `:489`
re-reads it and `:495-497` writes it back, which does *not* redraw when nothing changed — so a Silver
account's redraw on an arrow step comes from the sales/facet path, not from the history.

**The two requests at 279/285 ms (the next neighbour).**
N4: `solid/src/pages/Card.jsx:371` → `market/src/api.js:2231-2242`, fired from `showCard` the moment the
card page lands and the hero is (already) loaded. They are the right requests — they warm the arrow the
visitor will press next — but they are fired at the worst moment and cover only 2 of the 8 things the next
desk will ask (map rows 3-8).

---

## 5. Proposal — the smallest change per panel

Governing rules: `docs/PAINT_FROM_LAST_ANSWER.md` 1 (paint from the last answer), 2 (revalidate in the
background, never blank for it), 3 (touch the DOM only when the data differs), 4 (skeletons reserved and
delayed). Keep `solid/src/pages/Card.jsx:510-525` (draw-once) and the Silver gate
(`:464-466`, `:478`, `:507-509`) exactly as they are — none of the below asks a non-Silver account for
price history.

**P1 — listings cell: "known" must mean "an answer", not "a non-empty array". (N2)**
`market/src/listings-cache.js`: export `listingsKnown(cardId, maxAgeMs)` = "the cache holds an answer for
this id" (`:133-139` already knows the difference; an empty `rows` is called a real answer in
`market/src/desk-listings-store.js:36` — the memory cache should say the same).
`solid/src/pages/Card.jsx:261`, `:270`, `:272`: seed `shop.offers` from `listed.listings` when
`listingsKnown`, and initialise `offersReady` from the same test.
`solid/src/components/deal/CheapestListings.jsx:45-53` then never
renders the whitespace state for a card the client already knows is empty: one paint, "No listings yet.",
and the 84 → 90 px step is gone. The revalidation still runs and `solid/src/pages/Card.jsx:351` still
refuses to wipe painted rows.

**P2 — listings cell: widen the adoption window, keep the revalidate. (N1)**
`solid/src/pages/Card.jsx:170` `PREFETCH_FRESH_MS` 10 000 → 120 000 (2 minutes), or make the mount read
`fetchListings(cardId, { fresh: false, maxAgeMs: 0 })` when `listingsKnown` and let
`subscribeListingLive` (`solid/src/pages/Card.jsx:572`, `market/src/listing-live.js:29`) carry the
freshness — that channel already patches quantities. Either way the arrow step makes **zero**
`marketplace-listings` requests for a card that was warmed a moment ago, and the click-driven `_=`
disappears. Keep `fresh: true, maxAgeMs: 0` at `solid/src/pages/Card.jsx:1160` (after the visitor's own
listing) — there the re-read is the point.

**P3 — reserve the two cells' height so the answer cannot move the row. (N2, N3)**
`market/src/styles.css`: give `.desk-cell .cell-empty` (`:12096-12100`) and `.desk-cell .empty-shop`
(`:12093`) the same box as one row (`.cell-skel > span` is 2.4 rem, `:13117`;
`.cell-cheap .shop-row` is `min-height: 2.4rem`, `:12105-12112`) — i.e. `min-height: 2.4rem` on
`.desk-cell > :not(.cell-title)` — and add `.cell-skel`, `.offer-bar-skel` to the `skel-appear` list
(`:2654-2665`) so a desk that paints from cache never shows a skeleton at all.

**P4 — buy offers: paint the house line from the first frame; ask at idle with a short cap; warm it.
(N3, N4)**
The line the visitor waits for — "Pokoin buys it for 0.0375 DKK · Sell · Make offer" — is computed from
`HOUSE_OFFER_PKN` (`market/src/buy-orders.js`, used at `solid/src/components/deal/BuyOffers.jsx:81` and
`solid/src/pages/Card.jsx:1037` via `withHouseOffer`), not from the network. So:
- `solid/src/lib/buy-book.js:66-67`: when nothing is stored, seed `book` with `[]` and expose a separate
  `known()` flag; `solid/src/components/deal/BuyOffers.jsx:53` gates on `known()` instead of
  `Array.isArray(book())`, and the empty branch (`:76-90`) paints immediately. Same for
  `solid/src/components/desk/OfferBar.jsx:78` (`loading()` = `!known()`) and the sell strip
  (`solid/src/pages/Card.jsx:1034-1038`: return `withHouseOffer(null)` rather than `null` when the book is
  unknown).
- `solid/src/lib/buy-book.js:158-165`: drop the `ready()` conjunct from the dependency (listings do not
  gate the book) and pass a bounded idle: `whenIdle(() => load(id), 300)` (`solid/src/lib/idle.js:5`).
  Keep `solid/src/lib/buy-book.js:162`'s re-seed.
- `market/src/api.js:2208-2225` `prefetchCardDesk`: take a `book` flag and call `fetchBuyBook(id)` →
  `writeBookCache` (`market/src/buy-orders.js:99-111`) so the neighbour's warm is also what the next desk
  paints from. Then P4's first-frame line is accurate rather than a guess for cards that do have buyer
  offers.

**P5 — warm the whole next desk, at idle, behind the current page's reads. (N4, N5, N8)**
`market/src/api.js:2208-2225`: add to `prefetchCardDesk`, behind flags, `fetchVersionSet(id, { prefetch:
true, signal })`, `fetchExactNameCards`/`fetchListSnapshot('name', …)` with `{ prefetch: true }`,
`fetchCardSales(id, { slices: true })` → `saveCardSales`, and `fetchNativeSales(id)`. Passing
`prefetch:true` is what makes the warm useful: `market/src/local-read.js:298-300` then *waits* for the
store instead of dispatching the network on a memory miss (N7), so a card warmed twice costs nothing the
second time. `solid/src/pages/Card.jsx:369-371` and `:550-553`: move the warm behind `whenIdle`
(`solid/src/lib/idle.js:5`) inside the `afterHero`, and route it through the existing prefetch queue
(`solid/src/lib/local-prefetch.js`) so it inherits `maxInFlight: 4`
(`solid/src/lib/prefetch-queue.js:54`), `priority: 'low'` (`market/src/local-read.js:189`) and the
navigation abort (`solid/src/lib/prefetch-queue.js:100-107`) instead of three uncoordinated warmers. One
warmer, one schedule.
Suggested order inside the warm, cheapest-and-most-visible first: card page, listings, sales, version set,
buy book, name snapshot, native sales.

**P6 — the graph: stop repainting what did not change. (N9, N10)**
`solid/src/pages/Card.jsx:533`: mirror the history's guard (`:497`) — keep the previous array when the
answer equals it, with a small pure helper in `market/src/sold-sales.js` next to `soldGraphView`. With
P1/P2 the facets are already settled at the first frame, so the effect at `:782-786` no longer moves the
filters after the plot: the graph draws once, from the cached slices, and a repeat answer changes nothing.
Do not touch `:472-474`, `:510-525` or `:458`.

**P7 — "Sold on Pokoin": stop arriving late or stop being a surprise. (map row 4)**
`solid/src/components/desk/NativeSales.jsx:16-24` fetches inside a `createMemo` with no cache at all.
Give it the sales-cache pattern (`market/src/sold-sales-cache.js`: memory + localStorage keyed by card id,
15-day TTL at `:2`) or fold the rows into the card-page payload it already waits for, and warm it with P5.
Keep `fallback={null}` (`solid/src/components/desk/NativeSales.jsx:26`) only for the genuine first-ever
visit; with a cache the panel is present at the first paint or absent, never inserted mid-glance.

**P8 — the rail: do not hide it again on a neighbour step. (N11)**
`solid/src/pages/Card.jsx:568-571`: raise `later` without the rAF/task wait when this desk mounted from a
warm cache (the same `cached` test as `:257`/`:550`) — the wait exists to get the tile click painted first
(`:328-330`), which does not apply one step into a set. The `onSettled` cleanup (`:578-584`) stays.

**P9 — the SSE handler must not drop events into an empty cell. (N12)**
`solid/src/pages/Card.jsx:572-577`: apply the frame to the rows it is about to write even when the cell is
still empty but an answer is known (P1), instead of returning at `:573`.

Files a fix touches: `solid/src/pages/Card.jsx`, `solid/src/lib/buy-book.js`, `market/src/api.js`,
`market/src/listings-cache.js`, `market/src/buy-orders.js`, `market/src/sold-sales.js` (new helper),
`solid/src/components/desk/NativeSales.jsx`, `solid/src/components/deal/BuyOffers.jsx`,
`solid/src/components/deal/CheapestListings.jsx` (untouched if P1 lands in `Card.jsx`),
`solid/src/components/desk/OfferBar.jsx`, `solid/src/lib/local-prefetch.js`, `market/src/styles.css`.
`docs/FEATURES.toml`: the `card-page` flow (`:343-350`) and `sold-prices` (`:375-382`) gain this proof
file in `proof` (AGENTS.md, "Feature map").

---

## 6. Tests the fix needs (docs/CI.md, "JavaScript tests")

New files are picked up automatically by the group globs (`scripts/js-test-groups.txt:7` for
`market/src/*.test.js`, `:9` for `solid/src/**/*.test.js`); nothing may go into
`scripts/js-tests-not-in-gate.txt`.

1. **`market/src/card-arrows-trace.test.js` — the replay the brief asks for.** A scripted `fetchText` (the
   seam `market/src/api.js:127` and `market/src/local-read.js:81` already uses) + the real
   `fetchListings`/`fetchCard`/`fetchVersionSet`/`fetchBuyBook`, the real `prefetchCardDesk`
   (`market/src/api.js:2208-2225`) and a fake clock. Interleave in the order the lead measured — hover →
   click → mount — and assert: (a) a listings warm ≤ 2 min old produces **no** `marketplace-listings`
   request and no `=_` in any URL; (b) `marketplace-buy-orders` is asked without waiting for listings and
   inside the bounded idle; (c) `marketplace-version-set`, `marketplace-list`,
   `marketplace-card-sales` and `marketplace-native-sales` for 813624 appear in the *warm* set, so a step
   after a warm asks none of them; (d) the neighbour warm does not start before the current desk's own
   reads have been dispatched.
2. **`market/src/listings-cache.test.js` (extend)** — `listingsKnown` is true for a stored **empty**
   answer and false for nothing; the adoption window accepts a warm copy and rejects a stale one; an empty
   live answer never removes known state (the rule now written at `solid/src/pages/Card.jsx:351`,
   expressed on the cache).
3. **`market/src/card-desk-warm.test.js` (new)** — `prefetchCardDesk` with the new flags issues the six
   warm reads and passes `prefetch: true` to the local-storable ones (so
   `market/src/local-read.js:298-300` waits for the store), and the neighbour warm reaches `fetchText`
   with `priority: 'low'` (`market/src/local-read.js:189`).
4. **`solid/src/lib/buy-book.test.js` (new)** — `book()` is an array on the first frame when nothing is
   stored; `known()` flips only with the answer; the read does not wait for `ready()`; `whenIdle` carries
   the 300 ms cap; an answer equal to the painted rows does not re-set the signal.
5. **`solid/src/paint-from-last-answer.test.js` (update — it currently pins the buggy line)** — `:20`
   asserts `createSignal(peekHasListingRows(listed) || Boolean(stored))`, i.e. exactly N2's mistake; it
   must assert the `listingsKnown` form and that a known-empty desk never renders the whitespace state.
   **`market/src/listings-cache.test.js:62`** ("empty listings cache is a hit but does not count as ready
   rows") pins the *cache* semantics that N2 depends on; the fix should keep that test's first assertion
   and change only what the desk does with it — say so in the PR, because touching a passing test needs a
   reason.
6. **`solid/src/pages/Card.test.js` (extend, in that file's source-pinned style)** — pin: the neighbour
   warm sits inside `whenIdle`; `setSalesSlices` is guarded by an equality check; `later` is raised without
   the frame wait on a warm mount; and the things that must stay (`graphDrawn` effect
   `solid/src/pages/Card.jsx:510-525`, `GRAPH_HISTORY_WAIT_MS` `:458`, the Silver gate `:464-466` and
   `:478`) with `doesNotMatch` for any new unguarded `setSalesSlices` or unconditional
   `fetchCardPriceHistory`.
7. **`solid/src/components/deal-panels.test.js` (new)** — `solid/src/components/deal/BuyOffers.jsx`
   renders the house line from `known()=false, book()=[]` and keeps one reserved row;
   `solid/src/components/desk/OfferBar.jsx`'s `loading()` reads `known()`.
8. **`market/src/card-arrows-heights.test.js` (new)** — a CSS assertion in the style the repo already uses
   for `market/src/styles.css`: `.cell-skel` and `.offer-bar-skel` appear in the `skel-appear` selector
   list (`:2654-2665`), and the empty/answered states of `.desk-cell` share a `min-height`.

---

## 7. What could not be determined from the code alone

1. **Why the `_=` fired for this click**: N1 (the warm was >10 s old) or a CDP click that never produced
   `pointerenter` and so never ran `warm()`/the intent queue. Both reach the same line; only a trace with
   pointer events distinguishes them.
2. **The exact 994 ms**: `whenIdle` is `requestIdleCallback(…, {timeout: 4000})`
   (`solid/src/lib/idle.js:5-12`) — the real fire time is Chrome's idle scheduling under the desk's work,
   not a constant in the repo.
3. **The 24 ms version-set ask**: a store miss (first-ever step for that card) or the 25 ms
   `STORE_WAIT_MS` race (`market/src/local-read.js:33`, `:300`) losing to IndexedDB startup. Needs a
   store-state dump.
4. **Whether `preloadCard` (`solid/src/router.js:40-54`) runs again on a param-only navigation** in
   `@solidjs/router` 2.0.0-next.38 (`solid/package.json:12`) — there is no `node_modules` in this worktree
   and the version is a prerelease, so the "the desk adopts it" claim at `solid/src/router.js:36-38` could
   not be verified end to end; if it does run, N6 means two card-page dispatches joined only by
   `market/src/local-read.js:190-198`.
5. **What the production payload sizes and server timings were** (the 160 ms listings answer, the ~1,260 ms
   book answer): the code fixes when each request *starts*, not how long the API takes.
6. **Whether card 813624 really had zero listings and zero buyer offers** at the time of the trace. The
   symptom analysis only needs the client's *inability to say so* before the answer (N2, N3).
7. **Silver behaviour**: the price-history path (`solid/src/pages/Card.jsx:458-509`,
   `market/src/price-history-cache.js`) and `/api/marketplace-card-price-history` were read but not
   measured — the lead's trace is signed out.
8. **Solid 2's scheduling of the keyed remount** (`solid/src/pages/Card.jsx:225`) — the ordering of
   dispose-cleanup vs new-desk setup vs the `onSettled` rAF (`:568`) is assumed from Solid's documented
   model, not from a run of this build.
9. **Whether the 84 → 90 px pair is exactly the whitespace-vs-text line box**: the two DOM states and the
   shared stretch row are proven (`market/src/styles.css:3673-3678`, `:4329-4336`); the pixel arithmetic
   depends on the computed font metrics of the production build.
