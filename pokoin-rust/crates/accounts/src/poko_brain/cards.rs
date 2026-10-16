//! Reply cards taken from tool JSON, in the shape `clean_cards` already returns.
//!
//! At most six, deduped by card id, preferring the order the reply mentions them.
//! `attach_reply_cards` still runs in the chat handler and strips the `[[cards:]]` line.

use serde_json::{json, Map, Value as Json};

use crate::domain::poko_chat::{clean_cards, MAX_REPLY_CARDS};

pub(crate) fn from_results(results: &[Json], reply: &str) -> Vec<Json> {
    let mut raw: Vec<Json> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for result in results {
        collect(result, &mut raw, &mut seen);
    }
    let cleaned = clean_cards(Some(&Json::Array(raw.clone())));
    let mut cards: Vec<Json> = Vec::new();
    for card in cleaned {
        let id = card.get("cardId").and_then(Json::as_str).unwrap_or("");
        let number = raw.iter().find_map(|row| {
            let row_id = text_field(row, &["cardId", "id"]);
            if !id.is_empty() && row_id == id {
                let number = text_field(row, &["cardNumber", "number"]);
                if number.is_empty() {
                    None
                } else {
                    Some(number)
                }
            } else {
                None
            }
        });
        let mut card = card;
        if let Some(number) = number {
            if let Some(object) = card.as_object_mut() {
                object.insert("cardNumber".into(), json!(number));
            }
        }
        cards.push(card);
    }
    // `clean_cards` keeps input order. Re-order by the first mention, then cap.
    cards.sort_by_key(|card| mention_at(reply, card));
    cards.truncate(MAX_REPLY_CARDS);
    cards
}

fn collect(value: &Json, out: &mut Vec<Json>, seen: &mut Vec<String>) {
    match value {
        Json::Array(items) => {
            for item in items {
                collect(item, out, seen);
            }
        }
        Json::Object(object) => {
            if let Some(card) = as_card(object) {
                let key = dedupe_key(&card);
                if !key.is_empty() && !seen.iter().any(|existing| existing == &key) {
                    seen.push(key);
                    out.push(card);
                }
            }
            for (key, child) in object {
                if key == "card"
                    || key == "cards"
                    || key == "candidates"
                    || child.is_array()
                    || child.is_object()
                {
                    collect(child, out, seen);
                }
            }
        }
        _ => {}
    }
}

fn as_card(object: &Map<String, Json>) -> Option<Json> {
    let card_id = text_in(object, &["cardId", "id"]);
    let name = text_in(object, &["name", "cardName"]);
    let set_name = text_in(object, &["setName", "set"]);
    let number = text_in(object, &["cardNumber", "number"]);
    if card_id.is_empty() && (name.is_empty() || set_name.is_empty()) {
        return None;
    }
    let path = text_in(object, &["path", "canonicalPath"]);
    let image = text_in(object, &["imageUrl", "cardImageUrl", "image"]);
    let price = price_in(object);
    Some(json!({
        "kind": "card",
        "cardId": card_id,
        "name": name,
        "cardName": name,
        "setName": set_name,
        "cardNumber": number,
        "path": path,
        "canonicalPath": if path.is_empty() { Json::Null } else { json!(path) },
        "imageUrl": image,
        "pricePkn": price,
    }))
}

fn dedupe_key(card: &Json) -> String {
    let id = text_field(card, &["cardId"]);
    if !id.is_empty() {
        return id;
    }
    let name = text_field(card, &["name"]).to_ascii_lowercase();
    let set_name = text_field(card, &["setName"]).to_ascii_lowercase();
    let number = text_field(card, &["cardNumber"]).to_ascii_lowercase();
    if name.is_empty() {
        String::new()
    } else {
        format!("{name}|{set_name}|{number}")
    }
}

fn mention_at(reply: &str, card: &Json) -> usize {
    let haystack = reply.to_ascii_lowercase();
    let mut best = usize::MAX;
    for key in ["name", "cardId", "cardNumber"] {
        let needle = text_field(card, &[key]);
        if needle.chars().count() < 2 {
            continue;
        }
        if let Some(index) = haystack.find(&needle.to_ascii_lowercase()) {
            best = best.min(index);
        }
    }
    best
}

fn text_in(object: &Map<String, Json>, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| object.get(*key))
        .map(json_text)
        .unwrap_or_default()
}

fn text_field(value: &Json, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key))
        .map(json_text)
        .unwrap_or_default()
}

fn json_text(value: &Json) -> String {
    match value {
        Json::String(text) => text.trim().to_string(),
        Json::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

fn price_in(object: &Map<String, Json>) -> f64 {
    for key in [
        "pricePkn",
        "price",
        "minAsk",
        "medianPkn",
        "medianSoldPkn",
        "fromAsk",
    ] {
        if let Some(number) = object.get(key).and_then(Json::as_f64) {
            if number > 0.0 {
                return number;
            }
        }
    }
    0.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cards_follow_the_reply_and_drop_duplicates() {
        let results = vec![json!({
            "ok": true,
            "candidates": [
                {"cardId": "2", "name": "Eevee", "setName": "Jungle", "cardNumber": "11/64", "pricePkn": 40},
                {"cardId": "2", "name": "Eevee", "setName": "Jungle", "cardNumber": "11/64"},
                {"cardId": "1", "name": "Pikachu", "setName": "Base", "cardNumber": "58/102", "imageUrl": "https://cdn.example/p.jpg", "price": 12}
            ]
        })];
        let cards = from_results(&results, "Look at Pikachu first, then Eevee.");
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0]["cardId"], json!("1"));
        assert_eq!(cards[0]["name"], json!("Pikachu"));
        assert_eq!(cards[0]["cardName"], json!("Pikachu"));
        assert_eq!(cards[0]["cardNumber"], json!("58/102"));
        assert_eq!(cards[0]["kind"], json!("card"));
        assert_eq!(cards[0]["pricePkn"], json!(12));
        assert_eq!(cards[1]["cardId"], json!("2"));
    }
}
