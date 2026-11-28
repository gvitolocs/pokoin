//! `ct-ask-unpad` end to end: `plan`, `apply`, `apply` again, `verify`, a
//! hand-corrupted row, and `revert`, against a throwaway Postgres whose rows are
//! shaped like the real `cardtrader_blueprint_daily_analytics`.
//!
//! It runs only when `CT_ASK_UNPAD_TEST_DATABASE_URL` names a database the test
//! owns; `tests/container.sh` starts `postgres:19.0-alpine` on a loopback port, hands the
//! URL over and removes the container again. Every blueprint id is far above the
//! real CardTrader ones, so a scratch database is the only place they can land.
//!
//! One test function, on purpose: the phases share the tables, and cargo runs
//! test functions in parallel.

use ct_ask_unpad::{parse, Report};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

const BASE: i64 = 9_000_000_000;
/// Cheap card: 22 PKN asked, 222 stored.
const CHEAP: i64 = BASE + 1;
/// An expensive card whose price is also that of a CardTrader import listing.
const IMPORT: i64 = BASE + 2;
/// A card whose padded price equals a Pokoin native ask that is on the shelf.
const NATIVE: i64 = BASE + 3;
/// A card whose padded price equals a Pokoin native ask that ended before the
/// window, and whose first stored day is inside the window.
const SOLD: i64 = BASE + 4;

const BACKUP: &str = "ct_ask_unpad_fixture_backup";
const LIVE: &str = "public.cardtrader_blueprint_daily_analytics";

/// The fixture as the nightly job left it: `(day, blueprint, price, previous,
/// change)`. The four price columns hold the same value, as they do in the real
/// table, and `change` is the job's own division so that a row the fix must not
/// move compares equal to itself down to the last digit.
///
/// The blueprints are `9000000001` a cheap card (222 over a 22 PKN ask),
/// `…2` an expensive one (40328 over 40128) whose price is also a CardTrader
/// import listing, `…3` a card with a Pokoin native ask on the shelf at its
/// padded price, `…4` a card whose first stored day is inside the window and
/// whose native ask ended before it, `…5` a card priced below the pad, and `…6`
/// a card with no price at all on 2026-09-18.
const SEEDED: &str = "
  (date '2026-08-10', 9000000001, 200::numeric,   null::numeric,  null::numeric),
  (date '2026-08-10', 9000000002, 40128::numeric, null::numeric,  null::numeric),
  (date '2026-08-10', 9000000003, 1000::numeric,  null::numeric,  null::numeric),
  (date '2026-08-10', 9000000005, 100::numeric,   null::numeric,  null::numeric),
  (date '2026-08-10', 9000000006, null::numeric,  null::numeric,  null::numeric),
  (date '2026-08-31', 9000000001, 222::numeric,   200::numeric,   ((222-200)::numeric/200)),
  (date '2026-08-31', 9000000002, 40328::numeric, 40128::numeric, ((40328-40128)::numeric/40128)),
  (date '2026-08-31', 9000000005, 150::numeric,   100::numeric,   ((150-100)::numeric/100)),
  (date '2026-09-01', 9000000001, 422::numeric,   222::numeric,   ((422-222)::numeric/222)),
  (date '2026-09-01', 9000000003, 1200::numeric,  1100::numeric,  ((1200-1100)::numeric/1100)),
  (date '2026-09-01', 9000000004, 400::numeric,   null::numeric,  null::numeric),
  (date '2026-09-17', 9000000001, 222::numeric,   422::numeric,   ((222-422)::numeric/422)),
  (date '2026-09-18', 9000000006, null::numeric,  null::numeric,  null::numeric),
  (date '2026-09-19', 9000000001, 422::numeric,   222::numeric,   ((422-222)::numeric/222)),
  (date '2026-09-19', 9000000002, 40328::numeric, 40328::numeric, ((40328-40328)::numeric/40328)),
  (date '2026-09-19', 9000000003, 900::numeric,   1200::numeric,  ((900-1200)::numeric/1200)),
  (date '2026-09-23', 9000000001, 22::numeric,    422::numeric,   ((22-422)::numeric/422)),
  (date '2026-09-23', 9000000002, 40128::numeric, 40328::numeric, ((40128-40328)::numeric/40328)),
  (date '2026-09-23', 9000000004, 300::numeric,   400::numeric,   ((300-400)::numeric/400)),
  (date '2026-09-24', 9000000001, 22::numeric,    22::numeric,    ((22-22)::numeric/22)),
  (date '2026-09-24', 9000000002, 40128::numeric, 40128::numeric, ((40128-40128)::numeric/40128))
";

/// The same twenty-one rows once the pad is gone: 200 PKN off every priced row
/// of the window, whatever the listing tables say about it, and
/// `previous_min_price_pkn` and `price_change_pct` re-derived from the corrected
/// series — which is why 2026-09-23 moves without its price moving.
const CORRECTED: &str = "
  (date '2026-08-10', 9000000001, 200::numeric,   null::numeric,  null::numeric),
  (date '2026-08-10', 9000000002, 40128::numeric, null::numeric,  null::numeric),
  (date '2026-08-10', 9000000003, 1000::numeric,  null::numeric,  null::numeric),
  (date '2026-08-10', 9000000005, 100::numeric,   null::numeric,  null::numeric),
  (date '2026-08-10', 9000000006, null::numeric,  null::numeric,  null::numeric),
  (date '2026-08-31', 9000000001, 22::numeric,    200::numeric,   ((22-200)::numeric/200)),
  (date '2026-08-31', 9000000002, 40128::numeric, 40128::numeric, ((40128-40128)::numeric/40128)),
  (date '2026-08-31', 9000000005, 150::numeric,   100::numeric,   ((150-100)::numeric/100)),
  (date '2026-09-01', 9000000001, 222::numeric,   22::numeric,    ((222-22)::numeric/22)),
  (date '2026-09-01', 9000000003, 1000::numeric,  1000::numeric,  ((1000-1000)::numeric/1000)),
  (date '2026-09-01', 9000000004, 200::numeric,   null::numeric,  null::numeric),
  (date '2026-09-17', 9000000001, 22::numeric,    222::numeric,   ((22-222)::numeric/222)),
  (date '2026-09-18', 9000000006, null::numeric,  null::numeric,  null::numeric),
  (date '2026-09-19', 9000000001, 222::numeric,   22::numeric,    ((222-22)::numeric/22)),
  (date '2026-09-19', 9000000002, 40128::numeric, 40128::numeric, ((40128-40128)::numeric/40128)),
  (date '2026-09-19', 9000000003, 700::numeric,   1000::numeric,  ((700-1000)::numeric/1000)),
  (date '2026-09-23', 9000000001, 22::numeric,    222::numeric,   ((22-222)::numeric/222)),
  (date '2026-09-23', 9000000002, 40128::numeric, 40128::numeric, ((40128-40128)::numeric/40128)),
  (date '2026-09-23', 9000000004, 300::numeric,   200::numeric,   ((300-200)::numeric/200)),
  (date '2026-09-24', 9000000001, 22::numeric,    22::numeric,    ((22-22)::numeric/22)),
  (date '2026-09-24', 9000000002, 40128::numeric, 40128::numeric, ((40128-40128)::numeric/40128))
";

#[tokio::test]
async fn the_fix_plan_apply_verify_revert() -> Result<(), String> {
    let Some(url) = test_url() else {
        // No database was handed to the test, so nothing here is proved.
        // `tests/container.sh` is what sets the variable.
        eprintln!("CT_ASK_UNPAD_TEST_DATABASE_URL is not set: the fixture test did not run");
        return Ok(());
    };
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(60))
        .connect(&url)
        .await
        .map_err(|error| format!("cannot connect to the test database: {error}"))?;

    seed(&pool).await?;

    // 1. plan reads only, and says what the change would do.
    let planned = command(&url, &["plan", "--backup-table", BACKUP]).await?;
    assert_eq!(planned.code(), 0, "a plan must not fail");
    assert_counts(
        &planned,
        &[
            ("2026-08-31", &[3, 3, 2, 2, 2, 0, 0, 0]),
            ("2026-09-01", &[3, 3, 3, 3, 3, 0, 0, 0]),
            ("2026-09-17", &[1, 1, 1, 1, 1, 0, 0, 0]),
            ("2026-09-18", &[1, 0, 0, 0, 0, 0, 0, 1]),
            ("2026-09-19", &[3, 3, 3, 3, 3, 0, 0, 0]),
            ("2026-09-23", &[3, 3, 3, 3, 0, 3, 0, 0]),
            ("total", &[14, 13, 12, 4, 9, 3, 0, 1]),
        ],
    )?;
    for wanted in [
        "blueprints the change touches across the window: 4",
        "2026-09-23: 3 rows of 3 blueprints change only their previous value",
        "skipped: 1 rows of the window carry no price at all",
        "outside the change: 2026-08-10 has 5 rows and is never written",
        "2026-09-02  no rows stored that day: nothing to un-pad",
        "does not exist yet, so this counts every row the rule touches",
    ] {
        assert!(
            planned.text().contains(wanted),
            "the plan did not say {wanted:?}\n{}",
            planned.text()
        );
    }
    // The one row whose stored ask is also a Pokoin native ask that was on the
    // shelf that day. It is reported and still corrected: an import at the same
    // price, and a listing that ended before the window, are not worth a line.
    let blueprint = NATIVE.to_string();
    let words = planned.text();
    assert!(
        words.contains("rows whose padded price equals a Pokoin native listing price: 1"),
        "the plan did not count the native-priced row\n{words}"
    );
    let listed = words
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>())
        .find(|parts| parts.len() == 4 && parts[0].starts_with("2026-"))
        .unwrap_or_default();
    assert_eq!(
        listed,
        vec!["2026-09-01", blueprint.as_str(), "1200", "active"],
        "the native note did not list the listing that was on the shelf\n{words}"
    );
    assert!(
        words.contains("40328") && words.contains("40128"),
        "the samples must show the expensive card before and after\n{words}"
    );
    // The plan is the operator's decision material, so `container.sh --nocapture`
    // shows the report itself and not only the numbers this test checked.
    println!("{words}");
    assert_rows(&pool, SEEDED).await?;
    let made = count(
        &pool,
        &format!("select count(*) from pg_tables where tablename = '{BACKUP}'"),
    )
    .await?;
    assert_eq!(made, 0, "plan made a table");

    // 2. One write run at a time: a session that already holds the run lock
    // makes `apply` refuse at once, without waiting and without changing a row.
    let mut other = pool
        .acquire()
        .await
        .map_err(|error| format!("cannot take a second connection: {error}"))?;
    let held: bool = sqlx::query_scalar("select pg_try_advisory_lock($1::bigint)")
        .bind(ct_ask_unpad::LOCK_KEY)
        .fetch_one(other.as_mut())
        .await
        .map_err(|error| format!("cannot take the run lock by hand: {error}"))?;
    assert!(held, "the fixture could not take the run lock");
    let refused = command(&url, &["apply", "--backup-table", BACKUP]).await;
    let error = match refused {
        Ok(report) => {
            return Err(format!(
                "apply ran while another session held the run lock\n{}",
                report.text()
            ))
        }
        Err(error) => error,
    };
    assert!(
        error.contains("another apply or revert already holds the run lock"),
        "the refusal said something else: {error}"
    );
    assert_rows(&pool, SEEDED).await?;
    assert_eq!(
        count(
            &pool,
            &format!("select count(*) from pg_tables where tablename = '{BACKUP}'"),
        )
        .await?,
        0,
        "a refused apply made the backup table"
    );
    let given_back: bool = sqlx::query_scalar("select pg_advisory_unlock($1::bigint)")
        .bind(ct_ask_unpad::LOCK_KEY)
        .fetch_one(other.as_mut())
        .await
        .map_err(|error| format!("cannot give the run lock back: {error}"))?;
    assert!(given_back, "the fixture's lock was not its own");
    drop(other);

    // 3. apply: the change itself, one day per transaction.
    let applied = command(&url, &["apply", "--backup-table", BACKUP]).await?;
    assert_eq!(applied.code(), 0, "{}", applied.text());
    assert!(
        applied.text().contains(&format!(
            "apply: created the backup table public.\"{BACKUP}\""
        )),
        "{}",
        applied.text()
    );
    assert_eq!(
        writes(&applied)?,
        vec![
            day(2026, 8, 31, 3, 2, 2),
            day(2026, 9, 1, 3, 3, 3),
            day(2026, 9, 17, 1, 1, 1),
            day(2026, 9, 18, 1, 0, 0),
            day(2026, 9, 19, 3, 3, 3),
            day(2026, 9, 23, 3, 3, 3),
        ],
        "the apply moved the wrong rows\n{}",
        applied.text()
    );
    assert!(
        applied
            .text()
            .contains("apply: 14 rows read, 12 old values recorded in ct_ask_unpad_fixture_backup, 12 rows written"),
        "{}",
        applied.text()
    );
    assert_rows(&pool, CORRECTED).await?;
    assert_eq!(
        count(
            &pool,
            "select count(*) from public.cardtrader_blueprint_daily_analytics a
                        join fixture_before b using (observed_day, blueprint_id)
                       where a.refreshed_at is distinct from b.refreshed_at
                          or a.card_name is distinct from b.card_name"
        )
        .await?,
        0,
        "the apply wrote a column the rule does not name"
    );
    assert_eq!(
        count(&pool, &format!("select count(*) from {BACKUP}")).await?,
        12,
        "the backup table holds exactly the rows that moved"
    );
    assert_eq!(
        count(
            &pool,
            &format!("select count(*) from {BACKUP} where fixed_at is null")
        )
        .await?,
        0,
        "every recorded row carries its fixed_at"
    );
    // Every blueprint that has a listing at exactly the padded price lost the
    // pad all the same: the ask on the shelf, the ask that ended before the
    // window, and the CardTrader import that is still active.
    assert_eq!(
        count(
            &pool,
            &format!(
                "select count(*) from {LIVE}
                  where (observed_day = '2026-09-01' and blueprint_id = {NATIVE}
                         and min_price_pkn = 1000)
                     or (observed_day = '2026-09-01' and blueprint_id = {SOLD}
                         and min_price_pkn = 200)
                     or (observed_day = '2026-08-31' and blueprint_id = {IMPORT}
                         and min_price_pkn = 40128)"
            )
        )
        .await?,
        3,
        "a row whose price matches a listing kept its pad"
    );
    // The padded values themselves: 222 also happens to be what 422 becomes, so
    // the check names the numbers that only the pad can produce.
    assert_eq!(
        count(
            &pool,
            "select count(*) from public.cardtrader_blueprint_daily_analytics
              where observed_day between '2026-08-31' and '2026-09-19'
                and min_price_pkn in (1200, 400, 40328, 422, 900)"
        )
        .await?,
        0,
        "a padded price survived the apply"
    );
    // The day after the window: no price moved, the comparison did.
    assert_eq!(
        count(
            &pool,
            &format!(
                "select count(*) from {LIVE}
              where observed_day = '2026-09-23' and blueprint_id = {CHEAP}
                and min_price_pkn = 22 and previous_min_price_pkn = 222"
            )
        )
        .await?,
        1,
        "the day after the window kept its padded previous value"
    );

    // 4. a second apply changes nothing: the backup table says so.
    let again = command(&url, &["apply", "--backup-table", BACKUP]).await?;
    assert_eq!(again.code(), 0, "{}", again.text());
    for (_, _, _, written) in writes(&again)? {
        assert_eq!(written, 0, "a second apply wrote rows");
    }
    assert!(
        again
            .text()
            .contains("nothing was written: the rows are already right or already recorded"),
        "{}",
        again.text()
    );
    assert_eq!(
        count(&pool, &format!("select count(*) from {BACKUP}")).await?,
        12,
        "a second apply recorded rows again"
    );
    let replanned = command(&url, &["plan", "--backup-table", BACKUP]).await?;
    assert_counts(&replanned, &[("total", &[14, 13, 0, 0, 0, 0, 12, 1])])?;
    assert!(
        replanned
            .text()
            .contains("the backup table holds rows of 5 days"),
        "{}",
        replanned.text()
    );

    // 5. verify proves the stored state, and notices a lie.
    let verified = command(&url, &["verify", "--backup-table", BACKUP]).await?;
    assert!(!verified.failed(), "{}", verified.text());
    assert!(
        verified
            .text()
            .contains("verify: the stored asks of the window are un-padded"),
        "{}",
        verified.text()
    );
    set_price(&pool, "2026-08-31", CHEAP, "422").await?;
    let caught = command(&url, &["verify", "--backup-table", BACKUP]).await?;
    assert!(
        caught.failed(),
        "verify accepted a hand-corrupted row\n{}",
        caught.text()
    );
    assert_eq!(caught.code(), 1, "verify must exit non-zero on a mismatch");
    assert!(
        caught
            .text()
            .contains("MISMATCH a recorded row holds its old value minus the pad"),
        "{}",
        caught.text()
    );
    set_price(&pool, "2026-08-31", CHEAP, "22").await?;
    let verified = command(&url, &["verify", "--backup-table", BACKUP]).await?;
    assert!(!verified.failed(), "{}", verified.text());

    // 6. revert puts every old value back and empties the backup table.
    let reverted = command(&url, &["revert", "--backup-table", BACKUP]).await?;
    assert_eq!(reverted.code(), 0, "{}", reverted.text());
    assert!(
        reverted
            .text()
            .contains("revert: 12 rows back to their old values, 12 backup rows removed, 0 left"),
        "{}",
        reverted.text()
    );
    assert_rows(&pool, SEEDED).await?;
    assert_eq!(
        count(&pool, "select count(*) from (select * from fixture_before except all select * from cardtrader_blueprint_daily_analytics) x").await?,
        0,
        "revert did not restore the rows it changed, column for column"
    );
    assert_eq!(
        count(&pool, "select count(*) from (select * from cardtrader_blueprint_daily_analytics except all select * from fixture_before) x").await?,
        0,
        "revert left a row the fixture never had"
    );

    // 7. and the fix works again afterwards: it is a function of the data, not
    // of a run that already happened.
    let second = command(&url, &["apply", "--backup-table", BACKUP]).await?;
    assert_eq!(second.code(), 0, "{}", second.text());
    assert_rows(&pool, CORRECTED).await?;
    let verified = command(&url, &["verify", "--backup-table", BACKUP]).await?;
    assert!(!verified.failed(), "{}", verified.text());

    // The gate `tests/container.sh` reads: a run that skipped for want of a URL
    // says nothing like this, and cargo is just as green either way.
    println!("fixture ran: plan, lock, apply, apply again, verify, revert, apply again");
    Ok(())
}

/// Run one command of the tool. The URL is never an argument, so it goes to
/// `execute` the way the environment carries it in production.
async fn command(url: &str, argv: &[&str]) -> Result<Report, String> {
    let args = parse(argv.iter().map(|word| word.to_string()).collect())?;
    ct_ask_unpad::execute(&args, url).await
}

fn test_url() -> Option<String> {
    std::env::var("CT_ASK_UNPAD_TEST_DATABASE_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn day(
    year: i32,
    month: u32,
    day: u32,
    rows: i64,
    recorded: i64,
    written: i64,
) -> (String, i64, i64, i64) {
    (
        format!("{year:04}-{month:02}-{day:02}"),
        rows,
        recorded,
        written,
    )
}

/// The tables the tool names, the rows of [`SEEDED`], and `fixture_before`: an
/// untouched copy for the column-by-column and revert comparisons.
async fn seed(pool: &PgPool) -> Result<(), String> {
    let statements = [
        format!("drop table if exists {BACKUP}"),
        format!("drop table if exists {LIVE}"),
        "drop table if exists marketplace_search_candidates".to_string(),
        "drop table if exists marketplace_user_listings".to_string(),
        "drop table if exists fixture_before".to_string(),
        format!(
            "create table {LIVE} (
               observed_day date not null,
               blueprint_id bigint not null,
               min_price_pkn numeric,
               median_price_pkn numeric,
               average_price_pkn numeric,
               max_price_pkn numeric,
               previous_min_price_pkn numeric,
               price_change_pct numeric,
               refreshed_at timestamptz not null,
               card_name text not null,
               primary key (observed_day, blueprint_id)
             )"
        ),
        "create table marketplace_search_candidates (card_id bigint primary key, ct_id bigint)"
            .to_string(),
        "create table marketplace_user_listings (
           listing_id bigint primary key,
           card_id text not null,
           price_pkn numeric not null,
           status text not null,
           source text not null,
           quantity_available integer not null,
           created_at timestamptz not null,
           updated_at timestamptz not null
         )"
        .to_string(),
        format!(
            "insert into {LIVE} (observed_day, blueprint_id, min_price_pkn, median_price_pkn,
                                 average_price_pkn, max_price_pkn, previous_min_price_pkn,
                                 price_change_pct, refreshed_at, card_name)
             select observed_day, blueprint_id, price, price, price, price, previous, change,
                    observed_day + time '21:04:00', 'blueprint ' || blueprint_id::text
               from (values {SEEDED}) e (observed_day, blueprint_id, price, previous, change)"
        ),
        "insert into marketplace_search_candidates (card_id, ct_id) values
           (700001, 9000000001), (700002, 9000000002), (700003, 9000000003),
           (700004, 9000000004)"
            .to_string(),
        // Three listings at the padded price of their own card: a Pokoin native
        // ask that is on the shelf on 2026-09-01, a Pokoin native ask that ended
        // before the window, and a CardTrader import that is still active. None
        // of the three protects its row; only the first is worth a line.
        "insert into marketplace_user_listings
           (listing_id, card_id, price_pkn, status, source, quantity_available,
            created_at, updated_at) values
           (1, '700003',   1200, 'active', 'pokoin_web',             3,
            '2026-08-20T00:00:00Z', '2026-09-10T00:00:00Z'),
           (2, '700004',    400, 'sold',   'pokoin_web',             0,
            '2026-08-01T00:00:00Z', '2026-08-20T00:00:00Z'),
           (3, '700002',  40328, 'active', 'cardtrader_seller_import', 5,
            '2026-09-01T00:00:00Z', '2026-09-18T00:00:00Z')"
            .to_string(),
        "create table fixture_before as select * from cardtrader_blueprint_daily_analytics"
            .to_string(),
    ];
    for statement in &statements {
        sqlx::raw_sql(statement)
            .execute(pool)
            .await
            .map_err(|error| format!("{error}\nwhile running: {statement}"))?;
    }
    Ok(())
}

/// Every row of the live table, against `(day, blueprint, price, previous,
/// change)`: the four price columns all hold `price`, and nothing outside the
/// list is allowed to exist.
async fn assert_rows(pool: &PgPool, expected: &str) -> Result<(), String> {
    let sql = format!(
        "with e (observed_day, blueprint_id, price, previous, change) as (values {expected})
         select count(*) from {LIVE} a
          where (a.observed_day, a.blueprint_id) not in
                  (select observed_day, blueprint_id from e)
             or exists (
                  select 1 from e
                   where e.observed_day = a.observed_day
                     and e.blueprint_id = a.blueprint_id
                     and (   a.min_price_pkn           is distinct from e.price
                          or a.median_price_pkn        is distinct from e.price
                          or a.average_price_pkn       is distinct from e.price
                          or a.max_price_pkn           is distinct from e.price
                          or a.previous_min_price_pkn  is distinct from e.previous
                          or a.price_change_pct        is distinct from e.change))"
    );
    assert_eq!(
        count(pool, &sql).await?,
        0,
        "the stored rows are not what the rule gives"
    );
    assert_eq!(
        count(pool, &format!("select count(*) from {LIVE}")).await?,
        expected.matches("(date ").count() as i64,
        "the live table does not hold one row per fixture row"
    );
    Ok(())
}

/// The eight numbers of a table line of the plan, by its first column.
fn assert_counts(report: &Report, wanted: &[(&str, &[i64; 8])]) -> Result<(), String> {
    for (day, values) in wanted {
        let line = report
            .lines()
            .iter()
            .find(|line| {
                let parts = line.split_whitespace().collect::<Vec<_>>();
                parts.len() == 9 && parts[0] == *day
            })
            .ok_or_else(|| format!("no line for {day} in\n{}", report.text()))?;
        let seen = line
            .split_whitespace()
            .skip(1)
            .map(|word| word.parse::<i64>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("{day}: {error}"))?;
        assert_eq!(
            seen,
            values.to_vec(),
            "the line for {day} counts the wrong rows (rows, priced, to change, \
             blueprints, un-padded, previous, recorded, unpriced)\n{}",
            report.text()
        );
    }
    Ok(())
}

/// The per-day lines of an apply: `(day, rows, recorded, written)`.
fn writes(report: &Report) -> Result<Vec<(String, i64, i64, i64)>, String> {
    let mut out = Vec::new();
    for line in report.lines() {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() == 7 && parts[1] == "rows" && parts[3] == "recorded" {
            out.push((
                parts[0].to_string(),
                number(parts[2])?,
                number(parts[4])?,
                number(parts[6])?,
            ));
        }
    }
    if out.is_empty() {
        return Err(format!("the apply reported no day\n{}", report.text()));
    }
    Ok(out)
}

fn number(text: &str) -> Result<i64, String> {
    text.parse::<i64>()
        .map_err(|error| format!("{text} is not a count: {error}"))
}

async fn count(pool: &PgPool, sql: &str) -> Result<i64, String> {
    sqlx::query_scalar::<_, i64>(sql)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("{error}\nwhile running: {sql}"))
}

/// Put one row's four price columns at a value by hand: the drift `verify`
/// exists to notice.
async fn set_price(pool: &PgPool, day: &str, blueprint: i64, price: &str) -> Result<(), String> {
    let sql = format!(
        "update {LIVE} set min_price_pkn = {price}, median_price_pkn = {price},
                average_price_pkn = {price}, max_price_pkn = {price}
          where observed_day = '{day}' and blueprint_id = {blueprint}"
    );
    sqlx::raw_sql(&sql)
        .execute(pool)
        .await
        .map_err(|error| format!("{error}\nwhile running: {sql}"))?;
    Ok(())
}
