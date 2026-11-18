//! Every statement the commands run. The only interpolation is the validated
//! backup-table identifier and the `price_change_pct` type read back from the
//! catalog; every value, date and limit is a bind parameter.
//!
//! Parameters share one numbering so a statement never needs its own bind
//! order: `$1` the day (an empty string when the statement reads no day),
//! `$2`/`$3` the padded window, `$4` the previous-value day, `$5` the pad,
//! `$6` a row limit, `$7` the listing sources that are not Pokoin's own asks,
//! `$8` the listing statuses that still mean on the shelf. A statement binds up
//! to its highest numbered parameter, which is why the pad is always `$5` even
//! in a statement that reads no day.
//!
//! One statement, `fix_scoped`, holds the whole rule and is shared by `plan` and
//! `apply`, so what the plan prints is what the apply writes. Nothing in it
//! reads the listing tables: the pad was added to every CardTrader ask, so a
//! card that also costs that number here is not evidence that the stored price
//! is right. `native_note_count` and `native_note_rows` read those tables for
//! the operator's information and change nothing.

use crate::ident;

pub const LIVE: &str = "public.cardtrader_blueprint_daily_analytics";
pub const LISTINGS: &str = "public.marketplace_user_listings";
pub const CANDIDATES: &str = "public.marketplace_search_candidates";
pub const TEMP: &str = "unpad_day";

/// Listing sources that are imports of another marketplace's stock, not a Pokoin
/// seller's ask. A padded CardTrader price that equals one of those is the pad
/// meeting its own source, not a price a Pokoin buyer could have paid.
pub const NOT_POKOIN_SOURCES: [&str; 8] = [
    "cardtrader_seller_import",
    "cardtrader_csv_import",
    "cardtrader_live",
    "cardtrader",
    "powertools_csv_import",
    "cardmarket_csv_import",
    "tcgplayer_csv_import",
    "stock_csv_import",
];

/// A listing in one of these states is still on the shelf, so its ask is a price
/// a buyer could have paid on that day.
pub const ON_SHELF_STATUSES: [&str; 2] = ["active", "paused"];

/// The six old values the backup table keeps, in this order everywhere.
pub const OLD_COLUMNS: [&str; 6] = [
    "min_price_pkn",
    "median_price_pkn",
    "average_price_pkn",
    "max_price_pkn",
    "previous_min_price_pkn",
    "price_change_pct",
];

/// A long lock wait on the live table means something else is writing it; stop
/// rather than queue behind the nightly job.
pub const LOCK_TIMEOUT: &str = "set local lock_timeout = '3s'";
/// Ask for the run lock without waiting, so a second write run is refused at
/// once instead of queueing behind the first and doubling up. The key is
/// [`crate::LOCK_KEY`], bound as `$1::bigint`; the session holds it until the
/// process closes the connection.
pub const TRY_LOCK: &str = "select pg_try_advisory_lock($1::bigint) as taken";
pub const READ_ONLY: &str = "set default_transaction_read_only = on";
pub const IS_REPLICA: &str = "select pg_is_in_recovery()::int as count";
pub const BACKUP_EXISTS: &str = "select (to_regclass($1::text) is not null)::int as count";
pub const ROWS_OF_DAY: &str = "select count(*) from public.cardtrader_blueprint_daily_analytics \
                               where observed_day = $1::date";

pub const BACKUP_SHAPE: &str = r#"
select count(*)
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname = $1
   and c.relkind = 'r'
   and a.attnum > 0
   and not a.attisdropped
   and a.attname = any($2::text[])
"#;

/// `price_change_pct`'s own type, so a check compares the value the way the
/// column stores it instead of inventing a scale.
pub const COLUMN_TYPE: &str = r#"
select format_type(a.atttypid, a.atttypmod) as column_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname = 'cardtrader_blueprint_daily_analytics'
   and a.attname = 'price_change_pct'
"#;

/// Every day the fix is expected to speak for: the window plus the day whose
/// previous value points into it. A day of the live table that is missing here
/// has no rows at all, which `plan` says out loud.
pub const CALENDAR: &str = r#"
select observed_day::date::text as observed_day
  from generate_series($2::date, $3::date, interval '1 day') as day (observed_day)
 union all select $4::date::text as observed_day
 order by 1
"#;

/// The days this tool touches: the padded window plus the day whose previous
/// value still points into it. The day slot `$1` is not read here.
pub const FIXED_DAYS: &str = r#"
select observed_day::text as observed_day
  from public.cardtrader_blueprint_daily_analytics
 where (observed_day between $2::date and $3::date) or observed_day = $4::date
 group by 1
 order by 1
"#;

pub fn backup_days(backup: &str) -> String {
    format!("select observed_day::text as observed_day from {backup} group by 1 order by 1")
}

pub fn create_backup(backup: &str) -> String {
    format!(
        r#"
create table if not exists {backup} (
  observed_day date not null,
  blueprint_id bigint not null,
  min_price_pkn numeric,
  median_price_pkn numeric,
  average_price_pkn numeric,
  max_price_pkn numeric,
  previous_min_price_pkn numeric,
  price_change_pct numeric,
  fixed_at timestamptz not null default now(),
  primary key (observed_day, blueprint_id)
)
"#
    )
}

/// The rows already recorded as fixed. Without a backup table nothing counts as
/// fixed, which is what `plan` without `--backup-table` means.
fn backed_up(backup: Option<&str>) -> String {
    let Some(name) = backup else {
        return "false".to_string();
    };
    let table = ident::qualified(name);
    format!(
        "exists (select 1 from {table} kept \
                  where kept.observed_day = a.observed_day \
                    and kept.blueprint_id = a.blueprint_id)"
    )
}

/// The rule over one `observed_day`, which is what a transaction writes.
const DAY_SCOPE: &str = "a.observed_day = $1::date";

/// The rule over every touched day at once, which is what the plan totals and
/// the samples read.
const WINDOW_SCOPE: &str =
    "(a.observed_day between $2::date and $3::date) or a.observed_day = $4::date";

/// One row per analytics row of the scoped rows, carrying the old values, the
/// new values and why the row is or is not corrected.
fn fix_scoped(backup: Option<&str>, scope: &str) -> String {
    let backed_up = backed_up(backup);
    format!(
        r#"
with live as (
  select a.observed_day,
         a.blueprint_id,
         a.min_price_pkn,
         a.median_price_pkn,
         a.average_price_pkn,
         a.max_price_pkn,
         a.previous_min_price_pkn,
         a.price_change_pct,
         coalesce(a.min_price_pkn, 0) > 0                            as priced,
         a.observed_day between $2::date and $3::date                as in_pad_window,
         (a.observed_day between $2::date and $3::date)
           or a.observed_day = $4::date                              as recompute_previous,
         {backed_up}                                                 as backed_up
    from {LIVE} a
   where {scope}
),
series_raw as (
  -- `previous_min_price_pkn` exactly as the nightly job defines it
  -- (scripts/sql/listing-pipeline.sql, the `previous_day` CTE): the same
  -- blueprint's `min_price_pkn` on the nearest earlier observed_day. Keyed by
  -- the row, not the blueprint, because the window scope holds several days of
  -- one blueprint at once and each of them compares against its own neighbour.
  select distinct on (l.observed_day, l.blueprint_id)
         l.observed_day                                             as observed_day,
         l.blueprint_id                                             as blueprint_id,
         p.observed_day                                             as previous_day,
         p.min_price_pkn                                            as previous_min_price_pkn
    from live l
    join {LIVE} p
      on p.blueprint_id = l.blueprint_id
     and p.observed_day < l.observed_day
   order by l.observed_day, l.blueprint_id, p.observed_day desc
),
series as (
  -- The neighbour's price as it will stand once the pad is gone, which is the
  -- value this row has to compare itself against. Inside a window run the
  -- neighbour is itself one of the rows being planned, so its own pad decision
  -- answers for it; a neighbour of another day, or one that the fix has already
  -- recorded, is taken at its stored value. That is what makes a plan read
  -- before the change agree with the same plan read after it, and with the
  -- day-by-day apply, which reaches each neighbour already corrected.
  select r.observed_day,
         r.blueprint_id,
         case when q.in_pad_window
                   and q.priced
                   and q.min_price_pkn >= $5::int8
                   and not q.backed_up
              then r.previous_min_price_pkn - $5::int8
              else r.previous_min_price_pkn end                      as previous_min_price_pkn
    from series_raw r
    left join live q
      on q.observed_day = r.previous_day and q.blueprint_id = r.blueprint_id
),
scored as (
  select l.*,
         s.previous_min_price_pkn                                   as series_previous_min_price_pkn,
         l.in_pad_window
           and l.priced
           and l.min_price_pkn >= $5::int8
           and not l.backed_up                                      as pad_this,
         l.recompute_previous
           and l.priced
           and not l.backed_up                                      as previous_this
    from live l
    left join series s
      on s.observed_day = l.observed_day
     and s.blueprint_id = l.blueprint_id
),
moved as (
  select s.*,
         case when s.pad_this then s.min_price_pkn - $5::int8
              else s.min_price_pkn end                             as new_min_price_pkn,
         case when s.previous_this then s.series_previous_min_price_pkn
              else s.previous_min_price_pkn end                    as new_previous_min_price_pkn
    from scored s
),
priced_again as (
  select m.*,
         -- `price_change_pct` as the job writes it, from the corrected pair.
         case when not m.priced or not m.previous_this then m.price_change_pct
              when m.new_previous_min_price_pkn > 0 and m.new_min_price_pkn is not null
              then (m.new_min_price_pkn - m.new_previous_min_price_pkn)
                   / m.new_previous_min_price_pkn
              else null end                                         as new_price_change_pct
    from moved m
)
select observed_day,
       blueprint_id,
       min_price_pkn,
       median_price_pkn,
       average_price_pkn,
       max_price_pkn,
       previous_min_price_pkn,
       price_change_pct,
       priced,
       in_pad_window,
       recompute_previous,
       backed_up,
       pad_this,
       previous_this,
       new_min_price_pkn,
       new_previous_min_price_pkn,
       new_price_change_pct,
       -- The percentage is a pure function of the two prices, so a row that
       -- moves neither of them needs no write; `verify` still proves the rule
       -- holds for it.
       (new_min_price_pkn is distinct from min_price_pkn)
         or (new_previous_min_price_pkn is distinct from previous_min_price_pkn)
                                                                   as changed
  from priced_again
"#
    )
}

/// The eight aggregates over the rows of the rule, in this order everywhere.
const COUNT_AGGREGATES: &str = r#"count(*)                                                  as rows_seen,
       count(*) filter (where priced)                            as rows_priced,
       count(*) filter (where changed)                           as rows_to_change,
       count(distinct blueprint_id) filter (where changed)       as blueprints_to_change,
       count(*) filter (where pad_this and changed)              as rows_unpadded,
       count(*) filter (where changed and not pad_this)          as rows_previous_only,
       count(*) filter (where backed_up)                         as rows_already_fixed,
       count(*) filter (where in_pad_window and not priced)      as rows_unpriced"#;

/// The counts the plan prints per day, and in total over the window.
pub fn counts(body: &str) -> String {
    format!(
        "
select {COUNT_AGGREGATES}
  from ({body}) q
"
    )
}

/// The same counts one line per day, in a single pass over the window.
pub fn plan_days(backup: Option<&str>) -> String {
    format!(
        "
select observed_day::text                                        as observed_day,
       {COUNT_AGGREGATES}
  from ({}) q
 group by 1
 order by 1
",
        fix_scoped(backup, WINDOW_SCOPE)
    )
}

pub fn plan_total(backup: Option<&str>) -> String {
    counts(&fix_scoped(backup, WINDOW_SCOPE))
}

/// Ten rows the change touches: the five cheapest and the five most expensive,
/// so `$6` is how many of each.
pub fn plan_samples(backup: Option<&str>) -> String {
    format!(
        r#"
select observed_day::text                                       as observed_day,
       blueprint_id,
       min_price_pkn::text                                       as old_min,
       new_min_price_pkn::text                                   as new_min,
       previous_min_price_pkn::text                              as old_previous,
       new_previous_min_price_pkn::text                          as new_previous,
       round(price_change_pct, 6)::text                          as old_change,
       round(new_price_change_pct, 6)::text                      as new_change,
       pad_this,
       previous_this
  from (
    select q.*,
           row_number() over (order by q.new_min_price_pkn asc)   as cheapest,
           row_number() over (order by q.new_min_price_pkn desc)  as dearest
      from ({}) q
     where q.changed
  ) picked
 where cheapest <= $6::bigint or dearest <= $6::bigint
 order by new_min_price_pkn, observed_day
"#,
        fix_scoped(backup, WINDOW_SCOPE)
    )
}

/// How many rows of the day named by `$1` need their previous value recomputed
/// and nothing else. The body is the whole window on purpose: whether that day's
/// neighbour still carries the pad is a fact about the window, and a run that
/// looked at the day alone would find nothing to report.
pub fn previous_only_of_day(backup: Option<&str>) -> String {
    format!(
        r#"
select count(*) filter (where changed and not pad_this)           as rows_previous_only,
       count(distinct blueprint_id) filter (where changed and not pad_this)
                                                                  as blueprints_previous_only
  from ({}) q
 where q.observed_day = $1::date
"#,
        fix_scoped(backup, WINDOW_SCOPE)
    )
}

pub fn create_temp(backup: Option<&str>) -> String {
    format!(
        "create temp table {TEMP} on commit drop as {}",
        fix_scoped(backup, DAY_SCOPE)
    )
}

/// The window rows whose stored ask equals a Pokoin native listing price,
/// counted in the strictest reading of that comparison: a listing that was not
/// an import of another marketplace's stock (`$7`), posted on or before the day,
/// and either on the shelf (`$8`) or touched on or after it.
///
/// This is the informational count the lead asked for and nothing more: the pad
/// was added to every CardTrader ask, so a row that matches here is still
/// corrected. It is worded as one CTE because the count and the printed rows must
/// be the same rule.
fn native_matched(projection: &str) -> String {
    format!(
        r#"
with matched as (
  select distinct on (a.observed_day, a.blueprint_id)
         a.observed_day::text                                      as observed_day,
         a.blueprint_id                                            as blueprint_id,
         a.min_price_pkn                                           as min_price_pkn,
         coalesce(u.status, '')                                    as listing_status
    from {LIVE} a
    join {CANDIDATES} c on c.ct_id = a.blueprint_id
    join {LISTINGS} u on u.card_id = c.card_id::text
   where a.observed_day between $2::date and $3::date
     and a.min_price_pkn is not null
     and a.min_price_pkn >= $5::int8
     and u.price_pkn = a.min_price_pkn
     and coalesce(u.source, '') <> all ($7::text[])
     and (u.created_at at time zone 'utc')::date <= a.observed_day
     and (u.status = any ($8::text[])
          or (u.updated_at at time zone 'utc')::date >= a.observed_day)
)
select {projection}
  from matched
"#
    )
}

pub fn native_note_count() -> String {
    native_matched("count(*) as count")
}

/// The same rows for the plan to print, `$6` of them, cheapest first.
pub fn native_note_rows() -> String {
    format!(
        "{} order by min_price_pkn, observed_day, blueprint_id limit $6::bigint",
        native_matched(
            "observed_day, blueprint_id, min_price_pkn::text as padded_price, listing_status"
        )
    )
}

pub fn record_old_values(backup: &str) -> String {
    let columns = OLD_COLUMNS.join(", ");
    format!(
        r#"
insert into {backup} (observed_day, blueprint_id, {columns})
select observed_day, blueprint_id, {columns}
  from {TEMP}
 where changed
"#
    )
}

pub fn write_day() -> String {
    format!(
        r#"
update {LIVE} a
   set min_price_pkn            = t.new_min_price_pkn,
       median_price_pkn         = case when t.pad_this then t.new_min_price_pkn
                                      else t.median_price_pkn end,
       average_price_pkn        = case when t.pad_this then t.new_min_price_pkn
                                      else t.average_price_pkn end,
       max_price_pkn            = case when t.pad_this then t.new_min_price_pkn
                                      else t.max_price_pkn end,
       previous_min_price_pkn   = t.new_previous_min_price_pkn,
       price_change_pct         = t.new_price_change_pct
  from {TEMP} t
 where t.changed
   and a.observed_day = t.observed_day
   and a.blueprint_id = t.blueprint_id
"#
    )
}

/// Rows of the padded window that still carry the pad and are not in the backup
/// table: an apply that missed them.
pub fn missing_from_backup(backup: &str) -> String {
    format!(
        r#"
with live as (
  select a.observed_day, a.blueprint_id, a.min_price_pkn
    from {LIVE} a
   where a.observed_day between $2::date and $3::date
     and a.min_price_pkn is not null
     and a.min_price_pkn >= $5::int8
)
select count(*)
  from live l
 where not exists (select 1 from {backup} kept
                    where kept.observed_day = l.observed_day
                      and kept.blueprint_id = l.blueprint_id)
"#
    )
}

/// The live price of every backed-up row against the rule: old minus pad when
/// it was a padded row of the window, the old value when it was only its
/// previous value that moved.
pub fn backup_price_mismatch(backup: &str) -> String {
    // A row only ever lost the pad if it was in the window and priced at or
    // above it.
    let unpadded = "(kept.observed_day between $2::date and $3::date \
                    and kept.min_price_pkn >= $5::int8)";
    let columns = ["min", "median", "average", "max"];
    let expectations = columns
        .iter()
        .map(|column| {
            let price = format!("kept.{column}_price_pkn");
            [
                format!("case when {unpadded}"),
                format!("        then {price} - $5::int8"),
                format!("        else {price}"),
                format!("   end as {column}_price_pkn"),
            ]
            .join("\n                  ")
        })
        .collect::<Vec<_>>()
        .join(",\n         ");
    let mismatches = columns
        .iter()
        .map(|column| format!("a.{column}_price_pkn is distinct from e.{column}_price_pkn"))
        .collect::<Vec<_>>()
        .join("\n    or ");
    format!(
        r#"
with expected as (
  select kept.observed_day,
         kept.blueprint_id,
         {expectations}
    from {backup} kept
)
select count(*)
  from expected e
  join {LIVE} a
    on a.observed_day = e.observed_day and a.blueprint_id = e.blueprint_id
 where {mismatches}
"#
    )
}

pub fn backup_rows(backup: &str) -> String {
    format!("select count(*) as count from {backup}")
}

pub fn backup_rows_missing(backup: &str) -> String {
    format!(
        r#"
select count(*)
  from {backup} kept
 where not exists (select 1 from {LIVE} a
                    where a.observed_day = kept.observed_day
                      and a.blueprint_id = kept.blueprint_id)
"#
    )
}

/// Backup rows that belong to no day this tool is allowed to write, plus the
/// rows of the day named by `$1` (the window's left neighbour, which proves the
/// edge held).
pub fn backup_out_of_scope(backup: &str) -> String {
    format!(
        r#"
select count(*) filter (where b.observed_day = $1::date)         as rows_of_guard_day,
       count(*) filter (where not ((b.observed_day between $2::date and $3::date)
                                   or b.observed_day = $4::date)) as rows_of_other_days
  from {backup} b
"#
    )
}

/// Every priced row of the touched days, against the job's own definition of
/// `previous_min_price_pkn` and `price_change_pct` on the series as it stands
/// now.
pub fn previous_rule_mismatch(pct_cast: &str) -> String {
    format!(
        r#"
with covered as (
  select a.observed_day, a.blueprint_id, a.min_price_pkn,
         a.previous_min_price_pkn, a.price_change_pct
    from {LIVE} a
   where coalesce(a.min_price_pkn, 0) > 0
     and ((a.observed_day between $2::date and $3::date) or a.observed_day = $4::date)
),
series as (
  select distinct on (c.observed_day, c.blueprint_id)
         c.observed_day,
         c.blueprint_id,
         p.min_price_pkn                                            as previous_min_price_pkn
    from covered c
    join {LIVE} p
      on p.blueprint_id = c.blueprint_id
     and p.observed_day < c.observed_day
   order by c.observed_day, c.blueprint_id, p.observed_day desc
),
expected as (
  select c.observed_day,
         c.blueprint_id,
         s.previous_min_price_pkn                                   as previous_min_price_pkn,
         case when s.previous_min_price_pkn > 0 and c.min_price_pkn is not null
              then (c.min_price_pkn - s.previous_min_price_pkn)
                   / s.previous_min_price_pkn
              else null end                                         as price_change_pct
    from covered c
    left join series s
      on s.observed_day = c.observed_day
     and s.blueprint_id = c.blueprint_id
)
select count(*)
  from expected e
  join {LIVE} a
    on a.observed_day = e.observed_day and a.blueprint_id = e.blueprint_id
 where a.previous_min_price_pkn is distinct from e.previous_min_price_pkn
    or a.price_change_pct is distinct from e.price_change_pct{pct_cast}
"#
    )
}

pub fn revert_temp(backup: &str) -> String {
    let columns = OLD_COLUMNS.join(", ");
    format!(
        r#"
create temp table {TEMP} on commit drop as
select kept.observed_day, kept.blueprint_id, {columns}
  from {backup} kept
 where kept.observed_day = $1::date
"#
    )
}

pub fn revert_write() -> String {
    let columns = OLD_COLUMNS
        .iter()
        .map(|column| format!("{column:<22} = t.{column}"))
        .collect::<Vec<_>>()
        .join(",\n       ");
    format!(
        r#"
update {LIVE} a
   set {columns}
  from {TEMP} t
 where a.observed_day = t.observed_day
   and a.blueprint_id = t.blueprint_id
"#
    )
}

pub fn revert_delete(backup: &str) -> String {
    format!(
        r#"
delete from {backup} kept
 using {TEMP} t
 where kept.observed_day = t.observed_day
   and kept.blueprint_id = t.blueprint_id
"#
    )
}

/// The `numeric` spelling the catalog reported, as a cast, or nothing when it is
/// not a plain numeric family type.
pub fn pct_cast(type_name: &str) -> String {
    let Some(rest) = type_name.strip_prefix("numeric") else {
        return String::new();
    };
    if rest.is_empty() {
        return "::numeric".to_string();
    }
    let Some(inner) = rest
        .strip_prefix('(')
        .and_then(|body| body.strip_suffix(')'))
    else {
        return String::new();
    };
    // `numeric(p)` and `numeric(p,s)` are the only shapes Postgres prints for this
    // family; anything else, `numeric(,)` included, is not a type name.
    let digits = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit());
    let mut parts = inner.split(',');
    let shaped = match (parts.next(), parts.next(), parts.next()) {
        (Some(precision), None, None) => digits(precision),
        (Some(precision), Some(scale), None) => digits(precision) && digits(scale),
        _ => false,
    };
    if shaped {
        format!("::{type_name}")
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PAD_FROM, PAD_PKN, PAD_TO, PREVIOUS_DAY};

    const BACKUP: &str = "ct_ask_unpad_backup";

    fn qualified() -> String {
        ident::qualified(BACKUP)
    }

    /// The statement with its column alignment folded away, so an assertion
    /// reads the SQL and not its layout.
    fn flat(statement: &str) -> String {
        statement.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// The statements a command runs when a backup table names the work done.
    fn with_backup() -> Option<&'static str> {
        Some(BACKUP)
    }

    /// The rule over one day, which is what `apply` writes.
    fn per_day(backup: Option<&str>) -> String {
        fix_scoped(backup, DAY_SCOPE)
    }

    /// The same rule over every touched day at once.
    fn window(backup: Option<&str>) -> String {
        fix_scoped(backup, WINDOW_SCOPE)
    }

    #[test]
    fn only_the_identifier_is_written_into_the_sql() {
        let sql = per_day(with_backup());
        assert!(sql.contains(&qualified()), "{sql}");
        // The bare name appears nowhere except inside the quoted form.
        assert_eq!(sql.matches(BACKUP).count(), 1, "{sql}");
        assert!(!sql.contains(&format!(" {BACKUP} ")), "{sql}");
        let unscoped = per_day(None);
        assert!(!unscoped.contains(BACKUP), "{unscoped}");
        assert!(flat(&unscoped).contains("as backed_up"), "{unscoped}");
    }

    #[test]
    fn the_pad_and_the_row_limit_are_bound_as_integers() {
        // A numeric-typed parameter would be sent as int8 by the driver and
        // Postgres reads the bytes wrong; the cast names the type it has.
        for statement in [
            per_day(with_backup()),
            missing_from_backup(&qualified()),
            backup_price_mismatch(&qualified()),
        ] {
            assert!(statement.contains("$5::int8"), "{statement}");
            assert!(!statement.contains("$5::numeric"), "{statement}");
        }
        assert!(plan_samples(with_backup()).contains("$6::bigint"));
    }

    #[test]
    fn every_value_is_a_bind_parameter() {
        let statements = [
            per_day(with_backup()),
            window(with_backup()),
            plan_days(with_backup()),
            plan_total(with_backup()),
            plan_samples(with_backup()),
            previous_only_of_day(with_backup()),
            create_temp(with_backup()),
            missing_from_backup(&qualified()),
            backup_price_mismatch(&qualified()),
            previous_rule_mismatch("::numeric"),
            backup_out_of_scope(&qualified()),
            FIXED_DAYS.to_string(),
            CALENDAR.to_string(),
        ];
        let mut values: Vec<String> = [PAD_FROM, PAD_TO, PREVIOUS_DAY]
            .iter()
            .map(|v| v.to_string())
            .collect();
        values.push(PAD_PKN.to_string());
        for value in &values {
            for statement in &statements {
                assert!(
                    !statement.contains(value.as_str()),
                    "{value} must be bound, not written into\n{statement}"
                );
            }
        }
    }

    #[test]
    fn the_rule_is_written_once_and_shared() {
        let day = per_day(with_backup());
        let window = window(with_backup());
        // What apply collects for one day is the same statement, day by day.
        let collected = create_temp(with_backup());
        assert!(collected.contains(&day), "{collected}");
        // The plan's totals, its per-day table, its samples and the count of the
        // day after the window are the same statement over the whole window: a
        // neighbour's price is only knowable from the window it sits in.
        for statement in [
            plan_total(with_backup()),
            plan_days(with_backup()),
            plan_samples(with_backup()),
            previous_only_of_day(with_backup()),
        ] {
            assert!(statement.contains(&window), "{statement}");
        }
        assert!(
            create_temp(with_backup()).starts_with("create temp table unpad_day on commit drop as")
        );
    }

    #[test]
    fn a_write_touches_only_the_columns_the_rule_names() {
        for statement in [write_day(), revert_write()] {
            let text = flat(&statement);
            let set = text
                .split(" set ")
                .nth(1)
                .and_then(|rest| rest.split(" from ").next())
                .unwrap_or_else(|| panic!("no set list in {text}"));
            for untouched in [
                "refreshed_at",
                "listing_count",
                "listed_quantity",
                "seller_count",
                "sold_count",
                "sold_quantity",
                "sell_through_rate",
                "source_counts",
                "observed_day",
                "blueprint_id",
            ] {
                assert!(!set.contains(untouched), "{untouched} must not be written");
            }
            for column in OLD_COLUMNS {
                assert!(set.contains(&format!("{column} =")), "{column}");
            }
        }
    }

    #[test]
    fn the_backup_table_holds_the_six_old_values_and_fixed_at() {
        let ddl = create_backup(&qualified());
        for column in OLD_COLUMNS {
            assert!(ddl.contains(column), "{column}");
        }
        assert!(
            ddl.contains("fixed_at timestamptz not null default now()"),
            "{ddl}"
        );
        assert!(
            ddl.contains("primary key (observed_day, blueprint_id)"),
            "{ddl}"
        );
        let record = record_old_values(&qualified());
        assert!(
            record.contains("insert into public.\"ct_ask_unpad_backup\""),
            "{record}"
        );
        assert!(
            flat(&record).contains("from unpad_day where changed"),
            "{record}"
        );
    }

    #[test]
    fn the_backup_is_never_asked_to_record_the_same_row_twice() {
        let temp = create_temp(with_backup());
        assert!(temp.contains("not l.backed_up"), "{temp}");
        let second = per_day(with_backup());
        assert!(second.contains("and not l.backed_up"), "{second}");
        assert!(second.contains("as changed"), "{second}");
    }

    #[test]
    fn a_percentage_cast_only_comes_from_the_catalog() {
        assert_eq!(pct_cast("numeric"), "::numeric");
        assert_eq!(pct_cast("numeric(10,4)"), "::numeric(10,4)");
        assert_eq!(pct_cast("numeric(8)"), "::numeric(8)");
        for junk in [
            "double precision",
            "numeric(8); drop table x",
            "numeric(",
            "numeric()",
            "numeric(,)",
            "numeric(1,,2)",
            "integer",
            "text",
        ] {
            assert_eq!(pct_cast(junk), "", "{junk}");
        }
        assert!(previous_rule_mismatch(&pct_cast("numeric(10,4)")).contains("::numeric(10,4)"));
    }

    #[test]
    fn the_price_pass_never_reads_the_listing_tables() {
        // A native ask that happens to equal the padded price is not evidence
        // that the price is right: the pad went onto every CardTrader ask, and
        // an ended listing or an import speaks for nothing. Only the
        // informational note may join those tables.
        for statement in [
            per_day(with_backup()),
            per_day(None),
            window(with_backup()),
            missing_from_backup(&qualified()),
            backup_price_mismatch(&qualified()),
            write_day(),
            revert_write(),
        ] {
            let sql = flat(&statement);
            assert!(!sql.contains(LISTINGS), "{sql}");
            assert!(!sql.contains(CANDIDATES), "{sql}");
        }
    }

    #[test]
    fn the_pad_decision_names_nothing_but_the_row_itself() {
        // The withdrawn skip used to appear here as `n.blueprint_id is null`.
        let sql = flat(&per_day(with_backup()));
        assert!(
            sql.contains("and l.min_price_pkn >= $5::int8 and not l.backed_up as pad_this"),
            "{sql}"
        );
    }

    #[test]
    fn the_native_note_is_the_stricter_reading() {
        // An import of another marketplace's stock cannot vouch for a Pokoin
        // ask, an ended listing speaks only for the days it was on the shelf,
        // and the card is reached through the candidate's ct_id, whose card_id
        // is text while the analytics key is a bigint.
        let count = native_note_count();
        for clause in [
            "coalesce(u.source, '') <> all ($7::text[])",
            "(u.created_at at time zone 'utc')::date <= a.observed_day",
            "u.status = any ($8::text[])",
            "(u.updated_at at time zone 'utc')::date >= a.observed_day",
            "c.ct_id = a.blueprint_id",
            "u.card_id = c.card_id::text",
            "a.observed_day between $2::date and $3::date",
            "a.min_price_pkn >= $5::int8",
        ] {
            assert!(count.contains(clause), "{count}");
        }
        // The printed rows are the same rule with another projection and a
        // limit, so the count cannot drift away from what the plan shows.
        let rows = native_note_rows();
        assert!(rows.contains("limit $6::bigint"), "{rows}");
        let shared = count.split("select count(*)").next().unwrap_or_default();
        assert!(rows.contains(shared), "{rows}");
    }

    #[test]
    fn a_row_compares_itself_with_an_un_padded_neighbour() {
        // `previous_min_price_pkn` is not the neighbour's stored number when that
        // neighbour is itself a row the fix moves; without this a plan read
        // before the change would report nothing for the day after the window.
        let sql = window(with_backup());
        assert!(sql.contains("series_raw r"), "{sql}");
        assert!(
            sql.contains("left join live q"),
            "the neighbour's own pad decision is not asked: {sql}"
        );
        assert!(
            flat(&sql).contains("then r.previous_min_price_pkn - $5::int8"),
            "{sql}"
        );
    }
}
