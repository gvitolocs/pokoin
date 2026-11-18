//! Reading values out of the rows these statements return. Every accessor
//! reports which column it failed on and never panics on a NULL it did not ask
//! for.

use sqlx::postgres::{PgArguments, PgConnection, PgRow};
use sqlx::query::Query;
use sqlx::Row;

use crate::report::Report;
use crate::{PAD_FROM, PAD_PKN, PAD_TO, PREVIOUS_DAY};

/// A statement built by [`crate::sql`] with the slots this module binds.
pub type Statement<'q> = Query<'q, sqlx::Postgres, PgArguments>;

/// Why a statement failed, with the stage the operator reads instead of a
/// driver backtrace. The SQL text is never repeated: it carries no secret, but
/// a failure message can quote the parameter values it was given.
pub fn why(stage: &str, error: sqlx::Error) -> String {
    format!("{stage}: {error}")
}

/// The shared slots `$1` to `$5`: the day, the window, the previous-value day
/// and the pad. Pass an empty day for a statement scoped to the whole window.
pub fn bind_scope<'q>(query: Statement<'q>, day: &'q str) -> Statement<'q> {
    query
        .bind(day)
        .bind(PAD_FROM)
        .bind(PAD_TO)
        .bind(PREVIOUS_DAY)
        .bind(PAD_PKN)
}

/// The same slots without the pad, for a statement whose highest slot is `$4`.
pub fn bind_calendar<'q>(query: Statement<'q>, day: &'q str) -> Statement<'q> {
    query
        .bind(day)
        .bind(PAD_FROM)
        .bind(PAD_TO)
        .bind(PREVIOUS_DAY)
}

pub async fn rows(
    conn: &mut PgConnection,
    stage: &str,
    query: Statement<'_>,
) -> Result<Vec<PgRow>, String> {
    query
        .fetch_all(&mut *conn)
        .await
        .map_err(|error| why(stage, error))
}

pub async fn row(
    conn: &mut PgConnection,
    stage: &str,
    query: Statement<'_>,
) -> Result<PgRow, String> {
    query
        .fetch_one(&mut *conn)
        .await
        .map_err(|error| why(stage, error))
}

pub async fn run(
    conn: &mut PgConnection,
    stage: &str,
    query: Statement<'_>,
) -> Result<u64, String> {
    query
        .execute(&mut *conn)
        .await
        .map(|result| result.rows_affected())
        .map_err(|error| why(stage, error))
}

/// A statement that returns one number.
pub async fn count(
    conn: &mut PgConnection,
    stage: &str,
    query: Statement<'_>,
) -> Result<i64, String> {
    one_count(&row(conn, stage, query).await?)
}

/// A `count(*)` of the shared slots.
pub async fn scoped_count(
    conn: &mut PgConnection,
    stage: &str,
    sql: &str,
    day: &str,
) -> Result<i64, String> {
    count(conn, stage, bind_scope(sqlx::query(sql), day)).await
}

/// A `count(*)` of a statement whose only parameter is the day.
pub async fn one_day_count(
    conn: &mut PgConnection,
    stage: &str,
    sql: &str,
    day: &str,
) -> Result<i64, String> {
    count(conn, stage, sqlx::query(sql).bind(day)).await
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub rows_seen: i64,
    pub rows_priced: i64,
    pub rows_to_change: i64,
    pub blueprints_to_change: i64,
    pub rows_unpadded: i64,
    pub rows_previous_only: i64,
    pub rows_skipped_native: i64,
    pub rows_already_fixed: i64,
    pub rows_unpriced: i64,
}

impl Counts {
    pub fn from_row(row: &PgRow) -> Result<Self, String> {
        Ok(Self {
            rows_seen: integer(row, "rows_seen")?,
            rows_priced: integer(row, "rows_priced")?,
            rows_to_change: integer(row, "rows_to_change")?,
            blueprints_to_change: integer(row, "blueprints_to_change")?,
            rows_unpadded: integer(row, "rows_unpadded")?,
            rows_previous_only: integer(row, "rows_previous_only")?,
            rows_skipped_native: integer(row, "rows_skipped_native")?,
            rows_already_fixed: integer(row, "rows_already_fixed")?,
            rows_unpriced: integer(row, "rows_unpriced")?,
        })
    }

    pub fn plus(&mut self, other: &Self) {
        self.rows_seen += other.rows_seen;
        self.rows_priced += other.rows_priced;
        self.rows_to_change += other.rows_to_change;
        self.rows_unpadded += other.rows_unpadded;
        self.rows_previous_only += other.rows_previous_only;
        self.rows_skipped_native += other.rows_skipped_native;
        self.rows_already_fixed += other.rows_already_fixed;
        self.rows_unpriced += other.rows_unpriced;
    }
}

pub fn text(row: &PgRow, column: &str) -> Result<String, String> {
    row.try_get::<String, _>(column)
        .map_err(|error| format!("column {column}: {error}"))
}

/// A column that may legitimately be NULL, such as a price or a previous value.
pub fn optional_text(row: &PgRow, column: &str) -> Result<Option<String>, String> {
    row.try_get::<Option<String>, _>(column)
        .map_err(|error| format!("column {column}: {error}"))
}

pub fn boolean(row: &PgRow, column: &str) -> Result<bool, String> {
    row.try_get::<bool, _>(column)
        .map_err(|error| format!("column {column}: {error}"))
}

/// A count, which Postgres hands back as `bigint` and a filter as `bigint` too;
/// an `integer` is accepted so the read does not depend on the planner's choice.
pub fn integer(row: &PgRow, column: &str) -> Result<i64, String> {
    if let Ok(value) = row.try_get::<i64, _>(column) {
        return Ok(value);
    }
    row.try_get::<i32, _>(column)
        .map(i64::from)
        .map_err(|error| format!("column {column}: {error}"))
}

/// A single count, or the reason the statement could not be read.
pub fn one_count(row: &PgRow) -> Result<i64, String> {
    integer(row, "count")
}

/// One `count(*)` that has to be zero for the data to be right.
pub fn expect_zero(report: &mut Report, name: &str, value: i64, detail: impl Into<String>) {
    if value == 0 {
        report.line(format!("ok       {name}"));
        return;
    }
    report.fail(format!("MISMATCH {name}: {value} ({})", detail.into()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_add_up_across_days() {
        let mut total = Counts {
            rows_seen: 2,
            rows_priced: 1,
            rows_to_change: 1,
            blueprints_to_change: 1,
            rows_unpadded: 1,
            rows_previous_only: 0,
            rows_skipped_native: 0,
            rows_already_fixed: 0,
            rows_unpriced: 1,
        };
        let day = Counts {
            rows_seen: 3,
            rows_priced: 2,
            rows_to_change: 0,
            blueprints_to_change: 0,
            rows_unpadded: 0,
            rows_previous_only: 1,
            rows_skipped_native: 1,
            rows_already_fixed: 2,
            rows_unpriced: 1,
        };
        total.plus(&day);
        assert_eq!(total.rows_seen, 5);
        assert_eq!(total.rows_to_change, 1);
        assert_eq!(total.rows_already_fixed, 2);
        assert_eq!(total.rows_unpriced, 2);
        // The cross-day distinct count is not a sum: it is read from the whole
        // window in one statement instead.
        assert_eq!(total.blueprints_to_change, 1);
    }
}
