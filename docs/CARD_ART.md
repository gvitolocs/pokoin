# Marketplace card art surfaces

**Do not mix these up.** On 5 Sep 2026 an agent CSS-cropped the Pokemon
illustration window onto every `CardTile`. Giuseppe’s crop belongs on the
**right of search suggest** and on **artist / illustrator tiles**. Home
rails, search results, set grids, and the card desk stay **full card scans**.

Canonical crop math: `market/src/art-cut.js`. Chrome: [CHROME.md](CHROME.md).
Pipeline / images: [MARKET.md](MARKET.md), [HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md).
Games + **nezopt 15T Pi replica**: [GAMES.md](GAMES.md). JP/CN flags: [PRINT_FLAGS.md](PRINT_FLAGS.md).

---

## Hard rules

1. `CardArt cut` / `.art-cut` is the Pokemon illustration rectangle from
   `art-cut.js`. Surfaces: the **right column** of `#market-suggest`
   (`Chrome.jsx`), and **artist / illustrator album tiles** (`Artist.jsx`
   `.tile-cut.tile-album`). Landscape, **not** a 1:1 square. Album cells are
   **88∶63** (rotated card); suggest keeps the tighter illustration window.
   Not home/search/set tiles.
2. Default `CardTile` (class `.tile` without `.tile-cut`) is **always** the
   full leftover scan in a **63:88** box. Never wrap those `.tile-art` in
   `.art-cut`.
3. SPA: do not add `_art.webp` next to leftovers, and do not point tiles at
   pipeline crops. The suggest rectangle CSS-crops the **same**
   `imageSrc(card, 'suggest')` URL as the left thumb. CLIP / version-matching
   JPEGs live only on nezopt, sibling dir `artcut/` — [GAMES.md](GAMES.md).
4. Desk, zoom, and the home promo fan are leftover **JPEG** (`CardArt full` /
   `imageSrc(..., 'hero')`) on Pokemon. One Piece / Riftbound desks keep the
   catalog png/webp/jpg (`/card-images/one-piece|riftbound` → Pi `cdn.pokoin.com`; do not
   rewrite those prefixes to `.jpg`). Grid/search tiles are `_homepage.webp`
   then the master raster.
5. One Piece / Riftbound: no `.suggest-art`. Tiles stay full-card.
6. Competitive sprites / flags / format badges / scans are Pokoin Oracle
   (`/card-images/competitive/…`), not Limitless CDN. Map: [COMPETITIVE.md](COMPETITIVE.md).
7. `/marketplace/sets` wordmarks (`set-logos.js`) are expansion logos on the
   Pi (`/card-images/expansions/wordmarks/{slug}.png` and leftover
   `/card-images/expansions/logos/{slug}.png`). `/marketplace/eras/:id` reuses
   that grid. Desk reprint shortcuts use
   `/card-images/expansions/symbols/{slug}.png`. Missing official marks are
   saved once as SVI-style dark plates (`scripts/export-expansion-code-marks.py`),
   not HTML letter discs. They are **not** leftover
   card scans and **not** `CardArt cut`.

---

## Scan files (not Milo embeddings)

The desk shows the leftover **JPEG** on CDN (`{ct_id}_{slug}.jpg`). Rails JSON
may still store a **public-id** prefix (`pokoin_public_card.py`); the SPA
rewrites `<img>` to leftover `ct_id` (`leftoverKeyMatchesCard` /
`ownCatalogImage`). Desk **paths** stay `{public_id}`.

Live cardscan **Pokoin catalogs** (`pokemon_generic`, language galleries, OP
singles) use `"identity": "public_id"` — `hit.id` **is** the desk id.
Omitting `catalog` still searches TCGPlayer; that `id` is **not** a desk URL.
Map: [SCAN.md](SCAN.md).

If that JPEG is missing, **or** the leftover is CardTrader’s 186×260
`fallbacks/card_uploader` logo, `CardArt` paints `/home/missing-card.webp`
(Pokoin coin on a **63:88** card, TCG `--tcg-corner`). Leftover files that
are that grey 186×260 back are rewritten to the same Pokoin coin as a 630×880
JPEG (`scripts/replace-cardtrader-placeholder-leftovers.py`, cache `?v=pkph1`).
Do not CLIP those files. Do not show the
CardTrader placeholder. Catalog may still hold a
CardTrader `preview_` URL; the SPA drops those on desk/tiles and tries
`/card-images/{leftover_ct_id}_{slug}.jpg` instead (public id / 2, same as the
desk stub). Desk **paths** stay `{public_id}`. Leftover `ct_id` can equal another
card’s public id — do not put public id in the image key (Net Ball `245292` vs
Cyndaquil leftover `245292`). Suggest may show `preview_` so the row is not a
grey square — `CardArt` still swaps the 186×260 CT logo for `/home/missing-card.webp`.
Cloudflare blocks `.svg` on pokoin.com.

---

## `imageSrc(card, kind)` — `market/src/api.js`

| `kind` | File | Shape on screen | Used by |
| --- | --- | --- | --- |
| `'grid'` (default) | `{leftover}_homepage.webp`, 404 → leftover JPEG | Full card 63:88, `object-fit: contain` | **Every `CardTile`**. Image key is leftover `ct_id` (`public / 2`). `leftoverKeyMatchesCard` rejects a public-id prefix (Net Ball `245292` vs Cyndaquil leftover `245292`; Kirlia leftover `241930` vs Pikachu public `241930`). `ownCatalogImage` also drops a leftover prefix whose **slug** is another card (Juniper leftover `342356` is Pikachu V-UNION’s public id). Ignore `tileImageUrl` / `homepageImageUrl` when the filename slug is not this leftover JPEG’s slug. |
| `'hero'` | leftover JPEG only (`preferFullImage`); OP/RB keep png/webp | Full card 63:88 | Desk, zoom, promo fan, explore, portfolio |
| `'suggest'` | homepage webp if known; else leftover JPEG; **CardTrader `preview_` allowed only here** | Left: 48×68 (40×56 phone) full-card `cover`. Right: CSS illustration rectangle | Search popup only |

`CardArt` `full={true}` forces leftover JPEG even if `src` was a homepage
webp. `cut={true}` wraps the **same** `src` in `.art-cut` (no extra fetch).

---

## Type A — `CardTile` (`.tile`)

**Component:** `market/src/components/CardTile.jsx`  
**Look:** padded full-card JPEG/webp (`.tile-art` padding on **every** side —
never `padding-bottom: 0`, or the grey `.tile-meta` sits on the bottom
border), name, `printingIdentity().tileLine`,
PKN. Hover scales the **whole scan** from the bottom (`transform-origin: 50% 100%`).  
**Image:** `imageSrc(card, 'grid')`. Pointer-enter prefetches `'hero'` for
the desk (second file on purpose: tile ≠ master).

Every caller except **artist pages** is this same type. Do not fork a
cropped tile for home, search, set desk, versions, or the printings rail.

| Caller | Route / surface | Extra |
| --- | --- | --- |
| `Home.jsx` → `Carousel` | Recently seen, New cards, Best sellers, Spotlight | Horizontal rail, `SkeletonTile` is 63:88 placeholder |
| `Home.jsx` `.grid` | Marketplace grid under the rails (Pokemon: random English, 14 + Show more) | Same `CardTile` |
| `Search.jsx` | `/marketplace/search` | Result grid |
| `Expansion.jsx` | `/marketplace/sets/:slug` | Set browse grid |
| `Versions.jsx` | `…/versions` | Rarity grid + CLIP printings grouped by TCG era |
| `Products.jsx` | `/marketplace/products` | Product grid |
| `Watchlist.jsx` | `/marketplace/watchlist` | Local watchlist grid |
| `Card.jsx` printings rail | Card desk, exact-name tiles | `action={Action.clickVersion}` |

`Artist.jsx` is **Type H** (illustration crop), not Type A.

`Carousel.jsx` only maps `CardTile`. It must not inject a leftover full-size
raster or an art-cut.

---

## Type B — search suggest (two images, one URL)

**Component:** `Chrome.jsx` `#market-suggest`  
**Row left → right:**

| Cell | Class | What |
| --- | --- | --- |
| Set mark | `.suggest-set` | Expansion **symbol** PNG when the CDN has it (same as set desk). Else 2–4 letter abbrev. Hidden `≤720px`. |
| Mini scan | `.suggest-main img:not(.set-shortcut-sym)` | Type A shape, tiny: **full card** 48×68 (phone 40×56) |
| **Hover scan** | `.suggest-hover` | Desktop only (`≥721px` + fine pointer). Portal beside the popup. **Leftover JPEG** (`imageSrc` hero + `CardArt full`). Not the art-cut. Not `_homepage.webp`. Same 63:88 leftover as the desk. Loaded on enter, **not** kept in the suggest LRU. |
| Title / number | `.suggest-copy` / `.suggest-copy-text` | Desktop: collector number **left** of the **gold name** + set stack (first baseline, straight left column). Expansion clipped at 20 characters in JS. Phone: `Name - 006/021` |
| Collector number | `.suggest-number` | Desktop, left of the name. Hidden `≤720px`. |
| Print flag | `.suggest-print-flag` | Desktop: **left of the art rectangle.** Phone `≤720px`: overlay **on** the crop (top-left). JP/KO split, CN, EUUS from nationality. Product: omit. Same helper on the set desk title. |
| **Illustration rectangle** | `.suggest-art` + `CardArt cut` | **Only this cell is the art-cut** — except HGSS **LEGEND** halves and XY **BREAK** cards. Those leftovers are landscape prints stored as 63:88; `.suggest-art.is-landscape` shows the **full card rotated +90°** (`isLandscapePrintName`) so the name bar is on top. Not Call of Legends / BREAKthrough set titles. Far right. Desktop: flag immediately to its left. Phone: flag overlays the crop. Pokemon only. Same `thumb` URL as the mini scan. If leftover is missing, omit this cell; print flag stays in the last grid column. |

Crop (`art-cut.js`) is **per TCG layout family**, measured on leftover
scans (inner painting, not the gold/silver frame). Qwen3-VL
(`qwen3-vl:32b-instruct` via Ollama) gave an *outer* box that includes
the name plate — use those as bounds, then inset to the painting.

Official commissioned illustration is **2.13 × 1.34 in** on a **2.5 × 3.5 in**
card ([PTCG Illustration Contest](https://www.ptcgic-cr.com/2024/en/column/article-1/))
= 54.1 × 34.0 mm of 63.5 × 88.9 mm. That is the art *file* under the
frame, not the visible window. English Southern Islands was reframed to
the **Neo** window in 2001 ([Art of PKM](https://www.artofpkm.com/feature/southern-islands));
do not use the Original gold-frame crop there.

| Family | Eras | Leftover (W×H) | Inner box x,y w×h | Fractions L,T,W,H |
| --- | --- | --- | --- | --- |
| `wotc` | Original, Gym, LC | Base Alakazam `55574` 1260×1760 | 166,310 927×486 | 0.132, 0.176, 0.736, 0.276 |
| `neo` | Neo, Southern Islands | Wartortle `127870` 500×688 | 41,105 418×246 | 0.082, 0.152, 0.836, 0.358 |
| `ecard` | e-Card | Expedition Alakazam `118548` 500×688 | 66,105 374×208 | 0.132, 0.152, 0.748, 0.302 |
| `ex` | EX | Emerald Blaziken `115739` 500×688 | 36,77 428×219 | 0.072, 0.112, 0.856, 0.318 |
| `dp` | DP / Platinum / HGSS / COL | Dialga `113939` 500×688 | 39,88 422×233 | 0.078, 0.128, 0.844, 0.338 |
| `modern` | BW → Mega | Sprigatito `237709` 749×1050 | 64,132 620×355 | 0.086, 0.126, 0.828, 0.338 |

Default is modern. LEGEND/BREAK skip this crop. EX stops above STAGE / Illus.

---

## Type C — promo fan

**Component:** `PromoCarousel.jsx` `.promo-card`  
**Image:** `imageSrc(card, 'hero')` + `CardArt full` — leftover **JPEG**, same as the desk. Not `_homepage.webp`.  
**Shape:** full card 63:88, tilted trio. Not a tile, not a crop.
Each visit shuffles **secret / illustration rares** from that expansion
(`promo-fan.js` pool of 8). The pool is `GET /api/marketplace-rails?id=set:{slug}`
(`fetchPromoFanPool`) — **no** PKN overlay and **not** `marketplace-expansion-page`
with `limit=160`. If the chase pool is short, fill from any card with a hero.
404s are skipped. Do not pin Mega Rayquaza (or any id) on Storm Emeralda — the
lede may still name a chase card.

---

## Type D — card desk + zoom

**Component:** `Card.jsx` `.art-frame` / `<dialog class="zoom">`  
**Image:** `imageSrc(card, 'hero')` + `CardArt full`  
**Shape:** unclipped leftover JPEG in a **fixed 63:88** `.art-frame` (same
width as the version select). The frame hugs the scan — it does not flex to
fill the art panel. `object-fit: contain` only if the JPEG is not 63:88.
Click scan → lightbox. Never `--tcg-corner` clip-path on the desk scan.
Never art-cut.

Ingest die-cut (leftover JPEG, not CSS): physical trim **63.5 × 88.9 mm**,
circular corner **3.175 mm** (`5%` of width = `3.571%` of height — the same
`--tcg-corner: 5% / 3.571%`). The sanitizer may punch only the four cardboard
crescents outside that quarter-circle. It must not rewrite the printed silver
TRAINER bar or nameplate (Air Balloon). Recipe: CardVault
`pokemon_card_vault/docs/card-image-sanitize.md` /
`scripts/lib/sanitize-card-image.js`. Do not batch-rewrite ~50k R2 objects.
CardTrader stays the unsanitized source.

---

## Type E — bag (cart / checkout)

**Component:** `Cart.jsx`, `Checkout.jsx` `.bag-art`  
**Image:** cart line `row.image` (usually a catalog URL already on the item)  
**Shape:** 64×88 `object-fit: contain`. Full card. Not art-cut.

---

## Type F — explore / portfolio listings

**Component:** `Explore.jsx` `.explore-card`, `Portfolio.jsx`  
**Image:** `imageSrc(item, 'hero')`  
**Shape:** full card 63:88. Native listing photos, not suggest crops.

---

## Type G — competitive (not catalog tiles)

Oracle files via `SPRITE` / `FLAG` / `FORMAT` / `scanUrl` in
`market/src/competitive.js`. Paths: `/card-images/competitive/{sprites,flags,formats,scans}/…`.
`CardArt` is reused as an `<img>` helper only. **No** `cut`. **No**
`imageSrc` leftover keys. Do not hotlink Limitless. Sync:
`scripts/sync-competitive-cdn.sh`. Spec: [COMPETITIVE.md](COMPETITIVE.md).

---

## Type J — artist / illustrator album tiles

**Component:** `Artist.jsx` desk grid (`CardTile cut` + `.tile-album`) and
illustrators index (`.artist-tile.tile-cut.tile-album`).  
**Image:** leftover **JPEG** (`imageSrc(..., 'hero')` / `CardArt full`),
CSS-cropped from the era `art-top` / `art-width` in `art-cut.js`. Not
`_homepage.webp`. Not the nezopt `artcut/` pipeline files.  
**Shape:** album cell is **88∶63** (a Pokémon card rotated), the same box
as HGSS **LEGEND** / XY **BREAK**. Window tiles **width-fit** the era
illustration and vertically center it in that cell (no zoom, no side
crop). The leftover `<img>` **layout box stays inside that cell**
(`object-view-box` + `object-fit: contain` on Chrome). Do not shift the img
with negative `left` / width > 100% on Chrome — that pans the page and
native `loading=lazy` skips the fetch until hover (SO 67390705). Not a
1:1 square, not the
short illustration window used on suggest. Photo flush to the tile
edge (no 63:88 padding, no hover scale). **Exception:** HGSS **LEGEND** halves
and XY **BREAK** cards skip the crop (`.tile-album.is-landscape`): full
leftover rotated **+90°**, name bar on top, same as suggest. Not Call of
Legends / BREAKthrough set titles. Caption is the printing line on the
photo; `.tile-art::after` is a short masked blur at the bottom edge
tinted with that leftover’s `art_shade` delta (not a black wash) —
not a frosted rectangle with a hard top line. `.tile-art::before` sits
above the scan (z-index 1) with the same leftover shade on the top cut.
The crop mask fades the first ~14px so the cut is not a hard knife. Window
tiles width-fit and vertically center the era illustration in 88∶63
(Giuseppe: center, not zoom). Two-row bleed starts near leftover top
(`ART_CUT_BLEED.top` 0.028) so the
span is painting, not shade under the card.  
Illustration / full-art / Trainer Gallery / Hidden Fates Shiny Vault
printings use `.tile-tall` (`grid-row: span 2`, stretch to two cells plus
the gap) **only from Black & White onward** (when Full Art exists).
Original / Neo / e-Card / EX / DP / Platinum / HGSS / Call of Legends
stay one-row era windows even if leftover geometry stored bleed
(Neo Destiny Shining Mewtwo). Energy / Spirit Link stay
`.tile-item` full leftover. Potion and Doll use the era window — Base Set
has no full-art leftover except Energy. Paldean Fates n/m Shiny Rare (Dolliv 103/091)
and Hidden Fates / Shining Fates **Pokémon** SV## Shiny Rare (Diancie SV36, Morpeko SV44)
are framed windows. Hidden Fates Shiny Vault **trainers** (Lady SV86) stay full art.
Sword & Shield **Amazing Rare**
(Vivid Voltage 009/050/082/102/119/138, Shining Fates 017/021/046, JP
Legendary Heartbeat / Shiny Star V reprints) is album **halfart**: one-row
88∶63 crop of the illustration box (`ART_CUT_HALFART`), not Illustration
Rare bleed. CLIP holos of that painting stay window. XY Gold Secret
Mega EX (Flashfire 108/106) still has attacks — leftover geometry is
window, not bleed from the Gold Secret token. XY Secret Rare EX with
collector **n > m** (BREAKthrough Mewtwo ex 163/162 and 164/162) is album
bleed / `.tile-tall` even when leftover stored window; in-set ultras
(159/162) and trainer secrets without `ex` stay one-row.
Trainer **Ultra Rare** and SWSH/SV **Secret Rare** supporters (Serena 207/195,
Elesa's Sparkle 147/159, Morty's Conviction SIR, Misty's Determination UR)
are album bleed / `.tile-tall` even when leftover `art_layout` stored window.
Do not Dex-zero every trainer into a one-row window. Uncommon Wallace, Professor
Program Stamp Sada, Illustration Contest, and SM gold items stay the era window
until Gold Secret. Boundaries Crossed Squirtle
29/149 is a framed XY common — leftover OCR + yellow era border, not CLIP
`geometry:no_chrome`. SV type-tinted rules sheets (Quagsire SVP 156 cyan)
are a flat panel, not cream/white. First Partner MEP 037–063 and JP
`101/M-P`–`124/M-P` / `M-P 125`–`127` illustration promos are bleed;
McDonald's `019/M-P` stays a framed window. Autumn gold or cream in that
painting is not a gold/cream rules box. Catalog IR/FA does not become a
window because the leftover has cream paint or a dark HP overlay
(Beautifly IR, Accelgor IR).
The box is two regular album tiles tall (parent era-window vars). The
painting inside is `ART_CUT_BLEED` width-fit from near leftover top
(`top` 0.028) so the two-row cell is painting, not empty shade under
the scan — not a height-zoom that crops the sides, not a bleed-aspect
tile that sits short in the span. HP/name on full-art is overlay on
that painting. Suggest still uses the era window (`cutSurface` is album-only).
**Energy and Spirit Link** stay `.tile-item` full leftover
(`object-fit: contain`). Potion, Super Potion, and Clefairy Doll use the
era illustration window — Original / Base Set has no full-art leftover
except Energy. Stadium / supporter /
fossil trainers with a painting box use the same era art-cut as Pokémon
(Apricorn Forest, Antique Jaw Fossil are not two-row mini cards). Layout is **this leftover’s OCR text + pixels**
(`marketplace_leftover_art_layouts`). CLIP `pokoin_version_sets` is the same
painting, not the same frame — JP/CN only inherit a leftover-majority after
each scan is classified. Catalog rarity tokens are the SPA fallback. **Secret
Rare is not a layout.** **Prize Pack / League Promo set titles are not a
layout.** Regular ultras in those sets stay one cell with the era art-cut.
Regular printings stay one cell with the era art-cut. Index covers stay one
cell. Leftover `art_shade` remains the tile fallback. Pipeline:
[ARTWORK_LAYOUT.md](ARTWORK_LAYOUT.md).  
**Index cover:** leftover scan of that illustrator’s Pikachu, else a gen 1
starter (Bulbasaur / Charmander / Squirtle), else Eevee, else the highest
listed PKN. Never a CardTrader `preview_` thumb.

---

## Type H — chrome chrome (not Pokemon art)

Set symbols (`.set-sym`), language flags (`.lang-toggle`), forum avatars
(initials), burger `.mobile-tile` gold SVGs. Never catalog scans.

---

## Incident (do not repeat)

| Date | Mistake | Fix |
| --- | --- | --- |
| 5 Sep 2026 | `CardTile` got `cut={isPokemonGame()}`. Home/search/set grids showed landscape art windows. | Reverted. `cut` only on `.suggest-art` and artist `.tile-cut`. |
| 13 Sep 2026 | Suggest art-cut on LEGEND/BREAK leftovers showed a sideways strip. | `.suggest-art.is-landscape`: full card rotated, no cut. |
| 14 Sep 2026 | Artist album art-cut on LEGEND/BREAK showed the BREAK rule strip sideways. | `.tile-album.is-landscape`: full leftover +90°, no cut. |
| 14 Sep 2026 | Prize Pack set title forced tall tiles; FA `cover` cropped to Night Joker text. | Layout from leftover OCR + pixels; rarity tokens only as SPA fallback. Tall tiles `contain`. |
| 14 Sep 2026 | Artist album caption was a tall frosted bar with a hard top edge. | Printing line on the photo; short masked `.tile-art::after` blur. |
| 14 Sep 2026 | CLIP `geometry:no_chrome` made Boundaries Crossed Squirtle 29/149 a two-row leftover. Cyan XY rules are not cream; Secret Rare is not a layout. | Per-leftover OCR chrome + yellow era border; do not inherit CLIP bleed. |
| 14 Sep 2026 | 5ban album cropped BREAKthrough Mega Mewtwo Secret Rare 163/162 and 164/162 into one-row windows. | XY Secret Rare EX with n > m is album bleed; Gold Secret Mega EX stays window. |
| 14 Sep 2026 | Arita album: leftover crop imgs sat past the viewport (horizontal scrollbar) and stayed blank until hover. | `object-view-box` keeps the img box inside the 88∶63 cell so lazy-load intersects. |
| 14 Sep 2026 | Neo Destiny Shining Mewtwo sat as a two-row leftover next to Neo windows. | Pre-BW eras have no Full Art; album stays the era window except energy/item. |
| 14 Sep 2026 | Komayama Hidden Fates / Shining Fates Pokémon Shiny Rares were two-row leftovers. | Pokémon Shiny Rare (Paldean Fates n/m and HF/SF SV##) is an album window; Lady SV86 trainer stays bleed. |
| 14 Sep 2026 | Mizutani Serena Secret 207/195 and Elesa's Sparkle UR 147/159 were 88∶63 crops of full-art leftovers. | Trainer UR / SWSH-SV Secret Rare supporters are album bleed; uncommon / Stamp / Illustration Contest stay window. |
| 14 Sep 2026 | Forcing Dex-zero trainers into a window halved Morty's Conviction SIR. | Leftover-bleed full-art supporters stay `.tile-tall`. |

If a screenshot circles a dark rectangle “put the art here”, **ask which
surface** (suggest right vs artist tile vs Type A tile vs desk) before
changing Type A.

---

## Pipeline crops (nezopt, not the Pi)

Illustration-window JPEGs for CLIP / `pokoin_version_sets` are **not** a
marketplace surface. Export them on **nezopt NVMe** from leftover JPEGs.
The Raspberry Pi has no Pillow and must not crop or encode. 15T mybook is
Postgres historicization, not an edge glob.

| | |
| --- | --- |
| Edge leftovers | `/home/nez/data/pokoin-leftovers/objects/{ct_id}_{slug}.jpg` |
| Crops | `/home/nez/data/pokoin-leftovers/artcut/{ct_id}_{slug}.jpg` |
| One-time HDD→NVMe | `scripts/sync-nvme-leftovers-from-15t.sh` |
| Export | `scripts/export-leftover-artcut.py` (all CPUs) |
| Match | 7900 XTX leftover ingest / `scripts/match-imported-version-sets.sh` (illustration **box** CLIP, then equalized pixels, cluster floor **0.55**). Full `--all`: `version-sets-pipeline.sh`. [VERSIONS.md](VERSIONS.md). |

Listed **Base Set** (`bs` / 1472) leftovers are **unlimited** TCGPlayer product
photos (CardVault repo `pokemon_card_vault/scripts/import-base-set-unlimited-tcgplayer.js`). Encode with a 63:88 cover-fit;
do **not** run the yellow-frame millimetre rebuild — that stretched Magneton
and left Drowzee as a 325px thumb. pokemontcg.io `base1` hires are 1st Edition /
shadowless — do not point listed Base Set at that CDN.
**Base Set Shadowless** (`shbs` / 1969) stays on its own leftovers.

Do **not** rsync `artcut/` into `objects/`. Do **not** wire those files into
`CardTile`. Map: [GAMES.md](GAMES.md).

---

## Type I — set desk title flag (not art)

**Component:** `Expansion.jsx` `PageHead` → `h1.page-title`  
**Look:** circular JP/KO (`jpko`) / CN / western (US+EU `euus`) flag **left of the set name**. Yellow `SET` kicker
above, gray “N cards” lede below. `printFlagFromNationality(expansion.nationality)`.  
**Not** on Cart / Wallet / Forum `PageHead`s. **Not** on `CardTile`.
Sets / Era catalog tiles (`SetGuideGrid`) use the same flag **left of the set name**.

Flutter analog: `CollectionExpansionScreen` `_SelectedExpansionHeader`.
Copy notes: [PRINT_FLAGS.md](PRINT_FLAGS.md).
