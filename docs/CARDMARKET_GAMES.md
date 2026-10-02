# Cardmarket-only games

Nine games sold on Cardmarket that CardTrader does not cover. Each has its own
database on the nezopt writer (`pokoin_<game>`, streamed to the Pi replica like
every satellite game), raw table `marketplace_<game>.cardmarket_products`, and
CDN prefix `<slug>/` under `/srv/pokoin/card-images/objects/` on the Pi.

| Game | `game` | Path | Catalog source | Cards | Live |
| --- | --- | --- | --- | --- | --- |
| Final Fantasy TCG | `final_fantasy` | `/final-fantasy` | Square Enix card browser JSON (`fftcg.square-enix-games.com/en/get-cards`) | 4,260 | yes |
| Star Wars Destiny | `star_wars_destiny` | `/star-wars-destiny` | SWD Renewed Hope public API (`db.swdrenewedhope.com/api/public/cards/`) | 2,883 | yes |
| Weiss Schwarz | `weiss_schwarz` | `/weiss-schwarz` | `CCondeluci/WeissSchwarz-ENG-DB` + `-JP-DB` (official ws-tcg.com art, EncoreDecks for gaps) | 66,723 EN+JP | images importing |
| Force of Will | `force_of_will` | `/force-of-will` | FoWDB (scrape) | — | pending |
| World of Warcraft TCG | `world_of_warcraft` | `/world-of-warcraft` | WoW TCG Reborn scans | — | pending |
| Battle Spirits Saga | `battle_spirits_saga` | `/battle-spirits-saga` | official card database | — | pending |
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
2. Registry: the game is in `server/pokoin-api/_cardtrader_game_ingest.js`
   (`source: 'cardmarket'`, `table: 'cardmarket_products'`) and its prefix in
   `_marketplace_row.js`; ship with `scripts/deploy-multigame-registry-api.sh`.
3. Site: add the game to `market/src/game.js` (picker), and keep the slug in the
   `vercel.json`, `image-urls.js`, worker and CDN prefix lists; ship with
   `scripts/deploy-web.sh`. A game is added to `game.js` only once its catalog
   has images, so the picker never opens an empty store.
