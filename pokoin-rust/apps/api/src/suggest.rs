use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use pokoin_search::{
    assemble_pokemon_suggest, catalog_sql_needed, clean_print_language, clean_text, empty_suggest,
    group_suggest_hits, parse_limit, redis_search_query, suggest_meili_hit_limit, SuggestHitPage,
    SuggestParts,
};
use pokoin_api_common::compact::{encode as compact_encode, Wanted, C1_CONTENT_TYPE, C1_FORMAT_HEADER};
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

    let path = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("");
    let query_string = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    // `?format=c1` / `c1v2`, or the c1 media type in `Accept`: the same body, columnar.
    let wanted = Wanted::from_parts(headers.get(header::ACCEPT).and_then(|value| value.to_str().ok()), query_string);
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
        return multigame_suggest(state,headers,uri).await;
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
    let offset = param("offset").and_then(|value| value.parse::<i64>().ok()).unwrap_or(0).clamp(0, 10_000);
    let progressive = param("progressive") == Some("1") || offset > 0;
    let row_limit = if progressive { parse_limit(param("limit"), 50, 500) } else if hydrate {
        parse_limit(param("limit"), 1000, 1000)
    } else { POPUP_ROWS };
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
        return json_as(wanted, 
            &empty_suggest(&query, &game, "empty_query"),
            "public, max-age=5, s-maxage=30",
        );
    }
    if !language_ok(&search_language) {
        return json_as(wanted, 
            &empty_suggest(&query, &game, "meili_unavailable"),
            "public, max-age=5, s-maxage=15",
        );
    }
    let hit_limit = if progressive { row_limit } else if hydrate || print_language != "all" {
        1000
    } else { suggest_meili_hit_limit(group_limit) };
    let started = Instant::now();
    let page = if state.config.search_engine == "redis" {
        match redis_hits(&state, &query, "all", hit_limit, offset).await {
            Ok(page) => page,
            Err(error) => {
                tracing::error!(%error, "redis suggest failed");
                return json_as(wanted, 
                    &empty_suggest(&query, &game, "redis_error"),
                    "public, max-age=5, s-maxage=15",
                );
            }
        }
    } else if state.config.search_engine == "meili" && state.config.meili_url.is_some() {
        match meili_hits(&state, &query, hit_limit, offset, param("match") == Some("all")).await {
            Ok(page) => page,
            Err(error) => {
                tracing::error!(%error, "marketplace-suggest failed");
                return json_as(wanted, 
                    &empty_suggest(&query, &game, "meili_error"),
                    "public, max-age=5, s-maxage=15",
                );
            }
        }
    } else {
        return json_as(wanted, 
            &empty_suggest(&query, &game, "meili_unavailable"),
            "public, max-age=5, s-maxage=15",
        );
    };
    state.meili_ms.fetch_add(
        started.elapsed().as_millis() as u64,
        std::sync::atomic::Ordering::Relaxed,
    );
    let mut groups = group_suggest_hits(
        &page.hits,
        if progressive { page.hits.len().max(1) as i64 } else { group_limit },
        if progressive {
            page.hits.len().max(1) as i64
        } else if hydrate || print_language != "all" {
            1000
        } else {
            96
        },
        &query,
    );
    let (needs_nationality, needs_title) = catalog_sql_needed(&groups, &search_language);
    if let Some(pool) = state.db.read().await.clone() {
        let sql_started = Instant::now();
        if needs_nationality {
            fill_nationality(&pool, &mut groups).await;
        }
        if needs_title {
            overlay_titles(&pool, &search_language, &mut groups).await;
        }
        overlay_lang_scans(&pool, &search_language, &mut groups).await;
        state.sql_ms.fetch_add(
            sql_started.elapsed().as_millis() as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
    }
    let incoming = page.hits.len() as i64;
    let estimated = page.estimated_total as i64;
    let mut body = assemble_pokemon_suggest(
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
    body["offset"] = json!(offset);
    body["nextOffset"] = json!(offset + incoming);
    body["exhaustive"] = json!(incoming < hit_limit || offset + incoming >= estimated);
    json_as(wanted, 
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

pub(crate) fn game_from(headers: &HeaderMap, query_game: Option<&str>) -> String {
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

async fn redis_hits(
    state: &AppState,
    query: &str,
    print_language: &str,
    limit: i64,
    offset: i64,
) -> Result<SuggestHitPage, redis::RedisError> {
    let Some(mut conn) = state.redis.read().await.clone() else {
        return Err(redis::RedisError::from((
            redis::ErrorKind::IoError,
            "redis is not configured",
        )));
    };
    let text = redis_search_query(query, print_language);
    if text.is_empty() {
        return Ok(SuggestHitPage {
            hits: Vec::new(),
            estimated_total: 0,
            print_filter_applied: print_language != "all",
        });
    }
    let reply: redis::Value = redis::cmd("FT.SEARCH")
        .arg(&state.config.redis_index)
        .arg(text)
        .arg("LIMIT")
        .arg(offset.max(0))
        .arg(limit.clamp(1, 1000))
        .arg("RETURN")
        .arg(12)
        .arg("card_id")
        .arg("name")
        .arg("name_group")
        .arg("card_number")
        .arg("rarity")
        .arg("set_name")
        .arg("expansion_name")
        .arg("nicknames")
        .arg("cdn_image_url")
        .arg("search_weight")
        .arg("nationality")
        .arg("effective_print_bucket")
        .arg("DIALECT")
        .arg(2)
        .arg("TIMEOUT")
        .arg(800)
        .query_async(&mut conn)
        .await?;
    let rows = match reply {
        redis::Value::Array(rows) => rows,
        _ => Vec::new(),
    };
    let estimated = redis_int(rows.first()).unwrap_or(0) as u64;
    let mut hits = Vec::new();
    let mut index = 1;
    while index + 1 < rows.len() {
        let fields = redis_pairs(&rows[index + 1]);
        let card_id = fields.get("card_id").cloned().unwrap_or_default();
        if !card_id.trim().is_empty() {
            let nicknames = fields
                .get("nicknames")
                .map(|value| {
                    value
                        .split('|')
                        .map(str::trim)
                        .filter(|part| !part.is_empty())
                        .map(|part| json!(part))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            hits.push(json!({
                "card_id": card_id,
                "name": fields.get("name").cloned().unwrap_or_default(),
                "name_group": fields.get("name").cloned().unwrap_or_default(),
                "card_number": fields.get("card_number").cloned().unwrap_or_default(),
                "rarity": fields.get("rarity").cloned().unwrap_or_default(),
                "set_name": fields.get("set_name").cloned().unwrap_or_default(),
                "expansion_name": fields.get("expansion_name").cloned().unwrap_or_default(),
                "nicknames": nicknames,
                "cdn_image_url": fields.get("cdn_image_url").cloned().unwrap_or_default(),
                "search_weight": fields.get("search_weight").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0),
                "nationality": fields.get("nationality").cloned().unwrap_or_default(),
                "effective_print_bucket": fields.get("effective_print_bucket").cloned().unwrap_or_default(),
            }));
        }
        index += 2;
    }
    Ok(SuggestHitPage {
        hits,
        estimated_total: estimated,
        print_filter_applied: print_language != "all",
    })
}

fn redis_int(value: Option<&redis::Value>) -> Option<i64> {
    match value {
        Some(redis::Value::Int(number)) => Some(*number),
        Some(redis::Value::BulkString(bytes)) => String::from_utf8_lossy(bytes).parse().ok(),
        _ => None,
    }
}

fn redis_string(value: &redis::Value) -> String {
    match value {
        redis::Value::BulkString(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        redis::Value::SimpleString(text) => text.clone(),
        redis::Value::Int(number) => number.to_string(),
        redis::Value::Double(number) => number.to_string(),
        _ => String::new(),
    }
}

fn redis_pairs(value: &redis::Value) -> HashMap<String, String> {
    let rows = match value {
        redis::Value::Array(rows) => rows,
        _ => return HashMap::new(),
    };
    let mut out = HashMap::new();
    let mut index = 0;
    while index + 1 < rows.len() {
        out.insert(redis_string(&rows[index]), redis_string(&rows[index + 1]));
        index += 2;
    }
    out
}

async fn meili_hits(
    state: &AppState,
    query: &str,
    limit: i64,
    offset: i64,
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
        "offset": offset,
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

/// Card languages with TCGdex scans of western printings (docs/CARD_LANGUAGE_SCANS.md).
const LANG_SCAN_LANGUAGES: &[&str] = &["it", "fr", "de", "es", "pt"];

/// Same compact `langScans` string as the tile / desk reads (`de,fr,it:swsh/swsh3/136`),
/// so a French popup row shows the French scan the desk shows. Keyed by leftover
/// ct_id = public card id / 2. A failed lookup leaves the English scan.
async fn overlay_lang_scans(pool: &sqlx::PgPool, language: &str, groups: &mut [Value]) {
    if !LANG_SCAN_LANGUAGES.contains(&title_language(language).as_str()) {
        return;
    }
    let ct_ids = suggest_ct_ids(groups);
    if ct_ids.is_empty() {
        return;
    }
    let Ok(rows) = sqlx::query_as::<_, (i64, String)>(
        "select ct_id, string_agg(language, ',' order by language) || ':' || min(scan_path) from public.marketplace_leftover_lang_scans where ct_id = any($1::bigint[]) group by ct_id",
    )
    .bind(&ct_ids)
    .fetch_all(pool)
    .await
    else {
        return;
    };
    apply_lang_scans(groups, &rows.into_iter().collect());
}

fn printing_ct_id(printing: &Value) -> Option<i64> {
    let id = printing
        .get("card_id")
        .or_else(|| printing.get("id"))
        .and_then(|v| v.as_str().map(str::to_owned).or_else(|| v.as_i64().map(|n| n.to_string())))?;
    let id = id.trim().parse::<i64>().ok().filter(|n| *n > 0 && n % 2 == 0)?;
    Some(id / 2)
}

fn suggest_ct_ids(groups: &[Value]) -> Vec<i64> {
    let mut ids = groups
        .iter()
        .flat_map(|group| group.get("printings").and_then(|v| v.as_array()).into_iter().flatten())
        .filter_map(printing_ct_id)
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn apply_lang_scans(groups: &mut [Value], scans: &HashMap<i64, String>) {
    for group in groups {
        let Some(printings) = group.get_mut("printings").and_then(|v| v.as_array_mut()) else {
            continue;
        };
        for printing in printings {
            if let Some(scan) = printing_ct_id(printing).and_then(|ct| scans.get(&ct)) {
                printing["langScans"] = json!(scan);
            }
        }
    }
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



/// `json_ok` in the representation the client asked for. The compact form is
/// sent as `application/json` so the edge compresses it, marks itself with
/// `x-pokoin-format: c1`, and decodes back to exactly the default body.
fn json_as(wanted: Wanted, body: &Value, cache: &str) -> Response {
    if !wanted.c1() {
        return json_ok(body, cache);
    }
    let mut response = cors(
        StatusCode::OK,
        Some(cache.to_string()),
        Some(C1_CONTENT_TYPE),
        compact_encode::encode_to_vec_with(body, wanted.encode_options()),
    )
    .into_response();
    let headers = response.headers_mut();
    headers.insert(C1_FORMAT_HEADER.0, C1_FORMAT_HEADER.1.parse().unwrap());
    headers.insert(header::VARY, "Accept".parse().unwrap());
    response
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

pub(crate) fn cors(
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

async fn multigame_suggest(state:AppState,headers:HeaderMap,uri:axum::http::Uri)->Response {
 let p=crate::catalog_api::params(&uri);
 let game=game_from(&headers,p.get("game").or_else(||p.get("marketplaceGame")).map(String::as_str));
 let query=clean_text(p.get("q").or_else(||p.get("query")).map(String::as_str).unwrap_or(""),80);
 if query.is_empty(){return json_ok(&empty_suggest(&query,&game,"empty_query"),"public, max-age=5, s-maxage=30")}
 let Some(pool)=crate::catalog_api::game_pool(&state,&game).await else{return crate::catalog_api::response(StatusCode::SERVICE_UNAVAILABLE,json!({"error":"Marketplace database unavailable."}),"no-store")};
 let cap=crate::catalog_api::limit(&p,"limit",12,24);
 let needle=query.to_lowercase();let like=format!("%{needle}%");
 let sql=r#"select c.card_id from public.marketplace_search_candidates c where coalesce(c.cdn_image_url,c.preview_image_url,c.image_url) is not null
 and (c.search_text like $2 or word_similarity($1,coalesce(c.set_name,''))>0.4 or word_similarity($1,coalesce(c.name,''))>0.4)
 order by case when lower(c.name)=$1 then 0 when lower(c.set_name)=$1 then 1 when lower(c.name) like $2 then 2 when lower(c.set_name) like $2 then 3 when word_similarity($1,coalesce(c.set_name,''))>0.4 then 4 else 5 end,
 case when c.item_kind='single' then 0 else 1 end,c.search_weight desc,c.card_id desc limit $3"#;
 let ids=match sqlx::query_scalar::<_,i64>(sql).bind(needle).bind(like).bind((cap*8).max(48)).fetch_all(&pool).await {Ok(r)=>r,Err(e)=>return crate::catalog_api::failure(&e)};
 let cards=match crate::catalog_api::cards(&pool,&ids,&game).await {Ok(r)=>r,Err(e)=>return crate::catalog_api::failure(&e)};
 let mut groups=vec![];let mut names=HashMap::<String,usize>::new();
 for raw in cards {
  let card=pokoin_catalog::react_record(&raw);let name=card["name"].as_str().unwrap_or("");if name.is_empty(){continue}
  let key=name.to_lowercase();
  let index=if let Some(i)=names.get(&key){*i}else {
   if groups.len()>=cap as usize{continue}
   let i=groups.len();groups.push(json!({"name":name,"printings":[]}));names.insert(key,i);i
  };
  let rows=groups[index]["printings"].as_array_mut().unwrap();if rows.len()<6{rows.push(card)}
 }
 let shown=groups.iter().map(|g|g["printings"].as_array().unwrap().len()).sum::<usize>();
 json_ok(&json!({"query":query,"game":game,"groups":groups,"count":shown,"shown":shown}),"public, max-age=5, s-maxage=30")
}

#[cfg(test)]
mod lang_scan_tests {
    use super::*;

    #[test]
    fn popup_printings_take_the_leftover_language_scans() {
        let mut groups = vec![json!({"name": "Scolipede", "printings": [
            {"id": "684588", "card_id": "684588", "name": "Scolipede"},
            {"id": 263748, "name": "Scolipede"},
            {"id": "live:scolipede", "name": "Scolipede"},
        ]})];
        assert_eq!(suggest_ct_ids(&groups), vec![131874, 342294]);
        let scans = HashMap::from([(342294, "de,es,fr,it,pt:sv/sv10.5b/056".to_string())]);
        apply_lang_scans(&mut groups, &scans);
        let rows = groups[0]["printings"].as_array().unwrap();
        assert_eq!(rows[0]["langScans"], "de,es,fr,it,pt:sv/sv10.5b/056");
        assert!(rows[1].get("langScans").is_none());
        assert!(rows[2].get("langScans").is_none());
    }

    #[test]
    fn only_scan_languages_are_looked_up() {
        for lang in ["it", "fr", "de", "es", "pt"] {
            assert!(LANG_SCAN_LANGUAGES.contains(&title_language(lang).as_str()), "{lang}");
        }
        for lang in ["en", "jp", "ja", "ko", "zh", "zht", "nl", ""] {
            assert!(!LANG_SCAN_LANGUAGES.contains(&title_language(lang).as_str()), "{lang}");
        }
    }
}

#[cfg(test)]
mod c1_tests {
    use super::*;
    async fn bytes_of(response: Response) -> Vec<u8> {
        axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec()
    }

    #[tokio::test]
    async fn a_suggest_body_is_the_same_data_in_either_form() {
        let printing = |n: i64| json!({"id": n.to_string(), "name": "Mimikyu GX", "set": "Lost Thunder", "number": format!("{n}/214"), "imageUrl": format!("https://cdn.pokoin.com/leftovers/{n}.jpg")});
        let body = json!({"query": "mimikyu", "count": 148, "groups": [{"name": "Mimikyu GX", "printings": (1..=40).map(printing).collect::<Vec<_>>()}]});
        let plain = json_as(Wanted::DEFAULT, &body, "public, max-age=5");
        assert!(plain.headers().get("x-pokoin-format").is_none());
        assert_eq!(serde_json::from_slice::<Value>(&bytes_of(plain).await).unwrap(), body);

        let compact = json_as(Wanted::from_parts(None, "q=mimikyu&format=c1"), &body, "public, max-age=5");
        assert_eq!(compact.headers().get("x-pokoin-format").unwrap(), "c1");
        assert_eq!(compact.headers().get(header::CACHE_CONTROL).unwrap(), "public, max-age=5");
        assert_eq!(compact.headers().get(header::CONTENT_TYPE).unwrap(), "application/json; charset=utf-8");
        let packed = bytes_of(compact).await;
        assert!(packed.len() * 2 < serde_json::to_vec(&body).unwrap().len(), "{} bytes", packed.len());
        let decoded = pokoin_api_common::compact::decode::decode(&serde_json::from_slice(&packed).unwrap()).unwrap();
        assert_eq!(decoded, body);
    }
}
