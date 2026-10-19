# Pokoin Web Host Map (2026-10-04)

Live `pokoin.com` is Cloudflare Workers Static Assets (`pokoin-web`, version `81628312-3650-4644-bce6-53222d643f02` from `origin/main` 8bcdc56, 2026-10-04; previous `623887bb`). `wrangler deployments list --name pokoin-web` is authoritative; each deployment message names its `origin/main` SHA. Numeric short links (`/{id}`, `/{id}/{slug}`) are `_redirects` rules (one per leading digit, 302 to `/marketplace/en/cards/{id}`). There is no Worker script on ordinary page views. The browser calls `https://api.pokoin.com`. Card photos redirect to `cdn.pokoin.com`. The Pi website process is stopped.

## Deploying (2026-10-14)

Publish an exact `origin/main` commit on nezopt with `scripts/publish-web.sh`:

```bash
scripts/publish-web.sh                         # origin/main: build + upload a version (no traffic)
scripts/publish-web.sh --promote <version-id>  # after checking the printed Version Preview URL
```

`WRANGLER=~/.npm/_npx/32026684e21afda6/node_modules/.bin/wrangler` picks the cached
wrangler (default: `wrangler` on PATH, else `npx wrangler@4`). `--build-only [<sha>]` builds
any commit into a temp dir and prints a `solid/scripts/preview.mjs --dist-web` command
for a local check. The script does these steps, in this order:

1. `git archive <sha>` into a temp dir (uploads require the commit to be on `origin/main`).
2. `scripts/build-web.sh` → `dist-web/`.
3. `node scripts/carry-web-release-chunks.mjs dist-web --release <sha>`: copies the
   `/market/s/*` chunks of the **last two releases** from `https://pokoin.com` into the
   upload. `/market/release-chunks.json` lists the files each release owns, newest first,
   and the next deploy reads it from the live site. If the live site has no manifest
   (the first deploy with this step, or one published without it), the step crawls the
   live shell `/market/app` and the chunks it imports instead. A 404 for a listed file is
   skipped; any other error fails the deploy.
4. `node scripts/write-cloudflare-web-routing.mjs dist-web`: `_redirects`, `_headers`.
5. `wrangler versions upload -c wrangler.pokoin-web.jsonc --message "main <sha>"`.
6. `--promote` runs `wrangler versions deploy <id>@100% --name pokoin-web -y`.

Rollback: `scripts/publish-web.sh --promote <previous version>` (`wrangler deployments
list --name pokoin-web` shows the history). The older version does not have the newer
release's chunks, so tabs opened on the newer release reload through `chunk-reload.js` (below).

### Why the old chunks ship again

Every build renames the hashed chunks, and a Workers Static Assets version contains only
its own files. Before 2026-10-14, every deploy blanked pages for about 1–2 minutes (two
deploys that day): pokoin.com kept serving the previous HTML shell, which loaded
`/market/s/*` chunks the new version no longer had (404, "Failed to fetch dynamically
imported module"). Tabs left open on the old release hit the same 404 on their next lazy route.

- **The zone cache is not involved.** The zone has no Cache Rule for `pokoin.com`; the only
  rules are for `api.pokoin.com` / `api2.pokoin.com`. `cf-cache-status: HIT` also appears on
  `/market/app?<random>`, and the zone cache key includes the query string. That `HIT`
  comes from the Static Assets store. The old shell lives on while the new version
  propagates to the edges, and different requests from one page can reach different
  versions. `Cache-Control` cannot shorten that, so `no-store` or `s-maxage=0` on HTML
  would not help, and `no-store` would cost the back/forward cache. HTML stays
  `public, max-age=0, must-revalidate`.
- **Carrying the previous chunks** fixes the old-shell case and open tabs, for two releases.
  One release is ~165 chunks / 4.8 MB, so an upload holds ~500 chunk files. The Static
  Assets limit is 20,000 files per version.
- **A missing chunk's 404 is cached for a year.** The `_headers` rule `/market/s/*` matches
  by path, not by status, so a 404 there also gets `max-age=31536000, immutable`, and
  browsers keep it. This can still happen when a new shell reaches an edge that is still
  on the old version. `market/public/chunk-reload.js` refetches the failed files with
  `cache: 'reload'` before it reloads (below). A zone fix needs Giuseppe's approval and is **not
  applied**: a Response Header Transform Rule `(http.host eq "pokoin.com" and
  starts_with(http.request.uri.path, "/market/s/") and http.response.code eq 404)` → set
  `Cache-Control: no-store`. After applying it, check with
  `curl -sI https://pokoin.com/market/s/missing-x.js`.

### Client fallback

`market/public/chunk-reload.js` is a classic script in the Solid shell's `<head>`, ahead of
the module entry, so it also runs when the entry chunk 404s. It listens for Vite's
`vite:preloadError` (lazy routes and their dependencies), `error` events from `<script>`,
stylesheet and modulepreload elements under `/market/s/` (prefetch hints are ignored), and
unhandled `import()` rejections. The Solid route boundary (`RouteError` in
`solid/src/App.jsx`) calls `window.__pokoinChunkReload(error)` and shows "Loading the
latest Pokoin…" while a reload is pending. When a chunk fails, the script:

1. refetches the file with `cache: 'reload'`, plus every `/market/s/*` file Resource
   Timing lists for this page with a failed status (`cache: 'reload'`) or no status
   (Safari, some Chrome cache hits: `cache: 'no-cache'`, a 304 for a good chunk), and
   reloads once all of them answer 200. The error names only the chunk `import()` asked
   for; when the cached 404 is one of its static dependencies, refreshing only the named
   file let the 404 survive the reload (seen 2026-10-19 after 6383d726). A `?v=` retry of
   the import would not help: it makes a second module instance and its static imports
   still hit the cached 404;
2. else reloads at once if the live `/market/app` names a different entry chunk (a newer release);
3. else retries every 10 s while the deploy propagates, and reloads after the sixth try.

`sessionStorage['pokoin:chunk-reload-at']` allows one reload a minute. A second failure
right after a reload shows the normal route error and does not loop. Offline pages, and
pages where sessionStorage throws, never reload.

## One origin (2026-10-04)

Every game lives on `pokoin.com/{game path}` with soft navigation; there are **no game
subdomains**. DNS records for `onepiece.pokoin.com`, `riftbound.pokoin.com` and
`dashboard.pokoin.com` were deleted on 2026-10-04 (backup with record ids/targets in
pokoin-scanner `docs/dns-backup-2026-10-04-retired-subdomains.json`). Links, scan
catalogs (`pokoin_url`), robots/sitemap and llms.txt all use `https://pokoin.com/...`.
Old `/{game}/{id}` short links open the card (SPA catch-all, `market/src/shortlink.js`).
Host checks for those names left in code (`game.js`, the recents API,
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
  - The SPA (`/marketplace*`, `/wallet`, `/auth`, `/cart`, `/forum`, `/scan`, `/docs`, …)
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

**Build:** `scripts/build-web.sh [out]` → `dist-web/` (or `out`), then `node scripts/write-cloudflare-web-routing.mjs <out>`
- `/` → landing (`index.html` copy of `landing.html`)
- `/market/*` is the Solid app (`solid/dist`; `market/public` is its Vite publicDir): `index.html`
  (copied to `app.html`) is the SPA shell, `/market/s/*` the hashed chunks. There is no React build.
- App routes rewrite to `/market/app.html` via `dist-web/_redirects`
- Hashed `/market/s/*` are immutable
- HTML: `Cache-Control: max-age=0, must-revalidate`; no inline scripts, so the CSP `script-src` carries no hashes
- Local check: `node solid/scripts/preview.mjs --dist-web <out> --port <port>` serves the output with the
  same `_redirects` rules (redirects, rewrites, 404 otherwise)

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

**Extension zip:** 31 MB, above the Static Assets 25 MiB per-file limit, so it is not in the asset upload. Since 2026-10-05 `/download/extension.zip` and `/download/extention.zip` are static `_redirects` rules (302, no Worker) to the Pi CDN copy `https://cdn.pokoin.com/downloads/pokemon-card-extension-<version>.zip` (Pi `/srv/pokoin/card-images/objects/downloads/`). The URL is `EXTENSION_ZIP` in `scripts/write-cloudflare-web-routing.mjs`. The download Worker `pokoin-extension-download` has had no routes since the Pi cutover. `/aab` is a different Worker, `pokoin-aab-downloads`, and those routes were left in place.

---

## Unchanged Hosts (Not Part of This Migration)

| Host | Current Target | Notes |
| --- | --- | --- |
| `api.pokoin.com` | Cloudflare LB: Pi tunnel → Rust edge `127.0.0.1:18079` (0.9), nezopt k3s (0.1) | Native Rust since 2026-10-09 ([RUST_RUNTIME.md](RUST_RUNTIME.md)) |
| `api2.pokoin.com` | Same Pi origin as `api.pokoin.com` | Unchanged |
| `cdn.pokoin.com` | Pi → Rust CDN `127.0.0.1:18081` | Native Rust since 2026-10-09 |
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

## API runtime (2026-10-09)

- Every `api.pokoin.com` route, the edge, the CDN, ct-deals and the backend jobs are native Rust on the Pi (`pokoin-rust-api.service`). The Node API, edge and CDN are stopped and their sources were removed from this repo. [RUST_RUNTIME.md](RUST_RUNTIME.md)
- The nezopt k3s overflow runs the same Rust commit (x86_64) as a Cloudflare Load Balancer origin with weight 0.1. [NEZOPT_OVERFLOW.md](NEZOPT_OVERFLOW.md)
- The same-origin `/api/*` proxy in `scripts/pokoin-web-origin.mjs` (the stopped Pi web host above) still points at `127.0.0.1:18079`, now the Rust edge.

---

## Related Documents

- [LANDING.md](LANDING.md) — Landing pipeline, copy, deploy
- [DEPLOY.md](DEPLOY.md) — Production deploy rules
- [MARKET.md](MARKET.md) — Marketplace pipeline and APIs
- [SEO.md](SEO.md) — Marketplace SEO, sitemaps, crawler policy
- [NEWS.md](NEWS.md) — Hypemeter / news.pokoin.com pipeline
- [GAMES.md](GAMES.md) — Multi-game catalog, Pi API, CDN