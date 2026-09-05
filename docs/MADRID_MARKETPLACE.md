# Marketplace home stall → Madrid 3 A1

Investigation 1 Sep 2026. The empty **Recently seen** rail on
`https://pokoin.com/marketplace` is not a Cloudflare Worker bug and not a
CDN miss. It is the React home BFF waiting on Postgres while a CardTrader
refresh saturates the Frankfurt 1 GB micro. The fix that actually fits Always
Free is **Madrid 3 Ampere**, not another Frankfurt hunt.

**5 Sep 2026:** the SPA no longer waits on Oracle `marketplace-home-page`,
Firebase, or Firestore before painting New / Best / Featured. That first-paint
path is [HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md). This file stays the Madrid
hosting note. The grey-row screenshot below is the **old** Oracle stall.

Tenancy IDs, keys, and hunt paths live in the private two-tenancies note
(not git). This file is the public-web pipeline.

Do **not** point `api.pokoin.com` at Madrid until restore is verified.
Do **not** move `pokoin-peer1`. Do **not** delete boot volumes.

---

## What the screenshot is

`market/src/pages/Home.jsx` paints `PromoCarousel` from local data, then waits
on `GET /api/marketplace-home-page`. Until that JSON arrives, **Recently seen /
New cards / Best sellers / Featured** are eight skeleton tiles (`placeholders={8}`).
That is the grey row.

If the BFF had returned, tiles would show **name + PKN** (or **—**). A missing
ask is not “Out of stock”. `/card-images/…` and `cdn.pokoin.com` returned 200
(CDN worker `pokoin-cdn-card-images`). `pokoin-shortlink` only 302s numeric
card paths; `/api/*` is pass-through to Vercel → `api.pokoin.com`.

```
browser  →  Cloudflare (pokoin.com orange-cloud)
         →  Vercel rewrite /api/* 
         →  api.pokoin.com  (A 130.61.251.250, DNS-only, not proxied)
         →  pokoin-oracle-api  marketplace-home-page.js
         →  Postgres on pokoin-marketplace (E2.1.Micro, 1 GB)
```

Flutter `GET /api/marketplace-home` is a **different**, heavier endpoint
(240-row fallback). The SPA does not call it.

---

## Frankfurt box (live, 1 Sep 2026 ~12:00 UTC)

| | |
| --- | --- |
| VM | `pokoin-marketplace` Always Free **E2.1.Micro** |
| RAM | **956 MiB** host, **562 MiB swap** in use at the stall |
| Postgres docker | **512 MiB** memory cap, `shared_buffers=128MB`, `work_mem=2MB`, `max_connections=20`, `statement_timeout=30s` |
| API pool | `MARKETPLACE_DATABASE_POOL_MAX` default **4** |
| Disk | 97 GB, 13 GB used |
| Meili | active, **~108 MiB / 256 MiB** `MemoryMax` |
| Caddy | active |
| `api.pokoin.com` | `130.61.251.250` |

Database **1841 MB**. Largest relations:

| Relation | Size |
| --- | --- |
| `cardtrader_market_listing_snapshots` | **883 MB** |
| `pokoin_pokemon_blueprints` | 302 MB |
| `marketplace_search_candidates` | 171 MB |
| `cardtrader_market_listing_removed_history` | 122 MB |
| `marketplace_cards` | 114 MB |
| `marketplace_card_versions` | 104 MB |
| `marketplace_card_urls` | 97 MB |

The working set does not fit in a 512 MiB Postgres cgroup. Under refresh the
kernel reads data files (`DataFileRead`) and the host swaps. That is why a
query that is **5–20 ms idle** waits **seconds** on a connection.

---

## Home BFF (oracle-api)

`/app/api/marketplace-home-page.js`:

1. In-process snapshot cache **20 s**.
2. `Promise.all` of `readNewestEnglishCards` (three `readCardsForSet`: Mega
   Evolution, Phantasmal Flames, Black Bolt) and `readHotCards`, each wrapped
   in `withTimeout(…, 2500, [])`.
3. Then canonical paths + cheapest, 2 s timeouts.
4. If `recentCardIds` is present, a third query (2 s) merges Recently seen.

`EXPLAIN ANALYZE` when idle:

- newest Mega Evolution limit 12: **~4.7 ms** (index
  `marketplace_search_candidates_set_singles_card_id`)
- hot join: **~20 ms**

So the 2.5 s timeouts are **pool wait**, not missing indexes.

`withTimeout` is `Promise.race`. It does **not** cancel the Postgres query.
Timed-out work keeps the 4-client pool busy. Empty `[]` results are still
written into `cachedSnapshot`, so the SPA can serve **empty rails for 20 s**
after a timeout.

Live logs on the API container (same window as the screenshot):

- `marketplace-home-page newest timed out after 2500ms`
- `marketplace-home-page hot timed out after 2500ms`
- Flutter `marketplace-home` **500** at ~30 s:
  `canceling statement due to statement timeout`
- Meili search **408**
- Forum still `getaddrinfo ENOTFOUND` for the old Supabase host (unused for
  marketplace data; leftover)

A later curl, between refresh batches: home **200 in 0.49 s**, `__contract`
**1.27 s**. The endpoint is fine when Postgres is not writing snapshots.

---

## CardTrader refresh (the stall)

Container `confident_wescoff`, started **1 Sep 2026 06:53 UTC** (~5 h at
investigation), image `node:20-bookworm`, command
`bash scripts/run-cardtrader-daily-market-refresh.sh`.

It walks **512+ expansions**. Logs showed `expansionIndex: 513` still
running, **263** `database_refresh_start` events, each calling:

```sql
select * from public.refresh_cardtrader_market_listing_snapshots(...)
```

That function writes the **883 MB** snapshots table. One of those statements
was **active 30–40 s** with `wait_event = DataFileRead` while Postgres CPU
was **~160%** on the single vCPU.

Home, suggest, autocomplete, and Flutter home all share that vCPU and the
4-connection pool. Recently seen skeletons are the SPA waiting.

---

## Cloudflare / Vercel (not the root cause)

| Piece | Role |
| --- | --- |
| `pokoin.com` / `www` orange-cloud | Required for Worker routes |
| Worker `pokoin-shortlink` | KV 302 for `/{id}`, `/marketplace/{id}`, `/marketplace/{lang}/cards/{id}` |
| `pokoin.com/card-images/*` | More specific; stays on `pokoin-cdn-card-images` |
| `app.pokoin.com` | DNS-only, untouched |
| `api.pokoin.com` | DNS-only A record; **do not orange-cloud** |
| Curl from this host to `pokoin.com/api/*` | Cloudflare 403 (browser integrity). Real browsers still reach origin |

Shortlink KV is seeded (~74k English paths). That hop is tens of milliseconds
when the request hits Cloudflare. It does not populate Recently seen.

---

## Why not “fix it on the micro”

You cannot give the marketplace VM more RAM. Always Free AMD is two **fixed
1 GB** E2 micros; they do not merge. Frankfurt Ampere hunt was **stopped**
(no A1 hosts / quota ghosts). Hypemeter must not land on this box either
([NEWS.md](NEWS.md)).

Stopgap only (until Madrid exists): **one CardTrader refresh per day** at
`03:20 UTC` (`pokoin-cardtrader-daily-market-refresh.timer`); do not cache
empty home snapshots (Valkey `home:react` / `home:flutter` skip empty);
abort SQL on `withTimeout`. Listing sold/new stats
roll up from `cardtrader_market_listing_removed_history` plus native
`marketplace_user_listings` into `marketplace_card_weights` (small). Rails
on Supabase get those weights, not the 883 MB snapshot table.

That makes the rail honest. It does not make 883 MB of snapshots fit in 512 MiB.

---

## Why Madrid 3

Madrid Always Free compute is **Ampere only**: **2 OCPU / 12 GB**, one box
(or two 1/6). No `VM.Standard.E2.1.Micro` in that region.

| | Frankfurt micro today | Madrid A1 target |
| --- | --- | --- |
| CPU | 1 × x86 | **2** OCPU aarch64 |
| RAM | 1 GB + 2 GB swap | **12 GB** |
| Postgres | 128 MB buffers, 512 MB cgroup | 2 GB `shared_buffers`, 6 GB `effective_cache_size` (already in the old A1 migrate script) |
| Meili | 256 MB | 2 GB |
| Snapshots table | does not fit RAM | fits several times over |
| Refresh + API | same vCPU | one OCPU can refresh while the other serves |
| Chain | `pokoin-peer1` stays | **does not move** |

Existing hunt: `~/secrets/deploy/gvitolocs-madrid3/hunt-a1.sh`. Last run
**stopped 31 Aug 2026 16:39 UTC** after Oracle **429** / out of host capacity.
Pid file empty. **No Madrid instance exists.**

Do not run `scripts/oci-a1-2x12-hunt.sh` or
`scripts/migrate-marketplace-to-a1.sh` — those target **Frankfurt**
`pokoin-a1` and the migrate script **cuts `api.pokoin.com` DNS**.

`wait-and-restore.sh` (Madrid) is a first restore only: stale 31 Aug dump,
`pg_restore || true`, **no Meili, no Caddy, no DNS**. Use it as a waiter,
not as cutover.

On-disk dumps on nezopt (Frankfurt still live, so take a **fresh** dump at
restore time):

- `marketplace-20260831T094927Z.dump` (~26 MB custom format)
- `marketplace-config-20260831T094927Z.tgz` (~93 MB)

---

## Proposed topology

```
pokoin.com          Cloudflare + Vercel SPA + shortlink Worker     (unchanged)
www.pokoin.com      same
app.pokoin.com      CardVault DNS-only                             (unchanged)
news.pokoin.com     Hypemeter on Vercel until Madrid has spare RAM (unchanged)

api.pokoin.com      DNS-only A → pokoin-madrid-api
                    Caddy → oracle-api :18080
                    Postgres 17, Meili, CardTrader refresh (off-peak)

pokoin-peer1        Frankfurt E2 micro, chain seed                 (stays)
pokoin-marketplace  Frankfurt E2 micro, rollback until you say     (stays on)
```

Name the VM `pokoin-madrid-api`. Boot **200 GB** (full Always Free). SSH key
and VCN are already in the Madrid deploy dir.

---

## Cutover plan (gates, not a single script)

### 0 — Frankfurt stopgap (optional, same day)

- Pause or `docker stop` the CardTrader refresh while people browse, then
  resume off-peak.
- In oracle-api: do not cache empty timeout snapshots; `statement_timeout`
  on the refresh function lower than “run for 40 s per batch”.
- Listing pipeline: `scripts/install-listing-pipeline.sh` (Oracle stats +
  weights, daily flock, 15-min weight timer). Rails sync publishes ranked
  homepage rails to Supabase **with PKN** (`1 PKN = 0.005 USDT`,
  `PKN = EUR / 0.005`). Hub cache is ~868 hot blueprints; live English sets
  are not in it yet, so New cards overlay CardTrader NM/EN asks at publish
  time and store them in **Valkey** (`pkn:ct:{blueprint}`, 6 h). New cards
  is a chase + in-set mix per live set, unique names. Recents merge PKN
  from rails instead of shadowing priced tiles. Snapshots
  stay on Oracle. Install Valkey with `scripts/install-marketplace-valkey.sh`
  (32 MB, localhost, not on peer1).

### 1 — Hunt Madrid (gvitolocs profile only)

Restart the Madrid hunt with a slower loop (the last stop was 429). Prefer
**2/12**; fallback **1/6** then resize. Log + pid as in the hunt script.
Do not hunt Frankfurt A1.

Gate: instance `pokoin-madrid-api` **RUNNING** with a public IP. SSH as
`ubuntu` with the Madrid key.

### 2 — Bootstrap Ampere

`scripts/bootstrap-pokoin-a1.sh` (aarch64 docker, Caddy arm64, Meili
aarch64). Packages only. No DNS.

### 3 — Fresh copy from live Frankfurt

Do not restore the 31 Aug dump as the final dataset. On cutover day:

- `pg_dump -Fc` from `pokoin-marketplace` (expect ~GB uncompressed; custom
  format was ~26 MB last time because it is compressed).
- rsync `pokoin-oracle-api/current`, docker env files, Caddyfile, Meili
  data, postgres certs — same inventory as
  `scripts/migrate-marketplace-to-a1.sh`, but **destination is Madrid** and
  **no Cloudflare PATCH**.

Postgres on Madrid: listen **127.0.0.1:5432** only. Settings from the old
migrate script (`shared_buffers=2GB`, `max_connections=80`,
`statement_timeout=60s`, `idle_in_transaction_session_timeout=30s`).
**No 512 MiB docker memory cap.**

Meili: `MemoryMax=2G`. API: `node:20-bookworm` host network, same env, but
point `MARKETPLACE_DATABASE_URL` at localhost. Raise pool above 4.

### 4 — Verify on the box (DNS still Frankfurt)

From Madrid localhost:

```bash
curl -fsS --max-time 8  http://127.0.0.1:18080/api/__contract
curl -fsS --max-time 8  http://127.0.0.1:18080/api/marketplace-home-page
curl -fsS --max-time 8  'http://127.0.0.1:18080/api/marketplace-card-page?cardId=703358'
curl -fsS --max-time 8  'http://127.0.0.1:18080/api/marketplace-card-url?cardId=239324&language=en'
```

Home should be **well under 1 s** with no refresh running, and should stay
usable with a niceness-limited refresh. Compare row counts
(`marketplace_search_candidates`, `marketplace_card_urls`) to Frankfurt.

Do **not** run the full CardTrader 512-expansion job on Madrid until this
passes. When you do, cap DB connections for that job and run it off-peak.

### 5 — DNS cutover (explicit approval)

1. Keep Frankfurt Caddy running until the first public 200.
2. PATCH `api.pokoin.com` A → Madrid public IP, TTL 120, **proxied=false**.
3. Start Caddy on Madrid.
4. Prove `https://api.pokoin.com/api/__contract` and home-page from the
   public internet.
5. Prove `https://pokoin.com/marketplace` Recently seen / New cards fill.
6. Prove `https://pokoin.com/239324` still KV-302s (apex Worker unchanged).

Rollback: PATCH A back to `130.61.251.250`, start Frankfurt Caddy if it was
stopped. Leave both boot volumes.

### 6 — After cutover

- CardTrader daily refresh **only on Madrid**, nice’d / systemd timer at
  night, not a 5-hour unnamed `docker run`.
- oracle-api: skip empty home cache; cancel timed-out queries; stop calling
  dead Supabase from forum.
- Hypemeter stays on Vercel until 12 GB still has headroom after Meili +
  Postgres + refresh. Do not install Next on this VM in the same change.
- Frankfurt marketplace VM stays as rollback. No volume deletes.

---

## Script work (when implementing)

| Script | Keep? |
| --- | --- |
| `~/secrets/deploy/gvitolocs-madrid3/hunt-a1.sh` | Yes. Restart slower. |
| `scripts/bootstrap-pokoin-a1.sh` | Yes. Ampere packages. |
| `scripts/migrate-marketplace-to-a1.sh` | **Do not run.** Frankfurt tenancy + auto DNS. |
| `scripts/oci-a1-2x12-hunt.sh` | **Do not run.** Frankfurt A1 + auto-migrate. |
| `scripts/oci-a1-2x12-hunt-news.sh` | News only; still Frankfurt. Leave off. |
| `wait-and-restore.sh` | Waiter only. Replace restore with a Madrid migrate that rsyncs **live** data and **never** PATCHes DNS unless `MADRID_CUTOVER_DNS=1`. |

---

## Success

`https://pokoin.com/marketplace` paints Recently seen from
`marketplace-home-page` in under a second without skeletons sticking.
CardTrader refresh can run without taking the only vCPU. `api.pokoin.com`
is Madrid. `pokoin-peer1` and Frankfurt marketplace disks still exist.
