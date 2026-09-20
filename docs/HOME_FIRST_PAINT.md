# Marketplace home first paint

The JSON vector is not the delay you feel. On a warm Worker it is ~45 KB and
caches after the first miss. Skeletons used to wait on **auth + Firestore +
(maybe) extra tiles**, then **catalog JPEGs** started. That stack is what felt
like “over a second.”

Do not regress this. Product rules live with the rails table in
[MARKET.md](MARKET.md). Card-art surfaces (tile vs suggest crop vs desk):
[CARD_ART.md](CARD_ART.md). This file is the measured pipeline, the industry
map, and the files that enforce it.

**2026-09-06 / 2026-09-11:** Browse rails live on **Pi Postgres replica**
(`marketplace_rails` / `marketplace_card_tiles`). CardTrader dumps write on
Oracle `pokoin-marketplace`. There is **no Supabase** on this path. The origin
Worker reads `https://api.pokoin.com` (pi-home). Vite `/api` already proxies there.

---

## What we measured (5 Sep 2026)

| Hop | Size / time | On the LCP path? |
| --- | --- | --- |
| Public rails JSON (Worker / Pi vector) | ~45 KB after assemble; first miss builds from five `marketplace_rails` rows | Yes — this is the shell |
| Flutter `GET /api/marketplace-home` on **api.pokoin.com** | **170 KB**, 120 cards, **no** `newArrivalIds` | Must **not** be. SPA used to accept it because `cards.length > 0` |
| Pi `GET /api/marketplace-home-page` | Rails vector when `marketplace_rails` is populated; else newest / hot SQL | Fallback only (same host as rails) |
| Firebase `onAuthStateChanged` (`useAuth().ready`) | hundreds of ms | **No** |
| Firestore `user_card_recent_views/{uid}` | `getDoc` after auth | **No** — Recently seen only |
| `GET /api/marketplace-card-tiles` | Pi API on api.pokoin.com; Worker proxies the same path | **No** — leftover recents after paint |
| Catalog leftover JPEG (Lucario ex) | **166 KB** | **No** — desk / hero only |
| `_homepage.webp` sibling (240px, q82) | **26 KB** | Yes — grid / carousel |

From this host, `https://pokoin.com/api/marketplace-home` is Cloudflare WAF
**403** (`Your request was blocked`). Real browsers still hit
`workers/pokoin-origin.js`. Vite proxies `/api` to `api.pokoin.com`. Production
SPA rejects Flutter hydrate even if the Worker is skipped (`isPublicRailsVector`).

Homepage WebP coverage (same day, still backfilling): objects sit on Pi
disk / R2 under leftover `{ct_id}_{slug}` names. **Public image keys are
that leftover `ct_id` (`public / 2`)**, not the desk `card_id`. Desk paths
stay `{public_id}`. Generator:
`cardvault/.../scripts/generate-oracle-homepage-card-images.js` and
`generate-oracle-disk-homepage-webp.py`. Missing siblings 404 →
`CardArt` falls back to JPEG.

---

## Critical path (must stay this order)

```
localStorage pokoin.recentCardTiles (compact, ≤24)
        │  paint Recently seen on the first frame (rail shows 20)
sessionStorage pokoin.homeVector.{game}.rising   (10 min, recents stripped)
        │  paint New / Best / Featured immediately
        ▼
GET rails vector  (no Firebase wait)
  production:  pokoin.com /api/marketplace-home  → Worker Cache API hit
               waitUntil revalidate vs rails.updated_at
               Worker origin = https://api.pokoin.com/api/marketplace-home-page
  vite/dev:    GET /api/marketplace-rails?id=… (five Pi rails)
        │  attachRecentsToHome(local ids + compact tiles)  — sync
        ▼
<img src="/card-images/{leftover_ct_id}_{slug}_homepage.webp">
        │  onError → same leftover key .jpg
        ▼
(after paint) leftover recents → GET /api/marketplace-card-tiles
             (only ids not already in compact cache)
             (999 stamp ids remap to leftover × 2; still-missing or nameless → card-page)
(after paint) missing tile PKN → last-day sold median (`marketplace-card-sales`)
(after ready)  syncRemoteRecentCardIds() 15T merge
```

Skeletons:

- **New / Best / Featured** — only while there is **no**
  session cache **and** the rails fetch has not returned.
- **Marketplace grid (Pokemon)** — 14 skeleton tiles until the shuffled
  western-set walk returns. Independent of the rails vector. **Show more**
  appends the next 14. OP/RB still use spotlight from the vector.
- **Recently seen** — only if local ids exist and those cards are not already
  in the vector. Hydrate leftovers with `marketplace-card-tiles` after paint.
  Never block the other rails for that row.

---

## What used to block paint

`Home.jsx` waited for `useAuth().ready`, then `loadRecentCardIds()` (Firestore
`getDoc` when signed in), then `fetchHome(ids)`. `fetchHome` accepted Flutter
hydrate and `Promise.all`’d extra tiles with the rails. `CardTile` asked for
`imageSrc(..., 'grid')` which `preferFullImage` turned into the leftover JPEG.
The Worker looked up a remote `rails.updated_at` **before** `caches.default.match`.

Each of those is now illegal on the LCP path. Calling
`ruvtchmbtxvjqmquobij.supabase.co` for rails or tiles is also illegal.

---

## Industry map (what we copied)

Pokoin is a Vite SPA, not Next. The rules still apply: **public catalog is a
shared cache; session is a hole that streams later.**

| Rule | Upstream | Pokoin |
| --- | --- | --- |
| Session must not sit in the static / shared shell | [Next.js Cache Components — authentication](https://nextjs.org/docs/app/guides/authentication-with-cache-components). Authenticated UI goes behind a boundary; the rest prerenders. Tenant/user id is a cache key, never mixed into the public blob ([Hamza Shabbir on Next 16 `'use cache'`](https://hamzashabbir.dev/article/nextjs-16-use-cache-migration-cross-tenant-leak)). | `fetchHome` does not wait on `useAuth().ready`. Recents are not stored in the Worker JSON or in `sessionStorage pokoin.homeVector.*`. |
| Serve stale, revalidate in the background | [RFC 5861 `stale-while-revalidate`](https://datatracker.ietf.org/html/rfc5861). Shopware store APIs and [edge marketplace SWR](https://dev.to/opttoyschina/stale-while-revalidate-on-the-edge-how-our-marketplace-killed-the-cold-start-and-kept-3do2) use the same split: public cache, personalize on the client. Cloudflare Cache API `match` then `waitUntil(put)`. | `stableHomeCacheRequest` strips `?v=`. Hit returns immediately. `revalidateHome` compares `x-pokoin-rails-updated-at`. Browser `max-age=120`, `s-maxage=600`, SWR a day. |
| Guest local, signed-in merge | Shopify / Amazon recently viewed: persist **ids** locally, compact product rows for instant paint, account history on the server after login. | `localStorage pokoin.recentCardIds.{game}` plus **compact** `pokoin.recentCardTiles.{game}` (max 24, not desk JSON). Home paints those tiles on the first frame. Shared API `GET/PUT/POST /api/marketplace-recents?game=` merges **after** `ready` — one history per TCG. Unscoped legacy keys/Firestore are ignored. |
| Thumbnails ≠ masters | Every mature marketplace CDN (Shopify `cdn/shop`, eBay EPS, TCGPlayer) ships a small tile derivative and keeps the master for PDP zoom. | Catalog master = leftover-key JPEG on disk. Public URL prefix is leftover `ct_id` (`public / 2`). Home/search tile = `{leftover}_{slug}_homepage.webp` (240px, q82). Desk still uses JPEG. |

Do **not** put recents into `'use cache'` / Cache API. That is the cross-user
leak the Next 16 guides exist to prevent.

---

## Endpoints (do not mix these up)

| URL | Host | What | SPA |
| --- | --- | --- | --- |
| `GET /api/marketplace-home` | **pokoin.com** (Worker) | Rails vector from Pi, Cache API, no recents | Production first hop, only if `isPublicRailsVector` |
| `GET /api/marketplace-home` | **api.pokoin.com** | Flutter hydrate ~170 KB, server `recentlySeenIds`, no `newArrivalIds` | **Reject** |
| `GET /api/marketplace-home-page` | api.pokoin.com (Pi) | Prefer `marketplace_rails` (`source: 'pi'`); else newest / hot SQL | Last resort / Worker origin |
| `GET /api/marketplace-home-page` | pokoin.com Worker | Alias of the rails vector (`isHomePath`) | Same as Worker home |
| `GET /api/marketplace-rails?id=` | api.pokoin.com (Pi) | One rail JSONB row | Vite/dev first hop |
| `GET /api/marketplace-card-tiles?ids=` | api.pokoin.com (Pi); Worker on pokoin.com | Public tile payloads | After paint |

`isPublicRailsVector` is true when `source === 'pi'` **or** the payload
has non-empty `newArrivalIds` **and** `featuredIds` **and** `bestSellerIds`.
Flutter hydrate fails the first. Newest-only SQL without Featured/Best fails
the second.

Publisher: `/srv/pokoin/scripts/sync-marketplace-rails.py` (timer
`marketplace-rails-sync.timer`). Old `sync-supabase-rails.py` exits.

---

## Client files

| File | Job |
| --- | --- |
| `market/src/pages/Home.jsx` | Paint recents from local compact tiles even before the rails vector. `fetchHome` in an effect that does **not** list `ready`. New/Best/Featured skeletons wait on rails, not recents. Second effect: account merge after `ready`. Network tiles only for `missingRecentIds`. Pokemon Marketplace grid is `home-browse.js` (shuffled western sets, 14 + Show more), not the rails vector. |
| `market/src/lists.js` | `fetchHomeFromLists` (Pi `/api/marketplace-rails` only, no `Promise.all` with tiles). `attachRecentsToHome` is sync and returns `missingRecentIds`. |
| `market/src/api.js` | `fetchHome`: Worker (prod) → lists → home-page. Never treat Flutter hydrate as success. |
| `market/src/home-cache.js` | `sessionStorage pokoin.homeVector.{game}.rising`, 10 min, recents stripped. |
| `market/src/recents.js` | Local 24 ids **per game**. Signed-in list is shared Pi API `/api/marketplace-recents?game=` (`server/pokoin-api/marketplace-recents.js`). Compact rail tiles live in `localStorage pokoin.recentCardTiles.{game}`. **Do not** dump desk `card-page` JSON there. Desk identity is `pokoin.cardPage.v1.` (`card-page-cache.js`). `syncRemoteRecentCardIds` is the account merge for the current host game — do not call it on LCP. Unscoped legacy storage is ignored. |
| `market/src/auth-session.js` | Last uid / Silver / site PKN snapshot. **Not** on LCP. Paints CT/CM/VT from `pokoin.auth.session` after first paint while Firebase catches up. |
| `market/src/image-urls.js` | `homepageDerivativeUrl` for grid. `preferFullImage` for desk (strips `_homepage.webp` → JPEG). `rasterSiblings` only falls back webp→JPEG, never upgrades a JPEG src. |
| `market/src/components/CardTile.jsx` | `imageSrc(card, 'grid')`. First 8 `loading=eager`, first 4 `fetchPriority=high`. Full 63:88 scan — never `cut`. Map: [CARD_ART.md](CARD_ART.md). |
| `market/src/components/CardArt.jsx` | Grid: walk webp then JPEG. `full` (desk, zoom, promo fan): leftover JPEG only. `cut` is search-suggest only. |
| `market/src/components/PromoCarousel.jsx` | Fan leftover JPEG (`CardArt full`). Pool from `set:{slug}` rails (`fetchPromoFanPool`) — no `fillMissingTilePrices`. First slug starts at module load. Rise stagger stays 0 / 0.42s / 0.84s. |
| `market/src/art-cut.js` | Pokemon illustration window (landscape, `top` 0.125). Used on the **right** of search suggest, not home tiles. Print flags sit left of that rectangle on desktop and overlay it on phone. Set desk title uses the same flags left of `h1.page-title` ([PRINT_FLAGS.md](PRINT_FLAGS.md)). |
| `workers/marketplace-home.js` | `stableHomeCacheRequest`, match-before-origin, `waitUntil` revalidate. Origin is `https://api.pokoin.com`. |
| `workers/pokoin-origin.js` | Dispatches home before `fetch` to origin. |
| `market/src/home-browse.js` | Pokemon home grid: shuffle western expansions, walk 48-card pages, paint 14 tiles, **Show more** keeps the same walk. Drop JP/CN `card.nationality` even inside a western set. Independent of the rails vector. |
| `scripts/sync-marketplace-rails.py` | Writes Pi `marketplace_rails` / `marketplace_card_tiles`. `TILE_SQL` grid/tile → leftover `_homepage.webp`; hero stays leftover JPEG. Image keys are leftover `ct_id`. |

Tests: `market/src/home-cache.test.js`, `lists.recents.test.js`,
`recents.test.js`,
`image-urls.test.js`, `home-browse.test.js`, `sold-graph.test.js`,
`promo-fan.test.js`,
`workers/marketplace-home.test.mjs`.

---

## Do not regress

1. Do not gate `fetchHome` on `useAuth().ready`.
2. Do not `await` account recents (`/api/marketplace-recents` or Firestore)
   before the public vector.
3. Do not `Promise.all` `fetchCardTiles` with rails.
4. Do not `caches.default.match` only after a remote `updated_at` round-trip.
5. Do not accept `GET /api/marketplace-home` from api.pokoin.com as the SPA
   vector (`cards.length` is not enough).
6. Do not point Vite `/api` at pokoin.com from this datacenter (WAF 403).
7. Do not put recents into the Worker body or `pokoin.homeVector.*`.
8. Do not use leftover JPEGs as grid `src` when a `_homepage.webp` sibling
   can be derived.
9. Do not show New-cards skeletons because Recently seen is still loading.
   Do not wait on `marketplace-card-tiles` to paint compact recents already
   in `localStorage`.
10. Do not fetch a second art-crop image. Search suggest crops the illustration
    rectangle from the same suggest URL (`art-cut.js`). Not a square. Not home tiles.
11. Do not call Supabase REST for rails, tiles, home, or set desks.
12. Do not wait on `fillMissingTilePrices` or `marketplace-expansion-page?limit=160`
    before the home promo fan. That pool is `set:{slug}` rails. Fan `src` stays
    leftover JPEG (`CardArt full`), not `_homepage.webp`.
13. Set desk (`/marketplace/sets/:slug`) keeps skeletons until
    `fetchExpansionCards` finishes (`hasMore === false`), then paints Number
    (or Official) order. Homepage webps load **12 at a time** from that
    order; later slots stay skeletons. Do not flash the first 48 leftover
    `card_id`s. [MARKET.md](MARKET.md#set-desk-first-paint).

---

## Verify

```bash
node --test market/src/home-cache.test.js market/src/lists.recents.test.js \
  market/src/recents.test.js \
  market/src/image-urls.test.js market/src/art-cut.test.js \
  market/src/home-browse.test.js market/src/sold-graph.test.js \
  market/src/promo-fan.test.js \
  workers/marketplace-home.test.mjs

# Pi
python3 /usr/local/bin/pokoin-id-check 668126
curl -fsS http://127.0.0.1:18080/api/marketplace-rails?id=home-new-cards | jq '.source,.cards|length'
curl -fsS http://127.0.0.1:18080/api/marketplace-home-page | jq '.source,.sections|keys'

# local SPA (Vite 5174). First paint must not request Flutter home.
# Network: /api/marketplace-rails (and set rails for the promo), then _homepage.webp.
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
