# Scan Connect (desktop ↔ phone pairing and realtime)

A seller opens **Scan** on `dashboard.pokoin.com/scan` (same desk as
`pokoin.com/inventory/scan`), scans the QR with the phone camera — or types
the 4-digit code at `scan.pokoin.com/connect` — and every card the phone
recognises lands in the desktop queue within a second. The desktop owns
metadata; the phone is a camera. Listing semantics:
[SCAN_LISTING_WORKFLOW.md](SCAN_LISTING_WORKFLOW.md). Audit:
[SCAN_SYSTEM_AUDIT.md](SCAN_SYSTEM_AUDIT.md). Timings:
[SCAN_PERFORMANCE.md](SCAN_PERFORMANCE.md).

## Concepts (kept apart on purpose)

| Concept | Lifetime | Stored in | Why separate |
| --- | --- | --- | --- |
| **Pairing** | ≤ 120 s, single use | `scan_pairings` (PK `pin`) | Security object. Deleting it must never touch work. |
| **Scan Session** | one desktop ↔ phone working session; ends on inactivity (30 min), Done, logout | `scan_sessions` | Holds the phone credential hash and presence. Can end while the batch lives on. |
| **Scan Batch** | until submitted or discarded (days) | `scan_batches` | The seller's persistent work and the Batch Defaults history. A new session resumes it. |
| **Scan Event** | immutable | columns on `scan_items` (`scan_event_id` unique, `captured_at`, `recognition`, `defaults_snapshot`, `image`) | Idempotency key and audit of what the phone saw. |
| **Catalog match** | immutable per event | `scan_items.recognition` (`state`, candidates by public `card_id`) | Uses the existing public id; no new printing table. |
| **Inventory article** | live | `marketplace_user_listings` | Existing listing table; written only on submit. |

Four tables, not six: an event and its staged article are one row
(immutable event columns + mutable article columns) because every event
produces exactly one row; a merged duplicate is a row with
`status = 'merged'` pointing at its head, so Undo is a single update.
A trigger rejects updates to the event columns.

Schema: CardVault `oracle-postgres/schema/082_scan_connect.sql`.

## Routes

| Surface | Route | Why here |
| --- | --- | --- |
| Desktop | `dashboard.pokoin.com/scan` and `pokoin.com/inventory/scan` (SPA, `market/src/pages/ScanDesk.jsx`) | Same Vercel SPA. On the `dashboard.` host `/scan` renders the desk (`isDashboardHost`, `market/src/App.jsx`) and `/` redirects to `/scan` (`vercel.json`). On `pokoin.com`, `/scan` stays the public photo identify page. |
| Phone | `scan.pokoin.com/connect` — Oracle peer1 Caddy `file_server` over `/opt/pokoin-cardscan/web` with `rewrite /connect /index.html`; `web/static/scan-connect.js` switches that page to connect mode | Reuses the tuned camera loop, detection and orientation fixes. `scan.pokoin.com/` keeps redirecting accepted scans to the card page. Recognition paths (`/identify`, `/catalogs`, `/health`) proxy to `127.0.0.1:8100` → nezopt worker. The FastAPI `/connect` route in BattleScan `server/app.py` only matters when the app serves `web/` itself (local). |
| QR | `https://scan.pokoin.com/connect#c=<4 digits>&k=<secret>` | [QR link](#qr-link). Fragment is never sent to a server log. |

## API (CardVault, registered in `server/api-route-manifest.js`, family `scan`)

| Method + path | Caller / auth | Does |
| --- | --- | --- |
| `POST /api/scan-session?action=start` `{batchId?}` | desktop, Firebase bearer | Resume the seller's newest open batch (or `batchId`), end older live sessions of that batch (`replaced`), create session + pairing. Returns `{session, batch, pairing:{pin, qrSecret, expiresAt}}`. |
| `POST /api/scan-session?action=pairing` `{sessionId}` | desktop | Regenerate: old PIN deleted in the same transaction. |
| `POST /api/scan-session?action=disconnect` `{sessionId}` | desktop | Revoke the phone credential; session back to `waiting`. |
| `POST /api/scan-session?action=pause` `{sessionId, paused}` | desktop | Phone scans are rejected with `paused` (phone shows it). |
| `POST /api/scan-session?action=end` `{sessionId, reason}` | desktop | `completed` or `logout`. Batch untouched. |
| `GET /api/scan-session?sessionId=` | desktop | Session state. |
| `POST /api/scan-pair` `{pin}` (keypad), `{pin, qr}` (QR link), or `{qr}` (legacy link) + `{device}` | phone, **public** | Claim a pairing. Returns `{phoneToken, sessionId, serverTime, label:'Pokoin Dashboard'}`. Same `400 {"error":"Code not valid or expired."}` for wrong, expired and used codes. |
| `POST /api/scan-phone?action=heartbeat` | phone, `Authorization: Scan <phoneToken>` | Presence + `{status, paused, serverTime, defaultsLabel, received}`. |
| `POST /api/scan-phone?action=scan` | phone | One scan event (below). Idempotent on `scanEventId`. |
| `POST /api/scan-phone?action=leave` | phone | Phone disconnects itself. |
| `GET /api/scan-stream?batchId=&after=` | desktop, bearer | SSE-framed stream of row/batch/session changes after cursor. |
| `GET /api/scan-batch?batchId=` / `?list=open` / `?action=image&itemId=` | desktop | Snapshot, open batches, scan thumbnail. |
| `POST /api/scan-batch?action=defaults\|item\|add\|remove\|restore\|duplicate\|unmerge\|submit\|discard` | desktop | [SCAN_LISTING_WORKFLOW.md](SCAN_LISTING_WORKFLOW.md#api-actions). |

### Scan event body

```json
{
  "scanEventId": "uuid v4 (phone)",
  "clientSequence": 17,
  "capturedAt": 1789650000123,
  "clockOffsetMs": -42,
  "recognition": { "catalog": "pokemon_generic", "hits": [{ "public_id": "220962", "score": 0.91, "name": "Espurr" }] },
  "image": "<base64 JPEG ≤ 45 KB, optional>",
  "timings": { "captureToRequestMs": 31, "identifyMs": 240 }
}
```

`scanEventId` + `sessionId` + `clientSequence` + `capturedAt` are the
immutable identity. The server stores `received_at` itself.

## Pairing

1. Desktop `start` → `crypto.randomInt(0, 10000)` padded to 4 digits.
   `insert … on conflict (pin) do nothing` after deleting that PIN only if it
   is **expired**; conflict → draw again (≤ 20 tries, then 503). The PK makes
   the PIN unique among live pairings even across concurrent creates.
2. Pairing also gets `qrSecret` (24 random bytes, base64url), stored in
   plain text beside the PIN: it lives ≤ 120 s, is deleted on claim, and
   every open dashboard tab must be able to draw the same QR.
3. Phone posts the PIN. In one transaction: rate-limit check →
   `delete from scan_pairings where pin = $1 and expires_at > now() returning session_id`
   (the delete **is** the single-use claim; two phones racing on one PIN →
   exactly one row returned) → session must be `waiting` and belong to a live
   batch → store `sha256(phoneToken)`, `status = 'connected'`.
4. `phoneToken` = 32 random bytes (base64url). It is the only phone
   credential. It is scoped to that session: post scans, heartbeat, leave.
   It cannot read batch contents, listings, account data, or other sessions.

### QR link

The desk QR encodes `https://scan.pokoin.com/connect#c=4827&k=<qrSecret>`
(`phoneConnectUrl` in `market/src/scan-api.js`, ~73 bytes → QR version 5-M,
encoded locally by `market/src/qr.js`). Scanning it with the phone camera:

1. opens the scanner in connect mode;
2. `pairingFromHash` (BattleScan `web/static/scan-connect.js`) reads `c` and
   `k`, shows the 4 digits already in the slots, removes the fragment from
   the address bar;
3. posts `{pin, qr}` immediately — no typing;
4. the server claims the pairing only if **both** name the same live row
   (`pin = $1 and qr_secret = $2`, one `delete … returning`), so a stale or
   tampered link fails like a wrong code, counts toward the IP failure limit,
   and leaves the real pairing usable;
5. on success the phone shows **Connected to Pokoin Dashboard** and starts
   the camera; the desk flips to *iPhone connected*.

An expired QR shows "This QR code has expired. Type the new code from the
dashboard." with the keypad ready. The desk's **New code** regenerates PIN and
QR together. Tests: integration "dashboard QR link: PIN + secret…", phone
unit "dashboard QR link carries…", E2E step "dashboard QR link opens the phone
pre-filled…".

### Security protections

| Threat | Protection |
| --- | --- |
| PIN is a secret | It is not: it only selects a pairing for 120 s. The credential is the 256-bit `phoneToken`. |
| Flooding a batch with a leaked phone token | 1200 scans / session / 10 min (`scan:<session>` bucket, counted even when rejected), 10,000 rows per batch (`batch_full`). Retries of an already stored `scanEventId` are not counted. |
| Guessing a PIN | Postgres-backed fixed windows (`scan_rate_limits`, fails **closed**): 8 failed claims / IP / 10 min, 30 claims / IP / 10 min, 300 failed claims **globally** / 10 min (then 429 for everyone for the rest of the window). With *k* live pairings a guess hits with probability *k*/10,000: one IP (8 guesses) against 20 live codes ≈ 1.6 % per 10 min. Distributed attacks are bounded by the global cap (arithmetic below). |
| What a lucky guess gets | The ability to add scan rows to one staged batch until the seller notices. The desktop shows the device label and a **Disconnect** button; the real phone's claim fails ("code not valid") which prompts **Regenerate**. No listing is created without the desktop submitting. No read access. |
| Account enumeration | Pair response never includes seller name/uid; identical error for wrong / expired / used. |
| Session creation spam | 12 `start`s / seller / 10 min; 30 regenerations / session / 10 min. |
| Replay of a pairing | Row is deleted on claim; QR secret likewise. |
| Stolen phone token | Dies with disconnect, Done, logout, 30 min inactivity. Stored hashed. |
| Seller signs out | SPA calls `end` with `logout` before `signOut`. |
| Another account in the tab | Every desktop call checks `seller_uid = token uid` → 404; the SPA drops scan state when the uid changes. |
| Cross-site calls | CORS allowlist per handler: `https://pokoin.com`, `https://dashboard.pokoin.com`, `https://scan.pokoin.com`, `https://cardscan.pokoin.com`, plus `http://localhost:*` / `127.0.0.1:*` outside production. Phone uses `Authorization: Scan …`, never cookies. |
| Oversized uploads | image ≤ 45 KB decoded, ≤ 10 hits, strings clipped. |

Brute-force arithmetic, stated plainly: an attacker needs the right PIN
**while** it is live. One IP gets 8 wrong tries per 10 minutes. The global
cap of 300 failures per 10 minutes means an attacker with unlimited IPs gets
at most 300 guesses per window against whatever codes are live; with 5
pairings open at that moment the expected successes per window are
300 × 5 / 10,000 = 0.15, and each success is a staged-batch nuisance, not
account access. Once the global cap trips, legitimate phones also see 429
until the window ends — availability is traded for safety on purpose. The
**QR** path (192-bit secret) is not subject to that trade-off.

## Session states

| Stored `status` | Brief's names | Desktop shows |
| --- | --- | --- |
| `waiting` | CREATED, WAITING_FOR_PHONE | **Connect your phone** + PIN + QR |
| `connected`, phone seen < 12 s | CONNECTED | **{device} connected** |
| `connected`, scan < 20 s ago | SCANNING | **Scanning** |
| `connected`, phone silent ≥ 12 s | DISCONNECTED (derived) | **Connection lost — reconnecting** |
| `ended` + `end_reason` `completed` / `logout` / `replaced` | COMPLETED | **Session completed** |
| `ended` + `expired` | EXPIRED | **Session expired** + one-click new session on the same batch |

`DISCONNECTED` is derived from `phone_last_seen_at` instead of stored: a
phone that drops Wi-Fi cannot tell the server it left.

Inactivity: activity = pairing, scan received, desktop edit. Heartbeats and
open streams do not count (a phone left on the table must not keep a
credential alive). An idle session ends as `expired` lazily on the next
request. A scan whose `captured_at` is before `ended_at` is still accepted
for 120 s after an **expiry** (upload in flight), never after Disconnect,
Done or logout.

## Realtime transport

**Decision:** Postgres writer is the only store; `GET /api/scan-stream`
streams `text/event-stream` frames from the existing API process; every
(re)connect replays from a cursor.

| Option | Verdict |
| --- | --- |
| Firestore `onSnapshot` (exists for orders) | Rejected: second copy of every event (dual write), Pi → Google → browser hop, new rules; phone still needs HTTP. |
| WebSocket | Rejected: new dependency and upgrade path through the tunnel for a one-way feed. |
| **SSE over `fetch`** | Chosen: no dependency, `Authorization` header works (EventSource cannot send it), replay = live code path. |
| Polling only | Fallback behaviour when a proxy buffers the stream (see below). |

Mechanics:

- Every row change runs `update scan_batches set item_seq = item_seq + 1 returning item_seq`
  in the same transaction and stamps the row's `seq`. The batch cursor is
  that number.
- After commit the handler emits `batch:<id>` on an in-process bus
  (`api/_scan_bus.js`). Each open stream coalesces bursts and runs one
  `select … where batch_id = $1 and seq > $cursor order by seq limit 500`
  on the **writer** (replica lag would hide the row).
- Frames: `event: hello` (server time, batch, session), `event: items`
  (`{items, cursor}`), `event: batch`, `event: session`, `: ping` every 15 s.
  The server closes each stream after 55 s; the client reconnects at once
  with `after=cursor` (Cloudflare's 100 s idle limit never applies, and a
  buffering proxy degrades to ~55 s long-polling instead of breaking).
- Client (`market/src/scan-stream.js`) upserts rows by `id` and ignores any
  row whose `seq` is not newer than what it holds → duplicates, replays and
  out-of-order frames are harmless. Multiple tabs each hold a stream and
  converge on the same rows.
- Production desktop connects to `https://api.pokoin.com` directly
  (CORS) instead of the Vercel `/api` rewrite, because streaming through
  that rewrite is not verified.
- The API runs as **one** process (`ecosystem.config.cjs instances: 1`).
  Scaling out requires moving the bus to Valkey pub/sub; the cursor protocol
  does not change.

## Phone (`scan.pokoin.com/connect`)

- Keypad `_ _ _ _`; the 4th digit posts immediately. QR opens with the secret
  in the fragment and pairs without typing.
- After pairing: **Connected to Pokoin Dashboard**, then the camera. The top
  line shows the desktop's defaults label (`IT · NM · Box A12`) from the
  heartbeat so the seller can glance at the pile setting; it cannot change it.
- A scan event fires when a card is recognised (or detected but not
  identified for ~1.2 s) and is only re-armed after the card **leaves** the
  frame, so four identical copies are four events.
- Events go to an in-memory + `localStorage` outbox; retries reuse the same
  `scanEventId`. Losing the network never blocks the camera.
- `phoneToken` is kept in `localStorage` so a reload rejoins the session.

## Production topology (verified 2026-09-17 15:00 UTC)

| Piece | Where | Evidence |
| --- | --- | --- |
| Desk SPA | Vercel project `web`; aliases `pokoin.com`, `dashboard.pokoin.com` (+ `onepiece.`, `riftbound.`, …) | `vercel inspect pokoin.com` |
| `dashboard.pokoin.com` DNS | Cloudflare DNS-only CNAME → `00dae56389d2f4d1.vercel-dns-017.com`; Firebase Auth authorized domain | Cloudflare API; identitytoolkit config |
| Oracle API | Pi `pi-home`, Docker `pokoin-oracle-api` (`node server/oracle-api-server.js`, net host, port 18080), bind mount `/srv/pokoin/api/current` → `releases/…`; public via `pokoin-api-edge.service` :18079 and the Cloudflare tunnel | `docker inspect`, `ss -ltnp` |
| API reads | `MARKETPLACE_DATABASE_URL` = `127.0.0.1:5432/pokoin_marketplace` — Pi Docker `pokoin-marketplace-postgres-replica`, **hot standby** (`pg_is_in_recovery() = t`) | container env (names/hosts only), psql |
| API writes (all scan tables) | `MARKETPLACE_WRITER_DATABASE_URL` = `192.168.178.55:25432/pokoin_marketplace` — nezopt Docker `pokoin-marketplace-postgres-15t`, **primary** (`pg_is_in_recovery() = f`) | same |
| Replication | nezopt → Pi, streaming async, slot `pokoin_pi_replica` | `pg_stat_replication`, `pg_stat_wal_receiver` |
| DB role | API connects as `pokoin_marketplace` (owner) for both | env |
| Phone page | Oracle peer1 (`scan.pokoin.com` A 92.5.153.117), Caddy | `/etc/caddy/Caddyfile` |
| Recognition | nezopt `battlescan-fast` 127.0.0.1:8099, reached from peer1 via 127.0.0.1:8100 | `cardscan.pokoin.com/health` → worker `nezopt` |

Scan state is read and written on the **writer** (`_scan_store.js` uses the
writer pool for every query): a stream reading the replica would miss the row
it was just told about. The 6 Sep 2026 note that the Pi became primary is
superseded by this table.

## Production deployment

All from nezopt, in order; each step verifies itself.

```bash
scripts/deploy-scan-connect.sh migrate   # 082 + grants on the primary, waits for the Pi replica
scripts/deploy-scan-connect.sh api       # Pi release = live release + scan files, restart, health, auto-rollback
scripts/deploy-scan-connect.sh scanner   # peer1 backup, files, Caddy /connect rewrite, public check
scripts/deploy-web.sh                    # pokoin-web from origin/main (docs/DEPLOY.md)
```

| Step | What it touches | Rollback |
| --- | --- | --- |
| migrate | `scan_batches`, `scan_sessions`, `scan_pairings`, `scan_rate_limits`, `scan_items`; `marketplace_user_listings.location`, `.altered`, unique index `marketplace_user_listings_scan_row_uidx`. Idempotent (`if not exists`). | Additive; leave in place. |
| api | 13 files: `api/_scan_*.js`, `api/scan-*.js`, `api/marketplace-listings.js`, `server/api-route-manifest.js`, the 082 SQL; `server/api-route-families.js` keeps the live file plus the scan rule only | `scripts/deploy-scan-connect.sh rollback-api` (symlink back to `.scan-connect-previous`) |
| scanner | peer1 `web/index.html`, `web/static/scan-connect.js`, `server/app.py`; Caddy rewrite in the `scan.` and `cardscan.` blocks | `rollback-scanner` (backup in `/opt/pokoin-cardscan/.backups/<stamp>-scan-connect`); Caddy backup `/etc/caddy/Caddyfile.bak-scan-connect-*` |
| web | Vercel production | [DEPLOY.md](DEPLOY.md#commands) |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `dashboard.pokoin.com/scan` shows the public photo scan page | Deployed bundle predates `isDashboardHost` — see DEPLOY.md; `vercel api /v4/aliases/dashboard.pokoin.com` |
| Google sign-in popup fails on `dashboard.` | Firebase Auth authorized domains must list `dashboard.pokoin.com` |
| Phone: "Code not valid or expired" instantly | Code older than 120 s, already used, or QR from another tab after **New code**. Server: `select pin, expires_at from scan_pairings` on the writer |
| Phone: "Too many tries" | `select * from scan_rate_limits where bucket like 'pair%' order by window_start desc` |
| Desk stuck on "Connection lost" | Phone heartbeat not arriving: phone offline or token revoked (`scan_sessions.status`) |
| Rows never appear on the desk | `GET https://api.pokoin.com/api/scan-stream?batchId=…&after=0` with the bearer; `scan_items.seq` vs stream cursor |
| `scan.pokoin.com/connect` 404 | Caddy rewrite missing — `grep "rewrite /connect" /etc/caddy/Caddyfile` on peer1 |
| API 500 on scan routes | `docker logs pokoin-oracle-api` on the Pi; writer reachable from the Pi (`192.168.178.55:25432`) |

## Local development

```bash
# nezopt: throwaway Postgres
docker run -d --name pokoin-scan-test-pg --rm -e POSTGRES_PASSWORD=scantest -e POSTGRES_DB=scantest \
  -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine -c fsync=off
export SCAN_TEST_DATABASE_URL=postgres://postgres:scantest@127.0.0.1:55432/scantest
# CardVault
node --test api/_scan_connect.test.js
node --test --test-concurrency=1 api/scan-connect.integration.test.js
SCAN_DEV_FAKE_AUTH=1 PORT=18990 node scripts/scan-connect-dev-server.js --reset   # scan API + read-only proxy to api.pokoin.com
# pokoin-web (desk + phone page + fake identify, Playwright)
node scripts/scan-connect-e2e.mjs
# BattleScan
node --test scripts/scan-connect.test.cjs && node scripts/scanner-ui.test.cjs web/index.html
```

The dev server's fake auth (`Bearer seller:<uid>`) only exists with
`SCAN_DEV_FAKE_AUTH=1` and refuses `NODE_ENV=production`.

## Files

| Path | Role |
| --- | --- |
| CardVault `oracle-postgres/schema/082_scan_connect.sql` | Tables, trigger, listing columns |
| CardVault `api/_scan_connect.js` | Pure rules: PIN, tokens, classification, snapshot pick, merge key, validation |
| CardVault `api/_scan_store.js` | SQL (writer), transactions, rate limits |
| CardVault `api/_scan_bus.js` | In-process change bus |
| CardVault `api/_scan_http.js` | CORS, auth helpers, client IP |
| CardVault `api/scan-session.js`, `scan-pair.js`, `scan-phone.js`, `scan-batch.js`, `scan-stream.js` | Handlers |
| CardVault `api/_scan_connect.test.js`, `api/scan-connect.integration.test.js` | Tests |
| `market/src/pages/ScanDesk.jsx`, `market/src/scan-*.js`, `market/src/scan-desk.css` | Desktop |
| BattleScan `web/static/scan-connect.js`, `web/index.html`, `server/app.py` (`/connect`) | Phone |
| CardVault `oracle-postgres/schema/082_scan_connect.grants.sql` | Grants for the API writer role |
| CardVault `scripts/scan-connect-dev-server.js` | Local scan API for E2E |
| `scripts/deploy-scan-connect.sh`, `scripts/deploy-web.sh` | Production rollout |
| `scripts/scan-connect-e2e.mjs` | Desk + phone E2E (Playwright, scripted identify) |
