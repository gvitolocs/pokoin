# Pi overflow on nezopt (k3s)

`api.pokoin.com` is served by the Raspberry Pi. When many people search at
once, the Pi's single Node API saturates (~65 suggest req/s, ~25 search-page
req/s on 2026-09-29). nezopt now carries the overflow.

```
Cloudflare tunnel → Pi pokoin-api-edge :18079 ─┬─ Pi API :18080 (always first)
                                               └─ nezopt :30880 (k3s) — GET/HEAD only,
                                                  when the Pi has ≥ LOCAL_MAX in flight
```

## How requests are routed

`scripts/pokoin-api-edge.js` on the Pi counts requests in flight to the Pi API.

- Below `POKOIN_API_LOCAL_MAX` (16 — the Pi's p95 stays ≈ 400 ms there): everything goes to the Pi, as before.
- At or above it: **GET/HEAD** API requests go to nezopt, but only while nezopt
  answers a real suggest probe every 5 s (2 s timeout).
- **Writes, webhooks, uploads, checkout** (any other method) always stay on the Pi.
- If an overflow request cannot connect, it is retried on the Pi and nezopt is
  marked unhealthy until the next good probe.
- Every response carries `x-pokoin-origin: pi` or `nezopt`.
- If nezopt is off, the Pi behaves exactly as before the overflow existed.
- If the **Pi API refuses the connection** (restart, crash), GET/HEAD requests
  go to nezopt when it is healthy instead of answering 502.

## Edge micro-cache

The edge also caches public GET responses in memory (64 MB LRU,
`POKOIN_API_CACHE_MB`), for the API's own `s-maxage` (else `max-age`, capped
at 300 s) plus `stale-while-revalidate`:

- Only GETs without `Authorization`/`Cookie`; only `200`, `public`, no
  `private`/`no-store`/`no-cache`/`Set-Cookie`, not `text/event-stream`, ≤ 2 MB.
- Key: path + query + `x-pokoin-game` + `x-pokoin-host`. API responses carry
  `Access-Control-Allow-Origin: *`, no `Vary` and no compression.
- **Coalescing**: concurrent misses for one key make one upstream request;
  the rest get `COALESCED`. Expired entries inside the SWR window are served
  `STALE` while one refresh runs. This removes the home-feed stampede.
- Responses that must not be stored are streamed straight through
  (`BYPASS`), and their path skips coalescing for 5 min.
- Header `x-pokoin-edge-cache: HIT | MISS | STALE | COALESCED | BYPASS`;
  a per-minute summary line goes to `journalctl -u pokoin-api-edge`.

## What runs on nezopt

k3s runs **inside Docker** (container `pokoin-k3s`, image `rancher/k3s`), so
nothing is installed on the host: `docker rm -f pokoin-k3s` removes it.
Data lives in `~/pokoin-overflow/`. Manifest: `infra/k3s/pokoin-overflow.yaml`,
namespace `pokoin-overflow`.

| Piece | What |
| --- | --- |
| `pokoin-api` | The Pi's exact API release (`node server/oracle-api-server.js`), HPA **1 → 4** pods at 60 % CPU, NodePort **30880** on `192.168.178.55` |
| `meili` | Meilisearch **v1.53.1** (production pin) copy of `marketplace_cards` + `marketplace_name_tokens` |
| `meili-delta` | CronJob every 2 min — the Pi's own `scripts/meili-sync-marketplace-delta.js` |
| `meili-full` | CronJob 03:17 — full rebuild of both indexes (drift guard) |
| Redis | Stays on the Pi (`pokoin-redis` `:6380`). Overflow pods do not run a second cache. |

Overflow pods **read from the writer Postgres** on nezopt (freshest data; the Pi
reads its replica). UFW drops container → host traffic, so pods reach the writer
*container* on the user-defined Docker network `pokoin-overflow`
(writer `172.31.250.10`, k3s `172.31.250.20`); the secret key
`MARKETPLACE_OVERFLOW_DATABASE_URL` is the writer URL with that host, and
`MARKETPLACE_WRITER_DATABASE_URL` is rewritten to the same URL — the Pi's LAN
writer URL (`192.168.178.55:25432`) times out from pods, so overflowed Scan
Connect requests (scan-stream / scan-batch use the writer pool) failed with
"Scan service error.".

## Staying in sync with the Pi

`pokoin-overflow-sync.timer` (user systemd on nezopt, every 5 min) runs
`~/pokoin-overflow/bin/nezopt-k3s.sh sync`:

- the secret `pokoin-api-env` is rebuilt from the **running Pi container's**
  environment (the Pi `.env` file misses keys set at run time) — never committed;
- when the Pi's `/srv/pokoin/api/current` release changes, it is rsynced to
  `~/pokoin-overflow/data/api/releases/` and the pods restart.

So an API deploy to the Pi reaches nezopt within ~5 minutes.

The overflow API's pipeline health probe uses
`POKOIN_CDN_HEALTH_URL=https://cdn.pokoin.com/health` with a 2-second timeout.
The Pi keeps its local HTTP probe on `127.0.0.1:18081`; that address is not a
CDN inside a Kubernetes API pod. The shared `_pipeline_health.js` supports
both HTTP and HTTPS. All four dependency checks remain active.

## Commands

```bash
scripts/nezopt-k3s.sh status        # pods, HPA, overflow health
scripts/nezopt-k3s.sh sync          # force a release/env sync now
scripts/nezopt-k3s.sh apply         # after editing the manifest
scripts/nezopt-k3s.sh meili-full    # rebuild the Meili copy now
scripts/nezopt-k3s.sh install       # (re)install the sync timer
scripts/nezopt-k3s.sh down          # stop k3s (Pi keeps serving alone)
scripts/deploy-pokoin-api-edge.sh   # ship the edge from origin/main (overflow on)
POKOIN_API_OVERFLOW_ORIGIN= scripts/deploy-pokoin-api-edge.sh   # overflow off
```

## Measured (2026-09-29)

- Same query on both origins: identical groups, count and first printings;
  nezopt 11 ms vs Pi 36 ms (suggest).
- Production, from the Pi through the live edge, 40 concurrent distinct searches
  for 10 s: **186 req/s** (Pi alone ~65), 1318 served by nezopt / 538 by the Pi,
  0 errors (localMax 24); 157 req/s, 1137 / 434, 0 errors at localMax 16.
- nezopt alone, 32 concurrent suggest for 60 s: HPA 1 → 4 pods in ~40 s,
  **532 req/s**, p50 60 ms, p95 89 ms, 0 errors (Pi alone: ~65 req/s).
