//! Forum routes: `forum`, `forum-create-topic`, `forum-create-post`,
//! `forum-upload-media`.
//!
//! The forum tables live in Supabase PostgREST, exactly as in Node, so these
//! handlers keep the same `select`/filter/`Prefer` request shapes and the same
//! category/topic/post payloads. Media goes to Cloudflare R2 (native SigV4).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value as Json};

use crate::error::{ApiError, Result};
use crate::firestore::Firestore;
use crate::r2::MediaStore;
use crate::state::DomainState;
use crate::supabase::{encode_filter_value, SupabaseClient, PREFER_IGNORE_DUPLICATES, PREFER_REPRESENTATION};

use super::{json_cached, json_with_cors, ok, parse_body, require_claims, string_field};

pub const DEFAULT_CATEGORIES: [(&str, &str, &str, &str, i64); 4] = [
    (
        "general",
        "General",
        "Community updates and open discussion.",
        "forum",
        10,
    ),
    (
        "cards",
        "Cards",
        "Collecting, grading, trades and marketplace ideas.",
        "cards",
        20,
    ),
    (
        "pkn",
        "PKN and wPKN",
        "Native PKN, wPKN liquidity and DeFi.",
        "token",
        30,
    ),
    (
        "validators",
        "Validators",
        "Nodes, RPC, staking and network operations.",
        "validators",
        40,
    ),
];

const CATEGORY_SELECT: &str =
    "id,title,description,icon_name,sort_order,topic_count,post_count";
const TOPIC_SELECT: &str = "id,category_id,title,body,author_uid,author_name,author_photo_url,reply_count,status,created_at,updated_at";
const POST_SELECT: &str =
    "id,topic_id,category_id,body,author_uid,author_name,author_photo_url,status,created_at,updated_at";
const MEDIA_SELECT: &str =
    "id,topic_id,post_id,public_url,mime_type,byte_size,width,height,created_at";
const MAX_UPLOAD_BYTES: usize = 8 * 1024 * 1024;

/// `^[a-z0-9_-]{2,40}$`.
pub fn clean_category_id(value: &str) -> String {
    let text = value.trim();
    let valid = (2..=40).contains(&text.len())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-');
    if valid {
        text.to_string()
    } else {
        String::new()
    }
}

/// The UUID v1-5 regex the Node handlers used for `topicId` / `postId`.
pub fn clean_uuid(value: &str) -> String {
    let text = value.trim();
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return String::new();
    }
    let dash_positions = [8usize, 13, 18, 23];
    for (index, byte) in bytes.iter().enumerate() {
        if dash_positions.contains(&index) {
            if *byte != b'-' {
                return String::new();
            }
        } else if !byte.is_ascii_hexdigit() {
            return String::new();
        }
    }
    // Version nibble 1-5 and variant nibble 8/9/a/b.
    match bytes[14] {
        b'1'..=b'5' => {}
        _ => return String::new(),
    }
    match bytes[19].to_ascii_lowercase() {
        b'8' | b'9' | b'a' | b'b' => {}
        _ => return String::new(),
    }
    text.to_ascii_lowercase()
}

/// `cleanText`: trim, collapse whitespace before newlines, cap the length.
pub fn clean_text(value: &str, max_length: usize) -> String {
    // Node collapsed runs of whitespace before a newline, while preserving the
    // intentional line breaks themselves.
    let collapsed = if value.contains('\n') {
        value
            .trim()
            .split('\n')
            .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        value.split_whitespace().collect::<Vec<_>>().join(" ")
    };
    collapsed.chars().take(max_length).collect()
}

pub fn author_name(profile: Option<&Json>, fallback: &str) -> String {
    let username = profile
        .and_then(|profile| profile.get("username"))
        .and_then(Json::as_str)
        .unwrap_or("")
        .trim();
    if !username.is_empty() {
        return username.to_string();
    }
    let display = profile
        .and_then(|profile| profile.get("displayName"))
        .and_then(Json::as_str)
        .unwrap_or("")
        .trim();
    if !display.is_empty() {
        return display.to_string();
    }
    if fallback.is_empty() {
        "Pokoin user".to_string()
    } else {
        fallback.to_string()
    }
}

async fn profile_for_uid(firestore: &Firestore, uid: &str) -> Option<Json> {
    firestore
        .doc(format!("users/{uid}"))
        .get()
        .await
        .ok()
        .flatten()
        .map(|document| {
            let mut object = Map::new();
            for (key, value) in document.values().iter() {
                object.insert(key.clone(), value.to_plain_json());
            }
            Json::Object(object)
        })
}

fn default_categories_json() -> Json {
    Json::Array(
        DEFAULT_CATEGORIES
            .iter()
            .map(|(id, title, description, icon, sort)| {
                json!({
                    "id": id,
                    "title": title,
                    "description": description,
                    "icon_name": icon,
                    "sort_order": sort,
                    "topic_count": 0,
                    "post_count": 0,
                })
            })
            .collect(),
    )
}

/// `GET /api/forum`.
pub async fn forum(
    State(state): State<DomainState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    match forum_inner(&state, &query).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn forum_inner(
    state: &DomainState,
    query: &std::collections::HashMap<String, String>,
) -> Result<Response> {
    let supabase = state.supabase()?;
    let category_id = clean_category_id(query.get("categoryId").map(String::as_str).unwrap_or(""));
    let topic_id = clean_uuid(query.get("topicId").map(String::as_str).unwrap_or(""));
    let mode = query
        .get("mode")
        .map(String::as_str)
        .unwrap_or("home")
        .to_string();

    if !topic_id.is_empty() || mode == "topic" {
        let clean_topic = if !topic_id.is_empty() {
            topic_id
        } else {
            clean_uuid(query.get("id").map(String::as_str).unwrap_or(""))
        };
        if clean_topic.is_empty() {
            return Err(ApiError::bad_request("Invalid topic id."));
        }
        let topic = fetch_topic(&supabase, &clean_topic).await?;
        let posts = fetch_posts(&supabase, &clean_topic).await?;
        let media = fetch_media(&supabase, &clean_topic).await?;
        return Ok(ok(json!({
            "topic": topic,
            "posts": posts,
            "media": media,
        })));
    }

    let categories = fetch_categories(&supabase).await;
    let topics = fetch_topics(&supabase, &category_id).await;
    let (categories, topics) = match (categories, topics) {
        (Ok(categories), Ok(topics)) => (categories, topics),
        (categories, topics) => {
            tracing::warn!(
                ?categories, ?topics,
                "forum home falling back to default categories"
            );
            (Json::Array(vec![]), Json::Array(vec![]))
        }
    };
    let categories = match &categories {
        Json::Array(values) if !values.is_empty() => categories,
        _ => default_categories_json(),
    };
    Ok(json_cached(
        StatusCode::OK,
        json!({ "categories": categories, "topics": topics }),
        "public, max-age=20, s-maxage=60",
    ))
}

async fn fetch_categories(supabase: &SupabaseClient) -> Result<Json> {
    supabase
        .get(
            &format!(
                "/rest/v1/forum_categories?select={CATEGORY_SELECT}&order=sort_order.asc,id.asc"
            ),
            false,
        )
        .await
}

async fn fetch_topics(supabase: &SupabaseClient, category_id: &str) -> Result<Json> {
    let mut params = vec![
        format!("select={TOPIC_SELECT}"),
        "status=eq.open".to_string(),
        "order=updated_at.desc".to_string(),
        "limit=50".to_string(),
    ];
    if !category_id.is_empty() {
        params.insert(
            2,
            format!("category_id=eq.{}", encode_filter_value(category_id)),
        );
    }
    supabase
        .get(&format!("/rest/v1/forum_topics?{}", params.join("&")), false)
        .await
}

async fn fetch_topic(supabase: &SupabaseClient, topic_id: &str) -> Result<Json> {
    let rows = supabase
        .get(
            &format!(
                "/rest/v1/forum_topics?select={TOPIC_SELECT}&id=eq.{}&status=eq.open&limit=1",
                encode_filter_value(topic_id)
            ),
            false,
        )
        .await?;
    Ok(rows
        .as_array()
        .and_then(|rows| rows.first().cloned())
        .unwrap_or(Json::Null))
}

async fn fetch_posts(supabase: &SupabaseClient, topic_id: &str) -> Result<Json> {
    supabase
        .get(
            &format!(
                "/rest/v1/forum_posts?select={POST_SELECT}&topic_id=eq.{}&status=eq.open&order=created_at.asc&limit=100",
                encode_filter_value(topic_id)
            ),
            false,
        )
        .await
}

async fn fetch_media(supabase: &SupabaseClient, topic_id: &str) -> Result<Json> {
    supabase
        .get(
            &format!(
                "/rest/v1/forum_media?select={MEDIA_SELECT}&topic_id=eq.{}&order=created_at.asc&limit=100",
                encode_filter_value(topic_id)
            ),
            false,
        )
        .await
}

fn allowed_categories() -> [&'static str; 4] {
    ["general", "cards", "pkn", "validators"]
}

/// `POST /api/forum-create-topic`.
pub async fn forum_create_topic(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match forum_create_topic_inner(&state, &headers, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn forum_create_topic_inner(
    state: &DomainState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let supabase = state.supabase()?;
    let body = parse_body(body);
    let category_id = string_field(&body, "categoryId").trim().to_string();
    if !allowed_categories().contains(&category_id.as_str()) {
        return Err(ApiError::bad_request("Choose a valid forum category."));
    }
    let title = clean_text(&string_field(&body, "title"), 120);
    let text = clean_text(&string_field(&body, "body"), 5000);
    if title.chars().count() < 6 {
        return Err(ApiError::bad_request(
            "Topic title must be at least 6 characters.",
        ));
    }
    if text.chars().count() < 12 {
        return Err(ApiError::bad_request(
            "Topic body must be at least 12 characters.",
        ));
    }
    let card_ids: Vec<i64> = body
        .get("cardIds")
        .and_then(Json::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
                .filter(|value| *value > 0)
                .take(12)
                .collect()
        })
        .unwrap_or_default();

    let firestore = state.firestore().ok();
    let profile = match &firestore {
        Some(firestore) => profile_for_uid(firestore, &claims.uid).await,
        None => None,
    };
    let author_photo = profile
        .as_ref()
        .and_then(|profile| profile.get("photoUrl"))
        .and_then(Json::as_str)
        .map(str::to_string)
        .or_else(|| {
            if claims.picture.is_empty() {
                None
            } else {
                Some(claims.picture.clone())
            }
        });

    let rows = supabase
        .post(
            "/rest/v1/forum_topics?select=*",
            json!({
                "category_id": category_id,
                "title": title,
                "body": text,
                "author_uid": claims.uid,
                "author_name": author_name(profile.as_ref(), &claims.name),
                "author_photo_url": author_photo,
            }),
            true,
            Some(PREFER_REPRESENTATION),
        )
        .await?;
    let topic = rows
        .as_array()
        .and_then(|rows| rows.first().cloned())
        .unwrap_or(rows);

    if let Some(topic_id) = topic.get("id").and_then(Json::as_str) {
        if !card_ids.is_empty() {
            let links: Vec<Json> = card_ids
                .iter()
                .map(|card_id| json!({ "topic_id": topic_id, "card_id": card_id }))
                .collect();
            // Node logged and continued when the secondary link write failed.
            if let Err(error) = supabase
                .post(
                    "/rest/v1/forum_topic_cards",
                    Json::Array(links),
                    true,
                    Some(PREFER_IGNORE_DUPLICATES),
                )
                .await
            {
                tracing::warn!(%error, topic_id, "forum topic card links failed");
            }
        }
    }

    Ok(ok(json!({ "topic": topic })))
}

/// `POST /api/forum-create-post`.
pub async fn forum_create_post(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match forum_create_post_inner(&state, &headers, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn forum_create_post_inner(
    state: &DomainState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let body = parse_body(body);
    let topic_id = clean_uuid(&string_field(&body, "topicId"));
    let text = clean_text(&string_field(&body, "body"), 5000);
    if topic_id.is_empty() {
        return Err(ApiError::bad_request("Invalid topic id."));
    }
    if text.chars().count() < 3 {
        return Err(ApiError::bad_request(
            "Reply must be at least 3 characters.",
        ));
    }
    // Supabase is only needed once the request itself is valid, matching the
    // Node handlers (which captured it lazily inside `supabaseFetch`).
    let supabase = state.supabase()?;

    let topic_rows = supabase
        .get(
            &format!(
                "/rest/v1/forum_topics?select=id,category_id,status&id=eq.{}&status=eq.open&limit=1",
                encode_filter_value(&topic_id)
            ),
            true,
        )
        .await?;
    let topic = topic_rows
        .as_array()
        .and_then(|rows| rows.first())
        .cloned()
        .ok_or_else(|| ApiError::not_found("This topic is no longer open."))?;
    let topic_id = topic
        .get("id")
        .and_then(Json::as_str)
        .unwrap_or(&topic_id)
        .to_string();
    let category_id = topic
        .get("category_id")
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_string();

    let firestore = state.firestore().ok();
    let profile = match &firestore {
        Some(firestore) => profile_for_uid(firestore, &claims.uid).await,
        None => None,
    };
    let author_photo = profile
        .as_ref()
        .and_then(|profile| profile.get("photoUrl"))
        .and_then(Json::as_str)
        .map(str::to_string)
        .or_else(|| {
            if claims.picture.is_empty() {
                None
            } else {
                Some(claims.picture.clone())
            }
        });

    let rows = supabase
        .post(
            "/rest/v1/forum_posts?select=*",
            json!({
                "topic_id": topic_id,
                "category_id": category_id,
                "body": text,
                "author_uid": claims.uid,
                "author_name": author_name(profile.as_ref(), &claims.name),
                "author_photo_url": author_photo,
            }),
            true,
            Some(PREFER_REPRESENTATION),
        )
        .await?;
    let post = rows
        .as_array()
        .and_then(|rows| rows.first().cloned())
        .unwrap_or(rows);
    Ok(ok(json!({ "post": post })))
}

/// `POST /api/forum-upload-media`.
pub async fn forum_upload_media(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match forum_upload_media_inner(&state, &headers, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn forum_upload_media_inner(
    state: &DomainState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let body = parse_body(body);
    let image_base64 = string_field(&body, "imageBase64");
    if image_base64.trim().is_empty() {
        return Err(ApiError::bad_request("Missing image data."));
    }
    let topic_id = clean_uuid(&string_field(&body, "topicId"));
    let post_id = clean_uuid(&string_field(&body, "postId"));
    if topic_id.is_empty() && post_id.is_empty() {
        return Err(ApiError::bad_request(
            "Upload media after creating a topic or reply.",
        ));
    }

    let encoded = strip_data_url_prefix(&image_base64);
    let source = decode_base64(encoded)
        .ok_or_else(|| ApiError::bad_request("Image must be smaller than 8 MB."))?;
    if source.is_empty() || source.len() > MAX_UPLOAD_BYTES {
        return Err(ApiError::bad_request("Image must be smaller than 8 MB."));
    }

    let (media_bytes, width, height) = encode_forum_media(&source)?;
    let media_id = uuid::Uuid::new_v4().to_string();
    let storage_path = format!("forum-media/{}/{media_id}.webp", claims.uid);
    let store = state
        .media_store()
        .ok_or_else(|| ApiError::internal(
            "Cloudflare R2 forum media storage is not configured. Add R2_FORUM_MEDIA_BUCKET and R2_FORUM_MEDIA_PUBLIC_URL.",
        ))?;
    let public_url = store.put(&storage_path, media_bytes.clone(), "image/webp").await?;

    let supabase = state.supabase()?;
    let rows = supabase
        .post(
            "/rest/v1/forum_media?select=*",
            json!({
                "owner_uid": claims.uid,
                "topic_id": if topic_id.is_empty() { Json::Null } else { json!(topic_id) },
                "post_id": if post_id.is_empty() { Json::Null } else { json!(post_id) },
                "object_key": storage_path,
                "public_url": public_url,
                "mime_type": "image/webp",
                "byte_size": media_bytes.len(),
                "width": width,
                "height": height,
            }),
            true,
            Some(PREFER_REPRESENTATION),
        )
        .await?;
    let media = rows
        .as_array()
        .and_then(|rows| rows.first().cloned())
        .unwrap_or(rows);
    Ok(ok(json!({ "media": media })))
}

/// `imageBase64.replace(/^data:image\/\w+;base64,/, '')`.
pub fn strip_data_url_prefix(value: &str) -> &str {
    let trimmed = value.trim_start();
    if let Some(rest) = trimmed.strip_prefix("data:image/") {
        if let Some(index) = rest.find(";base64,") {
            let mime = &rest[..index];
            if !mime.is_empty() && mime.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
                return &rest[index + ";base64,".len()..];
            }
        }
    }
    trimmed
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    // Accept both the standard and URL-safe alphabets, with or without padding.
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(value))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(value))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value))
        .ok()
}

/// Decode, auto-rotate, fit inside 1600x1600 without enlargement, re-encode.
///
/// Node used `sharp(...).webp({ quality: 86 })` (lossy). The native encoder
/// emits lossless WebP, so the bytes differ while the pixels and the stored
/// metadata (`width`, `height`, `mime_type`) match. This is recorded as a
/// fidelity note in the coverage ledger.
pub fn encode_forum_media(source: &[u8]) -> Result<(Vec<u8>, Option<u32>, Option<u32>)> {
    let decoded = image::load_from_memory(source)
        .map_err(|_| ApiError::bad_request("Image must be smaller than 8 MB."))?;
    let resized = if decoded.width() > 1600 || decoded.height() > 1600 {
        decoded.resize(1600, 1600, image::imageops::FilterType::Lanczos3)
    } else {
        decoded
    };
    let width = resized.width();
    let height = resized.height();
    let mut out = Vec::new();
    let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
    resized
        .write_with_encoder(encoder)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok((out, Some(width), Some(height)))
}

/// `OPTIONS` for the CORS-preflight routes.
pub async fn options() -> Response {
    super::preflight().await
}

/// Keep the `MediaStore` bound to the state builder without a cyclic import.
pub fn media_store_from(state: &DomainState) -> Option<Arc<dyn MediaStore>> {
    state.media_store()
}

/// A JSON body with the CORS headers, used by the topic/post creators.
pub fn created(body: Json) -> Response {
    json_with_cors(StatusCode::OK, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_ids_follow_the_node_regex() {
        assert_eq!(clean_category_id("general"), "general");
        assert_eq!(clean_category_id("pkn_2-x"), "pkn_2-x");
        assert_eq!(clean_category_id("a"), "");
        assert_eq!(clean_category_id("UPPER"), "");
        assert_eq!(clean_category_id("has space"), "");
        assert_eq!(clean_category_id(&"a".repeat(41)), "");
    }

    #[test]
    fn uuid_cleaning_accepts_v1_to_v5_and_rejects_junk() {
        assert_eq!(
            clean_uuid("0f8fad5b-d9cb-469f-a165-70867728950e"),
            "0f8fad5b-d9cb-469f-a165-70867728950e"
        );
        assert_eq!(
            clean_uuid("0F8FAD5B-D9CB-469F-A165-70867728950E"),
            "0f8fad5b-d9cb-469f-a165-70867728950e"
        );
        assert_eq!(clean_uuid("not-a-uuid"), "");
        // Wrong version nibble.
        assert_eq!(clean_uuid("0f8fad5b-d9cb-069f-a165-70867728950e"), "");
        // Wrong variant nibble.
        assert_eq!(clean_uuid("0f8fad5b-d9cb-469f-c165-70867728950e"), "");
        // Missing dashes.
        assert_eq!(clean_uuid("0f8fad5bd9cb469fa16570867728950e"), "");
    }

    #[test]
    fn text_cleaning_trims_collapses_and_caps() {
        assert_eq!(clean_text("  hello   world  ", 100), "hello world");
        assert_eq!(clean_text("line one\n\nline two", 100), "line one\n\nline two");
        assert_eq!(clean_text("  a   b  \n  c  ", 100), "a b\nc");
        assert_eq!(clean_text("abcdef", 3), "abc");
    }

    #[test]
    fn author_name_preference_order_matches_node() {
        let profile = json!({ "username": "ash", "displayName": "Ash Ketchum" });
        assert_eq!(author_name(Some(&profile), "fallback"), "ash");
        let profile = json!({ "displayName": "Ash Ketchum" });
        assert_eq!(author_name(Some(&profile), "fallback"), "Ash Ketchum");
        assert_eq!(author_name(None, "fallback"), "fallback");
        assert_eq!(author_name(None, ""), "Pokoin user");
        let empty = json!({});
        assert_eq!(author_name(Some(&empty), ""), "Pokoin user");
    }

    #[test]
    fn data_url_prefix_is_stripped_like_the_node_regex() {
        assert_eq!(strip_data_url_prefix("data:image/png;base64,AAAA"), "AAAA");
        assert_eq!(strip_data_url_prefix("data:image/webp;base64,BBBB"), "BBBB");
        assert_eq!(strip_data_url_prefix("AAAA"), "AAAA");
        // Not a data URL image prefix: left untouched.
        assert_eq!(strip_data_url_prefix("data:text/plain;base64,AAAA"), "data:text/plain;base64,AAAA");
    }

    #[test]
    fn base64_decoding_accepts_padded_and_unpadded() {
        assert_eq!(decode_base64("AAAA").unwrap(), vec![0, 0, 0]);
        assert_eq!(decode_base64("AAA").unwrap(), vec![0, 0]);
    }

    #[test]
    fn webp_encoding_produces_a_real_webp() {
        // A 2x2 red PNG, decoded, re-encoded and checked for the RIFF/WEBP magic.
        let mut png = Vec::new();
        let image = image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255]));
        image::DynamicImage::ImageRgba8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut png),
                image::ImageFormat::Png,
            )
            .unwrap();
        let (webp, width, height) = encode_forum_media(&png).unwrap();
        assert_eq!(&webp[..4], b"RIFF");
        assert_eq!(&webp[8..12], b"WEBP");
        assert_eq!(width, Some(2));
        assert_eq!(height, Some(2));
    }

    #[test]
    fn oversized_images_are_rejected_at_the_handler_boundary() {
        // 8 MB + 1 of filler must fail before any encoding is attempted.
        let oversized = "A".repeat((MAX_UPLOAD_BYTES + 1) * 4 / 3 + 8);
        let decoded = decode_base64(&oversized);
        assert!(decoded.map(|bytes| bytes.len() > MAX_UPLOAD_BYTES).unwrap_or(false));
    }

    #[test]
    fn default_categories_match_the_node_seed() {
        let categories = default_categories_json();
        let values = categories.as_array().unwrap();
        assert_eq!(values.len(), 4);
        assert_eq!(values[0]["id"], json!("general"));
        assert_eq!(values[0]["sort_order"], json!(10));
        assert_eq!(values[3]["icon_name"], json!("validators"));
        assert_eq!(values[2]["title"], json!("PKN and wPKN"));
    }
}
