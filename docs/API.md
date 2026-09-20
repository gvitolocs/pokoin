# Pokoin API map

Public marketplace API runtime is **Pi** Docker `pokoin-oracle-api`
(`/srv/pokoin/api/current` → release overlay). `pokoin.com/api/*` rewrites to
`https://api.pokoin.com/api/*` — **not** Vercel serverless. Do not add
`api/*.js` serverless functions in this repo.

## Clients vs shared backend

```text
Pokoin Web (this repo, market/) ──┐
                                  ├──> Shared Pokoin API on Raspberry Pi
CardVault app (Flutter) ──────────┘     api.pokoin.com
```

| Client | Repo | Role |
| --- | --- | --- |
| **Pokoin Web** | `gvitolocs/pokoin` (this repo) | Website / React SPA |
| **CardVault** | `gvitolocs/cardvault` | Android/iOS app client |
| **Pokoin API** | **Shared backend** on Pi | Auth, marketplace BFFs, listings, recents, … |

The backend is **not** “the CardVault backend” and **not** website-only.
Both clients use the same Firebase-bearer contracts on `api.pokoin.com`.
Deploying the shared API is **not** deploying the CardVault app (and not
`scripts/deploy-web.sh`).

Pi hosts the API **runtime**. Writers, dump ingest, and leftover pipelines
follow [GAMES.md](GAMES.md) (nezopt writer, Oracle GET hop, etc.) — the Pi
runtime does not imply every database lives on the Pi.

## Who owns what (strangler / overlay)

| Layer | Location | Notes |
| --- | --- | --- |
| Runtime host | Pi `pokoin-oracle-api` | Atomic release dirs under `/srv/pokoin/api/releases/` |
| Legacy base handlers | Historically shipped from `cardvault/pokemon_card_vault/api` onto the Pi image | **Legacy / transitional.** Inspect as reference; do not add new Pokoin domain features there. |
| **Shared Pokoin domain APIs (canonical for new work)** | **this repo** `server/pokoin-api/` (+ some `server/api/`) | Overlays onto the live Pi release from `origin/main` |
| CardTrader market dump | Oracle `cardtrader-oracle-api` | Global marketplace snapshots — not seller inventory |

**New shared API functionality belongs in this repo’s `server/pokoin-api/` (or
`server/api/` for search-style overlays), deployed with the matching
`scripts/deploy-*-api.sh`.** Do not implement or deploy shared backend
features from the CardVault app project.

Overlay examples: `scripts/deploy-messages-api.sh`,
`scripts/deploy-cardtrader-sync-api.sh`, `scripts/deploy-search-api.sh`,
`scripts/deploy-recents-api.sh`.

Oracle `pokoin-marketplace` is the CardTrader dump / Postgres **writer**, not the
public first hop. Topology: [GAMES.md](GAMES.md). Non-Pokemon **ingest** APIs
are Oracle `127.0.0.1:18082` `/api/ingest/{game}` writing isolated 15T
databases. Pokemon stays on this Pi map. Plan: [MULTIGAME_REIMPORT.md](MULTIGAME_REIMPORT.md).

### CardTrader seller inventory (Pokoin-owned)

| Route | Role |
| --- | --- |
| `POST /api/cardtrader-connect` | Validate token, encrypt, register order webhook, run initial inventory reconcile |
| `GET /api/cardtrader-status` / `GET /api/cardtrader-sync` | Connection + last sync summary |
| `POST /api/cardtrader-sync` | Full inventory reconcile (`GET /products/export`) |
| `POST /api/cardtrader-webhook/:uid` | Order sale stock gate → linked Pokoin qty (idempotent) |

Invariant: **CardTrader inventory ⊆ Pokoin inventory**. Pokoin-only listings are
never modified by reconcile. Incomplete/failed CT exports never trigger
destructive “missing product” removal (CT has no product-delete webhook).

Deploy note: `scripts/deploy-cardtrader-sync-api.sh` overlays only
`server/pokoin-api/`. The live E2E harness
(`scripts/e2e-cardtrader-inventory-sync.sh`) is repo tooling and is **not** part
of the Pi runtime artifact — a main tip that changes only that script does not
require an API redeploy.


**Navigate live**

| URL | What |
| --- | --- |
| `GET /api/__contract` | React/Flutter identity, images, page BFFs, route families |
| `GET /healthz` | Pipeline: Postgres, Valkey, Meili, Pi CDN. **503** if any is down. Not a Node liveness ping. Page BFFs never return `ECONNREFUSED` / `127.0.0.1:5432`; they return **503** `{error:"We are working on a solution."}`. SPA swaps to `WorkingOnIt`. Uptime mail from **nezopt** (`scripts/pokoin-uptime-mail.sh`) goes to `vitologiuseppe17@gmail.com` on down / recovery after **two consecutive** 2-minute samples (so a single CDN `/health` timeout does not spam Gmail). |
| `GET /api/__routes` | Every hosted handler + `family` |
| `GET /api/__routes?group=1` | Same list grouped |
| `GET /api/__routes?family=page-bff` | One family |

Do not move CardVault `api/*.js` into subfolders. The Pi API maps
`/api/foo` → `api/foo.js`. Families are `server/api-route-families.js`.

**Human docs (contracts; some still live under the legacy CardVault tree)**

- CardVault `pokemon_card_vault/docs/react-api-architecture.md` — contract (legacy location)
- CardVault `pokemon_card_vault/docs/react-page-apis.md` — home / search / card / set BFFs
- CardVault `pokemon_card_vault/docs/oracle-api-migration.md` — generated from `server/api-route-manifest.js`
- CardVault `pokemon_card_vault/docs/api-route-catalog.json` — machine catalog (now includes `family`)
- CardVault `pokemon_card_vault/docs/pokoin-api.md` — auth examples
- This repo [GAMES.md](GAMES.md) / [DEPLOY.md](DEPLOY.md) — topology and how to ship overlays
- pokoin-web `docs/ARTISTS.md` — leftover artists PK vs public `card_id` display cache

**Recently Seen (shared)**

| | |
| --- | --- |
| Contract | `GET/PUT/POST /api/marketplace-recents` with **explicit** `game` (`pokemon` \| `one_piece` \| `riftbound`) |
| Source | `server/pokoin-api/marketplace-recents.js` |
| Deploy | `scripts/deploy-recents-api.sh` (Pi overlay) |
| Schema | `scripts/sql/090_marketplace_user_recents_game.sql` on **nezopt writer** only |
| Auth | Firebase bearer → server uid; never client uid |
| Isolation | SQL `WHERE user_uid AND game`; cards validated in that game’s catalog |

Bare calls without `game` / satellite Host / `x-pokoin-game` return **400** (no
silent Pokemon default). Older app builds that only used Firestore
`user_card_recent_views` are unaffected until they adopt this API.

**React page BFFs (pokoin-web)**

| Page | API |
| --- | --- |
| Home | Rails vector: Worker `GET /api/marketplace-home` on pokoin.com (origin `api.pokoin.com`), else Pi `GET /api/marketplace-rails`, else Pi `GET /api/marketplace-home-page`. Recents: 24 ids per game locally (`pokoin.recentCardIds.{game}`), signed-in `GET/PUT/POST /api/marketplace-recents?game=` (`marketplace_user_recents` PK `(user_uid, game)`). Do not use Flutter `api.pokoin.com/api/marketplace-home` (~170 KB). **No Supabase.** First paint: [HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md). |
| Search | `GET /api/marketplace-search-page` + `GET /api/marketplace-suggest` (print_language; western tie-break on equal Meili score; suggest ids can stay hot for search-page) |
| Scan | `POST /cardscan/identify?catalog=pokemon_generic` — leftover-JPEG singles like old Milo; live default is TCGPlayer. Desk uses `public_id`. Leftover `ct_id` × 2 if `public_id` is missing. [SCAN.md](SCAN.md), [MARKET.md](MARKET.md) |
| Extension auth | `/extension/auth-bridge` — Firebase ID token `postMessage` (`pokoin-auth-token` / `accessToken`) for the Chrome extension. Not an API. Skip marketplace chrome. |
| Card | Desk first paint from the URL slug (no BFF). `GET /api/marketplace-card-page` hydrates in the background (`version` / `card.version` is the CLIP `pokoin_version_sets` key; `versionCount` is `member_count`, the **same-artwork** count; `rarities` is same English name + expansion for the desk `<select>`; `card.artist` is denormalized on candidates by public `card_id`). Set-symbol circles under the scan are `GET /api/marketplace-version-set?cardId=` (this illustration’s expansions), refetched when the select changes. Listings are a parallel `GET /api/marketplace-listings` (`listings-cache.js`; empty `[]` is a hit — invalidate after POST). Seller username on a Shop row opens `/marketplace/{lang}/users/{username}` (`GET /api/marketplace-listings?sellerUsername=&nativeOnly=1`; resolve `seller_uid` from `marketplace_user_listings.seller_name` first, Firebase `usernames` / `usernameLower` only when that misses). Related cards on the desk cap at **12** tiles. Sold-price graph loads `GET /api/marketplace-card-sales?cardId=&slices=1` (every stored daily combination). Filter toggles stay local (`sold-sales.js`). `localStorage` `pokoin.cardSales.v11.` paints first (TTL 15 days) then the desk refetches so a new persist day is not frozen. Header last-day PKN is the current local series (`lastMedianPkn`). Japanese/Korean printings keep Asian langs only in the SPA. Graph geometry: `market/src/sold-graph.js`. |
| Protection | `/protection`. Physical checkout escrows site PKN. Confirm delivery on `/orders` releases the seller. No-ship after 7 days refunds the buyer. Disputes: first reply 48 hours, decision 5 business days. |
| Versions | `{canonicalPath}/versions` — title is `{name} - {set}` with the rarity count once beside it. **Rarity Lineup** (rarities in this set), then CLIP printings grouped by TCG era (Mega Evolution through Original; see [TCG_ERAS.md](TCG_ERAS.md)). Tile price is listed cheapest from `cheapest_homepage_cache_blueprint`, then last-day sold median for leftovers. Map: [VERSIONS.md](VERSIONS.md). |
| Set desk | Skeletons until `fetchExpansionCards` finishes (`hasMore === false`). Walk is `GET /api/marketplace-expansion-page?slug=&limit=48` pages. SQL leftover `card_id` desc is not shown. Default sort Number, Official when a checklist exists (Celebrations, Lost Origin). Homepage webps then load 12 at a time from that order. The next 12 wait for a scroll. [MARKET.md](MARKET.md#set-desk-first-paint). |
| Sets index | `GET /api/marketplace-expansion-page?limit=2000` (era catalog in `Sets.jsx` / `set-logos.js`). Watchtower slugs → `/card-images/expansions/wordmarks/{slug}.png`; leftover slugs → `/card-images/expansions/logos/{slug}.png`. Reverse-holo variants stay hidden unless the filter query matches. |
| Portfolio / Explore | `GET /api/marketplace-portfolio` (Pokoin catalog + native PKN overlay; `?id=` public id or leftover `ct_id`; `?game=` OP/RB). Never CardTrader leftover images. Never USD. |

Set lede uses `expansion.cardCount` / `total`. That is stored
`catalog_card_count` (grid singles with art), not TCGDex printedTotal.
The desk does **not** flash 48 leftover-id tiles; skeletons stay up until
the walk completes. [MARKET.md](MARKET.md#set-desk-first-paint). Schema:
`oracle-postgres/schema/029_marketplace_set_catalog_counts.sql`. Refresh:
`SELECT public.refresh_marketplace_set_catalog_counts();`.
`expansion.nationality` is `pokoin_pokemon_expansions.nationality`
(japanese / chinese / western / …). JP/CN circle flags go **left of**
`h1.page-title` only; [PRINT_FLAGS.md](PRINT_FLAGS.md).

**Silver CT / CM / VT** (Best Deal pills; Firestore Silver **or** `pokoin.auth.session`)

| Pill | Behavior |
| --- | --- |
| CT | SPA opens leftover `https://www.cardtrader.com/en/cards/{ct_id}` in a new tab with `noopener,noreferrer` (no Pokoin referrer). Lookup fallback `GET /api/cardtrader-redirect?format=json` then the same open — the browser never 302s through pokoin.com. Sanji `818358` → `409179`. Do not spoof Google as the referrer. |
| CM | `GET /api/cardmarket-redirect?id={publicId}&format=json` then `window.open`. Pokemon: stored/product URL, else Singles search **name + collector** (`dawn 129`, same fields as VT). OP/RB: Cardmarket `Products/Search` `{name} {number}`. Probing cardmarket.com from this datacenter is Cloudflare **403**; the buyer's browser is not. |
| VT | Vinted Italy catalog. SPA `search_text` is **name + collector hash** (`Gumshoos 184`, not `Gumshoos` and not English set name) plus `catalog[]=4824` (Hobby e collezionismo). Vinted ANDs tokens; `Pokemon Gumshoos 184 Destined Rivals` is 0 hits. OP: `One Piece Card Game {name} {number}`. RB: `Riftbound TCG {name} {number}`. |

**Workers in this repo** (`workers/`)

| Worker | Job |
| --- | --- |
| `pokoin-origin` | OG HTML for card paths, plus homepage rails Cache API (`marketplace-home.js`). Origin 530 / Cloudflare 1033 becomes the working page, not tunnel copy. |
| `pokoin-working` | `api.pokoin.com` / `api2.pokoin.com`: same working page when the Pi tunnel is down. GIF is on Vercel (`/home/working.gif`). |
| `pokoin-shortlink` | `/{digits}` → canonical card path |
| `marketplace-home` | Edge rails vector + `marketplace-card-tiles`. Origin is `https://api.pokoin.com`. |
| `marketplace-card-og` | OG **HTML** for link-preview bots (not an image file). Leftover image rewrite; `?og=1` / `?bot=1`; satellite hosts. |

**This repo also**

- `market/src/api.js` — SPA client
- `vercel.json` — SPA routes + `/api/*` rewrite
- `server/pokoin-api/` — shared Pokoin API overlays (messages, CardTrader seller sync, recents, …)
- `scripts/sql/` — marketplace SQL applied on the **nezopt writer** primary (`pokoin-marketplace-postgres-15t`). The Pi API reads a streaming replica (`127.0.0.1:5432`). Never migrate or dump-write on the replica.
