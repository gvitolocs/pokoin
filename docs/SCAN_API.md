# Pi recognition API boundary

Recognition source and deployment now belong to **pokoin-scanner** at
`/home/nez/Projects/pokoin-scanner`; Mac mount:
`/Users/giuseppe/mnt/nezopt/Projects/pokoin-scanner`.

The public base URL stays **https://api.pokoin.com/api/scan**.

| Route | Role |
| --- | --- |
| POST `/identify` | multipart card photo |
| POST `/identify-album` | repeated multipart photos |
| GET `/print` | asynchronous printing/OCR results (`ids`, `wait_ms`) |
| GET `/catalogs` | supported game/language catalogs |
| GET `/health` | GPU and CPU worker reachability |

This repository owns the native Rust shared API gateway:
`pokoin-rust/crates/external/src/scan.rs` and `routes/scan.rs`. It forwards
unchanged uploads to the nezopt GPU worker through the Pi SSH loopback tunnel
(`127.0.0.1:18151` → nezopt `:8099`), then falls back to the Pi CPU container
(`127.0.0.1:18150`). Responses preserve worker JSON and `X-Scan-Worker`.
The Pi shared API currently listens on `127.0.0.1:18082`; the former Node
container/port 18080 is retired. Do not restart it for scanner deployment.

The recognition models, catalog builders, worker code, standalone phone web
assets, tests and deployment scripts are in pokoin-scanner. Its
`deploy/paths.json` registers runtime/storage and `deploy/deploy.py` ships
exact scanner commits with artifact verification and rollback. Worker and
phone deployments do not redeploy/restart the shared Rust API.

Pokoin Web, CardRail and CardVault use this contract. Marketplace/scan-session
state, inventory and commerce stay in their domain repositories. Native
on-device adapters consume versioned exports or use the Pi API.

Legacy worker deployment scripts delegate to pokoin-scanner. Their revision
argument is a **scanner commit**, not a Pokoin Web commit. API-only changes
use this repository's native Rust deployment procedure.

Phone diagnostics (`scan-diag-v2`) are **not ported to Rust**: the native
`scan-phone` heartbeat neither logs nor acknowledges them, so the phone shows
**Logs unavailable**. The Node handler and its cross-repository protocol test
were removed with the Node backend; the port is listed in
[rust-migration/NODE_REMAINING.md](rust-migration/NODE_REMAINING.md).

## Web scanner (pokoin.com/scan)

`solid/src/pages/Scan.jsx` (also `/cardscan`, `/scancard`) is the browser
counterpart of the `scan.pokoin.com` phone scanner: live camera identify,
Single/Multi, flash, camera choice, photo upload / drop / paste, and every
game in `GET /catalogs`. It sends the same requests as the phone page
(`live=1`, `top_k` 3/8 live and 5 for a photo, 960 px live frames and
1280 px photos, JPEG 0.72, tilt-corrected) and accepts matches at the same
scores. The rules live in `market/src/scan-live.js`, ported from
`pokoin-scanner/service/web/index.html`; change both together until
`scan.pokoin.com/` points at `pokoin.com/scan`. Scan Connect pairing stays on
`scan.pokoin.com/connect`.
