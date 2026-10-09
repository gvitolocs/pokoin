//! `GET /api/marketplace-hot-blueprints` — port of `marketplace-hot-blueprints.js`
//! (60 s in-process pool cache with stale answers while a refresh runs).

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::pg::{self, Bind};
use pokoin_api_common::{http, RouteState};
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use super::util;
use crate::shared::js;

const HOT_POOL_TTL: Duration = Duration::from_secs(60);

struct Pool {
    key: String,
    rows: Arc<Vec<Value>>,
    created: Instant,
}

static CACHE: Mutex<Option<Pool>> = Mutex::const_new(None);
static REFRESHING: Mutex<bool> = Mutex::const_new(false);

/// `cleanWindow(value)`.
pub fn clean_window(value: &str) -> &'static str {
    match (if value.is_empty() { "24h".to_owned() } else { value.trim().to_lowercase() }).as_str() {
        "1h" => "1h",
        "7d" => "7d",
        _ => "24h",
    }
}

fn score_column(window: &str) -> &'static str {
    match window {
        "1h" => "hot_score_1h",
        "7d" => "hot_score_7d",
        _ => "hot_score_24h",
    }
}

fn wants_cards(value: Option<&str>) -> bool {
    matches!(value, Some("1") | Some("true") | Some("yes"))
}

async fn fetch_rows(state: &RouteState, limit: i64, window: &str) -> Result<Vec<Value>, sqlx::Error> {
    let order = score_column(window);
    let sql = format!(
        "
      with hot as (
        select *
        from public.marketplace_hot_blueprints
        where {order} > 0
        order by {order} desc, last_event_at desc nulls last, blueprint_id desc
        limit $1
      )
      select
        hot.blueprint_id, hot.name, hot.set_name, hot.card_number, hot.rarity, hot.card_type,
        urls.canonical_path, hot.item_kind, hot.product_type,
        hot.views_1h, hot.searches_1h, hot.clicks_1h, hot.cart_adds_1h, hot.reserves_1h, hot.sales_1h, hot.hot_score_1h,
        hot.views_24h, hot.searches_24h, hot.clicks_24h, hot.cart_adds_24h, hot.reserves_24h, hot.sales_24h, hot.hot_score_24h,
        hot.views_7d, hot.searches_7d, hot.clicks_7d, hot.cart_adds_7d, hot.reserves_7d, hot.sales_7d, hot.hot_score_7d,
        hot.last_event_at, hot.refreshed_at,
        c.product_variant, c.trainer_name, c.image_url, c.cdn_image_url, c.preview_image_url, c.card_palette, c.emoji, c.imported_at,
        artist.artist, artist.illustrator
      from hot
      left join public.marketplace_search_candidates c
        on c.card_id = hot.blueprint_id
      left join public.marketplace_blueprint_artists artist
        on artist.blueprint_id = hot.blueprint_id
      left join public.marketplace_card_urls urls
        on urls.card_id = hot.blueprint_id
        and urls.language = 'en'
      order by hot.{order} desc, hot.last_event_at desc nulls last, hot.blueprint_id desc
    "
    );
    pg::pool_rows(state.api.read(), &sql, &[Bind::Int(limit)]).await
}

/// `hotBlueprintRows(limit, window)` -> (rows, source).
async fn hot_rows(state: &RouteState, limit: i64, window: &str) -> Result<(Arc<Vec<Value>>, &'static str), sqlx::Error> {
    let key = format!("{window}:{limit}");
    {
        let cache = CACHE.lock().await;
        if let Some(pool) = cache.as_ref().filter(|p| p.key == key) {
            if pool.created.elapsed() < HOT_POOL_TTL {
                return Ok((pool.rows.clone(), "server_cache_hit"));
            }
            if *REFRESHING.lock().await {
                return Ok((pool.rows.clone(), "server_cache_stale"));
            }
        }
    }
    *REFRESHING.lock().await = true;
    let result = fetch_rows(state, limit, window).await;
    *REFRESHING.lock().await = false;
    let rows = Arc::new(result?);
    *CACHE.lock().await = Some(Pool { key, rows: rows.clone(), created: Instant::now() });
    Ok((rows, "server_cache_refresh"))
}

fn s(row: &Value, key: &str) -> Value {
    let v = js::string_or_empty(row.get(key));
    Value::String(v)
}

fn either(row: &Value, a: &str, b: &str) -> Value {
    let first = js::string_or_empty(row.get(a));
    Value::String(if first.is_empty() { js::string_or_empty(row.get(b)) } else { first })
}

fn or_str(row: &Value, key: &str, fallback: &str) -> Value {
    let v = js::string_or_empty(row.get(key));
    Value::String(if v.is_empty() { fallback.to_owned() } else { v })
}

fn n(row: &Value, key: &str) -> Value {
    pg::js_number(if js::truthy(row.get(key)) { js::number(row.get(key)) } else { 0.0 })
}

fn or_null(row: &Value, key: &str) -> Value {
    if js::truthy(row.get(key)) { row[key].clone() } else { Value::Null }
}

fn to_card_row(row: &Value) -> Value {
    let id = match row.get("blueprint_id") {
        Some(Value::Null) | None => String::new(),
        Some(v) => js::js_string(v),
    };
    json!({
        "card_id": id,
        "name": s(row, "name"), "set_name": s(row, "set_name"), "card_number": s(row, "card_number"),
        "product_variant": s(row, "product_variant"), "rarity": s(row, "rarity"), "card_type": s(row, "card_type"),
        "item_kind": or_str(row, "item_kind", "single"), "product_type": or_str(row, "product_type", "card"),
        "trainer_name": s(row, "trainer_name"), "canonical_path": s(row, "canonical_path"), "canonicalPath": s(row, "canonical_path"),
        "artist": either(row, "artist", "illustrator"), "illustrator": either(row, "illustrator", "artist"),
        "image_url": s(row, "image_url"), "cdn_image_url": s(row, "cdn_image_url"), "preview_image_url": s(row, "preview_image_url"),
        "card_palette": or_null(row, "card_palette"), "emoji": s(row, "emoji"), "imported_at": or_null(row, "imported_at"),
    })
}

fn blueprint(row: &Value) -> Value {
    let mut out = Map::new();
    out.insert("blueprintId".into(), Value::String(js::js_string(row.get("blueprint_id").unwrap_or(&Value::Null))));
    out.insert("name".into(), s(row, "name"));
    out.insert("set".into(), s(row, "set_name"));
    out.insert("number".into(), s(row, "card_number"));
    out.insert("rarity".into(), s(row, "rarity"));
    out.insert("type".into(), s(row, "card_type"));
    out.insert("canonicalPath".into(), s(row, "canonical_path"));
    out.insert("canonical_path".into(), s(row, "canonical_path"));
    out.insert("artist".into(), either(row, "artist", "illustrator"));
    out.insert("illustrator".into(), either(row, "illustrator", "artist"));
    out.insert("itemKind".into(), or_str(row, "item_kind", "single"));
    out.insert("productType".into(), or_str(row, "product_type", "card"));
    for w in ["1h", "24h", "7d"] {
        for (camel, snake) in [("views", "views"), ("searches", "searches"), ("clicks", "clicks"), ("cartAdds", "cart_adds"), ("reserves", "reserves"), ("sales", "sales"), ("hotScore", "hot_score")] {
            out.insert(format!("{camel}{w}"), n(row, &format!("{snake}_{w}")));
        }
    }
    out.insert("lastEventAt".into(), row.get("last_event_at").cloned().unwrap_or(Value::Null));
    out.insert("refreshedAt".into(), row.get("refreshed_at").cloned().unwrap_or(Value::Null));
    Value::Object(out)
}

pub async fn handler(State(state): State<RouteState>, method: Method, uri: Uri) -> Response {
    if method != Method::GET {
        return util::method_not_allowed("GET");
    }
    let q = http::Query::from_uri(&uri);
    let window = clean_window(q.search_param("window").unwrap_or(""));
    let limit = util::js_limit(q.search_param("limit"), 50, 1000);
    let include_cards = wants_cards(q.search_param("includeCards"));
    let started = Instant::now();
    match hot_rows(&state, limit, window).await {
        Ok((rows, source)) => {
            let duration = started.elapsed().as_millis() as i64;
            let mut body = json!({
                "window": window,
                "limit": limit,
                "pool": { "source": source, "size": rows.len(), "limit": limit, "ttlSeconds": 60, "durationMs": duration },
                "blueprints": rows.iter().map(blueprint).collect::<Vec<_>>(),
            });
            if include_cards {
                let cards: Vec<Value> = rows
                    .iter()
                    .map(to_card_row)
                    .filter(|c| {
                        !js::string_or_empty(c.get("card_id")).is_empty()
                            && ["preview_image_url", "cdn_image_url", "image_url"].iter().any(|k| !js::string_or_empty(c.get(*k)).is_empty())
                    })
                    .collect();
                body["cards"] = Value::Array(cards);
            }
            let timing = format!("hot-blueprints;dur={duration}");
            http::json_with(
                StatusCode::OK,
                body,
                &[("cache-control", "public, max-age=10, s-maxage=60, stale-while-revalidate=120"), ("server-timing", &timing)],
            )
        }
        Err(error) => util::db_error("marketplace-hot-blueprints", &error, "Marketplace hot blueprints failed."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_and_cards() {
        assert_eq!(clean_window(""), "24h");
        assert_eq!(clean_window("7D"), "7d");
        assert_eq!(clean_window("2h"), "24h");
        assert!(wants_cards(Some("yes")));
        assert!(!wants_cards(None));
        let row = json!({"blueprint_id": "5", "views_24h": "3", "hot_score_24h": 1.5, "artist": "", "illustrator": "Ken"});
        let b = blueprint(&row);
        assert_eq!(b["views24h"], json!(3));
        assert_eq!(b["hotScore24h"], json!(1.5));
        assert_eq!(b["artist"], "Ken");
    }
}
