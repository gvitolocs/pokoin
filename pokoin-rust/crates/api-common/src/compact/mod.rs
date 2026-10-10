//! The opt-in compact response encoding, `c1`.
//!
//! The default `application/json` body of every route stays byte-for-byte what
//! it is today — it is a frozen contract shared with the SPA and the CardVault
//! apps. `c1` is an additional representation of the *same* body, chosen by the
//! client:
//!
//! - `Accept: application/vnd.pokoin.c1+json`, or
//! - `?format=c1` (for cache-busting and for clients that cannot set `Accept`).
//!
//! A `c1` response keeps the status code and the `Cache-Control` of the default
//! response and swaps only the content type and the body. Both representations
//! carry `Vary: Accept`, so a shared cache can never hand a `c1` body to a
//! client that asked for plain JSON.
//!
//! See `docs/rust-migration/COMPACT_ENCODING.md` for why this shape was chosen
//! over JSON+brotli alone, CBOR/MessagePack and shared-dictionary compression,
//! and `market/src/compact.js` for the browser decoder.

use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::Value;

use crate::http;
use crate::public_error::sanitize_public_json;

pub mod decode;
pub mod dict;
pub mod encode;
pub mod template;

#[cfg(test)]
mod tests;

/// The `c1` media type.
pub const C1_MEDIA_TYPE: &str = "application/vnd.pokoin.c1+json";

/// The content type a `c1` body is sent with. It is `application/json`, not
/// the `c1` media type: Cloudflare only compresses the content types it knows,
/// and an uncompressed `c1` body is larger on the wire than brotli'd JSON. The
/// payload marks itself (`{"c1":1,…}`) and the response carries
/// [`C1_FORMAT_HEADER`].
pub const C1_CONTENT_TYPE: &str = "application/json; charset=utf-8";

/// `x-pokoin-format: c1` on every compact response.
pub const C1_FORMAT_HEADER: (&str, &str) = ("x-pokoin-format", "c1");

/// Which representation a request asked for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Wanted {
    c1: bool,
    templates: bool,
}

impl Wanted {
    /// The default representation — what every existing client gets.
    pub const DEFAULT: Self = Self { c1: false, templates: false };

    /// `true` when the client asked for `c1`.
    pub fn c1(self) -> bool {
        self.c1
    }

    /// `true` when the client also reads template columns (format `2`):
    /// `?format=c1v2`, or `v=2` on the `c1` media type in `Accept`.
    pub fn templates(self) -> bool {
        self.c1 && self.templates
    }

    /// The encoder options this representation allows.
    pub fn encode_options(self) -> encode::EncodeOptions {
        encode::EncodeOptions { templates: self.templates() }
    }

    /// Read the request's preference from the `Accept` header and the query.
    pub fn from_request(headers: &HeaderMap, query: &http::Query) -> Self {
        match query.first("format") {
            Some(value) if value.eq_ignore_ascii_case("c1") => return Self { c1: true, templates: false },
            Some(value) if value.eq_ignore_ascii_case("c1v2") => return Self { c1: true, templates: true },
            _ => {}
        }
        let accepts: Vec<&str> = headers
            .get_all(axum::http::header::ACCEPT)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect();
        Self {
            c1: accepts.iter().any(|accept| accept_lists_c1(accept)),
            templates: accepts.iter().any(|accept| accept_lists_c1_v2(accept)),
        }
    }

    /// Read the preference from an `Accept` header value and a raw query string.
    pub fn from_parts(accept: Option<&str>, raw_query: &str) -> Self {
        let mut headers = HeaderMap::new();
        if let Some(accept) = accept.and_then(|value| value.parse().ok()) {
            headers.insert(axum::http::header::ACCEPT, accept);
        }
        Self::from_request(&headers, &http::Query::parse(raw_query))
    }
}

/// An `Accept` value that names the `c1` media type in one of its entries.
///
/// `*/*` is deliberately **not** a match: `c1` is opt-in, and every browser
/// sends `*/*` somewhere in its `Accept`.
fn accept_lists_c1(accept: &str) -> bool {
    accept.split(',').any(|entry| {
        let media = entry.split(';').next().unwrap_or("").trim();
        media.eq_ignore_ascii_case(C1_MEDIA_TYPE)
    })
}

/// A `c1` entry that also asks for format `2` (`; v=2`).
fn accept_lists_c1_v2(accept: &str) -> bool {
    accept.split(',').any(|entry| {
        let mut parts = entry.split(';');
        let media = parts.next().unwrap_or("").trim();
        media.eq_ignore_ascii_case(C1_MEDIA_TYPE)
            && parts.any(|param| param.trim().eq_ignore_ascii_case("v=2"))
    })
}

/// The `Vary` header both representations carry.
const VARY_ACCEPT: (&str, &str) = ("vary", "Accept");

/// `jsonOk(res, body, cacheControl)`, in whichever representation the client
/// asked for. The default path produces exactly the bytes [`http::json_ok`]
/// produces today, plus `Vary: Accept`.
pub fn json_ok(wanted: Wanted, body: Value, cache_control: &str) -> Response {
    json_with_cors(wanted, StatusCode::OK, body, cache_control)
}

/// A JSON response with the read CORS headers, an optional `Cache-Control`, and
/// the requested representation.
pub fn json_with_cors(
    wanted: Wanted,
    status: StatusCode,
    body: Value,
    cache_control: &str,
) -> Response {
    let mut headers: Vec<(&str, &str)> = http::READ_CORS.to_vec();
    if !cache_control.is_empty() {
        headers.push(("cache-control", cache_control));
    }
    json_with(wanted, status, body, &headers)
}

/// A JSON response with explicit headers, in the requested representation.
///
/// `sanitize_public_json` runs before the encoding, so an infrastructure error
/// is turned into the public 503 in both representations, exactly as today.
pub fn json_with(
    wanted: Wanted,
    status: StatusCode,
    body: Value,
    headers: &[(&str, &str)],
) -> Response {
    let mut headers: Vec<(&str, &str)> = headers.to_vec();
    headers.push(VARY_ACCEPT);
    if !wanted.c1 {
        return http::json_with(status, body, &headers);
    }
    let (status, body) = sanitize_public_json(status, body);
    headers.push(C1_FORMAT_HEADER);
    let bytes = crate::stages::timed_sync(crate::stages::SERIALIZE, || encode::encode_to_vec_with(&body, wanted.encode_options()));
    http::raw(status, C1_CONTENT_TYPE, bytes, &headers)
}

/// A 200 whose default body is already serialised (a prebuilt snapshot).
/// The default representation sends `json` untouched; `c1` sends the stored
/// compact bytes when the snapshot has them, else encodes `json` now.
pub fn prebuilt(
    wanted: Wanted,
    json: Vec<u8>,
    c1: Option<Vec<u8>>,
    headers: &[(&str, &str)],
) -> Response {
    let mut headers: Vec<(&str, &str)> = headers.to_vec();
    headers.push(VARY_ACCEPT);
    if !wanted.c1 {
        return http::raw(StatusCode::OK, "application/json; charset=utf-8", json, &headers);
    }
    headers.push(C1_FORMAT_HEADER);
    // Stored bytes are format 1; a format-2 request is encoded now.
    let bytes = match c1.filter(|_| !wanted.templates()) {
        Some(bytes) => bytes,
        None => crate::stages::timed_sync(crate::stages::SERIALIZE, || {
            match serde_json::from_slice::<Value>(&json) {
                Ok(body) => encode::encode_to_vec_with(&body, wanted.encode_options()),
                Err(_) => json,
            }
        }),
    };
    http::raw(StatusCode::OK, C1_CONTENT_TYPE, bytes, &headers)
}

#[cfg(test)]
mod negotiation_tests {
    use super::*;

    #[test]
    fn c1v2_is_opt_in_on_top_of_c1() {
        assert!(Wanted::from_parts(None, "format=c1v2").templates());
        assert!(Wanted::from_parts(None, "format=C1V2").c1());
        assert!(!Wanted::from_parts(None, "format=c1").templates());
        assert!(Wanted::from_parts(Some("application/vnd.pokoin.c1+json; v=2"), "").templates());
        assert!(!Wanted::from_parts(Some(C1_MEDIA_TYPE), "").templates());
        assert!(!Wanted::DEFAULT.templates());
    }

    #[test]
    fn query_selects_c1() {
        assert!(Wanted::from_parts(None, "format=c1").c1());
        assert!(Wanted::from_parts(None, "slug=base-set&format=C1").c1());
        assert!(!Wanted::from_parts(None, "format=c2").c1());
        assert!(!Wanted::from_parts(None, "").c1());
    }

    #[test]
    fn accept_selects_c1_only_when_it_names_the_type() {
        assert!(Wanted::from_parts(Some(C1_MEDIA_TYPE), "").c1());
        assert!(Wanted::from_parts(Some("application/vnd.pokoin.c1+json; q=0.9"), "").c1());
        assert!(Wanted::from_parts(Some("application/json, application/vnd.pokoin.c1+json"), "").c1());
        // A browser's blanket Accept must never opt a page into c1.
        assert!(!Wanted::from_parts(Some("*/*"), "").c1());
        assert!(!Wanted::from_parts(Some("application/json, */*"), "").c1());
        assert!(!Wanted::from_parts(Some("application/vnd.pokoin.c2+json"), "").c1());
        assert!(!Wanted::DEFAULT.c1());
    }
}
