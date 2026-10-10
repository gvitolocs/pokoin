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
