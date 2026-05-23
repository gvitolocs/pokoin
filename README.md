# Pokoin

Pokoin is a Pokemon card commerce and wallet ecosystem built around CardVault,
the Pokoin Wallet, the PokoinPoS chain, marketplace tooling, and market-signal
apps.

This repository is currently an ecosystem entry point. The `pokoin` repository
contains this README only; runnable application source, package manifests,
deployment scripts, and CI configuration live in the related repositories listed
below.

## Ecosystem And Modules

| Module | Repository | Verified status |
| --- | --- | --- |
| Pokoin | [`gvitolocs/pokoin`](https://github.com/gvitolocs/pokoin) | Ecosystem README and public project entry point. No runnable code is currently present in this repository. |
| CardVault | [`gvitolocs/cardvault`](https://github.com/gvitolocs/cardvault) | Flutter web app for the Pokoin marketplace and wallet surfaces. The repository documents `https://pokoin.com/`, `/marketplace`, `/profile`, `/orders`, `/scan`, `/health`, and `/wallet` routes. |
| Wallet | [`gvitolocs/cardvault`](https://github.com/gvitolocs/cardvault) and [`gvitolocs/pokoinwallet`](https://github.com/gvitolocs/pokoinwallet) | The current wallet is documented as integrated into CardVault at `https://pokoin.com/wallet`. The separate `pokoinwallet` repository contains an older Flutter/Firebase Functions prototype. |
| Hypemeter | [`gvitolocs/hypemeter`](https://github.com/gvitolocs/hypemeter) | Next.js app named `hypemeter`. Its metadata describes Pokoin News as a live signal hub for Pokemon news, TCG market hype, crypto gaming signals, earn trends, and card-market momentum. |
| Card Extension | [`gvitolocs/pokemon-card-extension`](https://github.com/gvitolocs/pokemon-card-extension) | Chrome Manifest V3 extension that adds Pokoin card links to supported Pokemon marketplace listings. |
| PokoinPoS | [`gvitolocs/pokoinpos`](https://github.com/gvitolocs/pokoinpos) | Native Proof-of-Stake chain and node runtime for the Pokoin/CardVault ecosystem. Public network values are documented in the repository. |

## Verified Features

### Pokoin Repository

- Provides the public README for the Pokoin ecosystem.
- Does not currently include application source code, tests, package manifests,
  deployment configuration, or a license file.

### CardVault

- Flutter web app named `pokoin` with description
  `Pokoin marketplace, wallet, and card reserve app`.
- Marketplace routes and app pages are served from a single Flutter web bundle.
- Vercel rewrites app routes such as `/marketplace`, `/wallet`, `/scan`,
  `/health`, and `/docs` back into the SPA.
- Firebase Auth and Firestore are documented for accounts, profiles, balances,
  orders, wallet addresses, listings, and withdraw requests.
- Firestore rules include authenticated user ownership checks and read/write
  boundaries for user, wallet, balance, order, and card listing documents.
- The app documents a MetaMask/Pokoin network bridge and the integrated wallet
  route at `https://pokoin.com/wallet`.

### Wallet

- The active wallet surface is documented as part of CardVault at `/wallet`.
- Public PokoinPoS wallet values are documented as:
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
- Vercel configuration declares the framework as `nextjs`.
- Vercel cron jobs revalidate `/api/cron/revalidate-home` twice every
  three-hour window.
- App metadata identifies the live surface as `https://news.pokoin.com` and
  describes Pokemon news, TCG hype, crypto game, earn trend, and market-signal
  tracking.
- Details coming soon: public product README, deployment owner, and production
  operating notes.

### Card Extension

- Chrome Manifest V3 extension named `Pokemon Card Trader Linker`.
- Supports eBay, Vinted, CardTrader, Cardmarket, and Pokoin host permissions.
- Extracts card metadata from listings, matches cards through Pokoin/CardVault
  APIs, injects Pokoin buttons, and opens matched cards in a Chrome side panel.
- Uses `https://pokoin.com` as the Pokoin/CardVault API base URL.
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
| Marketplace and integrated wallet | Flutter web, Dart, Riverpod, GoRouter, Firebase Auth, Cloud Firestore, Hive/shared preferences, Vercel SPA routing |
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

There is no install command for this repository yet because it currently
contains documentation only.

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

This repository has no local configuration file.

Known module configuration from the repositories:

- CardVault uses Firebase project configuration and `firestore.rules` from
  `cardvault/pokemon_card_vault`.
- CardVault web routing is configured through
  `cardvault/pokemon_card_vault/web/vercel.json`.
- The card extension uses `https://pokoin.com` as its API base URL.
- Hypemeter is configured for Vercel as a Next.js project and includes cron
  revalidation for `/api/cron/revalidate-home`.
- PokoinPoS peers are configured with `POKOINPOS_*` environment variables in
  `docker-compose.peer.yml` and `deploy/env/peer.env.example`.

Secrets, private keys, API keys, Firebase credentials, wallet keys, and local
environment files must not be committed.

## Usage

- Visit `https://pokoin.com/` for the public Pokoin/CardVault web surface.
- Open `https://pokoin.com/wallet` for the integrated wallet route.
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
