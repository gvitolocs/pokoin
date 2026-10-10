# TLA+ models of the native Rust API

Model-checked with TLC. One folder per model; each has `Model.tla`, `Model.cfg`
and a README that maps every action to the Rust code with `file:line`.

| Model | What it covers |
| --- | --- |
| [`ct-reconcile/`](ct-reconcile/README.md) | CardTrader seller reconcile (export, plan, guards, Redis lock) racing the order webhook |
| [`listing-outbox/`](listing-outbox/README.md) | Listings outbox: claim/lease/retry, price refresh, cache generations, CardTrader push/link/destroy |
| [`eur-fulfilment/`](eur-fulfilment/README.md) | EUR orders: reservation, Stripe webhook, buyer cancel, sweep, fulfilment lease, CardTrader buy-through |

[`FINDINGS.md`](FINDINGS.md) records every counterexample TLC found, whether
the code or the spec was wrong, and how it was resolved.

```bash
specs/tla/run.sh                 # every model's top-level *.cfg: must pass (~21 min on 12 cores)
specs/tla/run.sh --regressions   # also bugs/, design/ and witness/ configs: must each report a violation
specs/tla/run.sh eur-fulfilment  # one model
```

`run.sh` uses `~/.local/share/tla/tla2tools.jar` (override with `TLA2TOOLS`),
the official release jar from github.com/tlaplus/tlaplus/releases, and Java 11+.
It runs `java -XX:+UseParallelGC -jar tla2tools.jar -workers auto -config <cfg>
Model.tla` in each folder, keeps TLC's state files in a temporary directory, and
exits non-zero on any violation.

Config layout per model:

- `*.cfg` at the top: the fixed code (`Fixed = TRUE`); every property must hold.
- `bugs/*.cfg`: origin/main (`Fixed = FALSE`); each reproduces one finding.
- `design/*.cfg`: races accepted and documented in FINDINGS.md.
- `witness/*.cfg`: behaviour the fixed model must still reach (not vacuous).

The older specs one level up (`specs/*.tla`) model the front end and an
earlier, more abstract CardTrader inventory model; they are not run here.
