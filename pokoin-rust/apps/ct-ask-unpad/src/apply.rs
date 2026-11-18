//! `apply` — the change itself: one `observed_day` per transaction, and every
//! row is recorded in the backup table in the same transaction that writes it.
//!
//! Each day's line goes out as that day commits, so a run that stops partway
//! says which days are already in the table and which one is not.

use sqlx::postgres::PgConnection;
use sqlx::{Connection, Transaction};

use crate::ident;
use crate::preflight;
use crate::query;
use crate::sql;
use crate::Report;

/// What one day's transaction did: the rows it looked at, and the two writes it
/// made. `recorded` and `written` are the same set by construction — the
/// transaction is rolled back if they ever differ.
struct Day {
    recorded: u64,
    written: u64,
}

pub async fn apply(conn: &mut PgConnection, backup: &str) -> Result<Report, String> {
    preflight::refuse_replica(conn, "apply").await?;
    preflight::take_lock(conn).await?;
    let table = ident::qualified(backup);
    let created = preflight::create_backup(conn, backup).await?;
    let mut report = Report::default();
    report.landed(format!(
        "apply: {} the backup table {table}",
        if created { "created" } else { "using" }
    ));
    // Read before anything is written, because it counts the rows as they stand
    // now. It changes no decision: every row of the window loses the pad.
    let matched = query::native_ask_count(conn).await?;
    report.landed(format!(
        "rows whose padded price equals a Pokoin native listing price: {matched}; \
         every one of them is corrected like the rest of the window"
    ));

    let days = preflight::live_days(conn).await?;
    report.landed(format!("apply: {backup} — {} days in scope", days.len()));
    let mut seen = 0i64;
    let mut recorded = 0i64;
    let mut written = 0i64;
    for (done, day) in days.iter().enumerate() {
        let rows = match query::one_day_count(
            conn,
            &format!("counting the rows of {day}"),
            sql::ROWS_OF_DAY,
            day,
        )
        .await
        {
            Ok(rows) => rows,
            Err(error) => {
                report.stopped("apply", days.len(), done, day);
                return Err(error);
            }
        };
        let did = match apply_day(conn, &table, backup, day).await {
            Ok(did) => did,
            Err(error) => {
                report.stopped("apply", days.len(), done, day);
                return Err(error);
            }
        };
        seen += rows;
        recorded += i64::try_from(did.recorded).unwrap_or(i64::MAX);
        written += i64::try_from(did.written).unwrap_or(i64::MAX);
        report.landed(format!(
            "{day}  rows {rows:>8}  recorded {:>8}  written {:>8}",
            did.recorded, did.written
        ));
    }
    report.landed(String::new());
    report.landed(format!(
        "apply: {seen} rows read, {recorded} old values recorded in {backup}, {written} rows written"
    ));
    if written == 0 {
        report.landed(
            "nothing was written: the rows are already right or already recorded".to_string(),
        );
    } else {
        report.landed(format!("run verify --backup-table {backup} to prove it"));
    }
    Ok(report)
}

/// One day, one transaction: collect the rows the rule touches, record their
/// old values, write the new ones, and only then commit.
///
/// `table` is the quoted backup name, `backup` the bare one.
async fn apply_day(
    conn: &mut PgConnection,
    table: &str,
    backup: &str,
    day: &str,
) -> Result<Day, String> {
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

    let collect = sql::create_temp(Some(backup));
    query::run(
        &mut tx,
        &format!("collecting the rows the rule touches on {day}"),
        query::bind_scope(sqlx::query(&collect), day),
    )
    .await?;

    let record = sql::record_old_values(table);
    let recorded = query::run(
        &mut tx,
        &format!("recording the old values of {day}"),
        sqlx::query(&record),
    )
    .await?;
    let write = sql::write_day();
    let written = query::run(
        &mut tx,
        &format!("writing the corrected prices of {day}"),
        sqlx::query(&write),
    )
    .await?;

    // The two statements read the same temporary rows with the same predicate,
    // so a backup of a row that was not written — or a write with no backup
    // behind it, which could never be reverted — is a bug, not a fact about the
    // data. Roll the day back rather than commit it.
    if recorded != written {
        return Err(format!(
            "{day}: recorded {recorded} old values but wrote {written} rows; the transaction was rolled back"
        ));
    }
    tx.commit()
        .await
        .map_err(|error| query::why(&format!("committing {day}"), error))?;
    Ok(Day { recorded, written })
}
