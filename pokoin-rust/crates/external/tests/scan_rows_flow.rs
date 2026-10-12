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

use pokoin_external::db::DbPools;
use pokoin_external::scan_store;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;

const SCHEMA: &str = include_str!("fixtures/scan_schema.sql");
const SELLER: &str = "seller-1";

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
