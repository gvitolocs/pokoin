//! The `sources` block of a price-check comp against a real Postgres: the
//! CardTrader sold rows query, the Cardmarket guide tables and the FX rate
//! from the production migration (`scripts/sql/139_pricer_sources.sql`), the
//! TCGNotify overlay (`scripts/sql/140_tcgnotify_price_guide.sql`), and the
//! TCGCSV store pointed at the same database.
//!
//! ```text
//! docker run -d --rm --name pokoin-pricer-sources-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55482:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55482/postgres \
//!   cargo test -p pokoin-external --test pricer_sources_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped. It drops and
//! recreates the tables it touches: a throwaway database only.

use pokoin_external::ct_fees::Channel;
use pokoin_external::db::DbPools;
use pokoin_external::price_check::{self, parse_items};
use pokoin_external::price_sources::round2;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;

const MIGRATION: &str = include_str!("../../../../scripts/sql/139_pricer_sources.sql");
const MIGRATION_TCGNOTIFY: &str = include_str!("../../../../scripts/sql/140_tcgnotify_price_guide.sql");

const SCHEMA: &str = "
drop table if exists public.marketplace_search_candidates, public.marketplace_user_listings,
  public.cardtrader_facet_price_runs, public.cardtrader_facet_prices,
  public.cardtrader_blueprint_daily_analytics, public.cardtrader_sold_daily,
  public.cardtrader_pokemon_blueprints, public.pokoin_product_links, public.latest_prices,
  public.cardmarket_price_guide, public.cardmarket_price_guide_runs, public.fx_rates_daily,
  public.tcgnotify_price_guide, public.tcgnotify_price_guide_runs cascade;
create table public.marketplace_search_candidates (card_id bigint primary key, ct_id bigint);
create table public.marketplace_user_listings (
  card_id text not null, seller_uid text not null, status text not null default 'active',
  quantity_available integer not null default 1, price_pkn numeric not null default 0,
  marketplace_game text not null default 'pokemon');
create table public.cardtrader_facet_price_runs (game text primary key, refreshed_at timestamptz not null);
create table public.cardtrader_facet_prices (
  game text not null, card_id bigint not null, language text not null, condition text not null,
  foil boolean not null, first_edition boolean not null, min_pkn numeric not null,
  offers integer not null default 0, basis text not null);
create table public.cardtrader_blueprint_daily_analytics (
  blueprint_id bigint, observed_day date, refreshed_at timestamptz,
  min_price_pkn numeric, listing_count integer, listed_quantity integer, seller_count integer);
create table public.cardtrader_sold_daily (
  blueprint_id bigint, observed_day date, condition text, language text,
  reverse boolean, first_edition boolean, graded boolean, median_pkn numeric, sold_qty integer);
create table public.cardtrader_pokemon_blueprints (id bigint primary key, card_market_ids jsonb);
create table public.pokoin_product_links (card_id bigint, product_id bigint, game text, active boolean);
create table public.latest_prices (
  product_id bigint primary key, category_id integer, subtype text,
  market_price numeric, low_price numeric, mid_price numeric, snapshot_timestamp timestamptz);
";

const DATA: &str = "
insert into public.marketplace_search_candidates values (200, 100);
insert into public.marketplace_user_listings (card_id, seller_uid, price_pkn) values ('200', 'someone', 30);
insert into public.cardtrader_facet_price_runs values ('pokemon', now());
insert into public.cardtrader_facet_prices values ('pokemon', 200, 'EN', 'NM', false, false, 100, 3, 'pro');
insert into public.cardtrader_sold_daily values
  (100, current_date, 'NM', 'EN', false, false, false, 100, 2),
  (100, current_date, 'NM', 'EN', true,  false, false, 200, 1),
  (100, current_date, 'SP', 'IT', false, false, false, 50, 1),
  (100, current_date, 'NM', 'EN', false, false, true,  999, 1);
insert into public.cardtrader_pokemon_blueprints values (100, '[\"11\", \"12\"]');
insert into public.pokoin_product_links values (200, 1, 'pokemon', true);
insert into public.latest_prices values (1, 3, 'Reverse Holofoil', 4.0, 3.5, 3.8, now());

insert into public.cardmarket_price_guide_runs values ('pokemon', current_date, 1, 2, 2);
insert into public.cardmarket_price_guide (game, id_product, day, trend, trend_foil, low) values
  ('pokemon', 11, current_date, 1.23, 5.0, 1.0),
  ('pokemon', 12, current_date, 2.0, null, null);
update public.cardmarket_price_guide set low_foil = 0.5 where id_product = 12;
insert into public.fx_rates_daily (day, base, quote, rate) values (current_date, 'EUR', 'USD', 1.0812);
";

fn today() -> String {
    pokoin_external::time_util::iso_from_ms(pokoin_external::time_util::now_ms())
        .get(..10)
        .unwrap_or("")
        .to_string()
}

#[tokio::test]
async fn read_prices_attaches_every_source_from_the_real_tables() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    // The TCGCSV store reads its own env; point it at the same test database
    // before its lazy pool is first built.
    std::env::set_var("TCGCSV_DATABASE_URL", &url);
    std::env::set_var("TCGCSV_DATABASE_SSL", "0");

    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.expect("connect");
    sqlx::raw_sql(SCHEMA).execute(&pool).await.expect("schema");
    sqlx::raw_sql(MIGRATION).execute(&pool).await.expect("migration 139");
    sqlx::raw_sql(MIGRATION_TCGNOTIFY).execute(&pool).await.expect("migration 140");
    sqlx::raw_sql(DATA).execute(&pool).await.expect("data");

    let db = DbPools::lazy(pool.clone(), pool.clone());
    let items = parse_items("200:NM:EN,200:NM:EN:R");
    let prices = price_check::read_prices(&db, "pokemon", &items, "", None).await.expect("read_prices");

    // The rest of the comp is intact: the price store floor and Pokoin's ask.
    let comp: &Value = &prices["200:NM:EN:"];
    assert_eq!(comp["pokoinCheapestPkn"], json!(30.0));
    assert_eq!(comp["ctCheapestGrossPkn"], json!(100.0));

    // CardTrader sold, from the rows query: "" over all rows (graded
    // included) is soldMedianGrossPkn; the other keys are ungraded only.
    assert_eq!(comp["soldMedianGrossPkn"], json!(150.0), "median of 50, 100, 200, 999");
    let sold = &comp["sources"]["cardtrader"]["sold"];
    assert_eq!(sold[""]["grossPkn"], json!(150.0));
    assert_eq!(sold["C"]["grossPkn"], json!(150.0), "median of the NM rows 100, 200");
    assert_eq!(sold["L"]["grossPkn"], json!(150.0), "median of the EN rows 100, 200");
    assert_eq!(sold["F"]["grossPkn"], json!(75.0), "plain item: median of 100, 50");
    assert_eq!(sold["CLFE"]["grossPkn"], json!(100.0));
    let rule = pokoin_external::ct_fees::rule();
    assert_eq!(sold["CLFE"]["pkn"], json!(rule.net_pkn(100.0, Channel::Direct).map(round2)));

    // Pokoin's own sold feed was not loaded: omitted, status unavailable.
    assert!(comp["sources"].get("pokoin").is_none());
    assert_eq!(comp["sourceStatus"]["pokoinSold"], json!("unavailable"));

    // Cardmarket guide: newest row per product, min positive over products.
    // No TCGNotify run has been loaded, so `low` is still the guide's.
    let cm = &comp["sources"]["cardmarket"];
    assert_eq!(cm["asOf"], json!(today()));
    assert_eq!(cm["trend"]["F"]["eur"], json!(1.23), "regular: min(1.23, 2.0)");
    assert_eq!(cm["trend"]["F"]["grossPkn"], json!(246.0));
    assert_eq!(cm["trend"]["F"]["pkn"], json!(246.0), "no CardTrader fee here");
    assert_eq!(cm["trend"][""]["eur"], json!(1.23), "min(regular 1.23, foil 5.0)");
    assert_eq!(cm["low"]["F"]["eur"], json!(1.0));
    assert_eq!(cm["low"][""]["eur"], json!(0.5), "min(regular 1.0, foil 0.5)");

    // TCGplayer: the linked product's quote, converted at the day's rate.
    let tcg = &comp["sources"]["tcgplayer"];
    assert_eq!(tcg["asOf"], json!(today()));
    assert_eq!(tcg["rateDay"], json!(today()));
    assert_eq!(tcg["usdPerEur"], json!(1.0812));
    assert_eq!(tcg["market"][""]["usd"], json!(4.0));
    assert_eq!(tcg["market"][""]["grossPkn"], json!(round2(4.0 / 1.0812 * 200.0)));
    assert_eq!(tcg["market"][""]["pkn"], tcg["market"][""]["grossPkn"]);
    assert!(tcg["market"].get("F").is_none(), "the only row is reverse; a plain item has no F");
    assert!(tcg["market"].get("FE").is_none(), "FE needs the finish too");
    assert_eq!(tcg["market"]["E"]["usd"], json!(4.0), "not 1st edition: the reverse row qualifies");
    assert_eq!(comp["tcgplayer"][0]["productId"], json!(1));
    assert_eq!(comp["tcgplayer"][0]["subtype"], json!("Reverse Holofoil"));
    assert_eq!(comp["tcgplayerStatus"], json!("available"));

    assert_eq!(
        comp["sourceStatus"],
        json!({ "cardtraderSold": "available", "pokoinSold": "unavailable", "cardmarket": "available", "tcgplayer": "available" })
    );

    // The reverse item prices the reverse rows in both feeds.
    let rev: &Value = &prices["200:NM:EN:R"];
    assert_eq!(rev["sources"]["cardtrader"]["sold"]["F"]["grossPkn"], json!(200.0));
    assert_eq!(rev["sources"]["tcgplayer"]["market"]["F"]["usd"], json!(4.0));

    // A loaded TCGNotify run wins `low` and nothing else. Product 11 has an
    // older row too (change-only history); product 12 is delisted (null ask).
    sqlx::raw_sql(
        "insert into public.tcgnotify_price_guide_runs values ('pokemon', current_date, 2, 2);
         insert into public.tcgnotify_price_guide (game, id_product, day, min_price) values
           ('pokemon', 11, current_date - 3, 9.99),
           ('pokemon', 11, current_date, 0.75),
           ('pokemon', 12, current_date, null);",
    )
    .execute(&pool)
    .await
    .expect("tcgnotify rows");
    let prices = price_check::read_prices(&db, "pokemon", &items, "", None).await.expect("read_prices");
    let cm = &prices["200:NM:EN:"]["sources"]["cardmarket"];
    assert_eq!(cm["low"]["F"]["eur"], json!(0.75), "the newest ask, not the older 9.99");
    assert_eq!(cm["low"]["F"]["grossPkn"], json!(150.0));
    assert_eq!(cm["low"][""]["eur"], json!(0.5), "product 12 has no ask: its guide low_foil stands");
    assert_eq!(cm["trend"]["F"]["eur"], json!(1.23), "TCGNotify publishes no trend");
    assert_eq!(cm["trend"][""]["eur"], json!(1.23), "min(1.23, 5.0): the foil value is untouched");
    assert_eq!(cm["asOf"], json!(today()), "the guide's run day: a basis is overridden, not the feed");
    assert_eq!(prices["200:NM:EN:"]["sourceStatus"]["cardmarket"], json!("available"));

    // A product the official guide never priced still gets a `low` from here.
    sqlx::raw_sql(
        "update public.cardtrader_pokemon_blueprints set card_market_ids = '[\"11\", \"12\", \"13\"]' where id = 100;
         insert into public.tcgnotify_price_guide (game, id_product, day, min_price)
           values ('pokemon', 13, current_date, 0.4);",
    )
    .execute(&pool)
    .await
    .expect("uncovered product");
    let prices = price_check::read_prices(&db, "pokemon", &items, "", None).await.expect("read_prices");
    let cm = &prices["200:NM:EN:"]["sources"]["cardmarket"];
    assert_eq!(cm["low"]["F"]["eur"], json!(0.4), "min(0.75, 0.4) over the three products");
    assert_eq!(cm["low"][""]["eur"], json!(0.4));
    assert_eq!(cm["trend"]["F"]["eur"], json!(1.23), "product 13 has no trend to contribute");

    // A run older than four days is not trusted: back to the guide alone.
    sqlx::raw_sql("update public.tcgnotify_price_guide_runs set day = current_date - 10 where game = 'pokemon'")
        .execute(&pool)
        .await
        .expect("stale run");
    let prices = price_check::read_prices(&db, "pokemon", &items, "", None).await.expect("read_prices");
    let cm = &prices["200:NM:EN:"]["sources"]["cardmarket"];
    assert_eq!(cm["low"]["F"]["eur"], json!(1.0));
    assert_eq!(cm["low"][""]["eur"], json!(0.5));

    // Migration 140 not applied at all: the comp still reads, on the guide.
    sqlx::raw_sql("drop table public.tcgnotify_price_guide, public.tcgnotify_price_guide_runs")
        .execute(&pool)
        .await
        .expect("drop tcgnotify");
    let prices = price_check::read_prices(&db, "pokemon", &items, "", None).await.expect("read_prices");
    let cm = &prices["200:NM:EN:"]["sources"]["cardmarket"];
    assert_eq!(cm["low"]["F"]["eur"], json!(1.0));
    assert_eq!(cm["low"][""]["eur"], json!(0.5));
    assert_eq!(prices["200:NM:EN:"]["sourceStatus"]["cardmarket"], json!("available"));
}
