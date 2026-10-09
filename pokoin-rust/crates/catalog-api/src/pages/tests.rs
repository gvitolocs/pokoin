//! Parity tests against the live API (responses captured 2026-10-08 with
//! `&_t` cache busters) and the production rows captured with `pokoin-sql-ro`
//! at the same data revision, plus the router tests.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;
use crate::shared::{expansions, js, rails, react_card, react_sql};

fn fixture(name: &str) -> Value {
    serde_json::from_str(fixtures_str(name)).expect("fixture json")
}

fn fixtures_str(name: &str) -> &'static str {
    // include_str! needs literals; the fixture set is small and fixed.
    match name {
        "live-expansion-destined-rivals.json" => {
            include_str!("fixtures/live-expansion-destined-rivals.json")
        }
        "live-expansion-no-slug.json" => include_str!("fixtures/live-expansion-no-slug.json"),
        "live-version-set.json" => include_str!("fixtures/live-version-set.json"),
        "live-rails-new-cards.json" => include_str!("fixtures/live-rails-new-cards.json"),
        "live-home.json" => include_str!("fixtures/live-home.json"),
        "live-sales-pulse.json" => include_str!("fixtures/live-sales-pulse.json"),
        "expansion-destined-rivals-rows.json" => {
            include_str!("fixtures/expansion-destined-rivals-rows.json")
        }
        "expansion-destined-rivals-paths.json" => {
            include_str!("fixtures/expansion-destined-rivals-paths.json")
        }
        "expansion-destined-rivals-cheapest.json" => {
            include_str!("fixtures/expansion-destined-rivals-cheapest.json")
        }
        "expansion-destined-rivals-slug-row.json" => {
            include_str!("fixtures/expansion-destined-rivals-slug-row.json")
        }
        "expansion-list-rows.json" => include_str!("fixtures/expansion-list-rows.json"),
        "version-set-239324-rows.json" => include_str!("fixtures/version-set-239324-rows.json"),
        "version-set-239324-cheapest.json" => {
            include_str!("fixtures/version-set-239324-cheapest.json")
        }
        "rail-new-cards-row.json" => include_str!("fixtures/rail-new-cards-row.json"),
        "rail-featured-row.json" => include_str!("fixtures/rail-featured-row.json"),
        "rail-best_sellers-row.json" => include_str!("fixtures/rail-best_sellers-row.json"),
        "rail-spotlight-row.json" => include_str!("fixtures/rail-spotlight-row.json"),
        "rail-top-sold-row.json" => include_str!("fixtures/rail-top-sold-row.json"),
        "sales-trend-1day-rows.json" => include_str!("fixtures/sales-trend-1day-rows.json"),
        other => panic!("unknown fixture {other}"),
    }
}

fn rows_fixture(name: &str) -> Vec<Value> {
    let raw = fixture(name);
    let rows = raw.as_array().expect("rows array").clone();
    rows.into_iter()
        .map(|entry| {
            let row = entry.get("row").cloned().unwrap_or_else(|| entry.clone());
            js::js_normalize(&row)
        })
        .collect()
}

fn rail_row_fixture(name: &str) -> rails::RailRow {
    let row = fixture(name);
    rails::RailRow {
        id: js::string_or_empty(js::get(&row, "id")),
        cards: js::get(&row, "cards").cloned(),
        meta: js::get(&row, "meta").cloned(),
        updated_at: Some(
            chrono::DateTime::parse_from_rfc3339(&js::string_or_empty(js::get(&row, "updated_at")))
                .expect("rail updated_at")
                .with_timezone(&chrono::Utc),
        ),
    }
}

fn iso_z(at: &chrono::DateTime<chrono::Utc>) -> Value {
    Value::String(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Recursive key-set + value-type comparison (`null` vs null, string vs
/// string, number vs number, …), asserting array lengths line up.
fn assert_same_shape(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => {
            let missing: Vec<&String> = e.keys().filter(|k| !a.contains_key(*k)).collect();
            assert!(missing.is_empty(), "{path}: missing keys {missing:?}");
            let extra: Vec<&String> = a.keys().filter(|k| !e.contains_key(*k)).collect();
            assert!(extra.is_empty(), "{path}: extra keys {extra:?}");
            for (key, expected_value) in e {
                assert_same_shape(&a[key], expected_value, &format!("{path}.{key}"));
            }
        }
        (Value::Array(a), Value::Array(e)) => {
            assert_eq!(a.len(), e.len(), "{path}: array length");
            for (index, (x, y)) in a.iter().zip(e.iter()).enumerate() {
                assert_same_shape(x, y, &format!("{path}[{index}]"));
            }
        }
        (a, e) => {
            let same = match (a, e) {
                (Value::Null, Value::Null) => true,
                (Value::Bool(x), Value::Bool(y)) => x == y,
                (Value::Number(_), Value::Number(_)) => true,
                (Value::String(x), Value::String(y)) => x == y,
                _ => false,
            };
            assert!(same, "{path}: {a} vs {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// marketplace-expansion-page
// ---------------------------------------------------------------------------

/// `to_react_card` over the real `readCardsForSet` rows (+ canonical paths
/// and cheapest rows captured from the writer DB) must equal the live cards,
/// field by field.
#[test]
fn expansion_page_cards_match_the_live_response() {
    let rows = rows_fixture("expansion-destined-rivals-rows.json");
    let paths_rows = rows_fixture("expansion-destined-rivals-paths.json");
    let cheapest_rows = rows_fixture("expansion-destined-rivals-cheapest.json");
    let mut paths = std::collections::HashMap::new();
    for row in &paths_rows {
        paths.insert(
            js::string_or_empty(js::get(row, "card_id")),
            js::string_or_empty(js::get(row, "canonical_path")),
        );
    }
    let cheapest = react_sql::cheapest_map_from_rows(&cheapest_rows);
    let enriched = react_sql::apply_canonical_and_cheapest(&rows, &paths, &cheapest);
    // The reference pages the first `limit` of its limit+1 fetch.
    let enriched: Vec<Value> = enriched.iter().take(4).cloned().collect();

    // `print` stamp from the expansion nationality.
    let print = "western";
    let cards: Vec<Value> = react_card::to_react_cards(&enriched)
        .into_iter()
        .map(|card| {
            let card_nationality = js::string_or_empty(js::get(&card, "nationality"));
            if !card_nationality.is_empty() {
                card
            } else {
                js::spread_with(&card, "nationality", Value::String(print.to_string()))
            }
        })
        .collect();

    let live = fixture("live-expansion-destined-rivals.json");
    let expected = live["cards"].as_array().expect("live cards");
    assert_eq!(cards.len(), expected.len());
    for (index, (card, expected_card)) in cards.iter().zip(expected.iter()).enumerate() {
        assert_eq!(
            card,
            expected_card,
            "card {index} ({}) differs from the live response",
            js::string_or_empty(js::get(expected_card, "id"))
        );
    }
}

#[test]
fn expansion_page_body_matches_the_live_shape() {
    let slug_row = js::js_normalize(&fixture("expansion-destined-rivals-slug-row.json"));
    // catalog_card_count 244 is the stored count the reference resolved.
    let expansion = react_sql::expansion_from_pokemon_row(&slug_row, "destined-rivals", 244.0);
    let live = fixture("live-expansion-destined-rivals.json");
    assert_eq!(expansion, live["expansion"]);

    // The production readSetCards overlay: canonical paths + cheapest.
    let rows = rows_fixture("expansion-destined-rivals-rows.json");
    let mut paths = std::collections::HashMap::new();
    for row in rows_fixture("expansion-destined-rivals-paths.json") {
        paths.insert(
            js::string_or_empty(js::get(&row, "card_id")),
            js::string_or_empty(js::get(&row, "canonical_path")),
        );
    }
    let cheapest =
        react_sql::cheapest_map_from_rows(&rows_fixture("expansion-destined-rivals-cheapest.json"));
    let enriched = react_sql::apply_canonical_and_cheapest(&rows, &paths, &cheapest);
    // The reference fetches limit+1 rows and pages the first `limit`.
    let page: Vec<Value> = enriched.iter().take(4).cloned().collect();
    let cards: Vec<Value> = react_card::to_react_cards(&page)
        .into_iter()
        .map(|card| {
            let nationality = js::string_or_empty(js::get(&card, "nationality"));
            if nationality.is_empty() {
                js::spread_with(&card, "nationality", Value::String("western".to_string()))
            } else {
                card
            }
        })
        .collect();
    let has_more = enriched.len() as i64 > 4;
    let body = expansion_page::success_body(expansion, cards, "card", 4, 0, 244.0, has_more);
    assert_same_shape(&body, &live, "expansion-page");
}

#[test]
fn expansion_page_no_slug_matches_the_live_response() {
    let rows = rows_fixture("expansion-list-rows.json");
    let expansions: Vec<Value> = rows
        .iter()
        .map(|row| {
            let name = js::string_or_empty(js::get(row, "name"));
            let resolved_slug = expansions::slugify(&name);
            json!({
                "name": name,
                "slug": resolved_slug,
                "symbolImageUrl": js::string_or_empty(js::get(row, "symbol_image_url")),
                "logoImageUrl": js::string_or_empty(js::get(row, "logo_image_url")),
                "defaultSymbolUrl": if resolved_slug.is_empty() {
                    String::new()
                } else {
                    format!("https://cdn.pokoin.com/expansions/symbols/{resolved_slug}.png")
                },
                "cardCount": js::js_json_number({
                    let n = js::number(js::get(row, "card_count"));
                    if n.is_finite() { n } else { 0.0 }
                }),
                "nationality": js::string_or_empty(js::get(row, "nationality")).trim().to_lowercase(),
            })
        })
        .collect();
    let live = fixture("live-expansion-no-slug.json");
    let expected = live["expansions"].as_array().expect("live expansions");
    assert_eq!(expansions.len(), expected.len());
    for (expansion, expected_expansion) in expansions.iter().zip(expected.iter()) {
        assert_eq!(expansion, expected_expansion);
    }
    let body = expansion_page::no_slug_body(expansions, "pokemon", 3);
    assert_same_shape(&body, &live, "expansion-page-no-slug");
}

// ---------------------------------------------------------------------------
// marketplace-version-set
// ---------------------------------------------------------------------------

#[test]
fn version_set_printings_match_the_live_response() {
    let rows = rows_fixture("version-set-239324-rows.json");
    let cheapest_rows = rows_fixture("version-set-239324-cheapest.json");
    let cheapest = react_sql::cheapest_map_from_rows(&cheapest_rows);
    let overlaid = react_sql::overlay_cheapest_with(&rows, &cheapest);

    let printings: Vec<Value> = overlaid
        .iter()
        .map(|row| {
            let mut card = react_card::to_react_card(row);
            if let Some(map) = card.as_object_mut() {
                map.insert(
                    "nationality".into(),
                    Value::String(
                        js::string_or_empty(js::get(row, "nationality"))
                            .trim()
                            .to_lowercase(),
                    ),
                );
                map.insert(
                    "version".into(),
                    Value::String(js::string_or_empty(js::get(row, "version"))),
                );
            }
            card
        })
        .collect();

    let live = fixture("live-version-set.json");
    let expected = live["printings"].as_array().expect("live printings");
    assert_eq!(printings.len(), expected.len());
    for (printing, expected_printing) in printings.iter().zip(expected.iter()) {
        assert_eq!(
            printing,
            expected_printing,
            "printing {} differs",
            js::string_or_empty(js::get(expected_printing, "id"))
        );
    }
    // versionCount comes from member_count of the first row.
    let member_count = js::number(js::get(&overlaid[0], "member_count"));
    assert_eq!(member_count, 2.0);
    assert_eq!(live["version"], json!("v239324"));
    assert_eq!(live["cardId"], json!("239324"));
    let body = version_set::success_body("239324", "v239324", json!(2), printings);
    assert_same_shape(&body, &live, "version-set");
}

// ---------------------------------------------------------------------------
// marketplace-rails
// ---------------------------------------------------------------------------

#[test]
fn rails_new_cards_matches_the_live_response() {
    let row = rail_row_fixture("rail-new-cards-row.json");
    let cards = rails::publicize_cards(&rails::as_cards(row.cards.as_ref()));
    let live = fixture("live-rails-new-cards.json");
    let expected = live["cards"].as_array().expect("live rail cards");
    assert_eq!(cards.len(), expected.len());
    for (card, expected_card) in cards.iter().zip(expected.iter()) {
        assert_eq!(
            card,
            expected_card,
            "tile {} differs",
            js::string_or_empty(js::get(expected_card, "id"))
        );
    }
    let body = crate::pages::rails::rail_body(
        &row.id,
        cards,
        row.meta.clone(),
        iso_z(&row.updated_at.expect("rail timestamp")),
    );
    assert_same_shape(&body, &live, "rails");
    assert_eq!(body["updated_at"], live["updated_at"]);
    assert_eq!(body["meta"], live["meta"]);
}

// ---------------------------------------------------------------------------
// marketplace-home-page
// ---------------------------------------------------------------------------

#[test]
fn home_page_assembly_matches_the_live_response() {
    let rows = vec![
        rail_row_fixture("rail-new-cards-row.json"),
        rail_row_fixture("rail-featured-row.json"),
        rail_row_fixture("rail-best_sellers-row.json"),
        rail_row_fixture("rail-spotlight-row.json"),
        rail_row_fixture("rail-top-sold-row.json"),
    ];
    let live = fixture("live-home.json");
    let generated_at = live["generatedAt"]
        .as_str()
        .expect("live generatedAt")
        .to_string();
    let snapshot = rails::assemble_home_vector(&rows, &generated_at);
    let snapshot = js::spread_with(&snapshot, "cacheSource", json!("postgres"));
    let body = home_page::plain_body(&snapshot, "pokemon", home_page::merged_sections(&snapshot));

    let live = fixture("live-home.json");
    // generatedAt is the request instant; everything else is data.
    let actual = body.clone();
    let expected = live.clone();
    assert_same_shape(
        actual.get("generatedAt").expect("generatedAt"),
        expected.get("generatedAt").expect("generatedAt"),
        "home.generatedAt",
    );
    assert_eq!(actual, expected, "home body differs from the live response");
    // The Node String(Date) stamp of the rail refresh.
    assert_eq!(body["updatedAt"], live["updatedAt"]);
}

// ---------------------------------------------------------------------------
// marketplace-sales-pulse
// ---------------------------------------------------------------------------

#[test]
fn sales_pulse_matches_the_live_response() {
    let rail = rail_row_fixture("rail-top-sold-row.json");
    let trend_rows = rows_fixture("sales-trend-1day-rows.json");
    let trend: Vec<Value> = trend_rows
        .iter()
        .map(|row| {
            sales_pulse::trend_entry(
                js::string_or_empty(js::get(row, "day")),
                js::number(js::get(row, "removed_listing_quantity")) as i64,
                js::number(js::get(row, "observed_sales")) as i64,
                js::number(js::get(row, "active_cards")) as i32,
            )
        })
        .collect();

    let raw_cards = rails::as_cards(rail.cards.as_ref());
    // No limit param -> Number(null)=0 -> clamped to 1, exactly like the
    // reference (the live no-params response has a single leader).
    let limit = sales_pulse::bounded_integer(None, 12, 24);
    assert_eq!(limit, 1);
    assert_eq!(sales_pulse::metric_name(None), "sales");
    let days = sales_pulse::bounded_integer(None, 7, 30);
    assert_eq!(days, 1);

    let leaders = sales_pulse::rank_leaders(&raw_cards, "sales", limit as usize);
    let meta = rail.meta.clone().unwrap_or(Value::Null);
    let observed = js::nullish_or(
        js::get(&meta, "observedSales"),
        js::get(&meta, "listingEvents"),
    );
    let removed = js::nullish_or(
        js::get(&meta, "removedListingQuantity"),
        js::get(&meta, "soldQty"),
    );
    let leader_day = leaders
        .first()
        .map(|leader| js::string_or_empty(js::get(leader, "salesDay")))
        .unwrap_or_default();
    let data_day = js::string_or_empty(Some(js::or(
        js::get(&meta, "day"),
        &Value::String(leader_day),
    )));
    let body = sales_pulse::success_body(
        data_day,
        iso_z(&rail.updated_at.expect("rail timestamp")),
        "sales",
        sales_pulse::integer_value(observed),
        sales_pulse::integer_value(removed),
        sales_pulse::integer_value(js::get(&meta, "activeCards")),
        leaders,
        trend,
        js::string_or_empty(Some(js::or(
            js::get(&meta, "source"),
            &Value::String("cardtrader_removed_sale".to_string()),
        ))),
        js::string_or_empty(Some(js::or(
            js::get(&meta, "methodology"),
            &Value::String(
                "Observed sales are counted from individual CardTrader removal samples. Removed listing quantity is diagnostic only and is not treated as confirmed sales."
                    .to_string(),
            ),
        ))),
    );

    let live = fixture("live-sales-pulse.json");
    assert_same_shape(&body, &live, "sales-pulse");
    assert_eq!(
        body, live,
        "sales-pulse body differs from the live response"
    );
}

/// The top_sold leader card is a `to_react_card` of the raw rail card with
/// the sales-day extras; assert one full leader against the live entry.
#[test]
fn sales_pulse_leader_card_matches_live() {
    let rail = rail_row_fixture("rail-top-sold-row.json");
    let raw_cards = rails::as_cards(rail.cards.as_ref());
    let leaders = sales_pulse::rank_leaders(&raw_cards, "sales", 12);
    let live = fixture("live-sales-pulse.json");
    let expected = &live["leaders"][0];
    assert_eq!(leaders[0], *expected);
}

// ---------------------------------------------------------------------------
// Router tests (dead pool: DB-touching handlers answer their failure body)
// ---------------------------------------------------------------------------

fn test_router() -> Router {
    let url = "postgres://x@127.0.0.1:1/x";
    let pool = pokoin_api_common::state::lazy_pool(url, 1).expect("lazy pool");
    crate::router(pokoin_api_common::RouteState::new(
        pokoin_api_common::ApiState::new(pool.clone(), pool, None, 1),
        pokoin_accounts::DomainState::default(),
    ))
}

async fn serve(method: &str, uri: &str) -> (StatusCode, Value, Vec<(String, String)>) {
    let response = test_router()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap_or_default();
    let value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap_or(Value::Null)
    };
    (status, value, headers)
}

fn cors_headers(headers: &[(String, String)]) -> bool {
    headers
        .iter()
        .any(|(k, v)| k == "access-control-allow-origin" && v == "*")
        && headers
            .iter()
            .any(|(k, v)| k == "access-control-allow-methods" && v == "GET, OPTIONS")
        && headers
            .iter()
            .any(|(k, v)| k == "access-control-allow-headers" && v == "Content-Type, Authorization")
        && headers
            .iter()
            .any(|(k, v)| k == "access-control-max-age" && v == "86400")
}

#[tokio::test]
async fn options_preflights_answer_204_with_read_cors() {
    for path in [
        "/api/marketplace-expansion-page",
        "/api/marketplace-version-set",
        "/api/marketplace-rails",
        "/api/marketplace-home-page",
        "/api/marketplace-sales-pulse",
    ] {
        let (status, body, headers) = serve("OPTIONS", path).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{path}");
        assert_eq!(body, Value::Null, "{path}");
        assert!(cors_headers(&headers), "{path}");
    }
}

#[tokio::test]
async fn unsupported_methods_answer_the_reference_405s() {
    for path in [
        "/api/marketplace-expansion-page",
        "/api/marketplace-rails",
        "/api/marketplace-home-page",
        "/api/marketplace-sales-pulse",
    ] {
        let (status, body, headers) = serve("POST", path).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{path}");
        assert_eq!(body, json!({ "error": "Method not allowed." }), "{path}");
        assert!(cors_headers(&headers), "{path}");
        assert!(
            headers
                .iter()
                .any(|(k, v)| k == "allow" && v == "GET, OPTIONS"),
            "{path}"
        );
    }
    let (status, body, headers) = serve("POST", "/api/marketplace-version-set").await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body, json!({ "error": "GET only." }));
    assert!(cors_headers(&headers));
    // No Allow header on the version-set 405 (the reference sets none).
    assert!(!headers.iter().any(|(k, _)| k == "allow"));
}

#[tokio::test]
async fn version_set_validates_card_id_without_the_database() {
    let (status, body, headers) = serve("GET", "/api/marketplace-version-set").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        json!({ "error": "cardId is required (public marketplace id)." })
    );
    assert!(cors_headers(&headers));

    let (status, _body, _) = serve("GET", "/api/marketplace-version-set?cardId=abc").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A real query against the dead pool surfaces the DB-failure response.
    let (status, body, _) = serve("GET", "/api/marketplace-version-set?cardId=239324").await;
    assert_eq!(status.as_u16(), 503, "{body}");
    assert_eq!(
        body["error"],
        pokoin_api_common::public_error::WORKING_MESSAGE
    );
}

#[tokio::test]
async fn rails_validates_ids_without_the_database() {
    let (status, body, headers) = serve("GET", "/api/marketplace-rails").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "id or ids required." }));
    assert!(cors_headers(&headers));

    // DB failure path (dead pool -> 503 pipeline message).
    let (status, body, _) = serve("GET", "/api/marketplace-rails?id=new_cards").await;
    assert_eq!(status.as_u16(), 503, "{body}");
    assert_eq!(
        body["error"],
        pokoin_api_common::public_error::WORKING_MESSAGE
    );
}

#[tokio::test]
async fn every_route_answers_get_not_404() {
    for (path, expected_range) in [
        (
            "/api/marketplace-expansion-page?slug=destined-rivals&limit=4",
            200..=599,
        ),
        ("/api/marketplace-expansion-page?limit=3", 200..=599),
        ("/api/marketplace-version-set?cardId=239324", 200..=599),
        ("/api/marketplace-rails?id=new_cards", 200..=599),
        ("/api/marketplace-rails?ids=1,2,3", 200..=599),
        ("/api/marketplace-home-page", 200..=599),
        ("/api/marketplace-sales-pulse", 200..=599),
    ] {
        let (status, _body, headers) = serve("GET", path).await;
        let code = status.as_u16();
        assert!(
            code >= *expected_range.start()
                && code <= *expected_range.end()
                && code != 404
                && code != 405,
            "{path} answered {code}"
        );
        assert!(cors_headers(&headers), "{path}");
    }
}
