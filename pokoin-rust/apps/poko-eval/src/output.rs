use serde::Serialize;
use serde_json::Value as Json;

#[derive(Debug, Clone, Serialize)]
pub struct EvalCard {
    #[serde(rename = "cardId", skip_serializing_if = "String::is_empty")]
    pub card_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(rename = "setName", skip_serializing_if = "String::is_empty")]
    pub set_name: String,
    #[serde(rename = "cardNumber", skip_serializing_if = "String::is_empty")]
    pub card_number: String,
    #[serde(rename = "pricePkn", skip_serializing_if = "Option::is_none")]
    pub price_pkn: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunRecord {
    pub id: String,
    pub kind: String,
    pub lang: String,
    pub system: String,
    pub provider: String,
    pub model: String,
    pub ms: u64,
    pub llm_calls: u32,
    pub tools: Vec<String>,
    pub reply: String,
    pub cards: Vec<EvalCard>,
    pub blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn cards_from_json(values: &[Json]) -> Vec<EvalCard> {
    values.iter().filter_map(card_from_json).collect()
}

fn card_from_json(value: &Json) -> Option<EvalCard> {
    let object = value.as_object()?;
    let card_id = text_field(object, &["cardId", "id"]);
    let name = text_field(object, &["name", "cardName"]);
    let set_name = text_field(object, &["setName", "set"]);
    let card_number = text_field(object, &["cardNumber", "number"]);
    let price_pkn = price_field(object);
    if card_id.is_empty() && name.is_empty() {
        return None;
    }
    Some(EvalCard {
        card_id,
        name,
        set_name,
        card_number,
        price_pkn,
    })
}

fn text_field(object: &serde_json::Map<String, Json>, keys: &[&str]) -> String {
    for key in keys {
        if let Some(Json::String(text)) = object.get(*key) {
            let text = text.trim();
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn price_field(object: &serde_json::Map<String, Json>) -> Option<u64> {
    for key in ["pricePkn", "price_pkn", "price"] {
        if let Some(value) = object.get(key) {
            if let Some(number) = value.as_u64() {
                return Some(number);
            }
            if let Some(text) = value.as_str() {
                if let Ok(parsed) = text.trim().parse::<u64>() {
                    return Some(parsed);
                }
            }
        }
    }
    None
}
