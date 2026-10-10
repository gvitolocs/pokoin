# POKO MARKET — Poko market intelligence API

Status: **live**. Price-source integration updated 2026-10-02. One
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

All fields derived from `*_pkn` columns are PKN token amounts. Responses mark
them with `priceUnit: "PKN"` / `currency: "PKN"` and `pknEurRate: 0.005`;
consumers must not interpret PKN as euro cents.

| Tool | Params | Returns |
|---|---|---|
| `resolve_card` | `query` and/or `artist` | catalog candidates only (`status: ok \| ambiguous \| not_found`); never an invented cardId |
| `card_quote` | `cardId` or `query`; optional `condition`, `language`, `priceDays` (1–90, default 14) | sold estimate (median/p25/p75, 90d), current asks, dated `priceSources.cardtrader` lowest asks in PKN and `priceSources.tcgplayer` aggregate subtype quotes in USD, liquidity and strategies when sold samples support them |
| `card_liquidity` | `cardId` or `query` | deterministic `lowDays/typicalDays/highDays` + `methodology` + confidence |
| `collection_quote` | `artist` (+ optional `condition`, `language`, default NM/EN/1 copy) | per-artist totals with explicit `coveragePct`; market value vs acquisition cost kept separate |
| `suggest_cards` | `subject` (+ `excludeCardId`, `limit` 1-12) | real catalog cards matching the subject with current lowest ask — powers "another cool steelix card?" |
| `market_snapshot` | `limit` (1-50) | top `sold_qty_7d` cards |
| `top_movers` | `subject` (pokemon/card words, optional), `days` (7-90, default 30), `direction` (`up`\|`down`), `limit` (1-10) | singles ranked by % change of daily lowest listed ask (first vs latest actual UTC refresh date), cards under €2 / 400 PKN excluded as bulk noise; returns explicit PKN and EUR values — powers "which Raikou card rose the most lately?"; empty window → 200 with `movers: []` + `note` |
| `card_ocr` | `cardId` or `query` | approximate western leftover PP-OCRv5 chrome (`marketplace_card_ocr`): attacks/abilities/HP text; `junk`/`confidence` when noisy; missing printing → `not_found` (never invent text) |

## Product rules baked into the handler

- Vague condition wording ("a bit damaged") quotes two condition ranges and
  never claims a grade; casual terms map onto the CardTrader scale
  (NM/SP/MP/PL/Poor).
- Zero sold observations → `askingPriceOnly: true`; no sold median is invented.
- Zero sold observations do not erase price analytics: quote available dated
  CardTrader asks and TCGplayer aggregate prices, naming source, currency,
  subtype and observation date. `priceSources.citationUrl` links the public
  source response. An unavailable optional history source preserves live asks.
- CardTrader analytics retain the genuine lowest listed ask only. Their copied
  median/average/max fields are not measured distribution statistics. The
  observation day comes from `refreshed_at` in UTC; `dumpDay` separately names
  the daily dump bucket. These asks are never inserted into sold history.
- TCGplayer subtype histories use USD, with condition/language unspecified.
  Never convert them into PKN implicitly or use them as condition-matched comps.
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
- `cardtrader_blueprint_daily_analytics` — dated lowest listed asks per blueprint.
- `tcgplayer_product_links` and the private TCGCSV reader — verified exact
  printing links and daily TCGplayer quotes, grouped by product/subtype.
- `marketplace_card_weights` — sell-through / days-of-supply signals.
- `marketplace_search_candidates` (+ `marketplace_cards`) — catalog resolution.
- `marketplace_card_ocr` — western leftover PP-OCRv5 chrome (attacks/rules);
  loaded by `scripts/import-marketplace-card-ocr.py` from
  `western-full-ocr-gpu.jsonl` after `scripts/sql/093_marketplace_card_ocr.sql`.
- All blueprint queries resolve `marketplace_search_candidates.ct_id` from the
  exact public `card_id`; no arithmetic fallback or blueprint-ID collision.

The card desk layout and its existing sanitized CardTrader sold graph remain
unchanged. Poko consumes these source DTOs directly. MyPokoin price-check adds
`cardtraderListed` history alongside live asks and a separate TCGplayer USD
column; daily asks and aggregate USD prices do not change automatic strategies.

## Hermes side

`Hermes/src/poko-market.js` is the single client used by website chat
(`poko-api.js`), Telegram (`telegram.js`), and the future YouTube adapter:
env `POKO_MARKET_API_URL` (e.g. `https://api.pokoin.com/api/poko-market`),
`POKO_MARKET_API_TOKEN`, optional `POKO_MARKET_TIMEOUT_MS` (default 12s).

Market plans are **multipath**: `market_query` carries `tools[]` with every
matching tool (e.g. `card_quote` + `card_ocr` for “worth and attacks”), run in
parallel. If none return useful data and a `cardId`/`query` is present, Hermes
retries with the full card set (`card_quote`, `card_ocr`, `card_liquidity`).
All math stays server-side.

## Deploy

```bash
# No token provisioning needed: the handler accepts POKONTACT_SERVICE_TOKEN,
# already present in the Pi Rust env. Hermes callers reuse POKO_API_TOKEN.
scripts/deploy-pokoin-rust.sh       # Rust release from an origin/main commit; health-checked, auto-rollback
```

No new SQL/migrations for quotes/movers. Card text needs
`scripts/sql/093_marketplace_card_ocr.sql` on the writer plus
`scripts/import-marketplace-card-ocr.py --apply` before `card_ocr` returns
rows. **Do not** deploy the API while Honcho workspaces
`hermes-peer1` / `poko-peer1` depend on it unless deploy is explicitly
approved — a release restarts `pokoin-rust-api`.
