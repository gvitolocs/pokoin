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

## Run ab7nav — 2026-10-09 20:18–20:19 UTC (card click, after the desk fixes)

- Card journey: home → 8 tile clicks → desk → back, mobile profile (390×844, CPU ×4),
  3 interleaved rounds per build, React = optimised React, Solid = feature/frontend-perf 3447554.
- Before the fixes (ab6nav, same journey): Solid INP 152 ms p50, presentation 111 ms —
  Router 2 navigated inside the click, so the click waited for the whole desk render.

| metric | optimised React p50 / p95 | Solid p50 / p95 |
|---|---|---|
| inp | 64 / 78.4 | 56 / 56 |
| nav.toHeadingMs | 128 / 250 | 136 / 229 |
| nav.toImageMs | 164 / 305 | 178 / 270 |
| nav.toUrlMs | 44.1 / 51.8 | 136 / 229 |
| nav.backMs | 142 / 162 | 154 / 209 |
| lt.blockingMs | 689 / 691 | 802 / 1102 |
| mem.heapPeakMB | 49.5 / 56.1 | 39 / 40.6 |

- `nav.toUrlMs` is router behaviour: Router 2 commits the URL with the new page.
- `dom.nodes` (Performance.getMetrics) is inflated by Playwright element handles in both
  builds: a forced-GC heap trace showed unmounted pages retained only by DevTools handles,
  so it is not reported here.

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

## Run s1010 — 2026-10-10 07:19–08:01 UTC (React before vs React now vs Solid now)

- Builds: **React before** = React at origin/main 5243700 (the pre-optimisation
  baseline of ab1, built from `git archive`); **React now** = origin/main 2b6757cc
  market/; **Solid now** = origin/main 2b6757cc solid/ (Solid owns home, search,
  card desk and versions in production since 2026-10-09 21:00 UTC).
- Same method as ab1: `solid/scripts/preview.mjs` per build, `bench/interleave.sh`
  (one run of each build per round), 5 rounds per profile, fresh browser context
  per run. Journeys: cold, warm, search, typo, printlang, langtype, card.
  Chromium 156.0.8078.4, Playwright 1.64.0. 0 failed runs.
- All three builds call the same live `api.pokoin.com` (native Rust since
  2026-10-09), so the backend is constant here; the Node vs Rust API comparison
  is in [../PI_LOAD_TEST.md](../PI_LOAD_TEST.md).
- **Caveat: host load.** nezopt load average was 22–42 on 12 threads during both
  profiles (ab1: 7–13). With 5 runs, read wall-clock p50 differences under ~15 %
  as noise and p95 as "worst seen"; `cpu.*`, `net.*` and `mem.*` are the stable
  signals. Absolute values are not comparable with ab1.

### mobile (390×844, CPU ×4)

| journey | metric | React before p50 / p95 | React now p50 / p95 | Solid now p50 / p95 |
|---|---|---|---|---|
| cold | vitals.fcp | 1444 / 5123 | 632 / 2850 | 800 / 1947 |
| cold | vitals.lcp | 2440 / 6318 | 1060 / 3732 | 1508 / 2680 |
| cold | vitals.cls | 0.049 / 0.405 | 0.049 / 0.049 | 0.000 / 0.000 |
| cold | tbt | 336 / 1201 | 257 / 771 | 185 / 694 |
| cold | cpu.scriptMs | 1903 / 3585 | 1059 / 2070 | 765 / 1225 |
| cold | mem.heapPeakMB | 29.5 / 35.0 | 27.3 / 28.9 | 10.4 / 12.8 |
| cold | net.bytes | 4184 KB / 4431 KB | 3930 KB / 4224 KB | 1202 KB / 2932 KB |
| cold | net.downloads | 59.0 / 64.8 | 63.0 / 63.8 | 61.0 / 64.4 |
| warm | vitals.lcp | 1568 / 2533 | 496 / 1181 | 760 / 975 |
| warm | cpu.scriptMs | 993 / 2427 | 719 / 1567 | 765 / 887 |
| search | inp | 4824 / 7309 | 240 / 491 | 120 / 162 |
| search | keys.toRowsMs | – | 730 / 1329 | 632 / 1236 |
| search | lt.blockingMs | 6546 / 12475 | 568 / 1692 | 1499 / 2204 |
| search | cpu.scriptMs | 7092 / 12880 | 1211 / 2170 | 1871 / 2375 |
| search | mem.heapPeakMB | 55.9 / 59.6 | 36.7 / 37.7 | 35.7 / 37.5 |
| search | net.apiCalls | 20.0 / 20.8 | 20.0 / 20.8 | 19.0 / 20.0 |
| typo | inp | 4880 / 7587 | 488 / 677 | 232 / 411 |
| typo | keys.toRowsMs | – | 829 / 1743 | 561 / 1304 |
| typo | cpu.scriptMs | 12106 / 15808 | 1869 / 3246 | 2763 / 3072 |
| printlang | inp | 288 / 659 | 248 / 579 | 424 / 526 |
| printlang | lang.toRowsMs | 249 / 563 | 204 / 444 | 284 / 438 |
| langtype | inp | 5264 / 7168 | 456 / 702 | 320 / 459 |
| langtype | keys.toRowsMs | 1827 / 6419 | 461 / 1570 | 399 / 1436 |
| card | inp | 112 / 149 | 96.0 / 176 | 96.0 / 112 |
| card | nav.toHeadingMs | 210 / 406 | 272 / 557 | 242 / 572 |
| card | nav.toImageMs | 263 / 500 | 347 / 735 | 313 / 657 |
| card | nav.backMs | 245 / 419 | 263 / 382 | 316 / 567 |
| card | lt.blockingMs | 1974 / 3028 | 2255 / 3166 | 3318 / 4743 |
| card | mem.heapPeakMB | 59.6 / 61.4 | 55.1 / 58.5 | 52.1 / 55.8 |

### desktop (1440×900)

| journey | metric | React before p50 / p95 | React now p50 / p95 | Solid now p50 / p95 |
|---|---|---|---|---|
| cold | vitals.fcp | 524 / 724 | 316 / 598 | 188 / 470 |
| cold | vitals.lcp | 852 / 1270 | 456 / 797 | 320 / 775 |
| cold | vitals.cls | 0.009 / 0.211 | 0.009 / 0.009 | 0.005 / 0.005 |
| cold | tbt | 3.0 / 68.6 | 34.0 / 173 | 0.0 / 33.2 |
| cold | cpu.scriptMs | 542 / 724 | 334 / 742 | 134 / 348 |
| cold | mem.heapPeakMB | 24.6 / 27.3 | 20.7 / 27.0 | 15.3 / 16.1 |
| cold | net.bytes | 4161 KB / 4565 KB | 3735 KB / 3952 KB | 1417 KB / 1422 KB |
| cold | net.downloads | 66.0 / 71.2 | 66.0 / 67.8 | 70.0 / 71.0 |
| warm | vitals.lcp | 532 / 1037 | 216 / 416 | 172 / 430 |
| warm | cpu.scriptMs | 392 / 535 | 219 / 556 | 106 / 276 |
| search | inp | 1264 / 1693 | 128 / 211 | 120 / 184 |
| search | keys.toRowsMs | 1354 / 1659 | 225 / 516 | 224 / 483 |
| search | lt.blockingMs | 2381 / 3627 | 28.0 / 279 | 242 / 459 |
| search | cpu.scriptMs | 3009 / 4273 | 593 / 1037 | 689 / 957 |
| search | mem.heapPeakMB | 46.6 / 49.0 | 35.5 / 38.0 | 34.3 / 39.7 |
| search | net.apiCalls | 20.0 / 20.0 | 21.0 / 24.4 | 20.0 / 26.6 |
| typo | inp | 1384 / 1800 | 136 / 320 | 176 / 384 |
| typo | keys.toRowsMs | 1399 / 1697 | 223 / 493 | 268 / 517 |
| typo | cpu.scriptMs | 4942 / 5948 | 644 / 1501 | 872 / 1410 |
| printlang | inp | 176 / 234 | 160 / 277 | 352 / 424 |
| printlang | lang.toRowsMs | 85.5 / 130 | 48.1 / 90.2 | 94.0 / 130 |
| langtype | inp | 1456 / 1622 | 144 / 354 | 304 / 674 |
| langtype | keys.toRowsMs | 842 / 1302 | 187 / 793 | 236 / 971 |
| card | inp | 64.0 / 101 | 40.0 / 131 | 80.0 / 144 |
| card | nav.toHeadingMs | 64.4 / 125 | 53.4 / 187 | 72.0 / 179 |
| card | nav.toImageMs | 79.7 / 167 | 68.5 / 227 | 135 / 304 |
| card | nav.backMs | 79.2 / 151 | 59.8 / 218 | 118 / 222 |
| card | lt.blockingMs | 246 / 441 | 4.0 / 641 | 373 / 1300 |
| card | mem.heapPeakMB | 46.6 / 60.3 | 55.4 / 59.3 | 41.9 / 50.8 |

### Findings from s1010

- Cold load, Solid vs React before: bytes −71 % mobile / −66 % desktop
  (1.2 / 1.4 MB vs 4.2 MB), script CPU −60 % / −75 %, JS heap 10 vs 30 MB
  (mobile), CLS 0. Desktop FCP 188 vs 524 ms and LCP 320 vs 852 ms.
- Typing, React before → now: mobile `search` INP 4.8 s → 240 ms (React now) /
  120 ms (Solid); `typo` 4.9 s → 488 / 232 ms. Most of that is the shared ranker
  rewrite, which both current UIs carry.
- Solid behind React now: print-language switch (INP 424 vs 248 ms mobile, 352
  vs 160 ms desktop), `langtype` on desktop (304 vs 144 ms), and desktop card
  navigation (image 135 vs 69 ms, back 118 vs 60 ms, 373 vs 4 ms blocking).
  Mobile typing still costs Solid more script than React now (1.9 vs 1.2 s for
  `search`) while answering faster, as in ab1.
- Mobile cold FCP/LCP p50 put React now ahead of Solid in this run (632 vs 800 ms)
  where ab1 had the opposite; with the host at 2–3× ab1's load and n = 5, that
  difference is within the noise noted above.
