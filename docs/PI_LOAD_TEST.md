# Pi load test (2026-09-29)

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

1. `scripts/pokoin-api-edge.js`: micro-cache + request coalescing +
   stale-while-revalidate for public GETs, and GET fallback to nezopt when the
   Pi API is down (docs/NEZOPT_OVERFLOW.md). Deploy: `scripts/deploy-pokoin-api-edge.sh`.
2. `server/pokoin-api/marketplace-event.js`: writes via the writer pool,
   answers 204 before writing, rate-limited failure log.
   Deploy: `scripts/deploy-marketplace-event-api.sh`.
3. `scripts/pokoin-docker-logrotate.conf`: 50 MB × 3 compressed per container
   log, copytruncate, logrotate hourly. Deploy: `scripts/deploy-pi-logrotate.sh`.

Still open (not traffic-critical once the edge cache sits in front):
`artist-cards?summaries=1` costs ~1.9 s of Postgres per build — worth a
precomputed table if it ever misses often; card pages are long-tail and rely
on overflow to nezopt rather than cache.
