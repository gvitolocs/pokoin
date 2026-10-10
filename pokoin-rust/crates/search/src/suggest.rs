use icu_collator::options::CollatorOptions;
use icu_collator::CollatorBorrowed;
use icu_locale_core::locale;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

const VARIANT_WORDS: &[&str] = &[
    "ex", "v", "vmax", "vstar", "gx", "lvx", "lv", "mega", "break", "radiant", "shining", "shiny",
    "prime", "tagteam",
];
const PRODUCT_WORDS: &[&str] = &[
    "collection",
    "pin",
    "coin",
    "tin",
    "box",
    "bundle",
    "deck",
    "etb",
    "pack",
    "premium",
    "merchandise",
    "blister",
    "case",
    "display",
    "figure",
    "plush",
];

static COLLECTOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[^0-9])[0-9]{1,4}[a-z]?/[0-9]{1,4}([^0-9]|$)").unwrap());

pub fn clean_text(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

pub fn parse_limit(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    let Some(raw) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return fallback;
    };
    let Ok(limit) = raw.parse::<f64>() else {
        return fallback;
    };
    if !limit.is_finite() {
        return fallback;
    }
    (limit.trunc() as i64).clamp(1, max)
}

pub fn suggest_meili_hit_limit(group_limit: i64) -> i64 {
    (group_limit * 8).clamp(48, 96)
}

pub fn clean_print_language(value: &str) -> String {
    let raw = value.trim().to_ascii_lowercase();
    if raw.is_empty() || raw == "all" {
        return "all".into();
    }
    match raw.as_str() {
        "eu" => "western".into(),
        "jp" | "ja" | "ko" | "korean" => "japanese".into(),
        "zh" | "cn" | "zht" => "chinese".into(),
        _ => {
            let bucket = print_bucket(&raw);
            if bucket == "korean" {
                "japanese".into()
            } else if matches!(bucket.as_str(), "western" | "japanese" | "chinese") {
                bucket
            } else {
                "all".into()
            }
        }
    }
}

fn print_bucket(nationality: &str) -> String {
    let value = nationality.trim().to_ascii_lowercase();
    if value.is_empty() || value == "product" || value == "unknown" {
        return "unknown".into();
    }
    match value.as_str() {
        "japanese" | "ja" | "jp" => "japanese".into(),
        "korean" | "ko" => "korean".into(),
        "chinese" | "zh" | "cn" | "zht" => "chinese".into(),
        "indonesian" | "id" => "indonesian".into(),
        "thai" | "th" => "thai".into(),
        "idth" => "idth".into(),
        "western" | "european" | "eu" | "american" | "us" | "french" | "fr" | "german" | "de" => {
            "western".into()
        }
        _ => "unknown".into(),
    }
}

fn fold_diacritics(value: &str) -> String {
    value
        .nfkd()
        .filter(|ch| !('\u{0300}'..='\u{036f}').contains(ch))
        .collect()
}

fn name_words(value: &str) -> Vec<String> {
    let folded = value.to_lowercase().replace_vstar().replace_lvx();
    folded
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

trait MechanicFold {
    fn replace_vstar(&self) -> String;
    fn replace_lvx(&self) -> String;
}

impl MechanicFold for String {
    fn replace_vstar(&self) -> String {
        let mut out = String::new();
        let lower = self.as_str();
        let chars: Vec<char> = lower.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == 'v' {
                let mut j = i + 1;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j < chars.len() && (chars[j] == '-' || chars[j] == '.') {
                    j += 1;
                    while j < chars.len() && chars[j].is_whitespace() {
                        j += 1;
                    }
                }
                if chars.get(j..j + 4) == Some(&['s', 't', 'a', 'r']) {
                    out.push_str("vstar");
                    i = j + 4;
                    continue;
                }
            }
            out.push(chars[i]);
            i += 1;
        }
        out
    }

    fn replace_lvx(&self) -> String {
        let chars: Vec<char> = self.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < chars.len() {
            if chars.get(i..i + 2) == Some(&['l', 'v']) {
                let mut j = i + 2;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j < chars.len() && chars[j] == '.' {
                    j += 1;
                }
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j < chars.len() && chars[j] == 'x' {
                    out.push_str("lvx");
                    i = j + 1;
                    continue;
                }
            }
            out.push(chars[i]);
            i += 1;
        }
        out
    }
}

fn compact_name(value: &str) -> String {
    name_words(value).join("")
}

fn is_variant_prefix(token: &str) -> bool {
    !token.is_empty()
        && VARIANT_WORDS
            .iter()
            .any(|word| *word == token || word.starts_with(token))
}

fn leftover_query_tokens(query: &str, group_name: &str) -> Vec<String> {
    let mut unused = name_words(group_name);
    let mut leftover = Vec::new();
    for word in name_words(query) {
        if let Some(index) = unused.iter().position(|name_word| {
            name_word == &word || name_word.starts_with(&word) || word.starts_with(name_word)
        }) {
            unused.remove(index);
        } else {
            leftover.push(word);
        }
    }
    leftover
}

fn suggest_group_tier(query: &str, group_name: &str) -> i32 {
    let q = compact_name(query);
    let n = compact_name(group_name);
    if q.is_empty() || n.is_empty() {
        return 50;
    }
    let n_words = name_words(group_name);
    let name_is_variant = n_words
        .iter()
        .any(|word| VARIANT_WORDS.contains(&word.as_str()));
    let name_is_product = n_words
        .iter()
        .any(|word| PRODUCT_WORDS.contains(&word.as_str()));
    let leftover = leftover_query_tokens(query, group_name);
    let leftover_is_variant = leftover.iter().any(|token| is_variant_prefix(token));
    if n == q {
        return 0;
    }
    if n.starts_with(&q) {
        if name_is_product {
            return 4;
        }
        if name_is_variant {
            return if leftover.is_empty() || leftover_is_variant {
                1
            } else {
                3
            };
        }
        return 1;
    }
    if q.starts_with(&n) {
        if leftover_is_variant {
            return 5;
        }
        if name_is_product {
            return 4;
        }
        if !name_is_variant {
            return 2;
        }
        return 3;
    }
    6
}

fn nickname_tier(query: &str, nicknames: &[String]) -> i32 {
    let q = compact_name(query);
    if q.is_empty() {
        return 50;
    }
    let mut best = 50;
    for nickname in nicknames {
        let n = compact_name(nickname);
        if n.is_empty() {
            continue;
        }
        if n == q {
            return 0;
        }
        if q.len() >= 4 && n.starts_with(&q) && best > 1 {
            best = 1;
        }
    }
    best
}

fn slug_part(value: &str) -> String {
    let folded = fold_diacritics(value).trim().to_lowercase();
    let mut dashed = String::new();
    let mut prev_dash = false;
    for ch in folded.chars() {
        if ch.is_ascii_alphanumeric() {
            dashed.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            dashed.push('-');
            prev_dash = true;
        }
    }
    dashed.trim_matches('-').to_string()
}

fn canonical_path(
    hit: &Value,
    id: &str,
    name: &str,
    number: &str,
    set_name: &str,
    rarity: &str,
) -> String {
    let stored = hit
        .get("canonical_path")
        .or_else(|| hit.get("canonicalPath"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if stored.starts_with("/marketplace/") && stored.contains("/cards/") {
        return stored.to_string();
    }
    let card_id = id.parse::<i64>().unwrap_or(0);
    let public_id = if card_id > 0 && card_id % 2 == 1 {
        card_id * 2
    } else {
        card_id
    };
    if public_id <= 0 {
        return String::new();
    }
    let collector = {
        let text = number.trim().trim_start_matches('#').trim();
        if text.is_empty() || text == id {
            String::new()
        } else {
            text.to_string()
        }
    };
    let rarity_part = if rarity.trim().is_empty() {
        "Card"
    } else {
        rarity
    };
    let slug = [rarity_part, name, collector.as_str(), set_name]
        .into_iter()
        .map(slug_part)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        String::new()
    } else {
        format!("/marketplace/en/cards/{public_id}/{slug}")
    }
}

fn prefer_full_image(hit: &Value) -> String {
    let keys = ["cdn_image_url", "image_url", "cdnImageUrl", "imageUrl"];
    let values: Vec<String> = keys
        .iter()
        .filter_map(|key| {
            hit.get(*key)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
        })
        .map(str::to_string)
        .collect();
    values
        .iter()
        .find(|url| {
            !url.contains("/previews/")
                && !url.to_ascii_lowercase().contains("/preview_")
                && !url.contains("preview_")
        })
        .cloned()
        .or_else(|| values.first().cloned())
        .unwrap_or_default()
}

fn text_field(hit: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = hit.get(*key).and_then(|v| v.as_str()) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn map_printing(hit: &Value) -> Value {
    let id = text_field(hit, &["card_id", "id"]);
    let name = text_field(hit, &["name"]);
    let set_name = text_field(hit, &["set_name", "expansion_name", "set"]);
    let number = text_field(hit, &["card_number", "number"]);
    let rarity = text_field(hit, &["rarity"]);
    let href = canonical_path(hit, &id, &name, &number, &set_name, &rarity);
    let mut printing = Map::new();
    printing.insert("id".into(), json!(id));
    printing.insert("card_id".into(), json!(id));
    printing.insert("name".into(), json!(name));
    printing.insert("set".into(), json!(set_name));
    printing.insert("set_name".into(), json!(set_name));
    printing.insert("number".into(), json!(number));
    printing.insert("card_number".into(), json!(number));
    printing.insert("rarity".into(), json!(rarity));
    printing.insert("image".into(), json!(prefer_full_image(hit)));
    printing.insert("href".into(), json!(href));
    printing.insert("canonicalPath".into(), json!(href));
    printing.insert("canonical_path".into(), json!(href));
    if COLLECTOR.is_match(&number.to_lowercase()) {
        printing.insert("item_kind".into(), json!("single"));
        printing.insert("product_type".into(), json!("card"));
    }
    if let Some(aliases) = hit.get("expansion_aliases").and_then(|v| v.as_array()) {
        let values: Vec<String> = aliases
            .iter()
            .filter_map(|v| {
                v.as_str()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)
            })
            .collect();
        if !values.is_empty() {
            printing.insert("_aliases".into(), json!(values));
        }
    }
    let rank = hit
        .get("_rankingScore")
        .or_else(|| hit.get("_rank"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    if rank.is_finite() && rank > 0.0 {
        printing.insert("_rank".into(), json!(rank));
    }
    let nationality = text_field(hit, &["nationality"]).to_lowercase();
    if !nationality.is_empty() {
        printing.insert("nationality".into(), json!(nationality));
    } else if let Some(bucket) = hit.get("effective_print_bucket").and_then(|v| v.as_str()) {
        let bucket = bucket.trim().to_lowercase();
        if !bucket.is_empty() && bucket != "unknown" {
            printing.insert("nationality".into(), json!(bucket));
        }
    }
    Value::Object(printing)
}

fn public_printing(printing: &Value) -> Value {
    let mut next = printing.as_object().cloned().unwrap_or_default();
    next.remove("_rank");
    next.remove("_meiliIndex");
    next.remove("_aliases");
    Value::Object(next)
}

pub fn group_suggest_hits(
    hits: &[Value],
    max_groups: i64,
    max_printings: i64,
    query: &str,
) -> Vec<Value> {
    let mut groups: Vec<Value> = Vec::new();
    let mut index_by_name: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for hit in hits {
        let printing = map_printing(hit);
        let id = printing
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let name = text_field(hit, &["name_group"]).trim().to_string();
        let name = if name.is_empty() {
            printing
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .trim()
                .to_string()
        } else {
            name
        };
        let name = if name.is_empty() { id.clone() } else { name };
        let slot = if let Some(slot) = index_by_name.get(&name).copied() {
            slot
        } else {
            let slot = groups.len();
            groups.push(json!({ "name": name, "printings": [], "_weight": 0, "_nicknames": [] }));
            index_by_name.insert(name, slot);
            slot
        };
        let weight = hit
            .get("search_weight")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let current = groups[slot]
            .get("_weight")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        groups[slot]["_weight"] = json!(current.max(weight));
        if let Some(nicks) = hit.get("nicknames").and_then(|v| v.as_array()) {
            let existing = groups[slot]
                .get_mut("_nicknames")
                .and_then(|v| v.as_array_mut());
            if let Some(existing) = existing {
                for nick in nicks {
                    let text = nick.as_str().unwrap_or("").trim();
                    if text.is_empty() {
                        continue;
                    }
                    if !existing.iter().any(|row| row.as_str() == Some(text)) {
                        existing.push(json!(text));
                    }
                }
            }
        }
        let printings = groups[slot]
            .get_mut("printings")
            .and_then(|v| v.as_array_mut())
            .unwrap();
        if printings
            .iter()
            .any(|row| row.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
        {
            continue;
        }
        printings.push(printing);
    }
    let cap = max_printings.max(1) as usize;
    let group_cap = max_groups.max(1) as usize;
    groups.retain(|group| {
        group
            .get("printings")
            .and_then(|v| v.as_array())
            .is_some_and(|rows| !rows.is_empty())
    });
    groups.sort_by(|left, right| group_order(query, left, right));
    groups.truncate(group_cap);
    groups
        .into_iter()
        .map(|group| {
            let name = group
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut printings = group
                .get("printings")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            printings.sort_by(|left, right| printing_order(query, &name, left, right));
            printings.truncate(cap);
            let mut out = Map::new();
            out.insert("name".into(), json!(name));
            if let Some(nicks) = group.get("_nicknames").and_then(|v| v.as_array()) {
                if !nicks.is_empty() {
                    out.insert("_nicknames".into(), Value::Array(nicks.clone()));
                }
            }
            out.insert("printings".into(), Value::Array(printings));
            Value::Object(out)
        })
        .collect()
}

/// Node `localeCompare` on the Pi uses the en_GB collation, including punctuation.
fn locale_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
        CollatorBorrowed::try_new(locale!("en-GB").into(), CollatorOptions::default())
            .expect("en-GB collator")
    });
    COLLATOR.compare(left, right)
}

fn group_order(query: &str, left: &Value, right: &Value) -> std::cmp::Ordering {
    if query.trim().is_empty() {
        return std::cmp::Ordering::Equal;
    }
    let left_name = left.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let right_name = right.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let left_nicks = string_list(left.get("_nicknames"));
    let right_nicks = string_list(right.get("_nicknames"));
    let left_tier = suggest_group_tier(query, left_name).min(nickname_tier(query, &left_nicks));
    let right_tier = suggest_group_tier(query, right_name).min(nickname_tier(query, &right_nicks));
    let left_len = compact_name(left_name).len();
    let right_len = compact_name(right_name).len();
    let left_weight = -left.get("_weight").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let right_weight = -right.get("_weight").and_then(|v| v.as_f64()).unwrap_or(0.0);
    left_tier
        .cmp(&right_tier)
        .then(left_len.cmp(&right_len))
        .then(
            pokoin_sort::cmp_f64(left_weight, right_weight),
        )
        .then(locale_cmp(left_name, right_name))
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn printing_score(query: &str, group_name: &str, printing: &Value) -> i32 {
    let leftover = leftover_query_tokens(query, group_name);
    if leftover.is_empty() {
        return 0;
    }
    let name_tokens = name_words(printing.get("name").and_then(|v| v.as_str()).unwrap_or(""));
    let set_text = printing
        .get("set")
        .or_else(|| printing.get("set_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let set_tokens = name_words(set_text);
    let set_compact = compact_name(set_text);
    let aliases = string_list(printing.get("_aliases"))
        .into_iter()
        .map(|v| compact_name(&v))
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();
    let number = printing
        .get("number")
        .or_else(|| printing.get("card_number"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    let mut score = 0;
    for token in leftover {
        let variantish = is_variant_prefix(&token);
        let name_hit = name_tokens
            .iter()
            .any(|word| word == &token || word.starts_with(&token));
        let number_hit = number.contains(&token);
        let alias_exact = aliases
            .iter()
            .any(|alias| alias == &token || alias == &compact_name(&token));
        let alias_prefix =
            token.len() >= 2 && aliases.iter().any(|alias| alias.starts_with(&token));
        let set_compact_hit = token.len() >= 2 && set_compact.starts_with(&token);
        let set_hit = set_tokens
            .iter()
            .any(|word| word == &token || word.starts_with(&token));
        if name_hit {
            score -= 100;
        } else if alias_exact {
            score -= 80;
        } else if alias_prefix {
            score -= 50;
        } else if number_hit {
            score -= 40;
        } else if (set_hit || set_compact_hit) && variantish {
            score += 25;
        } else if set_compact_hit {
            score -= 40;
        } else if set_hit && token.len() >= 2 {
            score -= 10;
        }
    }
    score
}

fn printing_order(
    query: &str,
    group_name: &str,
    left: &Value,
    right: &Value,
) -> std::cmp::Ordering {
    if query.trim().is_empty() {
        return std::cmp::Ordering::Equal;
    }
    let left_number = left.get("number").and_then(|v| v.as_str()).unwrap_or("");
    let right_number = right.get("number").and_then(|v| v.as_str()).unwrap_or("");
    printing_score(query, group_name, left)
        .cmp(&printing_score(query, group_name, right))
        .then(locale_cmp(left_number, right_number))
}

fn rank_points(printing: &Value) -> i64 {
    let rank = printing
        .get("_rank")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    if !rank.is_finite() || rank <= 0.0 {
        0
    } else {
        (rank * 10_000.0).round() as i64
    }
}

fn effective_bucket(printing: &Value) -> String {
    let explicit = print_bucket(
        printing
            .get("nationality")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    if explicit != "unknown" {
        explicit
    } else {
        "unknown".into()
    }
}

fn western_cmp(left: &(usize, Value), right: &(usize, Value)) -> std::cmp::Ordering {
    let points = rank_points(&left.1).cmp(&rank_points(&right.1));
    if points != std::cmp::Ordering::Equal {
        return left.0.cmp(&right.0);
    }
    let left_western = if effective_bucket(&left.1) == "western" {
        0
    } else {
        1
    };
    let right_western = if effective_bucket(&right.1) == "western" {
        0
    } else {
        1
    };
    left_western.cmp(&right_western).then(left.0.cmp(&right.0))
}

fn prefer_western(groups: Vec<Value>) -> Vec<Value> {
    groups
        .into_iter()
        .map(|group| {
            let mut indexed: Vec<(usize, Value)> = group
                .get("printings")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .enumerate()
                .collect();
            // Same comparator as applySuggestPrintPriority. It is not a total
            // order, and only V8/CPython powersort reproduces Node's order.
            let _ = crate::powersort::timsort(&mut indexed, &mut |left, right| {
                Ok::<bool, ()>(western_cmp(left, right) == std::cmp::Ordering::Less)
            });
            let mut next = group.as_object().cloned().unwrap_or_default();
            next.insert(
                "printings".into(),
                Value::Array(indexed.into_iter().map(|(_, printing)| printing).collect()),
            );
            Value::Object(next)
        })
        .collect()
}

fn filter_groups(groups: Vec<Value>, print_language: &str) -> Vec<Value> {
    let bucket = clean_print_language(print_language);
    if bucket == "all" {
        return groups;
    }
    groups
        .into_iter()
        .filter_map(|group| {
            let printings: Vec<Value> = group
                .get("printings")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|printing| {
                    let have = effective_bucket(printing);
                    if bucket == "japanese" {
                        have == "japanese" || have == "korean"
                    } else {
                        have == bucket
                    }
                })
                .collect();
            if printings.is_empty() {
                None
            } else {
                let mut next = group.as_object().cloned().unwrap_or_default();
                next.insert("printings".into(), Value::Array(printings));
                Some(Value::Object(next))
            }
        })
        .collect()
}

fn cap_rows(groups: Vec<Value>, max_rows: usize) -> Vec<Value> {
    let mut left = max_rows.max(1);
    let mut out = Vec::new();
    for group in groups {
        if left == 0 {
            break;
        }
        let printings: Vec<Value> = group
            .get("printings")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .take(left)
            .collect();
        if printings.is_empty() {
            continue;
        }
        left -= printings.len();
        let mut next = Map::new();
        next.insert(
            "name".into(),
            group.get("name").cloned().unwrap_or(json!("")),
        );
        if let Some(localized) = group.get("localized_name") {
            next.insert("localized_name".into(), localized.clone());
        }
        next.insert(
            "printings".into(),
            Value::Array(printings.iter().map(public_printing).collect()),
        );
        out.push(Value::Object(next));
    }
    out
}

fn apply_priority(groups: Vec<Value>, print_language: &str, max_rows: usize) -> Vec<Value> {
    let next = if clean_print_language(print_language) == "all" {
        prefer_western(groups)
    } else {
        filter_groups(groups, print_language)
    };
    cap_rows(next, max_rows)
}

pub fn catalog_sql_needed(groups: &[Value], language: &str) -> (bool, bool) {
    let lang = language.trim().to_ascii_lowercase();
    let nationality = groups.iter().any(|group| {
        group
            .get("printings")
            .and_then(|v| v.as_array())
            .is_some_and(|rows| {
                rows.iter().any(|printing| {
                    printing
                        .get("nationality")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .is_empty()
                })
            })
    });
    (nationality, !lang.is_empty() && lang != "en")
}

#[derive(Clone, Debug)]
pub struct SuggestHitPage {
    pub hits: Vec<Value>,
    pub estimated_total: u64,
    pub print_filter_applied: bool,
}

pub struct SuggestParts {
    pub query: String,
    pub game: String,
    pub search_language: String,
    pub print_language: String,
    pub hydrate: bool,
    pub group_limit: i64,
    pub row_limit: i64,
    pub hit_limit: i64,
    pub page: SuggestHitPage,
}

pub fn assemble_pokemon_suggest(parts: &SuggestParts, groups: Vec<Value>) -> Value {
    let print_language = clean_print_language(&parts.print_language);
    let filtered = if print_language == "all" {
        groups.clone()
    } else {
        filter_groups(groups.clone(), &print_language)
    };
    let filtered_count: usize = filtered
        .iter()
        .map(|group| {
            group
                .get("printings")
                .and_then(|v| v.as_array())
                .map(|rows| rows.len())
                .unwrap_or(0)
        })
        .sum();
    let shown_groups = apply_priority(groups, &print_language, parts.row_limit.max(1) as usize);
    let shown: usize = shown_groups
        .iter()
        .map(|group| {
            group
                .get("printings")
                .and_then(|v| v.as_array())
                .map(|rows| rows.len())
                .unwrap_or(0)
        })
        .sum();
    let global = parts.page.estimated_total;
    let count = if print_language == "all" || parts.page.print_filter_applied {
        global.max(shown as u64)
    } else {
        (filtered_count as u64).max(shown as u64)
    };
    json!({
        "query": parts.query,
        "game": parts.game,
        "groups": shown_groups,
        "shown": shown,
        "count": count,
        "globalCount": global,
        "printLanguage": print_language,
        "hydrated": parts.hydrate,
        "candidateLimit": parts.hit_limit,
        "exhaustive": parts.page.hits.len() as u64 >= global,
    })
}

pub fn empty_suggest(query: &str, game: &str, reason: &str) -> Value {
    json!({
        "query": query,
        "groups": [],
        "count": 0,
        "shown": 0,
        "reason": reason,
        "game": game,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_base_name_before_variant_and_strips_private_fields() {
        let hits = vec![
            json!({
                "card_id": "10",
                "name": "Pikachu GX",
                "name_group": "Pikachu GX",
                "card_number": "035/147",
                "rarity": "Rare",
                "set_name": "Burning Shadows",
                "canonical_path": "/marketplace/en/cards/10/rare-pikachu-gx",
                "cdn_image_url": "https://cdn.pokoin.com/10.jpg",
                "search_weight": 1,
                "nationality": "western",
                "_rankingScore": 0.9
            }),
            json!({
                "card_id": "11",
                "name": "Pikachu",
                "name_group": "Pikachu",
                "card_number": "58/102",
                "rarity": "Common",
                "set_name": "Base Set",
                "canonical_path": "/marketplace/en/cards/11/common-pikachu",
                "cdn_image_url": "https://cdn.pokoin.com/previews/11.jpg",
                "image_url": "https://cdn.pokoin.com/11.jpg",
                "search_weight": 3,
                "nationality": "japanese",
                "_rankingScore": 0.8
            }),
        ];
        let groups = group_suggest_hits(&hits, 20, 96, "pikachu");
        let body = assemble_pokemon_suggest(
            &SuggestParts {
                query: "pikachu".into(),
                game: "pokemon".into(),
                search_language: "en".into(),
                print_language: "all".into(),
                hydrate: false,
                group_limit: 20,
                row_limit: 20,
                hit_limit: 96,
                page: SuggestHitPage {
                    hits: hits.clone(),
                    estimated_total: 2,
                    print_filter_applied: false,
                },
            },
            groups,
        );
        let names: Vec<_> = body["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["Pikachu", "Pikachu GX"]);
        let printing = &body["groups"][0]["printings"][0];
        assert_eq!(printing["item_kind"], "single");
        assert_eq!(printing["product_type"], "card");
        assert_eq!(printing["image"], "https://cdn.pokoin.com/11.jpg");
        assert!(printing.get("_rank").is_none());
        assert!(printing.get("_aliases").is_none());
        assert_eq!(body["shown"], 2);
        assert_eq!(body["candidateLimit"], 96);
    }

    #[test]
    fn en_gb_collation_matches_node_locale_compare() {
        assert_eq!(
            locale_cmp(
                "Cosmos Holo | Canada Costco Exclusive 14/181",
                "Cosmos Holo Promo |019/113",
            ),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            locale_cmp("Illustration Rare | TG11/TG30", "Illustration Rare 188/167"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            locale_cmp("Pikachu ex", "Pikachu EX"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn western_timsort_matches_node_permutation() {
        let rows: Vec<Value> =
            serde_json::from_str(include_str!("../fixtures/eevee-i-rows.json")).unwrap();
        let expected: Vec<String> =
            serde_json::from_str(include_str!("../fixtures/eevee-i-order.json")).unwrap();
        let mut indexed: Vec<(usize, Value)> = rows
            .iter()
            .map(|row| {
                let index = row["index"].as_u64().unwrap() as usize;
                let printing = json!({
                    "_rank": row["points"].as_i64().unwrap() as f64 / 10_000.0,
                    "nationality": if row["western"].as_i64() == Some(0) { "western" } else { "japanese" },
                });
                (index, printing)
            })
            .collect();
        let _ = crate::powersort::timsort(&mut indexed, &mut |left, right| {
            Ok::<bool, ()>(western_cmp(left, right) == std::cmp::Ordering::Less)
        });
        let ids: Vec<String> = expected; // length check against permutation of indexes
        let got: Vec<usize> = indexed.iter().map(|(index, _)| *index).collect();
        let want: Vec<usize> = {
            let by_id: std::collections::HashMap<String, usize> = rows
                .iter()
                .map(|row| {
                    (
                        row["id"].as_str().unwrap().to_string(),
                        row["index"].as_u64().unwrap() as usize,
                    )
                })
                .collect();
            ids.iter().map(|id| by_id[id]).collect()
        };
        assert_eq!(got, want);
    }

    #[test]
    fn empty_and_limits_match_node() {
        assert_eq!(parse_limit(None, 20, 24), 20);
        assert_eq!(parse_limit(Some("0"), 20, 24), 1);
        assert_eq!(parse_limit(Some("99"), 20, 24), 24);
        assert_eq!(suggest_meili_hit_limit(20), 96);
        assert_eq!(clean_print_language("ko"), "japanese");
        assert_eq!(clean_text("  eevee  ", 80), "eevee");
    }
}
