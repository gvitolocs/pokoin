//! Ports of `_redis_ns.js`, `_redis_cache.js` and `_read_model_cache.js` —
//! versioned key namespaces, the fail-open disposable cache commands, and
//! the assembled read-model helpers (generation scoping + in-process
//! coalescing).
//!
//! Same Pi Redis as search/readiness (`state.api.redis()`), same keys, TTLs
//! and JSON value formats — Node and Rust share it during the cutover. Every
//! helper resolves to a miss/empty value on timeout, protocol error, or a
//! down server. Callers must not store stock, balances, or orders here.

use serde_json::Value;
use sha2::Digest;
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

// ---------------------------------------------------------------------------
// _redis_ns.js
// ---------------------------------------------------------------------------

pub const MARKETPLACE: &str = "pokoin:marketplace:v1";
pub const SELLER: &str = "pokoin:seller:v1";
pub const RL: &str = "pokoin:rl:v1";
pub const LOCK: &str = "pokoin:lock:v1";
pub const REFERENCE: &str = "pokoin:reference:v1";

/// `join(prefix, parts)` — trimmed, empties dropped, `:`-joined.
pub fn join(prefix: &str, parts: &[&str]) -> String {
    let body = parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(":");
    if body.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}:{body}")
    }
}

pub fn marketplace_key(parts: &[&str]) -> String {
    join(MARKETPLACE, parts)
}

pub fn seller_key(parts: &[&str]) -> String {
    join(SELLER, parts)
}

pub fn rate_limit_key(parts: &[&str]) -> String {
    join(RL, parts)
}

pub fn lock_key(parts: &[&str]) -> String {
    join(LOCK, parts)
}

pub fn reference_key(parts: &[&str]) -> String {
    join(REFERENCE, parts)
}

/// `generationKey(scope)` — the atomic invalidation counter of a family.
pub fn generation_key(scope: &str) -> String {
    marketplace_key(&["gen", scope])
}

// ---------------------------------------------------------------------------
// _redis_cache.js
// ---------------------------------------------------------------------------

fn timeout_ms() -> u64 {
    std::env::var("REDIS_CACHE_TIMEOUT_MS")
        .or_else(|_| std::env::var("REDIS_TIMEOUT_MS"))
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0)
        .unwrap_or(150)
}

/// Counters of `redisCacheStats()`.
pub struct Stats {
    pub get_hit: AtomicI64,
    pub get_miss: AtomicI64,
    pub get_malformed: AtomicI64,
    pub get_error: AtomicI64,
    pub set_ok: AtomicI64,
    pub set_error: AtomicI64,
    pub del_ok: AtomicI64,
    pub timeouts: AtomicI64,
    pub fallback: AtomicI64,
}

impl Stats {
    const fn new() -> Self {
        Self {
            get_hit: AtomicI64::new(0),
            get_miss: AtomicI64::new(0),
            get_malformed: AtomicI64::new(0),
            get_error: AtomicI64::new(0),
            set_ok: AtomicI64::new(0),
            set_error: AtomicI64::new(0),
            del_ok: AtomicI64::new(0),
            timeouts: AtomicI64::new(0),
            fallback: AtomicI64::new(0),
        }
    }
}

fn stats() -> &'static Stats {
    static STATS: OnceLock<Stats> = OnceLock::new();
    STATS.get_or_init(Stats::new)
}

/// `redisCacheStats()` as a JSON snapshot.
pub fn redis_cache_stats() -> Value {
    serde_json::json!({
        "getHit": stats().get_hit.load(Ordering::Relaxed),
        "getMiss": stats().get_miss.load(Ordering::Relaxed),
        "getMalformed": stats().get_malformed.load(Ordering::Relaxed),
        "getError": stats().get_error.load(Ordering::Relaxed),
        "setOk": stats().set_ok.load(Ordering::Relaxed),
        "setError": stats().set_error.load(Ordering::Relaxed),
        "delOk": stats().del_ok.load(Ordering::Relaxed),
        "timeouts": stats().timeouts.load(Ordering::Relaxed),
        "fallback": stats().fallback.load(Ordering::Relaxed),
    })
}

fn note_error(operation: &str, error: &str) {
    stats().fallback.fetch_add(1, Ordering::Relaxed);
    tracing::warn!(
        operation = operation,
        message = error,
        "redis_cache_unavailable"
    );
}

/// A public(crate) i64 view of a redis reply.
pub(crate) fn value_to_i64(value: &redis::Value) -> Option<i64> {
    match value {
        redis::Value::Int(n) => Some(*n),
        redis::Value::BulkString(bytes) => std::str::from_utf8(bytes).ok()?.parse().ok(),
        redis::Value::SimpleString(text) => text.parse().ok(),
        _ => None,
    }
}

fn as_text(value: &redis::Value) -> Option<String> {
    match value {
        redis::Value::BulkString(bytes) => String::from_utf8(bytes.clone()).ok(),
        redis::Value::SimpleString(text) => Some(text.clone()),
        redis::Value::Okay => Some("OK".to_string()),
        _ => None,
    }
}

/// `command(parts)` — fail-open: `None` on timeout, protocol error, or a
/// down server (the same null the Node helper resolves to).
pub async fn command(
    conn: &mut redis::aio::ConnectionManager,
    parts: &[&str],
) -> Option<redis::Value> {
    let mut cmd = redis::cmd(parts[0]);
    for part in &parts[1..] {
        cmd.arg(*part);
    }
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms()),
        cmd.query_async::<redis::Value>(conn),
    )
    .await
    {
        Ok(Ok(value)) => Some(value),
        Ok(Err(error)) => {
            stats().get_error.fetch_add(1, Ordering::Relaxed);
            note_error("getError", &error.to_string());
            None
        }
        Err(_) => {
            stats().timeouts.fetch_add(1, Ordering::Relaxed);
            note_error("timeouts", "redis cache command timeout");
            None
        }
    }
}

/// `getJson(key)` — `None` covers true misses and transport failures.
pub async fn get_json(conn: &mut redis::aio::ConnectionManager, key: &str) -> Option<Value> {
    let raw = command(conn, &["GET", key]).await;
    let raw = match raw {
        None | Some(redis::Value::Nil) => {
            stats().get_miss.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        Some(value) => value,
    };
    match as_text(&raw) {
        Some(text) if !text.is_empty() => match serde_json::from_str(&text) {
            Ok(parsed) => {
                stats().get_hit.fetch_add(1, Ordering::Relaxed);
                Some(parsed)
            }
            Err(_) => {
                stats().get_malformed.fetch_add(1, Ordering::Relaxed);
                stats().get_miss.fetch_add(1, Ordering::Relaxed);
                None
            }
        },
        // '' behaves like a miss.
        _ => {
            stats().get_miss.fetch_add(1, Ordering::Relaxed);
            None
        }
    }
}

/// `setJson(key, value, ttlSeconds)`.
pub async fn set_json(
    conn: &mut redis::aio::ConnectionManager,
    key: &str,
    value: &Value,
    ttl_seconds: i64,
) -> bool {
    if value.is_null() || ttl_seconds == 0 {
        return false;
    }
    let reply = command(
        conn,
        &["SETEX", key, &ttl_seconds.to_string(), &value.to_string()],
    )
    .await;
    match reply {
        Some(redis::Value::Okay) => {
            stats().set_ok.fetch_add(1, Ordering::Relaxed);
            true
        }
        Some(redis::Value::SimpleString(text)) if text == "OK" => {
            stats().set_ok.fetch_add(1, Ordering::Relaxed);
            true
        }
        other => {
            stats().set_error.fetch_add(1, Ordering::Relaxed);
            let text = other
                .as_ref()
                .and_then(as_text)
                .unwrap_or_else(|| "nil".into());
            note_error("setError", &text);
            false
        }
    }
}

/// `del(key)`.
pub async fn del(conn: &mut redis::aio::ConnectionManager, key: &str) -> i64 {
    let reply = command(conn, &["DEL", key]).await;
    match reply.as_ref().and_then(value_to_i64) {
        Some(removed) => {
            stats().del_ok.fetch_add(removed, Ordering::Relaxed);
            removed
        }
        None => 0,
    }
}

const INCR_WINDOW_SCRIPT: &str = "
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
";

/// `incrWindow(key, windowSeconds)`.
pub async fn incr_window(
    conn: &mut redis::aio::ConnectionManager,
    key: &str,
    window_seconds: i64,
) -> Option<i64> {
    let reply = command(
        conn,
        &[
            "EVAL",
            INCR_WINDOW_SCRIPT,
            "1",
            key,
            &window_seconds.max(1).to_string(),
        ],
    )
    .await;
    match reply.as_ref().and_then(value_to_i64) {
        Some(count) => Some(count),
        None => {
            note_error("incrError", "non-numeric reply");
            None
        }
    }
}

const ACQUIRE_LOCK_SCRIPT: &str = "
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
  return 1
end
return 0
";
const RELEASE_LOCK_SCRIPT: &str = "
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
";
const REFRESH_LOCK_SCRIPT: &str = "
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
";

/// `acquireLock(key, ownerToken, ttlSeconds)`.
pub async fn acquire_lock(
    conn: &mut redis::aio::ConnectionManager,
    key: &str,
    owner_token: &str,
    ttl_seconds: i64,
) -> bool {
    let reply = command(
        conn,
        &[
            "EVAL",
            ACQUIRE_LOCK_SCRIPT,
            "1",
            key,
            owner_token,
            &ttl_seconds.max(1).to_string(),
        ],
    )
    .await;
    match reply.as_ref().and_then(value_to_i64) {
        Some(1) => true,
        Some(0) => false,
        _ => false,
    }
}

/// `releaseLock(key, ownerToken)`.
pub async fn release_lock(
    conn: &mut redis::aio::ConnectionManager,
    key: &str,
    owner_token: &str,
) -> bool {
    let reply = command(conn, &["EVAL", RELEASE_LOCK_SCRIPT, "1", key, owner_token]).await;
    matches!(reply.as_ref().and_then(value_to_i64), Some(1))
}

/// `refreshLock(key, ownerToken, ttlSeconds)`.
pub async fn refresh_lock(
    conn: &mut redis::aio::ConnectionManager,
    key: &str,
    owner_token: &str,
    ttl_seconds: i64,
) -> bool {
    let reply = command(
        conn,
        &[
            "EVAL",
            REFRESH_LOCK_SCRIPT,
            "1",
            key,
            owner_token,
            &ttl_seconds.max(1).to_string(),
        ],
    )
    .await;
    matches!(reply.as_ref().and_then(value_to_i64), Some(1))
}

// ---------------------------------------------------------------------------
// _read_model_cache.js
// ---------------------------------------------------------------------------

/// `CARD_TTL_SEC`.
pub fn card_ttl_sec() -> i64 {
    env_i64("POKOIN_CARD_CACHE_TTL", 20)
}

/// `SEARCH_TTL_SEC`.
pub fn search_ttl_sec() -> i64 {
    env_i64("POKOIN_SEARCH_CACHE_TTL", 20)
}

/// `HOME_TTL_SEC`.
pub fn home_ttl_sec() -> i64 {
    env_i64("POKOIN_HOME_CACHE_TTL", 20)
}

fn env_i64(name: &str, fallback: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(fallback)
}

/// `cacheEnabled()`.
pub fn cache_enabled() -> bool {
    if std::env::var("POKOIN_READ_CACHE").as_deref() == Ok("0") {
        return false;
    }
    if std::env::var("NODE_TEST_CONTEXT").is_ok()
        && std::env::var("POKOIN_READ_CACHE").as_deref() != Ok("1")
    {
        return false;
    }
    true
}

/// Parts of `cardPageKey`.
#[derive(Debug, Default, Clone)]
pub struct CardPageKeyParts<'a> {
    pub game: &'a str,
    pub card_id: &'a str,
    pub lang: &'a str,
    pub include_offers: bool,
    pub include_sales: bool,
    pub include_same_as: bool,
    pub live_offers: bool,
}

/// `cardPageKey({...})` — `''` when uncachable.
pub fn card_page_key(parts: &CardPageKeyParts<'_>) -> String {
    if parts.live_offers {
        return String::new();
    }
    let id = parts.card_id.trim();
    if id.is_empty() {
        return String::new();
    }
    let lang = if parts.lang.is_empty() {
        "en".to_string()
    } else {
        parts.lang.to_ascii_lowercase()
    };
    marketplace_key(&[
        "card",
        if parts.game.is_empty() {
            "pokemon"
        } else {
            parts.game
        },
        id,
        &lang,
        if parts.include_offers {
            "offers"
        } else {
            "nooffers"
        },
        if parts.include_sales {
            "sales"
        } else {
            "nosales"
        },
        if parts.include_same_as {
            "same"
        } else {
            "nosame"
        },
    ])
}

/// Parts of `searchPageKey`.
#[derive(Debug, Default, Clone)]
pub struct SearchPageKeyParts<'a> {
    pub game: &'a str,
    pub query: &'a str,
    pub lang: &'a str,
    pub limit: i64,
    pub offset: i64,
    pub product_type: &'a str,
    pub print_language: &'a str,
    pub product_search_only: bool,
}

/// `searchPageKey({...})` — `''` outside the cached shape.
pub fn search_page_key(parts: &SearchPageKeyParts<'_>) -> String {
    let text = parts.query.trim().to_lowercase();
    let capped = parts.limit;
    let start = parts.offset;
    let len = text.encode_utf16().count();
    if len < 2 || len > 48 {
        return String::new();
    }
    if start != 0 || capped < 1 || capped > 48 {
        return String::new();
    }
    let digest = hex::encode(sha2::Sha256::digest(text.as_bytes()))[..16].to_string();
    let lang = if parts.lang.is_empty() {
        "en".to_string()
    } else {
        parts.lang.to_ascii_lowercase()
    };
    let capped_text = capped.to_string();
    marketplace_key(&[
        "search",
        if parts.game.is_empty() {
            "pokemon"
        } else {
            parts.game
        },
        &lang,
        if parts.product_type.is_empty() {
            "any"
        } else {
            parts.product_type
        },
        if parts.print_language.is_empty() {
            "all"
        } else {
            parts.print_language
        },
        if parts.product_search_only {
            "products"
        } else {
            "mixed"
        },
        &capped_text,
        &digest,
    ])
}

/// `homeSnapshotKey(game)`.
pub fn home_snapshot_key(game: &str) -> String {
    let id = if game.is_empty() { "pokemon" } else { game };
    if id == "pokemon" {
        marketplace_key(&["home", "react"])
    } else {
        marketplace_key(&["home", "react", "game", id])
    }
}

/// `generation(scope)` — `'0'` without a counter.
pub async fn generation(conn: &mut redis::aio::ConnectionManager, scope: &str) -> String {
    let raw = command(conn, &["GET", &generation_key(scope)]).await;
    match raw.as_ref().and_then(value_to_i64) {
        Some(n) if n > 0 => n.to_string(),
        _ => "0".to_string(),
    }
}

/// `readAssembled(key, scope)`.
pub async fn read_assembled(
    conn: &mut redis::aio::ConnectionManager,
    key: &str,
    scope: &str,
) -> Option<Value> {
    if !cache_enabled() || key.is_empty() {
        return None;
    }
    let gen = generation(conn, scope).await;
    let hit = get_json(conn, &format!("{key}:g{gen}")).await;
    hit.filter(|hit| hit.is_object())
}

/// `writeAssembled(key, scope, payload, ttlSeconds)`.
pub async fn write_assembled(
    conn: &mut redis::aio::ConnectionManager,
    key: &str,
    scope: &str,
    payload: &Value,
    ttl_seconds: i64,
) -> bool {
    if !cache_enabled() || key.is_empty() || payload.is_null() {
        return false;
    }
    let gen = generation(conn, scope).await;
    set_json(conn, &format!("{key}:g{gen}"), payload, ttl_seconds).await
}

/// `bumpGeneration(scope)`.
pub async fn bump_generation(conn: &mut redis::aio::ConnectionManager, scope: &str) -> Option<i64> {
    if !cache_enabled() || scope.is_empty() {
        return None;
    }
    command(conn, &["INCR", &generation_key(scope)])
        .await
        .as_ref()
        .and_then(value_to_i64)
}

/// `invalidateHome(game)`.
pub async fn invalidate_home(conn: &mut redis::aio::ConnectionManager, game: &str) -> Option<()> {
    if !cache_enabled() {
        return None;
    }
    let scope = format!("home:{}", if game.is_empty() { "pokemon" } else { game });
    bump_generation(conn, &scope).await;
    // Also drop the legacy TTL key used before gen-scoped home caching.
    del(conn, &home_snapshot_key(game)).await;
    Some(())
}

/// `invalidateCard(game, cardId)`.
pub async fn invalidate_card(
    conn: &mut redis::aio::ConnectionManager,
    game: &str,
    card_id: &str,
) -> Option<i64> {
    bump_generation(
        conn,
        &format!(
            "card:{}:{}",
            if game.is_empty() { "pokemon" } else { game },
            card_id
        ),
    )
    .await
}

/// `invalidateSearch(game)`.
pub async fn invalidate_search(
    conn: &mut redis::aio::ConnectionManager,
    game: &str,
) -> Option<i64> {
    bump_generation(
        conn,
        &format!("search:{}", if game.is_empty() { "pokemon" } else { game }),
    )
    .await
}

type Flight = Arc<flights::SharedFlight>;

mod flights {
    use super::*;
    pub type Payload = Arc<dyn std::any::Any + Send + Sync>;
    pub type SharedFlight = tokio::sync::Mutex<Option<Result<Payload, Payload>>>;
}

fn flights() -> &'static Mutex<HashMap<String, Flight>> {
    static FLIGHTS: OnceLock<Mutex<HashMap<String, Flight>>> = OnceLock::new();
    FLIGHTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `coalesce(key, load)` — concurrent callers with the same key share one
/// load; every waiter receives a clone of the outcome.
pub async fn coalesce<T, E, F>(key: &str, load: F) -> Result<T, E>
where
    F: Future<Output = Result<T, E>> + Send,
    T: Clone + Send + Sync + 'static,
    E: Clone + Send + Sync + 'static,
{
    if key.is_empty() {
        return load.await;
    }
    let flight = {
        let mut flights = flights()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if flights.len() > 1024 {
            flights.retain(|_, flight| Arc::strong_count(flight) > 1);
        }
        Arc::clone(flights.entry(key.to_string()).or_default())
    };
    let mut guard = flight.lock().await;
    if let Some(outcome) = guard.as_ref() {
        return decode_outcome(outcome.clone());
    }
    // Leader: run the load, publish the outcome, drop the flight.
    let outcome = load.await;
    let encoded: Result<flights::Payload, flights::Payload> = match &outcome {
        Ok(value) => Ok(Arc::new(value.clone())),
        Err(error) => Err(Arc::new(error.clone())),
    };
    *guard = Some(encoded.clone());
    let result = decode_outcome(encoded);
    let mut flights = flights()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if flights
        .get(key)
        .map(|f| Arc::ptr_eq(f, &flight))
        .unwrap_or(false)
    {
        flights.remove(key);
    }
    result
}

fn decode_outcome<T, E>(outcome: Result<flights::Payload, flights::Payload>) -> Result<T, E>
where
    T: Clone + Send + Sync + 'static,
    E: Clone + Send + Sync + 'static,
{
    match outcome {
        Ok(payload) => payload
            .downcast::<T>()
            .map(|value| (*value).clone())
            .map_err(|_| unreachable_payload()),
        Err(payload) => Err(payload
            .downcast::<E>()
            .map(|error| (*error).clone())
            .unwrap_or_else(|_| unreachable_payload())),
    }
}

fn unreachable_payload() -> ! {
    panic!("coalesce flight payload type mismatch")
}

/// The `{ payload, source }` of `loadCardPage`/`loadSearchPage`.
#[derive(Debug, Clone)]
pub struct AssembledPage {
    pub payload: Option<Value>,
    pub source: &'static str,
}

/// `loadCardPage(keyParts, load)` — generation-scoped cache with in-process
/// coalescing; `load` runs on a miss and the payload is written back with
/// [`card_ttl_sec`].
pub async fn load_card_page<F>(
    redis: Option<redis::aio::ConnectionManager>,
    key_parts: &CardPageKeyParts<'_>,
    load: F,
) -> AssembledPage
where
    F: Future<Output = Option<Value>> + Send,
{
    let key = card_page_key(key_parts);
    let flight_key = if key.is_empty() {
        format!("miss:{}", key_parts.card_id)
    } else {
        key.clone()
    };
    let scope = format!(
        "card:{}:{}",
        if key_parts.game.is_empty() {
            "pokemon"
        } else {
            key_parts.game
        },
        key_parts.card_id
    );
    let payload: Result<(Option<Value>, &'static str), std::convert::Infallible> =
        coalesce(&flight_key, async {
            if let Some(mut conn) = redis.clone() {
                if let Some(cached) = read_assembled(&mut conn, &key, &scope).await {
                    return Ok((Some(cached), "redis"));
                }
            }
            let payload = load.await;
            if let (Some(payload), Some(mut conn)) = (payload.as_ref(), redis.clone()) {
                write_assembled(&mut conn, &key, &scope, payload, card_ttl_sec()).await;
            }
            Ok((payload, "postgres"))
        })
        .await;
    let (payload, source) = payload.unwrap_or((None, "postgres"));
    AssembledPage { payload, source }
}

/// `loadSearchPage(keyParts, load)`.
pub async fn load_search_page<F>(
    redis: Option<redis::aio::ConnectionManager>,
    key_parts: &SearchPageKeyParts<'_>,
    load: F,
) -> AssembledPage
where
    F: Future<Output = Option<Value>> + Send,
{
    let key = search_page_key(key_parts);
    let flight_key = if key.is_empty() {
        format!("search-miss:{}", key_parts.query)
    } else {
        key.clone()
    };
    let scope = format!(
        "search:{}",
        if key_parts.game.is_empty() {
            "pokemon"
        } else {
            key_parts.game
        }
    );
    let payload: Result<(Option<Value>, &'static str), std::convert::Infallible> =
        coalesce(&flight_key, async {
            if let Some(mut conn) = redis.clone() {
                if let Some(cached) = read_assembled(&mut conn, &key, &scope).await {
                    return Ok((Some(cached), "redis"));
                }
            }
            let payload = load.await;
            if let (Some(payload), Some(mut conn)) = (payload.as_ref(), redis.clone()) {
                write_assembled(&mut conn, &key, &scope, payload, search_ttl_sec()).await;
            }
            Ok((payload, "postgres"))
        })
        .await;
    let (payload, source) = payload.unwrap_or((None, "postgres"));
    AssembledPage { payload, source }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn namespaces_join_and_trim() {
        assert_eq!(
            marketplace_key(&["card", "pokemon", "5"]),
            "pokoin:marketplace:v1:card:pokemon:5"
        );
        assert_eq!(
            generation_key("home:pokemon"),
            "pokoin:marketplace:v1:gen:home:pokemon"
        );
        assert_eq!(marketplace_key(&[]), "pokoin:marketplace:v1");
        assert_eq!(join("pfx", &["", " x ", "y"]), "pfx:x:y");
        assert_eq!(seller_key(&["a"]), "pokoin:seller:v1:a");
        assert_eq!(lock_key(&["a"]), "pokoin:lock:v1:a");
        assert_eq!(rate_limit_key(&["a"]), "pokoin:rl:v1:a");
        assert_eq!(reference_key(&["a"]), "pokoin:reference:v1:a");
    }

    #[test]
    fn home_keys_scope_games() {
        assert_eq!(
            home_snapshot_key("pokemon"),
            "pokoin:marketplace:v1:home:react"
        );
        assert_eq!(home_snapshot_key(""), "pokoin:marketplace:v1:home:react");
        assert_eq!(
            home_snapshot_key("magic"),
            "pokoin:marketplace:v1:home:react:game:magic"
        );
    }

    #[test]
    fn card_keys_track_every_variant() {
        let parts = CardPageKeyParts {
            game: "pokemon",
            card_id: "693360",
            lang: "EN",
            include_offers: true,
            include_sales: false,
            include_same_as: true,
            live_offers: false,
        };
        assert_eq!(
            card_page_key(&parts),
            "pokoin:marketplace:v1:card:pokemon:693360:en:offers:nosales:same"
        );
        assert_eq!(
            card_page_key(&CardPageKeyParts {
                live_offers: true,
                ..parts
            }),
            ""
        );
        assert_eq!(
            card_page_key(&CardPageKeyParts {
                card_id: " ",
                ..parts
            }),
            ""
        );
    }

    #[test]
    fn search_keys_hash_the_query() {
        let parts = SearchPageKeyParts {
            game: "pokemon",
            query: "Charizard",
            lang: "en",
            limit: 24,
            offset: 0,
            product_type: "",
            print_language: "all",
            product_search_only: false,
        };
        let key = search_page_key(&parts);
        assert!(key.starts_with("pokoin:marketplace:v1:search:pokemon:en:any:all:mixed:24:"));
        // Same text lowercased hashes identically.
        assert_eq!(
            key,
            search_page_key(&SearchPageKeyParts {
                query: "charizard",
                ..parts
            })
        );
        assert_eq!(
            search_page_key(&SearchPageKeyParts {
                query: "c",
                ..parts
            }),
            ""
        );
        assert_eq!(
            search_page_key(&SearchPageKeyParts {
                offset: 24,
                ..parts
            }),
            ""
        );
        assert_eq!(
            search_page_key(&SearchPageKeyParts { limit: 49, ..parts }),
            ""
        );
        assert_eq!(
            search_page_key(&SearchPageKeyParts { limit: 0, ..parts }),
            ""
        );
        assert_eq!(
            search_page_key(&SearchPageKeyParts {
                product_search_only: true,
                ..parts
            }),
            key.replace(":mixed:", ":products:")
        );
    }

    #[test]
    fn cache_can_be_disabled() {
        // The test environment does not set POKOIN_READ_CACHE; default on.
        assert!(cache_enabled() || std::env::var("POKOIN_READ_CACHE").as_deref() == Ok("0"));
    }

    #[tokio::test]
    async fn coalesce_shares_one_load() {
        use std::sync::atomic::AtomicUsize;
        static LOADS: AtomicUsize = AtomicUsize::new(0);
        LOADS.store(0, Ordering::Relaxed);
        let load = || async {
            LOADS.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok::<_, ()>(json!({"n": 1}))
        };
        let key = format!("test-flight-{}", std::process::id());
        let (a, b) = tokio::join!(coalesce(&key, load()), coalesce(&key, load()));
        assert_eq!(a.unwrap(), json!({"n": 1}));
        assert_eq!(b.unwrap(), json!({"n": 1}));
        assert_eq!(LOADS.load(Ordering::Relaxed), 1);
        // A later call after completion starts a fresh flight.
        let c = coalesce(&key, load()).await.unwrap();
        assert_eq!(c, json!({"n": 1}));
        assert_eq!(LOADS.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn coalesce_propagates_errors_to_waiters() {
        let key = format!("test-flight-err-{}", std::process::id());
        let (a, b) = tokio::join!(
            coalesce(&key, async { Err::<u8, _>("boom".to_string()) }),
            coalesce(&key, async { Err::<u8, _>("boom".to_string()) })
        );
        assert_eq!(a.unwrap_err(), "boom");
        assert_eq!(b.unwrap_err(), "boom");
    }
}
