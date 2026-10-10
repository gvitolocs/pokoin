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

use std::sync::{Arc, LazyLock};

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

use crate::{catalog_api, related, AppState};
use pokoin_api_common::compact;
use pokoin_catalog_api::shared::page_snapshot;
use pokoin_shared_dictionary::SharedDictionary;

/// The RFC 9842 shared dictionary for `c1v2` list snapshots: raw content
/// trained on every list snapshot (128 KB). A new dictionary is a new file and
/// id; snapshots carry the id they were compressed with.
static DICTIONARY: LazyLock<SharedDictionary> =
    LazyLock::new(|| SharedDictionary::new(include_bytes!("../assets/c1-shared-d30efab9dda40a4b.dict").to_vec()));
/// Browsers keep the dictionary a day, then revalidate it (ETag is its id), so
/// a new dictionary reaches them without a new URL.
const DICTIONARY_CACHE: &str = "public, max-age=86400";

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
-- c1 format 2 (template columns) and brotli-11 copies served as-is.
alter table public.marketplace_list_snapshots add column if not exists c1v2 bytea;
alter table public.marketplace_list_snapshots add column if not exists br_json bytea;
alter table public.marketplace_list_snapshots add column if not exists br_c1 bytea;
alter table public.marketplace_list_snapshots add column if not exists br_c1v2 bytea;
-- RFC 9842 dcb of c1v2 against the shared dictionary `dcb_dict` (its id).
alter table public.marketplace_list_snapshots add column if not exists dcb_c1v2 bytea;
alter table public.marketplace_list_snapshots add column if not exists dcb_dict text;
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
/// A `dcb` body is never stored by a shared cache: Cloudflare's dictionary
/// passthrough does not key its cache on `Available-Dictionary` (tested
/// 2026-10-10: one cached `dcb` body was replayed to `br`, gzip and identity
/// clients).
const LIST_CACHE_DCB: &str = "private, max-age=120";
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
    let brotli = accepts_coding(&headers, "br");
    // dcb needs the browser to hold our dictionary: it says so with its hash.
    let dictionary = &*DICTIONARY;
    let dcb_ready = accepts_coding(&headers, "dcb")
        && headers
            .get("available-dictionary")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| dictionary.matches(value));
    type Row = (String, Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, Option<String>, String);
    let row = sqlx::query_as::<_, Row>(
        "select body, c1, c1v2, br_json, br_c1, br_c1v2, dcb_c1v2, dcb_dict, version
         from public.marketplace_list_snapshots where kind = $1 and key = $2",
    )
    .bind(&kind)
    .bind(&key)
    .fetch_optional(&pool)
    .await;
    match row {
        Ok(Some((body, c1, c1v2, br_json, br_c1, br_c1v2, dcb_c1v2, dcb_dict, version))) => {
            // c1v2 only for clients that read template columns; a snapshot
            // built before format 2 falls back to c1.
            let has_v2 = c1v2.is_some();
            let (format, plain, compressed) = match (wanted.c1(), wanted.templates(), c1v2) {
                (true, true, Some(c1v2)) => ("c1v2", c1v2, br_c1v2),
                (true, _, _) => ("c1", c1, br_c1),
                _ => ("json", body.into_bytes(), br_json),
            };
            let dcb = (format == "c1v2" && dcb_ready && dcb_dict.as_deref() == Some(dictionary.id().as_str()))
                .then_some(dcb_c1v2)
                .flatten();
            // dcb when the browser holds our dictionary, else a brotli-11 copy
            // served as-is (Cloudflare passes origin encodings through; its own
            // on-the-fly level is far lower).
            let (bytes, coding) = match (dcb, compressed) {
                (Some(dcb), _) => (dcb, Some("dcb")),
                (None, Some(br)) if brotli => (br, Some("br")),
                _ => (plain, None),
            };
            let tag = format!("\"{version}-{format}{}\"", coding.map(|c| format!("-{c}")).unwrap_or_default());
            // application/json, not the c1 media type: Cloudflare only
            // brotli-compresses known types. The payload marks itself c1.
            let cache = if coding == Some("dcb") { LIST_CACHE_DCB } else { LIST_CACHE };
            let mut response = crate::suggest::cors(StatusCode::OK, Some(cache.to_owned()), Some("application/json; charset=utf-8"), bytes).into_response();
            let h = response.headers_mut();
            h.insert(axum::http::header::VARY, HeaderValue::from_static("Accept, Accept-Encoding, Available-Dictionary"));
            if format != "json" {
                h.insert("x-pokoin-format", HeaderValue::from_static(if format == "c1v2" { "c1v2" } else { "c1" }));
            }
            if let Some(coding) = coding {
                h.insert(axum::http::header::CONTENT_ENCODING, HeaderValue::from_static(coding));
            }
            // Where a c1v2 client fetches the shared dictionary (once).
            if wanted.templates() && has_v2 {
                if let Ok(v) = HeaderValue::from_str(&dictionary.id()) {
                    h.insert("x-pokoin-dictionary", v);
                }
                h.insert(
                    axum::http::header::ACCESS_CONTROL_EXPOSE_HEADERS,
                    HeaderValue::from_static("x-pokoin-dictionary, x-pokoin-format"),
                );
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

fn accepts_coding(headers: &HeaderMap, wanted: &str) -> bool {
    headers
        .get_all(axum::http::header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|entry| {
            let mut parts = entry.split(';');
            let coding = parts.next().unwrap_or("").trim();
            coding.eq_ignore_ascii_case(wanted)
                && !parts.any(|param| param.trim().replace(' ', "") == "q=0")
        })
}

/// `GET /api/c1-dictionary`: the raw RFC 9842 dictionary for c1v2
/// list snapshots. `Use-As-Dictionary` makes the browser keep it and offer it
/// (`Available-Dictionary`) on later `/api/marketplace-list` requests.
pub async fn dictionary() -> Response {
    let dictionary = &*DICTIONARY;
    let mut response = crate::suggest::cors(
        StatusCode::OK,
        Some(DICTIONARY_CACHE.to_owned()),
        Some("application/octet-stream"),
        dictionary.raw().to_vec(),
    )
    .into_response();
    let h = response.headers_mut();
    let rule = format!("match=\"/api/marketplace-list?*\", id=\"{}\"", dictionary.id());
    if let Ok(v) = HeaderValue::from_str(&rule) {
        h.insert("use-as-dictionary", v);
    }
    if let Ok(v) = HeaderValue::from_str(&format!("\"{}\"", dictionary.id())) {
        h.insert(axum::http::header::ETAG, v);
    }
    response
}

/// Brotli quality 11, 4 MiB window: the snapshot is built once and served
/// many times, so the slowest, smallest setting pays off.
fn brotli11(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() / 4 + 64);
    let params = brotli::enc::BrotliEncoderParams { quality: 11, lgwin: 22, ..Default::default() };
    if brotli::BrotliCompress(&mut &bytes[..], &mut out, &params).is_err() {
        out.clear();
    }
    out
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
    /// Compute, but store nothing (timing a build against a read-only database).
    dry_run: bool,
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
        } else if arg == "--dry-run" {
            o.dry_run = true;
        }
    }
    if o.kinds.is_empty() {
        o.kinds = vec!["median".into(), "set".into(), "artist".into(), "name".into(), "version".into(), "related".into()];
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

/// `pokoin-api job build-lists [--kind=median,set,artist,name,version,related,related-delta] [--game=pokemon,magic] [--key=slug] [--dry-run]`
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
        if !o.dry_run {
            sqlx::raw_sql(DDL).execute(&pool).await?;
            sqlx::raw_sql(page_snapshot::DDL).execute(&pool).await?;
        }
        if o.kinds.iter().any(|k| k == "median") && game == "pokemon" {
            let n = build_medians(&pool).await?;
            tracing::info!(%game, medians = n, "build-lists medians");
        }
        if o.kinds.iter().any(|k| k == "set") {
            // Stored set positions first (card desk arrows, set lists).
            match sqlx::query_scalar::<_, i32>("select public.marketplace_refresh_set_order()").fetch_one(&pool).await {
                Ok(moved) => tracing::info!(%game, moved, "build-lists set_order"),
                Err(error) => tracing::warn!(%game, %error, "build-lists set_order refresh failed"),
            }
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
        if o.kinds.iter().any(|k| k == "version") && game == "pokemon" {
            let n = build_versions(app, &pool, game, o.key.as_deref()).await?;
            tracing::info!(%game, versions = n, "build-lists versions");
        }
        for (kind, delta) in [("related", false), ("related-delta", true)] {
            if o.kinds.iter().any(|k| k == kind) && game == "pokemon" {
                let started = std::time::Instant::now();
                let (cards, written) = build_related(&pool, delta, o.dry_run).await?;
                tracing::info!(%game, cards, written, delta, dry_run = o.dry_run, seconds = started.elapsed().as_secs_f64(), "build-lists related");
            }
        }
    }
    Ok(())
}

async fn build_sets(app: &Router, pool: &PgPool, game: &str, only: Option<&str>) -> anyhow::Result<usize> {
    let slugs: Vec<String> = match only {
        Some(k) => vec![k.to_owned()],
        None => {
            let index = get(app, game, "/api/marketplace-expansion-page?limit=2000").await?;
            let expansions = index.get("expansions").and_then(Value::as_array).cloned().unwrap_or_default();
            // The set index itself: `?limit=n` is the first n of these rows.
            if !expansions.is_empty() {
                let page = Page { key: "all".into(), head: json!({ "game": game }), rows: expansions.iter().map(page_snapshot::text).collect(), c1: None };
                store_pages(pool, page_snapshot::SET_INDEX, &[page]).await?;
            }
            expansions.iter().filter_map(|r| r.get("slug").and_then(Value::as_str)).filter_map(|s| clean_key(Some(s))).collect()
        }
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
            // The page snapshot keeps the route's own rows: no median fill, no
            // key sort, so `/api/marketplace-expansion-page` stays byte-identical.
            let page = body.get("expansion").filter(|e| e.is_object()).map(|expansion| Page {
                key: slug.clone(),
                head: json!({ "expansion": expansion, "total": body.get("total").cloned().unwrap_or(json!(0)) }),
                rows: cards.iter().map(page_snapshot::text).collect(),
                c1: None,
            });
            let total = cards.len();
            body["cards"] = Value::Array(cards);
            body["offset"] = json!(0);
            body["count"] = json!(total);
            body["total"] = json!(total);
            body["hasMore"] = json!(false);
            anyhow::Ok((slug, body, page))
        }
    }).collect();
    store_all(pool, "set", game, jobs, 4, None).await
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
            anyhow::Ok((slug, body, None))
        }
    }).collect();
    store_all(pool, "artist", game, jobs, 2, Some(artist_page)).await
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
            anyhow::Ok((name_key(&name), json!({ "name": name.trim(), "cards": cards }), None))
        }
    }).collect();
    store_all(pool, "name", game, jobs, 6, None).await
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
///
/// A job may bring its own page snapshot (set desks); `page_of` derives one
/// from the stored list body instead (artist desks serve exactly that body).
async fn store_all<F>(pool: &PgPool, kind: &str, game: &str, jobs: Vec<F>, width: usize, page_of: Option<fn(&str, &Value) -> Option<Page>>) -> anyhow::Result<usize>
where
    F: std::future::Future<Output = anyhow::Result<(String, Value, Option<Page>)>> + Send + 'static,
{
    let mut pages: Vec<Page> = Vec::new();
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
            Ok(Ok((key, mut body, page))) => {
                if game == "pokemon" {
                    fill_medians(pool, &mut body).await;
                }
                pages.extend(page.or_else(|| page_of.and_then(|f| f(&key, &canonical_rows(&body)))));
                if pages.len() >= 100 {
                    if let Err(error) = store_pages(pool, kind, &std::mem::take(&mut pages)).await {
                        tracing::error!(%kind, %error, "build-lists page store failed");
                    }
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
    if let Err(error) = store_pages(pool, kind, &pages).await {
        tracing::error!(%kind, %error, "build-lists page store failed");
    }
    Ok(stored)
}

/// One `marketplace_page_snapshots` row to store.
#[derive(Debug, Clone)]
pub(crate) struct Page {
    pub key: String,
    pub head: Value,
    pub rows: Vec<String>,
    pub c1: Option<Vec<u8>>,
}

impl Page {
    fn version(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(page_snapshot::text(&self.head).as_bytes());
        for row in &self.rows {
            hash.update(b"\n");
            hash.update(row.as_bytes());
        }
        hex::encode(&hash.finalize()[..8])
    }
}

/// The artist desk page: the stored list body (`/api/marketplace-list`), which
/// is what `/api/marketplace-artist-cards?tiles=1` has answered since #304.
fn artist_page(key: &str, body: &Value) -> Option<Page> {
    let cards = body.get("cards").and_then(Value::as_array).filter(|c| !c.is_empty())?;
    Some(Page {
        key: key.to_owned(),
        head: json!({ "artist": body.get("artist").cloned().unwrap_or(Value::Null), "profile": body.get("profile").cloned().unwrap_or(Value::Null) }),
        rows: cards.iter().map(page_snapshot::text).collect(),
        c1: None,
    })
}

/// Store page snapshots in batches. An unchanged page (same content hash) only
/// has `checked_at` touched, so a rebuild writes almost no WAL for the replica.
/// Returns how many pages were rewritten.
pub(crate) async fn store_pages(pool: &PgPool, kind: &str, pages: &[Page]) -> anyhow::Result<usize> {
    // One statement cannot upsert a key twice (two spellings of one artist slug).
    let mut last: std::collections::HashMap<&str, &Page> = std::collections::HashMap::new();
    for page in pages {
        last.insert(page.key.as_str(), page);
    }
    let pages: Vec<&Page> = last.into_values().collect();
    let mut written = 0;
    for chunk in pages.chunks(200) {
        let keys: Vec<&str> = chunk.iter().map(|p| p.key.as_str()).collect();
        let versions: Vec<String> = chunk.iter().map(|p| p.version()).collect();
        let fresh: std::collections::HashSet<String> = sqlx::query_scalar::<_, String>(
            "update public.marketplace_page_snapshots s set checked_at = now()
             from unnest($2::text[], $3::text[]) as u(key, version)
             where s.kind = $1 and s.key = u.key and s.version = u.version
             returning s.key",
        )
        .bind(kind)
        .bind(&keys)
        .bind(&versions)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();
        let todo: Vec<(&Page, &String)> = chunk.iter().copied().zip(&versions).filter(|(p, _)| !fresh.contains(&p.key)).collect();
        if todo.is_empty() {
            continue;
        }
        let keys: Vec<&str> = todo.iter().map(|(p, _)| p.key.as_str()).collect();
        let heads: Vec<String> = todo.iter().map(|(p, _)| page_snapshot::text(&p.head)).collect();
        // Each row travels as a JSON string, so Postgres stores its exact bytes.
        let rows: Vec<String> = todo.iter().map(|(p, _)| serde_json::to_string(&p.rows).unwrap_or_else(|_| "[]".into())).collect();
        let c1: Vec<Option<&[u8]>> = todo.iter().map(|(p, _)| p.c1.as_deref()).collect();
        let versions: Vec<&str> = todo.iter().map(|(_, v)| v.as_str()).collect();
        sqlx::query(
            "insert into public.marketplace_page_snapshots (kind, key, head, rows, c1, version, built_at, checked_at)
             select $1, u.key, u.head,
               array(select e from jsonb_array_elements_text(u.rows::jsonb) with ordinality as t(e, ord) order by ord),
               u.c1, u.version, now(), now()
             from unnest($2::text[], $3::text[], $4::text[], $5::bytea[], $6::text[]) as u(key, head, rows, c1, version)
             on conflict (kind, key) do update set head = excluded.head, rows = excluded.rows, c1 = excluded.c1,
               version = excluded.version, built_at = now(), checked_at = now()",
        )
        .bind(kind)
        .bind(&keys)
        .bind(&heads)
        .bind(&rows)
        .bind(&c1)
        .bind(&versions)
        .execute(pool)
        .await?;
        written += todo.len();
    }
    Ok(written)
}

/// Snapshots of a kind the builder has not confirmed for a week are gone from
/// the catalogue (a renamed set, a merged version set).
async fn prune_pages(pool: &PgPool, kind: &str) {
    let _ = sqlx::query("delete from public.marketplace_page_snapshots where kind = $1 and checked_at < now() - interval '7 days'")
        .bind(kind)
        .execute(pool)
        .await;
}

/// One page per CLIP version set: the printings `/api/marketplace-version-set`
/// answers for any member card.
async fn build_versions(app: &Router, pool: &PgPool, game: &str, only: Option<&str>) -> anyhow::Result<usize> {
    let members: Vec<(String, i64)> = sqlx::query_as(
        "select c.version, min(c.card_id)
         from public.marketplace_search_candidates c
         join public.pokoin_version_sets s on s.version = c.version
         where c.item_kind = 'single' and c.product_type = 'card' and ($1::text is null or lower(c.version) = $1)
         group by c.version",
    )
    .bind(only)
    .fetch_all(pool)
    .await?;
    let gate = Arc::new(Semaphore::new(6));
    let mut set = JoinSet::new();
    for (version, card_id) in members {
        let (app, game, gate) = (app.clone(), game.to_owned(), gate.clone());
        set.spawn(async move {
            let _permit = gate.acquire_owned().await?;
            let body = get(&app, &game, &format!("/api/marketplace-version-set?cardId={card_id}")).await?;
            let printings = body.get("printings").and_then(Value::as_array).cloned().unwrap_or_default();
            anyhow::ensure!(body.get("version").and_then(Value::as_str) == Some(version.as_str()), "version set {version} answered another key");
            anyhow::Ok(Page {
                key: version,
                head: json!({ "version": body["version"], "versionCount": body["versionCount"] }),
                rows: printings.iter().map(page_snapshot::text).collect(),
                c1: None,
            })
        });
    }
    let mut pages = Vec::new();
    let mut stored = 0;
    while let Some(done) = set.join_next().await {
        match done {
            Ok(Ok(page)) => pages.push(page),
            Ok(Err(error)) => tracing::warn!(%game, error = %format!("{error:#}"), "build-lists skipped a version set"),
            Err(error) => tracing::error!(%error, "build-lists version task failed"),
        }
        if pages.len() >= 200 {
            store_pages(pool, page_snapshot::VERSION, &std::mem::take(&mut pages)).await?;
            stored += 200;
        }
    }
    stored += pages.len();
    store_pages(pool, page_snapshot::VERSION, &pages).await?;
    if only.is_none() {
        prune_pages(pool, page_snapshot::VERSION).await;
    }
    Ok(stored)
}

/// The related-cards index (see `related.rs`). Returns (cards scored, pages
/// rewritten). A delta build scores everything too (it is seconds of CPU) but
/// builds tile rows and writes only for the cards a change can have touched.
async fn build_related(pool: &PgPool, delta: bool, dry_run: bool) -> anyhow::Result<(usize, usize)> {
    let cards = related::load_cards(pool).await?;
    let lists = related::neighbours(&cards);
    let targets: Vec<usize> = if delta {
        let since: Option<String> = sqlx::query_scalar(
            "select (max(checked_at) - interval '10 minutes')::text from public.marketplace_page_snapshots where kind = $1",
        )
        .bind(page_snapshot::RELATED)
        .fetch_one(pool)
        .await?;
        let Some(since) = since else {
            anyhow::bail!("related-delta needs a full build first (run --kind=related)");
        };
        let stored: std::collections::HashSet<i64> = sqlx::query_scalar::<_, String>(
            "select key from public.marketplace_page_snapshots where kind = $1",
        )
        .bind(page_snapshot::RELATED)
        .fetch_all(pool)
        .await?
        .into_iter()
        .filter_map(|k| k.parse().ok())
        .collect();
        let changed = related::changed_since(pool, &since).await?;
        related::affected(&cards, &lists, &changed, &stored)
    } else {
        (0..cards.len()).collect()
    };
    let language: std::collections::HashMap<i64, &str> = cards.iter().map(|c| (c.id, c.language.as_str())).collect();
    let mut written = 0;
    for chunk in targets.chunks(2_000) {
        let mut needed: Vec<i64> = chunk.iter().flat_map(|&i| lists[i].iter().map(|&j| cards[j as usize].id)).collect();
        needed.sort_unstable();
        needed.dedup();
        let tiles = related::tile_rows(pool, &needed, &language).await?;
        let pages: Vec<Page> = chunk
            .iter()
            .map(|&i| {
                let key = cards[i].id.to_string();
                let rows: Vec<String> = lists[i].iter().filter_map(|&j| tiles.get(&cards[j as usize].id).cloned()).collect();
                let c1 = related::related_c1(&key, &rows);
                Page { key, head: json!({}), rows, c1: Some(c1) }
            })
            .collect();
        if !dry_run {
            written += store_pages(pool, page_snapshot::RELATED, &pages).await?;
        }
    }
    if !delta && !dry_run {
        prune_pages(pool, page_snapshot::RELATED).await;
    }
    Ok((cards.len(), written))
}

fn tile_price_missing(card: &Value) -> bool {
    !["price", "lowest_price_pkn"].iter().any(|k| card.get(*k).and_then(Value::as_f64).is_some_and(|n| n > 0.0))
}

/// `applyLastMedianPrices`: cards without a tile price show the daily median.
pub(crate) async fn fill_medians(pool: &PgPool, body: &mut Value) {
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
pub(crate) fn canonical_rows(body: &Value) -> Value {
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
    let version = hex::encode(&Sha256::digest(text.as_bytes())[..8]);
    // Unchanged and already carrying every representation: nothing to redo
    // (brotli 11 is the expensive part of a build).
    let current: Option<(String, bool)> = sqlx::query_as(
        "select version, c1v2 is not null and br_c1v2 is not null and br_c1 is not null and br_json is not null
                and dcb_c1v2 is not null and dcb_dict is not distinct from $3
         from public.marketplace_list_snapshots where kind = $1 and key = $2",
    )
    .bind(kind)
    .bind(key)
    .bind(DICTIONARY.id())
    .fetch_optional(pool)
    .await?;
    if current.as_ref().is_some_and(|(v, complete)| *v == version && *complete) {
        return Ok(());
    }
    let c1 = compact::encode::encode_to_vec(body);
    let c1v2 = compact::encode::encode_to_vec_with(body, compact::encode::EncodeOptions { templates: true });
    let (br_json, br_c1, br_c1v2) = (brotli11(text.as_bytes()), brotli11(&c1), brotli11(&c1v2));
    let dictionary = &*DICTIONARY;
    let dcb_c1v2 = dictionary.compress(&c1v2, 11);
    let dcb_dict = dcb_c1v2.as_ref().map(|_| dictionary.id());
    let count = body.get("cards").and_then(Value::as_array).map_or(0, Vec::len) as i32;
    sqlx::query(
        "insert into public.marketplace_list_snapshots
           (kind, key, body, c1, c1v2, br_json, br_c1, br_c1v2, dcb_c1v2, dcb_dict, card_count, version, built_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
         on conflict (kind, key) do update set body = excluded.body, c1 = excluded.c1,
           c1v2 = excluded.c1v2, br_json = excluded.br_json, br_c1 = excluded.br_c1,
           br_c1v2 = excluded.br_c1v2, dcb_c1v2 = excluded.dcb_c1v2, dcb_dict = excluded.dcb_dict,
           card_count = excluded.card_count, version = excluded.version, built_at = now()",
    )
    .bind(kind)
    .bind(key)
    .bind(text)
    .bind(c1)
    .bind(c1v2)
    .bind(nonempty(br_json))
    .bind(nonempty(br_c1))
    .bind(nonempty(br_c1v2))
    .bind(dcb_c1v2)
    .bind(dcb_dict)
    .bind(count)
    .bind(version)
    .execute(pool)
    .await?;
    Ok(())
}

fn nonempty(bytes: Vec<u8>) -> Option<Vec<u8>> {
    (!bytes.is_empty()).then_some(bytes)
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
        assert_eq!(o.kinds, vec!["median", "set", "artist", "name", "version", "related"]);
        assert!(!o.dry_run && options(&["--dry-run".into()]).dry_run);
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

#[cfg(test)]
mod dcb_tests {
    use super::*;

    #[test]
    fn the_shipped_dictionary_round_trips_a_c1v2_snapshot() {
        let body = serde_json::json!({
            "cards": (0..40).map(|i| serde_json::json!({
                "id": 600_000 + i,
                "name": format!("Pikachu {i}"),
                "canonicalPath": format!("/marketplace/en/cards/{}/card-pikachu-{i}-{i}-151", 600_000 + i),
            })).collect::<Vec<_>>()
        });
        let c1v2 = compact::encode::encode_to_vec_with(&body, compact::encode::EncodeOptions { templates: true });
        let dcb = DICTIONARY.compress(&c1v2, 11).expect("dcb");
        assert_eq!(DICTIONARY.decompress(&dcb).expect("decode"), c1v2);
        assert!(dcb.len() < brotli11(&c1v2).len() + 36);
        assert_eq!(DICTIONARY.id(), "d30efab9dda40a4b");
    }
}
