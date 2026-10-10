//! Pure Scan Connect rules — native port of `_scan_connect.js` (no I/O).
//!
//! Spec: pokoin-web docs/SCAN_CONNECT.md, docs/SCAN_LISTING_WORKFLOW.md.

use rand::{Rng, RngCore};
use serde_json::{json, Map, Value};

use crate::error::{clean_text, ApiError, ApiResult};

pub const PAIRING_TTL_MS: i64 = 120_000;
pub const SESSION_IDLE_MS: i64 = 30 * 60_000;
pub const SCAN_IDLE_MS: i64 = 10 * 60_000;
pub const EXPIRY_UPLOAD_GRACE_MS: i64 = 120_000;
pub const PHONE_LOST_MS: i64 = 12_000;
pub const SCANNING_MS: i64 = 20_000;

pub const MATCH_SCORE: f64 = 0.80;
pub const MATCH_MARGIN: f64 = 0.08;
pub const CANDIDATE_FLOOR: f64 = 0.60;
pub const MAX_CANDIDATES: usize = 5;
pub const MAX_HITS: usize = 10;
pub const MAX_IMAGE_BYTES: usize = 45_000;

pub const CONDITIONS: [&str; 5] = ["NM", "SP", "MP", "PL", "Poor"];
pub const LANGUAGES: [&str; 16] = [
    "EN", "IT", "FR", "DE", "ES", "JP", "PT", "NL", "PL", "RU", "KO", "ZH", "ZHT", "ID", "TH",
    "VI",
];
pub const FINISHES: [&str; 6] = ["standard", "holo", "reverse", "stamped", "promo", "other"];
pub const GAMES: [&str; 3] = ["pokemon", "one_piece", "riftbound"];

/// One rate-limit window.
#[derive(Clone, Copy, Debug)]
pub struct Limit {
    pub max: i64,
    pub window_ms: i64,
}

pub const LIMIT_PAIR_FAIL_PER_IP: Limit = Limit { max: 8, window_ms: 10 * 60_000 };
pub const LIMIT_PAIR_TRY_PER_IP: Limit = Limit { max: 30, window_ms: 10 * 60_000 };
pub const LIMIT_PAIR_FAIL_GLOBAL: Limit = Limit { max: 300, window_ms: 10 * 60_000 };
pub const LIMIT_SESSION_START_PER_SELLER: Limit = Limit { max: 12, window_ms: 10 * 60_000 };
pub const LIMIT_PAIRING_REGEN_PER_SESSION: Limit = Limit { max: 30, window_ms: 10 * 60_000 };
pub const LIMIT_SCAN_PER_SESSION: Limit = Limit { max: 1200, window_ms: 10 * 60_000 };

/// `DEFAULT_BATCH_DEFAULTS`.
pub fn default_batch_defaults() -> Value {
    json!({
        "game": "pokemon",
        "language": "EN",
        "condition": "NM",
        "foilState": "standard",
        "firstEdition": false,
        "signed": false,
        "altered": false,
        "location": "",
        "stack": 1,
        "stackSize": 1,
        "startPosition": 1,
        "quantity": 1,
        "mergeRepeats": true,
    })
}

/// `cleanText` — control characters become spaces, then trim + cap.
pub fn clean_scan_text(value: &str, max: usize) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| if (ch as u32) < 0x20 || ch as u32 == 0x7f { ' ' } else { ch })
        .collect();
    clean_text(Some(&cleaned), max)
}

pub fn is_uuid(value: &str) -> bool {
    let text = value.trim();
    if text.len() != 36 {
        return false;
    }
    let bytes = text.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        match index {
            8 | 13 | 18 | 23 => {
                if *byte != b'-' {
                    return false;
                }
            }
            14 => {
                if !(b'1'..=b'8').contains(byte) {
                    return false;
                }
            }
            19 => {
                if !matches!(*byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B') {
                    return false;
                }
            }
            _ => {
                if !byte.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

pub fn is_pin(value: &str) -> bool {
    value.len() == 4 && value.chars().all(|c| c.is_ascii_digit())
}

pub fn random_pin() -> String {
    format!("{:04}", rand::thread_rng().gen_range(0..10_000))
}

pub fn random_secret(bytes: usize) -> String {
    use base64::Engine;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

pub fn sha256(value: &str) -> String {
    crate::crypto::sha256_hex(value.as_bytes())
}

pub fn clean_card_id(value: &str) -> String {
    let text = clean_text(Some(value), 80);
    if !text.is_empty() && text.len() <= 18 && text.chars().all(|c| c.is_ascii_digit()) {
        text
    } else {
        String::new()
    }
}

fn pick(list: &[&str], value: &str, fallback: &str) -> String {
    let text = value.trim();
    list.iter()
        .find(|entry| entry.eq_ignore_ascii_case(text))
        .map(|entry| entry.to_string())
        .unwrap_or_else(|| fallback.to_string())
}

fn clamp_int(value: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    match value {
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|n| n.is_finite())
            .map(|n| (n.trunc() as i64).clamp(min, max))
            .unwrap_or(fallback),
        Some(Value::String(text)) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(|n| (n.trunc() as i64).clamp(min, max))
            .unwrap_or(fallback),
        _ => fallback,
    }
}

fn has(map: &Map<String, Value>, key: &str) -> bool {
    map.contains_key(key)
}

/// `normalizeDefaults` — clamp one defaults patch over a base.
pub fn normalize_defaults(input: &Value, base: &Value) -> Value {
    let base_obj = base.as_object().cloned().unwrap_or_default();
    let base = if base_obj.is_empty() { default_batch_defaults() } else { base.clone() };
    let base_obj = base.as_object().cloned().unwrap_or_default();
    let src = input.as_object().cloned().unwrap_or_default();
    if src.is_empty() {
        return base;
    }

    let base_stack_size = base_obj.get("stackSize").and_then(Value::as_i64).unwrap_or(1);
    let stack_size = if has(&src, "stackSize") {
        clamp_int(src.get("stackSize"), 1, 9999, base_stack_size)
    } else {
        base_stack_size
    };
    let base_stack = base_obj.get("stack").and_then(Value::as_i64).unwrap_or(1);
    let mut stack = if has(&src, "stack") {
        clamp_int(src.get("stack"), 1, 9999, base_stack)
    } else {
        base_stack
    };
    let mut start_position = if has(&src, "startPosition") {
        clamp_int(src.get("startPosition"), 1, 9999, base_obj.get("startPosition").and_then(Value::as_i64).unwrap_or(1))
    } else {
        base_obj.get("startPosition").and_then(Value::as_i64).unwrap_or(1)
    };
    if stack_size == 1 {
        if has(&src, "startPosition") && !has(&src, "stack") {
            stack = clamp_int(src.get("startPosition"), 1, 9999, stack);
        }
        start_position = 1;
    } else {
        start_position = start_position.min(stack_size);
    }

    let str_of = |key: &str, fallback: &str| -> String {
        base_obj.get(key).and_then(Value::as_str).unwrap_or(fallback).to_string()
    };
    let boolean_of = |key: &str| -> bool {
        if has(&src, key) {
            src.get(key) == Some(&Value::Bool(true))
        } else {
            base_obj.get(key).and_then(Value::as_bool).unwrap_or(false)
        }
    };

    json!({
        "game": if has(&src, "game") {
            pick(&GAMES, src.get("game").and_then(Value::as_str).unwrap_or_default(), &str_of("game", "pokemon"))
        } else { str_of("game", "pokemon") },
        "language": if has(&src, "language") {
            pick(&LANGUAGES, src.get("language").and_then(Value::as_str).unwrap_or_default(), &str_of("language", "EN"))
        } else { str_of("language", "EN") },
        "condition": if has(&src, "condition") {
            pick(&CONDITIONS, src.get("condition").and_then(Value::as_str).unwrap_or_default(), &str_of("condition", "NM"))
        } else { str_of("condition", "NM") },
        "foilState": if has(&src, "foilState") {
            pick(&FINISHES, src.get("foilState").and_then(Value::as_str).unwrap_or_default(), &str_of("foilState", "standard"))
        } else { str_of("foilState", "standard") },
        "firstEdition": boolean_of("firstEdition"),
        "signed": boolean_of("signed"),
        "altered": boolean_of("altered"),
        "location": if has(&src, "location") {
            clean_scan_text(src.get("location").and_then(Value::as_str).unwrap_or_default(), 64)
        } else { str_of("location", "") },
        "stack": stack,
        "stackSize": stack_size,
        "startPosition": start_position,
        "quantity": if has(&src, "quantity") {
            clamp_int(src.get("quantity"), 1, 99, base_obj.get("quantity").and_then(Value::as_i64).unwrap_or(1))
        } else { base_obj.get("quantity").and_then(Value::as_i64).unwrap_or(1) },
        "mergeRepeats": if has(&src, "mergeRepeats") {
            src.get("mergeRepeats") != Some(&Value::Bool(false))
        } else { base_obj.get("mergeRepeats").and_then(Value::as_bool).unwrap_or(true) },
    })
}

/// `indexToStackPos`.
pub fn index_to_stack_pos(index: i64, stack_size: i64) -> (i64, i64) {
    let size = stack_size.max(1);
    let i = index.max(1);
    if size == 1 {
        return (i, 1);
    }
    ((i - 1) / size + 1, (i - 1) % size + 1)
}

/// `stackPosToIndex`.
pub fn stack_pos_to_index(stack: i64, position: i64, stack_size: i64) -> i64 {
    let size = stack_size.max(1);
    let s = stack.max(1);
    let p = position.max(1);
    if size == 1 {
        return s.max(p).min(9999);
    }
    (s - 1) * size + p.min(size)
}

/// `locationDefaultsText`.
pub fn location_defaults_text(defaults: &Value) -> String {
    let location = clean_text(defaults.get("location").and_then(Value::as_str), 64);
    if location.is_empty() {
        return String::new();
    }
    let size = defaults.get("stackSize").and_then(Value::as_i64).unwrap_or(1).max(1);
    let stack = defaults.get("stack").and_then(Value::as_i64).unwrap_or(1).max(1);
    if size == 1 {
        return format!("{location}·{stack}");
    }
    let pos = defaults.get("startPosition").and_then(Value::as_i64).unwrap_or(1).max(1);
    format!("{location}·{stack}·{pos}")
}

/// `slotText` — `·2` / `·2-4` / `·2·5` / `·2·5–3·2`.
pub fn slot_text(slot: &Value, stack_size: i64) -> String {
    let size = stack_size.max(1);
    let number = |value: Option<&Value>| value.and_then(Value::as_i64).unwrap_or(0);
    if size == 1 {
        let a = number(slot.get("stack").or_else(|| slot.get("start")));
        let b = number(
            slot
                .get("endStack")
                .or_else(|| slot.get("stack"))
                .or_else(|| slot.get("end")),
        );
        return if b > a { format!("·{a}-{b}") } else { format!("·{a}") };
    }
    let stack = slot.get("stack").and_then(Value::as_i64).unwrap_or(1);
    let end_stack = slot.get("endStack").and_then(Value::as_i64).unwrap_or(stack);
    let start = slot.get("start").and_then(Value::as_i64).unwrap_or(1);
    let end = slot.get("end").and_then(Value::as_i64).unwrap_or(start);
    if end_stack != stack {
        return format!("·{stack}·{start}–{end_stack}·{end}");
    }
    if end > start {
        format!("·{stack}·{start}-{end}")
    } else {
        format!("·{stack}·{start}")
    }
}

/// `defaultsLabel`.
pub fn defaults_label(defaults: &Value) -> String {
    let d = normalize_defaults(defaults, &default_batch_defaults());
    let foil = d.get("foilState").and_then(Value::as_str).unwrap_or("standard");
    let finish = if foil == "standard" {
        String::new()
    } else {
        let mut chars = foil.chars();
        match chars.next() {
            Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
            None => String::new(),
        }
    };
    let language = d.get("language").and_then(Value::as_str).unwrap_or("EN");
    let condition = d.get("condition").and_then(Value::as_str).unwrap_or("NM");
    let location = d.get("location").and_then(Value::as_str).unwrap_or("");
    let quantity = d.get("quantity").and_then(Value::as_i64).unwrap_or(1);
    [
        language.to_string(),
        condition.to_string(),
        finish,
        if d.get("firstEdition") == Some(&Value::Bool(true)) { "1st".into() } else { String::new() },
        if d.get("signed") == Some(&Value::Bool(true)) { "Signed".into() } else { String::new() },
        if d.get("altered") == Some(&Value::Bool(true)) { "Altered".into() } else { String::new() },
        if location.is_empty() { String::new() } else { location_defaults_text(&d) },
        if quantity > 1 { format!("Qty {quantity}") } else { String::new() },
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

/// `scanPhoneCatalog`.
pub fn scan_phone_catalog(game: &str) -> Value {
    match game {
        "one_piece" => json!({ "family": "one_piece", "variant": "singles", "catalogId": "one_piece_singles" }),
        "riftbound" => json!({ "family": "riftbound", "variant": "western", "catalogId": "riftbound_western" }),
        _ => json!({ "family": "pokemon", "variant": "generic", "catalogId": "pokemon_generic" }),
    }
}

/// `appendDefaults`.
pub fn append_defaults(history: &Value, defaults: &Value, version: i64, now_ms: i64, keep: usize) -> Value {
    let mut list = history.as_array().cloned().unwrap_or_default();
    list.push(json!({ "version": version, "changedAt": now_ms, "defaults": normalize_defaults(defaults, &default_batch_defaults()) }));
    if list.len() > keep {
        list = list.split_off(list.len() - keep);
    }
    Value::Array(list)
}

/// `pickDefaults` — the history entry in force at capture time.
pub fn pick_defaults(history: &Value, captured_at_ms: i64) -> Value {
    let list = history.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        return json!({ "version": 1, "changedAt": 0, "defaults": default_batch_defaults() });
    }
    let mut chosen = list[0].clone();
    for entry in &list {
        let changed = entry.get("changedAt").and_then(Value::as_i64).unwrap_or(0);
        let version = entry.get("version").and_then(Value::as_i64).unwrap_or(1);
        let chosen_version = chosen.get("version").and_then(Value::as_i64).unwrap_or(1);
        if changed <= captured_at_ms && version >= chosen_version {
            chosen = entry.clone();
        }
    }
    json!({
        "version": chosen.get("version").and_then(Value::as_i64).unwrap_or(1),
        "changedAt": chosen.get("changedAt").and_then(Value::as_i64).unwrap_or(0),
        "defaults": normalize_defaults(chosen.get("defaults").unwrap_or(&default_batch_defaults()), &default_batch_defaults()),
    })
}

/// `capturedAtServer` — clamp phone clock into `[floor, receivedAt]`.
pub fn captured_at_server(captured_at: f64, clock_offset_ms: f64, received_at_ms: i64, floor_ms: i64) -> i64 {
    if !captured_at.is_finite()
        || captured_at <= 0.0
        || !clock_offset_ms.is_finite()
        || clock_offset_ms.abs() > 24.0 * 3600_000.0
    {
        return received_at_ms;
    }
    let candidate = (captured_at + clock_offset_ms).round() as i64;
    candidate.clamp(floor_ms, received_at_ms)
}

/// `candidatesFromHits`.
pub fn candidates_from_hits(hits: &[Value], limit: usize) -> Vec<Value> {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for hit in hits.iter().take(MAX_HITS) {
        let card_id = clean_card_id(
            hit.get("public_id")
                .or_else(|| hit.get("publicId"))
                .or_else(|| hit.get("cardId"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        let Some(score) = hit.get("score").and_then(Value::as_f64).filter(|s| s.is_finite()) else {
            continue;
        };
        if card_id.is_empty() || seen.contains(&card_id) {
            continue;
        }
        seen.push(card_id.clone());
        out.push(json!({
            "cardId": card_id,
            "score": ((score.clamp(0.0, 1.0) * 10_000.0).round() / 10_000.0),
            "name": clean_scan_text(hit.get("name").or_else(|| hit.get("card_name")).and_then(Value::as_str).unwrap_or_default(), 160),
        }));
    }
    out.sort_by(|a, b| {
        pokoin_sort::cmp_f64_desc(a.get("score").and_then(Value::as_f64).unwrap_or(0.0), b.get("score").and_then(Value::as_f64).unwrap_or(0.0))
    });
    out.truncate(limit);
    out
}

/// `classifyRecognition`.
pub fn classify_recognition(hits: &[Value]) -> Value {
    let candidates = candidates_from_hits(hits, MAX_CANDIDATES);
    let top = candidates.first().cloned();
    let second = candidates.get(1).cloned();
    let top_score = top.as_ref().and_then(|c| c.get("score")).and_then(Value::as_f64).unwrap_or(0.0);
    if top.is_none() || top_score < CANDIDATE_FLOOR {
        let filtered: Vec<Value> = candidates
            .iter()
            .filter(|c| c.get("score").and_then(Value::as_f64).unwrap_or(0.0) >= 0.3)
            .cloned()
            .collect();
        return json!({ "state": "unmatched", "candidates": filtered, "topScore": top_score, "margin": 0.0 });
    }
    let margin = second
        .as_ref()
        .map(|s| {
            let second_score = s.get("score").and_then(Value::as_f64).unwrap_or(0.0);
            ((top_score - second_score) * 10_000.0).round() / 10_000.0
        })
        .unwrap_or(1.0);
    let plausible: Vec<Value> = candidates
        .iter()
        .filter(|c| c.get("score").and_then(Value::as_f64).unwrap_or(0.0) >= CANDIDATE_FLOOR)
        .cloned()
        .collect();
    if top_score >= MATCH_SCORE && margin >= MATCH_MARGIN {
        json!({ "state": "matched", "candidates": plausible, "topScore": top_score, "margin": margin })
    } else {
        json!({ "state": "ambiguous", "candidates": plausible, "topScore": top_score, "margin": margin })
    }
}

/// `deviceLabel`.
pub fn device_label(user_agent: &str, provided: &str) -> String {
    let clean = clean_scan_text(provided, 40);
    if !clean.is_empty() {
        return clean;
    }
    if user_agent.contains("iPhone") {
        return "iPhone".into();
    }
    if user_agent.contains("iPad") {
        return "iPad".into();
    }
    if user_agent.contains("Android") {
        return if user_agent.contains("Mobile") { "Android phone".into() } else { "Android tablet".into() };
    }
    "Phone".into()
}

/// Parsed `scan` event body (phone → store).
#[derive(Clone, Debug)]
pub struct ScanEvent {
    pub scan_event_id: String,
    pub client_sequence: i64,
    pub captured_at: f64,
    pub clock_offset_ms: f64,
    pub catalog: String,
    pub hits: Vec<Value>,
    pub image: Option<Vec<u8>>,
    pub timings: Value,
    pub printing_choice: String,
}

/// `decodeImage` — base64 JPEG, ≤ 45 KB, JPEG magic.
pub fn decode_image(value: Option<&Value>) -> ApiResult<Option<Vec<u8>>> {
    use base64::Engine;
    let Some(value) = value else { return Ok(None) };
    let text = match value {
        Value::Null => return Ok(None),
        Value::String(text) => text.clone(),
        _ => return Ok(None),
    };
    if text.is_empty() {
        return Ok(None);
    }
    let text = text.strip_prefix("data:image/jpeg;base64,").unwrap_or(&text);
    if !text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-')) {
        return Err(ApiError::bad_request("Image must be base64 JPEG."));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| ApiError::bad_request("Image must be base64 JPEG."))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(ApiError::new(413, "Scan image too large."));
    }
    if bytes.len() < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 {
        return Err(ApiError::bad_request("Image must be JPEG."));
    }
    Ok(Some(bytes))
}

/// `parseScanEvent`.
pub fn parse_scan_event(body: &Value) -> ApiResult<ScanEvent> {
    let scan_event_id = body
        .get("scanEventId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    if !is_uuid(&scan_event_id) {
        return Err(ApiError::bad_request("scanEventId must be a UUID."));
    }
    let client_sequence = match body.get("clientSequence") {
        Some(Value::Number(number)) => number.as_f64().map(|n| (n.trunc() as i64).clamp(0, 2_000_000_000)),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok().map(|n| (n.trunc() as i64).clamp(0, 2_000_000_000)),
        _ => None,
    };
    let Some(client_sequence) = client_sequence else {
        return Err(ApiError::bad_request("clientSequence is required."));
    };
    let recognition = body.get("recognition").filter(|value| value.is_object()).cloned().unwrap_or(json!({}));
    let hits: Vec<Value> = recognition
        .get("hits")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().take(MAX_HITS).cloned().collect())
        .unwrap_or_default();
    let mut timings = Map::new();
    if let Some(source) = body.get("timings").and_then(Value::as_object) {
        for key in ["captureToRequestMs", "identifyMs", "uploadQueuedMs", "attempt"] {
            if let Some(number) = source.get(key).and_then(Value::as_f64) {
                if number.is_finite() && number >= 0.0 && number < 3_600_000.0 {
                    timings.insert(key.to_string(), json!(number.round() as i64));
                }
            }
        }
    }
    Ok(ScanEvent {
        scan_event_id,
        client_sequence,
        captured_at: body.get("capturedAt").and_then(Value::as_f64).unwrap_or(0.0),
        clock_offset_ms: body.get("clockOffsetMs").and_then(Value::as_f64).unwrap_or(0.0),
        catalog: clean_scan_text(
            recognition.get("catalog").and_then(Value::as_str).unwrap_or_default(),
            64,
        ),
        hits,
        image: decode_image(body.get("image"))?,
        timings: Value::Object(timings),
        printing_choice: clean_card_id(
            body.pointer("/printing/cardId").and_then(Value::as_str).unwrap_or_default(),
        ),
    })
}

// ---------------------------------------------------------------------------
// Print family + merge rules
// ---------------------------------------------------------------------------

/// `printBucket` — canonical print-universe classification.
pub fn print_bucket(nationality: &str) -> &'static str {
    match nationality.trim().to_lowercase().as_str() {
        "" | "product" | "unknown" => "unknown",
        "japanese" | "ja" | "jp" => "japanese",
        "korean" | "ko" => "korean",
        "chinese" | "zh" | "cn" | "zht" => "chinese",
        "indonesian" | "id" => "indonesian",
        "thai" | "th" => "thai",
        "idth" => "idth",
        "western" | "european" | "eu" | "american" | "us" | "french" | "fr" | "german" | "de" => "western",
        _ => "unknown",
    }
}

/// `printFamily` — most specific tier first.
pub fn print_family(language: &str) -> Value {
    match language.trim().to_uppercase().as_str() {
        "JP" => json!({"id": "japanese", "tiers": [["japanese"], ["korean"]]}),
        "KO" => json!({"id": "korean", "tiers": [["korean"], ["japanese"]]}),
        "ZH" | "ZHT" => json!({"id": "chinese", "tiers": [["chinese"]]}),
        "ID" => json!({"id": "indonesian", "tiers": [["indonesian", "idth"]]}),
        "TH" => json!({"id": "thai", "tiers": [["thai", "idth"]]}),
        "VI" => json!({"id": "vietnamese", "tiers": []}),
        _ => json!({"id": "western", "tiers": [["western"]]}),
    }
}

/// `scopeCandidatesToPrintFamily`.
pub fn scope_candidates_to_print_family(candidates: &[Value], language: &str) -> Vec<Value> {
    let family = print_family(language);
    let tiers: Vec<Vec<String>> = family
        .get("tiers")
        .and_then(Value::as_array)
        .map(|tiers| {
            tiers
                .iter()
                .map(|tier| {
                    tier.as_array()
                        .map(|items| items.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default();
    let in_family: Vec<Value> = candidates
        .iter()
        .filter(|candidate| {
            let bucket = print_bucket(candidate.get("nationality").and_then(Value::as_str).unwrap_or_default());
            tiers.iter().any(|tier| tier.iter().any(|entry| entry == bucket))
        })
        .cloned()
        .collect();
    if in_family.is_empty() {
        candidates.to_vec()
    } else {
        in_family
    }
}

/// `provisionalCandidate`.
pub fn provisional_candidate(candidates: &[Value], language: &str) -> Option<Value> {
    let family = print_family(language);
    if let Some(tiers) = family.get("tiers").and_then(Value::as_array) {
        for tier in tiers {
            let Some(tier) = tier.as_array() else { continue };
            for candidate in candidates {
                let bucket = print_bucket(candidate.get("nationality").and_then(Value::as_str).unwrap_or_default());
                if tier.iter().any(|entry| entry.as_str() == Some(bucket)) {
                    return Some(candidate.clone());
                }
            }
        }
    }
    candidates.first().cloned()
}

/// `listingLanguageForPrint`.
pub fn listing_language_for_print(nationality: &str, preferred: &str) -> String {
    let bucket = print_bucket(nationality);
    let want = clean_text(Some(preferred), 8).to_uppercase();
    let want = if want.is_empty() { "EN".to_string() } else { want };
    match bucket {
        "japanese" => "JP".into(),
        "korean" => "KO".into(),
        "chinese" => if want == "ZHT" { "ZHT".into() } else { "ZH".into() },
        "indonesian" => "ID".into(),
        "thai" => "TH".into(),
        "idth" => if want == "TH" { "TH".into() } else { "ID".into() },
        "unknown" => want,
        "western" => {
            if ["JP", "KO", "ZH", "ZHT", "ID", "TH", "VI"].contains(&want.as_str()) {
                "EN".into()
            } else {
                want
            }
        }
        _ => want,
    }
}

/// `stackKey` — identity of one listing stack.
pub fn stack_key(row: &Value) -> String {
    let field = |keys: &[&str]| -> String {
        for key in keys {
            if let Some(value) = row.get(*key) {
                if !value.is_null() {
                    return match value {
                        Value::String(text) => text.clone(),
                        Value::Number(number) => number.to_string(),
                        Value::Bool(flag) => flag.to_string(),
                        _ => String::new(),
                    };
                }
            }
        }
        String::new()
    };
    let flag = |keys: &[&str]| -> &'static str {
        for key in keys {
            if row.get(*key) == Some(&Value::Bool(true)) {
                return "1";
            }
        }
        "0"
    };
    [
        clean_card_id(&field(&["cardId", "card_id"])),
        field(&["condition"]),
        field(&["language"]),
        field(&["foilState", "foil_state"]),
        flag(&["firstEdition", "first_edition"]).to_string(),
        flag(&["signed"]).to_string(),
        flag(&["altered"]).to_string(),
        flag(&["graded"]).to_string(),
        field(&["gradingCompany", "grading_company"]),
        field(&["grade"]),
        field(&["location"]).trim().to_lowercase(),
    ]
    .join("|")
}

/// `shouldMerge`.
pub fn should_merge(previous: &Value, recognition_state: &str, card_id: &str, snapshot: &Value) -> bool {
    if previous.is_null() || snapshot.is_null() || snapshot.get("mergeRepeats") == Some(&Value::Bool(false)) {
        return false;
    }
    if recognition_state != "matched" {
        return false;
    }
    if previous.get("status").and_then(Value::as_str) != Some("active") {
        return false;
    }
    let prev_state = previous
        .get("recognition_state")
        .or_else(|| previous.get("recognitionState"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let prev_ok = prev_state == "matched"
        || prev_state == "manual"
        || previous.get("reviewed") == Some(&Value::Bool(true));
    if !prev_ok {
        return false;
    }
    let next_row = json!({
        "cardId": card_id,
        "condition": snapshot.get("condition"),
        "language": snapshot.get("language"),
        "foilState": snapshot.get("foilState"),
        "firstEdition": snapshot.get("firstEdition"),
        "signed": snapshot.get("signed"),
        "altered": snapshot.get("altered"),
        "graded": false,
        "gradingCompany": "",
        "grade": "",
        "location": snapshot.get("location"),
    });
    stack_key(previous) == stack_key(&next_row) && !clean_card_id(card_id).is_empty()
}

/// `listingSlotEnd` — parse `box·stack[·pos]` / ranges.
pub fn listing_slot_end(raw: &str) -> Value {
    let text = raw.trim();
    if text.is_empty() {
        return json!({"box": "", "stack": Value::Null, "position": Value::Null});
    }
    let sep = text
        .char_indices()
        .find(|(_, ch)| *ch == '·' || *ch == '•')
        .map(|(index, _)| index);
    let Some(sep) = sep else {
        return json!({"box": text, "stack": Value::Null, "position": Value::Null});
    };
    let box_name = text[..sep].trim().to_string();
    let tail: String = text[sep + 1..].split_whitespace().collect::<Vec<_>>().join("");
    let numbers: Vec<i64> = tail
        .split(|ch| ch == '·' || ch == '•' || ch == '-' || ch == '–' || ch == '—')
        .filter_map(|part| part.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .collect();
    json!({
        "box": box_name,
        "stack": numbers.first().copied().map(Value::from).unwrap_or(Value::Null),
        "position": numbers.get(1).copied().map(Value::from).unwrap_or(Value::Null),
    })
}

/// `lastOccupiedIndex`.
pub fn last_occupied_index(stock_rows: &[Value], box_name: &str, stack_size: i64) -> i64 {
    let size = stack_size.max(1);
    let mut max = 0;
    for row in stock_rows {
        let end = listing_slot_end(row.get("location").and_then(Value::as_str).unwrap_or_default());
        if end.get("box").and_then(Value::as_str).unwrap_or_default() != box_name {
            continue;
        }
        let Some(stack) = end.get("stack").and_then(Value::as_i64) else { continue };
        let abs = if size == 1 {
            stack
        } else {
            match end.get("position").and_then(Value::as_i64) {
                None => stack * size,
                Some(position) => stack_pos_to_index(stack, position.min(size), size),
            }
        };
        if abs > max {
            max = abs;
        }
    }
    max
}

/// `boxSlots` — assign stack/position per location (no live-stock seeding).
pub fn box_slots(rows: &[Value]) -> Map<String, Value> {
    use std::collections::HashMap;
    let mut counters: HashMap<String, i64> = HashMap::new();
    let mut slots = Map::new();
    for row in rows {
        let loc = clean_text(row.get("location").and_then(Value::as_str), 64);
        if loc.is_empty() {
            continue;
        }
        let snap = row
            .get("defaults_snapshot")
            .or_else(|| row.get("defaultsSnapshot"))
            .cloned()
            .unwrap_or(json!({}));
        let size = snap.get("stackSize").and_then(Value::as_i64).unwrap_or(1).max(1);
        let stack = snap.get("stack").and_then(Value::as_i64).unwrap_or(1).max(1);
        let pos_raw = snap.get("startPosition").and_then(Value::as_i64).unwrap_or(1).max(1);
        let anchor = if snap.get("stack").is_some() || snap.get("stackSize").is_some() {
            stack_pos_to_index(stack, if size == 1 { 1 } else { pos_raw }, size)
        } else {
            pos_raw
        };
        let start_abs = (counters.get(&loc).copied().unwrap_or(0) + 1).max(anchor);
        let quantity = row.get("quantity").and_then(Value::as_i64).unwrap_or(1);
        let end_abs = start_abs + quantity - 1;
        let start = index_to_stack_pos(start_abs, size);
        let end = index_to_stack_pos(end_abs, size);
        let filled = size > 1 && (end.0 > start.0 || end.1 == size);
        let id = row.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        slots.insert(
            id,
            json!({
                "stack": start.0,
                "start": start.1,
                "end": end.1,
                "endStack": end.0,
                "stackSize": size,
                "filledStack": filled,
                "absStart": start_abs,
                "absEnd": end_abs,
            }),
        );
        counters.insert(loc, end_abs);
    }
    slots
}

/// `parseItemPatch` — whitelisted row columns a desk edit may set.
pub fn parse_item_patch(patch: &Value) -> ApiResult<Vec<(String, Value)>> {
    let src = patch.as_object().cloned().unwrap_or_default();
    let has = |key: &str| src.contains_key(key);
    let mut out: Vec<(String, Value)> = Vec::new();
    if has("cardId") {
        let card_id = clean_card_id(src.get("cardId").and_then(Value::as_str).unwrap_or_default());
        if card_id.is_empty() {
            return Err(ApiError::bad_request("cardId must be a public card id."));
        }
        out.push(("card_id".into(), json!(card_id)));
    }
    let pick_field = |key: &str, list: &[&str]| -> ApiResult<Value> {
        let raw = src.get(key).and_then(Value::as_str).unwrap_or_default();
        list.iter()
            .find(|entry| entry.eq_ignore_ascii_case(raw.trim()))
            .map(|entry| json!(entry))
            .ok_or_else(|| ApiError::bad_request(format!("{key} is invalid.")))
    };
    if has("condition") {
        out.push(("condition".into(), pick_field("condition", &CONDITIONS)?));
    }
    if has("language") {
        out.push(("language".into(), pick_field("language", &LANGUAGES)?));
    }
    if has("foilState") {
        out.push(("foil_state".into(), pick_field("foilState", &FINISHES)?));
    }
    for key in ["firstEdition", "signed", "altered", "graded"] {
        if has(key) {
            out.push((
                match key {
                    "firstEdition" => "first_edition",
                    other => other,
                }
                .into(),
                json!(src.get(key) == Some(&Value::Bool(true))),
            ));
        }
    }
    if has("gradingCompany") {
        let value = clean_scan_text(src.get("gradingCompany").and_then(Value::as_str).unwrap_or_default(), 80);
        out.push(("grading_company".into(), if value.is_empty() { Value::Null } else { json!(value) }));
    }
    if has("grade") {
        let value = clean_scan_text(src.get("grade").and_then(Value::as_str).unwrap_or_default(), 40);
        out.push(("grade".into(), if value.is_empty() { Value::Null } else { json!(value) }));
    }
    if has("certificationId") {
        let value = clean_scan_text(src.get("certificationId").and_then(Value::as_str).unwrap_or_default(), 120);
        out.push(("certification_id".into(), if value.is_empty() { Value::Null } else { json!(value) }));
    }
    if has("location") {
        out.push((
            "location".into(),
            json!(clean_scan_text(src.get("location").and_then(Value::as_str).unwrap_or_default(), 64)),
        ));
    }
    if has("quantity") {
        let quantity = src.get("quantity").and_then(Value::as_i64).unwrap_or(0);
        if !(1..=99).contains(&quantity) {
            return Err(ApiError::bad_request("Quantity must be between 1 and 99."));
        }
        out.push(("quantity".into(), json!(quantity)));
    }
    if has("pricePkn") {
        match src.get("pricePkn") {
            Some(Value::Null) => out.push(("price_pkn".into(), Value::Null)),
            Some(Value::String(text)) if text.is_empty() => out.push(("price_pkn".into(), Value::Null)),
            Some(value) => {
                let price = value.as_f64().unwrap_or(f64::NAN);
                if !price.is_finite() || price <= 0.0 || price > 1e9 {
                    return Err(ApiError::bad_request("Enter a valid PKN price."));
                }
                out.push(("price_pkn".into(), json!((price * 100.0).round() / 100.0)));
            }
            None => {}
        }
        out.push(("price_suggested".into(), json!(src.get("priceSuggested") == Some(&Value::Bool(true)))));
    }
    if has("sellerComment") {
        out.push((
            "seller_comment".into(),
            json!(clean_scan_text(src.get("sellerComment").and_then(Value::as_str).unwrap_or_default(), 500)),
        ));
    }
    if src.get("confirm") == Some(&Value::Bool(true)) {
        out.push(("reviewed".into(), json!(true)));
    }
    Ok(out)
}

/// `submitProblem` — `""` means the row may be submitted.
pub fn submit_problem(row: &Value, intent: &str) -> &'static str {
    if row.get("status").and_then(Value::as_str) != Some("active") {
        return "";
    }
    let card_id = clean_card_id(row.get("card_id").and_then(Value::as_str).unwrap_or_default());
    if card_id.is_empty() {
        return "no_printing";
    }
    let state = row.get("recognition_state").and_then(Value::as_str).unwrap_or("");
    if (state == "ambiguous" || state == "unmatched") && row.get("reviewed") != Some(&Value::Bool(true)) {
        return "needs_review";
    }
    if row.get("graded") == Some(&Value::Bool(true))
        && (row.get("grading_company").and_then(Value::as_str).unwrap_or("").is_empty()
            || row.get("grade").and_then(Value::as_str).unwrap_or("").is_empty())
    {
        return "grading_incomplete";
    }
    let quantity = row.get("quantity").and_then(Value::as_i64).unwrap_or(0);
    if !(1..=99).contains(&quantity) {
        return "bad_quantity";
    }
    if intent != "collection" {
        let price = row.get("price_pkn").and_then(Value::as_f64).unwrap_or(0.0);
        if !price.is_finite() || price <= 0.0 {
            return "no_price";
        }
    }
    ""
}

/// `itemView`.
pub fn item_view(row: &Value) -> Value {
    json!({
        "id": row.get("id"),
        "batchId": row.get("batch_id"),
        "seq": row.get("seq").and_then(Value::as_i64).unwrap_or(0),
        "position": row.get("position").and_then(Value::as_i64).unwrap_or(0),
        "status": row.get("status"),
        "mergedInto": row.get("merged_into").cloned().unwrap_or(Value::Null),
        "scanEventId": row.get("scan_event_id").cloned().unwrap_or(Value::Null),
        "sessionId": row.get("session_id").cloned().unwrap_or(Value::Null),
        "clientSequence": row.get("client_sequence").cloned().unwrap_or(Value::Null),
        "capturedAt": row.get("captured_at").cloned().unwrap_or(Value::Null),
        "receivedAt": row.get("received_at").cloned().unwrap_or(Value::Null),
        "recognitionState": row.get("recognition_state"),
        "recognition": row.get("recognition").cloned().unwrap_or(json!({})),
        "defaultsVersion": row.get("defaults_version").cloned().unwrap_or(Value::Null),
        "defaultsSnapshot": row.get("defaults_snapshot").cloned().unwrap_or(json!({})),
        "hasImage": row.get("has_image") == Some(&Value::Bool(true)),
        "reviewed": row.get("reviewed") == Some(&Value::Bool(true)),
        "cardId": row.get("card_id").and_then(Value::as_str).unwrap_or(""),
        "cardName": row.get("card_name").and_then(Value::as_str).unwrap_or(""),
        "setName": row.get("set_name").and_then(Value::as_str).unwrap_or(""),
        "collectorNumber": row.get("collector_number").and_then(Value::as_str).unwrap_or(""),
        "imageUrl": row.get("image_url").and_then(Value::as_str).unwrap_or(""),
        "nationality": row.get("nationality").and_then(Value::as_str).unwrap_or(""),
        "condition": row.get("condition"),
        "language": row.get("language"),
        "foilState": row.get("foil_state"),
        "firstEdition": row.get("first_edition") == Some(&Value::Bool(true)),
        "signed": row.get("signed") == Some(&Value::Bool(true)),
        "altered": row.get("altered") == Some(&Value::Bool(true)),
        "graded": row.get("graded") == Some(&Value::Bool(true)),
        "gradingCompany": row.get("grading_company").and_then(Value::as_str).unwrap_or(""),
        "grade": row.get("grade").and_then(Value::as_str).unwrap_or(""),
        "certificationId": row.get("certification_id").and_then(Value::as_str).unwrap_or(""),
        "location": row.get("location").and_then(Value::as_str).unwrap_or(""),
        "quantity": row.get("quantity").and_then(Value::as_i64).unwrap_or(0),
        "pricePkn": row.get("price_pkn").and_then(Value::as_f64),
        "priceSuggested": row.get("price_suggested") == Some(&Value::Bool(true)),
        "sellerComment": row.get("seller_comment").and_then(Value::as_str).unwrap_or(""),
        "listingId": row.get("listing_id").cloned().unwrap_or(Value::Null),
        "timings": row.get("timings").cloned().unwrap_or(json!({})),
        "updatedAt": row.get("updated_at").cloned().unwrap_or(Value::Null),
    })
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------


/// `batchView`.
pub fn batch_view(row: &Value) -> Value {
    json!({
        "id": row.get("id"),
        "status": row.get("status"),
        "title": row.get("title").cloned().unwrap_or(json!("")),
        "defaults": normalize_defaults(row.get("defaults").unwrap_or(&default_batch_defaults()), &default_batch_defaults()),
        "defaultsVersion": row.get("defaults_version").and_then(Value::as_i64).unwrap_or(1),
        "cursor": row.get("item_seq").and_then(Value::as_i64).unwrap_or(0),
        "submitResult": row.get("submit_result").cloned().unwrap_or(Value::Null),
        "createdAt": row.get("created_at").cloned().unwrap_or(Value::Null),
        "updatedAt": row.get("updated_at").cloned().unwrap_or(Value::Null),
        "submittedAt": row.get("submitted_at").cloned().unwrap_or(Value::Null),
    })
}

/// `sessionView` — phase from phone presence + recent scan.
pub fn session_view(row: &Value, now_ms: i64) -> Value {
    let status = row.get("status").and_then(Value::as_str).unwrap_or("waiting");
    let last_seen = ms_of(row.get("phone_last_seen_at"));
    let last_scan = ms_of(row.get("last_scan_at"));
    let mut phase = status.to_string();
    if status == "connected" {
        if last_seen > 0 && now_ms - last_seen >= PHONE_LOST_MS {
            phase = "lost".into();
        } else if last_scan > 0 && now_ms - last_scan < SCANNING_MS {
            phase = "scanning".into();
        }
    }
    if status == "ended" {
        phase = if row.get("end_reason").and_then(Value::as_str) == Some("expired") {
            "expired".into()
        } else {
            "completed".into()
        };
    }
    json!({
        "id": row.get("id"),
        "batchId": row.get("batch_id"),
        "status": status,
        "phase": phase,
        "endReason": row.get("end_reason").cloned().unwrap_or(Value::Null),
        "paused": row.get("paused") == Some(&Value::Bool(true)),
        "phoneLabel": row.get("phone_label").and_then(Value::as_str).unwrap_or(""),
        "phoneConnectedAt": row.get("phone_connected_at").cloned().unwrap_or(Value::Null),
        "phoneLastSeenAt": row.get("phone_last_seen_at").cloned().unwrap_or(Value::Null),
        "lastScanAt": row.get("last_scan_at").cloned().unwrap_or(Value::Null),
        "phoneScans": row.get("phone_scans").and_then(Value::as_i64).unwrap_or(0),
        "lastActivityAt": row.get("last_activity_at").cloned().unwrap_or(Value::Null),
        "version": row.get("version").and_then(Value::as_i64).unwrap_or(1),
        "createdAt": row.get("created_at").cloned().unwrap_or(Value::Null),
        "endedAt": row.get("ended_at").cloned().unwrap_or(Value::Null),
    })
}

/// `scanIdleActivityMs`.
pub fn scan_idle_activity_ms(row: &Value) -> Option<i64> {
    let last_scan = ms_of(row.get("last_scan_at"));
    if last_scan > 0 {
        return Some(last_scan);
    }
    let connected = ms_of(row.get("phone_connected_at"));
    if connected > 0 {
        Some(connected)
    } else {
        None
    }
}

/// `isScanIdleExpired`.
pub fn is_scan_idle_expired(row: &Value, now_ms: i64) -> bool {
    if row.get("status").and_then(Value::as_str) != Some("connected") {
        return false;
    }
    scan_idle_activity_ms(row)
        .map(|last| now_ms - last >= SCAN_IDLE_MS)
        .unwrap_or(false)
}

/// `isIdleExpired`.
pub fn is_idle_expired(row: &Value, now_ms: i64) -> bool {
    let status = row.get("status").and_then(Value::as_str).unwrap_or("");
    if status.is_empty() || status == "ended" || status == "connected" {
        return false;
    }
    let last = ms_of(row.get("last_activity_at"));
    last > 0 && now_ms - last >= SESSION_IDLE_MS
}

fn ms_of(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::String(text)) => crate::time_util::ms_from_iso(text).unwrap_or(0),
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_and_pin_rules() {
        assert!(is_uuid("9f8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d"));
        assert!(!is_uuid("9f8b7c6d-5e4f-4a3b-1c1d-0e9f8a7b6c5d")); // bad variant nibble
        assert!(!is_uuid("nope"));
        assert!(is_pin("0042"));
        assert!(!is_pin("42"));
        let pin = random_pin();
        assert_eq!(pin.len(), 4);
        assert!(is_pin(&pin));
        assert!(!random_secret(24).is_empty());
    }

    #[test]
    fn defaults_clamp_and_labels() {
        let base = default_batch_defaults();
        let merged = normalize_defaults(&json!({"condition": "sp", "stackSize": 5, "startPosition": 9}), &base);
        assert_eq!(merged["condition"], "SP");
        assert_eq!(merged["stackSize"], 5);
        assert_eq!(merged["startPosition"], 5);
        // size 1 folds a legacy startPosition into stack
        let legacy = normalize_defaults(&json!({"startPosition": 7, "stackSize": 1}), &base);
        assert_eq!(legacy["stack"], 7);
        assert_eq!(legacy["startPosition"], 1);
        let label = defaults_label(&json!({"location": "box1", "stack": 2, "stackSize": 1, "quantity": 3}));
        assert!(label.contains("box1·2"));
        assert!(label.contains("Qty 3"));
    }

    #[test]
    fn slot_math_and_text() {
        assert_eq!(index_to_stack_pos(5, 1), (5, 1));
        assert_eq!(index_to_stack_pos(5, 3), (2, 2));
        assert_eq!(stack_pos_to_index(2, 2, 3), 5);
        assert_eq!(stack_pos_to_index(2, 2, 1), 2);
        assert_eq!(slot_text(&json!({"stack": 2}), 1), "·2");
        assert_eq!(slot_text(&json!({"stack": 2, "endStack": 2, "start": 5, "end": 7}), 3), "·2·5-7");
        assert_eq!(slot_text(&json!({"stack": 2, "endStack": 3, "start": 5, "end": 2}), 3), "·2·5–3·2");
    }

    #[test]
    fn recognition_tiers() {
        let matched = classify_recognition(&[
            json!({"public_id": "11", "score": 0.95}),
            json!({"public_id": "22", "score": 0.6}),
        ]);
        assert_eq!(matched["state"], "matched");
        let ambiguous = classify_recognition(&[
            json!({"public_id": "11", "score": 0.82}),
            json!({"public_id": "22", "score": 0.80}),
        ]);
        assert_eq!(ambiguous["state"], "ambiguous");
        let unmatched = classify_recognition(&[json!({"public_id": "11", "score": 0.4})]);
        assert_eq!(unmatched["state"], "unmatched");
    }

    #[test]
    fn scan_event_validation() {
        let ok = parse_scan_event(&json!({
            "scanEventId": "9f8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d",
            "clientSequence": 3,
            "capturedAt": 1_700_000_000_000i64,
            "clockOffsetMs": 10,
            "recognition": {"catalog": "pokemon_generic", "hits": [{"public_id": "1", "score": 0.9}]},
            "timings": {"identifyMs": 12.6, "attempt": 1, "junk": 5},
        }))
        .unwrap();
        assert_eq!(ok.client_sequence, 3);
        assert_eq!(ok.hits.len(), 1);
        assert_eq!(ok.timings["identifyMs"], 13);
        assert!(ok.timings.get("junk").is_none());
        assert!(parse_scan_event(&json!({"clientSequence": 1})).is_err());
        // 1x1 JPEG magic + size checks
        assert!(decode_image(Some(&json!("not base64 !!"))).is_err());
        assert!(decode_image(Some(&json!(base64_of(&[0u8, 1, 2, 3])))).is_err());
    }

    fn base64_of(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn print_family_and_buckets() {
        assert_eq!(print_bucket("Japanese"), "japanese");
        assert_eq!(print_bucket("jp"), "japanese");
        assert_eq!(print_bucket(""), "unknown");
        assert_eq!(print_family("JP")["id"], "japanese");
        assert_eq!(print_family("EN")["id"], "western");
        assert_eq!(listing_language_for_print("japanese", "EN"), "JP");
        assert_eq!(listing_language_for_print("chinese", "ZHT"), "ZHT");
        assert_eq!(listing_language_for_print("western", "JP"), "EN");
        let candidates = vec![
            json!({"cardId": "1", "score": 0.7, "nationality": "japanese"}),
            json!({"cardId": "2", "score": 0.9, "nationality": "western"}),
        ];
        let scoped = scope_candidates_to_print_family(&candidates, "EN");
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0]["cardId"], "2");
        // JP family prefers its own print
        assert_eq!(provisional_candidate(&candidates, "JP").unwrap()["cardId"], "1");
    }

    #[test]
    fn merge_identity_rules() {
        let previous = json!({
            "status": "active", "recognition_state": "matched",
            "card_id": "77", "condition": "NM", "language": "EN", "foil_state": "standard",
            "first_edition": false, "signed": false, "altered": false, "graded": false, "location": "box1"
        });
        let snapshot = json!({
            "condition": "NM", "language": "EN", "foilState": "standard",
            "firstEdition": false, "signed": false, "altered": false,
            "location": "box1", "mergeRepeats": true
        });
        assert!(should_merge(&previous, "matched", "77", &snapshot));
        assert!(!should_merge(&previous, "ambiguous", "77", &snapshot));
        assert!(!should_merge(&previous, "matched", "78", &snapshot));
        let mut no_merge = snapshot.clone();
        no_merge["mergeRepeats"] = json!(false);
        assert!(!should_merge(&previous, "matched", "77", &no_merge));
        let reviewed = json!({"status": "active", "recognition_state": "manual", "card_id": "77",
            "condition": "NM", "language": "EN", "foil_state": "standard", "location": "box1"});
        assert!(should_merge(&reviewed, "matched", "77", &snapshot));
    }

    #[test]
    fn item_patch_and_submit_problem() {
        let patch = parse_item_patch(&json!({"condition": "sp", "quantity": 3, "pricePkn": 10.239, "confirm": true})).unwrap();
        assert!(patch.contains(&("condition".into(), json!("SP"))));
        assert!(patch.contains(&("quantity".into(), json!(3))));
        assert!(patch.contains(&("price_pkn".into(), json!(10.24))));
        assert!(patch.contains(&("reviewed".into(), json!(true))));
        assert!(parse_item_patch(&json!({"quantity": 0})).is_err());
        assert!(parse_item_patch(&json!({"condition": "XX"})).is_err());

        let ready = json!({"status": "active", "card_id": "77", "recognition_state": "matched", "quantity": 1, "price_pkn": 5.0});
        assert_eq!(submit_problem(&ready, "list"), "");
        let no_price = json!({"status": "active", "card_id": "77", "recognition_state": "matched", "quantity": 1});
        assert_eq!(submit_problem(&no_price, "list"), "no_price");
        assert_eq!(submit_problem(&no_price, "collection"), "");
        let unreviewed = json!({"status": "active", "card_id": "77", "recognition_state": "ambiguous", "quantity": 1, "price_pkn": 5.0});
        assert_eq!(submit_problem(&unreviewed, "list"), "needs_review");
        let no_printing = json!({"status": "active", "recognition_state": "matched", "quantity": 1, "price_pkn": 5.0});
        assert_eq!(submit_problem(&no_printing, "list"), "no_printing");
    }

    #[test]
    fn box_slots_assign_stack_and_position() {
        let rows = vec![
            json!({"id": "a", "location": "box1", "quantity": 1, "defaults_snapshot": {"stack": 1, "stackSize": 1, "startPosition": 1}}),
            json!({"id": "b", "location": "box1", "quantity": 2, "defaults_snapshot": {"stack": 1, "stackSize": 1, "startPosition": 1}}),
            json!({"id": "c", "location": "box2", "quantity": 1, "defaults_snapshot": {"stack": 1, "stackSize": 3, "startPosition": 3}}),
        ];
        let slots = box_slots(&rows);
        assert_eq!(slots["a"]["absStart"], 1);
        assert_eq!(slots["b"]["absStart"], 2);
        assert_eq!(slots["b"]["absEnd"], 3);
        assert_eq!(slots["c"]["filledStack"], true);
    }

    #[test]
    fn expiry_and_views() {
        let now = 1_700_000_000_000i64;
        let connected = json!({
            "status": "connected",
            "last_scan_at": crate::time_util::iso_from_ms(now - SCAN_IDLE_MS - 1),
            "phone_connected_at": crate::time_util::iso_from_ms(now - 1_000_000),
        });
        assert!(is_scan_idle_expired(&connected, now));
        let waiting = json!({
            "status": "waiting",
            "last_activity_at": crate::time_util::iso_from_ms(now - SESSION_IDLE_MS - 1),
        });
        assert!(is_idle_expired(&waiting, now));
        let view = session_view(&json!({"id": "s1", "batch_id": "b1", "status": "waiting", "version": 2}), now);
        assert_eq!(view["phase"], "waiting");
        assert_eq!(view["version"], 2);
        let batch = batch_view(&json!({"id": "b1", "status": "open", "item_seq": 4}));
        assert_eq!(batch["cursor"], 4);
        assert_eq!(batch["defaults"]["language"], "EN");
    }

    #[test]
    fn captured_at_clamps_phone_skew() {
        assert_eq!(captured_at_server(1000.0, 0.0, 5000, 0), 1000);
        assert_eq!(captured_at_server(9000.0, 0.0, 5000, 0), 5000);
        assert_eq!(captured_at_server(1000.0, -5000.0, 5000, 2000), 2000);
        assert_eq!(captured_at_server(f64::NAN, 0.0, 5000, 0), 5000);
        assert_eq!(captured_at_server(1000.0, 1e18, 5000, 0), 5000);
    }
}
