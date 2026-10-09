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
            min_price_pkn as lowest_ask_pkn, listing_count, listed_quantity, seller_count, refreshed_at
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
}

/// `parseItems` — `"633380:NM:IT,713648"` → items (≤ 100, de-duped).
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
        let condition = parts.next().unwrap_or("").trim().to_uppercase();
        let language = parts.next().unwrap_or("").trim().to_uppercase();
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
        items.push(PriceItem { card_id, condition, language });
        if items.len() >= MAX_ITEMS {
            break;
        }
    }
    items
}

/// `pickMatchedCt` — cheapest group overall + cheapest matching group.
pub fn pick_matched_ct(groups: &[Value], condition: &str, language: &str) -> (Option<f64>, Option<f64>) {
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
        let Some(min_pkn) = group.get("minPkn").and_then(Value::as_f64) else {
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
        if cond_ok && lang_ok && min_pkn < matched {
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
                "lowestAskPkn": row.get("lowest_ask_pkn").and_then(Value::as_f64).unwrap_or(0.0),
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
        select card_id, min(price_pkn) as min_pkn
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

    let ct_sql = format!(
        "select
           coalesce(blueprint_id, cardtrader_blueprint_id) as ct_id,
           {CONDITION_KEY_SQL} as condition_key,
           {LANGUAGE_KEY_SQL} as language_key,
           min(public.marketplace_price_pkn_from_cardtrader(price, price_cents, currency)) as min_pkn
         from public.cardtrader_market_listing_snapshots
         where coalesce(blueprint_id, cardtrader_blueprint_id) = any($1::bigint[])
           and quantity > 0
           and public.marketplace_price_pkn_from_cardtrader(price, price_cents, currency) > 0
         group by 1, 2, 3"
    );
    let ct_rows = db.query("pokemon", &ct_sql, &[json!(ct_ids)]).await?;

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

    let mut ct_groups: Map<String, Value> = Map::new();
    for row in &ct_rows {
        let ct_id = row.get("ct_id").map(text_of).unwrap_or_default();
        let group = json!({
            "condition": row.get("condition_key").and_then(Value::as_str).unwrap_or(""),
            "language": row.get("language_key").and_then(Value::as_str).unwrap_or(""),
            "minPkn": row.get("min_pkn").and_then(Value::as_f64).unwrap_or(0.0),
        });
        let entry = ct_groups.entry(ct_id).or_insert_with(|| json!([]));
        if let Some(list) = entry.as_array_mut() {
            list.push(group);
        }
    }

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
        let (ct_cheapest, ct_matched) = pick_matched_ct(&groups, &item.condition, &item.language);
        let pokoin_cheapest = pokoin_rows
            .iter()
            .find(|row| row.get("card_id").map(text_of).as_deref() == Some(item.card_id.as_str()))
            .and_then(|row| row.get("min_pkn").and_then(Value::as_f64));
        let sold_median = ct_id.as_ref().and_then(|ct_id| {
            sold_rows
                .iter()
                .find(|row| row.get("blueprint_id").map(text_of).as_deref() == Some(ct_id.as_str()))
                .and_then(|row| row.get("sold_median_pkn").and_then(Value::as_f64))
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
        prices.insert(
            item.card_id.clone(),
            json!({
                "pokoinCheapestPkn": pokoin_cheapest,
                "ctCheapestPkn": ct_cheapest,
                "ctMatchedPkn": ct_matched,
                "soldMedianPkn": sold_median,
                "cardtraderListed": cardtrader_source(&listed_days, None),
                "tcgplayer": [],
                "tcgplayerStatus": "unconfigured",
            }),
        );
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
    }

    #[test]
    fn matched_ct_prefers_condition_and_language() {
        let groups = vec![
            json!({"condition": "nm", "language": "english", "minPkn": 12.0}),
            json!({"condition": "sp", "language": "italian", "minPkn": 5.0}),
        ];
        let (cheapest, matched) = pick_matched_ct(&groups, "NM", "EN");
        assert_eq!(cheapest, Some(5.0));
        assert_eq!(matched, Some(12.0));
        // NM:IT matches neither group → no matched price, cheapest still reported
        let (cheapest, matched) = pick_matched_ct(&groups, "NM", "IT");
        assert_eq!(cheapest, Some(5.0));
        assert_eq!(matched, None);
        let (_, matched) = pick_matched_ct(&groups, "SP", "IT");
        assert_eq!(matched, Some(5.0));
        let (cheapest, matched) = pick_matched_ct(&groups, "", "");
        assert_eq!(cheapest, Some(5.0));
        assert_eq!(matched, None);
        assert_eq!(pick_matched_ct(&[], "NM", "EN"), (None, None));
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
