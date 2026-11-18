//! PH-C025 W5 on a real Postgres: the `cardmarketOffers` leg of
//! `GET /api/marketplace-card-price-history` reads one Cardmarket product's
//! per-condition day out of `cardmarket_offer_daily` (migration 145, applied here
//! from its own file) with a single bind-only statement, and a database without
//! that table answers the leg `empty` without querying for it (PH-02).
//!
//! ```text
//! docker run -d --rm --name pokoin-ph-r041-offers-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55497:5432 --tmpfs /var/lib/postgresql/data \
//!   postgres:17-alpine -c log_min_error_statement=error
//! TMPDIR=$HOME/scratch/tmp \
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55497/postgres \
//!   cargo test -p pokoin-catalog-api --locked --test price_history_cm_offers_flow -- --nocapture
//! docker rm -f pokoin-ph-r041-offers-pg
//! ```
//!
//! What only a server can answer is the facet, and it is answered here rather
//! than in a unit test because it is the `where` clause that decides it: a day
//! that has rows naming the asked finish must not be taken from the `'*'`
//! aggregate even when the aggregate is cheaper, a day that has none must be
//! taken from it, and a day whose only row is of another first edition is not a
//! day at all. The same for `reverse=1`, which reads a different offer of the
//! same product. The absent-table half is measured the way
//! `price_history_pokoin_flow.rs` measures it: a control query for the very table
//! the guard is about is issued first on purpose, so a counter that cannot move
//! fails here rather than passing later, and `xact_rollback` then must not move
//! again across the requests whatever the logging says.
//!
//! The sizes printed at the end are the graph answer of one printing with the new
//! leg and with its block taken back out, which is what the leg costs the desk.
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped, as every `*_flow` test
//! is. It creates the `cmo_pokemon`, `cmo_bare` and `cmo_magic` databases and
//! drops nothing else. The tables it does not create are the point of the
//! absence assertions: no `fx_rates_daily`, no CardTrader analytics, no guide
//! tables and no listing events, so the other legs are guarded here too and the
//! byte delta below is the new block alone.

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnection, PgPoolOptions};
use sqlx::{Connection, PgPool, Row};
use tower::ServiceExt;

/// The migration the leg reads, from the repository's own file: what is applied
/// here is the text the writer will be given, not a copy of it.
const MIGRATION: &str = include_str!("../../../../scripts/sql/145_cardmarket_offer_daily.sql");

/// The catalog table every request starts from, and the blueprint whose
/// `card_market_ids` turn a card into the Cardmarket products the leg reads.
const CATALOG_SCHEMA: &str = r#"
create table public.marketplace_search_candidates (
  card_id bigint primary key, ct_id bigint, name text not null default '',
  expansion_name text not null default '', card_number text not null default '');
create table public.cardtrader_pokemon_blueprints (
  id bigint primary key, card_market_ids jsonb);
"#;

/// The cards of the asserted answers, in every Pokémon database of this test:
/// `239324` is the printing whose day is asserted facet by facet, `249386` the
/// one whose 1 013 days are the sizes, `239997` a printing with no blueprint at
/// all, and `4152` a Magic card asked with `game=magic` so that the leg's own
/// stub is seen from the router.
const CARDS: &str = r#"
insert into public.marketplace_search_candidates (card_id, ct_id, name, expansion_name, card_number)
  values (239324, 415200, 'Charizard', 'Base Set', '4/102'),
         (249386, 415201, 'Gengar ex', 'Destined Rivals', '122/194'),
         (239997, null, 'Pikachu', 'Base Set', '6/102'),
         (4152, 2076, 'Lightning Bolt', 'Masters 25', '146');
insert into public.cardtrader_pokemon_blueprints (id, card_market_ids)
  values (415200, '[279646, 279259]'::jsonb),
         (415201, '[279900]'::jsonb),
         (2076, '[79090]'::jsonb);
"#;

/// Ten days of one product, two languages, three condition floors, both seller
/// types and the reverse and non-reverse finish — the fixture the assertions
/// below read by hand. Every case the facet rules of `history_sources` have are
/// here, and each row says which of them it is.
const OFFER_SEED: &str = r#"
insert into public.cardmarket_offer_daily
  (cm_product_id, day, language, condition, seller_type, finish, first_edition,
   min_cents, offer_count, counts_complete, asked, observed_at)
  values
  -- 9 Nov, English, non-reverse: the day was aimed at and both seller types
  -- answered it. The private 9.20 EUR is the day, and its own `asked` flag is
  -- what the day reports.
  (279646, '2026-11-09', 'EN', 'NM', 'pro',     'N', 'N', 1500, 3,  true,  true, '2026-11-09 09:00:00+00'),
  (279646, '2026-11-09', 'EN', 'NM', 'private', 'N', 'N',  920, 1,  true,  true, '2026-11-09 09:00:00+00'),
  -- The same floor also rode along on a page fetched with no facet filter. It is
  -- the cheapest row of the day by far, and it is not the day: 9 Nov names the
  -- asked finish, so the aggregate is not read.
  (279646, '2026-11-09', 'EN', 'NM', 'private', '*', '*',  500, 9,  true, false, '2026-11-09 07:00:00+00'),
  -- SP has no row naming the asked finish that day, so its aggregate is the day.
  (279646, '2026-11-09', 'EN', 'SP', 'pro',     '*', '*', 1000, 2,  true,  true, '2026-11-09 07:00:00+00'),
  -- MP was seen but not complete, and nobody aimed at it: the day still prices it
  -- and says `asked: false`.
  (279646, '2026-11-09', 'EN', 'MP', 'private', 'N', 'N',  700, 1, false, false, '2026-11-09 09:00:00+00'),
  -- Cardmarket's own aggregate over the floors is not a floor: no series named
  -- `*`, and this price of 1.00 EUR never becomes the day of another floor.
  (279646, '2026-11-09', 'EN', '*',  'private', 'N', 'N',  100, 12, true,  true, '2026-11-09 09:00:00+00'),
  -- 16 Nov: the non-reverse English NM is the private offer; the reverse one is a
  -- cheaper offer of a different page that only `reverse=1` reads.
  (279646, '2026-11-16', 'EN', 'NM', 'private', 'N', 'N', 1100, 4,  true,  true, '2026-11-16 09:00:00+00'),
  (279646, '2026-11-16', 'EN', 'NM', 'pro',     'Y', 'N', 1000, 2,  true, false, '2026-11-16 09:00:00+00'),
  -- The only English SP of 16 Nov is a first edition, and the desk never asks
  -- for one: 16 Nov is not an SP day, so the SP series has one day.
  (279646, '2026-11-16', 'EN', 'SP', 'private', 'N', 'Y',  800, 1,  true,  true, '2026-11-16 09:00:00+00'),
  -- Another language of the same product and days. `cmLanguage=JP` reads these
  -- and not one of the English rows above; `cmLanguage=JP&reverse=1` reads only
  -- the 16 Nov one, so 9 Nov is not a day of that answer either.
  (279646, '2026-11-09', 'JP', 'NM', 'private', 'N', 'N', 4000, 1,  true,  true, '2026-11-09 09:00:00+00'),
  (279646, '2026-11-16', 'JP', 'NM', 'pro',     'Y', 'N', 3000, 2,  true,  true, '2026-11-16 09:00:00+00'),
  -- The blueprint's second product, a third of the price: the leg reads the first
  -- id of `card_market_ids`, the same one the client plots.
  (279259, '2026-11-09', 'EN', 'NM', 'private', 'N', 'N',  300, 1,  true,  true, '2026-11-09 09:00:00+00');
"#;

/// A printing with the density of a real one: 1 013 days of both an NM and an SP
/// English offer, which is the span the `All` button asks and the ISO-week
/// thinning is for.
const BUSY_SEED: &str = r#"
insert into public.cardmarket_offer_daily
  (cm_product_id, day, language, condition, seller_type, finish, first_edition,
   min_cents, offer_count, counts_complete, asked, observed_at)
select 279900, day, 'EN', 'NM', 'private', 'N', 'N',
       500 + (extract(day from day)::int % 9) * 10, 1, true, true,
       (day + interval '9 hours')::timestamptz
  from generate_series(date '2024-02-08', date '2026-11-16', interval '1 day') day;
insert into public.cardmarket_offer_daily
  (cm_product_id, day, language, condition, seller_type, finish, first_edition,
   min_cents, offer_count, counts_complete, asked, observed_at)
select 279900, day, 'EN', 'SP', 'pro', 'N', 'N',
       400 + (extract(day from day)::int % 7) * 10, 2, true, true,
       (day + interval '9 hours')::timestamptz
  from generate_series(date '2024-02-08', date '2026-11-16', interval '1 day') day;
"#;

/// The window of the asserted day, and the two spans the sizes are taken over.
const DAYS: &str = "from=2026-11-08&to=2026-11-17";
const MONTHS: &str = "from=2026-08-18&to=2026-11-16";
const ALL: &str = "from=2024-02-08&to=2026-11-16";

/// The table the leg reads, which `cmo_bare` has not.
const OFFER_TABLE: &str = "public.cardmarket_offer_daily";
/// The very statement the guard is about, issued by the control on the database
/// that has the table not.
const STRAY_OFFER_SQL: &str = "select min_cents from public.cardmarket_offer_daily limit 1";
/// A table none of these databases has, the control for the Pokémon database
/// whose offer table is present.
const STRAY_EVENTS_SQL: &str = "select price_pkn from public.marketplace_user_listing_events limit 1";

/// How long a counter read waits for the number it is looking for.
const STAT_WAIT: Duration = Duration::from_secs(5);
const STAT_POLL: Duration = Duration::from_millis(100);
/// The bound `PGSTAT_IDLE_INTERVAL` gives a backend that is never closed.
const IDLE_SETTLE: Duration = Duration::from_secs(12);
/// A "did not grow" claim is worth only the window it was watched for.
const IDLE_WATCH: Duration = Duration::from_millis(1_500);

/// The top-level keys of the answer, with and without `fields=graph`: the new
/// block sits right after the guide line it is drawn next to.
const FULL_KEYS: &str =
    "game,cardId,ctId,from,to,printing,cardtrader,tcgplayer,cardmarket,cardmarketOffers,pokoin,fx";
const GRAPH_KEYS: &str =
    "game,cardId,ctId,from,to,bucket,printing,cardtrader,tcgplayer,cardmarket,cardmarketOffers,pokoin,fx";

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

/// The floors the answer carries, in its own order.
fn floors(body: &Value) -> Vec<String> {
    body["cardmarketOffers"]["series"]
        .as_array()
        .map(|series| {
            series
                .iter()
                .map(|row| row["condition"].as_str().unwrap_or("?").to_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// One floor's days as `day lowestPkn`, plus `sellerType asked` when the answer
/// carries them: a `fields=graph` day has only the two plotted numbers, so the
/// same reader works on both shapes and the two can be compared point by point.
fn offer_days(body: &Value, floor: &str) -> Vec<String> {
    body["cardmarketOffers"]["series"]
        .as_array()
        .map(|series| {
            series
                .iter()
                .filter(|row| row["condition"].as_str() == Some(floor))
                .flat_map(|row| row["days"].as_array().cloned().unwrap_or_default())
                .map(|day| {
                    let mut parts = vec![format!(
                        "{} {}",
                        day["day"].as_str().unwrap_or("?"),
                        day["lowestPkn"]
                    )];
                    if let Some(seller) = day["sellerType"].as_str() {
                        parts.push(seller.to_owned());
                    }
                    if let Some(asked) = day["asked"].as_bool() {
                        parts.push(asked.to_string());
                    }
                    parts.join(" ")
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The two plotted numbers of one floor's days, whatever else the answer carries
/// beside them: the one form in which a full day and a `fields=graph` day of the
/// same day are the same string, which is what the weekly assertions compare.
fn offer_points(body: &Value, floor: &str) -> Vec<String> {
    offer_days(body, floor)
        .iter()
        .map(|row| row.split(' ').take(2).collect::<Vec<&str>>().join(" "))
        .collect()
}

/// Days between two `YYYY-MM-DD` strings, as the weekly gaps are counted.
fn day_span(older: &str, newer: &str) -> i64 {
    let parse = |day: &str| chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok();
    let (Some(older), Some(newer)) = (
        parse(&older[..10.min(older.len())]),
        parse(&newer[..10.min(newer.len())]),
    ) else {
        return i64::MIN;
    };
    newer.signed_duration_since(older).num_days()
}

/// The size of the answer without the new block: the same body with
/// `cardmarketOffers` taken out, which is the byte-for-byte answer this endpoint
/// gave before the leg.
fn size_without_offers(body: &Value) -> usize {
    let mut stripped = body.clone();
    if let Some(object) = stripped.as_object_mut() {
        object.remove("cardmarketOffers");
    }
    stripped.to_string().len()
}

#[tokio::test]
async fn price_history_reads_the_cardmarket_offer_day_and_never_queries_an_absent_table() {
    let Ok(base) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("POKOIN_TEST_DATABASE_URL unset; skipping");
        return;
    };
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&base)
        .await
        .unwrap();
    let (pokemon_url, pokemon) = fresh_db(&admin, &base, "cmo_pokemon").await;
    let (bare_url, bare) = fresh_db(&admin, &base, "cmo_bare").await;
    let (magic_url, magic) = fresh_db(&admin, &base, "cmo_magic").await;

    // The table comes from the migration's own file, so the statement the leg
    // sends is checked against the columns the writer will really have.
    exec_all(&pokemon, CATALOG_SCHEMA).await;
    exec_all(&pokemon, MIGRATION).await;
    exec_all(&pokemon, CARDS).await;
    exec_all(&pokemon, OFFER_SEED).await;
    exec_all(&pokemon, BUSY_SEED).await;
    // The same catalog and the same blueprint, without 145: what production is
    // today, because the migration is not applied there yet.
    exec_all(&bare, CATALOG_SCHEMA).await;
    exec_all(&bare, CARDS).await;
    exec_all(&magic, CATALOG_SCHEMA).await;
    exec_all(&magic, CARDS).await;

    std::env::set_var("MAGIC_MARKETPLACE_DATABASE_URL", &magic_url);

    let app = pokoin_catalog_api::router(pokoin_api_common::RouteState::new(
        pokoin_api_common::ApiState::new(pokemon.clone(), pokemon.clone(), None, 1),
        pokoin_accounts::DomainState::default(),
    ));
    let bare_app = pokoin_catalog_api::router(pokoin_api_common::RouteState::new(
        pokoin_api_common::ApiState::new(bare.clone(), bare.clone(), None, 1),
        pokoin_accounts::DomainState::default(),
    ));

    let logged =
        sqlx::query("select setting from pg_settings where name = 'log_min_error_statement'")
            .fetch_optional(&admin)
            .await
            .ok()
            .flatten()
            .and_then(|row| row.try_get::<String, _>("setting").ok())
            .unwrap_or_else(|| "unreadable".to_owned());
    println!("log_min_error_statement = {logged}");

    // 1. The control, before a single request: a query for the offer table of the
    //    database that has it not, and one for an events table none of these
    //    databases has, must each be seen to abort, so that every "did not abort"
    //    below is worth something. The number it moved to is the baseline.
    let mut baseline: Vec<(&str, i64)> = Vec::new();
    for (database, url, sql, table) in [
        ("cmo_bare", &bare_url, STRAY_OFFER_SQL, OFFER_TABLE),
        (
            "cmo_pokemon",
            &pokemon_url,
            STRAY_EVENTS_SQL,
            "public.marketplace_user_listing_events",
        ),
        ("cmo_magic", &magic_url, STRAY_OFFER_SQL, OFFER_TABLE),
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

    // 2. The default facet: what the desk asks when it has no chip of its own.
    let (status, body, body_bytes) = get(
        &app,
        &format!("/api/marketplace-card-price-history?cardId=239324&{DAYS}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    println!("239324 cardmarketOffers block: {}", body["cardmarketOffers"]);
    assert_eq!(keys(&body), FULL_KEYS);
    assert_eq!(body["ctId"], json!("415200"));
    assert_eq!(
        keys(&body["cardmarketOffers"]),
        "source,currency,metric,status,idProduct,language,finish,firstEdition,conditionIsFloor,series"
    );
    assert_eq!(body["cardmarketOffers"]["source"], "cardmarket_offers");
    assert_eq!(body["cardmarketOffers"]["currency"], "PKN");
    assert_eq!(body["cardmarketOffers"]["metric"], "lowestOffer");
    assert_eq!(body["cardmarketOffers"]["status"], "available");
    assert_eq!(
        body["cardmarketOffers"]["idProduct"], 279646,
        "the first product of the blueprint, the one the client plots"
    );
    assert_eq!(body["cardmarketOffers"]["language"], "EN");
    assert_eq!(body["cardmarketOffers"]["finish"], "N");
    assert_eq!(body["cardmarketOffers"]["firstEdition"], "N");
    assert_eq!(body["cardmarketOffers"]["conditionIsFloor"], true);
    assert_eq!(
        floors(&body),
        ["NM", "SP", "MP"],
        "one series per floor that has a day, in the order of the floors, with the aggregate \
         `*` never one of them and the floors nobody offers left out"
    );
    assert_eq!(
        offer_days(&body, "NM"),
        [
            "2026-11-09 1840 private true",
            "2026-11-16 2200 private true",
        ]
        .map(str::to_owned)
        .to_vec(),
        "9 Nov is the private 9.20 EUR (1 840 PKN) of the two seller types that name the asked \
         finish, not the 5.00 EUR aggregate that merely rode along; 16 Nov is the non-reverse \
         offer and not the cheaper reverse one"
    );
    assert_eq!(
        offer_days(&body, "SP"),
        ["2026-11-09 2000 pro true".to_owned()],
        "9 Nov has no row naming the asked finish, so its aggregate is the day; 16 Nov's only \
         SP is a first edition, which the desk never asks for, so it is not a day"
    );
    assert_eq!(
        offer_days(&body, "MP"),
        ["2026-11-09 1400 private false".to_owned()],
        "an offer that was not aimed at is still the day's cheapest, and says so"
    );
    assert_eq!(
        keys(&body["cardmarketOffers"]["series"][0]["days"][0]),
        "day,lowestPkn,sellerType,asked"
    );
    assert_eq!(body["cardtrader"]["status"], "empty");
    assert_eq!(body["pokoin"]["status"], "empty");
    println!(
        "the other legs of the same answer: cardtrader {}, tcgplayer {}, cardmarket {}, pokoin {}",
        body["cardtrader"]["status"], body["tcgplayer"]["status"], body["cardmarket"]["status"],
        body["pokoin"]["status"]
    );
    assert_eq!(
        body["cardmarket"]["status"], "empty",
        "the guide line is guarded on the same database and its tables are not here"
    );
    assert_ne!(
        body["cardmarketOffers"]["status"], "unavailable",
        "the new leg is the only one here whose tables are present, and it is not the one \
         that degrades"
    );

    // 3. The second facet the desk can ask: another language, and the reverse
    //    finish. `reverse=1` is the desk's own foil chip, so the same statement
    //    must answer a different offer of the same product.
    let (status, jp, _) = get(
        &app,
        &format!(
            "/api/marketplace-card-price-history?cardId=239324&{DAYS}&cmLanguage=JP&reverse=1"
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    println!("239324 cardmarketOffers of jp&reverse=1: {}", jp["cardmarketOffers"]);
    assert_eq!(jp["cardmarketOffers"]["language"], "JP");
    assert_eq!(jp["cardmarketOffers"]["finish"], "Y");
    assert_eq!(jp["cardmarketOffers"]["status"], "available");
    assert_eq!(
        offer_days(&jp, "NM"),
        ["2026-11-16 6000 pro true".to_owned()],
        "the Japanese reverse offer of 16 Nov, and no English row and no non-reverse row of \
         either language in the answer"
    );
    assert_eq!(
        floors(&jp),
        ["NM"],
        "one language's day has only the floors it was seen for"
    );

    //    A facet the collector has no row for is `empty`, not a line of nothing:
    //    the only Japanese offers of this product are non-reverse on 9 Nov and
    //    reverse on 16 Nov, so a plain Japanese ask of the two days between them
    //    has no day at all.
    let (status, none, _) = get(
        &app,
        "/api/marketplace-card-price-history?cardId=239324&from=2026-11-10&to=2026-11-15&cmLanguage=JP",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(none["cardmarketOffers"]["status"], "empty");
    assert_eq!(
        none["cardmarketOffers"]["idProduct"], 279646,
        "the product is still named, so a client can tell an uncollected facet from an \
         unlinked card"
    );
    assert!(floors(&none).is_empty(), "{}", none["cardmarketOffers"]);

    // 4. `fields=graph`: the same block, one series, and only the two numbers the
    //    line is drawn from.
    let (status, graph, graph_bytes) = get(
        &app,
        &format!(
            "/api/marketplace-card-price-history?cardId=239324&{DAYS}&fields=graph&cmCondition=SP"
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(keys(&graph), GRAPH_KEYS);
    assert!(
        graph_bytes < body_bytes,
        "the graph answer of the same ten days is {graph_bytes} B against the full {body_bytes} B"
    );
    println!("10 days: full {body_bytes} B, fields=graph {graph_bytes} B");
    assert_eq!(graph["bucket"], json!("day"), "10 days are plotted day by day");
    assert_eq!(
        keys(&graph["cardmarketOffers"]),
        keys(&body["cardmarketOffers"]),
        "the header of the block is the full one, field for field"
    );
    assert_eq!(
        floors(&graph),
        ["SP"],
        "the graph draws the floor the desk asked for and nothing else"
    );
    assert_eq!(
        offer_days(&graph, "SP"),
        ["2026-11-09 2000".to_owned()],
        "a graph day is the day and its price, with no seller type and no asked flag"
    );
    assert_eq!(
        keys(&graph["cardmarketOffers"]["series"][0]["days"][0]),
        "day,lowestPkn"
    );

    // 5. A parameter that is not a facet is the 400 this handler gives every other
    //    bad parameter, with the vocabulary it accepts, before any statement runs.
    for (param, wanted) in [
        ("cmCondition=Mint", "cmCondition must be one of NM, SP, MP, PL, Poor."),
        ("cmLanguage=ID", "cmLanguage must be one of EN, FR, DE, ES, IT, ZH, JP, PT, RU, KO, ZHT, NL, PL, *."),
        ("cmLanguage=EN;&drop=1", "cmLanguage must be one of EN, FR, DE, ES, IT, ZH, JP, PT, RU, KO, ZHT, NL, PL, *."),
    ] {
        let (status, bad, _) = get(
            &app,
            &format!("/api/marketplace-card-price-history?cardId=239324&{DAYS}&{param}"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{param}");
        assert_eq!(bad["error"], json!(wanted), "{param}");
    }
    //    The floor and the language are case-insensitive and space-tolerant,
    //    because the desk sends what its chip holds.
    let (status, lower, _) = get(
        &app,
        &format!(
            "/api/marketplace-card-price-history?cardId=239324&{DAYS}&fields=graph&cmCondition=nm&cmLanguage=en"
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(floors(&lower), ["NM"], "cmCondition=nm is the NM series");
    assert_eq!(lower["cardmarketOffers"]["language"], "EN");
    assert_eq!(
        offer_days(&lower, "NM"),
        ["2026-11-09 1840".to_owned(), "2026-11-16 2200".to_owned()],
        "the same two days the plain facet asked, however the values were spelled"
    );

    // 6. A printing with no Cardmarket blueprint is `empty` without a query for
    //    the offer table, exactly as the other legs answer it.
    let (status, no_ct, _) = get(
        &app,
        "/api/marketplace-card-price-history?cardId=239997&from=2026-11-09&to=2026-11-09",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    println!("a printing with no blueprint id: {}", no_ct["cardmarketOffers"]);
    assert_eq!(no_ct["cardmarketOffers"]["status"], "empty");
    assert_eq!(
        no_ct["cardmarketOffers"]["idProduct"],
        Value::Null,
        "nothing was resolved, so nothing is named"
    );
    assert!(floors(&no_ct).is_empty());

    // 7. PH-02 for this leg: a database without the daily table answers `empty`,
    //    with the same block and no series, and its other legs still work.
    let (status, missing, _) = get(
        &bare_app,
        &format!("/api/marketplace-card-price-history?cardId=239324&{DAYS}&fields=graph"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    println!("a database without 145: {}", missing["cardmarketOffers"]);
    assert_eq!(keys(&missing), GRAPH_KEYS);
    assert_eq!(missing["cardmarketOffers"]["status"], "empty");
    assert_eq!(missing["cardmarketOffers"]["source"], "cardmarket_offers");
    assert_eq!(missing["cardmarketOffers"]["currency"], "PKN");
    assert_eq!(missing["cardmarketOffers"]["metric"], "lowestOffer");
    assert_eq!(missing["cardmarketOffers"]["idProduct"], Value::Null);
    assert_eq!(missing["cardmarketOffers"]["language"], "EN");
    assert!(
        floors(&missing).is_empty(),
        "{}",
        missing["cardmarketOffers"]
    );
    assert_eq!(missing["pokoin"]["status"], "empty");

    // 8. A game whose offers are not collected answers the leg `unsupported_game`
    //    from the game alone, without reaching a probe.
    let (status, magic_body, _) = get(
        &app,
        &format!("/api/marketplace-card-price-history?cardId=4152&game=magic&{MONTHS}&cmCondition=Poor&cmLanguage=DE"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    println!("magic cardmarketOffers block: {}", magic_body["cardmarketOffers"]);
    assert_eq!(magic_body["game"], "magic");
    assert_eq!(magic_body["cardmarketOffers"]["status"], "unsupported_game");
    assert_eq!(magic_body["cardmarketOffers"]["source"], "cardmarket_offers");
    assert_eq!(
        magic_body["cardmarketOffers"]["language"], "DE",
        "the facet asked is still what the block names"
    );
    assert_eq!(magic_body["cardmarketOffers"]["idProduct"], Value::Null);
    assert!(floors(&magic_body).is_empty());
    assert_eq!(magic_body["cardmarket"]["status"], "unsupported_game");

    // 9. A span past 400 days is one point per ISO week, and the sizes the leg
    //    costs: the same request with its block taken back out is what this
    //    endpoint answered before.
    for (label, span, bucket, days, first, last) in [
        ("3 months", MONTHS, "day", 91, "2026-08-18 1000", "2026-11-16 1140"),
        (
            "all time",
            ALL,
            "week",
            1_013,
            "2024-02-11 1040",
            "2026-11-16 1140",
        ),
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
        assert_eq!(keys(&full), FULL_KEYS);
        assert_eq!(keys(&small), GRAPH_KEYS);
        assert_eq!(small["bucket"], json!(bucket));
        println!(
            "{label} (card 249386, {span}): full {full_bytes} B, fields=graph {graph_bytes} B, \
             the same answer without cardmarketOffers {} B, so the leg costs {} B",
            size_without_offers(&small),
            graph_bytes - size_without_offers(&small),
        );
        assert_eq!(floors(&full), ["NM", "SP"], "both floors of the busy printing");
        assert_eq!(
            floors(&small),
            ["NM"],
            "a graph answer of the default facet draws the NM line and leaves the SP one out, \
             which is exactly what the desk's condition chip asked for"
        );
        let all = offer_points(&full, "NM");
        assert_eq!(
            all.len(),
            days,
            "every day the collector saw, day by day over a short span"
        );
        let thin = offer_points(&small, "NM");
        assert_eq!(
            thin.first().unwrap().as_str(),
            first,
            "the last day of the first week that has a value"
        );
        assert_eq!(
            thin.last().unwrap().as_str(),
            last,
            "and today, in its own short week"
        );
        if bucket == "week" {
            assert_eq!(thin.len(), 146, "one point per ISO week, not one per day");
            for point in &thin {
                assert!(
                    all.contains(point),
                    "{point} is not in the full answer: thinning invented a price"
                );
            }
            for (index, pair) in thin.windows(2).enumerate() {
                let gap = day_span(&pair[0], &pair[1]);
                let is_last = index + 2 == thin.len();
                assert!(
                    gap == 7 || (is_last && gap > 0 && gap < 7),
                    "weekly offer days {gap} apart: {pair:?}"
                );
            }
        } else {
            assert_eq!(thin, all, "a short span thins nothing");
        }
    }

    // 10. No database aborted a statement across the requests. The pools this test
    //     owns are closed first, which reports what they counted; what is left is
    //     the magic satellite pool, which waits out IDLE_SETTLE.
    pokemon.close().await;
    bare.close().await;
    magic.close().await;
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
