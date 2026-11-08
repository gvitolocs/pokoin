# Price ownership: one pricer when Card Rails is connected

`Model.tla` follows one Pokoin listing's price and pricing group once Card
Rails is connected (owner, 2026-11-08: Pokoin prices, Card Rails mirrors). It
is listed once through the Card Rails connector `list`, with the item's
choice, the call's, the account default, or none. After that, the following
interleave:
- pricing-group runs (Apply and the daily `pricing-groups-daily`), which read and then write;
- market moves;
- MyPokoin's listing edit (a form opened earlier, saved later) and the Pricer board;
- Card Rails `update` (a price, no price, `pricingGroupId` set or null), its `listings` pull (a cached
  row that can be stale) and its own CardTrader import;
- Pokoin's own CardTrader sync (link to an existing product, create, price edits).

Card Rails is modelled as agreed:
- it sends a price only when the seller changed it in that edit;
- it sends that price with `pricingGroupId: null`;
- its CardTrader import never writes a price into a Pokoin-linked row.

Each Pokoin rule and each Card Rails behaviour is a constant, so a `bugs/*.cfg` can turn
one off and show the bug it prevents.

The group rule (`Move`, `IsManual`) is [`Rules.tla`](Rules.tla), shared with
the conformance table below.

## What is modelled

| Spec | Rust / Card Rails |
| --- | --- |
| `ListItem` | `seller_api.rs` `list` → `list_pricing` (item, then call), then `account_default_pricing` for an unpriced item only; `price_listed_item` (a group's strategy prices an unpriced item, a priced item keeps its price) |
| `MarketMove` | the comps a strategy reads (`pricer::comps_for`) change |
| `RunRead(t)`, `RunWrite(t)` | `pricer::apply_group` → `pricing_store::group_rows` (read), then `run_plan` → `write_run_price` → `listings::update_listing_guarded` with `GroupGuard::Run(group)`: under the row lock, written only while the listing is still in that group (`GuardedRun`), else `pricing_group_left` and the run counts it in `left`. `t` ∈ {apply, daily} (`apply_post`, `run_daily`) |
| `BoardAdd`, `BoardRemove` | `POST /api/marketplace-pricing-groups` `{groupId, add}` / `{remove}` → `pricing_store::add_members` / `remove_members`, which take the listings' row locks in id order (`ADD_SQL`, `REMOVE_SQL`) |
| `MpOpen`, `MpSave` | `ListingForm.jsx`: the form reads the listing when it opens; on save `editPriceFields` (`market/src/pricing-group-note.js`) sends `pricePkn` with `pricingGroupId: null` only when the seller typed a different price (`FormSendsOnlyChanged`) |
| `MpGroup`, `MpWrite` | `PATCH /api/marketplace-listings` → `update_listing_guarded` with `GroupGuard::Manual { may_join: false }`: `pricer::apply_guard` decides `group_move` from the price read under the row lock and applies it in the write's transaction (`AtomicManual`); answers `leftPricingGroup` |
| `CrEditOther`, `CrEditPrice`, `CrPriceMyself`, `CrRejoin` | Card Rails edits: another field (no price, `CrSendsOnlyChanged`), a changed price (with `pricingGroupId: null`, `NullOnPrice`), "Price myself" (null, no price), "Priced by Pokoin" (`pricingGroupId: <group>`) |
| `UpdGroup`, `UpdWrite` | `seller_api.rs` `update` → `update_listing_guarded` with `GroupGuard::Manual { may_join: true }` (an unknown group is refused first by `BatchPricing::check`); the answer's `listing` refreshes Card Rails' row |
| `CrPull` | Card Rails' `listings` pull (`tool_listing` with `listing_pricing`: `pricingGroupId`, …) into its own row |
| `CrCtImport`, `CrSyncDirty` | Card Rails' own CardTrader import; as agreed it skips the price of a Pokoin-linked row (`CrImportSkipsLinked`). R6 wrote the ask and pushed it back as a change |
| `CtLink` | `cardtrader/sync.rs` reconcile `LinkExisting` → `link_existing_listing`: an unlinked listing takes the product's net price once (`LINK_EXISTING_LISTING_SQL`, one statement) |
| `CtPush`, `CtEditDeliver` | `link.rs` `push_unlisted` (create at the gross ask); `listing_sync::edit_cardtrader` (a Pokoin price edit reaches CardTrader as `Gross(p)`); an already-linked product's reconcile changes quantity only, never the price |

Ghost variables: `pinned` (the price in force is one the seller typed),
`wiped`, `intent`, `sneaky`, `bounces`, `defaulted`, `skipped`.

## Properties

| Name | Meaning | Rust test |
| --- | --- | --- |
| `OneOwner` (PO1) | a listing is priced by exactly one owner, its group or the seller: a typed price is never held inside a group | `price_ownership_flow::po1_one_owner_*`, `pricer::po1_po5_*` |
| `ManualPriceKept` (PO2) | a group run never overwrites a price the seller typed, until the listing joins a group again | `price_ownership_flow::po2_manual_price_kept_*` |
| `NoPriceNoChange` (PO3) | an edit with no new price and no group named changes neither the price nor the group | `price_ownership_flow::po3_no_price_no_change_*`, `pricer::po3_*`, `pricing-group-note.test.js` |
| `NoPingPong` (PO4) | Card Rails' CardTrader import and the pull never flip the row's price back and forth | Card Rails side (agreed behaviour); `bugs/r6-import-pingpong.cfg` |
| `PriceMyselfHonoured` (PO5) | after "Price myself" (or a typed price) the listing is out of any group until put back, even at the same price | `price_ownership_flow::po5_*` |
| `ListNeverRefused` (PO6) | `list` never refuses over a bad account default | `price_ownership_flow::po6_po7_*` |
| `UnpricedStaysPaused` (PO7) | a listing no group prices and the seller did not price stays unpriced (paused at 0) | `price_ownership_flow::po6_po7_*` |
| `CardRailsConverges` (PO8, liveness) | once nothing else happens, a pull brings Card Rails' row to Pokoin's price and group | `price_ownership_flow::po8_*` (the pull names the group) |

**Conformance.** `Rules.tla` holds the rule the model checks. `MoveTable.tla`
prints it for every input into `conformance/move-table.txt`, and the Rust test
`pricer::group_move_matches_the_model_table` asserts that `group_move` and
`is_manual_price` give the same answer on every row. A change to either side
fails that test until the other side matches. To regenerate the table:
```bash
cd specs/tla/price-ownership
verify-gate --mem 2G -- java -jar ~/.local/share/tla/tla2tools.jar -config conformance/MoveTable.cfg MoveTable.tla \
  | grep '^<<' > conformance/move-table.txt
```

## Configs

- `Model.cfg`: the fixed design, account default usable. Every invariant must hold.
- `default-gone.cfg`: the same, with the default's group deleted.
- `liveness.cfg`: PO8 with fairness, at smaller bounds.
- `bugs/*.cfg`: each turns one rule off and must report its violation:
  - `pre-530-manual-wiped`: Pokoin before #530;
  - `r5-stale-resend`: Card Rails R5;
  - `r6-import-pingpong`: Card Rails R6;
  - `price-myself-same-price`: no `null`;
  - `unguarded-run`: #530 as first pushed;
  - `form-resends-stale`: #530 as first pushed;
  - `naive-default`.
- `witness/*.cfg`: behaviour the fixed model must still reach:
  - a typed price leaves its group;
  - the default is used;
  - a run's write is skipped;
  - Card Rails mirrors a group's new price.

Run on nezopt with the state files on disk (they outgrow the `/tmp` tmpfs):
```bash
TMPDIR=~/scratch/tla verify-gate -- specs/tla/run.sh --regressions price-ownership   # ~15 min
```
Bounds: two groups, prices 1..2, one market move, two Card Rails edits, one
MyPokoin edit, two runs, one import, one board move. The results are in
[`../FINDINGS.md`](../FINDINGS.md).
