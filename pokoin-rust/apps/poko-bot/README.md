# poko-bot (phase 2 of the Rust Poko) — design

Date: 2026-10-16. Goal: Poko's Telegram and Discord chat on Oracle peer1 answered by a small Rust daemon that uses the
same in-process Rust brain as the website chat, with the Node Hermes Poko runtime kept as the fallback.

## What runs where

```
Telegram ─┐                    ┌─► api.pokoin.com POST /api/poko-bot-chat   (Pi + k3s overflow, service bearer)
          ├─► poko-bot (peer1) ┤      └─ poko_brain::reply (DeepSeek → Gemini, 15 market tools, abuse screen, guard)
Discord ──┘   Rust, ~20 MB     ├─► api.pokoin.com POST /api/poko-connect     (link status / redeem / unlink)
                               ├─► Gemini API (voice transcript, photo description)
                               └─► 127.0.0.1:8789 POST /api/poko/chat         (Hermes Poko, per-message fallback)
hermes-poko (Node, peer1) keeps: website-era HTTP API, news scout, YouTube/X, LoL bets + Discord slash commands.
```

### Decision: brain over an internal endpoint, not a linked crate

`POST /api/poko-bot-chat` lives next to `/api/poko-chat` in `crates/accounts`, authenticated with the existing Poko
service token (`POKO_MARKET_SERVICE_TOKEN` / `POKONTACT_SERVICE_TOKEN`, the same secret Hermes already uses for
`/api/poko-market` and `/api/poko-connect`). It runs `poko_brain::reply` without Firebase claims.

Why not link `pokoin-accounts` into the bot: the brain's market tools need the marketplace Postgres, Firestore, the
scan workers and the provider keys. peer1 has 1 GB RAM and none of those; the API already has them on two hosts
(Pi + k3s). Linking would duplicate the secrets and the DB pool on a swap-thrashing box. The endpoint costs one HTTPS
hop (~100 ms) against a 3–4 s LLM turn.

The route trusts the bot for identity (service bearer): the bot passes the platform user key, the scope (dm/group)
and, when the user linked Pokoin, the Firebase uid it got from `/api/poko-connect status`. Personal context
(desk/cart/watchlist/collection) and recent website Messages are added **only in DMs** for a linked uid. Public
scopes (Telegram groups, Discord servers) never get personal data — the rule Hermes already applied on Discord.

## Rollout switches

Transport (who owns the Telegram poller / Discord message handler):

| Hermes (`/etc/systemd/system/hermes-poko.service.d/poko-bot-switch.conf`) | poko-bot (`/etc/poko-bot/switch.env`) |
|---|---|
| `POKO_TELEGRAM_CHAT=off` stops Hermes polling the Poko token | `POKO_BOT_TELEGRAM=on` |
| `POKO_DISCORD_MESSAGES=off` drops Poko MessageCreate in Hermes (slash commands, LoL bets, voice stay) | `POKO_BOT_DISCORD=on` |

Telegram allows one `getUpdates` consumer per token, so exactly one side polls. Discord allows several gateway sessions
per token; Hermes stays connected for interactions and only stops answering messages. `poko-switch <telegram|discord>
<rust|hermes>` flips both sides and restarts them in the safe order.

Brain routing inside poko-bot, per message (same semantics as the website's `POKO_BRAIN_MODE`):
`POKO_BOT_BRAIN_MODE=hermes|canary|rust`, `POKO_BOT_CANARY_UIDS` (Firebase uids of linked accounts) plus
`POKO_BOT_CANARY_TELEGRAM_IDS` / `POKO_BOT_CANARY_DISCORD_IDS`. Brain-enabled users go to `/api/poko-bot-chat`;
everybody else, and any brain failure, goes to Hermes' `POST 127.0.0.1:8789/api/poko/chat`.

Fallback ladder: brain → Hermes HTTP (same message) → fixed apology. Service-level fallback: `poko-switch … hermes`.

## Ported behaviour (Hermes → poko-bot)

- Reply gate `shouldPokoEngage` + `looksLikePokoPrivateCapabilityRequest` (poko-reply-gate.js, poko-isolation.js).
- Commands `/start [connect_CODE]`, `/connect CODE`, `/whoami`, `/disconnect`, `/help` on Telegram and as Discord text;
  5 redeem attempts / 10 min per user; 5 min link cache; leaked link code in a Discord server → delete message, redeem,
  short public notice. Telegram `setMyCommands` at startup. `/connect@BotName` is accepted in Telegram groups.
- wPKN contract-address shortcut reply.
- Discord server context: last 15 channel messages (≤2,500 chars) + the replied-to message, public-scope rules.
- Telegram voice/audio/video_note → Gemini transcript → text turn (`[transcript:voice] …`).
- Telegram photos (and Discord image attachments on a gated message) → JPEG to the route (scan-worker card
  identification, same as website photos) + a Gemini visual description as a context block.
- Telegram HTML output (`**bold**` → `<b>`, escaping), 4,096-char limit, plain-text retry on parse errors;
  Discord replies ≤1,800 chars per message.
- Short per-chat history (10 turns) kept in memory and snapshotted to `/var/lib/poko-bot/history.json`.

Hermes Agent v0.22 (Oct 2026) behaviour, shared with Hermes Node:

- **Gateway singleton lock** (`HERMES_GATEWAY_LOCK`, default on; `HERMES_GATEWAY_LOCK_DIR`, default
  `$POKO_BOT_STATE_DIR/gateway-locks`). Before polling Telegram, poko-bot takes `telegram-<botId>.lock`, a JSON record
  with the kernel boot id and a 30 s heartbeat. A record from another holder blocks polling only if it was written in
  this boot and its heartbeat is under 90 s old, so recycled PIDs after a reboot never count. A deferred gateway retries
  every 60 s; one that loses the lock stops polling and goes back to waiting. The record format is the same as Hermes
  `src/gateway-lock.js`: point both at one directory and they cannot both poll the Poko token (e.g. a half-finished
  `poko-switch`). A fresh record left by our own previous run never blocks us: same `HERMES_GATEWAY_INSTANCE`
  (set it per deployment, e.g. `poko-bot` and `hermes-poko`), or same PID namespace with that PID gone.
  `/health` shows `telegram.gatewayLock` (`held`, `deferred:<name>@<host>`, `lost`, `unguarded:<why>`).
- **Bounded wait-out** (`POKO_BOT_TRANSIENT_WAIT_MS`, default `4000,12000`; empty disables). When the brain and the
  Hermes fallback both fail only transiently (timeouts, 5xx/529, overload, connection resets), the turn keeps typing
  and retries up to that many cycles before the apology. Auth, quota and validation errors are never retried.
  `/health` counts `turns.transientWaits`.
- **Invisible Unicode**: bidi overrides/isolates, Unicode tag characters and zero-width characters are stripped from
  text and captions before the gate and the model see them (`turns.invisibleStripped`).

Not ported in this phase: LoL bets and the Discord slash commands (stay in Hermes), news scout/newsroom, X webhook,
YouTube replies, owner-only social posting / Twitter drafts from Telegram, Honcho long-term memory, Hypemeter news
context (follow-up: a news tool in the brain so the website gets it too), local faster-whisper.

## Measurements to report

RSS of poko-bot vs hermes-poko (~151 MB node+npm), `/health` counters on 127.0.0.1:8790 (turns, brain ok/fail,
fallbacks, p50/p95 brain latency), end-to-end Telegram/Discord latency from message to reply.

## Operations

peer1 runs Ubuntu 22.04 (glibc 2.35). A native build on nezopt (glibc 2.39) links `GLIBC_2.38` and does not start
there, so build the deploy binary in the `rust:1.99-bookworm` image, with a target dir outside the checkout
(run from the repository root):

```
docker run --rm --cpus 6 -u $(id -u):$(id -g) -e HOME=/tmp -v $PWD:/src \
  -v ~/.cargo/registry:/usr/local/cargo/registry -v ~/Projects/poko-bot-target-bookworm:/target \
  -w /src/pokoin-rust -e CARGO_TARGET_DIR=/target -e POKO_BOT_BUILD_COMMIT=$(git rev-parse --short HEAD) \
  rust:1.99-bookworm cargo build --release --locked -p poko-bot
objdump -T ~/Projects/poko-bot-target-bookworm/release/poko-bot | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1   # must be <= GLIBC_2.35
strip -o /tmp/poko-bot ~/Projects/poko-bot-target-bookworm/release/poko-bot
```

For local development `cargo build --release -p poko-bot -j 6` in `pokoin-rust` is fine.

Copy that binary to peer1 (do not build on the 1 GB box), then as root:

```
sudo apps/poko-bot/deploy/install.sh /path/to/poko-bot
```

`install.sh` is idempotent. It creates the `poko-bot` system user, installs the binary at `/opt/poko-bot/bin/poko-bot`, creates `/etc/poko-bot` (0750, root:poko-bot), and writes `/etc/poko-bot/env` (0640) by copying only the Telegram, Discord, API, and Gemini keys from `/opt/hermes-poko/.env.local` when that file exists. An existing env file is left in place unless `--refresh-env` is passed. Values are never printed. `/etc/poko-bot/switch.env` is created only when missing, with both platforms off and `POKO_BOT_BRAIN_MODE=canary`. The unit and `poko-switch` are installed and `systemctl daemon-reload` runs. The service is enabled and restarted only with `--start`.

Hand a platform to this daemon, or hand it back:

```
sudo poko-switch telegram rust
sudo poko-switch discord rust
sudo poko-switch telegram hermes
sudo poko-switch discord hermes
```

Moving to rust turns the Hermes side off, reloads systemd, restarts `hermes-poko`, waits for `http://127.0.0.1:8789/health` (up to 90s), turns the poko-bot side on, restarts `poko-bot`, and waits up to 45s for `http://127.0.0.1:8790/health` to show that platform live (`telegram.polling` or `discord.connected`). Moving to hermes does the reverse and waits for Hermes. A failed wait exits non-zero.

Brain routing, without moving the poller:

```
sudo poko-switch brain hermes
sudo poko-switch brain canary
sudo poko-switch brain rust
sudo poko-switch canary-add FIREBASE_UID
sudo poko-switch canary-add telegram:TELEGRAM_USER_ID
sudo poko-switch canary-add discord:DISCORD_USER_ID
```

`brain` and `canary-add` rewrite `switch.env` and restart `poko-bot` so the process picks up the file.

Health: `curl -fsS http://127.0.0.1:8790/health`

Logs: `journalctl -u poko-bot`

Both switch files and both health summaries: `sudo poko-switch status`
