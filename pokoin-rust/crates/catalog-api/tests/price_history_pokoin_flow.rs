//! PH-06 and PH-02 on a real Postgres: the `pokoin` leg of
//! `GET /api/marketplace-card-price-history` folds a card's listing events into
//! one cheapest-live-ask point per UTC day with a single statement, and a game
//! whose database has no `marketplace_user_listing_events` answers `empty`
//! without querying for it.
//!
//! ```text
//! docker run -d --rm --name pokoin-ph06-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55493:5432 --tmpfs /var/lib/postgresql/data \
//!   postgres:17-alpine -c log_min_error_statement=error
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55493/postgres \
//!   cargo test -p pokoin-catalog-api --locked --test price_history_pokoin_flow -- --nocapture
//! ```
//!
//! The absent-table half is measured the way PH-02 measures it, for the reasons
//! spelled out in `price_history_absent_tables_flow.rs`: the server logs an ERROR
//! for every aborted statement (`log_min_error_statement=error`) and
//! `pg_stat_database.xact_rollback` counts every one whatever the logging says.
//! A control query for the very table PH-06 guards is issued first on purpose, so
//! a counter that cannot move fails here rather than passing later; the requests
//! then must not move it again. `grep ERROR` over this container's log after a
//! clean run shows the control's own lines and nothing from the request traffic.
//!
//! The sizes it prints are what PH-06 is about: one printing's answer with and
//! without `fields=graph`, for a 3-month span (day by day) and for `All` (one
//! point per ISO week). The rows are seeded to the density of the real database —
//! a CardTrader ask day for every day of the span, four TCGplayer series over it,
//! daily EUR→USD rates, and listing events for the window Pokoin has had seller
//! listings since (2026-09-05).
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped, as every `*_flow` test
//! is. It creates the `ph06_pokemon`, `ph06_magic` and `ph06_tcgcsv` databases and
//! drops nothing else.

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnection, PgPoolOptions};
use sqlx::{Connection, PgPool, Row};
use tower::ServiceExt;

/// The catalog table every request starts from.
const CATALOG_SCHEMA: &str = r#"
create table public.marketplace_search_candidates (
  card_id bigint primary key, ct_id bigint, name text not null default '',
  expansion_name text not null default '', card_number text not null default '');
"#;

/// The two price tables of the marketplace database and the events table of
/// PH-06, the last with the index of `scripts/sql/listing-pipeline.sql` so that
/// the plan measured here is the plan production gets. Autovacuum is switched off
/// on the events table only, so the scan counter below reports the readers and
/// nothing else. The Cardmarket guide tables are created in neither database, so
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
create table public.marketplace_user_listing_events (
  id bigserial primary key, listing_id uuid, card_id text not null,
  seller_uid text not null default '', event_type text not null,
  quantity_before integer, quantity_after integer,
  status_before text, status_after text, price_pkn numeric,
  occurred_at timestamptz not null default now());
create index marketplace_user_listing_events_card_day_idx
  on public.marketplace_user_listing_events (card_id, occurred_at desc);
alter table public.marketplace_user_listing_events set (autovacuum_enabled = false);
"#;

/// The events of the asserted printing, `239324`: one listing that starts before
/// the window and never comes back, a cheaper one that takes over, a sold-out
/// that leaves one listing standing, a reprice, a third listing that joins and is
/// cancelled, and the two rows that must never reach the line — a paused listing
/// and one with a zero price.
const EVENT_SEED: &str = r#"
insert into public.marketplace_user_listing_events
  (listing_id, card_id, event_type, quantity_after, status_after, price_pkn, occurred_at)
  values
  ('11111111-1111-1111-1111-111111111111', '239324', 'listed',   1, 'active',    300, '2026-08-28 05:00:00+00'),
  ('22222222-2222-2222-2222-222222222222', '239324', 'listed',   2, 'active',    260, '2026-09-03 10:00:00+00'),
  ('11111111-1111-1111-1111-111111111111', '239324', 'sold',     0, 'sold_out',  300, '2026-09-05 10:00:00+00'),
  ('22222222-2222-2222-2222-222222222222', '239324', 'updated',  2, 'active',    240, '2026-09-07 10:00:00+00'),
  ('33333333-3333-3333-3333-333333333333', '239324', 'listed',   1, 'active',    190, '2026-09-08 10:00:00+00'),
  ('44444444-4444-4444-4444-444444444444', '239324', 'updated',  1, 'paused',     90, '2026-09-09 09:00:00+00'),
  ('55555555-5555-5555-5555-555555555555', '239324', 'updated',  1, 'active',      0, '2026-09-09 11:00:00+00'),
  ('33333333-3333-3333-3333-333333333333', '239324', 'removed',  0, 'cancelled', 190, '2026-09-09 14:00:00+00');
"#;

/// The pair PH-R026 found undetermined: two writes of one listing inside one
/// transaction, so the audit trigger stamps both with the transaction's `now()`
/// and they share `occurred_at` exactly. The ids say which one is the listing's
/// last event, and that is the only thing that can.
///
/// `aaaaaaaa` is listed and sold at the very same instant *inside* a window that
/// opens on 4 Oct, and `bbbbbbbb` did it the day *before* such a window: the
/// sold-out has to win both times, or the line draws an ask that left the market
/// in the same transaction it entered. Printing `239998` is the price tie, in
/// both directions: `cccc` reprices 220 down to 200 inside the window and `dddd`
/// repriced 180 up to 300 the day before it, so the cheapest ask is 200 of two
/// listings — and every one of the four rows read in the wrong order moves that
/// number.
///
/// Written ids, and the guard below reads them back, so that the seed cannot
/// quietly stop being the case the assertions are about. Neither printing has a
/// blueprint: the two lines are the only thing these cards are asked for.
const TIE_SEED: &str = r#"
insert into public.marketplace_search_candidates (card_id, ct_id, name, expansion_name, card_number)
  values (239999, null, 'Charizard', 'Base Set', '12'),
         (239998, null, 'Charizard', 'Base Set', '12');
insert into public.marketplace_user_listing_events
  (id, listing_id, card_id, event_type, quantity_after, status_after, price_pkn, occurred_at)
  values
  (900001, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '239999', 'listed',  1, 'active',   200, '2026-10-04 12:00:00+00'),
  (900002, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '239999', 'sold',    0, 'sold_out', 200, '2026-10-04 12:00:00+00'),
  (900003, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '239999', 'listed',  1, 'active',   200, '2026-10-03 12:00:00+00'),
  (900004, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '239999', 'sold',    0, 'sold_out', 200, '2026-10-03 12:00:00+00'),
  (900005, 'cccccccc-cccc-cccc-cccc-cccccccccccc', '239998', 'listed',  1, 'active',   220, '2026-10-04 12:00:00+00'),
  (900006, 'cccccccc-cccc-cccc-cccc-cccccccccccc', '239998', 'updated', 1, 'active',   200, '2026-10-04 12:00:00+00'),
  (900007, 'dddddddd-dddd-dddd-dddd-dddddddddddd', '239998', 'listed',  1, 'active',   180, '2026-10-03 12:00:00+00'),
  (900008, 'dddddddd-dddd-dddd-dddd-dddddddddddd', '239998', 'updated', 1, 'active',   300, '2026-10-03 12:00:00+00');
"#;

/// Two CardTrader ask days of the asserted printing, so that its `cardtrader`
/// block is a real one and the graph answer is seen to leave ask days out while
/// the pokoin line keeps every day.
const ASK_SEED: &str = r#"
insert into public.cardtrader_blueprint_daily_analytics
  (blueprint_id, observed_day, refreshed_at, min_price_pkn, listing_count, listed_quantity, seller_count)
  values (415200, '2026-09-02', '2026-09-02 06:00:00+00', 250, 2, 3, 1),
         (415200, '2026-09-08', '2026-09-08 06:00:00+00', 240, 1, 1, 1);
"#;

/// A printing with the density of a real one: 1 013 days of CardTrader asks and
/// 73 days of Pokoin listing events, four TCGplayer prices deep. Twelve listings
/// hold 249386 from 5 Sep 2026, the four cheapest of them sell on 13 Oct, and the
/// line steps from 260 PKN to 265 PKN that day.
const BUSY_SEED: &str = r#"
insert into public.cardtrader_blueprint_daily_analytics
  (blueprint_id, observed_day, refreshed_at, min_price_pkn, listing_count, listed_quantity, seller_count)
select 415201, day, day + interval '6 hours', 240 + (extract(day from day)::int % 9) * 4,
       3, 4, 2
  from generate_series(date '2024-02-08', date '2026-11-16', interval '1 day') day;
insert into public.marketplace_user_listing_events
  (listing_id, card_id, event_type, quantity_after, status_after, price_pkn, occurred_at)
select ('66660000-0000-4000-8000-0000000000' || lpad(s::text, 2, '0'))::uuid, '249386',
       case when day = date '2026-09-05' then 'listed' else 'updated' end,
       1, 'active', 260 + (s * 7 % 11) * 5, day + interval '8 hours'
  from generate_series(1, 12) s, generate_series(date '2026-09-05', date '2026-10-12', interval '1 day') day;
insert into public.marketplace_user_listing_events
  (listing_id, card_id, event_type, quantity_after, status_after, price_pkn, occurred_at)
select ('66660000-0000-4000-8000-0000000000' || lpad(s::text, 2, '0'))::uuid, '249386',
       'sold', 0, 'sold_out', 260 + (s * 7 % 11) * 5, timestamp with time zone '2026-10-13 08:00:00+00'
  from generate_series(9, 12) s;
"#;

/// Rates for every day of the span, which is what the real table holds.
const FX_SEED: &str = r#"
insert into public.fx_rates_daily (day, base, quote, rate)
select day, 'EUR', 'USD', 1.05 + (extract(doy from day)::int % 20) / 100.0
  from generate_series(date '2024-02-08', date '2026-11-16', interval '1 day') day;
"#;

/// The TCGCSV history database, shared by every game: four TCGplayer series of
/// the busy printing and one of the magic one, every day of the span. The columns
/// are those of `all_daily_prices` that `tcgplayer_source` plots.
const TCGCSV_SCHEMA: &str = r#"
create table public.pokoin_product_links (
  product_id bigint not null, game text not null, card_id bigint not null,
  active boolean not null default true);
create table public.latest_prices (product_id bigint not null, category_id integer not null);
create table public.all_daily_prices (
  product_id bigint not null, category_id integer not null, group_id text,
  observed_on date not null, subtype text not null default 'normal',
  market_price numeric, low_price numeric, mid_price numeric, high_price numeric,
  direct_low_price numeric, snapshot_timestamp timestamptz);
insert into public.pokoin_product_links (product_id, game, card_id, active)
  values (589965, 'pokemon', 249386, true), (589966, 'pokemon', 249386, true),
         (900001, 'magic', 4152, true);
insert into public.latest_prices (product_id, category_id) values (589965, 1), (589966, 1), (900001, 3);
insert into public.all_daily_prices
  (product_id, category_id, group_id, observed_on, subtype, market_price, low_price, mid_price,
   high_price, direct_low_price, snapshot_timestamp)
select p.product_id, p.category_id, 'grp-' || p.product_id, day, p.subtype,
       p.price + (extract(day from day)::int % 7) / 10.0, p.price, p.price + 0.10, p.price + 0.40,
       p.price - 0.05, day + interval '30 minutes'
  from generate_series(date '2024-02-08', date '2026-11-16', interval '1 day') day,
       (values (589965::bigint, 1, 'Holofoil', 0.85), (589965, 1, 'Reverse Holofoil', 1.15),
               (589965, 1, 'Normal', 0.20), (589966, 1, 'Holofoil', 0.95),
               (900001, 3, 'normal', 2.50)) as p(product_id, category_id, subtype, price);
"#;

const TO: &str = "2026-11-16";
/// The three-month span the desk opens with, and the `All` button's span — the
/// two answers PH-06 was asked to lighten.
const MONTHS: &str = "from=2026-08-18&to=2026-11-16";
const ALL: &str = "from=2024-02-08&to=2026-11-16";

/// The table PH-06 reads, which the magic database of this test has not.
const EVENTS_TABLE: &str = "public.marketplace_user_listing_events";
/// The very statement PH-06 guards, issued by the control.
const STRAY_EVENTS_SQL: &str =
    "select price_pkn from public.marketplace_user_listing_events limit 1";
/// A table the Pokémon database of this test has not too, its second control.
const STRAY_GUIDE_SQL: &str = "select 1 from public.cardmarket_price_guide_runs limit 1";

/// How long a counter read waits for the number it is looking for.
const STAT_WAIT: Duration = Duration::from_secs(5);
const STAT_POLL: Duration = Duration::from_millis(100);
/// The bound `PGSTAT_IDLE_INTERVAL` gives a backend that is never closed.
const IDLE_SETTLE: Duration = Duration::from_secs(12);
/// A "did not grow" claim is worth only the window it was watched for.
const IDLE_WATCH: Duration = Duration::from_millis(1_500);

/// The top-level keys of the answer, with and without `fields=graph`.
const FULL_KEYS: &str =
    "game,cardId,ctId,from,to,printing,cardtrader,tcgplayer,cardmarket,pokoin,fx";
const GRAPH_KEYS: &str =
    "game,cardId,ctId,from,to,bucket,printing,cardtrader,tcgplayer,cardmarket,pokoin,fx";

/// The number a counter read is looking for.
#[derive(Clone, Copy, Debug)]
enum Want {
    /// Nothing in particular: the first number that is not an old snapshot.
    Now,
    /// At least one above `base` — the control, which fails when the counter
    /// cannot move and so turns every later pass into a real one.
    Grown(i64),
    /// `base` still, for the whole of `IDLE_WATCH`, which is the only way to
    /// prove that nothing was counted.
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

/// One statement on a session of its own, which is then hung up: a backend
/// reports what it counted when it exits, so the control's own failing query is
/// in the counter straight away instead of behind `PGSTAT_IDLE_INTERVAL`.
async fn stray_query(url: &str, sql: &str) -> sqlx::Result<()> {
    let mut conn = PgConnection::connect(url).await?;
    let outcome = sqlx::query(sql).fetch_one(&mut conn).await.map(|_| ());
    drop(conn);
    outcome
}

/// Transactions Postgres aborted in one database, read until `want` is met or its
/// window is over; the last number read comes back, so the caller's assertion
/// reports what the server really counted.
///
/// The clear and the read run on one session, held for the whole poll:
/// `pg_stat_clear_snapshot()` only affects the session that calls it, and without
/// it Postgres answers every read from the snapshot that session took first.
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

/// Heap and index scans of the events table, read on a session of its own. A
/// fresh connection takes a fresh snapshot, so it cannot repeat an old number the
/// way a long-lived reading session would.
async fn event_scans(pokemon_url: &str) -> i64 {
    let mut conn = PgConnection::connect(pokemon_url)
        .await
        .expect("stats session");
    sqlx::query("select pg_stat_clear_snapshot()")
        .execute(&mut conn)
        .await
        .expect("pg_stat_clear_snapshot");
    let row = sqlx::query(
        "select coalesce(seq_scan, 0) + coalesce(idx_scan, 0) as scans \
           from pg_stat_user_tables \
          where schemaname = 'public' and relname = 'marketplace_user_listing_events'",
    )
    .fetch_one(&mut conn)
    .await
    .expect("pg_stat_user_tables row");
    let scans = row.try_get::<i64, _>("scans").expect("scan counter");
    drop(conn);
    scans
}

/// `GET` one URI and return its status, its JSON body and its size in bytes.
async fn get(app: &axum::Router, uri: &str) -> (StatusCode, Value, usize) {
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
    let bytes = axum::body::to_bytes(res.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        bytes.len(),
    )
}

/// `day lowestAskPkn listingCount` of every `pokoin` day, so that one assertion
/// reads like the answer it checks. A graph day prints without its count.
fn line(body: &Value) -> Vec<String> {
    points(body, "pokoin", "lowestAskPkn", true)
}

/// The `day`/value pairs of one block, optionally with the count the full answer
/// carries next to it.
fn points(body: &Value, block: &str, field: &str, with_count: bool) -> Vec<String> {
    body[block]["days"]
        .as_array()
        .map(|days| {
            days.iter()
                .map(|day| match day.get("listingCount").filter(|_| with_count) {
                    Some(count) => format!(
                        "{} {} {}",
                        day["day"].as_str().unwrap_or("?"),
                        day[field],
                        count
                    ),
                    None => format!("{} {}", day["day"].as_str().unwrap_or("?"), day[field]),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The days of one block, for the weekly assertions.
fn days_of(body: &Value, block: &str) -> Vec<(String, Value)> {
    body[block]["days"]
        .as_array()
        .map(|days| {
            days.iter()
                .map(|day| {
                    (
                        day["day"].as_str().unwrap_or("?").to_owned(),
                        day["lowestAskPkn"].clone(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn keys(value: &Value) -> String {
    value
        .as_object()
        .map(|object| {
            object
                .keys()
                .map(|key| key.as_str())
                .collect::<Vec<&str>>()
                .join(",")
        })
        .unwrap_or_default()
}

/// Days between two `YYYY-MM-DD` strings.
fn day_span(from: &str, to: &str) -> i64 {
    let parse = |day: &str| chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok();
    match (parse(from), parse(to)) {
        (Some(from), Some(to)) => to.signed_duration_since(from).num_days(),
        _ => i64::MIN,
    }
}

#[tokio::test]
async fn price_history_folds_pokoin_listings_and_never_queries_an_absent_table() {
    let Ok(base) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("POKOIN_TEST_DATABASE_URL unset; skipping");
        return;
    };
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&base)
        .await
        .unwrap();
    let (pokemon_url, pokemon) = fresh_db(&admin, &base, "ph06_pokemon").await;
    let (magic_url, magic) = fresh_db(&admin, &base, "ph06_magic").await;
    let (tcgcsv_url, tcgcsv) = fresh_db(&admin, &base, "ph06_tcgcsv").await;

    exec_all(&pokemon, CATALOG_SCHEMA).await;
    exec_all(&magic, CATALOG_SCHEMA).await;
    exec_all(&pokemon, PRICE_TABLES).await;
    exec_all(&pokemon, ASK_SEED).await;
    exec_all(&pokemon, EVENT_SEED).await;
    exec_all(&pokemon, TIE_SEED).await;
    exec_all(&pokemon, BUSY_SEED).await;
    exec_all(&pokemon, FX_SEED).await;
    exec_all(&tcgcsv, TCGCSV_SCHEMA).await;
    for (pool, card_id, ct_id, name, set_name) in [
        (&pokemon, 239324_i64, 415200_i64, "Charizard", "Base Set"),
        (
            &pokemon,
            249386_i64,
            415201_i64,
            "Gengar ex",
            "Destined Rivals",
        ),
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
        .bind("12")
        .execute(pool)
        .await
        .unwrap();
    }

    // The satellite game reads its own database, which has no events table; the
    // rates and the seller events come from the Pokémon pool `ApiState` was built
    // with, which is the one the listings handlers use.
    std::env::set_var("MAGIC_MARKETPLACE_DATABASE_URL", &magic_url);
    std::env::set_var("TCGCSV_DATABASE_URL", &tcgcsv_url);
    std::env::set_var("TCGCSV_DATABASE_SSL", "0");

    let state = pokoin_api_common::RouteState::new(
        pokoin_api_common::ApiState::new(pokemon.clone(), pokemon.clone(), None, 1),
        pokoin_accounts::DomainState::default(),
    );
    let app = pokoin_catalog_api::router(state);

    // What the server would have written down. The assertions below do not depend
    // on it: `xact_rollback` counts an aborted statement either way.
    let logged =
        sqlx::query("select setting from pg_settings where name = 'log_min_error_statement'")
            .fetch_optional(&admin)
            .await
            .ok()
            .flatten()
            .and_then(|row| row.try_get::<String, _>("setting").ok())
            .unwrap_or_else(|| "unreadable".to_owned());
    println!("log_min_error_statement = {logged}");

    // 1. The control, before a single request: a query for the events table of the
    //    database that has it not, and one for a table the Pokémon database has
    //    not, must each be seen to abort, so that every "did not abort" below is
    //    worth something. The number it moved to is the baseline.
    let mut baseline: Vec<(&str, i64)> = Vec::new();
    for (database, url, sql, table) in [
        ("ph06_magic", &magic_url, STRAY_EVENTS_SQL, EVENTS_TABLE),
        (
            "ph06_pokemon",
            &pokemon_url,
            STRAY_GUIDE_SQL,
            "public.cardmarket_price_guide_runs",
        ),
    ] {
        let before = rollbacks(&admin, database, Want::Now).await;
        let stray = stray_query(url, sql).await;
        assert!(stray.is_err(), "{database} must not have {table}");
        let after = rollbacks(&admin, database, Want::Grown(before)).await;
        assert!(
            after > before,
            "xact_rollback of {database} stayed {after} after a query for the absent {table}, \
             so it proves nothing"
        );
        println!("one stray query for {table} moved {database} xact_rollback {before} -> {after}");
        baseline.push((database, after));
    }

    // 2. The asserted line: the events of card 239324 folded day by day. The 28
    //    Aug listing is what prices 1 Sep, because the window opens on a state,
    //    not on an event.
    let (status, body, _) = get(
        &app,
        "/api/marketplace-card-price-history?cardId=239324&from=2026-09-01&to=2026-09-10",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    println!("239324 pokoin block: {}", body["pokoin"]);
    assert_eq!(
        line(&body),
        [
            "2026-09-01 300 1",
            "2026-09-02 300 1",
            "2026-09-03 260 2",
            "2026-09-04 260 2",
            "2026-09-05 260 1",
            "2026-09-06 260 1",
            "2026-09-07 240 1",
            "2026-09-08 190 2",
            "2026-09-09 240 1",
            "2026-09-10 240 1",
        ]
        .map(str::to_owned)
        .to_vec(),
        "the cheapest live ask of each day: a sold-out leaves one listing, a reprice moves it, \
         a third listing takes over at 190 and leaves again when it is cancelled, and a paused \
         listing and a zero price never join"
    );
    assert_eq!(body["pokoin"]["source"], "pokoin_listings");
    assert_eq!(body["pokoin"]["currency"], "PKN");
    assert_eq!(body["pokoin"]["metric"], "lowestAsk");
    assert_eq!(body["pokoin"]["status"], "available");
    assert_eq!(keys(&body), FULL_KEYS);
    assert_eq!(body["cardId"], "239324");
    assert_eq!(body["ctId"], json!("415200"));

    //    The other blocks are the ones of today, field for field.
    assert_eq!(body["cardtrader"]["status"], "available");
    assert_eq!(
        keys(&body["cardtrader"]["days"][0]),
        "day,dumpDay,lowestAskPkn,listingCount,listedQuantity,sellerCount,sourceTimestamp"
    );
    assert_eq!(
        days_of(&body, "cardtrader").len(),
        2,
        "two ask days, ten days of listing events: the pokoin line is the one that has a value \
         every day"
    );
    assert_eq!(
        body["tcgplayer"]["status"], "empty",
        "239324 has no product"
    );
    assert_eq!(body["cardmarket"]["status"], "empty");
    assert_eq!(
        body["fx"]["lastDay"], "2026-09-10",
        "the rates run to the end of the asked window"
    );

    // 3. The same ten days as a graph answer: `reverse=1` picks a reverse series,
    //    nothing is plotted twice and no field the graph does not draw survives.
    let (status, graph, _) = get(
        &app,
        "/api/marketplace-card-price-history?cardId=239324&from=2026-09-01&to=2026-09-10&fields=graph&reverse=1",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        graph["bucket"],
        json!("day"),
        "10 days are plotted day by day"
    );
    assert_eq!(graph["pokoin"]["status"], "available");
    assert_eq!(
        keys(&graph["pokoin"]["days"][0]),
        "day,lowestAskPkn",
        "the graph day of the pokoin line"
    );
    assert_eq!(
        line(&graph)[0],
        "2026-09-01 300",
        "listingCount is not plotted"
    );
    assert_eq!(
        line(&graph).len(),
        10,
        "the same ten days as the full answer"
    );
    assert_eq!(keys(&graph), GRAPH_KEYS);
    assert_eq!(
        keys(&graph["cardtrader"]["days"][0]),
        "day,lowestAskPkn",
        "the graph day of the ask line"
    );
    assert_eq!(graph["printing"], body["printing"]);

    // 4. One statement, not one per day: the events table is scanned twice for a
    //    whole request over 77 days — the state before the window and the events
    //    in it — whatever the span. The counters are handed in by the backend that
    //    ran the statement at an idle point `PGSTAT_MIN_INTERVAL` after its last
    //    hand-over, and otherwise only on its `PGSTAT_IDLE_INTERVAL` timer, so a
    //    request in a run of requests shows up to ten seconds later: IDLE_SETTLE
    //    is the bound, and a counter that never reaches two fails here. The settle
    //    first is what makes `before` a number the requests before it have already
    //    contributed to: their scans are still in their backend when they finish.
    tokio::time::sleep(IDLE_SETTLE).await;
    let before = event_scans(&pokemon_url).await;
    let (status, _, _) = get(
        &app,
        "/api/marketplace-card-price-history?cardId=239324&from=2026-09-01&to=2026-11-16",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut scans = event_scans(&pokemon_url).await;
    let started = Instant::now();
    while scans < before + 2 && started.elapsed() < IDLE_SETTLE {
        tokio::time::sleep(STAT_POLL).await;
        scans = event_scans(&pokemon_url).await;
    }
    assert_eq!(
        scans - before,
        2,
        "one request over 77 days scanned the events table {} times instead of twice",
        scans - before
    );
    tokio::time::sleep(IDLE_WATCH).await;
    assert_eq!(
        event_scans(&pokemon_url).await,
        scans,
        "the events table was scanned again after the request: one query per day is back"
    );

    // 5. The sizes PH-06 is about, on a printing whose sources are full.
    for (label, span, bucket, ask_days, pokoin_days, weekly_ask) in [
        ("3 months", MONTHS, "day", 91, 73, 91),
        ("all time", ALL, "week", 1013, 73, 146),
    ] {
        let (full_status, full, full_bytes) = get(
            &app,
            &format!("/api/marketplace-card-price-history?cardId=249386&{span}"),
        )
        .await;
        let (graph_status, small, graph_bytes) = get(
            &app,
            &format!("/api/marketplace-card-price-history?cardId=249386&{span}&fields=graph"),
        )
        .await;
        assert_eq!(full_status, StatusCode::OK);
        assert_eq!(graph_status, StatusCode::OK);
        println!(
            "{label} (card 249386, {span}): full {full_bytes} B, fields=graph {graph_bytes} B \
             = {:.1}% of it, bucket {}",
            100.0 * graph_bytes as f64 / full_bytes as f64,
            small["bucket"]
        );
        assert_eq!(
            keys(&full),
            FULL_KEYS,
            "the full answer is the one of today"
        );
        assert_eq!(keys(&small), GRAPH_KEYS);
        assert_eq!(small["bucket"], json!(bucket));
        assert_eq!(full["pokoin"]["status"], "available");
        assert_eq!(
            points(&full, "pokoin", "lowestAskPkn", true).len(),
            pokoin_days
        );
        assert_eq!(days_of(&full, "cardtrader").len(), ask_days);
        assert_eq!(days_of(&small, "cardtrader").len(), weekly_ask);
        let series = small["tcgplayer"]["series"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(series.len(), 1, "the graph answer plots one series of four");
        assert_eq!(
            keys(&series[0]),
            "productId,categoryId,groupId,subtype,days",
            "one TCGplayer series keeps its identity"
        );
        assert_eq!(
            series[0]["subtype"],
            json!("Holofoil"),
            "non-reverse, most days, first of those"
        );
        assert_eq!(
            keys(&small["cardtrader"]["days"][0]),
            "day,lowestAskPkn",
            "and one ask day keeps its two numbers"
        );
        assert_eq!(
            small["cardmarket"]["status"], "empty",
            "no guide table here"
        );
        assert_eq!(small["fx"], full["fx"], "the rates block is not trimmed");
        assert_eq!(small["printing"], full["printing"]);

        let full_ask = days_of(&full, "cardtrader");
        let thin_ask = days_of(&small, "cardtrader");
        if bucket == "day" {
            assert_eq!(
                points(&small, "pokoin", "lowestAskPkn", false),
                points(&full, "pokoin", "lowestAskPkn", false),
                "a short span thins nothing"
            );
            assert_eq!(thin_ask[0].0, "2026-08-18");
            assert_eq!(thin_ask.last().unwrap().0, TO);
        } else {
            // One point per ISO week, the last day of the week that has a value.
            assert_eq!(thin_ask[0].0, "2024-02-11", "the Sunday of 2024-W6");
            assert_eq!(thin_ask[1].0, "2024-02-18");
            assert_eq!(thin_ask.last().unwrap().0, TO, "2026-W47 has only Monday");
            for (index, pair) in thin_ask.windows(2).enumerate() {
                let gap = day_span(&pair[0].0, &pair[1].0);
                let last = index + 2 == thin_ask.len();
                assert!(
                    gap == 7 || (last && gap > 0 && gap < 7),
                    "weekly ask days {gap} apart: {pair:?}"
                );
            }
            for (day, value) in &thin_ask {
                let same = full_ask.iter().find(|(full_day, _)| full_day == day);
                assert_eq!(
                    same.map(|(_, full_value)| full_value),
                    Some(value),
                    "{day} changed when it was thinned"
                );
            }
            assert_eq!(
                points(&small, "pokoin", "lowestAskPkn", false),
                [
                    ("2026-09-06", 260),
                    ("2026-09-13", 260),
                    ("2026-09-20", 260),
                    ("2026-09-27", 260),
                    ("2026-10-04", 260),
                    ("2026-10-11", 260),
                    ("2026-10-18", 265),
                    ("2026-10-25", 265),
                    ("2026-11-01", 265),
                    ("2026-11-08", 265),
                    ("2026-11-15", 265),
                    ("2026-11-16", 265),
                ]
                .map(|(day, pkn)| format!("{day} {pkn}"))
                .to_vec(),
                "the pokoin line weekly: 260 while twelve listings are live, 265 from the day \
                 the four cheapest were sold, and today in its own short week"
            );
            assert_eq!(keys(&series[0]["days"][0]), "day,marketPkn");

            // `reverse=1` on the same span moves the plotted series and nothing else.
            let (_, reversed, reversed_bytes) = get(
                &app,
                &format!("/api/marketplace-card-price-history?cardId=249386&{span}&fields=graph&reverse=1"),
            )
            .await;
            println!("{label} with reverse=1: {reversed_bytes} B");
            assert_eq!(
                reversed["tcgplayer"]["series"][0]["subtype"],
                json!("Reverse Holofoil")
            );
            assert_eq!(
                points(&reversed, "pokoin", "lowestAskPkn", false),
                points(&small, "pokoin", "lowestAskPkn", false),
                "reverse is a TCGplayer choice, not a different pokoin line"
            );
        }
    }

    // 6. PH-02 for the new leg: a game whose database has no events table answers
    //    `empty`, with the same block and no days, and its other legs still work.
    let (magic_status, magic_body, _) = get(
        &app,
        &format!(
            "/api/marketplace-card-price-history?cardId=4152&game=magic&{MONTHS}&fields=graph"
        ),
    )
    .await;
    assert_eq!(magic_status, StatusCode::OK);
    println!("magic graph answer: {}", magic_body["pokoin"]);
    assert_eq!(magic_body["game"], "magic");
    assert_eq!(magic_body["pokoin"]["status"], "empty");
    assert_eq!(magic_body["pokoin"]["source"], "pokoin_listings");
    assert_eq!(magic_body["pokoin"]["currency"], "PKN");
    assert_eq!(magic_body["pokoin"]["metric"], "lowestAsk");
    assert!(magic_body["pokoin"]["days"]
        .as_array()
        .expect("days")
        .is_empty());
    assert_eq!(magic_body["cardtrader"]["status"], "empty");
    assert_eq!(magic_body["cardmarket"]["status"], "unsupported_game");
    assert_eq!(magic_body["tcgplayer"]["status"], "available");
    assert_eq!(
        keys(&magic_body["tcgplayer"]["series"][0]["days"][0]),
        "day,marketPkn",
        "the graph answer is the same shape whatever the game"
    );
    assert_eq!(
        magic_body["fx"]["lastDay"], TO,
        "the rates still come from the marketplace database"
    );

    // 7. PH-R026: the audit trigger stamps `occurred_at = now()`, the transaction
    //    timestamp, so the two writes of one listing inside one transaction are
    //    indistinguishable by instant and only the event id says which of them the
    //    listing ends on. First prove the seed really is that pair — one instant
    //    per listing, the rows in id order — because an assertion about a tie is
    //    worth nothing if the tie quietly stopped existing.
    let tied = {
        let rows = sqlx::query(
            "select right(listing_id::text, 8) || ': ' || count(*)::text || ' rows at ' \
                    || count(distinct occurred_at)::text || ' instant, ' \
                    || string_agg(status_after || ' qty' || quantity_after::text || ' ' \
                                  || price_pkn::text || ' id' || id::text, ' then ' order by id) \
                   as tied \
              from public.marketplace_user_listing_events \
             where card_id in ('239998', '239999') \
             group by listing_id \
             order by listing_id",
        )
        .fetch_all(&pokemon)
        .await
        .expect("tie seed rows");
        rows.iter()
            .map(|row| row.try_get::<String, _>("tied").expect("tied"))
            .collect::<Vec<String>>()
    };
    println!("the seeded same-instant pairs: {tied:?}");
    assert_eq!(
        tied,
        [
            "aaaaaaaa: 2 rows at 1 instant, active qty1 200 id900001 then sold_out qty0 200 id900002",
            "bbbbbbbb: 2 rows at 1 instant, active qty1 200 id900003 then sold_out qty0 200 id900004",
            "cccccccc: 2 rows at 1 instant, active qty1 220 id900005 then active qty1 200 id900006",
            "dddddddd: 2 rows at 1 instant, active qty1 180 id900007 then active qty1 300 id900008",
        ]
        .map(str::to_owned)
        .to_vec(),
        "each listing was written twice at one instant and the higher id is the later write"
    );

    //    A printing whose only listings sold out in the instant they were written:
    //    the `in_range` half must end `aaaaaaaa` with the sale, and the
    //    `before_start` half must carry `bbbbbbbb` into the window already sold, or
    //    either of them prices both days at 200.
    let (status, sold, _) = get(
        &app,
        "/api/marketplace-card-price-history?cardId=239999&from=2026-10-04&to=2026-10-05",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    println!(
        "239999 pokoin block, sold out at the instant it was listed: {}",
        sold["pokoin"]
    );
    let sold_days = line(&sold);
    assert!(
        sold_days.is_empty(),
        "a listing that ended inside one transaction of the same instant is not an ask: {sold_days:?}"
    );
    assert_eq!(sold["pokoin"]["status"], "empty");

    //    The same instant with a price instead of a sale: `cccc` went 220 → 200 in
    //    the window and `dddd` went 180 → 300 before it, so the ask of the day is
    //    200 of two listings. Either pair read backwards moves that number — 220
    //    with `cccc` backwards, 180 with `dddd` — so neither order can slip.
    let (status, repriced, _) = get(
        &app,
        "/api/marketplace-card-price-history?cardId=239998&from=2026-10-04&to=2026-10-05",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    println!(
        "239998 pokoin line of the tied reprices: {:?}",
        line(&repriced)
    );
    assert_eq!(
        line(&repriced),
        ["2026-10-04 200 2", "2026-10-05 200 2",]
            .map(str::to_owned)
            .to_vec(),
        "the higher id is the state each listing has from that instant, in the window and \
         in the state the window opens with"
    );

    //    And the printing the rest of this test asserts, asked over the same two
    //    days: the tie seed touches no listing of it, so the line is what its
    //    September events left standing.
    let (status, tied_span, _) = get(
        &app,
        "/api/marketplace-card-price-history?cardId=239324&from=2026-10-04&to=2026-10-05",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        line(&tied_span),
        ["2026-10-04 240 1", "2026-10-05 240 1",]
            .map(str::to_owned)
            .to_vec(),
        "the September line carries into October untouched: 240 PKN of the one listing that \
         is still live"
    );

    // 8. Neither database aborted a statement across the requests. The pools this
    //    test owns are closed first, which reports what they counted; what is left
    //    is the magic satellite pool, which waits out IDLE_SETTLE.
    pokemon.close().await;
    magic.close().await;
    tcgcsv.close().await;
    tokio::time::sleep(IDLE_SETTLE).await;
    for (database, base) in baseline {
        let after = rollbacks(&admin, database, Want::Unchanged(base)).await;
        assert_eq!(
            after, base,
            "{database} aborted a statement across the requests: PH-02 is back"
        );
    }

    admin.close().await;
}
