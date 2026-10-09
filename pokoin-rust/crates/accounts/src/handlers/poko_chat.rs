//! `poko-chat` — the website Poko chat BFF (Hermes only).
//!
//! `POST /api/poko-chat { message, cards?, images?, sessionId?, pageContext? }`
//! produces a reply through the Poko service, resolves the cards Poko names
//! against the catalog, and stores the turn in
//! `poko_conversations/{uid}/events` so web clients sync across devices.
//! `GET /api/poko-chat?action=history&before=` pages that transcript.
//!
//! There are no local scripted replies: when the assistant is unreachable the
//! stored reply is the documented fallback and the response is `ok:false`.

use std::collections::HashSet;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value as Json};

use crate::domain::poko_chat::{
    attach_reply_cards, cards_context, clean_cards, clean_client_turn_id, clean_images,
    clean_page_context, clean_text, images_context, market_first_directive,
    photo_cards_from_identify, photo_search_context, resolve_hermes_chat_url, serialize_event,
    without_open_cards, EVENT_PAGE, HERMES_UNAVAILABLE, HERMES_UNAVAILABLE_ERROR,
    REPLY_CARDS_DIRECTIVE,
};
use crate::domain::personal_context::{build_personal_context, format_personal_intent, Overlay};
use crate::error::{ApiError, Result};
use crate::firestore::{
    new_document_id, Direction, DocData, Firestore, Query as FirestoreQuery, Value,
};
use crate::http::{send_with_retry, HttpRequest, HttpResponse, RetryPolicy};
use crate::rate_limit::RateLimitRequest;
use crate::state::DomainState;

use super::{json_with_cors, method_not_allowed, parse_body, require_claims, string_field};

const CONVERSATIONS: &str = "poko_conversations";
const EVENTS: &str = "events";
const CHAT_RATE_LIMIT: i64 = 20;
const CHAT_RATE_WINDOW_SECONDS: u64 = 60;
const IDENTIFY_PATH: &str = "/identify?catalog=pokemon_generic&multi=1&live=0&top_k=3";

fn scan_primary() -> String {
    std::env::var("SCAN_PRIMARY_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:18151".to_string())
}

fn scan_fallback() -> String {
    std::env::var("SCAN_FALLBACK_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:18150".to_string())
}

/// `chatRateLimited(req)` — 20 messages a minute per client IP, best effort.
async fn chat_rate_limited(state: &DomainState, headers: &HeaderMap) -> bool {
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let ip = forwarded.unwrap_or_else(|| "unknown".to_string());
    let verdict = state
        .limiter()
        .check(RateLimitRequest {
            scope: "poko-chat",
            identity: &ip,
            limit: CHAT_RATE_LIMIT,
            window_seconds: CHAT_RATE_WINDOW_SECONDS,
        })
        .await;
    !verdict.allowed
}

fn conversation_ref(firestore: &Firestore, uid: &str) -> crate::firestore::DocumentRef {
    firestore.doc(format!("{CONVERSATIONS}/{uid}"))
}

/// `readEventPage(ref, beforeId)`.
///
/// Node used `orderBy(createdAt asc).limitToLast(21)`. Firestore REST has no
/// `limitToLast`, so this reads the newest page DESC and reverses it, which is
/// the documented equivalence.
async fn read_event_page(
    firestore: &Firestore,
    uid: &str,
    before_id: &str,
) -> Result<(Vec<crate::firestore::Document>, bool)> {
    let collection = format!("{CONVERSATIONS}/{uid}/{EVENTS}");
    let mut query = FirestoreQuery::collection(collection.clone())
        .order_by("createdAt", Direction::Descending)
        .limit(EVENT_PAGE + 1);
    if !before_id.is_empty() {
        let cursor = firestore.doc(format!("{collection}/{before_id}")).get().await?;
        if cursor.is_none() {
            return Ok((Vec::new(), false));
        }
        query = query.start_after_exclusive(vec![Value::Reference(
            firestore.document_name(&format!("{collection}/{before_id}")),
        )]);
    }
    let mut documents = firestore.run_query(&query).await?;
    documents.reverse();
    let has_more = documents.len() as i64 > EVENT_PAGE;
    if has_more {
        documents.remove(0);
    }
    Ok((documents, has_more))
}

/// `appendTurn(...)` — one user row and one assistant row in a single batch,
/// stamped so the reply is strictly later than the question.
pub async fn append_turn(
    firestore: &Firestore,
    uid: &str,
    user_text: &str,
    cards: &[Json],
    images: &[String],
    reply: &str,
    reply_cards: &[Json],
    source: &str,
    user_at_ms: i64,
    reply_at_ms: i64,
    client_turn_id: &str,
) -> Result<Vec<Json>> {
    let asked_at = user_at_ms;
    let answered_at = reply_at_ms.max(asked_at + 1);
    let conversation = conversation_ref(firestore, uid);
    let user_id = new_document_id();
    let assistant_id = new_document_id();
    let turn_id = user_id.clone();
    let clean_reply_cards = clean_cards(Some(&Json::Array(reply_cards.to_vec())));

    let mut writes = conversation.set_writes(
        &DocData::new()
            .string("uid", uid.to_string())
            .server_timestamp("updatedAt"),
        true,
    )?;
    let mut user_writes = firestore
        .doc(format!("{CONVERSATIONS}/{uid}/{EVENTS}/{user_id}"))
        .set_writes(
            &DocData::new()
                .string("role", "user")
                .string("text", user_text.to_string())
                .set(
                    "cards",
                    Value::Array(cards.iter().map(Value::from_plain_json).collect()),
                )
                .set(
                    "images",
                    Value::Array(images.iter().map(|url| Value::String(url.clone())).collect()),
                )
                .string("turnId", turn_id.clone())
                .string("clientTurnId", client_turn_id.to_string())
                .timestamp("createdAt", asked_at),
            false,
        )?;
    writes.append(&mut user_writes);
    let mut assistant_writes = firestore
        .doc(format!("{CONVERSATIONS}/{uid}/{EVENTS}/{assistant_id}"))
        .set_writes(
            &DocData::new()
                .string("role", "assistant")
                .string("text", reply.to_string())
                .set(
                    "cards",
                    Value::Array(
                        clean_reply_cards
                            .iter()
                            .map(Value::from_plain_json)
                            .collect(),
                    ),
                )
                .set("images", Value::Array(Vec::new()))
                .string("source", source.to_string())
                .string("turnId", turn_id.clone())
                .timestamp("createdAt", answered_at),
            false,
        )?;
    writes.append(&mut assistant_writes);
    firestore.commit_batch(writes).await?;

    Ok(vec![
        json!({
            "id": user_id,
            "role": "user",
            "mine": true,
            "text": user_text,
            "cards": cards,
            "listings": cards,
            "images": images,
            "source": "",
            "turnId": turn_id,
            "clientTurnId": client_turn_id,
            "createdAt": iso_ms(asked_at),
        }),
        json!({
            "id": assistant_id,
            "role": "assistant",
            "mine": false,
            "text": reply,
            "cards": clean_reply_cards,
            "listings": clean_reply_cards,
            "images": [],
            "source": source,
            "turnId": turn_id,
            "clientTurnId": "",
            "createdAt": iso_ms(answered_at),
        }),
    ])
}

fn iso_ms(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// `loadPersonalForChat(uid, pageContext)` — best effort.
async fn load_personal_for_chat(
    state: &DomainState,
    uid: &str,
    page_context: &Json,
) -> (Option<Json>, String) {
    let Ok(db) = state.marketplace_db() else {
        return (None, String::new());
    };
    let firestore = state.firestore().ok();
    let overlay = Overlay {
        watchlist_ids: page_context
            .get("watchlistIds")
            .and_then(Json::as_array)
            .map(|values| {
                crate::domain::personal_context::normalize_card_ids(
                    values,
                    crate::domain::personal_context::WATCH_LIMIT,
                )
            }),
        cart: page_context
            .get("cart")
            .and_then(Json::as_array)
            .map(|values| crate::domain::personal_context::clean_cart_items(Some(&Json::Array(values.to_vec())))),
        desk: crate::domain::personal_context::clean_desk(Some(page_context)),
    };
    match build_personal_context(&db, firestore.as_ref(), uid, &overlay, true).await {
        Ok(personal) => {
            let intent = format_personal_intent(&personal);
            (Some(personal), intent)
        }
        Err(error) => {
            tracing::warn!(
                message = %error.message().chars().take(160).collect::<String>(),
                "poko-chat personal context skipped"
            );
            (None, String::new())
        }
    }
}

/// A minimal `multipart/form-data` body for the scan upload.
fn multipart_body(boundary: &str, bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"photo.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// `identifyOnePhoto(url, {primary, fallback})` — YOLO + Milo on every box.
async fn identify_one_photo(
    state: &DomainState,
    url: &str,
    primary: &str,
    fallback: &str,
) -> Vec<Json> {
    let transport = state.transport().clone();
    let image = match send_with_retry(
        &transport,
        HttpRequest::new("GET", url.to_string()),
        RetryPolicy::none(),
    )
    .await
    {
        Ok(response) if response.is_success() => response,
        _ => return Vec::new(),
    };
    let bytes = image.body;
    if bytes.len() < 32 || bytes.len() > 4_000_000 {
        return Vec::new();
    }
    if bytes[0] != 0xff || bytes[1] != 0xd8 {
        return Vec::new();
    }
    for base in [primary, fallback] {
        if base.is_empty() {
            continue;
        }
        let boundary = format!("----pokoin{}", new_document_id());
        let request = HttpRequest::new("POST", format!("{base}{IDENTIFY_PATH}"))
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={boundary}"),
            );
        let mut request = request;
        request.body = multipart_body(&boundary, &bytes);
        let response = match send_with_retry(&transport, request, RetryPolicy::none()).await {
            Ok(response) => response,
            Err(_) => continue,
        };
        let Some(data) = response.json_value() else {
            continue;
        };
        if !response.is_success()
            || data.get("busy").and_then(Json::as_bool).unwrap_or(false)
        {
            continue;
        }
        let cards = photo_cards_from_identify(&data);
        if !cards.is_empty() {
            return cards;
        }
    }
    Vec::new()
}

/// `identifyChatPhotos(urls)` — only our own R2 chat photos, at most four.
async fn identify_chat_photos(state: &DomainState, urls: &[String]) -> Vec<Json> {
    let own: Vec<String> = urls
        .iter()
        .filter(|url| crate::domain::poko_chat::is_user_photo_url(url))
        .take(4)
        .cloned()
        .collect();
    let mut found: Vec<Json> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for url in own {
        let cards = identify_one_photo(state, &url, &scan_primary(), &scan_fallback()).await;
        for card in cards {
            let key = {
                let id = card.get("cardId").and_then(Json::as_str).unwrap_or("");
                if !id.is_empty() {
                    id.to_string()
                } else {
                    format!(
                        "{}|{}|{}",
                        card.get("name").and_then(Json::as_str).unwrap_or(""),
                        card.get("setName").and_then(Json::as_str).unwrap_or(""),
                        card.get("number").and_then(Json::as_str).unwrap_or("")
                    )
                }
            };
            if !seen.insert(key) {
                continue;
            }
            found.push(card);
            if found.len() >= 8 {
                return found;
            }
        }
    }
    found
}

struct HermesReply {
    reply: String,
    cards: Vec<Json>,
}

/// `hermesReply(...)` — the enriched prompt goes to the Poko service.
#[allow(clippy::too_many_arguments)]
async fn hermes_reply(
    state: &DomainState,
    message: &str,
    cards: &[Json],
    images: &[String],
    photo_cards: &[Json],
    page_context: &Json,
    personal_intent: &str,
    personal: Option<&Json>,
    user_id: &str,
    session_id: &str,
    display_name: &str,
) -> Result<HermesReply> {
    let url = resolve_hermes_chat_url(
        std::env::var("POKO_CHAT_URL").ok().as_deref(),
        std::env::var("POKONTACT_SERVICE_URL").ok().as_deref(),
    );
    let token = crate::domain::poko_chat::hermes_token(
        std::env::var("POKO_API_TOKEN").ok().as_deref(),
        std::env::var("POKONTACT_SERVICE_TOKEN").ok().as_deref(),
    );
    if url.is_empty() || token.is_empty() {
        return Err(ApiError::unavailable(
            "Poko Hermes is not configured (POKONTACT_SERVICE_URL / token).",
        ));
    }

    let enriched = [
        market_first_directive(cards, page_context, photo_cards),
        personal_intent.to_string(),
        message.to_string(),
        photo_search_context(photo_cards),
        cards_context(cards),
        images_context(images),
        REPLY_CARDS_DIRECTIVE.to_string(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");

    let page_with_personal = match personal {
        Some(personal) => {
            let mut page = page_context.clone();
            if let Some(object) = page.as_object_mut() {
                object.insert("personal".into(), personal.clone());
            }
            page
        }
        None => page_context.clone(),
    };
    let payload = json!({
        "message": enriched,
        "userMessage": message,
        "userId": user_id,
        "sessionId": session_id,
        "user": { "id": user_id, "displayName": display_name },
        "pageContext": page_with_personal,
        "personalIntent": personal_intent,
    });
    let request = HttpRequest::new("POST", url)
        .header("authorization", format!("Bearer {token}"))
        .json(&payload)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let response = state
        .transport()
        .execute(request)
        .await
        .map_err(|error| ApiError::new(StatusCode::BAD_GATEWAY, error.to_string()))?;
    let data = response.json_value().unwrap_or(Json::Null);
    if !response.is_success() {
        let message = data
            .get("message")
            .or_else(|| data.get("error"))
            .and_then(Json::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("Poko chat failed ({})", response.status));
        let status = if (400..600).contains(&response.status) {
            StatusCode::from_u16(response.status).unwrap_or(StatusCode::BAD_GATEWAY)
        } else {
            StatusCode::BAD_GATEWAY
        };
        return Err(ApiError::new(status, message));
    }
    let reply = clean_text(
        data.get("reply")
            .or_else(|| data.get("text"))
            .and_then(Json::as_str)
            .unwrap_or(""),
        8000,
    );
    if reply.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "Poko returned an empty reply.",
        ));
    }
    Ok(HermesReply {
        reply,
        cards: clean_cards(data.get("cards")),
    })
}

/// `GET|POST /api/poko-chat`.
pub async fn poko_chat(
    State(state): State<DomainState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if method != Method::GET && method != Method::POST {
        return method_not_allowed("GET, POST");
    }
    match poko_chat_inner(&state, &query, &method, &headers, &body).await {
        Ok(response) => response,
        Err(error) => chat_error(error),
    }
}

async fn poko_chat_inner(
    state: &DomainState,
    query: &std::collections::HashMap<String, String>,
    method: &Method,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let firestore = state.firestore()?;

    if method == Method::GET {
        let action = {
            let raw = clean_text(
                query.get("action").map(String::as_str).unwrap_or("history"),
                40,
            );
            if raw.is_empty() {
                "history".to_string()
            } else {
                raw
            }
        };
        if action != "history" {
            return Err(ApiError::bad_request("Unknown action."));
        }
        let before = clean_text(
            query.get("before").map(String::as_str).unwrap_or(""),
            80,
        );
        let (documents, has_more) = read_event_page(&firestore, &claims.uid, &before).await?;
        return Ok(json_with_cors(
            StatusCode::OK,
            json!({
                "ok": true,
                "events": documents.iter().map(serialize_event).collect::<Vec<_>>(),
                "hasMore": has_more,
            }),
        ));
    }

    if chat_rate_limited(state, headers).await {
        return Ok(json_with_cors(
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "error": "Too many messages, please slow down." }),
        ));
    }

    let received_at_ms = state.clock().now().timestamp_millis();
    let body = parse_body(body);
    let client_turn_id = clean_client_turn_id(&string_field(&body, "clientTurnId"));
    let message = clean_text(&string_field(&body, "message"), 4000);
    let cards = clean_cards(body.get("cards"));
    let images = clean_images(body.get("images"));
    let page_context = clean_page_context(body.get("pageContext"), &cards, &images);
    if message.is_empty() && cards.is_empty() && images.is_empty() {
        return Err(ApiError::bad_request("message, cards, or images required"));
    }

    let photo_cards = if images.is_empty() {
        Vec::new()
    } else {
        identify_chat_photos(state, &images).await
    };

    // The prompt stands in for the user's turn when only attachments were sent.
    let prompt = if !message.is_empty() {
        message.clone()
    } else if !photo_cards.is_empty() {
        format!(
            "The attached photo was identified with multi-card search ({} printings). Quote Pokoin sold median, current asks, and liquidity for each one. Do not collapse the photo to a single card.",
            photo_cards.len()
        )
    } else if let Some(name) = cards.first().and_then(|card| card.get("name")).and_then(Json::as_str) {
        let card_id = cards
            .first()
            .and_then(|card| card.get("cardId"))
            .and_then(Json::as_str)
            .unwrap_or("");
        if card_id.is_empty() {
            format!("Quote Pokoin sold median, current asks, and liquidity for {name}. Lead with site analytics.")
        } else {
            format!("Quote Pokoin sold median, current asks, and liquidity for {name} (cardId={card_id}). Lead with site analytics.")
        }
    } else if !images.is_empty() {
        "What can you tell me about the attached photo? Multi-card search found no printings; do not invent cards.".to_string()
    } else {
        "Tell me about the attached card with Pokoin sold/ask/liquidity analytics first.".to_string()
    };
    let session_id = {
        let raw = clean_text(&string_field(&body, "sessionId"), 80);
        if raw.is_empty() {
            claims.uid.clone()
        } else {
            raw
        }
    };
    let user_visible = if message.is_empty() {
        prompt.clone()
    } else {
        message.clone()
    };

    let (personal, personal_intent) = load_personal_for_chat(state, &claims.uid, &page_context).await;

    // Hermes first: a failure is a documented fallback, never a local script.
    let (reply, mut reply_cards, source) = match hermes_reply(
        state,
        &prompt,
        &cards,
        &images,
        &photo_cards,
        &page_context,
        &personal_intent,
        personal.as_ref(),
        &claims.uid,
        &session_id,
        &clean_text(
            if claims.name.is_empty() {
                &claims.email
            } else {
                &claims.name
            },
            80,
        ),
    )
    .await
    {
        Ok(hermes) => {
            let hermes_cards = hermes.cards.clone();
            // Hermes' own tool cards win; otherwise resolve the cards Poko names.
            let (text, attached_cards) = match state.marketplace_db() {
                Ok(db) => {
                    attach_reply_cards(&db, &hermes.reply, &hermes_cards).await
                }
                Err(_) => (hermes.reply.clone(), Vec::new()),
            };
            let reply = if text.is_empty() {
                hermes.reply.clone()
            } else {
                text
            };
            let from_photo: Vec<Json> = photo_cards
                .iter()
                .filter(|card| {
                    !card
                        .get("cardId")
                        .and_then(Json::as_str)
                        .unwrap_or("")
                        .is_empty()
                })
                .cloned()
                .collect();
            let mut candidates = from_photo;
            if hermes_cards.is_empty() {
                candidates.extend(attached_cards);
            } else {
                candidates.extend(hermes_cards);
            }
            let mut kept =
                without_open_cards(&candidates, &page_context, &cards, hermes.cards.is_empty());
            kept.truncate(8);
            (reply, kept, "hermes".to_string())
        }
        Err(error) => {
            tracing::warn!(
                message = %error.message().chars().take(200).collect::<String>(),
                "poko-chat hermes failed"
            );
            (
                HERMES_UNAVAILABLE.to_string(),
                Vec::new(),
                "unavailable".to_string(),
            )
        }
    };
    // A resolved card list is never stored for the unavailable fallback.
    if source == "unavailable" {
        reply_cards.clear();
    }

    let mut events: Vec<Json> = Vec::new();
    match append_turn(
        &firestore,
        &claims.uid,
        &user_visible,
        &cards,
        &images,
        &reply,
        &reply_cards,
        &source,
        received_at_ms,
        state.clock().now().timestamp_millis(),
        &client_turn_id,
    )
    .await
    {
        Ok(rows) => events = rows,
        Err(error) => tracing::error!(
            message = %error.message().chars().take(200).collect::<String>(),
            "poko-chat persist failed"
        ),
    }

    if source == "unavailable" {
        return Ok(json_with_cors(
            StatusCode::OK,
            json!({
                "ok": false,
                "assistant": "poko",
                "persona": "Poko",
                "reply": reply,
                "source": source,
                "error": HERMES_UNAVAILABLE_ERROR,
                "events": events,
            }),
        ));
    }
    Ok(json_with_cors(
        StatusCode::OK,
        json!({
            "ok": true,
            "assistant": "poko",
            "persona": "Poko",
            "reply": reply,
            "cards": reply_cards,
            "source": source,
            "events": events,
        }),
    ))
}

fn chat_error(error: ApiError) -> Response {
    let status = error.status();
    if status.is_server_error() {
        tracing::error!(%error, "poko-chat");
    }
    let status = if status.is_client_error() || status.is_server_error() {
        status
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    json_with_cors(
        status,
        json!({
            "error": if error.message().is_empty() { "Poko chat failed." } else { error.message() }
        }),
    )
}

/// `Allow: GET, POST`.
pub async fn poko_chat_other() -> Response {
    method_not_allowed("GET, POST")
}

/// Keep the unused import checker honest.
#[allow(dead_code)]
fn _markers(_: Arc<()>, _: HttpResponse, _: &Map<String, Json>) {
    let _ = EVENT_PAGE;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_bodies_are_well_formed() {
        let body = multipart_body("BOUNDARY", &[0xff, 0xd8, 0x01]);
        let text = String::from_utf8_lossy(&body).to_string();
        assert!(text.starts_with("--BOUNDARY\r\n"));
        assert!(text.contains("name=\"file\"; filename=\"photo.jpg\""));
        assert!(text.contains("Content-Type: image/jpeg"));
        assert!(text.ends_with("\r\n--BOUNDARY--\r\n"));
        assert!(body.windows(3).any(|window| window == [0xff, 0xd8, 0x01]));
    }

    #[test]
    fn iso_ms_renders_milliseconds() {
        assert_eq!(iso_ms(1_791_417_600_000), "2026-10-08T00:00:00.000Z");
    }

    #[test]
    fn scan_urls_have_documented_defaults() {
        std::env::remove_var("SCAN_PRIMARY_URL");
        std::env::remove_var("SCAN_FALLBACK_URL");
        assert_eq!(scan_primary(), "http://127.0.0.1:18151");
        assert_eq!(scan_fallback(), "http://127.0.0.1:18150");
        std::env::set_var("SCAN_PRIMARY_URL", " http://scan:1 ");
        assert_eq!(scan_primary(), "http://scan:1");
        std::env::remove_var("SCAN_PRIMARY_URL");
    }

    #[test]
    fn the_identify_path_pins_the_multi_card_mode() {
        assert_eq!(
            IDENTIFY_PATH,
            "/identify?catalog=pokemon_generic&multi=1&live=0&top_k=3"
        );
    }
}
