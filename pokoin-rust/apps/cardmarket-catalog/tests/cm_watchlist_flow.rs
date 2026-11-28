//! PH-R032 W2 on a real Postgres: the `cm-watchlist` statement run against a
//! seeded fixture, so the reason per card, the ranking inside each reason, the
//! interleaved cut, the product two cards asked for, the guard on non-numeric
//! ids, the windows and the cap are answers the server gave and not answers the
//! Rust code assumed. The mixing itself (`watchlist::walk`) is unit-tested in
//! `src/watchlist.rs`; what is proved here is that the numbers it mixes come out
//! of SQL as the fixture deserves.
//!
//! ```text
//! docker run -d --rm --name pokoin-ph-r032-test-pg -e POSTGRES_PASSWORD=test \
//!   -e POSTGRES_DB=pokoin_marketplace -p 127.0.0.1:55497:5432 \
//!   --tmpfs /var/lib/postgresql postgres:19.0-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55497/pokoin_marketplace \
//!   cargo test -p cardmarket-catalog --test cm_watchlist_flow -- --nocapture
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped, as every `*_flow`
//! test is. It creates and drops only the five tables it reads, in a throwaway
//! database; it writes nothing outside them, and the last assertion proves the
//! statement itself did not write anything at all.
//!
//! CI's database job discovers `pokoin-rust/crates/*/tests/*_flow.rs` only
//! (`scripts/run-flow-tests.sh:49`), so an app-level flow test like this one —
//! which is where the neighbouring app tests live too — runs when somebody
//! starts the container above, not in the sharded `cargo test` job.
//!
//! The event leg is also given 60,000 synthetic rows over 40 days so the
//! `EXPLAIN` this test prints reflects a windowed range scan of
//! `marketplace_card_events_recent_idx` rather than an empty table. The
//! synthetic cards have no catalog row, so they cannot change any assertion —
//! and because a card with no product is dropped before it is numbered, they do
//! not spend a turn of the viewed list either, which is what the cut counts.

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

/// One card per reason and one card per way of not qualifying, plus four cards
/// only guests looked at so the cut has something to interleave with the
/// listings. Public card ids and blueprint ids are the same number so the chain
/// is readable.
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
  (221, '[900221]'),
  (230, '[900230]'),                       -- the four cards only guests viewed
  (231, '[900231]'),
  (232, '[900232]'),
  (233, '[900233]');

insert into public.marketplace_search_candidates (card_id, ct_id) values
  (201, 201), (202, 202), (204, 204), (205, 205), (206, 206), (207, 207), (210, 210),
  (211, 211), (213, 213), (214, 214), (215, 215), (216, 216), (217, 217), (218, 218),
  (219, 219), (221, 221), (230, 230), (231, 231), (232, 232), (233, 233);   -- no card 212

-- viewed_member: weights 20 > 9 > 1, and card 202 is listed as well.
insert into public.marketplace_card_events (card_id, user_uid, event_type, weight, occurred_at) values
  (211, 'member', 'sale',      20, now() - interval '4 hours'),
  (202, 'member', 'click',      4, now() - interval '2 hours'),
  (202, 'member', 'search',     5, now() - interval '3 hours'),
  (201, 'member', 'view',       1, now() - interval '1 hour'),
  (207, 'member', 'view',     100, now() - interval '40 days'),  -- outside --days 7
  (212, 'member', 'view',       9, now() - interval '1 hour');   -- no catalog row
-- viewed: no user_uid at all, which is most of the traffic. 214 is a listing
-- that was looked at too, which is what lifts it to the head of its own list.
insert into public.marketplace_card_events (card_id, user_uid, event_type, weight, occurred_at) values
  (206, null, 'view', 1, now() - interval '5 hours'),
  (210, null, 'view', 1, now() - interval '6 hours'),            -- no Cardmarket product
  (214, null, 'view', 7, now() - interval '3 hours'),            -- listed and viewed
  (230, null, 'view', 9, now() - interval '2 hours'),
  (231, null, 'view', 5, now() - interval '3 days'),
  (232, null, 'view', 5, now() - interval '1 hour'),             -- same weight, more recent
  (233, null, 'view', 1, now() - interval '8 hours');

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

/// A walked line without its rank: product, card, reason.
type Want = (&'static str, &'static str, &'static str);

/// The 16 lines `--days 7 --cap 100 --viewed-share 50` should walk, in the order
/// the collector should open them: the head list (`viewed_member` by weight, then
/// `scanned`) first, then one listing and one viewed card in turn, each in its
/// own order. Card 214 leads the listings because seven people looked at it, and
/// 204 spends two of the day's lines on its two products.
const DAY_HALF: [Want; 16] = [
    ("900211", "211", "viewed_member"),
    ("900202", "202", "viewed_member"),
    ("900201", "201", "viewed_member"),
    ("900205", "205", "scanned"),
    // 214 is listed and looked at: its view weight lifts it inside `listed`.
    ("900214", "214", "listed"),
    ("900230", "230", "viewed"),
    ("900401", "204", "listed"),
    ("900402", "204", "listed"),
    // 232 and 231 weigh the same; the newer one is walked first.
    ("900232", "232", "viewed"),
    // 204 has two listings, so it still outranks the single-listing cards.
    ("900213", "213", "listed"),
    ("900231", "231", "viewed"),
    // 900206 is asked for by the listed 218 and by the viewed 206. The listing's
    // turn comes first, so it is walked as `listed` and 206 keeps only 900226.
    ("900206", "218", "listed"),
    ("900226", "206", "viewed"),
    // 215 and 216 are equal in every other way; the lower card id goes first.
    ("900215", "215", "listed"),
    ("900233", "233", "viewed"),
    ("900216", "216", "listed"),
];

/// The same day with `--viewed-share 0`: no viewed card outranks a listing,
/// which is the day production showed before the cut was interleaved. The head
/// list still leads, because its place does not depend on the share.
const DAY_LISTINGS_FIRST: [Want; 16] = [
    ("900211", "211", "viewed_member"),
    ("900202", "202", "viewed_member"),
    ("900201", "201", "viewed_member"),
    ("900205", "205", "scanned"),
    ("900214", "214", "listed"),
    ("900401", "204", "listed"),
    ("900402", "204", "listed"),
    ("900213", "213", "listed"),
    ("900206", "218", "listed"),
    ("900215", "215", "listed"),
    ("900216", "216", "listed"),
    ("900230", "230", "viewed"),
    ("900232", "232", "viewed"),
    ("900231", "231", "viewed"),
    ("900226", "206", "viewed"),
    ("900233", "233", "viewed"),
];

/// The same day with `--viewed-share 100`: the viewers lead and the listings
/// fill. Card 206 now reaches 900206 before 218 does, so `listed` walks one
/// product fewer and 218 contributes nothing at all.
const DAY_VIEWERS_FIRST: [Want; 16] = [
    ("900211", "211", "viewed_member"),
    ("900202", "202", "viewed_member"),
    ("900201", "201", "viewed_member"),
    ("900205", "205", "scanned"),
    ("900230", "230", "viewed"),
    ("900232", "232", "viewed"),
    ("900231", "231", "viewed"),
    ("900206", "206", "viewed"),
    ("900226", "206", "viewed"),
    ("900233", "233", "viewed"),
    ("900214", "214", "listed"),
    ("900401", "204", "listed"),
    ("900402", "204", "listed"),
    ("900213", "213", "listed"),
    ("900215", "215", "listed"),
    ("900216", "216", "listed"),
];

/// What each reason held before the cut, at `--days 7`: 17 lines to be had, and
/// the day walked 16 of them, because 900206 was asked for twice.
const TOTALS: [(&str, i64); 4] = [
    ("viewed_member", 3),
    ("listed", 7),
    ("scanned", 1),
    ("viewed", 6),
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

fn entry(product: &str, card: &str, reason: &str, rank: i64) -> Entry {
    Entry {
        id_product: product.parse().unwrap_or_default(),
        card_id: card.to_string(),
        reason: reason.to_string(),
        rank,
    }
}

/// The day a `want` list describes, numbered from 1: `rank` is the position in
/// the walked day, whatever list each line came from.
fn day(wanted: &[Want]) -> Vec<Entry> {
    wanted
        .iter()
        .enumerate()
        .map(|(index, (product, card, reason))| entry(product, card, reason, index as i64 + 1))
        .collect()
}

/// The counts table for a walked day, over the fixture's `TOTALS`.
fn side(kept: [i64; 4]) -> Vec<ReasonCount> {
    TOTALS
        .iter()
        .zip(kept)
        .map(|((reason, total), kept)| ReasonCount {
            reason: (*reason).to_string(),
            total: *total,
            kept,
        })
        .collect()
}

#[tokio::test]
async fn cm_watchlist_interleaves_reasons_caps_and_writes_nothing() {
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

    let list = Watchlist {
        days: 7,
        cap: 100,
        viewed_share: 50,
    };
    let run = watchlist::fetch_conn(&mut conn, &list)
        .await
        .expect("the watchlist statement");
    let half = day(&DAY_HALF);
    assert_eq!(run.entries, half, "the interleaved day");
    assert_eq!(
        run.counts,
        side([3, 7, 1, 5]),
        "before the cut each reason held what the fixture says; after it, the day's lines"
    );
    assert_eq!(
        run.counts.iter().map(|c| c.kept).sum::<i64>() as usize,
        run.entries.len(),
        "the kept counts add up to the lines the day walks"
    );
    assert!(
        run.entries.iter().all(|e| e.rank > 0),
        "rank is the position in the walked day"
    );

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

    // The two ends of `--viewed-share`, over the same rows.
    let listings = watchlist::fetch_conn(
        &mut conn,
        &Watchlist {
            days: 7,
            cap: 100,
            viewed_share: 0,
        },
    )
    .await
    .expect("a day of listings");
    assert_eq!(
        listings.entries,
        day(&DAY_LISTINGS_FIRST),
        "share 0: no viewed card outranks a listing"
    );
    assert_eq!(
        listings.counts,
        side([3, 7, 1, 5]),
        "the same 16 lines, so the same kept side"
    );
    let viewers = watchlist::fetch_conn(
        &mut conn,
        &Watchlist {
            days: 7,
            cap: 100,
            viewed_share: 100,
        },
    )
    .await
    .expect("a day of viewers");
    assert_eq!(
        viewers.entries,
        day(&DAY_VIEWERS_FIRST),
        "share 100: the viewers lead and 206 claims 900206"
    );
    assert_eq!(
        viewers.counts,
        side([3, 6, 1, 6]),
        "one listing fewer, because 218 lost its only product to card 206 first"
    );

    // A cap that cuts through both lists, and through one card's own products:
    // four head lines, then the first listing, then the first viewed card, then
    // the first of card 204's two products.
    let capped = watchlist::fetch_conn(
        &mut conn,
        &Watchlist {
            days: 7,
            cap: 7,
            viewed_share: 50,
        },
    )
    .await
    .expect("the capped read");
    assert_eq!(
        capped.entries,
        half[..7].to_vec(),
        "the cut is the head of the same day"
    );
    assert_eq!(
        capped.counts,
        side([3, 2, 1, 1]),
        "7 of 17 lines, and each reason's own share of them"
    );

    // A cap shallower than the head list: the statement bounds what it sends by
    // `--cap` per list, yet the totals still describe the whole day.
    let tiny = watchlist::fetch_conn(
        &mut conn,
        &Watchlist {
            days: 7,
            cap: 3,
            viewed_share: 50,
        },
    )
    .await
    .expect("the three-line read");
    assert_eq!(tiny.entries, half[..3].to_vec(), "the head list alone");
    assert_eq!(
        tiny.counts,
        side([3, 0, 0, 0]),
        "the totals are counted before that bound, not after it"
    );

    // `--days` is the event window only: the scan window stays 30 days, so a
    // 60-day read gains the 40-day member view (weight 100, first in the head)
    // and still not the 45-day scan.
    let wide = watchlist::fetch_conn(
        &mut conn,
        &Watchlist {
            days: 60,
            cap: 100,
            viewed_share: 50,
        },
    )
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
    want60.extend(half.iter().map(|e| Entry {
        rank: e.rank + 1,
        ..e.clone()
    }));
    assert_eq!(
        wide.entries, want60,
        "--days 60 gains exactly the 40-day view, leads with it, and shifts every later line down one"
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
            ("viewed", 6, 5),
        ],
        "the scan window stays 30 days: the 45-day scan never lists"
    );

    // The file the collector is handed: exactly one JSON object per line.
    let text = watchlist::body(&run.entries);
    assert_eq!(
        text,
        half.iter()
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
        "capped to 7:\n{}",
        watchlist::report(
            &Watchlist {
                days: 7,
                cap: 7,
                viewed_share: 50,
            },
            &capped
        )
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
