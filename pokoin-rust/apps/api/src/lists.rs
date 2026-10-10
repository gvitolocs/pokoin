//! Prebuilt list snapshots: set desks and artist desks are fixed catalog data,
//! so they are built once (with prices applied) by `pokoin-api job build-lists`
//! and served by one primary-key read, in plain JSON or `c1`.
//!
//! - `marketplace_list_snapshots (kind, key)` lives in every game database. The
//!   body is exactly what `/api/marketplace-expansion-page` or
//!   `/api/marketplace-artist-cards` returned, all pages joined, with gaps in
//!   tile prices filled from the daily median (what the SPA did per card).
//! - `marketplace_card_daily_median` holds one display median per card: the
//!   last day of the card-sales series, from the same Rust function the
//!   `/api/marketplace-card-sales` route uses.
//!
//! A missing snapshot answers 404 `{"missing":true}` and the SPA falls back to
//! the live routes, so a new set is never blank.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, Request, StatusCode, Uri},
    response::Response,
    Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::{sync::Semaphore, task::JoinSet};
use tower::ServiceExt;

use crate::{catalog_api, AppState};
use pokoin_api_common::compact;

const DDL: &str = "
create table if not exists public.marketplace_list_snapshots (
  kind text not null,
  key text not null,
  body text not null,
  c1 bytea not null,
  card_count integer not null default 0,
  version text not null,
  built_at timestamptz not null default now(),
  primary key (kind, key)
);
create table if not exists public.marketplace_card_daily_median (
  card_id bigint primary key,
  last_day date,
  last_median_pkn numeric not null,
  refreshed_at timestamptz not null default now()
);
";

const KINDS: [&str; 3] = ["set", "artist", "name"];
/// Static between builds; the builder runs every 15 min (sets) / hourly (artists).
const LIST_CACHE: &str = "public, max-age=120, s-maxage=900, stale-while-revalidate=86400";
/// The SPA's set-desk page size; a set is complete when a page comes back short.
const SET_PAGE: usize = 400;
const ARTIST_LIMIT: usize = 20_000;

fn clean_key(raw: Option<&str>) -> Option<String> {
    let key = raw.unwrap_or("").trim().to_ascii_lowercase();
    let ok = !key.is_empty()
        && key.len() <= 400
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    ok.then_some(key)
}

/// `GET /api/marketplace-list?kind=set|artist&key=<slug>[&game=][&format=c1]`
pub async fn list(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let q = pokoin_api_common::http::Query::from_uri(&uri);
    let kind = q.first("kind").unwrap_or("").trim().to_ascii_lowercase();
    if !KINDS.contains(&kind.as_str()) {
        return catalog_api::response(StatusCode::BAD_REQUEST, json!({"error": "kind must be set or artist."}), "no-store");
    }
    let Some(key) = clean_key(q.first("key")) else {
        return catalog_api::response(StatusCode::BAD_REQUEST, json!({"error": "key is required."}), "no-store");
    };
    let game = crate::suggest::game_from(&headers, q.first("game"));
    let Some(pool) = catalog_api::game_pool(&state, &game).await else {
        return catalog_api::response(StatusCode::SERVICE_UNAVAILABLE, json!({"error": "Marketplace database unavailable."}), "no-store");
    };
    let wanted = catalog_api::wanted(&headers, &uri);
    let row = sqlx::query_as::<_, (String, Vec<u8>, String)>(
        "select body, c1, version from public.marketplace_list_snapshots where kind = $1 and key = $2",
    )
    .bind(&kind)
    .bind(&key)
    .fetch_optional(&pool)
    .await;
    match row {
        Ok(Some((body, c1, version))) => {
            let (content_type, bytes, tag) = if wanted.c1() {
                // application/json, not the c1 media type: Cloudflare only
                // brotli-compresses known types. The payload marks itself c1.
                ("application/json; charset=utf-8", c1, format!("\"{version}-c1\""))
            } else {
                ("application/json; charset=utf-8", body.into_bytes(), format!("\"{version}\""))
            };
            let mut response = crate::suggest::cors(StatusCode::OK, Some(LIST_CACHE.to_owned()), Some(content_type), bytes).into_response();
            let h = response.headers_mut();
            h.insert(axum::http::header::VARY, HeaderValue::from_static("Accept"));
            if wanted.c1() {
                h.insert("x-pokoin-format", HeaderValue::from_static("c1"));
            }
            if let Ok(v) = HeaderValue::from_str(&tag) {
                h.insert(axum::http::header::ETAG, v);
            }
            response
        }
        Ok(None) => missing(),
        // A game database the builder has not reached yet has no table.
        Err(error) if error.to_string().contains("marketplace_list_snapshots") => missing(),
        Err(error) => catalog_api::failure(&error),
    }
}

fn missing() -> Response {
    catalog_api::response(StatusCode::NOT_FOUND, json!({"error": "List not built yet.", "missing": true}), "no-store")
}

use axum::response::IntoResponse;

// ---------------------------------------------------------------- builder

#[derive(Debug, Default)]
struct Options {
    kinds: Vec<String>,
    games: Vec<String>,
    key: Option<String>,
}

fn options(args: &[String]) -> Options {
    let mut o = Options::default();
    for arg in args {
        if let Some(v) = arg.strip_prefix("--kind=") {
            o.kinds.extend(v.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()));
        } else if let Some(v) = arg.strip_prefix("--game=") {
            o.games.extend(v.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()));
        } else if let Some(v) = arg.strip_prefix("--key=") {
            o.key = clean_key(Some(v));
        }
    }
    if o.kinds.is_empty() {
        o.kinds = vec!["median".into(), "set".into(), "artist".into(), "name".into()];
    }
    o
}

fn configured_games() -> Vec<String> {
    let mut games = vec!["pokemon".to_owned()];
    for g in pokoin_api_common::game::INGEST_GAMES {
        if std::env::var(g.database_url_env).is_ok_and(|v| !v.trim().is_empty()) {
            games.push(g.id.to_owned());
        }
    }
    games
}

/// In-process GET through the full API router (same body the SPA receives).
async fn get(app: &Router, game: &str, path: &str) -> anyhow::Result<Value> {
    let mut req = Request::builder()
        .method("GET")
        .uri(path)
        .header(pokoin_catalog_api::reads::artist_cards::LIST_BUILD_HEADER, "1");
    if game != "pokemon" {
        req = req.header("x-pokoin-game", game);
    }
    let response = app.clone().oneshot(req.body(Body::empty())?).await?;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024 * 1024).await?;
    anyhow::ensure!(status == StatusCode::OK, "{path} answered {status}");
    Ok(serde_json::from_slice(&bytes)?)
}

/// Keys are `clean_key` slugs (`[a-z0-9._-]`): safe in a query without encoding.
fn enc(s: &str) -> &str {
    s
}

/// `pokoin-api job build-lists [--kind=median,set,artist] [--game=pokemon,magic] [--key=slug]`
pub async fn build(app: Router, state: AppState, args: &[String]) -> anyhow::Result<()> {
    let o = options(args);
    let games = if o.games.is_empty() { configured_games() } else { o.games.clone() };
    for game in &games {
        // One unreachable game database is logged and skipped, never fatal.
        if let Err(error) = build_game(&app, &state, &o, game).await {
            tracing::error!(%game, error = %format!("{error:#}"), "build-lists game failed");
        }
        // Close this game's pool before the next game: every game database
        // lives on the one writer, shared with the API pods (max_connections).
        if game != "pokemon" {
            if let Some(pool) = state.game_dbs.write().await.remove(game.as_str()) {
                pool.close().await;
            }
        }
    }
    Ok(())
}

async fn build_game(app: &Router, state: &AppState, o: &Options, game: &str) -> anyhow::Result<()> {
    {
        let Some(pool) = catalog_api::game_pool(state, game).await else {
            tracing::warn!(%game, "build-lists: no database");
            return Ok(());
        };
        sqlx::raw_sql(DDL).execute(&pool).await?;
        if o.kinds.iter().any(|k| k == "median") && game == "pokemon" {
            let n = build_medians(&pool).await?;
            tracing::info!(%game, medians = n, "build-lists medians");
        }
        if o.kinds.iter().any(|k| k == "set") {
            let n = build_sets(app, &pool, game, o.key.as_deref()).await?;
            tracing::info!(%game, sets = n, "build-lists sets");
        }
        if o.kinds.iter().any(|k| k == "name") && game == "pokemon" {
            let n = build_names(app, &pool, game).await?;
            tracing::info!(%game, names = n, "build-lists names");
        }
        if o.kinds.iter().any(|k| k == "artist") && game == "pokemon" {
            let n = build_artists(app, &pool, game, o.key.as_deref()).await?;
            tracing::info!(%game, artists = n, "build-lists artists");
        }
    }
    Ok(())
}

async fn build_sets(app: &Router, pool: &PgPool, game: &str, only: Option<&str>) -> anyhow::Result<usize> {
    let slugs: Vec<String> = match only {
        Some(k) => vec![k.to_owned()],
        None => get(app, game, "/api/marketplace-expansion-page?limit=2000")
            .await?
            .get("expansions")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().filter_map(|r| r.get("slug").and_then(Value::as_str)).filter_map(|s| clean_key(Some(s))).collect())
            .unwrap_or_default(),
    };
    let jobs: Vec<_> = slugs.into_iter().map(|slug| {
        let app = app.clone();
        let game = game.to_owned();
        async move {
            let mut first: Option<Value> = None;
            let mut cards: Vec<Value> = Vec::new();
            let mut offset = 0;
            loop {
                let page = get(&app, &game, &format!(
                    "/api/marketplace-expansion-page?limit={SET_PAGE}&offset={offset}&productType=card&slug={}", enc(&slug)
                )).await?;
                let chunk = page.get("cards").and_then(Value::as_array).cloned().unwrap_or_default();
                let n = chunk.len();
                cards.extend(chunk);
                if first.is_none() {
                    first = Some(page);
                }
                if n < SET_PAGE || offset > 20_000 {
                    break;
                }
                offset += n;
            }
            let mut body = first.unwrap_or_else(|| json!({}));
            let total = cards.len();
            body["cards"] = Value::Array(cards);
            body["offset"] = json!(0);
            body["count"] = json!(total);
            body["total"] = json!(total);
            body["hasMore"] = json!(false);
            anyhow::Ok((slug, body))
        }
    }).collect();
    store_all(pool, "set", game, jobs, 4).await
}

async fn build_artists(app: &Router, pool: &PgPool, game: &str, only: Option<&str>) -> anyhow::Result<usize> {
    let slugs: Vec<String> = match only {
        Some(k) => vec![k.to_owned()],
        None => get(app, game, "/api/marketplace-artist-cards?summaries=1&limit=5000")
            .await?
            .get("artists")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().filter_map(|r| r.get("slug").and_then(Value::as_str)).filter_map(|s| clean_key(Some(s))).collect())
            .unwrap_or_default(),
    };
    let jobs: Vec<_> = slugs.into_iter().map(|slug| {
        let app = app.clone();
        let game = game.to_owned();
        async move {
            let body = get(&app, &game, &format!(
                "/api/marketplace-artist-cards?artistSlug={}&limit={ARTIST_LIMIT}&tiles=1", enc(&slug)
            )).await?;
            anyhow::Ok((slug, body))
        }
    }).collect();
    store_all(pool, "artist", game, jobs, 2).await
}

/// `kind=name` key: hex of the trimmed, lowercased card name. Collision-free
/// (Nidoran♀ / Nidoran♂) and the SPA derives it with TextEncoder.
pub fn name_key(name: &str) -> String {
    hex::encode(name.trim().to_lowercase().as_bytes())
}

/// `namesEqual` (exact-name.js): trimmed, case-insensitive.
fn names_equal(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// Every printing named exactly `name`: the versions desk's name lineup, the
/// rows `fetchExactNameCards` paged out of /api/marketplace-search-page.
async fn build_names(app: &Router, pool: &PgPool, game: &str) -> anyhow::Result<usize> {
    let names: Vec<String> = sqlx::query_scalar(
        "select distinct name from public.marketplace_search_candidates where coalesce(trim(name), '') <> ''",
    )
    .fetch_all(pool)
    .await?;
    let jobs: Vec<_> = names.into_iter().filter(|n| n.chars().count() <= 90).map(|name| {
        let app = app.clone();
        let game = game.to_owned();
        async move {
            let quoted = format!("\"{}\"", name.trim().replace('"', ""));
            let query: String = form_urlencoded_byte_serialize(&quoted);
            let mut cards: Vec<Value> = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for page in 0..8 {
                let data = get(&app, &game, &format!(
                    "/api/marketplace-search-page?query={query}&limit=96&offset={}&includeFacets=0&lang=en&search_language=en", page * 96
                )).await?;
                let rows = data.get("cards").and_then(Value::as_array).cloned().unwrap_or_default();
                let mut exact = 0;
                for row in rows {
                    let id = row.get("id").or_else(|| row.get("card_id")).map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())).unwrap_or_default();
                    if id.is_empty() || !names_equal(row.get("name").and_then(Value::as_str).unwrap_or(""), &name) || !seen.insert(id) {
                        continue;
                    }
                    exact += 1;
                    cards.push(row);
                }
                if data.get("hasMore").and_then(Value::as_bool) != Some(true) || exact == 0 {
                    break;
                }
            }
            anyhow::Ok((name_key(&name), json!({ "name": name.trim(), "cards": cards })))
        }
    }).collect();
    store_all(pool, "name", game, jobs, 6).await
}

/// application/x-www-form-urlencoded value encoding (search queries carry
/// spaces, quotes, accents and symbols).
fn form_urlencoded_byte_serialize(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 3);
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `GET /api/marketplace-daily-medians?ids=1,2,3` — the stored display median
/// per card (`marketplace_card_daily_median`), one read for a whole page.
pub async fn daily_medians(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let q = pokoin_api_common::http::Query::from_uri(&uri);
    let ids: Vec<i64> = q.first("ids").unwrap_or("").split(',').filter_map(|s| s.trim().parse::<i64>().ok()).filter(|n| *n > 0).take(500).collect();
    if ids.is_empty() {
        return catalog_api::response(StatusCode::OK, json!({"medians": {}}), "public, max-age=300, s-maxage=3600");
    }
    let game = crate::suggest::game_from(&headers, q.first("game"));
    let Some(pool) = catalog_api::game_pool(&state, &game).await else {
        return catalog_api::response(StatusCode::SERVICE_UNAVAILABLE, json!({"error": "Marketplace database unavailable."}), "no-store");
    };
    let rows = sqlx::query_as::<_, (i64, f64)>(
        "select card_id, last_median_pkn::float8 from public.marketplace_card_daily_median where card_id = any($1)",
    )
    .bind(&ids)
    .fetch_all(&pool)
    .await;
    match rows {
        Ok(rows) => {
            let medians: serde_json::Map<String, Value> = rows.into_iter().filter(|r| r.1 > 0.0).map(|(id, pkn)| (id.to_string(), json!(pkn))).collect();
            catalog_api::response(StatusCode::OK, json!({ "medians": medians }), "public, max-age=300, s-maxage=3600")
        }
        Err(error) if error.to_string().contains("marketplace_card_daily_median") => {
            catalog_api::response(StatusCode::OK, json!({"medians": {}}), "public, max-age=60")
        }
        Err(error) => catalog_api::failure(&error),
    }
}

/// Run builders with bounded concurrency; fill price gaps from the daily median
/// and upsert. One failing list is logged and skipped, never fatal.
async fn store_all<F>(pool: &PgPool, kind: &str, game: &str, jobs: Vec<F>, width: usize) -> anyhow::Result<usize>
where
    F: std::future::Future<Output = anyhow::Result<(String, Value)>> + Send + 'static,
{
    let gate = Arc::new(Semaphore::new(width));
    let mut set = JoinSet::new();
    for job in jobs {
        let gate = gate.clone();
        set.spawn(async move {
            let _permit = gate.acquire_owned().await?;
            job.await
        });
    }
    let mut stored = 0;
    while let Some(done) = set.join_next().await {
        match done {
            Ok(Ok((key, mut body))) => {
                if game == "pokemon" {
                    fill_medians(pool, &mut body).await;
                }
                match upsert(pool, kind, &key, &body).await {
                    Ok(()) => stored += 1,
                    Err(error) => tracing::error!(%kind, %key, %error, "build-lists store failed"),
                }
            }
            Ok(Err(error)) => tracing::warn!(%kind, %game, error = %format!("{error:#}"), "build-lists skipped a list"),
            Err(error) => tracing::error!(%kind, %error, "build-lists task failed"),
        }
    }
    Ok(stored)
}

fn tile_price_missing(card: &Value) -> bool {
    !["price", "lowest_price_pkn"].iter().any(|k| card.get(*k).and_then(Value::as_f64).is_some_and(|n| n > 0.0))
}

/// `applyLastMedianPrices`: cards without a tile price show the daily median.
async fn fill_medians(pool: &PgPool, body: &mut Value) {
    let Some(cards) = body.get_mut("cards").and_then(Value::as_array_mut) else { return };
    let ids: Vec<i64> = cards
        .iter()
        .filter(|c| tile_price_missing(c))
        .filter_map(|c| c.get("id").or_else(|| c.get("card_id")).and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_i64())))
        .collect();
    if ids.is_empty() {
        return;
    }
    let Ok(rows) = sqlx::query_as::<_, (i64, f64)>(
        "select card_id, last_median_pkn::float8 from public.marketplace_card_daily_median where card_id = any($1)",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await
    else {
        return;
    };
    let medians: std::collections::HashMap<String, f64> = rows.into_iter().map(|(id, pkn)| (id.to_string(), pkn)).collect();
    for card in cards.iter_mut().filter(|c| tile_price_missing(c)) {
        let id = card.get("id").or_else(|| card.get("card_id")).map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())).unwrap_or_default();
        if let Some(pkn) = medians.get(&id).copied().filter(|n| *n > 0.0) {
            card["price"] = json!(pkn);
            card["lowest_price_pkn"] = json!(pkn);
            card["lastMedianPkn"] = json!(pkn);
        }
    }
}

/// One key order for every card. c1 only builds a column table when each row's
/// keys are a subsequence of one order, and overlays (emoji, cheapest price)
/// insert keys at different positions; readers never depend on key order.
fn canonical_rows(body: &Value) -> Value {
    let mut body = body.clone();
    if let Some(cards) = body.get_mut("cards").and_then(Value::as_array_mut) {
        for card in cards.iter_mut() {
            if let Value::Object(map) = card {
                let mut entries: Vec<(String, Value)> = std::mem::take(map).into_iter().collect();
                entries.sort_by(|a, b| a.0.cmp(&b.0));
                map.extend(entries);
            }
        }
    }
    body
}

async fn upsert(pool: &PgPool, kind: &str, key: &str, body: &Value) -> anyhow::Result<()> {
    let body = &canonical_rows(body);
    let text = serde_json::to_string(body)?;
    let c1 = compact::encode::encode_to_vec(body);
    let version = hex::encode(&Sha256::digest(text.as_bytes())[..8]);
    let count = body.get("cards").and_then(Value::as_array).map_or(0, Vec::len) as i32;
    sqlx::query(
        "insert into public.marketplace_list_snapshots (kind, key, body, c1, card_count, version, built_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (kind, key) do update set body = excluded.body, c1 = excluded.c1,
           card_count = excluded.card_count, version = excluded.version, built_at = now()
         where marketplace_list_snapshots.version <> excluded.version",
    )
    .bind(kind)
    .bind(key)
    .bind(text)
    .bind(c1)
    .bind(count)
    .bind(version)
    .execute(pool)
    .await?;
    Ok(())
}

/// One display median per sold card: the last day of the card-sales series.
async fn build_medians(pool: &PgPool) -> anyhow::Result<usize> {
    use pokoin_catalog_api::sales::core::{read_oracle_card_sales_series, SoldSlice};
    let ids: Vec<i64> = sqlx::query_scalar(
        "select distinct c.card_id from public.marketplace_search_candidates c
         where c.ct_id in (select distinct blueprint_id from public.cardtrader_sold_daily)",
    )
    .fetch_all(pool)
    .await?;
    let gate = Arc::new(Semaphore::new(8));
    let mut set = JoinSet::new();
    for id in ids {
        let pool = pool.clone();
        let gate = gate.clone();
        set.spawn(async move {
            let _permit = gate.acquire_owned().await.ok()?;
            let series = read_oracle_card_sales_series(&pool, id, &SoldSlice::default()).await.ok()?;
            let pkn = series.get("lastMedianPkn").and_then(Value::as_f64).filter(|n| *n > 0.0)?;
            let day = series.get("lastDay").and_then(Value::as_str).map(str::to_owned);
            Some((id, pkn, day))
        });
    }
    let mut rows = Vec::new();
    while let Some(done) = set.join_next().await {
        if let Ok(Some(row)) = done {
            rows.push(row);
        }
    }
    for chunk in rows.chunks(1000) {
        let ids: Vec<i64> = chunk.iter().map(|r| r.0).collect();
        let pkns: Vec<f64> = chunk.iter().map(|r| r.1).collect();
        let days: Vec<Option<String>> = chunk.iter().map(|r| r.2.clone()).collect();
        sqlx::query(
            "insert into public.marketplace_card_daily_median (card_id, last_median_pkn, last_day, refreshed_at)
             select id, pkn, day::date, now() from unnest($1::bigint[], $2::float8[], $3::text[]) as t(id, pkn, day)
             on conflict (card_id) do update set last_median_pkn = excluded.last_median_pkn,
               last_day = excluded.last_day, refreshed_at = now()",
        )
        .bind(&ids)
        .bind(&pkns)
        .bind(&days)
        .execute(pool)
        .await?;
    }
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_slugs_only() {
        assert_eq!(clean_key(Some(" Base-Set ")).as_deref(), Some("base-set"));
        assert!(clean_key(Some("a/b")).is_none());
        assert!(clean_key(Some("")).is_none());
        assert!(clean_key(Some("x'; drop")).is_none());
    }

    #[test]
    fn options_default_to_every_kind() {
        let o = options(&["--game=magic".into(), "--key=Alpha".into()]);
        assert_eq!(o.kinds, vec!["median", "set", "artist", "name"]);
        assert_eq!(o.games, vec!["magic"]);
        assert_eq!(o.key.as_deref(), Some("alpha"));
    }

    #[test]
    fn rows_share_one_key_order_and_c1_compacts_them() {
        let body = json!({"cards": (0..40).map(|i| if i % 2 == 0 {
            json!({"id": i.to_string(), "name": "Pikachu", "price": 3, "set": "Base"})
        } else {
            json!({"price": 4, "set": "Base", "id": i.to_string(), "emoji": "x", "name": "Pikachu"})
        }).collect::<Vec<_>>()});
        let canon = canonical_rows(&body);
        let keys: Vec<Vec<String>> = canon["cards"].as_array().unwrap().iter().map(|c| c.as_object().unwrap().keys().cloned().collect()).collect();
        assert!(keys.iter().all(|k| k.windows(2).all(|w| w[0] <= w[1])));
        let raw = serde_json::to_vec(&canon).unwrap().len();
        let c1 = compact::encode::encode_to_vec(&canon).len();
        assert!(c1 * 2 < raw, "c1 {c1} vs json {raw}");
        assert_eq!(compact::decode::decode(&compact::encode::encode(&canon)).unwrap(), canon);
    }

    #[test]
    fn name_keys_are_hex_of_the_lowercased_name() {
        assert_eq!(name_key(" Mewtwo "), hex::encode("mewtwo"));
        assert_ne!(name_key("Nidoran♀"), name_key("Nidoran♂"));
        assert!(clean_key(Some(&name_key("Flabébé"))).is_some());
        assert_eq!(form_urlencoded_byte_serialize("\"Mr. Mime\""), "%22Mr.+Mime%22");
        assert!(names_equal(" pikachu", "Pikachu "));
    }

    #[test]
    fn median_fills_only_missing_prices() {
        assert!(tile_price_missing(&json!({"id": "1"})));
        assert!(tile_price_missing(&json!({"id": "1", "price": 0})));
        assert!(!tile_price_missing(&json!({"id": "1", "price": 12})));
        assert!(!tile_price_missing(&json!({"id": "1", "lowest_price_pkn": 3.5})));
    }
}
