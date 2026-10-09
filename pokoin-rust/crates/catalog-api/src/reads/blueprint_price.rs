//! `GET|OPTIONS /api/marketplace-blueprint-price` — port of `marketplace-blueprint-price.js`.

use std::sync::OnceLock;

use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::pg::{self, Bind};
use pokoin_api_common::{http, RouteState};
use regex::Regex;
use serde_json::{json, Map, Value};

use super::util;
use crate::shared::js;

const PKN_USD_REFERENCE_PRICE: f64 = 0.005;

/// `cleanBlueprintId(value)`.
pub fn clean_blueprint_id(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return String::new();
    }
    match text.parse::<f64>() {
        Ok(n) if js::is_safe_integer(n) && n > 0.0 => js::number_to_string(n),
        _ => String::new(),
    }
}

/// `priceRow(row, blueprintId)`.
pub fn price_row(row: Option<&Value>, blueprint_id: &str) -> Value {
    let Some(row) = row.filter(|r| !r.get("lowest_ask_pkn").map_or(true, Value::is_null)) else {
        return json!({
            "blueprint_id": blueprint_id, "card_id": blueprint_id, "price_pkn": null, "currency": "PKN", "unit": "PKN",
            "source": null, "listing_count": 0, "listed_quantity": 0, "updated_at": null,
        });
    };
    let id = match row.get("blueprint_id") {
        Some(v) if !v.is_null() => js::js_string(v),
        _ => blueprint_id.to_owned(),
    };
    let source = js::string_or_empty(row.get("source"));
    json!({
        "blueprint_id": id,
        "card_id": id,
        "price_pkn": pg::js_number(js::number(row.get("lowest_ask_pkn"))),
        "currency": "PKN",
        "unit": "PKN",
        "source": if source.is_empty() { "lowest_listing".to_owned() } else { source },
        "listing_count": pg::js_number(num_or_zero(row.get("active_listing_count"))),
        "listed_quantity": pg::js_number(num_or_zero(row.get("listed_quantity"))),
        "updated_at": if js::truthy(row.get("refreshed_at")) { row["refreshed_at"].clone() } else { Value::Null },
    })
}

/// `Number(x || 0)`.
fn num_or_zero(v: Option<&Value>) -> f64 {
    if js::truthy(v) { js::number(v) } else { 0.0 }
}

/// `pknFromUsdPrice(priceUsd)`.
pub fn pkn_from_usd_price(price_usd: Option<f64>) -> Option<f64> {
    let value = price_usd?;
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let reference = std::env::var("PKN_CHECKOUT_USDT_PRICE")
        .ok()
        .filter(|v| !v.is_empty())
        .map(|v| http::js_number(&v).unwrap_or(f64::NAN))
        .unwrap_or(PKN_USD_REFERENCE_PRICE);
    if !reference.is_finite() || reference <= 0.0 {
        return None;
    }
    Some(value / reference)
}

/// `parseCardTraderOfferPrice(html)`.
pub fn parse_card_trader_offer_price(html: &str) -> Option<f64> {
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    static ESCAPED: OnceLock<Regex> = OnceLock::new();
    static RAW: OnceLock<Regex> = OnceLock::new();
    let script = SCRIPT.get_or_init(|| Regex::new(r#"(?is)<script[^>]*type=["']application/ld\+json["'][^>]*>(.*?)</script>"#).expect("regex"));
    for caps in script.captures_iter(html) {
        let Ok(parsed) = serde_json::from_str::<Value>(&caps[1]) else { continue };
        let nodes = match parsed {
            Value::Array(items) => items,
            other => vec![other],
        };
        for node in nodes {
            let offers = match node.get("offers") {
                Some(Value::Array(items)) => items.clone(),
                Some(other) => vec![other.clone()],
                None => vec![Value::Null],
            };
            for offer in offers {
                let currency = js::string_or_empty(offer.get("priceCurrency")).trim().to_uppercase();
                let price = js::number(offer.get("price"));
                if currency == "USD" && price.is_finite() && price > 0.0 {
                    return Some(price);
                }
            }
        }
    }
    let escaped = ESCAPED.get_or_init(|| Regex::new(r"&quot;priceCurrency&quot;:&quot;USD&quot;,&quot;price&quot;:&quot;([0-9]+(?:\.[0-9]+)?)&quot;").expect("regex"));
    if let Some(c) = escaped.captures(html) {
        return c[1].parse().ok();
    }
    let raw = RAW.get_or_init(|| Regex::new(r#""priceCurrency"\s*:\s*"USD"\s*,\s*"price"\s*:\s*"([0-9]+(?:\.[0-9]+)?)""#).expect("regex"));
    raw.captures(html).and_then(|c| c[1].parse().ok())
}

async fn read_card_trader_page_price(state: &RouteState, blueprint_id: &str) -> Value {
    let clean = clean_blueprint_id(blueprint_id);
    if clean.is_empty() {
        return price_row(None, blueprint_id);
    }
    let response = state
        .api
        .http()
        .get(format!("https://www.cardtrader.com/en/cards/{clean}"))
        .header("Accept", "text/html,application/xhtml+xml")
        .header("User-Agent", "PokoinMarketplacePriceBot/1.0")
        .send()
        .await;
    let Ok(response) = response else { return price_row(None, &clean) };
    if !response.status().is_success() {
        return price_row(None, &clean);
    }
    let html = response.text().await.unwrap_or_default();
    let Some(price) = pkn_from_usd_price(parse_card_trader_offer_price(&html)) else {
        return price_row(None, &clean);
    };
    let row = json!({
        "blueprint_id": clean, "lowest_ask_pkn": price, "active_listing_count": 0, "listed_quantity": 0,
        "refreshed_at": pg::iso(chrono::Utc::now()), "source": "cardtrader_public_offer",
    });
    price_row(Some(&row), &clean)
}

fn linked_card_trader_predicate() -> &'static str {
    "
    (
      lower(coalesce(source, '')) = 'cardtrader'
      or lower(coalesce(source, '')) like 'cardtrader%'
      or lower(coalesce(source_listing_id, '')) like '%cardtrader%'
      or lower(coalesce(source_listing_id, '')) like '%cardtrader.com%'
    )
  "
}

enum PriceError {
    BadRequest,
    Db(sqlx::Error),
}

async fn read_blueprint_price(state: &RouteState, blueprint_id: &str, source: &str) -> Result<Value, PriceError> {
    let clean = clean_blueprint_id(blueprint_id);
    if clean.is_empty() {
        return Err(PriceError::BadRequest);
    }
    if source == "cardtrader" {
        return Ok(read_card_trader_page_price(state, &clean).await);
    }
    let sql = format!(
        "
      select
        card_id as blueprint_id,
        min(price_pkn) as lowest_ask_pkn,
        count(*)::int as active_listing_count,
        sum(quantity_available)::int as listed_quantity,
        max(updated_at) as refreshed_at,
        'cardtrader_lowest_listing' as source
      from public.marketplace_user_listings
      where card_id = $1
        and status = 'active'
        and quantity_available > 0
        and price_pkn > 0
        and {}
      group by card_id
      limit 1
    ",
        linked_card_trader_predicate()
    );
    let rows = pg::pool_rows(state.api.read(), &sql, &[Bind::Text(clean.clone())]).await.map_err(PriceError::Db)?;
    if let Some(row) = rows.first().filter(|r| !r["lowest_ask_pkn"].is_null()) {
        return Ok(price_row(Some(row), &clean));
    }
    let id: i64 = clean.parse().unwrap_or(0);
    let rows = pg::pool_rows(
        state.api.read(),
        "
      select
        blueprint_id,
        listed_quantity,
        active_listing_count,
        lowest_ask_pkn,
        refreshed_at
      from public.marketplace_blueprint_price_summary
      where blueprint_id = $1::bigint
        and active_listing_count > 0
        and listed_quantity > 0
        and lowest_ask_pkn is not null
      limit 1
    ",
        &[Bind::Int(id)],
    )
    .await
    .map_err(PriceError::Db)?;
    Ok(price_row(rows.first(), &clean))
}

pub async fn handler(State(state): State<RouteState>, method: Method, uri: Uri) -> Response {
    let cors = http::READ_CORS;
    if method == Method::OPTIONS {
        return http::read_preflight();
    }
    if method != Method::GET {
        let mut headers = cors.to_vec();
        headers.push(("allow", "GET, OPTIONS"));
        return http::json_with(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Method not allowed." }), &headers);
    }
    let q = http::Query::from_uri(&uri);
    let blueprint_id = util::first_of(&q, &["blueprintId", "cardId"]).unwrap_or("");
    let source = q.search_param("source").unwrap_or("").trim().to_lowercase();
    match read_blueprint_price(&state, blueprint_id, &source).await {
        Ok(price) => {
            let mut headers = cors.to_vec();
            headers.push(("cache-control", "public, max-age=10, s-maxage=30"));
            if price["price_pkn"].is_null() {
                let mut body: Map<String, Value> = price.as_object().cloned().unwrap_or_default();
                body.insert(
                    "error".into(),
                    json!(if source == "cardtrader" {
                        "No active CardTrader PKN price found for this blueprint."
                    } else {
                        "No active PKN listing price found for this blueprint."
                    }),
                );
                return http::json_with(StatusCode::NOT_FOUND, Value::Object(body), &headers);
            }
            http::json_with(StatusCode::OK, price, &headers)
        }
        Err(PriceError::BadRequest) => http::json_with(StatusCode::BAD_REQUEST, json!({ "error": "Missing or invalid blueprintId." }), &cors),
        Err(PriceError::Db(error)) => {
            tracing::error!(%error, "marketplace-blueprint-price failed");
            let mut response = util::db_error("marketplace-blueprint-price", &error, "Marketplace blueprint price failed.");
            for (k, v) in cors {
                if let (Ok(k), Ok(v)) = (axum::http::HeaderName::try_from(k), axum::http::HeaderValue::try_from(v)) {
                    response.headers_mut().insert(k, v);
                }
            }
            response
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn price_helpers() {
        assert_eq!(clean_blueprint_id(" 119662 "), "119662");
        assert_eq!(clean_blueprint_id("0"), "");
        assert_eq!(clean_blueprint_id("12a"), "");
        assert_eq!(price_row(None, "5")["price_pkn"], Value::Null);
        let row = json!({"blueprint_id": "5", "lowest_ask_pkn": "22.00", "active_listing_count": 2, "listed_quantity": 3, "refreshed_at": "2026-10-08T22:09:31.097Z"});
        let p = price_row(Some(&row), "5");
        assert_eq!(p["price_pkn"], json!(22));
        assert_eq!(p["source"], "lowest_listing");
        assert_eq!(parse_card_trader_offer_price(r#"<script type="application/ld+json">{"offers":{"priceCurrency":"USD","price":"1.25"}}</script>"#), Some(1.25));
        assert_eq!(pkn_from_usd_price(Some(1.0)), Some(200.0));
    }
}
