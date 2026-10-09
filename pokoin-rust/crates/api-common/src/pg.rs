//! Rows exactly as node-postgres hands them to the Node handlers.
//!
//! node-pg (default type parsers, process TZ = UTC on the Pi) returns `int8`
//! and `numeric` as strings, `int2/int4/float` as numbers, `json(b)` parsed,
//! `timestamptz/timestamp/date` as JS `Date` (serialized by `res.json` as
//! `toISOString()`), and arrays element-wise with the same rules. Handlers
//! that pass rows through (`res.json(rows)`) therefore expose those types, so
//! the native port must reproduce them instead of `to_jsonb` typing.

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use serde_json::{Map, Number, Value};
use sqlx::postgres::{PgArguments, PgRow};
use sqlx::{Arguments, Column, PgPool, Row, TypeInfo, ValueRef};

/// One `$n` value of the Node `values` array.
#[derive(Clone, Debug)]
pub enum Bind {
    Text(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    Json(Value),
    TextArray(Vec<String>),
    BigIntArray(Vec<i64>),
    NullText,
    NullBool,
}

fn arguments(binds: &[Bind]) -> PgArguments {
    let mut args = PgArguments::default();
    for bind in binds {
        let _ = match bind {
            Bind::Text(v) => args.add(v.clone()),
            Bind::Int(v) => args.add(*v),
            Bind::Float(v) => args.add(*v),
            Bind::Bool(v) => args.add(*v),
            Bind::Json(v) => args.add(sqlx::types::Json(v.clone())),
            Bind::TextArray(v) => args.add(v.clone()),
            Bind::BigIntArray(v) => args.add(v.clone()),
            Bind::NullText => args.add(Option::<String>::None),
            Bind::NullBool => args.add(Option::<bool>::None),
        };
    }
    args
}

/// `query(sql, values).rows` with node-pg typing, column order preserved.
pub async fn node_rows<'e, E>(executor: E, sql: &str, binds: &[Bind]) -> Result<Vec<Value>, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let rows = sqlx::query_with(sql, arguments(binds)).fetch_all(executor).await?;
    Ok(rows.iter().map(row_to_node_json).collect())
}

/// Convenience over a pool.
pub async fn pool_rows(pool: &PgPool, sql: &str, binds: &[Bind]) -> Result<Vec<Value>, sqlx::Error> {
    node_rows(pool, sql, binds).await
}

/// `result.rowCount` of a write.
pub async fn execute(pool: &PgPool, sql: &str, binds: &[Bind]) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query_with(sql, arguments(binds)).execute(pool).await?.rows_affected())
}

/// A JS number (`22.0` -> `22`, non-finite -> null like `JSON.stringify`).
pub fn js_number(n: f64) -> Value {
    if !n.is_finite() {
        return Value::Null;
    }
    if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        return Value::Number(Number::from(n as i64));
    }
    Number::from_f64(n).map(Value::Number).unwrap_or(Value::Null)
}

/// `Date.prototype.toISOString()`.
pub fn iso(dt: DateTime<Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn row_to_node_json(row: &PgRow) -> Value {
    let mut map = Map::new();
    for (i, column) in row.columns().iter().enumerate() {
        map.insert(column.name().to_owned(), cell(row, i, column.type_info().name()));
    }
    Value::Object(map)
}

fn is_null(row: &PgRow, i: usize) -> bool {
    row.try_get_raw(i).map(|v| v.is_null()).unwrap_or(true)
}

fn cell(row: &PgRow, i: usize, ty: &str) -> Value {
    if is_null(row, i) {
        return Value::Null;
    }
    let text = |v: Option<String>| v.map(Value::String).unwrap_or(Value::Null);
    match ty {
        "INT2" => row.try_get::<i16, _>(i).map(|v| Value::from(v)).unwrap_or(Value::Null),
        "INT4" => row.try_get::<i32, _>(i).map(Value::from).unwrap_or(Value::Null),
        "OID" => row.try_get::<sqlx::postgres::types::Oid, _>(i).map(|v| Value::from(v.0)).unwrap_or(Value::Null),
        "INT8" => text(row.try_get::<i64, _>(i).ok().map(|v| v.to_string())),
        "NUMERIC" => text(row.try_get::<sqlx::types::BigDecimal, _>(i).ok().map(|v| v.to_string())),
        "FLOAT4" => row.try_get::<f32, _>(i).map(|v| js_number(f64::from(v))).unwrap_or(Value::Null),
        "FLOAT8" => row.try_get::<f64, _>(i).map(js_number).unwrap_or(Value::Null),
        "BOOL" => row.try_get::<bool, _>(i).map(Value::Bool).unwrap_or(Value::Null),
        "JSON" | "JSONB" => row.try_get::<Value, _>(i).unwrap_or(Value::Null),
        "TIMESTAMPTZ" => text(row.try_get::<DateTime<Utc>, _>(i).ok().map(iso)),
        "TIMESTAMP" => text(row.try_get::<NaiveDateTime, _>(i).ok().map(|v| iso(v.and_utc()))),
        "DATE" => text(row.try_get::<NaiveDate, _>(i).ok().and_then(|d| d.and_hms_opt(0, 0, 0)).map(|v| iso(v.and_utc()))),
        "UUID" => text(row.try_get::<sqlx::types::Uuid, _>(i).ok().map(|v| v.to_string())),
        "TEXT[]" | "VARCHAR[]" | "BPCHAR[]" | "NAME[]" | "CITEXT[]" => row
            .try_get::<Vec<Option<String>>, _>(i)
            .map(|v| Value::Array(v.into_iter().map(text).collect()))
            .unwrap_or(Value::Null),
        "INT8[]" => row
            .try_get::<Vec<Option<i64>>, _>(i)
            .map(|v| Value::Array(v.into_iter().map(|x| text(x.map(|n| n.to_string()))).collect()))
            .unwrap_or(Value::Null),
        "INT4[]" => row
            .try_get::<Vec<Option<i32>>, _>(i)
            .map(|v| Value::Array(v.into_iter().map(|x| x.map(Value::from).unwrap_or(Value::Null)).collect()))
            .unwrap_or(Value::Null),
        "INT2[]" => row
            .try_get::<Vec<Option<i16>>, _>(i)
            .map(|v| Value::Array(v.into_iter().map(|x| x.map(Value::from).unwrap_or(Value::Null)).collect()))
            .unwrap_or(Value::Null),
        "NUMERIC[]" => row
            .try_get::<Vec<Option<sqlx::types::BigDecimal>>, _>(i)
            .map(|v| Value::Array(v.into_iter().map(|x| text(x.map(|n| n.to_string()))).collect()))
            .unwrap_or(Value::Null),
        "FLOAT8[]" | "FLOAT4[]" => row
            .try_get::<Vec<Option<f64>>, _>(i)
            .map(|v| Value::Array(v.into_iter().map(|x| x.map(js_number).unwrap_or(Value::Null)).collect()))
            .unwrap_or(Value::Null),
        "BOOL[]" => row
            .try_get::<Vec<Option<bool>>, _>(i)
            .map(|v| Value::Array(v.into_iter().map(|x| x.map(Value::Bool).unwrap_or(Value::Null)).collect()))
            .unwrap_or(Value::Null),
        "JSON[]" | "JSONB[]" => row
            .try_get::<Vec<Option<Value>>, _>(i)
            .map(|v| Value::Array(v.into_iter().map(|x| x.unwrap_or(Value::Null)).collect()))
            .unwrap_or(Value::Null),
        "TIMESTAMPTZ[]" => row
            .try_get::<Vec<Option<DateTime<Utc>>>, _>(i)
            .map(|v| Value::Array(v.into_iter().map(|x| text(x.map(iso))).collect()))
            .unwrap_or(Value::Null),
        "UUID[]" => row
            .try_get::<Vec<Option<sqlx::types::Uuid>>, _>(i)
            .map(|v| Value::Array(v.into_iter().map(|x| text(x.map(|u| u.to_string()))).collect()))
            .unwrap_or(Value::Null),
        // TEXT, VARCHAR, BPCHAR, NAME, CHAR, CITEXT, enums and anything text-like.
        _ => match row.try_get::<String, _>(i) {
            Ok(v) => Value::String(v),
            Err(_) => row.try_get_unchecked::<String, _>(i).map(Value::String).unwrap_or_else(|error| {
                tracing::warn!(column_type = ty, %error, "unsupported column type for node-pg typing");
                Value::Null
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_and_dates_match_js() {
        assert_eq!(js_number(22.0), Value::from(22));
        assert_eq!(js_number(0.5), serde_json::json!(0.5));
        assert_eq!(js_number(f64::NAN), Value::Null);
        let dt = DateTime::parse_from_rfc3339("2026-10-08T22:09:31.097123+00:00").unwrap().with_timezone(&Utc);
        assert_eq!(iso(dt), "2026-10-08T22:09:31.097Z");
    }
}
