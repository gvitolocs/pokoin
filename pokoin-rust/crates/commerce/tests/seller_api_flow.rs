//! End-to-end seller API flow on a real Postgres: a seller creates a grant,
//! the tool connects with it, sets stock and lists a card, and every change
//! reaches the event log and the webhook queue.
//!
//! Needs a throwaway database (the test drops and recreates its tables):
//!
//! ```text
//! docker run -d --rm --name pokoin-seller-api-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55473:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55473/postgres \
//!   cargo test -p pokoin-commerce --test seller_api_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped. With
//! `POKOIN_TEST_WEBHOOK_URL=https://…` it also posts the queued webhooks to
//! that public endpoint and prints what it answered.

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

use pokoin_commerce::auth::{AuthError, Claims, TokenVerifier};
use pokoin_commerce::config::CommerceConfig;
use pokoin_commerce::state::DomainState;
use pokoin_commerce::{listing_sync, seller_api};

const LISTINGS_SQL: &str = "
drop table if exists public.seller_api_listing_keys, public.seller_webhook_deliveries,
  public.seller_api_events, public.seller_api_grants, public.marketplace_outbox,
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
create or replace function public.refresh_marketplace_blueprint_price_summary(text)
  returns void language sql as 'select';
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

async fn connector(app: &Router, token: &str, body: Value) -> (StatusCode, Value) {
    call(app, "POST", "/api/cardrails/connector", token, body).await
}

async fn drain(state: &DomainState) {
    for _ in 0..50 {
        if !listing_sync::drain_once(state).await.expect("drain") {
            break;
        }
    }
}

async fn count(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.expect("count")
}

#[tokio::test]
async fn a_grant_connects_sets_stock_lists_and_hears_every_event() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    // No background workers: the test drains the outbox itself and never
    // posts a webhook to the network.
    std::env::set_var("POKOIN_LISTING_SYNC_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_WEBHOOK_WORKER", "0");
    std::env::set_var("POKOIN_READ_CACHE", "0");
    std::env::set_var("CARDTRADER_TOKEN_ENCRYPTION_KEY", "11".repeat(32));

    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.expect("test database");
    run_sql(&pool, LISTINGS_SQL).await;
    run_sql(&pool, "drop table if exists public.scan_batches cascade;
        create table public.scan_batches (id uuid primary key default gen_random_uuid(), seller_uid text not null,
        defaults jsonb not null, status text not null default 'open', updated_at timestamptz not null default now());").await;
    sqlx::query("insert into public.scan_batches (seller_uid, defaults) values ($1, $2), ($3, $4)")
        .bind("seller-1")
        .bind(json!({"language":"IT", "condition":"Poor", "foilState":"reverse", "location":"BIN-07",
            "stackSize":100, "stack":3, "startPosition":42, "quantity":2, "firstEdition":true, "mergeRepeats":false}))
        .bind("seller-2").bind(json!({"language":"DE", "location":"PRIVATE-BOX"}))
        .execute(&pool).await.unwrap();
    run_sql(&pool, include_str!("../../../../scripts/sql/096_marketplace_outbox.sql")).await;
    run_sql(&pool, include_str!("../../../../scripts/sql/115_seller_api_grants.sql")).await;
    let mine: uuid::Uuid = sqlx::query_scalar(
        "insert into public.marketplace_user_listings (card_id, seller_uid, seller_name, seller_country, price_pkn, quantity_available, location, card_name) \
         values ('220962', 'seller-1', 'alice', 'IT', 400, 3, 'BIN-07', 'Espurr') returning id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let theirs: uuid::Uuid = sqlx::query_scalar(
        "insert into public.marketplace_user_listings (card_id, seller_uid, seller_country, price_pkn, quantity_available, location) \
         values ('220962', 'seller-2', 'DE', 400, 5, 'OTHER-BOX') returning id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let state = DomainState::with_pools(CommerceConfig::default(), pool.clone(), pool.clone(), None, Arc::new(UidToken), None);
    let app = pokoin_commerce::router(state.clone());

    // --- the seller creates a Card Rails token ------------------------------
    let (status, created) = call(&app, "POST", "/api/seller-api-grants", "seller-1", json!({"action":"create","client":"Card Rails"})).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let token = created["token"].as_str().unwrap().to_string();
    let secret = created["sharedSecret"].as_str().unwrap().to_string();
    let grant_id = created["grant"]["id"].as_str().unwrap().to_string();
    assert!(token.starts_with("pkn_"));
    assert_eq!(created["grant"]["scope"], "cardrails:stock");

    // Only the hash is stored, and the list never shows the token again.
    let stored: (String, Value) = sqlx::query_as("select token_hash, shared_secret from public.seller_api_grants").fetch_one(&pool).await.unwrap();
    assert_eq!(stored.0, seller_api::token_hash(&token));
    assert!(!stored.1.to_string().contains(&secret), "the shared secret is encrypted at rest");
    let (_, listed) = call(&app, "GET", "/api/seller-api-grants", "seller-1", Value::Null).await;
    assert_eq!(listed["grants"].as_array().unwrap().len(), 1);
    assert!(!listed.to_string().contains(&token) && !listed.to_string().contains(&secret));
    let (_, others) = call(&app, "GET", "/api/seller-api-grants", "seller-2", Value::Null).await;
    assert_eq!(others["grants"], json!([]));

    // --- the tool connects --------------------------------------------------
    let (status, _) = connector(&app, "pkn_not-a-real-token", json!({"action":"connect"})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // A sign-in token is not a grant, and a grant is not a sign-in.
    let (status, _) = connector(&app, "seller-1", json!({"action":"connect"})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, "GET", "/api/seller-api-grants", &token, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, info) = connector(&app, &token, json!({"action":"connect"})).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(info["scope"], "cardrails:stock");
    assert_eq!(info["accountRef"], "seller-1");
    assert_eq!(info["accountName"], "alice");
    assert_eq!(info["cardmarketLinked"], false);
    assert_eq!(info["sharedSecret"], secret);
    assert_eq!(info["locations"], json!([{"label":"BIN-07"}]));
    let (status, settings) = connector(&app, &token, json!({"action":"scan-settings"})).await;
    assert_eq!(status, StatusCode::OK, "{settings}");
    assert_eq!(settings["scanSettings"]["language"], "IT");
    assert_eq!(settings["scanSettings"]["storageLabel"], "BIN-07");
    assert_eq!(settings["scanSettings"]["printing"], "Reverse Holo");
    assert_eq!(settings["scanSettings"]["condition"], "PO");
    assert_eq!(settings["scanSettings"]["stack"], 3);
    assert_eq!(settings["scanSettings"]["startPosition"], 42);
    assert_eq!(settings["scanSettings"]["quantity"], 2);
    assert_eq!(settings["scanSettings"]["firstEdition"], true);
    assert_eq!(settings["scanSettings"]["mergeRepeats"], false);
    let (_, refused_settings) = connector(&app, "pkn_not-a-real-token", json!({"action":"scan-settings"})).await;
    assert!(refused_settings.get("scanSettings").is_none());

    // A generic grant works on the generic path only.
    let (_, other) = call(&app, "POST", "/api/seller-api-grants", "seller-1", json!({"action":"create","client":"My Tool"})).await;
    let other_token = other["token"].as_str().unwrap().to_string();
    assert_eq!(other["grant"]["scope"], "seller:stock");
    let (status, refused) = connector(&app, &other_token, json!({"action":"connect"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    let (status, _) = call(&app, "POST", "/api/seller-api/v1", &other_token, json!({"action":"connect"})).await;
    assert_eq!(status, StatusCode::OK);

    // --- webhook registration, like CardTrader's PATCH /app -----------------
    let (status, _) = connector(&app, &token, json!({"action":"webhook","url":"http://hooks.example.com/x"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = connector(&app, &token, json!({"action":"webhook","url":"https://127.0.0.1/x"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, hook) = connector(&app, &token, json!({"action":"webhook","url":"https://hooks.example.com/x?workspace=w1"})).await;
    assert_eq!(status, StatusCode::OK, "{hook}");
    assert_eq!(hook["webhookUrl"], "https://hooks.example.com/x?workspace=w1");
    assert_eq!(hook["sharedSecret"], secret);

    // --- listings and stock -------------------------------------------------
    let (_, page) = connector(&app, &token, json!({"action":"listings"})).await;
    assert_eq!(page["listings"].as_array().unwrap().len(), 1, "{page}");
    assert_eq!(page["listings"][0]["listingId"], mine.to_string());
    assert_eq!(page["listings"][0]["quantity"], 3);
    assert_eq!(page["listings"][0]["priceEurCents"], 200);

    let stock = |quantity: i64, id: uuid::Uuid| json!({"action":"stock","channel":"pokoin","listingId":id.to_string(),"targetQuantity":quantity,"idempotencyKey":"k"});
    let (status, set) = connector(&app, &token, stock(1, mine)).await;
    assert_eq!(status, StatusCode::OK, "{set}");
    assert_eq!((set["confirmed"].clone(), set["quantity"].clone(), set["changed"].clone()), (json!(true), json!(1), json!(true)));
    let (_, again) = connector(&app, &token, stock(1, mine)).await;
    assert_eq!((again["confirmed"].clone(), again["quantity"].clone(), again["changed"].clone()), (json!(true), json!(1), json!(false)));
    // Another seller's listing does not exist for this grant.
    let (status, _) = connector(&app, &token, stock(1, theirs)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(count(&pool, "select quantity_available::bigint from public.marketplace_user_listings where seller_uid = 'seller-2'").await, 5);
    let (status, _) = connector(&app, &token, stock(100, mine)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = connector(&app, &token, json!({"action":"stock","channel":"cardmarket","listingId":mine.to_string(),"targetQuantity":1})).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Out of stock pauses the listing; stock coming back puts it on sale.
    let (_, empty) = connector(&app, &token, stock(0, mine)).await;
    assert_eq!((empty["quantity"].clone(), empty["status"].clone()), (json!(0), json!("paused")), "{empty}");
    let (_, back) = connector(&app, &token, stock(2, mine)).await;
    assert_eq!((back["quantity"].clone(), back["status"].clone()), (json!(2), json!("active")), "{back}");

    // --- every change is an event, queued once per grant with a webhook -----
    drain(&state).await;
    let (_, log) = call(&app, "POST", "/api/seller-api/v1", &token, json!({"action":"events"})).await;
    let events = log["events"].as_array().unwrap();
    assert_eq!(events.len(), 3, "{log}");
    assert!(events.iter().all(|event| event["cause"] == "listing.update" && event["object_id"] == mine.to_string()));
    assert_eq!(events.iter().map(|event| event["data"]["quantity"].clone()).collect::<Vec<_>>(), vec![json!(1), json!(0), json!(2)]);
    // Only the Card Rails grant has a webhook URL.
    assert_eq!(count(&pool, "select count(*) from public.seller_webhook_deliveries").await, 3);
    assert_eq!(
        count(&pool, &format!("select count(*) from public.seller_webhook_deliveries where grant_id = '{grant_id}' and delivered_at is null")).await,
        3
    );
    // The body that will be posted verifies with the secret the tool read.
    let body: String = sqlx::query_scalar("select body from public.seller_api_events order by id limit 1").fetch_one(&pool).await.unwrap();
    let signature = seller_api::sign(body.as_bytes(), &secret);
    assert!(pokoin_external::crypto::verify_webhook_signature(body.as_bytes(), &signature, &secret));
    // Reading past the cursor returns nothing new.
    let (_, rest) = call(&app, "POST", "/api/seller-api/v1", &token, json!({"action":"events","cursor":log["cursor"]})).await;
    assert_eq!(rest["events"], json!([]));

    // --- list a card, at most once per key ----------------------------------
    let item = json!({"id":"cr_1","identity":{"game":"pokemon","name":"Sylveon","publicId":"555001"},"language":"EN","condition":"NM","finish":"standard","quantity":2,"price":3.5,"currency":"EUR","location":"BIN-09"});
    let (status, listed) = connector(&app, &token, json!({"action":"list","channel":"pokoin","item":item,"idempotencyKey":"list:cr_1"})).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!((listed["confirmed"].clone(), listed["created"].clone(), listed["stockMode"].clone()), (json!(true), json!(true), json!("absolute")));
    let (_, relisted) = connector(&app, &token, json!({"action":"list","channel":"pokoin","item":item,"idempotencyKey":"list:cr_1"})).await;
    assert_eq!((relisted["listingId"].clone(), relisted["created"].clone()), (listed["listingId"].clone(), json!(false)));
    assert_eq!(count(&pool, "select count(*) from public.marketplace_user_listings where seller_uid = 'seller-1'").await, 2);
    let row: (String, i32, String, String, f64) = sqlx::query_as(
        "select card_id, quantity_available, seller_country, location, price_pkn::float8 from public.marketplace_user_listings where card_id = '555001'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row, ("555001".into(), 2, "IT".into(), "BIN-09".into(), 700.0));
    // An item with no Pokoin card id is refused and its key stays free.
    let (status, unmapped) = connector(&app, &token, json!({"action":"list","item":{"identity":{"name":"?"},"quantity":1,"price":1},"idempotencyKey":"list:cr_2"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{unmapped}");
    assert_eq!(count(&pool, "select count(*) from public.seller_api_listing_keys").await, 1);

    // --- sales --------------------------------------------------------------
    let sale = json!({"orderId":"o1","listingId":mine.to_string(),"cardId":"220962","cardName":"Espurr","sellerUid":"seller-1","quantity":1,"unitPricePkn":400,"currency":"PKN","condition":"NM","language":"EN"});
    let foreign = json!({"orderId":"o1","listingId":theirs.to_string(),"cardId":"220962","sellerUid":"seller-2","quantity":4,"unitPricePkn":400,"currency":"PKN"});
    seller_api::log_order_paid(&state, "o1", &[sale.clone(), foreign.clone()]).await;
    // A retried fulfilment logs the order once.
    seller_api::log_order_paid(&state, "o1", &[sale, foreign]).await;
    let (_, sales) = connector(&app, &token, json!({"action":"sales"})).await;
    let orders = sales["orders"].as_array().unwrap();
    assert_eq!(orders.len(), 1, "{sales}");
    assert_eq!((orders[0]["code"].clone(), orders[0]["state"].clone(), orders[0]["cancelled"].clone()), (json!("o1"), json!("paid"), json!(false)));
    // Only this seller's lines, and never the buyer.
    assert_eq!(orders[0]["order_items"].as_array().unwrap().len(), 1);
    assert_eq!(orders[0]["order_items"][0]["listing_id"], mine.to_string());
    assert_eq!(orders[0]["order_items"][0]["quantity"], 1);
    assert!(!sales.to_string().contains("buyer"));
    // The same sale as the flat line Card Rails records.
    assert_eq!(
        sales["sales"],
        json!([{"channel":"pokoin","externalId":mine.to_string(),"quantity":1,"orderRef":"o1","lineId":format!("o1:{mine}:0"),"occurredAt":orders[0]["paid_at"]}])
    );
    seller_api::log_order_cancelled(&state, "o1", "seller-1").await;
    let (_, after) = connector(&app, &token, json!({"action":"sales","cursor":sales["cursor"]})).await;
    assert_eq!(after["orders"].as_array().unwrap().len(), 1);
    assert_eq!(after["orders"][0]["cancelled"], true);
    assert_eq!(after["sales"], json!([]), "a cancelled order is not a sale line");
    // seller-2 has no grant: nothing was logged for them.
    assert_eq!(count(&pool, "select count(*) from public.seller_api_events where seller_uid = 'seller-2'").await, 0);

    // --- delivery (opt-in: it posts to the network) --------------------------
    if let Ok(target) = std::env::var("POKOIN_TEST_WEBHOOK_URL") {
        let pending = count(&pool, "select count(*) from public.seller_webhook_deliveries where delivered_at is null").await;
        sqlx::query("update public.seller_api_grants set webhook_url = $1 where webhook_url <> ''").bind(&target).execute(&pool).await.unwrap();
        let mut claimed = 0;
        while seller_api::deliver_once(&state).await.expect("deliver") {
            claimed += 1;
        }
        assert_eq!(claimed, pending, "every due webhook is attempted once");
        let rows: Vec<(Option<i32>, Option<String>, bool)> =
            sqlx::query_as("select last_status, last_error, delivered_at is not null from public.seller_webhook_deliveries order by id").fetch_all(&pool).await.unwrap();
        for (status, error, delivered) in &rows {
            eprintln!("webhook → {target}: status {status:?} delivered {delivered} error {error:?}");
            assert!(status.is_some(), "the receiver answered: {error:?}");
            assert_eq!(*delivered, (200..300).contains(&status.unwrap()));
        }
        // An attempt that failed is due again later, not now.
        assert!(!seller_api::deliver_once(&state).await.unwrap());
        sqlx::query("update public.seller_api_grants set webhook_url = 'https://hooks.example.com/x?workspace=w1' where webhook_url <> ''").execute(&pool).await.unwrap();
    }

    // New scans get the same exact-facet sold minimum, otherwise the CardTrader tile minimum.
    run_sql(&pool,"DROP TABLE IF EXISTS cardtrader_sold_daily; CREATE TABLE cardtrader_sold_daily(blueprint_id bigint,condition text,language text,reverse bool,first_edition bool,graded bool,sold_qty int,min_pkn numeric,observed_day date); INSERT INTO cardtrader_sold_daily VALUES(370796,'NM','IT',false,false,false,1,38,current_date);").await;
    run_sql(&pool,"CREATE OR REPLACE VIEW cheapest_homepage_cache_blueprint AS SELECT 370796::bigint AS blueprint_id,'cardtrader'::text AS provider,44::numeric AS cheapest_price_pkn;").await;
    let (_, quotes)=connector(&app,&token,json!({"action":"sold-prices","items":[
      {"id":"it","identity":{"publicId":"741592"},"condition":"NM","language":"IT"},
      {"id":"en","identity":{"publicId":"741592"},"condition":"NM","language":"EN"},
      {"id":"absent","identity":{"publicId":"2"},"condition":"NM","language":"IT"}]})).await;
    assert_eq!(quotes["prices"][0]["minEurCents"],19);assert_eq!(quotes["prices"][0]["priceSource"],"sold_exact_30d");
    assert_eq!(quotes["prices"][1]["minEurCents"],22);assert_eq!(quotes["prices"][1]["priceSource"],"cardtrader_tile_minimum");
    assert_eq!(quotes["prices"][2]["minEurCents"],Value::Null);

    // Unpriced stock is inventory, never a free public sale; retries and restocks preserve it.
    run_sql(&pool, include_str!("../../../../scripts/sql/118_unpriced_paused_inventory.sql")).await;
    let body=json!({"action":"list","idempotencyKey":"unpriced-copy","item":{
      "identity":{"publicId":"741592","game":"pokemon"},"quantity":2,"priceEurCents":0,
      "status":"paused","condition":"NM","language":"IT","printing":"Reverse Holo",
      "firstEdition":true,"location":"box·2·42"}});
    let (status, saved)=connector(&app,&token,body.clone()).await;
    assert_eq!(status,StatusCode::OK,"{saved}");let id=saved["listingId"].as_str().unwrap();
    let (_,again)=connector(&app,&token,body).await;assert_eq!(again["listingId"],id);assert_eq!(again["created"],false);
    let row:Value=sqlx::query_scalar("SELECT to_jsonb(l) FROM marketplace_user_listings l WHERE id=$1").bind(uuid::Uuid::parse_str(id).unwrap()).fetch_one(&pool).await.unwrap();
    assert_eq!(row["status"],"paused");assert_eq!(row["price_pkn"],0);assert_eq!(row["reverse"],true);
    assert_eq!(row["first_edition"],true);assert_eq!(row["location"],"box·2·42");
    let (_,empty)=connector(&app,&token,json!({"action":"stock","listingId":id,"targetQuantity":0})).await;
    assert_eq!(empty["quantity"],0);
    let (status,restock)=connector(&app,&token,json!({"action":"stock","listingId":id,"targetQuantity":2})).await;
    assert_eq!(status,StatusCode::OK,"{restock}");assert_eq!(restock["status"],"paused");
    assert!(sqlx::query("UPDATE marketplace_user_listings SET status='active' WHERE id=$1").bind(uuid::Uuid::parse_str(id).unwrap()).execute(&pool).await.is_err());

    // --- test webhook and revoke --------------------------------------------
    let (status, _) = call(&app, "POST", "/api/seller-api-grants", "seller-1", json!({"action":"test","id":other["grant"]["id"]})).await;
    assert_eq!(status, StatusCode::CONFLICT, "a grant with no webhook URL has nothing to test");
    let (status, _) = call(&app, "POST", "/api/seller-api-grants", "seller-1", json!({"action":"test","id":grant_id})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&app, "POST", "/api/seller-api-grants", "seller-2", json!({"action":"revoke","id":grant_id})).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "another seller cannot revoke it");
    let (status, _) = call(&app, "POST", "/api/seller-api-grants", "seller-1", json!({"action":"revoke","id":grant_id})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = connector(&app, &token, json!({"action":"connect"})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a revoked token stops at once");
    assert_eq!(count(&pool, "select count(*) from public.seller_webhook_deliveries where delivered_at is null").await, 0);
    let (_, left) = call(&app, "GET", "/api/seller-api-grants", "seller-1", Value::Null).await;
    assert_eq!(left["grants"].as_array().unwrap().len(), 1);
}
