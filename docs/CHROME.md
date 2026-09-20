# Chrome icons → React (`pokoin.com`)

Public chrome is this SPA. Android/iOS CardVault is a separate app on
`app.pokoin.com`. App-only history and Flutter-web leftovers:
[APP.md](APP.md). Do not alias that host onto Vercel project `web`.

| Host | Vercel project | What |
| --- | --- | --- |
| `https://pokoin.com` | `web` (`prj_1x0bUwaSZPeMRU90jQL5Ak8WWnPX`) | Landing + React market (Pokemon) |
| `https://onepiece.pokoin.com` | same `web` | Same SPA; hostname → One Piece (`?game=one_piece`) |
| `https://riftbound.pokoin.com` | same `web` | Same SPA; hostname → Riftbound (`?game=riftbound`) |
| `https://app.pokoin.com` | `pokoin-flutter` (`prj_nrmYJjDGMPh4fZVO7dexZ77BTPls`) | Flutter CardVault |

`explorer.pokoin.com` is served by the same `web` project via host-based
rewrites to `/explorer/*` (PokoinPoS explorer UI, `explorer/README.md`) —
never aliased to `pokoin-flutter`.

The **title-language** picker is the **32px circular flag in the top bar**,
right of the search pill (`LangToggle`). The Pokoin mark on the left is
**40px**. It sets `pokoin.searchLanguage` and
is sent as `search_language` / `lang` on **suggest and search** so typeahead
can match `rocco` and show the translation. Card/artist URLs
rewrite `/marketplace/{lang}/…`. Desk canonical replace keeps that segment —
it must not bounce `/marketplace/it/cards/…` back to `/en/` or the flag cannot
switch. English identity fields (`name` / `set` / `rarity`) stay on tiles,
desk, sets, and home. Suggest paints a CardTrader-style subtitle from
`localized_name` when it differs from English. Artist personal names are not
translated.

The **print-language** picker is the **gold magnifying glass inside the search
pill** (`PrintLangToggle`). Clicking it opens All / Western / Japanese /
Chinese. It filters Pokemon suggest rows by expansion nationality via
`pokoin.printLanguage`. It does **not** change card titles and does **not**
submit search. Search runs on **Enter** (or the suggest “View all results”
row). Western / Japanese / Korean / Chinese use print flags in `market/public/flags`
(HatScripts circle-flags; western is the US/EU split `euus.svg`; Japanese print
is the JP/KO split `jpko.svg`; Korean print is `ko.svg`). All prints uses the globe icon.

Home (house icon): on `pokoin.com` → `/` (landing). On One Piece / Riftbound hosts → `/marketplace`.

Competitive is Pokemon-only (hidden on satellite hosts). Pictures are Oracle
`/card-images/competitive/…`, not Limitless. [COMPETITIVE.md](COMPETITIVE.md).

Card art surfaces (tile vs suggest crop vs desk): [CARD_ART.md](CARD_ART.md).
Scan `/scan`: leftover-JPEG catalogs (`pokemon_generic` / `one_piece_singles`).
Desk is `public_id`, not TCGPlayer `id`. [SCAN.md](SCAN.md), [MARKET.md](MARKET.md).
Back/forward restores window scroll for that history entry (`scroll-restore.js`).
Restore only on **POP**; **PUSH/REPLACE** still start at the top. Hash links
are left alone. Persist the last real Y in a ref — layout cleanup must not save
`readWindowY()` after the card page has already scrolled to 0. Artist / Explore /
Portfolio / Search / Expansion stash `shown` + filters via `rememberPageView`
and hydrate only when the **path** matches (do not leak a `default` key across
URLs). Artist albums also stash how many tiles were shown (`ALBUM_PAGE=24` on
remount), so infinite scroll can grow tall enough before the Y is applied.
`fetchArtist` keeps an in-memory cache (`peekArtist`, 5000) so Back does not
wait on the artist API.
Chrome extension Cardmarket auth: `/extension/auth-bridge` posts the Firebase
ID token (`pokoin-auth-token` / `accessToken`, length ≥ 20) when the opener
sends `POKOIN_EXTENSION_AUTH_TOKEN_REQUEST` from `pokemon-card-extension`.
The side-panel desk iframe is credentialless (COEP). The extension posts
`POKOIN_EXTENSION_DESK_SESSION` (`token`, `uid`) into that frame; Firebase
`user=null` must not clear that injected session. `getBearer()` returns the
injected token until Firebase Auth itself is present. `/profile` and seller
pages (`/marketplace/{lang}/users/…`) must keep rendering with that uid —
never read `user.displayName` bare (that blacks the iframe). Worker
`pokoin-origin` frames **card desks**, **seller pages**, and **account**
routes (`/profile`, `/auth`, `/cart`, …) the same way and strips the
chrome-extension Referer. It must not put those headers on every
`/marketplace/*` URL — home, search, Pokémon/set hubs keep normal HTML so
tiles and `/api` stay on the apex when you are in a tab. Inside the
credentialless iframe, `framedByChromeExtension()` is true even with an
empty Referer (`window.credentialless`), the footer hides, and SPA fetches
go to `https://api.pokoin.com` (DNS-only, not Bot Fight). Framed desks set
`html.is-extension-desk`: no footer, clip horizontal overflow, and the version
`<select>` sits in `minmax(0,1fr)` so a long printing line cannot shove the
card off the left edge. Skip marketplace chrome on `/extension/auth-bridge`,
`/sanitize`, `/espurr`, and `/ocr`.

Action inventory: [pokoin-react-action-map.canvas.tsx](/home/nez/.cursor/projects/home-nez-Projects-pokoin-web/canvases/pokoin-react-action-map.canvas.tsx).

---

## Icon map (market top bar)

Source: `market/src/components/Chrome.jsx`. Routes: `market/src/punchouts.js`.
Every control is a **same-origin** path on `pokoin.com`. Never
`https://app.pokoin.com/…` for these icons.

| Control | href on pokoin.com |
| --- | --- |
| Logo / Marketplace | `/marketplace` |
| Home | `/` (static landing, full page) |
| Forum | `/forum` |
| Signal | `/marketplace/signal` |
| Competitive | `/marketplace/competitive` |
| PKN chip | `/wallet` |
| Profile / Sign in | `/profile` or `/auth?from=` |
| Cart | `/cart` (`pokoin.cartItems`) |
| Language flag | **Top bar**, right of search. Card **title** language (`pokoin.searchLanguage`). **32px** (the old Poko size). Pokoin logo is **40px**. Same 32px flag on `≤720px`. |
| Print flag | **Inside the search pill**, gold magnifying glass. Opens the card **print** language filter (`pokoin.printLanguage`). Search submit is Enter. |

Footer and burger also include Explore, Portfolio, **Sets** (era catalog,
`set-logos.js`, not the 80-row dump), Watchlist, Docs, About, Careers, Privacy, Scan.
Gold era names on Sets and Versions open `/marketplace/eras/:id`.

On viewports `≤720px` the icon row is a **left side drawer** (~86vw) that
starts **below the top bar**, with a dim scrim over the **full page** under
the drawer (including the header). 3-column gold icons over labels
(`Chrome.jsx` `mobile-tile`). Tap the dim to close. Search submit is **Enter**. The gold
magnifying glass in the pill opens the print-language filter. Phone layout: [MOBILE.md](MOBILE.md).
Suggest rows are **two columns** (`main | art`). Phone hides the set square and overlays the print flag on the art crop. No Singles cell.

Card page: Sign in → `/auth`. Artist and versions stay in this SPA. Add to cart
writes the local cart and opens `/cart`.

---

## Header search (CardTrader-style rows)

Source: `market/src/components/Chrome.jsx`, copy helpers in
`market/src/identity.js`. Dark gold theme — do **not** clone CardTrader’s
white/blue skin.

The pill’s gold magnifying-glass opens the **print-language** filter. Full
search is **Enter** (hidden `type="submit"` for assistive tech). Never the word
“Search” as a visible control. Clicking the **title-language** flag while the
popup is open keeps it open and re-queries so the translation subtitle
switches in place. Card and expansion titles on the rest of the site stay
English.

`GET /api/marketplace-suggest?q=` (Meili groups) with `search_language` from the
**top-bar** title-language flag (`pokoin.searchLanguage`). The SPA ranks a local
catalog of ~10k blueprint names plus ~400 illustrators and ~800 set titles
(`suggest-catalog.js`, same typo emission as the name pool). The popup still
opens on the **third compact character**. Typing `komiya` hydrates that artist’s
cards; `ultra prism` hydrates the set; `cyntha` still ranks Cynthia; `cynthia
secret rare` peels the rarity; `119/156` is a collector query. Meili stays the
name-printing hydrate for card names — do not put `expansion_aliases` on
typeahead search-on. One Meili index, English-identity documents (`language = "en"`)
for every flag — not one index per language. Localized names from
`card_name_languages` sit on Meili `nicknames` so typing `Fantallenatori` can
hit Ace Trainer. After grouping, the API stamps `localized_name` /
`localized_set` / `localized_rarity` from the tall catalog tables. The popup
keeps the **English** card name and expansion (CardTrader-style) and shows
`localized_name - collector` as `.suggest-translated` when it differs
(`Cynthia` / `Camilla - 119/156`). English `name` stays
on the row for `suggest-rank.js`. `market/src/suggest-rank.js` scores the compact **name** against
unique blueprint names from `marketplace_card_names` (re-export with
`scripts/export-suggest-names.py`). `miikyu ex` is one name (`mimikyuex`), not
a peeled EX layer. Art/rarity shorthands (`il`, `ir`, `sir`, `fa`,
`illustrazione`) peel after the name so `sylveon ex il` hydrates **Sylveon ex**
and ranks illustration / full-art / SIR printings first. Collector n / n/m
(`061`, `061/106`) peel the same way: `061 shieldon` ranks **Shieldon** and
puts 061 printings first — Meili is queried for the name, not every card
numbered 061. Letter-prefix collectors (`Sh1`, `SH12`, `TG01`) stay first in
the popup; extra **real** cached printings from the ranked name pool fill
toward 20 (Shinx / Shuppet typos) — never `live:` name stubs. The
print-language chip then keeps western (or JP/KO/CN) rows in that 20. `shi`
stays the name prefix. Set `151` stays a set token, not a collector. Short
set codes: `hgss energy` peels HeartGold & SoulSilver and ranks **elemental
energies** from that era (Fire Energy, not Aquapolis Energy Switch). `palkai
sl` peels Call of Legends (the SL secret-rare line) and ranks Palkia in that
set, not Palkia LV.X. Pair names and HGSS LEGEND halves do **not** peel:
`Palkia & Dialga Legend` is **Palkia & Dialga LEGEND** (never Paldea + Dialga);
`Lugia LEGEND` stays the landscape half. `palkia legen` without `&` still peels
the set. Tag Team GX pairs keep `tag team` on the name. BREAK, LV.X, V-UNION,
δ Delta Species, Prism Star, Gold Star, Radiant, Mega, regional forms
(Alolan/Galarian/Hisuian/Paldean), and owner Pokémon (`N's`, `Iono's`,
`Team Rocket's`) stay the card name — do not steal Paldea / BREAKthrough /
Mega Evolution / Shining Legends from those queries. Rank workers have an 80ms
fallback so Vite/cold workers cannot blank the popup; Meili starts on the typed
name in parallel with ranking. Reddit species typos
(`market/src/data/reddit-pokemon-typos.js`) are a regression suite — A-tier must
recover without exact aliases; do not alias official localized names
(`Garados`). Typed mechanic words (`gx`, `ex`, `v`, `vmax`, `vstar`) add **4 points** on
a perfect name match; catalog popularity is **2 points** (log printing count,
never 428×). `pikahc gx` → **Pikachu GX**. Typed mechanic (`keldeo ex`) fills
matching EX printings toward 20 and does **not** rank a rival GX/V/VMAX into
that list — White Flare `Keldeo ex` stays with Boundaries Crossed, not under
Unified Minds GX. Base species without a mechanic may still fill. Exact-prefix `oin` stays
**Oinkologne**, not Pikachu. Emission is prefix/QWERTY/typo
so `o` stays below Onix and `dawe` / `talflamd` still expand when Meili’s
5-letter typo floor would miss. Full set-code tokens (`hgss energy`,
`energy hgss`, `palkai sl`, `flareon call of legendsd`) are peeled in
`suggest-rank.js` and hydrated from the search page (set names live there);
leftover `ex` stays the EX mechanic, not Expedition. A bare expansion-title
token of 8+ letters (`expedition`) is a set browse: 20 singles from
Expedition Base Set, not the longer card-name prefix Expedition Uniform.
Shorter tokens (`dark`, `plasma`) stay names unless a card name is also
typed (`glaceon plasma`). An exact blueprint name never peels as a fuzzy
set title, even when a set title extends it: `eevee i` keeps the Eevee
name pool instead of peeling SWSH `Eevee Heroes` (that peel emptied the
popup to “No singles match”). A 2–4 word set title
with a typo (`call of legendsd`) peels as the set and ranks the leftover
name (Flareon), not sealed product titles that share those words. An exact
prefix (`palkai call of`) peels the same way — do not wait for `lege`. Fuzzy
prefixes stay unpeeled so `call of` does not become Cold Flare. The popup
takes the **top 20 real printings** from the ranked pool; it does not invent
empty gold-circle stubs to pad. The name pool ranks **once** per keystroke
(memoized); phrase peel uses the set-alias pool only. Chrome does not re-run
`liveSuggestGroups` in the Meili effect — it
bumps a tick after cache fills. Suggest Meili stays name +
number + nicknames so leftover `g` is still GX, not Guardians Rising.
Not Flutter `POST /api/marketplace-autocomplete` and not
`searchbar-token-predict` (prefix-only). Enter uses `resolveSearchQuery` (so
`dawe` submits as Dawn, `talflamd` as Talonflame, `miikyu ex` as Mimikyu ex;
`hgss energy` stays typed). Each printing is a row:

**2pikabench** (one bench, 10 names, `seed=2`): drop two letters and swap one remaining key for a QWERTY neighbor. All 10 must rank as the intended name. `rank_ms` is the name-pool scorer; `search_ms` is `fetchSuggestRanked` wall time (pool + parallel Meili), not the popup gate or the 40ms follow-up debounce. First-character Meili still runs in the background; the popup does not wait for it. Measured 2026-09-13 against `api.pokoin.com` from nezopt: **10/10 recovered**, rank 27 ms total (2.7 ms avg), search **1053 ms total (105 ms avg)**.

| # | query | want | ok | rank_ms | search_ms | rows |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 1 | `oriruo` | Oricorio | yes | 2.1 | 209.2 | 20 |
| 2 | `dwrknessener` | Darkness Energy | yes | 3.8 | 106.9 | 20 |
| 3 | `dclops` | Dusclops | yes | 1.8 | 76.0 | 20 |
| 4 | `bhlbsur` | Bulbasaur | yes | 2.1 | 77.8 | 20 |
| 5 | `zjnniasresve` | Zinnia's Resolve | yes | 4.4 | 74.3 | 20 |
| 6 | `rnofvotlity` | Urn of Vitality | yes | 3.7 | 74.0 | 12 |
| 7 | `xuknoi` | Dusknoir | yes | 1.7 | 188.2 | 20 |
| 8 | `quikbkl` | Quick Ball | yes | 1.9 | 91.6 | 20 |
| 9 | `entavrel` | Tentacruel | yes | 2.7 | 82.3 | 20 |
| 10 | `ombusln` | Combusken | yes | 3.0 | 73.1 | 20 |

| Cell | What |
| --- | --- |
| Set square | Official expansion **symbol** (`expansionSymbolSrc`, same PNG as the set desk title). 2.15rem mark, **vertically centered in the 68px thumb column** (`min-height: 0` so tall PNGs cannot overflow). Missing official files are saved as dark SVI-style plates (`export-expansion-code-marks.py`); HTML `setAbbrev` is only a last resort on a dark plate — never yellow on white. Empty set → `●`. Hidden `≤720px`. Autocomplete may send `expansion_symbol_url`; suggest maps that plus the slug path. `/marketplace` HTML is `max-age=0, must-revalidate` so the hashed JS (not letter-code `setAbbrev`) loads. |
| Thumb | Left mini **full card** (48×68, phone 40×56). `imageSrc(card, 'suggest')` prefers `_homepage.webp`, then leftover JPEG. CardTrader `preview_` URLs are allowed **only** here so empty squares do not appear. Hero/grid still drop previews. Same URL as the right crop. `suggest-images.js` preloads those thumbs into a **128** LRU (4 in flight, visible rows first). First 8 rows eager (`fetchPriority` high on the first 4); the rest `loading="lazy"`. Not leftover JPEGs. Not unlimited. |
| Hover | Desktop: hovering a row (or keyboard highlight) opens `.suggest-hover` — leftover JPEG, as large as the viewport beside the panel allows. Phone: no hover card. |
| Title | **Bold English** name on desktop, **gold** (`var(--yellow)`). Alternate title language adds a gray CardTrader second line (`.suggest-translated`): `Camilla - 119/156`. Phone keeps `Name - 006/021` in the title (`suggest-num-phone`). Expansion name under that, clipped at 20 characters, stays English. |
| Number | Desktop: `.suggest-number` is the **left** column in `.suggest-copy` (`auto minmax(0, 1fr)`), **first-baseline** with the name. Numbers left-anchor in a `7.5ch` tabular column; name/set sit to their right. Hidden at `≤720px`. Popup-only: `clipSuggestCollector` cuts to 9 characters (`Mewtwo Stamp` → `Mewtwo St`). Desk, tiles, and version badge keep the full number. |
| Right art | Pokemon only: landscape **illustration rectangle** (`CardArt cut`, `art-cut.js`). Same `suggest` URL as the left thumb — one download, CSS crop, **not** a 1:1 square, **not** a second `_art.webp`. **LEGEND** and **BREAK** cards skip the crop: `.suggest-art.is-landscape` shows the leftover rotated +90° (`isLandscapePrintName` in `art-cut.js`) so the name bar is on top. Not Call of Legends / BREAKthrough.
| Print flag | Desktop: left of that rectangle. Phone `≤720px`: overlay on the crop (top-left). `nationality` from `pokoin_pokemon_expansions`: `japanese` → JPKO (JP+KO split), `korean` → KO (Taegeukgi), `chinese` → CN, `western` → EUUS (US+EU split). Product: none. Leftover rows with empty nationality use the expansion’s flag (`expansionNationality(set)`), so HeartGold Collection energies still show jpko. Same mapping on the **set desk** `h1.page-title` ([PRINT_FLAGS.md](PRINT_FLAGS.md)). |
| Footer | **View all {total} results** submits to `/marketplace/search` **for the current tab**. The number is the search-page payload’s `total` (GET `/api/marketplace-search-page` returns it — same-WHERE `count(*) over ()`, so `popupCount(Q) === totalCount(search(Q))` for that universe) whenever the payload carries one; the Product/SQL universe always does. Where the total is still null (singles rides the Meili candidates window), the suggest payload’s relaxed `estimatedTotalHits` stays as the baseline footer number instead of zeroing it. |
| Tabs | Popup and `/marketplace/search` split exactly **Singles** / **Product** / **Users** — no Jumbo tab; `normalizeSearchTab('jumbo')` maps legacy `tab=jumbo` links into Product, and jumbos ride Product (`productSearchOnly` matches `item_kind = 'product' OR product_type = 'jumbo'`). Singles still sends `productType=card`, but the page ranks through **Meili** (same pool as typeahead) then hydrates and keeps `product_type=card`. Do not skip Meili for that param — SQL `ILIKE` AND-of-tokens made **View all 51** paint two *Shuppet Lv.17* rows. Product is sealed (`productSearchOnly`) plus jumbo / oversized leftovers (`Jumbo Oversized` in the number column) and named SKUs CardTrader filed as cards (theme / battle / WCD decks, **Collections** plurals, League Battle decks, dice sets, binders, chests, packs, kits, language exclusives, and anything in a `* Products` expansion). Meili suggest docs do **not** carry `item_kind` / `product_type` — the SPA classifies from name + set + group title. Trainers with those words and a printed n/m (`Deck Exchange`, `Suspicious Food Tin`) stay Singles. Users looks up an exact seller username on `marketplace-listings` and opens
`/marketplace/{lang}/users/{username}` (CardTrader-style seller desk). Default tab is Singles. |

The **20-row cap is server-side**. After nationality is attached, `applySuggestPrintPriority` (CardVault API repo) is a **visual tie-break only**: among printings with the **same Meili `_rankingScore`**, western (EU) rows sit before JP/CN, then the cap. Lower-scoring western printings do **not** jump higher-scoring JP/CN. `search_weight` is unchanged. Print-language chip is sent as `print_language` so the 20 rows match All / Western / Japanese / Korean / Chinese. Revert: `SUGGEST_PRINT_PRIORITY=0`.

While the popup is open the SPA **prefetches** the first search page (`search-hot.js`,
60s TTL, query length ≥ 2, `limit=48`, keyed by **tab**) so Enter paints the rest of the cards
from that query. The API keeps the Meili ID pool in process memory
(CardVault API repo `_suggest_hot_query.js`). Revert: `SUGGEST_HOT_QUERY=0` and/or stop calling
`prefetchSearchPage` in `Chrome.jsx`.

### Desktop vs phone (test both)

CSS: `.suggest-row` in `market/src/styles.css`. Contract test: `node --test market/src/suggest-layout.test.js market/src/suggest-rank.test.js market/src/suggest-live.test.js market/src/suggest-corpus.test.js`.

Fixture row: `#suggest-691678` Mimikyu 006/021 Starter Set MEGA Mega Diancie
ex (Japanese). Leftover is still a CardTrader `preview_`, so the mini scan is
`.suggest-ph` and there is **no** `.suggest-art`. The JP print flag must
still sit in the **last column**, not wrap under the title.

| | Desktop **1440×900** (`≥721px`) | Phone **393×852** (`≤720px`) |
| --- | --- | --- |
| Grid | `main \| flag (+ art)` | `main \| art` (flag overlays the crop; set square hidden) |
| `.suggest-main` | 3 cols: set, thumb, **copy (number left, name/set right)** | 2 cols: thumb, copy; number back in the title |
| `.suggest-number` | own column **left of** the name/set (`008/022`), left-anchored | `display: none` |
| `.suggest-num-phone` | `display: none` | inline ` - 008/022` |
| Columns | `minmax(0,1fr) auto` — flag+art on the **right**; number sits next to the name | `minmax(0,1fr) auto` |
| Mini scan | 48×68 | 40×56 |
| Art crop | 8.75rem, last column | 6.75rem, last column |
| Missing leftover | placeholder + flag in last column; **one row**, not 120px wrap | same |

Playwright:

```bash
playwright-cli open http://127.0.0.1:5174/marketplace
playwright-cli resize 1440 900   # desktop
# type mimikyu; #suggest-691678 .suggest-art-cluster must share the first row y
playwright-cli resize 393 852    # iPhone 16
```

No uppercase group headers (`MIMIKYU`). Groups still exist in the payload for
rank. The popup shows **20** printing rows, scrollable; the footer stays pinned.

Row pick goes to the card page.

After marketplace **home** finishes loading, `warmupSearchBar()` runs on idle
(5 min TTL). It hits `GET /api/marketplace-suggest?q=m&limit=4` (the header
path), remembers those printings in the live typeahead cache, preloads their
`_homepage.webp` thumbs into the 128-slot LRU, and, on Pokemon only,
`GET /api/searchbar-token-predict?warmup=1` (same first-char warmup as
Flutter). Errors are swallowed. Do not wait on this for LCP. Hover leftover
JPEGs are not part of that cache — the portal fetches the one scan on enter.

---

## Pipeline (edit → live)

```
Chrome hrefs          punchouts.js APP
     │
     ▼
pokoin-web  ──build-web.sh──►  dist-web/          Vercel `web`     pokoin.com
CardVault   ──deploy-pokoin-flutter-new-project.sh──►  Vercel `pokoin-flutter`
                                                          alias app.pokoin.com
```

1. Change a route in `market/src/punchouts.js` (and landing `index.html` if it
   is a marketing link).
2. Deploy the **web** (`scripts/build-web.sh` / Vercel project `web`).
3. Change Android/iOS UI in CardVault, then deploy **only** `pokoin-flutter`.
   Do **not** alias `pokoin.com`. See [APP.md](APP.md).

Do not copy Flutter `app.html` into `dist-web`.

---

## Live check

`https://pokoin.com` sits behind Cloudflare Bot Fight. Datacenter curls from
this host get **403** / JS challenge. Use a real browser.

JSON APIs use **`https://api.pokoin.com`** (Cloudflare Tunnel, orange-clouded).
Submit GSC sitemaps at **`https://sitemap.pokoin.com/sitemap.xml`** (grey-cloud
Vercel CNAME, no Bot Fight). Search Console’s fetch is a datacenter IP;
Bot Fight 403s every proxied `*.pokoin.com` name including the API tunnel.
`pokoin.com/api/*` still orange-clouds through the origin Worker; a custom
skip rule covers BIC for `/api/` but Free Bot Fight cannot be skipped (only
Super Bot Fight). Do not send extension `fetch` to the apex host. The
credentialless desk iframe has the same rule: `publicApiUrl()` rewrites SPA
`/api` calls to `api.pokoin.com` so home tiles and expansion pages are not
403s without `cf_clearance`.

Forum, Signal, Competitive, Wallet, Profile, and Cart on
`https://pokoin.com/marketplace` are same-origin React routes. They must not
open `app.pokoin.com`.
