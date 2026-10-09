//! Stock CSV import/export mappers, ported from `_stock_csv.js`.
//!
//! Covers PowerTools, Cardmarket, CardTrader and TCGPlayer stock files: format
//! detection, condition/language/finish mapping, location/stack assignment and
//! the export row shape. Pure helpers — no DB.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::domain::{js_number, truthy_flag};

pub const POWERTOOLS_HEADERS: [&str; 22] = [
    "cardmarketId", "quantity", "name", "set", "setCode", "cn", "condition", "language", "isFirstEd",
    "isReverseHolo", "isSigned", "finishType", "price", "comment", "location", "nameDE", "nameES",
    "nameFR", "nameIT", "rarity", "listedAt", "countryEdition",
];

pub const CARDMARKET_HEADERS: [&str; 15] = [
    "idProduct", "quantity", "name", "expansion", "number", "language", "condition", "isFoil",
    "isReverseHolo", "isSigned", "isFirstEd", "isAltered", "price", "comment", "location",
];

pub const CARDTRADER_HEADERS: [&str; 17] = [
    "blueprint_id", "product_id", "quantity", "price_cents", "currency", "name", "expansion",
    "number", "condition", "language", "foil", "reverse", "first_edition", "signed", "altered",
    "comment", "location",
];

pub const TCGPLAYER_HEADERS: [&str; 18] = [
    "TCGplayer Id", "Product Line", "Set Name", "Product Name", "Number", "Rarity", "Condition",
    "TCG Market Price", "TCG Direct Low", "TCG Low Price With Shipping", "TCG Low Price",
    "Total Quantity", "Add to Quantity", "TCG Marketplace Price", "Photo URL", "Language",
    "Printing", "Location",
];

pub const FORMATS: [&str; 4] = ["powertools", "cardmarket", "cardtrader", "tcgplayer"];

/// 1 EUR = 200 PKN (same ratio as CardTrader inventory sync tests).
pub const EUR_TO_PKN: f64 = 200.0;

fn re(pattern: &str) -> &'static Regex {
    // Small static registry keyed by pattern; patterns are literals in this file.
    static CACHE: OnceLock<std::sync::Mutex<HashMap<String, &'static Regex>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut guard = cache.lock().expect("regex cache poisoned");
    if let Some(found) = guard.get(pattern) {
        return found;
    }
    let compiled: &'static Regex = Box::leak(Box::new(Regex::new(pattern).expect("valid regex")));
    guard.insert(pattern.to_string(), compiled);
    compiled
}

/// `String(value ?? '')`.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(_) => String::new(),
    }
}

/// `cleanText`: control characters become spaces, then trim, then cap.
pub fn clean_text(value: Option<&Value>, max: usize) -> String {
    let raw = js_string(value);
    let cleaned: String = raw
        .chars()
        .map(|c| if (c as u32) < 0x20 || c as u32 == 0x7f { ' ' } else { c })
        .collect();
    cleaned.trim().chars().take(max).collect()
}

fn clean_str(value: &str, max: usize) -> String {
    clean_text(Some(&Value::String(value.to_string())), max)
}

/// `clampInt`.
pub fn clamp_int(value: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    match js_number(value) {
        Some(number) if number.is_finite() => (number.trunc() as i64).clamp(min, max),
        _ => fallback,
    }
}

// --- condition / language / finish mapping ----------------------------------

pub fn map_condition_from_cm(raw: &str) -> &'static str {
    match clean_str(raw, 40).to_ascii_lowercase().as_str() {
        "mt" | "mint" | "nm" | "near mint" => "NM",
        "ex" | "excellent" | "sp" | "slightly played" => "SP",
        "gd" | "good" | "mp" | "moderately played" | "lp" | "lightly played" => "MP",
        "pl" | "played" | "hp" | "heavily played" => "PL",
        "po" | "poor" => "Poor",
        _ => "NM",
    }
}

pub fn map_condition_to_cm(pokoin: &str) -> &'static str {
    match clean_str(pokoin, 20).as_str() {
        "NM" => "NM",
        "SP" => "EX",
        "MP" => "GD",
        "PL" => "PL",
        "Poor" => "PO",
        "LP" => "LP",
        "HP" => "PL",
        "EX" => "EX",
        "GD" => "GD",
        "PO" => "PO",
        _ => "NM",
    }
}

pub fn map_condition_from_ct(raw: &str) -> &'static str {
    match clean_str(raw, 40).to_ascii_lowercase().as_str() {
        "mint" | "near mint" | "nm" => "NM",
        "slightly played" | "sp" => "SP",
        "moderately played" | "mp" | "lightly played" | "lp" => "MP",
        "played" | "heavily played" | "hp" | "pl" => "PL",
        "poor" | "po" | "damaged" => "Poor",
        _ => map_condition_from_cm(raw),
    }
}

pub fn map_condition_to_ct(pokoin: &str) -> &'static str {
    match clean_str(pokoin, 20).as_str() {
        "NM" => "Near Mint",
        "SP" => "Slightly Played",
        "MP" => "Moderately Played",
        "PL" => "Heavily Played",
        "Poor" => "Poor",
        "LP" => "Lightly Played",
        "HP" => "Heavily Played",
        _ => "Near Mint",
    }
}

pub fn map_language_from_name(raw: &str) -> String {
    let key = clean_str(raw, 40).to_ascii_lowercase();
    if re(r"^[A-Z]{2,3}$").is_match(&key) {
        let upper = key.to_ascii_uppercase();
        if LANG_TO_NAME.iter().any(|(code, _)| *code == upper) {
            return upper;
        }
    }
    LANG_FROM_NAME
        .iter()
        .find(|(name, _)| **name == key)
        .map(|(_, code)| (*code).to_string())
        .unwrap_or_else(|| "EN".to_string())
}

pub fn map_language_to_name(code: &str) -> &'static str {
    let key = clean_str(code, 10).to_ascii_uppercase();
    LANG_TO_NAME
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, label)| *label)
        .unwrap_or("English")
}

const LANG_FROM_NAME: &[(&str, &str)] = &[
    ("english", "EN"), ("en", "EN"), ("italian", "IT"), ("it", "IT"), ("german", "DE"), ("de", "DE"),
    ("french", "FR"), ("fr", "FR"), ("spanish", "ES"), ("es", "ES"), ("portuguese", "PT"),
    ("pt", "PT"), ("japanese", "JP"), ("jp", "JP"), ("ja", "JP"), ("korean", "KO"), ("ko", "KO"),
    ("kr", "KO"), ("chinese", "ZH"), ("zh", "ZH"), ("chinese (trad.)", "ZHT"),
    ("chinese traditional", "ZHT"), ("zht", "ZHT"), ("dutch", "NL"), ("nl", "NL"), ("polish", "PL"),
    ("pl", "PL"), ("russian", "RU"), ("ru", "RU"), ("indonesian", "ID"), ("id", "ID"), ("thai", "TH"),
    ("th", "TH"), ("vietnamese", "VI"), ("vi", "VI"),
];

const LANG_TO_NAME: &[(&str, &str)] = &[
    ("EN", "English"), ("IT", "Italian"), ("DE", "German"), ("FR", "French"), ("ES", "Spanish"),
    ("PT", "Portuguese"), ("JP", "Japanese"), ("KO", "Korean"), ("ZH", "Chinese"),
    ("ZHT", "Chinese (Trad.)"), ("NL", "Dutch"), ("PL", "Polish"), ("RU", "Russian"),
    ("ID", "Indonesian"), ("TH", "Thai"), ("VI", "Vietnamese"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishState {
    pub foil_state: String,
    pub reverse: bool,
    pub variant_state: String,
}

/// `mapFinishFromPowerTools`.
pub fn map_finish_from_powertools(finish_type: &str, is_reverse_holo: Option<&Value>) -> FinishState {
    let finish = clean_str(finish_type, 40);
    let reverse_flag = truthy_flag(is_reverse_holo) || re(r"(?i)reverse").is_match(&finish);
    let lower = finish.to_ascii_lowercase();
    let mut foil_state = "standard";
    let mut variant_state = "";
    if re(r"(?i)master\s*ball").is_match(&finish) {
        foil_state = if reverse_flag { "reverse" } else { "holo" };
        variant_state = "masterball";
    } else if re(r"(?i)pok[eé]\s*ball").is_match(&finish) {
        foil_state = if reverse_flag { "reverse" } else { "holo" };
        variant_state = "pokeball";
    } else if re(r"(?i)cosmos").is_match(&finish) {
        foil_state = "holo";
        variant_state = "cosmos";
    } else if re(r"(?i)ice\s*crack").is_match(&finish) {
        foil_state = "holo";
        variant_state = "icecracked";
    } else if re(r"(?i)stamp").is_match(&finish) {
        foil_state = "stamped";
    } else if re(r"(?i)promo").is_match(&finish) {
        foil_state = "promo";
    } else if reverse_flag || lower == "reverseholo" {
        foil_state = "reverse";
    } else if re(r"(?i)holo").is_match(&finish) && !re(r"(?i)reverse").is_match(&finish) {
        foil_state = "holo";
    }
    FinishState {
        foil_state: foil_state.to_string(),
        reverse: foil_state == "reverse" || reverse_flag,
        variant_state: variant_state.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PowerToolsFinish {
    pub finish_type: &'static str,
    pub is_reverse_holo: bool,
}

/// `mapFinishToPowerTools`.
pub fn map_finish_to_powertools(foil_state: &str, reverse: bool, variant_state: &str) -> PowerToolsFinish {
    let variant = clean_str(variant_state, 40).to_ascii_lowercase();
    let foil = clean_str(foil_state, 40).to_ascii_lowercase();
    let is_reverse = reverse || foil == "reverse";
    match variant.as_str() {
        "masterball" => PowerToolsFinish {
            finish_type: if is_reverse { "ReverseMasterballHolo" } else { "MasterballHolo" },
            is_reverse_holo: is_reverse,
        },
        "pokeball" => PowerToolsFinish {
            finish_type: if is_reverse { "ReversePokeballHolo" } else { "PokeballHolo" },
            is_reverse_holo: is_reverse,
        },
        "cosmos" => PowerToolsFinish { finish_type: "CosmosHolo", is_reverse_holo: false },
        "icecracked" => PowerToolsFinish { finish_type: "IceCrackedHolo", is_reverse_holo: false },
        _ => {
            if foil == "stamped" {
                PowerToolsFinish { finish_type: "StampedHolo", is_reverse_holo: false }
            } else if foil == "promo" {
                PowerToolsFinish { finish_type: "Promo", is_reverse_holo: false }
            } else if is_reverse {
                PowerToolsFinish { finish_type: "ReverseHolo", is_reverse_holo: true }
            } else if foil == "holo" {
                PowerToolsFinish { finish_type: "Holo", is_reverse_holo: false }
            } else {
                PowerToolsFinish { finish_type: "Regular", is_reverse_holo: false }
            }
        }
    }
}

// --- locations ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLocation {
    pub box_name: String,
    pub stack: i64,
    pub position: i64,
    pub structured: bool,
    pub has_position: bool,
}

/// `parseLocation`: `box·2·5`, `box·3`, trailing ` #3`, or bare box.
pub fn parse_location(raw: &str) -> ParsedLocation {
    let text = clean_str(raw, 120);
    if text.is_empty() {
        return ParsedLocation {
            box_name: String::new(),
            stack: 1,
            position: 1,
            structured: false,
            has_position: false,
        };
    }
    if let Some(caps) = re(r"^(.+?)[·•](\d+)(?:[·•](\d+))?$").captures(&text) {
        let third = caps.get(3).map(|m| m.as_str().to_string());
        return ParsedLocation {
            box_name: clean_str(caps.get(1).unwrap().as_str(), 64),
            stack: clamp_int(Some(&json!(caps.get(2).unwrap().as_str())), 1, 9999, 1),
            position: clamp_int(
                third.as_deref().map(|value| json!(value)).as_ref(),
                1,
                9999,
                1,
            ),
            structured: true,
            has_position: third.is_some(),
        };
    }
    if let Some(caps) = re(r"^(.+?)[\s_-]+(\d+)[\s_-]+(\d+)$").captures(&text) {
        let head = caps.get(1).unwrap().as_str();
        if !re(r"^\d+$").is_match(head) {
            return ParsedLocation {
                box_name: text.clone(),
                stack: 1,
                position: 1,
                structured: false,
                has_position: false,
            };
        }
    }
    if let Some(caps) = re(r"^(.+?)\s*#\s*(\d+)$").captures(&text) {
        return ParsedLocation {
            box_name: clean_str(caps.get(1).unwrap().as_str(), 64),
            stack: clamp_int(Some(&json!(caps.get(2).unwrap().as_str())), 1, 9999, 1),
            position: 1,
            structured: true,
            has_position: false,
        };
    }
    ParsedLocation {
        box_name: text,
        stack: 1,
        position: 1,
        structured: false,
        has_position: false,
    }
}

/// `parsePowerToolsLocation`.
pub fn parse_powertools_location(raw: &str, location_parse: &str) -> ParsedLocation {
    let text = clean_str(raw, 120);
    if text.is_empty() {
        return ParsedLocation {
            box_name: String::new(),
            stack: 1,
            position: 1,
            structured: false,
            has_position: false,
        };
    }
    let mode = {
        let cleaned = clean_str(location_parse, 40);
        if cleaned.is_empty() { "as_is".to_string() } else { cleaned }
    };
    if mode == "structured" || re(r"[·•]\d+").is_match(&text) {
        return parse_location(&text);
    }
    if mode == "trailing_stack" {
        if let Some(caps) = re(r"^(.+?)\s+-\s+(\d+)$").captures(&text) {
            return ParsedLocation {
                box_name: clean_str(caps.get(1).unwrap().as_str(), 64),
                stack: clamp_int(Some(&json!(caps.get(2).unwrap().as_str())), 1, 9999, 1),
                position: 1,
                structured: true,
                has_position: false,
            };
        }
        if let Some(caps) = re(r"^(.+?)[\s_]+(\d+)$").captures(&text) {
            let head = caps.get(1).unwrap().as_str();
            if re(r"[a-zA-Z]").is_match(head) {
                return ParsedLocation {
                    box_name: clean_str(head, 64),
                    stack: clamp_int(Some(&json!(caps.get(2).unwrap().as_str())), 1, 9999, 1),
                    position: 1,
                    structured: true,
                    has_position: false,
                };
            }
        }
    }
    ParsedLocation {
        box_name: text,
        stack: 1,
        position: 1,
        structured: false,
        has_position: false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocationStyle {
    pub location_parse: &'static str,
    pub location_examples: Vec<String>,
    pub structured: i64,
    pub trailing: i64,
    pub as_is: i64,
    pub total: i64,
}

/// `detectPowerToolsLocationStyle` — never invents box names.
pub fn detect_powertools_location_style(locations: &[String]) -> LocationStyle {
    let mut examples: Vec<String> = Vec::new();
    let (mut structured, mut trailing, mut as_is) = (0i64, 0i64, 0i64);
    for raw in locations {
        let text = clean_str(raw, 120);
        if text.is_empty() {
            continue;
        }
        if examples.len() < 6 && !examples.contains(&text) {
            examples.push(text.clone());
        }
        if re(r"[·•#]\d+").is_match(&text) {
            structured += 1;
            continue;
        }
        if re(r"^.+?\s+-\s+\d+$").is_match(&text)
            || (re(r"^.+?[\s_]+\d+$").is_match(&text) && re(r"[a-zA-ZÀ-ÿ]").is_match(&text))
        {
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
    LocationStyle {
        location_parse,
        location_examples: examples,
        structured,
        trailing,
        as_is,
        total,
    }
}

/// `formatListingLocation`.
pub fn format_listing_location(
    box_name: &str,
    stack: i64,
    position: i64,
    numbered_in_stack: bool,
    include_stack: bool,
) -> String {
    let loc = clean_str(box_name, 64);
    if loc.is_empty() {
        return String::new();
    }
    let s = stack.max(1);
    let p = position.max(1);
    if !numbered_in_stack {
        if include_stack || s > 1 {
            return format!("{loc}·{s}");
        }
        return loc;
    }
    format!("{loc}·{s}·{p}")
}

/// `assignStackPositions` — legacy Inventory CSV import.
pub fn assign_stack_positions(rows: &[Value], stack_size: i64) -> Vec<Value> {
    let size = stack_size.max(1);
    let mut counters: HashMap<String, i64> = HashMap::new();
    rows.iter()
        .map(|row| {
            let raw_location = row
                .get("location")
                .or_else(|| row.get("box"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let parsed = parse_location(&raw_location);
            let had_structured = re(r"[·•]\d+").is_match(&raw_location);
            let mut stack = parsed.stack;
            let mut position = parsed.position;
            let box_name = if parsed.box_name.is_empty() {
                let fallback = clean_str(&raw_location, 64);
                if fallback.is_empty() { "box".to_string() } else { fallback }
            } else {
                parsed.box_name.clone()
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
                let abs = (stack - 1) * size + size.min(position);
                let entry = counters.entry(box_name.clone()).or_insert(0);
                if abs > *entry {
                    *entry = abs;
                }
            }
            let mut out = row.clone();
            if let Some(object) = out.as_object_mut() {
                object.insert("box".into(), json!(box_name));
                object.insert("stack".into(), json!(stack));
                object.insert("position".into(), json!(position));
                object.insert("stackSize".into(), json!(size));
                object.insert(
                    "location".into(),
                    json!(format_listing_location(&box_name, stack, position, true, true)),
                );
            }
            out
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occupancy {
    pub box_name: String,
    pub stack: i64,
    pub count: i64,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overflow {
    pub box_name: String,
    pub stack: i64,
    pub count: i64,
    pub stack_size: i64,
    pub label: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct PowerToolsAssignment {
    pub rows: Vec<Value>,
    pub overflows: Vec<Overflow>,
    pub occupancy: Vec<Occupancy>,
    pub suggested_stack_size: i64,
}

/// `assignPowerToolsLocations`.
pub fn assign_powertools_locations(
    rows: &[Value],
    stack_size: i64,
    numbered_in_stack: bool,
    location_parse: &str,
) -> PowerToolsAssignment {
    let stack_size = stack_size.max(1);
    let location_parse = {
        let cleaned = clean_str(location_parse, 40);
        if cleaned.is_empty() { "as_is".to_string() } else { cleaned }
    };
    let mut counts: HashMap<String, i64> = HashMap::new();
    let mut pos_counters: HashMap<String, i64> = HashMap::new();
    let mut out = Vec::with_capacity(rows.len());

    for row in rows {
        let raw_loc = clean_text(row.get("location").or_else(|| row.get("box")), 120);
        let parsed = parse_powertools_location(&raw_loc, &location_parse);
        let box_name = if parsed.box_name.is_empty() {
            if raw_loc.is_empty() { "box".to_string() } else { raw_loc.clone() }
        } else {
            parsed.box_name.clone()
        };
        let mut stack = parsed.stack.max(1);
        let mut position = 1i64;
        let key = format!("{box_name}|{stack}");
        let next_count = counts.get(&key).copied().unwrap_or(0) + 1;
        counts.insert(key.clone(), next_count);

        if numbered_in_stack {
            if parsed.has_position {
                position = parsed.position;
            } else {
                let abs = pos_counters.get(&key).copied().unwrap_or(0) + 1;
                pos_counters.insert(key.clone(), abs);
                stack += (abs - 1) / stack_size;
                position = (abs - 1) % stack_size + 1;
            }
        }

        let include_stack = parsed.structured || location_parse == "trailing_stack" || stack > 1;
        let location = format_listing_location(
            &box_name,
            stack,
            position,
            numbered_in_stack,
            include_stack || numbered_in_stack,
        );
        let mut item = row.clone();
        if let Some(object) = item.as_object_mut() {
            object.insert("box".into(), json!(box_name));
            object.insert("stack".into(), json!(stack));
            object.insert("position".into(), json!(position));
            object.insert("stackSize".into(), json!(stack_size));
            object.insert("location".into(), json!(location));
            object.insert("sourceLocation".into(), json!(raw_loc));
        }
        out.push(item);
    }

    let mut occupancy: Vec<Occupancy> = Vec::new();
    let mut suggested_stack_size = 1i64;
    for (key, count) in counts.iter() {
        let mut parts = key.splitn(2, '|');
        let box_name = parts.next().unwrap_or_default().to_string();
        let stack = parts.next().and_then(|value| value.parse::<i64>().ok()).unwrap_or(1);
        let label = format!(
            "{box_name}{}",
            if stack > 1 || location_parse == "trailing_stack" {
                format!("·{stack}")
            } else {
                String::new()
            }
        );
        occupancy.push(Occupancy { box_name, stack, count: *count, label });
        if *count > suggested_stack_size {
            suggested_stack_size = *count;
        }
    }
    occupancy.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.label.cmp(&b.label)));

    let mut overflows = Vec::new();
    for row in &occupancy {
        if row.count <= stack_size {
            continue;
        }
        overflows.push(Overflow {
            box_name: row.box_name.clone(),
            stack: row.stack,
            count: row.count,
            stack_size,
            label: row.label.clone(),
            message: format!(
                "{}: {} cards in this stack, but capacity is set to {}",
                row.label, row.count, stack_size
            ),
        });
    }

    PowerToolsAssignment {
        rows: out,
        overflows,
        occupancy,
        suggested_stack_size: suggested_stack_size.max(1),
    }
}

// --- pricing -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriceMode {
    EurToPkn,
    AsPkn,
    CentsEurToPkn,
}

pub fn price_to_pkn(
    raw: Option<&Value>,
    price_mode: PriceMode,
    currency: &str,
) -> Option<f64> {
    let text = js_string(raw).replace(',', ".");
    let n = text.trim().parse::<f64>().ok()?;
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    match price_mode {
        PriceMode::AsPkn => Some(n),
        PriceMode::CentsEurToPkn => Some((n / 100.0) * EUR_TO_PKN),
        PriceMode::EurToPkn => {
            let cur = {
                let cleaned = clean_str(currency, 8).to_ascii_uppercase();
                if cleaned.is_empty() { "EUR".to_string() } else { cleaned }
            };
            if cur == "PKN" {
                Some(n)
            } else {
                Some(n * EUR_TO_PKN)
            }
        }
    }
}

pub fn pkn_to_eur(pkn: Option<f64>) -> String {
    let Some(n) = pkn else { return String::new() };
    if !n.is_finite() || n <= 0.0 {
        return String::new();
    }
    let eur = (n / EUR_TO_PKN * 100.0).round() / 100.0;
    format_number(eur)
}

pub fn pkn_to_cents(pkn: Option<f64>) -> String {
    let text = pkn_to_eur(pkn);
    if text.is_empty() {
        return String::new();
    }
    let Ok(eur) = text.parse::<f64>() else {
        return String::new();
    };
    if !eur.is_finite() || eur <= 0.0 {
        return String::new();
    }
    format!("{}", (eur * 100.0).round() as i64)
}

/// JS `String(number)`: no trailing `.0`.
fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        let mut text = format!("{value}");
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
        text
    }
}

// --- CSV parse / emit --------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedCsv {
    pub headers: Vec<String>,
    pub records: Vec<Map<String, Value>>,
}

/// Minimal CSV parse (RFC4180-ish): commas, quotes, CRLF.
pub fn parse_csv(text: &str) -> ParsedCsv {
    let src = text.strip_prefix('\u{feff}').unwrap_or(text);
    let chars: Vec<char> = src.chars().collect();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut i = 0usize;
    let mut in_quotes = false;
    while i < chars.len() {
        let ch = chars[i];
        if in_quotes {
            if ch == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    cell.push('"');
                    i += 2;
                    continue;
                }
                in_quotes = false;
                i += 1;
                continue;
            }
            cell.push(ch);
            i += 1;
            continue;
        }
        if ch == '"' {
            in_quotes = true;
            i += 1;
            continue;
        }
        if ch == ',' {
            row.push(std::mem::take(&mut cell));
            i += 1;
            continue;
        }
        if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            row.push(std::mem::take(&mut cell));
            if row.iter().any(|c| !c.is_empty()) {
                rows.push(std::mem::take(&mut row));
            }
            row.clear();
            i += 1;
            continue;
        }
        cell.push(ch);
        i += 1;
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        if row.iter().any(|c| !c.is_empty()) {
            rows.push(row);
        }
    }
    if rows.is_empty() {
        return ParsedCsv::default();
    }
    let headers: Vec<String> = rows[0].iter().map(|h| clean_str(h, 80)).collect();
    let records = rows[1..]
        .iter()
        .map(|cols| {
            let mut object = Map::new();
            for (index, header) in headers.iter().enumerate() {
                object.insert(
                    header.clone(),
                    Value::String(cols.get(index).cloned().unwrap_or_default()),
                );
            }
            object
        })
        .collect();
    ParsedCsv { headers, records }
}

pub fn escape_csv_cell(value: &str) -> String {
    if re(r#"[",\r\n]"#).is_match(value) {
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
                .map(|header| {
                    let cell = row
                        .get(header)
                        .map(|value| js_string(Some(value)))
                        .unwrap_or_default();
                    escape_csv_cell(&cell)
                })
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    format!("{}\n", lines.join("\n"))
}

fn header_key(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '_')
        .collect()
}

/// `field(raw, ...names)`: exact key, then case/space/underscore-insensitive.
pub fn field(raw: &Map<String, Value>, names: &[&str]) -> Value {
    for name in names {
        if let Some(value) = raw.get(*name) {
            if !js_string(Some(value)).trim().is_empty() {
                return value.clone();
            }
        }
    }
    let wanted: Vec<String> = names.iter().map(|name| header_key(name)).collect();
    for (key, value) in raw {
        if wanted.contains(&header_key(key)) && !js_string(Some(value)).trim().is_empty() {
            return value.clone();
        }
    }
    Value::String(String::new())
}

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

/// `normalizeImportRow` — one normalized row per supported format.
pub fn normalize_import_row(
    format: &str,
    raw: &Map<String, Value>,
    price_mode: PriceMode,
) -> Result<Value, String> {
    match format {
        "powertools" => {
            let finish = map_finish_from_powertools(
                &clean_text(raw.get("finishType"), 40),
                raw.get("isReverseHolo"),
            );
            let name = clean_text(raw.get("name"), 240);
            Ok(json!({
                "format": format,
                "externalId": clean_text(raw.get("cardmarketId"), 40),
                "cardmarketId": clean_text(raw.get("cardmarketId"), 40),
                "quantity": clamp_int(raw.get("quantity"), 1, 99, 1),
                "name": name,
                "setName": clean_text(raw.get("set"), 240),
                "setCode": clean_text(raw.get("setCode"), 40),
                "collectorNumber": clean_text(raw.get("cn"), 40),
                "condition": map_condition_from_cm(&clean_text(raw.get("condition"), 40)),
                "language": map_language_from_name(&clean_text(raw.get("language"), 40)),
                "firstEdition": truthy_flag(raw.get("isFirstEd")),
                "signed": truthy_flag(raw.get("isSigned")),
                "altered": false,
                "foilState": finish.foil_state,
                "reverse": finish.reverse,
                "variantState": finish.variant_state,
                "pricePkn": price_to_pkn(raw.get("price"), price_mode, "EUR"),
                "sellerComment": clean_text(raw.get("comment"), 500),
                "location": clean_text(raw.get("location"), 120),
                "rarity": clean_text(raw.get("rarity"), 80),
            }))
        }
        "cardmarket" => {
            let reverse = truthy_flag(raw.get("isReverseHolo"));
            let foil = truthy_flag(raw.get("isFoil"));
            Ok(json!({
                "format": format,
                "externalId": clean_text(raw.get("idProduct"), 40),
                "cardmarketId": clean_text(raw.get("idProduct"), 40),
                "quantity": clamp_int(raw.get("quantity"), 1, 99, 1),
                "name": clean_text(raw.get("name"), 240),
                "setName": clean_text(raw.get("expansion"), 240),
                "setCode": "",
                "collectorNumber": clean_text(raw.get("number"), 40),
                "condition": map_condition_from_cm(&clean_text(raw.get("condition"), 40)),
                "language": map_language_from_name(&clean_text(raw.get("language"), 40)),
                "firstEdition": truthy_flag(raw.get("isFirstEd")),
                "signed": truthy_flag(raw.get("isSigned")),
                "altered": truthy_flag(raw.get("isAltered")),
                "foilState": if reverse { "reverse" } else if foil { "holo" } else { "standard" },
                "reverse": reverse,
                "variantState": "",
                "pricePkn": price_to_pkn(raw.get("price"), price_mode, "EUR"),
                "sellerComment": clean_text(raw.get("comment"), 500),
                "location": clean_text(raw.get("location"), 120),
                "rarity": "",
            }))
        }
        "cardtrader" => {
            let reverse = truthy_flag(raw.get("reverse"))
                || clean_text(raw.get("foil"), 40).to_ascii_lowercase() == "reverse";
            let price_pkn = match raw.get("price_cents") {
                Some(Value::String(text)) if !text.is_empty() => {
                    price_to_pkn(raw.get("price_cents"), PriceMode::CentsEurToPkn, "EUR")
                }
                Some(Value::Number(_)) => {
                    price_to_pkn(raw.get("price_cents"), PriceMode::CentsEurToPkn, "EUR")
                }
                _ => price_to_pkn(
                    raw.get("price"),
                    price_mode,
                    &clean_text(raw.get("currency"), 8),
                ),
            };
            let foil_raw = clean_text(raw.get("foil"), 40).to_ascii_lowercase();
            let external_id = {
                let product = clean_text(raw.get("product_id"), 40);
                if product.is_empty() {
                    clean_text(raw.get("blueprint_id"), 40)
                } else {
                    product
                }
            };
            Ok(json!({
                "format": format,
                "externalId": external_id,
                "blueprintId": clean_text(raw.get("blueprint_id"), 40),
                "productId": clean_text(raw.get("product_id"), 40),
                "quantity": clamp_int(raw.get("quantity"), 1, 99, 1),
                "name": clean_text(raw.get("name"), 240),
                "setName": clean_text(raw.get("expansion"), 240),
                "setCode": "",
                "collectorNumber": clean_text(raw.get("number"), 40),
                "condition": map_condition_from_ct(&clean_text(raw.get("condition"), 40)),
                "language": map_language_from_name(&clean_text(raw.get("language"), 40)),
                "firstEdition": truthy_flag(raw.get("first_edition")),
                "signed": truthy_flag(raw.get("signed")),
                "altered": truthy_flag(raw.get("altered")),
                "foilState": if reverse { "reverse" } else if foil_raw == "holo" { "holo" } else { "standard" },
                "reverse": reverse,
                "variantState": "",
                "pricePkn": price_pkn,
                "sellerComment": clean_text(raw.get("comment"), 500),
                "location": clean_text(raw.get("location"), 120),
                "rarity": "",
            }))
        }
        "tcgplayer" => {
            let printing = clean_text(Some(&field(raw, &["Printing"])), 40).to_ascii_lowercase();
            let reverse = re(r"reverse").is_match(&printing);
            let foil = re(r"holo|foil").is_match(&printing);
            let price = field(raw, &["TCG Marketplace Price", "TCG Market Price", "price"]);
            let language_field = field(raw, &["Language"]);
            let language_raw = language_field.as_str().unwrap_or_default();
            let language_input = if language_raw.is_empty() {
                "English"
            } else {
                language_raw
            };
            Ok(json!({
                "format": format,
                "externalId": clean_text(Some(&field(raw, &["TCGplayer Id"])), 40),
                "tcgplayerId": clean_text(Some(&field(raw, &["TCGplayer Id"])), 40),
                "quantity": clamp_int(Some(&field(raw, &["Total Quantity", "Quantity", "Add to Quantity"])), 1, 99, 1),
                "name": clean_text(Some(&field(raw, &["Product Name", "Title", "Name"])), 240),
                "setName": clean_text(Some(&field(raw, &["Set Name", "Set"])), 240),
                "setCode": "",
                "collectorNumber": clean_text(Some(&field(raw, &["Number"])), 40),
                "condition": map_condition_from_ct(&field(raw, &["Condition"]).as_str().unwrap_or_default()),
                "language": map_language_from_name(language_input),
                "firstEdition": re(r"1st|first").is_match(&printing),
                "signed": false,
                "altered": false,
                "foilState": if reverse { "reverse" } else if foil { "holo" } else { "standard" },
                "reverse": reverse,
                "variantState": "",
                "pricePkn": price_to_pkn(Some(&price), price_mode, "EUR"),
                "sellerComment": "",
                "location": clean_text(Some(&field(raw, &["Location"])), 120),
                "rarity": clean_text(Some(&field(raw, &["Rarity"])), 80),
            }))
        }
        other => Err(format!("Unknown format: {other}")),
    }
}

fn listing_text(listing: &Value, keys: &[&str], max: usize) -> String {
    for key in keys {
        if let Some(value) = listing.get(*key) {
            let text = js_string(Some(value));
            if !text.trim().is_empty() {
                return clean_str(&text, max);
            }
        }
    }
    String::new()
}

/// `listingToExportRow` for each supported format.
pub fn listing_to_export_row(format: &str, listing: &Value) -> Result<Value, String> {
    let location = listing_text(listing, &["location"], 120);
    let qty = clamp_int(
        listing
            .get("quantityAvailable")
            .or_else(|| listing.get("quantity")),
        1,
        99,
        1,
    );
    let name = listing_text(listing, &["cardName", "name"], 240);
    let set_name = listing_text(listing, &["setName"], 240);
    let collector = listing_text(listing, &["collectorNumber"], 40);
    let condition = listing_text(listing, &["condition"], 20);
    let language = listing_text(listing, &["language"], 10);
    let price_pkn = listing.get("pricePkn").and_then(Value::as_f64);
    let foil_state = listing_text(listing, &["foilState"], 40);
    let variant_state = listing_text(listing, &["variantState"], 40);
    let reverse = listing.get("reverse").and_then(Value::as_bool).unwrap_or(false);
    let signed = listing.get("signed").and_then(Value::as_bool).unwrap_or(false);
    let altered = listing.get("altered").and_then(Value::as_bool).unwrap_or(false);
    let first_edition = listing
        .get("firstEdition")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let comment = listing_text(listing, &["sellerComment"], 500);

    match format {
        "powertools" => {
            let finish = map_finish_to_powertools(&foil_state, reverse, &variant_state);
            let cn = re(r"/.*$").replace(&collector, "").to_string();
            let cn = re(r"^.*\|\s*").replace(&cn, "").to_string();
            Ok(json!({
                "cardmarketId": listing_text(listing, &["cardmarketId"], 40),
                "quantity": qty.to_string(),
                "name": name,
                "set": set_name,
                "setCode": listing_text(listing, &["setCode"], 40),
                "cn": cn,
                "condition": map_condition_to_cm(&condition),
                "language": map_language_to_name(&language),
                "isFirstEd": if first_edition { "true" } else { "" },
                "isReverseHolo": if finish.is_reverse_holo { "true" } else { "" },
                "isSigned": if signed { "true" } else { "" },
                "finishType": finish.finish_type,
                "price": pkn_to_eur(price_pkn),
                "comment": comment,
                "location": location,
                "nameDE": "", "nameES": "", "nameFR": "", "nameIT": "",
                "rarity": "", "listedAt": "", "countryEdition": "",
            }))
        }
        "cardmarket" => Ok(json!({
            "idProduct": listing_text(listing, &["cardmarketId"], 40),
            "quantity": qty.to_string(),
            "name": name,
            "expansion": set_name,
            "number": collector,
            "language": map_language_to_name(&language),
            "condition": map_condition_to_cm(&condition),
            "isFoil": if !foil_state.is_empty() && foil_state != "standard" { "true" } else { "" },
            "isReverseHolo": if reverse || foil_state == "reverse" { "true" } else { "" },
            "isSigned": if signed { "true" } else { "" },
            "isFirstEd": if first_edition { "true" } else { "" },
            "isAltered": if altered { "true" } else { "" },
            "price": pkn_to_eur(price_pkn),
            "comment": comment,
            "location": location,
        })),
        "cardtrader" => {
            let blueprint_id = {
                let blueprint = listing_text(listing, &["blueprintId"], 40);
                if blueprint.is_empty() {
                    listing_text(listing, &["cardId"], 40)
                } else {
                    blueprint
                }
            };
            let product_id = listing_text(listing, &["ctProductId", "productId"], 40);
            let lang = {
                let lang = language.to_ascii_lowercase();
                if lang.is_empty() {
                    "en".to_string()
                } else {
                    lang
                }
            };
            Ok(json!({
            "blueprint_id": blueprint_id,
            "product_id": product_id,
            "quantity": qty.to_string(),
            "price_cents": pkn_to_cents(price_pkn),
            "currency": "EUR",
            "name": name,
            "expansion": set_name,
            "number": collector,
            "condition": map_condition_to_ct(&condition),
            "language": lang,
            "foil": if foil_state == "holo" { "holo" } else if foil_state == "reverse" || reverse { "reverse" } else { "" },
            "reverse": if reverse || foil_state == "reverse" { "true" } else { "" },
            "first_edition": if first_edition { "true" } else { "" },
            "signed": if signed { "true" } else { "" },
            "altered": if altered { "true" } else { "" },
            "comment": comment,
            "location": location,
        }))
        }
        "tcgplayer" => {
            let finish = map_finish_to_powertools(&foil_state, reverse, &variant_state);
            let printing = if finish.is_reverse_holo {
                "Reverse Holofoil"
            } else if finish.finish_type == "Holo" {
                "Holofoil"
            } else {
                "Normal"
            };
            let tcgplayer_id = {
                let id = listing_text(listing, &["tcgplayerId"], 40);
                if id.is_empty() {
                    listing_text(listing, &["externalId"], 40)
                } else {
                    id
                }
            };
            Ok(json!({
                "TCGplayer Id": tcgplayer_id,
                "Product Line": "Pokemon",
                "Set Name": set_name,
                "Product Name": name,
                "Number": collector,
                "Rarity": "",
                "Condition": map_condition_to_ct(&condition),
                "TCG Market Price": "",
                "TCG Direct Low": "",
                "TCG Low Price With Shipping": "",
                "TCG Low Price": "",
                "Total Quantity": qty.to_string(),
                "Add to Quantity": "",
                "TCG Marketplace Price": pkn_to_eur(price_pkn),
                "Photo URL": "",
                "Language": map_language_to_name(&language),
                "Printing": printing,
                "Location": location,
            }))
        }
        other => Err(format!("Unknown format: {other}")),
    }
}

pub fn headers_for(format: &str) -> Result<Vec<String>, String> {
    let headers: &[&str] = match format {
        "powertools" => &POWERTOOLS_HEADERS,
        "cardmarket" => &CARDMARKET_HEADERS,
        "cardtrader" => &CARDTRADER_HEADERS,
        "tcgplayer" => &TCGPLAYER_HEADERS,
        other => return Err(format!("Unknown format: {other}")),
    };
    Ok(headers.iter().map(|header| header.to_string()).collect())
}

pub fn export_listings_csv(format: &str, listings: &[Value]) -> Result<String, String> {
    let headers = headers_for(format)?;
    let rows: Result<Vec<Value>, String> = listings
        .iter()
        .map(|listing| listing_to_export_row(format, listing))
        .collect();
    Ok(to_csv(&headers, &rows?))
}

#[derive(Debug, Clone)]
pub struct ImportOptions {
    pub format: Option<String>,
    pub price_mode: PriceMode,
    pub preserve_location: bool,
    pub power_tools_sync: bool,
    pub location_parse: String,
    pub detect_location: bool,
    pub stack_size: Option<i64>,
    pub numbered_in_stack: bool,
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            format: None,
            price_mode: PriceMode::EurToPkn,
            preserve_location: false,
            power_tools_sync: false,
            location_parse: "auto".to_string(),
            detect_location: false,
            stack_size: None,
            numbered_in_stack: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ImportResult {
    pub format: String,
    pub headers: Vec<String>,
    pub results: Vec<ImportEntry>,
    pub overflows: Vec<Overflow>,
    pub occupancy: Vec<Occupancy>,
    pub suggested_stack_size: i64,
    pub location_detection: Value,
}

#[derive(Debug, Clone)]
pub struct ImportEntry {
    pub ok: bool,
    pub index: usize,
    pub row: Option<Value>,
    pub error: Option<String>,
    pub raw: Map<String, Value>,
}

/// `importCsvText`.
pub fn import_csv_text(text: &str, options: &ImportOptions) -> Result<ImportResult, String> {
    let parsed = parse_csv(text);
    let format = options
        .format
        .clone()
        .or_else(|| detect_format(&parsed.headers).map(|value| value.to_string()))
        .filter(|value| FORMATS.contains(&value.as_str()))
        .ok_or_else(|| {
            "Unrecognized CSV format. Use powertools, cardmarket, cardtrader, or tcgplayer."
                .to_string()
        })?;

    let normalized: Vec<ImportEntry> = parsed
        .records
        .iter()
        .enumerate()
        .map(|(index, raw)| match normalize_import_row(&format, raw, options.price_mode) {
            Ok(row) => ImportEntry {
                ok: true,
                index: index + 2,
                row: Some(row),
                error: None,
                raw: raw.clone(),
            },
            Err(error) => ImportEntry {
                ok: false,
                index: index + 2,
                row: None,
                error: Some(error),
                raw: raw.clone(),
            },
        })
        .collect();

    let ok_rows: Vec<Value> = normalized
        .iter()
        .filter_map(|entry| entry.row.clone())
        .collect();

    let mut overflows = Vec::new();
    let mut occupancy = Vec::new();
    let mut suggested_stack_size = 1i64;
    let mut location_detection = Value::Null;

    let with_slots: Vec<Value> = if options.preserve_location {
        ok_rows
    } else if options.power_tools_sync {
        let mut location_parse = clean_str(&options.location_parse, 40);
        if location_parse.is_empty() {
            location_parse = "auto".to_string();
        }
        if location_parse == "auto" || options.detect_location {
            let locations: Vec<String> = ok_rows
                .iter()
                .map(|row| {
                    row.get("location")
                        .or_else(|| row.get("box"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                })
                .collect();
            let style = detect_powertools_location_style(&locations);
            location_parse = style.location_parse.to_string();
            location_detection = json!({
                "locationParse": style.location_parse,
                "locationExamples": style.location_examples,
                "counts": {
                    "structured": style.structured,
                    "trailing": style.trailing,
                    "asIs": style.as_is,
                    "total": style.total,
                },
            });
        }
        let stack_size = match options.stack_size {
            Some(size) if size > 0 => size,
            _ => 10000,
        };
        let assigned = assign_powertools_locations(
            &ok_rows,
            stack_size,
            options.numbered_in_stack,
            &location_parse,
        );
        overflows = assigned.overflows;
        occupancy = assigned.occupancy;
        suggested_stack_size = assigned.suggested_stack_size;
        if location_detection.is_null() {
            location_detection = json!({
                "locationParse": location_parse,
                "locationExamples": occupancy
                    .iter()
                    .take(6)
                    .map(|row| row.label.clone())
                    .filter(|label| !label.is_empty())
                    .collect::<Vec<_>>(),
                "counts": Value::Null,
            });
        }
        assigned.rows
    } else {
        assign_stack_positions(&ok_rows, options.stack_size.unwrap_or(1))
    };

    let mut slot_index = 0usize;
    let results = normalized
        .into_iter()
        .map(|entry| {
            if !entry.ok {
                return entry;
            }
            let row = with_slots.get(slot_index).cloned();
            slot_index += 1;
            ImportEntry { row, ..entry }
        })
        .collect();

    Ok(ImportResult {
        format,
        headers: parsed.headers,
        results,
        overflows,
        occupancy,
        suggested_stack_size,
        location_detection,
    })
}

pub fn source_for_format(format: &str, cardtrader_intent: &str) -> &'static str {
    match cardtrader_intent {
        "link" => "cardtrader_csv_link",
        "import" => "cardtrader_csv_import",
        _ => match format {
            "powertools" => "powertools_csv_import",
            "cardmarket" => "cardmarket_csv_import",
            "cardtrader" => "cardtrader_csv_import",
            "tcgplayer" => "tcgplayer_csv_import",
            _ => "stock_csv_import",
        },
    }
}

pub fn source_listing_id_for(format: &str, row: &Value) -> String {
    let id = ["externalId", "cardmarketId", "productId", "blueprintId"]
        .iter()
        .find_map(|key| row.get(*key).and_then(Value::as_str))
        .map(|value| clean_str(value, 80))
        .unwrap_or_default();
    if id.is_empty() {
        return String::new();
    }
    let prefix = match format {
        "powertools" => "pt",
        "cardmarket" => "cm",
        "tcgplayer" => "tp",
        _ => "ct",
    };
    let text = format!(
        "{prefix}:{id}:{}:{}:{}:{}",
        row.get("condition").and_then(Value::as_str).unwrap_or_default(),
        row.get("language").and_then(Value::as_str).unwrap_or_default(),
        row.get("foilState").and_then(Value::as_str).unwrap_or_default(),
        row.get("location").and_then(Value::as_str).unwrap_or_default(),
    );
    text.chars().take(160).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_round_trip_handles_quotes_and_crlf() {
        let text = "name,note\r\n\"Charizard, ex\",\"He said \"\"hi\"\"\"\r\nPikachu,\r\n";
        let parsed = parse_csv(text);
        assert_eq!(parsed.headers, vec!["name", "note"]);
        assert_eq!(parsed.records.len(), 2);
        assert_eq!(parsed.records[0]["name"], json!("Charizard, ex"));
        assert_eq!(parsed.records[0]["note"], json!("He said \"hi\""));
        assert_eq!(parsed.records[1]["note"], json!(""));

        let out = to_csv(
            &["a".to_string(), "b".to_string()],
            &[json!({ "a": "x,y", "b": "plain" })],
        );
        assert_eq!(out, "a,b\n\"x,y\",plain\n");
    }

    #[test]
    fn detects_every_supported_format() {
        assert_eq!(
            detect_format(&["cardmarketId".into(), "finishType".into()]),
            Some("powertools")
        );
        assert_eq!(detect_format(&["blueprint_id".into()]), Some("cardtrader"));
        assert_eq!(detect_format(&["idProduct".into()]), Some("cardmarket"));
        assert_eq!(
            detect_format(&["TCGplayer Id".into(), "Product Name".into()]),
            Some("tcgplayer")
        );
        assert_eq!(detect_format(&["idProduct".into(), "expansion".into(), "isFoil".into()]), Some("cardmarket"));
        assert_eq!(detect_format(&["nope".into()]), None);
    }

    #[test]
    fn condition_and_language_mapping_is_lossless_enough() {
        assert_eq!(map_condition_from_cm("Mint"), "NM");
        assert_eq!(map_condition_from_cm("Excellent"), "SP");
        assert_eq!(map_condition_from_cm("Good"), "MP");
        assert_eq!(map_condition_from_cm("Played"), "PL");
        assert_eq!(map_condition_from_ct("Damaged"), "Poor");
        assert_eq!(map_condition_to_cm("SP"), "EX");
        assert_eq!(map_condition_to_ct("NM"), "Near Mint");

        assert_eq!(map_language_from_name("Japanese"), "JP");
        assert_eq!(map_language_from_name("jp"), "JP");
        assert_eq!(map_language_from_name("KO"), "KO");
        assert_eq!(map_language_from_name("klingon"), "EN");
        assert_eq!(map_language_to_name("zht"), "Chinese (Trad.)");
    }

    #[test]
    fn finish_mapping_round_trips_master_ball() {
        let finish = map_finish_from_powertools("MasterballHolo", None);
        assert_eq!(finish.foil_state, "holo");
        assert_eq!(finish.variant_state, "masterball");
        let back = map_finish_to_powertools("holo", false, "masterball");
        assert_eq!(back.finish_type, "MasterballHolo");

        let reverse = map_finish_from_powertools("Reverse Holo", None);
        assert!(reverse.reverse);
        assert_eq!(reverse.foil_state, "reverse");
        assert_eq!(
            map_finish_to_powertools("reverse", true, "").finish_type,
            "ReverseHolo"
        );
    }

    #[test]
    fn price_conversion_uses_two_hundred_pkn_per_euro() {
        assert_eq!(price_to_pkn(Some(&json!("1.50")), PriceMode::EurToPkn, "EUR"), Some(300.0));
        assert_eq!(price_to_pkn(Some(&json!("1,50")), PriceMode::EurToPkn, "EUR"), Some(300.0));
        assert_eq!(price_to_pkn(Some(&json!(150)), PriceMode::CentsEurToPkn, "EUR"), Some(300.0));
        assert_eq!(price_to_pkn(Some(&json!(5)), PriceMode::EurToPkn, "PKN"), Some(5.0));
        assert_eq!(price_to_pkn(Some(&json!(0)), PriceMode::EurToPkn, "EUR"), None);
        assert_eq!(pkn_to_eur(Some(300.0)), "1.5");
        assert_eq!(pkn_to_cents(Some(300.0)), "150");
    }

    #[test]
    fn location_parsing_covers_all_forms() {
        let structured = parse_location("box·2·5");
        assert!(structured.structured && structured.has_position);
        assert_eq!(structured.box_name, "box");
        assert_eq!((structured.stack, structured.position), (2, 5));

        let hash = parse_location("FUOCOBOMBA #16");
        assert_eq!(hash.box_name, "FUOCOBOMBA");
        assert_eq!(hash.stack, 16);

        let bare = parse_location("FUOCOBOMBA 006 - 16");
        assert!(!bare.structured);
        assert_eq!(bare.box_name, "FUOCOBOMBA 006 - 16");
    }

    #[test]
    fn powertools_trailing_stack_mode_splits_box_and_stack() {
        let parsed = parse_powertools_location("FUOCOBOMBA 006 - 16", "trailing_stack");
        assert_eq!(parsed.box_name, "FUOCOBOMBA 006");
        assert_eq!(parsed.stack, 16);
        assert!(parsed.structured);

        let as_is = parse_powertools_location("FUOCOBOMBA 006 - 16", "as_is");
        assert_eq!(as_is.box_name, "FUOCOBOMBA 006 - 16");
        assert!(!as_is.structured);
    }

    #[test]
    fn location_style_detection_picks_the_dominant_shape() {
        let structured = detect_powertools_location_style(&[
            "box·1".into(),
            "box·2".into(),
            "box·3".into(),
        ]);
        assert_eq!(structured.location_parse, "structured");
        assert_eq!(structured.location_examples.len(), 3);

        let trailing = detect_powertools_location_style(&[
            "FUOCOBOMBA 006 - 16".into(),
            "FUOCOBOMBA 006 - 17".into(),
            "misc".into(),
        ]);
        assert_eq!(trailing.location_parse, "trailing_stack");
    }

    #[test]
    fn stack_assignment_numbers_cards_within_a_box() {
        let rows = vec![
            json!({ "location": "box", "name": "a" }),
            json!({ "location": "box", "name": "b" }),
            json!({ "location": "box", "name": "c" }),
        ];
        let assigned = assign_stack_positions(&rows, 1);
        assert_eq!(assigned[0]["location"], json!("box·1·1"));
        assert_eq!(assigned[1]["location"], json!("box·2·1"));
        assert_eq!(assigned[2]["location"], json!("box·3·1"));

        let assigned = assign_stack_positions(&rows, 2);
        assert_eq!(assigned[0]["location"], json!("box·1·1"));
        assert_eq!(assigned[1]["location"], json!("box·1·2"));
        assert_eq!(assigned[2]["location"], json!("box·2·1"));
    }

    #[test]
    fn powertools_assignment_reports_overflow_against_capacity() {
        let rows = vec![
            json!({ "location": "box·1" }),
            json!({ "location": "box·1" }),
            json!({ "location": "box·2" }),
        ];
        let assigned = assign_powertools_locations(&rows, 1, false, "structured");
        assert_eq!(assigned.rows[0]["location"], json!("box·1"));
        assert_eq!(assigned.suggested_stack_size, 2);
        assert_eq!(assigned.overflows.len(), 1);
        assert_eq!(assigned.overflows[0].count, 2);
        assert!(assigned.overflows[0].message.contains("capacity is set to 1"));
    }

    #[test]
    fn powertools_assignment_spills_past_capacity_when_numbering() {
        let rows = vec![
            json!({ "location": "box·1" }),
            json!({ "location": "box·1" }),
            json!({ "location": "box·1" }),
        ];
        let assigned = assign_powertools_locations(&rows, 2, true, "structured");
        assert_eq!(assigned.rows[0]["location"], json!("box·1·1"));
        assert_eq!(assigned.rows[1]["location"], json!("box·1·2"));
        // Third card spills into stack 2 because capacity is 2.
        assert_eq!(assigned.rows[2]["location"], json!("box·2·1"));
    }

    #[test]
    fn import_normalizes_powertools_rows() {
        let csv = "cardmarketId,quantity,name,set,cn,condition,language,isReverseHolo,finishType,price,comment,location\n\
                   123,2,Charizard,Base Set,4/102,ex,english,true,ReverseHolo,1.50,note,box·1\n";
        let result = import_csv_text(csv, &ImportOptions::default()).unwrap();
        assert_eq!(result.format, "powertools");
        assert_eq!(result.results.len(), 1);
        let row = result.results[0].row.clone().unwrap();
        assert_eq!(row["condition"], json!("SP"));
        assert_eq!(row["language"], json!("EN"));
        assert_eq!(row["pricePkn"], json!(300.0));
        assert_eq!(row["reverse"], json!(true));
        assert_eq!(row["foilState"], json!("reverse"));
        // Default (non-preserve) path assigns stack slots.
        assert_eq!(row["location"], json!("box·1·1"));
    }

    #[test]
    fn import_rejects_unknown_formats() {
        let error = import_csv_text("a,b\n1,2\n", &ImportOptions::default()).unwrap_err();
        assert!(error.contains("Unrecognized CSV format"));
    }

    #[test]
    fn preserve_location_keeps_the_file_string() {
        let csv = "blueprint_id,quantity,name,price_cents,condition,language,foil\n\
                   555,1,Card,250,Near Mint,en,holo\n";
        let options = ImportOptions {
            preserve_location: true,
            ..Default::default()
        };
        let result = import_csv_text(csv, &options).unwrap();
        let row = result.results[0].row.clone().unwrap();
        assert_eq!(row["pricePkn"], json!(500.0));
        assert_eq!(row["foilState"], json!("holo"));
        assert_eq!(row["location"], json!(""));
    }

    #[test]
    fn export_then_import_round_trips_a_powertools_row() {
        let listings = vec![json!({
            "cardmarketId": "123",
            "cardName": "Charizard",
            "setName": "Base Set",
            "collectorNumber": "4/102",
            "quantityAvailable": 2,
            "condition": "SP",
            "language": "EN",
            "pricePkn": 300,
            "foilState": "reverse",
            "reverse": true,
            "location": "box·1",
        })];
        let csv = export_listings_csv("powertools", &listings).unwrap();
        assert!(csv.starts_with("cardmarketId,quantity,name,"));
        let result = import_csv_text(
            &csv,
            &ImportOptions {
                preserve_location: true,
                ..Default::default()
            },
        )
        .unwrap();
        let row = result.results[0].row.clone().unwrap();
        assert_eq!(row["name"], json!("Charizard"));
        assert_eq!(row["condition"], json!("SP"));
        assert_eq!(row["pricePkn"], json!(300.0));
    }

    #[test]
    fn source_listing_ids_are_prefixed_and_bounded() {
        let row = json!({
            "externalId": "123", "condition": "NM", "language": "EN",
            "foilState": "standard", "location": "box",
        });
        assert_eq!(source_listing_id_for("powertools", &row), "pt:123:NM:EN:standard:box");
        assert_eq!(source_for_format("cardtrader", "link"), "cardtrader_csv_link");
        assert_eq!(source_for_format("cardmarket", ""), "cardmarket_csv_import");
    }
}
