# Pokoin.com React marketplace — pipeline and APIs

Source of truth for the **public web**: this repo (`gvitolocs/pokoin`).
Production is Vercel project `web`. Android/iOS CardVault is a separate app:
[APP.md](APP.md). Do not alias `app.pokoin.com` onto project `web`.

Humans and bots hitting `/marketplace`, search, card, sets (with or without a
trailing slash), competitive, explore, portfolio, watchlist, products, auth,
profile, cart, checkout, orders, wallet, forum, signal, scan, inventory, nft,
admin, and the static docs pages get `market/index.html`. Chrome:
[CHROME.md](CHROME.md).

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
   Add to cart only with a native listing else Unavailable, estimated total /
   escrow 0.30% / slippage 1.00%) + POKOIN CARD RESERVE copy
5. Shop table below: filters/sort when listings exist; empty `No items found` +
   watchlist + Sell this card
6. Other printings rail

Click the scan to zoom (React lightbox). Do not navigate Home on art tap.
Mount `<dialog>` only while zoom is on; **never** set `display` on a closed
dialog.

Header does **not** pin Mega Evolution / Phantasmal Flames / Black Bolt. Top
bar: search, EN flag (visual only), Home, Forum, Signal, Competitive, PKN
chip, profile/sign-in, cart. Sell stays off the global bar. Routes:
[CHROME.md](CHROME.md). On **phone** (`≤720px`) that icon row is the burger
panel; `≤480px` search submit is an icon. Layout notes: [MOBILE.md](MOBILE.md).

Marketplace home (`/marketplace`) paints a 5-expansion promo carousel (Mega
Evolution, Phantasmal Flames, Black Bolt, White Flare, Destined Rivals), rails,
and grid immediately. Each slide is official-set copy plus a 3-card fan that
overflows the banner; autoplay pauses on hover, with arrows and dots. Set browse (`/marketplace/sets/:slug`) and search do the same —
skeleton tiles, never “Loading set…” / “Searching…”. Card pages seed from the
tile you clicked. The landing page prefetches this SPA and `/api/marketplace-home-page`
on idle and on hover of Explore cards.

## Action map (every control)

| Surface | Control | What happens |
| --- | --- | --- |
| Top bar | Search | Autocomplete → card page; submit → `/marketplace/search` |
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
| Header | Share | Web Share or clipboard |
| Art | Prev / next | Same-set sibling via expansion page; do not clear siblings on cardId change |
| Art | Scan click | Lightbox zoom |
| Art | Version select | Always in the art column. Seeded with this printing. |
| Art | View all versions | `{canonicalPath}/versions` in this SPA |
| Center | Listing fields | Local form state only |
| Center | Extra chips | Toggle 1st Ed. / Sealed / Graded / Signed / Shipping |
| Center | Sign in / List card | Sign in → `/auth`; signed-in List card POSTs with Firebase bearer |
| Best Deal | Language / condition | Filter native listings |
| Best Deal | Add to cart / Unavailable | Native listing → local cart then `/cart` |
| Best Deal | Silver CT / CM / VT | Unsigned → `/auth`. Signed-in unlock `POST /api/unlock-silver` (20 site PKN). Silver: CT `/api/cardtrader-redirect`, CM JSON then URL (409 honest), VT Vinted search. Gold pills, not Cardmarket blue. |
| Shop | Sort / condition / language | Client filter of native listings |
| Shop | Listing row | Adds that offer to the local cart |
| Shop empty | Watchlist / Sell this card | Watch toggles local ids; Sell → `/auth` if unsigned |

Do not send `listingId` in `marketplace-event`.

## Other SPA pages (user actions)

| Page | Actions |
| --- | --- |
| `/marketplace` | Promo slides, rails, grid, Sell callout → `/inventory` |
| `/marketplace/search` | Query, load more, tile → card |
| `/marketplace/explore` | Type/price/lang/game filters, dump watch, page 48 |
| `/marketplace/portfolio` | Game bars, rails, search holdings, holding desk |
| `/marketplace/sets` | Expansion index (limit 80) → set desk |
| `/marketplace/watchlist` | Hydrate ids, clear, tiles |
| `/product/:kind` | Seeded search (box/pack/graded/nft). Empty `query=` times out — do not. |
| `/marketplace/competitive…` | Candyext Limitless dump: tournaments, decks, lists, players, cards |
| `/forum` | Categories, topics, create (bearer), replies, image upload after topic/post id |
| `/marketplace/signal` | Dump asking + home rail counts. No fake 24h. |
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
| `/marketplace/{lang}/cards/{id}` | Cloudflare Worker 302 from KV (`POKOIN_CARD_PATHS`) to the canonical slug URL. |
| Same paths with a trailing `/` | Same. Vercel must still rewrite the slash form of the SPA to `/market/index.html` or it 404s (`x-vercel-error: NOT_FOUND`). |
| `/marketplace/{id}` | Same Worker 302 (`https://pokoin.com/marketplace/239324`). |
| `/{id}` | Same Worker 302 (`https://pokoin.com/239324`). |
| `/{id}/{slug}` | Same Worker 302. |

Example (Gambler 239324):

- Short: `https://pokoin.com/239324`
- Canonical: `https://pokoin.com/marketplace/en/cards/239324/card-gambler-060-062-fossil`

Worker: `workers/pokoin-shortlink.js`, routes `pokoin.com/*` and `www.pokoin.com/*`.
Canonical slugs are a packed in-Worker index (`card-ids.bin`,
`card-starts.bin`, `card-slug-blob.gz`) dumped from Postgres. Lookup is a
binary search in the isolate — no KV and no Oracle on the request path, so
there is no cold KV read. 302s set `Cache-Control` / `s-maxage` and Workers
Caching is on. Unknown ids (not in the packed index) **404** with `no-store` —
they must not 302 to `/marketplace/en/cards/{id}/card` (that fake slug was
getting cached). Refresh the map with
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
CT/CM/VT pills render only when Firestore says Silver (or admin). List card
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

Images: `gridImageUrl` / `heroImageUrl` from the page BFF. Never `/previews/`.
Autocomplete thumbs use `cdn_image_url` only if it is not a preview path.

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
| `GET /api/marketplace-home-page` | Home (not `marketplace-home`) |
| `GET /api/marketplace-search-page?query=` | Search + load more |
| `GET /api/marketplace-card-page?cardId=` | Detail shell. `includeOffers=0` by default |
| `GET /api/marketplace-listings?cardId=&nativeOnly=1` | Listings table after first paint |
| `POST /api/marketplace-listings` | Create listing. Bearer Firebase ID token |
| `POST /api/marketplace-orders` | Paid checkout. Bearer. `fulfillmentMode` physical or nft_only |
| `POST /api/marketplace-orders?action=nft-shipping-request` | NFT shipping intent. Bearer |
| `POST /api/create-pkn-checkout-session` | Stripe PKN packages |
| `POST /api/unlock-silver` | 20 site PKN Silver |
| `GET /api/marketplace-expansion-page?slug=` | Set browse |
| `GET /api/marketplace-suggest?q=` | Header typeahead (Meili-only, grouped printings, ~120ms debounce). Plain prefix → base name first (`mimik` → Mimikyu). |
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
Browse rails now read **Supabase** (`marketplace_rails` / `marketplace_card_tiles`),
published every 10 min from the marketplace box. Oracle Postgres stays search +
source of truth. See [MADRID_MARKETPLACE.md](MADRID_MARKETPLACE.md).

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
