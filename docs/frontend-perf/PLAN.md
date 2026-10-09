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
- [x] Repeatable benchmark suite in `bench/` (journeys A–J; K/L need a test account) + `interleave.sh`/`merge.mjs`.
- [x] Baselines and comparisons in `docs/frontend-perf/RESULTS.md` (ab1: 6 runs/cell, ab2: 3 runs/cell; more runs on a quiet host still to do).

## Phase B — optimise the React app (fair optimised-React baseline)
- [x] B1 Typeahead ranking: byte-identical (35,604-query oracle vs the original module, 0 diffs), 18.5× faster in Node.
- [x] B2 Firestore off the entry chunk (cloud/fp-decouple, merged).
- [x] B3 (Solid) engine off the entry, evaluated on search intent, chunks prefetched. React: spec queued for Qwen (`useSuggestEngine`).
- [x] B4 Expansion symbols load cdn.pokoin.com directly (no 301 per symbol).
- [ ] B5 Duplicate image requests in the suggest popup — the bench counts real downloads; verify on the next run.
- [ ] B6 art-shade canvas sampling (getImageData per image) off the input path.
- [x] B7 No idle rank workers on mount (up to 8 catalog copies per page load); card-url-boot prefetches the exact desk URL; Home CLS (rails unmounting, short skeletons); era-match memo; shared Intl.Collator.
- [ ] B8 (Qwen, in progress) formatPknNumber formatter cache, compactQuery ASCII path, rail controls from ResizeObserver, idle home-cache writes.

## Phase C/D — Solid 2 app (`solid/`), critical path first
- [x] C1 Scaffold: Vite 8 + Solid 2 rc.14 + router 2, shares `market/src` via `@market`, React guard, chunks in `/market/s/`.
- [x] C2 Coexistence switch (`scripts/build-ui-shell.mjs`, off unless `POKOIN_UI_SWITCH=1`; canary `POKOIN_UI_CANARY`; CSP hash; e2e verified).
- [x] D1 header + typeahead (parity 10/10 queries), D2 Home rails.
- [ ] D1/D2 parity extras, D3 Search, D4 Card desk + versions: cloud sessions (`cloud/solid-chrome-home`, `cloud/solid-search`, `cloud/solid-card-desk`), to merge.
- [ ] D5 Sets/Expansion/Era/hubs, then collections/listings/cart/checkout/profile.

## Phase E — local-first search
- [ ] Ranking in a worker with a compact name-pool shard (needs a Rust endpoint, see requests).
- [ ] IndexedDB cache for name pool + hot suggest groups, print/language pre-warm.

## Phase F — backend requests (Rust session)
- [x] Requests sent and accepted by the Rust session (Server-Timing + TAO, weak ETag/304 on 9 routes, cold p95 < 300 ms for search-page/expansions, `/api/catalog/names` + `/api/catalog/version`): draft PR feature/cache-sync-engine.

## Phase G/H — parity, regression, rollout
- [ ] Playwright parity tests React vs Solid on the migrated routes.
- [ ] Release gates + canary + rollback (Cloudflare versions; React entry stays default).

## Measurement notes
- nezopt is shared (load avg 4–16, swap full on 2026-10-09): use CPU-time metrics
  (ScriptDuration, TaskDuration, long tasks) next to wall-clock, and ≥10 samples.
- Mobile profile = 390×844, CPU throttle 4×, no network throttle (isolates CPU).
