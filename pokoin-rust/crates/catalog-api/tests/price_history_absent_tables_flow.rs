//! PH-02 on a real Postgres: the price-history readers of a game whose database
//! has none of the Pokémon-only tables answer their own no-data blocks, send no
//! query, and leave the server with nothing to log.
//!
//! ```text
//! docker run -d --rm --name pokoin-ph02-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55492:5432 --tmpfs /var/lib/postgresql \
//!   postgres:19.0-alpine -c log_min_error_statement=error
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55492/postgres \
//!   cargo test -p pokoin-catalog-api --locked --test price_history_absent_tables_flow -- --nocapture
//! ```
//!
//! `log_min_error_statement=error` is what makes a query for an absent relation
//! reach the server log. The control issues two such queries on purpose, so
//! `docker logs pokoin-ph02-test-pg 2>&1 | grep ERROR` must show exactly its own
//! two lines and nothing else — no line for the request traffic.
//!
//! What the requests did is measured on `pg_stat_database.xact_rollback`, which
//! counts every statement Postgres aborted whatever the logging says, and that
//! counter has to be read carefully because Postgres is late twice over:
//!
//! * a backend hands its statistics to the shared counters only at an idle point
//!   more than `PGSTAT_MIN_INTERVAL` (1 s) after its last hand-over, and the
//!   hand-over it then defers is only guaranteed on the `PGSTAT_IDLE_INTERVAL`
//!   (10 s) timer it arms for itself, or when the backend exits;
//! * a reading session keeps the statistics snapshot it took first, so without
//!   `pg_stat_clear_snapshot()` it repeats one number forever.
//!
//! Every read therefore goes through `rollbacks`, which clears the snapshot on
//! the session it reads with and waits; the control closes the session that
//! failed its query, which reports its number now instead of in ten seconds; and
//! the "nothing was aborted" measurement waits out the ten-second bound for the
//! pools this test has no handle on. The control runs *before* the requests: a
//! counter that has been seen to move for a query this test issues itself cannot
//! then pass a "did not grow" assertion by being simply late.
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped, as every `*_flow`
//! test is. It recreates the `ph02_pokemon`, `ph02_magic` and `ph02_tcgcsv`
//! databases and drops nothing else.

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnection, PgPoolOptions};
use sqlx::{Connection, PgPool, Row};
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

/// The ask analytics of `LISTED_SQL`, which the magic database lacks.
const LISTED_TABLE: &str = "public.cardtrader_blueprint_daily_analytics";
/// One Cardmarket guide table, which the Pokémon database of this test lacks too.
const GUIDE_TABLE: &str = "public.cardmarket_price_guide_runs";

/// The very statement PH-02 blocks on the game pool, issued by the control.
const STRAY_LISTED_SQL: &str =
    "select min_price_pkn from public.cardtrader_blueprint_daily_analytics limit 1";
/// The same on the Pokémon side, whose Cardmarket leg queries the guide runs.
const STRAY_GUIDE_SQL: &str = "select 1 from public.cardmarket_price_guide_runs limit 1";

/// How long a counter read waits for the number it is looking for, which is
/// longer than the moment a just-closed backend takes to hand its statistics in.
const STAT_WAIT: Duration = Duration::from_secs(5);
const STAT_POLL: Duration = Duration::from_millis(100);
/// How long the readers must be left alone before a `Want::Unchanged` read says
/// anything. `pgstat_report_stat()` skips a hand-over that comes within
/// `PGSTAT_MIN_INTERVAL` (1 s) of the previous one — which is what a request
/// made of two statements does — and the statistics it then holds are only
/// certain to arrive on the `PGSTAT_IDLE_INTERVAL` (10 s) timer it arms for
/// itself. The game pool is one of the process-wide satellite pools the router
/// owns and cannot be closed from here, so the wait is the bound; the pools this
/// test does own are closed first, which reports them at once.
const IDLE_SETTLE: Duration = Duration::from_secs(12);
/// A "did not grow" claim is worth only the window it was watched for.
const IDLE_WATCH: Duration = Duration::from_millis(1_500);

/// The number a `rollbacks` read is looking for.
#[derive(Clone, Copy, Debug)]
enum Want {
    /// Nothing in particular: the first number that is not an old snapshot.
    Now,
    /// At least one above `base` — the control, which fails when the counter
    /// cannot move and so turns every later pass into a real one.
    Grown(i64),
    /// `base` still, for the whole of `IDLE_WATCH`. Nothing can be waited *for*
    /// here, so the watch ends when the number moves — which is the failure the
    /// caller asserts on — or when its window is over.
    Unchanged(i64),
}

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

/// One statement on a session of its own, which is then hung up. A backend
/// reports what it counted when it exits, so the control's own failing query is
/// in the counter straight away instead of behind `PGSTAT_IDLE_INTERVAL`.
async fn stray_query(url: &str, sql: &str) -> sqlx::Result<()> {
    let mut conn = PgConnection::connect(url).await?;
    let outcome = sqlx::query(sql).fetch_one(&mut conn).await.map(|_| ());
    drop(conn);
    outcome
}

/// Transactions Postgres aborted in one database, read until `want` is met or
/// its window is over; the last number read comes back, so the caller's
/// assertion reports what the server really counted.
///
/// The clear and the read run on one session, held for the whole poll:
/// `pg_stat_clear_snapshot()` only affects the session that calls it, and
/// without it Postgres answers every read from the snapshot that session took
/// first — the same number twice, whatever any reader did in between.
async fn rollbacks(admin: &PgPool, database: &str, want: Want) -> i64 {
    let mut conn = admin.acquire().await.expect("admin connection");
    let within = match want {
        Want::Now => Duration::ZERO,
        Want::Grown(_) => STAT_WAIT,
        Want::Unchanged(_) => IDLE_WATCH,
    };
    let started = Instant::now();
    loop {
        sqlx::query("select pg_stat_clear_snapshot()")
            .execute(&mut *conn)
            .await
            .expect("pg_stat_clear_snapshot");
        let row = sqlx::query("select xact_rollback from pg_stat_database where datname = $1")
            .bind(database)
            .fetch_one(&mut *conn)
            .await
            .expect("pg_stat_database row");
        let value = row
            .try_get::<i64, _>("xact_rollback")
            .expect("xact_rollback counter");
        let reached = match want {
            Want::Now => true,
            Want::Grown(base) => value > base,
            Want::Unchanged(base) => value != base,
        };
        if reached || started.elapsed() >= within {
            return value;
        }
        tokio::time::sleep(STAT_POLL).await;
    }
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
    let (pokemon_url, pokemon) = fresh_db(&admin, &base, "ph02_pokemon").await;
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

    // 1. The control, before a single request: each of the two queries PH-02 is
    //    about is issued on purpose against a database that lacks its table, and
    //    that database's counter must be seen to move for it. The number it moved
    //    to is the baseline of every assertion below, so a counter that is merely
    //    late — or simply dead — fails here instead of passing later.
    let mut baseline: Vec<(&str, i64)> = Vec::new();
    for (database, url, sql, table) in [
        ("ph02_magic", &magic_url, STRAY_LISTED_SQL, LISTED_TABLE),
        ("ph02_pokemon", &pokemon_url, STRAY_GUIDE_SQL, GUIDE_TABLE),
    ] {
        let before = rollbacks(&admin, database, Want::Now).await;
        let stray = stray_query(url, sql).await;
        assert!(stray.is_err(), "{database} must not have {table}");
        let after = rollbacks(&admin, database, Want::Grown(before)).await;
        assert!(
            after > before,
            "xact_rollback of {database} stayed {after} for {} s after a query for the absent \
             {table}, so it proves nothing",
            STAT_WAIT.as_secs()
        );
        println!("one stray query for {table} moved {database} xact_rollback {before} -> {after}");
        baseline.push((database, after));
    }

    // 2. The requests. Their bodies are asserted after the counter, below, so
    //    that a reader which goes back to querying an absent table is reported as
    //    PH-02 rather than as the `unavailable` status that failure brings with it.
    let (magic_status, magic_body) = history(
        &app,
        &format!("/api/marketplace-card-price-history?cardId=4152&game=magic&{RANGE}"),
    )
    .await;
    println!("magic price history: {magic_body}");

    //    A second request of the same game: the probed answer is cached.
    let (again_status, again) = history(
        &app,
        &format!("/api/marketplace-card-price-history?cardId=4152&game=magic&{RANGE}"),
    )
    .await;
    println!("magic price history, second request: {again}");

    //    And the same route on Pokémon, whose database really has the ask table.
    let (pokemon_status, pokemon_body) = history(
        &app,
        &format!("/api/marketplace-card-price-history?cardId=239324&{RANGE}"),
    )
    .await;
    println!("pokemon price history: {pokemon_body}");

    // 3. Neither database aborted a statement across the three requests. The
    //    pools this test owns — the router's Pokémon/main one included — are
    //    closed first, which reports what they counted, and what is left is the
    //    game's satellite pool: that waits out IDLE_SETTLE. Only then is the
    //    number read, twice, at least IDLE_WATCH apart.
    pokemon.close().await;
    magic.close().await;
    tcgcsv.close().await;
    tokio::time::sleep(IDLE_SETTLE).await;
    for (database, base) in baseline {
        let after = rollbacks(&admin, database, Want::Unchanged(base)).await;
        assert_eq!(
            after, base,
            "{database} aborted a statement across the three requests: PH-02 is back"
        );
    }

    // 4. The magic printing: every source answered, and the magic database was
    //    asked nothing but the probe.
    assert_eq!(magic_status, StatusCode::OK);
    assert_eq!(again_status, StatusCode::OK);
    assert_eq!(pokemon_status, StatusCode::OK);
    assert_eq!(magic_body["game"], "magic");
    assert_eq!(magic_body["cardId"], "4152");
    assert_eq!(magic_body["ctId"], json!("2076"));
    assert_eq!(magic_body["cardtrader"]["status"], "empty");
    assert_eq!(magic_body["cardtrader"]["source"], "cardtrader_listed");
    assert!(magic_body["cardtrader"]["days"]
        .as_array()
        .expect("days")
        .is_empty());
    assert_eq!(magic_body["cardmarket"]["status"], "unsupported_game");
    // TCGplayer is not a game database read, so its days survive — and they
    // carry `marketPkn`, which only the Pokémon rates can give them:
    // 2.50 USD at 1.25 EUR/USD is 400 PKN.
    assert_eq!(magic_body["tcgplayer"]["status"], "available");
    assert_eq!(
        magic_body["fx"],
        json!({"base": "EUR", "quote": "USD", "firstDay": "2026-01-01", "lastDay": "2026-10-01"})
    );
    assert_eq!(
        magic_body["tcgplayer"]["series"][0]["days"][0]["day"],
        "2026-11-02"
    );
    assert_eq!(
        magic_body["tcgplayer"]["series"][0]["days"][0]["marketPkn"],
        json!(400)
    );

    //    The cached second request answers the same, table by table.
    assert_eq!(again["cardtrader"]["status"], "empty");
    assert_eq!(again["fx"], magic_body["fx"]);

    // 5. Pokémon behaviour is unchanged: its ask day is still there, and its
    //    Cardmarket leg — whose tables were created in neither database — answers
    //    `empty` instead of failing.
    assert_eq!(pokemon_body["cardtrader"]["status"], "available");
    assert_eq!(
        pokemon_body["cardtrader"]["days"].as_array().unwrap().len(),
        1
    );
    assert_eq!(pokemon_body["cardtrader"]["days"][0]["day"], "2026-11-02");
    assert_eq!(pokemon_body["cardmarket"]["status"], "empty");
    assert_eq!(pokemon_body["fx"]["lastDay"], "2026-10-01");

    admin.close().await;
}
