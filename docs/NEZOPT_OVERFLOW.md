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
It picks an origin per request (`random` steering), CORS preflights included,
and the 60 s `/readyz` monitor does not notice a pod crash loop of a few
minutes. While nezopt is down, its share of requests gets a 502 from its tunnel:
a failed preflight makes the browser `fetch` throw, which the SPA showed as
"The network request failed." (Profile Poko link code and seller setup,
2026-10-15). `market/src/api-retry.js` now retries such gateway failures
(network error, 502, Cloudflare 52x/530) twice: reads always, writes only with
`retry: true`. That hides a flapping origin from the page; it does not fix it.
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
- **CDN:** the pods also serve the cdn.pokoin.com origin `nez-k3s` (port 8081) from the read-only leftover mirror plus `poko-video/`. A miss falls back to the Pi's own CDN (see *Staying in sync with the Pi*).
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

> **2026-10-28:** event-driven instead of a 5-minute poll, quiet while the Pi is offline, env from the
> Pi's env file instead of `/proc` (Infisical next). Before → after numbers: end of this section.

**Triggers.** The Pi tells nezopt when something changed, and nezopt pulls with its own access:

| Pi side (`scripts/install-pi-overflow-notify.sh`) | Notice | nezopt runs |
| --- | --- | --- |
| `pokoin-overflow-notify.path` on `/srv/pokoin/rust/` (the `current` symlink swap of a deploy, an edit of `pokoin-api.env`) | `release` | `pokoin-overflow-sync.service` |
| `poko-video-notify.service` (`inotifywait -r` on `poko-video/`, 3 s debounce) | `video` | `poko-video-mirror.service` |

A notice is `ssh nez@nezopt <verb>` with the key `/etc/pokoin/overflow-notify/id_ed25519`. It is sent as the
Pi user `pokoin-notify`, which has no shell and only a traverse ACL on `/srv/pokoin/card-images`. It is
not in group `nes`, which can read the API env file. nezopt's `authorized_keys` pins it to `restrict,from="192.168.178.46",command="~/.local/bin/pokoin-pi-hook"`,
which only touches a stamp and starts the unit. A notice that arrives during a run makes that run go
again (`follow` in `nezopt-k3s.sh`). The timers stay as an hourly backstop
(`install-ops-nezopt.sh pi-hooks-live`, installed 2026-10-28).

**`sync`** (`nezopt-k3s.sh sync`):

1. **Secrets.** `pokoin-api-env` / `pokoin-jobs-env` are built from the API env, from `POKOIN_ENV_SOURCE`:
   - `pi-file` (default): the Pi's `/srv/pokoin/rust/pokoin-api.env`, parsed like systemd's `EnvironmentFile=`.
     `nezopt-k3s.sh env-diff` lists key names that differ from the running process: none on 2026-10-28,
     and both sources give the same secret hash.
   - `pi-proc`: the old `/proc/<MainPID>/environ` read.
   - `infisical`: `secret://pokoin-runtime/prod#POKOIN_API_ENV` (the whole env file as one value) through
     `infisical-broker exec`. The value only exists inside the child that applies the secret. Needs the owner (below).

   Then the same rewrites as before (Pi-only keys dropped, loopback database URLs → writer, Hermes → bridge,
   least-privilege logins). The secrets carry `pokoin.com/env-sha256`. They are applied only when that hash
   changes, and a change rolls the pods. Before, a Pi env change only reached pods that happened to restart.
2. **Sitemaps and extension zips**, as before.
3. **Release**, as before: the Pi's commit, an x86_64 build from a detached worktree, a rollout.

**Videos.** `nezopt-k3s.sh video`: `rsync -a` from the Pi into the CDN root, **never `--delete`**. On a
miss the k3s CDN falls back to the Pi's own CDN: `POKOIN_CDN_FALLBACK_ORIGIN=http://172.31.250.15:18181`
→ `pokoin-pi-cdn-bridge` → `pokoin-pi-cdn-tunnel.service` (`ssh -L 18181:127.0.0.1:18081 pi-home`). It is never
cdn.pokoin.com, which would route back here. The fallback covers the game prefixes. `poko-video/`
(`POKOIN_CDN_FALLBACK_EXTRA_PREFIXES`) needs a release that contains the cdn.rs change, and a request
that is itself a fallback fetch (`user-agent: pokoin-cdn-fallback`) is never forwarded again.

**Pi offline is a state, not a failure.**

- Every Pi-dependent unit has `ExecCondition=~/.local/bin/pokoin-pi-up` (a 4 s TCP probe of the Pi's
  port 22). The units are the sync, the video mirror, and the scan, Honcho, tcgprices and CDN tunnels. While
  the Pi is down they skip: no failure, no `OnFailure=` mail. A skip also ends `Restart=always`.
- `pokoin-pi-health.timer` (every minute, `pokoin-ops pi-health`) keeps `~/.local/state/pokoin-ops/pi-health.json`.
  - After 3 failed probes it sends **one** mail + Secretary push ("Pi offline"). It pauses the `pi-*`
    and `nezopt-overflow-sync` healthchecks, which resume on their next ping.
  - When the Pi answers again it sends **one** "Pi back after …". It starts the enabled tunnels again and
    runs the sync and the video mirror once.
  - A blip under 3 minutes alerts nobody; the next run restarts any tunnel the blip skipped.
- The sentinel mutes findings for those units, and `replication.standby` / `replication.lag`, while
  pi-health says the Pi is down (`pi::mute`). A timer whose last run was a condition skip is OK.

**Install / undo.** nezopt: `scripts/backup/install-ops-nezopt.sh pi-follow`. Pi (owner's OK):
`scripts/install-pi-overflow-notify.sh install`, then `install-ops-nezopt.sh pi-hooks-live`.
`scripts/install-pi-overflow-notify.sh remove` takes the Pi side out and puts the 5-minute timers back.

**Secrets from Infisical (owner steps).** Each one is an owner action:
1. An Infisical project `pokoin-runtime` (env `prod`) with `POKOIN_API_ENV` = the Pi env file.
2. A broker caller `svc-pokoin-overflow-sync` (class services, `bind_unit = "pokoin-overflow-sync.service"`),
   with `broker-services` as viewer on the project.
3. A Pi machine identity (viewer) whose credentials are in systemd-creds on the Pi. A Pi-side render step
   writes `pokoin-api.env` from the same secret and keeps the last good file when Infisical is unreachable,
   so the Pi service never depends on Infisical being up.
4. `Environment=POKOIN_ENV_SOURCE=infisical` on `pokoin-overflow-sync.service`. Check first with
   `POKOIN_SECRET_DRY_RUN=1 POKOIN_ENV_SOURCE=infisical nezopt-k3s.sh secret`: the hash must equal the `pi-file` one.

**Maintenance.** Before planned work on the Pi, run `pokoin-ops pi-health --maintenance 2h --reason "…"` on
nezopt. One notice says the window is open, and the Pi's healthchecks are paused. Down/back alerts are held
until the window ends; if the Pi is still down then, the "Pi offline" alert goes out with a note about
the window. `--end-maintenance` closes it early. The 2026-10-28 outage was planned work of this kind:
an SSD moved to another USB port, 13:44 → 15:33 UTC.

**Measured (2026-10-28).**

| | Before | After |
| --- | --- | --- |
| sync + video mirror runs | about 288 + 288 a day (5-minute timers) | about 24 + 24 a day (hourly backstop), plus one per Pi release or upload. `pi-health` adds 1,440 runs a day of about 35 ms each. |
| a Pi outage (2026-10-28, 09:10 → 15:34 UTC) | 1,864 notifier runs; about 10 failure mails, each with a Secretary push; sentinel CRITs; healthchecks emails | drill: 0 notifier runs, 1 "offline" + 1 "back"; none inside a declared maintenance window |
| upload on the Pi → in the nezopt CDN | up to 5 minutes | 4.5 s (3 s of it is the debounce) |
| Pi release → nezopt sync starts | up to 5 minutes | about 12 s (10 s settle delay on the Pi) |

## Commands

```bash
scripts/nezopt-k3s.sh status        # pods, HPA, CronJobs, release vs Pi commit, a pod's /readyz
scripts/nezopt-k3s.sh sync          # force a secret/sitemap/release sync now
scripts/nezopt-k3s.sh secret        # only rebuild the env secrets (POKOIN_ENV_SOURCE; applied when the hash changes)
scripts/nezopt-k3s.sh video         # poko-video mirror now (additive)
scripts/nezopt-k3s.sh env-diff      # key names that differ between the Pi process env and its env file
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
