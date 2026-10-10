# Pi overflow on nezopt (k3s)

> **2026-10-09:** the overflow runs the native Rust binary (see *What runs on nezopt*); no Node.
>
> **Superseded in part (2026-10-07):** the edge overflow and NodePort `:30880` are retired. nezopt is a Cloudflare Load Balancer origin (Pi 0.9 / NEZ 0.1) behind its own tunnel; the Service is ClusterIP. Security baseline: [SECURITY_HARDENING.md](SECURITY_HARDENING.md).

`api.pokoin.com` is a Cloudflare Load Balancer (pool `pokoin-api`, monitor
`GET /readyz`) with two origins, both running the same native Rust release:

```
Cloudflare LB ─┬─ pi  (0.9) → Pi tunnel → Rust edge 127.0.0.1:18079 → in-process API
               └─ nez (0.1) → NEZ tunnel → cloudflared pods → Service pokoin-api:8080
                                          → Rust edge in each pod → in-process API
```

The Pi does not forward to nezopt any more; the load balancer splits traffic.
Writes, webhooks and checkout can land on either origin: both write to the
nezopt writer Postgres. Runtime details: [RUST_RUNTIME.md](RUST_RUNTIME.md).

## Edge micro-cache

The Rust edge (`pokoin-rust/crates/edge`) caches public GET responses in memory
(64 MB LRU, `POKOIN_API_CACHE_MB`), for the API's own `s-maxage` (else
`max-age`, capped at 300 s, `POKOIN_API_CACHE_MAX_TTL`) plus
`stale-while-revalidate`:

- Only GETs without `Authorization`/`Cookie`; only `200`, `public`, no
  `private`/`no-store`/`no-cache`/`Set-Cookie`, not `text/event-stream`, ≤ 2 MB.
- Key: path + query + `x-pokoin-game` + `x-pokoin-host`.
- **Coalescing**: concurrent misses for one key make one upstream request;
  the rest get `COALESCED`. Expired entries inside the SWR window are served
  `STALE` while one refresh runs. This removes the home-feed stampede.
- Responses that must not be stored are streamed straight through
  (`BYPASS`), and their path skips coalescing for 5 min.
- Headers `x-pokoin-edge-cache: HIT | MISS | STALE | COALESCED | BYPASS` and
  `x-pokoin-origin: rust`; a per-minute `pokoin-api-edge minute` log line
  (`journalctl -u pokoin-rust-api` on the Pi).

## What runs on nezopt (Rust, since 2026-10-09)

k3s runs **inside Docker** (container `pokoin-k3s`, image `rancher/k3s`), so
nothing is installed on the host: `docker rm -f pokoin-k3s` removes it.
Data lives in `~/pokoin-overflow/`. Manifest: `infra/k3s/pokoin-overflow.yaml`,
namespace `pokoin-overflow`. No Node runs here.

| Piece | What |
| --- | --- |
| `pokoin-api` | The Pi's exact Rust release (same commit, **x86_64** build) in `gcr.io/distroless/cc-debian12:nonroot`, HPA **2 → 4** pods at 60 % CPU. Each pod serves the full api.pokoin.com **edge** on `:8080` (micro-cache, sitemaps, API on pod loopback `:18082`). Reached only through the in-cluster `cloudflared` (Cloudflare LB origin, Pi 0.9 / NEZ 0.1). |
| `search-delta` | CronJob every 2 min: `pokoin-api job search-delta`, the Redis Search delta (same job as the Pi timer). A missing index (Redis restarted) is rebuilt in full. |
| `search-reindex` | CronJob 03:17: `pokoin-api job search-reindex`, full rebuild of the `pokoin:cards` index (drift guard). |
| `redis` | Redis 8 with Search: the overflow's own search index and cache. |
| `meili` | Rollback-only Meilisearch copy. Search runs on Redis (`MARKETPLACE_SEARCH_ENGINE=redis`); nothing syncs Meili any more. |

Pods differ from the Pi only where they must:

- **Database:** they read and write the **writer Postgres** on nezopt (the Pi reads its replica), on the private Docker network `pokoin-overflow` (writer `172.31.250.10`, k3s `172.31.250.20`), TLS `verify-full` with the Pokoin PG CA. UFW drops container → host traffic, which is why the host LAN URL is not used.
- **Redis:** `redis.pokoin-overflow.svc.cluster.local:6379`.
- **Outbox worker:** off (`POKOIN_LISTING_SYNC_WORKER=0`). It runs on the Pi only.
- **CDN:** no card images on nezopt. Non-Pokémon game image paths on api.pokoin.com proxy to `https://cdn.pokoin.com`. Pokémon image paths 404 here, as they did with the Node overflow. Images normally load from cdn.pokoin.com, which is not load-balanced.

## Staying in sync with the Pi

`pokoin-overflow-sync.timer` (user systemd on nezopt, every 5 min) runs
`~/pokoin-overflow/bin/nezopt-k3s.sh sync`. It does three things:

1. **Secret.** `pokoin-api-env` is rebuilt from the **running Pi Rust service**: `/proc/<MainPID>/environ` of `pokoin-rust-api`, which is the env file after systemd unquoting. Pi-only keys (listeners, CDN/SEO paths, trusted proxies, Valkey, the outbox worker flag) are dropped. Loopback database URLs point at the writer as described above.
2. **Sitemaps.** `/srv/pokoin/seo` is rsynced to `~/pokoin-overflow/data/seo`, which is mounted at `/srv/pokoin/seo` in the pods.
3. **Release.** The Pi's commit is read from `/srv/pokoin/rust/current --version`. If `~/pokoin-overflow/data/rust/current` is a different commit, the script builds that commit for x86_64 and rolls the pods:
   - The build runs in a detached worktree of `~/Projects/pokoin-web` at `~/pokoin-overflow/src`, with target dir `~/pokoin-overflow/build/target`, `--locked`.
   - The binary's `--version` must report the same commit.
   - The script keeps 3 releases.

So a Rust deploy to the Pi reaches nezopt on the next timer run, plus build time: about 1 minute incremental, longer on a cold target dir.

## Commands

```bash
scripts/nezopt-k3s.sh status        # pods, HPA, CronJobs, release vs Pi commit, a pod's /readyz
scripts/nezopt-k3s.sh sync          # force a secret/sitemap/release sync now
scripts/nezopt-k3s.sh secret        # only rebuild the env secret from the Pi Rust service
scripts/nezopt-k3s.sh apply         # after editing the manifest (also deletes the retired meili-* CronJobs)
scripts/nezopt-k3s.sh reindex       # rebuild the Redis Search index now
scripts/nezopt-k3s.sh install       # (re)install the sync timer and its script copy
scripts/nezopt-k3s.sh down          # stop k3s (the Pi keeps serving alone)
```

Rollback to the previous ReplicaSet: `docker exec pokoin-k3s kubectl -n pokoin-overflow rollout undo deploy/pokoin-api`.

## History: the Node overflow (2026-09-29 → 2026-10-09)

Until the Rust cutover the Pi ran a Node edge that sent GET/HEAD requests to
nezopt (NodePort `:30880`, retired 2026-10-07) only when 16 or more requests
were in flight to the Pi's Node API, and the pods ran the Pi's Node release.
The measurements below are from that setup.

## Measured (2026-09-29)

- Same query on both origins: identical groups, count and first printings;
  nezopt 11 ms vs Pi 36 ms (suggest).
- Production, from the Pi through the live edge, 40 concurrent distinct searches
  for 10 s: **186 req/s** (Pi alone ~65), 1318 served by nezopt / 538 by the Pi,
  0 errors (localMax 24); 157 req/s, 1137 / 434, 0 errors at localMax 16.
- nezopt alone, 32 concurrent suggest for 60 s: HPA 1 → 4 pods in ~40 s,
  **532 req/s**, p50 60 ms, p95 89 ms, 0 errors (Pi alone: ~65 req/s).
