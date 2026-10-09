# Frontend performance results

Measured values only. Every number below comes from `bench/` (Playwright + CDP)
against production-shaped local previews (`solid/scripts/preview.mjs`), all
three builds served the same way and calling the live `api.pokoin.com`.

## Run ab1 — 2026-10-09 16:10–16:45 UTC

- Builds: **baseline** = React at origin/main 5243700 (built from `git archive`);
  **optimised React** = feature/frontend-perf 0eb9575 market/; **Solid** = feature/frontend-perf 0eb9575 solid/.
- Host: nezopt (Ryzen 5 7600, 12 threads), shared with other workloads (load
  average 7–13 during the run). Runs interleaved per round (`bench/interleave.sh`),
  6 runs per build per profile, fresh browser context per run.
- Profiles: mobile = 390×844, CPU throttle ×4, no network throttle; desktop = 1440×900.
- `inp` = worst interaction of the journey (Event Timing). `keys.toRowsMs` =
  keystroke → first change of the visible suggestion rows (pooled over keystrokes).
- Caveats: Solid Home had no PromoCarousel yet (fewer bytes, different LCP
  element), so cold-load bytes/LCP are not a like-for-like comparison. Card,
  back, scroll and checkout journeys were not run (Solid desk/search pages not
  merged yet). Server RAM/CPU not measured here (the Rust session owns the API).

### mobile

| journey | metric | baseline p50 / p95 | optimised React p50 / p95 | Solid p50 / p95 |
|---|---|---|---|---|
| cold | vitals.fcp | 1414 / 3531 | 1008 / 1096 | 458 / 640 |
| cold | vitals.lcp | 2678 / 4696 | 2038 / 2301 | 1386 / 1459 |
| cold | vitals.cls | 0.049 / 0.487 | 0.049 / 0.049 | 0 / 0 |
| cold | tbt | 107.5 / 638.5 | 108.5 / 180.25 | 493.5 / 653.25 |
| cold | cpu.scriptMs | 1488.2 / 2597.95 | 1267.65 / 1336 | 872.7 / 1106.025 |
| cold | mem.heapPeakMB | 31.5 / 32.475 | 31.45 / 32.2 | 26.85 / 27.3 |
| cold | net.bytes | 4278861 / 4892057 | 2851517 / 4276727.75 | 788363.5 / 805237.25 |
| cold | net.downloads | 58 / 69 | 57 / 58.75 | 39.5 / 47 |
| warm | vitals.lcp | 992 / 1793 | 1028 / 1543 | 732 / 1219 |
| warm | cpu.scriptMs | 1138.8 / 1893.625 | 1114.65 / 1623.75 | 145.95 / 715.5 |
| search | inp | 4692 / 6190 | 280 / 338 | 304 / 394 |
| search | keys.toRowsMs | null / null | 737.65 / 1142.315 | 573.3 / 1144.065 |
| search | lt.blockingMs | 8023 / 10252.75 | 883 / 1667.25 | 1785.5 / 2655.75 |
| search | cpu.scriptMs | 8552.15 / 10670.15 | 1469.5 / 2198.125 | 2139.85 / 2741.425 |
| search | mem.heapPeakMB | 57.55 / 59.025 | 41.75 / 44.15 | 35.6 / 37.025 |
| search | net.apiCalls | 20 / 20.75 | 20 / 20 | 15.5 / 16.75 |
| typo | inp | 5504 / 7126 | 280 / 536 | 308 / 394 |
| typo | keys.toRowsMs | null / null | 867.2 / 1577.915 | 602.4 / 1414.215 |
| typo | cpu.scriptMs | 13159.85 / 15374.525 | 2310.15 / 3046.125 | 3068.95 / 4082.825 |
| printlang | inp | 328 / 426 | 292 / 492 | 364 / 574 |
| printlang | lang.toRowsMs | 291.85 / 380.055 | 254.5 / 408.015 | 302.15 / 524.735 |
| langtype | inp | 5296 / 5422 | 312 / 984 | 424 / 582 |
| langtype | keys.toRowsMs | 4785.7 / 4919.55 | 547.45 / 1212.14 | 730.95 / 1317.37 |

### desktop

| journey | metric | baseline p50 / p95 | optimised React p50 / p95 | Solid p50 / p95 |
|---|---|---|---|---|
| cold | vitals.fcp | 284 / 321 | 246 / 269 | 116 / 123 |
| cold | vitals.lcp | 1298 / 1540 | 1258 / 1285 | 270 / 280 |
| cold | vitals.cls | 0.208 / 0.385 | 0.009 / 0.009 | 0 / 0 |
| cold | tbt | 0 / 0 | 0 / 0 | 4.5 / 10.75 |
| cold | cpu.scriptMs | 272.3 / 311.85 | 221.8 / 252.025 | 155.3 / 167.65 |
| cold | mem.heapPeakMB | 31.25 / 32.875 | 29.85 / 31.775 | 23.75 / 26.475 |
| cold | net.bytes | 2659818 / 4234497.25 | 2028709 / 4778057.5 | 1120317.5 / 1156974.75 |
| cold | net.downloads | 64.5 / 69.75 | 62 / 67.25 | 59 / 64.5 |
| warm | vitals.lcp | 222 / 242 | 194 / 215 | 132 / 150 |
| warm | cpu.scriptMs | 205.55 / 228.025 | 176.4 / 192.5 | 137.25 / 159.1 |
| search | inp | 728 / 756 | 84 / 88 | 64 / 64 |
| search | keys.toRowsMs | 906.65 / 1268.28 | 187.45 / 426.735 | 177.25 / 360.36 |
| search | lt.blockingMs | 1048 / 1218.75 | 0 / 0 | 11.5 / 23.25 |
| search | cpu.scriptMs | 1681.05 / 1876.825 | 341.35 / 372.2 | 545.95 / 587.1 |
| search | mem.heapPeakMB | 51.95 / 56.725 | 38.15 / 45.275 | 31.8 / 37.525 |
| search | net.apiCalls | 20 / 20 | 24.5 / 26.75 | 22 / 22 |
| typo | inp | 904 / 992 | 96 / 114 | 64 / 80 |
| typo | keys.toRowsMs | 1162.35 / 1551.2 | 156.9 / 345.595 | 175.6 / 401.77 |
| typo | cpu.scriptMs | 3059.95 / 3354.625 | 528.45 / 576.45 | 824.8 / 914.075 |
| printlang | inp | 76 / 92 | 80 / 100 | 88 / 102 |
| printlang | lang.toRowsMs | 45.3 / 54.715 | 36.6 / 41.71 | 51.9 / 67.95 |
| langtype | inp | 752 / 848 | 100 / 118 | 104 / 116 |
| langtype | keys.toRowsMs | 556 / 1178.825 | 147.1 / 482.86 | 171.7 / 510.215 |

### Findings from ab1 and follow-up profiles

- Typing on the baseline is dominated by name ranking (mobile INP 4.7 s). The
  optimised ranker (byte-identical, 35,604-query oracle, 0 diffs) brings typing
  INP to ~0.3 s mobile / ~0.08 s desktop in both UIs.
- Solid mobile cold TBT (494 ms) was higher than React: the typeahead engine
  (ranker + 10k-name catalog) was evaluated on idle inside the 5 s window, and
  `bindRailControls` forced a layout per rail. Addressed after ab1: engine
  chunks are prefetched (no evaluation) and evaluated on search intent; rail
  controls sync from the ResizeObserver's first callback.
- Solid typing script time (2.1 s vs 1.5 s React, mobile) came from row
  derivations recomputed on every read; addressed with per-row memos and a
  per-printing card/thumb cache. Era matching (`matchTcgEra`) is memoised for
  both UIs.

## Run ab2 — 2026-10-09 19:08–19:11 UTC (typing only, after the Solid fixes)

- Builds: optimised React = feature/frontend-perf market/ (before the hot-path
  fixes in shared modules); Solid = feature/frontend-perf 229dad5+ solid/
  (engine on intent, per-row memos, era memo, collator).
- Mobile profile (390×844, CPU ×4), 3 interleaved runs per build (small n:
  read p50 as indicative). Same host caveats as ab1.

| journey | metric | optimised React p50 / p95 | Solid p50 / p95 |
|---|---|---|---|
| search | inp | 272 / 300.8 | 104 / 118.4 |
| search | keys.toRowsMs | 831 / 1534 | 307.3 / 547.2 |
| search | lt.blockingMs | 920 / 987.5 | 508 / 620.5 |
| search | cpu.scriptMs | 1543.3 / 1628.3 | 977.8 / 1082.9 |
| search | mem.heapPeakMB | 38.7 / 50.31 | 35 / 35.63 |
| typo | inp | 312 / 333.6 | 152 / 152 |
| typo | keys.toRowsMs | 646 / 1006.9 | 372.3 / 498.5 |
| typo | lt.blockingMs | 889 / 1258.9 | 741 / 964.2 |
| typo | cpu.scriptMs | 1888.8 / 2164.6 | 1429.5 / 1722.3 |
| typo | mem.heapPeakMB | 43.9 / 60.46 | 34.8 / 36.6 |
