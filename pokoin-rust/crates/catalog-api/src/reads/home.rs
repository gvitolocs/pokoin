//! `GET /api/marketplace-home` — port of `marketplace-home.js` (Flutter/Pokemon home
//! snapshot; satellite games delegate to the marketplace-home-page BFF).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::pg::{self, Bind};
use pokoin_api_common::{game, http, RouteState};
use regex::Regex;
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use super::util;
use crate::shared::{card_emoji, card_versions, js};

const GENERATION_PROBE_TTL: Duration = Duration::from_secs(5 * 60);
const HOT_REFRESH_INTERVAL: &str = "2 minutes";

fn get<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    row.get(key)
}

/// `a ?? b ?? ...` over keys: the first present, non-null value.
fn nn<'a>(row: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| row.get(*k)).find(|v| !v.is_null())
}

fn s(row: &Value, key: &str) -> String {
    js::string_or_empty(row.get(key))
}

/// `a || b || ''` over keys.
fn or_s(row: &Value, keys: &[&str]) -> String {
    keys.iter().map(|k| s(row, k)).find(|v| !v.is_empty()).unwrap_or_default()
}

fn or_default(value: &str, fallback: &str) -> String {
    if value.is_empty() { fallback.to_owned() } else { value.to_owned() }
}

fn num(v: Option<&Value>) -> f64 {
    js::number(v)
}

fn collector_number_from_image_url(value: &str) -> String {
    static R: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re = R.get_or_init(|| fancy_regex::Regex::new(r"([0-9]{1,4}[A-Za-z]?)[-/]([0-9]{1,4})(?![0-9])").expect("regex"));
    match re.captures(value) {
        Ok(Some(c)) => format!("{}/{}", &c[1], &c[2]),
        _ => String::new(),
    }
}

fn clean_collector_number(value: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^#+\s*").expect("regex")).replace(value.trim(), "").into_owned()
}

pub fn has_collector_number(value: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(^|[^0-9])[0-9]{1,4}[A-Za-z]?/[0-9]{1,4}([^0-9]|$)").expect("regex")).is_match(value.trim())
}

fn projected_collector_number(row: &Value) -> String {
    let explicit = or_s(row, &["card_number", "expansion_number", "number"]).trim().to_owned();
    if !explicit.is_empty() {
        return clean_collector_number(&explicit);
    }
    collector_number_from_image_url(&or_s(row, &["cdn_image_url", "image_url", "homepage_image_url", "preview_image_url"]))
}

fn projected_rarity(row: &Value) -> String {
    let candidate = s(row, "rarity").trim().to_owned();
    let blueprint = or_s(row, &["blueprint_rarity", "collector_rarity", "pokemon_rarity"]).trim().to_owned();
    if !candidate.is_empty() && candidate.to_lowercase() != "card" {
        return candidate;
    }
    [blueprint, candidate].into_iter().find(|v| !v.is_empty()).unwrap_or_else(|| "Card".into())
}

/// `normalizeImageUrl(value)`.
fn normalize_image_url(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() {
        return String::new();
    }
    for prefix in ["https://cdn.pokoin.com", "http://cdn.pokoin.com"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            if rest.is_empty() || rest.starts_with(['/', '?', '#']) {
                let rest = rest.split('#').next().unwrap_or("");
                let rest = if rest.starts_with('/') { rest.to_owned() } else { format!("/{rest}") };
                return format!("/card-images{rest}");
            }
        }
    }
    text.to_owned()
}

fn normalize_card_images(card: &Value) -> Value {
    let mut map = card.as_object().cloned().unwrap_or_default();
    let image = s(card, "imageUrl");
    let preview = or_s(card, &["previewImageUrl", "imageUrl"]);
    let homepage = or_s(card, &["homepageImageUrl", "previewImageUrl", "imageUrl"]);
    map.insert("imageUrl".into(), json!(normalize_image_url(&image)));
    map.insert("previewImageUrl".into(), json!(normalize_image_url(&preview)));
    map.insert("homepageImageUrl".into(), json!(normalize_image_url(&homepage)));
    Value::Object(map)
}

fn is_card_trader_image_url(value: &str) -> bool {
    value.split_once("://").and_then(|(_, rest)| rest.split(['/', '?', '#']).next()).map(|host| host.eq_ignore_ascii_case("cardtrader.com")).unwrap_or(false)
}

fn has_cdn_backed_images(card: &Value) -> bool {
    let image = s(card, "imageUrl").trim().to_owned();
    let preview = or_s(card, &["previewImageUrl", "imageUrl"]).trim().to_owned();
    let homepage = or_s(card, &["homepageImageUrl", "previewImageUrl", "imageUrl"]).trim().to_owned();
    let primary = [image, preview.clone(), homepage.clone()].into_iter().find(|v| !v.is_empty()).unwrap_or_default();
    if primary.is_empty() || is_card_trader_image_url(&primary) {
        return false;
    }
    !(is_card_trader_image_url(&preview) || is_card_trader_image_url(&homepage))
}

fn card_tile_price(row: &Value) -> Value {
    let ct = num(nn(row, &["cardtrader_lowest_price_pkn", "cardtraderLowestPricePkn"]));
    let listed = num(nn(row, &["price", "lowest_price_pkn"]));
    if ct.is_finite() && ct > 0.0 && (!listed.is_finite() || listed <= 0.0 || ct <= listed) {
        return pg::js_number(ct);
    }
    if listed.is_finite() && listed > 0.0 {
        return pg::js_number(listed);
    }
    Value::Null
}

fn has_card_trader_availability(row: &Value) -> bool {
    if get(row, "hasCardTraderListing") == Some(&Value::Bool(true)) || get(row, "has_cardtrader_listing") == Some(&Value::Bool(true)) {
        return true;
    }
    let count = nn(row, &["cardtraderEligibleListingCount", "cardtrader_eligible_listing_count"]).map(|v| num(Some(v))).unwrap_or(0.0);
    if count.is_finite() && count > 0.0 {
        return true;
    }
    let quantity = nn(row, &["cardtrader_listed_quantity", "cardtraderListedQuantity"]).map(|v| num(Some(v))).unwrap_or(0.0);
    quantity.is_finite() && quantity > 0.0
}

fn finite_or_zero(n: f64) -> f64 {
    if n.is_finite() { n } else { 0.0 }
}

fn card_tile_stock(row: &Value) -> i64 {
    let explicit = finite_or_zero(num(row.get("stock")));
    let listed = finite_or_zero(num(row.get("listed_quantity")));
    let ct = finite_or_zero(nn(row, &["cardtrader_listed_quantity", "cardtraderListedQuantity"]).map(|v| num(Some(v))).unwrap_or(0.0));
    let stock = explicit.max(listed).max(ct);
    if stock > 0.0 {
        return stock.trunc() as i64;
    }
    i64::from(has_card_trader_availability(row))
}

fn count_from_row(row: &Value, keys: &[&str], nested: &[&str]) -> i64 {
    let v = nn(row, keys).or_else(|| row.get("analytics").and_then(|a| nested.iter().filter_map(|k| a.get(*k)).find(|v| !v.is_null())));
    let n = v.map(|v| num(Some(v))).unwrap_or(0.0);
    if n.is_finite() && n > 0.0 { n.trunc() as i64 } else { 0 }
}

fn to_card_json(row: &Value) -> Value {
    let rarity = projected_rarity(row);
    let number = projected_collector_number(row);
    let item_kind = if has_collector_number(&number) { "single".to_owned() } else { let k = s(row, "item_kind"); if k.is_empty() { "single".into() } else { k } };
    let product_type = if has_collector_number(&number) { "card".to_owned() } else { let p = s(row, "product_type"); if p.is_empty() { "card".into() } else { p } };
    let tags: Vec<Value> = [s(row, "set_name"), rarity.clone(), s(row, "card_type"), s(row, "trainer_name")].into_iter().filter(|v| !v.is_empty()).map(Value::String).collect();
    let mut m = Map::new();
    m.insert("id".into(), json!(match row.get("card_id") { Some(Value::Null) | None => String::new(), Some(v) => js::js_string(v) }));
    m.insert("name".into(), json!(s(row, "name")));
    m.insert("imageUrl".into(), json!(or_s(row, &["cdn_image_url", "image_url"])));
    m.insert("previewImageUrl".into(), json!(or_s(row, &["preview_image_url", "cdn_image_url", "image_url"])));
    m.insert("homepageImageUrl".into(), json!(or_s(row, &["homepage_image_url", "preview_image_url", "cdn_image_url", "image_url"])));
    m.insert("rarity".into(), json!(rarity));
    m.insert("type".into(), json!(or_default(&s(row, "card_type"), "Trading card")));
    m.insert("set".into(), json!(or_default(&s(row, "set_name"), "Pokemon")));
    m.insert("number".into(), json!(if item_kind == "product" { or_s(row, &["product_variant", "version"]) } else { number.clone() }));
    m.insert("card_number".into(), json!(number));
    m.insert("expansion_number".into(), json!(number));
    m.insert("itemKind".into(), json!(item_kind));
    m.insert("productType".into(), json!(product_type));
    m.insert("trainerName".into(), json!(s(row, "trainer_name")));
    m.insert("canonicalPath".into(), json!(s(row, "canonical_path")));
    m.insert("canonical_path".into(), json!(s(row, "canonical_path")));
    m.insert("artist".into(), json!(or_s(row, &["artist", "illustrator"])));
    m.insert("illustrator".into(), json!(or_s(row, &["illustrator", "artist"])));
    m.insert("cardPalette".into(), if js::truthy(row.get("card_palette")) { row["card_palette"].clone() } else { Value::Null });
    m.insert("emoji".into(), json!(s(row, "emoji")));
    m.insert("price".into(), card_tile_price(row));
    m.insert("priceSource".into(), json!(or_s(row, &["price_source", "homepage_cheapest_source"])));
    m.insert("homepageCheapestProvider".into(), json!(s(row, "homepage_cheapest_provider")));
    m.insert("homepageCheapestListingId".into(), json!(s(row, "homepage_cheapest_listing_id")));
    m.insert("stock".into(), json!(card_tile_stock(row)));
    m.insert("rating".into(), json!(count_from_row(row, &["watchlist_count", "watchlistCount"], &["watchlistCount"])));
    m.insert("cartHolderCount".into(), json!(count_from_row(row, &["cart_holder_count", "cartHolderCount"], &["cartHolderCount", "cart_holder_count"])));
    m.insert("reviewCount".into(), json!(0));
    m.insert("isFoil".into(), json!(false));
    m.insert("isHolo".into(), json!(projected_rarity(row).to_lowercase().contains("holo")));
    m.insert("tags".into(), Value::Array(tags));
    m.insert("condition".into(), json!("NM"));
    m.insert("isGraded".into(), json!(false));
    let truthy_num = |k: &str| if js::truthy(row.get(k)) { num(row.get(k)) } else { 0.0 };
    m.insert("hasCardTraderListing".into(), json!(row.get("has_cardtrader_listing") == Some(&Value::Bool(true)) || truthy_num("cardtrader_eligible_listing_count") > 0.0 || truthy_num("cardtrader_listed_quantity") > 0.0));
    m.insert("cardtraderEligibleListingCount".into(), pg::js_number(truthy_num("cardtrader_eligible_listing_count")));
    m.insert("cardtraderListedQuantity".into(), pg::js_number(truthy_num("cardtrader_listed_quantity")));
    m.insert("cardtraderLowestPricePkn".into(), match row.get("cardtrader_lowest_price_pkn") { None | Some(Value::Null) => Value::Null, v => pg::js_number(num(v)) });
    card_emoji::with_card_emoji_fields(&Value::Object(m))
}

fn normalize_tags(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.iter().map(|v| js::string_or_empty(Some(v)).trim().to_owned()).filter(|v| !v.is_empty()).map(Value::String).collect(),
        _ => Vec::new(),
    }
}

fn normalize_home_card(card: &Value) -> Value {
    let normalized = normalize_card_images(&card_emoji::with_card_emoji_fields(card));
    let available = has_card_trader_availability(&normalized);
    if !available {
        return normalized;
    }
    let analytics_qty = normalized.get("analytics").and_then(|a| a.get("cardtraderListedQuantity"));
    let ct_qty = nn(&normalized, &["cardtraderListedQuantity", "cardtrader_listed_quantity"]).or(analytics_qty).map(|v| num(Some(v))).unwrap_or(0.0);
    let ct_stock = if ct_qty.is_finite() && ct_qty > 0.0 { ct_qty.trunc() } else { 1.0 };
    let ct_price = nn(&normalized, &["cardtraderLowestPricePkn", "cardtrader_lowest_price_pkn"]).map(|v| num(Some(v))).unwrap_or(0.0);
    let listed = num(nn(&normalized, &["price", "lowest_price_pkn"]));
    let price = if ct_price.is_finite() && ct_price > 0.0 && (!listed.is_finite() || listed <= 0.0 || ct_price <= listed) { ct_price } else { listed };
    let mut map = normalized.as_object().cloned().unwrap_or_default();
    map.insert("hasCardTraderListing".into(), json!(true));
    let count = nn(&normalized, &["cardtraderEligibleListingCount", "cardtrader_eligible_listing_count"]).map(|v| num(Some(v))).unwrap_or(0.0);
    map.insert("cardtraderEligibleListingCount".into(), pg::js_number(count));
    let stock = if js::truthy(normalized.get("stock")) { num(normalized.get("stock")) } else { 0.0 };
    map.insert("stock".into(), pg::js_number(stock.max(ct_stock)));
    map.insert("price".into(), if price.is_finite() && price > 0.0 { pg::js_number(price) } else { normalized.get("price").cloned().unwrap_or(Value::Null) });
    map.insert("tags".into(), Value::Array(normalize_tags(normalized.get("tags")).into_iter().filter(|t| t != "NFT").collect()));
    Value::Object(map)
}

fn has_canonical_homepage_availability(card: &Value) -> bool {
    let price = num(nn(card, &["price", "lowest_price_pkn"]));
    if !price.is_finite() || price <= 0.0 {
        return false;
    }
    let source = nn(card, &["priceSource", "price_source", "homepage_cheapest_source"]).map(|v| js::js_string(v)).unwrap_or_default();
    let provider = nn(card, &["homepageCheapestProvider", "homepage_cheapest_provider"]).map(|v| js::js_string(v)).unwrap_or_default();
    matches!(source.trim(), "cheapest_homepage_cache_blueprint" | "pokoin_native_homepage_cache") || matches!(provider.trim(), "cardtrader" | "pokoin_native")
}

fn id_of(card: &Value) -> String {
    match card.get("id") {
        None | Some(Value::Null) => String::new(),
        Some(v) => js::js_string(v),
    }
}

fn ids_of(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().map(|v| js::js_string(v).trim().to_owned()).collect(),
        _ => Vec::new(),
    }
}

fn fill_section_ids(primary: &[String], fallback: &[String], available: &HashSet<String>, limit: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in primary.iter().chain(fallback.iter()) {
        if out.len() >= limit {
            break;
        }
        if id.is_empty() || out.contains(id) || !available.contains(id) {
            continue;
        }
        out.push(id.clone());
    }
    out
}

fn fallback_sections(cards: &[Value]) -> Value {
    let ids: Vec<String> = cards.iter().map(id_of).filter(|v| !v.is_empty()).collect();
    let slice = |a: usize, b: usize| ids.iter().skip(a).take(b - a).cloned().collect::<Vec<_>>();
    let featured = slice(0, 12);
    let best = slice(12, 24);
    json!({
        "recentlySeenIds": slice(24, 36),
        "bestSellerIds": if best.is_empty() { featured.clone() } else { best },
        "featuredIds": if featured.is_empty() { slice(0, 12) } else { featured },
    })
}

async fn fetch_rows_for_home_fallback(state: &RouteState, relation: &str) -> Result<Value, sqlx::Error> {
    let relation: String = relation.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '"')).collect();
    let sql = format!(
        "
      select
        marketplace_search_candidates.card_id, marketplace_search_candidates.name, marketplace_search_candidates.image_url,
        marketplace_search_candidates.cdn_image_url, marketplace_search_candidates.preview_image_url, marketplace_search_candidates.homepage_image_url,
        marketplace_search_candidates.set_name, marketplace_search_candidates.rarity, marketplace_search_candidates.card_type,
        marketplace_search_candidates.card_number, marketplace_search_candidates.product_variant, marketplace_search_candidates.item_kind,
        marketplace_search_candidates.product_type, marketplace_search_candidates.trainer_name, marketplace_search_candidates.card_palette,
        marketplace_search_candidates.emoji, marketplace_search_candidates.imported_at,
        coalesce(cardtrader.eligible_quantity, cardtrader.eligible_listing_count, 0) as listed_quantity,
        cardtrader.cheapest_price_pkn as lowest_price_pkn,
        case
          when cardtrader.provider = 'pokoin_native' then 'pokoin_native_homepage_cache'
          else 'cheapest_homepage_cache_blueprint'
        end as homepage_cheapest_source,
        cardtrader.provider as homepage_cheapest_provider,
        cardtrader.sample_listing_id as homepage_cheapest_listing_id,
        cardtrader.provider = 'cardtrader' and coalesce(cardtrader.eligible_listing_count, 0) > 0 as has_cardtrader_listing,
        case when cardtrader.provider = 'cardtrader' then coalesce(cardtrader.eligible_listing_count, 0) else 0 end as cardtrader_eligible_listing_count,
        case when cardtrader.provider = 'cardtrader' then coalesce(cardtrader.eligible_quantity, 0) else 0 end as cardtrader_listed_quantity,
        case when cardtrader.provider = 'cardtrader' then cardtrader.cheapest_price_pkn else null end as cardtrader_lowest_price_pkn,
        0 as watchlist_count,
        0 as cart_holder_count
      from {relation} cardtrader
      inner join public.marketplace_search_candidates
        on marketplace_search_candidates.ct_id = cardtrader.blueprint_id
      where cardtrader.provider in ('cardtrader', 'pokoin_native')
        and coalesce(cardtrader.eligible_listing_count, 0) > 0
        and cardtrader.cheapest_price_pkn is not null
        and cardtrader.cheapest_price_pkn > 0
        and marketplace_search_candidates.item_kind = 'single'
        and marketplace_search_candidates.product_type = 'card'
        and coalesce(
          marketplace_search_candidates.homepage_image_url,
          marketplace_search_candidates.preview_image_url,
          marketplace_search_candidates.cdn_image_url,
          marketplace_search_candidates.image_url
        ) is not null
      order by
        marketplace_search_candidates.search_weight desc nulls last,
        marketplace_search_candidates.imported_at desc nulls last,
        marketplace_search_candidates.card_id desc
      limit $1
    "
    );
    let rows = pg::pool_rows(state.api.read(), &sql, &[Bind::Int(240)]).await?;
    let cards: Vec<Value> = rows.iter().map(to_card_json).map(|c| normalize_home_card(&c)).filter(has_cdn_backed_images).filter(has_canonical_homepage_availability).collect();
    let sections = fallback_sections(&cards);
    Ok(json!({ "cards": cards, "sections": sections }))
}

fn watchlist_join(c: &str, a: &str) -> String {
    format!("
    left join public.marketplace_card_watchlist_analytics {a}
      on (
        {a}.blueprint_id = {c}.ct_id
        or {a}.blueprint_id = {c}.card_id
      )
  ")
}

fn cart_join(c: &str, a: &str) -> String {
    format!("
    left join public.marketplace_card_cart_analytics {a}
      on (
        {a}.blueprint_id = {c}.ct_id
        or {a}.blueprint_id = {c}.card_id
      )
  ")
}

async fn fetch_missing_section_cards(state: &RouteState, section_ids: &[String], existing: &HashSet<String>, relation: &str) -> Result<Vec<Value>, sqlx::Error> {
    let missing: Vec<i64> = section_ids
        .iter()
        .filter_map(|id| id.parse::<f64>().ok().filter(|n| js::is_safe_integer(*n) && *n > 0.0).map(|n| n as i64))
        .filter(|id| !existing.contains(&id.to_string()))
        .collect();
    if missing.is_empty() {
        return Ok(Vec::new());
    }
    let price = std::env::var("PKN_CHECKOUT_USDT_PRICE").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "0.005".into());
    let sql = format!(
        "
      with settings as (
        select set_config('app.pkn_usdt_price', $2::text, true)
      )
      select
        marketplace_search_candidates.card_id,
        urls.canonical_path,
        marketplace_search_candidates.name, marketplace_search_candidates.image_url, marketplace_search_candidates.cdn_image_url,
        marketplace_search_candidates.preview_image_url, marketplace_search_candidates.homepage_image_url, marketplace_search_candidates.set_name,
        coalesce(
          case
            when lower(nullif(marketplace_search_candidates.rarity, '')) <> 'card'
            then marketplace_search_candidates.rarity
            else null
          end,
          nullif(blueprints.blueprint->>'rarity', ''),
          nullif(blueprints.blueprint->>'collector_rarity', ''),
          nullif(blueprints.blueprint#>>'{{fixed_properties,pokemon_rarity}}', ''),
          nullif(marketplace_search_candidates.rarity, ''),
          'Card'
        ) as rarity,
        marketplace_search_candidates.card_type,
        coalesce(
          nullif(marketplace_search_candidates.card_number, ''),
          nullif(blueprints.version, ''),
          nullif(blueprints.blueprint->>'number', ''),
          nullif(blueprints.blueprint->>'collector_number', ''),
          nullif(blueprints.blueprint->>'card_number', ''),
          marketplace_search_candidates.card_number
        ) as card_number,
        marketplace_search_candidates.product_variant, marketplace_search_candidates.item_kind, marketplace_search_candidates.product_type,
        marketplace_search_candidates.trainer_name, marketplace_search_candidates.artist, marketplace_search_candidates.illustrator,
        marketplace_search_candidates.card_palette, marketplace_search_candidates.emoji,
        coalesce(watchlist_analytics.watchlist_count, 0) as watchlist_count,
        coalesce(cart_analytics.cart_holder_count, 0) as cart_holder_count,
        (
          coalesce(price_summary.listed_quantity, 0) +
          case
            when cardtrader.provider = 'cardtrader' then coalesce(cardtrader.eligible_quantity, 0)
            when coalesce(price_summary.listed_quantity, 0) = 0 then coalesce(cardtrader.eligible_quantity, 0)
            else 0
          end
        ) as listed_quantity,
        case
          when cardtrader.cheapest_price_pkn is not null
            and (
              price_summary.lowest_ask_pkn is null
              or cardtrader.cheapest_price_pkn <= price_summary.lowest_ask_pkn
            )
            then cardtrader.cheapest_price_pkn
          else price_summary.lowest_ask_pkn
        end as lowest_price_pkn,
        case when cardtrader.provider = 'cardtrader' then coalesce(cardtrader.eligible_quantity, 0) else 0 end as cardtrader_listed_quantity,
        case when cardtrader.provider = 'cardtrader' then cardtrader.cheapest_price_pkn else null end as cardtrader_lowest_price_pkn
      from settings,
        public.marketplace_search_candidates
      left join public.cardtrader_pokemon_blueprints blueprints
        on blueprints.id = marketplace_search_candidates.ct_id
      left join public.marketplace_blueprint_price_summary price_summary
        on price_summary.blueprint_id = marketplace_search_candidates.ct_id
      {}
      {}
      {}
      left join public.marketplace_card_urls urls
        on urls.card_id = marketplace_search_candidates.card_id
        and urls.language = 'en'
      where marketplace_search_candidates.card_id = any($1::bigint[])
        and cardtrader.cheapest_price_pkn is not null
        and cardtrader.cheapest_price_pkn > 0
        and coalesce(cardtrader.eligible_listing_count, 0) > 0
    ",
        card_versions::card_trader_availability_join("marketplace_search_candidates", relation),
        watchlist_join("marketplace_search_candidates", "watchlist_analytics"),
        cart_join("marketplace_search_candidates", "cart_analytics"),
    );
    let rows = pg::pool_rows(state.api.read(), &sql, &[Bind::BigIntArray(missing), Bind::Text(price)]).await?;
    Ok(rows.iter().map(to_card_json).collect())
}

async fn hydrate_canonical_card_trader_cache(state: &RouteState, cards: Vec<Value>, relation: &str) -> Result<Vec<Value>, sqlx::Error> {
    let mut ids: Vec<i64> = Vec::new();
    for card in &cards {
        let n = num(card.get("id"));
        if js::is_safe_integer(n) && n > 0.0 && !ids.contains(&(n as i64)) {
            ids.push(n as i64);
        }
    }
    if ids.is_empty() {
        return Ok(cards);
    }
    let sql = format!(
        "
      select distinct on (candidate_id)
        candidate_id, blueprint_id, pokoin_card_id, provider, eligible_listing_count, eligible_quantity, cheapest_price_pkn
      from (
        select
          candidate.card_id as candidate_id,
          cache.blueprint_id, cache.pokoin_card_id, cache.provider, cache.eligible_listing_count, cache.eligible_quantity, cache.cheapest_price_pkn,
          case when cache.blueprint_id = c.ct_id then 0 else 1 end as match_rank
        from unnest($1::bigint[]) as candidate(card_id)
        join public.marketplace_search_candidates c
          on c.card_id = candidate.card_id
        join {relation} cache
          on cache.provider in ('cardtrader', 'pokoin_native')
          and cache.eligible_listing_count > 0
          and cache.cheapest_price_pkn is not null
          and (
            cache.blueprint_id = c.ct_id
            or cache.pokoin_card_id = c.card_id::text
          )
      ) matches
      order by
        candidate_id,
        match_rank,
        cheapest_price_pkn asc,
        case when provider = 'pokoin_native' then 0 else 1 end,
        eligible_listing_count desc,
        blueprint_id asc,
        provider asc
    "
    );
    let rows = pg::pool_rows(state.api.read(), &sql, &[Bind::BigIntArray(ids)]).await?;
    let by_id: HashMap<String, Value> = rows.into_iter().map(|r| (js::js_string(&r["candidate_id"]), r)).collect();
    Ok(cards
        .into_iter()
        .map(|card| {
            let Some(cache) = by_id.get(&id_of(&card)) else { return card };
            let truthy_num = |k: &str| if js::truthy(cache.get(k)) { num(cache.get(k)) } else { 0.0 };
            let count = truthy_num("eligible_listing_count");
            let quantity = truthy_num("eligible_quantity");
            let price = num(cache.get("cheapest_price_pkn"));
            if !price.is_finite() || price <= 0.0 || count <= 0.0 {
                return card;
            }
            let ct = cache.get("provider").and_then(Value::as_str) == Some("cardtrader");
            let native = cache.get("provider").and_then(Value::as_str) == Some("pokoin_native");
            let mut map = card.as_object().cloned().unwrap_or_default();
            map.insert("hasCardTraderListing".into(), json!(ct));
            map.insert("cardtraderEligibleListingCount".into(), pg::js_number(if ct { count } else { 0.0 }));
            map.insert("cardtraderListedQuantity".into(), json!(if ct && quantity.is_finite() && quantity > 0.0 { quantity.trunc() as i64 } else { 0 }));
            map.insert("cardtraderLowestPricePkn".into(), if ct { pg::js_number(price) } else { Value::Null });
            if native && quantity.is_finite() && quantity > 0.0 {
                map.insert("stock".into(), json!(quantity.trunc() as i64));
            }
            map.insert("price".into(), pg::js_number(price));
            map.insert("priceSource".into(), json!(if native { "pokoin_native_homepage_cache" } else { "cheapest_homepage_cache_blueprint" }));
            map.insert("homepageCheapestProvider".into(), cache.get("provider").cloned().unwrap_or(Value::Null));
            normalize_home_card(&Value::Object(map))
        })
        .collect())
}

async fn artist_map(state: &RouteState, cards: &[Value]) -> Result<HashMap<String, (String, String)>, sqlx::Error> {
    let mut ids: Vec<i64> = Vec::new();
    for card in cards {
        let n = num(card.get("id"));
        if js::is_safe_integer(n) && n > 0.0 && !ids.contains(&(n as i64)) {
            ids.push(n as i64);
        }
    }
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = pg::pool_rows(
        state.api.read(),
        "
      select card_id, artist, illustrator
      from public.marketplace_blueprint_artists
      where marketplace_blueprint_artists.card_id = any($1::bigint[])
    ",
        &[Bind::BigIntArray(ids)],
    )
    .await?;
    Ok(rows.iter().map(|r| (js::js_string(&r["card_id"]), (or_s(r, &["artist", "illustrator"]), or_s(r, &["illustrator", "artist"])))).collect())
}

async fn refresh_hot_blueprints_if_stale(state: &RouteState) {
    let sql = "
        select case
          when coalesce(max(refreshed_at), timestamp with time zone 'epoch') < now() - $1::interval
          then public.refresh_marketplace_hot_blueprints()
          else null
        end as refreshed_count
        from public.marketplace_hot_blueprints
      ";
    if let Err(error) = pg::pool_rows(state.api.read(), sql, &[Bind::Text(HOT_REFRESH_INTERVAL.into())]).await {
        tracing::warn!(%error, "marketplace-home hot blueprint refresh skipped");
    }
}

async fn build_snapshot(state: &RouteState) -> Result<Value, sqlx::Error> {
    let relation = card_versions::cheapest_homepage_cache_relation_name(state.api.read()).await?;
    let use_sql = std::env::var("MARKETPLACE_HOME_SQL_SNAPSHOT").as_deref() == Ok("1") && std::env::var("MARKETPLACE_HOME_SQL_SNAPSHOT_DISABLED").as_deref() != Ok("1");
    let mut snapshot = fetch_rows_for_home_fallback(state, &relation).await?;
    if use_sql {
        refresh_hot_blueprints_if_stale(state).await;
        match pg::pool_rows(state.api.read(), "select public.get_marketplace_home_snapshot($1) as snapshot", &[Bind::Int(240)]).await {
            Ok(rows) => {
                if let Some(s) = rows.first().and_then(|r| r.get("snapshot")).filter(|v| js::truthy(Some(v))) {
                    snapshot = s.clone();
                }
            }
            Err(error) => tracing::warn!(%error, "marketplace-home snapshot fallback used"),
        }
    }
    let mut cards: Vec<Value> = match snapshot.get("cards") {
        Some(Value::Array(items)) => items.iter().map(normalize_home_card).filter(has_cdn_backed_images).collect(),
        _ => Vec::new(),
    };
    let mut card_ids: HashSet<String> = cards.iter().map(id_of).collect();
    let sections = snapshot.get("sections").cloned().unwrap_or(json!({}));
    let recent = ids_of(sections.get("recentlySeenIds"));
    let best = ids_of(sections.get("bestSellerIds"));
    let featured = {
        let f = ids_of(sections.get("featuredIds"));
        if !f.is_empty() { f } else if !best.is_empty() { best.clone() } else { recent.clone() }
    };
    let section_ids: Vec<String> = recent.iter().chain(best.iter()).chain(featured.iter()).cloned().collect();
    let extra = fetch_missing_section_cards(state, &section_ids, &card_ids, &relation).await?;
    for card in extra.iter().map(normalize_card_images).filter(has_cdn_backed_images) {
        let id = id_of(&card);
        if card_ids.insert(id) {
            cards.push(card);
        }
    }
    let hydrated = hydrate_canonical_card_trader_cache(state, cards, &relation).await?;
    let mut order: Vec<String> = Vec::new();
    let mut by_id: HashMap<String, Value> = HashMap::new();
    for card in hydrated.into_iter().filter(has_cdn_backed_images).filter(has_canonical_homepage_availability) {
        let id = id_of(&card);
        if id.is_empty() {
            continue;
        }
        match by_id.get(&id) {
            None => {
                order.push(id.clone());
                by_id.insert(id, card);
            }
            Some(current) => {
                if has_canonical_homepage_availability(&card) && !has_canonical_homepage_availability(current) {
                    by_id.insert(id, card);
                }
            }
        }
    }
    let available: Vec<Value> = order.iter().filter_map(|id| by_id.get(id).cloned()).collect();
    let available_ids: HashSet<String> = order.iter().cloned().collect();
    let response_cards: Vec<Value> = available.iter().take(120).cloned().collect();
    let artists = artist_map(state, &response_cards).await?;
    let merged: Vec<Value> = response_cards
        .into_iter()
        .map(|card| match artists.get(&id_of(&card)) {
            Some((artist, illustrator)) => {
                let mut map = card.as_object().cloned().unwrap_or_default();
                map.insert("artist".into(), json!(artist));
                map.insert("illustrator".into(), json!(illustrator));
                Value::Object(map)
            }
            None => card,
        })
        .collect();
    let mut out = snapshot.as_object().cloned().unwrap_or_default();
    out.insert("cards".into(), Value::Array(merged));
    out.insert(
        "sections".into(),
        json!({
            "recentlySeenIds": fill_section_ids(&recent, &order, &available_ids, 12),
            "bestSellerIds": fill_section_ids(&best, &order, &available_ids, 12),
            "featuredIds": fill_section_ids(&featured, &order, &available_ids, 12),
        }),
    );
    Ok(Value::Object(out))
}

struct Snapshot {
    key: String,
    value: Arc<Value>,
}

struct HomeCache {
    snapshot: Option<Snapshot>,
    rebuilding: bool,
    generation: String,
    probed: Option<Instant>,
}

static CACHE: Mutex<HomeCache> = Mutex::const_new(HomeCache { snapshot: None, rebuilding: false, generation: String::new(), probed: None });

async fn snapshot_key(state: &RouteState) -> String {
    let mut cache = CACHE.lock().await;
    if cache.probed.map_or(true, |at| at.elapsed() >= GENERATION_PROBE_TTL) {
        match pg::pool_rows(state.api.read(), "select max(updated_at) as refreshed_at from public.cardtrader_blueprint_listing_cache", &[]).await {
            Ok(rows) => {
                let refreshed = rows.first().and_then(|r| r.get("refreshed_at")).filter(|v| !v.is_null()).map(|v| js::js_string(v));
                cache.generation = refreshed.unwrap_or_else(|| "empty".into());
            }
            Err(error) => {
                tracing::warn!(%error, "marketplace-home generation probe failed");
                if cache.generation.is_empty() {
                    cache.generation = "unknown".into();
                }
            }
        }
        cache.probed = Some(Instant::now());
    }
    format!("{}|{}", &pg::iso(chrono::Utc::now())[..10], cache.generation)
}

async fn rebuild(state: &RouteState) -> Result<Arc<Value>, sqlx::Error> {
    let built = Arc::new(build_snapshot(state).await?);
    let key = snapshot_key(state).await;
    CACHE.lock().await.snapshot = Some(Snapshot { key, value: built.clone() });
    Ok(built)
}

async fn fetch_snapshot(state: &RouteState) -> Result<Arc<Value>, sqlx::Error> {
    let key = snapshot_key(state).await;
    let mut cache = CACHE.lock().await;
    if let Some(snapshot) = cache.snapshot.as_ref() {
        if snapshot.key == key {
            return Ok(snapshot.value.clone());
        }
        let stale = snapshot.value.clone();
        if !cache.rebuilding {
            cache.rebuilding = true;
            let state = state.clone();
            tokio::spawn(async move {
                if let Err(error) = rebuild(&state).await {
                    tracing::error!(%error, "marketplace-home background rebuild failed");
                }
                CACHE.lock().await.rebuilding = false;
            });
        }
        return Ok(stale);
    }
    drop(cache);
    rebuild(state).await
}

pub async fn handler(method: Method, State(state): State<RouteState>, headers: HeaderMap, uri: Uri) -> Response {
    if method != Method::GET {
        return util::method_not_allowed("GET");
    }
    let q = http::Query::from_uri(&uri);
    let game_id = game::parse_game_from_request(&http::header_pairs(&headers), q.first("game").filter(|v| !v.is_empty()), q.first("marketplaceGame").filter(|v| !v.is_empty()));
    if !game::is_pokemon_game(&game_id) {
        return crate::pages::home_page::handler(method, State(state), headers, uri).await;
    }
    match fetch_snapshot(&state).await {
        Ok(snapshot) => {
            let mut body = snapshot.as_object().cloned().unwrap_or_default();
            body.insert("game".into(), json!("pokemon"));
            util::json_cache(StatusCode::OK, Value::Object(body), "public, max-age=10, s-maxage=30, stale-while-revalidate=60")
        }
        Err(error) => {
            tracing::error!(%error, "marketplace-home failed");
            http::json(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "Marketplace home failed." }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_helpers() {
        assert_eq!(collector_number_from_image_url("https://x/1_pika-25-102.jpg"), "25/102");
        assert!(has_collector_number("SV 025/198"));
        assert!(!has_collector_number("SVP 044"));
        assert_eq!(normalize_image_url("https://cdn.pokoin.com/1_a.jpg?v=1"), "/card-images/1_a.jpg?v=1");
        let row = json!({"card_id": "5", "name": "Pikachu", "cdn_image_url": "https://cdn.pokoin.com/5_p.jpg", "lowest_price_pkn": "30", "cardtrader_lowest_price_pkn": "25", "listed_quantity": "2", "set_name": "Base", "rarity": "Rare Holo", "card_number": "#58/102"});
        let card = to_card_json(&row);
        assert_eq!(card["price"], json!(25));
        assert_eq!(card["stock"], json!(2));
        assert_eq!(card["number"], "58/102");
        assert_eq!(card["isHolo"], json!(true));
        let ids = vec!["1".to_owned(), "2".to_owned(), "3".to_owned()];
        let avail: HashSet<String> = ["1", "3"].iter().map(|s| s.to_string()).collect();
        assert_eq!(fill_section_ids(&ids[..1], &ids, &avail, 12), vec!["1", "3"]);
    }
}
