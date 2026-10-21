# Verus proofs

[Verus](https://github.com/verus-lang/verus) checks Rust code against
specifications with an SMT solver. These files are not part of the cargo
workspace; the normal build and tests never need Verus.

```bash
pokoin-rust/verus/run.sh            # every file; VERUS=/path/to/verus to override
```

Verus lives in user space on nezopt: `~/tools/verus/verus-x86-linux/verus`
(release 0.2026.10.18, unpacked from the GitHub release zip; it brings its
own Rust toolchain through rustup). No root is needed.

## `ct_fees.rs` — CardTrader fees, the gross-up, the pricer floor, the push claim

The `exec` functions are the production integer core of
`crates/external/src/ct_fees.rs` (`fee_bps`, `net_scaled`, `round_pkn`,
`nets`, `gross_cents`, `floor_price`) and `apps/api/src/jobs/fee_once.rs`
(`raise_to`), with the same names and arithmetic. Keep them in step: a
change to one is a change to both. Units: prices in whole PKN (2 PKN = 1
cent), rates in basis points, results in 10⁻⁸ PKN. Bounds: asks up to 10¹²
PKN, prices up to 10⁹ PKN, rates up to 30 %, VAT up to 50 %, a 1–2 cent
minimum fee. Production refuses anything outside them (`MAX_ASK_PKN`,
`MAX_PRICE_PKN`, `MAX_RATE_BPS`, `MAX_VAT_BPS`).

Result on 2026-10-21: **40 verified, 0 errors**. Proved:

| Property | Where |
| --- | --- |
| No integer overflow anywhere in the core (i128) | every `exec` function |
| The commission is at least 1 cent when the ask is positive | `lemma_fee_at_least_one_cent` |
| A seller never nets more than the ask; nets ≥ 0 from a 2-cent ask (min fee 1 cent) | `lemma_net_le_ask` |
| Net is monotonic in the ask | `lemma_net_monotonic`, `lemma_nets_monotonic` |
| The gross-up ask nets the Pokoin price, and no smaller whole-cent ask does | `gross_cents` postconditions |
| The gross-up loop terminates with an answer by `price + 4` cents | `lemma_below_half_never_nets`, `lemma_bound_nets` |
| Fee counted once: listing the (already net) Pokoin price as the CardTrader ask never nets it (the 2026-10-21 bug) | `lemma_listing_the_net_loses_the_fee` |
| Fee counted once: one cent below the gross-up ask does not net the price | `lemma_fee_once` |
| The pricer's rounding never takes a price under the configured minimum | `floor_price` postcondition |
| `fee_once` never lowers a CardTrader ask; a raised ask nets the price at the smallest cent | `raise_to` postconditions |
| Two pushes that read the same source: only the first claim succeeds (one CardTrader create per listing) | `lemma_one_claim_wins` |
| A listing with a pending claim is not claimed again | `lemma_pending_is_not_a_candidate` |

Not proved here: the float wrappers (`net_pkn`, `net_cents`, `gross_eur`)
that convert to and from the integer core at the API boundary (unit-tested,
`ct_fees::tests`), the SQL itself (`CLAIM_SQL` is modelled by `claim`), and
CardTrader's own rounding of its commission (CardTrader does not publish it;
the rule assumes the exact product).
