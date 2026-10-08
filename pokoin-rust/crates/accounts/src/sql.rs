//! Postgres access for the **existing** Pokoin marketplace read model.
//!
//! Several accounts routes read tables that already exist and are owned by the
//! catalog/read-model pipeline (`marketplace_search_candidates`,
//! `marketplace_user_listings`, `cheapest_homepage_cache_blueprint`,
//! `marketplace_card_urls`, `marketplace_cardtrader_1dr_assets`,
//! `assistant_user_current_pages`, …). This module is a thin, read-mostly
//! client for them.
//!
//! It deliberately creates **no** tables: `sql/` is empty and no DDL lives in
//! this crate. Money, ledger and identity contracts stay in Firestore (see
//! `state.rs` and the commerce worker's `store::apply`).
//!
//! Rows are decoded into `serde_json::Value` so a handler can return the same
//! JSON shape the Node handler built from `result.rows`, without a bespoke
//! struct per query.

use std::sync::Arc;

use serde_json::{json, Map, Value as Json};
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::{Column, Row, TypeInfo};

use crate::error::ApiError;

/// A bound parameter. Kept small on purpose: these routes only ever bind text,
/// integers, floats, text arrays and nulls.
#[derive(Debug, Clone, PartialEq)]
pub enum SqlParam {
    Text(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    /// `text[]`, for `= any($1)` / `= $1` array comparisons.
    TextArray(Vec<String>),
    /// `bigint[]`, for the `card_id = any($1::bigint[])` lookups.
    IntArray(Vec<i64>),
    /// A nullable text/int column (the Node `x ? value : null` pattern).
    OptText(Option<String>),
    OptInt(Option<i64>),
    Json(Json),
    Null,
}

impl From<&str> for SqlParam {
    fn from(value: &str) -> Self {
        SqlParam::Text(value.to_string())
    }
}

impl From<String> for SqlParam {
    fn from(value: String) -> Self {
        SqlParam::Text(value)
    }
}

impl From<i64> for SqlParam {
    fn from(value: i64) -> Self {
        SqlParam::Int(value)
    }
}

impl From<f64> for SqlParam {
    fn from(value: f64) -> Self {
        SqlParam::Float(value)
    }
}

impl From<bool> for SqlParam {
    fn from(value: bool) -> Self {
        SqlParam::Bool(value)
    }
}

impl From<Vec<String>> for SqlParam {
    fn from(value: Vec<String>) -> Self {
        SqlParam::TextArray(value)
    }
}

impl From<Vec<i64>> for SqlParam {
    fn from(value: Vec<i64>) -> Self {
        SqlParam::IntArray(value)
    }
}

impl From<Option<String>> for SqlParam {
    fn from(value: Option<String>) -> Self {
        SqlParam::OptText(value)
    }
}

impl From<Option<i64>> for SqlParam {
    fn from(value: Option<i64>) -> Self {
        SqlParam::OptInt(value)
    }
}

/// A Postgres failure, keeping the SQLSTATE so a handler can reproduce the Node
/// behaviour for `42P01` (undefined_table) instead of a blanket 500.
#[derive(Debug, Clone)]
pub struct SqlError {
    pub code: Option<String>,
    pub message: String,
}

impl SqlError {
    /// Postgres `undefined_table`.
    pub fn undefined_table(&self) -> bool {
        self.code.as_deref() == Some("42P01")
    }
}

impl std::fmt::Display for SqlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.code {
            Some(code) => write!(f, "Postgres error {code}: {}", self.message),
            None => write!(f, "Postgres error: {}", self.message),
        }
    }
}

impl std::error::Error for SqlError {}

impl From<SqlError> for ApiError {
    fn from(error: SqlError) -> Self {
        // 42P01 is a deployment state, not a bug: callers branch on it before
        // converting, so reaching here is a genuine 500.
        ApiError::internal(error.to_string())
    }
}

/// The marketplace read-model pool. Cheap to clone.
#[derive(Clone)]
pub struct MarketplaceDb {
    pool: Arc<PgPool>,
}

impl MarketplaceDb {
    /// Connect, with the same tiny timeout discipline as the rest of the crate:
    /// these are interactive routes, not batch jobs.
    pub async fn connect(url: &str, max_connections: u32) -> std::result::Result<Self, SqlError> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections.max(1))
            .acquire_timeout(std::time::Duration::from_millis(2_000))
            .connect(url)
            .await
            .map_err(|error| SqlError {
                code: database_code(&error),
                message: error.to_string(),
            })?;
        Ok(Self {
            pool: Arc::new(pool),
        })
    }

    /// Build a pool without connecting. `DomainState::from_env()` is
    /// synchronous, and these routes must not block boot on the read model.
    pub fn connect_lazy(url: &str, max_connections: u32) -> std::result::Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections.max(1))
            .acquire_timeout(std::time::Duration::from_millis(2_000))
            .connect_lazy(url)?;
        Ok(Self {
            pool: Arc::new(pool),
        })
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self {
            pool: Arc::new(pool),
        }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Run a query and decode every row to JSON, preserving column order.
    pub async fn query_json(
        &self,
        sql: &str,
        params: &[SqlParam],
    ) -> std::result::Result<Vec<Json>, SqlError> {
        let mut query = sqlx::query(sql);
        for param in params {
            query = match param {
                SqlParam::Text(value) => query.bind(value.clone()),
                SqlParam::Int(value) => query.bind(*value),
                SqlParam::Float(value) => query.bind(*value),
                SqlParam::Bool(value) => query.bind(*value),
                SqlParam::TextArray(values) => query.bind(values.clone()),
                SqlParam::IntArray(values) => query.bind(values.clone()),
                SqlParam::OptText(value) => query.bind(value.clone()),
                SqlParam::OptInt(value) => query.bind(*value),
                SqlParam::Json(value) => query.bind(value.clone()),
                SqlParam::Null => query.bind(Option::<String>::None),
            };
        }
        let rows = query.fetch_all(&*self.pool).await.map_err(|error| SqlError {
            code: database_code(&error),
            message: error.to_string(),
        })?;
        Ok(rows.iter().map(row_to_json).collect())
    }

    /// `select to_regclass($1)::text as rel` — the Node `relationExists` probe.
    pub async fn relation_exists(
        &self,
        qualified: &str,
    ) -> std::result::Result<bool, SqlError> {
        let rows = self
            .query_json("select to_regclass($1)::text as rel", &[qualified.into()])
            .await?;
        Ok(rows
            .first()
            .and_then(|row| row.get("rel"))
            .map(|value| !value.is_null())
            .unwrap_or(false))
    }
}

fn database_code(error: &sqlx::Error) -> Option<String> {
    match error {
        sqlx::Error::Database(database) => database.code().map(|code| code.to_string()),
        _ => None,
    }
}

/// Decode one row without a compile-time schema. Types are attempted in a fixed
/// order; anything unexpected becomes JSON null rather than failing the route.
pub fn row_to_json(row: &sqlx::postgres::PgRow) -> Json {
    let mut object = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let name = column.name().to_string();
        let type_name = column.type_info().name().to_ascii_uppercase();
        let value = decode_column(row, index, &type_name);
        object.insert(name, value);
    }
    Json::Object(object)
}

fn decode_column(row: &sqlx::postgres::PgRow, index: usize, type_name: &str) -> Json {
    match type_name {
        "BOOL" => {
            if let Ok(Some(value)) = row.try_get::<Option<bool>, _>(index) {
                return json!(value);
            }
        }
        "INT2" | "INT4" | "INT8" => {
            if let Ok(Some(value)) = row.try_get::<Option<i64>, _>(index) {
                return json!(value);
            }
        }
        "FLOAT4" | "FLOAT8" => {
            if let Ok(Some(value)) = row.try_get::<Option<f64>, _>(index) {
                return json!(value);
            }
        }
        "NUMERIC" => {
            // NUMERIC is not a JSON number in sqlx; go through its decimal text
            // form so money-like columns keep their value.
            if let Ok(Some(value)) = row.try_get::<Option<sqlx::types::BigDecimal>, _>(index) {
                return value
                    .to_string()
                    .parse::<f64>()
                    .map(|number| json!(number))
                    .unwrap_or(Json::Null);
            }
            if let Ok(Some(value)) = row.try_get::<Option<f64>, _>(index) {
                return json!(value);
            }
        }
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CITEXT" | "UNKNOWN" => {
            if let Ok(Some(value)) = row.try_get::<Option<String>, _>(index) {
                return json!(value);
            }
        }
        "JSON" | "JSONB" => {
            if let Ok(Some(value)) = row.try_get::<Option<Json>, _>(index) {
                return value;
            }
        }
        "UUID" => {
            if let Ok(Some(value)) = row.try_get::<Option<sqlx::types::Uuid>, _>(index) {
                return json!(value.to_string());
            }
        }
        "TIMESTAMPTZ" => {
            if let Ok(Some(value)) =
                row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(index)
            {
                return json!(value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            }
        }
        "TIMESTAMP" => {
            if let Ok(Some(value)) = row.try_get::<Option<chrono::NaiveDateTime>, _>(index) {
                return json!(value
                    .and_utc()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            }
        }
        "DATE" => {
            if let Ok(Some(value)) = row.try_get::<Option<chrono::NaiveDate>, _>(index) {
                return json!(value.to_string());
            }
        }
        // Array columns (`_int8`, `int8[]`, …) carry the card-id lists.
        name if name.contains("[]") || name.starts_with('_') || name.ends_with("ARRAY") => {
            if let Ok(Some(values)) = row.try_get::<Option<Vec<i64>>, _>(index) {
                return Json::Array(values.into_iter().map(|value| json!(value)).collect());
            }
            if let Ok(Some(values)) = row.try_get::<Option<Vec<String>>, _>(index) {
                return Json::Array(values.into_iter().map(|value| json!(value)).collect());
            }
            if let Ok(Some(values)) = row.try_get::<Option<Vec<f64>>, _>(index) {
                return Json::Array(values.into_iter().map(|value| json!(value)).collect());
            }
            if let Ok(Some(values)) = row.try_get::<Option<Vec<bool>>, _>(index) {
                return Json::Array(values.into_iter().map(|value| json!(value)).collect());
            }
            return Json::Null;
        }
        _ => {}
    }

    // Unknown or unexpected type: try the common ones (arrays included), then
    // give up as null rather than failing the whole route.
    if let Ok(Some(values)) = row.try_get::<Option<Vec<i64>>, _>(index) {
        return Json::Array(values.into_iter().map(|value| json!(value)).collect());
    }
    if let Ok(Some(values)) = row.try_get::<Option<Vec<String>>, _>(index) {
        return Json::Array(values.into_iter().map(|value| json!(value)).collect());
    }
    if row.try_get::<Option<()>, _>(index).map(|v| v.is_none()).unwrap_or(false) {
        return Json::Null;
    }
    if let Ok(Some(value)) = row.try_get::<Option<String>, _>(index) {
        return json!(value);
    }
    if let Ok(Some(value)) = row.try_get::<Option<i64>, _>(index) {
        return json!(value);
    }
    if let Ok(Some(value)) = row.try_get::<Option<f64>, _>(index) {
        return json!(value);
    }
    if let Ok(Some(value)) = row.try_get::<Option<bool>, _>(index) {
        return json!(value);
    }
    Json::Null
}

/// Read the first non-null `TEXT`-ish value of a row (helper for the handlers).
pub fn row_text(row: &Json, key: &str) -> String {
    row.get(key)
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_string()
}

pub fn row_f64(row: &Json, key: &str) -> f64 {
    row.get(key).and_then(Json::as_f64).unwrap_or(0.0)
}

pub fn row_i64(row: &Json, key: &str) -> i64 {
    row.get(key)
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|number| number as i64))
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_errors_classify_undefined_table() {
        let missing = SqlError {
            code: Some("42P01".into()),
            message: "relation \"assistant_user_current_pages\" does not exist".into(),
        };
        assert!(missing.undefined_table());
        let other = SqlError {
            code: Some("23505".into()),
            message: "duplicate key".into(),
        };
        assert!(!other.undefined_table());
        assert!(other.to_string().contains("23505"));
    }

    #[test]
    fn params_convert_from_rust_values() {
        assert_eq!(SqlParam::from("a"), SqlParam::Text("a".into()));
        assert_eq!(SqlParam::from(7i64), SqlParam::Int(7));
        assert_eq!(SqlParam::from(1.5f64), SqlParam::Float(1.5));
        assert_eq!(SqlParam::from(true), SqlParam::Bool(true));
        assert_eq!(
            SqlParam::from(vec!["a".to_string()]),
            SqlParam::TextArray(vec!["a".to_string()])
        );
    }

    #[test]
    fn every_param_variant_is_constructible() {
        assert_eq!(SqlParam::from(vec![1i64, 2]), SqlParam::IntArray(vec![1, 2]));
        assert_eq!(
            SqlParam::from(Some("a".to_string())),
            SqlParam::OptText(Some("a".to_string()))
        );
        assert_eq!(SqlParam::from(Some(3i64)), SqlParam::OptInt(Some(3)));
        assert_eq!(SqlParam::from(None::<i64>), SqlParam::OptInt(None));
    }

    #[test]
    fn row_helpers_match_javascript_coercion() {
        let row = serde_json::json!({
            "text": "value",
            "number": 2.5,
            "int_as_string": "12",
            "missing": serde_json::Value::Null
        });
        assert_eq!(row_text(&row, "text"), "value");
        assert_eq!(row_text(&row, "missing"), "");
        assert_eq!(row_f64(&row, "number"), 2.5);
        assert_eq!(row_i64(&row, "int_as_string"), 12);
        assert_eq!(row_i64(&row, "missing"), 0);
    }
}
