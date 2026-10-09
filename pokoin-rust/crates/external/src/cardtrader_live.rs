//! `/api/cardtrader-live-listings` — live on-demand CardTrader marketplace
//! listings. Native port of `cardtrader-live-listings.js` (60 s L1 cache;
//! optional Redis L2). The promotional seller-comment filter is not ported.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::cardtrader::client::{self, CardTraderClient};
use crate::db::DbPools;
use crate::error::{clean_text, ApiError, ApiResult};
use crate::redis::RedisCache;

pub const PROVIDER: &str = "cardtrader";
pub const PKNRESERVE_SELLER_USERNAME: &str = "pknreserve";
pub const PKN_USDT_REFERENCE_PRICE: f64 = 0.005;
pub const CARDTRADER_MARKUP_PKN: i64 = 0;
pub const CARDTRADER_MARKETPLACE_PRODUCTS_PATH: &str = "/api/v2/marketplace/products";
pub const MAX_EXPLICIT_LIMIT: i64 = 1000;
pub const CACHE_TTL_MS: i64 = 60_000;
pub const CACHE_TTL_SEC: u64 = 60;
pub const MAX_CACHE_ENTRIES: usize = 100;

#[derive(Clone, Debug, PartialEq)]
pub struct LiveRequest {
    pub blueprint_id: String,
    pub card_id: String,
    pub requested_id: String,
    pub requested_param: &'static str,
    pub language: String,
    pub limit: Option<i64>,
}

fn first_search_value(query: &[(String, String)], names: &[&str]) -> String {
    for name in names {
        if let Some((_, value)) = query.iter().find(|(key, _)| key == name) {
            if !value.trim().is_empty() {
                return value.clone();
            }
        }
    }
    String::new()
}

pub fn clean_numeric_id(value: &str) -> String {
    let text = clean_text(Some(value), 80);
    if text.is_empty() || !text.chars().all(|c| c.is_ascii_digit()) {
        return String::new();
    }
    match text.parse::<u64>() {
        Ok(number) if number > 0 => number.to_string(),
        _ => String::new(),
    }
}

pub fn clean_card_id(value: &str) -> String {
    let text = clean_text(Some(value), 80);
    if text.is_empty()
        || !text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
    {
        return String::new();
    }
    text
}

fn clean_language(value: &str) -> String {
    let text = clean_text(Some(value), 16);
    let valid = text.len() >= 2
        && text.len() <= 16
        && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if valid {
        text
    } else {
        String::new()
    }
}

fn clean_limit(value: Option<&str>) -> Option<i64> {
    let text = value?;
    if text.trim().is_empty() {
        return None;
    }
    text.trim()
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .map(|number| (number.trunc() as i64).clamp(1, MAX_EXPLICIT_LIMIT))
}

/// `parseLiveListingsRequest`.
pub fn parse_request(query: &[(String, String)]) -> ApiResult<LiveRequest> {
    let blueprint_input = first_search_value(
        query,
        &[
            "blueprintId",
            "blueprint_id",
            "cardtraderBlueprintId",
            "cardtrader_blueprint_id",
            "id",
        ],
    );
    let card_input = first_search_value(query, &["cardId", "card_id"]);
    let blueprint_id = if blueprint_input.is_empty() { String::new() } else { clean_numeric_id(&blueprint_input) };
    let card_id = if card_input.is_empty() { String::new() } else { clean_card_id(&card_input) };
    if !blueprint_input.is_empty() && blueprint_id.is_empty() {
        return Err(ApiError::bad_request("Missing or invalid blueprintId."));
    }
    if !card_input.is_empty() && card_id.is_empty() {
        return Err(ApiError::bad_request("Missing or invalid cardId."));
    }
    if blueprint_id.is_empty() && card_id.is_empty() {
        return Err(ApiError::bad_request("Provide blueprintId or cardId."));
    }
    let requested_id = if blueprint_id.is_empty() { card_id.clone() } else { blueprint_id.clone() };
    Ok(LiveRequest {
        requested_param: if blueprint_id.is_empty() { "cardId" } else { "blueprintId" },
        blueprint_id,
        card_id,
        requested_id,
        language: clean_language(
            &first_search_value(query, &["language"]).or_nonempty(|| first_search_value(query, &["lang"])),
        ),
        limit: clean_limit(Some(&first_search_value(query, &["limit"]))),
    })
}

trait OrNonEmpty {
    fn or_nonempty(self, fallback: impl FnOnce() -> String) -> String;
}
impl OrNonEmpty for String {
    fn or_nonempty(self, fallback: impl FnOnce() -> String) -> String {
        if self.is_empty() {
            fallback()
        } else {
            self
        }
    }
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

/// `resolveCardTraderBlueprintId`.
pub async fn resolve_blueprint(db: &DbPools, request: &LiveRequest, game: &str) -> ApiResult<Value> {
    if !request.blueprint_id.is_empty() {
        return Ok(json!({
            "cardtraderBlueprintId": request.blueprint_id,
            "pokoinCardId": request.card_id,
            "mappingSource": "direct_cardtrader_blueprint_id",
            "warning": "",
        }));
    }
    let numeric = clean_numeric_id(&request.card_id);
    if numeric.is_empty() {
        return Err(ApiError::bad_request(
            "cardId must be a numeric Pokoin/CardTrader blueprint id for live CardTrader lookup.",
        ));
    }
    let game = crate::db::normalize_game(game);
    if let Ok(rows) = db
        .query(
            &game,
            "select card_id as pokoin_card_id, ct_id as cardtrader_blueprint_id
               from public.marketplace_search_candidates where card_id = $1::bigint limit 1",
            &[json!(numeric.parse::<i64>().unwrap_or(0))],
        )
        .await
    {
        if let Some(row) = rows.first() {
            let blueprint = clean_numeric_id(&text_of(row.get("cardtrader_blueprint_id").unwrap_or(&Value::Null)));
            if !blueprint.is_empty() {
                return Ok(json!({
                    "cardtraderBlueprintId": blueprint,
                    "pokoinCardId": row.get("pokoin_card_id").map(text_of).unwrap_or_else(|| numeric.clone()),
                    "mappingSource": format!("{game}_catalog_ct_id"),
                    "warning": "",
                }));
            }
        }
    }
    match db
        .query(
            "pokemon",
            "select candidates.card_id as pokoin_card_id, blueprints.id as cardtrader_blueprint_id
               from (select $1::bigint as requested_id) input
               left join public.marketplace_search_candidates candidates
                 on candidates.card_id = input.requested_id
               left join public.cardtrader_pokemon_blueprints blueprints
                 on blueprints.id = coalesce(candidates.card_id, input.requested_id)
               limit 1",
            &[json!(numeric.parse::<i64>().unwrap_or(0))],
        )
        .await
    {
        Ok(rows) => {
            if let Some(row) = rows.first() {
                let blueprint = clean_numeric_id(&text_of(
                    row.get("cardtrader_blueprint_id")
                        .filter(|value| !value.is_null())
                        .unwrap_or(&row["pokoin_card_id"].clone()),
                ));
                if !blueprint.is_empty() {
                    return Ok(json!({
                        "cardtraderBlueprintId": blueprint,
                        "pokoinCardId": row.get("pokoin_card_id").map(text_of).unwrap_or_else(|| numeric.clone()),
                        "mappingSource": "oracle_card_data",
                        "warning": "",
                    }));
                }
            }
            Ok(json!({
                "cardtraderBlueprintId": numeric,
                "pokoinCardId": numeric,
                "mappingSource": "numeric_card_id_fallback",
                "warning": "No Oracle mapping row found; treated numeric cardId as a CardTrader blueprint id.",
            }))
        }
        Err(_) => Ok(json!({
            "cardtraderBlueprintId": numeric,
            "pokoinCardId": numeric,
            "mappingSource": "numeric_card_id_fallback",
            "warning": "Oracle card mapping was unavailable; treated numeric cardId as a CardTrader blueprint id.",
        })),
    }
}

fn game_language_property(properties: &Value) -> String {
    let Some(map) = properties.as_object() else {
        return String::new();
    };
    for (key, value) in map {
        if key.ends_with("_language") {
            let text = clean_text(value.as_str(), 40);
            if !text.is_empty() {
                return text;
            }
        }
    }
    String::new()
}

fn object_or_empty(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Object(_)) => value.cloned().unwrap_or(json!({})),
        _ => json!({}),
    }
}

fn first_text(values: &[Option<&Value>]) -> String {
    for value in values {
        let text = clean_text(value.and_then(Value::as_str), 240);
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

fn is_shipping_mode_label(value: &str) -> bool {
    let normalized: String = clean_text(Some(value), 120)
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    [
        "cardtrader zero",
        "ct zero",
        "zero",
        "1 day ready",
        "one day ready",
        "cardtrader 1 day ready",
        "normal",
    ]
    .contains(&normalized.as_str())
}

pub fn normalize_condition(value: &str) -> String {
    let text = clean_text(Some(value), 40);
    let normalized: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        return String::new();
    }
    let sets: [(&str, [&str; 6]); 3] = [
        ("NM", ["nm", "mint", "near mint", "near mint foil", "", ""]),
        ("SP", ["sp", "slightly played", "lightly played", "lp", "excellent", "ex"]),
        ("MP", ["mp", "moderately played", "played good", "good", "gd", ""]),
    ];
    for (key, values) in sets {
        if values.contains(&normalized.as_str()) {
            return key.to_string();
        }
    }
    if ["pl", "played", "poor played"].contains(&normalized.as_str()) {
        return "PL".into();
    }
    if ["poor", "po", "damaged", "dmg"].contains(&normalized.as_str()) {
        return "Poor".into();
    }
    text
}

pub fn normalize_language(value: &str) -> String {
    let text = clean_text(Some(value), 40);
    if text.is_empty() {
        return String::new();
    }
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

fn public_expansion(product: &Value) -> Value {
    let expansion = object_or_empty(product.get("expansion"));
    json!({
        "id": expansion.get("id").or_else(|| product.get("expansion_id")).and_then(Value::as_i64),
        "code": clean_text(
            expansion.get("code").and_then(Value::as_str).or_else(|| product.get("expansion_code").and_then(Value::as_str)),
            80,
        ),
        "name": first_text(&[
            expansion.get("name_en"),
            expansion.get("name"),
            product.get("expansion").filter(|value| value.is_string()),
        ]),
    })
}

fn normalized_price(product: &Value) -> Value {
    let price_object = object_or_empty(product.get("price"));
    let price_cents = product
        .get("price_cents")
        .or_else(|| product.get("priceCents"))
        .or_else(|| price_object.get("cents"))
        .and_then(Value::as_i64);
    let amount = product
        .get("price_amount")
        .or_else(|| product.get("priceAmount"))
        .or_else(|| price_object.get("amount"))
        .and_then(Value::as_f64)
        .or_else(|| price_cents.map(|cents| cents as f64 / 100.0));
    json!({
        "price": amount,
        "priceCents": price_cents,
        "currency": clean_text(
            product
                .get("currency")
                .or_else(|| product.get("price_currency"))
                .or_else(|| product.get("priceCurrency"))
                .or_else(|| price_object.get("currency"))
                .and_then(Value::as_str),
            12,
        ),
    })
}

pub fn pkn_reference_price(configured: Option<&str>) -> f64 {
    configured
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(PKN_USDT_REFERENCE_PRICE)
}

pub fn display_price_pkn(price: Option<f64>, currency: &str, reference: f64) -> Option<f64> {
    let amount = price?;
    if !amount.is_finite() || amount <= 0.0 {
        return None;
    }
    let currency = clean_text(Some(currency), 12).to_uppercase();
    if currency == "PKN" || currency == "POKOIN" {
        return Some(amount);
    }
    Some(amount / reference)
}

fn text_includes_one_day_ready(values: &[Option<&Value>]) -> bool {
    let text = values
        .iter()
        .filter_map(|value| value.and_then(Value::as_str))
        .map(|value| clean_text(Some(value), 1000))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let lowered = text.to_lowercase();
    ["1 day ready", "1-day ready", "one day ready", "one-day ready"]
        .iter()
        .any(|needle| lowered.contains(needle))
}

fn boolean_or_false(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().map(|n| n != 0.0).unwrap_or(false),
        Some(Value::String(text)) => matches!(text.trim().to_lowercase().as_str(), "true" | "1" | "yes" | "y"),
        _ => false,
    }
}

/// `inferCardTraderShippingMode`.
pub fn infer_shipping_mode(product: &Value, user: &Value) -> &'static str {
    if text_includes_one_day_ready(&[
        user.get("username"),
        user.get("name"),
        user.get("display_name"),
        user.get("public_name"),
        product.get("seller_name"),
        product.get("seller_display_name"),
        product.get("name"),
        product.get("name_en"),
        product.get("description"),
    ]) {
        return "one_day_ready";
    }
    let can_sell_via_hub = boolean_or_false(user.get("can_sell_via_hub").or_else(|| product.get("can_sell_via_hub")));
    if can_sell_via_hub {
        return "zero";
    }
    let can_sell_sealed = boolean_or_false(
        user.get("can_sell_sealed_with_ct_zero").or_else(|| product.get("can_sell_sealed_with_ct_zero")),
    );
    if can_sell_sealed {
        return "zero";
    }
    "normal"
}

pub fn shipping_label_for_mode(mode: &str) -> &'static str {
    match mode {
        "one_day_ready" => "1-Day Ready",
        "zero" => "Zero",
        "normal" => "Normal",
        _ => "Unknown",
    }
}

/// `normalizeLiveListing` — the fields the marketplace desk renders.
pub fn normalize_live_listing(product: &Value, fallback_blueprint_id: Option<&str>, reference: f64) -> Value {
    let properties = object_or_empty(product.get("properties_hash").or_else(|| product.get("properties")));
    let user = object_or_empty(product.get("user").or_else(|| product.get("seller")));
    let buyer_price = object_or_empty(product.get("buyer_price").or_else(|| product.get("buyerPrice")));
    let seller_price = object_or_empty(product.get("seller_price").or_else(|| product.get("sellerPrice")));
    let product_id = clean_text(
        product
            .get("id")
            .or_else(|| product.get("product_id"))
            .or_else(|| product.get("productId"))
            .or_else(|| product.get("listing_id"))
            .or_else(|| product.get("listingId"))
            .and_then(Value::as_str),
        160,
    );
    let blueprint_id = product
        .get("blueprint_id")
        .or_else(|| product.get("blueprintId"))
        .and_then(Value::as_i64)
        .map(|value| value.to_string())
        .or_else(|| fallback_blueprint_id.map(|value| value.to_string()));
    let price = normalized_price(product);
    let shipping_mode = infer_shipping_mode(product, &user);
    let condition = normalize_condition(&first_text(&[
        product.get("condition"),
        product.get("state"),
        properties.get("condition"),
        properties.get("pokemon_condition"),
    ]));
    let language = normalize_language(&first_text(&[
        product.get("language"),
        product.get("lang"),
        properties.get("language"),
        properties.get("pokemon_language"),
        properties.get("mtg_language"),
        Some(&json!(game_language_property(&properties))),
    ]));
    let seller_comment_raw = first_text(&[
        product.get("seller_comment"),
        product.get("sellerComment"),
        product.get("seller_comments"),
        product.get("sellerComments"),
        product.get("description"),
    ]);
    let seller_comment = if is_shipping_mode_label(&seller_comment_raw) {
        String::new()
    } else {
        seller_comment_raw
    };
    json!({
        "externalListingId": product_id,
        "externalProductId": product_id,
        "cardtraderProductId": product_id,
        "blueprintId": blueprint_id,
        "cardtraderBlueprintId": blueprint_id,
        "name": first_text(&[product.get("name_en"), product.get("name"), product.pointer("/blueprint/name")]),
        "expansion": public_expansion(product),
        "price": price.get("price"),
        "priceCents": price.get("priceCents"),
        "currency": price.get("currency"),
        "displayPricePkn": display_price_pkn(price.get("price").and_then(Value::as_f64), price.get("currency").and_then(Value::as_str).unwrap_or(""), reference),
        "markupPkn": CARDTRADER_MARKUP_PKN,
        "buyerPrice": {
            "priceCents": buyer_price.get("cents").and_then(Value::as_i64),
            "currency": clean_text(buyer_price.get("currency").and_then(Value::as_str), 12),
            "formatted": clean_text(product.get("formatted_price").and_then(Value::as_str), 80),
        },
        "sellerPrice": {
            "priceCents": seller_price.get("cents").and_then(Value::as_i64),
            "currency": clean_text(seller_price.get("currency").and_then(Value::as_str), 12),
        },
        "quantity": product.get("quantity").or_else(|| product.get("qty")).and_then(Value::as_i64).unwrap_or(0).max(0),
        "condition": condition,
        "language": language,
        "description": clean_text(product.get("description").and_then(Value::as_str), 1000),
        "sellerComment": seller_comment,
        "properties": crate::cardtrader_listings::sanitize_metadata(&properties, 0),
        "rawMetadata": crate::cardtrader_listings::sanitize_metadata(product, 0),
        "shippingMode": shipping_mode,
        "shippingLabel": shipping_label_for_mode(shipping_mode),
        "seller": {
            "accountId": clean_text(
                user.get("id").or_else(|| user.get("user_id")).and_then(Value::as_str)
                    .or_else(|| product.get("seller_id").and_then(Value::as_str)),
                160,
            ),
            "accountName": PKNRESERVE_SELLER_USERNAME,
            "displayName": PKNRESERVE_SELLER_USERNAME,
            "sourceAccountName": first_text(&[user.get("username"), user.get("name"), product.get("seller_name")]),
            "country": clean_text(
                user.get("country_code").or_else(|| user.get("country")).and_then(Value::as_str)
                    .or_else(|| product.get("seller_country").and_then(Value::as_str)),
                40,
            ),
            "type": clean_text(
                user.get("user_type").and_then(Value::as_str).or_else(|| product.get("seller_type").and_then(Value::as_str)),
                80,
            ),
            "canSellViaHub": boolean_or_false(user.get("can_sell_via_hub").or_else(|| product.get("can_sell_via_hub"))),
            "canSellSealedWithCtZero": boolean_or_false(user.get("can_sell_sealed_with_ct_zero").or_else(|| product.get("can_sell_sealed_with_ct_zero"))),
            "maxSellableIn24hQuantity": user.get("max_sellable_in24h_quantity").or_else(|| product.get("max_sellable_in24h_quantity")).and_then(Value::as_i64),
        },
        "graded": product.get("graded").map(|value| value == &Value::Bool(true)),
        "onVacation": product.get("on_vacation").map(|value| value == &Value::Bool(true)),
        "bundleSize": product.get("bundle_size").and_then(Value::as_i64),
        "source": {
            "provider": PROVIDER,
            "apiPath": CARDTRADER_MARKETPLACE_PRODUCTS_PATH,
            "live": true,
            "persisted": false,
        },
    })
}

pub fn is_eligible_pokoin_listing(listing: &Value) -> bool {
    listing.get("quantity").and_then(Value::as_i64).unwrap_or(0) > 0
        && listing.get("displayPricePkn").and_then(Value::as_f64).is_some()
        && matches!(listing.get("shippingMode").and_then(Value::as_str), Some("zero") | Some("one_day_ready"))
}

/// `listingsFromMarketplacePayload`.
pub fn listings_from_payload(payload: &Value, blueprint_id: &str, limit: Option<i64>, reference: f64) -> Vec<Value> {
    let clean_blueprint = clean_numeric_id(blueprint_id);
    let products: Vec<Value> = match payload {
        Value::Array(rows) => rows.clone(),
        Value::Object(map) => map
            .get(&clean_blueprint)
            .and_then(Value::as_array)
            .cloned()
            .or_else(|| map.values().find_map(Value::as_array).cloned())
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let selected = match limit {
        Some(limit) => products.into_iter().take(limit.max(0) as usize).collect::<Vec<_>>(),
        None => products,
    };
    selected
        .iter()
        .map(|product| normalize_live_listing(product, Some(&clean_blueprint), reference))
        .filter(|listing| is_eligible_pokoin_listing(listing))
        .filter(|listing| !listing.get("externalListingId").and_then(Value::as_str).unwrap_or("").is_empty())
        .collect()
}

fn cache() -> &'static Mutex<HashMap<String, (i64, Value)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (i64, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune_cache(now_ms: i64) {
    let mut guard = cache().lock().expect("live cache");
    guard.retain(|_, (expires, _)| *expires > now_ms);
    while guard.len() > MAX_CACHE_ENTRIES {
        let Some(key) = guard.keys().next().cloned() else { break };
        guard.remove(&key);
    }
}

fn cache_key(request: &LiveRequest, blueprint_id: &str) -> String {
    format!(
        "{PROVIDER}:{blueprint_id}:{}:{}",
        request.language,
        request.limit.map(|value| value.to_string()).unwrap_or_else(|| "all".into())
    )
}

pub fn clear_cache() {
    cache().lock().expect("live cache").clear();
}

/// `readLiveCardTraderListings`.
#[allow(clippy::too_many_arguments)]
pub async fn read_live_listings(
    db: &DbPools,
    ct: &CardTraderClient,
    redis: Option<&RedisCache>,
    request: &LiveRequest,
    game: &str,
) -> ApiResult<Value> {
    let token = client::clean_token(
        &std::env::var("CARDTRADER_AUTH_TOKEN")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| std::env::var("CARDTRADER_API_TOKEN").ok())
            .unwrap_or_default(),
    );
    if token.is_empty() {
        return Err(ApiError::unavailable(
            "Global CardTrader API token is not configured. Set CARDTRADER_AUTH_TOKEN or CARDTRADER_API_TOKEN.",
        )
        .with_code("CARDTRADER_GLOBAL_API_TOKEN_MISSING"));
    }
    let reference = pkn_reference_price(std::env::var("PKN_CHECKOUT_USDT_PRICE").ok().as_deref());
    let mapping = resolve_blueprint(db, request, game).await?;
    let blueprint_id = mapping.get("cardtraderBlueprintId").and_then(Value::as_str).unwrap_or_default().to_string();
    let now_ms = crate::time_util::now_ms();
    prune_cache(now_ms);
    let key = cache_key(request, &blueprint_id);
    if let Some((expires, payload)) = cache().lock().expect("live cache").get(&key).cloned() {
        if expires > now_ms {
            let mut hit = payload;
            hit["cache"] = json!({"hit": true, "ttlSeconds": CACHE_TTL_SEC, "expiresAt": crate::time_util::iso_from_ms(expires)});
            return Ok(hit);
        }
    }
    let redis_key = crate::redis::marketplace_key(&["ct", "live", &key]);
    if let Some(redis) = redis {
        if let Some(shared) = redis.get_json(&redis_key).await {
            if let (Some(payload), Some(expires)) = (
                shared.get("payload").cloned(),
                shared.get("expiresAtMs").and_then(Value::as_i64),
            ) {
                if expires > now_ms {
                    cache().lock().expect("live cache").insert(key.clone(), (expires, payload.clone()));
                    let mut hit = payload;
                    hit["cache"] = json!({"hit": true, "ttlSeconds": CACHE_TTL_SEC, "expiresAt": crate::time_util::iso_from_ms(expires)});
                    return Ok(hit);
                }
            }
        }
    }

    let mut params: Vec<(&str, &str)> = vec![("blueprint_id", blueprint_id.as_str())];
    if !request.language.is_empty() {
        params.push(("language", request.language.as_str()));
    }
    let payload = ct.fetch_marketplace_products(&token, &params).await?;
    let listings = listings_from_payload(&payload, &blueprint_id, request.limit, reference);
    let expires_at_ms = now_ms + CACHE_TTL_MS;
    let response_payload = json!({
        "ok": true,
        "provider": PROVIDER,
        "source": "live_cardtrader_marketplace_products",
        "apiPath": CARDTRADER_MARKETPLACE_PRODUCTS_PATH,
        "liveCardTraderApiUsed": true,
        "persisted": false,
        "fetchedAt": crate::time_util::iso_from_ms(now_ms),
        "requested": {
            "id": request.requested_id,
            "param": request.requested_param,
            "blueprintId": if request.blueprint_id.is_empty() { Value::Null } else { json!(request.blueprint_id) },
            "cardId": if request.card_id.is_empty() { Value::Null } else { json!(request.card_id) },
            "language": if request.language.is_empty() { Value::Null } else { json!(request.language) },
            "limit": request.limit,
        },
        "mapping": {
            "cardtraderBlueprintId": mapping.get("cardtraderBlueprintId"),
            // `mapping.pokoinCardId || null`: an empty id is null.
            "pokoinCardId": mapping.get("pokoinCardId").filter(|value| !value.is_null() && value.as_str() != Some("")),
            "source": mapping.get("mappingSource"),
            "warning": mapping.get("warning").filter(|value| !value.as_str().unwrap_or("").is_empty()),
        },
        "cache": {"hit": false, "ttlSeconds": CACHE_TTL_SEC, "expiresAt": crate::time_util::iso_from_ms(expires_at_ms)},
        "pagination": {
            "limit": request.limit,
            "limited": request.limit.is_some(),
            "returned": listings.len(),
        },
        "count": listings.len(),
        "listings": listings,
    });
    cache()
        .lock()
        .expect("live cache")
        .insert(key, (expires_at_ms, response_payload.clone()));
    prune_cache(now_ms);
    if let Some(redis) = redis {
        let _ = redis
            .set_json(
                &redis_key,
                &json!({"payload": response_payload, "expiresAtMs": expires_at_ms}),
                std::time::Duration::from_secs(CACHE_TTL_SEC),
            )
            .await;
    }
    Ok(response_payload)
}

/// Response `cache` block on a cache hit (kept as a helper for tests).
pub fn hit_cache_block(expires_at_ms: i64, now_ms: i64) -> Value {
    json!({
        "hit": true,
        "expiresAt": crate::time_util::iso_from_ms(expires_at_ms.min(now_ms + CACHE_TTL_MS)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn request_parsing_matches_reference() {
        let request = parse_request(&q(&[("blueprintId", "123"), ("lang", "en"), ("limit", "5000")])).unwrap();
        assert_eq!(request.blueprint_id, "123");
        assert_eq!(request.language, "en");
        assert_eq!(request.limit, Some(MAX_EXPLICIT_LIMIT));
        assert!(parse_request(&q(&[("blueprintId", "abc")])).is_err());
        assert!(parse_request(&q(&[])).is_err());
        let card = parse_request(&q(&[("cardId", "248856")])).unwrap();
        assert_eq!(card.card_id, "248856");
        assert_eq!(card.requested_param, "cardId");
    }

    #[test]
    fn condition_language_and_price_helpers() {
        assert_eq!(normalize_condition("Near Mint Foil"), "NM");
        assert_eq!(normalize_condition("Slightly Played"), "SP");
        assert_eq!(normalize_language("Japanese"), "ja");
        assert_eq!(normalize_language("EN"), "EN");
        assert_eq!(display_price_pkn(Some(10.0), "EUR", 0.005), Some(2000.0));
        assert_eq!(display_price_pkn(Some(10.0), "PKN", 0.005), Some(10.0));
        assert_eq!(display_price_pkn(Some(0.0), "EUR", 0.005), None);
        assert_eq!(pkn_reference_price(Some("0.01")), 0.01);
        assert_eq!(pkn_reference_price(Some("nope")), PKN_USDT_REFERENCE_PRICE);
        assert_eq!(shipping_label_for_mode("zero"), "Zero");
        assert!(is_shipping_mode_label("CardTrader Zero"));
        assert!(!is_shipping_mode_label("great seller"));
    }

    #[test]
    fn normalization_filters_ineligible_listings() {
        let payload = json!({
            "123": [
                {"id": "10", "blueprint_id": 123, "name": "Pikachu", "quantity": 2, "price_cents": 500, "currency": "EUR",
                 "properties": {"condition": "Near Mint", "pokemon_language": "en"},
                 "user": {"id": "7", "username": "Test Seller 1-Day Ready App", "can_sell_via_hub": true}},
                {"id": "11", "blueprint_id": 123, "name": "Pikachu", "quantity": 0, "price_cents": 500, "currency": "EUR",
                 "user": {"id": "8"}}
            ]
        });
        let listings = listings_from_payload(&payload, "123", None, 0.005);
        assert_eq!(listings.len(), 1);
        assert_eq!(listings[0]["externalListingId"], "10");
        assert_eq!(listings[0]["shippingMode"], "one_day_ready");
        assert_eq!(listings[0]["displayPricePkn"], 1000.0);
        assert_eq!(listings[0]["condition"], "NM");
        let limited = listings_from_payload(&payload, "123", Some(1), 0.005);
        assert_eq!(limited.len(), 1);
    }

    #[test]
    fn shipping_mode_inference() {
        assert_eq!(infer_shipping_mode(&json!({"name": "Test Seller 1-Day Ready App"}), &json!({})), "one_day_ready");
        assert_eq!(infer_shipping_mode(&json!({}), &json!({"can_sell_via_hub": true})), "zero");
        assert_eq!(infer_shipping_mode(&json!({}), &json!({"can_sell_sealed_with_ct_zero": true})), "zero");
        assert_eq!(infer_shipping_mode(&json!({}), &json!({})), "normal");
    }
}
