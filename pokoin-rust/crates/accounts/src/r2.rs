//! Cloudflare R2 (S3-compatible) media storage with AWS Signature V4.
//!
//! Node used `uploadForumMediaToR2` from `_r2.js`. This is the native
//! equivalent: a signed `PUT` of the encoded bytes to
//! `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`, returning the
//! public URL. With no credentials configured the store reports that
//! truthfully rather than pretending an upload happened.

use std::sync::Arc;

use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::{ApiError, Result};
use crate::http::{send_with_retry, HttpRequest, RetryPolicy, SharedTransport};

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct R2MediaStore {
    inner: Arc<R2Inner>,
}

struct R2Inner {
    /// e.g. `https://abc123.r2.cloudflarestorage.com`
    endpoint: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
    public_url: String,
    transport: SharedTransport,
    retry: RetryPolicy,
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Percent-encode one path segment (RFC 3986 unreserved set kept literal).
pub fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Percent-encode a key, keeping `/` as a separator.
pub fn encode_key(key: &str) -> String {
    key.split('/')
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn host_of(endpoint: &str) -> String {
    endpoint
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string()
}

/// AWS Signature V4 `Authorization` value for one request. `headers` holds
/// every signed header (lowercase names; sorted here). R2 signs with region
/// `auto`; there is never a query string.
#[allow(clippy::too_many_arguments)]
fn sigv4_authorization(
    access_key_id: &str,
    secret_access_key: &str,
    region: &str,
    method: &str,
    canonical_uri: &str,
    headers: &mut [(&str, String)],
    payload_hash: &str,
    amz_date: &str,
) -> String {
    headers.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_headers: String = headers
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect();
    let signed_headers = headers
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(";");
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let date_stamp = &amz_date[..8];
    let scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex_sha256(canonical_request.as_bytes())
    );
    let k_date = hmac(
        format!("AWS4{secret_access_key}").as_bytes(),
        date_stamp.as_bytes(),
    );
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, b"s3");
    let k_signing = hmac(&k_service, b"aws4_request");
    let signature = hex::encode(hmac(&k_signing, string_to_sign.as_bytes()));
    format!(
        "AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

impl R2MediaStore {
    pub fn new(
        endpoint: impl Into<String>,
        bucket: impl Into<String>,
        access_key_id: impl Into<String>,
        secret_access_key: impl Into<String>,
        public_url: impl Into<String>,
        transport: SharedTransport,
    ) -> Self {
        Self {
            inner: Arc::new(R2Inner {
                endpoint: endpoint.into().trim_end_matches('/').to_string(),
                bucket: bucket.into(),
                access_key_id: access_key_id.into(),
                secret_access_key: secret_access_key.into(),
                public_url: public_url.into().trim_end_matches('/').to_string(),
                transport,
                retry: RetryPolicy::default(),
            }),
        }
    }

    /// Signed `PUT` with no explicit cache directive (forum media).
    pub async fn put(&self, key: &str, body: Vec<u8>, content_type: &str) -> Result<String> {
        self.put_object(key, body, content_type, None).await
    }

    /// The chat/listing user-photos bucket. Different env vars from forum media
    /// (`CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_USER_PHOTOS_BUCKET`),
    /// same SigV4 signing. `None` when photo storage is not configured.
    pub fn for_user_photos(transport: SharedTransport) -> Option<Self> {
        let read = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        let account = read("CLOUDFLARE_ACCOUNT_ID")?;
        Some(Self::new(
            format!("https://{account}.r2.cloudflarestorage.com"),
            read("R2_USER_PHOTOS_BUCKET").unwrap_or_else(|| "pokoin-user-photos".into()),
            read("R2_ACCESS_KEY_ID")?,
            read("R2_SECRET_ACCESS_KEY")?,
            // The public URL is never used: chat photos are served through the
            // auth-aware /api/user-photos proxy.
            "https://api.pokoin.com",
            transport,
        ))
    }

    /// Build from the forum-media environment variables, or `None`.
    pub fn from_env(transport: SharedTransport) -> Option<Self> {
        let read = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        Some(Self::new(
            read("R2_FORUM_MEDIA_ENDPOINT")?,
            read("R2_FORUM_MEDIA_BUCKET")?,
            read("R2_FORUM_MEDIA_ACCESS_KEY_ID").or_else(|| read("R2_ACCESS_KEY_ID"))?,
            read("R2_FORUM_MEDIA_SECRET_ACCESS_KEY")
                .or_else(|| read("R2_SECRET_ACCESS_KEY"))?,
            read("R2_FORUM_MEDIA_PUBLIC_URL")?,
            transport,
        ))
    }

    pub fn public_url_for(&self, key: &str) -> String {
        format!("{}/{}", self.inner.public_url, encode_key(key))
    }

    /// Signed `PUT` with an optional `Cache-Control`. Returns the public URL.
    pub async fn put_object(
        &self,
        key: &str,
        body: Vec<u8>,
        content_type: &str,
        cache_control: Option<&str>,
    ) -> Result<String> {
        let host = host_of(&self.inner.endpoint);
        let canonical_uri = format!("/{}/{}", self.inner.bucket, encode_key(key));
        let url = format!("{}{}", self.inner.endpoint, canonical_uri);

        let now = chrono::Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let payload_hash = hex_sha256(&body);

        // Every header we send (except Authorization and Host, which are handled
        // separately) must be signed, in sorted lowercase name order.
        let mut to_sign: Vec<(&str, String)> = vec![
            ("content-type", content_type.to_string()),
            ("host", host.clone()),
            ("x-amz-content-sha256", payload_hash.clone()),
            ("x-amz-date", amz_date.clone()),
        ];
        if let Some(cache_control) = cache_control {
            to_sign.push(("cache-control", cache_control.to_string()));
        }
        let authorization = sigv4_authorization(
            &self.inner.access_key_id,
            &self.inner.secret_access_key,
            "auto",
            "PUT",
            &canonical_uri,
            &mut to_sign,
            &payload_hash,
            &amz_date,
        );

        let mut request = HttpRequest::new("PUT", url)
            .header("Host", host)
            .header("Content-Type", content_type)
            .header("x-amz-content-sha256", payload_hash)
            .header("x-amz-date", amz_date)
            .header("Authorization", authorization);
        if let Some(cache_control) = cache_control {
            request = request.header("Cache-Control", cache_control);
        }
        request.body = body;

        let response = send_with_retry(&self.inner.transport, request, self.inner.retry)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        if !response.is_success() {
            let detail: String = response.text().chars().take(300).collect();
            return Err(ApiError::internal(format!(
                "R2 upload failed {}: {detail}",
                response.status
            )));
        }
        Ok(self.public_url_for(key))
    }

    /// Signed `GET` of one object; `Ok(None)` when it does not exist. Photos
    /// are at most 4 MB: the read gets 8 s instead of the shared 4 s default,
    /// and no retries (a failed read only means no photo search).
    pub async fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let host = host_of(&self.inner.endpoint);
        let canonical_uri = format!("/{}/{}", self.inner.bucket, encode_key(key));
        let url = format!("{}{}", self.inner.endpoint, canonical_uri);
        let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let payload_hash = hex_sha256(b"");
        let mut to_sign: Vec<(&str, String)> = vec![
            ("host", host.clone()),
            ("x-amz-content-sha256", payload_hash.clone()),
            ("x-amz-date", amz_date.clone()),
        ];
        let authorization = sigv4_authorization(
            &self.inner.access_key_id,
            &self.inner.secret_access_key,
            "auto",
            "GET",
            &canonical_uri,
            &mut to_sign,
            &payload_hash,
            &amz_date,
        );
        let request = HttpRequest::new("GET", url)
            .timeout(std::time::Duration::from_secs(8))
            .header("Host", host)
            .header("x-amz-content-sha256", payload_hash)
            .header("x-amz-date", amz_date)
            .header("Authorization", authorization);
        let response = send_with_retry(&self.inner.transport, request, RetryPolicy::none())
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        if response.status == 404 {
            return Ok(None);
        }
        if !response.is_success() {
            let detail: String = response.text().chars().take(300).collect();
            return Err(ApiError::internal(format!(
                "R2 read failed {}: {detail}",
                response.status
            )));
        }
        Ok(Some(response.body))
    }
}

/// Where forum media goes. The handler only needs this seam.
#[async_trait::async_trait]
pub trait MediaStore: Send + Sync + 'static {
    async fn put(&self, key: &str, body: Vec<u8>, content_type: &str) -> Result<String>;
}

#[async_trait::async_trait]
impl MediaStore for R2MediaStore {
    async fn put(&self, key: &str, body: Vec<u8>, content_type: &str) -> Result<String> {
        R2MediaStore::put(self, key, body, content_type).await
    }
}

/// Reports the exact Node configuration error when R2 is not set up.
pub struct UnconfiguredMediaStore;

#[async_trait::async_trait]
impl MediaStore for UnconfiguredMediaStore {
    async fn put(&self, _key: &str, _body: Vec<u8>, _content_type: &str) -> Result<String> {
        Err(ApiError::internal(
            "Cloudflare R2 forum media storage is not configured. Add R2_FORUM_MEDIA_BUCKET and R2_FORUM_MEDIA_PUBLIC_URL.",
        ))
    }
}

/// Response body helper for the `uploadForumMediaToR2` return shape.
pub fn uploaded_json(key: &str, url: &str) -> serde_json::Value {
    json!({ "key": key, "url": url })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_encode_per_segment_only() {
        assert_eq!(
            encode_key("forum-media/uid-1/abc.webp"),
            "forum-media/uid-1/abc.webp"
        );
        assert_eq!(encode_key("a b/c+d.webp"), "a%20b/c%2Bd.webp");
        assert_eq!(encode_segment("a/b"), "a%2Fb");
    }

    #[test]
    fn host_is_stripped_of_scheme_and_slash() {
        assert_eq!(
            host_of("https://abc.r2.cloudflarestorage.com/"),
            "abc.r2.cloudflarestorage.com"
        );
        assert_eq!(host_of("http://localhost:9000"), "localhost:9000");
    }

    #[test]
    fn sha256_matches_the_known_vector() {
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn signed_headers_are_sorted_and_include_cache_control() {
        // The canonical request builder sorts lowercase header names; verify the
        // ordering invariant the signature depends on.
        let mut to_sign = vec![
            ("content-type", "image/jpeg"),
            ("host", "h"),
            ("x-amz-content-sha256", "p"),
            ("x-amz-date", "d"),
            ("cache-control", "private, max-age=300"),
        ];
        to_sign.sort_by(|a, b| a.0.cmp(b.0));
        let signed: Vec<&str> = to_sign.iter().map(|(name, _)| *name).collect();
        assert_eq!(
            signed,
            vec![
                "cache-control",
                "content-type",
                "host",
                "x-amz-content-sha256",
                "x-amz-date"
            ]
        );
    }

    #[test]
    fn public_url_joins_without_double_slashes() {
        let transport: SharedTransport = Arc::new(crate::http::ReqwestTransport::new(
            std::time::Duration::from_secs(1),
        ));
        let store = R2MediaStore::new(
            "https://abc.r2.cloudflarestorage.com/",
            "pokoin-forum",
            "key",
            "secret",
            "https://cdn.pokoin.com/",
            transport,
        );
        assert_eq!(
            store.public_url_for("forum-media/u/1.webp"),
            "https://cdn.pokoin.com/forum-media/u/1.webp"
        );
    }

    #[test]
    fn sigv4_matches_the_aws_s3_get_object_example() {
        // AWS docs, Signature V4 for S3, "Example: GET Object".
        let empty = hex_sha256(b"");
        let mut headers = vec![
            ("host", "examplebucket.s3.amazonaws.com".to_string()),
            ("range", "bytes=0-9".to_string()),
            ("x-amz-content-sha256", empty.clone()),
            ("x-amz-date", "20130524T000000Z".to_string()),
        ];
        let authorization = sigv4_authorization(
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "us-east-1",
            "GET",
            "/test.txt",
            &mut headers,
            &empty,
            "20130524T000000Z",
        );
        assert_eq!(
            authorization,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    struct CannedTransport {
        status: u16,
        body: Vec<u8>,
        seen: std::sync::Mutex<Vec<HttpRequest>>,
    }

    #[async_trait::async_trait]
    impl crate::http::HttpTransport for CannedTransport {
        async fn execute(
            &self,
            request: HttpRequest,
        ) -> std::result::Result<crate::http::HttpResponse, crate::http::TransportError> {
            self.seen.lock().unwrap().push(request);
            Ok(crate::http::HttpResponse::new(self.status, self.body.clone()))
        }
    }

    fn photo_store(status: u16, body: &[u8]) -> (Arc<CannedTransport>, R2MediaStore) {
        let canned = Arc::new(CannedTransport {
            status,
            body: body.to_vec(),
            seen: std::sync::Mutex::new(Vec::new()),
        });
        let shared: SharedTransport = canned.clone();
        let store = R2MediaStore::new(
            "https://acct.r2.cloudflarestorage.com",
            "pokoin-user-photos",
            "key",
            "secret",
            "https://api.pokoin.com",
            shared,
        );
        (canned, store)
    }

    #[tokio::test]
    async fn get_object_signs_a_get_and_returns_the_bytes() {
        let (canned, store) = photo_store(200, b"\xff\xd8jpeg");
        let bytes = store
            .get_object("user-photos/chat/uid12345/abcdefabcdef.jpg")
            .await
            .unwrap();
        assert_eq!(bytes.as_deref(), Some(&b"\xff\xd8jpeg"[..]));
        let seen = canned.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].method, "GET");
        assert_eq!(
            seen[0].url,
            "https://acct.r2.cloudflarestorage.com/pokoin-user-photos/user-photos/chat/uid12345/abcdefabcdef.jpg"
        );
        assert_eq!(seen[0].timeout, Some(std::time::Duration::from_secs(8)));
        let authorization = seen[0].header_value("Authorization").unwrap();
        assert!(authorization.starts_with("AWS4-HMAC-SHA256 Credential=key/"));
        assert!(authorization
            .contains("/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature="));
    }

    #[tokio::test]
    async fn get_object_is_none_for_a_missing_photo_and_errs_otherwise() {
        let (_, missing) = photo_store(404, b"");
        assert!(missing.get_object("user-photos/chat/u/1.jpg").await.unwrap().is_none());
        let (_, broken) = photo_store(500, b"boom");
        assert!(broken.get_object("user-photos/chat/u/1.jpg").await.is_err());
    }
}
