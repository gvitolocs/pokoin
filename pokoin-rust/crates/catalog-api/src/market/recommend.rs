//! Pure ranking of `_recommend.js`: buyer affinity over the buyable pool,
//! the seller parcel shelf, co-cart and trending rails, and the offer cascade.

use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::shared::js;

pub const DEFAULT_LIMIT: usize = 18;
const MAX_SPECIES: i64 = 1025;

static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

/// `String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)`.
pub fn text_of(value: Option<&Value>, max: usize) -> String {
    let raw = match value {
        None | Some(Value::Null) => String::new(),
        Some(v) => js::js_string(v),
    };
    js::slice_utf16(WS.replace_all(&raw, " ").trim(), max)
}

pub fn text_str(value: &str, max: usize) -> String {
    js::slice_utf16(WS.replace_all(value, " ").trim(), max)
}

fn key_of(value: Option<&Value>) -> String {
    text_of(value, 240).to_lowercase()
}

fn nullish<'a>(card: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| card.get(*k)).find(|v| !v.is_null())
}

/// `cardIdOf(card)`.
pub fn card_id_of(card: &Value) -> String {
    text_of(nullish(card, &["card_id", "cardId", "id"]), 24)
}

pub fn species(card: &Value) -> i64 {
    let n = js::number(card.get("pokedex_num")).trunc();
    if js::is_safe_integer(n) && n > 0.0 && (n as i64) <= MAX_SPECIES { n as i64 } else { 0 }
}

fn truthy_or<'a>(card: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| card.get(*k)).find(|v| js::truthy(Some(v)))
}

fn artist_of(card: &Value) -> String {
    text_of(truthy_or(card, &["artist", "illustrator"]), 120)
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `parseIds(value, max)` over already-split parts.
pub fn parse_ids<I: IntoIterator<Item = String>>(parts: I, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for part in parts {
        let id = text_str(&part, 24);
        if !is_digits(&id) || !seen.insert(id.clone()) {
            continue;
        }
        out.push(id);
        if out.len() >= max {
            break;
        }
    }
    out
}

/// `parseIds(commaString, max)`; `null` is `''`.
pub fn parse_id_param(value: Option<&str>, max: usize) -> Vec<String> {
    parse_ids(value.unwrap_or("").split(',').map(str::to_owned), max)
}

#[derive(Clone)]
pub struct Entry {
    pub weight: f64,
    pub label: String,
}

/// Insertion-ordered map (JS `Map`).
pub struct OrderedMap<K> {
    order: Vec<K>,
    entries: HashMap<K, Entry>,
}

impl<K: Eq + Hash + Clone> OrderedMap<K> {
    fn new() -> Self {
        Self { order: Vec::new(), entries: HashMap::new() }
    }

    pub fn get(&self, key: &K) -> Option<&Entry> {
        self.entries.get(key)
    }

    pub fn keys(&self) -> impl Iterator<Item = &K> {
        self.order.iter()
    }

    pub fn values(&self) -> impl Iterator<Item = &Entry> {
        self.order.iter().filter_map(|k| self.entries.get(k))
    }

    fn add(&mut self, key: K, weight: f64, label: String) {
        if let Some(current) = self.entries.get_mut(&key) {
            current.weight += weight;
        } else {
            self.order.push(key.clone());
            self.entries.insert(key, Entry { weight, label });
        }
    }
}

pub struct Affinity {
    pub versions: OrderedMap<String>,
    pub species: OrderedMap<i64>,
    pub names: OrderedMap<String>,
    pub artists: OrderedMap<String>,
    pub sets: OrderedMap<String>,
    pub size: usize,
}

static SPECIES_LABEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+(ex|EX|GX|V|VMAX|VSTAR|BREAK|LEGEND|Prime|LV\.X)(?-u:\b).*$").unwrap());
static PARCEL_LABEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+(ex|EX|GX|V|VMAX|VSTAR)(?-u:\b).*$").unwrap());

fn signal_weight(source: &str) -> f64 {
    match source {
        "cart" => 3.0,
        "bought" => 2.5,
        "watch" => 2.0,
        "recent" => 1.5,
        _ => 1.0,
    }
}

fn add_text(map: &mut OrderedMap<String>, key: String, weight: f64, label: String) {
    if key.is_empty() {
        return;
    }
    let label = if label.is_empty() { key.clone() } else { label };
    map.add(key, weight, label);
}

/// `buildAffinity([{ card, source }])`.
pub fn build_affinity(signals: &[(Option<&Value>, &str)]) -> Affinity {
    let mut affinity = Affinity {
        versions: OrderedMap::new(),
        species: OrderedMap::new(),
        names: OrderedMap::new(),
        artists: OrderedMap::new(),
        sets: OrderedMap::new(),
        size: 0,
    };
    let mut position: HashMap<&str, usize> = HashMap::new();
    for (card, source) in signals {
        let Some(card) = card else { continue };
        let at = *position.get(source).unwrap_or(&0);
        position.insert(source, at + 1);
        let weight = signal_weight(source) / (1.0 + at as f64 / 6.0);
        let name = text_of(card.get("name"), 240);
        add_text(&mut affinity.versions, text_of(card.get("version"), 40), weight, name.clone());
        let kind = species(card);
        if kind != 0 {
            let stripped = SPECIES_LABEL.replacen(&name, 1, "").into_owned();
            let label = if stripped.is_empty() { name.clone() } else { stripped };
            affinity.species.add(kind, weight, if label.is_empty() { kind.to_string() } else { label });
        }
        add_text(&mut affinity.names, name.to_lowercase(), weight, name.clone());
        let artist = artist_of(card);
        add_text(&mut affinity.artists, artist.to_lowercase(), weight, artist.clone());
        let set = text_of(truthy_or(card, &["set_name", "setName"]), 240);
        add_text(&mut affinity.sets, set.to_lowercase(), weight, set);
        affinity.size += 1;
    }
    affinity
}

pub struct Score {
    pub score: f64,
    pub reason: String,
    pub matches: Vec<&'static str>,
}

/// `affinityScore(card, affinity)`.
pub fn affinity_score(card: &Value, affinity: &Affinity) -> Score {
    let mut hits: Vec<(&'static str, f64, String)> = Vec::new();
    if let Some(e) = affinity.versions.get(&text_of(card.get("version"), 40)) {
        hits.push(("version", e.weight * 2.5, "Same artwork as a card you looked at".into()));
    }
    if let Some(e) = affinity.species.get(&species(card)) {
        hits.push(("species", e.weight * 4.0, format!("More {}", e.label)));
    }
    if let Some(e) = affinity.names.get(&key_of(card.get("name"))) {
        hits.push(("name", e.weight * 3.0, format!("Other printings of {}", e.label)));
    }
    if let Some(e) = affinity.artists.get(&artist_of(card).to_lowercase()) {
        hits.push(("artist", e.weight * 2.0, format!("Art by {}", e.label)));
    }
    if let Some(e) = affinity.sets.get(&key_of(card.get("set_name"))) {
        hits.push(("set", e.weight * 0.75, format!("From {}", e.label)));
    }
    if hits.is_empty() {
        return Score { score: 0.0, reason: String::new(), matches: Vec::new() };
    }
    hits.sort_by(|a, b| pokoin_sort::cmp_f64_desc(a.1, b.1));
    Score { score: hits.iter().map(|h| h.1).sum(), reason: hits[0].2.clone(), matches: hits.iter().map(|h| h.0).collect() }
}

fn hot_of(card: &Value, window_24h: bool) -> f64 {
    let n = js::number(card.get(if window_24h { "hot_24h" } else { "hot_7d" }));
    if n.is_finite() && n > 0.0 { n } else { 0.0 }
}

fn popularity(card: &Value, max_hot: f64) -> f64 {
    if !(max_hot > 0.0) {
        return 0.0;
    }
    hot_of(card, false).ln_1p() / max_hot.ln_1p()
}

fn max_hot_of(pool: &[Value]) -> f64 {
    pool.iter().fold(0.0, |m, c| f64::max(m, hot_of(c, false)))
}

pub struct Ranked {
    pub card: Value,
    pub score: f64,
    pub reason: String,
    pub offer: Option<Value>,
    pub price: f64,
}

fn cmp_desc(a: f64, b: f64) -> std::cmp::Ordering {
    pokoin_sort::cmp_f64_desc(a, b)
}

pub fn rank_by_affinity(pool: &[Value], affinity: &Affinity, want: impl Fn(&[&str]) -> bool, exclude: &HashSet<String>, limit: usize) -> Vec<Ranked> {
    let max_hot = max_hot_of(pool);
    let mut scored = Vec::new();
    for card in pool {
        let id = card_id_of(card);
        if id.is_empty() || exclude.contains(&id) {
            continue;
        }
        let result = affinity_score(card, affinity);
        if !(result.score > 0.0) || !want(&result.matches) {
            continue;
        }
        scored.push(Ranked { card: card.clone(), score: result.score + 0.5 * popularity(card, max_hot), reason: result.reason, offer: None, price: 0.0 });
    }
    scored.sort_by(|a, b| {
        cmp_desc(a.score, b.score).then_with(|| {
            pokoin_sort::cmp_f64(js::number(a.card.get("min_price")), js::number(b.card.get("min_price")))
        })
    });
    scored.truncate(limit);
    scored
}

pub fn rank_trending(pool: &[Value], affinity: &Affinity, exclude: &HashSet<String>, limit: usize) -> Vec<Ranked> {
    let max24 = pool.iter().fold(0.0, |m, c| f64::max(m, hot_of(c, true)));
    let max7 = max_hot_of(pool);
    let mut scored = Vec::new();
    for card in pool {
        let id = card_id_of(card);
        if id.is_empty() || exclude.contains(&id) {
            continue;
        }
        let heat = (if max24 > 0.0 { hot_of(card, true).ln_1p() / max24.ln_1p() } else { 0.0 })
            + 0.5 * (if max7 > 0.0 { hot_of(card, false).ln_1p() / max7.ln_1p() } else { 0.0 });
        if !(heat > 0.0) {
            continue;
        }
        let taste = if affinity.size > 0 { affinity_score(card, affinity) } else { Score { score: 0.0, reason: String::new(), matches: Vec::new() } };
        scored.push(Ranked {
            card: card.clone(),
            score: heat + f64::min(0.3, taste.score / 40.0),
            reason: if taste.score > 0.0 { taste.reason } else { String::new() },
            offer: None,
            price: 0.0,
        });
    }
    scored.sort_by(|a, b| cmp_desc(a.score, b.score));
    scored.truncate(limit);
    scored
}

pub fn rank_co_carted(pool_by_id: &HashMap<String, Value>, counts: &[(String, f64)], exclude: &HashSet<String>, limit: usize) -> Vec<Ranked> {
    let mut scored = Vec::new();
    for (id, n) in counts {
        if exclude.contains(id) {
            continue;
        }
        let Some(card) = pool_by_id.get(id) else { continue };
        scored.push(Ranked {
            card: card.clone(),
            score: n + popularity(card, hot_of(card, false) + 1.0),
            reason: if *n > 1.0 { format!("In {} other carts with yours", js::number_to_string(*n)) } else { "In another cart with yours".into() },
            offer: None,
            price: 0.0,
        });
    }
    scored.sort_by(|a, b| cmp_desc(a.score, b.score));
    scored.truncate(limit);
    scored
}

fn language_key(value: Option<&Value>) -> String {
    let lang = key_of(value);
    match lang.as_str() {
        "ja" | "jpn" => "jp".into(),
        "eng" | "english" => "en".into(),
        _ => lang,
    }
}

fn language_name(lang: &str) -> Option<&'static str> {
    Some(match lang {
        "en" => "English",
        "it" => "Italian",
        "jp" => "Japanese",
        "de" => "German",
        "fr" => "French",
        "es" => "Spanish",
        "pt" => "Portuguese",
        "nl" => "Dutch",
        "pl" => "Polish",
        "ko" => "Korean",
        "zh" | "zht" => "Chinese",
        _ => return None,
    })
}

static NON_ALNUM_SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9 ]+").unwrap());
static TONES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"^(nm|near mint|mint|m)(?-u:\b)", "nm"),
        (r"^(ex|excellent)(?-u:\b)", "ex"),
        (r"^(sp|lp|slightly played|lightly played|good|gd)(?-u:\b)", "sp"),
        (r"^(mp|moderately played)(?-u:\b)", "mp"),
        (r"^(pl|hp|played|heavily played)(?-u:\b)", "pl"),
        (r"^(po|poor|damaged|dmg)(?-u:\b)", "poor"),
    ]
    .into_iter()
    .map(|(p, t)| (Regex::new(p).unwrap(), t))
    .collect()
});

/// `conditionTone(condition)`.
pub fn condition_tone(condition: Option<&Value>) -> &'static str {
    let lowered = key_of(condition);
    let value = NON_ALNUM_SPACE.replace_all(&lowered, " ");
    let value = value.trim();
    if value.is_empty() {
        return "nm";
    }
    TONES.iter().find(|(re, _)| re.is_match(value)).map(|(_, t)| *t).unwrap_or("")
}

struct Parcel {
    names: HashMap<String, String>,
    species: HashMap<i64, String>,
    sets: HashSet<String>,
    languages: HashSet<String>,
    conditions: HashSet<&'static str>,
}

fn parcel_profile(anchors: &[Value], pool_by_id: &HashMap<String, Value>) -> Parcel {
    let mut profile = Parcel { names: HashMap::new(), species: HashMap::new(), sets: HashSet::new(), languages: HashSet::new(), conditions: HashSet::new() };
    for row in anchors {
        let card = pool_by_id.get(&text_of(row.get("card_id"), 24));
        let name = text_of(card.and_then(|c| c.get("name")).filter(|v| js::truthy(Some(v))).or(row.get("card_name")), 240);
        if !name.is_empty() {
            profile.names.insert(name.to_lowercase(), name.clone());
        }
        let kind = card.map(species).unwrap_or(0);
        if kind != 0 {
            profile.species.insert(kind, name.clone());
        }
        let set = key_of(card.and_then(|c| c.get("set_name")).filter(|v| js::truthy(Some(v))).or(row.get("set_name")));
        if !set.is_empty() {
            profile.sets.insert(set);
        }
        let lang = language_key(row.get("language"));
        if !lang.is_empty() {
            profile.languages.insert(lang);
        }
        let tone = condition_tone(row.get("condition"));
        if !tone.is_empty() {
            profile.conditions.insert(tone);
        }
    }
    profile
}

fn upper_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn parcel_match(offer: &Value, card: &Value, profile: &Parcel) -> (f64, String) {
    let mut facets: Vec<String> = Vec::new();
    let mut score = 0.0;
    let name = profile.names.get(&key_of(card.get("name")));
    let kind = profile.species.get(&species(card));
    if let Some(name) = name {
        score += 4.0;
        facets.push(format!("other printing of {name}"));
    } else if let Some(kind) = kind {
        score += 3.0;
        facets.push(format!("more {}", PARCEL_LABEL.replacen(kind, 1, "")));
    }
    let set_value = card.get("set_name").filter(|v| js::truthy(Some(v))).or(offer.get("set_name"));
    if profile.sets.contains(&key_of(set_value)) {
        score += 3.0;
        facets.push(text_of(set_value, 240));
    }
    let lang = language_key(offer.get("language"));
    if !lang.is_empty() && profile.languages.contains(&lang) {
        score += 2.0;
        facets.push(language_name(&lang).map(str::to_owned).unwrap_or_else(|| lang.to_uppercase()));
    }
    let tone = condition_tone(offer.get("condition"));
    if !tone.is_empty() && profile.conditions.contains(tone) {
        score += 1.5;
        facets.push(if tone == "poor" { "Poor".into() } else { tone.to_uppercase() });
    }
    if facets.is_empty() {
        return (0.0, String::new());
    }
    let lead = upper_first(&facets[0]);
    let rest = &facets[1..];
    (score, if rest.is_empty() { lead } else { format!("{lead} · {}", rest.join(" · ")) })
}

pub fn rank_seller_shelf(
    listings: &[Value],
    pool_by_id: &HashMap<String, Value>,
    affinity: &Affinity,
    exclude_listings: &HashSet<String>,
    exclude_cards: &HashSet<String>,
    anchors: &[Value],
    limit: usize,
) -> Vec<Ranked> {
    let profile = parcel_profile(anchors, pool_by_id);
    let mut scored = Vec::new();
    let mut seen_cards = HashSet::new();
    for offer in listings {
        let listing_id = text_of(offer.get("id"), 80);
        let id = text_of(offer.get("card_id"), 24);
        if listing_id.is_empty() || exclude_listings.contains(&listing_id) || exclude_cards.contains(&id) || seen_cards.contains(&id) {
            continue;
        }
        let Some(card) = pool_by_id.get(&id) else { continue };
        seen_cards.insert(id);
        let (match_score, match_reason) = parcel_match(offer, card, &profile);
        let taste = affinity_score(card, affinity);
        let price = js::number(offer.get("price_pkn"));
        let reason = [match_reason, taste.reason].into_iter().find(|r| !r.is_empty()).unwrap_or_else(|| "Ships in the same parcel".into());
        scored.push(Ranked {
            card: card.clone(),
            offer: Some(offer.clone()),
            score: match_score + taste.score / 10.0,
            price: if price.is_finite() && price != 0.0 { price } else { 0.0 },
            reason,
        });
    }
    scored.sort_by(|a, b| cmp_desc(a.score, b.score).then_with(|| pokoin_sort::cmp_f64(a.price, b.price)));
    scored.truncate(limit);
    scored
}

fn condition_rank(offer: &Value) -> u8 {
    match condition_tone(offer.get("condition")) {
        "nm" => 0,
        "ex" => 1,
        "sp" => 2,
        "mp" => 3,
        "pl" => 4,
        "poor" => 5,
        _ => 6,
    }
}

fn is_english(offer: &Value) -> bool {
    matches!(key_of(offer.get("language")).as_str(), "en" | "eng" | "english")
}

/// `pickOffer(offers)` — English NM, other English, NM elsewhere, the rest; never graded.
pub fn pick_offer(offers: &[Value]) -> Option<Value> {
    let price = |o: &Value| js::number(o.get("price_pkn"));
    let rows: Vec<&Value> = offers
        .iter()
        .filter(|o| !js::truthy(o.get("graded")) && price(o) > 0.0 && js::number(o.get("quantity_available")) > 0.0)
        .collect();
    let cheapest = |list: Vec<&Value>| -> Option<Value> {
        let mut list = list;
        list.sort_by(|a, b| pokoin_sort::cmp_f64(price(a), price(b)));
        list.first().map(|v| (*v).clone())
    };
    let best = |list: Vec<&Value>| -> Option<Value> {
        let mut list = list;
        list.sort_by(|a, b| condition_rank(a).cmp(&condition_rank(b)).then_with(|| pokoin_sort::cmp_f64(price(a), price(b))));
        list.first().map(|v| (*v).clone())
    };
    let home: Vec<&Value> = rows.iter().copied().filter(|o| is_english(o)).collect();
    let other: Vec<&Value> = rows.iter().copied().filter(|o| !is_english(o)).collect();
    cheapest(home.iter().copied().filter(|o| condition_rank(o) == 0).collect())
        .or_else(|| best(home.iter().copied().filter(|o| condition_rank(o) != 0).collect()))
        .or_else(|| cheapest(other.iter().copied().filter(|o| condition_rank(o) == 0).collect()))
        .or_else(|| best(other.iter().copied().filter(|o| condition_rank(o) != 0).collect()))
}

/// `stamp(value)` of `boughtCardIds` over Firestore plain JSON.
fn stamp(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 0.0,
        Some(v) if !js::truthy(Some(v)) => 0.0,
        Some(Value::Object(map)) => {
            if let Some(s) = map.get("_seconds").and_then(Value::as_f64) {
                s * 1000.0
            } else if let Some(s) = map.get("seconds").and_then(Value::as_f64) {
                s * 1000.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => chrono::DateTime::parse_from_rfc3339(s).map(|d| d.timestamp_millis() as f64).unwrap_or(0.0),
        _ => 0.0,
    }
}

pub struct Bought {
    pub card_id: String,
    pub purchased_at: f64,
}

/// `boughtCardIds(orders, max)`.
pub fn bought_card_ids(orders: &[Value], max: usize) -> Vec<Bought> {
    let mut paid: Vec<&Value> = orders
        .iter()
        .filter(|o| matches!(o.get("paymentStatus").map(js::js_string).as_deref(), Some("paid" | "escrow" | "released" | "partially_refunded")))
        .collect();
    paid.sort_by(|a, b| pokoin_sort::cmp_f64_desc(stamp(a.get("createdAt")), stamp(b.get("createdAt"))));
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for order in paid {
        for item in order.get("items").and_then(Value::as_array).into_iter().flatten() {
            let raw = item.pointer("/card/id").filter(|v| !v.is_null()).or(item.get("cardId"));
            let id = text_of(raw, 24);
            if !is_digits(&id) || !seen.insert(id.clone()) {
                continue;
            }
            out.push(Bought { card_id: id, purchased_at: stamp(order.get("createdAt")) });
            if out.len() >= max {
                return out;
            }
        }
    }
    out
}

/// `topLabels(map, n)`.
pub fn top_labels<K: Eq + Hash + Clone>(map: &OrderedMap<K>, n: usize) -> Vec<String> {
    let mut entries: Vec<&Entry> = map.values().collect();
    entries.sort_by(|a, b| cmp_desc(a.weight, b.weight));
    entries.into_iter().take(n).map(|e| e.label.clone()).filter(|l| !l.is_empty()).collect()
}

pub fn join_labels(labels: &[String]) -> String {
    match labels.len() {
        0 => String::new(),
        1 => labels[0].clone(),
        n => format!("{} and {}", labels[..n - 1].join(", "), labels[n - 1]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn affinity_and_offers() {
        let card = json!({ "card_id": "1", "name": "Pikachu ex", "pokedex_num": 25, "artist": "Arita", "set_name": "151", "version": "v1" });
        let affinity = build_affinity(&[(Some(&card), "cart")]);
        assert_eq!(affinity.species.get(&25).unwrap().label, "Pikachu");
        let other = json!({ "card_id": "2", "name": "Pikachu", "pokedex_num": 25, "artist": "Arita" });
        let s = affinity_score(&other, &affinity);
        assert_eq!(s.matches, vec!["species", "artist"]);
        assert_eq!(s.reason, "More Pikachu");
        assert_eq!(condition_tone(Some(&json!("Near Mint"))), "nm");
        assert_eq!(condition_tone(Some(&json!("Lightly-Played"))), "sp");
        let offers = vec![
            json!({ "id": "a", "price_pkn": 50, "quantity_available": 1, "language": "it", "condition": "NM" }),
            json!({ "id": "b", "price_pkn": 90, "quantity_available": 1, "language": "en", "condition": "SP" }),
            json!({ "id": "c", "price_pkn": 70, "quantity_available": 1, "language": "en", "condition": "EX" }),
        ];
        assert_eq!(pick_offer(&offers).unwrap()["id"], "c");
        assert_eq!(join_labels(&["A".into(), "B".into(), "C".into()]), "A, B and C");
        assert_eq!(parse_id_param(Some("1, 2,x,1"), 24), vec!["1", "2"]);
        let orders = vec![json!({ "paymentStatus": "paid", "createdAt": "2026-01-01T00:00:00Z", "items": [{ "card": { "id": "9" } }, { "cardId": 9 }] })];
        let b = bought_card_ids(&orders, 24);
        assert_eq!((b.len(), b[0].card_id.as_str()), (1, "9"));
    }
}
