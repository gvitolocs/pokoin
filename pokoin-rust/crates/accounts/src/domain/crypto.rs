//! Wallet signature verification (EIP-191 `personal_sign`) and address rules.
//!
//! The Node handlers called `ethers.verifyMessage(message, signature)` and
//! compared the recovered address to the submitted one. This is that
//! computation natively: keccak256 of the EIP-191 framed message, secp256k1
//! public-key recovery, then the last 20 bytes of keccak256 of the uncompressed
//! key as the address.

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sha3::{Digest, Keccak256};

/// `^0x[a-f0-9]{40}$` — the normalized (lowercase) address the Node code stores.
pub fn normalize_address(address: &str) -> Option<String> {
    let normalized = address.trim().to_ascii_lowercase();
    if is_normalized_address(&normalized) {
        Some(normalized)
    } else {
        None
    }
}

pub fn is_normalized_address(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("0x") else {
        return false;
    };
    hex.len() == 40 && hex.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// `^0x[a-fA-F0-9]+$` — the looser check the Node handlers applied first.
pub fn is_signature_shaped(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("0x") else {
        return false;
    };
    !hex.is_empty() && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `0x` + 130 hex characters (r ‖ s ‖ v).
pub fn is_full_signature(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("0x") else {
        return false;
    };
    hex.len() == 130 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Debug, thiserror::Error)]
pub enum WalletSignatureError {
    #[error("signature is not 65 bytes of hex")]
    Malformed,
    #[error("signature recovery failed")]
    Recovery,
    #[error("signature recovery id is out of range")]
    RecoveryId,
}

fn keccak256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// The EIP-191 `personal_sign` digest:
/// `keccak256("\x19Ethereum Signed Message:\n" + decimal_len + message)`.
pub fn personal_sign_digest(message: &str) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let mut buffer = Vec::with_capacity(prefix.len() + message.len());
    buffer.extend_from_slice(prefix.as_bytes());
    buffer.extend_from_slice(message.as_bytes());
    keccak256(&buffer)
}

/// Recover the lowercase checksum-free address that produced `signature` over
/// `message`. Mirrors `ethers.verifyMessage(...).toLowerCase()`.
pub fn recover_address(message: &str, signature: &str) -> Result<String, WalletSignatureError> {
    let hex = signature
        .trim()
        .strip_prefix("0x")
        .ok_or(WalletSignatureError::Malformed)?;
    if hex.len() != 130 {
        return Err(WalletSignatureError::Malformed);
    }
    let bytes = hex::decode(hex).map_err(|_| WalletSignatureError::Malformed)?;

    let signature = Signature::from_slice(&bytes[..64]).map_err(|_| WalletSignatureError::Malformed)?;
    let raw_v = bytes[64];
    // ethers accepts 27/28 (and 0/1); normalize both conventions.
    let recovery_id = match raw_v {
        27 | 28 => raw_v - 27,
        0 | 1 => raw_v,
        2 | 3 => raw_v,
        _ => return Err(WalletSignatureError::RecoveryId),
    };
    let recovery_id =
        RecoveryId::from_byte(recovery_id).ok_or(WalletSignatureError::RecoveryId)?;

    let digest = personal_sign_digest(message);
    let verifying_key = VerifyingKey::recover_from_prehash(&digest, &signature, recovery_id)
        .map_err(|_| WalletSignatureError::Recovery)?;

    let encoded = verifying_key.to_encoded_point(false);
    let public_key = encoded.as_bytes();
    // `to_encoded_point(false)` is 0x04 ‖ X ‖ Y.
    if public_key.len() != 65 {
        return Err(WalletSignatureError::Recovery);
    }
    let hash = keccak256(&public_key[1..]);
    Ok(format!("0x{}", hex::encode(&hash[12..])))
}

/// `ethers.verifyMessage(...).toLowerCase() === normalizedAddress`.
pub fn signature_matches_address(
    message: &str,
    signature: &str,
    address: &str,
) -> Result<bool, WalletSignatureError> {
    Ok(recover_address(message, signature)? == address)
}

/// The exact sign-in message the Node `wallet-auth-nonce` handler builds.
pub fn wallet_sign_in_message(address: &str, nonce: &str, issued_at: &str) -> String {
    [
        "Sign in to Pokoin",
        "",
        &format!("Wallet: {address}"),
        &format!("Nonce: {nonce}"),
        &format!("Issued At: {issued_at}"),
        "Domain: pokoin.com",
    ]
    .join("\n")
}

/// A 128-bit hex nonce, like Node `crypto.randomBytes(16).toString('hex')`.
pub fn random_nonce() -> String {
    let bytes: [u8; 16] = rand::random();
    hex::encode(bytes)
}

/// A 192-bit hex session id, like Node `crypto.randomBytes(24).toString('hex')`.
pub fn random_session_id() -> String {
    let bytes: [u8; 24] = rand::random();
    hex::encode(bytes)
}

/// `^[a-f0-9]{48}$` — the wallet link session id shape.
pub fn is_session_id(value: &str) -> bool {
    value.len() == 48 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    /// Sign a message the way a wallet does, so recovery can be checked for
    /// real without any network or external tooling.
    fn sign_message(message: &str, key: &SigningKey) -> String {
        let digest = personal_sign_digest(message);
        let (signature, recovery_id) = key
            .sign_prehash_recoverable(&digest)
            .expect("signing works");
        let mut bytes = [0u8; 65];
        bytes[..64].copy_from_slice(&signature.to_bytes());
        // Wallets emit the 27/28 convention.
        bytes[64] = recovery_id.to_byte() + 27;
        format!("0x{}", hex::encode(bytes))
    }

    fn address_for(key: &SigningKey) -> String {
        let verifying = VerifyingKey::from(key);
        let encoded = verifying.to_encoded_point(false);
        let hash = keccak256(&encoded.as_bytes()[1..]);
        format!("0x{}", hex::encode(&hash[12..]))
    }

    #[test]
    fn recovers_the_signing_address() {
        let key = SigningKey::from_bytes(&[7u8; 32].into()).unwrap();
        let address = address_for(&key);
        let message = wallet_sign_in_message(
            &address,
            "0123456789abcdef0123456789abcdef",
            "2026-10-08T00:00:00.000Z",
        );
        let signature = sign_message(&message, &key);
        assert_eq!(recover_address(&message, &signature).unwrap(), address);
        assert!(signature_matches_address(&message, &signature, &address).unwrap());
    }

    #[test]
    fn a_different_message_does_not_match() {
        let key = SigningKey::from_bytes(&[9u8; 32].into()).unwrap();
        let address = address_for(&key);
        let signature = sign_message("original", &key);
        assert!(!signature_matches_address("tampered", &signature, &address).unwrap());
    }

    #[test]
    fn a_second_key_does_not_recover_to_the_first_address() {
        let first = SigningKey::from_bytes(&[1u8; 32].into()).unwrap();
        let second = SigningKey::from_bytes(&[2u8; 32].into()).unwrap();
        let signature = sign_message("hello", &second);
        assert!(!signature_matches_address("hello", &signature, &address_for(&first)).unwrap());
    }

    #[test]
    fn signatures_with_v_of_zero_or_one_also_recover() {
        let key = SigningKey::from_bytes(&[5u8; 32].into()).unwrap();
        let address = address_for(&key);
        let digest = personal_sign_digest("payload");
        let (signature, recovery_id) = key.sign_prehash_recoverable(&digest).unwrap();
        let mut bytes = [0u8; 65];
        bytes[..64].copy_from_slice(&signature.to_bytes());
        bytes[64] = recovery_id.to_byte(); // 0/1 convention
        let raw = format!("0x{}", hex::encode(bytes));
        assert_eq!(recover_address("payload", &raw).unwrap(), address);
    }

    #[test]
    fn malformed_signatures_are_rejected() {
        assert!(matches!(
            recover_address("m", "0xdeadbeef"),
            Err(WalletSignatureError::Malformed)
        ));
        assert!(matches!(
            recover_address("m", "deadbeef"),
            Err(WalletSignatureError::Malformed)
        ));
        let bad_v = format!("0x{}ff", "11".repeat(64));
        assert!(matches!(
            recover_address("m", &bad_v),
            Err(WalletSignatureError::RecoveryId)
        ));
    }

    #[test]
    fn message_layout_matches_the_node_handler() {
        let message = wallet_sign_in_message("0xabc", "n1", "2026-01-01T00:00:00.000Z");
        assert_eq!(
            message,
            "Sign in to Pokoin\n\nWallet: 0xabc\nNonce: n1\nIssued At: 2026-01-01T00:00:00.000Z\nDomain: pokoin.com"
        );
    }

    #[test]
    fn address_normalization_matches_the_node_regex() {
        assert_eq!(
            normalize_address("  0xABCDEF0123456789ABCDEF0123456789ABCDEF01 ").unwrap(),
            "0xabcdef0123456789abcdef0123456789abcdef01"
        );
        assert!(normalize_address("0x123").is_none());
        assert!(normalize_address("abcdef0123456789abcdef0123456789abcdef01").is_none());
        assert!(normalize_address("0xZZcdef0123456789abcdef0123456789abcdef01").is_none());
    }

    #[test]
    fn nonce_and_session_shapes_match_node() {
        let nonce = random_nonce();
        assert_eq!(nonce.len(), 32);
        assert!(nonce.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(nonce, random_nonce());

        let session = random_session_id();
        assert_eq!(session.len(), 48);
        assert!(is_session_id(&session));
        assert!(!is_session_id(&session.to_uppercase()));
        assert!(!is_session_id("too-short"));
    }

    #[test]
    fn signature_shape_helpers() {
        assert!(is_signature_shaped("0xABcd"));
        assert!(!is_signature_shaped("0x"));
        assert!(!is_signature_shaped("ABcd"));
        let full = format!("0x{}", "ab".repeat(65));
        assert!(is_full_signature(&full));
        assert!(!is_full_signature("0xabcd"));
    }
}
