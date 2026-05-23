# Pokoin

Pokoin is an ecosystem for Pokemon-card commerce, wallet experiences, and a
native Proof-of-Stake chain. This repository currently contains **Hermes**, the
Pokoin conversational assistant service used to connect Telegram, optional
Discord, an OpenAI-compatible model provider, Honcho memory, optional ComfyUI
image generation, and optional Cursor Agent project automation.

This README documents the verified contents of this repository plus public
references from related Pokoin repositories. Where details are not available,
the ecosystem section says so explicitly.

## Ecosystem And Related Projects

| Project | Verified status | Links and notes |
| --- | --- | --- |
| CardVault | Public Flutter web app for the Pokoin ecosystem. Its README describes CardVault marketplace routes and an integrated Pokoin Wallet served from one Flutter web deployment. | [gvitolocs/cardvault](https://github.com/gvitolocs/cardvault), production site listed as `https://pokoin.com/`, wallet route listed as `https://pokoin.com/wallet`. |
| Wallet | The current wallet is documented as integrated into CardVault at `/wallet`. A separate older `pokoinwallet` repository exists and describes a Flutter app with Firebase Functions v2, Firestore, a deployable node API, transaction validation, mempool, manual mining, and locked-down Firestore rules. | [gvitolocs/pokoinwallet](https://github.com/gvitolocs/pokoinwallet). Treat this as legacy/prototype unless the owner confirms its current role. |
| Hypemeter | Public repository exists, with a TypeScript/Next.js app and homepage metadata. No README or product description was found. | [gvitolocs/hypemeter](https://github.com/gvitolocs/hypemeter), homepage listed as `https://hypemeter-beta.vercel.app`. Details coming soon. |
| Card Extension | Chrome extension that turns Pokemon card listing titles from eBay, Vinted, CardTrader, and Cardmarket into Pokoin marketplace links. Its README says it extracts metadata, matches cards through Pokoin/CardVault APIs, injects buttons, and opens matched cards in a Chrome side panel. | [gvitolocs/pokemon-card-extension](https://github.com/gvitolocs/pokemon-card-extension). |
| PokoinPoS | Native Proof-of-Stake chain used by the Pokoin/CardVault ecosystem. Its README documents public RPC, health endpoints, Docker deployment, peer auto-updates, wallet compatibility, chain ID `26062026`, and native currency `PKN`. | [gvitolocs/pokoinpos](https://github.com/gvitolocs/pokoinpos), RPC listed as `https://rpc.pokoin.com/rpc`, explorer listed as `https://explorer.pokoin.com`. |

## Verified Features In This Repository

- Telegram bot powered by `telegraf`, using either long polling or HTTPS webhook mode.
- Optional Discord bot powered by `discord.js`, responding in direct messages or when mentioned.
- OpenAI-compatible Chat Completions integration for reply planning and text responses.
- Telegram image inspection through a provider endpoint derived from `OPENAI_BASE_URL` and `/v1/inspect`.
- Honcho-backed conversation memory, with a no-memory fallback when `MEMORY_PROVIDER` is changed.
- Optional ComfyUI image generation using `workflows/comfyui-text-to-image.json`.
- Optional Cursor Agent CLI task execution for project work when explicitly enabled.
- Local Telegram chat registry written to `data/telegram-chats.json`.
- HTTP health endpoint at `GET /health`.
- Bash scripts for installing Honcho and deploying the service to an Oracle `peer1` host.

## Architecture And Tech Stack

- Runtime: Node.js ESM, requiring Node.js `>=20`.
- Package manager: npm, with scripts in `package.json`.
- Messaging: `telegraf` for Telegram and `discord.js` for optional Discord support.
- Model provider: OpenAI-compatible HTTP APIs configured through `OPENAI_BASE_URL`, `OPENAI_MODEL`, and `OPENAI_API_KEY`.
- Memory: `@honcho-ai/sdk` with configurable Honcho URL, workspace, agent peer, and optional vector-search context settings.
- Image generation: ComfyUI workflow JSON plus a Colab helper notebook under `notebooks/`.
- Automation: Cursor Agent CLI wrapper in `src/cursor-agent.js`.
- Deployment: Bash scripts and a systemd service target for an Oracle `peer1` host.

Project layout:

```text
.
|-- src/
|   |-- index.js              # HTTP server, Telegram startup, Discord startup
|   |-- config.js             # Environment loading and validation
|   |-- telegram.js           # Telegram bot handlers
|   |-- discord.js            # Optional Discord bot handlers
|   |-- openai.js             # OpenAI-compatible planning, replies, image inspection
|   |-- image-generation.js   # ComfyUI client
|   |-- cursor-agent.js       # Cursor Agent CLI wrapper
|   |-- chat-registry.js      # Telegram chat registry persistence
|   `-- memory/honcho.js      # Honcho memory provider
|-- notebooks/                # ComfyUI Colab helper files
|-- workflows/                # ComfyUI workflow JSON
|-- scripts/                  # Peer deployment and Honcho install scripts
|-- data/                     # Runtime data, ignored by Git
|-- .env.example              # Configuration template
`-- package.json              # npm scripts and dependencies
```

## Prerequisites

- Node.js 20 or newer and npm.
- Telegram Bot API token in `TELEGRAM_BOT_TOKEN`.
- API key for an OpenAI-compatible provider in `OPENAI_API_KEY`.
- Optional Honcho service reachable through `HONCHO_URL`.
- Optional Discord bot token and Message Content Intent for Discord support.
- Optional ComfyUI HTTP endpoint for generated images.
- Optional Cursor Agent CLI plus `CURSOR_API_KEY` for project automation.
- For Oracle `peer1` deployment: SSH access, sudo access on the remote host, and Docker/Compose for Honcho setup.

## Setup

```bash
git clone https://github.com/gvitolocs/pokoin.git
cd pokoin
npm install
cp .env.example .env.local
```

Edit `.env.local` and set at least:

```env
OPENAI_API_KEY=...
TELEGRAM_BOT_TOKEN=...
```

Do not commit `.env.local`, API keys, SSH keys, generated runtime data, or the
`apikeys` directory.

## Configuration

All supported variables are listed in `.env.example`.

Core service:

- `NODE_ENV`: runtime environment, default `development`.
- `HERMES_PORT`: HTTP server port, default `8788`.
- `HERMES_PUBLIC_URL`: when empty, Telegram polling is used; when set to an HTTPS URL, Hermes registers a Telegram webhook.
- `HERMES_CHAT_REGISTRY_PATH`: JSON path for the Telegram chat registry.

Model provider:

- `OPENAI_API_KEY`: required provider key.
- `OPENAI_BASE_URL`: OpenAI-compatible base URL, default `https://api.openai.com/v1`.
- `OPENAI_MODEL`: chat model, default `gpt-4o-mini`.
- `OPENAI_REASONING_EFFORT`: optional provider-specific setting.
- `OPENAI_TIMEOUT_MS`: provider request timeout, default `30000`.

Messaging:

- `TELEGRAM_BOT_TOKEN`: required Telegram token.
- `TELEGRAM_WEBHOOK_SECRET`: optional Telegram webhook secret.
- `TELEGRAM_ALLOWED_CHAT_IDS`: optional comma-separated allowlist.
- `DISCORD_BOT_TOKEN`: enables Discord when set.
- `DISCORD_ALLOWED_CHANNEL_IDS`: optional comma-separated Discord channel allowlist.
- `DISCORD_ALLOWED_USER_IDS`: optional comma-separated Discord user allowlist.

Optional integrations:

- `IMAGE_PROVIDER`: default `pokemon-artwork`; set to `comfyui` to use ComfyUI.
- `COMFYUI_BASE_URL`: public ComfyUI endpoint.
- `COMFYUI_WORKFLOW_PATH`: workflow path, default `workflows/comfyui-text-to-image.json`.
- `IMAGE_TIMEOUT_MS`: image-generation timeout, default `180000`.
- `HERMES_CURSOR_ENABLED`: set to `true` to enable Cursor Agent tasks.
- `CURSOR_API_KEY`: Cursor API key.
- `HERMES_CURSOR_AGENT_PATH`: Cursor Agent CLI path.
- `HERMES_PROJECT_DIR`: workspace path for Cursor Agent tasks.
- `HERMES_CURSOR_MODEL`: Cursor Agent model.
- `HERMES_CURSOR_TIMEOUT_MS`: Cursor task timeout; `0` disables the timeout.
- `MEMORY_PROVIDER`: default `honcho`; set to another value to disable Honcho-backed memory.
- `HONCHO_URL`, `HONCHO_API_KEY`, `HONCHO_WORKSPACE_ID`, `HONCHO_AGENT_PEER_ID`, `HONCHO_USE_VECTOR_SEARCH`: Honcho memory settings.

Deployment variables:

- `PEER1_HOST`, `PEER1_USER`, `PEER1_SERVICE_USER`, `PEER1_REMOTE_DIR`, `PEER1_HONCHO_DIR`, and optional `PEER1_KEY` are read by the peer deployment scripts.

## Run

Check JavaScript syntax for the main source files:

```bash
npm run check
```

Start locally with `.env.local`:

```bash
npm run dev
```

Start without the npm dev env-file flag:

```bash
npm start
```

When `HERMES_PUBLIC_URL` is empty, Hermes removes any Telegram webhook and uses
polling. When `HERMES_PUBLIC_URL` is set, it registers the webhook path
`/telegram/<TELEGRAM_BOT_TOKEN>`.

Health check:

```text
GET /health
```

## Usage

On Telegram, send `/start` to confirm the bot is online. Text messages are
planned as a normal reply, an image-generation request, or a Cursor Agent project
task. Photos sent to Telegram are inspected through the configured image
inspection endpoint and stored in memory when memory is enabled.

On Discord, set `DISCORD_BOT_TOKEN` and enable Message Content Intent in the
Discord Developer Portal. Hermes responds to direct messages and to server
messages that mention the bot.

For ComfyUI image generation, start the Colab workflow in
`notebooks/comfyui_colab_minimal.md`, copy the printed
`COMFYUI_BASE_URL=https://...trycloudflare.com`, set `IMAGE_PROVIDER=comfyui`,
and restart or redeploy Hermes.

## Deployment

Install or update Honcho on the configured Oracle `peer1` host:

```bash
./scripts/install-honcho-peer1.sh
```

Deploy Hermes to `peer1`:

```bash
./scripts/deploy-peer1.sh
```

The deploy script reads `.env.local`, archives the project while excluding
`node_modules`, `.git`, and `apikeys`, installs production dependencies on the
remote host, and configures a systemd service named `hermes`.

## Contributing

No dedicated contribution guide is currently present. Before opening a change,
run:

```bash
npm run check
```

Keep secrets and generated data out of version control, including `.env.local`,
`.env.*` files other than `.env.example`, `apikeys`, `node_modules`, and
runtime files under `data/`.

## License

No license file was found in this repository. Add a license before publishing,
redistributing, or accepting external reuse contributions.
