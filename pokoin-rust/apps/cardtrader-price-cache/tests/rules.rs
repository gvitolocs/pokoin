use cardtrader_price_cache::{
    checkout_rate, eligible_cardtrader, flag_is_true, format_rat, is_one_day_ready, parse_rat,
    price_to_pkn, rank, Offer, Provider,
};
use serde_json::{json, Value};

fn rate() -> cardtrader_price_cache::Rat {
    checkout_rate(None)
}

fn pkn(eur: &str, raw_rate: Option<&str>) -> String {
    format_rat(price_to_pkn(parse_rat(eur).unwrap(), checkout_rate(raw_rate)).unwrap())
}

#[test]
fn flag_truthiness_matches_the_oracle_text_form() {
    for value in [
        json!(true),
        json!("true"),
        json!("TRUE"),
        json!(" yes "),
        json!("Y"),
        json!(1),
        json!("1"),
    ] {
        assert!(flag_is_true(&value), "{value}");
    }
    for value in [
        json!(false),
        json!("false"),
        json!("no"),
        json!(0),
        json!("0"),
        json!(null),
        json!(""),
    ] {
        assert!(!flag_is_true(&value), "{value}");
    }
}

#[test]
fn one_day_ready_matcher() {
    for text in [
        "Shop 1-Day Ready",
        "1 day ready",
        "One-Day-Ready",
        "1DayReady",
        "oneday ready",
    ] {
        assert!(is_one_day_ready(text), "{text}");
    }
    for text in ["11-day ready", "a1-day-readyx", "1-day readyz"] {
        assert!(!is_one_day_ready(text), "{text}");
    }
}

#[test]
fn pkn_conversion_uses_the_checkout_rate_and_markup() {
    assert_eq!(pkn("1", None), "400");
    assert_eq!(pkn("4", Some("0.01")), "600");
    assert_eq!(pkn("1", Some("0")), "400");
    assert_eq!(pkn("1", Some("nope")), "400");
    assert_eq!(pkn("1.5", Some("0.005")), "500");
}

#[test]
fn eur_quantity_and_price_filters() {
    let ready = rate();
    let ok = eligible_cardtrader(&hub_product(json!(2), json!(100), "EUR"), "100", ready).unwrap();
    assert_eq!(ok.listing_id, "1");
    assert_eq!(ok.quantity, 2);
    assert_eq!(format_rat(ok.price_eur.unwrap()), "1");
    assert_eq!(format_rat(ok.price_pkn), "400");
    assert_eq!(ok.shipping_mode, "zero");
    assert_eq!(ok.country, "IT");

    assert!(eligible_cardtrader(&hub_product(json!(1), json!(100), "USD"), "100", ready).is_none());
    assert!(eligible_cardtrader(&hub_product(json!(0), json!(100), "EUR"), "100", ready).is_none());
    assert!(eligible_cardtrader(&hub_product(json!(1), json!(0), "EUR"), "100", ready).is_none());
    assert!(
        eligible_cardtrader(&hub_product(json!(1.5), json!(100), "EUR"), "100", ready).is_none()
    );

    let mut missing_currency = hub_product(json!(1), json!(250), "EUR");
    missing_currency
        .as_object_mut()
        .unwrap()
        .remove("price_currency");
    let row = eligible_cardtrader(&missing_currency, "100", ready).unwrap();
    assert_eq!(format_rat(row.price_eur.unwrap()), "2.5");

    let plain = json!({
        "id": 4,
        "quantity": 1,
        "price": 3,
        "price_cents": 100,
        "price_currency": "EUR",
        "user": {"can_sell_via_hub": true}
    });
    let row = eligible_cardtrader(&plain, "100", ready).unwrap();
    assert_eq!(format_rat(row.price_eur.unwrap()), "3");
    assert_eq!(format_rat(row.price_pkn), "800");

    let cents_object = json!({
        "id": 5,
        "quantity": 1,
        "price": {"cents": 400, "currency": "EUR"},
        "user": {"can_sell_via_hub": true}
    });
    let row = eligible_cardtrader(&cents_object, "100", ready).unwrap();
    assert_eq!(format_rat(row.price_eur.unwrap()), "4");

    let price_currency_wins = json!({
        "id": 6,
        "quantity": 1,
        "price_cents": 100,
        "price_currency": "usd",
        "price": {"cents": 100, "currency": "EUR"},
        "user": {"can_sell_via_hub": true}
    });
    assert!(eligible_cardtrader(&price_currency_wins, "100", ready).is_none());

    assert!(eligible_cardtrader(
        &json!({"quantity": 1, "price_cents": 100, "user": {"can_sell_via_hub": true}}),
        "100",
        ready
    )
    .is_none());
    assert!(eligible_cardtrader(
        &json!({"id": 7, "quantity": 1, "price_cents": 100, "user": {"can_sell_via_hub": false}}),
        "100",
        ready
    )
    .is_none());

    let fallthrough = json!({
        "id": 8,
        "quantity": 1,
        "price_cents": 100,
        "user": {"can_sell_via_hub": null},
        "can_sell_via_hub": "yes"
    });
    assert_eq!(
        eligible_cardtrader(&fallthrough, "100", ready)
            .unwrap()
            .shipping_mode,
        "zero"
    );

    let named = json!({
        "id": 9,
        "quantity": 1,
        "price_amount": "1.25",
        "name": "Shop 1-Day Ready"
    });
    let row = eligible_cardtrader(&named, "55", ready).unwrap();
    assert_eq!(row.blueprint_id, 55);
    assert_eq!(row.shipping_mode, "one_day_ready");
    assert_eq!(format_rat(row.price_pkn), "450");

    let zero_beats_name = json!({
        "id": 10,
        "quantity": 1,
        "price_cents": 100,
        "name": "1 day ready",
        "user": {"can_sell_via_hub": true, "country_code": "ES"}
    });
    assert_eq!(
        eligible_cardtrader(&zero_beats_name, "100", ready)
            .unwrap()
            .shipping_mode,
        "zero"
    );
}

fn hub_product(quantity: Value, cents: Value, currency: &str) -> Value {
    json!({
        "id": 1,
        "product_id": 44,
        "blueprint_id": 100,
        "quantity": quantity,
        "price_cents": cents,
        "price_currency": currency,
        "user": {"can_sell_via_hub": true, "country_code": "IT"}
    })
}

fn offer(blueprint: i64, provider: Provider, pkn: &str, listing: &str, quantity: i64) -> Offer {
    Offer {
        blueprint_id: blueprint,
        provider,
        price_pkn: parse_rat(pkn).unwrap(),
        price_eur: None,
        listing_id: listing.to_string(),
        product_id: listing.to_string(),
        quantity,
        country: String::new(),
        shipping_mode: "zero",
        source_snapshot_at: None,
    }
}

#[test]
fn ranking_picks_cheapest_then_native_then_listing_id_and_counts_that_provider() {
    let winners = rank([
        offer(1, Provider::CardTrader, "100", "b", 2),
        offer(1, Provider::CardTrader, "80", "c", 4),
        offer(1, Provider::Native, "100", "z", 1),
        offer(1, Provider::CardTrader, "80", "a", 3),
        offer(2, Provider::CardTrader, "50", "m", 4),
        offer(2, Provider::Native, "50", "z", 2),
        offer(3, Provider::CardTrader, "10", "b", 1),
        offer(3, Provider::CardTrader, "10", "a", 5),
        offer(4, Provider::CardTrader, "30", "m", 1),
        offer(4, Provider::Native, "20", "n", 7),
    ]);
    assert_eq!(winners.len(), 4);

    let first = &winners[0];
    assert_eq!(first.blueprint_id, 1);
    assert_eq!(first.provider, Provider::CardTrader);
    assert_eq!(first.listing_id, "a");
    assert_eq!(first.listing_count, 3);
    assert_eq!(first.quantity_sum, 9);

    let tie = &winners[1];
    assert_eq!(tie.provider, Provider::Native);
    assert_eq!(tie.listing_id, "z");
    assert_eq!(tie.listing_count, 1);
    assert_eq!(tie.quantity_sum, 2);

    let listing = &winners[2];
    assert_eq!(listing.listing_id, "a");
    assert_eq!(listing.listing_count, 2);
    assert_eq!(listing.quantity_sum, 6);

    let cheaper_native = &winners[3];
    assert_eq!(cheaper_native.provider, Provider::Native);
    assert_eq!(cheaper_native.listing_count, 1);
    assert_eq!(cheaper_native.quantity_sum, 7);
}
