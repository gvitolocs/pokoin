//! Local checkout end-to-end server: the real commerce router against the
//! Firestore emulator, a throwaway Postgres and Stripe TEST mode, seeded with
//! one buyer, two sellers (Italy and Denmark) and a two-parcel cart.
//!
//! Never for production: it refuses a live Stripe key, a Firestore project
//! that is not `demo-*`, and a database that is not on localhost.
//!
//! ```text
//! E2E_DATABASE_URL=postgres://e2e:e2e@127.0.0.1:55432/e2e \
//! FIRESTORE_EMULATOR_HOST=127.0.0.1:8086 \
//! STRIPE_SECRET_KEY=sk_test_... \
//! cargo run -p pokoin-commerce --example checkout_e2e
//! ```
//!
//! The SPA signs in as the buyer with the `pokoin.auth.token` cookie
//! `{"token": E2E_BUYER_TOKEN, "uid": "e2e-buyer", "expiresAt": ...}` and the
//! Solid dev server proxies `/api` here (`POKOIN_API_PROXY`).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use pokoin_commerce::auth::{AuthError, Claims, TokenVerifier};
use pokoin_commerce::config::CommerceConfig;
use pokoin_commerce::firestore::FirestoreClient;
use pokoin_commerce::state::DomainState;

const PROJECT: &str = "demo-pokoin-e2e";
const BUYER: &str = "e2e-buyer";
const BUYER_TOKEN: &str = "e2e-buyer-token-not-a-firebase-jwt";
/// The buyer's PKN balance before every run (1000 PKN = €5).
const BUYER_BALANCE_PKN: i64 = 1000;
/// Address encryption key for the emulator's throwaway addresses only.
const ADDRESS_KEY_HEX: &str = "e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0";

/// Two sellers, one parcel each. Card subtotal €14 (≤ €20, so the untracked
/// letter is bookable): Italy 1 × 1200 PKN, Denmark 2 × 800 PKN.
const LISTINGS: &[(&str, &str, &str, &str, &str, i64)] = &[
    // (listing id, seller uid, seller username, country, card id, price PKN)
    ("00000000-0000-4000-8000-0000000e2e01", "e2e-seller-it", "redshakkio", "IT", "900001", 1200),
    ("00000000-0000-4000-8000-0000000e2e02", "e2e-seller-dk", "givi", "DK", "900002", 800),
];

struct E2eVerifier;

#[async_trait]
impl TokenVerifier for E2eVerifier {
    async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        if token != BUYER_TOKEN {
            return Err(AuthError::Missing);
        }
        Ok(Claims {
            uid: BUYER.into(),
            email: "e2e-buyer@example.test".into(),
            role: String::new(),
            admin: false,
            is_admin: false,
            custom: Default::default(),
        })
    }
}

fn env(name: &str, fallback: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn fail(message: &str) -> ! {
    eprintln!("checkout_e2e: {message}");
    std::process::exit(2);
}

const SCHEMA: &[&str] = &[
    "create extension if not exists pgcrypto",
    r#"create table if not exists public.marketplace_user_listings (
      id uuid primary key default gen_random_uuid(),
      card_id text not null,
      seller_uid text not null,
      seller_name text not null default 'Pokoin seller',
      seller_country text not null default 'EU',
      seller_reputation_label text not null default 'New',
      condition text not null default 'NM',
      language text not null default 'EN',
      price_pkn numeric not null check (price_pkn > 0),
      quantity_available integer not null default 1,
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
      status text not null default 'active',
      card_name text not null default '',
      card_image_url text not null default '',
      set_name text not null default '',
      collector_number text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )"#,
    r#"create table if not exists public.marketplace_checkout_holds (
      order_id text not null,
      listing_id uuid not null,
      quantity integer not null check (quantity > 0),
      created_at timestamptz not null default now(),
      primary key (order_id, listing_id)
    )"#,
    r#"create table if not exists public.marketplace_user_carts (
      user_uid text primary key,
      items jsonb not null default '[]'::jsonb,
      saved jsonb not null default '[]'::jsonb,
      gift boolean not null default false,
      card_ids bigint[] not null default '{}'::bigint[],
      rev bigint not null default 0,
      updated_at timestamptz not null default now()
    )"#,
];

async fn seed_postgres(pool: &sqlx::PgPool) -> anyhow::Result<()> {
    for statement in SCHEMA {
        sqlx::query(statement).execute(pool).await?;
    }
    sqlx::query("delete from public.marketplace_checkout_holds")
        .execute(pool)
        .await?;
    let mut cart = Vec::new();
    for (index, (id, seller, username, country, card, price)) in LISTINGS.iter().enumerate() {
        let quantity = if *country == "DK" { 2 } else { 1 };
        sqlx::query(
            r#"insert into public.marketplace_user_listings
                 (id, card_id, seller_uid, seller_name, seller_country, price_pkn,
                  quantity_available, status, card_name)
               values ($1::uuid, $2, $3, $4, $5, $6, 10, 'active', $7)
               on conflict (id) do update
                 set quantity_available = 10, status = 'active', price_pkn = excluded.price_pkn,
                     updated_at = now()"#,
        )
        .bind(*id)
        .bind(*card)
        .bind(*seller)
        .bind(*username)
        .bind(*country)
        .bind(*price as f64)
        .bind(format!("E2E card {}", index + 1))
        .execute(pool)
        .await?;
        cart.push(json!({
            "id": format!("e2e-row-{}", index + 1),
            "listingId": id,
            "sellerUid": seller,
            "sellerName": username,
            "sellerUsername": username,
            "sellerCountry": country,
            "cardId": card,
            "name": format!("E2E card {}", index + 1),
            "pricePkn": price,
            "addedPricePkn": price,
            "qty": quantity,
            "stock": 10,
            "selected": true,
            "condition": "NM",
            "language": "EN",
        }));
    }
    sqlx::query(
        r#"insert into public.marketplace_user_carts (user_uid, items, saved, gift, rev, updated_at)
           values ($1, $2::jsonb, '[]'::jsonb, false, 1, now())
           on conflict (user_uid) do update
             set items = excluded.items, saved = '[]'::jsonb, gift = false,
                 rev = public.marketplace_user_carts.rev + 1, updated_at = now()"#,
    )
    .bind(BUYER)
    .bind(Value::Array(cart))
    .execute(pool)
    .await?;
    Ok(())
}

async fn seed_firestore(firestore: &FirestoreClient) -> anyhow::Result<()> {
    for (_, seller, username, country, _, _) in LISTINGS {
        firestore
            .set_document(
                &firestore.document_path("users", seller)?,
                &json!({ "username": username, "shipFromCountry": country, "acceptsPkn": true }),
            )
            .await?;
    }
    firestore
        .set_document(
            &firestore.document_path("users", BUYER)?,
            &json!({ "username": BUYER, "shipFromCountry": "DK", "email": "e2e-buyer@example.test" }),
        )
        .await?;
    // A fixed balance on every start so each run prices the same discount.
    firestore
        .set_document(
            &firestore.document_path("balances", BUYER)?,
            &json!({ "availablePkn": BUYER_BALANCE_PKN, "lockedPkn": 0 }),
        )
        .await?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let stripe_key = env("STRIPE_SECRET_KEY", "");
    if !(stripe_key.starts_with("sk_test_") || stripe_key.starts_with("rk_test_")) {
        fail("STRIPE_SECRET_KEY must be a Stripe TEST key (sk_test_/rk_test_).");
    }
    let emulator = env("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8086");
    let database_url = env("E2E_DATABASE_URL", "postgres://e2e:e2e@127.0.0.1:55432/e2e");
    let listen = env("E2E_LISTEN", "127.0.0.1:8790");
    let site = env("E2E_SITE_URL", "http://127.0.0.1:5199");
    let local = |text: &str| text.contains("127.0.0.1") || text.contains("localhost");
    if !local(&emulator) || !local(&database_url) || !local(&listen) {
        fail("the emulator, the database and the listener must all be on localhost.");
    }

    let firestore = FirestoreClient::with_static_token(
        reqwest::Client::new(),
        PROJECT,
        format!("http://{emulator}/v1/projects/{PROJECT}/databases/(default)/documents"),
        "owner",
    );
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url)
        .await?;
    seed_postgres(&pool).await?;
    seed_firestore(&firestore).await?;

    let mut config = CommerceConfig::default();
    config.stripe_secret_key = Some(stripe_key);
    config.public_site_url = site;
    config.address_encryption_key = Some(ADDRESS_KEY_HEX.into());
    config.pokoin_treasury_username = "pokoin".into();
    let state = DomainState::with_pools(
        config,
        pool.clone(),
        pool,
        None,
        Arc::new(E2eVerifier),
        Some(firestore),
    );
    let app = pokoin_commerce::router(state);
    let listener = tokio::net::TcpListener::bind(&listen).await?;
    eprintln!("checkout_e2e: commerce API on http://{listen} (Firestore emulator {emulator}, project {PROJECT})");
    axum::serve(listener, app).await?;
    Ok(())
}
