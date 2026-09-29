# POKO CHAT — website Messages / dock → Hermes

Status: live path. Website Poko is **Hermes only** — no local scripted
replies and no local `poko-market` fallback inside this BFF.

Transcript is **server-backed** in Firestore
`poko_conversations/{uid}/events` and synced to the browser via a thin
cache (localStorage) + poll. Local storage alone is not the source of truth.

## Flow

```
Browser (Messages / chat dock)
  → Firebase bearer
  → GET  /api/poko-chat?action=history   (sync transcript)
  → POST /api/poko-chat   { message, cards?, images?, sessionId?, pageContext? }
  → Pi BFF server/pokoin-api/poko-chat.js
       1) POST Hermes peer1  {POKONTACT_SERVICE_URL}/chat
       2) append user+assistant events to Firestore
  → response includes `events[]` (server ids) and `source`
       source=hermes | unavailable (timeout / planner failure)
```

On a card desk the SPA always includes the open printing in `cards[]` /
`pageContext.deskCardId` (even with no drag-attach). The BFF prepends a
market-first multipath directive so Hermes runs `card_quote` (+ `card_ocr`
when needed) instead of inventing lore.

## Channels

| Surface | Role |
|---|---|
| Website Messages / dock | Firebase → `/api/poko-chat` → Hermes |
| Telegram `@pokoinpos_bot` | Hermes Telegram polling |
| Discord `Poko#1220` | Hermes Discord |

**Connect** (`/api/poko-connect`) links a Pokoin account to **Telegram and/or
Discord** with the same one-time profile code (`/connect CODE` on either
channel). Linked chats resolve to Honcho peer `poko_user_<firebaseUid>` — the
same persona as website Messages — without merging strangers' memories.
`unlink_me` accepts `channel=telegram|discord|all`.

**Personal context** (`/api/poko-personal-context`) loads desk, recently seen,
watchlist, cart, seller inventory, and collection for that Firebase uid and
injects a compact intent block into Hermes. Website chat syncs browser
cart/watchlist/desk into `poko_user_personal_snapshot` so linked Telegram/
Discord turns see the same personal facts (recents/inventory/collection are
always live). Requires SQL `scripts/sql/095_poko_personal_snapshot.sql`.

Hermes (`/opt/hermes-poko` on oracle-peer1, `hermes-poko.service` :8789)
loads `docs/poko-knowledge.md` + `docs/poko-behavior-seed.jsonl`, plans with
the LLM, and may call `POST /api/poko-market` for sold/ask/liquidity tools
(see [POKO_MARKET.md](./POKO_MARKET.md)).

## Env (Pi `pokoin-oracle-api`)

| Variable | Role |
|---|---|
| `POKONTACT_SERVICE_URL` | Base ending in `/api/poko` |
| `POKONTACT_SERVICE_TOKEN` | Bearer Hermes accepts |
| `POKO_CHAT_URL` | Optional override of the base / full chat URL |
| `POKO_API_TOKEN` | Optional override of the bearer |
| `POKO_CHAT_TIMEOUT_MS` | Optional (default 45000) |

### Network (important)

Hermes listens on peer1 private/loopback `:8789` and is **not** open on the
public IP. The Pi reaches it through an SSH local forward:

- systemd: `hermes-pi-poko-tunnel.service` on pi-home  
- `127.0.0.1:18789` → peer1 `127.0.0.1:8789`  
- peer1 `authorized_keys` for the Pi tunnel key must include  
  `permitopen="127.0.0.1:8789"`  
- API env: `POKONTACT_SERVICE_URL=http://127.0.0.1:18789/api/poko`

Do **not** point the Pi at `http://10.0.0.170:8789` (Oracle VCN private) or
the public `92.5.153.117:8789` — both fail from pi-home.

URL resolve (same as CardVault `pokoin-assistant.js`):

- if value already ends with `/chat` → use as-is
- else append `/chat`

## Failure behaviour

If Hermes is unreachable or misconfigured, the BFF returns HTTP 200 with
`ok: false`, `source: "unavailable"`, persists the turn, and sets `error`
so the UI can show retry instead of treating the soft line as a normal
Hermes answer:

> I don’t know the answer yet, but I’m always improving ✨ …

It does **not** invent market quotes or run local FAQ scripts.

## UI

- Dock and `/messages/poko` use the **same composer** as people chats
  (↑ send, + photos, drag-drop card tags, mascot avatar).
- Attached cards → `cards[]`; photos → `images[]` (https URLs only).

## Deploy

```bash
scripts/deploy-poko-market-api.sh   # ships poko-chat.js + route + poko-market
scripts/deploy-web.sh               # Messages / ChatDock SPA
```

After Hermes knowledge edits on peer1, restart:

```bash
ssh oracle-peer1 'systemctl restart hermes-poko.service'
```

## Related

- Hermes knowledge: `/opt/hermes-poko/docs/poko-knowledge.md`
- Behavior seed: `/opt/hermes-poko/docs/poko-behavior-seed.jsonl`
- Handoff: `/opt/hermes-poko/docs/poko-handoff.md`
- Obsidian (pi-home): `/home/nes/Obsidian/Pokoin/` — note `Hermes-Poko-website-chat`
