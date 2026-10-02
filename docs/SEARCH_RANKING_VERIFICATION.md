# Shared search ranking verification

## Behavior covered by the fix

The shared printing scorer retains confidence for an accepted spelling typo
in proportion to the letters preserved, while keeping the existing edit and
coverage limits. Name specificity counts distinct words actually matched in
the name: set, artist, rarity and collector evidence cannot cancel an untyped
name word. A shorter translation only contributes specificity when that
language contributed name evidence.

The popup selects individual printings in descending score order. Lower-score
siblings no longer inherit their group's best score, and per-name quotas no
longer displace stronger printings. Heterogeneous set and artist caches group
each printing by its actual name before applying mechanic eligibility.

Both header and add-card search hydrate recognized sets through the complete
paginated catalog. A matching card beyond the first 48 rows can therefore
reach the scorer. Concurrent requests for the same set share the entire
pagination promise, including later pages; a failed request can be retried.
Successful empty terminal pages complete exact 48/96-card sets, while missing
or failed responses still reject.
The existing 40-page bound remains, and a truncated catalog is not marked
complete. These changes apply to every query using these shared paths.

## Running the formal check

Run `scripts/check-search-ranking-tlc.sh` from an isolated worktree on nezopt.
The check imports the worktree's actual `search-score.js` and
`suggest-live.js`; it generates its score fixtures and popup observations at
runtime. It neither connects to production nor writes generated fixtures or
TLC state directories into the checkout.

The pinned toolchain is
`/home/nez/deepseek-harness-local/formal/orchestra-tlc/toolchain`. The script
checks the SHA-256 of its `tla2tools.jar` before invoking the bundled Java 17.
It expects Node.js and GNU `timeout` on PATH. No package install is needed.
An optional `SEARCH_RANKING_SOURCE_ROOT` selects another isolated checkout for
read-only verification; `SEARCH_RANKING_TLC_TIMEOUT_SECONDS` changes the
per-configuration timeout (default 300 seconds).

## What TLC checks

The bridge evaluates **7,200 finite popup executions** across 17 scenarios:

- A typo plus set prefix (`mewtow evol`), with six source groups, all 720
  cache insertion orders, normal and reversed printing order, and result
  caps 0, 1, 4 and 20. The cache includes two name forms, weaker sibling
  printings, a context-only card, a sealed product, a live stub, a duplicate
  printing ID, and a card with no query evidence.
- Another typo plus set (`charziard base`), a compound name competing with
  set context (`pakia legend`), and name queries with rarity (`eevee illu`),
  artist (`sugimori pika`) and collector (`025 pikachu`) evidence. Each
  covers all six orders of three source groups, both printing orders,
  and caps 1, 4 and 20.
- Progressive `e`, `ev`, `evo` and `evol` set suffixes after both typo Mewtwo
  and typo Charizard names. Each of these eight scenarios covers all 24
  insertion orders of four groups, both printing orders, and caps 1, 4 and
  20. Plain, EX and GX name forms are present alongside a context-only card.
- Literal EX, GX and V suffixes after a typo Mewtwo name. Each covers all six
  insertion orders of three groups, both printing orders, and caps 1, 4 and
  20, including a rival mechanic that must remain excluded.

For every bounded execution, TLC replays the actual JavaScript result one row
at a time. Independent invariants require descending relevance, a result cap,
unique eligible identities, all available eligible printings when the cap has
room, and no lower-score selection displacing a higher-score omitted printing.
An exact reference sequence also requires deterministic tie ordering across
cache and within-group insertion orders. Score probes verify coverage priority,
a small accepted name typo beating a metadata-only match with equal coverage,
and a penalty for an unmatched extra name word even when another query word
matches the set. Eight progressive-prefix probes require one/two-character
set evidence to improve quality without adding coverage after an independent
name match; three/four-character prefixes regain ordinary coverage. The same
probes require EX cards to remain eligible and prohibit accidentally treating
an unfinished `ev` set suffix as V. Two additional bare `e`/`ev` probes forbid
set expansion, and three literal-mechanic probes preserve exact EX/GX/V name
evidence and rival-mechanic exclusions. Every pair of fixture rows also checks
coverage priority.

The Node bridge now memoizes the actual `rankNames` results from the real
local pool instead of substituting an empty ranking pool. Cold probes execute
the actual API adapter with injected transport, followed by
`fetchSuggestRanked`, cache hydration and popup selection. The browser's
unrelated JSX authentication dependencies are excluded from that adapter
execution, as in `expansion-api.test.js`.
The cold bridge uses the existing four-way `rankNamesParallel` partition and
merge path, with actual `rankNames` chunk results memoized by a fingerprint
of the complete chunk. It caches deterministic scorer observations without
skipping any cold retrieval or popup execution.

## Regression witnesses

The script runs three configurations:

- `SearchRanking.cfg` must pass with exit code 0.
- `SearchRanking-old-extra-tokens.cfg` must fail with exit code 12. It restores
  the previous subtraction of total cross-field coverage from name length;
  the base name and extra-word name then tie instead of preferring the base.
- `SearchRanking-old-group-fill.cfg` must fail with exit code 12. It restores
  ordering groups by their best printing and emitting whole groups; a weaker
  sibling can then precede a stronger printing in the next group.

A witness passing, a parse failure, or a timeout makes the script fail. Witness
counterexamples demonstrate that the fixture universe reaches the reported
failure modes, rather than merely checking a vacuous invariant.

## Recorded validation

On 2026-10-01, the corrected shared scorer passed all 5,940 executions:
26,820 states generated, 20,880 distinct states explored, zero states left
on the queue, and complete search depth 6. Both regression configurations
produced the required invariant counterexamples with exit code 12.
The whole-group witness emitted IDs `101, 102, 201`: a partial Mewtwo
printing preceded the full-query Mewtwo ex printing. The corrected sequence
was `101, 201, 102`. The name-specificity witness reproduced equal base
and extra-word scores after restoring the previous penalty calculation.

The final implementation also passed:

| Check | Result |
| --- | --- |
| `node --test market/src/*.test.js` | 1,036 passed, zero failed |
| `cd market && npm run build` | Passed; existing bundle-size and mixed-import warnings |
| Python test files under `scripts/` | 12 files, 121 tests passed |
| Existing gesture TLC safety/liveness checks | Passed; all five expected reachability witnesses produced counterexamples |
| Existing CardTrader seller inventory TLC safety/liveness | Passed; 43 generated, 14 distinct states |
| Broader API, worker and script JavaScript suites | 397 passed, two baseline failures |
| `market/index.test.js` | One baseline failure |

The two broader JavaScript failures are the CardTrader connect webhook test
and seller-listings test loading the absent `server/_firebase` helper. The
index test expects a card-bootstrap route matcher that is absent from the
unchanged baseline. All three failures were reproduced in the separate
formal-verification worktree without the implementation changes. They remain
outside this search fix.

Python tests used a temporary virtual environment with Pillow and NumPy; the
artwork-layout classifier tests used the existing ROCm/PyTorch environment.
No global dependency installation was required.

Browser verification against the live catalog from the isolated development
server showed `mewtow evol` starting with regular Mewtwo **51/108**, then
Mewtwo ex **52/108** and **103/108**, followed by other Mewtwo printings.
`charziard evol` likewise started with the Evolutions Charizard printings.
The live Evolutions endpoint confirmed that regular Mewtwo is beyond the
initial 48-row response. No production code was pushed or deployed.

## Limits

This is exhaustive over the generated finite executions, not a proof over the
entire catalog or every query. It does not model Unicode normalization, edit
matrix correctness, live Meili response correctness, localized hydration, asynchronous response
content changes, network errors, cache expiration, or browser rendering.
Fixtures hold hydrated fields constant while varying their insertion order.
JavaScript unit and corpus tests remain necessary for those wider concerns.
Scores are represented as integers at five-decimal precision; the selected
fixtures use score differences substantially larger than that precision.
The hand-written TLA+ checks observed JavaScript outputs independently; it does
not assert that a hand-translated selector is identical to arbitrary future
JavaScript implementations.

## Early-prefix followup validation

The expanded check on 2026-10-01 passed all **7,200 executions** across
17 scenarios: 33,552 states generated, 26,352 distinct states explored,
zero states left on the queue, and complete search depth 7. Both existing
regression configurations still produced their required exit-code-12
counterexamples.

The new probes verified `e` and `ev` contributing positive set quality while
coverage remained 1 after a matching name; `evo` and `evol` raised coverage
to 2. Context-only cards stayed at zero coverage for `e`/`ev`, and EX cards
remained eligible through the `ev` transition. Literal EX/GX/V queries kept
exact name evidence, matching forms and rival-mechanic exclusions.

Running the same expanded check against the previous `c131210` baseline
failed `EarlySetPrefixProgression`: early `e`/`ev` provided no set quality,
and `ev` was mistakenly read as V, hiding EX cards. This confirms the new
checks distinguish the followup fix from the earlier balanced scorer.

The early-prefix implementation adds a quality-only set bonus for trailing
one/two-letter words after independent name evidence. These broad prefixes
have equal strength across short and long set words, so `EX` and `Expansion`
do not gain an arbitrary advantage over `Evolutions`. Exact mechanic words
remain literal; separated `ev`/`sv` cannot be inferred as V. Known joined card
mechanics remain recognized when other query words precede them, and the
`lv x` phrase does not trigger set-prefix hydration.

For one-to-three-letter set prefixes, both search callers retrieve a bounded
name bucket from the existing SQL `/api/marketplace-card-versions` endpoint.
The request uses the confident canonical name, a 1,000-row limit and selected
title language. Concurrent callers share the same promise; identities are
deduplicated and rows retain their fetch-language stamp. Completed rows enter
the existing expiring suggestion cache. No particular ambiguous set or card
is forced into the candidate pool. Non-English name spellings are left to
server-authoritative retrieval rather than corrected against the English
local pool; exact English names remain usable under another title language.

The final followup passed **1,053 frontend tests**, **406 broader API/worker/
script JavaScript tests**, the production build, and the expanded TLC check.
The initial two missing-helper failures above were repaired independently on
`origin/main` before this followup; its isolated branch starts from `c131210`.
The standalone `market/index.test.js` still has its unchanged baseline
card-bootstrap matcher assertion failure. The broader tests reused the
matching server dependencies via `NODE_PATH` without changing source files.

Fresh-browser verification with the live catalog put regular Evolutions
Mewtwo **51/108 first** for `mewtwo e`, `mewtwo ev` and `mewtwo evo`; the latter
two retained Evolutions EX **52/108** and **103/108** immediately after it.
`charizard e` also put regular Evolutions Charizard **11/108 first**.
The page rendered without a Vite overlay. No push or deployment was performed.

## Cold retrieval and three-component regression

The Western `diagl` incident exposed two candidate losses: incomplete indexed
print facets returned only three raw hits, and every suggest response was
capped at twenty before the popup could select its print universe. A further
popup word-token gate dropped six documented compact-name typo cases even
when the local probability pool retrieved their correct identities.

Candidate hydration now requests a bounded 1,000-hit Meili window with no
indexed print restriction. Canonical nationality and title-language overlays
hydrate before the cap. Name-only English popup queries use the established
probability pool and accepted correction; mixed metadata queries retain
individual printing relevance. Existing default suggest clients still
receive twenty rows. The search handler and its helper closure now live in
`server/api/` and are included in the existing deployment overlay.

The expanded formal model adds **3,072 popup executions**: four typo names
(transposed names, a compact multiword name and a sparse keyboard typo),
every ordered pair of eight context tokens (`evol`, `base`, `ex`, `gx`, `holo`,
`arita`, `51`, `ir`), all six component permutations including repeats, and
both cache/printing directions. This is the full cross-product of that
declared finite vocabulary, not every three-word query in the TCG catalog.
It checks ranked output, eligibility, completeness, caps and stable order.

Another **52 cold probes** cover thirteen documented typo identities, All and
Western, and both response directions. Each controlled server payload holds
thirty printings, including twenty-three Western printings. Independent
invariants require the expanded unfiltered request, corrected canonical
lookup, all thirty retrieved candidates, twenty unique correctly named popup
rows, and the selected print universe. The old filter and old twenty-row
response are explicit loss witnesses at the transport boundary.

The same complete three-component vocabulary adds **3,072 cold retrieval
executions**: four typo identities × eight first-context tokens × eight
second-context tokens × six component permutations × All/Western. The raw
full-text search is empty and only canonical name lookups return candidates.
Each source has ninety real printings across plain/EX/GX names; nationality,
set, artist, rarity and collector fields vary. Invariants require all ninety
candidates to survive retrieval, the canonical lexical anchor to be requested,
twenty unique eligible displayed rows, descending relevance and no weaker
displayed row displacing a stronger omitted row. Western reverses source order.
This tests the adapter → local pool → candidate hydration → cache → popup
path, rather than assuming all relevant printings were already cached.
The first cold run caught the legacy name lock shrinking `mewtow evol ex`
to one name form before popup scoring. The returned structured result keeps
its existing name focus, while `hydrated` now retains the full candidate union
for the live cache. This preserves the Plasma/name-pool regression contract
and keeps plain/compound readings available to printing evidence.
The fixture print oracle also treats unknown nationality on the declared
Western Base Set/Evolutions expansions as Western, while preserving explicit
Japanese nationality. An earlier oracle incorrectly excluded those recovered
rows; correcting that expectation required no application change.

Compact-name pool evidence also survives metadata scoring: a known corrected
identity contributes its matched name words, rather than being rejected by a
stricter per-word ratio. Only the winning identity can supply that fallback;
an unrelated fuzzy name cannot create coverage. Repeated or leading mechanic
tokens retain token scoring so `ex ex mewtow` cannot become a sealed collection
correction with an empty Singles popup.
Mixed-query retrieval retains raw full-text and whole-name lookups while
adding scorer readings and accepted lexical anchors from that same local
pool. The supplemental lookup is bounded and leaves printing evidence in
charge of the final order; it does not force a particular card or expansion.

The other agent's `search-token-triples.test.js` and
`search-token-matrix.test.js` are retained and run. They enumerate parsing and
API-shape states across vocabulary/options; they are JavaScript sweeps rather
than TLC ranking proofs, and the set vocabulary tier is sampled.

The final JavaScript validation for this regression passed **1,124 frontend
tests**, **84 maintained API/worker/script tests** and **313 shared API tests**
(1,521 total, zero failed). The production build passed with
bundle-size/mixed-import warnings. The standalone `market/index.test.js`
baseline limitation recorded above remains outside these suites.

For browser verification, the updated maintained API modules were loaded in
a separate, read-only Node process inside the Pi container. They returned
170 Dialga-bucket hits and 395 Mewtwo-bucket hits against the live database,
including regular Evolutions Mewtwo 51/108. Those exact public responses were
provided to the isolated preview's candidate requests. The preview showed
twenty Western Dialga printings/variants for `diagl`, and regular Evolutions
Mewtwo 51/108 first for `mewtwo e`, `mewtwo evo` and `mewtow evol`.
`ex ex mewtow` showed twenty Singles instead of an empty popup. The separate
search-page process also verified the other agent's missing-await fix against
the live database (five cards, total seven for `mewtwo evo`) without the
`next.filter is not a function` crash. These were preview/in-memory checks;
no production module, branch or deployment was changed.

Final results inspected on 2026-10-02: the expanded check observed **13,396
executions** (10,272 warm popup executions, 52 cold name probes and 3,072 cold
three-component executions). All cold probe invariants passed. TLC completed
the current configuration with exit code 0: **53,040 states generated,
42,768 distinct states explored, zero states left on the queue, depth 7**.
Both old-behavior configurations failed with the required invariant
counterexamples and exit code 12. The complete run is recorded on nezopt in
`/tmp/search-regression-tlc-final9.log`. The finite vocabulary and exclusions
above remain the scope of this result.

## Unfinished name suffix correction (2026-10-02)

Giuseppe corrected the intended `mewtwo e` order: EX name matches should lead,
with regular Evolutions also near the top. The previous rule credited `e`
only as a set prefix and penalized the untyped EX word. An anchored trailing
one/two-letter suffix now also completes unmatched name words. It contributes
bounded quality only; literal EX/GX/V remain exact, and bare `e`/`ev` gain no
prefix evidence. Joint name/set readings beat either ambiguous reading alone.
Short name-only completion stays weaker than short set context, so an entire
EX cohort cannot displace every regular contextual printing.

Already-covered name words are excluded independently in each title language;
an English copy of a translated anchor cannot create another name match.
A translated anchor retains English mechanic completion. Unit cases cover
Mewtwo/Charizard/Pikachu, accepted typos, name-only/set-only/joint evidence,
prefix-to-literal boundaries and translated/same-spelling anchors.

The formal three-component vocabulary now also includes `e`: four typo names
× nine first-context tokens × nine second-context tokens × six permutations
× two directions/universes, giving **3,888 warm and 3,888 cold executions**.
The earlier short-prefix probes now require EX to lead for `e`, and regular
set matches to lead for `ev`, `evo` and `evol`.

Deployment review compared all 33 owned overlay runtime files to the current
Pi release. Two vendored helpers contained older behavior: search-debug
authorization lacked the verified-email gate, and row normalization lacked
the raw Palworld/Cyberpunk image-key exception. Both current live helpers
were preserved byte-for-byte, with regression checks for authorization and
satellite image keys, before publishing any overlay.
