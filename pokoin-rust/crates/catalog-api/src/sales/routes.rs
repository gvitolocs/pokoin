//! Card sale/price routes: card-sales, card-last-median, card-cheapest-price,
//! card-price-history and tcgplayer-history.

use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::pg::{self, Bind};
use pokoin_api_common::{game, http, RouteState};
use serde_json::{json, Map, Value};

use super::core::{self, SoldSlice};
use super::tcgcsv::{self, TcgError};
use crate::reads::util;
use crate::shared::{card_versions, js};

const READ_CORS: [(&str, &str); 3] = [
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "GET, OPTIONS"),
    ("access-control-allow-headers", "Content-Type, Authorization"),
];

fn with_headers(status: StatusCode, body: Value, base: &[(&str, &str)], extra: &[(&str, &str)]) -> Response {
    let mut h = base.to_vec();
    h.extend_from_slice(extra);
    http::json_with(status, body, &h)
}

fn preflight_or_405(method: &Method, cors: &[(&str, &str)]) -> Option<Response> {
    if *method == Method::OPTIONS {
        return Some(http::raw(StatusCode::NO_CONTENT, "text/plain", axum::body::Body::empty(), cors));
    }
    if *method != Method::GET {
        return Some(with_headers(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Method not allowed." }), cors, &[("allow", "GET, OPTIONS")]));
    }
    None
}

fn db_failure(route: &str, error: &sqlx::Error, fallback: &str, cors: &[(&str, &str)]) -> Response {
    let mut response = util::db_error(route, error, fallback);
    for (k, v) in cors {
        if let (Ok(k), Ok(v)) = (axum::http::HeaderName::try_from(*k), axum::http::HeaderValue::try_from(*v)) {
            response.headers_mut().insert(k, v);
        }
    }
    response
}

async fn read_native_card_sales(state: &RouteState, card_id: &str, limit: i64) -> Result<Vec<Value>, String> {
    let firestore = state.accounts.firestore().map_err(|e| e.body().to_string())?;
    let mut rows: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut query_limit = (limit * 12).max(80).min(500);
    while (rows.len() as i64) < limit && query_limit <= 500 {
        let query = pokoin_accounts::Query::collection("orders").where_eq("paymentStatus", "paid").limit(query_limit);
        let docs = firestore.run_query(&query).await.map_err(|e| e.body().to_string())?;
        let size = docs.len() as i64;
        for doc in docs {
            let id = doc.id();
            if seen.contains(&id) {
                continue;
            }
            seen.push(id.clone());
            let data = doc.to_plain_json();
            let paid_at = iso_of(data.get("paidAt").filter(|v| js::truthy(Some(v))).or(data.get("createdAt")));
            if let Some(Value::Array(items)) = data.get("items") {
                for item in items {
                    let sale = normalize_sale_item(&id, &paid_at, item);
                    if js::string_or_empty(sale.get("cardId")) == card_id && js::number(sale.get("pricePkn")) > 0.0 && js::truthy(sale.get("soldAt")) {
                        rows.push(sale);
                        if rows.len() as i64 >= limit {
                            break;
                        }
                    }
                }
            }
            if rows.len() as i64 >= limit {
                break;
            }
        }
        if size < query_limit || query_limit >= 500 {
            break;
        }
        query_limit = (query_limit * 2).min(500);
    }
    rows.sort_by(|a, b| js::string_or_empty(a.get("soldAt")).cmp(&js::string_or_empty(b.get("soldAt"))));
    let skip = rows.len().saturating_sub(limit as usize);
    Ok(rows.into_iter().skip(skip).collect())
}

/// Firestore timestamps as `toDate().toISOString()`.
fn iso_of(value: Option<&Value>) -> Value {
    let Some(text) = value.and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        return Value::Null;
    };
    match chrono::DateTime::parse_from_rfc3339(text) {
        Ok(dt) => json!(pg::iso(dt.with_timezone(&chrono::Utc))),
        Err(_) => json!(text),
    }
}

fn normalize_sale_item(order_id: &str, paid_at: &Value, item: &Value) -> Value {
    let raw = if item.is_object() { item.clone() } else { json!({}) };
    let card = raw.get("card").filter(|c| c.is_object()).cloned().unwrap_or(json!({}));
    let quantity = (core::number_value(raw.get("quantity"), 1.0).trunc() as i64).max(1);
    let unit = core::number_value(["unitPricePkn", "pricePkn", "price_pkn"].iter().filter_map(|k| raw.get(*k)).find(|v| !v.is_null()), 0.0);
    let total = core::number_value(["totalPricePkn", "total_pkn"].iter().filter_map(|k| raw.get(*k)).find(|v| !v.is_null()), unit * quantity as f64);
    let effective = if unit > 0.0 { unit } else { total / quantity as f64 };
    let card_id = [card.get("id"), raw.get("cardId"), raw.get("card_id")].into_iter().flatten().find(|v| js::truthy(Some(v))).cloned();
    let condition = js::clean_text(raw.get("condition"), 40);
    json!({
        "orderId": order_id,
        "cardId": js::clean_text(card_id.as_ref(), 80),
        "condition": if condition.is_empty() { "NM".to_owned() } else { condition },
        "pricePkn": pg::js_number(core::to_fixed(effective, 6)),
        "quantity": quantity,
        "soldAt": paid_at,
        "graded": raw.get("graded") == Some(&Value::Bool(true)),
        "gradingCompany": js::clean_text(raw.get("gradingCompany"), 80),
        "grade": js::clean_text(raw.get("grade"), 40),
    })
}

/// `readCardSales({ cardId, limit, includeNative, ...slice })`.
async fn read_card_sales(state: &RouteState, card_id: &str, limit: i64, include_native: bool, slice: &SoldSlice) -> Result<Vec<Value>, Response> {
    let id: i64 = card_id.parse().unwrap_or(0);
    let mut oracle = core::read_oracle_card_sales(state.api.read(), id, limit, slice)
        .await
        .map_err(|e| db_failure("marketplace-card-sales", &e, "Marketplace card sales failed.", &READ_CORS))?;
    let sort = |rows: &mut Vec<Value>| rows.sort_by(|a, b| js::string_or_empty(a.get("soldAt")).cmp(&js::string_or_empty(b.get("soldAt"))));
    let tail = |rows: Vec<Value>| {
        let skip = rows.len().saturating_sub(limit as usize);
        rows.into_iter().skip(skip).collect::<Vec<_>>()
    };
    if !include_native {
        sort(&mut oracle);
        return Ok(tail(oracle));
    }
    let native = read_native_card_sales(state, card_id, limit)
        .await
        .map_err(|message| with_headers(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": message }), &READ_CORS, &[]))?;
    let mut order: Vec<String> = Vec::new();
    let mut merged: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for sale in native.into_iter().chain(oracle) {
        let key = format!(
            "{}|{}|{}|{}|{}",
            js::string_or_empty(sale.get("orderId")),
            js::string_or_empty(sale.get("cardId")),
            js::string_or_empty(sale.get("soldAt")),
            js::js_string(sale.get("pricePkn").unwrap_or(&Value::Null)),
            js::string_or_empty(sale.get("condition"))
        );
        if !merged.contains_key(&key) {
            order.push(key.clone());
        }
        merged.insert(key, sale);
    }
    let mut rows: Vec<Value> = order.into_iter().filter_map(|k| merged.remove(&k)).collect();
    sort(&mut rows);
    Ok(tail(rows))
}

/// `GET /api/marketplace-card-sales`.
pub async fn card_sales(State(state): State<RouteState>, method: Method, uri: Uri) -> Response {
    if let Some(r) = preflight_or_405(&method, &READ_CORS) {
        return r;
    }
    let q = http::Query::from_uri(&uri);
    let card_id = js::clean_text_str(q.search_param("cardId").unwrap_or(""), 80);
    if card_id.is_empty() || !card_id.bytes().all(|b| b.is_ascii_digit()) {
        return with_headers(StatusCode::BAD_REQUEST, json!({ "error": "cardId is required." }), &READ_CORS, &[]);
    }
    let id: i64 = card_id.parse().unwrap_or(0);
    let cache = [("cache-control", "public, max-age=20, s-maxage=120")];
    let include_native = q.search_param("includeNative").unwrap_or("").trim() == "1";
    let include_rows = include_native || q.search_param("includeRows").unwrap_or("").trim() == "1";
    if q.search_param("slices").unwrap_or("").trim() == "1" {
        return match core::read_oracle_sold_daily_rows(state.api.read(), id, &SoldSlice::default()).await {
            Ok((_, rows)) => with_headers(StatusCode::OK, json!({ "slices": rows.iter().map(core::compact_sold_daily_slice).collect::<Vec<_>>(), "source": "cardtrader_removed_sale" }), &READ_CORS, &cache),
            Err(e) => db_failure("marketplace-card-sales", &e, "Marketplace card sales failed.", &READ_CORS),
        };
    }
    let slice = SoldSlice::from_query(&q);
    let limit = util::js_limit(q.search_param("limit"), 120, 500);
    let pool = state.api.read();
    let (rows, series, filters) = tokio::join!(
        async {
            if include_rows { read_card_sales(&state, &card_id, limit, include_native, &slice).await } else { Ok(Vec::new()) }
        },
        core::read_oracle_card_sales_series(pool, id, &slice),
        core::read_oracle_sales_filters(pool, id, &slice),
    );
    let rows = match rows {
        Ok(rows) => rows,
        Err(response) => return response,
    };
    let (series, filters) = match (series, filters) {
        (Ok(s), Ok(f)) => (s, f),
        (Err(e), _) | (_, Err(e)) => return db_failure("marketplace-card-sales", &e, "Marketplace card sales failed.", &READ_CORS),
    };
    let mut body = Map::new();
    body.insert("rows".into(), Value::Array(rows));
    body.insert("series".into(), series);
    body.insert("filters".into(), filters);
    body.insert("slice".into(), Value::Object(slice.payload()));
    body.insert("source".into(), json!("cardtrader_removed_sale"));
    with_headers(StatusCode::OK, Value::Object(body), &READ_CORS, &cache)
}

const LAST_MEDIAN_CORS: [(&str, &str); 4] = [
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "GET, OPTIONS"),
    ("access-control-allow-headers", "Content-Type, Authorization"),
    ("access-control-max-age", "86400"),
];

/// `GET /api/marketplace-card-last-median`.
pub async fn card_last_median(State(state): State<RouteState>, method: Method, uri: Uri) -> Response {
    if let Some(r) = preflight_or_405(&method, &LAST_MEDIAN_CORS) {
        return r;
    }
    let q = http::Query::from_uri(&uri);
    let clean = |v: &str| {
        let t = v.trim();
        if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
            return String::new();
        }
        match t.parse::<f64>() {
            Ok(n) if js::is_safe_integer(n) && n > 0.0 => js::number_to_string(n),
            _ => String::new(),
        }
    };
    let mut ids: Vec<String> = Vec::new();
    let mut add = |v: &str| {
        let id = clean(v);
        if !id.is_empty() && !ids.contains(&id) && ids.len() < 40 {
            ids.push(id);
        }
    };
    add(util::first_of(&q, &["cardId", "blueprintId"]).unwrap_or(""));
    for part in q.search_param("cardIds").unwrap_or("").split(',') {
        add(part);
    }
    if ids.is_empty() {
        return with_headers(StatusCode::BAD_REQUEST, json!({ "error": "cardId is required." }), &LAST_MEDIAN_CORS, &[]);
    }
    let slice = SoldSlice::from_query(&q);
    let pool = state.api.read();
    let futures = ids.iter().map(|id| core::read_oracle_last_median(pool, id.parse().unwrap_or(0), &slice));
    let results = futures_util::future::join_all(futures).await;
    let mut prices = Vec::new();
    for r in results {
        match r {
            Ok(p) => prices.push(p),
            Err(e) => return db_failure("marketplace-card-last-median", &e, "Marketplace last-day median failed.", &LAST_MEDIAN_CORS),
        }
    }
    let first = prices.first().cloned().unwrap_or_else(|| core::last_median_payload(&ids[0], &Value::Null, &slice));
    let body = json!({
        "card_id": first["card_id"], "day": first["day"], "median_pkn": first["median_pkn"], "sample_count": first["sample_count"],
        "currency": "PKN", "source": "cardtrader_removed_sale",
        "condition": first["condition"], "language": first["language"], "reverse": first["reverse"],
        "firstEdition": first["firstEdition"], "graded": first["graded"],
        "prices": prices,
    });
    with_headers(StatusCode::OK, body, &LAST_MEDIAN_CORS, &[("cache-control", "public, max-age=20, s-maxage=120")])
}

// ---------------- cheapest price ----------------

fn cheapest_clean_text(value: &str, max: usize) -> String {
    js::clean_text_str(&value.split_whitespace().collect::<Vec<_>>().join(" "), max)
}

fn cheapest_card_id(value: &str) -> String {
    let t = value.trim();
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
        return String::new();
    }
    match t.parse::<f64>() {
        Ok(n) if js::is_safe_integer(n) && n > 0.0 => js::number_to_string(n),
        _ => String::new(),
    }
}

fn card_id_from_canonical_path(value: &str) -> String {
    let path = util::url_pathname(value);
    let re = regex::Regex::new(r"(?i)^/marketplace/[a-z]{2}(?:-[a-z]{2})?/cards/(\d+)(?:/|$)").expect("regex");
    if let Some(c) = re.captures(&path) {
        return cheapest_card_id(&c[1]);
    }
    let root = regex::Regex::new(r"^/(\d+)(?:/|$)").expect("regex");
    root.captures(&path).map(|c| cheapest_card_id(&c[1])).unwrap_or_default()
}

fn finite_positive(v: Option<&Value>) -> Option<f64> {
    let n = js::number(v);
    (n.is_finite() && n > 0.0).then_some(n)
}

fn nullable_number(v: Option<&Value>) -> Value {
    let n = js::number(v);
    if n.is_finite() { pg::js_number(n) } else { Value::Null }
}

fn or_null(row: &Value, keys: &[&str]) -> Value {
    keys.iter().filter_map(|k| row.get(*k)).find(|v| js::truthy(Some(v))).cloned().unwrap_or(Value::Null)
}

fn n0(row: &Value, key: &str) -> Value {
    pg::js_number(if js::truthy(row.get(key)) { js::number(row.get(key)) } else { 0.0 })
}

/// `cheapestPriceRow(row)`.
pub fn cheapest_price_row(row: &Value) -> Value {
    let s = |k: &str| js::string_or_empty(row.get(k));
    let ct_price = finite_positive(row.get("cardtrader_lowest_price_pkn"));
    let native_price = finite_positive(row.get("native_lowest_ask_pkn"));
    let provider = cheapest_clean_text(&[s("homepage_cache_provider"), s("cardtrader_provider")].into_iter().find(|v| !v.is_empty()).unwrap_or_default(), 80);
    let cache_source = if provider == "pokoin_native" { "pokoin_native_homepage_cache" } else { "cheapest_homepage_cache_blueprint" };
    let uses = ct_price.is_some();
    let price = ct_price;
    let listing_count = if uses { js::number(row.get("cardtrader_eligible_listing_count")).max(0.0) } else { 0.0 };
    let listing_count = if listing_count.is_finite() { listing_count } else { 0.0 };
    let listed_qty = if uses { let n = js::number(row.get("cardtrader_listed_quantity")); if n.is_finite() { n } else { 0.0 } } else { 0.0 };
    let reference = std::env::var("PKN_CHECKOUT_USDT_PRICE").ok().and_then(|v| http::js_number(&v)).filter(|n| n.is_finite() && *n > 0.0).unwrap_or(0.005);
    let price_v = price.map(pg::js_number).unwrap_or(Value::Null);
    let language = s("language");
    let ct_count = n0(row, "cardtrader_eligible_listing_count");
    json!({
        "cardId": s("card_id"),
        "canonicalPath": s("canonical_path"),
        "publicNumber": s("public_number"),
        "language": if language.is_empty() { "en".into() } else { language },
        "name": s("name"), "set": s("set_name"), "number": s("card_number"),
        "currency": "PKN", "unit": "PKN",
        "price": price_v, "pricePkn": price_v,
        "priceUsdt": price.map(|p| pg::js_number(p * reference)).unwrap_or(Value::Null),
        "pknReferencePriceUsdt": pg::js_number(reference),
        "source": if price.is_some() { json!(cache_source) } else { Value::Null },
        "provider": if price.is_some() { json!(if provider.is_empty() { "cardtrader".to_owned() } else { provider.clone() }) } else { Value::Null },
        "listingId": if uses { json!(s("cardtrader_sample_listing_id")) } else { json!("") },
        "listingCount": pg::js_number(listing_count),
        "listedQuantity": pg::js_number(listed_qty),
        "available": price.is_some() && listing_count > 0.0,
        "inStock": price.is_some() && listed_qty > 0.0,
        "updatedAt": if uses { or_null(row, &["cardtrader_updated_at", "cardtrader_source_snapshot_at"]) } else { Value::Null },
        "nativeListing": {
            "source": "marketplace_blueprint_price_summary",
            "pricePkn": native_price.map(pg::js_number).unwrap_or(Value::Null),
            "listingCount": n0(row, "native_active_listing_count"),
            "listedQuantity": n0(row, "native_listed_quantity"),
            "updatedAt": or_null(row, &["native_refreshed_at"]),
        },
        "cardtrader": {
            "source": cache_source,
            "provider": if !provider.is_empty() { provider.clone() } else if ct_price.is_none() { String::new() } else { "cardtrader".into() },
            "available": ct_price.is_some() && js::number(row.get("cardtrader_eligible_listing_count")) > 0.0,
            "pricePkn": ct_price.map(pg::js_number).unwrap_or(Value::Null),
            "priceEur": nullable_number(row.get("cardtrader_lowest_price_eur")),
            "listingCount": ct_count,
            "listedQuantity": n0(row, "cardtrader_listed_quantity"),
            "sampleListingId": s("cardtrader_sample_listing_id"),
            "sampleProductId": s("cardtrader_sample_product_id"),
            "sourceSnapshotAt": or_null(row, &["cardtrader_source_snapshot_at"]),
            "updatedAt": or_null(row, &["cardtrader_updated_at"]),
        },
    })
}

fn lookup_value(q: &http::Query, keys: &[&str]) -> Value {
    keys.iter().filter_map(|k| q.search_param(k)).find(|v| !v.is_empty()).map(|v| json!(v)).unwrap_or(Value::Null)
}

/// `GET /api/marketplace-card-cheapest-price`.
pub async fn card_cheapest_price(State(state): State<RouteState>, method: Method, uri: Uri) -> Response {
    if let Some(r) = preflight_or_405(&method, &LAST_MEDIAN_CORS) {
        return r;
    }
    let q = http::Query::from_uri(&uri);
    let lookup = json!({
        "cardId": lookup_value(&q, &["cardId", "blueprintId"]),
        "cardIds": lookup_value(&q, &["cardIds", "blueprintIds", "ids"]),
        "canonicalPath": lookup_value(&q, &["canonicalPath", "path", "url"]),
        "name": lookup_value(&q, &["name", "cardName", "pokemonName"]),
        "setName": lookup_value(&q, &["set", "setName", "expansion", "expansionName"]),
        "number": lookup_value(&q, &["number", "collectorNumber", "collectionNumber", "cardNumber"]),
        "language": lookup_value(&q, &["language", "lang"]),
        "limit": q.search_param("limit").map(|v| json!(v)).unwrap_or(Value::Null),
    });
    let text = |k: &str| js::string_or_empty(lookup.get(k));
    let mut ids: Vec<String> = Vec::new();
    let mut add = |v: &str| {
        let id = cheapest_card_id(v);
        if !id.is_empty() && !ids.contains(&id) && ids.len() < 50 {
            ids.push(id);
        }
    };
    add(&text("cardId"));
    for part in text("cardIds").split(',').map(str::trim).filter(|p| !p.is_empty()) {
        add(part);
    }
    add(&card_id_from_canonical_path(&text("canonicalPath")));
    let name = cheapest_clean_text(&text("name"), 120);
    let set_name = cheapest_clean_text(&text("setName"), 120);
    let number = cheapest_clean_text(&text("number"), 80);
    let language = card_versions::clean_language(lookup.get("language"));
    if ids.is_empty() && name.is_empty() && set_name.is_empty() && number.is_empty() {
        return with_headers(StatusCode::BAD_REQUEST, json!({ "error": "Provide cardId, cardIds, canonicalPath, or name/set/number lookup fields." }), &LAST_MEDIAN_CORS, &[]);
    }
    let limit = match q.search_param("limit").filter(|v| !v.is_empty()) {
        None => 5,
        Some(v) => match http::js_number(v) {
            Some(n) if n.is_finite() => (n.trunc() as i64).clamp(1, 10),
            _ => 5,
        },
    };
    let pool = state.api.read();
    let relation = match card_versions::cheapest_homepage_cache_relation_name(pool).await {
        Ok(r) => r,
        Err(e) => return db_failure("marketplace-card-cheapest-price", &e, "Marketplace card cheapest price failed.", &LAST_MEDIAN_CORS),
    };
    let sql = format!("{}{}\n      order by candidate_ids.ordinality asc, candidate_ids.card_id asc\n    ", CHEAPEST_SQL, card_versions::card_trader_availability_join("candidate_ids", &relation));
    let numeric: Vec<i64> = ids.iter().filter_map(|id| id.parse().ok()).collect();
    let rows = match pg::pool_rows(pool, &sql, &[Bind::BigIntArray(numeric), Bind::Text(name), Bind::Text(set_name), Bind::Text(number), Bind::Text(language), Bind::Int(limit)]).await {
        Ok(rows) => rows,
        Err(e) => return db_failure("marketplace-card-cheapest-price", &e, "Marketplace card cheapest price failed.", &LAST_MEDIAN_CORS),
    };
    let prices: Vec<Value> = rows.iter().map(cheapest_price_row).collect();
    let cache = [("cache-control", "public, max-age=10, s-maxage=30, stale-while-revalidate=60")];
    if prices.is_empty() {
        return with_headers(StatusCode::NOT_FOUND, json!({ "price": null, "prices": [], "count": 0, "lookup": lookup, "error": "No marketplace price found for this lookup." }), &LAST_MEDIAN_CORS, &cache);
    }
    with_headers(StatusCode::OK, json!({ "price": prices[0], "prices": prices, "count": prices.len(), "lookup": lookup }), &LAST_MEDIAN_CORS, &cache)
}

const CHEAPEST_SQL: &str = "
      with explicit_ids as (
        select
          requested.card_id,
          requested.ordinality::bigint as ordinality,
          c.ct_id
        from unnest($1::bigint[]) with ordinality as requested(card_id, ordinality)
        left join public.marketplace_search_candidates c
          on c.card_id = requested.card_id
      ),
      structured_ids as (
        select
          c.card_id,
          c.ct_id,
          (100000 + row_number() over (
            order by
              case
                when $2::text <> '' and public.marketplace_search_compact(c.name) = public.marketplace_search_compact($2::text) then 0
                else 1
              end,
              case
                when $4::text = '' then 1
                when public.marketplace_search_compact(c.card_number) = public.marketplace_search_compact($4::text) then 0
                when public.marketplace_search_compact(c.card_number) like '%' || public.marketplace_search_compact($4::text) || '%' then 1
                else 2
              end,
              case
                when $3::text <> '' and public.marketplace_search_compact(c.set_name) = public.marketplace_search_compact($3::text) then 0
                else 1
              end,
              c.search_weight desc,
              c.imported_at desc nulls last,
              c.card_id desc
          ))::bigint as ordinality
        from public.marketplace_search_candidates c
        where ($2::text <> '' or $3::text <> '' or $4::text <> '')
          and (
            $2::text = ''
            or public.marketplace_search_compact(c.name) = public.marketplace_search_compact($2::text)
            or c.name ilike '%' || $2::text || '%'
          )
          and (
            $3::text = ''
            or public.marketplace_search_compact(c.set_name) = public.marketplace_search_compact($3::text)
            or c.set_name ilike '%' || $3::text || '%'
          )
          and (
            $4::text = ''
            or public.marketplace_search_compact(c.card_number) = public.marketplace_search_compact($4::text)
            or public.marketplace_search_compact(c.card_number) like '%' || public.marketplace_search_compact($4::text) || '%'
          )
        order by ordinality
        limit $6
      ),
      candidate_ids as (
        select
          card_id,
          min(ct_id) as ct_id,
          min(ordinality) as ordinality
        from (
          select card_id, ct_id, ordinality from explicit_ids
          union all
          select card_id, ct_id, ordinality from structured_ids
        ) candidates
        group by card_id
      )
      select
        candidate_ids.card_id,
        candidate_ids.ordinality,
        coalesce(c.name, '') as name,
        coalesce(c.set_name, '') as set_name,
        coalesce(nullif(c.card_number, ''), '') as card_number,
        coalesce(urls.language, $5::text) as language,
        coalesce(urls.canonical_path, '') as canonical_path,
        coalesce(substring(urls.canonical_path from '/cards/([0-9]+)(?:/|$)'), '') as public_number,
        price_summary.lowest_ask_pkn as native_lowest_ask_pkn,
        coalesce(price_summary.active_listing_count, 0) as native_active_listing_count,
        coalesce(price_summary.listed_quantity, 0) as native_listed_quantity,
        price_summary.refreshed_at as native_refreshed_at,
        native_listing.id::text as native_sample_listing_id,
        cardtrader.provider as homepage_cache_provider,
        cardtrader.cheapest_price_pkn as cardtrader_lowest_price_pkn,
        cardtrader.cheapest_price_eur as cardtrader_lowest_price_eur,
        coalesce(cardtrader.eligible_listing_count, 0) as cardtrader_eligible_listing_count,
        coalesce(cardtrader.eligible_quantity, 0) as cardtrader_listed_quantity,
        cardtrader.sample_listing_id as cardtrader_sample_listing_id,
        cardtrader.sample_product_id as cardtrader_sample_product_id,
        cardtrader.source_snapshot_at as cardtrader_source_snapshot_at,
        cardtrader.updated_at as cardtrader_updated_at
      from candidate_ids
      left join public.marketplace_search_candidates c
        on c.card_id = candidate_ids.card_id
      left join public.marketplace_card_urls urls
        on urls.card_id = candidate_ids.card_id
        and urls.language = $5::text
      left join public.marketplace_blueprint_price_summary price_summary
        on price_summary.blueprint_id = candidate_ids.ct_id
      left join lateral (
        select listing.id
        from (
          select
            native_listing.*,
            case when native_listing.card_id ~ '^[0-9]+$' then native_listing.card_id::bigint else null end as card_id_bigint
          from public.marketplace_user_listings
          native_listing
        ) listing
        where listing.card_id_bigint = candidate_ids.card_id
          and listing.status = 'active'
          and listing.quantity_available > 0
          and listing.price_pkn > 0
          and coalesce(listing.shipping_available, true) = true
          and not (
            listing.nft_available = true
            and coalesce(listing.shipping_available, false) = false
          )
        order by listing.price_pkn asc, listing.updated_at desc, listing.id asc
        limit 1
      ) native_listing on true
      ";

// ---------------- price history ----------------

/// `parseRange(params)` of marketplace-tcgplayer-history.js.
pub fn parse_range(q: &http::Query) -> Result<(String, String, String), String> {
    let card_id = q.search_param("cardId").filter(|v| !v.is_empty()).unwrap_or("").to_owned();
    let from = q.search_param("from").filter(|v| !v.is_empty()).unwrap_or("2024-02-08").to_owned();
    let today = pg::iso(chrono::Utc::now())[..10].to_owned();
    let to = q.search_param("to").filter(|v| !v.is_empty()).map(str::to_owned).unwrap_or(today);
    let valid = |v: &str| v.len() == 10 && chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d").is_ok();
    let id_ok = !card_id.is_empty() && card_id.len() <= 18 && card_id.bytes().all(|b| b.is_ascii_digit()) && !card_id.starts_with('0');
    let span_ok = || {
        let f = chrono::NaiveDate::parse_from_str(&from, "%Y-%m-%d").ok();
        let t = chrono::NaiveDate::parse_from_str(&to, "%Y-%m-%d").ok();
        matches!((f, t), (Some(f), Some(t)) if (t - f).num_days() <= 3660)
    };
    if !id_ok || !valid(&from) || !valid(&to) || from > to || from.as_str() < "2024-01-01" || !span_ok() {
        return Err("Valid cardId and date range required (YYYY-MM-DD, maximum 10 years).".into());
    }
    Ok((card_id, from, to))
}

fn current_game(headers: &HeaderMap, q: &http::Query) -> String {
    game::parse_game_from_request(&http::header_pairs(headers), q.first("game").filter(|v| !v.is_empty()), q.first("marketplaceGame").filter(|v| !v.is_empty()))
}

fn day_of(v: &Value) -> String {
    js::string_or_empty(Some(v)).chars().take(10).collect()
}

fn count(v: Option<&Value>) -> i64 {
    let n = js::number(v);
    if n.is_finite() { (n.trunc() as i64).max(0) } else { 0 }
}

fn cardtrader_source(rows: &[Value], status: Option<&str>) -> Value {
    json!({
        "source": "cardtrader_listed", "currency": "PKN", "metric": "lowestAsk",
        "status": status.unwrap_or(if rows.is_empty() { "empty" } else { "available" }),
        "conditionSpecific": false, "languageSpecific": false,
        "days": rows.iter().map(|r| json!({
            "day": day_of(&r["day"]), "dumpDay": day_of(&r["dump_day"]),
            "lowestAskPkn": pg::js_number(js::number(r.get("lowest_ask_pkn"))),
            "listingCount": count(r.get("listing_count")), "listedQuantity": count(r.get("listed_quantity")),
            "sellerCount": count(r.get("seller_count")), "sourceTimestamp": if js::truthy(r.get("refreshed_at")) { r["refreshed_at"].clone() } else { Value::Null },
        })).collect::<Vec<_>>(),
    })
}

fn tcgplayer_source(rows: &[Value], status: Option<&str>) -> Value {
    let mut order: Vec<String> = Vec::new();
    let mut by: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for r in rows {
        let key = format!("{}:{}:{}", js::js_string(&r["category_id"]), js::js_string(&r["product_id"]), js::js_string(&r["subtype"]));
        let entry = by.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            json!({ "productId": js::js_string(&r["product_id"]), "categoryId": r["category_id"], "groupId": r["group_id"], "subtype": r["subtype"], "days": [] })
        });
        if let Some(days) = entry.get_mut("days").and_then(Value::as_array_mut) {
            days.push(json!({
                "day": day_of(&r["observed_on"]), "marketPrice": r["market_price"], "lowPrice": r["low_price"], "midPrice": r["mid_price"],
                "highPrice": r["high_price"], "directLowPrice": r["direct_low_price"], "sourceTimestamp": if js::truthy(r.get("snapshot_timestamp")) { r["snapshot_timestamp"].clone() } else { Value::Null },
            }));
        }
    }
    json!({
        "source": "tcgcsv/tcgplayer", "currency": "USD", "metric": "marketPrice",
        "status": status.unwrap_or(if rows.is_empty() { "empty" } else { "available" }),
        "conditionSpecific": false, "languageSpecific": false,
        "series": order.into_iter().filter_map(|k| by.remove(&k)).collect::<Vec<_>>(),
    })
}

const CARD_SQL: &str = "select card_id, ct_id, name, expansion_name, card_number
  from public.marketplace_search_candidates where card_id=$1::bigint limit 1";
const LISTED_SQL: &str = "select observed_day as dump_day,
    (refreshed_at at time zone 'utc')::date as day,
    min_price_pkn as lowest_ask_pkn, listing_count, listed_quantity, seller_count, refreshed_at
  from public.cardtrader_blueprint_daily_analytics
  where blueprint_id=$1::bigint
    and observed_day between $2::date - 1 and $3::date
    and (refreshed_at at time zone 'utc')::date between $2::date and $3::date
    and min_price_pkn > 0 and listing_count > 0
  order by refreshed_at, observed_day";

/// `GET /api/marketplace-card-price-history`.
pub async fn card_price_history(State(state): State<RouteState>, method: Method, headers: HeaderMap, uri: Uri) -> Response {
    let cors = [("access-control-allow-origin", "*"), ("access-control-allow-methods", "GET, OPTIONS"), ("access-control-allow-headers", "Content-Type")];
    if let Some(r) = preflight_or_405(&method, &cors) {
        return r;
    }
    let q = http::Query::from_uri(&uri);
    let (card_id, from, to) = match parse_range(&q) {
        Ok(r) => r,
        Err(message) => return with_headers(StatusCode::BAD_REQUEST, json!({ "error": message }), &cors, &[]),
    };
    let game_id = current_game(&headers, &q);
    let Some(pool) = state.api.game_pool(&game_id).await else {
        return with_headers(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "Card price history unavailable." }), &cors, &[]);
    };
    let card = match pg::pool_rows(&pool, CARD_SQL, &[Bind::Int(card_id.parse().unwrap_or(0))]).await {
        Ok(rows) => rows.into_iter().next(),
        Err(_) => return with_headers(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "Card price history unavailable." }), &cors, &[]),
    };
    let Some(card) = card else {
        return with_headers(StatusCode::NOT_FOUND, json!({ "error": "Card not found." }), &cors, &[]);
    };
    let ct = if card["ct_id"].is_null() { None } else { Some(js::js_string(&card["ct_id"])) };
    let (listed, tcg) = tokio::join!(
        async {
            match &ct {
                Some(ct) => pg::pool_rows(&pool, LISTED_SQL, &[Bind::Text(ct.clone()), Bind::Text(from.clone()), Bind::Text(to.clone())]).await,
                None => Ok(Vec::new()),
            }
        },
        tcgcsv::read_tcgplayer_history(&game_id, &card_id, &from, &to),
    );
    let cardtrader = match listed {
        Ok(rows) => cardtrader_source(&rows, None),
        Err(_) => cardtrader_source(&[], Some("unavailable")),
    };
    let tcgplayer = match tcg {
        Ok(result) => tcgplayer_source(result["observations"].as_array().map(Vec::as_slice).unwrap_or(&[]), None),
        Err(TcgError::Unconfigured) => tcgplayer_source(&[], Some(if std::env::var("TCGCSV_DATABASE_URL").map_or(true, |v| v.is_empty()) { "unconfigured" } else { "unavailable" })),
        Err(TcgError::Db(_)) => tcgplayer_source(&[], Some("unavailable")),
    };
    let degraded = [&cardtrader, &tcgplayer].iter().any(|f| matches!(f["status"].as_str(), Some("unavailable") | Some("unconfigured")));
    let body = json!({
        "game": game_id, "cardId": js::js_string(&card["card_id"]), "ctId": ct, "from": from, "to": to,
        "printing": { "name": card["name"], "setName": card["expansion_name"], "number": card["card_number"] },
        "cardtrader": cardtrader, "tcgplayer": tcgplayer,
    });
    with_headers(StatusCode::OK, body, &cors, &[("cache-control", if degraded { "no-store" } else { "public, max-age=20, s-maxage=120" })])
}

/// `GET /api/marketplace-tcgplayer-history` (signed-in).
pub async fn tcgplayer_history(State(state): State<RouteState>, method: Method, headers: HeaderMap, uri: Uri) -> Response {
    if method != Method::GET {
        return util::method_not_allowed("GET");
    }
    if let Err(response) = state.require_user(&headers).await {
        return response;
    }
    let q = http::Query::from_uri(&uri);
    let (card_id, from, to) = match parse_range(&q) {
        Ok(r) => r,
        Err(message) => return http::json(StatusCode::BAD_REQUEST, json!({ "error": message })),
    };
    let game_id = current_game(&headers, &q);
    match tcgcsv::read_tcgplayer_history(&game_id, &card_id, &from, &to).await {
        Ok(result) => http::json_with(StatusCode::OK, result, &[("cache-control", "private, max-age=60")]),
        Err(TcgError::Unconfigured) => http::json(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "TCGplayer history unavailable." })),
        Err(TcgError::Db(error)) => {
            tracing::warn!(%error, "tcgplayer history failed");
            http::json(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "TCGplayer history unavailable." }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        let q = http::Query::parse("cardId=239324&from=2025-01-01&to=2025-06-01");
        assert!(parse_range(&q).is_ok());
        let q = http::Query::parse("cardId=0239&from=2025-01-01&to=2025-06-01");
        assert!(parse_range(&q).is_err());
        let q = http::Query::parse("cardId=1&from=2023-12-31&to=2025-06-01");
        assert!(parse_range(&q).is_err());
        assert_eq!(card_id_from_canonical_path("/marketplace/en/cards/239324/x"), "239324");
        let row = json!({"card_id": "239324", "cardtrader_lowest_price_pkn": "22", "cardtrader_eligible_listing_count": 3, "cardtrader_listed_quantity": "4"});
        let p = cheapest_price_row(&row);
        assert_eq!(p["pricePkn"], json!(22));
        assert_eq!(p["provider"], "cardtrader");
        assert_eq!(p["available"], json!(true));
    }
}
