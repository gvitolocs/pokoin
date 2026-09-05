# Pokoin

Pokoin is a Pokemon card commerce and wallet ecosystem built around CardVault,
the Pokoin Wallet, the PokoinPoS chain, marketplace tooling, and market-signal
apps.

This repository is the **public web**: landing (`index.html`, `home/`) and the
React market (`market/`). Android/iOS CardVault is a separate app
([docs/APP.md](docs/APP.md)). Product APIs stay on `api.pokoin.com`.

See [docs/LANDING.md](docs/LANDING.md) for the landing pipeline, copy, and
deploy. React market: [docs/MARKET.md](docs/MARKET.md). Home first paint:
[docs/HOME_FIRST_PAINT.md](docs/HOME_FIRST_PAINT.md). HTTP API map:
[docs/API.md](docs/API.md). Pokoin News
(`news.pokoin.com`) on Oracle behind a Cloudflare Tunnel:
[docs/NEWS.md](docs/NEWS.md).
Motion vs [get.rarecandy.com](https://get.rarecandy.com/)
is in [docs/ANIMATIONS.md](docs/ANIMATIONS.md). Public vs operator peer JSON:
[docs/BOOTSTRAP_PEERS.md](docs/BOOTSTRAP_PEERS.md). Chrome routes:
[docs/CHROME.md](docs/CHROME.md). Android/iOS:
[docs/APP.md](docs/APP.md) (`https://app.pokoin.com`).
Phone (iPhone 16 393×852): [docs/MOBILE.md](docs/MOBILE.md).

## Ecosystem And Modules

| Module | Repository | Verified status |
| --- | --- | --- |
| Pokoin | [`gvitolocs/pokoin`](https://github.com/gvitolocs/pokoin) | Public web: landing (`index.html`, `home/`) and React market (`market/`) on `https://pokoin.com`. |
| CardVault | [`gvitolocs/cardvault`](https://github.com/gvitolocs/cardvault) | Flutter Android/iOS on `https://app.pokoin.com`. Not the pokoin.com web host. [docs/APP.md](docs/APP.md). |
| Wallet | This repo (`/wallet`) and [`gvitolocs/pokoinpos`](https://github.com/gvitolocs/pokoinpos) | MetaMask + PokoinPoS on the React SPA. The `pokoinwallet` repository is an older Flutter/Firebase Functions prototype. |
| Hypemeter | [`gvitolocs/hypemeter`](https://github.com/gvitolocs/hypemeter) | Next.js Pokoin News at `https://news.pokoin.com`, hosted on Always Free Ampere A1 behind a Cloudflare named tunnel. Pipeline: [docs/NEWS.md](docs/NEWS.md). |
| Card Extension | [`gvitolocs/pokemon-card-extension`](https://github.com/gvitolocs/pokemon-card-extension) | Chrome Manifest V3 extension that adds Pokoin card links to supported Pokemon marketplace listings. |
| PokoinPoS | [`gvitolocs/pokoinpos`](https://github.com/gvitolocs/pokoinpos) | Native Proof-of-Stake chain and node runtime for the Pokoin/CardVault ecosystem. Public network values are documented in the repository. |

## Verified Features

### Pokoin Repository

- Provides the public README for the Pokoin ecosystem.
- Holds the pokoin.com landing (`index.html`, `home/`) and the React
  market (`market/`). Deploys itself to Vercel project `web`.

### CardVault

Flutter Android/iOS. Not the pokoin.com web host. Details: [docs/APP.md](docs/APP.md).

- App name `pokoin`: marketplace, wallet, and card reserve on device.
- Shares Firebase project `pokoin` with this SPA.
- Do not deploy `cardvault/.../build/web` as `https://pokoin.com`.

### Wallet

- Public wallet UI: `https://pokoin.com/wallet` in this React SPA.
- Public PokoinPoS values:
  - Network name: `PokoinPoS`
  - Chain ID: `26062026`
  - Network ID: `26062026`
  - Native currency: `PKN`
  - Decimals: `18`
  - RPC URL: `https://rpc.pokoin.com/rpc`
  - Explorer URL: `https://explorer.pokoin.com`
- Wallet compatibility docs state that MetaMask-style wallets can add the
  network, read chain metadata, read balances, submit signed transfers through
  `eth_sendRawTransaction`, and poll transactions and receipts.
- The older `pokoinwallet` repository documents a Flutter app with Firebase
  Functions v2, Firestore, a deployable Node API, transaction validation,
  mempool, manual mining, and Firestore rules that block direct client writes.

### Hypemeter

- Next.js app using Node `22.x`, Next `16.2.1`, React `19.2.4`, TypeScript,
  Tailwind CSS, Vitest, and `better-sqlite3`.
- Production is Oracle Always Free Ampere (`pokoin-a1`) bound to
  `127.0.0.1:3000`, published only through Cloudflare Tunnel `pokoin-news`.
  Hunt, compose, tunnel, 15-minute revalidate timer, and DNS cutover:
  [docs/NEWS.md](docs/NEWS.md).
- Vercel project `hypemeter` / `https://monmeter.vercel.app` stays up as
  rollback until you approve teardown. Do not delete it until then.
- App metadata identifies the live surface as `https://news.pokoin.com`.

### Card Extension

- Chrome Manifest V3 extension named `Pokemon Card Trader Linker`.
- Supports eBay, Vinted, CardTrader, Cardmarket, and Pokoin host permissions.
- Extracts card metadata from listings, matches cards through Pokoin APIs,
  injects Pokoin buttons, and opens matched cards in a Chrome side panel.
- Uses `https://pokoin.com` as the API base URL.
- Includes Node test files for extension workflow and live CardVault API smoke
  checks.

### PokoinPoS

- Go node runtime for the native PokoinPoS chain.
- Chain ID and network ID: `26062026`; native currency: `PKN`.
- Public RPC: `https://rpc.pokoin.com/rpc`.
- Public explorer/static metadata host: `https://explorer.pokoin.com`.
- Public web and wallet surface: `https://pokoin.com` and
  `https://pokoin.com/wallet`.
- The node exposes health, readiness, chain status, metrics, endpoint catalog,
  and EVM-style JSON-RPC compatibility endpoints.
- Docker Compose deployment uses the `newisdom/pokoinpos-peer:latest` image by
  default and includes a Watchtower updater service.
- Documentation covers wallet compatibility, public-network metadata, Docker
  peer deployment, bootstrap peers, disaster recovery, and security operations.

## Architecture And Tech Stack

| Area | Verified stack |
| --- | --- |
| Public marketplace (web) | React + Vite in `market/`; humans hit `/marketplace` |
| Android/iOS app | Flutter, Dart, Riverpod, GoRouter, Firebase Auth, Cloud Firestore. Host `app.pokoin.com`. [docs/APP.md](docs/APP.md). |
| Legacy wallet prototype | Flutter, Firebase Functions v2 on Node 20, Express, Firestore, `tweetnacl` signatures |
| Market signals and news | Next.js, React, TypeScript, Tailwind CSS, Vercel, Vercel Cron, SQLite via `better-sqlite3` |
| Browser extension | Chrome Manifest V3, JavaScript modules, side panel, content scripts, local storage |
| Chain and RPC | Go, Proof-of-Stake node runtime, EVM-style JSON-RPC compatibility, Docker Compose, Watchtower, Oracle/Docker node deployment |
| Public hosting boundary | Vercel hosts web/static surfaces; node infrastructure backs `rpc.pokoin.com` chain and RPC endpoints |

## Setup

Clone this entry repository:

```bash
git clone https://github.com/gvitolocs/pokoin.git
cd pokoin
```

Landing is static HTML. The React marketplace:

```bash
cd market
npm install
npm run dev
# http://127.0.0.1:5174/marketplace
```

Work on a module from its own repository:

```bash
git clone https://github.com/gvitolocs/cardvault.git
cd cardvault/pokemon_card_vault
flutter pub get
flutter run -d chrome
```

```bash
git clone https://github.com/gvitolocs/hypemeter.git
cd hypemeter
npm install
npm run dev
```

```bash
git clone https://github.com/gvitolocs/pokoinpos.git
cd pokoinpos/peer
go test ./...
```

```bash
git clone https://github.com/gvitolocs/pokemon-card-extension.git
cd pokemon-card-extension
# Load this folder from chrome://extensions with Developer mode enabled.
```

## Configuration

Landing has none. The React marketplace uses the public Firebase web config
in `market/src/auth.jsx` (same project as Android/iOS
`DefaultFirebaseOptions.web`) and talks to `https://api.pokoin.com`.

Known module configuration from the repositories:

- CardVault Firebase and `firestore.rules`: `cardvault/pokemon_card_vault`.
  App routing: [docs/APP.md](docs/APP.md).
- The card extension uses `https://pokoin.com` as its API base URL.
- Hypemeter production is Oracle + Cloudflare Tunnel (`docs/NEWS.md`).
  A systemd timer calls `/api/cron/revalidate-home` every 15 minutes.
- PokoinPoS peers are configured with `POKOINPOS_*` environment variables in
  `docker-compose.peer.yml` and `deploy/env/peer.env.example`.

Secrets, private keys, API keys, Firebase credentials, wallet keys, and local
environment files must not be committed.

## Deployment Status

This repo is the public web. Android/iOS is CardVault. Production is Vercel
project `web` (`pokoin.com`): `vercel.json` runs `scripts/build-web.sh`, then
`vercel --prebuilt --prod`. Details: [docs/LANDING.md](docs/LANDING.md),
[docs/MARKET.md](docs/MARKET.md), [docs/APP.md](docs/APP.md).

## Usage

- Visit `https://pokoin.com/` for the landing and `https://pokoin.com/marketplace` for the React market.
- Wallet, auth, cart, checkout, forum, scan, and buy are this SPA (`/wallet`, `/auth`, `/cart`, `/checkout`, `/forum`, `/scan`, `/buy`).
- Use `https://rpc.pokoin.com/rpc` as the documented public PokoinPoS RPC URL.
- Use `https://explorer.pokoin.com` as the documented public explorer URL.
- Load the Card Extension locally in Chrome to add Pokoin links on supported
  marketplace pages.
- Use the module repositories for development, testing, and deployment commands.

## Contributing

Keep changes tied to verified repository content. If a feature, URL, deployment
target, or configuration value is not documented in the repositories, write
`details coming soon` until it is confirmed.

Before opening a change in a module repository, run the checks documented by
that module, for example:

```bash
# cardvault/pokemon_card_vault
flutter analyze

# hypemeter
npm run lint
npm run test

# pokoinpos/peer
go test ./...

# pokemon-card-extension
node --test tests/extension-workflow.test.js
```

## License

No license file was found in this repository. License details coming soon.

Check each related module repository for its own license files or release
packaging notes before reusing or redistributing code.
