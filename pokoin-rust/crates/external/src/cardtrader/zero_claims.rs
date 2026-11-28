//! One copy, one line: how many copies of a box one Zero picking line may
//! still claim (docs/CARDTRADER_ZERO.md "One copy, one line").
//!
//! The pick handler (pokoin-commerce `zero_picks`) and the Zero list (the
//! `taken` flags of `ownTaken` / `candidates[]`) both answer through
//! [`check_claim`], so the list never offers a box the server would refuse.
//!
//! Inputs, for a pick of `quantity` copies by one line from box X:
//! - `stock`: X's `quantity_available`. The handler reads it from the row it
//!   locked. Every sale has already taken its copies out of it (the CardTrader
//!   webhook decrement), and so has every live swap *from* X (a swap takes the
//!   copies out of the picked box). A finalize changes no stock.
//! - [`BoxClaims`]: the live picks (`state = 'picked'`) on X of the *other*
//!   lines of the same scope (seller and CardTrader order). Another line is
//!   another `(item_id, line_key)`; two lines of one item (webhook allocations
//!   over two boxes) are two lines.
//!
//! The rule, with `F` = the copies other lines finalized on X and
//! `capacity = stock - F`:
//! - **Finalize** (the line's own box, the one the sale is taken to have used):
//!   with no other live claim on X it is always allowed, whatever the
//!   quantity. That is where the copies the sale took come from, which Pokoin
//!   cannot count once they are sold (no immutable original stock). With
//!   other claims it needs `capacity >= quantity`: the sold copies were
//!   already claimed, so only copies still in stock can cover another line.
//! - **Swap** (another identical box): needs `capacity >= quantity`. Other
//!   lines' swaps are not subtracted: they are already out of `stock`.
//!
//! Refusals: [`Refusal::CopyAlreadyPicked`] when other lines' claims are what
//! stops the pick (their claims used the copies up, or the stock would cover
//! the request without them); [`Refusal::InsufficientQuantity`] when the box
//! never had enough for this request (no other claim, or a request larger
//! than what is left).
//!
//! A client cannot raise any of these numbers: they come from the locked row
//! and the stored pick rows. Capacity is per order, not across orders.
//!
//! One line, one box is the other half ([`line_picked_elsewhere`]): a line that
//! already has a live pick on another copy is refused with
//! [`LINE_ALREADY_PICKED`] and the list stops offering its other boxes, so two
//! tabs of one line cannot move two boxes for one sale.

/// The error code of a claim refused because other lines have the copies.
pub const COPY_ALREADY_PICKED: &str = "copy_already_picked";
/// The message shown with it.
pub const COPY_ALREADY_PICKED_MESSAGE: &str =
    "That box's copy was already picked for another line; choose another box";

/// The error code of a pick refused because the line already picked a box.
pub const LINE_ALREADY_PICKED: &str = "line_already_picked";
/// The message shown with it.
pub const LINE_ALREADY_PICKED_MESSAGE: &str =
    "This line was already picked from another box; undo it first";

/// What a pick does with box X.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimKind {
    /// X is the line's own (allocated) box: no stock moves.
    Finalize,
    /// X is another identical box: X loses the copies.
    Swap,
}

/// The live picks on one box of the other lines of the same order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BoxClaims {
    /// How many live pick rows (any kind).
    pub picks: i64,
    /// Copies of the live `finalize` rows among them.
    pub finalized: i64,
}

impl BoxClaims {
    /// Count one live pick row of `kind` (`"finalize"` / `"swap"`).
    pub fn add(&mut self, kind: &str, quantity: i64) {
        self.picks += 1;
        if kind != "swap" {
            self.finalized += quantity.max(0);
        }
    }

    pub fn any(&self) -> bool {
        self.picks > 0
    }
}

/// Why [`check_claim`] refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `copy_already_picked`: other lines of the order have the copies.
    CopyAlreadyPicked,
    /// `insufficient_quantity`: the box holds fewer copies than the request.
    InsufficientQuantity,
}

/// Whether one line may claim `quantity` copies of a box holding `stock`,
/// given the other lines' `claims` on it (see the module doc).
pub fn check_claim(
    kind: ClaimKind,
    stock: i64,
    claims: BoxClaims,
    quantity: i64,
) -> Result<(), Refusal> {
    if kind == ClaimKind::Finalize && !claims.any() {
        return Ok(());
    }
    let stock = stock.max(0);
    let capacity = stock - claims.finalized;
    if capacity >= quantity {
        return Ok(());
    }
    match kind {
        ClaimKind::Finalize => Err(Refusal::CopyAlreadyPicked),
        ClaimKind::Swap if claims.any() && (capacity <= 0 || stock >= quantity) => {
            Err(Refusal::CopyAlreadyPicked)
        }
        ClaimKind::Swap => Err(Refusal::InsufficientQuantity),
    }
}

/// The list's `taken`: this line cannot have the box because of other lines.
pub fn taken(kind: ClaimKind, stock: i64, claims: BoxClaims, quantity: i64) -> bool {
    check_claim(kind, stock, claims, quantity) == Err(Refusal::CopyAlreadyPicked)
}

/// The copies a line already holds on a box other than `listing_id`.
///
/// A line is one box of one item (docs/CARDTRADER_ZERO.md "One line per box"),
/// so its first live pick settles it: a pick of the same line key from another
/// copy would move two boxes for one sale. `rows` are the item's live picks on
/// every copy (`(line_key, listing_id, quantity)`); the same copy is not
/// counted — it is the idempotent replay.
pub fn line_picked_elsewhere(
    rows: &[(String, String, i64)],
    line_key: &str,
    listing_id: &str,
) -> i64 {
    rows.iter()
        .filter(|(key, copy, _)| key == line_key && copy != listing_id)
        .map(|(_, _, quantity)| *quantity)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::ClaimKind::{Finalize, Swap};
    use super::*;

    fn claims(rows: &[(&str, i64)]) -> BoxClaims {
        let mut out = BoxClaims::default();
        for (kind, quantity) in rows {
            out.add(kind, *quantity);
        }
        out
    }

    const NONE: &[(&str, i64)] = &[];

    #[test]
    fn a_finalize_after_another_lines_swap_took_the_last_copy_is_refused() {
        // X held 1. Line A (default Y) swapped it out: X is 0, A's swap is live.
        let after_swap = claims(&[("swap", 1)]);
        assert_eq!(
            check_claim(Finalize, 0, after_swap, 1),
            Err(Refusal::CopyAlreadyPicked)
        );
        assert!(taken(Finalize, 0, after_swap, 1));
        // Nobody else on X: the first finalize takes the copy the sale took.
        assert_eq!(check_claim(Finalize, 0, claims(NONE), 1), Ok(()));
    }

    #[test]
    fn the_first_finalize_of_a_sold_out_box_blocks_the_other_lines() {
        let first = claims(&[("finalize", 1)]);
        assert_eq!(
            check_claim(Finalize, 0, first, 1),
            Err(Refusal::CopyAlreadyPicked)
        );
        // The reverse order: a swap from it is refused with the same code.
        assert_eq!(
            check_claim(Swap, 0, first, 1),
            Err(Refusal::CopyAlreadyPicked)
        );
        // A box with a copy left beyond the finalized one covers one more line.
        assert_eq!(check_claim(Finalize, 2, first, 1), Ok(()));
        assert_eq!(check_claim(Swap, 2, first, 1), Ok(()));
        assert_eq!(
            check_claim(Swap, 1, first, 1),
            Err(Refusal::CopyAlreadyPicked)
        );
        // Released (undo): nothing claims it, the other line may finalize.
        assert_eq!(check_claim(Finalize, 0, claims(NONE), 1), Ok(()));
    }

    #[test]
    fn a_swap_out_of_a_box_other_lines_emptied_is_copy_already_picked() {
        // X held 1, another line swapped it out: stock 0 with a live claim.
        assert_eq!(
            check_claim(Swap, 0, claims(&[("swap", 1)]), 1),
            Err(Refusal::CopyAlreadyPicked)
        );
        assert!(taken(Swap, 0, claims(&[("swap", 1)]), 1));
        // Nobody claimed it: the plain shortage keeps its code.
        assert_eq!(
            check_claim(Swap, 0, claims(NONE), 1),
            Err(Refusal::InsufficientQuantity)
        );
        assert!(!taken(Swap, 0, claims(NONE), 1));
    }

    #[test]
    fn a_request_larger_than_what_is_left_stays_insufficient_quantity() {
        // The flow test's item 23: C holds 2, item 22's swap of 1 is live,
        // item 23 asks for 5. The claims did not cause the shortage.
        assert_eq!(
            check_claim(Swap, 2, claims(&[("swap", 1)]), 5),
            Err(Refusal::InsufficientQuantity)
        );
        assert!(!taken(Swap, 2, claims(&[("swap", 1)]), 5));
        // Stock alone would cover it but another line's finalize holds a copy.
        assert_eq!(
            check_claim(Swap, 2, claims(&[("finalize", 1)]), 2),
            Err(Refusal::CopyAlreadyPicked)
        );
    }

    #[test]
    fn swaps_are_never_subtracted_twice() {
        // Item 21 swapped 2 of 3 (stock now 1); item 22 swaps 1: allowed.
        assert_eq!(check_claim(Swap, 1, claims(&[("swap", 2)]), 1), Ok(()));
        // Item 22's swap of 1 live, C back at 2 after 21's undo: item 25 takes 2.
        assert_eq!(check_claim(Swap, 2, claims(&[("swap", 1)]), 2), Ok(()));
        // Stock 3, two swaps of 1 live elsewhere: a finalize of 3 still fits.
        assert_eq!(
            check_claim(Finalize, 3, claims(&[("swap", 1), ("swap", 1)]), 3),
            Ok(())
        );
    }

    #[test]
    fn multi_copy_lines_count_their_quantity() {
        // A line of 3 finalizes a sold-out box alone.
        assert_eq!(check_claim(Finalize, 0, claims(NONE), 3), Ok(()));
        // A finalize of 2 holds 2 copies: stock 3 leaves 1 for anyone else.
        let two = claims(&[("finalize", 2)]);
        assert_eq!(check_claim(Swap, 3, two, 1), Ok(()));
        assert_eq!(
            check_claim(Swap, 3, two, 2),
            Err(Refusal::CopyAlreadyPicked)
        );
        assert_eq!(
            check_claim(Finalize, 3, two, 2),
            Err(Refusal::CopyAlreadyPicked)
        );
        // A swap of 3 out of 3 with nobody else on the box.
        assert_eq!(check_claim(Swap, 3, claims(NONE), 3), Ok(()));
        assert_eq!(
            check_claim(Swap, 3, claims(NONE), 4),
            Err(Refusal::InsufficientQuantity)
        );
    }

    #[test]
    fn a_line_picked_from_one_box_holds_no_other_box() {
        let rows = |entries: &[(&str, &str, i64)]| -> Vec<(String, String, i64)> {
            entries
                .iter()
                .map(|(key, copy, quantity)| (key.to_string(), copy.to_string(), *quantity))
                .collect()
        };
        // Two tabs, one line: the pick of the other box is what is refused.
        let two_boxes = rows(&[("11@N1", "N2", 1)]);
        assert_eq!(line_picked_elsewhere(&two_boxes, "11@N1", "N3"), 1);
        // The copy it already picked stays the idempotent replay.
        assert_eq!(line_picked_elsewhere(&two_boxes, "11@N1", "N2"), 0);
        // Another line of the same item (a webhook split) is another line.
        assert_eq!(line_picked_elsewhere(&two_boxes, "11@N9", "N3"), 0);
        // A line is settled by any live copies of it, however many rows.
        let spread = rows(&[("11@N1", "N2", 1), ("11@N1", "N3", 2), ("12@N1", "N2", 4)]);
        assert_eq!(line_picked_elsewhere(&spread, "11@N1", "N4"), 3);
        assert_eq!(line_picked_elsewhere(&[], "11@N1", "N2"), 0);
    }

    #[test]
    fn claims_count_rows_and_finalized_copies() {
        let mut out = BoxClaims::default();
        assert!(!out.any());
        out.add("finalize", 2);
        out.add("swap", 1);
        out.add("finalize", -4);
        assert_eq!(
            out,
            BoxClaims {
                picks: 3,
                finalized: 2
            }
        );
        assert!(out.any());
        // Negative stock (never stored, check constraint) reads as none.
        assert_eq!(
            check_claim(Swap, -1, claims(&[("swap", 1)]), 1),
            Err(Refusal::CopyAlreadyPicked)
        );
    }
}
