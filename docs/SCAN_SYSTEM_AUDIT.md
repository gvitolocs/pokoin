# Scan system audit (before Scan Connect)

State of the seller, scan, catalog and realtime code on 2026-09-17, and what
Scan Connect reuses. Specs: [SCAN_CONNECT.md](SCAN_CONNECT.md),
[SCAN_LISTING_WORKFLOW.md](SCAN_LISTING_WORKFLOW.md),
[POWERTOOLS_FEATURE_MATRIX.md](POWERTOOLS_FEATURE_MATRIX.md),
[KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md),
[SCAN_PERFORMANCE.md](SCAN_PERFORMANCE.md). Vault:
[[MOC Pokoin scan connect]] on the Pi.

Paths without a prefix are pokoin-web. **CardVault** is
`/home/nez/Projects/cardvault/pokemon_card_vault`, **BattleScan**
`/home/nez/Projects/BattleScan`, **candyext** `/home/nez/Projects/candyext`.

## 0. Hosts

| Surface | What it is |
| --- | --- |
| Seller dashboard | pokoin.com SPA: `/inventory` (`market/src/pages/Inventory.jsx`), `/orders`, `/profile`, card desk **List your card**. There is **no** `dashboard.` host and no `pokecoin` name in any repo on nezopt. Hosts: `pokoin.com`, `onepiece.`, `riftbound.`, `test.` (`vercel.json`). |
| Phone scanner | `scan.pokoin.com` = BattleScan `web/index.html`, served by the FastAPI app on Oracle peer1 (`/opt/pokoin-cardscan/web`). Identify is `cardscan.pokoin.com` → nezopt `battlescan-fast`. |
| Mobile detection | None. Phone layout is CSS-only ([MOBILE.md](MOBILE.md)). No User-Agent redirect in `vercel.json` or `workers/`. `scan.pokoin.com` navigates to `https://pokoin.com/{public_id}` after an accepted identify (score ≥ 0.72, BattleScan `docs/recognition-redirect-20260903.md`). |
| PowerTools reference | `candyext/dump/`: HAR mirror of `new.` / `app.tcgpowertools.com` (original bundles, KB, screenshots, API manifest). `cookies.txt`, `auth_state.json`, `cookies_cdp.json` are a live session — not read. |

Scan Connect stays on existing hosts: desktop `pokoin.com/inventory/scan`,
phone `scan.pokoin.com/connect` ([SCAN_CONNECT.md](SCAN_CONNECT.md#routes)).

## 1. Topology

```
pokoin.com (Vercel SPA, market/)  ──/api/* rewrite──▶  api.pokoin.com (Cloudflare tunnel)
                                                        └─ Pi: CardVault server/oracle-api-server.js
                                                             · one Node process (pm2 fork, instances: 1)
                                                             · reads: Postgres streaming replica 127.0.0.1:5432
                                                             · writes: MARKETPLACE_WRITER_DATABASE_URL (nezopt NVMe primary)
                                                             · Valkey 127.0.0.1:6379 (48 MB, cache only)
                                                             · Firebase Admin (auth, Firestore)
scan.pokoin.com  (peer1 FastAPI, BattleScan web/index.html)
cardscan.pokoin.com/identify ──▶ nezopt battlescan-fast (YOLO + Milo, one global lock)
```

| Piece | Where | Notes for Scan Connect |
| --- | --- | --- |
| SPA | `market/src/App.jsx` (react-router 7, Vite) | Add one route. `/scan`, `/cardscan`, `/scancard` stay the public photo identify page. |
| API router | CardVault `server/oracle-api-server.js`, routes in `server/api-route-manifest.js`, families `server/api-route-families.js` | `/api/foo` → `api/foo.js`, Vercel-style `(req, res)`. New handlers must be registered in the manifest. Body is buffered and JSON-parsed unless the file is in `RAW_BODY_ROUTE_FILES`. After the handler resolves the server calls `res.end()` — a streaming handler must not resolve until the client disconnects. |
| Auth | Firebase ID token, `verifyBearerToken` (CardVault `api/_firebase.js`); SPA `getBearer()` (`market/src/auth.jsx`) | Desktop calls reuse it. The phone has **no** Firebase session by design. |
| DB split | `marketplaceQuery` (replica) vs `marketplaceWriteQuery` (primary) in CardVault `api/_marketplace_db.js` | Scan state must be **read from the writer** — replica lag would make a just-scanned card invisible to its own stream. |
| Valkey | CardVault `api/_valkey.js` | One TCP connection per command, 400 ms timeout, **returns `null` on any error**. Fine for caches, wrong for security counters (fails open). No pub/sub client. |
| CORS | Per handler (`auth-login.js`, `cardtrader-live-listings.js`, …); none global | Phone origin `scan.pokoin.com` calls `api.pokoin.com` directly → scan handlers set their own allowlist. |

## 2. Catalog identity (do not add a second version system)

| Concept | Existing model | Source |
| --- | --- | --- |
| **Printing** (card + set + collector + art) | Public `card_id` = leftover CardTrader `ct_id` × 2. One row per printing in `marketplace_card_versions` (`name`, `expansion_name`, `expansion_number`, `product_variant`, `blueprint_id`, images). Search/desk read `marketplace_search_candidates`. | `docs/MARKET.md#identity-do-this-not-the-other-thing`, CardVault `oracle-postgres/schema/001_marketplace_core.sql` |
| **Same-set rarity lineup** (regular ↔ IR ↔ secret of one card) | `rarities` on `GET /api/marketplace-card-page` | `docs/VERSIONS.md`, `market/src/card-versions.js` |
| **Same artwork across sets/languages** ("versions") | `pokoin_version_sets` (CLIP groups) + `marketplace_search_candidates.version`; `GET /api/marketplace-version-set?cardId=` | `docs/VERSIONS.md` |
| **Print language of an expansion** | `pokoin_pokemon_expansions.nationality` (western / japanese / chinese / korean / …) | `docs/PRINT_FLAGS.md`, `market/src/locale.js` `languagesForNationality` |
| Reverse holo / Poké Ball / Master Ball variants | Mostly **seller attribute** (`reverse`, `foil_state`) on the listing; CardTrader also has some separate reverse blueprints that stay hidden unless searched | `docs/API.md` (Sets index), `market/src/pages/Card.jsx` `FOILS` |

Scan Connect stores the chosen printing as the public `card_id` and the
candidates as the scanner's `public_id` hits. "Switch printing" walks the
scan's own top-k hits first, then `marketplace-version-set` (same artwork)
and `rarities` (same set). No new printing table.

## 3. Seller article model (the listing)

`public.marketplace_user_listings` (CardVault schema `001_marketplace_core.sql`),
written only through `POST/PATCH /api/marketplace-listings`
(CardVault `api/marketplace-listings.js`).

| Column | Kind | Values the SPA offers today (`Card.jsx` ListingForm) |
| --- | --- | --- |
| `card_id` | catalog identity (printing) | public id |
| `condition` | seller attribute | `NM` `SP` `MP` `PL` `Poor` |
| `language` | seller attribute | `EN IT FR DE ES JP PT NL PL RU KO ZH ZHT ID TH VI`, filtered by expansion nationality |
| `foil_state` + `reverse` | seller attribute (finish) | `standard` `holo` `reverse` `stamped` `promo` `other`; `reverse` mirrors `foil_state = 'reverse'` |
| `variant_state` | free text, unused by the SPA | — |
| `first_edition` | seller attribute | chip |
| `signed` | seller attribute | column exists, SPA always sends `false` |
| `graded`, `grading_company`, `grade`, `certification_id` | seller attribute | chip + 3 inputs |
| `sealed` | product attribute | chip |
| `quantity_available` | quantity | API 1–99 on create (DB allows 999999) |
| `price_pkn` | price | required `> 0` |
| `seller_comment` | comment | filtered by `_seller_comment_filter.js` |
| `shipping_available`, `reserve_available`, `nft_available`, `source`, `source_listing_id` | channel flags | `source = 'pokoin_user_listing'` for sellers |
| `status` | `active` `paused` `inactive` `sold_out` | no draft state |

**Missing for this feature:** `altered`, `country_edition`, **location**, a
staged/draft state, and any idempotency key on create. There is **no
location / storage-position support anywhere** (grep of both repos and the
schema). Sold-comp "stack identity" is seller + language + condition +
reverse / 1st / graded (`docs/MARKET.md#sold-comps`).

Quantity semantics: **one row per identical stack** with a quantity, not
one row per physical copy. Checkout decrements (`?action=decrement`). So
four identical copies must become one listing with `quantity_available = 4`.

Security note found during the audit (not changed here): `POST
/api/marketplace-listings?action=decrement&id=` verifies a bearer token but
not that the caller owns the listing. Filed as a follow-up in
[POWERTOOLS_FEATURE_MATRIX.md](POWERTOOLS_FEATURE_MATRIX.md#follow-up-tasks).

## 4. Current listing workflow

1. Seller searches or scans to reach a card desk.
2. Card desk **List your card** (`market/src/pages/Card.jsx` `ListingForm`):
   price + currency, qty, condition, language, foil, chips, comment.
3. `createListing` → `POST /api/marketplace-listings` → row is **live
   immediately** (`status = 'active'`), `refresh_marketplace_blueprint_price_summary`.
4. `/inventory` lists the seller's rows (`GET ?sellerUid=` with bearer), read-only.

One card per page visit, mouse-driven, no batch, no keyboard.

## 5. Scanner and recognition pipeline

| Piece | Where | Behaviour |
| --- | --- | --- |
| Phone page | BattleScan `web/index.html` (863 lines, inline script) | Rear camera 1280×960, live frame every 280 ms (`LIVE_MS`), JPEG 0.72 at ≤960 px, Single / Multi, torch, gallery. |
| Identify API | BattleScan `server/app.py` `POST /identify?catalog=&top_k=&live=&multi=` | YOLO detect → orientation passes → Milo 128-d embedding → catalog dot product. Hits carry `public_id`, `ct_id`, `pokoin_url`, `name`, `score`. Card-back rejection. **One global lock**: a concurrent request returns `{busy:true}` immediately. CORS allows `pokoin.com`, `scan.pokoin.com`, `cardscan.pokoin.com`, `*.vercel.app`. |
| Acceptance | `ACCEPT = 0.72` (navigate), `0.60–0.72` "Possible match" candidates; server `_immediate` = top ≥ 0.80 and margin to #2 ≥ 0.08 | BattleScan `docs/recognition-redirect-20260903.md` |
| Catalogs | `pokemon_generic` (54,908 leftover JPEGs, W+JP+CN), language catalogs | `docs/SCAN.md` |
| SPA `/scan` | `market/src/pages/Scan.jsx` + `api.js identifyScan` + `scan-id.js` | File upload → `/cardscan/identify?catalog=pokemon_generic` → list of desk links. |
| Finish detection | **None.** The embedding cannot tell normal / holo / reverse. | Scan Connect never claims a finish from the photo. |

## 6. Realtime and session infrastructure

| Candidate | Exists? | Fit for scan events |
| --- | --- | --- |
| Firestore `onSnapshot` | **Yes** — `auth.jsx` (profile/balance), `pages/Orders.jsx`, `pages/Nft.jsx` | Would need a **second copy** of every scan event (Postgres is where the batch and listings live), a Pi → Google → browser hop, new Firestore rules, and reconciliation when the Firestore write fails after the Postgres commit. The phone has no Firebase auth, so it would still post over HTTP. |
| WebSocket | No (no `ws` dependency; PowerTools uses ActionCable, Pokoin does not) | New dependency + upgrade handling through the Cloudflare tunnel. |
| SSE / streaming HTTP | No, but the Node `http` server streams fine (single process) | Postgres stays the only store; replay-from-cursor is the same code path as live delivery. |
| Valkey pub/sub | Valkey exists; client has no subscribe mode | Not needed while the API is one process. |
| Redis sessions | None (auth is stateless Firebase JWT) | — |

Decision (details in [SCAN_CONNECT.md](SCAN_CONNECT.md#realtime-transport)):
**Postgres writer = source of truth, SSE-framed `fetch` stream from the
existing API process for push, cursor replay for every reconnect.** Nothing
new to install; Firestore stays for orders/wallet.

## 7. Keyboard shortcut infrastructure

None. The only document `keydown` listeners are **Escape** closers in
`components/Chrome.jsx` (search suggest, print-language menu, burger). No
`?` help, no hotkey library. Chrome search is submitted with Enter inside its
input. Scan shortcuts therefore get a small scoped module with tests
([KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md)).

## 8. CardTrader integration (relevant parts)

| Piece | Where | Relevance |
| --- | --- | --- |
| Token connect / status / disconnect | CardVault `api/cardtrader-connect.js`, `cardtrader-status.js`, `cardtrader-disconnect.js`, token encrypted in Firestore (`_cardtrader_integration.js`) | Future "push batch to CardTrader". Out of scope. |
| Import dry run | `api/cardtrader-import-dry-run.js`, `marketplace_cardtrader_import_jobs` | Job table pattern (queued/running/…); not a staged listing model. |
| Seller book snapshots | `cardtrader_user_listing_snapshots` (condition, language, `properties` jsonb) | Sync, not listing creation. |
| Live CardTrader asks on the desk | `api/cardtrader-live-listings.js` merged as `pknreserve` | Read side only. |

## 9. Design language

Dark desk (`--bg #000`, `--surface #16141a`, gold `--yellow #FFD33D`,
Satoshi), `components/Desk.jsx` (`PageHead`, `DeskPanel`, `Alert`,
`EmptyDesk`, `SessionWait`), `desk.css`. Candy Ext Collectr/PowerTools
references are for **density and flow**, not colours. PowerTools listing
screen: left mode rail, tabbed staging area ("Tab 1 · Singles 0 | Acc. 0"),
toolbar Select All / Select None / Export / Actions / **SAVE**
(`candyext/dump/shots/new.tcgpowertools.com/listing-and-appraisal.png`).

## 10. Reuse map

| New concept | Reuses | New code only for |
| --- | --- | --- |
| Pairing | Firebase bearer on desktop, `crypto.randomInt` | 4-digit PIN table + limits |
| Scan Session | API process, writer DB | session row, phone credential hash |
| Scan Batch | nothing equivalent (listings have no draft state) | batch + staged items |
| Scan Event | BattleScan identify hits (`public_id`, `score`) | immutable event columns, idempotency key |
| Catalog match | `public_id`, `marketplace_card_versions`, `marketplace-version-set`, card-page `rarities` | ambiguity classification thresholds (shared with BattleScan) |
| Inventory article | `marketplace_user_listings` + existing create/PATCH semantics | location / altered / country edition columns (see matrix), submit-with-idempotency path |
| Realtime | API process + writer DB | stream handler, client reconnect |
| Phone UI | BattleScan camera loop, detection, orientation fixes | connect keypad + upload queue |
| Desktop UI | SPA router, `Desk.jsx`, `auth.jsx`, `locale.js` language lists | `/inventory/scan` page |
| Shortcuts | **PowerTools Pokémon hotkey map** (verified, see matrix) | scoped key handler |
