# Pokoin API map (web)

Handlers live in CardVault, not this repo. Do not add Vercel serverless
functions here. `pokoin.com/api/*` rewrites to `https://api.pokoin.com/api/*`.

**Navigate live**

| URL | What |
| --- | --- |
| `GET /api/__contract` | React/Flutter identity, images, page BFFs, route families |
| `GET /api/__routes` | Every hosted handler + `family` |
| `GET /api/__routes?group=1` | Same list grouped |
| `GET /api/__routes?family=page-bff` | One family |

Do not move CardVault `api/*.js` into subfolders. The Oracle server maps
`/api/foo` → `api/foo.js`. Families are `server/api-route-families.js`.

**Human docs (CardVault `pokemon_card_vault/docs/`)**

- `react-api-architecture.md` — contract
- `react-page-apis.md` — home / search / card / set BFFs
- `oracle-api-migration.md` — generated from `server/api-route-manifest.js`
- `api-route-catalog.json` — machine catalog (now includes `family`)
- `pokoin-api.md` — auth examples

**React page BFFs (pokoin-web)**

| Page | API |
| --- | --- |
| Home | Rails vector: Worker `GET /api/marketplace-home` on pokoin.com, else Supabase `marketplace_rails`, else Oracle `GET /api/marketplace-home-page`. Recents are client-side. Do not use Flutter `api.pokoin.com/api/marketplace-home` (~170 KB). First paint: [HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md). |
| Search | `GET /api/marketplace-search-page` + `GET /api/marketplace-suggest` |
| Card | `GET /api/marketplace-card-page` |
| Set desk | `GET /api/marketplace-expansion-page?slug=` |
| Portfolio / Explore | `GET /api/marketplace-portfolio` (Pokoin catalog + native PKN overlay; `?id=` public id or leftover `ct_id`; `?game=` OP/RB). Never CardTrader leftover images. Never USD. |

Set lede uses `expansion.cardCount` / `total`. That is stored
`catalog_card_count` (grid singles with art), not the first page of 48 and
not TCGDex printedTotal. Schema:
`oracle-postgres/schema/029_marketplace_set_catalog_counts.sql`. Refresh:
`SELECT public.refresh_marketplace_set_catalog_counts();`.

**Silver CT / CM / VT** (Best Deal pills, Firestore Silver)

| Pill | Behavior |
| --- | --- |
| CT | SPA opens leftover `https://www.cardtrader.com/en/cards/{ct_id}` in a new tab with `noopener,noreferrer` (no Pokoin referrer). Lookup fallback `GET /api/cardtrader-redirect?format=json` then the same open — the browser never 302s through pokoin.com. Sanji `818358` → `409179`. Do not spoof Google as the referrer. |
| CM | `GET /api/cardmarket-redirect?id={publicId}&format=json` then `window.open`. Pokemon: stored/product URL, else Singles search **name + collector** (`dawn 129`, same fields as VT). OP/RB: Cardmarket `Products/Search` `{name} {number}`. Probing cardmarket.com from this datacenter is Cloudflare **403**; the buyer's browser is not. |
| VT | Vinted Italy catalog. SPA `search_text` is **name + collector hash** (`Gumshoos 184`, not `Gumshoos` and not English set name) plus `catalog[]=4824` (Hobby e collezionismo). Vinted ANDs tokens; `Pokemon Gumshoos 184 Destined Rivals` is 0 hits. OP: `One Piece Card Game {name} {number}`. RB: `Riftbound TCG {name} {number}`. |

**Workers in this repo** (`workers/`)

| Worker | Job |
| --- | --- |
| `pokoin-origin` | OG HTML for card paths, plus homepage rails Cache API (`marketplace-home.js`) |
| `pokoin-shortlink` | `/{digits}` → canonical card path |
| `marketplace-home` | Edge rails vector + `marketplace-card-tiles`. Match before Supabase `updated_at`. |
| `marketplace-card-og` | Card OG image |

**This repo also**

- `market/src/api.js` — SPA client
- `vercel.json` — SPA routes + `/api/*` rewrite
- `scripts/sql/` — marketplace SQL applied on pokoin-marketplace
