//! Port of `_marketplace_canonical_path.js`.

use serde_json::Value;

use super::{js, slug};

/// `cleanCardId(value)` — a positive safe integer, else 0.
pub fn clean_card_id(value: Option<&Value>) -> i64 {
    let text = js::string_or_empty(value);
    let n = js::number(Some(&Value::String(text.trim().to_string())));
    if js::is_safe_integer(n) && n > 0.0 {
        n as i64
    } else {
        0
    }
}

/// `publicCardIdForRow(row)` — the doubled public card id of a leftover row.
pub fn public_card_id_for_row(row: &Value) -> i64 {
    let card_id = clean_card_id(js::get(row, "card_id").or_else(|| js::get(row, "id")));
    let ct_id = clean_card_id(js::get(row, "ct_id").or_else(|| js::get(row, "ctId")));
    if ct_id > 0 {
        return ct_id * 2;
    }
    if card_id == 0 {
        return 0;
    }
    if card_id % 2 == 1 {
        card_id * 2
    } else {
        card_id
    }
}

/// `cleanCollectorNumber(value, cardId)` — drops `#` prefixes and a bare
/// copy of the card id.
pub fn clean_collector_number(value: Option<&Value>, card_id: i64) -> String {
    // `/^#+\s*/` strips every leading `#` plus following whitespace.
    let text = js::string_or_empty(value);
    let text = text.trim().trim_start_matches('#');
    let text = text.trim_start();
    if text.is_empty() || text == card_id.to_string() {
        return String::new();
    }
    text.to_string()
}

/// `canonicalSlugForRow(row)`.
pub fn canonical_slug_for_row(row: &Value) -> String {
    let rarity = js::string_or_empty(js::get(row, "rarity"))
        .trim()
        .to_string();
    let parts = [
        if rarity.is_empty() {
            "Card".to_string()
        } else {
            rarity
        },
        js::string_or_empty(
            js::get(row, "display_name")
                .or_else(|| js::get(row, "canonical_name"))
                .or_else(|| js::get(row, "name")),
        ),
        {
            let card_id = clean_card_id(js::get(row, "card_id"));
            clean_collector_number(js::get(row, "card_number"), card_id)
        },
        js::string_or_empty(js::get(row, "set_name")),
    ];
    parts
        .iter()
        .map(|part| slug::slug_part(part))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// `canonicalPathForRow(row)` — the stored path when it is a card desk, else
/// the public `/marketplace/en/cards/<id>/<slug>`.
pub fn canonical_path_for_row(row: &Value) -> String {
    let stored_path = js::clean_text(
        js::get(row, "canonical_path").or_else(|| js::get(row, "canonicalPath")),
        800,
    );
    if stored_path.starts_with("/marketplace/") && stored_path.contains("/cards/") {
        return stored_path;
    }
    let clean_id = public_card_id_for_row(row);
    let slug = canonical_slug_for_row(row);
    if clean_id > 0 && !slug.is_empty() {
        format!("/marketplace/en/cards/{clean_id}/{slug}")
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn public_ids_double_leftover_ids() {
        assert_eq!(public_card_id_for_row(&json!({"ct_id": 334063})), 668126);
        assert_eq!(public_card_id_for_row(&json!({"card_id": 668126})), 668126);
        assert_eq!(public_card_id_for_row(&json!({"card_id": 668125})), 1336250);
        assert_eq!(public_card_id_for_row(&json!({})), 0);
        assert_eq!(clean_card_id(Some(&json!("668126"))), 668126);
        assert_eq!(clean_card_id(Some(&json!("12.5"))), 0);
        assert_eq!(clean_card_id(Some(&json!("-3"))), 0);
        assert_eq!(clean_card_id(None), 0);
    }

    #[test]
    fn collector_numbers_drop_hashes_and_self_ids() {
        assert_eq!(clean_collector_number(Some(&json!("## 4/102")), 9), "4/102");
        assert_eq!(clean_collector_number(Some(&json!("668126")), 668126), "");
        assert_eq!(clean_collector_number(Some(&json!("")), 1), "");
        assert_eq!(clean_collector_number(None, 1), "");
    }

    #[test]
    fn paths_fall_back_to_the_public_shape() {
        let row = json!({
            "card_id": 668126,
            "ct_id": 334063,
            "rarity": "Card",
            "name": "Levincia",
            "card_number": "Gold Secret Rare | 244/182",
            "set_name": "Destined Rivals",
        });
        assert_eq!(
            canonical_path_for_row(&row),
            "/marketplace/en/cards/668126/card-levincia-gold-secret-rare-244-182-destined-rivals"
        );
        let stored = json!({
            "card_id": 668126,
            "canonical_path": "/marketplace/en/cards/668126/card-x",
        });
        assert_eq!(
            canonical_path_for_row(&stored),
            "/marketplace/en/cards/668126/card-x"
        );
        let non_card = json!({"canonical_path": "/marketplace/en/sets/x", "card_id": 5});
        // Odd card id doubles to 10; only the rarity contributes to the slug.
        assert_eq!(
            canonical_path_for_row(&non_card),
            "/marketplace/en/cards/10/card"
        );
        assert_eq!(canonical_path_for_row(&json!({})), "");
    }
}
