//! The checks a command makes before it trusts what it is reading or writing.

use sqlx::postgres::PgConnection;

use crate::query;
use crate::sql;

/// A replica answers `apply` and `revert` exactly like the writer does, so a
/// run against one reports work it will lose. `pg_is_in_recovery()` is the
/// question the server cannot answer wrongly.
pub async fn refuse_replica(conn: &mut PgConnection, stage: &str) -> Result<(), String> {
    let recovering = query::count(
        conn,
        &format!("{stage}: is this host a replica"),
        sqlx::query(sql::IS_REPLICA),
    )
    .await?;
    if recovering != 0 {
        return Err(format!(
            "{stage} refuses to run on a replica: this host is still recovering. \
             Run it on the writer."
        ));
    }
    Ok(())
}

/// One write run at a time, on this host and every other: `apply` and `revert`
/// take [`crate::LOCK_KEY`] as a session lock before they write anything and
/// hold it until the process ends. It is tried, never waited for, so a second
/// terminal that starts while the first is still running is refused at once
/// rather than queueing behind it and repeating the work.
pub async fn take_lock(conn: &mut PgConnection) -> Result<(), String> {
    let row = query::row(
        conn,
        "taking the run lock",
        sqlx::query(sql::TRY_LOCK).bind(crate::LOCK_KEY),
    )
    .await?;
    if !query::boolean(&row, "taken")? {
        return Err(
            "another apply or revert already holds the run lock: nothing was changed. \
             Wait for that run to finish."
                .to_string(),
        );
    }
    Ok(())
}

/// The columns the backup table has to carry: the key and the six old values.
/// `fixed_at` has a default and is not checked for, only for the record.
pub fn expected_columns() -> Vec<&'static str> {
    let mut names = vec!["observed_day", "blueprint_id"];
    names.extend_from_slice(&sql::OLD_COLUMNS);
    names
}

pub async fn backup_exists(conn: &mut PgConnection, bare: &str) -> Result<bool, String> {
    let present = query::count(
        conn,
        "looking for the backup table",
        sqlx::query(sql::BACKUP_EXISTS).bind(crate::ident::qualified(bare)),
    )
    .await?;
    Ok(present != 0)
}

/// How many of the columns this tool writes are actually there.
pub async fn shape(conn: &mut PgConnection, bare: &str) -> Result<i64, String> {
    query::count(
        conn,
        "reading the shape of the backup table",
        sqlx::query(sql::BACKUP_SHAPE)
            .bind(bare)
            .bind(expected_columns()),
    )
    .await
}

/// The backup table is there and holds the columns the fix needs.
pub async fn require_backup(
    conn: &mut PgConnection,
    bare: &str,
    stage: &str,
) -> Result<(), String> {
    if !backup_exists(conn, bare).await? {
        return Err(format!(
            "{stage}: the backup table {bare} does not exist. \
             It records what apply changed; without it nothing can be proved or undone."
        ));
    }
    let columns = shape(conn, bare).await?;
    let wanted = expected_columns().len() as i64;
    if columns != wanted {
        return Err(format!(
            "{stage}: the backup table {bare} carries {columns} of the {wanted} columns \
             this fix writes, so it is not a table this tool made."
        ));
    }
    Ok(())
}

/// Make the backup table if it is not there yet, then prove its shape. A table
/// of the same name that is not ours is refused rather than written into. The
/// answer says whether this call created it.
pub async fn create_backup(conn: &mut PgConnection, bare: &str) -> Result<bool, String> {
    let existed = backup_exists(conn, bare).await?;
    if !existed {
        query::run(
            conn,
            "creating the backup table",
            sqlx::query(&sql::create_backup(&crate::ident::qualified(bare))),
        )
        .await?;
    }
    let columns = shape(conn, bare).await?;
    let wanted = expected_columns().len() as i64;
    if columns != wanted {
        return Err(format!(
            "apply: the table {bare} carries {columns} of the {wanted} columns this fix \
             writes. {}, so it is not a table this tool made.",
            if existed {
                "It was already there"
            } else {
                "It was created but is missing them"
            }
        ));
    }
    Ok(!existed)
}

/// One text column per row, in the order the statement returns.
pub async fn texts(
    conn: &mut PgConnection,
    stage: &str,
    statement: query::Statement<'_>,
) -> Result<Vec<String>, String> {
    let rows = query::rows(conn, stage, statement).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(query::text(row, "observed_day")?);
    }
    Ok(out)
}

/// The days this tool is allowed to speak for, from the live table.
pub async fn live_days(conn: &mut PgConnection) -> Result<Vec<String>, String> {
    texts(
        conn,
        "listing the days the fix touches",
        query::bind_calendar(sqlx::query(sql::FIXED_DAYS), ""),
    )
    .await
}

/// Every day the calendar says should be spoken for, whether the live table has
/// rows for it or not. `plan` walks this list so a missing day is visible.
pub async fn calendar_days(conn: &mut PgConnection) -> Result<Vec<String>, String> {
    texts(
        conn,
        "listing the days of the padded window",
        query::bind_calendar(sqlx::query(sql::CALENDAR), ""),
    )
    .await
}

/// The days already recorded in the backup table.
pub async fn backed_up_days(conn: &mut PgConnection, bare: &str) -> Result<Vec<String>, String> {
    texts(
        conn,
        "listing the days recorded in the backup table",
        sqlx::query(&sql::backup_days(&crate::ident::qualified(bare))),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_backup_table_carries_the_key_and_the_six_old_values() {
        assert_eq!(
            expected_columns(),
            vec![
                "observed_day",
                "blueprint_id",
                "min_price_pkn",
                "median_price_pkn",
                "average_price_pkn",
                "max_price_pkn",
                "previous_min_price_pkn",
                "price_change_pct",
            ]
        );
    }
}
