//! Scan desk rows against a real Postgres with the live column types
//! (`seq` bigint, `position` double precision, `price_pkn` numeric).
//!
//! ```text
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55473/postgres \
//!   cargo test -p pokoin-external --test scan_rows_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped. It drops and
//! recreates the three scan tables: point it at a throwaway database only.
//! The tests below own a scratch database of the same server each, because the
//! tests of one binary run on parallel threads.

use pokoin_external::db::DbPools;
use pokoin_external::scan_store;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;

const SCHEMA: &str = include_str!("fixtures/scan_schema.sql");
const SELLER: &str = "seller-1";

/// What a paired phone needs on top of the scan tables.
const PHONE_SCHEMA: &str = "
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

/// Listings a `list` submit writes (the subset `submit_batch` touches).
const LISTINGS_SCHEMA: &str = "
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

/// The submit seam: these tests never list, so ownership is never reached.
struct Owned;

impl scan_store::ScanOwnership for Owned {
    fn upsert<'a>(
        &'a self,
        _args: scan_store::ScanOwnershipArgs,
    ) -> futures_util::future::BoxFuture<'a, pokoin_external::ApiResult<Value>> {
        Box::pin(async { Ok(json!({})) })
    }
}

/// Every test of this file drops and recreates the scan tables and cargo runs
/// the tests of one binary on parallel threads, so each one works in its own
/// database of the same throwaway server.
struct Scratch {
    maint: sqlx::PgPool,
    pool: sqlx::PgPool,
    name: String,
}

impl Scratch {
    async fn finish(self) {
        let Self { maint, pool, name } = self;
        pool.close().await;
        for _ in 0..100 {
            if pool.is_closed() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let _ = sqlx::raw_sql(&format!("drop database if exists {name}"))
            .execute(&maint)
            .await;
    }
}

async fn scratch_db(tag: &str) -> Option<Scratch> {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return None;
    };
    let name = format!("scan_rows_flow_{tag}");
    let maint = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect");
    sqlx::raw_sql(&format!("drop database if exists {name}"))
        .execute(&maint)
        .await
        .expect("drop scratch database");
    sqlx::raw_sql(&format!("create database {name}"))
        .execute(&maint)
        .await
        .expect("create scratch database");
    let options = url
        .parse::<sqlx::postgres::PgConnectOptions>()
        .expect("test database url")
        .database(&name);
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .expect("connect scratch database");
    sqlx::raw_sql(SCHEMA)
        .execute(&pool)
        .await
        .expect("scan schema");
    sqlx::raw_sql(PHONE_SCHEMA)
        .execute(&pool)
        .await
        .expect("phone schema");
    Some(Scratch { maint, pool, name })
}

async fn insert_row(
    pool: &sqlx::PgPool,
    batch: &str,
    seq: i64,
    position: f64,
    price: Option<f64>,
) -> String {
    sqlx::query_scalar::<_, String>(
        "insert into public.scan_items (batch_id, seller_uid, recognition_state, seq, position, card_name, price_pkn)
         values ($1::uuid, $2, 'manual', $3, $4, 'Lugia', $5::float8::numeric) returning id::text",
    )
    .bind(batch)
    .bind(SELLER)
    .bind(seq)
    .bind(position)
    .bind(price)
    .fetch_one(pool)
    .await
    .expect("item")
}

async fn price_pkn(pool: &sqlx::PgPool, item: &str) -> Option<f64> {
    sqlx::query_scalar::<_, Option<f64>>(
        "select price_pkn::float8 from public.scan_items where id = $1::uuid",
    )
    .bind(item)
    .fetch_one(pool)
    .await
    .expect("price")
}

#[tokio::test]
async fn only_if_empty_price_is_read_from_the_patch_the_desk_sends() {
    let Some(scratch) = scratch_db("only_if_empty_price").await else {
        return;
    };
    let pool = scratch.pool.clone();
    let db = DbPools::lazy(pool.clone(), pool.clone());
    let batch: String = sqlx::query(
        "insert into public.scan_batches (seller_uid, item_seq, item_position) values ($1, 2, 2) returning id::text",
    )
    .bind(SELLER)
    .fetch_one(&pool)
    .await
    .expect("batch")
    .get(0);
    let typed = insert_row(&pool, &batch, 1, 1.0, Some(400.0)).await;
    let other = insert_row(&pool, &batch, 2, 2.0, Some(400.0)).await;

    // The body market/src/scan-api.js:77 posts: the guard travels inside `patch`.
    let desk_patch = |item: &str, guard: bool| {
        json!({
            "batchId": batch,
            "itemId": item,
            "patch": {"pricePkn": 300, "priceSuggested": true, "onlyIfEmptyPrice": guard},
        })
    };

    // With the guard read from the payload root only, `pricePkn` stayed in the
    // change list and the patch wrote over the row.
    let out = scan_store::mutate_batch(
        &db,
        &Owned,
        SELLER,
        &batch,
        "item",
        &desk_patch(&typed, true),
    )
    .await;
    out.expect("guarded patch of a priced row");
    assert_eq!(
        price_pkn(&pool, &typed).await,
        Some(400.0),
        "a late suggestion must not replace the price the seller typed"
    );

    let top_level = json!({
        "batchId": batch,
        "itemId": other,
        "patch": {"pricePkn": 300, "priceSuggested": true},
        "onlyIfEmptyPrice": true,
    });
    let out = scan_store::mutate_batch(&db, &Owned, SELLER, &batch, "item", &top_level).await;
    out.expect("top-level guard");
    assert_eq!(
        price_pkn(&pool, &other).await,
        Some(400.0),
        "a top-level guard still holds"
    );

    // The other side of the guard — the empty box gets the suggestion, an
    // unguarded patch writes — is covered by the patch tests below.

    scratch.finish().await;
}

#[tokio::test]
async fn a_removed_row_comes_back_newer_than_the_one_on_screen() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.expect("connect");
    sqlx::raw_sql("drop table if exists public.scan_items, public.scan_sessions, public.scan_batches cascade")
        .execute(&pool)
        .await
        .expect("drop");
    sqlx::raw_sql(SCHEMA).execute(&pool).await.expect("schema");

    let batch: String = sqlx::query(
        "insert into public.scan_batches (seller_uid, item_seq, item_position) values ($1, 18, 2) returning id::text",
    )
    .bind(SELLER)
    .fetch_one(&pool)
    .await
    .expect("batch")
    .get(0);
    let mut ids = Vec::new();
    for (seq, position) in [(17_i64, 1.0_f64), (18, 1.5)] {
        let id: String = sqlx::query(
            "insert into public.scan_items (batch_id, seller_uid, recognition_state, seq, position, card_name, price_pkn)
             values ($1::uuid, $2, 'manual', $3, $4, 'Lugia', 12.50) returning id::text",
        )
        .bind(&batch)
        .bind(SELLER)
        .bind(seq)
        .bind(position)
        .fetch_one(&pool)
        .await
        .expect("item")
        .get(0);
        ids.push(id);
    }
    let db = DbPools::lazy(pool.clone(), pool.clone());

    // What the desk loads: item views, numbers as numbers.
    let snapshot = scan_store::read_batch_snapshot(&db, SELLER, &batch).await.expect("snapshot");
    let items = snapshot["items"].as_array().expect("items");
    assert_eq!(items.iter().map(|row| row["seq"].clone()).collect::<Vec<_>>(), vec![json!(17), json!(18)]);
    assert_eq!(items[1]["position"], json!(1.5));
    assert_eq!(items[1]["pricePkn"], json!(12.5));
    assert_eq!(items[1]["cardName"], json!("Lugia"));
    assert_eq!(items[1]["batchId"], json!(batch));
    assert_eq!(snapshot["batch"]["cursor"], json!(18));
    assert_eq!(snapshot["cursor"], json!(18));
    assert!(snapshot["serverTime"].as_i64().unwrap_or(0) > 0);

    // The row ✕. The desk keeps whichever copy of a row has the higher seq
    // (scan-model.js applyItems), so the answer must outrank the row it shows.
    let removed = scan_store::set_status(&db, SELLER, &ids[1], "active", "removed").await.expect("remove");
    let row = &removed["items"][0];
    assert_eq!(row["id"], json!(ids[1]));
    assert_eq!(row["status"], json!("removed"));
    assert_eq!(row["seq"], json!(19), "seq read as 0 leaves the removed row on screen");

    // The stream replays it from the desk's cursor, in the same shape.
    let after = scan_store::items_after(&db, &batch, 18, 500).await.expect("after");
    let after = after.as_array().expect("array");
    assert_eq!(after.len(), 1);
    assert_eq!(after[0]["seq"], json!(19));
    assert_eq!(after[0]["status"], json!("removed"));
    assert_eq!(after[0]["batchId"], json!(batch));
    assert_eq!(after[0].get("batch_id"), None::<&Value>);

    let restored = scan_store::set_status(&db, SELLER, &ids[1], "removed", "active").await.expect("restore");
    assert_eq!(restored["items"][0]["seq"], json!(20));
    assert_eq!(restored["items"][0]["status"], json!("active"));
}

/// A deterministic uuid per scan event.
fn scan_uuid(n: i64) -> String {
    format!("0b0e0000-0000-4000-a000-{n:012x}")
}

/// Wait until a scan of this server is parked on the row lock of `scan_batches`.
async fn wait_blocked_on_batch(pool: &sqlx::PgPool) {
    for _ in 0..200 {
        let waiting: i64 = sqlx::query_scalar(
            "select count(*) from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and state = 'active' and query ilike '%scan_batches%for update%'",
        )
        .fetch_one(pool)
        .await
        .unwrap_or(0);
        if waiting > 0 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the scan never blocked on the batch row lock");
}

#[tokio::test]
async fn a_scan_that_lands_while_submit_closes_the_batch_is_rejected() {
    let Some(scratch) = scratch_db("scan_after_batch_close").await else {
        return;
    };
    let pool = scratch.pool.clone();
    let db = DbPools::lazy(pool.clone(), pool.clone());

    let started = scan_store::start_session(&db, SELLER, "")
        .await
        .expect("session");
    let batch_id = started["batch"]["id"].as_str().expect("batch").to_string();
    let secret: String = sqlx::query_scalar("select qr_secret from public.scan_pairings")
        .fetch_one(&pool)
        .await
        .expect("pairing");
    let paired =
        scan_store::claim_pairing(&db, "", &secret, "203.0.113.9", "Card Rails/1", "iPhone")
            .await
            .expect("pair");
    let token = paired["phoneToken"].as_str().expect("token").to_string();

    // submit's closing write, held open: the batch row is locked and the last
    // status anybody can still read as committed is `open`.
    let mut closer = pool.begin().await.expect("closer");
    sqlx::query("update public.scan_batches set status = 'submitted' where id = $1::uuid")
        .bind(&batch_id)
        .execute(&mut *closer)
        .await
        .expect("close");

    let ingest_db = DbPools::lazy(pool.clone(), pool.clone());
    let body = json!({ "scanEventId": scan_uuid(1), "clientSequence": 1 });
    let ingest =
        tokio::spawn(async move { scan_store::ingest_scan(&ingest_db, &token, &body).await });
    wait_blocked_on_batch(&pool).await;

    closer.commit().await.expect("commit close");
    let out = ingest.await.expect("ingest task");
    let error =
        out.expect_err("a scan that lands behind the commit that closed the batch is refused");
    assert_eq!(
        (error.status, error.code.as_deref()),
        (409, Some("batch_closed")),
        "the scan answered {error:?} for a batch submit had already closed"
    );
    let rows: i64 =
        sqlx::query_scalar("select count(*) from public.scan_items where batch_id = $1::uuid")
            .bind(&batch_id)
            .fetch_one(&pool)
            .await
            .expect("count");
    assert_eq!(rows, 0, "the refused scan inserts nothing");

    scratch.finish().await;
}

async fn insert_batch(pool: &sqlx::PgPool, item_seq: i64, item_position: i32) -> String {
    sqlx::query_scalar(
        "insert into public.scan_batches (seller_uid, item_seq, item_position) values ($1, $2, $3) returning id::text",
    )
    .bind(SELLER)
    .bind(item_seq)
    .bind(item_position)
    .fetch_one(pool)
    .await
    .expect("batch")
}

async fn item_field(pool: &sqlx::PgPool, item: &str, column: &str) -> Option<String> {
    let sql = format!("select {column}::text from public.scan_items where id = $1::uuid");
    sqlx::query_scalar(&sql)
        .bind(item)
        .fetch_one(pool)
        .await
        .expect("item field")
}

#[tokio::test]
async fn a_price_patch_writes_the_rows_price() {
    let Some(scratch) = scratch_db("patch_price").await else {
        return;
    };
    let pool = scratch.pool.clone();
    let db = DbPools::lazy(pool.clone(), pool.clone());
    let batch = insert_batch(&pool, 5, 1).await;
    let item = insert_row(&pool, &batch, 1, 1.0, None).await;

    let out = scan_store::mutate_batch(
        &db,
        &Owned,
        SELLER,
        &batch,
        "item",
        &json!({ "itemId": item, "patch": { "pricePkn": 12.34 } }),
    )
    .await
    .expect("a price patch writes the row");
    assert_eq!(out["items"][0]["pricePkn"], json!(12.34));
    assert_eq!(price_pkn(&pool, &item).await, Some(12.34));

    scratch.finish().await;
}

#[tokio::test]
async fn a_facet_and_printing_patch_writes_the_row() {
    let Some(scratch) = scratch_db("patch_facets").await else {
        return;
    };
    let pool = scratch.pool.clone();
    let db = DbPools::lazy(pool.clone(), pool.clone());
    let batch = insert_batch(&pool, 5, 1).await;
    let item: String = sqlx::query_scalar(
        "insert into public.scan_items (batch_id, seller_uid, recognition_state, seq, position, card_id, card_name)
         values ($1::uuid, $2, 'manual', 1, 1, '111', 'Lugia') returning id::text",
    )
    .bind(&batch)
    .bind(SELLER)
    .fetch_one(&pool)
    .await
    .expect("item");

    let out = scan_store::mutate_batch(
        &db,
        &Owned,
        SELLER,
        &batch,
        "item",
        &json!({ "itemId": item, "patch": { "condition": "MP", "language": "JP", "cardId": "222" } }),
    )
    .await
    .expect("a facet and printing patch writes the row");
    assert_eq!(out["items"][0]["condition"], json!("MP"));
    assert_eq!(out["items"][0]["language"], json!("JP"));
    assert_eq!(out["items"][0]["cardId"], json!("222"));
    assert_eq!(
        item_field(&pool, &item, "condition").await.as_deref(),
        Some("MP")
    );
    assert_eq!(
        item_field(&pool, &item, "language").await.as_deref(),
        Some("JP")
    );
    assert_eq!(
        item_field(&pool, &item, "card_id").await.as_deref(),
        Some("222")
    );

    scratch.finish().await;
}

#[tokio::test]
async fn batch_defaults_set_and_clear_on_every_active_row() {
    let Some(scratch) = scratch_db("defaults_fan").await else {
        return;
    };
    let pool = scratch.pool.clone();
    let db = DbPools::lazy(pool.clone(), pool.clone());
    let batch = insert_batch(&pool, 10, 3).await;
    let first = insert_row(&pool, &batch, 1, 1.0, None).await;
    let second = insert_row(&pool, &batch, 2, 2.0, None).await;
    let removed: String = sqlx::query_scalar(
        "insert into public.scan_items (batch_id, seller_uid, recognition_state, seq, position, status)
         values ($1::uuid, $2, 'manual', 3, 3, 'removed') returning id::text",
    )
    .bind(&batch)
    .bind(SELLER)
    .fetch_one(&pool)
    .await
    .expect("removed");

    let out = scan_store::set_defaults(&db, SELLER, &batch, &json!({ "condition": "MP" }))
        .await
        .expect("a batch default fans onto the active rows");
    assert_eq!(out["items"].as_array().map(Vec::len), Some(2));
    for item in [&first, &second] {
        assert_eq!(
            item_field(&pool, item, "condition").await.as_deref(),
            Some("MP")
        );
    }
    assert_eq!(
        item_field(&pool, &removed, "condition").await.as_deref(),
        Some("NM")
    );

    let out = scan_store::set_defaults(&db, SELLER, &batch, &json!({ "condition": "NM" }))
        .await
        .expect("clearing a batch default fans onto the active rows");
    assert_eq!(out["items"].as_array().map(Vec::len), Some(2));
    for item in [&first, &second] {
        assert_eq!(
            item_field(&pool, item, "condition").await.as_deref(),
            Some("NM")
        );
    }

    scratch.finish().await;
}

#[tokio::test]
async fn a_status_patch_removes_and_restores_the_row() {
    let Some(scratch) = scratch_db("patch_status").await else {
        return;
    };
    let pool = scratch.pool.clone();
    let db = DbPools::lazy(pool.clone(), pool.clone());
    let batch = insert_batch(&pool, 5, 1).await;
    let item = insert_row(&pool, &batch, 1, 1.0, Some(4.0)).await;

    let removed = scan_store::set_status(&db, SELLER, &item, "active", "removed")
        .await
        .expect("remove");
    assert_eq!(removed["items"][0]["status"], json!("removed"));
    assert_eq!(
        item_field(&pool, &item, "status").await.as_deref(),
        Some("removed")
    );

    let restored = scan_store::set_status(&db, SELLER, &item, "removed", "active")
        .await
        .expect("restore");
    assert_eq!(restored["items"][0]["status"], json!("active"));
    assert_eq!(
        item_field(&pool, &item, "status").await.as_deref(),
        Some("active")
    );

    scratch.finish().await;
}

#[tokio::test]
async fn a_duplicated_row_copies_the_printing_and_price() {
    let Some(scratch) = scratch_db("duplicate").await else {
        return;
    };
    let pool = scratch.pool.clone();
    let db = DbPools::lazy(pool.clone(), pool.clone());
    let batch = insert_batch(&pool, 5, 1).await;
    let item = insert_row(&pool, &batch, 1, 1.0, Some(9.5)).await;

    let out = scan_store::duplicate_item(&db, SELLER, &item)
        .await
        .expect("duplicate");
    let copy = &out["items"][0];
    assert_ne!(copy["id"], json!(item));
    assert_eq!(copy["status"], json!("active"));
    assert_eq!(copy["condition"], json!("NM"));
    assert_eq!(
        price_pkn(&pool, copy["id"].as_str().expect("copy id")).await,
        Some(9.5)
    );
    let rows: i64 =
        sqlx::query_scalar("select count(*) from public.scan_items where batch_id = $1::uuid")
            .bind(&batch)
            .fetch_one(&pool)
            .await
            .expect("count");
    assert_eq!(rows, 2);

    scratch.finish().await;
}

#[tokio::test]
async fn a_submit_lists_a_priced_row_and_parks_the_unpriced_one() {
    let Some(scratch) = scratch_db("submit_rows").await else {
        return;
    };
    let pool = scratch.pool.clone();
    sqlx::raw_sql(LISTINGS_SCHEMA)
        .execute(&pool)
        .await
        .expect("listings schema");
    let db = DbPools::lazy(pool.clone(), pool.clone());
    let batch: String = sqlx::query_scalar(
        "insert into public.scan_batches (seller_uid, item_seq, defaults) values ($1, 2, $2) returning id::text",
    )
    .bind(SELLER)
    .bind(sqlx::types::Json(json!({ "pricingStrategyId": "st_test" })))
    .fetch_one(&pool)
    .await
    .expect("batch");
    sqlx::query(
        "insert into public.scan_items
           (batch_id, seller_uid, recognition_state, seq, position, card_id, card_name, price_pkn, graded, grading_company, grade)
         values ($1::uuid, $2, 'matched', 1, 1, '111', 'Lugia', 12.5, true, 'PSA', '10'),
                ($1::uuid, $2, 'matched', 2, 2, '222', 'Ho-Oh', null, false, null, null)",
    )
    .bind(&batch)
    .bind(SELLER)
    .execute(&pool)
    .await
    .expect("rows");

    let out = scan_store::submit_batch(
        &db,
        &Owned,
        SELLER,
        &batch,
        "submit-rows",
        "Seller",
        "list",
        &json!({ "pokoin": true, "cardtrader": false }),
    )
    .await
    .expect("submit one priced and one unpriced row");
    assert_eq!(out["result"]["paused"], json!(1));
    let listings: Vec<(String, String, f64)> = sqlx::query_as(
        "select card_id, status, price_pkn::float8 from public.marketplace_user_listings order by card_id",
    )
    .fetch_all(&pool)
    .await
    .expect("listings");
    assert_eq!(
        listings,
        vec![
            ("111".into(), "active".into(), 12.5),
            ("222".into(), "paused".into(), 0.0),
        ]
    );

    scratch.finish().await;
}

#[tokio::test]
async fn the_defaults_fan_keeps_every_row_ahead_of_the_stream_cursor() {
    let Some(scratch) = scratch_db("defaults_cursor").await else {
        return;
    };
    let pool = scratch.pool.clone();
    let db = DbPools::lazy(pool.clone(), pool.clone());
    let batch = insert_batch(&pool, 18, 2).await;
    insert_row(&pool, &batch, 17, 1.0, None).await;
    insert_row(&pool, &batch, 18, 2.0, None).await;
    let cursor = 18_i64;

    let _out = scan_store::set_defaults(&db, SELLER, &batch, &json!({ "condition": "MP" }))
        .await
        .expect("defaults fan");
    let batch_cursor: i64 =
        sqlx::query_scalar("select item_seq from public.scan_batches where id = $1::uuid")
            .bind(&batch)
            .fetch_one(&pool)
            .await
            .expect("batch item_seq");
    assert!(batch_cursor > cursor);

    let after = scan_store::items_after(&db, &batch, cursor, 500)
        .await
        .expect("items after");
    let after = after.as_array().expect("array");
    assert_eq!(
        after.len(),
        2,
        "both fanned rows are past the desk's cursor"
    );
    for row in after {
        assert_eq!(row["condition"], json!("MP"));
    }
    let max_seq = after.iter().filter_map(|row| row["seq"].as_i64()).max();
    assert_eq!(
        max_seq,
        Some(batch_cursor),
        "every fanned row sits on the batch item_seq"
    );

    scratch.finish().await;
}
