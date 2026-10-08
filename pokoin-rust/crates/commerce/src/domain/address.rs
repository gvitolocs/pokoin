//! Buyer shipping addresses: validation plus Node-compatible AES-256-GCM
//! envelope encryption, ported from `_address_crypto.js` and the address
//! helpers in `_checkout_core.js`.
//!
//! The stored envelope keeps the exact shape the Node writer produced:
//! `{ version: 1, algorithm: 'aes-256-gcm', iv, tag, ciphertext }` with base64
//! fields, so rows written by either runtime stay readable.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::country::normalize_country;
use crate::domain::trim_text;
use crate::error::{ApiError, ApiResult};

pub const ENCRYPTION_ALGORITHM: &str = "aes-256-gcm";
pub const ENCRYPTION_VERSION: i32 = 1;
const KEY_BYTES: usize = 32;
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedPayload {
    pub version: i32,
    pub algorithm: String,
    pub iv: String,
    pub tag: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AddressFields {
    pub full_name: String,
    pub company_name: String,
    pub address_line1: String,
    pub address_line2: String,
    pub postal_code: String,
    pub city: String,
    pub state_province_region: String,
    pub country_code: String,
    pub phone_number: String,
    pub delivery_instructions: String,
}

impl AddressFields {
    /// The plaintext JSON the Node writer stored inside the envelope.
    pub fn to_plaintext(&self) -> Value {
        serde_json::json!({
            "fullName": self.full_name,
            "companyName": self.company_name,
            "addressLine1": self.address_line1,
            "addressLine2": self.address_line2,
            "postalCode": self.postal_code,
            "city": self.city,
            "stateProvinceRegion": self.state_province_region,
            "phoneNumber": self.phone_number,
            "deliveryInstructions": self.delivery_instructions,
        })
    }

    pub fn from_plaintext(value: &Value) -> Self {
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        Self {
            full_name: text("fullName"),
            company_name: text("companyName"),
            address_line1: text("addressLine1"),
            address_line2: text("addressLine2"),
            postal_code: text("postalCode"),
            city: text("city"),
            state_province_region: text("stateProvinceRegion"),
            // countryCode is a queryable column, never part of the ciphertext.
            country_code: String::new(),
            phone_number: text("phoneNumber"),
            delivery_instructions: text("deliveryInstructions"),
        }
    }
}

fn config_error(message: &str) -> ApiError {
    ApiError::internal(message).with_code("address_encryption_config")
}

/// Lenient base64 decode with `Buffer.from(value, 'base64')` semantics:
/// unknown characters are dropped and padding is repaired.
fn lenient_base64(value: &str) -> Vec<u8> {
    let cleaned: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/' || *c == '=')
        .collect();
    let unpadded = cleaned.trim_end_matches('=');
    let mut padded = unpadded.to_string();
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    STANDARD.decode(padded).unwrap_or_default()
}

/// `parseAddressKey`: first candidate that decodes to exactly 32 bytes wins,
/// trying hex, then base64, then raw UTF-8.
pub fn parse_address_key(raw: Option<&str>) -> ApiResult<[u8; KEY_BYTES]> {
    let value = raw.unwrap_or_default().trim();
    if value.is_empty() {
        return Err(config_error("ADDRESS_ENCRYPTION_KEY is not configured."));
    }

    let mut candidates: Vec<Vec<u8>> = Vec::new();
    if value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()) {
        candidates.push(hex::decode(value).unwrap_or_default());
    }
    candidates.push(lenient_base64(value));
    candidates.push(value.as_bytes().to_vec());

    for candidate in candidates {
        if candidate.len() == KEY_BYTES {
            let mut key = [0u8; KEY_BYTES];
            key.copy_from_slice(&candidate);
            return Ok(key);
        }
    }
    Err(config_error(
        "ADDRESS_ENCRYPTION_KEY must decode to exactly 32 bytes.",
    ))
}

pub fn encrypt_address_payload(fields: &AddressFields, raw_key: Option<&str>) -> ApiResult<EncryptedPayload> {
    encrypt_address_value(&fields.to_plaintext(), raw_key)
}

/// `encryptAddressPayload` for any JSON object.
///
/// The order's shipping snapshot is not just the address fields: it carries the
/// country and the source address id too, so the envelope has to accept a
/// general object.
pub fn encrypt_address_value(value: &Value, raw_key: Option<&str>) -> ApiResult<EncryptedPayload> {
    let key = parse_address_key(raw_key)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let mut iv = [0u8; IV_BYTES];
    rand::thread_rng().fill_bytes(&mut iv);
    let plaintext = serde_json::to_vec(value)
        .map_err(|_| config_error("Address payload could not be serialized."))?;
    let mut sealed = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext.as_slice())
        .map_err(|_| config_error("Address payload could not be encrypted."))?;
    let tag = sealed.split_off(sealed.len() - TAG_BYTES);
    Ok(EncryptedPayload {
        version: ENCRYPTION_VERSION,
        algorithm: ENCRYPTION_ALGORITHM.to_string(),
        iv: STANDARD.encode(iv),
        tag: STANDARD.encode(tag),
        ciphertext: STANDARD.encode(sealed),
    })
}

/// Tolerant decode for reads: accepts the camelCase JSON the Node writer stored
/// and the snake_case shape this crate serializes.
pub fn decrypt_address_payload(
    encrypted: &EncryptedPayload,
    raw_key: Option<&str>,
) -> ApiResult<AddressFields> {
    let value = decrypt_address_value(encrypted, raw_key)?;
    // Accept both key spellings so a Rust-written row round-trips too.
    Ok(AddressFields {
        full_name: pick(&value, &["fullName", "full_name"]),
        company_name: pick(&value, &["companyName", "company_name"]),
        address_line1: pick(&value, &["addressLine1", "address_line1"]),
        address_line2: pick(&value, &["addressLine2", "address_line2"]),
        postal_code: pick(&value, &["postalCode", "postal_code"]),
        city: pick(&value, &["city"]),
        state_province_region: pick(&value, &["stateProvinceRegion", "state_province_region"]),
        // The column, not the envelope, carries the country.
        country_code: String::new(),
        phone_number: pick(&value, &["phoneNumber", "phone_number"]),
        delivery_instructions: pick(&value, &["deliveryInstructions", "delivery_instructions"]),
    })
}

/// Decrypt any address-encrypted JSON object (the order shipping snapshot).
pub fn decrypt_address_value(
    encrypted: &EncryptedPayload,
    raw_key: Option<&str>,
) -> ApiResult<Value> {
    if encrypted.algorithm != ENCRYPTION_ALGORITHM {
        return Err(ApiError::internal("Unsupported address encryption format."));
    }
    let key = parse_address_key(raw_key)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let iv = lenient_base64(&encrypted.iv);
    if iv.len() != IV_BYTES {
        return Err(ApiError::internal("Unsupported address encryption format."));
    }
    let tag = lenient_base64(&encrypted.tag);
    let mut combined = lenient_base64(&encrypted.ciphertext);
    combined.extend_from_slice(&tag);
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&iv), combined.as_slice())
        .map_err(|_| ApiError::internal("Unsupported address encryption format."))?;
    serde_json::from_slice(&plaintext)
        .map_err(|_| ApiError::internal("Unsupported address encryption format."))
}

fn pick(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

fn first_string(raw: &Value, keys: &[&str]) -> String {
    for key in keys {
        match raw.get(*key) {
            Some(Value::String(text)) if !text.trim().is_empty() => return text.trim().to_string(),
            Some(Value::Number(number)) => return number.to_string(),
            _ => {}
        }
    }
    String::new()
}

/// `normalizeAddressInput`: alias-aware, length-capped, country-normalized.
pub fn normalize_address_input(raw: &Value) -> AddressFields {
    AddressFields {
        full_name: trim_text(&first_string(raw, &["fullName", "name"]), 120),
        company_name: trim_text(&first_string(raw, &["companyName"]), 120),
        address_line1: trim_text(&first_string(raw, &["addressLine1", "line1"]), 180),
        address_line2: trim_text(&first_string(raw, &["addressLine2", "line2"]), 180),
        postal_code: trim_text(&first_string(raw, &["postalCode", "postal_code"]), 40),
        city: trim_text(&first_string(raw, &["city"]), 120),
        state_province_region: trim_text(
            &first_string(raw, &["stateProvinceRegion", "region"]),
            120,
        ),
        country_code: normalize_country(&first_string(raw, &["countryCode", "country"])),
        phone_number: trim_text(&first_string(raw, &["phoneNumber", "phone"]), 80),
        delivery_instructions: trim_text(&first_string(raw, &["deliveryInstructions"]), 240),
    }
}

/// `validateAddressFields`: required fields or a 400 with `invalid_address`.
pub fn validate_address_fields(raw: &Value) -> ApiResult<AddressFields> {
    let fields = normalize_address_input(raw);
    if fields.full_name.is_empty()
        || fields.address_line1.is_empty()
        || fields.postal_code.is_empty()
        || fields.city.is_empty()
        || fields.country_code.is_empty()
    {
        return Err(ApiError::bad_request(
            "Address requires fullName, addressLine1, postalCode, city, and countryCode.",
        )
        .with_code("invalid_address"));
    }
    Ok(fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_generic_envelope_round_trips_extra_keys() {
        // The order snapshot carries the country and source id alongside the
        // address fields, so the envelope must preserve arbitrary keys.
        let key = "22".repeat(32);
        let snapshot = json!({
            "fullName": "Alice Buyer",
            "addressLine1": "Via Roma 1",
            "city": "Roma",
            "countryCode": "IT",
            "sourceAddressId": "addr-1",
            "nested": { "keep": [1, 2, 3] },
        });
        let envelope = encrypt_address_value(&snapshot, Some(&key)).unwrap();
        assert_eq!(envelope.algorithm, "aes-256-gcm");
        assert_eq!(envelope.version, 1);
        // The ciphertext never carries the plaintext.
        assert!(!envelope.ciphertext.contains("Alice"));
        let decoded = decrypt_address_value(&envelope, Some(&key)).unwrap();
        assert_eq!(decoded, snapshot);
        // A different key must not decrypt.
        assert!(decrypt_address_value(&envelope, Some(&"33".repeat(32))).is_err());
    }

    fn sample() -> AddressFields {
        AddressFields {
            full_name: "Giuseppe Vitolo".into(),
            company_name: "Pokoin".into(),
            address_line1: "Via Roma 1".into(),
            address_line2: "Scala B".into(),
            postal_code: "80100".into(),
            city: "Napoli".into(),
            state_province_region: "NA".into(),
            country_code: "IT".into(),
            phone_number: "+39 000".into(),
            delivery_instructions: "Ring twice".into(),
        }
    }

    #[test]
    fn key_parsing_prefers_hex_then_base64_then_utf8() {
        let hex_key = "a".repeat(64);
        assert_eq!(parse_address_key(Some(&hex_key)).unwrap(), [0xaa; 32]);

        let utf8_key = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_address_key(Some(utf8_key)).unwrap(),
            utf8_key.as_bytes()
        );

        let b64 = STANDARD.encode([7u8; 32]);
        assert_eq!(parse_address_key(Some(&b64)).unwrap(), [7u8; 32]);
    }

    #[test]
    fn key_parsing_fails_closed() {
        assert!(parse_address_key(None).is_err());
        assert!(parse_address_key(Some("short")).is_err());
    }

    #[test]
    fn encryption_round_trips_and_stays_node_readable() {
        let key = "b".repeat(64);
        let sealed = encrypt_address_payload(&sample(), Some(&key)).unwrap();
        assert_eq!(sealed.version, 1);
        assert_eq!(sealed.algorithm, "aes-256-gcm");
        assert_eq!(STANDARD.decode(&sealed.iv).unwrap().len(), 12);
        assert_eq!(STANDARD.decode(&sealed.tag).unwrap().len(), 16);

        let opened = decrypt_address_payload(&sealed, Some(&key)).unwrap();
        // countryCode lives on the row, not in the ciphertext.
        assert_eq!(
            opened,
            AddressFields {
                country_code: String::new(),
                ..sample()
            }
        );
        assert_eq!(opened.full_name, "Giuseppe Vitolo");
    }

    /// A payload produced by Node's `_address_crypto.js` (camelCase JSON,
    /// separate tag) must decrypt here. Fixture built with the same algorithm.
    #[test]
    fn decrypts_a_node_shaped_envelope() {
        let key_hex = "c".repeat(64);
        let key = parse_address_key(Some(&key_hex)).unwrap();
        // Encrypt the exact camelCase JSON the Node writer uses.
        let plaintext = serde_json::json!({
            "fullName": "Ada Lovelace",
            "companyName": "",
            "addressLine1": "1 Analytical Way",
            "addressLine2": "",
            "postalCode": "NW1",
            "city": "London",
            "stateProvinceRegion": "",
            "phoneNumber": "",
            "deliveryInstructions": "",
        });
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let iv = [9u8; 12];
        let mut sealed = cipher
            .encrypt(
                Nonce::from_slice(&iv),
                serde_json::to_vec(&plaintext).unwrap().as_slice(),
            )
            .unwrap();
        let tag = sealed.split_off(sealed.len() - TAG_BYTES);
        let envelope = EncryptedPayload {
            version: 1,
            algorithm: "aes-256-gcm".into(),
            iv: STANDARD.encode(iv),
            tag: STANDARD.encode(tag),
            ciphertext: STANDARD.encode(sealed),
        };
        let fields = decrypt_address_payload(&envelope, Some(&key_hex)).unwrap();
        assert_eq!(fields.full_name, "Ada Lovelace");
        assert_eq!(fields.city, "London");
    }

    #[test]
    fn rejects_foreign_algorithms() {
        let envelope = EncryptedPayload {
            version: 1,
            algorithm: "aes-128-gcm".into(),
            iv: String::new(),
            tag: String::new(),
            ciphertext: String::new(),
        };
        assert!(decrypt_address_payload(&envelope, Some(&"d".repeat(64))).is_err());
    }

    #[test]
    fn validation_requires_the_five_core_fields() {
        let raw = serde_json::json!({
            "fullName": "A", "addressLine1": "B", "postalCode": "1", "city": "C",
        });
        assert!(validate_address_fields(&raw).is_err());

        let raw = serde_json::json!({
            "name": "A", "line1": "B", "postal_code": "1", "city": "C", "country": "it",
        });
        let fields = validate_address_fields(&raw).unwrap();
        assert_eq!(fields.country_code, "IT");
        assert_eq!(fields.full_name, "A");
    }
}
