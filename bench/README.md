# Pokoin browser benchmark

Repeatable Playwright + Chrome DevTools Protocol (CDP) benchmark for the Pokoin SPA
(`market/`, served at `/marketplace`). It drives real user journeys in Chromium and records
Web Vitals, Event Timing (INP), long tasks, CDP CPU/heap/DOM counters and network
transfers. Every run is kept raw, and every metric gets a distribution summary. The same
selectors work for any build with the same markup, including the Solid 2 port. They all
live in [`config.mjs`](config.mjs).

## Setup

```bash
cd bench
npm ci                      # playwright is the only dependency (pinned)
npx playwright install chromium   # Linux without browser deps: add --with-deps
npm test                    # unit tests for stats, network, sourcemap and profile maths
```

## Running

```bash
# Full public suite, 10 runs, desktop (1440×900, no throttling)
node run.mjs --base https://pokoin.com --profile desktop --runs 10 --label "$(git rev-parse --short HEAD)"

# Mobile: 390×844, isMobile + touch, CDP CPU throttling ×4; optional slow 4G
node run.mjs --profile mobile --runs 10 --label abc123 --out results/abc123-mobile.json
node run.mjs --profile mobile --net slow4g --runs 5 --journeys cold,warm --label abc123

# A subset
node run.mjs --profile desktop --runs 2 --journeys cold,search,card --label smoke

# Compare two result files (markdown on stdout, warnings on stderr)
node compare.mjs results/before.json results/after.json > compare.md
node compare.mjs before.json after.json --threshold 5 --fail-on-regression   # exit 2 on regression

# Bundle sizes (+ sourcemap attribution when *.map exist)
(cd ../market && npx vite build --sourcemap --outDir /tmp/pokoin-dist-maps --emptyOutDir)
node bundle.mjs /tmp/pokoin-dist-maps --top 40 --json /tmp/bundle.json

# CPU profile while typing a query (writes a .cpuprofile, gitignored)
node profile.mjs --profile mobile --query pikachu --label abc123
node profile.mjs --base http://127.0.0.1:4173 --sourcemap-dir /tmp/pokoin-dist-maps   # symbolicated
```

`run.mjs` options: `--base` (origin, default `https://pokoin.com`), `--profile desktop|mobile`,
`--runs N` (default 5), `--journeys a,b,…`, `--label` (e.g. the git sha), `--out`
(default `results/<label>-<profile>-<time>.json`), `--net slow4g|none`,
`--auth-state <storageState.json>`, `--cooldown ms` between journeys (default 1000),
`--journey-timeout ms` (default 180000), `--channel chromium|headless-shell|chrome`
(default `chromium`, i.e. the full browser in new-headless mode), `--headed`, `--verbose`.
Ctrl-C writes the partial results collected so far.

Every journey runs in a **fresh browser context**: empty HTTP cache, storage and service
workers. Runs are interleaved run-major (run 1 of every journey, then run 2, …), so slow
drift on the host or the network spreads across journeys instead of piling onto one.

## Journeys

| journey | what it does | journey-specific metrics |
|---|---|---|
| `cold` | fresh context → `/marketplace`; observe until 5 s after `load` | `vitals.*`, `tbt` |
| `warm` | load `/marketplace`, settle, then `reload()` in the same context | `vitals.*`, `tbt` |
| `search` | click `#market-search`, type `pikachu` one key every 120 ms | `keys.*`, `rows.final`, `inp*` |
| `typo` | same with `pikahcu` | as search |
| `printlang` | with `pikachu` suggestions open, print language → Japanese, then → Western | `lang.toRowsMs`, `inp*` |
| `langtype` | type `char`, switch print language to Japanese, click back into the box, type `izard` | `keys.*`, `lang.toRowsMs` |
| `card` | click the first 8 distinct home tiles in turn, `history.back()` between them | `nav.toUrlMs/toHeadingMs/toImageMs`, `nav.backMs` |
| `back` | `/marketplace/search?q=pikachu`, scroll 1.5 viewports, open a card, `history.back()` | `back.*` |
| `rapid20` | open a card, then click "Next card in set" 20 times, each as soon as the heading paints | `nav.toHeadingMs` ×20, `rapid.totalMs` |
| `scroll` | `/marketplace/search?q=energy`, mouse-wheel down for 8 s, pressing "Load more" at the bottom | `scroll.*` |
| `realtime` | open a card desk, then idle 30 s | `idle.requestsPerMin`, `idle.scriptMsPerMin` |
| `collection` | **auth only.** Load the collection page, open the first editor, then press Escape (nothing is saved) | `auth.readyMs`, `auth.editOpened` |
| `checkout` | **auth only.** Open `/cart`, click through to checkout, stop once it renders. Never pays or places an order | `auth.cartReadyMs`, `auth.toCheckoutMs` |

The auth journeys run only with `--auth-state`. Without it they are recorded as
`skipped: no auth state`. To create a state file for a **test** account, run
`npx playwright codegen --save-storage=auth.json https://pokoin.com` and sign in. These files
hold session cookies, so `.gitignore` excludes `auth*.json` and `*.storage.json`. The
checkout journey is skipped when the cart is empty, because the suite never adds items.
The auth journeys could not be validated here (no test account), and their selectors in
`AUTH` (config.mjs) are best guesses.

## Metric definitions

All times are milliseconds. Page-side timestamps share one clock (`performance.now()` and
`event.timeStamp`), so **start → condition** latencies are measured inside the page, not
with Playwright round trips.

**Load (cold / warm)**

- `vitals.ttfb`: navigation `responseStart`. `vitals.fcp`: `first-contentful-paint`.
  `vitals.lcp`: last `largest-contentful-paint` entry. `vitals.cls`: sum of `layout-shift`
  values, excluding shifts with `hadRecentInput`. `vitals.dcl` / `vitals.load`: event end
  times.
- `vitals.firstTileMs` / `vitals.appReadyMs`: first time `a.tile` / `#market-search`
  existed in the DOM (MutationObserver).
- `tbt`: Σ max(0, duration − 50) over `longtask` entries that start between FCP and
  `load` + 5 s.

**Interaction (Event Timing, `durationThreshold: 16`)**

- `inp`: worst interaction in the journey. Entries are grouped by `interactionId`, an
  interaction's latency is its longest entry, and `inp` is the maximum. This is the max
  for the journey, not the field metric's p98, since journeys have few interactions.
  `inp.inputDelay` = `processingStart − startTime`, `inp.processing` =
  `processingEnd − processingStart`, `inp.presentation` = `startTime + duration −
  processingEnd`, all taken from the worst entry. `inp.all` holds every interaction's
  latency (pooled across runs in the summary). `inp.interactions` counts interactions
  ≥ 16 ms. `inp = 0` means every interaction finished under the 16 ms observer threshold.
  Event Timing durations are rounded to 8 ms by the browser.

**Typeahead**

- `keys.toRowsMs` (one value per keystroke): keydown `timeStamp` → the first animation
  frame where the visible option rows (`#market-suggest .suggest-list li li`, compared by
  `data-suggest-id`) are non-empty **and** different from the rows at that keydown. It is
  `null` if there is no change within 1.5 s. A null can also mean the results simply did
  not change, so check `keys.noChange` before reading it as slowness. Rows that render and
  are replaced before any frame paints them are never seen, which is intended.
- `keys.firstToRowsMs`: first keydown of a typed burst → first rows change.
  `keys.lastToFinalRowsMs`: last keydown → rows change. Both have a 10 s budget, so they
  still carry signal when every per-key value is null (e.g. mobile under load).
- `keys.maxToRowsMs`, `keys.noChange`, `rows.final` (rows once stable for 1 s), and
  `keys.valueMismatch` (1 if the input did not end up holding the typed text).
- Keys are sent on a fixed 120 ms schedule and are **not** awaited one by one, so they
  queue behind a busy main thread the way a real user's keystrokes do.
- `lang.toRowsMs`: pointerdown on the print-language option → rows changed (5 s budget).

**Navigation**

- `nav.toUrlMs` / `nav.toHeadingMs` / `nav.toImageMs`: pointerdown on the link →
  `location.pathname` contains `/cards/<id>` → the desk `h1` has text and no skeleton
  (and the art frame carries that `data-card-id`, or the heading text changed) → the art
  frame's `img` is complete and `decode()` resolved.
- `nav.backMs` (card) and `back.toResultsMs`: `history.back()` → target page tiles
  present and the desk gone.
- `back.scrollDeltaAtPaintPx` / `back.scrollDeltaPx`: |scrollY − saved| when results first
  paint / 1 s later. `back.scrollRestored` is 1 if within 50 px after 1 s.

**Scroll**: `scroll.frames`, `scroll.gapsOver33`, `scroll.gapsOver50`, `scroll.maxGapMs`,
`scroll.p95GapMs` (gaps between consecutive rAF callbacks), `scroll.tilesStart/End`,
`scroll.loadMoreClicks`, `scroll.finalY`.

**Every journey** (measured over the journey's window)

- `wall.ms`: window duration.
- `cpu.scriptMs`, `cpu.taskMs`, `cpu.layoutMs`, `cpu.recalcStyleMs`: deltas of CDP
  `Performance.getMetrics` `ScriptDuration`, `TaskDuration`, `LayoutDuration` and
  `RecalcStyleDuration`, i.e. main-thread CPU time of the page's renderer.
- `mem.heapPeakMB` (`JSHeapUsedSize` sampled every 500 ms), `mem.heapEndMB`, and
  `dom.nodes` (CDP `Nodes` at the end).
- `lt.count`, `lt.totalMs`, `lt.maxMs`, `lt.blockingMs`: long tasks starting inside the
  window. `loaf.count` and `loaf.blockingMs` come from long-animation-frame entries.
- `net.requests`: every request except `data:`/`blob:`. `net.downloads`: requests that
  actually crossed the network. Excluded are memory/disk cache, service-worker and
  prefetch-cache hits, 0-byte loads (counted in `net.cached`), redirect hops
  (`net.redirects`, with samples in `detail.redirectSamples`), failures (`net.failed`) and
  cancellations (`net.canceled`, e.g. aborted typeahead fetches). `net.bytes` and
  `net.bytes.<Type>` are encoded (on-the-wire) bytes of real downloads. `net.apiCalls`
  counts requests to `api.pokoin.com` or `/api/*`, with the per-path breakdown in
  `detail.apiByPath`. `net.imageDownloads` / `net.imageBytes` cover images.
  `net.duplicateDownloads` counts the same URL downloaded more than once
  (`detail.duplicateUrls`). `net.wsFrames` counts WebSocket frames received.

## Output format

```jsonc
{
  "schema": 1,
  "environment": { "timestamp", "base", "label", "profile", "net", "runs", "journeys",
    "cpuThrottle", "viewport", "userAgent", "channel", "browserVersion", "playwrightVersion",
    "node", "platform", "hostname", "cpuCount", "cpuModel", "totalMemMB",
    "loadavgStart", "loadavgEnd", "durationMs", "argv" },
  "runs":    { "search": [ { "run": 1, "ok": true, "wallMs": 6400,
                 "metrics": { "inp": 752, "keys.toRowsMs": [1342.8, null, …], … },
                 "detail":  { "keys": [ … ], "apiByPath": { … }, "worstInteraction": { … } } } ] },
  "summary": { "search": { "inp": { "n": 10, "nulls": 0, "min": …, "p50": …, "p75": …,
                 "p95": …, "p99": …, "max": …, "mean": … }, … } }
}
```

Scalar metrics give one sample per run. Array metrics (keystrokes, navigations) are pooled
across runs (`"pooled": true`), so their `n` counts samples. Percentiles use linear
interpolation. With 10 runs, p95/p99 sit close to the max, so treat them as "worst seen".
Failed runs keep their `error` and are left out of the summary. Skipped runs keep their
`skipped` reason.

## Reading results

- Compare **p50 first**, then p95. Treat a single-run difference under ~10 % as noise.
  `compare.mjs` flags p50 increases above `--threshold` (default 10 %) on the watched
  metrics `inp`, `keys.toRowsMs`, `keys.lastToFinalRowsMs`, `lang.toRowsMs`,
  `nav.toHeadingMs`, `vitals.lcp` and `tbt`.
- Look at `nulls` for keystroke metrics. A build whose rows never change in time can show
  a *better* p50 over fewer samples.
- To localise a regression, read `cpu.scriptMs` together with `lt.blockingMs`. Read
  `net.apiCalls` and `detail.apiByPath` together with the latency metrics.
- For bundle changes, use `bundle.mjs` (entry raw/gzip/brotli plus per-package bytes).
  For where main-thread time goes during typing, use `profile.mjs`.

## Caveats

- **Shared-host noise.** Other processes on the box steal CPU from the renderer, and that
  shows up directly in INP, keystroke latency and long tasks. `loadavgStart` and
  `loadavgEnd` are recorded, and `compare.mjs` prints them, so do not compare runs taken
  under very different load. Prefer a quiet machine, ≥ 10 runs, and A/B runs taken back to
  back on the same host (or interleave A and B result files from alternating
  invocations).
- **CPU time vs wall-clock.** `cpu.*` metrics are main-thread CPU time and are mostly
  immune to network jitter. They are the most stable signal for "did the code get
  cheaper". Wall-clock metrics (`vitals.*`, `keys.*`, `nav.*`, `back.*`) include network
  latency to `api.pokoin.com` and the CDN, Cloudflare cache state, and server load. They
  measure user experience but move with the network.
- **CPU throttling is relative.** ×4 on a Ryzen 7600 is not a real mid-range phone.
  Compare mobile numbers only with mobile numbers from the same host.
- **Headless.** The default `chromium` channel runs the full browser in new-headless
  mode, with software rasterisation (no GPU). Absolute paint and presentation times
  differ from a desktop Chrome with GPU, but A/B deltas on the same host are meaningful.
  `--channel headless-shell` uses the lighter old-headless shell.
- Only the page target is instrumented: requests from Web Workers / service workers are
  not in `net.*`, and worker CPU is not in `cpu.*`.
- Instrumentation cost: per-frame `querySelectorAll` on ≤ 20 option rows while a watcher
  is pending, a keydown/pointer capture listener, and a CDP metrics call every 500 ms.
  This cost is small and identical across builds.
- **Production load.** A full 10-run suite makes a few thousand API requests and downloads
  a few hundred MB from the CDN. Keep validation runs small and don't loop the suite
  against production.
