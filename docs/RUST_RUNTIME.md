# Native Pokoin runtime

The production backend is native Rust across catalog, accounts, commerce, integrations, jobs, edge and CDN (cutover 2026-10-09). The Node API, edge, CDN, ct-deals server and Node timer jobs are stopped and their sources are no longer in this repository. Node is restricted to development, builds and isolated references (production rule in AGENTS.md). What still runs on Node, and the proposed replacement for each piece, is in [rust-migration/NODE_REMAINING.md](rust-migration/NODE_REMAINING.md).

## Topology on the Pi

One systemd unit, `pokoin-rust-api.service` ([deploy/systemd/pokoin-rust-api.service](../deploy/systemd/pokoin-rust-api.service)), runs `/srv/pokoin/rust/current` as user `nes`:

| Listener | Serves |
| --- | --- |
| `127.0.0.1:18079` edge | `api.pokoin.com` and `api2.pokoin.com` (cloudflared). Public GET micro-cache with request coalescing, sitemaps from `/srv/pokoin/seo`, `/livez` and `/readyz`. API paths go to the in-process router; `/card-images/*` goes to the in-process CDN. |
| `127.0.0.1:18082` API | The same router, for loopback health checks and smoke tests. |
| `127.0.0.1:18081` CDN | `cdn.pokoin.com`: disk objects under `/srv/pokoin/card-images/objects`, misses fall back to nezopt `:18088`. |
| `127.0.0.1:18090` ct-deals | The static ct-deals build in `/srv/pokoin/ct-deals/current/dist`. |

Native jobs run as `pokoin-rust-job@<name>.service` (`/srv/pokoin/rust/current job <name>`, one `flock` per job so runs never overlap), started by these timers:

| Timer | Job | Every |
| --- | --- | --- |
| `pokoin-rust-job-cardtrader-seller-reconcile.timer` | connected-seller CardTrader reconcile and webhook repair | 10 min after the last run ends |
| `pokoin-rust-job-eur-orders-sweep.timer` | expire stale Stripe holds, recover missed payments | 5 min |
| `pokoin-rust-job-referral-reconcile.timer` | Invite & Earn payouts | 10 min |
| `pokoin-rust-job-search-delta.timer` | Redis Search `pokoin:cards` delta | 2 min |

`MemoryMax=300M` in `pokoin-rust-job@.service` is not enforced on the Pi: its kernel command line has `cgroup_disable=memory`, so a job that grows only shows up as swap.

`job search-reindex` rebuilds the Redis Search index in full; run it by hand on the Pi, or let the nezopt `search-reindex` CronJob do it for the overflow.

Data: reads go to the Pi streaming replica `127.0.0.1:5432`, writes to the nezopt writer (`MARKETPLACE_WRITER_DATABASE_URL`, TLS `verify-full`), cache and search to Redis `127.0.0.1:6380`. Environment: `/srv/pokoin/rust/pokoin-api.env` (root:nes, 0640).

The Cloudflare Load Balancer also sends about 10% of `api.pokoin.com` to the nezopt k3s overflow, which runs the same commit built for x86_64: [NEZOPT_OVERFLOW.md](NEZOPT_OVERFLOW.md).

`scripts/pokoin-pi-watchdog.sh` (every 5 min) restarts `pokoin-rust-api` when any of the four listeners is down or `/livez` fails. A degraded `/readyz` (Postgres, Redis or CDN) never reboots the host. Install it with `scripts/deploy-pokoin-pi-watchdog.sh`.

## Code map

- `pokoin-rust/apps/api`: the binary. HTTP server by default, `job <name>` for the timers. System routes (`/livez`, `/readyz`, `/healthz`, `/api/__contract`, `/api/__routes`) are in `src/system.rs`.
- `pokoin-rust/crates/`: route crates `edge` (edge and CDN), `catalog-api`, `search-api`, `accounts`, `commerce`, `external` (CardTrader, Cardmarket, scan gateway, Power Tools, pricing), `admin-api`, `assistant-api`; domain and shared crates `catalog`, `search`, `marketplace`, `inventory`, `listings`, `sync`, `integrations`, `api-common`, `auth`, `cache`, `config`, `db`, `observability`.
- `pokoin-rust/apps/api/fixtures` and each crate's `fixtures/` hold golden contracts captured from the Node runtime, so the parity tests need no Node sources.

## Deploy

1. Merge to `main` and push. Build the clean aarch64 artifact from the exact `origin/main` commit: `cargo build --release --target aarch64-unknown-linux-gnu -p pokoin-api` in `pokoin-rust/` with `POKOIN_BUILD_COMMIT=<full sha>` and `POKOIN_BUILD_DIRTY=false` (the linker is set in `pokoin-rust/.cargo/config.toml`).
2. `scripts/deploy-pokoin-rust.sh`. It refuses anything but the clean `origin/main` checkout, copies the binary and `deploy/systemd/pokoin-rust-api.service`, and runs `scripts/install-pokoin-rust.py` on the Pi.
3. The installer checks the binary's embedded commit and digest, keeps the existing env settings, swaps the `current` symlink, restarts the unit and waits for health. A failed readiness check restores the previous binary, env file and unit. The prior release stays at `/srv/pokoin/rust/previous`; backups go to `/srv/pokoin/rust/rollbacks/`.

Timer or job-unit changes are installed with `scripts/cutover-pi-rust.sh` (it copies `deploy/systemd/pokoin-rust-job@.service`, the job timers and the watchdog).

## Rollback

- **Rust release:** a failed install restores itself. To go back by hand, point `/srv/pokoin/rust/current` at the `previous` target and restart `pokoin-rust-api`.
- **Back to Node (emergency only):** `scripts/cutover-pi-rust.sh --rollback` re-enables the Node edge, CDN, ct-deals and API container and the Node timers that are still installed (disabled) on the Pi. It needs no Node sources from this repository; it works as long as the Pi keeps `/srv/pokoin/api` and those units.

## Catalog identity and caching

Catalog responses bind the public Pokoin id, game and canonical URL to the request. Browser card pages resolve identity through the shared API; the legacy OG Worker no longer resolves or redirects browser desks from its canonical cache. Provider blueprint ids are used only for provider joins. The native read cache isolates query case, facets, optional sections, limits, language, game, catalog generation and release. A Redis generation-read failure bypasses caching. Catalog identity mismatches are rejected before persistence and logged without private request data.

The SPA retires card-page v1 and home-vector v3 cache keys and validates stored/received card identities. Authentication, carts and unrelated local data are preserved.

## Release safety

Deploy only the clean exact origin/main commit. Build with POKOIN_BUILD_COMMIT set to its full SHA and POKOIN_BUILD_DIRTY=false after confirming the source is clean. The Pi installer checks the binary's embedded commit and digest, preserves configured service bindings and traffic routing, and requires matching release plus Postgres/Redis readiness. A failed readiness check restores the prior binary, environment and systemd unit.

Run the relevant native and SPA tests, then the loopback Pi contract smoke. Capture the pre-release baseline, run scripts/deploy-pokoin-rust.sh, and monitor native/public health, identity, errors, latency, process restarts and memory for five minutes. Record these as operational before/after observations; do not describe cache smoke timings as a fair language benchmark.
