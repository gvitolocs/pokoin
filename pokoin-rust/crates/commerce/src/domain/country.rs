//! ISO-3166-1 alpha-2 handling and IP-country seeding, ported from
//! `_checkout_core.js` + `_client_country.js`.

use axum::http::HeaderMap;

use crate::error::{ApiError, ApiResult};

/// EU ship-from allowlist (same set as `market/src/ship-countries.js`).
pub const SHIP_FROM_CODES: [&str; 27] = [
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
    "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
];

const HEADER_KEYS: [&str; 5] = [
    "cf-ipcountry",
    "x-vercel-ip-country",
    "cloudfront-viewer-country",
    "x-country-code",
    "x-geo-country",
];

/// `normalizeCountry`: upper-case ISO-2, but `EU`/`EUROPE` mean "unknown".
pub fn normalize_country(value: &str) -> String {
    let code = value.trim().to_ascii_uppercase();
    if code == "EU" || code == "EUROPE" {
        return String::new();
    }
    if code.len() == 2 && code.chars().all(|c| c.is_ascii_uppercase()) {
        code
    } else {
        String::new()
    }
}

pub fn assert_ship_from_country(value: &str) -> ApiResult<String> {
    let code = normalize_country(value);
    if code.is_empty() {
        return Err(ApiError::bad_request(
            "shipFromCountry must be a real ISO 3166-1 alpha-2 code (not EU).",
        )
        .with_code("invalid_ship_from"));
    }
    Ok(code)
}

pub fn is_allowed_ship_from_country(value: &str) -> bool {
    let code = normalize_country(value);
    !code.is_empty() && SHIP_FROM_CODES.contains(&code.as_str())
}

fn header_value(headers: &HeaderMap, key: &str) -> String {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Raw ISO-2 from request headers, or `''` when unknown / EU / XX / T1.
pub fn country_from_request_headers(headers: &HeaderMap) -> String {
    for key in HEADER_KEYS {
        let code = normalize_country(&header_value(headers, key));
        if code.is_empty() || code == "XX" || code == "T1" {
            continue;
        }
        return code;
    }
    String::new()
}

/// Ship-from seed: IP country only when it is an allowed sell-from country.
pub fn ship_from_country_from_request(headers: &HeaderMap) -> String {
    let code = country_from_request_headers(headers);
    if SHIP_FROM_CODES.contains(&code.as_str()) {
        code
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn normalize_country_rejects_eu_and_junk() {
        assert_eq!(normalize_country(" it "), "IT");
        assert_eq!(normalize_country("EU"), "");
        assert_eq!(normalize_country("Europe"), "");
        assert_eq!(normalize_country("ITA"), "");
        assert_eq!(normalize_country("1T"), "");
    }

    #[test]
    fn ship_from_assertion_matches_node_error() {
        let error = assert_ship_from_country("EU").unwrap_err();
        assert_eq!(error.code.as_deref(), Some("invalid_ship_from"));
        assert_eq!(error.status.as_u16(), 400);
        assert_eq!(assert_ship_from_country("de").unwrap(), "DE");
    }

    #[test]
    fn header_seeding_prefers_cloudflare_then_vercel() {
        let mut headers = HeaderMap::new();
        headers.insert("cf-ipcountry", HeaderValue::from_static("XX"));
        headers.insert("x-vercel-ip-country", HeaderValue::from_static("fr"));
        assert_eq!(country_from_request_headers(&headers), "FR");
        assert_eq!(ship_from_country_from_request(&headers), "FR");

        headers.insert("cf-ipcountry", HeaderValue::from_static("US"));
        assert_eq!(country_from_request_headers(&headers), "US");
        // US is not in the EU sell-from allowlist.
        assert_eq!(ship_from_country_from_request(&headers), "");
    }

    #[test]
    fn header_seeding_skips_tor_and_eu() {
        let mut headers = HeaderMap::new();
        headers.insert("cf-ipcountry", HeaderValue::from_static("T1"));
        headers.insert("x-country-code", HeaderValue::from_static("EU"));
        headers.insert("x-geo-country", HeaderValue::from_static("de"));
        assert_eq!(ship_from_country_from_request(&headers), "DE");
    }
}
