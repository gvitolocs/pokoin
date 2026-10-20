//! One CardTrader listing, read the way the Pokémon persist reads it.
//!
//! The Pokémon sold graph is built by the Oracle job: it shapes each product
//! with `normalize_product` (`crates/external/src/daily_refresh.rs`) and the
//! writer's SQL helpers (`cardtrader_listing_is_reverse`, `_is_first_edition`,
//! `_is_graded`, `cardtrader_listing_language_for_blueprint`,
//! `marketplace_price_pkn_from_cardtrader`, …) turn it into stack keys and
//! sold-graph facets. This module keeps exactly the fields those rules read.
//!
//! Two additions for the other games, which never change a Pokémon listing:
//! - language: when none of the Pokémon/Magic keys is set, the game's own
//!   `<game>_language` property (`yugioh_language`, `onepiece_language`, …);
//! - foil: the game's `<game>_foil` / `fab_foil_new` property is a stack facet
//!   and the sold-graph "reverse" column, like Pokémon's reverse holo.

use std::collections::HashMap;

use regex::Regex;

use crate::fx::{map_with, FxMap};
use serde_json::{Map, Value};

/// Interned strings: seller ids, conditions, languages, facets.
pub struct Strings {
    index: FxMap<Box<str>, u32>,
    list: Vec<Box<str>>,
}

/// The id of `""` in every [`Strings`].
pub const EMPTY: u32 = 0;

impl Default for Strings {
    fn default() -> Self {
        let mut strings = Self {
            index: map_with(1024),
            list: Vec::new(),
        };
        strings.id("");
        strings
    }
}

impl Strings {
    pub fn id(&mut self, text: &str) -> u32 {
        if let Some(id) = self.index.get(text) {
            return *id;
        }
        let id = self.list.len() as u32;
        self.list.push(text.into());
        self.index.insert(text.into(), id);
        id
    }

    pub fn get(&self, id: u32) -> &str {
        self.list.get(id as usize).map(|text| &**text).unwrap_or("")
    }
}

/// One listing of one night's book.
#[derive(Clone, Debug, PartialEq)]
pub struct Listing {
    pub id: u64,
    pub blueprint: i64,
    pub seller: u32,
    pub seller_name: u32,
    pub quantity: i32,
    pub condition: u32,
    /// `lower(btrim(condition))`: the stack key.
    pub condition_key: u32,
    pub language: u32,
    /// `lower(btrim(language))`: the stack key.
    pub language_key: u32,
    /// `cardtrader_listing_language_for_blueprint`: the sold-graph language.
    pub sold_language: u32,
    /// `"reverse"`, a game's foil value (`"foil"`, `"rainbow foil"`, …) or `""`.
    pub foil: u32,
    pub first_edition: bool,
    pub graded: bool,
    pub on_vacation: bool,
    /// `marketplace_price_pkn_from_cardtrader(price, price_cents, currency)`.
    pub price_pkn: Option<f64>,
    /// `cardtrader_graded_seller_comment`, graded listings only.
    pub comment: Option<Box<str>>,
}

/// A listing with its strings still owned: built on the decode threads,
/// interned into a [`Listing`] on the engine's thread.
#[derive(Clone, Debug)]
pub struct Raw {
    pub id: u64,
    pub blueprint: i64,
    pub seller: String,
    pub seller_name: String,
    pub quantity: i32,
    pub condition: String,
    pub condition_key: String,
    pub language: String,
    pub language_key: String,
    pub sold_language: String,
    pub foil: &'static str,
    pub first_edition: bool,
    pub graded: bool,
    pub on_vacation: bool,
    pub price_pkn: Option<f64>,
    pub comment: Option<Box<str>>,
}

/// The shaping rules; shared by the decode threads.
pub struct Rules {
    /// Pokémon expansion nationality by blueprint (`pokoin_pokemon_expansions`);
    /// empty for the other games, whose listings name their language.
    pub nationality: HashMap<i64, String>,
    /// `app.pkn_usdt_price`: EUR per PKN (0.005 = 200 PKN per euro).
    pub pkn_rate: f64,
    comment_patterns: Vec<(Regex, &'static str)>,
    promotional: Vec<Regex>,
}

/// [`Rules`] plus the interner.
pub struct Shaper {
    pub strings: Strings,
    pub rules: Rules,
}

impl Shaper {
    pub fn new(pkn_rate: f64, nationality: HashMap<i64, String>) -> Self {
        Self {
            strings: Strings::default(),
            rules: Rules::new(pkn_rate, nationality),
        }
    }

    pub fn intern(&mut self, raw: Raw) -> Listing {
        self.strings.listing(raw)
    }

    pub fn listing(&mut self, product: &Value, fallback_blueprint: Option<i64>) -> Option<Listing> {
        let raw = self.rules.raw(product, fallback_blueprint)?;
        Some(self.intern(raw))
    }

    pub fn book(&mut self, book: &Value) -> Vec<Listing> {
        self.rules
            .book(book)
            .into_iter()
            .map(|raw| self.intern(raw))
            .collect()
    }
}

impl Strings {
    /// Interns a shaped row.
    pub fn listing(&mut self, raw: Raw) -> Listing {
        let strings = self;
        Listing {
            id: raw.id,
            blueprint: raw.blueprint,
            seller: strings.id(&raw.seller),
            seller_name: strings.id(&raw.seller_name),
            quantity: raw.quantity,
            condition: strings.id(&raw.condition),
            condition_key: strings.id(&raw.condition_key),
            language: strings.id(&raw.language),
            language_key: strings.id(&raw.language_key),
            sold_language: strings.id(&raw.sold_language),
            foil: strings.id(raw.foil),
            first_edition: raw.first_edition,
            graded: raw.graded,
            on_vacation: raw.on_vacation,
            price_pkn: raw.price_pkn,
            comment: raw.comment,
        }
    }
}

impl Rules {
    pub fn new(pkn_rate: f64, nationality: HashMap<i64, String>) -> Self {
        let comment_patterns = [
            (r"(?is)<script\b[^>]*>.*?</script>", ""),
            (r"(?is)<style\b[^>]*>.*?</style>", ""),
            (r"<[^>]*>", ""),
            (r"[\x00-\x1f\x7f]+", " "),
            (r"\s+", " "),
        ]
        .into_iter()
        .map(|(pattern, with)| (Regex::new(pattern).expect("comment pattern"), with))
        .collect();
        let promotional = [
            r"\bcheck\s+(?:out\s+)?my\s+(?:store|shop|profile|page|cards|listings|other\s+items)\b",
            r"\bvisit\s+my\s+(?:store|shop|profile|page)\b",
            r"\bsee\s+my\s+(?:store|shop|profile|page|other\s+cards|listings)\b",
            r"\bmore\s+(?:cards|items|listings|products)\s+available\b",
            r"\b(?:other|more)\s+(?:cards|items|listings|products)\s+(?:in|on)\s+my\s+(?:store|shop|profile|page)\b",
            r"\b(?:message|contact|dm|pm)\s+me\b",
            r"\b(?:whatsapp|telegram|instagram|facebook|discord|ebay|vinted)\b",
            r"(?:https?://|www\.|(?:^|\s)[a-z0-9-]+\.(?:com|it|net|org|shop)\b)",
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("promotional pattern"))
        .collect();
        Self {
            nationality,
            pkn_rate,
            comment_patterns,
            promotional,
        }
    }

    /// Every listing of a decoded book (`{blueprint_id: [product, …]}`, or a
    /// plain product array). Products without a listing id are skipped, as
    /// the persist does.
    pub fn book(&self, book: &Value) -> Vec<Raw> {
        let mut out = Vec::new();
        match book {
            Value::Object(map) => {
                for (key, products) in map {
                    let fallback = key.parse::<i64>().ok();
                    for product in products.as_array().into_iter().flatten() {
                        if let Some(listing) = self.raw(product, fallback) {
                            out.push(listing);
                        }
                    }
                }
            }
            Value::Array(products) => {
                for product in products {
                    if let Some(listing) = self.raw(product, None) {
                        out.push(listing);
                    }
                }
            }
            _ => {}
        }
        out
    }

    pub fn raw(&self, product: &Value, fallback_blueprint: Option<i64>) -> Option<Raw> {
        let empty = Map::new();
        let props = pick(product, &["properties_hash", "properties"])
            .as_object()
            .unwrap_or(&empty);
        let user = pick(product, &["user", "seller"]);
        let id = text(pick(product, &["id", "product_id", "listing_id"]), 160)
            .parse::<u64>()
            .ok()?;
        let blueprint =
            int(pick(product, &["blueprint_id", "blueprintId"])).or(fallback_blueprint)?;

        let condition = cut(
            &first(&[
                pick(product, &["condition", "state"]),
                pick_map(props, &["condition", "pokemon_condition"]),
            ]),
            80,
        );
        let mut language = normalize_language(&first(&[
            pick(product, &["language", "lang"]),
            pick_map(props, &["language", "pokemon_language", "mtg_language"]),
        ]));
        if language.is_empty() {
            language = normalize_language(&game_language(props));
        }
        let language = cut(&language, 40);
        let pokemon_language = text(props.get("pokemon_language").unwrap_or(&Value::Null), 240);

        let graded = truthy(product.get("graded").unwrap_or(&Value::Null))
            || truthy(props.get("graded").unwrap_or(&Value::Null));
        let comment = if graded {
            let source = first(&[
                pick(product, &["seller_comment", "sellerComment", "description"]),
                pick_map(props, &["seller_comment", "sellerComment"]),
            ]);
            let cleaned = self.comment(&source);
            (!cleaned.is_empty()).then(|| cut(&cleaned, 500).into_boxed_str())
        } else {
            None
        };

        let on_vacation = truthy(product.get("on_vacation").unwrap_or(&Value::Null))
            || truthy(user.get("on_vacation").unwrap_or(&Value::Null));

        let price_object = product.get("price").filter(|value| value.is_object());
        let cents = int(pick(product, &["price_cents", "priceCents"])).or_else(|| {
            price_object.and_then(|price| int(price.get("cents").unwrap_or(&Value::Null)))
        });
        let price = product
            .get("price")
            .and_then(Value::as_f64)
            .or_else(|| cents.map(|c| c as f64 / 100.0));
        let currency_value = pick(product, &["currency", "price_currency"]);
        let currency = if currency_value.is_null() {
            price_object
                .and_then(|price| price.get("currency"))
                .map(|v| text(v, 12))
                .unwrap_or_default()
        } else {
            text(currency_value, 12)
        };
        let currency = if currency.is_empty() {
            "EUR".to_string()
        } else {
            currency
        };
        let price_pkn = price_pkn(price, &currency, self.pkn_rate);

        let nationality = self
            .nationality
            .get(&blueprint)
            .map(String::as_str)
            .unwrap_or("");
        let sold_language = listing_language(&language, &pokemon_language, nationality);

        Some(Raw {
            id,
            blueprint,
            seller: cut(&text(pick(user, &["id", "user_id"]), 160), 160),
            seller_name: cut(&first(&[pick(user, &["username", "name"])]), 240),
            quantity: int(pick(product, &["quantity", "qty"]))
                .unwrap_or(0)
                .clamp(0, i32::MAX as i64) as i32,
            condition_key: condition.trim().to_lowercase(),
            condition,
            language_key: language.trim().to_lowercase(),
            language,
            sold_language,
            foil: foil_facet(props),
            first_edition: ["first_edition", "firstEdition", "pokemon_first_edition"]
                .iter()
                .any(|key| truthy(props.get(*key).unwrap_or(&Value::Null))),
            graded,
            on_vacation,
            price_pkn,
            comment,
        })
    }

    /// `comment()` of the persist: markup and control characters stripped,
    /// whitespace collapsed, shop adverts dropped.
    fn comment(&self, value: &str) -> String {
        let mut output: String = value.chars().take(500).collect();
        for (pattern, with) in &self.comment_patterns {
            output = pattern.replace_all(&output, *with).into_owned();
        }
        let lower = output.to_lowercase();
        if self
            .promotional
            .iter()
            .any(|pattern| pattern.is_match(&lower))
        {
            return String::new();
        }
        output.trim().to_string()
    }
}

fn pick<'a>(value: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .find_map(|key| value.get(*key).filter(|v| !v.is_null()))
        .unwrap_or(&Value::Null)
}

fn pick_map<'a>(map: &'a Map<String, Value>, keys: &[&str]) -> &'a Value {
    keys.iter()
        .find_map(|key| map.get(*key).filter(|v| !v.is_null()))
        .unwrap_or(&Value::Null)
}

/// JS `String(value).trim()` for the scalars the persist reads.
fn text(value: &Value, max: usize) -> String {
    match value {
        Value::String(text) => text.trim().chars().take(max).collect(),
        Value::Number(number) => number.to_string(),
        Value::Bool(true) => "true".into(),
        _ => String::new(),
    }
}

fn first(values: &[&Value]) -> String {
    values
        .iter()
        .map(|value| text(value, 240))
        .find(|text| !text.is_empty())
        .unwrap_or_default()
}

fn cut(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) if text.trim().is_empty() => 0.0,
        Value::String(text) => text.trim().parse().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

fn int(value: &Value) -> Option<i64> {
    if value.is_null() || value.as_str() == Some("") {
        return None;
    }
    let number = js_number(value);
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0)
        .then_some(number as i64)
}

pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64() == Some(1.0),
        Value::String(text) => matches!(text.trim().to_lowercase().as_str(), "true" | "1" | "yes"),
        _ => false,
    }
}

/// `normalize_language` of the CardTrader port: full names to codes.
pub fn normalize_language(value: &str) -> String {
    let text: String = value.trim().chars().take(40).collect();
    match text.to_lowercase().as_str() {
        "english" => "en".into(),
        "italian" => "it".into(),
        "japanese" => "ja".into(),
        "french" => "fr".into(),
        "german" => "de".into(),
        "spanish" => "es".into(),
        "korean" => "ko".into(),
        "chinese" => "zh".into(),
        _ => text,
    }
}

/// The game's own language property (`yugioh_language`, `onepiece_language`, …).
fn game_language(props: &Map<String, Value>) -> String {
    props
        .iter()
        .filter(|(key, _)| key.ends_with("_language"))
        .map(|(_, value)| text(value, 240))
        .find(|text| !text.is_empty())
        .unwrap_or_default()
}

/// `"reverse"` exactly when `cardtrader_listing_is_reverse` holds (Pokémon);
/// otherwise the game's foil property, lowercased, with "not foil" as `""`.
pub fn foil_facet(props: &Map<String, Value>) -> &'static str {
    let lower = |key: &str| {
        props
            .get(key)
            .map(|v| text(v, 80).to_lowercase())
            .unwrap_or_default()
    };
    if lower("foil_state") == "reverse"
        || lower("foilState") == "reverse"
        || matches!(
            lower("pokemon_reverse").as_str(),
            "true" | "1" | "yes" | "reverse"
        )
    {
        return "reverse";
    }
    for (key, value) in props {
        if !(key.ends_with("_foil") || key.ends_with("_foil_new")) {
            continue;
        }
        let value = text(value, 80).to_lowercase();
        return match value.as_str() {
            "" | "false" | "0" | "no" | "regular" | "normal" | "non-foil" | "nonfoil"
            | "non foil" => "",
            "true" | "1" | "yes" | "foil" => "foil",
            "rainbow foil" => "rainbow foil",
            "cold foil" => "cold foil",
            "gold cold foil" => "gold cold foil",
            _ => "foil",
        };
    }
    ""
}

/// `cardtrader_sold_language`.
pub fn sold_language(value: &str) -> Option<String> {
    let lower = value.trim().to_lowercase();
    let code = match lower.as_str() {
        "en" | "english" => "EN",
        "it" | "italian" => "IT",
        "fr" | "french" => "FR",
        "de" | "german" => "DE",
        "es" | "spanish" => "ES",
        "jp" | "ja" | "japanese" => "JP",
        "pt" | "portuguese" => "PT",
        "nl" | "dutch" => "NL",
        "pl" | "polish" => "PL",
        "ru" | "russian" => "RU",
        "ko" | "kr" | "korean" => "KO",
        "zh-tw" | "zht" | "zh_hant" | "zh-hant" => "ZHT",
        "zh" | "zh-cn" | "zh_hans" | "zh-hans" | "chinese" => "ZH",
        "id" | "indonesian" | "indonesia" => "ID",
        "" => return None,
        _ => return Some(value.trim().to_uppercase()),
    };
    Some(code.into())
}

/// `cardtrader_default_language_for_nationality`.
pub fn default_language_for_nationality(nationality: &str) -> &'static str {
    match nationality.trim().to_lowercase().as_str() {
        "japanese" => "JP",
        "korean" => "KO",
        "chinese" => "ZH",
        "indonesian" | "idth" => "ID",
        "thai" => "TH",
        "french" => "FR",
        "german" => "DE",
        _ => "EN",
    }
}

/// `cardtrader_listing_language`: an explicit `pokemon_language`, else a
/// stored non-English language, else the expansion's print language.
pub fn listing_language(stored: &str, pokemon_language: &str, nationality: &str) -> String {
    if let Some(code) = sold_language(pokemon_language) {
        return code;
    }
    match sold_language(stored) {
        Some(code) if code != "EN" => code,
        _ => default_language_for_nationality(nationality).to_string(),
    }
}

/// `cardtrader_sold_condition`.
pub fn sold_condition(value: &str) -> Option<String> {
    let lower = value.trim().to_lowercase();
    let code = match lower.as_str() {
        "nm" | "mint" | "near mint" | "near mint foil" => "NM",
        "sp" | "slightly played" | "lightly played" | "lp" | "excellent" | "ex" => "SP",
        "mp" | "moderately played" | "played good" | "good" | "gd" => "MP",
        "pl" | "played" | "poor played" | "hp" | "heavily played" => "PL",
        "poor" | "po" | "damaged" | "dmg" => "Poor",
        "" => return None,
        _ => return Some(value.trim().to_string()),
    };
    Some(code.into())
}

/// `marketplace_price_pkn_from_cardtrader`.
pub fn price_pkn(amount: Option<f64>, currency: &str, rate: f64) -> Option<f64> {
    let amount = amount.filter(|value| value.is_finite() && *value > 0.0)?;
    if matches!(currency.trim().to_uppercase().as_str(), "PKN" | "POKOIN") {
        return Some(amount);
    }
    let rate = if rate.is_finite() && rate > 0.0 {
        rate
    } else {
        0.005
    };
    Some(amount / rate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shaper() -> Shaper {
        Shaper::new(0.005, HashMap::from([(7, "japanese".to_string())]))
    }

    #[test]
    fn pokemon_listing_keeps_the_persist_fields() {
        let mut s = shaper();
        let product = json!({"id": 386678731, "blueprint_id": 273500, "price_cents": 1000,
            "price_currency": "EUR", "quantity": 2, "graded": false, "on_vacation": false,
            "properties_hash": {"condition": "Poor", "pokemon_language": "it", "pokemon_reverse": true,
                "first_edition": false},
            "user": {"id": 68970, "username": "Card Republic"},
            "price": {"cents": 1000, "currency": "EUR"}});
        let l = s.listing(&product, None).unwrap();
        assert_eq!(l.id, 386678731);
        assert_eq!(s.strings.get(l.seller), "68970");
        assert_eq!(s.strings.get(l.condition_key), "poor");
        assert_eq!(s.strings.get(l.language_key), "it");
        assert_eq!(s.strings.get(l.sold_language), "IT");
        assert_eq!(s.strings.get(l.foil), "reverse");
        assert_eq!(l.price_pkn, Some(2000.0));
        assert_eq!(l.quantity, 2);
    }

    #[test]
    fn empty_pokemon_language_is_the_print_language() {
        let mut s = shaper();
        let product = json!({"id": 1, "blueprint_id": 7, "price_cents": 100, "quantity": 1,
            "properties_hash": {"condition": "Near Mint"}, "user": {"id": 2}});
        let l = s.listing(&product, None).unwrap();
        assert_eq!(s.strings.get(l.language_key), "");
        assert_eq!(s.strings.get(l.sold_language), "JP");
    }

    #[test]
    fn other_games_use_their_language_and_foil_properties() {
        let mut s = shaper();
        let ygo = json!({"id": 3, "blueprint_id": 9, "price_cents": 250, "quantity": 1,
            "properties_hash": {"condition": "Slightly Played", "yugioh_language": "it", "first_edition": true},
            "user": {"id": 4}});
        let l = s.listing(&ygo, None).unwrap();
        assert_eq!(s.strings.get(l.language_key), "it");
        assert_eq!(s.strings.get(l.sold_language), "IT");
        assert!(l.first_edition);
        let fab = json!({"id": 5, "blueprint_id": 9, "price_cents": 250, "quantity": 1,
            "properties_hash": {"fab_language": "en", "fab_foil_new": "Rainbow Foil"}, "user": {"id": 4}});
        let l = s.listing(&fab, None).unwrap();
        assert_eq!(s.strings.get(l.foil), "rainbow foil");
        let mtg = json!({"id": 6, "blueprint_id": 9, "price_cents": 250, "quantity": 1,
            "properties_hash": {"mtg_language": "kr", "mtg_foil": false}, "user": {"id": 4}});
        let l = s.listing(&mtg, None).unwrap();
        assert_eq!(s.strings.get(l.foil), "");
        assert_eq!(s.strings.get(l.sold_language), "KO");
        let lorcana = json!({"id": 7, "blueprint_id": 9, "price_cents": 250, "quantity": 1,
            "properties_hash": {"lorcana_language": "zh-CN", "lorcana_foil": true}, "user": {"id": 4}});
        let l = s.listing(&lorcana, None).unwrap();
        assert_eq!(s.strings.get(l.foil), "foil");
        assert_eq!(s.strings.get(l.sold_language), "ZH");
    }

    #[test]
    fn graded_comments_drop_adverts_and_markup() {
        let mut s = shaper();
        let graded = json!({"id": 8, "blueprint_id": 9, "price_cents": 250, "quantity": 1, "graded": true,
            "description": "<b>PSA 10</b>\n gem mint", "user": {"id": 4}});
        let l = s.listing(&graded, None).unwrap();
        assert_eq!(l.comment.as_deref(), Some("PSA 10 gem mint"));
        let advert = json!({"id": 9, "blueprint_id": 9, "price_cents": 250, "quantity": 1, "graded": true,
            "description": "PSA 9, check out my store", "user": {"id": 4}});
        assert_eq!(s.listing(&advert, None).unwrap().comment, None);
    }

    #[test]
    fn missing_ids_and_prices() {
        let mut s = shaper();
        assert!(s.listing(&json!({"blueprint_id": 9}), None).is_none());
        let free = s
            .listing(
                &json!({"id": 10, "blueprint_id": 9, "price_cents": 0}),
                None,
            )
            .unwrap();
        assert_eq!(free.price_pkn, None);
        let pkn = price_pkn(Some(12.0), "PKN", 0.005);
        assert_eq!(pkn, Some(12.0));
        assert_eq!(
            s.listing(&json!({"id": 11}), Some(44)).unwrap().blueprint,
            44
        );
    }

    #[test]
    fn sold_codes_match_the_sql_helpers() {
        assert_eq!(sold_condition("Near Mint").as_deref(), Some("NM"));
        assert_eq!(sold_condition("Moderately Played").as_deref(), Some("MP"));
        assert_eq!(sold_condition("Played").as_deref(), Some("PL"));
        assert_eq!(sold_condition(""), None);
        assert_eq!(sold_language("zh-CN").as_deref(), Some("ZH"));
        assert_eq!(sold_language("xx").as_deref(), Some("XX"));
        assert_eq!(listing_language("en", "", "korean"), "KO");
        assert_eq!(listing_language("fr", "", "japanese"), "FR");
    }
}
