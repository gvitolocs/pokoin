//! `/api/marketplace-price-check` — PowerTools-style pricer. Native port of
//! `marketplace-price-check.js` (pokoin + CardTrader asks + 30-day sold median
//! + bounded listed history). TCGplayer quotes come from the separate TCGCSV
//! store and are reported as `unconfigured` here.

use serde_json::{json, Map, Value};

use crate::db::DbPools;
use crate::error::{clean_text, ApiError, ApiResult};

pub const MAX_ITEMS: usize = 100;

pub const CT_CONDITION_SETS: [(&str, &[&str]); 5] = [
    ("NM", &["nm", "mint", "near mint", "near mint foil"]),
    ("SP", &["sp", "slightly played", "lightly played", "lp", "excellent", "ex"]),
    ("MP", &["mp", "moderately played", "played good", "good", "gd"]),
    ("PL", &["pl", "played", "poor played"]),
    ("Poor", &["poor", "po", "damaged", "dmg"]),
];

pub const CT_LANGUAGE_NAMES: [(&str, &[&str]); 13] = [
    ("EN", &["english"]),
    ("IT", &["italian"]),
    ("DE", &["german"]),
    ("FR", &["french"]),
    ("ES", &["spanish"]),
    ("JP", &["japanese"]),
    ("KO", &["korean"]),
    ("PT", &["portuguese"]),
    ("NL", &["dutch"]),
    ("PL", &["polish"]),
    ("RU", &["russian"]),
    ("ZH", &["chinese"]),
    ("ZHT", &["chinese traditional", "traditional chinese"]),
];

const CONDITION_KEY_SQL: &str = "
  case
    when lower(btrim(coalesce(condition, ''))) in ('nm', 'mint', 'near mint', 'near mint foil') then 'NM'
    when lower(btrim(coalesce(condition, ''))) in ('sp', 'slightly played', 'lightly played', 'lp', 'excellent', 'ex') then 'SP'
    when lower(btrim(coalesce(condition, ''))) in ('mp', 'moderately played', 'played good', 'good', 'gd') then 'MP'
    when lower(btrim(coalesce(condition, ''))) in ('pl', 'played', 'poor played') then 'PL'
    when lower(btrim(coalesce(condition, ''))) in ('poor', 'po', 'damaged', 'dmg') then 'Poor'
    else nullif(btrim(condition), '')
  end";

const LANGUAGE_KEY_SQL: &str = "
  case
    when lower(btrim(coalesce(language, ''))) in ('en', 'english') then 'EN'
    when lower(btrim(coalesce(language, ''))) in ('it', 'italian') then 'IT'
    when lower(btrim(coalesce(language, ''))) in ('de', 'german') then 'DE'
    when lower(btrim(coalesce(language, ''))) in ('fr', 'french') then 'FR'
    when lower(btrim(coalesce(language, ''))) in ('es', 'spanish') then 'ES'
    when lower(btrim(coalesce(language, ''))) in ('jp', 'ja', 'japanese') then 'JP'
    when lower(btrim(coalesce(language, ''))) in ('ko', 'kr', 'korean') then 'KO'
    when lower(btrim(coalesce(language, ''))) in ('pt', 'portuguese') then 'PT'
    when lower(btrim(coalesce(language, ''))) in ('nl', 'dutch') then 'NL'
    when lower(btrim(coalesce(language, ''))) in ('pl', 'polish') then 'PL'
    when lower(btrim(coalesce(language, ''))) in ('ru', 'russian') then 'RU'
    when lower(btrim(coalesce(language, ''))) in ('zh', 'zh-cn', 'zh_hans', 'zh-hans', 'chinese') then 'ZH'
    when lower(btrim(coalesce(language, ''))) in ('zh-tw', 'zht', 'zh_hant', 'zh-hant') then 'ZHT'
    else nullif(upper(btrim(language)), '')
  end";

/// `LISTED_BULK_SQL`.
fn listed_bulk_sql() -> String {
    format!(
        "select blueprint_id, observed_day as dump_day,
            (refreshed_at at time zone 'utc')::date as day,
            min_price_pkn::float8 as lowest_ask_pkn, listing_count, listed_quantity, seller_count, refreshed_at
          from public.cardtrader_blueprint_daily_analytics
          where blueprint_id = any($1::bigint[])
            and observed_day between $2::text::date - 1 and $3::text::date
            and (refreshed_at at time zone 'utc')::date between $2::text::date and $3::text::date
            and min_price_pkn > 0 and listing_count > 0
          order by refreshed_at, observed_day"
    )
}

#[derive(Clone, Debug, PartialEq)]
pub struct PriceItem {
    pub card_id: String,
    pub condition: String,
    pub language: String,
    pub reverse: bool,
    pub first_edition: bool,
}

/// A listing's condition as the pricer's CardTrader condition key. Pokoin
/// stores NM, LP, SP, MP, HP, PL, PO and Poor; CardTrader groups are NM, SP
/// (Slightly Played), MP, PL (Played) and Poor. Before this, LP, HP and PO
/// matched no group and were priced from offers of any condition. The web
/// mirrors it in `pricerCondition` (market/src/inventory-price.js).
pub fn condition_key(raw: &str) -> String {
    match raw.trim().to_uppercase().as_str() {
        "" => String::new(),
        "M" | "MT" | "MINT" | "NM" | "NEAR MINT" => "NM".into(),
        "SP" | "LP" | "EX" | "EXCELLENT" | "SLIGHTLY PLAYED" | "LIGHTLY PLAYED" => "SP".into(),
        "MP" | "GD" | "GOOD" | "MODERATELY PLAYED" => "MP".into(),
        "PL" | "HP" | "PLD" | "PLAYED" | "HEAVILY PLAYED" => "PL".into(),
        "PO" | "POOR" | "DMG" | "DAMAGED" => "Poor".into(),
        other => other.to_string(),
    }
}

/// The key a comp is returned under besides the bare card id:
/// `card:CONDITION:LANGUAGE:FLAGS` (flags `R` reverse, `F` first edition), so
/// a plain and a reverse copy of one card never share a comp. The web builds
/// the same key (`priceCheckKey` in market/src/inventory-price.js).
pub fn price_check_key(item: &PriceItem) -> String {
    format!(
        "{}:{}:{}:{}{}",
        item.card_id,
        item.condition,
        item.language,
        if item.reverse { "R" } else { "" },
        if item.first_edition { "F" } else { "" },
    )
}

/// `parseItems` — `"633380:NM:IT,713648,633380:NM:IT:RF"` → items (≤ 100,
/// de-duped). The optional fourth part holds finish flags: `R` reverse holo,
/// `F` first edition.
pub fn parse_items(raw: &str) -> Vec<PriceItem> {
    let mut items = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for chunk in raw.split(',') {
        let piece = chunk.trim();
        if piece.is_empty() {
            continue;
        }
        let mut parts = piece.split(':');
        let raw_id = parts.next().unwrap_or("").trim();
        let condition = condition_key(parts.next().unwrap_or(""));
        let language = parts.next().unwrap_or("").trim().to_uppercase();
        let flags = parts.next().unwrap_or("").trim().to_uppercase();
        let card_id = raw_id.trim_start_matches('0').to_string();
        let valid = !card_id.is_empty()
            && card_id.len() <= 18
            && card_id.chars().all(|c| c.is_ascii_digit())
            && card_id != "0";
        let upper = piece.to_uppercase();
        if !valid || seen.contains(&upper) {
            continue;
        }
        seen.push(upper);
        items.push(PriceItem {
            card_id,
            condition,
            language,
            reverse: flags.contains('R'),
            first_edition: flags.contains('F'),
        });
        if items.len() >= MAX_ITEMS {
            break;
        }
    }
    items
}

/// Pokoin's CardTrader reference price: the cheapest current offer from a
/// professional (`pro`) CardTrader seller of the same printing, grouped by
/// condition, language, reverse and first edition. Private sellers' one-off
/// asks, offers of sellers on vacation and offers no dump saw for 3 days do
/// not count. `$2` lists CardTrader seller ids to leave out (a seller's own
/// offers when pricing that seller).
pub fn pro_floor_sql() -> String {
    format!(
        "select
           coalesce(blueprint_id, cardtrader_blueprint_id) as ct_id,
           {CONDITION_KEY_SQL} as condition_key,
           {LANGUAGE_KEY_SQL} as language_key,
           coalesce(properties->>'pokemon_reverse', '') = 'true' as reverse,
           (coalesce(properties->>'first_edition', '') = 'true' or coalesce(properties->>'pokemon_first_edition', '') = 'true') as first_edition,
           min(public.marketplace_price_pkn_from_cardtrader(price, price_cents, currency))::float8 as min_pkn,
           count(*)::int as offers
         from public.cardtrader_market_listing_snapshots as offer
         where coalesce(blueprint_id, cardtrader_blueprint_id) = any($1::bigint[])
           and quantity > 0
           and seller_type = 'pro'
           and last_seen_at >= now() - interval '3 days'
           and not (coalesce(seller_account_id, '') = any($2::text[]))
           and not exists (
             select 1 from public.cardtrader_seller_vacation as vacation
             where vacation.provider = 'cardtrader'
               and vacation.seller_account_id = offer.seller_account_id
               and vacation.on_vacation
           )
           and public.marketplace_price_pkn_from_cardtrader(price, price_cents, currency) > 0
         group by 1, 2, 3, 4, 5"
    )
}

/// Blueprints per pro-floor query. A whole shop at once (~1,000 blueprints,
/// ~300k offers) ran past the Pi replica's 30 s statement timeout.
pub const PRO_FLOOR_CHUNK: usize = 60;

/// Pro-floor groups per CardTrader blueprint id: `{condition, language,
/// reverse, firstEdition, minPkn, offers}`.
pub async fn pro_floors(db: &DbPools, ct_ids: &[i64], exclude_ct_sellers: &[String]) -> ApiResult<Map<String, Value>> {
    let mut groups: Map<String, Value> = Map::new();
    let mut rows = Vec::new();
    for chunk in ct_ids.chunks(PRO_FLOOR_CHUNK) {
        rows.extend(
            db.query("pokemon", &pro_floor_sql(), &[json!(chunk), json!(exclude_ct_sellers)])
                .await?,
        );
    }
    for row in &rows {
        let ct_id = row.get("ct_id").map(text_of).unwrap_or_default();
        let group = json!({
            "condition": row.get("condition_key").and_then(Value::as_str).unwrap_or(""),
            "language": row.get("language_key").and_then(Value::as_str).unwrap_or(""),
            "reverse": row.get("reverse") == Some(&Value::Bool(true)),
            "firstEdition": row.get("first_edition") == Some(&Value::Bool(true)),
            "minPkn": number(row.get("min_pkn")).unwrap_or(0.0),
            "offers": row.get("offers").and_then(Value::as_i64).unwrap_or(0),
        });
        if let Some(list) = groups.entry(ct_id).or_insert_with(|| json!([])).as_array_mut() {
            list.push(group);
        }
    }
    Ok(groups)
}

/// `pickMatchedCt` — cheapest group overall + cheapest group of the same
/// condition, language and finishes (reverse, first edition).
pub fn pick_matched_ct(
    groups: &[Value],
    condition: &str,
    language: &str,
    reverse: bool,
    first_edition: bool,
) -> (Option<f64>, Option<f64>) {
    if groups.is_empty() {
        return (None, None);
    }
    let mut cheapest = f64::INFINITY;
    let mut matched = f64::INFINITY;
    let want_condition = CT_CONDITION_SETS
        .iter()
        .find(|(key, _)| *key == condition)
        .map(|(_, values)| *values);
    let want_language: Option<Vec<String>> = CT_LANGUAGE_NAMES
        .iter()
        .find(|(key, _)| *key == language)
        .map(|(_, values)| values.iter().map(|v| v.to_string()).collect())
        .or_else(|| {
            if language.is_empty() {
                None
            } else {
                Some(vec![language.to_lowercase()])
            }
        });
    for group in groups {
        let Some(min_pkn) = number(group.get("minPkn")) else {
            continue;
        };
        if !(min_pkn > 0.0) {
            continue;
        }
        if min_pkn < cheapest {
            cheapest = min_pkn;
        }
        if want_condition.is_none() && want_language.is_none() {
            continue;
        }
        let group_condition = group.get("condition").and_then(Value::as_str).unwrap_or("").to_lowercase();
        let cond_ok = want_condition
            .map(|set| set.iter().any(|entry| *entry == group_condition))
            .unwrap_or(true);
        let group_language = group.get("language").and_then(Value::as_str).unwrap_or("").to_lowercase();
        let lang_ok = want_language
            .as_ref()
            .map(|set| set.iter().any(|entry| *entry == group_language) || group_language == language.to_lowercase())
            .unwrap_or(true);
        let finish_ok = (group.get("reverse") == Some(&Value::Bool(true))) == reverse
            && (group.get("firstEdition") == Some(&Value::Bool(true))) == first_edition;
        if cond_ok && lang_ok && finish_ok && min_pkn < matched {
            matched = min_pkn;
        }
    }
    (
        if cheapest.is_finite() { Some((cheapest * 1_000_000.0).round() / 1_000_000.0) } else { None },
        if matched.is_finite() { Some((matched * 1_000_000.0).round() / 1_000_000.0) } else { None },
    )
}

fn day(value: &Value) -> String {
    match value {
        Value::String(text) => text.get(..10).unwrap_or("").to_string(),
        _ => String::new(),
    }
}

fn count(value: &Value) -> i64 {
    value.as_i64().unwrap_or(0).max(0)
}

/// `cardtraderSource`.
pub fn cardtrader_source(rows: &[Value], status: Option<&str>) -> Value {
    let days: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "day": day(row.get("day").unwrap_or(&Value::Null)),
                "dumpDay": day(row.get("dump_day").unwrap_or(&Value::Null)),
                "lowestAskPkn": number(row.get("lowest_ask_pkn")).unwrap_or(0.0),
                "listingCount": count(row.get("listing_count").unwrap_or(&Value::Null)),
                "listedQuantity": count(row.get("listed_quantity").unwrap_or(&Value::Null)),
                "sellerCount": count(row.get("seller_count").unwrap_or(&Value::Null)),
                "sourceTimestamp": row.get("refreshed_at").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    let resolved = status.map(|s| s.to_string()).unwrap_or_else(|| {
        if rows.is_empty() { "empty".into() } else { "available".into() }
    });
    json!({
        "source": "cardtrader_listed",
        "currency": "PKN",
        "metric": "lowestAsk",
        "status": resolved,
        "conditionSpecific": false,
        "languageSpecific": false,
        "days": days,
    })
}

/// A price cell as `f64`. The shared row decoder returns `numeric` and `int8`
/// as strings (the Node shape), so `as_f64` alone read every `numeric` price
/// as missing: CardTrader and Pokoin comps were always empty in production.
fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|n| n.is_finite())
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

/// `readPrices` — per-item comps keyed by public card id.
pub async fn read_prices(db: &DbPools, items: &[PriceItem], exclude_seller_uid: &str) -> ApiResult<Value> {
    let mut ids: Vec<String> = Vec::new();
    for item in items {
        if !ids.contains(&item.card_id) {
            ids.push(item.card_id.clone());
        }
    }
    if ids.is_empty() {
        return Ok(json!({}));
    }
    let numeric_ids: Vec<i64> = ids.iter().filter_map(|id| id.parse::<i64>().ok()).collect();
    let mapping = db
        .query(
            "pokemon",
            "select card_id, ct_id from public.marketplace_search_candidates where card_id = any($1::bigint[])",
            &[json!(numeric_ids)],
        )
        .await?;
    let mut blueprint_by_card: Vec<(String, String)> = Vec::new();
    for row in &mapping {
        if let (Some(card_id), Some(ct_id)) = (
            row.get("card_id").map(text_of),
            row.get("ct_id").filter(|value| !value.is_null()).map(text_of),
        ) {
            if !ct_id.is_empty() {
                blueprint_by_card.push((card_id, ct_id));
            }
        }
    }
    let mut ct_ids: Vec<i64> = Vec::new();
    for (_, ct_id) in &blueprint_by_card {
        if let Ok(number) = ct_id.parse::<i64>() {
            if !ct_ids.contains(&number) {
                ct_ids.push(number);
            }
        }
    }

    let to = crate::time_util::iso_from_ms(crate::time_util::now_ms())
        .get(..10)
        .unwrap_or("")
        .to_string();
    let from = {
        let ms = crate::time_util::now_ms() - 29 * 86_400_000;
        crate::time_util::iso_from_ms(ms).get(..10).unwrap_or("").to_string()
    };

    let pokoin_sql = "
        select card_id, min(price_pkn)::float8 as min_pkn
        from public.marketplace_user_listings
        where card_id = any($1::text[])
          and status = 'active'
          and quantity_available > 0
          and price_pkn > 0
          and ($2::text = '' or seller_uid is distinct from $2::text)
        group by card_id";
    let pokoin_rows = db
        .query("pokemon", pokoin_sql, &[json!(ids), json!(exclude_seller_uid)])
        .await?;

    // Professional sellers only, same finishes: private one-off asks made
    // every comp look too cheap.
    let ct_groups = pro_floors(db, &ct_ids, &[]).await?;

    let sold_sql = "
        select blueprint_id,
               percentile_cont(0.5) within group (order by median_pkn) as sold_median_pkn
        from public.cardtrader_sold_daily
        where blueprint_id = any($1::bigint[])
          and observed_day >= current_date - 30
          and sold_qty > 0
          and median_pkn > 0
        group by blueprint_id";
    let sold_rows = db.query("pokemon", sold_sql, &[json!(ct_ids)]).await?;

    let listed_rows = db
        .query("pokemon", &listed_bulk_sql(), &[json!(ct_ids), json!(from), json!(to)])
        .await
        .unwrap_or_default();

    let mut prices = Map::new();
    for item in items {
        let ct_id = blueprint_by_card
            .iter()
            .find(|(card_id, _)| card_id == &item.card_id)
            .map(|(_, ct_id)| ct_id.clone());
        let groups = ct_id
            .as_ref()
            .and_then(|ct_id| ct_groups.get(ct_id))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let (ct_cheapest, ct_matched) = pick_matched_ct(&groups, &item.condition, &item.language, item.reverse, item.first_edition);
        let pokoin_cheapest = pokoin_rows
            .iter()
            .find(|row| row.get("card_id").map(text_of).as_deref() == Some(item.card_id.as_str()))
            .and_then(|row| number(row.get("min_pkn")));
        let sold_median = ct_id.as_ref().and_then(|ct_id| {
            sold_rows
                .iter()
                .find(|row| row.get("blueprint_id").map(text_of).as_deref() == Some(ct_id.as_str()))
                .and_then(|row| number(row.get("sold_median_pkn")))
        });
        let listed_days: Vec<Value> = ct_id
            .as_ref()
            .map(|ct_id| {
                listed_rows
                    .iter()
                    .filter(|row| row.get("blueprint_id").map(text_of).as_deref() == Some(ct_id.as_str()))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let comp = json!({
                "pokoinCheapestPkn": pokoin_cheapest,
                "ctCheapestPkn": ct_cheapest,
                "ctMatchedPkn": ct_matched,
                "ctBasis": "pro",
                "soldMedianPkn": sold_median,
                "cardtraderListed": cardtrader_source(&listed_days, None),
                "tcgplayer": [],
                "tcgplayerStatus": "unconfigured",
            });
        prices.insert(price_check_key(item), comp.clone());
        prices.insert(item.card_id.clone(), comp);
    }
    Ok(Value::Object(prices))
}

/// Handler helper: validate + read.
pub async fn handle(db: &DbPools, raw_items: &str, exclude_seller_uid: &str) -> ApiResult<Value> {
    let items = parse_items(raw_items);
    if items.is_empty() {
        return Err(ApiError::bad_request(
            clean_text(Some("items query param required (cardId[:COND:LANG], max 100)."), 200),
        ));
    }
    let prices = read_prices(db, &items, exclude_seller_uid).await?;
    let count = prices.as_object().map(|map| map.len()).unwrap_or(0);
    Ok(json!({ "prices": prices, "source": "pokoin+cardtrader", "count": count }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_parsing_matches_reference() {
        let items = parse_items("633380:NM:IT,713648, 000713648 ,bad,:NM");
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].card_id, "633380");
        assert_eq!(items[0].condition, "NM");
        assert_eq!(items[0].language, "IT");
        assert_eq!(items[1].card_id, "713648");
        assert_eq!(items[1].condition, "");
        // leading zeros are stripped; de-dup keys the raw chunk
        assert_eq!(items[2].card_id, "713648");
        assert!(!items[0].reverse && !items[0].first_edition);
        let flagged = parse_items("633380:NM:IT:R,633380:NM:IT:RF");
        assert!(flagged[0].reverse && !flagged[0].first_edition);
        assert!(flagged[1].reverse && flagged[1].first_edition);
        assert_eq!(price_check_key(&flagged[1]), "633380:NM:IT:RF");
        // Pokoin's LP / HP / PO are CardTrader's SP / PL / Poor.
        let pokoin = parse_items("1:LP:EN,2:HP:EN,3:PO:EN,4:poor:EN,5:MINT:EN");
        let keys: Vec<&str> = pokoin.iter().map(|item| item.condition.as_str()).collect();
        assert_eq!(keys, ["SP", "PL", "Poor", "Poor", "NM"]);
        assert_eq!(price_check_key(&items[1]), "713648:::");
    }

    #[test]
    fn matched_ct_prefers_condition_and_language() {
        let groups = vec![
            json!({"condition": "nm", "language": "english", "minPkn": 12.0}),
            json!({"condition": "sp", "language": "italian", "minPkn": 5.0}),
        ];
        let (cheapest, matched) = pick_matched_ct(&groups, "NM", "EN", false, false);
        assert_eq!(cheapest, Some(5.0));
        assert_eq!(matched, Some(12.0));
        // NM:IT matches neither group → no matched price, cheapest still reported
        let (cheapest, matched) = pick_matched_ct(&groups, "NM", "IT", false, false);
        assert_eq!(cheapest, Some(5.0));
        assert_eq!(matched, None);
        let (_, matched) = pick_matched_ct(&groups, "SP", "IT", false, false);
        assert_eq!(matched, Some(5.0));
        let (cheapest, matched) = pick_matched_ct(&groups, "", "", false, false);
        assert_eq!(cheapest, Some(5.0));
        assert_eq!(matched, None);
        assert_eq!(pick_matched_ct(&[], "NM", "EN", false, false), (None, None));
    }

    #[test]
    fn numeric_cells_decoded_as_strings_still_price() {
        assert_eq!(number(Some(&json!("38.0000000000000000"))), Some(38.0));
        assert_eq!(number(Some(&json!(22.5))), Some(22.5));
        assert_eq!(number(Some(&json!("x"))), None);
        assert_eq!(number(None), None);
        // Groups built from string cells match like numeric ones.
        let groups = vec![json!({"condition": "NM", "language": "IT", "minPkn": "22.0000"})];
        assert_eq!(pick_matched_ct(&groups, "NM", "IT", false, false).1, Some(22.0));
        assert!(pro_floor_sql().contains("::float8 as min_pkn"));
        assert!(PRO_FLOOR_CHUNK <= 100, "one query stays well inside the replica's 30 s statement timeout");
    }

    #[test]
    fn matched_ct_needs_the_same_finishes() {
        // The 2026-10-15 complaint: a reverse or first-edition listing was
        // priced from the plain printing's cheapest offer.
        let groups = vec![
            json!({"condition": "NM", "language": "IT", "reverse": false, "firstEdition": false, "minPkn": 20.0}),
            json!({"condition": "NM", "language": "IT", "reverse": true, "firstEdition": false, "minPkn": 60.0}),
        ];
        assert_eq!(pick_matched_ct(&groups, "NM", "IT", false, false).1, Some(20.0));
        assert_eq!(pick_matched_ct(&groups, "NM", "IT", true, false).1, Some(60.0));
        assert_eq!(pick_matched_ct(&groups, "NM", "IT", false, true).1, None);
    }

    #[test]
    fn pro_floor_counts_only_current_professional_offers() {
        let sql = pro_floor_sql();
        assert!(sql.contains("seller_type = 'pro'"));
        assert!(sql.contains("on_vacation"));
        assert!(sql.contains("interval '3 days'"));
        assert!(sql.contains("group by 1, 2, 3, 4, 5"), "condition, language, reverse and first edition are facets");
    }

    #[test]
    fn listed_source_shape() {
        let source = cardtrader_source(
            &[json!({"day": "2026-10-01", "dump_day": "2026-09-30", "lowest_ask_pkn": 3.5,
                     "listing_count": 2, "listed_quantity": 4, "seller_count": 1,
                     "refreshed_at": "2026-10-01T00:00:00Z"})],
            None,
        );
        assert_eq!(source["status"], "available");
        assert_eq!(source["days"][0]["lowestAskPkn"], 3.5);
        assert_eq!(source["days"][0]["listingCount"], 2);
        assert_eq!(cardtrader_source(&[], None)["status"], "empty");
        assert_eq!(cardtrader_source(&[], Some("unavailable"))["status"], "unavailable");
    }
}
