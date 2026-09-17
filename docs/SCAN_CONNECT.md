# Scan Connect (desktop ↔ phone pairing and realtime)

A seller opens **Scan** on `pokoin.com/inventory/scan`, types a 4-digit code
on the phone at `scan.pokoin.com/connect`, and every card the phone
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
| Desktop | `pokoin.com/inventory/scan` (SPA, `market/src/pages/ScanDesk.jsx`) | Seller tools already live under `/inventory`; `/scan` stays the public photo identify page. |
| Phone | `scan.pokoin.com/connect` (BattleScan FastAPI serves the same `web/index.html`; `web/static/scan-connect.js` switches to connect mode) | Reuses the tuned camera loop, detection and orientation fixes. `scan.pokoin.com/` keeps redirecting accepted scans to the card page. |
| QR | `https://scan.pokoin.com/connect#k=<secret>` | Fragment is never sent to a server log. |

## API (CardVault, registered in `server/api-route-manifest.js`, family `scan`)

| Method + path | Caller / auth | Does |
| --- | --- | --- |
| `POST /api/scan-session?action=start` `{batchId?}` | desktop, Firebase bearer | Resume the seller's newest open batch (or `batchId`), end older live sessions of that batch (`replaced`), create session + pairing. Returns `{session, batch, pairing:{pin, qrSecret, expiresAt}}`. |
| `POST /api/scan-session?action=pairing` `{sessionId}` | desktop | Regenerate: old PIN deleted in the same transaction. |
| `POST /api/scan-session?action=disconnect` `{sessionId}` | desktop | Revoke the phone credential; session back to `waiting`. |
| `POST /api/scan-session?action=pause` `{sessionId, paused}` | desktop | Phone scans are rejected with `paused` (phone shows it). |
| `POST /api/scan-session?action=end` `{sessionId, reason}` | desktop | `completed` or `logout`. Batch untouched. |
| `GET /api/scan-session?sessionId=` | desktop | Session state. |
| `POST /api/scan-pair` `{pin}` or `{qr}` + `{device}` | phone, **public** | Claim a pairing. Returns `{phoneToken, sessionId, serverTime, label:'Pokoin Dashboard'}`. Same `400 {"error":"Code not valid or expired."}` for wrong, expired and used codes. |
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
2. Pairing also gets `qrSecret` (24 random bytes, base64url); only its
   SHA-256 is stored.
3. Phone posts the PIN. In one transaction: rate-limit check →
   `delete from scan_pairings where pin = $1 and expires_at > now() returning session_id`
   (the delete **is** the single-use claim; two phones racing on one PIN →
   exactly one row returned) → session must be `waiting` and belong to a live
   batch → store `sha256(phoneToken)`, `status = 'connected'`.
4. `phoneToken` = 32 random bytes (base64url). It is the only phone
   credential. It is scoped to that session: post scans, heartbeat, leave.
   It cannot read batch contents, listings, account data, or other sessions.

### Security protections

| Threat | Protection |
| --- | --- |
| PIN is a secret | It is not: it only selects a pairing for 120 s. The credential is the 256-bit `phoneToken`. |
| Guessing a PIN | Postgres-backed fixed windows (`scan_rate_limits`, fails **closed**): 8 failed claims / IP / 10 min, 30 claims / IP / 10 min, 300 failed claims **globally** / 10 min (then 429 for everyone for the rest of the window). With *k* live pairings a guess hits with probability *k*/10,000: one IP (8 guesses) against 20 live codes ≈ 1.6 % per 10 min. Distributed attacks are bounded by the global cap (arithmetic below). |
| What a lucky guess gets | The ability to add scan rows to one staged batch until the seller notices. The desktop shows the device label and a **Disconnect** button; the real phone's claim fails ("code not valid") which prompts **Regenerate**. No listing is created without the desktop submitting. No read access. |
| Account enumeration | Pair response never includes seller name/uid; identical error for wrong / expired / used. |
| Session creation spam | 12 `start`s / seller / 10 min; 30 regenerations / session / 10 min. |
| Replay of a pairing | Row is deleted on claim; QR secret likewise. |
| Stolen phone token | Dies with disconnect, Done, logout, 30 min inactivity. Stored hashed. |
| Seller signs out | SPA calls `end` with `logout` before `signOut`. |
| Another account in the tab | Every desktop call checks `seller_uid = token uid` → 404; the SPA drops scan state when the uid changes. |
| Cross-site calls | CORS allowlist per handler: `https://pokoin.com`, `https://scan.pokoin.com`, `https://cardscan.pokoin.com`, plus `http://localhost:*` / `127.0.0.1:*` outside production. Phone uses `Authorization: Scan …`, never cookies. |
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
