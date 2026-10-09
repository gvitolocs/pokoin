# Handoff: cache and sync engine

Saved from the nezopt session "Rust API cache and sync engine pass" (stopped 2026-10-09 to move the work to a cloud session). It had read the edge micro-cache, the Redis read cache, the live bus and SSE route, the outbox worker, the security layer and the Cache-Control values across routes. No source files were edited.

## Findings that shape the design
1. **Edge cache poisoning by satellite requests.** One request from a satellite origin (or with `x-pokoin-game`) without `?game=` gets `private, no-store` from the security layer. The edge then marks the whole path uncacheable for 5 minutes, so every visitor skips the edge cache. Not yet confirmed with a test: add one, then fix by keying the bypass on the game variant instead of the path.
2. **Pi replica lag.** Invalidation fires right after the commit on the nezopt writer, but the Pi serves reads from a hot-standby replica. A read in between can re-cache stale data under the new generation for 20–30 s. Plan: wait for the replica to replay the write (pg_last_wal_replay_lsn ≥ commit LSN, with a bounded wait) before the final invalidation, the live event and any Cloudflare purge.
3. **Outbox throughput.** The worker polls every 250 ms and handles one row per pass, so a burst of 100 events takes about 25 s. `pg_notify('pokoin_outbox')` is already sent on enqueue but nothing listens. Live events are only published by the worker.
4. **No perf on nezopt** (no sudo, `perf_event_paranoid=4`). Use the Server-Timing split (edge/app/db/redis), with DB time captured from sqlx query events.

## Planned
- Strong ETags with 304 at both the API and the edge.
- Server-Timing.
- Edge purge by tag over an in-process invalidation bus.
- A batched LISTEN/NOTIFY outbox worker.
- Cloudflare purge off by default. It would need `POKOIN_CF_PURGE=1` as well as `CLOUDFLARE_ZONE_ID`/`CLOUDFLARE_API_TOKEN`.

## Task (continue from here)
Repository gvitolocs/pokoin. Rust workspace: pokoin-rust/ (the binary is apps/api; one process serves the API, edge, CDN and jobs on a Raspberry Pi). Background: Postgres writer and replica, Redis 8, and Cloudflare in front of api.pokoin.com and cdn.pokoin.com.

Goal: optimize caching and make the sync engine event-driven. A change (a listing created or sold, a price update) should flow asynchronously into every cache and reach open browsers immediately, while public reads are served from cache. Response shapes of existing routes must NOT change.

Read first:
- pokoin-rust/crates/edge: an in-process micro-cache honouring s-maxage, max-age and stale-while-revalidate, with single-flight.
- apps/api/src/read_cache.rs
- crates/api-common/src/live.rs: an in-process listing bus. The SSE route /api/marketplace-live is in crates/catalog-api/src/market/live.rs.
- crates/commerce/src/listing_sync.rs: a durable Postgres outbox (marketplace_outbox). Its worker refreshes prices, bumps generations, invalidates caches and publishes live events.
- crates/api-common/src/security.rs: the private/no-store rules, including gameSelectedOutsideUrl.

Requests measured by the frontend team (api.pokoin.com, Rust, 2026-10-09):
1. `Server-Timing: app;dur=<ms>, db;dur=<ms>, cache;desc=hit|miss` on every /api route, plus `Timing-Allow-Origin: https://pokoin.com`. Without TAO, cross-origin Resource Timing hides serverTiming.
2. Weak ETag and 304 on If-None-Match for: marketplace-card-page, marketplace-card-tiles, marketplace-rails, marketplace-home/{new-cards,best-sellers,spotlight}, marketplace-expansions, marketplace-search-page, marketplace-suggest. Keep their current Cache-Control/SWR values.
3. Cold-MISS targets: marketplace-search-page?q=pikachu&lang=en takes 1.18 s and marketplace-expansions?limit=500 takes 1.69 s; the target is p95 < 300 ms on a miss. Profile these code paths (SQL plans and per-step timings) and optimize them. Use precomputation, Redis-backed materialized results invalidated by the outbox generations, and cheaper SQL. Results must stay identical.
4. A compact catalog shard for local-first typeahead:
   - `GET /api/catalog/names?v=<ver>` returns `{v, names:[[display,prior],...], sets:[[display,slug,prior,nationality],...], artists:[[display,slug,prior],...]}` with `Cache-Control: public, max-age=31536000, immutable` per version.
   - `GET /api/catalog/version` returns `{v}` with max-age=300.
   - The source is the same lists the SPA ships in market/src/data/suggest-{names,sets,artists}.js (about 10,009 names from marketplace_card_names with priors, 838 sets, 444 artists). Build it from the database with the same rules, and make the version a content hash.

Also:
- Make the outbox engine event-driven: LISTEN/NOTIFY when available, polling as fallback. Events invalidate the edge micro-cache and Redis keys by generation and publish to the live bus.
- Add an optional Cloudflare cache purge by URL/tag behind CLOUDFLARE_ZONE_ID / CLOUDFLARE_API_TOKEN, off by default.
- Write the plan, with route-by-route TTLs and invalidation keys, in docs/rust-migration/CACHE_SYNC_ENGINE.md.
- Add tests for each piece.

You cannot reach production here. Measure with unit-level timings and the SQL plans you can reason about. The coordinator benchmarks on nezopt before shipping.

Verify: `cd pokoin-rust && cargo test --workspace` passes.

Work on branch `feature/cache-sync-engine`. End commit messages with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". Open a DRAFT PR whose body ends with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".

Do NOT merge or deploy, and do not change deploy/ or scripts/.
