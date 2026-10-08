# Card recognition API (Pi)

One public API for recognizing cards from a photo, used by the website
(pokoin.com/cardscan), Scan Connect (scan.pokoin.com) and the app.

| Route | What |
| --- | --- |
| `POST /api/scan/identify?catalog=&top_k=&live=&multi=&album=` | multipart field `file` (≤ 4 MB) → matches |
| `POST /api/scan/identify-album` | multipart `file` repeated (album page) |
| `GET /api/scan/print?ids=&wait_ms=` | print strip (collector/language OCR), second pass |
| `GET /api/scan/catalogs` | recognition catalogs (game × language) |
| `GET /api/scan/health` | which workers answer |

## Print strip second pass

Ambiguous identify results (2+ printings within 0.06 of top1, score ≥ 0.60)
carry a `print_id` per card. The worker OCRs the bottom strip on a dedicated
one-thread pool **after** the identify response is sent, so identify latency
no longer pays the ~80 ms CPU read.

- `GET /api/scan/print?ids=<print_id>[,<print_id>…]&wait_ms=400` blocks up to
  `wait_ms` (0–3000, default 400) for the results.
- Response: `{prints: {id: {collector, language, set_code, …} | null}, pending: [id], unknown: [id]}`.
  Poll with the `pending` ids until they clear; `unknown` ids are gone
  (180 s TTL or another worker).
- All `print_id`s are unknown → 404. No worker answers → 503.
- The print store is per worker process: an identify answered by nezopt's
  worker must be polled against the same worker, so the API pins the poll to
  the same nezopt-first fallback chain.

Clients that take a base URL use `https://api.pokoin.com/api/scan` (the
scanner page's `window.CARDSCAN_API`: it appends `/identify` and derives
`/catalogs`).

## Where the work runs

```
client → api.pokoin.com (Pi, pokoin-oracle-api) ─┬─ nezopt GPU worker  127.0.0.1:18151 → nezopt :8099   ~0.2 s
                                                 └─ Pi CPU worker     127.0.0.1:18150 (pokoin-scan)    ~2–4 s
```

- `server/pokoin-api/scan-identify.js` forwards the upload unchanged to
  nezopt first; on a connection error, a 5xx or a 6 s timeout it answers
  from the Pi's own worker and skips nezopt for 15 s. Responses carry
  `X-Scan-Worker: nezopt|pi`. The client IP goes out as `X-Forwarded-For`
  so the worker's 30/min per-IP limit still applies.
- **nezopt worker**: `battlescan-fast.service` (ROCm, `CARDSCAN_MODELS`,
  `CARDSCAN_CATALOGS`), reached through `pokoin-scan-pi-tunnel.service`
  (`ssh -R 127.0.0.1:18151:127.0.0.1:8099 pi-home`).
- **Pi worker**: container `pokoin-scan` built from `server/scan/` (the
  recognition service: YOLO detect + Milo CNN embed, CPU, 2 cores), with
  the same models/catalogs as nezopt mounted from `/srv/pokoin/scan`.
- Under heavy load the API edge may send GETs to the nezopt k3s overflow,
  which has no workers: `/api/scan/catalogs` can then 503 briefly. POSTs
  always stay on the Pi.

`server/scan/` is the source of truth for the recognition service; the
BattleScan checkout on nezopt still runs the same code for the GPU worker.

## Deploy

```bash
scripts/deploy-scan-api.sh <origin/main commit>   # run on nezopt
```

It builds/restarts `pokoin-scan` on the Pi (same galleries as the running
nezopt worker), installs the tunnel unit, adds the four routes to the Pi
API release, and rolls the API back unless `/api/scan/health` shows both
workers up.
