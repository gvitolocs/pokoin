//! Pending-signup token/password handling — a port of `api/_pending_signup.js`.
//!
//! * `hashValue` — sha256 hex of a value (token or email lookup key).
//! * `newSignupToken` — 32 random bytes, base64url without padding.
//! * `encryptPassword` / `decryptPassword` — AES-256-GCM over the UTF-8
//!   password, serialized as `iv.tag.ciphertext`, all base64url, with the key
//!   derived as `sha256(secret)`.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::error::{ApiError, Result};

const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;

fn b64url() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

/// `crypto.createHash('sha256').update(value).digest('hex')`.
pub fn hash_value(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

/// `crypto.randomBytes(32).toString('base64url')`.
pub fn new_signup_token() -> String {
    let bytes: [u8; 32] = rand::random();
    b64url().encode(bytes)
}

/// The 32-byte AES key: `sha256(secret)`.
pub fn secret_key(secret: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    let digest = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

/// Which secret the Node module picked, in its own order.
pub fn resolve_secret(
    signup_encryption_secret: Option<&str>,
    firebase_private_key: Option<&str>,
    resend_api_key: Option<&str>,
) -> Result<String> {
    // JavaScript `a || b || c`: an empty string is falsy and falls through.
    [signup_encryption_secret, firebase_private_key, resend_api_key]
        .into_iter()
        .flatten()
        .find(|secret| !secret.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ApiError::internal("Pending signup encryption secret is missing."))
}

/// `encryptPassword(password)` → `iv.tag.ciphertext` (base64url segments).
pub fn encrypt_password(secret: &str, password: &str) -> Result<String> {
    let key_bytes = secret_key(secret);
    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|_| ApiError::internal("Pending signup encryption failed."))?;
    let iv: [u8; IV_LEN] = rand::random();
    let nonce = Nonce::from(iv);
    let ciphertext = cipher
        .encrypt(&nonce, password.as_bytes())
        .map_err(|_| ApiError::internal("Pending signup encryption failed."))?;
    // The `aes-gcm` crate appends the 16-byte tag to the ciphertext; Node kept
    // it as a separate segment, so split it back out.
    if ciphertext.len() < TAG_LEN {
        return Err(ApiError::internal("Pending signup encryption failed."));
    }
    let split = ciphertext.len() - TAG_LEN;
    let (body, tag) = ciphertext.split_at(split);
    Ok(format!(
        "{}.{}.{}",
        b64url().encode(iv),
        b64url().encode(tag),
        b64url().encode(body)
    ))
}

/// `decryptPassword(payload)`. A malformed payload is a 400, exactly like Node.
pub fn decrypt_password(secret: &str, payload: &str) -> Result<String> {
    let invalid = || ApiError::bad_request("Pending signup payload is invalid.");
    let mut segments = payload.split('.');
    let (Some(iv_raw), Some(tag_raw), Some(body_raw), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return Err(invalid());
    };
    let iv = b64url().decode(iv_raw).map_err(|_| invalid())?;
    let tag = b64url().decode(tag_raw).map_err(|_| invalid())?;
    let body = b64url().decode(body_raw).map_err(|_| invalid())?;
    if iv.len() != IV_LEN || tag.len() != TAG_LEN {
        return Err(invalid());
    }

    let key_bytes = secret_key(secret);
    let cipher =
        Aes256Gcm::new_from_slice(&key_bytes).map_err(|_| invalid())?;
    let iv_array: [u8; IV_LEN] = iv.as_slice().try_into().map_err(|_| invalid())?;
    let nonce = Nonce::from(iv_array);
    let mut joined = body;
    joined.extend_from_slice(&tag);
    let plaintext = cipher.decrypt(&nonce, joined.as_slice()).map_err(|_| invalid())?;
    String::from_utf8(plaintext).map_err(|_| invalid())
}

/// The `safeRedirectPath` rule: an absolute site path, never protocol-relative.
pub fn safe_redirect_path(value: &str) -> String {
    let raw = value.trim();
    if raw.starts_with('/') && !raw.starts_with("//") {
        raw.to_string()
    } else {
        "/".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_value_is_sha256_hex() {
        assert_eq!(
            hash_value("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(hash_value("").len(), 64);
    }

    #[test]
    fn signup_tokens_are_base64url_and_unique() {
        let token = new_signup_token();
        // 32 bytes -> 43 base64url characters with no padding.
        assert_eq!(token.len(), 43);
        assert!(!token.contains('='));
        assert!(!token.contains('+'));
        assert!(!token.contains('/'));
        assert_ne!(token, new_signup_token());
    }

    #[test]
    fn password_round_trips() {
        let payload = encrypt_password("secret", "hunter2!").unwrap();
        assert_eq!(payload.split('.').count(), 3);
        assert_eq!(decrypt_password("secret", &payload).unwrap(), "hunter2!");
    }

    #[test]
    fn password_round_trips_unicode_and_empty() {
        for password in ["", "pässwörd", "🔐 emoji", &"x".repeat(200)] {
            let payload = encrypt_password("k", password).unwrap();
            assert_eq!(decrypt_password("k", &payload).unwrap(), password);
        }
    }

    #[test]
    fn a_wrong_secret_fails_closed() {
        let payload = encrypt_password("right", "hunter2!").unwrap();
        assert!(decrypt_password("wrong", &payload).is_err());
    }

    #[test]
    fn a_tampered_payload_fails_closed() {
        let payload = encrypt_password("s", "hunter2!").unwrap();
        let mut parts: Vec<String> = payload.split('.').map(str::to_string).collect();
        // Flip a byte of the ciphertext.
        let mut body = b64url().decode(&parts[2]).unwrap();
        body[0] ^= 0xff;
        parts[2] = b64url().encode(body);
        let tampered = parts.join(".");
        assert!(decrypt_password("s", &tampered).is_err());
    }

    #[test]
    fn malformed_payloads_are_400() {
        for payload in ["", "only-one", "a.b", "a.b.c.d", "!!!.@@@.###"] {
            let error = decrypt_password("s", payload).unwrap_err();
            assert_eq!(error.status(), axum::http::StatusCode::BAD_REQUEST, "{payload}");
        }
    }

    #[test]
    fn encrypted_payloads_use_fresh_ivs() {
        let first = encrypt_password("k", "same").unwrap();
        let second = encrypt_password("k", "same").unwrap();
        assert_ne!(first, second);
        assert_ne!(first.split('.').next(), second.split('.').next());
    }

    #[test]
    fn secret_resolution_follows_the_node_order() {
        assert_eq!(
            resolve_secret(Some("a"), Some("b"), Some("c")).unwrap(),
            "a"
        );
        assert_eq!(resolve_secret(None, Some("b"), Some("c")).unwrap(), "b");
        assert_eq!(resolve_secret(None, None, Some("c")).unwrap(), "c");
        assert_eq!(resolve_secret(Some(""), None, Some("c")).unwrap(), "c");
        assert!(resolve_secret(None, None, None).is_err());
    }

    #[test]
    fn redirect_paths_are_never_protocol_relative() {
        assert_eq!(safe_redirect_path("/auth?x=1"), "/auth?x=1");
        assert_eq!(safe_redirect_path("//evil.com"), "/");
        assert_eq!(safe_redirect_path("https://evil.com"), "/");
        assert_eq!(safe_redirect_path(""), "/");
        assert_eq!(safe_redirect_path("  /profile  "), "/profile");
    }
}
