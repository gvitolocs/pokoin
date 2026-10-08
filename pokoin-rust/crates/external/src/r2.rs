//! Cloudflare R2 (S3-compatible) object access signed with SigV4.
//!
//! Only the operations the external domain needs: proxy a private object
//! (`/api/user-photos/...`) and read/write/delete small objects. Signing is
//! pure Rust (`crypto::sigv4_headers`), no AWS SDK and no Node.

use bytes::Bytes;
use serde_json::Value;

use crate::crypto::{self, sigv4_time::SigV4Time};
use crate::error::{clean_text, ApiError, ApiResult};

/// One R2 bucket binding plus the shared credentials.
#[derive(Clone)]
pub struct R2Client {
    http: reqwest::Client,
    account_id: String,
    access_key: String,
    secret_key: String,
    /// Public CDN base for the bucket, without a trailing slash.
    pub public_base_url: String,
    pub bucket: String,
}

impl std::fmt::Debug for R2Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("R2Client")
            .field("account_id", &self.account_id)
            .field("bucket", &self.bucket)
            .field("public_base_url", &self.public_base_url)
            .finish_non_exhaustive()
    }
}

/// A fetched object: status, a small header allow-list and the body bytes.
pub struct R2Object {
    pub status: u16,
    pub content_type: String,
    pub cache_control: String,
    pub body: Bytes,
}

impl R2Client {
    /// Build from `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_ACCOUNT_ID`
    /// and the bucket variable named by `bucket_env`. Returns `None` when R2 is
    /// not configured, so the route can fail closed with 503.
    pub fn from_env(bucket_env: &str) -> Option<Self> {
        let curl = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let account_id = curl("CLOUDFLARE_ACCOUNT_ID")?;
        let access_key = curl("R2_ACCESS_KEY_ID")?;
        let secret_key = curl("R2_SECRET_ACCESS_KEY")?;
        let bucket = curl(bucket_env)?;
        // `R2_<NAME>_BUCKET` → `R2_<NAME>_PUBLIC_URL`.
        let public_env = format!(
            "{}_PUBLIC_URL",
            bucket_env.strip_suffix("_BUCKET").unwrap_or(bucket_env)
        );
        let public_base_url = curl(&format!("{bucket_env}_PUBLIC_URL"))
            .or_else(|| curl(&public_env))
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string();
        Some(Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .expect("reqwest client"),
            account_id,
            access_key,
            secret_key,
            public_base_url,
            bucket,
        })
    }

    fn host(&self, bucket: &str) -> String {
        format!("{bucket}.{}.r2.cloudflarestorage.com", self.account_id)
    }

    fn object_path(key: &str) -> String {
        format!("/{}", clean_text(Some(key), 1024).trim_start_matches('/'))
    }

    /// GET one object. Mirrors the reference proxy: R2 status is passed
    /// through so the caller can return 404 without inventing a body.
    pub async fn get_object(&self, bucket: &str, key: &str) -> ApiResult<R2Object> {
        let host = self.host(bucket);
        let path = Self::object_path(key);
        let url = format!("https://{host}{}", crypto::uri_encode(&path, false));
        let headers = crypto::sigv4_headers(
            "GET",
            &host,
            &path,
            "",
            b"",
            &self.access_key,
            &self.secret_key,
            SigV4Time::now(),
        );
        let mut request = self.http.get(&url);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request.send().await?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let cache_control = response
            .headers()
            .get(reqwest::header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let body = response.bytes().await?;
        Ok(R2Object { status, content_type, cache_control, body })
    }

    /// PUT one object with an explicit content type. Returns the R2 status.
    pub async fn put_object(
        &self,
        bucket: &str,
        key: &str,
        content_type: &str,
        body: Vec<u8>,
        cache_control: &str,
    ) -> ApiResult<u16> {
        let host = self.host(bucket);
        let path = Self::object_path(key);
        let url = format!("https://{host}{}", crypto::uri_encode(&path, false));
        let payload_hash = crypto::sha256_hex(&body);
        let headers = crypto::sigv4_headers(
            "PUT",
            &host,
            &path,
            "",
            &body,
            &self.access_key,
            &self.secret_key,
            SigV4Time::now(),
        );
        let mut request = self
            .http
            .put(&url)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(body);
        if !cache_control.is_empty() {
            request = request.header(reqwest::header::CACHE_CONTROL, cache_control);
        }
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request.send().await?;
        let _ = payload_hash;
        Ok(response.status().as_u16())
    }

    /// DELETE one object; 404 is success for the "remove" routes.
    pub async fn delete_object(&self, bucket: &str, key: &str) -> ApiResult<u16> {
        let host = self.host(bucket);
        let path = Self::object_path(key);
        let url = format!("https://{host}{}", crypto::uri_encode(&path, false));
        let headers = crypto::sigv4_headers(
            "DELETE",
            &host,
            &path,
            "",
            b"",
            &self.access_key,
            &self.secret_key,
            SigV4Time::now(),
        );
        let mut request = self.http.delete(&url);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request.send().await?;
        Ok(response.status().as_u16())
    }

    /// Public CDN URL for an object key, when a public base is configured.
    pub fn public_url(&self, key: &str) -> Option<String> {
        if self.public_base_url.is_empty() {
            return None;
        }
        Some(format!(
            "{}/{}",
            self.public_base_url,
            clean_text(Some(key), 1024).trim_start_matches('/')
        ))
    }
}

/// Validate an image payload for the upload routes: base64 decodes, image
/// decodes, and the source stays under `max_bytes`.
pub fn decode_image_base64(payload: &Value, max_bytes: usize) -> ApiResult<(Vec<u8>, String)> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    let raw = payload
        .get("imageBase64")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let raw = raw
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(',').map(|(_, data)| data))
        .unwrap_or(raw);
    if raw.is_empty() {
        return Err(ApiError::bad_request("imageBase64 is required."));
    }
    let bytes = B64
        .decode(raw)
        .map_err(|_| ApiError::bad_request("imageBase64 is not valid base64."))?;
    if bytes.is_empty() {
        return Err(ApiError::bad_request("imageBase64 decoded to an empty image."));
    }
    if bytes.len() > max_bytes {
        return Err(ApiError::new(413, "Image is too large."));
    }
    let format = image::guess_format(&bytes)
        .map_err(|_| ApiError::bad_request("Unsupported image format."))?;
    let content_type = match format {
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err(ApiError::bad_request("Unsupported image format.")),
    };
    Ok((bytes, content_type.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn object_path_is_normalized() {
        assert_eq!(R2Client::object_path("user-photos/a/b.jpg"), "/user-photos/a/b.jpg");
        assert_eq!(R2Client::object_path("/leading.jpg"), "/leading.jpg");
    }

    #[test]
    fn decode_rejects_empty_and_oversize() {
        assert!(decode_image_base64(&json!({}), 10).is_err());
        assert!(decode_image_base64(&json!({"imageBase64": "!!!"}), 10).is_err());
        // 1x1 PNG (valid image, tiny) then a size cap below its length.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let ok = decode_image_base64(&json!({"imageBase64": png}), 1024 * 1024).unwrap();
        assert_eq!(ok.1, "image/png");
        assert!(decode_image_base64(&json!({"imageBase64": png}), 4).is_err());
    }

    #[test]
    fn data_url_prefix_is_stripped() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let payload = json!({ "imageBase64": format!("data:image/png;base64,{png}") });
        assert!(decode_image_base64(&payload, 1024 * 1024).is_ok());
    }
}
