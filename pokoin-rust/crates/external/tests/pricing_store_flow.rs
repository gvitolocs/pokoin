//! Pricing groups against a real Postgres, with the production migration
//! (`scripts/sql/138_seller_pricing_groups.sql`).
//!
//! ```text
//! docker run -d --rm --name pokoin-pricing-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55481:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55481/postgres \
//!   cargo test -p pokoin-external --test pricing_store_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped. It drops and
//! recreates the listings and pricing tables: a throwaway database only.

use pokoin_external::pricing::{self, PlanOutcome};
use pokoin_external::pricing_store as store;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

const MIGRATION: &str = include_str!("../../../../scripts/sql/138_seller_pricing_groups.sql");
const LISTINGS: &str = "
drop table if exists public.seller_pricing_group_members, public.seller_pricing_groups, public.marketplace_user_listings cascade;
create extension if not exists pgcrypto;
create table public.marketplace_user_listings (
  id uuid primary key default gen_random_uuid(),
  card_id text not null, seller_uid text not null,
  card_name text not null default '', set_name text not null default '', collector_number text not null default '',
  condition text not null default 'NM', language text not null default 'EN', foil_state text not null default 'standard',
  reverse boolean not null default false, first_edition boolean not null default false, graded boolean not null default false,
  signed boolean not null default false, altered boolean not null default false,
  price_pkn numeric not null default 0, status text not null default 'active', quantity_available integer not null default 1,
  marketplace_game text not null default 'pokemon');";

async fn listing(pool: &sqlx::PgPool, seller: &str, card: &str, status: &str, price: f64, game: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "insert into public.marketplace_user_listings (card_id, seller_uid, card_name, status, price_pkn, marketplace_game)
         values ($1, $2, $1, $3, $4, $5) returning id",
    )
    .bind(card)
    .bind(seller)
    .bind(status)
    .bind(price)
    .bind(game)
    .fetch_one(pool)
    .await
    .expect("listing")
}

#[tokio::test]
async fn groups_hold_one_sellers_listings_one_group_each() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.expect("connect");
    sqlx::raw_sql(LISTINGS).execute(&pool).await.expect("listings");
    sqlx::raw_sql(MIGRATION).execute(&pool).await.expect("migration");
    sqlx::raw_sql(MIGRATION).execute(&pool).await.expect("the migration runs twice");

    let strategies = [json!({"id": "st_a", "name": "Match"}), json!({"id": "st_b", "name": "Undercut"})];
    let bulk = pricing::sanitize_group(&json!({"name": "Riftbound bulk", "strategyId": "st_a", "autoDaily": true}), None, &strategies, &[]).unwrap();
    let holos = pricing::sanitize_group(&json!({"name": "Vintage holos", "strategyId": "st_b"}), None, &strategies, &[]).unwrap();
    store::upsert_group(&pool, "alice", &bulk).await.unwrap();
    store::upsert_group(&pool, "alice", &holos).await.unwrap();
    let (bulk_id, holos_id) = (bulk["id"].as_str().unwrap(), holos["id"].as_str().unwrap());

    // The unique index catches a same-name race the sanitizer cannot see.
    let twin = json!({"id": "pg_twin", "name": "RIFTBOUND BULK", "strategyId": "st_a", "autoDaily": false});
    assert_eq!(store::upsert_group(&pool, "alice", &twin).await.unwrap_err().code.as_deref(), Some("group_name_taken"));
    // Another seller cannot take over an id.
    let stolen = json!({"id": bulk_id, "name": "Mine now", "strategyId": "st_a", "autoDaily": false});
    assert_eq!(store::upsert_group(&pool, "mallory", &stolen).await.unwrap_err().code.as_deref(), Some("pricing_group_unknown"));

    let a1 = listing(&pool, "alice", "801312", "paused", 0.0, "riftbound").await;
    let a2 = listing(&pool, "alice", "801320", "active", 30.0, "riftbound").await;
    let a3 = listing(&pool, "alice", "220962", "sold_out", 30.0, "pokemon").await;
    let m1 = listing(&pool, "mallory", "801312", "active", 10.0, "riftbound").await;

    assert_eq!(store::add_members(&pool, "alice", bulk_id, &[a1, a2, a3, m1]).await.unwrap(), 3, "mallory's listing is ignored");
    assert_eq!(store::add_members(&pool, "mallory", bulk_id, &[m1]).await.unwrap(), 0, "nor can mallory use alice's group");
    // Moving a listing takes it out of its old group.
    assert_eq!(store::add_members(&pool, "alice", holos_id, &[a2]).await.unwrap(), 1);
    let memberships = store::memberships(&pool, "alice").await.unwrap();
    assert_eq!(memberships.len(), 3);
    assert!(memberships.contains(&(a2.to_string(), holos_id.to_string())));

    let groups = store::list_groups(&pool, "alice").await.unwrap();
    let names: Vec<&str> = groups.iter().map(|g| g["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Riftbound bulk", "Vintage holos"]);
    assert_eq!((groups[0]["listingCount"].clone(), groups[0]["autoDaily"].clone()), (json!(2), json!(true)));
    assert!(groups[0]["lastAppliedAt"].is_null());

    // The plan's rows: live and paused with stock only.
    let rows = store::group_rows(&pool, "alice", bulk_id).await.unwrap();
    assert_eq!(rows.len(), 1, "the sold-out listing is not priced");
    assert_eq!((rows[0]["id"].as_str().unwrap(), rows[0]["marketplace_game"].as_str().unwrap()), (a1.to_string().as_str(), "riftbound"));
    let comp = json!({"ctMatchedPkn": 25.56, "ctMatchedGrossPkn": 28});
    let strategy = json!({"rounding": "integer", "minPkn": 1, "activatePaused": true});
    assert_eq!(
        pricing::plan_row(&rows[0], Some(&comp), &strategy),
        PlanOutcome::Change { current: 0.0, comp_pkn: 25.56, target: 26.0, activate: true },
        "a row read from the store plans like the web's"
    );
    assert_eq!(store::listing_rows(&pool, "alice", &[a1, a2, m1]).await.unwrap().len(), 2);
    assert_eq!(store::seller_rows(&pool, "alice").await.unwrap().len(), 2);

    store::record_applied(&pool, "alice", bulk_id, &store::applied_summary(1, 1, 0, 0, 0, "daily")).await.unwrap();
    let applied = store::group(&pool, "alice", bulk_id).await.unwrap().unwrap();
    assert_eq!(applied["lastApplied"]["trigger"], "daily");
    assert!(applied["lastAppliedAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(store::daily_groups(&pool).await.unwrap(), vec![("alice".to_string(), bulk_id.to_string())]);
    assert_eq!(store::groups_using_strategy(&pool, "alice", "st_b").await.unwrap(), ["Vintage holos"]);

    // Removing, deleting a group and deleting a listing all drop memberships.
    assert_eq!(store::remove_members(&pool, "mallory", &[a1]).await.unwrap(), 0);
    assert_eq!(store::remove_members(&pool, "alice", &[a3]).await.unwrap(), 1);
    assert!(store::delete_group(&pool, "alice", holos_id).await.unwrap());
    assert!(!store::delete_group(&pool, "mallory", bulk_id).await.unwrap());
    sqlx::query("delete from public.marketplace_user_listings where id = $1").bind(a1).execute(&pool).await.unwrap();
    assert!(store::memberships(&pool, "alice").await.unwrap().is_empty());
    let left: Vec<Value> = store::list_groups(&pool, "alice").await.unwrap();
    assert_eq!((left.len(), left[0]["listingCount"].clone()), (1, json!(0)));
}
