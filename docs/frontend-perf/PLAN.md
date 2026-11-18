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
- [x] C2 Coexistence switch (`scripts/build-ui-shell.mjs`, `solid/owned-routes.json`, canary, CSP hash). Retired with the React UI (see Phase I).
- [x] D1 header + typeahead (parity 10/10 queries), D2 Home rails.
- [x] D3 Search, D4 Card desk + versions merged; smoke parity with React on home, search (singles + product), desk, slugless desk, versions.
- [x] D5 Sets/Expansion/Era/hubs, then collections/listings/cart/checkout/profile: all 65 remaining pages ported (PRs #325–#328).

## Phase E — local-first search
- [ ] Ranking in a worker with a compact name-pool shard (needs a Rust endpoint, see requests).
- [ ] IndexedDB cache for name pool + hot suggest groups, print/language pre-warm.

## Phase F — backend requests (Rust session)
- [x] Requests sent and accepted by the Rust session (Server-Timing + TAO, weak ETag/304 on 9 routes, cold p95 < 300 ms for search-page/expansions, `/api/catalog/names` + `/api/catalog/version`): draft PR feature/cache-sync-engine.

## Phase G/H — parity, regression, rollout
- [x] Playwright parity React vs Solid on every route (integration branch, PRs #325–#328).
- [x] Stage 1 rollout: switch shipped with canary 0 — React stays the default; Solid owns home, search, card desk, versions for visitors who opt in.
- [x] Stage 2 (2026-10-09, Giuseppe: 100% now): `canary` 100 — every visitor gets Solid on the owned routes; explicit `?ui=react` opt-outs and framed pages stay React.

### Rollout and rollback (historical)
- The coexistence switch (`?ui=solid` / `?ui=react`, localStorage `pokoin.ui`, the canary in
  `solid/owned-routes.json`, the `pokoin.ui.once` handoff) is gone with the React UI.
- Rollback is a Cloudflare version rollback (`wrangler versions deploy <previous>@100%`,
  docs/WEB_HOST.md); there is no React build to fall back to.

## Phase I — React removed (2026-10-11)
- [x] The React UI is deleted: `market/src/pages`, `market/src/components`, the root `.jsx`
      files and the React hook modules. `market/` is the framework-free modules the Solid app
      (`@market/*`) and the workers share, with their node tests; React, react-dom,
      react-router-dom, react-easy-crop, @vitejs/plugin-react and Vite left `market/package.json`.
- [x] `scripts/build-web.sh` builds Solid only: `solid/dist` (with `market/public` as its
      publicDir) is `/market/*`, `index.html` is the shell, chunks are `/market/s/*`.
- [x] React leftovers are errors that name where they are:
      `node scripts/react-legacy-report.mjs` (run by `market/src/react-legacy-report.test.js`)
      prints one `[react-legacy] file:line` line per React import, `.jsx` under `market/src`
      or React dependency; the Solid entry reports `?ui=react`, a stored `pokoin.ui` React
      preference or a `pokoin.ui.once` handoff as a `[react-legacy]` client error
      (`solid/src/lib/react-legacy.js`); `bench/crawl-solid.mjs` fails a page on either, or on
      any React chunk.
- [x] The UI guards the React tests held moved to `solid/src/**/*.test.js` (`cd solid && npm test`).

## Measurement notes
- nezopt is shared (load avg 4–16, swap full on 2026-10-09): use CPU-time metrics
  (ScriptDuration, TaskDuration, long tasks) next to wall-clock, and ≥10 samples.
- Mobile profile = 390×844, CPU throttle 4×, no network throttle (isolates CPU).
