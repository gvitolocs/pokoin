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
card ids are still `ct_id * 2` on every game. Storm Emeralda Combee 006/076
is leftover `403034` → desk `806068`. Pokemon stays the default when
`game` is omitted. Re-import of every CardTrader game keeps Oracle as the
GET hop and 15T as the writer; images stay on the 15T, not the Pi:
[MULTIGAME_REIMPORT.md](MULTIGAME_REIMPORT.md).

Humans and bots hitting `/marketplace`, search, card, sets, eras (with or without a
trailing slash), Pokémon / rarity / language / guide hubs, competitive, explore, portfolio, watchlist, products, auth,
`/extension/auth-bridge`, profile, seller `/marketplace/{lang}/users/{username}`, cart, checkout, orders, wallet, forum,
signal, scan, inventory, nft, admin, and the static docs pages get
`market/index.html`. Chrome:
[CHROME.md](CHROME.md). SEO hubs (Pokémon / rarity / language / guides) and
bot HTML: [SEO.md](SEO.md). Every card-art surface (tile vs suggest crop vs desk):
[CARD_ART.md](CARD_ART.md). Illustrators (leftover PK vs public `card_id`):
[ARTISTS.md](ARTISTS.md). JP/CN print flags (suggest + set title, Flutter
port notes): [PRINT_FLAGS.md](PRINT_FLAGS.md).

**Link-preview bots:** they do not run the SPA. Worker `pokoin-origin`
(`marketplace-card-og.js`) matches Discord / Twitter / Slack / LinkedIn /
Facebook / WhatsApp / Telegram / Googlebot and peers on
`/marketplace/{lang}/cards/{id}…`, loads `GET api.pokoin.com/api/marketplace-card-page`,
and returns **HTML** with `og:title` / `og:image`. Social scrapers still omit
the leftover subtitle and send `x-robots-tag: noindex`. **Googlebot / bingbot**
get an indexable document (`index, follow`) with H1, crawlable `<a href>`
crumbs, neighbor links, and `Product` JSON-LD. Cache key version `v5` splits
`search` vs `social`. Humans still get the SPA. Force with `?og=1` or `?bot=1`.
Hub paths under `/marketplace/{lang}/pokemon|rarities|languages|guides` use the
same worker for search engines. Browser `max-age=300`, edge `s-maxage=3600`.
Bot Fight Mode
blocks `Discordbot` on `/marketplace/` unless the **card-images skip rule**
also lists those user-agents. After a failed paste, Discord caches the 403 —
delete the message and send the URL again (or append `?v=2`).

Visual language follows `/home/nez/Projects/candyext`: Rare Candy shop chrome
(dark rails, chips, gold `#FFD33D` not lime `#cbf062`). **Card detail is an
action-first market desk** (art + list + Best Deal + shop table), not
Collectr’s Printing column.

Collectr is a portfolio / price-guide product page (identity + charts +
affiliate TCGPlayer / eBay). CardTrader is a first-party marketplace: buy box
+ offer table in the first viewport. Pokoin sells and settles in PKN, so this
desk stays action-first, not analytics-first. Do not clone Collectr
ungraded/graded SVG history. `sales` on the BFF is empty. Do not invent a
24h % from listing spread. The gold graph and header 24h come from
`GET /api/marketplace-card-sales` (`series.days`, `series.change24hPct` as a
**fraction** — SPA multiplies by 100). Empty `pct` paints `24h —`. That is
inferred CardTrader sold medians, not a settled Pokoin purchase.

## Card page (wide >1100px)

`300px` art | flex-2 center | `300px` Best Deal. Shop is **below** the hero
row. Wide layout uses `align-items: stretch` so the art **panel**, sell form, and
Best Deal column share one bottom edge. The scan itself stays a **fixed 63:88**
slot (`.art-frame`); extra panel height sits under **More versions...**, not
as letterbox around the card. **1100px and below** the Best Deal
column drops under art+center. **Below 720px** (same compact chrome as the
search suggest) the stack is Best Deal
→ art → Shop → analytics/sell form; those panels use `flex: none` so stacked
layout does not stretch. **Below 480px** (iPhone 16) the stack is art first,
then Best Deal.

1. Asset header: two lines — name with watch/share on the right; `set number · artist|type`
   with last-day sold median PKN (`GET /api/marketplace-card-sales` →
   `series.lastMedianPkn`) and `24h ±n.n%` from `series.change24hPct` (or
   `24h —` when that field is empty) on the right. No Pokémon/rarity pills.
   Subtitle is set + collector + artist. Do not append a “Card” type label.
2. Left: ‹ › **above** the scan (not overlaid). JPEG hero in a **fixed
   63:88** `.art-frame` the width of the version select (**no** `--tcg-corner`
   clip-path; do not stretch the frame to the Best Deal / sell-form height).
   Gold rounded
   rectangle between the arrows is the rarity label (`Holo Rare 003/112`), not
   the collector number alone. When this set has another rarity, that control
   is the version `<select>` (gold chevron) — change Illustration Rare there.
   ‹ › always walk the expansion (collector order, wrapping), not regular↔IR
   of the same Pokémon. When there is no other rarity, the gold control is a
   `<span>` — no dropdown arrow. **Set-symbol circles** always sit under the
   scan (even a singleton expansion). **More versions...** sits under those
   circles when this card has another rarity or another artwork. When the CLIP
   group has **more than five** expansions, circles drop and only the link
   remains. Changing Ultra Rare → Full-Art
   refetches `marketplace-version-set` so the circles update. Do not feed
   exact-name rows into that row — that kept every expansion of the English
   name and did not move when the select changed. Do not copy CardTrader’s
   one list of JP regular + JP IR + EN regular + EN IR.
   **Phone (`max-width: 480px`, iPhone 16 393×852):** stack is art → Best Deal
   → shop → list form so the scan is in the first viewport. Compact chrome
   `≤720px` (same as search suggest): Best Deal → art → shop → list form.
   See [MOBILE.md](MOBILE.md).
   3. Center: gold **sold-median graph** (`market/src/sold-graph.js`) when
   `GET /api/marketplace-card-sales?cardId=&slices=1` returns stored daily
   combinations (`slices`). First paint may use `localStorage`
   (`sold-sales-cache.js`, key `pokoin.cardSales.v11.`, TTL 15 days). The
   desk still refetches slices on each visit so a new persist day is not
   stuck. Filter
   clicks only recompute locally — tiles / versions last-median still use the
   thin `marketplace-card-sales` series (no `slices`). Empty graph copy is
   “No sold-card analytics yet…”. Overlay stays **one line** inside the 12rem
   tile: **Reverse** / **1st Ed.** / **Graded**, then **All languages** /
   **All conditions**, then **n units**. Phone (`≤720px`) keeps that one
   line and tightens padding/type instead of wrapping. Menus list
   keys that exist in the current **Reverse / 1st Ed. / Graded** slice (after
   nationality). One reverse Near Mint sale shows **Near Mint**, not **All
   conditions**; one-language reverse shows **English**, not **All languages**.
   Language and condition do **not** shrink each other, so clicking a Poor
   Italian day still leaves **All languages** when the printing also sold in
   other languages. A flag state with no matching comps keeps the printing
   menus (`sold-sales.js` fallback); the UI avoids reaching it via chip
   hiding and the standard-variant snap. A dropdown with only one key in that
   slice shows that key
   (no **All**). Japanese and Korean expansions
   (`pokoin_pokemon_expansions.nationality`) only offer Asian TCG langs
   (JP, KO, ZH, ZHT, ID, TH, VI) on the graph, Best Deal, list form, and shop
   — not EN/IT/FR/…. Card payloads often omit `nationality`; the desk reads
   it from `GET /api/marketplace-expansion-page?slug=`. A JP-only printing
   uses JP from the cached slices, not mixed All.
   **Reverse**, **1st Ed.** and **Graded** are strict two-state switches, off
   by default: off plots the **standard copies only** (flag `false` — reverse
   holos never bleed into the default median), gold plots that variant only.
   The three flags combine orthogonally (they mirror the
   `cardtrader_sold_daily` slice key), so Reverse+1st Ed. is the reverse
   1st-edition slice. A chip only renders when the printing actually sold
   that variant (visibility is printing-wide, not scoped to the current
   combo). A printing that never sold the standard variant — 1.7k mostly
   reverse-holo promo/blister printings — **snaps the chip back on** on load
   (`soldGraphView.flags`), so the stricter default never blanks a graph;
   both-on combos may still be empty. The Pi stores those daily slices in
   `cardtrader_sold_daily`. The tile is a **fixed 12rem** `.sold-graph`
   while sales load, when empty, and when plotted — no “Loading sold-card
   analytics…” label. Hover shows that day’s PKN and a locale
   date (`03/09` in IT/EU, `09/03` in US); the tip hides when the pointer
   leaves.    Top-right **n units** is copies sold in the current
   slice (`series.soldQty`, summed from each day’s `soldQty`). Those points
   are snapshot diffs keyed by **seller stack** (seller + language +
   condition + foil facets). `inferred_sale` is that stack gone from the
   complete book; `quantity_decreased` is the same listing qty-down. CardTrader
   product id is not the identity — see **Sold comps**
   under Listing pipeline below. Hover also shows that
   day’s count. Clicking a plotted day sets the top menus to traits those
   units share: one unit aligns language, condition, Reverse, 1st Ed., and
   Graded; several units only change keys they all share (mixed keys stay
   **All** / toggles off). Reverse / 1st / Graded still shrink the option
   lists to that foil slice; language and condition do not, so you can switch
   language or return to **All**. Listing-event count stays on `sampleCount` /
   `cardtrader_sold_daily.sample_count` (a vanished stack of 8 is one event,
   eight units). Y-axis is 0–50 by tens, then 0–500, 0–2500, 0–5000, 0–50k,
   then 0–125k by 25k (2.5–5–10) — labels stay put
   while the line stretches to the panel. Not Collectr ungraded/graded SVG.
   **Inline List your card** form (Price, Currency PKN/EUR/USD/DKK, Qty, Condition, Language, Foil, chips
   1st Ed. / Sealed / Graded / Shipping, seller comment). **List card**
   POSTs `POST /api/marketplace-listings` with the Firebase ID token when the
   user is signed in (same public web config as Android/iOS
   `DefaultFirebaseOptions.web`). Unsigned: button stays off, **Sign in**
   punches `/auth`. Do not send `listingId` in events. Reserve copy stays
   informational until a reserve API exists.
4. Right: Best Deal (Silver CT/CM/VT, language/condition,
   Add to cart only with a native listing else Unavailable)
   + POKOIN CARD RESERVE copy
5. Shop table below: one-line filters/sort when listings exist; trash only on
   your listing row; empty `No items found`. Username is a gold link to
   `/marketplace/{lang}/users/{username}` (CardTrader-style seller desk: avatar,
   country flag, item counts, that seller’s asks). Condition is colored
   (NM mint, SP gold, MP orange, Poor red). Card language is a circle flag,
   not `EN` text. Seller country flag sits left of the handle. Row click still
   adds the ask to the cart except the username, card link, and trash.
   After **List card**, Shop paints the POST body immediately; GET listings
   uses `cache: no-store` so a cached empty ask cannot hide the new row.
6. Same-name printings rail (`GET /api/marketplace-search-page?query="{name}"`,
   then keep rows whose `name` matches exactly — Full Arts included. Not the
   illustration version-set.)
7. Related cards (`RelatedCards.jsx`) is a separate priced tile rail: at most
   **12** leftovers from `cheapest_homepage_cache_blueprint` (not 8). Same-name
   printings stay on that rail above, not a second related row.

Click the scan to zoom (React lightbox). Do not navigate Home on art tap.
Mount `<dialog>` only while zoom is on; **never** set `display` on a closed
dialog.

Header does **not** pin Mega Evolution / Phantasmal Flames / Black Bolt. Top
bar: search, title-language flag (`pokoin.searchLanguage`, live — not visual
only), Home, Forum, Signal, Competitive, PKN
chip, profile/sign-in, cart. Sell stays off the global bar. Routes:
[CHROME.md](CHROME.md). Search submit is **Enter**; the pill magnifying glass opens the print-language filter.
On **phone** (`≤720px`) the icon row is a left side drawer. Layout notes:
[MOBILE.md](MOBILE.md).

Marketplace home (`/marketplace`) paints a 5-expansion promo carousel (Storm
Emeralda, Mega Evolution, Phantasmal Flames, Black Bolt, White Flare), rails,
and grid immediately. When that home payload lands, idle `warmupSearchBar()`
opens Meili suggest (and Pokemon token-predict warmup). Each slide is official-set copy plus a 3-card fan of **random chase leftover JPEGs** from that set that
overflows the banner. Homepage pan lock is `html:has(.page.home) { overflow-x: clip }` plus `.page.home { overflow: clip }` — not `html`/`body` globally, so artist album desks still scroll. The fan pool is the Pi `set:{slug}` rail (no PKN wait). Autoplay pauses on hover of the whole stage (so the
arrows stay clickable). Hovering a side fan card lifts the center
(`is-mid-away`); the center card itself does not. Set browse (`/marketplace/sets/:slug`) keeps skeletons until the full set
walk finishes (`expansionTilesReady`: `hasMore === false`), then paints
Number order (Official when we have a checklist). Search uses skeleton tiles
(it can still flash **Searching…** in the
result count). Set-desk walk: [Set desk first paint](#set-desk-first-paint).
Card pages seed from the tile you clicked. The landing page prefetches this
SPA and `/api/marketplace-home?v=rising-month` (Worker strips `?v=`).
`/marketplace/sets` is the era catalog (`set-logos.js`), not the home rails.

## Action map (every control)

| Surface | Control | What happens |
| --- | --- | --- |
| Top bar | Search | Autocomplete → card page; submit → `/marketplace/search`. Popup and search page split **Singles / Product / Users**. Rows match CardTrader **density** (set mark, thumb, bold `Name - number`, expansion `#n`) on the dark gold chrome. Spec: [CHROME.md](CHROME.md#header-search-cardtrader-style-rows). |
| Top bar | Logo | Marketplace home |
| Top bar | Home | Landing `/` |
| Top bar | Forum | `/forum` (GET `/api/forum`, 8s timeout) |
| Top bar | Signal | `/marketplace/signal` (catalog dump + home rails; honest empty 24h) |
| Top bar | Competitive | `/marketplace/competitive` (Oracle pictures, snapshot data) |
| Top bar | PKN chip | `/wallet` (MetaMask + PokoinPoS `26062026`) |
| Top bar | Profile icon | Signed in → `/profile`; unsigned → `/auth?from=` |
| Top bar | Cart | `/cart` (`localStorage pokoin.cartItems`) |
| Header | Set name | `/marketplace/sets/:slug` |
| Header | Artist | `/marketplace/{lang}/artists/{slug}` |
| Header | Watch | `localStorage pokoin.watchlistIds` + `POST /api/marketplace-watchlist` |
| Header | Share | iOS/Android: system share sheet. Desktop: copy URL + Copied |
| Art | Prev / next | Same-set sibling via expansion page; do not clear siblings on cardId change |
| Art | Scan click | Lightbox zoom |
| Art | Version select | Always in the art column between ‹ ›. Seeded with this printing. Options are **rarity** versions in this set. Singleton is a gold `<span>`, no chevron. |
| Art | Set shortcuts | Circular set symbols **under the scan**, including a singleton expansion (`GET /api/marketplace-version-set`). Current highlighted. Switching the rarity `<select>` reloads that CLIP group. **More versions...** under the circles → rarity lineup + artwork (gold halo). **More than five** expansions → link only |
| Center | Listing fields | Local form state only. Currency PKN / EUR / USD / DKK; EUR and USD convert at `1 PKN = 0.005 USDT` (`DKK` via 7.5 / EUR). POST is always `pricePkn`. |
| Center | Extra chips | Toggle 1st Ed. / Sealed / Graded / Shipping |
| Center | Sign in / List card | Sign in → `/auth`; signed-in List card POSTs with Firebase bearer |
| Best Deal | Language / condition | Always enabled (all langs / conditions). Filters Best Deal when listings exist; seeds List your card |
| Best Deal | Add to cart / Unavailable | Native listing → local cart then `/cart` |
| Best Deal | Silver CT / CM / VT | Unsigned → `/auth`. Signed-in unlock `POST /api/unlock-silver` (20 site PKN). Silver can paint from `localStorage pokoin.auth.session` (`auth-session.js`) before Firebase returns. Silver: **CT** leftover `cardtrader.com/en/cards/{ct_id}` via `window.open` noreferrer (Sanji `818358` → `409179`; no pokoin 302 in the tab). **CM** JSON URL then `window.open` noreferrer (Pokemon stored/product, else Singles `{name} {collector}` like VT `dawn 129`; OP `/en/OnePiece/Products/Search`; RB `/en/Riftbound/Products/Search`). Do not fetch cardmarket.com from Oracle/nezopt (Cloudflare 403). **VT** Vinted `search_text`: Pokemon `{name} {collector}` (`Gumshoos 184`; name-only → 500+) plus `catalog[]=4824` (Hobby e collezionismo). OP `One Piece Card Game {name} {number}`. RB `Riftbound TCG {name} {number}`. Skip English set names (Vinted AND + IT titles). All three pills `window.open(..., 'noopener,noreferrer')` so CT/CM/VT see a direct visit, not pokoin.com. Do not cloak as Google. Pills: CardTrader light blue, Cardmarket dark blue (`#1a4f9c`), Vinted dark green. |
| Shop | Sort / condition / language | Client filter of native listings; one header row |
| Shop | Listing row | Adds that offer to the local cart. Your own row is not a buy; it has trash to cancel that listing (`PATCH` `status=inactive`). Username opens `/marketplace/{lang}/users/{username}`. Condition uses CardTrader colors; language and seller-country are flags. |
| Desk | Related cards | At most **12** priced tiles (`RelatedCards.jsx`). Same-name printings stay on the rail above Shop. |
| Shop empty | No items found | List form above is the sell path; header heart is watchlist |

Do not send `listingId` in `marketplace-event`.

## Other SPA pages (user actions)

| Page | Actions |
| --- | --- |
| `/marketplace` | Promo slides, rails, grid, protection callout (“100% coverage on your assets”) → `/protection`, Sell callout → `/inventory` |
| `/marketplace/search` | Query, **Singles / Product / Users** tabs (`?tab=`), client Rarity / Set / Sort (`search-filters.js`). Artist desks keep the old Type dropdown. Load more, tile → card. Result count can show **Searching…**. |
| `/marketplace/explore` | Pokoin catalog in PKN, filters, page 48 |
| `/marketplace/portfolio` | Set bars, rails, search holdings, holding desk (PKN, `GET /api/marketplace-portfolio`, no CardTrader leftover art) |
| `/marketplace/sets` | Era chips + search, Watchtower / leftover wordmarks (`set-logos.js`). `fetchExpansions({ limit: 2000 })`. Not a flat 80-row dump. Gold era headings link to `/marketplace/eras/:id`. Set desk `/marketplace/sets/:slug` sorts **Official** when we have a checklist (`set-official-lists.js`: Celebrations, Lost Origin, Platinum Arceus), else Number. Letter-prefix secrets (AR/SH/TG) sort after n/m even on Number — do not interleave AR1 with 001/099. Skeletons until the full walk (`hasMore === false`), then `_homepage.webp` in **12-card** batches — [Set desk first paint](#set-desk-first-paint). The next 12 wait for a scroll; do not IntersectionObserver-cascade the whole set. |
| `/marketplace/eras` | TCG block names (`TCG_ERA_ORDER`). Gold links to each setlist. |
| `/marketplace/eras/:id` | Setlist for one TCG block. JP/EN/CN of that generation stay together (`tcgEra`). `/eras/ex` is 2003–2007 only — not substring `ex`. Japanese / Chinese ids stay nationality buckets. Wordmarks, not leftover scans. |
| `/marketplace/watchlist` | Hydrate ids, clear, tiles |
| `/product/:kind` | Seeded search (box/pack/graded/nft). Empty `query=` times out — do not. |
| `/marketplace/competitive…` | Static dump: tournaments, decks, lists, players, cards. Pictures from Oracle `/card-images/competitive/`. [COMPETITIVE.md](COMPETITIVE.md) |
| `/forum` | Categories, topics, create (bearer), replies, image upload after topic/post id |
| `/marketplace/signal` | Native PKN asking + home rail counts. No fake 24h. |
| `/wallet` | Connect MetaMask, send PKN, AMM quote/swap on `0x…2606`, WPKN quote + signed request |
| `/buy` | Stripe PKN packages (Starter/Collector/Validator). Return `?session_id=` confirms. |
| `/auth` | Email/password, Google, return `?from=` |
| `/profile` | Session, site PKN, Silver, sign out, admin link if role |
| `/cart` | Qty, remove, clear, Checkout |
| `/checkout` | Bearer `POST /api/marketplace-orders`. Physical: PKN escrow until the buyer confirms delivery. NFT-only: pay now. Tax 8%. Physical shipping 2000 PKN. |
| `/orders` | Buyer confirm / report; seller mark shipped. |
| `/protection` | Buyer protection: escrow, 7-day no-ship refund, dispute times. |
| `/orders` | Firestore `orders` for uid |
| `/nft` | Firestore `user_card_collections` (NFT rows) + shipping intent |
| `/inventory` | Seller listings for Firebase uid |
| `/scan` | Photo → leftover-JPEG identify (`pokemon_generic` / `one_piece_singles`). Live API default is TCGPlayer — the SPA must set `catalog`. Desk is `public_id`. [SCAN.md](SCAN.md). |
| `/extension/auth-bridge` | Chrome extension Cardmarket auth. Firebase ID token `postMessage` (`pokoin-auth-token`). No marketplace chrome. |
| `/espurr` `/sanitize` `/ocr` | Operator review boards (`TestDock`). Not public chrome. `/ocr` is one leftover per expansion; Qwen3-VL leftover print vs DB `nationality`, plus the PP-OCRv5 sample. |
| `/admin` | Firestore admin only. Expansion symbol editor at `/marketplace/admin/edit`. |
| `/docs` `/contact` `/privacy` `/earn` `/whitepaper` `/health` | Static desk + RPC probe on health |
| `/about` | Public story page (hero, how it works, surfaces). Not internals. |
| `/careers` | Public careers page (mission, principles, why join, open roles). Empty when no postings. |

Checkout pays site PKN through `/api/marketplace-orders`. Failed API calls stay
honest (no invented 24h or CT prices).

## Card URLs

Public id is `card_id` = leftover `ct_id` × 2. Never put `ct_id` in the
address bar. Never divide a public id. Milo scan `id` is that leftover
`ct_id`, not a TCGplayer product id. Storm Emeralda briefly used a
placeholder `999000000 + (ct_id × 2)` (Zinnia’s Trust UR `999806370`).
Catalog is leftover × 2 now (`806370`). SPA `realPublicCardId` and the
origin OG Worker subtract the 999 offset so old bookmarks still open.

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
`pokoin-cdn-card-images`. Do not put shortlinks on a third-party REST host. Do not point
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
the detail hero. Zoom softness is the 500px source, not the codec. Ingest
rounds only the cardboard crescents (3.175 mm circle); it must not punch the
printed TRAINER / nameplate. Map: [CARD_ART.md](CARD_ART.md) Type D.

Artist is React: `/marketplace/{lang}/artists/{slug}`. **More versions...** is
`{canonicalPath}/versions` in this SPA. That page has **Rarity Lineup**
(rarity pair in this set), then CLIP printings grouped by TCG era (Mega
Evolution → Original; Platinum and Call of Legends are their own blocks).
Same-era full-art is that era, not a reprint. JP/EN/CN of the same generation
stay together. Expansion lists and mapping caveats:
[TCG_ERAS.md](TCG_ERAS.md). Full rules:
[VERSIONS.md](VERSIONS.md).
Espurr was seeded from [test.pokoin.com/espurr](https://test.pokoin.com/espurr).
Every other name uses leftover **illustration-box** CLIP, then equalized
pixels when CLIP cannot split poses (Pikachu δ PCG-P 112 → Legend Maker
093/92, not Holon 079). Do not union leftover-catalog CLIP first — that
chained every Flareon / Pikachu δ. Searchbar `artcut/` crops stay for
suggest CSS only.

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

| Name | Formula | Where |
| --- | --- | --- |
| Public **card id** | leftover `ct_id` × 2 | paths, `cardId`, Flutter `card.id`, rewritten image URL prefix |
| Leftover **`ct_id` / Milo `id`** | CardTrader blueprint | R2 object prefix, scan `hit.id` / `hit.ct_id`, leftover JPEG `{ct_id}_*.jpg`, artists PK, CardTrader HTTP. Never in the address bar. |
| Artists **PK** | leftover `blueprint_id` (= `ct_id`) | `marketplace_blueprint_artists`. Generated `card_id` = leftover × 2. OCR/CLIP write here only. |
| Desk **artist** | `candidates.artist` by public `card_id` | card-page, search, home. Trigger 073 copies from artists. Do not leftover-join the hot path. Map: [ARTISTS.md](ARTISTS.md). |
| TCGplayer product id | CollectorVision Fast only | **Not** Pokoin Milo. Example: TCGPlayer `704765` is not desk `704765`; Pitch Black Mega Delphox is public `798708` (leftover `399354`). |

Gallery manifests (`cdn_milo_western`, `assets/milo_index/*/manifest.json`)
used `"identity": "ct_id"`. Live cardscan **2.1** (`cardscan.pokoin.com/health`)
indexes Pokoin catalogs as `"identity": "public_id"`. `POST /identify` **defaults
to `catalog=tcgplayer`** — `id` is a TCGPlayer product id (example: `632917`
is not a desk card). Pokemon/OP/RB catalogs return `id` = `public_id`, plus
`ct_id` and `pokoin_url`. SPA `identifyScan` sets leftover-JPEG catalogs by
default (`pokemon_generic` / `one_piece_singles`). Map: [SCAN.md](SCAN.md).
`publicIdFromScanHit` prefers `public_id` / `pokoin_url`, else leftover
`ct_id` × 2, and **does not** double a TCGPlayer `id`.

A **printing** (SKU in the TCGPlayer *sense*, not a TCGPlayer id) is:

1. Public **card id** (never divide; never put `ct_id` in the address bar).
2. **Set** + **collector number** + **rarity** + **artist**.
3. Listings under that printing: **condition + seller + PKN price**.

`includeSameAs` and `liveOffers` are **off** unless the client asks. `includeOffers`
defaults **off** too: the React card shell paints identity + hero first, then
`GET /api/marketplace-listings?cardId=&nativeOnly=1` fills the table. In-memory
`listings-cache.js` treats an empty `[]` as a hit — after **List card**, the
SPA invalidates that id and fetches `fresh` (`cache: no-store`) so a cached
empty ask cannot hide the new row. Do not await listings for LCP.

The page BFF still concatenates CardTrader `expansion_number` into `number`
(`Special Illustration Rare | 184/132`) and often puts product type `Card` in
`rarity`. `market/src/identity.js` splits that before render and before
`marketplace-event`. Do not show `Card` as a rarity. When the projection
fell back to leftover `ct_id` (Jungle Eevee `281978` → `140989`), drop it —
that is not a collector number. The canonical slug already omits it
(`card-eevee--pokemon-jungle`).

Images: `gridImageUrl` / `heroImageUrl` from the page BFF. Never `/previews/`
on the card desk. Header suggest thumbs may fall back to a CardTrader
`preview_` URL when no leftover JPEG exists — empty grey squares are worse.
If the leftover JPEG is missing (Pitch Black Mega Delphox `399354`), the desk
stays empty; do not hotlink CardTrader. Image keys are leftover `ct_id`
(`public / 2`). `leftoverKeyMatchesCard` / `pokoin-id-check` reject a public-id
prefix: leftover `ct_id` can equal another card’s public id (Net Ball `245292`
vs Cyndaquil leftover `245292`; Kirlia leftover `241930` vs Pikachu public
`241930`). The old `pokoin-id-check` counted `{card_id}_*` as the good prefix
and leftover as drift, so Net Ball `245292_net-ball` looked fine. Art map: [CARD_ART.md](CARD_ART.md).

Contract source: CardVault `api/_client_contract.js` version **`2026-09-05.6`**.
Live `GET https://api.pokoin.com/api/__contract` until Oracle restarts may
still show an older version.

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

Qwen (`qwen3.8:27b-128k` via llama.cpp on nezopt `:11436`, not Ollama `:11434`)
reviewed leftover image keys, Pi origin, last-day sold median, and Sets as
an era catalog on 7 Sep 2026. The OpenCode agent loop timed out stuffing
full markdown files into the 128k slot; a compact `think:false` pass was
used instead. Ignore any POST-for-page-BFFs or `ct*` cardId examples —
those contradict the live contract. Page BFFs are **GET**.

---

## APIs this SPA may call

| URL | When |
| --- | --- |
| `GET /api/marketplace-home` | Homepage **vector** from Pi `marketplace_rails`. Worker Cache API on **pokoin.com** (stable key, SWR). English titles. No recently seen. **Not** the Flutter hydrate on api.pokoin.com (~170 KB). |
| `GET /api/marketplace-card-tiles?ids=` | Public tile payloads for recents not in the vector. Pi API; Worker on pokoin.com proxies the same path. After first paint only. |
| `GET /api/marketplace-search-page?query=` | Search + load more. Card desk same-name rail uses quoted `"{name}"` then a strict name filter. Singles `productType=card` still uses Meili (same as typeahead), then keeps `product_type=card` rows. |
| `GET /api/marketplace-card-page?cardId=` | Detail shell. `includeOffers=0` by default. English `name` / `set` / `rarity`. CLIP key is `version` / `card.version`; `versionCount` is same-artwork `member_count`. `rarities` is same English name + expansion (UR / FA / SIR / Gold), not the CLIP cluster. Neighbor, rarity, and CLIP version rows stamp listed cheapest PKN from `cheapest_homepage_cache_blueprint` so Related cards are not fake Out of stock. The desk also overlays `marketplace-card-tiles` on that grid. |
| `GET /api/marketplace-listings?cardId=&nativeOnly=1` | Listings table after first paint. HTTP `cache: no-store`. In-memory `listings-cache.js` (empty `[]` is a hit — invalidate after POST). |
| `GET /api/searchbar-token-predict?warmup=1` | Pokemon idle warmup after home paint (`warmupSearchBar`). Errors swallowed. |
| `POST /api/marketplace-listings` | Create listing. Bearer Firebase ID token (identity only). Row insert is Postgres `marketplace_user_listings` on the **nezopt NVMe writer** (`MARKETPLACE_WRITER_DATABASE_URL` → `192.168.178.55:25432`), not Firebase and not the Pi replica. |
| `POST /api/marketplace-orders` | Paid checkout. Physical holds PKN (`paymentStatus: escrow`) until `confirm-delivery`. NFT-only credits now. |
| `POST /api/marketplace-orders?action=nft-shipping-request` | NFT shipping intent. Bearer |
| `POST /api/create-pkn-checkout-session` | Stripe PKN packages |
| `POST /api/unlock-silver` | 20 site PKN Silver |
| `GET /api/marketplace-expansion-page?slug=` | Set browse walk, 48-row pages, leftover `card_id` desc. SPA does not paint until the walk finishes. `expansion.nationality` drives the JP/CN title flag ([PRINT_FLAGS.md](PRINT_FLAGS.md)). English `expansion.name` for slugs, official lists, and the desk title. [Set desk first paint](#set-desk-first-paint). |
| `GET /api/marketplace-suggest?q=` | Header typeahead (grouped printings). Meili from 1 character in the background; popup from 3 compact characters, instant local rank + **cached printings** (not a 120ms blank dump, not `live:` name stubs). One Meili index, English-identity rows for every title language; after grouping the API stamps `localized_name` / `localized_set` / `localized_rarity` so the popup can show a CardTrader-style English title plus translation subtitle. SPA `suggest-rank.js` scores the compact English name against unique blueprint names (`marketplace_card_names`). Popularity is 2 log-capped points, never 428×; a perfect typed `gx`/`ex`/`v` match is 4. `oin` ranks Oinkologne; `pikahc gx` ranks Pikachu GX; `dawe` expands to Dawn; `miikyu ex` scores `Mimikyu ex`, not a peeled EX layer. `sylveon ex il` peels `il` as illustration/full-art and ranks SIR/FA printings first. `061 shieldon` peels the collector token and ranks Shieldon printings (061 first); Meili is not queried for every 061. `Sh1` is the SH1/SH10 collector prefix first, then real name-pool printings (Shinx, Shuppet) fill toward 20; the print-language chip keeps western rows in that 20. Set-code tokens: `hgss energy` peels HeartGold & SoulSilver and ranks elemental energies from that era; `palkai sl` peels Call of Legends (SL secrets) and ranks that set’s Palkia, not LV.X. Set-title phrases with a typo (`flareon call of legendsd`) peel to a name lookup on the search page, then filter printings by TCG era — expansion short codes stay off suggest `attributesToSearchOn`. A bare `expedition` browses Expedition Base Set and fills 20 singles; it is not Expedition Uniform from Chilling Reign. Jumbo / oversized leftovers are Product, not Singles. Not Flutter `marketplace-autocomplete` / token-predict. UI flattens groups into CardTrader-style rows. The “View all N results” number prefers the search-page payload’s `total` (same query object as its rows, same-WHERE window count), so `pikachu gx 30th` no longer reports the broad `pikachu` pool where that total exists; suggest `count` stays the baseline for universes without one. Popup cap 20 is the top real ranked matches; **western is a visual tie-break** on equal Meili points, not a `search_weight` change. After suggest, the SPA prefetches search-page so Enter is hot (`search-hot.js`). **2pikabench** (10 two-insert + keyboard typos, `seed=2`) recovered 10/10 on 2026-09-13: pool rank 2.7 ms avg, `fetchSuggestRanked` search **105 ms avg** (1053 ms / 10). Table: [CHROME.md](CHROME.md). |
| `GET /api/marketplace-card-sales?cardId=` | Desk header last-day PKN (`series.lastMedianPkn`) + daily median series. Tile/versions last-median uses this thin response (no `slices`). Desk graph uses `?slices=1` once per card: every `cardtrader_sold_daily` combination as camelCase `slices` (day, condition, language, reverse, firstEdition, graded, medianPkn, sampleCount, …). SPA filters locally and caches 15 days. `series.soldQty` is copies sold in the current slice (shown as **n units**); `series.sampleCount` is listing-disappearance events. Each `series.days[]` has `sampleCount` / `soldQty`. Optional `condition` / `language` (`cond` / `lang`), `reverse`, `firstEdition`, `graded` (`0`/`1`) still apply on the series path. `filters` lists keys that exist for the printing on that path. Default has no observation rows (`includeRows=1` for a capped sample). |
| `GET /api/marketplace-version-set?cardId=` | CLIP group for `/versions` era grids. Same English name + same illustration key. SPA splits those rows by TCG era (`tcgEra`). Rarity versions are SPA-side. [VERSIONS.md](VERSIONS.md). |
| `GET /api/marketplace-expansion-page?limit=` | Sets index (SPA asks 2000). `?slug=` is one set desk. |
| `POST /api/marketplace-event` | Actions above |

Same-origin `https://pokoin.com/api/marketplace-suggest` rewrites to
`https://api.pokoin.com/api/marketplace-suggest`. Omitting `/api` 404s. Do not
GET autocomplete (405). Ranking map is documented with the search service in
the app repo; the web only calls `marketplace-suggest`. See [APP.md](APP.md).

---

## Speed (card page must be fast)

Do **not** wait for listings, sameAs, or live CardTrader before painting the
printing. Shopify-style: await identity + hero, stream offers after. The desk
gold graph is daily median PKN from CardTrader inferred sold comps
(`GET /api/marketplace-card-sales` → `series.days`, drawn by
`market/src/sold-graph.js`). Not Collectr ungraded/graded
SVG, not a settled Pokoin sale. Header PKN is `series.lastMedianPkn` (last
day with a median), not a floor. 24h is `series.change24hPct` × 100, or
honest `24h —` when that field is empty.

Cold `/marketplace/{lang}/cards/{id}/{slug}` has no tile `state`. Paint the
desk from the URL (`card-stub.js` leftover JPEG + name) and start
`marketplace-listings` immediately. Promo slugs keep the Pokémon name in
`h1`; a year-version tail (`illustration-contest-2024`) stays on the gold
collector badge as `Illustration Contest 2024 | SVP 214`, same shape as
`marketplace-card-page`. Hydrate emoji / artist / versions from that **same**
card-page query (no tiles overlay). Artist is denormalized on
`marketplace_search_candidates` by public `card_id` (OCR/CLIP still write
`marketplace_blueprint_artists`). Search identity hydrate and set tiles carry
it so in-app navigation first-paints the subtitle. The payload is stored by public card id
(`pokoin.cardPage.v1.`) so a reload paints them before the hop. That BFF is
often ~3s on the Frankfurt micro and can stall like expansion-page; a hang
must **not** become “Card market not found.” Only a real 404 clears the stub.
Suggest passes `state: { card }` so typeahead already has art.

Live marketplace API/CDN is the **Raspberry Pi**
([GAMES.md](GAMES.md)). Frankfurt `pokoin-marketplace` is the **CardTrader
dump / Postgres write primary**, not the SPA first hop and not a streaming
backup of the Pi. Madrid Ampere is the target if the Pi origin is abandoned.

The API box `pokoin-marketplace` is an Always Free **E2.1.Micro (1 GB)**. You
cannot merge the two AMD micros into one bigger AMD VM — that quota is two
fixed 1 GB shapes. Oracle halved Always Free Ampere in 2026: the unpaid “big
VM” is **Ampere A1 Flex 2 OCPU / 12 GB**, not 4/24 (4/24 is paid). **If the
Pi is abandoned**, move Postgres + `pokoin-oracle-api` + Meili + Caddy to
**Madrid 3** `pokoin-madrid-api`. Seed stays on Frankfurt `pokoin-peer1`.
`pokoinpos-peer2` on the marketplace micro stays stopped. Do not delete boot
volumes. Do **not** run `scripts/oci-a1-2x12-hunt.sh` (Frankfurt A1 + auto
DNS cutover). Marketplace move: [MADRID_MARKETPLACE.md](MADRID_MARKETPLACE.md).

Set browse uses indexed `marketplace_search_candidates` (`readCardsForSet`),
not `snapshotForExpansion` (distinct-on `marketplace_card_versions`, ~6s).
Hypemeter / `news.pokoin.com` stays on Vercel Hobby until the Oracle A1
tunnel cutover ([NEWS.md](NEWS.md)). Do not put it on Madrid marketplace RAM.
News hunt `scripts/oci-a1-2x12-hunt-news.sh` is Frankfurt-only and is
stopped.

---

## Pipeline (edit → live)

This repo is the public web. Do not ship the marketplace through
`cardvault/.../build/web`. App host: [APP.md](APP.md).

Empty **Recently seen** skeletons used to wait on `GET /api/marketplace-home-page`.
Browse rails now read **Pi Postgres replica** (`marketplace_rails` /
`marketplace_card_tiles`). CardTrader dumps and schema writes land on Oracle
`pokoin-marketplace` (primary) and stream to the Pi. The replica stores seller
listings, CardTrader snapshots, and sold/removed history for the API. A 15-minute job rolls those into card weights; rails sync publishes
the ranked lists **with PKN prices**. Snapshots stay in Postgres. Do not seq-scan
`cardtrader_market_listing_snapshots` (the usable index is
`COALESCE(blueprint_id, cardtrader_blueprint_id)`). There is **no Supabase**
on marketplace browse.

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
Set grids (`Expansion.jsx`) use the same waterfall: Pi `set:{slug}` rail
(hub cache / sold median PKN), then tile JSON, then last-day sold median.
`Load more` must keep slicing that rail (first 120) instead of jumping to
unpriced `marketplace-expansion-page` rows.
5. Else **Out of stock**. Shop / Add to cart stay
   **native listings only**. Homepage PKN is a market reference, not a
   buyable native ask.

### Homepage rails

The SPA (`Home.jsx`) reads one **vector** assembled from Pi
`marketplace_rails` (new / featured / best / spotlight / popular). Full
first-paint notes, measured sizes, and industry map:
[HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md).

The Worker caches that JSON at a **stable** Cache API key (no extra
`updated_at` round-trip on the user path) and revalidates in `waitUntil`
when rails change ([RFC 5861](https://datatracker.ietf.org/doc/html/rfc5861)).
Browsers may keep the JSON 120s fresh and a day stale. The SPA also keeps the
last public vector in `sessionStorage pokoin.homeVector.{game}.rising` (10 min) so a
return visit paints rails before the network.

Recently seen is **not** in that cache. Recents are 24 public ids **per
game**: guest `localStorage pokoin.recentCardIds.{game}` for the list,
signed-in `GET/PUT/POST /api/marketplace-recents?game=` on the shared Pi
API (`marketplace_user_recents` PK `(user_uid, game)` on the **nezopt
writer**). Handler source: `server/pokoin-api/marketplace-recents.js`
(deploy `scripts/deploy-recents-api.sh`). A Riftbound GET never loads
Pokémon rows. Unscoped legacy localStorage / Firestore lists are **not**
reseeding. Migration `090` deletes ambiguous unscoped SQL rows (does not
label them pokemon). Compact tiles:
`localStorage pokoin.recentCardTiles.{game}`.
`GET /api/marketplace-card-tiles` fills ids that are not already cached,
after New cards already painted. Nameless stubs are treated as missing:
do not paint the coin placeholder, and `fetchCard` after tiles miss.

Tiles show `formatPkn` (2642 PKN, no thousands comma) plus `printingIdentity().tileLine`. Grid art is the
240px `_homepage.webp` sibling (catalog JPEG stays on the card desk and the
home promo fan). First eight visible tiles are `loading=eager`; the first
four use `fetchPriority=high`. `CardTile` is always a **full 63:88 scan**.
Search suggest (desktop and phone) can show a CSS-cropped illustration
rectangle on the **right** of each row — same file, not a second download.
Every surface: [CARD_ART.md](CARD_ART.md). Suggest row:
[CHROME.md](CHROME.md#header-search-cardtrader-style-rows).

### Homepage first paint (do not regress)

Checklist only — rationale and file map are in
[HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md).

1. Promo carousel (local).
2. `sessionStorage` public vector if present → paint New / Best / Featured /
   grid immediately.
3. Rails vector with **no** auth wait. Attach recents **synchronously**.
4. Grid images: `/card-images/{leftover-key}_homepage.webp`, then JPEG.

Deferred (skeletons only on Recently seen if local ids are not in the vector):

5. Tile JSON for leftover recents.
6. Missing rail PKN from last-day sold median (do not block New cards paint).
7. After Firebase `ready`, `syncRemoteRecentCardIds()`.

Do **not** gate `fetchHome` on `useAuth().ready`. Do **not** `await`
`getDoc(user_card_recent_views)` before the public vector. Do **not** put
`fetchCardTiles` inside `Promise.all` with the rails. Worker cache lookup
must not call a remote `updated_at` before `caches.default.match`. Do **not**
treat Flutter `api.pokoin.com/api/marketplace-home` as the SPA vector.

| Rail | What it is | Rank | Price on the tile |
| --- | --- | --- | --- |
| Promo | Five current sets (Storm Emeralda first) | local `PromoCarousel` | set page, not this row |
| Recently seen | Last 24 card ids **per game** | `marketplace_user_recents` `(user_uid, game)` when signed in; guest ids in `pokoin.recentCardIds.{game}` | not in the 1-day vector |
| New cards | **Curated Storm Emeralda** chase printings (Japanese M6 / English Delta Reign source). Matched by set + collector number + name; same Pokémon names stay separate variants. Not `imported_at`, not unique-name shop mix. Missing specs are logged, never filled with another printing. | publisher `NEW_CARDS_CURATED` array order | waterfall above; last-day sold fills hub misses |
| Best sellers | Cheap movers that still have copies: `best_seller_score`, `sold_qty_7d ≥ 3`, `listed_qty_now > 0`, median sold **≤ €15**, skip Energy. 12 tiles. UI title **Best sellers** (`bestSellerIds`). `psql_price_gainers()` (30d % up) exists in the publisher and is **not called**. | `best_seller_score DESC` | hub cache or median PKN |
| Featured | **30 random 30th Anniversary singles** (EN `30th Celebration`, JP `30th Celebration JP`, First Partner Illustration Collection, CN when present). Daily UTC shuffle. Skip Energy, boxes, frames, markers. Same Pokémon names stay separate printings. Empty pool falls back to sell-through. 30 tiles. UI title **Spotlight** (`featuredIds`). | publisher `pick_featured_cards` daily seed | same |
| Marketplace grid | Pokemon **for now**: shuffled **western (English)** printings, **14** tiles per block, **Show more** loads the next 14 from the same shuffled set walk. Not the New-cards shop mix. OP/RB still use the spotlight rail. `isSetDeskCard`: no merch backpacks without an `n/m` collector number (IC bags). Nemona's Backpack stays. Ingest kind is CardTrader `category_id` (memorabilia/box/storage → `item_kind=product`); Qwen-VL leftovers fill unknown categories (`scripts/qwen-leftover-kind.py`). SPA name regex is a safety net only. Energy stays. Secret Box with an `n/m` stays. | shuffled western set index, then expansion pages | same |

High PKN on a gold or SR is the rate, not a conversion bug: €1 = 200 PKN
(`EUR / 0.005`). Mega Lucario ex gold ~€150 → ~30,128 PKN. Two tiles named
Victini were two printings (Black Bolt 171/086 vs White Flare 172/086); the
mix now keeps one name. Levincia gold 244/182 is a stadium — Iono is in
the art, the catalog name is Levincia.

### Set desk first paint

`/marketplace/sets/:slug` does **not** paint the first 48 leftover-id rows
and then append the rest. That page size (`EXPANSION_PAGE` = 48 in
`market/src/api.js`) is only the walk chunk. SQL `readCardsForSet` is still
`order by card_id desc`; the SPA hides it.

Default:

1. Show skeletons (title / flag may land from expansion metadata). Count
   follows `expansion.cardCount` when the metadata hop has it.
2. `fetchExpansionCards` walks offset 0, 48, 96, … until a short page.
3. Paint order once `hasMore === false` (`expansionTilesReady`), sorted
   **Number** (or **Official** when `set-official-lists.js` has a checklist:
   Celebrations, Lost Origin, Platinum Arceus). Letter-prefix secrets sort
   after printed n/m. Official English PDFs on assets.pokemon.com can feed
   the same `assignOfficialIndexes` matcher for other major EN sets; reverse
   holos are not extra slots. Japanese/CN checklists are a separate list.
4. `_homepage.webp` mounts **12 tiles at a time** from that order. The rest
   stay skeletons until the user scrolls (the sentinel after the current
   batch sits in the first rows, so a fat `rootMargin` would mount the whole
   set in one frame). Do not fire every set preview at once.
5. `.result-count` is the full desk total, not `48`.

Load more stays only if the walk hit the 40-page cap. Do not treat a 48-row
SQL page as the checklist. Tiles stay full leftover 63:88 (`CardTile`).
Title flag (`nationality`) can land with the metadata hop —
[PRINT_FLAGS.md](PRINT_FLAGS.md).

### Remove from catalogue (CT gone)

When CardTrader deletes a blueprint and the desk is a dead preview (no
leftover JPEG), remove it with `scripts/remove-catalogue-card.py`. Public
id is still `ct_id × 2`.

```bash
# Dry-run (default): CT probes + writer inventory + would-delete list
python3 scripts/remove-catalogue-card.py 794206
python3 scripts/remove-catalogue-card.py --ct-id 397103

# Apply on nezopt 15T writer + Meili on the Pi
python3 scripts/remove-catalogue-card.py 794206 --apply
```

**Would-remove checks (refuse `--apply` unless overridden):**

| Check | Why |
| --- | --- |
| CardTrader page or preview is HTTP 404 | Do not delete a live CT product (`--allow-live-ct` to override) |
| No active `marketplace_user_listings` | Native sellers keep the desk (`--force-listings` to override) |
| No `marketplace_cm_scrape_observations` with this blueprint | FK is NO ACTION — null/delete first |

**Apply order (writer only — Pi replica streams):**

1. `marketplace_search_candidates` (cascades `marketplace_card_urls`,
   `marketplace_card_url_hash4`, variations, nickname hits)
2. `marketplace_card_versions`
3. `pokoin_version_sets` (candidates → version FK is NO ACTION)
4. `pokoin_pokemon_blueprints` (cascades `marketplace_cards`, artists,
   hot/watch/cart analytics, …). View `cardtrader_pokemon_blueprints` follows.
5. Meili `DELETE …/documents/en_{card_id}` via Pi `pokoin-meili` master key
6. Wait replica candidates = 0; `GET /api/marketplace-card-page?cardId=` → 404

Do **not** delete `cardtrader_sold_daily` or listing snapshots (history).
Do **not** write the Pi replica. Next CT dump will not resurrect a 404
blueprint; if a stale dump row reappears, run the script again after
confirming CT is still gone.

Fixture from this pipeline: Theme Deck & Blisters Exclusives Gengar
`794206` / CT `397103` (Night Stiker Theme Deck) — CT page + image 404,
CDN leftover absent, removed 2026-09-14.

### Listing pipeline (Oracle GET → nezopt NVMe ingest → Pi replica)

```
CardTrader daily (Oracle GET, nezopt NVMe persist, flock)
  GET /marketplace/products?expansion_id=  → one call per set (~834 expansions),
    4 fetches in flight on Oracle `pokoin-marketplace` (1 GB micro, host-network
    Docker). Persist/SQL is nezopt NVMe Postgres (`pokoin-marketplace-postgres-15t`,
    `:25432`) through reverse tunnel Oracle `127.0.0.1:15543`.
    `archiveMissing` is real because the writer DB was cloned from the Pi replica
    (~2.1M snapshot rows), not an empty table.
    **Expansion dumps must not `archiveMissing` as sold.** CardTrader
    `GET /marketplace/products?expansion_id=` is cheapest-25 per
    blueprint and still incomplete vs `?blueprint_id=` (Glalie leftover
    **287734**: 170 snapshot rows vs 342 live; Wonderwallshop even rank 6
    in cheapest-25 was archived). Worker expansion persist: `archiveMissing:
    false`, `completeBook: true` (keep whatever CT returned; do not 25-trim
    ourselves). Only **by-blueprint** fetches may archive vanished stacks.
    There is no complete-book dump API.
    Do not move the Node dump onto nezopt. Do not add a second writer on
    `pokoin-peer1`. Dual-peer + `pg_advisory_lock` was slower than one persist
    path.     Oracle Docker Postgres is no longer the ingest target.
  Blueprint kind: `pokoin_pokemon_blueprints.category_id` is already on
    persist. `refresh_marketplace_cards_from_blueprints` sets `item_kind`
    from `resolved_marketplace_product_type`: Qwen leftover override
    (`marketplace_visual_kind`), then CardTrader category (73/78 singles,
    61 memorabilia, 60 box set, 118 empty storage, …), then the name
    classifier for Singles only. Fresh 30th frames/boxes/markers were
    category 61/60/118 with empty `category_name` and used to project as
    cards. Schema `060_cardtrader_category_kind.sql`. Visual fallback on
    nezopt leftovers: `scripts/qwen-leftover-kind.py` via llama.cpp `:11436`
    (`qwen3-vl:32b-instruct`, not Ollama).
    Do not crop those JPEGs on the Pi.
    Title-language display names are tall tables `card_name_languages`,
    `rarity_languages`, `expansion_languages` (`062_catalog_languages.sql`).
    English blueprint / set / printed-rarity strings stay the identity.
    Fills match TCGDex language dumps (and pokemontcg `foreignNames` when
    present) on English name / official set id. Print language
    (`nationality`) is a separate axis. Search lexicons
    `marketplace_card_names_*` are not these tables. Importer:
    `scripts/import-catalog-languages.js`.
  qty-down / vanished listing → sold copies, keyed by language × condition ×
    reverse × 1st edition × graded (`cardtrader_sold_daily`)
  per blueprint: listing_count, listed_quantity (copies), seller_count,
    new insertions (first_seen today), capped (false on the full-book path)
    → cardtrader_blueprint_population_daily
    (skip refresh if ≥10k rows in last 6 hours; statement_timeout 120s;
     lock_timeout 4s; GROUP BY coalesce(blueprint_id, cardtrader_blueprint_id);
     writer is nezopt 15T — batch the GROUP BY; never run it as a write on
     the Pi replica). Oracle’s 1 GB Docker Postgres is not this ingest target.
  ### Sold comps (stack identity — not CardTrader product id)

  Pokoin never sees CardTrader receipts. Sold graphs are **snapshot diffs**
  of the public listing book. Persist lives in the **cardvault** repo,
  `pokemon_card_vault/oracle-postgres/schema/086_disappearance_inferred_sales.sql`
  (continuity reconciliation in `088_seller_stack_continuity.sql`). The copy at
  `scripts/sql/cardtrader-listing-qty-diff.sql` in this repo is a superseded
  snapshot and must never be applied.

  **Stack key (the listing identity for “sold?”):**

  | Field | Role |
  | --- | --- |
  | seller (`seller_account_id`, else lowercased `seller_account_name`) | who |
  | blueprint / printing | which card |
  | condition | NM / LP / … |
  | language | EN / JP / … |
  | reverse / 1st edition / graded | foil facets |

  CardTrader `marketplace/products` **product id is not the stack.** It is
  only the snapshot row key. Price edits mint a new id while the same seller
  still lists the same NM EN stack — that is **not** a sale.

  **Archive reasons** (`cardtrader_market_listing_removed_history`):

  | Reason | Meaning | Sold graph? |
  | --- | --- | --- |
  | `quantity_decreased` | Same product id still in the book; qty went down. Stack drip. | **Yes** |
  | `listing_id_rotated` | Old product id gone, but the **same seller stack** is still listed (any sibling id, **any qty**). Insertion-id / split-stack churn, not a sale. | **No** |
  | `inferred_sale` | That **seller stack** is gone from the complete book (seller + language + condition + reverse/1st/graded). Not “product id missing.” Still not a receipt — dump miss and delist look the same. | **Yes** |
  | `seller_on_vacation` | Seller hid the shop (`on_vacation`) or the whole snapshot book vanished in one day. Not sold. Snapshots stay frozen. | **No** |
  | `dump_miss` | Listing id still on CardTrader `GET ?blueprint_id=`. Expansion dump / 25-wide window omitted it. | **No** |
  | `dropped_from_cheapest_25` | Left our old 25-wide window. **Wrong as a sale.** Unused on the complete-book path. | **No** |
  | `complete_book_cutover` | Sanitized cutover lump (11–12 Sep), not that day's market. | **No** |

  **Vanish is not one thing.** Persist must pick a reason; these are the
  live edge cases:

  | What we saw | What it actually is | Pipeline |
  | --- | --- | --- |
  | Same seller, same facets, new product id | CardTrader id reroll / split stack | `listing_id_rotated` (`070`/`071`) |
  | Same seller, **different** reverse / lang / condition still listed | Parallel stack (Final deck NM IT non-foil vs reverse) | `inferred_sale` of the missing facet only |
  | Listing id gone, blueprint GET still returns that id | Expansion dump miss (Glalie TWM 052/167). CT `expansion_id` ≠ complete book | **No** — `dump_miss` (`076`). Expansion persist `archiveMissing: false` |
  | Seller’s **entire** book gone in one day, or `on_vacation` on the product | Vacation / shop pause | `seller_on_vacation` (`075`). Table `cardtrader_seller_vacation`. Freeze snapshots |
  | Seller still has thousands of other listings, this stack gone | Delist or sold-out of that stack | `inferred_sale` — we cannot tell which |
  | Same id, qty 10 → 9 | Stack drip | `quantity_decreased` |
  | Left cheapest-25 window | Still listed further down | `dropped_from_cheapest_25` (historical; complete-book path unused) |
  | 11–12 Sep (and the 13 Sep remainder lump) | Cutover vs a stale / partial dump | `complete_book_cutover`; graphs ignore inferred_sale before 13 Sep |

  `cardtrader_seller_vacation` is upserted from incoming `on_vacation`.
  CardTrader often **omits** the shop instead of returning the flag, so
  finalize also marks a seller with **≥5 inferred rows / ≥3 printings**
  and **zero** remaining snapshots that day as vacation, restores those
  snapshot rows, and drops the sold observations. Tiny one-card sell-outs
  stay `inferred_sale`.

  Live persist decides with `cardtrader_same_seller_listing_stack`
  (cardvault `oracle-postgres/schema/086_disappearance_inferred_sales.sql`).
  Product id is only the snapshot row key. If the id vanished but the seller still lists
  that stack — including **sibling product ids already in the book** and
  **different quantities** — → `listing_id_rotated`. Do not require the
  successor id to be new, and do not require live qty = vanished qty.

  **Quantity-aware continuity.** A disappearance is reconciled against the
  successor stack by quantity, not by mere existence
  (cardvault `088_seller_stack_continuity.sql`). For predecessor `P` and
  available successor units `S`: `continuity = least(P, S)` and
  `residual = P - continuity`. `S >= P` retracts the episode outright
  (`listing_id_rotated`); `0 < S < P` keeps the residual as a **provisional**
  disappearance that still has to clear the normal confirmation rules, so a
  genuine partial sale is never erased; `S = 0` leaves the episode alone.
  Successor units are allocated once per stack (largest predecessor first), and
  credited continuity permanently consumes that capacity, which makes repeated
  reconciliation a no-op. `quantity_decreased` episodes are never touched.
  If the seller no longer lists that stack at all → `inferred_sale` (full
  remaining qty) **unless** that seller is on vacation or their whole shop
  vanished the same day (`seller_on_vacation`, schema `075_…`). Dump miss
  (listing still on CardTrader via `blueprint_id` GET) is also not a sale. A parallel listing already in the book is **not** a successor for
  a **different** stack of the same seller/card (real dual listings exist:
  NM vs LP, EN vs IT). Combined qty drops on a still-listed stack stay
  `quantity_decreased`.

  **15T had the wrong persist until 14 Sep 2026.** Docker
  `pokoin-marketplace-postgres-15t` still ran schema `026`: a vanished id
  became `listing_id_rotated` only when an incoming same-stack row’s product
  id was **not already** in `cardtrader_market_listing_snapshots`. Sellers
  split one stack across many CardTrader ids (price edits, qty splits).
  When one of those ids disappeared, the siblings were already snapshotted,
  so persist wrote `inferred_sale`. Coalossal Ascended Heroes 120/217
  leftover **370758** (public **741516**): Pippo100 vanished ids `422985453`
  (qty 1) and `424202669` (qty 2) on 13 Sep while six NM IT rows (14 copies)
  stayed listed from 1 Sep / 12 Sep. Graph showed **39 units / 26 PKN**
  (All languages Near Mint) because 057’s sold-daily exclusion also required
  `live.quantity = history.quantity` — qty 1 dropped, qty 2 did not.
  Sanitizer `scripts/sql/sanitize-same-stack-still-listed-inferred-sales.sql`
  (schema `071_…`) reclassified history to `listing_id_rotated` when a live
  sibling stack existed with `first_seen_at::date <= removed_day` (restock
  after a real sold-out stays `inferred_sale`). 14 Sep pass: **6529** events,
  **13506** copies, **1353** blueprints; **819** graph observations deleted
  (`quantity_decreased` kept; 11–12 Sep cutover inferred stays off the
  graph). `refresh_cardtrader_sold_daily` still ignores `inferred_sale`
  before **13 Sep** and drops a vanished id that is somehow still in
  snapshots; it does **not** seq-scan the 4.5 GB listing book for live
  stacks (jsonb TOAST on 15T HDD). Stack identity is persist `070` plus this
  sanitizer.

  **Cheap-25 is gone and was wrong.** CardTrader’s expansion GET is cheapest
  ~25 per blueprint; our old trim treated “left the 25” as sold (Theme Deck
  Marnie still live at 1,211 copies; Psyduck Ascended Heroes 741354 plotted
  121 from one row). Live dumps use `--complete-book` /
  `app.cardtrader_complete_book=1` so we do **not** emit
  `dropped_from_cheapest_25`. Historical cheap-25 `inferred_sale` through
  **10 Sep** was deleted; keep `quantity_decreased`
  (`scripts/sql/sanitize-cheap25-inferred-sales.sql`, schema `061_…`).
  `refresh_cardtrader_sold_daily` ignores `inferred_sale` before **13 Sep**.

  **What becomes a sold-graph point** (`cardtrader_sold_daily` ←
  `marketplace_price_observations`):

  - Source ids only: `cardtrader:{listing}:{day}:{inferred_sale|quantity_decreased}`.
  - Same listing_id on many days is snapshot flicker — keep `inferred_sale`
    only when that listing appears on a single day (`047_…`).
  - `inferred_sale` while that listing_id is still in
    `cardtrader_market_listing_snapshots` is **not** a sale (`052_…`,
    `sanitize-still-listed-inferred-sales.sql`).
  - Same seller stack under a new **or already-listed** product id is **not**
    a sale, **any quantity** (`070`/`071`,
    `sanitize-same-stack-still-listed-inferred-sales.sql`). Older `057`/`058`
    (`sanitize-listing-id-rotated-sales.sql`,
    `sanitize-listing-id-churn-full-pass.sql`) required `live.quantity =
    history.quantity` and a *new* successor id — that missed split stacks
    (Coalossal 370758 Pippo100 qty 2; Mewtwo Reverse Holo Promo 413168:
    Meta TCG qty 28 NM EN, nine ids, still listed 28).
  - **Never** ingest `listed-median-day:*` / `listed_median_from_snapshot`
    (asks, not sales; 6 Sep 60k EN fake day — `050_…`,
    `sanitize-listed-median-sales.sql`).
  - Empty CardTrader `pokemon_language` is the expansion print language, not
    EN (`051_…`). Explicit `en` on JP/CN stays.
  - **11 Sep** and **12 Sep** `inferred_sale` lumps are complete-book cutover
    vs the Pi clone / leftover cheap-25 ids, not those days’ markets. Dropped;
    keep `quantity_decreased` (`051_…`, `059_…`
    `sanitize-sep12-complete-book-cutover.sql`).
  - SPA desk cache key: `pokoin.cardSales.v11.` (15 days). First paint can
    use the cache; the desk still refetches slices on each visit so a new
    persist day (13 Sep …) is not stuck behind the TTL.

Native POST /api/marketplace-listings
  appear / qty-down / sold_out → marketplace_user_listing_events

every 15 min  refresh-listing-weights.py
  population (skip if fresh) → stats_daily → marketplace_card_weights
  best_seller = sold_qty_7d × ln(1+copies); popular = copies first seen in last 30d

every 5 min  sync-marketplace-rails.py
  SQL tiles + PKN + live CT overlay for new sets
  Valkey `pkn:ct:{blueprint}` TTL 6h (misses 5 min)
  → marketplace_rails / marketplace_card_tiles on nezopt 15T (Pi replica streams)

Worker GET /api/marketplace-home  (pokoin-origin)
  stable Cache API key, SWR revalidate via waitUntil
  recently seen stays local / Firebase (after paint)

SPA Home.jsx
  sessionStorage vector → fetchHome (no auth wait)
  attachRecentsToHome sync → tiles fetch for missing ids only
  CardTile: _homepage.webp then JPEG; formatPkn(price) or Out of stock
```

On **pokoin.com**, `GET /api/marketplace-home` is the Worker vector (1 day).
The Flutter app still calls **api.pokoin.com** `GET /api/marketplace-home`
(Valkey 30s, ~170 KB). The SPA must not use that payload. First paint:
[HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md).
Pi `GET /api/marketplace-home-page` remains the fallback if the Worker is
skipped; that handler prefers `marketplace_rails` then newest/hot SQL.

**Valkey, not Redis.** Honcho on nezopt and Nextcloud’s cache image are
`valkey/valkey`. Marketplace Valkey runs on the **Pi** with Meili and the API.
Do **not** put Valkey or Redis on `pokoin-peer1`. Pi `marketplace_rails` is
the SPA source of truth.

**Card images:** public URLs stay `https://cdn.pokoin.com/…` (set by
`POKOIN_CARD_CDN_BASE_URL` at import). Catalog leftover JPEGs live on the
Raspberry Pi (`/srv/pokoin/card-images/objects`). Worker `pokoin-cdn-card-images`
reads Pi first, R2 only as backup. `api2.pokoin.com` is the same Pi origin as
`api.pokoin.com`. Do not rewrite DB URLs. See [GAMES.md](GAMES.md).
Home/search tiles use `_homepage.webp` (240px, q82); desk and promo fan use
leftover JPEG (`CardArt full`). Grid 404 falls back to JPEG. Search suggest
may CSS-crop that same webp into the illustration rectangle on the right of
the popup (`art-cut.js`); no second download.

**Image jobs on nezopt, not the Pi.** The 15T mybook replica is local:
`/home/nez/mnt/mybook/pokoin-pi-card-images/`. Seed it with filesystem rsync
from leftover trees already on nezopt (`scripts/sync-pi-card-images-replica.sh`).
Pi delta uses LAN `rsync://192.168.178.46/card-images/` — not SSH. Crop with
`scripts/export-leftover-artcut.py`. Version CLIP runs on the RX 7900 XTX.

Install: `scripts/install-marketplace-valkey.sh` then
`scripts/install-listing-pipeline.sh`.

```
PKN            = EUR / 0.005
best_seller    = sold_qty_7d × ln(1 + listed_qty_now)   (homepage Best sellers; median ≤€15, qty≥3, listed>0)
popular        = copies first seen in last 30d, cap 25/listing (skip census dump day; skip Energy)
demand         = ln(1 + 80 × ((qty/7)/listed)) if qty≥3 and listed>0
featured       = 30 random 30th Anniversary singles (daily UTC shuffle; Energy/merch skipped)
combined       = best_seller + 10×demand + native
```

`psql_price_gainers` (30d median % up) is leftover SQL in the publisher. Do
**not** wire it to a homepage rail.

**Why the old rows looked the same.** Featured still used raw `hot_score_24h` (values ~400–1000), so Supreme Victors FB promos with tiny listed counts beat Fezandipiti/Galvantula. Best sellers included vintage cards with **zero** hub listings (Magneton 227 units, listed=0). The fix is simpler sorts on real columns, not nationality filters.

Publisher: `scripts/sync-marketplace-rails.py` on the Pi
(`marketplace-rails-sync.timer`). Weights: `scripts/refresh-listing-weights.py`
(`listing-weights.timer`). Formula SQL:
`scripts/sql/listing-weight-formulas.sql`. Install:
`scripts/install-marketplace-rails-sync.sh` then
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

**Live API/CDN origin is the Raspberry Pi** (`api.pokoin.com` /
`cdn.pokoin.com`). Oracle Docker **`cardtrader-oracle-api`** is the CardTrader
GET host (full `oracle-api-server` on `:18080`, persist to nezopt 15T). It is
not the SPA first hop. Do not use `deploy-oracle-api-peer3.sh`. Map:
[CARDTRADER_ORACLE_API.md](CARDTRADER_ORACLE_API.md). Hosting target if the Pi
origin is abandoned: [MADRID_MARKETPLACE.md](MADRID_MARKETPLACE.md).

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
