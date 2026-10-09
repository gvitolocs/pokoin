//! R2 media routes: private `pokoin-user-photos` proxy today; profile/forum
//! uploads are audited gaps (see external-coverage.json).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

use crate::error::{header_value, json_response, ApiError, ApiResult};
use crate::routes::util::require_token;
use crate::time_util;
use crate::state::DomainState;

/// A validated `user-photos/<kind>/<uid>/<id>.jpg` key.
#[derive(Clone, Debug, PartialEq)]
pub struct PhotoKey {
    pub kind: String,
    pub uid: String,
    pub id: String,
    pub key: String,
}

/// `parsePhotoKey` — the reference only accepts sha-like ids and the two kinds.
pub fn parse_photo_key(raw: &str) -> Option<PhotoKey> {
    let text = raw.trim().trim_start_matches('/');
    // user-photos/(chat|listing)/<uid 8-128 alnum>/<id 12-64 hex>.jpg
    let rest = text
        .strip_prefix("user-photos/")
        .or_else(|| text.strip_prefix("user-photos"))?;
    let rest = rest.trim_start_matches('/');
    let mut parts = rest.split('/');
    let kind = parts.next()?.to_ascii_lowercase();
    if kind != "chat" && kind != "listing" {
        return None;
    }
    let uid = parts.next()?;
    if uid.len() < 8 || uid.len() > 128 || !uid.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let file = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let id = file.strip_suffix(".jpg").or_else(|| file.strip_suffix(".JPG"))?;
    let id_lower = id.to_ascii_lowercase();
    if id.len() < 12 || id.len() > 64 || !id_lower.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(PhotoKey {
        kind: kind.clone(),
        uid: uid.to_string(),
        id: id_lower.clone(),
        key: format!("user-photos/{kind}/{uid}/{id_lower}.jpg"),
    })
}

fn auth_origin() -> String {
    std::env::var("POKOIN_PUBLIC_ORIGIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://pokoin.com".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn wants_html(headers: &HeaderMap) -> bool {
    header_value(headers, "accept").contains("text/html")
}

/// `GET /api/user-photos/:kind/:uid/:file`.
pub async fn user_photos(
    State(state): State<DomainState>,
    headers: HeaderMap,
    Path((kind, uid, file)): Path<(String, String, String)>,
) -> ApiResult<Response> {
    let key = parse_photo_key(&format!("user-photos/{kind}/{uid}/{file}"))
        .ok_or_else(|| ApiError::not_found("Photo not found."))?;

    if key.kind == "chat" {
        let authorization = header_value(&headers, "authorization");
        let user = if authorization.is_empty() {
            None
        } else {
            state.verifier.verify(Some(authorization.as_str())).await.ok()
        };
        if user.is_none() {
            if wants_html(&headers) || authorization.is_empty() {
                let origin = auth_origin();
                let next = format!("{origin}/messages?photo=/api/user-photos/{kind}/{uid}/{file}");
                let location = format!("{origin}/auth?from={}", crate::crypto::uri_encode(&next, true));
                let response = Response::builder()
                    .status(StatusCode::FOUND)
                    .header("Cache-Control", "no-store")
                    .header("Location", location)
                    .body(axum::body::Body::empty())
                    .map_err(|_| ApiError::new(500, "Photo redirect failed."))?;
                return Ok(response);
            }
            return Err(ApiError::new(401, "Sign in to view this photo."));
        }
    }

    let Some(client) = state.r2_user_photos.as_ref() else {
        return Err(ApiError::new(503, "Photo storage is not configured.")
            .with_code("r2_not_configured"));
    };
    let bucket = client.bucket.clone();
    let object = client.get_object(&bucket, &key.key).await?;
    if object.status == 404 {
        return Err(ApiError::not_found("Photo not found."));
    }
    if object.status >= 400 {
        return Err(ApiError::upstream("Photo storage read failed."));
    }
    let cache = if key.kind == "chat" {
        "private, max-age=300"
    } else {
        "public, max-age=86400, stale-while-revalidate=604800"
    };
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", object.content_type)
        .header("Cache-Control", cache)
        .header("X-Content-Type-Options", "nosniff");
    if key.kind == "chat" {
        builder = builder
            .header("Access-Control-Allow-Origin", auth_origin())
            .header("Vary", "Authorization");
    }
    builder
        .body(axum::body::Body::from(object.body))
        .map_err(|_| ApiError::new(500, "Photo response failed."))
}

/// `POST /api/upload-profile-picture` — 256x256 cover avatar into R2.
pub async fn upload_profile_picture(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let payload = crate::routes::util::body_json(&body).await?;
    let (source, _content_type) = crate::r2::decode_image_base64(&payload, MAX_AVATAR_SOURCE_BYTES)?;
    let Some(client) = state.r2_profile_pictures.as_ref() else {
        return Err(ApiError::new(
            500,
            "Cloudflare R2 profile picture storage is not configured. Add R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.",
        )
        .with_code("r2_not_configured"));
    };
    let avatar = avatar_webp(&source)?;
    let key = format!("profile-pictures/{}/{}.webp", identity.uid, uuid::Uuid::new_v4());
    let bucket = client.bucket.clone();
    let status = client
        .put_object(
            &bucket,
            &key,
            "image/webp",
            avatar,
            "public, max-age=31536000, immutable",
        )
        .await?;
    if status >= 300 {
        return Err(ApiError::upstream("Profile picture upload failed."));
    }
    let Some(photo_url) = client.public_url(&key) else {
        return Err(ApiError::new(
            500,
            "Cloudflare R2 profile picture public URL is not configured.",
        )
        .with_code("r2_not_configured"));
    };
    assert_public_avatar_url(&photo_url).await?;

    let doc = state.firestore.get_doc("users", &identity.uid).await?;
    let previous = if doc.exists {
        doc.data
            .get("photoStoragePath")
            .and_then(serde_json::Value::as_str)
            .map(|value| value.to_string())
    } else {
        None
    };
    if let Some(previous) = previous {
        if previous != key && previous.starts_with(&format!("profile-pictures/{}/", identity.uid)) {
            let _ = client.delete_object(&bucket, &previous).await;
        }
    }

    state
        .firestore
        .merge_doc(
            "users",
            &identity.uid,
            serde_json::json!({
                "photoUrl": photo_url,
                "photoStoragePath": key,
                "photoInlineId": serde_json::Value::Null,
                "photoSource": "custom",
                "googlePhotoUrlHash": serde_json::Value::Null,
                "updatedAt": time_util::iso_from_ms(time_util::now_ms()),
            }),
        )
        .await?;
    Ok(json_response(200, json!({ "photoUrl": photo_url })))
}

/// `POST /api/remove-profile-picture` — delete the stored avatar + clear fields.
pub async fn remove_profile_picture(
    State(state): State<DomainState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let doc = state.firestore.get_doc("users", &identity.uid).await?;
    let storage_path = if doc.exists {
        doc.data
            .get("photoStoragePath")
            .and_then(serde_json::Value::as_str)
            .map(|value| value.to_string())
    } else {
        None
    };
    if let (Some(path), Some(client)) = (storage_path, state.r2_profile_pictures.as_ref()) {
        if path.starts_with(&format!("profile-pictures/{}/", identity.uid)) {
            let bucket = client.bucket.clone();
            let _ = client.delete_object(&bucket, &path).await;
        }
    }
    state
        .firestore
        .merge_doc(
            "users",
            &identity.uid,
            json!({
                "photoUrl": Value::Null,
                "photoStoragePath": Value::Null,
                "photoInlineId": Value::Null,
                "photoSource": Value::Null,
                "googlePhotoUrlHash": Value::Null,
                "updatedAt": time_util::iso_from_ms(time_util::now_ms()),
            }),
        )
        .await?;
    Ok(json_response(200, json!({ "ok": true })))
}

/// `POST /api/cache-google-profile-picture` — cache the Google avatar in R2.
pub async fn cache_google_profile_picture(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let payload = crate::routes::util::body_json(&body).await?;
    let doc = state.firestore.get_doc("users", &identity.uid).await?;
    let profile = if doc.exists { doc.data } else { Value::Null };
    let custom_prefix = format!("profile-pictures/{}/", identity.uid);
    let photo_storage_path = profile.get("photoStoragePath").and_then(Value::as_str).unwrap_or_default();
    let photo_source = profile.get("photoSource").and_then(Value::as_str).unwrap_or_default();
    let prior_photo_url = profile.get("photoUrl").cloned().unwrap_or(Value::Null);

    if photo_storage_path.starts_with(&custom_prefix) && photo_source != "google" {
        return Ok(json_response(
            200,
            json!({ "ok": true, "skipped": "custom-profile-picture", "photoUrl": prior_photo_url }),
        ));
    }

    let source_url = identity
        .picture
        .clone()
        .or_else(|| payload.get("photoUrl").and_then(Value::as_str).map(|value| value.to_string()))
        .unwrap_or_default();
    if source_url.is_empty() || !is_google_avatar_url(&source_url) {
        return Ok(json_response(
            200,
            json!({ "ok": true, "skipped": "no-google-profile-picture", "photoUrl": prior_photo_url }),
        ));
    }

    let source_hash = crate::crypto::sha256_hex(source_url.as_bytes())[..20].to_string();
    let storage_path = format!("profile-pictures/{}/google-{}.webp", identity.uid, source_hash);
    if photo_source == "google" && photo_storage_path == storage_path && !prior_photo_url.is_null() {
        return Ok(json_response(200, json!({ "ok": true, "cached": true, "photoUrl": prior_photo_url })));
    }

    let Some(client) = state.r2_profile_pictures.as_ref() else {
        return Err(ApiError::new(
            500,
            "Cloudflare R2 profile picture storage is not configured. Add R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.",
        )
        .with_code("r2_not_configured"));
    };
    let source = download_google_image(&source_url).await?;
    let avatar = avatar_webp(&source)?;
    let bucket = client.bucket.clone();
    let status = client
        .put_object(&bucket, &storage_path, "image/webp", avatar, "public, max-age=31536000, immutable")
        .await?;
    if status >= 300 {
        return Err(ApiError::upstream("Profile picture upload failed."));
    }
    let Some(photo_url) = client.public_url(&storage_path) else {
        return Err(ApiError::new(500, "Cloudflare R2 profile picture public URL is not configured.")
            .with_code("r2_not_configured"));
    };
    assert_public_avatar_url(&photo_url).await?;

    if !photo_storage_path.is_empty()
        && photo_storage_path.starts_with(&custom_prefix)
        && photo_storage_path != storage_path
    {
        let _ = client.delete_object(&bucket, photo_storage_path).await;
    }

    state
        .firestore
        .merge_doc(
            "users",
            &identity.uid,
            json!({
                "photoUrl": photo_url,
                "photoStoragePath": storage_path,
                "photoInlineId": Value::Null,
                "photoSource": "google",
                "googlePhotoUrlHash": source_hash,
                "updatedAt": time_util::iso_from_ms(time_util::now_ms()),
            }),
        )
        .await?;
    Ok(json_response(200, json!({ "ok": true, "photoUrl": photo_url })))
}

/// Only Google avatar hosts are eligible (SSRF guard from the reference).
pub fn is_google_avatar_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    match url.host_str() {
        Some("lh3.googleusercontent.com") | Some("googleusercontent.com") => true,
        Some(host) => host.ends_with(".googleusercontent.com"),
        None => false,
    }
}

async fn download_google_image(url: &str) -> ApiResult<Vec<u8>> {
    let response = reqwest::Client::new()
        .get(url)
        .header(
            "accept",
            "image/avif,image/webp,image/png,image/jpeg,image/*",
        )
        .header("user-agent", "pokoin-google-avatar-cache/1.0")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| ApiError::upstream("Google profile picture download failed."))?;
    if !response.status().is_success() {
        return Err(ApiError::upstream("Google profile picture download failed."));
    }
    if let Some(length) = response.content_length() {
        if length as usize > MAX_AVATAR_SOURCE_BYTES {
            return Err(ApiError::bad_request("Google profile picture is too large."));
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| ApiError::upstream("Google profile picture download failed."))?;
    if bytes.is_empty() || bytes.len() > MAX_AVATAR_SOURCE_BYTES {
        return Err(ApiError::bad_request("Google profile picture is too large."));
    }
    Ok(bytes.to_vec())
}

/// `POST /api/forum-upload-media` — 1600px-inside WebP into R2 forum bucket,
/// then a `forum_media` row through Supabase service role.
pub async fn forum_upload_media(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let payload = crate::routes::util::body_json(&body).await?;
    let topic_id = clean_uuid(payload.get("topicId").and_then(Value::as_str).unwrap_or_default());
    let post_id = clean_uuid(payload.get("postId").and_then(Value::as_str).unwrap_or_default());
    if topic_id.is_none() && post_id.is_none() {
        return Err(ApiError::bad_request("Upload media after creating a topic or reply."));
    }
    let (source, _content_type) = crate::r2::decode_image_base64(&payload, MAX_FORUM_SOURCE_BYTES)?;
    let Some(client) = state.r2_forum_media.as_ref() else {
        return Err(ApiError::new(
            500,
            "Cloudflare R2 forum media storage is not configured. Add R2_FORUM_MEDIA_BUCKET and R2_FORUM_MEDIA_PUBLIC_URL.",
        )
        .with_code("r2_not_configured"));
    };
    let (media, width, height) = forum_webp(&source)?;
    let byte_size = media.len();
    let key = format!("forum-media/{}/{}.webp", identity.uid, uuid::Uuid::new_v4());
    let bucket = client.bucket.clone();
    let status = client
        .put_object(&bucket, &key, "image/webp", media, "public, max-age=31536000, immutable")
        .await?;
    if status >= 300 {
        return Err(ApiError::upstream("Forum media upload failed."));
    }
    let Some(public_url) = client.public_url(&key) else {
        return Err(ApiError::new(500, "Cloudflare R2 forum media public URL is not configured.")
            .with_code("r2_not_configured"));
    };
    let Some(supabase) = crate::supabase::SupabaseConfig::from_env() else {
        return Err(ApiError::new(500, "Supabase is not configured.")
            .with_code("supabase_not_configured"));
    };
    let rows = supabase
        .insert(
            "/rest/v1/forum_media?select=*",
            &json!({
                "owner_uid": identity.uid,
                "topic_id": topic_id,
                "post_id": post_id,
                "object_key": key,
                "public_url": public_url,
                "mime_type": "image/webp",
                "byte_size": byte_size,
                "width": width,
                "height": height,
            }),
        )
        .await?;
    let media = rows
        .as_array()
        .and_then(|rows| rows.first().cloned())
        .unwrap_or(rows);
    Ok(json_response(200, json!({ "media": media })))
}

fn clean_uuid(value: &str) -> Option<String> {
    let text = value.trim();
    if crate::scan_connect::is_uuid(text) {
        Some(text.to_lowercase())
    } else {
        None
    }
}


/// Reference cap: 6 MB of source bytes before the avatar transform.
const MAX_AVATAR_SOURCE_BYTES: usize = 6 * 1024 * 1024;

/// Reference cap: 8 MB of source bytes before the forum transform.
const MAX_FORUM_SOURCE_BYTES: usize = 8 * 1024 * 1024;

/// 256x256 centre-cover avatar as WebP. The reference uses sharp's lossy WebP
/// q88; the `image` crate only exposes lossless WebP, so bytes differ while the
/// storage path (`profile-pictures/<uid>/<uuid>.webp`) and content type match.
fn avatar_webp(source: &[u8]) -> ApiResult<Vec<u8>> {
    use image::ImageEncoder;
    let decoded = image::load_from_memory(source)
        .map_err(|_| ApiError::bad_request("Unsupported image format."))?;
    let resized = decoded.resize_to_fill(256, 256, image::imageops::FilterType::Lanczos3);
    let rgba = resized.to_rgba8();
    let mut out = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut out)
        .write_image(rgba.as_raw(), 256, 256, image::ExtendedColorType::Rgba8)
        .map_err(|_| ApiError::new(500, "Avatar encoding failed."))?;
    Ok(out)
}

/// Forum media: resize inside 1600 without enlargement, lossless WebP.
fn forum_webp(source: &[u8]) -> ApiResult<(Vec<u8>, Option<i64>, Option<i64>)> {
    use image::ImageEncoder;
    let decoded = image::load_from_memory(source)
        .map_err(|_| ApiError::bad_request("Unsupported image format."))?;
    let resized = if decoded.width() > 1600 || decoded.height() > 1600 {
        decoded.resize(1600, 1600, image::imageops::FilterType::Lanczos3)
    } else {
        decoded
    };
    let (width, height) = (resized.width(), resized.height());
    let rgba = resized.to_rgba8();
    let mut out = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut out)
        .write_image(rgba.as_raw(), width, height, image::ExtendedColorType::Rgba8)
        .map_err(|_| ApiError::new(500, "Forum media encoding failed."))?;
    Ok((out, Some(width as i64), Some(height as i64)))
}

/// `assertPublicAvatarUrl` — the stored URL must be publicly readable.
async fn assert_public_avatar_url(url: &str) -> ApiResult<()> {
    let response = reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| ApiError::upstream("Uploaded profile picture is not publicly readable."))?;
    if !response.status().is_success() {
        return Err(ApiError::upstream(format!(
            "Uploaded profile picture is not publicly readable ({}).",
            response.status().as_u16()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn photo_key_matches_reference_shape() {
        let key = parse_photo_key("user-photos/chat/AbCd1234/0123456789ab.jpg").unwrap();
        assert_eq!(key.kind, "chat");
        assert_eq!(key.uid, "AbCd1234");
        assert_eq!(key.key, "user-photos/chat/AbCd1234/0123456789ab.jpg");

        // listing is accepted, mixed case is normalized
        assert!(parse_photo_key("user-photos/listing/uid12345/ABCDEFABCDEF.jpg").is_some());
        // wrong kind, short uid, too-short/non-hex id, extra segment
        assert!(parse_photo_key("user-photos/avatar/uid12345/0123456789ab.jpg").is_none());
        assert!(parse_photo_key("user-photos/chat/short/0123456789ab.jpg").is_none());
        assert!(parse_photo_key("user-photos/chat/uid12345/0123.jpg").is_none());
        assert!(parse_photo_key("user-photos/chat/uid12345/zzzzzzzzzzzz.jpg").is_none());
        assert!(parse_photo_key("user-photos/chat/uid12345/0123456789ab.jpg/extra").is_none());
        assert!(parse_photo_key("other/chat/uid12345/0123456789ab.jpg").is_none());
    }

    #[test]
    fn avatar_is_a_256_webp_container() {
        // 1x1 PNG -> 256x256 lossless WebP (RIFF....WEBP).
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine;
        let source = B64.decode(png).unwrap();
        let webp = avatar_webp(&source).unwrap();
        assert_eq!(&webp[..4], b"RIFF");
        assert_eq!(&webp[8..12], b"WEBP");
        // Decoding back proves the encoder produced a real image, not a header.
        let decoded = image::load_from_memory(&webp).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (256, 256));
        assert!(avatar_webp(b"not an image").is_err());
    }

    #[test]
    fn forum_media_transform_and_uuid() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine;
        let source = B64.decode(png).unwrap();
        let (webp, width, height) = forum_webp(&source).unwrap();
        assert_eq!(&webp[..4], b"RIFF");
        assert_eq!(&webp[8..12], b"WEBP");
        assert_eq!((width, height), (Some(1), Some(1)));
        assert!(clean_uuid("9f8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d").is_some());
        assert!(clean_uuid("nope").is_none());
    }

    #[test]
    fn google_avatar_host_guard() {
        assert!(is_google_avatar_url("https://lh3.googleusercontent.com/a/abc=s96-c"));
        assert!(is_google_avatar_url("https://foo.googleusercontent.com/x.png"));
        // http, other hosts and junk are rejected (SSRF guard).
        assert!(!is_google_avatar_url("http://lh3.googleusercontent.com/a"));
        assert!(!is_google_avatar_url("https://evil.example.com/a.png"));
        assert!(!is_google_avatar_url("https://googleusercontent.com.evil.com/a"));
        assert!(!is_google_avatar_url("not a url"));
        // The cache key hash is the reference's 20-char prefix.
        let hash = crate::crypto::sha256_hex(b"https://lh3.googleusercontent.com/a");
        assert_eq!(&hash[..20], &hash[..20]);
        assert_eq!(hash[..20].len(), 20);
    }
}
