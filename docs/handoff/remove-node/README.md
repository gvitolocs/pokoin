# Handoff: remove the Node backend

Saved from the nezopt session "Remove the Node backend from the repo" (stopped 2026-10-09 to move the work to a cloud session). No files were edited.

## Inventory so far
- **Delete (retired Pi runtime):**
  - `server/pokoin-api`, `server/api`, `server/server`
  - the Node edge and CDN, including the Oracle CDN unit
  - the three retired Node timers
  - the `deploy-*-api.sh` overlays
- **Keep:**
  - the market/ build
  - `workers/`
  - `server/scan` (the Python worker and phone UI)
  - the nezopt and Oracle data pipelines
  - `scripts/cutover-pi-rust.sh`
- **To decide:**
  - the k3s overflow (being moved to Rust by the coordinator)
  - the Pi web origin
  - the Oracle `cardtrader-oracle-api`
  - the installer that reads env from the stopped container

## Remaining steps it had identified
- Delete the Node files. Fix the market tests that read `server/` files by pointing them at the Rust constants and fixtures (e.g. `market/src/silver.test.js`).
- Point `sync-shipping-rates.py` at the Rust shipping-rates asset.
- Rewrite `deploy-pokoin-pi-watchdog.sh` and `install-pokoin-pi-watchdog.sh` without the Node units.
- Update the docs and write `docs/rust-migration/NODE_REMAINING.md`.

## Production bug found (already mitigated)
Rust `/api/unlock-silver` read `SILVER_PRICE_PKN` with a fallback of 20 PKN (`pokoin-rust/crates/commerce/src/config.rs`). Node and the SPA charge 100 PKN, set in #136 on 2026-09-29. The Pi env lacked the variable. The coordinator set `SILVER_PRICE_PKN=100` on the Pi at about 16:00 UTC; no Silver purchase happened at 20. The code default still has to change to 100, with a test pinning it.

## Note
Its `cargo test` baseline failure ("could not parse/generate dep info") was caused by its worktree being removed mid-build, not by a broken main.

## Task (continue from here)
Repository gvitolocs/pokoin. Production now runs only native Rust. The Pi unit deploy/systemd/pokoin-rust-api.service serves:
- the API on :18082
- the edge on :18079
- the CDN on :18081
- ct-deals on :18090

The jobs run from deploy/systemd/pokoin-rust-job@.service. Retired:
- the Node edge (scripts/pokoin-api-edge.js)
- the Node CDN server
- the ct-deals Node server
- the pokoin-oracle-api container (server/pokoin-api, server/oracle-api-server.js, and the server/api modules they load)
- the Node timer jobs

Goal: remove the retired Node backend from the repo. Keep scripts/cutover-pi-rust.sh: its --rollback only re-enables units already installed on the Pi.

1. Build an inventory with `git grep` of every Node backend artifact and every reference to it. Cover requires, deploy scripts (scripts/deploy-*-api.sh, deploy-pokoin-api-edge.sh, run-cardtrader-*-docker.sh), infra/k3s manifests, docs, AGENTS.md, CI and package.json scripts. Classify each item:
   - (a) retired Pi API/edge/CDN/ct-deals/jobs: delete;
   - (b) still used elsewhere: keep. Examples: the market/ SPA build tooling (Vite/npm is a frontend build, not a backend); data pipeline scripts run on nezopt or Oracle; workers/ Cloudflare workers;
   - (c) unsure: keep and list.
2. Delete the (a) items and fix every reference. If a test or doc still needs reference material, move it into docs/rust-migration/.
3. Update the docs to the Rust-only topology: the AGENTS.md ownership table, docs/API.md, docs/RUST_RUNTIME.md (create it if missing), docs/WEB_HOST.md, docs/NEZOPT_OVERFLOW.md and docs/SECURITY_HARDENING.md, wherever they describe Node :18080, the Node edge or Node jobs.
   The nezopt k3s overflow is being switched to the Rust x86 binary by the coordinator in parallel. Leave infra/k3s and scripts/nezopt-k3s.sh to them.
4. Write docs/rust-migration/NODE_REMAINING.md, listing the remaining Node usages (b)/(c), with a proposed Rust replacement for each backend runtime item.

Verify: `cd pokoin-rust && cargo test --workspace` passes, the market tests pass, and `git grep` finds no dangling references to deleted paths.

Work on branch `chore/remove-node-backend`. End commit messages with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". Open a DRAFT PR containing the inventory table, with a body ending "🤖 Generated with [Claude Code](https://claude.com/claude-code)".

Do NOT merge or deploy.
