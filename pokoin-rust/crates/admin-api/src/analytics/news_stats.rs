//! Port of `api/news-stats.js` — GET /api/news-stats, admin-only Pokoin News
//! reading stats aggregated from `public.news_events` (CTR, views, readers,
//! scroll depth, time on page, daily and per card position).

use axum::{
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
};
use serde_json::{json, Map, Value};
use sqlx::{Column, Row};

use pokoin_api_common::{http, RouteState};

const DEFAULT_DAYS: i64 = 30;
const MAX_ARTICLES: usize = 300;
const WINDOW: &str = "created_at >= now() - make_interval(days => $1::int)";

const CACHE_CONTROL: [(&str, &str); 1] = [("cache-control", "private, no-store")];

/// The six statements with the shared window; kept as functions so the SQL
/// text is exactly the Node one.
pub(crate) fn sql_articles() -> String {
    format!(
        r#"
    select article_id, max(article_path) as article_path,
           count(*) filter (where event_type = 'impression') as impressions,
           count(*) filter (where event_type = 'click') as clicks,
           count(distinct pv) filter (where event_type = 'view') as views,
           count(distinct (visitor, created_at::date)) filter (where event_type = 'view') as readers
    from public.news_events
    where {WINDOW}
    group by article_id"#
    )
}

pub(crate) fn sql_depth() -> String {
    format!(
        r#"
    select article_id,
           count(*) filter (where d >= 25) as d25,
           count(*) filter (where d >= 50) as d50,
           count(*) filter (where d >= 75) as d75,
           count(*) filter (where d >= 100) as d100
    from (
      select article_id, pv, max(depth) as d
      from public.news_events
      where {WINDOW} and event_type in ('read', 'leave') and depth is not null
      group by article_id, pv
    ) per_view
    group by article_id"#
    )
}

pub(crate) fn sql_time() -> String {
    format!(
        r#"
    select article_id,
           percentile_cont(0.5) within group (order by s) as median_seconds,
           percentile_cont(0.75) within group (order by s) as p75_seconds,
           count(*) filter (where s < 10) as quick_exits,
           count(*) as timed
    from (
      select article_id, pv, max(seconds) as s
      from public.news_events
      where {WINDOW} and event_type = 'leave'
      group by article_id, pv
    ) per_view
    group by article_id"#
    )
}

pub(crate) fn sql_daily() -> String {
    format!(
        r#"
    select to_char(created_at::date, 'YYYY-MM-DD') as day,
           count(distinct pv) filter (where event_type = 'view') as views,
           count(*) filter (where event_type = 'click') as clicks,
           count(*) filter (where event_type = 'impression') as impressions
    from public.news_events
    where {WINDOW}
    group by created_at::date
    order by created_at::date"#
    )
}

pub(crate) fn sql_positions() -> String {
    format!(
        r#"
    select position,
           count(*) filter (where event_type = 'impression') as impressions,
           count(*) filter (where event_type = 'click') as clicks
    from public.news_events
    where {WINDOW} and event_type in ('impression', 'click') and position is not null
    group by position
    order by position
    limit 50"#
    )
}

pub(crate) fn sql_overall() -> String {
    format!(
        r#"
    select percentile_cont(0.5) within group (order by s) as median_seconds
    from (
      select max(seconds) as s
      from public.news_events
      where {WINDOW} and event_type = 'leave'
      group by article_id, pv
    ) per_view"#
    )
}

/// `num(value)`.
pub(crate) fn num(value: &Value) -> f64 {
    crate::debug::js_number_of(value)
        .filter(|number| number.is_finite())
        .unwrap_or(0.0)
}

/// A JS number as JSON: `JSON.stringify(200)` prints `200`, never `200.0`.
pub(crate) fn js_num(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// `numOrNull(value)`: rounded integer or null.
pub(crate) fn num_or_null(value: &Value) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    match crate::debug::js_number_of(value) {
        Some(number) if number.is_finite() => js_num(number.round()),
        _ => Value::Null,
    }
}

/// `share(part, whole)`.
pub(crate) fn share(part: f64, whole: f64) -> Value {
    if whole > 0.0 {
        js_num((part / whole * 10000.0).round() / 10000.0)
    } else {
        Value::Null
    }
}

/// `cleanDays(value)`.
pub(crate) fn clean_days(value: Option<&str>) -> i64 {
    match value.and_then(http::js_number) {
        Some(days) if days.trunc() == days && (1.0..=365.0).contains(&days) => days as i64,
        _ => DEFAULT_DAYS,
    }
}

/// `callerIsAdmin(firestore, decoded)` — token claim, then the users/{uid}
/// profile (admin / isAdmin / role / roles), failures answer false.
pub(crate) async fn caller_is_admin(state: &RouteState, uid: &str, admin_claim: bool) -> bool {
    if admin_claim {
        return true;
    }
    let uid = uid.trim();
    if uid.is_empty() {
        return false;
    }
    let firestore = match state.accounts.firestore() {
        Ok(firestore) => firestore,
        Err(error) => {
            tracing::warn!(message = %error, "news-stats admin lookup failed");
            return false;
        }
    };
    let document = match firestore.doc(format!("users/{uid}")).get().await {
        Ok(Some(document)) => document,
        Ok(None) => return false,
        Err(error) => {
            tracing::warn!(message = %error, "news-stats admin lookup failed");
            return false;
        }
    };
    let profile = document.values();
    let flag = |key: &str| profile.get(key).is_some_and(|value| value.is_true());
    if flag("admin") || flag("isAdmin") {
        return true;
    }
    if let Some(role) = profile.get("role") {
        if role.as_str_or_empty().trim().eq_ignore_ascii_case("admin") {
            return true;
        }
    }
    let roles: Vec<String> = match profile.get("roles") {
        Some(value) => match value.as_array() {
            Some(items) => items
                .iter()
                .map(|role| role.as_str_or_empty().trim().to_lowercase())
                .collect(),
            None => value
                .as_str_or_empty()
                .split(',')
                .map(|role| role.trim().to_lowercase())
                .collect(),
        },
        None => vec![],
    };
    roles.iter().any(|role| role == "admin")
}

fn map_by_article(rows: &[Value]) -> Map<String, Value> {
    let mut map = Map::new();
    for row in rows {
        if let Some(id) = row.get("article_id").and_then(Value::as_str) {
            map.insert(id.to_owned(), row.clone());
        }
    }
    map
}

/// `buildStats({ days, now, articles, depth, time, daily, positions, overall })`.
pub(crate) fn build_stats(
    days: i64,
    now: &str,
    articles: &[Value],
    depth: &[Value],
    time: &[Value],
    daily: &[Value],
    positions: &[Value],
    overall: &[Value],
) -> Value {
    let depth_by = map_by_article(depth);
    let time_by = map_by_article(time);
    let mut rows: Vec<Value> = articles
        .iter()
        .map(|row| {
            let article_id = row.get("article_id").and_then(Value::as_str).unwrap_or("");
            let views = num(&row["views"]);
            let impressions = num(&row["impressions"]);
            let clicks = num(&row["clicks"]);
            let empty = json!({});
            let d = depth_by.get(article_id).unwrap_or(&empty);
            let t = time_by.get(article_id).unwrap_or(&empty);
            let timed = num(&t["timed"]);
            json!({
                "articleId": article_id,
                "articlePath": row.get("article_path").cloned().unwrap_or(Value::Null),
                "impressions": js_num(impressions),
                "clicks": js_num(clicks),
                "ctr": share(clicks, impressions),
                "views": js_num(views),
                "readers": js_num(num(&row["readers"])),
                "depth": {
                    "25": share(num(&d["d25"]), views),
                    "50": share(num(&d["d50"]), views),
                    "75": share(num(&d["d75"]), views),
                    "100": share(num(&d["d100"]), views),
                },
                "medianSeconds": num_or_null(&t["median_seconds"]),
                "p75Seconds": num_or_null(&t["p75_seconds"]),
                "quickExitShare": share(num(&t["quick_exits"]), timed),
                "timed": js_num(timed),
            })
        })
        .collect();
    // `rows.sort((a, b) => b.views - a.views || b.impressions - a.impressions)`
    // — Array#sort is stable, matching Rust's stable sort_by.
    rows.sort_by(|a, b| {
        let a_views = a["views"].as_f64().unwrap_or(0.0);
        let b_views = b["views"].as_f64().unwrap_or(0.0);
        let a_imp = a["impressions"].as_f64().unwrap_or(0.0);
        let b_imp = b["impressions"].as_f64().unwrap_or(0.0);
        b_views
            .partial_cmp(&a_views)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                b_imp
                    .partial_cmp(&a_imp)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    let mut totals = Map::new();
    for key in ["impressions", "clicks", "views", "readers"] {
        totals.insert(key.to_owned(), js_num(0.0));
    }
    for row in &rows {
        for key in ["impressions", "clicks", "views", "readers"] {
            let sum = totals[key].as_f64().unwrap_or(0.0) + row[key].as_f64().unwrap_or(0.0);
            totals.insert(key.to_owned(), js_num(sum));
        }
    }
    let overall_median = overall
        .first()
        .map(|row| num_or_null(&row["median_seconds"]))
        .unwrap_or(Value::Null);

    let mut totals_out = Map::new();
    for key in ["impressions", "clicks", "views", "readers"] {
        totals_out.insert(key.to_owned(), totals[key].clone());
    }
    totals_out.insert(
        "ctr".to_owned(),
        share(
            totals["clicks"].as_f64().unwrap_or(0.0),
            totals["impressions"].as_f64().unwrap_or(0.0),
        ),
    );
    totals_out.insert("medianSeconds".to_owned(), overall_median);

    json!({
        "days": days,
        "generatedAt": now,
        "totals": Value::Object(totals_out),
        "articles": Value::Array(rows.into_iter().take(MAX_ARTICLES).collect()),
        "daily": daily
            .iter()
            .map(|row| {
                json!({
                    "day": row.get("day").map(|d| d.as_str().unwrap_or("")).unwrap_or(""),
                    "views": js_num(num(&row["views"])),
                    "clicks": js_num(num(&row["clicks"])),
                    "impressions": js_num(num(&row["impressions"])),
                })
            })
            .collect::<Vec<_>>(),
        "positions": positions
            .iter()
            .map(|row| {
                let impressions = num(&row["impressions"]);
                let clicks = num(&row["clicks"]);
                json!({
                    "position": js_num(num(&row["position"])),
                    "impressions": js_num(impressions),
                    "clicks": js_num(clicks),
                    "ctr": share(clicks, impressions),
                })
            })
            .collect::<Vec<_>>(),
    })
}

async fn run_query(state: &RouteState, sql: &str, days: i64) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(sql)
        .bind(days as i32)
        .fetch_all(state.api.read())
        .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let mut object = Map::new();
            for (index, column) in row.columns().iter().enumerate() {
                let name = column.name().to_owned();
                let value: Value = if let Ok(text) = row.try_get::<Option<String>, _>(index) {
                    match text {
                        Some(text) => Value::String(text),
                        None => Value::Null,
                    }
                } else if let Ok(number) = row.try_get::<Option<i64>, _>(index) {
                    number.map(|n| json!(n)).unwrap_or(Value::Null)
                } else if let Ok(number) = row.try_get::<Option<i32>, _>(index) {
                    number.map(|n| json!(n)).unwrap_or(Value::Null)
                } else if let Ok(number) = row.try_get::<Option<f64>, _>(index) {
                    number.map(|n| json!(n)).unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                object.insert(name.to_owned(), value);
            }
            Value::Object(object)
        })
        .collect())
}

pub(crate) async fn handle(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if method != Method::GET {
        return http::json_with(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
            &[("allow", "GET")],
        );
    }
    // `res.setHeader('Cache-Control', 'private, no-store')` happens before
    // the auth checks, so every answer below carries it.
    let verified = state.require_user(&headers).await;
    let claims = match verified {
        Ok(claims) => claims,
        Err(_) => {
            return http::json_with(
                StatusCode::UNAUTHORIZED,
                json!({ "error": "Sign in as an admin." }),
                &CACHE_CONTROL,
            )
        }
    };
    let admin_claim = claims
        .extra
        .get("admin")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !caller_is_admin(&state, &claims.uid, admin_claim).await {
        return http::json_with(
            StatusCode::FORBIDDEN,
            json!({ "error": "Admins only." }),
            &CACHE_CONTROL,
        );
    }

    let query = http::Query::from_uri(&uri);
    let days = clean_days(query.first("days"));

    let articles_sql = sql_articles();
    let depth_sql = sql_depth();
    let time_sql = sql_time();
    let daily_sql = sql_daily();
    let positions_sql = sql_positions();
    let overall_sql = sql_overall();
    let (articles, depth, time, daily, positions, overall) = tokio::join!(
        run_query(&state, &articles_sql, days),
        run_query(&state, &depth_sql, days),
        run_query(&state, &time_sql, days),
        run_query(&state, &daily_sql, days),
        run_query(&state, &positions_sql, days),
        run_query(&state, &overall_sql, days),
    );
    let (articles, depth, time, daily, positions, overall) =
        match (articles, depth, time, daily, positions, overall) {
            (Ok(a), Ok(b), Ok(c), Ok(d), Ok(e), Ok(f)) => (a, b, c, d, e, f),
            _ => {
                return http::json_with(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": "News stats are unavailable right now." }),
                    &CACHE_CONTROL,
                );
            }
        };

    let now = crate::debug::now_iso();
    let payload = build_stats(
        days, &now, &articles, &depth, &time, &daily, &positions, &overall,
    );
    http::json_with(StatusCode::OK, payload, &CACHE_CONTROL)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> (
        Vec<Value>,
        Vec<Value>,
        Vec<Value>,
        Vec<Value>,
        Vec<Value>,
        Vec<Value>,
    ) {
        (
            vec![
                json!({"article_id": "art_a", "article_path": "/news/a", "impressions": "200", "clicks": "20", "views": "50", "readers": "40"}),
                json!({"article_id": "art_b", "article_path": "/news/b", "impressions": "0", "clicks": "0", "views": "80", "readers": "70"}),
            ],
            vec![
                json!({"article_id": "art_a", "d25": "40", "d50": "30", "d75": "20", "d100": "10"}),
            ],
            vec![
                json!({"article_id": "art_a", "median_seconds": 62.5, "p75_seconds": 120, "quick_exits": "5", "timed": "25"}),
            ],
            vec![
                json!({"day": "2026-10-07", "views": "130", "clicks": "20", "impressions": "200"}),
            ],
            vec![json!({"position": 1, "impressions": "100", "clicks": "15"})],
            vec![json!({"median_seconds": 48})],
        )
    }

    #[test]
    fn clean_days_outside_range_falls_back() {
        assert_eq!(clean_days(Some("0")), 30);
        assert_eq!(clean_days(Some("400")), 30);
        assert_eq!(clean_days(Some("abc")), 30);
        assert_eq!(clean_days(Some("90")), 90);
        assert_eq!(clean_days(None), 30);
    }

    #[test]
    fn build_stats_merges_and_sorts() {
        let (articles, depth, time, daily, positions, overall) = rows();
        let stats = build_stats(
            7,
            "2026-10-08T12:00:00.000Z",
            &articles,
            &depth,
            &time,
            &daily,
            &positions,
            &overall,
        );
        assert_eq!(stats["days"], 7);
        let ids: Vec<&str> = stats["articles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["articleId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["art_b", "art_a"], "sorted by views");
        let art_a = stats["articles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["articleId"] == "art_a")
            .unwrap();
        assert_eq!(art_a["ctr"], json!(0.1));
        assert_eq!(
            art_a["depth"],
            json!({"25": 0.8, "50": 0.6, "75": 0.4, "100": 0.2})
        );
        assert_eq!(art_a["medianSeconds"], 63, "Math.round(62.5) = 63");
        assert_eq!(art_a["quickExitShare"], json!(0.2));
        let art_b = stats["articles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["articleId"] == "art_b")
            .unwrap();
        assert_eq!(art_b["ctr"], Value::Null);
        assert_eq!(art_b["medianSeconds"], Value::Null);
        assert_eq!(
            stats["totals"],
            json!({"impressions": 200, "clicks": 20, "views": 130, "readers": 110, "ctr": 0.1, "medianSeconds": 48}),
            "JSON.stringify prints whole numbers without a decimal point"
        );
        assert_eq!(
            stats["positions"],
            json!([{"position": 1, "impressions": 100, "clicks": 15, "ctr": 0.15}])
        );
        assert_eq!(stats["daily"][0]["day"], "2026-10-07");
    }

    #[test]
    fn share_semantics() {
        assert_eq!(share(0.0, 0.0), Value::Null);
        assert_eq!(share(20.0, 200.0), json!(0.1));
        assert_eq!(share(0.0, 50.0), json!(0), "JSON.stringify(0) prints 0");
        assert_eq!(num(&json!("abc")), 0.0);
        assert_eq!(num_or_null(&Value::Null), Value::Null);
        assert_eq!(num_or_null(&json!(12.4)), json!(12));
        assert_eq!(js_num(200.0), json!(200));
        assert_eq!(js_num(62.5), json!(62.5));
    }
}
