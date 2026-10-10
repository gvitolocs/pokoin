//! RFC 9842 `dcb`: Brotli with a raw shared dictionary.
//!
//! The pure-Rust `brotli` crate only has the legacy ring-buffer custom
//! dictionary, which is a different contract; RFC 9842 needs Brotli's raw
//! *shared* dictionary (`BrotliEncoderPrepareDictionary` /
//! `BrotliDecoderAttachDictionary`). That comes from Google's C library,
//! vendored and statically linked by `brotlic-sys`, so the binary needs no
//! system `libbrotli` (the overflow image is distroless).
//!
//! This crate is the only place the workspace allows `unsafe`: a handful of FFI
//! calls behind [`SharedDictionary::compress`] and
//! [`SharedDictionary::decompress`], each instance owned by a guard that frees
//! it, encoders always before their prepared dictionary.

use std::ptr::{null, null_mut};

use brotlic_sys as ffi;
use sha2::{Digest, Sha256};

/// The `dcb` stream header magic (RFC 9842 §4).
pub const DCB_MAGIC: [u8; 4] = [0xff, 0x44, 0x43, 0x42];

/// A raw dictionary and its SHA-256, the identity browsers send back in
/// `Available-Dictionary`.
#[derive(Clone)]
pub struct SharedDictionary {
    raw: Vec<u8>,
    hash: [u8; 32],
}

struct Encoder(*mut ffi::BrotliEncoderState);
impl Drop for Encoder {
    fn drop(&mut self) {
        // SAFETY: created by BrotliEncoderCreateInstance, destroyed once.
        unsafe { ffi::BrotliEncoderDestroyInstance(self.0) }
    }
}

struct Prepared(*mut ffi::BrotliEncoderPreparedDictionary);
impl Drop for Prepared {
    fn drop(&mut self) {
        // SAFETY: created by BrotliEncoderPrepareDictionary, destroyed once,
        // after every encoder it was attached to (see `compress`).
        unsafe { ffi::BrotliEncoderDestroyPreparedDictionary(self.0) }
    }
}

struct Decoder(*mut ffi::BrotliDecoderState);
impl Drop for Decoder {
    fn drop(&mut self) {
        // SAFETY: created by BrotliDecoderCreateInstance, destroyed once.
        unsafe { ffi::BrotliDecoderDestroyInstance(self.0) }
    }
}

impl SharedDictionary {
    pub fn new(raw: Vec<u8>) -> Self {
        let hash = Sha256::digest(&raw).into();
        Self { raw, hash }
    }

    pub fn raw(&self) -> &[u8] {
        &self.raw
    }

    pub fn hash(&self) -> &[u8; 32] {
        &self.hash
    }

    /// Short stable id: the first 8 bytes of the hash, hex.
    pub fn id(&self) -> String {
        self.hash[..8].iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The `Available-Dictionary` value a browser sends for this dictionary:
    /// a Structured Field byte sequence, `:base64(sha256):`.
    pub fn available_dictionary(&self) -> String {
        format!(":{}:", base64(&self.hash))
    }

    /// `true` when an `Available-Dictionary` request header names this dictionary.
    pub fn matches(&self, available_dictionary: &str) -> bool {
        available_dictionary.trim() == self.available_dictionary()
    }

    /// A complete `dcb` body: magic, dictionary hash, then the Brotli stream
    /// compressed against the dictionary. `None` if the library fails.
    pub fn compress(&self, data: &[u8], quality: u32) -> Option<Vec<u8>> {
        let quality = quality.min(11);
        // SAFETY: every pointer passed below is either null where the API allows
        // it, or points into `self.raw` / `data` / `buffer`, which outlive the
        // calls. The prepared dictionary is declared first so its guard drops
        // after the encoder's.
        unsafe {
            let prepared = Prepared(ffi::BrotliEncoderPrepareDictionary(
                ffi::BrotliSharedDictionaryType_BROTLI_SHARED_DICTIONARY_RAW,
                self.raw.len(),
                self.raw.as_ptr(),
                quality as std::os::raw::c_int,
                None,
                None,
                null_mut(),
            ));
            if prepared.0.is_null() {
                return None;
            }
            let encoder = Encoder(ffi::BrotliEncoderCreateInstance(None, None, null_mut()));
            if encoder.0.is_null() {
                return None;
            }
            let size_hint = u32::try_from(data.len()).unwrap_or(u32::MAX);
            for (param, value) in [
                (ffi::BrotliEncoderParameter_BROTLI_PARAM_QUALITY, quality),
                (ffi::BrotliEncoderParameter_BROTLI_PARAM_LGWIN, 22),
                (ffi::BrotliEncoderParameter_BROTLI_PARAM_SIZE_HINT, size_hint),
            ] {
                if ffi::BrotliEncoderSetParameter(encoder.0, param, value) == 0 {
                    return None;
                }
            }
            if ffi::BrotliEncoderAttachPreparedDictionary(encoder.0, prepared.0) == 0 {
                return None;
            }
            let mut out = Vec::with_capacity(36 + data.len() / 3);
            out.extend_from_slice(&DCB_MAGIC);
            out.extend_from_slice(&self.hash);
            let mut buffer = vec![0u8; 1 << 16];
            let mut available_in = data.len();
            let mut next_in = if data.is_empty() { null() } else { data.as_ptr() };
            loop {
                let mut available_out = buffer.len();
                let mut next_out = buffer.as_mut_ptr();
                if ffi::BrotliEncoderCompressStream(
                    encoder.0,
                    ffi::BrotliEncoderOperation_BROTLI_OPERATION_FINISH,
                    &mut available_in,
                    &mut next_in,
                    &mut available_out,
                    &mut next_out,
                    null_mut(),
                ) == 0
                {
                    return None;
                }
                out.extend_from_slice(&buffer[..buffer.len() - available_out]);
                if ffi::BrotliEncoderIsFinished(encoder.0) != 0
                    && ffi::BrotliEncoderHasMoreOutput(encoder.0) == 0
                {
                    break;
                }
            }
            drop(encoder);
            drop(prepared);
            Some(out)
        }
    }

    /// Decode a `dcb` body made with this dictionary (tests and verification;
    /// browsers decode `dcb` natively).
    pub fn decompress(&self, body: &[u8]) -> Option<Vec<u8>> {
        if body.len() < 36 || body[..4] != DCB_MAGIC || body[4..36] != self.hash {
            return None;
        }
        let stream = &body[36..];
        // SAFETY: as in `compress`; the dictionary bytes outlive the decoder.
        unsafe {
            let decoder = Decoder(ffi::BrotliDecoderCreateInstance(None, None, null_mut()));
            if decoder.0.is_null() {
                return None;
            }
            if ffi::BrotliDecoderAttachDictionary(
                decoder.0,
                ffi::BrotliSharedDictionaryType_BROTLI_SHARED_DICTIONARY_RAW,
                self.raw.len(),
                self.raw.as_ptr(),
            ) == 0
            {
                return None;
            }
            let mut out = Vec::with_capacity(stream.len() * 4);
            let mut buffer = vec![0u8; 1 << 16];
            let mut available_in = stream.len();
            let mut next_in = stream.as_ptr();
            loop {
                let mut available_out = buffer.len();
                let mut next_out = buffer.as_mut_ptr();
                let result = ffi::BrotliDecoderDecompressStream(
                    decoder.0,
                    &mut available_in,
                    &mut next_in,
                    &mut available_out,
                    &mut next_out,
                    null_mut(),
                );
                out.extend_from_slice(&buffer[..buffer.len() - available_out]);
                match result {
                    ffi::BrotliDecoderResult_BROTLI_DECODER_RESULT_SUCCESS => return Some(out),
                    ffi::BrotliDecoderResult_BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT => continue,
                    _ => return None,
                }
            }
        }
    }
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dictionary() -> SharedDictionary {
        let raw = br#"{"c1":2,"dict":"1","b":{"cards":{"$c1":0}},"t":[{"n":"#.repeat(40);
        SharedDictionary::new([raw.as_slice(), b"/marketplace/en/cards/ Holo Rare Destined Rivals"].concat())
    }

    #[test]
    fn round_trips_and_carries_the_dcb_header() {
        let dict = dictionary();
        for data in [
            Vec::new(),
            b"x".to_vec(),
            br#"{"c1":2,"dict":"1","b":{"cards":{"$c1":0}},"t":[{"n":24}]}"#.repeat(500),
            (0..=255u8).cycle().take(200_000).collect(),
        ] {
            let body = dict.compress(&data, 11).expect("compress");
            assert_eq!(&body[..4], &DCB_MAGIC);
            assert_eq!(&body[4..36], dict.hash());
            assert_eq!(dict.decompress(&body).expect("decompress"), data);
        }
    }

    #[test]
    fn the_dictionary_makes_matching_data_smaller() {
        let dict = dictionary();
        let data = br#"{"c1":2,"dict":"1","b":{"cards":{"$c1":0}},"t":[{"n":7}]}"#.to_vec();
        let with = dict.compress(&data, 11).unwrap().len() - 36;
        let without = SharedDictionary::new(vec![0u8; 16]).compress(&data, 11).unwrap().len() - 36;
        assert!(with < without, "{with} >= {without}");
    }

    #[test]
    fn a_different_dictionary_is_refused() {
        let body = dictionary().compress(b"hello hello hello", 5).unwrap();
        assert!(SharedDictionary::new(b"other".to_vec()).decompress(&body).is_none());
    }

    #[test]
    fn available_dictionary_is_a_structured_field_byte_sequence() {
        let dict = SharedDictionary::new(b"abc".to_vec());
        // sha256("abc") = ba7816bf…
        assert_eq!(dict.available_dictionary(), ":ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:");
        assert!(dict.matches(" :ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=: "));
        assert_eq!(dict.id(), "ba7816bf8f01cfea");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
    }
}
