//! Chat core — a port of `api/_chat_core.js` plus the `effectiveStatus` helper
//! from `api/_money_request_core.js`.
//!
//! Everything here is pure: pair keys, participant checks, text/listing/photo
//! cleaning, unread bookkeeping, event previews and the payment idempotency id.
//! The Firestore/R2 orchestration lives in `handlers::chat`.

use serde_json::{json, Map, Number, Value as Json};
use sha2::{Digest, Sha256};

use crate::error::{ApiError, Result};
use crate::firestore::{OrderedMap, Value};

pub const EVENT_TEXT: &str = "text";
pub const EVENT_MONEY_REQUEST: &str = "money_request";
pub const EVENT_PAYMENT: &str = "payment";
pub const EVENT_SYSTEM: &str = "system";

pub const TEXT_MAX: usize = 1000;
pub const NOTE_MAX: usize = 140;
pub const MAX_CHAT_PHOTOS: usize = 4;
pub const MAX_LISTING_PHOTOS: usize = 2;
pub const MAX_LISTINGS: usize = 4;
pub const EVENT_PAGE: i64 = 100;

/// Money-request lifecycle (from `_money_request_core.js`).
pub const STATUS_PENDING: &str = "pending";
pub const STATUS_PAID: &str = "paid";
pub const STATUS_DECLINED: &str = "declined";
pub const STATUS_CANCELLED: &str = "cancelled";
pub const STATUS_EXPIRED: &str = "expired";
pub const MONEY_REQUEST_TTL_MS: i64 = 14 * 24 * 60 * 60 * 1000;

/// `USERNAME_RE = /^[a-z0-9]{3,32}$/`.
pub fn is_username(value: &str) -> bool {
    (3..=32).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

/// `^[A-Za-z0-9]{8,128}$` — the Firebase uid shape the chat routes accept.
pub fn is_uid(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// `pairKeyFor(uidA, uidB)` — sorted members, sha256 of their JSON array.
pub fn pair_key_for(uid_a: &str, uid_b: &str) -> Result<String> {
    let mut members = [uid_a.trim().to_string(), uid_b.trim().to_string()];
    members.sort();
    if members[0].is_empty() || members[1].is_empty() {
        return Err(ApiError::internal("Two participants are required."));
    }
    if members[0] == members[1] {
        return Err(ApiError::internal(
            "A conversation needs two different users.",
        ));
    }
    let mut hasher = Sha256::new();
    // `JSON.stringify(members)` for two ASCII strings.
    hasher.update(format!("[\"{}\",\"{}\"]", members[0], members[1]).as_bytes());
    Ok(format!("direct_{}", hex::encode(hasher.finalize())))
}

pub fn is_participant(members: &[String], uid: &str) -> bool {
    members.iter().any(|member| member == uid)
}

pub fn other_member(members: &[String], uid: &str) -> String {
    members
        .iter()
        .find(|member| member.as_str() != uid)
        .cloned()
        .unwrap_or_default()
}

/// `cleanText(text)`: collapse whitespace, trim, cap at 1000.
pub fn clean_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(TEXT_MAX)
        .collect()
}

/// `cleanNote(note)`: collapse whitespace, trim, cap at 140.
pub fn clean_note(note: &str) -> String {
    note.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(NOTE_MAX)
        .collect()
}

/// `validateAmountPkn`: an integer in 1..=1_000_000_000.
pub fn validate_amount_pkn(value: Option<&Json>) -> std::result::Result<i64, String> {
    let amount = value
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().filter(|number| number.fract() == 0.0).map(|n| n as i64))
        })
        .unwrap_or(0);
    if amount <= 0 {
        return Err("Enter a whole PKN amount greater than zero.".into());
    }
    if amount > 1_000_000_000 {
        return Err("That amount is too large.".into());
    }
    Ok(amount)
}

/// `bumpUnread(unread, members, senderUid)` — the sender keeps their count, every
/// other member gains one.
pub fn bump_unread(
    unread: Option<&Map<String, Json>>,
    members: &[String],
    sender_uid: &str,
) -> OrderedMap<Value> {
    let mut next: OrderedMap<Value> = OrderedMap::new();
    // Preserve any members already present, then update the current roster.
    if let Some(unread) = unread {
        for (key, value) in unread {
            next.insert(key.clone(), Value::Integer(value.as_i64().unwrap_or(0)));
        }
    }
    for member in members {
        let current = unread
            .and_then(|unread| unread.get(member))
            .and_then(Json::as_i64)
            .unwrap_or(0);
        let value = if member == sender_uid {
            current
        } else {
            current + 1
        };
        next.insert(member.clone(), Value::Integer(value));
    }
    next
}

pub fn unread_for(unread: Option<&Map<String, Json>>, uid: &str) -> i64 {
    unread
        .and_then(|unread| unread.get(uid))
        .and_then(Json::as_i64)
        .unwrap_or(0)
}

/// `cleanImageUrl`: a site-absolute path or an https URL, never `..`/`\`.
pub fn clean_image_url(value: &str) -> String {
    let raw = value.trim();
    if raw.is_empty() || raw.len() > 400 || raw.contains('\\') || raw.contains("..") {
        return String::new();
    }
    if raw.starts_with('/') && !raw.starts_with("//") {
        return raw.to_string();
    }
    match raw.strip_prefix("https://") {
        Some(_) if raw.contains("://") => raw.to_string(),
        _ => String::new(),
    }
}

/// `cleanListing(raw)` — the public listing card attached to a chat message.
pub fn clean_listing(raw: &Json) -> Option<Json> {
    let card_name: String = raw
        .get("cardName")
        .and_then(Json::as_str)
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(120)
        .collect();
    if card_name.is_empty() {
        return None;
    }
    let seller = raw
        .get("seller")
        .and_then(Json::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let image_url = clean_image_url(raw.get("imageUrl").and_then(Json::as_str).unwrap_or(""));
    let path = {
        let raw_path = raw.get("path").and_then(Json::as_str).unwrap_or("");
        if raw_path.starts_with('/') && !raw_path.starts_with("//") {
            raw_path.chars().take(240).collect::<String>()
        } else {
            String::new()
        }
    };
    let price = raw.get("pricePkn").and_then(Json::as_f64);
    let qty = raw.get("qty").and_then(Json::as_f64);
    let seller_uid = raw
        .get("sellerUid")
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_string();
    Some(json!({
        "kind": if raw.get("kind").and_then(Json::as_str) == Some("card") { "card" } else { "listing" },
        "listingId": raw.get("listingId").and_then(Json::as_str).unwrap_or("").chars().take(80).collect::<String>(),
        "cardId": raw.get("cardId").and_then(Json::as_str).unwrap_or("").chars().take(40).collect::<String>(),
        "seller": if is_username(&seller) { seller } else { String::new() },
        "sellerUid": if is_uid(&seller_uid) { seller_uid } else { String::new() },
        "cardName": card_name,
        "setName": raw.get("setName").and_then(Json::as_str).unwrap_or("")
            .split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect::<String>(),
        "imageUrl": image_url,
        "path": path,
        "pricePkn": price
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value.round().min(1_000_000_000.0) as i64)
            .unwrap_or(0),
        "qty": qty
            .filter(|value| value.is_finite() && *value >= 1.0)
            .map(|value| (value.trunc() as i64).min(99))
            .unwrap_or(1),
    }))
}

pub fn clean_listings(value: Option<&Json>) -> Vec<Json> {
    let Some(rows) = value.and_then(Json::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in rows {
        if let Some(clean) = clean_listing(row) {
            out.push(clean);
            if out.len() >= MAX_LISTINGS {
                break;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

/// `photoPath`: normalise a stored photo reference to a `/user-photos/...` path.
pub fn photo_path(value: &str) -> String {
    let raw = value.trim();
    if raw.is_empty() || raw.contains("..") || raw.contains('\\') {
        return String::new();
    }
    if let Some(rest) = raw.strip_prefix("/card-images/user-photos/") {
        return format!("/user-photos/{rest}");
    }
    if raw.starts_with("/api/user-photos/") {
        return raw.trim_start_matches("/api").to_string();
    }
    if let Some(rest) = raw.strip_prefix("https://") {
        let (authority, path) = match rest.find('/') {
            Some(index) => (&rest[..index], &rest[index..]),
            None => (rest, "/"),
        };
        let host = authority
            .split(':')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if host.ends_with(".r2.dev") && path.starts_with("/user-photos/") {
            return path.to_string();
        }
        if (host == "api.pokoin.com" || host.ends_with(".pokoin.com"))
            && path.starts_with("/api/user-photos/")
        {
            return path.trim_start_matches("/api").to_string();
        }
    }
    String::new()
}

/// Rewrite legacy public r2.dev chat/listing URLs onto the auth-aware API proxy.
pub fn public_photo_proxy_url(value: &str, api_origin: &str) -> String {
    let path = photo_path(value);
    if !path.starts_with("/user-photos/") {
        return value.trim().to_string();
    }
    format!("{}/api{path}", api_origin.trim_end_matches('/'))
}

/// `cleanOwnedPhotos`: only the caller's own `user-photos/{kind}/{uid}/…jpg`.
pub fn clean_owned_photos(
    value: Option<&Json>,
    uid: &str,
    kind: &str,
    limit: usize,
) -> Vec<String> {
    let owner = uid.trim();
    if !is_uid(owner) {
        return Vec::new();
    }
    let prefix = format!("/user-photos/{kind}/{owner}/");
    let Some(items) = value.and_then(Json::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let raw = item.as_str().unwrap_or("");
        let path = photo_path(raw);
        if !path.starts_with(&prefix) || !path.ends_with(".jpg") {
            continue;
        }
        out.push(raw.trim().chars().take(400).collect::<String>());
        if out.len() >= limit {
            break;
        }
    }
    out
}

pub fn clean_chat_images(value: Option<&Json>, uid: &str) -> Vec<String> {
    clean_owned_photos(value, uid, "chat", MAX_CHAT_PHOTOS)
}

pub fn clean_listing_photos(value: Option<&Json>, uid: &str) -> Vec<String> {
    clean_owned_photos(value, uid, "listing", MAX_LISTING_PHOTOS)
}

// ---------------------------------------------------------------------------
// Previews and idempotency
// ---------------------------------------------------------------------------

/// `previewForEvent(event, viewerUid)` — the conversation-list one-liner.
pub fn preview_for_event(event: &Json, viewer_uid: &str) -> String {
    let amount = format!(
        "{} PKN",
        event.get("amountPkn").and_then(Json::as_i64).unwrap_or(0)
    );
    let mine = event.get("senderUid").and_then(Json::as_str) == Some(viewer_uid);
    let event_type = event.get("type").and_then(Json::as_str).unwrap_or("");
    if event_type == EVENT_TEXT {
        let text = clean_text(event.get("text").and_then(Json::as_str).unwrap_or(""));
        if !text.is_empty() {
            return text.chars().take(80).collect();
        }
        if event
            .get("images")
            .and_then(Json::as_array)
            .map(|images| !images.is_empty())
            .unwrap_or(false)
        {
            return "Photo".to_string();
        }
        let name = event
            .get("listings")
            .and_then(Json::as_array)
            .and_then(|listings| listings.first())
            .and_then(|listing| listing.get("cardName"))
            .and_then(Json::as_str)
            .unwrap_or("");
        return if name.is_empty() {
            String::new()
        } else {
            name.chars().take(80).collect()
        };
    }
    if event_type == EVENT_MONEY_REQUEST {
        if event.get("status").and_then(Json::as_str) == Some("paid") {
            return format!("Paid ✓ {amount}");
        }
        return if mine {
            format!("You requested {amount}")
        } else {
            format!("Requested {amount}")
        };
    }
    if event_type == EVENT_PAYMENT {
        return if mine {
            format!("You sent {amount}")
        } else {
            format!("Sent you {amount}")
        };
    }
    clean_text(event.get("text").and_then(Json::as_str).unwrap_or(""))
        .chars()
        .take(80)
        .collect()
}

/// `operationId(uid, clientToken)` — the payment idempotency document id.
pub fn operation_id(uid: &str, client_token: &str) -> String {
    let token: String = client_token.trim().chars().take(80).collect();
    if token.is_empty() {
        return String::new();
    }
    let mut hasher = Sha256::new();
    hasher.update(format!("{uid}\0{token}").as_bytes());
    format!("chat_{}", hex::encode(hasher.finalize()))
}

/// `effectiveStatus(request, now)`: a pending request older than 14 days is
/// reported as expired without writing anything.
pub fn effective_status(status: &str, created_at_ms: i64, now_ms: i64) -> String {
    let status = if status.is_empty() {
        STATUS_PENDING
    } else {
        status
    };
    if status == STATUS_PENDING && now_ms - created_at_ms > MONEY_REQUEST_TTL_MS {
        return STATUS_EXPIRED.to_string();
    }
    status.to_string()
}

/// The same conversion for a plain JSON value (a `lastEvent.at` from the wire).
pub fn json_timestamp_millis(value: &Json) -> i64 {
    match value {
        Json::Null => 0,
        Json::String(text) => chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|parsed| parsed.timestamp_millis())
            .unwrap_or(0),
        Json::Number(number) => number.as_i64().unwrap_or(0),
        Json::Object(fields) => fields
            .get("seconds")
            .and_then(Json::as_i64)
            .map(|seconds| seconds * 1000)
            .or_else(|| {
                fields
                    .get("_seconds")
                    .and_then(Json::as_i64)
                    .map(|seconds| seconds * 1000)
            })
            .unwrap_or(0),
        _ => 0,
    }
}

/// Convenience for a Firestore timestamp/`{seconds}`/number field.
pub fn timestamp_millis(value: Option<&Value>) -> i64 {
    match value {
        None | Some(Value::Null) => 0,
        Some(Value::Timestamp(timestamp)) => timestamp.timestamp_millis(),
        Some(Value::Integer(millis)) => *millis,
        Some(Value::Double(millis)) => *millis as i64,
        Some(Value::String(text)) => chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|parsed| parsed.timestamp_millis())
            .unwrap_or(0),
        Some(Value::Map(fields)) => fields
            .get("seconds")
            .and_then(|value| value.as_i64())
            .map(|seconds| seconds * 1000)
            .unwrap_or(0),
        _ => 0,
    }
}

/// `profileFromUser(data)`: a safe display name and an https-only photo.
pub fn profile_from_user(data: &crate::firestore::Document) -> Json {
    let display_name: String = data
        .get_str("displayName")
        .trim()
        .chars()
        .take(120)
        .collect();
    let display_name = if display_name.is_empty() || display_name.contains('@') {
        String::new()
    } else {
        display_name
    };
    let photo = data.get_str("photoUrl");
    let photo_url = photo
        .trim()
        .strip_prefix("https://")
        .map(|_| photo.trim().to_string())
        .unwrap_or_default();
    json!({ "displayName": display_name, "photoUrl": photo_url })
}

/// Serialize one event document for the client.
pub fn serialize_event(
    document: &crate::firestore::Document,
    uid: &str,
    requests_by_id: &Map<String, Json>,
) -> Json {
    let request_id = document.get_str("requestId");
    let request = requests_by_id.get(&request_id);
    let request_amount = request
        .and_then(|request| request.get("amountPkn"))
        .and_then(Json::as_i64)
        .unwrap_or(0);
    let amount = document.get_i64("amountPkn").unwrap_or(request_amount);
    let note = {
        let own = document.get_str("note");
        if own.is_empty() {
            request
                .and_then(|request| request.get("note"))
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string()
        } else {
            own
        }
    };
    let request_status = request
        .map(|request| {
            let status = request
                .get("status")
                .and_then(Json::as_str)
                .unwrap_or(STATUS_PENDING);
            let created = request
                .get("createdAtMs")
                .and_then(Json::as_i64)
                .unwrap_or(0);
            let now = chrono::Utc::now().timestamp_millis();
            effective_status(status, created, now)
        })
        .unwrap_or_default();
    let sender_uid = document.get_str("senderUid");
    json!({
        "id": document.id(),
        "type": document.get_str("type"),
        "senderUid": sender_uid,
        "senderUsername": document.get_str("senderUsername"),
        "text": document.get_str("text"),
        "listings": document.get("listings").map(|value| value.to_plain_json()).unwrap_or(json!([])),
        "images": document.get("images").map(|value| value.to_plain_json()).unwrap_or(json!([])),
        "amountPkn": amount,
        "note": note,
        "requestId": request_id,
        "requestStatus": request_status,
        "paymentLedgerId": request
            .and_then(|request| request.get("paymentLedgerId"))
            .and_then(Json::as_str)
            .unwrap_or(""),
        "transactionId": document.get_str("transactionId"),
        "createdAt": document.get("createdAt").map(|value| value.to_plain_json()).unwrap_or(Json::Null),
        "mine": sender_uid == uid,
    })
}

/// A JSON number that is integral serializes as an integer, like JavaScript.
pub fn integral_json(value: i64) -> Json {
    Json::Number(Number::from(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firestore::Document;

    fn document(fields: Json) -> Document {
        Document {
            name: "projects/p/databases/(default)/documents/conversations/c/events/e".into(),
            create_time: None,
            update_time: None,
            fields: serde_json::from_value(fields).ok(),
        }
    }

    #[test]
    fn pair_keys_are_order_independent_and_reject_bad_input() {
        let a = pair_key_for("uidAAAAAAAA", "uidBBBBBBBB").unwrap();
        let b = pair_key_for("uidBBBBBBBB", "uidAAAAAAAA").unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("direct_"));
        assert_eq!(a.len(), "direct_".len() + 64);
        assert!(pair_key_for("", "uidBBBBBBBB").is_err());
        assert!(pair_key_for("uidAAAAAAAA", "uidAAAAAAAA").is_err());
    }

    #[test]
    fn participants_helpers_match_the_node_helpers() {
        let members = vec!["a".to_string(), "b".to_string()];
        assert!(is_participant(&members, "a"));
        assert!(!is_participant(&members, "c"));
        assert_eq!(other_member(&members, "a"), "b");
        assert_eq!(other_member(&members, "b"), "a");
        assert_eq!(other_member(&members, "c"), "a");
    }

    #[test]
    fn text_and_note_cleaning_collapses_and_caps() {
        assert_eq!(clean_text("  a   b  "), "a b");
        assert_eq!(clean_text("a\nb"), "a b");
        assert_eq!(clean_text(&"x".repeat(1200)).len(), TEXT_MAX);
        assert_eq!(clean_note(&"x".repeat(200)).len(), NOTE_MAX);
        assert_eq!(clean_note(""), "");
    }

    #[test]
    fn amounts_must_be_positive_whole_and_bounded() {
        assert_eq!(validate_amount_pkn(Some(&json!(5))), Ok(5));
        assert_eq!(
            validate_amount_pkn(Some(&json!(0))),
            Err("Enter a whole PKN amount greater than zero.".to_string())
        );
        assert_eq!(
            validate_amount_pkn(Some(&json!(-3))),
            Err("Enter a whole PKN amount greater than zero.".to_string())
        );
        assert_eq!(
            validate_amount_pkn(Some(&json!(1.5))),
            Err("Enter a whole PKN amount greater than zero.".to_string())
        );
        assert_eq!(
            validate_amount_pkn(Some(&json!(1_000_000_001i64))),
            Err("That amount is too large.".to_string())
        );
        assert_eq!(validate_amount_pkn(None), Err("Enter a whole PKN amount greater than zero.".to_string()));
    }

    #[test]
    fn unread_counts_skip_the_sender() {
        let members = vec!["a".to_string(), "b".to_string()];
        let unread: Map<String, Json> = serde_json::from_value(json!({ "a": 3, "b": 0 })).unwrap();
        let next = bump_unread(Some(&unread), &members, "a");
        assert_eq!(next.get("a").and_then(Value::as_i64), Some(3));
        assert_eq!(next.get("b").and_then(Value::as_i64), Some(1));
        // A brand new conversation starts at 0/1.
        let next = bump_unread(None, &members, "b");
        assert_eq!(next.get("a").and_then(Value::as_i64), Some(1));
        assert_eq!(next.get("b").and_then(Value::as_i64), Some(0));
        assert_eq!(unread_for(Some(&unread), "a"), 3);
        assert_eq!(unread_for(Some(&unread), "zz"), 0);
        assert_eq!(unread_for(None, "a"), 0);
    }

    #[test]
    fn image_urls_accept_only_site_paths_and_https() {
        assert_eq!(clean_image_url("/x/y.jpg"), "/x/y.jpg");
        assert_eq!(clean_image_url("https://cdn.pokoin.com/y.jpg"), "https://cdn.pokoin.com/y.jpg");
        assert_eq!(clean_image_url("//evil.com/y.jpg"), "");
        assert_eq!(clean_image_url("http://cdn.pokoin.com/y.jpg"), "");
        assert_eq!(clean_image_url("/a/../b"), "");
        assert_eq!(clean_image_url("/a\\b"), "");
        assert_eq!(clean_image_url(""), "");
        assert_eq!(clean_image_url(&format!("/{}", "x".repeat(500))), "");
    }

    #[test]
    fn listings_are_sanitized() {
        let raw = json!({
            "kind": "card",
            "listingId": "l1",
            "cardId": "c1",
            "seller": "Ash",
            "sellerUid": "uidAAAAAAAA",
            "cardName": "  Pikachu   ex ",
            "setName": "Base  Set",
            "imageUrl": "https://cdn.pokoin.com/p.jpg",
            "path": "/marketplace/en/cards/1",
            "pricePkn": 12.6,
            "qty": 3.9
        });
        let clean = clean_listing(&raw).unwrap();
        assert_eq!(clean["kind"], json!("card"));
        assert_eq!(clean["seller"], json!("ash"));
        assert_eq!(clean["cardName"], json!("Pikachu ex"));
        assert_eq!(clean["setName"], json!("Base Set"));
        assert_eq!(clean["pricePkn"], json!(13));
        assert_eq!(clean["qty"], json!(3));
        // A missing card name is not a listing.
        assert!(clean_listing(&json!({ "cardName": "  " })).is_none());
        // Invalid seller fields are blanked, not dropped.
        let clean = clean_listing(&json!({
            "cardName": "x", "seller": "A B", "sellerUid": "short", "path": "//evil", "pricePkn": -1
        }))
        .unwrap();
        assert_eq!(clean["seller"], json!(""));
        assert_eq!(clean["sellerUid"], json!(""));
        assert_eq!(clean["path"], json!(""));
        assert_eq!(clean["pricePkn"], json!(0));
        assert_eq!(clean["qty"], json!(1));
    }

    #[test]
    fn at_most_four_listings_are_kept() {
        let rows = Json::Array((0..8).map(|index| json!({ "cardName": format!("c{index}") })).collect());
        assert_eq!(clean_listings(Some(&rows)).len(), MAX_LISTINGS);
        assert!(clean_listings(None).is_empty());
    }

    #[test]
    fn photo_paths_are_normalized() {
        assert_eq!(
            photo_path("/card-images/user-photos/chat/u/1.jpg"),
            "/user-photos/chat/u/1.jpg"
        );
        assert_eq!(
            photo_path("/api/user-photos/chat/u/1.jpg"),
            "/user-photos/chat/u/1.jpg"
        );
        assert_eq!(
            photo_path("https://abc.r2.dev/user-photos/chat/u/1.jpg"),
            "/user-photos/chat/u/1.jpg"
        );
        assert_eq!(
            photo_path("https://api.pokoin.com/api/user-photos/chat/u/1.jpg"),
            "/user-photos/chat/u/1.jpg"
        );
        assert_eq!(photo_path("https://evil.com/x.jpg"), "");
        assert_eq!(photo_path("/a/../b"), "");
        assert_eq!(photo_path(""), "");
    }

    #[test]
    fn owned_photos_are_scoped_to_the_caller_and_kind() {
        let uid = "uidAAAAAAAA";
        let value = json!([
            format!("/api/user-photos/chat/{uid}/1.jpg"),
            format!("/api/user-photos/listing/{uid}/2.jpg"),
            format!("/api/user-photos/chat/uidBBBBBBBB/3.jpg"),
            format!("/api/user-photos/chat/{uid}/4.png"),
            format!("/api/user-photos/chat/{uid}/5.jpg")
        ]);
        let chat = clean_chat_images(Some(&value), uid);
        assert_eq!(chat.len(), 2);
        assert!(chat[0].ends_with("1.jpg"));
        assert!(chat[1].ends_with("5.jpg"));
        let listing = clean_listing_photos(Some(&value), uid);
        assert_eq!(listing.len(), 1);
        assert!(listing[0].ends_with("2.jpg"));
        // A malformed uid yields nothing at all.
        assert!(clean_chat_images(Some(&value), "short").is_empty());
    }

    #[test]
    fn proxy_urls_rewrite_only_owned_photo_paths() {
        assert_eq!(
            public_photo_proxy_url("https://abc.r2.dev/user-photos/chat/u/1.jpg", "https://api.pokoin.com"),
            "https://api.pokoin.com/api/user-photos/chat/u/1.jpg"
        );
        assert_eq!(
            public_photo_proxy_url("https://cdn.pokoin.com/other.jpg", "https://api.pokoin.com"),
            "https://cdn.pokoin.com/other.jpg"
        );
    }

    #[test]
    fn previews_match_the_node_wording() {
        let text = json!({ "type": "text", "text": "hello", "senderUid": "a" });
        assert_eq!(preview_for_event(&text, "a"), "hello");
        let photo = json!({ "type": "text", "images": ["x"], "senderUid": "a" });
        assert_eq!(preview_for_event(&photo, "a"), "Photo");
        let listing = json!({ "type": "text", "listings": [{ "cardName": "Pikachu" }], "senderUid": "a" });
        assert_eq!(preview_for_event(&listing, "a"), "Pikachu");
        let request = json!({ "type": "money_request", "amountPkn": 5, "senderUid": "a" });
        assert_eq!(preview_for_event(&request, "a"), "You requested 5 PKN");
        assert_eq!(preview_for_event(&request, "b"), "Requested 5 PKN");
        let paid = json!({ "type": "money_request", "status": "paid", "amountPkn": 5, "senderUid": "a" });
        assert_eq!(preview_for_event(&paid, "a"), "Paid ✓ 5 PKN");
        let payment = json!({ "type": "payment", "amountPkn": 7, "senderUid": "a" });
        assert_eq!(preview_for_event(&payment, "a"), "You sent 7 PKN");
        assert_eq!(preview_for_event(&payment, "b"), "Sent you 7 PKN");
    }

    #[test]
    fn operation_ids_are_per_user_and_token() {
        let first = operation_id("uidAAAAAAAA", "token-1");
        assert!(first.starts_with("chat_"));
        assert_eq!(first, operation_id("uidAAAAAAAA", "token-1"));
        assert_ne!(first, operation_id("uidBBBBBBBB", "token-1"));
        assert_ne!(first, operation_id("uidAAAAAAAA", "token-2"));
        // An empty token has no idempotency key at all.
        assert_eq!(operation_id("uidAAAAAAAA", "   "), "");
    }

    #[test]
    fn money_request_status_expires_after_fourteen_days() {
        let now = 1_791_417_600_000i64;
        assert_eq!(effective_status("pending", now - 1000, now), "pending");
        assert_eq!(
            effective_status("pending", now - MONEY_REQUEST_TTL_MS - 1, now),
            "expired"
        );
        // A non-pending status is never rewritten.
        assert_eq!(effective_status("paid", 0, now), "paid");
        assert_eq!(effective_status("", now, now), "pending");
    }

    #[test]
    fn serialized_events_carry_the_request_fallbacks() {
        let event_document = document(json!({
            "type": { "stringValue": "money_request" },
            "senderUid": { "stringValue": "a" },
            "senderUsername": { "stringValue": "ash" },
            "requestId": { "stringValue": "req1" },
            "createdAt": { "timestampValue": "2026-10-08T00:00:00Z" }
        }));
        let mut requests = Map::new();
        requests.insert(
            "req1".to_string(),
            json!({ "amountPkn": 9, "note": "lunch", "status": "paid", "paymentLedgerId": "L1" }),
        );
        let event = serialize_event(&event_document, "a", &requests);
        assert_eq!(event["amountPkn"], json!(9));
        assert_eq!(event["note"], json!("lunch"));
        assert_eq!(event["requestStatus"], json!("paid"));
        assert_eq!(event["paymentLedgerId"], json!("L1"));
        assert_eq!(event["mine"], json!(true));
        assert_eq!(event["id"], json!("e"));
        // Without the request, the fallbacks are empty/zero.
        let event = serialize_event(&event_document, "b", &Map::new());
        assert_eq!(event["amountPkn"], json!(0));
        assert_eq!(event["note"], json!(""));
        assert_eq!(event["requestStatus"], json!(""));
        assert_eq!(event["mine"], json!(false));
    }

    #[test]
    fn profile_shaping_matches_profile_from_user() {
        let profile_document = document(json!({
            "displayName": { "stringValue": "Ash Ketchum" },
            "photoUrl": { "stringValue": "https://cdn.pokoin.com/a.jpg" }
        }));
        let profile = profile_from_user(&profile_document);
        assert_eq!(profile["displayName"], json!("Ash Ketchum"));
        assert_eq!(profile["photoUrl"], json!("https://cdn.pokoin.com/a.jpg"));
        // An email-shaped display name and a non-https photo are dropped.
        let email_document = document(json!({
            "displayName": { "stringValue": "a@b.co" },
            "photoUrl": { "stringValue": "http://cdn.pokoin.com/a.jpg" }
        }));
        let profile = profile_from_user(&email_document);
        assert_eq!(profile["displayName"], json!(""));
        assert_eq!(profile["photoUrl"], json!(""));
    }

    #[test]
    fn json_timestamps_cover_every_stored_shape() {
        assert_eq!(json_timestamp_millis(&Json::Null), 0);
        assert_eq!(json_timestamp_millis(&json!("2026-10-08T00:00:00Z")), 1_791_417_600_000);
        assert_eq!(json_timestamp_millis(&json!("nonsense")), 0);
        assert_eq!(json_timestamp_millis(&json!(1_791_417_600_000i64)), 1_791_417_600_000);
        assert_eq!(json_timestamp_millis(&json!({ "seconds": 2 })), 2000);
        assert_eq!(json_timestamp_millis(&json!({ "_seconds": 3 })), 3000);
        assert_eq!(json_timestamp_millis(&json!([])), 0);
    }

    #[test]
    fn username_and_uid_shapes() {
        assert!(is_username("ash"));
        assert!(is_username("ash99"));
        assert!(!is_username("Ash"));
        assert!(!is_username("ab"));
        assert!(is_uid("uidAAAAAAAA"));
        assert!(!is_uid("short"));
        assert!(!is_uid("uid-AAAAAAAA"));
        assert_eq!(integral_json(7), json!(7));
    }
}
