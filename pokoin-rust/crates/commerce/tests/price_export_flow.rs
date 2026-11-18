//! End-to-end price export on a real Postgres: seed `cardtrader_sold_daily`
//! and `cheapest_homepage_cache_blueprint`, run the export query, and read
//! the `PKP2` file back.
//!
//! Needs its own throwaway database — the test drops and recreates its
//! tables, so do not share a container with the seller-api flow test:
//!
//! ```text
//! docker run -d --rm --name pokoin-price-export-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55496:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_PRICE_EXPORT_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55496/postgres \
//!   cargo test -p pokoin-commerce --test price_export_flow
//! ```
//!
//! Without `POKOIN_PRICE_EXPORT_TEST_DATABASE_URL` the test is skipped.

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use pokoin_commerce::price_export::{self, PriceRow, LANGUAGES, LANG_ANY, SOURCE_CARDTRADER, SOURCE_SOLD_30D};

const FIXTURE_SQL: &str = "
drop table if exists cardtrader_sold_daily cascade;
drop table if exists cheapest_homepage_cache_blueprint cascade;
drop view if exists cheapest_homepage_cache_blueprint cascade;
create table cardtrader_sold_daily (
  blueprint_id bigint not null,
  condition text not null,
  language text not null,
  reverse boolean not null default false,
  first_edition boolean not null default false,
  graded boolean not null default false,
  sold_qty integer not null default 0,
  min_pkn numeric,
  observed_day date not null
);
create table cheapest_homepage_cache_blueprint (
  blueprint_id bigint not null,
  provider text not null,
  cheapest_price_pkn numeric
);
";

async fn run_sql(pool: &PgPool, sql: &str) {
    sqlx::raw_sql(sql).execute(pool).await.expect("schema");
}

#[allow(clippy::too_many_arguments)] // a fixture row builder: every column is a fact of the rule under test
fn sold(blueprint_id: i64, condition: &str, language: &str, reverse: bool, first_edition: bool, graded: bool, sold_qty: i32, min_pkn: &str, age_days: i32) -> String {
    format!("({blueprint_id}, '{condition}', '{language}', {reverse}, {first_edition}, {graded}, {sold_qty}, {min_pkn}, current_date - {age_days})")
}

fn tile(blueprint_id: i64, provider: &str, price: &str) -> String {
    format!("({blueprint_id}, '{provider}', {price})")
}

fn row(card_id: u32, lang: u8, source: u8, cents: u32) -> PriceRow {
    PriceRow { card_id, lang, source, cents }
}

/// Every rule in one pass: source order, the NM/ungraded/raw filters, the
/// window, the per-language rows and the cheapest-across-languages "any" row,
/// the PKP2 encoding.
#[tokio::test]
async fn the_export_follows_the_connector_price_rule_and_encodes_sorted_rows() {
    let Ok(url) = std::env::var("POKOIN_PRICE_EXPORT_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_PRICE_EXPORT_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = PgPoolOptions::new().max_connections(2).connect(&url).await.expect("test database");
    run_sql(&pool, FIXTURE_SQL).await;
    let en = |name: &str| LANGUAGES.iter().position(|l| *l == name).unwrap() as u8 + 1;

    run_sql(
        &pool,
        &format!(
            "insert into cardtrader_sold_daily (blueprint_id, condition, language, reverse, first_edition, graded, sold_qty, min_pkn, observed_day) values {}",
            [
                // Card 2000 (blueprint 1000): NM EN/IT sales inside the window…
                sold(1000, "NM", "EN", false, false, false, 1, "38", 3),
                sold(1000, "NM", "IT", false, false, false, 1, "20", 1),
                // …and every variant the rule must ignore: graded, reverse,
                // first edition, played, outside the window, no sold units,
                // a language outside the fixed list (DA is not one of the 16).
                sold(1000, "NM", "EN", false, false, true, 1, "2", 1),
                sold(1000, "NM", "EN", true, false, false, 1, "3", 1),
                sold(1000, "NM", "EN", false, true, false, 1, "4", 1),
                sold(1000, "SP", "EN", false, false, false, 1, "1", 1),
                sold(1000, "NM", "EN", false, false, false, 1, "6", 40),
                sold(1000, "NM", "EN", false, false, false, 0, "7", 1),
                sold(1000, "NM", "DA", false, false, false, 1, "8", 1),
                sold(-4, "NM", "EN", false, false, false, 1, "5", 1),
                // Card 10000 (blueprint 5000): the window is inclusive at 30 days.
                sold(5000, "NM", "EN", false, false, false, 1, "10", 30),
                sold(5000, "NM", "EN", false, false, false, 1, "2", 31),
                // Card 8000 (blueprint 4000): only a reverse sale sold — the
                // tile minimum must take over.
                sold(4000, "NM", "EN", true, false, false, 1, "5", 1),
            ]
            .join(",")
        ),
    )
    .await;
    run_sql(
        &pool,
        &format!(
            "insert into cheapest_homepage_cache_blueprint (blueprint_id, provider, cheapest_price_pkn) values {}",
            [
                // Card 2000: a CardTrader ask cheaper than the sold minimum.
                tile(1000, "cardtrader", "12"),
                tile(1000, "cardtrader", "10"),
                // Card 4000: listing cache only; a pokoin_native row must not count.
                tile(2000, "cardtrader", "50"),
                tile(2000, "cardtrader", "44"),
                tile(2000, "pokoin_native", "5"),
                // Card 8000: the fallback for a card with only ignored sales.
                tile(4000, "cardtrader", "30"),
                // Card 12000 (blueprint 6000) gets no tile at all.
            ]
            .join(",")
        ),
    )
    .await;

    run_sql(&pool, "insert into cardtrader_sold_daily (blueprint_id, condition, language, reverse, first_edition, graded, sold_qty, min_pkn, observed_day) values (6000, 'Poor', 'EN', false, false, false, 1, '2', current_date - 1), (6000, 'NM', 'EN', false, false, false, 1, '0.4', current_date - 1)").await;

    let rows = price_export::collect_price_rows(&pool).await.expect("export");

    // Source order: card 2000's 38 PKN NM EN sale (19 cents) wins over its
    // cheaper 10 PKN CardTrader ask (5 cents). Any-language is the cheapest
    // sold language (10), not the out-of-list DA sale (4) and not the ask (5).
    // Card 4000 and 8000 have no qualifying sale: their "any" row is the
    // CardTrader tile minimum, `source` cardtrader. Card 12000 has nothing
    // qualifying at all: no rows, not even a zero-cent one.
    let expected = vec![
        row(2000, LANG_ANY, SOURCE_SOLD_30D, 10),
        row(2000, en("EN"), SOURCE_SOLD_30D, 19),
        row(2000, en("IT"), SOURCE_SOLD_30D, 10),
        row(4000, LANG_ANY, SOURCE_CARDTRADER, 22),
        row(8000, LANG_ANY, SOURCE_CARDTRADER, 15),
        row(10000, LANG_ANY, SOURCE_SOLD_30D, 5),
        row(10000, en("EN"), SOURCE_SOLD_30D, 5),
    ];
    assert_eq!(rows, expected, "export rows, sorted by (card_id, lang)");

    // The file carries the same rows back, with a truthful header.
    let (header, decoded) = price_export::decode(&price_export::encode(1_760_000_000, &rows)).unwrap();
    assert_eq!(decoded, expected);
    assert_eq!(header.version, price_export::FORMAT_VERSION);
    assert_eq!(header.row_count, expected.len() as u32);
    assert_eq!(header.source_count, 4, "four distinct cards carry rows");
    assert_eq!(header.as_of, 1_760_000_000);
}
