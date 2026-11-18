//! `verify` — read-only proof that the change happened the way the rule says,
//! and that nothing outside the rule moved. Every check is a count that has to
//! be zero; the exit status is non-zero if any of them is not.

use sqlx::postgres::PgConnection;

use crate::ident;
use crate::preflight;
use crate::query;
use crate::sql;
use crate::Report;
use crate::BEFORE_WINDOW_DAY;

pub async fn verify(conn: &mut PgConnection, backup: &str) -> Result<Report, String> {
    preflight::require_backup(conn, backup, "verify").await?;
    let table = ident::qualified(backup);
    let mut report = Report::default();
    report.line(format!("verify: public.\"{backup}\" against the rule"));

    let recorded = query::count(
        conn,
        "counting the rows of the backup table",
        sqlx::query(&sql::backup_rows(&table)),
    )
    .await?;
    report.line(format!("the backup table holds {recorded} rows"));

    // A row of the window that carries the pad, is not protected by a native
    // ask and is not recorded: apply missed it.
    let missed = sql::missing_from_backup(&table);
    let missed = query::scoped_count(
        conn,
        "looking for padded rows the backup table does not record",
        &missed,
        "",
    )
    .await?;
    query::expect_zero(
        &mut report,
        "every padded row of the window is recorded or protected by a native ask",
        missed,
        "rows still holding the pad and unknown to the backup table",
    );

    // What the backup says the old value was, against what the live table holds
    // now: exactly the pad lower for a row that lost it.
    let prices = sql::backup_price_mismatch(&table);
    let prices = query::scoped_count(
        conn,
        "comparing the live prices of the recorded rows with the backup",
        &prices,
        "",
    )
    .await?;
    query::expect_zero(
        &mut report,
        "a recorded row holds its old value minus the pad in all four price columns",
        prices,
        "recorded rows whose live price is not what the rule gives",
    );

    // The job's own definition of the two comparison columns, on the series as
    // it now stands.
    let cast = pct_cast(conn, &mut report).await?;
    let previous = sql::previous_rule_mismatch(&cast);
    let previous = query::count(
        conn,
        "re-deriving previous_min_price_pkn and price_change_pct",
        query::bind_calendar(sqlx::query(&previous), ""),
    )
    .await?;
    query::expect_zero(
        &mut report,
        "previous_min_price_pkn and price_change_pct hold the nightly job's values",
        previous,
        "priced rows of the window and of the day after it whose comparison value is wrong",
    );

    // Nothing outside the rule moved.
    let gone = sql::backup_rows_missing(&table);
    let gone = query::count(
        conn,
        "looking for recorded rows that are no longer in the live table",
        sqlx::query(&gone),
    )
    .await?;
    query::expect_zero(
        &mut report,
        "every recorded row is still a row of the live table",
        gone,
        "backup rows with no analytics row behind them",
    );

    let guard = sql::backup_out_of_scope(&table);
    let row = query::row(
        conn,
        "checking which days the backup table speaks for",
        query::bind_calendar(sqlx::query(&guard), BEFORE_WINDOW_DAY),
    )
    .await?;
    let outside = query::integer(&row, "rows_of_other_days")?;
    query::expect_zero(
        &mut report,
        "the backup table records no day outside the window and the day after it",
        outside,
        "rows of days this fix never writes",
    );
    let neighbour = query::integer(&row, "rows_of_guard_day")?;
    query::expect_zero(
        &mut report,
        &format!("{BEFORE_WINDOW_DAY}, the day before the window, was never written"),
        neighbour,
        "rows of that day recorded as changed",
    );

    // Completeness: the same rule, re-planned with the backup table in hand,
    // has nothing left to do.
    let again = sql::plan_total(Some(backup));
    let row = query::row(
        conn,
        "asking the rule whether anything is left to change",
        query::bind_scope(sqlx::query(&again), ""),
    )
    .await?;
    let left = query::integer(&row, "rows_to_change")?;
    query::expect_zero(
        &mut report,
        "a plan run now finds nothing left to change",
        left,
        "rows the rule still wants to move",
    );

    let days = preflight::backed_up_days(conn, backup).await?;
    report.line(format!(
        "the backup table speaks for {} days: {}",
        days.len(),
        days.join(", ")
    ));
    if !report.failed() {
        report.line("verify: the stored asks of the window are un-padded".to_string());
    }
    Ok(report)
}

/// The cast that puts `price_change_pct`'s own numeric shape on the value the
/// check derives, so the comparison is against the number the column can hold
/// rather than against forty digits of division.
async fn pct_cast(conn: &mut PgConnection, report: &mut Report) -> Result<String, String> {
    let row = query::row(
        conn,
        "reading the type of price_change_pct",
        sqlx::query(sql::COLUMN_TYPE),
    )
    .await?;
    let type_name = query::text(&row, "column_type")?;
    let cast = sql::pct_cast(&type_name);
    if cast.is_empty() {
        // Not a plain numeric family type, so the check compares the value as
        // it comes out of the division. Say which comparison that is.
        report.line(format!(
            "note: price_change_pct is {type_name}; the comparison column is checked as it is derived"
        ));
        return Ok(String::new());
    }
    report.line(format!(
        "note: price_change_pct is {type_name}; the derived value is compared as {cast}"
    ));
    Ok(cast)
}
