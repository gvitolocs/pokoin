//! BuySell buy orders: the pure rules (validation, expiry, derived state).
//!
//! Version 1 is non-binding. An order stores a standing offer; what is left of
//! it and whether it is live are derived from its fills, never stored. The SQL
//! fragment in `handlers::buy_orders` and `derive_state` below say the same
//! thing and are kept side by side.

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

pub const CONDITIONS: [&str; 5] = ["NM", "SP", "MP", "PL", "Poor"];
/// The values `days` may take; `null` means until cancelled.
pub const DAYS: [i64; 5] = [1, 7, 30, 60, 90];
pub const MIN_QUANTITY: i64 = 1;
pub const MAX_QUANTITY: i64 = 10;
/// Open orders one buyer may hold at the same time.
pub const MAX_OPEN_ORDERS: i64 = 100;
/// How long a seller's private note to the buyer may be, counted in Unicode
/// scalar values. The migration enforces the same ceiling.
pub const MAX_BUYER_MESSAGE_CHARS: usize = 240;
/// The listing handler sets no ceiling of its own; this keeps a typo out of
/// the book (and inside `numeric`).
pub const MAX_PRICE_PKN: f64 = 1_000_000_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Open,
    Filled,
    Expired,
    Cancelled,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Open => "open",
            State::Filled => "filled",
            State::Expired => "expired",
            State::Cancelled => "cancelled",
        }
    }
}

/// `quantity - counted fills`, never below zero.
pub fn remaining(quantity: i64, counted: i64) -> i64 {
    (quantity - counted).max(0)
}

/// Cancelled beats everything, then filled, then expired.
pub fn derive_state(
    status: &str,
    quantity: i64,
    counted: i64,
    expires_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> State {
    if status != "open" {
        return State::Cancelled;
    }
    if remaining(quantity, counted) == 0 {
        return State::Filled;
    }
    match expires_at {
        Some(at) if at <= now => State::Expired,
        _ => State::Open,
    }
}

/// An offer a seller can still sell into.
pub fn is_live(state: State) -> bool {
    state == State::Open
}

/// Condition code from the listing vocabulary (`NM SP MP PL Poor`), any case.
pub fn parse_condition(raw: &str) -> Result<&'static str, &'static str> {
    let key = raw.trim();
    CONDITIONS
        .iter()
        .find(|code| code.eq_ignore_ascii_case(key))
        .copied()
        .ok_or("invalid_condition")
}

/// Upper-case language code from the fixed list the price book uses.
pub fn parse_language(raw: &str) -> Result<String, &'static str> {
    let upper = raw.trim().to_ascii_uppercase();
    if crate::price_export::language_code(&upper).is_some() {
        Ok(upper)
    } else {
        Err("invalid_language")
    }
}

/// A finite price above zero and at most [`MAX_PRICE_PKN`]. Numbers and
/// numeric strings are accepted, like the listing body.
pub fn parse_price(value: &Value) -> Result<f64, &'static str> {
    let price = crate::listing_live::number(value);
    if value.is_null()
        || value.is_boolean()
        || !price.is_finite()
        || price <= 0.0
        || price > MAX_PRICE_PKN
    {
        return Err("invalid_price");
    }
    Ok(price)
}

/// A whole number of copies, 1 to 10.
pub fn parse_quantity(value: &Value) -> Result<i64, &'static str> {
    let n = crate::listing_live::number(value);
    if value.is_null()
        || value.is_boolean()
        || !n.is_finite()
        || n.fract() != 0.0
        || n < MIN_QUANTITY as f64
        || n > MAX_QUANTITY as f64
    {
        return Err("invalid_quantity");
    }
    Ok(n as i64)
}

/// `Some(days)` for 1/7/30/60/90, `None` for `null`; anything else is invalid.
pub fn parse_days(value: &Value) -> Result<Option<i64>, &'static str> {
    match value {
        Value::Null => Ok(None),
        Value::Number(n) => n
            .as_i64()
            .filter(|days| DAYS.contains(days))
            .map(Some)
            .ok_or("invalid_days"),
        _ => Err("invalid_days"),
    }
}

/// `expires_at` for an order placed (or re-timed) at `now`.
pub fn expiry(now: DateTime<Utc>, days: Option<i64>) -> Option<DateTime<Utc>> {
    days.map(|days| now + Duration::days(days))
}

/// The seller's optional private note to the buyer on "Sell now", read from
/// the `buyer_message` key of a sell body. `Ok(text)` is what is stored and
/// mailed; `Ok(String::new())` means there is nothing to say. Newlines are
/// normalised to `\n` and the ends are trimmed; a note that is not a plain
/// string, that is too long or that carries a control character other than a
/// newline is rejected whole, never truncated. Markup is kept as the seller
/// typed it — escaping happens where the note is rendered.
pub fn parse_buyer_message(value: &Value) -> Result<String, &'static str> {
    let invalid = "invalid_buyer_message";
    match value {
        Value::Null => Ok(String::new()),
        Value::String(raw) => {
            let folded = raw.replace("\r\n", "\n").replace('\r', "\n");
            let text = folded.trim().to_string();
            if text.is_empty() {
                return Ok(String::new());
            }
            if text.chars().count() > MAX_BUYER_MESSAGE_CHARS {
                return Err(invalid);
            }
            if text.chars().any(|ch| ch.is_control() && ch != '\n') {
                return Err(invalid);
            }
            Ok(text)
        }
        _ => Err(invalid),
    }
}

/// Why a seller cannot sell `quantity` into an order right now, if they can't.
/// The order of the checks is the order of the API contract.
pub fn check_sellable(
    state: State,
    buyer_uid: &str,
    seller_uid: &str,
    remaining: i64,
    quantity: i64,
) -> Result<(), (u16, &'static str)> {
    if !is_live(state) {
        return Err((409, "not_open"));
    }
    if buyer_uid == seller_uid {
        return Err((403, "own_buy_order"));
    }
    if quantity > remaining {
        return Err((409, "quantity_exceeds_remaining"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn at(day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, day, 12, 0, 0).unwrap()
    }

    #[test]
    fn remaining_never_goes_negative() {
        assert_eq!(remaining(3, 1), 2);
        assert_eq!(remaining(3, 3), 0);
        assert_eq!(remaining(3, 5), 0);
        assert_eq!(remaining(1, 0), 1);
    }

    #[test]
    fn state_is_derived_from_status_fills_and_expiry() {
        let now = at(10);
        assert_eq!(derive_state("open", 2, 0, None, now), State::Open);
        assert_eq!(derive_state("open", 2, 1, Some(at(11)), now), State::Open);
        assert_eq!(derive_state("open", 2, 0, Some(at(9)), now), State::Expired);
        // The expiry instant itself is already expired (`expires_at > now()` is live).
        assert_eq!(derive_state("open", 2, 0, Some(now), now), State::Expired);
        assert_eq!(derive_state("open", 2, 2, None, now), State::Filled);
        assert_eq!(derive_state("open", 2, 3, None, now), State::Filled);
        // Filled wins over expired; cancelled wins over both.
        assert_eq!(derive_state("open", 2, 2, Some(at(9)), now), State::Filled);
        assert_eq!(derive_state("cancelled", 2, 0, None, now), State::Cancelled);
        assert_eq!(
            derive_state("cancelled", 2, 2, Some(at(9)), now),
            State::Cancelled
        );
        assert!(is_live(State::Open));
        for state in [State::Filled, State::Expired, State::Cancelled] {
            assert!(!is_live(state));
        }
        assert_eq!(State::Expired.as_str(), "expired");
    }

    #[test]
    fn conditions_and_languages_are_closed_sets() {
        for code in CONDITIONS {
            assert_eq!(parse_condition(code), Ok(code));
        }
        assert_eq!(parse_condition(" nm "), Ok("NM"));
        assert_eq!(parse_condition("poor"), Ok("Poor"));
        assert_eq!(parse_condition("Mint"), Err("invalid_condition"));
        assert_eq!(parse_condition(""), Err("invalid_condition"));
        assert_eq!(parse_language(" jp "), Ok("JP".to_string()));
        assert_eq!(parse_language("zht"), Ok("ZHT".to_string()));
        assert_eq!(parse_language("XX"), Err("invalid_language"));
        assert_eq!(parse_language(""), Err("invalid_language"));
    }

    #[test]
    fn price_must_be_finite_positive_and_bounded() {
        assert_eq!(parse_price(&json!(12.5)), Ok(12.5));
        assert_eq!(parse_price(&json!("40")), Ok(40.0));
        assert_eq!(parse_price(&json!(MAX_PRICE_PKN)), Ok(MAX_PRICE_PKN));
        for bad in [
            json!(0),
            json!(-1),
            json!(null),
            json!("abc"),
            json!(MAX_PRICE_PKN + 1.0),
            json!(true),
            json!([]),
            json!({}),
        ] {
            assert_eq!(parse_price(&bad), Err("invalid_price"), "{bad}");
        }
    }

    #[test]
    fn quantity_is_one_to_ten_whole_copies() {
        assert_eq!(parse_quantity(&json!(1)), Ok(1));
        assert_eq!(parse_quantity(&json!(10)), Ok(10));
        assert_eq!(parse_quantity(&json!("3")), Ok(3));
        for bad in [
            json!(0),
            json!(11),
            json!(1.5),
            json!(-2),
            json!(null),
            json!("x"),
        ] {
            assert_eq!(parse_quantity(&bad), Err("invalid_quantity"), "{bad}");
        }
    }

    #[test]
    fn days_are_a_fixed_menu_or_null() {
        for days in DAYS {
            assert_eq!(parse_days(&json!(days)), Ok(Some(days)));
        }
        assert_eq!(parse_days(&json!(null)), Ok(None));
        for bad in [
            json!(0),
            json!(2),
            json!(365),
            json!(-7),
            json!(7.5),
            json!("7"),
            json!(true),
        ] {
            assert_eq!(parse_days(&bad), Err("invalid_days"), "{bad}");
        }
    }

    #[test]
    fn expiry_counts_days_from_now() {
        let now = at(10);
        assert_eq!(expiry(now, None), None);
        assert_eq!(expiry(now, Some(1)), Some(at(11)));
        assert_eq!(expiry(now, Some(7)), Some(at(17)));
        assert_eq!(expiry(now, Some(30)), Some(now + Duration::days(30)));
    }

    #[test]
    fn sell_checks_follow_the_contract_order() {
        let ok = check_sellable(State::Open, "buyer", "seller", 2, 2);
        assert_eq!(ok, Ok(()));
        assert_eq!(
            check_sellable(State::Filled, "buyer", "seller", 0, 1),
            Err((409, "not_open"))
        );
        assert_eq!(
            check_sellable(State::Expired, "buyer", "seller", 1, 1),
            Err((409, "not_open"))
        );
        assert_eq!(
            check_sellable(State::Cancelled, "buyer", "buyer", 1, 1),
            Err((409, "not_open"))
        );
        assert_eq!(
            check_sellable(State::Open, "buyer", "buyer", 1, 1),
            Err((403, "own_buy_order"))
        );
        assert_eq!(
            check_sellable(State::Open, "buyer", "seller", 1, 2),
            Err((409, "quantity_exceeds_remaining"))
        );
    }

    #[test]
    fn an_absent_or_blank_note_is_no_note() {
        for value in [
            Value::Null,
            json!(""),
            json!("   "),
            json!("\n \t \r\n "),
            json!("\u{a0}\u{a0}"),
        ] {
            assert_eq!(parse_buyer_message(&value), Ok(String::new()), "{value}");
        }
        // A key that was never sent reads as null.
        assert_eq!(
            parse_buyer_message(&json!({ "quantity": 1 })["buyer_message"]),
            Ok(String::new())
        );
    }

    #[test]
    fn a_note_is_folded_and_trimmed_but_otherwise_untouched() {
        assert_eq!(parse_buyer_message(&json!("a\r\nb")), Ok("a\nb".into()));
        assert_eq!(parse_buyer_message(&json!("a\rb")), Ok("a\nb".into()));
        assert_eq!(
            parse_buyer_message(&json!("  7 days, ship Monday\r\n\ntext  ")),
            Ok("7 days, ship Monday\n\ntext".to_string())
        );
        // Not markup: what the seller typed survives to the renderer.
        for raw in [
            "<script>alert(1)</script>",
            "Bob's \"sleeved\" & mint <NM> cards",
            "a & b < c > d \"e\" 'f'",
            "Sleeved ✓ 日本語",
        ] {
            assert_eq!(parse_buyer_message(&json!(raw)), Ok(raw.to_string()));
        }
    }

    #[test]
    fn a_note_counts_scalar_values_and_stops_at_240() {
        let ascii = "a".repeat(MAX_BUYER_MESSAGE_CHARS);
        assert_eq!(ascii.len(), MAX_BUYER_MESSAGE_CHARS);
        assert_eq!(
            parse_buyer_message(&json!(ascii.as_str())),
            Ok(ascii.clone())
        );
        let emoji = "🐱".repeat(MAX_BUYER_MESSAGE_CHARS);
        // Four bytes and two UTF-16 units apiece; still 240 characters.
        assert_eq!(emoji.len(), MAX_BUYER_MESSAGE_CHARS * 4);
        assert_eq!(
            parse_buyer_message(&json!(emoji.as_str())),
            Ok(emoji.clone())
        );
        for over in [
            "a".repeat(MAX_BUYER_MESSAGE_CHARS + 1),
            "🐱".repeat(MAX_BUYER_MESSAGE_CHARS + 1),
        ] {
            // Rejected whole, never truncated to fit.
            assert_eq!(
                parse_buyer_message(&json!(over.as_str())),
                Err("invalid_buyer_message"),
                "length {}",
                over.chars().count()
            );
        }
        // Trimmed first, so padding never pushes a valid note over the line.
        assert_eq!(
            parse_buyer_message(&json!(format!("  {emoji}  ").as_str())),
            Ok(emoji)
        );
    }

    #[test]
    fn a_note_is_a_string_without_control_characters() {
        for not_a_string in [
            json!(1),
            json!(1.5),
            json!(true),
            json!([]),
            json!({"a": 1}),
        ] {
            assert_eq!(
                parse_buyer_message(&not_a_string),
                Err("invalid_buyer_message"),
                "{not_a_string}"
            );
        }
        for control in ['\u{7}', '\u{0}', '\u{1b}', '\u{7f}', '\u{85}', '\u{9f}'] {
            let raw = format!("ship Monday{control}please");
            assert_eq!(
                parse_buyer_message(&json!(raw)),
                Err("invalid_buyer_message"),
                "{:?}",
                control
            );
        }
        // A newline, however it is written, is the one allowed control.
        assert_eq!(parse_buyer_message(&json!("a\n\nb")), Ok("a\n\nb".into()));
    }
}
