//! PH-02 on a real Postgres: the price-history readers of a game whose database
//! has none of the Pokémon-only tables answer their own no-data blocks, send no
//! query, and leave the server with nothing to log.
//!
//! ```text
//! docker run -d --rm --name pokoin-ph02-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55492:5432 --tmpfs /var/lib/postgresql/data \
//!   -c log_min_error_statement=error postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55492/postgres \
//!   cargo test -p pokoin-catalog-api --locked --test price_history_absent_tables_flow -- --nocapture
//! ```
//!
//! `log_min_error_statement=error` is what makes a query for an absent relation
//! reach the server log; `docker logs <name> | grep ERROR` must then show
//! nothing, which is the outer half of this check. `scripts/check-fast --db`
//! starts the same image without that flag, and the test does not need it: the
//! assertion below is `pg_stat_database.xact_rollback`, which counts every
//! statement Postgres aborted, whatever the logging says.
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped, as every `*_flow`
//! test is. It recreates the `ph02_pokemon`, `ph02_magic` and `ph02_tcgcsv`
//! databases and drops nothing else.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use tower::ServiceExt;

/// The catalog table every request starts from. Only the five columns of
/// `CARD_SQL` matter here.
const CATALOG_SCHEMA: &str = r#"
create table public.marketplace_search_candidates (
  card_id bigint primary key, ct_id bigint, name text not null default '',
  expansion_name text not null default '', card_number text not null default '');
"#;

/// The tables a request may ask for: the ask analytics and the rates. The
/// Cardmarket guide tables are deliberately created in neither database, so
/// that leg is guarded on the Pokémon side too.
const PRICE_TABLES: &str = r#"
create table public.cardtrader_blueprint_daily_analytics (
  blueprint_id bigint not null, observed_day date not null,
  refreshed_at timestamptz not null default now(), min_price_pkn numeric,
  listing_count integer not null default 0, listed_quantity integer not null default 0,
  seller_count integer not null default 0);
create table public.fx_rates_daily (
  day date not null, base text not null, quote text not null, rate numeric not null,
  primary key (day, base, quote));
"#;

const PRICE_SEED: &str = r#"
insert into public.cardtrader_blueprint_daily_analytics
  (blueprint_id, observed_day, refreshed_at, min_price_pkn, listing_count, listed_quantity, seller_count)
  values (415200, '2026-11-02', '2026-11-02 06:00:00+00', 300, 2, 2, 1);
insert into public.fx_rates_daily (day, base, quote, rate)
  values ('2026-01-01', 'EUR', 'USD', 1.10), ('2026-10-01', 'EUR', 'USD', 1.25);
"#;

/// The TCGCSV history database, which is the same for every game and holds none
/// of the tables above.
const TCGCSV_SCHEMA: &str = r#"
create table public.pokoin_product_links (
  product_id bigint not null, game text not null, card_id bigint not null,
  active boolean not null default true);
create table public.latest_prices (product_id bigint not null, category_id integer not null);
create table public.all_daily_prices (
  product_id bigint not null, category_id integer not null, observed_on date not null,
  subtype text not null default 'normal', market_price numeric);
insert into public.pokoin_product_links (product_id, game, card_id, active)
  values (900001, 'magic', 4152, true);
insert into public.latest_prices (product_id, category_id) values (900001, 3);
insert into public.all_daily_prices (product_id, category_id, observed_on, subtype, market_price)
  values (900001, 3, '2026-11-02', 'normal', 2.50);
"#;

const RANGE: &str = "from=2026-10-01&to=2026-11-16";

async fn exec_all(pool: &PgPool, sql: &str) {
    sqlx::raw_sql(sql)
        .execute(pool)
        .await
        .expect("schema/seed sql");
}

async fn fresh_db(admin: &PgPool, base: &str, name: &str) -> (String, PgPool) {
    sqlx::query(&format!("drop database if exists {name} with (force)"))
        .execute(admin)
        .await
        .unwrap();
    sqlx::query(&format!("create database {name}"))
        .execute(admin)
        .await
        .unwrap();
    let url = format!("{}/{name}", base.rsplit_once('/').unwrap().0);
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .unwrap();
    (url, pool)
}

/// Transactions Postgres aborted in one database. A query for an absent
/// relation is exactly one of these, so its delta across a request is the
/// server's own count of the errors PH-02 is about.
async fn rollbacks(admin: &PgPool, database: &str) -> i64 {
    let row = sqlx::query("select xact_rollback from pg_stat_database where datname = $1")
        .bind(database)
        .fetch_one(admin)
        .await
        .unwrap();
    row.try_get::<i64, _>("xact_rollback").unwrap()
}

async fn history(app: &axum::Router, uri: &str) -> (StatusCode, Value) {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn price_history_never_queries_a_table_the_game_lacks() {
    let Ok(base) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("POKOIN_TEST_DATABASE_URL unset; skipping");
        return;
    };
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&base)
        .await
        .unwrap();
    let (_, pokemon) = fresh_db(&admin, &base, "ph02_pokemon").await;
    let (magic_url, magic) = fresh_db(&admin, &base, "ph02_magic").await;
    let (tcgcsv_url, tcgcsv) = fresh_db(&admin, &base, "ph02_tcgcsv").await;

    exec_all(&pokemon, CATALOG_SCHEMA).await;
    exec_all(&magic, CATALOG_SCHEMA).await;
    exec_all(&pokemon, PRICE_TABLES).await;
    exec_all(&pokemon, PRICE_SEED).await;
    exec_all(&tcgcsv, TCGCSV_SCHEMA).await;
    for (pool, card_id, ct_id, name, set_name) in [
        (&pokemon, 239324_i64, 415200_i64, "Charizard", "Base Set"),
        (&magic, 4152_i64, 2076_i64, "Lightning Bolt", "Masters 25"),
    ] {
        sqlx::query(
            "insert into public.marketplace_search_candidates \
             (card_id, ct_id, name, expansion_name, card_number) values ($1,$2,$3,$4,$5)",
        )
        .bind(card_id)
        .bind(ct_id)
        .bind(name)
        .bind(set_name)
        .bind("141")
        .execute(pool)
        .await
        .unwrap();
    }

    // The satellite game reads its own database; the history rates always come
    // from the Pokémon one, which is the pool `ApiState` was built with.
    std::env::set_var("MAGIC_MARKETPLACE_DATABASE_URL", &magic_url);
    std::env::set_var("TCGCSV_DATABASE_URL", &tcgcsv_url);
    std::env::set_var("TCGCSV_DATABASE_SSL", "0");

    let state = pokoin_api_common::RouteState::new(
        pokoin_api_common::ApiState::new(pokemon.clone(), pokemon.clone(), None, 1),
        pokoin_accounts::DomainState::default(),
    );
    let app = pokoin_catalog_api::router(state);

    // What the server would have written down. The assertions below do not
    // depend on it: `xact_rollback` counts an aborted statement either way.
    let logged =
        sqlx::query("select setting from pg_settings where name = 'log_min_error_statement'")
            .fetch_optional(&admin)
            .await
            .ok()
            .flatten()
            .and_then(|row| row.try_get::<String, _>("setting").ok())
            .unwrap_or_else(|| "unreadable".to_owned());
    println!("log_min_error_statement = {logged}");

    let before_magic = rollbacks(&admin, "ph02_magic").await;
    let before_pokemon = rollbacks(&admin, "ph02_pokemon").await;

    // 1. The magic printing: every source answers, and the magic database is
    //    asked nothing but the probe.
    let (status, body) = history(
        &app,
        &format!("/api/marketplace-card-price-history?cardId=4152&game=magic&{RANGE}"),
    )
    .await;
    println!("magic price history: {body}");
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["game"], "magic");
    assert_eq!(body["cardId"], "4152");
    assert_eq!(body["ctId"], json!("2076"));
    assert_eq!(body["cardtrader"]["status"], "empty");
    assert_eq!(body["cardtrader"]["source"], "cardtrader_listed");
    assert!(body["cardtrader"]["days"]
        .as_array()
        .expect("days")
        .is_empty());
    assert_eq!(body["cardmarket"]["status"], "unsupported_game");
    // TCGplayer is not a game database read, so its days survive — and they
    // carry `marketPkn`, which only the Pokémon rates can give them:
    // 2.50 USD at 1.25 EUR/USD is 400 PKN.
    assert_eq!(body["tcgplayer"]["status"], "available");
    assert_eq!(
        body["fx"],
        json!({"base": "EUR", "quote": "USD", "firstDay": "2026-01-01", "lastDay": "2026-10-01"})
    );
    assert_eq!(
        body["tcgplayer"]["series"][0]["days"][0]["day"],
        "2026-11-02"
    );
    assert_eq!(
        body["tcgplayer"]["series"][0]["days"][0]["marketPkn"],
        json!(400)
    );

    // 2. A second request of the same game: the probed answer is cached, so it
    //    still costs no failing statement.
    let (_, again) = history(
        &app,
        &format!("/api/marketplace-card-price-history?cardId=4152&game=magic&{RANGE}"),
    )
    .await;
    assert_eq!(again["cardtrader"]["status"], "empty");
    assert_eq!(again["fx"], body["fx"]);

    // 3. The same route on Pokémon, whose database really has the ask table:
    //    unchanged behaviour, and the Cardmarket leg, whose tables were created
    //    in neither database, answers `empty` instead of failing.
    let (status, body) = history(
        &app,
        &format!("/api/marketplace-card-price-history?cardId=239324&{RANGE}"),
    )
    .await;
    println!("pokemon price history: {body}");
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["cardtrader"]["status"], "available");
    assert_eq!(body["cardtrader"]["days"].as_array().unwrap().len(), 1);
    assert_eq!(body["cardtrader"]["days"][0]["day"], "2026-11-02");
    assert_eq!(body["cardmarket"]["status"], "empty");
    assert_eq!(body["fx"]["lastDay"], "2026-10-01");

    assert_eq!(
        rollbacks(&admin, "ph02_magic").await,
        before_magic,
        "the magic database aborted a statement: PH-02 is back"
    );
    assert_eq!(
        rollbacks(&admin, "ph02_pokemon").await,
        before_pokemon,
        "the pokemon database aborted a statement"
    );

    // 4. The counter is not vacuous: the very query the guard now blocks does
    //    move it, and Postgres writes the ERROR line the finding is about.
    let stray = sqlx::query(
        "select min_price_pkn from public.cardtrader_blueprint_daily_analytics limit 1",
    )
    .fetch_one(&magic)
    .await;
    assert!(
        stray.is_err(),
        "the magic database must not have the table: {stray:?}"
    );
    let after_stray = rollbacks(&admin, "ph02_magic").await;
    assert!(
        after_stray > before_magic,
        "xact_rollback stayed {before_magic} after a query for an absent relation, so it proves nothing"
    );
    println!("one stray query moved ph02_magic xact_rollback {before_magic} -> {after_stray}");

    admin.close().await;
    pokemon.close().await;
    magic.close().await;
    tcgcsv.close().await;
}
