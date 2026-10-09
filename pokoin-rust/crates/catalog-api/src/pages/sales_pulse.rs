//! `GET /api/marketplace-sales-pulse` — port of `marketplace-sales-pulse.js`:
//! the latest completed daily sales leaders plus a bounded activity trend.

use axum::extract::State;
use axum::http::Uri;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use pokoin_api_common::http::Query;
use pokoin_api_common::RouteState;
use serde_json::{json, Map, Value};

use super::support;
use crate::shared::{js, rails};

/// `boundedInteger(value, fallback, max)` — `Number(null)` is 0, so a
/// missing param clamps to 1 exactly like the reference.
pub fn bounded_integer(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    let number = value
        .map(pokoin_api_common::http::js_number)
        .unwrap_or(Some(0.0)) // Number(null) === 0
        .unwrap_or(f64::NAN);
    if !number.is_finite() {
        return fallback;
    }
    (number.trunc() as i64).clamp(1, max)
}

/// `metricName(value)`.
pub fn metric_name(value: Option<&str>) -> &'static str {
    match value.unwrap_or("").trim().to_lowercase().as_str() {
        "quantity" | "units" => "quantity",
        _ => "sales",
    }
}

/// `integerValue(value)`.
pub fn integer_value(value: Option<&Value>) -> i64 {
    let number = js::number(value);
    if number.is_finite() {
        number.trunc().max(0.0) as i64
    } else {
        0
    }
}

/// `numberValue(value)`.
pub fn number_value(value: Option<&Value>) -> Value {
    let number = js::number(value);
    if number.is_finite() {
        js::js_json_number(number)
    } else {
        Value::Null
    }
}

/// `leaderFrom(raw, card)`.
pub fn leader_from(raw: &Value, card: &Value) -> Value {
    json!({
        "card": card,
        "salesDay": js::string_or_empty(js::get(raw, "salesDay")),
        "observedSales": integer_value(js::get(raw, "dailySaleSamples")),
        "removedListingQuantity": integer_value(js::get(raw, "dailySoldQty")),
        "medianPkn": number_value(js::get(raw, "dailyMedianPkn")),
        "minPkn": number_value(js::get(raw, "dailyMinPkn")),
        "maxPkn": number_value(js::get(raw, "dailyMaxPkn")),
    })
}

/// `rankLeaders(rawCards, metric, limit)`.
pub fn rank_leaders(raw_cards: &[Value], metric: &str, limit: usize) -> Vec<Value> {
    let cards = rails::publicize_cards(raw_cards);
    let field_quantity = metric == "quantity";
    let mut leaders: Vec<(Value, i64, i64)> = raw_cards
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let leader = leader_from(raw, cards.get(index).unwrap_or(&Value::Null));
            let observed = js::number(js::get(&leader, "observedSales")) as i64;
            let removed = js::number(js::get(&leader, "removedListingQuantity")) as i64;
            (leader, observed, removed)
        })
        .filter(|(leader, _, _)| {
            !rails::card_id(js::get(leader, "card").unwrap_or(&Value::Null)).is_empty()
                && js::number(js::get(
                    leader,
                    if field_quantity {
                        "removedListingQuantity"
                    } else {
                        "observedSales"
                    },
                )) > 0.0
        })
        .collect();
    // `right[field] - left[field] || right.observedSales - left.observedSales
    //  || right.removedListingQuantity - left.removedListingQuantity`.
    leaders.sort_by(|a, b| {
        let field = |leader: &(Value, i64, i64)| {
            if field_quantity {
                leader.2
            } else {
                leader.1
            }
        };
        field(b)
            .cmp(&field(a))
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| b.2.cmp(&a.2))
    });
    leaders
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(index, (leader, _, _))| {
            // `{ rank: index + 1, ...leader }`.
            let mut ranked = Map::new();
            ranked.insert("rank".into(), json!(index + 1));
            if let Some(map) = leader.as_object() {
                for (key, value) in map {
                    ranked.insert(key.clone(), value.clone());
                }
            }
            Value::Object(ranked)
        })
        .collect()
}

/// `readTrend(days)`.
pub async fn read_trend(pool: &sqlx::PgPool, days: i64) -> Result<Vec<Value>, sqlx::Error> {
    let sql = "
      with latest as (
        select max(observed_day) as day
        from public.cardtrader_sold_daily
      )
      select
        d.observed_day::text as day,
        sum(d.sold_qty)::bigint as removed_listing_quantity,
        sum(d.sample_count)::bigint as observed_sales,
        count(distinct d.blueprint_id)::integer as active_cards
      from public.cardtrader_sold_daily d, latest l
      where d.observed_day >= l.day - ($1::integer - 1)
      group by d.observed_day
      order by d.observed_day
    ";
    let rows: Vec<(String, i64, i64, i32)> = sqlx::query_as(sql)
        .bind(days as i32)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(day, removed, observed, active)| trend_entry(day, removed, observed, active))
        .collect())
}

/// The `readTrend` row mapping, factored for tests.
pub fn trend_entry(day: String, removed: i64, observed: i64, active: i32) -> Value {
    json!({
        "day": day,
        "observedSales": integer_value(Some(&json!(observed))),
        "removedListingQuantity": integer_value(Some(&json!(removed))),
        "activeCards": integer_value(Some(&json!(active))),
    })
}

/// Route handler (GET; OPTIONS is answered by the preflight route).
pub async fn handler(method: Method, State(state): State<RouteState>, uri: Uri) -> Response {
    if method != Method::GET {
        return support::method_not_allowed_get_options().await;
    }
    support::timing_scope("/api/marketplace-sales-pulse", "GET", handle(state, uri)).await
}

async fn handle(state: RouteState, uri: Uri) -> Response {
    let q = Query::from_uri(&uri);
    let pool = match support::game_pool(&state, "pokemon").await {
        Ok(pool) => pool,
        Err(response) => return response,
    };
    let metric = metric_name(q.search_param("metric"));
    let limit = bounded_integer(q.search_param("limit"), 12, 24);
    let days = bounded_integer(q.search_param("days"), 7, 30);
    let rail_id = if metric == "quantity" {
        "top_sold_quantity"
    } else {
        "top_sold"
    };

    let rows = match rails::read_rails(&pool, &[rail_id.to_string()]).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(error = %error, "marketplace-sales-pulse failed");
            return sales_pulse_error_response(&error, "Marketplace sales pulse failed.");
        }
    };
    let trend = match read_trend(&pool, days).await {
        Ok(trend) => trend,
        Err(error) => {
            tracing::warn!(error = %error, "marketplace-sales-pulse failed");
            return sales_pulse_error_response(&error, "Marketplace sales pulse failed.");
        }
    };
    let Some(rail) = rows.into_iter().next() else {
        return support::json_with_cors(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "Daily sales rail is unavailable." }),
        );
    };

    let raw_cards = rails::as_cards(rail.cards.as_ref());
    let leaders = rank_leaders(&raw_cards, metric, limit as usize);
    let meta = rail.meta.clone().unwrap_or(Value::Null);
    let meta_get = |key: &str| js::get(&meta, key);
    // `rail.meta?.observedSales ?? rail.meta?.listingEvents` — nullish chain.
    let observed = js::nullish_or(meta_get("observedSales"), meta_get("listingEvents"));
    let removed = js::nullish_or(meta_get("removedListingQuantity"), meta_get("soldQty"));
    let leader_day = leaders
        .first()
        .map(|leader| js::string_or_empty(js::get(leader, "salesDay")))
        .unwrap_or_default();
    let data_day = js::string_or_empty(Some(js::or(meta_get("day"), &Value::String(leader_day))));
    let source = js::string_or_empty(Some(js::or(
        meta_get("source"),
        &Value::String("cardtrader_removed_sale".to_string()),
    )));
    let methodology = js::string_or_empty(Some(js::or(
        meta_get("methodology"),
        &Value::String(
            "Observed sales are counted from individual CardTrader removal samples. Removed listing quantity is diagnostic only and is not treated as confirmed sales."
                .to_string(),
        ),
    )));
    let refreshed_at = rail
        .updated_at
        .map(|at| Value::String(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)))
        .unwrap_or(Value::Null);

    support::json_with_cache_control(
        StatusCode::OK,
        success_body(
            data_day,
            refreshed_at,
            metric,
            integer_value(observed),
            integer_value(removed),
            integer_value(meta_get("activeCards")),
            leaders,
            trend,
            source,
            methodology,
        ),
        "public, max-age=30, s-maxage=300, stale-while-revalidate=600",
    )
}

/// The `jsonOk` payload of the reference.
#[allow(clippy::too_many_arguments)]
pub fn success_body(
    data_day: String,
    refreshed_at: Value,
    metric: &str,
    observed_sales: i64,
    removed_listing_quantity: i64,
    active_cards: i64,
    leaders: Vec<Value>,
    trend: Vec<Value>,
    source: String,
    methodology: String,
) -> Value {
    json!({
        "dataDay": data_day,
        "refreshedAt": refreshed_at,
        "metric": metric,
        "totals": {
            "observedSales": observed_sales,
            "removedListingQuantity": removed_listing_quantity,
            "activeCards": active_cards,
        },
        "leaders": leaders,
        "trend": trend,
        "source": source,
        "methodology": methodology,
    })
}

/// The catch uses `error.statusCode || 500` + `error.message || fallback`.
fn sales_pulse_error_response(error: &sqlx::Error, fallback: &str) -> Response {
    let message = match error {
        sqlx::Error::Database(db) => db.message().to_string(),
        sqlx::Error::PoolTimedOut => "could not connect to server".to_string(),
        other if other.to_string().contains("error communicating") => {
            "connection refused".to_string()
        }
        other => other.to_string(),
    };
    support::json_with_cors(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "error": if message.is_empty() { fallback.to_string() } else { message } }),
    )
}

/// 405 for every method the reference rejects.
pub async fn method_not_allowed() -> Response {
    support::method_not_allowed_get_options().await
}
