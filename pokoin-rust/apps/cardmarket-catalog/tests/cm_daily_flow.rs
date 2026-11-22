//! PH-C024 W3 on a real Postgres: migration 145 applied from its own file, one
//! day of the collector's `daily-minimums-YYYY-MM-DD.jsonl` loaded through the
//! statements the command sends, then the same file again, then a second file
//! for the same day whose lines are one newer and one older observation. What
//! is proved here is what only a server can answer: that a replay changes
//! nothing, that an older line cannot roll a day's facet back, that `asked`
//! sticks once the walk aimed at the facet, and that the revert really drops
//! the table. The line-by-line refusals (`cm_daily::parse`) are unit-tested in
//! `src/cm_daily.rs`; what the flow adds is that a refused line never reaches
//! the table either.
//!
//! ```text
//! docker run -d --rm --name pokoin-ph-r040-daily-pg -e POSTGRES_PASSWORD=test \
//!   -e POSTGRES_DB=pokoin_marketplace -p 127.0.0.1:55498:5432 \
//!   --tmpfs /var/lib/postgresql postgres:19.0-alpine
//! TMPDIR=$HOME/scratch/tmp \
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55498/pokoin_marketplace \
//!   cargo test -p cardmarket-catalog --test cm_daily_flow -- --nocapture
//! docker rm -f pokoin-ph-r040-daily-pg
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped, as every `*_flow`
//! test is. The files it writes go under `$TMPDIR`, never `/tmp`. It creates and
//! drops only `public.cardmarket_offer_daily`, in a throwaway database.
//!
//! CI's database job discovers `pokoin-rust/crates/*/tests/*_flow.rs` only
//! (`scripts/run-flow-tests.sh:49`), so an app-level flow test like this one —
//! which is where the neighbouring app test lives too — runs when somebody
//! starts the container above, not in the sharded `cargo test` job.

use std::path::PathBuf;

use cardmarket_catalog::{cm_daily, db};
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;

/// The migration and its revert, from the repository's own files: what this
/// test applies is the text the writer will be given, not a copy of it.
const MIGRATION: &str = include_str!("../../../../scripts/sql/145_cardmarket_offer_daily.sql");
const REVERT: &str =
    include_str!("../../../../scripts/sql-reverts/145_cardmarket_offer_daily.revert.sql");

const DAY: &str = "2026-11-12";

/// The first file of the day: four facets the pages showed, one error, one line
/// written on another day and one facet that found no price.
const FILE_ONE: &str = r#"{"day":"2026-11-12","idProduct":279646,"language":"IT","condition":"NM","finish":"*","firstEdition":"*","sellerType":"private","minCents":1000,"count":2,"countsComplete":true,"observedAt":"2026-11-12T13:09:30.235Z","status":"ok","asked":true}
{"day":"2026-11-12","idProduct":279646,"language":"IT","condition":"SP","finish":"*","firstEdition":"*","sellerType":"pro","minCents":588,"count":4,"countsComplete":true,"observedAt":"2026-11-12T13:09:30.235Z","status":"ok","asked":false}
{"day":"2026-11-12","idProduct":279646,"language":"ZH-TW","condition":"NM","finish":"N","firstEdition":"*","sellerType":"private","minCents":1000,"count":null,"countsComplete":null,"observedAt":"2026-11-12T13:09:30.235Z","status":"ok","asked":false}
{"day":"2026-11-12","idProduct":279259,"language":"EN","condition":"Poor","finish":"*","firstEdition":"Y","sellerType":"private","minCents":50,"count":null,"countsComplete":null,"observedAt":"2026-11-12T13:09:30.235Z","status":"ok","asked":true}
{"day":"2026-11-12","idProduct":279259,"language":"EN","condition":"NM","finish":"*","firstEdition":"*","sellerType":"private","minCents":null,"count":0,"countsComplete":true,"observedAt":"2026-11-12T13:09:30.235Z","status":"ok","asked":true}
{"day":"2026-11-12","idProduct":279259,"language":"EN","condition":"MP","finish":"*","firstEdition":"*","sellerType":"private","minCents":700,"count":1,"countsComplete":true,"observedAt":"2026-11-12T13:09:30.235Z","status":"error","asked":true}
{"day":"2026-11-11","idProduct":279259,"language":"EN","condition":"NM","finish":"*","firstEdition":"*","sellerType":"private","minCents":900,"count":3,"countsComplete":true,"observedAt":"2026-11-11T13:09:30.235Z","status":"ok","asked":true}
"#;

/// The same day rewritten after a longer walk: the NM facet seen again at 18:00
/// with `asked` no longer set, the SP facet answered only by an older line, and
/// the Traditional Chinese facet finally aimed at.
const FILE_TWO: &str = r#"{"day":"2026-11-12","idProduct":279646,"language":"IT","condition":"NM","finish":"*","firstEdition":"*","sellerType":"private","minCents":850,"count":5,"countsComplete":true,"observedAt":"2026-11-12T18:00:00.000Z","status":"ok","asked":false}
{"day":"2026-11-12","idProduct":279646,"language":"IT","condition":"SP","finish":"*","firstEdition":"*","sellerType":"pro","minCents":610,"count":3,"countsComplete":true,"observedAt":"2026-11-12T09:00:00.000Z","status":"ok","asked":true}
{"day":"2026-11-12","idProduct":279646,"language":"ZH-TW","condition":"NM","finish":"N","firstEdition":"*","sellerType":"private","minCents":900,"count":6,"countsComplete":false,"observedAt":"2026-11-12T18:00:00.000Z","status":"ok","asked":true}
"#;

async fn pool() -> sqlx::PgPool {
    let url = std::env::var("POKOIN_TEST_DATABASE_URL").unwrap_or_default();
    assert!(
        !url.trim().is_empty(),
        "POKOIN_TEST_DATABASE_URL is not set"
    );
    PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(url.trim())
        .await
        .expect("connect the throwaway Postgres")
}

/// The scratch directory the lane set: never `/tmp`, which is small and shared.
fn scratch() -> PathBuf {
    let dir = PathBuf::from(std::env::var("TMPDIR").expect("run with TMPDIR=$HOME/scratch/tmp"));
    std::fs::create_dir_all(&dir).expect("create the scratch dir");
    dir
}

/// One facet's answer as the table holds it: the price, the two counts, whether
/// the day aimed at it, and whether its observation is the instant asked for.
async fn facet(
    pool: &sqlx::PgPool,
    product: i64,
    language: &str,
    condition: &str,
    seller: &str,
    instant: &str,
) -> (i32, Option<i32>, Option<bool>, bool, bool) {
    let row = sqlx::query(
        r#"select min_cents, offer_count, counts_complete, asked,
                  observed_at = $6::timestamptz as at_instant
             from public.cardmarket_offer_daily
             where cm_product_id = $1 and day = $2::date
               and language = $3 and condition = $4 and seller_type = $5"#,
    )
    .bind(product)
    .bind(DAY)
    .bind(language)
    .bind(condition)
    .bind(seller)
    .bind(instant)
    .fetch_optional(pool)
    .await
    .expect("read one facet");
    match row {
        Some(row) => (
            row.get("min_cents"),
            row.get("offer_count"),
            row.get("counts_complete"),
            row.get("asked"),
            row.get("at_instant"),
        ),
        None => panic!("no {product} {language} {condition} {seller} row in the day"),
    }
}

async fn total(pool: &sqlx::PgPool) -> i64 {
    sqlx::query_scalar("select count(*) from public.cardmarket_offer_daily")
        .fetch_one(pool)
        .await
        .expect("count the day")
}

/// Load one day's text the way the command does: the day from the file name,
/// the lines through `cm_daily::parse`, the rows through the loader's own
/// statements.
async fn load(pool: &sqlx::PgPool, name: &str, text: &str) -> (usize, usize, usize, u64, u64) {
    let path = scratch().join(name);
    std::fs::write(&path, text).expect("write the day's file");
    let day = cm_daily::file_day(&path).expect("the file name carries its day");
    assert_eq!(day, DAY, "the day the name carries");
    let file = cm_daily::parse(
        &std::fs::read_to_string(&path).expect("read the day's file"),
        &day,
    );
    let (rows, changed) = db::store_daily_offers(pool, &file.offers)
        .await
        .expect("load the day");
    (
        file.lines,
        file.valid(),
        file.skipped_total(),
        rows,
        changed,
    )
}

#[tokio::test]
async fn cm_daily_loads_a_day_replays_it_and_the_revert_drops_the_table() {
    if std::env::var("POKOIN_TEST_DATABASE_URL").is_err() {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    }
    let pool = pool().await;
    let noon = "2026-11-12T13:09:30.235Z";
    let evening = "2026-11-12T18:00:00.000Z";

    // The table is the migration's, not the loader's: without it the command is
    // refused (that message is `run_cm_daily`'s own check), and nothing here
    // creates it as a side effect. The revert runs first so a run that died
    // halfway leaves this one a clean database to start from.
    sqlx::raw_sql(REVERT)
        .execute(&pool)
        .await
        .expect("clean the day's table");
    assert!(
        !db::has_table(&pool, "public.cardmarket_offer_daily")
            .await
            .expect("to_regclass"),
        "the day's table was already there"
    );
    sqlx::raw_sql(MIGRATION)
        .execute(&pool)
        .await
        .expect("apply 145");
    // Idempotent: the writer may be given the same file twice.
    sqlx::raw_sql(MIGRATION)
        .execute(&pool)
        .await
        .expect("re-apply 145");
    assert!(
        db::has_table(&pool, "public.cardmarket_offer_daily")
            .await
            .expect("to_regclass"),
        "the migration did not create the table"
    );

    // One extra index beyond the primary key, and it is the day-anchored one
    // the report's freshness read needs (§4.1).
    let indexes: Vec<String> = sqlx::query_scalar(
        r#"select i.indexname from pg_indexes i
           where i.tablename = 'cardmarket_offer_daily' order by 1"#,
    )
    .fetch_all(&pool)
    .await
    .expect("the table's indexes");
    assert_eq!(
        indexes,
        vec![
            "cardmarket_offer_daily_day_idx".to_string(),
            "cardmarket_offer_daily_pkey".to_string()
        ],
        "{indexes:?}"
    );

    // The vocabulary the loader refused is also the vocabulary the table
    // refuses, so a writer that guesses cannot land a row the pricer would
    // later join wrong. Cardmarket's own `ZH-TW` is not a Pokoin key.
    for (language, condition) in [("ZH-TW", "NM"), ("IT", "Mint")] {
        let error = sqlx::query(
            r#"insert into public.cardmarket_offer_daily
                 (cm_product_id, day, language, condition, seller_type, finish,
                  first_edition, min_cents, asked, observed_at)
               values (279646, '2026-11-12', $1, $2, 'private', '*', '*', 100, true,
                       '2026-11-12T13:09:30.235Z')"#,
        )
        .bind(language)
        .bind(condition)
        .execute(&pool)
        .await
        .expect_err("a facet code outside the contract");
        let text = error.to_string();
        assert!(text.contains("check constraint"), "{text}");
    }

    // The day's first file: seven lines, four of them rows, three refused.
    let (lines, valid, skipped, staged, changed) =
        load(&pool, "daily-minimums-2026-11-12.jsonl", FILE_ONE).await;
    assert_eq!((lines, valid, skipped), (7, 4, 3));
    assert_eq!((staged, changed), (4, 4));
    assert_eq!(total(&pool).await, 4, "the refused lines left no row");
    // Cardmarket's `ZH-TW` is stored as Pokoin's `ZHT`, or the floor would never
    // join a listing.
    assert_eq!(
        facet(&pool, 279646, "ZHT", "NM", "private", noon).await,
        (1000, None, None, false, true),
        "a count the collector did not settle stays null"
    );
    assert_eq!(
        facet(&pool, 279646, "IT", "NM", "private", noon).await,
        (1000, Some(2), Some(true), true, true)
    );
    // The `*` language and the `Poor` floor are facets like any other.
    assert_eq!(
        facet(&pool, 279259, "EN", "Poor", "private", noon).await,
        (50, None, None, true, true)
    );

    // The same file again: the day is staged and written, and nothing changes.
    let (_, _, _, staged, changed) = load(&pool, "daily-minimums-2026-11-12.jsonl", FILE_ONE).await;
    assert_eq!(
        (staged, changed),
        (4, 0),
        "a replay of an unchanged file changes nothing"
    );
    assert_eq!(total(&pool).await, 4);
    assert_eq!(
        facet(&pool, 279646, "IT", "NM", "private", noon).await,
        (1000, Some(2), Some(true), true, true)
    );

    // The same day rewritten: the newer observation replaces its facet, the
    // older one is refused, and `asked` survives both directions.
    let (_, _, _, staged, changed) =
        load(&pool, "daily-minimums-2026-11-12-later.jsonl", FILE_TWO).await;
    assert_eq!((staged, changed), (3, 2), "only the newer lines changed");
    // Replaced: the price, the count and the moment, but not the fact that the
    // day aimed at this facet.
    assert_eq!(
        facet(&pool, 279646, "IT", "NM", "private", evening).await,
        (850, Some(5), Some(true), true, true),
        "a facet stays asked once any line said the walk aimed at it"
    );
    // Refused: an older answer cannot roll the day back, not even its `asked`.
    assert_eq!(
        facet(&pool, 279646, "IT", "SP", "pro", noon).await,
        (588, Some(4), Some(true), false, true),
        "an older observation did not touch the facet"
    );
    // Replaced and now aimed at.
    assert_eq!(
        facet(&pool, 279646, "ZHT", "NM", "private", evening).await,
        (900, Some(6), Some(false), true, true)
    );
    // And the day's other facets are exactly as the first file left them.
    assert_eq!(
        facet(&pool, 279259, "EN", "Poor", "private", noon).await,
        (50, None, None, true, true)
    );
    assert_eq!(total(&pool).await, 4, "a re-observed facet is one row");

    // The two reads the table exists for, printed so a reviewer can see the
    // shape the report predicted: one product across days, one day across
    // products.
    for sql in [
        "explain (costs off) select day, min_cents from public.cardmarket_offer_daily \
         where cm_product_id = 279646 and language = 'IT' and condition = 'NM' \
         and day between '2026-11-01' and '2026-11-12' order by day",
        "explain (costs off) select count(distinct cm_product_id) from public.cardmarket_offer_daily \
         where day = '2026-11-12'",
    ] {
        let plan = sqlx::query(sql).fetch_all(&pool).await.expect("explain");
        for row in plan {
            print!("{}", row.get::<String, _>("QUERY PLAN"));
        }
    }

    // The revert, and the table is gone with its rows and its index.
    sqlx::raw_sql(REVERT)
        .execute(&pool)
        .await
        .expect("revert 145");
    assert!(
        !db::has_table(&pool, "public.cardmarket_offer_daily")
            .await
            .expect("to_regclass"),
        "the revert left the table"
    );
    let left: i64 = sqlx::query_scalar(
        "select count(*) from pg_indexes where tablename = 'cardmarket_offer_daily'",
    )
    .fetch_one(&pool)
    .await
    .expect("the indexes after the revert");
    assert_eq!(left, 0, "the revert left an index");
    drop(pool);
}
