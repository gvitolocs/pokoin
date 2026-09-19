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

| CT id | Game | Slug / DB | CDN prefix | Status 2026-09-18 |
| ---: | --- | --- | --- | --- |
| 5 | Pokémon | `pokoin_marketplace` | *(none)* | Live. NVMe writer + Pi replica. Images on Pi origin, rsynced from the NVMe tree. |
| 15 | One Piece | `pokoin_one_piece` | `one-piece/` | **Live on writer + Pi replica (2026-09-18).** 8,543 blueprints dumped Oracle → restored NVMe writer; extensions pg_trgm/unaccent; projections refreshed. 4.1 GB objects on both disks. |
| 22 | Riftbound | `pokoin_riftbound` | `riftbound/` | **Live on writer + Pi replica (2026-09-18).** 1,800 blueprints; 455 MB objects. Smoke: `GET /api/marketplace-card-page?game=riftbound&cardId=723286` → Spiritforged Ahri (public id is **723286** = 361643×2; the older 722286 here was a digit-swap typo). |
| 1 | Magic: the Gathering | `pokoin_magic` | `magic/` | Ingest API live (`POST /api/ingest/magic` on Oracle :18082); discover-only done: **790 expansions** / 27 categories. Catalog import next (bound one expansion before `--stream-all`). |
| 4 | Yu-Gi-Oh! | `pokoin_yugioh` | `yugioh/` | Ingest API live; discover-only done: **683 expansions** / 18 categories. |
| 18 | Disney Lorcana | `pokoin_lorcana` | `lorcana/` | Ingest API live; discover-only: 29 expansions. |
| 6 | Flesh and Blood | `pokoin_flesh_and_blood` | `flesh-and-blood/` | Ingest API live; discover-only: 131 expansions. |
| 8 | Digimon | `pokoin_digimon` | `digimon/` | Ingest API live; discover-only: 122 expansions. |
| 9 | Dragon Ball Super | `pokoin_dragon_ball_super` | `dragon-ball-super/` | Ingest API live; discover-only: 171 expansions. |
| 10 | Cardfight!! Vanguard | `pokoin_vanguard` | `vanguard/` | Ingest API live; discover-only: 279 expansions. |
| 20 | Star Wars Unlimited | `pokoin_star_wars` | `star-wars/` | Ingest API live; discover-only: 31 expansions. |
| 21 | Union Arena | `pokoin_union_arena` | `union-arena/` | Ingest API live; discover-only: 92 expansions. |
| 23 | Gundam | `pokoin_gundam` | `gundam/` | Ingest API live; discover-only: 37 expansions. |
| 24 | Sorcery: Contested Realm | `pokoin_sorcery` | `sorcery/` | Ingest API live; discover-only: 9 expansions. |

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
# 2026-09-18: CARDTRADER_INGEST_SECRET now lives in Oracle .env.ingest (chmod 600).
# Header: x-cardtrader-ingest-secret (or Authorization: Bearer). NOTE: docker
# restart does NOT re-read --env-file — recreate the container with
# run-cardtrader-game-ingest-api-docker.sh after editing .env.ingest.
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
6. Smoke: `GET /api/marketplace-card-page?game=riftbound&cardId=723286` for
   Spiritforged Ahri (`361643` → public `723286`). Extension “Card market
   not found” should go away. **Verified 2026-09-18** — the Pi API reads the
   replica satellite DBs (no explicit `ONE_PIECE_MARKETPLACE_DATABASE_URL` /
   `RIFTBOUND_…` env is needed: `databaseUrlForGame` derives
   `127.0.0.1:5432/pokoin_<db>` from `MARKETPLACE_DATABASE_URL`).

### Wave 2 — Magic, then Yu-Gi-Oh

**DONE 2026-09-18 — full blueprint import of every satellite game ran the same
day (see Wave 3 status).** Two importer bugs were found and fixed first:

1. `cardtrader-multigame-import.js` `createTargetPool` always passed an `ssl`
   object to `pg.Pool` — even `{rejectUnauthorized:false}` **forces** SSL, and
   the `:15543` tunnel to the writer is non-SSL ("The server does not support
   SSL connections"). Fixed: `ssl:false` when `MARKETPLACE_DATABASE_SSL=0`,
   `sslmode=disable` in the URL, or `<ENV>_SSL=0`.
2. The ingest API body needs **`"limit":"all"`** — without it the default cap
   is **500 blueprint rows** per request (11 games × 500 rows silently).
3. `.env.ingest` on Oracle now uses `sslmode=disable` everywhere (the install
   script derives per-game URLs from the base `?sslmode=require` URL).

Results (rows in `marketplace_<game>.cardtrader_blueprints` on the writer,
streamed to the Pi replica automatically):

| Game | CT id | Rows | CT expansions |
| --- | ---: | ---: | ---: |
| Magic | 1 | 122,740 | 790 |
| Yu-Gi-Oh! | 4 | 48,453 | 683 |
| Vanguard | 10 | 26,619 | 279 |
| Dragon Ball Super | 9 | 14,742 | 171 |
| Flesh and Blood | 6 | 13,756 | 131 |
| Digimon | 8 | 9,783 | 100 selected |
| Star Wars Unlimited | 20 | 8,302 | 31 |
| Union Arena | 21 | 7,200 | 92 (9 empty/not-ready on CT) |
| Lorcana | 18 | 3,879 | 29 |
| Gundam | 23 | 2,168 | 37 |
| Sorcery | 24 | 1,844 | 9 |

**Raw archive:** `/home/nez/mnt/mybook/pokoin-ct-blueprints/` — `pg_dump -Fc`
of each game's `cardtrader_blueprints` (the `blueprint` jsonb column holds
CT's original blueprint JSON) + `manifest.txt`. Giuseppe 2026-09-18: keep the
raw copies on the 15T mybook for now.

## Scan ingest (2026-09-18, satellite games)

`scripts/satellite-scan-ingest.py` (pokoin-web) downloads CardTrader blueprint
scans for every satellite game and lands them exactly like Pokemon leftovers:

```
per game, 5000-row chunks (resumable; rows with cdn_image_url IS NULL)
  nezopt: dump rows (ct_id, name, preview/full urls) from writer
          build jobs {prefix}{ct_id}_{slug}.jpg → candidate urls
  Oracle: scp jobs, fetch at POKOIN_SCAN_WORKERS (ThreadPool) → /tmp/pokoin-scan-out{tag}
  rsync bytes back → Pillow ProcessPool encodes onto NVMe tree
          objects/sorcery/385717_alpha-booster-box.jpg + _homepage.webp
  stamp cdn_image_url / cdn_object_key / homepage_* on the writer (ct_id join)
Pi: per-prefix rsync over ssh to /srv/pokoin/card-images/objects/ (ingest push
    path, same as Pokemon push(); the "hourly pi replica timer" in GAMES.md is
    NOT installed — push manually per prefix, or install the rsyncd first)
```

Run with the ai-toolkit venv python (Pillow). Env: `POKOIN_SCAN_WORKERS`
(Oracle fetch concurrency), `POKOIN_SCAN_CHUNK`, `POKOIN_SCAN_GAMES`,
`POKOIN_SCAN_TAG` (separates concurrent runners: jobs/out dirs on Oracle +
state/raw dirs locally), `POKOIN_SCAN_STATE` / `POKOIN_SCAN_FAILS` (7-day
failure memo so empty/unscannable blueprints are not refetched every run;
memoization is skipped for a chunk whose fail rate is ≥40% — that pattern is
rate limiting, not missing scans).

**Cloudflare incident 2026-09-18:** two runners × 24 workers (48 concurrent
CT image GETs) tripped the bot challenge — cardtrader.com AND
api.cardtrader.com returned 403 "Just a moment…" for the Oracle IP. The
blueprint import at concurrency 4 never triggered it. Escalation learned the
hard way: an IP that once got challenged gets re-challenged after only ~7 min
of fetching, and the home IP eventually too. **Working configuration:
`POKOIN_SCAN_ROTATE=1`** — the runner flips egress per chunk (Oracle ↔ nezopt
home IP), sleeps 240s + flips on an empty chunk, and gives a game up after 12
consecutive empty chunks (resume later; everything is resumable). Keep
workers ≤8 per runner. The `blueprint->'image'->>'url'` full URL is the first
candidate, so most rows cost exactly one GET. `pkill -f satellite-scan…`
self-matches the launching shell's command line — kill by PID or use a `[y]`
bracket pattern. The script is committed to the repo: the Mac repo sync
(19:33) deleted the untracked copy mid-run once already.

### Wave 3 — the rest

**DONE 2026-09-18** (same run as Wave 2): Lorcana, Flesh and Blood, Digimon,
Dragon Ball Super, Vanguard, Star Wars Unlimited, Union Arena, Gundam,
Sorcery all imported — counts in the Wave 2 table. Runner:
`/home/ubuntu/cardtrader-game-ingest-runner.sh` on Oracle, logs +
per-game response JSON in `/home/ubuntu/cardtrader-game-ingest-logs/`.
CardTrader-side gaps: a few Union Arena expansions return `[]` or 404
"Data is not ready for blueprints" — nothing to import yet.

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
