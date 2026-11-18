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

## Rust era: public API at low concurrency (2026-10-10)

The Pi has served the native Rust API since 2026-10-09 15:00 UTC. It is no
longer load-tested directly: a candidate plus a parity run on the Pi filled its
RAM and swap on 2026-10-09 and Cloudflare answered 1033. This run measures what
users get instead: `scripts/api-bench.mjs` from nezopt through
`https://api.pokoin.com` (Cloudflare load balancer, Pi 0.6 / nezopt k3s 0.4),
**2 concurrent, 40 requests per endpoint**, random real ids so no cache helps
(400 card ids, illustrator slugs, card names, set slugs from `sitemap-sets.xml`).
Every response is attributed by `x-pokoin-release` (`nez-k3s` = overflow) and
`cf-cache-status`. Run 2026-10-10 07:24 UTC, Pi on release bc3a9ad.

Not like-for-like with the Node tables above: those were measured directly on
the Pi at 8 concurrent, while these include the Cloudflare and tunnel round trip
(~15–20 ms, the cached rows below).

| Endpoint | Node 2026-09-29, 1 at a time on the Pi | Rust, public p50 / p95 | Pi p50 | nezopt p50 | Cloudflare |
| --- | --- | --- | --- | --- | --- |
| `marketplace-card-page` | 290 ms | **81 / 116 ms** | 83 ms | 76 ms | MISS |
| `marketplace-search-page` | 273 ms p50 at 8 concurrent | **72 / 103 ms** | 66 ms | 76 ms | MISS |
| `marketplace-version-set` | ~170 ms | **100 / 129 ms** | 103 ms | 81 ms | MISS |
| `marketplace-artist-cards?artistSlug=` | 290 ms | 185 / 777 ms | 232 ms | 120 ms | MISS |
| `marketplace-expansion-page` (one set) | 244 ms | **329 / 1,096 ms** | 347 ms | 163 ms | MISS |
| `marketplace-native-sales` | ~170 ms | 299 / 685 ms | 214 ms | 311 ms | MISS |
| `marketplace-listings` (nativeOnly) | p95 668 ms at 8 concurrent | 39 / 155 ms | 35 ms | 43 ms | BYPASS |
| `marketplace-suggest` | 120 req/s at 8 concurrent | 52 / 76 ms | 52 ms | 59 ms | MISS |
| `marketplace-card-sales` | fine | 33 / 65 ms | 30 ms | 43 ms | MISS |
| `marketplace-card-url` | fine | 28 / 59 ms | 27 ms | 44 ms | MISS |
| `marketplace-home?v=rising-month` | 9 ms (in-process cache) | 18 / 54 ms | | | HIT |
| `marketplace-expansion-page?limit=500` | 0.9 s | 18 / 82 ms | | | HIT |
| `marketplace-artist-cards?summaries=1` | 1.9 s | 20 / 29 ms | | | HIT |
| `searchbar-token-predict` (warmup) | fine | **6 / 6 timed out at 30 s** | | | – |

- 520/520 requests to the 13 regular endpoints answered 200.
- Faster than Node: card pages, search, version-set, listings. Slower: set pages
  (p95 above 1 s, mostly on the Pi; `expansion-page` was ≥ 1 s for 14 % of Pi
  requests in the morning's logs) and native-sales.
- `searchbar-token-predict` hung because a handler panic left the edge's
  coalescing slot for that URL pending (see below). PRs #300/#301 removed that
  panic (deployed 07:41 UTC); afterwards it answered 200 (3.5 s cold on the Pi,
  ~40 ms through Cloudflare).

### Pi incident the same morning (Rust era)

Before this run the Pi was swapping: catalog pool timeouts, 503s, ~1 s requests.
Pi rebooted 06:57 UTC. Root causes (details in Honcho
`claude-pi-rust-load-2026-10-10`, diagnostics on pi-home
`/home/root/incident-20261010-prereboot/`):

1. `pokoin-rust-job@cardtrader-seller-reconcile` peaks at **1.77 GB** RSS within
   ~20 s of downloading the largest seller's 12.5k-product export (whole response
   as text, then an untyped `serde_json::Value` tree). One run is ~7 min, the timer
   restarts it every 5, so it is resident almost all the time. `MemoryMax=300M`
   does nothing: the Pi kernel boots with `cgroup_disable=memory`.
2. Each run re-removes the seller's 400 already sold_out listings (refetching up
   to 5,000 CardTrader orders and ~400 Firestore event writes); `removed` is
   counted twice in its summary.
3. The edge calls the API router in-process. A handler panic skips
   `finish_flight`, so that URL's coalescing slot stays pending and every later
   request for it hangs until the client gives up (100 s measured). The panics
   came from float sorts that are not a total order when a value is NaN.
4. After the reboot a udev rule (`/etc/udev/rules.d/99-pokoin-data.rules`) started
   the retired Node `pokoin-card-images` on :18081, and the Rust unit crash-looped
   until it was stopped and removed from the rule.

Under Node the Pi was memory-starved too (the Node API grew to 0.5–1.3 GB and
swap was often full); the Rust API itself stays at 80–250 MB.

### Rerun

```bash
# id lists (read-only, on the Pi replica)
docker exec -i pokoin-marketplace-postgres-replica psql -U pokoin_marketplace -d pokoin_marketplace -At \
  -c "select card_id from public.marketplace_search_candidates tablesample system (2) where product_type = 'card' order by random() limit 400" > cards.txt
#   artists.txt: select distinct artist ... where coalesce(artist,'') <> ''
#   names.txt:   120 random distinct card names (product_type = 'card', 4–24 chars)
#   set-urls.txt: the <loc> URLs of sitemap-sets.xml
node scripts/api-bench.mjs --ids <dir> --conc 2 --n 40 --out rust-public.json
```

Keep it at low concurrency: this goes through production.
