//! Port of `_marketplace_home_recent.js` — apply recentCardIds onto a cached
//! home snapshot without busting the 30s cache.

use serde_json::{Map, Value};

use super::{js, react_card};

/// `mergeRecentIntoHome(snapshot, recentIds, extraCards)`.
pub fn merge_recent_into_home(
    snapshot: &Value,
    recent_ids: &[String],
    extra_cards: &[Value],
) -> Value {
    let mut cards: Vec<Value> = snapshot
        .get("cards")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut by_id: Map<String, Value> = Map::new();
    for card in &cards {
        by_id.insert(js::string_or_empty(js::get(card, "id")), card.clone());
    }
    for card in extra_cards {
        let id = js::string_or_empty(js::get(card, "id"));
        if !id.is_empty() && !by_id.contains_key(&id) {
            by_id.insert(id, card.clone());
            cards.push(card.clone());
        }
    }
    let known: std::collections::HashSet<String> = by_id.keys().cloned().collect();
    let recent: Vec<String> = recent_ids
        .iter()
        .filter(|id| known.contains(*id))
        .cloned()
        .collect();
    let previous: Vec<String> = snapshot
        .get("sections")
        .and_then(|sections| sections.get("recentlySeenIds"))
        .and_then(Value::as_array)
        .map(|ids| ids.iter().map(|v| js::string_or_empty(Some(v))).collect())
        .unwrap_or_default();
    let mut merged: Vec<String> = recent.clone();
    for id in &previous {
        if !recent.contains(id) {
            merged.push(id.clone());
        }
    }
    merged.truncate(12);

    let mut sections: Map<String, Value> = snapshot
        .get("sections")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    sections.insert(
        "recentlySeenIds".into(),
        Value::Array(merged.iter().cloned().map(Value::String).collect()),
    );
    sections.insert(
        "spotlightIds".into(),
        Value::Array(merged.iter().cloned().map(Value::String).collect()),
    );

    let mut out = snapshot.as_object().cloned().unwrap_or_default();
    out.insert("cards".into(), Value::Array(cards));
    out.insert("sections".into(), Value::Object(sections));
    Value::Object(out)
}

/// `recentIdsFromUrl(url)` — `parseIdList(recentCardIds || recent, 24)`.
pub fn recent_ids_from_url(query: &pokoin_api_common::http::Query) -> Vec<String> {
    let raw = query
        .search_param("recentCardIds")
        .filter(|v| !v.is_empty())
        .or_else(|| query.search_param("recent").filter(|v| !v.is_empty()));
    react_card::parse_id_list(raw.unwrap_or(""), 24)
}

/// `mergeHomeDisplayCards(newestCards, availableCards, limit = 140)`.
pub fn merge_home_display_cards(
    newest_cards: &[Value],
    available_cards: &[Value],
    limit: usize,
) -> Vec<Value> {
    let mut by_id: Map<String, Value> = Map::new();
    for card in newest_cards {
        let id = js::string_or_empty(js::get(card, "id"));
        if !id.is_empty() {
            by_id.insert(id, card.clone());
        }
    }
    for card in available_cards {
        let id = js::string_or_empty(js::get(card, "id"));
        if !id.is_empty() {
            by_id.insert(id, card.clone());
        }
    }
    by_id.values().cloned().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> Value {
        json!({
            "cards": [{"id": "1"}, {"id": "2"}],
            "sections": {"newArrivalIds": ["1", "2"], "recentlySeenIds": ["9", "1"]},
        })
    }

    #[test]
    fn recent_ids_merge_ahead_of_previous() {
        let merged = merge_recent_into_home(
            &snapshot(),
            &["2".to_string(), "99".to_string(), "1".to_string()],
            &[],
        );
        let cards = merged["cards"].as_array().unwrap();
        assert_eq!(cards.len(), 2);
        let sections = merged["sections"].as_object().unwrap();
        assert_eq!(sections["recentlySeenIds"], json!(["2", "1", "9"]));
        assert_eq!(sections["spotlightIds"], json!(["2", "1", "9"]));
        // Other sections survive untouched.
        assert_eq!(sections["newArrivalIds"], json!(["1", "2"]));
    }

    #[test]
    fn extra_cards_extend_but_never_duplicate() {
        let merged = merge_recent_into_home(
            &snapshot(),
            &["3".to_string()],
            &[json!({"id": "3"}), json!({"id": "1"})],
        );
        let cards = merged["cards"].as_array().unwrap();
        assert_eq!(cards.len(), 3);
        assert_eq!(cards[2]["id"], json!("3"));
        // recent = known recentIds; previous entries not in recent follow.
        assert_eq!(
            merged["sections"]["recentlySeenIds"],
            json!(["3", "9", "1"])
        );
    }

    #[test]
    fn recent_list_caps_at_twelve() {
        // Only ids present in the snapshot survive the merge.
        let mut snapshot = snapshot();
        snapshot["cards"] = json!((1..=20)
            .map(|n| json!({"id": n.to_string()}))
            .collect::<Vec<_>>());
        let ids: Vec<String> = (1..=20).map(|n| n.to_string()).collect();
        let merged = merge_recent_into_home(&snapshot, &ids, &[]);
        let recent = merged["sections"]["recentlySeenIds"].as_array().unwrap();
        assert_eq!(recent.len(), 12);
        assert_eq!(recent[0], json!("1"));
    }

    #[test]
    fn recent_ids_read_both_aliases() {
        use pokoin_api_common::http::Query;
        assert_eq!(
            recent_ids_from_url(&Query::parse("recentCardIds=1,2")),
            vec!["1", "2"]
        );
        assert_eq!(recent_ids_from_url(&Query::parse("recent=3")), vec!["3"]);
        assert_eq!(
            recent_ids_from_url(&Query::parse("recentCardIds=&recent=3,3,4")),
            vec!["3", "4"]
        );
        assert!(recent_ids_from_url(&Query::parse("")).is_empty());
    }

    #[test]
    fn display_cards_merge_newest_first() {
        let merged = merge_home_display_cards(
            &[json!({"id": "1"}), json!({"id": "2"})],
            &[json!({"id": "2"}), json!({"id": "3"})],
            140,
        );
        let ids: Vec<&str> = merged.iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["1", "2", "3"]);
        assert_eq!(merge_home_display_cards(&[], &[], 1).len(), 0);
    }
}
