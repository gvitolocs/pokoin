//! The facet half of a listing save, on a real Postgres and against a fake
//! CardTrader on 127.0.0.1: condition, language and properties of a linked
//! listing go to CardTrader inside the seller's request, before the row write
//! commits, so a save that answered `ok` never leaves their product describing
//! another card (docs/CARDTRADER_SELLER_SYNC.md).
//!
//! ```text
//! docker run -d --rm --name pokoin-ct-facets-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55492:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55492/postgres \
//!   cargo test -p pokoin-commerce --test listing_ct_facets_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the tests are skipped. They drop and
//! recreate their tables, one test at a time: a throwaway database only.
//! Nothing here can reach `api.cardtrader.com`: every client is built with
//! `CardTraderClient::with_base` on the fake's address, and the no-answer case
//! points at a port with nothing behind it.

use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
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
use pokoin_external::cardtrader::client::CardTraderClient;
use pokoin_external::cardtrader::integration;
use pokoin_external::crypto::encrypt_secret;
use pokoin_external::firebase::MemoryFirestore;

struct UidToken;

#[async_trait]
impl TokenVerifier for UidToken {
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

/// One test at a time: each one recreates the tables and the process globals
/// (the encryption key, the workers, the satellite catalog).
fn serial() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

const SELLER: &str = "seller-1";
/// The CardTrader product every listing here is linked to (`ct:99`).
const PRODUCT: &str = "99";
const CARD: &str = "220962";
const CT_KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CT_TOKEN: &str = "ct-token-0123456789abcdef";

/// What the fake answers a write.
#[derive(Clone, Copy, Debug)]
enum Answer {
    Accepted,
    /// 422: it took the request and said no (a property it will not carry).
    Refused,
    /// 404: the product is gone.
    Gone,
    /// 500: it never got as far as an answer.
    Down,
    /// Nothing listens: the request gets no HTTP answer at all.
    Silent,
}

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    authorization: String,
    body: Value,
}

/// A CardTrader of one's own on 127.0.0.1, recording every request.
async fn fake_cardtrader(answer: Answer) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let app = Router::new().fallback(move |request: Request| {
        let log = log.clone();
        async move {
            let method = request.method().to_string();
            let path = request.uri().path().to_string();
            let authorization = request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string();
            let bytes = axum::body::to_bytes(request.into_body(), 1 << 20)
                .await
                .unwrap_or_default();
            let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            log.lock().unwrap().push(Seen {
                method,
                path,
                authorization,
                body,
            });
            match answer {
                Answer::Accepted => (StatusCode::OK, axum::Json(json!({ "id": 99 }))),
                Answer::Refused => (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    axum::Json(json!({"error": "pokemon_language cannot be it", "error_code": "invalid_property"})),
                ),
                Answer::Gone => (
                    StatusCode::NOT_FOUND,
                    axum::Json(json!({ "error": "Product not found" })),
                ),
                Answer::Down => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({ "error": "boom" })),
                ),
                Answer::Silent => (StatusCode::OK, axum::Json(Value::Null)),
            }
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("fake CardTrader port");
    let address = listener.local_addr().expect("fake CardTrader address");
    if matches!(answer, Answer::Silent) {
        drop(listener);
        return (format!("http://{address}"), seen);
    }
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("fake CardTrader");
    });
    (format!("http://{address}"), seen)
}

/// A connected seller who pushes to CardTrader, or only imports from it.
fn integration_doc(direction: &str) -> Value {
    json!({
        "uid": SELLER,
        "enabled": true,
        "encryptedToken": encrypt_secret(CT_TOKEN, Some(CT_KEY)),
        "metadata": {},
        "inventorySync": { "direction": direction },
    })
}

/// 1-Day Ready: CardTrader stocks the products, Pokoin never edits them.
fn one_day_ready() -> Value {
    let mut doc = integration_doc("pokoin_to_ct");
    doc["metadata"] = json!({ "oneDayReady": true });
    doc
}

struct Env {
    pool: PgPool,
    app: Router,
    seen: Arc<Mutex<Vec<Seen>>>,
    grant: String,
}

/// Fresh tables and a seller whose CardTrader answers `answer`; `None` doc is
/// a seller who never connected.
async fn setup(answer: Answer, doc: Option<Value>) -> Option<Env> {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return None;
    };
    std::env::set_var("POKOIN_LISTING_SYNC_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_WEBHOOK_WORKER", "0");
    std::env::set_var("POKOIN_SELLER_BOOK_WORKER", "0");
    std::env::set_var("POKOIN_READ_CACHE", "0");
    std::env::set_var("CARDTRADER_TOKEN_ENCRYPTION_KEY", CT_KEY);
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .expect("test database");
    for sql in [
        include_str!("sql/flow_listings.sql"),
        include_str!("../../../../scripts/sql/096_marketplace_outbox.sql"),
        include_str!("../../../../scripts/sql/115_seller_api_grants.sql"),
        include_str!("../../../../scripts/sql/118_unpriced_paused_inventory.sql"),
        include_str!("../../../../scripts/sql/138_seller_pricing_groups.sql"),
        include_str!("sql/flow_riftbound_blueprints.sql"),
    ] {
        sqlx::raw_sql(sql).execute(&pool).await.expect("schema");
    }
    // The satellite catalog `game_pools` reads for a Riftbound listing.
    std::env::set_var("RIFTBOUND_MARKETPLACE_DATABASE_URL", &url);
    let (base, seen) = fake_cardtrader(answer).await;
    let firestore = MemoryFirestore::new();
    if let Some(doc) = doc {
        firestore
            .seed(
                integration::COLLECTION,
                &integration::integration_doc_id(SELLER),
                doc,
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
    )
    .with_cardtrader_access(Arc::new(firestore), CardTraderClient::with_base(base));
    let app = pokoin_commerce::router(state.clone());
    let (status, created) = call(
        &app,
        "POST",
        "/api/seller-api-grants",
        SELLER,
        json!({"action": "create", "client": "Card Rails"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let grant = created["token"].as_str().unwrap_or_default().to_string();
    Some(Env {
        pool,
        app,
        seen,
        grant,
    })
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
    /// MyPokoin's listing edit, as the seller.
    async fn edit(&self, id: Uuid, body: Value) -> (StatusCode, Value) {
        call(
            &self.app,
            "PATCH",
            &format!("/api/marketplace-listings?id={id}"),
            SELLER,
            body,
        )
        .await
    }

    /// Card Rails' `update` over the seller-API connector.
    async fn connector_update(&self, id: Uuid, item: Value) -> (StatusCode, Value) {
        call(
            &self.app,
            "POST",
            "/api/cardrails/connector",
            &self.grant,
            json!({"action": "update", "channel": "pokoin", "listingId": id.to_string(), "item": item}),
        )
        .await
    }

    /// A linked, on-sale listing: 400 PKN, 2 copies, Near Mint English.
    async fn linked_listing(&self) -> Uuid {
        sqlx::query_scalar(
            "insert into public.marketplace_user_listings (card_id, seller_uid, seller_name, \
               seller_country, marketplace_game, source, source_listing_id, price_pkn, \
               quantity_available, condition, language, card_name) \
             values ($1, $2, 'alice', 'IT', 'pokemon', 'cardtrader', 'ct:99', 400, 2, 'NM', 'EN', 'Espurr') \
             returning id",
        )
        .bind(CARD)
        .bind(SELLER)
        .fetch_one(&self.pool)
        .await
        .expect("listing")
    }

    /// The same, of a game whose CardTrader properties come from its blueprint.
    async fn linked_riftbound_listing(&self) -> Uuid {
        sqlx::query_scalar(
            "insert into public.marketplace_user_listings (card_id, seller_uid, seller_name, \
               seller_country, marketplace_game, source, source_listing_id, price_pkn, \
               quantity_available, condition, language, card_name) \
             values ($1, $2, 'alice', 'IT', 'riftbound', 'cardtrader', 'ct:99', 400, 2, 'NM', 'EN', 'Akui, Riftbreaker') \
             returning id",
        )
        .bind(CARD)
        .bind(SELLER)
        .fetch_one(&self.pool)
        .await
        .expect("listing")
    }

    /// A linked copy of a reverse first edition: both flags on, so an edit
    /// that turns them off is a facet CardTrader's product has to be told.
    async fn linked_flagged_listing(&self) -> Uuid {
        sqlx::query_scalar(
            "insert into public.marketplace_user_listings (card_id, seller_uid, seller_name, \
               seller_country, marketplace_game, source, source_listing_id, price_pkn, \
               quantity_available, condition, language, card_name, reverse, foil_state, first_edition) \
             values ($1, $2, 'alice', 'IT', 'pokemon', 'cardtrader', 'ct:99', 400, 2, 'NM', 'EN', 'Espurr', \
               true, 'reverse', true) \
             returning id",
        )
        .bind(CARD)
        .bind(SELLER)
        .fetch_one(&self.pool)
        .await
        .expect("flagged listing")
    }

    async fn row(&self, id: Uuid) -> Value {
        sqlx::query_scalar::<_, Value>(
            "select to_jsonb(v) from (select condition, language, signed, source_listing_id, \
               price_pkn, quantity_available, status, reverse, first_edition, foil_state \
             from public.marketplace_user_listings where id = $1) v",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .expect("row")
    }

    /// The outbox payloads queued so far, oldest first.
    async fn events(&self) -> Vec<Value> {
        sqlx::query_scalar::<_, Value>("select payload from public.marketplace_outbox order by id")
            .fetch_all(&self.pool)
            .await
            .expect("outbox")
    }

    /// What the fake was PUT.
    fn puts(&self) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|seen| seen.method == "PUT")
            .cloned()
            .collect()
    }
}

/// A language edit is one strict PUT of the product's properties, and the row
/// saves with CardTrader's answer in the reply.
#[tokio::test]
async fn a_language_edit_puts_the_product_before_the_row_is_saved() {
    let _serial = serial().lock().await;
    let Some(env) = setup(Answer::Accepted, Some(integration_doc("pokoin_to_ct"))).await else {
        return;
    };
    let id = env.linked_listing().await;
    let (status, body) = env.edit(id, json!({"language": "IT"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["cardtrader"],
        json!({"ok": true, "facets": "updated"}),
        "{body}"
    );
    assert_eq!(env.row(id).await["language"], "IT", "the row saved");
    let puts = env.puts();
    assert_eq!(puts.len(), 1, "one PUT: {puts:?}");
    assert_eq!(puts[0].path, format!("/products/{PRODUCT}"));
    assert_eq!(puts[0].authorization, format!("Bearer {CT_TOKEN}"));
    assert_eq!(puts[0].body["error_mode"], "strict", "{puts:?}");
    assert_eq!(puts[0].body["properties"]["pokemon_language"], "it");
    assert_eq!(puts[0].body["properties"]["condition"], "Near Mint");
    assert!(
        puts[0].body.get("price").is_none() && puts[0].body.get("quantity").is_none(),
        "a facet write carries neither price nor stock: {}",
        puts[0].body
    );
    // The listing event is still queued, and it carries no facet to send twice.
    let events = env.events().await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(
        events[0]["cardtraderEdit"],
        Value::Null,
        "the event re-sends no facet"
    );
}

/// CardTrader says no: the seller gets 409 with the reason and Pokoin writes
/// nothing at all, not even the row or its event.
#[tokio::test]
async fn a_refused_facet_writes_nothing() {
    let _serial = serial().lock().await;
    let Some(env) = setup(Answer::Refused, Some(integration_doc("both"))).await else {
        return;
    };
    let id = env.linked_listing().await;
    let (status, body) = env.edit(id, json!({"language": "IT"})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "cardtrader_refused", "{body}");
    assert!(
        body["error"].to_string().contains("Nothing was changed"),
        "{body}"
    );
    let row = env.row(id).await;
    assert_eq!(row["language"], "EN", "the row kept its language");
    assert!(
        env.events().await.is_empty(),
        "the queued event rolled back with the write"
    );
    assert_eq!(env.puts().len(), 1, "one attempt, refused");
}

/// A 5xx and a request that got no answer at all both answer 502 and write
/// nothing: the PUT is a rewrite of absolute values, so trying again is safe.
#[tokio::test]
async fn no_clear_answer_writes_nothing() {
    for answer in [Answer::Down, Answer::Silent] {
        let _serial = serial().lock().await;
        let Some(env) = setup(answer, Some(integration_doc("pokoin_to_ct"))).await else {
            return;
        };
        let id = env.linked_listing().await;
        let (status, body) = env.edit(id, json!({"condition": "LP"})).await;
        assert_eq!(
            status,
            StatusCode::BAD_GATEWAY,
            "{body} (answer {answer:?})"
        );
        assert_eq!(body["code"], "cardtrader_unreachable", "{body}");
        assert_eq!(env.row(id).await["condition"], "NM", "nothing was written");
        assert!(env.events().await.is_empty());
    }
}

/// CardTrader no longer has the product: the save goes ahead, and the answer
/// says the link has to be redone.
#[tokio::test]
async fn a_gone_product_saves_and_asks_for_a_relink() {
    let _serial = serial().lock().await;
    let Some(env) = setup(Answer::Gone, Some(integration_doc("pokoin_to_ct"))).await else {
        return;
    };
    let id = env.linked_listing().await;
    let (status, body) = env
        .edit(id, json!({"firstEdition": true, "condition": "LP"}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["cardtrader"]["ok"], false, "{body}");
    assert_eq!(
        body["cardtrader"]["error"],
        "The CardTrader product no longer exists; the next sync relinks it.",
        "{body}"
    );
    let row = env.row(id).await;
    assert_eq!(row["condition"], "LP", "Pokoin saved the edit");
    assert_eq!(
        row["source_listing_id"], "ct:99",
        "and left the link for the sync"
    );
    assert_eq!(env.events().await.len(), 1, "the save stands on its own");
}

/// A facet the mapping cannot express is refused before a byte is sent: the
/// seller's value is the problem, and retrying it would be refused again.
#[tokio::test]
async fn an_unmappable_facet_is_refused_before_any_request() {
    let _serial = serial().lock().await;
    let Some(env) = setup(Answer::Accepted, Some(integration_doc("pokoin_to_ct"))).await else {
        return;
    };
    // The Riftbound blueprint of this card carries English only.
    let id = env.linked_riftbound_listing().await;
    let (status, body) = env.edit(id, json!({"language": "IT"})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "cardtrader_facet_unsupported", "{body}");
    assert_eq!(
        body["error"], "CardTrader has no such language for this card.",
        "{body}"
    );
    assert!(env.puts().is_empty(), "nothing was sent to CardTrader");
    assert_eq!(env.row(id).await["language"], "EN", "nothing was written");
    assert!(env.events().await.is_empty());
}

/// A copy that shares its product with live siblings never rewrites it: the
/// group would change for the others. It leaves the group instead.
#[tokio::test]
async fn a_copy_that_shares_its_product_leaves_the_group_instead() {
    let _serial = serial().lock().await;
    let Some(env) = setup(Answer::Accepted, Some(integration_doc("pokoin_to_ct"))).await else {
        return;
    };
    let mine = env.linked_listing().await;
    let _other = env.linked_listing().await;
    let (status, body) = env.edit(mine, json!({"condition": "LP"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        body.get("cardtrader").is_none(),
        "CardTrader was never asked: {body}"
    );
    assert!(env.puts().is_empty(), "never a PUT of a shared product");
    let row = env.row(mine).await;
    assert_eq!(row["condition"], "LP", "the copy kept its own edit");
    assert_eq!(row["source_listing_id"], "", "and left the product");
    let events = env.events().await;
    assert_eq!(
        events[0]["cardtraderEdit"],
        json!({"productId": PRODUCT, "leaveGroup": true, "quantityDelta": -2}),
        "{:?}",
        events[0]
    );
}

/// A seller who only imports, or whose CardTrader account is 1-Day Ready, is
/// never asked: Pokoin saves and says nothing about CardTrader.
#[tokio::test]
async fn a_seller_who_never_pushes_is_never_asked() {
    for doc in [integration_doc("ct_to_pokoin"), one_day_ready()] {
        let _serial = serial().lock().await;
        let Some(env) = setup(Answer::Accepted, Some(doc.clone())).await else {
            return;
        };
        let id = env.linked_listing().await;
        let (status, body) = env
            .edit(id, json!({"language": "IT", "signed": true}))
            .await;
        assert_eq!(status, StatusCode::OK, "{body} ({doc})");
        assert!(body.get("cardtrader").is_none(), "{body}");
        assert!(env.puts().is_empty(), "nothing sent: {doc}");
        let row = env.row(id).await;
        assert_eq!(row["language"], "IT", "Pokoin still saved it");
        assert_eq!(row["signed"], true, "Pokoin still saved it");
    }
}

/// A price-only edit sends no facet, from MyPokoin and from Card Rails: the
/// price and the stock still follow through the outbox.
#[tokio::test]
async fn a_price_only_edit_sends_no_facet() {
    let _serial = serial().lock().await;
    let Some(env) = setup(Answer::Accepted, Some(integration_doc("pokoin_to_ct"))).await else {
        return;
    };
    let id = env.linked_listing().await;
    let (status, body) = env.edit(id, json!({"pricePkn": 420})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.get("cardtrader").is_none(), "{body}");
    assert!(env.puts().is_empty(), "a price is not a facet");
    let events = env.events().await;
    assert_eq!(
        events[0]["cardtraderEdit"],
        json!({"productId": PRODUCT, "pricePkn": 420}),
        "{:?}",
        events[0]
    );
    // Card Rails' `update` reaches the same save.
    let (status, updated) = env
        .connector_update(id, json!({"priceEurCents": 250}))
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert!(updated.get("cardtrader").is_none(), "{updated}");
    assert!(env.puts().is_empty(), "and sends no facet either");
    assert_eq!(env.row(id).await["price_pkn"].as_f64(), Some(500.0));
}

/// A flag the seller turned off is a facet CardTrader's product has to be told
/// about: a PUT says nothing of a property it does not name, so leaving
/// `pokemon_reverse` out would keep the card on sale as a reverse.
#[tokio::test]
async fn a_flag_turned_off_is_sent_as_false() {
    let _serial = serial().lock().await;
    let Some(env) = setup(Answer::Accepted, Some(integration_doc("pokoin_to_ct"))).await else {
        return;
    };
    let id = env.linked_flagged_listing().await;
    let (status, body) = env
        .edit(
            id,
            json!({"reverse": false, "foilState": "standard", "firstEdition": false}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["cardtrader"],
        json!({"ok": true, "facets": "updated"}),
        "{body}"
    );
    let puts = env.puts();
    assert_eq!(puts.len(), 1, "one PUT: {puts:?}");
    assert_eq!(
        puts[0].body["properties"]["pokemon_reverse"],
        json!(false),
        "reverse off goes explicitly, not unsaid: {}",
        puts[0].body["properties"]
    );
    assert_eq!(
        puts[0].body["properties"]["pokemon_first_edition"],
        json!(false),
        "{}",
        puts[0].body["properties"]
    );
    // The create always names signed and altered, so they stay as they are,
    // and nothing else was switched off: only the two flags gained a `false`.
    assert_eq!(
        puts[0].body["properties"]["signed"],
        json!(false),
        "{}",
        puts[0].body["properties"]
    );
    assert_eq!(
        puts[0].body["properties"]["altered"],
        json!(false),
        "{}",
        puts[0].body["properties"]
    );
    let row = env.row(id).await;
    assert_eq!(row["reverse"], false, "and Pokoin saved the row");
    assert_eq!(row["foil_state"], "standard");
    assert_eq!(row["first_edition"], false);
    assert_eq!(row["source_listing_id"], "ct:99", "still linked");
}

/// A seller Pokoin never writes for is never refused over a facet nobody is
/// asked to carry: their integration is read, and its skip applied, before the
/// blueprint or the mapping is consulted.
#[tokio::test]
async fn an_import_only_seller_is_never_refused_a_facet() {
    let _serial = serial().lock().await;
    let Some(env) = setup(Answer::Accepted, Some(integration_doc("ct_to_pokoin"))).await else {
        return;
    };
    // The Riftbound blueprint of this card carries English only, so a pushing
    // seller is refused this language (`an_unmappable_facet_is_refused_before_any_request`).
    let id = env.linked_riftbound_listing().await;
    let (status, body) = env.edit(id, json!({"language": "IT"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        body.get("cardtrader").is_none(),
        "an import-only seller gets no CardTrader answer: {body}"
    );
    assert!(env.puts().is_empty(), "nothing reached CardTrader");
    assert_eq!(env.row(id).await["language"], "IT", "Pokoin saved it");
}
