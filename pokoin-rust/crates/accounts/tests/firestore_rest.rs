//! Firestore REST behaviour: typed writes, transforms, reads, queries and
//! transaction retry on `ABORTED`.
//!
//! The scripted transport records every request, so these assertions are about
//! the actual wire payloads (`updateMask`, `transform`, `currentDocument`,
//! `structuredQuery`, `commit`) rather than about internal state.

mod common;

use std::sync::Arc;

use common::*;
use pokoin_accounts::firebase::ServiceAccount;
use pokoin_accounts::firestore::{
    Direction, DocData, FieldValue, Firestore, Query, Value,
};
use pokoin_accounts::http::{HttpResponse, RetryPolicy};

const DOCS: &str = "/databases/(default)/documents";

fn firestore(transport: &Arc<ScriptedTransport>) -> Firestore {
    transport.on_json(
        "https://test.local/oauth",
        200,
        serde_json::json!({ "access_token": "test-access-token", "expires_in": 3600 }),
    );
    let account = ServiceAccount::new(&test_config(), transport.as_transport()).unwrap();
    Firestore::new(
        &test_config(),
        transport.as_transport(),
        Arc::new(account),
        RetryPolicy::default(),
    )
}

fn document_json(name: &str, fields: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "name": name, "fields": fields })
}

#[tokio::test]
async fn a_merge_set_sends_an_update_mask_and_the_bearer_token() {
    let transport = ScriptedTransport::new();
    transport.on_json(
        &format!("{DOCS}:commit"),
        200,
        serde_json::json!({ "writeResults": [{}] }),
    );
    let firestore = firestore(&transport);

    firestore
        .doc("users/u1")
        .set(
            DocData::new().string("email", "a@b.co").bool("active", true),
            true,
        )
        .await
        .expect("commit succeeds");

    let commits = transport.requests_to(":commit");
    assert_eq!(commits.len(), 1);
    let request = &commits[0];
    assert_eq!(
        request.header_value("authorization"),
        Some("Bearer test-access-token")
    );
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let write = &body["writes"][0];
    assert_eq!(
        write["update"]["name"],
        serde_json::json!(format!(
            "https://test.local/v1/projects/{TEST_PROJECT}{DOCS}/users/u1"
        ))
    );
    assert_eq!(
        write["update"]["fields"]["email"],
        serde_json::json!({ "stringValue": "a@b.co" })
    );
    assert_eq!(
        write["updateMask"]["fieldPaths"],
        serde_json::json!(["email", "active"])
    );
    // A merge write must not carry a create-only precondition.
    assert!(write.get("currentDocument").is_none());
}

#[tokio::test]
async fn server_timestamps_and_increments_become_a_transform_write() {
    let transport = ScriptedTransport::new();
    transport.on_json(
        &format!("{DOCS}:commit"),
        200,
        serde_json::json!({ "writeResults": [{}, {}] }),
    );
    let firestore = firestore(&transport);

    firestore
        .doc("balances/u1")
        .set(
            DocData::new()
                .increment("availablePkn", 0)
                .server_timestamp("updatedAt")
                .string("note", "x"),
            true,
        )
        .await
        .expect("commit succeeds");

    let body: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":commit")[0].body).unwrap();
    let writes = body["writes"].as_array().unwrap();
    assert_eq!(writes.len(), 2, "one update write plus one transform write");
    // The update write must only carry the plain field.
    assert!(writes[0]["update"]["fields"].get("updatedAt").is_none());
    assert!(writes[0]["update"]["fields"].get("availablePkn").is_none());
    assert_eq!(
        writes[0]["update"]["fields"]["note"],
        serde_json::json!({ "stringValue": "x" })
    );
    let transforms = writes[1]["transform"]["fieldTransforms"].as_array().unwrap();
    assert_eq!(transforms.len(), 2);
    assert_eq!(transforms[0]["fieldPath"], serde_json::json!("availablePkn"));
    assert_eq!(
        transforms[0]["increment"],
        serde_json::json!({ "integerValue": "0" })
    );
    assert_eq!(transforms[1]["fieldPath"], serde_json::json!("updatedAt"));
    assert_eq!(
        transforms[1]["setToServerValue"],
        serde_json::json!("REQUEST_TIME")
    );
}

#[tokio::test]
async fn a_full_overwrite_sends_no_update_mask() {
    let transport = ScriptedTransport::new();
    transport.on_json(
        &format!("{DOCS}:commit"),
        200,
        serde_json::json!({ "writeResults": [{}] }),
    );
    let firestore = firestore(&transport);
    firestore
        .doc("wallet_auth_nonces/0xabc")
        .set(DocData::new().string("nonce", "n1"), false)
        .await
        .unwrap();

    let body: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":commit")[0].body).unwrap();
    assert!(body["writes"][0].get("updateMask").is_none());
}

#[tokio::test]
async fn create_requires_the_document_to_be_absent_and_update_requires_it_present() {
    let transport = ScriptedTransport::new();
    transport.on_json(
        &format!("{DOCS}:commit"),
        200,
        serde_json::json!({ "writeResults": [{}] }),
    );
    let firestore = firestore(&transport);

    firestore
        .doc("users/u1")
        .create(DocData::new().string("email", "a@b.co"))
        .await
        .unwrap();
    firestore
        .doc("users/u1")
        .update(DocData::new().string("email", "b@c.co"))
        .await
        .unwrap();

    let commits = transport.requests_to(":commit");
    let first: serde_json::Value = serde_json::from_slice(&commits[0].body).unwrap();
    assert_eq!(
        first["writes"][0]["currentDocument"],
        serde_json::json!({ "exists": false })
    );
    let second: serde_json::Value = serde_json::from_slice(&commits[1].body).unwrap();
    assert_eq!(
        second["writes"][0]["currentDocument"],
        serde_json::json!({ "exists": true })
    );
}

#[tokio::test]
async fn delete_sends_a_delete_write() {
    let transport = ScriptedTransport::new();
    transport.on_json(
        &format!("{DOCS}:commit"),
        200,
        serde_json::json!({ "writeResults": [{}] }),
    );
    let firestore = firestore(&transport);
    firestore.doc("usernames/ash").delete().await.unwrap();

    let body: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":commit")[0].body).unwrap();
    assert_eq!(
        body["writes"][0]["delete"],
        serde_json::json!(format!(
            "https://test.local/v1/projects/{TEST_PROJECT}{DOCS}/usernames/ash"
        ))
    );
}

#[tokio::test]
async fn get_returns_none_on_404_and_the_document_on_200() {
    let transport = ScriptedTransport::new();
    transport.on("users/missing", |_| {
        HttpResponse::json(404, serde_json::json!({ "error": { "code": 5, "status": "NOT_FOUND" } }))
    });
    transport.on("users/present", |_| {
        HttpResponse::json(
            200,
            document_json(
                &format!("projects/{TEST_PROJECT}{DOCS}/users/present"),
                serde_json::json!({
                    "username": { "stringValue": "ash" },
                    "availablePkn": { "integerValue": "42" },
                    "lastLoginAt": { "timestampValue": "2026-10-08T00:00:00Z" }
                }),
            ),
        )
    });
    let firestore = firestore(&transport);

    assert!(firestore.doc("users/missing").get().await.unwrap().is_none());
    let document = firestore
        .doc("users/present")
        .get()
        .await
        .unwrap()
        .expect("present");
    assert_eq!(document.get_str("username"), "ash");
    assert_eq!(document.get_i64("availablePkn"), Some(42));
    assert!(document.get_timestamp_millis("lastLoginAt").is_some());
    assert_eq!(document.id(), "present");
}

#[tokio::test]
async fn a_query_sends_a_structured_query_and_decodes_rows() {
    let transport = ScriptedTransport::new();
    transport.on(":runQuery", |_| {
        HttpResponse::json(
            200,
            serde_json::json!([
                { "document": document_json(
                    &format!("projects/{TEST_PROJECT}{DOCS}/user_card_collections/scan:1"),
                    serde_json::json!({
                        "uid": { "stringValue": "u1" },
                        "cardId": { "stringValue": "12345" },
                        "quantity": { "integerValue": "2" },
                        "ownershipType": { "stringValue": "physical" }
                    })
                ) },
                { "readTime": "2026-10-08T00:00:00Z" }
            ]),
        )
    });
    let firestore = firestore(&transport);

    let documents = firestore
        .run_query(
            &Query::collection("user_card_collections")
                .where_eq("uid", "u1")
                .order_by("updatedAt", Direction::Descending)
                .limit(50),
        )
        .await
        .expect("query succeeds");

    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0].id(), "scan:1");
    let body: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":runQuery")[0].body).unwrap();
    assert_eq!(
        body["structuredQuery"]["from"][0]["collectionId"],
        serde_json::json!("user_card_collections")
    );
    assert_eq!(
        body["structuredQuery"]["where"]["fieldFilter"]["value"],
        serde_json::json!({ "stringValue": "u1" })
    );
    assert_eq!(body["structuredQuery"]["limit"], serde_json::json!(50));
}

#[tokio::test]
async fn a_transaction_begins_reads_commits_and_keeps_writes_atomic() {
    let transport = ScriptedTransport::new();
    transport.on(":beginTransaction", |_| {
        HttpResponse::json(200, serde_json::json!({ "transaction": "dHhu" }))
    });
    transport.on(":batchGet", |_| {
        HttpResponse::json(
            200,
            serde_json::json!([{ "found": document_json(
                &format!("projects/{TEST_PROJECT}{DOCS}/wallet_auth_nonces/0xabc"),
                serde_json::json!({
                    "message": { "stringValue": "Sign in to Pokoin" },
                    "used": { "booleanValue": false },
                    "issuedAt": { "stringValue": "2026-10-08T00:00:00.000Z" }
                })
            ) }]),
        )
    });
    transport.on_json(
        &format!("{DOCS}:commit"),
        200,
        serde_json::json!({ "writeResults": [{}] }),
    );
    let firestore = firestore(&transport);

    let observed = firestore
        .run_transaction(|transaction| {
            Box::pin(async move {
                let reference = transaction.doc("wallet_auth_nonces/0xabc");
                let document = transaction.get_doc(&reference).await?;
                let message = document.map(|d| d.get_str("message")).unwrap_or_default();
                transaction.set(
                    &reference,
                    DocData::new().bool("used", true),
                    true,
                )?;
                Ok(message)
            })
        })
        .await
        .expect("transaction succeeds");
    assert_eq!(observed, "Sign in to Pokoin");

    // The read used the transaction id, and the commit used the same one.
    let batch: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":batchGet")[0].body).unwrap();
    assert_eq!(batch["transaction"], serde_json::json!("dHhu"));
    let commit: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":commit")[0].body).unwrap();
    assert_eq!(commit["transaction"], serde_json::json!("dHhu"));
    assert_eq!(commit["writes"][0]["updateMask"]["fieldPaths"], serde_json::json!(["used"]));
    assert!(transport.requests_to(":rollback").is_empty());
}

#[tokio::test]
async fn an_aborted_transaction_is_retried_and_then_succeeds() {
    let transport = ScriptedTransport::new();
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = attempts.clone();
    transport.on(":beginTransaction", move |_| {
        let attempt = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        HttpResponse::json(
            200,
            serde_json::json!({ "transaction": format!("tx{attempt}") }),
        )
    });
    transport.on(":batchGet", |_| {
        HttpResponse::json(200, serde_json::json!([{ "found": document_json(
            &format!("projects/{TEST_PROJECT}{DOCS}/users/u1"),
            serde_json::json!({ "username": { "stringValue": "ash" } })
        ) }]))
    });
    let commits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let commit_counter = commits.clone();
    transport.on_method("POST", ":commit", move |_| {
        let attempt = commit_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if attempt == 0 {
            // First commit loses the race.
            HttpResponse::json(
                409,
                serde_json::json!({ "error": { "code": 10, "status": "ABORTED", "message": "too much contention" } }),
            )
        } else {
            HttpResponse::json(200, serde_json::json!({ "writeResults": [{}] }))
        }
    });
    let firestore = firestore(&transport);

    let result = firestore
        .run_transaction(|transaction| {
            let _ = &transaction;
            Box::pin(async move {
                let reference = transaction.doc("users/u1");
                transaction.set(&reference, DocData::new().bool("active", true), true)?;
                Ok(7)
            })
        })
        .await
        .expect("the retry succeeds");
    assert_eq!(result, 7);
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert_eq!(commits.load(std::sync::atomic::Ordering::SeqCst), 2);
    // The aborted attempt is rolled back before the retry.
    assert_eq!(transport.requests_to(":rollback").len(), 1);
}

#[tokio::test]
async fn a_transaction_body_error_rolls_back_and_is_returned_unchanged() {
    let transport = ScriptedTransport::new();
    transport.on(":beginTransaction", |_| {
        HttpResponse::json(200, serde_json::json!({ "transaction": "tx" }))
    });
    transport.on(":batchGet", |_| {
        HttpResponse::json(200, serde_json::json!([{ "found": document_json(
            &format!("projects/{TEST_PROJECT}{DOCS}/wallet_auth_nonces/0xabc"),
            serde_json::json!({ "used": { "booleanValue": true } })
        ) }]))
    });
    let firestore = firestore(&transport);

    let error = firestore
        .run_transaction(|transaction| {
            Box::pin(async move {
                let reference = transaction.doc("wallet_auth_nonces/0xabc");
                let document = transaction.get_doc(&reference).await?;
                if document.and_then(|d| d.get_bool("used")).unwrap_or(false) {
                    // A domain failure, not a conflict: no retry.
                    return Err(pokoin_accounts::ApiError::bad_request(
                        "Wallet sign-in nonce expired. Try again.",
                    ));
                }
                Ok(())
            })
        })
        .await
        .unwrap_err();
    assert_eq!(error.status(), axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(transport.requests_to(":beginTransaction").len(), 1);
    assert_eq!(transport.requests_to(":rollback").len(), 1);
    assert!(transport.requests_to(":commit").is_empty());
}

#[tokio::test]
async fn a_transaction_with_no_writes_is_rolled_back_instead_of_committed() {
    let transport = ScriptedTransport::new();
    transport.on(":beginTransaction", |_| {
        HttpResponse::json(200, serde_json::json!({ "transaction": "tx" }))
    });
    transport.on(":batchGet", |_| {
        HttpResponse::json(200, serde_json::json!([{ "found": document_json(
            &format!("projects/{TEST_PROJECT}{DOCS}/users/u1"),
            serde_json::json!({ "username": { "stringValue": "ash" } })
        ) }]))
    });
    transport.on_json(":rollback", 200, serde_json::json!({}));
    let firestore = firestore(&transport);

    firestore
        .run_transaction(|transaction| {
            Box::pin(async move {
                let reference = transaction.doc("users/u1");
                let _ = transaction.get_doc(&reference).await?;
                Ok(())
            })
        })
        .await
        .expect("read-only transaction succeeds");
    assert!(transport.requests_to(":commit").is_empty());
    assert_eq!(transport.requests_to(":rollback").len(), 1);
}

#[tokio::test]
async fn a_retryable_write_status_is_retried_by_the_transport() {
    let transport = ScriptedTransport::new();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = calls.clone();
    transport.on_method("POST", ":commit", move |_| {
        let call = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if call == 0 {
            HttpResponse::json(503, serde_json::json!({ "error": { "status": "UNAVAILABLE" } }))
        } else {
            HttpResponse::json(200, serde_json::json!({ "writeResults": [{}] }))
        }
    });
    let firestore = firestore(&transport);
    firestore
        .doc("users/u1")
        .set(DocData::new().string("a", "b"), true)
        .await
        .expect("transient 503 is retried");
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_stale_access_token_is_invalidated_after_a_401() {
    let transport = ScriptedTransport::new();
    let tokens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = tokens.clone();
    transport.on("https://test.local/oauth", move |_| {
        let call = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        oauth_response(&format!("token-{call}"), 3600)
    });
    transport.on_method("POST", ":commit", |request| {
        if request.header_value("authorization") == Some("Bearer token-0") {
            HttpResponse::json(401, serde_json::json!({ "error": { "status": "UNAUTHENTICATED" } }))
        } else {
            HttpResponse::json(200, serde_json::json!({ "writeResults": [{}] }))
        }
    });
    let firestore = firestore(&transport);

    // The first attempt 401s (and is not retryable at the HTTP level), so the
    // caller sees an error; the next call must use a freshly minted token.
    let _ = firestore
        .doc("users/u1")
        .set(DocData::new().string("a", "b"), true)
        .await;
    firestore
        .doc("users/u1")
        .set(DocData::new().string("a", "b"), true)
        .await
        .expect("the refreshed token is accepted");
    assert_eq!(transport.requests_to("/oauth").len(), 2);
}

#[tokio::test]
async fn typed_values_survive_a_write_and_a_read_of_the_same_field() {
    let transport = ScriptedTransport::new();
    transport.on_json(
        &format!("{DOCS}:commit"),
        200,
        serde_json::json!({ "writeResults": [{}] }),
    );
    transport.on("users/typed", |_| {
        HttpResponse::json(
            200,
            document_json(
                &format!("projects/{TEST_PROJECT}{DOCS}/users/typed"),
                serde_json::json!({
                    "n": { "integerValue": "9007199254740993" },
                    "d": { "doubleValue": 1.5 },
                    "b": { "booleanValue": true },
                    "arr": { "arrayValue": { "values": [{ "integerValue": "1" }] } },
                    "map": { "mapValue": { "fields": { "k": { "stringValue": "v" } } } },
                    "nil": { "nullValue": null }
                }),
            ),
        )
    });
    let firestore = firestore(&transport);
    let document = firestore.doc("users/typed").get().await.unwrap().unwrap();

    // int64 precision must survive the string encoding.
    assert_eq!(document.get_i64("n"), Some(9_007_199_254_740_993));
    assert_eq!(
        document.get("d"),
        Some(Value::Double(1.5))
    );
    assert_eq!(document.get_bool("b"), Some(true));
    assert_eq!(
        document.get("arr"),
        Some(Value::Array(vec![Value::Integer(1)]))
    );
    assert!(matches!(document.get("map"), Some(Value::Map(_))));
    assert_eq!(document.get("nil"), Some(Value::Null));

    // Writing the same shapes uses the documented typed encodings.
    firestore
        .doc("users/typed")
        .set(
            DocData::new()
                .set("n", Value::Integer(9_007_199_254_740_993))
                .set("nil", Value::Null),
            true,
        )
        .await
        .unwrap();
    let body: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":commit")[0].body).unwrap();
    assert_eq!(
        body["writes"][0]["update"]["fields"]["n"],
        serde_json::json!({ "integerValue": "9007199254740993" })
    );
    assert_eq!(
        body["writes"][0]["update"]["fields"]["nil"],
        serde_json::json!({ "nullValue": null })
    );
}

#[test]
fn field_value_transforms_are_not_plain_fields() {
    let data = DocData::new()
        .string("plain", "x")
        .server_timestamp("ts")
        .increment("n", 3)
        .set(
            "union",
            FieldValue::ArrayUnion(vec![Value::String("a".into())]),
        )
        .set(
            "remove",
            FieldValue::ArrayRemove(vec![Value::String("b".into())]),
        );
    assert_eq!(data.field_paths().len(), 5);
}
