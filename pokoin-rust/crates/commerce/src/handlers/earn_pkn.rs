//! Earn PKN shard review normalization and email content from live earn-pkn.
use serde_json::{json, Value};
use crate::error::ApiError;

fn text(value: Option<&Value>, max: usize) -> String {
    let raw = match value {
        Some(Value::String(s)) => s.clone(), Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(true)) => "true".into(), _ => String::new(),
    };
    raw.replace('\r', "").trim().chars().take(max).collect()
}
fn pick<'a>(v: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| v.get(*name).filter(|x| !x.is_null()))
}
fn field(v: &Value, names: &[&str], max: usize) -> String { text(pick(v, names), max) }
fn number(value: &str) -> f64 { value.trim().parse().unwrap_or(f64::NAN) }
fn whole_positive(n: f64) -> bool { n.is_finite() && n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0 }

pub fn normalize(body: &Value) -> Result<Value, ApiError> {
    let email = field(body, &["email"], 320).to_lowercase();
    let mode = field(body, &["requestMode", "mode", "shardMode"], 40).to_lowercase();
    let mode = mode.split(|c: char| c.is_whitespace() || c == '_' || c == '-').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-");
    let request_mode = if ["deck", "deck-shard", "decklist"].contains(&mode.as_str()) { "deck" } else { "cards" };
    let count = field(body, &["numberOfCards", "cardCount"], 40);
    let count = if count.is_empty() { None } else { Some(number(&count)) };
    let card_list = field(body, &["cardList", "listOfCards", "cards"], 4000);
    let deck_list = field(body, &["deckList", "decklist", "deckShard"], 12000);
    let mut deck_cards = Vec::new();
    for (index, card) in pick(body, &["deckCards", "deckCardSelections"]).and_then(Value::as_array).into_iter().flatten().enumerate() {
        let quantity = number(&field(card, &["quantity"], 20));
        if !whole_positive(quantity) {
            return Err(ApiError::bad_request(format!("Deck card {} must include a valid quantity.", index + 1)));
        }
        let mut normalized = json!({"quantity": quantity as u64});
        for (name, max) in [("name",240),("setCode",40),("collectorNumber",40),("category",40),("version",240),("language",80),("condition",80),("rawLine",400)] {
            normalized[name] = json!(field(card, &[name], max));
        }
        normalized["selectedVersion"] = if let Some(selected) = card.get("selectedVersion").filter(|v| v.is_object()) {
            let mut row = json!({});
            for (name,max) in [("cardId",80),("name",240),("set",160),("number",80),("rarity",120),("canonicalPath",500),("imageUrl",500)] {
                row[name] = json!(field(selected, &[name], max));
            }
            row
        } else { Value::Null };
        if ["name","setCode","collectorNumber"].iter().any(|name| normalized[name].as_str().unwrap_or("").is_empty()) {
            return Err(ApiError::bad_request(format!("Deck card {} must include name, set code, and collector number.", index + 1)));
        }
        if ["version","language","condition"].iter().any(|name| normalized[name].as_str().unwrap_or("").is_empty()) {
            return Err(ApiError::bad_request(format!("Deck card {} must include version, language, and condition.", index + 1)));
        }
        deck_cards.push(normalized);
    }
    let valid_email = regex::Regex::new(r"^[^@\s]+@[^@\s]+\.[^@\s]+$").map(|re| re.is_match(&email)).unwrap_or(false);
    if !valid_email { return Err(ApiError::bad_request("Enter a valid email address.")); }
    if count.is_some_and(|n| !whole_positive(n)) { return Err(ApiError::bad_request("Enter the number of cards as a whole number.")); }
    if request_mode == "deck" && deck_cards.is_empty() {
        if deck_list.is_empty() { return Err(ApiError::bad_request("Import a decklist for deck shard review.")); }
        let lower = deck_list.to_lowercase();
        let quantity_line = regex::Regex::new(r"(?m)^\s*\d+\s+\S+").map(|re| re.is_match(&deck_list)).unwrap_or(false);
        if !(lower.contains("pokemon:") || lower.contains("pokémon:")) || !lower.contains("trainer:") || !lower.contains("energy:") || !quantity_line {
            return Err(ApiError::bad_request("Deck shard requests must include Pokemon, Trainer, and Energy sections."));
        }
    } else if request_mode == "cards" && card_list.is_empty() {
        return Err(ApiError::bad_request("Enter the card list for review."));
    }
    Ok(json!({
        "email":email,"requestMode":request_mode,"numberOfCards":count.map(|n| n as u64),
        "valueOfCards":field(body,&["valueOfCards","estimatedValue"],120), "cardList":card_list,"deckList":deck_list,
        "deckCards":deck_cards,"language":field(body,&["language"],240),"conditions":field(body,&["conditions","condition"],800)
    }))
}
pub fn email(submission: &Value, submitted_at: &str) -> (String,String,String) {
    let label = if submission["requestMode"] == "deck" { "Deck shard" } else { "Card shard" };
    let cards = submission["deckCards"].as_array().cloned().unwrap_or_default();
    let count = submission["numberOfCards"].as_u64().unwrap_or_else(|| cards.iter().filter_map(|c| c["quantity"].as_u64()).sum());
    let count_label = if count == 0 { "unspecified cards".into() } else { format!("{count} card{}", if count == 1 { "" } else { "s" }) };
    let subject = format!("{label} PKN request: {count_label}");
    let value = |key: &str| {
        let v = &submission[key];
        if v.is_null() || v.as_str() == Some("") { "-".into() } else { text(Some(v),12000) }
    };
    let deck_lines = cards.iter().map(|c| {
        let get = |key: &str| text(c.get(key),12000);
        let marketplace = if c["selectedVersion"]["cardId"].as_str().is_some_and(|s| !s.is_empty()) {
            let path = c["selectedVersion"]["canonicalPath"].as_str().unwrap_or("");
            format!("\n  Marketplace card: {}{}", c["selectedVersion"]["cardId"].as_str().unwrap_or(""), if path.is_empty() { String::new() } else { format!(" ({path})") })
        } else { String::new() };
        format!("{}x {} ({} {})\n  Category: {}\n  Version: {}{}\n  Language: {}\n  Condition: {}",get("quantity"),get("name"),get("setCode"),get("collectorNumber"), if get("category").is_empty() { "-".into() } else { get("category") },get("version"),marketplace,get("language"),get("condition"))
    }).collect::<Vec<_>>().join("\n\n");
    let text = format!("A collector submitted the PKN shard review form.\n\nEmail: {}\nRequest mode: {label}\nNumber of cards: {}\nEstimated value: {}\nLanguage: {}\nConditions: {}\n\nCard list:\n{}\n\nDecklist:\n{}\n\nImported deck cards:\n{}\n\nSubmitted at: {submitted_at}",value("email"),value("numberOfCards"),value("valueOfCards"),value("language"),value("conditions"),value("cardList"),value("deckList"),if deck_lines.is_empty() { "-" } else { &deck_lines });
    let escape = crate::domain::notify::escape_html;
    let mut html = include_str!("earn_pkn_email.html").to_string();
    for key in ["email","numberOfCards","valueOfCards","language","conditions","cardList","deckList"] {
        html = html.replace(&format!("@@{key}@@"), &escape(&value(key)));
    }
    html = html.replace("@@requestLabel@@", label).replace("@@submittedAt@@", &escape(submitted_at));
    let rows = if cards.is_empty() {
        "<tr><td colspan=\"7\" style=\"padding:8px;border-top:1px solid #e2e8f0\">-</td></tr>".to_string()
    } else {
        cards.iter().map(|card| {
            let field = |key: &str| escape(&self::text(Some(&card[key]), 12000));
            let selected = &card["selectedVersion"];
            let marketplace = if selected["cardId"].as_str().is_some_and(|v| !v.is_empty()) {
                format!("<br><span style=\"color:#64748b\">#{} {}</span>", escape(selected["cardId"].as_str().unwrap_or("")), escape(selected["canonicalPath"].as_str().unwrap_or("")))
            } else { String::new() };
            format!("\n        <tr>\n          <td style=\"padding:8px;border-top:1px solid #e2e8f0\">{}</td>\n          <td style=\"padding:8px;border-top:1px solid #e2e8f0\">{}</td>\n          <td style=\"padding:8px;border-top:1px solid #e2e8f0\">{}</td>\n          <td style=\"padding:8px;border-top:1px solid #e2e8f0\">{} {}</td>\n          <td style=\"padding:8px;border-top:1px solid #e2e8f0\">\n            {}\n            {}\n          </td>\n          <td style=\"padding:8px;border-top:1px solid #e2e8f0\">{}</td>\n          <td style=\"padding:8px;border-top:1px solid #e2e8f0\">{}</td>\n        </tr>\n      ",field("quantity"),field("name"),if card["category"]==""{"-".to_string()}else{field("category")},field("setCode"),field("collectorNumber"),field("version"),marketplace,field("language"),field("condition"))
        }).collect::<String>()
    };
    html = html.replace("@@deckCardRows@@", &rows);
    (subject,text,html)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn validates_the_live_form_without_a_name_requirement() {
        assert_eq!(normalize(&json!({})).unwrap_err().message,"Enter a valid email address.");
        assert_eq!(normalize(&json!({"email":"a@b.com"})).unwrap_err().message,"Enter the card list for review.");
        let v=normalize(&json!({"email":" A@B.com\r ","listOfCards":"Pikachu","cardCount":"2"})).unwrap();
        assert_eq!(v["email"],"a@b.com"); assert_eq!(v["numberOfCards"],2);
        assert_eq!(email(&v,"2026-10-09T00:00:00.000Z").0,"Card shard PKN request: 2 cards");
    }
    #[test] fn deck_validation_precedes_email_like_node() {
        assert_eq!(normalize(&json!({"deckCards":[{}]})).unwrap_err().message,"Deck card 1 must include a valid quantity.");
        assert_eq!(normalize(&json!({"email":"a@b.com","mode":"deck_shard"})).unwrap_err().message,"Import a decklist for deck shard review.");
        assert!(normalize(&json!({"email":"a@b.com","mode":"deck","decklist":"Pokémon:\n1 Pikachu\nTrainer:\nEnergy:"})).is_ok());
        assert_eq!(normalize(&json!({"email":"a@b.com","cardList":"x","numberOfCards":1.5})).unwrap_err().message,"Enter the number of cards as a whole number.");
    }
}
