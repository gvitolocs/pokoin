//! A seller takes a listing off sale: MyPokoin's inventory Delete button
//! (`cancelListing` in `market/src/api.js`) sends `PATCH
//! /api/marketplace-listings?id=<id>` with `{ "status": "inactive" }`, and the
//! handler (`marketplace_listings_patch` → `update_listing_guarded`) commits
//! one outbox event in the same transaction as the row. What that event says
//! about the CardTrader product the listing is linked to is the difference
//! between the four cases below (docs/FEATURES.toml `listing-unlist`,
//! specs/tla/listing-outbox).
//!
//! ```text
//! docker run -d --rm --name pokoin-unlist-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55501:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55501/postgres \
//!   cargo test -p pokoin-commerce --test listing_unlist_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the tests are skipped. They drop and
//! recreate their tables (one test at a time), so a test that panics leaves
//! nothing for the next one: a throwaway database only. No CardTrader and no
//! Firestore here: the sync worker is off, so what is checked is the event the
//! write committed — the event is what the worker would act on, and the rules
//! for it (`group_leave`, `cardtrader_edit`, `destroy`) are unit-tested in
//! `src/listing_sync.rs`.

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
use pokoin_commerce::state::DomainState;

struct UidToken;

#[async_trait]
impl TokenVerifier for UidToken {
    /// The sign-in token is the uid.
    async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        if token.is_empty() || token.starts_with("pkn_") {
            return Err(AuthError::Invalid("not a sign-in token".into()));
        }
        Ok(Claims {
            uid: token.into(),
            ..Default::default()
        })
    }
}

/// One test at a time: each one recreates the tables.
fn serial() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

const SELLER: &str = "seller-1";
const OTHER_SELLER: &str = "seller-2";
/// A listing linked to CardTrader product 123456.
const LINKED: &str = "ct:123456";

struct Env {
    pool: PgPool,
    app: Router,
}

/// Fresh listings, outbox and product-link tables: no rows, no groups.
async fn setup() -> Option<Env> {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return None;
    };
    std::env::set_var("POKOIN_LISTING_SYNC_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_WEBHOOK_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_BOOK_WORKER", "0");
    std::env::set_var("POKOIN_READ_CACHE", "0");
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .expect("test database");
    for sql in [
        include_str!("sql/flow_listings.sql"),
        include_str!("../../../../scripts/sql/096_marketplace_outbox.sql"),
    ] {
        sqlx::raw_sql(sql).execute(&pool).await.expect("schema");
    }
    let state = DomainState::with_pools(
        CommerceConfig::default(),
        pool.clone(),
        pool.clone(),
        None,
        Arc::new(UidToken),
        None,
    );
    let app = pokoin_commerce::router(state.clone());
    Some(Env { pool, app })
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    bearer: &str,
    body: Value,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {bearer}"))
        .header("content-type", "application/json")
        .body(if method == "GET" {
            Body::empty()
        } else {
            Body::from(body.to_string())
        })
        .unwrap();
    let response = app.clone().oneshot(request).await.expect("router");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

impl Env {
    /// A live listing of `SELLER` of `quantity` copies, linked to `source`
    /// (empty: nothing outside Pokoin).
    async fn listing(&self, source: &str, quantity: i32) -> Uuid {
        sqlx::query_scalar(
            "insert into public.marketplace_user_listings (card_id, seller_uid, seller_name, seller_country, price_pkn, quantity_available, card_name, source_listing_id) \
             values ('220962', $1, 'alice', 'IT', 400, $2, 'Espurr', $3) returning id",
        )
        .bind(SELLER)
        .bind(quantity)
        .bind(source)
        .fetch_one(&self.pool)
        .await
        .expect("listing")
    }

    /// The Delete button, signed in as `bearer`.
    async fn unlist_as(&self, id: Uuid, bearer: &str) -> (StatusCode, Value) {
        call(
            &self.app,
            "PATCH",
            &format!("/api/marketplace-listings?id={id}"),
            bearer,
            json!({ "sellerUid": bearer, "status": "inactive" }),
        )
        .await
    }

    async fn unlist(&self, id: Uuid) -> (StatusCode, Value) {
        self.unlist_as(id, SELLER).await
    }

    /// The row as the database holds it now; `None` once it is gone.
    async fn row(&self, id: Uuid) -> Option<Value> {
        sqlx::query_scalar::<_, Value>(
            "select to_jsonb(v) from (select seller_uid, status, quantity_available, price_pkn, source_listing_id from public.marketplace_user_listings where id = $1 limit 1) v",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .unwrap()
    }

    /// The payload of every outbox event the listing's writes queued.
    async fn events(&self, id: Uuid) -> Vec<Value> {
        sqlx::query_scalar::<_, Value>("select payload from public.marketplace_outbox where aggregate_id = $1::text order by id")
            .bind(id.to_string())
            .fetch_all(&self.pool)
            .await
            .unwrap()
    }

    /// The single event one write queued.
    async fn event(&self, id: Uuid) -> Value {
        let events = self.events(id).await;
        assert_eq!(events.len(), 1, "{id}: exactly one event per unlist");
        events.into_iter().next().unwrap()
    }

    async fn outbox_len(&self) -> i64 {
        sqlx::query_scalar("select count(*) from public.marketplace_outbox")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

/// An unlisted plain listing is taken off sale, not thrown away, and no
/// CardTrader product is asked for: it never had one.
#[tokio::test]
async fn unlisting_a_pokoin_listing_takes_it_off_sale_and_keeps_the_row() {
    let _serial = serial().lock().await;
    let Some(env) = setup().await else { return };
    let id = env.listing("", 3).await;
    let (status, body) = env.unlist(id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (
            body["status"].clone(),
            body["sourceListingId"].clone(),
            body["leftPricingGroup"].clone()
        ),
        (json!("inactive"), json!(""), Value::Null),
        "{body}"
    );
    let row = env
        .row(id)
        .await
        .expect("the row survives its own unlisting");
    assert_eq!(
        (
            row["status"].clone(),
            row["quantity_available"].clone(),
            row["price_pkn"].clone()
        ),
        (json!("inactive"), json!(3), json!(400)),
        "{row}"
    );
    let event = env.event(id).await;
    assert_eq!(
        (
            event["destroyCardtrader"].clone(),
            event["sourceListingId"].clone()
        ),
        (json!(false), json!("")),
        "{event}"
    );
    assert!(
        event["cardtraderEdit"].is_null(),
        "nothing of CardTrader's to write: {event}"
    );
    assert_eq!(
        (event["mutation"].as_str(), event["status"].as_str()),
        (Some("LISTING_DELETED"), Some("inactive")),
        "{event}"
    );
    assert_eq!(event["merchantListing"]["status"], "inactive", "{event}");
}

/// A listing linked to a CardTrader product of its own: the seller was the
/// only thing holding that product, so it is destroyed off Pokoin too, and the
/// row keeps its link for the reconcile to find it by.
#[tokio::test]
async fn unlisting_a_linked_listing_destroys_its_cardtrader_product() {
    let _serial = serial().lock().await;
    let Some(env) = setup().await else { return };
    let id = env.listing(LINKED, 2).await;
    let (status, body) = env.unlist(id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let row = env
        .row(id)
        .await
        .expect("the row survives its own unlisting");
    assert_eq!(
        (row["status"].clone(), row["source_listing_id"].clone()),
        (json!("inactive"), json!(LINKED)),
        "{row}"
    );
    let event = env.event(id).await;
    assert_eq!(
        (
            event["destroyCardtrader"].clone(),
            event["sourceListingId"].clone()
        ),
        (json!(true), json!(LINKED)),
        "{event}"
    );
    assert!(
        event["cardtraderEdit"].is_null(),
        "the destroy takes the product off, no edit alongside it: {event}"
    );
    assert_eq!(event["mutation"], "LISTING_DELETED", "{event}");
}

/// A seller's identical copies are one CardTrader product, so unlisting one of
/// them must never delete what the other is still selling: the unlisted copy
/// gives up its link (`listing_sync::LEAVE_GROUP_SQL`) and the product only
/// loses that copy's stock.
#[tokio::test]
async fn unlisting_one_copy_of_a_shared_product_leaves_the_group_and_keeps_the_product() {
    let _serial = serial().lock().await;
    let Some(env) = setup().await else { return };
    let unlisted = env.listing(LINKED, 3).await;
    let still_selling = env.listing(LINKED, 2).await;
    let (status, body) = env.unlist(unlisted).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let event = env.event(unlisted).await;
    assert_eq!(
        event["destroyCardtrader"], false,
        "the copy still on sale holds the product: {event}"
    );
    assert_eq!(
        event["cardtraderEdit"],
        json!({ "productId": "123456", "leaveGroup": true, "quantityDelta": -3 }),
        "{event}"
    );
    assert_eq!(
        event["sourceListingId"], LINKED,
        "the event names the product it is editing: {event}"
    );
    let row = env
        .row(unlisted)
        .await
        .expect("the row survives its own unlisting");
    assert_eq!(
        (row["status"].clone(), row["source_listing_id"].clone()),
        (json!("inactive"), json!("")),
        "{row}: unlinked, the reconcile pushes it again"
    );
    let other = env.row(still_selling).await.expect("the copy is untouched");
    assert_eq!(
        (
            other["status"].clone(),
            other["quantity_available"].clone(),
            other["source_listing_id"].clone(),
            other["price_pkn"].clone()
        ),
        (json!("active"), json!(2), json!(LINKED), json!(400)),
        "{other}"
    );
    assert_eq!(
        env.events(still_selling).await.len(),
        0,
        "and it queues nothing of its own"
    );
}

/// The unlist is scoped to the seller who owns the listing: another seller
/// gets the same answer as for a listing that does not exist, and the listing
/// stays live and linked.
#[tokio::test]
async fn another_seller_cannot_unlist_a_listing_it_does_not_own() {
    let _serial = serial().lock().await;
    let Some(env) = setup().await else { return };
    let id = env.listing(LINKED, 3).await;
    let (status, body) = env.unlist_as(id, OTHER_SELLER).await;
    assert_eq!(
        (status, body["error"].clone()),
        (
            StatusCode::NOT_FOUND,
            json!("Listing not found for this seller.")
        ),
        "{body}"
    );
    let row = env.row(id).await.expect("the row is untouched");
    assert_eq!(
        (
            row["status"].clone(),
            row["quantity_available"].clone(),
            row["source_listing_id"].clone(),
            row["seller_uid"].clone()
        ),
        (json!("active"), json!(3), json!(LINKED), json!(SELLER)),
        "{row}"
    );
    assert_eq!(env.outbox_len().await, 0, "and no event was queued");
}
