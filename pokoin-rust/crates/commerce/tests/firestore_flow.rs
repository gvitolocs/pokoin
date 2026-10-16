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
    /// One commit at a time, so a create-only precondition is atomic.
    commit_lock: Arc<Mutex<()>>,
    /// Faults consumed by the next commits, in order.
    faults: Arc<Mutex<Vec<CommitFault>>>,
    /// Document keys written by each applied commit.
    commits: Arc<Mutex<Vec<Vec<String>>>>,
}

#[derive(Clone, Copy, Debug)]
enum CommitFault {
    /// Firestore contention: nothing is written, `ABORTED` is returned.
    Abort,
    /// The commit is applied but the client sees a 503.
    LoseResponse,
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
    fn fail_next_commit(&self, fault: CommitFault) {
        self.faults.lock().unwrap().push(fault);
    }
    fn keys_with_prefix(&self, prefix: &str) -> Vec<String> {
        self.documents
            .lock()
            .unwrap()
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect()
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

async fn mock_batch_get(State(state): State<MockStore>, Json(body): Json<Value>) -> Response {
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

fn set_field_path(target: &mut Value, path: &str, value: Value) {
    let mut parts = path.splitn(2, '.');
    let first = parts.next().unwrap_or("");
    if let Some(rest) = parts.next() {
        if !target[first].is_object() {
            target[first] = json!({});
        }
        set_field_path(&mut target[first], rest, value);
    } else {
        target[first] = value;
    }
}
fn get_field_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut value = value;
    for part in path.split('.') {
        value = value.get(part)?;
    }
    Some(value)
}
fn apply_mask(current: &mut Value, patch: &Value, mask: &[String]) {
    for path in mask {
        if let Some(value) = get_field_path(patch, path) {
            set_field_path(current, path, value.clone());
        }
    }
}

async fn mock_commit(State(state): State<MockStore>, Json(body): Json<Value>) -> Response {
    let _commit = state.commit_lock.lock().unwrap();
    let writes = body
        .get("writes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let fault = {
        let mut faults = state.faults.lock().unwrap();
        (!faults.is_empty()).then(|| faults.remove(0))
    };
    if matches!(fault, Some(CommitFault::Abort)) {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": { "status": "ABORTED" } })),
        )
            .into_response();
    }
    // Preconditions are checked before any write: a commit is all or nothing.
    for write in &writes {
        if write.pointer("/currentDocument/exists") == Some(&json!(false)) {
            let path = write
                .pointer("/update/name")
                .and_then(Value::as_str)
                .map(strip_prefix)
                .unwrap_or_default();
            if state.get(&path).is_some() {
                return (
                    StatusCode::CONFLICT,
                    Json(json!({ "error": { "status": "ALREADY_EXISTS" } })),
                )
                    .into_response();
            }
        }
    }
    let written: Vec<String> = writes
        .iter()
        .filter_map(|write| {
            write
                .pointer("/update/name")
                .or_else(|| write.get("delete"))
                .and_then(Value::as_str)
                .map(strip_prefix)
        })
        .collect();
    state.commits.lock().unwrap().push(written);
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
                    let name = field
                        .get("fieldPath")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
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
                        let existing = current.get(name).and_then(Value::as_i64).unwrap_or(0);
                        if let Some(object) = current.as_object_mut() {
                            object.insert(name.to_string(), json!(existing + amount));
                        }
                    }
                }
            }
            state.upsert(&path, current, true);
            continue;
        }
        let Some(update) = write.get("update") else {
            continue;
        };
        let path = update
            .get("name")
            .and_then(Value::as_str)
            .map(strip_prefix)
            .unwrap_or_default();
        let fields = update.get("fields").cloned().unwrap_or_else(|| json!({}));
        let decoded = pokoin_commerce::firestore::fields_to_value(Some(&fields));
        if let Some(mask) = write
            .pointer("/updateMask/fieldPaths")
            .and_then(Value::as_array)
        {
            let mask = mask
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>();
            let mut current = state.get(&path).unwrap_or(json!({}));
            apply_mask(&mut current, &decoded, &mask);
            state.upsert(&path, current, false);
        } else {
            state.upsert(&path, decoded, false);
        }
    }
    if matches!(fault, Some(CommitFault::LoseResponse)) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": { "status": "UNAVAILABLE" } })),
        )
            .into_response();
    }
    Json(json!({ "writeResults": [] })).into_response()
}

async fn mock_patch(
    State(state): State<MockStore>,
    Path(path): Path<String>,
    axum::extract::RawQuery(raw): axum::extract::RawQuery,
    Json(body): Json<Value>,
) -> Response {
    let key = path.clone();
    // Repeated `updateMask.fieldPaths` keys must all survive (a HashMap keeps one).
    let pairs: Vec<(String, String)> = raw
        .as_deref()
        .unwrap_or("")
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (name, value) = part.split_once('=').unwrap_or((part, ""));
            let decode = |text: &str| {
                urlencoding::decode(&text.replace('+', " "))
                    .map(|v| v.into_owned())
                    .unwrap_or_else(|_| text.to_string())
            };
            (decode(name), decode(value))
        })
        .collect();
    let query: HashMap<String, String> = pairs.iter().cloned().collect();
    if query.get("currentDocument.exists").map(String::as_str) == Some("true")
        && state.get(&key).is_none()
    {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": { "status": "NOT_FOUND" } })),
        )
            .into_response();
    }
    let merge = query.keys().any(|name| name.starts_with("updateMask."));
    let fields = body.get("fields").cloned().unwrap_or_else(|| json!({}));
    let decoded = pokoin_commerce::firestore::fields_to_value(Some(&fields));
    if merge {
        let mask = pairs
            .iter()
            .filter(|(name, _)| name.starts_with("updateMask."))
            .map(|(_, value)| value.clone())
            .collect::<Vec<_>>();
        let mut current = state.get(&key).unwrap_or(json!({}));
        apply_mask(&mut current, &decoded, &mask);
        state.upsert(&key, current, false);
    } else {
        state.upsert(&key, decoded, false);
    }
    let value = state.get(&key).unwrap_or_else(|| json!({}));
    Json(document_resource(&key, &value, "https://mock")).into_response()
}

async fn mock_get_document(State(state): State<MockStore>, Path(path): Path<String>) -> Response {
    match state.get(&path) {
        Some(value) => Json(document_resource(&path, &value, "https://mock")).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": { "status": "NOT_FOUND" } })),
        )
            .into_response(),
    }
}

async fn mock_delete(State(state): State<MockStore>, Path(path): Path<String>) -> Response {
    state.delete(&path);
    Json(json!({})).into_response()
}

async fn mock_create(
    State(state): State<MockStore>,
    Path(collection): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<Value>,
) -> Response {
    let id = query
        .get("documentId")
        .cloned()
        .unwrap_or_else(|| "auto".into());
    let path = format!("{collection}/{id}");
    if state.get(&path).is_some() {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": { "status": "ALREADY_EXISTS" } })),
        )
            .into_response();
    }
    let fields = body.get("fields").cloned().unwrap_or_else(|| json!({}));
    let decoded = pokoin_commerce::firestore::fields_to_value(Some(&fields));
    state.upsert(&path, decoded, false);
    Json(document_resource(
        &path,
        &state.get(&path).unwrap_or(json!({})),
        "https://mock",
    ))
    .into_response()
}

async fn mock_run_query(State(state): State<MockStore>, Json(body): Json<Value>) -> Response {
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
        .route(
            "/v1/projects/pokoin-test/databases/(default)/documents/{*path}",
            get(mock_get_document),
        )
        .route(
            "/v1/projects/pokoin-test/databases/(default)/documents/{*path}",
            patch(mock_patch),
        )
        .route(
            "/v1/projects/pokoin-test/databases/(default)/documents/{*path}",
            axum::routing::delete(mock_delete),
        )
        .route(
            "/v1/projects/pokoin-test/databases/(default)/documents/{*path}",
            post(mock_create),
        )
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
            custom: Default::default(),
        })
    }
}

async fn state_harness() -> (DomainState, FirestoreClient) {
    state_harness_with(|_| {}).await
}

/// A 32-byte address key, the same shape ADDRESS_ENCRYPTION_KEY accepts.
fn test_address_key() -> String {
    "11".repeat(32)
}

/// The harness with the address key in its config. Tests never set the
/// process env: `CommerceConfig::default()` reads it, so a parallel test's
/// `remove_var` raced another test's harness ("ADDRESS_ENCRYPTION_KEY is
/// not configured").
async fn address_state_harness() -> (DomainState, FirestoreClient) {
    state_harness_with(|config| config.address_encryption_key = Some(test_address_key())).await
}

async fn state_harness_with(
    configure: impl FnOnce(&mut CommerceConfig),
) -> (DomainState, FirestoreClient) {
    let (state, firestore, _store) = state_harness_with_store(configure).await;
    (state, firestore)
}

async fn state_harness_with_store(
    configure: impl FnOnce(&mut CommerceConfig),
) -> (DomainState, FirestoreClient, MockStore) {
    let (base, store) = start_mock_firestore().await;
    let http = reqwest::Client::new();
    let firestore = FirestoreClient::with_static_token(http, "pokoin-test", base, "test-token");
    let mut config = CommerceConfig::default();
    config.pokoin_treasury_username = "pokoin".into();
    configure(&mut config);
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
    (state, firestore, store)
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
        .body(
            body.map(|value| Body::from(value.to_string()))
                .unwrap_or_else(Body::empty),
        )
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("router");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let payload = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).to_string()))
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
        store::balance(&firestore, "buyer-1")
            .await
            .unwrap()
            .available_pkn,
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
        store::balance(&firestore, "seller-1")
            .await
            .unwrap()
            .available_pkn,
        250
    );

    // The ledger kept both signed entries with the Node field names.
    let entries = firestore
        .run_query(&store::StructuredQuery::collection(store::LEDGER_ENTRIES).limit(50))
        .await
        .expect("ledger query");
    let types: Vec<String> = entries
        .iter()
        .filter_map(|row| {
            row.get("type")
                .and_then(Value::as_str)
                .map(|v| v.to_string())
        })
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
        store::balance(&firestore, "buyer-1")
            .await
            .unwrap()
            .available_pkn,
        750
    );
    assert_eq!(
        store::balance(&firestore, "seller-1")
            .await
            .unwrap()
            .available_pkn,
        250
    );
}

#[tokio::test]
async fn lock_then_unlock_burn_models_a_withdrawal() {
    let (_, firestore) = harness().await;
    store::apply(&firestore, &LedgerOp::mint("u1", 500, "account_top_up"))
        .await
        .unwrap();

    store::apply(
        &firestore,
        &LedgerOp::lock("u1", 200, "withdraw_requested").with_ref("wr-1"),
    )
    .await
    .expect("lock");
    let balance = store::balance(&firestore, "u1").await.unwrap();
    assert_eq!(balance.available_pkn, 300);
    assert_eq!(balance.locked_pkn, 200);

    store::apply(
        &firestore,
        &LedgerOp::unlock("u1", 200, "withdraw_paid", false).with_ref("wr-1"),
    )
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
    assert_eq!(
        store::balance(&firestore, "u1")
            .await
            .unwrap()
            .available_pkn,
        100
    );
    assert_eq!(
        store::balance(&firestore, "u2")
            .await
            .unwrap()
            .available_pkn,
        0
    );
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
    store::apply(
        &firestore,
        &LedgerOp::mint("bob-1", 1_000, "account_top_up"),
    )
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
    let request_id = created["requestId"]
        .as_str()
        .expect("requestId")
        .to_string();

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
    assert_eq!(
        store::balance(&firestore, "bob-1")
            .await
            .unwrap()
            .available_pkn,
        750
    );
    assert_eq!(
        store::balance(&firestore, "buyer-1")
            .await
            .unwrap()
            .available_pkn,
        250
    );

    // A second pay attempt with the same request id is a no-op.
    let replay = store::apply(&firestore, &op).await.expect("replay");
    assert!(!replay.applied);
    assert_eq!(
        store::balance(&firestore, "bob-1")
            .await
            .unwrap()
            .available_pkn,
        750
    );

    // The create path queued exactly one notification for the payee.
    let notifications = firestore
        .run_query(
            &store::StructuredQuery::collection(store::NOTIFICATIONS)
                .where_eq("uid", json!("bob-1")),
        )
        .await
        .expect("notifications");
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0]["type"], json!("money_request_created"));
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
    assert!(
        sales[0].get("orderId").is_none(),
        "order id must never leak"
    );
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
                "inventory": { "state": "reserved", "lines": [{
                    "listingId": "l1", "cardId": "693360", "sellerUid": "seller-1",
                    "quantity": 2, "sourceListingId": "ct:7", "remainingQuantity": 0
                }] },
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
        .get_document(&firestore.document_path("orders", "order-eur-1").unwrap())
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
    use pokoin_commerce::handlers::orders::{decrement_seller_ownership_for_sale, OwnershipLine};
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
        ..Default::default()
    };
    let result = decrement_seller_ownership_for_sale(&state, &line)
        .await
        .expect("decrement");
    assert_eq!(result["deleted"], json!(false));
    assert_eq!(result["before"], json!(3));
    assert_eq!(result["after"], json!(2));
    let row = firestore
        .get_document(&firestore.document_path("user_card_collections", "row-1").unwrap())
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
        .get_document(&firestore.document_path("user_card_collections", "row-1").unwrap())
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
async fn a_sale_key_decrements_the_ownership_row_once() {
    // specs/tla/eur-fulfilment bugs/ownership-twice.cfg: a fulfilment that
    // died after the decrement but before ownershipDone, retried.
    use pokoin_commerce::handlers::orders::{decrement_seller_ownership_for_sale, OwnershipLine};
    let (state, firestore) = state_harness().await;
    firestore
        .create_document(
            "user_card_collections",
            "row-k",
            &json!({"uid": "seller-1", "listingId": "l1", "quantity": 3, "ownershipType": "physical"}),
        )
        .await
        .expect("row");
    let line = OwnershipLine {
        listing_id: "l1".into(),
        seller_uid: "seller-1".into(),
        quantity: 1,
        sale_key: "order-1:l1".into(),
        ..Default::default()
    };
    let first = decrement_seller_ownership_for_sale(&state, &line).await.expect("first");
    assert_eq!(first["after"], json!(2));
    let replay = decrement_seller_ownership_for_sale(&state, &line).await.expect("replay");
    assert_eq!(replay["reason"], json!("already_decremented"));
    let other = OwnershipLine { sale_key: "order-2:l1".into(), ..line.clone() };
    let second = decrement_seller_ownership_for_sale(&state, &other).await.expect("second sale");
    assert_eq!(second["after"], json!(1));
    let row = firestore
        .get_document(&firestore.document_path("user_card_collections", "row-k").unwrap())
        .await
        .unwrap()
        .expect("row");
    assert_eq!(row["quantity"], json!(1));
    assert_eq!(row["saleKeys"], json!(["order-1:l1", "order-2:l1"]));
}

#[tokio::test]
async fn nft_ownership_rows_are_never_decremented() {
    use pokoin_commerce::handlers::orders::{decrement_seller_ownership_for_sale, OwnershipLine};
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
            ..Default::default()
        },
    )
    .await
    .expect("decrement");
    assert_eq!(result["skipped"], json!(true));
    assert_eq!(
        firestore
            .get_document(&firestore.document_path("user_card_collections", "nft-row").unwrap())
            .await
            .unwrap()
            .expect("still there")["quantity"],
        json!(1)
    );
}

#[tokio::test]
async fn a_scan_source_row_is_decremented_by_its_full_document_id() {
    use pokoin_commerce::handlers::orders::{decrement_seller_ownership_for_sale, OwnershipLine};
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
            ..Default::default()
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
        .get_document(&firestore.document_path("users", "buyer-1").unwrap())
        .await
        .unwrap()
        .expect("user");
    assert_eq!(user["shipFromCountry"], json!("IT"));
    assert!(user.get("stripeConnectAccountId").is_none());
}

#[tokio::test]
async fn the_checkout_quote_prices_each_seller_parcel_with_its_own_service() {
    use pokoin_commerce::domain::shipping::{find_rate, package_tier_for_count_default, RateCatalog};
    let (app, firestore) = harness().await;
    for (uid, country) in [("red", "IT"), ("givi", "DK")] {
        firestore
            .create_document(
                "users",
                uid,
                &json!({ "username": uid, "shipFromCountry": country }),
            )
            .await
            .expect("seller");
    }
    let items = json!([
        { "listingId": "l1", "sellerUid": "red", "quantity": 1, "unitPricePkn": 200 },
        { "listingId": "l2", "sellerUid": "givi", "quantity": 2, "unitPricePkn": 400 },
    ]);
    let price = |from: &str, cards: i64, tracked: bool| {
        let tier = package_tier_for_count_default(cards).unwrap();
        let rate = find_rate(from, "DK", &tier, tracked, RateCatalog::default_catalog()).unwrap();
        (rate.price_eur_cents as i64, rate.is_tracked())
    };

    let (status, quote) = call(
        &app,
        "POST",
        "/api/marketplace-checkout-quote",
        Some(json!({
            "items": items,
            "toCountry": "DK",
            "tracked": true,
            "shippingServices": { "red": "untracked", "givi": "tracked" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{quote}");
    let (red_cents, red_tracked) = price("IT", 1, false);
    let (givi_cents, givi_tracked) = price("DK", 2, true);
    let shipments = quote["shipments"].as_array().expect("shipments");
    assert_eq!(shipments.len(), 2);
    assert_eq!(shipments[0]["sellerId"], json!("red"));
    assert_eq!(shipments[0]["fromCountry"], json!("IT"));
    assert_eq!(shipments[0]["amountCents"], json!(red_cents));
    assert_eq!(shipments[0]["tracked"], json!(red_tracked));
    assert_eq!(shipments[1]["sellerId"], json!("givi"));
    assert_eq!(shipments[1]["amountCents"], json!(givi_cents));
    assert_eq!(
        shipments[1]["serviceId"],
        json!(if givi_tracked { "tracked" } else { "untracked" })
    );
    assert_eq!(quote["shippingTotalCents"], json!(red_cents + givi_cents));
    // 1000 PKN of cards = 500 cents.
    assert_eq!(quote["grandTotalCents"], json!(500 + red_cents + givi_cents));
    assert_eq!(quote["tracked"], json!(false));
    assert_eq!(quote["shippingServices"]["givi"], shipments[1]["serviceId"]);

    // The single order-wide flag still prices every parcel alike.
    let (status, legacy) = call(
        &app,
        "POST",
        "/api/marketplace-checkout-quote",
        Some(json!({ "items": items, "toCountry": "DK", "shippingService": "tracked" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{legacy}");
    assert_eq!(
        legacy["shippingTotalCents"],
        json!(price("IT", 1, true).0 + price("DK", 2, true).0)
    );

    // A Packlink parcel cannot be booked: refused, never re-priced as a letter.
    let (status, refused) = call(
        &app,
        "POST",
        "/api/marketplace-checkout-quote",
        Some(json!({
            "items": items,
            "toCountry": "DK",
            "shippingServices": { "red": "packlink:22131" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(refused["code"], json!("shipping_service_unavailable"));
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
    let error =
        pokoin_commerce::handlers::orders::release_seller_transfers(&state, "order-connect")
            .await
            .unwrap_err();
    // Reached Stripe and failed there (no key): the READY account was resolved
    // from the Firestore user document.
    assert!(
        error.message.to_lowercase().contains("stripe"),
        "{}",
        error.message
    );
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

    let first = pokoin_commerce::handlers::orders::send_seller_sale_notifications_for_paid_order(
        &state,
        "order-notify",
    )
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
        ).unwrap())
        .await
        .unwrap()
        .expect("marker");
    assert_eq!(marker1["status"], json!("skipped"));
    assert_eq!(marker1["sellerEmail"], json!("seller1@example.com"));
    assert_eq!(marker1["quantity"], json!(2));
    assert_eq!(marker1["totalPkn"], json!(200.0));
    assert_eq!(marker1["itemCount"], json!(1));

    let markers = firestore
        .run_query(&store::StructuredQuery::collection(notify::NOTIFICATION_COLLECTION).limit(10))
        .await
        .expect("markers");
    assert_eq!(markers.len(), 2);

    // A second call must not re-claim or re-send.
    let second = pokoin_commerce::handlers::orders::send_seller_sale_notifications_for_paid_order(
        &state,
        "order-notify",
    )
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
    let outcome = pokoin_commerce::handlers::orders::send_seller_sale_notifications_for_paid_order(
        &state,
        "order-unpaid",
    )
    .await
    .expect("notify");
    assert_eq!(outcome["skipped"], json!(true));
    assert_eq!(outcome["reason"], json!("Order is not paid."));
    let markers = firestore
        .run_query(&store::StructuredQuery::collection("order_seller_sale_notifications").limit(10))
        .await
        .expect("markers");
    assert!(
        markers.is_empty(),
        "an unpaid order must not claim a marker"
    );
}

#[tokio::test]
async fn wallet_addresses_registry_is_read_from_firestore_document_ids() {
    // The registry keys documents BY the 0x address, so the doc id is the
    // address — this is the only source of top-up ownership.
    let (state, firestore) = state_harness().await;
    for (id, extra) in [
        (
            "0x1111111111111111111111111111111111111111",
            json!({ "uid": "buyer-1" }),
        ),
        (
            "0x2222222222222222222222222222222222222222",
            json!({ "uid": "buyer-1" }),
        ),
    ] {
        let mut document = extra;
        document["uid"] = json!("buyer-1");
        firestore
            .create_document("wallet_addresses", id, &document)
            .await
            .unwrap();
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
        .create_document(
            "wallet_addresses",
            "not-an-address",
            &json!({ "uid": "buyer-1" }),
        )
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
                // Checkout reserved the stock; fulfilment commits it.
                "inventory": {
                    "state": "reserved",
                    "lines": [{
                        "listingId": "l1", "cardId": "693360", "sellerUid": "seller-1",
                        "quantity": 2,
                    }],
                },
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
    let (state, firestore, port) = paid_eur_order_with_port(CardTraderOutcome::Applied {
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
        .get_document(&firestore.document_path("orders", "order-ct").unwrap())
        .await
        .unwrap()
        .expect("order");
    assert_eq!(
        order["fulfillment"]["steps"]["cardtrader_sync"],
        json!("done")
    );
    assert_eq!(
        order["fulfillment"]["steps"]["cardtrader_buy"],
        json!("done")
    );
    assert_eq!(
        order["fulfillment"]["steps"]["seller_ownership"],
        json!("done")
    );
    assert_eq!(
        order["fulfillment"]["steps"]["notifications"],
        json!("done")
    );
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
        .get_document(&firestore.document_path("user_card_collections", "row-ct").unwrap())
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn an_unconfigured_cardtrader_leaves_the_steps_open() {
    use pokoin_commerce::cardtrader::CardTraderOutcome;
    let (state, firestore, port) = paid_eur_order_with_port(CardTraderOutcome::NotConfigured {
        reason: "seller has no token".into(),
    })
    .await;

    let result = pokoin_commerce::handlers::orders::fulfil_paid_eur_order(&state, "order-ct")
        .await
        .expect("fulfil");
    // Nothing is claimed done: the CardTrader steps stay open.
    assert_eq!(
        result["done"],
        json!(false),
        "unconfigured work remains pending: {result}"
    );
    assert!(!port.calls().is_empty());

    let order = firestore
        .get_document(&firestore.document_path("orders", "order-ct").unwrap())
        .await
        .unwrap()
        .expect("order");
    assert_ne!(
        order["fulfillment"]["steps"]["cardtrader_sync"],
        json!("done")
    );
    assert_ne!(
        order["fulfillment"]["steps"]["cardtrader_buy"],
        json!("done")
    );
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
        paid_eur_order_with_port(CardTraderOutcome::Applied { detail: json!({}) }).await;
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
    store::apply(
        &firestore,
        &LedgerOp::mint("buyer-1", 500, "account_top_up"),
    )
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
        .get_document(&firestore.document_path("orders", "order-release").unwrap())
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
    .await;
    match second {
        Ok(second) => {
            assert_eq!(second["lines"], json!(0));
        }
        Err(error) => assert_eq!(error.code.as_deref(), Some("order_stock_restore_failed")),
    }
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
        .get_document(&firestore.document_path("orders", "order-release").unwrap())
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
        .get_document(&firestore.document_path("orders", "order-release").unwrap())
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
    let (state, firestore) = address_state_harness().await;
    let envelope = pokoin_commerce::domain::address::encrypt_address_payload(
        &pokoin_commerce::domain::address::AddressFields {
            full_name: "Alice Buyer".into(),
            address_line1: "Via Roma 1".into(),
            postal_code: "00100".into(),
            city: "Roma".into(),
            ..Default::default()
        },
        Some(&test_address_key()),
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

    let (country, snapshot) =
        pokoin_commerce::handlers::orders::shipping_address_snapshot(&state, "buyer-1", "addr-1")
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
}

#[tokio::test]
async fn an_unknown_shipping_address_is_not_found() {
    let (state, _firestore) = address_state_harness().await;
    let error =
        pokoin_commerce::handlers::orders::shipping_address_snapshot(&state, "buyer-1", "missing")
            .await
            .unwrap_err();
    assert_eq!(error.status.as_u16(), 404);
}

#[tokio::test]
async fn reveal_shipping_requires_payment_and_an_encrypted_snapshot() {
    use pokoin_commerce::handlers::orders::shipping_address_snapshot as build_snapshot;
    let _ = build_snapshot;
    let (state, firestore) = address_state_harness().await;
    let envelope = pokoin_commerce::domain::address::encrypt_address_payload(
        &pokoin_commerce::domain::address::AddressFields {
            full_name: "Alice Buyer".into(),
            address_line1: "Via Roma 1".into(),
            postal_code: "00100".into(),
            city: "Roma".into(),
            ..Default::default()
        },
        Some(&test_address_key()),
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
    let (_country, snapshot) =
        pokoin_commerce::handlers::orders::shipping_address_snapshot(&state, "buyer-1", "addr-1")
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
            .get_document(&firestore.document_path("orders", "order-reveal").unwrap())
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
}

#[tokio::test]
async fn an_order_without_a_stored_snapshot_reveals_nothing() {
    let (state, _firestore) = state_harness().await;
    let revealed = pokoin_commerce::handlers::orders::decrypt_shipping_snapshot(&state, &json!({}))
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

#[tokio::test]
async fn paid_order_without_reserved_stock_flags_conflict_without_faking_fulfilment() {
    use pokoin_commerce::cardtrader::CardTraderOutcome;
    let (state, firestore, port) =
        paid_eur_order_with_port(CardTraderOutcome::Applied { detail: json!({}) }).await;
    firestore
        .set_document(
            &firestore.document_path("orders", "order-ct").unwrap(),
            &json!({"inventory":{"state":"released"}}),
        )
        .await
        .unwrap();
    let result = pokoin_commerce::handlers::orders::fulfil_paid_eur_order(&state, "order-ct")
        .await
        .unwrap();
    assert_eq!(result["conflict"], true);
    assert!(port.calls().is_empty());
    let order = firestore
        .get_document(&firestore.document_path("orders", "order-ct").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(order["fulfillmentStatus"], "needs_refund");
    assert_eq!(order["inventory"]["state"], "conflict");
    assert_eq!(order["buyerUid"], "buyer-1");
    assert_eq!(order["items"][0]["listingId"], "l1");
    let retry = pokoin_commerce::handlers::orders::fulfil_paid_eur_order(&state, "order-ct")
        .await
        .unwrap();
    assert_eq!(retry["skipped"], "done");
    assert!(port.calls().is_empty());
}
#[tokio::test]
async fn unconfigured_cardtrader_result_retries_and_never_becomes_done() {
    use pokoin_commerce::cardtrader::CardTraderOutcome;
    let (state, firestore, port) = paid_eur_order_with_port(CardTraderOutcome::NotConfigured {
        reason: "missing token".into(),
    })
    .await;
    let first = pokoin_commerce::handlers::orders::fulfil_paid_eur_order(&state, "order-ct")
        .await
        .unwrap();
    assert_eq!(first["done"], false);
    let calls = port.calls().len();
    let second = pokoin_commerce::handlers::orders::fulfil_paid_eur_order(&state, "order-ct")
        .await
        .unwrap();
    assert_eq!(second["done"], false);
    assert!(port.calls().len() > calls);
    let order = firestore
        .get_document(&firestore.document_path("orders", "order-ct").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(order["fulfillment"]["state"], "partial");
    assert_eq!(order["fulfillment"]["ownershipDone"], json!(["l1"]));
}

// ---------------------------------------------------------------------------
// Money-safety regressions (2026-10-15 audit)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn address_ids_that_walk_out_of_the_users_addresses_are_400_and_touch_nothing() {
    let (state, firestore, _store) = state_harness_with_store(|_| {}).await;
    let app = pokoin_commerce::router(state);
    store::apply(&firestore, &LedgerOp::mint("buyer-1", 1_000, "account_top_up"))
        .await
        .unwrap();

    for uri in [
        "/api/account-addresses?id=../../../balances/buyer-1",
        "/api/account-addresses?id=%2e%2e%2f%2e%2e%2f%2e%2e%2fbalances%2fbuyer-1",
        "/api/account-addresses?id=%252e%252e%252fbalances",
        "/api/account-addresses?id=a/b",
        "/api/account-addresses?id=..",
    ] {
        let (status, body) = call(&app, "DELETE", uri, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: {body}");
    }
    let (status, _) = call(
        &app,
        "DELETE",
        "/api/account-addresses",
        Some(json!({ "id": "../../../balances/buyer-1" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &app,
        "PUT",
        "/api/account-addresses?id=../../../balances/buyer-1",
        Some(json!({ "countryCode": "IT" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &app,
        "POST",
        "/api/marketplace-checkout-quote",
        Some(json!({ "items": [{ "listingId": "x" }], "shippingAddressId": "../../../balances/buyer-1" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The balance document is untouched, and a well-formed id still reaches
    // Firestore (the mock answers a delete of a missing document with 200).
    assert_eq!(
        store::balance(&firestore, "buyer-1").await.unwrap().available_pkn,
        1_000
    );
    let (status, _) = call(
        &app,
        "DELETE",
        "/api/account-addresses?id=0b0e7a3e-1c2d-4f5a-9b8c-7d6e5f4a3b2c",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn racing_replays_of_one_key_move_money_once() {
    let (_, firestore, mock) = state_harness_with_store(|_| {}).await;
    store::apply(&firestore, &LedgerOp::mint("u1", 1_000, "account_top_up"))
        .await
        .unwrap();
    let op = LedgerOp::transfer("u1", "u2", 100, "account_transfer_sent").with_idempotency("race:1");
    let outcomes = futures_util::future::join_all(
        (0..8).map(|_| store::apply(&firestore, &op)),
    )
    .await;
    let applied = outcomes
        .iter()
        .filter(|outcome| outcome.as_ref().expect("apply").applied)
        .count();
    assert_eq!(applied, 1);
    assert_eq!(store::balance(&firestore, "u1").await.unwrap().available_pkn, 900);
    assert_eq!(store::balance(&firestore, "u2").await.unwrap().available_pkn, 100);
    // mint (1 entry) + one transfer (2 entries)
    assert_eq!(mock.keys_with_prefix("ledger_entries/").len(), 3);
    // Every replay reports the committed balances.
    for outcome in outcomes {
        assert_eq!(outcome.unwrap().from_available, 900);
    }
}

#[tokio::test]
async fn the_idempotency_marker_commits_with_the_balances() {
    let (_, firestore, mock) = state_harness_with_store(|_| {}).await;
    let op = LedgerOp::mint("u1", 50, "account_top_up").with_idempotency("marker:1");
    assert!(store::apply(&firestore, &op).await.unwrap().applied);
    let marker = format!("commerce_idempotency/{}", store::idempotency_doc_id("marker:1"));
    let commits = mock.commits.lock().unwrap().clone();
    assert_eq!(commits.len(), 1);
    assert!(commits[0].contains(&marker), "{commits:?}");
    assert!(commits[0].contains(&"balances/u1".to_string()));

    // A key whose marker already exists moves nothing.
    let replay = store::apply(&firestore, &op).await.unwrap();
    assert!(!replay.applied);
    assert_eq!(replay.to_available, 50);
    assert_eq!(store::balance(&firestore, "u1").await.unwrap().available_pkn, 50);
    assert_eq!(mock.commits.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_lost_commit_response_is_never_applied_twice() {
    let (_, firestore, mock) = state_harness_with_store(|_| {}).await;
    // With a key: the landed marker is ours, so the call reports applied.
    mock.fail_next_commit(CommitFault::LoseResponse);
    let op = LedgerOp::mint("u1", 70, "account_top_up").with_idempotency("lost:1");
    let outcome = store::apply(&firestore, &op).await.expect("recovered from the marker");
    assert!(outcome.applied);
    assert_eq!(outcome.to_available, 70);
    assert_eq!(store::balance(&firestore, "u1").await.unwrap().available_pkn, 70);

    // Without a key: the error surfaces, and the body is not re-run.
    mock.fail_next_commit(CommitFault::LoseResponse);
    let op = LedgerOp::mint("u2", 30, "account_top_up");
    assert!(store::apply(&firestore, &op).await.is_err());
    assert_eq!(store::balance(&firestore, "u2").await.unwrap().available_pkn, 30);
}

#[tokio::test]
async fn an_aborted_commit_is_retried_once() {
    let (_, firestore, mock) = state_harness_with_store(|_| {}).await;
    mock.fail_next_commit(CommitFault::Abort);
    let op = LedgerOp::mint("u1", 40, "account_top_up").with_idempotency("abort:1");
    assert!(store::apply(&firestore, &op).await.unwrap().applied);
    assert_eq!(store::balance(&firestore, "u1").await.unwrap().available_pkn, 40);
    assert_eq!(mock.commits.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_multi_leg_payment_is_all_or_nothing() {
    let (_, firestore, _mock) = state_harness_with_store(|_| {}).await;
    store::apply(&firestore, &LedgerOp::mint("buyer", 100, "account_top_up"))
        .await
        .unwrap();
    let legs = |amount: i64| {
        vec![
            LedgerOp::transfer("buyer", "s1", amount, "marketplace_order_sale"),
            LedgerOp::transfer("buyer", "s2", amount, "marketplace_order_sale"),
        ]
    };
    // 60 + 60 > 100: the first leg alone would fit, but nothing moves.
    let error = store::apply_all(&firestore, &legs(60), Some("pay:1")).await.unwrap_err();
    assert!(matches!(error, pokoin_commerce::error::StoreError::Insufficient));
    assert_eq!(store::balance(&firestore, "s1").await.unwrap().available_pkn, 0);
    assert_eq!(store::balance(&firestore, "buyer").await.unwrap().available_pkn, 100);

    let outcome = store::apply_all(&firestore, &legs(50), Some("pay:2")).await.unwrap();
    assert!(outcome.applied);
    assert_eq!(outcome.from_available, 0);
    assert_eq!(store::balance(&firestore, "s1").await.unwrap().available_pkn, 50);
    assert_eq!(store::balance(&firestore, "s2").await.unwrap().available_pkn, 50);
    let replay = store::apply_all(&firestore, &legs(50), Some("pay:2")).await.unwrap();
    assert!(!replay.applied);
    assert_eq!(store::balance(&firestore, "s2").await.unwrap().available_pkn, 50);
}

#[tokio::test]
async fn an_underfunded_pkn_order_is_refused_before_any_stock_is_taken() {
    // The harness has no Postgres: reaching the listing decrement would be a
    // 5xx, so a 400 proves the balance is checked first.
    let (state, firestore, _mock) = state_harness_with_store(|_| {}).await;
    firestore
        .set_document(
            &firestore.document_path("usernames", "pokoin").unwrap(),
            &json!({ "uid": "treasury-1" }),
        )
        .await
        .unwrap();
    store::apply(&firestore, &LedgerOp::mint("buyer-1", 10, "account_top_up"))
        .await
        .unwrap();
    let app = pokoin_commerce::router(state);
    let (status, body) = call(
        &app,
        "POST",
        "/api/marketplace-orders",
        Some(json!({
            "clientOrderId": "c1",
            "items": [{
                "listingId": "0b0e7a3e-1c2d-4f5a-9b8c-7d6e5f4a3b2c",
                "quantity": 1,
                "sellerUid": "seller-1",
                "unitPricePkn": 500,
            }],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(store::balance(&firestore, "buyer-1").await.unwrap().available_pkn, 10);
}

#[tokio::test]
async fn a_top_up_hash_is_claimed_before_it_mints_and_credits_one_account() {
    let (state, firestore, _mock) = state_harness_with_store(|_| {}).await;
    let hash = format!("0x{}", "ab".repeat(32));
    let top_up = |uid: &'static str, hash: String| {
        let state = state.clone();
        async move {
            pokoin_commerce::handlers::wallet::credit_verified_top_up(
                &state, uid, &hash, "0xfrom", 50.0, false,
            )
            .await
        }
    };
    assert!(top_up("u1", hash.clone()).await.unwrap());
    assert!(!top_up("u1", hash.clone()).await.unwrap());
    let error = top_up("u2", hash.clone()).await.unwrap_err();
    assert_eq!(error.status, StatusCode::CONFLICT);
    assert_eq!(store::balance(&firestore, "u1").await.unwrap().available_pkn, 50);
    assert_eq!(store::balance(&firestore, "u2").await.unwrap().available_pkn, 0);
    let deposit = firestore
        .get_document(&firestore.document_path("native_pkn_deposits", &hash).unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(deposit["status"], json!("credited"));

    // A claim interrupted before its mint is finished by the owner's retry…
    let interrupted = format!("0x{}", "cd".repeat(32));
    firestore
        .set_document(
            &firestore.document_path("native_pkn_deposits", &interrupted).unwrap(),
            &json!({ "uid": "u3", "purpose": "account_top_up", "status": "claiming" }),
        )
        .await
        .unwrap();
    assert!(top_up("u3", interrupted.clone()).await.unwrap());
    assert_eq!(store::balance(&firestore, "u3").await.unwrap().available_pkn, 50);
    // …but a legacy (or crypto-sale) deposit for the same account never mints.
    let legacy = format!("0x{}", "ef".repeat(32));
    firestore
        .set_document(
            &firestore.document_path("native_pkn_deposits", &legacy).unwrap(),
            &json!({ "uid": "u4", "purpose": "crypto_pkn_sale" }),
        )
        .await
        .unwrap();
    assert!(!top_up("u4", legacy).await.unwrap());
    assert_eq!(store::balance(&firestore, "u4").await.unwrap().available_pkn, 0);
}

#[tokio::test]
async fn a_failed_stripe_event_releases_its_claim_so_the_retry_runs() {
    use pokoin_commerce::handlers::stripe::process_verified_event;
    let (state, firestore, _mock) = state_harness_with_store(|_| {}).await;
    let claim_path = firestore
        .document_path(
            "commerce_idempotency",
            &store::idempotency_doc_id("stripe_event:evt_1"),
        )
        .unwrap();
    let event = |pkn: &str| {
        json!({
            "id": "evt_1",
            "type": "checkout.session.completed",
            "data": { "object": {
                "id": "cs_test_1",
                "metadata": { "uid": "buyer-1", "pknAmount": pkn, "fiatCents": "500" },
            } },
        })
    };
    // The handler fails (bad metadata): the claim is gone, nothing minted.
    assert!(process_verified_event(&state, &event("0")).await.is_err());
    assert!(firestore.get_document(&claim_path).await.unwrap().is_none());

    // Stripe's retry runs the handler and marks the claim done.
    assert!(process_verified_event(&state, &event("1000")).await.is_ok());
    assert_eq!(store::balance(&firestore, "buyer-1").await.unwrap().available_pkn, 1_000);
    let claim = firestore.get_document(&claim_path).await.unwrap().unwrap();
    assert_eq!(claim["done"], json!(true));

    // A later duplicate is acknowledged and mints nothing.
    let response = process_verified_event(&state, &event("1000")).await.unwrap();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["duplicate"], json!(true));
    assert_eq!(store::balance(&firestore, "buyer-1").await.unwrap().available_pkn, 1_000);
}

#[tokio::test]
async fn an_abandoned_stripe_claim_is_handled_again() {
    use pokoin_commerce::handlers::stripe::process_verified_event;
    let (state, firestore, _mock) = state_harness_with_store(|_| {}).await;
    let key = "stripe_event:evt_2";
    // A worker claimed the event 20 minutes ago and died before handling it.
    firestore
        .set_document(
            &firestore
                .document_path("commerce_idempotency", &store::idempotency_doc_id(key))
                .unwrap(),
            &json!({
                "key": key,
                "createdAt": (chrono::Utc::now() - chrono::Duration::minutes(20))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            }),
        )
        .await
        .unwrap();
    let event = json!({
        "id": "evt_2",
        "type": "checkout.session.completed",
        "data": { "object": {
            "id": "cs_test_2",
            "metadata": { "uid": "buyer-2", "pknAmount": "500", "fiatCents": "500" },
        } },
    });
    assert!(process_verified_event(&state, &event).await.is_ok());
    assert_eq!(store::balance(&firestore, "buyer-2").await.unwrap().available_pkn, 500);
}

#[tokio::test]
async fn confirming_a_channel_only_eur_order_releases_seller_transfers() {
    // EUR orders the Rust checkout wrote before 2026-10-15 carry only
    // `channel: "eur"`; they must still settle through Stripe Transfers.
    let (state, firestore) = state_harness().await;
    firestore
        .create_document(
            "orders",
            "order-eur-channel",
            &json!({
                "buyerUid": "buyer-1",
                "channel": "eur",
                "paymentStatus": "paid",
                "fulfillmentMode": "physical",
                "shipments": [{ "sellerId": "seller-1", "sellerTransferCents": 1420 }],
                "items": [{ "listingId": "l1", "sellerUid": "seller-1", "quantity": 1,
                            "unitPricePkn": 100, "cardId": "1" }],
                "createdAt": "2026-10-08T10:00:00.000Z",
            }),
        )
        .await
        .expect("order");
    firestore
        .create_document(
            "users",
            "seller-1",
            &json!({ "username": "seller1", "stripeConnectStatus": "pending" }),
        )
        .await
        .expect("seller profile");
    let app = pokoin_commerce::router(state);
    let (status, body) = call(
        &app,
        "POST",
        "/api/marketplace-orders",
        Some(json!({ "action": "confirm-delivery", "orderId": "order-eur-channel" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // The Stripe-transfer path ran (it records the pending seller and escrow).
    assert_eq!(body["transfers"]["duplicate"], json!(false), "{body}");
    let order = firestore
        .get_document(&firestore.document_path("orders", "order-eur-channel").unwrap())
        .await
        .unwrap()
        .expect("order");
    assert_eq!(order["transfersPendingSellerIds"], json!(["seller-1"]));
}
