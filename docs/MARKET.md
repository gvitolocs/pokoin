# Pokoin.com React marketplace — pipeline and APIs

Source of truth for the **public web**: this repo (`gvitolocs/pokoin`).
Production is Vercel project `web`. Android/iOS CardVault is a separate app:
[APP.md](APP.md). Do not alias `app.pokoin.com` onto project `web`.
HTTP API map: [API.md](API.md). Home first paint (auth, cache, images):
[HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md). Live index:
`GET https://api.pokoin.com/api/__routes?group=1`.

**Multi-game:** the same SPA also serves `onepiece.pokoin.com` and
`riftbound.pokoin.com` ([GAMES.md](GAMES.md), `market/src/game.js`). Those hosts
append `?game=one_piece` / `?game=riftbound` on `/api/marketplace-*`. Public
card ids are still `ct_id * 2` on every game. Pokemon stays the default when
`game` is omitted.

Humans and bots hitting `/marketplace`, search, card, sets (with or without a
trailing slash), competitive, explore, portfolio, watchlist, products, auth,
profile, cart, checkout, orders, wallet, forum, signal, scan, inventory, nft,
admin, and the static docs pages get `market/index.html`. Chrome:
[CHROME.md](CHROME.md).

**Discord / Slack / X previews:** those crawlers do not run the SPA. Worker
`pokoin-origin` detects `Discordbot` (and peers) on
`/marketplace/{lang}/cards/{id}…`, loads `GET api.pokoin.com/api/marketplace-card-page`,
and returns HTML with `og:title` / `og:description` / `og:image` (absolute
`https://pokoin.com/card-images/…`). Humans still get the SPA. Force with
`?og=1` while debugging. Cache TTL 1h. Verified: Discordbot UA from the LAN
Pi gets 200 + Drifloon meta; datacenter IPs (Oracle, this laptop) often get
Cloudflare **403** — that is IP/ASN blocking, not missing tags. Discord’s own
crawlers are not on those ASNs. If an old paste still has no card, Discord
cached the failed fetch — re-paste with `?v=2` or delete and send again.
Free plan is at **5/5** custom WAF skip rules; do not add a sixth without
merging an existing skip.

Visual language follows `/home/nez/Projects/candyext`: Rare Candy shop chrome
(dark rails, chips, gold `#FFD33D` not lime `#cbf062`). **Card detail is an
action-first market desk** (art + list + Best Deal + shop table), not
Collectr’s Printing column.

Collectr is a portfolio / price-guide product page (identity + charts +
affiliate TCGPlayer / eBay). CardTrader is a first-party marketplace: buy box
+ offer table in the first viewport. Pokoin sells and settles in PKN, so this
desk stays action-first, not analytics-first. Do not clone Collectr
ungraded/graded SVG history. `sales` on the BFF is empty. Do not invent a
24h % from listing spread; React shows honest `24h —` until completed
purchases exist.

## Card page (wide >960px)

`300px` art | flex-2 center | `300px` Best Deal. Shop is **below** the hero
row. Wide layout uses `align-items: stretch` so the art panel, sell form, and
Best Deal column share one bottom edge. **Below 960px** the stack is Best Deal
→ art → Shop → analytics/sell form; those panels use `flex: none` so stacked
layout does not stretch. **Below 480px** (iPhone 16) the stack is art first,
then Best Deal.

1. Asset header: Pokémon + rarity badges (never show `Card` as rarity), name,
   `set number · artist|type`, Floor (native listings only), honest `24h —`,
   watchlist, share
2. Left: `< collector-number >` **above** the scan (not overlaid), JPEG hero in
   a padded frame (**no** `--tcg-corner` clip-path, **63:88** box so the scan
   does not shove the rails), version `<select>` **always mounted** (current
   printing as the first option; extra versions fill the menu later — never
   swap in a `<p>`), View all versions → `{canonicalPath}/versions`.
   **Phone (`max-width: 480px`, iPhone 16 393×852):** stack is art → Best Deal
   → shop → list form so the scan is in the first viewport. Tablet `≤960px`:
   Best Deal → art → shop → list form. See [MOBILE.md](MOBILE.md).
3. Center: honest empty analytics (“No sold-card analytics yet…”) + **inline
   List your card** form (Price, PKN, Qty, Condition, Language, Foil, chips
   1st Ed. / Sealed / Graded / Signed / Shipping, seller comment). **List card**
   POSTs `POST /api/marketplace-listings` with the Firebase ID token when the
   user is signed in (same public web config as Android/iOS
   `DefaultFirebaseOptions.web`). Unsigned: button stays off, **Sign in**
   punches `/auth`. Do not send `listingId` in events. Reserve copy stays
   informational until a reserve API exists.
4. Right: Best Deal (Silver CT/CM/VT, language/condition,
   Add to cart only with a native listing else Unavailable)
   + POKOIN CARD RESERVE copy
5. Shop table below: filters/sort when listings exist; empty `No items found`
6. Other printings rail

Click the scan to zoom (React lightbox). Do not navigate Home on art tap.
Mount `<dialog>` only while zoom is on; **never** set `display` on a closed
dialog.

Header does **not** pin Mega Evolution / Phantasmal Flames / Black Bolt. Top
bar: search, EN flag (visual only), Home, Forum, Signal, Competitive, PKN
chip, profile/sign-in, cart. Sell stays off the global bar. Routes:
[CHROME.md](CHROME.md). Search submit is a magnifying-glass icon (all widths).
On **phone** (`≤720px`) the icon row is a left side drawer. Layout notes:
[MOBILE.md](MOBILE.md).

Marketplace home (`/marketplace`) paints a 5-expansion promo carousel (Mega
Evolution, Phantasmal Flames, Black Bolt, White Flare, Destined Rivals), rails,
and grid immediately. When that home payload lands, idle `warmupSearchBar()`
opens Meili suggest (and Pokemon token-predict warmup). Each slide is official-set copy plus a 3-card fan that
overflows the banner; autoplay pauses on hover, with arrows and dots. Set browse (`/marketplace/sets/:slug`) and search do the same —
skeleton tiles, never “Loading set…” / “Searching…”. Card pages seed from the
tile you clicked. The landing page prefetches this SPA and `/api/marketplace-home-page`
on idle and on hover of Explore cards.

## Action map (every control)

| Surface | Control | What happens |
| --- | --- | --- |
| Top bar | Search | Autocomplete → card page; submit → `/marketplace/search`. Rows match CardTrader **density** (set mark, thumb, bold `Name - number`, expansion `#n`, Singles, View all versions) on the dark gold chrome. Spec: [CHROME.md](CHROME.md#header-search-cardtrader-style-rows). |
| Top bar | Logo | Marketplace home |
| Top bar | Home | Landing `/` |
| Top bar | Forum | `/forum` (GET `/api/forum`, 8s timeout) |
| Top bar | Signal | `/marketplace/signal` (catalog dump + home rails; honest empty 24h) |
| Top bar | Competitive | `/marketplace/competitive` (candyext Limitless dump) |
| Top bar | PKN chip | `/wallet` (MetaMask + PokoinPoS `26062026`) |
| Top bar | Profile icon | Signed in → `/profile`; unsigned → `/auth?from=` |
| Top bar | Cart | `/cart` (`localStorage pokoin.cartItems`) |
| Header | Set name | `/marketplace/sets/:slug` |
| Header | Artist | `/marketplace/{lang}/artists/{slug}` |
| Header | Watch | `localStorage pokoin.watchlistIds` + `POST /api/marketplace-watchlist` |
| Header | Share | iOS/Android: system share sheet. Desktop: copy URL + Copied |
| Art | Prev / next | Same-set sibling via expansion page; do not clear siblings on cardId change |
| Art | Scan click | Lightbox zoom |
| Art | Version select | Always in the art column. Seeded with this printing. |
| Art | View all versions | `{canonicalPath}/versions` in this SPA |
| Center | Listing fields | Local form state only |
| Center | Extra chips | Toggle 1st Ed. / Sealed / Graded / Signed / Shipping |
| Center | Sign in / List card | Sign in → `/auth`; signed-in List card POSTs with Firebase bearer |
| Best Deal | Language / condition | Always enabled (all langs / conditions). Filters Best Deal when listings exist; seeds List your card |
| Best Deal | Add to cart / Unavailable | Native listing → local cart then `/cart` |
| Best Deal | Silver CT / CM / VT | Unsigned → `/auth`. Signed-in unlock `POST /api/unlock-silver` (20 site PKN). Silver: **CT** leftover `cardtrader.com/en/cards/{ct_id}` via `window.open` noreferrer (Sanji `818358` → `409179`; no pokoin 302 in the tab). **CM** JSON URL then `window.open` noreferrer (Pokemon stored/product, else Singles `{name} {collector}` like VT `dawn 129`; OP `/en/OnePiece/Products/Search`; RB `/en/Riftbound/Products/Search`). Do not fetch cardmarket.com from Oracle/nezopt (Cloudflare 403). **VT** Vinted `search_text`: Pokemon `{name} {collector}` (`Gumshoos 184`; name-only → 500+) plus `catalog[]=4824` (Hobby e collezionismo). OP `One Piece Card Game {name} {number}`. RB `Riftbound TCG {name} {number}`. Skip English set names (Vinted AND + IT titles). All three pills `window.open(..., 'noopener,noreferrer')` so CT/CM/VT see a direct visit, not pokoin.com. Do not cloak as Google. Gold pills. |
| Shop | Sort / condition / language | Client filter of native listings |
| Shop | Listing row | Adds that offer to the local cart |
| Shop empty | No items found | List form above is the sell path; header heart is watchlist |

Do not send `listingId` in `marketplace-event`.

## Other SPA pages (user actions)

| Page | Actions |
| --- | --- |
| `/marketplace` | Promo slides, rails, grid, Sell callout → `/inventory` |
| `/marketplace/search` | Query, load more, tile → card |
| `/marketplace/explore` | Pokoin catalog in PKN, filters, page 48 |
| `/marketplace/portfolio` | Set bars, rails, search holdings, holding desk (PKN, `GET /api/marketplace-portfolio`, no CardTrader leftover art) |
| `/marketplace/sets` | Expansion index (limit 80) → set desk |
| `/marketplace/watchlist` | Hydrate ids, clear, tiles |
| `/product/:kind` | Seeded search (box/pack/graded/nft). Empty `query=` times out — do not. |
| `/marketplace/competitive…` | Candyext Limitless dump: tournaments, decks, lists, players, cards |
| `/forum` | Categories, topics, create (bearer), replies, image upload after topic/post id |
| `/marketplace/signal` | Native PKN asking + home rail counts. No fake 24h. |
| `/wallet` | Connect MetaMask, send PKN, AMM quote/swap on `0x…2606`, WPKN quote + signed request |
| `/buy` | Stripe PKN packages (Starter/Collector/Validator). Return `?session_id=` confirms. |
| `/auth` | Email/password, Google, return `?from=` |
| `/profile` | Session, site PKN, Silver, sign out, admin link if role |
| `/cart` | Qty, remove, clear, Checkout |
| `/checkout` | Bearer `POST /api/marketplace-orders`. Tax 8%. Physical shipping 2000 PKN. NFT-only when every row is nft/reserve. |
| `/orders` | Firestore `orders` for uid |
| `/nft` | Firestore `user_card_collections` (NFT rows) + shipping intent |
| `/inventory` | Seller listings for Firebase uid |
| `/scan` | Photo → `POST /cardscan/identify`, blueprint × 2, suggest/search match. TCGplayer id ignored. |
| `/admin` | Firestore admin only. Expansion symbol editor at `/marketplace/admin/edit`. |
| `/docs` `/about` `/contact` `/privacy` `/earn` `/whitepaper` `/health` | Static + RPC probe on health |

Checkout pays site PKN through `/api/marketplace-orders`. Failed API calls stay
honest (no invented 24h or CT prices).

## Card URLs

Public id is `card_id` (CardTrader blueprint × 2). Never put `ct_id` in the
address bar.

| URL | What happens |
| --- | --- |
| `/marketplace/{lang}/cards/{id}/{slug}` | Canonical. SPA. Cloudflare Worker passes through to Vercel. |
| `/marketplace/{lang}/cards/{id}` | Cloudflare Worker 302 from the packed slug index to the canonical slug URL. |
| Same paths with a trailing `/` | Same. Vercel must still rewrite the slash form of the SPA to `/market/index.html` or it 404s (`x-vercel-error: NOT_FOUND`). |
| `/marketplace/{id}` | Same Worker 302 (`https://pokoin.com/marketplace/239324`). |
| `/{id}` | Same Worker 302 (`https://pokoin.com/239324`). |
| `/{id}/{slug}` | Same Worker 302. |

Example (Gambler 239324):

- Short: `https://pokoin.com/239324`
- Canonical: `https://pokoin.com/marketplace/en/cards/239324/card-gambler-060-062-fossil`

Worker: `workers/pokoin-shortlink.js`, routes `pokoin.com/*` and `www.pokoin.com/*`.
A tiny `pokoin-origin` Worker owns the more specific routes (`/marketplace/en*`,
`/api/*`, `/market*`, `/home*`) so the card page after the 302 does not cold-start
the 74k slug index. Slugs are a packed in-Worker index (`card-ids.bin`,
`card-starts.bin`, `card-slug-blob.gz` inflated to text at deploy) so the 302
does not gunzip on the request. Lookup is a binary search — no KV and no Oracle
on the Worker path. 302s set `Cache-Control` / `s-maxage` and Workers Caching is
on. Unknown ids **404** with `no-store`. Vercel origin fallback is a 302 to
`/marketplace/en/cards/{id}` (SPA), not `marketplace-card-shortlink` on Oracle. Refresh the map with
`scripts/dump-shortlink-slugs.sh` then redeploy the Worker. Do not `wrangler kv
bulk put` on the Free plan. `pokoin.com/card-images/*` stays on
`pokoin-cdn-card-images`. Do not put shortlinks on Supabase. Do not point
`news.pokoin.com` at these rewrites. `app.pokoin.com` stays DNS-only.

The React card page still `navigate(canonicalPath, { replace: true })` when a
request reaches the SPA without a slug.

---

## Why the JPEG scan looked better than PNG

Catalog heroes (`heroImageUrl`) are **JPEG photographs of cardboard**, typically
~500×688. That is the photograph of cardboard: continuous tone, print dots,
dirty white border. The desk paints that JPEG with `object-fit: contain`
inside a padded frame so you see the whole card.

PNG looked worse because:

1. **Clip-path** (React `.hero-art` used `--tcg-corner`) cut the printed white
   border and made a photo look like a flat digital sticker.
2. **JPEG→PNG does not add detail.** Re-wrapping a scan as PNG (or a PNG of a
   screenshot) keeps JPEG ringing and often adds halo against navy.
3. PNG is the right format for flat graphics with alpha, not for photos. The
   source is a photo.

Keep serving the **JPEG** `heroImageUrl`. Never convert to PNG. Do not clip
the detail hero. Zoom softness is the 500px source, not the codec.

Artist is React: `/marketplace/{lang}/artists/{slug}`. View all versions is
`{canonicalPath}/versions` in this SPA.

Collectr and CardTrader show the **full** scan in the left column (Collectr
has no lightbox). Pokoin click-to-view is a viewport lightbox: entire raster,
`object-fit: contain`, no `--tcg-corner` clip-path. Mount the `<dialog>` only
while zoom is on, call `showModal()`, and **never** set `display` on a closed
dialog. `.zoom { display: grid }` overrides the UA `dialog:not([open])` rule
and paints the last scan under the footer (the “random leftover card”).
Do not use `<dialog open>` in-flow. There is no “View card” label on the art;
click the scan to zoom. Previous/next loads the set list once
(`GET /api/marketplace-expansion-page?expansionName=`) and **must not**
clear it when the card id changes — that made the arrows vanish after the
first click.

Home rails can show a catalog `price` while Shop is native-only. Floor, Best
Deal, and Add to cart use `GET /api/marketplace-listings?nativeOnly=1` after
first paint. Catalog `card.price` is not a buyable ask. Empty native listings:
Floor `—`, **Unavailable**, “No sellers yet.” Unsigned Best Deal unlock goes
to `/auth`. Signed-in unlock posts `/api/unlock-silver` (20 site PKN).
CT/CM/VT pills render only when Firestore says Silver (or admin). Silver **VT**
opens Vinted Italy with Pokemon `{name} {collector}` (`Gumshoos 184`); OP/RB
keep their game prefix plus collector. English set names zero the catalog.
Name-only Gumshoos is 500+ listings. List card
already sends a Firebase ID token.

Do **not** clone Collectr’s ungraded/graded SVG history or affiliate TCGPlayer /
eBay rows. Shop rows are native `GET /api/marketplace-listings?nativeOnly=1`
only. Gold, not Collectr teal. Cart, checkout, orders, wallet, inventory,
forum, buy, scan, nft, admin, and auth are this SPA. Android/iOS:
[APP.md](APP.md).

---

## Identity (do this, not the other thing)

A **printing** is identified the TCGPlayer way:

1. Public **card id** (`card_id` = CardTrader blueprint × 2). Never divide. Never
   put `ct_id` in the address bar.
2. **Set** + **collector number** + **rarity** + **artist**.
3. Listings under that printing: **condition + seller + PKN price**.

`includeSameAs` and `liveOffers` are **off** unless the client asks. `includeOffers`
defaults **off** too: the React card shell paints identity + hero first, then
`GET /api/marketplace-listings?cardId=&nativeOnly=1` fills the table. Do not
await listings for LCP.

The page BFF still concatenates CardTrader `expansion_number` into `number`
(`Special Illustration Rare | 184/132`) and often puts product type `Card` in
`rarity`. `market/src/identity.js` splits that before render and before
`marketplace-event`. Do not show `Card` as a rarity.

Images: `gridImageUrl` / `heroImageUrl` from the page BFF. Never `/previews/`
on the card desk. Header suggest thumbs may fall back to a CardTrader
`preview_` URL when no leftover JPEG exists — empty grey squares are worse.

Contract: `GET https://api.pokoin.com/api/__contract` version `2026-08-30.2`.

---

## Action pipeline

`POST /api/marketplace-event` only accepts `view | search | click | reserve |
cart_add | sale` plus a **public** `cardId`. The UI gesture is `metadata.type`.
No PII. `source` is always `react-market` (`market/src/track.js`).

| Gesture | eventType | metadata.type |
| --- | --- | --- |
| Card page load | `view` | `card_view` |
| Tile / printing click | `click` | `tile` / `version` |
| Autocomplete pick | `click` | `suggest` |
| Search results | `search` | `search_submit` (`query`, `resultCount`) |
| Sign in to buy | `cart_add` | `buy_intent` |
| Sell / share / copy / zoom / watchlist / listing / set / artist / prev / next | `click` | `sell` `share` `copy` `zoom` `watchlist_add` `listing` `set` `artist` `prev` `next` |
| Load more | `click` | `load_more` |

Do **not** send `listingId`, emails, or `includeSameAs=1` / `liveOffers=1`
(those hung the BFF ~30s). Watchlist for signed-out users is
`localStorage pokoin.watchlistIds`. Listing POST already uses the Firebase
bearer; watchlist has not been moved off localStorage yet.

Qwen (`qwen3.8:27b-128k`, think:false) agreed on printing identity and rails.
Ignore its POST-for-page-BFFs and `ct*` cardId examples — those contradict the
live contract. Page BFFs are **GET**.

---

## APIs this SPA may call

| URL | When |
| --- | --- |
| `GET /api/marketplace-home` | Homepage **vector** from Supabase rails. Worker Cache API on **pokoin.com** (stable key, SWR). No recently seen. **Not** the Flutter hydrate on api.pokoin.com (~170 KB). |
| `GET /api/marketplace-card-tiles?ids=` | Public tile payloads for recents not in the vector. Worker on pokoin.com; Oracle 404. After first paint only. |
| `GET /api/marketplace-search-page?query=` | Search + load more |
| `GET /api/marketplace-card-page?cardId=` | Detail shell. `includeOffers=0` by default |
| `GET /api/marketplace-listings?cardId=&nativeOnly=1` | Listings table after first paint |
| `POST /api/marketplace-listings` | Create listing. Bearer Firebase ID token |
| `POST /api/marketplace-orders` | Paid checkout. Bearer. `fulfillmentMode` physical or nft_only |
| `POST /api/marketplace-orders?action=nft-shipping-request` | NFT shipping intent. Bearer |
| `POST /api/create-pkn-checkout-session` | Stripe PKN packages |
| `POST /api/unlock-silver` | 20 site PKN Silver |
| `GET /api/marketplace-expansion-page?slug=` | Set browse |
| `GET /api/marketplace-suggest?q=` | Header typeahead (Meili-only, grouped printings, ~120ms debounce). Plain prefix → base name first (`mimik` → Mimikyu). UI flattens groups into CardTrader-style rows; `count` drives “View all N results”. |
| `POST /api/marketplace-event` | Actions above |

Same-origin `https://pokoin.com/api/marketplace-suggest` rewrites to
`https://api.pokoin.com/api/marketplace-suggest`. Omitting `/api` 404s. Do not
GET autocomplete (405). Ranking map is documented with the search service in
the app repo; the web only calls `marketplace-suggest`. See [APP.md](APP.md).

---

## Speed (card page must be fast)

Do **not** wait for listings, sameAs, or live CardTrader before painting the
printing. Shopify-style: await identity + hero, stream offers after. Collectr
charts stay out of this SPA until the BFF has a real series.

The API box `pokoin-marketplace` is an Always Free **E2.1.Micro (1 GB)**. You
cannot merge the two AMD micros into one bigger AMD VM — that quota is two
fixed 1 GB shapes. Oracle halved Always Free Ampere in 2026: the unpaid “big
VM” is **Ampere A1 Flex 2 OCPU / 12 GB**, not 4/24 (4/24 is paid). Target:
Postgres + `pokoin-oracle-api` + Meili + Caddy on **Madrid 3**
`pokoin-madrid-api`. Seed stays on Frankfurt `pokoin-peer1`.
`pokoinpos-peer2` on the marketplace micro stays stopped. Do not delete boot
volumes. Do **not** run `scripts/oci-a1-2x12-hunt.sh` (Frankfurt A1 + auto
DNS cutover). Marketplace move: [MADRID_MARKETPLACE.md](MADRID_MARKETPLACE.md).

Set browse uses indexed `marketplace_search_candidates` (`readCardsForSet`),
not `snapshotForExpansion` (distinct-on `marketplace_card_versions`, ~6s).
Hypemeter / `news.pokoin.com` stays on Vercel until Madrid has spare RAM.
News hunt `scripts/oci-a1-2x12-hunt-news.sh` is Frankfurt-only and is
stopped. Pipeline: [NEWS.md](NEWS.md).

---

## Pipeline (edit → live)

This repo is the public web. Do not ship the marketplace through
`cardvault/.../build/web`. App host: [APP.md](APP.md).

Empty **Recently seen** skeletons used to wait on Oracle `GET /api/marketplace-home-page`.
Browse rails now read **Supabase** (`marketplace_rails` / `marketplace_card_tiles` /
`marketplace_card_weights`). Oracle Postgres stores seller listings, CardTrader
snapshots, and sold/removed history. A 15-minute job rolls those into card
weights; rails sync publishes the ranked lists **with PKN prices**. Snapshots
(883 MB) stay on Oracle. Do not seq-scan
`cardtrader_market_listing_snapshots` (the usable index is
`COALESCE(blueprint_id, cardtrader_blueprint_id)`).

**PKN conversion (one rate everywhere):** `1 PKN = 0.005 USDT`. Oracle
`marketplace_price_pkn_from_cardtrader` and the SPA (`market/src/pkn.js`) use
the same number. EUR (and USDT) asks convert as `PKN = EUR / 0.005`.
Example: Dragonite FB hub ask **€62.29 → 12,458 PKN** (cached column may
already store PKN); median sold €67.54 → **13,508 PKN**. Stripe Buy packages
use this rate too (`€5.00 → 1,000 PKN`).

### Price on a homepage tile

1. CardTrader hub cache `cheapest_price_pkn` (~868 hot blueprints, already
   converted).
2. Else sold-median EUR from `marketplace_card_weights` ÷ 0.005.
3. Else **live** CardTrader `GET /marketplace/products?blueprint_id=` — Near
   Mint English, unsigned, non-altered, non-vacation; cheapest EUR ÷ 0.005.
   Used for New cards / Marketplace grid when the hub cache has no live-set
   rows (Mega Evolution is not in those 868).
4. Else **—** (not “Out of stock”). Shop / Floor / Add to cart stay
   **native listings only**. Homepage PKN is a market reference, not a
   buyable native ask.

### Homepage rails

The SPA (`Home.jsx`) reads one **vector** assembled from Supabase
`marketplace_rails` (new / featured / best / spotlight / popular). Full
first-paint notes, measured sizes, and industry map:
[HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md).

The Worker caches that JSON at a **stable** Cache API key (no Supabase
`updated_at` round-trip on the user path) and revalidates in `waitUntil`
when rails change ([RFC 5861](https://datatracker.ietf.org/doc/html/rfc5861)).
Browsers may keep the JSON 120s fresh and a day stale. The SPA also keeps the
last public vector in `sessionStorage pokoin.homeVector.{game}` (10 min) so a
return visit paints rails before the network.

Recently seen is **not** in that cache. Recents are `localStorage
pokoin.recentCardIds` first; Firestore merges **after** Firebase `ready`.
Extra tile JSON runs only for ids missing from the vector, after New cards
already painted.

Tiles show `formatPkn` plus `printingIdentity().tileLine`. Grid art is the
240px `_homepage.webp` sibling (catalog JPEG stays on the card desk and the
home promo fan). First eight visible tiles are `loading=eager`; the first
four use `fetchPriority=high`.

### Homepage first paint (do not regress)

Checklist only — rationale and file map are in
[HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md).

1. Promo carousel (local).
2. `sessionStorage` public vector if present → paint New / Best / Featured /
   Popular / grid immediately.
3. Rails vector with **no** auth wait. Attach recents **synchronously**.
4. Grid images: `/card-images/{leftover-key}_homepage.webp`, then JPEG.

Deferred (skeletons only on Recently seen if local ids are not in the vector):

5. Tile JSON for leftover recents.
6. After Firebase `ready`, `syncRemoteRecentCardIds()`.

Do **not** gate `fetchHome` on `useAuth().ready`. Do **not** `await`
`getDoc(user_card_recent_views)` before the public vector. Do **not** put
`fetchCardTiles` inside `Promise.all` with the rails. Worker cache lookup
must not call Supabase `updated_at` before `caches.default.match`. Do **not**
treat Flutter `api.pokoin.com/api/marketplace-home` as the SPA vector.

| Rail | What it is | Rank | Price on the tile |
| --- | --- | --- | --- |
| Promo | Five current English sets | local `PromoCarousel` | set page, not this row |
| Recently seen | Last 24 card ids | localStorage, or Firestore `user_card_recent_views` if signed in | not in the 1-day vector |
| New cards | **Shop mix**, unique **names**: one chase (`n>m`) + one in-set (`n≤m`, not Energy) per live English set (Mega Evolution, Phantasmal Flames, Black Bolt, White Flare, Destined Rivals) | collector number + `card_id` desc | waterfall above, live CT overlay |
| Best sellers | **Units sold (7d)** among cards **listed now** in the hub, median sold ≤ €15 (playables not chase gold). Skip basic Energy. Unique names. | `sold_qty_7d DESC` | hub cache or median PKN |
| Featured | **Shelf speed**: `sell_through DESC` then `demand_score`, among cards with **≥8 listings** (avoids 3-copy promo “fake tight”). Disjoint from Best sellers by name, max 2 per set. | `sell_through`, `demand_score` | same |
| Popular | Same pool as Best sellers filters: units then demand among listed cards | `sold_qty_7d DESC`, `demand_score` | same |
| Marketplace grid | Same shop mix as New cards (up to 16) | same as New cards | same |

High PKN on a gold or SR is the rate, not a conversion bug: €1 = 200 PKN
(`EUR / 0.005`). Mega Lucario ex gold ~€150 → ~30,128 PKN. Two tiles named
Victini were two printings (Black Bolt 171/086 vs White Flare 172/086); the
mix now keeps one name. Levincia gold 244/182 is a stadium — Iono is in
the art, the catalog name is Levincia.

### Listing pipeline (Oracle → Supabase)

```
CardTrader daily (03:20 UTC, flock)
  GET /marketplace/products?expansion_id=  → snapshots (Oracle only)
  sold comps from removed_history if reason is inferred_sale /
    quantity_decreased / missing_from_cardtrader_market_snapshot
    (dropped_from_cheapest_25 is not a sale)

Native POST /api/marketplace-listings
  appear / qty-down / sold_out → marketplace_user_listing_events

every 15 min  refresh-listing-weights.py
  stats_daily → marketplace_card_weights (unit / sell-through formulas)

every 10 min  sync-supabase-rails.py
  SQL tiles + PKN + live CT overlay for new sets
  Valkey `pkn:ct:{blueprint}` TTL 6h (misses 5 min)
  → Supabase marketplace_rails / _card_tiles / _card_weights

Worker GET /api/marketplace-home  (pokoin-origin)
  stable Cache API key, SWR revalidate via waitUntil
  recently seen stays local / Firebase (after paint)

SPA Home.jsx
  sessionStorage vector → fetchHome (no auth wait)
  attachRecentsToHome sync → tiles fetch for missing ids only
  CardTile: _homepage.webp then JPEG; formatPkn(price) or —
```

On **pokoin.com**, `GET /api/marketplace-home` is the Worker vector (1 day).
The Flutter app still calls **api.pokoin.com** `GET /api/marketplace-home`
(Valkey 30s, ~170 KB). The SPA must not use that payload. First paint:
[HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md).
Oracle `GET /api/marketplace-home-page` remains the fallback if Worker and
Supabase rails are both unavailable.

**Valkey, not Redis.** Honcho on nezopt and Nextcloud’s cache image are
`valkey/valkey`. Marketplace runs a **32 MB** Valkey on
`pokoin-marketplace` (`127.0.0.1:6379`, host network, no persistence).
Do **not** put Valkey or Redis on `pokoin-peer1`. The 1 GB micro cannot
hold a large cache; Madrid A1 is where this can grow. Supabase rails stay
the SPA source of truth.

**Card images / R2:** public URLs stay `https://cdn.pokoin.com/…` (set by
`POKOIN_CARD_CDN_BASE_URL` at import). Oracle origin is
`https://api2.pokoin.com` on peer1 (same paths + public→leftover remap).
See [GAMES.md](GAMES.md). Do not rewrite DB URLs — cut over `cdn.pokoin.com`
DNS to peer1 after the R2→disk sync. Catalog masters are leftover-key JPEGs.
Home/search tiles use the `_homepage.webp` sibling (240px, q82) generated by
`cardvault/.../scripts/generate-oracle-homepage-card-images.js` (R2) and
`generate-oracle-disk-homepage-webp.py` (peer1 disk). `imageSrc(..., 'grid')`
rewrites `.jpg` → `_homepage.webp` and `CardArt` falls back to JPEG on 404.
Desk/hero and the home promo fan use leftover JPEG (`CardArt full` /
`preferFullImage`); `CardArt` does not upgrade a JPEG src to the homepage
derivative. Grid/search tiles still use `_homepage.webp` and fall back to
JPEG on 404.

Install: `scripts/install-marketplace-valkey.sh` then
`scripts/install-listing-pipeline.sh`.

```
PKN            = EUR / 0.005
best_seller    = sold_qty_7d                    (integer; publisher also filters listed_now>0, median≤€15)
demand         = ln(1 + 80 × ((qty/7)/listed)) if qty≥3 and listed>0
featured       = demand + 2×sell_through×ln(1+qty)   (no hot_score)
combined       = sold_qty_7d + 10×demand + native
```

**Why the old rows looked the same.** Featured still used raw `hot_score_24h` (values ~400–1000), so Supreme Victors FB promos with tiny listed counts beat Fezandipiti/Galvantula. Best sellers included vintage cards with **zero** hub listings (Magneton 227 units, listed=0). The fix is simpler sorts on real columns, not nationality filters.

Publisher: `scripts/sync-supabase-rails.py` on `pokoin-marketplace`
(`supabase-rails-sync.timer`). Weights: `scripts/refresh-listing-weights.py`
(`listing-weights.timer`). Formula SQL:
`scripts/sql/listing-weight-formulas.sql`. Install:
`scripts/install-listing-pipeline.sh`.

See [MADRID_MARKETPLACE.md](MADRID_MARKETPLACE.md).

```
pokoin-web/                 scripts/build-web.sh          Vercel project `web`
index.html + home/  ──►     dist-web/index.html              pokoin.com/
market/             ──►     dist-web/market/                /marketplace → /market/index.html
vercel.json                 humans → /market/index.html
                            /cardscan/identify → cardscan.pokoin.com
                            /chain/* → rpc.pokoin.com
                            /api/* → api.pokoin.com
```

```bash
cd /home/nez/Projects/pokoin-web
env -u VERCEL_TOKEN vercel pull --yes --environment=production
env -u VERCEL_TOKEN vercel build --prod --yes
env -u VERCEL_TOKEN vercel deploy --prebuilt --prod --yes --archive=tgz
```

`vercel.json` runs `scripts/build-web.sh` into `dist-web/` (landing + hashed
`market/` assets). Do not deploy the GitHub tree as static files — that ships
the Vite `src/main.jsx` shell and 404s `/marketplace`. `scripts/sync-market.sh`
copies into CardVault and is leftover; it is not production. See [APP.md](APP.md).

Local Vite:

```bash
cd /home/nez/Projects/pokoin-web/market
npm install
npm run dev
# http://192.168.178.55:5174/marketplace
# Vite proxies /api → api.pokoin.com, /chain → rpc.pokoin.com,
# /cardscan/identify → cardscan.pokoin.com/identify (not the SPA).
```

Oracle API is Docker `pokoin-oracle-api` on SSH `pokoin-marketplace`.
Do not use `deploy-oracle-api-peer3.sh`.

---

## Verify

```bash
curl -sS --max-time 8 https://api.pokoin.com/api/__contract | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["version"])'
curl -sS --max-time 8 'https://api.pokoin.com/api/marketplace-home-page'
curl -sS --max-time 8 'https://api.pokoin.com/api/marketplace-card-page?cardId=703358'
curl -sSI https://pokoin.com/232378 | head
curl -sSI https://pokoin.com/marketplace/en/cards/248768/ | head
curl -sSI https://pokoin.com/marketplace/en/cards/248768 | head
curl -sSI https://pokoin.com/marketplace/248768 | head
curl -sS https://pokoin.com/marketplace | grep -F '/market/assets/'
curl -sS https://pokoin.com/ | grep -F 'The market belongs to the collectors'
```
