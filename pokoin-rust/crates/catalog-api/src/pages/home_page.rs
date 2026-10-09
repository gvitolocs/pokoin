//! `GET /api/marketplace-home-page` — port of `marketplace-home-page.js`:
//! fast home carousels. Redis-cached home snapshots
//! (`pokoin:marketplace:v1:home:react[:game:{id}]:g{gen}`), short TTL plus
//! generation bumps, in-process coalescing so concurrent misses share one
//! SQL/rails load, and a parsed snapshot whose `cards` is an Array is a valid
//! hit (including the empty snapshot).

use axum::extract::State;
use axum::http::Uri;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use pokoin_api_common::http::Query;
use pokoin_api_common::RouteState;
use serde_json::{json, Map, Value};

use super::support;
use crate::shared::{cache, home_recent, js, rails, react_card, react_sql};

const SNAPSHOT_TTL_SEC: i64 = 20; // HOME_TTL_SEC

/// `emptySections()`.
pub fn empty_sections() -> Map<String, Value> {
    let mut sections = Map::new();
    for key in [
        "recentlySeenIds",
        "bestSellerIds",
        "featuredIds",
        "newArrivalIds",
        "spotlightIds",
        "topSoldIds",
    ] {
        sections.insert(key.to_string(), json!([]));
    }
    sections
}

/// `homeGeneration(game)`.
async fn home_generation(conn: Option<&mut redis::aio::ConnectionManager>, game: &str) -> String {
    let Some(conn) = conn else {
        return "0".to_string();
    };
    cache::command(
        conn,
        &["GET", &cache::generation_key(&format!("home:{game}"))],
    )
    .await
    .as_ref()
    .and_then(cache::value_to_i64)
    .filter(|n| *n > 0)
    .map(|n| n.to_string())
    .unwrap_or_else(|| "0".to_string())
}

/// `buildHomeSnapshot({ limit })`.
async fn build_home_snapshot(
    pool: &sqlx::PgPool,
    is_pokemon: bool,
    limit: i64,
) -> Result<Value, sqlx::Error> {
    if is_pokemon {
        // Rails first; failures fall through to the newest/hot SQL fallback.
        let rail_ids: Vec<String> = rails::HOME_RAILS
            .iter()
            .map(|row| row.0.to_string())
            .collect();
        if let Ok(rows) = rails::read_rails(pool, &rail_ids).await {
            if !rows.is_empty() {
                let generated_at =
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let from_rails = rails::assemble_home_vector(&rows, &generated_at);
                if from_rails
                    .get("cards")
                    .and_then(Value::as_array)
                    .is_some_and(|cards| !cards.is_empty())
                {
                    return Ok(from_rails);
                }
            }
        }
    }
    let newest_cap = limit.min(24);
    let hot_cap = 12.min(limit);
    let (newest_rows, hot_rows) = tokio::join!(
        react_card::with_timeout(
            2500,
            "marketplace-home-page newest",
            react_sql::read_newest_english_cards(pool, is_pokemon, newest_cap),
            Ok(Vec::new()),
        ),
        react_card::with_timeout(
            2500,
            "marketplace-home-page hot",
            react_sql::read_hot_cards(pool, is_pokemon, hot_cap),
            Ok(Vec::new()),
        ),
    );
    let newest_rows = newest_rows?;
    let hot_rows = hot_rows?;

    let mut by_id: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in newest_rows.iter().chain(hot_rows.iter()) {
        let id = js::string_or_empty(js::get(row, "card_id"));
        if !id.is_empty() && seen.insert(id) {
            by_id.push(row.clone());
        }
    }
    let ids: Vec<i64> = by_id
        .iter()
        .filter_map(|row| {
            let n = js::number(js::get(row, "card_id"));
            (js::is_safe_integer(n) && n > 0.0).then_some(n as i64)
        })
        .collect();
    let blueprint_ids: Vec<i64> = by_id
        .iter()
        .filter_map(|row| {
            let n = js::number(js::get(row, "ct_id"));
            (js::is_safe_integer(n) && n > 0.0).then_some(n as i64)
        })
        .collect();
    let (paths, cheapest) = tokio::join!(
        react_card::with_timeout(
            2000,
            "marketplace-home-page urls",
            react_sql::read_canonical_paths(pool, &ids),
            Ok(std::collections::HashMap::new()),
        ),
        react_card::with_timeout(
            2000,
            "marketplace-home-page cheapest",
            react_sql::read_cheapest_map(pool, is_pokemon, &ids, &blueprint_ids),
            react_sql::CheapestMap::default(),
        ),
    );
    let paths = paths?;
    let enriched = react_sql::apply_canonical_and_cheapest(&by_id, &paths, &cheapest);
    let cards = react_card::to_react_cards(&enriched);
    let newest_ids: Vec<String> = newest_rows
        .iter()
        .map(|row| js::string_or_empty(js::get(row, "card_id")))
        .filter(|id| !id.is_empty())
        .collect();
    let hot_ids: Vec<String> = hot_rows
        .iter()
        .map(|row| js::string_or_empty(js::get(row, "card_id")))
        .filter(|id| !id.is_empty())
        .collect();
    Ok(json!({
        "cards": cards,
        "sections": {
            "recentlySeenIds": [],
            "newArrivalIds": newest_ids.iter().take(12).cloned().collect::<Vec<_>>(),
            "featuredIds": hot_ids.iter().take(12).cloned().collect::<Vec<_>>(),
            "bestSellerIds": hot_ids.iter().take(12).cloned().collect::<Vec<_>>(),
            "spotlightIds": newest_ids.iter().take(16).cloned().collect::<Vec<_>>(),
        },
    }))
}

/// `defaultLoadHomeSnapshot({ limit })` — redis generation-scoped snapshot
/// with coalescing.
async fn default_load_home_snapshot(
    pool: &sqlx::PgPool,
    is_pokemon: bool,
    game: &str,
    limit: i64,
    redis: Option<redis::aio::ConnectionManager>,
) -> Result<Value, String> {
    let base_key = cache::home_snapshot_key(game);
    let snapshot = cache::coalesce(&base_key, async {
        let mut conn = redis.clone();
        let gen = match conn.as_mut() {
            Some(conn) => home_generation(Some(conn), game).await,
            None => "0".to_string(),
        };
        let cache_key = format!("{base_key}:g{gen}");
        let cached = match conn.as_mut() {
            Some(conn) => cache::get_json(conn, &cache_key).await,
            None => None,
        };
        if let Some(cached) = cached {
            let valid = cached.is_object() && cached.get("cards").is_some_and(Value::is_array);
            if valid {
                return Ok(js::spread_with(&cached, "cacheSource", json!("redis")));
            }
        }
        let snapshot = build_home_snapshot(pool, is_pokemon, limit)
            .await
            .map_err(|error| error.to_string())?;
        // A valid empty snapshot is cached too: it keeps a catalog hiccup
        // from turning into one uncached SQL fallback per request.
        if let Some(conn) = conn.as_mut() {
            cache::set_json(conn, &cache_key, &snapshot, SNAPSHOT_TTL_SEC).await;
        }
        Ok(js::spread_with(&snapshot, "cacheSource", json!("postgres")))
    })
    .await
    .map_err(sanitize_load_error)?;
    Ok(snapshot)
}

fn sanitize_load_error(message: String) -> String {
    if pokoin_api_common::public_error::is_pipeline_failure(&message) {
        pokoin_api_common::public_error::WORKING_MESSAGE.to_string()
    } else if message.is_empty() {
        "Marketplace home page failed.".to_string()
    } else {
        message
    }
}

/// `loadByIds` of the handler deps — candidates by ids + canonical paths +
/// cheapest, mapped to react cards.
async fn load_by_ids(
    pool: &sqlx::PgPool,
    is_pokemon: bool,
    ids: &[String],
) -> Result<Vec<Value>, sqlx::Error> {
    let numeric: Vec<i64> = ids.iter().filter_map(|id| id.parse().ok()).collect();
    let rows = react_sql::read_candidates_by_card_ids(pool, is_pokemon, &numeric).await?;
    let paths = react_sql::read_canonical_paths(pool, &numeric).await?;
    let blueprint_ids: Vec<i64> = rows
        .iter()
        .filter_map(|row| {
            let n = js::number(js::get(row, "ct_id"));
            (js::is_safe_integer(n) && n > 0.0).then_some(n as i64)
        })
        .collect();
    let cheapest = react_sql::read_cheapest_map(pool, is_pokemon, &numeric, &blueprint_ids).await;
    Ok(react_card::to_react_cards(
        &react_sql::apply_canonical_and_cheapest(&rows, &paths, &cheapest),
    ))
}

/// Route handler (GET; OPTIONS is answered by the preflight route).
pub async fn handler(
    method: Method,
    State(state): State<RouteState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if method != Method::GET {
        return support::method_not_allowed_get_options().await;
    }
    support::timing_scope(
        "/api/marketplace-home-page",
        "GET",
        handle(state, headers, uri),
    )
    .await
}

async fn handle(state: RouteState, headers: HeaderMap, uri: Uri) -> Response {
    let q = Query::from_uri(&uri);
    let game = support::resolve_game(&headers, q.first("game"), q.first("marketplaceGame"));
    let is_pokemon = pokoin_api_common::game::is_pokemon_game(&game);
    let pool = match support::game_pool(&state, &game).await {
        Ok(pool) => pool,
        Err(response) => return response,
    };

    let recent_ids = home_recent::recent_ids_from_url(&q);
    let limit = react_card::parse_limit(q.search_param("limit"), 36, 48);
    let redis = state.api.redis().await;
    let snapshot = match default_load_home_snapshot(&pool, is_pokemon, &game, limit, redis).await {
        Ok(snapshot) => snapshot,
        Err(message) => {
            let status = if pokoin_api_common::public_error::is_pipeline_failure(&message) {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            return support::json_with_cors(status, json!({ "error": message }));
        }
    };

    if !recent_ids.is_empty() {
        let existing: std::collections::HashSet<String> = snapshot
            .get("cards")
            .and_then(Value::as_array)
            .map(|cards| {
                cards
                    .iter()
                    .map(|card| js::string_or_empty(js::get(card, "id")))
                    .collect()
            })
            .unwrap_or_default();
        let missing: Vec<String> = recent_ids
            .iter()
            .filter(|id| !existing.contains(*id))
            .cloned()
            .collect();
        let mut extra: Vec<Value> = Vec::new();
        if !missing.is_empty() {
            extra = match react_card::with_timeout(
                2000,
                "marketplace-home-page recent",
                load_by_ids(&pool, is_pokemon, &missing),
                Ok(Vec::new()),
            )
            .await
            {
                Ok(extra) => extra,
                Err(error) => {
                    return support::node_error_response(&error, "Marketplace home page failed.")
                }
            };
        }
        let merged = home_recent::merge_recent_into_home(&snapshot, &recent_ids, &extra);
        let mut sections = empty_sections();
        if let Some(merged_sections) = merged.get("sections").and_then(Value::as_object) {
            for (key, value) in merged_sections {
                sections.insert(key.clone(), value.clone());
            }
        }
        return support::json_with_cache_control(
            StatusCode::OK,
            recent_body(&merged, &game, sections),
            "private, max-age=0, no-store",
        );
    }

    let sections = merged_sections(&snapshot);
    support::json_with_cache_control(
        StatusCode::OK,
        plain_body(&snapshot, &game, sections),
        "public, max-age=15, s-maxage=30, stale-while-revalidate=60",
    )
}

/// `{ ...emptySections(), ...snapshot.sections }` with key order preserved.
pub fn merged_sections(snapshot: &Value) -> Map<String, Value> {
    let mut sections = empty_sections();
    if let Some(snapshot_sections) = snapshot.get("sections").and_then(Value::as_object) {
        for (key, value) in snapshot_sections {
            sections.insert(key.clone(), value.clone());
        }
    }
    sections
}

/// The recentCardIds response body (`private, no-store` path).
pub fn recent_body(merged: &Value, game: &str, sections: Map<String, Value>) -> Value {
    let mut body = merged.as_object().cloned().unwrap_or_default();
    body.insert("game".into(), json!(game));
    body.insert("sections".into(), Value::Object(sections));
    Value::Object(body)
}

/// The plain response body. `source` follows `snapshot.source || undefined`.
pub fn plain_body(snapshot: &Value, game: &str, sections: Map<String, Value>) -> Value {
    let mut body = snapshot.as_object().cloned().unwrap_or_default();
    body.entry("cards".to_string()).or_insert_with(|| json!([]));
    body.insert("game".into(), json!(game));
    let source = js::string_or_empty(js::get(snapshot, "source"));
    if source.is_empty() {
        body.remove("source");
    } else {
        body.insert("source".into(), json!(source));
    }
    body.insert("sections".into(), Value::Object(sections));
    Value::Object(body)
}

/// 405 for every method the reference rejects.
pub async fn method_not_allowed() -> Response {
    support::method_not_allowed_get_options().await
}
