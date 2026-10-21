//! Verus proofs of Pokoin's money rules for CardTrader prices
//! (`crates/external/src/ct_fees.rs`, `apps/api/src/jobs/fee_once.rs`, the
//! push claim in `crates/external/src/cardtrader/link.rs`).
//!
//! The `exec` functions are the production integer core line for line (same
//! names, same arithmetic); Verus checks them against the `spec` functions and
//! proves the lemmas below. Units: prices in whole PKN (2 PKN = 1 euro cent),
//! rates in basis points, results in 1e-8 PKN.
//!
//! Run: `verus/run.sh` (see verus/README.md).
use vstd::prelude::*;

verus! {

pub const BPS: i128 = 10_000;
pub const SCALE: i128 = 100_000_000;

// ---------------------------------------------------------------- specs

pub open spec fn fee_spec(ask: int, rate: int, min: int) -> int {
    if ask * rate > min * 10_000 { ask * rate } else { min * 10_000 }
}

pub open spec fn net_spec(ask: int, rate: int, vat: int, min: int) -> int {
    ask * 100_000_000 - fee_spec(ask, rate, min) * (10_000 + vat)
}

/// Half-up rounding to whole PKN (floor division, as `div_euclid`).
pub open spec fn round_spec(x: int) -> int {
    (x + 50_000_000) / 100_000_000
}

pub open spec fn nets_spec(cents: int, price: int, rate: int, vat: int, min: int) -> bool {
    round_spec(net_spec(cents * 2, rate, vat, min)) >= price
}

/// The rule's bounds: rates up to 30 %, VAT up to 50 % (`ct_fees::MAX_*`),
/// a minimum fee of 1 or 2 cents (production: 1 cent = 2 PKN).
pub open spec fn valid(rate: int, vat: int, min: int) -> bool {
    0 <= rate <= 3_000 && 0 <= vat <= 5_000 && 2 <= min <= 4
}

// ---------------------------------------------------------------- exec (the production core)

pub fn fee_bps(ask_pkn: i128, rate_bps: i128, min_fee_pkn: i128) -> (r: i128)
    requires
        0 <= ask_pkn <= 1_000_000_000_000,
        0 <= rate_bps <= 3_000,
        0 <= min_fee_pkn <= 4,
    ensures
        r == fee_spec(ask_pkn as int, rate_bps as int, min_fee_pkn as int),
        0 <= r <= 3_000_000_000_000_000,
{
    assert(ask_pkn * rate_bps <= 3_000_000_000_000_000) by (nonlinear_arith)
        requires 0 <= ask_pkn <= 1_000_000_000_000, 0 <= rate_bps <= 3_000;
    let pct = ask_pkn * rate_bps;
    let min = min_fee_pkn * BPS;
    if pct > min {
        pct
    } else {
        min
    }
}

pub fn net_scaled(ask_pkn: i128, rate_bps: i128, vat_bps: i128, min_fee_pkn: i128) -> (r: i128)
    requires
        0 <= ask_pkn <= 1_000_000_000_000,
        0 <= rate_bps <= 3_000,
        0 <= vat_bps <= 5_000,
        0 <= min_fee_pkn <= 4,
    ensures
        r == net_spec(ask_pkn as int, rate_bps as int, vat_bps as int, min_fee_pkn as int),
        -45_000_000_000_000_000_000 <= r <= 100_000_000_000_000_000_000,
{
    let fee = fee_bps(ask_pkn, rate_bps, min_fee_pkn);
    assert(fee * (BPS + vat_bps) <= 45_000_000_000_000_000_000) by (nonlinear_arith)
        requires 0 <= fee <= 3_000_000_000_000_000, 0 <= vat_bps <= 5_000;
    assert(ask_pkn * SCALE <= 100_000_000_000_000_000_000) by (nonlinear_arith)
        requires 0 <= ask_pkn <= 1_000_000_000_000;
    assert(fee * (BPS + vat_bps) >= 0) by (nonlinear_arith)
        requires 0 <= fee, 0 <= vat_bps;
    ask_pkn * SCALE - fee * (BPS + vat_bps)
}

/// Production: `(scaled + SCALE / 2).div_euclid(SCALE)`.
pub fn round_pkn(scaled: i128) -> (r: i128)
    requires
        -100_000_000_000_000_000_000 <= scaled <= 100_000_000_000_000_000_000,
    ensures
        r == round_spec(scaled as int),
{
    let y = scaled + SCALE / 2;
    if y >= 0 {
        y / SCALE
    } else {
        // floor division of a negative numerator
        let q = (-y + SCALE - 1) / SCALE;
        assert(-q == y as int / 100_000_000) by (nonlinear_arith)
            requires y < 0, q == (-y + 100_000_000 - 1) / 100_000_000;
        -q
    }
}

pub fn nets(cents: i128, price_pkn: i128, rate_bps: i128, vat_bps: i128, min_fee_pkn: i128) -> (r: bool)
    requires
        0 <= cents <= 500_000_000_000,
        0 <= rate_bps <= 3_000,
        0 <= vat_bps <= 5_000,
        0 <= min_fee_pkn <= 4,
    ensures
        r == nets_spec(cents as int, price_pkn as int, rate_bps as int, vat_bps as int, min_fee_pkn as int),
{
    let net = net_scaled(cents * 2, rate_bps, vat_bps, min_fee_pkn);
    round_pkn(net) >= price_pkn
}

/// The smallest whole-cent CardTrader ask that nets `price_pkn`.
pub fn gross_cents(price_pkn: i128, rate_bps: i128, vat_bps: i128, min_fee_pkn: i128) -> (c: i128)
    requires
        1 <= price_pkn <= 1_000_000_000,
        valid(rate_bps as int, vat_bps as int, min_fee_pkn as int),
    ensures
        nets_spec(c as int, price_pkn as int, rate_bps as int, vat_bps as int, min_fee_pkn as int),
        forall|d: int| 1 <= d < c ==> !nets_spec(d, price_pkn as int, rate_bps as int, vat_bps as int, min_fee_pkn as int),
        1 <= c <= price_pkn + 4,
{
    let mut cents: i128 = if price_pkn / 2 > 1 { price_pkn / 2 } else { 1 };
    let bound = price_pkn + 4;
    proof {
        assert forall|d: int| 1 <= d < cents implies !nets_spec(d, price_pkn as int, rate_bps as int, vat_bps as int, min_fee_pkn as int) by {
            lemma_below_half_never_nets(d, price_pkn as int, rate_bps as int, vat_bps as int, min_fee_pkn as int);
        }
    }
    while cents < bound && !nets(cents, price_pkn, rate_bps, vat_bps, min_fee_pkn)
        invariant
            1 <= cents <= bound,
            bound == price_pkn + 4,
            1 <= price_pkn <= 1_000_000_000,
            valid(rate_bps as int, vat_bps as int, min_fee_pkn as int),
            forall|d: int| 1 <= d < cents ==> !nets_spec(d, price_pkn as int, rate_bps as int, vat_bps as int, min_fee_pkn as int),
        decreases bound - cents,
    {
        cents = cents + 1;
    }
    proof {
        if cents == bound {
            lemma_bound_nets(price_pkn as int, rate_bps as int, vat_bps as int, min_fee_pkn as int);
        }
    }
    cents
}

/// The pricer's last step: whole PKN when asked, never under the floor.
pub fn floor_price(target_scaled: i128, whole: bool, floor_pkn_scaled: i128) -> (r: i128)
    requires
        -100_000_000_000_000_000_000 <= target_scaled <= 100_000_000_000_000_000_000,
    ensures
        r >= floor_pkn_scaled,
        r == floor_pkn_scaled || (whole ==> r == round_spec(target_scaled as int) * 100_000_000) || (!whole ==> r == target_scaled),
{
    let rounded = if whole {
        let p = round_pkn(target_scaled);
        assert(-1_000_000_000_001 <= p <= 1_000_000_000_001) by (nonlinear_arith)
            requires p == (target_scaled as int + 50_000_000) / 100_000_000,
                -100_000_000_000_000_000_000 <= target_scaled <= 100_000_000_000_000_000_000;
        p * SCALE
    } else {
        target_scaled
    };
    if rounded < floor_pkn_scaled {
        floor_pkn_scaled
    } else {
        rounded
    }
}

/// `fee_once::raise_to`: the ask to set, or 0 when the current ask already
/// nets the price. A current ask is never lowered, and a raised one nets the
/// price at the smallest cent that does.
pub fn raise_to(current_cents: i128, price_pkn: i128, rate_bps: i128, vat_bps: i128, min_fee_pkn: i128) -> (r: i128)
    requires
        0 <= current_cents <= 500_000_000_000,
        1 <= price_pkn <= 1_000_000_000,
        valid(rate_bps as int, vat_bps as int, min_fee_pkn as int),
    ensures
        (r == 0) == (current_cents > 0 && nets_spec(current_cents as int, price_pkn as int, rate_bps as int, vat_bps as int, min_fee_pkn as int)),
        r != 0 ==> r > current_cents
            && nets_spec(r as int, price_pkn as int, rate_bps as int, vat_bps as int, min_fee_pkn as int)
            && forall|d: int| 1 <= d < r ==> !nets_spec(d, price_pkn as int, rate_bps as int, vat_bps as int, min_fee_pkn as int),
{
    if current_cents > 0 && nets(current_cents, price_pkn, rate_bps, vat_bps, min_fee_pkn) {
        return 0;
    }
    let target = gross_cents(price_pkn, rate_bps, vat_bps, min_fee_pkn);
    proof {
        // The current ask does not net the price; every ask from `target` up
        // does (nets is monotonic), so the current ask is below `target`.
        if current_cents >= target {
            lemma_nets_monotonic(target as int, current_cents as int, price_pkn as int, rate_bps as int, vat_bps as int, min_fee_pkn as int);
        }
    }
    target
}

/// Netting is monotonic in the ask: a higher ask that nets the price still does.
pub proof fn lemma_nets_monotonic(c1: int, c2: int, price: int, rate: int, vat: int, min: int)
    requires 0 <= c1 <= c2, valid(rate, vat, min), nets_spec(c1, price, rate, vat, min),
    ensures nets_spec(c2, price, rate, vat, min),
{
    lemma_net_monotonic(c1 * 2, c2 * 2, rate, vat, min);
    let n1 = net_spec(c1 * 2, rate, vat, min);
    let n2 = net_spec(c2 * 2, rate, vat, min);
    vstd::arithmetic::div_mod::lemma_div_is_ordered(n1 + 50_000_000, n2 + 50_000_000, 100_000_000);
}

// ---------------------------------------------------------------- the push claim

/// A listing's `source_listing_id` as far as the push is concerned.
pub enum Source {
    Empty,
    Pending(u64),
    Linked(u64),
}

/// `CLAIM_SQL`: `update … set source = $new where id = $id and source = $read`.
pub open spec fn claim(current: Source, read: Source, new: Source) -> (Source, bool) {
    if current == read { (new, true) } else { (current, false) }
}

// ---------------------------------------------------------------- lemmas

/// The commission is never below the minimum (1 cent = 2 PKN = 2e4 in fee units).
pub proof fn lemma_fee_at_least_one_cent(ask: int, rate: int, min: int)
    requires 0 <= ask, 0 <= rate, 2 <= min,
    ensures fee_spec(ask, rate, min) >= 20_000,
{
}

/// A seller never nets more than the ask, and nets something from 2 cents up.
pub proof fn lemma_net_le_ask(ask: int, rate: int, vat: int, min: int)
    requires 0 <= ask, valid(rate, vat, min),
    ensures
        net_spec(ask, rate, vat, min) <= ask * 100_000_000,
        ask >= 4 + 2 * min ==> net_spec(ask, rate, vat, min) >= 0,
{
    assert(fee_spec(ask, rate, min) * (10_000 + vat) >= 0) by (nonlinear_arith)
        requires fee_spec(ask, rate, min) >= 0, vat >= 0;
    if ask >= 4 + 2 * min {
        if ask * rate > min * 10_000 {
            assert(ask * 100_000_000 - ask * rate * (10_000 + vat) >= 0) by (nonlinear_arith)
                requires ask >= 0, 0 <= rate <= 3_000, 0 <= vat <= 5_000;
        } else {
            assert(ask * 100_000_000 - min * 10_000 * (10_000 + vat) >= 0) by (nonlinear_arith)
                requires ask >= 4 + 2 * min, 2 <= min <= 4, 0 <= vat <= 5_000;
        }
    }
}

/// More ask never nets less.
pub proof fn lemma_net_monotonic(a1: int, a2: int, rate: int, vat: int, min: int)
    requires 0 <= a1 <= a2, valid(rate, vat, min),
    ensures net_spec(a1, rate, vat, min) <= net_spec(a2, rate, vat, min),
{
    let f1 = fee_spec(a1, rate, min);
    let f2 = fee_spec(a2, rate, min);
    // max(a·r, m) grows by at most (a2 − a1)·r.
    assert(f2 - f1 <= (a2 - a1) * rate) by (nonlinear_arith)
        requires 0 <= a1 <= a2, 0 <= rate,
            f1 == (if a1 * rate > min * 10_000 { a1 * rate } else { min * 10_000 }),
            f2 == (if a2 * rate > min * 10_000 { a2 * rate } else { min * 10_000 });
    assert((a2 - a1) * 100_000_000 - (f2 - f1) * (10_000 + vat) >= 0) by (nonlinear_arith)
        requires f2 - f1 <= (a2 - a1) * rate, 0 <= rate <= 3_000, 0 <= vat <= 5_000, a1 <= a2;
    assert(net_spec(a2, rate, vat, min) - net_spec(a1, rate, vat, min)
        == (a2 - a1) * 100_000_000 - (f2 - f1) * (10_000 + vat)) by (nonlinear_arith)
        requires
            net_spec(a1, rate, vat, min) == a1 * 100_000_000 - f1 * (10_000 + vat),
            net_spec(a2, rate, vat, min) == a2 * 100_000_000 - f2 * (10_000 + vat);
}

/// An ask under half the price (in cents) never nets the price: the loop may
/// start at `price / 2`.
pub proof fn lemma_below_half_never_nets(d: int, price: int, rate: int, vat: int, min: int)
    requires 1 <= d, 1 <= price, d < (if price / 2 > 1 { price / 2 } else { 1 }), valid(rate, vat, min),
    ensures !nets_spec(d, price, rate, vat, min),
{
    lemma_net_le_ask(d * 2, rate, vat, min);
    assert(d * 2 <= price - 2);
    let n = net_spec(d * 2, rate, vat, min);
    assert(n <= (price - 2) * 100_000_000) by (nonlinear_arith)
        requires n <= d * 2 * 100_000_000, d * 2 <= price - 2;
    assert(round_spec(n) <= price - 2) by (nonlinear_arith)
        requires n <= (price - 2) * 100_000_000;
}

/// `price + 4` cents always nets the price: the loop ends with an answer.
pub proof fn lemma_bound_nets(price: int, rate: int, vat: int, min: int)
    requires 1 <= price, valid(rate, vat, min),
    ensures nets_spec(price + 4, price, rate, vat, min),
{
    let ask = (price + 4) * 2;
    let f = fee_spec(ask, rate, min);
    let n = net_spec(ask, rate, vat, min);
    if ask * rate > min * 10_000 {
        assert(n >= price * 100_000_000) by (nonlinear_arith)
            requires n == ask * 100_000_000 - ask * rate * (10_000 + vat), ask == (price + 4) * 2,
                0 <= rate <= 3_000, 0 <= vat <= 5_000, 1 <= price;
    } else {
        assert(n >= price * 100_000_000) by (nonlinear_arith)
            requires n == ask * 100_000_000 - min * 10_000 * (10_000 + vat), ask == (price + 4) * 2,
                2 <= min <= 4, 0 <= vat <= 5_000, 1 <= price;
    }
    assert(round_spec(n) >= price) by (nonlinear_arith)
        requires n >= price * 100_000_000;
}

/// The 2026-10-21 bug, stated: listing the (already net) Pokoin price as the
/// CardTrader ask never nets that price; the fee would be taken twice.
pub proof fn lemma_listing_the_net_loses_the_fee(price_cents: int, rate: int, vat: int, min: int)
    requires 1 <= price_cents, valid(rate, vat, min),
    ensures !nets_spec(price_cents, price_cents * 2, rate, vat, min),
{
    let ask = price_cents * 2;
    let n = net_spec(ask, rate, vat, min);
    lemma_fee_at_least_one_cent(ask, rate, min);
    assert(n <= ask * 100_000_000 - 200_000_000) by (nonlinear_arith)
        requires n == ask * 100_000_000 - fee_spec(ask, rate, min) * (10_000 + vat),
            fee_spec(ask, rate, min) >= 20_000, 0 <= vat;
    assert(round_spec(n) <= ask - 2) by (nonlinear_arith)
        requires n <= ask * 100_000_000 - 200_000_000;
}

/// The fee is counted once: the gross-up's ask nets the price, and one cent
/// less does not (so no second fee is folded into the CardTrader ask).
pub proof fn lemma_fee_once(price: int, c: int, rate: int, vat: int, min: int)
    requires
        1 <= price, 1 <= c, valid(rate, vat, min),
        nets_spec(c, price, rate, vat, min),
        forall|d: int| 1 <= d < c ==> !nets_spec(d, price, rate, vat, min),
    ensures
        c == 1 || !nets_spec(c - 1, price, rate, vat, min),
{
}

/// Of two pushes that read the same source, only the first claim succeeds:
/// one CardTrader create per listing (`CLAIM_SQL`, the outbox and the
/// reconcile alike).
pub proof fn lemma_one_claim_wins(s0: Source, read: Source, first: Source, second: Source)
    requires first != read,
    ensures
        ({
            let (s1, ok1) = claim(s0, read, first);
            let (_s2, ok2) = claim(s1, read, second);
            !(ok1 && ok2)
        }),
{
}

/// A claimed listing is never claimed again by a push that read it empty.
pub proof fn lemma_pending_is_not_a_candidate(id: u64, new: Source)
    ensures claim(Source::Pending(id), Source::Empty, new).1 == false,
{
}

fn main() {
}

} // verus!
