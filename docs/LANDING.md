# Pokoin.com root landing — pipeline and files

Static get.rarecandy-style page. Source of truth: this repo (`gvitolocs/pokoin`).
This repo is the public web. CardVault is the Flutter app. Production host:
Vercel project `web` (`prj_1x0bUwaSZPeMRU90jQL5Ak8WWnPX`). Live URL:
`https://pokoin.com/`.

Action map canvas (clicks, not files): [landing-action-map.canvas.tsx](/home/nez/.cursor/projects/home-nez-Projects-pokoin-web/canvases/landing-action-map.canvas.tsx).

---

## Pipeline (edit → live)

```
pokoin-web/                 scripts/build-web.sh          Vercel project `web`
index.html + home/  ──►     dist-web/                    pokoin.com/
market/             ──►     dist-web/market/
vercel.json                 GET /              = landing
                            GET /marketplace*   = React market
                            /api/*              = api.pokoin.com
```

Wallet, auth, cart, forum, signal, and the rest of Flutter live on
`https://app.pokoin.com` (Vercel `pokoin-flutter`). Links are in
[CHROME.md](CHROME.md). Do not deploy `cardvault/.../build/web` as pokoin.com.

### Step 1 — Edit here

Work in `/home/nez/Projects/pokoin-web` (this repo).

Local landing preview (relative `home/` URLs):

```bash
python3 -m http.server 8766 --bind 0.0.0.0 --directory /home/nez/Projects/pokoin-web
```

React market:

```bash
cd /home/nez/Projects/pokoin-web/market
npm install
npm run dev
# http://127.0.0.1:5174/marketplace
```

Cursor’s browser on the Mac cannot use `127.0.0.1` on this host. Use Tailscale
`http://100.107.164.33:8766/` or LAN `http://192.168.178.55:8766/`.

### Step 2 — Build and deploy this repo

Do **not** sync into CardVault. Do **not** run `deploy-pokoin-web.sh`.

```bash
cd /home/nez/Projects/pokoin-web
env -u VERCEL_TOKEN vercel pull --yes --environment=production
env -u VERCEL_TOKEN vercel build --prod --yes
env -u VERCEL_TOKEN vercel deploy --prebuilt --prod --yes --archive=tgz
```

| Flag / file | Why |
| --- | --- |
| `env -u VERCEL_TOKEN` | A stale `VERCEL_TOKEN` in the environment fails CLI login. CLI session `giuseppevitolo17` works. |
| `vercel.json` `buildCommand` | `scripts/build-web.sh` writes `dist-web/` (landing with `/home/` paths + Vite `market/`). |
| `outputDirectory` | `dist-web`. Never upload the GitHub source tree as static — that ships Vite `src/main.jsx` and 404s `/marketplace`. |

`vercel deploy --prod` aliases `pokoin.com`. **Do not** alias `explorer.pokoin.com` to this project — that host is Caddy.

`scripts/sync-landing.sh` / `scripts/sync-market.sh` copy into CardVault. They are leftover and not the production path.

### Step 3 — What Vercel serves

Filesystem `index.html` is evaluated **before** rewrites.

| Request | File | App |
| --- | --- | --- |
| `GET /` | `index.html` (landing) | Static HTML |
| `GET /home/landing.css` | `home/landing.css` | Static |
| `GET /marketplace` (and search / sets / cards, **with or without trailing `/`**) | `/market/index.html` | React SPA |
| `GET /api/*` | Oracle proxy | `api.pokoin.com` |
| `GET /wallet`, `/auth`, `/cart`, `/forum`, … | not this host | Punch-out to `https://app.pokoin.com/…` |
| `https://explorer.pokoin.com/` | not this project | Caddy |

`www.pokoin.com/` 301s to `https://pokoin.com/`.

---

## Cache (why HTML can update while CSS stays lime)

`vercel.json`:

| Path | Cache-Control |
| --- | --- |
| `/`, `/index.html`, `/market/index.html` | `max-age=0, must-revalidate` |
| `/home/:path*` (css, js, font, logo) | `max-age=0, must-revalidate` |

After a landing-only deploy, bump `?v=` on `landing.css` / `landing.js` if a browser still holds an old sheet. Origin is `must-revalidate`; query strings defeat leftover 1h caches from before this header change.

---

## Runtime (browser, after paint)

No Flutter wasm. Deferred `home/landing.js`:

- Mobile nav toggle (hamburger `400ms` inOutQuint; overlay slides from the right).
- Navbar tint: transparent → `rgba(0,0,0,0.4)` after a few pixels of scroll.
- Unregister leftover service workers.
- IntersectionObserver `.reveal` → `.is-visible` (slide 100px / 1s outQuart; `.reveal-fade` 20px / 1.2s ease + 300ms; `.reveal-grow` scale 0.75). Skipped if `prefers-reduced-motion`.
- Count-up on `[data-count]` (height, peer count).
- Motion inventory vs get.rarecandy.com: [ANIMATIONS.md](ANIMATIONS.md).
- Idle `fetch` `https://rpc.pokoin.com/health` → `[data-height]`, `[data-health]`.
- Idle `fetch` `https://rpc.pokoin.com/network/peer-status.json` → `[data-peers]` and `[data-peer-list]` (geo only, no `innerHTML`).

A tiny inline script in `<head>` sets `document.documentElement.classList.add("js")` **before** CSS so `.reveal` can start hidden. Without JS, `html:not(.js) .reveal` stays visible.

---

## Every file — this repo (`pokoin-web`)

| Path | Role |
| --- | --- |
| `index.html` | Source HTML for `pokoin.com/`. Relative `home/` URLs for local preview. |
| `home/landing.css` | Satoshi, Pokoin gold `#FFD33D` (Flutter landing), layout, `.reveal`, marquee, CTA glow, store icons, coming-soon cards. |
| `home/landing.js` | Nav, reveals, counters, idle RPC, SW unregister. |
| `home/logo.png` | Nav + hero mark (7339 bytes). |
| `home/satoshi.woff2` | Self-hosted Satoshi variable font. |
| `scripts/build-web.sh` | Production build: landing + `market/` into `dist-web/`. |
| `vercel.json` | Headers, www redirect, `/marketplace*` (slash and no-slash) → `/market/index.html`, card shortlinks → Oracle 302, `/api/*` → `api.pokoin.com`. |
| `scripts/sync-landing.sh` | Leftover CardVault copy. Not production. |
| `docs/LANDING.md` | This file: pipeline, inventory, copy rules, proof. |
| `docs/CHROME.md` | Icon / punch-out map. `pokoin.com` vs `app.pokoin.com`. |
| `docs/NEWS.md` | `news.pokoin.com` on `pokoin-a1` behind Cloudflare Tunnel. |
| `docs/BOOTSTRAP_PEERS.md` | Public vs operator peer JSON (OWASP API3). |
| `docs/ANIMATIONS.md` | get.rarecandy.com IX2 inventory and Pokoin mapping. |
| `README.md` | Ecosystem README. Points here for the landing. |
| `.gitignore` | Ignores `dist-web/`, `.vercel/`, `market/node_modules/`, `.cursor/`. |

OG banner, favicon, and the security PDF still live on the old CardVault static files. Those URLs 404 unless they are added to this repo.

Visual reference only (not deployed): `/home/nez/Projects/candyext` (get.rarecandy clone). Lime `#cbf062` there. This page uses Flutter Pokoin gold `#FFD33D`, not Tailwind `#facc15` (that still reads as lime on a black page).

### `index.html` — document map

| Region | Markup | Notes |
| --- | --- | --- |
| Head | title, description, OG/Twitter, canonical, JSON-LD Organization | No “wrapped liquidity”. `theme-color` `#000`. |
| Skip | `.skip-link` → `#main` | Yellow on focus. |
| Header | logo `/`, marketplace, wallet, scan, `/docs`, forum | Hamburger `.nav-toggle` on ≤991px. |
| Hero | H1 white “The market belongs to the collectors.” + yellow “Buy. Sell. Settle in PKN.” | Lede: global P2P marketplace built for everyone. CTAs: Explore cards `/marketplace`, Start selling `/inventory`. |
| Features | three `<a class="feature">` | `/marketplace`, `/wallet`, `/scan`. |
| Live | marquee + four `.stat` | Height/peers/health live-updated. Chain ID `26062026` static. |
| Security | two `.card` | May 2026 PDF. Reserve proof (renounced, JSON, BscScan, Pancake). |
| Peers | `[data-peer-list]` | Snapshot then idle refresh. |
| Coming next | three `.soon-card` | iOS/Android: not in stores (web is live). More peers: permissioned, no open intake. |
| CTA | yellow `.cta-box` | Live: marketplace, signal, forum, cardscan. Placeholders: App Store / Play (`aria-disabled`). |
| Footer | four columns | Same destinations as old Flutter `SiteFooter`. |
| Script | `home/landing.js` `defer` | Last. |

Hero copy (locked):

> The market belongs to the collectors.
> Buy. Sell. Settle in PKN.
> A global peer-to-peer marketplace built for everyone.
> Explore cards → Start selling (`/marketplace`, `/inventory`).

Tab / OG title uses a colon (`Pokoin: …`), not an em dash.

Do not put “wrapped liquidity” or “Live peers — not testimonials” on this page. wPKN stays in the **Reserve proof** card only.

Peer rows show city, country, and flag only — not hostnames and not host:port. Idle refresh: `https://rpc.pokoin.com/network/peer-status.json`. Do not fetch or link `bootstrap-peers.json` from this page (join list, IPs). Split and rationale: `docs/BOOTSTRAP_PEERS.md`.

Accent: `--yellow: #FFD33D` (Flutter `Color(0xFFFFD33D)`). Not Rare Candy lime `#cbf062`. Not Tailwind `#facc15`.

`/home/*` Cache-Control is `max-age=0, must-revalidate`. HTML also cache-busts `landing.css?v=…` so a stale hour-long sheet cannot keep the old lime.

Phone (iPhone 16 393×852 CSS px): `viewport-fit=cover` and `≤480px` safe-area
padding on the fixed nav, hero, and yellow CTA. Do not change desktop landing
rules for this. [MOBILE.md](MOBILE.md).

Crawlers get this HTML at `GET /`. `/marketplace` is the React market, not Flutter.

### `home/landing.css` — classes that matter

`:root --yellow #FFD33D`, `--blue #4452d8`. `.reveal` / `.reveal-fade` / `.reveal-grow` / `.is-visible`, `html:not(.js) .reveal`. `.nav.is-scrolled`. `.btn-yellow`, `.store-btn.is-soon` (`pointer-events: none`). `.glow-olive-*` are gold, not olive. `.cta-box` yellow bar. `.soon-grid` / `.pill`. Apple / Play SVGs on the coming-soon store buttons. `@media (prefers-reduced-motion: reduce)` kills reveal, marquee, and motion transitions.

### `home/landing.js` — functions

Nav toggle + scroll tint; SW unregister; reveal observer (150ms sibling stagger, `data-delay`); `animateCounter` / `fill` (live height cancels the rAF count); `peerRow` (safe DOM, geo only); idle `/health` + `peer-status.json`.

---

## CardVault (the app) — not pokoin.com

CardVault is Flutter Android/iOS. The tables below are leftover from when
pokoin.com was a Flutter web bundle. Do not deploy `build/web` as production.

### Generated / copied (do not hand-edit; re-run sync)

| Path | Role |
| --- | --- |
| `web/home.html` | Production landing HTML with `/home/` asset URLs. |
| `web/home/landing.css` | Copy of pokoin-web CSS. |
| `web/home/landing.js` | Copy of pokoin-web JS. |
| `web/home/logo.png` | Copy. |
| `web/home/satoshi.woff2` | Copy. |
| `build/web/home.html` | Flutter-copied `web/home.html`. |
| `build/web/home/*` | Same assets in the deploy folder. |
| `build/web/index.html` | **After deploy swap:** landing. **After flutter build, before swap:** Flutter shell. |
| `build/web/app.html` | Flutter shell, created by the deploy script. |

### Routing and deploy (edit in CardVault)

| Path | Role |
| --- | --- |
| `web/index.html` | Flutter web shell. **Never overwrite with the landing.** |
| `vercel.json` | Headers, host redirects, `/` → `/home.html`, catchall `/(.*)` → `/app.html`. |
| `deploy-pokoin-web.sh` | Flutter build, index/app swap, Oracle API strip, Vercel deploy, verifier. Project id `prj_1x0bUwaSZPeMRU90jQL5Ak8WWnPX`, org `team_WIppHrH49qzR3JDOj6AynDiC`. |
| `scripts/landing-root.test.js` | Rewrite order + landing copy assertions. |
| `scripts/verify-production-aliases.js` | Health checks. Full route set only on `pokoin.com` and `www.pokoin.com`. Explorer is HTTP 200 on `/` only (Caddy). |
| `docs/landing-root.md` | Short pointer back to this spec. |

`vercel.json` landing-related entries:

- Headers: `/`, `/index.html`, `/home.html`, `/app.html` (no-store-ish), `/home/:path*` (1h cache).
- Redirect: `www.pokoin.com` → `pokoin.com`. `explorer.pokoin.com` `/` → `/scan` **if** that host were on this project (it is not).
- Rewrites: `/` → `/home.html` then later `/(.*)` → `/app.html`.

### Flutter punch-out (in-app “Home” must leave the SPA)

Production `/` is static. In-app Home does a **full navigation** to `/`, except explorer/forum hosts.

| Path | Role |
| --- | --- |
| `lib/utils/public_home.dart` | `goPublicHome()`: explorer/forum → `context.go('/')`; else `assignPublicHome()`. |
| `lib/utils/browser_location.dart` | Conditional export. |
| `lib/utils/browser_location_web.dart` | `window.location.assign('/')`. |
| `lib/utils/browser_location_stub.dart` | No-op for VM/tests. |

Callers of `goPublicHome`:

`lib/widgets/site_footer.dart`, `lib/screens/home_screen.dart`, `home_screen` (marketplace Home), `scan_screen.dart`, `card_scan_screen.dart`, `buy_pkn_screen.dart`, `contact_screen.dart`, `whitepaper_screen.dart`, `privacy_screen.dart`, `about_screen.dart`, `not_found_screen.dart`, `profile_screen.dart`, `docs_screen.dart`, `forum_screen.dart`, `health_screen.dart`.

### Flutter still compiled, not production `/`

| Path | Role |
| --- | --- |
| `lib/screens/landing_screen.dart` | Old marketing UI. Still the GoRoute for `/` **inside** the SPA (`lib/main.dart`). Used by `flutter run`, `explorer`/`forum` host exceptions do not use it. Production Vercel `/` never loads this file. |
| `lib/main.dart` | `GoRoute path: '/'` → `LandingScreen` (or Scan/Forum by host). |

### Static files the landing **links to** (CardVault `web/`, not this repo)

| URL | File / origin |
| --- | --- |
| `/audit/PokoinPOS_Official_Security_Audit_2026-05-28.pdf` | `web/audit/…` |
| `/favicon.ico`, `/pokoin-512.png` | `web/` |
| OG image `/pokoin-project-banner-1360x430.png` | `web/` |
| `/bootstrap-peers.json` | Join-only host:port for nodes. Not linked from the landing. |

---

## Hosts

| Host | What `/` is |
| --- | --- |
| `pokoin.com` | This landing |
| `www.pokoin.com` | 301 → `pokoin.com` |
| `app.pokoin.com` | Flutter app (Vercel `pokoin-flutter`). Wallet, forum, signal, cart, auth. |
| `forum.pokoin.com` | Legacy alias on project `web`. Use `app.pokoin.com/forum`. |
| `explorer.pokoin.com` | **Caddy**, not Vercel. Do not `vercel alias` this name. |
| `rpc.pokoin.com` | PokoinPoS RPC (health, bootstrap peers, `eth_chainId`) |
| `api.pokoin.com` | Oracle marketplace API |
| `news.pokoin.com` | Hypemeter on `pokoin-a1` via Cloudflare Tunnel. [NEWS.md](NEWS.md). |

Vercel project name: `web`. Inspect example: `https://vercel.com/giuseppevitolo17s-projects/web`.

---

## Honesty rules (do not regress)

- No fake reviews, no `aggregateRating`, no “Certified by”, no fake user counts.
- Security section = 28 May 2026 PDF only. Not Certik. Mythril N/A (Go node).
- Peer proof from `https://rpc.pokoin.com/network/peer-status.json` (geo only). Join IPs stay off this page.
- Coming soon is labeled and not a store link.
- Hero does not say wrapped liquidity. Reserve proof may name the BNB contract.

---

## Proof (honest)

**Audit PDF** (28 May 2026): `/audit/PokoinPOS_Official_Security_Audit_2026-05-28.pdf`

- Independent technical report for the PokoinPoS Go node and public RPC. Target was `/Users/giuseppe/pokoinpos`. Network chainId `26062026` / `0x18dacca`.
- PASS: `go test`, `go vet`, `go test -race`, `govulncheck` (0 reachable), `gosec` (0 issues, 22 files), secret-pattern scan, live `/health` `/ready`, `eth_chainId`.
- Mythril is N/A (EVM bytecode tool; node is Go). Finding F-01 informational. F-02: permissioned PoS with `finalityDepth` 1, to be documented for integrators.
- Scope **does not** assert economic, validator-governance, or third-party infra guarantees beyond the listed live checks.
- Snapshot that day: height 791, peerCount 3, PokoinPoS/v0.2.0. Live height is higher; the landing refreshes from `/health`.

**Peers** (30 Aug 2026, then idle refresh):

- Public proof: `https://rpc.pokoin.com/network/peer-status.json` (Frankfurt ×2, no hostnames, no IPs).
- Node join list: `https://rpc.pokoin.com/network/bootstrap-peers.json` and `https://pokoin.com/bootstrap-peers.json` (host:port of the two live nodes only). See `docs/BOOTSTRAP_PEERS.md`.

**wPKN:** owner `0x0` (renounced), max backed 2,000,000, contract `0x91A17E2bddfF839078BD395482B38e4AC15276f4`.

---

## Why this stack

Marketing `/` must be fast. Flutter web is the rest of the product and is too heavy for a first paint.

- **Static HTML + CSS** is the performance ceiling for a one-pager.
- **Astro** if the marketing site grows. A single file does not need it.
- Do **not** put Next.js/React or Flutter wasm on `/`.
- Self-host Satoshi, preload font + logo, defer a tiny script, LCP is H1 + logo (visible without JS).

---

## Previous `/` (Flutter `LandingScreen`)

What visitors could do **before** this replacement. Viewport gap: under 820px the header hid Wallet / Host node / Forum.

### Header

| Control | Viewport | Destination |
| --- | --- | --- |
| Logo | All | `/` (no-op) |
| Wallet | ≥820px | `/wallet` |
| Host node | ≥820px | `/docs` |
| Forum | ≥820px | `/forum` |
| Marketplace | All | `/marketplace` |

### Hero and cards

Marketplace, Join the network `/docs`, Wallet roles `/wallet`, Open forum `/forum`, token card Open marketplace, Enter market / Use wallet / Host node / Discuss.

### Marketplace stack

Open marketplace, `/marketplace/signal`, Wallet, `/scan`, yellow Open marketplace.

### Footer Explore

`/` `/about` `/earn` `/whitepaper` `/docs` `/contact` `/privacy` `/scan` `/cardscan` `/health`

### Footer Account and network

`/profile` `/buy` RPC, reserve JSON, wPKN BscScan, PancakeSwap, generic CMC, `mailto:contact@pokoin.com`

### Not actions

700ms offscreen `HomeScreen` warmup. Feature/roadmap cards were text-only.

---

## Qwen

Local `qwen3.8:27b-128k` was given a copy brief.

- First run: `done_reason: length`, empty `response`. Useful bits in the chain-of-thought: short hero, no fake reviews, no invented Certik.
- Second run (`think: false`): JSON came back but was too generic (`Pokoin Marketplace` / `PKN`). Discarded.
- Page copy was checked against the decoded 28 May 2026 PDF and live RPC (height 994, two bootstrap peers).

---

## Verify

```bash
curl -sS https://pokoin.com/ | grep -F 'The market belongs to the collectors'
curl -sS https://pokoin.com/ | grep -F 'built for everyone'
curl -sS https://pokoin.com/ | grep -F 'Buy. Sell. Settle in PKN'
curl -sS https://pokoin.com/ | grep -F 'btn-yellow'
curl -sS https://pokoin.com/home/landing.css | grep -F '#ffd33d'
curl -sI https://pokoin.com/marketplace | head
curl -sS https://pokoin.com/marketplace | grep -F '/market/assets/'
```

Hard-refresh if a cached `landing.css` still shows lime; the live sheet is `#ffd33d`.
