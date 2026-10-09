//! sqlx plumbing shared by the SQL helper ports: run a verbatim Node SQL
//! statement and get the rows back as JSON objects.
//!
//! Node passed whole `pg` rows through (`result.rows`), so the Rust port
//! wraps each verbatim statement as `select to_jsonb(q) as row from (<sql>) q`
//! — identical column names, JSON numbers/strings/bools where `pg` parsed
//! them into JS values. Bind values are attached in `$n` order.

use serde_json::Value;
use sqlx::PgPool;
use sqlx::Row;

/// One `$n` bind value (the Node `values` array entries).
#[derive(Debug, Clone)]
pub(crate) enum SqlBind {
    Text(String),
    Int(i64),
    TextArray(Vec<String>),
    BigIntArray(Vec<i64>),
}

/// Execute `sql` (verbatim) and return one JSON object per row, typed the way
/// node-pg typed `result.rows` (int8/numeric strings, ISO dates, parsed json).
pub(crate) async fn rows_json(
    pool: &PgPool,
    sql: &str,
    binds: &[SqlBind],
) -> Result<Vec<Value>, sqlx::Error> {
    let binds: Vec<pokoin_api_common::pg::Bind> = binds
        .iter()
        .map(|bind| match bind {
            SqlBind::Text(value) => pokoin_api_common::pg::Bind::Text(value.clone()),
            SqlBind::Int(value) => pokoin_api_common::pg::Bind::Int(*value),
            SqlBind::TextArray(value) => pokoin_api_common::pg::Bind::TextArray(value.clone()),
            SqlBind::BigIntArray(value) => pokoin_api_common::pg::Bind::BigIntArray(value.clone()),
        })
        .collect();
    pokoin_api_common::pg::pool_rows(pool, sql, &binds).await
}

/// Execute `sql` and return the first row, if any.
pub(crate) async fn row_json(
    pool: &PgPool,
    sql: &str,
    binds: &[SqlBind],
) -> Result<Option<Value>, sqlx::Error> {
    Ok(rows_json(pool, sql, binds).await?.into_iter().next())
}

/// Run a scalar statement and decode its first column of the first row.
pub(crate) async fn scalar<T>(
    pool: &PgPool,
    sql: &str,
    binds: &[SqlBind],
) -> Result<Option<T>, sqlx::Error>
where
    T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin,
{
    let wrapped = format!("select ({sql}) as v");
    let mut query = sqlx::query(&wrapped);
    for bind in binds {
        query = match bind {
            SqlBind::Text(value) => query.bind(value.as_str()),
            SqlBind::Int(value) => query.bind(*value),
            SqlBind::TextArray(value) => query.bind(value.as_slice()),
            SqlBind::BigIntArray(value) => query.bind(value.as_slice()),
        };
    }
    let row = query.fetch_optional(pool).await?;
    Ok(match row {
        Some(row) => row.try_get::<Option<T>, _>("v")?,
        None => None,
    })
}
