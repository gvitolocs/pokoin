# CardTrader seller inventory model

`CardTraderSellerInventory.tla` is the PlusCal/TLC model for connected-seller
stock, separate from Pokoin's global CardTrader market/sold-comps pipeline.

It models the two convergence paths after CardTrader stock disappears:

1. the registered order webhook updates Pokoin immediately; or
2. the periodic complete `/products/export` reconcile removes stale stock when
   a webhook is absent, delayed, or registration previously failed.

The model checks:

- state types and non-negative bounded quantities;
- after a sale has been observed and no reconciliation work remains, Pokoin
  stock equals CardTrader stock; and
- connected-seller webhook/export updates never increment Pokoin-native sold
  evidence—the sale is counted exactly once by CardTrader sold comps; and
- every CardTrader sell-out eventually becomes zero Pokoin stock under fair
  webhook/reconcile scheduling.

Run with an official TLA+ tools jar:

```bash
java -cp /path/to/tla2tools.jar pcal.trans specs/CardTraderSellerInventory.tla
java -cp /path/to/tla2tools.jar tlc2.TLC \
  -config specs/CardTraderSellerInventory.cfg \
  specs/CardTraderSellerInventory.tla
```

## Other models

- `GestureExclusivity.tla` (+ `G2-liveness.cfg`, `W1`–`W5` witnesses):
  `scripts/check-gesture-tlc.sh`, see `GESTURE-PROOF-2026-09-27.md`.
- `SearchRanking.tla`: `scripts/check-search-ranking-tlc.sh` (it generates the
  fixtures module from the real scorer first; TLC alone cannot parse the spec).
- `tla/`: the native Rust API models (`tla/run.sh`); `logika/`: Sireum Logika
  proofs (`logika/run.sh`). Last full re-run of all of them: 2026-10-11,
  results in `tla/FINDINGS.md`.
