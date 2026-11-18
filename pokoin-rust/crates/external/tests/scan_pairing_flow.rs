//! Scan Connect pairing against a real Postgres with the live column types
//! (`scan_pairings.session_id` and `scan_sessions.id` are uuid).
//!
//! ```text
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55473/postgres \\
//!   cargo test -p pokoin-external --test scan_pairing_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped. It drops and
//! recreates the scan tables: point it at a throwaway database only.

use pokoin_external::db::DbPools;
use pokoin_external::scan_store;
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;

const SCHEMA: &str = include_str!("fixtures/scan_schema.sql");
const PAIRING_SCHEMA: &str = "
create table public.scan_pairings (
    pin character(4) primary key check (pin ~ '^[0-9]{4}$'),
    session_id uuid not null unique references public.scan_sessions(id) on delete cascade,
    qr_secret text not null unique,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create table public.scan_rate_limits (
    bucket text not null,
    window_start timestamptz not null,
    hits integer not null default 0,
    primary key (bucket, window_start)
);";

#[tokio::test]
async fn a_phone_pairs_with_the_qr_secret_or_the_pin() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.expect("connect");
    sqlx::raw_sql(
        "drop table if exists public.scan_pairings, public.scan_rate_limits, public.scan_items, public.scan_sessions, public.scan_batches cascade",
    )
    .execute(&pool)
    .await
    .expect("drop");
    sqlx::raw_sql(SCHEMA).execute(&pool).await.expect("schema");
    sqlx::raw_sql(PAIRING_SCHEMA).execute(&pool).await.expect("pairing schema");
    let db = DbPools::lazy(pool.clone(), pool.clone());

    // The QR the dashboard shows carries only the secret.
    scan_store::start_session(&db, "seller-qr", "").await.expect("session");
    let row = sqlx::query("select session_id::text, qr_secret from public.scan_pairings")
        .fetch_one(&pool)
        .await
        .expect("pairing");
    let (session_id, secret): (String, String) = (row.get(0), row.get(1));
    let paired = scan_store::claim_pairing(&db, "", &secret, "203.0.113.7", "CardRails/15", "Card Rails iPhone")
        .await
        .expect("a live QR secret must pair; a uuid read as text rejects it as invalid_code");
    assert_eq!(paired["sessionId"].as_str(), Some(session_id.as_str()));
    assert!(paired["phoneToken"].as_str().is_some_and(|token| token.len() >= 32));

    // A consumed code cannot be claimed twice.
    let again = scan_store::claim_pairing(&db, "", &secret, "203.0.113.7", "CardRails/15", "Card Rails iPhone").await;
    assert!(again.is_err());

    // Typing the four digits on scan.pokoin.com pairs the same way.
    scan_store::start_session(&db, "seller-pin", "").await.expect("session");
    let pin: String = sqlx::query("select pin::text from public.scan_pairings").fetch_one(&pool).await.expect("pin").get(0);
    let paired = scan_store::claim_pairing(&db, &pin, "", "203.0.113.8", "Mozilla/5.0", "").await.expect("pin pairs");
    assert!(paired["phoneToken"].as_str().is_some());
}
