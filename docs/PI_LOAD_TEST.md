# Pi load test (2026-09-29)

> Measured on the retired Node runtime. The Pi now runs native Rust (`pokoin-rust-api`: edge `:18079`, API `:18082`); the edge micro-cache below carried over into `pokoin-rust/crates/edge`. [RUST_RUNTIME.md](RUST_RUNTIME.md)

Read endpoints hit straight on the Pi API (`127.0.0.1:18080`, bypassing the
edge), random real card ids / set / artist slugs so no cache helps, 8
concurrent for 6 s each (`CONC=1` for intrinsic cost). Script and id lists
lived in the session scratchpad; rerun the same way before big launches.

| Endpoint | 8 concurrent | 1 at a time | Cacheable upstream | Notes |
| --- | --- | --- | --- | --- |
| `marketplace-home?v=rising-month` | **1.3 req/s, p50 6.9 s** | 9 ms (in-process cache) | s-maxage 30 | Cache **stampede**: every miss rebuilt in parallel |
| `marketplace-artist-cards?summaries=1` | **2 req/s, p50 7 s** | **1.9 s** | s-maxage 300 | Loaded on **every card page** |
| `marketplace-expansion-page?limit=500` | 4.7 req/s, 2 s | 0.9 s | s-maxage 300 | Loaded on the home page |
| `marketplace-artist-cards?artistSlug=` | 4.8 req/s | 290 ms | s-maxage 300 | 290–560 KB bodies |
| `marketplace-card-page` | **6.7 req/s, p50 1.3 s** | 290 ms | s-maxage 30 | Main landing page; DB pool max 4 |
| `marketplace-expansion-page` (one set) | 12 req/s | 244 ms | s-maxage 120 | |
| `marketplace-search-page` | 29 req/s | | s-maxage 60 | |
| `marketplace-version-set` / `native-sales` | ~45 req/s | ~170 ms | yes | |
| `marketplace-listings` (nativeOnly) | 133 req/s, p95 668 ms | | **no-store** + `&_=` buster | Never cacheable |
| `marketplace-suggest` | 120 req/s | | s-maxage 30 | |
| `card-sales`, `card-url`, `searchbar-token-predict` | 250–400 req/s | | yes | Fine |

Other findings:

- **`POST /api/marketplace-event` failed on every call** — it inserted through
  the read pool, which on the Pi is the hot-standby replica ("cannot execute
  INSERT in a read-only transaction", 808 in 6 h). Page-view/search analytics
  and the rising rails got nothing from the web. It also awaited the insert
  before answering, holding an API slot per page view.
- **Docker logs had no size cap** (`json-file`, no `max-size`): replica
  454 MB, Meili 166 MB; the API logs a line per page view. Heavy traffic would
  fill the SD card.
- `docker restart` on every API deploy answered 502 for a few seconds.

Fixes:

1. The Node edge: micro-cache + request coalescing +
   stale-while-revalidate for public GETs, and GET fallback to nezopt when the
   Pi API is down. Now the Rust edge (`pokoin-rust/crates/edge`), without the
   fallback: the Cloudflare LB splits traffic ([NEZOPT_OVERFLOW.md](NEZOPT_OVERFLOW.md)).
2. `marketplace-event`: writes via the writer pool, answers 204 before
   writing, rate-limited failure log. Now in `pokoin-rust/crates/commerce`.
3. `scripts/pokoin-docker-logrotate.conf`: 50 MB × 3 compressed per container
   log, copytruncate, logrotate hourly. Deploy: `scripts/deploy-pi-logrotate.sh`.

## After (same test, through the live edge, 2026-09-29)

| Endpoint, 8 concurrent | Before | After |
| --- | --- | --- |
| home feed | 1.3 req/s, p50 6.9 s | **284 req/s, p50 26 ms** |
| artist summaries | 2 req/s, p50 7 s | **251 req/s, p50 20 ms** |
| set index | 4.7 req/s, p50 2 s | **178 req/s, p50 35 ms** |
| search page | 29 req/s, p50 273 ms | **283 req/s, p50 20 ms** |
| card page, 32 concurrent, 400 random cards | ~7 req/s | **107 req/s** (cache + nezopt overflow) |

- An API restart during a deploy: 24/24 requests through the edge answered 200.
- `marketplace-event`: first web event since 2026-09-11 recorded on the writer;
  0 read-only failures after the deploy.
- Docker logs rotated (replica 454 MB → compressed archives), logrotate hourly.
- Edge RSS ~100 MB; Pi still 2.5 GB available.

Still open (not traffic-critical once the edge cache sits in front):
`artist-cards?summaries=1` costs ~1.9 s of Postgres per build — worth a
precomputed table if it ever misses often; card pages are long-tail and rely
on overflow to nezopt rather than cache. Cold misses of never-seen card /
set / artist URLs still cost 0.3–1.5 s each on the Pi below the overflow
threshold (16 in flight).
