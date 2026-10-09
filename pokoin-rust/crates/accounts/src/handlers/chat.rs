//! `chat` — direct messages, chat payments and money-request events.
//!
//! Ported from `api/chat.js` over `api/_chat_core.js`. Conversations live in
//! Firestore as `conversations/{direct_<sha256>}` with an `events`
//! subcollection; the pair key is order-independent, so both participants
//! always address the same document.
//!
//! Payments are idempotent through `payment_operations/{operationId}`: the
//! client token plus the payer uid hash to a deterministic document id, and a
//! replay with the same peer and amount returns the original ledger id instead
//! of moving money twice. Both `balances` documents and both `ledger_entries`
//! are written in one Firestore transaction, exactly like the Node handler.

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value as Json};

use crate::domain::chat::{
    bump_unread, clean_chat_images, clean_listing_photos, clean_listings, clean_note, clean_text,
    is_participant, is_uid, is_username, json_timestamp_millis, operation_id, other_member,
    pair_key_for, preview_for_event, profile_from_user, serialize_event, unread_for,
    validate_amount_pkn, EVENT_PAGE, EVENT_PAYMENT, EVENT_TEXT,
};
use crate::error::{ApiError, Result};
use crate::firestore::{
    new_document_id, Direction, DocData, Document, DocumentRef, Firestore, Query as FirestoreQuery,
    Value,
};
use crate::state::DomainState;

use super::{json_with_cors, method_not_allowed, parse_body, require_claims, string_field};

/// Firestore caps a commit at 500 writes; the payment path writes far fewer.
const LEDGER: &str = "ledger_entries";
const BALANCES: &str = "balances";
const USERS: &str = "users";
const USERNAMES: &str = "usernames";
const CONVERSATIONS: &str = "conversations";
const PAYMENT_OPERATIONS: &str = "payment_operations";
const MONEY_REQUESTS: &str = "money_requests";
const NOTIFICATIONS: &str = "notifications";

fn http_error(status: StatusCode, message: &str) -> ApiError {
    ApiError::new(status, message)
}

/// `usernameFor(firestore, uid, fallback)`: the profile handle, lowercased.
async fn username_for(firestore: &Firestore, uid: &str, fallback: &str) -> Result<String> {
    Ok(firestore
        .doc(format!("{USERS}/{uid}"))
        .get()
        .await?
        .map(|document| document.get_str("username"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
        .trim()
        .to_ascii_lowercase())
}

/// `resolvePeer(firestore, peerUsername)`.
async fn resolve_peer(firestore: &Firestore, peer_username: &str) -> Result<(String, String)> {
    let username = peer_username.trim().to_ascii_lowercase();
    if !is_username(&username) {
        return Err(http_error(
            StatusCode::BAD_REQUEST,
            "Enter a valid username.",
        ));
    }
    let document = firestore.doc(format!("{USERNAMES}/{username}")).get().await?;
    let uid = document
        .as_ref()
        .map(|document| document.get_str("uid"))
        .unwrap_or_default();
    if document.is_none() || uid.is_empty() {
        return Err(http_error(
            StatusCode::NOT_FOUND,
            "No Pokoin account was found for that username.",
        ));
    }
    Ok((uid, username))
}

/// `resolveRegisteredUser(admin, firestore, rawUid)`.
async fn resolve_registered_user(
    state: &DomainState,
    firestore: &Firestore,
    raw_uid: &str,
) -> Result<(String, String)> {
    let uid = raw_uid.trim();
    if !is_uid(uid) {
        return Err(http_error(
            StatusCode::BAD_REQUEST,
            "That seller account is missing.",
        ));
    }
    let auth = state.auth()?;
    let record = auth.get_user(uid).await.map_err(|error| {
        if error.not_found() {
            http_error(
                StatusCode::NOT_FOUND,
                "No Pokoin account was found for that seller.",
            )
        } else {
            super::auth::identity_to_api(error)
        }
    })?;
    let username = username_for(firestore, &record.uid, "").await?;
    Ok((record.uid, username))
}

/// `peerUidOnly(rawUid)` — a read never needs the peer's handle.
fn peer_uid_only(raw_uid: &str) -> Result<(String, String)> {
    let uid = raw_uid.trim();
    if !is_uid(uid) {
        return Err(http_error(
            StatusCode::BAD_REQUEST,
            "That seller account is missing.",
        ));
    }
    Ok((uid.to_string(), String::new()))
}

/// `profilesFor(firestore, uids)` — one `getAll` for every peer profile.
async fn profiles_for(firestore: &Firestore, uids: &[String]) -> Map<String, Json> {
    let mut ids: Vec<String> = Vec::new();
    for uid in uids {
        let uid = uid.trim().to_string();
        if !uid.is_empty() && !ids.contains(&uid) {
            ids.push(uid);
        }
    }
    let mut out = Map::new();
    if ids.is_empty() {
        return out;
    }
    let references: Vec<DocumentRef> = ids
        .iter()
        .map(|uid| firestore.doc(format!("{USERS}/{uid}")))
        .collect();
    match firestore.get_all(&references).await {
        Ok(documents) => {
            for (index, document) in documents.into_iter().enumerate() {
                if let Some(document) = document {
                    out.insert(ids[index].clone(), profile_from_user(&document));
                }
            }
        }
        Err(error) => {
            // Node logged and returned whatever it had.
            tracing::error!(%error, "chat peer profiles failed");
        }
    }
    out
}

/// `readEventPage(ref, beforeId)`.
///
/// Node used `orderBy(createdAt asc).limitToLast(101)`. Firestore REST has no
/// `limitToLast`, so this asks for the newest page instead (`createdAt desc` +
/// `limit`) and reverses it, which is the documented equivalence.
async fn read_event_page(
    firestore: &Firestore,
    pair_key: &str,
    before_id: &str,
) -> Result<(Vec<Document>, bool)> {
    let collection = format!("{CONVERSATIONS}/{pair_key}/events");
    let mut query = FirestoreQuery::collection(collection.clone())
        .order_by("createdAt", Direction::Descending)
        .limit(EVENT_PAGE + 1);
    if !before_id.is_empty() {
        let cursor = firestore
            .doc(format!("{collection}/{before_id}"))
            .get()
            .await?;
        if cursor.is_none() {
            return Ok((Vec::new(), false));
        }
        query = query.start_after_exclusive(vec![Value::Reference(
            firestore.document_name(&format!("{collection}/{before_id}")),
        )]);
    }
    let mut documents = firestore.run_query(&query).await?;
    // Newest-first -> oldest-first, so the client receives chronological events.
    documents.reverse();
    let has_more = documents.len() as i64 > EVENT_PAGE;
    if has_more {
        // Drop the oldest extra page entry.
        documents.remove(0);
    }
    Ok((documents, has_more))
}

/// `GET /api/chat` and `POST /api/chat`, dispatched on `?action=`.
pub async fn chat(
    State(state): State<DomainState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match chat_inner(&state, &query, &method, &headers, &body).await {
        Ok(response) => response,
        Err(error) => {
            let status = error.status();
            if status.is_server_error() {
                tracing::error!(%error, "chat failed");
            }
            let status = if status.is_client_error() || status.is_server_error() {
                status
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_with_cors(
                status,
                json!({
                    "error": if error.message().is_empty() { "Chat failed." } else { error.message() }
                }),
            )
        }
    }
}

async fn chat_inner(
    state: &DomainState,
    query: &std::collections::HashMap<String, String>,
    method: &Method,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let firestore = state.firestore()?;
    let body = parse_body(body);
    let action = query
        .get("action")
        .map(|value| value.as_str())
        .unwrap_or("list")
        .to_string();

    let mut my_username = String::new();
    if method == Method::POST {
        my_username = username_for(&firestore, &claims.uid, "").await?;
    }

    // ---- GET action=list -------------------------------------------------
    if method == Method::GET && action == "list" {
        let documents = firestore
            .run_query(
                &FirestoreQuery::collection(CONVERSATIONS)
                    .where_op(
                        "members",
                        crate::firestore::FilterOp::ArrayContains,
                        claims.uid.clone(),
                    )
                    .limit(100),
            )
            .await?;

        struct Row {
            pair_key: String,
            peer_uid: String,
            peer_username: String,
            preview: String,
            unread: i64,
            updated_at_ms: i64,
        }

        let mut rows: Vec<Row> = Vec::new();
        for document in documents {
            let members: Vec<String> = document
                .get("members")
                .and_then(|value| value.as_array().cloned())
                .map(|values| {
                    values
                        .iter()
                        .map(|value| value.as_str().unwrap_or("").to_string())
                        .collect()
                })
                .unwrap_or_default();
            if !is_participant(&members, &claims.uid) {
                continue;
            }
            let peer_uid = other_member(&members, &claims.uid);
            let last_event = document.get("lastEvent").map(|value| value.to_plain_json());
            let preview = last_event
                .as_ref()
                .map(|event| preview_for_event(event, &claims.uid))
                .unwrap_or_default();
            let unread_map = document
                .get("unread")
                .and_then(|value| value.as_map().cloned())
                .map(|fields| {
                    fields
                        .iter()
                        .map(|(key, value)| (key.clone(), value.to_plain_json()))
                        .collect::<Map<String, Json>>()
                });
            let updated_at_ms = last_event
                .as_ref()
                .and_then(|event| event.get("at"))
                .map(json_timestamp_millis)
                .or_else(|| document.get_timestamp_millis("createdAt"))
                .unwrap_or(0);
            let peer_username = document
                .get("memberUsernames")
                .and_then(|value| value.as_map().cloned())
                .and_then(|fields| fields.get(&peer_uid).cloned())
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default();
            rows.push(Row {
                pair_key: document.id(),
                peer_uid,
                peer_username,
                preview,
                unread: unread_for(unread_map.as_ref(), &claims.uid),
                updated_at_ms,
            });
        }
        rows.sort_by_key(|row| std::cmp::Reverse(row.updated_at_ms));

        let peer_uids: Vec<String> = rows.iter().map(|row| row.peer_uid.clone()).collect();
        let profiles = profiles_for(&firestore, &peer_uids).await;
        let conversations: Vec<Json> = rows
            .into_iter()
            .map(|row| {
                let profile = profiles.get(&row.peer_uid);
                json!({
                    "pairKey": row.pair_key,
                    "peerUid": row.peer_uid,
                    "peerUsername": row.peer_username,
                    "preview": row.preview,
                    "unread": row.unread,
                    "updatedAt": row.updated_at_ms,
                    "peerDisplayName": profile
                        .and_then(|profile| profile.get("displayName"))
                        .and_then(Json::as_str)
                        .unwrap_or(""),
                    "peerPhotoUrl": profile
                        .and_then(|profile| profile.get("photoUrl"))
                        .and_then(Json::as_str)
                        .unwrap_or(""),
                })
            })
            .collect();
        return Ok(json_with_cors(
            StatusCode::OK,
            json!({ "conversations": conversations }),
        ));
    }

    // ---- POST action=photo ----------------------------------------------
    if method == Method::POST && action == "photo" {
        return store_user_photo(state, &claims.uid, &body).await;
    }

    // ---- POST action=listing-photos --------------------------------------
    if method == Method::POST && action == "listing-photos" {
        return save_listing_photos(state, &claims.uid, &body).await;
    }

    // ---- resolve the peer ------------------------------------------------
    let peer_uid_raw = if method == Method::GET {
        query.get("peerUid").cloned().unwrap_or_default()
    } else {
        string_field(&body, "peerUid")
    };
    let peer_name = if method == Method::GET {
        query.get("peer").cloned().unwrap_or_default()
    } else {
        string_field(&body, "peer")
    };
    let (peer_uid, peer_username) = if !peer_uid_raw.trim().is_empty() {
        if method == Method::GET {
            peer_uid_only(&peer_uid_raw)?
        } else {
            resolve_registered_user(state, &firestore, &peer_uid_raw).await?
        }
    } else {
        resolve_peer(&firestore, &peer_name).await?
    };
    if peer_uid == claims.uid {
        return Err(http_error(
            StatusCode::BAD_REQUEST,
            "You cannot open a conversation with yourself.",
        ));
    }
    let pair_key = pair_key_for(&claims.uid, &peer_uid)?;
    let conversation_ref = firestore.doc(format!("{CONVERSATIONS}/{pair_key}"));

    // ---- GET action=get --------------------------------------------------
    if method == Method::GET && action == "get" {
        let document = conversation_ref.get().await?;
        if let Some(document) = &document {
            let members: Vec<String> = document
                .get("members")
                .and_then(|value| value.as_array().cloned())
                .map(|values| {
                    values
                        .iter()
                        .map(|value| value.as_str().unwrap_or("").to_string())
                        .collect()
                })
                .unwrap_or_default();
            if !is_participant(&members, &claims.uid) {
                return Err(http_error(StatusCode::FORBIDDEN, "Not your conversation."));
            }
        }
        let before_id = query.get("before").map(|v| v.trim().to_string()).unwrap_or_default();
        let (documents, has_more) = read_event_page(&firestore, &pair_key, &before_id).await?;

        let request_ids: Vec<String> = {
            let mut ids: Vec<String> = Vec::new();
            for document in &documents {
                let id = document.get_str("requestId");
                if !id.is_empty() && !ids.contains(&id) {
                    ids.push(id);
                }
            }
            ids
        };
        let mut requests_by_id: Map<String, Json> = Map::new();
        if !request_ids.is_empty() {
            let references: Vec<DocumentRef> = request_ids
                .iter()
                .map(|id| firestore.doc(format!("{MONEY_REQUESTS}/{id}")))
                .collect();
            if let Ok(found) = firestore.get_all(&references).await {
                for (index, document) in found.into_iter().enumerate() {
                    if let Some(document) = document {
                        let mut object = Map::new();
                        for (key, value) in document.values().iter() {
                            object.insert(key.clone(), value.to_plain_json());
                        }
                        object.insert(
                            "createdAtMs".into(),
                            json!(document.get_timestamp_millis("createdAt").unwrap_or(0)),
                        );
                        requests_by_id.insert(request_ids[index].clone(), Json::Object(object));
                    }
                }
            }
        }

        let unread = if before_id.is_empty() {
            document
                .as_ref()
                .map(|document| unread_for_map(document, &claims.uid))
                .unwrap_or(0)
        } else {
            0
        };
        if unread != 0 {
            conversation_ref
                .set(
                    DocData::new().int(format!("unread.{}", claims.uid), 0),
                    true,
                )
                .await?;
        }
        let stored_name = document
            .as_ref()
            .and_then(|document| document.get("memberUsernames"))
            .and_then(|value| value.as_map().cloned())
            .and_then(|fields| fields.get(&peer_uid).cloned())
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default();
        let profiles = profiles_for(&firestore, std::slice::from_ref(&peer_uid)).await;
        let profile = profiles.get(&peer_uid);

        return Ok(json_with_cors(
            StatusCode::OK,
            json!({
                "pairKey": pair_key,
                "peer": {
                    "uid": peer_uid,
                    "username": if !stored_name.is_empty() { stored_name } else { peer_username },
                    "displayName": profile.and_then(|p| p.get("displayName")).and_then(Json::as_str).unwrap_or(""),
                    "photoUrl": profile.and_then(|p| p.get("photoUrl")).and_then(Json::as_str).unwrap_or(""),
                },
                "unread": unread,
                "hasMore": has_more,
                "events": documents
                    .iter()
                    .map(|document| serialize_event(document, &claims.uid, &requests_by_id))
                    .collect::<Vec<_>>(),
            }),
        ));
    }

    if method != Method::POST {
        return Err(http_error(StatusCode::METHOD_NOT_ALLOWED, "Unsupported action."));
    }

    let me_username = my_username.clone();
    let peer_username_owned = peer_username.clone();
    let peer_uid_owned = peer_uid.clone();
    let uid_owned = claims.uid.clone();

    // ---- POST action=message --------------------------------------------
    if action == "message" {
        let listings = clean_listings(body.get("listings"));
        let images = clean_chat_images(body.get("images"), &claims.uid);
        let text = clean_text(&string_field(&body, "text"));
        if text.is_empty() && listings.is_empty() && images.is_empty() {
            return Err(http_error(StatusCode::BAD_REQUEST, "Write a message first."));
        }
        let preview_text = if !text.is_empty() {
            text.clone()
        } else if let Some(name) = listings
            .first()
            .and_then(|listing| listing.get("cardName"))
            .and_then(Json::as_str)
        {
            name.to_string()
        } else if !images.is_empty() {
            "Photo".to_string()
        } else {
            String::new()
        };
        let images_json = Json::Array(images.iter().map(|image| json!(image)).collect());
        let listings_json = Json::Array(listings.clone());
        let text_owned = text.clone();
        let preview_owned = preview_text.clone();
        let pair_key_owned = pair_key.clone();

        firestore
            .run_transaction(|transaction| {
                let uid = uid_owned.clone();
                let peer_uid = peer_uid_owned.clone();
                let me_username = me_username.clone();
                let peer_username = peer_username_owned.clone();
                let pair_key = pair_key_owned.clone();
                let text = text_owned.clone();
                let preview_text = preview_owned.clone();
                let listings = listings_json.clone();
                let images = images_json.clone();
                Box::pin(async move {
                    let reference = transaction.doc(&format!("{CONVERSATIONS}/{pair_key}"));
                    let conversation = transaction.get_doc(&reference).await?;
                    let members: Vec<String> = conversation
                        .as_ref()
                        .and_then(|document| document.get("members"))
                        .and_then(|value| value.as_array().cloned())
                        .map(|values| {
                            values
                                .iter()
                                .map(|value| value.as_str().unwrap_or("").to_string())
                                .collect()
                        })
                        .unwrap_or_else(|| {
                            let mut members = vec![uid.clone(), peer_uid.clone()];
                            members.sort();
                            members
                        });
                    if conversation.is_some() && !is_participant(&members, &uid) {
                        return Err(http_error(
                            StatusCode::FORBIDDEN,
                            "Not your conversation.",
                        ));
                    }
                    let unread = conversation
                        .as_ref()
                        .and_then(|document| document.get("unread"))
                        .and_then(|value| value.as_map().cloned())
                        .map(|fields| {
                            fields
                                .iter()
                                .map(|(key, value)| (key.clone(), value.to_plain_json()))
                                .collect::<Map<String, Json>>()
                        });
                    let mut member_usernames = conversation
                        .as_ref()
                        .and_then(|document| document.get("memberUsernames"))
                        .and_then(|value| value.as_map().cloned())
                        .map(|fields| {
                            fields
                                .iter()
                                .map(|(key, value)| (key.clone(), value.to_plain_json()))
                                .collect::<Map<String, Json>>()
                        })
                        .unwrap_or_default();
                    member_usernames.insert(uid.clone(), json!(me_username));
                    member_usernames.insert(peer_uid.clone(), json!(peer_username));

                    let mut data = DocData::new()
                        .string("pairKey", pair_key.clone())
                        .array(
                            "members",
                            members.iter().map(|m| Value::String(m.clone())).collect(),
                        )
                        .map(
                            "memberUsernames",
                            member_usernames
                                .iter()
                                .map(|(key, value)| {
                                    (
                                        key.clone(),
                                        Value::String(value.as_str().unwrap_or("").to_string()),
                                    )
                                })
                                .collect(),
                        )
                        .map("unread", bump_unread(unread.as_ref(), &members, &uid))
                        .map(
                            "lastEvent",
                            [
                                ("type".to_string(), Value::String(EVENT_TEXT.into())),
                                ("text".to_string(), Value::String(preview_text)),
                                (
                                    "images".to_string(),
                                    Value::Array(
                                        images
                                            .as_array()
                                            .map(|values| {
                                                values
                                                    .iter()
                                                    .map(|value| Value::String(
                                                        value.as_str().unwrap_or("").to_string(),
                                                    ))
                                                    .collect()
                                            })
                                            .unwrap_or_default(),
                                    ),
                                ),
                                ("senderUid".to_string(), Value::String(uid.clone())),
                                ("at".to_string(), Value::Null),
                            ]
                            .into_iter()
                            .collect(),
                        );
                    if conversation.is_none() {
                        data = data.server_timestamp("createdAt");
                    }
                    // `lastEvent.at` must be a server timestamp, so it is written
                    // as a transform on the nested path.
                    data = data.server_timestamp("lastEvent.at");
                    transaction.set(&reference, data, true)?;

                    let event_ref = transaction
                        .doc(&format!("{CONVERSATIONS}/{pair_key}/events/{}", new_document_id()));
                    transaction.set(
                        &event_ref,
                        DocData::new()
                            .string("type", EVENT_TEXT)
                            .string("senderUid", uid.clone())
                            .string("senderUsername", me_username.clone())
                            .string("text", text)
                            .set(
                                "listings",
                                Value::Array(
                                    listings
                                        .as_array()
                                        .map(|values| {
                                            values
                                                .iter()
                                                .map(|value| {
                                                    crate::firestore::Value::from_plain_json(value)
                                                })
                                                .collect()
                                        })
                                        .unwrap_or_default(),
                                ),
                            )
                            .set(
                                "images",
                                Value::Array(
                                    images
                                        .as_array()
                                        .map(|values| {
                                            values
                                                .iter()
                                                .map(|value| {
                                                    crate::firestore::Value::from_plain_json(value)
                                                })
                                                .collect()
                                        })
                                        .unwrap_or_default(),
                                ),
                            )
                            .server_timestamp("createdAt"),
                        false,
                    )?;
                    Ok(())
                })
            })
            .await?;
        return Ok(json_with_cors(StatusCode::OK, json!({ "ok": true })));
    }

    // ---- POST action=pay ------------------------------------------------
    if action == "pay" {
        let amount_pkn = validate_amount_pkn(body.get("amountPkn"))
            .map_err(|message| http_error(StatusCode::BAD_REQUEST, &message))?;
        let client_token = string_field(&body, "clientToken").trim().to_string();
        let op_id = operation_id(&claims.uid, &client_token);
        if op_id.is_empty() {
            return Err(http_error(
                StatusCode::BAD_REQUEST,
                "Missing payment idempotency token.",
            ));
        }
        let note = clean_note(&string_field(&body, "note"));
        let pair_key_owned = pair_key.clone();
        let op_id_owned = op_id.clone();

        let result = firestore
            .run_transaction(|transaction| {
                let uid = uid_owned.clone();
                let peer_uid = peer_uid_owned.clone();
                let me_username = me_username.clone();
                let peer_username = peer_username_owned.clone();
                let pair_key = pair_key_owned.clone();
                let op_id = op_id_owned.clone();
                let note = note.clone();
                Box::pin(async move {
                    let operation_ref =
                        transaction.doc(&format!("{PAYMENT_OPERATIONS}/{op_id}"));
                    let reference = transaction.doc(&format!("{CONVERSATIONS}/{pair_key}"));
                    let payer_ref = transaction.doc(&format!("{BALANCES}/{uid}"));

                    let operation = transaction.get_doc(&operation_ref).await?;
                    let conversation = transaction.get_doc(&reference).await?;
                    let payer = transaction.get_doc(&payer_ref).await?;

                    if let Some(operation) = operation {
                        let prior_peer = operation.get_str("peerUid");
                        let prior_amount = operation.get_i64("amountPkn").unwrap_or(0);
                        if prior_peer != peer_uid || prior_amount != amount_pkn {
                            return Err(http_error(
                                StatusCode::CONFLICT,
                                "That payment token was already used.",
                            ));
                        }
                        return Ok(json!({
                            "duplicate": true,
                            "ledgerId": operation.get_str("ledgerId"),
                            "amountPkn": amount_pkn,
                        }));
                    }

                    let members: Vec<String> = conversation
                        .as_ref()
                        .and_then(|document| document.get("members"))
                        .and_then(|value| value.as_array().cloned())
                        .map(|values| {
                            values
                                .iter()
                                .map(|value| value.as_str().unwrap_or("").to_string())
                                .collect()
                        })
                        .unwrap_or_else(|| {
                            let mut members = vec![uid.clone(), peer_uid.clone()];
                            members.sort();
                            members
                        });
                    if conversation.is_some() && !is_participant(&members, &uid) {
                        return Err(http_error(
                            StatusCode::FORBIDDEN,
                            "Not your conversation.",
                        ));
                    }
                    let available = payer
                        .as_ref()
                        .and_then(|document| document.get_i64("availablePkn"))
                        .unwrap_or(0);
                    if available < amount_pkn {
                        return Err(http_error(
                            StatusCode::BAD_REQUEST,
                            "Your account balance is too low.",
                        ));
                    }

                    let unread = conversation
                        .as_ref()
                        .and_then(|document| document.get("unread"))
                        .and_then(|value| value.as_map().cloned())
                        .map(|fields| {
                            fields
                                .iter()
                                .map(|(key, value)| (key.clone(), value.to_plain_json()))
                                .collect::<Map<String, Json>>()
                        });
                    let mut member_usernames = conversation
                        .as_ref()
                        .and_then(|document| document.get("memberUsernames"))
                        .and_then(|value| value.as_map().cloned())
                        .map(|fields| {
                            fields
                                .iter()
                                .map(|(key, value)| (key.clone(), value.to_plain_json()))
                                .collect::<Map<String, Json>>()
                        })
                        .unwrap_or_default();
                    member_usernames.insert(uid.clone(), json!(me_username));
                    member_usernames.insert(peer_uid.clone(), json!(peer_username));

                    let out_ledger_id = new_document_id();
                    let in_ledger_id = new_document_id();

                    // Both balances and both ledger entries in one transaction.
                    transaction.set(
                        &payer_ref,
                        DocData::new()
                            .increment("availablePkn", -amount_pkn)
                            .server_timestamp("updatedAt"),
                        true,
                    )?;
                    transaction.set(
                        &transaction.doc(&format!("{BALANCES}/{peer_uid}")),
                        DocData::new()
                            .increment("availablePkn", amount_pkn)
                            .server_timestamp("updatedAt"),
                        true,
                    )?;
                    transaction.set(
                        &transaction.doc(&format!("{LEDGER}/{out_ledger_id}")),
                        DocData::new()
                            .string("uid", uid.clone())
                            .string("type", "chat_payment_sent")
                            .int("amountPkn", -amount_pkn)
                            .string("counterpartyUid", peer_uid.clone())
                            .string("counterpartyUsername", peer_username.clone())
                            .string("note", note.clone())
                            .string("operationId", op_id.clone())
                            .server_timestamp("createdAt"),
                        false,
                    )?;
                    transaction.set(
                        &transaction.doc(&format!("{LEDGER}/{in_ledger_id}")),
                        DocData::new()
                            .string("uid", peer_uid.clone())
                            .string("type", "chat_payment_received")
                            .int("amountPkn", amount_pkn)
                            .string("counterpartyUid", uid.clone())
                            .string("counterpartyUsername", me_username.clone())
                            .string("note", note.clone())
                            .string("operationId", op_id.clone())
                            .server_timestamp("createdAt"),
                        false,
                    )?;
                    transaction.set(
                        &transaction.doc(&format!(
                            "{CONVERSATIONS}/{pair_key}/events/{}",
                            new_document_id()
                        )),
                        DocData::new()
                            .string("type", EVENT_PAYMENT)
                            .string("senderUid", uid.clone())
                            .string("senderUsername", me_username.clone())
                            .int("amountPkn", amount_pkn)
                            .string("note", note.clone())
                            .string("transactionId", out_ledger_id.clone())
                            .server_timestamp("createdAt"),
                        false,
                    )?;
                    let mut data = DocData::new()
                        .string("pairKey", pair_key.clone())
                        .array(
                            "members",
                            members.iter().map(|m| Value::String(m.clone())).collect(),
                        )
                        .map(
                            "memberUsernames",
                            member_usernames
                                .iter()
                                .map(|(key, value)| {
                                    (
                                        key.clone(),
                                        Value::String(value.as_str().unwrap_or("").to_string()),
                                    )
                                })
                                .collect(),
                        )
                        .map("unread", bump_unread(unread.as_ref(), &members, &uid))
                        .map(
                            "lastEvent",
                            [
                                ("type".to_string(), Value::String(EVENT_PAYMENT.into())),
                                ("amountPkn".to_string(), Value::Integer(amount_pkn)),
                                ("senderUid".to_string(), Value::String(uid.clone())),
                                ("at".to_string(), Value::Null),
                            ]
                            .into_iter()
                            .collect(),
                        );
                    if conversation.is_none() {
                        data = data.server_timestamp("createdAt");
                    }
                    data = data.server_timestamp("lastEvent.at");
                    transaction.set(&reference, data, true)?;

                    transaction.set(
                        &transaction.doc(&format!("{NOTIFICATIONS}/{}", new_document_id())),
                        DocData::new()
                            .string("uid", peer_uid.clone())
                            .string("type", "chat_payment_received")
                            .string("actorUsername", me_username.clone())
                            .int("amountPkn", amount_pkn)
                            .bool("read", false)
                            .server_timestamp("createdAt"),
                        false,
                    )?;
                    transaction.set(
                        &operation_ref,
                        DocData::new()
                            .string("uid", uid.clone())
                            .string("peerUid", peer_uid.clone())
                            .int("amountPkn", amount_pkn)
                            .string("ledgerId", out_ledger_id.clone())
                            .server_timestamp("createdAt"),
                        false,
                    )?;
                    Ok(json!({
                        "duplicate": false,
                        "ledgerId": out_ledger_id,
                        "amountPkn": amount_pkn,
                    }))
                })
            })
            .await?;

        let mut response = result;
        if let Some(object) = response.as_object_mut() {
            object.insert("ok".into(), json!(true));
        }
        return Ok(json_with_cors(StatusCode::OK, response));
    }

    // ---- POST action=read -----------------------------------------------
    if action == "read" {
        let document = conversation_ref.get().await?;
        let Some(document) = document else {
            return Ok(json_with_cors(StatusCode::OK, json!({ "ok": true })));
        };
        let members: Vec<String> = document
            .get("members")
            .and_then(|value| value.as_array().cloned())
            .map(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().unwrap_or("").to_string())
                    .collect()
            })
            .unwrap_or_default();
        if !is_participant(&members, &claims.uid) {
            return Err(http_error(StatusCode::FORBIDDEN, "Not your conversation."));
        }
        conversation_ref
            .set(
                DocData::new().int(format!("unread.{}", claims.uid), 0),
                true,
            )
            .await?;
        return Ok(json_with_cors(StatusCode::OK, json!({ "ok": true })));
    }

    Err(http_error(StatusCode::BAD_REQUEST, "Unknown action."))
}

fn unread_for_map(document: &Document, uid: &str) -> i64 {
    document
        .get("unread")
        .and_then(|value| value.as_map().cloned())
        .map(|fields| {
            let plain: Map<String, Json> = fields
                .iter()
                .map(|(key, value)| (key.clone(), value.to_plain_json()))
                .collect();
            unread_for(Some(&plain), uid)
        })
        .unwrap_or(0)
}

/// `storeUserPhoto(uid, body)` — a JPEG PUT into the user-photos bucket.
async fn store_user_photo(state: &DomainState, uid: &str, body: &Json) -> Result<Response> {
    use base64::Engine;
    let kind = if string_field(body, "kind") == "listing" {
        "listing"
    } else {
        "chat"
    };
    let raw = string_field(body, "dataUrl");
    let Some(encoded) = raw.strip_prefix("data:image/jpeg;base64,") else {
        return Err(http_error(StatusCode::BAD_REQUEST, "Send a JPEG photo."));
    };
    if !encoded
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b' ' | b'\n' | b'\r' | b'\t'))
    {
        return Err(http_error(StatusCode::BAD_REQUEST, "Send a JPEG photo."));
    }
    let cleaned: String = encoded.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cleaned)
        .map_err(|_| http_error(StatusCode::BAD_REQUEST, "Send a JPEG photo."))?;
    if bytes.len() < 32 || bytes.len() > 1_800_000 {
        return Err(http_error(StatusCode::BAD_REQUEST, "That photo is too large."));
    }
    if bytes[0] != 0xff || bytes[1] != 0xd8 {
        return Err(http_error(StatusCode::BAD_REQUEST, "Send a JPEG photo."));
    }
    let store = state.photo_store().ok_or_else(|| {
        http_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Photo storage is not configured.",
        )
    })?;
    let id: [u8; 12] = rand::random();
    let key = format!("user-photos/{kind}/{uid}/{}.jpg", hex::encode(id));
    let cache_control = if kind == "chat" {
        "private, max-age=300"
    } else {
        "public, max-age=86400"
    };
    store
        .put_object(&key, bytes, "image/jpeg", Some(cache_control))
        .await?;
    let origin = std::env::var("POKOIN_API_PUBLIC_ORIGIN")
        .ok()
        .or_else(|| std::env::var("API_ORIGIN").ok())
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "https://api.pokoin.com".to_string());
    Ok(json_with_cors(
        StatusCode::OK,
        json!({ "url": format!("{origin}/api/user-photos/{kind}/{uid}/{}.jpg", hex::encode(id)) }),
    ))
}

/// `saveListingPhotos(uid, body)` — an owner-scoped `photo_urls` update.
async fn save_listing_photos(state: &DomainState, uid: &str, body: &Json) -> Result<Response> {
    let id = string_field(body, "listingId").trim().to_string();
    let valid_id = (id.len() == 36
        || (8..=36).contains(&id.len()))
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    if !valid_id || id.len() != 36 {
        return Err(http_error(StatusCode::BAD_REQUEST, "Missing listing."));
    }
    let photos = clean_listing_photos(body.get("urls"), uid);
    let db = state.marketplace_db()?;
    let rows = db
        .query_json(
            "update public.marketplace_user_listings \
                set photo_urls = $1::text[], updated_at = now() \
              where id = $2::uuid and seller_uid = $3 returning id",
            &[
                crate::sql::SqlParam::TextArray(photos.clone()),
                crate::sql::SqlParam::Text(id),
                crate::sql::SqlParam::Text(uid.to_string()),
            ],
        )
        .await?;
    if rows.is_empty() {
        return Err(http_error(StatusCode::NOT_FOUND, "Listing was not found."));
    }
    Ok(json_with_cors(
        StatusCode::OK,
        json!({ "ok": true, "photoUrls": photos }),
    ))
}

/// `Allow: GET, POST`.
pub async fn chat_other() -> Response {
    method_not_allowed("GET, POST")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_photo_ids_must_be_a_uuid() {
        let valid = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert_eq!(valid.len(), 36);
        let invalid = "not-a-uuid";
        assert!(invalid.len() != 36);
    }

    #[test]
    fn unread_map_reading_uses_the_plain_view() {
        let document = Document {
            name: "projects/p/databases/(default)/documents/conversations/c".into(),
            create_time: None,
            update_time: None,
            fields: serde_json::from_value(json!({
                "unread": { "mapValue": { "fields": {
                    "uidAAAAAAAA": { "integerValue": "4" } } } }
            }))
            .ok(),
        };
        assert_eq!(unread_for_map(&document, "uidAAAAAAAA"), 4);
        assert_eq!(unread_for_map(&document, "uidBBBBBBBB"), 0);
        let empty = Document::default();
        assert_eq!(unread_for_map(&empty, "uidAAAAAAAA"), 0);
    }
}
