//! The Pokémon sold rules, night by night, on tiny books.

use std::collections::HashMap;

use cardtrader_sold::engine::{Engine, Night, Reason, Status};
use cardtrader_sold::listing::{Listing, Shaper};
use cardtrader_sold::sold::sold_rows;
use serde_json::json;

const D0: i32 = 740_000;
const EXPANSION: i64 = 10;

struct Book {
    shaper: Shaper,
    engine: Engine,
}

fn product(id: u64, blueprint: i64, seller: u64, qty: i64, cents: i64) -> serde_json::Value {
    json!({"id": id, "blueprint_id": blueprint, "quantity": qty, "price_cents": cents,
        "properties_hash": {"condition": "Near Mint", "mtg_language": "en"},
        "user": {"id": seller, "username": format!("seller{seller}")}})
}

impl Book {
    fn new() -> Self {
        Self {
            shaper: Shaper::new(0.005, HashMap::new()),
            engine: Engine::default(),
        }
    }

    fn rows(&mut self, products: &[serde_json::Value]) -> Vec<Listing> {
        products
            .iter()
            .filter_map(|p| self.shaper.listing(p, None))
            .collect()
    }

    /// One night with one expansion book.
    fn night(&mut self, day: i32, products: &[serde_json::Value]) {
        let rows = self.rows(products);
        let night = Night::new(D0 + day);
        self.engine.expansion(night, EXPANSION, rows);
        self.engine.finalize(night);
    }

    fn episodes(&self, listing: u64) -> Vec<(i32, Reason, Status, i32, bool)> {
        self.engine
            .episodes
            .iter()
            .filter(|e| e.listing.id == listing)
            .map(|e| {
                (
                    e.removed_day - D0,
                    e.reason,
                    e.status,
                    e.listing.quantity,
                    e.observed,
                )
            })
            .collect()
    }
}

/// Keeps blueprint 1 non-empty so a vanish is not an "empty book" freeze.
fn keeper() -> serde_json::Value {
    product(900, 1, 99, 1, 500)
}

#[test]
fn a_vanished_stack_counts_after_three_complete_absences() {
    let mut b = Book::new();
    for day in 0..4 {
        b.night(day, &[product(1, 1, 7, 2, 1000), keeper()]);
    }
    b.night(4, &[keeper()]);
    assert_eq!(
        b.episodes(1),
        vec![(4, Reason::InferredSale, Status::Pending, 2, false)]
    );
    b.night(5, &[keeper()]);
    assert_eq!(b.episodes(1)[0].2, Status::Pending);
    b.night(6, &[keeper()]);
    assert_eq!(
        b.episodes(1),
        vec![(4, Reason::InferredSale, Status::Provisional, 2, true)]
    );
    let rows = sold_rows(&b.engine, &b.shaper.strings, D0, D0 + 6);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].key.day, D0 + 4);
    assert_eq!(rows[0].key.condition, "NM");
    assert_eq!(rows[0].key.language, "EN");
    assert_eq!(rows[0].sold_qty, 2);
    assert_eq!(rows[0].median_pkn, 2000.0);
}

#[test]
fn a_new_listing_id_for_the_same_stack_is_rotation_not_a_sale() {
    let mut b = Book::new();
    for day in 0..4 {
        b.night(day, &[product(1, 1, 7, 2, 1000), keeper()]);
    }
    b.night(4, &[product(2, 1, 7, 2, 900), keeper()]);
    assert_eq!(b.episodes(1)[0].1, Reason::ListingIdRotated);
    for day in 5..8 {
        b.night(day, &[product(2, 1, 7, 2, 900), keeper()]);
    }
    assert!(sold_rows(&b.engine, &b.shaper.strings, D0, D0 + 8).is_empty());
}

#[test]
fn a_partly_sold_stack_counts_only_the_missing_copies() {
    let mut b = Book::new();
    for day in 0..4 {
        b.night(day, &[product(1, 1, 7, 5, 1000), keeper()]);
    }
    // Same seller stack under a new id with 2 of the 5 copies.
    b.night(4, &[product(2, 1, 7, 2, 1000), keeper()]);
    assert_eq!(b.episodes(1)[0].1, Reason::InferredSale);
    // The stack delta attributes 5 - 2 = 3 copies, then 088 continuity credits
    // the 2 successor copies once more: the live writer keeps a residual of 1.
    assert_eq!(b.episodes(1)[0].3, 1);
}

#[test]
fn quantity_drips_count_and_are_retracted_when_the_listing_is_still_there() {
    let mut b = Book::new();
    for day in 0..4 {
        b.night(day, &[product(1, 1, 7, 5, 1000), keeper()]);
    }
    b.night(4, &[product(1, 1, 7, 3, 1000), keeper()]);
    assert_eq!(
        b.episodes(1),
        vec![(4, Reason::QuantityDecreased, Status::Provisional, 2, true)]
    );
    // The live writer's correction step retracts open episodes whose listing
    // id is back in the book, drips included (production parity).
    b.night(5, &[product(1, 1, 7, 3, 1000), keeper()]);
    assert_eq!(b.episodes(1)[0].2, Status::Retracted);
    // A drip followed by the listing vanishing keeps the drip.
    let mut b = Book::new();
    for day in 0..4 {
        b.night(day, &[product(1, 1, 7, 5, 1000), keeper()]);
    }
    b.night(4, &[product(1, 1, 7, 3, 1000), keeper()]);
    b.night(5, &[keeper()]);
    assert_eq!(
        b.episodes(1)[0],
        (4, Reason::QuantityDecreased, Status::Provisional, 2, true)
    );
}

#[test]
fn listings_under_three_days_old_never_sell() {
    let mut b = Book::new();
    b.night(0, &[keeper()]);
    b.night(1, &[product(1, 1, 7, 1, 1000), keeper()]);
    for day in 2..6 {
        b.night(day, &[keeper()]);
    }
    assert_eq!(b.episodes(1)[0].1, Reason::YoungListingRemoved);
    assert!(sold_rows(&b.engine, &b.shaper.strings, D0, D0 + 6).is_empty());
}

#[test]
fn an_emptied_blueprint_is_frozen_not_sold() {
    let mut b = Book::new();
    for day in 0..4 {
        b.night(day, &[product(1, 2, 7, 1, 1000), keeper()]);
    }
    for day in 4..8 {
        b.night(day, &[keeper()]);
    }
    // 093: an empty book with live listings is frozen. The vanish is recorded
    // with no complete absence and can never be confirmed while it stays empty.
    assert_eq!(
        b.episodes(1),
        vec![(4, Reason::InferredSale, Status::Pending, 1, false)]
    );
    assert!(b.engine.books[&2].contains_key(&1));
    assert!(sold_rows(&b.engine, &b.shaper.strings, D0, D0 + 8).is_empty());
}

#[test]
fn a_seller_on_vacation_sells_nothing() {
    let mut b = Book::new();
    for day in 0..4 {
        b.night(
            day,
            &[
                product(1, 1, 7, 1, 1000),
                product(3, 1, 7, 1, 1000),
                keeper(),
            ],
        );
    }
    let mut away = product(3, 1, 7, 1, 1000);
    away["on_vacation"] = json!(true);
    b.night(4, &[away, keeper()]);
    assert!(b.episodes(1).is_empty());
}

#[test]
fn a_missing_book_turns_the_next_vanishes_into_a_cutover() {
    let mut b = Book::new();
    for day in 0..4 {
        b.night(day, &[product(1, 1, 7, 1, 1000), keeper()]);
    }
    // Nights 4 and 5 have no book for this expansion.
    for day in 6..10 {
        b.night(day, &[keeper()]);
    }
    assert_eq!(b.episodes(1)[0].1, Reason::CompleteBookCutover);
    assert!(sold_rows(&b.engine, &b.shaper.strings, D0, D0 + 10).is_empty());
}

#[test]
fn a_whole_shop_gone_in_one_day_is_vacation() {
    let mut b = Book::new();
    let shop: Vec<_> = (0..6)
        .map(|i| product(100 + i, 1 + (i as i64 % 3), 7, 1, 1000))
        .collect();
    let keepers: Vec<_> = (1..4)
        .map(|bp| product(900 + bp as u64, bp, 99, 1, 500))
        .collect();
    for day in 0..4 {
        let mut all = shop.clone();
        all.extend(keepers.clone());
        b.night(day, &all);
    }
    b.night(4, &keepers);
    let reasons: Vec<_> = (100..106)
        .flat_map(|id| b.episodes(id))
        .map(|e| e.1)
        .collect();
    assert_eq!(reasons, vec![Reason::SellerOnVacation; 6]);
    assert_eq!(b.engine.vacation.values().filter(|v| **v).count(), 1);
}

#[test]
fn foil_stacks_are_separate_and_plot_as_reverse() {
    let mut b = Book::new();
    let mut foil = product(1, 1, 7, 1, 3000);
    foil["properties_hash"]["mtg_foil"] = json!(true);
    let plain = product(2, 1, 7, 1, 1000);
    for day in 0..4 {
        b.night(day, &[foil.clone(), plain.clone(), keeper()]);
    }
    // The foil copy sells; the same seller's non-foil stack stays.
    for day in 4..7 {
        b.night(day, &[plain.clone(), keeper()]);
    }
    let rows = sold_rows(&b.engine, &b.shaper.strings, D0, D0 + 7);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].key.reverse);
    assert_eq!(rows[0].median_pkn, 6000.0);
}
