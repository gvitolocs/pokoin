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
- every CardTrader sell-out eventually becomes zero Pokoin stock under fair
  webhook/reconcile scheduling.

Run with an official TLA+ tools jar:

```bash
java -cp /path/to/tla2tools.jar pcal.trans specs/CardTraderSellerInventory.tla
java -cp /path/to/tla2tools.jar tlc2.TLC \
  -config specs/CardTraderSellerInventory.cfg \
  specs/CardTraderSellerInventory.tla
```
