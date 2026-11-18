//! `revert` — put every row the fix moved back the way it was, one
//! `observed_day` per transaction, using nothing but the backup table.

use sqlx::postgres::PgConnection;
use sqlx::{Connection, Transaction};

use crate::ident;
use crate::preflight;
use crate::query;
use crate::sql;
use crate::Report;

pub async fn revert(conn: &mut PgConnection, backup: &str) -> Result<Report, String> {
    preflight::refuse_replica(conn, "revert").await?;
    preflight::take_lock(conn).await?;
    preflight::require_backup(conn, backup, "revert").await?;
    let table = ident::qualified(backup);

    let mut report = Report::default();
    let days = preflight::backed_up_days(conn, backup).await?;
    report.landed(format!(
        "revert: public.\"{backup}\" speaks for {} days",
        days.len()
    ));
    let mut restored = 0u64;
    let mut deleted = 0u64;
    for (done, day) in days.iter().enumerate() {
        let did = match revert_day(conn, &table, day).await {
            Ok(did) => did,
            Err(error) => {
                report.stopped("revert", days.len(), done, day);
                return Err(error);
            }
        };
        restored += did.0;
        deleted += did.1;
        report.landed(format!(
            "{day}  restored {:>8}  deleted {:>8}",
            did.0, did.1
        ));
    }
    let left = query::count(
        conn,
        "counting what the backup table still holds",
        sqlx::query(&sql::backup_rows(&table)),
    )
    .await?;
    report.landed(format!(
        "revert: {restored} rows back to their old values, {deleted} backup rows removed, {left} left in the backup table"
    ));
    if left != 0 {
        report.fail("the backup table still holds rows: revert did not finish");
    }
    Ok(report)
}

/// One day, one transaction: read the old values out of the backup table, write
/// them back, and delete exactly those backup rows in the same transaction, so
/// a revert is never half done.
async fn revert_day(conn: &mut PgConnection, table: &str, day: &str) -> Result<(u64, u64), String> {
    let mut tx: Transaction<'_, sqlx::Postgres> = conn
        .begin()
        .await
        .map_err(|error| query::why(&format!("opening the transaction for {day}"), error))?;
    query::run(
        &mut tx,
        "setting the lock timeout",
        sqlx::query(sql::LOCK_TIMEOUT),
    )
    .await?;

    let collect = sql::revert_temp(table);
    query::run(
        &mut tx,
        &format!("reading the old values of {day}"),
        sqlx::query(&collect).bind(day),
    )
    .await?;

    let write = sql::revert_write();
    let restored = query::run(
        &mut tx,
        &format!("restoring the old values of {day}"),
        sqlx::query(&write),
    )
    .await?;

    let remove = sql::revert_delete(table);
    let deleted = query::run(
        &mut tx,
        &format!("removing the recorded rows of {day}"),
        sqlx::query(&remove),
    )
    .await?;

    // Both statements work from the same temporary rows: a restore that found
    // no backup row, or a backup row dropped without restoring its analytics
    // row, would leave the fix half undone. Roll the day back instead.
    if restored != deleted {
        return Err(format!(
            "{day}: restored {restored} rows but removed {deleted} backup rows; the transaction was rolled back"
        ));
    }
    tx.commit()
        .await
        .map_err(|error| query::why(&format!("committing {day}"), error))?;
    Ok((restored, deleted))
}
