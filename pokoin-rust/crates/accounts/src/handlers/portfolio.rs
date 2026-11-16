//! Portfolio routes.
//!
//! * `marketplace-portfolio-history` — the stored daily collection-value series.
//!   Card values come from CardTrader sold medians only, so the pricing rules
//!   live in [`crate::domain::portfolio_history`]. A stored series that is on
//!   the current basis answers the request at once and is recomputed behind it.

use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard, OnceLock};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Map, Value as Json};

use crate::domain::portfolio_catalog::{
    catalog_select_sql, is_undefined_table, listing_join_sql, react_image_urls, urls_join_sql,
};
use crate::domain::portfolio_history::{
    add_utc_days, build_daily_series, clean_days, frozen_card_days, holding_slices,
    sold_price_book, stored_is_current, stored_is_fresh, top_movers, utc_day_key_ms, wallet_series,
    Mover, CARDS_BY_BLUEPRINT_SQL, HISTORY_DAYS, HOLDINGS_SQL, PRICE_BASIS, SERIES_REVISION,
    SOLD_BY_BLUEPRINT_SQL,
};
use crate::error::{ApiError, Result};
use crate::firestore::{Direction, DocData, Firestore, Query as FirestoreQuery, Value};
use crate::sql::{row_text, MarketplaceDb, SqlParam};
use crate::state::DomainState;

use super::{apply_cors, json_with_cors, method_not_allowed, require_claims};

const HISTORY: &str = "portfolio_history";
const LEDGER: &str = "ledger_entries";
const BALANCES: &str = "balances";
const LEDGER_PAGE: i64 = 200;

/// The stored series read, or `None` when there is nothing saved yet.
async fn read_stored(firestore: &Firestore, uid: &str) -> Result<Option<Json>> {
    Ok(firestore
        .doc(format!("{HISTORY}/{uid}"))
        .get()
        .await?
        .map(|document| document.to_plain_json()))
}

/// `readLedger(firestore, uid)` — newest first, best effort on the ordering.
async fn read_ledger(firestore: &Firestore, uid: &str) -> Vec<Json> {
    let ordered = FirestoreQuery::collection(LEDGER)
        .where_eq("uid", uid.to_string())
        .order_by("createdAt", Direction::Descending)
        .limit(LEDGER_PAGE);
    let documents = match firestore.run_query(&ordered).await {
        Ok(documents) => documents,
        // Node retried without the ordering when the index was missing.
        Err(_) => firestore
            .run_query(
                &FirestoreQuery::collection(LEDGER)
                    .where_eq("uid", uid.to_string())
                    .limit(LEDGER_PAGE),
            )
            .await
            .unwrap_or_default(),
    };
    documents
        .iter()
        .map(|document| document.to_plain_json())
        .collect()
}

/// `readBalance(firestore, uid)`.
async fn read_balance(firestore: &Firestore, uid: &str) -> f64 {
    firestore
        .doc(format!("{BALANCES}/{uid}"))
        .get()
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get_i64("availablePkn"))
        .unwrap_or(0)
        .max(0) as f64
}

/// The held slices and their sold price book, or `None` when the market read
/// model is unavailable (the caller then serves the last good series).
async fn read_card_book(
    db: &MarketplaceDb,
    uid: &str,
) -> Option<(
    Vec<crate::domain::portfolio_history::Holding>,
    std::collections::HashMap<String, Vec<crate::domain::portfolio_history::PricePoint>>,
)> {
    let held = match db
        .query_json(HOLDINGS_SQL, &[SqlParam::Text(uid.to_string())])
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "portfolio card book failed");
            return None;
        }
    };
    let mut ids: Vec<i64> = Vec::new();
    for row in &held {
        let id = row_text(row, "blueprint_id");
        if id.bytes().all(|byte| byte.is_ascii_digit()) && !id.is_empty() {
            if let Ok(value) = id.parse::<i64>() {
                if !ids.contains(&value) {
                    ids.push(value);
                }
            }
        }
    }
    let sold = if ids.is_empty() {
        Vec::new()
    } else {
        match db
            .query_json(SOLD_BY_BLUEPRINT_SQL, &[SqlParam::IntArray(ids)])
            .await
        {
            Ok(rows) => rows,
            Err(error) => {
                tracing::error!(%error, "portfolio sold book failed");
                return None;
            }
        }
    };
    Some((holding_slices(&held), sold_price_book(&sold)))
}

/// `GET /api/marketplace-portfolio-history`.
pub async fn marketplace_portfolio_history(
    State(state): State<DomainState>,
    method: axum::http::Method,
    headers: HeaderMap,
) -> Response {
    if method != axum::http::Method::GET {
        let mut response = method_not_allowed("GET");
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-store"),
        );
        return response;
    }
    match portfolio_history_inner(&state, &headers).await {
        Ok(response) => response,
        Err(error) => history_error(error),
    }
}

async fn portfolio_history_inner(state: &DomainState, headers: &HeaderMap) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let uid = claims.uid.clone();
    let firestore = state.firestore()?;
    let now_ms = state.clock().now().timestamp_millis();

    let stored = read_stored(&firestore, &uid).await?;
    match history_plan(stored.as_ref(), now_ms) {
        Plan::ServeFresh => Ok(history_body(stored_days(stored.as_ref()))),
        Plan::ServeStaleAndRefresh => {
            let days = stored_days(stored.as_ref());
            spawn_history_refresh(state, &uid, stored);
            Ok(history_body(days))
        }
        Plan::ComputeNow => {
            // A missing or failing read model is not fatal: the last good
            // series is served instead, exactly like the Node `readCardBook`
            // catch.
            let days = recompute_series(state, &uid, stored.as_ref())
                .await?
                .unwrap_or_else(|| last_good_series(stored.as_ref()));
            Ok(history_body(days))
        }
    }
}

/// What a history request does with the series it just read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Plan {
    /// Answer with the stored days: recomputed less than `FRESH_MS` ago.
    ServeFresh,
    /// Answer with the stored days at once and recompute behind the response.
    ServeStaleAndRefresh,
    /// Nothing to answer with: recompute and wait for it.
    ComputeNow,
}

/// Past days are frozen and sold prices arrive once a day, so a stored series
/// on the current basis is good enough to show immediately even when the last
/// recompute is hours old. Waiting for one made every visit pay for it.
fn history_plan(stored: Option<&Json>, now_ms: i64) -> Plan {
    if stored_is_fresh(stored, now_ms) {
        return Plan::ServeFresh;
    }
    if stored_is_current(stored) && !stored_days(stored).is_empty() {
        return Plan::ServeStaleAndRefresh;
    }
    Plan::ComputeNow
}

/// The days of a stored series, in the shape the client reads.
fn stored_days(stored: Option<&Json>) -> Vec<Json> {
    clean_days(stored.and_then(|doc| doc.get("days")))
}

/// The series to answer with when nothing could be recomputed: the stored days
/// while they are on the current basis, none before there is such a thing.
fn last_good_series(stored: Option<&Json>) -> Vec<Json> {
    if stored_is_current(stored) {
        stored_days(stored)
    } else {
        Vec::new()
    }
}

fn history_body(days: Vec<Json>) -> Response {
    ok_no_store(json!({ "ok": true, "days": days }))
}

/// The recompute and its stored write: card book, ledger, balance, series.
/// `None` when the market read model is unavailable, which writes nothing so
/// the stored series survives.
async fn recompute_series(
    state: &DomainState,
    uid: &str,
    stored: Option<&Json>,
) -> Result<Option<Vec<Json>>> {
    let now_ms = state.clock().now().timestamp_millis();
    let today_key = utc_day_key_ms(now_ms);
    let firestore = state.firestore()?;

    let card_book = match state.marketplace_db() {
        Ok(db) => read_card_book(&db, uid).await,
        Err(error) => {
            tracing::debug!(%error, "portfolio read model is not configured");
            None
        }
    };
    let Some((holdings, book)) = card_book else {
        return Ok(None);
    };

    let movements = read_ledger(&firestore, uid).await;
    let balance = read_balance(&firestore, uid).await;
    let wallet = wallet_series(&movements, balance, &today_key);
    let frozen = frozen_card_days(stored, &today_key);
    let days = build_daily_series(&wallet, &holdings, &book, &frozen, &today_key);

    firestore
        .doc(format!("{HISTORY}/{uid}"))
        .set(
            DocData::new()
                .set(
                    "days",
                    Value::Array(days.iter().map(Value::from_plain_json).collect()),
                )
                .string("priceBasis", PRICE_BASIS)
                .int("seriesRevision", SERIES_REVISION)
                .string("updatedAt", utc_iso(now_ms)),
            false,
        )
        .await?;

    Ok(Some(days))
}

/// Uids with a history refresh running in this process.
fn refresh_claims() -> &'static Mutex<HashSet<String>> {
    static CLAIMS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CLAIMS.get_or_init(Default::default)
}

/// One uid held in the in-flight set while its refresh runs. Releasing happens
/// in `Drop`, so an error return and a panic both free the uid.
struct RefreshClaim<'a>(&'a Mutex<HashSet<String>>, String);

impl Drop for RefreshClaim<'_> {
    fn drop(&mut self) {
        lock_claims(&self.0).remove(&self.1);
    }
}

/// The in-flight set. A holder that panics already released its uid in `Drop`,
/// so a poisoned lock is no reason to stop refreshing: take it anyway.
fn lock_claims(claims: &Mutex<HashSet<String>>) -> MutexGuard<'_, HashSet<String>> {
    claims
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The uid, when no refresh for it is already running.
fn claim_uid<'a>(claims: &'a Mutex<HashSet<String>>, uid: &str) -> Option<RefreshClaim<'a>> {
    if !lock_claims(claims).insert(uid.to_string()) {
        return None;
    }
    Some(RefreshClaim(claims, uid.to_string()))
}

/// Recompute behind the response, at most once per uid at a time. A request
/// that finds the uid already refreshing just serves its stored series.
fn spawn_history_refresh(state: &DomainState, uid: &str, stored: Option<Json>) {
    let Some(claim) = claim_uid(refresh_claims(), uid) else {
        return;
    };
    let state = state.clone();
    let uid = uid.to_string();
    tokio::spawn(async move {
        let outcome = recompute_series(&state, &uid, stored.as_ref()).await;
        drop(claim);
        if let Err(error) = outcome {
            tracing::warn!(%error, "portfolio history background refresh failed");
        }
    });
}

fn utc_iso(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// Every history response carries `Cache-Control: no-store`, including errors,
/// because the Node handler set it before doing any work.
fn ok_no_store(body: Json) -> Response {
    let mut response = json_with_cors(StatusCode::OK, body);
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

fn history_error(error: ApiError) -> Response {
    let status = error.status();
    if status.is_server_error() {
        tracing::error!(%error, "marketplace-portfolio-history failed");
    }
    let status = if status.is_client_error() || status.is_server_error() {
        status
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    let mut body = Map::new();
    body.insert(
        "error".into(),
        json!(if error.message().is_empty() {
            "Portfolio history failed."
        } else {
            error.message()
        }),
    );
    if let Some(code) = error.code() {
        body.insert("code".into(), json!(code));
    }
    let mut response = json_with_cors(status, Json::Object(body));
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

/// `Allow: GET`.
pub async fn portfolio_history_other() -> Response {
    let mut response = method_not_allowed("GET");
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

// ---------------------------------------------------------------------------
// marketplace-portfolio-movers
// ---------------------------------------------------------------------------

/// The chart opens on a month, so the movers window does too.
const MOVER_DEFAULT_DAYS: i64 = 30;
const MOVER_DEFAULT_LIMIT: usize = 6;
const MOVER_MAX_LIMIT: usize = 12;

/// `?days=30|90|180|max` — the window is counted back from today; `max` (or no
/// parameter) prices the whole stored history. The chart's own 1M/3M/6M day
/// counts are accepted, so a tile always moves over the window it sits under.
fn movers_window(raw: Option<&str>, today_key: &str) -> (Json, String) {
    let text = raw.unwrap_or("").trim();
    if text.eq_ignore_ascii_case("max") {
        return (json!("max"), String::new());
    }
    let days = text
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .unwrap_or(MOVER_DEFAULT_DAYS)
        .clamp(1, HISTORY_DAYS);
    (json!(days), add_utc_days(today_key, -days))
}

/// `?limit=6`, bounded so one request cannot ask for the whole collection.
fn movers_limit(raw: Option<&str>) -> usize {
    raw.and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(MOVER_DEFAULT_LIMIT)
        .min(MOVER_MAX_LIMIT)
}

/// Blueprint id → the catalog fields a tile needs. A failed join is logged and
/// answers with nothing, so the movers still carry their own numbers.
async fn read_mover_cards(
    db: &MarketplaceDb,
    ids: &[i64],
) -> std::collections::HashMap<String, Json> {
    let rows = match db
        .query_json(CARDS_BY_BLUEPRINT_SQL, &[SqlParam::IntArray(ids.to_vec())])
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "portfolio mover cards failed");
            return Default::default();
        }
    };
    rows.iter()
        .filter_map(|row| {
            let blueprint_id = row_text(row, "blueprint_id");
            if blueprint_id.is_empty() {
                return None;
            }
            let images = react_image_urls(row);
            Some((
                blueprint_id,
                json!({
                    "cardId": row_text(row, "card_id"),
                    "name": row_text(row, "name"),
                    "setName": row_text(row, "expansion_name"),
                    "collectorNumber": row_text(row, "expansion_number"),
                    "imageUrl": images.get("imageUrl").and_then(Json::as_str).unwrap_or(""),
                }),
            ))
        })
        .collect()
}

/// A mover plus the card it is a picture of. A printing the catalog lost still
/// keeps its own numbers; the tile then shows no art rather than a wrong one.
fn mover_item(mover: &Mover, cards: &std::collections::HashMap<String, Json>) -> Json {
    let mut row = mover.to_json();
    if let Some(card) = cards.get(&mover.blueprint_id).and_then(Json::as_object) {
        if let Some(object) = row.as_object_mut() {
            for (key, value) in card {
                object.insert(key.clone(), value.clone());
            }
        }
    }
    if let Some(object) = row.as_object_mut() {
        for key in ["cardId", "name", "setName", "collectorNumber", "imageUrl"] {
            object
                .entry(key.to_string())
                .or_insert_with(|| Json::String(String::new()));
        }
    }
    row
}

/// `GET /api/marketplace-portfolio-movers`.
pub async fn marketplace_portfolio_movers(
    State(state): State<DomainState>,
    method: axum::http::Method,
    headers: HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if method != axum::http::Method::GET {
        return portfolio_history_other().await;
    }
    portfolio_movers_inner(&state, &headers, &query).await
}

async fn portfolio_movers_inner(
    state: &DomainState,
    headers: &HeaderMap,
    query: &std::collections::HashMap<String, String>,
) -> Response {
    let claims = match require_claims(state, headers).await {
        Ok(claims) => claims,
        Err(error) => return history_error(error),
    };
    let today_key = utc_day_key_ms(state.clock().now().timestamp_millis());
    let (days, from_day) = movers_window(query.get("days").map(String::as_str), &today_key);
    let limit = movers_limit(query.get("limit").map(String::as_str));
    // The same read model the history series uses; without it there is no
    // sold book to rank, which is an empty dashboard and not a failure.
    let no_movers = || {
        ok_no_store(json!({
            "ok": true, "days": days, "gainers": [], "losers": [],
        }))
    };
    let db = match state.marketplace_db() {
        Ok(db) => db,
        Err(error) => {
            tracing::debug!(%error, "portfolio movers read model is not configured");
            return no_movers();
        }
    };
    let Some((holdings, book)) = read_card_book(&db, &claims.uid).await else {
        return no_movers();
    };
    let movers = top_movers(&holdings, &book, &from_day, &today_key, limit);

    let mut ids: Vec<i64> = Vec::new();
    for mover in movers.gainers.iter().chain(movers.losers.iter()) {
        if let Ok(value) = mover.blueprint_id.parse::<i64>() {
            if !ids.contains(&value) {
                ids.push(value);
            }
        }
    }
    // The move is the substance; the picture is one join away.
    let cards = if ids.is_empty() {
        Default::default()
    } else {
        read_mover_cards(&db, &ids).await
    };

    ok_no_store(json!({
        "ok": true,
        "days": days,
        "gainers": movers.gainers.iter().map(|mover| mover_item(mover, &cards)).collect::<Vec<_>>(),
        "losers": movers.losers.iter().map(|mover| mover_item(mover, &cards)).collect::<Vec<_>>(),
    }))
}

// ---------------------------------------------------------------------------
// marketplace-portfolio (React Portfolio / Explore BFF)
// ---------------------------------------------------------------------------

const PORTFOLIO_SHORT_CACHE: &str = "public, max-age=15, s-maxage=30";
const PORTFOLIO_CACHE: &str = "public, max-age=15, s-maxage=30, stale-while-revalidate=60";

/// Per-game catalog pools. The Pokemon catalog is the configured default; every
/// other game resolves its own URL (explicit env, else derived from the base
/// URL's host) and uses the process-wide satellite pool (`pokoin_db` budget).
fn game_db(state: &DomainState, game: &str) -> Result<MarketplaceDb> {
    use crate::domain::marketplace_game::{database_url_for_game, env_pairs, is_pokemon_game};
    if is_pokemon_game(game) {
        return state.marketplace_db();
    }
    let url = database_url_for_game(game, &env_pairs());
    if url.is_empty() {
        return Err(ApiError::internal(
            "Marketplace database is not configured.",
        ));
    }
    let pool = pokoin_db::satellite_pool(&url).map_err(|error| {
        ApiError::internal(format!("Marketplace database pool failed: {error}"))
    })?;
    Ok(MarketplaceDb::from_pool(pool))
}

/// `relationExists(qualified)`.
async fn relation_exists(db: &MarketplaceDb, qualified: &str) -> Result<bool> {
    let rows = db
        .query_json(
            "select to_regclass($1)::text as rel",
            &[SqlParam::Text(qualified.to_string())],
        )
        .await?;
    Ok(rows
        .first()
        .map(|row| !row_text(row, "rel").is_empty())
        .unwrap_or(false))
}

/// `queryById({cardId, hasListings, hasCheap})`.
async fn query_by_id(
    db: &MarketplaceDb,
    card_id: i64,
    has_listings: bool,
    has_cheap: bool,
) -> Result<Vec<Json>> {
    let parts = catalog_select_sql(has_listings, has_cheap);
    let sql = format!(
        "select {} from public.marketplace_search_candidates c {}{}{} \
         where c.card_id = $1::bigint or c.ct_id = $1::bigint \
         order by case when c.card_id = $1::bigint then 0 else 1 end, c.card_id limit 1",
        parts.select,
        parts.listing_join,
        parts.cheap_join,
        urls_join_sql(),
    );
    db.query_json(&sql, &[SqlParam::Int(card_id)])
        .await
        .map_err(ApiError::from)
}

/// `queryPokemonPriced({limit, hasListings})`.
async fn query_pokemon_priced(
    db: &MarketplaceDb,
    limit: i64,
    has_listings: bool,
) -> Result<Vec<Json>> {
    let listing_join = if has_listings { listing_join_sql() } else { "" };
    let listing_floor = if has_listings {
        "listings.floor_pkn"
    } else {
        "null::float8"
    };
    let listing_total = if has_listings {
        "listings.total_pkn"
    } else {
        "null::float8"
    };
    let listing_qty = if has_listings {
        "listings.qty"
    } else {
        "null::int"
    };
    let listing_count = if has_listings {
        "coalesce(listings.listing_count, 0)"
    } else {
        "0"
    };
    let sealed = if has_listings {
        "coalesce(listings.sealed, c.item_kind = 'product')"
    } else {
        "c.item_kind = 'product'"
    };
    let card_name = if has_listings {
        "listings.card_name"
    } else {
        "null::text"
    };
    let collector = if has_listings {
        "listings.collector_number"
    } else {
        "null::text"
    };
    let condition = if has_listings {
        "listings.condition"
    } else {
        "null"
    };
    let language = if has_listings {
        "listings.language"
    } else {
        "null"
    };
    let sql = format!(
        "select card_id, ct_id, floor_pkn, \
                coalesce(listing_total, floor_pkn * qty)::float8 as total_pkn, \
                qty, listing_count, sealed, card_name, catalog_name, set_name, \
                expansion_name, card_number, collector_number, condition, language, \
                cdn_image_url, image_url, canonical_path \
           from ( \
             select distinct on (c.card_id) \
               c.card_id::text as card_id, c.ct_id, \
               coalesce({listing_floor}, cheap.cheapest_price_pkn, 0)::float8 as floor_pkn, \
               {listing_total} as listing_total, \
               coalesce({listing_qty}, cheap.eligible_quantity, 1)::int as qty, \
               ({listing_count})::int as listing_count, \
               ({sealed}) as sealed, \
               {card_name} as card_name, c.name as catalog_name, c.set_name, \
               c.expansion_name, c.card_number, \
               {collector} as collector_number, {condition} as condition, \
               {language} as language, c.cdn_image_url, c.image_url, urls.canonical_path \
             from public.cheapest_homepage_cache_blueprint cheap \
             join public.marketplace_search_candidates c \
               on c.card_id = cheap.pokoin_card_id::bigint \
             {listing_join} {urls} \
             where cheap.cheapest_price_pkn is not null \
               and cheap.cheapest_price_pkn > 0 \
               and coalesce(cheap.eligible_listing_count, 0) > 0 \
               and cheap.provider in ('pokoin_native', 'cardtrader') \
               and coalesce(c.cdn_image_url, c.image_url) is not null \
             order by c.card_id, \
               case when cheap.provider = 'pokoin_native' then 0 else 1 end, \
               cheap.cheapest_price_pkn asc \
           ) ranked \
          order by floor_pkn desc, qty desc, card_id limit $1",
        urls = urls_join_sql(),
    );
    db.query_json(&sql, &[SqlParam::Int(limit)])
        .await
        .map_err(ApiError::from)
}

/// `queryCatalogList({limit, hasListings, pokemon})`.
async fn query_catalog_list(
    db: &MarketplaceDb,
    limit: i64,
    has_listings: bool,
    pokemon: bool,
) -> Result<Vec<Json>> {
    let parts = catalog_select_sql(has_listings, false);
    let from_sql = if pokemon {
        "(select * from public.marketplace_search_candidates \
           where item_kind = 'single' and product_type = 'card' \
             and coalesce(cdn_image_url, image_url) is not null \
           order by search_weight desc, card_id desc limit $1) c"
            .to_string()
    } else {
        "public.marketplace_search_candidates c".to_string()
    };
    let sql = format!(
        "select {} from {} {} {} \
         where coalesce(c.cdn_image_url, c.image_url) is not null \
         order by floor_pkn desc, qty desc, c.card_id limit $1",
        parts.select,
        from_sql,
        parts.listing_join,
        urls_join_sql(),
    );
    db.query_json(&sql, &[SqlParam::Int(limit)])
        .await
        .map_err(ApiError::from)
}

/// `defaultLoadPortfolio({limit, cardId})`.
async fn load_portfolio(
    db: &MarketplaceDb,
    limit: i64,
    card_id: &str,
    game: &str,
) -> Result<Vec<Json>> {
    use crate::domain::marketplace_game::is_pokemon_game;
    let pokemon = is_pokemon_game(game);
    let mut has_listings = false;
    let mut has_cheap = false;
    match (
        relation_exists(db, "public.marketplace_user_listings").await,
        relation_exists(db, "public.cheapest_homepage_cache_blueprint").await,
    ) {
        (Ok(listings), Ok(cheap)) => {
            has_listings = listings;
            has_cheap = cheap;
        }
        (listings, cheap) => {
            // A missing relation is an empty catalog; anything else propagates.
            for error in [listings.err(), cheap.err()].into_iter().flatten() {
                if !is_undefined_table(&error) {
                    return Err(error);
                }
            }
        }
    }
    let id = if card_id.is_empty() {
        None
    } else {
        card_id.parse::<i64>().ok()
    };
    let first = match id {
        Some(id) => query_by_id(db, id, has_listings, has_cheap).await,
        None if pokemon && has_cheap => query_pokemon_priced(db, limit, has_listings).await,
        None => query_catalog_list(db, limit, has_listings, pokemon).await,
    };
    match first {
        Ok(rows) => Ok(rows),
        Err(error) if is_undefined_table(&error) => {
            // A gate table is missing entirely: fall back to a pure catalog read.
            let id = if card_id.is_empty() {
                None
            } else {
                card_id.parse::<i64>().ok()
            };
            match id {
                Some(id) => query_by_id(db, id, false, false).await,
                None => query_catalog_list(db, limit, false, false).await,
            }
        }
        Err(error) => Err(error),
    }
}

fn header_pairs(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect()
}

/// The portfolio CORS set: `GET, OPTIONS` plus a day-long preflight cache.
fn portfolio_cors(mut response: Response) -> Response {
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, OPTIONS"),
    );
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        axum::http::HeaderValue::from_static("Content-Type, Authorization"),
    );
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_MAX_AGE,
        axum::http::HeaderValue::from_static("86400"),
    );
    response
}

fn portfolio_ok(body: Json, cache: &'static str) -> Response {
    let mut response = portfolio_cors(json_with_cors(StatusCode::OK, body));
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static(cache),
    );
    response
}

/// `GET,OPTIONS /api/marketplace-portfolio`.
pub async fn marketplace_portfolio(
    State(state): State<DomainState>,
    method: axum::http::Method,
    headers: HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    use crate::domain::marketplace_game::{is_pokemon_game, parse_game_from_request};
    use crate::domain::portfolio_catalog::{
        empty_payload, game_label, limit_for_game, parse_public_card_id, payload_from_rows,
    };

    if method == axum::http::Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        apply_cors(response.headers_mut());
        return portfolio_cors(response);
    }
    if method != axum::http::Method::GET {
        let mut response = portfolio_cors(json_with_cors(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
        ));
        response.headers_mut().insert(
            axum::http::header::ALLOW,
            axum::http::HeaderValue::from_static("GET, OPTIONS"),
        );
        return response;
    }

    let pairs = header_pairs(&headers);
    let game = parse_game_from_request(
        &pairs,
        query.get("game").map(String::as_str),
        query.get("marketplaceGame").map(String::as_str),
    );
    let _ = is_pokemon_game(&game);
    let _ = game_label(&game);
    let id_json = query.get("id").map(|value| json!(value));
    let card_id_json = query.get("cardId").map(|value| json!(value));
    let card_id = {
        let from_id = parse_public_card_id(id_json.as_ref());
        if from_id.is_empty() {
            parse_public_card_id(card_id_json.as_ref())
        } else {
            from_id
        }
    };
    let limit_json = query.get("limit").map(|value| json!(value));
    let limit = limit_for_game(limit_json.as_ref(), &game);
    let generated = utc_iso(state.clock().now().timestamp_millis());

    let db = match game_db(&state, &game) {
        Ok(db) => db,
        Err(error) => return portfolio_failure(&state, error, &game, &generated),
    };
    match load_portfolio(&db, limit, &card_id, &game).await {
        Ok(rows) => {
            let payload = payload_from_rows(&rows, &game, &generated);
            let empty = payload
                .get("items")
                .and_then(Json::as_array)
                .map(Vec::is_empty)
                .unwrap_or(true);
            if empty && !card_id.is_empty() {
                let mut body = empty_payload(&game, &generated);
                body["id"] = json!(card_id);
                return portfolio_ok(body, PORTFOLIO_SHORT_CACHE);
            }
            portfolio_ok(payload, PORTFOLIO_CACHE)
        }
        Err(error) => portfolio_failure(&state, error, &game, &generated),
    }
}

/// A missing relation is an empty catalog, not a 500.
fn portfolio_failure(
    state: &DomainState,
    error: ApiError,
    game: &str,
    generated: &str,
) -> Response {
    use crate::domain::portfolio_catalog::{empty_payload, is_undefined_table};
    if is_undefined_table(&error) {
        return portfolio_ok(empty_payload(game, generated), PORTFOLIO_SHORT_CACHE);
    }
    let status = error.status();
    if status.is_server_error() {
        tracing::error!(%error, "marketplace-portfolio failed");
    }
    let _ = state;
    let status = if status.is_client_error() || status.is_server_error() {
        status
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    portfolio_cors(json_with_cors(
        status,
        json!({
            "error": if error.message().is_empty() { "Marketplace portfolio failed." } else { error.message() }
        }),
    ))
}

/// `Allow: GET, OPTIONS`.
pub async fn portfolio_other() -> Response {
    let mut response = portfolio_cors(json_with_cors(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({ "error": "Method not allowed." }),
    ));
    response.headers_mut().insert(
        axum::http::header::ALLOW,
        axum::http::HeaderValue::from_static("GET, OPTIONS"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::portfolio_history::PricePoint;

    #[test]
    fn utc_iso_renders_milliseconds() {
        assert_eq!(utc_iso(1_791_417_600_000), "2026-10-08T00:00:00.000Z");
        assert_eq!(utc_iso(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn error_bodies_only_carry_a_code_when_there_is_one() {
        let response = history_error(ApiError::internal("Firestore is not configured."));
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            response.headers().get(axum::http::header::CACHE_CONTROL),
            Some(&axum::http::HeaderValue::from_static("no-store"))
        );
        let response = history_error(ApiError::bad_request("nope").with_code("invalid_token"));
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn the_movers_window_counts_back_from_today() {
        // The chart presets arrive as their day counts.
        assert_eq!(
            movers_window(Some("91"), "2026-10-08"),
            (json!(91), "2026-07-09".to_string())
        );
        // No parameter and junk both mean the month the dashboard opens on.
        assert_eq!(
            movers_window(None, "2026-10-08"),
            (json!(30), "2026-09-08".to_string())
        );
        assert_eq!(
            movers_window(Some("0"), "2026-10-08"),
            (json!(30), "2026-09-08".to_string())
        );
        assert_eq!(
            movers_window(Some("two"), "2026-10-08"),
            (json!(30), "2026-09-08".to_string())
        );
        // A window longer than the stored series is clamped, never refused.
        assert_eq!(
            movers_window(Some("4000"), "2026-10-08"),
            (json!(HISTORY_DAYS), "2025-09-03".to_string())
        );
        // MAX asks for everything and prices from the first stored day.
        assert_eq!(
            movers_window(Some("MAX"), "2026-10-08"),
            (json!("max"), String::new())
        );
    }

    #[test]
    fn the_movers_limit_defaults_and_bounds() {
        assert_eq!(movers_limit(None), 6);
        assert_eq!(movers_limit(Some("3")), 3);
        assert_eq!(movers_limit(Some("0")), 6);
        assert_eq!(movers_limit(Some("60")), 12);
    }

    #[test]
    fn a_mover_item_keeps_its_numbers_when_the_catalog_lost_the_card() {
        let mover = Mover {
            key: "502874|NM|EN|-|-|-".to_string(),
            blueprint_id: "502874".to_string(),
            condition: "NM".to_string(),
            language: "EN".to_string(),
            reverse: false,
            first_edition: false,
            graded: false,
            quantity: 2,
            start_pkn: 1000.0,
            end_pkn: 1450.0,
            change_pkn: 450.0,
            change_pct: 45.0,
            series: vec![PricePoint {
                day: "2026-10-01".to_string(),
                pkn: 1450.0,
            }],
        };
        let cards = std::collections::HashMap::from([(
            "502874".to_string(),
            json!({ "cardId": "1234", "name": "Snorlax", "imageUrl": "https://cdn/x.jpg" }),
        )]);
        let joined = mover_item(&mover, &cards);
        assert_eq!(joined["cardId"], json!("1234"));
        assert_eq!(joined["name"], json!("Snorlax"));
        assert_eq!(joined["changePct"], json!(45));
        assert_eq!(joined["endPkn"], json!(1450));
        assert_eq!(joined["series"].as_array().map(Vec::len), Some(1));

        // A missing join still answers with the empty fields the tile expects.
        let alone = mover_item(&mover, &std::collections::HashMap::new());
        for key in ["cardId", "name", "setName", "collectorNumber", "imageUrl"] {
            assert_eq!(alone[key], json!(""), "{key}");
        }
    }

    /// Noon, so an offset of hours still lands on the same UTC day.
    const NOON: i64 = 1_791_460_800_000;

    fn stored(updated_at: &str, days: Json) -> Json {
        json!({
            "priceBasis": PRICE_BASIS,
            "seriesRevision": SERIES_REVISION,
            "updatedAt": updated_at,
            "days": days,
        })
    }

    fn one_day() -> Json {
        json!([{ "date": "2026-10-08", "currencyPkn": 100, "cardsValuePkn": 30, "cardsHeld": 2 }])
    }

    #[test]
    fn a_series_recomputed_minutes_ago_is_served_without_a_refresh() {
        let doc = stored("2026-10-08T11:59:00.000Z", one_day());
        assert_eq!(history_plan(Some(&doc), NOON), Plan::ServeFresh);
    }

    #[test]
    fn a_series_sixteen_minutes_old_answers_at_once_and_refreshes() {
        let doc = stored("2026-10-08T11:44:00.000Z", one_day());
        assert_eq!(history_plan(Some(&doc), NOON), Plan::ServeStaleAndRefresh);
    }

    #[test]
    fn yesterdays_series_answers_at_once_and_refreshes() {
        // Visits are hours apart, so this is the common case the graph pays for.
        let doc = stored("2026-10-07T18:00:00.000Z", one_day());
        assert_eq!(history_plan(Some(&doc), NOON), Plan::ServeStaleAndRefresh);
    }

    #[test]
    fn another_basis_or_revision_is_never_served_stale() {
        let mut doc = stored("2026-10-08T11:59:00.000Z", one_day());
        doc["priceBasis"] = json!("old-basis");
        assert_eq!(history_plan(Some(&doc), NOON), Plan::ComputeNow);

        let mut doc = stored("2026-10-08T11:59:00.000Z", one_day());
        doc["seriesRevision"] = json!(SERIES_REVISION - 1);
        assert_eq!(history_plan(Some(&doc), NOON), Plan::ComputeNow);
    }

    #[test]
    fn an_empty_or_missing_series_leaves_nothing_to_serve() {
        let doc = stored("2026-10-07T18:00:00.000Z", json!([]));
        assert_eq!(history_plan(Some(&doc), NOON), Plan::ComputeNow);
        // A day row without a date is dropped, which empties the series.
        let doc = stored("2026-10-07T18:00:00.000Z", json!([{ "currencyPkn": 100 }]));
        assert_eq!(history_plan(Some(&doc), NOON), Plan::ComputeNow);
        assert_eq!(history_plan(None, NOON), Plan::ComputeNow);
    }

    #[test]
    fn one_refresh_per_uid_runs_at_a_time() {
        let claims = Mutex::new(HashSet::new());
        let first = claim_uid(&claims, "u1").expect("the uid is free");
        assert!(
            claim_uid(&claims, "u1").is_none(),
            "a second refresh is refused"
        );
        assert!(
            claim_uid(&claims, "u2").is_some(),
            "another uid is independent"
        );
        drop(first);
        assert!(
            claim_uid(&claims, "u1").is_some(),
            "the uid is free once held ends"
        );
    }

    #[test]
    fn a_refresh_that_panics_still_releases_its_uid() {
        let claims = Mutex::new(HashSet::new());
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _claim = claim_uid(&claims, "u1").expect("the uid is free");
            panic!("the refresh blew up");
        }));
        assert!(panic.is_err());
        assert!(
            claim_uid(&claims, "u1").is_some(),
            "a panic must not strand the uid forever"
        );
    }
}
