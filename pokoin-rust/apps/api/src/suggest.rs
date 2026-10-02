use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use pokoin_search::{
    assemble_pokemon_suggest, catalog_sql_needed, clean_print_language, clean_text, empty_suggest,
    group_suggest_hits, parse_limit, suggest_meili_hit_limit, SuggestHitPage, SuggestParts,
};
use serde_json::{json, Value};

use crate::AppState;

const POPUP_ROWS: i64 = 20;
const ATTRIBUTES: &[&str] = &[
    "card_id",
    "name",
    "name_group",
    "card_number",
    "rarity",
    "set_name",
    "expansion_name",
    "expansion_aliases",
    "nicknames",
    "cdn_image_url",
    "canonical_path",
    "search_weight",
    "nationality",
    "effective_print_bucket",
    "_rankingScore",
];
const SEARCH_ON: &[&str] = &[
    "name",
    "name_normalized",
    "name_compact",
    "name_group",
    "nicknames",
    "card_number",
];

pub async fn options() -> Response {
    cors(StatusCode::NO_CONTENT, None, None, "").into_response()
}

pub async fn suggest(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Response {
    state.count_request();
    let path = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("");
    let query_string = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let params: Vec<(String, String)> =
        serde_urlencoded::from_str(query_string).unwrap_or_default();
    let param = |name: &str| {
        params
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    let game = game_from(&headers, param("game").or_else(|| param("marketplaceGame")));
    if game != "pokemon" {
        return proxy_node(&state, &uri).await;
    }
    let query = clean_text(param("q").or_else(|| param("query")).unwrap_or(""), 80);
    let search_language = {
        let raw = clean_text(
            param("search_language")
                .or_else(|| param("lang"))
                .or_else(|| param("language"))
                .unwrap_or("en"),
            12,
        );
        if raw.is_empty() {
            "en".into()
        } else {
            raw
        }
    };
    let hydrate = param("hydrate") == Some("1");
    let row_limit = if hydrate {
        parse_limit(param("limit"), 1000, 1000)
    } else {
        POPUP_ROWS
    };
    let group_limit = if hydrate {
        row_limit
    } else {
        parse_limit(param("limit"), POPUP_ROWS, 24)
    };
    let print_language = clean_print_language(
        param("print_language")
            .or_else(|| param("printLanguage"))
            .unwrap_or("all"),
    );
    if query.is_empty() {
        return json_ok(
            &empty_suggest(&query, &game, "empty_query"),
            "public, max-age=5, s-maxage=30",
        );
    }
    if state.config.search_engine != "meili"
        || state.config.meili_url.is_none()
        || !language_ok(&search_language)
    {
        return json_ok(
            &empty_suggest(&query, &game, "meili_unavailable"),
            "public, max-age=5, s-maxage=15",
        );
    }
    let hit_limit = if hydrate || print_language != "all" {
        1000
    } else {
        suggest_meili_hit_limit(group_limit)
    };
    let started = Instant::now();
    let page = match meili_hits(&state, &query, hit_limit, param("match") == Some("all")).await {
        Ok(page) => page,
        Err(error) => {
            tracing::error!(%error, "marketplace-suggest failed");
            return json_ok(
                &empty_suggest(&query, &game, "meili_error"),
                "public, max-age=5, s-maxage=15",
            );
        }
    };
    state.meili_ms.fetch_add(
        started.elapsed().as_millis() as u64,
        std::sync::atomic::Ordering::Relaxed,
    );
    let mut groups = group_suggest_hits(
        &page.hits,
        group_limit,
        if hydrate || print_language != "all" {
            1000
        } else {
            96
        },
        &query,
    );
    let (needs_nationality, needs_title) = catalog_sql_needed(&groups, &search_language);
    if let Some(pool) = state.db.clone() {
        let sql_started = Instant::now();
        if needs_nationality {
            fill_nationality(&pool, &mut groups).await;
        }
        if needs_title {
            overlay_titles(&pool, &search_language, &mut groups).await;
        }
        state.sql_ms.fetch_add(
            sql_started.elapsed().as_millis() as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
    }
    let body = assemble_pokemon_suggest(
        &SuggestParts {
            query,
            game,
            search_language,
            print_language,
            hydrate,
            group_limit,
            row_limit,
            hit_limit,
            page,
        },
        groups,
    );
    json_ok(
        &body,
        "public, max-age=5, s-maxage=30, stale-while-revalidate=120",
    )
}

fn language_ok(language: &str) -> bool {
    let language = language.trim().to_ascii_lowercase();
    if language.is_empty() || language == "en" {
        return true;
    }
    let bytes = language.as_bytes();
    if bytes.len() == 2 && bytes.iter().all(|b| b.is_ascii_lowercase()) {
        return true;
    }
    bytes.len() == 5
        && bytes[2] == b'-'
        && bytes[..2].iter().all(|b| b.is_ascii_lowercase())
        && bytes[3..].iter().all(|b| b.is_ascii_lowercase())
}

fn game_from(headers: &HeaderMap, query_game: Option<&str>) -> String {
    let raw = query_game
        .filter(|value| !value.trim().is_empty())
        .or_else(|| headers.get("x-pokoin-game").and_then(|v| v.to_str().ok()))
        .unwrap_or("pokemon")
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_");
    if raw.is_empty() || raw == "pokemon" || raw == "poke" || raw == "default" {
        "pokemon".into()
    } else {
        raw
    }
}

async fn meili_hits(
    state: &AppState,
    query: &str,
    limit: i64,
    match_all: bool,
) -> Result<SuggestHitPage, reqwest::Error> {
    let base = state.config.meili_url.clone().unwrap_or_default();
    let url = format!(
        "{}/indexes/{}/search",
        base.trim_end_matches('/'),
        state.config.meili_index
    );
    let mut body = json!({
        "q": query,
        "limit": limit.clamp(1, 1000),
        "offset": 0,
        "showRankingScore": true,
        "attributesToRetrieve": ATTRIBUTES,
        "attributesToSearchOn": SEARCH_ON,
        "attributesToHighlight": [],
        "filter": ["language = \"en\""],
    });
    if match_all {
        body["matchingStrategy"] = json!("all");
    }
    let mut request = state.http.post(url).json(&body);
    if let Some(key) = state.config.meili_key.as_deref() {
        request = request.header(header::AUTHORIZATION, format!("Bearer {key}"));
    }
    let payload: Value = request.send().await?.error_for_status()?.json().await?;
    let hits = payload
        .get("hits")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|hit| {
            !hit.get("card_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .is_empty()
        })
        .collect::<Vec<_>>();
    let estimated = payload
        .get("estimatedTotalHits")
        .or_else(|| payload.get("nbHits"))
        .and_then(|v| v.as_u64())
        .unwrap_or(hits.len() as u64);
    Ok(SuggestHitPage {
        hits,
        estimated_total: estimated,
        print_filter_applied: false,
    })
}

async fn nationality_map(pool: &sqlx::PgPool) -> HashMap<String, String> {
    // Same 10-minute expansion map Node keeps in `_expansion_nationality.js`.
    static CACHE: tokio::sync::Mutex<Option<(Instant, HashMap<String, String>)>> =
        tokio::sync::Mutex::const_new(None);
    {
        let guard = CACHE.lock().await;
        if let Some((at, map)) = guard.as_ref() {
            if at.elapsed() < Duration::from_secs(600) {
                return map.clone();
            }
        }
    }
    let Ok(rows) = sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>)>(
        "select name, normalized_name, nationality from public.pokoin_pokemon_expansions",
    )
    .fetch_all(pool)
    .await
    else {
        return HashMap::new();
    };
    let mut map = HashMap::new();
    for (name, normalized, nationality) in rows {
        let nationality = nationality.unwrap_or_default().trim().to_lowercase();
        if nationality.is_empty() {
            continue;
        }
        if let Some(name) = name {
            map.insert(name.trim().to_lowercase(), nationality.clone());
        }
        if let Some(normalized) = normalized {
            map.insert(normalized.trim().to_lowercase(), nationality);
        }
    }
    *CACHE.lock().await = Some((Instant::now(), map.clone()));
    map
}

async fn fill_nationality(pool: &sqlx::PgPool, groups: &mut [Value]) {
    let map = nationality_map(pool).await;
    if map.is_empty() {
        return;
    }
    for group in groups {
        let Some(printings) = group.get_mut("printings").and_then(|v| v.as_array_mut()) else {
            continue;
        };
        for printing in printings {
            let existing = printing
                .get("nationality")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if !existing.is_empty() {
                continue;
            }
            let set_name = printing
                .get("set")
                .or_else(|| printing.get("set_name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some(found) = map.get(&set_name.trim().to_lowercase()) {
                if let Some(object) = printing.as_object_mut() {
                    object.insert("nationality".into(), json!(found));
                }
            }
        }
    }
}

async fn overlay_titles(pool: &sqlx::PgPool, language: &str, groups: &mut [Value]) {
    let lang = title_language(language);
    if lang == "en" {
        return;
    }
    let mut names = Vec::new();
    let mut sets = Vec::new();
    let mut rarities = Vec::new();
    for group in groups.iter() {
        if let Some(name) = group.get("name").and_then(|v| v.as_str()) {
            names.push(name.to_lowercase());
        }
        for printing in group
            .get("printings")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            if let Some(name) = printing.get("name").and_then(|v| v.as_str()) {
                names.push(name.to_lowercase());
            }
            if let Some(set_name) = printing.get("set").and_then(|v| v.as_str()) {
                sets.push(set_name.to_lowercase());
            }
            if let Some(rarity) = printing.get("rarity").and_then(|v| v.as_str()) {
                rarities.push(rarity.to_lowercase());
            }
        }
    }
    let name_map = lookup_pairs(
        pool,
        "select lower(name), localized_name from public.card_name_languages where language = $1 and lower(name) = any($2)",
        &lang,
        &names,
    )
    .await;
    let set_map = lookup_pairs(
        pool,
        "select lower(e.name), l.localized_name from public.expansion_languages l join public.pokoin_pokemon_expansions e on e.expansion_id = l.expansion_id where l.language = $1 and (lower(e.name) = any($2) or lower(e.normalized_name) = any($2))",
        &lang,
        &sets,
    )
    .await;
    let rarity_map = lookup_pairs(
        pool,
        "select lower(rarity), localized_name from public.rarity_languages where language = $1 and lower(rarity) = any($2)",
        &lang,
        &rarities,
    )
    .await;
    for group in groups {
        if let Some(name) = group
            .get("name")
            .and_then(|v| v.as_str())
            .map(|v| v.to_lowercase())
        {
            if let Some(localized) = name_map.get(&name) {
                if let Some(object) = group.as_object_mut() {
                    object.insert("localized_name".into(), json!(localized));
                }
            }
        }
        let Some(printings) = group.get_mut("printings").and_then(|v| v.as_array_mut()) else {
            continue;
        };
        for printing in printings {
            let Some(object) = printing.as_object_mut() else {
                continue;
            };
            let name = object
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            let set_name = object
                .get("set")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            let rarity = object
                .get("rarity")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            if let Some(value) = name_map.get(&name) {
                object.insert("localized_name".into(), json!(value));
            }
            if let Some(value) = set_map.get(&set_name) {
                object.insert("localized_set".into(), json!(value));
            }
            if let Some(value) = rarity_map.get(&rarity) {
                object.insert("localized_rarity".into(), json!(value));
            }
        }
    }
}

async fn lookup_pairs(
    pool: &sqlx::PgPool,
    sql: &str,
    lang: &str,
    keys: &[String],
) -> std::collections::HashMap<String, String> {
    if keys.is_empty() {
        return std::collections::HashMap::new();
    }
    let Ok(rows) = sqlx::query_as::<_, (String, String)>(sql)
        .bind(lang)
        .bind(keys)
        .fetch_all(pool)
        .await
    else {
        return std::collections::HashMap::new();
    };
    rows.into_iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .collect()
}

fn title_language(value: &str) -> String {
    let language = value.trim().to_ascii_lowercase();
    match language.as_str() {
        "ja" => "jp".into(),
        "zh-cn" | "zh-hans" => "zh".into(),
        "zh-tw" | "zh-hant" => "zht".into(),
        "en" | "it" | "fr" | "de" | "es" | "jp" | "pt" | "nl" | "pl" | "ru" | "ko" | "zh"
        | "zht" | "id" | "th" | "vi" => language,
        _ => "en".into(),
    }
}

async fn proxy_node(state: &AppState, uri: &axum::http::Uri) -> Response {
    let url = format!(
        "{}{}",
        state.config.node_origin.trim_end_matches('/'),
        uri.path_and_query().map(|v| v.as_str()).unwrap_or("/")
    );
    match state.http.get(url).send().await {
        Ok(response) => {
            let status =
                StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let cache = response
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let bytes = response.bytes().await.unwrap_or_default();
            cors(status, Some(cache), None, bytes).into_response()
        }
        Err(_) => json_ok(
            &empty_suggest("", "pokemon", "sql_error"),
            "public, max-age=5, s-maxage=15",
        ),
    }
}

fn json_ok(body: &Value, cache: &str) -> Response {
    cors(
        StatusCode::OK,
        Some(cache.to_string()),
        Some("application/json; charset=utf-8"),
        serde_json::to_vec(body).unwrap_or_default(),
    )
    .into_response()
}

fn cors(
    status: StatusCode,
    cache: Option<String>,
    content_type: Option<&str>,
    body: impl Into<axum::body::Body>,
) -> impl IntoResponse {
    let mut response = (status, body.into()).into_response();
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET, OPTIONS".parse().unwrap(),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        "Content-Type, Authorization".parse().unwrap(),
    );
    headers.insert("access-control-max-age", "86400".parse().unwrap());
    if let Some(cache) = cache.filter(|value| !value.is_empty()) {
        headers.insert(header::CACHE_CONTROL, cache.parse().unwrap());
    }
    if let Some(content_type) = content_type {
        headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    }
    response
}

#[allow(dead_code)]
fn _json_error() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "GET, OPTIONS")],
        Json(json!({ "error": "Method not allowed." })),
    )
        .into_response()
}
