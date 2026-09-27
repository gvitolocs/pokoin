# GestureExclusivity proof — 2026-09-27 (hardened)

Desk / shop pointer exclusivity model for the pokoin market (`specs/GestureExclusivity.tla`,
plain TLA+ — hand-translated, no PlusCal source). Supersedes the first green run of
2026-09-27 morning ("119 distinct states" era) with witnesses, liveness, and the
anti-theft cart property.

## What this run adds over the first green run

- **`CartOnlyViaDropOrBuy`** — action property replacing the vacuous
  `InvClickKeepsCart == (...) => TRUE`. The cart may only grow via
  `dropCart` or `clickBuy`; this is the formal pin of the click-add theft
  fix (commit 6bb3c1c "shop rows no longer click-add").
- **`G2-liveness`** — under `FairAssump == WF_vars(\E t \in Targets: Release(t))`
  (a fair user eventually releases the pointer; Release is the only
  unconditional gesture-terminator), gestures always terminate:
  `TermDrag == [](dragging => <> ~dragging)`, `TermBand` likewise. Catches a
  future `Release` that forgets a reset field.
- **W1–W5 witness configs** — each checks a `No*` invariant asserting the
  fixed behaviour is UNREACHABLE; TLC's counterexample (rc 12) proves the
  model still exercises it. If a witness passes, guards were over-tightened
  and the runner fails ("model too weak") — same convention as
  TaskGraphLeases `W1-fanout-witness`.
- **Runner** (`scripts/check-gesture-tlc.sh`) now uses the **pinned
  toolchain** (`/home/nez/deepseek-harness-local/formal/orchestra-tlc/toolchain`,
  TLC2 2026.09.22.222048 + bundled JRE 17) instead of ad-hoc
  `~/tools/tla/tla2tools.jar` + system java, per-config `-metadir states/<cfg>`,
  300 s timeout, `GESTURE_CHECK_BEGIN/END` markers.

## Model md5 (at proof time)

```
a2a04766d424985d0fb75e5aadfbb6d4  GestureExclusivity.tla
4eedd0f4d5d004d993107fa4730e1e19  GestureExclusivity.cfg
b03ec665465f8cb14b11db1ac89a2cae  G2-liveness.cfg
3f73d35f2bc2562db87546a9463303c0  W1-art-band-sel.cfg
932c39c5c14746b718eb826c55be4a26  W2-listing-pile.cfg
eb65a0c61262d390e3fef44479a7848b  W3-card-pile.cfg
ed88edd4f26f8f2bf189f36a6c08eb74  W4-bundle-drag.cfg
46343e80a8202ffec41b0ed2875651f9  W5-cart-drop.cfg
4d941e8d8f8843646ce2def3da2e0900  scripts/check-gesture-tlc.sh
```

Toolchain: TLC2 Version 2026.09.22.222048 (rev: 35d40c9), bundled
OpenJDK 17.0.20.1, `-XX:+UseParallelGC -workers auto`.

## Commands

```
cd /home/nez/.paseo/worktrees/2n15xc8c/tcg-paths
scripts/check-gesture-tlc.sh          # exits 0 only if safety+liveness green
                                      # AND all five witnesses fail with rc 12
node --test market/src/gesture-exclusivity.test.js   # 4/4 pass, includes the runner
```

## Results (all on 2026-09-27)

| kind | cfg | expected | rc | states generated / distinct | verdict |
| --- | --- | --- | --- | --- | --- |
| G1-safety | GestureExclusivity.cfg | pass | 0 | 216 521 / 2 596 (depth 10) | TypeOK + 11 Inv* + CartOnlyViaDropOrBuy hold |
| G2-liveness | G2-liveness.cfg | pass | 0 | 216 521 / 2 596 | TermDrag, TermBand hold under WF release |
| W1-art-band-sel | NoArtBandSel | violate | 12 | 2 643 / 93 | empty-background band reaches the desk scan |
| W2-listing-pile | NoListingPileDrag | violate | 12 | 46 651 / 1 140 | multi-listing drag produces a pile |
| W3-card-pile | NoCardPileDrag | violate | 12 | 55 783 / 1 264 | desk+related multi drag produces a pile |
| W4-bundle-drag | NoBundleDrag | violate | 12 | 2 647 / 140 | title/set/artist drag reaches "bundle" |
| W5-cart-drop | NoCartDrop | violate | 12 | 2 038 / 115 | drag-onto-CartDrop really fires |

Witness violation traces stopped the BFS early (queue not drained) — that is
the point: a short counterexample is the reachability proof.

## Fairness assumptions

- `FairAssump == WF_vars(\E t \in Targets: Release(t))` only. Release is
  enabled with a state change in every reachable state (some target always
  changes `lastTarget`), so WF forces it to recur; every gesture is cleared
  by Release, hence `TermDrag`/`TermBand`. No fairness on band paint, drag
  starts, or cart actions — the scheduler (user) may withhold those forever.

## Explicitly NOT proved

- No pointer geometry, timing, or threshold dynamics: `armed` abstracts the
  marquee threshold as a boolean; real dragstart races below the threshold
  are out of scope.
- Single pointer only; no multi-touch, no pen+touch interleaving, no second
  user.
- Keyboard modifiers and focus/blur are not modeled; Chrome is a click target
  only (the warm band across chrome clicks *is* modeled — clickChrome leaves
  `banding`/`armed` untouched).
- `cartAdds` is client-side intent; server cart behaviour is out of scope.
- Bounds: `CartBound = 2`, `PileBound = 3` (three selectable targets exist, so
  the model's pile clamp never binds — it pins the UI cap). Larger bounds only
  lengthen traces; no new interleavings appear.
- Deadlock checking stays ON; the spec has no terminal states (Release is
  always enabled).

## Unit-test pin

`market/src/gesture-exclusivity.test.js` keeps the spec/cfg names frozen
(`InvMultiDragPiles`, `InvShopRowNeverArms`, `CanBand(t) == t = BandEmpty`,
`specs/GestureExclusivity.cfg`) and runs the runner end-to-end (4/4 pass,
4.4 s).
