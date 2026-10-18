//! MyPokoin book stamp on a real Postgres: the first page of the owner's
//! whole book carries `stamp`, `stamp=1` answers it alone, and an edit or a
//! delete moves it, so a cached book revalidates with one index read.
//! `order=price-desc` serves the book dearest first.
//!
//! ```text
//! docker run -d --rm --name pokoin-seller-api-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55473:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55473/postgres \
//!   cargo test -p pokoin-commerce --test owner_book_stamp_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped. It drops and
//! recreates its tables (the same ones as `seller_snapshot_flow`).

use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

use pokoin_commerce::auth::{AuthError, Claims, TokenVerifier};
use pokoin_commerce::config::CommerceConfig;
use pokoin_commerce::state::DomainState;

const SCHEMA: &str = "
drop table if exists public.marketplace_user_listings, public.marketplace_search_candidates cascade;
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
insert into public.marketplace_search_candidates values
  (10, 'Rare | 119/214', 'Card', 'card', 'single'), (12, '4/102', 'Common', 'card', 'single');
insert into public.marketplace_user_listings (card_id, seller_uid, seller_name, price_pkn, quantity_available, card_name, updated_at) values
  ('10', 'u1', 'alice', 400, 3, 'Espurr', '2026-10-18T10:00:00.123Z'),
  ('12', 'u1', 'alice', 200, 1, 'Pikachu', '2026-10-18T09:00:00Z'),
  ('10', 'u2', 'bob', 100, 9, 'Other seller', '2026-10-18T11:00:00Z');
";

/// The bearer is the uid.
struct UidToken;
#[async_trait]
impl TokenVerifier for UidToken {
    async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        Ok(serde_json::from_value(json!({ "uid": token })).unwrap())
    }
}

async fn get(state: &DomainState, query: &str, bearer: &str) -> (StatusCode, String, Value) {
    let request = Request::builder()
        .uri(format!("/api/marketplace-listings?{query}"))
        .header("authorization", format!("Bearer {bearer}"))
        .body(Body::empty())
        .unwrap();
    let response = pokoin_commerce::router(state.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let cache = response
        .headers()
        .get("cache-control")
        .map(|value| value.to_str().unwrap().to_owned())
        .unwrap_or_default();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, cache, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn the_owner_book_stamp_moves_with_every_change() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.expect("test database");
    sqlx::raw_sql(SCHEMA).execute(&pool).await.expect("schema");
    let state = DomainState::with_pools(CommerceConfig::default(), pool.clone(), pool.clone(), None, Arc::new(UidToken), None);

    // The whole-book first page carries the stamp; it is private.
    let (status, cache, page) = get(&state, "sellerUid=u1&nativeOnly=1&limit=200", "u1").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(cache, "private, no-store");
    assert_eq!(page["listings"].as_array().unwrap().len(), 2);
    assert_eq!(page["stamp"], "2:2026-10-18T10:00:00.123Z");

    // stamp=1 answers the same value alone.
    let (status, cache, alone) = get(&state, "sellerUid=u1&stamp=1", "u1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cache, "private, no-store");
    assert_eq!(alone, json!({ "stamp": "2:2026-10-18T10:00:00.123Z" }));

    // order=price-desc serves the dearest rows first (MyPokoin's default sort).
    let names = |page: &Value| page["listings"].as_array().unwrap().iter().map(|row| row["cardName"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(names(&page), ["Pikachu", "Espurr"]);
    let (_, _, desc) = get(&state, "sellerUid=u1&nativeOnly=1&limit=200&order=price-desc", "u1").await;
    assert_eq!(names(&desc), ["Espurr", "Pikachu"]);
    assert_eq!(desc["stamp"], page["stamp"]);

    // Later pages and single reads carry no stamp.
    let (_, _, later) = get(&state, "sellerUid=u1&nativeOnly=1&limit=1&offset=1", "u1").await;
    assert!(later.get("stamp").is_none());

    // Another seller's stamp is not readable.
    let (status, _, _) = get(&state, "sellerUid=u2&stamp=1", "u1").await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // An edit moves max(updated_at); a delete moves the count.
    sqlx::query("update public.marketplace_user_listings set price_pkn = 210, updated_at = '2026-10-18T12:00:00Z' where card_name = 'Pikachu'")
        .execute(&pool)
        .await
        .unwrap();
    let (_, _, edited) = get(&state, "sellerUid=u1&stamp=1", "u1").await;
    assert_eq!(edited["stamp"], "2:2026-10-18T12:00:00.000Z");
    sqlx::query("delete from public.marketplace_user_listings where card_name = 'Espurr'")
        .execute(&pool)
        .await
        .unwrap();
    let (_, _, deleted) = get(&state, "sellerUid=u1&stamp=1", "u1").await;
    assert_eq!(deleted["stamp"], "1:2026-10-18T12:00:00.000Z");
}
