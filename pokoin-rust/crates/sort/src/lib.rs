//! Total orders for `f64` sort keys.
//!
//! `a.partial_cmp(&b).unwrap_or(Ordering::Equal)` makes NaN equal to every
//! number, which is not transitive (1 = NaN = 2, yet 1 < 2). Rust's sort
//! notices and panics with "user-provided comparison function does not
//! correctly implement a total order". Ported JS makes NaN easily
//! (`Number(undefined)`, `0 / 0`), so float sort keys go through these:
//! numbers keep their `partial_cmp` order (so `-0.0 == 0.0`), and NaN sorts
//! after every number in both directions.

use std::cmp::Ordering;

/// Ascending, NaN last.
pub fn cmp_f64(left: f64, right: f64) -> Ordering {
    cmp_f64_nan_last(left, right, false)
}

/// Descending, NaN last.
pub fn cmp_f64_desc(left: f64, right: f64) -> Ordering {
    cmp_f64_nan_last(left, right, true)
}

/// Ascending or descending; NaN last either way.
pub fn cmp_f64_nan_last(left: f64, right: f64, descending: bool) -> Ordering {
    match (left.is_nan(), right.is_nan()) {
        (false, false) => {
            let order = left.partial_cmp(&right).unwrap_or(Ordering::Equal);
            if descending {
                order.reverse()
            } else {
                order
            }
        }
        (left_nan, right_nan) => left_nan.cmp(&right_nan),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALUES: [f64; 9] = [f64::NEG_INFINITY, -2.5, -0.0, 0.0, 1.0, 1.0, 7.25, f64::INFINITY, f64::NAN];

    fn is_total_order(cmp: fn(f64, f64) -> Ordering) -> bool {
        let values: Vec<f64> = VALUES.iter().copied().chain([-f64::NAN, 0.0 / 0.0]).collect();
        values.iter().all(|&a| {
            cmp(a, a) == Ordering::Equal
                && values.iter().all(|&b| {
                    cmp(a, b) == cmp(b, a).reverse()
                        && values.iter().all(|&c| !(cmp(a, b) != Ordering::Greater && cmp(b, c) != Ordering::Greater) || cmp(a, c) != Ordering::Greater)
                })
        })
    }

    #[test]
    fn both_directions_are_total_orders() {
        assert!(is_total_order(cmp_f64));
        assert!(is_total_order(cmp_f64_desc));
    }

    #[test]
    fn the_old_comparator_is_not() {
        let old = |a: f64, b: f64| a.partial_cmp(&b).unwrap_or(Ordering::Equal);
        // 1 = NaN and NaN = 2, but 1 < 2.
        assert_eq!(old(1.0, f64::NAN), Ordering::Equal);
        assert_eq!(old(f64::NAN, 2.0), Ordering::Equal);
        assert_eq!(old(1.0, 2.0), Ordering::Less);
    }

    #[test]
    fn numbers_keep_their_order_and_nan_goes_last() {
        // Long enough for the std sort's merge path, with NaN scattered through.
        let mut values: Vec<f64> = (0..600).map(|i| if i % 7 == 3 { f64::NAN } else { ((i * 7919) % 613) as f64 / 3.0 - 50.0 }).collect();
        let finite: Vec<f64> = values.iter().copied().filter(|v| !v.is_nan()).collect();
        values.sort_by(|a, b| cmp_f64(*a, *b));
        let (head, tail) = values.split_at(finite.len());
        assert!(head.windows(2).all(|w| w[0] <= w[1]));
        assert!(tail.iter().all(|v| v.is_nan()));
        values.sort_by(|a, b| cmp_f64_desc(*a, *b));
        let (head, tail) = values.split_at(finite.len());
        assert!(head.windows(2).all(|w| w[0] >= w[1]));
        assert!(tail.iter().all(|v| v.is_nan()));
    }

    #[test]
    fn signed_zeros_stay_equal() {
        assert_eq!(cmp_f64(-0.0, 0.0), Ordering::Equal);
        assert_eq!(cmp_f64_desc(0.0, -0.0), Ordering::Equal);
    }
}
