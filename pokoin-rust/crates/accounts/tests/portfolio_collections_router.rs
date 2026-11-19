//! `GET|POST /api/marketplace-portfolio-collections` over the real router and a
//! scripted Firestore.
//!
//! The database behind the prices is deliberately *not* configured here: with no
//! market read model every card of every list answers held and unpriced, which is
//! the answer the route owes a seller whose catalog is down, and it keeps these
//! tests about the HTTP contract — who may read, what a write stores, which names
//! collide and which ids exist. The prices themselves, and the fact that a card of
//! another game is priced by its own database, are
//! [`portfolio_collections_flow`](../pokoin_accounts) territory.
//!
//! The scripted Firestore is a document store, not an echo: it holds what a commit
//! wrote and answers a query and a `get` from that, so a save really is read back
//! and a foreign document really is another seller's.

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use common::*;
use http_body_util::BodyExt;
use pokoin_accounts::http::HttpResponse;
use pokoin_accounts::router;
use serde_json::{json, Value as Json};
use tower::ServiceExt;

const COLLECTION: &str = "portfolio_collections";
const SELLER: &str = "user-1";
const OTHER: &str = "user-2";

/// The Firestore base URL of [`test_config`].
const BASE: &str = "https://test.local/v1/projects/pokoin-test/databases/(default)/documents";

/// Firestore documents by path and the version each was last written at, with the
/// read sets of the open transactions: what a commit is checked against, so a write
/// that read a state someone else changed loses the race the backend makes it lose.
#[derive(Default)]
struct Db {
    docs: HashMap<String, (Json, u64)>,
    /// Every write bumps this, and a transaction that ran a query holds it in its
    /// read set: a document added anywhere in the collection is a change to that
    /// query's answer, which is what the real store aborts on.
    version: u64,
    txns: u64,
    reads: HashMap<String, Vec<(String, u64)>>,
    /// Fail this many following commits with `ABORTED` whatever was read — the
    /// contention the backend invents under load, which the client retries.
    aborts: usize,
    /// A document this fake deletes at the moment it aborts, so a test can say *the
    /// list was deleted while your transaction was in flight* and have the retry
    /// really read it gone.
    vanish_on_abort: Option<String>,
}

/// The read-set key of a query, which has no document of its own.
const QUERY_READ: &str = "*";

impl Db {
    fn document(&self, id: &str) -> Option<Json> {
        self.docs
            .get(&format!("{COLLECTION}/{id}"))
            .map(|(document, _)| document.clone())
    }

    /// Seed one document, at a fresh version.
    fn insert(&mut self, key: String, document: Json) {
        self.version += 1;
        self.docs.insert(key_of(&key), (document, self.version));
    }

    /// The backend's own `ABORTED`, the shape `tests/firestore_rest.rs` proved the
    /// client retries on.
    fn abort(&mut self) -> HttpResponse {
        if let Some(path) = self.vanish_on_abort.take() {
            self.remove(&path);
        }
        HttpResponse::json(
            409,
            json!({
                "error": {
                    "code": 10,
                    "status": "ABORTED",
                    "message": "The transaction has been aborted on the backend.",
                }
            }),
        )
    }

    /// A write, at the store's next version. `currentDocument` preconditions are
    /// not enforced here: a create mints a fresh id every attempt, so the read set
    /// above is the only conflict this route can meet.
    fn write(&mut self, name: &str, fields: Json) {
        self.version += 1;
        self.docs.insert(
            key_of(name),
            (json!({ "name": name, "fields": fields }), self.version),
        );
    }

    fn remove(&mut self, name: &str) {
        self.version += 1;
        self.docs.remove(&key_of(name));
    }
}

fn document(id: &str, uid: &str, name: &str, created: &str, items: Vec<Json>) -> (String, Json) {
    (
        format!("{COLLECTION}/{id}"),
        json!({
            "name": format!("{BASE}/{COLLECTION}/{id}"),
            "fields": {
                "uid": { "stringValue": uid },
                "name": { "stringValue": name },
                "items": { "arrayValue": { "values": items } },
                "createdAt": { "timestampValue": created },
                "updatedAt": { "timestampValue": created },
            }
        }),
    )
}

fn stored(id: &str, uid: &str, name: &str, created: &str) -> (String, Json) {
    document(id, uid, name, created, Vec::new())
}

/// The store key of a resource name, in either form the client uses: the REST
/// `…/documents/<path>` name a commit carries, or the plain `<path>` of a seed.
fn key_of(name: &str) -> String {
    name.rsplit("/documents/")
        .next()
        .unwrap_or(name)
        .trim_matches('/')
        .to_string()
}

/// One card of one list, in the map shape [`pokoin_accounts::firestore`] writes.
fn card(id: &str, quantity: i64) -> Json {
    json!({
        "mapValue": {
            "fields": {
                "cardId": { "stringValue": id },
                "quantity": { "integerValue": quantity.to_string() },
                "condition": { "stringValue": "NM" },
                "language": { "stringValue": "EN" },
                "reverse": { "booleanValue": false },
                "firstEdition": { "booleanValue": false },
                "graded": { "booleanValue": false },
                "game": { "stringValue": "pokemon" },
                "name": { "stringValue": "Charizard" },
                "setName": { "stringValue": "Base Set" },
            }
        }
    })
}

/// A Firestore whose answers come from what it was last told, so a save really is
/// read back and a foreign document really is another seller's — and whose commits
/// really do fail when the state a transaction read has moved, which is the only
/// way to test that two writes cannot both land. The transport comes back with it
/// because a refusal that never reaches the store is only proven by counting what
/// the store was asked.
fn store_state(
    seed: Vec<(String, Json)>,
) -> (
    pokoin_accounts::state::DomainState,
    Arc<Mutex<Db>>,
    Arc<ScriptedTransport>,
) {
    let mut db = Db::default();
    for (key, document) in seed {
        db.insert(key, document);
    }
    let store = Arc::new(Mutex::new(db));
    let transport = ScriptedTransport::new();
    transport.on("/oauth", |_| {
        HttpResponse::json(200, json!({ "access_token": "t", "expires_in": 3600 }))
    });
    transport.on("/jwks", |_| jwks_response());

    // `:beginTransaction` — a fresh read-set, named the way the wire names it.
    let begun = store.clone();
    transport.on(":beginTransaction", move |_| {
        let mut db = begun.lock().unwrap();
        db.txns += 1;
        let id = format!("txn{}", db.txns);
        db.reads.insert(id.clone(), Vec::new());
        HttpResponse::json(200, json!({ "transaction": id }))
    });

    /// The transaction a body names, if it names one: only a read inside a
    /// transaction joins a read set the commit is checked against.
    fn transaction_of(asked: &Json) -> Option<String> {
        asked["transaction"]
            .as_str()
            .map(str::to_string)
            .filter(|id| !id.is_empty())
    }

    // `:batchGet` — the document read of a transaction body. A miss is a read too:
    // the create that lands elsewhere afterwards conflicts with it.
    let gets = store.clone();
    transport.on(":batchGet", move |request| {
        let asked: Json = serde_json::from_slice(&request.body).unwrap_or(Json::Null);
        let mut db = gets.lock().unwrap();
        let transaction = transaction_of(&asked);
        let rows: Vec<Json> = asked["documents"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|name| name.as_str().unwrap_or_default())
            .map(|name| {
                let key = key_of(name);
                if let Some(transaction) = &transaction {
                    let version = db
                        .docs
                        .get(&key)
                        .map(|(_, version)| *version)
                        .unwrap_or_default();
                    db.reads
                        .entry(transaction.clone())
                        .or_default()
                        .push((key.clone(), version));
                }
                match db.docs.get(&key) {
                    Some((document, _)) => json!({ "found": document }),
                    None => json!({}),
                }
            })
            .collect();
        HttpResponse::json(200, Json::Array(rows))
    });

    // `:runQuery` — the seller's documents, in whatever order Firestore answers.
    let queries = store.clone();
    transport.on(":runQuery", move |request| {
        let asked: Json = serde_json::from_slice(&request.body).unwrap_or(Json::Null);
        let wanted = asked["structuredQuery"]["where"]["fieldFilter"]["value"]["stringValue"]
            .as_str()
            .unwrap_or_default();
        let mut db = queries.lock().unwrap();
        if let Some(transaction) = transaction_of(&asked) {
            let version = db.version;
            db.reads
                .entry(transaction)
                .or_default()
                .push((QUERY_READ.to_string(), version));
        }
        let documents: Vec<Json> = db
            .docs
            .values()
            .map(|(document, _)| document)
            .filter(|document| document["fields"]["uid"]["stringValue"].as_str() == Some(wanted))
            .map(|document| json!({ "document": document }))
            .collect();
        HttpResponse::json(200, Json::Array(documents))
    });

    // `:commit` — abort on anything the transaction read having moved, else apply
    // every `update` and `delete` of the write.
    let writes = store.clone();
    transport.on(":commit", move |request| {
        let body: Json = serde_json::from_slice(&request.body).unwrap_or(Json::Null);
        let mut db = writes.lock().unwrap();
        let transaction = body["transaction"].as_str().unwrap_or_default();
        let reads = db.reads.remove(transaction).unwrap_or_default();
        if db.aborts > 0 {
            db.aborts -= 1;
            return db.abort();
        }
        for (key, version) in reads {
            let now = if key == QUERY_READ {
                db.version
            } else {
                db.docs.get(&key).map(|(_, v)| *v).unwrap_or_default()
            };
            if now != version {
                return db.abort();
            }
        }
        let mut results = Vec::new();
        for write in body["writes"].as_array().cloned().unwrap_or_default() {
            if let Some(name) = write["delete"].as_str() {
                db.remove(name);
                results.push(json!({}));
                continue;
            }
            if write["update"].is_null() {
                results.push(json!({}));
                continue;
            }
            let name = write["update"]["name"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            db.write(&name, write["update"]["fields"].clone());
            results.push(json!({ "transformResults": {} }));
        }
        HttpResponse::json(200, json!({ "writeResults": results }))
    });

    // `:rollback` — the read set is dropped with the transaction.
    let rolled = store.clone();
    transport.on(":rollback", move |request| {
        let body: Json = serde_json::from_slice(&request.body).unwrap_or(Json::Null);
        let transaction = body["transaction"].as_str().unwrap_or_default();
        rolled.lock().unwrap().reads.remove(transaction);
        HttpResponse::json(200, json!({}))
    });

    // A plain document read: the REST API's 404, which the client answers `None`.
    let reads = store.clone();
    transport.on_method("GET", BASE, move |request| {
        match reads.lock().unwrap().docs.get(&key_of(&request.url)) {
            Some((document, _)) => HttpResponse::json(200, document.clone()),
            None => HttpResponse::json(
                404,
                json!({ "error": { "code": 5, "message": "Document not found." } }),
            ),
        }
    });

    (test_state(&transport), store, transport)
}

/// Every Firestore wire call a request made — document reads and writes, queries and
/// commits — and nothing else. The token fetches are not the store.
fn store_calls(transport: &ScriptedTransport) -> Vec<String> {
    transport
        .requests()
        .iter()
        .filter(|request| request.url.contains("/documents"))
        .map(|request| request.url.clone())
        .collect()
}

fn token(sub: &str) -> String {
    sign_id_token(id_token_claims(
        sub,
        "ash@pokoin.com",
        chrono::Utc::now().timestamp(),
    ))
}

async fn call(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Json>,
    uid: Option<&str>,
) -> (StatusCode, Json, HashMap<String, String>) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(uid) = uid {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {}", token(uid)));
    }
    let request = match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .expect("a test request is well formed"),
        None => builder
            .body(Body::empty())
            .expect("a test request is well formed"),
    };
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("the router answers");
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_lowercase(),
                String::from_utf8_lossy(value.as_bytes()).to_string(),
            )
        })
        .collect();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("the body reads")
        .to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Json::Null),
        headers,
    )
}

async fn get(app: &axum::Router, uid: Option<&str>) -> (StatusCode, Json, HashMap<String, String>) {
    call(
        app,
        Method::GET,
        "/api/marketplace-portfolio-collections",
        None,
        uid,
    )
    .await
}

async fn post(
    app: &axum::Router,
    action: &str,
    body: Json,
    uid: &str,
) -> (StatusCode, Json, HashMap<String, String>) {
    call(
        app,
        Method::POST,
        &format!("/api/marketplace-portfolio-collections?action={action}"),
        Some(body),
        Some(uid),
    )
    .await
}

/// `[valuePkn, cardsPriced, cardsHeld]` of one collection of one day.
fn segment(day: &Json, id: &str) -> Vec<f64> {
    day["segments"][format!("collection:{id}")]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|value| value.as_f64().unwrap_or_default())
        .collect()
}

/// The names the answer lists, in the order it lists them.
fn names_of(body: &Json) -> Vec<String> {
    body["collections"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|collection| collection["name"].as_str().unwrap_or_default().to_string())
        .collect()
}

#[tokio::test]
async fn a_seller_reads_their_own_lists_and_nobody_elses() {
    let (state, _store, _transport) = store_state(vec![
        stored("mine", SELLER, "Vault", "2026-09-01T10:00:00Z"),
        stored("theirs", OTHER, "Their vault", "2026-09-02T10:00:00Z"),
        document(
            "late",
            SELLER,
            "Wishlist",
            "2026-09-03T10:00:00Z",
            vec![card("11", 2)],
        ),
    ]);
    let app = router(state);

    let (status, body, headers) = get(&app, Some(SELLER)).await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        headers.get("cache-control").map(String::as_str),
        Some("private, no-store"),
        "a seller's lists and their worth are never cacheable"
    );
    assert_eq!(body["priceBasis"], json!("ct-last-sold"));
    assert_eq!(
        body["limits"],
        json!({ "collections": 20, "items": 300, "quantity": 999, "name": 40 })
    );
    assert_eq!(
        body["saved"],
        Json::Null,
        "only a write answers which list it wrote"
    );

    // The keys the contract lists, in its order, and the two lists in theirs.
    let keys: Vec<&String> = body
        .as_object()
        .map(|map| map.keys().collect())
        .unwrap_or_default();
    assert_eq!(
        keys,
        ["priceBasis", "limits", "collections", "segmentDefs", "days"]
    );
    assert_eq!(
        names_of(&body),
        ["Vault", "Wishlist"],
        "oldest first, and the other seller's list is not in it"
    );
    assert_eq!(
        body["collections"][1]["createdAt"],
        json!("2026-09-03T10:00:00.000Z")
    );
    assert_eq!(
        body["segmentDefs"],
        json!([
            { "key": "collection:mine", "group": "collection", "label": "Vault" },
            { "key": "collection:late", "group": "collection", "label": "Wishlist" },
        ]),
        "one def per list, in creation order, empty or not"
    );

    // No market read model is configured, so nothing is priceable: the series is
    // today alone and every card is held at nothing.
    let days = body["days"].as_array().cloned().unwrap_or_default();
    assert_eq!(days.len(), 1, "body={body}");
    assert_eq!(
        days[0]["date"],
        json!(chrono::Utc::now().format("%Y-%m-%d").to_string())
    );
    assert_eq!(segment(&days[0], "late"), vec![0.0, 0.0, 2.0]);
    assert_eq!(
        days[0]["segments"].get("collection:mine"),
        None,
        "a list of no cards holds nothing"
    );
    assert_eq!(body["collections"][1]["items"][0]["pricePkn"], Json::Null);
    assert_eq!(body["collections"][1]["items"][0]["cardId"], json!("11"));
    assert_eq!(body["collections"][1]["items"][0]["quantity"], json!(2));

    // A request without a token never reaches the store at all.
    for (status, body, headers) in [
        get(&app, None).await,
        post(&app, "save", json!({ "name": "Sneak" }), "").await,
    ] {
        assert_eq!(status, StatusCode::UNAUTHORIZED, "body={body}");
        assert_eq!(
            headers.get("cache-control").map(String::as_str),
            Some("private, no-store")
        );
    }
}

#[tokio::test]
async fn a_save_answers_the_list_it_just_wrote() {
    let (state, store, _transport) = store_state(vec![stored(
        "mine",
        SELLER,
        "Vault",
        "2026-09-01T10:00:00Z",
    )]);
    let app = router(state);

    let body = json!({
        "name": "  My   Drafts\u{1} ",
        "items": [
            { "cardId": "11", "quantity": 2 },
            { "cardId": "11" },
            { "cardId": "12", "game": "riftbound", "condition": "lightly played", "language": "ja" },
        ],
    });
    let (status, answer, headers) = post(&app, "save", body, SELLER).await;
    assert_eq!(status, StatusCode::OK, "answer={answer}");
    assert_eq!(
        headers.get("cache-control").map(String::as_str),
        Some("private, no-store")
    );
    let saved = answer["saved"].as_str().unwrap_or_default().to_string();
    assert!(
        saved.len() == 20 && saved.bytes().all(|byte| byte.is_ascii_alphanumeric()),
        "the id is the one Firestore mints: {saved}"
    );

    // The answer is the whole state *after* the write: both lists, the new one last,
    // the name cleaned, and the two copies of card 11 merged into one line of three.
    let collections = answer["collections"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(collections.len(), 2);
    assert_eq!(collections[1]["id"], json!(saved));
    assert_eq!(collections[1]["name"], json!("My Drafts"));
    let items = collections[1]["items"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(items.len(), 2, "answer={answer}");
    assert_eq!(items[0]["quantity"], json!(3));
    assert_eq!(items[1]["game"], json!("riftbound"));
    assert_eq!(items[1]["condition"], json!("SP"));
    assert_eq!(items[1]["language"], json!("JP"));
    assert_eq!(
        answer["segmentDefs"].as_array().map(Vec::len),
        Some(2),
        "the new list draws a line at once"
    );
    assert_eq!(segment(&answer["days"][0], &saved), vec![0.0, 0.0, 4.0]);

    // What was stored is the list and nothing else — no price, no blueprint.
    let written = store.lock().unwrap().document(&saved);
    let fields = written.expect("the save wrote its document")["fields"].clone();
    let keys: Vec<&String> = fields
        .as_object()
        .map(|map| map.keys().collect())
        .unwrap_or_default();
    assert_eq!(keys, ["uid", "name", "items", "createdAt", "updatedAt"]);
    assert_eq!(fields["uid"]["stringValue"], json!(SELLER));
    let stored = serde_json::to_string(&fields).unwrap_or_default();
    for secret in ["pricePkn", "blueprint", "median"] {
        assert!(
            !stored.to_lowercase().contains(secret),
            "a stored list carries no market answer: {stored}"
        );
    }

    // A name another list holds is taken, whatever its case…
    let (status, answer, _) = post(&app, "save", json!({ "name": "my drafts" }), SELLER).await;
    assert_eq!(status, StatusCode::CONFLICT, "answer={answer}");
    assert_eq!(answer["code"], json!("collection_name_taken"));
    let (status, answer, _) = post(
        &app,
        "save",
        json!({ "name": "MY DRAFTS", "items": [card_plain("13")] }),
        SELLER,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "answer={answer}");

    // …but a list renaming itself is not a collision, and a replace keeps the id
    // and the day it was created and writes the items it was given.
    let created = collections[1]["createdAt"].clone();
    let (status, answer, _) = post(
        &app,
        "save",
        json!({ "id": saved, "name": "My Drafts", "items": [card_plain("12")] }),
        SELLER,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "answer={answer}");
    assert_eq!(
        answer["saved"],
        json!(saved),
        "the same document, not a second one"
    );
    let after = answer["collections"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(after.len(), 2, "answer={answer}");
    assert_eq!(after[1]["id"], json!(saved));
    assert_eq!(
        after[1]["createdAt"], created,
        "a rename does not restart the list's history"
    );
    assert_eq!(after[1]["items"].as_array().map(Vec::len), Some(1));

    // Replacing the *other* list by its own name is the same write, not a new doc.
    let (status, answer, _) = post(
        &app,
        "save",
        json!({ "id": "mine", "name": "Vault", "items": [card_plain("11")] }),
        SELLER,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "answer={answer}");
    assert_eq!(
        answer["collections"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter(|collection| collection["id"] == json!("mine"))
            .count(),
        1,
        "a replace stays one document"
    );
}

fn card_plain(id: &str) -> Json {
    json!({ "cardId": id, "quantity": 1 })
}

#[tokio::test]
async fn a_list_you_do_not_own_is_not_there() {
    let (state, store, _transport) = store_state(vec![
        stored("mine", SELLER, "Vault", "2026-09-01T10:00:00Z"),
        stored("theirs", OTHER, "Their vault", "2026-09-02T10:00:00Z"),
    ]);
    let app = router(state);
    let their_before = store
        .lock()
        .unwrap()
        .document("theirs")
        .expect("the other seller's list is seeded");

    let attempts = [
        (
            "save over another seller's id",
            post(
                &app,
                "save",
                json!({ "id": "theirs", "name": "Mine now" }),
                SELLER,
            )
            .await,
        ),
        (
            "save over an id that never existed",
            post(
                &app,
                "save",
                json!({ "id": "neverwas", "name": "Mine now" }),
                SELLER,
            )
            .await,
        ),
        (
            "delete of an id that never existed",
            post(&app, "delete", json!({ "id": "neverwas" }), SELLER).await,
        ),
        (
            "delete of another seller's id",
            post(&app, "delete", json!({ "id": "theirs" }), SELLER).await,
        ),
        (
            "delete of an id of no shape",
            post(
                &app,
                "delete",
                json!({ "id": "a/path/that/cannot/be/a/document/id" }),
                SELLER,
            )
            .await,
        ),
    ];
    for (case, (status, answer, headers)) in attempts.iter() {
        assert_eq!(*status, StatusCode::NOT_FOUND, "{case}");
        assert_eq!(answer["code"], json!("collection_not_found"), "{case}");
        assert_eq!(answer["error"], "Collection not found.", "{case}");
        assert_eq!(
            headers.get("cache-control").map(String::as_str),
            Some("private, no-store"),
            "{case}"
        );
    }

    // An id is never revealed by an error: the two bodies are the same bytes.
    assert_eq!(
        serde_json::to_vec(&attempts[0].1 .1).unwrap_or_default(),
        serde_json::to_vec(&attempts[1].1 .1).unwrap_or_default(),
        "another seller's list and a missing list answer identically"
    );
    assert_eq!(
        store
            .lock()
            .unwrap()
            .document("theirs")
            .expect("the other seller's list is still there"),
        their_before,
        "another seller's document was neither written nor deleted"
    );
    // The seller's own list is untouched too: a refused save stores nothing.
    let (_status, answer, _) = get(&app, Some(SELLER)).await;
    assert_eq!(
        names_of(&answer),
        ["Vault"],
        "answer={answer}: a refused save stores nothing"
    );
}

#[tokio::test]
async fn a_request_outside_the_contract_is_refused() {
    let (state, _store, transport) = store_state(Vec::new());
    let app = router(state);

    // Twenty lists: the twenty-first is the one that is refused.
    let seed: Vec<(String, Json)> = (0..20)
        .map(|index| {
            stored(
                &format!("k{index}"),
                SELLER,
                &format!("List {index}"),
                "2026-09-01T10:00:00Z",
            )
        })
        .collect();
    let (full, _store, _transport) = store_state(seed);
    let full = router(full);
    let (status, answer, _) = post(&full, "save", json!({ "name": "One too many" }), SELLER).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answer={answer}");
    assert_eq!(answer["code"], json!("collection_limit"));

    // A list too long, a card too small, a name missing, an unknown verb.
    let many: Vec<Json> = (0..301)
        .map(|index| card_plain(&index.to_string()))
        .collect();
    let (status, answer, _) = post(
        &app,
        "save",
        json!({ "name": "Too long", "items": many }),
        SELLER,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answer={answer}");
    assert_eq!(answer["code"], json!("collection_items_limit"));

    let (status, answer, _) = post(
        &app,
        "save",
        json!({ "name": "Bad card", "items": [card_plain("11"), { "quantity": 2 }] }),
        SELLER,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answer={answer}");
    assert_eq!(answer["code"], json!("collection_item_invalid"));
    assert!(
        answer["error"].as_str().unwrap_or_default().contains("2"),
        "the refused card is named by its position: {answer}"
    );

    let (status, answer, _) = post(&app, "save", json!({ "items": [] }), SELLER).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answer={answer}");
    assert_eq!(answer["code"], json!("collection_name_required"));

    for action in ["rename", ""] {
        let (status, answer, _) = post(&app, action, json!({ "name": "A" }), SELLER).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "action={action} answer={answer}"
        );
        assert_eq!(answer["code"], json!("unknown_action"), "action={action}");
    }
    // A body of nothing is a save with no name, not an unknown verb.
    let (status, answer, _) = post(&app, "save", Json::Null, SELLER).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answer={answer}");
    assert_eq!(answer["code"], json!("collection_name_required"));
    let (status, answer, _) = call(
        &app,
        Method::GET,
        "/api/marketplace-portfolio-collections?action=save",
        None,
        Some(SELLER),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answer={answer}");
    assert_eq!(
        answer["code"],
        json!("unknown_action"),
        "a read does not write"
    );

    // Every other method, OPTIONS included, is the route's own 405.
    for method in [Method::OPTIONS, Method::PUT, Method::PATCH, Method::DELETE] {
        let (status, _answer, headers) = call(
            &app,
            method.clone(),
            "/api/marketplace-portfolio-collections",
            None,
            Some(SELLER),
        )
        .await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "method={method}");
        assert_eq!(
            headers.get("allow").map(String::as_str),
            Some("GET, POST"),
            "method={method}"
        );
        assert_eq!(
            headers.get("cache-control").map(String::as_str),
            Some("private, no-store"),
            "method={method}"
        );
    }

    // HEAD is the read it always is: axum routes it to the GET handler, as it does
    // on the history route.
    let (status, _answer, headers) = call(
        &app,
        Method::HEAD,
        "/api/marketplace-portfolio-collections",
        None,
        Some(SELLER),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get("cache-control").map(String::as_str),
        Some("private, no-store")
    );

    // A name the store keeps for its own markers is not a list id either: it answers
    // the 404 every other unknown id answers, and the store is never asked about it.
    for (action, body) in [
        ("save", json!({ "id": "__namespace__", "name": "Vault" })),
        ("delete", json!({ "id": "__namespace__" })),
    ] {
        transport.clear_requests();
        let (status, answer, _) = post(&app, action, body, SELLER).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "action={action} answer={answer}"
        );
        assert_eq!(
            answer["code"],
            json!("collection_not_found"),
            "action={action}"
        );
        assert_eq!(
            store_calls(&transport),
            Vec::<String>::new(),
            "a reserved id is refused before the store is asked: action={action}"
        );
    }
    // And the counter is not simply blind: a read of the very same app does ask it.
    transport.clear_requests();
    let (_status, _answer, _) = get(&app, Some(SELLER)).await;
    assert!(
        !store_calls(&transport).is_empty(),
        "an ordinary read reaches the store, so the empty answer above means a refusal"
    );

    // And without a token none of it is even reached.
    let (status, _answer, _) = call(
        &app,
        Method::POST,
        "/api/marketplace-portfolio-collections?action=save",
        Some(json!({ "name": "Anonymous" })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_delete_loses_the_list_and_its_line() {
    let (state, _store, _transport) = store_state(vec![
        document(
            "mine",
            SELLER,
            "Vault",
            "2026-09-01T10:00:00Z",
            vec![card("11", 1)],
        ),
        stored("other", SELLER, "Wishlist", "2026-09-02T10:00:00Z"),
    ]);
    let app = router(state);

    let (_status, before, _) = get(&app, Some(SELLER)).await;
    assert_eq!(before["segmentDefs"].as_array().map(Vec::len), Some(2));

    let (status, answer, _) = post(&app, "delete", json!({ "id": "mine" }), SELLER).await;
    assert_eq!(status, StatusCode::OK, "answer={answer}");
    assert_eq!(answer["saved"], Json::Null, "a delete writes no list");
    let collections = answer["collections"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(collections.len(), 1, "answer={answer}");
    assert_eq!(collections[0]["id"], json!("other"));
    assert_eq!(
        answer["segmentDefs"],
        json!([{ "key": "collection:other", "group": "collection", "label": "Wishlist" }])
    );
    assert_eq!(
        answer["days"].as_array().map(Vec::len),
        Some(0),
        "with no list holding a card there is no series to draw at all"
    );

    // A second delete of the same id is the same 404 a wrong id gets.
    let (status, answer, _) = post(&app, "delete", json!({ "id": "mine" }), SELLER).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answer={answer}");
    assert_eq!(answer["code"], json!("collection_not_found"));
    // An id of no shape at all is refused the same way, before a read.
    let (status, answer, _) = post(
        &app,
        "delete",
        json!({ "id": "a/path/that/cannot/be/a/document/id" }),
        SELLER,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answer={answer}");
}

// ---------------------------------------------------------------------------
// Atomicity: points 8 and 9 of DG-R012
// ---------------------------------------------------------------------------

/// How many times the route asked the store to commit.
fn commits(transport: &ScriptedTransport) -> usize {
    transport.requests_to(":commit").len()
}

/// The list names a seller's store holds, whatever order they were written in.
fn stored_names(store: &Arc<Mutex<Db>>) -> Vec<String> {
    let mut names: Vec<String> = store
        .lock()
        .unwrap()
        .docs
        .values()
        .map(|(document, _)| {
            document["fields"]["name"]["stringValue"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn a_replace_whose_document_is_gone_at_commit_is_not_written_back() {
    let (state, store, transport) = store_state(vec![stored(
        "mine",
        SELLER,
        "Vault",
        "2026-09-01T10:00:00Z",
    )]);
    let app = router(state);

    // Somebody deletes the list while this save's transaction is in flight: the
    // commit is aborted and the document is gone, so the retry reads nothing and the
    // write that would have resurrected it is never attempted.
    {
        let mut db = store.lock().unwrap();
        db.aborts = 1;
        db.vanish_on_abort = Some(format!("{COLLECTION}/mine"));
    }
    let (status, answer, _) = post(
        &app,
        "save",
        json!({ "id": "mine", "name": "Vault again" }),
        SELLER,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answer={answer}");
    assert_eq!(answer["code"], json!("collection_not_found"));
    assert_eq!(
        commits(&transport),
        1,
        "the retried attempt refused before it wrote"
    );
    assert!(
        store.lock().unwrap().document("mine").is_none(),
        "a save must not bring a deleted list back"
    );
}

#[tokio::test]
async fn a_contended_save_is_retried_and_lands_exactly_once() {
    let (state, store, transport) = store_state(Vec::new());
    let app = router(state);

    // The backend aborts the first commit for contention. That is the store's own
    // transient failure, so the write runs again from its reads and lands — once.
    store.lock().unwrap().aborts = 1;
    let (status, answer, _) = post(
        &app,
        "save",
        json!({ "name": "Drafts", "items": [card_plain("11")] }),
        SELLER,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "answer={answer}");
    assert_eq!(commits(&transport), 2, "one aborted, one landed");
    assert_eq!(names_of(&answer), ["Drafts"], "answer={answer}");
    let saved = answer["saved"].as_str().unwrap_or_default().to_string();
    assert!(
        store.lock().unwrap().document(&saved).is_some(),
        "the list that was written is the list that was answered"
    );
    assert_eq!(
        store.lock().unwrap().docs.len(),
        1,
        "a retry writes one document, not two"
    );
}

#[tokio::test]
async fn a_save_answers_from_its_own_read_and_never_lists_the_store_again() {
    let (state, _store, transport) = store_state(vec![stored(
        "mine",
        SELLER,
        "Vault",
        "2026-09-01T10:00:00Z",
    )]);
    let app = router(state);

    let (status, answer, _) = post(
        &app,
        "save",
        json!({ "name": "Drafts", "items": [card_plain("11")] }),
        SELLER,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "answer={answer}");
    assert_eq!(names_of(&answer), ["Vault", "Drafts"], "answer={answer}");
    // One read of the seller's lists, inside the transaction that wrote: a store
    // that failed on a second listing read could not turn a write that landed into
    // an error the client would retry, because there is no second read to fail.
    assert_eq!(
        transport.requests_to(":runQuery").len(),
        1,
        "answer={answer}"
    );
    assert_eq!(commits(&transport), 1);
    // And the state that answer described is the state the store holds: the
    // in-memory after-state of the transaction is what a read of it now says.
    let (_status, again, _) = get(&app, Some(SELLER)).await;
    assert_eq!(
        again["collections"], answer["collections"],
        "the answer of a write and the read of the store are the same lists"
    );
}

#[tokio::test]
async fn two_writes_that_would_each_fit_alone_do_not_both_land() {
    // Nineteen lists: each of these two saves fits alone, and both together do not.
    let seed: Vec<(String, Json)> = (0..19)
        .map(|index| {
            stored(
                &format!("k{index}"),
                SELLER,
                &format!("List {index}"),
                "2026-09-01T10:00:00Z",
            )
        })
        .collect();
    let (state, store, _transport) = store_state(seed);
    let app = router(state);
    let (first, second) = tokio::join!(
        post(&app, "save", json!({ "name": "Nineteen" }), SELLER),
        post(&app, "save", json!({ "name": "Twenty" }), SELLER),
    );
    let answers = [(first.0, first.1.clone()), (second.0, second.1.clone())];
    assert_eq!(
        answers
            .iter()
            .filter(|(status, _)| *status == StatusCode::OK)
            .count(),
        1,
        "answers={answers:?}"
    );
    let loser = &answers
        .iter()
        .find(|(status, _)| *status != StatusCode::OK)
        .expect("one of the two is refused")
        .1;
    assert_eq!(loser["code"], json!("collection_limit"), "loser={loser}");
    assert_eq!(
        stored_names(&store).len(),
        20,
        "the cap is the cap whatever the interleaving"
    );
}

#[tokio::test]
async fn two_creates_of_one_name_do_not_both_land() {
    let (state, store, _transport) = store_state(Vec::new());
    let app = router(state);
    let (first, second) = tokio::join!(
        post(&app, "save", json!({ "name": "Twin" }), SELLER),
        post(&app, "save", json!({ "name": "twin" }), SELLER),
    );
    let answers = [(first.0, first.1.clone()), (second.0, second.1.clone())];
    assert_eq!(
        answers
            .iter()
            .filter(|(status, _)| *status == StatusCode::OK)
            .count(),
        1,
        "answers={answers:?}"
    );
    let loser = &answers
        .iter()
        .find(|(status, _)| *status != StatusCode::OK)
        .expect("one of the two is refused")
        .1;
    assert_eq!(
        loser["code"],
        json!("collection_name_taken"),
        "loser={loser}"
    );
    assert_eq!(
        stored_names(&store).len(),
        1,
        "one name is one list, whichever of the two wrote it"
    );
}

#[tokio::test]
async fn a_delete_of_a_document_gone_at_commit_answers_404() {
    let (state, store, transport) = store_state(vec![document(
        "mine",
        SELLER,
        "Vault",
        "2026-09-01T10:00:00Z",
        vec![card("11", 1)],
    )]);
    let app = router(state);

    // The list is deleted elsewhere while this delete's transaction is in flight.
    // Its read is inside that transaction, so the retry finds nothing to delete and
    // answers the 404 rather than deleting a document that was never its seller's.
    {
        let mut db = store.lock().unwrap();
        db.aborts = 1;
        db.vanish_on_abort = Some(format!("{COLLECTION}/mine"));
    }
    let (status, answer, _) = post(&app, "delete", json!({ "id": "mine" }), SELLER).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answer={answer}");
    assert_eq!(answer["code"], json!("collection_not_found"));
    assert_eq!(commits(&transport), 1, "no delete was committed twice");
}
