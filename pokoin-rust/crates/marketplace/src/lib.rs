use pokoin_cache::card_page_key;
use serde_json::{json, Value};

pub fn card_cache_key(game: &str, card_id: &str, lang: &str) -> String {
    card_page_key(game, card_id, lang, false, false, false, false, 40, 40, "")
}

pub fn empty_card_page(card_id: &str, lang: &str) -> Value {
    json!({
        "card": { "id": card_id },
        "lookup": { "cardId": card_id, "lang": lang },
    })
}
