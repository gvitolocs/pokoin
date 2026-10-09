//! Marketplace image diagnostics, ported from `_marketplace_image_log.js`.
//!
//! The Node writer keeps an in-process ring buffer and logs one structured line
//! per served image; there is no database table. The useful, testable part is
//! the derivation: the numeric prefix of an image URL and what that prefix
//! refers to (the CardTrader id, the public card id, or neither).

use serde_json::{json, Value};

/// The `\d+` that follows a preview path segment, e.g. `.../previews/123_foo.jpg`.
pub fn image_prefix(url: &str) -> String {
    let bytes: Vec<char> = url.chars().collect();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == '/' {
            let mut cursor = index + 1;
            let previews = "previews/";
            if url[index + 1..].starts_with(previews) {
                cursor = index + 1 + previews.len();
            }
            let start = cursor;
            while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                cursor += 1;
            }
            if cursor > start && cursor < bytes.len() && bytes[cursor] == '_' {
                return bytes[start..cursor].iter().collect();
            }
        }
        index += 1;
    }
    String::new()
}

/// `prefixKind(cardId, ctId, url)`.
pub fn prefix_kind(card_id: &str, ct_id: &str, url: &str) -> &'static str {
    let prefix = image_prefix(url);
    if prefix.is_empty() {
        return "none";
    }
    let card = card_id.trim();
    let ct = ct_id.trim();
    if !ct.is_empty() && prefix == ct {
        return "ct_id";
    }
    if !card.is_empty() && prefix == card {
        return "public_id";
    }
    // The public card id is the doubled CardTrader id.
    if !card.is_empty() {
        if let Ok(number) = card.parse::<i64>() {
            if number % 2 == 0 && number / 2 >= 0 && prefix == (number / 2).to_string() {
                return "ct_id";
            }
        }
    }
    "other"
}

fn clean(value: Option<&Value>, max: usize) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(max)
        .collect()
}

/// `recordMarketplaceImage`: the structured entry written for one served image.
pub fn marketplace_image_entry(input: &Value, at_iso: &str) -> Value {
    let card_id = clean(input.get("cardId"), 32);
    let ct_id = clean(input.get("ctId"), 32);
    let url = clean(input.get("url"), 300);
    json!({
        "at": at_iso,
        "source": if clean(input.get("source"), 80).is_empty() {
            "unknown".to_string()
        } else {
            clean(input.get("source"), 80)
        },
        "status": if clean(input.get("status"), 40).is_empty() {
            "served".to_string()
        } else {
            clean(input.get("status"), 40)
        },
        "route": clean(input.get("route"), 240),
        "cardId": card_id,
        "ctId": ct_id,
        "name": clean(input.get("name"), 80),
        "url": url,
        "fallbackUrl": clean(input.get("fallbackUrl"), 300),
        "prefix": image_prefix(&url),
        "prefixKind": prefix_kind(&card_id, &ct_id, &url),
        "error": clean(input.get("error"), 200),
        "sessionId": clean(input.get("sessionId"), 80),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_prefix_reads_the_number_before_the_underscore() {
        assert_eq!(image_prefix("/cdn/cards/1234567_foo.jpg"), "1234567");
        assert_eq!(image_prefix("/cdn/previews/7654321_bar.webp"), "7654321");
        assert_eq!(image_prefix("https://cdn.pokoin.com/previews/42_a_b.png"), "42");
        // No underscore after the digits is not a prefix.
        assert_eq!(image_prefix("/cdn/123.jpg"), "");
        assert_eq!(image_prefix(""), "");
        assert_eq!(image_prefix("/cdn/abc_def.jpg"), "");
    }

    #[test]
    fn prefix_kind_classifies_cardtrader_public_and_other() {
        // The prefix equals the CardTrader id.
        assert_eq!(prefix_kind("10", "42", "/p/42_a.jpg"), "ct_id");
        // The prefix equals the public card id.
        assert_eq!(prefix_kind("42", "9", "/p/42_a.jpg"), "public_id");
        // The public id is the doubled CardTrader id.
        assert_eq!(prefix_kind("84", "9", "/p/42_a.jpg"), "ct_id");
        // An odd public id never doubles into an integer CardTrader id.
        assert_eq!(prefix_kind("85", "9", "/p/42_a.jpg"), "other");
        // Unknown ids and a missing prefix.
        assert_eq!(prefix_kind("", "", "/p/42_a.jpg"), "other");
        assert_eq!(prefix_kind("1", "2", "/p/abc_a.jpg"), "none");
        assert_eq!(prefix_kind("1", "2", ""), "none");
    }

    #[test]
    fn entries_carry_the_node_defaults_and_derived_fields() {
        let entry = marketplace_image_entry(
            &json!({ "url": "/previews/84_a.jpg", "cardId": "168", "ctId": "84" }),
            "2026-10-08T00:00:00Z",
        );
        assert_eq!(entry["source"], json!("unknown"));
        assert_eq!(entry["status"], json!("served"));
        assert_eq!(entry["prefix"], json!("84"));
        assert_eq!(entry["prefixKind"], json!("ct_id"));
        assert_eq!(entry["route"], json!(""));
        assert_eq!(entry["at"], json!("2026-10-08T00:00:00Z"));

        let explicit = marketplace_image_entry(
            &json!({ "source": " card-desk ", "status": "fallback",
                     "url": "/previews/9_a.jpg", "error": "404" }),
            "2026-10-08T00:00:00Z",
        );
        assert_eq!(explicit["source"], json!("card-desk"));
        assert_eq!(explicit["status"], json!("fallback"));
        assert_eq!(explicit["error"], json!("404"));
        assert_eq!(explicit["prefixKind"], json!("other"));
    }
}
