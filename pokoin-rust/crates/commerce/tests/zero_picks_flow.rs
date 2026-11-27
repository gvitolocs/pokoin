//! CardTrader Zero picks against a real Postgres: a pick finalizes or swaps
//! copies, the outbox carries the CardTrader change, undo reverses it, and a
//! replay never moves stock twice. Applies the real migration
//! `scripts/sql/135_cardtrader_zero_picks.sql`.
//!
//! Needs a throwaway server (the test drops and recreates its database):
//!
//! ```text
//! docker run -d --rm --name pokoin-zero-picks-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55497:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55497/postgres \
//!   cargo test -p pokoin-commerce --test zero_picks_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped.

use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tower::ServiceExt;

use pokoin_commerce::auth::{AuthError, Claims, TokenVerifier};
use pokoin_commerce::config::CommerceConfig;
use pokoin_commerce::state::DomainState;

const LISTINGS_SQL: &str = "
create table public.marketplace_user_listings (
  id uuid primary key default gen_random_uuid(),
  card_id text not null,
  seller_uid text not null,
  seller_name text not null default 'Pokoin seller',
  seller_country text not null default 'EU',
  seller_reputation_label text not null default 'New',
  condition text not null default 'NM',
  language text not null default 'EN',
  price_pkn numeric not null,
  quantity_available integer not null default 1 check (quantity_available >= 0),
  signed boolean not null default false,
  reverse boolean not null default false,
  first_edition boolean not null default false,
  foil_state text not null default 'standard',
  variant_state text not null default '',
  sealed boolean not null default false,
  graded boolean not null default false,
  grading_company text,
  grade text,
  certification_id text,
  shipping_available boolean not null default true,
  reserve_available boolean not null default false,
  nft_available boolean not null default false,
  seller_comment text not null default '',
  source text not null default 'pokoin_user_listing',
  source_listing_id text not null default '',
  status text not null default 'active' check (status in ('active', 'paused', 'inactive', 'sold_out')),
  card_name text not null default '',
  card_image_url text not null default '',
  set_name text not null default '',
  collector_number text not null default '',
  location text not null default '',
  altered boolean not null default false,
  marketplace_game text not null default 'pokemon',
  photo_urls text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (price_pkn >= 0 and (price_pkn > 0 or status <> 'active'))
);
create or replace function public.refresh_marketplace_blueprint_price_summary(text)
  returns void language sql as 'select';
";


struct UidToken;
#[async_trait]
impl TokenVerifier for UidToken {
    async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        if token.is_empty() {
            return Err(AuthError::Invalid("empty".into()));
        }
        Ok(Claims { uid: token.into(), ..Default::default() })
    }
}

async fn run_sql(pool: &PgPool, sql: &str) {
    sqlx::raw_sql(sql).execute(pool).await.expect("schema");
}

async fn send(app: &Router, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", "Bearer seller-1")
        .header("content-type", "application/json")
        .body(body.map(|b| Body::from(b.to_string())).unwrap_or_else(Body::empty))
        .unwrap();
    let response = app.clone().oneshot(request).await.expect("router");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// `(quantity, status, location)` of one listing.
async fn row(pool: &PgPool, id: &str) -> (i32, String, String) {
    sqlx::query_as("select quantity_available, status, location from public.marketplace_user_listings where id = $1::uuid")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("listing row")
}

async fn stock(pool: &PgPool) -> i64 {
    sqlx::query_scalar("select coalesce(sum(quantity_available), 0)::bigint from public.marketplace_user_listings where seller_uid = 'seller-1'")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// CardTrader edits queued since `after` (outbox id), in order.
async fn edits_since(pool: &PgPool, after: i64) -> Vec<(String, Value, Value)> {
    sqlx::query_as::<_, (String, Value, Value)>(
        "select aggregate_id, payload->'cardtraderEdit', payload->'mutation' from public.marketplace_outbox where id > $1 order by id",
    )
    .bind(after)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn last_outbox(pool: &PgPool) -> i64 {
    sqlx::query_scalar("select coalesce(max(id), 0) from public.marketplace_outbox").fetch_one(pool).await.unwrap()
}

async fn insert(pool: &PgPool, qty: i32, status: &str, location: &str, source: &str, condition: &str) -> String {
    sqlx::query_scalar(
        "insert into public.marketplace_user_listings (card_id, seller_uid, price_pkn, quantity_available, status, location, source_listing_id, condition, card_name, set_name, collector_number) \
         values ('202', 'seller-1', 100, $1, $2, $3, $4, $5, 'Pikachu', 'Base Set', '58/102') returning id::text",
    )
    .bind(qty)
    .bind(status)
    .bind(location)
    .bind(source)
    .bind(condition)
    .fetch_one(pool)
    .await
    .expect("insert")
}

fn pick(item: &str, listing: &str, allocated: &str, quantity: i64, action: &str) -> Value {
    json!({ "action": action, "orderId": "9001", "orderCode": "CT9001", "itemId": item, "lineKey": format!("{item}@{allocated}"),
            "listingId": listing, "allocatedListingId": allocated, "quantity": quantity, "unitCents": 120, "currency": "eur" })
}

#[tokio::test]
async fn picks_move_inventory_once_and_undo_reverses_them() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    std::env::set_var("POKOIN_LISTING_SYNC_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_WEBHOOK_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_BOOK_WORKER", "0");
    std::env::set_var("POKOIN_READ_CACHE", "0");
    let admin = PgPoolOptions::new().max_connections(2).connect(&url).await.expect("test server");
    run_sql(&admin, "drop database if exists zero_picks_flow with (force)").await;
    run_sql(&admin, "create database zero_picks_flow").await;
    let (server, _) = url.rsplit_once('/').unwrap();
    let pool = PgPoolOptions::new().max_connections(6).connect(&format!("{server}/zero_picks_flow")).await.unwrap();
    run_sql(&pool, LISTINGS_SQL).await;
    run_sql(&pool, include_str!("../../../../scripts/sql/096_marketplace_outbox.sql")).await;
    run_sql(&pool, include_str!("../../../../scripts/sql/135_cardtrader_zero_picks.sql")).await;
    // Idempotent: applying it twice is fine.
    run_sql(&pool, include_str!("../../../../scripts/sql/135_cardtrader_zero_picks.sql")).await;

    let state = DomainState::with_pools(CommerceConfig::default(), pool.clone(), pool.clone(), None, Arc::new(UidToken), None);
    let app = pokoin_commerce::router(state);

    // --- finalize: the sale took the last copy of A; picking it clears its box.
    let a = insert(&pool, 0, "sold_out", "box·1·4", "ct:501", "NM").await;
    let multi = insert(&pool, 2, "active", "box·2", "ct:502", "NM").await;
    let before_stock = stock(&pool).await;
    let mark = last_outbox(&pool).await;
    let (status, body) = send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("11", &a, &a, 1, "pick"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["inventory"], "removed");
    assert_eq!(body["pick"]["kind"], "finalize");
    assert_eq!(body["pick"]["locationFrom"], "box·1·4");
    assert_eq!(body["pick"]["currency"], "EUR");
    assert_eq!(row(&pool, &a).await, (0, "sold_out".into(), String::new()));
    assert_eq!(stock(&pool).await, before_stock, "a finalize never moves stock");
    // The location clear is a plain update: no CardTrader edit.
    assert!(edits_since(&pool, mark).await.iter().all(|(_, edit, _)| edit.is_null()));

    // Replay / double click: same row, nothing new.
    let mark = last_outbox(&pool).await;
    let (_, again) = send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("11", &a, &a, 1, "pick"))).await;
    assert_eq!(again["inventory"], "unchanged");
    assert_eq!(again["pick"]["id"], body["pick"]["id"]);
    assert_eq!(last_outbox(&pool).await, mark);
    let picks: i64 = sqlx::query_scalar("select count(*) from public.cardtrader_zero_picks").fetch_one(&pool).await.unwrap();
    assert_eq!(picks, 1);

    // A multi-copy listing keeps its box.
    let (_, kept) = send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("12", &multi, &multi, 1, "pick"))).await;
    assert_eq!(kept["inventory"], "unchanged");
    assert_eq!(kept["pick"]["locationFrom"], "");
    assert_eq!(row(&pool, &multi).await, (2, "active".into(), "box·2".into()));

    // Undo finalize: the box comes back.
    let (_, undone) = send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("11", &a, &a, 1, "undo"))).await;
    assert_eq!(undone["inventory"], "restored", "{undone}");
    assert_eq!(undone["pick"]["state"], "undone");
    assert_eq!(row(&pool, &a).await.2, "box·1·4");
    // Undo of an undone row: a no-op.
    let (status, noop) = send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("11", &a, &a, 1, "undo"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(noop["inventory"], "unchanged");
    assert_eq!(noop["pick"], Value::Null);

    // --- swap: the sale took B (now 0); the seller picked 2 copies of C.
    let b = insert(&pool, 0, "sold_out", "box·5", "ct:601", "NM").await;
    let c = insert(&pool, 3, "active", "box·6", "ct:602", "NM").await;
    let before_stock = stock(&pool).await;
    let mark = last_outbox(&pool).await;
    let (status, swapped) = send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("21", &c, &b, 2, "pick"))).await;
    assert_eq!(status, StatusCode::OK, "{swapped}");
    assert_eq!(swapped["inventory"], "swapped");
    assert_eq!(swapped["listings"].as_array().unwrap().len(), 2);
    assert_eq!(row(&pool, &c).await, (1, "active".into(), "box·6".into()));
    assert_eq!(row(&pool, &b).await, (2, "active".into(), "box·5".into()));
    assert_eq!(stock(&pool).await, before_stock, "the sale already took the copy; the swap only moves it");
    let edits = edits_since(&pool, mark).await;
    assert_eq!(edits.len(), 2);
    assert_eq!(edits[0].0, c);
    assert_eq!(edits[0].1, json!({ "productId": "602", "quantityDelta": -2 }));
    assert_eq!(edits[1].0, b);
    assert_eq!(edits[1].1, json!({ "productId": "601", "quantityDelta": 2 }));
    assert_eq!(edits[1].2, "LISTING_REACTIVATED");
    // Replayed swap: no second delta.
    let mark = last_outbox(&pool).await;
    let (_, again) = send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("21", &c, &b, 2, "pick"))).await;
    assert_eq!(again["inventory"], "unchanged");
    assert_eq!(row(&pool, &c).await.0, 1);
    assert_eq!(last_outbox(&pool).await, mark);

    // The Picked page sends the stored allocated copy back.
    let (_, picked) = send(&app, "GET", "/api/cardtrader-zero-picked", None).await;
    let row21 = picked["rows"].as_array().unwrap().iter().find(|r| r["itemId"] == "21").unwrap().clone();
    assert_eq!(row21["allocatedListingId"], b.as_str());
    assert_eq!(row21["listingId"], c.as_str());

    // Undo swap: C +2, B −2. A client naming another copy is ignored: the
    // stored allocated copy (B) is the one restored.
    let decoy = insert(&pool, 5, "active", "box·8", "ct:604", "NM").await;
    let (_, undone) = send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("21", &c, &decoy, 2, "undo"))).await;
    assert_eq!(row(&pool, &decoy).await.0, 5, "the client's allocated id is never trusted");
    assert_eq!(undone["inventory"], "restored", "{undone}");
    assert_eq!(row(&pool, &c).await, (3, "active".into(), "box·6".into()));
    assert_eq!(row(&pool, &b).await, (0, "sold_out".into(), "box·5".into()));

    // Undo when the allocated copy was sold again: refused, nothing moves.
    send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("22", &c, &b, 1, "pick"))).await;
    sqlx::query("update public.marketplace_user_listings set quantity_available = 0, status = 'sold_out' where id = $1::uuid")
        .bind(&b)
        .execute(&pool)
        .await
        .unwrap();
    let (status, gone) = send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("22", &c, &b, 1, "undo"))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(gone["code"], "allocated_copy_gone");
    assert_eq!(row(&pool, &c).await.0, 2);

    // Quantity never below 0: picking more than C holds is refused.
    let (status, short) = send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("23", &c, &b, 5, "pick"))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(short["code"], "insufficient_quantity");
    assert_eq!(row(&pool, &c).await.0, 2);

    // Not the same card: refused.
    let d = insert(&pool, 1, "active", "box·7", "ct:603", "SP").await;
    let (status, other) = send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("24", &d, &b, 1, "pick"))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(other["code"], "not_identical");

    // Swapping the last copy of C empties its box too; undo puts it back.
    let (_, emptied) = send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("25", &c, &b, 2, "pick"))).await;
    assert_eq!(emptied["inventory"], "swapped");
    assert_eq!(row(&pool, &c).await, (0, "sold_out".into(), String::new()));
    send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("25", &c, &b, 2, "undo"))).await;
    assert_eq!(row(&pool, &c).await, (2, "active".into(), "box·6".into()));

    // An issue report never touches stock (Firestore is not configured here).
    let before_stock = stock(&pool).await;
    let mark = last_outbox(&pool).await;
    let (status, _) = send(&app, "POST", "/api/cardtrader-zero-pick",
        Some(json!({ "orderId": "9001", "lineKey": format!("21@{b}"), "issue": { "type": "missing" } }))).await;
    assert_ne!(status, StatusCode::OK);
    assert_eq!(stock(&pool).await, before_stock);
    assert_eq!(last_outbox(&pool).await, mark);

    // The Picked section: live picks, newest first, with the copy's card.
    let (status, picked) = send(&app, "GET", "/api/cardtrader-zero-picked", None).await;
    assert_eq!(status, StatusCode::OK, "{picked}");
    let rows = picked["rows"].as_array().unwrap();
    assert_eq!(rows.iter().map(|r| r["itemId"].as_str().unwrap()).collect::<Vec<_>>(), vec!["22", "12"]);
    assert_eq!(rows[0]["name"], "Pikachu");
    assert_eq!(rows[0]["expansion"], "Base Set");
    assert_eq!(rows[0]["kind"], "swap");
    assert_eq!(picked["nextOffset"], Value::Null);
    run_sql(&admin, "select 1").await;
}

#[tokio::test]
async fn concurrent_double_click_records_one_pick_and_one_delta() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    std::env::set_var("POKOIN_LISTING_SYNC_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_WEBHOOK_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_BOOK_WORKER", "0");
    std::env::set_var("POKOIN_READ_CACHE", "0");
    let admin = PgPoolOptions::new().max_connections(2).connect(&url).await.expect("test server");
    run_sql(&admin, "drop database if exists zero_picks_race with (force)").await;
    run_sql(&admin, "create database zero_picks_race").await;
    let (server, _) = url.rsplit_once('/').unwrap();
    let pool = PgPoolOptions::new().max_connections(8).connect(&format!("{server}/zero_picks_race")).await.unwrap();
    run_sql(&pool, LISTINGS_SQL).await;
    run_sql(&pool, include_str!("../../../../scripts/sql/096_marketplace_outbox.sql")).await;
    run_sql(&pool, include_str!("../../../../scripts/sql/135_cardtrader_zero_picks.sql")).await;
    let state = DomainState::with_pools(CommerceConfig::default(), pool.clone(), pool.clone(), None, Arc::new(UidToken), None);
    let app = pokoin_commerce::router(state);
    let b = insert(&pool, 0, "sold_out", "box·5", "ct:601", "NM").await;
    let c = insert(&pool, 3, "active", "box·6", "ct:602", "NM").await;
    let clicks = (0..4).map(|_| send(&app, "POST", "/api/cardtrader-zero-pick", Some(pick("31", &c, &b, 1, "pick"))));
    let answers = futures_util::future::join_all(clicks).await;
    assert!(answers.iter().all(|(status, _)| *status == StatusCode::OK), "{answers:?}");
    assert_eq!(answers.iter().filter(|(_, body)| body["inventory"] == "swapped").count(), 1);
    let ids: std::collections::HashSet<String> = answers.iter().map(|(_, body)| body["pick"]["id"].to_string()).collect();
    assert_eq!(ids.len(), 1, "every click answers the same row");
    assert_eq!(row(&pool, &c).await.0, 2);
    assert_eq!(row(&pool, &b).await.0, 1);
}

async fn claims_app(db: &str) -> Option<(PgPool, Router)> {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return None;
    };
    std::env::set_var("POKOIN_LISTING_SYNC_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_WEBHOOK_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_BOOK_WORKER", "0");
    std::env::set_var("POKOIN_READ_CACHE", "0");
    let admin = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("test server");
    run_sql(
        &admin,
        &format!("drop database if exists {db} with (force)"),
    )
    .await;
    run_sql(&admin, &format!("create database {db}")).await;
    let (server, _) = url.rsplit_once('/').unwrap();
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&format!("{server}/{db}"))
        .await
        .unwrap();
    run_sql(&pool, LISTINGS_SQL).await;
    run_sql(
        &pool,
        include_str!("../../../../scripts/sql/096_marketplace_outbox.sql"),
    )
    .await;
    run_sql(
        &pool,
        include_str!("../../../../scripts/sql/135_cardtrader_zero_picks.sql"),
    )
    .await;
    let state = DomainState::with_pools(
        CommerceConfig::default(),
        pool.clone(),
        pool.clone(),
        None,
        Arc::new(UidToken),
        None,
    );
    Some((pool, pokoin_commerce::router(state)))
}

async fn live_picks(pool: &PgPool) -> i64 {
    sqlx::query_scalar("select count(*) from public.cardtrader_zero_picks where state = 'picked'")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn one_copy_is_claimed_by_one_line_of_the_order() {
    let Some((pool, app)) = claims_app("zero_picks_claims").await else {
        return;
    };
    let post = |body: Value| send(&app, "POST", "/api/cardtrader-zero-pick", Some(body));

    // --- a swap took X's only copy, then the line X was the default of finalizes it.
    let x = insert(&pool, 1, "active", "box·X", "ct:701", "NM").await;
    let y = insert(&pool, 0, "sold_out", "box·Y", "ct:701", "NM").await;
    let (status, swapped) = post(pick("41", &x, &y, 1, "pick")).await;
    assert_eq!(status, StatusCode::OK, "{swapped}");
    assert_eq!(swapped["inventory"], "swapped");
    assert_eq!(row(&pool, &x).await, (0, "sold_out".into(), String::new()));
    let before = live_picks(&pool).await;
    let mark = last_outbox(&pool).await;
    let (status, refused) = post(pick("42", &x, &x, 1, "pick")).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["code"], "copy_already_picked");
    assert_eq!(
        refused["error"],
        "That box's copy was already picked for another line; choose another box"
    );
    // A swap out of it from a third line: the same code, not a plain shortage.
    let z = insert(&pool, 0, "sold_out", "box·Z", "ct:701", "NM").await;
    let (status, refused) = post(pick("43", &x, &z, 1, "pick")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(refused["code"], "copy_already_picked");
    // Retrying changes nothing either.
    let (status, again) = post(pick("42", &x, &x, 1, "pick")).await;
    assert_eq!(
        (status, again["code"].clone()),
        (StatusCode::CONFLICT, json!("copy_already_picked"))
    );
    assert_eq!(live_picks(&pool).await, before);
    assert_eq!(
        last_outbox(&pool).await,
        mark,
        "a refused claim writes nothing"
    );
    assert_eq!(row(&pool, &x).await.0, 0);
    // Line 41 undoes its swap: X has its copy again and line 42 may finalize it.
    let (_, undone) = post(pick("41", &x, &y, 1, "undo")).await;
    assert_eq!(undone["inventory"], "restored", "{undone}");
    let (status, finalized) = post(pick("42", &x, &x, 1, "pick")).await;
    assert_eq!(status, StatusCode::OK, "{finalized}");
    assert_eq!(finalized["pick"]["kind"], "finalize");

    // --- the first finalize of a sold-out box blocks every other line until undone.
    let s = insert(&pool, 0, "sold_out", "box·S", "ct:702", "NM").await;
    let (status, first) = post(pick("51", &s, &s, 1, "pick")).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let (status, second) = post(pick("52", &s, &s, 1, "pick")).await;
    assert_eq!(status, StatusCode::CONFLICT, "{second}");
    assert_eq!(second["code"], "copy_already_picked");
    // The same request again is a replay of the first line's row.
    let (status, replay) = post(pick("51", &s, &s, 1, "pick")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay["inventory"], "unchanged");
    assert_eq!(replay["pick"]["id"], first["pick"]["id"]);
    // Undo releases the copy (and its location) for the other line.
    let (_, undone) = post(pick("51", &s, &s, 1, "undo")).await;
    assert_eq!(undone["pick"]["state"], "undone");
    assert_eq!(row(&pool, &s).await.2, "box·S");
    let (status, taken_over) = post(pick("52", &s, &s, 1, "pick")).await;
    assert_eq!(status, StatusCode::OK, "{taken_over}");
    assert_eq!(taken_over["pick"]["lineKey"], format!("52@{s}"));

    // --- one item over two boxes (webhook allocation): its other line holding that copy is not a replay.
    let p = insert(&pool, 0, "sold_out", "box·P", "ct:703", "NM").await;
    let q = insert(&pool, 2, "active", "box·Q", "ct:703", "NM").await;
    let (status, own) = post(pick("61", &q, &q, 1, "pick")).await;
    assert_eq!(status, StatusCode::OK, "{own}");
    let (status, split) = post(pick("61", &q, &p, 1, "pick")).await;
    assert_eq!(status, StatusCode::CONFLICT, "{split}");
    assert_eq!(split["code"], "copy_already_picked");
    assert_eq!(row(&pool, &q).await.0, 2, "no swap moved stock");
    assert_eq!(row(&pool, &p).await.0, 0);

    // --- multi-copy: a line of 3 finalizes a sold-out box alone and holds all 3.
    let m = insert(&pool, 0, "sold_out", "box·M", "ct:704", "NM").await;
    let n = insert(&pool, 3, "active", "box·N", "ct:704", "NM").await;
    let (status, three) = post(pick("71", &m, &m, 3, "pick")).await;
    assert_eq!(status, StatusCode::OK, "{three}");
    assert_eq!(three["pick"]["quantity"], 3);
    let (status, refused) = post(pick("72", &m, &m, 1, "pick")).await;
    assert_eq!(
        (status, refused["code"].clone()),
        (StatusCode::CONFLICT, json!("copy_already_picked"))
    );
    // A swap of 2 out of the 3-copy box nobody else claimed is legitimate.
    let (status, moved) = post(pick("73", &n, &m, 2, "pick")).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(row(&pool, &n).await.0, 1);
    assert_eq!(row(&pool, &m).await.0, 2);
    // M shows 2 now, but line 71 holds 3 of it: still refused.
    let (status, refused) = post(pick("72", &m, &m, 1, "pick")).await;
    assert_eq!(
        (status, refused["code"].clone()),
        (StatusCode::CONFLICT, json!("copy_already_picked"))
    );
    let (_, _) = post(pick("71", &m, &m, 3, "undo")).await;
    let (status, freed) = post(pick("72", &m, &m, 1, "pick")).await;
    assert_eq!(status, StatusCode::OK, "{freed}");
}

#[tokio::test]
async fn two_lines_racing_for_one_sold_copy_get_one_pick() {
    let Some((pool, app)) = claims_app("zero_picks_claims_race").await else {
        return;
    };
    let x = insert(&pool, 0, "sold_out", "box·X", "ct:801", "NM").await;
    let clicks = ["81", "82", "83", "84"].map(|item| {
        send(
            &app,
            "POST",
            "/api/cardtrader-zero-pick",
            Some(pick(item, &x, &x, 1, "pick")),
        )
    });
    let answers = futures_util::future::join_all(clicks).await;
    assert_eq!(
        answers
            .iter()
            .filter(|(status, _)| *status == StatusCode::OK)
            .count(),
        1,
        "{answers:?}"
    );
    assert!(
        answers
            .iter()
            .filter(|(status, _)| *status != StatusCode::OK)
            .all(|(status, body)| *status == StatusCode::CONFLICT
                && body["code"] == "copy_already_picked"),
        "{answers:?}"
    );
    assert_eq!(live_picks(&pool).await, 1);
}

/// A copy with an explicit finish: the same card, condition and language as
/// [`insert`], another foil or variant state.
async fn insert_finish(
    pool: &PgPool,
    qty: i32,
    status: &str,
    location: &str,
    source: &str,
    foil: &str,
    variant: &str,
) -> String {
    sqlx::query_scalar(
        "insert into public.marketplace_user_listings (card_id, seller_uid, price_pkn, quantity_available, status, location, source_listing_id, condition, language, foil_state, variant_state, card_name, set_name, collector_number) \
         values ('202', 'seller-1', 100, $1, $2, $3, $4, 'NM', 'EN', $5, $6, 'Pikachu', 'Base Set', '58/102') returning id::text",
    )
    .bind(qty)
    .bind(status)
    .bind(location)
    .bind(source)
    .bind(foil)
    .bind(variant)
    .fetch_one(pool)
    .await
    .expect("insert")
}

#[tokio::test]
async fn one_line_picks_one_box_and_refuses_another() {
    let Some((pool, app)) = claims_app("zero_picks_one_line_one_box").await else {
        return;
    };
    let post = |body: Value| send(&app, "POST", "/api/cardtrader-zero-pick", Some(body));

    // One sold copy, two identical ones to pick it from. Line 91 takes box·A.
    let sold = insert(&pool, 0, "sold_out", "box·S", "ct:901", "NM").await;
    let first = insert(&pool, 1, "active", "box·A", "ct:901", "NM").await;
    let second = insert(&pool, 1, "active", "box·B", "ct:901", "NM").await;
    let (status, swapped) = post(pick("91", &first, &sold, 1, "pick")).await;
    assert_eq!(status, StatusCode::OK, "{swapped}");
    assert_eq!(swapped["inventory"], "swapped");
    assert_eq!(live_picks(&pool).await, 1);

    // The same line, another box: the line already has its copy.
    let before = live_picks(&pool).await;
    let mark = last_outbox(&pool).await;
    let (status, refused) = post(pick("91", &second, &sold, 1, "pick")).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["code"], "line_already_picked");
    assert_eq!(
        refused["error"],
        "This line was already picked from another box; undo it first"
    );
    assert_eq!(live_picks(&pool).await, before);
    assert_eq!(last_outbox(&pool).await, mark, "a refused pick writes nothing");
    assert_eq!(
        row(&pool, &second).await,
        (1, "active".into(), "box·B".into()),
        "the untouched box keeps its copy and its place"
    );
    assert_eq!(row(&pool, &first).await.0, 0, "the picked box holds line 91's copy");

    // The request that succeeded is a replay of its own copy, not a second pick.
    let (status, replay) = post(pick("91", &first, &sold, 1, "pick")).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["inventory"], "unchanged");
    assert_eq!(replay["pick"]["id"], swapped["pick"]["id"]);
    assert_eq!(live_picks(&pool).await, 1);

    // Undoing frees the line: box·B may carry it now, and still one row only.
    let (_, undone) = post(pick("91", &first, &sold, 1, "undo")).await;
    assert_eq!(undone["inventory"], "restored", "{undone}");
    let (status, moved) = post(pick("91", &second, &sold, 1, "pick")).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["inventory"], "swapped");
    assert_eq!(live_picks(&pool).await, 1, "one line, one live pick");
}

#[tokio::test]
async fn a_pick_must_be_a_copy_of_the_lines_own_finish() {
    let Some((pool, app)) = claims_app("zero_picks_finish").await else {
        return;
    };
    let post = |body: Value| send(&app, "POST", "/api/cardtrader-zero-pick", Some(body));

    // The order sold the plain printing of the product; the seller also owns a
    // reverse-holo, a stamped and a graded copy of the same card.
    let sold = insert_finish(&pool, 0, "sold_out", "box·S", "ct:911", "standard", "").await;
    let reverse = insert_finish(&pool, 1, "active", "box·R", "ct:911", "reverse", "").await;
    let stamp = insert_finish(&pool, 1, "active", "box·T", "ct:911", "standard", "stamp").await;
    let graded = {
        let id = insert_finish(&pool, 1, "active", "box·G", "ct:911", "standard", "").await;
        sqlx::query("update public.marketplace_user_listings set graded = true where id = $1::uuid")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();
        id
    };
    for other in [&reverse, &stamp, &graded] {
        let (status, body) = post(pick("95", other, &sold, 1, "pick")).await;
        assert_eq!(status, StatusCode::CONFLICT, "{other} is another card: {body}");
        assert_eq!(body["code"], "not_identical");
    }
    assert_eq!(live_picks(&pool).await, 0, "a refused finish writes nothing");
    for other in [&reverse, &stamp, &graded] {
        let (quantity, status, _) = row(&pool, other).await;
        assert_eq!(
            (quantity, status.as_str()),
            (1, "active"),
            "the refused copy is untouched"
        );
    }
    // A copy of the sold printing is the swap the line may make.
    let plain = insert_finish(&pool, 1, "active", "box·P", "ct:911", "standard", "").await;
    let (status, swapped) = post(pick("95", &plain, &sold, 1, "pick")).await;
    assert_eq!(status, StatusCode::OK, "{swapped}");
    assert_eq!(swapped["inventory"], "swapped");
    assert_eq!(row(&pool, &plain).await.0, 0);
}
