# Multi-game hosts + Oracle CDN

## Marketplaces (live)

One shared React SPA (`market/`, Vercel project `web`). Hostname picks the game
via [`market/src/game.js`](../market/src/game.js); API calls append `?game=` and
send `x-pokoin-game` / `x-pokoin-host`. The CF origin Worker also injects `game`
for satellite hosts so Oracle never falls back to Pokemon.

| Host | `game` | DB | Public card id |
| --- | --- | --- | --- |
| `pokoin.com` | `pokemon` (default) | `pokoin_marketplace` | `ct_id * 2` |
| `onepiece.pokoin.com` | `one_piece` | `pokoin_one_piece` | `ct_id * 2` |
| `riftbound.pokoin.com` | `riftbound` | `pokoin_riftbound` | `ct_id * 2` |

### Satellite vs Pokemon APIs

| Endpoint | Pokemon | One Piece / Riftbound |
| --- | --- | --- |
| `GET /api/marketplace-home` | **pokoin.com Worker:** SPA rails vector. **api.pokoin.com:** Flutter hydrate (~170 KB) — SPA must reject it. | **Delegates** to home-page for satellite `game` / Host |
| `GET /api/marketplace-home-page` | Oracle newest fallback; Worker alias of the rails vector on pokoin.com | Same handler, isolated DB via `_marketplace_game` |
| `GET /api/marketplace-search-page` | Meili + Postgres | Postgres-only multigame SQL |
| `GET /api/marketplace-suggest` | Meili/Postgres | Multigame suggest |
| `GET /api/marketplace-portfolio` | Catalog + native PKN overlay | Same handler, isolated DB |

Game resolution order (`cardvault/.../api/_marketplace_game.js`):

1. `?game=` / `marketplaceGame`
2. `x-pokoin-game` / `x-marketplace-game`
3. Host / `x-forwarded-host` / `x-pokoin-host` / Origin (`onepiece.*` → `one_piece`, `riftbound.*` → `riftbound`)

SPA on satellite hosts **skips** `/api/marketplace-home` and calls `/api/marketplace-home-page` only (the Pokemon Flutter home always returned Pokemon cards and short-circuited the UI). Pokemon SPA first paint: [HOME_FIRST_PAINT.md](HOME_FIRST_PAINT.md).

- `/` on satellite hosts → `/marketplace`.
- CDN keys stay raw `ct_id` under `one-piece/` and `riftbound/` (do not rewrite to public id).
- Projections: `public.marketplace_search_candidates` + `marketplace_card_urls` in each isolated DB (`oracle-postgres/schema/026_multigame_marketplace_projections.sql`).
- Refresh: `select public.refresh_multigame_marketplace_projections(...)`.
- Competitive / Supabase rails / Meili: Pokemon-only for now.

**Silver off-site links:** CardTrader URLs are leftover `ct_id` (`409179`), never
public `card_id` (`818358`). `GET /api/cardtrader-redirect?id=` maps either.
The Silver CT pill opens leftover `cardtrader.com` with `noopener,noreferrer`
so CardTrader does not see pokoin.com. Do not spoof a Google referrer.
Cardmarket search for OP/RB uses `/en/OnePiece` and `/en/Riftbound` (not
Pokemon Singles). Fallback `searchString` is `{name} {collector}` like Vinted. Vinted is Pokemon `{name} {collector}` (`Gumshoos 184`);
OP `One Piece Card Game {name} {number}`; RB `Riftbound TCG {name} {number}`.
Do not add English set names — Vinted ANDs tokens and IT listings omit them.
Name-only Gumshoos is 500+. See [API.md](API.md) and [MARKET.md](MARKET.md).

DNS: CNAME → same Vercel target as apex (`00dae56389d2f4d1.vercel-dns-017.com`). Prefer **DNS-only** (grey cloud) for the new hosts until CF WAF skip capacity allows orange-cloud like apex.

## Image URLs (do not change assignment)

Catalog / API / SPA keep storing and returning:

`https://cdn.pokoin.com/{leftover_or_prefix_key}.jpg`

Set at import time by `POKOIN_CARD_CDN_BASE_URL` (default `https://cdn.pokoin.com`) in CardVault importers (`cardtrader-multigame-import.js`, pokemontcg hires, etc.). Rows land in `cdn_image_url` / `image_url`.

SPA [`market/src/api.js`](../market/src/api.js) `preferFullImage` rewrites that host to same-origin `/card-images/…`. Vercel [`vercel.json`](../vercel.json) proxies `/card-images/*` → `https://cdn.pokoin.com/:path*`.

**Do not** rewrite Postgres URLs to `api2` — flip **DNS** for `cdn.pokoin.com` when Oracle has the files.

## Oracle origin

| Host | Role |
| --- | --- |
| `api.pokoin.com` | Marketplace API (Frankfurt `pokoin-marketplace`, unchanged) |
| `api2.pokoin.com` | Oracle card-image origin on **peer1** (`92.5.153.117`) — same remap as the old CF Worker |
| `cdn.pokoin.com` | Public image URL (still assigned in DB). Today still CNAME→R2 until sync finishes; then A→peer1 DNS-only |

Server: `scripts/pokoin-oracle-cdn-server.js` on peer1 (`pokoin-oracle-cdn.service`), root `/home/ubuntu/pokoin-cdn`, port `18090`. Remaps even public ids → leftover (`ct_id`) like `pokoin-cdn-card-images`.

Probe:

```bash
curl -sS https://api2.pokoin.com/health
curl -sSI "https://api2.pokoin.com/one-piece/301338_burn-bazooka.jpg"
curl -sS "https://api.pokoin.com/api/marketplace-suggest?game=one_piece&q=luffy&limit=2"
curl -sS "https://onepiece.pokoin.com/api/marketplace-home-page" | head -c 200   # must be game=one_piece
curl -sS "https://riftbound.pokoin.com/api/marketplace-home" | head -c 200       # must NOT be Pokemon
curl -sS "https://api.pokoin.com/api/marketplace-home-page?game=riftbound" | head -c 200
```

## R2 free tier

Bucket `cardvault-images` ~29 GB. Sync catalog (not `originals/`) to peer1, verify via `api2`, then delete R2 catalog objects until under 10 GB. Sync helper: `scripts/sync-r2-cdn-to-peer1.sh`.
