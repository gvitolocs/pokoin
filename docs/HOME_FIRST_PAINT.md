# Marketplace home first paint

The JSON vector is not the delay you feel. On a warm Worker it is ~45 KB and
caches after the first miss. Skeletons used to wait on **auth + Firestore +
(maybe) extra tiles**, then **catalog JPEGs** started. That stack is what felt
like “over a second.”

Do not regress this. Product rules live with the rails table in
[MARKET.md](MARKET.md). This file is the measured pipeline, the industry
map, and the files that enforce it.

---

## What we measured (5 Sep 2026)

| Hop | Size / time | On the LCP path? |
| --- | --- | --- |
| Public rails JSON (Worker / Supabase vector) | ~45 KB after assemble; first miss builds from five `marketplace_rails` rows | Yes — this is the shell |
| Flutter `GET /api/marketplace-home` on **api.pokoin.com** | **170 KB**, 120 cards, **no** `newArrivalIds` | Must **not** be. SPA used to accept it because `cards.length > 0` |
| Oracle `GET /api/marketplace-home-page` | ~26 KB, New cards only; Featured / Best empty | Fallback only |
| Firebase `onAuthStateChanged` (`useAuth().ready`) | hundreds of ms | **No** |
| Firestore `user_card_recent_views/{uid}` | `getDoc` after auth | **No** — Recently seen only |
| `GET /api/marketplace-card-tiles` | Oracle **404**; Worker on pokoin.com | **No** — leftover recents after paint; SPA falls back to Supabase `marketplace_card_tiles` |
| Catalog leftover JPEG (Lucario ex) | **166 KB** | **No** — desk / hero only |
| `_homepage.webp` sibling (240px, q82) | **26 KB** | Yes — grid / carousel |

From this host, `https://pokoin.com/api/marketplace-home` is Cloudflare WAF
**403** (`Your request was blocked`). Real browsers still hit
`workers/pokoin-origin.js`. Vite proxies `/api` to `api.pokoin.com`, so local
dev must **not** call Flutter home. Production SPA rejects that payload even
if the Worker is skipped (`isPublicRailsVector`).

Homepage WebP coverage (same day, still backfilling): R2 had ~115k leftover
JPEGs and ~81k `_homepage.webp`; `marketplace_cards.homepage_image_url` was
backfilled for tens of thousands of rows. Generator:
`cardvault/.../scripts/generate-oracle-homepage-card-images.js` (R2) and
`generate-oracle-disk-homepage-webp.py` (peer1 disk). Missing siblings 404 →
`CardArt` falls back to JPEG.

---

## Critical path (must stay this order)

```
sessionStorage pokoin.homeVector.{game}   (10 min, recents stripped)
        │  paint New / Best / Featured / Popular / grid immediately
        ▼
GET rails vector  (no Firebase wait)
  production:  pokoin.com /api/marketplace-home  → Worker Cache API hit
               waitUntil revalidate vs rails.updated_at
  vite/dev:    five Supabase marketplace_rails reads (fetchHomeFromLists)
        │  attachRecentsToHome(localStorage pokoin.recentCardIds)  — sync
        ▼
<img src="/card-images/{leftover}_homepage.webp">
        │  onError → same key .jpg
        ▼
(after paint) leftover recents → marketplace_card_tiles / Worker tiles
(after ready)  syncRemoteRecentCardIds() Firestore merge
```

Skeletons:

- **New / Best / Featured / Popular / grid** — only while there is **no**
  session cache **and** the rails fetch has not returned.
- **Recently seen** — only if local ids exist and those cards are not already
  in the vector. Never block the other rails for that row.

---

## What used to block paint

`Home.jsx` waited for `useAuth().ready`, then `loadRecentCardIds()` (Firestore
`getDoc` when signed in), then `fetchHome(ids)`. `fetchHome` accepted Flutter
hydrate and `Promise.all`’d extra tiles with the rails. `CardTile` asked for
`imageSrc(..., 'grid')` which `preferFullImage` turned into the leftover JPEG.
The Worker looked up Supabase `rails.updated_at` **before** `caches.default.match`.

Each of those is now illegal on the LCP path.

---

## Industry map (what we copied)

Pokoin is a Vite SPA, not Next. The rules still apply: **public catalog is a
shared cache; session is a hole that streams later.**

| Rule | Upstream | Pokoin |
| --- | --- | --- |
| Session must not sit in the static / shared shell | [Next.js Cache Components — authentication](https://nextjs.org/docs/app/guides/authentication-with-cache-components). Authenticated UI goes behind a boundary; the rest prerenders. [Vercel example: `"use cache"` + Supabase, auth **not** cached](https://github.com/vercel/next.js/pull/92225). Tenant/user id is a cache key, never mixed into the public blob ([Hamza Shabbir on Next 16 `'use cache'`](https://hamzashabbir.dev/article/nextjs-16-use-cache-migration-cross-tenant-leak)). | `fetchHome` does not wait on `useAuth().ready`. Recents are not stored in the Worker JSON or in `sessionStorage pokoin.homeVector.*`. |
| Serve stale, revalidate in the background | [RFC 5861 `stale-while-revalidate`](https://datatracker.ietf.org/doc/html/rfc5861). Shopware store APIs and [edge marketplace SWR](https://dev.to/opttoyschina/stale-while-revalidate-on-the-edge-how-our-marketplace-killed-the-cold-start-and-kept-3do2) use the same split: public cache, personalize on the client. Cloudflare Cache API `match` then `waitUntil(put)`. | `stableHomeCacheRequest` strips `?v=`. Hit returns immediately. `revalidateHome` compares `x-pokoin-rails-updated-at`. Browser `max-age=120`, `s-maxage=600`, SWR a day. |
| Guest local, signed-in merge | Shopify / headless carts: persist locally (cookie or storage), sync to the customer record after login ([AuditBuffet cart-sync](https://auditbuffet.com/patterns/ab-001097), Shopify metafield cart restore). Amazon does the same for recently viewed. | `localStorage pokoin.recentCardIds` (24) paints first. Firestore `user_card_recent_views/{uid}` merges **after** `ready`. |
| Thumbnails ≠ masters | Every mature marketplace CDN (Shopify `cdn/shop`, eBay EPS, TCGPlayer) ships a small tile derivative and keeps the master for PDP zoom. | Catalog master = leftover-key JPEG. Home/search tile = `{key}_homepage.webp` (240px, q82). Desk still uses JPEG. |

Do **not** put recents into `'use cache'` / Cache API. That is the cross-user
leak the Next 16 guides exist to prevent.

---

## Endpoints (do not mix these up)

| URL | Host | What | SPA |
| --- | --- | --- | --- |
| `GET /api/marketplace-home` | **pokoin.com** (Worker) | Rails vector, Cache API, no recents | Production first hop, only if `isPublicRailsVector` |
| `GET /api/marketplace-home` | **api.pokoin.com** | Flutter hydrate ~170 KB, server `recentlySeenIds`, no `newArrivalIds` | **Reject** |
| `GET /api/marketplace-home-page` | api.pokoin.com | Oracle newest / spotlight ~26 KB; Featured/Best often empty; JPEG grid URLs | Last resort |
| `GET /api/marketplace-home-page` | pokoin.com Worker | Alias of the rails vector (`isHomePath`) | Same as Worker home |
| Supabase `marketplace_rails` | `ruvtchmbtxvjqmquobij.supabase.co` | Source of truth for the vector; TILE_SQL writes `_homepage.webp` into grid/tile | Vite/dev first hop; production fallback |
| `GET /api/marketplace-card-tiles?ids=` | Worker on pokoin.com | Public tile payloads | After paint, production |
| same path | api.pokoin.com | **404** `API route not found` | Do not wait on this in Vite |

`isPublicRailsVector` is true when `source === 'supabase'` **or** the payload
has non-empty `newArrivalIds` **and** `featuredIds` **and** `bestSellerIds`.
Flutter fails the first. Oracle newest-only page fails Featured/Best.

---

## Client files

| File | Job |
| --- | --- |
| `market/src/pages/Home.jsx` | Paint from session cache. `fetchHome` in an effect that does **not** list `ready`. Second effect: Firestore after `ready`. Tiles only for `missingRecentIds`. |
| `market/src/lists.js` | `fetchHomeFromLists` (rails only, no `Promise.all` with tiles). `attachRecentsToHome` is sync and returns `missingRecentIds`. `fetchCardTiles` skips the Oracle 404 in Vite. |
| `market/src/api.js` | `fetchHome`: Worker (prod) → lists → home-page. Never treat Flutter hydrate as success. |
| `market/src/home-cache.js` | `sessionStorage pokoin.homeVector.{game}`, 10 min, recents stripped. |
| `market/src/recents.js` | Local 24 ids. `syncRemoteRecentCardIds` is the Firestore merge. `loadRecentCardIds` is an alias — do not call it on LCP. |
| `market/src/image-urls.js` | `homepageDerivativeUrl` for grid. `preferFullImage` for desk (strips `_homepage.webp` → JPEG). `rasterSiblings` only falls back webp→JPEG, never upgrades a JPEG src. |
| `market/src/components/CardTile.jsx` | `imageSrc(card, 'grid')`. First 8 `loading=eager`, first 4 `fetchPriority=high`. |
| `market/src/components/CardArt.jsx` | Grid: walk webp then JPEG. `full` (desk, zoom, promo fan): leftover JPEG only. |
| `workers/marketplace-home.js` | `stableHomeCacheRequest`, match-before-Supabase, `waitUntil` revalidate. Tiles path is separate. |
| `workers/pokoin-origin.js` | Dispatches home before `fetch` to origin. |
| `scripts/sync-supabase-rails.py` | `TILE_SQL` grid/tile → `_homepage.webp`; hero stays JPEG. |

Tests: `market/src/home-cache.test.js`, `lists.recents.test.js`,
`image-urls.test.js`, `workers/marketplace-home.test.mjs`.

---

## Do not regress

1. Do not gate `fetchHome` on `useAuth().ready`.
2. Do not `await getDoc(user_card_recent_views)` before the public vector.
3. Do not `Promise.all` `fetchCardTiles` with rails.
4. Do not `caches.default.match` only after a Supabase `updated_at` round-trip.
5. Do not accept `GET /api/marketplace-home` from api.pokoin.com as the SPA
   vector (`cards.length` is not enough).
6. Do not point Vite `/api` at pokoin.com from this datacenter (WAF 403).
7. Do not put recents into the Worker body or `pokoin.homeVector.*`.
8. Do not use leftover JPEGs as grid `src` when a `_homepage.webp` sibling
   can be derived.
9. Do not show New-cards skeletons because Recently seen is still loading.

---

## Verify

```bash
node --test market/src/home-cache.test.js market/src/lists.recents.test.js \
  market/src/image-urls.test.js workers/marketplace-home.test.mjs

# local SPA (Vite 5174). First paint must not request Flutter home.
# Network: marketplace_rails (and set rails for the promo), then _homepage.webp.
# Reload: sessionStorage paints rails before the network returns.
```

Measured on Vite `127.0.0.1:5174/marketplace` (5 Sep 2026, unsigned, Playwright):

| Visit | Time to New cards + ≥4 tile images |
| --- | --- |
| Cold (no `pokoin.homeVector`) | **284 ms** |
| Reload with session cache | **141 ms** |

No `api.pokoin.com/api/marketplace-home` hop. No Firestore on that path.
Mega Lucario desk stayed leftover JPEG; grid stayed `_homepage.webp`. Wondrous
Patch / Juniper 404 webp fell back to `.jpg`. After opening a card, Recently
seen filled from `localStorage` without emptying the other rails.

On a signed-in profile, Recently seen may fill after the other rails. That is
correct. Identity, listings, and CartTrader live asks stay off this page’s
first paint ([MARKET.md](MARKET.md) card-page speed notes).
