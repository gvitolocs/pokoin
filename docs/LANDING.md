# Pokoin.com root landing — pipeline and files

Static get.rarecandy-style page. Source of truth: this repo (`gvitolocs/pokoin`).
Production host: CardVault Vercel project `web` (`prj_1x0bUwaSZPeMRU90jQL5Ak8WWnPX`).
Live URL: `https://pokoin.com/`.

Action map canvas (clicks, not files): [landing-action-map.canvas.tsx](/home/nez/.cursor/projects/home-nez-Projects-pokoin-web/canvases/landing-action-map.canvas.tsx).

---

## Pipeline (edit → live)

```
pokoin-web/                  CardVault web/              Flutter build          Vercel
───────────                  ─────────────              ────────────          ──────
index.html  ──sync──►        web/home.html  ──flutter──►  build/web/home.html
home/*      ──sync──►        web/home/*      ──copy──►    build/web/home/*
                                                          build/web/index.html  (Flutter shell)
                                                          │
                                                          deploy-pokoin-web.sh
                                                          ├─ Flutter shell → app.html
                                                          └─ landing      → index.html
                                                                             │
                                                                             vercel --prod
                                                                             │
                                                                             pokoin.com/
                                                                             GET /              = index.html (landing)
                                                                             GET /marketplace*   = market/index.html (humans)
                                                                             GET /*              = app.html (Flutter)
```

### Step 1 — Edit here

Work in `/home/nez/Projects/pokoin-web` (this repo).

Local preview (relative `home/` URLs, no CardVault):

```bash
python3 -m http.server 8766 --bind 0.0.0.0 --directory /home/nez/Projects/pokoin-web
```

Cursor’s browser on the Mac cannot use `127.0.0.1` on this host. Use Tailscale `http://100.107.164.33:8766/` or LAN `http://192.168.178.55:8766/` (port 8766 must be reachable).

### Step 2 — Sync into CardVault

```bash
/home/nez/Projects/pokoin-web/scripts/sync-landing.sh
```

Override destination with `CARDVAULT_WEB` if the CardVault clone is not at `/home/nez/Projects/cardvault/pokemon_card_vault/web`.

The script:

1. Copies `index.html` → `web/home.html`.
2. Replaces `web/home/` with this repo’s `home/`.
3. Rewrites `href="home/` and `src="home/` to `/home/` so production asset URLs are absolute.

Do **not** copy onto `web/index.html`. That file is the Flutter web shell.

### Step 3 — Tests (CardVault)

```bash
node --test /home/nez/Projects/cardvault/pokemon_card_vault/scripts/landing-root.test.js
```

### Step 4 — Deploy

Canonical (rebuilds Flutter, then swaps HTML):

```bash
cd /home/nez/Projects/cardvault/pokemon_card_vault
env -u VERCEL_TOKEN \
  ORACLE_API_BASE_URL=https://api.pokoin.com \
  USE_ORACLE_API=1 \
  ./deploy-pokoin-web.sh
```

| Flag | Why |
| --- | --- |
| `env -u VERCEL_TOKEN` | A stale `VERCEL_TOKEN` in the environment fails CLI login. CLI session `giuseppevitolo17` works. |
| `USE_ORACLE_API=1` | Hobby plan cannot ship the local serverless function set. APIs stay on `api.pokoin.com`. |
| `--pwa-strategy=none` | Already in the deploy script’s `flutter build web`. Landing also unregisters leftover service workers. |

What the script does after `flutter build web`:

1. Requires `build/web/home.html` (copied from `web/` by Flutter).
2. `cp build/web/index.html build/web/app.html` (keep Flutter).
3. `cp build/web/home.html build/web/index.html` (landing wins at `/`).
4. Oracle mode: strip `build/web/api/*.js` so Vercel does not try to host 12+ functions.
5. `vercel pull` / `vercel build --prod` / `vercel deploy --prebuilt --prod`.
6. `scripts/verify-production-aliases.js --set-aliases`.

Landing-only shortcut (no Flutter rebuild) when `build/web/` is already a recent Oracle-mode production output:

```bash
/home/nez/Projects/pokoin-web/scripts/sync-landing.sh
WEB=/home/nez/Projects/cardvault/pokemon_card_vault
cp "$WEB/web/home.html" "$WEB/build/web/home.html"
cp "$WEB/web/home.html" "$WEB/build/web/index.html"
rm -rf "$WEB/build/web/home" && cp -a "$WEB/web/home" "$WEB/build/web/home"
cd "$WEB/build/web"
env -u VERCEL_TOKEN vercel pull --yes --environment=production
env -u VERCEL_TOKEN vercel build --prod --yes
env -u VERCEL_TOKEN vercel deploy --prebuilt --prod --yes --archive=tgz
```

`vercel deploy --prod` already aliases `pokoin.com`. Extra aliases (`www`, `wallet`, `forum`, `cards`, …) need `env -u VERCEL_TOKEN vercel alias set`. **Do not** alias `explorer.pokoin.com` to this Vercel project — that host is Caddy on the explorer VM.

### Step 5 — What Vercel serves

Filesystem `index.html` is evaluated **before** rewrites. That is why the landing must sit on `index.html`, not only on `home.html`.

| Request | File | App |
| --- | --- | --- |
| `GET /` | `index.html` (landing) | Static HTML |
| `GET /home.html` | rewrite → `/home.html` | Same landing (copy) |
| `GET /home/landing.css` | `home/landing.css` | Static |
| `GET /marketplace` (humans) | `/market/index.html` | React SPA (`pokoin-web/market`) |
| `GET /marketplace` (bots) | `/marketplace.html` | SEO stub |
| Other app routes (`/wallet`, `/cart`, `/auth`, …) | rewrite `/(.*)` → `/app.html` | Flutter SPA |
| `GET /api/*` | Oracle proxy | `api.pokoin.com` |
| `https://explorer.pokoin.com/` | not this project | Caddy “PokoinPoS Explorer” |

`vercel.json` also rewrites `/` → `/home.html`. That is belt-and-suspenders. Production `/` is the swapped `index.html`.

`www.pokoin.com/` 301s to `https://pokoin.com/`.

---

## Cache (why HTML can update while CSS stays lime)

`vercel.json`:

| Path | Cache-Control |
| --- | --- |
| `/`, `/index.html`, `/home.html`, `/app.html` | `max-age=0, must-revalidate` |
| `/home/:path*` (css, js, font, logo) | `max-age=0, must-revalidate` (was 1h; that kept Rare Candy lime after HTML updates) |

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
| `scripts/sync-landing.sh` | Copy into CardVault `web/home.html` + `web/home/`, rewrite asset paths to `/home/`. |
| `docs/LANDING.md` | This file: pipeline, inventory, copy rules, proof. |
| `docs/BOOTSTRAP_PEERS.md` | Public vs operator peer JSON (OWASP API3). |
| `docs/ANIMATIONS.md` | get.rarecandy.com IX2 inventory and Pokoin mapping. |
| `README.md` | Ecosystem README. Points here for the landing. |
| `.gitignore` | Ignores `.cursor/`, `.codevira/`, etc. |

Not in this repo: Flutter, `vercel.json`, the audit PDF, OG banner `pokoin-project-banner-1360x430.png`, favicon. Those live in CardVault `web/`.

Visual reference only (not deployed): `/home/nez/Projects/candyext` (get.rarecandy clone). Lime `#cbf062` there. This page uses Flutter Pokoin gold `#FFD33D`, not Tailwind `#facc15` (that still reads as lime on a black page).

### `index.html` — document map

| Region | Markup | Notes |
| --- | --- | --- |
| Head | title, description, OG/Twitter, canonical, JSON-LD Organization | No “wrapped liquidity”. `theme-color` `#000`. |
| Skip | `.skip-link` → `#main` | Yellow on focus. |
| Header | logo `/`, marketplace, wallet, scan, `/docs`, forum | Hamburger `.nav-toggle` on ≤991px. |
| Hero | H1 white “The marketplace belongs to the collectors.” + yellow “Buy. Sell. Settle in PKN.” | Lede: global P2P for collectors. CTAs: Explore cards `/marketplace`, Start selling `/inventory`. |
| Features | three `<a class="feature">` | `/marketplace`, `/wallet`, `/scan`. |
| Live | marquee + four `.stat` | Height/peers/health live-updated. Chain ID `26062026` static. |
| Security | two `.card` | May 2026 PDF. Reserve proof (renounced, JSON, BscScan, Pancake). |
| Peers | `[data-peer-list]` | Snapshot then idle refresh. |
| Coming next | three `.soon-card` | iOS/Android: not in stores (web is live). More peers: permissioned, no open intake. |
| CTA | yellow `.cta-box` | Live: marketplace, signal, forum, cardscan. Placeholders: App Store / Play (`aria-disabled`). |
| Footer | four columns | Same destinations as old Flutter `SiteFooter`. |
| Script | `home/landing.js` `defer` | Last. |

Hero copy (locked):

> The marketplace belongs to the collectors.
> Buy. Sell. Settle in PKN.
> A global peer-to-peer marketplace built for Pokémon card collectors.
> Explore cards → Start selling (`/marketplace`, `/inventory`).

Tab / OG title uses a colon (`Pokoin: …`), not an em dash.

Do not put “wrapped liquidity” or “Live peers — not testimonials” on this page. wPKN stays in the **Reserve proof** card only.

Peer rows show city, country, and flag only — not hostnames and not host:port. Idle refresh: `https://rpc.pokoin.com/network/peer-status.json`. Do not fetch or link `bootstrap-peers.json` from this page (join list, IPs). Split and rationale: `docs/BOOTSTRAP_PEERS.md`.

Accent: `--yellow: #FFD33D` (Flutter `Color(0xFFFFD33D)`). Not Rare Candy lime `#cbf062`. Not Tailwind `#facc15`.

`/home/*` Cache-Control is `max-age=0, must-revalidate`. HTML also cache-busts `landing.css?v=…` so a stale hour-long sheet cannot keep the old lime.

Crawlers get this HTML at `GET /`. The Flutter shell is `app.html`. Bot-only rewrites still serve the thin `marketplace.html` (and similar) stubs.

### `home/landing.css` — classes that matter

`:root --yellow #FFD33D`, `--blue #4452d8`. `.reveal` / `.reveal-fade` / `.reveal-grow` / `.is-visible`, `html:not(.js) .reveal`. `.nav.is-scrolled`. `.btn-yellow`, `.store-btn.is-soon` (`pointer-events: none`). `.glow-olive-*` are gold, not olive. `.cta-box` yellow bar. `.soon-grid` / `.pill`. Apple / Play SVGs on the coming-soon store buttons. `@media (prefers-reduced-motion: reduce)` kills reveal, marquee, and motion transitions.

### `home/landing.js` — functions

Nav toggle + scroll tint; SW unregister; reveal observer (150ms sibling stagger, `data-delay`); `animateCounter` / `fill` (live height cancels the rAF count); `peerRow` (safe DOM, geo only); idle `/health` + `peer-status.json`.

---

## Every file — CardVault (`pokemon_card_vault`) that this pipeline touches

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
| `wallet.pokoin.com`, `cards.pokoin.com`, `cardcaveau.pokoin.com`, `cardvault.pokoin.com` | Same Vercel project (Flutter + landing) |
| `forum.pokoin.com` | Same project; Flutter Forum at `/`. `goPublicHome` stays in SPA. |
| `explorer.pokoin.com` | **Caddy**, not Vercel. Do not `vercel alias` this name. |
| `rpc.pokoin.com` | PokoinPoS RPC (health, bootstrap peers, `eth_chainId`) |
| `api.pokoin.com` | Oracle marketplace API |

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
curl -sS https://pokoin.com/ | grep -F 'The marketplace belongs to the collectors'
curl -sS https://pokoin.com/ | grep -F 'Buy. Sell. Settle in PKN'
curl -sS https://pokoin.com/ | grep -F 'btn-yellow'
curl -sS https://pokoin.com/home/landing.css | grep -F '#ffd33d'
curl -sI https://pokoin.com/marketplace | head
curl -sS https://pokoin.com/audit/PokoinPOS_Official_Security_Audit_2026-05-28.pdf | head -c 8
```

Hard-refresh if a cached `landing.css` still shows lime; the live sheet is `#ffd33d`.
