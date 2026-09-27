# POKO CHAT — website Messages / dock → Hermes

Status: live path. Website Poko is **Hermes only** — no local scripted
replies and no local `poko-market` fallback inside this BFF.

## Flow

```
Browser (Messages / chat dock)
  → Firebase bearer
  → POST /api/poko-chat   { message, cards?, images?, sessionId? }
  → Pi BFF server/pokoin-api/poko-chat.js
  → Hermes peer1  POST {POKONTACT_SERVICE_URL}/chat
       default base: http://92.5.153.117:8789/api/poko
       full URL:     …/api/poko/chat
```

Hermes (`/opt/hermes-poko` on oracle-peer1, `hermes-poko.service` :8789)
loads `docs/poko-knowledge.md` + `docs/poko-behavior-seed.jsonl`, plans with
the LLM, and may call `POST /api/poko-market` for sold/ask/liquidity tools
(see [POKO_MARKET.md](./POKO_MARKET.md)).

## Env (Pi `pokoin-oracle-api`)

| Variable | Role |
|---|---|
| `POKONTACT_SERVICE_URL` | Base ending in `/api/poko` (already used by `pokoin-assistant`) |
| `POKONTACT_SERVICE_TOKEN` | Bearer Hermes accepts (same secret family as market tools) |
| `POKO_CHAT_URL` | Optional override of the base / full chat URL |
| `POKO_API_TOKEN` | Optional override of the bearer |
| `POKO_CHAT_TIMEOUT_MS` | Optional (default 45000) |

URL resolve (same as CardVault `pokoin-assistant.js`):

- if value already ends with `/chat` → use as-is
- else append `/chat`

## Failure behaviour

If Hermes is unreachable or misconfigured, the BFF returns HTTP 200 with
`source: "unavailable"` and the soft line:

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
