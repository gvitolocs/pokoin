//! Price ownership on a real Postgres: each test is named after the
//! invariant of `specs/tla/price-ownership/Model.tla` it checks in the Rust
//! code (docs/pricer-cardrails-contract.md, "Price ownership invariants").
//! Card Rails' connector (`update`, `list`, `listings`), MyPokoin's listing
//! edit (`PATCH /api/marketplace-listings`) and a pricing-group run's write
//! (`pricer::write_run_price`).
//!
//! ```text
//! docker run -d --rm --name pokoin-price-owner-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55491:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55491/postgres \
//!   cargo test -p pokoin-commerce --test price_ownership_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the tests are skipped. They drop and
//! recreate their tables (one test at a time): a throwaway database only.
//! No Firestore here: strategy names read as null and a group's apply
//! answers a `pricingError`; membership and prices are what is checked.

use std::sync::{Arc, OnceLock};

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
use pokoin_commerce::handlers::pricer;
use pokoin_commerce::state::DomainState;

struct UidToken;
#[async_trait]
impl TokenVerifier for UidToken {
    async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        if token.is_empty() || token.starts_with("pkn_") {
            return Err(AuthError::Invalid("not a sign-in token".into()));
        }
        Ok(Claims { uid: token.into(), ..Default::default() })
    }
}

/// One test at a time: each one recreates the tables.
fn serial() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

struct Env {
    pool: PgPool,
    state: DomainState,
    app: Router,
    token: String,
}

const SELLER: &str = "seller-1";

/// Fresh tables, a Card Rails grant for seller-1, and two of its groups
/// (`pg_bulk`, daily, and `pg_rare`) plus another seller's (`pg_theirs`).
async fn setup() -> Option<Env> {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return None;
    };
    std::env::set_var("POKOIN_LISTING_SYNC_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_WEBHOOK_WORKER", "0");
    std::env::set_var("POKOIN_READ_CACHE", "0");
    std::env::set_var("CARDTRADER_TOKEN_ENCRYPTION_KEY", "11".repeat(32));
    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.expect("test database");
    for sql in [
        include_str!("sql/flow_listings.sql"),
        include_str!("../../../../scripts/sql/096_marketplace_outbox.sql"),
        include_str!("../../../../scripts/sql/115_seller_api_grants.sql"),
        include_str!("../../../../scripts/sql/118_unpriced_paused_inventory.sql"),
        "drop table if exists public.seller_pricing_group_members, public.seller_pricing_groups, public.scan_batches cascade;
         create table public.scan_batches (id uuid primary key default gen_random_uuid(), seller_uid text not null,
           defaults jsonb not null, status text not null default 'open', updated_at timestamptz not null default now());",
        include_str!("../../../../scripts/sql/138_seller_pricing_groups.sql"),
        "insert into public.seller_pricing_groups (id, seller_uid, name, strategy_id, auto_daily) values
           ('pg_bulk', 'seller-1', 'Riftbound bulk', 'st_gone', true), ('pg_rare', 'seller-1', 'Rares', 'st_gone', false),
           ('pg_theirs', 'seller-2', 'Theirs', 'st_x', false);",
    ] {
        sqlx::raw_sql(sql).execute(&pool).await.expect("schema");
    }
    let state = DomainState::with_pools(CommerceConfig::default(), pool.clone(), pool.clone(), None, Arc::new(UidToken), None);
    let app = pokoin_commerce::router(state.clone());
    let (status, created) = call(&app, "POST", "/api/seller-api-grants", SELLER, json!({"action":"create","client":"Card Rails"})).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let token = created["token"].as_str().unwrap().to_string();
    Some(Env { pool, state, app, token })
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

impl Env {
    async fn connector(&self, body: Value) -> (StatusCode, Value) {
        call(&self.app, "POST", "/api/cardrails/connector", &self.token, body).await
    }

    async fn update(&self, id: Uuid, item: Value) -> (StatusCode, Value) {
        self.connector(json!({"action":"update","channel":"pokoin","listingId":id.to_string(),"item":item})).await
    }

    /// MyPokoin's listing edit, as the seller.
    async fn edit(&self, id: Uuid, body: Value) -> (StatusCode, Value) {
        call(&self.app, "PATCH", &format!("/api/marketplace-listings?id={id}"), SELLER, body).await
    }

    /// A live seller-1 listing at `price` PKN, in `group` when given.
    async fn listing(&self, price: i32, group: Option<&str>) -> Uuid {
        let id: Uuid = sqlx::query_scalar(
            "insert into public.marketplace_user_listings (card_id, seller_uid, seller_name, seller_country, price_pkn, quantity_available, card_name) \
             values ('220962', $1, 'alice', 'IT', $2, 2, 'Espurr') returning id",
        )
        .bind(SELLER)
        .bind(price)
        .fetch_one(&self.pool)
        .await
        .expect("listing");
        if let Some(group) = group {
            sqlx::query("insert into public.seller_pricing_group_members (listing_id, group_id, seller_uid) values ($1, $2, $3)")
                .bind(id)
                .bind(group)
                .bind(SELLER)
                .execute(&self.pool)
                .await
                .expect("member");
        }
        id
    }

    async fn group_of(&self, id: Uuid) -> Option<String> {
        sqlx::query_scalar("select group_id from public.seller_pricing_group_members where listing_id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .unwrap()
    }

    /// The group and price of the listing a `list` answer names.
    async fn state_of(&self, listed: &Value) -> (Option<String>, f64) {
        let id = Uuid::parse_str(listed["listingId"].as_str().unwrap()).unwrap();
        (self.group_of(id).await, self.price_of(id).await)
    }

    async fn price_of(&self, id: Uuid) -> f64 {
        sqlx::query_scalar("select price_pkn::float8 from public.marketplace_user_listings where id = $1")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

/// PO8 (the pull half): every pulled listing names the group that prices it,
/// so Card Rails mirrors Pokoin's price and locks its own.
#[tokio::test]
async fn po8_the_pull_names_the_group_that_prices_each_listing() {
    let _serial = serial().lock().await;
    let Some(env) = setup().await else { return };
    let (grouped, own) = (env.listing(400, Some("pg_bulk")).await, env.listing(300, None).await);
    let (_, page) = env.connector(json!({"action":"listings","limit":500})).await;
    let entry = |id: Uuid| page["listings"].as_array().unwrap().iter().find(|l| l["listingId"] == id.to_string()).cloned().unwrap();
    let pulled = entry(grouped);
    assert_eq!(
        (pulled["pricingGroupId"].clone(), pulled["pricingGroupName"].clone(), pulled["pricingStrategyId"].clone(), pulled["pricingAutoDaily"].clone()),
        (json!("pg_bulk"), json!("Riftbound bulk"), json!("st_gone"), json!(true)),
        "{pulled}"
    );
    assert_eq!(pulled["pricingStrategyName"], Value::Null, "the strategy cannot be named here");
    let mine = entry(own);
    assert_eq!((mine["pricingGroupId"].clone(), mine["pricingAutoDaily"].clone()), (Value::Null, json!(false)));
}

/// PO1 OneOwner: a price the seller types takes the listing out of its group,
/// from Card Rails and from MyPokoin.
#[tokio::test]
async fn po1_one_owner_a_typed_price_takes_the_listing_out_of_its_group() {
    let _serial = serial().lock().await;
    let Some(env) = setup().await else { return };
    let from_card_rails = env.listing(400, Some("pg_bulk")).await;
    let (status, manual) = env.update(from_card_rails, json!({"priceEurCents":250,"pricingGroupId":null})).await;
    assert_eq!(status, StatusCode::OK, "{manual}");
    assert_eq!((manual["leftPricingGroupId"].clone(), manual["listing"]["pricingGroupId"].clone()), (json!("pg_bulk"), Value::Null), "{manual}");
    assert_eq!((manual["changed"].clone(), manual["listing"]["pricePkn"].clone()), (json!(true), json!(500)));
    assert_eq!(env.group_of(from_card_rails).await, None);
    // A new price alone (an older tool) is still a manual price.
    let alone = env.listing(400, Some("pg_bulk")).await;
    let (_, left) = env.update(alone, json!({"pricePkn":410})).await;
    assert_eq!(left["leftPricingGroupId"], "pg_bulk", "{left}");
    // MyPokoin: the form sends a changed price with pricingGroupId null.
    let from_mypokoin = env.listing(400, Some("pg_rare")).await;
    let (status, typed) = env.edit(from_mypokoin, json!({"pricePkn":420,"pricingGroupId":null,"quantityAvailable":2})).await;
    assert_eq!(status, StatusCode::OK, "{typed}");
    assert_eq!(typed["leftPricingGroup"], json!({"id":"pg_rare","name":"Rares"}), "{typed}");
    assert_eq!((env.group_of(from_mypokoin).await, env.price_of(from_mypokoin).await), (None, 420.0));
}

/// PO2 ManualPriceKept: a run that read the listing in its group does not
/// write once a manual price took it out; while it is in, the run writes.
#[tokio::test]
async fn po2_manual_price_kept_a_run_never_writes_a_listing_that_left() {
    let _serial = serial().lock().await;
    let Some(env) = setup().await else { return };
    let id = env.listing(400, Some("pg_bulk")).await;
    let target = json!({"pricePkn": 450});
    // In the group: the run's write lands.
    assert!(pricer::write_run_price(&env.state, SELLER, Some("pg_bulk"), &id.to_string(), &target).await.unwrap());
    assert_eq!(env.price_of(id).await, 450.0);
    // The seller prices it by hand: out of the group …
    let (_, manual) = env.update(id, json!({"pricePkn":300,"pricingGroupId":null})).await;
    assert_eq!(manual["leftPricingGroupId"], "pg_bulk", "{manual}");
    // … and the run that read it before writes nothing.
    let late = json!({"pricePkn": 460});
    assert!(!pricer::write_run_price(&env.state, SELLER, Some("pg_bulk"), &id.to_string(), &late).await.unwrap());
    assert_eq!(env.price_of(id).await, 300.0, "the manual price stays");
    // Moved to another group: a run of the old group does not write either.
    let (_, moved) = env.update(id, json!({"pricingGroupId":"pg_rare"})).await;
    assert_eq!(moved["listing"]["pricingGroupId"], "pg_rare", "{moved}");
    assert!(!pricer::write_run_price(&env.state, SELLER, Some("pg_bulk"), &id.to_string(), &late).await.unwrap());
    assert!(pricer::write_run_price(&env.state, SELLER, Some("pg_rare"), &id.to_string(), &late).await.unwrap());
    assert_eq!(env.price_of(id).await, 460.0, "the group it rejoined prices it again");
}

/// PO3 NoPriceNoChange: an edit with no new price and no group named changes
/// neither the price nor the group; resending the price it has is no price.
#[tokio::test]
async fn po3_no_price_no_change_an_edit_without_a_new_price_keeps_price_and_group() {
    let _serial = serial().lock().await;
    let Some(env) = setup().await else { return };
    let id = env.listing(400, Some("pg_bulk")).await;
    let (_, moved) = env.update(id, json!({"location":"BIN-30"})).await;
    assert_eq!((moved["changed"].clone(), moved["listing"]["pricingGroupId"].clone(), moved["listing"]["pricePkn"].clone()), (json!(true), json!("pg_bulk"), json!(400)), "{moved}");
    let (_, same) = env.update(id, json!({"pricePkn":400,"location":"BIN-30"})).await;
    assert_eq!((same["changed"].clone(), same["leftPricingGroupId"].clone(), same["listing"]["pricingGroupId"].clone()), (json!(false), Value::Null, json!("pg_bulk")), "{same}");
    // Price 0 pauses; it is not a price.
    let (_, paused) = env.update(id, json!({"priceEurCents":0})).await;
    assert_eq!((paused["listing"]["status"].clone(), paused["listing"]["pricingGroupId"].clone()), (json!("paused"), json!("pg_bulk")), "{paused}");
    // MyPokoin: a quantity edit, and a form resending the price it has.
    let (status, quantity) = env.edit(id, json!({"quantityAvailable":1})).await;
    assert_eq!((status, quantity["leftPricingGroup"].clone()), (StatusCode::OK, Value::Null), "{quantity}");
    let (_, resent) = env.edit(id, json!({"pricePkn":400,"quantityAvailable":1})).await;
    assert_eq!(resent["leftPricingGroup"], Value::Null, "{resent}");
    assert_eq!((env.group_of(id).await.as_deref(), env.price_of(id).await), (Some("pg_bulk"), 400.0));
}

/// PO5 PriceMyselfHonoured: "Price myself" at the same price needs
/// `pricingGroupId: null`, and with it the listing leaves; naming the group
/// keeps it, naming another moves it, another seller's group is refused.
#[tokio::test]
async fn po5_price_myself_honoured_at_the_same_price_with_null() {
    let _serial = serial().lock().await;
    let Some(env) = setup().await else { return };
    let id = env.listing(400, Some("pg_bulk")).await;
    let (_, kept) = env.update(id, json!({"pricePkn":410,"pricingGroupId":"pg_bulk"})).await;
    assert_eq!((kept["leftPricingGroupId"].clone(), kept["listing"]["pricingGroupId"].clone()), (Value::Null, json!("pg_bulk")), "{kept}");
    let (_, other) = env.update(id, json!({"pricingGroupId":"pg_rare"})).await;
    assert_eq!((other["changed"].clone(), other["listing"]["pricingGroupName"].clone()), (json!(true), json!("Rares")), "{other}");
    let (_, again) = env.update(id, json!({"pricingGroupId":"pg_rare"})).await;
    assert_eq!(again["changed"], false, "{again}");
    let (status, refused) = env.update(id, json!({"pricingGroupId":"pg_theirs","pricePkn":999})).await;
    assert_eq!((status, refused["code"].clone()), (StatusCode::BAD_REQUEST, json!("pricing_group_unknown")), "{refused}");
    assert_eq!((env.group_of(id).await.as_deref(), env.price_of(id).await), (Some("pg_rare"), 410.0), "nothing was written");
    // Same price, no null: indistinguishable from a resend, it stays …
    let (_, resend) = env.update(id, json!({"pricePkn":410})).await;
    assert_eq!(resend["listing"]["pricingGroupId"], "pg_rare", "{resend}");
    // … with null it leaves, at the same price.
    let (_, myself) = env.update(id, json!({"pricePkn":410,"pricingGroupId":null})).await;
    assert_eq!((myself["leftPricingGroupId"].clone(), myself["listing"]["pricePkn"].clone()), (json!("pg_rare"), json!(410)), "{myself}");
    // MyPokoin: null with no price leaves too.
    let board = env.listing(500, Some("pg_bulk")).await;
    let (_, edited) = env.edit(board, json!({"pricingGroupId":null})).await;
    assert_eq!(edited["leftPricingGroup"], json!({"id":"pg_bulk","name":"Riftbound bulk"}), "{edited}");
    assert_eq!((env.group_of(board).await, env.price_of(board).await), (None, 500.0));
}

/// PO6 ListNeverRefused and PO7 UnpricedStaysPaused: an unpriced item with
/// no choice takes a usable account default, and with none (or a deleted
/// one) is listed paused at 0, never refused.
#[tokio::test]
async fn po6_po7_list_never_refused_and_an_unpriced_item_stays_paused() {
    let _serial = serial().lock().await;
    let Some(env) = setup().await else { return };
    // The seller's name and ship-from country come from a listing they have.
    env.listing(100, None).await;
    let unpriced = |key: &str| json!({"action":"list","idempotencyKey":key,"item":{
        "identity":{"publicId":"741592","game":"pokemon"},"quantity":1,"priceEurCents":0,"status":"paused","condition":"NM","language":"IT"}});
    // No account default: listed, paused at 0, in no group.
    let (status, none) = env.connector(unpriced("no-default")).await;
    assert_eq!(status, StatusCode::OK, "{none}");
    assert!(none.get("pricingGroupId").is_none(), "{none}");
    assert_eq!(env.state_of(&none).await, (None, 0.0));
    // A usable default: it joins that group.
    sqlx::query("insert into public.scan_batches (seller_uid, defaults) values ($1, $2)")
        .bind(SELLER)
        .bind(json!({"pricingGroupId":"pg_bulk"}))
        .execute(&env.pool)
        .await
        .unwrap();
    let (_, defaulted) = env.connector(unpriced("with-default")).await;
    assert_eq!((defaulted["pricingGroupId"].clone(), defaulted["pricingFromAccountDefault"].clone()), (json!("pg_bulk"), json!(true)), "{defaulted}");
    assert_eq!(env.state_of(&defaulted).await.0.as_deref(), Some("pg_bulk"));
    // The item's or the call's choice wins over the default.
    let mut own = unpriced("own-choice");
    own["pricingGroupId"] = json!("pg_rare");
    let (_, own) = env.connector(own).await;
    assert_eq!((own["pricingGroupId"].clone(), own["pricingFromAccountDefault"].clone()), (json!("pg_rare"), json!(false)), "{own}");
    // A priced item keeps its price and joins no group.
    let (_, priced) = env.connector(json!({"action":"list","idempotencyKey":"priced","item":{
        "identity":{"publicId":"741592","game":"pokemon"},"quantity":1,"priceEurCents":85,"condition":"NM","language":"IT"}})).await;
    assert!(priced.get("pricingGroupId").is_none(), "{priced}");
    // A default whose group was deleted: never refused, paused at 0.
    sqlx::query("update public.scan_batches set defaults = $2 where seller_uid = $1")
        .bind(SELLER)
        .bind(json!({"pricingGroupId":"pg_deleted"}))
        .execute(&env.pool)
        .await
        .unwrap();
    let (status, stale) = env.connector(unpriced("stale-default")).await;
    assert_eq!(status, StatusCode::OK, "{stale}");
    assert!(stale.get("pricingGroupId").is_none(), "{stale}");
    assert_eq!(env.state_of(&stale).await, (None, 0.0));
}
