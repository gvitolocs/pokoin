# POKO CONNECT — Pokoin profile ↔ Telegram linking

Status: live. Lets a signed-in Pokoin account verify itself to the Poko
assistant on Telegram, so Poko's per-user memory is anchored to a real profile
instead of an anonymous chat id.

## Flow

1. Signed-in user opens **Profile → Telegram** (`TelegramConnectPanel`) and
   presses **Get link code** → `POST /api/poko-connect { action: "create_code" }`
   (Firebase bearer). Codes are 8 chars (unambiguous alphabet), last 15
   minutes, work once, and are stored only as SHA-256 hashes.
2. The panel shows a **"Open Telegram & link"** deep link:
   `https://t.me/pokoinpos_bot?start=connect_<CODE>`.
3. The bot redeems it (`/start connect_CODE` or `/connect CODE`):
   `POST /api/poko-connect { action: "redeem", code, telegram: { userId,
   username, displayName } }` (service bearer from Hermes). One Pokoin
   account ↔ one Telegram user, enforced in both directions.
4. Linked users get a `[Pokoin profile]` context line in every Poko turn.
   `/whoami` shows status; `/disconnect` unlinks.

## Contract

`POST /api/poko-connect` — one route, action-switched.

| Action | Auth | Body | Returns |
|---|---|---|---|
| `create_code` | Firebase bearer | — | `{ code, expiresAtMinutes: 15 }` |
| `my_status` | Firebase bearer | — | `{ linked, telegramUsername?, linkedAt? }` |
| `unlink_me` | Firebase bearer | — | `{ linked: false }` |
| `redeem` | Service bearer | `code`, `telegramUserId`, `telegramUsername?`, `telegramDisplayName?` | `{ linked, firebaseUid }` |
| `status` | Service bearer | `telegramUserId` | `{ linked, firebaseUid?, telegramUsername? }` |
| `unlink` | Service bearer | `telegramUserId` | `{ linked: false }` |

Service bearer = `POKO_MARKET_SERVICE_TOKEN` or the shared
`POKONTACT_SERVICE_TOKEN`. Missing → 503, wrong → 401.

## Storage (writer)

- `poko_telegram_links` — one row per link (`firebase_uid` unique,
  `telegram_user_id` unique, soft `unlinked_at`).
- `poko_telegram_link_codes` — hashed codes with `expires_at`/`redeemed_at`.
- Migration: `scripts/sql/092_poko_telegram_links.sql` (applied on the nezopt
  writer 2026-09-27).

## Hermes side

`Hermes/src/poko-connect.js` (commands + status cache) and the Telegram
command wiring in `src/telegram.js`; commands menu registered at boot via
`setMyCommands`. Telegram itself is open — any user can DM the bot; linking is
optional but unlocks the verified identity.
