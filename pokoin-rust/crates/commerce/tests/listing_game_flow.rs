//! A new listing is stored under the catalog that holds its card, not under
//! whatever game the client tagged it with. On 2026-10-16 Card Rails sent 41
//! Battle Spirits Saga cards tagged `pokemon` through the seller API; the
//! stock board then priced them from the Pokémon catalog and linked them to
//! Pokémon desks.
//!
//! Real Postgres: the shared marketplace database plus two satellite catalogs
//! that share one 200000000+ synthetic id, as Battle Spirits Saga and World of
//! Warcraft do live. Needs a throwaway server (the test drops and recreates
//! its own databases):
//!
//! ```text
//! docker run -d --rm --name pokoin-seller-api-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55473:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55473/postgres \
//!   cargo test -p pokoin-commerce --test listing_game_flow
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

const CATALOG_SQL: &str = "
create table public.marketplace_search_candidates (
  card_id bigint primary key,
  name text,
  set_name text
);
";

struct UidToken;
#[async_trait]
impl TokenVerifier for UidToken {
    /// The sign-in token is the uid; a `pkn_` grant is never a sign-in.
    async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        if token.is_empty() || token.starts_with("pkn_") {
            return Err(AuthError::Invalid("not a sign-in token".into()));
        }
        Ok(Claims { uid: token.into(), ..Default::default() })
    }
}

async fn run_sql(pool: &PgPool, sql: &str) {
    sqlx::raw_sql(sql).execute(pool).await.expect("schema");
}

/// A fresh database next to `url`, with its URL and a pool on it.
async fn fresh_database(admin: &PgPool, url: &str, name: &str) -> (String, PgPool) {
    run_sql(admin, &format!("drop database if exists {name} with (force)")).await;
    run_sql(admin, &format!("create database {name}")).await;
    let (server, _) = url.rsplit_once('/').expect("database url has a path");
    let url = format!("{server}/{name}");
    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.expect("fresh database");
    (url, pool)
}

async fn call(app: &Router, path: &str, bearer: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("authorization", format!("Bearer {bearer}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.expect("router");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn game_of(pool: &PgPool, id: &Value) -> String {
    sqlx::query_scalar("select marketplace_game from public.marketplace_user_listings where id = $1::uuid")
        .bind(id.as_str().expect("listing id"))
        .fetch_one(pool)
        .await
        .expect("listing row")
}

async fn listings(pool: &PgPool) -> i64 {
    sqlx::query_scalar("select count(*) from public.marketplace_user_listings").fetch_one(pool).await.unwrap()
}

/// An unpriced, paused stock row, as Card Rails sends them.
fn stock(card: &str, name: &str, game: &str) -> Value {
    json!({"cardId": card, "cardName": name, "sellerCountry": "IT", "pricePkn": 0, "status": "paused",
        "quantityAvailable": 1, "shippingAvailable": false, "marketplaceGame": game})
}

#[tokio::test]
async fn a_listing_is_stored_under_the_catalog_that_holds_its_card() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    std::env::set_var("POKOIN_LISTING_SYNC_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_WEBHOOK_WORKER", "0");
    std::env::set_var("POKOIN_READ_CACHE", "0");
    std::env::set_var("CARDTRADER_TOKEN_ENCRYPTION_KEY", "11".repeat(32));
    // Only the two catalogs below are mounted, whatever the shell exports.
    for (_, env) in pokoin_commerce::game::SATELLITE_GAMES {
        std::env::remove_var(env);
    }

    let admin = PgPoolOptions::new().max_connections(2).connect(&url).await.expect("test server");
    let (_, main) = fresh_database(&admin, &url, "pokoin_listing_game_main").await;
    let (bss_url, bss) = fresh_database(&admin, &url, "pokoin_listing_game_bss").await;
    let (wow_url, wow) = fresh_database(&admin, &url, "pokoin_listing_game_wow").await;
    run_sql(&main, LISTINGS_SQL).await;
    run_sql(&main, include_str!("../../../../scripts/sql/096_marketplace_outbox.sql")).await;
    run_sql(&main, include_str!("../../../../scripts/sql/115_seller_api_grants.sql")).await;
    for pool in [&main, &bss, &wow] {
        run_sql(pool, CATALOG_SQL).await;
    }
    run_sql(&main, "insert into public.marketplace_search_candidates values (757846, 'Pikachu', 'Ascended Heroes')").await;
    run_sql(&bss, "insert into public.marketplace_search_candidates values (200001768, 'Gladiator Squalo', 'Savior Of Chaos')").await;
    run_sql(&wow, "insert into public.marketplace_search_candidates values (200001768, 'Divine Justice', 'Blood of Gladiators')").await;
    std::env::set_var("BATTLE_SPIRITS_SAGA_MARKETPLACE_DATABASE_URL", &bss_url);
    std::env::set_var("WORLD_OF_WARCRAFT_MARKETPLACE_DATABASE_URL", &wow_url);

    let state = DomainState::with_pools(CommerceConfig::default(), main.clone(), main.clone(), None, Arc::new(UidToken), None);
    let app = pokoin_commerce::router(state);
    let post = |body: Value| call(&app, "/api/marketplace-listings", "seller-1", body);

    // A Battle Spirits Saga card tagged `pokemon` lands under Battle Spirits
    // Saga: the Pokémon catalog lacks the id, and of the two catalogs sharing
    // it only Battle Spirits Saga has it under that name.
    let (status, created) = post(stock("200001768", "Gladiator Squalo", "pokemon")).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(game_of(&main, &created["id"]).await, "battle_spirits_saga");
    let (status, created) = post(stock("200001768", "Divine Justice", "pokemon")).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(game_of(&main, &created["id"]).await, "world_of_warcraft");

    // The shared id under a name neither catalog has is refused, not guessed.
    let before = listings(&main).await;
    let (status, refused) = post(stock("200001768", "Pikachu", "pokemon")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert!(refused.to_string().contains("GAME_CARD_MISMATCH"), "{refused}");
    assert_eq!(listings(&main).await, before);

    // A claim its catalog confirms stands, and so does an id no catalog has
    // yet (a lagging catalog must not block a listing).
    let (_, created) = post(stock("757846", "Pikachu", "pokemon")).await;
    assert_eq!(game_of(&main, &created["id"]).await, "pokemon");
    let (_, created) = post(stock("200001768", "Gladiator Squalo", "battle_spirits_saga")).await;
    assert_eq!(game_of(&main, &created["id"]).await, "battle_spirits_saga");
    let (_, created) = post(stock("999998", "Next Set Promo", "pokemon")).await;
    assert_eq!(game_of(&main, &created["id"]).await, "pokemon");

    // The Card Rails path itself: a seller API `list` whose identity says
    // `pokemon` for a Battle Spirits Saga card.
    let (status, grant) = call(&app, "/api/seller-api-grants", "seller-1", json!({"action":"create","client":"Card Rails"})).await;
    assert_eq!(status, StatusCode::OK, "{grant}");
    let token = grant["token"].as_str().unwrap().to_string();
    let item = json!({"id":"cr_0d486093","identity":{"game":"pokemon","name":"Gladiator Squalo","setName":"Savior Of Chaos","number":"BSS04-090","publicId":"200001768"},
        "language":"EN","condition":"NM","finish":"standard","quantity":1,"price":0,"currency":"EUR","status":"paused","location":"megaevoluzionietb·20·1"});
    let (status, listed) = call(&app, "/api/cardrails/connector", &token, json!({"action":"list","channel":"pokoin","item":item,"idempotencyKey":"cardrails:cr_0d486093"})).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(game_of(&main, &listed["listingId"]).await, "battle_spirits_saga");

    drop((main, bss, wow));
    for name in ["pokoin_listing_game_main", "pokoin_listing_game_bss", "pokoin_listing_game_wow"] {
        run_sql(&admin, &format!("drop database if exists {name} with (force)")).await;
    }
}
