//! The stock CSV route against a real Postgres: what an APPLY stores for a
//! location that ends in a number.
//!
//! `POST /api/marketplace-listings-csv` reads locations through the legacy
//! allocator (`stock_csv::assign_stack_positions`), never through the Power
//! Tools detector, and it builds `ImportOptions` without `power_tools_sync`. So
//! this route has no reading to guess: `Focobomba 006` is stored as the box
//! `Focobomba 006` with an assigned slot. That is the property this test holds
//! on — if someone wires Power Tools detection into the route without the
//! box-name confirmation, the stored box becomes `Focobomba` and this fails.
//!
//! Needs a throwaway server (the test drops and recreates its own database):
//!
//! ```text
//! docker run -d --rm --name pokoin-stock-csv-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55498:5432 --tmpfs /var/lib/postgresql postgres:19.0-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55498/postgres \
//!   cargo test -p pokoin-commerce --test stock_csv_location_flow
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
";

const CARDS_SQL: &str = "
create table public.marketplace_cards (
  card_id text primary key,
  name text not null,
  set_name text not null default '',
  card_number text not null default '',
  image_url text not null default '',
  cdn_image_url text not null default ''
);
insert into public.marketplace_cards (card_id, name, set_name, card_number) values
  ('202', 'Pikachu', 'Base Set', '58/102');
";

/// Two boxes whose name ends in a number, and a third copy in the first box.
const CSV: &str = "cardmarketId,quantity,name,set,cn,condition,language,price,location\n\
    1,1,Pikachu,Base Set,58/102,NM,English,100,Focobomba 006\n\
    2,1,Pikachu,Base Set,58/102,NM,English,100,Focobomba 007\n\
    3,1,Pikachu,Base Set,58/102,NM,English,100,Focobomba 006\n";

struct UidToken;

#[async_trait]
impl TokenVerifier for UidToken {
    async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        if token.is_empty() {
            return Err(AuthError::Invalid("empty".into()));
        }
        Ok(Claims {
            uid: token.into(),
            ..Default::default()
        })
    }
}

async fn run_sql(pool: &PgPool, sql: &str) {
    sqlx::raw_sql(sql).execute(pool).await.expect("schema");
}

/// A fresh database with the two tables this route touches, and its router.
async fn setup() -> Option<(PgPool, Router)> {
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
        "drop database if exists stock_csv_location_flow with (force)",
    )
    .await;
    run_sql(&admin, "create database stock_csv_location_flow").await;
    let (server, _) = url.rsplit_once('/').expect("database url");
    let pool = PgPoolOptions::new()
        .max_connections(6)
        .connect(&format!("{server}/stock_csv_location_flow"))
        .await
        .expect("connect");
    run_sql(&pool, LISTINGS_SQL).await;
    run_sql(&pool, CARDS_SQL).await;
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

async fn import(app: &Router, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri("/api/marketplace-listings-csv")
        .header("authorization", "Bearer seller-1")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.expect("router");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Every stored location of this seller, in import order.
async fn locations(pool: &PgPool) -> Vec<String> {
    sqlx::query_scalar(
        "select location from public.marketplace_user_listings \
          where seller_uid = 'seller-1' order by source_listing_id",
    )
    .fetch_all(pool)
    .await
    .expect("locations")
}

#[tokio::test]
async fn an_apply_keeps_a_box_name_that_ends_in_a_number_whole() {
    let Some((pool, app)) = setup().await else {
        return;
    };
    let (status, body) = import(
        &app,
        json!({ "csv": CSV, "dryRun": false, "priceMode": "as_pkn" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["counts"]["created"], 3, "{body}");
    let stored = locations(&pool).await;
    assert_eq!(
        stored,
        vec![
            "Focobomba 006·1·1",
            "Focobomba 007·1·1",
            "Focobomba 006·2·1",
        ],
        "the route assigns slots inside the box the seller named; it never cuts \
         the number off the box name, so there is no reading to confirm here"
    );

    // A dry run of the same rows writes nothing, and says the same thing.
    let (status, body) = import(
        &app,
        json!({ "csv": CSV, "dryRun": true, "priceMode": "as_pkn" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["counts"]["preview"], 3, "{body}");
    assert_eq!(body["counts"]["created"], 0, "{body}");
    assert_eq!(
        locations(&pool).await,
        stored,
        "a dry run writes no listing row"
    );
}
