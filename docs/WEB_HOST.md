# Pokoin Web Host Map (2026-10-03)

Live `pokoin.com` is Cloudflare Workers Static Assets (`pokoin-web`, version `7ded97af-4f23-4016-a6be-202d9c227ecb` from `origin/main` 7ec665e, 2026-10-04; previous `02547d29`). Numeric short links (`/{id}`, `/{id}/{slug}`) are `_redirects` rules (one per leading digit, 302 to `/marketplace/en/cards/{id}`). There is no Worker script on ordinary page views. The browser calls `https://api.pokoin.com`. Card photos redirect to `cdn.pokoin.com`. The Pi website process is stopped.

## One origin (2026-10-04)

Every game lives on `pokoin.com/{game path}` with soft navigation; there are **no game
subdomains**. DNS records for `onepiece.pokoin.com`, `riftbound.pokoin.com` and
`dashboard.pokoin.com` were deleted on 2026-10-04 (backup with record ids/targets in
pokoin-scanner `docs/dns-backup-2026-10-04-retired-subdomains.json`). Links, scan
catalogs (`pokoin_url`), robots/sitemap and llms.txt all use `https://pokoin.com/...`.
Old `/{game}/{id}` short links open the card (SPA catch-all, `market/src/shortlink.js`).
Host checks for those names left in code (`game.js`, `marketplace-recents.js`,
`workers/*`) are dead paths, not link sources. The vanity redirects `cards.`,
`cardcaveau.`, `cardvault.`, `forum.`, `wallet.`, `sitemap.` (301 → pokoin.com) remain.

---

## Previous temporary host (no longer in the request path)

| Host | DNS / Ingress | Origin |
| --- | --- | --- |
| `pokoin.com` | Proxied CNAME → `daaeb13c-6abe-459d-bf52-0079a41d9c79.cfargotunnel.com` | Pi `cloudflared` ingress → `http://127.0.0.1:18078` |
| `www.pokoin.com` | Same tunnel | Same |
| `dashboard.pokoin.com` | Same tunnel | Same |
| `onepiece.pokoin.com` | Same tunnel | Same |
| `riftbound.pokoin.com` | Same tunnel | Same |

**Process:** `systemd` unit `pokoin-web-origin.service` (user `nes`)
- Command: `node /srv/pokoin/web/app/scripts/pokoin-web-origin.mjs`
- Static root: `/srv/pokoin/web/current` (release `f3aef6a` of `origin/main`)
- Serves:
  - Landing page (`/`)
  - React SPA (`/marketplace*`, `/wallet`, `/auth`, `/cart`, `/forum`, `/scan`, `/docs`, …)
  - Numeric shortlinks without slug (e.g. `/239324`)
  - Bot OG HTML (`/marketplace/{lang}/cards/{id}...`)
  - Homepage rails vector (`GET /api/marketplace-home`)
  - Proxies `/api/*` → `http://127.0.0.1:18079` (api.pokoin.com)
  - Proxies `/card-images/*` → `http://127.0.0.1:18081` (cdn.pokoin.com)

> **Note:** This is the **temporary** host. Giuseppe decided the SPA must not stay on the Pi. This architecture is not the desired end state.

---

## Target Preview (Not Yet Cut Over)

| Project | Preview URL | Version |
| --- | --- | --- |
| `pokoin-web` (Cloudflare Workers Static Assets) | `https://pokoin-web.vitologiuseppe17.workers.dev` | `519de49c-0797-46d1-b3a7-9ec67083e6db` |

**Repo files:**
- `wrangler.pokoin-web.jsonc`
- `workers/pokoin-web-assets.js`
- `scripts/write-cloudflare-web-routing.mjs`

**Build:** `scripts/build-web.sh` → `dist-web/`
- `/` → landing (`index.html` copy)
- App routes rewrite to `/market/app.html` via `dist-web/_redirects`
- Hashed `/market/assets/*` are immutable
- HTML: `Cache-Control: max-age=0, must-revalidate`

**Worker execution (`run_worker_first`):**
Only these paths run the Worker script:
- `/api/*`
- `/card-images/*`
- `/__/auth/*`
- `/__/firebase/*`
- `/chain/*`
- `/cardscan/identify`

Ordinary HTML, JS, and CSS **do not** run the Worker script.

**Why the domain was not attached:**
The Cloudflare account is over the 100,000 Worker-script daily cap until **2026-10-04 00:00 UTC**. On the preview, static files return `200` and `/api` returns `429`.

**Why a narrow Worker still exists:**
1. The SPA calls same-origin `/api` (see `market/src/extension-auth-bridge.js` `publicApiUrl`).
2. Google sign-in uses `authDomain: pokoin.com`, so `/__/auth/*` must stay on that host.

**Extension zip:** 31 MB, above the Static Assets per-file limit, so it is not in the asset upload. The download Worker is `pokoin-extension-download`. Its routes were removed during the Pi cutover, and the Pi origin currently serves `/download/extension.zip` from disk. `/aab` is a different Worker, `pokoin-aab-downloads`, and those routes were left in place.

---

## Unchanged Hosts (Not Part of This Migration)

| Host | Current Target | Notes |
| --- | --- | --- |
| `api.pokoin.com` | Pi tunnel → `127.0.0.1:18079` | Unchanged |
| `api2.pokoin.com` | Same Pi origin as `api.pokoin.com` | Unchanged |
| `cdn.pokoin.com` | Pi → `127.0.0.1:18081` | Unchanged |
| `test.pokoin.com` | Vercel A `76.76.21.21` (project `web`) | Unchanged; manual alias, not a project domain |
| `rpc.pokoin.com` | PokoinPoS RPC (health, bootstrap peers, `eth_chainId`) | Unchanged |
| `explorer.pokoin.com` | Vercel `web` via host rewrite → `/explorer/*` | DNS must be CNAME to `cname.vercel-dns.com` |
| `news.pokoin.com` | Vercel Hobby (target: Oracle `pokoin-a1` + Cloudflare Tunnel) | [NEWS.md](NEWS.md) |
| `app.pokoin.com` | Flutter CardVault (Android/iOS) | DNS-only; not on `web` project |

---

## Rollback Procedure (If Preview Cutover Is Attempted and Fails)

The Vercel project `web` (team `giuseppevitolo17s-projects`) and its environment variables were **not deleted**.

1. Remove any `pokoin-web` custom-domain routes if they were added.
2. Set `pokoin.com` and `www.pokoin.com` CNAMEs back to `00dae56389d2f4d1.vercel-dns-017.com`.

---

## Rust Suggest (Status)

- `suggest` is 100% Rust at `127.0.0.1:18082` on the Pi.
- **Search, card page, listings, inventory, collections, orders, and SSE are still 100% Node.**
- Do **not** document Rust search as live. Live `rust-routes.json` has only `suggest` at 100.

---

## nezopt k3s Overflow (Status)

- Extra API pods stayed `ContainerCreating` because the `hostPath` `current` symlink is not a directory.
- Do **not** document a 4-pod capacity number.
- Overflow threshold remains **16**. Do not change it in docs as if it were retuned.

---

## Related Documents

- [LANDING.md](LANDING.md) — Landing pipeline, copy, deploy
- [DEPLOY.md](DEPLOY.md) — Production deploy rules
- [MARKET.md](MARKET.md) — React marketplace pipeline and APIs
- [SEO.md](SEO.md) — Marketplace SEO, sitemaps, crawler policy
- [NEWS.md](NEWS.md) — Hypemeter / news.pokoin.com pipeline
- [GAMES.md](GAMES.md) — Multi-game catalog, Pi API, CDN