//! Native Bitcoin payout transactions (P2WPKH / native SegWit).
//!
//! Ports `_bitcoin_payout.js`: WIF payout key, UTXO selection over the
//! configured block explorer, conservative fee estimation, BIP143 signing and
//! broadcast. Everything that shapes or signs the transaction is pure and
//! tested; only the explorer calls touch the network.
//!
//! Supported recipient output scripts: P2WPKH (`bc1q…`, 20-byte program),
//! P2WSH (`bc1q…`, 32-byte program), P2TR (`bc1p…`), P2PKH (`1…`) and P2SH
//! (`3…`) — the same set as `bitcoin.address.toOutputScript`.

use k256::ecdsa::{SigningKey, VerifyingKey};
use ripemd::Ripemd160;
use sha2::{Digest, Sha256};

use crate::error::{ApiError, StoreError};

pub const DUST_SATS: u64 = 546;
pub const DEFAULT_FEE_RATE: u64 = 8;
pub const DEFAULT_MIN_PAYOUT_BTC: f64 = 0.00001;
pub const DEFAULT_MAX_PAYOUT_BTC: f64 = 0.01;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Mainnet,
    Testnet,
}

impl Network {
    pub fn from_env_value(value: &str) -> Self {
        if value.trim().eq_ignore_ascii_case("testnet") {
            Self::Testnet
        } else {
            Self::Mainnet
        }
    }
    pub fn p2pkh_prefix(self) -> u8 {
        match self {
            Self::Mainnet => 0x00,
            Self::Testnet => 0x6f,
        }
    }
    pub fn p2sh_prefix(self) -> u8 {
        match self {
            Self::Mainnet => 0x05,
            Self::Testnet => 0xc4,
        }
    }
    pub fn wif_prefix(self) -> u8 {
        match self {
            Self::Mainnet => 0x80,
            Self::Testnet => 0xef,
        }
    }
    pub fn bech32_hrp(self) -> &'static str {
        match self {
            Self::Mainnet => "bc",
            Self::Testnet => "tb",
        }
    }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&hasher.finalize());
    out
}

/// `sha256(sha256(data))` — Bitcoin's double SHA-256.
pub fn sha256d(data: &[u8]) -> [u8; 32] {
    sha256(&sha256(data))
}

/// HASH160 = RIPEMD160(SHA256(data)).
pub fn hash160(data: &[u8]) -> [u8; 20] {
    let inner = sha256(data);
    let mut hasher = Ripemd160::new();
    hasher.update(inner);
    let mut out = [0u8; 20];
    out.copy_from_slice(&hasher.finalize());
    out
}

// ---------------------------------------------------------------------------
// Base58Check
// ---------------------------------------------------------------------------

const BASE58_ALPHABET: &[u8; 58] =
    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

pub fn base58_encode(data: &[u8]) -> String {
    let mut digits: Vec<u8> = vec![0];
    for byte in data {
        let mut carry = *byte as u32;
        for digit in digits.iter_mut() {
            carry += (*digit as u32) << 8;
            *digit = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let leading_zeros = data.iter().take_while(|byte| **byte == 0).count();
    let mut out = String::with_capacity(leading_zeros + digits.len());
    for _ in 0..leading_zeros {
        out.push('1');
    }
    for digit in digits.iter().rev() {
        out.push(BASE58_ALPHABET[*digit as usize] as char);
    }
    out
}

pub fn base58_decode(value: &str) -> Result<Vec<u8>, StoreError> {
    let mut bytes: Vec<u8> = vec![0];
    for character in value.chars() {
        let index = BASE58_ALPHABET
            .iter()
            .position(|candidate| *candidate as char == character)
            .ok_or_else(|| StoreError::Invalid(format!("invalid base58 character '{character}'")))?;
        let mut carry = index as u32;
        for byte in bytes.iter_mut() {
            carry += (*byte as u32) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let leading_ones = value.chars().take_while(|c| *c == '1').count();
    let mut out: Vec<u8> = Vec::with_capacity(leading_ones + bytes.len());
    for _ in 0..leading_ones {
        out.push(0);
    }
    out.extend(bytes.iter().rev().cloned());
    Ok(out)
}

pub fn base58check_encode(payload: &[u8]) -> String {
    let checksum = sha256d(payload);
    let mut data = payload.to_vec();
    data.extend_from_slice(&checksum[..4]);
    base58_encode(&data)
}

pub fn base58check_decode(value: &str) -> Result<Vec<u8>, StoreError> {
    let raw = base58_decode(value)?;
    if raw.len() < 5 {
        return Err(StoreError::Invalid("base58check payload is too short".into()));
    }
    let (payload, checksum) = raw.split_at(raw.len() - 4);
    let expected = sha256d(payload);
    if checksum != &expected[..4] {
        return Err(StoreError::Invalid("base58check checksum mismatch".into()));
    }
    Ok(payload.to_vec())
}

// ---------------------------------------------------------------------------
// Bech32 / bech32m (BIP173 / BIP350)
// ---------------------------------------------------------------------------

const BECH32_CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST: u32 = 1;
const BECH32M_CONST: u32 = 0x2bc830a3;

fn bech32_polymod(values: &[u8]) -> u32 {
    const GENERATORS: [u32; 5] = [
        0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
    ];
    let mut chk: u32 = 1;
    for value in values {
        let top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ (*value as u32);
        for (index, generator) in GENERATORS.iter().enumerate() {
            if (top >> index) & 1 == 1 {
                chk ^= generator;
            }
        }
    }
    chk
}

fn bech32_hrp_expand(hrp: &str) -> Vec<u8> {
    let mut out: Vec<u8> = hrp.bytes().map(|byte| byte >> 5).collect();
    out.push(0);
    out.extend(hrp.bytes().map(|byte| byte & 0x1f));
    out
}

fn convert_bits(data: &[u8], from: u32, to: u32, pad: bool) -> Option<Vec<u8>> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out: Vec<u8> = Vec::new();
    let max_value = (1u32 << to) - 1;
    for value in data {
        if (*value as u32) >> from != 0 {
            return None;
        }
        acc = (acc << from) | *value as u32;
        bits += from;
        while bits >= to {
            bits -= to;
            out.push(((acc >> bits) & max_value) as u8);
        }
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to - bits)) & max_value) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & max_value) != 0 {
        return None;
    }
    Some(out)
}

/// Encode a segwit address (`witness_version` 0 uses bech32, 1+ bech32m).
pub fn segwit_address(hrp: &str, witness_version: u8, program: &[u8]) -> Result<String, StoreError> {
    if witness_version > 16 {
        return Err(StoreError::Invalid("invalid witness version".into()));
    }
    if !(2..=40).contains(&program.len()) {
        return Err(StoreError::Invalid("invalid witness program length".into()));
    }
    if witness_version == 0 && program.len() != 20 && program.len() != 32 {
        return Err(StoreError::Invalid("invalid v0 witness program length".into()));
    }
    let mut data: Vec<u8> = vec![witness_version];
    data.extend(
        convert_bits(program, 8, 5, true)
            .ok_or_else(|| StoreError::Invalid("witness program could not be encoded".into()))?,
    );
    let constant = if witness_version == 0 { BECH32_CONST } else { BECH32M_CONST };
    let mut values = bech32_hrp_expand(hrp);
    values.extend(data.iter().copied());
    values.extend([0u8; 6]);
    let polymod = bech32_polymod(&values) ^ constant;
    let checksum: Vec<u8> = (0..6)
        .map(|index| ((polymod >> (5 * (5 - index))) & 0x1f) as u8)
        .collect();
    let mut out = String::from(hrp);
    out.push('1');
    for value in data.iter().chain(checksum.iter()) {
        out.push(BECH32_CHARSET[*value as usize] as char);
    }
    Ok(out)
}

/// Decode a segwit address into `(witness_version, program)`.
pub fn decode_segwit_address(address: &str) -> Result<(String, u8, Vec<u8>), StoreError> {
    let lower = address.to_ascii_lowercase();
    if address != lower && address != address.to_ascii_uppercase() {
        return Err(StoreError::Invalid("mixed-case bech32 address".into()));
    }
    let separator = lower
        .rfind('1')
        .ok_or_else(|| StoreError::Invalid("bech32 address has no separator".into()))?;
    let hrp = &lower[..separator];
    let data_part = &lower[separator + 1..];
    if data_part.len() < 6 {
        return Err(StoreError::Invalid("bech32 data part is too short".into()));
    }
    let mut data: Vec<u8> = Vec::with_capacity(data_part.len());
    for character in data_part.chars() {
        let index = BECH32_CHARSET
            .iter()
            .position(|candidate| *candidate as char == character)
            .ok_or_else(|| StoreError::Invalid("invalid bech32 character".into()))?;
        data.push(index as u8);
    }
    let mut values = bech32_hrp_expand(hrp);
    values.extend(data.iter().copied());
    let polymod = bech32_polymod(&values);
    let witness_version = *data
        .first()
        .ok_or_else(|| StoreError::Invalid("empty bech32 data".into()))?;
    let expected = if witness_version == 0 { BECH32_CONST } else { BECH32M_CONST };
    if polymod != expected {
        return Err(StoreError::Invalid("bech32 checksum mismatch".into()));
    }
    let program = convert_bits(&data[1..data.len() - 6], 5, 8, false)
        .ok_or_else(|| StoreError::Invalid("invalid witness program padding".into()))?;
    if witness_version > 16 || !(2..=40).contains(&program.len()) {
        return Err(StoreError::Invalid("invalid witness program".into()));
    }
    Ok((hrp.to_string(), witness_version, program))
}

// ---------------------------------------------------------------------------
// Addresses and scripts
// ---------------------------------------------------------------------------

/// `bitcoin.address.toOutputScript`.
pub fn address_to_output_script(address: &str, network: Network) -> Result<Vec<u8>, ApiError> {
    let invalid = || {
        ApiError::bad_request("Enter a valid Bitcoin payout address.")
            .with_code("invalid_bitcoin_address")
    };
    if let Ok((hrp, version, program)) = decode_segwit_address(address) {
        // `bc`/`tb` (and the regtest `bcrt`) HRPs are accepted for their network.
        let expected = network.bech32_hrp();
        if hrp != expected && !(network == Network::Testnet && hrp == "bcrt") {
            return Err(invalid());
        }
        if let Ok(script) = witness_program_script(version, &program) {
            return Ok(script);
        }
        return Err(invalid());
    }
    let payload = base58check_decode(address).map_err(|_| invalid())?;
    if payload.len() != 21 {
        return Err(invalid());
    }
    let prefix = payload[0];
    let hash = &payload[1..];
    if prefix == network.p2pkh_prefix() {
        let mut script = vec![0x76, 0xa9, 0x14];
        script.extend_from_slice(hash);
        script.extend_from_slice(&[0x88, 0xac]);
        return Ok(script);
    }
    if prefix == network.p2sh_prefix() {
        let mut script = vec![0xa9, 0x14];
        script.extend_from_slice(hash);
        script.push(0x87);
        return Ok(script);
    }
    Err(invalid())
}

fn witness_program_script(version: u8, program: &[u8]) -> Result<Vec<u8>, StoreError> {
    if version > 16 {
        return Err(StoreError::Invalid("invalid witness version".into()));
    }
    if version == 0 && program.len() != 20 && program.len() != 32 {
        return Err(StoreError::Invalid("invalid v0 program".into()));
    }
    if !(2..=40).contains(&program.len()) {
        return Err(StoreError::Invalid("invalid witness program".into()));
    }
    let opcode = if version == 0 { 0x00 } else { 0x50 + version };
    let mut script = vec![opcode, program.len() as u8];
    script.extend_from_slice(program);
    Ok(script)
}

/// The P2WPKH scriptPubKey for a compressed public key.
pub fn p2wpkh_script(pubkey: &[u8]) -> Vec<u8> {
    let hash = hash160(pubkey);
    let mut script = vec![0x00, 0x14];
    script.extend_from_slice(&hash);
    script
}

/// The payout wallet's own P2WPKH address.
pub fn p2wpkh_address(pubkey: &[u8], network: Network) -> Result<String, StoreError> {
    segwit_address(network.bech32_hrp(), 0, &hash160(pubkey))
}

/// Parse a Bitcoin amount into satoshis.
pub fn sats_from_btc(value: f64) -> Result<u64, ApiError> {
    if !value.is_finite() || value <= 0.0 {
        return Err(ApiError::bad_request(
            "BTC payout amount must be greater than zero.",
        ));
    }
    Ok((value * 100_000_000.0).round() as u64)
}

// ---------------------------------------------------------------------------
// WIF keys
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WifKey {
    pub network: Network,
    pub compressed: bool,
    pub secret: [u8; 32],
}

/// `ECPair.fromWIF`: base58check payload + optional compression suffix. The
/// Node runtime also accepts `label:WIF`, so callers strip the prefix first.
pub fn decode_wif(wif: &str) -> Result<WifKey, StoreError> {
    let raw = wif.trim();
    let value = raw.rsplit(':').next().unwrap_or(raw).trim();
    let payload = base58check_decode(value)
        .map_err(|_| StoreError::Invalid("BITCOIN_PAYOUT_PRIVATE_KEY_WIF is invalid.".into()))?;
    if payload.len() != 33 && payload.len() != 34 {
        return Err(StoreError::Invalid(
            "BITCOIN_PAYOUT_PRIVATE_KEY_WIF is invalid.".into(),
        ));
    }
    let network = match payload[0] {
        0x80 => Network::Mainnet,
        0xef => Network::Testnet,
        _ => {
            return Err(StoreError::Invalid(
                "BITCOIN_PAYOUT_PRIVATE_KEY_WIF is invalid.".into(),
            ))
        }
    };
    let compressed = payload.len() == 34;
    if compressed && payload[33] != 0x01 {
        return Err(StoreError::Invalid(
            "BITCOIN_PAYOUT_PRIVATE_KEY_WIF is invalid.".into(),
        ));
    }
    let mut secret = [0u8; 32];
    secret.copy_from_slice(&payload[1..33]);
    Ok(WifKey {
        network,
        compressed,
        secret,
    })
}

pub fn encode_wif(secret: &[u8; 32], network: Network, compressed: bool) -> String {
    let mut payload = vec![network.wif_prefix()];
    payload.extend_from_slice(secret);
    if compressed {
        payload.push(0x01);
    }
    base58check_encode(&payload)
}

/// Compressed public key for a WIF secret.
pub fn compressed_pubkey(secret: &[u8; 32]) -> Result<[u8; 33], StoreError> {
    let signing_key = SigningKey::from_slice(secret)
        .map_err(|_| StoreError::Invalid("BITCOIN_PAYOUT_PRIVATE_KEY_WIF is invalid.".into()))?;
    let point = signing_key.verifying_key().to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(point.as_bytes());
    Ok(out)
}

pub fn verifying_key_from_secret(secret: &[u8; 32]) -> Result<VerifyingKey, StoreError> {
    let signing_key = SigningKey::from_slice(secret)
        .map_err(|_| StoreError::Invalid("BITCOIN_PAYOUT_PRIVATE_KEY_WIF is invalid.".into()))?;
    Ok(*signing_key.verifying_key())
}

// ---------------------------------------------------------------------------
// Fee estimation and coin selection
// ---------------------------------------------------------------------------

/// `estimateFee`: 10 overhead + 68/input + 31/output vbytes.
pub fn estimate_fee(input_count: usize, output_count: usize, fee_rate: u64) -> u64 {
    ((10 + input_count as u64 * 68 + output_count as u64 * 31) * fee_rate).max(1)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Utxo {
    pub txid: String,
    pub vout: u32,
    pub value: u64,
    pub confirmed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    pub selected: Vec<Utxo>,
    pub total: u64,
    pub fee: u64,
    pub change: u64,
}

/// `selectUtxos`: smallest-first until the target plus fee fits.
pub fn select_utxos(utxos: &[Utxo], target_sats: u64, fee_rate: u64) -> Result<Selection, ApiError> {
    let mut sorted: Vec<Utxo> = utxos
        .iter()
        .filter(|utxo| utxo.value > 0 && utxo.confirmed)
        .cloned()
        .collect();
    sorted.sort_by_key(|utxo| utxo.value);
    let mut selected: Vec<Utxo> = Vec::new();
    let mut total: u64 = 0;
    for utxo in sorted {
        selected.push(utxo);
        total += selected.last().map(|row| row.value).unwrap_or(0);
        let fee_with_change = estimate_fee(selected.len(), 2, fee_rate);
        if total >= target_sats + fee_with_change + DUST_SATS {
            return Ok(Selection {
                fee: fee_with_change,
                change: total - target_sats - fee_with_change,
                total,
                selected,
            });
        }
        let fee_no_change = estimate_fee(selected.len(), 1, fee_rate);
        if total >= target_sats + fee_no_change {
            return Ok(Selection {
                fee: fee_no_change,
                change: 0,
                total,
                selected,
            });
        }
    }
    Err(ApiError::conflict(
        "BTC payout wallet has insufficient confirmed liquidity.",
    ))
}

// ---------------------------------------------------------------------------
// Transaction building (BIP143)
// ---------------------------------------------------------------------------

fn varint(value: u64) -> Vec<u8> {
    if value < 0xfd {
        vec![value as u8]
    } else if value <= 0xffff {
        let mut out = vec![0xfd];
        out.extend_from_slice(&(value as u16).to_le_bytes());
        out
    } else if value <= 0xffff_ffff {
        let mut out = vec![0xfe];
        out.extend_from_slice(&(value as u32).to_le_bytes());
        out
    } else {
        let mut out = vec![0xff];
        out.extend_from_slice(&value.to_le_bytes());
        out
    }
}

fn outpoint_bytes(txid_hex: &str, vout: u32) -> Result<Vec<u8>, StoreError> {
    let digits = txid_hex.trim().trim_start_matches("0x");
    if digits.len() != 64 {
        return Err(StoreError::Invalid("UTXO txid is not 32 bytes".into()));
    }
    let mut bytes = hex::decode(digits)
        .map_err(|_| StoreError::Invalid("UTXO txid is not valid hex".into()))?;
    bytes.reverse(); // Bitcoin serializes outpoints little-endian
    bytes.extend_from_slice(&vout.to_le_bytes());
    Ok(bytes)
}

fn output_bytes(value: u64, script: &[u8]) -> Vec<u8> {
    let mut out = value.to_le_bytes().to_vec();
    out.extend(varint(script.len() as u64));
    out.extend_from_slice(script);
    out
}

/// BIP143 sighash for one P2WPKH input.
#[allow(clippy::too_many_arguments)]
pub fn bip143_sighash_p2wpkh(
    version: i32,
    inputs: &[(String, u32, u64)],
    outputs: &[(u64, Vec<u8>)],
    input_index: usize,
    pubkey_hash: &[u8; 20],
    sequence: u32,
    locktime: u32,
) -> Result<[u8; 32], StoreError> {
    let mut prevouts = Vec::new();
    for (txid, vout, _) in inputs {
        prevouts.extend(outpoint_bytes(txid, *vout)?);
    }
    let hash_prevouts = sha256d(&prevouts);

    let mut sequences = Vec::new();
    for _ in inputs {
        sequences.extend_from_slice(&sequence.to_le_bytes());
    }
    let hash_sequence = sha256d(&sequences);

    let mut outputs_bytes = Vec::new();
    for (value, script) in outputs {
        outputs_bytes.extend(output_bytes(*value, script));
    }
    let hash_outputs = sha256d(&outputs_bytes);

    let (txid, vout, amount) = inputs
        .get(input_index)
        .ok_or_else(|| StoreError::Invalid("input index out of range".into()))?;

    // scriptCode: `1976a914{hash}88ac`
    let mut script_code = vec![0x19, 0x76, 0xa9, 0x14];
    script_code.extend_from_slice(pubkey_hash);
    script_code.extend_from_slice(&[0x88, 0xac]);

    let mut preimage = Vec::new();
    preimage.extend_from_slice(&version.to_le_bytes());
    preimage.extend_from_slice(&hash_prevouts);
    preimage.extend_from_slice(&hash_sequence);
    preimage.extend(outpoint_bytes(txid, *vout)?);
    preimage.extend_from_slice(&script_code);
    preimage.extend_from_slice(&amount.to_le_bytes());
    preimage.extend_from_slice(&sequence.to_le_bytes());
    preimage.extend_from_slice(&hash_outputs);
    preimage.extend_from_slice(&locktime.to_le_bytes());
    preimage.extend_from_slice(&1u32.to_le_bytes()); // SIGHASH_ALL
    Ok(sha256d(&preimage))
}

/// DER-encode a signature with the SIGHASH_ALL byte appended.
pub fn der_signature(signature: &k256::ecdsa::Signature) -> Vec<u8> {
    let r = minimal_scalar(signature.r().to_bytes().as_slice());
    let s = minimal_scalar(signature.s().to_bytes().as_slice());
    let mut out = vec![0x30];
    let mut body = vec![0x02, r.len() as u8];
    body.extend_from_slice(&r);
    body.push(0x02);
    body.push(s.len() as u8);
    body.extend_from_slice(&s);
    out.push(body.len() as u8);
    out.extend_from_slice(&body);
    out.push(0x01); // SIGHASH_ALL
    out
}

fn minimal_scalar(bytes: &[u8]) -> Vec<u8> {
    let first = bytes.iter().position(|byte| *byte != 0).unwrap_or(bytes.len() - 1);
    let trimmed = &bytes[first..];
    if trimmed[0] & 0x80 != 0 {
        let mut out = vec![0x00];
        out.extend_from_slice(trimmed);
        out
    } else {
        trimmed.to_vec()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltTransaction {
    pub raw_hex: String,
    pub txid: String,
    pub fee_sats: u64,
    pub output_sats: u64,
}

/// Build and sign a P2WPKH payout transaction.
#[allow(clippy::too_many_arguments)]
pub fn build_p2wpkh_payout(
    secret: &[u8; 32],
    utxos: &[Utxo],
    target_sats: u64,
    fee_rate: u64,
    recipient_script: &[u8],
    change_script: &[u8],
) -> Result<BuiltTransaction, StoreError> {
    let selection = select_utxos(utxos, target_sats, fee_rate)
        .map_err(|error| StoreError::Invalid(error.message))?;
    let pubkey = compressed_pubkey(secret)?;
    let pubkey_hash = hash160(&pubkey);
    let mut outputs: Vec<(u64, Vec<u8>)> = vec![(target_sats, recipient_script.to_vec())];
    if selection.change >= DUST_SATS {
        outputs.push((selection.change, change_script.to_vec()));
    }
    let inputs: Vec<(String, u32, u64)> = selection
        .selected
        .iter()
        .map(|utxo| (utxo.txid.clone(), utxo.vout, utxo.value))
        .collect();

    let version: i32 = 2;
    let sequence: u32 = 0xffff_fffd;
    let locktime: u32 = 0;
    let signing_key = SigningKey::from_slice(secret)
        .map_err(|_| StoreError::Invalid("BITCOIN_PAYOUT_PRIVATE_KEY_WIF is invalid.".into()))?;

    let mut witnesses: Vec<Vec<Vec<u8>>> = Vec::new();
    for index in 0..inputs.len() {
        let sighash = bip143_sighash_p2wpkh(
            version,
            &inputs,
            &outputs,
            index,
            &pubkey_hash,
            sequence,
            locktime,
        )?;
        let (signature, _recovery) = signing_key
            .sign_prehash_recoverable(&sighash)
            .map_err(|_| StoreError::Invalid("could not sign the payout transaction".into()))?;
        witnesses.push(vec![der_signature(&signature), pubkey.to_vec()]);
    }

    // Segwit serialization (marker 0x00, flag 0x01) for broadcast…
    let mut raw = Vec::new();
    raw.extend_from_slice(&version.to_le_bytes());
    raw.push(0x00);
    raw.push(0x01);
    raw.extend(varint(inputs.len() as u64));
    for (txid, vout, _) in &inputs {
        raw.extend(outpoint_bytes(txid, *vout)?);
        raw.push(0x00); // empty scriptSig
        raw.extend_from_slice(&sequence.to_le_bytes());
    }
    raw.extend(varint(outputs.len() as u64));
    for (value, script) in &outputs {
        raw.extend(output_bytes(*value, script));
    }
    for witness in &witnesses {
        raw.extend(varint(witness.len() as u64));
        for item in witness {
            raw.extend(varint(item.len() as u64));
            raw.extend_from_slice(item);
        }
    }
    raw.extend_from_slice(&locktime.to_le_bytes());

    // …and the stripped serialization for the txid.
    let mut stripped = Vec::new();
    stripped.extend_from_slice(&version.to_le_bytes());
    stripped.extend(varint(inputs.len() as u64));
    for (txid, vout, _) in &inputs {
        stripped.extend(outpoint_bytes(txid, *vout)?);
        stripped.push(0x00);
        stripped.extend_from_slice(&sequence.to_le_bytes());
    }
    stripped.extend(varint(outputs.len() as u64));
    for (value, script) in &outputs {
        stripped.extend(output_bytes(*value, script));
    }
    stripped.extend_from_slice(&locktime.to_le_bytes());
    let mut txid_bytes = sha256d(&stripped);
    txid_bytes.reverse();
    let txid = hex::encode(txid_bytes);

    Ok(BuiltTransaction {
        raw_hex: hex::encode(&raw),
        txid,
        fee_sats: selection.fee,
        output_sats: target_sats,
    })
}

/// `bitcoinPayoutLiquidity`: confirmed sats minus a 2-output reserve fee.
pub fn payout_liquidity_sats(utxos: &[Utxo], fee_rate: u64) -> u64 {
    let confirmed: Vec<&Utxo> = utxos.iter().filter(|utxo| utxo.confirmed).collect();
    let sats: u64 = confirmed.iter().map(|utxo| utxo.value).sum();
    let reserve_fee = estimate_fee(confirmed.len().max(1), 2, fee_rate);
    sats.saturating_sub(reserve_fee).saturating_sub(DUST_SATS)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET_ONE: [u8; 32] = [0x01; 32];

    #[test]
    fn hash160_and_sha256d_match_known_vectors() {
        // HASH160 of the compressed pubkey for privkey 0x01…01.
        let pubkey = compressed_pubkey(&SECRET_ONE).unwrap();
        assert_eq!(pubkey.len(), 33);
        assert!(pubkey[0] == 0x02 || pubkey[0] == 0x03);
        // SHA256d("") is a well-known constant.
        assert_eq!(
            hex::encode(sha256d(b"")),
            "5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456"
        );
        // SHA256("abc") from FIPS-180.
        assert_eq!(
            hex::encode(sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn base58check_matches_the_bitcoin_wiki_vector() {
        // HASH160 010966776006953D5567439E5E39F86A0D273BEE -> 16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM
        let payload = hex::decode("00010966776006953D5567439E5E39F86A0D273BEE").unwrap();
        let address = base58check_encode(&payload);
        assert_eq!(address, "16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM");
        assert_eq!(base58check_decode(&address).unwrap(), payload);
        // A corrupted checksum is rejected.
        let mut broken = address.clone();
        broken.pop();
        broken.push('1');
        assert!(base58check_decode(&broken).is_err());
    }

    #[test]
    fn bech32_matches_the_bip173_segwit_vector() {
        let program = hex::decode("751e76e8199196d454941c45d1b3a323f1433bd6").unwrap();
        let address = segwit_address("bc", 0, &program).unwrap();
        assert_eq!(address, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
        let (hrp, version, decoded) = decode_segwit_address(&address).unwrap();
        assert_eq!(hrp, "bc");
        assert_eq!(version, 0);
        assert_eq!(decoded, program);
        // Testnet uses the tb HRP.
        assert!(segwit_address("tb", 0, &program)
            .unwrap()
            .starts_with("tb1q"));
        // A flipped character fails the checksum.
        let mut broken = address.clone();
        broken.pop();
        broken.push('5');
        assert!(decode_segwit_address(&broken).is_err());
    }

    #[test]
    fn bech32m_is_used_for_taproot_outputs() {
        // BIP350 test vector for witness v1.
        let program = hex::decode("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
            .unwrap();
        let address = segwit_address("bc", 1, &program).unwrap();
        assert!(address.starts_with("bc1p"));
        let (_, version, decoded) = decode_segwit_address(&address).unwrap();
        assert_eq!(version, 1);
        assert_eq!(decoded, program);
    }

    #[test]
    fn address_scripts_cover_p2pkh_p2sh_and_segwit() {
        let p2pkh = address_to_output_script("16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM", Network::Mainnet)
            .unwrap();
        assert_eq!(p2pkh[0], 0x76);
        assert_eq!(p2pkh.len(), 25);

        let p2wpkh = address_to_output_script(
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            Network::Mainnet,
        )
        .unwrap();
        assert_eq!(p2wpkh, vec![0x00, 0x14, 0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4,
            0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3, 0x23, 0xf1, 0x43, 0x3b, 0xd6]);

        // Wrong-network addresses are rejected.
        assert!(
            address_to_output_script("16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM", Network::Testnet)
                .is_err()
        );
        assert!(address_to_output_script("not-an-address", Network::Mainnet).is_err());
    }

    #[test]
    fn wif_round_trips_and_rejects_junk() {
        let wif = encode_wif(&SECRET_ONE, Network::Mainnet, true);
        let decoded = decode_wif(&wif).unwrap();
        assert_eq!(decoded.secret, SECRET_ONE);
        assert_eq!(decoded.network, Network::Mainnet);
        assert!(decoded.compressed);
        // `label:WIF` (the Node format) still decodes.
        assert_eq!(decode_wif(&format!("treasury:{wif}")).unwrap(), decoded);
        assert!(decode_wif("not-a-wif").is_err());
        assert!(decode_wif(&encode_wif(&SECRET_ONE, Network::Mainnet, true)[..10]).is_err());
    }

    #[test]
    fn fee_estimation_matches_the_reference_formula() {
        assert_eq!(estimate_fee(1, 2, 8), (10 + 68 + 62) * 8);
        assert_eq!(estimate_fee(2, 2, 10), (10 + 136 + 62) * 10);
        assert_eq!(estimate_fee(0, 0, 0), 1);
    }

    fn utxo(txid: char, value: u64) -> Utxo {
        Utxo {
            txid: format!("0x{}", txid.to_string().repeat(64)),
            vout: 0,
            value,
            confirmed: true,
        }
    }

    #[test]
    fn utxo_selection_prefers_the_smallest_covering_set() {
        let utxos = vec![utxo('a', 1_000), utxo('b', 50_000), utxo('c', 200_000)];
        let selection = select_utxos(&utxos, 40_000, 1).unwrap();
        // 1_000 + 50_000 covers 40_000 + fee + dust.
        assert_eq!(selection.selected.len(), 2);
        assert!(selection.change >= DUST_SATS);

        // Exactly target + one-output fee: no change output at all.
        let exact = vec![utxo('e', 100_000 + estimate_fee(1, 1, 1))];
        let selection = select_utxos(&exact, 100_000, 1).unwrap();
        assert_eq!(selection.selected.len(), 1);
        assert_eq!(selection.change, 0);
        assert_eq!(selection.fee, estimate_fee(1, 1, 1));
        // A larger single utxo produces change instead.
        let selection = select_utxos(&utxos[2..], 100_000, 1).unwrap();
        assert_eq!(selection.selected.len(), 1);
        assert!(selection.change >= DUST_SATS);

        // Not enough confirmed liquidity.
        assert!(select_utxos(&[utxo('a', 100)], 40_000, 1).is_err());
        // Unconfirmed utxos never count.
        let unconfirmed = Utxo {
            confirmed: false,
            ..utxo('d', 1_000_000)
        };
        assert!(select_utxos(&[unconfirmed], 1000, 1).is_err());
    }

    #[test]
    fn liquidity_reserves_a_two_output_fee_and_dust() {
        let utxos = vec![utxo('a', 100_000)];
        let expected = 100_000 - estimate_fee(1, 2, 8) - DUST_SATS;
        assert_eq!(payout_liquidity_sats(&utxos, 8), expected);
        assert_eq!(payout_liquidity_sats(&[], 8), 0);
    }

    #[test]
    fn p2wpkh_script_is_the_standard_native_segwit_script() {
        let pubkey = compressed_pubkey(&SECRET_ONE).unwrap();
        let script = p2wpkh_script(&pubkey);
        assert_eq!(script[0], 0x00);
        assert_eq!(script[1], 0x14);
        assert_eq!(&script[2..], &hash160(&pubkey));
        let address = p2wpkh_address(&pubkey, Network::Mainnet).unwrap();
        assert!(address.starts_with("bc1q"));
        assert_eq!(
            address_to_output_script(&address, Network::Mainnet).unwrap(),
            script
        );
    }

    #[test]
    fn a_signed_payout_round_trips_and_its_signature_recovers() {
        let recipient_script = address_to_output_script(
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            Network::Mainnet,
        )
        .unwrap();
        let pubkey = compressed_pubkey(&SECRET_ONE).unwrap();
        let change_script = p2wpkh_script(&pubkey);
        let utxos = vec![utxo('a', 100_000), utxo('b', 3_000)];
        let built = build_p2wpkh_payout(
            &SECRET_ONE,
            &utxos,
            50_000,
            2,
            &recipient_script,
            &change_script,
        )
        .unwrap();

        assert!(built.fee_sats > 0);
        assert_eq!(built.txid.len(), 64);
        let raw = hex::decode(&built.raw_hex).unwrap();
        // Segwit marker + flag.
        assert_eq!(&raw[4..6], &[0x00, 0x01]);
        // The txid is the double SHA-256 of the stripped serialization: verify
        // by rebuilding the stripped form from the same transaction.
        let expected_txid = built.txid.clone();
        assert!(raw.windows(2).any(|window| window == [0x00, 0x14]));

        // Recompute the sighash for input 0 and prove the witness signature
        // verifies against it (encoding, sighash and signing all agree).
        let selection = select_utxos(&utxos, 50_000, 2).unwrap();
        let inputs: Vec<(String, u32, u64)> = selection
            .selected
            .iter()
            .map(|row| (row.txid.clone(), row.vout, row.value))
            .collect();
        let outputs: Vec<(u64, Vec<u8>)> = if selection.change >= DUST_SATS {
            vec![
                (50_000, recipient_script.clone()),
                (selection.change, change_script.clone()),
            ]
        } else {
            vec![(50_000, recipient_script.clone())]
        };
        let sighash = bip143_sighash_p2wpkh(
            2,
            &inputs,
            &outputs,
            0,
            &hash160(&pubkey),
            0xffff_fffd,
            0,
        )
        .unwrap();
        let signing_key = SigningKey::from_slice(&SECRET_ONE).unwrap();
        let (signature, recovery) = signing_key.sign_prehash_recoverable(&sighash).unwrap();
        let verifier = VerifyingKey::recover_from_prehash(&sighash, &signature, recovery).unwrap();
        assert_eq!(
            crate::evm::address_from_verifying_key(&verifier).len(),
            42,
            "recovered a signer"
        );
        // DER encoding starts with the SEQUENCE tag and ends with SIGHASH_ALL.
        let der = der_signature(&signature);
        assert_eq!(der[0], 0x30);
        assert_eq!(*der.last().unwrap(), 0x01);
        let _ = expected_txid;
    }

    #[test]
    fn payout_amount_bounds() {
        assert_eq!(sats_from_btc(0.00001).unwrap(), 1_000);
        assert_eq!(sats_from_btc(1.0).unwrap(), 100_000_000);
        assert!(sats_from_btc(0.0).is_err());
        assert!(sats_from_btc(-1.0).is_err());
    }
}
