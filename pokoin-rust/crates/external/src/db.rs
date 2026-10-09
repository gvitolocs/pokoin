//! Marketplace Postgres access with the two invariants the Node code guards:
//! **game isolation** (each marketplace game has its own database) and
//! **writer routing** (writes must land on the writer pool; the Pi read pool
//! is a hot standby where every write fails read-only).

use std::collections::HashMap;

use serde_json::{json, Value};
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};


use crate::error::{ApiError, ApiResult};

/// The ingest-game table from `_cardtrader_game_ingest.js` (id → env / db).
pub const INGEST_GAMES: [(&str, &str, &str); 24] = [
    ("magic", "MAGIC_MARKETPLACE_DATABASE_URL", "pokoin_magic"),
    ("yugioh", "YUGIOH_MARKETPLACE_DATABASE_URL", "pokoin_yugioh"),
    ("flesh_and_blood", "FLESH_AND_BLOOD_MARKETPLACE_DATABASE_URL", "pokoin_flesh_and_blood"),
    ("digimon", "DIGIMON_MARKETPLACE_DATABASE_URL", "pokoin_digimon"),
    ("dragon_ball_super", "DRAGON_BALL_SUPER_MARKETPLACE_DATABASE_URL", "pokoin_dragon_ball_super"),
    ("vanguard", "VANGUARD_MARKETPLACE_DATABASE_URL", "pokoin_vanguard"),
    ("one_piece", "ONE_PIECE_MARKETPLACE_DATABASE_URL", "pokoin_one_piece"),
    ("lorcana", "LORCANA_MARKETPLACE_DATABASE_URL", "pokoin_lorcana"),
    ("star_wars", "STAR_WARS_MARKETPLACE_DATABASE_URL", "pokoin_star_wars"),
    ("union_arena", "UNION_ARENA_MARKETPLACE_DATABASE_URL", "pokoin_union_arena"),
    ("riftbound", "RIFTBOUND_MARKETPLACE_DATABASE_URL", "pokoin_riftbound"),
    ("gundam", "GUNDAM_MARKETPLACE_DATABASE_URL", "pokoin_gundam"),
    ("sorcery", "SORCERY_MARKETPLACE_DATABASE_URL", "pokoin_sorcery"),
    ("palworld", "PALWORLD_MARKETPLACE_DATABASE_URL", "pokoin_palworld"),
    ("cyberpunk", "CYBERPUNK_MARKETPLACE_DATABASE_URL", "pokoin_cyberpunk"),
    ("weiss_schwarz", "WEISS_SCHWARZ_MARKETPLACE_DATABASE_URL", "pokoin_weiss_schwarz"),
    ("final_fantasy", "FINAL_FANTASY_MARKETPLACE_DATABASE_URL", "pokoin_final_fantasy"),
    ("force_of_will", "FORCE_OF_WILL_MARKETPLACE_DATABASE_URL", "pokoin_force_of_will"),
    ("world_of_warcraft", "WORLD_OF_WARCRAFT_MARKETPLACE_DATABASE_URL", "pokoin_world_of_warcraft"),
    ("battle_spirits_saga", "BATTLE_SPIRITS_SAGA_MARKETPLACE_DATABASE_URL", "pokoin_battle_spirits_saga"),
    ("star_wars_destiny", "STAR_WARS_DESTINY_MARKETPLACE_DATABASE_URL", "pokoin_star_wars_destiny"),
    ("dragon_born", "DRAGON_BORN_MARKETPLACE_DATABASE_URL", "pokoin_dragon_born"),
    ("my_little_pony", "MY_LITTLE_PONY_MARKETPLACE_DATABASE_URL", "pokoin_my_little_pony"),
    ("the_spoils", "THE_SPOILS_MARKETPLACE_DATABASE_URL", "pokoin_the_spoils"),
];

pub fn normalize_game(value: &str) -> String {
    pokoin_api_common::game::normalize_game(value)
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
    writer_game: std::sync::Arc<tokio::sync::Mutex<HashMap<String, PgPool>>>,
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
        let cached = self.writer_game.lock().await.get(&normalized).cloned();
        let pool = if normalized == "pokemon" {
            self.writer()?
        } else if let Some(pool) = cached {
            pool
        } else {
            let url = writer_url_for_game(&normalized);
            if url.is_empty() {
                return Err(ApiError::new(503, "marketplace writer database is not configured."));
            }
            let pool = build_pool(&url, 4).await?;
            self.writer_game.lock().await.insert(normalized.clone(), pool.clone());
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
/// value: null, bool, number, string; an array of scalars is a Postgres
/// array literal (text[], cast in SQL like `$1::bigint[]`), and objects or
/// arrays of objects are JSONB.
struct BindValue<'a>(&'a Value);

/// `["1", 2, null]` -> `Some(vec![Some("1"), Some("2"), None])`; `None` when
/// any element is an object or array (that value binds as JSONB).
fn scalar_array(value: &Value) -> Option<Vec<Option<String>>> {
    let items = value.as_array()?;
    items
        .iter()
        .map(|item| match item {
            Value::Null => Some(None),
            Value::String(s) => Some(Some(s.clone())),
            Value::Number(n) => Some(Some(n.to_string())),
            Value::Bool(b) => Some(Some(b.to_string())),
            _ => None,
        })
        .collect()
}

impl<'a> sqlx::Encode<'a, sqlx::Postgres> for BindValue<'a> {
    fn produces(&self) -> Option<sqlx::postgres::PgTypeInfo> {
        Some(match self.0 {
            Value::Null | Value::String(_) => <String as sqlx::Type<sqlx::Postgres>>::type_info(),
            Value::Bool(_) => <bool as sqlx::Type<sqlx::Postgres>>::type_info(),
            Value::Number(n) => match n.as_i64() {
                Some(i) if i32::try_from(i).is_ok() => <i32 as sqlx::Type<sqlx::Postgres>>::type_info(),
                Some(_) => <i64 as sqlx::Type<sqlx::Postgres>>::type_info(),
                None => <f64 as sqlx::Type<sqlx::Postgres>>::type_info(),
            },
            array @ Value::Array(_) if scalar_array(array).is_some() => {
                <Vec<Option<String>> as sqlx::Type<sqlx::Postgres>>::type_info()
            }
            _ => <sqlx::types::Json<Value> as sqlx::Type<sqlx::Postgres>>::type_info(),
        })
    }
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
            array @ Value::Array(_) => match scalar_array(array) {
                Some(items) => items.encode_by_ref(buf),
                None => sqlx::types::Json(array).encode_by_ref(buf),
            },
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
    rows.iter().map(pokoin_api_common::pg::row_to_node_json).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn binary_bind_types_match_the_encoded_value() {
        use sqlx::{Encode, TypeInfo};
        for (value, ty) in [(json!(239324),"INT4"),(json!(9007199254740991_i64),"INT8"),(json!(true),"BOOL"),(json!(1.5),"FLOAT8"),(json!("119662"),"TEXT"),(json!({"x":1}),"JSONB")] {
            assert_eq!(BindValue(&value).produces().unwrap().name(),ty);
        }
    }

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
        assert_eq!(writer_url_for_game("yugioh"), "postgres://w:5432/pokoin_yugioh");
        std::env::remove_var("MARKETPLACE_WRITER_DATABASE_URL");
    }
}
