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

/// Firestore documents by full name, as the typed wire shape.
type Store = Arc<Mutex<HashMap<String, Json>>>;

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
/// read back and a foreign document really is another seller's. The transport comes
/// back with it because a refusal that never reaches the store is only proven by
/// counting what the store was asked.
fn store_state(
    seed: Vec<(String, Json)>,
) -> (
    pokoin_accounts::state::DomainState,
    Store,
    Arc<ScriptedTransport>,
) {
    let store: Store = Arc::new(Mutex::new(seed.into_iter().collect()));
    let transport = ScriptedTransport::new();
    transport.on("/oauth", |_| {
        HttpResponse::json(200, json!({ "access_token": "t", "expires_in": 3600 }))
    });
    transport.on("/jwks", |_| jwks_response());

    // `:runQuery` — the seller's documents, in whatever order Firestore answers.
    let queries = store.clone();
    transport.on(":runQuery", move |request| {
        let asked: Json = serde_json::from_slice(&request.body).unwrap_or(Json::Null);
        let wanted = asked["structuredQuery"]["where"]["fieldFilter"]["value"]["stringValue"]
            .as_str()
            .unwrap_or_default();
        let documents: Vec<Json> = queries
            .lock()
            .unwrap()
            .values()
            .filter(|document| document["fields"]["uid"]["stringValue"].as_str() == Some(wanted))
            .map(|document| json!({ "document": document }))
            .collect();
        HttpResponse::json(200, Json::Array(documents))
    });

    // A document read: the REST API's 404, which the client answers with `None`.
    let reads = store.clone();
    transport.on_method("GET", BASE, move |request| {
        match reads.lock().unwrap().get(&key_of(&request.url)) {
            Some(document) => HttpResponse::json(200, document.clone()),
            None => HttpResponse::json(
                404,
                json!({ "error": { "code": 5, "message": "Document not found." } }),
            ),
        }
    });

    // `:commit` — apply every `update` and `delete` of the write.
    let writes = store.clone();
    transport.on(":commit", move |request| {
        let body: Json = serde_json::from_slice(&request.body).unwrap_or(Json::Null);
        let mut store = writes.lock().unwrap();
        let mut results = Vec::new();
        for write in body["writes"].as_array().cloned().unwrap_or_default() {
            if let Some(name) = write["delete"].as_str() {
                store.remove(&key_of(name));
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
            let key = key_of(&name);
            store.insert(
                key,
                json!({ "name": name, "fields": write["update"]["fields"] }),
            );
            results.push(json!({ "transformResults": {} }));
        }
        HttpResponse::json(200, json!({ "writeResults": results }))
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
    let written = store
        .lock()
        .unwrap()
        .get(&format!("{COLLECTION}/{saved}"))
        .cloned();
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
    let their_before = store.lock().unwrap()[&format!("{COLLECTION}/theirs")].clone();

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
        store.lock().unwrap()[&format!("{COLLECTION}/theirs")],
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
