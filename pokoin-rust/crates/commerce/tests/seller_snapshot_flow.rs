//! Seller shop snapshots on a real Postgres: the k3s builder (`build_all`)
//! writes the brotli copy, handle and header; a rebuild in an API instance
//! keeps the header and leaves the copy for the next run; `fresh=1` compares
//! the live stamp with the stored book; a database without migration 119
//! still stores books.
//!
//! ```text
//! docker run -d --rm --name pokoin-seller-api-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55473:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55473/postgres \
//!   cargo test -p pokoin-commerce --test seller_snapshot_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped. It drops and
//! recreates its tables (the same ones as `seller_book_flow`).

use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tower::ServiceExt;

use pokoin_api_common::compact::decode::decode;
use pokoin_commerce::auth::{AuthError, Claims, TokenVerifier};
use pokoin_commerce::config::CommerceConfig;
use pokoin_commerce::ApiError;
use pokoin_commerce::handlers::seller::{Seller, ShopHeader};
use pokoin_commerce::handlers::seller_book::{self, SellerDirectory};
use pokoin_commerce::state::DomainState;

const SCHEMA: &str = "
drop table if exists public.marketplace_seller_books, public.marketplace_user_listings,
  public.marketplace_search_candidates, public.cardtrader_pokemon_blueprints cascade;
create table public.marketplace_user_listings (
  id uuid primary key default gen_random_uuid(), card_id text not null, seller_uid text not null,
  seller_name text not null default 'Pokoin seller', seller_country text not null default 'IT',
  marketplace_game text not null default 'pokemon', condition text not null default 'NM',
  language text not null default 'EN', price_pkn numeric not null, quantity_available integer not null default 1,
  signed boolean not null default false, reverse boolean not null default false,
  first_edition boolean not null default false, altered boolean not null default false,
  foil_state text not null default 'standard', variant_state text not null default '',
  sealed boolean not null default false, graded boolean not null default false,
  shipping_available boolean not null default true, card_name text not null default '',
  card_image_url text not null default '', set_name text not null default '',
  collector_number text not null default '', status text not null default 'active',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.marketplace_search_candidates (
  card_id bigint primary key, card_number text, rarity text, product_type text, item_kind text);
create table public.cardtrader_pokemon_blueprints (id bigint primary key, category_id integer, blueprint jsonb);
insert into public.marketplace_search_candidates values
  (10, 'Rare | 119/214', 'Card', 'card', 'single'), (12, '4/102', 'Common', 'card', 'single');
insert into public.marketplace_user_listings (card_id, seller_uid, seller_name, price_pkn, quantity_available, card_name, updated_at) values
  ('10', 'u1', 'alice', 400, 3, 'Espurr', now() - interval '3 hours'),
  ('12', 'u1', 'alice', 200, 1, 'Pikachu', now() - interval '2 hours'),
  ('10', 'u2', 'Some One', 100, 9, 'No handle', now());
";

const MIGRATION_116: &str = include_str!("../../../../scripts/sql/116_marketplace_seller_books.sql");
const MIGRATION_119: &str = include_str!("../../../../scripts/sql/119_seller_book_snapshots.sql");

struct NoSignIn;
#[async_trait]
impl TokenVerifier for NoSignIn {
    async fn verify(&self, _token: &str) -> Result<Claims, AuthError> {
        Err(AuthError::Missing)
    }
}

fn alice() -> Seller {
    Seller { uid: "u1".into(), username: "alice".into(), display_name: "Alice".into(), accepts_pkn: true }
}

/// u1 is alice with a photo and a country; u2 has no public handle.
struct Directory;
#[async_trait]
impl SellerDirectory for Directory {
    async fn seller(&self, uid: &str, _listing_name: &str) -> Result<Option<Seller>, ApiError> {
        Ok((uid == "u1").then(alice))
    }
    async fn header(&self, _uid: &str) -> ShopHeader {
        ShopHeader { photo_url: Some("https://x.test/alice.png".into()), country: Some("IT".into()) }
    }
}

/// Stands in for brotli 11: any recognisable transform of the bytes.
fn reversed(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().rev().copied().collect()
}

struct Row {
    stamp: String,
    username: Option<String>,
    version: Option<String>,
    body: Vec<u8>,
    br: Option<Vec<u8>>,
    seller: Value,
}

async fn stored(pool: &PgPool) -> Option<Row> {
    sqlx::query_as::<_, (String, Option<String>, Option<String>, Vec<u8>, Option<Vec<u8>>, Value)>(
        "select stamp, username, version, body, br, seller from public.marketplace_seller_books where seller_uid = 'u1'",
    )
    .fetch_optional(pool)
    .await
    .unwrap()
    .map(|(stamp, username, version, body, br, seller)| Row { stamp, username, version, body, br, seller })
}

fn open(body: &[u8]) -> Value {
    decode(&serde_json::from_slice(body).unwrap()).unwrap()
}

async fn fresh(state: &DomainState, query: &str) -> (Value, String) {
    let request = Request::builder()
        .uri(format!("/api/marketplace-seller-shop?sellerUsername=alice&fresh=1{query}"))
        .body(Body::empty())
        .unwrap();
    let response = pokoin_commerce::router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cache = response.headers()["cache-control"].to_str().unwrap().to_owned();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (serde_json::from_slice(&bytes).unwrap(), cache)
}

#[tokio::test]
async fn the_builder_writes_snapshots_and_fresh_reports_their_stamp() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = PgPoolOptions::new().max_connections(6).connect(&url).await.expect("test database");
    sqlx::raw_sql(SCHEMA).execute(&pool).await.expect("schema");
    sqlx::raw_sql(MIGRATION_116).execute(&pool).await.expect("migration 116");
    let state = DomainState::with_pools(CommerceConfig::default(), pool.clone(), pool.clone(), None, Arc::new(NoSignIn), None);

    // --- an API deployed before migration 119 still stores its books --------
    let stamp: String = sqlx::query_scalar(
        "select to_char(max(updated_at) at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
         from public.marketplace_user_listings where seller_uid = 'u1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    seller_book::serve(&state, &alice(), "pokemon", &stamp).await.unwrap();
    let count: i64 = sqlx::query_scalar("select count(*) from public.marketplace_seller_books").fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1, "stored with the 116 statement");

    // --- the builder: applies 119, writes the copy, the handle and the header
    let built = seller_book::build_all(&state, &Directory, reversed, None, false, false).await.unwrap();
    assert_eq!((built.sellers, built.built, built.failed), (2, 1, 0), "{built:?}: u2 has no handle");
    let row = stored(&pool).await.unwrap();
    assert_eq!(row.stamp, stamp);
    assert_eq!(row.username.as_deref(), Some("alice"));
    assert_eq!(row.version.as_deref(), Some(seller_book::version_of(&row.body).as_str()));
    assert_eq!(row.br.as_deref(), Some(reversed(&row.body).as_slice()));
    assert_eq!(row.seller["photoUrl"], "https://x.test/alice.png");
    let book = open(&row.body);
    assert_eq!(book["seller"]["photoUrl"], "https://x.test/alice.png");
    assert_eq!(book["seller"]["country"], "IT");
    assert_eq!(book["maxUpdatedAt"], stamp.as_str());
    assert_eq!(book["listings"].as_array().unwrap().len(), 2);
    assert_eq!((book["unique"].as_i64(), book["copies"].as_i64()), (Some(2), Some(4)));

    // Nothing moved: the next run skips alice after one profile read.
    let again = seller_book::build_all(&state, &Directory, reversed, None, false, false).await.unwrap();
    assert_eq!((again.built, again.skipped), (0, 1));

    // --- fresh=1: the live stamp equals the stored book's --------------------
    let (now, cache) = fresh(&state, "&sellerUid=u1").await;
    assert!(cache.starts_with("public,") && cache.contains("s-maxage=10"), "{cache}");
    assert_eq!(now["maxUpdatedAt"], stamp.as_str());
    assert_eq!(now["book"]["stamp"], stamp.as_str());
    assert_eq!(now["book"]["version"], row.version.clone().unwrap().as_str());
    // Without sellerUid the stored book names the seller: no profile lookup.
    let (by_handle, _) = fresh(&state, "").await;
    assert_eq!(by_handle["sellerUid"], "u1");

    // --- a listing moves: fresh=1 says so before any rebuild -----------------
    sqlx::query("update public.marketplace_user_listings set quantity_available = 2, updated_at = now() where card_name = 'Espurr'")
        .execute(&pool)
        .await
        .unwrap();
    let (moved, _) = fresh(&state, "&sellerUid=u1").await;
    assert_ne!(moved["maxUpdatedAt"], stamp.as_str());
    assert_eq!(moved["book"]["stamp"], stamp.as_str(), "the stored book is still the old one");

    // An API instance rebuilds: the header stays, the copy waits for the builder.
    assert!(seller_book::rebuild(&state, &alice(), "pokemon").await.unwrap());
    let rebuilt = stored(&pool).await.unwrap();
    assert_eq!(rebuilt.stamp, moved["maxUpdatedAt"].as_str().unwrap());
    assert!(rebuilt.br.is_none());
    assert_ne!(rebuilt.version, row.version);
    assert_eq!(open(&rebuilt.body)["seller"]["photoUrl"], "https://x.test/alice.png");
    let (after, _) = fresh(&state, "&sellerUid=u1").await;
    assert_eq!(after["book"]["stamp"], after["maxUpdatedAt"]);

    // ...and the next builder run writes it.
    let filled = seller_book::build_all(&state, &Directory, reversed, None, false, false).await.unwrap();
    assert_eq!(filled.built, 1);
    let filled_row = stored(&pool).await.unwrap();
    assert_eq!(filled_row.br.as_deref(), Some(reversed(&filled_row.body).as_slice()));

    // --- a seller with no listing row left has no shop -----------------------
    sqlx::query("delete from public.marketplace_user_listings where seller_uid = 'u1'").execute(&pool).await.unwrap();
    let gone = seller_book::build_all(&state, &Directory, reversed, None, false, false).await.unwrap();
    assert_eq!(gone.removed, 1);
    assert!(stored(&pool).await.is_none());
    sqlx::raw_sql(MIGRATION_119).execute(&pool).await.expect("119 is idempotent");
}
