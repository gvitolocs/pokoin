//! Port of the `marketplace-card-sales.js` helpers (sold graph, slices, filters,
//! last-day median) shared by card-sales and card-last-median.

use std::collections::{BTreeMap, HashMap};

use pokoin_api_common::pg::{self, Bind};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::shared::js;

pub const SOLD_CONDITION_ORDER: [&str; 5] = ["NM", "SP", "MP", "PL", "Poor"];
pub const SOLD_LANGUAGE_ORDER: [&str; 16] = ["EN", "IT", "JP", "FR", "DE", "ES", "KO", "ZH", "ZHT", "PT", "NL", "PL", "RU", "ID", "TH", "VI"];

pub const SOLD_CONDITION_SQL: &str = "
  case
    when lower(btrim(coalesce(condition, ''))) in ('nm', 'mint', 'near mint', 'near mint foil') then 'NM'
    when lower(btrim(coalesce(condition, ''))) in ('sp', 'slightly played', 'lightly played', 'lp', 'excellent', 'ex') then 'SP'
    when lower(btrim(coalesce(condition, ''))) in ('mp', 'moderately played', 'played good', 'good', 'gd') then 'MP'
    when lower(btrim(coalesce(condition, ''))) in ('poor', 'po', 'damaged', 'dmg') then 'Poor'
    when lower(btrim(coalesce(condition, ''))) in ('pl', 'played', 'poor played') then 'PL'
    else nullif(btrim(condition), '')
  end
";

pub const SOLD_LANGUAGE_SQL: &str = "
  case
    when lower(btrim(coalesce(language, ''))) in ('en', 'english') then 'EN'
    when lower(btrim(coalesce(language, ''))) in ('it', 'italian') then 'IT'
    when lower(btrim(coalesce(language, ''))) in ('fr', 'french') then 'FR'
    when lower(btrim(coalesce(language, ''))) in ('de', 'german') then 'DE'
    when lower(btrim(coalesce(language, ''))) in ('es', 'spanish') then 'ES'
    when lower(btrim(coalesce(language, ''))) in ('jp', 'ja', 'japanese') then 'JP'
    when lower(btrim(coalesce(language, ''))) in ('pt', 'portuguese') then 'PT'
    when lower(btrim(coalesce(language, ''))) in ('nl', 'dutch') then 'NL'
    when lower(btrim(coalesce(language, ''))) in ('pl', 'polish') then 'PL'
    when lower(btrim(coalesce(language, ''))) in ('ru', 'russian') then 'RU'
    when lower(btrim(coalesce(language, ''))) in ('ko', 'kr', 'korean') then 'KO'
    when lower(btrim(coalesce(language, ''))) in ('zh-tw', 'zht', 'zh_hant', 'zh-hant') then 'ZHT'
    when lower(btrim(coalesce(language, ''))) in ('zh', 'zh-cn', 'zh_hans', 'zh-hans', 'chinese') then 'ZH'
    when lower(btrim(coalesce(language, ''))) in ('id', 'indonesian', 'indonesia') then 'ID'
    else nullif(upper(btrim(language)), '')
  end
";

pub const SALES_BLUEPRINT_SQL: &str = "
  select ct_id
  from public.marketplace_search_candidates
  where card_id = $1::bigint
     or ct_id = $1::bigint
  order by
    case when card_id = $1::bigint then 0 else 1 end,
    card_id
  limit 1
";

pub const SOLD_ONCE_LISTING_SQL: &str = "
  (
    split_part(source_item_id, ':', 4) = 'quantity_decreased'
    or split_part(source_item_id, ':', 2) in (
      select split_part(source_item_id, ':', 2)
      from public.marketplace_price_observations
      where source = 'cardtrader_removed_sale'
        and split_part(source_item_id, ':', 4) is distinct from 'quantity_decreased'
      group by 1
      having count(distinct (observed_at at time zone 'utc')::date) = 1
    )
  )
";

/// `numberValue(value, fallback)`.
pub fn number_value(value: Option<&Value>, fallback: f64) -> f64 {
    let n = js::number(value);
    if n.is_finite() { n } else { fallback }
}

fn coalesce<'a>(row: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| row.get(*k)).find(|v| !v.is_null())
}

/// `Number(x.toFixed(2))`.
pub fn round_pkn(value: Option<&Value>) -> f64 {
    to_fixed(number_value(value, 0.0), 2)
}

/// `Number(n.toFixed(digits))`: JS rounds the exact binary value, half up.
pub fn to_fixed(n: f64, digits: i32) -> f64 {
    if !n.is_finite() || n.abs() >= 1e21 {
        return n;
    }
    let digits = digits.max(0) as usize;
    let exact = format!("{:.80}", n.abs());
    let (int_part, frac) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let kept = &frac[..digits.min(frac.len())];
    let round_up = frac.as_bytes().get(digits).is_some_and(|b| *b >= b'5');
    let mut number: f64 = format!("{int_part}.{kept}0").parse().unwrap_or(n.abs());
    if round_up {
        number += 10f64.powi(-(digits as i32));
        number = format!("{:.*}", digits, number).parse().unwrap_or(number);
    }
    if n < 0.0 { -number } else { number }
}

/// `dayKey(value)`.
pub fn day_key(value: Option<&Value>) -> String {
    let Some(v) = value.filter(|v| js::truthy(Some(v))) else { return String::new() };
    let text = js::js_string(v);
    if text.len() >= 10 && text.as_bytes()[4] == b'-' && text.as_bytes()[7] == b'-' && text[..10].chars().all(|c| c.is_ascii_digit() || c == '-') {
        return text[..10].to_owned();
    }
    text.chars().take(10).collect()
}

fn trunc_nonneg(n: f64) -> i64 {
    (n.trunc() as i64).max(0)
}

/// `sampleCountOf(row)`.
pub fn sample_count_of(row: &Value) -> i64 {
    let samples = trunc_nonneg(number_value(coalesce(row, &["sample_count", "sampleCount"]), 0.0));
    if samples > 0 {
        return samples;
    }
    let listings = trunc_nonneg(number_value(row.get("listings"), 0.0));
    if listings > 0 {
        return listings;
    }
    trunc_nonneg(number_value(coalesce(row, &["sold_qty", "soldQty"]), 0.0))
}

/// `commentList(value)`.
pub fn comment_list(value: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(Value::Array(items)) = value {
        for item in items {
            let text = if item.is_null() { String::new() } else { js::js_string(item).trim().to_owned() };
            if !text.is_empty() && !out.contains(&text) {
                out.push(text);
            }
        }
    }
    out.truncate(8);
    out
}

fn truthy_bool(v: Option<&Value>) -> bool {
    js::truthy(v)
}

/// `compactSoldDailySlice(row)`.
pub fn compact_sold_daily_slice(row: &Value) -> Value {
    let day = day_key(row.get("day").filter(|v| js::truthy(Some(v))).or(row.get("observed_day")));
    json!({
        "day": day,
        "condition": js::string_or_empty(row.get("condition")).trim(),
        "language": js::string_or_empty(row.get("language")).trim().to_uppercase(),
        "reverse": truthy_bool(row.get("reverse")),
        "firstEdition": truthy_bool(coalesce(row, &["first_edition", "firstEdition"])),
        "graded": truthy_bool(row.get("graded")),
        "medianPkn": pg::js_number(round_pkn(coalesce(row, &["median_pkn", "medianPkn"]))),
        "minPkn": pg::js_number(round_pkn(coalesce(row, &["min_pkn", "minPkn"]))),
        "maxPkn": pg::js_number(round_pkn(coalesce(row, &["max_pkn", "maxPkn"]))),
        "soldQty": trunc_nonneg(number_value(coalesce(row, &["sold_qty", "soldQty"]), 0.0)),
        "listings": trunc_nonneg(number_value(row.get("listings"), 0.0)),
        "sampleCount": sample_count_of(row),
        "comments": comment_list(coalesce(row, &["graded_comments", "comments"])),
    })
}

fn median_of(values: &[f64]) -> f64 {
    let mut list: Vec<f64> = values.iter().copied().filter(|n| n.is_finite() && *n > 0.0).collect();
    if list.is_empty() {
        return 0.0;
    }
    list.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = (list.len() - 1) / 2;
    if list.len() % 2 == 1 { list[mid] } else { (list[mid] + list[mid + 1]) / 2.0 }
}

/// `mergeSoldDailyRows(rows)` (insertion order of the first appearance of each day).
pub fn merge_sold_daily_rows(rows: &[Value]) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut by_day: HashMap<String, Vec<&Value>> = HashMap::new();
    for row in rows {
        let day = day_key([row.get("day"), row.get("observed_day"), row.get("observed_at")].into_iter().flatten().find(|v| js::truthy(Some(v))));
        if day.is_empty() {
            continue;
        }
        if !by_day.contains_key(&day) {
            order.push(day.clone());
        }
        by_day.entry(day).or_default().push(row);
    }
    order
        .into_iter()
        .map(|day| {
            let slices = &by_day[&day];
            let mut prices = Vec::new();
            let mut comments = Vec::new();
            let (mut min, mut max, mut sold, mut listings, mut samples) = (f64::INFINITY, 0f64, 0i64, 0i64, 0i64);
            for slice in slices {
                let median = number_value(coalesce(slice, &["median_pkn", "medianPkn"]), 0.0);
                let qty = (number_value(coalesce(slice, &["sold_qty", "soldQty"]), 1.0).trunc() as i64).max(1);
                for _ in 0..qty {
                    prices.push(median);
                }
                min = min.min(number_value(coalesce(slice, &["min_pkn", "minPkn"]), median));
                max = max.max(number_value(coalesce(slice, &["max_pkn", "maxPkn"]), median));
                sold += trunc_nonneg(number_value(coalesce(slice, &["sold_qty", "soldQty"]), 0.0));
                listings += trunc_nonneg(number_value(slice.get("listings"), 0.0));
                samples += sample_count_of(slice);
                comments.extend(comment_list(coalesce(slice, &["graded_comments", "comments"])));
            }
            let median = if slices.len() == 1 { number_value(coalesce(slices[0], &["median_pkn", "medianPkn"]), 0.0) } else { median_of(&prices) };
            json!({
                "day": day,
                "median_pkn": median,
                "min_pkn": if min.is_infinite() { 0.0 } else { min },
                "max_pkn": max,
                "sold_qty": sold,
                "listings": listings,
                "sample_count": if samples != 0 { samples } else { listings },
                "comments": comment_list(Some(&json!(comments))),
            })
        })
        .collect()
}

/// `buildSalesSeries(dayRows)`.
pub fn build_sales_series(day_rows: &[Value]) -> Value {
    let mut days: Vec<Value> = day_rows
        .iter()
        .map(|row| {
            json!({
                "day": day_key([row.get("day"), row.get("observed_day"), row.get("observed_at")].into_iter().flatten().find(|v| js::truthy(Some(v)))),
                "medianPkn": pg::js_number(round_pkn(coalesce(row, &["median_pkn", "medianPkn"]))),
                "minPkn": pg::js_number(round_pkn(coalesce(row, &["min_pkn", "minPkn"]))),
                "maxPkn": pg::js_number(round_pkn(coalesce(row, &["max_pkn", "maxPkn"]))),
                "soldQty": trunc_nonneg(number_value(coalesce(row, &["sold_qty", "soldQty"]), 0.0)),
                "listings": trunc_nonneg(number_value(row.get("listings"), 0.0)),
                "sampleCount": sample_count_of(row),
                "comments": comment_list(coalesce(row, &["comments", "graded_comments"])),
            })
        })
        .filter(|row| !js::string_or_empty(row.get("day")).is_empty() && js::number(row.get("medianPkn")) > 0.0)
        .collect();
    days.sort_by(|a, b| js::string_or_empty(a.get("day")).cmp(&js::string_or_empty(b.get("day"))));
    let mut change = Value::Null;
    if days.len() >= 2 {
        let previous = js::number(days[days.len() - 2].get("medianPkn"));
        let latest = js::number(days[days.len() - 1].get("medianPkn"));
        if previous > 0.0 {
            change = pg::js_number(to_fixed((latest - previous) / previous, 6));
        }
    }
    let sample_total: i64 = days.iter().map(|d| d["sampleCount"].as_i64().unwrap_or(0)).sum();
    let first = days.first().map(|d| d["day"].clone()).unwrap_or(Value::Null);
    let last = days.last().map(|d| d["day"].clone()).unwrap_or(Value::Null);
    let last_median = days.last().map(|d| d["medianPkn"].clone()).filter(|v| js::truthy(Some(v))).unwrap_or(Value::Null);
    json!({ "days": days, "sampleCount": sample_total, "change24hPct": change, "firstDay": first, "lastDay": last, "lastMedianPkn": last_median })
}

/// `cleanSoldCondition(value)`.
pub fn clean_sold_condition(value: &str) -> String {
    let text = value.trim();
    if SOLD_CONDITION_ORDER.contains(&text) {
        return text.to_owned();
    }
    let lowered = text.to_lowercase().split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    match lowered.as_str() {
        "nm" | "mint" | "near mint" => "NM",
        "sp" | "slightly played" | "lightly played" | "lp" => "SP",
        "mp" | "moderately played" | "good" | "gd" => "MP",
        "pl" | "played" => "PL",
        "poor" | "po" | "damaged" => "Poor",
        _ => "",
    }
    .to_owned()
}

/// `cleanSoldLanguage(value)`.
pub fn clean_sold_language(value: &str) -> String {
    let text = value.trim().to_uppercase();
    match text.as_str() {
        "" => String::new(),
        "JA" => "JP".into(),
        "KR" => "KO".into(),
        "ZH-CN" | "ZH_HANS" => "ZH".into(),
        "ZH-TW" | "ZH_HANT" => "ZHT".into(),
        t if t == "ZHT" || ((2..=3).contains(&t.len()) && t.chars().all(|c| c.is_ascii_uppercase())) => t.to_owned(),
        _ => String::new(),
    }
}

/// `cleanSoldFlag(value)`.
pub fn clean_sold_flag(value: Option<&str>) -> Option<bool> {
    let text = value?.trim().to_lowercase();
    match text.as_str() {
        "" => None,
        "1" | "true" | "yes" | "reverse" | "graded" | "first" | "1st" | "first edition" => Some(true),
        "0" | "false" | "no" | "standard" | "unlimited" | "raw" | "ungraded" => Some(false),
        _ => None,
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SoldSlice {
    pub condition: String,
    pub language: String,
    pub reverse: Option<bool>,
    pub first_edition: Option<bool>,
    pub graded: Option<bool>,
}

impl SoldSlice {
    /// `soldSliceFromSearchParams(searchParams)`.
    pub fn from_query(q: &pokoin_api_common::http::Query) -> Self {
        let first = |keys: &[&str]| keys.iter().filter_map(|k| q.search_param(k)).find(|v| !v.is_empty());
        SoldSlice {
            condition: clean_sold_condition(first(&["condition", "cond"]).unwrap_or("")),
            language: clean_sold_language(first(&["language", "lang"]).unwrap_or("")),
            reverse: clean_sold_flag(q.search_param("reverse")),
            first_edition: clean_sold_flag(first(&["firstEdition", "first_edition", "edition"])),
            graded: clean_sold_flag(q.search_param("graded")),
        }
    }

    /// `soldSlicePayload(slice)` as ordered JSON fields.
    pub fn payload(&self) -> Map<String, Value> {
        let mut m = Map::new();
        let opt = |s: &str| if s.is_empty() { Value::Null } else { json!(s) };
        m.insert("condition".into(), opt(&clean_sold_condition(&self.condition)));
        m.insert("language".into(), opt(&clean_sold_language(&self.language)));
        m.insert("reverse".into(), json!(self.reverse));
        m.insert("firstEdition".into(), json!(self.first_edition));
        m.insert("graded".into(), json!(self.graded));
        m
    }

    /// `soldSliceValues(slice)` as `$2..$6` binds.
    pub fn binds(&self) -> Vec<Bind> {
        let flag = |v: Option<bool>| v.map(Bind::Bool).unwrap_or(Bind::NullBool);
        vec![
            Bind::Text(clean_sold_condition(&self.condition)),
            Bind::Text(clean_sold_language(&self.language)),
            flag(self.reverse),
            flag(self.first_edition),
            flag(self.graded),
        ]
    }
}

fn sold_slice_sql(start: usize) -> String {
    format!(
        "
    and (${a}::text = '' or ({c}) = ${a})
    and (${b}::text = '' or ({l}) = ${b})
    and (${r}::boolean is null or reverse = ${r})
    and (${f}::boolean is null or first_edition = ${f})
    and (${g}::boolean is null or graded = ${g})
  ",
        a = start, b = start + 1, r = start + 2, f = start + 3, g = start + 4, c = SOLD_CONDITION_SQL, l = SOLD_LANGUAGE_SQL
    )
}

fn sold_daily_slice_sql(start: usize) -> String {
    format!(
        "
    and (${a}::text = '' or condition = ${a})
    and (${b}::text = '' or language = ${b})
    and (${r}::boolean is null or reverse = ${r})
    and (${f}::boolean is null or first_edition = ${f})
    and (${g}::boolean is null or graded = ${g})
  ",
        a = start, b = start + 1, r = start + 2, f = start + 3, g = start + 4
    )
}

/// `catchMissingRelation`: `Ok(None)` for 42P01/42703.
async fn rows_or_missing(pool: &PgPool, sql: &str, binds: &[Bind]) -> Result<Option<Vec<Value>>, sqlx::Error> {
    match pg::pool_rows(pool, sql, binds).await {
        Ok(rows) => Ok(Some(rows)),
        Err(error) => {
            let code = error.as_database_error().and_then(|db| db.code()).map(|c| c.into_owned()).unwrap_or_default();
            if code == "42P01" || code == "42703" {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

fn with_card(id: i64, binds: Vec<Bind>) -> Vec<Bind> {
    let mut all = vec![Bind::Text(id.to_string())];
    all.extend(binds);
    all
}

/// `readOracleSoldDailyRows(cardId, slice)` -> (missing, rows).
pub async fn read_oracle_sold_daily_rows(pool: &PgPool, card_id: i64, slice: &SoldSlice) -> Result<(bool, Vec<Value>), sqlx::Error> {
    let sql = format!(
        "
      select
        observed_day as day, condition, language, reverse, first_edition, graded,
        median_pkn, min_pkn, max_pkn, sold_qty, listings, sample_count, graded_comments
      from public.cardtrader_sold_daily
      where blueprint_id in ({SALES_BLUEPRINT_SQL})
        {}
      order by 1
    ",
        sold_daily_slice_sql(2)
    );
    Ok(match rows_or_missing(pool, &sql, &with_card(card_id, slice.binds())).await? {
        Some(rows) => (false, rows),
        None => (true, Vec::new()),
    })
}

/// `readOracleCardSalesSeries({ cardId, ...slice })`.
pub async fn read_oracle_card_sales_series(pool: &PgPool, card_id: i64, slice: &SoldSlice) -> Result<Value, sqlx::Error> {
    let (missing, rows) = read_oracle_sold_daily_rows(pool, card_id, slice).await?;
    if !missing {
        return Ok(build_sales_series(&merge_sold_daily_rows(&rows)));
    }
    let sql = format!(
        "
      select
        (observed_at at time zone 'utc')::date as day,
        percentile_cont(0.5) within group (order by price_pkn) as median_pkn,
        min(price_pkn) as min_pkn,
        max(price_pkn) as max_pkn,
        coalesce(sum(quantity), 0)::integer as sold_qty,
        count(*)::integer as listings,
        count(*)::integer as sample_count
      from public.marketplace_price_observations
      where blueprint_id in ({SALES_BLUEPRINT_SQL})
        and price_pkn > 0
        and source = 'cardtrader_removed_sale'
        and {SOLD_ONCE_LISTING_SQL}
        {}
      group by 1
      order by 1
    ",
        sold_slice_sql(2)
    );
    let rows = rows_or_missing(pool, &sql, &with_card(card_id, slice.binds())).await?.unwrap_or_default();
    Ok(build_sales_series(&rows))
}

fn row_matches_sold_slice(row: &Value, slice: &SoldSlice, omit: &str) -> bool {
    let p = slice.payload();
    let cond = p["condition"].as_str().unwrap_or("");
    let lang = p["language"].as_str().unwrap_or("");
    if omit != "condition" && !cond.is_empty() && js::string_or_empty(row.get("condition")) != cond {
        return false;
    }
    if omit != "language" && !lang.is_empty() && js::string_or_empty(row.get("language")).to_uppercase() != lang {
        return false;
    }
    if omit != "reverse" && slice.reverse.is_some() && Some(truthy_bool(row.get("reverse"))) != clean_flag_bool(slice.reverse) {
        return false;
    }
    if omit != "firstEdition" && slice.first_edition.is_some() && Some(truthy_bool(coalesce(row, &["first_edition", "firstEdition"]))) != slice.first_edition {
        return false;
    }
    if omit != "graded" && slice.graded.is_some() && Some(truthy_bool(row.get("graded"))) != slice.graded {
        return false;
    }
    true
}

fn clean_flag_bool(v: Option<bool>) -> Option<bool> {
    v
}

fn unique_ordered(values: Vec<String>, order: &[&str]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for v in values {
        let key = v.trim().to_owned();
        if !key.is_empty() && !seen.contains(&key) {
            seen.push(key);
        }
    }
    let mut ranked: Vec<String> = order.iter().filter(|k| seen.iter().any(|s| s == *k)).map(|k| (*k).to_owned()).collect();
    let mut rest: Vec<String> = seen.into_iter().filter(|k| !order.contains(&k.as_str())).collect();
    rest.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
    ranked.extend(rest);
    ranked
}

fn unique_flags(values: Vec<Option<&Value>>) -> Vec<bool> {
    let mut seen = (false, false);
    for v in values {
        match v {
            Some(Value::Bool(b)) => {
                if *b { seen.1 = true } else { seen.0 = true }
            }
            other => {
                let text = other.filter(|v| !v.is_null()).map(js::js_string).unwrap_or_default().trim().to_lowercase();
                if ["true", "t", "1", "yes"].contains(&text.as_str()) {
                    seen.1 = true;
                } else if ["false", "f", "0", "no"].contains(&text.as_str()) {
                    seen.0 = true;
                }
            }
        }
    }
    let mut out = Vec::new();
    if seen.0 {
        out.push(false);
    }
    if seen.1 {
        out.push(true);
    }
    out
}

/// `buildSalesFilters(rows, slice)`.
pub fn build_sales_filters(rows: &[Value], slice: &SoldSlice) -> Value {
    let facet = |omit: &str| rows.iter().filter(|r| row_matches_sold_slice(r, slice, omit)).collect::<Vec<_>>();
    let strs = |rs: Vec<&Value>, k: &str| rs.into_iter().map(|r| r.get(k).filter(|v| !v.is_null()).map(js::js_string).unwrap_or_default()).collect::<Vec<_>>();
    json!({
        "conditions": unique_ordered(strs(facet("condition"), "condition"), &SOLD_CONDITION_ORDER),
        "languages": unique_ordered(strs(facet("language"), "language"), &SOLD_LANGUAGE_ORDER),
        "reverse": unique_flags(facet("reverse").into_iter().map(|r| r.get("reverse")).collect()),
        "firstEdition": unique_flags(facet("firstEdition").into_iter().map(|r| coalesce(r, &["first_edition", "firstEdition"])).collect()),
        "graded": unique_flags(facet("graded").into_iter().map(|r| r.get("graded")).collect()),
    })
}

/// `readOracleSalesFilters({ cardId, ...slice })`.
pub async fn read_oracle_sales_filters(pool: &PgPool, card_id: i64, slice: &SoldSlice) -> Result<Value, sqlx::Error> {
    let sql = format!(
        "
      select distinct condition, language, reverse, first_edition, graded
      from public.cardtrader_sold_daily
      where blueprint_id in ({SALES_BLUEPRINT_SQL})
    "
    );
    if let Some(rows) = rows_or_missing(pool, &sql, &[Bind::Text(card_id.to_string())]).await? {
        return Ok(build_sales_filters(&rows, slice));
    }
    let sql = format!(
        "
      select distinct
        {SOLD_CONDITION_SQL} as condition,
        {SOLD_LANGUAGE_SQL} as language,
        reverse, first_edition, graded
      from public.marketplace_price_observations
      where blueprint_id in ({SALES_BLUEPRINT_SQL})
        and price_pkn > 0
        and source = 'cardtrader_removed_sale'
        and {SOLD_ONCE_LISTING_SQL}
    "
    );
    let rows = rows_or_missing(pool, &sql, &[Bind::Text(card_id.to_string())]).await?.unwrap_or_default();
    Ok(build_sales_filters(&rows, slice))
}

/// `timestampToIso(value)` over node-pg values (strings stay as they are).
fn timestamp_to_iso(value: Option<&Value>) -> Value {
    match value {
        Some(v) if js::truthy(Some(v)) => v.clone(),
        _ => Value::Null,
    }
}

fn clean_text(value: Option<&Value>, max: usize) -> String {
    js::clean_text(value, max)
}

/// `normalizeOracleSale(row)` + `cardId`.
pub fn normalize_oracle_sale(row: &Value, card_id: &str) -> Value {
    let observed = match timestamp_to_iso(row.get("observed_at")) {
        Value::Null => timestamp_to_iso(row.get("created_at")),
        v => v,
    };
    let order_id = {
        let s = js::string_or_empty(row.get("source_item_id"));
        if s.is_empty() { format!("oracle-{}", js::string_or_empty(row.get("id"))) } else { s }
    };
    let condition = clean_text(row.get("condition"), 40);
    json!({
        "orderId": js::clean_text_str(&order_id, 160),
        "cardId": card_id,
        "condition": if condition.is_empty() { "NM".to_owned() } else { condition },
        "language": clean_text(row.get("language"), 12).to_uppercase(),
        "pricePkn": pg::js_number(to_fixed(number_value(row.get("price_pkn"), 0.0), 6)),
        "quantity": (number_value(row.get("quantity"), 1.0).trunc() as i64).max(1),
        "soldAt": observed,
        "graded": row.get("graded") == Some(&Value::Bool(true)),
        "gradingCompany": clean_text(row.get("grading_company"), 80),
        "grade": clean_text(row.get("grade"), 40),
        "source": clean_text(row.get("source"), 80),
    })
}

/// `readOracleCardSales({ cardId, limit, ...slice })`.
pub async fn read_oracle_card_sales(pool: &PgPool, card_id: i64, limit: i64, slice: &SoldSlice) -> Result<Vec<Value>, sqlx::Error> {
    let sql = format!(
        "
      select
        id, blueprint_id, source, source_item_id, observed_at, price_pkn, quantity, condition, language,
        graded, grading_company, grade, created_at
      from public.marketplace_price_observations
      where blueprint_id in ({SALES_BLUEPRINT_SQL})
        and price_pkn > 0
        and source = 'cardtrader_removed_sale'
        and {SOLD_ONCE_LISTING_SQL}
        {}
      order by observed_at desc, created_at desc
      limit $7
    ",
        sold_slice_sql(2)
    );
    let mut binds = with_card(card_id, slice.binds());
    binds.push(Bind::Int(limit));
    let rows = rows_or_missing(pool, &sql, &binds).await?.unwrap_or_default();
    let id = card_id.to_string();
    Ok(rows
        .iter()
        .map(|row| normalize_oracle_sale(row, &id))
        .filter(|s| js::string_or_empty(s.get("cardId")) == id && js::number(s.get("pricePkn")) > 0.0 && js::truthy(s.get("soldAt")))
        .collect())
}

/// `lastMedianPayload(cardId, row, slice)`.
pub fn last_median_payload(card_id: &str, row: &Value, slice: &SoldSlice) -> Value {
    let median = round_pkn(coalesce(row, &["median_pkn", "medianPkn"]));
    let day = day_key([row.get("day"), row.get("observed_day"), row.get("observed_at")].into_iter().flatten().find(|v| js::truthy(Some(v))));
    let samples = sample_count_of(row);
    let show = !day.is_empty() && median > 0.0;
    let mut m = Map::new();
    m.insert("card_id".into(), json!(card_id));
    m.insert("day".into(), if show { json!(day) } else { Value::Null });
    m.insert("median_pkn".into(), if show { pg::js_number(median) } else { Value::Null });
    m.insert("sample_count".into(), if show && samples > 0 { json!(samples) } else { Value::Null });
    m.insert("currency".into(), json!("PKN"));
    m.insert("source".into(), json!("cardtrader_removed_sale"));
    for (k, v) in slice.payload() {
        m.insert(k, v);
    }
    Value::Object(m)
}

/// `readOracleLastMedian({ cardId, ...slice })`.
pub async fn read_oracle_last_median(pool: &PgPool, card_id: i64, slice: &SoldSlice) -> Result<Value, sqlx::Error> {
    let series = read_oracle_card_sales_series(pool, card_id, slice).await?;
    let days = series["days"].as_array().cloned().unwrap_or_default();
    let sample = days.last().and_then(|d| d["sampleCount"].as_i64()).filter(|n| *n != 0).unwrap_or(0);
    let row = json!({ "day": series["lastDay"], "median_pkn": series["lastMedianPkn"], "sample_count": sample });
    Ok(last_median_payload(&card_id.to_string(), &row, slice))
}

/// Day buckets, used in tests.
pub fn _days_of(rows: &[Value]) -> BTreeMap<String, usize> {
    let mut m = BTreeMap::new();
    for r in rows {
        *m.entry(js::string_or_empty(r.get("day"))).or_insert(0) += 1;
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slices_and_series() {
        assert_eq!(clean_sold_condition("Near-Mint"), "NM");
        assert_eq!(clean_sold_condition("excellent"), "");
        assert_eq!(clean_sold_language("ja"), "JP");
        assert_eq!(clean_sold_language("english"), "");
        assert_eq!(clean_sold_flag(Some("1st")), Some(true));
        assert_eq!(clean_sold_flag(Some("maybe")), None);
        let rows = vec![
            json!({"day": "2026-09-04", "median_pkn": "20", "sold_qty": 1, "min_pkn": "20", "max_pkn": "20", "listings": 1}),
            json!({"day": "2026-09-04", "median_pkn": "30", "sold_qty": 2, "min_pkn": "28", "max_pkn": "31", "listings": 2}),
            json!({"day": "2026-09-05", "median_pkn": "40", "sold_qty": 1, "listings": 1}),
        ];
        let merged = merge_sold_daily_rows(&rows);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0]["median_pkn"], json!(30.0));
        let series = build_sales_series(&merged);
        assert_eq!(series["lastDay"], "2026-09-05");
        assert_eq!(series["lastMedianPkn"], json!(40));
        assert_eq!(series["change24hPct"], json!(0.333333));
        assert_eq!(to_fixed(22.005, 2), 22.0);
        assert_eq!(to_fixed(1.125, 2), 1.13);
        assert_eq!(to_fixed(1.005, 2), 1.0);
        assert_eq!(to_fixed(0.3333333333, 6), 0.333333);
        assert_eq!(to_fixed(-2.5, 0), -3.0);
    }

    #[test]
    fn filters() {
        let rows = vec![json!({"condition": "NM", "language": "EN", "reverse": false, "first_edition": false, "graded": false}), json!({"condition": "SP", "language": "IT", "reverse": true, "first_edition": false, "graded": false})];
        let f = build_sales_filters(&rows, &SoldSlice::default());
        assert_eq!(f["conditions"], json!(["NM", "SP"]));
        assert_eq!(f["reverse"], json!([false, true]));
        let slice = SoldSlice { condition: "NM".into(), ..Default::default() };
        let f = build_sales_filters(&rows, &slice);
        assert_eq!(f["languages"], json!(["EN"]));
    }
}
