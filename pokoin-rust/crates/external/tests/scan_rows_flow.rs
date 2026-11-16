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
    // unguarded patch writes — is not assertable here yet: `patch_item` binds the
    // parameters of its dynamically built UPDATE as jsonb, so every row write
    // fails with `cannot cast type jsonb to uuid`.

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
