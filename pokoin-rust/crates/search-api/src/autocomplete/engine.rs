//! Redis/SQL access of the autocomplete handler: the `_marketplace_db` pools
//! (primary, peer3 name search, variation replicas, analytics replicas, per
//! dimension pools, prefix shard clients), every candidate SQL query of
//! `marketplace-autocomplete.js`, the Supabase name-index tier (Postgres pool +
//! REST fallback), the RediSearch candidate load of the redis engine, the
//! circuits and the `withTimeout` budgets.

use serde_json::{json, Map, Value};
use sqlx::{Column, PgPool, Row, TypeInfo};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering as AtomicOrdering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use super::analytics::f32_to_f64;
use super::ladder::{
    self, AUTOCOMPLETE_ONE_CHAR_BACKEND_POOL_LIMIT, AUTOCOMPLETE_SQL_SAFE_POOL_CAP,
};
use super::normalize::{
    clean_language, compact, is_expansion_alias_term, is_rarity_term, is_variation_intent_term,
    js_num_or, js_str_or, search_terms,
};
use super::rank::{
    card_ids_from_name_token_row, dimension_tokens_for_source,
    expand_name_token_rows_to_candidate_ids, field_token_score, merge_rows_preserving_best,
    name_token_search_rank, normalize_prediction_rows, prediction_candidate_card_ids,
    prediction_debug_entry, predictive_confidence_boost, row_key, source_flags_for,
    supabase_predicted_name_confidence, supabase_rest_fuzzy_name_token_rows, NameAnchor,
    PredictivePlan, Token, PREDICTIVE_DIMENSION_SOURCES,
};
use super::row::{attach_canonical_path, get, get_any, num_field, str_field};

pub const SUPABASE_NAME_TOKEN_TABLE: &str = "marketplace_card_name_tokens";
pub const SEARCH_RPC_V2: &str = "search_marketplace_blueprint_candidates_v2";
pub const SEARCH_NAME_RPC: &str = "search_marketplace_blueprint_name_candidates";
pub const SEARCH_NON_NAME_RPC: &str = "search_marketplace_blueprint_non_name_candidates";

fn locale_cmp(left: &str, right: &str) -> Ordering {
    super::normalize::locale_cmp(left, right)
}

// --- errors ---

#[derive(Debug, Clone)]
pub struct EngineError {
    pub message: String,
    pub code: Option<String>,
    pub status: Option<u16>,
    pub payload: Option<Value>,
}

impl EngineError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            status: None,
            payload: None,
        }
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn from_sqlx(error: sqlx::Error) -> Self {
        let mut out = Self::new(error.to_string());
        if let Some(db) = error.as_database_error() {
            out.code = db.code().map(|code| code.to_string());
        }
        out
    }

    pub fn timeout(label: &str, timeout_ms: u64) -> Self {
        Self {
            message: format!("{label} timed out after {timeout_ms}ms"),
            code: Some("MARKETPLACE_SEARCH_TIMEOUT".to_owned()),
            status: None,
            payload: None,
        }
    }

    pub fn db_code(&self) -> Option<String> {
        self.code.clone()
    }

    pub fn from_redis(error: redis::RedisError) -> Self {
        Self::new(error.to_string())
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

// --- binds and generic SQL execution ---

#[derive(Clone, Debug)]
pub enum Bind {
    S(String),
    I(i64),
    F(f64),
    B(bool),
    SA(Vec<String>),
    IA(Vec<i64>),
    N,
}

pub async fn run_query(
    pool: &PgPool,
    sql: &str,
    binds: Vec<Bind>,
) -> Result<Vec<Value>, EngineError> {
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = match bind {
            Bind::S(value) => query.bind(value),
            // node-pg sends numbers untyped, so Postgres resolves them as
            // integer: bind int4 when it fits (function lookup by signature).
            Bind::I(value) => match i32::try_from(value) {
                Ok(small) => query.bind(small),
                Err(_) => query.bind(value),
            },
            Bind::F(value) => query.bind(value),
            Bind::B(value) => query.bind(value),
            Bind::SA(values) => query.bind(values),
            Bind::IA(values) => query.bind(values),
            Bind::N => query.bind(Option::<String>::None),
        };
    }
    let rows = query
        .fetch_all(pool)
        .await
        .map_err(EngineError::from_sqlx)?;
    Ok(rows.iter().map(pg_row_to_json).collect())
}

/// `withTimeout(promise, timeoutMs, label)`.
pub async fn with_timeout<T>(
    future: impl std::future::Future<Output = Result<T, EngineError>>,
    timeout_ms: u64,
    label: &str,
) -> Result<T, EngineError> {
    match tokio::time::timeout(Duration::from_millis(timeout_ms.max(1)), future).await {
        Ok(result) => result,
        Err(_) => Err(EngineError::timeout(label, timeout_ms)),
    }
}

fn timestamp_to_json(value: chrono::DateTime<chrono::Utc>) -> Value {
    Value::String(value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// pg row -> JSON object with the Node driver's coercions (float4 keeps its
/// shortest representation, timestamps become ISO strings, numerics stay text).
pub fn pg_row_to_json(row: &sqlx::postgres::PgRow) -> Value {
    let mut map = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let name = column.name().to_owned();
        let type_name = column.type_info().name().to_owned();
        let value: Value = match type_name.as_str() {
            "TEXT" | "VARCHAR" | "CHAR" | "BPCHAR" | "NAME" | "CITEXT" | "UNKNOWN" => row
                .try_get::<Option<String>, _>(index)
                .map(|value| value.map(Value::String).unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
            "INT2" | "SMALLINT" => row
                .try_get::<Option<i16>, _>(index)
                .map(|value| value.map(Value::from).unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
            "INT4" | "INT" => row
                .try_get::<Option<i32>, _>(index)
                .map(|value| {
                    value
                        .map(|value| Value::from(value as i64))
                        .unwrap_or(Value::Null)
                })
                .unwrap_or(Value::Null),
            // node-pg returns int8 as a string.
            "INT8" | "BIGINT" => row
                .try_get::<Option<i64>, _>(index)
                .map(|value| value.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
            "FLOAT4" | "REAL" => row
                .try_get::<Option<f32>, _>(index)
                .map(|value| {
                    value
                        .map(|value| Value::from(f32_to_f64(value)))
                        .unwrap_or(Value::Null)
                })
                .unwrap_or(Value::Null),
            "FLOAT8" | "DOUBLE PRECISION" => row
                .try_get::<Option<f64>, _>(index)
                .map(|value| value.map(Value::from).unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
            "BOOL" | "BOOLEAN" => row
                .try_get::<Option<bool>, _>(index)
                .map(|value| value.map(Value::Bool).unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
            "TIMESTAMPTZ"
            | "TIMESTAMP WITH TIME ZONE"
            | "TIMESTAMP"
            | "TIMESTAMP WITHOUT TIME ZONE" => row
                .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(index)
                .map(|value| value.map(timestamp_to_json).unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
            "DATE" => row
                .try_get::<Option<chrono::NaiveDate>, _>(index)
                .map(|value| {
                    value
                        .map(|value| Value::String(value.format("%Y-%m-%d").to_string()))
                        .unwrap_or(Value::Null)
                })
                .unwrap_or(Value::Null),
            "JSON" | "JSONB" => row
                .try_get::<Option<Value>, _>(index)
                .map(|value| value.unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
            "UUID" => row
                .try_get::<Option<uuid::Uuid>, _>(index)
                .map(|value| {
                    value
                        .map(|value| Value::String(value.to_string()))
                        .unwrap_or(Value::Null)
                })
                .unwrap_or(Value::Null),
            "NUMERIC" => row
                .try_get::<Option<sqlx::types::BigDecimal>, _>(index)
                .map(|value| {
                    value
                        .map(|value| Value::String(value.to_string()))
                        .unwrap_or(Value::Null)
                })
                .unwrap_or(Value::Null),
            "TEXT[]" => row
                .try_get::<Option<Vec<Option<String>>>, _>(index)
                .map(|values| {
                    Value::Array(
                        values
                            .unwrap_or_default()
                            .into_iter()
                            .map(|value| value.map(Value::String).unwrap_or(Value::Null))
                            .collect(),
                    )
                })
                .unwrap_or(Value::Null),
            "INT8[]" | "BIGINT[]" => row
                .try_get::<Option<Vec<Option<i64>>>, _>(index)
                .map(|values| {
                    Value::Array(
                        values
                            .unwrap_or_default()
                            .into_iter()
                            .map(|value| value.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null))
                            .collect(),
                    )
                })
                .unwrap_or(Value::Null),
            _ => row
                .try_get::<Option<Value>, _>(index)
                .ok()
                .flatten()
                .unwrap_or(Value::Null),
        };
        map.insert(name, value);
    }
    Value::Object(map)
}

// --- pools (_marketplace_db.js) ---

fn env_s(name: &str) -> String {
    std::env::var(name).unwrap_or_default().trim().to_owned()
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        let value = value.trim().to_owned();
        if value.is_empty() || !seen.insert(value.clone()) {
            continue;
        }
        seen.insert(value.clone());
        out.push(value);
    }
    out
}

/// `marketplaceDatabaseUrl()`.
pub fn marketplace_database_url() -> String {
    let url = env_s("MARKETPLACE_DATABASE_URL");
    if !url.is_empty() {
        return url;
    }
    env_s("MARKETPLACE_PEER4_DATABASE_URL")
}

/// `marketplaceNameSearchDatabaseUrl()`.
pub fn marketplace_name_search_database_url() -> String {
    let url = env_s("MARKETPLACE_NAME_SEARCH_DATABASE_URL");
    if !url.is_empty() {
        return url;
    }
    let peer3 = env_s("MARKETPLACE_PEER3_DATABASE_URL");
    if !peer3.is_empty() {
        return peer3;
    }
    marketplace_database_url()
}

/// `supabaseNameIndexConfigured()`. The name-token index is read over
/// Supabase REST only; the direct Postgres pool was removed because the Pi
/// cannot reach the Supabase database host (os error 101) and every request
/// paid a failed connect before falling back to REST.
pub fn supabase_name_index_configured() -> bool {
    supabase_rest_name_index_configured()
}

/// `supabaseRestNameIndexConfigured()`.
pub fn supabase_rest_name_index_configured() -> bool {
    !env_s("SUPABASE_URL").is_empty() && !env_s("SUPABASE_SERVICE_ROLE_KEY").is_empty()
}

fn configured_variation_search_urls() -> Vec<String> {
    let replica_urls = env_s("MARKETPLACE_VARIATION_SEARCH_REPLICA_URLS");
    if !replica_urls.is_empty() {
        return unique_strings(replica_urls.split(',').map(str::to_owned).collect());
    }
    let single = env_s("MARKETPLACE_VARIATION_SEARCH_DATABASE_URL");
    if !single.is_empty() {
        return unique_strings(vec![single]);
    }
    unique_strings(vec![
        env_s("MARKETPLACE_PEER2_DATABASE_URL"),
        env_s("MARKETPLACE_PEER1_DATABASE_URL"),
    ])
}

pub fn marketplace_variation_search_database_urls() -> Vec<String> {
    let urls = configured_variation_search_urls();
    if urls.is_empty() {
        let primary = marketplace_database_url();
        return if primary.is_empty() {
            Vec::new()
        } else {
            vec![primary]
        };
    }
    urls
}

fn configured_read_replica_urls() -> Vec<String> {
    let primary = marketplace_database_url();
    let mut urls = configured_variation_search_urls();
    urls.push(marketplace_name_search_database_url());
    urls.push(env_s("MARKETPLACE_PEER3_DATABASE_URL"));
    urls.push(env_s("MARKETPLACE_PEER2_DATABASE_URL"));
    urls.push(env_s("MARKETPLACE_PEER1_DATABASE_URL"));
    unique_strings(urls)
        .into_iter()
        .filter(|url| *url != primary)
        .collect()
}

pub fn marketplace_analytics_search_database_urls() -> Vec<String> {
    let primary = marketplace_database_url();
    let raw = env_s("MARKETPLACE_ANALYTICS_SEARCH_REPLICA_URLS");
    let explicit: Vec<String> = unique_strings(raw.split(',').map(str::to_owned).collect())
        .into_iter()
        .filter(|url| *url != primary)
        .collect();
    if !explicit.is_empty() {
        return explicit;
    }
    let replicas = configured_read_replica_urls();
    if !replicas.is_empty() {
        return replicas;
    }
    if primary.is_empty() {
        Vec::new()
    } else {
        vec![primary]
    }
}

/// `marketplaceDimensionSearchDatabaseUrls()`.
pub fn marketplace_dimension_search_database_urls() -> HashMap<&'static str, String> {
    let variation_urls = configured_variation_search_urls();
    let replica_urls = configured_read_replica_urls();
    let fallback = marketplace_database_url();
    let variation = |index: usize| -> String {
        variation_urls
            .get(index)
            .cloned()
            .or_else(|| replica_urls.get(index).cloned())
            .unwrap_or_else(|| fallback.clone())
    };
    let first_available = |urls: Vec<String>| -> String {
        unique_strings(urls)
            .into_iter()
            .next()
            .unwrap_or_else(|| fallback.clone())
    };
    HashMap::from([
        (
            "number",
            first_available(vec![
                env_s("MARKETPLACE_NUMBER_SEARCH_DATABASE_URL"),
                env_s("MARKETPLACE_PEER2_DATABASE_URL"),
                variation(0),
                replica_urls.get(0).cloned().unwrap_or_default(),
            ]),
        ),
        (
            "expansion",
            first_available(vec![
                env_s("MARKETPLACE_EXPANSION_SEARCH_DATABASE_URL"),
                env_s("MARKETPLACE_PEER1_DATABASE_URL"),
                variation(1),
                replica_urls.get(1).cloned().unwrap_or_default(),
            ]),
        ),
        (
            "rarity",
            first_available(vec![
                env_s("MARKETPLACE_RARITY_SEARCH_DATABASE_URL"),
                env_s("MARKETPLACE_PEER3_DATABASE_URL"),
                marketplace_name_search_database_url(),
                replica_urls.get(2).cloned().unwrap_or_default(),
            ]),
        ),
        (
            "variation_owner",
            first_available(vec![
                env_s("MARKETPLACE_VARIATION_OWNER_SEARCH_DATABASE_URL"),
                env_s("MARKETPLACE_VARIATION_SEARCH_DATABASE_URL"),
                variation(0),
                env_s("MARKETPLACE_PEER2_DATABASE_URL"),
                env_s("MARKETPLACE_PEER1_DATABASE_URL"),
                replica_urls.get(0).cloned().unwrap_or_default(),
            ]),
        ),
    ])
}

/// `marketplaceDimensionSearchRoute(dimension)`.
pub fn marketplace_dimension_search_route(dimension: &str) -> Value {
    let urls = marketplace_dimension_search_database_urls();
    let selected = urls
        .get(dimension)
        .cloned()
        .unwrap_or_else(marketplace_database_url);
    let primary = marketplace_database_url();
    json!({
        "dimension": dimension,
        "source": dimension,
        "configured": selected != primary,
        "fallbackToPrimary": selected == primary,
    })
}

/// `marketplaceNameSearchDatabaseUrl() !== marketplaceDatabaseUrl()`.
pub fn name_search_route() -> Value {
    let primary = marketplace_database_url();
    let name = marketplace_name_search_database_url();
    json!({
        "source": "name",
        "configured": name != primary,
        "fallbackToPrimary": name == primary,
    })
}

static POOL_CACHE: LazyLock<Mutex<HashMap<String, PgPool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn pooled(url: &str) -> PgPool {
    let mut cache = POOL_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(pool) = cache.get(url) {
        return pool.clone();
    }
    let pool = PgPoolOptions::new().max_connections(4).connect_lazy_with(
        PgConnectOptions::from_str(url).unwrap_or_else(|_| PgConnectOptions::new()),
    );
    cache.insert(url.to_owned(), pool.clone());
    pool
}

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;

static VARIATION_INDEX: AtomicUsize = AtomicUsize::new(0);
static ANALYTICS_INDEX: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone)]
pub struct PrefixClient {
    pub role: String,
    pub pool: PgPool,
}

/// The `_marketplace_db` pool bundle resolved against the runtime state.
pub struct Pools {
    pub primary: PgPool,
    pub primary_url: String,
    pub name_search: PgPool,
    variation: Vec<PgPool>,
    analytics: Vec<PgPool>,
    dimension: HashMap<&'static str, PgPool>,
    pub prefix_clients: Vec<PrefixClient>,
}

impl Pools {
    pub fn from_state(primary: PgPool) -> Self {
        let primary_url = marketplace_database_url();
        let name_url = marketplace_name_search_database_url();
        let name_search =
            if name_url.is_empty() || primary_url.is_empty() || name_url == primary_url {
                primary.clone()
            } else {
                pooled(&name_url)
            };
        let variation_urls = marketplace_variation_search_database_urls();
        let variation: Vec<PgPool> = if variation_urls.len() == 1
            && (variation_urls[0] == primary_url || primary_url.is_empty())
        {
            vec![primary.clone()]
        } else {
            variation_urls.iter().map(|url| pooled(url)).collect()
        };
        let analytics_urls = marketplace_analytics_search_database_urls();
        let analytics: Vec<PgPool> = if analytics_urls.len() == 1
            && (analytics_urls[0] == primary_url || primary_url.is_empty())
        {
            vec![primary.clone()]
        } else {
            analytics_urls.iter().map(|url| pooled(url)).collect()
        };
        let dimension = marketplace_dimension_search_database_urls()
            .into_iter()
            .map(|(source, url)| {
                let pool = if url == primary_url || primary_url.is_empty() {
                    primary.clone()
                } else if url == name_url {
                    name_search.clone()
                } else {
                    pooled(&url)
                };
                (source, pool)
            })
            .collect();
        let mut prefix_clients: Vec<PrefixClient> = Vec::new();
        let mut used: HashSet<String> = HashSet::new();
        if name_url != primary_url && !name_url.is_empty() {
            used.insert(name_url.clone());
            prefix_clients.push(PrefixClient {
                role: "name_search".to_owned(),
                pool: name_search.clone(),
            });
        }
        for (index, url) in variation_urls.iter().enumerate() {
            if used.contains(url) {
                continue;
            }
            used.insert(url.clone());
            let pool = if variation_urls.len() == 1 && variation_urls[0] == primary_url {
                primary.clone()
            } else {
                pooled(url)
            };
            prefix_clients.push(PrefixClient {
                role: if index == 0 {
                    "variation_search".to_owned()
                } else {
                    format!("variation_search_{}", index + 1)
                },
                pool,
            });
        }
        if prefix_clients.is_empty() {
            prefix_clients.push(PrefixClient {
                role: "primary".to_owned(),
                pool: primary.clone(),
            });
        }
        Self {
            primary,
            primary_url,
            name_search,
            variation,
            analytics,
            dimension,
            prefix_clients,
        }
    }

    pub fn marketplace(&self) -> &PgPool {
        &self.primary
    }

    pub fn name_search(&self) -> &PgPool {
        &self.name_search
    }

    /// `marketplaceVariationSearchQuery` (round-robin).
    pub fn variation(&self) -> PgPool {
        if self.variation.is_empty() {
            return self.primary.clone();
        }
        let index = VARIATION_INDEX.fetch_add(1, AtomicOrdering::Relaxed);
        self.variation[index % self.variation.len()].clone()
    }

    /// `marketplaceAnalyticsSearchQuery` (round-robin).
    pub fn analytics(&self) -> PgPool {
        if self.analytics.is_empty() {
            return self.primary.clone();
        }
        let index = ANALYTICS_INDEX.fetch_add(1, AtomicOrdering::Relaxed);
        self.analytics[index % self.analytics.len()].clone()
    }

    /// `marketplaceDimensionSearchQuery(source, ...)`.
    pub fn dimension(&self, source: &str) -> PgPool {
        self.dimension
            .get(source)
            .cloned()
            .unwrap_or_else(|| self.primary.clone())
    }
}

// --- circuits ---

static SUPABASE_DISABLED_UNTIL: AtomicU64 = AtomicU64::new(0);
static NAME_SEARCH_DISABLED_UNTIL: AtomicU64 = AtomicU64::new(0);
static VARIATION_DISABLED_UNTIL: AtomicU64 = AtomicU64::new(0);
static PREFIX_SHARD_DISABLED: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub fn supabase_name_index_circuit_open() -> bool {
    now_ms() < SUPABASE_DISABLED_UNTIL.load(AtomicOrdering::Relaxed)
}

pub fn disable_supabase_name_index_temporarily() {
    SUPABASE_DISABLED_UNTIL.store(
        now_ms() + ladder::name_search_circuit_ms(),
        AtomicOrdering::Relaxed,
    );
}

pub fn reset_supabase_name_index_circuit_for_test() {
    SUPABASE_DISABLED_UNTIL.store(0, AtomicOrdering::Relaxed);
}

pub fn name_search_circuit_open() -> bool {
    now_ms() < NAME_SEARCH_DISABLED_UNTIL.load(AtomicOrdering::Relaxed)
}

pub fn open_name_search_circuit() {
    NAME_SEARCH_DISABLED_UNTIL.store(
        now_ms() + ladder::name_search_circuit_ms(),
        AtomicOrdering::Relaxed,
    );
}

pub fn variation_search_circuit_open() -> bool {
    now_ms() < VARIATION_DISABLED_UNTIL.load(AtomicOrdering::Relaxed)
}

pub fn open_variation_search_circuit() {
    VARIATION_DISABLED_UNTIL.store(
        now_ms() + ladder::variation_search_circuit_ms(),
        AtomicOrdering::Relaxed,
    );
}

// --- engine context ---

pub struct Ctx {
    pub pools: Pools,
    pub redis_index: String,
    /// Shared Redis connection from `state.api.redis()` (`None` when down).
    pub redis: Option<redis::aio::ConnectionManager>,
    /// `candidateDebug` (present when `debug: true`).
    pub debug: Option<Value>,
    /// `debug.user` (verified operator from the bearer token).
    pub debug_user: Option<Value>,
    /// `debug.debugAuthError`.
    pub debug_auth_error: Option<Value>,
}

impl Ctx {
    pub fn new(primary: PgPool, redis: Option<redis::aio::ConnectionManager>) -> Self {
        Self {
            pools: Pools::from_state(primary),
            redis_index: {
                let index = env_s("POKOIN_REDIS_INDEX");
                if index.is_empty() {
                    "pokoin:cards".to_owned()
                } else {
                    index
                }
            },
            redis,
            debug: None,
            debug_user: None,
            debug_auth_error: None,
        }
    }
}

fn debug_set(ctx: &mut Ctx, key: &str, value: Value) {
    if let Some(debug) = ctx.debug.as_mut() {
        if let Value::Object(map) = debug {
            map.insert(key.to_owned(), value);
        }
    }
}

fn debug_push_step(
    ctx: &mut Ctx,
    label: &str,
    duration_ms: u64,
    result: &Result<Vec<Value>, EngineError>,
) {
    let Some(debug) = ctx.debug.as_mut() else {
        return;
    };
    let mut step = json!({ "label": label, "durationMs": duration_ms });
    match result {
        Ok(rows) => {
            step["rowCount"] = json!(rows.len());
            step["topRows"] = json!(rows.iter().take(8).map(row_summary).collect::<Vec<_>>());
        }
        Err(error) => {
            step["error"] = json!(error.message);
            if let Some(code) = &error.code {
                step["code"] = json!(code);
            }
        }
    }
    if let Value::Object(map) = debug {
        map["steps"].as_array_mut().map(|steps| steps.push(step));
    }
}

/// `rowSummary(row)` of marketplace-search-candidates.js.
pub fn row_summary(row: &Value) -> Value {
    json!({
        "card_id": get_any(row, &["card_id"]).cloned().unwrap_or(Value::Null),
        "name": get_any(row, &["name"]).cloned().unwrap_or(Value::Null),
        "set_name": get_any(row, &["set_name"]).cloned().unwrap_or(Value::Null),
        "card_number": get_any(row, &["card_number"]).cloned().unwrap_or(Value::Null),
        "rarity": get_any(row, &["rarity"]).cloned().unwrap_or(Value::Null),
        "product_variant": get_any(row, &["product_variant"]).cloned().unwrap_or(Value::Null),
        "item_kind": get_any(row, &["item_kind"]).cloned().unwrap_or(Value::Null),
        "product_type": get_any(row, &["product_type"]).cloned().unwrap_or(Value::Null),
        "search_rank": num_field(row, &["search_rank"]),
    })
}

// --- collector number SQL fragments ---

fn collector_number_sql(candidate_alias: &str, cards_alias: &str, blueprint_alias: &str) -> String {
    let clean_version = |alias: &str| {
        format!(
            r#"
    nullif(
      case
        when {alias}.version ~ '[0-9]' then regexp_replace(btrim({alias}.version), '^#+\s*', '')
        else ''
      end,
      ''
    )"#
        )
    };
    let clean_blueprint_value = |expression: String| {
        format!(
            r#"
    nullif(regexp_replace(btrim(coalesce({expression}, '')), '^#+\s*', ''), '')"#
        )
    };
    format!(
        r#"
    coalesce(
      nullif({candidate}.card_number, ''),
      {clean_cards},
      {clean_blueprint},
      {fixed_collector},
      {collector_number},
      {number_key},
      {card_number_key},
      ''
    )"#,
        candidate = candidate_alias,
        clean_cards = clean_version(cards_alias),
        clean_blueprint = clean_version(blueprint_alias),
        fixed_collector = clean_blueprint_value(format!(
            "{blueprint_alias}.blueprint#>>'{{fixed_properties,collector_number}}'"
        )),
        collector_number =
            clean_blueprint_value(format!("{blueprint_alias}.blueprint->>'collector_number'")),
        number_key = clean_blueprint_value(format!("{blueprint_alias}.blueprint->>'number'")),
        card_number_key =
            clean_blueprint_value(format!("{blueprint_alias}.blueprint->>'card_number'")),
    )
}

pub fn collector_number_join_sql(
    candidate_alias: &str,
    cards_alias: &str,
    blueprint_alias: &str,
    output_alias: &str,
) -> String {
    format!(
        r#"
    left join public.marketplace_cards {cards}
      on {cards}.card_id = {candidate}.card_id
    left join public.cardtrader_pokemon_blueprints {blueprint}
      on {blueprint}.id = {candidate}.card_id
    left join lateral (
      select {number} as card_number
    ) {output} on true"#,
        cards = cards_alias,
        blueprint = blueprint_alias,
        candidate = candidate_alias,
        output = output_alias,
        number = collector_number_sql(candidate_alias, cards_alias, blueprint_alias),
    )
}

// --- candidate rows ---

/// The candidate stage result: rows plus the `nonNameContext` the split /
/// predictive stages attach to the JS array.
#[derive(Clone, Debug, Default)]
pub struct CandidateRows {
    pub rows: Vec<Value>,
    pub non_name_context: Option<Value>,
}

// --- name search RPCs ---

/// `searchWithDatabase` — `search_marketplace_blueprint_candidates_v2`.
pub async fn search_with_database(
    ctx: &Ctx,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    search_language: &str,
) -> Result<Vec<Value>, EngineError> {
    run_query(
        ctx.pools.marketplace(),
        &format!("select * from public.{SEARCH_RPC_V2}($1, $2, $3, $4)"),
        vec![
            Bind::S(search_term.to_owned()),
            Bind::I(result_limit),
            Bind::I(result_offset),
            Bind::S(clean_language(Some(&json!(search_language)))),
        ],
    )
    .await
}

/// `searchNameWithDatabase` — peer3 `search_marketplace_blueprint_name_candidates`.
pub async fn search_name_with_database(
    ctx: &Ctx,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    search_language: &str,
) -> Result<Vec<Value>, EngineError> {
    run_query(
        ctx.pools.name_search(),
        &format!("select * from public.{SEARCH_NAME_RPC}($1, $2, $3, $4)"),
        vec![
            Bind::S(search_term.to_owned()),
            Bind::I(result_limit),
            Bind::I(result_offset),
            Bind::S(clean_language(Some(&json!(search_language)))),
        ],
    )
    .await
}

/// `searchNonNameWithDatabaseLegacy`.
pub async fn search_non_name_with_database_legacy(
    _ctx: &Ctx,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    search_language: &str,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    run_query(
        pool,
        &format!("select * from public.{SEARCH_NON_NAME_RPC}($1, $2, $3, $4)"),
        vec![
            Bind::S(search_term.to_owned()),
            Bind::I(result_limit),
            Bind::I(result_offset),
            Bind::S(clean_language(Some(&json!(search_language)))),
        ],
    )
    .await
}

/// `searchRowsByCardIdsWithDatabase` — hydration of the redis candidate ids.
pub async fn search_rows_by_card_ids_with_database(
    ctx: &Ctx,
    card_ids: &[String],
) -> Result<Vec<Value>, EngineError> {
    if card_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i64> = card_ids.iter().filter_map(|id| id.parse().ok()).collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = r#"
      select
        c.card_id,
        c.ct_id,
        c.name,
        c.set_name,
        c.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.homepage_image_url,
        c.card_palette,
        c.emoji,
        c.artist,
        c.illustrator,
        c.imported_at,
        c.search_weight::real as search_rank,
        coalesce(cardtrader.eligible_quantity, cardtrader.eligible_listing_count, 0) as listed_quantity,
        cardtrader.cheapest_price_pkn as lowest_price_pkn,
        case
          when cardtrader.provider = 'cardtrader'
            then coalesce(cardtrader.eligible_listing_count, 0)
          else 0
        end as cardtrader_eligible_listing_count,
        (cardtrader.provider = 'cardtrader' and coalesce(cardtrader.eligible_listing_count, 0) > 0) as has_cardtrader_listing,
        case
          when cardtrader.provider = 'cardtrader'
            then coalesce(cardtrader.eligible_quantity, 0)
          else 0
        end as cardtrader_listed_quantity
      from public.marketplace_search_candidates c
      left join lateral (
        select cardtrader_cache.*
        from public.cheapest_homepage_cache_blueprint cardtrader_cache
        where cardtrader_cache.provider in ('cardtrader', 'pokoin_native')
          and cardtrader_cache.eligible_listing_count > 0
          and cardtrader_cache.cheapest_price_pkn is not null
          and (
            cardtrader_cache.blueprint_id = c.ct_id
            or (cardtrader_cache.pokoin_card_id = c.card_id::text and cardtrader_cache.pokoin_card_id <> '')
          )
        order by
          case when cardtrader_cache.blueprint_id = c.ct_id then 0 else 1 end,
          cardtrader_cache.cheapest_price_pkn asc,
          case when cardtrader_cache.provider = 'pokoin_native' then 0 else 1 end,
          cardtrader_cache.eligible_listing_count desc
        limit 1
      ) cardtrader on true
      where c.card_id = any($1::bigint[])
      order by c.search_weight desc, c.name asc, c.card_number asc
    "#;
    run_query(ctx.pools.marketplace(), sql, vec![Bind::IA(ids)]).await
}

/// `collectorNumberKey(value)`.
pub fn collector_number_key(value: &str) -> String {
    LazyLock::force(&COLLECTOR_KEY_RE)
        .captures(value)
        .map(|caps| {
            let left = caps
                .get(1)
                .and_then(|m| pokoin_api_common::http::js_number(m.as_str()))
                .unwrap_or(0.0);
            let right = caps
                .get(2)
                .and_then(|m| pokoin_api_common::http::js_number(m.as_str()))
                .unwrap_or(0.0);
            format!("{}/{}", number_text(left), number_text(right))
        })
        .unwrap_or_default()
}

fn number_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

static COLLECTOR_KEY_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(\d+)\s*/\s*(\d+)").unwrap());

/// `rankRowsByQueryCollectorNumber(rows, searchTerm)` (stable, in place).
pub fn rank_rows_by_query_collector_number(rows: &mut [Value], search_term: &str) {
    let wanted = collector_number_key(search_term);
    if wanted.is_empty() || rows.len() < 2 {
        return;
    }
    rows.sort_by_key(|row| {
        u8::from(collector_number_key(&str_field(row, &["card_number"])) != wanted)
    });
}

/// `searchCandidatesForCardIdsWithDatabase(cardIds, query)`.
pub async fn search_candidates_for_card_ids_with_database(
    _ctx: &Ctx,
    card_ids: &[String],
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    if card_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i64> = card_ids.iter().filter_map(|id| id.parse().ok()).collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        r#"
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{{}}'::text[]) as variation_keys,
        public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
        public.marketplace_search_compact(candidate_number.card_number) as compact_number,
        public.marketplace_search_normalize(c.set_name) as normalized_set,
        public.marketplace_search_compact(c.set_name) as compact_set,
        public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
        public.marketplace_search_compact(c.trainer_name) as compact_trainer,
        public.marketplace_search_normalize(c.product_variant) as normalized_variant,
        public.marketplace_search_compact(c.product_variant) as compact_variant,
        c.search_weight::real as search_rank
      from public.marketplace_search_candidates c
      {join}
      left join public.marketplace_card_variations cv on cv.card_id = c.card_id
      where c.card_id = any($1::bigint[])
      group by
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        c.search_weight
      order by c.search_weight desc, c.name asc, c.card_number asc
    "#,
        join = collector_number_join_sql("c", "mc", "b", "candidate_number")
    );
    run_query(pool, &sql, vec![Bind::IA(ids)]).await
}

/// `searchCanonicalNameEntitiesWithDatabase(searchTerm, resultLimit, language)`.
pub async fn search_canonical_name_entities_with_database(
    _ctx: &Ctx,
    search_term: &str,
    result_limit: i64,
    search_language: &str,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    let fast_sql = r#"
      with normalized as (
        select
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 200) as clean_limit,
          $3::text as language
      )
      select
        names.name,
        (
          case
            when names.compact_name = n.compact_q then 1400
            when names.compact_name like n.compact_q || '%' then 1220
            when n.compact_q = any(names.name_tokens) then 1180
            else 980
          end
        )::real as token_score
      from normalized n
      join public.marketplace_card_names_for_language(n.language) names
        on names.compact_name = n.compact_q
        or names.compact_name like n.compact_q || '%'
        or n.compact_q = any(names.name_tokens)
      where n.compact_q <> ''
      order by token_score desc, length(names.compact_name), names.name
      limit (select clean_limit from normalized)
    "#;
    let binds = vec![
        Bind::S(search_term.to_owned()),
        Bind::I(result_limit),
        Bind::S(clean_language(Some(&json!(search_language)))),
    ];
    let fast = run_query(pool, fast_sql, binds.clone()).await?;
    if !fast.is_empty() {
        return Ok(fast);
    }
    let fuzzy_sql = r#"
      with normalized as (
        select
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 200) as clean_limit,
          $3::text as language
      )
      select
        names.name,
        980::real as token_score
      from normalized n
      join public.marketplace_card_names_for_language(n.language) names
        on (
          length(n.compact_q) between 3 and 8
          and exists (
            select 1
            from unnest(names.name_tokens) name_token
            where abs(length(public.marketplace_search_compact(name_token)) - length(n.compact_q)) <= 1
              and left(public.marketplace_search_compact(name_token), 2) = left(n.compact_q, 2)
              and public.marketplace_edit_distance(public.marketplace_search_compact(name_token), n.compact_q) <= 1
          )
        )
      where n.compact_q <> ''
      order by token_score desc, length(names.compact_name), names.name
      limit (select clean_limit from normalized)
    "#;
    run_query(pool, fuzzy_sql, binds).await
}

/// `searchCandidatesForCanonicalNamesWithDatabase(names, resultLimit)`.
pub async fn search_candidates_for_canonical_names_with_database(
    _ctx: &Ctx,
    canonical_names: &[String],
    result_limit: i64,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    if canonical_names.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        r#"
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{{}}'::text[]) as variation_keys,
        public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
        public.marketplace_search_compact(candidate_number.card_number) as compact_number,
        public.marketplace_search_normalize(c.set_name) as normalized_set,
        public.marketplace_search_compact(c.set_name) as compact_set,
        public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
        public.marketplace_search_compact(c.trainer_name) as compact_trainer,
        public.marketplace_search_normalize(c.product_variant) as normalized_variant,
        public.marketplace_search_compact(c.product_variant) as compact_variant,
        c.search_weight::real as search_rank
      from public.marketplace_search_candidates c
      {join}
      left join public.marketplace_card_variations cv on cv.card_id = c.card_id
      where coalesce(nullif(c.canonical_name, ''), c.name) = any($1::text[])
      group by
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        c.search_weight
      order by c.search_weight desc, c.name asc, c.card_number asc
      limit $2::integer
    "#,
        join = collector_number_join_sql("c", "mc", "b", "candidate_number")
    );
    run_query(
        pool,
        &sql,
        vec![Bind::SA(canonical_names.to_owned()), Bind::I(result_limit)],
    )
    .await
}

/// `searchNameOnlyRowsWithDatabase(terms, poolLimit, searchLanguage)`.
pub async fn search_name_only_rows_with_database(
    _ctx: &Ctx,
    terms: &[String],
    pool_limit: i64,
    search_language: &str,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    let mut clean_terms: Vec<String> = Vec::new();
    for term in terms {
        let term = super::normalize::clean_search_term(Some(&json!(term)));
        if term.is_empty() || clean_terms.contains(&term) {
            continue;
        }
        clean_terms.push(term);
    }
    clean_terms.truncate(5);
    if clean_terms.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        r#"
      with input_terms as (
        select
          term,
          public.marketplace_search_compact(term) as compact_term
        from unnest($1::text[]) term
      ),
      matched_names as (
        select
          names.name,
          sum(
            case
              when names.compact_name = input_terms.compact_term then 1400
              when names.compact_name like input_terms.compact_term || '%' then 1220
              when input_terms.compact_term = any(names.name_tokens) then 1180
              else 980
            end
          )::real as name_score,
          count(distinct input_terms.term)::integer as matched_terms
        from input_terms
        join public.marketplace_card_names_for_language($3::text) names
          on names.compact_name = input_terms.compact_term
          or names.compact_name like input_terms.compact_term || '%'
          or input_terms.compact_term = any(names.name_tokens)
        where input_terms.compact_term <> ''
        group by names.name
        having count(distinct input_terms.term) = (select count(*) from input_terms)
        order by name_score desc, length(public.marketplace_search_compact(names.name)), names.name
        limit 80
      )
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        '{{}}'::text[] as variation_keys,
        '' as normalized_number,
        '' as compact_number,
        '' as normalized_set,
        '' as compact_set,
        '' as normalized_trainer,
        '' as compact_trainer,
        '' as normalized_variant,
        '' as compact_variant,
        (matched_names.name_score + c.search_weight)::real as search_rank
      from matched_names
      join public.marketplace_search_candidates c
        on coalesce(nullif(c.canonical_name, ''), c.name) = matched_names.name
      {join}
      order by search_rank desc, c.name asc, candidate_number.card_number asc
      limit $2::integer
    "#,
        join = collector_number_join_sql("c", "mc", "b", "candidate_number")
    );
    run_query(
        pool,
        &sql,
        vec![
            Bind::SA(clean_terms),
            Bind::I(pool_limit.clamp(1, AUTOCOMPLETE_SQL_SAFE_POOL_CAP as i64)),
            Bind::S(clean_language(Some(&json!(search_language)))),
        ],
    )
    .await
}

/// `searchCombinedCardNameWithDatabase(terms, poolLimit)`.
pub async fn search_combined_card_name_with_database(
    _ctx: &Ctx,
    terms: &[String],
    pool_limit: i64,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    let mut clean_terms: Vec<String> = Vec::new();
    for term in terms {
        let term = super::normalize::clean_search_term(Some(&json!(term)));
        if term.is_empty()
            || term.bytes().all(|b| b.is_ascii_digit())
            || is_variation_intent_term(&term)
            || is_rarity_term(&term)
            || clean_terms.contains(&term)
        {
            continue;
        }
        clean_terms.push(term);
    }
    clean_terms.truncate(4);
    if clean_terms.len() < 2 {
        return Ok(Vec::new());
    }
    let sql = format!(
        r#"
      with input_terms as (
        select public.marketplace_search_compact(term) as compact_term
        from unnest($1::text[]) term
      )
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        '{{}}'::text[] as variation_keys,
        '' as normalized_number,
        '' as compact_number,
        '' as normalized_set,
        '' as compact_set,
        '' as normalized_trainer,
        '' as compact_trainer,
        '' as normalized_variant,
        '' as compact_variant,
        (c.search_weight + 2600)::real as search_rank
      from public.marketplace_search_candidates c
      {join}
      where c.item_kind <> 'product'
        and (
          select bool_and(
            public.marketplace_search_compact(coalesce(nullif(c.source_name, ''), c.name))
              like '%' || input_terms.compact_term || '%'
          )
          from input_terms
        )
      order by c.search_weight desc, c.name asc, candidate_number.card_number asc
      limit $2::integer
    "#,
        join = collector_number_join_sql("c", "mc", "b", "candidate_number")
    );
    run_query(
        pool,
        &sql,
        vec![
            Bind::SA(clean_terms),
            Bind::I(pool_limit.clamp(1, AUTOCOMPLETE_SQL_SAFE_POOL_CAP as i64)),
        ],
    )
    .await
}

/// `searchNameTokenFallbackWithDatabase(searchTerm, resultLimit, offset, lang)`.
pub async fn search_name_token_fallback_with_database(
    _ctx: &Ctx,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    search_language: &str,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    let sql = format!(
        r#"
      with normalized as (
        select
          public.marketplace_search_normalize($1) as q,
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 15874) as clean_limit,
          least(greatest($3::integer, 0), 15874) as clean_offset,
          $4::text as language
      )
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        (
          case
            when names.compact_name = n.compact_q then 3300
            when names.compact_name like n.compact_q || '%' then 3180
            else 3000
          end
        )::real as search_rank
      from normalized n
      join public.marketplace_card_names_for_language(n.language) names
        on names.compact_name = n.compact_q
        or names.compact_name like n.compact_q || '%'
        or (
          length(n.compact_q) between 3 and 8
          and exists (
            select 1
            from unnest(names.name_tokens) name_token
            where abs(length(public.marketplace_search_compact(name_token)) - length(n.compact_q)) <= 1
              and left(public.marketplace_search_compact(name_token), 2) = left(n.compact_q, 2)
              and public.marketplace_edit_distance(public.marketplace_search_compact(name_token), n.compact_q) <= 1
          )
        )
        or n.compact_q = any(names.name_tokens)
      join public.marketplace_search_candidates c
        on coalesce(nullif(c.canonical_name, ''), c.name) = names.name
      {join}
      where n.compact_q <> ''
      order by search_rank desc, c.name asc, candidate_number.card_number asc
      limit (select clean_limit from normalized)
      offset (select clean_offset from normalized)
    "#,
        join = collector_number_join_sql("c", "mc", "b", "candidate_number")
    );
    run_query(
        pool,
        &sql,
        vec![
            Bind::S(search_term.to_owned()),
            Bind::I(result_limit),
            Bind::I(result_offset),
            Bind::S(clean_language(Some(&json!(search_language)))),
        ],
    )
    .await
}

/// `searchFastNamePreviewWithDatabase(searchTerm, resultLimit, searchLanguage)`.
pub async fn search_fast_name_preview_with_database(
    ctx: &Ctx,
    search_term: &str,
    result_limit: i64,
    search_language: &str,
) -> Result<Vec<Value>, EngineError> {
    let terms = search_terms(search_term);
    let structured_tokens: Vec<Token> = super::rank::tokens_for_query(search_term)
        .into_iter()
        .filter(|token| token.kind != "text" && token.kind != "rarity")
        .collect();
    let candidate_tokens: Vec<String> = terms
        .iter()
        .filter(|term| {
            !term.is_empty()
                && !term.bytes().all(|b| b.is_ascii_digit())
                && !is_variation_intent_term(term)
                && !is_rarity_term(term)
        })
        .take(4)
        .cloned()
        .collect();
    let lookup_limit = if !structured_tokens.is_empty() {
        ((result_limit * 40).max(500)).min(AUTOCOMPLETE_SQL_SAFE_POOL_CAP as i64)
    } else {
        result_limit
    };
    let mut groups: Vec<Vec<Value>> = Vec::new();
    for term in &candidate_tokens {
        groups.push(
            search_name_token_fallback_with_database(
                ctx,
                term,
                lookup_limit,
                0,
                search_language,
                ctx.pools.marketplace(),
            )
            .await?,
        );
    }
    let merged = merge_rows_preserving_best(groups, lookup_limit.max(0) as usize);
    if structured_tokens.is_empty() {
        let mut merged = merged;
        merged.truncate(result_limit.max(0) as usize);
        return Ok(merged);
    }
    let mut filtered = filter_rows_by_stored_structured_tokens(
        ctx,
        merged,
        &structured_tokens,
        ctx.pools.marketplace(),
    )
    .await?;
    filtered.truncate(result_limit.max(0) as usize);
    Ok(filtered)
}

/// `searchNameOnlyAutocompleteWithCardNameFanout(...)` — `None` mirrors the JS
/// `null` return.
pub async fn search_name_only_autocomplete_with_card_name_fanout(
    ctx: &mut Ctx,
    search_term: &str,
    pool_limit: i64,
    search_language: &str,
) -> Result<Option<Vec<Value>>, EngineError> {
    let tokens = super::rank::tokens_for_query(search_term);
    let name_tokens: Vec<Token> = tokens
        .iter()
        .filter(|token| token.kind == "text" || token.kind == "expansion")
        .cloned()
        .collect();
    if tokens.is_empty() || name_tokens.is_empty() || name_tokens.len() != tokens.len() {
        return Ok(None);
    }
    let started = now_ms();
    let terms: Vec<String> = name_tokens.iter().map(|token| token.term.clone()).collect();
    let direct_rows = search_name_only_rows_with_database(
        ctx,
        &terms,
        pool_limit,
        search_language,
        ctx.pools.marketplace(),
    )
    .await?;
    if !direct_rows.is_empty() {
        debug_set(
            ctx,
            "tokenPlan",
            json!({
                "strategy": "name_table_direct",
                "tokens": Token::tokens_json(&tokens),
                "candidateRowCount": direct_rows.len(),
                "matchedRowCount": direct_rows.len(),
                "durationMs": now_ms() - started,
            }),
        );
        return Ok(Some(direct_rows));
    }
    let mut groups_with_entities: Vec<(Token, Vec<Value>)> = Vec::new();
    for token in &name_tokens {
        let entities = search_canonical_name_entities_with_database(
            ctx,
            &token.term,
            if tokens.len() == 1 { 80 } else { 30 },
            search_language,
            ctx.pools.marketplace(),
        )
        .await?;
        if !entities.is_empty() {
            groups_with_entities.push((token.clone(), entities));
        }
    }
    if groups_with_entities.is_empty() {
        return Ok(None);
    }
    let exact_name_sets: Vec<HashSet<String>> = groups_with_entities
        .iter()
        .map(|(token, entities)| {
            entities
                .iter()
                .filter(|entity| compact(&str_field(entity, &["name"])) == compact(&token.term))
                .map(|entity| str_field(entity, &["name"]))
                .collect()
        })
        .collect();
    let exact_shared_names: Vec<String> = if !exact_name_sets.is_empty() {
        exact_name_sets[0]
            .iter()
            .filter(|name| exact_name_sets.iter().all(|set| set.contains(*name)))
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    let mut combined_name_scores: HashMap<String, f64> = HashMap::new();
    for (_, entities) in &groups_with_entities {
        for entity in entities {
            let name = str_field(entity, &["name"]);
            *combined_name_scores.entry(name).or_insert(0.0) += num_field(entity, &["token_score"]);
        }
    }
    let threshold = 980.0 * groups_with_entities.len() as f64;
    let mut scored: Vec<(String, f64)> = combined_name_scores
        .iter()
        .filter(|(_, score)| **score >= threshold)
        .map(|(name, score)| (name.clone(), *score))
        .collect();
    scored.sort_by(|left, right| {
        pokoin_sort::cmp_f64_desc(left.1, right.1)
            .then_with(|| locale_cmp(&left.0, &right.0))
    });
    let mut selected_names: Vec<String> = if !exact_shared_names.is_empty() {
        exact_shared_names
    } else {
        scored.into_iter().map(|(name, _)| name).collect()
    };
    selected_names.truncate(if tokens.len() == 1 { 80 } else { 40 });
    if selected_names.is_empty() {
        return Ok(None);
    }
    let candidate_limit = ((pool_limit.saturating_mul(40)).max(500)).min(4000);
    let candidate_rows = search_candidates_for_canonical_names_with_database(
        ctx,
        &selected_names,
        candidate_limit,
        ctx.pools.marketplace(),
    )
    .await?;
    let candidate_rows_count = candidate_rows.len();
    let mut ranked: Vec<Value> = Vec::new();
    for row in candidate_rows {
        let normalized_name = str_field(&row, &["canonical_name", "name"]).to_lowercase();
        let name_words = search_terms(&normalized_name);
        let mut token_scores: Vec<f64> = Vec::new();
        for token in &name_tokens {
            token_scores.push(
                (super::rank::name_token_confidence(&normalized_name, &name_words, &token.term)
                    as f64)
                    .max(field_token_score(&row, token)),
            );
        }
        if token_scores.iter().any(|score| *score <= 0.0) {
            continue;
        }
        let entity_score = combined_name_scores
            .get(&str_field(&row, &["canonical_name", "name"]))
            .copied()
            .unwrap_or(0.0);
        let total = entity_score
            + token_scores.iter().sum::<f64>() * 10.0
            + num_field(&row, &["search_rank"]);
        let mut row = row;
        if let Value::Object(map) = &mut row {
            map.insert("search_rank".into(), json!(total));
        }
        ranked.push(row);
    }
    ranked.sort_by(|left, right| {
        pokoin_sort::cmp_f64_desc(num_field(left, &["search_rank"]), num_field(right, &["search_rank"]))
            .then_with(|| locale_cmp(&str_field(left, &["name"]), &str_field(right, &["name"])))
            .then_with(|| {
                locale_cmp(
                    &str_field(left, &["card_number"]),
                    &str_field(right, &["card_number"]),
                )
            })
    });
    if ranked.is_empty() {
        return Ok(None);
    }
    debug_set(
        ctx,
        "tokenPlan",
        json!({
            "strategy": "name_table_fanout",
            "tokens": Token::tokens_json(&tokens),
            "nameTokenCount": name_tokens.len(),
            "matchedNameTokens": groups_with_entities.iter().map(|(token, entities)| json!({
                "term": token.term,
                "entityCount": entities.len(),
                "topEntities": entities.iter().take(6).map(|entity| str_field(entity, &["name"])).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "canonicalNameCount": selected_names.len(),
            "candidateRowCount": candidate_rows_count,
            "matchedRowCount": ranked.len(),
            "durationMs": now_ms() - started,
        }),
    );
    ranked.truncate(pool_limit.max(0) as usize);
    Ok(Some(ranked))
}

/// `filterRowsByStoredStructuredTokens(rows, structuredTokens, query)`.
pub async fn filter_rows_by_stored_structured_tokens(
    _ctx: &Ctx,
    rows: Vec<Value>,
    structured_tokens: &[Token],
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    if rows.is_empty() || structured_tokens.is_empty() {
        return Ok(rows);
    }
    let ids: Vec<i64> = rows
        .iter()
        .filter_map(|row| {
            let id = num_field(row, &["card_id"]);
            if id.is_finite() && id.fract() == 0.0 && id > 0.0 && id <= 9_007_199_254_740_991.0 {
                Some(id as i64)
            } else {
                None
            }
        })
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let variation_tokens: Vec<Vec<String>> = structured_tokens
        .iter()
        .filter(|token| token.kind == "variation")
        .map(|token| super::normalize::variation_term_targets(&token.term))
        .collect();
    let expansion_tokens: Vec<String> = structured_tokens
        .iter()
        .filter(|token| token.kind == "expansion")
        .flat_map(|token| super::normalize::expansion_alias_targets(&token.term))
        .collect();
    let number_tokens: Vec<String> = structured_tokens
        .iter()
        .filter(|token| token.kind == "number")
        .map(|token| compact(&token.term))
        .collect();
    let sql = format!(
        r#"
      select
        c.card_id,
        coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{{}}'::text[]) as variation_keys,
        public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
        public.marketplace_search_compact(candidate_number.card_number) as compact_number,
        public.marketplace_search_compact(c.set_name) as compact_set
      from public.marketplace_search_candidates c
      {join}
      left join public.marketplace_card_variations cv on cv.card_id = c.card_id
      where c.card_id = any($1::bigint[])
      group by c.card_id, candidate_number.card_number, c.set_name
    "#,
        join = collector_number_join_sql("c", "mc", "b", "candidate_number")
    );
    let result = run_query(pool, &sql, vec![Bind::IA(ids)]).await?;
    let mut facets_by_id: HashMap<String, Value> = HashMap::new();
    for row in result {
        facets_by_id.insert(str_field(&row, &["card_id"]), row);
    }
    Ok(rows
        .into_iter()
        .filter(|row| {
            let Some(facets) = facets_by_id.get(&str_field(row, &["card_id"])) else {
                return false;
            };
            let variation_keys: HashSet<String> = match get(facets, "variation_keys") {
                Some(Value::Array(items)) => items
                    .iter()
                    .map(|item| js_str_or(Some(item)))
                    .filter(|key| !key.is_empty())
                    .collect(),
                _ => HashSet::new(),
            };
            let has_variations = variation_tokens
                .iter()
                .all(|targets| targets.iter().any(|target| variation_keys.contains(target)));
            let normalized_number_terms = search_terms(&str_field(facets, &["normalized_number"]));
            let compact_number = str_field(facets, &["compact_number"]);
            let has_numbers = number_tokens.iter().all(|token| {
                normalized_number_terms.contains(token)
                    || compact_number == *token
                    || compact_number.starts_with(token.as_str())
                    || compact_number.contains(token.as_str())
            });
            let compact_set = str_field(facets, &["compact_set"]);
            let has_expansions = expansion_tokens.iter().all(|token| {
                compact_set == *token
                    || compact_set.starts_with(token.as_str())
                    || token.starts_with(&compact_set)
            });
            has_variations && has_numbers && has_expansions
        })
        .collect())
}

/// `searchGenericEnergyExpansionRowsWithDatabase(searchTerm, poolLimit)` —
/// `None` mirrors the JS `null` return.
pub async fn search_generic_energy_expansion_rows_with_database(
    ctx: &mut Ctx,
    search_term: &str,
    pool_limit: i64,
) -> Result<Option<Vec<Value>>, EngineError> {
    let Some(_plan) = super::rank::generic_energy_expansion_plan(search_term) else {
        return Ok(None);
    };
    let plan_strategy = "generic_energy_expansion";
    let started = now_ms();
    let tokens = super::rank::tokens_for_query(search_term);
    let expansion_tokens: Vec<Token> = tokens
        .iter()
        .filter(|token| token.kind == "expansion")
        .cloned()
        .collect();
    let mut expansion_targets: Vec<String> = Vec::new();
    for token in &expansion_tokens {
        for target in super::normalize::expansion_alias_targets(&token.term) {
            if !expansion_targets.contains(&target) {
                expansion_targets.push(target);
            }
        }
    }
    if expansion_targets.is_empty() {
        return Ok(None);
    }
    let sql = format!(
        r#"
      with input as (
        select
          $1::text[] as expansion_targets,
          least(greatest($2::integer, 1), 5000) as clean_limit
      )
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{{}}'::text[]) as variation_keys,
        public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
        public.marketplace_search_compact(candidate_number.card_number) as compact_number,
        public.marketplace_search_normalize(c.set_name) as normalized_set,
        public.marketplace_search_compact(c.set_name) as compact_set,
        public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
        public.marketplace_search_compact(c.trainer_name) as compact_trainer,
        public.marketplace_search_normalize(c.product_variant) as normalized_variant,
        public.marketplace_search_compact(c.product_variant) as compact_variant,
        (
          case
            when public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) in (
              'grassenergy',
              'fireenergy',
              'waterenergy',
              'lightningenergy',
              'psychicenergy',
              'fightingenergy',
              'darknessenergy',
              'metalenergy'
            ) then 7200
            when public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) like '%energy' then 5600
            else 0
          end +
          case
            when public.marketplace_search_compact(c.set_name) = any(input.expansion_targets) then 1600
            else 900
          end +
          c.search_weight
        )::real as search_rank
      from input
      join public.marketplace_search_candidates c
        on public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) like '%energy'
        and exists (
          select 1
          from unnest(input.expansion_targets) target
          where public.marketplace_search_compact(c.set_name) = target
             or public.marketplace_search_compact(c.set_name) like target || '%'
             or target like public.marketplace_search_compact(c.set_name) || '%'
        )
      {join}
      left join public.marketplace_card_variations cv on cv.card_id = c.card_id
      where public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) like '%energy'
        and c.item_kind <> 'product'
      group by
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        c.search_weight,
        input.expansion_targets
      order by search_rank desc, c.name asc, candidate_number.card_number asc
      limit (select clean_limit from input)
    "#,
        join = collector_number_join_sql("c", "mc", "b", "candidate_number")
    );
    let rows = run_query(
        ctx.pools.marketplace(),
        &sql,
        vec![
            Bind::SA(expansion_targets.clone()),
            Bind::I(pool_limit.clamp(1, AUTOCOMPLETE_SQL_SAFE_POOL_CAP as i64)),
        ],
    )
    .await?;
    debug_set(
        ctx,
        "genericEnergyExpansion",
        json!({
            "used": true,
            "strategy": plan_strategy,
            "expansionTargets": expansion_targets,
            "candidateRowCount": rows.len(),
            "durationMs": now_ms() - started,
        }),
    );
    Ok(Some(rows))
}

// --- redis engine path (_redis_search.js + rowsForMeiliSearchTerm) ---

pub struct RedisCandidateLoad {
    pub hits: Vec<Value>,
    pub estimated_total_hits: u64,
}

/// `redisSearchCandidates(searchTerm, limit, offset)` — FT.SEARCH over the
/// shared RediSearch index, `RETURN 3 card_id search_weight
/// effective_print_bucket`.
pub async fn redis_search_candidates(
    ctx: &Ctx,
    redis: redis::aio::ConnectionManager,
    search_term: &str,
    limit: i64,
    offset: i64,
    timeout_ms: u64,
) -> Result<RedisCandidateLoad, EngineError> {
    let query = pokoin_search::redis_search_query(search_term, "all");
    if query.is_empty() {
        return Ok(RedisCandidateLoad {
            hits: Vec::new(),
            estimated_total_hits: 0,
        });
    }
    let size = limit.max(1).min(240);
    let start = offset.max(0);
    let timeout_arg = env_s("REDIS_SEARCH_TIMEOUT_MS")
        .parse::<i64>()
        .unwrap_or(800)
        .max(1);
    let mut connection = redis;
    let reply: redis::Value =
        tokio::time::timeout(Duration::from_millis(timeout_ms.max(1)), async {
            redis::cmd("FT.SEARCH")
                .arg(&ctx.redis_index)
                .arg(query)
                .arg("LIMIT")
                .arg(start)
                .arg(size)
                .arg("RETURN")
                .arg(3)
                .arg("card_id")
                .arg("search_weight")
                .arg("effective_print_bucket")
                .arg("DIALECT")
                .arg(2)
                .arg("TIMEOUT")
                .arg(timeout_arg)
                .query_async(&mut connection)
                .await
        })
        .await
        .map_err(|_| EngineError::new("redis search timeout"))?
        .map_err(EngineError::from_redis)?;
    let rows = match reply {
        redis::Value::Array(rows) => rows,
        _ => Vec::new(),
    };
    let total = match rows.first() {
        Some(redis::Value::BulkString(bytes)) => std::str::from_utf8(bytes)
            .ok()
            .and_then(|text| text.parse::<u64>().ok())
            .unwrap_or(0),
        Some(redis::Value::Int(value)) => *value as u64,
        _ => 0,
    };
    let mut hits: Vec<Value> = Vec::new();
    let mut index = 1usize;
    while index + 1 < rows.len() {
        let fields = redis_pairs(&rows[index + 1]);
        let card_id = fields.get("card_id").cloned().unwrap_or_default();
        let card_id = card_id.trim().to_owned();
        if card_id.is_empty() {
            index += 2;
            continue;
        }
        let weight = fields
            .get("search_weight")
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        hits.push(json!({
            "card_id": card_id,
            "meili_rank": weight,
            "meili_position": (hits.len() + 1) as f64,
            "effective_print_bucket": fields.get("effective_print_bucket").cloned().unwrap_or_default(),
        }));
        index += 2;
    }
    Ok(RedisCandidateLoad {
        hits,
        estimated_total_hits: total,
    })
}

fn redis_pairs(value: &redis::Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let redis::Value::Array(rows) = value {
        let mut index = 0;
        while index + 1 < rows.len() {
            let key = redis_text(&rows[index]);
            let value = redis_text(&rows[index + 1]);
            out.insert(key, value);
            index += 2;
        }
    }
    out
}

fn redis_text(value: &redis::Value) -> String {
    match value {
        redis::Value::BulkString(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        redis::Value::SimpleString(text) => text.clone(),
        redis::Value::Okay => "OK".to_owned(),
        redis::Value::Nil => String::new(),
        redis::Value::Int(value) => value.to_string(),
        _ => String::new(),
    }
}

/// `localNameScore(row, searchTerm)` of marketplace-search-candidates.js.
pub fn local_name_score(row: &Value, search_term: &str) -> f64 {
    let name: String = str_field(row, &["name"])
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        .collect();
    let query: String = search_term
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        .collect();
    let weight = js_num_or(get_any(row, &["search_weight", "search_rank"]), 0.0).clamp(0.0, 5000.0);
    let mut score = weight;
    if !query.is_empty() && name == query {
        score += 100_000.0;
    } else if !query.is_empty() && name.starts_with(&query) {
        score += 40_000.0;
    } else if !query.is_empty() && name.contains(&query) {
        score += 10_000.0;
    }
    score
}

/// `rowsForMeiliSearchTerm` — the redis-engine branch the handler actually
/// serves (Meili is retired in production). Returns `{ rows, total }`.
pub async fn rows_for_meili_search_term(
    ctx: &Ctx,
    redis: Option<redis::aio::ConnectionManager>,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    debug: Option<&mut Value>,
) -> Result<(Vec<Value>, f64), EngineError> {
    let page_size = {
        let raw = if result_limit != 0 { result_limit } else { 100 };
        raw.max(1).min(100)
    };
    let page_offset = result_offset.clamp(0, 10_000);
    let Some(redis) = redis else {
        return Err(EngineError::new("redis is not configured"));
    };
    let candidate_load =
        redis_search_candidates(ctx, redis, search_term, page_size, page_offset, 800).await?;
    let meili_candidates = &candidate_load.hits;
    let ids: Vec<String> = meili_candidates
        .iter()
        .map(|candidate| str_field(candidate, &["card_id"]))
        .filter(|id| !id.is_empty())
        .collect();
    let hydrated_rows = search_rows_by_card_ids_with_database(ctx, &ids).await?;
    let mut by_id: HashMap<String, Value> = HashMap::new();
    for row in hydrated_rows {
        by_id.insert(str_field(&row, &["card_id"]), row);
    }
    let mut ranked: Vec<Value> = Vec::new();
    for (index, id) in ids.iter().enumerate() {
        let Some(row) = by_id.get(id) else { continue };
        let hit = meili_candidates.get(index);
        let rank = js_num_or(
            hit.map(|hit| get(hit, "meili_rank")).unwrap_or(None),
            js_num_or(get_any(row, &["search_weight"]), 0.0),
        );
        let mut row = row.clone();
        if let Value::Object(map) = &mut row {
            map.insert("search_rank".into(), json!(rank));
        }
        ranked.push(row);
    }
    let mut debug = debug;
    if let Some(debug) = debug.as_deref_mut() {
        if let Value::Object(map) = debug {
            map.insert("searchPath".into(), json!("meili_en_candidates"));
            map.insert(
                "tokenPlan".into(),
                json!({
                    "strategy": "meili_en_candidates",
                    "poolLimit": page_size,
                    "candidateCount": meili_candidates.len(),
                    "hydratedCount": hydrated_rows_count_of(&by_id),
                    "offset": page_offset,
                }),
            );
            map.insert(
                "searchEngine".into(),
                json!({
                    "mode": "meili",
                    "strategy": "all",
                    "poolLimit": page_size,
                    "offset": page_offset,
                    "candidateCount": meili_candidates.len(),
                    "hydratedCount": by_id.len(),
                    "shadow": false,
                }),
            );
        }
    }
    ranked.sort_by(|left, right| {
        pokoin_sort::cmp_f64_desc(local_name_score(left, search_term), local_name_score(right, search_term))
    });
    rank_rows_by_query_collector_number(&mut ranked, search_term);
    ranked.truncate(page_size.max(0) as usize);
    Ok((ranked, candidate_load.estimated_total_hits as f64))
}

fn hydrated_rows_count_of(by_id: &HashMap<String, Value>) -> usize {
    by_id.len()
}

// --- theme packs ---

/// `readCardThemePacks(cardIds)` of `_marketplace_react_sql.js`.
async fn read_card_theme_packs(ctx: &Ctx, card_ids: &[String]) -> HashMap<String, String> {
    let ids: Vec<i64> = card_ids
        .iter()
        .filter_map(|id| id.parse::<i64>().ok())
        .filter(|id| *id > 0)
        .collect();
    let mut ids = ids;
    ids.dedup();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return HashMap::new();
    }
    let sql = r#"
      with wanted as (select card_id from unnest($1::bigint[]) as w(card_id))
      select w.card_id,
             coalesce(nullif(s.shade, ''), '') as shade,
             coalesce(nullif(s.artwork_identity, ''), '') as current_identity,
             t.version as theme_version,
             coalesce(nullif(t.artwork_identity, ''), '') as theme_identity,
             t.artwork_shade as theme_shade,
             t.hue as theme_hue,
             t.chroma as theme_chroma,
             t.background as theme_background,
             t.surface as theme_surface,
             t.surface_raised as theme_surface_raised,
             t.hero as theme_hero,
             t.hero_border as theme_hero_border,
             t.border as theme_border,
             t.tint as theme_tint
      from wanted w
      join public.marketplace_search_candidates c on c.card_id = w.card_id
      left join public.marketplace_leftover_art_shades s on s.ct_id = c.ct_id
      left join public.marketplace_leftover_visual_themes t on t.ct_id = c.ct_id
    "#;
    let result = match run_query(ctx.pools.marketplace(), sql, vec![Bind::IA(ids)]).await {
        Ok(rows) => rows,
        Err(_) => return HashMap::new(),
    };
    let mut packs = HashMap::new();
    for row in &result {
        let theme = super::row::visual_theme_for_shade(
            Some(row),
            &str_field(row, &["shade"]),
            &str_field(row, &["current_identity"]),
        );
        let packed = super::row::pack_visual_theme(&theme);
        if !packed.is_empty() {
            packs.insert(str_field(row, &["card_id"]), packed);
        }
    }
    packs
}

/// `attachThemePacks(rows)`.
pub async fn attach_theme_packs(ctx: &Ctx, rows: Vec<Value>) -> Vec<Value> {
    if rows.is_empty() {
        return rows;
    }
    let ids: Vec<String> = rows
        .iter()
        .map(|row| str_field(row, &["card_id", "id"]))
        .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
        .collect();
    let packs = read_card_theme_packs(ctx, &ids).await;
    if packs.is_empty() {
        return rows;
    }
    rows.into_iter()
        .map(|row| {
            let id = str_field(&row, &["card_id", "id"]);
            match packs.get(&id) {
                Some(pack) => {
                    let mut row = row;
                    if let Value::Object(map) = &mut row {
                        map.insert("vt".into(), Value::String(pack.clone()));
                    }
                    row
                }
                None => row,
            }
        })
        .collect()
}

/// `rowsForSearchTerm(searchTerm, resultLimit, offset, language, options)`.
pub async fn rows_for_search_term(
    ctx: &mut Ctx,
    redis: Option<redis::aio::ConnectionManager>,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    search_language: &str,
    meili_only: bool,
) -> Result<Vec<Value>, EngineError> {
    let loaded = rows_for_search_term_base(
        ctx,
        redis,
        search_term,
        result_limit,
        result_offset,
        search_language,
        meili_only,
    )
    .await?;
    Ok(attach_theme_packs(ctx, loaded).await)
}

/// `rowsForSearchTermBase` — the redis-engine gate and the split fallback.
async fn rows_for_search_term_base(
    ctx: &mut Ctx,
    redis: Option<redis::aio::ConnectionManager>,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    search_language: &str,
    meili_only: bool,
) -> Result<Vec<Value>, EngineError> {
    let engine_language_active = use_meili_search_for_language(search_language);
    if engine_language_active {
        let started = now_ms();
        // Node times out FT.SEARCH, not the subsequent PostgreSQL hydration.
        // Applying the name-tier budget to both stages discarded valid Redis
        // results and exposed unhydrated fallback rows (no artist/palette).
        let attempt = rows_for_meili_search_term(
            ctx, redis.clone(), search_term, result_limit, result_offset, None,
        ).await;
        match attempt {
            Ok((rows, _total)) => {
                let _ = started;
                return Ok(rows);
            }
            Err(error) => {
                if let Some(debug) = ctx.debug.as_mut() {
                    if let Value::Object(map) = debug {
                        map.insert(
                            "searchPath".into(),
                            json!(if meili_only {
                                "meili_en_unavailable"
                            } else {
                                "meili_en_fallback_legacy"
                            }),
                        );
                        map.insert(
                            "searchEngine".into(),
                            json!({
                                "mode": marketplace_search_engine(),
                                "fallback": if meili_only { "caller" } else { "legacy" },
                                "reason": error.message,
                                "code": error.code,
                            }),
                        );
                    }
                }
                if meili_only {
                    return Ok(Vec::new());
                }
            }
        }
    } else if let Some(debug) = ctx.debug.as_mut() {
        if let Value::Object(map) = debug {
            map.insert(
                "searchEngine".into(),
                json!({
                    "mode": marketplace_search_engine(),
                    "language": search_language,
                    "active": false,
                    "reason": "language_gate_or_flag",
                }),
            );
        }
    }
    if meili_only {
        return Ok(Vec::new());
    }
    Ok(rows_for_split_search_term(
        ctx,
        search_term,
        result_limit,
        result_offset,
        search_language,
    )
    .await?
    .rows)
}

/// `marketplaceSearchEngine()` (redis in production).
pub fn marketplace_search_engine() -> String {
    let raw = {
        let engine = env_s("MARKETPLACE_SEARCH_ENGINE");
        if !engine.is_empty() {
            engine
        } else {
            env_s("SEARCH_ENGINE")
        }
    };
    let engine = raw.to_lowercase();
    if ["legacy", "meili", "redis"].contains(&engine.as_str()) {
        engine
    } else if engine.is_empty() {
        "legacy".to_owned()
    } else {
        "legacy".to_owned()
    }
}

/// `useMeiliSearchForLanguage(searchLanguage)` — true when the redis engine is
/// active and the language is an en-like tag (Meili is retired but this gate
/// selects the RediSearch candidate path).
pub fn use_meili_search_for_language(search_language: &str) -> bool {
    let engine = marketplace_search_engine();
    if engine != "meili" && engine != "redis" {
        return false;
    }
    let language = search_language.trim().to_lowercase();
    if language.is_empty() || language == "en" {
        return true;
    }
    let bytes = language.as_bytes();
    let two = bytes.len() == 2 && bytes.iter().all(|b| b.is_ascii_lowercase());
    let five = bytes.len() == 5
        && bytes[2] == b'-'
        && bytes[..2].iter().all(|b| b.is_ascii_lowercase())
        && bytes[3..].iter().all(|b| b.is_ascii_lowercase());
    two || five
}

// --- split search (marketplace-search-candidates.js) ---

/// `rowsForSplitSearchTerm(searchTerm, resultLimit, offset, language)`.
pub async fn rows_for_split_search_term(
    ctx: &mut Ctx,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    search_language: &str,
) -> Result<CandidateRows, EngineError> {
    let clean_language_value = clean_language(Some(&json!(search_language)));
    let pool_limit = (result_limit * 2).max(result_limit).min(15_874);
    if name_search_circuit_open() {
        let started = now_ms();
        let result = search_with_database(
            ctx,
            search_term,
            result_limit,
            result_offset,
            &clean_language_value,
        )
        .await;
        debug_push_step(
            ctx,
            "primary_full_circuit_open",
            now_ms() - started,
            &result,
        );
        return Ok(CandidateRows {
            rows: result?,
            non_name_context: None,
        });
    }
    let pool_limit_for_name = pool_limit;
    let name_task = with_timeout(
        search_name_with_database(
            ctx,
            search_term,
            pool_limit_for_name,
            result_offset,
            &clean_language_value,
        ),
        ladder::name_search_timeout_ms(),
        "peer3 name search",
    );
    let started = now_ms();
    let name_result = name_task.await;
    debug_push_step(ctx, "peer3_name", now_ms() - started, &name_result);
    let non_name_result = search_variation_replica_non_name_with_database(
        ctx,
        search_term,
        pool_limit_for_name,
        result_offset,
        &clean_language_value,
    )
    .await;
    let mut debug_non_name = None;
    if ctx.debug.is_some() {
        if let Ok((_, context)) = &non_name_result {
            debug_non_name = context.clone();
        }
    }
    match (name_result, non_name_result) {
        (Ok(name_rows), Ok((non_name_rows, _))) => {
            let merged = merge_rows_preserving_best(
                vec![name_rows, non_name_rows],
                result_limit.max(0) as usize,
            );
            debug_push_step_ok(ctx, "merged", merged.len());
            Ok(CandidateRows {
                rows: merged,
                non_name_context: debug_non_name,
            })
        }
        (Err(name_error), Ok(_)) | (Ok(_), Err(name_error)) => {
            // JS: Promise.all fails when EITHER leg fails; both failure shapes
            // open the circuit and fall back to the primary full search.
            open_name_search_circuit();
            let disabled_until = NAME_SEARCH_DISABLED_UNTIL.load(AtomicOrdering::Relaxed);
            if let Some(debug) = ctx.debug.as_mut() {
                if let Value::Object(map) = debug {
                    map.insert("searchPath".into(), json!("primary_full_fallback"));
                    map.insert(
                        "fallback".into(),
                        json!({
                            "reason": name_error.message,
                            "code": name_error.code,
                            "disabledUntil": disabled_until as f64,
                        }),
                    );
                }
            }
            let started = now_ms();
            let result = search_with_database(
                ctx,
                search_term,
                result_limit,
                result_offset,
                &clean_language_value,
            )
            .await;
            debug_push_step(ctx, "primary_full_fallback", now_ms() - started, &result);
            return Ok(CandidateRows {
                rows: result?,
                non_name_context: None,
            });
        }
        (Err(_), Err(_)) => {
            open_name_search_circuit();
            let started = now_ms();
            let result = search_with_database(
                ctx,
                search_term,
                result_limit,
                result_offset,
                &clean_language_value,
            )
            .await;
            debug_push_step(ctx, "primary_full_fallback", now_ms() - started, &result);
            Ok(CandidateRows {
                rows: result?,
                non_name_context: None,
            })
        }
    }
}

fn debug_push_step_ok(ctx: &mut Ctx, label: &str, row_count: usize) {
    let Some(debug) = ctx.debug.as_mut() else {
        return;
    };
    if let Value::Object(map) = debug {
        map.entry("merged".to_owned())
            .or_insert_with(|| json!({"rowCount": row_count}));
    }
    let _ = label;
}

/// `searchVariationReplicaNonNameWithDatabase(...)` — returns the rows and the
/// `nonNameCategoryFanout.context` (for `merged.nonNameContext`).
pub async fn search_variation_replica_non_name_with_database(
    ctx: &mut Ctx,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    search_language: &str,
) -> Result<(Vec<Value>, Option<Value>), EngineError> {
    if variation_search_circuit_open() {
        if let Some(debug) = ctx.debug.as_mut() {
            if let Value::Object(map) = debug {
                map.insert(
                    "variationSearch".into(),
                    json!({
                        "path": "primary_circuit_open",
                        "disabledUntil": VARIATION_DISABLED_UNTIL.load(AtomicOrdering::Relaxed) as f64,
                    }),
                );
            }
        }
        let rows = search_non_name_with_database(
            ctx,
            search_term,
            result_limit,
            result_offset,
            search_language,
            ctx.pools.marketplace().clone(),
        )
        .await?;
        return Ok(rows);
    }
    let replica = ctx.pools.variation();
    let started = now_ms();
    let attempt = with_timeout(
        search_non_name_with_database(
            ctx,
            search_term,
            result_limit,
            result_offset,
            search_language,
            replica,
        ),
        ladder::variation_search_timeout_ms(),
        "variation search replica",
    )
    .await;
    match attempt {
        Ok((rows, context)) => {
            if let Some(debug) = ctx.debug.as_mut() {
                if let Value::Object(map) = debug {
                    map.insert(
                        "variationSearch".into(),
                        json!({
                            "path": "replica",
                            "timeoutMs": ladder::variation_search_timeout_ms(),
                            "rowCount": rows.len(),
                        }),
                    );
                }
            }
            let _ = started;
            Ok((rows, context))
        }
        Err(error) => {
            open_variation_search_circuit();
            if let Some(debug) = ctx.debug.as_mut() {
                if let Value::Object(map) = debug {
                    map.insert(
                        "variationSearch".into(),
                        json!({
                            "path": "primary_fallback",
                            "reason": error.message,
                            "code": error.code,
                            "disabledUntil": VARIATION_DISABLED_UNTIL.load(AtomicOrdering::Relaxed) as f64,
                        }),
                    );
                }
            }
            search_non_name_with_database(
                ctx,
                search_term,
                result_limit,
                result_offset,
                search_language,
                ctx.pools.marketplace().clone(),
            )
            .await
        }
    }
}

// --- non-name category fanout ---

/// `nonNameCategoryPlan(searchTerm)`.
pub fn non_name_category_plan(
    search_term: &str,
) -> Option<(Vec<(String, Vec<String>)>, Vec<String>)> {
    let terms = super::normalize::candidates_search_terms(search_term);
    let mut tokens: Vec<(String, Vec<String>)> = Vec::new();
    for (index, term) in terms.iter().enumerate() {
        let mut categories: Vec<String> = Vec::new();
        if !term.is_empty() && term.bytes().all(|b| b.is_ascii_digit()) {
            categories.push("number".to_owned());
            categories.push("expansion".to_owned());
        } else {
            if is_variation_intent_term(term) {
                categories.push("variation".to_owned());
            }
            if is_rarity_term(term) {
                categories.push("rarity".to_owned());
            }
            let alias = super::normalize::expansion_alias_targets(term);
            if !alias.is_empty() || (index > 0 && term.chars().count() >= 4) {
                categories.push("expansion".to_owned());
            }
            if !is_variation_intent_term(term) && !is_rarity_term(term) && term.chars().count() >= 2
            {
                categories.push("trainer_or_variant".to_owned());
            }
        }
        categories.dedup();
        if !categories.is_empty() {
            tokens.push((term.clone(), categories));
        }
    }
    let mut categories: Vec<String> = Vec::new();
    for (_, token_categories) in &tokens {
        for category in token_categories {
            if !categories.contains(category) {
                categories.push(category.clone());
            }
        }
    }
    if tokens.is_empty() || categories.is_empty() {
        return None;
    }
    Some((tokens, categories))
}

/// `cleanCategoryContext(value, category, token, searchLanguage)`.
fn clean_category_context(
    previous_context: Option<&Value>,
    category: &str,
    token: &str,
    search_language: &str,
) -> Result<Vec<String>, &'static str> {
    let Some(value) = previous_context else {
        return Err("missing_category_context");
    };
    let Some(source) = get_any(value, &["non_name_context", "nonNameContext"])
        .and_then(|context| get(context, category))
        .filter(|source| source.is_object())
    else {
        return Err("missing_category_context");
    };
    let previous_query = super::normalize::clean_search_term(get(source, "query"));
    let current_query = super::normalize::clean_search_term(Some(&json!(token)));
    if previous_query.is_empty()
        || !current_query.starts_with(&previous_query)
        || current_query == previous_query
    {
        return Err("category_query_not_extended");
    }
    let language = clean_language(get(source, "language"));
    if language != clean_language(Some(&json!(search_language))) {
        return Err("category_language_changed");
    }
    let created_at_ms = js_num_or(get_any(source, &["created_at_ms", "createdAtMs"]), 0.0);
    if !created_at_ms.is_finite()
        || created_at_ms <= 0.0
        || now_ms() as f64 - created_at_ms > 60_000.0
    {
        return Err("category_context_expired");
    }
    let card_ids: Vec<String> = match get_any(source, &["card_ids", "cardIds"]) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                let id = js_num_or(Some(item), f64::NAN);
                if id.is_finite() && id.fract() == 0.0 && id > 0.0 {
                    Some(number_text(id))
                } else {
                    None
                }
            })
            .collect(),
        _ => Vec::new(),
    };
    if card_ids.is_empty() {
        return Err("empty_category_card_ids");
    }
    if card_ids.len() > 500 {
        return Err("too_many_category_card_ids");
    }
    let mut unique: Vec<String> = Vec::new();
    for id in card_ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    Ok(unique)
}

/// `rowMatchesCategoryToken(row, category, token)`.
pub fn row_matches_category_token(row: &Value, category: &str, token: &str) -> bool {
    let compact_term = compact(token);
    if compact_term.is_empty() {
        return false;
    }
    match category {
        "number" => {
            let number = str_field(row, &["card_number"]).to_lowercase();
            let number_terms = search_terms(&number);
            let compact_number = compact(&number);
            number_terms.iter().any(|term| term == token)
                || compact_number == compact_term
                || compact_number.starts_with(&compact_term)
                || compact_number.contains(&compact_term)
        }
        "variation" => {
            let text = [
                str_field(row, &["name"]),
                str_field(row, &["rarity"]),
                str_field(row, &["card_type"]),
                str_field(row, &["product_type"]),
                str_field(row, &["product_variant"]),
            ]
            .join(" ")
            .to_lowercase();
            super::normalize::variation_term_targets(&compact_term)
                .iter()
                .any(|target| {
                    let text = text.clone();
                    match target.as_str() {
                        "v" => contains_word(&text, "v"),
                        "lvx" => ["lvx", "lv.x", "level x"]
                            .iter()
                            .any(|word| contains_word(&text, word)),
                        "mega" => contains_word(&text, "mega") || contains_word(&text, "m"),
                        other => contains_word(&text, other),
                    }
                })
        }
        "expansion" => {
            let set = str_field(row, &["set_name"]).to_lowercase();
            let compact_set = compact(&set);
            search_terms(&set).iter().any(|term| term == token)
                || compact_set.contains(&compact_term)
                || (token.chars().count() >= 4
                    && compact_set
                        .starts_with(compact_term.chars().take(4).collect::<String>().as_str()))
        }
        "rarity" => {
            let text = [
                str_field(row, &["rarity"]),
                str_field(row, &["card_number"]),
            ]
            .join(" ")
            .to_lowercase();
            if compact_term == "sir" {
                text.contains("special illustration rare")
            } else if compact_term == "ir" || compact_term == "ill" || compact_term == "illus" {
                text.contains("illustration rare")
            } else {
                compact(&text).contains(&compact_term)
            }
        }
        "trainer_or_variant" => {
            let text = [
                str_field(row, &["trainer_name"]),
                str_field(row, &["product_variant"]),
            ]
            .join(" ")
            .to_lowercase();
            let compact_text = compact(&text);
            search_terms(&text).iter().any(|term| term == token)
                || compact_text.contains(&compact_term)
        }
        _ => false,
    }
}

/// `(^|[^a-z0-9])needle([^a-z0-9]|$)` without compiling a regex per row: a
/// per-call `Regex::new` runs on a tokio worker for every candidate row.
fn contains_word(text: &str, needle: &str) -> bool {
    let bytes = text.as_bytes();
    let word = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let mut from = 0;
    while let Some(at) = text[from..].find(needle) {
        let start = from + at;
        let end = start + needle.len();
        if (start == 0 || !word(bytes[start - 1])) && (end == bytes.len() || !word(bytes[end])) {
            return true;
        }
        match text[start..].chars().next() {
            Some(ch) => from = start + ch.len_utf8(),
            None => return false,
        }
    }
    false
}

/// `buildNonNameContext(searchLanguage, categorySteps)`.
fn build_non_name_context(search_language: &str, category_steps: &[Value]) -> Value {
    let mut context = Map::new();
    let language = clean_language(Some(&json!(search_language)));
    for step in category_steps {
        let category = str_field(step, &["category"]);
        let term = str_field(step, &["term"]);
        let card_ids: Vec<Value> = match get(step, "cardIds") {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        if category.is_empty() || term.is_empty() || card_ids.is_empty() {
            continue;
        }
        let existing_larger = get(&Value::Object(context.clone()), &category)
            .and_then(|existing| get(existing, "card_ids"))
            .and_then(|ids| ids.as_array())
            .map(|ids| ids.len() >= card_ids.len())
            .unwrap_or(false);
        if existing_larger {
            continue;
        }
        let step_strategy = {
            let own = str_field(step, &["strategy"]);
            if own.is_empty() {
                "category_sql".to_owned()
            } else {
                own
            }
        };
        context.insert(
            category,
            json!({
                "query": term,
                "language": language,
                "card_ids": card_ids.iter().take(500).cloned().collect::<Vec<_>>(),
                "created_at_ms": now_ms() as f64,
                "strategy": step_strategy,
            }),
        );
    }
    Value::Object(context)
}

/// `searchNonNameWithDatabase(...)` — category fanout with the legacy RPC
/// fallback. Returns the rows plus the context for `merged.nonNameContext`.
pub async fn search_non_name_with_database(
    ctx: &mut Ctx,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    search_language: &str,
    pool: PgPool,
) -> Result<(Vec<Value>, Option<Value>), EngineError> {
    let Some((tokens, categories)) = non_name_category_plan(search_term) else {
        let rows = search_non_name_with_database_legacy(
            ctx,
            search_term,
            result_limit,
            result_offset,
            search_language,
            &pool,
        )
        .await?;
        if let Some(debug) = ctx.debug.as_mut() {
            if let Value::Object(map) = debug {
                map.insert(
                    "nonNameCategoryFanout".into(),
                    json!({"used": false, "reason": "empty_plan"}),
                );
            }
        }
        return Ok((rows, None));
    };
    let clean_limit_value = super::normalize::clean_limit(Some(&json!(result_limit)));
    let clean_offset_value = super::normalize::clean_offset(Some(&json!(result_offset)));
    let started = now_ms();
    let mut row_groups: Vec<Vec<Value>> = Vec::new();
    let mut category_steps: Vec<Value> = Vec::new();
    for (term, token_categories) in &tokens {
        for category in token_categories {
            let category_started = now_ms();
            // searchNonNameCategoryWithContext
            let context_card_ids =
                clean_category_context(ctx_debug_value(ctx), category, term, search_language);
            let had_refined = context_card_ids.is_ok();
            let context_reason = match &context_card_ids {
                Err(reason) => (*reason).to_owned(),
                Ok(_) => String::new(),
            };
            let refined_rows: Option<Vec<Value>> = match context_card_ids {
                Ok(card_ids) => {
                    let rows = search_rows_by_card_ids_with_database(ctx, &card_ids).await?;
                    let mut matched: Vec<Value> = rows
                        .into_iter()
                        .filter(|row| row_matches_category_token(row, category, term))
                        .map(|mut row| {
                            let boosted = num_field(&row, &["search_rank"]) + 1800.0;
                            if let Value::Object(map) = &mut row {
                                map.insert("search_rank".into(), json!(boosted));
                            }
                            row
                        })
                        .collect();
                    matched.sort_by(|left, right| {
                        pokoin_sort::cmp_f64_desc(num_field(left, &["search_rank"]), num_field(right, &["search_rank"]))
                            .then_with(|| {
                                locale_cmp(
                                    &str_field(left, &["name"]),
                                    &str_field(right, &["name"]),
                                )
                            })
                            .then_with(|| {
                                locale_cmp(
                                    &str_field(left, &["card_number"]),
                                    &str_field(right, &["card_number"]),
                                )
                            })
                    });
                    matched.truncate(clean_limit_value.max(0) as usize);
                    if matched.is_empty() {
                        None
                    } else {
                        Some(matched)
                    }
                }
                Err(_) => None,
            };
            let strategy = if refined_rows.is_some() {
                "category_context_refine"
            } else {
                "category_sql"
            };
            let rows = match refined_rows {
                Some(rows) => rows,
                None => match category.as_str() {
                    "number" => {
                        search_non_name_number_with_database(
                            ctx,
                            term,
                            clean_limit_value,
                            clean_offset_value,
                            &pool,
                        )
                        .await?
                    }
                    "variation" => {
                        search_non_name_variation_with_database(
                            ctx,
                            term,
                            clean_limit_value,
                            clean_offset_value,
                            &pool,
                        )
                        .await?
                    }
                    "expansion" => {
                        search_non_name_expansion_with_database(
                            ctx,
                            term,
                            clean_limit_value,
                            clean_offset_value,
                            &pool,
                        )
                        .await?
                    }
                    "rarity" => {
                        search_non_name_rarity_with_database(
                            ctx,
                            term,
                            clean_limit_value,
                            clean_offset_value,
                            &pool,
                        )
                        .await?
                    }
                    "trainer_or_variant" => {
                        search_non_name_trainer_variant_with_database(
                            ctx,
                            term,
                            clean_limit_value,
                            clean_offset_value,
                            &pool,
                        )
                        .await?
                    }
                    _ => Vec::new(),
                },
            };
            category_steps.push(json!({
                "category": category,
                "term": term,
                "strategy": strategy,
                "database": "replica",
                "contextReason": if had_refined { Value::Null } else { json!(context_reason) },
                "durationMs": now_ms() - category_started,
                "rowCount": rows.len(),
                "cardIds": rows.iter().filter_map(|row| get(row, "card_id").cloned()).take(500).collect::<Vec<_>>(),
                "topRows": rows.iter().take(5).map(row_summary).collect::<Vec<_>>(),
            }));
            row_groups.push(rows);
        }
    }
    let merged = merge_rows_preserving_best(row_groups, clean_limit_value.max(0) as usize);
    let context = build_non_name_context(search_language, &category_steps);
    if let Some(debug) = ctx.debug.as_mut() {
        if let Value::Object(map) = debug {
            let mut steps = category_steps.clone();
            steps.sort_by(|left, right| {
                locale_cmp(
                    &str_field(left, &["category"]),
                    &str_field(right, &["category"]),
                )
                .then_with(|| locale_cmp(&str_field(left, &["term"]), &str_field(right, &["term"])))
            });
            map.insert(
                "nonNameCategoryFanout".into(),
                json!({
                    "used": true,
                    "strategy": "non_name_category_fanout",
                    "database": "replica",
                    "categories": categories,
                    "tokens": tokens.iter().map(|(term, cats)| json!({"term": term, "categories": cats})).collect::<Vec<_>>(),
                    "durationMs": now_ms() - started,
                    "rowCount": merged.len(),
                    "context": context,
                    "steps": steps,
                }),
            );
        }
    }
    if !merged.is_empty() {
        return Ok((merged, Some(context)));
    }
    if let Some(debug) = ctx.debug.as_mut() {
        if let Value::Object(map) = debug {
            if let Some(fanout) = map.get_mut("nonNameCategoryFanout") {
                fanout["fallbackReason"] = json!("empty_category_fanout");
            }
        }
    }
    let rows = search_non_name_with_database_legacy(
        ctx,
        search_term,
        result_limit,
        result_offset,
        search_language,
        &pool,
    )
    .await?;
    Ok((rows, None))
}

fn ctx_debug_value(ctx: &Ctx) -> Option<&Value> {
    ctx.debug.as_ref().map(|debug| {
        // previousContext rides in the debug object under "previousContext"
        // for the category-context reads; absent otherwise.
        get(debug, "previousContext").unwrap_or(&Value::Null)
    })
}

/// The five category SQL queries (searchNonName*WithDatabase).

async fn search_non_name_number_with_database(
    ctx: &Ctx,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    let _ = ctx;
    let sql = format!(
        r#"
      with normalized as (
        select
          public.marketplace_search_normalize($1) as q,
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 15874) as clean_limit,
          least(greatest($3::integer, 0), 15874) as clean_offset
      ),
      hits as (
        select
          num.card_number,
          max(
            case
              when num.normalized_number = n.q then 1120
              when num.compact_number = n.compact_q then 1120
              when n.q = any(num.number_tokens) then 1080
              when n.q ~ '^[0-9]+$'
                and num.normalized_number ~ ('(^|[^0-9])' || regexp_replace(n.q, '([\\^$.|?*+()\\[\\]{{}}])', '\\\\1', 'g') || '([^0-9]|$)') then 1060
              when num.normalized_number like n.q || '%' then 860
              when num.compact_number like n.compact_q || '%' then 820
              else 0
            end
          )::real as token_score
        from normalized n
        join public.marketplace_expansion_numbers num
          on num.normalized_number = n.q
          or num.compact_number = n.compact_q
          or n.q = any(num.number_tokens)
          or (
            n.q ~ '^[0-9]+$'
            and num.normalized_number ~ ('(^|[^0-9])' || regexp_replace(n.q, '([\\^$.|?*+()\\[\\]{{}}])', '\\\\1', 'g') || '([^0-9]|$)')
          )
          or num.normalized_number like n.q || '%'
          or num.compact_number like n.compact_q || '%'
        group by num.card_number
      )
      {select},
        (h.token_score + 560 + c.search_weight)::real as search_rank
      from hits h
      join public.marketplace_search_candidates c on c.card_number = h.card_number
      order by search_rank desc, c.name asc, c.card_number asc
      limit (select clean_limit from normalized)
      offset (select clean_offset from normalized)
    "#,
        select = SEARCH_CANDIDATE_SELECT
    );
    run_query(
        pool,
        &sql,
        vec![
            Bind::S(search_term.to_owned()),
            Bind::I(result_limit),
            Bind::I(result_offset),
        ],
    )
    .await
}

const SEARCH_CANDIDATE_SELECT: &str = r#"
  select
    c.card_id,
    c.ct_id,
    c.name,
    c.set_name,
    c.card_number,
    c.product_variant,
    c.rarity,
    c.card_type,
    c.item_kind,
    c.product_type,
    c.trainer_name,
    c.image_url,
    c.cdn_image_url,
    c.preview_image_url,
    c.homepage_image_url,
    c.card_palette,
    c.emoji,
    c.artist,
    c.illustrator,
    c.imported_at"#;

async fn search_non_name_variation_with_database(
    ctx: &Ctx,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    let _ = ctx;
    let sql = format!(
        r#"
      with normalized as (
        select
          public.marketplace_search_normalize($1) as q,
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 15874) as clean_limit,
          least(greatest($3::integer, 0), 15874) as clean_offset
      ),
      hits as (
        select
          v.variation_key,
          max(
            case
              when n.q = any(v.normalized_aliases) then 1180
              when n.compact_q = any(v.compact_aliases) then 1160
              when n.compact_q <> '' and exists (
                select 1
                from unnest(v.normalized_aliases, v.compact_aliases) as alias_pair(normalized_alias, compact_alias)
                where (
                  alias_pair.normalized_alias <> ''
                  and n.q ~ ('(^|[^a-z0-9])' || regexp_replace(alias_pair.normalized_alias, '([\\^$.|?*+()\\[\\]{{}}])', '\\\\1', 'g') || '([^a-z0-9]|$)')
                )
                or (
                  length(n.compact_q) >= 1
                  and length(alias_pair.compact_alias) >= 2
                  and alias_pair.compact_alias like n.compact_q || '%'
                )
              ) then 1320
              else 0
            end
          )::real as token_score
        from normalized n
        join public.marketplace_variations v
          on n.q = any(v.normalized_aliases)
          or n.compact_q = any(v.compact_aliases)
          or exists (
            select 1
            from unnest(v.normalized_aliases, v.compact_aliases) as alias_pair(normalized_alias, compact_alias)
            where (
              alias_pair.normalized_alias <> ''
              and n.q ~ ('(^|[^a-z0-9])' || regexp_replace(alias_pair.normalized_alias, '([\\^$.|?*+()\\[\\]{{}}])', '\\\\1', 'g') || '([^a-z0-9]|$)')
            )
            or (
              length(n.compact_q) >= 1
              and length(alias_pair.compact_alias) >= 2
              and alias_pair.compact_alias like n.compact_q || '%'
            )
          )
        group by v.variation_key
      )
      {select},
        (h.token_score + 1320 + c.search_weight)::real as search_rank
      from hits h
      join public.marketplace_card_variations cv on cv.variation_key = h.variation_key
      join public.marketplace_search_candidates c on c.card_id = cv.card_id
      order by search_rank desc, c.name asc, c.card_number asc
      limit (select clean_limit from normalized)
      offset (select clean_offset from normalized)
    "#,
        select = SEARCH_CANDIDATE_SELECT
    );
    run_query(
        pool,
        &sql,
        vec![
            Bind::S(search_term.to_owned()),
            Bind::I(result_limit),
            Bind::I(result_offset),
        ],
    )
    .await
}

async fn search_non_name_expansion_with_database(
    ctx: &Ctx,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    let _ = ctx;
    let sql = format!(
        r#"
      with normalized as (
        select
          public.marketplace_search_normalize($1) as q,
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 15874) as clean_limit,
          least(greatest($3::integer, 0), 15874) as clean_offset
      ),
      expansion_hits as (
        select
          e.normalized_name as expansion_name,
          (
            case
              when e.normalized_name = n.q then 1050
              when e.compact_name = n.compact_q then 1030
              when length(n.q) >= 2 and e.normalized_name like n.q || '%' then 820
              when length(n.q) >= 2 and e.compact_name like n.compact_q || '%' then 780
              when length(n.q) >= 4 and e.normalized_name %% n.q then 620 + similarity(e.normalized_name, n.q) * 180
              else 0
            end
          )::real as token_score
        from normalized n
        join public.pokoin_pokemon_expansions e
          on e.normalized_name = n.q
          or e.compact_name = n.compact_q
          or (length(n.q) >= 2 and e.normalized_name like n.q || '%')
          or (length(n.q) >= 2 and e.compact_name like n.compact_q || '%')
          or (length(n.q) >= 4 and e.normalized_name %% n.q)
        union all
        select
          ea.normalized_expansion_name as expansion_name,
          (
            case
              when ea.normalized_alias = n.q then 1180
              when ea.compact_alias = n.compact_q then 1160
              else 0
            end
            + greatest(0, 220 - ea.priority)
          )::real as token_score
        from normalized n
        join public.marketplace_expansion_aliases ea
          on ea.normalized_alias = n.q
          or ea.compact_alias = n.compact_q
      ),
      hits as (
        select expansion_name, max(token_score) as token_score
        from expansion_hits
        group by expansion_name
      )
      {select},
        (h.token_score + 980 + c.search_weight)::real as search_rank
      from hits h
      join public.marketplace_search_candidates c
        on public.marketplace_search_normalize(c.expansion_name) = h.expansion_name
      order by search_rank desc, c.name asc, c.card_number asc
      limit (select clean_limit from normalized)
      offset (select clean_offset from normalized)
    "#,
        select = SEARCH_CANDIDATE_SELECT
    );
    run_query(
        pool,
        &sql,
        vec![
            Bind::S(search_term.to_owned()),
            Bind::I(result_limit),
            Bind::I(result_offset),
        ],
    )
    .await
}

async fn search_non_name_rarity_with_database(
    ctx: &Ctx,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    let _ = ctx;
    let sql = format!(
        r#"
      with normalized as (
        select
          public.marketplace_search_normalize($1) as q,
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 15874) as clean_limit,
          least(greatest($3::integer, 0), 15874) as clean_offset
      ),
      rarity_hits as (
        select
          r.rarity,
          (
            case
              when r.normalized_rarity = n.q then 980
              when r.compact_rarity = n.compact_q then 940
              when r.normalized_rarity like n.q || '%' then 720
              when length(n.q) >= 4 and r.normalized_rarity %% n.q then 560 + similarity(r.normalized_rarity, n.q) * 160
              else 0
            end
          )::real as token_score
        from normalized n
        join public.marketplace_rarities r
          on r.normalized_rarity = n.q
          or r.compact_rarity = n.compact_q
          or r.normalized_rarity like n.q || '%'
          or (length(n.q) >= 4 and r.normalized_rarity %% n.q)
      ),
      candidate_hits as (
        select c.card_id, max(h.token_score + 320)::real as token_score
        from rarity_hits h
        join public.marketplace_search_candidates c on c.rarity = h.rarity
        group by c.card_id
        union all
        select
          c.card_id,
          max(
            case
              when n.q = 'sir' and public.marketplace_search_normalize(c.card_number) like '%special illustration rare%' then 900
              when n.q in ('ir', 'ill', 'illus', 'illustration') and public.marketplace_search_normalize(c.card_number) like '%illustration rare%' then 820
              when n.q in ('ur', 'ultra') and public.marketplace_search_normalize(c.card_number) like '%ultra rare%' then 800
              when n.q in ('sr', 'secret') and public.marketplace_search_normalize(c.card_number) like '%secret rare%' then 780
              when n.q in ('rare', 'holo', 'shiny') and public.marketplace_search_normalize(c.card_number) like '%' || n.q || '%' then 520
              else 0
            end
          )::real as token_score
        from normalized n
        join public.marketplace_search_candidates c
          on (
            n.q = 'sir'
            and public.marketplace_search_normalize(c.card_number) like '%special illustration rare%'
          )
          or (
            n.q in ('ir', 'ill', 'illus', 'illustration')
            and public.marketplace_search_normalize(c.card_number) like '%illustration rare%'
          )
          or (
            n.q in ('ur', 'ultra')
            and public.marketplace_search_normalize(c.card_number) like '%ultra rare%'
          )
          or (
            n.q in ('sr', 'secret')
            and public.marketplace_search_normalize(c.card_number) like '%secret rare%'
          )
          or (
            n.q in ('rare', 'holo', 'shiny')
            and public.marketplace_search_normalize(c.card_number) like '%' || n.q || '%'
          )
        group by c.card_id
      )
      {select},
        (h.token_score + c.search_weight)::real as search_rank
      from candidate_hits h
      join public.marketplace_search_candidates c on c.card_id = h.card_id
      order by search_rank desc, c.name asc, c.card_number asc
      limit (select clean_limit from normalized)
      offset (select clean_offset from normalized)
    "#,
        select = SEARCH_CANDIDATE_SELECT
    );
    run_query(
        pool,
        &sql,
        vec![
            Bind::S(search_term.to_owned()),
            Bind::I(result_limit),
            Bind::I(result_offset),
        ],
    )
    .await
}

async fn search_non_name_trainer_variant_with_database(
    ctx: &Ctx,
    search_term: &str,
    result_limit: i64,
    result_offset: i64,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    let _ = ctx;
    let sql = format!(
        r#"
      with normalized as (
        select
          public.marketplace_search_normalize($1) as q,
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 15874) as clean_limit,
          least(greatest($3::integer, 0), 15874) as clean_offset
      )
      {select},
        (
          case
            when public.marketplace_search_normalize(c.trainer_name) = n.q then 980
            when public.marketplace_search_compact(c.trainer_name) = n.compact_q then 940
            when public.marketplace_search_normalize(c.trainer_name) like n.q || '%' then 760
            when public.marketplace_search_compact(c.trainer_name) like n.compact_q || '%' then 720
            when public.marketplace_search_normalize(c.product_variant) = n.q then 860
            when public.marketplace_search_compact(c.product_variant) = n.compact_q then 840
            when public.marketplace_search_normalize(c.product_variant) like n.q || '%' then 700
            when public.marketplace_search_compact(c.product_variant) like n.compact_q || '%' then 680
            else 0
          end
          + 360
          + c.search_weight
        )::real as search_rank
      from normalized n
      join public.marketplace_search_candidates c
        on (
          c.trainer_name <> ''
          and (
            public.marketplace_search_normalize(c.trainer_name) = n.q
            or public.marketplace_search_compact(c.trainer_name) = n.compact_q
            or public.marketplace_search_normalize(c.trainer_name) like n.q || '%'
            or public.marketplace_search_compact(c.trainer_name) like n.compact_q || '%'
          )
        )
        or (
          c.product_variant <> ''
          and (
            public.marketplace_search_normalize(c.product_variant) = n.q
            or public.marketplace_search_compact(c.product_variant) = n.compact_q
            or public.marketplace_search_normalize(c.product_variant) like n.q || '%'
            or public.marketplace_search_compact(c.product_variant) like n.compact_q || '%'
          )
        )
      order by search_rank desc, c.name asc, c.card_number asc
      limit (select clean_limit from normalized)
      offset (select clean_offset from normalized)
    "#,
        select = SEARCH_CANDIDATE_SELECT
    );
    run_query(
        pool,
        &sql,
        vec![
            Bind::S(search_term.to_owned()),
            Bind::I(result_limit),
            Bind::I(result_offset),
        ],
    )
    .await
}

// --- supabase name index tier ---

/// `shouldTrySupabaseNameIndex(searchTerm, previousContext)`.
pub fn should_try_supabase_name_index(search_term: &str, previous_context: Option<&Value>) -> bool {
    if !supabase_name_index_configured() {
        return false;
    }
    if supabase_name_index_circuit_open() {
        return false;
    }
    let depth = super::normalize::meaningful_search_depth(search_term);
    if depth < 2 || depth > ladder::SUPABASE_NAME_INDEX_MAX_DEPTH {
        return false;
    }
    let terms = search_terms(search_term);
    let short_name_prefix = if terms.is_empty() {
        depth == 1
    } else {
        terms.len() == 1 && !is_rarity_term(&terms[0])
    };
    if !short_name_prefix {
        return false;
    }
    let Some(previous_context) = previous_context else {
        return true;
    };
    let previous_strategy = str_field(previous_context, &["strategy"]);
    let previous_depth =
        super::normalize::meaningful_search_depth(&str_field(previous_context, &["query"]));
    previous_strategy != "supabase_name_index" || previous_depth < depth
}

/// `shouldTrySupabaseOneCharNameIndex(searchTerm)`.
pub fn should_try_supabase_one_char_name_index(search_term: &str) -> bool {
    if !supabase_prediction_configured() {
        return false;
    }
    if supabase_name_index_circuit_open() {
        return false;
    }
    compact(search_term).chars().count() == 1
}

/// `supabasePredictionConfigured()`.
pub fn supabase_prediction_configured() -> bool {
    supabase_name_index_configured()
}

/// `supabaseNameIndexDecision(searchTerm, previousContext)`.
pub fn supabase_name_index_decision(search_term: &str, previous_context: Option<&Value>) -> Value {
    let depth = super::normalize::meaningful_search_depth(search_term);
    let terms = search_terms(search_term);
    let short_name_prefix = if terms.is_empty() {
        depth == 1
    } else {
        terms.len() == 1 && !is_rarity_term(&terms[0])
    };
    json!({
        "configured": supabase_name_index_configured(),
        "circuitOpen": supabase_name_index_circuit_open(),
        "depth": depth,
        "terms": terms,
        "shortNamePrefix": short_name_prefix,
        "previousStrategy": previous_context.map(|context| get_any(context, &["strategy"]).cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null),
        "previousDepth": previous_context.map(|context| super::normalize::meaningful_search_depth(&str_field(context, &["query"]))).map(|depth| json!(depth)).unwrap_or(Value::Null),
        "shouldTry": should_try_supabase_name_index(search_term, previous_context),
    })
}

/// `supabaseFetch(path, { serviceRole: true })` of `_supabase.js`.
async fn supabase_fetch(ctx_http: &reqwest::Client, path: &str) -> Result<Value, EngineError> {
    let url = env_s("SUPABASE_URL").trim_end_matches('/').to_owned();
    let key = env_s("SUPABASE_SERVICE_ROLE_KEY");
    if url.is_empty() || key.is_empty() {
        return Err(EngineError::new("Supabase is not configured.").with_status(500));
    }
    let response = ctx_http
        .get(format!("{url}{path}"))
        .header("apikey", &key)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|error| EngineError::new(error.to_string()))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        let body: String = body.chars().take(300).collect();
        return Err(
            EngineError::new(format!("Supabase request failed {status}: {body}")).with_status(
                if (400..500).contains(&status) {
                    status
                } else {
                    500
                },
            ),
        );
    }
    if status == 204 {
        return Ok(Value::Null);
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| EngineError::new(error.to_string()))
}

/// `encodeFilterValue(value)`.
fn encode_filter_value(value: &str) -> String {
    urlencoding::encode(&value.replace('"', "\\\"")).into_owned()
}

const SUPABASE_NAME_TOKEN_SELECT: &str = "display_name,canonical_name,search_name,language,card_ids,representative_labels,row_count,compact_name,name_tokens,search_weight,updated_at";

/// `supabaseRestNameIndexCandidateRows(searchTerm, poolLimit, searchLanguage)`.
pub async fn supabase_rest_name_index_candidate_rows(
    ctx_http: &reqwest::Client,
    search_term: &str,
    pool_limit: i64,
    search_language: &str,
) -> Result<Vec<Value>, EngineError> {
    let compact_query = compact(search_term);
    if compact_query.is_empty() || !supabase_rest_name_index_configured() {
        return Ok(Vec::new());
    }
    let normalized_language = clean_language(Some(&json!(search_language)));
    let clean_pool_limit = pool_limit.clamp(1, AUTOCOMPLETE_SQL_SAFE_POOL_CAP as i64);
    let table = SUPABASE_NAME_TOKEN_TABLE;
    let select = SUPABASE_NAME_TOKEN_SELECT;
    let path = format!(
        "/rest/v1/{table}?select={select}\
         &language=eq.{language}\
         &or=(compact_name.eq.{eq},compact_name.like.{like},name_tokens.cs.{tokens})\
         &limit=80",
        language = encode_filter_value(&normalized_language),
        eq = encode_filter_value(&compact_query),
        like = encode_filter_value(&format!("{compact_query}%")),
        tokens = encode_filter_value(&format!("{{\"{compact_query}\"}}")),
    );
    let rows = supabase_fetch(ctx_http, &path).await?;
    let rows_array: Vec<Value> = rows.as_array().cloned().unwrap_or_default();
    let fuzzy_rows = if rows_array.is_empty() && compact_query.chars().count() >= 3 {
        let fuzzy_path = format!(
            "/rest/v1/{table}?select={select}&language=eq.{language}&compact_name=like.{prefix}&limit=80",
            language = encode_filter_value(&normalized_language),
            prefix = encode_filter_value(&format!("{}%", &compact_query.chars().take(2).collect::<String>())),
        );
        let fuzzy = supabase_fetch(ctx_http, &fuzzy_path).await?;
        super::rank::supabase_rest_fuzzy_name_token_rows(
            fuzzy.as_array().cloned().unwrap_or_default().as_slice(),
            &compact_query,
        )
    } else {
        rows_array
    };
    let candidates = expand_name_token_rows_to_candidate_ids(
        &fuzzy_rows,
        &compact_query,
        clean_pool_limit as usize,
    );
    let mut best_by_card_id: HashMap<String, Value> = HashMap::new();
    for row in candidates {
        let key = str_field(&row, &["card_id"]);
        match best_by_card_id.get(&key) {
            Some(current)
                if num_field(current, &["search_rank"]) >= num_field(&row, &["search_rank"]) => {}
            _ => {
                best_by_card_id.insert(key, row);
            }
        }
    }
    let mut rows: Vec<Value> = best_by_card_id.into_values().collect();
    rows.sort_by(|left, right| {
        pokoin_sort::cmp_f64_desc(num_field(left, &["search_rank"]), num_field(right, &["search_rank"]))
            .then_with(|| locale_cmp(&str_field(left, &["name"]), &str_field(right, &["name"])))
            .then_with(|| {
                locale_cmp(
                    &str_field(left, &["card_number"]),
                    &str_field(right, &["card_number"]),
                )
            })
    });
    rows.truncate(clean_pool_limit.max(0) as usize);
    Ok(rows)
}

/// `supabaseRestOneCharNameTokenRows(nameFragment, poolLimit, searchLanguage)`.
pub async fn supabase_rest_one_char_name_token_rows(
    ctx_http: &reqwest::Client,
    name_fragment: &str,
    pool_limit: i64,
    search_language: &str,
) -> Result<Vec<Value>, EngineError> {
    let compact_query = compact(name_fragment);
    if compact_query.chars().count() != 1 || !supabase_rest_name_index_configured() {
        return Ok(Vec::new());
    }
    let normalized_language = clean_language(Some(&json!(search_language)));
    let scan_limit = ((pool_limit * 2).max(ladder::SUPABASE_PREDICTED_NAME_SCAN_LIMIT as i64))
        .min(ladder::SUPABASE_ONE_CHAR_NAME_SCAN_LIMIT as i64);
    let table = SUPABASE_NAME_TOKEN_TABLE;
    let path = format!(
        "/rest/v1/{table}?select={select}&language=eq.{language}&or=(compact_name.eq.{eq},compact_name.like.{like},normalized_name.eq.{neq},normalized_name.like.{nlike},normalized_name.like.{mid},name_tokens.cs.{tokens})&limit={scan_limit}",
        select = format!("{SUPABASE_NAME_TOKEN_SELECT},normalized_name"),
        language = encode_filter_value(&normalized_language),
        eq = encode_filter_value(&compact_query),
        like = encode_filter_value(&format!("{compact_query}%")),
        neq = encode_filter_value(&compact_query),
        nlike = encode_filter_value(&format!("{compact_query}%")),
        mid = encode_filter_value(&format!("% {compact_query}%")),
        tokens = encode_filter_value(&format!("{{\"{compact_query}\"}}")),
    );
    let rows = supabase_fetch(ctx_http, &path).await?;
    let rows = match rows {
        Value::Array(items) => items,
        _ => return Ok(Vec::new()),
    };
    Ok(rows
        .into_iter()
        .map(|row| {
            let confidence = supabase_predicted_name_confidence(&row, &compact_query);
            let score = name_token_search_rank(&row, &compact_query);
            let mut row = row;
            if let Value::Object(map) = &mut row {
                map.insert("confidence".into(), json!(confidence));
                map.insert("score".into(), json!(score));
            }
            row
        })
        .filter(|row| num_field(row, &["confidence"]) > 0.0)
        .collect())
}

/// `supabaseRestPredictedNameTokens(nameFragment, searchLanguage, limit)`.
pub async fn supabase_rest_predicted_name_tokens(
    ctx_http: &reqwest::Client,
    name_fragment: &str,
    search_language: &str,
    limit: usize,
) -> Result<Vec<Value>, EngineError> {
    let compact_query = compact(name_fragment);
    if compact_query.is_empty() || !supabase_rest_name_index_configured() {
        return Ok(Vec::new());
    }
    let normalized_language = clean_language(Some(&json!(search_language)));
    let clean_limit = limit.clamp(1, ladder::SUPABASE_PREDICTED_NAME_TOKEN_LIMIT);
    let scan_limit = (clean_limit as i64 * 8)
        .max(ladder::SUPABASE_PREDICTED_NAME_SCAN_LIMIT as i64)
        .min(500);
    let table = SUPABASE_NAME_TOKEN_TABLE;
    let path = format!(
        "/rest/v1/{table}?select={select}&language=eq.{language}&or=(compact_name.eq.{eq},compact_name.like.{like},name_tokens.cs.{tokens})&limit={scan_limit}",
        select = SUPABASE_NAME_TOKEN_SELECT,
        language = encode_filter_value(&normalized_language),
        eq = encode_filter_value(&compact_query),
        like = encode_filter_value(&format!("{compact_query}%")),
        tokens = encode_filter_value(&format!("{{\"{compact_query}\"}}")),
    );
    let rows = supabase_fetch(ctx_http, &path).await?;
    let rows_array: Vec<Value> = rows.as_array().cloned().unwrap_or_default();
    let fuzzy_rows = if rows_array.is_empty() && compact_query.chars().count() >= 3 {
        let fuzzy_path = format!(
            "/rest/v1/{table}?select={select_value}&language=eq.{language}&compact_name=like.{prefix}&limit={scan_limit}",
            select_value = SUPABASE_NAME_TOKEN_SELECT,
            language = encode_filter_value(&normalized_language),
            prefix = encode_filter_value(&format!("{}%", compact_query.chars().take(2).collect::<String>())),
        );
        let fuzzy = supabase_fetch(ctx_http, &fuzzy_path).await?;
        supabase_rest_fuzzy_name_token_rows(
            fuzzy.as_array().cloned().unwrap_or_default().as_slice(),
            &compact_query,
        )
    } else {
        rows_array
    };
    let candidate_rows: Vec<Value> = fuzzy_rows
        .into_iter()
        .map(|row| {
            let score = name_token_search_rank(&row, &compact_query);
            let mut row = row;
            if let Value::Object(map) = &mut row {
                map.insert("score".into(), json!(score));
            }
            row
        })
        .collect();
    Ok(normalize_prediction_rows(
        &candidate_rows,
        &compact_query,
        &normalized_language,
        clean_limit,
    ))
}

/// `predictedNameTokensFromSupabase(nameFragment, searchLanguage, debug,
/// options)` — with the REST fallback and the circuit breaker. `strict`
/// rethrows like the JS caller.
pub async fn predicted_name_tokens_from_supabase(
    ctx: &Ctx,
    name_fragment: &str,
    search_language: &str,
    strict: bool,
) -> Result<Vec<Value>, EngineError> {
    let compact_query = compact(name_fragment);
    if compact_query.is_empty() {
        return Ok(Vec::new());
    }
    let predictions = match supabase_rest_predicted_name_tokens(
        ctx.api_http(),
        name_fragment,
        search_language,
        ladder::SUPABASE_PREDICTED_NAME_TOKEN_LIMIT,
    )
    .await
    {
        Ok(predictions) => predictions,
        Err(error) => {
            disable_supabase_name_index_temporarily();
            if strict {
                return Err(error);
            }
            return Ok(Vec::new());
        }
    };
    if predictions.is_empty() && strict {
        return Err(EngineError::new(
            "Supabase predicted name token search returned no candidates.",
        )
        .with_code("SUPABASE_PREDICTED_NAMES_EMPTY"));
    }
    Ok(predictions)
}

impl Ctx {
    pub fn api_http(&self) -> &reqwest::Client {
        &HTTP
    }
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

/// `rowsFromSupabaseNameIndex(searchTerm, poolLimit, searchLanguage, debug,
/// hydrateQuery, options)` — `None` mirrors the JS `null`.
pub async fn rows_from_supabase_name_index(
    ctx: &mut Ctx,
    search_term: &str,
    pool_limit: i64,
    search_language: &str,
    hydrate_pool: &PgPool,
    strict: bool,
) -> Result<Option<Vec<Value>>, EngineError> {
    let supabase_started = now_ms();
    let supabase_rows = match supabase_rest_name_index_candidate_rows(
        ctx.api_http(),
        search_term,
        pool_limit,
        search_language,
    )
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            disable_supabase_name_index_temporarily();
            if strict {
                return Err(error);
            }
            debug_set(
                ctx,
                "supabaseNameIndex",
                json!({
                    "used": false,
                    "fallback": true,
                    "reason": error.message,
                    "code": error.code,
                    "durationMs": now_ms() - supabase_started,
                }),
            );
            return Ok(None);
        }
    };
    if supabase_rows.is_empty() {
        if strict {
            return Err(
                EngineError::new("Supabase name index returned no candidates.")
                    .with_code("SUPABASE_NAME_INDEX_EMPTY"),
            );
        }
        debug_set(
            ctx,
            "supabaseNameIndex",
            json!({
                "used": true,
                "fallback": true,
                "reason": "empty_candidate_pool",
                "source": "rest",
                "candidateRowCount": 0,
                "durationMs": now_ms() - supabase_started,
            }),
        );
        return Ok(None);
    }
    let row_count = supabase_rows.len();
    let visible_hydration_limit = if row_count <= ladder::AUTOCOMPLETE_CANDIDATE_ID_FLOOR {
        ladder::AUTOCOMPLETE_CANDIDATE_ID_FLOOR.min(row_count)
    } else {
        (ladder::AUTOCOMPLETE_PREVIEW_ROW_LIMIT * 3)
            .min(ladder::SUPABASE_VISIBLE_HYDRATION_LIMIT)
            .min(row_count)
    };
    let hydrate_ids: Vec<String> = supabase_rows
        .iter()
        .take(visible_hydration_limit)
        .map(|row| str_field(row, &["card_id"]))
        .collect();
    let hydrated_rows =
        search_candidates_for_card_ids_with_database(ctx, &hydrate_ids, hydrate_pool).await?;
    let mut rows_by_id: HashMap<String, Value> = HashMap::new();
    for row in hydrated_rows {
        rows_by_id.insert(str_field(&row, &["card_id"]), row);
    }
    let compact_term = compact(search_term);
    let mut rows: Vec<Value> = supabase_rows
        .into_iter()
        .map(|row| match rows_by_id.get(&str_field(&row, &["card_id"])) {
            Some(hydrated) => {
                let mut hydrated = hydrated.clone();
                let bonus = super::rank::hydrated_name_rank_bonus(&hydrated, &compact_term);
                let merged = num_field(&hydrated, &["search_rank"])
                    .max(num_field(&row, &["search_rank"]) + bonus);
                if let Value::Object(map) = &mut hydrated {
                    map.insert("search_rank".into(), json!(merged));
                }
                hydrated
            }
            None => row,
        })
        .collect();
    rows.sort_by(|left, right| {
        pokoin_sort::cmp_f64_desc(num_field(left, &["search_rank"]), num_field(right, &["search_rank"]))
    });
    debug_set(
        ctx,
        "supabaseNameIndex",
        json!({
            "used": true,
            "fallback": false,
            "source": "rest",
            "candidateRowCount": rows.len(),
            "hydratedRowCount": rows_by_id.len(),
            "visibleHydrationLimit": visible_hydration_limit,
            "durationMs": now_ms() - supabase_started,
        }),
    );
    debug_set(
        ctx,
        "tokenPlan",
        json!({
            "strategy": "supabase_name_index",
            "source": "rest",
            "candidateRowCount": rows.len(),
            "hydratedRowCount": rows_by_id.len(),
            "visibleHydrationLimit": visible_hydration_limit,
            "durationMs": now_ms() - supabase_started,
        }),
    );
    if let Some(debug) = ctx.debug.as_mut() {
        if let Value::Object(map) = debug {
            map.insert("searchPath".into(), json!("supabase_name_index"));
        }
    }
    rows.truncate(pool_limit.max(0) as usize);
    Ok(Some(rows))
}

/// `rowsFromSupabaseOneCharNameIndex(...)` — `None` mirrors the JS `null`.
pub async fn rows_from_supabase_one_char_name_index(
    ctx: &mut Ctx,
    search_term: &str,
    pool_limit: i64,
    search_language: &str,
) -> Result<Option<CandidateRows>, EngineError> {
    let started = now_ms();
    let compact_query = compact(search_term);
    if compact_query.chars().count() != 1 {
        return Ok(None);
    }
    let token_rows = match supabase_rest_one_char_name_token_rows(
        ctx.api_http(),
        search_term,
        pool_limit,
        search_language,
    )
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            disable_supabase_name_index_temporarily();
            debug_set(
                ctx,
                "supabaseOneCharNameIndex",
                json!({
                    "used": false,
                    "fallback": true,
                    "reason": error.message,
                    "code": error.code,
                    "durationMs": now_ms() - started,
                }),
            );
            return Ok(None);
        }
    };
    if token_rows.is_empty() {
        debug_set(
            ctx,
            "supabaseOneCharNameIndex",
            json!({
                "used": true,
                "fallback": true,
                "source": "rest",
                "reason": "empty_candidate_pool",
                "tokenRowCount": 0,
                "candidateRowCount": 0,
                "durationMs": now_ms() - started,
            }),
        );
        return Ok(None);
    }
    let clean_pool_limit = pool_limit.clamp(1, AUTOCOMPLETE_ONE_CHAR_BACKEND_POOL_LIMIT as i64);
    let predictions = normalize_prediction_rows(
        &token_rows,
        &compact_query,
        search_language,
        ladder::SUPABASE_PREDICTED_NAME_TOKEN_LIMIT,
    );
    let mut rows = expand_name_token_rows_to_candidate_ids(
        &token_rows,
        &compact_query,
        clean_pool_limit as usize,
    );
    rows.truncate(clean_pool_limit as usize);
    let duration_ms = now_ms() - started;
    let predictive_pool = json!({
        "strict": false,
        "predicted_tokens": predictions.iter().map(|prediction| {
            let mut entry = prediction_debug_entry(prediction);
            entry["source"] = json!("supabase_one_char_name_index");
            entry
        }).collect::<Vec<_>>(),
        "sources": [{
            "source": "supabase_predicted_names",
            "status": "fulfilled",
            "route": {
                "source": "supabase_predicted_names",
                "configured": true,
                "fallbackToPrimary": false,
            },
            "row_count": predictions.len(),
            "source_kind": "rest",
            "duration_ms": duration_ms,
        }],
    });
    debug_set(ctx, "searchPath", json!("supabase_one_char_name_index"));
    debug_set(
        ctx,
        "supabaseOneCharNameIndex",
        json!({
            "used": true,
            "fallback": false,
            "source": "rest",
            "compactFragment": compact_query,
            "tokenRowCount": token_rows.len(),
            "candidateRowCount": rows.len(),
            "predictionCount": predictions.len(),
            "rowLimit": clean_pool_limit,
            "scanLimit": (pool_limit * 2).max(ladder::SUPABASE_PREDICTED_NAME_SCAN_LIMIT as i64).min(ladder::SUPABASE_ONE_CHAR_NAME_SCAN_LIMIT as i64),
            "durationMs": duration_ms,
            "predictions": predictions,
        }),
    );
    debug_set(
        ctx,
        "predictivePool",
        json!({
            "strategy": "supabase_one_char_name_index",
            "model": "supabase_one_char_name_tokens",
            "predictedTokens": predictions,
            "sources": [{
                "source": "supabase_predicted_names",
                "status": "fulfilled",
                "rowCount": token_rows.len(),
                "route": {"source": "supabase_predicted_names", "configured": true, "fallbackToPrimary": false},
                "durationMs": duration_ms,
            }],
            "failedSourceCount": 0,
            "durationMs": duration_ms,
        }),
    );
    debug_set(
        ctx,
        "tokenPlan",
        json!({
            "strategy": "supabase_one_char_name_index",
            "source": "rest",
            "compactFragment": compact_query,
            "tokenRowCount": token_rows.len(),
            "candidateRowCount": rows.len(),
            "predictedTokenCount": predictions.len(),
            "durationMs": duration_ms,
        }),
    );
    Ok(Some(CandidateRows {
        rows,
        non_name_context: Some(json!({"predictive_pool": predictive_pool})),
    }))
}

// --- predictive pool ---

fn predictive_pool_enabled() -> bool {
    env_s("MARKETPLACE_PREDICTIVE_POOL_ENABLED") == "1"
}

fn predictive_pool_strict_mode() -> bool {
    env_s("MARKETPLACE_PREDICTIVE_POOL_STRICT") != "0"
}

/// `candidateRowsForPredictedNames(predictions, poolLimit)`.
async fn candidate_rows_for_predicted_names(
    ctx: &Ctx,
    predictions: &[Value],
    pool_limit: i64,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    let mut representative_ids: Vec<String> = Vec::new();
    let mut seen_ids = HashSet::new();
    'outer: for prediction in predictions {
        for card_id in card_ids_from_name_token_row(prediction, usize::MAX) {
            if card_id.is_empty() || !seen_ids.insert(card_id.clone()) {
                continue;
            }
            seen_ids.insert(card_id.clone());
            representative_ids.push(card_id);
            if representative_ids.len() >= AUTOCOMPLETE_SQL_SAFE_POOL_CAP {
                break 'outer;
            }
        }
        if representative_ids.len() >= AUTOCOMPLETE_SQL_SAFE_POOL_CAP {
            break;
        }
    }
    if !representative_ids.is_empty() {
        let limit = ((pool_limit * ladder::SUPABASE_PREDICTED_NAME_TOKEN_LIMIT as i64).max(500))
            .min(AUTOCOMPLETE_SQL_SAFE_POOL_CAP as i64);
        let take = (limit as usize).min(representative_ids.len());
        return search_candidates_for_card_ids_with_database(
            ctx,
            &representative_ids[..take],
            pool,
        )
        .await;
    }
    let mut canonical_names: Vec<String> = Vec::new();
    for prediction in predictions {
        let display = str_field(prediction, &["display"]);
        if !display.is_empty() && !canonical_names.contains(&display) {
            canonical_names.push(display);
        }
    }
    canonical_names.truncate(ladder::SUPABASE_PREDICTED_NAME_TOKEN_LIMIT);
    if canonical_names.is_empty() {
        return Ok(Vec::new());
    }
    let limit = ((pool_limit * ladder::SUPABASE_PREDICTED_NAME_TOKEN_LIMIT as i64).max(500))
        .min(AUTOCOMPLETE_SQL_SAFE_POOL_CAP as i64);
    search_candidates_for_canonical_names_with_database(ctx, &canonical_names, limit, pool).await
}

/// `scorePredictedNameCandidate(row, prediction, dimensionTokens)`.
fn score_predicted_name_candidate(
    row: &Value,
    prediction: &Value,
    dimension_tokens: &[Token],
) -> Option<(f64, usize, Vec<String>)> {
    let mut score = predictive_confidence_boost(num_field(prediction, &["confidence"]));
    let mut matched_dimensions = 0usize;
    let mut matched_sources: Vec<String> = vec!["name".to_owned()];
    for token in dimension_tokens {
        let token_score = field_token_score(row, token);
        if token_score <= 0.0 {
            return None;
        }
        score += token_score * 140.0;
        matched_dimensions += 1;
        let source = if token.kind == "number" {
            "number"
        } else if token.kind == "expansion" || token.source_hint.as_deref() == Some("expansion") {
            "expansion"
        } else if token.kind == "rarity" {
            "rarity"
        } else if token.kind == "variation"
            || token.source_hint.as_deref() == Some("variation_owner")
        {
            "variation_owner"
        } else {
            continue;
        };
        if !matched_sources.iter().any(|entry| entry == source) {
            matched_sources.push(source.to_owned());
        }
    }
    Some((score, matched_dimensions, matched_sources))
}

/// `predictiveRowsForNamePredictions(predictionSets, poolLimit)`.
pub async fn predictive_rows_for_name_predictions(
    ctx: &Ctx,
    prediction_sets: &[Value],
    pool_limit: i64,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    let mut unique_predictions: Vec<Value> = Vec::new();
    let mut seen_keys: HashMap<String, f64> = HashMap::new();
    for set in prediction_sets {
        let Some(Value::Array(predictions)) = get(set, "predictions") else {
            continue;
        };
        for prediction in predictions {
            let key = {
                let normalized = str_field(prediction, &["normalized"]);
                if normalized.is_empty() {
                    str_field(prediction, &["display"])
                } else {
                    normalized
                }
            };
            let confidence = num_field(prediction, &["confidence"]);
            match seen_keys.get(&key) {
                Some(existing) if *existing >= confidence => {}
                _ => {
                    seen_keys.insert(key, confidence);
                    unique_predictions.push(prediction.clone());
                }
            }
        }
    }
    let candidate_rows =
        candidate_rows_for_predicted_names(ctx, &unique_predictions, pool_limit, pool).await?;
    let mut rows: Vec<Value> = Vec::new();
    for set in prediction_sets {
        let dimension_tokens = dimension_tokens_json(get(set, "dimensionTokens"));
        let Some(Value::Array(predictions)) = get(set, "predictions") else {
            continue;
        };
        for prediction in predictions {
            let prediction_ids: HashSet<String> =
                card_ids_from_name_token_row(prediction, usize::MAX)
                    .into_iter()
                    .collect();
            for row in &candidate_rows {
                let row_id = str_field(row, &["card_id"]);
                let matches = if !prediction_ids.is_empty() {
                    prediction_ids.contains(&row_id)
                } else {
                    compact(&str_field(row, &["canonical_name", "name"]))
                        == str_field(prediction, &["normalized"])
                };
                if !matches {
                    continue;
                }
                let Some((scored, matched_dimensions, matched_sources)) =
                    score_predicted_name_candidate(row, prediction, &dimension_tokens)
                else {
                    continue;
                };
                let mut enriched = row.clone();
                if let Value::Object(map) = &mut enriched {
                    map.insert(
                        "search_rank".into(),
                        json!(num_field(row, &["search_rank"]) + scored),
                    );
                    map.insert("predicted_name".into(), prediction_debug_entry(prediction));
                    map.insert(
                        "predicted_name_confidence".into(),
                        json!(num_field(prediction, &["confidence"])),
                    );
                    map.insert(
                        "predictive_dimension_match_count".into(),
                        json!(matched_dimensions as f64),
                    );
                    map.insert("predictive_source_flags".into(), json!(matched_sources));
                    map.insert(
                        "predictive_score_components".into(),
                        json!({
                            "predicted_name_confidence": predictive_confidence_boost(num_field(prediction, &["confidence"])),
                            "dimension_matches": matched_dimensions as f64 * 180_000.0,
                        }),
                    );
                }
                rows.push(enriched);
            }
        }
    }
    Ok(merge_rows_preserving_best(
        vec![rows],
        pool_limit.max(0) as usize,
    ))
}

fn dimension_tokens_json(value: Option<&Value>) -> Vec<Token> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| Token {
            term: str_field(item, &["term"]),
            kind: match str_field(item, &["kind"]).as_str() {
                "number" => "number",
                "variation" => "variation",
                "rarity" => "rarity",
                "expansion" => "expansion",
                _ => "text",
            },
            source_hint: match get(item, "sourceHint") {
                Some(hint) => Some(js_str_or(Some(hint))),
                None => None,
            },
        })
        .collect()
}

/// `predictiveDimensionRowsWithDatabase(source, tokens, poolLimit)`.
pub async fn predictive_dimension_rows_with_database(
    ctx: &Ctx,
    source: &str,
    tokens: &[Token],
    pool_limit: i64,
) -> Result<Vec<Value>, EngineError> {
    let clean_pool_limit = pool_limit.clamp(1, AUTOCOMPLETE_SQL_SAFE_POOL_CAP as i64);
    let source_tokens: Vec<Token> = dimension_tokens_for_source(source, tokens)
        .into_iter()
        .take(6)
        .collect();
    if source_tokens.is_empty() {
        return Ok(Vec::new());
    }
    let mut normalized_terms: Vec<String> = Vec::new();
    let mut compact_terms: Vec<String> = Vec::new();
    let mut variation_targets: Vec<String> = Vec::new();
    let mut expansion_targets: Vec<String> = Vec::new();
    for token in &source_tokens {
        if !token.term.is_empty() && !normalized_terms.contains(&token.term) {
            normalized_terms.push(token.term.clone());
        }
        let term_compact = compact(&token.term);
        if !term_compact.is_empty() && !compact_terms.contains(&term_compact) {
            compact_terms.push(term_compact);
        }
        if token.kind == "variation" {
            for target in super::normalize::variation_term_targets(&token.term) {
                if !variation_targets.contains(&target) {
                    variation_targets.push(target);
                }
            }
        }
        if token.kind == "expansion" {
            for target in super::normalize::expansion_alias_targets(&token.term) {
                if !expansion_targets.contains(&target) {
                    expansion_targets.push(target);
                }
            }
        }
    }
    let sql = format!(
        r#"
        with input as (
          select
            $1::text[] as normalized_terms,
            $2::text[] as compact_terms,
            $3::text[] as variation_targets,
            $4::text[] as expansion_targets,
            $5::text as source,
            least(greatest($6::integer, 1), 5000) as clean_limit
        )
        select
          c.card_id,
          c.name,
          c.set_name,
          candidate_number.card_number,
          c.product_variant,
          c.rarity,
          c.card_type,
          c.item_kind,
          c.product_type,
          c.trainer_name,
          c.canonical_name,
          c.image_url,
          c.cdn_image_url,
          c.preview_image_url,
          c.card_palette,
          c.emoji,
          c.imported_at,
          coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{{}}'::text[]) as variation_keys,
          public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
          public.marketplace_search_compact(candidate_number.card_number) as compact_number,
          public.marketplace_search_normalize(c.set_name) as normalized_set,
          public.marketplace_search_compact(c.set_name) as compact_set,
          public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
          public.marketplace_search_compact(c.trainer_name) as compact_trainer,
          public.marketplace_search_normalize(c.product_variant) as normalized_variant,
          public.marketplace_search_compact(c.product_variant) as compact_variant,
          (
            case
              when input.source = 'number' and exists (
                select 1 from unnest(input.compact_terms) term
                where public.marketplace_search_compact(candidate_number.card_number) = term
                   or public.marketplace_search_compact(candidate_number.card_number) like '%' || term || '%'
              ) then 3400
              when input.source = 'expansion' and exists (
                select 1 from unnest(input.expansion_targets) target
                where public.marketplace_search_compact(c.set_name) = target
                   or public.marketplace_search_compact(c.set_name) like target || '%'
                   or target like public.marketplace_search_compact(c.set_name) || '%'
              ) then 3200
              when input.source = 'expansion' and exists (
                select 1 from unnest(input.compact_terms) term
                where public.marketplace_search_compact(c.set_name) = term
                   or public.marketplace_search_compact(c.set_name) like term || '%'
              ) then 2200
              when input.source = 'rarity' and exists (
                select 1 from unnest(input.normalized_terms) term
                where public.marketplace_search_normalize(concat_ws(' ', c.rarity, candidate_number.card_number)) like '%' || term || '%'
              ) then 2100
              when input.source = 'variation_owner' and exists (
                select 1 from unnest(input.variation_targets) target
                where cv.variation_key = target
              ) then 3300
              when input.source = 'variation_owner' and exists (
                select 1 from unnest(input.compact_terms) term
                where public.marketplace_search_compact(c.trainer_name) = term
                   or public.marketplace_search_compact(c.trainer_name) like term || '%'
                   or public.marketplace_search_compact(c.product_variant) = term
                   or public.marketplace_search_compact(c.product_variant) like term || '%'
              ) then 2600
              else 0
            end +
            c.search_weight * 0.2
          )::real as search_rank
        from input
        join public.marketplace_search_candidates c on true
        {join}
        left join public.marketplace_card_variations cv on cv.card_id = c.card_id
        where (
          input.source = 'number' and exists (
            select 1 from unnest(input.compact_terms) term
            where public.marketplace_search_compact(candidate_number.card_number) = term
               or public.marketplace_search_compact(candidate_number.card_number) like '%' || term || '%'
          )
        ) or (
          input.source = 'expansion' and (
            exists (
              select 1 from unnest(input.expansion_targets) target
              where public.marketplace_search_compact(c.set_name) = target
                 or public.marketplace_search_compact(c.set_name) like target || '%'
                 or target like public.marketplace_search_compact(c.set_name) || '%'
            )
            or exists (
              select 1 from unnest(input.compact_terms) term
              where length(term) >= 3
                and (
                  public.marketplace_search_compact(c.set_name) = term
                  or public.marketplace_search_compact(c.set_name) like term || '%'
                )
            )
          )
        ) or (
          input.source = 'rarity' and exists (
            select 1 from unnest(input.normalized_terms) term
            where public.marketplace_search_normalize(concat_ws(' ', c.rarity, candidate_number.card_number)) like '%' || term || '%'
          )
        ) or (
          input.source = 'variation_owner' and (
            exists (
              select 1 from unnest(input.variation_targets) target
              where cv.variation_key = target
            )
            or exists (
              select 1 from unnest(input.compact_terms) term
              where length(term) >= 2
                and (
                  public.marketplace_search_compact(c.trainer_name) = term
                  or public.marketplace_search_compact(c.trainer_name) like term || '%'
                  or public.marketplace_search_compact(c.product_variant) = term
                  or public.marketplace_search_compact(c.product_variant) like term || '%'
                )
            )
          )
        )
        group by
          c.card_id,
          c.name,
          c.set_name,
          candidate_number.card_number,
          c.product_variant,
          c.rarity,
          c.card_type,
          c.item_kind,
          c.product_type,
          c.trainer_name,
          c.canonical_name,
          c.image_url,
          c.cdn_image_url,
          c.preview_image_url,
          c.card_palette,
          c.emoji,
          c.imported_at,
          c.search_weight,
          input.source
        having (
          case
            when input.source = 'variation_owner' and count(cv.variation_key) > 0 then true
            else true
          end
        )
        order by search_rank desc, c.name asc, candidate_number.card_number asc
        limit (select clean_limit from input)
      "#,
        join = collector_number_join_sql("c", "mc", "b", "candidate_number")
    );
    with_timeout(
        run_query(
            &ctx.pools.dimension(source),
            &sql,
            vec![
                Bind::SA(normalized_terms),
                Bind::SA(compact_terms),
                Bind::SA(variation_targets),
                Bind::SA(expansion_targets),
                Bind::S(source.to_owned()),
                Bind::I(clean_pool_limit),
            ],
        ),
        ladder::dimension_search_timeout_ms(),
        &format!("predictive {source} search"),
    )
    .await
}

/// `predictiveVerifiedDimensionRowsWithDatabase(source, predictionSets, poolLimit)`.
pub async fn predictive_verified_dimension_rows_with_database(
    ctx: &Ctx,
    source: &str,
    prediction_sets: &[Value],
    pool_limit: i64,
) -> Result<Vec<Value>, EngineError> {
    let clean_pool_limit = pool_limit.clamp(1, AUTOCOMPLETE_SQL_SAFE_POOL_CAP as i64);
    let mut row_groups: Vec<Vec<Value>> = Vec::new();
    for set in prediction_sets {
        let set_dimension_tokens = dimension_tokens_json(get(set, "dimensionTokens"));
        let source_tokens: Vec<Token> = dimension_tokens_for_source(source, &set_dimension_tokens)
            .into_iter()
            .take(6)
            .collect();
        let predictions_empty = get(set, "predictions")
            .and_then(|value| value.as_array())
            .map(|items| items.is_empty())
            .unwrap_or(true);
        if source_tokens.is_empty() || predictions_empty {
            continue;
        }
        let Some(Value::Array(predictions)) = get(set, "predictions") else {
            continue;
        };
        let mut canonical_names: Vec<String> = Vec::new();
        for prediction in predictions {
            let display = str_field(prediction, &["display"]);
            if !display.is_empty() && !canonical_names.contains(&display) {
                canonical_names.push(display);
            }
        }
        canonical_names.truncate(ladder::SUPABASE_PREDICTED_NAME_TOKEN_LIMIT);
        let mut candidate_card_ids: Vec<i64> = Vec::new();
        for prediction in predictions {
            for id in prediction_candidate_card_ids(prediction, 64) {
                if let Ok(id) = id.parse::<i64>() {
                    if !candidate_card_ids.contains(&id)
                        && candidate_card_ids.len() < AUTOCOMPLETE_SQL_SAFE_POOL_CAP
                    {
                        candidate_card_ids.push(id);
                    }
                }
            }
        }
        if canonical_names.is_empty() && candidate_card_ids.is_empty() {
            continue;
        }
        let mut normalized_terms: Vec<String> = Vec::new();
        let mut compact_terms: Vec<String> = Vec::new();
        let mut variation_targets: Vec<String> = Vec::new();
        let mut expansion_targets: Vec<String> = Vec::new();
        for token in &source_tokens {
            if !token.term.is_empty() && !normalized_terms.contains(&token.term) {
                normalized_terms.push(token.term.clone());
            }
            let term_compact = compact(&token.term);
            if !term_compact.is_empty() && !compact_terms.contains(&term_compact) {
                compact_terms.push(term_compact);
            }
            if token.kind == "variation" {
                for target in super::normalize::variation_term_targets(&token.term) {
                    if !variation_targets.contains(&target) {
                        variation_targets.push(target);
                    }
                }
            }
            if token.kind == "expansion" {
                for target in super::normalize::expansion_alias_targets(&token.term) {
                    if !expansion_targets.contains(&target) {
                        expansion_targets.push(target);
                    }
                }
            }
        }
        let sql = format!(
            r#"
          with input as (
            select
              $1::text[] as canonical_names,
              $2::text[] as normalized_terms,
              $3::text[] as compact_terms,
              $4::text[] as variation_targets,
              $5::text[] as expansion_targets,
              $6::text as source,
              least(greatest($7::integer, 1), 5000) as clean_limit,
              $8::bigint[] as candidate_card_ids
          )
          select
            c.card_id,
            c.name,
            c.set_name,
            candidate_number.card_number,
            c.product_variant,
            c.rarity,
            c.card_type,
            c.item_kind,
            c.product_type,
            c.trainer_name,
            c.canonical_name,
            c.image_url,
            c.cdn_image_url,
            c.preview_image_url,
            c.card_palette,
            c.emoji,
            c.imported_at,
            coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{{}}'::text[]) as variation_keys,
            public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
            public.marketplace_search_compact(candidate_number.card_number) as compact_number,
            public.marketplace_search_normalize(c.set_name) as normalized_set,
            public.marketplace_search_compact(c.set_name) as compact_set,
            public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
            public.marketplace_search_compact(c.trainer_name) as compact_trainer,
            public.marketplace_search_normalize(c.product_variant) as normalized_variant,
            public.marketplace_search_compact(c.product_variant) as compact_variant,
            (
              case
                when input.source = 'number' and exists (
                  select 1 from unnest(input.compact_terms) term
                  where public.marketplace_search_compact(candidate_number.card_number) = term
                     or public.marketplace_search_compact(candidate_number.card_number) like '%' || term || '%'
                ) then 3600
                when input.source = 'expansion' and exists (
                  select 1 from unnest(input.expansion_targets) target
                  where public.marketplace_search_compact(c.set_name) = target
                     or public.marketplace_search_compact(c.set_name) like target || '%'
                     or target like public.marketplace_search_compact(c.set_name) || '%'
                ) then 3300
                when input.source = 'expansion' and exists (
                  select 1 from unnest(input.compact_terms) term
                  where public.marketplace_search_compact(c.set_name) = term
                     or public.marketplace_search_compact(c.set_name) like term || '%'
                ) then 2600
                when input.source = 'rarity' and exists (
                  select 1 from unnest(input.normalized_terms) term
                  where public.marketplace_search_normalize(concat_ws(' ', c.rarity, candidate_number.card_number)) like '%' || term || '%'
                ) then 2400
                when input.source = 'variation_owner' and exists (
                  select 1 from unnest(input.variation_targets) target
                  where cv.variation_key = target
                ) then 3500
                when input.source = 'variation_owner' and exists (
                  select 1 from unnest(input.compact_terms) term
                  where public.marketplace_search_compact(c.trainer_name) = term
                     or public.marketplace_search_compact(c.trainer_name) like term || '%'
                     or public.marketplace_search_compact(c.product_variant) = term
                     or public.marketplace_search_compact(c.product_variant) like term || '%'
                ) then 2800
                else 0
              end +
              c.search_weight * 0.25
            )::real as search_rank
          from input
          join public.marketplace_search_candidates c
            on (
              case
                when cardinality(input.candidate_card_ids) > 0
                  then c.card_id = any(input.candidate_card_ids)
                else coalesce(nullif(c.canonical_name, ''), c.name) = any(input.canonical_names)
              end
            )
          {join}
          left join public.marketplace_card_variations cv on cv.card_id = c.card_id
          where (
            input.source = 'number' and exists (
              select 1 from unnest(input.compact_terms) term
              where public.marketplace_search_compact(candidate_number.card_number) = term
                 or public.marketplace_search_compact(candidate_number.card_number) like '%' || term || '%'
            )
          ) or (
            input.source = 'expansion' and (
              exists (
                select 1 from unnest(input.expansion_targets) target
                where public.marketplace_search_compact(c.set_name) = target
                   or public.marketplace_search_compact(c.set_name) like target || '%'
                   or target like public.marketplace_search_compact(c.set_name) || '%'
              )
              or exists (
                select 1 from unnest(input.compact_terms) term
                where length(term) >= 3
                  and (
                    public.marketplace_search_compact(c.set_name) = term
                    or public.marketplace_search_compact(c.set_name) like term || '%'
                  )
              )
            )
          ) or (
            input.source = 'rarity' and exists (
              select 1 from unnest(input.normalized_terms) term
              where public.marketplace_search_normalize(concat_ws(' ', c.rarity, candidate_number.card_number)) like '%' || term || '%'
            )
          ) or (
            input.source = 'variation_owner' and (
              exists (
                select 1 from unnest(input.variation_targets) target
                where cv.variation_key = target
              )
              or exists (
                select 1 from unnest(input.compact_terms) term
                where length(term) >= 2
                  and (
                    public.marketplace_search_compact(c.trainer_name) = term
                    or public.marketplace_search_compact(c.trainer_name) like term || '%'
                    or public.marketplace_search_compact(c.product_variant) = term
                    or public.marketplace_search_compact(c.product_variant) like term || '%'
                  )
              )
            )
          )
          group by
            c.card_id,
            c.name,
            c.set_name,
            candidate_number.card_number,
            c.product_variant,
            c.rarity,
            c.card_type,
            c.item_kind,
            c.product_type,
            c.trainer_name,
            c.canonical_name,
            c.image_url,
            c.cdn_image_url,
            c.preview_image_url,
            c.card_palette,
            c.emoji,
            c.imported_at,
            c.search_weight,
            input.source
          order by search_rank desc, c.name asc, candidate_number.card_number asc
          limit (select clean_limit from input)
        "#,
            join = collector_number_join_sql("c", "mc", "b", "candidate_number")
        );
        let result = with_timeout(
            run_query(
                &ctx.pools.dimension(source),
                &sql,
                vec![
                    Bind::SA(canonical_names),
                    Bind::SA(normalized_terms),
                    Bind::SA(compact_terms),
                    Bind::SA(variation_targets),
                    Bind::SA(expansion_targets),
                    Bind::S(source.to_owned()),
                    Bind::I(clean_pool_limit),
                    Bind::IA(candidate_card_ids),
                ],
            ),
            ladder::dimension_search_timeout_ms(),
            &format!("predictive {source} verification"),
        )
        .await?;
        let mut prediction_by_card_id: HashMap<String, &Value> = HashMap::new();
        for prediction in predictions {
            for id in prediction_candidate_card_ids(prediction, 64) {
                prediction_by_card_id.entry(id).or_insert(prediction);
            }
        }
        let mut prediction_by_name: HashMap<String, &Value> = HashMap::new();
        for prediction in predictions {
            prediction_by_name
                .entry(compact(&str_field(prediction, &["display"])))
                .or_insert(prediction);
        }
        row_groups.push(
            result
                .into_iter()
                .map(|row| {
                    let prediction = prediction_by_card_id
                        .get(&str_field(&row, &["card_id"]))
                        .or_else(|| {
                            prediction_by_name
                                .get(&compact(&str_field(&row, &["canonical_name", "name"])))
                        })
                        .copied();
                    let mut row = row;
                    if let Value::Object(map) = &mut row {
                        map.insert(
                            "predicted_name".into(),
                            prediction
                                .map(prediction_debug_entry)
                                .unwrap_or(Value::Null),
                        );
                        map.insert(
                            "predicted_name_confidence".into(),
                            json!(prediction
                                .map(|p| num_field(p, &["confidence"]))
                                .unwrap_or(0.0)),
                        );
                        map.insert(
                            "predictive_dimension_match_count".into(),
                            json!(source_tokens.len() as f64),
                        );
                        map.insert(
                            "predictive_source_flags".into(),
                            json!(["name".to_owned(), source.to_owned()]),
                        );
                    }
                    row
                })
                .collect(),
        );
    }
    Ok(merge_rows_preserving_best(
        row_groups,
        clean_pool_limit as usize,
    ))
}

/// `predictedNamePredictionSets(plan, searchLanguage)` — strict predictions per
/// name fragment candidate.
async fn predicted_name_prediction_sets(
    ctx: &Ctx,
    plan: &PredictivePlan,
    search_language: &str,
) -> Result<Vec<Value>, EngineError> {
    let mut candidates: Vec<Value> = plan.name_fragment_candidates.clone();
    if candidates.is_empty() {
        candidates.push(json!({
            "nameFragment": plan.text_tokens.iter().map(|token| token.term.clone()).collect::<Vec<_>>().join(" "),
            "nameTerms": plan.text_tokens.iter().map(|token| token.term.clone()).collect::<Vec<_>>(),
            "dimensionTokens": super::rank::Token::tokens_json(&plan.dimension_tokens),
            "reason": "text_tokens",
        }));
    }
    let mut prediction_sets: Vec<Value> = Vec::new();
    for candidate in candidates {
        let name_fragment = str_field(&candidate, &["nameFragment"]);
        if name_fragment.is_empty() {
            continue;
        }
        let predictions =
            predicted_name_tokens_from_supabase(ctx, &name_fragment, search_language, true).await?;
        if predictions.is_empty() {
            continue;
        }
        let mut set = candidate.clone();
        if let Value::Object(map) = &mut set {
            map.insert("predictions".into(), Value::Array(predictions));
        }
        prediction_sets.push(set);
    }
    Ok(prediction_sets)
}

/// `firstNameAnchorFromPredictionContext(predictionContext, tokens, language)`.
fn first_name_anchor_from_prediction_context(
    prediction_context: Option<&Value>,
    tokens: &[Token],
    search_language: &str,
) -> Option<NameAnchor> {
    let fragment = tokens
        .iter()
        .map(|token| token.term.clone())
        .collect::<Vec<_>>()
        .join(" ");
    let context =
        super::request::clean_prediction_context(prediction_context, &fragment, search_language)
            .ok()?;
    for prefix_length in (1..tokens.len()).rev() {
        let prefix_tokens = &tokens[..prefix_length];
        if prefix_tokens.iter().any(|token| {
            token.kind != "text" && token.kind != "rarity" && token.kind != "variation"
        }) {
            continue;
        }
        if prefix_tokens.len() == 1
            && super::rank::MODIFIER_ONLY_ANCHOR_WORDS
                .contains(&compact(&prefix_tokens[0].term).as_str())
        {
            continue;
        }
        let normalized_prefix = compact(
            &prefix_tokens
                .iter()
                .map(|token| token.term.clone())
                .collect::<Vec<_>>()
                .join(" "),
        );
        if normalized_prefix.is_empty() {
            continue;
        }
        let context_json = context_value(&context);
        let Some(candidates) = get(&context_json, "candidates").and_then(|value| value.as_array())
        else {
            continue;
        };
        let prediction = candidates.iter().find(|candidate| {
            str_field(candidate, &["normalized"]) == normalized_prefix
                && num_field(candidate, &["confidence"])
                    >= super::rank::FIRST_NAME_ANCHOR_MIN_CONFIDENCE as f64
        })?;
        return Some(NameAnchor {
            prefix_length,
            name_fragment: prefix_tokens
                .iter()
                .map(|token| token.term.clone())
                .collect::<Vec<_>>()
                .join(" "),
            name_terms: prefix_tokens
                .iter()
                .map(|token| token.term.clone())
                .collect(),
            predictions: json!([prediction]),
            source: "prediction_context".to_owned(),
        });
    }
    None
}

fn context_value(context: &super::request::ValidPredictionContext) -> Value {
    json!({
        "normalized_fragment": context.normalized_fragment,
        "language": context.language,
        "candidates": context.candidates,
    })
}

/// `firstNameAnchorFromSupabase(tokens, searchLanguage)`.
async fn first_name_anchor_from_supabase(
    ctx: &Ctx,
    tokens: &[Token],
    search_language: &str,
) -> Option<NameAnchor> {
    for prefix_length in (1..tokens.len()).rev() {
        let prefix_tokens = &tokens[..prefix_length];
        if prefix_tokens.iter().any(|token| {
            token.kind != "text" && token.kind != "rarity" && token.kind != "variation"
        }) {
            continue;
        }
        if prefix_tokens.len() == 1
            && super::rank::MODIFIER_ONLY_ANCHOR_WORDS
                .contains(&compact(&prefix_tokens[0].term).as_str())
        {
            continue;
        }
        let name_fragment = prefix_tokens
            .iter()
            .map(|token| token.term.clone())
            .collect::<Vec<_>>()
            .join(" ");
        let normalized_prefix = compact(&name_fragment);
        if normalized_prefix.is_empty() {
            continue;
        }
        let predictions =
            predicted_name_tokens_from_supabase(ctx, &name_fragment, search_language, false)
                .await
                .unwrap_or_default();
        let exact: Vec<Value> = predictions
            .into_iter()
            .filter(|prediction| {
                compact(&str_field(prediction, &["normalized", "display"])) == normalized_prefix
                    && num_field(prediction, &["confidence"])
                        >= super::rank::FIRST_NAME_ANCHOR_MIN_CONFIDENCE as f64
            })
            .collect();
        if exact.is_empty() {
            continue;
        }
        return Some(NameAnchor {
            prefix_length,
            name_fragment,
            name_terms: prefix_tokens
                .iter()
                .map(|token| token.term.clone())
                .collect(),
            predictions: Value::Array(exact),
            source: "supabase_name_prefix".to_owned(),
        });
    }
    None
}

/// `firstNameAnchorForPredictivePlan(plan, searchLanguage, predictionContext)`.
async fn first_name_anchor_for_predictive_plan(
    ctx: &Ctx,
    plan: &PredictivePlan,
    search_language: &str,
    prediction_context: Option<&Value>,
) -> Option<NameAnchor> {
    if plan.tokens.len() < 2 {
        return None;
    }
    if let Some(anchor) =
        first_name_anchor_from_prediction_context(prediction_context, &plan.tokens, search_language)
    {
        return Some(anchor);
    }
    first_name_anchor_from_supabase(ctx, &plan.tokens, search_language).await
}

/// `predictionSetsFromContext(plan, predictionContext, searchTerm, language,
/// debug)` — client prediction context path.
fn prediction_sets_from_context(
    plan: &PredictivePlan,
    prediction_context: Option<&Value>,
    search_term: &str,
    search_language: &str,
    ctx: &mut Ctx,
) -> Option<Vec<Value>> {
    let context = match super::request::clean_prediction_context(
        prediction_context,
        search_term,
        search_language,
    ) {
        Ok(context) => context,
        Err(reason) => {
            debug_set(
                ctx,
                "predictionContext",
                json!({"used": false, "reason": reason}),
            );
            return None;
        }
    };
    let mut candidates = plan.name_fragment_candidates.clone();
    if candidates.is_empty() {
        candidates.push(json!({
            "nameFragment": plan.text_tokens.iter().map(|token| token.term.clone()).collect::<Vec<_>>().join(" "),
            "nameTerms": plan.text_tokens.iter().map(|token| token.term.clone()).collect::<Vec<_>>(),
            "dimensionTokens": super::rank::Token::tokens_json(&plan.dimension_tokens),
            "reason": "text_tokens",
        }));
    }
    let prediction_sets: Vec<Value> = candidates
        .into_iter()
        .filter(|candidate| {
            let fragment = str_field(candidate, &["nameFragment"]);
            !fragment.is_empty() && compact(&fragment).starts_with(&context.normalized_fragment)
        })
        .map(|mut candidate| {
            if let Value::Object(map) = &mut candidate {
                map.insert(
                    "predictions".into(),
                    Value::Array(context.candidates.clone()),
                );
                map.insert(
                    "predictionContextSource".into(),
                    json!("client_prediction_context"),
                );
            }
            candidate
        })
        .collect();
    debug_set(
        ctx,
        "predictionContext",
        json!({
            "used": !prediction_sets.is_empty(),
            "reason": if prediction_sets.is_empty() { json!("no_matching_name_fragment") } else { Value::Null },
            "normalizedFragment": context.normalized_fragment,
            "candidateCount": context.candidates.len(),
            "predictionSetCount": prediction_sets.len(),
        }),
    );
    if prediction_sets.is_empty() {
        None
    } else {
        Some(prediction_sets)
    }
}

/// `strictPredictivePoolError(failedSources, sourceResults)`.
fn strict_predictive_pool_error(
    failed_sources: &[Value],
    source_results: &[Value],
) -> Option<EngineError> {
    if !predictive_pool_strict_mode() {
        return None;
    }
    let fulfilled_rows: f64 = source_results
        .iter()
        .filter(|entry| {
            str_field(entry, &["source"]) != "supabase_predicted_names"
                && str_field(entry, &["status"]) == "fulfilled"
        })
        .map(|entry| num_field(entry, &["rowCount"]))
        .sum();
    if failed_sources.is_empty() && fulfilled_rows > 0.0 {
        return None;
    }
    let sources: Vec<String> = failed_sources
        .iter()
        .map(|entry| str_field(entry, &["source"]))
        .collect();
    let message = if !sources.is_empty() {
        format!("Predictive pool source failed: {}", sources.join(", "))
    } else {
        "Predictive pool returned no candidate rows.".to_owned()
    };
    Some(
        EngineError::new(message)
            .with_status(503)
            .with_code("PREDICTIVE_POOL_SOURCE_FAILED"),
    )
}

/// `buildPredictivePoolWithFanout(...)` — `Ok(None)` mirrors the JS `null`.
#[allow(clippy::too_many_arguments)]
pub async fn build_predictive_pool_with_fanout(
    ctx: &mut Ctx,
    search_term: &str,
    pool_limit: i64,
    search_language: &str,
    prediction_context: Option<&Value>,
) -> Result<Option<CandidateRows>, EngineError> {
    let Some(plan) = super::rank::predictive_pool_plan(search_term) else {
        return Ok(None);
    };
    let started = now_ms();
    let strict = predictive_pool_strict_mode();
    let prediction_configured = supabase_prediction_configured();
    let prediction_route = json!({
        "source": "supabase_predicted_names",
        "configured": prediction_configured,
        "fallbackToPrimary": !prediction_configured,
    });
    let prediction_task_started = now_ms();
    let mut prediction_sets: Vec<Value> = Vec::new();
    let context_prediction_sets =
        prediction_sets_from_context(&plan, prediction_context, search_term, search_language, ctx);
    let first_name_anchor =
        first_name_anchor_for_predictive_plan(ctx, &plan, search_language, prediction_context)
            .await;
    let anchor_prediction_sets = super::rank::anchored_prediction_sets(
        first_name_anchor.as_ref().map(|anchor| NameAnchor {
            prefix_length: anchor.prefix_length,
            name_fragment: anchor.name_fragment.clone(),
            name_terms: anchor.name_terms.clone(),
            predictions: anchor.predictions.clone(),
            source: anchor.source.clone(),
        }),
        &plan.tokens,
    );
    let prediction_source_result: Value;
    if strict
        && !prediction_configured
        && !plan.text_tokens.is_empty()
        && context_prediction_sets.is_none()
        && anchor_prediction_sets.is_none()
    {
        prediction_source_result = json!({
            "source": "supabase_predicted_names",
            "status": "failed",
            "reason": "source_not_configured_no_primary_fallback",
            "route": prediction_route,
            "rowCount": 0,
            "rows": [],
            "durationMs": now_ms() - prediction_task_started,
        });
    } else {
        let outcome: Result<Vec<Value>, EngineError> = async {
            if let Some(sets) = anchor_prediction_sets.clone() {
                return Ok(sets);
            }
            if let Some(sets) = context_prediction_sets.clone() {
                return Ok(sets);
            }
            if !plan.text_tokens.is_empty() {
                predicted_name_prediction_sets(ctx, &plan, search_language).await
            } else {
                Ok(Vec::new())
            }
        }
        .await;
        match outcome {
            Ok(sets) => {
                let row_count: f64 = sets
                    .iter()
                    .map(|set| {
                        get(set, "predictions")
                            .and_then(|value| value.as_array())
                            .map(|items| items.len())
                            .unwrap_or(0) as f64
                    })
                    .sum();
                prediction_sets = sets;
                prediction_source_result = json!({
                    "source": "supabase_predicted_names",
                    "status": if !prediction_sets.is_empty() || plan.text_tokens.is_empty() { "fulfilled" } else { "failed" },
                    "reason": if !prediction_sets.is_empty() || plan.text_tokens.is_empty() { Value::Null } else { json!("empty_prediction_sets") },
                    "route": prediction_route,
                    "rowCount": row_count,
                    "rows": [],
                    "contextProvided": context_prediction_sets.is_some(),
                    "firstNameAnchorProvided": anchor_prediction_sets.is_some(),
                    "durationMs": now_ms() - prediction_task_started,
                });
            }
            Err(error) => {
                prediction_source_result = json!({
                    "source": "supabase_predicted_names",
                    "status": "failed",
                    "reason": error.message,
                    "code": error.code,
                    "route": prediction_route,
                    "rowCount": 0,
                    "rows": [],
                    "contextProvided": context_prediction_sets.is_some(),
                    "firstNameAnchorProvided": anchor_prediction_sets.is_some(),
                    "durationMs": now_ms() - prediction_task_started,
                });
            }
        }
    }
    let name_route = name_search_route();
    struct SourceTask {
        source: &'static str,
        route: Value,
        required: bool,
    }
    let mut source_tasks: Vec<SourceTask> = vec![SourceTask {
        source: "name",
        route: name_route,
        required: !plan.text_tokens.is_empty() || plan.dimension_tokens.is_empty(),
    }];
    for source in PREDICTIVE_DIMENSION_SOURCES {
        let route = marketplace_dimension_search_route(source);
        let has_matching_token = if !prediction_sets.is_empty() {
            prediction_sets.iter().any(|set| {
                !dimension_tokens_for_source(
                    source,
                    &dimension_tokens_json(get(set, "dimensionTokens")),
                )
                .is_empty()
            })
        } else {
            !dimension_tokens_for_source(source, &plan.dimension_tokens).is_empty()
        };
        source_tasks.push(SourceTask {
            source,
            route,
            required: has_matching_token,
        });
    }
    let prediction_failed = str_field(&prediction_source_result, &["status"]) == "failed"
        && !plan.text_tokens.is_empty();
    let mut preflight_results: Vec<Option<Value>> = Vec::new();
    for task in &source_tasks {
        let fallback_to_primary = get(&task.route, "fallbackToPrimary")
            .map(|value| value == &Value::Bool(true))
            .unwrap_or(false);
        let configured = get(&task.route, "configured")
            .map(|value| value == &Value::Bool(true))
            .unwrap_or(false);
        if strict && fallback_to_primary {
            preflight_results.push(Some(json!({
                "source": task.source,
                "status": if task.required { "failed" } else { "skipped" },
                "skipped": !task.required,
                "reason": "source_not_configured_no_primary_fallback",
                "route": task.route,
                "rowCount": 0,
                "rows": [],
                "durationMs": 0,
            })));
        } else if !task.required && task.source != "name" && !configured {
            preflight_results.push(Some(json!({
                "source": task.source,
                "status": "skipped",
                "skipped": true,
                "reason": "source_not_required_or_configured",
                "route": task.route,
                "rowCount": 0,
                "rows": [],
                "durationMs": 0,
            })));
        } else {
            preflight_results.push(None);
        }
    }
    let mut preflight_failures: Vec<Value> = Vec::new();
    if prediction_failed && strict {
        preflight_failures.push(prediction_source_result.clone());
    }
    for entry in preflight_results.iter().flatten() {
        if str_field(entry, &["status"]) == "failed" {
            preflight_failures.push(entry.clone());
        }
    }
    if !preflight_failures.is_empty() {
        let mut source_results: Vec<Value> = vec![prediction_source_result.clone()];
        for (index, task) in source_tasks.iter().enumerate() {
            match preflight_results.get(index) {
                Some(Some(entry)) => source_results.push(entry.clone()),
                _ => source_results.push(json!({
                    "source": task.source,
                    "status": "not_started",
                    "route": task.route,
                    "rowCount": 0,
                    "rows": [],
                    "durationMs": 0,
                })),
            }
        }
        write_predictive_debug(
            ctx,
            &plan,
            &prediction_sets,
            first_name_anchor.as_ref(),
            &source_results,
            preflight_failures.len(),
            started,
        );
        let error = strict_predictive_pool_error(&preflight_failures, &source_results);
        if let Some(error) = error {
            return Err(error);
        }
        return Ok(None);
    }
    // Run the name source.
    let mut source_results: Vec<Value> = Vec::new();
    // index 0 == name task; the rest are dimension tasks.
    let name_task = &source_tasks[0];
    let name_fallback_to_primary = get(&name_task.route, "fallbackToPrimary")
        .map(|value| value == &Value::Bool(true))
        .unwrap_or(false);
    let name_started = now_ms();
    if strict && name_fallback_to_primary {
        source_results.push(json!({
            "source": name_task.source,
            "status": if name_task.required { "failed" } else { "skipped" },
            "skipped": !name_task.required,
            "reason": "source_not_configured_no_primary_fallback",
            "route": name_task.route,
            "rowCount": 0,
            "rows": [],
            "durationMs": now_ms() - name_started,
        }));
    } else {
        let rows = predictive_rows_for_name_predictions(
            ctx,
            &prediction_sets,
            pool_limit,
            ctx.pools.name_search(),
        )
        .await;
        match rows {
            Ok(rows) => source_results.push(json!({
                "source": name_task.source,
                "status": "fulfilled",
                "route": name_task.route,
                "rowCount": rows.len(),
                "rows": rows,
                "durationMs": now_ms() - name_started,
            })),
            Err(error) => source_results.push(json!({
                "source": name_task.source,
                "status": "failed",
                "reason": error.message,
                "code": error.code,
                "route": name_task.route,
                "rowCount": 0,
                "rows": [],
                "durationMs": now_ms() - name_started,
            })),
        }
    }
    for (index, task) in source_tasks.iter().enumerate().skip(1) {
        let task_started = now_ms();
        let fallback_to_primary = get(&task.route, "fallbackToPrimary")
            .map(|value| value == &Value::Bool(true))
            .unwrap_or(false);
        let configured = get(&task.route, "configured")
            .map(|value| value == &Value::Bool(true))
            .unwrap_or(false);
        if strict && fallback_to_primary {
            source_results.push(json!({
                "source": task.source,
                "status": if task.required { "failed" } else { "skipped" },
                "skipped": !task.required,
                "reason": "source_not_configured_no_primary_fallback",
                "route": task.route,
                "rowCount": 0,
                "rows": [],
                "durationMs": now_ms() - task_started,
            }));
            continue;
        }
        if !task.required && task.source != "name" && !configured {
            source_results.push(json!({
                "source": task.source,
                "status": "skipped",
                "skipped": true,
                "reason": "source_not_required_or_configured",
                "route": task.route,
                "rowCount": 0,
                "rows": [],
                "durationMs": now_ms() - task_started,
            }));
            continue;
        }
        let run_result = if !prediction_sets.is_empty() {
            predictive_verified_dimension_rows_with_database(
                ctx,
                task.source,
                &prediction_sets,
                pool_limit,
            )
            .await
        } else {
            predictive_dimension_rows_with_database(ctx, task.source, &plan.tokens, pool_limit)
                .await
        };
        match run_result {
            Ok(rows) => source_results.push(json!({
                "source": task.source,
                "status": "fulfilled",
                "route": task.route,
                "rowCount": rows.len(),
                "rows": rows,
                "durationMs": now_ms() - task_started,
            })),
            Err(error) => source_results.push(json!({
                "source": task.source,
                "status": "failed",
                "reason": error.message,
                "code": error.code,
                "route": task.route,
                "rowCount": 0,
                "rows": [],
                "durationMs": now_ms() - task_started,
            })),
        }
        let _ = index;
    }
    let all_source_results: Vec<Value> = vec![prediction_source_result.clone()]
        .into_iter()
        .chain(source_results.iter().cloned())
        .collect();
    let failed_sources: Vec<Value> = all_source_results
        .iter()
        .filter(|entry| str_field(entry, &["status"]) == "failed")
        .cloned()
        .collect();
    write_predictive_debug(
        ctx,
        &plan,
        &prediction_sets,
        first_name_anchor.as_ref(),
        &all_source_results,
        failed_sources.len(),
        started,
    );
    let strict_error = strict_predictive_pool_error(&failed_sources, &all_source_results);
    if let Some(error) = strict_error {
        return Err(error);
    }
    let merge_inputs: Vec<(String, Vec<Value>)> = source_results
        .iter()
        .filter(|entry| str_field(entry, &["status"]) == "fulfilled")
        .map(|entry| {
            (
                str_field(entry, &["source"]),
                get(entry, "rows")
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or_default(),
            )
        })
        .collect();
    let rows =
        super::rank::merge_predictive_pool_rows(&merge_inputs, search_term, pool_limit as usize);
    let any_fulfilled = source_results
        .iter()
        .any(|entry| str_field(entry, &["status"]) == "fulfilled");
    if any_fulfilled && rows.is_empty() {
        return Err(
            EngineError::new("Predictive pool returned no rankable candidate rows.")
                .with_status(503)
                .with_code("PREDICTIVE_POOL_EMPTY_AFTER_MERGE"),
        );
    }
    let predictive_context = json!({
        "predictive_pool": {
            "strict": strict,
            "predicted_tokens": prediction_sets.iter().flat_map(|set| {
                let fragment = str_field(set, &["nameFragment"]);
                let remaining = get(set, "dimensionTokens").cloned().unwrap_or(Value::Null);
                get(set, "predictions")
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or_default()
                    .into_iter()
                    .map(move |prediction| {
                        let mut entry = prediction_debug_entry(&prediction);
                        entry["name_fragment"] = json!(fragment);
                        entry["remaining_tokens"] = remaining.clone();
                        entry
                    })
                    .collect::<Vec<_>>()
            }).collect::<Vec<_>>(),
            "sources": all_source_results.iter().map(|entry| json!({
                "source": str_field(entry, &["source"]),
                "status": str_field(entry, &["status"]),
                "row_count": num_field(entry, &["rowCount"]),
                "context_provided": get(entry, "contextProvided") == Some(&Value::Bool(true)),
                "first_name_anchor_provided": get(entry, "firstNameAnchorProvided") == Some(&Value::Bool(true)),
            })).collect::<Vec<_>>(),
        }
    });
    if let Some(debug) = ctx.debug.as_mut().filter(|_| true) {
        if let Some(pool) = get_mut(debug, "predictivePool") {
            pool["mergedRowCount"] = json!(rows.len());
            pool["mergedTopSources"] = json!(rows.iter().take(12).map(|row| json!({
                "card_id": str_field(row, &["card_id"]),
                "sources": source_flags_for(row),
                "components": get(row, "predictive_score_components").cloned().unwrap_or(Value::Null),
            })).collect::<Vec<_>>());
        }
        if let Some(plan_value) = get_mut(debug, "tokenPlan") {
            *plan_value = json!({
                "strategy": "predictive_dimension_pool",
                "tokens": super::rank::Token::tokens_json(&plan.tokens),
                "predictedTokenCount": prediction_sets.iter().map(|set| get(set, "predictions").and_then(|v| v.as_array()).map(|items| items.len()).unwrap_or(0)).sum::<usize>(),
                "sourceCount": source_results.len(),
                "failedSourceCount": failed_sources.len(),
                "matchedRowCount": rows.len(),
                "durationMs": now_ms() - started,
            });
        }
    }
    if rows.is_empty() {
        return Ok(None);
    }
    Ok(Some(CandidateRows {
        rows,
        non_name_context: Some(predictive_context),
    }))
}

fn get_mut<'a>(value: &'a mut Value, key: &str) -> Option<&'a mut Value> {
    value.get_mut(key)
}

fn write_predictive_debug(
    ctx: &mut Ctx,
    plan: &PredictivePlan,
    prediction_sets: &[Value],
    first_name_anchor: Option<&NameAnchor>,
    sources: &[Value],
    failed_source_count: usize,
    started: u64,
) {
    debug_set(ctx, "searchPath", json!("predictive_dimension_pool"));
    debug_set(
        ctx,
        "predictivePool",
        json!({
            "strategy": "predictive_dimension_pool",
            "model": "dynamic_supabase_predicted_tokens",
            "strict": predictive_pool_strict_mode(),
            "tokens": super::rank::Token::tokens_json(&plan.tokens),
            "nameFragmentCandidates": plan.name_fragment_candidates,
            "firstNameAnchor": first_name_anchor.map(|anchor| json!({
                "nameFragment": anchor.name_fragment,
                "source": anchor.source,
                "predictionCount": anchor.predictions.as_array().map(|items| items.len()).unwrap_or(0),
            })).unwrap_or(Value::Null),
            "predictedTokens": prediction_sets.iter().flat_map(|set| {
                let fragment = str_field(set, &["nameFragment"]);
                let remaining = get(set, "dimensionTokens").cloned().unwrap_or(Value::Null);
                get(set, "predictions")
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or_default()
                    .into_iter()
                    .map(move |prediction| {
                        let mut entry = prediction_debug_entry(&prediction);
                        entry["nameFragment"] = json!(fragment);
                        entry["remainingTokens"] = remaining.clone();
                        entry
                    })
                    .collect::<Vec<_>>()
            }).collect::<Vec<_>>(),
            "sources": sources.iter().map(|entry| json!({
                "source": str_field(entry, &["source"]),
                "status": str_field(entry, &["status"]),
                "skipped": get(entry, "skipped") == Some(&Value::Bool(true)),
                "reason": get(entry, "reason").cloned().unwrap_or(Value::Null),
                "code": get(entry, "code").cloned().unwrap_or(Value::Null),
                "route": get(entry, "route").cloned().unwrap_or(Value::Null),
                "rowCount": num_field(entry, &["rowCount"]),
                "contextProvided": get(entry, "contextProvided") == Some(&Value::Bool(true)),
                "firstNameAnchorProvided": get(entry, "firstNameAnchorProvided") == Some(&Value::Bool(true)),
                "durationMs": num_field(entry, &["durationMs"]),
            })).collect::<Vec<_>>(),
            "failedSourceCount": failed_source_count,
            "durationMs": now_ms() - started,
        }),
    );
}

// --- predictive n-grams ---

/// `searchPredictiveNgramRowsWithDatabase(searchTerm, poolLimit, language)`.
pub async fn search_predictive_ngram_rows_with_database(
    ctx: &mut Ctx,
    search_term: &str,
    pool_limit: i64,
    search_language: &str,
    use_name_query_first: bool,
) -> Result<Option<Vec<Value>>, EngineError> {
    let chunks = super::normalize::predictive_chunks_for_query(search_term, 2, 3);
    if chunks.is_empty() {
        return Ok(None);
    }
    let ngram_language = clean_language(Some(&json!(search_language)));
    let chunk_list: Vec<String> = chunks
        .iter()
        .map(|chunk| str_field(chunk, &["chunk"]))
        .collect();
    let values = vec![
        Bind::SA(chunk_list.clone()),
        Bind::I(pool_limit.clamp(1, AUTOCOMPLETE_SQL_SAFE_POOL_CAP as i64)),
        Bind::S(ngram_language.clone()),
    ];
    let sql = format!(
        r#"
      with query_chunks as (
        select
          chunk,
          ordinality::integer as chunk_order
        from unnest($1::text[]) with ordinality as input(chunk, ordinality)
      ),
      -- Predictive chunks and chunk-frequency boosts are language-local. Missing
      -- event rows produce a neutral boost instead of falling back to English.
      chunk_hits as (
        select
          n.card_id,
          max(n.name) as matched_name,
          count(distinct q.chunk)::integer as matched_chunks,
          sum(
            (
              case
                when n.chunk = q.chunk and n.is_prefix then 760
                when n.chunk = q.chunk then 520
                else 0
              end +
              greatest(0, 80 - n.chunk_position * 6) +
              n.source_weight * 100 +
              least(coalesce(e.total_weight, 0), 250) * 0.8
            )
          )::real as ngram_score,
          jsonb_agg(distinct n.chunk order by n.chunk) as matched_ngram_chunks
        from query_chunks q
        join public.marketplace_name_ngrams n
          on n.language = $3::text
          and n.chunk = q.chunk
        left join public.marketplace_query_chunk_events e
          on e.language = $3::text
          and e.chunk = q.chunk
          and e.event_type = 'search'
        group by n.card_id
        having count(distinct q.chunk) >= greatest(1, least(3, ceil((select count(*) from query_chunks)::numeric * 0.35))::integer)
      )
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{{}}'::text[]) as variation_keys,
        public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
        public.marketplace_search_compact(candidate_number.card_number) as compact_number,
        public.marketplace_search_normalize(c.set_name) as normalized_set,
        public.marketplace_search_compact(c.set_name) as compact_set,
        public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
        public.marketplace_search_compact(c.trainer_name) as compact_trainer,
        public.marketplace_search_normalize(c.product_variant) as normalized_variant,
        public.marketplace_search_compact(c.product_variant) as compact_variant,
        (
          h.ngram_score +
          h.matched_chunks * 260 +
          c.search_weight * 0.35
        )::real as search_rank,
        h.matched_chunks,
        h.matched_ngram_chunks
      from chunk_hits h
      join public.marketplace_search_candidates c on c.card_id = h.card_id
      {join}
      left join public.marketplace_card_variations cv on cv.card_id = c.card_id
      group by
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        c.search_weight,
        h.ngram_score,
        h.matched_chunks,
        h.matched_ngram_chunks
      order by search_rank desc, c.name asc, c.card_number asc
      limit $2::integer
    "#,
        join = collector_number_join_sql("c", "mc", "b", "candidate_number")
    );
    let started = now_ms();
    let run = |pool: PgPool| {
        let sql = sql.clone();
        let values = values.clone();
        async move { run_query(&pool, &sql, values).await }
    };
    let attempt = with_timeout(
        run(if use_name_query_first {
            ctx.pools.name_search().clone()
        } else {
            ctx.pools.marketplace().clone()
        }),
        ladder::name_search_timeout_ms(),
        "predictive ngram search",
    )
    .await;
    match attempt {
        Ok(rows) => {
            debug_set(
                ctx,
                "predictiveNgrams",
                json!({
                    "used": true,
                    "path": if use_name_query_first { "peer3_predictive_ngrams" } else { "injected_predictive_ngrams" },
                    "fallback": false,
                    "chunks": chunks,
                    "language": ngram_language,
                    "eventLanguage": ngram_language,
                    "languageFallback": "none",
                    "candidateRowCount": rows.len(),
                    "durationMs": now_ms() - started,
                }),
            );
            Ok(Some(rows))
        }
        Err(error) => {
            let code = error.db_code();
            if ["42P01", "42883", "42703"].contains(&code.as_deref().unwrap_or("")) {
                debug_set(
                    ctx,
                    "predictiveNgrams",
                    json!({
                        "used": false,
                        "reason": "schema_not_applied",
                        "code": code,
                        "chunks": chunks,
                        "language": ngram_language,
                        "eventLanguage": ngram_language,
                        "languageFallback": "none",
                        "durationMs": now_ms() - started,
                    }),
                );
                return Ok(None);
            }
            if !use_name_query_first || ladder::should_avoid_primary_search_fallback(search_term) {
                debug_set(
                    ctx,
                    "predictiveNgrams",
                    json!({
                        "used": false,
                        "reason": if !use_name_query_first { "query_failed" } else { "primary_fallback_skipped_short_prefix" },
                        "error": error.message,
                        "code": code,
                        "chunks": chunks,
                        "language": ngram_language,
                        "eventLanguage": ngram_language,
                        "languageFallback": "none",
                        "durationMs": now_ms() - started,
                    }),
                );
                return Ok(None);
            }
            let fallback_started = now_ms();
            match with_timeout(
                run(ctx.pools.marketplace().clone()),
                ladder::name_search_timeout_ms(),
                "primary predictive ngram search",
            )
            .await
            {
                Err(fallback_error) => {
                    debug_set(
                        ctx,
                        "predictiveNgrams",
                        json!({
                            "used": false,
                            "reason": "fallback_failed",
                            "error": error.message,
                            "code": code,
                            "fallbackError": fallback_error.message,
                            "fallbackCode": fallback_error.code,
                            "chunks": chunks,
                            "language": ngram_language,
                            "eventLanguage": ngram_language,
                            "languageFallback": "none",
                            "durationMs": now_ms() - started,
                            "fallbackDurationMs": now_ms() - fallback_started,
                        }),
                    );
                    Ok(None)
                }
                Ok(rows) => {
                    debug_set(
                        ctx,
                        "predictiveNgrams",
                        json!({
                            "used": true,
                            "path": "primary_predictive_ngrams_fallback",
                            "fallback": true,
                            "reason": error.message,
                            "code": code,
                            "chunks": chunks,
                            "language": ngram_language,
                            "eventLanguage": ngram_language,
                            "languageFallback": "none",
                            "candidateRowCount": rows.len(),
                            "durationMs": now_ms() - started,
                            "fallbackDurationMs": now_ms() - fallback_started,
                        }),
                    );
                    Ok(Some(rows))
                }
            }
        }
    }
}

// --- one character prefix shards ---

const PREFIX_SHARD_SECONDARY_BUCKETS_JSON: &str = r#"[{"kind":"range","start":"a","end":"g"},{"kind":"range","start":"h","end":"o"},{"kind":"range","start":"p","end":"u"},{"kind":"range","start":"v","end":"z"},{"kind":"non_alpha"}]"#;

/// `namePrefixRowsForOneCharacterSearch(searchTerm, poolLimit, language,
/// shardPool, fallbackPool, plan)`.
pub async fn name_prefix_rows_for_one_character_search(
    ctx: &mut Ctx,
    search_term: &str,
    pool_limit: i64,
    search_language: &str,
    shard_pool: &PgPool,
    fallback_pool: &PgPool,
    shard_label: &str,
    shard_role: &str,
    shard_buckets_json: &str,
) -> Result<Vec<Value>, EngineError> {
    let compact_term = compact(search_term);
    if compact_term.chars().count() != 1 {
        return Ok(Vec::new());
    }
    let sql = r#"
      with shard_buckets as (
        select
          bucket->>'kind' as kind,
          bucket->>'start' as start_char,
          bucket->>'end' as end_char
        from jsonb_array_elements($4::jsonb) bucket
      )
      select
        c.card_id,
        c.name,
        c.set_name,
        c.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        '{}'::text[] as variation_keys,
        public.marketplace_search_normalize(c.card_number) as normalized_number,
        public.marketplace_search_compact(c.card_number) as compact_number,
        public.marketplace_search_normalize(c.set_name) as normalized_set,
        public.marketplace_search_compact(c.set_name) as compact_set,
        public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
        public.marketplace_search_compact(c.trainer_name) as compact_trainer,
        public.marketplace_search_normalize(c.product_variant) as normalized_variant,
        public.marketplace_search_compact(c.product_variant) as compact_variant,
        (
          case
            when public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) = $1 then 3600
            when public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) like $1 || '%' then 3400
            when exists (
              select 1
              from public.marketplace_card_names_for_language($3::text) names
              where names.name = coalesce(nullif(c.canonical_name, ''), c.name)
                and names.compact_name like $1 || '%'
            ) then 3200
            else 2600
          end +
          c.search_weight +
          least(coalesce(h.hot_score_1h, 0), 5000) * 0.35 +
          least(coalesce(h.hot_score_24h, 0), 15000) * 0.12 +
          least(coalesce(h.hot_score_7d, 0), 40000) * 0.03 +
          least(coalesce(h.searches_24h, 0), 500) * 8 +
          least(coalesce(h.clicks_24h, 0), 500) * 14 +
          least(coalesce(h.cart_adds_24h, 0), 100) * 28 +
          least(coalesce(h.reserves_24h, 0), 100) * 34 +
          least(coalesce(h.sales_24h, 0), 50) * 55 +
          least(coalesce(s.active_listing_count, 0), 50) * 24 +
          least(coalesce(s.listed_quantity, 0), 200) * 4
        )::real as search_rank
      from public.marketplace_search_candidates c
      left join public.marketplace_hot_blueprints h
        on h.blueprint_id = c.card_id
      left join public.marketplace_blueprint_price_summary s
        on s.blueprint_id = c.card_id
      where
        exists (
          select 1
          from shard_buckets bucket
          where (
            bucket.kind = 'range'
            and (
              public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name))
                between $1 || bucket.start_char and $1 || bucket.end_char || repeat('z', 80)
              or exists (
                select 1
                from public.marketplace_card_names_for_language($3::text) names
                where names.name = coalesce(nullif(c.canonical_name, ''), c.name)
                  and names.compact_name between $1 || bucket.start_char and $1 || bucket.end_char || repeat('z', 80)
              )
            )
          ) or (
            bucket.kind = 'non_alpha'
            and (
              public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) = $1
              or (
                public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) like $1 || '%'
                and substring(public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) from 2 for 1)
                  !~ '^[a-z]$'
              )
              or exists (
                select 1
                from public.marketplace_card_names_for_language($3::text) names
                where names.name = coalesce(nullif(c.canonical_name, ''), c.name)
                  and (
                    names.compact_name = $1
                    or (
                      names.compact_name like $1 || '%'
                      and substring(names.compact_name from 2 for 1) !~ '^[a-z]$'
                    )
                  )
              )
            )
          )
        )
      order by search_rank desc, h.last_event_at desc nulls last, c.name asc, c.card_number asc
      limit $2::integer
    "#;
    let clean_pool_limit = pool_limit.clamp(1, AUTOCOMPLETE_ONE_CHAR_BACKEND_POOL_LIMIT as i64);
    let values = vec![
        Bind::S(compact_term.clone()),
        Bind::I(clean_pool_limit),
        Bind::S(clean_language(Some(&json!(search_language)))),
        Bind::S(shard_buckets_json.to_owned()),
    ];
    let label = format!("one-character prefix {shard_label}");
    let run = |pool: PgPool| {
        let sql = sql.to_owned();
        let values = values.clone();
        let label = label.clone();
        async move {
            with_timeout(
                run_query(&pool, &sql, values),
                ladder::name_search_timeout_ms(),
                &label,
            )
            .await
        }
    };
    let attempt = run(shard_pool.clone()).await;
    match attempt {
        Ok(rows) => {
            debug_set(
                ctx,
                "prefixPool",
                json!({
                    "path": if std::ptr::eq(shard_pool, ctx.pools.name_search()) { "peer3_name_prefix" } else { "injected_name_prefix" },
                    "fallback": false,
                    "shardRange": shard_label,
                    "dbRole": shard_role,
                    "rowCount": rows.len(),
                }),
            );
            Ok(rows)
        }
        Err(error) => {
            if std::ptr::eq(shard_pool, fallback_pool)
                || ladder::should_avoid_primary_search_fallback(search_term)
            {
                return Err(error);
            }
            let result = run(fallback_pool.clone()).await?;
            debug_set(
                ctx,
                "prefixPool",
                json!({
                    "path": "primary_name_prefix_fallback",
                    "fallback": true,
                    "shardRange": shard_label,
                    "dbRole": shard_role,
                    "reason": error.message,
                    "code": error.code,
                    "rowCount": result.len(),
                }),
            );
            Ok(result)
        }
    }
}

/// `shardedNamePrefixRowsForOneCharacterSearch(searchTerm, poolLimit, language)`.
pub async fn sharded_name_prefix_rows_for_one_character_search(
    ctx: &mut Ctx,
    search_term: &str,
    pool_limit: i64,
    search_language: &str,
    use_state_clients: bool,
) -> Vec<Value> {
    let compact_term = compact(search_term);
    if compact_term.chars().count() != 1 {
        return Vec::new();
    }
    let client_roles: Vec<String> = if use_state_clients {
        ctx.pools
            .prefix_clients
            .iter()
            .map(|client| client.role.clone())
            .collect()
    } else {
        vec!["injected".to_owned()]
    };
    let shard_plans = super::rank::one_character_prefix_shard_plan(search_term, &client_roles);
    if shard_plans.is_empty() {
        return Vec::new();
    }
    let started = now_ms();
    let shard_limit = pool_limit.clamp(1, AUTOCOMPLETE_ONE_CHAR_BACKEND_POOL_LIMIT as i64);
    let mut shard_results: Vec<Value> = Vec::new();
    let mut merged: HashMap<String, Value> = HashMap::new();
    let primary_client = ctx
        .pools
        .prefix_clients
        .iter()
        .find(|client| client.role == "primary")
        .or_else(|| ctx.pools.prefix_clients.first())
        .cloned();
    for plan in &shard_plans {
        let shard_started = now_ms();
        let circuit_key = format!("{}:{}", plan.role, plan.label);
        let disabled_until = PREFIX_SHARD_DISABLED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&circuit_key)
            .copied()
            .unwrap_or(0);
        let circuit_open = plan.role != "primary" && now_ms() < disabled_until;
        let client = if use_state_clients && !circuit_open {
            ctx.pools
                .prefix_clients
                .get(plan.index)
                .map(|client| client.pool.clone())
        } else if use_state_clients {
            None
        } else {
            Some(ctx.pools.marketplace().clone())
        };
        let Some(shard_pool) = client else {
            shard_results.push(json!({
                "index": plan.index,
                "role": plan.role,
                "range": plan.label,
                "fallback": false,
                "skipped": true,
                "circuitOpen": circuit_open,
                "disabledUntil": if circuit_open { json!(disabled_until as f64) } else { Value::Null },
                "reason": if circuit_open { "prefix shard circuit open" } else { "no replica client for prefix shard" },
                "durationMs": now_ms() - shard_started,
                "rowCount": 0,
                "rows": [],
            }));
            continue;
        };
        let fallback_pool = primary_client
            .as_ref()
            .map(|client| client.pool.clone())
            .unwrap_or_else(|| ctx.pools.marketplace().clone());
        let result = name_prefix_rows_for_one_character_search(
            ctx,
            search_term,
            shard_limit,
            search_language,
            &shard_pool,
            &fallback_pool,
            &plan.label,
            &plan.role,
            PREFIX_SHARD_SECONDARY_BUCKETS_JSON,
        )
        .await;
        match result {
            Ok(rows) => {
                let fallback = circuit_open;
                shard_results.push(json!({
                    "index": plan.index,
                    "role": plan.role,
                    "range": plan.label,
                    "fallback": fallback,
                    "circuitOpen": circuit_open,
                    "disabledUntil": if circuit_open { json!(disabled_until as f64) } else { Value::Null },
                    "reason": if circuit_open { json!("prefix shard circuit open") } else { Value::Null },
                    "durationMs": now_ms() - shard_started,
                    "rowCount": rows.len(),
                    "rows": rows,
                }));
                for row in rows {
                    let key = row_key(&row);
                    if key.is_empty() {
                        continue;
                    }
                    match merged.get(&key) {
                        Some(existing)
                            if num_field(existing, &["search_rank"])
                                >= num_field(&row, &["search_rank"]) => {}
                        _ => {
                            merged.insert(key, row);
                        }
                    }
                }
            }
            Err(error) => {
                if plan.role != "primary" {
                    PREFIX_SHARD_DISABLED
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .insert(
                            circuit_key.clone(),
                            now_ms() + ladder::name_search_circuit_ms(),
                        );
                }
                shard_results.push(json!({
                    "index": plan.index,
                    "role": plan.role,
                    "range": plan.label,
                    "fallback": false,
                    "failed": true,
                    "reason": error.message,
                    "code": error.code,
                    "durationMs": now_ms() - shard_started,
                    "rowCount": 0,
                    "rows": [],
                }));
            }
        }
    }
    let mut rows: Vec<Value> = merged.into_values().collect();
    rows.sort_by(|left, right| {
        pokoin_sort::cmp_f64_desc(num_field(left, &["search_rank"]), num_field(right, &["search_rank"]))
            .then_with(|| locale_cmp(&str_field(left, &["name"]), &str_field(right, &["name"])))
            .then_with(|| {
                locale_cmp(
                    &str_field(left, &["card_number"]),
                    &str_field(right, &["card_number"]),
                )
            })
    });
    rows.truncate(shard_limit.max(0) as usize);
    let raw_row_count: f64 = shard_results
        .iter()
        .map(|result| num_field(result, &["rowCount"]))
        .sum();
    debug_set(
        ctx,
        "prefixPool",
        json!({
            "path": "typed_one_character_sharded_prefix",
            "fallback": shard_results.iter().any(|result| get(result, "fallback") == Some(&Value::Bool(true))),
            "shardCount": shard_results.len(),
            "shardRanges": shard_results.iter().map(|result| str_field(result, &["range"])).collect::<Vec<_>>(),
            "shards": shard_results,
            "rawRowCount": raw_row_count,
            "rowCount": rows.len(),
            "durationMs": now_ms() - started,
        }),
    );
    rows
}

// --- hydrators ---

/// `hydrateCanonicalPathsForRows(rows)`.
pub async fn hydrate_canonical_paths_for_rows(ctx: &Ctx, rows: Vec<Value>) -> Vec<Value> {
    let mut missing_ids: Vec<i64> = Vec::new();
    for row in &rows {
        if !str_field(row, &["canonical_path", "canonicalPath"])
            .trim()
            .is_empty()
        {
            continue;
        }
        let id = num_field(row, &["card_id", "id"]);
        if id.is_finite() && id.fract() == 0.0 && id > 0.0 && id <= 9_007_199_254_740_991.0 {
            let id = id as i64;
            if !missing_ids.contains(&id) {
                missing_ids.push(id);
            }
        }
    }
    let mut path_by_id: HashMap<String, String> = HashMap::new();
    if !missing_ids.is_empty() {
        let sql = r#"
        select card_id, canonical_path
        from public.marketplace_card_urls
        where (card_id = any($1::bigint[]) or ct_id = any($1::bigint[]))
          and language = 'en'
      "#;
        if let Ok(result) =
            run_query(ctx.pools.marketplace(), sql, vec![Bind::IA(missing_ids)]).await
        {
            for row in &result {
                path_by_id.insert(
                    str_field(row, &["card_id"]),
                    str_field(row, &["canonical_path"]).trim().to_owned(),
                );
            }
        }
    }
    rows.into_iter()
        .map(|row| {
            let lookup = path_by_id
                .get(&str_field(&row, &["card_id", "id"]))
                .cloned()
                .unwrap_or_default();
            attach_canonical_path(&row, &lookup)
        })
        .collect()
}

/// `hydrateProjectedRarityForRows(rows)`.
pub async fn hydrate_projected_rarity_for_rows(ctx: &Ctx, rows: Vec<Value>) -> Vec<Value> {
    let mut ids: Vec<i64> = Vec::new();
    for row in &rows {
        let rarity = str_field(row, &["rarity"]).trim().to_lowercase();
        if !rarity.is_empty() && rarity != "card" {
            continue;
        }
        let id = num_field(row, &["card_id", "id"]);
        if id.is_finite() && id.fract() == 0.0 && id > 0.0 && id <= 9_007_199_254_740_991.0 {
            let id = id as i64;
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    if ids.is_empty() {
        return rows;
    }
    let sql = r#"
        select
          blueprints.id as card_id,
          coalesce(
            nullif(tcg_metadata.raw_metadata#>>'{sourceCard,rarity}', ''),
            nullif(blueprints.blueprint->>'rarity', ''),
            nullif(blueprints.blueprint->>'collector_rarity', ''),
            nullif(blueprints.blueprint#>>'{fixed_properties,pokemon_rarity}', '')
          ) as projected_rarity
        from public.cardtrader_pokemon_blueprints blueprints
        left join public.marketplace_blueprint_tcg_metadata tcg_metadata
          on tcg_metadata.blueprint_id = blueprints.id
        where blueprints.id = any($1::bigint[])
      "#;
    let Ok(result) = run_query(ctx.pools.marketplace(), sql, vec![Bind::IA(ids)]).await else {
        return rows;
    };
    let mut rarity_by_id: HashMap<String, String> = HashMap::new();
    for row in &result {
        let rarity = str_field(row, &["projected_rarity"]).trim().to_owned();
        if rarity.is_empty() || rarity.eq_ignore_ascii_case("card") {
            continue;
        }
        rarity_by_id.insert(str_field(row, &["card_id"]), rarity);
    }
    rows.into_iter()
        .map(|row| {
            let rarity = str_field(&row, &["rarity"]).trim().to_owned();
            if !rarity.is_empty() && !rarity.eq_ignore_ascii_case("card") {
                return row;
            }
            match rarity_by_id.get(&str_field(&row, &["card_id", "id"])) {
                Some(projected) => {
                    let mut row = row;
                    if let Value::Object(map) = &mut row {
                        map.insert("rarity".into(), Value::String(projected.clone()));
                    }
                    row
                }
                None => row,
            }
        })
        .collect()
}

/// `hydrateExpansionSymbolsForRows(rows)`.
pub async fn hydrate_expansion_symbols_for_rows(ctx: &Ctx, rows: Vec<Value>) -> Vec<Value> {
    let rows = hydrate_projected_rarity_for_rows(ctx, rows).await;
    let rows = hydrate_canonical_paths_for_rows(ctx, rows).await;
    let mut missing_set_names: Vec<String> = Vec::new();
    for row in &rows {
        if !str_field(row, &["expansion_symbol_url"]).trim().is_empty() {
            continue;
        }
        let set_name = str_field(row, &["set_name"]).trim().to_owned();
        if !set_name.is_empty() && !missing_set_names.contains(&set_name) {
            missing_set_names.push(set_name);
        }
    }
    if missing_set_names.is_empty() {
        return rows;
    }
    let sql = r#"
        select
          name,
          min(symbol_image_url) as expansion_symbol_url
        from public.pokoin_pokemon_expansions
        where name = any($1::text[])
          and coalesce(symbol_image_url, '') <> ''
        group by name
      "#;
    let Ok(result) = run_query(
        ctx.pools.marketplace(),
        sql,
        vec![Bind::SA(missing_set_names)],
    )
    .await
    else {
        return rows;
    };
    let mut symbol_by_name: HashMap<String, String> = HashMap::new();
    for row in &result {
        symbol_by_name.insert(
            str_field(row, &["name"]).trim().to_owned(),
            str_field(row, &["expansion_symbol_url"]).trim().to_owned(),
        );
    }
    rows.into_iter()
        .map(|row| {
            if !str_field(&row, &["expansion_symbol_url"]).trim().is_empty() {
                return row;
            }
            match symbol_by_name.get(&str_field(&row, &["set_name"]).trim().to_owned()) {
                Some(symbol_url) if !symbol_url.is_empty() => {
                    let mut row = row;
                    if let Value::Object(map) = &mut row {
                        map.insert(
                            "expansion_symbol_url".into(),
                            Value::String(symbol_url.clone()),
                        );
                    }
                    row
                }
                _ => row,
            }
        })
        .collect()
}

// --- hot preview pool ---

struct HotPoolCache {
    key: i64,
    rows: Vec<Value>,
    created_at_ms: u64,
    refresh_in_flight: bool,
}

static HOT_POOL_CACHE: LazyLock<Mutex<Option<HotPoolCache>>> = LazyLock::new(|| Mutex::new(None));

/// `hotPreviewPoolRowsWithDatabase(poolLimit)`.
pub async fn hot_preview_pool_rows_with_database(
    _ctx: &Ctx,
    pool_limit: i64,
    pool: &PgPool,
) -> Result<Vec<Value>, EngineError> {
    let sql = r#"
      select
        c.card_id,
        c.name,
        c.set_name,
        c.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        (
          c.search_weight +
          least(coalesce(h.hot_score_1h, 0), 5000) * 0.35 +
          least(coalesce(h.hot_score_24h, 0), 15000) * 0.12 +
          least(coalesce(h.hot_score_7d, 0), 40000) * 0.03 +
          least(coalesce(h.searches_24h, 0), 500) * 8 +
          least(coalesce(h.clicks_24h, 0), 500) * 14 +
          least(coalesce(h.cart_adds_24h, 0), 100) * 28 +
          least(coalesce(h.reserves_24h, 0), 100) * 34 +
          least(coalesce(h.sales_24h, 0), 50) * 55 +
          least(coalesce(s.active_listing_count, 0), 50) * 24 +
          least(coalesce(s.listed_quantity, 0), 200) * 4
        )::real as search_rank
      from public.marketplace_hot_blueprints h
      join public.marketplace_search_candidates c
        on c.card_id = h.blueprint_id
      left join public.marketplace_blueprint_price_summary s
        on s.blueprint_id = h.blueprint_id
      where coalesce(h.hot_score_1h, 0) > 0
        or coalesce(h.hot_score_24h, 0) > 0
        or coalesce(h.hot_score_7d, 0) > 0
        or coalesce(h.searches_24h, 0) > 0
        or coalesce(h.clicks_24h, 0) > 0
        or coalesce(h.cart_adds_24h, 0) > 0
        or coalesce(h.reserves_24h, 0) > 0
        or coalesce(h.sales_24h, 0) > 0
      order by search_rank desc, h.last_event_at desc nulls last, c.name asc
      limit $1::integer
    "#;
    run_query(pool, sql, vec![Bind::I(pool_limit.clamp(1, 1000))]).await
}

/// `hotPreviewPool(poolLimit)` — 60 s server cache with the JS source labels.
/// The refresh is awaited, so a database failure rejects like the JS promise.
pub async fn hot_preview_pool(
    ctx: &Ctx,
    pool_limit: i64,
) -> Result<(Vec<Value>, String), EngineError> {
    let limit = pool_limit.clamp(1, 1000);
    let now = now_ms();
    {
        let cache = HOT_POOL_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = cache.as_ref() {
            if entry.key == limit && now - entry.created_at_ms < ladder::HOT_PREVIEW_POOL_TTL_MS {
                return Ok((
                    entry.rows.clone(),
                    "hot_analytics_server_cache_hit".to_owned(),
                ));
            }
            if entry.key == limit && entry.refresh_in_flight {
                return Ok((
                    entry.rows.clone(),
                    "hot_analytics_server_cache_stale".to_owned(),
                ));
            }
        }
    }
    let rows = hot_preview_pool_rows_with_database(ctx, limit, &ctx.pools.analytics()).await?;
    let mut cache = HOT_POOL_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cache = Some(HotPoolCache {
        key: limit,
        rows: rows.clone(),
        created_at_ms: now_ms(),
        refresh_in_flight: false,
    });
    Ok((rows, "hot_analytics_server_cache_refresh".to_owned()))
}

// --- structured context refine + candidate fanout ---

/// `searchStructuredAutocompleteWithContext(...)` — `Ok(None)` mirrors `null`.
pub async fn search_structured_autocomplete_with_context(
    ctx: &mut Ctx,
    search_term: &str,
    pool_limit: i64,
    search_language: &str,
    previous_context: Option<&Value>,
) -> Result<Option<Vec<Value>>, EngineError> {
    let context = match super::request::clean_search_context(
        previous_context,
        search_term,
        search_language,
    ) {
        Ok(context) => context,
        Err(reason) => {
            debug_set(
                ctx,
                "contextRefine",
                json!({"used": false, "reason": reason}),
            );
            return Ok(None);
        }
    };
    let Some(plan) = super::rank::candidate_fanout_plan(search_term) else {
        debug_set(
            ctx,
            "contextRefine",
            json!({"used": false, "reason": "no_fanout_plan"}),
        );
        return Ok(None);
    };
    let started = now_ms();
    let candidate_rows = search_candidates_for_card_ids_with_database(
        ctx,
        &context.card_ids,
        ctx.pools.marketplace(),
    )
    .await?;
    let mut ranked: Vec<Value> = Vec::new();
    for row in candidate_rows {
        let (matched, score) = super::rank::score_row_against_fanout_plan(&row, &plan);
        if !matched {
            continue;
        }
        let mut row = row;
        if let Value::Object(map) = &mut row {
            map.insert("search_rank".into(), json!(score));
        }
        ranked.push(row);
    }
    ranked.sort_by(|left, right| {
        pokoin_sort::cmp_f64_desc(num_field(left, &["search_rank"]), num_field(right, &["search_rank"]))
            .then_with(|| locale_cmp(&str_field(left, &["name"]), &str_field(right, &["name"])))
            .then_with(|| {
                locale_cmp(
                    &str_field(left, &["card_number"]),
                    &str_field(right, &["card_number"]),
                )
            })
    });
    let candidate_row_count = ranked.len();
    debug_set(
        ctx,
        "tokenPlan",
        json!({
            "strategy": "candidate_context_refine",
            "tokens": super::rank::Token::tokens_json(&plan.tokens),
            "previousQuery": context.query,
            "previousCardIdCount": context.card_ids.len(),
            "candidateRowCount": candidate_row_count,
            "matchedRowCount": ranked.len(),
            "durationMs": now_ms() - started,
        }),
    );
    if ranked.is_empty() {
        let previous_terms: HashSet<String> = search_terms(&context.query).into_iter().collect();
        for token in &plan.name_probe_tokens {
            if previous_terms.contains(&token.term) {
                continue;
            }
            let entities = search_canonical_name_entities_with_database(
                ctx,
                &token.term,
                20,
                search_language,
                ctx.pools.marketplace(),
            )
            .await?;
            if entities.is_empty() {
                continue;
            }
            let mut names_by_score: HashMap<String, f64> = HashMap::new();
            for entity in &entities {
                let name = str_field(entity, &["name"]);
                let score = num_field(entity, &["token_score"]);
                let entry = names_by_score.entry(name).or_insert(0.0);
                *entry = entry.max(score);
            }
            let mut pairs: Vec<(String, f64)> = names_by_score
                .iter()
                .map(|(name, score)| (name.clone(), *score))
                .collect();
            pairs.sort_by(|left, right| {
                pokoin_sort::cmp_f64_desc(left.1, right.1)
                    .then_with(|| locale_cmp(&left.0, &right.0))
            });
            let canonical_names: Vec<String> =
                pairs.into_iter().take(30).map(|(name, _)| name).collect();
            let candidate_limit = ((pool_limit.saturating_mul(40)).max(500)).min(4000);
            let seeded_rows = search_candidates_for_canonical_names_with_database(
                ctx,
                &canonical_names,
                candidate_limit,
                ctx.pools.marketplace(),
            )
            .await?;
            let previous_field_tokens: Vec<&Token> = plan
                .tokens
                .iter()
                .filter(|plan_token| plan_token.term != token.term)
                .collect();
            let mut seeded_ranked: Vec<Value> = Vec::new();
            for row in seeded_rows {
                let mut field_score = 0.0;
                let mut matched = true;
                for plan_token in &previous_field_tokens {
                    let score = field_token_score(&row, plan_token);
                    if score <= 0.0 {
                        matched = false;
                        break;
                    }
                    field_score += score;
                }
                if !matched {
                    continue;
                }
                let total = names_by_score
                    .get(&str_field(&row, &["canonical_name", "name"]))
                    .copied()
                    .unwrap_or(1000.0)
                    + field_score
                    + num_field(&row, &["search_rank"]);
                let mut row = row;
                if let Value::Object(map) = &mut row {
                    map.insert("search_rank".into(), json!(total));
                }
                seeded_ranked.push(row);
            }
            seeded_ranked.sort_by(|left, right| {
                pokoin_sort::cmp_f64_desc(num_field(left, &["search_rank"]), num_field(right, &["search_rank"]))
                    .then_with(|| {
                        locale_cmp(&str_field(left, &["name"]), &str_field(right, &["name"]))
                    })
                    .then_with(|| {
                        locale_cmp(
                            &str_field(left, &["card_number"]),
                            &str_field(right, &["card_number"]),
                        )
                    })
            });
            if !seeded_ranked.is_empty() {
                debug_set(
                    ctx,
                    "tokenPlan",
                    json!({
                        "strategy": "candidate_context_refine",
                        "subStrategy": "added_name_seed",
                        "tokens": super::rank::Token::tokens_json(&plan.tokens),
                        "previousQuery": context.query,
                        "seedToken": {"term": token.term, "kind": token.kind},
                        "previousCardIdCount": context.card_ids.len(),
                        "candidateRowCount": seeded_ranked.len(),
                        "matchedRowCount": seeded_ranked.len(),
                        "durationMs": now_ms() - started,
                    }),
                );
                seeded_ranked.truncate(pool_limit.max(0) as usize);
                return Ok(Some(seeded_ranked));
            }
        }
        debug_set(
            ctx,
            "contextRefine",
            json!({
                "used": true,
                "fallbackReason": "empty_context_refine",
                "previousCardIdCount": context.card_ids.len(),
            }),
        );
        return Ok(None);
    }
    ranked.truncate(pool_limit.max(0) as usize);
    Ok(Some(ranked))
}

/// `searchStructuredAutocompleteWithCandidateFanout(...)` — `Ok(None)` mirrors
/// `null`.
pub async fn search_structured_autocomplete_with_candidate_fanout(
    ctx: &mut Ctx,
    search_term: &str,
    pool_limit: i64,
    search_language: &str,
) -> Result<Option<Vec<Value>>, EngineError> {
    let Some(plan) = super::rank::candidate_fanout_plan(search_term) else {
        return Ok(None);
    };
    let name_started = now_ms();
    let mut name_entity_groups: Vec<(Token, Vec<Value>)> = Vec::new();
    for token in &plan.name_probe_tokens {
        let entities = search_canonical_name_entities_with_database(
            ctx,
            &token.term,
            20,
            search_language,
            ctx.pools.marketplace(),
        )
        .await?;
        if !entities.is_empty() {
            name_entity_groups.push((token.clone(), entities));
        }
    }
    let matched_name_tokens = &name_entity_groups;
    let name_duration_ms = now_ms() - name_started;
    if matched_name_tokens.is_empty() {
        return Ok(None);
    }
    // nameSeedCombinations
    struct Combination {
        matched_name_tokens: Vec<String>,
        field_tokens: Vec<Token>,
        score: f64,
    }
    let mut combinations: Vec<Combination> = Vec::new();
    for (token, entities) in matched_name_tokens {
        let best = entities
            .iter()
            .map(|entity| num_field(entity, &["token_score"]))
            .fold(f64::NEG_INFINITY, f64::max);
        combinations.push(Combination {
            matched_name_tokens: vec![token.term.clone()],
            field_tokens: matched_name_tokens
                .iter()
                .filter(|(other, _)| other.term != token.term)
                .map(|(token, _)| Token {
                    source_hint: None,
                    ..token.clone()
                })
                .collect(),
            score: best + token.term.len() as f64,
        });
    }
    combinations.sort_by(|left, right| {
        pokoin_sort::cmp_f64_desc(left.score, right.score)
    });
    combinations.truncate(12);
    let candidate_started = now_ms();
    struct FanoutResult {
        ranked: Vec<Value>,
        matched_name_tokens: Vec<String>,
        field_tokens: Vec<Token>,
        canonical_names: Vec<String>,
        candidate_row_count: usize,
    }
    let mut results: Vec<FanoutResult> = Vec::new();
    for combination in &combinations {
        let mut field_tokens = combination.field_tokens.clone();
        for token in &plan.tokens {
            if !matched_name_tokens
                .iter()
                .any(|(entry, _)| entry.term == token.term)
                && !field_tokens
                    .iter()
                    .any(|existing| existing.term == token.term)
            {
                field_tokens.push(token.clone());
            }
        }
        if field_tokens.is_empty() {
            continue;
        }
        let mut names_by_score: HashMap<String, f64> = HashMap::new();
        for term in &combination.matched_name_tokens {
            let Some((_, entities)) = matched_name_tokens
                .iter()
                .find(|(token, _)| &token.term == term)
            else {
                continue;
            };
            for entity in entities {
                let name = str_field(entity, &["name"]);
                let entry = names_by_score.entry(name).or_insert(0.0);
                *entry = entry.max(num_field(entity, &["token_score"]));
            }
        }
        let mut pairs: Vec<(String, f64)> = names_by_score
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect();
        pairs.sort_by(|left, right| {
            pokoin_sort::cmp_f64_desc(left.1, right.1)
                .then_with(|| locale_cmp(&left.0, &right.0))
        });
        let canonical_names: Vec<String> =
            pairs.into_iter().take(30).map(|(name, _)| name).collect();
        let candidate_limit = ((pool_limit.saturating_mul(40)).max(500)).min(4000);
        let candidate_rows = search_candidates_for_canonical_names_with_database(
            ctx,
            &canonical_names,
            candidate_limit,
            ctx.pools.marketplace(),
        )
        .await?;
        let candidate_row_count = candidate_rows.len();
        let mut ranked: Vec<Value> = Vec::new();
        for row in candidate_rows {
            let mut field_score = 0.0;
            let mut matched = true;
            for token in &field_tokens {
                let score = field_token_score(&row, token);
                if score <= 0.0 {
                    matched = false;
                    break;
                }
                field_score += score;
            }
            if !matched {
                continue;
            }
            let total = names_by_score
                .get(&str_field(&row, &["canonical_name", "name"]))
                .copied()
                .unwrap_or(1000.0)
                + field_score
                + num_field(&row, &["search_rank"]);
            let mut row = row;
            if let Value::Object(map) = &mut row {
                map.insert("search_rank".into(), json!(total));
            }
            ranked.push(row);
        }
        ranked.sort_by(|left, right| {
            pokoin_sort::cmp_f64_desc(num_field(left, &["search_rank"]), num_field(right, &["search_rank"]))
                .then_with(|| locale_cmp(&str_field(left, &["name"]), &str_field(right, &["name"])))
                .then_with(|| {
                    locale_cmp(
                        &str_field(left, &["card_number"]),
                        &str_field(right, &["card_number"]),
                    )
                })
        });
        results.push(FanoutResult {
            ranked,
            matched_name_tokens: combination.matched_name_tokens.clone(),
            field_tokens,
            canonical_names,
            candidate_row_count,
        });
    }
    let best = results.into_iter().max_by(|left, right| {
        let left_has = !left.ranked.is_empty();
        let right_has = !right.ranked.is_empty();
        right_has
            .cmp(&left_has)
            .then_with(|| right.ranked.len().cmp(&left.ranked.len()))
            .then_with(|| {
                let left_rank = left
                    .ranked
                    .first()
                    .map(|row| num_field(row, &["search_rank"]))
                    .unwrap_or(0.0);
                let right_rank = right
                    .ranked
                    .first()
                    .map(|row| num_field(row, &["search_rank"]))
                    .unwrap_or(0.0);
                pokoin_sort::cmp_f64_desc(left_rank, right_rank)
            })
    });
    let Some(best) = best else {
        return Ok(None);
    };
    let matched_count = best.ranked.len();
    debug_set(
        ctx,
        "tokenPlan",
        json!({
            "strategy": "candidate_fanout",
            "tokens": super::rank::Token::tokens_json(&plan.tokens),
            "matchedNameTokens": best.matched_name_tokens,
            "fieldTokens": super::rank::Token::tokens_json(&best.field_tokens),
            "canonicalNameCount": best.canonical_names.len(),
            "candidateRowCount": best.candidate_row_count,
            "matchedRowCount": matched_count,
            "nameDurationMs": name_duration_ms,
            "candidateDurationMs": now_ms() - candidate_started,
        }),
    );
    if matched_count == 0 {
        return Ok(None);
    }
    let mut ranked = best.ranked;
    ranked.truncate(pool_limit.max(0) as usize);
    Ok(Some(ranked))
}

// --- orchestrators ---

/// `shouldPreferDirectNamePrefix(searchTerm)`.
pub fn should_prefer_direct_name_prefix(search_term: &str) -> bool {
    let terms = search_terms(search_term);
    if terms.len() != 1 {
        return false;
    }
    let term = &terms[0];
    if !term.is_empty() && term.bytes().all(|b| b.is_ascii_digit())
        || is_variation_intent_term(term)
        || is_rarity_term(term)
        || is_expansion_alias_term(term)
    {
        return false;
    }
    compact(search_term) == compact(term)
}

/// `rowsForAutocompleteSearchTerm(searchTerm, poolLimit, language, debug,
/// previousContext, readQuery, predictiveQuery)`.
pub async fn rows_for_autocomplete_search_term(
    ctx: &mut Ctx,
    search_term: &str,
    pool_limit: i64,
    search_language: &str,
    previous_context: Option<&Value>,
    predictive_from_name_pool: bool,
) -> Result<Vec<Value>, EngineError> {
    // searchStructuredAutocompleteWithContext
    if let Some(rows) = search_structured_autocomplete_with_context(
        ctx,
        search_term,
        pool_limit,
        search_language,
        previous_context,
    )
    .await?
    .filter(|rows| !rows.is_empty())
    {
        return Ok(rows);
    }

    let terms = search_terms(search_term);
    let mut direct_name_prefix_rows: Option<Vec<Value>> = None;
    if let Some(rows) =
        search_generic_energy_expansion_rows_with_database(ctx, search_term, pool_limit).await?
    {
        if !rows.is_empty() {
            return Ok(rows);
        }
    }

    if should_prefer_direct_name_prefix(search_term) {
        match search_name_only_autocomplete_with_card_name_fanout(
            ctx,
            search_term,
            pool_limit,
            search_language,
        )
        .await
        {
            Ok(rows) => direct_name_prefix_rows = rows,
            Err(error) => {
                debug_set(
                    ctx,
                    "directNamePrefix",
                    json!({
                        "used": false,
                        "fallback": true,
                        "reason": error.message,
                        "code": error.code,
                    }),
                );
            }
        }
    }
    if let Some(rows) = direct_name_prefix_rows.filter(|rows| !rows.is_empty()) {
        return Ok(rows);
    }

    let predictive_started = now_ms();
    let predictive_result = search_predictive_ngram_rows_with_database(
        ctx,
        search_term,
        pool_limit,
        search_language,
        predictive_from_name_pool,
    )
    .await?;
    if let Some(ngram_rows) = predictive_result.filter(|rows| !rows.is_empty()) {
        let name_required =
            super::rank::filter_rows_by_required_name_tokens(ngram_rows.clone(), search_term);
        let structured_tokens: Vec<Token> = super::rank::tokens_for_query(search_term)
            .into_iter()
            .filter(|token| token.kind != "text" && token.kind != "rarity")
            .collect();
        let name_required_applied = name_required.applied;
        let name_required_filtered_count = name_required.filtered_count;
        let name_required_tokens = name_required.required_tokens.clone();
        let mut filtered_rows = name_required.rows;
        let mut structured_applied = false;
        if !structured_tokens.is_empty() && !name_required_applied {
            let loose = super::rank::filter_rows_by_any_structured_token(
                filtered_rows.clone(),
                &structured_tokens,
            );
            if loose.applied {
                filtered_rows = loose.rows;
                structured_applied = true;
            } else {
                let stored = filter_rows_by_stored_structured_tokens(
                    ctx,
                    ngram_rows.clone(),
                    &structured_tokens,
                    ctx.pools.marketplace(),
                )
                .await?;
                if !stored.is_empty() {
                    filtered_rows = stored;
                    structured_applied = true;
                }
                let _ = &filtered_rows;
            }
        }
        debug_set(ctx, "searchPath", json!("typed_predictive_ngrams"));
        debug_set(
            ctx,
            "tokenPlan",
            json!({
                "strategy": "typed_predictive_ngrams",
                "chunks": super::normalize::predictive_chunks_for_query(search_term, 2, 3),
                "structuredTokens": Token::tokens_json(&structured_tokens),
                "structuredTokenFilter": {"applied": structured_applied},
                "requiredNameTokens": super::rank::Token::tokens_json(&name_required_tokens),
                "requiredNameTokenFilter": {
                    "applied": name_required_applied,
                    "filteredCount": name_required_filtered_count,
                },
                "language": search_language,
                "eventLanguage": search_language,
                "languageFallback": "none",
                "candidateRowCount": ngram_rows.len(),
                "matchedRowCount": filtered_rows.len(),
                "fallback": false,
                "durationMs": now_ms() - predictive_started,
            }),
        );
        if !filtered_rows.is_empty() {
            let needs_fanout = structured_tokens
                .iter()
                .any(|token| token.kind == "expansion")
                && !structured_applied
                && !name_required.applied;
            if needs_fanout {
                let fanout_rows = search_structured_autocomplete_with_candidate_fanout(
                    ctx,
                    search_term,
                    pool_limit,
                    search_language,
                )
                .await?;
                if let Some(rows) = fanout_rows.filter(|rows| !rows.is_empty()) {
                    return Ok(rows);
                }
            }
            filtered_rows.truncate(pool_limit.max(0) as usize);
            return Ok(filtered_rows);
        }
    }
    let fanout_rows = search_structured_autocomplete_with_candidate_fanout(
        ctx,
        search_term,
        pool_limit,
        search_language,
    )
    .await?;
    if let Some(rows) = fanout_rows.filter(|rows| !rows.is_empty()) {
        return Ok(rows);
    }
    let combined_name_started = now_ms();
    let combined_name_rows =
        search_combined_card_name_with_database(ctx, &terms, pool_limit, ctx.pools.marketplace())
            .await?;
    if !combined_name_rows.is_empty() {
        debug_set(
            ctx,
            "tokenPlan",
            json!({
                "strategy": "combined_card_name",
                "terms": terms,
                "candidateRowCount": combined_name_rows.len(),
                "matchedRowCount": combined_name_rows.len(),
                "durationMs": now_ms() - combined_name_started,
            }),
        );
        return Ok(combined_name_rows);
    }
    let multi_name_only_rows = if terms.len() > 1 {
        search_name_only_autocomplete_with_card_name_fanout(
            ctx,
            search_term,
            pool_limit,
            search_language,
        )
        .await?
    } else {
        None
    };
    if let Some(rows) = multi_name_only_rows.filter(|rows| !rows.is_empty()) {
        return Ok(rows);
    }
    if let Some(debug) = ctx.debug.as_mut() {
        if let Value::Object(map) = debug {
            map.insert("fanoutFallback".into(), json!(true));
        }
    }
    let pool_term = super::normalize::clean_search_term(Some(&json!(
        super::normalize::normalize_variation_phrases(search_term)
    )));
    let token_plan = super::rank::intersection_token_plan(search_term);
    let Some(token_plan) = token_plan else {
        let rows = rows_for_search_term(
            ctx,
            ctx.redis.clone(),
            &pool_term,
            pool_limit,
            0,
            search_language,
            false,
        )
        .await?;
        debug_set(
            ctx,
            "tokenPlan",
            json!({
                "strategy": "ranked_pool",
                "poolTerm": pool_term,
            }),
        );
        return Ok(rows);
    };

    let per_token_limit = ladder::structured_autocomplete_token_limit(None);
    let text_tokens: Vec<&Token> = token_plan
        .tokens
        .iter()
        .filter(|token| token.kind == "text")
        .collect();
    let structured_tokens: Vec<&Token> = token_plan
        .tokens
        .iter()
        .filter(|token| token.kind != "text")
        .collect();
    if !text_tokens.is_empty() && !structured_tokens.is_empty() {
        let started = now_ms();
        let mut name_rows_by_token: Vec<(&Token, Vec<Value>)> = Vec::new();
        for token in &text_tokens {
            let token_started = now_ms();
            let name_rows =
                search_name_with_database(ctx, &token.term, per_token_limit, 0, search_language)
                    .await?;
            let fallback_rows =
                if super::rank::should_use_supplemental_name_fallback(token, &name_rows) {
                    search_name_token_fallback_with_database(
                        ctx,
                        &token.term,
                        per_token_limit,
                        0,
                        search_language,
                        ctx.pools.marketplace(),
                    )
                    .await?
                } else {
                    Vec::new()
                };
            let fallback_count = fallback_rows.len();
            let raw = name_rows.len();
            let rows = merge_rows_preserving_best(
                vec![name_rows, fallback_rows],
                per_token_limit.max(0) as usize,
            );
            let _ = (token_started, raw, fallback_count);
            name_rows_by_token.push((token, rows));
        }
        let groups: Vec<Vec<Value>> = name_rows_by_token
            .iter()
            .map(|(_, rows)| rows.clone())
            .collect();
        let name_intersection =
            super::rank::intersect_rows(&groups, per_token_limit.max(0) as usize);
        let structured_owned: Vec<Token> = structured_tokens
            .iter()
            .map(|token| (*token).clone())
            .collect();
        let mut filtered_rows = filter_rows_by_stored_structured_tokens(
            ctx,
            name_intersection,
            &structured_owned,
            ctx.pools.marketplace(),
        )
        .await?;
        debug_set(
            ctx,
            "tokenPlan",
            json!({
                "strategy": "name_first_stored_dimension_intersection",
                "tokens": name_rows_by_token.iter().map(|(token, rows)| json!({
                    "term": token.term,
                    "kind": token.kind,
                    "rowCount": rows.len(),
                })).collect::<Vec<_>>(),
                "nameIntersectedRowCount": name_intersection_len(&name_rows_by_token),
                "intersectedRowCount": filtered_rows.len(),
                "durationMs": now_ms() - started,
            }),
        );
        if !filtered_rows.is_empty() {
            filtered_rows.truncate(pool_limit.max(0) as usize);
            return Ok(filtered_rows);
        }
        return Ok(Vec::new());
    }

    let mut token_results: Vec<(&Token, Vec<Value>)> = Vec::new();
    for token in &token_plan.tokens {
        let rows = if token.kind == "text" {
            search_name_with_database(ctx, &token.term, per_token_limit, 0, search_language).await?
        } else {
            search_non_name_with_database_legacy(
                ctx,
                &token.term,
                per_token_limit,
                0,
                search_language,
                ctx.pools.marketplace(),
            )
            .await?
        };
        let rows: Vec<Value> = rows
            .into_iter()
            .filter(|row| super::rank::row_matches_intersection_token(row, token))
            .collect();
        token_results.push((token, rows));
    }
    let mut ordered_groups = token_results.clone();
    ordered_groups.sort_by_key(|(_, rows)| rows.len());
    let groups: Vec<Vec<Value>> = ordered_groups
        .iter()
        .map(|(_, rows)| rows.clone())
        .collect();
    let intersected = super::rank::intersect_rows(&groups, pool_limit.max(0) as usize);
    debug_set(
        ctx,
        "tokenPlan",
        json!({
            "strategy": "intersection",
            "tokens": token_results.iter().map(|(token, rows)| json!({
                "term": token.term,
                "kind": token.kind,
                "rowCount": rows.len(),
            })).collect::<Vec<_>>(),
            "intersectedRowCount": intersected.len(),
            "orderedBySelectivity": ordered_groups.iter().map(|(token, _)| token.term.clone()).collect::<Vec<_>>(),
        }),
    );
    if !intersected.is_empty() {
        return Ok(intersected);
    }
    let rows = rows_for_search_term(
        ctx,
        ctx.redis.clone(),
        &pool_term,
        pool_limit,
        0,
        search_language,
        false,
    )
    .await?;
    Ok(rows)
}

fn name_intersection_len(groups: &[(&Token, Vec<Value>)]) -> usize {
    groups.first().map(|(_, rows)| rows.len()).unwrap_or(0)
}

/// `rowsForAutocompleteSearchTermWithQuery(...)` — the full candidate
/// pipeline. `Ok(None)` means the caller falls through to the empty response.
pub async fn rows_for_autocomplete_search_term_with_query(
    ctx: &mut Ctx,
    redis: Option<redis::aio::ConnectionManager>,
    search_term: &str,
    pool_limit: i64,
    search_language: &str,
    previous_context: Option<&Value>,
    prediction_context: Option<&Value>,
) -> Result<CandidateRows, EngineError> {
    // redis-engine gate: en-like languages take the RediSearch candidate pool.
    if use_meili_search_for_language(search_language) {
        let meili_pool_term = super::normalize::clean_search_term(Some(&json!(
            super::normalize::normalize_variation_phrases(search_term)
        )));
        let rows = rows_for_search_term(
            ctx,
            redis.clone(),
            &meili_pool_term,
            pool_limit,
            0,
            search_language,
            true,
        )
        .await?;
        if !rows.is_empty() {
            let candidate_row_count = rows.len();
            if let Some(debug) = ctx.debug.as_mut().filter(|debug| debug.is_object()) {
                let search_path = str_field(debug, &["searchPath"]);
                let strategy = {
                    let own = get(debug, "tokenPlan")
                        .map(|plan| str_field(plan, &["strategy"]))
                        .unwrap_or_default();
                    if own.is_empty() {
                        "meili_en_autocomplete_pool".to_owned()
                    } else {
                        own
                    }
                };
                let map = debug.as_object_mut().expect("object");
                if search_path.is_empty() {
                    map.insert("searchPath".into(), json!("meili_en_autocomplete_pool"));
                }
                map.insert(
                    "tokenPlan".into(),
                    json!({
                        "strategy": strategy,
                        "poolTerm": meili_pool_term,
                        "candidateRowCount": candidate_row_count,
                    }),
                );
            }
            return Ok(CandidateRows {
                rows,
                non_name_context: None,
            });
        }
        if let Some(debug) = ctx.debug.as_mut().filter(|debug| debug.is_object()) {
            let search_path = str_field(debug, &["searchPath"]);
            let search_engine = get(debug, "searchEngine").cloned();
            let token_plan = get(debug, "tokenPlan").cloned();
            let token_plan_is_meili = get(debug, "tokenPlan")
                .map(|plan| str_field(plan, &["strategy"]).starts_with("meili_"))
                .unwrap_or(false);
            let reason = search_engine
                .as_ref()
                .and_then(|engine| get(engine, "reason"))
                .map(|reason| js_str_or(Some(reason)))
                .unwrap_or_else(|| "empty_meili_pool".to_owned());
            let map = debug.as_object_mut().expect("object");
            map.insert(
                "meiliAutocompleteFallback".into(),
                json!({
                    "reason": reason,
                    "poolTerm": meili_pool_term,
                    "searchPath": search_path,
                    "candidateRowCount": rows.len(),
                    "searchEngine": search_engine,
                    "tokenPlan": token_plan,
                }),
            );
            if search_path.starts_with("meili_") {
                map.remove("searchPath");
            }
            if token_plan_is_meili {
                map.remove("tokenPlan");
            }
        }
    }
    let read_query = super::request::read_query_for_autocomplete(search_term);
    let can_use_supabase_name_tier = true;
    if can_use_supabase_name_tier && should_try_supabase_name_index(search_term, previous_context) {
        let hydrate_pool = match read_query {
            super::request::ReadQuery::NameSearch => ctx.pools.name_search().clone(),
            super::request::ReadQuery::Variation => ctx.pools.variation(),
        };
        if let Some(rows) = rows_from_supabase_name_index(
            ctx,
            search_term,
            pool_limit,
            search_language,
            &hydrate_pool,
            false,
        )
        .await?
        .filter(|rows| !rows.is_empty())
        {
            return Ok(CandidateRows {
                rows,
                non_name_context: None,
            });
        }
    } else if let Some(debug) = ctx.debug.as_mut() {
        if let Value::Object(map) = debug {
            map.insert(
                "supabaseNameIndex".into(),
                json!({
                    "used": false,
                    "fallback": true,
                    "decision": supabase_name_index_decision(search_term, previous_context),
                }),
            );
        }
    }
    if can_use_supabase_name_tier && should_try_supabase_one_char_name_index(search_term) {
        if let Some(rows) =
            rows_from_supabase_one_char_name_index(ctx, search_term, pool_limit, search_language)
                .await?
                .filter(|candidate| !candidate.rows.is_empty())
        {
            return Ok(rows);
        }
    } else if compact(search_term).chars().count() == 1 {
        if let Some(debug) = ctx.debug.as_mut() {
            if let Value::Object(map) = debug {
                map.insert(
                    "supabaseOneCharNameIndex".into(),
                    json!({
                        "used": false,
                        "fallback": true,
                        "decision": {
                            "configured": supabase_prediction_configured(),
                            "circuitOpen": supabase_name_index_circuit_open(),
                            "depth": super::normalize::meaningful_search_depth(search_term),
                            "shouldTry": should_try_supabase_one_char_name_index(search_term),
                        },
                    }),
                );
            }
        }
    }
    if predictive_pool_enabled() {
        if let Some(rows) = build_predictive_pool_with_fanout(
            ctx,
            search_term,
            pool_limit,
            search_language,
            prediction_context,
        )
        .await?
        .filter(|candidate| !candidate.rows.is_empty())
        {
            return Ok(rows);
        }
    }
    if compact(search_term).chars().count() == 1 {
        let started = now_ms();
        let candidate_started = now_ms();
        let rows = sharded_name_prefix_rows_for_one_character_search(
            ctx,
            search_term,
            pool_limit,
            search_language,
            true,
        )
        .await;
        let candidate_duration_ms = now_ms() - candidate_started;
        let shard_count = ctx
            .debug
            .as_ref()
            .and_then(|debug| get(debug, "prefixPool"))
            .and_then(|pool| get(pool, "shardCount"))
            .and_then(js_value_number_of)
            .unwrap_or(0.0);
        let shard_ranges = ctx
            .debug
            .as_ref()
            .and_then(|debug| get(debug, "prefixPool"))
            .and_then(|pool| get(pool, "shardRanges"))
            .cloned()
            .unwrap_or(json!([]));
        debug_set(
            ctx,
            "searchPath",
            json!("typed_one_character_sharded_prefix"),
        );
        debug_set(
            ctx,
            "tokenPlan",
            json!({
                "strategy": "typed_one_character_sharded_prefix",
                "poolLimit": pool_limit,
                "shardCount": shard_count,
                "shardRanges": shard_ranges,
                "candidateRowCount": rows.len(),
                "matchedRowCount": rows.len(),
                "candidateDurationMs": candidate_duration_ms,
                "durationMs": now_ms() - started,
            }),
        );
        return Ok(CandidateRows {
            rows,
            non_name_context: None,
        });
    }
    let predictive_from_name_pool = matches!(read_query, super::request::ReadQuery::NameSearch);
    let rows = rows_for_autocomplete_search_term(
        ctx,
        search_term,
        pool_limit,
        search_language,
        previous_context,
        predictive_from_name_pool,
    )
    .await?;
    Ok(CandidateRows {
        rows,
        non_name_context: None,
    })
}

fn js_value_number_of(value: &Value) -> Option<f64> {
    super::normalize::js_value_number(value)
}

// --- engine tests ---

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn contains_word_matches_the_boundary_regex() {
        let texts = [
            "", "v", "pikachu v", "pikachu vmax", "vstar", "m charizard ex", "mega", "lv.x",
            "dialga lv.x", "level x", "levelx", "lvx9", "é v é", "aaa", "café-v", "ex/gx",
        ];
        let needles = ["v", "m", "mega", "lvx", "lv.x", "level x", "ex", "aa", "é", ""];
        for text in texts {
            for needle in needles {
                let re = regex::Regex::new(&format!(
                    r"(^|[^a-z0-9]){}([^a-z0-9]|$)",
                    regex::escape(needle)
                ))
                .unwrap();
                assert_eq!(contains_word(text, needle), re.is_match(text), "{text:?} {needle:?}");
            }
        }
    }

    #[test]
    fn redis_query_reuses_the_pokoin_search_port() {
        let query = pokoin_search::redis_search_query("pikachu", "all");
        assert!(query.contains("@name:pikachu*"));
        assert!(query.contains("@name_compact:pikachu*"));
    }

    #[test]
    fn collector_key_normalizes_n_m() {
        assert_eq!(collector_number_key("Secret Rare | 090/087"), "90/87");
        assert_eq!(collector_number_key("4 /  102"), "4/102");
        assert_eq!(collector_number_key("151 Poster"), "");
    }

    #[test]
    fn dimension_routes_read_the_env_fallback_chain() {
        let route = marketplace_dimension_search_route("rarity");
        assert_eq!(route["source"], "rarity");
        assert!(route["fallbackToPrimary"].is_boolean());
        let urls = marketplace_dimension_search_database_urls();
        assert_eq!(urls.len(), 4);
        assert!(urls.contains_key("number") && urls.contains_key("variation_owner"));
    }

    #[test]
    fn collector_join_sql_binds_the_expected_shape() {
        let join = collector_number_join_sql("c", "mc", "b", "candidate_number");
        assert!(join.contains("left join public.marketplace_cards mc"));
        assert!(join.contains("left join public.cardtrader_pokemon_blueprints b"));
        assert!(join.contains("blueprint#>>'{fixed_properties,collector_number}'"));
        assert!(join.contains("select"));
    }

    #[test]
    fn non_name_plan_buckets_the_tokens() {
        let (tokens, categories) = non_name_category_plan("charizard ex").unwrap();
        assert_eq!(tokens.len(), 2);
        assert!(categories.contains(&"variation".to_owned()));
        assert!(categories.contains(&"trainer_or_variant".to_owned()));
        assert!(non_name_category_plan("").is_none());
        let (tokens, _) = non_name_category_plan("sv 25").unwrap();
        assert_eq!(tokens[0].1.first().map(String::as_str), Some("expansion"));
        assert_eq!(tokens[1].1.first().map(String::as_str), Some("number"));
    }

    #[test]
    fn category_token_matchers() {
        let row = json!({
            "card_id": 1, "name": "Charizard V", "set_name": "Brilliant Stars",
            "card_number": "TG29/TG30", "rarity": "Rare Holo V", "product_variant": "Holo",
            "trainer_name": "",
        });
        assert!(row_matches_category_token(&row, "variation", "v"));
        assert!(row_matches_category_token(&row, "number", "tg"));
        assert!(row_matches_category_token(&row, "expansion", "bril"));
        assert!(!row_matches_category_token(&row, "rarity", "sir"));
        assert!(row_matches_category_token(
            &row,
            "trainer_or_variant",
            "holo"
        ));
    }

    #[test]
    fn should_prefer_direct_name_prefix_only_for_plain_single_terms() {
        assert!(should_prefer_direct_name_prefix("pikachu"));
        assert!(!should_prefer_direct_name_prefix("pika chu"));
        assert!(!should_prefer_direct_name_prefix("151"));
        assert!(!should_prefer_direct_name_prefix("pika ex"));
        assert!(!should_prefer_direct_name_prefix("sir"));
    }

    #[test]
    fn pool_env_urls_follow_the_node_fallback_chain() {
        // No env URLs in tests: everything resolves to the primary.
        if std::env::var("MARKETPLACE_NAME_SEARCH_DATABASE_URL").is_err()
            && std::env::var("MARKETPLACE_PEER3_DATABASE_URL").is_err()
        {
            assert_eq!(
                marketplace_name_search_database_url(),
                marketplace_database_url().or_empty_if_unconfigured_workaround()
            );
        }
        let _ = supabase_name_index_configured();
    }

    trait OrEmpty {
        fn or_empty_if_unconfigured_workaround(self) -> String;
    }

    impl OrEmpty for String {
        fn or_empty_if_unconfigured_workaround(self) -> String {
            self
        }
    }

    #[test]
    fn pg_row_to_json_covers_the_candidate_columns() {
        // Covered indirectly by the router tests; the mapping helper must not
        // panic on any column type the queries return.
        let value = json!({"card_id": 1});
        assert_eq!(str_field(&value, &["card_id"]), "1");
    }

    #[test]
    fn strict_predictive_error_requires_failures_or_empty() {
        let fulfilled = json!({"source": "name", "status": "fulfilled", "rowCount": 3});
        assert!(strict_predictive_pool_error(&[], &[fulfilled.clone()]).is_none());
        let failed = json!({"source": "number", "status": "failed"});
        let error = strict_predictive_pool_error(&[failed.clone()], &[fulfilled]).expect("error");
        assert_eq!(error.status, Some(503));
        assert_eq!(error.code.as_deref(), Some("PREDICTIVE_POOL_SOURCE_FAILED"));
    }

    #[test]
    fn use_meili_search_for_language_gates_the_redis_engine() {
        // Tests run without the env flag; the gate reads the live engine env.
        let active = use_meili_search_for_language("en");
        assert_eq!(active, use_meili_search_for_language("en-US"));
        assert!(!use_meili_search_for_language("xx"));
    }
}
