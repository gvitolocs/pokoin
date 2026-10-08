# Native Pokoin runtime

The completed production backend is native Rust across catalog, accounts, commerce, integrations, jobs, edge and CDN. Node is restricted to development, builds and isolated references. See the production rule in AGENTS.md.

## Incremental rollout

The first release upgrades the existing native suggest/search routes. Card-page and card-tiles have native read models; optional offers, CardTrader sales and sameAs sections must be integrated and verified before moving card-page traffic. Account, commerce and integration work is isolated in separate worktrees and is not enabled by this release. This is not a completed backend migration.

Catalog responses bind the public Pokoin id, game and canonical URL to the request. Browser card pages resolve identity through the shared API; the legacy OG Worker no longer resolves or redirects browser desks from its canonical cache. Provider blueprint ids are used only for provider joins. The native read cache isolates query case, facets, optional sections, limits, language, game, catalog generation and release. A Redis generation-read failure bypasses caching. Catalog identity mismatches are rejected before persistence and logged without private request data.

The SPA retires card-page v1 and home-vector v3 cache keys and validates stored/received card identities. Authentication, carts and unrelated local data are preserved.

## Release safety

Deploy only the clean exact origin/main commit. Build with POKOIN_BUILD_COMMIT set to its full SHA and POKOIN_BUILD_DIRTY=false after confirming the source is clean. The Pi installer checks the binary's embedded commit and digest, preserves configured service bindings and traffic routing, and requires matching release plus Postgres/Redis readiness. A failed readiness check restores the prior binary, environment and systemd unit.

Run the relevant native and SPA tests, then the loopback Pi contract smoke. Capture the pre-release baseline, run scripts/deploy-pokoin-rust.sh, and monitor native/public health, identity, errors, latency, process restarts and memory for five minutes. Record these as operational before/after observations; do not describe cache smoke timings as a fair language benchmark.
