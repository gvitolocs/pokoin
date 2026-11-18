# PH-R031 — per-condition Cardmarket prices on the card page: the site side

Run PH-R031 for finding PRICE-03 (lead PH). Analysis only: no source file changed, no build, no
database, no host. Everything below is read from this worktree at commit `30601f15`
(`cm-conditions-analysis`, from `origin/main`). Every `file:line` was opened at that commit.

The owner's decision (2026-11-18): collect **all conditions, every day**, for the cards that are
**viewed and owned**, and show them on the card page graph. Sections 1–5 describe what exists and
what has to be added; 6 is the work order; 7 is what this checkout cannot answer.

One line up front, because it shapes the rest: the Cardmarket data that has conditions
(`cardmarket_offer_minimums`, `cm_prices.current_minimums`) is **a latest-value table, not a
history**, and **nothing on the graph path reads it**. The graph's Cardmarket line reads
`cardmarket_price_guide`, which has no condition at all. So the work is not "show a number we
already keep" — it is "start keeping a per-condition daily series, then show it".

---

## 1. Where per-condition Cardmarket data lives today

### 1.1 `public.cardmarket_price_guide` — what the graph reads (no condition)

| | |
|---|---|
| DDL | `scripts/sql/139_pricer_sources.sql:24-45`; PK `(game, id_product, day)`; runs table `:47-57` PK `(game, day)` |
| Columns | `game`, `id_product`, `day`, `id_category`, `avg low trend avg1 avg7 avg30` and the same seven `_foil` (`:26-43`) |
| Kind | **History**, but change-only: "a row is written only when a product's values change: it holds from `day` until that product's next row" (`scripts/sql/139_pricer_sources.sql:9-11`) |
| Condition / language | none. It is Cardmarket's public guide: one global number per product (`docs/PRICING.md:295-297`) |
| Written by | `pokoin-cardmarket-catalog guides --apply` (`pokoin-rust/apps/cardmarket-catalog/src/lib.rs:14-19`), nezopt user unit `pokoin-cardmarket-guides.service` + `.timer` at 02:45 UTC (`deploy/ops/nezopt-user/pokoin-cardmarket-guides.service:11`, `deploy/ops/nezopt-user/pokoin-cardmarket-guides.timer:6`) |
| Read by | the pricer (`pokoin-rust/crates/external/src/price_sources.rs:290-299` `CM_GUIDE_SQL`, run freshness `:272`) **and** the price-history endpoint (`pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:33-49` `CM_GUIDE_HISTORY_SQL`) |
| Retention | every changed day, forever; the day a run row exists for is a day the guide was loaded (`cardmarket_price_guide_runs`) |

### 1.2 `public.cardmarket_price_guide_daily` — satellite games only, also no condition

`scripts/sql/126_cardmarket_price_guide.sql:14-35`, PK `(id_product, day)`, one row per product per
day (`:34-35` index on `day`). Written by the same app's `prices` subcommand
(`pokoin-rust/apps/cardmarket-catalog/src/lib.rs:21-24`) into each Cardmarket-only game database,
not `pokoin_marketplace`. It is a true daily series — the only per-day Cardmarket table in this repo
— and it is the shape a per-condition daily table should copy.

### 1.3 `public.tcgnotify_price_guide` — one global ask, no condition

`scripts/sql/140_tcgnotify_price_guide.sql:27` (table) and `:40` (runs). Change-only, keyed by the
product's own update day, used for the guide's `low` only (`docs/PRICING.md:278-293`). Not a
candidate for conditions: TCGNotify publishes one `min_price` across languages and grades.

### 1.4 `public.cardmarket_offer_minimums` — **has** condition, keeps no history

| | |
|---|---|
| DDL | `scripts/sql/141_cardmarket_offer_minimums.sql:37-60`; PK `(cm_product_id, language, condition, finish, first_edition, seller_type)` (`:58-59`) |
| Facet columns | `language` (`:40-42`), `condition` = Cardmarket's `minCondition` (`:43`, semantics `:17-23`), `finish` Y/N/* (`:45-46`), `first_edition`, `seller_type` `pro`/`private` (`:48-49`) |
| Value | `min_cents` integer EUR cents (`:50-51`), `offers`, `counts_complete`, `observed_at` timestamptz, `loaded_at` |
| Kind | **Latest value only.** There is no `day` column and no day in the key; a facet is rewritten only by a newer `observed_at` (`:12` header, and the upsert `pokoin-rust/apps/cardmarket-catalog/src/db.rs:467-471`: `do update … where excluded.observed_at > minimum.observed_at`) |
| Written by | `pokoin-cardmarket-catalog cm-offers --file minimums.jsonl --apply` — a **hand-run** load of one CTCMDeals harvest at a time (`pokoin-rust/apps/cardmarket-catalog/src/lib.rs:41-49`, loader `pokoin-rust/apps/cardmarket-catalog/src/db.rs:420-485` through a temp `incoming_minimums` staging table `pokoin-rust/apps/cardmarket-catalog/src/db.rs:405-425`). No timer runs it: `docs/PRICING.md:275` says "Per scan, on demand" |
| Read by | the pricer only: `pokoin-rust/crates/external/src/price_sources.rs:635-645` (`cm_floor_sql`), freshness 7 days per facet (`CM_FLOOR_MAX_AGE_DAYS`, `:600`), merged at `:697-725`, surfaced as `sources.cardmarketoffers` (`:876+`). **The price-history endpoint never touches it.** |
| Retention | one row per facet; history exists only in the engine's append-only `minimums.jsonl` (`scripts/sql/141_cardmarket_offer_minimums.sql:12-13`) |

### 1.5 schema `cm_prices` — the collector's own store, already read by the pricer

`docs/PRICE_DUMPS.md:15` is the map: the walk `pokoin-cm-price-collector.service` (continuous, 7-day
cycle), `pokoin-cm-price-ingest.timer` (hourly load), `pokoin-cm-price-publish.timer` (Monday 03:00),
data lands in "schema `cm_prices` in `pokoin_marketplace`; readers use the view
`cm_prices.current_minimums`", project `cm-price-engine`. That project is a **separate repository**;
its DDL, its walk list and its publish logic are not in this checkout and were not read
(cross-repo boundary — see §7).

What this side proves about it is the columns the pricer selects
(`pokoin-rust/crates/external/src/price_sources.rs:620-631`, `cm_engine_floor_sql`):
`cm_product_id, seller_type, condition, language, finish, first_edition, min_cents, offers,
counts_complete, observed_at, published_at`, filtered by `published_at::date >= current_date - 8`
and `observed_at::date >= current_date - 15` (`CM_SNAPSHOT_MAX_AGE_DAYS` `:606`,
`CM_SNAPSHOT_FACET_MAX_AGE_DAYS` `:612`). The engine snapshot is merged **ahead of**
`cardmarket_offer_minimums`, newest observation wins per facet (`:697-725`), read at `:767-796`, and a
missing schema or view degrades alone (`:737-747`, `:776`).

So `cm_prices.current_minimums` is **also latest-value**: one row per facet of the current published
snapshot. The underlying walk history may be daily or not — this checkout cannot tell (the collector
walks on a 7-day cycle, so a product is seen roughly weekly, not daily — `docs/PRICE_DUMPS.md:15`).
That is the single most important unknown for the owner's "every day" requirement (§7).

**A doc defect the lead should fix:** `docs/PRICE_DUMPS.md:30` still says "Nothing reads `cm_prices`
yet", and `docs/PRICE_DUMPS.md:24-28` records that the walk was **installed and NOT started** as of
2026-11-11. Both are contradicted by `pokoin-rust/crates/external/src/price_sources.rs:620-631`, which reads the view first and
prefers it. Either the walk has since been started (the owner's decision of 2026-11-18 suggests it
has) and the docs are stale, or the pricer is querying a view that does not exist and logging the
`not published` warning at `:776` on every price check. The one-line check is in §7.

### 1.6 Everything else that is Cardmarket-shaped but holds no price

`public.pokoin_printing_cm_links(cm_url, cm_product_id, …)`
(`scripts/sql/130_printing_cm_links.sql:17-28`, written at
`pokoin-rust/apps/cardmarket-catalog/src/db.rs:605-611`) and
`public.marketplace_cm_verified_links` (`scripts/sql/098_cardmarket_game_catalog_support.sql:13-31`,
PK `(blueprint_id, cardmarket_locale)`; also `scripts/sql/120_admin_debug_tables.sql:100`) plus
`marketplace_cm_product_parsing` resolve a printing to a **product page URL** for
`/api/cardmarket-redirect` (`pokoin-rust/crates/external/src/cardmarket.rs:86-94`). They carry ids,
not prices. The outbound button is a user-visible flow in its own right
(`docs/FEATURES.toml:321` "Card page offers Cardmarket matches and outbound redirects").

### 1.7 The precedent worth copying

The graph's CardTrader ask leg reads `public.cardtrader_blueprint_daily_analytics`
(`pokoin-rust/crates/catalog-api/src/sales/routes.rs:693-701`), one row per blueprint per day, built
by the daily dump rollup (`docs/CARDTRADER_DAILY_DUMP.md:230`). That is the pattern the owner asked
for: a per-day series table, read by a leg, never a latest-value table.

---

## 2. The key chain, and how condition and language are named

### 2.1 Pokoin card → Cardmarket product → back

```
card page cardId (public id)
  → public.marketplace_search_candidates.card_id, .ct_id            pokoin-rust/crates/catalog-api/src/sales/routes.rs:691-692  (CARD_SQL)
  → public.cardtrader_pokemon_blueprints.id = ct_id,
      .card_market_ids jsonb array of numeric strings                pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:22-28 (CM_PRODUCT_IDS_SQL)
      unnested by cm_product_ids()                                   pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:230-245
  → idProduct  ─┬→ public.cardmarket_price_guide (game, id_product)  pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:33-49
                ├→ public.cardmarket_offer_minimums (cm_product_id)  pokoin-rust/crates/external/src/price_sources.rs:635-645
                └→ cm_prices.current_minimums (cm_product_id)        pokoin-rust/crates/external/src/price_sources.rs:620-631
```

* Public id = `ct_id × 2` (`scripts/sql/listing-pipeline.sql:3` and the function at `:5-17`).
* The reverse direction, product → card, exists as SQL only for Cardmarket-only games
  (`pokoin-rust/apps/cardmarket-catalog/src/db.rs:118`: `select min(c.card_id) … where c.ct_id = p.id`).
* The bulk "every product our catalog references" query is
  `pokoin-rust/apps/cardmarket-catalog/src/db.rs:150-162` (`referenced_products`) — it yields product
  ids only, not which card each belongs to. **The daily priority list needs the bulk
  card→product form, which does not exist yet**; §3 sketches it.
* One blueprint can carry several idProducts (`pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:22-28` unnests the array;
  `pokoin-rust/apps/cardmarket-catalog/src/guides.rs:96` "on a duplicated idProduct the first row
  wins"), and the graph client silently plots `products[0]`
  (`market/src/price-history.js:129-131`). Anything per-condition must decide the same rule, or the
  line will jump between products of one printing.
* Listing-side ids: `marketplace_user_listings.card_id` is **text** and is joined with a numeric
  guard (`pokoin-rust/crates/commerce/src/handlers/seller.rs:198`, or plainly
  `c.card_id = l.card_id::bigint` at `pokoin-rust/crates/catalog-api/src/market/recommendations.rs:125`).
  `marketplace_card_events.card_id` is numeric (`pokoin-rust/crates/search-api/src/autocomplete/analytics.rs:125`).
  Cardmarket product ids are `bigint` everywhere.
* Pokémon's Cardmarket `idGame` is **6**: `pokoin-rust/apps/cardmarket-catalog/src/guides.rs:32` in the
  registry `:31-54`, persisted per run into `cardmarket_price_guide_runs.id_game`
  (`scripts/sql/139_pricer_sources.sql:50`).

### 2.2 Condition

Pokoin's desk offers five grades plus "any": `NM SP MP PL Poor`
(`market/src/card-desk.js:16-23` `CONDITIONS`, `:30-36` `MOOD_CONDS`, `:39-45` `DEAL_CONDS` — worst →
best, which is the "or better" order the Best Deal uses). The listings table only accepts those five
(`scripts/sql/142_marketplace_buy_orders.sql:25`). The canonicalizer is `condition_key`
(`pokoin-rust/crates/external/src/price_check.rs:113-123`, SQL mirror `:43-52`, web mirror
`pricerCondition` at `market/src/inventory-price.js:35-44`); the tone/short-label layer also knows the
raw spellings that reach Pokoin from other feeds (`market/src/listing-meta.js:4-32`: `EX→ex`, `LP→sp`,
`HP→pl`, `PO/D/DMG→poor`; `EX` and `GD` from the owner's question live there).

Cardmarket's facet is `minCondition` — the **worst grade the page filter accepts**, so an `NM` facet is
"NM or better" and `*` is unfiltered (`scripts/sql/141_cardmarket_offer_minimums.sql:17-23`;
`pokoin-rust/apps/cardmarket-catalog/src/cm_offers.rs:5-9`; enforced by `facet_agrees`
`pokoin-rust/crates/external/src/price_sources.rs:802-807` and `floor_matches` `:840-847`). The
loader's whole vocabulary is six values, `const CONDITIONS: [&str; 6] = ["NM", "SP", "MP", "PL",
"Poor", "*"]` (`pokoin-rust/apps/cardmarket-catalog/src/cm_offers.rs:41`).

| Pokoin desk code | Pokoin `condition_key` output (from a raw feed) | Cardmarket `minCondition` facet stored by this repo | Read as |
|---|---|---|---|
| `NM` | `NM` (also `M MT MINT NEAR MINT`) | `NM` | NM or better |
| `SP` | `SP` (also `LP EX EXCELLENT SLIGHTLY PLAYED LIGHTLY PLAYED`) | `SP` | SP or better, i.e. includes NM |
| `MP` | `MP` (also `GD GOOD MODERATELY PLAYED`) | `MP` | MP or better |
| `PL` | `PL` (also `HP PLD PLAYED HEAVILY PLAYED`) | `PL` | PL or better |
| `Poor` | `Poor` (also `PO POOR DMG DAMAGED`) | `Poor` | anything, incl. Damaged |
| `''` (Any condition) | `''` | `*` | unfiltered mix — never answers a condition switch that is on |
| — | — | (`GP`/"Good" is **not modelled anywhere in this repo**) | see §7 |

The two vocabularies coincide letter-for-letter on the five grades because the CM loader reused the
CardTrader keys (`pokoin-rust/apps/cardmarket-catalog/src/cm_offers.rs:39-41` says so). There is **no mapping table in code or SQL** to
maintain — which is good, but only as long as the collector keeps emitting exactly these six strings.
**No Pokoin grade maps to Cardmarket's `Damaged`** and the `*` row must never be plotted as a grade.

### 2.3 Language

Desk list: `LIST_LANGS = EN IT FR DE ES JP PT NL PL RU KO ZH ZHT ID TH VI`
(`market/src/card-desk.js:26`). Server side `LANGUAGE_KEY_SQL` (`pokoin-rust/crates/external/src/price_check.rs:54-69`) and the
price-file alias map (`pokoin-rust/crates/external/src/price_book.rs:120-127`) normalize `JA/JPN→JP`,
`KR→KO`, `ZH-CN/ZHS/CN→ZH`, `ZH-TW/TW→ZHT`.

The collector's codes are Cardmarket's own, mapped at load time
(`pokoin-rust/apps/cardmarket-catalog/src/cm_offers.rs:47-62`):

| Cardmarket facet code | Pokoin key stored |
|---|---|
| `EN FR DE ES IT ZH PT RU KO NL PL` | same |
| `JP` | `JP` |
| `ZH-TW` | `ZHT` (comment at `pokoin-rust/apps/cardmarket-catalog/src/cm_offers.rs:43-46`: "a floor that never joins is a floor that never happens") |
| `*` | `*` — page fetched unfiltered for language |
| (no code) | `ID TH VI` exist on the desk but **cannot be stored**: they are not in `LANGUAGES`, so a record in them is skipped and counted (`pokoin-rust/apps/cardmarket-catalog/src/cm_offers.rs:124`, `:120-153`) |

Finish and first edition are separate facets (`Y`/`N`/`*`, `pokoin-rust/apps/cardmarket-catalog/src/cm_offers.rs:64`): Pokémon `finish` means
reverse holo (`scripts/sql/141_cardmarket_offer_minimums.sql:45-46`). A daily series that drops them
from its key would mix a reverse holo into a regular minimum — which the pricing rule forbids outright
("No fallback to another facet", `docs/PRICING.md:17-20`).

---

## 3. Which cards count as "viewed and owned"

### 3.1 Viewed

| Where | What it is | Write path | Cheap for "distinct cards of the last N days"? |
|---|---|---|---|
| `public.marketplace_card_events` | the only server-side per-event log: `(card_id bigint, event_type text, weight bigint, metadata jsonb, user_uid text null, occurred_at timestamptz)` | `POST /api/marketplace-event` (`pokoin-rust/crates/commerce/src/lib.rs:137-140`) → `marketplace_event` (`pokoin-rust/crates/commerce/src/handlers/cart.rs:974-1035`, `OptionalUser` at `:976` so **guests are recorded too**, with `user_uid` NULL) → spawned write `record_event` at `pokoin-rust/crates/commerce/src/handlers/cart.rs:1037-1064` (`insert` at `:1047`, card-id resolved through `marketplace_cards` at `:1050-1054`; a no-`user_uid`-column fallback insert at `:1071-1084`). Accepted types and weights `view 1, search 2, click 4, reserve 10, cart_add 8, sale 20` (`pokoin-rust/crates/commerce/src/handlers/cart.rs:893-900`; `docs/MARKET.md:455-470`). Client: one `view` per desk load (`solid/src/pages/Card.jsx:398`, `market/src/track.js:13`) | **Unknown — the DDL is not in this repo.** It is owned by the CardVault `oracle-postgres/schema` tree, replayed by `bench/postgres/load-schema.sh`; in this checkout the table appears only in a grant list (`scripts/sql/124_least_privilege_roles.sql:121`). Existing readers always filter `card_id = any(...) [and user_uid = …] and occurred_at >= now() - interval` (`pokoin-rust/crates/search-api/src/autocomplete/analytics.rs:128-138`), which implies indexes leading on `card_id`/`user_uid`, **not** on `occurred_at`. A `group by card_id … where occurred_at >= …` over the whole window is likely a seq scan. §7 has the queries |
| `public.marketplace_user_recents` | **one row per `(user_uid, game)` holding `card_ids bigint[]`**, not one row per view (`scripts/sql/069_marketplace_user_recents.sql:6-10`, re-keyed by `scripts/sql/090_marketplace_user_recents_game.sql:53-57`; index on `(game, updated_at desc)`) | `GET/PUT/POST /api/marketplace-recents` (`pokoin-rust/crates/commerce/src/lib.rs:129-135`) → `pokoin-rust/crates/commerce/src/handlers/cart.rs:829-849` (`on conflict … do update set card_ids = excluded.card_ids, updated_at = now()`), capped at 24 ids (`RECENT_MAX`, `pokoin-rust/crates/commerce/src/handlers/cart.rs:701`, `:789`) | Cannot answer "viewed in the last N days" at all: the array is overwritten and `updated_at` is the row's last touch, so it yields only **currently** recent cards. Unnesting it is nevertheless trivially cheap (`cross join lateral unnest(card_ids)`) and useful as a boost, not as the source |
| Browser-only | guests' recents (`market/src/recents-storage.js`, `pokoin.recentCardIds.{game}`) and interest profile (`market/src/interest-profile.js:91-112`) never leave the device | — | Not available |
| Firestore `user_card_recent_views/{uid}` | legacy, explicitly not to be awaited (`docs/MARKET.md:664`, `docs/API.md:151`) | no writer left in Rust/JS | Not available |
| `public.marketplace_hot_blueprints` | derived per-blueprint event-weight aggregate, refreshed by SECURITY DEFINER `refresh_marketplace_hot_blueprints` (`scripts/sql/124_least_privilege_roles.sql:170`) | read-only here (`pokoin-rust/crates/catalog-api/src/reads/hot_blueprints.rs:56`) | Already a "what's hot" ranking, but it is **blueprint-weighted and reason-blind**: it cannot say *why* (viewed vs owned) and is not a per-day list. Usable as the tie-breaker inside the priority query, not as the list |
| watchlist / cart | `marketplace_card_watchlist_users`, `_watchlist_analytics`, `_cart_users`, `_cart_analytics` (writes `pokoin-rust/crates/commerce/src/handlers/cart.rs:409-528`, routes `pokoin-rust/crates/commerce/src/lib.rs:118-122`); DDL also outside this repo | | intent, not view/ownership. Out of scope unless the owner wants a third reason |

There is **no** Plausible/Umami/Cloudflare/pageview ingestion and no `card_views` counter column
anywhere in this checkout (`news_events` is article analytics, `scripts/sql/111_news_events.sql:11-29`).
So "viewed" = `marketplace_card_events` rows of `event_type in ('view','click')`, full stop.

### 3.2 Owned

Ownership has **no Postgres table**: it is Firestore `user_card_collections`, one document per owned
item ("the one place that decides what a user owns",
`pokoin-rust/crates/accounts/src/domain/collection.rs:1`, constant `:25`, read `list_owned_collection`
`:413`, decrement on sale `:489-556` and `pokoin-rust/crates/commerce/src/handlers/orders.rs:1898-1930`; routes
`pokoin-rust/crates/accounts/src/lib.rs:202-208`; decision D00006D/D00006E). A daily SQL job therefore **cannot read
"owned"**. Two Postgres proxies exist, and both are one step removed:

1. **Listed with stock** — `public.marketplace_user_listings`: `card_id text`, `seller_uid`,
   `condition`, `language`, `reverse`, `first_edition`, `quantity_available`, `status`, `source`,
   `source_listing_id`, `marketplace_game` (insert `CREATE_SQL`
   `pokoin-rust/crates/commerce/src/handlers/listings.rs:877`; the columns are visible in the bind list
   `:833-866`). Index `marketplace_user_listings_card_active_idx (card_id, price_pkn) where
   status='active' and quantity_available>0` (`pokoin-rust/crates/commerce/sql/001_commerce.sql:79-82`)
   — so "distinct cards currently listed with stock" is an index-only-ish scan. This is the honest
   "owned" proxy the site can query today. Note the seller's own inventory on the desk filters the
   same table to active/paused with stock (decision D00005R, `market/src/pages/Inventory.jsx`).
2. **Scanned stock** — `public.scan_items` (`card_id`, `condition`, `language`, `foil_state`,
   `first_edition`, `captured_at`, `seller_uid`, `status`; insert
   `pokoin-rust/crates/external/src/scan_store.rs:1124-1136`), which catches cards a seller owns and
   has scanned even before they are listed. Its DDL is outside this repo
   (`docs/SCAN_CONNECT.md:267` lists the scan tables as created by cardvault `082_scan_connect.sql`,
   referenced again in `scripts/sql/136_scan_row_uidx_ct_groups.sql:3-5`); `scan_items` appears in the
   grants at `scripts/sql/124_least_privilege_roles.sql:124` and gains `pricing jsonb` at
   `scripts/sql/138_seller_pricing_groups.sql:44-45`. **Indexes unknown** (§7).

### 3.3 Listed for sale

Covered by 3.2(1). Two extra day-driven options:

* `public.marketplace_user_listing_events` (`scripts/sql/listing-pipeline.sql:42-54`), written by the
  listing audit trigger (`:112+`, replaced by `scripts/sql/128_channel_synced_audit.sql:13`), with
  index `(card_id, occurred_at desc)` (`:56-57`) and `(event_type, occurred_at desc)` (`:59-60`) — this
  is the cheapest "listed/removed in the last N days" if the event-type index supports the filter.
* `public.marketplace_listing_stats_daily` (`scripts/sql/listing-pipeline.sql:19-34`), PK
  `(card_id, observed_day, source)`, index `(observed_day desc, source)` (`:36-37`) — a real per-day
  per-card rollup already in the writer database, and the closest existing thing to "which cards
  mattered today".
* `public.marketplace_card_weights` (`scripts/sql/listing-pipeline.sql:62-89`) already holds
  `listed_now`, `native_listed`, `sold_7d`, `combined_weight`, `hot_score_24h` per card with an index
  on `combined_weight desc` (`:97-98`) — one indexed read for a ranked cap, but again reason-blind and
  refreshed by trigger/rollup rather than per day.

### 3.4 The daily priority-list query (shape, read-only)

One statement, no writes, reasons kept separate so the collector can spend its day in the right order.
Card ids are unioned from the three sources, mapped to Cardmarket products in bulk, and capped with a
reason tie-break. `:days` and `:cap` are the parameters; the numeric guard on the listings text id is
the one `pokoin-rust/crates/commerce/src/handlers/seller.rs:198` already uses.

```sql
with win as (                                        -- the window, once
  select now() - ($1 * interval '1 day') as since     -- $1 = days
),
viewed as (                                           -- $2 = view weights by type
  select e.card_id::bigint as card_id, count(*) as hits
    from public.marketplace_card_events e, win
   where e.occurred_at >= win.since
     and e.event_type in ('view','click')
   group by 1
),
listed as (                                           -- owned proxy #1
  select l.card_id::bigint as card_id, count(*) as rows
    from public.marketplace_user_listings l
   where l.marketplace_game = 'pokemon'
     and l.status in ('active','paused')
     and coalesce(l.quantity_available,0) > 0
     and l.card_id ~ '^[0-9]{1,18}$'
   group by 1
),
scanned as (                                          -- owned proxy #2
  select s.card_id::bigint as card_id, max(s.captured_at) as last_scan
    from public.scan_items s, win
   where s.captured_at >= win.since
     and s.status = 'active' and coalesce(s.quantity,0) > 0
     and s.card_id ~ '^[0-9]{1,18}$'
   group by 1
),
cards as (
  select card_id, 'viewed' as reason, hits::numeric as weight from viewed
  union all select card_id, 'owned',    rows   from listed
  union all select card_id, 'scanned',  1      from scanned
),
picked as (                                           -- dedupe to one reason per card, best first
  select distinct on (card_id) card_id, reason, weight
    from cards
   order by card_id,
            case reason when 'viewed' then 0 when 'owned' then 1 else 2 end,
            weight desc
),
products as (                                         -- the bulk card → idProduct step
  select p.card_id, p.reason, p.weight, cm.id::bigint as cm_product_id
    from picked p
    join public.marketplace_search_candidates c on c.card_id = p.card_id
    join public.cardtrader_pokemon_blueprints b on b.id = c.ct_id
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(b.card_market_ids) = 'array'
           then b.card_market_ids else '[]'::jsonb end) cm(id)
   where cm.id ~ '^[0-9]+$'
)
select cm_product_id,
       min(card_id)  as card_id,          -- one card per product keeps the walk honest
       min(reason)   as reason
  from products
 group by cm_product_id
 order by min(card_id)
 limit $3;                                -- $3 = the daily cap
```

Notes a worker must keep: the `distinct on (card_id)` step is where a card with two reasons becomes
one row — if the collector needs both, keep `reasons text[]` instead; `min(card_id)` per product
collapses printings that share an idProduct (the §2.1 1→N case); `scanned.card_id` type is assumed
numeric and must be checked before this runs anywhere (§7). The `owned` branch is a full-table read
today unless the partial `card_active` index is usable for the predicate chosen — verify with
`explain (analyze)` on the writer before wiring a timer.

### 3.5 Where the exporter belongs

**A new subcommand in the existing `pokoin-cardmarket-catalog` app**:
`pokoin-cardmarket-catalog cm-watchlist [--days=7] [--cap=4000] --out <file.jsonl> [--apply-irrelevant]`.

Why there, following the nearest example (`cm-offers`, which is this app's own file-driven load,
`pokoin-rust/apps/cardmarket-catalog/src/lib.rs:41-49`, options struct `:104-125`, dispatch in `run()`):

* it already connects to `pokoin_marketplace` with the right conventions
  (`pokoin-rust/apps/cardmarket-catalog/src/db.rs:70-102`: `POSTGRES_USER/POSTGRES_PASSWORD` env or the writer container's own login via
  `docker inspect`, `POKOIN_CARDMARKET_PG_PORT`), which is the database that holds both `cm_prices` and
  the new series;
* it is already deployed and unit-filed on nezopt (`deploy/ops/nezopt-user/pokoin-cardmarket-guides.service:11`
  runs `%h/pokoin-cardmarket/current/pokoin-cardmarket-catalog …`), so a new timer is a copy of
  `pokoin-cardmarket-guides.{service,timer}` beside the other two — the conventions a new feed must
  follow are listed at `docs/PRICE_DUMPS.md:32-42` (user unit under `~/.config/systemd/user`, installed
  under `~/pokoin-deploy/<name>/`, `OnFailure=pokoin-notify@%n.service`, secrets at run time);
* the output is a file the engine reads, exactly like `cm-offers` reads a file the engine wrote — the
  two repos stay joined by a file contract, not a shared connection.

The alternative is a job in the API binary (`pokoin-api job cm-watchlist`, next to
`apps/api/src/jobs/facet_prices.rs`) which is where a **writer** of a Pokoin-owned table would go, but
it runs on the Pi and would need the writer tunnel; the collector runs on nezopt. Keep the exporter on
nezopt with the rest of the Cardmarket feed.

The output should be one JSON object per line
(`{day, cm_product_id, card_id, reason, conditions: [...], languages: [...]}`) so the engine can consume
it without a schema change on its side, and the file should land where the engine's config already
looks (`~/.config/cm-price-engine/`, named in `docs/PRICE_DUMPS.md:26-27` — the exact path is the
engine's business, §7).

New tools are Rust, not Python (AGENTS.md, "Production runtime"); `scripts/` has no cm-price exporter
today (`grep` over `scripts/ deploy/` finds none).

---

## 4. Storage for a daily per-condition series

### 4.1 The smallest schema that answers the question

`public.cardmarket_offer_daily` — one row per product, day, language, condition and seller type,
keyed so a facet's own history is a range scan, with the two optional facet columns kept as
attributes and only `*` allowed unless the collector proves it asks them separately:

```sql
-- db: writer
-- phase: expand
create table if not exists public.cardmarket_offer_daily (
  cm_product_id  bigint       NOT NULL,   -- Cardmarket idProduct, as in 141:38-39
  day            date         NOT NULL,   -- the UTC day the collector saw it
  language       text         NOT NULL,   -- Pokoin key: EN IT DE … ZHT, or '*'
  condition      text         NOT NULL,   -- minCondition facet: NM SP MP PL Poor, or '*'
  seller_type    text         NOT NULL,   -- 'pro' | 'private'  (both, per 141:48-49)
  finish         text         NOT NULL default '*',   -- 'Y' 'N' '*'   (reverse holo)
  first_edition  text         NOT NULL default '*',   -- 'Y' 'N' '*'
  min_cents      integer      NOT NULL,   -- EUR cents, exactly as 141:50-51
  offers         integer,                 -- offers behind the minimum, nullable as in 141:52-53
  counts_complete boolean,                -- false = the walk stopped early, 141:54-55
  observed_at    timestamptz  NOT NULL,   -- the moment within the day
  loaded_at      timestamptz  NOT NULL default now(),
  CONSTRAINT cardmarket_offer_daily_pkey
    PRIMARY KEY (cm_product_id, day, language, condition, seller_type, finish, first_edition)
);
create index if not exists cardmarket_offer_daily_day_idx
  on public.cardmarket_offer_daily (day, cm_product_id);
```

Design choices worth defending in the brief:

* **`day` in the key, `observed_at` as an attribute.** The graph needs a series by day; `observed_at`
  alone is what makes 141 latest-value. The `cardmarket_price_guide_daily` precedent
  (`scripts/sql/126_cardmarket_price_guide.sql:14-32`) does the same.
* **`finish`/`first_edition` in the key, defaulting to `*`.** Collapsing them would average a reverse
  holo into the regular minimum, which `docs/PRICING.md:17-20` forbids as a rule. Defaulting them to
  `*` means the collector can start without them and fill them later without a migration, and a `*`
  row is honestly unreadable for a specific item (`pokoin-rust/crates/external/src/price_sources.rs:809-813`).
* **`seller_type` in the key** — the reason the walk exists at all: the guide and TCGNotify cannot
  separate pro from private (`docs/PRICING.md:295-299`).
* **integer cents, no `numeric`** — same as 141; keeps rows narrow and matches "cents are the unit
  Cardmarket prices in" (`scripts/sql/141_cardmarket_offer_minimums.sql:24-26`).
* **No change-only trick.** 139 stores a row only when a value changes; that is fine for a weekly
  trend and wrong for the owner's "every day" ask, and `docs/PRICE_DUMPS.md:40` already says the
  convention is "Missing days stay missing: no value is invented or carried forward". A daily table
  that only inserts on change makes "no row" mean either "unchanged" or "not walked" — the graph could
  not tell them apart. Carry-forward, if wanted, belongs on the read side
  (`CM_GUIDE_HISTORY_SQL`'s lateral `order by day desc limit 1` at `pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:41-47` is the
  existing example of carrying a guide row onto run days).
* Retention: nothing in the repo prunes 139/141 today; a 400-day window covers the graph's longest
  preset (the `all` window starts at `2024-02-08`, `market/src/price-history.js:13` and
  `pokoin-rust/crates/catalog-api/src/sales/routes.rs:597`, and the range cap is 3660 days, `pokoin-rust/crates/catalog-api/src/sales/routes.rs:605`). Say so in the brief and let the
  owner pick; a plain `delete … where day < current_date - N` in the loader's transaction is enough at
  these sizes.

### 4.2 Migration mechanics, per this repo's rules

`scripts/check-migrations.sh` rules `(b)`, `(c)`, `(d)`, `(e)`, `(g)`, `(h)`
(`scripts/check-migrations.sh:26-55`) apply to a new file in `scripts/sql/`:

* **next free number is 145** — `scripts/sql/` holds `…144_listing_external_identity.sql` and nothing
  above; the check refuses a reuse or a lower number than already in use (rule (b), `:26-30`).
* name `145_cardmarket_offer_daily.sql`, three digits + snake_case;
* first 10 lines must carry `-- db: writer` and `-- phase: expand` (rule (c), `:31-34`); expand is
  correct — the table is new and nothing stops using it;
* it must contain real DDL at line start (rule (e), `:38-40`), which it does;
* it must be undoable: `scripts/sql-reverts/145_cardmarket_offer_daily.revert.sql`, holding
  `-- reverts: scripts/sql/145_cardmarket_offer_daily.sql`, a `-- db:` equal to the migration's, a
  `pg_is_in_recovery()` refusal inside a raising statement, and
  `-- destructive: <reason ≥ 15 chars>` (rules (g)/(h), `:43-53`). Copy the shape of the only revert in
  the tree, `scripts/sql-reverts/144_listing_external_identity.revert.sql`.
* grants follow 141's block (`scripts/sql/141_cardmarket_offer_minimums.sql:63-74`):
  `pokoin_jobs` write, `pokoin_api_read`/`pokoin_api_write` select. **Add `usage on schema`** for
  whichever role reads it — `pokoin-rust/crates/external/src/price_sources.rs:1918` shows what happens otherwise
  (`permission denied for schema cm_prices`).
* Apply target: **the nezopt writer, `pokoin_marketplace` database** — the same database as
  `cm_prices` (`docs/PRICE_DUMPS.md:15`) and as 139/141 (`scripts/sql/139_pricer_sources.sql:19-22`
  carries the `docker exec` line to copy into `docs/DEPLOY.md`'s section). The API reads the Pi replica,
  and physical replication carries writer tables to it (the pattern stated in
  `scripts/sql/130_printing_cm_links.sql:14-15`).

### 4.3 Size per month

Assumptions, stated so they can be argued: ~100 B per heap row (12 narrow columns, no TOAST) + ~70 B
PK btree entry + ~50 B day index entry ≈ **0.22 kB per row including indexes**; 30 days a month;
5 conditions (`NM SP MP PL Poor`, no `*`); both seller types kept.

Rows per month = products × 30 × languages × 5 × 2.

| products | 1 language/day | 2 languages/day | all 13 languages/day |
|---|---|---|---|
| 1,000 | 300,000 rows → **~66 MB** | 600,000 → **~130 MB** | 3,900,000 → **~0.86 GB** |
| 5,000 | 1,500,000 → **~330 MB** | 3,000,000 → **~660 MB** | 19,500,000 → **~4.3 GB** |
| 20,000 | 6,000,000 → **~1.3 GB** | 12,000,000 → **~2.6 GB** | 78,000,000 → **~17 GB** |

Two levers, both bigger than the cap: whether the collector keeps **every language** (13× the rows for
a page it already walks) or only the printing's own language plus `EN`, and whether it keeps both
**seller types** (2×). Keeping one language and one seller type is a 13× smaller table and answers less;
the middle row of the table is what I would plan around. And the real ceiling is not storage: it is
how many product pages the walk can open per day. 20,000 products × 13 languages × 5 conditions is a
number of page views that has to be checked against the collector's rate limits in the other repo (§7).

---

## 5. The endpoint and the graph

### 5.1 What the endpoint does today

`GET /api/marketplace-card-price-history` (`pokoin-rust/crates/catalog-api/src/sales/routes.rs:754-801`):
parses `cardId/from/to` (`:595-611`, default `from = 2024-02-08`, max span 3660 days), reads the card's
`ct_id` from `marketplace_search_candidates` (`:769-776`, `CARD_SQL` `:691-692`), then runs **four legs
in parallel** with `tokio::join!` (`:782-787`): `cardtrader_history`, `tcgcsv::read_tcgplayer_history`,
`history_sources::cardmarket_history`, `read_fx_rates`. The body is one key per block plus `fx`
(`:795-799`); `cache-control` is `public, max-age=20, s-maxage=120` unless a block degraded (`:794`,
`:800`). There is no `pokoin` leg and no `fields=graph` in this checkout — those are on the unmerged
branch the lead mentioned, and this design assumes the new leg joins at `:782-787` exactly as the other
three do.

Each leg follows the same three-part pattern, which is what a new leg must copy:

1. a `const …_SQL` with every value bound positionally (the test at `pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:636-661`
   asserts no interpolation and the exact bind count);
2. a presence guard so a satellite database without the table answers `empty` and Postgres logs no
   error (`table_presence::guarded` + `Presence`, `pokoin-rust/crates/catalog-api/src/shared/table_presence.rs:26-55`,
   probe `to_regclass` `:21`, 10-minute cache `:25`; the table list
   `CARDMARKET_TABLES` at `pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:61-65`; proved by
   `pokoin-rust/crates/catalog-api/tests/price_history_absent_tables_flow.rs:1-8`);
3. a pure builder that emits a status and a series (`cardmarket_source` `:205-222`,
   `cardmarket_history` `:303-318`, the per-product grouping at `:216-221`, and the "unsupported game"
   stub `:225-227`).

The block already declares its own limits in the answer, which is the hook for the new one:
`"conditionSpecific": false, "languageSpecific": false` (`pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:219-220`).

### 5.2 A `cardmarketOffers` leg

Naming: the pricer already calls this feed `cardmarketoffers`
(`docs/PRICING.md:275`, `pokoin-rust/crates/external/src/price_sources.rs:869-876`), so the leg is **`cardmarketOffers`** and the graph
key `cardmarket_offers`. It reads the §4 table through the products it already resolved
(`cm_product_ids`, `pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:230-245`) — the card→product hop is done, do not redo it.

Shape, deliberately per day and per facet rather than one line (compact, and all conditions in one
answer so a condition tap never refetches):

```jsonc
"cardmarketOffers": {
  "source": "cardmarket_offer_daily",
  "currency": "EUR", "metric": "min_cents",
  "status": "available" | "empty" | "unavailable" | "unsupported_game",
  "conditionSpecific": true, "languageSpecific": true,
  "conditions": ["NM","SP","MP","PL","Poor"],
  "sellerTypes": ["pro","private"],
  "products": [{
    "productId": "794461",
    "language": "EN",                     // the one language the desk is showing
    "days": [{
      "day": "2026-11-17",
      "offers": {                          // facet → PKN
        "NM|pro": 156, "NM|private": 149,
        "SP|pro": 140, "MP|pro": 118, "PL|pro": 96, "Poor|pro": 71
      },
      "countsComplete": true               // false = the walk stopped early that day
    }]
  }]
}
```

* **PKN only.** The client never converts currency
  (`market/src/price-history.js:3-8`: "a source is plotted only when the API already answered in PKN"),
  so each facet value is cents → EUR → PKN through the existing `pkn_of_eur`
  (`pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:95-97`, 200 PKN/€ at `:18`, the same constant the pricer uses at
  `pokoin-rust/crates/external/src/price_sources.rs:542`). A missing day is absent, not zero — `pricedDays` drops non-positive values
  anyway (`market/src/price-history.js:100-105`).
* **Language**: answer one language, the desk's pick, defaulting to the printing's own and then `EN`;
  `*` facets must be dropped, not plotted, or the line means "unfiltered mix"
  (`scripts/sql/141_cardmarket_offer_minimums.sql:20-23`). Which language to answer is the desk's
  `pickedLang()` (`solid/src/pages/Card.jsx:778`), which today is not sent to the history read at all.
* **`fields=graph` trimming** belongs to the same unmerged-branch mechanism: the compact answer keeps
  `day` + the facet map and drops `guideDay`, `avg1/7/30`, `low` and every `*Foil` sibling that the
  current `guide_day_entry` still sends (`pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:191-201`, 13 fields/day/product). A
  per-condition series is 10 facet values per day instead of one, so trimming matters more here; the
  same `fields` gate should decide whether the old guide block is included at all — the graph reads
  exactly three of its fields (`trendPkn`, `trendFoilPkn`, `day`, `market/src/price-history.js:130-139`).
* Degradation is per block, so the new leg needs its own `OFFER_TABLES` presence list
  (`pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:61-65` style) including `"public.cardmarket_offer_daily"`, and its own
  `sourceStatus` so a missing table leaves the guide and the sold lines untouched
  (`docs/PRICING.md:333-339` says this explicitly for the pricer's copy of the same feed).

### 5.3 The graph

Facts that make this cheap: the graph component is already generic over source keys.
`props.sources = [{key,label,short,color,gapDays,carry,days}]` (`solid/src/components/desk/SoldPriceGraph.jsx:66-70`),
each becomes a line plus a toggle chip whose off-state is remembered in
`localStorage pokoin.graph.sources` (`:34-51`, `sourceKeys` `:201-213`, `toggleSource` `:204-208`), and
the hover already lists several lines on one day (`:236+`, `soldGraphHoverRows`). The page side already
maps chips → lines for the sold facets: `pickedCond()`/`pickedLang()`
(`solid/src/pages/Card.jsx:777-778`) feed `graphPicks`/`facetKey` and `graphOverlays()`
(`:826-865`, max 8 picks, `GRAPH_PICKS_MAX` `:826`), with a per-grade colour in
`soldSeriesColor` (`:841-844`). The source list itself is `PRICE_SOURCES`
(`market/src/price-history.js:33-37`) — one entry per line, and `priceSourceSeries` (`:151-161`) picks
each one's days out of the response.

**Option A — one line, the desk's facet, the rest one tap away.** A new `PRICE_SOURCES` entry
`{ key:'cardmarket_offers', label:'Cardmarket NM·EN', … }` whose label is built from the desk's picked
condition and language, and an extractor that reads `products[0].days[].offers[cond|seller]`. The visitor
changing the condition chip changes the line, and the other grades stay reachable through the chip row
they already use (`solid/src/pages/Card.jsx:782-786` re-plots on every pick). Cost: ~1 source entry + one extractor
function + passing `{ condition, language, sellerType }` into `priceSourceSeries` (a signature the
function already has room for: it takes `{ reverse }`, `market/src/price-history.js:151`), plus 2 tests
in `market/src/price-history.test.js`. No new UI, no legend growth, no extra cache entries. The risk:
the label must say it is **one grade** ("Cardmarket · NM · EN" next to a plain "Cardmarket" line that
is all-grades trend), and the two lines must not read as the same source.

**Option B — small multiples, one line per condition** in the desk's language, five lines with the
existing grade colours, toggled off individually and remembered. Cost: same payload (the response
already carries all conditions), but five legend chips on a row that already scrolls and fades when it
overflows (`keysOverflow`, `solid/src/components/desk/SoldPriceGraph.jsx:222-235`), five series in the hover (a 4-line tooltip
becomes an 8-line one), a `PRICE_SOURCES` entry per grade (the array is static today,
`market/src/price-history.js:33-37`, so this means generating entries from the response's
`conditions` list, i.e. real new client logic), and the localStorage history cache payload grows because
it holds one entry per `cardId|range` (`market/src/price-history-cache.js:29-33`). Roughly 3× A's work,
and it needs a visual check on a phone (≤720px the filter row is already tight — decision D00002V,
`market/src/styles.css`).

Recommendation: **A now, B as a follow-up on the same payload.** Whichever is chosen, keep the guide
line and rename its label to what it actually is — Cardmarket's guide trend, all conditions, one number
per product (`pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:217` already reports `"metric":"trend"` and `:219`
`conditionSpecific:false`). It must not read as a condition price next to a condition price.

Line style: a daily source with genuinely missing days should **break the line**, not carry a price
forward — `gapDays` small (`market/src/price-history.js:25-32` documents both modes; the guide uses
`gapDays: 99, carry:'onOrBefore'` because a weekly trend stands until replaced, which is exactly the
carrying that `docs/PRICE_DUMPS.md:40` forbids for a new value). If the walk really is weekly, then
weekly is the truth and the line should say so in the label rather than hide it in a carry.

### 5.4 Silver and the feature map

The whole source row is Silver-only today: nothing is asked of the history unless `accountSilver()`
(`solid/src/pages/Card.jsx:464-466`, `:477-478`, `:877-883`; the comment at `:449-457`), and the range
buttons are Silver's alone (`:1564`). Per-condition Cardmarket inherits that gate for free — but say so
in the brief, because "the site's per-condition prices" is a paywalled surface by default here, and the
owner may want the grade line shown to everybody while the history stays Silver's.

Whatever ships changes a user-visible flow, so it updates `docs/FEATURES.toml` in the same PR
(AGENTS.md, "Production runtime"): flow `sold-prices` — "Visitor sees sold medians and price history"
— names `solid/src/components/desk/SoldPriceGraph.jsx` and `market/src/price-history.js` as entries and
`pokoin-rust/crates/catalog-api/src/sales/core.rs`, `market/src/price-history.test.js`,
`market/src/sold-graph.test.js` as proofs, with `status = "partial"`
(`docs/FEATURES.toml:375-381`); `scripts/check-features.sh` checks that the map still names real files
and real tests (`docs/CI.md:11`).

---

## 6. The pieces of work, in order

Each is one worker brief. Files, behaviour, tests; W1∥W2 and W5∥W6 are the parallel pairs.

**W1 — the daily table (no code).** `scripts/sql/145_cardmarket_offer_daily.sql` +
`scripts/sql-reverts/145_cardmarket_offer_daily.revert.sql`, exactly §4.1's columns/key/index plus the
grant block and `-- db: writer`, `-- phase: expand`. Tests: `scripts/check-migrations.sh` clean (run it;
it reads HEAD only, `:57`), `scripts/check-fast`. **Blocks W3, W5, W6.** No production apply here — that
is the owner's step (`scripts/check-migrations.sh:7-8`: a human copies the `docker exec` line from
`docs/DEPLOY.md`).

**W2 — the priority-list exporter.** `pokoin-rust/apps/cardmarket-catalog`: a `cm-watchlist` command
(`src/lib.rs` options + dispatch, beside `cm-offers` at `:41-49` and the `Options` struct `:104-125`), a
new `src/watchlist.rs` holding §3.4's SQL as one constant with positional binds, `--out file.jsonl`,
`--days`, `--cap`, and one JSON line per product with its reason. Dry run prints the counts (the app's
convention, `pokoin-rust/apps/cardmarket-catalog/src/lib.rs:26-27`, `:37-40`). Tests: unit tests for the reason precedence/dedup and the
cap, and one `--out` golden file test. Timer+service files beside
`deploy/ops/nezopt-user/pokoin-cardmarket-guides.{service,timer}` and the `expected-active` note
(`docs/PRICE_DUMPS.md:47` says the cm units are not in it). **Independent of W1 — run in parallel.**

**W3 — the daily loader.** Decide the writer: either the engine's `pokoin-cm-price-ingest` inserts into
`cardmarket_offer_daily` itself, or this repo grows `pokoin-cardmarket-catalog cm-daily --file
daily.jsonl --apply` next to `cm-offers` (`src/cm_offers.rs` is the template: strict record validation
`:120-153`, facet key `:156-166`, multi-format parse `:172+`, staging table + upsert
`pokoin-rust/apps/cardmarket-catalog/src/db.rs:405-485`). Recommendation: put it here, so Pokoin owns both ends of the table it reads, and
the engine only publishes a file. Tests: skip-counts on a bad record, "a `*` condition never becomes a
grade", idempotent re-apply, dry-run rollback. **Depends on W1.**

**W4 — the contract with the collector (cross-repo, lead-owned).** One document stating the daily file
schema, the condition and language vocabularies of §2 (and the answer to "is a facet `minCondition` or
exact condition?"), the per-day guarantee the owner asked for, the cap that the walk can actually afford,
and where the file lands for W2/W3. Nothing here can enforce it; it needs the other repo. **Blocks W3's
shipping, not W3's code.**

**W5 — the `cardmarketOffers` leg.** `pokoin-rust/crates/catalog-api/src/sales/history_sources.rs`:
`CM_OFFER_HISTORY_SQL`, an `OFFER_TABLES` presence list, a `cardmarket_offers_source` builder (§5.2's
shape), a `cardmarket_offers_leg` mirroring `:286-298`; `routes.rs`: join it at `:782-787` and add the
key at `:795-799`; `card_id → products` reuses `cm_product_ids` (`:230-245`). Tests: extend
`pokoin-rust/crates/catalog-api/tests/price_history_absent_tables_flow.rs` so a database without
`cardmarket_offer_daily` answers `empty` with no Postgres error line, plus the pure builder's unit tests
and the bind-count test pattern of `pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:636-661`. `game != "pokemon"` → `unsupported_game`
before any probe (`:310-312`). **Depends on W1; can run in parallel with W6.**

**W6 — the graph line (Option A).** `market/src/price-history.js`: one `PRICE_SOURCES` entry and a
facet extractor (§5.3), `fields=graph` request if the unmerged branch lands first; `market/src/price-history.test.js`:
a fixture with the new block, "an absent block draws one line less" (the contract in `:3-8`), "a `*`
facet is never a grade line"; `solid/src/pages/Card.jsx`: pass the desk's condition/language into
`priceSourceSeries` (`:881-883`) and relabel the guide line. `scripts/check-fast` + the JS test files;
no UI claim without a browser look at both a grade and a no-data card. **Depends on W5's shape, not its
merge — it can be built against the fixture.**

**W7 — the docs and the map.** `docs/PRICE_DUMPS.md` new row for the daily per-condition feed and the
**stale `:30`** sentence about `cm_prices`; `docs/PRICING.md` "Price sources" note that the scanned
facets now have a history and are read by the graph; `docs/FEATURES.toml` `sold-prices` entries/proofs
(`:375-381`). Small, last, and required by AGENTS.md for the user-visible part.

Parallelism: W1 ∥ W2 → W3 → (W5 ∥ W6) → W7, with W4 running alongside from the start. Nothing here
builds the collector; that is the other repo's work and W4 is the interface to it.

---

## 7. What this checkout could not determine — for the lead

Cross-repo and volumes. The queries are read-only and meant for the nezopt writer / the engine's own
store; this run was told to touch no database and no host, so none were run.

1. **Is the collector walk actually running, and how often does one product get a fresh facet?**
   `docs/PRICE_DUMPS.md:24-28` recorded the walk as installed-but-not-started on 2026-11-11 and
   `:15` records a 7-day cycle; `docs/PRICE_DUMPS.md:30` contradicts the code that reads the view.
   On `pokoin_marketplace`:
   `select count(*) from cm_prices.current_minimums; select min(published_at), max(published_at),
    count(distinct cm_product_id) from cm_prices.current_minimums;
    select max(observed_at), min(observed_at) from cm_prices.current_minimums;`
   Then the decisive one — **does the engine keep a daily series behind the view, or only the newest
   facet?** (`\d cm_prices.*` in the engine's schema / its own README). If a daily series already
   exists, W1/W3 shrink to a projection of it.
2. **The real facet vocabulary the collector emits today**: which condition strings (does it ever
   produce `GP`/`Good`, exact-condition rather than `minCondition`, or `Damaged`?), which language codes
   (any `ID TH VI`?), and whether `finish`/`first_edition` are ever asked exactly or only as `*`
   (`docs/PRICING.md:335-339` says a scan asked with `--finish '*' --first-edition '*'` stores no exact
   value). This decides W1's key and W4's contract.
3. **Products, not prices**: how many products the walk covers now (`docs/PRICE_DUMPS.md:24-25`: 406
   products in the 2026-11-11 publish; the owner's brief says ~846) and what its daily page budget is, to
   set the exporter's `--cap` in W2 — 20,000 products/day is a different machine than 846/week.
4. **`marketplace_card_events` indexes and volume** — `select indexname, indexdef from pg_indexes where
   tablename = 'marketplace_card_events';` and `select count(*) from marketplace_card_events where
   occurred_at >= now() - interval '1 day'; select event_type, count(*) from marketplace_card_events
   where occurred_at >= now() - interval '7 days' group by 1;` plus
   `select count(distinct card_id) from marketplace_card_events where event_type in ('view','click') and
   occurred_at >= now() - interval '7 days';` — the last one **is** the size of "viewed", and §3.4's
   `viewed` CTE is only cheap if an `occurred_at`-leading index exists. If it does not, W2 needs a small
   daily rollup table (the `marketplace_listing_stats_daily` pattern,
   `scripts/sql/listing-pipeline.sql:19-37`) refreshed by the exporter, not a scan of the event log.
5. **`scan_items` type, DDL and indexes** — `\d public.scan_items` (is `card_id` uuid or text? §3.4
   assumed it casts to bigint) and the same for `marketplace_card_events`; both live in the CardVault
   `oracle-postgres/schema` tree, which this worktree cannot read.
6. **Listings volume and index usability** — `select count(distinct card_id) from
   marketplace_user_listings where status in ('active','paused') and quantity_available > 0;` and
   `explain (analyze)` of §3.4's `listed` CTE against `marketplace_user_listings_card_active_idx`
   (`pokoin-rust/crates/commerce/sql/001_commerce.sql:79-82`), noting that predicate says `status =
   'active'` while the query wants paused-with-stock too.
7. **CM coverage of the viewed/owned set** — of the cards §3.4 picks, what share has a Cardmarket
   product at all: `count(distinct b.card_market_ids)` over that join, and how many cards map to
   **several** idProducts (the §2.1 1→N case the graph currently papers over with `products[0]`).
   Without this number the whole feature might serve a line for a third of the pages.
8. **How many rows the graph's `all` window would move** — products × days × facets, against §4.3, plus
   the response size of the unmerged `fields=graph` path (the guide block is already 13 fields/day,
   `pokoin-rust/crates/catalog-api/src/sales/history_sources.rs:191-201`).
9. **Whether `cm_prices` and the new table can live in one schema** — the least-privilege roles list
   tables by name (`scripts/sql/124_least_privilege_roles.sql:121`), and `cm_prices` is a schema the
   engine owns; who grants `usage` to `pokoin_api_read`, and does the Pi replica carry a non-public
   schema (it should, being physical replication, but the grants do not replicate if the engine's
   publish sets them itself).
10. **Whether the owner wants per-condition prices behind the Silver gate** (`solid/src/pages/Card.jsx:464-466`,
    `:877-883`) — the code says sources are Silver's; the brief says "show them on the graph".
