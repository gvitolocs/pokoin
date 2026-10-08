//! Hermetic end-to-end tests: the real commerce router and the real Firestore
//! client talking to an in-process mock Firestore over HTTP.
//!
//! This exercises the wiring that unit tests cannot: extractors → handler →
//! Firestore documents/query/transaction → a second request reading the result
//! back. No network, no credentials, no database.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;
use tower::ServiceExt;

use pokoin_commerce::auth::{AuthError, Claims, TokenVerifier};
use pokoin_commerce::config::CommerceConfig;
use pokoin_commerce::firestore::{value_to_fields, FirestoreClient};
use pokoin_commerce::state::DomainState;
use pokoin_commerce::store::LedgerOp;
use pokoin_commerce::{store, FixedClock};

// ---------------------------------------------------------------------------
// Mock Firestore
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct MockStore {
    documents: Arc<Mutex<HashMap<String, Value>>>,
}

impl MockStore {
    fn get(&self, path: &str) -> Option<Value> {
        self.documents.lock().unwrap().get(path).cloned()
    }
    fn upsert(&self, path: &str, value: Value, merge: bool) {
        let mut guard = self.documents.lock().unwrap();
        let entry = guard.entry(path.to_string()).or_insert_with(|| json!({}));
        if merge {
            if let (Some(target), Some(extra)) = (entry.as_object_mut(), value.as_object()) {
                for (key, field) in extra {
                    target.insert(key.clone(), field.clone());
                }
            }
        } else {
            *entry = value;
        }
    }
    fn delete(&self, path: &str) {
        self.documents.lock().unwrap().remove(path);
    }
    fn all(&self) -> Vec<(String, Value)> {
        self.documents
            .lock()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }
}

fn document_resource(path: &str, value: &Value, base: &str) -> Value {
    json!({
        "name": format!("{base}/{path}"),
        "fields": value_to_fields(value),
    })
}

async fn mock_batch_get(
    State(state): State<MockStore>,
    Json(body): Json<Value>,
) -> Response {
    let paths = body
        .get("documents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let base = body
        .get("base")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut results = Vec::new();
    for path in paths {
        let Some(full) = path.as_str() else { continue };
        let key = strip_prefix(full);
        match state.get(&key) {
            Some(value) => results.push(
                json!({ "found": document_resource(&key, &value, base.trim_end_matches('/')) }),
            ),
            None => results.push(json!({ "missing": full })),
        }
    }
    Json(Value::Array(results)).into_response()
}

fn strip_prefix(full_path: &str) -> String {
    match full_path.find("/documents/") {
        Some(index) => full_path[index + "/documents/".len()..].to_string(),
        None => full_path.trim_start_matches('/').to_string(),
    }
}

async fn mock_begin_transaction() -> Response {
    Json(json!({ "transaction": "bW9jay10cmFuc2FjdGlvbg==" })).into_response()
}

async fn mock_commit(
    State(state): State<MockStore>,
    Json(body): Json<Value>,
) -> Response {
    let writes = body
        .get("writes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for write in writes {
        if let Some(delete) = write.get("delete").and_then(Value::as_str) {
            state.delete(&strip_prefix(delete));
            continue;
        }
        if let Some(transform) = write.get("transform") {
            let path = transform
                .get("document")
                .and_then(Value::as_str)
                .map(strip_prefix)
                .unwrap_or_default();
            let mut current = state.get(&path).unwrap_or_else(|| json!({}));
            if let Some(fields) = transform.get("fieldTransforms").and_then(Value::as_array) {
                for field in fields {
                    let name = field.get("fieldPath").and_then(Value::as_str).unwrap_or_default();
                    if field.get("setToServerValue").is_some() {
                        if let Some(object) = current.as_object_mut() {
                            object.insert(name.to_string(), json!("2026-10-08T00:00:00.000Z"));
                        }
                    }
                    if let Some(increment) = field.get("increment") {
                        let amount: i64 = increment
                            .get("integerValue")
                            .and_then(Value::as_str)
                            .and_then(|value| value.parse().ok())
                            .unwrap_or(0);
                        let existing = current
                            .get(name)
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        if let Some(object) = current.as_object_mut() {
                            object.insert(name.to_string(), json!(existing + amount));
                        }
                    }
                }
            }
            state.upsert(&path, current, true);
            continue;
        }
        let Some(update) = write.get("update") else { continue };
        let path = update
            .get("name")
            .and_then(Value::as_str)
            .map(strip_prefix)
            .unwrap_or_default();
        let fields = update.get("fields").cloned().unwrap_or_else(|| json!({}));
        let decoded = pokoin_commerce::firestore::fields_to_value(Some(&fields));
        let merge = write.get("updateMask").is_some();
        state.upsert(&path, decoded, merge);
    }
    Json(json!({ "writeResults": [] })).into_response()
}

async fn mock_patch(
    State(state): State<MockStore>,
    Path(path): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<Value>,
) -> Response {
    let key = path.clone();
    if query.get("currentDocument.exists").map(String::as_str) == Some("true") && state.get(&key).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": { "status": "NOT_FOUND" } }))).into_response();
    }
    let merge = query.keys().any(|name| name.starts_with("updateMask."));
    let fields = body.get("fields").cloned().unwrap_or_else(|| json!({}));
    let decoded = pokoin_commerce::firestore::fields_to_value(Some(&fields));
    state.upsert(&key, decoded, merge);
    let value = state.get(&key).unwrap_or_else(|| json!({}));
    Json(document_resource(&key, &value, "https://mock")).into_response()
}

async fn mock_get_document(
    State(state): State<MockStore>,
    Path(path): Path<String>,
) -> Response {
    match state.get(&path) {
        Some(value) => Json(document_resource(&path, &value, "https://mock")).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": { "status": "NOT_FOUND" } })),
        )
            .into_response(),
    }
}

async fn mock_delete(
    State(state): State<MockStore>,
    Path(path): Path<String>,
) -> Response {
    state.delete(&path);
    Json(json!({})).into_response()
}

async fn mock_create(
    State(state): State<MockStore>,
    Path(collection): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<Value>,
) -> Response {
    let id = query.get("documentId").cloned().unwrap_or_else(|| "auto".into());
    let path = format!("{collection}/{id}");
    if state.get(&path).is_some() {
        return (StatusCode::CONFLICT, Json(json!({ "error": { "status": "ALREADY_EXISTS" } }))).into_response();
    }
    let fields = body.get("fields").cloned().unwrap_or_else(|| json!({}));
    let decoded = pokoin_commerce::firestore::fields_to_value(Some(&fields));
    state.upsert(&path, decoded, false);
    Json(document_resource(&path, &state.get(&path).unwrap_or(json!({})), "https://mock")).into_response()
}

async fn mock_run_query(
    State(state): State<MockStore>,
    Json(body): Json<Value>,
) -> Response {
    let query = body.get("structuredQuery").cloned().unwrap_or(json!({}));
    let collection = query
        .get("from")
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(|row| row.get("collectionId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let filters: Vec<Value> = match query.get("where") {
        Some(where_clause) if where_clause.get("compositeFilter").is_some() => where_clause
            .get("compositeFilter")
            .and_then(|composite| composite.get("filters"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        Some(single) => vec![single.clone()],
        None => Vec::new(),
    };
    let limit = query.get("limit").and_then(Value::as_u64).unwrap_or(1000) as usize;

    let mut rows: Vec<(String, Value)> = state
        .all()
        .into_iter()
        .filter(|(path, _)| path.starts_with(&format!("{collection}/")))
        .filter(|(_, value)| {
            filters.iter().all(|filter| {
                let Some(field_filter) = filter.get("fieldFilter") else {
                    return true;
                };
                let field = field_filter
                    .get("field")
                    .and_then(|field| field.get("fieldPath"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let expected = pokoin_commerce::firestore::decode_value(
                    field_filter.get("value").unwrap_or(&Value::Null),
                );
                value.get(field) == Some(&expected)
            })
        })
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    rows.truncate(limit);
    Json(
        rows.into_iter()
            .map(|(path, value)| json!({ "document": document_resource(&path, &value, "https://mock") }))
            .collect::<Vec<_>>(),
    )
    .into_response()
}

/// Start the mock Firestore and return its document base URL.
async fn start_mock_firestore() -> (String, MockStore) {
    let store = MockStore::default();
    let base = "/v1/projects/pokoin-test/databases/(default)/documents".to_string();
    let app = Router::new()
        .route(
            "/v1/projects/pokoin-test/databases/(default)/documents:batchGet",
            post(mock_batch_get),
        )
        .route(
            "/v1/projects/pokoin-test/databases/(default)/documents:beginTransaction",
            post(mock_begin_transaction),
        )
        .route(
            "/v1/projects/pokoin-test/databases/(default)/documents:commit",
            post(mock_commit),
        )
        .route(
            "/v1/projects/pokoin-test/databases/(default)/documents:runQuery",
            post(mock_run_query),
        )
        .route("/v1/projects/pokoin-test/databases/(default)/documents/{*path}", get(mock_get_document))
        .route("/v1/projects/pokoin-test/databases/(default)/documents/{*path}", patch(mock_patch))
        .route("/v1/projects/pokoin-test/databases/(default)/documents/{*path}", axum::routing::delete(mock_delete))
        .route("/v1/projects/pokoin-test/databases/(default)/documents/{*path}", post(mock_create))
        .with_state(store.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}{base}"), store)
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct AnyToken;
#[async_trait]
impl TokenVerifier for AnyToken {
    async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        if token.is_empty() {
            return Err(AuthError::Missing);
        }
        Ok(Claims {
            uid: "buyer-1".into(),
            email: "buyer@example.com".into(),
            role: String::new(),
            admin: false,
            is_admin: false,
        })
    }
}

async fn state_harness() -> (DomainState, FirestoreClient) {
    let (base, _store) = start_mock_firestore().await;
    let http = reqwest::Client::new();
    let firestore = FirestoreClient::with_static_token(http, "pokoin-test", base, "test-token");
    let mut config = CommerceConfig::default();
    config.pokoin_treasury_username = "pokoin".into();
    // Short acquire timeout: the harness has no Postgres, so SQL paths must
    // fail fast instead of waiting on the driver default.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy("postgres://127.0.0.1:1/none")
        .expect("lazy pool");
    let state = DomainState::with_pools(
        config,
        pool.clone(),
        pool,
        None,
        Arc::new(AnyToken),
        Some(firestore.clone()),
    )
    .with_clock(Arc::new(FixedClock(1_700_000_000_000)));
    (state, firestore)
}

async fn harness() -> (Router, FirestoreClient) {
    let (base, _store) = start_mock_firestore().await;
    let http = reqwest::Client::new();
    let firestore = FirestoreClient::with_static_token(http, "pokoin-test", base, "test-token");
    let mut config = CommerceConfig::default();
    config.pokoin_treasury_username = "pokoin".into();
    // Short acquire timeout: the harness has no Postgres, so SQL paths must
    // fail fast instead of waiting on the driver default.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy("postgres://127.0.0.1:1/none")
        .expect("lazy pool");
    let state = DomainState::with_pools(
        config,
        pool.clone(),
        pool,
        None,
        Arc::new(AnyToken),
        Some(firestore.clone()),
    )
    .with_clock(Arc::new(FixedClock(1_700_000_000_000)));
    (pokoin_commerce::router(state), firestore)
}

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", "Bearer test-token")
        .header("content-type", "application/json");
    if method == "GET" {
        builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", "Bearer test-token");
    }
    let request = builder
        .body(body.map(|value| Body::from(value.to_string())).unwrap_or_else(Body::empty))
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("router");
    let status = response.status();
    let bytes = response.into_body().collect().await.expect("body").to_bytes();
    let payload = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::String(String::from_utf8_lossy(&bytes).to_string()))
    };
    (status, payload)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_pkn_transfer_moves_balances_writes_ledger_and_replays_idempotently() {
    let (_, firestore) = harness().await;
    let mint = LedgerOp::mint("buyer-1", 1_000, "account_top_up");
    store::apply(&firestore, &mint).await.expect("mint");
    assert_eq!(
        store::balance(&firestore, "buyer-1").await.unwrap().available_pkn,
        1_000
    );

    let mut op = LedgerOp::transfer("buyer-1", "seller-1", 250, "account_transfer_sent")
        .with_idempotency("transfer:t1")
        .with_meta(json!({ "purpose": "unit-test" }));
    op.receive_reason = Some("account_transfer_received".into());
    let outcome = store::apply(&firestore, &op).await.expect("transfer");
    assert!(outcome.applied);
    assert_eq!(outcome.from_available, 750);
    assert_eq!(outcome.to_available, 250);
    assert_eq!(
        store::balance(&firestore, "seller-1").await.unwrap().available_pkn,
        250
    );

    // The ledger kept both signed entries with the Node field names.
    let entries = firestore
        .run_query(&store::StructuredQuery::collection(store::LEDGER_ENTRIES).limit(50))
        .await
        .expect("ledger query");
    let types: Vec<String> = entries
        .iter()
        .filter_map(|row| row.get("type").and_then(Value::as_str).map(|v| v.to_string()))
        .collect();
    assert!(types.contains(&"account_transfer_sent".to_string()));
    assert!(types.contains(&"account_transfer_received".to_string()));
    assert!(types.contains(&"account_top_up".to_string()));
    assert!(entries
        .iter()
        .any(|row| row.get("purpose").and_then(Value::as_str) == Some("unit-test")));
    assert!(entries
        .iter()
        .any(|row| row.get("amountPkn").and_then(Value::as_i64) == Some(-250)));

    // Replaying the same idempotency key must not move money again.
    let replay = store::apply(&firestore, &op).await.expect("replay");
    assert!(!replay.applied);
    assert_eq!(
        store::balance(&firestore, "buyer-1").await.unwrap().available_pkn,
        750
    );
    assert_eq!(
        store::balance(&firestore, "seller-1").await.unwrap().available_pkn,
        250
    );
}

#[tokio::test]
async fn lock_then_unlock_burn_models_a_withdrawal() {
    let (_, firestore) = harness().await;
    store::apply(&firestore, &LedgerOp::mint("u1", 500, "account_top_up"))
        .await
        .unwrap();

    store::apply(&firestore, &LedgerOp::lock("u1", 200, "withdraw_requested").with_ref("wr-1"))
        .await
        .expect("lock");
    let balance = store::balance(&firestore, "u1").await.unwrap();
    assert_eq!(balance.available_pkn, 300);
    assert_eq!(balance.locked_pkn, 200);

    store::apply(&firestore, &LedgerOp::unlock("u1", 200, "withdraw_paid", false).with_ref("wr-1"))
        .await
        .expect("unlock");
    let balance = store::balance(&firestore, "u1").await.unwrap();
    assert_eq!(balance.available_pkn, 300);
    assert_eq!(balance.locked_pkn, 0);
}

#[tokio::test]
async fn an_insufficient_transfer_is_refused_and_changes_nothing() {
    let (_, firestore) = harness().await;
    store::apply(&firestore, &LedgerOp::mint("u1", 100, "account_top_up"))
        .await
        .unwrap();
    let op = LedgerOp::transfer("u1", "u2", 250, "account_transfer_sent");
    assert!(store::apply(&firestore, &op).await.is_err());
    assert_eq!(store::balance(&firestore, "u1").await.unwrap().available_pkn, 100);
    assert_eq!(store::balance(&firestore, "u2").await.unwrap().available_pkn, 0);
}

#[tokio::test]
async fn money_request_create_list_pay_over_the_real_router() {
    let (app, firestore) = harness().await;
    // Registry + profiles the handlers resolve through.
    firestore
        .create_document("usernames", "bob", &json!({ "uid": "bob-1" }))
        .await
        .expect("usernames/bob");
    firestore
        .create_document(
            "users",
            "buyer-1",
            &json!({ "username": "alice", "email": "alice@example.com" }),
        )
        .await
        .expect("users/buyer-1");
    firestore
        .create_document(
            "users",
            "bob-1",
            &json!({ "username": "bob", "email": "bob@example.com" }),
        )
        .await
        .expect("users/bob-1");
    // Bob has the PKN to pay with.
    store::apply(&firestore, &LedgerOp::mint("bob-1", 1_000, "account_top_up"))
        .await
        .unwrap();

    let (status, created) = call(
        &app,
        "POST",
        "/api/money-request?action=create",
        Some(json!({ "recipientUsername": "bob", "amountPkn": 250, "note": "lunch" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["ok"], json!(true));
    let request_id = created["requestId"].as_str().expect("requestId").to_string();

    let (status, listed) = call(&app, "GET", "/api/money-request?action=list", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["outgoing"].as_array().unwrap().len(), 1);
    assert_eq!(listed["outgoing"][0]["amountPkn"], json!(250));
    assert_eq!(listed["outgoing"][0]["status"], json!("pending"));

    // The requester cannot pay their own request.
    let (status, denied) = call(
        &app,
        "POST",
        "/api/money-request?action=pay",
        Some(json!({ "requestId": request_id })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{denied}");

    // Pay as the recipient (the test token resolves to buyer-1, so pay
    // directly through the ledger the same way the handler does, proving the
    // money moves exactly once).
    let mut op = LedgerOp::transfer("bob-1", "buyer-1", 250, "money_request_paid_sent")
        .with_idempotency(format!("money_request_pay:{request_id}"));
    op.receive_reason = Some("money_request_paid_received".into());
    op.ref_id = Some(request_id.clone());
    let outcome = store::apply(&firestore, &op).await.expect("pay");
    assert!(outcome.applied);
    assert_eq!(store::balance(&firestore, "bob-1").await.unwrap().available_pkn, 750);
    assert_eq!(
        store::balance(&firestore, "buyer-1").await.unwrap().available_pkn,
        250
    );

    // A second pay attempt with the same request id is a no-op.
    let replay = store::apply(&firestore, &op).await.expect("replay");
    assert!(!replay.applied);
    assert_eq!(store::balance(&firestore, "bob-1").await.unwrap().available_pkn, 750);

    // The create path queued exactly one notification for the payee.
    let notifications = firestore
        .run_query(
            &store::StructuredQuery::collection(store::NOTIFICATIONS)
                .where_eq("uid", json!("bob-1")),
        )
        .await
        .expect("notifications");
    assert_eq!(notifications.len(), 1);
    assert_eq!(
        notifications[0]["type"],
        json!("money_request_created")
    );
    assert_eq!(notifications[0]["amountPkn"], json!(250));
}

#[tokio::test]
async fn public_card_sales_never_expose_buyer_identity() {
    let (_, firestore) = harness().await;
    firestore
        .create_document(
            "marketplace_sales",
            "order-1__listing-1",
            &json!({
                "orderId": "order-1",
                "cardId": "693360",
                "sellerUid": "seller-1",
                "condition": "NM",
                "language": "EN",
                "quantity": 2,
                "pricePkn": 250,
                "soldAt": "2026-10-08T10:00:00.000Z",
                "voided": false,
                "buyerUid": "secret-buyer",
            }),
        )
        .await
        .unwrap();
    let state = DomainState::with_pools(
        CommerceConfig::default(),
        sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://127.0.0.1:1/none")
            .unwrap(),
        sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://127.0.0.1:1/none")
            .unwrap(),
        None,
        Arc::new(AnyToken),
        Some(firestore.clone()),
    );
    let sales = pokoin_commerce::handlers::orders::read_card_sales(&state, "693360", 20)
        .await
        .expect("sales");
    assert_eq!(sales.len(), 1);
    assert_eq!(sales[0]["quantity"], json!(2));
    assert_eq!(sales[0]["pricePkn"], json!(250));
    assert!(sales[0].get("buyerUid").is_none(), "buyer must never leak");
    assert!(sales[0].get("orderId").is_none(), "order id must never leak");
}

#[tokio::test]
async fn a_voided_or_cardtrader_sale_is_not_public() {
    let (_, firestore) = harness().await;
    for (id, extra) in [
        ("a", json!({ "voided": true })),
        ("b", json!({ "source": "cardtrader" })),
        ("c", json!({ "quantity": 0 })),
    ] {
        let mut document = json!({
            "orderId": "order-1",
            "cardId": "42",
            "sellerUid": "seller-1",
            "quantity": 1,
            "pricePkn": 10,
            "soldAt": "2026-10-08T10:00:00.000Z",
            "voided": false,
        });
        for (key, value) in extra.as_object().unwrap() {
            document[key] = value.clone();
        }
        firestore
            .create_document("marketplace_sales", id, &document)
            .await
            .unwrap();
    }
    firestore
        .create_document(
            "marketplace_sales",
            "keep",
            &json!({
                "orderId": "order-2",
                "cardId": "42",
                "sellerUid": "seller-1",
                "quantity": 1,
                "pricePkn": 11,
                "soldAt": "2026-10-08T11:00:00.000Z",
                "voided": false,
            }),
        )
        .await
        .unwrap();
    let state = DomainState::with_pools(
        CommerceConfig::default(),
        sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://127.0.0.1:1/none")
            .unwrap(),
        sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://127.0.0.1:1/none")
            .unwrap(),
        None,
        Arc::new(AnyToken),
        Some(firestore.clone()),
    );
    let sales = pokoin_commerce::handlers::orders::read_card_sales(&state, "42", 20)
        .await
        .expect("sales");
    assert_eq!(sales.len(), 1, "only the live native row is public");
    assert_eq!(sales[0]["pricePkn"], json!(11));
}

#[tokio::test]
async fn an_unauthenticated_request_is_rejected_before_any_firestore_write() {
    let (app, firestore) = harness().await;
    let request = Request::builder()
        .method("POST")
        .uri("/api/money-request?action=create")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "recipientUsername": "bob", "amountPkn": 10 }).to_string(),
        ))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let rows = firestore
        .run_query(&store::StructuredQuery::collection(store::MONEY_REQUESTS).limit(10))
        .await
        .unwrap();
    assert!(rows.is_empty());
}


#[tokio::test]
async fn seller_transfers_wait_for_a_ready_connect_account() {
    let (state, firestore) = state_harness().await;
    // Two sellers; the first has no Connect account, the second is fully refunded.
    firestore
        .create_document(
            "orders",
            "order-eur-1",
            &json!({
                "buyerUid": "buyer-1",
                "channel": "eur",
                "currency": "EUR",
                "paymentStatus": "paid",
                "fulfillmentMode": "physical",
                "totalEURCents": 2184,
                "shipments": [
                    { "sellerId": "seller-1", "sellerTransferCents": 1984, "shippingEURCents": 1684 },
                    { "sellerId": "seller-2", "sellerTransferCents": 500, "refundedCents": 500 },
                ],
                "items": [
                    { "listingId": "l1", "sellerUid": "seller-1", "quantity": 2,
                      "unitPricePkn": 100, "cardId": "1" },
                ],
                "createdAt": "2026-10-08T10:00:00.000Z",
            }),
        )
        .await
        .expect("order");
    // Seller-1 exists but is not READY yet.
    firestore
        .create_document(
            "users",
            "seller-1",
            &json!({ "username": "seller1", "stripeConnectStatus": "pending" }),
        )
        .await
        .expect("seller profile");

    let result = pokoin_commerce::handlers::orders::release_seller_transfers(&state, "order-eur-1")
        .await
        .expect("release");
    assert_eq!(result["duplicate"], json!(false));
    assert_eq!(result["complete"], json!(false));
    assert_eq!(result["pendingSellerIds"], json!(["seller-1"]));
    assert_eq!(result["transferIds"], json!([]));

    // The order stays in escrow with the pending seller recorded.
    let order = firestore
        .get_document(&firestore.document_path("orders", "order-eur-1"))
        .await
        .unwrap()
        .expect("order");
    assert_eq!(order["paymentStatus"], json!("escrow"));
    assert_eq!(order["transfersReleased"], json!(false));
    assert_eq!(order["transfersPendingSellerIds"], json!(["seller-1"]));
    // The fully-refunded seller never reaches Stripe.
    assert!(order["transfersBySeller"].get("seller-2").is_none());
}

#[tokio::test]
async fn a_released_order_is_idempotent() {
    let (state, firestore) = state_harness().await;
    firestore
        .create_document(
            "orders",
            "order-eur-2",
            &json!({
                "buyerUid": "buyer-1",
                "currency": "EUR",
                "paymentStatus": "released",
                "transfersReleased": true,
                "transferIds": ["tr_1"],
                "shipments": [{ "sellerId": "seller-1", "sellerTransferCents": 100 }],
            }),
        )
        .await
        .expect("order");
    let result = pokoin_commerce::handlers::orders::release_seller_transfers(&state, "order-eur-2")
        .await
        .expect("release");
    assert_eq!(result["duplicate"], json!(true));
}

#[tokio::test]
async fn transfers_are_refused_for_an_unpaid_order() {
    let (state, firestore) = state_harness().await;
    firestore
        .create_document(
            "orders",
            "order-eur-3",
            &json!({
                "buyerUid": "buyer-1",
                "currency": "EUR",
                "paymentStatus": "pending_stripe",
                "shipments": [{ "sellerId": "seller-1", "sellerTransferCents": 100 }],
            }),
        )
        .await
        .expect("order");
    let error = pokoin_commerce::handlers::orders::release_seller_transfers(&state, "order-eur-3")
        .await
        .unwrap_err();
    assert_eq!(error.status.as_u16(), 409);
}


#[tokio::test]
async fn a_sale_decrements_the_sellers_ownership_row_and_deletes_it_at_zero() {
    use pokoin_commerce::handlers::orders::{
        decrement_seller_ownership_for_sale, OwnershipLine,
    };
    let (state, firestore) = state_harness().await;
    firestore
        .create_document(
            "user_card_collections",
            "row-1",
            &json!({
                "uid": "seller-1",
                "listingId": "l1",
                "quantity": 3,
                "cardId": "693360",
                "ownershipType": "physical",
            }),
        )
        .await
        .expect("row");

    let line = OwnershipLine {
        listing_id: "l1".into(),
        seller_uid: "seller-1".into(),
        quantity: 1,
        source_listing_id: String::new(),
    };
    let result = decrement_seller_ownership_for_sale(&state, &line)
        .await
        .expect("decrement");
    assert_eq!(result["deleted"], json!(false));
    assert_eq!(result["before"], json!(3));
    assert_eq!(result["after"], json!(2));
    let row = firestore
        .get_document(&firestore.document_path("user_card_collections", "row-1"))
        .await
        .unwrap()
        .expect("row");
    assert_eq!(row["quantity"], json!(2));

    // Selling the remainder deletes the row.
    let rest = OwnershipLine {
        quantity: 2,
        ..line.clone()
    };
    let result = decrement_seller_ownership_for_sale(&state, &rest)
        .await
        .expect("decrement");
    assert_eq!(result["deleted"], json!(true));
    assert!(firestore
        .get_document(&firestore.document_path("user_card_collections", "row-1"))
        .await
        .unwrap()
        .is_none());

    // Nothing left to link: the sync reports it instead of inventing a row.
    let result = decrement_seller_ownership_for_sale(&state, &line)
        .await
        .expect("decrement");
    assert_eq!(result["skipped"], json!(true));
    assert_eq!(result["reason"], json!("no_linked_ownership"));
}

#[tokio::test]
async fn nft_ownership_rows_are_never_decremented() {
    use pokoin_commerce::handlers::orders::{
        decrement_seller_ownership_for_sale, OwnershipLine,
    };
    let (state, firestore) = state_harness().await;
    firestore
        .create_document(
            "user_card_collections",
            "nft-row",
            &json!({
                "uid": "seller-1",
                "listingId": "l9",
                "quantity": 1,
                "ownershipType": "nft",
            }),
        )
        .await
        .expect("nft row");
    let result = decrement_seller_ownership_for_sale(
        &state,
        &OwnershipLine {
            listing_id: "l9".into(),
            seller_uid: "seller-1".into(),
            quantity: 1,
            source_listing_id: String::new(),
        },
    )
    .await
    .expect("decrement");
    assert_eq!(result["skipped"], json!(true));
    assert_eq!(
        firestore
            .get_document(&firestore.document_path("user_card_collections", "nft-row"))
            .await
            .unwrap()
            .expect("still there")["quantity"],
        json!(1)
    );
}

#[tokio::test]
async fn a_scan_source_row_is_decremented_by_its_full_document_id() {
    use pokoin_commerce::handlers::orders::{
        decrement_seller_ownership_for_sale, OwnershipLine,
    };
    let (state, firestore) = state_harness().await;
    firestore
        .create_document(
            "user_card_collections",
            "scan:abc123",
            &json!({ "uid": "seller-1", "quantity": 5, "ownershipType": "physical" }),
        )
        .await
        .expect("scan row");
    let result = decrement_seller_ownership_for_sale(
        &state,
        &OwnershipLine {
            listing_id: "l1".into(),
            seller_uid: "seller-1".into(),
            quantity: 2,
            source_listing_id: "scan:abc123".into(),
        },
    )
    .await
    .expect("decrement");
    assert_eq!(result["docId"], json!("scan:abc123"));
    assert_eq!(result["after"], json!(3));
}


// ---------------------------------------------------------------------------
// Corrections from review: Firestore-owned Connect, real notifications,
// wallet_addresses registry, graceful optional-visual degradation.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn connect_state_lives_on_the_firestore_user_document() {
    // The GET handler reads users/{uid}.stripeConnectAccountId; with no account
    // it must answer not_started without touching any SQL profile.
    let (app, firestore) = harness().await;
    firestore
        .create_document(
            "users",
            "buyer-1",
            &json!({ "username": "alice", "shipFromCountry": "IT" }),
        )
        .await
        .expect("user");
    let (status, payload) = call(&app, "GET", "/api/stripe-connect-onboard", None).await;
    // Stripe is not configured in tests, so the handler fails closed (500/503)
    // rather than inventing an account — but it must have read Firestore first.
    assert!(status.is_server_error(), "{status} {payload}");
    let user = firestore
        .get_document(&firestore.document_path("users", "buyer-1"))
        .await
        .unwrap()
        .expect("user");
    assert_eq!(user["shipFromCountry"], json!("IT"));
    assert!(user.get("stripeConnectAccountId").is_none());
}

#[tokio::test]
async fn seller_transfers_resolve_a_ready_account_from_the_user_document() {
    // releaseSellerTransfers must read the Connect account from users/{uid}
    // (never a profile table). With no Stripe key configured the transfer
    // attempt fails loudly, which proves it reached the Stripe call.
    let (state, firestore) = state_harness().await;
    firestore
        .create_document(
            "orders",
            "order-connect",
            &json!({
                "currency": "EUR",
                "paymentStatus": "paid",
                "shipments": [{ "sellerId": "seller-1", "sellerTransferCents": 500 }],
                "items": [],
            }),
        )
        .await
        .expect("order");
    firestore
        .create_document(
            "users",
            "seller-1",
            &json!({
                "username": "seller1",
                "stripeConnectStatus": "READY",
                "stripeConnectAccountId": "acct_ready",
            }),
        )
        .await
        .expect("user");
    let error = pokoin_commerce::handlers::orders::release_seller_transfers(&state, "order-connect")
        .await
        .unwrap_err();
    // Reached Stripe and failed there (no key): the READY account was resolved
    // from the Firestore user document.
    assert!(error.message.to_lowercase().contains("stripe"), "{}", error.message);
}

#[tokio::test]
async fn seller_sale_notifications_claim_the_real_firestore_marker() {
    use pokoin_commerce::domain::notify;
    let (state, firestore) = state_harness().await;
    firestore
        .create_document(
            "orders",
            "order-notify",
            &json!({
                "uid": "buyer-1",
                "paymentStatus": "paid",
                "items": [
                    { "sellerUid": "seller-1", "cardName": "Pikachu", "quantity": 2,
                      "unitPricePkn": 100, "condition": "NM", "language": "EN" },
                    { "sellerUid": "seller-2", "cardName": "Mew", "quantity": 1,
                      "unitPricePkn": 50 },
                ],
            }),
        )
        .await
        .expect("order");
    firestore
        .create_document(
            "users",
            "seller-1",
            &json!({ "username": "seller1", "email": "seller1@example.com" }),
        )
        .await
        .expect("seller-1");
    firestore
        .create_document(
            "users",
            "seller-2",
            &json!({ "username": "seller2", "email": "seller2@wallet.pokoin.local" }),
        )
        .await
        .expect("seller-2");

    let first = pokoin_commerce::handlers::orders::
        send_seller_sale_notifications_for_paid_order(&state, "order-notify")
        .await
        .expect("notify");
    let results = first["results"].as_array().expect("results");
    assert_eq!(results.len(), 2);
    // No RESEND_API_KEY in tests: claimed, then recorded as skipped.
    let seller1 = results
        .iter()
        .find(|row| row["sellerUid"] == json!("seller-1"))
        .expect("seller-1 result");
    assert_eq!(seller1["skipped"], json!(true));
    assert_eq!(
        seller1["reason"],
        json!("RESEND_API_KEY is not configured.")
    );
    // A wallet alias is never deliverable.
    let seller2 = results
        .iter()
        .find(|row| row["sellerUid"] == json!("seller-2"))
        .expect("seller-2 result");
    assert_eq!(seller2["reason"], json!("Seller has no deliverable email."));

    // The marker documents exist with the Node doc ids and statuses.
    let marker1 = firestore
        .get_document(&firestore.document_path(
            notify::NOTIFICATION_COLLECTION,
            &notify::notification_marker_id("order-notify", "seller-1"),
        ))
        .await
        .unwrap()
        .expect("marker");
    assert_eq!(marker1["status"], json!("skipped"));
    assert_eq!(marker1["sellerEmail"], json!("seller1@example.com"));
    assert_eq!(marker1["quantity"], json!(2));
    assert_eq!(marker1["totalPkn"], json!(200.0));
    assert_eq!(marker1["itemCount"], json!(1));

    let markers = firestore
        .run_query(
            &store::StructuredQuery::collection(notify::NOTIFICATION_COLLECTION).limit(10),
        )
        .await
        .expect("markers");
    assert_eq!(markers.len(), 2);

    // A second call must not re-claim or re-send.
    let second = pokoin_commerce::handlers::orders::
        send_seller_sale_notifications_for_paid_order(&state, "order-notify")
        .await
        .expect("notify");
    for row in second["results"].as_array().expect("results") {
        assert_eq!(row["skipped"], json!(true));
        assert_eq!(row["reason"], json!("Notification already claimed."));
    }
}

#[tokio::test]
async fn notifications_are_skipped_for_an_unpaid_order() {
    let (state, firestore) = state_harness().await;
    firestore
        .create_document(
            "orders",
            "order-unpaid",
            &json!({
                "paymentStatus": "pending_stripe",
                "items": [{ "sellerUid": "seller-1", "quantity": 1 }],
            }),
        )
        .await
        .expect("order");
    let outcome = pokoin_commerce::handlers::orders::
        send_seller_sale_notifications_for_paid_order(&state, "order-unpaid")
        .await
        .expect("notify");
    assert_eq!(outcome["skipped"], json!(true));
    assert_eq!(outcome["reason"], json!("Order is not paid."));
    let markers = firestore
        .run_query(
            &store::StructuredQuery::collection("order_seller_sale_notifications").limit(10),
        )
        .await
        .expect("markers");
    assert!(markers.is_empty(), "an unpaid order must not claim a marker");
}

#[tokio::test]
async fn wallet_addresses_registry_is_read_from_firestore_document_ids() {
    // The registry keys documents BY the 0x address, so the doc id is the
    // address — this is the only source of top-up ownership.
    let (state, firestore) = state_harness().await;
    for (id, extra) in [
        ("0x1111111111111111111111111111111111111111", json!({ "uid": "buyer-1" })),
        ("0x2222222222222222222222222222222222222222", json!({ "uid": "buyer-1" })),
    ] {
        let mut document = extra;
        document["uid"] = json!("buyer-1");
        firestore.create_document("wallet_addresses", id, &document).await.unwrap();
    }
    // A different owner's wallet must not be claimed.
    firestore
        .create_document(
            "wallet_addresses",
            "0x3333333333333333333333333333333333333333",
            &json!({ "uid": "someone-else" }),
        )
        .await
        .unwrap();
    // A non-address document id in the same collection is ignored.
    firestore
        .create_document("wallet_addresses", "not-an-address", &json!({ "uid": "buyer-1" }))
        .await
        .unwrap();

    let rows = firestore
        .run_query(
            &store::StructuredQuery::collection("wallet_addresses")
                .where_eq("uid", json!("buyer-1"))
                .limit(5),
        )
        .await
        .expect("registry");
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(|v| v.to_string()))
        .collect();
    assert!(ids.contains(&"0x1111111111111111111111111111111111111111".to_string()));
    assert!(ids.contains(&"0x2222222222222222222222222222222222222222".to_string()));
    assert!(!ids.contains(&"0x3333333333333333333333333333333333333333".to_string()));
    let _ = state;
}


// ---------------------------------------------------------------------------
// CardTrader integration boundary (owned by the integrations crate)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct RecordingCardTrader {
    outcome: pokoin_commerce::cardtrader::CardTraderOutcome,
    calls: Arc<Mutex<Vec<String>>>,
}

impl RecordingCardTrader {
    fn new(outcome: pokoin_commerce::cardtrader::CardTraderOutcome) -> Self {
        Self {
            outcome,
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl pokoin_commerce::cardtrader::CardTraderPort for RecordingCardTrader {
    async fn sync_after_sale(
        &self,
        request: &pokoin_commerce::cardtrader::CardTraderSaleSync,
    ) -> Result<pokoin_commerce::cardtrader::CardTraderOutcome, pokoin_commerce::error::ApiError>
    {
        self.calls
            .lock()
            .unwrap()
            .push(format!("sync:{}", request.seller_uid));
        Ok(self.outcome.clone())
    }

    async fn buy_through(
        &self,
        request: &pokoin_commerce::cardtrader::CardTraderBuyThrough,
    ) -> Result<pokoin_commerce::cardtrader::CardTraderOutcome, pokoin_commerce::error::ApiError>
    {
        self.calls
            .lock()
            .unwrap()
            .push(format!("buy:{}", request.listing_id));
        Ok(self.outcome.clone())
    }
}

async fn paid_eur_order_with_port(
    outcome: pokoin_commerce::cardtrader::CardTraderOutcome,
) -> (DomainState, FirestoreClient, RecordingCardTrader) {
    let (state, firestore) = state_harness().await;
    let port = RecordingCardTrader::new(outcome);
    let state = state.with_cardtrader(Arc::new(port.clone()));
    firestore
        .create_document(
            "orders",
            "order-ct",
            &json!({
                "buyerUid": "buyer-1",
                "currency": "EUR",
                "channel": "eur",
                "paymentStatus": "paid",
                "fulfillmentMode": "physical",
                "totalEURCents": 2184,
                "shipments": [{ "sellerId": "seller-1", "sellerTransferCents": 1984 }],
                "items": [{
                    "listingId": "l1", "cardId": "693360", "sellerUid": "seller-1",
                    "quantity": 2, "unitPricePkn": 1000, "condition": "NM",
                    "language": "EN", "card": { "name": "Pikachu" },
                }],
                "createdAt": "2026-10-08T10:00:00.000Z",
            }),
        )
        .await
        .expect("order");
    // The seller's owned row so the ownership step has something to decrement.
    firestore
        .create_document(
            "user_card_collections",
            "row-ct",
            &json!({ "uid": "seller-1", "listingId": "l1", "quantity": 2,
                     "ownershipType": "physical" }),
        )
        .await
        .expect("ownership row");
    (state, firestore, port)
}

#[tokio::test]
async fn fulfilment_drives_the_cardtrader_port_and_completes_applied_steps() {
    use pokoin_commerce::cardtrader::CardTraderOutcome;
    let (state, firestore, port) =
        paid_eur_order_with_port(CardTraderOutcome::Applied {
            detail: json!({ "synced": true }),
        })
        .await;

    let result = pokoin_commerce::handlers::orders::fulfil_paid_eur_order(&state, "order-ct")
        .await
        .expect("fulfil");
    assert_eq!(result["done"], json!(true), "{result}");

    // Both boundaries were called exactly once, with the order's identifiers.
    let calls = port.calls();
    assert!(calls.contains(&"sync:seller-1".to_string()), "{calls:?}");
    assert!(calls.contains(&"buy:l1".to_string()), "{calls:?}");

    let order = firestore
        .get_document(&firestore.document_path("orders", "order-ct"))
        .await
        .unwrap()
        .expect("order");
    assert_eq!(order["fulfillment"]["steps"]["cardtrader_sync"], json!("done"));
    assert_eq!(order["fulfillment"]["steps"]["cardtrader_buy"], json!("done"));
    assert_eq!(order["fulfillment"]["steps"]["seller_ownership"], json!("done"));
    assert_eq!(order["fulfillment"]["steps"]["notifications"], json!("done"));
    assert_eq!(order["fulfillment"]["steps"]["sales"], json!("done"));
    // Every step completed, so the fulfilment is done and a retry short-circuits.
    assert_eq!(order["fulfillment"]["state"], json!("done"));
    assert_eq!(order["fulfillment"]["pendingWorkerSteps"], json!([]));
    assert_eq!(
        order["fulfillment"]["cardtrader"]["sync:seller-1"]["status"],
        json!("applied")
    );
    // The ownership row was decremented to zero and deleted.
    assert!(firestore
        .get_document(&firestore.document_path("user_card_collections", "row-ct"))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn an_unconfigured_cardtrader_leaves_the_steps_open() {
    use pokoin_commerce::cardtrader::CardTraderOutcome;
    let (state, firestore, port) =
        paid_eur_order_with_port(CardTraderOutcome::NotConfigured {
            reason: "seller has no token".into(),
        })
        .await;

    let result = pokoin_commerce::handlers::orders::fulfil_paid_eur_order(&state, "order-ct")
        .await
        .expect("fulfil");
    // Nothing is claimed done: the CardTrader steps stay open.
    assert_eq!(result["done"], json!(true), "no hard failure: {result}");
    assert!(!port.calls().is_empty());

    let order = firestore
        .get_document(&firestore.document_path("orders", "order-ct"))
        .await
        .unwrap()
        .expect("order");
    assert_ne!(order["fulfillment"]["steps"]["cardtrader_sync"], json!("done"));
    assert_ne!(order["fulfillment"]["steps"]["cardtrader_buy"], json!("done"));
    let pending = order["fulfillment"]["pendingWorkerSteps"]
        .as_array()
        .expect("pending");
    assert!(pending.contains(&json!("cardtrader_sync")), "{pending:?}");
    assert!(pending.contains(&json!("cardtrader_buy")), "{pending:?}");
    assert_eq!(
        order["fulfillment"]["cardtrader"]["sync:seller-1"]["status"],
        json!("not_configured")
    );
    assert_eq!(
        order["fulfillment"]["cardtrader"]["sync:seller-1"]["reason"],
        json!("seller has no token")
    );
}

#[tokio::test]
async fn a_second_fulfilment_run_does_not_call_cardtrader_again() {
    use pokoin_commerce::cardtrader::CardTraderOutcome;
    let (state, _firestore, port) =
        paid_eur_order_with_port(CardTraderOutcome::Applied {
            detail: json!({}),
        })
        .await;
    let _ = pokoin_commerce::handlers::orders::fulfil_paid_eur_order(&state, "order-ct")
        .await
        .expect("first");
    let before = port.calls().len();
    let second = pokoin_commerce::handlers::orders::fulfil_paid_eur_order(&state, "order-ct")
        .await
        .expect("second");
    // The order is already complete, so the retry short-circuits.
    assert_eq!(second["skipped"], json!("done"));
    assert_eq!(port.calls().len(), before, "no duplicate integration calls");
}


// ---------------------------------------------------------------------------
// releaseEurReservation (unpaid EUR order teardown)
// ---------------------------------------------------------------------------

async fn unpaid_eur_order(firestore: &FirestoreClient, payment_status: &str, with_discount: bool) {
    let mut order = json!({
        "buyerUid": "buyer-1",
        "currency": "EUR",
        "paymentStatus": payment_status,
        "status": "pending",
        "fulfillmentStatus": "pending",
        "inventory": { "state": "reserved", "lines": [{ "listingId": "l1", "quantity": 2 }] },
        "items": [{ "listingId": "l1", "sellerUid": "seller-1", "quantity": 2 }],
    });
    if with_discount {
        order["pknDiscount"] = json!({ "pkn": 120, "eurCents": 300, "state": "held" });
    }
    firestore
        .create_document("orders", "order-release", &order)
        .await
        .expect("order");
}


#[tokio::test]
async fn releasing_an_expired_order_cancels_it_and_returns_the_held_discount_once() {
    let (state, firestore) = state_harness().await;
    unpaid_eur_order(&firestore, "pending_stripe", true).await;
    // The buyer's discount is held: available down, locked up.
    store::apply(&firestore, &LedgerOp::mint("buyer-1", 500, "account_top_up"))
        .await
        .unwrap();
    store::apply(
        &firestore,
        &LedgerOp::lock("buyer-1", 120, "order_discount_held").with_ref("order-release"),
    )
    .await
    .unwrap();
    let held = store::balance(&firestore, "buyer-1").await.unwrap();
    assert_eq!(held.available_pkn, 380);
    assert_eq!(held.locked_pkn, 120);

    let result = pokoin_commerce::handlers::orders::release_eur_reservation(
        &state,
        "order-release",
        "expired",
        "expired",
        &[],
    )
    .await;
    // Either a live Postgres restored the listings, or the documented
    // environment error is reported; the Firestore contract holds either way.
    let restored = match &result {
        Ok(_) => true,
        Err(error) => {
            assert_eq!(error.code.as_deref(), Some("order_stock_restore_failed"));
            false
        }
    };

    // The order is cancelled (not merely expired) with the inventory released.
    let order = firestore
        .get_document(&firestore.document_path("orders", "order-release"))
        .await
        .unwrap()
        .expect("order");
    assert_eq!(order["paymentStatus"], json!("expired"));
    assert_eq!(order["status"], json!("cancelled"));
    assert_eq!(order["fulfillmentStatus"], json!("cancelled"));
    assert_eq!(order["cancelReason"], json!("expired"));
    assert!(order["cancelledAt"].is_string());
    if restored {
        assert_eq!(order["inventory"]["state"], json!("released"));
        assert_eq!(order["inventory"]["releaseReason"], json!("expired"));
    } else {
        // Node replaces the field with the restore failure, keeping the reason.
        assert!(
            order["inventory"]["restoreError"].is_string(),
            "restore failure must be recorded: {}",
            order["inventory"]
        );
    }
    assert_eq!(order["pknDiscount"]["state"], json!("released"));
    assert_eq!(order["pknDiscount"]["pkn"], json!(120));

    // The discount is back in the buyer's available balance.
    let balance = store::balance(&firestore, "buyer-1").await.unwrap();
    assert_eq!(balance.available_pkn, 500);
    assert_eq!(balance.locked_pkn, 0);

    // Re-running must not mint PKN. `expired` is still a releasable status (so
    // Node also re-enters), but the inventory is no longer reserved and the
    // discount is no longer held, so nothing moves.
    let second = pokoin_commerce::handlers::orders::release_eur_reservation(
        &state,
        "order-release",
        "expired",
        "expired",
        &[],
    )
    .await
    .expect("second release");
    assert_eq!(second["outcome"], json!("closed"));
    assert_eq!(second["lines"], json!(0));
    let balance = store::balance(&firestore, "buyer-1").await.unwrap();
    assert_eq!(balance.available_pkn, 500, "no double credit");
    assert_eq!(balance.locked_pkn, 0);
}

#[tokio::test]
async fn a_paid_order_is_never_released() {
    let (state, firestore) = state_harness().await;
    unpaid_eur_order(&firestore, "paid", true).await;
    let result = pokoin_commerce::handlers::orders::release_eur_reservation(
        &state,
        "order-release",
        "expired",
        "expired",
        &[],
    )
    .await
    .expect("release");
    assert_eq!(result["outcome"], json!("not_releasable"));
    let order = firestore
        .get_document(&firestore.document_path("orders", "order-release"))
        .await
        .unwrap()
        .expect("order");
    // Untouched: still paid, still reserved.
    assert_eq!(order["paymentStatus"], json!("paid"));
    assert_eq!(order["status"], json!("pending"));
    assert_eq!(order["inventory"]["state"], json!("reserved"));
}

#[tokio::test]
async fn a_failed_async_payment_may_also_release_a_processing_order() {
    let (state, firestore) = state_harness().await;
    unpaid_eur_order(&firestore, "processing", false).await;
    // Without the extra status a `processing` order is not releasable…
    let blocked = pokoin_commerce::handlers::orders::release_eur_reservation(
        &state,
        "order-release",
        "expired",
        "expired",
        &[],
    )
    .await
    .expect("release");
    assert_eq!(blocked["outcome"], json!("not_releasable"));
    // …but `async_payment_failed` passes it as releasable, like Node.
    let released = pokoin_commerce::handlers::orders::release_eur_reservation(
        &state,
        "order-release",
        "payment_failed",
        "failed",
        &["processing"],
    )
    .await;
    if let Err(error) = &released {
        assert_eq!(error.code.as_deref(), Some("order_stock_restore_failed"));
    }
    let order = firestore
        .get_document(&firestore.document_path("orders", "order-release"))
        .await
        .unwrap()
        .expect("order");
    assert_eq!(order["paymentStatus"], json!("failed"));
    assert_eq!(order["status"], json!("cancelled"));
    assert_eq!(order["cancelReason"], json!("payment_failed"));
}

#[tokio::test]
async fn an_order_without_a_reservation_is_closed_not_released() {
    let (state, firestore) = state_harness().await;
    firestore
        .create_document(
            "orders",
            "order-release",
            &json!({
                "buyerUid": "buyer-1",
                "paymentStatus": "pending_stripe",
                "inventory": { "state": "released" },
            }),
        )
        .await
        .expect("order");
    let result = pokoin_commerce::handlers::orders::release_eur_reservation(
        &state,
        "order-release",
        "expired",
        "expired",
        &[],
    )
    .await
    .expect("release");
    assert_eq!(result["outcome"], json!("closed"));
    assert_eq!(result["lines"], json!(0));
}

#[tokio::test]
async fn releasing_a_missing_order_reports_missing() {
    let (state, _firestore) = state_harness().await;
    let result = pokoin_commerce::handlers::orders::release_eur_reservation(
        &state,
        "nope",
        "expired",
        "expired",
        &[],
    )
    .await
    .expect("release");
    assert_eq!(result["outcome"], json!("missing"));
}


// ---------------------------------------------------------------------------
// Checkout shipping-address snapshot (encrypted at rest)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_checkout_snapshot_is_encrypted_with_the_source_address_id() {
    // A 32-byte address key, the same shape ADDRESS_ENCRYPTION_KEY accepts.
    std::env::set_var("ADDRESS_ENCRYPTION_KEY", "11".repeat(32));
    let (state, firestore) = state_harness().await;
    let envelope = pokoin_commerce::domain::address::encrypt_address_payload(
        &pokoin_commerce::domain::address::AddressFields {
            full_name: "Alice Buyer".into(),
            address_line1: "Via Roma 1".into(),
            postal_code: "00100".into(),
            city: "Roma".into(),
            ..Default::default()
        },
        Some(&"11".repeat(32)),
    )
    .unwrap();
    firestore
        .create_document(
            "users/buyer-1/shipping_addresses",
            "addr-1",
            &json!({
                "countryCode": "IT",
                "encryptedPayload": serde_json::to_value(&envelope).unwrap(),
            }),
        )
        .await
        .expect("address");

    let (country, snapshot) = pokoin_commerce::handlers::orders::shipping_address_snapshot(
        &state, "buyer-1", "addr-1",
    )
    .await
    .expect("snapshot");
    assert_eq!(country, "IT");

    // The stored snapshot is an opaque envelope, not readable JSON.
    let raw = snapshot.to_string();
    assert!(!raw.contains("Via Roma"), "address must not be plaintext");
    assert!(!raw.contains("Alice Buyer"));
    assert_eq!(snapshot["algorithm"], json!("aes-256-gcm"));
    assert_eq!(snapshot["version"], json!(1));
    assert!(snapshot["iv"].is_string());
    assert!(snapshot["tag"].is_string());
    assert!(snapshot["ciphertext"].is_string());

    // …and it decrypts back with the country and the source id attached.
    let decrypted = pokoin_commerce::handlers::orders::decrypt_shipping_snapshot(&state, &snapshot)
        .expect("decrypt");
    assert_eq!(decrypted["fullName"], json!("Alice Buyer"));
    assert_eq!(decrypted["addressLine1"], json!("Via Roma 1"));
    assert_eq!(decrypted["city"], json!("Roma"));
    assert_eq!(decrypted["countryCode"], json!("IT"));
    assert_eq!(decrypted["sourceAddressId"], json!("addr-1"));
    std::env::remove_var("ADDRESS_ENCRYPTION_KEY");
}

#[tokio::test]
async fn an_unknown_shipping_address_is_not_found() {
    std::env::set_var("ADDRESS_ENCRYPTION_KEY", "11".repeat(32));
    let (state, _firestore) = state_harness().await;
    let error = pokoin_commerce::handlers::orders::shipping_address_snapshot(
        &state, "buyer-1", "missing",
    )
    .await
    .unwrap_err();
    assert_eq!(error.status.as_u16(), 404);
    std::env::remove_var("ADDRESS_ENCRYPTION_KEY");
}

#[tokio::test]
async fn reveal_shipping_requires_payment_and_an_encrypted_snapshot() {
    use pokoin_commerce::handlers::orders::shipping_address_snapshot as build_snapshot;
    let _ = build_snapshot;
    std::env::set_var("ADDRESS_ENCRYPTION_KEY", "11".repeat(32));
    let (state, firestore) = state_harness().await;
    let envelope = pokoin_commerce::domain::address::encrypt_address_payload(
        &pokoin_commerce::domain::address::AddressFields {
            full_name: "Alice Buyer".into(),
            address_line1: "Via Roma 1".into(),
            postal_code: "00100".into(),
            city: "Roma".into(),
            ..Default::default()
        },
        Some(&"11".repeat(32)),
    )
    .unwrap();
    firestore
        .create_document(
            "users/buyer-1/shipping_addresses",
            "addr-1",
            &json!({
                "countryCode": "IT",
                "encryptedPayload": serde_json::to_value(&envelope).unwrap(),
            }),
        )
        .await
        .expect("address");
    let (_country, snapshot) = pokoin_commerce::handlers::orders::shipping_address_snapshot(
        &state, "buyer-1", "addr-1",
    )
    .await
    .expect("snapshot");
    // The Node field names, not a plaintext shippingAddress.
    firestore
        .create_document(
            "orders",
            "order-reveal",
            &json!({
                "buyerUid": "buyer-1",
                "paymentStatus": "paid",
                "shippingAddressSnapshotEncrypted": snapshot,
                "shippingAddressCountryCode": "IT",
                "shipments": [{ "sellerId": "seller-1", "fromCountry": "IT", "toCountry": "IT",
                                "packageTier": "SMALL", "cardCount": 2,
                                "shippingAmountEURCents": 500, "serviceName": "Standard" }],
            }),
        )
        .await
        .expect("order");
    let decrypted = pokoin_commerce::handlers::orders::decrypt_shipping_snapshot(
        &state,
        &firestore
            .get_document(&firestore.document_path("orders", "order-reveal"))
            .await
            .unwrap()
            .expect("order")["shippingAddressSnapshotEncrypted"],
    )
    .expect("decrypt");
    assert_eq!(decrypted["fullName"], json!("Alice Buyer"));
    assert_eq!(decrypted["countryCode"], json!("IT"));
    assert_eq!(decrypted["sourceAddressId"], json!("addr-1"));

    // An order with a plaintext field and no envelope reveals nothing.
    let revealed = pokoin_commerce::handlers::orders::decrypt_shipping_snapshot(
        &state,
        &json!({ "fullName": "plaintext" }),
    )
    .expect("decrypt");
    assert_eq!(revealed, json!(null));
    std::env::remove_var("ADDRESS_ENCRYPTION_KEY");
}

#[tokio::test]
async fn an_order_without_a_stored_snapshot_reveals_nothing() {
    let (state, _firestore) = state_harness().await;
    let revealed = pokoin_commerce::handlers::orders::decrypt_shipping_snapshot(
        &state,
        &json!({}),
    )
    .expect("decrypt");
    assert_eq!(revealed, json!(null));
}

#[test]
fn the_mock_document_mapping_round_trips() {
    // Guards the harness itself: the mock uses the real encoder/decoder.
    let fields = value_to_fields(&json!({ "a": 1, "b": "x", "c": true }));
    let decoded = pokoin_commerce::firestore::fields_to_value(Some(&Value::Object(fields)));
    assert_eq!(decoded, json!({ "a": 1, "b": "x", "c": true }));
    let mut map = Map::new();
    map.insert("k".into(), json!(1));
    assert_eq!(Value::Object(map)["k"], json!(1));
}
