//! Port of `_marketplace_image_log.js` — the in-process ring buffer of image
//! selections plus the `marketplace-image` info log line.

use serde_json::{json, Value};
use std::sync::Mutex;
use std::sync::OnceLock;

use super::js;

const RING_LIMIT: usize = 250;

fn ring() -> &'static Mutex<Vec<Value>> {
    static RING: OnceLock<Mutex<Vec<Value>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(Vec::new()))
}

/// `imagePrefix(url)` — the leading `\d+_` id of a leftover image key.
pub fn image_prefix(url: &str) -> String {
    prefix_re()
        .captures(url)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default()
}

/// `prefixKind(cardId, ctId, url)`.
pub fn prefix_kind(card_id: &str, ct_id: &str, url: &str) -> String {
    let prefix = image_prefix(url);
    if prefix.is_empty() {
        return "none".to_string();
    }
    let card = card_id.trim();
    let ct = ct_id.trim();
    if !ct.is_empty() && prefix == ct {
        return "ct_id".to_string();
    }
    if !card.is_empty() && prefix == card {
        return "public_id".to_string();
    }
    if let Ok(card_number) = card.parse::<f64>() {
        if card_number > 0.0
            && (card_number as i64) % 2 == 0
            && prefix == (card_number / 2.0).to_string()
        {
            return "ct_id".to_string();
        }
    }
    "other".to_string()
}

/// The input of `recordMarketplaceImage`.
#[derive(Debug, Default, Clone)]
pub struct ImageEvent<'a> {
    pub source: &'a str,
    pub status: &'a str,
    pub route: &'a str,
    pub card_id: &'a str,
    pub ct_id: &'a str,
    pub name: &'a str,
    pub url: &'a str,
    pub fallback_url: &'a str,
    pub error: &'a str,
    pub session_id: &'a str,
}

/// `recordMarketplaceImage(input)` — append to the ring and log.
pub fn record_marketplace_image(event: ImageEvent<'_>) -> Value {
    let entry = json!({
        "at": now_iso(),
        "source": clean_or(event.source, 80, "unknown"),
        "status": clean_or(event.status, 40, "served"),
        "route": js::clean_text_str(event.route, 240),
        "cardId": js::clean_text_str(event.card_id, 32),
        "ctId": js::clean_text_str(event.ct_id, 32),
        "name": js::clean_text_str(event.name, 80),
        "url": js::clean_text_str(event.url, 300),
        "fallbackUrl": js::clean_text_str(event.fallback_url, 300),
        "prefix": image_prefix(event.url),
        "prefixKind": prefix_kind(event.card_id, event.ct_id, event.url),
        "error": js::clean_text_str(event.error, 200),
        "sessionId": js::clean_text_str(event.session_id, 80),
    });
    let mut ring = ring()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    ring.push(entry.clone());
    if ring.len() > RING_LIMIT {
        ring.remove(0);
    }
    tracing::info!(target: "marketplace-image", "{entry}");
    entry
}

/// `recordHomeImages(snapshot, route)`.
pub fn record_home_images(snapshot: &Value, route: &str) {
    let cards = snapshot
        .get("cards")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let sections = snapshot.get("sections").cloned().unwrap_or(Value::Null);
    let take = |key: &str| -> Vec<String> {
        sections
            .get(key)
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .take(6)
                    .map(|v| js::string_or_empty(Some(v)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let mut wanted: Vec<String> = Vec::new();
    wanted.extend(take("recentlySeenIds"));
    wanted.extend(take("bestSellerIds"));
    wanted.extend(take("featuredIds"));
    let mut seen = std::collections::HashSet::new();
    for id in wanted {
        if !seen.insert(id.clone()) {
            continue;
        }
        let card = cards
            .iter()
            .find(|card| js::string_or_empty(js::get(card, "id")) == id)
            .cloned()
            .unwrap_or(Value::Null);
        let url = js::string_chain(&[
            js::get(&card, "homepageImageUrl"),
            js::get(&card, "previewImageUrl"),
            js::get(&card, "imageUrl"),
        ]);
        let card_id = js::string_chain(&[js::get(&card, "id"), Some(&Value::String(id.clone()))]);
        let ct_id = js::string_chain(&[js::get(&card, "ct_id"), js::get(&card, "ctId")]);
        let name = js::string_or_empty(js::get(&card, "name"));
        let fallback_url = js::string_or_empty(js::get(&card, "imageUrl"));
        record_marketplace_image(ImageEvent {
            source: "marketplace-home",
            status: "served",
            route,
            card_id: &card_id,
            ct_id: &ct_id,
            name: &name,
            url: &url,
            fallback_url: &fallback_url,
            error: "",
            session_id: "",
        });
    }
}

/// `recordVersionImages(rows, query)`.
pub fn record_version_images(rows: &[Value], route: &str, card_id: &str) {
    for row in rows.iter().take(3) {
        let row_card_id = js::string_chain(&[
            js::get(row, "card_id"),
            js::get(row, "cardId"),
            Some(&Value::String(card_id.to_string())),
        ]);
        let ct_id = js::string_chain(&[
            js::get(row, "ct_id"),
            js::get(row, "ctId"),
            js::get(row, "blueprint_id"),
        ]);
        let name = js::string_or_empty(js::get(row, "name"));
        let url = js::string_chain(&[
            js::get(row, "image_url"),
            js::get(row, "imageUrl"),
            js::get(row, "cdn_image_url"),
        ]);
        let fallback_url = js::string_chain(&[
            js::get(row, "preview_image_url"),
            js::get(row, "previewImageUrl"),
        ]);
        record_marketplace_image(ImageEvent {
            source: "marketplace-card-versions",
            status: "served",
            route,
            card_id: &row_card_id,
            ct_id: &ct_id,
            name: &name,
            url: &url,
            fallback_url: &fallback_url,
            error: "",
            session_id: "",
        });
    }
}

/// `recordCardsImages(rows, query)`.
pub fn record_cards_images(rows: &[Value], route: &str) {
    for row in rows.iter().take(8) {
        let card_id = js::string_chain(&[
            js::get(row, "id"),
            js::get(row, "card_id"),
            js::get(row, "cardId"),
        ]);
        let ct_id = js::string_chain(&[js::get(row, "ct_id"), js::get(row, "ctId")]);
        let name = js::string_or_empty(js::get(row, "name"));
        let url = js::string_chain(&[
            js::get(row, "homepageImageUrl"),
            js::get(row, "previewImageUrl"),
            js::get(row, "imageUrl"),
            js::get(row, "preview_image_url"),
            js::get(row, "cdn_image_url"),
            js::get(row, "image_url"),
        ]);
        let fallback_url = js::string_chain(&[js::get(row, "imageUrl"), js::get(row, "image_url")]);
        record_marketplace_image(ImageEvent {
            source: "marketplace-cards",
            status: "served",
            route,
            card_id: &card_id,
            ct_id: &ct_id,
            name: &name,
            url: &url,
            fallback_url: &fallback_url,
            error: "",
            session_id: "",
        });
    }
}

/// `listMarketplaceImages(limit)` — newest first.
pub fn list_marketplace_images(limit: usize) -> Vec<Value> {
    let size = limit.clamp(1, RING_LIMIT);
    let ring = ring()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    ring.iter().rev().take(size).cloned().collect()
}

fn clean_or(value: &str, max: usize, fallback: &str) -> String {
    let clean = js::clean_text_str(value, max);
    if clean.is_empty() {
        fallback.to_string()
    } else {
        clean
    }
}

fn now_iso() -> Value {
    let now = chrono::Utc::now();
    Value::String(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn prefix_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"/(?:previews/)?(\d+)_").expect("valid regex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_and_kinds() {
        assert_eq!(
            image_prefix("https://cdn.pokoin.com/334063_x.jpg"),
            "334063"
        );
        assert_eq!(image_prefix("/card-images/previews/99_y.jpg"), "99");
        assert_eq!(image_prefix("/card-images/nokey.jpg"), "");
        assert_eq!(
            prefix_kind("668126", "334063", "/x/668126_a.jpg"),
            "public_id"
        );
        assert_eq!(prefix_kind("668126", "334063", "/x/334063_a.jpg"), "ct_id");
        assert_eq!(prefix_kind("668126", "", "/x/334063_a.jpg"), "ct_id");
        assert_eq!(prefix_kind("668126", "", "/x/109873_a.jpg"), "other");
        assert_eq!(prefix_kind("", "", "/x/1.jpg"), "none");
    }

    #[test]
    fn ring_records_and_lists_newest_first() {
        let before = list_marketplace_images(250).len();
        record_marketplace_image(ImageEvent {
            source: "test",
            url: "/x/5_a.jpg",
            card_id: "10",
            ..Default::default()
        });
        let all = list_marketplace_images(250);
        assert_eq!(all.len(), before + 1);
        assert_eq!(all[0]["source"], json!("test"));
        // 10 is even and 5 == 10/2, so the prefix kind is ct_id (first match wins
        // over public_id in prefixKind ordering).
        assert_eq!(all[0]["prefixKind"], json!("ct_id"));
        assert_eq!(all[0]["status"], json!("served"));
        assert_eq!(list_marketplace_images(1).len(), 1);
    }
}
