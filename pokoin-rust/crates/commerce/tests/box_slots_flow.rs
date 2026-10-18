//! The next storage-box slot on a real Postgres: one box holds cards of every
//! game and every status that keeps a card in it.
//!
//! Needs a throwaway database (the test drops and recreates its table):
//!
//! ```text
//! docker run -d --rm --name pokoin-box-slots-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55474:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55474/postgres \
//!   cargo test -p pokoin-commerce --test box_slots_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped.

use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tower::ServiceExt;

use pokoin_commerce::auth::{AuthError, Claims, TokenVerifier};
use pokoin_commerce::config::CommerceConfig;
use pokoin_commerce::state::DomainState;

const SCHEMA: &str = "
drop table if exists public.marketplace_user_listings cascade;
create table public.marketplace_user_listings (
  id uuid primary key default gen_random_uuid(),
  card_id text not null,
  seller_uid text not null,
  price_pkn numeric not null default 100,
  quantity_available integer not null default 1,
  status text not null default 'active',
  location text not null default '',
  marketplace_game text not null default 'pokemon',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
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

async fn get(app: &Router, path: &str, bearer: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .uri(path)
        .header("authorization", format!("Bearer {bearer}"))
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.expect("router");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// `(seller, game, status, qty, location, minutes after the first row)`.
async fn insert(pool: &PgPool, rows: &[(&str, &str, &str, i32, String, i32)]) {
    for (seller, game, status, qty, location, minute) in rows {
        sqlx::query(
            "insert into public.marketplace_user_listings
               (card_id, seller_uid, marketplace_game, status, quantity_available, location, created_at)
             values ('1', $1, $2, $3, $4, $5, timestamptz '2026-10-01 00:00:00+00' + make_interval(mins => $6))",
        )
        .bind(seller)
        .bind(game)
        .bind(status)
        .bind(qty)
        .bind(location)
        .bind(minute)
        .execute(pool)
        .await
        .expect("insert");
    }
}

#[tokio::test]
async fn next_slot_counts_every_game_and_every_status_holding_a_card() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    std::env::set_var("POKOIN_LISTING_SYNC_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_WEBHOOK_WORKER", "0");
    std::env::set_var("POKOIN_READ_CACHE", "0");
    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.expect("test database");
    sqlx::raw_sql(SCHEMA).execute(&pool).await.expect("schema");

    let mut rows = vec![];
    // Pokémon stock first: stack 19 up to position 39.
    for p in 1..=39 {
        rows.push(("seller-1", "pokemon", "active", 1, format!("megaevoluzionietb·19·{p}"), p));
    }
    // Then Battle Spirits Saga cards, paused (not on sale yet), in stack 22.
    for p in 72..=76 {
        rows.push(("seller-1", "battle_spirits_saga", "paused", 1, format!("megaevoluzionietb·22·{p}"), 100 + p));
    }
    // A sold-out card left the box; another seller's box is not this one.
    rows.push(("seller-1", "pokemon", "sold_out", 0, "megaevoluzionietb·30·1".into(), 500));
    rows.push(("seller-2", "pokemon", "active", 1, "megaevoluzionietb·40·1".into(), 600));
    // Box `bin`: the newest cards are a scan-submitted (inactive) one and a
    // paused one; both still sit in the box.
    rows.push(("seller-1", "pokemon", "active", 5, "bin·1·1-5".into(), 10));
    rows.push(("seller-1", "riftbound", "inactive", 1, "bin·1·6".into(), 20));
    rows.push(("seller-1", "pokemon", "paused", 1, "bin·1·7".into(), 30));
    insert(&pool, &rows).await;

    let state = DomainState::with_pools(CommerceConfig::default(), pool.clone(), pool.clone(), None, Arc::new(UidToken), None);
    let app = pokoin_commerce::router(state);

    let (status, body) = get(
        &app,
        "/api/marketplace-listings?action=box-slots&sellerUid=seller-1&box=megaevoluzionietb&stackSize=80",
        "seller-1",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["next"]["slot"], "·22·77", "{body}");
    assert_eq!(body["next"]["stack"], 22);
    assert_eq!(body["next"]["startPosition"], 77);
    let held = body["rows"].as_array().unwrap();
    assert_eq!(held.len(), 44, "39 Pokémon + 5 Battle Spirits Saga, no sold-out row");
    assert!(held.iter().any(|row| row["game"] == "battle_spirits_saga" && row["status"] == "paused"));

    // The same answer on any game's host: the box is not scoped to a game.
    let (_, satellite) = get(
        &app,
        "/api/marketplace-listings?action=box-slots&sellerUid=seller-1&box=MegaEvoluzioniETB&stackSize=80&game=battle_spirits_saga",
        "seller-1",
    )
    .await;
    assert_eq!(satellite["next"]["slot"], "·22·77");

    // Boxes newest first, each with its next slot.
    assert_eq!(body["boxes"][0]["box"], "megaevoluzionietb");
    assert_eq!(body["boxes"][1]["box"], "bin");
    assert_eq!(body["boxes"][1]["next"]["slot"], "·1·8");

    let (_, bin) = get(&app, "/api/marketplace-listings?action=box-slots&sellerUid=seller-1&box=bin&stackSize=80", "seller-1").await;
    assert_eq!(bin["next"]["slot"], "·1·8", "{bin}");

    // A desk edit reads where its own listing is stored (public offers omit it).
    let paused: String = sqlx::query_scalar(
        "select id::text from public.marketplace_user_listings where seller_uid = 'seller-1' and location = 'bin·1·7'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let (_, own) = get(&app, &format!("/api/marketplace-listings?action=box-slots&sellerUid=seller-1&id={paused}"), "seller-1").await;
    assert_eq!(own["listing"]["location"], "bin·1·7", "{own}");
    let (_, theirs) = get(&app, &format!("/api/marketplace-listings?action=box-slots&sellerUid=seller-2&id={paused}"), "seller-2").await;
    assert_eq!(theirs["listing"], Value::Null);

    // Only the seller reads their boxes.
    let (status, _) = get(&app, "/api/marketplace-listings?action=box-slots&sellerUid=seller-1&box=bin", "seller-2").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
