//! Text primitives of `api/pokoin-assistant.js` and `api/_slug.js`:
//! `cleanText`, `cleanObject`, `normalizeIntentText`, `slugPart`,
//! `sanitizePokoEmoji`, `escapeHtml`, `levenshteinDistance`, `formatPkn`,
//! `doubledCardId`, `cardNameMatchesHint`, `uniqueLimited`.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;

/// `String(value || '')` for a JSON value: null/absent/0/false/'' -> ''.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(true) => "true".to_owned(),
        Value::Bool(false) => String::new(), // `false || ''` is ''
        Value::Number(number) => {
            // `0 || ''` and `NaN || ''` are '' in JS.
            let as_f64 = number.as_f64().unwrap_or(f64::NAN);
            if as_f64 == 0.0 {
                String::new()
            } else {
                js_number_to_string(as_f64)
            }
        }
        Value::String(text) => text.clone(),
        // Objects stringify to '[object Object]', arrays join with ','; the
        // assistant only reads scalar fields, so keep the scalar fast path and
        // mirror JS for the rest.
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// JavaScript `String(number)` for the values the assistant sees.
pub fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    if value.abs() >= 1e21 {
        // JS switches to exponential notation ("1e+21").
        let exponential = format!("{value:e}");
        match exponential.split_once('e') {
            Some((mantissa, exponent)) => {
                let sign = if exponent.starts_with('-') { "" } else { "+" };
                format!("{mantissa}e{sign}{exponent}")
            }
            None => exponential,
        }
    } else if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        let mut text = format!("{value}");
        if text.ends_with(".0") {
            text.truncate(text.len() - 2);
        }
        text
    }
}

fn whitespace_before_newline() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+\n").expect("static regex"))
}

/// Compile-once regex cache for the ported JS patterns. JS `\b` is the ASCII
/// word boundary; ported patterns write `(?-u:\b)` explicitly.
pub(crate) fn re(pattern: &'static str) -> Regex {
    static CACHE: OnceLock<std::sync::Mutex<HashMap<&'static str, Regex>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut guard = match cache.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(compiled) = guard.get(pattern) {
        return compiled.clone();
    }
    let compiled =
        Regex::new(pattern).unwrap_or_else(|error| panic!("bad regex {pattern}: {error}"));
    guard.insert(pattern, compiled.clone());
    compiled
}

/// `cleanText(value, maxLength)`: `String(value || '').trim().replace(/\s+\n/g,
/// '\n').slice(0, maxLength)`. Slicing follows chars (JS slices UTF-16 code
/// units; the difference only shows for emoji straddling the cut).
pub fn clean_text(value: &Value, max_length: usize) -> String {
    let raw = js_string(value);
    let trimmed = raw.trim();
    let normalized = whitespace_before_newline().replace_all(trimmed, "\n");
    normalized.chars().take(max_length).collect()
}

pub fn clean_text_str(value: &str, max_length: usize) -> String {
    clean_text(&Value::String(value.to_owned()), max_length)
}

fn fold_diacritics(value: &str) -> String {
    let decomposed: String = value.nfkd().collect();
    decomposed
        .chars()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect()
}

/// `slugPart` of `_slug.js`: fold, trim, lowercase, non-alphanumerics to `-`.
pub fn slug_part(value: &str) -> String {
    let folded = fold_diacritics(value);
    let lowered = folded.trim().to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut last_dash = false;
    for c in lowered.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_owned()
}

/// `isSensitiveContextKey`.
pub fn is_sensitive_context_key(key: &str) -> bool {
    let normalized = key.to_lowercase();
    normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized == "code"
        || normalized == "state"
}

/// `cleanObject(value, { maxEntries, keyLength, valueLength })`.
pub fn clean_object(
    value: &Value,
    max_entries: usize,
    key_length: usize,
    value_length: usize,
) -> Map<String, Value> {
    let mut output = Map::new();
    let Some(entries) = value.as_object() else {
        return output;
    };
    for (raw_key, raw_value) in entries {
        let key = clean_text(&Value::String(raw_key.clone()), key_length);
        if key.is_empty() || is_sensitive_context_key(&key) {
            continue;
        }
        let text = clean_text(raw_value, value_length);
        if !text.is_empty() {
            output.insert(key, Value::String(text));
        }
        if output.len() >= max_entries {
            break;
        }
    }
    output
}

/// `escapeHtml`.
pub fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// `levenshteinDistance`.
pub fn levenshtein_distance(left: &str, right: &str) -> usize {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0usize; right.len() + 1];
    for row in 1..=left.len() {
        current[0] = row;
        for col in 1..=right.len() {
            current[col] = if left[row - 1] == right[col - 1] {
                previous[col - 1]
            } else {
                previous[col - 1].min(current[col - 1]).min(previous[col]) + 1
            };
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

/// `normalizeIntentText`: NFKD, strip combining marks, remove apostrophes,
/// lowercase.
pub fn normalize_intent_text(value: &str) -> String {
    let stripped = fold_diacritics(value);
    stripped.replace(['’', '\''], "").to_lowercase()
}

/// `uniqueLimited(values, limit)`.
pub fn unique_limited(values: &[String], limit: usize) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut output = Vec::new();
    for value in values {
        let clean = clean_text(&Value::String(value.clone()), 80);
        let key = normalize_intent_text(&clean);
        if clean.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        output.push(clean);
        if output.len() >= limit {
            break;
        }
    }
    output
}

const POKO_EMOJI_REPLACEMENTS: [(&str, &str); 22] = [
    ("🃏", "⭐"),
    ("🫧", "✨"),
    ("🫠", "😊"),
    ("⛓️", "🛠️"),
    ("⛓", "🛠️"),
    ("🦊", "🛠️"),
    ("📒", "📚"),
    ("✅", "⭐"),
    ("🐣", "😊"),
    ("🔑", "🛠️"),
    ("💪", "⭐"),
    ("💕", "💛"),
    ("😌", "😊"),
    ("📨", "🛠️"),
    ("💌", "💛"),
    ("🧭", "📚"),
    ("⚠️", "🛠️"),
    ("⚠", "🛠️"),
    ("🟢", "⭐"),
    ("🟡", "⭐"),
    ("⚡", "⭐"),
    ("💗", "💛"),
];

const POKO_SAFE_ASTRAL: [char; 4] = ['😊', '📚', '🛠', '💛'];

fn cardtrader_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\bCardTrader\b").expect("static regex"))
}

/// `sanitizePokoEmoji`.
pub fn sanitize_poko_emoji(value: &str) -> String {
    let mut sanitized = value.to_owned();
    for (emoji, replacement) in POKO_EMOJI_REPLACEMENTS {
        if sanitized.contains(emoji) {
            sanitized = sanitized.replace(emoji, replacement);
        }
    }
    let sanitized = cardtrader_regex().replace_all(&sanitized, "marketplace partner");
    let filtered: String = sanitized
        .chars()
        .filter(|c| *c != '\u{FFFD}' && (*c < '\u{10000}' || POKO_SAFE_ASTRAL.contains(c)))
        .collect();
    filtered.replace('\u{200d}', "")
}

/// `formatPkn`: `toLocaleString('en-US', { maximumFractionDigits: 2 })`.
pub fn format_pkn(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_owned();
    }
    // half-expand rounding at 2 fraction digits, then trim trailing zeros.
    let scaled = (value * 100.0).round() as i128;
    let negative = scaled < 0;
    let scaled = scaled.unsigned_abs();
    let int_part = (scaled / 100).to_string();
    let mut grouped = String::new();
    for (index, digit) in int_part.chars().enumerate() {
        if index > 0 && (int_part.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    let frac = scaled % 100;
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    out.push_str(&grouped);
    if frac > 0 {
        let mut frac_text = format!("{frac:02}");
        if frac_text.ends_with('0') {
            frac_text.pop();
        }
        out.push('.');
        out.push_str(&frac_text);
    }
    out
}

/// `doubledCardId`.
pub fn doubled_card_id(value: &str) -> String {
    let id = value.trim();
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return String::new();
    }
    match id.parse::<u128>() {
        Ok(parsed) if parsed > 0 => (parsed * 2).to_string(),
        _ => String::new(),
    }
}

/// `cardNameMatchesHint`.
pub fn card_name_matches_hint(card_name: &str, name_hint: &str) -> bool {
    let hint = name_hint.trim().to_lowercase();
    if hint.is_empty() {
        return true;
    }
    let card_name = card_name.trim().to_lowercase();
    if card_name.is_empty() {
        return false;
    }
    // `hint.replace(/\s+(ex|v|vmax|vstar|gx)$/i, '').trim()`
    let hint_base = strip_mechanic_suffix(&hint);
    card_name == hint
        || card_name.starts_with(&format!("{hint} "))
        || card_name == hint_base
        || card_name.starts_with(&format!("{hint_base} "))
        || hint == card_name
        || hint.starts_with(&format!("{card_name} "))
}

fn strip_mechanic_suffix(hint: &str) -> String {
    for suffix in ["vstar", "vmax", "ex", "v", "gx"] {
        let with_space = format!(" {suffix}");
        if let Some(base) = hint.strip_suffix(&with_space) {
            return base.trim().to_owned();
        }
    }
    hint.to_owned()
}

/// A JSON object is required; everything else behaves like `{}` in JS.
pub fn as_object_or_empty(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clean_text_trims_and_slices() {
        assert_eq!(
            clean_text(&json!("  hello \n  world "), 4000),
            "hello\n  world"
        );
        assert_eq!(clean_text(&json!("abcdefgh"), 4), "abcd");
        assert_eq!(clean_text(&Value::Null, 10), "");
        assert_eq!(clean_text(&json!(""), 10), "");
        // `0 || ''` is '' in JS.
        assert_eq!(clean_text(&json!(0), 10), "");
        assert_eq!(clean_text(&json!(12), 10), "12");
        assert_eq!(clean_text(&json!(true), 10), "true");
        assert_eq!(clean_text(&json!(false), 10), "");
        // `/\s+\n/g` — greedy `\s+` swallows the inner newline too.
        assert_eq!(clean_text(&json!("a   \n\nb"), 100), "a\nb");
        assert_eq!(clean_text(&json!("a  \n b"), 100), "a\n b");
        // emoji survive a char-boundary slice
        assert_eq!(clean_text(&json!("ab✨cd"), 3), "ab✨");
    }

    #[test]
    fn js_number_strings() {
        assert_eq!(js_number_to_string(1.0), "1");
        assert_eq!(js_number_to_string(-3.5), "-3.5");
        assert_eq!(js_number_to_string(0.0), "0");
        assert_eq!(js_number_to_string(1e21), "1e+21");
    }

    #[test]
    fn slug_part_matches_node() {
        // From api/_slug.js semantics.
        assert_eq!(slug_part("Pokémon Card 151"), "pokemon-card-151");
        assert_eq!(slug_part("  My -- Cool Card!  "), "my-cool-card");
        assert_eq!(slug_part("Vanillite"), "vanillite");
        assert_eq!(slug_part(""), "");
        assert_eq!(slug_part("Ünïcodé Nàme"), "unicode-name");
        assert_eq!(slug_part("a1 2b"), "a1-2b");
    }

    #[test]
    fn normalize_intent_text_folds() {
        assert_eq!(normalize_intent_text("Pokémon è lì"), "pokemon e li");
        assert_eq!(normalize_intent_text("doesn’t work"), "doesnt work");
        assert_eq!(normalize_intent_text("PIÙ caro"), "piu caro");
    }

    #[test]
    fn sensitive_keys() {
        assert!(is_sensitive_context_key("accessToken"));
        assert!(is_sensitive_context_key("SECRET"));
        assert!(is_sensitive_context_key("code"));
        assert!(is_sensitive_context_key("state"));
        assert!(!is_sensitive_context_key("query"));
    }

    #[test]
    fn clean_object_drops_sensitive_and_caps_entries() {
        let value = json!({
            "keep": "a",
            "token": "hidden",
            "": "dropped",
            "empty": "",
            "b": "c"
        });
        let cleaned = clean_object(&value, 12, 60, 240);
        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned["keep"], json!("a"));
        let capped = clean_object(&json!({"a":"1","b":"2","c":"3"}), 2, 60, 240);
        assert_eq!(capped.len(), 2);
    }

    #[test]
    fn levenshtein_matches() {
        assert_eq!(levenshtein_distance("kitten", "sitting"), 3);
        assert_eq!(levenshtein_distance("card", "cad"), 1);
        assert_eq!(levenshtein_distance("", "abc"), 3);
    }

    #[test]
    fn sanitize_poko_emoji_replaces_and_strips() {
        // Replacement table order and astral filtering.
        assert_eq!(sanitize_poko_emoji("hello 🦊 world"), "hello 🛠️ world");
        assert_eq!(sanitize_poko_emoji("x ⚠️ y"), "x 🛠️ y");
        // CardTrader is reworded.
        assert_eq!(
            sanitize_poko_emoji("via CARDTRADER and cardtrader"),
            "via marketplace partner and marketplace partner"
        );
        assert_eq!(sanitize_poko_emoji("safe 😊🛠💛📚"), "safe 😊🛠💛📚");
        assert_eq!(sanitize_poko_emoji("dragon 🐉 gone"), "dragon  gone");
        assert_eq!(sanitize_poko_emoji("zwj\u{200d}j"), "zwjj");
        assert_eq!(sanitize_poko_emoji("bad \u{FFFD} gone"), "bad  gone");
    }

    #[test]
    fn format_pkn_grouping() {
        assert_eq!(format_pkn(0.0), "0");
        assert_eq!(format_pkn(1234.0), "1,234");
        assert_eq!(format_pkn(1234.5), "1,234.5");
        assert_eq!(format_pkn(1234.567), "1,234.57");
        assert_eq!(format_pkn(42.0), "42");
        assert_eq!(format_pkn(f64::NAN), "0");
    }

    #[test]
    fn doubled_ids() {
        assert_eq!(doubled_card_id("248856"), "497712");
        assert_eq!(doubled_card_id(" 12 "), "24");
        assert_eq!(doubled_card_id("0"), "");
        assert_eq!(doubled_card_id("abc"), "");
        assert_eq!(doubled_card_id(""), "");
    }

    #[test]
    fn hint_matching() {
        assert!(card_name_matches_hint("Charizard", ""));
        assert!(card_name_matches_hint("Charizard", "charizard"));
        assert!(card_name_matches_hint("Charizard V", "charizard"));
        assert!(card_name_matches_hint("Mew ex", "mew"));
        assert!(!card_name_matches_hint("", "mew"));
        assert!(!card_name_matches_hint("Blastoise", "charizard"));
    }

    #[test]
    fn unique_limited_dedupes() {
        let values: Vec<String> = vec![
            "Pikachu".into(),
            " pikachu ".into(),
            "Rayquaza".into(),
            "".into(),
        ];
        assert_eq!(unique_limited(&values, 8), vec!["Pikachu", "Rayquaza"]);
        assert_eq!(unique_limited(&["a".into(), "b".into()], 1), vec!["a"]);
    }

    #[test]
    fn escape_html_entities() {
        assert_eq!(escape_html("a<b>&\"'"), "a&lt;b&gt;&amp;&quot;&#39;");
    }
}
