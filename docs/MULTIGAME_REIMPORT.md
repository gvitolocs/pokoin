# Multi-game CardTrader re-import — nezopt objects, Pi databases

Giuseppe 2026-09-14: re-import One Piece, Riftbound, Magic, Yu-Gi-Oh, and
the rest of CardTrader’s games. **Postgres yes on the usual path (the NVMe
writer; the container keeps the historical `15t` name). JPEG/webp trees live
on the nezopt NVMe leftover tree (`/home/nez/data/pokoin-leftovers`), not
the small Pi.**

**Ingest point stays Oracle.** `cardtrader-oracle-api` on
`pokoin-marketplace` GETs CardTrader (blueprint JSON and scan bytes) and
sends that payload to nezopt. SQL lands on NVMe Postgres through
`127.0.0.1:15543` → `:25432`. Scan bodies rsync to nezopt; Pillow encodes
onto the NVMe leftover tree. The Pi replica only **reads** those databases.
It is not the write target for leftover JPEGs.

Pokemon leftovers stay `ct_id` keys with no prefix. Every other game uses a
prefix (`one-piece/`, `riftbound/`, `magic/`, `yugioh/`, …). Public card id
is still leftover `ct_id × 2`. Do not mix games into `pokoin_marketplace`.

Importer already exists: `cardvault/.../scripts/cardtrader-multigame-import.js`.
Config sketch: `cardvault/.../config/cardtrader-marketplaces.example.json`.
Do **not** `--images` onto R2 as the origin (10 GB cap). Do **not** rsync
new game trees onto Pi `/srv/pokoin/card-images`.

## Why this now

| Today | Problem |
| --- | --- |
| `cdn.pokoin.com` origin is **pi-home** `:18081` (`/srv/pokoin/card-images/objects`, **36 GB**) | Pi data disk is 868 GB but USB-root + enclosure already stall. Magic + Yu-Gi-Oh leftovers would dwarf Pokemon. The NVMe tree is the write root and stays origin-side; the Pi only rsyncs a serving replica. |
| nezopt NVMe holds the leftover tree (`/home/nez/data/pokoin-leftovers`); mybook/HDD keeps bulk + rollback | Replica is the wrong direction for a bulk import: encode lands on NVMe first, the Pi replica rsyncs down. |
| `pokoin_one_piece` (8.5k) / `pokoin_riftbound` (1.8k) still live on **Oracle** 1 GB Postgres | 15T writer only has `pokoin_marketplace`. Pi replica has no satellite DBs. Satellite API derives `/pokoin_one_piece` from `MARKETPLACE_DATABASE_URL` — that only works if the URL is still Oracle. |
| R2 `cardvault-images` | Free **10 GB**. Homepage `_homepage.webp` backup only. Never the JPEG catalog. |
| Oracle `pokoin-peer1` | Cloudflare **403** on `cardtrader.com` image hosts. GET stays on **`pokoin-marketplace`**, not peer1. |

Ahri Inquisitive Showcase (CT `361643`, Spiritforged) is a Riftbound printing.
The extension “Card market not found” is the same isolation gap: RB catalog is
not on the Pi replica of the writer.

## CardTrader games (from `cardvault/.../data/cardtrader/games.json`)

| CT id | Game | Slug / DB | CDN prefix | Status 2026-09-14 |
| ---: | --- | --- | --- | --- |
| 5 | Pokémon | `pokoin_marketplace` | *(none)* | Live. NVMe writer + Pi replica. Images on Pi origin, rsynced from the NVMe tree. |
| 15 | One Piece | `pokoin_one_piece` | `one-piece/` | ~8.5k blueprints on **Oracle**. ~2.1 GB objects already on Pi **and** NVMe. |
| 22 | Riftbound | `pokoin_riftbound` | `riftbound/` | ~1.8k on **Oracle**. ~455 MB objects. |
| 1 | Magic: the Gathering | `pokoin_magic` | `magic/` | Config only. Largest dump — do this after the prefix syncs through to the Pi origin. |
| 4 | Yu-Gi-Oh! | `pokoin_yugioh` | `yugioh/` | Config only. |
| 18 | Disney Lorcana | `pokoin_lorcana` | `lorcana/` | Config only. |
| 6 | Flesh and Blood | `pokoin_flesh_and_blood` | `flesh-and-blood/` | Config only. |
| 8 | Digimon | `pokoin_digimon` | `digimon/` | Config only. |
| 9 | Dragon Ball Super | `pokoin_dragon_ball_super` | `dragon-ball-super/` | Config only. |
| 10 | Cardfight!! Vanguard | `pokoin_vanguard` | `vanguard/` | Config only. |
| 20 | Star Wars Unlimited | `pokoin_star_wars` | `star-wars/` | Config only. |
| 21 | Union Arena | `pokoin_union_arena` | `union-arena/` | Config only. |
| 23 | Gundam | `pokoin_gundam` | `gundam/` | Config only. |
| 24 | Sorcery: Contested Realm | `pokoin_sorcery` | `sorcery/` | Config only. |

SPA hosts today: `pokoin.com`, `onepiece.pokoin.com`, `riftbound.pokoin.com`.
Magic / Yu-Gi-Oh hosts come **after** a catalog exists (`game.js` +
`_marketplace_game.js` + Vercel DNS). Do not invent `app.pokoin.com` aliases.

## Topology (target)

Same hop as Pokemon leftover ingest
(`scripts/ingest-missing-product-images.py`): Oracle `--oracle-fetch`, rsync
raw bodies to nezopt, encode onto the NVMe tree.

```
CardTrader ── GET JSON + scan bytes ── Oracle pokoin-marketplace
                                        cardtrader-oracle-api (:18080)

              persist SQL ──────────────► nezopt writer (NVMe) isolated DBs
                                          (tunnel :15543 → :25432)

              rsync raw scans ──────────► nezopt Pillow
                                          write JPEG/webp on the NVMe tree
                                          /home/nez/data/pokoin-leftovers/objects/{prefix}

cdn.pokoin.com  ◄── Cloudflare  ◄── Pi CDN :18081 (hourly rsync replica of
                                    the NVMe objects; sync-pi-card-images-replica)

api.pokoin.com  ◄── Pi  ◄── streaming replica of the writer (all pokoin_* DBs)
```

| Piece | Stays | Changes |
| --- | --- | --- |
| Public API | Pi `api.pokoin.com` | Reads replica DBs `pokoin_one_piece`, `pokoin_magic`, … once they exist on the writer |
| Listing writes | Writer (NVMe) `MARKETPLACE_WRITER_DATABASE_URL` | Per-game writer URL on the same cluster |
| Dump JSON | nezopt NVMe | Unchanged |
| CardTrader GET | Oracle `pokoin-marketplace` | JSON dump + scan prefetch. Sends to nezopt. Not peer1. Not home IP. |
| Leftover / prefixed JPEGs | **nezopt NVMe tree** (`/home/nez/data/pokoin-leftovers`) | Oracle does not keep the catalog tree. Stop using Pi `/srv/pokoin/card-images` as the write target |
| `cdn.pokoin.com` | Hostname unchanged | Origin stays the **Pi** (`:18081`, [GAMES.md](GAMES.md)); `pi-card-images-replica.timer` rsyncs the NVMe objects down hourly. R2 stays `_homepage.webp` backup only |
| Meili | Pi, Pokemon-only | Satellites stay Postgres suggest until a second index is worth it |
| CLIP / versions | 7900 XTX, Pokemon | Do not CLIP Magic/Yu-Gi-Oh unless asked |

Pi CDN skip-prefixes (`one-piece/`, `riftbound/`, `competitive/`) must gain
every new prefix so leftover-id remapping never halves `magic/1234_…`.

## Per-game ingest APIs (Oracle → 15T writer)

Pokemon public API stays on the Pi (`api.pokoin.com` / `pokoin-oracle-api`).
It is not these routes.

Oracle `cardtrader-game-ingest-api` listens on **127.0.0.1:18082**. Each
CardTrader game has its own ingest path. GET CardTrader here, persist to
that game’s writer database (`MAGIC_MARKETPLACE_DATABASE_URL` →
`pokoin_magic`, …). Leftover JPEGs still go to the NVMe object tree, not
the Pi.

| API | Writer database |
| --- | --- |
| `GET/POST /api/ingest/magic` | `pokoin_magic` |
| `GET/POST /api/ingest/yugioh` | `pokoin_yugioh` |
| `GET/POST /api/ingest/one-piece` | `pokoin_one_piece` |
| `GET/POST /api/ingest/riftbound` | `pokoin_riftbound` |
| `GET/POST /api/ingest/lorcana` | `pokoin_lorcana` |
| `GET/POST /api/ingest/flesh-and-blood` | `pokoin_flesh_and_blood` |
| `GET/POST /api/ingest/digimon` | `pokoin_digimon` |
| `GET/POST /api/ingest/dragon-ball-super` | `pokoin_dragon_ball_super` |
| `GET/POST /api/ingest/vanguard` | `pokoin_vanguard` |
| `GET/POST /api/ingest/star-wars` | `pokoin_star_wars` |
| `GET/POST /api/ingest/union-arena` | `pokoin_union_arena` |
| `GET/POST /api/ingest/gundam` | `pokoin_gundam` |
| `GET/POST /api/ingest/sorcery` | `pokoin_sorcery` |
| `GET/POST /api/ingest/pokemon` | **404** — stays on the Pi |

```bash
python3 scripts/create-multigame-ingest-databases.py --apply
scripts/install-cardtrader-game-ingest-api.sh

ssh pokoin-marketplace 'curl -sS http://127.0.0.1:18082/api/ingest'
ssh pokoin-marketplace 'curl -sS http://127.0.0.1:18082/api/ingest/magic'
# POST needs CARDTRADER_INGEST_SECRET (or CARDTRADER_DAILY_LISTINGS_SECRET)
# discover-only:
curl -sS -X POST -H "Authorization: Bearer $SECRET" \
  -H 'content-type: application/json' \
  -d '{"discoverOnly":true}' \
  http://127.0.0.1:18082/api/ingest/one-piece
```

POST `apply:true` must bound `expansionIds` or send `streamAll` with
`confirm:"stream-all"`. Images stay false on this API (no R2). Pin one
process with `CARDTRADER_INGEST_GAME=magic` if a game needs its own
container later (`18100 + cardtraderGameId`).

## Pipeline (waves)

Dry-run every wave. `--apply` only after counts look like that game.

### Wave 0 — image plumbing (do this first)

Pokemon objects already live on the NVMe tree and the Pi replica rsyncs
them hourly. Keep that direction before any Magic download.

1. Confirm `sync-pi-card-images-replica.sh` / `pi-card-images-replica.timer`
   carries the NVMe tree (`/home/nez/data/pokoin-leftovers/objects`) to the
   Pi serving root, including the new prefixes (`one-piece/`, `riftbound/`).
2. Pi CDN skip-prefixes gain every new prefix (see the remap note above) so
   a prefixed key is never halved.
3. R2 stays `_homepage.webp` overflow only.
4. Never make the Pi the *write* target: Oracle GET + nezopt Pillow write
   the NVMe tree only.

### Wave 1 — One Piece + Riftbound onto the writer Postgres

Catalogs already exist on Oracle. Images already sit under `one-piece/` and
`riftbound/` on both disks.

1. `CREATE DATABASE pokoin_one_piece` / `pokoin_riftbound` on the writer
   (same instance as `pokoin_marketplace` → Pi replica streams them).
2. `pg_dump` Oracle → 15T **or** re-run
   `cardtrader-multigame-import.js --stream-all --ensure-schema --apply`
   with `ONE_PIECE_MARKETPLACE_DATABASE_URL` / `RIFTBOUND_…` pointing at
   `127.0.0.1:25432`. Prefer dump+restore if Oracle rows are trusted.
3. Image bytes: Oracle GET, nezopt encode onto the **NVMe tree**. Skip
   importer `--images` (that path still PutObject to R2). `--backfill-images`
   only for missing `cdn_image_url` keys after files exist on disk.
4. `refresh_multigame_marketplace_projections(...)` on those DBs.
5. Pi API env: `ONE_PIECE_MARKETPLACE_DATABASE_URL` /
   `RIFTBOUND_MARKETPLACE_DATABASE_URL` → `127.0.0.1:5432` replica DBs.
   Drop Oracle as the satellite first hop.
6. Smoke: `GET /api/marketplace-card-page?game=riftbound&cardId=` for
   Spiritforged Ahri (`361643` → public `722286`). Extension “Card market
   not found” should go away.

### Wave 2 — Magic, then Yu-Gi-Oh

Largest. Image plumbing (Wave 0) **must** already sync the prefix through
to the Pi origin.

```bash
node cardvault/pokemon_card_vault/scripts/cardtrader-multigame-import.js \
  --game=magic --cardtrader-game-id=1 --discover-only

node …/cardtrader-multigame-import.js \
  --game=magic --cardtrader-game-id=1 \
  --database-url-env=MAGIC_MARKETPLACE_DATABASE_URL \
  --schema=marketplace_magic --table=cardtrader_blueprints \
  --stream-all --ensure-schema \
  --batch-size=1000 --concurrency=8
```

Run that importer on **Oracle** so CardTrader GET and writer persist stay
one hop (`MARKETPLACE_DATABASE_URL` already tunnels). Same for
`--game=yugioh --cardtrader-game-id=4`. Create DBs first. Then leftover
ingest with `POKOIN_CT_FETCH_HOST=pokoin-marketplace` and
`POKOIN_REPLICA_OBJECTS` as the write root; **do not** `rsync` to
`pi-home:/srv/pokoin/card-images`. Projection SQL is the multigame helper
with that game’s `category_id`s (discover-only prints them). Bound one
expansion before `--stream-all`.

### Wave 3 — the rest

Lorcana, Flesh and Blood, Digimon, Dragon Ball Super, Vanguard, Star Wars
Unlimited, Union Arena, Gundam, Sorcery. Same importer, one isolated DB +
prefix each. Order by CardTrader expansion count after `--discover-only`.

### Wave 4 — SPA hosts (after catalogs)

`magic.pokoin.com`, `yugioh.pokoin.com`, … → same Vercel project `web`.
`market/src/game.js` + Pi `_marketplace_game.js`. `/` on satellites already
rewrites to `/marketplace`. Competitive / Meili / art-cut stay Pokemon.

## Image contract

| | Pokemon | Other games |
| --- | --- | --- |
| Object key | `{ct_id}_{slug}.jpg` | `{prefix}{ct_id}_{slug}.jpg` |
| Homepage | `{ct_id}_{slug}_homepage.webp` | `{prefix}{ct_id}_{slug}_homepage.webp` |
| GET | Oracle `pokoin-marketplace` | same |
| Encode | nezopt Pillow (ai-toolkit venv) | same |
| Pillow on Pi | never | never |
| Public URL | `https://cdn.pokoin.com/{key}` | same |
| SPA rewrite | leftover `ct_id` | keep prefix; do not half a prefixed key |

Importer `--images` today PutObject to R2 via sharp. Do not use it for this
re-import. Oracle GET + nezopt Pillow onto the NVMe tree, same as Pokemon
leftovers. If we add `--image-root` later, it still runs the GET on Oracle
and writes the NVMe tree — never R2, never the Pi.

## Would-remove / gone CT printings

`scripts/remove-catalogue-card.py` is Pokemon/`pokoin_marketplace` today.
Satellite deletes need `--database-url` / `--game` before we wipe Magic rows
the same way. CT 404 + no leftover JPEG is the same rule.

## Do not

- Import Magic into `public.cardtrader_pokemon_blueprints`.
- `rsync` a Magic tree onto the Pi.
- Run CardTrader GET on `pokoin-peer1` (403) or on nezopt home IP (rate-limited).
- Skip Oracle: nezopt is persist/encode, not the CardTrader ingest hop.
- Store catalog JPEGs on R2.
- `--refresh` Pokemon `refresh_marketplace_oracle_projections()` on live
  (it `ALTER TABLE`s).
- CLIP non-Pokemon leftovers unless Giuseppe asks.
- Alias `app.pokoin.com` or `explorer.pokoin.com` onto project `web`.

## Status command

```bash
python3 scripts/multigame-reimport-status.py
```

Prints the game databases on the NVMe writer (satellite DBs present or
missing) and image prefix bytes on the NVMe leftover tree.
