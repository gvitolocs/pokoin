# Shared search ranking verification

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

The bridge evaluates **5,940 finite popup executions** across six scenarios:

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

For every bounded execution, TLC replays the actual JavaScript result one row
at a time. Independent invariants require descending relevance, a result cap,
unique eligible identities, all available eligible printings when the cap has
room, and no lower-score selection displacing a higher-score omitted printing.
An exact reference sequence also requires deterministic tie ordering across
cache and within-group insertion orders. Score probes verify coverage priority,
a small accepted name typo beating a metadata-only match with equal coverage,
and a penalty for an unmatched extra name word even when another query word
matches the set. Every pair of fixture rows also checks coverage priority.

The Node bridge supplies an empty custom local name-ranking pool to
`liveSuggestGroups`. This avoids repeating candidate-vocabulary retrieval for
thousands of permutations while retaining the real cache, printing scorer,
eligibility gates and result filling. Retrieval recall is covered by the
JavaScript test suite, not this TLC model.

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

## Limits

This is exhaustive over the generated finite executions, not a proof over the
entire catalog or every query. It does not model Unicode normalization, edit
matrix correctness, Meili retrieval, localized hydration, asynchronous response
content changes, network errors, cache expiration, or browser rendering.
Fixtures hold hydrated fields constant while varying their insertion order.
JavaScript unit and corpus tests remain necessary for those wider concerns.
Scores are represented as integers at six-decimal precision; the selected
fixtures use score differences substantially larger than that precision.
The hand-written TLA+ checks observed JavaScript outputs independently; it does
not assert that a hand-translated selector is identical to arbitrary future
JavaScript implementations.
