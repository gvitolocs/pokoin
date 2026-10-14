//! Stored seller books on a real Postgres: built once, served stale while a
//! change is rebuilt behind the request, and picked up by the sweep.
//!
//! ```text
//! docker run -d --rm --name pokoin-seller-api-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55473:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55473/postgres \
//!   cargo test -p pokoin-commerce --test seller_book_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped. It drops and
//! recreates its tables.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use pokoin_api_common::compact::decode::decode;
use pokoin_commerce::auth::{AuthError, Claims, TokenVerifier};
use pokoin_commerce::config::CommerceConfig;
use pokoin_commerce::handlers::seller::Seller;
use pokoin_commerce::handlers::seller_book;
use pokoin_commerce::state::DomainState;

const SCHEMA: &str = "
drop table if exists public.marketplace_seller_books, public.marketplace_user_listings,
  public.marketplace_search_candidates, public.cardtrader_pokemon_blueprints cascade;
create table public.marketplace_user_listings (
  id uuid primary key default gen_random_uuid(),
  card_id text not null,
  seller_uid text not null,
  seller_name text not null default 'Pokoin seller',
  seller_country text not null default 'IT',
  marketplace_game text not null default 'pokemon',
  condition text not null default 'NM',
  language text not null default 'EN',
  price_pkn numeric not null,
  quantity_available integer not null default 1,
  signed boolean not null default false,
  reverse boolean not null default false,
  first_edition boolean not null default false,
  altered boolean not null default false,
  foil_state text not null default 'standard',
  variant_state text not null default '',
  sealed boolean not null default false,
  graded boolean not null default false,
  shipping_available boolean not null default true,
  card_name text not null default '',
  card_image_url text not null default '',
  set_name text not null default '',
  collector_number text not null default '',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.marketplace_search_candidates (
  card_id bigint primary key, card_number text, rarity text, product_type text, item_kind text);
create table public.cardtrader_pokemon_blueprints (id bigint primary key, category_id integer, blueprint jsonb);
insert into public.marketplace_search_candidates values
  (10, 'Rare | 119/214', 'Card', 'card', 'single'), (12, '4/102', 'Common', 'card', 'single'),
  (14, '1/1', 'Card', 'sealed', 'booster');
insert into public.marketplace_user_listings (card_id, seller_uid, price_pkn, quantity_available, card_name, updated_at) values
  ('10', 'u1', 400, 3, 'Espurr', now() - interval '3 hours'),
  ('12', 'u1', 200, 1, 'Pikachu', now() - interval '2 hours'),
  ('14', 'u1', 900, 1, 'A booster, not a single', now() - interval '2 hours'),
  ('10', 'u2', 100, 9, 'Someone else', now());
";

struct NoSignIn;
#[async_trait]
impl TokenVerifier for NoSignIn {
    async fn verify(&self, _token: &str) -> Result<Claims, AuthError> {
        Err(AuthError::Missing)
    }
}

/// The stamp the API reads for a seller: max(updated_at), RFC 3339 with milliseconds.
async fn stamp(pool: &PgPool, uid: &str) -> String {
    sqlx::query_scalar(
        "select to_char(max(updated_at) at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
         from public.marketplace_user_listings where seller_uid = $1",
    )
    .bind(uid)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn open(body: &[u8]) -> Value {
    decode(&serde_json::from_slice(body).unwrap()).unwrap()
}

async fn stored_stamp(pool: &PgPool) -> String {
    sqlx::query_scalar("select stamp from public.marketplace_seller_books where seller_uid = 'u1' and game = 'pokemon'")
        .fetch_optional(pool)
        .await
        .unwrap()
        .unwrap_or_default()
}

async fn wait_for_stamp(pool: &PgPool, wanted: &str) {
    for _ in 0..100 {
        if stored_stamp(pool).await == wanted {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the stored book never reached stamp {wanted}; it is at {}", stored_stamp(pool).await);
}

fn quantities(book: &Value) -> Vec<(String, i64)> {
    book["listings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| (row["cardName"].as_str().unwrap().to_string(), row["quantityAvailable"].as_i64().unwrap()))
        .collect()
}

#[tokio::test]
async fn a_book_is_stored_served_stale_and_rebuilt_behind_the_request() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = PgPoolOptions::new().max_connections(6).connect(&url).await.expect("test database");
    sqlx::raw_sql(SCHEMA).execute(&pool).await.expect("schema");
    sqlx::raw_sql(include_str!("../../../../scripts/sql/116_marketplace_seller_books.sql"))
        .execute(&pool)
        .await
        .expect("migration 116");
    let state = DomainState::with_pools(CommerceConfig::default(), pool.clone(), pool.clone(), None, Arc::new(NoSignIn), None);
    let alice = Seller { uid: "u1".into(), username: "alice".into(), display_name: "Alice".into(), accepts_pkn: true };

    // --- the first request builds the book and stores it --------------------
    let first_stamp = stamp(&pool, "u1").await;
    let body = seller_book::serve(&state, &alice, "pokemon", &first_stamp).await.unwrap();
    let book = open(&body);
    assert_eq!(book["book"], true);
    assert_eq!(book["maxUpdatedAt"], first_stamp.as_str());
    // Singles only, cheapest first, this seller only.
    assert_eq!(quantities(&book), vec![("Pikachu".to_string(), 1), ("Espurr".to_string(), 3)]);
    assert_eq!(book["listings"][0]["rarity"], "Common");
    assert_eq!(book["listings"][1]["rarity"], "Rare");
    assert_eq!(book["seller"]["displayName"], "Alice");
    assert_eq!(stored_stamp(&pool).await, first_stamp);
    let listings: i32 = sqlx::query_scalar("select listings from public.marketplace_seller_books").fetch_one(&pool).await.unwrap();
    assert_eq!(listings, 2);
    // Nothing changed: there is nothing to rebuild.
    assert!(!seller_book::rebuild(&state, &alice, "pokemon").await.unwrap());
    assert_eq!(seller_book::sweep_once(&state).await.unwrap(), 0);

    // --- a listing changes: the request gets the stored book at once --------
    sqlx::query("update public.marketplace_user_listings set quantity_available = 2, updated_at = now() where card_name = 'Espurr'")
        .execute(&pool)
        .await
        .unwrap();
    let second_stamp = stamp(&pool, "u1").await;
    assert_ne!(second_stamp, first_stamp);
    let stale = open(&seller_book::serve(&state, &alice, "pokemon", &second_stamp).await.unwrap());
    assert_eq!(stale["maxUpdatedAt"], first_stamp.as_str(), "the request did not wait for a rebuild");
    assert_eq!(quantities(&stale)[1], ("Espurr".to_string(), 3));
    // ...and its replacement is built behind it.
    wait_for_stamp(&pool, &second_stamp).await;
    let fresh = open(&seller_book::serve(&state, &alice, "pokemon", &second_stamp).await.unwrap());
    assert_eq!(fresh["maxUpdatedAt"], second_stamp.as_str());
    assert_eq!(quantities(&fresh)[1], ("Espurr".to_string(), 2));

    // --- a change nobody requested is found by the sweep --------------------
    sqlx::query("update public.marketplace_user_listings set status = 'sold_out', quantity_available = 0, updated_at = now() + interval '1 second' where card_name = 'Pikachu'")
        .execute(&pool)
        .await
        .unwrap();
    let third_stamp = stamp(&pool, "u1").await;
    assert_eq!(seller_book::sweep_once(&state).await.unwrap(), 1);
    wait_for_stamp(&pool, &third_stamp).await;
    let swept = open(&seller_book::serve(&state, &alice, "pokemon", &third_stamp).await.unwrap());
    assert_eq!(quantities(&swept), vec![("Espurr".to_string(), 2)]);

    // --- a listing change seen by the outbox rebuilds without a request -----
    sqlx::query("update public.marketplace_user_listings set price_pkn = 50, updated_at = now() + interval '2 seconds' where card_name = 'Espurr'")
        .execute(&pool)
        .await
        .unwrap();
    let fourth_stamp = stamp(&pool, "u1").await;
    seller_book::kick_seller(&state, "u1");
    wait_for_stamp(&pool, &fourth_stamp).await;
    seller_book::kick_seller(&state, "nobody");

    // --- the seller's name is in every row: renaming rebuilds too -----------
    let renamed = Seller { display_name: "Alice Cards".into(), ..alice.clone() };
    let before = open(&seller_book::serve(&state, &renamed, "pokemon", &fourth_stamp).await.unwrap());
    assert_eq!(before["seller"]["displayName"], "Alice", "the stored book, at once");
    for _ in 0..100 {
        let profile: String = sqlx::query_scalar("select profile from public.marketplace_seller_books").fetch_one(&pool).await.unwrap();
        if profile == seller_book::profile_of(&renamed) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let after = open(&seller_book::serve(&state, &renamed, "pokemon", &fourth_stamp).await.unwrap());
    assert_eq!(after["seller"]["displayName"], "Alice Cards");
    assert_eq!(after["listings"][0]["sellerName"], "Alice Cards");
    assert_eq!(after["listings"][0]["pricePkn"], 50.0);

    // One row per seller and game, however many rebuilds.
    let books: i64 = sqlx::query_scalar("select count(*) from public.marketplace_seller_books").fetch_one(&pool).await.unwrap();
    assert_eq!(books, 1);

    // --- without the table, a request still gets its book -------------------
    sqlx::raw_sql("drop table public.marketplace_seller_books").execute(&pool).await.unwrap();
    let bob = Seller { uid: "u2".into(), username: "bob".into(), display_name: "Bob".into(), accepts_pkn: true };
    let unstored = open(&seller_book::serve(&state, &bob, "pokemon", &stamp(&pool, "u2").await).await.unwrap());
    assert_eq!(quantities(&unstored), vec![("Someone else".to_string(), 9)]);
    assert!(!seller_book::rebuild(&state, &bob, "pokemon").await.unwrap());
}
