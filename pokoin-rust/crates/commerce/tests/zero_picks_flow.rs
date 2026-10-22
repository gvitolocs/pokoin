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
