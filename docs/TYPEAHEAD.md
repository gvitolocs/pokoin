# Typeahead: the query-hypothesis pipeline (2026-09 redesign)

Canonical for the header search bar. Related: `market/src/suggest-rank.js` header
(legacy rank blocks), `market/src/suggest-resolve.js` (hypothesis resolver),
`market/src/suggest-live.js` (paint), `docs/MARKET.md` (sold comps, unrelated).

## Shape of the pipeline today

Two engines run per keystroke; a gate decides which paints. Both feed the same
FLIP popup, the same 30-min suggest cache (`byCompact`), and the same three tabs.

```text
keystroke
  │
  ├─ resolveSuggestQuery(q)                market/src/suggest-resolve.js
  │    STEP 1  exact whole-entity lock     'palkia & dialga legend' locks as one span
  │    STEP 2  protected syntax            collectors, art/rarity aliases (parseTypedQuery)
  │    STEP 3  span candidates             word trie (multi-word entities), set-alias
  │             (legend/legen homonyms),   fuzzy rankNames over the unified 11.3k vocab
  │    STEP 4  hypothesis beam (≤8)        coverage → cost → compat → exactness → kind → popularity
  │    STEP 5  relaxation tiers            all constraints → drop weakest → strongest entity
  │
  ├─ liveSuggestGroups(q)                  market/src/suggest-live.js   (instant paint)
  │    gate = artist binding?              YES → resolver branch (intersection-first)
  │    everything else                     → legacy engine (ranked name pool + peels)
  │
  └─ fetchSuggestRanked(q, {resolved})     market/src/suggest-rank.js   (Meili hydration)
       corrected text = PRIMARY lookup     (only when resolver found artist/set/free)
       raw typed query = challenger
       popup count = corrected lookup only (never max-over-junk)
```

### Vocabulary

`NAME_POOL` (10,009 blueprint names) + `ARTIST_POOL` (444 rows: full names plus
last-name rows ≥5 letters) + `SET_POOL` (834 expansion titles), bundled from
Postgres by `scripts/export-suggest-names.py` / `export-suggest-catalog.py`.
Mechanic words are vocabulary too, but only `legend`/`legen` may bind a set
alias; `v`/`ex`/`gx`/`vmax`/`mega`… ride the name text and never bind entities.

### Scoring (split dimensions — popularity never decides kind)

Span cost buckets: exact word 0, exact prefix 0.25, capped fuzzy 0.75 + 0.1·d.
Hypothesis comparison: coverage → total cost → compatibility penalty (extra
name/artist/set entities) → exactness rank → kind rank (name < set < artist) →
popularity. In-pool ordering stays the legacy emission curve
(`exp(-4.236·d) × popularity`, keyboard/transposition costs).

### Paint

- Resolver branch (artist queries): intersection-first against the suggest
  cache — name rows ∩ artist rows; artist hydration stubs until they land;
  relaxation tiers keep the popup non-empty; print-language filter applied.
- Legacy branch: `parseTypedQuery` peels (set codes, `sl`, phrases, expansion
  prefixes, collectors, art/rarity words) → ranked name pool →
  `fillSuggestGroups` (set rows first, then the pool; mechanic-word bonus;
  rival-mechanic filter; stubs pad toward 20; jumbos to Product tab).

### Search-page parity

Enter/“View all” serializes the winning hypothesis:
`/marketplace/search?q=…&resolved=name:Pikachu~artist:yuka-morii`.
Search.jsx re-resolves the raw query locally, fetches the corrected name text,
and filters rows by `artist` (present on `marketplace_search_candidates`),
with a removable chip. Sets serialize today but the page ignores them (see
gaps).

## Nuances matrix — legacy behavior vs the new pipeline

| # | Legacy nuance (decision) | Status now |
| --- | --- | --- |
| 1 | Prefix Damerau emission, QWERTY costs, per-length typo budget (D000019/D000024) | Kept — `rankNames` unchanged; resolver fuzzy reuses it |
| 2 | Whole-compact scoring, `miikyu ex` one name; exact mechanic word +4 (D000019) | Kept on legacy branch (owns all non-artist queries) |
| 3 | Set-token peels: `hgss`, `sl`, phrases, `call of` prefix, >3-letter expansion prefixes, typos | Kept on legacy branch — resolver never owns set-only peels |
| 4 | Bare `expedition` = set browse (D00004M) | Kept — setOnly intent untouched |
| 5 | Mechanic words on the card, `pikahc gx` bonus, rival GX/V filter (D000050) | Kept — legacy branch; resolver passes mods through `parsed.raw` |
| 6 | Collectors `061/106`, `Sh1`/`TG01`; art/rarity shorthands `il/ir/sir/fa` | Kept — protected syntax both engines |
| 7 | `061 shieldon` queries the name so Potion 061/073 can't win | Kept — number+name path untouched |
| 8 | `legend`/`legen` → Call of Legends; solo `Lugia LEGEND` stays a name (D000019/D00002M) | Kept — homonym carve-out + STEP 1 lock |
| 9 | Exact blueprint never peels as set: `eevee i` (D000033/D00005N) | Kept — `namePoolHasCompact` guard + exact lock |
| 10 | Top 20 real printings, stubs pad, jumbos on Product (D00002M/D000016) | Kept — `fillSuggestGroups` both branches |
| 11 | Print-language chips western / JP / KO / CN | Kept — filter applied in every paint branch |
| 12 | Meili search-on name+number+nicknames, no expansion_aliases | Untouched |
| 13 | Prefetch from 1st char, popup at 3 compact chars (D00001X) | Untouched |
| 14 | Thumb LRU preload + hover JPEGs (D00001Y) | Untouched |
| 15 | Rank memoized per keystroke (D000026) | Resolver memoized per compact too (10 ms avg, 60 ms worst cold) |
| 16 | Users tab = sellers; three tabs (D00002I) | Untouched |
| 17 | Sealed SKUs classify as products (D00003S/D00003X) | Untouched |
| 18 | Title-language overlay on rows | Untouched |
| 19 | Artist typos recover (`kawayod` → kawayoo) (D000020) | **New** — resolver's reason to exist |
| 20 | Multi-token name+artist (`pika yuka` → intersection) | **New** |
| 21 | Popup count = corrected lookup, not max-over-junk (the 51 bug) | **New** |

## Known gaps / open edge cases (the honest list)

G1. **Relaxed-tier hydration.** Chrome hydrates only best-hypothesis artist/set
entities. If tier 1 misses and tier 2 would need another entity's cache, it is
not hydrated → paint falls back to legacy. Low frequency; fix is small.

G2. **Search page ignores `resolved` sets/numbers/rarity.** Only artist slugs
are consumed. `palkia legend` + Enter should prefill the set filter
("Call of Legends"); today the param is serialized but unused for sets.

G3. **Resolver-branch name fill.** Artist queries paint entity rows + artist
base; the ranked name-pool fill (4-per-group interleave) is legacy-only. A
future artist query with a second intended name (`kawayod charizard`) would
need tier work.

G4. **`palkia legend` semantics.** Set-rows-first-then-pool is locked fixture
behavior (`palkai sl`, `hgss energy`). A strict "only the LEGEND halves" mode
contradicts those fixtures — product call, not implemented.

G5. **Data: LEGEND halves are named `Palkia`** in the catalog, so
`palkia legend` can never name-match; the CoL alias peel is the only router.
A catalog/export fix would let STEP 1 lock it.

G6. **Meili challenger can false-succeed** — default `matchingStrategy: last`
drops the unmatched token (`yuka` in `pika yuka` raw challenger). Corrected
primary hides this; server-side `matching all` for corrected lookups is the
clean fix (cardvault change).

G7. **Deployment.** Prod must be rebuilt/redeployed (`scripts/build-web.sh`);
the pre-redesign bundle still shows the 51-junk-count behavior.

## Regression harness

`suggest-resolve.test.js` (14 fixtures), `suggest-live.test.js`,
`suggest-rank.test.js`, `suggest-catalog.test.js`, plus `2pikabench` (10/10
recovered). `locale.test.js` "Korean HGSS" failure predates the redesign
(pre-existing working-tree state).
