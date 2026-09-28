# POKO MARKET — Poko market intelligence API

Status: **live** (Pi release `poko-market-102dc55`, 2026-09-28). One
authoritative read-only market tool surface for every Poko channel (site chat
dock + `/messages/poko`, Telegram, YouTube replies).

Website Messages mounts a permanent **Poko** thread at `/messages/poko` and
in the chat dock. The browser calls Firebase-authed `POST /api/poko-chat`
(see [POKO_CHAT.md](./POKO_CHAT.md)), which proxies **only** to Hermes
`…/api/poko/chat`. Hermes may call the tools below via `POKO_MARKET_API_URL`.
Attached cards and photos are forwarded as `cards[]` / `images[]`.

## Resolution behaviour

Card resolution is sentence-tolerant: chatter ("how much is a … worth? near
mint english") is stripped server-side and the query retries progressively, so
planner-extracted free text resolves without exact card names. Ambiguous
results return the candidate list — the assistant asks one clarification and
never guesses a card id.

## Contract

`POST /api/poko-market` — server-to-server only. Never call it from a browser.

Auth: `Authorization: Bearer $TOKEN` (timing-safe compare) where $TOKEN is
`POKO_MARKET_SERVICE_TOKEN`, or `POKONTACT_SERVICE_TOKEN` — the same secret
already provisioned in the Pi container env (docs/poko-handoff.md).
Missing token in env → 503; wrong token → 401.

Body: `{ "tool": "...", "params": { ... } }`. Unknown tool → 400.

| Tool | Params | Returns |
|---|---|---|
| `resolve_card` | `query` and/or `artist` | catalog candidates only (`status: ok \| ambiguous \| not_found`); never an invented cardId |
| `card_quote` | `cardId` or `query`; optional `condition`, `language` | sold estimate (median/p25/p75, 90d, `cardtrader_sold_daily`), current asks (`cardtrader_blueprint_daily_analytics`), liquidity band, quick/market/patient strategies when sample supports |
| `card_liquidity` | `cardId` or `query` | deterministic `lowDays/typicalDays/highDays` + `methodology` + confidence |
| `collection_quote` | `artist` (+ optional `condition`, `language`, default NM/EN/1 copy) | per-artist totals with explicit `coveragePct`; market value vs acquisition cost kept separate |
| `suggest_cards` | `subject` (+ `excludeCardId`, `limit` 1-12) | real catalog cards matching the subject with current lowest ask — powers "another cool steelix card?" |
| `market_snapshot` | `limit` (1-50) | top `sold_qty_7d` cards |

## Product rules baked into the handler

- Vague condition wording ("a bit damaged") quotes two condition ranges and
  never claims a grade; casual terms map onto the CardTrader scale
  (NM/SP/MP/PL/Poor).
- Zero sold observations → `askingPriceOnly: true`; no sold median is invented.
- Sample size and confidence ride every estimate (`high >=10`, `medium >=4`,
  else `low`/`none`).
- `marketplace_card_weights` older than 3 days is treated as absent (stale
  pipeline guard) and liquidity falls back to fresh `cardtrader_sold_daily`.
- Ambiguous artists/cards return the candidate list for one concise
  clarification; "Yukamori"-style typos resolve only when unambiguous.

## Privacy boundary

The SQL selects public aggregates only. `seller_uid`, `buyer_uid`, emails,
addresses, account ids never exist in any response DTO — enforced by tests
(`poko-market.test.js` plants private columns in fixtures and deep-scans the
serialized output).

## Data sources (all read-only, Pi replica)

- `cardtrader_sold_daily` — sanitized sold market (all inference-sanitization
  passes already applied upstream; this module adds none).
- `cardtrader_blueprint_daily_analytics` — latest min/median asks per blueprint.
- `marketplace_card_weights` — sell-through / days-of-supply signals.
- `marketplace_search_candidates` (+ `marketplace_cards`) — catalog resolution.
- Public card id = CardTrader blueprint × 2 for singles.

## Hermes side

`Hermes/src/poko-market.js` is the single client used by website chat
(`poko-api.js`), Telegram (`telegram.js`), and the future YouTube adapter:
env `POKO_MARKET_API_URL` (e.g. `https://api.pokoin.com/api/poko-market`),
`POKO_MARKET_API_TOKEN`, optional `POKO_MARKET_TIMEOUT_MS` (default 12s).
The LLM selects the tool through the `market_query` plan action; all math
stays server-side.

## Deploy

```bash
# No token provisioning needed: the handler accepts POKONTACT_SERVICE_TOKEN,
# already present in the Pi container env. Hermes callers reuse POKO_API_TOKEN.
scripts/deploy-poko-market-api.sh   # from an origin/main commit; verifies 401 + health, auto-rollback
```

No new SQL/migrations: existing aggregates are sufficient for v1. If quote
latency ever demands it, add a keyed aggregate under `scripts/sql/092_*`.
