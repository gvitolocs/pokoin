# Multi-game hosts + Pi CDN

## Marketplaces (live)

One shared React SPA (`market/`, Vercel project `web`). Hostname picks the game
via [`market/src/game.js`](../market/src/game.js); API calls append `?game=` and
send `x-pokoin-game` / `x-pokoin-host`. The CF origin Worker also injects `game`
for satellite hosts so the Pi API never falls back to Pokemon.

| Host | `game` | DB | Public card id |
| --- | --- | --- | --- |
| `pokoin.com` | `pokemon` (default) | `pokoin_marketplace` | `ct_id * 2` |
| `onepiece.pokoin.com` | `one_piece` | `pokoin_one_piece` | `ct_id * 2` |
| `riftbound.pokoin.com` | `riftbound` | `pokoin_riftbound` | `ct_id * 2` |

Pokemon Milo gallery `id` is that same leftover `ct_id` (manifest
`"identity": "ct_id"`). Public desk = Milo `id` × 2. Not a TCGplayer product
id. Live `/scan` uses leftover-JPEG catalogs (`pokemon_generic` /
`one_piece_singles`) with `"identity": "public_id"`. [SCAN.md](SCAN.md),
[MARKET.md](MARKET.md) identity, [APP.md](APP.md).

### Satellite vs Pokemon APIs

| Endpoint | Pokemon | One Piece / Riftbound |
| --- | --- | --- |
| `GET /api/marketplace-home` | **pokoin.com Worker:** SPA rails vector. **api.pokoin.com:** Flutter hydrate (~170 KB) — SPA must reject it. | **Delegates** to home-page for satellite `game` / Host |
| `GET /api/marketplace-home-page` | Oracle newest fallback; Worker alias of the rails vector on pokoin.com | Same handler, isolated DB via `_marketplace_game` |
| `GET /api/marketplace-search-page` | Meili + Postgres | Postgres-only multigame SQL |
| `GET /api/marketplace-suggest` | Meili/Postgres | Multigame suggest |
| `GET /api/marketplace-portfolio` | Catalog + native PKN overlay | Same handler, isolated DB |

Game resolution order (`cardvault/.../api/_marketplace_game.js`):

1. `?game=` / `marketplaceGame`
2. `x-pokoin-game` / `x-marketplace-game`
3. Host / `x-forwarded-host` / `x-pokoin-host` / Origin (`onepiece.*` → `one_piece`, `riftbound.*` → `riftbound`)

SPA on satellite hosts **skips** `/api/marketplace-home` and calls `/api/marketplace-home-page` only (the Pokemon Flutter home always returned Pokemon cards and short-circuited the UI). Isolated OP/RB catalogs have no `candidates.version` / `pokoin_version_sets`; home and set lists use newest/hot SQL and `marketplace_set_card_counts`. Pokemon SPA first paint: [HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md).

- `/` on satellite hosts → `/marketplace`.
- CDN keys stay raw `ct_id` under `one-piece/` and `riftbound/` (do not rewrite to public id).
- Projections: `public.marketplace_search_candidates` + `marketplace_card_urls` in each isolated DB (`cardvault/pokemon_card_vault/oracle-postgres/schema/026_multigame_marketplace_projections.sql`).
- Refresh: `select public.refresh_multigame_marketplace_projections(...)`.
- Competitive / Pi rails / Meili: Pokemon-only for now.
- Search-suggest **illustration rectangle** (`CardArt cut`) is Pokemon-only.
  LEGEND/BREAK rows show the leftover rotated landscape instead of that crop.
  One Piece / Riftbound suggest rows keep the mini full-card thumb and skip
  `.suggest-art`. `CardTile` is a full 63:88 scan on every host.
  Map: [CARD_ART.md](CARD_ART.md).

**Silver off-site links:** CardTrader URLs are leftover `ct_id` (`409179`), never
public `card_id` (`818358`). `GET /api/cardtrader-redirect?id=` maps either.
The Silver CT pill opens leftover `cardtrader.com` with `noopener,noreferrer`
so CardTrader does not see pokoin.com. Do not spoof a Google referrer.
Cardmarket search for OP/RB uses `/en/OnePiece` and `/en/Riftbound` (not
Pokemon Singles). Fallback `searchString` is `{name} {collector}` like Vinted. Vinted is Pokemon `{name} {collector}` (`Gumshoos 184`);
OP `One Piece Card Game {name} {number}`; RB `Riftbound TCG {name} {number}`.
Do not add English set names — Vinted ANDs tokens and IT listings omit them.
Name-only Gumshoos is 500+. See [API.md](API.md) and [MARKET.md](MARKET.md).

DNS: CNAME → same Vercel target as apex (`00dae56389d2f4d1.vercel-dns-017.com`). Prefer **DNS-only** (grey cloud) for the new hosts until CF WAF skip capacity allows orange-cloud like apex.

## Image URLs (do not change assignment)

Catalog / API / SPA keep storing and returning:

`https://cdn.pokoin.com/{leftover_or_prefix_key}.jpg`

Set at import time by `POKOIN_CARD_CDN_BASE_URL` (default `https://cdn.pokoin.com`) in CardVault importers (`cardtrader-multigame-import.js`, pokemontcg hires, etc.). Rows land in `cdn_image_url` / `image_url`.

SPA [`market/src/api.js`](../market/src/api.js) `preferFullImage` rewrites that host to same-origin `/card-images/…`. Rails JSON from `pokoin_public_card.py` may still store a **public-id** prefix; the SPA rewrites `<img>` to leftover `ct_id` before paint. Vercel [`vercel.json`](../vercel.json) proxies every `/card-images/*` path to `https://cdn.pokoin.com/:path*` (Raspberry Pi). The `pokoin-cdn-card-images` worker on pokoin.com does the same: Pi first, R2 backup, **never Oracle**. Keep `competitive/` PNG/SVG raw. The SPA must not rewrite those prefixes to `.jpg`. See [COMPETITIVE.md](COMPETITIVE.md).

**Do not** rewrite the Pi API’s `MARKETPLACE_DATABASE_URL` off `127.0.0.1:5432`.
That local URL is the **replica**. Live image and API **hosts** stay the Pi
tunnel. Dump persist and schema SQL go to the nezopt NVMe writer Postgres
(the container keeps the historical `15t` name), not the Pi
and not Oracle’s 1 GB Docker Postgres.

Pokemon `item_kind` follows CardTrader `category_id` on ingest
(`060_cardtrader_category_kind.sql`). Empty `category_name` is not a card.
Qwen-VL leftover classification (`scripts/qwen-leftover-kind.py` via llama.cpp `:11436`) fills
null/unknown categories; it does not replace CT memorabilia/box/storage ids.

## Live topology (2026-09-12)

Giuseppe: **APIs are from the Pi. Oracle is the CardTrader GET hop; it
sends JSON (and scan bytes) to nezopt. Postgres persist is nezopt NVMe.** Do not
treat Oracle Docker API as the SPA first hop.
Do not dump-write on the Pi replica. Historicization (snapshots, sold_daily,
observations) lives on **nezopt NVMe Postgres**. Raw dump JSON belongs on nezopt
**NVMe** (`/`, not mybook). GET can stay on Oracle; persist SQL still hits
`:25432` through `:15543`.

Satellite games (One Piece, Riftbound, Magic, Yu-Gi-Oh, …) use the **same
ingest hop**: Oracle GET → nezopt NVMe Postgres. Isolated DBs stream to the Pi replica.
Leftover JPEGs for those games stay on nezopt **NVMe**
(`/home/nez/data/pokoin-leftovers`), not Pi
`/srv/pokoin/card-images`. Plan: [MULTIGAME_REIMPORT.md](MULTIGAME_REIMPORT.md).
Per-game ingest APIs live on Oracle `:18082`; Pokemon public API stays the
Pi.

| Piece | Where | Role |
| --- | --- | --- |
| `api.pokoin.com` | **pi-home** CF tunnel (edge `:18079` → API `:18080`) | Public marketplace API. Reads local Postgres replica `127.0.0.1:5432`. Listing/order writes use `MARKETPLACE_WRITER_DATABASE_URL` → nezopt LAN `192.168.178.55:25432`. Card desk sold graph: `GET /api/marketplace-card-sales` → replica `cardtrader_sold_daily`. |
| `cdn.pokoin.com` | **pi-home** `:18081` | Leftover JPEG origin (`/srv/pokoin/card-images/objects`). |
| Meili + Valkey | **pi-home** | English suggest + cache next to the API. Docker `pokoin-meili` is `getmeili/meilisearch:v1.53.1`, data `/srv/pokoin/meili`. |
| CardTrader **GET** + API | Oracle `pokoin-marketplace` `130.61.251.250` | Docker **`cardtrader-oracle-api`** (`:18080`, `/home/ubuntu/cardtrader-oracle-api/current`). Full `oracle-api-server` plus the daily GET dump. Not `api.pokoin.com`. [CARDTRADER_ORACLE_API.md](CARDTRADER_ORACLE_API.md). |
| Dump **JSON** | nezopt **NVMe** (`/`, ~1.2T free) | Raw CardTrader expansion GET bodies / crawl artifacts. Not the 15T. Not the Pi. |
| Leftover **JPEGs** (edge) | nezopt **NVMe** `/home/nez/data/pokoin-leftovers` | Classify, OCR, CLIP artcut, ingest write. One-time `scripts/sync-nvme-leftovers-from-15t.sh`. |
| Postgres **writer** / historicization | **nezopt NVMe** `pokoin-marketplace-postgres-15t` (`127.0.0.1:25432`, LAN `192.168.178.55:25432`) | Snapshot book, `archiveMissing`, `sold_daily`, observations. Data dir `/home/nez/data/pokoin-marketplace-postgres/`. Always on (no 22:00 HDD night-off). HDD copy kept for rollback. |
| Dump persist tunnel | nezopt user unit `pokoin-oracle-dump-pg-tunnel` | Oracle `127.0.0.1:15543` → nezopt `127.0.0.1:25432`. `MARKETPLACE_DATABASE_SSL=0`. |
| Postgres on Pi | Docker `pokoin-marketplace-postgres-replica` | Streaming **replica of nezopt writer** (`primary_conninfo` `192.168.178.55:25432`, slot `pokoin_pi_replica`, `sslmode=disable`). `max_connections` must be ≥ primary (120). Never dump-write or migrate here. Oracle SSH tunnel `:15432` is disabled. |
| SPA | Vercel project `web` → `pokoin.com` | `/api/*` rewrites to `api.pokoin.com`. |

Install the persist tunnel on nezopt:
`scripts/install-oracle-dump-nezopt-tunnel.sh`. Recreate the Oracle CardTrader
API: `scripts/install-cardtrader-oracle-api.sh`. Dump drop-in:
`scripts/pokoin-cardtrader-daily-nezopt.conf`. Map:
[CARDTRADER_ORACLE_API.md](CARDTRADER_ORACLE_API.md).

If the replica container is missing, `GET /healthz` is **503** and the SPA
shows WorkingOnIt. Do not promote a second primary from
`/srv/pokoin/postgres.promoted-primary-backup`. Pause the Pi watchdog
**timer** (not only reboot) while `pg_basebackup` runs, or it will
`docker start` the old datadir. Replica `max_connections` must be ≥ the
nezopt primary (default 100). Cutover 2026-09-12: old Oracle pgdata kept as
`/srv/pokoin/postgres/pgdata.oracle-20260912T135334Z`. Writer PGDATA moved
onto NVMe 2026-09-14 (`scripts/install-pokoin-postgres-nvme.sh`); host port
`:25432` did not change.

## Raspberry Pi origin

| Host | Role |
| --- | --- |
| `api.pokoin.com` | Marketplace API + leftover image keys on **pi-home** (edge `:18079` → API `:18080` / CDN `:18081`). Tunnel 1033 is Worker `pokoin-working` → “We are working on a solution.” not the Cloudflare label. |
| `api2.pokoin.com` | Same origin as `api.pokoin.com`. Oracle api2 CDN is removed. |
| `cdn.pokoin.com` | Card-image origin on **pi-home** (`:18081`, same tunnel, disk `/srv/pokoin/card-images/objects`) |

Server: `scripts/pokoin-oracle-cdn-server.js` on the Pi (`pokoin-card-images.service` → `/srv/pokoin/card-images/tools/pokoin-pi-cdn-server.js`), root `/srv/pokoin/card-images/objects`, port `18081`. SPA image URLs are leftover `ct_id` (`public / 2`). CDN remaps a **public-id** key to leftover only when dumps at that id belong to another card (Lost Thunder Net Ball `245292` vs Cyndaquil leftover `245292`). It must not half an even leftover key again (Meloetta `122490` is leftover; `61245` is stale leftover/4). Desk paths stay public id. `pokoin-id-check` rejects a public-id prefix on an image URL — the old checker treated `{publicId}_*` as success and `--audit-urls` ok when leftover prefixes were 0.

## nezopt NVMe leftovers — edge image jobs

Classify, OCR, CLIP artcut, and leftover ingest write on **NVMe**
(`/home/nez/data/pokoin-leftovers`). Writer Postgres is also NVMe
(`/home/nez/data/pokoin-marketplace-postgres`). Do not scandir
`mybook/.../objects` on every pass.

One-time catch-up (hardlink existing NVMe trees, then copy files only the
HDD still has):

```bash
scripts/sync-nvme-leftovers-from-15t.sh
```

The Pi is the live `cdn.pokoin.com` origin. It has **no Pillow**. Do not
SSH a crop/encode loop onto the Pi, and do not copy the image tree over
`sshd` (200k files reset the daemon).

| | |
| --- | --- |
| Edge leftovers | `/home/nez/data/pokoin-leftovers/objects/` |
| Edge artcut | `/home/nez/data/pokoin-leftovers/artcut/` (nezopt-only) |
| Historicization | NVMe `/home/nez/data/pokoin-marketplace-postgres/` (`:25432`) |
| Cold HDD copy | `/home/nez/mnt/mybook/` leftover objects + old PGDATA rollback |
| Pi delta | **rsync daemon** `rsync://192.168.178.46/card-images/` |
| Crop | `scripts/export-leftover-artcut.py` (all CPUs, NVMe) |
| Versions | ROCm venv + 7900 XTX: `scripts/version-sets-pipeline.sh` (illustration **box** CLIP, then equalized pixels at cluster floor **0.55**). Era headings: [TCG_ERAS.md](TCG_ERAS.md). [VERSIONS.md](VERSIONS.md). |

```bash
# leftover JPEG → CLIP illustration rectangle (NVMe, all cores)
/home/nez/Projects/BattleScan/.venv/bin/python scripts/export-leftover-artcut.py

# CLIP + version groups on the RX 7900 XTX (HIP 0, not the Raphael iGPU)
# New leftovers (one expansion / one desk):
scripts/match-imported-version-sets.sh --expansion "30th Celebration JP"
/home/nez/Projects/pokemon-card-extension/scripts/version-sets-pipeline.sh --dry-run
/home/nez/Projects/pokemon-card-extension/scripts/version-sets-pipeline.sh
# CLIP rebuild only when scripts/out/artbox-clip.npz is stale:
HIP_VISIBLE_DEVICES=0 /home/nez/Projects/ai-toolkit/venv/bin/python \
  /home/nez/Projects/pokemon-card-extension/scripts/cluster-name-version-sets.py \
  --all --reencode --dry-run
```

`artcut/` uses the same filename as the leftover JPEG. It is pipeline data.
Never `_art.webp` in `objects/`. Never `CardTile` / `.tile`. SPA still
CSS-crops on search suggest only — [CARD_ART.md](CARD_ART.md).

Probe:

```bash
curl -sS https://api.pokoin.com/healthz
# 200 only when postgres, valkey, meili, and Pi CDN all answer.
curl -sSI "https://cdn.pokoin.com/one-piece/301338_burn-bazooka.jpg"
curl -sS "https://api.pokoin.com/api/marketplace-suggest?game=one_piece&q=luffy&limit=2"
curl -sS "https://onepiece.pokoin.com/api/marketplace-home-page" | head -c 200   # must be game=one_piece
curl -sS "https://riftbound.pokoin.com/api/marketplace-home" | head -c 200       # must NOT be Pokemon
curl -sS "https://api.pokoin.com/api/marketplace-home-page?game=riftbound" | head -c 200
```

## Pi watchdog

`scripts/pokoin-pi-watchdog.sh` runs **on pi-home** every 5 minutes
(`pokoin-pi-watchdog.timer`). It starts Docker + API/CDN/edge/cloudflared/ssh
if a port is down, then curls local `/healthz`. Fail counts live on **tmpfs**
(`/run/pokoin-watchdog`) so a read-only root can still increment them.
Three consecutive failed checks (~15 min) reboot, at most once per hour.
`pokoin-pi-ro-watch.service` is a RAM-resident loop: if `/proc/mounts`
contains `emergency_ro`, it writes `b` to sysrq (20s). Hardware
`RuntimeWatchdogSec=180s` only helps when systemd **stops petting**; a USB
stall that leaves the CPU idle does not trip it. Hung USB tasks panic after
120s (`kernel.hung_task_panic=1`) when there is a D-state hang — I/O
`emergency_ro` is not that. Edge is `scripts/pokoin-api-edge.js`
(`:18079` → API `:18080` / CDN `:18081`). Install:
`scripts/install-pokoin-pi-watchdog.sh`. USB-NVMe root quirks:
`scripts/install-pi-usb-root.sh`. Deploy helper:
`scripts/deploy-pokoin-pi-watchdog.sh`.

**Uptime mail (nezopt, not the Pi):** `scripts/pokoin-uptime-mail.sh` curls
`https://api.pokoin.com/healthz` every 2 minutes and emails
`vitologiuseppe17@gmail.com` on the down edge after two consecutive failed
samples, every 30 minutes while still down, and once when it returns. Install: `scripts/install-pokoin-uptime-mail.sh`.
The Pi watchdog cannot send this if the box itself is unreachable.

OS stays on the external Samsung 990 PRO (`/dev/sda2`) behind Realtek
RTL9210 (`0bda:9210`, `bcdDevice=22.27`, MaxPower **896 mA**) on the Pi 4
VL805. Boot firmware stays on the SD card. UAS is already ignored
(`usb-storage.quirks=0bda:9210:u`). USB3 LPM/autosuspend off.

**Why a manual reboot was needed (2026-09-09):** the bridge stalled, ext4 set
`emergency_ro`, `hostname`/`dockerd` returned `Input/output error`, Postgres
and Meili died, ping and systemd stayed up. The 5-minute watchdog could not
write `/var/lib/pokoin-watchdog` on a dead USB root, so it never counted to
three. Same class of failure as Umbrel-on-Pi + RTL9210
([victorhonos/umbrel-os-rtl9210-fix](https://github.com/victorhonos/umbrel-os-rtl9210-fix)):
enclosure idle-sleep (`DISK_IPS_THRES` / `PCIE_PWRCUT_THRES`) looks like a
disk disconnect; Docker then cannot exec. Pi 4 USB budget is 1.2 A shared;
this enclosure advertises 896 mA ([rpi linux#4130](https://github.com/raspberrypi/linux/issues/4130)).

**Fixes that actually stop the stall (hardware, not another reboot loop):**

1. **Powered USB 3 hub** between Pi and the enclosure (confirmed on that
   GitHub thread: “root cause is a lack of Pi power”).
2. **Windows flash** of RTL9210 firmware ≥ 1.33.44
   ([bensuperpc/rtl9210](https://github.com/bensuperpc/rtl9210)), SSD
   **removed** while flashing, and comment out `DISK_IPS_THRES` plus
   `PCIE_PWRCUT_THRES=0` so the bridge does not sleep after minutes idle.
   `bcdDevice=f0.01` would mean ROM fallback — not this box (22.27).
3. Keep the RO→sysrq watcher so a stall becomes a reboot in 20s instead of
   hours of `healthz` 500s.

Replica + crop (nezopt, not the Pi): `scripts/install-pi-card-images-replica.sh`.

## R2 free tier

R2 `cardvault-images` free cap is **10 GB**. The bucket is a backup, not the
catalog origin. `pokoin-cdn-card-images` reads the Raspberry Pi first
(`pi-home` `:18081`, `/srv/pokoin/card-images/objects`) and R2 only if the Pi
misses. Public URLs stay `https://cdn.pokoin.com/…`. The write tree is nezopt
NVMe `/home/nez/data/pokoin-leftovers`. `api2.pokoin.com` is the same Pi origin
as `api.pokoin.com`. Nezopt NVMe `/home/nez/data/pokoin-leftovers/objects`
is the card backup. `cardvault-images` was emptied on 2026-09-26 after that
copy (`remaining 0`). `pokoin-profile-pictures` stays; avatars still upload there.

The 2026-09-26 listing before the move was **281,478** objects, **10.9 GB**.
**85,913** keys were already on the leftover tree. The other **198,262** were
copied there with no failures, including Magic, Yu-Gi-Oh, Vanguard, and Dragon
Ball Super keys the Pi does not serve. The CDN still reads the Pi first and
has no R2 fallback for a miss.

Seller listing photos are at most **2** JPEGs per listing (`photo_urls`).
Chat messages take at most **4**. Both are written on the Pi under
`/srv/pokoin/card-images/objects/user-photos/{listing|chat}/{uid}/` and served
as `/card-images/user-photos/…`. They are not stored in R2.

## New CardTrader printing

Dump **GET** stays on Oracle `pokoin-marketplace`. Persist writes go to nezopt
NVMe Postgres (`:25432`, tunnel `:15543`). Public API/CDN stay on the Pi
replica. Do not `--refresh` the full projection on live (it `ALTER TABLE`s and
exclusive-locks `marketplace_cards`). Procedure:
`cardvault/pokemon_card_vault/workflows/oracle-marketplace-postgres-workflow.md`
(CardTrader Delta Catalog Import).

1. Dry-run `cardtrader-delta-import.js --expansion-names="…" --limit=all` against
   nezopt writer (`127.0.0.1:25432`). The old Oracle tunnel `:15432` is the 1 GB
   box, not the ingest writer.
2. `--apply` raw blueprints only (no `--images` / `--refresh` / `--sync-supabase`).
3. Targeted `INSERT … ON CONFLICT DO NOTHING` into cards / candidates / versions /
   URLs for those `ct_id`s, then `refresh_marketplace_set_catalog_counts()`.
4. Leftover JPEG + homepage webp:
   `POKOIN_INGEST_EXPANSION='…'` or `POKOIN_INGEST_PLACEHOLDERS=1`
   `/home/nez/Projects/ai-toolkit/venv/bin/python scripts/ingest-missing-product-images.py`
   (Pillow is in that venv). Placeholder mode replaces leftover JPEGs that are
   still the 186×260 CardTrader logo **when the blueprint has a real scan**
   (`image.url` / `show`, PNG/JPEG/WebP — including Chaos Rising holos whose
   leftover slug omits `holo-rare`). Grey `card_uploader` leftovers with no
   CT scan stay the Pokoin missing-card JPEG (63:88), not the chevron back.
   **GET the scan on Oracle** `pokoin-marketplace` (home IP is
   rate-limited); encode JPEG/webp on nezopt onto the NVMe leftover tree.
   Rsync to the Pi objects replica. Do not HUP `pokoin-card-images`.
5. Set `cdn_image_url` to `https://cdn.pokoin.com/{ct_id}_{name-slug}.jpg`.
6. CLIP same-art groups on the 7900 XTX; apply `pokoin_version_sets` on the
   **nezopt NVMe writer**, not the
   Pi replica. Leftover ingest runs this for the expansion it just pushed.
   Manual / already-on-disk leftovers:
   `scripts/match-imported-version-sets.sh --expansion "30th Celebration JP"`
   or `--ids 790994`. Re-clusters those **name buckets** (Base Set Charizard
   joins 30th JP Charizard). Do not wait for a later `--all` pass.
   [VERSIONS.md](VERSIONS.md). `CardTile` stays the full leftover
   63:88 JPEG.
7. Empty leftover illustrators: OCR jsonl (leftover `ct_id`) plus
   `scripts/fill-missing-artists-from-ocr-io.js --apply`, then English
   pkmncards.com artist pages
   (`scripts/fill-missing-artists-from-pkmncards.js --artist=… --apply`),
   then CLIP `marketplace_copy_same_art_artists()` (skip energy names). All write
   `marketplace_blueprint_artists` (leftover PK). Trigger 073 copies onto
   `candidates.artist` by public `card_id`. Desk/search/home read that column
   — do not leftover-join the hot path. [ARTISTS.md](ARTISTS.md).

Public id = leftover `ct_id × 2`. Set desk path is `/marketplace/sets/{slug}`
(no `/en/`). `ct_id` stays on candidates for CDN filenames and CardTrader.
