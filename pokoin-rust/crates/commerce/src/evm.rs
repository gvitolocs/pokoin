//! Native EVM transaction encoding and EIP-155 signing.
//!
//! The payout paths (PKN bank/reserve, EVM native coins and ERC-20 tokens) build
//! and sign legacy transactions here and submit them as raw transactions over
//! JSON-RPC. No Node, no external signer service.
//!
//! Everything is pure and testable: RLP encoding, the ERC-20 `transfer`
//! calldata, the EIP-155 signing hash, the `v` derivation and address recovery.

use k256::ecdsa::{RecoveryId, SigningKey, VerifyingKey};
use sha3::{Digest, Keccak256};

use crate::error::{ApiError, StoreError};

/// keccak256("transfer(address,uint256)") first four bytes.
pub const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

// ---------------------------------------------------------------------------
// RLP
// ---------------------------------------------------------------------------

/// RLP encode one byte string (single byte < 0x80 encodes as itself).
pub fn rlp_encode_bytes(data: &[u8]) -> Vec<u8> {
    if data.len() == 1 && data[0] < 0x80 {
        return data.to_vec();
    }
    encode_length(data.len(), 0x80)
        .into_iter()
        .chain(data.iter().copied())
        .collect()
}

/// RLP encode a list of already-encoded items.
pub fn rlp_encode_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.iter().flatten().copied().collect();
    encode_length(payload.len(), 0xc0)
        .into_iter()
        .chain(payload)
        .collect()
}

fn encode_length(length: usize, offset: u8) -> Vec<u8> {
    if length < 56 {
        return vec![offset + length as u8];
    }
    let encoded = minimal_bytes(length as u128);
    let mut out = vec![offset + 55 + encoded.len() as u8];
    out.extend_from_slice(&encoded);
    out
}

/// Minimal big-endian bytes; zero encodes as the empty string.
pub fn minimal_bytes(value: u128) -> Vec<u8> {
    if value == 0 {
        return Vec::new();
    }
    let bytes = value.to_be_bytes();
    let first = bytes.iter().position(|byte| *byte != 0).unwrap_or(15);
    bytes[first..].to_vec()
}

/// RLP encode a u128 as a big-endian integer.
pub fn rlp_encode_uint(value: u128) -> Vec<u8> {
    rlp_encode_bytes(&minimal_bytes(value))
}

/// RLP encode a hex address (`0x…`, 20 bytes).
pub fn rlp_encode_address(address: &str) -> Result<Vec<u8>, ApiError> {
    let normalized = address.trim().to_ascii_lowercase();
    let digits = normalized.strip_prefix("0x").unwrap_or(&normalized);
    if digits.len() != 40 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request("Enter a valid 0x address."));
    }
    let bytes = hex::decode(digits)
        .map_err(|_| ApiError::bad_request("Enter a valid 0x address."))?;
    Ok(rlp_encode_bytes(&bytes))
}

// ---------------------------------------------------------------------------
// ERC-20 calldata
// ---------------------------------------------------------------------------

/// `transfer(address,uint256)` calldata for an ERC-20 payout.
pub fn erc20_transfer_data(to_address: &str, amount: u128) -> Result<Vec<u8>, ApiError> {
    let normalized = to_address.trim().to_ascii_lowercase();
    let digits = normalized.strip_prefix("0x").unwrap_or(&normalized);
    if digits.len() != 40 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request("Enter a valid 0x address."));
    }
    let address = hex::decode(digits)
        .map_err(|_| ApiError::bad_request("Enter a valid 0x address."))?;
    let mut data = Vec::with_capacity(68);
    data.extend_from_slice(&ERC20_TRANSFER_SELECTOR);
    // address padded to 32 bytes
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(&address);
    // amount padded to 32 bytes (u128 → 16 zero bytes + 16 value bytes)
    data.extend_from_slice(&[0u8; 16]);
    data.extend_from_slice(&amount.to_be_bytes());
    Ok(data)
}

/// `balanceOf(address)` selector: keccak256("balanceOf(address)")[..4].
pub const ERC20_BALANCE_OF_SELECTOR: [u8; 4] = [0x70, 0xa0, 0x82, 0x31];

/// `balanceOf(address)` calldata for a payout-wallet balance read.
pub fn erc20_balance_of_data(owner: &str) -> Result<Vec<u8>, ApiError> {
    let normalized = owner.trim().to_ascii_lowercase();
    let digits = normalized.strip_prefix("0x").unwrap_or(&normalized);
    if digits.len() != 40 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request("Enter a valid 0x address."));
    }
    let address = hex::decode(digits)
        .map_err(|_| ApiError::bad_request("Enter a valid 0x address."))?;
    let mut data = Vec::with_capacity(36);
    data.extend_from_slice(&ERC20_BALANCE_OF_SELECTOR);
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(&address);
    Ok(data)
}

// ---------------------------------------------------------------------------
// Keys and addresses
// ---------------------------------------------------------------------------

/// Parse a 32-byte secp256k1 private key from hex (`0x` optional).
pub fn parse_private_key(raw: &str) -> Result<SigningKey, StoreError> {
    let trimmed = raw.trim();
    let digits = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    if digits.len() != 64 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(StoreError::Invalid(
            "payout private key must be 32 bytes of hex".into(),
        ));
    }
    let bytes = hex::decode(digits).map_err(|_| {
        StoreError::Invalid("payout private key must be 32 bytes of hex".into())
    })?;
    SigningKey::from_slice(&bytes).map_err(|_| {
        StoreError::Invalid("payout private key is not a valid secp256k1 key".into())
    })
}

/// Uncompressed public key → 20-byte `0x` address.
pub fn address_from_verifying_key(key: &VerifyingKey) -> String {
    let point = key.to_encoded_point(false);
    let digest = keccak256(&point.as_bytes()[1..]);
    format!("0x{}", hex::encode(&digest[12..]))
}

pub fn address_from_private_key(raw: &str) -> Result<String, StoreError> {
    let key = parse_private_key(raw)?;
    Ok(address_from_verifying_key(key.verifying_key()))
}

// ---------------------------------------------------------------------------
// EIP-155 legacy transactions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedTransaction {
    /// `0x`-prefixed raw transaction for `eth_sendRawTransaction`.
    pub raw_hex: String,
    /// keccak256 of the raw transaction.
    pub tx_hash: String,
    pub from_address: String,
}

/// The EIP-155 signing hash for a legacy transaction.
#[allow(clippy::too_many_arguments)]
pub fn eip155_signing_hash(
    nonce: u128,
    gas_price: u128,
    gas_limit: u128,
    to: &str,
    value: u128,
    data: &[u8],
    chain_id: u128,
) -> Result<[u8; 32], ApiError> {
    let items = vec![
        rlp_encode_uint(nonce),
        rlp_encode_uint(gas_price),
        rlp_encode_uint(gas_limit),
        rlp_encode_address(to)?,
        rlp_encode_uint(value),
        rlp_encode_bytes(data),
        rlp_encode_uint(chain_id),
        rlp_encode_uint(0),
        rlp_encode_uint(0),
    ];
    Ok(keccak256(&rlp_encode_list(&items)))
}

/// Sign a legacy transaction with EIP-155 replay protection.
#[allow(clippy::too_many_arguments)]
pub fn sign_legacy_transaction(
    private_key: &str,
    chain_id: u128,
    nonce: u128,
    gas_price: u128,
    gas_limit: u128,
    to: &str,
    value: u128,
    data: &[u8],
) -> Result<SignedTransaction, StoreError> {
    let signing_key = parse_private_key(private_key)?;
    let hash = eip155_signing_hash(nonce, gas_price, gas_limit, to, value, data, chain_id)
        .map_err(|error| StoreError::Invalid(error.message))?;
    let (signature, recovery_id) = signing_key
        .sign_prehash_recoverable(&hash)
        .map_err(|_| StoreError::Invalid("could not sign the payout transaction".into()))?;
    let v = chain_id * 2 + 35 + recovery_id.to_byte() as u128;
    let mut r = [0u8; 32];
    r.copy_from_slice(signature.r().to_bytes().as_slice());
    let mut s = [0u8; 32];
    s.copy_from_slice(signature.s().to_bytes().as_slice());

    let items = vec![
        rlp_encode_uint(nonce),
        rlp_encode_uint(gas_price),
        rlp_encode_uint(gas_limit),
        rlp_encode_address(to).map_err(|error| StoreError::Invalid(error.message))?,
        rlp_encode_uint(value),
        rlp_encode_bytes(data),
        rlp_encode_uint(v),
        rlp_encode_bytes(&minimal_32(&r)),
        rlp_encode_bytes(&minimal_32(&s)),
    ];
    let raw = rlp_encode_list(&items);
    let tx_hash = format!("0x{}", hex::encode(keccak256(&raw)));
    Ok(SignedTransaction {
        raw_hex: format!("0x{}", hex::encode(&raw)),
        tx_hash,
        from_address: address_from_verifying_key(signing_key.verifying_key()),
    })
}

/// Strip leading zero bytes from a 32-byte signature component.
fn minimal_32(value: &[u8; 32]) -> Vec<u8> {
    let first = value.iter().position(|byte| *byte != 0).unwrap_or(31);
    let trimmed = &value[first..];
    if trimmed.is_empty() {
        vec![0]
    } else {
        trimmed.to_vec()
    }
}

/// Recover the signing address from a signed legacy transaction — used by the
/// tests to prove the signature, `v` derivation and encoding all agree.
#[allow(clippy::too_many_arguments)]
pub fn recover_signer(
    nonce: u128,
    gas_price: u128,
    gas_limit: u128,
    to: &str,
    value: u128,
    data: &[u8],
    chain_id: u128,
    r: &[u8],
    s: &[u8],
    recovery_id: u8,
) -> Result<String, StoreError> {
    let hash = eip155_signing_hash(nonce, gas_price, gas_limit, to, value, data, chain_id)
        .map_err(|error| StoreError::Invalid(error.message))?;
    let mut r_bytes = [0u8; 32];
    let r_offset = 32usize.saturating_sub(r.len());
    r_bytes[r_offset..].copy_from_slice(&r[r.len().saturating_sub(32)..]);
    let mut s_bytes = [0u8; 32];
    let s_offset = 32usize.saturating_sub(s.len());
    s_bytes[s_offset..].copy_from_slice(&s[s.len().saturating_sub(32)..]);
    let signature = k256::ecdsa::Signature::from_scalars(r_bytes, s_bytes)
        .map_err(|_| StoreError::Invalid("invalid signature scalars".into()))?;
    let recovery = RecoveryId::try_from(recovery_id)
        .map_err(|_| StoreError::Invalid("invalid recovery id".into()))?;
    let verifying_key = VerifyingKey::recover_from_prehash(&hash, &signature, recovery)
        .map_err(|_| StoreError::Invalid("could not recover the signer".into()))?;
    Ok(address_from_verifying_key(&verifying_key))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic test key: 0x01 repeated 32 times.
    const TEST_KEY: &str = "0x0101010101010101010101010101010101010101010101010101010101010101";
    /// Well-known key `0x02…02`, whose address is stable.
    const KEY_TWO: &str = "0x0202020202020202020202020202020202020202020202020202020202020202";
    const TO: &str = "0x3535353535353535353535353535353535353535";

    #[test]
    fn rlp_encodes_the_spec_examples() {
        // "dog" -> 0x83 'd' 'o' 'g'
        assert_eq!(rlp_encode_bytes(b"dog"), hex::decode("83646f67").unwrap());
        // Single byte below 0x80 is itself.
        assert_eq!(rlp_encode_bytes(&[0x0f]), vec![0x0f]);
        // Empty string -> 0x80
        assert_eq!(rlp_encode_bytes(&[]), vec![0x80]);
        // Empty list -> 0xc0
        assert_eq!(rlp_encode_list(&[]), vec![0xc0]);
        // The classic ["cat","dog"] -> 0xc8 83636174 83646f67
        let list = rlp_encode_list(&[
            rlp_encode_bytes(b"cat"),
            rlp_encode_bytes(b"dog"),
        ]);
        assert_eq!(list, hex::decode("c88363617483646f67").unwrap());
        // Integers are minimal big-endian; zero is empty.
        assert_eq!(rlp_encode_uint(0), vec![0x80]);
        assert_eq!(rlp_encode_uint(15), vec![0x0f]);
        assert_eq!(rlp_encode_uint(1024), hex::decode("820400").unwrap());
    }

    #[test]
    fn long_byte_strings_use_the_long_form() {
        let data = vec![0xaa; 56];
        let encoded = rlp_encode_bytes(&data);
        assert_eq!(encoded[0], 0xb8);
        assert_eq!(encoded[1], 56);
        assert_eq!(encoded.len(), 58);
    }

    #[test]
    fn addresses_require_exactly_twenty_bytes() {
        let encoded = rlp_encode_address(TO).unwrap();
        assert_eq!(encoded[0], 0x94);
        assert_eq!(encoded.len(), 21);
        assert!(rlp_encode_address("0x1234").is_err());
        assert!(rlp_encode_address("not-an-address").is_err());
    }

    #[test]
    fn erc20_calldata_matches_the_abi_encoding() {
        let data = erc20_transfer_data(TO, 1000).unwrap();
        assert_eq!(data.len(), 68);
        assert_eq!(&data[..4], &ERC20_TRANSFER_SELECTOR);
        // 12 zero bytes of padding then the 20-byte address.
        assert!(data[4..16].iter().all(|byte| *byte == 0));
        assert_eq!(&data[16..36], &hex::decode("3535353535353535353535353535353535353535").unwrap());
        // amount 1000 = 0x3e8 in the last bytes
        assert_eq!(&data[64..68], &[0x00, 0x00, 0x03, 0xe8]);
    }

    #[test]
    fn erc20_balance_of_calldata_matches_the_abi() {
        let data = erc20_balance_of_data(TO).unwrap();
        assert_eq!(data.len(), 36);
        assert_eq!(&data[..4], &ERC20_BALANCE_OF_SELECTOR);
        assert!(data[4..16].iter().all(|byte| *byte == 0));
        assert_eq!(
            &data[16..36],
            &hex::decode("3535353535353535353535353535353535353535").unwrap()
        );
        assert!(erc20_balance_of_data("0x1234").is_err());
    }

    #[test]
    fn signature_recovers_the_signing_address() {
        let signed = sign_legacy_transaction(
            TEST_KEY,
            56,
            0,
            5_000_000_000,
            21_000,
            TO,
            1_000_000_000_000_000,
            &[],
        )
        .unwrap();
        assert_eq!(
            signed.from_address,
            address_from_private_key(TEST_KEY).unwrap()
        );
        assert!(signed.raw_hex.starts_with("0x"));

        // Decode the raw transaction and recover the signer from (r, s, v).
        let raw = hex::decode(signed.raw_hex.trim_start_matches("0x")).unwrap();
        let (nonce, gas_price, gas_limit, _to, value, data, v, r, s) = decode_legacy(&raw);
        assert_eq!(nonce, 0);
        assert_eq!(gas_price, 5_000_000_000);
        assert_eq!(gas_limit, 21_000);
        assert_eq!(value, 1_000_000_000_000_000);
        assert!(data.is_empty());
        // v = chain_id * 2 + 35 + recovery_id
        assert!(v == 56 * 2 + 35 || v == 56 * 2 + 36, "unexpected v {v}");
        let recovery_id = (v - (56 * 2 + 35)) as u8;
        let recovered = recover_signer(
            nonce, gas_price, gas_limit, TO, value, &[], 56, &r, &s, recovery_id,
        )
        .unwrap();
        assert_eq!(recovered, signed.from_address);
    }

    #[test]
    fn the_transaction_hash_is_the_keccak_of_the_raw_bytes() {
        let signed = sign_legacy_transaction(
            KEY_TWO,
            1,
            7,
            1_000_000_000,
            21_000,
            TO,
            5,
            &[],
        )
        .unwrap();
        let raw = hex::decode(signed.raw_hex.trim_start_matches("0x")).unwrap();
        assert_eq!(signed.tx_hash, format!("0x{}", hex::encode(keccak256(&raw))));
    }

    #[test]
    fn erc20_transactions_carry_the_calldata() {
        let data = erc20_transfer_data(TO, 1_500_000).unwrap();
        let signed = sign_legacy_transaction(
            TEST_KEY,
            56,
            3,
            5_000_000_000,
            60_000,
            "0x55d398326f99059ff775485246999027b3197955",
            0,
            &data,
        )
        .unwrap();
        let raw = hex::decode(signed.raw_hex.trim_start_matches("0x")).unwrap();
        let (_, _, gas_limit, to, value, decoded_data, _, _, _) = decode_legacy(&raw);
        assert_eq!(gas_limit, 60_000);
        assert_eq!(value, 0);
        assert_eq!(decoded_data, data);
        assert_eq!(to.to_ascii_lowercase(), "0x55d398326f99059ff775485246999027b3197955");
    }

    #[test]
    fn invalid_keys_fail_closed() {
        assert!(parse_private_key("").is_err());
        assert!(parse_private_key("0x1234").is_err());
        assert!(parse_private_key(&"zz".repeat(32)).is_err());
        // All-zero is not a valid secp256k1 scalar.
        assert!(parse_private_key(&"0".repeat(64)).is_err());
    }

    #[test]
    fn addresses_are_lower_case_and_stable() {
        let address = address_from_private_key(TEST_KEY).unwrap();
        assert_eq!(address.len(), 42);
        assert!(address.starts_with("0x"));
        assert_eq!(address, address.to_ascii_lowercase());
        assert_eq!(address, address_from_private_key(TEST_KEY).unwrap());
        assert_ne!(address, address_from_private_key(KEY_TWO).unwrap());
    }

    /// Minimal legacy-transaction decoder for the tests.
    #[allow(clippy::type_complexity)]
    fn decode_legacy(raw: &[u8]) -> (u128, u128, u128, String, u128, Vec<u8>, u128, Vec<u8>, Vec<u8>) {
        let start = if raw[0] >= 0xf8 {
            1 + (raw[0] - 0xf7) as usize
        } else {
            1
        };
        let mut cursor = start;
        let items: Vec<Vec<u8>> = (0..9).map(|_| {
            let (value, next) = decode_item(raw, cursor);
            cursor = next;
            value
        }).collect();
        let to = format!("0x{}", hex::encode(&items[3]));
        (
            bytes_to_u128(&items[0]),
            bytes_to_u128(&items[1]),
            bytes_to_u128(&items[2]),
            to,
            bytes_to_u128(&items[4]),
            items[5].clone(),
            bytes_to_u128(&items[6]),
            items[7].clone(),
            items[8].clone(),
        )
    }

    fn decode_item(raw: &[u8], cursor: usize) -> (Vec<u8>, usize) {
        let prefix = raw[cursor];
        if prefix < 0x80 {
            return (vec![prefix], cursor + 1);
        }
        if prefix < 0xb8 {
            let len = (prefix - 0x80) as usize;
            return (raw[cursor + 1..cursor + 1 + len].to_vec(), cursor + 1 + len);
        }
        if prefix < 0xc0 {
            let len_of_len = (prefix - 0xb7) as usize;
            let mut len = 0usize;
            for byte in &raw[cursor + 1..cursor + 1 + len_of_len] {
                len = (len << 8) | *byte as usize;
            }
            let start = cursor + 1 + len_of_len;
            return (raw[start..start + len].to_vec(), start + len);
        }
        if prefix < 0xf8 {
            let len = (prefix - 0xc0) as usize;
            return (raw[cursor + 1..cursor + 1 + len].to_vec(), cursor + 1 + len);
        }
        let len_of_len = (prefix - 0xf7) as usize;
        let mut len = 0usize;
        for byte in &raw[cursor + 1..cursor + 1 + len_of_len] {
            len = (len << 8) | *byte as usize;
        }
        let start = cursor + 1 + len_of_len;
        (raw[start..start + len].to_vec(), start + len)
    }

    fn bytes_to_u128(bytes: &[u8]) -> u128 {
        let mut value = 0u128;
        for byte in bytes {
            value = (value << 8) | *byte as u128;
        }
        value
    }
}
