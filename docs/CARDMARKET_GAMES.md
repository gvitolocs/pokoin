# Cardmarket-only games

Nine games sold on Cardmarket that CardTrader does not cover. Each has its own
database on the nezopt writer (`pokoin_<game>`, streamed to the Pi replica like
every satellite game), raw table `marketplace_<game>.cardmarket_products`, and
CDN prefix `<slug>/` under `/srv/pokoin/card-images/objects/` on the Pi.

| Game | `game` | Path | Catalog source | Cards | Live |
| --- | --- | --- | --- | --- | --- |
| Final Fantasy TCG | `final_fantasy` | `/final-fantasy` | Square Enix card browser JSON (`fftcg.square-enix-games.com/en/get-cards`) | 4,260 | yes |
| Star Wars Destiny | `star_wars_destiny` | `/star-wars-destiny` | SWD Renewed Hope public API (`db.swdrenewedhope.com/api/public/cards/`) | 2,883 | yes |
| Weiss Schwarz | `weiss_schwarz` | `/weiss-schwarz` | `CCondeluci/WeissSchwarz-ENG-DB` + `-JP-DB` (official ws-tcg.com art, EncoreDecks for gaps) | 65,982 EN+JP with images (725 without art hidden) | yes |
| Force of Will | `force_of_will` | `/force-of-will` | FoWDB set listings (480×670) | 4,213 | yes |
| World of Warcraft TCG | `world_of_warcraft` | `/world-of-warcraft` | wowcards.info edition tables + scans (312×440; WoW TCG Reborn 750×1050 packs are Google Drive only) | 7,784 | yes |
| Battle Spirits Saga | `battle_spirits_saga` | `/battle-spirits-saga` | official battlespirits-saga.com database (600×838) | 1,089 | yes |
| Dragoborne | `dragon_born` | `/dragon-born` | dragoborne.fandom.com MediaWiki API (480×670, needs the wiki Referer) | 476 | yes |
| My Little Pony CCG | `my_little_pony` | `/my-little-pony` | data.mlpmerch.com CCG database (full-size originals) | 2,172 | yes |
| The Spoils | `the_spoils` | `/the-spoils` | the-spoils-cardgame.vercel.app (Cloudinary art 500×700) | 2,101 | yes |

## History

2026-09-29/10-01: the databases were first filled from **2019 Wayback Machine
snapshots** of Cardmarket listing pages (`blueprint.source = cardmarket-wayback`),
because there are no Cardmarket API keys. That gave 3,012 rows for 7 games, 42
images, and a `collector_number` that is only the row index. Usable as a list
of Cardmarket product ids, not as a catalog.

2026-10-02: `scripts/catalog/import_catalog.py` replaces that sample with full
catalogs from free public sources. Every Wayback row that matches a source card
(by card code, else name + set) gives its Cardmarket product id to that card
(`card_market_ids`), then the Wayback rows are deleted.

## Import

```bash
~/.venvs/pokoin-catalog/bin/python scripts/catalog/import_catalog.py final_fantasy            # dry run
~/.venvs/pokoin-catalog/bin/python scripts/catalog/import_catalog.py final_fantasy --images --apply
```

- Ids: sequential from `100_000_000` per game, kept per source key
  (`blueprint.source_key`) so reruns never renumber. Public card id = id × 2
  must stay **below 999,000,000**: larger ids are read as provisional Storm
  Emeralda stamps (`workers/public-card-id.js`) and rewritten, which broke card
  links on 2026-10-02 until the first import (hashed 10¹⁰ ids) was renumbered.
- Weiss Schwarz images: official ws-tcg.com art; EncoreDecks
  (`encoredecks.com/images/<imagepath>`, 460×641) only where the official URL
  404s (≈5,000 JP cards), so we don't bulk-download a community site.
- Images: the largest the source publishes (FF 429×600, Weiss 350×489, SWD
  298×418), capped at 1050 px tall, JPEG q90 + 240 px `_homepage.webp`, rsynced
  to the Pi CDN, then served by `cdn.pokoin.com` / `pokoin.com/card-images`.
- Raw source responses and rendered images are cached in `~/pokoin-catalogs/<game>/`.
- After the upsert: stale candidates are removed, then
  `refresh_cardmarket_marketplace_projections()` and
  `refresh_marketplace_set_catalog_counts()` run.
- `scripts/sql/098_cardmarket_game_catalog_support.sql` gives these DBs the
  set-count / expansion / Cardmarket-link tables the shared API reads.

## Going live

1. Catalog + images imported (table above).
2. Registry: the game is in the Rust game registry
   (`pokoin-rust/crates/api-common/src/game.rs`; CDN prefixes in
   `crates/catalog-api/src/shared/row.rs`; `git grep -i <an existing game>` in
   `pokoin-rust/` lists every copy); ship with `scripts/deploy-pokoin-rust.sh`.
3. Site: add the game to `market/src/game.js` (picker), and keep the slug in the
   `vercel.json`, `image-urls.js`, worker and CDN prefix lists; ship with
   `scripts/deploy-web.sh`. A game is added to `game.js` only once its catalog
   has images, so the picker never opens an empty store.

## Cardmarket ids, missing singles and prices

Battle Spirits Saga first (2026-10-16). Cardmarket publishes its catalog and
price guide as public files (no login; nezopt reaches the download host, the
website answers 403):

- `downloads.s3.cardmarket.com/productCatalog/productList/products_singles_20.json`
  (+ `products_nonsingles_20.json`): idProduct, name, idExpansion, idMetacard.
  No expansion names, no card numbers.
- `…/priceGuide/price_guide_20.json`: low, trend, 1/7/30-day averages, foil.
- TCGplayer category 72 via tcgcsv.com: printed numbers, treatment/pack tags in
  the names (`(SAGA)`, `(SPR)`, `(Box Topper)`, `(Judge Pack Vol. 1)`) and pictures.

`pokoin-cardmarket-catalog` (`pokoin-rust/apps/cardmarket-catalog`) does the
matching and the prices; the Python importer keeps writing catalog rows:

```bash
pokoin-cardmarket-catalog match                       # read-only: report + <cache>/raw/cardmarket-match.json
~/.venvs/pokoin-catalog/bin/python scripts/catalog/import_catalog.py battle_spirits_saga --images          # dry run
~/.venvs/pokoin-catalog/bin/python scripts/catalog/import_catalog.py battle_spirits_saga --images --apply
pokoin-cardmarket-catalog prices                      # dry run: coverage
pokoin-cardmarket-catalog prices --apply              # needs scripts/sql/126_cardmarket_price_guide.sql
```

- **Expansions**: `src/game.rs` maps each Cardmarket idExpansion to a Pokoin set
  (fixed by hand from the cards and sealed products filed under it). Promo
  expansions (Judge Packs, Event Packs 2023/2024, Promotion Packs, prerelease
  and collaboration packs) become sets of their own.
- **Matching**: Cardmarket names within an expansion pair with TCGplayer rows
  of the same name; the regular printing first, then parallels in the order
  TCGplayer added them (Cardmarket adds the regular printing first too).
  Collaboration rares (`Freedom Gundam - Rage Dragon Emperor Ira`) read as the
  card name. A name with no TCGplayer row in its own set takes the row released
  nearest in time (release clock from names both sites print once; at most
  12,000 TCGplayer ids away), e.g. the BSS01 box toppers in Aquatic Invaders.
  The TCGplayer number then finds our card. Official-site promo scans
  (`<number>_p`) pair only through `promo_pins` (a number is printed in several
  packs). Close spellings (dice ≥ 0.85–0.9) are listed as `fuzzy:` notes.
- **New rows**: Cardmarket singles with no catalog card become
  `cardmarket-productlist` rows (`cm-<idProduct>` keys) with the TCGplayer
  picture, number, rarity and pack tag (`version`). TCGplayer rows with
  `imageCount: 0` have no picture, so those rows stay unlisted until one exists.
- **Prices**: every price-guide build is kept in
  `public.cardmarket_price_guide_daily` (idProduct × day). Each card's display
  price in `marketplace_card_daily_median` is Cardmarket's trend, else the 7/30/1
  day sale averages (foil only when there is no regular price), × 200 PKN. The
  `low` column is an ask and is never shown as a price. Set desks pick it up at
  the next `build-lists --kind=set` run.
- **Daily**: `deploy/ops/nezopt-user/pokoin-cardmarket-prices.{service,timer}`
  (02:15 UTC; the guide is built around 00:45 UTC). Install the binary at
  `~/pokoin-cardmarket/current/` from an origin/main build.

Dry run 2026-10-16: 1,094 of 1,823 Cardmarket singles match catalog cards
(every card of 11 sets, 90.9–97.9% of the other 6; the 25 left are tokens,
core cards and misprint/corrected scans Cardmarket does not list), 532 new
rows with pictures, 197 without; 1,565 of the 1,651 listed cards get a price.

## Weiss Schwarz product links

Cardmarket sells only the **English** edition of Weiss Schwarz (idGame 10:
165 expansions, 28,140 singles). Japanese printings (47,727 of our 66,723)
have no Cardmarket product, so their CM button can only search. Product names
carry no card code, so `/api/cardmarket-redirect` searches the name alone for
this game (like Battle Spirits Saga).

`pokoin-cardmarket-catalog links` pairs EN printings with Cardmarket products
and writes exact product pages into `public.marketplace_cm_verified_links`,
which the redirect reads first:

```bash
sqlite3 -json ~/pokoin-catalogs/cardmarket-links.sqlite \
  "select cm_id id, url from products where game = 'weiss_schwarz'" > harvest.json
pokoin-cardmarket-catalog links --game weiss_schwarz --urls harvest.json            # dry run + report
pokoin-cardmarket-catalog links --game weiss_schwarz --urls harvest.json --apply    # harvested URLs only
```

- Expansion: each EN set (collector prefix `AYT/W110`) belongs to the
  idExpansion holding most of its names.
- Printing: same name in that expansion. A repeated name has a
  `-V<n>-<Rarity>` URL suffix; that rarity picks the printing (`N` premium
  cards are Cardmarket's Common). Most EN parallels (SR/SP/SSP/OFR/FR) are
  not in our catalog and stay unmatched.
- URL: only harvested product pages (the candyext dump) are exact. Generated
  slugs are accepted only where the expansion's own harvested pages confirm
  the style (≥ 20 pages, ≥ 98 %); 2014–2018 pages mix `V-1`/`V1` and bare
  suffixes inside one expansion, so none qualify today.

Dry run 2026-10-19: 3,035 of 18,996 EN printings get an exact page; 13,577
more pair with a Cardmarket product but sit in the 98 expansions whose
candyext listing came back empty (no URL), 867 are repeated names (booster vs
Trial Deck) with no harvested rarity, 354 have no product of that name, and
1,163 are in sets Cardmarket does not list.

### Japanese printings through their English twin

A Japanese printing shares the Cardmarket page of its English twin when both
show the same artwork, as Pokémon printings share links across artwork
versions. The English edition keeps the Japanese code with an `E` before the
number (`MM/W35-096` → `MM/W35-E096`, trial decks `T01` → `TE01`).

```bash
pokoin-cardmarket-catalog links --game weiss_schwarz --urls harvest.json --jp-twins             # dry run
pokoin-cardmarket-catalog links --game weiss_schwarz --urls harvest.json --jp-twins --apply-jp  # needs 130_printing_cm_links.sql
```

- Artwork: a 64-bit difference hash of the art area of both local scans
  (`~/pokoin-catalogs/weiss_schwarz/images/weiss-schwarz`), at most 18 bits
  apart. Checked by eye: same art stays within ~23 bits (SAMPLE stamp, crop,
  added logo); different art or a renumbered English card starts at 28.
- Parallels (`010S` SR, SP, SSP) would take the harvested `-V<n>-<Rarity>`
  product, but Pokoin has no English parallel scan to compare against, and
  none of the 89 candidates matches the English regular art within 8 bits, so
  none are linked.
- Rows go to `public.pokoin_printing_cm_links` (public card id → page; the
  redirect reads it first), not `marketplace_cm_verified_links`, whose URL is
  unique per printing.

Dry run 2026-10-19: 2,815 of 47,727 Japanese printings link through their
twin; 29,511 are in sets with no English edition, 13,338 have an English twin
without a Cardmarket page yet (the missing harvest above), 1,552 have no
English printing of that number, 467 are parallels, 8 have different art.
