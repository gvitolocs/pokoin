//! Reply cards taken from tool JSON, in the shape `clean_cards` already returns.
//!
//! Only entries listed on the reply's `[[cards: ...]]` line are kept (see
//! `extract_reply_card_mentions`). `attach_reply_cards` still runs in the chat
//! handler and strips that line.

use std::collections::HashSet;

use serde_json::{json, Map, Value as Json};

use crate::domain::poko_chat::{clean_cards, extract_reply_card_mentions, ReplyCardMentions};

const DEFAULT_REPLY_CARD_CAP: usize = 3;
const PRINTING_CHOICE_REPLY_CARD_CAP: usize = 4;

pub(crate) fn from_results(results: &[Json], reply: &str) -> Vec<Json> {
    let mentions = extract_reply_card_mentions(reply);
    if !mentions.tagged {
        return Vec::new();
    }
    let cap = reply_card_cap(reply, &mentions);

    let mut raw: Vec<Json> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for result in results {
        collect(result, &mut raw, &mut seen);
    }
    let cleaned = clean_cards(Some(&Json::Array(raw.clone())));
    let mut pool: Vec<Json> = Vec::new();
    for card in cleaned {
        pool.push(enrich_card_number(card, &raw));
    }

    let mut out: Vec<Json> = Vec::new();
    let mut attached_ids: HashSet<String> = HashSet::new();

    for id in &mentions.ids {
        if out.len() >= cap {
            break;
        }
        if !is_card_id(id) || attached_ids.contains(id) {
            continue;
        }
        let card = pool
            .iter()
            .find(|card| text_field(card, &["cardId", "id"]) == *id)
            .cloned()
            .unwrap_or_else(|| stub_card_id(id));
        attached_ids.insert(id.clone());
        out.push(card);
    }

    for name in &mentions.names {
        if out.len() >= cap {
            break;
        }
        let matches: Vec<&Json> = pool
            .iter()
            .filter(|card| name_matches(card, name))
            .collect();
        if matches.is_empty() {
            continue;
        }
        let hinted: Vec<&Json> = matches
            .iter()
            .filter(|card| reply_mentions_printing(reply, card))
            .copied()
            .collect();
        let chosen = if !hinted.is_empty() {
            hinted[0]
        } else {
            matches[0]
        };
        let id = text_field(chosen, &["cardId", "id"]);
        if id.is_empty() || attached_ids.contains(&id) {
            continue;
        }
        attached_ids.insert(id);
        out.push(chosen.clone());
    }

    out
}

fn reply_card_cap(reply: &str, mentions: &ReplyCardMentions) -> usize {
    if reply.contains('?') && mentions.ids.len() >= 2 {
        PRINTING_CHOICE_REPLY_CARD_CAP
    } else {
        DEFAULT_REPLY_CARD_CAP
    }
}

fn enrich_card_number(card: Json, raw: &[Json]) -> Json {
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
    card
}

fn stub_card_id(id: &str) -> Json {
    json!({
        "kind": "card",
        "cardId": id,
        "name": "",
        "cardName": "",
        "setName": "",
        "cardNumber": "",
        "path": "",
        "canonicalPath": Json::Null,
        "imageUrl": "",
        "pricePkn": 0,
    })
}

fn name_matches(card: &Json, name: &str) -> bool {
    let card_name = text_field(card, &["name", "cardName"]);
    !card_name.is_empty() && card_name.eq_ignore_ascii_case(name)
}

fn reply_mentions_printing(reply: &str, card: &Json) -> bool {
    let haystack = reply.to_ascii_lowercase();
    let set_name = text_field(card, &["setName", "set"]).to_ascii_lowercase();
    let number = text_field(card, &["cardNumber", "number"]).to_ascii_lowercase();
    (!set_name.is_empty() && haystack.contains(&set_name))
        || (!number.is_empty() && haystack.contains(&number))
}

fn is_card_id(value: &str) -> bool {
    (3..=12).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
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

    fn mimikyu_results() -> Vec<Json> {
        vec![json!({
            "ok": true,
            "candidates": [
                {"cardId": "101", "name": "Mimikyu", "setName": "Team Rocket's Mimikyu", "cardNumber": "1/100"},
                {"cardId": "102", "name": "Mimikyu", "setName": "Chinese GX Set", "cardNumber": "50/100"},
                {"cardId": "103", "name": "Mimikyu", "setName": "SV9a", "cardNumber": "123/165"},
                {"cardId": "104", "name": "Mimikyu", "setName": "Japanese Promo", "cardNumber": "10/20"},
                {"cardId": "105", "name": "Mimikyu", "setName": "Lost Origin", "cardNumber": "96/196"},
            ]
        })]
    }

    #[test]
    fn no_marker_line_attaches_no_cards() {
        let cards = from_results(
            &mimikyu_results(),
            "Mimikyu prices have been volatile lately across several printings.",
        );
        assert!(cards.is_empty());
    }

    #[test]
    fn marker_card_id_selects_one_printing() {
        let cards = from_results(
            &mimikyu_results(),
            "The Japanese printing looks steadier.\n\n[[cards: 103]]",
        );
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["cardId"], json!("103"));
        assert_eq!(cards[0]["setName"], json!("SV9a"));
    }

    #[test]
    fn marker_name_with_set_hint_picks_that_printing() {
        let cards = from_results(
            &mimikyu_results(),
            "SV9a 123 has calmer sold comps.\n\n[[cards: Mimikyu]]",
        );
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["cardId"], json!("103"));
    }

    #[test]
    fn marker_name_without_hint_keeps_first_match() {
        let cards = from_results(
            &mimikyu_results(),
            "Hard to pick one printing.\n\n[[cards: Mimikyu]]",
        );
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["cardId"], json!("101"));
    }

    #[test]
    fn six_ids_in_marker_are_capped_at_three() {
        let results = vec![json!({
            "cards": [
                {"cardId": "100001", "name": "A", "setName": "S1", "cardNumber": "1/1"},
                {"cardId": "100002", "name": "B", "setName": "S2", "cardNumber": "2/2"},
                {"cardId": "100003", "name": "C", "setName": "S3", "cardNumber": "3/3"},
                {"cardId": "100004", "name": "D", "setName": "S4", "cardNumber": "4/4"},
                {"cardId": "100005", "name": "E", "setName": "S5", "cardNumber": "5/5"},
                {"cardId": "100006", "name": "F", "setName": "S6", "cardNumber": "6/6"},
            ]
        })];
        let cards = from_results(
            &results,
            "Several options.\n\n[[cards: 100001 | 100002 | 100003 | 100004 | 100005 | 100006]]",
        );
        assert_eq!(cards.len(), 3);
        assert_eq!(cards[0]["cardId"], json!("100001"));
        assert_eq!(cards[1]["cardId"], json!("100002"));
        assert_eq!(cards[2]["cardId"], json!("100003"));
    }

    #[test]
    fn printing_question_with_two_ids_caps_at_four() {
        let results = vec![json!({
            "cards": [
                {"cardId": "200001", "name": "A", "setName": "S1", "cardNumber": "1/1"},
                {"cardId": "200002", "name": "B", "setName": "S2", "cardNumber": "2/2"},
                {"cardId": "200003", "name": "C", "setName": "S3", "cardNumber": "3/3"},
                {"cardId": "200004", "name": "D", "setName": "S4", "cardNumber": "4/4"},
                {"cardId": "200005", "name": "E", "setName": "S5", "cardNumber": "5/5"},
            ]
        })];
        let cards = from_results(
            &results,
            "Which printing do you mean?\n\n[[cards: 200001 | 200002 | 200003 | 200004 | 200005]]",
        );
        assert_eq!(cards.len(), 4);
    }

    #[test]
    fn marker_id_not_in_tools_is_kept_for_resolution() {
        let cards = from_results(&mimikyu_results(), "Check this one.\n\n[[cards: 999888]]");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["cardId"], json!("999888"));
    }

    #[test]
    fn cards_follow_marker_and_drop_duplicates() {
        let results = vec![json!({
            "ok": true,
            "candidates": [
                {"cardId": "300002", "name": "Eevee", "setName": "Jungle", "cardNumber": "11/64", "pricePkn": 40},
                {"cardId": "300002", "name": "Eevee", "setName": "Jungle", "cardNumber": "11/64"},
                {"cardId": "300001", "name": "Pikachu", "setName": "Base", "cardNumber": "58/102", "imageUrl": "https://cdn.example/p.jpg", "price": 12}
            ]
        })];
        let cards = from_results(
            &results,
            "Look at Pikachu first, then Eevee.\n\n[[cards: 300001 | 300002 | 300001]]",
        );
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0]["cardId"], json!("300001"));
        assert_eq!(cards[0]["name"], json!("Pikachu"));
        assert_eq!(cards[0]["cardNumber"], json!("58/102"));
        assert_eq!(cards[0]["kind"], json!("card"));
        assert_eq!(cards[0]["pricePkn"], json!(12));
        assert_eq!(cards[1]["cardId"], json!("300002"));
    }
}
