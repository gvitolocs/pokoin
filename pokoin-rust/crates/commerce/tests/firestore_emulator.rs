//! `runQuery` against the real Firestore emulator (project `demo-pokoin-e2e`).
//!
//! Skipped unless `FIRESTORE_EMULATOR_HOST` points at a local emulator:
//!
//! ```text
//! java -jar ~/.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar --host 127.0.0.1 --port 8086 &
//! FIRESTORE_EMULATOR_HOST=127.0.0.1:8086 cargo test -p pokoin-commerce --test firestore_emulator
//! ```

use serde_json::{json, Value};

use pokoin_commerce::firestore::{FirestoreClient, StructuredQuery};

const PROJECT: &str = "demo-pokoin-e2e";

fn emulator() -> Option<FirestoreClient> {
    let Ok(host) = std::env::var("FIRESTORE_EMULATOR_HOST") else {
        eprintln!("skipped: FIRESTORE_EMULATOR_HOST unset");
        return None;
    };
    assert!(
        host.starts_with("127.0.0.1:") || host.starts_with("localhost:"),
        "FIRESTORE_EMULATOR_HOST must be a local emulator, got {host}"
    );
    Some(FirestoreClient::with_static_token(
        reqwest::Client::new(),
        PROJECT,
        format!("http://{host}/v1/projects/{PROJECT}/databases/(default)/documents"),
        "owner",
    ))
}

fn ids(rows: &[Value]) -> Vec<&str> {
    rows.iter().filter_map(|row| row["id"].as_str()).collect()
}

#[tokio::test]
async fn a_subcollection_query_reads_only_that_documents_children() {
    let Some(firestore) = emulator() else { return };
    let run = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let user = format!("rq-user-{run}");
    let other = format!("rq-other-{run}");
    let mine = format!("users/{user}/shipping_addresses");
    let seeds = [
        (mine.clone(), "a1".to_string(), json!({ "createdAt": "2026-10-01T00:00:00Z", "isDefault": false })),
        (mine.clone(), "a2".to_string(), json!({ "createdAt": "2026-10-02T00:00:00Z", "isDefault": true })),
        (
            format!("users/{other}/shipping_addresses"),
            "x".to_string(),
            json!({ "createdAt": "2026-10-03T00:00:00Z", "isDefault": true }),
        ),
        (
            "shipping_addresses".to_string(),
            format!("root-{run}"),
            json!({ "createdAt": "2026-10-04T00:00:00Z", "isDefault": true }),
        ),
    ];
    for (collection, id, value) in &seeds {
        firestore.create_document(collection, id, value).await.expect("seed");
    }

    let parent = firestore.document_path("users", &user).unwrap();
    let listed = firestore
        .run_query(
            &StructuredQuery::collection("shipping_addresses")
                .parent(parent.clone())
                .order_by("createdAt", true),
        )
        .await
        .expect("list");
    let defaults = firestore
        .run_query(
            &StructuredQuery::collection("shipping_addresses")
                .parent(parent)
                .where_eq("isDefault", json!(true)),
        )
        .await
        .expect("defaults");

    for (collection, id, _) in &seeds {
        let _ = firestore
            .delete_document(&format!("{}/{id}", firestore.collection_url(collection)))
            .await;
    }

    assert_eq!(ids(&listed), ["a2", "a1"]);
    assert_eq!(ids(&defaults), ["a2"]);
}
