# Pi overflow on nezopt (k3s)

> **2026-10-09:** the overflow runs the native Rust binary (see *What runs on nezopt*); no Node.
>
> **Superseded in part (2026-10-07):** the edge overflow and NodePort `:30880` are retired. nezopt is a Cloudflare Load Balancer origin (Pi 0.9 / NEZ 0.1) behind its own tunnel; the Service is ClusterIP. Security baseline: [SECURITY_HARDENING.md](SECURITY_HARDENING.md).
>
> **2026-10-14:** overflow pods reach Hermes (Poko chat) through the `pokoin-hermes-bridge` container; see [Host services through socat bridges](#host-services-through-socat-bridges).

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
- A coalesced fetch and its waiters give up after 60 s with `504`
  (`POKOIN_API_FLIGHT_TIMEOUT_SECS`). A `5xx` (a handler panic answers `500`)
  goes to every waiter and is not stored; the next request fetches again. If
  the leader's client hangs up, a waiter takes over the fetch.
- Responses that must not be stored are streamed straight through
  (`BYPASS`); a `2xx`/`3xx` one also makes its path skip coalescing for 5 min.
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
- **Scan and Hermes:** the Pi's loopback SSH tunnels do not exist in a pod, so pods reach those two host services through socat bridges on the same Docker network (next section).

## Host services through socat bridges

UFW drops container → host traffic, so a pod cannot call a service on the
nezopt host loopback. Each such service gets a bridge: a privileged
`alpine:3.20` container (`--pid host`, `--restart unless-stopped`) on the
Docker network `pokoin-overflow` that runs `socat` on a fixed address and,
per connection, enters the host network namespace (`nsenter -t 1 -n`) to
reach the loopback port.

| Container | Pods call | Host target | Used by |
| --- | --- | --- | --- |
| `pokoin-scan-bridge` | `172.31.250.12:18151` | `127.0.0.1:8099`, the pokoin-scanner GPU recognition worker | `SCAN_PRIMARY_URL` / `SCAN_FALLBACK_URL` in the manifest |
| `pokoin-hermes-bridge` | `172.31.250.13:18789` | `127.0.0.1:18789`, `oracle-poko-tunnel.service` → oracle-peer1 Hermes `127.0.0.1:8789` | `POKO_CHAT_URL` / `POKONTACT_SERVICE_URL`, rewritten by the secret sync |

`scripts/nezopt-k3s.sh network` (also run by `up`, `sync` and `secret`)
creates a missing bridge and starts a stopped one; it never recreates a
running bridge. The `pokoin-api` NetworkPolicy in
`infra/k3s/pokoin-security.yaml` allows egress to exactly these two
address:port pairs. Without the Hermes bridge, website chat failed
(`source: "unavailable"`) for every request the load balancer sent to
nezopt (fixed 2026-10-14).

## Staying in sync with the Pi

`pokoin-overflow-sync.timer` (user systemd on nezopt, every 5 min) runs
`~/pokoin-overflow/bin/nezopt-k3s.sh sync`. It does three things:

1. **Secret.** `pokoin-api-env` is rebuilt from the **running Pi Rust service**: `/proc/<MainPID>/environ` of `pokoin-rust-api`, which is the env file after systemd unquoting. Pi-only keys (listeners, CDN/SEO paths, trusted proxies, Valkey, the outbox worker flag) are dropped. Loopback database URLs point at the writer as described above. Loopback `POKO_CHAT_URL` / `POKONTACT_SERVICE_URL` (the Pi's Hermes tunnel) become `http://172.31.250.13:18789/api/poko`, the Hermes bridge.
2. **Sitemaps.** `/srv/pokoin/seo` is rsynced to `~/pokoin-overflow/data/seo`, which is mounted at `/srv/pokoin/seo` in the pods.
3. **Release.** The Pi's commit is read from `/srv/pokoin/rust/current --version`. If `~/pokoin-overflow/data/rust/current` is a different commit, the script builds that commit for x86_64 and rolls the pods:
   - The build runs in a detached worktree of `~/Projects/pokoin-web` at `~/pokoin-overflow/src`, with target dir `~/pokoin-overflow/build/target`, `--locked`.
   - The binary's `--version` must report the same commit.
   - The script keeps 3 releases.

So a Rust deploy to the Pi reaches nezopt on the next timer run, plus build time: about 1 minute incremental, longer on a cold target dir.

The timer runs the copies in `~/pokoin-overflow/bin` (the script, `infra/k3s/pokoin-overflow.yaml` and
`infra/k3s/pokoin-security.yaml`) that `install` makes, never a git checkout, so a repository change reaches the
timer only after `scripts/nezopt-k3s.sh install`.

## Commands

```bash
scripts/nezopt-k3s.sh status        # pods, HPA, CronJobs, release vs Pi commit, a pod's /readyz
scripts/nezopt-k3s.sh sync          # force a secret/sitemap/release sync now
scripts/nezopt-k3s.sh secret        # only rebuild the env secret from the Pi Rust service
scripts/nezopt-k3s.sh apply         # after editing either manifest (applies both; also deletes the retired meili-* CronJobs)
scripts/nezopt-k3s.sh reindex       # rebuild the Redis Search index now
scripts/nezopt-k3s.sh install       # (re)install the sync timer and its script + manifest copies
scripts/nezopt-k3s.sh network       # Docker network, DB attachments, scan + Hermes bridges (idempotent)
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
