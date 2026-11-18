//! PH-R032 W2 on a real Postgres: the `cm-watchlist` statement run against a
//! seeded fixture, so the reason precedence, the ranking inside each reason, the
//! two de-duplications, the guard on non-numeric ids, the windows and the cap are
//! answers the server gave and not answers the Rust code assumed.
//!
//! ```text
//! docker run -d --rm --name pokoin-ph-r032-test-pg -e POSTGRES_PASSWORD=test \
//!   -e POSTGRES_DB=pokoin_marketplace -p 127.0.0.1:55497:5432 \
//!   --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55497/pokoin_marketplace \
//!   cargo test -p cardmarket-catalog --test cm_watchlist_flow -- --nocapture
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped, as every `*_flow`
//! test is. It creates and drops only the five tables it reads, in a throwaway
//! database; it writes nothing outside them, and the last assertion proves the
//! statement itself did not write anything at all.
//!
//! The event leg is also given 60,000 synthetic rows over 40 days so the
//! `EXPLAIN` this test prints reflects a windowed range scan of
//! `marketplace_card_events_recent_idx` rather than an empty table. The
//! synthetic cards have no catalog row, so they cannot change any assertion.

use std::time::Duration;

use cardmarket_catalog::watchlist::{self, Entry, ReasonCount, Watchlist};
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::Connection;

/// The five production tables the statement reads, with the columns the
/// statement touches and the two indexes it is shaped around.
const SCHEMA: &str = r#"
drop table if exists public.marketplace_card_events, public.marketplace_user_listings,
  public.scan_items, public.marketplace_search_candidates,
  public.cardtrader_pokemon_blueprints cascade;

create table public.marketplace_card_events (
  id bigint generated always as identity primary key,
  card_id bigint not null,
  user_uid text,
  event_type text not null,
  weight numeric not null,
  metadata jsonb,
  occurred_at timestamptz not null,
  ct_id bigint);
create index marketplace_card_events_recent_idx
  on public.marketplace_card_events (occurred_at desc, card_id);

create table public.marketplace_user_listings (
  id bigint generated always as identity primary key,
  card_id text not null,
  seller_uid text not null,
  status text not null default 'active',
  quantity_available integer not null default 1,
  price_pkn numeric not null default 0,
  marketplace_game text not null default 'pokemon',
  updated_at timestamptz not null default now());
create index marketplace_user_listings_card_active_idx
  on public.marketplace_user_listings (card_id, price_pkn)
  where status = 'active' and quantity_available > 0;

create table public.scan_items (
  id bigint generated always as identity primary key,
  card_id text,
  seller_uid text,
  status text not null default 'active',
  quantity integer not null default 1,
  captured_at timestamptz not null default now());

create table public.marketplace_search_candidates (card_id bigint primary key, ct_id bigint);
create index marketplace_search_candidates_ct_id_idx on public.marketplace_search_candidates (ct_id);

create table public.cardtrader_pokemon_blueprints (
  id bigint primary key, card_market_ids jsonb not null default '[]'::jsonb);
"#;

/// One card per reason and one card per way of not qualifying. Public card ids
/// and blueprint ids are the same number so the chain is readable.
const SEED: &str = r#"
insert into public.cardtrader_pokemon_blueprints (id, card_market_ids) values
  (201, '[900201]'),                       -- one product
  (202, '[900202]'),
  (204, '[900401, 900402]'),               -- two products: two lines, both capped
  (205, '[900205]'),
  (206, '[900206, 900226]'),               -- shares 900206 with card 218
  (207, '[900207]'),
  (210, '[]'),                             -- no product at all
  (211, '[900211, "oops"]'),               -- one product id that is not numeric
  (212, '[900212]'),
  (213, '[900213]'),
  (214, '[900214]'),
  (215, '[900215]'),
  (216, '[900216]'),
  (217, '[900217]'),
  (218, '[900206]'),
  (219, '[900219]'),
  (221, '[900221]');

insert into public.marketplace_search_candidates (card_id, ct_id) values
  (201, 201), (202, 202), (204, 204), (205, 205), (206, 206), (207, 207), (210, 210),
  (211, 211), (213, 213), (214, 214), (215, 215), (216, 216), (217, 217), (218, 218),
  (219, 219), (221, 221);                                        -- card 212 has no row

-- viewed_member: weights 20 > 9 > 1, and card 202 is listed as well.
insert into public.marketplace_card_events (card_id, user_uid, event_type, weight, occurred_at) values
  (211, 'member', 'sale',      20, now() - interval '4 hours'),
  (202, 'member', 'click',      4, now() - interval '2 hours'),
  (202, 'member', 'search',     5, now() - interval '3 hours'),
  (201, 'member', 'view',       1, now() - interval '1 hour'),
  (207, 'member', 'view',     100, now() - interval '40 days'),  -- outside --days 7
  (212, 'member', 'view',       9, now() - interval '1 hour');   -- no catalog row
-- viewed: no user_uid at all, which is most of the traffic.
insert into public.marketplace_card_events (card_id, user_uid, event_type, weight, occurred_at) values
  (206, null, 'view', 1, now() - interval '5 hours'),
  (210, null, 'view', 1, now() - interval '6 hours');            -- no Cardmarket product

insert into public.marketplace_user_listings
  (card_id, seller_uid, status, quantity_available, marketplace_game, updated_at) values
  ('202', 'seller', 'active', 3,   'pokemon', now() - interval '1 hour'),
  ('204', 'seller', 'active', 1,   'pokemon', now() - interval '2 hours'),
  ('204', 'other',  'active', 2,   'pokemon', now() - interval '3 hours'),
  ('213', 'seller', 'active', 1,   'pokemon', now() - interval '1 day'),
  ('218', 'seller', 'active', 1,   'pokemon', now() - interval '2 days'),
  ('214', 'seller', 'active', 1,   'pokemon', now() - interval '5 days'),
  ('215', 'seller', 'active', 1,   'pokemon', '2026-01-05 00:00:00+00'),
  ('216', 'seller', 'active', 1,   'pokemon', '2026-01-05 00:00:00+00'),
  ('217', 'seller', 'active', 0,   'pokemon', now() - interval '1 hour'),  -- no stock
  ('220', 'seller', 'paused', 1,   'pokemon', now() - interval '1 hour'),  -- not active
  ('219', 'seller', 'active', 1,   'magic',   now() - interval '1 hour'),  -- other game
  ('abc', 'seller', 'active', 1,   'pokemon', now() - interval '1 hour');  -- not an integer

insert into public.scan_items (card_id, seller_uid, status, quantity, captured_at) values
  ('205', 'seller', 'active', 1, now() - interval '10 days'),
  ('221', 'seller', 'active', 1, now() - interval '45 days'),               -- past 30 days
  ('12x', 'seller', 'active', 1, now() - interval '1 hour');                -- not an integer

-- Volume for the plan: 60,000 events over 40 days on cards the catalog does not
-- have, so the windowed leg is measured against a real range and not a demo.
insert into public.marketplace_card_events (card_id, user_uid, event_type, weight, occurred_at)
  select 500000 + (g % 20000), (case when g % 7 = 0 then 'member' end),
         'view', 1, now() - ((g % 40) * interval '1 day') - ((g % 24) * interval '1 hour')
    from generate_series(1, 60000) g;
analyze public.marketplace_card_events;
analyze public.marketplace_user_listings;
analyze public.scan_items;
analyze public.marketplace_search_candidates;
analyze public.cardtrader_pokemon_blueprints;
"#;

/// The 12 lines `--days 7` should rank, in order: strongest reason first, then
/// weight, then activity, then card id, then product id.
const EXPECTED: [(&str, &str, &str, i64); 12] = [
    ("900211", "211", "viewed_member", 1),
    ("900202", "202", "viewed_member", 2),
    ("900201", "201", "viewed_member", 3),
    ("900401", "204", "listed", 4),
    ("900402", "204", "listed", 5),
    ("900213", "213", "listed", 6),
    // 900206 goes to the listed card 218, not to the guest-viewed 206.
    ("900206", "218", "listed", 7),
    ("900214", "214", "listed", 8),
    ("900215", "215", "listed", 9),
    ("900216", "216", "listed", 10),
    ("900205", "205", "scanned", 11),
    // Card 206 keeps the product nobody else asked for, under `viewed`.
    ("900226", "206", "viewed", 12),
];

/// One reason's share of those 12 lines, before any cap.
const EXPECTED_COUNTS: [(&str, i64); 4] = [
    ("viewed_member", 3),
    ("listed", 7),
    ("scanned", 1),
    ("viewed", 1),
];

async fn pool() -> PgPool {
    let url = std::env::var("POKOIN_TEST_DATABASE_URL").unwrap_or_default();
    assert!(
        !url.trim().is_empty(),
        "POKOIN_TEST_DATABASE_URL is not set"
    );
    PgPoolOptions::new()
        .max_connections(3)
        .acquire_timeout(Duration::from_secs(10))
        .connect(url.trim())
        .await
        .expect("connect the throwaway Postgres")
}

async fn counts(pool: &PgPool) -> Result<Vec<i64>, sqlx::Error> {
    let mut out = Vec::new();
    for table in [
        "public.marketplace_card_events",
        "public.marketplace_user_listings",
        "public.scan_items",
        "public.marketplace_search_candidates",
        "public.cardtrader_pokemon_blueprints",
    ] {
        out.push(
            sqlx::query_scalar::<_, i64>(&format!("select count(*) from {table}"))
                .fetch_one(pool)
                .await?,
        );
    }
    Ok(out)
}

fn entry(id_product: &str, card_id: &str, reason: &str, rank: i64) -> Entry {
    Entry {
        id_product: id_product.parse().unwrap_or_default(),
        card_id: card_id.to_string(),
        reason: reason.to_string(),
        rank,
    }
}

#[tokio::test]
async fn cm_watchlist_ranks_reasons_caps_and_writes_nothing() {
    if std::env::var("POKOIN_TEST_DATABASE_URL").is_err() {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    }
    let pool = pool().await;
    sqlx::raw_sql(SCHEMA).execute(&pool).await.expect("schema");
    sqlx::raw_sql(SEED).execute(&pool).await.expect("seed");
    let before = counts(&pool).await.expect("row counts before");

    // The read runs on its own connection, under the session guards.
    let url = std::env::var("POKOIN_TEST_DATABASE_URL").unwrap_or_default();
    let mut conn = sqlx::postgres::PgConnection::connect(url.trim())
        .await
        .expect("connect one session");

    let list = Watchlist { days: 7, cap: 100 };
    let run = watchlist::fetch_conn(&mut conn, &list)
        .await
        .expect("the watchlist statement");

    let want: Vec<Entry> = EXPECTED
        .iter()
        .map(|(product, card, reason, rank)| entry(product, card, reason, *rank))
        .collect();
    assert_eq!(run.entries, want, "the ranked list");
    let want_counts: Vec<ReasonCount> = EXPECTED_COUNTS
        .iter()
        .map(|(reason, total)| ReasonCount {
            reason: (*reason).to_string(),
            total: *total,
            kept: *total,
        })
        .collect();
    assert_eq!(run.counts, want_counts, "counts per reason, uncapped");

    // The session cannot write, and is bounded: both guards the job needs.
    let timeout: String = sqlx::query_scalar("show statement_timeout")
        .fetch_one(&mut conn)
        .await
        .expect("statement_timeout");
    assert_eq!(timeout, format!("{}s", watchlist::STATEMENT_TIMEOUT_SECS));
    let read_only: String = sqlx::query_scalar("show default_transaction_read_only")
        .fetch_one(&mut conn)
        .await
        .expect("default_transaction_read_only");
    assert_eq!(read_only, "on");
    let attempted = sqlx::query("create table public.ph_r032_wrote (id integer)")
        .execute(&mut conn)
        .await;
    let error = match attempted {
        Ok(_) => String::from("the write was accepted"),
        Err(e) => e.to_string(),
    };
    assert!(
        error.contains("read-only"),
        "a watchlist session accepted a write: {error}"
    );

    // The same statement with a small cap: the cut happens after the ranking,
    // and the counts say what each reason lost.
    let capped = watchlist::fetch_conn(&mut conn, &Watchlist { days: 7, cap: 4 })
        .await
        .expect("the capped read");
    assert_eq!(
        capped.entries,
        want[..4].to_vec(),
        "the cap keeps the first four lines"
    );
    assert_eq!(
        capped
            .counts
            .iter()
            .map(|c| (c.reason.as_str(), c.total, c.kept))
            .collect::<Vec<_>>(),
        vec![
            ("viewed_member", 3, 3),
            ("listed", 7, 1),
            ("scanned", 1, 0),
            ("viewed", 1, 0),
        ],
        "before and after the cap"
    );
    assert_eq!(
        capped.counts.iter().map(|c| c.kept).sum::<i64>() as usize,
        capped.entries.len(),
        "the kept counts add up to the lines the cap left"
    );

    // `--days` is the event window only: the scan window stays 30 days, so a
    // 60-day read gains the 40-day view (weight 100, first) and still not the
    // 45-day scan.
    let wide = watchlist::fetch_conn(&mut conn, &Watchlist { days: 60, cap: 100 })
        .await
        .expect("the 60 day read");
    assert_eq!(
        wide.entries
            .first()
            .map(|e| (e.id_product, e.card_id.as_str(), e.reason.as_str())),
        Some((900207, "207", "viewed_member")),
        "the 40-day member view weighs 100 and leads when --days covers it"
    );
    let mut want60 = vec![entry("900207", "207", "viewed_member", 1)];
    want60.extend(want.iter().map(|e| Entry {
        rank: e.rank + 1,
        ..e.clone()
    }));
    assert_eq!(
        wide.entries, want60,
        "--days 60 gains exactly the 40-day view and pushes every later line down one"
    );
    assert_eq!(
        wide.counts
            .iter()
            .map(|c| (c.reason.as_str(), c.total, c.kept))
            .collect::<Vec<_>>(),
        vec![
            ("viewed_member", 4, 4),
            ("listed", 7, 7),
            ("scanned", 1, 1),
            ("viewed", 1, 1),
        ],
        "the scan window stays 30 days: the 45-day scan never lists"
    );

    // The file the collector is handed: exactly one JSON object per line.
    let text = watchlist::body(&run.entries);
    assert_eq!(
        text,
        want.iter()
            .map(watchlist::line)
            .collect::<Vec<String>>()
            .join("\n")
            + "\n"
    );
    assert_eq!(
        text.lines().next(),
        Some(r#"{"idProduct":900211,"cardId":"211","reason":"viewed_member","rank":1}"#)
    );
    println!("{}", watchlist::report(&list, &run));
    println!(
        "capped to 4:\n{}",
        watchlist::report(&Watchlist { days: 7, cap: 4 }, &capped)
    );

    // Nothing at all was written by the read.
    assert_eq!(
        counts(&pool).await.expect("row counts after"),
        before,
        "the statement changed the data"
    );

    // Evidence for the lead: the plan this fixture's statistics give the
    // statement. Diagnostic only — a plan is not a contract, so a database
    // that declines to explain it must not fail the run. A utility statement
    // cannot carry $n parameters, so the statement is prepared with its real
    // parameter types first and explained through EXECUTE.
    let plan = explain(&mut conn).await;
    match plan {
        Ok(lines) => {
            println!("plan:\n{}", lines.join("\n"));
            let uses_recent_index = lines
                .iter()
                .any(|l| l.contains("marketplace_card_events_recent_idx"));
            println!(
                "the event range reads marketplace_card_events_recent_idx: {uses_recent_index}"
            );
        }
        Err(e) => println!("plan unavailable: {e}"),
    }

    conn.close().await.ok();
    pool.close().await;
}

/// `EXPLAIN (ANALYZE, BUFFERS)` of the watchlist statement at the defaults.
async fn explain(conn: &mut sqlx::PgConnection) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query(&format!(
        "prepare cm_watchlist_plan (int, int, bigint, text[], text) as {}",
        watchlist::WATCHLIST_SQL
    ))
    .execute(&mut *conn)
    .await?;
    let rows = sqlx::query_scalar::<_, String>(&format!(
        "explain (analyze, buffers) execute cm_watchlist_plan (7, {}, 1200, '{{{}}}', '{}')",
        watchlist::SCAN_DAYS,
        watchlist::REASONS.join(","),
        watchlist::GAME,
    ))
    .fetch_all(&mut *conn)
    .await?;
    sqlx::query("deallocate cm_watchlist_plan")
        .execute(&mut *conn)
        .await?;
    Ok(rows)
}
