use cardtrader_price_cache::{ensure_schema, write_cache, CacheRow, BATCH};

#[tokio::test]
async fn schema_is_idempotent_and_rewrite_deletes_only_in_scope_rows() {
    const BASE: i64 = 9_000_000_000;
    let Ok(url) = std::env::var("PRICE_CACHE_TEST_DATABASE_URL") else {
        return;
    };
    if url.trim().is_empty() {
        return;
    }
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(url.trim())
        .await
        .expect("connect");
    ensure_schema(&pool).await.expect("schema");
    ensure_schema(&pool).await.expect("schema again");

    // Synthetic ids, far above CardTrader blueprint ids, so a scratch database is the only place they land.
    let outside = BASE + 900_000;
    let other = BASE + 800_000;
    sqlx::query(
        "delete from public.cardtrader_blueprint_listing_cache \
         where blueprint_id between $1 and $2 or blueprint_id = any($3::bigint[])",
    )
    .bind(BASE)
    .bind(BASE + BATCH as i64 + 10)
    .bind(vec![outside, other])
    .execute(&pool)
    .await
    .expect("clear");
    insert_raw(&pool, outside, "cardtrader", "111").await;
    insert_raw(&pool, other, "other", "222").await;

    let scope: Vec<i64> = (1..=BATCH as i64 + 1)
        .map(|offset| BASE + offset)
        .chain(std::iter::once(other))
        .collect();
    let rows: Vec<CacheRow> = (1..=BATCH as i64 + 1)
        .map(|offset| row(BASE + offset, "10"))
        .collect();
    let updated = "2026-10-15T00:00:00Z";
    let first = write_cache(&pool, &scope, &rows, updated)
        .await
        .expect("write");
    assert_eq!(first.upserted, rows.len() as i64);

    let second_rows = vec![row(BASE + 1, "11")];
    let second = write_cache(&pool, &scope, &second_rows, updated)
        .await
        .expect("rewrite");
    assert_eq!(second.upserted, 1);
    assert_eq!(second.deleted, rows.len() as i64 - 1);

    let kept: bool = sqlx::query_scalar(
        "select cheapest_price_pkn = 11::numeric from public.cardtrader_blueprint_listing_cache where blueprint_id = $1",
    )
    .bind(BASE + 1)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(kept);

    let gone: i64 = sqlx::query_scalar(
        "select count(*) from public.cardtrader_blueprint_listing_cache where blueprint_id between $1 and $2",
    )
    .bind(BASE + 2)
    .bind(BASE + BATCH as i64 + 1)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(gone, 0);

    let outside_kept: bool = sqlx::query_scalar(
        "select cheapest_price_pkn = 111::numeric from public.cardtrader_blueprint_listing_cache where blueprint_id = $1",
    )
    .bind(outside)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(outside_kept);

    let other_kept: bool = sqlx::query_scalar(
        "select cheapest_price_pkn = 222::numeric from public.cardtrader_blueprint_listing_cache where blueprint_id = $1",
    )
    .bind(other)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(other_kept);

    sqlx::query(
        "delete from public.cardtrader_blueprint_listing_cache \
         where blueprint_id between $1 and $2 or blueprint_id = any($3::bigint[])",
    )
    .bind(BASE)
    .bind(BASE + BATCH as i64 + 10)
    .bind(vec![outside, other])
    .execute(&pool)
    .await
    .unwrap();
}

async fn insert_raw(pool: &sqlx::PgPool, blueprint_id: i64, provider: &str, price: &str) {
    sqlx::query(
        "insert into public.cardtrader_blueprint_listing_cache (
            provider, blueprint_id, pokoin_card_id, cheapest_price_pkn, eligible_listing_count, eligible_quantity
        ) values ($1, $2, $3, $4::numeric, 1, 1)",
    )
    .bind(provider)
    .bind(blueprint_id)
    .bind(blueprint_id.to_string())
    .bind(price)
    .execute(pool)
    .await
    .expect("insert");
}

fn row(blueprint_id: i64, price: &str) -> CacheRow {
    CacheRow {
        provider: "cardtrader",
        blueprint_id,
        pokoin_card_id: blueprint_id.to_string(),
        price_eur: Some(price.to_string()),
        price_pkn: price.to_string(),
        listing_count: 1,
        quantity: 1,
        listing_id: blueprint_id.to_string(),
        product_id: blueprint_id.to_string(),
        shipping_mode: "zero".to_string(),
        country: "IT".to_string(),
        source_snapshot_at: "2026-10-15T00:00:00Z".to_string(),
    }
}
