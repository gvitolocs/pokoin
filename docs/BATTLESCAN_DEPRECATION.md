# BattleScan — deprecated

**Status (2026-09-30): deprecated, not yet removable.** New recognition work goes
into pokoin-web: the public API is `api.pokoin.com/api/scan/*` on the Pi
([SCAN_API.md](SCAN_API.md)) and the recognition service source is
`server/scan/`. BattleScan (`/home/nez/Projects/BattleScan`, GitHub
`gvitolocs/pokoin-cardapp`) must not receive new features. It can be switched
off only after the blockers below are cleared, in the order given.

## What BattleScan was

A research repo that grew into production:

- the recognition engine (YOLO card detector + Milo 128-d embedder + per-game
  galleries), served by FastAPI `server/app.py`;
- the phone scanner page (`web/index.html` + `web/static/scan-connect.js`)
  used for pokoin.com/cardscan and Scan Connect (scan.pokoin.com/connect);
- an Android on-device prototype (`android/`) and benchmarks.

Only **50 files** are in git (android, notes, some scripts, `scan-connect.js`).
The production pieces — `server/`, `deploy/`, `docs/`, gallery export scripts,
`web/index.html`, `runtime/` models and galleries — exist **only on nezopt's
disk** (8.4 GB checkout, 5.7 GB of it the Python venv).

## Inventory (what still depends on it)

| Piece | Where | Still used? | Replacement | Blocks removal |
| --- | --- | --- | --- | --- |
| GPU recognition worker `battlescan-fast.service` (:8099) | nezopt, runs from `BattleScan/.venv` + `server/` + `runtime/{fast-models-cnn,catalogs-cnn-v22,ort-rocm}` | **Yes** — primary worker behind the Pi API (~890 identifies / 7 days) | Same service run from pokoin-web `server/scan/` with its own venv and a runtime dir outside BattleScan | **Yes** |
| Pi → nezopt tunnel `pokoin-scan-pi-tunnel.service` | nezopt | Yes (new) | — (stays) | no |
| Pi CPU fallback `pokoin-scan` | Pi container from `server/scan/` | Yes (new) | — | no |
| Old tunnel `battlescan-fast-tunnel.service` → peer1 :8100 | nezopt → oracle-peer1 | **Yes** — the app (cardscan.pokoin.com) still goes peer1 → tunnel → nezopt | App calls the Pi API | Yes, until the app release |
| `nezopt-cardscan.service` (`cdn_app`, :8098) | nezopt | **No** — 0 requests in 7 days, no tunnel | — | no, can stop now |
| Phone page (scan.pokoin.com, cardscan.pokoin.com) | oracle-peer1 `/opt/pokoin-cardscan/web` (Caddy static), source on BattleScan branch `feature/scan-printing-picker` (e2ce5d0) | **Yes** | Serve from pokoin-web (e.g. pokoin.com/connect) — a pokoin-web `scan-printing-picker` worktree started this move but never committed it | **Yes** |
| peer1 `/opt/pokoin-cardscan/{server,models,catalogs}` (≈660 MB) | oracle-peer1 | **No** — no Python service runs there; Caddy only serves `web/` | — | no, can delete after a backup |
| Gallery build (`scripts/export_cnn_v22_catalogs.py`, `export_catalogs.py`, `export_singles_catalogs.py`, `catalog-metadata.cjs`) | BattleScan, **untracked**; inputs in `~/Projects/pokoin/PokoinTest/index/cdn_cnn_v22_*` | Yes, whenever galleries are refreshed | Move to pokoin-web `scripts/scan/` | **Yes** |
| Website pokoin.com/cardscan | pokoin-web | Uses the Pi API since #145 | — | no |
| CardVault app `card_scan_service.dart` | cardvault | **Yes** — `cardscan.pokoin.com` | `https://api.pokoin.com/api/scan/identify` in the next app release | **Yes** |
| Chrome extension on-device scan | pokemon-card-extension `scan/models/*` (30 MB, bundled) | No runtime calls to BattleScan (locked D000035: fully local). **Build-time** copy by `scripts/bundle-ondevice-scan.py` from `BattleScan/{models,catalogs,runtime/fast-models}` — an older gallery than the servers use | Bundle from the same models/galleries as the Pi API | **Yes** (for rebuilds) |
| CLIP version-set pipeline (`cluster-name-version-sets.py`, `artwork-lang-pipeline.py`, `espurr-artbox.py`) | pokemon-card-extension scripts | Yes — read `BattleScan/runtime/catalogs-20260903-jp-reference` | Move that catalog to a shared data dir | **Yes** |
| pokoin-web `sample-leftover-art-shade.py`, `export-leftover-artcut.py` | pokoin-web scripts | Use `BattleScan/.venv/bin/python` as interpreter | Own venv / `server/scan` venv | Yes (small) |
| `scripts/deploy-scan-connect.sh scanner` | pokoin-web | Copies the **BattleScan working tree** (`web/`) to peer1 | Deploy the phone page from a commit (or from pokoin-web once moved) | **Hazard now** — this is how the 2026-09-21 regression happened |
| `scripts/deploy-scan-connect.sh api` | pokoin-web | Ships CardVault's `marketplace-listings.js` / `marketplace-orders.js` whole to the Pi | pokoin-web `server/pokoin-api` deploy scripts | **Hazard now** — would overwrite newer pokoin-web handlers (e.g. PKN opt-out) |
| Codevira decisions D00005U, D00005V, D000061, D000066, D000067 | pokoin-web memory | Point at BattleScan paths | Re-record against `server/scan/` once moved; D00005V (Oracle tunnel) is superseded by the Pi API | no |

## Can it be deprecated safely?

**Not yet.** Deleting or stopping BattleScan today would break:

1. card recognition quality — the Pi API would lose the nezopt GPU worker and
   answer every scan from the Pi CPU (~3 s instead of ~0.3 s);
2. the phone scanner page (only copy of its source is a BattleScan branch);
3. the app's scanner (still on cardscan.pokoin.com → peer1 → nezopt);
4. gallery refreshes, extension bundle rebuilds and the CLIP versions pipeline;
5. and the untracked production code would be lost with no copy in git.

It **is** safe once these are done, in this order:

| Step | Change | Verify | Rollback |
| --- | --- | --- | --- |
| 0 | **Preserve**: commit the untracked `server/`, `deploy/`, `docs/`, gallery scripts, `web/index.html` to a BattleScan `archive/2026-09-30` branch (no models/venv) | branch on GitHub | — |
| 1 | Stop `nezopt-cardscan.service` (unused) | `/api/scan/health` still ok | `systemctl --user start` |
| 2 | Guard `deploy-scan-connect.sh`: `scanner` deploys only from a git commit; `api` stops shipping marketplace-listings/orders | dry run | revert commit |
| 3 | Run the GPU worker from pokoin-web `server/scan/` (own venv + ROCm ORT) with runtime in `~/pokoin-scan-runtime/` | `/api/scan/health`, identify `X-Scan-Worker: nezopt` | point the unit back at BattleScan |
| 4 | Move gallery export scripts to pokoin-web `scripts/scan/`; bundle the extension and the CLIP pipeline from the shared runtime dir | rebuild one gallery, bundle diff | old paths still on disk |
| 5 | Move the phone page into pokoin-web and serve it from pokoin.com (keep scan.pokoin.com as a redirect) | pair a phone, printing buttons, stack flash | Caddy back to static files |
| 6 | App release with `api.pokoin.com/api/scan/identify` | app scan works; peer1 :8100 traffic → 0 | old builds still work until 7 |
| 7 | Retire `battlescan-fast-tunnel.service`, peer1 Caddy recognition routes and `/opt/pokoin-cardscan` | no 8100 traffic for 7 days | re-enable unit |
| 8 | Archive the BattleScan GitHub repo (read-only); keep the nezopt checkout for 30 days, then delete it (frees ~8 GB) | — | restore from archive branch |

## Known issue found while auditing

The recognition worker limits each client IP to **30 identifies a minute**.
Live scanning sends several frames a second, and the nezopt log shows ~550
`429 Too Many Requests` answers to live `pokemon_generic` scans in 7 days —
scans that silently fail and feel like "the card is not recognized". Raise the
limit for `live=1` (or key it on the Scan Connect session) before blaming the
model.
