//! A Scan desk batch with pricing, submitted against a real Postgres: the
//! priced row goes live, the unpriced one is listed paused at 0, and both
//! join the batch's pricing group in the submit transaction.
//!
//! ```text
//! docker run -d --rm --name pokoin-pricing-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55481:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55481/postgres \
//!   cargo test -p pokoin-external --test scan_batch_pricing_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped. It drops and
//! recreates the scan, listing and pricing tables: a throwaway database only.

use futures_util::future::BoxFuture;
use pokoin_external::db::DbPools;
use pokoin_external::scan_store::{self, ScanOwnership, ScanOwnershipArgs};
use pokoin_external::ApiResult;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;

const SCAN_SCHEMA: &str = include_str!("fixtures/scan_schema.sql");
const MIGRATION: &str = include_str!("../../../../scripts/sql/138_seller_pricing_groups.sql");
const SELLER: &str = "seller-1";
const LISTINGS: &str = "
create extension if not exists pgcrypto;
create table public.marketplace_user_listings (
  id uuid primary key default gen_random_uuid(),
  card_id text not null, seller_uid text not null, seller_name text not null default '',
  condition text not null default 'NM', language text not null default 'EN',
  price_pkn numeric not null default 0 check (price_pkn >= 0), quantity_available integer not null default 1,
  signed boolean not null default false, reverse boolean not null default false, first_edition boolean not null default false,
  foil_state text not null default 'standard', graded boolean not null default false,
  grading_company text, grade text, certification_id text, seller_comment text not null default '',
  source text not null default 'pokoin_user_listing', source_listing_id text not null default '',
  card_name text not null default '', card_image_url text not null default '', set_name text not null default '',
  collector_number text not null default '', location text not null default '', altered boolean not null default false,
  status text not null default 'active', marketplace_game text not null default 'pokemon',
  updated_at timestamptz not null default now());
create unique index marketplace_user_listings_scan_source_uidx on public.marketplace_user_listings (source_listing_id)
  where source = 'pokoin_scan_batch' and source_listing_id not like 'ct:%';";

struct Owned;

impl ScanOwnership for Owned {
    fn upsert<'a>(&'a self, _args: ScanOwnershipArgs) -> BoxFuture<'a, ApiResult<Value>> {
        Box::pin(async { Ok(json!({})) })
    }
}

async fn batch_with_rows(pool: &sqlx::PgPool, defaults: Value) -> String {
    let batch: String = sqlx::query("insert into public.scan_batches (seller_uid, defaults, item_seq) values ($1, $2, 2) returning id::text")
        .bind(SELLER)
        .bind(sqlx::types::Json(defaults))
        .fetch_one(pool)
        .await
        .expect("batch")
        .get(0);
    for (seq, card, price) in [(1_i64, "220962", Some(12.5_f64)), (2, "222410", None)] {
        sqlx::query(
            "insert into public.scan_items (batch_id, seller_uid, recognition_state, seq, position, card_id, card_name, price_pkn)
             values ($1::uuid, $2, 'matched', $3, $3, $4, $4, $5)",
        )
        .bind(&batch)
        .bind(SELLER)
        .bind(seq)
        .bind(card)
        .bind(price)
        .execute(pool)
        .await
        .expect("item");
    }
    batch
}

#[tokio::test]
async fn an_unpriced_row_is_listed_paused_and_joins_the_batch_group() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.expect("connect");
    sqlx::raw_sql(
        "drop table if exists public.seller_pricing_group_members, public.seller_pricing_groups,
           public.marketplace_user_listings, public.scan_items, public.scan_sessions, public.scan_batches cascade",
    )
    .execute(&pool)
    .await
    .expect("drop");
    sqlx::raw_sql(SCAN_SCHEMA).execute(&pool).await.expect("scan schema");
    sqlx::raw_sql(LISTINGS).execute(&pool).await.expect("listings");
    sqlx::raw_sql(MIGRATION).execute(&pool).await.expect("migration");
    sqlx::query("insert into public.seller_pricing_groups (id, seller_uid, name, strategy_id) values ('pg_bulk', $1, 'Bulk', 'st_a')")
        .bind(SELLER)
        .execute(&pool)
        .await
        .expect("group");
    let db = DbPools::lazy(pool.clone(), pool.clone());
    let targets = json!({"pokoin": true, "cardtrader": false});

    // Without pricing, the unpriced row still blocks the submit.
    let plain = batch_with_rows(&pool, json!({})).await;
    let refused = scan_store::submit_batch(&db, &Owned, SELLER, &plain, "k0", "Seller", "list", &targets).await.unwrap_err();
    assert_eq!(refused.code.as_deref(), Some("not_ready"));

    // A group that is not the seller's is refused before anything is written.
    let foreign = batch_with_rows(&pool, json!({"pricingGroupId": "pg_other"})).await;
    let refused = scan_store::submit_batch(&db, &Owned, SELLER, &foreign, "k1", "Seller", "list", &targets).await.unwrap_err();
    assert_eq!((refused.status, refused.code.as_deref()), (409, Some("pricing_group_unknown")));
    let written: i64 = sqlx::query_scalar("select count(*) from public.marketplace_user_listings").fetch_one(&pool).await.unwrap();
    assert_eq!(written, 0);

    let priced = batch_with_rows(&pool, json!({"pricingGroupId": "pg_bulk"})).await;
    let out = scan_store::submit_batch(&db, &Owned, SELLER, &priced, "k2", "Seller", "list", &targets).await.expect("submit");
    assert_eq!(out["result"]["pricing"], json!({"groupId": "pg_bulk"}));
    assert_eq!(out["result"]["paused"], json!(1));
    let rows: Vec<(String, String, f64, Option<String>)> = sqlx::query_as(
        "select l.card_id, l.status, l.price_pkn::float8, m.group_id
           from public.marketplace_user_listings l
           left join public.seller_pricing_group_members m on m.listing_id = l.id
          order by l.card_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("220962".into(), "active".into(), 12.5, Some("pg_bulk".into())),
            ("222410".into(), "paused".into(), 0.0, Some("pg_bulk".into())),
        ]
    );

    // A strategy alone: listed the same way, in no group.
    let alone = batch_with_rows(&pool, json!({"pricingStrategyId": "st_a"})).await;
    sqlx::query("update public.scan_items set card_id = card_id || '0' where batch_id = $1::uuid").bind(&alone).execute(&pool).await.unwrap();
    let out = scan_store::submit_batch(&db, &Owned, SELLER, &alone, "k3", "Seller", "list", &targets).await.expect("submit");
    assert_eq!(out["result"]["pricing"], json!({"strategyId": "st_a"}));
    let grouped: i64 = sqlx::query_scalar("select count(*) from public.seller_pricing_group_members").fetch_one(&pool).await.unwrap();
    assert_eq!(grouped, 2, "a strategy batch joins no group");

    // One batch, several pricings: the batch's group, a row's own strategy,
    // and a row that must stay unpriced (so it needs a price to submit).
    let mixed = batch_with_rows(&pool, json!({"pricingGroupId": "pg_bulk"})).await;
    sqlx::query("update public.scan_items set card_id = card_id || '1' where batch_id = $1::uuid").bind(&mixed).execute(&pool).await.unwrap();
    sqlx::query("update public.scan_items set pricing = '{\"strategyId\": \"st_b\"}' where batch_id = $1::uuid and price_pkn is null")
        .bind(&mixed)
        .execute(&pool)
        .await
        .unwrap();
    let out = scan_store::submit_batch(&db, &Owned, SELLER, &mixed, "k4", "Seller", "list", &targets).await.expect("submit");
    let rows = out["result"]["rowPricing"].as_array().unwrap().clone();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|r| r["groupId"] == "pg_bulk" && r["priced"] == true));
    assert!(rows.iter().any(|r| r["strategyId"] == "st_b" && r["priced"] == false));
    let grouped: i64 = sqlx::query_scalar("select count(*) from public.seller_pricing_group_members").fetch_one(&pool).await.unwrap();
    assert_eq!(grouped, 3, "only the row priced by the group joins it");

    let opted_out = batch_with_rows(&pool, json!({"pricingGroupId": "pg_bulk"})).await;
    sqlx::query("update public.scan_items set card_id = card_id || '2', pricing = '{\"none\": true}' where batch_id = $1::uuid and price_pkn is null")
        .bind(&opted_out)
        .execute(&pool)
        .await
        .unwrap();
    let refused = scan_store::submit_batch(&db, &Owned, SELLER, &opted_out, "k5", "Seller", "list", &targets).await.unwrap_err();
    assert_eq!(refused.code.as_deref(), Some("not_ready"), "a row set to no pricing still needs its own price");
}
