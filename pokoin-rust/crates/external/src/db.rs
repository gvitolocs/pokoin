//! Marketplace Postgres access with the two invariants the Node code guards:
//! **game isolation** (each marketplace game has its own database) and
//! **writer routing** (writes must land on the writer pool; the Pi read pool
//! is a hot standby where every write fails read-only).

use std::collections::HashMap;

use serde_json::{json, Map, Value};
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Column, Row, TypeInfo};

use crate::error::{ApiError, ApiResult};

/// The ingest-game table from `_cardtrader_game_ingest.js` (id → env / db).
pub const INGEST_GAMES: [(&str, &str, &str); 8] = [
    // (id, databaseUrlEnv, database)
    ("magic", "MARKETPLACE_MAGIC_DATABASE_URL", "marketplace_magic"),
    ("yugioh", "MARKETPLACE_YUGIOH_DATABASE_URL", "marketplace_yugioh"),
    ("flesh_and_blood", "MARKETPLACE_FAB_DATABASE_URL", "marketplace_fab"),
    ("one_piece", "MARKETPLACE_ONE_PIECE_DATABASE_URL", "marketplace_one_piece"),
    ("lorcana", "MARKETPLACE_LORCANA_DATABASE_URL", "marketplace_lorcana"),
    ("star_wars", "MARKETPLACE_STAR_WARS_DATABASE_URL", "marketplace_star_wars"),
    ("union_arena", "MARKETPLACE_UNION_ARENA_DATABASE_URL", "marketplace_union_arena"),
    ("digimon", "MARKETPLACE_DIGIMON_DATABASE_URL", "marketplace_digimon"),
];

/// `normalizeGame` — unknown/blank maps to pokemon, dashes fold to underscores.
pub fn normalize_game(value: &str) -> String {
    let raw: String = value.trim().to_lowercase().replace('-', "_");
    if raw.is_empty() || raw == "pokemon" || raw == "poke" || raw == "default" {
        return "pokemon".into();
    }
    if INGEST_GAMES.iter().any(|(id, _, _)| *id == raw) {
        return raw;
    }
    "pokemon".into()
}

pub fn is_pokemon_game(game: &str) -> bool {
    normalize_game(game) == "pokemon"
}

fn env_first(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()))
}

/// `marketplaceDatabaseUrl()` — the pokemon read pool URL.
pub fn marketplace_database_url() -> String {
    env_first(&["MARKETPLACE_DATABASE_URL", "MARKETPLACE_PEER4_DATABASE_URL"]).unwrap_or_default()
}

/// `marketplaceWriterDatabaseUrl()` — writer first, read URL as fallback.
pub fn marketplace_writer_database_url() -> String {
    env_first(&["MARKETPLACE_WRITER_DATABASE_URL"]).unwrap_or_else(marketplace_database_url)
}

/// `databaseUrlForGame` — explicit env per game, else same host with the
/// game's database path swapped in.
pub fn database_url_for_game(game: &str) -> String {
    let normalized = normalize_game(game);
    if normalized == "pokemon" {
        return marketplace_database_url();
    }
    let (_, env_name, database) =
        INGEST_GAMES.iter().find(|(id, _, _)| *id == normalized).expect("normalized game is in table");
    if let Some(explicit) = env_first(&[env_name]) {
        return explicit;
    }
    derive_database_url(&marketplace_database_url(), database)
}

fn derive_database_url(base: &str, database: &str) -> String {
    if base.is_empty() {
        return String::new();
    }
    match base.rfind('/') {
        Some(index) if index >= "postgres://".len() - 1 => format!("{}/{}", &base[..index], database),
        _ => String::new(),
    }
}

async fn build_pool(url: &str, max: u32) -> ApiResult<PgPool> {
    if url.is_empty() {
        return Err(ApiError::new(500, "MARKETPLACE_DATABASE_URL is not configured."));
    }
    // Node strips sslmode unless SSL_VERIFY=1; sqlx rustls handles TLS itself,
    // so strip the param for parity (never verify off/on against rustls config).
    let cleaned = strip_sslmode(url);
    PgPoolOptions::new()
        .max_connections(max.max(1))
        .acquire_timeout(std::time::Duration::from_millis(8000))
        .connect(&cleaned)
        .await
        .map_err(|error| ApiError::new(500, format!("marketplace database connect failed: {error}")))
}

fn strip_sslmode(url: &str) -> String {
    let (base, query) = match url.split_once('?') {
        Some(parts) => parts,
        None => return url.to_string(),
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|part| !part.to_lowercase().starts_with("sslmode="))
        .collect();
    if kept.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{}", kept.join("&"))
    }
}

/// Per-game pools + the shared writer pool. Cloneable (sqlx pools are Arc'd).
/// `DbPools::disconnected()` builds a state with no pools — every query then
/// fails with a 503-style error, which tests use to prove a handler gates on
/// validation before ever touching the database.
#[derive(Clone, Default)]
pub struct DbPools {
    reads: std::sync::Arc<tokio::sync::Mutex<HashMap<String, PgPool>>>,
    writer: Option<PgPool>,
    writer_game: std::sync::Arc<std::sync::OnceLock<PgPool>>,
}

impl DbPools {
    /// Build pools without dialing Postgres. The shared API creates these at
    /// startup so a database outage cannot block the HTTP bind.
    pub fn lazy(read: PgPool, writer: PgPool) -> Self {
        let mut reads = HashMap::new();
        reads.insert("pokemon".to_string(), read);
        Self {
            reads: std::sync::Arc::new(tokio::sync::Mutex::new(reads)),
            writer: Some(writer),
            writer_game: Default::default(),
        }
    }

    pub async fn from_env(pool_max: u32) -> ApiResult<Self> {
        let writer = build_pool(&marketplace_writer_database_url(), pool_max).await?;
        Ok(Self {
            reads: Default::default(),
            writer: Some(writer),
            writer_game: Default::default(),
        })
    }

    /// A pools set with no connection — queries fail cleanly instead of panicking.
    pub fn disconnected() -> Self {
        Self::default()
    }

    /// Read pool for a game (lazy, cached per game).
    pub async fn read(&self, game: &str) -> ApiResult<PgPool> {
        let normalized = normalize_game(game);
        if let Some(pool) = self.reads.lock().await.get(&normalized) {
            return Ok(pool.clone());
        }
        let url = database_url_for_game(&normalized);
        if url.is_empty() {
            return Err(ApiError::new(503, "marketplace database is not configured."));
        }
        let pool = build_pool(&url, 4).await?;
        self.reads.lock().await.insert(normalized, pool.clone());
        Ok(pool)
    }

    /// The writer pool (`getMarketplaceWriterPool`).
    pub fn writer(&self) -> ApiResult<PgPool> {
        self.writer.clone().ok_or_else(|| ApiError::new(503, "marketplace writer database is not configured."))
    }

    /// `marketplaceQuery` — game-scoped read.
    pub async fn query(&self, game: &str, sql: &str, params: &[Value]) -> ApiResult<Vec<Value>> {
        let pool = self.read(game).await?;
        let rows = bound_query(sql, params).fetch_all(&pool).await?;
        Ok(rows_to_json(&rows))
    }

    /// `marketplaceWriteQuery` — writer, always pokemon-routing games that
    /// share the shared writer (non-pokemon games each get their own writer
    /// URL derived the same way as reads).
    pub async fn write(&self, game: &str, sql: &str, params: &[Value]) -> ApiResult<Vec<Value>> {
        let normalized = normalize_game(game);
        let pool = if normalized == "pokemon" {
            self.writer()?
        } else if let Some(pool) = self.writer_game.get() {
            pool.clone()
        } else {
            let url = writer_url_for_game(&normalized);
            if url.is_empty() {
                return Err(ApiError::new(503, "marketplace writer database is not configured."));
            }
            let pool = build_pool(&url, 4).await?;
            let _ = self.writer_game.set(pool.clone());
            pool
        };
        let rows = bound_query(sql, params).fetch_all(&pool).await?;
        Ok(rows_to_json(&rows))
    }
}

/// Build a query with serde_json params bound like node-postgres would.
fn bound_query<'q>(sql: &'q str, params: &'q [Value]) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    let mut query = sqlx::query(sql);
    for value in params {
        query = query.bind(BindValue(value));
    }
    query
}

fn writer_url_for_game(game: &str) -> String {
    let (_, env_name, database) =
        INGEST_GAMES.iter().find(|(id, _, _)| *id == game).expect("game in table");
    env_first(&[env_name]).unwrap_or_else(|| derive_database_url(&marketplace_writer_database_url(), database))
}

/// Bind a serde_json value the way node-postgres would bind the equivalent JS
/// value: null, bool, number, string, or JSONB for objects/arrays.
struct BindValue<'a>(&'a Value);

impl<'a> sqlx::Encode<'a, sqlx::Postgres> for BindValue<'a> {
    fn encode_by_ref(
        &self,
        buf: &mut <sqlx::Postgres as sqlx::Database>::ArgumentBuffer<'a>,
    ) -> Result<sqlx::encode::IsNull, Box<dyn std::error::Error + Send + Sync>> {
        match self.0 {
            Value::Null => Option::<String>::None.encode_by_ref(buf),
            Value::Bool(b) => b.encode_by_ref(buf),
            Value::Number(n) => {
                if let Some(int) = n.as_i64() {
                    // Bind small ints as INT4 (limit/qty columns); large as INT8.
                    if int >= i32::MIN as i64 && int <= i32::MAX as i64 {
                        (int as i32).encode_by_ref(buf)
                    } else {
                        int.encode_by_ref(buf)
                    }
                } else {
                    n.as_f64().unwrap_or(0.0).encode_by_ref(buf)
                }
            }
            Value::String(s) => s.encode_by_ref(buf),
            other => sqlx::types::Json(other).encode_by_ref(buf),
        }
    }
}

impl<'a> sqlx::Type<sqlx::Postgres> for BindValue<'a> {
    fn type_info() -> <sqlx::Postgres as sqlx::Database>::TypeInfo {
        <String as sqlx::Type<sqlx::Postgres>>::type_info()
    }
}

/// Convert a pg row to a serde_json object like node-postgres would hand back
/// a JS object: strings, numbers, booleans, nulls, and JSONB passthrough.
pub fn rows_to_json(rows: &[PgRow]) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let mut object = Map::new();
            for column in row.columns() {
                let name = column.name();
                let value = column_to_json(row, column.type_info().clone(), name);
                object.insert(name.to_string(), value);
            }
            Value::Object(object)
        })
        .collect()
}

fn column_to_json(row: &PgRow, info: sqlx::postgres::PgTypeInfo, name: &str) -> Value {
    let kind = info.name().to_uppercase();
    macro_rules! get {
        ($ty:ty) => {
            match row.try_get::<Option<$ty>, _>(name) {
                Ok(Some(value)) => value,
                Ok(None) => return Value::Null,
                Err(_) => return Value::Null,
            }
        };
    }
    match kind.as_str() {
        "BOOL" => Value::Bool(get!(bool)),
        "INT2" | "SMALLINT" => json!(get!(i16)),
        "INT4" | "INTEGER" => json!(get!(i32)),
        "INT8" | "BIGINT" => json!(get!(i64)),
        "FLOAT4" | "REAL" => json!(get!(f32)),
        "FLOAT8" | "DOUBLE PRECISION" => json!(get!(f64)),
        "NUMERIC" => {
            // NUMERIC comes back as string in node-postgres only for big values;
            // sqlx gives f64 with the rust_decimal feature off — parse text form.
            match row.try_get::<Option<String>, _>(name) {
                Ok(Some(text)) => text.parse::<f64>().map(|n| json!(n)).unwrap_or(Value::String(text)),
                _ => Value::Null,
            }
        }
        "JSON" | "JSONB" => match row.try_get::<Option<sqlx::types::Json<Value>>, _>(name) {
            Ok(Some(value)) => value.0,
            _ => Value::Null,
        },
        "TIMESTAMPTZ" | "TIMESTAMP WITH TIME ZONE" => {
            match row.try_get::<Option<time::OffsetDateTime>, _>(name) {
                Ok(Some(stamp)) => Value::String(crate::time_util::iso_from_offset(stamp)),
                _ => Value::Null,
            }
        }
        "TIMESTAMP" | "TIMESTAMP WITHOUT TIME ZONE" => {
            match row.try_get::<Option<time::PrimitiveDateTime>, _>(name) {
                Ok(Some(stamp)) => Value::String(crate::time_util::iso_from_primitive(stamp)),
                _ => Value::Null,
            }
        }
        "UUID" => match row.try_get::<Option<uuid::Uuid>, _>(name) {
            Ok(Some(value)) => Value::String(value.to_string()),
            _ => Value::Null,
        },
        _ => match row.try_get::<Option<String>, _>(name) {
            Ok(Some(text)) => Value::String(text),
            _ => Value::Null,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_normalization_matches_reference() {
        assert_eq!(normalize_game(""), "pokemon");
        assert_eq!(normalize_game("default"), "pokemon");
        assert_eq!(normalize_game("POKEMON"), "pokemon");
        assert_eq!(normalize_game("one-piece"), "one_piece");
        assert_eq!(normalize_game("one_piece"), "one_piece");
        assert_eq!(normalize_game("bogus"), "pokemon");
    }

    #[test]
    fn sslmode_is_stripped_like_node() {
        assert_eq!(strip_sslmode("postgres://h/db?sslmode=require&x=1"), "postgres://h/db?x=1");
        assert_eq!(strip_sslmode("postgres://h/db"), "postgres://h/db");
        assert_eq!(strip_sslmode("postgres://h/db?sslmode=no-verify"), "postgres://h/db");
    }

    #[test]
    fn writer_url_falls_back_to_derived_path() {
        std::env::remove_var("MARKETPLACE_YUGIOH_DATABASE_URL");
        std::env::set_var("MARKETPLACE_WRITER_DATABASE_URL", "postgres://w:5432/marketplace");
        assert_eq!(writer_url_for_game("yugioh"), "postgres://w:5432/marketplace_yugioh");
        std::env::remove_var("MARKETPLACE_WRITER_DATABASE_URL");
    }
}
