# Sireum Logika proofs

Slang ports, with contracts, of the pure rules that decide money or what a
buyer sees, verified with [Sireum Logika](https://github.com/sireum/kekinian)
(SMT: Z3/CVC5). Findings and results: [`../tla/FINDINGS.md`](../tla/FINDINGS.md#formal-verification-pass--2026-10-11).

| File | Ported from | Proved |
| --- | --- | --- |
| [`PokoinSort.sc`](PokoinSort.sc) | `pokoin-rust/crates/sort/src/lib.rs` | `cmp_f64`, `cmp_f64_desc`, `cmp_f64_nan_last` are total orders over IEEE-754 binary64 (NaN, ±0, infinities): range, reflexive, antisymmetric, transitive (≤, <, =); numbers keep their order; NaN last both ways |
| [`BestDeal.sc`](BestDeal.sc) | `market/src/card-desk.js` `matchDeal`, `bestDealCondition`, `shownDealCondition` | a listed chosen grade is never replaced; with priced offers in the language the shown grade is listed and the best listed; otherwise the chosen grade stays; `''` exactly when the language has no priced offer |
| [`ReconcilePlan.sc`](ReconcilePlan.sc) | `pokoin-rust/crates/external/src/cardtrader/sync_core.rs` `plan_inventory_reconcile`, `resolve_product_attachment` | Remove only for a product id absent from the export; settled rows never re-planned; unreadable/failed/incomplete exports remove nothing; mass-removal guard all-or-nothing; a link only to a listing not linked elsewhere, at most once; never link and remove one listing |
| [`bugs/*.sc`](bugs) | the code before a fix | must FAIL: `OldSortComparator` (pre-pokoin-sort), `BestDealOrigin` (pre-#317 grade, old chips), `ReconcilePlanOrigin` (origin link rule, L1) |

Each file states its abstraction at the top: what a value of the port stands
for in the real code, and what was left out and why.

## Run

```bash
specs/logika/run.sh          # verify everything + reachability probes (~12 min on nezopt)
specs/logika/run.sh --quick  # verify only (~2 min)
```

The runner verifies each `*.sc`, then turns each `// reachable` marker into
`assert(F)` one at a time and requires that to fail, so no proof passes on an
unsatisfiable path (the first `ReconcilePlan.sc` did; see FINDINGS), and
requires each `bugs/*.sc` to fail.

## Install (no sudo)

```bash
mkdir -p ~/tools/sireum && cd ~/tools/sireum
curl -sSLO https://github.com/sireum/kekinian/releases/download/4.20260810.80aad0c2/sireum-cli-linux-amd64.tar.xz
tar -xJf sireum-cli-linux-amd64.tar.xz
SIREUM_HOME=$PWD/Sireum Sireum/bin/sireum --init   # fetches Z3, CVC5, JDK
```

`SIREUM=/path/to/sireum specs/logika/run.sh` overrides the binary.
