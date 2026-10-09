# Recognition moved to pokoin-scanner

The worker, Pi fallback, models/catalog tooling, phone web assets and tests
are owned by `/home/nez/Projects/pokoin-scanner` (`service/`).

Applications call `https://api.pokoin.com/api/scan`. This repository keeps the
shared native Rust Pi gateway under `pokoin-rust/crates/external/src/scan.rs`
and `routes/scan.rs`, plus marketplace/scan-session domain APIs.

Read `docs/SCAN_API.md`; do not restore a second recognition worker here.
