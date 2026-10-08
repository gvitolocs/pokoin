//! Stock CSV import/export mappers — native port of `_stock_csv.js`.
//! Pure helpers (no DB/Firebase). Spec: pokoin-web docs/STOCK_CSV.md.

use serde_json::{json, Map, Value};

use crate::error::{clean_text, ApiError, ApiResult};

pub const POWERTOOLS_HEADERS: [&str; 22] = [
    "cardmarketId", "quantity", "name", "set", "setCode", "cn", "condition", "language",
    "isFirstEd", "isReverseHolo", "isSigned", "finishType", "price", "comment", "location",
    "nameDE", "nameES", "nameFR", "nameIT", "rarity", "listedAt", "countryEdition",
];
pub const CARDMARKET_HEADERS: [&str; 15] = [
    "idProduct", "quantity", "name", "expansion", "number", "language", "condition",
    "isFoil", "isReverseHolo", "isSigned", "isFirstEd", "isAltered", "price", "comment",
    "location",
];
pub const CARDTRADER_HEADERS: [&str; 17] = [
    "blueprint_id", "product_id", "quantity", "price_cents", "currency", "name", "expansion",
    "number", "condition", "language", "foil", "reverse", "first_edition", "signed", "altered",
    "comment", "location",
];
pub const TCGPLAYER_HEADERS: [&str; 18] = [
    "TCGplayer Id", "Product Line", "Set Name", "Product Name", "Number", "Rarity",
    "Condition", "TCG Market Price", "TCG Direct Low", "TCG Low Price With Shipping",
    "TCG Low Price", "Total Quantity", "Add to Quantity", "TCG Marketplace Price",
    "Photo URL", "Language", "Printing", "Location",
];
pub const FORMATS: [&str; 4] = ["powertools", "cardmarket", "cardtrader", "tcgplayer"];

/// 1 EUR = 200 PKN (same ratio as the CardTrader inventory sync).
pub const EUR_TO_PKN: f64 = 200.0;

pub fn stock_clean_text(value: &str, max: usize) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| if (ch as u32) < 0x20 || ch as u32 == 0x7f { ' ' } else { ch })
        .collect();
    clean_text(Some(&cleaned), max)
}

pub fn clamp_int(value: Option<f64>, min: i64, max: i64, fallback: i64) -> i64 {
    match value {
        Some(number) if number.is_finite() => (number.trunc() as i64).clamp(min, max),
        _ => fallback,
    }
}

pub fn truthy_flag(value: &str) -> bool {
    matches!(value.trim().to_lowercase().as_str(), "true" | "1" | "yes" | "y" | "x")
}

fn map_lookup<'a>(pairs: &'a [(&'a str, &'a str)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| *value)
}

pub const CONDITION_FROM_CM: [(&str, &str); 19] = [
    ("mt", "NM"), ("mint", "NM"), ("nm", "NM"), ("near mint", "NM"),
    ("ex", "SP"), ("excellent", "SP"), ("sp", "SP"), ("slightly played", "SP"),
    ("gd", "MP"), ("good", "MP"), ("mp", "MP"), ("moderately played", "MP"),
    ("lp", "MP"), ("lightly played", "MP"),
    ("pl", "PL"), ("played", "PL"), ("hp", "PL"), ("heavily played", "PL"),
    ("po", "Poor"),
];
pub const CONDITION_TO_CM: [(&str, &str); 12] = [
    ("NM", "NM"), ("SP", "EX"), ("MP", "GD"), ("PL", "PL"), ("Poor", "PO"),
    ("LP", "LP"), ("HP", "PL"), ("EX", "EX"), ("GD", "GD"), ("PO", "PO"),
    ("poor", "PO"), ("Mint", "NM"),
];
pub const CONDITION_FROM_CT: [(&str, &str); 16] = [
    ("mint", "NM"), ("near mint", "NM"), ("nm", "NM"),
    ("slightly played", "SP"), ("sp", "SP"),
    ("moderately played", "MP"), ("mp", "MP"),
    ("lightly played", "MP"), ("lp", "MP"),
    ("played", "PL"), ("heavily played", "PL"), ("hp", "PL"), ("pl", "PL"),
    ("poor", "Poor"), ("po", "Poor"), ("damaged", "Poor"),
];
pub const CONDITION_TO_CT: [(&str, &str); 7] = [
    ("NM", "Near Mint"), ("SP", "Slightly Played"), ("MP", "Moderately Played"),
    ("PL", "Heavily Played"), ("Poor", "Poor"), ("LP", "Lightly Played"), ("HP", "Heavily Played"),
];
pub const LANG_FROM_NAME: [(&str, &str); 36] = [
    ("english", "EN"), ("en", "EN"), ("italian", "IT"), ("it", "IT"), ("german", "DE"), ("de", "DE"),
    ("french", "FR"), ("fr", "FR"), ("spanish", "ES"), ("es", "ES"), ("portuguese", "PT"), ("pt", "PT"),
    ("japanese", "JP"), ("jp", "JP"), ("ja", "JP"), ("korean", "KO"), ("ko", "KO"), ("kr", "KO"),
    ("chinese", "ZH"), ("zh", "ZH"), ("chinese (trad.)", "ZHT"), ("chinese traditional", "ZHT"), ("zht", "ZHT"),
    ("dutch", "NL"), ("nl", "NL"), ("polish", "PL"), ("pl", "PL"), ("russian", "RU"), ("ru", "RU"),
    ("indonesian", "ID"), ("id", "ID"), ("thai", "TH"), ("th", "TH"), ("vietnamese", "VI"), ("vi", "VI"),
    ("", "EN"),
];
pub const LANG_TO_NAME: [(&str, &str); 16] = [
    ("EN", "English"), ("IT", "Italian"), ("DE", "German"), ("FR", "French"), ("ES", "Spanish"),
    ("PT", "Portuguese"), ("JP", "Japanese"), ("KO", "Korean"), ("ZH", "Chinese"), ("ZHT", "Chinese (Trad.)"),
    ("NL", "Dutch"), ("PL", "Polish"), ("RU", "Russian"), ("ID", "Indonesian"), ("TH", "Thai"), ("VI", "Vietnamese"),
];

pub fn map_condition_from_cm(raw: &str) -> String {
    let key = stock_clean_text(raw, 40).to_lowercase();
    map_lookup(&CONDITION_FROM_CM, &key).unwrap_or("NM").to_string()
}

pub fn map_condition_to_cm(pokoin: &str) -> String {
    let key = stock_clean_text(pokoin, 20);
    map_lookup(&CONDITION_TO_CM, &key).unwrap_or("NM").to_string()
}

pub fn map_condition_from_ct(raw: &str) -> String {
    let key = stock_clean_text(raw, 40).to_lowercase();
    map_lookup(&CONDITION_FROM_CT, &key)
        .map(|value| value.to_string())
        .unwrap_or_else(|| map_condition_from_cm(raw))
}

pub fn map_condition_to_ct(pokoin: &str) -> String {
    let key = stock_clean_text(pokoin, 20);
    map_lookup(&CONDITION_TO_CT, &key).unwrap_or("Near Mint").to_string()
}

pub fn map_language_from_name(raw: &str) -> String {
    let key = stock_clean_text(raw, 40).to_lowercase();
    let upper = key.to_uppercase();
    if upper.len() >= 2 && upper.len() <= 3 && upper.chars().all(|c| c.is_ascii_alphabetic()) {
        if map_lookup(&LANG_TO_NAME, &upper).is_some() {
            return upper;
        }
    }
    map_lookup(&LANG_FROM_NAME, &key).unwrap_or("EN").to_string()
}

pub fn map_language_to_name(code: &str) -> String {
    let key = stock_clean_text(code, 10).to_uppercase();
    map_lookup(&LANG_TO_NAME, &key).unwrap_or("English").to_string()
}

/// `mapFinishFromPowerTools`.
pub fn map_finish_from_power_tools(finish_type: &str, is_reverse_holo: &str) -> Value {
    let finish = stock_clean_text(finish_type, 40);
    let reverse_flag = truthy_flag(is_reverse_holo) || finish.to_lowercase().contains("reverse");
    let lower = finish.to_lowercase();
    let mut foil_state = "standard";
    let mut variant_state = "";
    if lower.contains("masterball") || lower.contains("master ball") {
        foil_state = if reverse_flag { "reverse" } else { "holo" };
        variant_state = "masterball";
    } else if lower.contains("pokeball") || lower.contains("pokéball") || lower.contains("poke ball") || lower.contains("poké ball") {
        foil_state = if reverse_flag { "reverse" } else { "holo" };
        variant_state = "pokeball";
    } else if lower.contains("cosmos") {
        foil_state = "holo";
        variant_state = "cosmos";
    } else if lower.contains("icecrack") || lower.contains("ice crack") {
        foil_state = "holo";
        variant_state = "icecracked";
    } else if lower.contains("stamp") {
        foil_state = "stamped";
    } else if lower.contains("promo") {
        foil_state = "promo";
    } else if reverse_flag || lower == "reverseholo" {
        foil_state = "reverse";
    } else if lower.contains("holo") && !lower.contains("reverse") {
        foil_state = "holo";
    }
    json!({
        "foilState": foil_state,
        "reverse": foil_state == "reverse" || reverse_flag,
        "variantState": variant_state,
    })
}

/// `mapFinishToPowerTools`.
pub fn map_finish_to_power_tools(foil_state: &str, reverse: bool, variant_state: &str) -> Value {
    let variant = stock_clean_text(variant_state, 40).to_lowercase();
    let foil = stock_clean_text(foil_state, 40).to_lowercase();
    let is_reverse = reverse || foil == "reverse";
    let (finish_type, is_reverse_holo) = match variant.as_str() {
        "masterball" => (if is_reverse { "ReverseMasterballHolo" } else { "MasterballHolo" }, is_reverse),
        "pokeball" => (if is_reverse { "ReversePokeballHolo" } else { "PokeballHolo" }, is_reverse),
        "cosmos" => ("CosmosHolo", false),
        "icecracked" => ("IceCrackedHolo", false),
        _ => {
            if foil == "stamped" {
                ("StampedHolo", false)
            } else if foil == "promo" {
                ("Promo", false)
            } else if is_reverse || foil == "reverse" {
                ("ReverseHolo", true)
            } else if foil == "holo" {
                ("Holo", false)
            } else {
                ("Regular", false)
            }
        }
    };
    json!({ "finishType": finish_type, "isReverseHolo": is_reverse_holo })
}

/// `parseLocation`.
pub fn parse_location(raw: &str) -> Value {
    let text = stock_clean_text(raw, 120);
    if text.is_empty() {
        return json!({"box": "", "stack": 1, "position": 1, "structured": false, "hasPosition": false});
    }
    // box·stack[·pos]
    if let Some(index) = text.find(['·', '•']) {
        let head = &text[..index];
        let tail = &text[index + 1..];
        let parts: Vec<&str> = tail.split(['·', '•']).collect();
        if !parts.is_empty() && parts[0].chars().all(|c| c.is_ascii_digit()) && !parts[0].is_empty() {
            return json!({
                "box": stock_clean_text(head, 64),
                "stack": clamp_int(parts[0].parse::<f64>().ok(), 1, 9999, 1),
                "position": clamp_int(parts.get(1).and_then(|p| p.parse::<f64>().ok()), 1, 9999, 1),
                "structured": true,
                "hasPosition": parts.len() > 1,
            });
        }
    }
    // dash form: "box - 2 - 5" is ambiguous; treat as bare box (reference behavior)
    let dash = split_numeric_tail(&text, &[' ', '_', '-']);
    if let Some((box, stack)) = dash {
        if box.chars().any(|c| c.is_ascii_alphabetic()) && text.matches('-').count() == 1 {
            return json!({"box": stock_clean_text(&box, 64), "stack": clamp_int(Some(stack as f64), 1, 9999, 1), "position": 1, "structured": true, "hasPosition": false});
        }
    }
    // trailing "#N"
    if let Some(index) = text.rfind('#') {
        let head = &text[..index];
        let tail = text[index + 1..].trim();
        if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
            return json!({
                "box": stock_clean_text(head, 64),
                "stack": clamp_int(tail.parse::<f64>().ok(), 1, 9999, 1),
                "position": 1,
                "structured": true,
                "hasPosition": false,
            });
        }
    }
    json!({"box": text, "stack": 1, "position": 1, "structured": false, "hasPosition": false})
}

fn split_numeric_tail(text: &str, seps: &[char]) -> Option<(String, i64)> {
    let index = text.rfind(|c| seps.contains(&c))?;
    let tail = text[index + 1..].trim();
    if tail.is_empty() || !tail.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let head = text[..index].trim_end_matches(seps).to_string();
    if head.is_empty() {
        return None;
    }
    tail.parse::<i64>().ok().map(|stack| (head, stack))
}

/// `parsePowerToolsLocation`.
pub fn parse_power_tools_location(raw: &str, location_parse: &str) -> Value {
    let text = stock_clean_text(raw, 120);
    if text.is_empty() {
        return json!({"box": "", "stack": 1, "position": 1, "structured": false, "hasPosition": false});
    }
    let mode = if location_parse.trim().is_empty() { "as_is" } else { location_parse.trim() };
    if mode == "structured" || text.contains('·') || text.contains('•') {
        return parse_location(&text);
    }
    if mode == "trailing_stack" {
        if let Some((box, stack)) = split_numeric_tail_owned(&text, " - ") {
            return json!({"box": stock_clean_text(&box, 64), "stack": stack, "position": 1, "structured": true, "hasPosition": false});
        }
        if let Some((box, stack)) = split_numeric_tail(&text, &[' ', '_']) {
            if box.chars().any(|c| c.is_ascii_alphabetic()) {
                return json!({"box": stock_clean_text(&box, 64), "stack": stack, "position": 1, "structured": true, "hasPosition": false});
            }
        }
    }
    json!({"box": text, "stack": 1, "position": 1, "structured": false, "hasPosition": false})
}

fn split_numeric_tail_owned(text: &str, sep: &str) -> Option<(String, i64)> {
    let index = text.rfind(sep)?;
    let tail = text[index + sep.len()..].trim();
    if tail.is_empty() || !tail.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let head = text[..index].trim().to_string();
    if head.is_empty() {
        return None;
    }
    tail.parse::<i64>().ok().map(|stack| (head, stack))
}

/// `detectPowerToolsLocationStyle`.
pub fn detect_power_tools_location_style(locations: &[String]) -> Value {
    let mut examples: Vec<String> = Vec::new();
    let (mut structured, mut trailing, mut as_is) = (0i64, 0i64, 0i64);
    for raw in locations {
        let text = stock_clean_text(raw, 120);
        if text.is_empty() {
            continue;
        }
        if examples.len() < 6 && !examples.contains(&text) {
            examples.push(text.clone());
        }
        if text.contains('·') || text.contains('•') || text.contains('#') {
            structured += 1;
            continue;
        }
        let has_digit_suffix = text.rfind(' ').map(|i| text[i + 1..].chars().all(|c| c.is_ascii_digit())).unwrap_or(false);
        if (text.contains(" - ") && has_digit_suffix) || has_digit_suffix {
            trailing += 1;
            continue;
        }
        as_is += 1;
    }
    let total = structured + trailing + as_is;
    let mut location_parse = "as_is";
    if total > 0 {
        if structured >= trailing && structured >= as_is && structured > 0 {
            location_parse = "structured";
        } else if trailing > as_is {
            location_parse = "trailing_stack";
        }
    }
    json!({
        "locationParse": location_parse,
        "locationExamples": examples,
        "counts": {"structured": structured, "trailing": trailing, "asIs": as_is, "total": total},
    })
}

/// `formatListingLocation`.
pub fn format_listing_location(
    box_name: &str,
    stack: i64,
    position: i64,
    stack_size: i64,
    numbered_in_stack: bool,
    include_stack: bool,
) -> String {
    let loc = stock_clean_text(box_name, 64);
    if loc.is_empty() {
        return String::new();
    }
    let size = stack_size.max(1);
    let s = stack.max(1);
    let p = position.max(1);
    if !numbered_in_stack {
        if include_stack || s > 1 {
            return format!("{loc}·{s}");
        }
        return loc;
    }
    if size == 1 {
        return format!("{loc}·{s}");
    }
    format!("{loc}·{s}·{p}")
}

/// `assignStackPositions`.
pub fn assign_stack_positions(rows: &[Value], stack_size: i64) -> Vec<Value> {
    use std::collections::HashMap;
    let size = stack_size.max(1);
    let mut counters: HashMap<String, i64> = HashMap::new();
    rows.iter()
        .map(|row| {
            let raw_location = row.get("location").and_then(Value::as_str).unwrap_or_default();
            let parsed = parse_location(raw_location);
            let had_structured = raw_location.contains('·') || raw_location.contains('•');
            let mut stack = parsed.get("stack").and_then(Value::as_i64).unwrap_or(1);
            let mut position = parsed.get("position").and_then(Value::as_i64).unwrap_or(1);
            let box_name = {
                let parsed_box = parsed.get("box").and_then(Value::as_str).unwrap_or_default();
                if parsed_box.is_empty() {
                    let fallback = stock_clean_text(raw_location, 64);
                    if fallback.is_empty() { "box".to_string() } else { fallback }
                } else {
                    parsed_box.to_string()
                }
            };
            if !had_structured || size == 1 {
                let next_abs = counters.get(&box_name).copied().unwrap_or(0) + 1;
                counters.insert(box_name.clone(), next_abs);
                if size == 1 {
                    stack = next_abs;
                    position = 1;
                } else {
                    stack = (next_abs - 1) / size + 1;
                    position = (next_abs - 1) % size + 1;
                }
            } else {
                let abs = (stack - 1) * size + position.min(size);
                let entry = counters.entry(box_name.clone()).or_insert(0);
                *entry = (*entry).max(abs);
            }
            let mut out = row.clone();
            out["box"] = json!(box_name);
            out["stack"] = json!(stack);
            out["position"] = json!(position);
            out["stackSize"] = json!(size);
            out["location"] = json!(format_listing_location(&box_name, stack, position, size, true, true));
            out
        })
        .collect()
}

/// `priceToPkn`.
pub fn price_to_pkn(raw: &str, price_mode: &str, currency: &str) -> Option<f64> {
    let parsed = raw.replace(',', ".");
    let number = parsed.trim().parse::<f64>().ok()?;
    if !number.is_finite() || number <= 0.0 {
        return None;
    }
    match price_mode {
        "as_pkn" => Some(number),
        "cents_eur_to_pkn" => Some((number / 100.0) * EUR_TO_PKN),
        _ => {
            let currency = stock_clean_text(currency, 8).to_uppercase();
            if currency == "PKN" {
                Some(number)
            } else {
                Some(number * EUR_TO_PKN)
            }
        }
    }
}

pub fn pkn_to_eur(pkn: Option<f64>) -> String {
    let Some(pkn) = pkn else { return String::new() };
    if !pkn.is_finite() || pkn <= 0.0 {
        return String::new();
    }
    let eur = ((pkn / EUR_TO_PKN) * 100.0).round() / 100.0;
    format_trimmed(eur)
}

pub fn pkn_to_cents(pkn: Option<f64>) -> String {
    let eur = pkn_to_eur(pkn);
    let Ok(eur) = eur.parse::<f64>() else { return String::new() };
    if !eur.is_finite() || eur <= 0.0 {
        return String::new();
    }
    format!("{}", (eur * 100.0).round() as i64)
}

fn format_trimmed(value: f64) -> String {
    let text = format!("{value}");
    text
}

/// `parseCsv` — RFC4180-ish: commas, quotes, CRLF.
pub fn parse_csv(text: &str) -> (Vec<String>, Vec<Map<String, Value>>) {
    let src = text.trim_start_matches('\u{feff}');
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = src.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if in_quotes {
            if ch == '"' {
                if chars.get(index + 1) == Some(&'"') {
                    cell.push('"');
                    index += 2;
                    continue;
                }
                in_quotes = false;
                index += 1;
                continue;
            }
            cell.push(ch);
            index += 1;
            continue;
        }
        if ch == '"' {
            in_quotes = true;
            index += 1;
            continue;
        }
        if ch == ',' {
            row.push(std::mem::take(&mut cell));
            index += 1;
            continue;
        }
        if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.get(index + 1) == Some(&'\n') {
                index += 1;
            }
            row.push(std::mem::take(&mut cell));
            if row.iter().any(|cell| !cell.is_empty()) {
                rows.push(std::mem::take(&mut row));
            } else {
                row.clear();
            }
            index += 1;
            continue;
        }
        cell.push(ch);
        index += 1;
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        if row.iter().any(|cell| !cell.is_empty()) {
            rows.push(row);
        }
    }
    if rows.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let headers: Vec<String> = rows[0].iter().map(|h| stock_clean_text(h, 80)).collect();
    let records = rows[1..]
        .iter()
        .map(|cols| {
            let mut object = Map::new();
            for (idx, header) in headers.iter().enumerate() {
                object.insert(
                    header.clone(),
                    json!(cols.get(idx).cloned().unwrap_or_default()),
                );
            }
            object
        })
        .collect();
    (headers, records)
}

pub fn escape_csv_cell(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

pub fn to_csv(headers: &[String], rows: &[Value]) -> String {
    let mut lines = vec![headers
        .iter()
        .map(|header| escape_csv_cell(header))
        .collect::<Vec<_>>()
        .join(",")];
    for row in rows {
        lines.push(
            headers
                .iter()
                .map(|header| escape_csv_cell(value_to_csv_cell(row.get(header))))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    format!("{}\n", lines.join("\n"))
}

fn value_to_csv_cell(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(other) => other.to_string(),
    }
}

pub fn header_key(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '_')
        .collect()
}

/// `field(raw, names...)`.
pub fn field(raw: &Value, names: &[&str]) -> String {
    let Some(map) = raw.as_object() else {
        return String::new();
    };
    for name in names {
        if let Some(value) = map.get(*name) {
            let text = value_to_csv_cell(Some(value));
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    let wanted: Vec<String> = names.iter().map(|name| header_key(name)).collect();
    for (key, value) in map {
        if wanted.contains(&header_key(key)) {
            let text = value_to_csv_cell(Some(value));
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    String::new()
}

/// `detectFormat`.
pub fn detect_format(headers: &[String]) -> Option<&'static str> {
    let set: Vec<String> = headers.iter().map(|header| header_key(header)).collect();
    let has = |key: &str| set.iter().any(|entry| entry == key);
    if has("cardmarketid") && (has("finishtype") || has("setcode")) {
        return Some("powertools");
    }
    if has("blueprintid") || has("pricecents") {
        return Some("cardtrader");
    }
    if has("idproduct") || (has("expansion") && has("isfoil")) {
        return Some("cardmarket");
    }
    if has("tcgplayerid")
        || (has("productname")
            && has("setname")
            && (has("tcgmarketplaceprice") || has("totalquantity") || has("tcgmarketprice")))
    {
        return Some("tcgplayer");
    }
    if has("cardmarketid") {
        return Some("powertools");
    }
    None
}

/// `normalizeImportRow`.
pub fn normalize_import_row(format: &str, raw: &Value, price_mode: &str) -> ApiResult<Value> {
    match format {
        "powertools" => {
            let finish = map_finish_from_power_tools(
                &field(raw, &["finishType"]),
                &field(raw, &["isReverseHolo"]),
            );
            Ok(json!({
                "format": format,
                "externalId": stock_clean_text(&field(raw, &["cardmarketId"]), 40),
                "cardmarketId": stock_clean_text(&field(raw, &["cardmarketId"]), 40),
                "quantity": clamp_int(field(raw, &["quantity"]).parse::<f64>().ok(), 1, 99, 1),
                "name": stock_clean_text(&field(raw, &["name"]), 240),
                "setName": stock_clean_text(&field(raw, &["set"]), 240),
                "setCode": stock_clean_text(&field(raw, &["setCode"]), 40),
                "collectorNumber": stock_clean_text(&field(raw, &["cn"]), 40),
                "condition": map_condition_from_cm(&field(raw, &["condition"])),
                "language": map_language_from_name(&field(raw, &["language"])),
                "firstEdition": truthy_flag(&field(raw, &["isFirstEd"])),
                "signed": truthy_flag(&field(raw, &["isSigned"])),
                "altered": false,
                "foilState": finish["foilState"],
                "reverse": finish["reverse"],
                "variantState": finish["variantState"],
                "pricePkn": price_to_pkn(&field(raw, &["price"]), price_mode, "EUR"),
                "sellerComment": stock_clean_text(&field(raw, &["comment"]), 500),
                "location": stock_clean_text(&field(raw, &["location"]), 120),
                "rarity": stock_clean_text(&field(raw, &["rarity"]), 80),
            }))
        }
        "cardmarket" => {
            let reverse = truthy_flag(&field(raw, &["isReverseHolo"]));
            let foil = truthy_flag(&field(raw, &["isFoil"]));
            Ok(json!({
                "format": format,
                "externalId": stock_clean_text(&field(raw, &["idProduct"]), 40),
                "cardmarketId": stock_clean_text(&field(raw, &["idProduct"]), 40),
                "quantity": clamp_int(field(raw, &["quantity"]).parse::<f64>().ok(), 1, 99, 1),
                "name": stock_clean_text(&field(raw, &["name"]), 240),
                "setName": stock_clean_text(&field(raw, &["expansion"]), 240),
                "setCode": "",
                "collectorNumber": stock_clean_text(&field(raw, &["number"]), 40),
                "condition": map_condition_from_cm(&field(raw, &["condition"])),
                "language": map_language_from_name(&field(raw, &["language"])),
                "firstEdition": truthy_flag(&field(raw, &["isFirstEd"])),
                "signed": truthy_flag(&field(raw, &["isSigned"])),
                "altered": truthy_flag(&field(raw, &["isAltered"])),
                "foilState": if reverse { "reverse" } else if foil { "holo" } else { "standard" },
                "reverse": reverse,
                "variantState": "",
                "pricePkn": price_to_pkn(&field(raw, &["price"]), price_mode, "EUR"),
                "sellerComment": stock_clean_text(&field(raw, &["comment"]), 500),
                "location": stock_clean_text(&field(raw, &["location"]), 120),
                "rarity": "",
            }))
        }
        "cardtrader" => {
            let reverse = truthy_flag(&field(raw, &["reverse"]))
                || field(raw, &["foil"]).to_lowercase() == "reverse";
            let price_cents = field(raw, &["price_cents"]);
            let price_pkn = if !price_cents.is_empty() {
                price_to_pkn(&price_cents, "cents_eur_to_pkn", "EUR")
            } else {
                price_to_pkn(&field(raw, &["price"]), price_mode, &field(raw, &["currency"]))
            };
            let foil = field(raw, &["foil"]).to_lowercase();
            Ok(json!({
                "format": format,
                "externalId": stock_clean_text(&if field(raw, &["product_id"]).is_empty() { field(raw, &["blueprint_id"]) } else { field(raw, &["product_id"]) }, 40),
                "blueprintId": stock_clean_text(&field(raw, &["blueprint_id"]), 40),
                "productId": stock_clean_text(&field(raw, &["product_id"]), 40),
                "quantity": clamp_int(field(raw, &["quantity"]).parse::<f64>().ok(), 1, 99, 1),
                "name": stock_clean_text(&field(raw, &["name"]), 240),
                "setName": stock_clean_text(&field(raw, &["expansion"]), 240),
                "setCode": "",
                "collectorNumber": stock_clean_text(&field(raw, &["number"]), 40),
                "condition": map_condition_from_ct(&field(raw, &["condition"])),
                "language": map_language_from_name(&field(raw, &["language"])),
                "firstEdition": truthy_flag(&field(raw, &["first_edition"])),
                "signed": truthy_flag(&field(raw, &["signed"])),
                "altered": truthy_flag(&field(raw, &["altered"])),
                "foilState": if reverse { "reverse" } else if foil == "holo" { "holo" } else { "standard" },
                "reverse": reverse,
                "variantState": "",
                "pricePkn": price_pkn,
                "sellerComment": stock_clean_text(&field(raw, &["comment"]), 500),
                "location": stock_clean_text(&field(raw, &["location"]), 120),
                "rarity": "",
            }))
        }
        "tcgplayer" => {
            let printing = field(raw, &["Printing"]).to_lowercase();
            let reverse = printing.contains("reverse");
            let foil = printing.contains("holo") || printing.contains("foil");
            let price = field(raw, &["TCG Marketplace Price", "TCG Market Price", "price"]);
            let language = field(raw, &["Language"]);
            Ok(json!({
                "format": format,
                "externalId": stock_clean_text(&field(raw, &["TCGplayer Id"]), 40),
                "tcgplayerId": stock_clean_text(&field(raw, &["TCGplayer Id"]), 40),
                "quantity": clamp_int(field(raw, &["Total Quantity", "Quantity", "Add to Quantity"]).parse::<f64>().ok(), 1, 99, 1),
                "name": stock_clean_text(&field(raw, &["Product Name", "Title", "Name"]), 240),
                "setName": stock_clean_text(&field(raw, &["Set Name", "Set"]), 240),
                "setCode": "",
                "collectorNumber": stock_clean_text(&field(raw, &["Number"]), 40),
                "condition": map_condition_from_ct(&field(raw, &["Condition"])),
                "language": map_language_from_name(if language.is_empty() { "English" } else { &language }),
                "firstEdition": printing.contains("1st") || printing.contains("first"),
                "signed": false,
                "altered": false,
                "foilState": if reverse { "reverse" } else if foil { "holo" } else { "standard" },
                "reverse": reverse,
                "variantState": "",
                "pricePkn": price_to_pkn(&price, price_mode, "EUR"),
                "sellerComment": "",
                "location": stock_clean_text(&field(raw, &["Location"]), 120),
                "rarity": stock_clean_text(&field(raw, &["Rarity"]), 80),
            }))
        }
        other => Err(ApiError::bad_request(format!("Unknown format: {other}"))),
    }
}

/// `listingToExportRow`.
pub fn listing_to_export_row(format: &str, listing: &Value) -> ApiResult<Value> {
    let location = stock_clean_text(listing.get("location").and_then(Value::as_str).unwrap_or_default(), 120);
    let qty = clamp_int(
        listing
            .get("quantityAvailable")
            .or_else(|| listing.get("quantity"))
            .and_then(Value::as_f64),
        1,
        99,
        1,
    );
    let text = |key: &str| stock_clean_text(listing.get(key).and_then(Value::as_str).unwrap_or_default(), 240);
    let name = {
        let value = listing.get("cardName").or_else(|| listing.get("name")).and_then(Value::as_str).unwrap_or_default();
        stock_clean_text(value, 240)
    };
    match format {
        "powertools" => {
            let finish = map_finish_to_power_tools(
                listing.get("foilState").and_then(Value::as_str).unwrap_or("standard"),
                listing.get("reverse") == Some(&Value::Bool(true)),
                listing.get("variantState").and_then(Value::as_str).unwrap_or(""),
            );
            let cn = stock_clean_text(listing.get("collectorNumber").and_then(Value::as_str).unwrap_or_default(), 40);
            let cn = cn.split('/').next().unwrap_or("").to_string();
            Ok(json!({
                "cardmarketId": text("cardmarketId"),
                "quantity": qty.to_string(),
                "name": name,
                "set": text("setName"),
                "setCode": text("setCode"),
                "cn": cn,
                "condition": map_condition_to_cm(listing.get("condition").and_then(Value::as_str).unwrap_or("NM")),
                "language": map_language_to_name(listing.get("language").and_then(Value::as_str).unwrap_or("EN")),
                "isFirstEd": if listing.get("firstEdition") == Some(&Value::Bool(true)) { "true" } else { "" },
                "isReverseHolo": if finish["isReverseHolo"] == json!(true) { "true" } else { "" },
                "isSigned": if listing.get("signed") == Some(&Value::Bool(true)) { "true" } else { "" },
                "finishType": finish["finishType"],
                "price": pkn_to_eur(listing.get("pricePkn").and_then(Value::as_f64)),
                "comment": stock_clean_text(listing.get("sellerComment").and_then(Value::as_str).unwrap_or_default(), 500),
                "location": location,
                "nameDE": "", "nameES": "", "nameFR": "", "nameIT": "", "rarity": "", "listedAt": "", "countryEdition": "",
            }))
        }
        "cardmarket" => Ok(json!({
            "idProduct": text("cardmarketId"),
            "quantity": qty.to_string(),
            "name": name,
            "expansion": text("setName"),
            "number": text("collectorNumber"),
            "language": map_language_to_name(listing.get("language").and_then(Value::as_str).unwrap_or("EN")),
            "condition": map_condition_to_cm(listing.get("condition").and_then(Value::as_str).unwrap_or("NM")),
            "isFoil": if matches!(listing.get("foilState").and_then(Value::as_str), Some("holo") | Some("reverse")) { "true" } else { "" },
            "isReverseHolo": if listing.get("reverse") == Some(&Value::Bool(true)) || listing.get("foilState").and_then(Value::as_str) == Some("reverse") { "true" } else { "" },
            "isSigned": if listing.get("signed") == Some(&Value::Bool(true)) { "true" } else { "" },
            "isFirstEd": if listing.get("firstEdition") == Some(&Value::Bool(true)) { "true" } else { "" },
            "isAltered": if listing.get("altered") == Some(&Value::Bool(true)) { "true" } else { "" },
            "price": pkn_to_eur(listing.get("pricePkn").and_then(Value::as_f64)),
            "comment": stock_clean_text(listing.get("sellerComment").and_then(Value::as_str).unwrap_or_default(), 500),
            "location": location,
        })),
        "cardtrader" => {
            let foil_state = listing.get("foilState").and_then(Value::as_str).unwrap_or("standard");
            Ok(json!({
                "blueprint_id": text("blueprintId"),
                "product_id": text("productId"),
                "quantity": qty.to_string(),
                "price_cents": pkn_to_cents(listing.get("pricePkn").and_then(Value::as_f64)),
                "currency": "EUR",
                "name": name,
                "expansion": text("setName"),
                "number": text("collectorNumber"),
                "condition": map_condition_to_ct(listing.get("condition").and_then(Value::as_str).unwrap_or("NM")),
                "language": stock_clean_text(listing.get("language").and_then(Value::as_str).unwrap_or("en"), 10).to_lowercase(),
                "foil": if foil_state == "holo" { "holo" } else if foil_state == "reverse" || listing.get("reverse") == Some(&Value::Bool(true)) { "reverse" } else { "" },
                "reverse": if listing.get("reverse") == Some(&Value::Bool(true)) || foil_state == "reverse" { "true" } else { "" },
                "first_edition": if listing.get("firstEdition") == Some(&Value::Bool(true)) { "true" } else { "" },
                "signed": if listing.get("signed") == Some(&Value::Bool(true)) { "true" } else { "" },
                "altered": if listing.get("altered") == Some(&Value::Bool(true)) { "true" } else { "" },
                "comment": stock_clean_text(listing.get("sellerComment").and_then(Value::as_str).unwrap_or_default(), 500),
                "location": location,
            }))
        }
        "tcgplayer" => {
            let finish = map_finish_to_power_tools(
                listing.get("foilState").and_then(Value::as_str).unwrap_or("standard"),
                listing.get("reverse") == Some(&Value::Bool(true)),
                "",
            );
            let printing = if finish["isReverseHolo"] == json!(true) {
                "Reverse Holofoil"
            } else if finish["finishType"] == json!("Holo") {
                "Holofoil"
            } else {
                "Normal"
            };
            Ok(json!({
                "TCGplayer Id": text("tcgplayerId"),
                "Product Line": "Pokemon",
                "Set Name": text("setName"),
                "Product Name": name,
                "Number": text("collectorNumber"),
                "Rarity": "",
                "Condition": map_condition_to_ct(listing.get("condition").and_then(Value::as_str).unwrap_or("NM")),
                "TCG Market Price": "",
                "TCG Direct Low": "",
                "TCG Low Price With Shipping": "",
                "TCG Low Price": "",
                "Total Quantity": qty.to_string(),
                "Add to Quantity": "",
                "TCG Marketplace Price": pkn_to_eur(listing.get("pricePkn").and_then(Value::as_f64)),
                "Photo URL": "",
                "Language": map_language_to_name(listing.get("language").and_then(Value::as_str).unwrap_or("EN")),
                "Printing": printing,
                "Location": location,
            }))
        }
        other => Err(ApiError::bad_request(format!("Unknown format: {other}"))),
    }
}

pub fn headers_for(format: &str) -> ApiResult<Vec<String>> {
    let headers: &[&str] = match format {
        "powertools" => &POWERTOOLS_HEADERS,
        "cardmarket" => &CARDMARKET_HEADERS,
        "cardtrader" => &CARDTRADER_HEADERS,
        "tcgplayer" => &TCGPLAYER_HEADERS,
        other => return Err(ApiError::bad_request(format!("Unknown format: {other}"))),
    };
    Ok(headers.iter().map(|header| header.to_string()).collect())
}

pub fn export_listings_csv(format: &str, listings: &[Value]) -> ApiResult<String> {
    let headers = headers_for(format)?;
    let rows: Vec<Value> = listings
        .iter()
        .map(|listing| listing_to_export_row(format, listing))
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(to_csv(&headers, &rows))
}

/// `importCsvText` (default branch: `assignStackPositions`).
pub fn import_csv_text(
    text: &str,
    format: Option<&str>,
    stack_size: i64,
    price_mode: &str,
) -> ApiResult<Value> {
    let (headers, records) = parse_csv(text);
    let format = match format {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => detect_format(&headers).map(|value| value.to_string()).unwrap_or_default(),
    };
    if !FORMATS.contains(&format.as_str()) {
        return Err(ApiError::bad_request(
            "Unrecognized CSV format. Use powertools, cardmarket, cardtrader, or tcgplayer.",
        ));
    }
    let mut results: Vec<Value> = Vec::new();
    let mut ok_rows: Vec<(usize, Value)> = Vec::new();
    for (index, raw) in records.iter().enumerate() {
        let raw_value = Value::Object(raw.clone());
        match normalize_import_row(&format, &raw_value, price_mode) {
            Ok(row) => {
                ok_rows.push((index, row.clone()));
                results.push(json!({"ok": true, "index": index + 2, "row": row, "raw": raw_value}));
            }
            Err(error) => {
                results.push(json!({"ok": false, "index": index + 2, "error": error.message, "raw": raw_value}));
            }
        }
    }
    let rows_for_slots: Vec<Value> = ok_rows.iter().map(|(_, row)| row.clone()).collect();
    let with_slots = assign_stack_positions(&rows_for_slots, stack_size);
    let mut slot_index = 0usize;
    let results: Vec<Value> = results
        .into_iter()
        .map(|entry| {
            if entry.get("ok") == Some(&Value::Bool(true)) {
                let row = with_slots.get(slot_index).cloned().unwrap_or(Value::Null);
                slot_index += 1;
                let mut updated = entry;
                updated["row"] = row;
                updated
            } else {
                entry
            }
        })
        .collect();
    Ok(json!({
        "format": format,
        "headers": headers,
        "results": results,
        "overflows": [],
        "occupancy": [],
        "suggestedStackSize": 1,
        "locationDetection": Value::Null,
    }))
}

pub fn source_for_format(format: &str) -> &'static str {
    match format {
        "powertools" => "powertools_csv_import",
        "cardmarket" => "cardmarket_csv_import",
        "cardtrader" => "cardtrader_csv_import",
        "tcgplayer" => "tcgplayer_csv_import",
        _ => "stock_csv_import",
    }
}

pub fn source_listing_id_for(format: &str, row: &Value) -> String {
    let id = stock_clean_text(
        &{
            let candidate = row
                .get("externalId")
                .or_else(|| row.get("cardmarketId"))
                .or_else(|| row.get("productId"))
                .or_else(|| row.get("blueprintId"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            candidate.to_string()
        },
        80,
    );
    if id.is_empty() {
        return String::new();
    }
    let prefix = match format {
        "powertools" => "pt",
        "cardmarket" => "cm",
        "tcgplayer" => "tp",
        _ => "ct",
    };
    let condition = row.get("condition").and_then(Value::as_str).unwrap_or("");
    let language = row.get("language").and_then(Value::as_str).unwrap_or("");
    let foil = row.get("foilState").and_then(Value::as_str).unwrap_or("");
    let location = row.get("location").and_then(Value::as_str).unwrap_or("");
    format!("{prefix}:{id}:{condition}:{language}:{foil}:{location}")
        .chars()
        .take(160)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_round_trip_and_detect() {
        let text = "cardmarketId,quantity,name,set,setCode,cn,condition,language,isFirstEd,isReverseHolo,isSigned,finishType,price,comment,location\r\n1,2,\"Charizard, Base\",Base Set,BS,4/102,NM,English,,,,\"Holo\",10.5,,\"box·2\"\r\n";
        let (headers, records) = parse_csv(text);
        assert_eq!(headers[0], "cardmarketId");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["name"], "Charizard, Base");
        assert_eq!(detect_format(&headers), Some("powertools"));
        let out = to_csv(&["a", "b"], &[json!({"a": "x,y", "b": "z"})]);
        assert_eq!(out, "a,b\n\"x,y\",z\n");
    }

    #[test]
    fn import_normalizes_each_format() {
        let pt = import_csv_text(
            "cardmarketId,quantity,name,set,setCode,cn,condition,language,isFirstEd,isReverseHolo,isSigned,finishType,price,comment,location\n1,2,Pikachu,Base,BS,58/102,EX,Italian,,true,,ReverseHolo,10,,box\n",
            Some("powertools"),
            1,
            "eur_to_pkn",
        )
        .unwrap();
        assert_eq!(pt["format"], "powertools");
        let row = &pt["results"][0]["row"];
        assert_eq!(row["condition"], "SP");
        assert_eq!(row["language"], "IT");
        assert_eq!(row["pricePkn"], 2000.0);
        assert_eq!(row["reverse"], true);
        assert_eq!(pt["results"][0]["index"], 2);

        let cm = import_csv_text(
            "idProduct,quantity,name,expansion,number,language,condition,isFoil,isReverseHolo,isSigned,isFirstEd,isAltered,price,comment,location\n7,1,Mew,Fossil,8/62,English,Near Mint,true,,,,5,,box·3\n",
            Some("cardmarket"),
            1,
            "eur_to_pkn",
        )
        .unwrap();
        assert_eq!(cm["results"][0]["row"]["foilState"], "holo");
        assert_eq!(cm["results"][0]["row"]["location"], "box·1");
    }

    #[test]
    fn locations_and_sources() {
        assert_eq!(parse_location("box·2·5")["stack"], 2);
        assert_eq!(parse_location("box·2·5")["position"], 5);
        assert_eq!(parse_location("box")["structured"], false);
        assert_eq!(parse_power_tools_location("FUOCOBOMBA 006 - 16", "trailing_stack")["stack"], 16);
        let style = detect_power_tools_location_style(&["box·2".to_string(), "box·3".to_string(), "loose".to_string()]);
        assert_eq!(style["locationParse"], "structured");
        let rows = vec![json!({"location": "box", "quantity": 1}), json!({"location": "box", "quantity": 1})];
        let assigned = assign_stack_positions(&rows, 1);
        assert_eq!(assigned[0]["location"], "box·1");
        assert_eq!(assigned[1]["location"], "box·2");
        assert_eq!(source_for_format("cardmarket"), "cardmarket_csv_import");
        let id = source_listing_id_for("cardtrader", &json!({"productId": "42", "condition": "NM", "language": "EN", "foilState": "standard", "location": "b"}));
        assert_eq!(id, "ct:42:NM:EN:standard:b");
    }

    #[test]
    fn export_shapes_match_headers() {
        let listing = json!({"cardName": "Pikachu", "setName": "Base", "collectorNumber": "58/102", "condition": "SP",
            "language": "IT", "pricePkn": 2000.0, "quantityAvailable": 2, "reverse": true, "foilState": "reverse",
            "location": "box·1", "sellerComment": "nice"});
        let csv = export_listings_csv("cardmarket", &[listing]).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], CARDMARKET_HEADERS.join(","));
        assert!(lines[1].contains("Pikachu"));
        assert!(lines[1].contains("10")); // 2000 PKN → 10 EUR
        let pt = listing_to_export_row("powertools", &listing).unwrap();
        assert_eq!(pt["condition"], "EX");
        assert_eq!(pt["price"], "10");
        assert_eq!(pt["cn"], "58");
    }
}
