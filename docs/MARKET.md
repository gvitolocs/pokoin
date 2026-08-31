# Pokoin.com React marketplace — pipeline and APIs

Source of truth for the public web: this repo (`gvitolocs/pokoin`). CardVault
is the Flutter app (Android/iOS), not pokoin.com. Production is Vercel project
`web`. Humans and bots hitting `/marketplace`, `/marketplace/search`,
`/marketplace/:lang/cards/:id`, `/marketplace/:lang/cards/:id/:slug`, and
`/marketplace/sets/:slug` (with or without a trailing slash) get
`market/index.html`. App routes this SPA does not claim (`/wallet`, `/cart`,
`/forum`, `/marketplace/signal`, `/inventory`, `/auth`) punch out to
`https://app.pokoin.com` (Flutter, Vercel project `pokoin-flutter`). See
[CHROME.md](CHROME.md).

Visual language follows `/home/nez/Projects/candyext`: Rare Candy shop chrome
(dark rails, chips, gold `#FFD33D` not lime `#cbf062`). **Card detail is the
Flutter desktop marketplace**, not Collectr’s Printing column.

Collectr is a portfolio / price-guide product page (identity + charts +
affiliate TCGPlayer / eBay). CardTrader is a first-party marketplace: buy box
+ offer table in the first viewport. Pokoin sells and settles in PKN, so the
old Flutter layout is the right model — action-first, not analytics-first.
Do not clone Collectr ungraded/graded SVG history. `sales` on the BFF is empty.
Flutter’s “+4.2% / 24h” pill was fabricated from listing spread; React shows
honest `24h —` until completed purchases exist.

## Card page (Flutter `_TopTerminal`, wide >960px)

`300px` art | flex-2 center | `300px` Best Deal. Shop (`_ListingsTerminal`) is
**below** the hero row. Wide layout uses `align-items: stretch` so the art
panel, sell form, and Best Deal column share one bottom edge. **Below 960px** stack is Best Deal → art → Shop → analytics/sell form (same as
Flutter narrow); those panels use `flex: none` so stacked layout does not
stretch. **Below 480px** (iPhone 16) the stack is art first, then Best Deal.

1. Asset header: Pokémon + rarity badges (never show `Card` as rarity), name,
   `set number · artist|type`, Floor (native listings only), honest `24h —`,
   watchlist, share
2. Left: `< collector-number >` **above** the scan (not overlaid), JPEG hero in
   a padded frame (**no** `--tcg-corner` clip-path, **63:88** box so the scan
   does not shove the rails), version `<select>` **always mounted** (current
   printing as the first option; extra versions fill the menu later — never
   swap in a `<p>`), View all versions → `{canonicalPath}/versions`.
   **Phone (`max-width: 480px`, iPhone 16 393×852):** stack is art → Best Deal
   → shop → list form so the scan is in the first viewport. Tablet `≤960px`
   stays Flutter-narrow: Best Deal → art → shop → list form. See
   [MOBILE.md](MOBILE.md).
3. Center: honest empty analytics (“No sold-card analytics yet…”) + **inline
   List your card** form (Price, PKN, Qty, Condition, Language, Foil, chips
   1st Ed. / Sealed / Graded / Signed / Shipping, seller comment). **List card**
   POSTs `POST /api/marketplace-listings` with the Firebase ID token when the
   user is signed in (same public web config as Flutter
   `DefaultFirebaseOptions.web`). Unsigned: button stays off, **Sign in**
   punches `/auth`. Do not send `listingId` in events. Reserve/NFT stay off
   until those APIs are wired.
4. Right: Best Deal (Sign in to unlock Silver CT/CM/VT, language/condition,
   Add to cart only with a native listing else Unavailable, estimated total /
   escrow 0.30% / slippage 1.00%) + POKOIN CARD RESERVE copy
5. Shop table below: filters/sort when listings exist; empty `No items found` +
   watchlist + Sell this card
6. Other printings rail

Click the scan to zoom (React lightbox). Flutter’s art tap was Hero back to
marketplace — do not copy that; keep the lightbox. Mount `<dialog>` only while
zoom is on; **never** set `display` on a closed dialog.

Header does **not** pin Mega Evolution / Phantasmal Flames / Black Bolt. Flutter
top-bar: search, EN flag (visual; language menu is Flutter), Home, Forum,
Signal, Competitive, **0 PKN**, profile/sign-in, cart **0**. Sell stays off
the global bar. Punch-outs: [CHROME.md](CHROME.md). On **phone** (`≤720px`)
that icon row is the burger panel; `≤480px` search submit is an icon. Layout
notes: [MOBILE.md](MOBILE.md).

Marketplace home (`/marketplace`) paints the Mega Era promo, rails, and grid
immediately. Set browse (`/marketplace/sets/:slug`) and search do the same —
skeleton tiles, never “Loading set…” / “Searching…”. Card pages seed from the
tile you clicked. The landing page prefetches this SPA and `/api/marketplace-home-page`
on idle and on hover of Explore cards.

## Action map (every control)

| Surface | Control | What happens |
| --- | --- | --- |
| Top bar | Search | Autocomplete → card page; submit → `/marketplace/search` |
| Top bar | Logo | Marketplace home |
| Top bar | Home / Forum / Signal / Competitive | Home → `/`. Others → `https://app.pokoin.com/…` ([CHROME.md](CHROME.md)) |
| Top bar | 0 PKN | `https://app.pokoin.com/wallet` |
| Top bar | Profile icon | Signed in → `https://app.pokoin.com/profile`; unsigned → `https://app.pokoin.com/auth?from=` |
| Top bar | Cart | `https://app.pokoin.com/cart` |
| Header | Set name | Set browse |
| Header | Artist | Flutter artist collection on `app.pokoin.com` |
| Header | Watch | `localStorage pokoin.watchlistIds` + `POST /api/marketplace-watchlist` (local until signed in) |
| Header | Share | Web Share or clipboard |
| Art | Prev / next | Same-set sibling via expansion page; do not clear siblings on cardId change |
| Art | Scan click | Lightbox zoom |
| Art | Version select | Always in the art column. Seeded with this printing; other printings fill after `marketplace-card-page`. Same height either way. |
| Art | View all versions | Flutter `{canonicalPath}/versions` on `app.pokoin.com` |
| Center | Listing fields | Local form state only |
| Center | Extra chips | Toggle 1st Ed. / Sealed / Graded / Signed / Shipping |
| Center | Sign in / List card | Sign in → `app.pokoin.com/auth`; signed-in List card POSTs with Firebase bearer |
| Best Deal | Language / condition | Filter native listings |
| Best Deal | Add to cart / Unavailable | Cart only with a native listing → `app.pokoin.com/auth` |
| Best Deal | Sign in to unlock | `app.pokoin.com/auth` (no CT/CM/VT without Silver + bearer) |
| Shop | Sort / condition / language | Client filter of native listings |
| Shop | Listing row | `app.pokoin.com/auth?from=` so Flutter attaches the listing |
| Shop empty | Watchlist / Sell this card | Same as Flutter empty terminal |

Do not send `listingId` in `marketplace-event`.

## Card URLs

Public id is `card_id` (CardTrader blueprint × 2). Never put `ct_id` in the
address bar.

| URL | What happens |
| --- | --- |
| `/marketplace/{lang}/cards/{id}/{slug}` | Canonical. SPA. |
| `/marketplace/{lang}/cards/{id}` | Short. SPA, then `replace` to `canonicalPath`. |
| Same paths with a trailing `/` | Same. Vercel must rewrite the slash form to `/market/index.html` or it 404s (`x-vercel-error: NOT_FOUND`). |
| `/marketplace/{id}` | Oracle `GET /api/marketplace-card-shortlink` → 302 to canonical. |
| `/{id}` | Same shortlink 302 (`https://pokoin.com/232378`). |
| `/{id}/{slug}` | Same shortlink 302. |

Example (Drifloon 248768):

- Short: `https://pokoin.com/marketplace/en/cards/248768/`
- Canonical: `https://pokoin.com/marketplace/en/cards/248768/card-drifloon-lv-17-non-holo-promo-6-17-pop-series-6`

The React card page already `navigate(canonicalPath, { replace: true })` when
the path has no slug. The 404 was Vercel: `/marketplace/:language/cards/:cardId`
does not match a trailing slash unless that source is listed.

Numeric shortlinks stay on the Oracle BFF so one 302 can mint the slug. Do not
point `news.pokoin.com` at these rewrites.

---

## Why the JPEG scan looked better than PNG

Catalog heroes (`heroImageUrl`) are **JPEG photographs of cardboard**, typically
~500×688. That is the native scan: continuous tone, print dots, dirty white
border. Flutter `preferDetailMarketplaceImage` paints that JPEG with
`BoxFit.contain` inside a padded frame so you see the whole card.

PNG looked worse because:

1. **Clip-path** (React `.hero-art` used `--tcg-corner`) cut the printed white
   border and made a photo look like a flat digital sticker.
2. **JPEG→PNG does not add detail.** Re-wrapping a scan as PNG (or a PNG of a
   screenshot) keeps JPEG ringing and often adds halo against navy.
3. PNG is the right format for flat graphics with alpha, not for photos. The
   source is a photo.

Keep serving the **JPEG** `heroImageUrl`. Never convert to PNG. Do not clip
the detail hero. Zoom softness is the 500px source, not the codec.

Artist is a Flutter punch-out: `/marketplace/{lang}/artists/{slug}`. View all
versions is `{canonicalPath}/versions` (Flutter `CardVersionsScreen`).

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
first paint — same as Flutter Firestore listings. Catalog `card.price` is
not a buyable ask. Empty native listings: Floor `—`, **Unavailable**, “No
sellers yet.” Sign in to unlock punches `/auth`. List card already sends a
Firebase ID token; do not open CT/CM/VT without Silver + that same bearer.

Do **not** clone Collectr’s ungraded/graded SVG history or affiliate TCGPlayer /
eBay rows. Shop rows are native `GET /api/marketplace-listings?nativeOnly=1`
only. Gold, not Collectr teal. Flutter still owns cart / wallet / inventory.

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

Qwen (`qwen3.8:27b-128k`, think:false) agreed on printing identity, rails,
chips, and Flutter punch-out. Ignore its POST-for-page-BFFs and `ct*` cardId
examples — those contradict the live contract. Page BFFs are **GET**.

---

## APIs this SPA may call

| URL | When |
| --- | --- |
| `GET /api/marketplace-home-page` | Home (not Flutter `marketplace-home`) |
| `GET /api/marketplace-search-page?query=` | Search + load more |
| `GET /api/marketplace-card-page?cardId=` | Detail shell. `includeOffers=0` by default |
| `GET /api/marketplace-listings?cardId=&nativeOnly=1` | Listings table after first paint |
| `POST /api/marketplace-listings` | Create listing. Bearer Firebase ID token |
| `GET /api/marketplace-expansion-page?slug=` | Set browse |
| `POST /api/marketplace-autocomplete` `{ search_term, result_limit, search_language }` | Searchbar only, 280ms debounce |
| `POST /api/marketplace-event` | Actions above |

---

## Speed (card page must be fast)

Do **not** wait for listings, sameAs, or live CardTrader before painting the
printing. Shopify-style: await identity + hero, stream offers after. Collectr
charts stay out of this SPA until the BFF has a real series.

The API box `pokoin-marketplace` is an Always Free **E2.1.Micro (1 GB)**. You
cannot merge the two AMD micros into one bigger AMD VM — that quota is two
fixed 1 GB shapes. Oracle halved Always Free Ampere in 2026: the unpaid “big
VM” is **Ampere A1 Flex 2 OCPU / 12 GB**, not 4/24 (4/24 is paid). Target:
Postgres + `pokoin-oracle-api` + Meili + Caddy on `pokoin-a1`; seed stays on
`pokoin-peer1`. `pokoinpos-peer2` on the marketplace micro stays stopped. Do
not delete boot volumes. Hunt/migrate: `scripts/oci-a1-2x12-hunt.sh`.

Set browse uses indexed `marketplace_search_candidates` (`readCardsForSet`),
not `snapshotForExpansion` (distinct-on `marketplace_card_versions`, ~6s).
Hypemeter / `news.pokoin.com` hunt is `scripts/oci-a1-2x12-hunt-news.sh`
(no marketplace migrate). Pipeline: [NEWS.md](NEWS.md).

---

## Pipeline (edit → live)

This repo is the public web. CardVault is the Flutter app. Do not ship the
marketplace through `cardvault/.../build/web`.

```
pokoin-web/                 scripts/build-web.sh          Vercel project `web`
index.html + home/  ──►     dist-web/index.html              pokoin.com/
market/             ──►     dist-web/market/                /marketplace → /market/index.html
vercel.json                 humans → /market/index.html
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
is leftover CardVault copy; it is not production.

Local Vite:

```bash
cd /home/nez/Projects/pokoin-web/market
npm install
npm run dev
# http://192.168.178.55:5174/marketplace
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
