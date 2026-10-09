//! Marketplace cart analytics, account cart sync, watchlist, recents and events.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use sqlx::Row;

use super::{empty_no_content, private_json};
use crate::domain::cart;
use crate::error::ApiError;
use crate::state::{AuthedUser, DomainState, OptionalUser};

// ---------------------------------------------------------------------------
// Game scoping
// ---------------------------------------------------------------------------

const GAME_ALIASES: &[(&str, &str)] = &[
    ("pokemon", "pokemon"),
    ("poke", "pokemon"),
    ("default", "pokemon"),
    ("one_piece", "one_piece"),
    ("onepiece", "one_piece"),
    ("op", "one_piece"),
    ("one-piece", "one_piece"),
    ("riftbound", "riftbound"),
    ("rb", "riftbound"),
    ("lol", "riftbound"),
    ("magic", "magic"),
    ("mtg", "magic"),
    ("yugioh", "yugioh"),
    ("ygo", "yugioh"),
    ("yu-gi-oh", "yugioh"),
    ("yu_gi_oh", "yugioh"),
    ("lorcana", "lorcana"),
    ("flesh_and_blood", "flesh_and_blood"),
    ("fab", "flesh_and_blood"),
    ("flesh-and-blood", "flesh_and_blood"),
    ("digimon", "digimon"),
    ("dragon_ball_super", "dragon_ball_super"),
    ("dbs", "dragon_ball_super"),
    ("dragon-ball-super", "dragon_ball_super"),
    ("vanguard", "vanguard"),
    ("star_wars", "star_wars"),
    ("swu", "star_wars"),
    ("star-wars", "star_wars"),
    ("union_arena", "union_arena"),
    ("union-arena", "union_arena"),
    ("gundam", "gundam"),
    ("sorcery", "sorcery"),
    ("palworld", "palworld"),
    ("cyberpunk", "cyberpunk"),
    ("weiss_schwarz", "weiss_schwarz"),
    ("weiss-schwarz", "weiss_schwarz"),
    ("final_fantasy", "final_fantasy"),
    ("final-fantasy", "final_fantasy"),
    ("force_of_will", "force_of_will"),
    ("force-of-will", "force_of_will"),
    ("world_of_warcraft", "world_of_warcraft"),
    ("world-of-warcraft", "world_of_warcraft"),
    ("battle_spirits_saga", "battle_spirits_saga"),
    ("battle-spirits-saga", "battle_spirits_saga"),
    ("star_wars_destiny", "star_wars_destiny"),
    ("star-wars-destiny", "star_wars_destiny"),
    ("dragon_born", "dragon_born"),
    ("dragon-born", "dragon_born"),
    ("my_little_pony", "my_little_pony"),
    ("my-little-pony", "my_little_pony"),
    ("the_spoils", "the_spoils"),
    ("the-spoils", "the_spoils"),
];

pub fn normalize_game(value: &str) -> Option<&'static str> {
    let compact = value.trim().to_ascii_lowercase();
    if compact.is_empty() {
        return None;
    }
    GAME_ALIASES
        .iter()
        .find(|(alias, _)| *alias == compact)
        .map(|(_, game)| *game)
}

fn header_text(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// `resolveRecentsGame`: an explicit game is required, never a silent default.
pub fn resolve_recents_game(
    headers: &HeaderMap,
    query_game: Option<&str>,
    body: Option<&Value>,
) -> Result<&'static str, ApiError> {
    let mut hints: Vec<String> = Vec::new();
    for name in ["x-pokoin-game", "x-marketplace-game"] {
        let value = header_text(headers, name);
        if !value.is_empty() {
            hints.push(value);
        }
    }
    if let Some(value) = query_game {
        if !value.trim().is_empty() {
            hints.push(value.to_string());
        }
    }
    if let Some(body) = body {
        for key in ["game", "marketplaceGame"] {
            if let Some(value) = body.get(key).and_then(Value::as_str) {
                if !value.trim().is_empty() {
                    hints.push(value.to_string());
                    break;
                }
            }
        }
    }
    if hints.is_empty() {
        // The host is the last hint the Node handler accepts (proxy header).
        let host = header_text(headers, "x-pokoin-host");
        let referer = header_text(headers, "referer");
        let origin = header_text(headers, "origin");
        for candidate in [host, referer, origin] {
            if candidate.is_empty() {
                continue;
            }
            let hostname = candidate
                .split("://")
                .last()
                .unwrap_or(&candidate)
                .split('/')
                .next()
                .unwrap_or_default()
                .split('.')
                .next()
                .unwrap_or_default()
                .to_string();
            if let Some(game) = normalize_game(&hostname) {
                hints.push(game.to_string());
                break;
            }
        }
    }
    let Some(hint) = hints.into_iter().next() else {
        return Err(invalid_game_error(""));
    };
    normalize_game(&hint).ok_or_else(|| invalid_game_error(&hint))
}

fn invalid_game_error(hint: &str) -> ApiError {
    ApiError::bad_request(format!(
        "Unknown marketplace game{}.",
        if hint.is_empty() {
            String::new()
        } else {
            format!(": {hint}")
        }
    ))
    .with_code("INVALID_GAME")
}

// ---------------------------------------------------------------------------
// Rate limiting (best effort: Redis window, bounded in-process fallback)
// ---------------------------------------------------------------------------

static LOCAL_WINDOWS: Mutex<Option<HashMap<String, (i64, i64)>>> = Mutex::new(None);

fn local_consume(bucket: &str, window_seconds: i64) -> i64 {
    let window_ms = window_seconds.max(1) * 1000;
    let window_start = chrono::Utc::now().timestamp_millis() / window_ms;
    let mut guard = LOCAL_WINDOWS.lock().expect("rate limit lock");
    let table = guard.get_or_insert_with(HashMap::new);
    if table.len() >= 10_000 {
        table.retain(|_, (start, _)| *start >= window_start);
        if table.len() >= 10_000 {
            if let Some(key) = table.keys().next().cloned() {
                table.remove(&key);
            }
        }
    }
    let entry = table.entry(bucket.to_string()).or_insert((window_start, 0));
    if entry.0 != window_start {
        *entry = (window_start, 0);
    }
    entry.1 += 1;
    entry.1
}

/// `limitBestEffort` — never rejects because the store is down.
pub async fn limit_best_effort(
    state: &DomainState,
    scope: &str,
    identity: &str,
    limit: i64,
    window_seconds: i64,
) -> (bool, i64) {
    let digest = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(identity.as_bytes());
        hex::encode(&hasher.finalize()[..16])
    };
    // `cleanScope`: lowercase, non [a-z0-9_-] collapsed to '-', max 40 chars.
    let scope: String = {
        let lowered = scope.trim().to_ascii_lowercase();
        let mut cleaned = String::with_capacity(lowered.len());
        let mut last_dash = false;
        for character in lowered.chars() {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                cleaned.push(character);
                last_dash = character == '-';
            } else if !last_dash {
                cleaned.push('-');
                last_dash = true;
            }
        }
        let trimmed = cleaned.trim_matches('-').chars().take(40).collect::<String>();
        if trimmed.is_empty() {
            "scope".to_string()
        } else {
            trimmed
        }
    };
    let bucket = format!("pokoin:rl:v1:{scope}:{digest}");
    if let Some(mut redis) = state.redis() {
        let script = redis::cmd("INCR")
            .arg(&bucket)
            .clone();
        if let Ok(count) = script.query_async::<i64>(&mut redis).await {
            if count == 1 {
                let _ = redis::cmd("EXPIRE")
                    .arg(&bucket)
                    .arg(window_seconds.max(1))
                    .query_async::<i64>(&mut redis)
                    .await;
            }
            return (count <= limit, count);
        }
    }
    let count = local_consume(&bucket, window_seconds);
    (count <= limit, count)
}

// ---------------------------------------------------------------------------
// Cart / watchlist analytics
// ---------------------------------------------------------------------------

fn clean_blueprint_id(value: Option<&Value>) -> Option<i64> {
    let number = crate::domain::js_number(value)?;
    if number.is_finite() && number.fract() == 0.0 && number > 0.0 && number <= 9_007_199_254_740_991.0 {
        Some(number as i64)
    } else {
        None
    }
}


pub async fn marketplace_cart(
    State(state): State<DomainState>,
    OptionalUser(claims): OptionalUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    use_analytics(
        &state,
        &body,
        claims.as_ref().map(|claims| claims.uid.as_str()),
        AnalyticsKind::Cart,
    )
    .await
}

pub async fn marketplace_watchlist(
    State(state): State<DomainState>,
    OptionalUser(claims): OptionalUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    use_analytics(
        &state,
        &body,
        claims.as_ref().map(|claims| claims.uid.as_str()),
        AnalyticsKind::Watchlist,
    )
    .await
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AnalyticsKind {
    Cart,
    Watchlist,
}

async fn use_analytics(
    state: &DomainState,
    body: &Value,
    user_uid: Option<&str>,
    kind: AnalyticsKind,
) -> Result<Response, ApiError> {
    let invalid_payload = match kind {
        AnalyticsKind::Cart => "Invalid cart analytics payload.",
        AnalyticsKind::Watchlist => "Invalid watchlist analytics payload.",
    };
    let blueprint_id = clean_blueprint_id(body.get("cardId").or_else(|| body.get("blueprintId")))
        .ok_or_else(|| ApiError::bad_request(invalid_payload))?;
    let (add_verbs, remove_verbs): (&[&str], &[&str]) = match kind {
        AnalyticsKind::Cart => (
            &["add", "added", "cart_add", "add_to_cart"],
            &["remove", "removed", "cart_remove", "remove_from_cart", "clear"],
        ),
        AnalyticsKind::Watchlist => (
            &["add", "added", "watch", "watchlist_add"],
            &["remove", "removed", "unwatch", "watchlist_remove"],
        ),
    };
    let action = body
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let action = if add_verbs.contains(&action.as_str()) {
        "add"
    } else if remove_verbs.contains(&action.as_str()) {
        "remove"
    } else {
        ""
    };
    if action.is_empty() {
        return Err(ApiError::bad_request(invalid_payload));
    }

    let holder_key = match kind {
        AnalyticsKind::Cart => {
            let anonymous = body
                .get("anonymousId")
                .or_else(|| body.get("sessionId"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .chars()
                .take(128)
                .collect::<String>();
            match user_uid.filter(|uid| !uid.trim().is_empty()) {
                Some(uid) => format!("uid:{}", uid.trim().chars().take(128).collect::<String>()),
                None if !anonymous.is_empty() => format!("anon:{anonymous}"),
                None => String::new(),
            }
        }
        AnalyticsKind::Watchlist => match user_uid.filter(|uid| !uid.trim().is_empty()) {
            Some(uid) => uid.trim().chars().take(128).collect(),
            None => String::new(),
        },
    };
    if holder_key.is_empty() {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    let result = match kind {
        AnalyticsKind::Cart => record_cart_change(state, blueprint_id, action, &holder_key).await,
        AnalyticsKind::Watchlist => {
            record_watchlist_change(state, blueprint_id, action, &holder_key).await
        }
    };
    match result {
        Ok(count) => {
            let user_scoped = holder_key.starts_with("uid:") || kind == AnalyticsKind::Watchlist;
            let payload = match kind {
                AnalyticsKind::Cart => json!({
                    "cardId": blueprint_id.to_string(),
                    "action": action,
                    "changed": true,
                    "cartHolderCount": count,
                    "userScoped": user_scoped,
                }),
                AnalyticsKind::Watchlist => json!({
                    "cardId": blueprint_id.to_string(),
                    "action": action,
                    "changed": true,
                    "watchlistCount": count,
                    "userScoped": user_scoped,
                }),
            };
            Ok(private_json(payload))
        }
        Err(error) => {
            tracing::warn!(%error, "marketplace analytics failed");
            // Node turns the failure into a 204 for non-validation errors.
            Ok(StatusCode::NO_CONTENT.into_response())
        }
    }
}

async fn record_cart_change(
    state: &DomainState,
    blueprint_id: i64,
    action: &str,
    holder_key: &str,
) -> Result<i64, sqlx::Error> {
    let row = if action == "add" {
        sqlx::query(
            r#"
            with membership as (
              insert into public.marketplace_card_cart_users
                (blueprint_id, holder_key, added_at, updated_at)
              values ($1, $2, now(), now())
              on conflict (blueprint_id, holder_key) do nothing
              returning 1
            ),
            aggregate as (
              insert into public.marketplace_card_cart_analytics
                (blueprint_id, cart_holder_count, first_added_at, last_added_at, updated_at)
              select $1, 1, now(), now(), now()
              where exists (select 1 from membership)
              on conflict (blueprint_id) do update set
                cart_holder_count = public.marketplace_card_cart_analytics.cart_holder_count + 1,
                first_added_at = coalesce(
                  public.marketplace_card_cart_analytics.first_added_at,
                  excluded.first_added_at
                ),
                last_added_at = excluded.last_added_at,
                updated_at = excluded.updated_at
              returning cart_holder_count
            )
            select
              coalesce(
                (select cart_holder_count from aggregate),
                (select cart_holder_count from public.marketplace_card_cart_analytics
                  where blueprint_id = $1),
                0
              ) as cart_holder_count
            "#,
        )
        .bind(blueprint_id)
        .bind(holder_key)
        .fetch_one(state.write_db())
        .await?
    } else {
        sqlx::query(
            r#"
            with membership as (
              delete from public.marketplace_card_cart_users
              where blueprint_id = $1 and holder_key = $2
              returning 1
            ),
            aggregate as (
              update public.marketplace_card_cart_analytics
              set cart_holder_count = greatest(0, cart_holder_count - 1),
                  updated_at = now()
              where blueprint_id = $1 and exists (select 1 from membership)
              returning cart_holder_count
            )
            select
              coalesce(
                (select cart_holder_count from aggregate),
                (select cart_holder_count from public.marketplace_card_cart_analytics
                  where blueprint_id = $1),
                0
              ) as cart_holder_count
            "#,
        )
        .bind(blueprint_id)
        .bind(holder_key)
        .fetch_one(state.write_db())
        .await?
    };
    Ok(row.try_get::<i64, _>("cart_holder_count").unwrap_or(0))
}

async fn record_watchlist_change(
    state: &DomainState,
    blueprint_id: i64,
    action: &str,
    user_uid: &str,
) -> Result<i64, sqlx::Error> {
    let row = if action == "add" {
        sqlx::query(
            r#"
            with membership as (
              insert into public.marketplace_card_watchlist_users
                (blueprint_id, user_uid, added_at, updated_at)
              values ($1, $2, now(), now())
              on conflict (blueprint_id, user_uid) do nothing
              returning 1
            ),
            aggregate as (
              insert into public.marketplace_card_watchlist_analytics
                (blueprint_id, watchlist_count, first_watchlisted_at, last_watchlisted_at, updated_at)
              select $1, 1, now(), now(), now()
              where exists (select 1 from membership)
              on conflict (blueprint_id) do update set
                watchlist_count = public.marketplace_card_watchlist_analytics.watchlist_count + 1,
                first_watchlisted_at = coalesce(
                  public.marketplace_card_watchlist_analytics.first_watchlisted_at,
                  excluded.first_watchlisted_at
                ),
                last_watchlisted_at = excluded.last_watchlisted_at,
                updated_at = excluded.updated_at
              returning watchlist_count
            )
            select
              coalesce(
                (select watchlist_count from aggregate),
                (select watchlist_count from public.marketplace_card_watchlist_analytics
                  where blueprint_id = $1),
                0
              ) as watchlist_count
            "#,
        )
        .bind(blueprint_id)
        .bind(user_uid)
        .fetch_one(state.write_db())
        .await?
    } else {
        sqlx::query(
            r#"
            with membership as (
              delete from public.marketplace_card_watchlist_users
              where blueprint_id = $1 and user_uid = $2
              returning 1
            ),
            aggregate as (
              update public.marketplace_card_watchlist_analytics
              set watchlist_count = greatest(0, watchlist_count - 1),
                  updated_at = now()
              where blueprint_id = $1 and exists (select 1 from membership)
              returning watchlist_count
            )
            select
              coalesce(
                (select watchlist_count from aggregate),
                (select watchlist_count from public.marketplace_card_watchlist_analytics
                  where blueprint_id = $1),
                0
              ) as watchlist_count
            "#,
        )
        .bind(blueprint_id)
        .bind(user_uid)
        .fetch_one(state.write_db())
        .await?
    };
    Ok(row.try_get::<i64, _>("watchlist_count").unwrap_or(0))
}

// ---------------------------------------------------------------------------
// Account cart sync
// ---------------------------------------------------------------------------

const CART_WRITES_PER_MINUTE: i64 = 120;

pub async fn marketplace_cart_sync_get(
    State(state): State<DomainState>,
    super::CartAuthedUser(claims): super::CartAuthedUser,
) -> Result<Response, ApiError> {
    let cart = match read_cart(&state, &claims.uid).await {
        Ok(cart) => cart,
        Err(error) => return Ok(cart_error_response(ApiError::new(error.status, "Cart sync failed."))),
    };
    Ok(private_json(cart))
}

pub async fn marketplace_cart_sync_put(
    State(state): State<DomainState>,
    super::CartAuthedUser(claims): super::CartAuthedUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let (allowed, _count) = limit_best_effort(
        &state,
        "cart-sync",
        &claims.uid,
        CART_WRITES_PER_MINUTE,
        60,
    )
    .await;
    if !allowed {
        let mut response = ApiError::new(StatusCode::TOO_MANY_REQUESTS, "Too many cart saves. Try again in a minute.")
            .into_response();
        response
            .headers_mut()
            .insert("retry-after", axum::http::HeaderValue::from_static("60"));
        return Ok(cart_private_response(response));
    }
    let saved = match write_cart(&state, &claims.uid, &body, cart::base_rev(body.get("baseRev"))).await {
        Ok(saved) => saved,
        Err(error) => return Ok(cart_error_response(ApiError::new(error.status, "Cart sync failed."))),
    };
    if saved.0 {
        Ok(private_json(saved.1))
    } else {
        Ok(cart_private_response((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "The cart changed on another device.",
                "code": "CART_REV",
                "cart": saved.1,
            })),
        )
            .into_response()))
    }
}

async fn read_cart(state: &DomainState, uid: &str) -> Result<Value, ApiError> {
    let row = sqlx::query(
        "select items, saved, gift, rev, updated_at
           from public.marketplace_user_carts where user_uid = $1 limit 1",
    )
    .bind(uid)
    .fetch_optional(state.read_db())
    .await;
    match row {
        Ok(row) => {
            let projected = row.as_ref().map(row_to_json);
            Ok(cart::cart_from_row(projected.as_ref()))
        }
        Err(error) => {
            if is_undefined_table(&error) {
                return Ok(cart::empty_cart());
            }
            Err(error.into())
        }
    }
}

fn row_to_json(row: &sqlx::postgres::PgRow) -> Value {
    let items: Value = row.try_get("items").unwrap_or(json!([]));
    let saved: Value = row.try_get("saved").unwrap_or(json!([]));
    let gift: bool = row.try_get("gift").unwrap_or(false);
    let rev: i64 = row.try_get("rev").unwrap_or(0);
    let updated_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("updated_at").ok();
    json!({
        "items": items,
        "saved": saved,
        "gift": gift,
        "rev": rev,
        "updated_at": updated_at.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    })
}

fn is_undefined_table(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(database) => database.code().as_deref() == Some("42P01"),
        _ => false,
    }
}

/// Revision-checked save. Returns `(ok, cart)`.
async fn write_cart(
    state: &DomainState,
    uid: &str,
    raw: &Value,
    base_rev: i64,
) -> Result<(bool, Value), ApiError> {
    let cleaned = cart::clean_cart_state(raw);
    let items = cleaned.get("items").cloned().unwrap_or(json!([]));
    let saved = cleaned.get("saved").cloned().unwrap_or(json!([]));
    let gift = cleaned.get("gift").and_then(Value::as_bool).unwrap_or(false);
    let card_ids = cart::cart_card_ids(&cleaned);

    let row = sqlx::query(
        r#"
        insert into public.marketplace_user_carts
          (user_uid, items, saved, gift, card_ids, rev, updated_at)
        values ($1, $2::jsonb, $3::jsonb, $4, $5::bigint[], 1, now())
        on conflict (user_uid) do update
           set items = excluded.items,
               saved = excluded.saved,
               gift = excluded.gift,
               card_ids = excluded.card_ids,
               rev = public.marketplace_user_carts.rev + 1,
               updated_at = now()
         where public.marketplace_user_carts.rev = $6
        returning items, saved, gift, rev, updated_at
        "#,
    )
    .bind(uid)
    .bind(&items)
    .bind(&saved)
    .bind(gift)
    .bind(&card_ids)
    .bind(base_rev)
    .fetch_optional(state.write_db())
    .await
    .map_err(ApiError::from)?;

    if let Some(row) = row {
        return Ok((true, cart::cart_from_row(Some(&row_to_json(&row)))));
    }
    Ok((false, read_cart(state, uid).await?))
}

// ---------------------------------------------------------------------------
// Recents
// ---------------------------------------------------------------------------

const RECENT_MAX: usize = 24;

pub async fn marketplace_recents_get(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let game = resolve_recents_game(&headers, query.get("game").map(String::as_str), None)?;
    let card_ids = read_recents(&state, &claims.uid, game).await?;
    Ok(private_json(json!({ "game": game, "cardIds": card_ids })))
}

pub async fn marketplace_recents_write(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let game = resolve_recents_game(
        &headers,
        query.get("game").map(String::as_str),
        Some(&body),
    )?;
    let extra = body
        .get("cardId")
        .or_else(|| body.get("card_id"))
        .and_then(|value| parse_public_card_id(value));
    let incoming = body
        .get("cardIds")
        .or_else(|| body.get("card_ids"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if let Some(extra) = extra {
        if body.get("cardIds").is_none() && body.get("card_ids").is_none() {
            assert_cards_in_game_catalog(&state, game, &[extra]).await?;
            let current = read_recents(&state, &claims.uid, game).await?;
            let mut merged: Vec<i64> = vec![extra];
            for id in current {
                if let Some(id) = id.as_i64() {
                    merged.push(id);
                }
            }
            let ids = normalize_recent_ids(merged);
            let written = write_recents(&state, &claims.uid, game, &ids).await?;
            return Ok(private_json(json!({ "game": game, "cardIds": written })));
        }
    }

    let merged: Vec<i64> = match extra {
        Some(extra) => {
            let mut list = vec![extra];
            for value in &incoming {
                if let Some(id) = parse_public_card_id(value) {
                    list.push(id);
                }
            }
            list
        }
        None => incoming
            .iter()
            .filter_map(parse_public_card_id)
            .collect::<Vec<_>>(),
    };
    let ids = normalize_recent_ids(merged);
    let valid = assert_cards_in_game_catalog(&state, game, &ids).await?;
    let written = write_recents(&state, &claims.uid, game, &valid).await?;
    Ok(private_json(json!({ "game": game, "cardIds": written })))
}

pub fn parse_public_card_id(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().filter(|id| *id > 0),
        Value::String(text) => text.trim().parse::<i64>().ok().filter(|id| *id > 0),
        _ => None,
    }
}

fn normalize_recent_ids(values: impl IntoIterator<Item = i64>) -> Vec<i64> {
    let mut out = Vec::new();
    for id in values {
        if id <= 0 || out.contains(&id) {
            continue;
        }
        out.push(id);
        if out.len() >= RECENT_MAX {
            break;
        }
    }
    out
}

async fn read_recents(state: &DomainState, uid: &str, game: &str) -> Result<Vec<Value>, ApiError> {
    let row = sqlx::query(
        "select card_ids from public.marketplace_user_recents
          where user_uid = $1 and game = $2 limit 1",
    )
    .bind(uid)
    .bind(game)
    .fetch_optional(state.read_db())
    .await;
    match row {
        Ok(row) => {
            let ids: Vec<i64> = row
                .as_ref()
                .and_then(|row| row.try_get::<Vec<i64>, _>("card_ids").ok())
                .unwrap_or_default();
            Ok(normalize_recent_ids(ids).into_iter().map(Value::from).collect())
        }
        Err(error) => {
            if is_undefined_table(&error) || is_undefined_column(&error) {
                return Ok(Vec::new());
            }
            Err(error.into())
        }
    }
}

fn is_undefined_column(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(database) => database.code().as_deref() == Some("42703"),
        _ => false,
    }
}

async fn write_recents(
    state: &DomainState,
    uid: &str,
    game: &str,
    ids: &[i64],
) -> Result<Vec<Value>, ApiError> {
    let card_ids = normalize_recent_ids(ids.iter().copied());
    sqlx::query(
        "insert into public.marketplace_user_recents (user_uid, game, card_ids, updated_at)
         values ($1, $2, $3::bigint[], now())
         on conflict (user_uid, game) do update
           set card_ids = excluded.card_ids, updated_at = now()",
    )
    .bind(uid)
    .bind(game)
    .bind(&card_ids)
    .execute(state.write_db())
    .await
    .map_err(ApiError::from)?;
    Ok(card_ids.into_iter().map(Value::from).collect())
}

async fn assert_cards_in_game_catalog(
    state: &DomainState,
    game: &str,
    ids: &[i64],
) -> Result<Vec<i64>, ApiError> {
    let wanted = normalize_recent_ids(ids.iter().copied());
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    // Each game validates against its own catalog database
    // (`<GAME>_MARKETPLACE_DATABASE_URL`, the Node `databaseUrlEnv` contract).
    let Some(pools) = state.game_pools(game).await else {
        return Err(DomainState::game_catalog_unconfigured(game));
    };
    let rows = sqlx::query(
        "select card_id::text as id from public.marketplace_search_candidates
          where card_id = any($1::bigint[])",
    )
    .bind(&wanted)
    .fetch_all(&pools.read)
    .await
    .map_err(|error| crate::game::catalog_error(game, error))?;
    let present: Vec<String> = rows
        .iter()
        .filter_map(|row| row.try_get::<String, _>("id").ok())
        .collect();
    let valid: Vec<i64> = wanted
        .iter()
        .copied()
        .filter(|id| present.contains(&id.to_string()))
        .collect();
    if valid.len() != wanted.len() {
        return Err(ApiError::bad_request("Card not found in this game catalog.")
            .with_code("INVALID_CARD_FOR_GAME"));
    }
    Ok(valid)
}

// ---------------------------------------------------------------------------
// Public interaction events
// ---------------------------------------------------------------------------

const WEIGHTS: &[(&str, i64)] = &[
    ("view", 1),
    ("search", 2),
    ("click", 4),
    ("reserve", 10),
    ("cart_add", 8),
    ("sale", 20),
];

const ALLOWED_METADATA_KEYS: &[&str] = &[
    "source",
    "query",
    "resultRank",
    "resultCount",
    "language",
    "name",
    "set",
    "number",
    "rarity",
    "type",
    "itemKind",
    "productType",
    "trainerName",
    "tags",
    "imageUrl",
    "homepageImageUrl",
    "ctId",
];

fn event_weight(event_type: &str) -> Option<i64> {
    WEIGHTS
        .iter()
        .find(|(name, _)| *name == event_type)
        .map(|(_, weight)| *weight)
}

pub fn clean_metadata(value: &Value) -> Value {
    let mut out = serde_json::Map::new();
    let Some(object) = value.as_object() else {
        return Value::Object(out);
    };
    for (key, raw) in object {
        if !ALLOWED_METADATA_KEYS.contains(&key.as_str()) || raw.is_null() {
            continue;
        }
        match raw {
            Value::String(text) => {
                let text: String = text.trim().chars().take(160).collect();
                if !text.is_empty() {
                    out.insert(key.clone(), Value::String(text));
                }
            }
            Value::Number(number) => {
                if let Some(value) = number.as_f64() {
                    if value.is_finite() {
                        out.insert(key.clone(), json!(value.trunc() as i64));
                    }
                }
            }
            Value::Bool(flag) => {
                out.insert(key.clone(), Value::Bool(*flag));
            }
            Value::Array(values) => {
                let list: Vec<Value> = values
                    .iter()
                    .filter_map(|entry| entry.as_str())
                    .map(|entry| entry.trim().chars().take(80).collect::<String>())
                    .filter(|entry| !entry.is_empty())
                    .take(8)
                    .map(Value::String)
                    .collect();
                if !list.is_empty() {
                    out.insert(key.clone(), Value::Array(list));
                }
            }
            _ => {}
        }
    }
    Value::Object(out)
}

pub async fn marketplace_event(
    State(state): State<DomainState>,
    OptionalUser(claims): OptionalUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let card_id = body.get("cardId").and_then(Value::as_i64).unwrap_or(0);
    let event_type = body
        .get("eventType")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if card_id <= 0 || event_weight(&event_type).is_none() {
        return Err(ApiError::bad_request("Invalid marketplace event."));
    }
    let mut metadata_source = body.get("metadata").cloned().unwrap_or(json!({}));
    if let Some(object) = metadata_source.as_object_mut() {
        let source: String = body
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("web")
            .chars()
            .take(40)
            .collect();
        object.insert("source".into(), Value::String(source));
    }
    let metadata = clean_metadata(&metadata_source);
    let weight = event_weight(&event_type).unwrap_or(0);
    let uid = claims.map(|claims| claims.uid);

    // `recordMarketplaceImage`: Node derives an image-diagnostic entry for every
    // navigation event (in-process ring + one structured log line; there is no
    // table). Kept as a tracing event so the derivation is not lost.
    {
        let entry = crate::domain::media::marketplace_image_entry(
            &json!({
                "source": "marketplace-event",
                "status": "navigate",
                "cardId": card_id.to_string(),
                "ctId": metadata.get("ctId").cloned().unwrap_or(Value::Null),
                "name": metadata.get("name").cloned().unwrap_or(Value::Null),
                "route": metadata.get("source").cloned().unwrap_or(Value::Null),
                "url": metadata
                    .get("imageUrl")
                    .or_else(|| metadata.get("homepageImageUrl"))
                    .cloned()
                    .unwrap_or(Value::Null),
            }),
            &state.now_iso(),
        );
        tracing::info!(marketplace_image = %entry, "marketplace-image");
    }

    // The Node handler answers 204 before writing so page views never block.
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = record_event(&state, card_id, &event_type, weight, &metadata, uid.as_deref()).await {
            tracing::warn!(%error, "marketplace-event write failed");
        }
    });
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn record_event(
    state: &DomainState,
    card_id: i64,
    event_type: &str,
    weight: i64,
    metadata: &Value,
    user_uid: Option<&str>,
) -> Result<(), sqlx::Error> {
    match sqlx::query(
        r#"
        insert into public.marketplace_card_events (card_id, event_type, weight, metadata, user_uid)
        select resolved.card_id, $2, $3, $4::jsonb, $5
        from (
          select coalesce(
            (select c.card_id from public.marketplace_cards c
              where c.card_id = $1::bigint or c.ct_id = $1::bigint limit 1),
            $1::bigint
          ) as card_id
        ) resolved
        "#,
    )
    .bind(card_id)
    .bind(event_type)
    .bind(weight)
    .bind(metadata)
    .bind(user_uid)
    .execute(state.write_db())
    .await
    {
        Ok(_) => {}
        Err(error) => {
            if !is_undefined_column(&error) {
                return Err(error);
            }
            sqlx::query(
                r#"
                insert into public.marketplace_card_events (card_id, event_type, weight, metadata)
                select resolved.card_id, $2, $3, $4::jsonb
                from (
                  select coalesce(
                    (select c.card_id from public.marketplace_cards c
                      where c.card_id = $1::bigint or c.ct_id = $1::bigint limit 1),
                    $1::bigint
                  ) as card_id
                ) resolved
                "#,
            )
            .bind(card_id)
            .bind(event_type)
            .bind(weight)
            .bind(metadata)
            .execute(state.write_db())
            .await?;
        }
    }

    let query = metadata
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if event_type == "search" && query.chars().count() >= 2 {
        let language = metadata
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("en")
            .to_string();
        let _ = sqlx::query("select public.record_marketplace_query_chunks($1, $2, $3, $4)")
            .bind(&query)
            .bind(&language)
            .bind(event_type)
            .bind(weight)
            .execute(state.write_db())
            .await;
    }
    Ok(())
}

/// Method guard helper used by the OPTIONS handlers.
pub fn options_response(methods: &str) -> Response {
    let mut response = empty_no_content();
    if let Ok(value) = axum::http::HeaderValue::from_str(methods) {
        response.headers_mut().insert("access-control-allow-methods", value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_aliases_match_the_recents_map() {
        for (alias, game) in [
            ("pokemon", "pokemon"),
            ("one-piece", "one_piece"),
            ("OP", "one_piece"),
            ("mtg", "magic"),
            ("yu_gi_oh", "yugioh"),
            ("fab", "flesh_and_blood"),
            ("swu", "star_wars"),
            ("the-spoils", "the_spoils"),
        ] {
            assert_eq!(normalize_game(alias), Some(game), "{alias}");
        }
        assert_eq!(normalize_game("chess"), None);
    }

    #[test]
    fn recents_require_an_explicit_game() {
        let headers = HeaderMap::new();
        let error = resolve_recents_game(&headers, None, None).unwrap_err();
        assert_eq!(error.status.as_u16(), 400);

        let mut headers = HeaderMap::new();
        headers.insert("x-marketplace-game", "One-Piece".parse().unwrap());
        assert_eq!(
            resolve_recents_game(&headers, None, None).unwrap(),
            "one_piece"
        );
        assert_eq!(
            resolve_recents_game(&HeaderMap::new(), Some("magic"), None).unwrap(),
            "magic"
        );
    }

    #[test]
    fn recent_ids_are_deduped_capped_and_positive() {
        assert_eq!(normalize_recent_ids([0, -1, 5, 5, 7]), vec![5, 7]);
        let many: Vec<i64> = (1..=40).collect();
        assert_eq!(normalize_recent_ids(many).len(), RECENT_MAX);
    }

    #[test]
    fn event_metadata_is_allowlisted_and_squashed() {
        let cleaned = clean_metadata(&json!({
            "source": "web",
            "query": "charizard",
            "resultRank": 3.7,
            "tags": ["a", "b"],
            "secretField": "nope",
            "ctId": null,
        }));
        assert_eq!(cleaned["source"], json!("web"));
        assert_eq!(cleaned["resultRank"], json!(3));
        assert_eq!(cleaned["tags"], json!(["a", "b"]));
        assert!(cleaned.get("secretField").is_none());
        assert!(cleaned.get("ctId").is_none());
    }

    #[test]
    fn event_weights_match_the_node_table() {
        assert_eq!(event_weight("view"), Some(1));
        assert_eq!(event_weight("search"), Some(2));
        assert_eq!(event_weight("click"), Some(4));
        assert_eq!(event_weight("reserve"), Some(10));
        assert_eq!(event_weight("cart_add"), Some(8));
        assert_eq!(event_weight("sale"), Some(20));
        assert_eq!(event_weight("nope"), None);
    }

    #[test]
    fn blueprint_ids_require_positive_safe_integers() {
        assert_eq!(clean_blueprint_id(Some(&json!(693360))), Some(693360));
        assert_eq!(clean_blueprint_id(Some(&json!("12"))), Some(12));
        assert_eq!(clean_blueprint_id(Some(&json!(0))), None);
        assert_eq!(clean_blueprint_id(Some(&json!(-3))), None);
        assert_eq!(clean_blueprint_id(Some(&json!(1.5))), None);
        assert_eq!(clean_blueprint_id(None), None);
    }
}

fn cart_private_response(mut response: Response) -> Response {
    response.headers_mut().insert("cache-control", axum::http::HeaderValue::from_static("private, no-store"));
    response
}
fn cart_error_response(error: ApiError) -> Response { cart_private_response(error.into_response()) }
pub async fn cart_sync_method_not_allowed() -> Response {
    let mut response = cart_private_response((StatusCode::METHOD_NOT_ALLOWED, Json(serde_json::json!({"error":"GET or PUT only."}))).into_response());
    response.headers_mut().insert("allow", axum::http::HeaderValue::from_static("GET, PUT, OPTIONS"));
    response
}
