//! Client IP country from edge/proxy headers.
//!
//! Port of `server/pokoin-api/_client_country.js`: Cloudflare, Vercel,
//! CloudFront, Fastly and generic geo headers, in that order. `XX`, `T1` and
//! the EU continent code stay empty so the client opens the international
//! marketplace instead of guessing.

use axum::http::HeaderMap;

/// EU sell-from allowlist (same set as `market/src/ship-countries.js`).
pub const SHIP_FROM_CODES: [&str; 27] = [
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
    "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
];

const HEADER_KEYS: [&str; 5] = [
    "cf-ipcountry",
    "x-vercel-ip-country",
    "cloudfront-viewer-country",
    "x-country-code",
    "x-geo-country",
];

/// `normalizeCountry` — upper-case ISO-2, dropping `EU`/`EUROPE` and junk.
pub fn normalize_country(value: &str) -> String {
    let code = value.trim().to_uppercase();
    if code == "EU" || code == "EUROPE" {
        return String::new();
    }
    let bytes = code.as_bytes();
    if bytes.len() == 2 && bytes.iter().all(|b| b.is_ascii_uppercase()) {
        code
    } else {
        String::new()
    }
}

fn header_value(headers: &HeaderMap, key: &str) -> String {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Raw ISO-2 from request headers, or `""` when unknown / EU / XX / T1.
pub fn country_from_headers(headers: &HeaderMap) -> String {
    for key in HEADER_KEYS {
        let code = normalize_country(&header_value(headers, key));
        if code.is_empty() || code == "XX" || code == "T1" {
            continue;
        }
        return code;
    }
    String::new()
}

/// Ship-from seed: the IP country only when it is an allowed sell-from country.
pub fn ship_from_country_from_headers(headers: &HeaderMap) -> String {
    let code = country_from_headers(headers);
    if SHIP_FROM_CODES.contains(&code.as_str()) {
        code
    } else {
        String::new()
    }
}

/// `isAllowedShipFromCountry`.
pub fn is_allowed_ship_from_country(value: &str) -> bool {
    let code = normalize_country(value);
    !code.is_empty() && SHIP_FROM_CODES.contains(&code.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn picks_first_known_header() {
        assert_eq!(country_from_headers(&headers(&[("cf-ipcountry", "it")])), "IT");
        assert_eq!(
            country_from_headers(&headers(&[("cf-ipcountry", "XX"), ("x-vercel-ip-country", "de")])),
            "DE"
        );
        assert_eq!(country_from_headers(&headers(&[("cf-ipcountry", "T1")])), "");
        assert_eq!(country_from_headers(&headers(&[("cf-ipcountry", "EU")])), "");
        assert_eq!(country_from_headers(&headers(&[])), "");
    }

    #[test]
    fn ship_from_only_inside_the_allowlist() {
        assert_eq!(ship_from_country_from_headers(&headers(&[("cf-ipcountry", "es")])), "ES");
        assert_eq!(ship_from_country_from_headers(&headers(&[("cf-ipcountry", "us")])), "");
        assert!(is_allowed_ship_from_country("fr"));
        assert!(!is_allowed_ship_from_country("US"));
        assert!(!is_allowed_ship_from_country("EU"));
        assert!(!is_allowed_ship_from_country(""));
    }

    #[test]
    fn normalize_country_rejects_junk() {
        assert_eq!(normalize_country(" gb "), "GB");
        assert_eq!(normalize_country("europe"), "");
        assert_eq!(normalize_country("USA"), "");
        assert_eq!(normalize_country("1A"), "");
    }
}
