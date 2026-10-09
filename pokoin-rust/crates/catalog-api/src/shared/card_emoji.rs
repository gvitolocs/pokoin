//! Port of `_marketplace_card_emoji.js`.

use serde_json::{Map, Value};
use unicode_segmentation::UnicodeSegmentation;

use super::js;

/// `emojiTokens(value)` — grapheme clusters (Intl.Segmenter), trimmed,
/// empties dropped.
pub fn emoji_tokens(value: Option<&Value>) -> Vec<String> {
    let text = js::string_or_empty(value);
    if text.trim().is_empty() {
        return Vec::new();
    }
    text.graphemes(true)
        .map(|g| g.trim().to_string())
        .filter(|g| !g.is_empty())
        .collect()
}

/// `cardIdentityEmojisForCard(row)`.
pub fn card_identity_emojis_for_card(row: &Value) -> Vec<String> {
    let structured = js::or(
        js::get(row, "cardIdentityEmojis"),
        js::get(row, "card_identity_emojis").unwrap_or(&Value::Null),
    );
    if structured.is_array() {
        return structured
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .flat_map(|item| emoji_tokens(Some(item)))
                    .collect()
            })
            .unwrap_or_default();
    }
    emoji_tokens(js::truthy_chain(&[
        js::get(row, "cardIdentityEmoji"),
        js::get(row, "card_identity_emoji"),
    ]))
}

/// `cardEmojiFields(row)` — the seven emoji fields in Node key order.
pub fn card_emoji_fields(row: &Value) -> Map<String, Value> {
    let identity = card_identity_emojis_for_card(row);
    let variant = emoji_tokens(js::truthy_chain(&[
        js::get(row, "rarityVariantEmoji"),
        js::get(row, "rarity_variant_emoji"),
        js::get(row, "variantEmoji"),
        js::get(row, "variant_emoji"),
    ]))
    .into_iter()
    .next()
    .unwrap_or_default();
    let emoji = js::string_or_empty(js::get(row, "emoji"))
        .trim()
        .to_string();
    let mut fields = Map::new();
    fields.insert(
        "cardIdentityEmoji".into(),
        Value::String(identity.join(" ")),
    );
    fields.insert(
        "card_identity_emoji".into(),
        Value::String(identity.join(" ")),
    );
    fields.insert(
        "cardIdentityEmojis".into(),
        Value::Array(identity.iter().cloned().map(Value::String).collect()),
    );
    fields.insert(
        "card_identity_emojis".into(),
        Value::Array(identity.iter().cloned().map(Value::String).collect()),
    );
    fields.insert("rarityVariantEmoji".into(), Value::String(variant.clone()));
    fields.insert("rarity_variant_emoji".into(), Value::String(variant));
    fields.insert("emoji".into(), Value::String(emoji));
    fields
}

/// `withCardEmojiFields(row)`.
pub fn with_card_emoji_fields(row: &Value) -> Value {
    let mut map = row.as_object().cloned().unwrap_or_default();
    for (key, value) in card_emoji_fields(row) {
        map.insert(key, value);
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn emoji_tokens_split_graphemes() {
        assert_eq!(emoji_tokens(Some(&json!("🏆"))), vec!["🏆"]);
        assert_eq!(emoji_tokens(Some(&json!("🦇 🌙"))), vec!["🦇", "🌙"]);
        assert_eq!(emoji_tokens(Some(&json!(""))), Vec::<String>::new());
        assert_eq!(emoji_tokens(None), Vec::<String>::new());
        // ZWJ family is one grapheme cluster.
        assert_eq!(emoji_tokens(Some(&json!("👨‍👩‍👧"))).len(), 1);
    }

    #[test]
    fn fields_prefer_structured_lists() {
        let row = json!({"cardIdentityEmojis": ["🏆", "🌙 x"], "emoji": " 🏆 "});
        let fields = card_emoji_fields(&row);
        // flatMap(emojiTokens) splits every element.
        assert_eq!(fields["cardIdentityEmoji"], json!("🏆 🌙 x"));
        assert_eq!(fields["card_identity_emoji"], json!("🏆 🌙 x"));
        assert_eq!(fields["cardIdentityEmojis"], json!(["🏆", "🌙", "x"]));
        assert_eq!(fields["rarityVariantEmoji"], json!(""));
        assert_eq!(fields["emoji"], json!("🏆"));
    }

    #[test]
    fn snake_case_sources_fill_fields() {
        let row = json!({"card_identity_emoji": "x y", "rarity_variant_emoji": "⭐ z"});
        let fields = card_emoji_fields(&row);
        assert_eq!(fields["cardIdentityEmoji"], json!("x y"));
        assert_eq!(fields["rarityVariantEmoji"], json!("⭐"));
        let with = with_card_emoji_fields(&json!({"name": "a", "card_identity_emoji": "x"}));
        assert_eq!(with["name"], json!("a"));
        assert_eq!(with["card_identity_emoji"], json!("x"));
    }
}
