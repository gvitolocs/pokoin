# Node.js that remains after the Rust cutover (2026-10-10)

The shared Pokoin backend has run as native Rust since 2026-10-09
([RUST_RUNTIME.md](../RUST_RUNTIME.md)). The retired Node backend was removed
from this repository: the API handlers and server, the edge, the CDN server,
the Node timer units, and the per-handler overlay deploy scripts.
The last commit that still has those sources is
`234defa6ce886ddb5d253f79badc8c7079868c18`, so
`git show 234defa6:server/pokoin-api/<file>` reads any of them.

This file lists every Node usage that is left, in four groups:

1. Backend services and jobs that still run on Node in production. Each has a proposed Rust replacement.
2. Behaviour that only the Node backend had and Rust does not do yet.
3. Stopped Node pieces that something still depends on.
4. Node used for builds, tests and tooling. These stay.

## 1. Production backend still on Node

None of these runs from Node sources in this repository: the two Oracle
services run a CardVault checkout. The production rule in AGENTS.md says
production backend jobs must be native Rust, so each needs a replacement.

| What | Where and how it runs | Repo files | Proposed Rust replacement |
| --- | --- | --- | --- |
| **`cardtrader-oracle-api`** (CardTrader GET host) | Oracle `pokoin-marketplace` (E2 micro, x86_64), Docker `node:20-bookworm` running `node server/oracle-api-server.js` from an rsync of `cardvault/pokemon_card_vault`, `0.0.0.0:18080` on the VM only. [CARDTRADER_ORACLE_API.md](../CARDTRADER_ORACLE_API.md) | `scripts/install-cardtrader-oracle-api.sh`, `scripts/run-cardtrader-oracle-api-docker.sh` | The full route manifest on Oracle is not public traffic. First find what still calls `:18080` on Oracle (the daily dump below is the known user). Then stop the container, or run the x86_64 `pokoin-api` build (the binary the k3s overflow already uses) with only the routes that are still called. |
| **CardTrader daily market dump** | Oracle `pokoin-cardtrader-daily-market-refresh.service` → CardVault `run-cardtrader-daily-market-refresh-docker.sh` (Node, `NODE_OPTIONS=--max-old-space-size=768`). Persists to the nezopt writer through the reverse tunnel. | `scripts/pokoin-cardtrader-daily-lock.conf`, `scripts/pokoin-cardtrader-daily-nezopt.conf`, `scripts/cardtrader-market-rows.js` (helper copied next to the job) | `pokoin-rust/crates/external/src/daily_refresh.rs` is a native port of the global snapshot refresh, behind the secret-gated `/api/cardtrader-daily-listings-refresh` route. Add a `job cardtrader-daily-refresh` entry in `apps/api/src/jobs/mod.rs` that calls it with the same options. Run the x86_64 binary on Oracle from a systemd timer, with the existing env file and tunnel. Compare one day's persisted rows (counts per expansion, `sold_daily` deltas) against the Node run before switching. |
| **`cardtrader-game-ingest-api`** | Oracle Docker `node:20-bookworm` running `node server/cardtrader-game-ingest-server.js` (CardVault), `:18082`, `/api/ingest/{game}` writing isolated per-game databases. [MULTIGAME_REIMPORT.md](../MULTIGAME_REIMPORT.md) | `scripts/install-cardtrader-game-ingest-api.sh`, `scripts/run-cardtrader-game-ingest-api-docker.sh` | `pokoin-rust/crates/external/src/game_ingest.rs` already has the registry (`ingest_games.json`, `ingest_schemas.json`), the secret gate, the `pokemon stays on the Pi` guard and `import`. Run the x86_64 `pokoin-api` on Oracle with `POKOIN_API_SERVICE_NAME=cardtrader-game-ingest-api` on `:18082`. Replay one small game import against a scratch database and diff the rows before switching. |
| **nezopt daily catalogue refresh** | `pokoin-all-cardtrader-daily.timer` → `scripts/run-all-cardtrader-daily.sh` runs `node scripts/refresh-all-cardtrader-catalogues.cjs --apply`. It requires CardVault's `scripts/cardtrader-multigame-import.js` and `node_modules/pg`. | `scripts/refresh-all-cardtrader-catalogues.cjs`, `deploy/systemd/pokoin-all-cardtrader-daily.*` | A `job catalogue-refresh` that loops the CardTrader games through `game_ingest::import` and runs the same post-import SQL (`pokoin_pokemon_expansions`, `marketplace_card_names`, `marketplace_card_urls` inserts). Run it from the same timer with the x86_64 binary. The Python steps of the daily run stay as they are. |
| **nezopt daily search upload** | The same daily run calls `node scripts/sync-refreshed-catalogue-search.cjs`. It builds Meili documents with CardVault's `api/_meili_document.js` and uploads them to the **Pi Meili**, reading the key from the stopped `pokoin-oracle-api` container's config. | `scripts/sync-refreshed-catalogue-search.cjs` | Meili is rollback-only now: production search is Redis Search, kept fresh by `job search-delta` every 2 min. Drop this step from `run-all-cardtrader-daily.sh` once `search-delta` is confirmed to pick up the rows this job selects (`projected_at >= run start` **or** `ct_id = any(refreshed picture ids)`). A picture-only refresh may not bump `projected_at`; if it does not, have the Rust job accept the same id list. |

Out of scope here: **Hypemeter** (`news.pokoin.com`, Next.js on Oracle A1,
repository `gvitolocs/hypemeter`) is a separate product, not the shared API.
Whether the Rust-only rule covers it is Giuseppe's call.

## 2. Behaviour only the Node backend had

| What | Effect today | Proposed Rust port |
| --- | --- | --- |
| **Scan Connect phone diagnostics** (`scan-diag-v2`). The Node `scan-phone` heartbeat called `recordDiagnostics` (`_scan_diagnostics.js`, 61 lines). It sanitized an allowlist of fields, deduplicated by session + run + sequence for 30 min, logged `scan-diagnostic` JSON and returned `diagnosticsVersion` + `diagnosticAck`. | The Rust heartbeat does neither. The phone shows **Logs unavailable**, and records stay pending in `pokoin.scanDiagnostics.v2` (capped at 2048). Scanning itself is unaffected. | Port the module into `pokoin-rust/crates/external` (same allowlist and caps, `tracing::info!(target: "scan-diagnostic", …)`). Return the two fields from the heartbeat in `routes/scan.rs`. Replace the removed cross-repo test with a fixture packet produced by `pokoin-scanner/service/web/static/scan-diagnostics.js`. |
| **Google Merchant listing sync**: `google-merchant/{client,config,sync,shipping,reconcile}.js` plus the `merchant` step of `_sync_engine.js`, and the offline diff CLI `scripts/google-merchant-reconcile.js`. It was gated by `GOOGLE_MERCHANT_ENABLED` and dry-run unless `GOOGLE_MERCHANT_DRY_RUN=0`. | The Rust listing outbox (`crates/commerce/src/listing_sync.rs`) still builds the `merchantListing` snapshot, but there is no Merchant API client, so nothing is pushed. `grep GOOGLE_MERCHANT /srv/pokoin/rust/pokoin-api.env` on the Pi shows whether it was ever live: the env file was seeded from the Node container. | If it is wanted: add a `merchant` step to the Rust outbox worker (Merchant API `productInputs` insert/delete, service-account JWT, the same flags and dry-run default), and port `reconcile.js` (55 lines, pure) as a unit-tested function. |

| **CardTrader sales backfill CLI** (`cardtrader-sales-backfill.js --uid <firebaseUid> [--apply]`), run by hand inside the Node container. For one connected seller it rebuilt historic sales from CardTrader seller orders: `marketplace_sales/ct_{order}__{item}`, claims in `cardtrader_webhook_events`, quantity capped at what CardTrader still has. | No way to run it now. New sales still arrive through the webhook and the 5-minute reconcile job; only historic backfills for newly connected sellers are affected. | A `job cardtrader-sales-backfill --uid <uid> [--apply]` in `apps/api/src/jobs/`, dry-run by default, reusing the CardTrader client and webhook claim code in `crates/external/src/cardtrader/`. Port the assertions of the removed `cardtrader-sales-backfill.test.js`. |

Already replaced, listed so nobody looks for them: `redis-search-reindex.js` →
`job search-reindex`; `redis-search-delta.js` / `meili-sync-marketplace-delta.js`
→ `job search-delta`; the EUR sweep, referral and CardTrader seller reconcile
timers → `pokoin-rust-job@*.timer`; the edge, CDN and ct-deals →
`pokoin-rust-api.service`.

## 3. Stopped Node pieces that something still depends on

| Item | Depends on it | Proposal |
| --- | --- | --- |
| Pi Node units, disabled but installed: Docker `pokoin-oracle-api` (`/srv/pokoin/api/current`), `pokoin-api-edge`, `pokoin-card-images`, `pokoin-ct-deals`, and the four Node timers | `scripts/cutover-pi-rust.sh --rollback` re-enables them. It needs no Node sources from this repository. | After an agreed stable period, remove the container, the units and `/srv/pokoin/api`, then drop the `--rollback` branch and `NODE_UNITS`/`NODE_TIMERS` from `cutover-pi-rust.sh`. |
| The stopped container's **configuration** | `scripts/install-pokoin-rust.py` merges `docker inspect pokoin-oracle-api` env into `/srv/pokoin/rust/pokoin-api.env` on **every** deploy; existing native values win. `sync-refreshed-catalogue-search.cjs` reads the Meili key the same way. | Before removing the container: make the native env file the only source (drop the merge, or skip it when the container is absent) and update `scripts/tests/test_install_pokoin_rust.py`, which mocks `docker inspect`. Otherwise the next Rust deploy fails once the container is gone. |
| `scripts/pokoin-web-origin.mjs` (Pi `pokoin-web-origin.service`, the old pokoin.com host) | Stopped since the Cloudflare Static Assets cutover (2026-10-04, [WEB_HOST.md](../WEB_HOST.md)). Its `/api/*` proxy targets `127.0.0.1:18079`, now the Rust edge. | Delete it once Giuseppe confirms the web rollback path is Vercel (as WEB_HOST.md describes), not the Pi. If a Pi fallback is wanted, the Rust edge could serve `dist-web` the way it serves ct-deals. |
| Oracle A1 marketplace plan: `scripts/migrate-marketplace-to-a1.sh`, `wait-and-migrate-a1.sh`, `oci-a1-2x12-hunt.sh` (runs the migration automatically once an A1 VM appears), `bootstrap-pokoin-a1.sh` | They would start a Node `pokoin-oracle-api` and Meili on A1 from a CardVault checkout. No hunt loop was running on nezopt on 2026-10-10. | Delete them, or, if A1 is still a hosting target ([MADRID_MARKETPLACE.md](../MADRID_MARKETPLACE.md)), rewrite the API step to install the Rust aarch64 release with `install-pokoin-rust.py`. |

The nezopt k3s overflow runs the Rust x86_64 binary since 2026-10-09
([NEZOPT_OVERFLOW.md](../NEZOPT_OVERFLOW.md)). Its remaining `meili` StatefulSet
is rollback-only Meilisearch, not Node.

## 4. Node that stays (builds, tests, tooling)

| Area | Files | Why it stays |
| --- | --- | --- |
| Web frontends | `market/` (React, Vite), `solid/` (Solid 2 shell), `home/`, `news/`, `explorer/` | Frontend build and unit tests (`node --test market/src/*.test.js`). Not a server. |
| Cloudflare Workers | `workers/*.js`, `wrangler.*.jsonc` | Run on Cloudflare (V8 isolates, not Node). Their tests use `node --test`. |
| Build-time generators | `scripts/build-{card-sitemaps,catalog-discovery,seo-sitemaps,site-map,ui-shell,news-site}.mjs`, `card-sitemap.mjs`, `write-cloudflare-web-routing.mjs`, `export-expansion-nationality.mjs`, `refresh-pokedex-sort.mjs` | Run by `build-web.sh`, `deploy-web.sh`, `publish-news.sh` and `refresh-site-map.sh` to produce static files. |
| Operator data scripts (nezopt, run by hand) | `fill-missing-artists-from-ocr-io.js`, `fill-missing-artists-from-pkmncards.js`, `pkmncards-artists.js`, `build-western-ocr-artists.js`, `import-catalog-languages.js`, `catalog-languages.js`, `import-set-release-languages.js`, `report-listing-collection-backfill.js` (dry-run report) | One-off catalogue maintenance against the writer, not scheduled. Port one to Rust only if it becomes scheduled. |
| Benchmarks and test harnesses | `bench/` (Playwright), `scripts/scan-connect-e2e.mjs`, `scan-connect-bench-*.mjs`, `check-search-ranking-tlc.sh` (TLA+ model input), `scripts/sql/cardtrader-sale-dedupe.test.js`, and the `*.test.*` files next to kept scripts | Development and verification only. |
