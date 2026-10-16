//! End-to-end TCGplayer channel sync on a real Postgres: register a box,
//! fan a resync out, claim through the device route, and post an order that
//! lowers stock without counting as a Pokoin sale.
//!
//! Needs a throwaway database (the test drops and recreates its tables):
//!
//! ```text
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55491/postgres \
//!   cargo test -p pokoin-commerce --test channel_sync_flow
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
use uuid::Uuid;

use pokoin_commerce::auth::{AuthError, Claims, TokenVerifier};
use pokoin_commerce::config::CommerceConfig;
use pokoin_commerce::state::DomainState;
use pokoin_commerce::{channel_sync, listing_sync};

const SCHEMA_SQL: &str = "
drop trigger if exists marketplace_user_listings_audit_trg on public.marketplace_user_listings;
drop table if exists public.channel_order_stock_applied, public.channel_orders,
  public.channel_price_rules, public.channel_listing_links, public.channel_sync_jobs,
  public.seller_channel_devices, public.seller_webhook_deliveries, public.seller_api_events,
  public.seller_api_listing_keys, public.seller_api_grants, public.marketplace_outbox,
  public.marketplace_user_listing_events, public.marketplace_listing_stats_daily,
  public.marketplace_user_listings cascade;
create table public.marketplace_user_listings (
  id uuid primary key default gen_random_uuid(),
  card_id text not null,
  seller_uid text not null,
  seller_name text not null default 'Pokoin seller',
  seller_country text not null default 'EU',
  seller_reputation_label text not null default 'New',
  condition text not null default 'NM',
  language text not null default 'EN',
  price_pkn numeric not null check (price_pkn > 0),
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
  updated_at timestamptz not null default now()
);
create table public.marketplace_user_listing_events (
  id bigserial primary key,
  listing_id uuid,
  card_id text not null,
  seller_uid text not null default '',
  event_type text not null,
  quantity_before integer,
  quantity_after integer,
  status_before text,
  status_after text,
  price_pkn numeric,
  occurred_at timestamptz not null default now()
);
create table public.marketplace_listing_stats_daily (
  card_id text not null,
  observed_day date not null,
  source text not null,
  new_listings integer not null default 0,
  new_quantity integer not null default 0,
  sold_listings integer not null default 0,
  sold_quantity integer not null default 0,
  refreshed_at timestamptz not null default now(),
  primary key (card_id, observed_day, source)
);
drop trigger if exists marketplace_user_listings_audit_trg on public.marketplace_user_listings;
";

const TRIGGER_SQL: &str = "
create trigger marketplace_user_listings_audit_trg
  after insert or update or delete on public.marketplace_user_listings
  for each row
  execute procedure public.marketplace_user_listings_audit();
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

async fn call(app: &Router, method: &str, path: &str, bearer: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {bearer}"))
        .header("content-type", "application/json")
        .body(if method == "GET" { Body::empty() } else { Body::from(body.to_string()) })
        .unwrap();
    let response = app.clone().oneshot(request).await.expect("router");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn seller(app: &Router, body: Value) -> (StatusCode, Value) {
    call(app, "POST", "/api/channel-sync?channel=tcgplayer", "seller-1", body).await
}

async fn device(app: &Router, token: &str, body: Value) -> (StatusCode, Value) {
    call(app, "POST", "/api/channel-sync/device", token, body).await
}

async fn count(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.expect("count")
}

async fn seed(pool: &PgPool, card: &str, game: &str, sealed: bool, graded: bool, qty: i32) -> Uuid {
    sqlx::query_scalar(
        "insert into public.marketplace_user_listings \
         (card_id, seller_uid, price_pkn, quantity_available, sealed, graded, marketplace_game, \
          card_name, set_name, collector_number, status) \
         values ($1, 'seller-1', 74036, $2, $3, $4, $5, $6, 'Test Set', '1/100', 'active') returning id",
    )
    .bind(card)
    .bind(qty)
    .bind(sealed)
    .bind(graded)
    .bind(game)
    .bind(card)
    .fetch_one(pool)
    .await
    .expect("seed")
}

fn listing_id(job: &Value) -> &str {
    job["listingId"].as_str().unwrap_or("")
}

#[tokio::test]
async fn a_box_syncs_listings_and_a_channel_sale_is_not_a_pokoin_sale() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    std::env::set_var("POKOIN_LISTING_SYNC_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_WEBHOOK_WORKER", "0");
    std::env::set_var("POKOIN_READ_CACHE", "0");
    std::env::set_var("CARDTRADER_TOKEN_ENCRYPTION_KEY", "11".repeat(32));

    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.expect("test database");
    run_sql(&pool, SCHEMA_SQL).await;
    run_sql(&pool, include_str!("../../../../scripts/sql/096_marketplace_outbox.sql")).await;
    run_sql(&pool, include_str!("../../../../scripts/sql/115_seller_api_grants.sql")).await;
    run_sql(&pool, include_str!("../../../../scripts/sql/126_channel_sync.sql")).await;
    run_sql(&pool, include_str!("../../../../scripts/sql/127_channel_synced_audit.sql")).await;
    run_sql(&pool, TRIGGER_SQL).await;

    let linked = seed(&pool, "card-linked", "pokemon", false, false, 2).await;
    let other = seed(&pool, "card-other", "pokemon", false, false, 1).await;
    seed(&pool, "card-sealed", "pokemon", true, false, 3).await;
    seed(&pool, "card-graded", "pokemon", false, true, 3).await;
    seed(&pool, "card-lorcana", "lorcana", false, false, 3).await;
    seed(&pool, "card-zero", "pokemon", false, false, 0).await;

    let state = DomainState::with_pools(CommerceConfig::default(), pool.clone(), pool.clone(), None, Arc::new(UidToken), None);
    let app = pokoin_commerce::router(state.clone());

    // 1. Register, then enable fans out only the two eligible singles.
    let (status, registered) = seller(&app, json!({"action": "register-device", "label": "desk"})).await;
    assert_eq!(status, StatusCode::OK, "{registered}");
    let token = registered["token"].as_str().unwrap().to_string();
    assert!(token.starts_with("pkn_"), "{token}");
    let (status, page) = call(&app, "GET", "/api/channel-sync?channel=tcgplayer", "seller-1", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["badges"]["usingSync"], false);
    assert!(!page.to_string().contains(&token), "the token is shown once");

    let (status, enabled) = seller(&app, json!({"action": "enable"})).await;
    assert_eq!(status, StatusCode::OK, "{enabled}");
    let resync: Value = sqlx::query_scalar(
        "select result from public.channel_sync_jobs where kind = 'full_resync' and status = 'done'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(resync["queued"].as_i64(), Some(2), "{resync}");
    assert_eq!(count(&pool, "select count(*) from public.channel_sync_jobs where kind = 'set_qty' and status = 'pending'").await, 2);

    // 2. A box token cannot write stock. A stock token cannot drive the box.
    let (status, stock_grant) = call(
        &app,
        "POST",
        "/api/seller-api-grants",
        "seller-1",
        json!({"action": "create", "client": "Shop Tool"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{stock_grant}");
    let stock_token = stock_grant["token"].as_str().unwrap();
    let (status, refused) = call(&app, "POST", "/api/seller-api/v1", &token, json!({"action": "connect"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["code"], "channel_sync/wrong-scope");
    let (status, refused) = device(&app, stock_token, json!({"action": "heartbeat"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["code"], "channel_sync/wrong-scope");

    // 3. Two heartbeats schedule one pull, and the seller sees the box online.
    let (status, beat) = device(&app, &token, json!({"action": "heartbeat", "signedIn": true, "running": true, "version": "test"})).await;
    assert_eq!(status, StatusCode::OK, "{beat}");
    assert_eq!(beat["enabled"], true);
    let (status, beat) = device(&app, &token, json!({"action": "heartbeat", "signedIn": true, "running": true, "version": "test"})).await;
    assert_eq!(status, StatusCode::OK, "{beat}");
    assert_eq!(count(&pool, "select count(*) from public.channel_sync_jobs where kind = 'pull_orders'").await, 1);
    let (status, page) = call(&app, "GET", "/api/channel-sync?channel=tcgplayer", "seller-1", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["badges"]["usingSync"], true);
    assert_eq!(page["badges"]["online"], true);
    assert_eq!(page["badges"]["running"], true);
    assert_eq!(page["badges"]["signedIn"], true);

    // 4. Claim hands the two singles out as pushes, plus the pull.
    let (status, claimed) = device(&app, &token, json!({"action": "claim", "max": 5})).await;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    let jobs = claimed["jobs"].as_array().unwrap();
    assert_eq!(jobs.len(), 3, "{claimed}");
    let pushes: Vec<&Value> = jobs.iter().filter(|job| job["kind"] == "push_listing").collect();
    assert_eq!(pushes.len(), 2, "{claimed}");
    assert!(jobs.iter().any(|job| job["kind"] == "pull_orders"), "{claimed}");
    let push = pushes.iter().copied().find(|job| listing_id(job) == linked.to_string()).expect("linked push");
    assert!(push["externalId"].is_null(), "{push}");
    let job_id = push["jobId"].as_i64().unwrap();
    let lease = push["leaseToken"].as_str().unwrap().to_string();
    let before: (String, i32, String) = sqlx::query_as(
        "select status, attempts, updated_at::text from public.channel_sync_jobs where id = $1",
    )
    .bind(job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(before.0, "claimed");

    let row: Value = sqlx::query_scalar("select to_jsonb(l.*) from public.marketplace_user_listings l where id = $1")
        .bind(linked)
        .fetch_one(&pool)
        .await
        .unwrap();
    let envelope = listing_sync::event(
        &row,
        &json!({"game": "pokemon", "sellerUid": "seller-1", "mutation": "LISTING_QUANTITY_CHANGED"}),
        state.now_ms(),
    )
    .expect("listing event");
    channel_sync::enqueue_for_event(&state, &envelope["payload"]).await.expect("enqueue");
    let after: (String, i32, String) = sqlx::query_as(
        "select status, attempts, updated_at::text from public.channel_sync_jobs where id = $1",
    )
    .bind(job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after, before, "the claimed row keeps the numbers it was given");
    let pending: i64 = sqlx::query_scalar(
        "select count(*) from public.channel_sync_jobs \
         where seller_uid = 'seller-1' and kind = 'set_qty' and listing_key = $1 and status = 'pending' and id <> $2",
    )
    .bind(linked.to_string())
    .bind(job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pending, 1, "the newer edit is its own pending row");

    let (status, missing) = device(
        &app,
        &token,
        json!({"action": "complete", "jobId": job_id, "leaseToken": lease, "outcome": "done"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{missing}");
    assert_eq!(missing["code"], "channel_sync/external-id");
    assert_eq!(count(&pool, "select count(*) from public.channel_listing_links").await, 0);

    let (status, done) = device(
        &app,
        &token,
        json!({"action": "complete", "jobId": job_id, "leaseToken": lease, "outcome": "done", "externalId": "sku-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert!(done.get("sharedSku").is_none(), "{done}");
    let link: (String, i32, i32) = sqlx::query_as(
        "select external_id, last_qty, last_price_cents from public.channel_listing_links where listing_id = $1",
    )
    .bind(linked)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(link, ("sku-1".into(), 2, 37018));

    // 5. A stale lease cannot finish the other claimed push.
    let other_push = pushes.iter().copied().find(|job| listing_id(job) == other.to_string()).expect("other push");
    let other_id = other_push["jobId"].as_i64().unwrap();
    let other_lease = other_push["leaseToken"].as_str().unwrap();
    let (status, lost) = device(
        &app,
        &token,
        json!({"action": "complete", "jobId": other_id, "leaseToken": "00000000-0000-0000-0000-000000000000", "outcome": "retry"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{lost}");
    assert_eq!(lost["code"], "channel_sync/lease-lost");

    // 6. Claim counts the attempt. The eighth one, retried, is dead.
    let (status, retried) = device(
        &app,
        &token,
        json!({"action": "complete", "jobId": other_id, "leaseToken": other_lease, "outcome": "retry"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{retried}");
    assert_eq!(retried["status"], "pending");
    sqlx::query("update public.channel_sync_jobs set attempts = 7, available_at = now() where id = $1")
        .bind(other_id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, again) = device(&app, &token, json!({"action": "claim", "max": 5})).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    let again_jobs = again["jobs"].as_array().unwrap();
    let dying = again_jobs.iter().find(|job| job["jobId"].as_i64() == Some(other_id)).expect("reclaimed");
    let (status, dead) = device(
        &app,
        &token,
        json!({"action": "complete", "jobId": other_id, "leaseToken": dying["leaseToken"], "outcome": "retry"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{dead}");
    assert_eq!(dead["status"], "dead");
    let dead_status: String = sqlx::query_scalar("select status from public.channel_sync_jobs where id = $1")
        .bind(other_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(dead_status, "dead");

    // The newer edit of the linked listing was claimed beside the dying job.
    // Put it back so disable still has a pending row to skip.
    if let Some(twin) = again_jobs.iter().find(|job| job["jobId"].as_i64() != Some(other_id) && job["kind"] != "pull_orders") {
        let (status, back) = device(
            &app,
            &token,
            json!({"action": "complete", "jobId": twin["jobId"], "leaseToken": twin["leaseToken"], "outcome": "needs_sign_in"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{back}");
        assert_eq!(back["status"], "pending");
    }

    // Orders from before the SKU was linked, and orders with no date, are stored
    // and do not move stock.
    let qty_before: i32 = sqlx::query_scalar("select quantity_available from public.marketplace_user_listings where id = $1")
        .bind(linked)
        .fetch_one(&pool)
        .await
        .unwrap();
    let (status, old) = device(
        &app,
        &token,
        json!({"action": "orders", "orders": [{
            "externalOrderId": "tcg-old",
            "status": "paid",
            "placedAt": "2000-01-01T00:00:00Z",
            "lines": [{"externalId": "sku-1", "quantity": 1, "lineKey": "old-1"}]
        }]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{old}");
    assert_eq!(old["stockApplied"], 0);
    assert_eq!(old["skippedBeforeLink"], 1);
    let (status, undated) = device(
        &app,
        &token,
        json!({"action": "orders", "orders": [{
            "externalOrderId": "tcg-nodate",
            "status": "paid",
            "lines": [{"externalId": "sku-1", "quantity": 1, "lineKey": "nodate-1"}]
        }]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{undated}");
    assert_eq!(undated["stockApplied"], 0);
    assert_eq!(undated["skippedNoDate"], 1);
    let qty_held: i32 = sqlx::query_scalar("select quantity_available from public.marketplace_user_listings where id = $1")
        .bind(linked)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(qty_held, qty_before);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "select count(*) from public.channel_orders where external_order_id in ('tcg-old', 'tcg-nodate')"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        2
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "select count(*) from public.channel_order_stock_applied where external_order_id in ('tcg-old', 'tcg-nodate')"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );

    // 7. The order lowers stock once and the audit records channel_synced.
    let order = json!({"action": "orders", "orders": [{
        "externalOrderId": "tcg-1",
        "status": "paid",
        "placedAt": "2099-01-01T00:00:00Z",
        "lines": [{"externalId": "sku-1", "quantity": 1, "lineKey": "line-1"}]
    }]});
    let (status, posted) = device(&app, &token, order.clone()).await;
    assert_eq!(status, StatusCode::OK, "{posted}");
    assert_eq!(posted["stockApplied"], 1);
    let qty: i32 = sqlx::query_scalar("select quantity_available from public.marketplace_user_listings where id = $1")
        .bind(linked)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(qty, 1);
    let events: i64 = sqlx::query_scalar(
        "select count(*) from public.marketplace_user_listing_events \
         where listing_id = $1 and event_type = 'channel_synced'",
    )
    .bind(linked)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(events, 1);
    let sold: i64 = sqlx::query_scalar(
        "select count(*) from public.marketplace_user_listing_events \
         where listing_id = $1 and event_type in ('sold', 'quantity_decreased')",
    )
    .bind(linked)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(sold, 0);
    let sold_qty: i32 = sqlx::query_scalar(
        "select coalesce(sum(sold_quantity), 0)::int from public.marketplace_listing_stats_daily where card_id = 'card-linked'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(sold_qty, 0);
    assert_eq!(count(&pool, "select count(*) from public.marketplace_outbox where event_type = 'listing.changed'").await, 1);

    let (status, posted) = device(&app, &token, order).await;
    assert_eq!(status, StatusCode::OK, "{posted}");
    assert_eq!(posted["stockApplied"], 0);
    let qty_again: i32 = sqlx::query_scalar("select quantity_available from public.marketplace_user_listings where id = $1")
        .bind(linked)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(qty_again, 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "select count(*) from public.marketplace_user_listing_events where listing_id = $1 and event_type = 'channel_synced'"
        )
        .bind(linked)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );

    let (status, cancelled) = device(
        &app,
        &token,
        json!({"action": "orders", "orders": [{
            "externalOrderId": "tcg-cancel",
            "status": "Cancelled",
            "lines": [{"externalId": "sku-1", "quantity": 1}]
        }]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["stockApplied"], 0);
    assert_eq!(cancelled["skippedCancelled"], 1);
    let qty_cancelled: i32 = sqlx::query_scalar("select quantity_available from public.marketplace_user_listings where id = $1")
        .bind(linked)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(qty_cancelled, 1);

    // A second listing may link the same SKU. The link is stored and the response says so.
    let twin = seed(&pool, "card-twin", "pokemon", false, false, 1).await;
    let twin_lease = Uuid::new_v4();
    let twin_job: i64 = sqlx::query_scalar(
        "insert into public.channel_sync_jobs \
         (seller_uid, channel, kind, listing_key, status, attempts, lease_token, lease_until, claimed_kind) \
         values ('seller-1', 'tcgplayer', 'set_qty', $1, 'claimed', 1, $2, now() + interval '5 minutes', 'set_qty') \
         returning id",
    )
    .bind(twin.to_string())
    .bind(twin_lease)
    .fetch_one(&pool)
    .await
    .unwrap();
    let (status, shared) = device(
        &app,
        &token,
        json!({"action": "complete", "jobId": twin_job, "leaseToken": twin_lease.to_string(), "outcome": "done", "externalId": "sku-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{shared}");
    assert_eq!(shared["sharedSku"], true, "{shared}");
    let shared_links: i64 = sqlx::query_scalar(
        "select count(*) from public.channel_listing_links where seller_uid = 'seller-1' and external_id = 'sku-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(shared_links, 2);

    // 8. Disable skips what is still open. A change while off counts on that row.
    let (status, off) = seller(&app, json!({"action": "disable"})).await;
    assert_eq!(status, StatusCode::OK, "{off}");
    let open: i64 = count(&pool, "select count(*) from public.channel_sync_jobs where status in ('pending', 'claimed')").await;
    assert_eq!(open, 0);
    let skipped: (i64, i32) = sqlx::query_as(
        "select count(*)::bigint, coalesce(max(skip_count), 0)::int from public.channel_sync_jobs \
         where seller_uid = 'seller-1' and kind = 'set_qty' and listing_key = $1 \
           and status = 'skipped' and skip_reason = 'device_not_enabled'",
    )
    .bind(linked.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(skipped.0, 1, "one skipped row for the listing");
    assert_eq!(skipped.1, 1);

    let row: Value = sqlx::query_scalar("select to_jsonb(l.*) from public.marketplace_user_listings l where id = $1")
        .bind(linked)
        .fetch_one(&pool)
        .await
        .unwrap();
    let envelope = listing_sync::event(
        &row,
        &json!({"game": "pokemon", "sellerUid": "seller-1", "mutation": "LISTING_QUANTITY_CHANGED"}),
        state.now_ms(),
    )
    .expect("listing event");
    channel_sync::enqueue_for_event(&state, &envelope["payload"]).await.expect("enqueue while off");
    let bumped: (i64, i32) = sqlx::query_as(
        "select count(*)::bigint, coalesce(max(skip_count), 0)::int from public.channel_sync_jobs \
         where seller_uid = 'seller-1' and kind = 'set_qty' and listing_key = $1 \
           and status = 'skipped' and skip_reason = 'device_not_enabled'",
    )
    .bind(linked.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(bumped, (1, 2), "the disabled edit increments the one skipped row");
}
