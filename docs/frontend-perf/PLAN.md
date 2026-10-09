# Frontend performance + Solid 2 migration — execution checklist

Owner: Claude session "Pokoin ultra-low-latency frontend optimization" (2026-10-09).
Worktree: nezopt `~/Projects/pokoin-web-frontend-perf`, branch `feature/frontend-perf`.
Paths owned here: `market/`, `bench/`, `solid/` (new), `docs/frontend-perf/`.
Not owned (Rust API session, `feature/rust-full-api`): `pokoin-rust/`, `deploy/systemd/`,
`scripts/deploy-pokoin-rust.sh`, `scripts/install-pokoin-rust.py`, `scripts/cutover-pi-rust.sh`,
`docs/rust-migration/`, `server/pokoin-api/` removal. Backend changes go to that session as
written requests.

Framework decision (Giuseppe, 2026-10-09): **Solid 2.0** — `solid-js@2.0.0-rc.14`,
`@solidjs/web@2.0.0-rc.14`, `@solidjs/router@2.0.0-next.38`, `vite-plugin-solid@3.0.0-next.27`.
Read `node_modules/solid-js/CHEATSHEET.md` before writing Solid code. The
`solidjs-patterns` skill (omniaura) is a 1.x guide; where it conflicts, 2.0 wins.

## Phase A — inspect and baseline
- [x] Live topology: pokoin.com = Cloudflare Workers Static Assets (`pokoin-web`), API =
      api.pokoin.com (Pi, Rust edge cutover in progress), images = cdn.pokoin.com.
- [x] Entry bundle attribution (`index-*.js` 1.82 MB raw / 498 KB br as served):
      suggest name/set/artist data 537 KB (30%), Firestore + re2js + webchannel ~430 KB (24%),
      react-dom/router/react ~234 KB (13%), Firebase Auth ~100 KB.
- [x] First production probes (Playwright, nezopt Ryzen 5 7600; noisy host, see below).
- [ ] Repeatable benchmark suite in `bench/` (journeys A–J; K/L need a test account).
- [ ] Baselines saved under `bench/results/` with distributions (≥10 runs per cell).

## Phase B — optimise the React app (fair optimised-React baseline)
- [ ] B1 Typeahead ranking: prefix Damerau-Levenshtein + rankNames + compactQuery memo,
      byte-identical results (oracle test). (in progress)
- [ ] B2 Firestore off the entry chunk (auth.jsx, cart-rails.js import it eagerly).
- [ ] B3 Suggest catalog data off the entry chunk (load on idle / search focus).
- [ ] B4 Expansion symbols: stop the `pokoin.com/card-images/…` → cdn.pokoin.com double hop
      (Worker invocation + redirect per symbol; 45 per typed query).
- [ ] B5 Duplicate image requests in the suggest popup (each thumb requested 3×).
- [ ] B6 art-shade canvas sampling (getImageData per image) off the input path.

## Phase C/D — Solid 2 app (`solid/`), critical path first
- [ ] C1 Scaffold: Vite + Solid 2 + router 2, shares `market/src/*.js` pure modules and
      `styles.css`; builds to `dist-web/market-solid/` without touching the React build.
- [ ] C2 Coexistence switch: one HTML boot script picks React or Solid entry
      (`?ui=solid` / localStorage flag, optional % canary); URLs unchanged.
- [ ] D1 Chrome (header, search, typeahead), D2 Home, D3 Search, D4 Card desk,
      D5 Back navigation + scroll restore, D6 Sets/Expansion, then collections/listings.

## Phase E — local-first search
- [ ] Ranking in a worker with a compact name-pool shard (needs a Rust endpoint, see requests).
- [ ] IndexedDB cache for name pool + hot suggest groups, print/language pre-warm.

## Phase F — backend requests (Rust session)
- [ ] ETag + Cache-Control/SWR on public reads, Server-Timing (edge/app/db), compact
      catalog/name-pool shard endpoint. Send with measured targets.

## Phase G/H — parity, regression, rollout
- [ ] Playwright parity tests React vs Solid on the migrated routes.
- [ ] Release gates + canary + rollback (Cloudflare versions; React entry stays default).

## Measurement notes
- nezopt is shared (load avg 4–16, swap full on 2026-10-09): use CPU-time metrics
  (ScriptDuration, TaskDuration, long tasks) next to wall-clock, and ≥10 samples.
- Mobile profile = 390×844, CPU throttle 4×, no network throttle (isolates CPU).
