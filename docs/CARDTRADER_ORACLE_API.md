# cardtrader-oracle-api

The CardTrader HTTP API and GET dump live on Oracle `pokoin-marketplace`
(`130.61.251.250`). They are **not** `api.pokoin.com`. Public marketplace
traffic stays on the Pi replica of nezopt NVMe Postgres.

Giuseppe 2026-09-12: call this process **`cardtrader-oracle-api`**. Do not
name it `pokoin-oracle-api` on Oracle (that container name is the Pi public
API). Do not alias `api.pokoin.com` here.

## What it is

| Piece | Value |
| --- | --- |
| Host | Oracle `pokoin-marketplace` |
| Container | `cardtrader-oracle-api` (`node:20-bookworm`, `--network host`, `--restart unless-stopped`) |
| Code | `/home/ubuntu/cardtrader-oracle-api/current` ← rsync of `cardvault/pokemon_card_vault` |
| Env | `/home/ubuntu/cardtrader-oracle-api/.env` (mode 600, not in git) |
| Listen | `0.0.0.0:18080` on the Oracle VM only |
| Process | `node server/oracle-api-server.js` (full route manifest) |
| `/healthz` `service` | `cardtrader-oracle-api` (`POKOIN_API_SERVICE_NAME`) |
| Postgres | nezopt NVMe through reverse tunnel `127.0.0.1:15543` → `127.0.0.1:25432`. `MARKETPLACE_DATABASE_SSL=0` |
| Health skips | `PIPELINE_HEALTH_SKIP=valkey,meili,cdn` — those belong to the Pi public API. `ok` follows **postgres** (NVMe via tunnel). |

Valkey on this VM (`pokoin-valkey`) is optional local cache. It is not the Pi
marketplace Valkey.

## What it is not

- Not the SPA first hop. Vercel `/api/*` → `api.pokoin.com` → Pi
  `pokoin-oracle-api` `:18080` reading the replica at `127.0.0.1:5432`.
- Not Oracle Docker Postgres. Persist/SQL is the nezopt NVMe writer
  (the container keeps the historical `15t` name; HDD is rollback only).
- Not a second CardTrader crawl. One flocked dump at a time.

## Dump job (GET stays here)

`pokoin-cardtrader-daily-market-refresh.service` still runs on Oracle:

```
GET /marketplace/products?expansion_id=   (CardTrader, ~834 sets)
  → persist into the nezopt NVMe writer via 127.0.0.1:15543
```

Satellite games (One Piece, Riftbound, Magic, Yu-Gi-Oh, …) use this same
ingest point. Oracle GETs CardTrader JSON (and scan bytes); the nezopt NVMe
writer is the writer. Isolated `pokoin_*` databases stream to the Pi replica. Leftover
JPEGs land on the NVMe leftover tree, not Pi `/srv/pokoin/card-images`. Map:
[MULTIGAME_REIMPORT.md](MULTIGAME_REIMPORT.md).

Per-game ingest HTTP APIs: Docker `cardtrader-game-ingest-api` on Oracle
`127.0.0.1:18082` (`/api/ingest/magic`, `/api/ingest/one-piece`, …). They
write isolated writer DBs. Pokemon is 404 there — public Pokemon stays
`pokoin-oracle-api` on the Pi. Install:
`scripts/install-cardtrader-game-ingest-api.sh`. Does not restart a dump.

Wrapper: `/home/ubuntu/pokoin-oracle-api/run-cardtrader-daily-market-refresh-docker.sh`
(`APP_ROOT` defaults to `$HOME/cardtrader-oracle-api`). Env:
`.env` on that tree (same 15T URL as the HTTP API). Drop-in
`scripts/pokoin-cardtrader-daily-nezopt.conf`. Tunnel unit on nezopt:
`pokoin-oracle-dump-pg-tunnel`.

Do not `systemctl restart` that oneshot while a crawl is `activating`.

## Recreate / deploy

From nezopt (this repo):

```bash
scripts/install-cardtrader-oracle-api.sh
```

That rsyncs cardvault **runtime** (api, server, scripts; skips Flutter
`build/` / `android/` / images), copies `node_modules` from the old
`/home/ubuntu/pokoin-oracle-api/current` if needed, writes `.env` from
`.env.cardtrader-nezopt`, removes leftover container `pokoin-oracle-api` on
Oracle, and starts `cardtrader-oracle-api`.

On Oracle only:

```bash
/home/ubuntu/cardtrader-oracle-api/run-cardtrader-oracle-api-docker.sh
curl -sS http://127.0.0.1:18080/healthz
# {"ok":true,"service":"cardtrader-oracle-api","checks":{"postgres":{"ok":true},...}}
```

`postgres.ok` must be true (tunnel + 15T). `ok` follows postgres only
(`PIPELINE_HEALTH_SKIP=valkey,meili,cdn`). Under a live dump, `/healthz`
uses `PIPELINE_HEALTH_TIMEOUT_MS=4000`.

## Topology

```
CardTrader.com
    ↑ GET JSON (Oracle VM, 1 GB micro) — not api.pokoin.com
cardtrader-oracle-api  :18080
    + daily dump docker (flock, complete-book)
    ├─ raw JSON  →  nezopt NVMe  (main SSD, not 15T)
    └─ persist   →  127.0.0.1:15543
                       ↓
nezopt NVMe Postgres :25432     historicization
  snapshots / sold_daily / observations / archiveMissing
                       ↓ streaming slot pokoin_pi_replica
Pi replica :5432               read-only, LAN 192.168.178.55:25432
                       ↓
api.pokoin.com  (container pokoin-oracle-api)
  GET /api/marketplace-card-sales  →  cardtrader_sold_daily
                       ↓
Vercel pokoin.com SPA  /api/* rewrite
```

**Who reads what**

| Hop | Disk | Job |
| --- | --- | --- |
| Oracle GET | Oracle RAM, then JSON copied to nezopt NVMe | Crawl CardTrader expansion products |
| nezopt writer | NVMe Postgres (container `pokoin-marketplace-postgres-15t`; HDD rollback only) | Historicization: live book + sold diffs |
| Pi | SSD replica of the writer | Public API + Meili/Valkey. No dump writes |
| SPA | none | `pokoin.com` → `api.pokoin.com` → Pi |

Card desk last-median and gold graph use replica `cardtrader_sold_daily`,
not `marketplace_card_weights`. Weights (homepage Best sellers) are a
separate 15-minute roll on the writer.

Sold comps from that dump are keyed by **seller stack** (seller + condition +
language + foil facets), not CardTrader product id. Cheap-25 “left the 25”
was wrong and is off the live path. Full map:
[MARKET.md](MARKET.md) → Listing pipeline → **Sold comps**.
Host map: [GAMES.md](GAMES.md).