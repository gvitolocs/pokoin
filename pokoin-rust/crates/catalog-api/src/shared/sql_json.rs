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

/// Execute `sql` (verbatim) and return one JSON object per row.
pub(crate) async fn rows_json(
    pool: &PgPool,
    sql: &str,
    binds: &[SqlBind],
) -> Result<Vec<Value>, sqlx::Error> {
    let wrapped = format!("select to_jsonb(q) as row from ({sql}) q");
    let mut query = sqlx::query(&wrapped);
    for bind in binds {
        query = match bind {
            SqlBind::Text(value) => query.bind(value.as_str()),
            SqlBind::Int(value) => query.bind(*value),
            SqlBind::TextArray(value) => query.bind(value.as_slice()),
            SqlBind::BigIntArray(value) => query.bind(value.as_slice()),
        };
    }
    let rows = query.fetch_all(pool).await?;
    let mut values = Vec::with_capacity(rows.len());
    for row in &rows {
        // pg handed every jsonb number to JS as a double; mirror that round
        // trip so `22.0` serializes as `22` exactly like the reference.
        values.push(crate::shared::js::js_normalize(
            &row.try_get::<Value, _>("row")?,
        ));
    }
    Ok(values)
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
