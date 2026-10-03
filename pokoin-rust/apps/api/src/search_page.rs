use std::collections::HashMap;
use std::time::Instant;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use pokoin_search::{
    clean_print_language, clean_text, page_body, print_matches, rank_rows, react_card,
    redis_search_query, SearchRow,
};
use serde_json::json;
use sqlx::FromRow;

use crate::suggest::{cors, game_from};
use crate::AppState;

pub async fn options() -> Response {
    cors(StatusCode::NO_CONTENT, None, None, "").into_response()
}

pub async fn search_page(
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
    let query = clean_text(param("query").or_else(|| param("q")).unwrap_or(""), 180);
    let product_type = clean_text(param("productType").unwrap_or(""), 60);
    let product_search_only = param("productSearchOnly") == Some("1");
    let include_facets = param("includeFacets") != Some("0");
    let lang_raw = clean_text(
        param("search_language")
            .or_else(|| param("lang"))
            .or_else(|| param("language"))
            .unwrap_or("en"),
        12,
    );
    let lang = if lang_raw.is_empty() { "en".into() } else { lang_raw };
    let limit = parse_limit(param("limit"), 100, 100);
    let offset = parse_offset(param("offset"));
    let print_language = clean_print_language(
        param("print_language")
            .or_else(|| param("printLanguage"))
            .unwrap_or("all"),
    );
    let delegate = game != "pokemon"
        || product_search_only
        || product_type == "jumbo"
        || query.is_empty()
        || include_facets
        || state.config.search_engine != "redis"
        || state.db.read().await.is_none()
        || state.redis.read().await.is_none();
    if delegate {
        return proxy_node(&state, &uri).await;
    }
    let started = Instant::now();
    let fetch_limit = (limit + 1).clamp(1, 100);
    let found = match redis_candidates(&state, &query, &print_language, fetch_limit, offset).await {
        Ok(found) => found,
        Err(error) => {
            tracing::error!(%error, "redis search page failed");
            state.errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return proxy_node(&state, &uri).await;
        }
    };
    state.meili_ms.fetch_add(
        started.elapsed().as_millis() as u64,
        std::sync::atomic::Ordering::Relaxed,
    );
    let sql_started = Instant::now();
    let mut rows = match hydrate(&state, &found.hits).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "search page hydrate failed");
            state.errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return proxy_node(&state, &uri).await;
        }
    };
    state.sql_ms.fetch_add(
        sql_started.elapsed().as_millis() as u64,
        std::sync::atomic::Ordering::Relaxed,
    );
    if !product_type.is_empty() {
        rows.retain(|row| row.product_type == product_type);
    }
    if print_language != "all" {
        rows.retain(|row| print_matches(&print_language, &row.nationality));
    }
    rank_rows(&mut rows, &query);
    let fetched = rows.len();
    let cards = rows
        .into_iter()
        .take(limit as usize)
        .map(|row| react_card(&row))
        .collect::<Vec<_>>();
    let mut body = page_body(
        &query,
        &game,
        &product_type,
        false,
        &lang,
        limit,
        offset,
        Some(found.total),
        cards,
    );
    if let Some(flag) = body.get_mut("hasMore") {
        *flag = serde_json::json!(fetched as i64 > limit);
    }
    tracing::info!(
        redis_ms = started.elapsed().as_millis() as u64,
        rows = fetched,
        "search page"
    );
    let mut response = json_response(
        StatusCode::OK,
        &body,
        "public, max-age=15, s-maxage=60, stale-while-revalidate=120",
    );
    response.headers_mut().insert(
        "x-pokoin-handler",
        "rust-search".parse().unwrap(),
    );
    response
}

struct Found {
    hits: Vec<Hit>,
    total: i64,
}

struct Hit {
    card_id: i64,
    weight: f64,
}

async fn redis_candidates(
    state: &AppState,
    query: &str,
    print_language: &str,
    limit: i64,
    offset: i64,
) -> Result<Found, redis::RedisError> {
    let Some(mut conn) = state.redis.read().await.clone() else {
        return Err(redis::RedisError::from((
            redis::ErrorKind::IoError,
            "redis is not configured",
        )));
    };
    let text = redis_search_query(query, print_language);
    if text.is_empty() {
        return Ok(Found { hits: Vec::new(), total: 0 });
    }
    let reply: redis::Value = redis::cmd("FT.SEARCH")
        .arg(&state.config.redis_index)
        .arg(text)
        .arg("LIMIT")
        .arg(offset.max(0))
        .arg(limit.clamp(1, 100))
        .arg("RETURN")
        .arg(3)
        .arg("card_id")
        .arg("search_weight")
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
    let total = redis_int(rows.first()).unwrap_or(0);
    let mut hits = Vec::new();
    let mut index = 1;
    while index + 1 < rows.len() {
        let fields = redis_pairs(&rows[index + 1]);
        if let Some(card_id) = fields.get("card_id").and_then(|value| value.parse().ok()) {
            hits.push(Hit {
                card_id,
                weight: fields
                    .get("search_weight")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0.0),
            });
        }
        index += 2;
    }
    Ok(Found { hits, total })
}

#[derive(FromRow)]
struct DbCard {
    card_id: i64,
    ct_id: Option<i64>,
    name: Option<String>,
    set_name: Option<String>,
    card_number: Option<String>,
    rarity: Option<String>,
    item_kind: Option<String>,
    product_type: Option<String>,
    image_url: Option<String>,
    cdn_image_url: Option<String>,
    preview_image_url: Option<String>,
    homepage_image_url: Option<String>,
    artist: Option<String>,
    illustrator: Option<String>,
    nationality: Option<String>,
    product_variant: Option<String>,
    emoji: Option<String>,
    search_weight: Option<f64>,
    price: Option<f64>,
    stock: Option<i64>,
    eligible_count: Option<i64>,
    provider: Option<String>,
}

async fn hydrate(state: &AppState, hits: &[Hit]) -> Result<Vec<SearchRow>, sqlx::Error> {
    let Some(pool) = state.db.read().await.clone() else {
        return Ok(Vec::new());
    };
    if hits.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i64> = hits.iter().map(|hit| hit.card_id).collect();
    let weights: HashMap<i64, f64> = hits.iter().map(|hit| (hit.card_id, hit.weight)).collect();
    let loaded = sqlx::query_as::<_, DbCard>(
        r#"
        select
          c.card_id,
          c.ct_id,
          c.name,
          c.set_name,
          c.card_number,
          c.rarity,
          c.item_kind,
          c.product_type,
          c.image_url,
          c.cdn_image_url,
          c.preview_image_url,
          c.homepage_image_url,
          c.artist,
          c.illustrator,
          (
            select e.nationality
            from public.pokoin_pokemon_expansions e
            where e.name = c.set_name
               or e.normalized_name = public.marketplace_search_normalize(c.set_name)
            order by case when e.name = c.set_name then 0 else 1 end
            limit 1
          ) as nationality,
          c.product_variant,
          c.emoji,
          c.search_weight::float8 as search_weight,
          cache.cheapest_price_pkn::float8 as price,
          coalesce(cache.eligible_quantity, cache.eligible_listing_count, 0)::int8 as stock,
          case
            when cache.provider = 'cardtrader' then coalesce(cache.eligible_listing_count, 0)
            else 0
          end::int8 as eligible_count,
          cache.provider
        from public.marketplace_search_candidates c
        left join lateral (
          select
            cache.cheapest_price_pkn,
            cache.eligible_quantity,
            cache.eligible_listing_count,
            cache.provider
          from public.cheapest_homepage_cache_blueprint cache
          where cache.provider in ('cardtrader', 'pokoin_native')
            and cache.eligible_listing_count > 0
            and cache.cheapest_price_pkn is not null
            and (
              cache.blueprint_id = c.ct_id
              or cache.pokoin_card_id = c.card_id::text
            )
          order by case when cache.provider = 'cardtrader' then 0 else 1 end,
            cache.cheapest_price_pkn
          limit 1
        ) cache on true
        where c.card_id = any($1::bigint[])
        "#,
    )
    .bind(&ids)
    .fetch_all(&pool)
    .await?;
    Ok(loaded
        .into_iter()
        .map(|row| {
            let weight = row.search_weight.unwrap_or(0.0);
            let fallback = weights.get(&row.card_id).copied().unwrap_or(0.0);
            let provider = row.provider.unwrap_or_default();
            SearchRow {
                card_id: row.card_id,
                ct_id: row.ct_id,
                name: row.name.unwrap_or_default(),
                set_name: row.set_name.unwrap_or_default(),
                card_number: row.card_number.unwrap_or_default(),
                rarity: row.rarity.unwrap_or_default(),
                item_kind: row.item_kind.unwrap_or_else(|| "single".into()),
                product_type: row.product_type.unwrap_or_else(|| "card".into()),
                image_url: row.image_url.unwrap_or_default(),
                cdn_image_url: row.cdn_image_url.unwrap_or_default(),
                preview_image_url: row.preview_image_url.unwrap_or_default(),
                homepage_image_url: row.homepage_image_url.unwrap_or_default(),
                artist: row.artist.unwrap_or_default(),
                illustrator: row.illustrator.unwrap_or_default(),
                nationality: row.nationality.unwrap_or_default(),
                product_variant: row.product_variant.unwrap_or_default(),
                emoji: row.emoji.unwrap_or_default(),
                search_weight: if weight > 0.0 { weight } else { fallback },
                price: row.price,
                stock: row.stock.unwrap_or(0),
                has_cardtrader: provider == "cardtrader" && row.eligible_count.unwrap_or(0) > 0,
                eligible_count: if provider == "cardtrader" {
                    row.eligible_count.unwrap_or(0)
                } else {
                    0
                },
            }
        })
        .collect())
}

fn parse_limit(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    let Some(raw) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return fallback;
    };
    let Ok(limit) = raw.parse::<f64>() else {
        return fallback;
    };
    if !limit.is_finite() {
        return fallback;
    }
    (limit.trunc() as i64).clamp(1, max)
}

fn parse_offset(value: Option<&str>) -> i64 {
    let Some(raw) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return 0;
    };
    let Ok(offset) = raw.parse::<f64>() else {
        return 0;
    };
    if !offset.is_finite() || offset < 0.0 {
        return 0;
    }
    (offset.trunc() as i64).min(10_000)
}

async fn proxy_node(state: &AppState, uri: &axum::http::Uri) -> Response {
    let url = format!(
        "{}{}",
        state.config.node_origin.trim_end_matches('/'),
        uri.path_and_query().map(|v| v.as_str()).unwrap_or("/")
    );
    match state.http.get(&url).send().await {
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
            cors(status, Some(cache), Some("application/json; charset=utf-8"), bytes)
                .into_response()
        }
        Err(error) => {
            tracing::error!(%error, "search page node fallback failed");
            json_response(
                StatusCode::BAD_GATEWAY,
                &json!({ "error": "Marketplace search page failed." }),
                "",
            )
        }
    }
}

fn json_response(status: StatusCode, body: &serde_json::Value, cache: &str) -> Response {
    cors(
        status,
        if cache.is_empty() { None } else { Some(cache.to_string()) },
        Some("application/json; charset=utf-8"),
        serde_json::to_vec(body).unwrap_or_default(),
    )
    .into_response()
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
