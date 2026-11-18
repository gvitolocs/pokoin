# New set, end to end — every game

Written 2026-11-13 from the repository sources and the live public API on that
day. Nothing in this document was run with `--apply`, and no production data
was written. **Live data changes by the hour; every count, row and check result
below is a dated sample, not a promise.**

How to read it:

- **Mode** says what a command does: `read-only`, `dry run` (the tool's own
  default, nothing written) or `WRITES PRODUCTION` (an explicit apply flag or a
  service). Only flags found in the tool's source or `--help` are listed.
- **Host** is where it runs: `nezopt` (writer Postgres, GPU, NVMe leftover
  tree), `oracle` (`pokoin-marketplace`, the only CardTrader GET hop), `pi`
  (`pi-home`, public API and CDN origin), `any` (public GETs only).
- **Time**: the repository records almost no durations. Where it does, the
  figure is quoted with its source; everything else is **unmeasured**.
- **UNKNOWN** means the sources do not say. **Manual / unsupported** means no
  command exists; the line says what automation would need.
- The games are *not* one identical pipeline. Section 2 maps each game to one of
  three families; sections 4–6 are the procedures per family; section 7 lists
  what only Pokémon has.

Owning docs: [GAMES.md](GAMES.md) (topology, images, Pokémon new printing),
[MULTIGAME_REIMPORT.md](MULTIGAME_REIMPORT.md) (CardTrader satellites),
[CARDMARKET_GAMES.md](CARDMARKET_GAMES.md) (Cardmarket-only games),
[CARDTRADER_DAILY_DUMP.md](CARDTRADER_DAILY_DUMP.md) (nightly run, prices, sold),
[VERSIONS.md](VERSIONS.md), [STAMPS.md](STAMPS.md), [TCG_ERAS.md](TCG_ERAS.md),
[RUST_RUNTIME.md](RUST_RUNTIME.md).

## 1. What already happens without you

`pokoin-all-cardtrader-daily.timer` (nezopt, `OnCalendar=*-*-* 23:00:00 UTC`)
runs `scripts/run-all-cardtrader-daily.sh`. In order: preflight, `node
scripts/refresh-all-cardtrader-catalogues.cjs --apply` (new CardTrader
expansions and blueprints for every CardTrader game, projection into each game's
tables), `scripts/refresh-all-cardtrader-pictures.py` (scan GET on Oracle,
Pillow encode on nezopt, GPU lease), `scripts/sync-catalog-pictures.py` (only
that run's new `_homepage.webp` pairs to the Pi), `scripts/match-refreshed-pokemon-artwork.py`
(Pokémon CLIP version groups, CPU by default), the `cards` stage, the listing
dump, `pokoin-cardtrader-price-cache`, `pokoin-cardtrader-sold`. Stage results
are in `<run root>/` (`/home/nez/data/pokoin-catalog-refresh/daily/<UTC date>/`).
A set that CardTrader published today normally arrives that night; the manual
steps below are for getting it earlier, or for what the night does not do
(symbols, vocabulary, featured set, Cardmarket-only games). Whether a given
night's run completed is **UNKNOWN** from the repository: read the run root.

Nothing of the search stage is left: it fed Meilisearch, retired 2026-10-03
(`run-all-cardtrader-daily.sh` comment). Production Pokémon search is Redis
Search (`job search-delta`, every 2 min, `deploy/systemd/pokoin-rust-job-search-delta.timer`).

## 2. The games

25 games: `market/src/game.js` `GAMES`, `INGEST_GAMES` in
`pokoin-rust/crates/api-common/src/game.rs`, `GAMES` in `scripts/check-new-set.py`
(a unit test compares the checker's table with `game.js`). The API picks the
game from `?game=` (then `x-pokoin-game`, then host). Pokémon has no prefix.

Public card id = id × 2 for every game (`ct_id × 2` for CardTrader games,
`id × 2` of the synthetic id for Cardmarket-only games, which start at
`100_000_000`). CDN key = `{prefix}{id}_{name-slug}.jpg` and
`…_homepage.webp`, `id` being the **un**doubled id; Pokémon has no prefix. The
API may return a public-id key for Pokémon rows (Delta Reign, 2026-11-13); the
SPA and the CDN map it back (GAMES.md).

| `game` | Path | Family | Database | CardTrader game id | CDN prefix | Search | Sets listed 2026-11-13 |
| --- | --- | --- | --- | ---: | --- | --- | ---: |
| `pokemon` | `/` | A | `pokoin_marketplace` | 5 | *(none)* | Redis Search `pokoin:card:` + Postgres | not sampled |
| `one_piece` | `/one-piece` | B | `pokoin_one_piece` | 15 | `one-piece/` | Postgres | 95 |
| `riftbound` | `/riftbound` | B | `pokoin_riftbound` | 22 | `riftbound/` | Postgres | 13 |
| `magic` | `/magic` | B | `pokoin_magic` | 1 | `magic/` | Postgres | 775 |
| `yugioh` | `/yugioh` | B | `pokoin_yugioh` | 4 | `yugioh/` | Postgres | 622 |
| `lorcana` | `/lorcana` | B | `pokoin_lorcana` | 18 | `lorcana/` | Postgres | 29 |
| `flesh_and_blood` | `/flesh-and-blood` | B | `pokoin_flesh_and_blood` | 6 | `flesh-and-blood/` | Postgres | 130 |
| `digimon` | `/digimon` | B | `pokoin_digimon` | 8 | `digimon/` | Postgres | 121 |
| `dragon_ball_super` | `/dragon-ball-super` | B | `pokoin_dragon_ball_super` | 9 | `dragon-ball-super/` | Postgres | 167 |
| `vanguard` | `/vanguard` | B | `pokoin_vanguard` | 10 | `vanguard/` | Postgres | 278 |
| `star_wars` | `/star-wars` | B | `pokoin_star_wars` | 20 | `star-wars/` | Postgres | 35 |
| `union_arena` | `/union-arena` | B | `pokoin_union_arena` | 21 | `union-arena/` | Postgres | 87 |
| `gundam` | `/gundam` | B | `pokoin_gundam` | 23 | `gundam/` | Postgres | 35 |
| `sorcery` | `/sorcery` | B | `pokoin_sorcery` | 24 | `sorcery/` | Postgres | 9 |
| `palworld` | `/palworld` | B | `pokoin_palworld` | 26 | `palworld/` | Postgres | 7 |
| `cyberpunk` | `/cyberpunk` | B | `pokoin_cyberpunk` | 27 | `cyberpunk/` | Postgres | 11 |
| `final_fantasy` | `/final-fantasy` | C | `pokoin_final_fantasy` | — | `final-fantasy/` | Postgres | 33 |
| `star_wars_destiny` | `/star-wars-destiny` | C | `pokoin_star_wars_destiny` | — | `star-wars-destiny/` | Postgres | 24 |
| `weiss_schwarz` | `/weiss-schwarz` | C | `pokoin_weiss_schwarz` | — | `weiss-schwarz/` | Postgres | 582 |
| `force_of_will` | `/force-of-will` | C | `pokoin_force_of_will` | — | `force-of-will/` | Postgres | 57 |
| `world_of_warcraft` | `/world-of-warcraft` | C | `pokoin_world_of_warcraft` | — | `world-of-warcraft/` | Postgres | 127 |
| `battle_spirits_saga` | `/battle-spirits-saga` | C | `pokoin_battle_spirits_saga` | — | `battle-spirits-saga/` | Postgres | 24 |
| `dragon_born` | `/dragon-born` | C | `pokoin_dragon_born` | — | `dragon-born/` | Postgres | 5 |
| `my_little_pony` | `/my-little-pony` | C | `pokoin_my_little_pony` | — | `my-little-pony/` | Postgres | 15 |
| `the_spoils` | `/the-spoils` | C | `pokoin_the_spoils` | — | `the-spoils/` | Postgres | 11 |

- **A** = Pokémon. **B** = CardTrader satellite (blueprints are CardTrader's;
  raw table `marketplace_<game>.cardtrader_blueprints`). **C** = Cardmarket-only
  (raw table `marketplace_<game>.cardmarket_products`; catalog from a public
  source below).
- "Search: Postgres" is from GAMES.md ("Postgres-only multigame SQL") and
  MULTIGAME_REIMPORT.md ("Meili Pokémon-only"). Verified in source: the Redis
  index job `search-delta` reads one pool (`jobs/search.rs` `read_pool()`, no game
  argument) and joins `pokoin_pokemon_expansions`, so it indexes the Pokémon
  catalog only. Meilisearch is retired (above), so ignore "Meili" in older docs.
  I did not read the satellite suggest SQL end to end; the live behaviour is
  that `marketplace-suggest?game=<g>` answers with groups (section 8).
- Databases are on the nezopt writer and stream to the Pi replica; the public
  API only reads the replica.
- Palworld and Cyberpunk: MULTIGAME_REIMPORT.md says only "wired in SPA +
  ingest targets"; the index above shows sets, so they carry data. How and when
  they were imported is **UNKNOWN**.
- Cardmarket-only catalog sources (CARDMARKET_GAMES.md; ids and Cardmarket
  product ids come from the importer, not from a feed):

| `game` | Catalog source | Images |
| --- | --- | --- |
| `final_fantasy` | Square Enix card browser JSON (`fftcg.square-enix-games.com/en/get-cards`) | largest published (429×600) |
| `star_wars_destiny` | `db.swdrenewedhope.com/api/public/cards/` | 298×418 |
| `weiss_schwarz` | `CCondeluci/WeissSchwarz-ENG-DB` + `-JP-DB`; official ws-tcg.com art, EncoreDecks only where the official URL 404s | 350×489 |
| `force_of_will` | FoWDB set listings | 480×670 |
| `world_of_warcraft` | wowcards.info edition tables and scans | 312×440 |
| `battle_spirits_saga` | official battlespirits-saga.com database, plus Cardmarket productList + TCGplayer category 72 (`pokoin-cardmarket-catalog`) | 600×838 |
| `dragon_born` | dragoborne.fandom.com MediaWiki API (needs the wiki Referer) | 480×670 |
| `my_little_pony` | data.mlpmerch.com CCG database | full-size originals |
| `the_spoils` | the-spoils-cardgame.vercel.app (Cloudinary) | 500×700 |

## 3. Facts every game shares

- **Writes happen only on nezopt** (writer Postgres `127.0.0.1:25432`, container
  `pokoin-marketplace-postgres-15t`; host port `:25432`). Never write the Pi
  replica. Never R2 as the image origin. Never Pillow on the Pi.
- **CardTrader GET only on Oracle** (`ssh pokoin-marketplace`, `130.61.251.250`).
  `pokoin-peer1` gets a Cloudflare 403; the nezopt home IP is rate-limited.
  Keep fetch concurrency ≤ 8 per runner (48 tripped a Cloudflare challenge on
  2026-09-18, MULTIGAME_REIMPORT.md). Cardmarket-only games do not use
  CardTrader at all.
- **Images**: JPEG master + `_homepage.webp` thumbnail on the nezopt NVMe tree
  `/home/nez/data/pokoin-leftovers/objects/{prefix}`; the Pi serves
  `cdn.pokoin.com` from `/srv/pokoin/card-images/objects`. Pokémon thumbnails
  are **480 px** wide (`market/src/data/catalog-image-cache.json` `thumbToken`
  `t480`; `HOME_FIRST_PAINT.md`). Other games are not 480: a One Piece thumbnail
  on 2026-11-13 is 416×580, and the Cardmarket-only importer writes **240 px**
  thumbnails (CARDMARKET_GAMES.md). Do not assume a width outside Pokémon.
  The hourly Pi replica timer in GAMES.md is **not installed** for satellite
  prefixes (MULTIGAME_REIMPORT.md, scan ingest); the push is manual per prefix
  unless the CDN proxies a miss to nezopt (Wave 4, same doc). Which of the two
  serves a given prefix today is **UNKNOWN**.
- **Page caches**: set desks are rebuilt every 15 minutes (`build-lists-sets`
  CronJob, RUST_RUNTIME.md) and cached `s-maxage=600`; expect up to roughly
  25 minutes before a newly imported set shows on `marketplace-expansion-page`.
  That figure is the sum of the two documented intervals, not a measurement.
- **Language / print nationality**: Pokémon has `pokoin_pokemon_expansions.nationality`
  (`western|japanese|chinese|korean|unknown`), set by
  `select public.pokoin_refresh_expansion_nationality()` during the nightly
  catalogue refresh and by `scripts/export-expansion-nationality.mjs`
  (derives `market/src/data/expansion-nationality.js` from `suggest-sets.js`).
  Satellite and Cardmarket-only games have `public.pokoin_expansions.nationality`
  only where `multigame-set-lang-runbook.md` (CardVault) was applied; that runbook
  is "PREP ONLY" and needs the Mac Gemma tunnel (UNKNOWN whether ever run); the
  API returns `nationality: ""` for the satellite sets sampled on 2026-11-13.
  CardTrader `*_language` properties are listing enums, not print language.

## 4. Family A — Pokémon (`game=pokemon`)

Order matters; the numbering follows the owning docs (GAMES.md "New CardTrader
printing", `oracle-marketplace-postgres-workflow.md` "CardTrader Delta Catalog
Import" in CardVault). Where those two disagree on the writer (GAMES.md: nezopt
NVMe `:25432`; the workflow: Oracle raw table through a `:15432` tunnel) this
document follows GAMES.md, which carries the 2026-09-12/14 topology; the
workflow wording is older. Confirm before the first apply.

CardVault sources are under `~/Projects/Startup/Pokoin/cardvault/pokemon_card_vault`
(`cd` there for the Node scripts).

1. **Discovery** — which CardTrader expansion/blueprints are new.
   - Automatic: the 23:00 UTC nightly (section 1).
   - By hand, `nezopt`, **dry run** (the importer's default; `--apply` writes):
     `node scripts/cardtrader-delta-import.js --expansion-names="Delta Reign" --limit=all --sleep-ms=100`
     (`--expansion-ids=` works the same). Read `counts.fetched`, `counts.existingRaw`,
     `counts.missingRaw`, `missingSamples`, `existingRawMissingSearchCandidate`.
     Use the exact name so `30th Celebration JP` does not match `30th Celebration`.
     Needs the writer URL in the environment; do not print it. Time: unmeasured.
2. **Blueprints (raw)** — `WRITES PRODUCTION`: same command with `--apply` and
   no `--images`, `--refresh` or `--sync-supabase`. Decision D000003.
3. **Projection** — manual: targeted `INSERT … ON CONFLICT DO NOTHING` into
   `marketplace_cards`, `marketplace_search_candidates`, `marketplace_card_versions`,
   `marketplace_card_urls` for the new `ct_id`s, then
   `refresh_marketplace_set_catalog_counts()` (`WRITES PRODUCTION`). No script
   does this one set at a time; the nightly `refresh-all-cardtrader-catalogues.cjs`
   projects every game's new rows through the database's projection functions. Automation of the
   targeted insert would need a script that takes `--expansion` and prints the
   rows first. Never `--refresh` the full projection live (it `ALTER TABLE`s and
   exclusive-locks `marketplace_cards`).
4. **Images and 480 px thumbnails** — `nezopt`:
   `POKOIN_INGEST_EXPANSION='Delta Reign' /home/nez/Projects/ai-toolkit/venv/bin/python scripts/ingest-missing-product-images.py`
   (also `POKOIN_INGEST_IDS=…`, `POKOIN_INGEST_ID_FILE=…`,
   `POKOIN_INGEST_PLACEHOLDERS=1`). The script has **no dry-run flag** in its
   source: it writes JPEG + `_homepage.webp` (width `HOMEPAGE_IMAGE_REFERENCE_WIDTH`,
   default 480) to the NVMe tree, fetches scans through Oracle, rsyncs to the
   Pi objects, sets `cdn_image_url`, and runs the CLIP match for that expansion
   unless `POKOIN_SKIP_VERSION_MATCH=1` (`WRITES PRODUCTION`). Never hotlink
   CardTrader. Without this the desk shows the missing-card image.
   Nightly equivalent: `refresh-all-cardtrader-pictures.py` + `sync-catalog-pictures.py`.
   Time: unmeasured.
5. **Artwork matching (version groups)** — `nezopt`, GPU (7900 XTX):
   `scripts/match-imported-version-sets.sh --expansion "Delta Reign"` (or `--ids <ct_id>`),
   passes `--refresh-candidates` plus whatever you add. `--dry-run` is accepted
   (the script skips its SQL step on it). Applies on the nezopt writer, then
   `marketplace_join_reverse_pattern_versions(true)` (`WRITES PRODUCTION`
   without `--dry-run`). Review singleton groups afterwards ([VERSIONS.md](VERSIONS.md)).
   Only Pokémon has CLIP version groups.
6. **Languages / nationality** — runs inside the nightly catalogue refresh
   (`pokoin_refresh_expansion_nationality()`); a new expansion starts as
   `unknown` until then. Manual: same SQL function on the writer
   (`WRITES PRODUCTION`). Release languages table:
   `node scripts/import-set-release-languages.js` (writes a repo JSON; `--apply`
   with `MARKETPLACE_WRITER_DATABASE_URL` writes the DB). Catalog title languages:
   `scripts/import-catalog-languages.js` (flags not read here: **UNKNOWN**).
7. **Symbols**
   - Normal set: the CDN must serve `expansions/symbols/{slug}.png`. Missing ones
     are generated as dark code plates by
     `scripts/export-expansion-code-marks.py` (`--apply` writes to the Pi and
     replica; without it, staging only). Real marks: `scripts/publish-expansion-symbols.sh`
     (`--init` proposes `tools/expansion-symbols/symbols.tsv`; no flag draws only;
     `--apply` copies to both CDN origins, backs up replaced PNGs, needs a new
     `SYMBOL_CACHE` in `market/src/set-logos.js`). Wordmarks:
     `scripts/import-serebii-expansion-logos.py`. A PNG that returns 200 can still
     be a generated text plate: **look at it**.
   - **Play! Pokémon Prize Pack series** (slug `play-pokemon-prize-pack-series…`):
     the symbol is *not* on the CDN. It is the bundled static file
     `market/public/expansion-symbols/play-pokemon-prize-pack.png`
     (128×128 RGBA, added in commit `e4d0a0ee`), chosen in
     `market/src/set-logos.js` `expansionSymbolSources()` and ordered by
     `solid/src/components/ExpansionMark.jsx`. It ships with the web build
     (`scripts/build-web.sh`, `scripts/deploy-web.sh`), so a new Prize Pack
     series needs **no symbol step**. Cutting a new mark out of an official scan
     is **manual**: no script for it exists in the repository and the commit
     does not record how the PNG was cut (UNKNOWN). Automation would need a
     documented crop box per scan, an output size and a place in `tools/`.
   - Deck-mascot stamps are a separate system: [STAMPS.md](STAMPS.md),
     `scripts/publish-expansion-stamps.sh [--apply]`.
8. **Search and vocabulary**
   - Redis index: `job search-delta` (Pi, every 2 min) picks up rows by
     `projected_at/imported_at`. Check with the checker (search index). Full
     rebuild: `job search-reindex` by hand on the Pi (RUST_RUNTIME.md; flags
     **UNKNOWN**).
   - Bundled vocabulary (client-side typeahead): `python3 scripts/export-suggest-names.py`
     and `python3 scripts/export-suggest-catalog.py` read the catalog through
     `docker exec pokoin-marketplace-postgres-15t` on nezopt and **rewrite repository
     files** (`market/src/data/suggest-names.js`, `suggest-artists.js`,
     `suggest-sets.js`); then `node scripts/export-expansion-nationality.mjs`.
     These need a web build and deploy to reach users. They have no dry-run flag.
9. **Prices** — nothing to do per set. CardTrader listing books →
   `pokoin-cardtrader-price-cache` (cheapest PKN per blueprint, facets: seller
   Zero/1-day-ready eligibility, quantity, EUR→PKN at `PKN_CHECKOUT_USDT_PRICE`,
   default 0.005) and the Pokémon sold graph run in the nightly (23:00 UTC).
   `--dry-run` and `--game pokemon` exist on the price cache
   (CARDTRADER_DAILY_DUMP.md "Prices"). Condition/language/foil facets of sold
   stacks: MARKET.md. A set with no listing on CardTrader has no price: the checker
   does not test prices.
10. **Featured selection** — Pokémon only.
    - Override file `market/src/data/featured-set.json`
      (`{"newCardsSet": "Delta Reign", "aliases": [...], "updated": "…"}`),
      read by `scripts/sync-marketplace-rails.py` (`NEW_CARDS_SET`) and by the SPA.
    - The rail itself is *persisted* by `sync-marketplace-rails.py` (nezopt
      timer, every 5 min after boot, `scripts/marketplace-rails-sync.timer`).
      The timer runs a **copy** of the script and of `featured-set.json`
      installed on nezopt: `scripts/install-marketplace-rails-sync.sh [host]`
      (`WRITES PRODUCTION`; copies files and enables the timer). Merging the
      JSON into `main` alone does not change the rail.
    - Release-date ordering of "newest" is reviewed by hand (the checker says so).
11. **Web deploy** — the vocabulary files, `featured-set.json`, the bundled Prize
    Pack symbol and `catalog-image-cache.json` are repository files:
    `scripts/deploy-web.sh` against the pushed `origin/main` commit, only when
    explicitly instructed ([DEPLOY.md](DEPLOY.md), AGENTS.md).
12. **Verify** — section 8, then the visual checks the tool cannot do (symbol,
    artwork of the version groups, every image of the set).

## 5. Family B — CardTrader satellites (15 games)

Same hosts and rules as Pokémon, **different tables, projections and no
Pokémon extras**. One database per game. Every command takes the game, so the
procedure is written once.

1. **Discovery**
   - Nightly catalogue refresh (section 1) covers all CardTrader games.
   - By hand: `node scripts/cardtrader-multigame-import.js --game=<id> --discover-only`
     (lists CardTrader expansions; default mode is dry-run). Per-game ingest API
     on Oracle, `127.0.0.1:18082`: `GET /api/ingest/<slug>` is readable with
     `ssh pokoin-marketplace 'curl -sS http://127.0.0.1:18082/api/ingest/<slug>'`;
     `POST` needs `CARDTRADER_INGEST_SECRET` (a secret, not recorded here) and
     `{"discoverOnly":true}`.
   - Game ids and URL env names: section 2 and `INGEST_GAMES`
     (`<GAME>_MARKETPLACE_DATABASE_URL`). Values: not in this repo.
2. **Blueprints** — `node scripts/cardtrader-multigame-import.js --game=<id> --expansion-ids=<ct expansion id> --limit=all`
   is a **dry run**; `--apply` (`WRITES PRODUCTION`) with `--ensure-schema` the first
   time. `--apply` must be bounded by `--expansion-ids` or `--stream-all`.
   Do **not** pass `--images` (it uploads to R2) and do not `--refresh` Pokémon
   projections. The ingest API needs `"limit":"all"` or it stops at 500 rows
   (MULTIGAME_REIMPORT.md). Time: unmeasured per expansion; the 2026-09-18 full
   import of all games is not timed in the docs.
3. **Projection** — `select public.refresh_multigame_marketplace_projections(...)`
   on that game's database (arguments **UNKNOWN**; read
   `oracle-postgres/schema/026_multigame_marketplace_projections.sql`), then
   `refresh_marketplace_set_catalog_counts()`. The nightly refresh does this for
   every game. `WRITES PRODUCTION`.
4. **Images and thumbnails** — `nezopt`, ai-toolkit venv:
   `POKOIN_SCAN_GAMES=<id> python3 scripts/satellite-scan-ingest.py` (no dry-run
   flag; resumable; env in its docstring: `POKOIN_SCAN_WORKERS` ≤ 8,
   `POKOIN_SCAN_CHUNK`, `POKOIN_SCAN_ROTATE=1`). Writes JPEG +
   `_homepage.webp` under `objects/<prefix>`, stamps `cdn_image_url` on the
   writer (`WRITES PRODUCTION`). Then push the prefix to the Pi (manual rsync per
   prefix; see section 3). Thumbnail width is not 480 for these games.
   Nightly equivalent: `refresh-all-cardtrader-pictures.py` (small real scans of
   ≥ 240 px beat the placeholder).
5. **Matching** — name-based version groups come from the projection; **no CLIP**
   ("do not CLIP Magic/Yu-Gi-Oh unless asked"). The checker verifies the sampled
   card is in its `name:<card>` group.
6. **Languages / nationality** — manual and unsupported in practice: see
   section 3. Automation would need the CardVault set-language runbook run
   (Gemma OCR) per game, or a CardTrader-derived rule; neither is wired.
7. **Symbols** — **none.** The API returns empty `symbolImageUrl`; the SPA
   falls back to `/card-images/<slug>/expansions/symbols/<set>.png` and then the
   letter mark. Wordmark logos may exist (Battle Spirits Saga returned a
   `logoImageUrl`). No satellite symbol script exists. The Play! Pokémon scan
   cutting above is Pokémon-only.
8. **Search and vocabulary** — Postgres, nothing to refresh. The bundled vocabulary
   exporters are Pokémon-only. The checker's suggest steps use the live API.
9. **Prices** — nightly `pokoin-cardtrader-price-cache` (all games, `--game <slug>`
   limits, `--dry-run` available) and `pokoin-cardtrader-sold` (sold graph of every
   game except Pokémon). Same eligibility facets as Pokémon.
10. **Featured selection** — **not applicable.** `featured-set.json` and the New
    cards rail are Pokémon-only: `GET /api/marketplace-home/new-cards?game=one_piece`
    returned the Pokémon rail on 2026-11-13. Satellite homes use
    `marketplace-home-page?game=<id>` newest rows, which need nothing.
11. **Verify** — section 8 with `--game <id>`.

## 6. Family C — Cardmarket-only (9 games)

No CardTrader, so no nightly discovery: a new set exists only after somebody
re-runs the importer for that game.

1. **Discovery** — manual. The source column in section 2 is the feed; there is
   no discovery command. `~/.venvs/pokoin-catalog/bin/python scripts/catalog/import_catalog.py <game>`
   without flags is a **dry run** (usage: `--apply --images --keep-wayback --limit
   --concurrency`, games: the nine above).
2. **Catalog rows** — `import_catalog.py <game> --images --apply`
   (`WRITES PRODUCTION`): sequential ids from `100_000_000` per source key (public
   id must stay below 999,000,000), upsert into `marketplace_<game>.cardmarket_products`,
   remove stale candidates, `refresh_cardmarket_marketplace_projections()` and
   `refresh_marketplace_set_catalog_counts()`. Needs `scripts/sql/098_cardmarket_game_catalog_support.sql`.
   `cardmarket-multigame-import.js` (CardVault) is a CardVault importer with
   `--discover-only`, `--dry-run`, `--apply`, `--cardmarket-game-id`; its role for new sets is UNKNOWN (CARDMARKET_GAMES.md describes it as the source of the first, Wayback-based rows).
3. **Cardmarket ids** — `pokoin-cardmarket-catalog match` (read-only; writes
   `<cache>/raw/cardmarket-match.json`) before the import so rows get
   `card_market_ids`. Documented for Battle Spirits Saga first; whether it covers
   other games is **UNKNOWN**. Expansion mapping is a hand-fixed table in
   `pokoin-rust/apps/cardmarket-catalog/src/game.rs`.
4. **Images and thumbnails** — `--images` on the same command: ≤ 1050 px tall JPEG q90
   plus a 240 px `_homepage.webp`, rsynced to the Pi `objects/<prefix>/`.
5. **Matching** — name groups only. Weiss Schwarz English/Japanese pairing
   for Cardmarket links: `pokoin-cardmarket-catalog links …` (`--apply`,
   `--jp-twins`, `--apply-jp`; CARDMARKET_GAMES.md has the exact commands).
6. **Languages** — Weiss Schwarz carries EN and JP printings in one catalog;
   a `nationality` value is not populated (API `""`). Everything else:
   manual/unsupported as in family B.
7. **Symbols** — none, as family B.
8. **Search** — Postgres, nothing to refresh.
9. **Prices** — Cardmarket, not CardTrader: `pokoin-cardmarket-catalog prices`
   (dry run, reports coverage) and `prices --apply` (needs
   `scripts/sql/126_cardmarket_price_guide.sql`), timer
   `pokoin-cardmarket-prices.timer` at 02:15 UTC, installed binary
   `~/pokoin-cardmarket/current/`. Price = Cardmarket trend, else 7/30/1-day
   averages, × 200 PKN; `low` is never shown. Set desks show it at the next
   `build-lists --kind=set` (15 min). Only Battle Spirits Saga is documented
   as run (2026-10-16); the other eight: **UNKNOWN**.
10. **Featured selection** — not applicable (as family B).
11. **Going live for a new *game*** (not a new set): Rust registry
    (`game.rs`, `catalog-api/src/shared/row.rs`), `market/src/game.js`,
    `vercel.json`, `image-urls.js`, worker and CDN prefix lists; shipped with
    `scripts/deploy-pokoin-rust.sh` and `scripts/deploy-web.sh`. Also update
    `GAMES` in `scripts/check-new-set.py` (the unit test fails until you do).
12. **Verify** — section 8 with `--game <id>`.

## 7. What only Pokémon has

| Capability | Pokémon | Every other game |
| --- | --- | --- |
| Redis Search `pokoin:card:` (`search-delta`) | yes | no (Postgres) |
| Bundled typeahead vocabulary (`suggest-names/-artists/-sets.js`, exporters) | yes | no |
| CLIP artwork version groups (`pokoin_version_sets`, `match-imported-version-sets.sh`) | yes | name-based groups only |
| `featured-set.json` and the New cards rail (`sync-marketplace-rails.py`) | yes | no |
| Expansion symbols / wordmarks / stamps, Play! Prize Pack bundled mark | yes | none (letter mark) |
| `pokoin_pokemon_expansions.nationality` refreshed nightly | yes | empty in the API |
| 480 px thumbnails | yes (2026-10-20 rebuild) | no (416 and 240 seen/documented) |
| Sold graph writer | Oracle job | `pokoin-cardtrader-sold` (CardTrader games) |
| Era headings, print flags, artists | yes | no |

## 8. Verification — `scripts/check-new-set.sh`

Read-only; public GETs plus reads of three repository files
(`market/src/data/suggest-sets.js`, `featured-set.json`,
`market/public/expansion-symbols/play-pokemon-prize-pack.png`). Host: any.

```bash
TMPDIR="$HOME/scratch/tmp" scripts/check-new-set.sh "Delta Reign"                         # Pokémon, default
TMPDIR="$HOME/scratch/tmp" scripts/check-new-set.sh --game one_piece "EB-05: Heroines Edition Vol.2"
TMPDIR="$HOME/scratch/tmp" python3 -B scripts/check-new-set.test.py                        # unit tests, no network
```

`--game` takes the id or the path slug (`one-piece`). Output lines:

- `OK` — the step passed on the sample.
- `MISSING` — the step failed, errored, or could not be verified (HTTP error,
  timeout, bad JSON, wrong prefix). The exit status is 1. A failed public request
  is printed with its HTTP code and body, never dropped.
- `SKIPPED: <step>: <reason>` — the step does not exist for that game. Skips
  never change the exit status; the reason is the evidence.
- Exit 2: unknown `--game`, nothing was requested.

What each step does, and for which game:

| Step | What it checks | Pokémon | Other games |
| --- | --- | --- | --- |
| catalog | expansion page by slug, exact name, ≥ 1 card; other games find the slug in the set index first (an unknown slug is an HTTP 500 there) | yes | yes |
| singles | cards with `itemKind=single` and `productType=card` | yes | yes |
| image key | key starts with `{prefix}{id/2}_` (Pokémon also accepts the public id) | yes | yes |
| image | one single's JPEG answers 200 `image/*` | yes | yes |
| thumbnail | `_homepage.webp` answers and is WebP; width asserted = 480 | yes | WebP only, width reported |
| version set | Pokémon: group id present; others: sample is a member of its name group | yes | yes |
| search index | sample found by its card name in suggest | yes | yes |
| set-name suggest | bare set name returns ≥ 1 sampled single (the API ranks sealed products first, so a fresh set can fail here while the name search passes) | yes | yes |
| local suggest set catalog | slug in `suggest-sets.js` | yes | SKIPPED |
| symbol | CDN PNG answers; Prize Pack series: bundled file exists; others: 404 → SKIPPED, other errors MISSING | yes | yes |
| featured set override, new-cards rail | `featured-set.json` names the set; every card of the rail is in it | yes | SKIPPED |

Limits: it samples one card; it cannot see the 25-minute page cache, GPU or
nightly state, release-date order, whether a symbol is a text plate, or whether
version groups are right. `all OK` is therefore **necessary, not sufficient**;
the closing `UNVERIFIED` line stays. Do not edit the output to make a set look
ready.

## 9. Recorded runs (2026-11-13, nezopt, 22:16 UTC)

Unedited outputs from the day this document was written. They are evidence of
the tool, not of any set's state later. Delta Reign ends in `MISSING` and exit 1
on purpose: it is **not ready**, and the output was not altered.

```text
Fri Nov 13 22:16:21 UTC 2026
$ scripts/check-new-set.sh "Delta Reign"
game: pokemon (pokemon); set: Delta Reign
OK: catalog: 144 cards reported, slug delta-reign
OK: singles: 144 singles of 144 sampled (itemKind=single, productType=card)
OK: image key matches card id: /card-images/842726_giratina.jpg: expects 421363_… or 842726_… for public id 842726
OK: image (one sample): https://cdn.pokoin.com/842726_giratina.jpg
OK: thumbnail (one sample): https://cdn.pokoin.com/842726_giratina_homepage.webp: 480 px wide, 480 expected
OK: version set (one sample): 842726: v806118; singleton matches require review
OK: search index (one sample): 842726 by card name
MISSING: set-name suggest: 20 printings returned, 0 singles, 0 of the sampled singles; the API ranks sealed products first for a bare set name
OK: local suggest set catalog: delta-reign
OK: symbol HTTP: https://cdn.pokoin.com/expansions/symbols/delta-reign.png; inspect visually for text plates
OK: featured set override: Delta Reign; release-date ordering requires manual review
MISSING: new-cards rail: Storm Emeralda
UNVERIFIED: samples do not prove all images, artwork matches, or release-date ordering; review them separately.
exit=1
```

```text
Fri Nov 13 22:16:22 UTC 2026
$ scripts/check-new-set.sh --game one_piece "EB-05: Heroines Edition Vol.2"
game: one_piece (cardtrader); set: EB-05: Heroines Edition Vol.2
OK: catalog (set index): 95 sets listed; found
OK: catalog: 96 cards reported, slug eb-05-heroines-edition-vol-2
OK: singles: 96 singles of 96 sampled (itemKind=single, productType=card)
OK: image key matches card id: /card-images/one-piece/419066_nojiko.jpg: expects one-piece/419066_… for public id 838132
OK: image (one sample): https://cdn.pokoin.com/one-piece/419066_nojiko.jpg
OK: thumbnail (one sample): https://cdn.pokoin.com/one-piece/419066_nojiko_homepage.webp: 416 px wide (width not asserted: only Pokémon has a 480 px contract)
OK: version set (name groups): 838132: name:nojiko, 7 printings; CLIP artwork groups are Pokémon-only
OK: search index (one sample): 838132 by card name
OK: set-name suggest: 78 printings returned, 78 singles, 56 of the sampled singles
SKIPPED: local suggest set catalog: market/src/data/suggest-sets.js is the Pokémon typeahead vocabulary; other games search Postgres
SKIPPED: symbol: no satellite symbol pipeline; the API returns none and https://cdn.pokoin.com/one-piece/expansions/symbols/eb-05-heroines-edition-vol-2.png is 404, so the SPA paints the letter mark
SKIPPED: featured set override: featured-set.json and the New cards rail are Pokémon-only (the rail ignores ?game=)
SKIPPED: new-cards rail: Pokémon-only; satellite homes use marketplace-home-page newest rows
UNVERIFIED: samples do not prove all images, artwork matches, or release-date ordering; review them separately.
exit=0
```

Reading them:

- **Delta Reign (Pokémon), not ready — two failures, both known:**
  - `MISSING: new-cards rail` is the **pre-deployment** gap: `featured-set.json`
    (`updated: 2026-11-13`) names Delta Reign, the persisted rail still holds
    Storm Emeralda until `install-marketplace-rails-sync.sh` copies the new file to
    nezopt and the 5-minute timer runs (step 10 of family A). Not a bug.
  - `MISSING: set-name suggest`: the 20 results for "Delta Reign" were all
    sealed products (Delta Reign Dice Set, Divider, Booster, Sleeved Booster, …);
    none of the 144 singles. The search by card name finds the sample, so the
    cards are indexed. Whether this is a ranking behaviour of the API or a gap
    the SPA hides through its client-side set peel is **UNKNOWN** (not
    reproduced in a browser). The check keeps failing it because it was a
    check before this change too.
- **One Piece, EB-05 Heroines Edition Vol.2: every applicable step OK, the five
  inapplicable steps SKIPPED, exit 0.** That is the checker's verdict on one
  sampled single, nothing more. "Newest": EB-05 supplies 17 of the cards in the
  newest rail of `marketplace-home-page?game=one_piece` (the first has `ct_id`
  421163). The API gives no release date for satellite sets, so this is "newest
  imported", not "newest released".
- **A transient CDN fault was seen and is why the checker never calls a failed
  request OK.** The first runs at 22:11–22:13 UTC printed
  `MISSING: thumbnail (one sample): HTTP 502 error code: 502` for Delta Reign and
  `MISSING` image, thumbnail and symbol probe (HTTP 502) for One Piece; `curl` saw
  502 from `cdn.pokoin.com` on old keys too (`one-piece/301338_burn-bazooka.jpg`,
  an old Pokémon thumbnail) while `842726_giratina.jpg` answered 206. Three
  minutes later every one of those answered, with `healthz` 200 throughout. Cause:
  **UNKNOWN** (a CDN/origin fault, not an import bug). Re-run before believing a
  502 or a pass.
- The check's own failures are of three kinds: the set is not ready (rail),
  a fault between you and the CDN (502), and a checker/API disagreement
  (set-name suggest). Read the line, not just the exit code.

## 10. Not known / not done

- Writer location wording conflict (GAMES.md vs the CardVault workflow, step 1 of
  family A) — resolve before the first apply.
- How `search-delta` treats a set whose cards have no `projected_at`:
  not read.
- Whether the satellite thumbnail path is served by the Pi copy or by the nezopt
  proxy, and why `cdn.pokoin.com` answered 502 for about two minutes on 2026-11-13.
- Satellite and Cardmarket-only language/nationality: no wired process.
- Cutting a Play! Pokémon mark from an official scan: no script, no recorded method.
- No durations are recorded for any manual step above.
