//! Port of `_marketplace_rails.js` — Pi browse rails, home vector assembly
//! and theme-pack overlays.

use chrono::Timelike;
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use super::{js, react_card, react_sql};

pub const NEW_CARDS_LIMIT: i64 = 20;
pub const FEATURED_LIMIT: i64 = 30;

/// `HOME_RAILS` — `(rail id, section key, limit)`.
pub const HOME_RAILS: [(&str, &str, i64); 5] = [
    ("new_cards", "newArrivalIds", NEW_CARDS_LIMIT),
    ("featured", "featuredIds", FEATURED_LIMIT),
    ("best_sellers", "bestSellerIds", 12),
    ("spotlight", "spotlightIds", 16),
    ("top_sold", "topSoldIds", 24),
];

/// One `marketplace_rails` row.
#[derive(Debug, Clone)]
pub struct RailRow {
    pub id: String,
    pub cards: Option<Value>,
    pub meta: Option<Value>,
    /// JS `Date` (timestamptz).
    pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// `cardId(card)`.
pub fn card_id(card: &Value) -> String {
    js::string_chain(&[js::get(card, "id"), js::get(card, "card_id")])
}

/// `asCards(value)` — array items with an id.
pub fn as_cards(value: Option<&Value>) -> Vec<Value> {
    match value.and_then(Value::as_array) {
        Some(items) => items
            .iter()
            .filter(|card| !card.is_null() && !card_id(card).is_empty())
            .cloned()
            .collect(),
        None => Vec::new(),
    }
}

/// `publicizeCards(cards)` — `toReactCards` plus the sales-day extras, with
/// `ct_id`/`ctId` removed.
pub fn publicize_cards(cards: &[Value]) -> Vec<Value> {
    let source_cards = as_cards(Some(&Value::Array(cards.to_vec())));
    react_card::to_react_cards(&source_cards)
        .into_iter()
        .enumerate()
        .map(|(index, mut card)| {
            let source = source_cards.get(index).cloned().unwrap_or(Value::Null);
            if js::truthy(js::get(&source, "salesDay")) {
                let map = card
                    .as_object_mut()
                    .expect("to_react_card returns an object");
                map.insert(
                    "salesDay".into(),
                    Value::String(js::string_or_empty(js::get(&source, "salesDay"))),
                );
                let number_or_zero = |key: &str| {
                    let n = js::number(js::get(&source, key));
                    js::js_json_number(if n.is_finite() && n != 0.0 { n } else { 0.0 })
                };
                map.insert("dailySoldQty".into(), number_or_zero("dailySoldQty"));
                map.insert(
                    "dailySaleSamples".into(),
                    number_or_zero("dailySaleSamples"),
                );
                map.insert(
                    "dailyMedianPkn".into(),
                    optional_number(js::get(&source, "dailyMedianPkn")),
                );
                map.insert(
                    "dailyMinPkn".into(),
                    optional_number(js::get(&source, "dailyMinPkn")),
                );
                map.insert(
                    "dailyMaxPkn".into(),
                    optional_number(js::get(&source, "dailyMaxPkn")),
                );
            }
            if let Some(map) = card.as_object_mut() {
                map.remove("ct_id");
                map.remove("ctId");
            }
            card
        })
        .collect()
}

fn optional_number(value: Option<&Value>) -> Value {
    let n = js::number(value);
    if n.is_finite() {
        js::js_json_number(n)
    } else {
        Value::Null
    }
}

/// `readRails(ids)`.
pub async fn read_rails(pool: &PgPool, ids: &[String]) -> Result<Vec<RailRow>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(
        String,
        Option<Value>,
        Option<Value>,
        Option<chrono::DateTime<chrono::Utc>>,
    )> = sqlx::query_as(
        "
      select id, cards, meta, updated_at
      from public.marketplace_rails
      where id = any($1::text[])
    ",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, cards, meta, updated_at)| RailRow {
            id,
            cards,
            meta,
            updated_at,
        })
        .collect())
}

/// `readTiles(ids)` — tile payloads for card ids.
pub async fn read_tiles(pool: &PgPool, ids: &[String]) -> Result<Vec<Value>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, Option<Value>)> = sqlx::query_as(
        "
      select card_id, payload
      from public.marketplace_card_tiles
      where card_id = any($1::text[])
    ",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(_, payload)| payload.filter(|payload| !payload.is_null()))
        .collect())
}

/// `assembleHomeVector(rows, generatedAt)` — the rails-backed home snapshot.
pub fn assemble_home_vector(rows: &[RailRow], generated_at: &str) -> Value {
    let by_rail: std::collections::HashMap<String, &RailRow> =
        rows.iter().map(|row| (row.id.clone(), row)).collect();
    let mut by_id: Map<String, Value> = Map::new();
    let mut sections = Map::new();
    let mut pkn_usdt = 0.005;
    let mut updated_at = String::new();

    for (rail_id, section_key, limit) in HOME_RAILS {
        let row = by_rail.get(rail_id);
        let cards: Vec<Value> = match row {
            Some(row) => as_cards(row.cards.as_ref())
                .into_iter()
                .take(limit as usize)
                .collect(),
            None => Vec::new(),
        };
        for card in publicize_cards(&cards) {
            let id = card_id(&card);
            if id.is_empty() {
                continue;
            }
            by_id.insert(id, card);
        }
        sections.insert(
            section_key.to_string(),
            Value::Array(
                cards
                    .iter()
                    .map(card_id)
                    .filter(|id| !id.is_empty())
                    .map(Value::String)
                    .collect(),
            ),
        );
        if let Some(row) = row {
            let rate = js::number(row.meta.as_ref().and_then(|meta| js::get(meta, "pknUsdt")));
            if rate.is_finite() && rate > 0.0 {
                pkn_usdt = rate;
            }
            let stamp = row
                .updated_at
                .map(|at| node_date_string(&at))
                .unwrap_or_default();
            if !stamp.is_empty() && stamp > updated_at {
                updated_at = stamp;
            }
        }
    }

    json!({
        "source": "pi",
        "cacheTtl": 300,
        "generatedAt": generated_at,
        "updatedAt": updated_at,
        "pknUsdt": js::js_json_number(pkn_usdt),
        "cards": Value::Array(by_id.values().cloned().collect()),
        "sections": Value::Object(sections),
    })
}

/// `String(new Date(ms))` in the UTC runtime of the Node container, e.g.
/// `Thu Oct 08 2026 22:44:35 GMT+0000 (Coordinated Universal Time)`.
pub fn node_date_string(at: &chrono::DateTime<chrono::Utc>) -> String {
    use chrono::Datelike;
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    format!(
        "{} {} {:02} {:04} {:02}:{:02}:{:02} GMT+0000 (Coordinated Universal Time)",
        DAYS[at.weekday().num_days_from_sunday() as usize],
        MONTHS[at.month() as usize - 1],
        at.day(),
        at.year(),
        at.hour(),
        at.minute(),
        at.second(),
    )
}

/// `withThemePacks(cards)` — attach compact theme packs (`vt`) to public card
/// rows. Failures resolve to the unchanged rows — theme hints must never
/// break a summary response.
pub async fn with_theme_packs(pool: &PgPool, cards: &[Value]) -> Vec<Value> {
    if cards.is_empty() {
        return cards.to_vec();
    }
    let ids: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        cards
            .iter()
            .map(card_id)
            .filter(|id| {
                !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) && seen.insert(id.clone())
            })
            .collect()
    };
    let numeric: Vec<i64> = ids.iter().filter_map(|id| id.parse().ok()).collect();
    let packs = match react_sql::read_card_theme_packs(pool, &numeric).await {
        Ok(packs) => packs,
        Err(_) => return cards.to_vec(),
    };
    if packs.is_empty() {
        return cards.to_vec();
    }
    cards
        .iter()
        .map(|card| {
            let id = card_id(card);
            match packs.get(&id) {
                Some(vt) => js::spread_with(card, "vt", Value::String(vt.clone())),
                None => card.clone(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rail(id: &str, cards: Value, meta: Value) -> RailRow {
        RailRow {
            id: id.to_string(),
            cards: Some(cards),
            meta: Some(meta),
            updated_at: Some(
                chrono::DateTime::parse_from_rfc3339("2026-10-08T22:44:35.674387+00:00")
                    .unwrap()
                    .with_timezone(&chrono::Utc),
            ),
        }
    }

    #[test]
    fn card_ids_prefer_id() {
        assert_eq!(card_id(&json!({"id": "5", "card_id": "6"})), "5");
        assert_eq!(card_id(&json!({"card_id": "6"})), "6");
        assert_eq!(card_id(&json!({})), "");
    }

    #[test]
    fn as_cards_drops_idless_entries() {
        let cards = as_cards(Some(&json!([{"id": "1"}, {}, {"card_id": "2"}, "junk"])));
        assert_eq!(cards.len(), 2);
        assert_eq!(as_cards(None).len(), 0);
        assert_eq!(as_cards(Some(&json!("x"))).len(), 0);
    }

    #[test]
    fn publicize_keeps_sales_fields_and_drops_ct_ids() {
        let out = publicize_cards(&[json!({
            "id": "667996",
            "card_id": "667996",
            "ct_id": 333998,
            "name": "Team Rocket's Factory",
            "salesDay": "2026-10-07",
            "dailySoldQty": 18.0,
            "dailySaleSamples": 6.0,
            "dailyMedianPkn": 66.0,
            "dailyMinPkn": 62.0,
            "dailyMaxPkn": 152.0,
            "imageUrl": "https://cdn.pokoin.com/333998_team-rocket-s-factory.jpg",
        })]);
        let card = &out[0];
        assert_eq!(card["id"], json!("667996"));
        assert_eq!(card.get("ct_id"), None);
        assert_eq!(card.get("ctId"), None);
        assert_eq!(card["salesDay"], json!("2026-10-07"));
        assert_eq!(card["dailySoldQty"], json!(18));
        assert_eq!(card["dailySaleSamples"], json!(6));
        assert_eq!(card["dailyMedianPkn"], json!(66));
        assert_eq!(card["dailyMinPkn"], json!(62));
        assert_eq!(card["dailyMaxPkn"], json!(152));

        let plain = publicize_cards(&[json!({"id": "1"})]);
        assert!(plain[0].get("salesDay").is_none());
    }

    #[test]
    fn home_vector_assembles_sections_and_stamps() {
        let rows = vec![
            rail(
                "new_cards",
                json!([{"id": "1"}, {"id": "2"}]),
                json!({"pknUsdt": 0.005}),
            ),
            rail(
                "top_sold",
                json!([{"id": "9", "salesDay": "d", "dailySoldQty": 3}]),
                json!({}),
            ),
            rail("featured", json!([]), json!({})),
            rail("best_sellers", json!([]), json!({})),
            rail("spotlight", json!([]), json!({})),
        ];
        let vector = assemble_home_vector(&rows, "2026-10-08T00:00:00.000Z");
        assert_eq!(vector["source"], json!("pi"));
        assert_eq!(vector["cacheTtl"], json!(300));
        assert_eq!(vector["pknUsdt"], json!(0.005));
        assert_eq!(
            vector["updatedAt"],
            json!("Thu Oct 08 2026 22:44:35 GMT+0000 (Coordinated Universal Time)")
        );
        let sections = vector["sections"].as_object().unwrap();
        assert_eq!(sections["newArrivalIds"], json!(["1", "2"]));
        assert_eq!(sections["topSoldIds"], json!(["9"]));
        assert_eq!(sections["featuredIds"], json!([]));
        let cards = vector["cards"].as_array().unwrap();
        assert_eq!(cards.len(), 3);
        // Rail order: new_cards cards first.
        assert_eq!(cards[0]["id"], json!("1"));
    }

    #[test]
    fn home_vector_defaults_without_rows() {
        let vector = assemble_home_vector(&[], "x");
        assert_eq!(vector["pknUsdt"], json!(0.005));
        assert_eq!(vector["updatedAt"], json!(""));
        assert_eq!(vector["cards"], json!([]));
    }

    #[test]
    fn node_date_string_matches_v8_utc() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-10-08T22:44:35.674387+00:00")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(
            node_date_string(&at),
            "Thu Oct 08 2026 22:44:35 GMT+0000 (Coordinated Universal Time)"
        );
    }
}
