# Condition chips (`/conditions/*.svg`)

CardTrader-style grade pills used on shop rows and the listing condition picker.

| File | Grade | Fill |
| --- | --- | --- |
| `nm.svg` | Near Mint (NM) | `#6f8f3a` |
| `sp.svg` | Slightly Played (SP) | `#9bb84a` |
| `mp.svg` | Moderately Played (MP) | `#d4a017` |
| `pl.svg` | Played (PL); CardTrader Heavily Played maps here | `#c45a22` |
| `po.svg` | Poor (PO) — Pokoin red | `#d32f2f` |

Intrinsic size is **40×28** (narrower width than the first 56×28 draft; height stays 28).

Load via `conditionChipSrc(condition)` in `market/src/listing-meta.js` — same `BASE_URL` pattern as `/flags/*.svg`. Do not add extra grade files; legacy EX/LP tones reuse `nm`/`sp` in that helper.
