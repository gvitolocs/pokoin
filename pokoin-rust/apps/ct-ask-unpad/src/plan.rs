//! `plan` — read-only: what the change would do, day by day, with samples.

use sqlx::postgres::PgConnection;

use crate::preflight;
use crate::query;
use crate::sql;
use crate::Report;
use crate::BEFORE_WINDOW_DAY;
use crate::PAD_FROM;
use crate::PAD_PKN;
use crate::PAD_TO;
use crate::PREVIOUS_DAY;
use crate::SAMPLES;

/// The eight count columns of the per-day table, with the header they get.
const COLUMNS: [(&str, &str); 8] = [
    ("rows_seen", "rows"),
    ("rows_priced", "priced"),
    ("rows_to_change", "to change"),
    ("blueprints_to_change", "blueprints"),
    ("rows_unpadded", "un-padded"),
    ("rows_previous_only", "previous"),
    ("rows_already_fixed", "recorded"),
    ("rows_unpriced", "unpriced"),
];

/// Wide enough for the longest title, `previous old`, with a space left over so
/// two columns never read as one.
const WIDTH: usize = 13;
const DAY_WIDTH: usize = 10;

/// Right-aligned in [`WIDTH`], so a table of days lines up.
pub fn pad(text: &str) -> String {
    let mut out = String::new();
    for _ in text.len()..WIDTH {
        out.push(' ');
    }
    out.push_str(text);
    out
}

/// The day column of every table: an ISO date, so ten characters.
pub fn day_column(day: &str) -> String {
    let mut out = String::new();
    for _ in day.len()..DAY_WIDTH {
        out.push(' ');
    }
    out.push_str(day);
    out
}

pub fn header() -> String {
    let mut line = day_column("day");
    for (_, title) in COLUMNS {
        line.push_str(&pad(title));
    }
    line
}

fn row_line(day: &str, counts: &query::Counts) -> String {
    let values = [
        counts.rows_seen,
        counts.rows_priced,
        counts.rows_to_change,
        counts.blueprints_to_change,
        counts.rows_unpadded,
        counts.rows_previous_only,
        counts.rows_already_fixed,
        counts.rows_unpriced,
    ];
    let mut line = day_column(day);
    for value in values {
        line.push_str(&pad(&value.to_string()));
    }
    line
}

pub async fn plan(conn: &mut PgConnection, named: Option<&str>) -> Result<Report, String> {
    let mut report = Report::default();
    report.line(format!(
        "plan: {PAD_FROM} to {PAD_TO} lose the {PAD_PKN} PKN shipping pad in the four price columns"
    ));
    report.line(format!(
        "plan: {PREVIOUS_DAY} keeps its prices and loses the padded value it compares against"
    ));
    // A plan is what the lead reads before the first apply, and the first apply
    // is what makes the table. A named table that is not there yet is said so
    // and treated as none: `plan` never creates anything.
    let exists = match named {
        Some(name) => preflight::backup_exists(conn, name).await?,
        None => false,
    };
    let backup = if exists { named } else { None };
    report.line(match (named, exists) {
        (Some(name), true) => format!(
            "backup: public.\"{name}\" holds the rows already changed; a row it holds is never touched again"
        ),
        (Some(name), false) => format!(
            "backup: public.\"{name}\" does not exist yet, so this counts every row the rule touches"
        ),
        (None, _) => "backup: none named, so this counts every row the rule touches".to_string(),
    });
    report.line(String::new());
    report.line(header());

    let days = preflight::calendar_days(conn).await?;
    let body = sql::plan_days(backup);
    let rows = query::rows(
        conn,
        "counting the rows of each day",
        query::bind_scope(sqlx::query(&body), ""),
    )
    .await?;
    let mut counted: Vec<(String, query::Counts)> = Vec::with_capacity(rows.len());
    for row in &rows {
        counted.push((
            query::text(row, "observed_day")?,
            query::Counts::from_row(row)?,
        ));
    }

    let mut total = query::Counts::default();
    for day in &days {
        match counted.iter().find(|(seen, _)| seen == day) {
            Some((_, counts)) => {
                total.plus(counts);
                report.line(row_line(day, counts));
            }
            None => report.line(format!(
                "{}  no rows stored that day: nothing to un-pad",
                day_column(day)
            )),
        }
    }

    let whole = sql::plan_total(backup);
    let across = query::row(
        conn,
        "counting the window as a whole, where a blueprint counts once",
        query::bind_scope(sqlx::query(&whole), ""),
    )
    .await?;
    // The per-day counts add up, except the distinct blueprints: a blueprint
    // corrected on four days is four rows but one card, so the total line takes
    // that number from the window statement instead.
    total.blueprints_to_change = query::integer(&across, "blueprints_to_change")?;
    report.line(String::new());
    report.line(row_line("total", &total));
    report.line(format!(
        "blueprints the change touches across the window: {}",
        total.blueprints_to_change
    ));

    let previous = sql::previous_only_of_day(backup);
    let row = query::row(
        conn,
        "counting the previous-value rows of the day after the window",
        query::bind_scope(sqlx::query(&previous), PREVIOUS_DAY),
    )
    .await?;
    report.line(format!(
        "{PREVIOUS_DAY}: {} rows of {} blueprints change only their previous value",
        query::integer(&row, "rows_previous_only")?,
        query::integer(&row, "blueprints_previous_only")?,
    ));

    report.line(String::new());
    report.line(format!(
        "skipped: {} rows of the window carry no price at all",
        total.rows_unpriced
    ));
    native_asks(conn, &mut report).await?;
    if let Some(name) = backup {
        report.line(format!(
            "already done: {} rows are recorded in public.\"{name}\" and are never changed twice",
            total.rows_already_fixed
        ));
        let recorded = preflight::backed_up_days(conn, name).await?;
        if recorded.is_empty() {
            report.line("the backup table holds no rows yet".to_string());
        } else {
            report.line(format!(
                "the backup table holds rows of {} days: {}",
                recorded.len(),
                recorded.join(", ")
            ));
        }
    }

    let guard = query::one_day_count(
        conn,
        "counting the rows of the day before the window",
        sql::ROWS_OF_DAY,
        BEFORE_WINDOW_DAY,
    )
    .await?;
    report.line(format!(
        "outside the change: {BEFORE_WINDOW_DAY} has {guard} rows and is never written"
    ));

    samples(conn, backup, &mut report).await?;
    Ok(report)
}

/// How many of the matching rows the plan lists; the count is always all of them.
const NOTES: i64 = 10;

/// The window rows whose stored ask equals the price a Pokoin native listing of
/// the same card asked on that day, read in the strictest way the question can
/// be asked: not an import of another marketplace's stock, posted on or before
/// the day, and either on the shelf or touched on or after it.
///
/// Nothing is skipped for it. The pad went onto every CardTrader ask, so a row
/// that matches here is corrected like every other row of the window; the count
/// is printed because a large one would say the diagnosis behind the fix is
/// wrong.
async fn native_asks(conn: &mut PgConnection, report: &mut Report) -> Result<(), String> {
    let counted = query::native_ask_count(conn).await?;
    report.line(format!(
        "rows whose padded price equals a Pokoin native listing price: {counted}"
    ));
    if counted == 0 {
        return Ok(());
    }
    let body = sql::native_note_rows();
    let rows = query::rows(
        conn,
        "reading the rows whose price equals a Pokoin native ask",
        query::bind_note(sqlx::query(&body), NOTES),
    )
    .await?;
    report.line(format!(
        "every one of them is un-padded like the rest of the window; the {} cheapest are listed",
        rows.len()
    ));
    report.line(format!(
        "{}{}{}{}",
        day_column("day"),
        pad("blueprint"),
        pad("price"),
        pad("listing"),
    ));
    for row in &rows {
        report.line(format!(
            "{}{}{}{}",
            day_column(&query::text(row, "observed_day")?),
            pad(&query::integer(row, "blueprint_id")?.to_string()),
            pad(&price(row, "padded_price")?),
            pad(&query::text(row, "listing_status")?),
        ));
    }
    Ok(())
}

/// The rows the change touches at both ends of the price range, before and
/// after, so a cheap card and an expensive one are both visible.
async fn samples(
    conn: &mut PgConnection,
    backup: Option<&str>,
    report: &mut Report,
) -> Result<(), String> {
    let body = sql::plan_samples(backup);
    let rows = query::rows(
        conn,
        "reading the sample rows",
        query::bind_scope(sqlx::query(&body), "").bind(SAMPLES),
    )
    .await?;
    report.line(String::new());
    report.line(format!(
        "samples: the {SAMPLES} cheapest and the {SAMPLES} dearest by the new price"
    ));
    report.line(format!(
        "{}{}{}{}{}{}",
        day_column("day"),
        pad("blueprint"),
        pad("min old"),
        pad("min new"),
        pad("previous old"),
        pad("previous new"),
    ));
    for row in &rows {
        let reason = if query::boolean(row, "pad_this")? {
            "un-padded"
        } else {
            "previous value only"
        };
        report.line(format!(
            "{}{}{}{}{}{}  {reason}",
            day_column(&query::text(row, "observed_day")?),
            pad(&query::integer(row, "blueprint_id")?.to_string()),
            pad(&price(row, "old_min")?),
            pad(&price(row, "new_min")?),
            pad(&price(row, "old_previous")?),
            pad(&price(row, "new_previous")?),
        ));
    }
    Ok(())
}

/// A price the statement handed back as text, with its fraction shortened for
/// the table. A missing price is a dash, so an unpriced row is visible.
fn price(row: &sqlx::postgres::PgRow, column: &str) -> Result<String, String> {
    Ok(match query::optional_text(row, column)? {
        Some(text) => shorten(&text),
        None => "-".to_string(),
    })
}

/// Trailing fraction zeroes carry no information; a whole number has no
/// fraction to trim.
pub fn shorten(text: &str) -> String {
    if text.contains('.') {
        return text.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_header_holds_every_column_title() {
        let line = header();
        let mut wanted = day_column("day");
        for (_, title) in COLUMNS {
            wanted.push_str(&pad(title));
        }
        assert_eq!(line, wanted);
        assert_eq!(line.len(), DAY_WIDTH + WIDTH * COLUMNS.len());
    }

    #[test]
    fn a_day_lines_up_under_the_header() {
        let counts = query::Counts {
            rows_seen: 3,
            rows_priced: 2,
            rows_to_change: 1,
            blueprints_to_change: 1,
            rows_unpadded: 1,
            rows_previous_only: 0,
            rows_already_fixed: 0,
            rows_unpriced: 1,
        };
        let line = row_line("2026-09-01", &counts);
        assert_eq!(line.len(), header().len(), "{line}");
        assert!(line.starts_with("2026-09-01"), "{line}");
        assert!(line.ends_with("            1"), "{line}");
    }

    #[test]
    fn a_long_value_is_not_cut_down() {
        let counts = query::Counts {
            rows_seen: 538_106,
            rows_priced: 538_106,
            rows_to_change: 538_106,
            blueprints_to_change: 62_978,
            rows_unpadded: 538_106,
            rows_previous_only: 0,
            rows_already_fixed: 0,
            rows_unpriced: 0,
        };
        let line = row_line("2026-09-19", &counts);
        assert!(line.contains("538106"), "{line}");
        assert!(line.contains("62978"), "{line}");
    }

    #[test]
    fn a_price_is_printed_without_its_padding_zeroes() {
        assert_eq!(shorten("40128"), "40128");
        assert_eq!(shorten("40128.0000000000"), "40128");
        assert_eq!(shorten("0.0476190476"), "0.0476190476");
        assert_eq!(shorten("22.50"), "22.5");
    }
}
