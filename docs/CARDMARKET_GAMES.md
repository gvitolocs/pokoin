# Cardmarket-only games

Nine games sold on Cardmarket that CardTrader does not cover. Each has its own
database on the nezopt writer (`pokoin_<game>`, streamed to the Pi replica like
every satellite game), raw table `marketplace_<game>.cardmarket_products`, and
CDN prefix `<slug>/` under `/srv/pokoin/card-images/objects/` on the Pi.

| Game | `game` | Path | Catalog source | Cards | Live |
| --- | --- | --- | --- | --- | --- |
| Final Fantasy TCG | `final_fantasy` | `/final-fantasy` | Square Enix card browser JSON (`fftcg.square-enix-games.com/en/get-cards`) | 4,260 | yes |
| Star Wars Destiny | `star_wars_destiny` | `/star-wars-destiny` | SWD Renewed Hope public API (`db.swdrenewedhope.com/api/public/cards/`) | 2,883 | yes |
| Weiss Schwarz | `weiss_schwarz` | `/weiss-schwarz` | `CCondeluci/WeissSchwarz-ENG-DB` + `-JP-DB` (official ws-tcg.com art) | 66,723 EN+JP | images importing |
| Force of Will | `force_of_will` | `/force-of-will` | FoWDB (scrape) | — | pending |
| World of Warcraft TCG | `world_of_warcraft` | `/world-of-warcraft` | WoW TCG Reborn scans | — | pending |
| Battle Spirits Saga | `battle_spirits_saga` | `/battle-spirits-saga` | official card database | — | pending |
| Dragoborne | `dragon_born` | `/dragon-born` | Dragoborne wiki / CCGTrader | — | pending |
| My Little Pony CCG | `my_little_pony` | `/my-little-pony` | mlpmerch.com CCG database | — | pending |
| The Spoils | `the_spoils` | `/the-spoils` | the-spoils-cardgame.vercel.app | — | pending |

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

- Ids: `10_000_000_000 + sha1(game:key)[:9]`. Stable across reruns, above every
  Cardmarket idProduct; public card id = id × 2 (< 2^53).
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
