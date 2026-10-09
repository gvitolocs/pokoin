//! Native crypto for the external domain. No Node, no JS engine:
//! AES-256-GCM secret envelope, HMAC-SHA256 webhook signatures,
//! SHA-256 hex digests, random pins/secrets, and R2 SigV4 signing.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::{ApiError, ApiResult};

pub const ENCRYPTION_ALGORITHM: &str = "aes-256-gcm";
pub const ENCRYPTION_VERSION: i64 = 1;
const KEY_BYTES: usize = 32;
const IV_BYTES: usize = 12;

/// `parseEncryptionKey` — hex(64), base64, or raw UTF-8, must decode to 32 bytes.
pub fn parse_encryption_key(raw: Option<&str>) -> ApiResult<Vec<u8>> {
    let value = raw.unwrap_or_default().trim();
    if value.is_empty() {
        return Err(ApiError::new(500, "CARDTRADER_TOKEN_ENCRYPTION_KEY is not configured.")
            .with_code("cardtrader_encryption_config"));
    }
    if value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(hex::decode(value).unwrap_or_default());
    }
    if let Ok(decoded) = B64.decode(value.as_bytes()) {
        if decoded.len() == KEY_BYTES {
            return Ok(decoded);
        }
    }
    let utf8 = value.as_bytes().to_vec();
    if utf8.len() == KEY_BYTES {
        return Ok(utf8);
    }
    Err(ApiError::new(500, "CARDTRADER_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.")
        .with_code("cardtrader_encryption_config"))
}

/// `encryptSecret` — the {version, algorithm, iv, tag, ciphertext} envelope.
pub fn encrypt_secret(plaintext: &str, raw_key: Option<&str>) -> Option<Value> {
    if plaintext.is_empty() {
        return None;
    }
    let key = parse_encryption_key(raw_key).ok()?;
    let mut iv_bytes = [0u8; IV_BYTES];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut iv_bytes);
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    let mut sealed = cipher
        .encrypt(Nonce::from_slice(&iv_bytes), Payload { msg: plaintext.as_bytes(), aad: &[] })
        .ok()?;
    let tag = sealed.split_off(sealed.len() - 16);
    Some(json!({
        "version": ENCRYPTION_VERSION,
        "algorithm": ENCRYPTION_ALGORITHM,
        "iv": B64.encode(iv_bytes),
        "tag": B64.encode(&tag),
        "ciphertext": B64.encode(&sealed),
    }))
}

/// `decryptSecret` — returns "" for empty input like the Node helper.
pub fn decrypt_secret(encrypted: &Value, raw_key: Option<&str>) -> ApiResult<String> {
    if encrypted.is_null() {
        return Ok(String::new());
    }
    if encrypted.get("version").and_then(Value::as_i64) != Some(ENCRYPTION_VERSION)
        || encrypted.get("algorithm").and_then(Value::as_str) != Some(ENCRYPTION_ALGORITHM)
    {
        return Err(ApiError::new(500, "Unsupported CardTrader secret encryption format."));
    }
    let key = parse_encryption_key(raw_key)?;
    let iv = B64.decode(encrypted.get("iv").and_then(Value::as_str).unwrap_or("").as_bytes())
        .map_err(|_| ApiError::new(500, "Unsupported CardTrader secret encryption format."))?;
    let tag = B64.decode(encrypted.get("tag").and_then(Value::as_str).unwrap_or("").as_bytes())
        .map_err(|_| ApiError::new(500, "Unsupported CardTrader secret encryption format."))?;
    let ciphertext = B64
        .decode(encrypted.get("ciphertext").and_then(Value::as_str).unwrap_or("").as_bytes())
        .map_err(|_| ApiError::new(500, "Unsupported CardTrader secret encryption format."))?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| ApiError::new(500, "Unsupported CardTrader secret encryption format."))?;
    let mut sealed = ciphertext;
    sealed.extend_from_slice(&tag);
    let plain = cipher
        .decrypt(Nonce::from_slice(&iv), Payload { msg: &sealed, aad: &[] })
        .map_err(|_| ApiError::new(500, "Unsupported CardTrader secret encryption format."))?;
    String::from_utf8(plain).map_err(|_| ApiError::new(500, "Unsupported CardTrader secret encryption format."))
}

pub fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

/// `verifyWebhookSignature` — HMAC-SHA256 base64 over the RAW request body,
/// constant-time comparison. The raw-body requirement is load-bearing:
/// re-serialized JSON breaks every signature.
pub fn verify_webhook_signature(raw_body: &[u8], signature_header: &str, shared_secret: &str) -> bool {
    if shared_secret.is_empty() {
        return false;
    }
    let mut mac = match <Hmac<Sha256> as Mac>::new_from_slice(shared_secret.as_bytes()) {
        Ok(mac) => mac,
        Err(_) => return false,
    };
    mac.update(raw_body);
    let expected = match mac.finalize().into_bytes() {
        bytes => B64.encode(bytes),
    };
    let provided = signature_header.trim();
    if provided.is_empty() || expected.is_empty() {
        return false;
    }
    constant_time_eq(expected.as_bytes(), provided.as_bytes())
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// `randomPin` — 4 digits, zero padded ("0042").
pub fn random_pin(rng: &mut impl rand::RngCore) -> String {
    let value = rng.next_u32() % 10_000;
    format!("{value:04}")
}

/// `randomSecret` — base64url of `bytes` random bytes.
pub fn random_secret(bytes: usize, rng: &mut impl rand::RngCore) -> String {
    let mut buf = vec![0u8; bytes];
    rng.fill_bytes(&mut buf);
    B64URL.encode(buf)
}

/// Percent-encode for SigV4 canonical URIs (unreserved = A–Z a–z 0–9 - _ . ~).
pub fn uri_encode(value: &str, encode_slash: bool) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if unreserved || (byte == b'/' && !encode_slash) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// AWS SigV4 signature for R2 (service "s3", region "auto"). Pure Rust,
/// no AWS SDK — this is the only signing R2 needs.
pub fn sigv4_headers(
    method: &str,
    host: &str,
    canonical_uri: &str,
    query: &str,
    payload_sha256: &[u8],
    access_key: &str,
    secret_key: &str,
    now: sigv4_time::SigV4Time,
) -> Vec<(String, String)> {
    let amz_date = now.amz_date();
    let date_stamp = now.date_stamp();
    let payload_hash = hex::encode(payload_sha256);
    let canonical_headers = format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n");
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "{method}\n{}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}",
        uri_encode(canonical_uri, false),
    );
    let scope = format!("{date_stamp}/auto/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let k_date = hmac_sha256(format!("AWS4{secret_key}").as_bytes(), date_stamp.as_bytes());
    let k_scope = hmac_sha256(&k_date, b"auto/s3/aws4_request");
    let signing_key = hmac_sha256(&k_scope, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));
    vec![
        ("Authorization".into(), format!("AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}")),
        ("x-amz-date".into(), amz_date),
        ("x-amz-content-sha256".into(), payload_hash),
    ]
}

pub mod sigv4_time {
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;

    pub struct SigV4Time {
        pub utc: OffsetDateTime,
    }

    impl SigV4Time {
        pub fn now() -> Self {
            Self { utc: OffsetDateTime::now_utc() }
        }
        pub fn amz_date(&self) -> String {
            self.utc.format(&Rfc3339).unwrap_or_default().replace(['-', ':', '.'], "").split('+').next().unwrap_or_default().to_string()
        }
        pub fn date_stamp(&self) -> String {
            self.amz_date().get(..8).unwrap_or_default().to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn key_parsing_accepts_hex_base64_and_utf8() {
        assert_eq!(parse_encryption_key(Some(KEY)).unwrap().len(), 32);
        let b64 = B64.encode([7u8; 32]);
        assert_eq!(parse_encryption_key(Some(&b64)).unwrap(), vec![7u8; 32]);
        let raw = "abcdefghijklmnopqrstuvwxyz012345";
        assert_eq!(parse_encryption_key(Some(raw)).unwrap().len(), 32);
        assert!(parse_encryption_key(Some("short")).is_err());
        assert!(parse_encryption_key(None).is_err());
    }

    #[test]
    fn secret_envelope_round_trips_and_rejects_tampering() {
        let envelope = encrypt_secret("cardtrader-jwt-token", Some(KEY)).unwrap();
        assert_eq!(envelope["algorithm"], "aes-256-gcm");
        assert_eq!(envelope["version"], 1);
        assert_eq!(decrypt_secret(&envelope, Some(KEY)).unwrap(), "cardtrader-jwt-token");

        let mut tampered = envelope.clone();
        tampered["ciphertext"] = json!("AAAA");
        assert!(decrypt_secret(&tampered, Some(KEY)).is_err());
        assert_eq!(decrypt_secret(&Value::Null, Some(KEY)).unwrap(), "");
    }

    #[test]
    fn encrypt_secret_none_for_empty() {
        assert!(encrypt_secret("", Some(KEY)).is_none());
    }

    #[test]
    fn webhook_signature_matches_node_hmac_shape() {
        let body = br#"{"cause":"order.create","data":{"id":42}}"#;
        let secret = "hub-secret";
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body);
        let signature = B64.encode(mac.finalize().into_bytes());
        assert!(verify_webhook_signature(body, &signature, secret));
        assert!(!verify_webhook_signature(b"other", &signature, secret));
        assert!(!verify_webhook_signature(body, &signature, ""));
        assert!(!verify_webhook_signature(body, "  ", secret));
        // Whitespace around the header is tolerated (Node trims).
        assert!(verify_webhook_signature(body, &format!("  {signature}  "), secret));
    }

    #[test]
    fn pins_and_secrets_shapes() {
        let mut rng = rand::rngs::mock::StepRng::new(1, 1);
        assert_eq!(random_pin(&mut rng).len(), 4);
        let secret = random_secret(32, &mut rng);
        assert!(secret.len() >= 40);
        assert!(secret.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn sigv4_signature_is_deterministic() {
        let t = sigv4_time::SigV4Time { utc: time::macros::datetime!(2026-10-08 12:00:00 UTC) };
        let a = sigv4_headers("GET", "acct.r2.cloudflarestorage.com", "/bucket/key.jpg", "", b"".as_ref(), "AK", "SK", sigv4_time::SigV4Time { utc: t.utc });
        let b = sigv4_headers("GET", "acct.r2.cloudflarestorage.com", "/bucket/key.jpg", "", b"".as_ref(), "AK", "SK", sigv4_time::SigV4Time { utc: t.utc });
        assert_eq!(a, b);
        assert!(a[0].1.starts_with("AWS4-HMAC-SHA256 Credential=AK/"));
        assert_eq!(a[1].1, "20261008T120000Z");
    }
}
