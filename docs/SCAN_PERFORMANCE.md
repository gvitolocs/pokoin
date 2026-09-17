# Scan Connect performance

Measured, not estimated. Every number below comes from a script in this repo
that you can re-run; each table says which one, with how many samples and on
which day. Where something was not measured it says **UNKNOWN** rather than a
guess. Design: [SCAN_CONNECT.md](SCAN_CONNECT.md).

## The budget

One scanned card becomes a row on the desk in three hops:

| Hop | What happens | Measured p50 | Measured p95 |
| --- | --- | --- | --- |
| Capture → answer | phone encodes a ≤960 px JPEG and calls `/identify` on `scan.pokoin.com` | **140 ms** | **218 ms** |
| Answer → stored | phone `POST /api/scan-phone?action=scan`, row written to Postgres | **5 ms** (loopback) | **6 ms** |
| Stored → on screen | change lands on the desktop's open SSE stream | **6 ms** (loopback) | **7 ms** |

The phone re-arms only after the card leaves the frame, so the practical
ceiling is how fast a human moves cards, not the pipeline: at the phone's
280 ms capture cadence a scan is answered well before the next frame.

## Recognition latency

`node scripts/scan-connect-bench-identify.mjs <base> <count>` — six real card
photos (slab, toploader, IT/FR prints, holo) re-encoded exactly as the phone
does (≤960 px, JPEG q0.72, `live=1`, `top_k=3`, `catalog=pokemon_generic`),
one request at a time at the phone's 280 ms cadence so a real seller is never
pushed into `busy`.

2026-09-17, service `battlescan-fast` on nezopt (`worker: nezopt` in every
response):

| Path | n | Round trip p50 / p95 / max | Server detect p50 | Server identify p50 | busy | errors |
| --- | --- | --- | --- | --- | --- | --- |
| `https://scan.pokoin.com` (real phone path: Oracle peer1 Caddy → tunnel :8100 → nezopt) | 30 | **140 / 218 / 262 ms** | 21.4 ms | 56.8 ms | 0 | 0 |
| `http://127.0.0.1:8099` (service directly, no network) | 40 | **84 / 93 / 94 ms** | 21.8 ms | 56.8 ms | 1 | 0 |

So the model costs ~78 ms (detect 21 + identify 57, p95 within 3 ms of the
median — the global lock keeps it flat), the local loopback adds ~6 ms, and
the public hop (peer1 → SSH tunnel → nezopt and back) adds ~56 ms at the
median and ~125 ms at p95. JPEG encoding on the bench host is 8 ms per frame;
on a phone it is part of the 280 ms cadence and is not on this path.

The one `busy` in 40 is the service's global lock answering while another
request held it — the phone treats `busy` as "no answer yet" and keeps
scanning, so it never reaches the seller.

## Delivery latency (phone POST → row on the desk)

`SCAN_TEST_DATABASE_URL=… node scripts/scan-connect-bench-delivery.mjs <count>` —
real `scan-phone` / `scan-stream` handlers against a throwaway Postgres, a
real SSE stream open on the desktop side, 150 scan events at the phone's
280 ms cadence, cycling MATCHED / AMBIGUOUS / UNMATCHED recognitions.

2026-09-17, 150 events, 150 delivered, 0 errors (50 matched, 50 ambiguous, 50
unmatched):

| Measure | p50 | p95 | max |
| --- | --- | --- | --- |
| `POST …action=scan` round trip (parse, rate limit, card lookup, insert, notify) | **5 ms** | 6 ms | 16 ms |
| Phone POST → the row arriving on the desktop's SSE stream | **6 ms** | 7 ms | 17 ms |

Delivery is ~1 ms behind the write because the in-process bus wakes the
stream's pump as soon as the transaction commits, instead of polling. The
5 s presence tick and the 15 s ping never gate a scan.

These numbers are loopback + a local Postgres: they measure the handlers and
the stream, not the seller's WAN. Add one internet round trip
(phone → Cloudflare → Pi) for the real path, which the identify table above
puts at ~56 ms median from a wired host.

## Desk interaction

From the browser E2E (`scripts/scan-connect-e2e.mjs`, 18/18 on 2026-09-17),
wall-clock per step including Playwright's own overhead — an upper bound on
what the seller feels:

| Action | Measured |
| --- | --- |
| `Alt+2` resolves an ambiguous printing | 52 ms |
| Finish + quantity (`i`, `+`) | 81 ms |
| `?` opens the shortcut overlay, `Esc` closes it | 59 ms |
| `Shift+G` / `Shift+A` change a Batch Default (and re-render the queue) | 261 / 2866 ms* |
| Fill prices, `Ctrl+Enter`, `Enter` → 4 articles in inventory | 231 ms |
| Desktop refresh keeps the batch; phone reload keeps the pairing | 629 ms |

\* the `Shift+A` step also waits for the three existing rows to prove they
stayed Italian, so most of those 2.9 s is the assertion's own polling, not the
keypress.

## Capacity and limits

| Limit | Value | Where |
| --- | --- | --- |
| Scans per session | 1200 per 10 min | `LIMITS.scanPerSession`, `api/_scan_connect.js` |
| Rows per batch | 10 000 | `MAX_BATCH_ROWS`, `api/_scan_store.js` |
| Stream lifetime | 55 s, then `bye` + resume from cursor | `SCAN_STREAM_MS`, `api/scan-stream.js` |
| Stream replay page | 500 items | `PAGE`, `api/scan-stream.js` |
| Pairing TTL | ~2 min, single use | `PAIRING_TTL_MS`, `api/_scan_store.js` |

1200 scans per 10 minutes is two scans per second sustained — roughly four
times what a fast human hand does — and it is the abuse ceiling, not a target.

## Not measured (UNKNOWN)

- Real camera capture on a phone: frame rate, autofocus time and encode time
  on a mid-range Android. The bench re-encodes stored photos instead.
- Mobile-data latency (4G/5G) from a phone to `scan.pokoin.com`. Both identify
  runs were from a wired host.
- Production Postgres write latency for scan rows: the delivery bench uses a
  throwaway database, and the production primary is not load-tested from here.
- Recognition *accuracy* on a live pile. This page is latency only; the
  candidate scores in the bench output are incidental.
