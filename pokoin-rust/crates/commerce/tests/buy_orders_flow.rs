//! BuySell buy orders against a real Postgres: create, the book / board /
//! mine reads, expiry, cancel, patch, "Sell now" (a real listing plus a fill),
//! withdrawn listings giving the quantity back, `for-my-listings`, and the
//! last-copy race. Applies the real migrations
//! `scripts/sql/142_marketplace_buy_orders.sql` and
//! `scripts/sql/143_buy_order_fill_seller_message.sql`, each twice (they are
//! idempotent).
//!
//! Needs a throwaway server (the test drops and recreates its databases):
//!
//! ```text
//! docker run -d --rm --name pokoin-buysell-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55512:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55512/postgres \
//!   cargo test -p pokoin-commerce --test buy_orders_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the tests are skipped.

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

const LISTINGS_SQL: &str = include_str!("sql/flow_buy_orders.sql");
const BASE: &str = "/api/marketplace-buy-orders";

struct UidToken;
#[async_trait]
impl TokenVerifier for UidToken {
    async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        if token.is_empty() {
            return Err(AuthError::Invalid("empty".into()));
        }
        Ok(Claims {
            uid: token.into(),
            ..Default::default()
        })
    }
}

async fn run_sql(pool: &PgPool, sql: &str) {
    sqlx::raw_sql(sql).execute(pool).await.expect("schema");
}

/// A fresh database with the listings table, the outbox and the migration.
async fn database(url: &str, name: &str) -> (PgPool, Router) {
    std::env::set_var("POKOIN_LISTING_SYNC_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_WEBHOOK_WORKER", "0");
    std::env::set_var("POKOIN_READ_CACHE", "0");
    let admin = PgPoolOptions::new()
        .max_connections(2)
        .connect(url)
        .await
        .expect("test server");
    run_sql(
        &admin,
        &format!("drop database if exists {name} with (force)"),
    )
    .await;
    run_sql(&admin, &format!("create database {name}")).await;
    let (server, _) = url.rsplit_once('/').unwrap();
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&format!("{server}/{name}"))
        .await
        .unwrap();
    run_sql(&pool, LISTINGS_SQL).await;
    run_sql(
        &pool,
        include_str!("../../../../scripts/sql/096_marketplace_outbox.sql"),
    )
    .await;
    run_sql(
        &pool,
        include_str!("../../../../scripts/sql/142_marketplace_buy_orders.sql"),
    )
    .await;
    // Idempotent: applying it twice is fine.
    run_sql(
        &pool,
        include_str!("../../../../scripts/sql/142_marketplace_buy_orders.sql"),
    )
    .await;
    for _ in 0..2 {
        run_sql(
            &pool,
            include_str!("../../../../scripts/sql/143_buy_order_fill_seller_message.sql"),
        )
        .await;
    }
    let state = DomainState::with_pools(
        CommerceConfig::default(),
        pool.clone(),
        pool.clone(),
        None,
        Arc::new(UidToken),
        None,
    );
    (pool, pokoin_commerce::router(state))
}

/// `who` is the bearer token, which this verifier turns into the uid; "" sends none.
async fn send(
    app: &Router,
    who: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !who.is_empty() {
        request = request.header("authorization", format!("Bearer {who}"));
    }
    let request = request
        .body(
            body.map(|b| Body::from(b.to_string()))
                .unwrap_or_else(Body::empty),
        )
        .unwrap();
    let response = app.clone().oneshot(request).await.expect("router");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn order_body(card: &str, condition: &str, language: &str, price: f64, quantity: i64) -> Value {
    json!({
        "card_id": card, "condition": condition, "language": language, "price_pkn": price, "quantity": quantity, "days": 7,
        "card_name": "Pikachu", "card_image_url": "https://img/pikachu.jpg", "set_name": "Base Set", "collector_number": "58/102",
        "buyer_name": "Ash",
    })
}

async fn create(app: &Router, who: &str, body: Value) -> String {
    let (status, order) = send(app, who, "POST", BASE, Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{order}");
    order["id"].as_str().unwrap().to_string()
}

async fn mine(app: &Router, who: &str) -> Vec<Value> {
    let (status, body) = send(app, who, "GET", &format!("{BASE}/mine"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["items"].as_array().unwrap().clone()
}

async fn order_of(app: &Router, who: &str, id: &str) -> Value {
    mine(app, who)
        .await
        .into_iter()
        .find(|item| item["id"] == id)
        .unwrap_or_else(|| panic!("{id} not in mine"))
}

async fn book(app: &Router, card: &str) -> Vec<Value> {
    let (status, body) = send(app, "", "GET", &format!("{BASE}?card_id={card}"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["card_id"], card);
    body["book"].as_array().unwrap().clone()
}

async fn board_ids(app: &Router, query: &str) -> Vec<String> {
    let (status, body) = send(app, "", "GET", &format!("{BASE}/board{query}"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_string())
        .collect()
}

async fn listing(
    pool: &PgPool,
    seller: &str,
    card: &str,
    condition: &str,
    language: &str,
    reverse: bool,
    price: f64,
) -> String {
    sqlx::query_scalar(
        "insert into public.marketplace_user_listings (card_id, seller_uid, condition, language, reverse, price_pkn, card_name, set_name, collector_number) \
         values ($1, $2, $3, $4, $5, $6::float8, 'Pikachu', 'Base Set', '58/102') returning id::text",
    )
    .bind(card)
    .bind(seller)
    .bind(condition)
    .bind(language)
    .bind(reverse)
    .bind(price)
    .fetch_one(pool)
    .await
    .expect("listing")
}

async fn set_listing_status(pool: &PgPool, id: &str, status: &str) {
    sqlx::query("update public.marketplace_user_listings set status = $2 where id = $1::uuid")
        .bind(id)
        .bind(status)
        .execute(pool)
        .await
        .unwrap();
}

async fn sell(app: &Router, who: &str, order: &str, quantity: i64) -> (StatusCode, Value) {
    send(
        app,
        who,
        "POST",
        &format!("{BASE}/{order}/sell"),
        Some(json!({ "quantity": quantity, "sellerCountry": "DK" })),
    )
    .await
}

fn error_code(body: &Value) -> &str {
    body["code"].as_str().unwrap_or_default()
}

/// `send` without parsing: a leak check reads the bytes on the wire.
async fn raw(app: &Router, who: &str, method: &str, path: &str) -> (StatusCode, String) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !who.is_empty() {
        request = request.header("authorization", format!("Bearer {who}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .expect("router");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

/// The note is nowhere in what this endpoint just wrote down.
fn refute_note(where_: &str, body: &str, probes: &[&str]) {
    for probe in probes {
        assert!(
            !body.contains(probe),
            "{where_} carries the note ({probe}): {body}"
        );
    }
}

/// `seller_message` of the fill of one listing.
async fn fill_note(pool: &PgPool, order: &str, listing_id: &str) -> String {
    sqlx::query_scalar(
        "select f.seller_message from public.marketplace_buy_order_fills f \
           join public.marketplace_user_listings l on l.id = f.listing_id \
         where f.buy_order_id = $1::uuid and f.listing_id = $2::uuid",
    )
    .bind(order)
    .bind(listing_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn listing_comment(pool: &PgPool, listing_id: &str) -> String {
    sqlx::query_scalar(
        "select seller_comment from public.marketplace_user_listings where id = $1::uuid",
    )
    .bind(listing_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn note_sale(
    app: &Router,
    who: &str,
    order: &str,
    quantity: i64,
    note: &str,
) -> (StatusCode, Value) {
    send(
        app,
        who,
        "POST",
        &format!("{BASE}/{order}/sell"),
        Some(json!({
            "quantity": quantity, "sellerCountry": "DK", "buyer_message": note,
            "sellerComment": "my own listing comment",
        })),
    )
    .await
}

/// What one order would have left behind: its fills and its sell listings.
async fn footprint(pool: &PgPool, order: &str) -> (i64, i64) {
    sqlx::query_as(
        "select (select count(*) from public.marketplace_buy_order_fills where buy_order_id = $1::uuid), \
                (select count(*) from public.marketplace_user_listings where source = 'buy_order' and source_listing_id = $1)",
    )
    .bind(order)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn buy_orders_book_board_sell_and_withdraw() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let (pool, app) = database(&url, "buy_orders_flow").await;

    // --- create: appears in mine, book and board; never shows the buyer uid.
    let a = create(&app, "buyer-1", order_body("202", "nm", "en", 100.0, 2)).await;
    let created = order_of(&app, "buyer-1", &a).await;
    assert_eq!(
        (
            created["state"].clone(),
            created["remaining"].clone(),
            created["quantity"].clone()
        ),
        (json!("open"), json!(2), json!(2))
    );
    assert_eq!(
        (created["condition"].clone(), created["language"].clone()),
        (json!("NM"), json!("EN"))
    );
    assert_eq!(created["fills"], json!([]));
    assert!(created["expires_at"].is_string());
    let (status, again) = send(
        &app,
        "buyer-1",
        "POST",
        BASE,
        Some(order_body("202", "NM", "EN", 100.0, 2)),
    )
    .await;
    assert_eq!(
        (status, error_code(&again), again["id"].as_str()),
        (
            StatusCode::CONFLICT,
            "duplicate_buy_order",
            Some(a.as_str())
        )
    );
    let rows = book(&app, "202").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (
            rows[0]["best_price_pkn"].clone(),
            rows[0]["quantity"].clone(),
            rows[0]["orders"].clone()
        ),
        (json!(100), json!(2), json!(1))
    );
    assert_eq!(rows[0]["best_order_id"], a.as_str());
    assert_eq!(rows[0]["best_remaining"], 2);
    assert_eq!(
        (rows[0]["reverse"].clone(), rows[0]["first_edition"].clone()),
        (json!(false), json!(false))
    );
    assert_eq!(board_ids(&app, "").await, vec![a.clone()]);
    let (_, board) = send(&app, "", "GET", &format!("{BASE}/board"), None).await;
    assert_eq!(board["next"], Value::Null);
    assert_eq!(board["items"][0]["buyer_name"], "Ash");
    assert_eq!(board["items"][0]["card_name"], "Pikachu");
    assert!(
        !board.to_string().contains("buyer-1")
            && !serde_json::to_string(&rows).unwrap().contains("buyer-1"),
        "the buyer uid is never public"
    );
    // The public reads are cacheable briefly.
    let cached = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("{BASE}?card_id=202"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        cached.headers().get("cache-control").unwrap(),
        "public, max-age=15"
    );
    // A game that has no orders sees none.
    let (_, other_game) = send(
        &app,
        "",
        "GET",
        &format!("{BASE}?card_id=202&game=yugioh"),
        None,
    )
    .await;
    assert_eq!(other_game["book"], json!([]));

    // --- validation.
    for (patch, code) in [
        (json!({ "condition": "Mint" }), "invalid_condition"),
        (json!({ "language": "XX" }), "invalid_language"),
        (json!({ "price_pkn": 0 }), "invalid_price"),
        (json!({ "price_pkn": 1.0e12 }), "invalid_price"),
        (json!({ "quantity": 11 }), "invalid_quantity"),
        (json!({ "days": 5 }), "invalid_days"),
        (json!({ "card_id": "" }), "invalid_card"),
    ] {
        let mut body = order_body("999", "NM", "EN", 5.0, 1);
        for (key, value) in patch.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, error) = send(&app, "buyer-1", "POST", BASE, Some(body)).await;
        assert_eq!(
            (status, error_code(&error)),
            (StatusCode::BAD_REQUEST, code),
            "{error}"
        );
    }
    assert_eq!(book(&app, "999").await.len(), 0);

    // --- a second buyer on the same facets: the book merges, best price wins.
    let b = create(&app, "buyer-2", order_body("202", "NM", "EN", 150.0, 1)).await;
    let rows = book(&app, "202").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (
            rows[0]["best_price_pkn"].clone(),
            rows[0]["quantity"].clone(),
            rows[0]["orders"].clone()
        ),
        (json!(150), json!(3), json!(2))
    );
    assert_eq!(rows[0]["best_order_id"], b.as_str());
    assert_eq!(
        rows[0]["best_remaining"], 1,
        "the best order alone, not the facet total of 3"
    );
    // Highest price first on the board's price sort, newest first on recent.
    assert_eq!(
        board_ids(&app, "?sort=price").await,
        vec![b.clone(), a.clone()]
    );
    assert_eq!(
        board_ids(&app, "?sort=recent").await,
        vec![b.clone(), a.clone()]
    );
    // Equal best prices: the oldest order is the best one.
    let t1 = create(&app, "buyer-1", order_body("tie", "NM", "EN", 50.0, 1)).await;
    let _t2 = create(&app, "buyer-2", order_body("tie", "NM", "EN", 50.0, 1)).await;
    assert_eq!(book(&app, "tie").await[0]["best_order_id"], t1.as_str());
    assert_eq!(book(&app, "tie").await[0]["best_remaining"], 1);

    // --- expiry hides it everywhere public and reports `expired`.
    sqlx::query("update public.marketplace_buy_orders set expires_at = now() - interval '1 minute' where id = $1::uuid").bind(&b).execute(&pool).await.unwrap();
    assert_eq!(order_of(&app, "buyer-2", &b).await["state"], "expired");
    let rows = book(&app, "202").await;
    assert_eq!(
        (rows[0]["best_price_pkn"].clone(), rows[0]["orders"].clone()),
        (json!(100), json!(1))
    );
    assert_eq!(rows[0]["best_order_id"], a.as_str());
    assert_eq!(rows[0]["best_remaining"], 2);
    assert!(board_ids(&app, "?limit=60").await.contains(&a));
    assert!(!board_ids(&app, "?limit=60").await.contains(&b));
    let (status, error) = sell(&app, "seller-1", &b, 1).await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::CONFLICT, "not_open"),
        "{error}"
    );
    // An expired order can be re-timed: patching days brings it back.
    let (status, patched) = send(
        &app,
        "buyer-2",
        "PATCH",
        &format!("{BASE}/{b}"),
        Some(json!({ "days": 30 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{patched}");
    assert_eq!(patched["state"], "open");
    assert_eq!(book(&app, "202").await[0]["orders"], 2);

    // --- cancel: idempotent, owner only, no further edits.
    let (status, _) = send(&app, "buyer-1", "DELETE", &format!("{BASE}/{b}"), None).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "another user cannot cancel it"
    );
    for _ in 0..2 {
        let (status, cancelled) =
            send(&app, "buyer-2", "DELETE", &format!("{BASE}/{b}"), None).await;
        assert_eq!(
            (status, cancelled["state"].clone()),
            (StatusCode::OK, json!("cancelled")),
            "{cancelled}"
        );
    }
    let (status, error) = send(
        &app,
        "buyer-2",
        "PATCH",
        &format!("{BASE}/{b}"),
        Some(json!({ "price_pkn": 5 })),
    )
    .await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::CONFLICT, "not_editable")
    );
    let (status, _) = send(
        &app,
        "buyer-2",
        "DELETE",
        &format!("{BASE}/00000000-0000-4000-8000-0000000000ff"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &app,
        "buyer-2",
        "DELETE",
        &format!("{BASE}/not-a-uuid"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(book(&app, "202").await[0]["orders"], 1);
    assert_eq!(order_of(&app, "buyer-2", &b).await["state"], "cancelled");

    // --- patch: price, quantity, days; owner only.
    let (status, patched) = send(
        &app,
        "buyer-1",
        "PATCH",
        &format!("{BASE}/{a}"),
        Some(json!({ "price_pkn": 120, "quantity": 3, "days": null })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{patched}");
    assert_eq!(
        (
            patched["price_pkn"].clone(),
            patched["quantity"].clone(),
            patched["remaining"].clone()
        ),
        (json!(120), json!(3), json!(3))
    );
    assert_eq!(patched["expires_at"], Value::Null);
    let (status, _) = send(
        &app,
        "buyer-2",
        "PATCH",
        &format!("{BASE}/{a}"),
        Some(json!({ "price_pkn": 1 })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, error) = send(
        &app,
        "buyer-1",
        "PATCH",
        &format!("{BASE}/{a}"),
        Some(json!({})),
    )
    .await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::BAD_REQUEST, "nothing_to_update")
    );

    // --- for-my-listings: exact facets only, never the caller's own orders.
    let c = create(&app, "buyer-2", order_body("202", "NM", "EN", 130.0, 1)).await;
    let _sp = create(&app, "buyer-2", order_body("202", "SP", "EN", 500.0, 1)).await;
    let _jp = create(&app, "buyer-2", order_body("202", "NM", "JP", 500.0, 1)).await;
    let mut reverse = order_body("202", "NM", "EN", 500.0, 1);
    reverse["reverse"] = json!(true);
    let _rev = create(&app, "buyer-2", reverse).await;
    let l1 = listing(&pool, "seller-1", "202", "NM", "EN", false, 90.0).await;
    let _dearer = listing(&pool, "seller-1", "202", "NM", "EN", false, 95.0).await;
    let (status, matches) = send(
        &app,
        "seller-1",
        "GET",
        &format!("{BASE}/for-my-listings"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{matches}");
    let items = matches["items"].as_array().unwrap();
    assert_eq!(
        items
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![c.as_str(), a.as_str()]
    );
    assert_eq!(
        items[0]["my_listing_id"],
        l1.as_str(),
        "the cheapest matching listing"
    );
    assert_eq!(items[0]["my_price_pkn"], 90);
    assert!(items[0].get("buyer_uid").is_none());
    // buyer-1 has a matching listing too: C qualifies, their own A does not.
    let own = listing(&pool, "buyer-1", "202", "NM", "EN", false, 80.0).await;
    let (_, matches) = send(
        &app,
        "buyer-1",
        "GET",
        &format!("{BASE}/for-my-listings"),
        None,
    )
    .await;
    assert_eq!(
        matches["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![c.as_str()]
    );
    // A paused listing matches nothing.
    set_listing_status(&pool, &own, "paused").await;
    let (_, matches) = send(
        &app,
        "buyer-1",
        "GET",
        &format!("{BASE}/for-my-listings"),
        None,
    )
    .await;
    assert_eq!(matches["items"], json!([]));
    let (_, nobody) = send(
        &app,
        "seller-9",
        "GET",
        &format!("{BASE}/for-my-listings"),
        None,
    )
    .await;
    assert_eq!(nobody["items"], json!([]));

    // --- Sell now: same listing checks as the listing endpoint (country first).
    let (status, error) = send(
        &app,
        "seller-1",
        "POST",
        &format!("{BASE}/{a}/sell"),
        Some(json!({ "quantity": 1 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert!(
        error["error"].as_str().unwrap().contains("shipFromCountry"),
        "{error}"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("select count(*) from public.marketplace_buy_order_fills")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let (status, sold) = sell(&app, "seller-1", &a, 1).await;
    assert_eq!(status, StatusCode::CREATED, "{sold}");
    let listing_id = sold["listing_id"].as_str().unwrap().to_string();
    let (price, condition, language, source, source_id, quantity, seller, state, country): (f64, String, String, String, String, i32, String, String, String) =
        sqlx::query_as(
            "select price_pkn::float8, condition, language, source, source_listing_id, quantity_available, seller_uid, status, seller_country \
             from public.marketplace_user_listings where id = $1::uuid",
        )
        .bind(&listing_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        (price, condition.as_str(), language.as_str()),
        (120.0, "NM", "EN")
    );
    assert_eq!(
        (
            source.as_str(),
            source_id.as_str(),
            quantity,
            seller.as_str(),
            state.as_str(),
            country.as_str()
        ),
        ("buy_order", a.as_str(), 1, "seller-1", "active", "DK")
    );
    assert_eq!(sold["buy_order"]["remaining"], 2);
    assert_eq!(sold["buy_order"]["fills"].as_array().unwrap().len(), 1);
    let fill = &order_of(&app, "buyer-1", &a).await["fills"][0];
    assert_eq!(
        (
            fill["listing_id"].clone(),
            fill["quantity"].clone(),
            fill["listing_status"].clone()
        ),
        (json!(listing_id), json!(1), json!("active"))
    );
    assert!(fill.get("seller_uid").is_none());
    assert_eq!(
        book(&app, "202")
            .await
            .iter()
            .find(|row| row["orders"] == 2)
            .unwrap()["quantity"],
        3,
        "A has 2 left, C has 1"
    );
    for row in book(&app, "202").await {
        if row["best_order_id"] == a.as_str() {
            assert_eq!(row["best_remaining"], 2, "A is partly filled");
        }
        assert!(row["best_remaining"].as_i64().unwrap() <= row["quantity"].as_i64().unwrap());
    }

    // --- the other rules, in the contract's order.
    let (status, error) = sell(&app, "buyer-1", &a, 1).await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::FORBIDDEN, "own_buy_order"),
        "{error}"
    );
    let (status, error) = sell(&app, "seller-2", &a, 3).await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::CONFLICT, "quantity_exceeds_remaining"),
        "{error}"
    );
    let (status, error) = sell(&app, "seller-2", "00000000-0000-4000-8000-0000000000ff", 1).await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::NOT_FOUND, "not_found"),
        "{error}"
    );
    let (status, error) = sell(&app, "seller-2", &b, 1).await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::CONFLICT, "not_open"),
        "cancelled"
    );
    let (status, error) = send(
        &app,
        "seller-2",
        "POST",
        &format!("{BASE}/{a}/sell"),
        Some(json!({ "quantity": 0, "sellerCountry": "DK" })),
    )
    .await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::BAD_REQUEST, "invalid_quantity")
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("select count(*) from public.marketplace_buy_order_fills")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1,
        "rejected sells write nothing"
    );

    // --- the seller withdraws: the copy comes back; sold_out still counts.
    set_listing_status(&pool, &listing_id, "inactive").await;
    let back = order_of(&app, "buyer-1", &a).await;
    assert_eq!(
        (back["remaining"].clone(), back["state"].clone()),
        (json!(3), json!("open"))
    );
    assert_eq!(back["fills"][0]["listing_status"], "inactive");
    set_listing_status(&pool, &listing_id, "paused").await;
    assert_eq!(order_of(&app, "buyer-1", &a).await["remaining"], 3);
    sqlx::query("delete from public.marketplace_user_listings where id = $1::uuid")
        .bind(&listing_id)
        .execute(&pool)
        .await
        .unwrap();
    let back = order_of(&app, "buyer-1", &a).await;
    assert_eq!(back["remaining"], 3);
    assert_eq!(back["fills"][0]["listing_status"], "deleted");
    // Put a fresh copy in: buying it out (sold_out) keeps the order counted.
    let (status, sold) = sell(&app, "seller-1", &a, 1).await;
    assert_eq!(status, StatusCode::CREATED, "{sold}");
    set_listing_status(&pool, sold["listing_id"].as_str().unwrap(), "sold_out").await;
    assert_eq!(order_of(&app, "buyer-1", &a).await["remaining"], 2);

    // --- fill it up: filled leaves the book and cannot be sold into or edited.
    let (status, sold) = sell(&app, "seller-2", &a, 2).await;
    assert_eq!(status, StatusCode::CREATED, "{sold}");
    assert_eq!(sold["buy_order"]["remaining"], 0);
    assert_eq!(sold["buy_order"]["state"], "filled");
    assert_eq!(
        sold["buy_order"]["fills"].as_array().unwrap().len(),
        1,
        "only the caller's fills"
    );
    assert_eq!(
        order_of(&app, "buyer-1", &a).await["fills"]
            .as_array()
            .unwrap()
            .len(),
        3,
        "the deleted-listing fill stays recorded, plus two live ones"
    );
    assert!(!board_ids(&app, "?limit=60").await.contains(&a));
    let (status, error) = sell(&app, "seller-3", &a, 1).await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::CONFLICT, "not_open")
    );
    let (status, error) = send(
        &app,
        "buyer-1",
        "PATCH",
        &format!("{BASE}/{a}"),
        Some(json!({ "price_pkn": 5 })),
    )
    .await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::CONFLICT, "not_editable")
    );

    // --- quantity cannot drop below what is already counted.
    let e = create(&app, "buyer-1", order_body("303", "PL", "DE", 10.0, 3)).await;
    let (status, sold) = sell(&app, "seller-1", &e, 2).await;
    assert_eq!(status, StatusCode::CREATED, "{sold}");
    let (status, error) = send(
        &app,
        "buyer-1",
        "PATCH",
        &format!("{BASE}/{e}"),
        Some(json!({ "quantity": 1 })),
    )
    .await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::CONFLICT, "quantity_below_filled"),
        "{error}"
    );
    let (status, raised) = send(
        &app,
        "buyer-1",
        "PATCH",
        &format!("{BASE}/{e}"),
        Some(json!({ "quantity": 5 })),
    )
    .await;
    assert_eq!(
        (status, raised["remaining"].clone()),
        (StatusCode::OK, json!(3)),
        "{raised}"
    );

    // --- board paging walks every live order exactly once, both sorts.
    for n in 0..5 {
        create(
            &app,
            "buyer-3",
            order_body(&format!("7{n}"), "NM", "EN", 10.0 + f64::from(n % 2), 1),
        )
        .await;
    }
    let all = board_ids(&app, "?limit=60").await;
    for sort in ["recent", "price"] {
        let mut seen = Vec::new();
        let mut before = String::new();
        loop {
            let query = format!("?limit=2&sort={sort}{before}");
            let (status, page) = send(&app, "", "GET", &format!("{BASE}/board{query}"), None).await;
            assert_eq!(status, StatusCode::OK, "{page}");
            seen.extend(
                page["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| item["id"].as_str().unwrap().to_string()),
            );
            match page["next"].as_str() {
                Some(next) => before = format!("&before={}", next.replace('|', "%7C")),
                None => break,
            }
        }
        let mut sorted_seen = seen.clone();
        sorted_seen.sort();
        sorted_seen.dedup();
        let mut sorted_all = all.clone();
        sorted_all.sort();
        assert_eq!(
            (seen.len(), sorted_seen),
            (all.len(), sorted_all),
            "{sort}: every live order once"
        );
    }
    let (status, error) = send(&app, "", "GET", &format!("{BASE}/board?sort=nope"), None).await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::BAD_REQUEST, "invalid_sort")
    );
    let (status, error) = send(&app, "", "GET", &format!("{BASE}/board?before=junk"), None).await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::BAD_REQUEST, "invalid_cursor")
    );
    let (status, error) = send(&app, "", "GET", BASE, None).await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::BAD_REQUEST, "invalid_card")
    );

    // --- a buyer holds at most 100 open orders.
    sqlx::query(
        "insert into public.marketplace_buy_orders (buyer_uid, card_id, condition, language, price_pkn, quantity) \
         select 'buyer-4', 'bulk-' || n, 'NM', 'EN', 1, 1 from generate_series(1, 100) n",
    )
    .execute(&pool)
    .await
    .unwrap();
    let (status, error) = send(
        &app,
        "buyer-4",
        "POST",
        BASE,
        Some(order_body("one-more", "NM", "EN", 1.0, 1)),
    )
    .await;
    assert_eq!(
        (status, error_code(&error)),
        (StatusCode::CONFLICT, "too_many_buy_orders"),
        "{error}"
    );
    // Cancelling one frees a slot.
    let one: String = sqlx::query_scalar(
        "select id::text from public.marketplace_buy_orders where buyer_uid = 'buyer-4' limit 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    send(&app, "buyer-4", "DELETE", &format!("{BASE}/{one}"), None).await;
    create(&app, "buyer-4", order_body("one-more", "NM", "EN", 1.0, 1)).await;

    // --- every authenticated endpoint refuses a missing bearer.
    for (method, path) in [
        ("GET", format!("{BASE}/mine")),
        ("GET", format!("{BASE}/for-my-listings")),
        ("POST", BASE.to_string()),
        ("PATCH", format!("{BASE}/{a}")),
        ("DELETE", format!("{BASE}/{a}")),
        ("POST", format!("{BASE}/{a}/sell")),
    ] {
        let (status, _) = send(&app, "", method, &path, Some(json!({}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
}

#[tokio::test]
async fn two_sells_for_the_last_copy_let_exactly_one_through() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let (pool, app) = database(&url, "buy_orders_race").await;
    for round in 0..6 {
        let order = create(
            &app,
            "buyer-1",
            order_body(&format!("5{round}"), "NM", "EN", 40.0, 1),
        )
        .await;
        let (first, second) = tokio::join!(
            sell(&app, "seller-1", &order, 1),
            sell(&app, "seller-2", &order, 1)
        );
        let mut statuses = [first.0.as_u16(), second.0.as_u16()];
        statuses.sort_unstable();
        assert_eq!(statuses, [201, 409], "round {round}: {first:?} {second:?}");
        let loser = if first.0 == StatusCode::CREATED {
            &second.1
        } else {
            &first.1
        };
        assert_eq!(error_code(loser), "not_open", "{loser}");
        let (fills, listings): (i64, i64) = sqlx::query_as(
            "select (select count(*) from public.marketplace_buy_order_fills where buy_order_id = $1::uuid), \
                    (select count(*) from public.marketplace_user_listings where source = 'buy_order' and source_listing_id = $1)",
        )
        .bind(&order)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            (fills, listings),
            (1, 1),
            "round {round}: the loser left no listing behind"
        );
        assert_eq!(order_of(&app, "buyer-1", &order).await["state"], "filled");
    }

    // Two sells that together fit are both let through.
    let order = create(&app, "buyer-1", order_body("60", "NM", "EN", 40.0, 2)).await;
    let (first, second) = tokio::join!(
        sell(&app, "seller-1", &order, 1),
        sell(&app, "seller-2", &order, 1)
    );
    assert_eq!(
        (first.0, second.0),
        (StatusCode::CREATED, StatusCode::CREATED),
        "{first:?} {second:?}"
    );
    assert_eq!(order_of(&app, "buyer-1", &order).await["remaining"], 0);

    // Two identical creates by one buyer: one order, one duplicate.
    let body = order_body("61", "NM", "EN", 40.0, 1);
    let (first, second) = tokio::join!(
        send(&app, "buyer-5", "POST", BASE, Some(body.clone())),
        send(&app, "buyer-5", "POST", BASE, Some(body))
    );
    let mut statuses = [first.0.as_u16(), second.0.as_u16()];
    statuses.sort_unstable();
    assert_eq!(statuses, [201, 409], "{first:?} {second:?}");
}

/// Pokoin's starting offer: any seller can list any card into it at 1 PKN,
/// whatever price the body names, with no order row and no fill.
#[tokio::test]
async fn selling_into_the_starting_offer_lists_at_one_pkn() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let (pool, app) = database(&url, "buy_orders_house").await;
    let path = format!("{BASE}/house/sell");
    let body = json!({
        "card_id": "777", "condition": "sp", "language": "it", "reverse": true, "quantity": 2,
        "price_pkn": 5000, "days": 90, "sellerCountry": "DK",
        "card_name": "Clefable", "card_image_url": "https://img/clefable.jpg", "set_name": "Expedition", "collector_number": "41/165",
    });

    // A bearer is required, and the body is validated like a buy order.
    let (status, _) = send(&app, "", "POST", &path, Some(body.clone())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let mut wrong = body.clone();
    wrong["condition"] = json!("Mint");
    let (status, error) = send(&app, "seller-1", "POST", &path, Some(wrong)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert_eq!(error_code(&error), "invalid_condition");

    let (status, sold) = send(&app, "seller-1", "POST", &path, Some(body.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{sold}");
    assert_eq!(sold["price_pkn"], json!(1.0));
    assert_eq!(sold["quantity"], json!(2));
    let listing_id = sold["listing_id"].as_str().unwrap().to_string();
    let (price, condition, language, reverse, source, source_id, quantity, seller, state, card): (f64, String, String, bool, String, String, i32, String, String, String) =
        sqlx::query_as(
            "select price_pkn::float8, condition, language, reverse, source, source_listing_id, quantity_available, seller_uid, status, card_id \
             from public.marketplace_user_listings where id = $1::uuid",
        )
        .bind(&listing_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(price, 1.0, "the body's 5000 PKN is ignored");
    assert_eq!(
        (condition.as_str(), language.as_str(), reverse),
        ("SP", "IT", true)
    );
    assert_eq!(
        (source.as_str(), source_id.as_str()),
        ("buy_order_house", "")
    );
    assert_eq!(
        (quantity, seller.as_str(), state.as_str(), card.as_str()),
        (2, "seller-1", "active", "777")
    );

    // No order row and no fill: the starting offer is not in the book or the board.
    let orders: i64 = sqlx::query_scalar("select count(*) from public.marketplace_buy_orders")
        .fetch_one(&pool)
        .await
        .unwrap();
    let fills: i64 = sqlx::query_scalar("select count(*) from public.marketplace_buy_order_fills")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!((orders, fills), (0, 0));
    assert!(book(&app, "777").await.is_empty());

    // A second seller can sell the same card into it: it never fills up.
    let (status, again) = send(&app, "seller-2", "POST", &path, Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{again}");
    assert_ne!(again["listing_id"], sold["listing_id"]);
}

/// The seller's private note on "Sell now": folded and trimmed onto the fill,
/// read back by the buyer of that order and by nobody else — not the seller
/// who wrote it, not another user's own view, not the book, the board or
/// `for-my-listings`, and never on the listing itself.
#[tokio::test]
async fn a_sell_note_reaches_that_buyer_and_nobody_else() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let (pool, app) = database(&url, "buy_orders_notes").await;

    const SENT: &str = "  ships Monday,\r\nsleeved & toploaded  ";
    const NOTE: &str = "ships Monday,\nsleeved & toploaded";
    // Marks of the note that must never reach a body it is not addressed to.
    let probes = ["ships Monday", "toploaded", "sleeved"];

    let a = create(&app, "buyer-1", order_body("202", "NM", "EN", 100.0, 2)).await;
    let b = create(&app, "buyer-2", order_body("303", "PL", "DE", 10.0, 1)).await;

    let (status, sold) = note_sale(&app, "seller-1", &a, 1, SENT).await;
    assert_eq!(status, StatusCode::CREATED, "{sold}");
    let listing = sold["listing_id"].as_str().unwrap().to_string();

    // --- stored: the fill row holds the folded, trimmed note.
    assert_eq!(fill_note(&pool, &a, &listing).await, NOTE);
    // --- not stored on the listing: its own comment is the seller's words.
    assert_eq!(
        listing_comment(&pool, &listing).await,
        "my own listing comment"
    );
    // --- the writing seller reads their own note off their own fill, and
    //     sees no other fill at all.
    let fills = sold["buy_order"]["fills"].as_array().unwrap();
    assert_eq!(fills.len(), 1, "only the caller's fills");
    assert_eq!(fills[0]["seller_message"], NOTE);
    // --- the buyer reads it on their own order.
    assert_eq!(
        order_of(&app, "buyer-1", &a).await["fills"][0]["seller_message"],
        NOTE
    );

    // --- nowhere else, in the raw bytes of each response.
    for (who, path) in [
        ("buyer-2", format!("{BASE}/mine")),
        ("seller-2", format!("{BASE}/mine")),
        ("seller-1", format!("{BASE}/mine")),
        ("seller-1", format!("{BASE}/for-my-listings")),
        ("seller-9", format!("{BASE}/for-my-listings")),
        ("", format!("{BASE}?card_id=202")),
        ("", format!("{BASE}/board")),
        ("", format!("{BASE}/board?sort=recent")),
        ("", format!("{BASE}/board?sort=price")),
        ("", format!("{BASE}/board?limit=60&sort=price")),
    ] {
        let (status, body) = raw(&app, who, "GET", &path).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        refute_note(&format!("{who} {path}"), &body, &probes);
    }
    // The buyer's own view is the one place the note is written down.
    let (status, mine_body) = raw(&app, "buyer-1", "GET", &format!("{BASE}/mine")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(mine_body.contains("ships Monday"), "{mine_body}");

    // --- a rejected note writes nothing at all.
    let before = footprint(&pool, &b).await;
    for bad_note in &[
        json!("x".repeat(241)),
        json!("🐱".repeat(241)),
        json!(7),
        json!({ "text": "ships Monday" }),
        json!("a\u{7}b"),
        json!("a\u{7f}b"),
    ] {
        let body = json!({
            "quantity": 1, "sellerCountry": "DK", "buyer_message": bad_note,
        });
        let (status, error) = send(
            &app,
            "seller-2",
            "POST",
            &format!("{BASE}/{b}/sell"),
            Some(body),
        )
        .await;
        assert_eq!(
            (status, error_code(&error)),
            (StatusCode::BAD_REQUEST, "invalid_buyer_message"),
            "{bad_note}"
        );
    }
    assert_eq!(
        footprint(&pool, &b).await,
        before,
        "a rejected note leaves no listing and no fill"
    );
    // The order is still there for a valid note, and 240 characters is the
    // ceiling rather than past it.
    let long = "a".repeat(240);
    let (status, at_the_ceiling) = note_sale(&app, "seller-2", &b, 1, &long).await;
    assert_eq!(status, StatusCode::CREATED, "{at_the_ceiling}");
    assert_eq!(
        fill_note(&pool, &b, at_the_ceiling["listing_id"].as_str().unwrap()).await,
        long
    );

    // --- a sell with no note: empty, and every other rule unchanged.
    let (status, second) = sell(&app, "seller-3", &a, 1).await;
    assert_eq!(status, StatusCode::CREATED, "{second}");
    let second_listing = second["listing_id"].as_str().unwrap().to_string();
    assert_eq!(fill_note(&pool, &a, &second_listing).await, "");
    assert_eq!(second["buy_order"]["fills"][0]["seller_message"], "");
    assert_eq!(
        (
            second["buy_order"]["remaining"].clone(),
            second["buy_order"]["state"].clone()
        ),
        (json!(0), json!("filled")),
        "the order filled as it always did"
    );
    assert!(!board_ids(&app, "?limit=60").await.contains(&a));
    let buyer_view = order_of(&app, "buyer-1", &a).await;
    let note_of = |listing_id: &str| {
        buyer_view["fills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|fill| fill["listing_id"] == listing_id)
            .unwrap()["seller_message"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(note_of(&listing), NOTE);
    assert_eq!(note_of(&second_listing), "");
    assert_eq!(buyer_view["state"], "filled");
    // `null`, an empty string and pure whitespace are as good as absent.
    for (n, blank) in [Value::Null, json!(""), json!("  \r\n  ")]
        .iter()
        .enumerate()
    {
        let order = create(
            &app,
            "buyer-1",
            order_body(&format!("4{n}4"), "NM", "EN", 8.0, 1),
        )
        .await;
        let (status, blank_sold) = send(
            &app,
            "seller-1",
            "POST",
            &format!("{BASE}/{order}/sell"),
            Some(json!({
                "quantity": 1, "sellerCountry": "DK", "buyer_message": blank,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{blank}: {blank_sold}");
        assert_eq!(blank_sold["buy_order"]["fills"][0]["seller_message"], "");
        assert_eq!(
            fill_note(&pool, &order, blank_sold["listing_id"].as_str().unwrap()).await,
            ""
        );
    }
}

/// The starting offer has no fill to hold a note, so the note reaches Pokoin's
/// email and touches nothing else: not the listing, not the response, not a
/// single read.
#[tokio::test]
async fn a_starting_offer_note_reaches_pokoin_and_nothing_else() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let (pool, app) = database(&url, "buy_orders_house_note").await;
    let path = format!("{BASE}/house/sell");
    let note = "ships in a rigid toploader, thanks";
    let body = json!({
        "card_id": "888", "condition": "nm", "language": "en", "quantity": 1,
        "sellerCountry": "DK", "card_name": "Clefable", "set_name": "Expedition",
        "collector_number": "41/165", "sellerComment": "my own listing comment",
        "buyer_message": note,
    });

    let (status, sold) = send(&app, "seller-1", "POST", &path, Some(body.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{sold}");
    assert_eq!(sold["price_pkn"], json!(1.0));
    let listing = sold["listing_id"].as_str().unwrap().to_string();
    assert_eq!(
        listing_comment(&pool, &listing).await,
        "my own listing comment"
    );
    assert!(!sold.to_string().contains(note), "{sold}");

    // No fill row anywhere, and no listing carries the note.
    let (fills, notes_on_listings): (i64, i64) = sqlx::query_as(
        "select (select count(*) from public.marketplace_buy_order_fills), \
                (select count(*) from public.marketplace_user_listings where seller_comment = $1)",
    )
    .bind(note)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((fills, notes_on_listings), (0, 0));

    for (who, read) in [
        ("", format!("{BASE}?card_id=888")),
        ("", format!("{BASE}/board?sort=recent")),
        ("", format!("{BASE}/board?sort=price")),
        ("seller-1", format!("{BASE}/mine")),
        ("seller-1", format!("{BASE}/for-my-listings")),
    ] {
        let (status, page) = raw(&app, who, "GET", &read).await;
        assert_eq!(status, StatusCode::OK, "{read}");
        refute_note(&format!("{who} {read}"), &page, &["toploader"]);
    }

    // The same validation as a sell into a member's order.
    for bad_note in [json!("x".repeat(241)), json!(true), json!("a\u{85}b")] {
        let mut wrong = body.clone();
        wrong["buyer_message"] = bad_note.clone();
        let (status, error) = send(&app, "seller-2", "POST", &path, Some(wrong)).await;
        assert_eq!(
            (status, error_code(&error)),
            (StatusCode::BAD_REQUEST, "invalid_buyer_message"),
            "{bad_note}"
        );
    }
    let listings: i64 = sqlx::query_scalar("select count(*) from public.marketplace_user_listings")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(listings, 1, "a rejected note lists nothing");
}
