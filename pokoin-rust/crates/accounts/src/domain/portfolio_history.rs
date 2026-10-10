//! Collection value history — a port of `_portfolio_history_core.js`.
//!
//! Cards are marked to market on **CardTrader sold prices only**. Each held
//! printing slice (blueprint + condition + language + reverse / 1st edition /
//! graded) is worth its last sold daily median on or before that day, carried
//! forward until the slice sells again — the way portfolio trackers fill a
//! quote across days without a trade. A slice that never sold adds 0 PKN and
//! stays out of the priced count. Asks, dump minimums and other conditions' or
//! languages' sales are never used.
//!
//! Everything here is pure, so the API can price and store days without a
//! browser and the tests can run without a database.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{json, Map, Value as Json};

pub const PRICE_BASIS: &str = "ct-last-sold";
pub const SERIES_REVISION: i64 = 4;
pub const HISTORY_DAYS: i64 = 400;
/// A stored series is reused for this long. Past days are frozen anyway, so a
/// recompute only re-prices today.
pub const FRESH_MS: i64 = 15 * 60 * 1000;

/// Every sold print of the held blueprints; the slice match happens in Rust.
pub const SOLD_BY_BLUEPRINT_SQL: &str = "\
  select blueprint_id::text as blueprint_id, \
         observed_day::text as day, \
         condition, language, reverse, first_edition, graded, \
         median_pkn::float8 as median_pkn \
  from public.cardtrader_sold_daily \
  where blueprint_id = any($1::bigint[]) \
    and observed_day <= (timezone('utc', now()))::date \
    and median_pkn > 0 \
    and sold_qty > 0";

/// CardTrader 1-DR stock plus the seller's own Pokoin listings.
pub const HOLDINGS_SQL: &str = "\
  select blueprint_id, condition, language, reverse, first_edition, graded, \
         quantity, created_at::text as since \
  from public.marketplace_cardtrader_1dr_assets \
  where seller_uid = $1 and quantity > 0 \
  union all \
  select coalesce(v.blueprint_id::text, '') as blueprint_id, l.condition, l.language, \
         l.reverse, l.first_edition, l.graded, \
         l.quantity_available as quantity, l.created_at::text as since \
  from public.marketplace_user_listings l \
  left join public.marketplace_card_versions v on v.card_id::text = l.card_id \
  where l.seller_uid = $1 \
    and l.status in ('active', 'paused') \
    and l.quantity_available > 0 \
    and coalesce(l.source, '') <> 'cardtrader_seller_import'";

/// A sold price this many times the same card's other sold prices is a
/// withdrawn joke listing that looked like a sale, not a market print.
pub const SOLD_OUTLIER_RATIO: f64 = 20.0;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/// `utcDayKey` from epoch milliseconds.
pub fn utc_day_key_ms(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|value| value.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// `addUtcDays(dayKey, delta)`.
pub fn add_utc_days(day_key: &str, delta: i64) -> String {
    let Some(date) = parse_day_key(day_key) else {
        return String::new();
    };
    let shifted = date + chrono::Duration::days(delta);
    shifted.format("%Y-%m-%d").to_string()
}

fn parse_day_key(day_key: &str) -> Option<chrono::NaiveDate> {
    let text = day_key.trim();
    if text.len() < 10 {
        return None;
    }
    chrono::NaiveDate::parse_from_str(&text[..10], "%Y-%m-%d").ok()
}

/// `coerceDate(value)` — a Firestore timestamp, `{seconds}`, ISO string or ms.
pub fn coerce_date_millis(value: Option<&Json>) -> Option<i64> {
    match value? {
        Json::Null => None,
        Json::Number(number) => number.as_i64(),
        Json::String(text) => chrono::DateTime::parse_from_rfc3339(text.trim())
            .ok()
            .map(|parsed| parsed.timestamp_millis())
            .or_else(|| {
                chrono::NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d")
                    .ok()
                    .and_then(|date| date.and_hms_opt(0, 0, 0))
                    .map(|naive| naive.and_utc().timestamp_millis())
            }),
        Json::Object(fields) => fields
            .get("seconds")
            .and_then(Json::as_i64)
            .map(|seconds| seconds * 1000)
            .or_else(|| {
                fields
                    .get("_seconds")
                    .and_then(Json::as_i64)
                    .map(|seconds| seconds * 1000)
            }),
        _ => None,
    }
}

/// `dayOf(value)` — a plain `YYYY-MM-DD` stays that day, timestamps become
/// their UTC day.
pub fn day_of(value: Option<&Json>) -> String {
    if let Some(Json::String(text)) = value {
        let trimmed = text.trim();
        if trimmed.len() >= 10 {
            let head = &trimmed[..10];
            if parse_day_key(head).is_some() {
                return head.to_string();
            }
        }
    }
    coerce_date_millis(value)
        .map(utc_day_key_ms)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

pub fn non_neg(value: Option<&Json>) -> f64 {
    value
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        })
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(0.0)
}

pub fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// A JS number renders without a decimal point when it is integral.
pub fn num(value: f64) -> Json {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn field_number(row: &Json, key: &str) -> Option<f64> {
    row.get(key).and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
    })
}

fn field_bool(row: &Json, keys: &[&str]) -> bool {
    keys.iter()
        .any(|key| row.get(*key).and_then(Json::as_bool).unwrap_or(false))
}

fn field_str(row: &Json, key: &str) -> String {
    row.get(key).and_then(Json::as_str).unwrap_or("").to_string()
}

fn field_i64(row: &Json, key: &str) -> i64 {
    row.get(key)
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|number| number.trunc() as i64))
                .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        })
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Wallet series
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Movement {
    pub date: String,
    pub amount_pkn: f64,
}

/// `movementFromLedger(row)`.
pub fn movement_from_ledger(row: &Json) -> Option<Movement> {
    let amount = field_number(row, "amountPkn")?;
    if !amount.is_finite() || amount == 0.0 {
        return None;
    }
    let ledger_type = field_str(row, "type");
    let outbound = amount < 0.0
        || ledger_type.contains("sent")
        || ledger_type.contains("withdraw");
    let signed = if outbound && amount > 0.0 {
        -amount.abs()
    } else {
        amount
    };
    let date = day_of(
        row.get("createdAt")
            .or_else(|| row.get("at"))
            .or_else(|| row.get("date")),
    );
    if date.is_empty() {
        return None;
    }
    Some(Movement {
        date,
        amount_pkn: signed,
    })
}

/// `walletSeries({movements, balance, today})`.
pub fn wallet_series(movements: &[Json], balance: f64, today_key: &str) -> Vec<Json> {
    if today_key.is_empty() {
        return Vec::new();
    }
    let mut events: Vec<Movement> = movements
        .iter()
        .map(|row| {
            // A row that already carries a day and a signed amount is used as-is.
            let pre_shaped = row.get("date").and_then(Json::as_str).is_some()
                && row.get("amountPkn").is_some()
                && row.get("type").is_none();
            if pre_shaped {
                Movement {
                    date: day_of(row.get("date")),
                    amount_pkn: field_number(row, "amountPkn").unwrap_or(0.0),
                }
            } else {
                movement_from_ledger(row).unwrap_or(Movement {
                    date: String::new(),
                    amount_pkn: 0.0,
                })
            }
        })
        .filter(|movement| {
            !movement.date.is_empty()
                && movement.date.as_str() <= today_key
                && movement.amount_pkn != 0.0
        })
        .collect();
    events.sort_by(|a, b| a.date.cmp(&b.date));

    let mut by_day: BTreeMap<String, f64> = BTreeMap::new();
    let mut running = 0.0;
    for event in &events {
        running += event.amount_pkn;
        by_day.insert(event.date.clone(), running.max(0.0));
    }
    let live = non_neg(Some(&json!(balance)));
    if events.is_empty() && live == 0.0 {
        return Vec::new();
    }
    let days: Vec<String> = by_day.keys().cloned().collect();
    let mut points: Vec<Json> = Vec::new();
    let first = days.first().cloned().unwrap_or_else(|| today_key.to_string());
    let zero_date = add_utc_days(&first, -1);
    if !days.is_empty() && !zero_date.is_empty() {
        points.push(json!({ "date": zero_date, "currencyPkn": 0 }));
    }
    for date in &days {
        points.push(json!({ "date": date, "currencyPkn": num(by_day[date]) }));
    }
    // The live balance is today's truth.
    if let Some(point) = points
        .iter_mut()
        .find(|point| point.get("date").and_then(Json::as_str) == Some(today_key))
    {
        point["currencyPkn"] = num(live);
    } else {
        points.push(json!({ "date": today_key, "currencyPkn": num(live) }));
    }
    points
}

// ---------------------------------------------------------------------------
// Slice keys
// ---------------------------------------------------------------------------

/// CardTrader condition names and both Pokoin spellings (1-DR stock says LP /
/// HP / PO, the sold table says SP / PL / Poor) meet on one key.
pub fn condition_key(value: &str) -> String {
    let raw = value.trim().to_ascii_lowercase();
    let mapped = match raw.as_str() {
        "nm" | "mint" | "near mint" => "NM",
        "sp" | "lp" | "ex" | "excellent" | "slightly played" | "lightly played" => "SP",
        "mp" | "gd" | "good" | "moderately played" | "played good" => "MP",
        "pl" | "hp" | "played" | "heavily played" | "poor played" => "PL",
        "po" | "poor" | "damaged" | "dmg" => "PO",
        _ => "",
    };
    if mapped.is_empty() {
        raw.to_ascii_uppercase()
    } else {
        mapped.to_string()
    }
}

pub fn language_key(value: &str) -> String {
    let raw = value.trim().to_ascii_lowercase();
    let mapped = match raw.as_str() {
        "ja" => "JP",
        "kr" => "KO",
        "zh-cn" | "zh-hans" | "zh_hans" => "ZH",
        "zh-tw" | "zh-hant" | "zh_hant" => "ZHT",
        _ => "",
    };
    if mapped.is_empty() {
        raw.to_ascii_uppercase()
    } else {
        mapped.to_string()
    }
}

/// The same card, condition, language and finish sell as one price.
pub fn sold_slice_key(row: &Json) -> String {
    let blueprint = {
        let raw = row
            .get("blueprint_id")
            .or_else(|| row.get("blueprintId"))
            .map(|value| match value {
                Json::String(text) => text.clone(),
                Json::Number(number) => number.to_string(),
                _ => String::new(),
            })
            .unwrap_or_default();
        raw.trim().to_string()
    };
    if blueprint.is_empty() || !blueprint.bytes().all(|byte| byte.is_ascii_digit()) {
        return String::new();
    }
    [
        blueprint,
        condition_key(&field_str(row, "condition")),
        language_key(&field_str(row, "language")),
        if field_bool(row, &["reverse"]) { "R" } else { "-" }.to_string(),
        if field_bool(row, &["first_edition", "firstEdition"]) {
            "1"
        } else {
            "-"
        }
        .to_string(),
        if field_bool(row, &["graded"]) { "G" } else { "-" }.to_string(),
    ]
    .join("|")
}

/// Card + finish, any condition or language: the pool a joke price is checked
/// against.
pub fn finish_key(row: &Json) -> String {
    sold_slice_key(row)
        .split('|')
        .enumerate()
        .filter(|(index, _)| *index != 1 && *index != 2)
        .map(|(_, part)| part)
        .collect::<Vec<_>>()
        .join("|")
}

pub fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| pokoin_sort::cmp_f64(*a, *b));
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    }
}

/// `withoutSoldOutliers(rows)` — drops withdrawn joke listings.
pub fn without_sold_outliers(rows: &[Json]) -> Vec<Json> {
    struct Print {
        row: Json,
        finish: String,
        pkn: f64,
    }
    let prints: Vec<Print> = rows
        .iter()
        .filter_map(|row| {
            let pkn = field_number(row, "median_pkn")
                .or_else(|| field_number(row, "medianPkn"))
                .unwrap_or(0.0);
            let finish = finish_key(row);
            if finish.is_empty() || !(pkn > 0.0) {
                return None;
            }
            Some(Print {
                row: row.clone(),
                finish,
                pkn,
            })
        })
        .collect();

    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, entry) in prints.iter().enumerate() {
        groups.entry(entry.finish.clone()).or_default().push(index);
    }
    prints
        .iter()
        .enumerate()
        .filter(|(index, entry)| {
            let group = groups.get(&entry.finish).cloned().unwrap_or_default();
            let others: Vec<f64> = group
                .iter()
                .filter(|other| *other != index)
                .map(|other| prints[*other].pkn)
                .collect();
            others.is_empty() || entry.pkn <= median(&others) * SOLD_OUTLIER_RATIO
        })
        .map(|(_, entry)| entry.row.clone())
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct PricePoint {
    pub day: String,
    pub pkn: f64,
}

/// Sold daily medians per slice, oldest first. Joke prices are dropped first.
pub fn sold_price_book(rows: &[Json]) -> HashMap<String, Vec<PricePoint>> {
    let mut book: HashMap<String, Vec<PricePoint>> = HashMap::new();
    for row in without_sold_outliers(rows) {
        let key = sold_slice_key(&row);
        let day = day_of(row.get("day").or_else(|| row.get("observed_day")));
        let pkn = field_number(&row, "median_pkn")
            .or_else(|| field_number(&row, "medianPkn"))
            .unwrap_or(0.0);
        if key.is_empty() || day.is_empty() || !(pkn > 0.0) {
            continue;
        }
        book.entry(key).or_default().push(PricePoint { day, pkn });
    }
    for entries in book.values_mut() {
        entries.sort_by(|a, b| a.day.cmp(&b.day));
    }
    book
}

/// `priceAsOf(entries, day)` — the last sold median on or before `day`.
pub fn price_as_of(entries: Option<&Vec<PricePoint>>, day: &str) -> Option<PricePoint> {
    let entries = entries?;
    if entries.is_empty() || day.is_empty() {
        return None;
    }
    let mut lo = 0usize;
    let mut hi = entries.len() as i64 - 1;
    let mut hit: Option<PricePoint> = None;
    while lo as i64 <= hi {
        let mid = ((lo as i64 + hi) >> 1) as usize;
        if entries[mid].day.as_str() <= day {
            hit = Some(entries[mid].clone());
            lo = mid + 1;
        } else {
            hi = mid as i64 - 1;
        }
    }
    hit
}

/// `lastSoldFor(row, book, day)` — `{pkn, day}` or nothing.
pub fn last_sold_for(
    row: &Json,
    book: &HashMap<String, Vec<PricePoint>>,
    day: &str,
) -> Option<PricePoint> {
    let hit = price_as_of(book.get(&sold_slice_key(row)), day)?;
    Some(PricePoint {
        day: hit.day,
        pkn: round2(hit.pkn),
    })
}

// ---------------------------------------------------------------------------
// Holdings and valuation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Holding {
    pub key: String,
    pub qty: i64,
    pub since: String,
}

/// 1-DR stock rows as holdings that count from the day each was first synced.
pub fn holding_slices(rows: &[Json]) -> Vec<Holding> {
    rows.iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let qty = (field_i64(row, "quantity")).max(0);
            if qty == 0 {
                return None;
            }
            let key = {
                let computed = sold_slice_key(row);
                if computed.is_empty() {
                    format!("unpriced|{index}")
                } else {
                    computed
                }
            };
            Some(Holding {
                key,
                qty,
                since: day_of(
                    row.get("since")
                        .or_else(|| row.get("created_at"))
                        .or_else(|| row.get("createdAt")),
                ),
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct HoldingsValue {
    pub cards_value_pkn: f64,
    pub cards_priced: i64,
    pub cards_held: i64,
}

/// Cards held on `day`, priced at each slice's last sale. `None` when nothing
/// was held.
pub fn value_holdings_on(
    holdings: &[Holding],
    book: &HashMap<String, Vec<PricePoint>>,
    day: &str,
) -> Option<HoldingsValue> {
    let mut held = 0i64;
    let mut priced = 0i64;
    let mut value = 0.0;
    for holding in holdings {
        if !holding.since.is_empty() && holding.since.as_str() > day {
            continue;
        }
        held += holding.qty;
        let Some(hit) = price_as_of(book.get(&holding.key), day) else {
            continue;
        };
        priced += holding.qty;
        value += holding.qty as f64 * hit.pkn;
    }
    if held == 0 {
        return None;
    }
    Some(HoldingsValue {
        cards_value_pkn: round2(value),
        cards_priced: priced,
        cards_held: held,
    })
}

/// Price move of the same basket from `prev_day` to `day`: only slices held and
/// priced on both days, like an index whose new members do not count as a
/// return.
pub fn basket_move(
    holdings: &[Holding],
    book: &HashMap<String, Vec<PricePoint>>,
    day: &str,
    prev_day: &str,
) -> Option<f64> {
    let mut before = 0.0;
    let mut after = 0.0;
    for holding in holdings {
        if !holding.since.is_empty() && holding.since.as_str() > prev_day {
            continue;
        }
        let entries = book.get(&holding.key);
        let Some(was) = price_as_of(entries, prev_day) else {
            continue;
        };
        before += holding.qty as f64 * was.pkn;
        let now = price_as_of(entries, day).map(|point| point.pkn).unwrap_or(was.pkn);
        after += holding.qty as f64 * now;
    }
    if before > 0.0 {
        Some(((after / before - 1.0) * 1e6).round() / 1e6)
    } else {
        None
    }
}

/// `compactDay(row)` — the stored public day shape.
pub fn compact_day(row: &Json) -> Option<Json> {
    let date = day_of(row.get("date"));
    if date.is_empty() {
        return None;
    }
    let currency_pkn = round2(non_neg(row.get("currencyPkn")));
    let held = field_i64(row, "cardsHeld").max(0);
    let raw_cards_value = row.get("cardsValuePkn");
    let has_value = raw_cards_value
        .map(|value| !value.is_null() && value.as_str() != Some(""))
        .unwrap_or(false);
    let cards_known_flag = row
        .get("cardsKnown")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let has_cards = has_value && (held > 0 || cards_known_flag);
    let cards_value_pkn = if has_cards {
        Some(round2(non_neg(raw_cards_value)))
    } else {
        None
    };
    let cards_priced = if has_cards {
        held.min(field_i64(row, "cardsPriced").max(0))
    } else {
        0
    };
    let cards_move = if has_cards {
        row.get("cardsMove")
            .filter(|value| !value.is_null())
            .and_then(|value| {
                value
                    .as_f64()
                    .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
            })
            .filter(|value| value.is_finite())
    } else {
        None
    };
    let total = currency_pkn + cards_value_pkn.unwrap_or(0.0);
    Some(json!({
        "date": date,
        "currencyPkn": num(currency_pkn),
        "cardsValuePkn": cards_value_pkn.map(num).unwrap_or(Json::Null),
        "cardsKnown": cards_value_pkn.is_some(),
        "cardsPriced": cards_priced,
        "cardsHeld": if has_cards { held } else { 0 },
        "cardsMove": cards_move.map(num).unwrap_or(Json::Null),
        "totalPkn": num(round2(total)),
    }))
}

/// `cleanDays(value)`.
pub fn clean_days(value: Option<&Json>) -> Vec<Json> {
    value
        .and_then(Json::as_array)
        .map(|rows| rows.iter().filter_map(compact_day).collect())
        .unwrap_or_default()
}

/// Card values of days that had already ended when the series was stored. The
/// 1-DR table only knows today's stock, so re-pricing those days would erase
/// cards that have since sold. Another basis or revision is discarded.
pub fn frozen_card_days(doc: Option<&Json>, today_key: &str) -> BTreeMap<String, Json> {
    let mut frozen = BTreeMap::new();
    let Some(doc) = doc else {
        return frozen;
    };
    if doc.get("priceBasis").and_then(Json::as_str) != Some(PRICE_BASIS) {
        return frozen;
    }
    if doc.get("seriesRevision").and_then(Json::as_i64) != Some(SERIES_REVISION) {
        return frozen;
    }
    let Some(rows) = doc.get("days").and_then(Json::as_array) else {
        return frozen;
    };
    for row in rows {
        let Some(day) = compact_day(row) else {
            continue;
        };
        let date = day.get("date").and_then(Json::as_str).unwrap_or("");
        if date.is_empty() || !(date < today_key) {
            continue;
        }
        // A day stored without cards has nothing to protect: re-price it.
        if day.get("cardsValuePkn").map(Json::is_null).unwrap_or(true) {
            continue;
        }
        frozen.insert(
            date.to_string(),
            json!({
                "cardsValuePkn": day["cardsValuePkn"].clone(),
                "cardsPriced": day["cardsPriced"].clone(),
                "cardsHeld": day["cardsHeld"].clone(),
                "cardsMove": day["cardsMove"].clone(),
            }),
        );
    }
    frozen
}

/// `buildDailySeries({wallet, holdings, book, frozen, today})`.
pub fn build_daily_series(
    wallet: &[Json],
    holdings: &[Holding],
    book: &HashMap<String, Vec<PricePoint>>,
    frozen: &BTreeMap<String, Json>,
    today_key: &str,
) -> Vec<Json> {
    if today_key.is_empty() {
        return Vec::new();
    }
    let mut wallet_days: Vec<(String, f64)> = wallet
        .iter()
        .map(|row| {
            (
                day_of(row.get("date")),
                non_neg(row.get("currencyPkn")),
            )
        })
        .filter(|(date, _)| !date.is_empty() && date.as_str() <= today_key)
        .collect();
    wallet_days.sort_by(|a, b| a.0.cmp(&b.0));

    let mut starts: BTreeSet<String> = BTreeSet::new();
    if let Some((date, _)) = wallet_days.first() {
        starts.insert(date.clone());
    }
    for holding in holdings {
        let candidate = if holding.since.is_empty() {
            today_key.to_string()
        } else {
            holding.since.clone()
        };
        if candidate.as_str() <= today_key {
            starts.insert(candidate);
        }
    }
    for date in frozen.keys() {
        if date.as_str() <= today_key {
            starts.insert(date.clone());
        }
    }
    let Some(start) = starts.iter().next().cloned() else {
        return Vec::new();
    };

    let floor = add_utc_days(today_key, -(HISTORY_DAYS - 1));
    let start = if !floor.is_empty() && start.as_str() < floor.as_str() {
        floor
    } else {
        start
    };

    let mut points: Vec<Json> = Vec::new();
    let mut currency = 0.0;
    let mut next = 0usize;
    let mut date = start.clone();
    let mut guard = 0i64;
    while !date.is_empty() && date.as_str() <= today_key && guard <= HISTORY_DAYS {
        guard += 1;
        while next < wallet_days.len() && wallet_days[next].0.as_str() <= date.as_str() {
            currency = wallet_days[next].1;
            next += 1;
        }
        let cards = if let Some(frozen_day) = frozen.get(&date) {
            Some(frozen_day.clone())
        } else {
            value_holdings_on(holdings, book, &date).map(|value| {
                json!({
                    "cardsValuePkn": num(value.cards_value_pkn),
                    "cardsPriced": value.cards_priced,
                    "cardsHeld": value.cards_held,
                })
            })
        };
        let mut cards = cards;
        if let Some(cards) = cards.as_mut() {
            if !frozen.contains_key(&date) && date.as_str() > start.as_str() {
                if let Some(object) = cards.as_object_mut() {
                    let moved = basket_move(holdings, book, &date, &add_utc_days(&date, -1))
                        .map(num)
                        .unwrap_or(Json::Null);
                    object.insert("cardsMove".into(), moved);
                }
            }
        }
        let mut row = Map::new();
        row.insert("date".into(), json!(date));
        row.insert("currencyPkn".into(), num(currency));
        if let Some(cards) = cards.as_ref().and_then(Json::as_object) {
            for (key, value) in cards {
                row.insert(key.clone(), value.clone());
            }
        }
        if let Some(day) = compact_day(&Json::Object(row)) {
            points.push(day);
        }
        let next_date = add_utc_days(&date, 1);
        if next_date == date {
            break;
        }
        date = next_date;
    }
    points
}

/// `storedIsFresh(doc, now)`.
pub fn stored_is_fresh(doc: Option<&Json>, now_ms: i64) -> bool {
    let Some(doc) = doc else {
        return false;
    };
    if doc.get("priceBasis").and_then(Json::as_str) != Some(PRICE_BASIS) {
        return false;
    }
    if doc.get("seriesRevision").and_then(Json::as_i64) != Some(SERIES_REVISION) {
        return false;
    }
    let Some(at) = coerce_date_millis(doc.get("updatedAt")) else {
        return false;
    };
    if utc_day_key_ms(at) != utc_day_key_ms(now_ms) {
        return false;
    }
    let age = now_ms - at;
    (0..FRESH_MS).contains(&age)
}

/// Whether a stored series is at least on the current basis and revision.
pub fn stored_is_current(doc: Option<&Json>) -> bool {
    let Some(doc) = doc else {
        return false;
    };
    doc.get("priceBasis").and_then(Json::as_str) == Some(PRICE_BASIS)
        && doc.get("seriesRevision").and_then(Json::as_i64) == Some(SERIES_REVISION)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(rows: &[(&str, &[(&str, f64)])]) -> HashMap<String, Vec<PricePoint>> {
        rows.iter()
            .map(|(key, points)| {
                (
                    (*key).to_string(),
                    points
                        .iter()
                        .map(|(day, pkn)| PricePoint {
                            day: (*day).to_string(),
                            pkn: *pkn,
                        })
                        .collect(),
                )
            })
            .collect()
    }

    #[test]
    fn day_maths_handles_edges() {
        assert_eq!(add_utc_days("2026-10-08", 1), "2026-10-09");
        assert_eq!(add_utc_days("2026-10-08", -1), "2026-10-07");
        assert_eq!(add_utc_days("2026-03-01", -1), "2026-02-28");
        assert_eq!(add_utc_days("2026-01-01", -1), "2025-12-31");
        assert_eq!(add_utc_days("bad", 1), "");
        assert_eq!(utc_day_key_ms(1_791_417_600_000), "2026-10-08");
    }

    #[test]
    fn day_of_prefers_a_plain_day_key() {
        assert_eq!(day_of(Some(&json!("2026-10-08"))), "2026-10-08");
        assert_eq!(day_of(Some(&json!("2026-10-08T12:00:00Z"))), "2026-10-08");
        assert_eq!(day_of(Some(&json!({ "seconds": 1_791_417_600 }))), "2026-10-08");
        assert_eq!(day_of(Some(&json!("nonsense"))), "");
        assert_eq!(day_of(None), "");
    }

    #[test]
    fn condition_and_language_aliases_collapse() {
        for (input, expected) in [
            ("nm", "NM"),
            ("MINT", "NM"),
            ("Near Mint", "NM"),
            ("lp", "SP"),
            ("EX", "SP"),
            ("excellent", "SP"),
            ("Slightly Played", "SP"),
            ("hp", "PL"),
            ("Poor", "PO"),
            ("dmg", "PO"),
            ("weird", "WEIRD"),
        ] {
            assert_eq!(condition_key(input), expected, "{input}");
        }
        for (input, expected) in [
            ("ja", "JP"),
            ("kr", "KO"),
            ("zh-cn", "ZH"),
            ("zh_hant", "ZHT"),
            ("en", "EN"),
        ] {
            assert_eq!(language_key(input), expected, "{input}");
        }
    }

    #[test]
    fn sold_slice_keys_separate_every_facet() {
        let base = json!({
            "blueprint_id": "12345", "condition": "lp", "language": "ja",
            "reverse": false, "first_edition": false, "graded": false
        });
        assert_eq!(sold_slice_key(&base), "12345|SP|JP|-|-|-");
        let mut reverse = base.clone();
        reverse["reverse"] = json!(true);
        assert_eq!(sold_slice_key(&reverse), "12345|SP|JP|R|-|-");
        let mut graded = base.clone();
        graded["graded"] = json!(true);
        assert_eq!(sold_slice_key(&graded), "12345|SP|JP|-|-|G");
        // The finish key drops condition and language.
        assert_eq!(finish_key(&base), "12345|-|-|-");
        // A non-numeric or missing blueprint has no key at all.
        assert_eq!(sold_slice_key(&json!({ "blueprint_id": "abc" })), "");
        assert_eq!(sold_slice_key(&json!({})), "");
        // A numeric blueprint in the camelCase spelling works too.
        assert_eq!(
            sold_slice_key(&json!({ "blueprintId": 7, "condition": "NM" })),
            "7|NM||-|-|-"
        );
    }

    #[test]
    fn median_handles_odd_and_even_lengths() {
        assert_eq!(median(&[]), 0.0);
        assert_eq!(median(&[3.0]), 3.0);
        assert_eq!(median(&[3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&[1.0, 2.0, 3.0, 4.0]), 2.5);
    }

    #[test]
    fn joke_listings_are_dropped_from_the_price_book() {
        // The documented case: a 3,243,020 PKN print against ~22 PKN peers.
        let rows = vec![
            json!({ "blueprint_id": "1", "condition": "NM", "language": "EN",
                    "median_pkn": 22.0, "day": "2026-09-20" }),
            json!({ "blueprint_id": "1", "condition": "SP", "language": "EN",
                    "median_pkn": 20.0, "day": "2026-09-21" }),
            json!({ "blueprint_id": "1", "condition": "NM", "language": "EN",
                    "median_pkn": 3_243_020.0, "day": "2026-09-22" }),
        ];
        let kept = without_sold_outliers(&rows);
        assert_eq!(kept.len(), 2, "the outlier must be dropped");
        assert!(kept
            .iter()
            .all(|row| row["median_pkn"].as_f64().unwrap() < 1000.0));
        // A lone print is never an outlier.
        let single = vec![json!({ "blueprint_id": "1", "condition": "NM", "median_pkn": 9999.0 })];
        assert_eq!(without_sold_outliers(&single).len(), 1);
        // Rows without a usable price or finish are not prints at all.
        let empty = vec![json!({ "blueprint_id": "1", "median_pkn": 0 })];
        assert!(without_sold_outliers(&empty).is_empty());
    }

    #[test]
    fn the_price_book_sorts_days_and_ignores_bad_rows() {
        let rows = vec![
            json!({ "blueprint_id": "1", "condition": "NM", "language": "EN",
                    "median_pkn": 30.0, "day": "2026-09-22" }),
            json!({ "blueprint_id": "1", "condition": "NM", "language": "EN",
                    "median_pkn": 10.0, "day": "2026-09-20" }),
            json!({ "blueprint_id": "abc", "condition": "NM", "median_pkn": 5.0, "day": "2026-09-20" }),
            json!({ "blueprint_id": "1", "condition": "NM", "median_pkn": 0.0, "day": "2026-09-20" }),
        ];
        let book = sold_price_book(&rows);
        let entries = book.get("1|NM|EN|-|-|-").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].day, "2026-09-20");
        assert_eq!(entries[1].day, "2026-09-22");
        assert_eq!(book.len(), 1);
    }

    #[test]
    fn price_as_of_carries_the_last_sale_forward() {
        let entries = vec![
            PricePoint { day: "2026-09-20".into(), pkn: 10.0 },
            PricePoint { day: "2026-09-25".into(), pkn: 20.0 },
        ];
        // Before the first sale there is no price.
        assert!(price_as_of(Some(&entries), "2026-09-19").is_none());
        // On a sale day the sale price applies.
        assert_eq!(price_as_of(Some(&entries), "2026-09-20").unwrap().pkn, 10.0);
        // Between sales the last sale carries forward.
        assert_eq!(price_as_of(Some(&entries), "2026-09-24").unwrap().pkn, 10.0);
        assert_eq!(price_as_of(Some(&entries), "2026-09-25").unwrap().pkn, 20.0);
        assert_eq!(price_as_of(Some(&entries), "2027-01-01").unwrap().pkn, 20.0);
        assert!(price_as_of(Some(&entries), "").is_none());
        assert!(price_as_of(None, "2026-09-20").is_none());
        let empty: Vec<PricePoint> = Vec::new();
        assert!(price_as_of(Some(&empty), "2026-09-20").is_none());
    }

    #[test]
    fn holdings_track_quantity_and_since() {
        let rows = vec![
            json!({ "blueprint_id": "1", "condition": "NM", "language": "EN",
                    "quantity": 3, "since": "2026-09-20" }),
            json!({ "blueprint_id": "2", "condition": "NM", "language": "EN", "quantity": 0 }),
            json!({ "condition": "NM", "language": "EN", "quantity": 2 }),
        ];
        let holdings = holding_slices(&rows);
        assert_eq!(holdings.len(), 2);
        assert_eq!(holdings[0].key, "1|NM|EN|-|-|-");
        assert_eq!(holdings[0].qty, 3);
        assert_eq!(holdings[0].since, "2026-09-20");
        // A slice with no blueprint is held but unpriced.
        assert_eq!(holdings[1].key, "unpriced|2");
    }

    #[test]
    fn holdings_are_valued_only_from_their_since_day() {
        let holdings = vec![
            Holding { key: "a".into(), qty: 2, since: "2026-09-20".into() },
            Holding { key: "b".into(), qty: 1, since: "2026-09-25".into() },
            Holding { key: "c".into(), qty: 5, since: String::new() },
        ];
        let book = book(&[
            ("a", &[("2026-09-20", 10.0)]),
            ("b", &[("2026-09-25", 100.0)]),
            // c never sold.
        ]);
        // Before a's since day only the slice without a since day is held.
        let value = value_holdings_on(&holdings, &book, "2026-09-19").unwrap();
        assert_eq!(value.cards_held, 5);
        assert_eq!(value.cards_priced, 0);
        assert_eq!(value.cards_value_pkn, 0.0);
        // On the 20th only a counts (and c, which is held but unpriced).
        let value = value_holdings_on(&holdings, &book, "2026-09-20").unwrap();
        assert_eq!(value.cards_held, 7);
        assert_eq!(value.cards_priced, 2);
        assert_eq!(value.cards_value_pkn, 20.0);
        // On the 25th b joins.
        let value = value_holdings_on(&holdings, &book, "2026-09-25").unwrap();
        assert_eq!(value.cards_held, 8);
        assert_eq!(value.cards_priced, 3);
        assert_eq!(value.cards_value_pkn, 120.0);
    }

    #[test]
    fn the_basket_move_ignores_new_members() {
        let holdings = vec![
            Holding { key: "a".into(), qty: 1, since: "2026-09-20".into() },
            Holding { key: "b".into(), qty: 1, since: "2026-09-24".into() },
        ];
        let book = book(&[
            ("a", &[("2026-09-20", 100.0), ("2026-09-25", 110.0)]),
            ("b", &[("2026-09-24", 500.0), ("2026-09-25", 1000.0)]),
        ]);
        // b was not held (and not priced) on the 23rd, so it does not count.
        let moved = basket_move(&holdings, &book, "2026-09-25", "2026-09-23").unwrap();
        assert!((moved - 0.1).abs() < 1e-9, "{moved}");
        // With no priced history there is no move at all.
        assert!(basket_move(&holdings, &book, "2026-09-19", "2026-09-18").is_none());
    }

    #[test]
    fn compact_day_matches_the_stored_shape() {
        let day = compact_day(&json!({
            "date": "2026-10-08",
            "currencyPkn": 10.005,
            "cardsValuePkn": 20.004,
            "cardsPriced": 2,
            "cardsHeld": 3,
            "cardsMove": 0.5
        }))
        .unwrap();
        assert_eq!(day["date"], json!("2026-10-08"));
        assert_eq!(day["currencyPkn"], json!(10.01));
        // Integral JS numbers serialize without a decimal point.
        assert_eq!(day["cardsValuePkn"], json!(20));
        assert_eq!(day["cardsKnown"], json!(true));
        assert_eq!(day["cardsPriced"], json!(2));
        assert_eq!(day["cardsHeld"], json!(3));
        assert_eq!(day["cardsMove"], json!(0.5));
        assert_eq!(day["totalPkn"], json!(30.01));

        // A day with no card value is stored without cards.
        let day = compact_day(&json!({ "date": "2026-10-08", "currencyPkn": 5 })).unwrap();
        assert_eq!(day["cardsValuePkn"], Json::Null);
        assert_eq!(day["cardsKnown"], json!(false));
        assert_eq!(day["cardsPriced"], json!(0));
        assert_eq!(day["cardsHeld"], json!(0));
        assert_eq!(day["cardsMove"], Json::Null);
        assert_eq!(day["totalPkn"], json!(5));

        // cardsPriced never exceeds cardsHeld.
        let day = compact_day(&json!({
            "date": "2026-10-08", "currencyPkn": 0, "cardsValuePkn": 1,
            "cardsPriced": 9, "cardsHeld": 2
        }))
        .unwrap();
        assert_eq!(day["cardsPriced"], json!(2));

        // A negative currency becomes 0 and an unusable date is dropped.
        let day = compact_day(&json!({ "date": "2026-10-08", "currencyPkn": -5 })).unwrap();
        assert_eq!(day["currencyPkn"], json!(0));
        assert!(compact_day(&json!({ "date": "nope" })).is_none());
    }

    #[test]
    fn frozen_days_only_protect_days_that_had_cards() {
        let doc = json!({
            "priceBasis": PRICE_BASIS,
            "seriesRevision": SERIES_REVISION,
            "days": [
                { "date": "2026-10-01", "currencyPkn": 100, "cardsValuePkn": 50,
                  "cardsPriced": 1, "cardsHeld": 1, "cardsMove": 0.1 },
                // A day stored without cards is re-priced, not frozen.
                { "date": "2026-10-02", "currencyPkn": 100 },
                // Today and the future are never frozen.
                { "date": "2026-10-08", "currencyPkn": 100, "cardsValuePkn": 60,
                  "cardsPriced": 1, "cardsHeld": 1 }
            ]
        });
        let frozen = frozen_card_days(Some(&doc), "2026-10-08");
        assert_eq!(frozen.len(), 1);
        let day = &frozen["2026-10-01"];
        assert_eq!(day["cardsValuePkn"], json!(50));
        assert_eq!(day["cardsMove"], json!(0.1));

        // Another basis or revision discards the whole series.
        let mut other = doc.clone();
        other["priceBasis"] = json!("something-else");
        assert!(frozen_card_days(Some(&other), "2026-10-08").is_empty());
        let mut other = doc.clone();
        other["seriesRevision"] = json!(SERIES_REVISION - 1);
        assert!(frozen_card_days(Some(&other), "2026-10-08").is_empty());
        assert!(frozen_card_days(None, "2026-10-08").is_empty());
    }

    #[test]
    fn wallet_series_carries_the_balance_and_adds_a_zero_day() {
        let movements = vec![
            json!({ "amountPkn": 100, "type": "deposit", "createdAt": "2026-10-02T00:00:00Z" }),
            json!({ "amountPkn": -30, "type": "sale", "createdAt": "2026-10-04T00:00:00Z" }),
            // `sent` makes a positive amount outbound.
            json!({ "amountPkn": 10, "type": "pkn_sent", "createdAt": "2026-10-05T00:00:00Z" }),
        ];
        let series = wallet_series(&movements, 90.0, "2026-10-08");
        assert_eq!(series.len(), 5);
        // A zero point the day before the first movement.
        assert_eq!(series[0], json!({ "date": "2026-10-01", "currencyPkn": 0 }));
        assert_eq!(series[1]["currencyPkn"], json!(100));
        assert_eq!(series[2]["currencyPkn"], json!(70));
        assert_eq!(series[3]["currencyPkn"], json!(60));
        // Today carries the live balance.
        assert_eq!(series[4]["date"], json!("2026-10-08"));
        assert_eq!(series[4]["currencyPkn"], json!(90));

        // With no movements and no balance there is no series.
        assert!(wallet_series(&[], 0.0, "2026-10-08").is_empty());
        // The live balance alone still produces today's point.
        let series = wallet_series(&[], 25.0, "2026-10-08");
        assert_eq!(series.len(), 1);
        assert_eq!(series[0]["currencyPkn"], json!(25));
        // A running total never goes below zero.
        let series = wallet_series(
            &[json!({ "amountPkn": -50, "createdAt": "2026-10-02T00:00:00Z" })],
            0.0,
            "2026-10-08",
        );
        assert_eq!(series[1]["currencyPkn"], json!(0));
    }

    #[test]
    fn today_overwrites_the_wallet_point() {
        let movements = vec![
            json!({ "date": "2026-10-08", "amountPkn": 5 }),
        ];
        let series = wallet_series(&movements, 42.0, "2026-10-08");
        assert_eq!(series.len(), 2);
        assert_eq!(series[0], json!({ "date": "2026-10-07", "currencyPkn": 0 }));
        assert_eq!(series[1], json!({ "date": "2026-10-08", "currencyPkn": 42 }));
    }

    #[test]
    fn daily_series_walks_every_day_and_freezes_stored_days() {
        let holdings = vec![Holding {
            key: "a".into(),
            qty: 2,
            since: "2026-10-02".into(),
        }];
        let book = book(&[("a", &[("2026-10-03", 10.0)])]);
        let wallet = vec![
            json!({ "date": "2026-10-01", "currencyPkn": 100 }),
            json!({ "date": "2026-10-03", "currencyPkn": 50 }),
        ];
        let mut frozen = BTreeMap::new();
        frozen.insert(
            "2026-10-02".to_string(),
            json!({ "cardsValuePkn": 7, "cardsPriced": 1, "cardsHeld": 1, "cardsMove": Json::Null }),
        );

        let days = build_daily_series(&wallet, &holdings, &book, &frozen, "2026-10-05");
        assert_eq!(days.len(), 5);
        assert_eq!(days[0]["date"], json!("2026-10-01"));
        assert_eq!(days[0]["currencyPkn"], json!(100));
        // Nothing is held before the since day.
        assert_eq!(days[0]["cardsHeld"], json!(0));
        // The frozen day keeps its stored card value.
        assert_eq!(days[1]["date"], json!("2026-10-02"));
        assert_eq!(days[1]["cardsValuePkn"], json!(7));
        assert_eq!(days[1]["cardsHeld"], json!(1));
        // From the first sale the slice is priced; 2 cards at 10 PKN.
        assert_eq!(days[2]["cardsValuePkn"], json!(20));
        assert_eq!(days[2]["cardsPriced"], json!(2));
        assert_eq!(days[2]["totalPkn"], json!(70));
        // The wallet carries forward between ledger days.
        assert_eq!(days[3]["currencyPkn"], json!(50));
        // Every day is compacted into the public shape.
        for day in &days {
            assert!(day.get("totalPkn").is_some());
            assert!(day.get("cardsKnown").is_some());
        }
    }

    #[test]
    fn daily_series_is_empty_without_a_starting_point() {
        assert!(build_daily_series(&[], &[], &HashMap::new(), &BTreeMap::new(), "2026-10-08")
            .is_empty());
        // A holdings row in the future does not start the series.
        let future = vec![Holding {
            key: "a".into(),
            qty: 1,
            since: "2027-01-01".into(),
        }];
        assert!(
            build_daily_series(&[], &future, &HashMap::new(), &BTreeMap::new(), "2026-10-08")
                .is_empty()
        );
    }

    #[test]
    fn stored_freshness_requires_the_basis_revision_day_and_window() {
        // 2026-10-08T00:00:00Z, with the stored series written five minutes later.
        let now = 1_791_417_600_000i64 + 10 * 60 * 1000;
        let fresh = json!({
            "priceBasis": PRICE_BASIS,
            "seriesRevision": SERIES_REVISION,
            "updatedAt": "2026-10-08T00:05:00Z"
        });
        assert!(stored_is_fresh(Some(&fresh), now));
        // Older than the freshness window.
        assert!(!stored_is_fresh(Some(&fresh), now + FRESH_MS));
        // A different UTC day is stale even when recent.
        let yesterday = json!({
            "priceBasis": PRICE_BASIS,
            "seriesRevision": SERIES_REVISION,
            "updatedAt": "2026-10-07T23:59:00Z"
        });
        assert!(!stored_is_fresh(Some(&yesterday), now), "a different UTC day is stale");
        // Wrong basis or revision.
        let mut wrong = fresh.clone();
        wrong["priceBasis"] = json!("other");
        assert!(!stored_is_fresh(Some(&wrong), now));
        let mut wrong = fresh.clone();
        wrong["seriesRevision"] = json!(SERIES_REVISION - 1);
        assert!(!stored_is_fresh(Some(&wrong), now));
        // No document at all.
        assert!(!stored_is_fresh(None, now));
        // A future timestamp is not fresh.
        let future = json!({
            "priceBasis": PRICE_BASIS,
            "seriesRevision": SERIES_REVISION,
            "updatedAt": "2026-10-08T00:20:00Z"
        });
        assert!(!stored_is_fresh(Some(&future), now));
    }

    #[test]
    fn clean_days_compacts_and_drops_unusable_rows() {
        let days = clean_days(Some(&json!([
            { "date": "2026-10-08", "currencyPkn": 1 },
            { "date": "nope" },
            { "currencyPkn": 5 }
        ])));
        assert_eq!(days.len(), 1);
        assert_eq!(days[0]["date"], json!("2026-10-08"));
        assert!(clean_days(None).is_empty());
        assert!(clean_days(Some(&json!("not an array"))).is_empty());
    }

    #[test]
    fn ledger_movements_sign_outbound_rows() {
        let row = json!({ "amountPkn": 5, "type": "pkn_sent", "createdAt": "2026-10-08T00:00:00Z" });
        assert_eq!(movement_from_ledger(&row).unwrap().amount_pkn, -5.0);
        let row = json!({ "amountPkn": -5, "type": "sale", "createdAt": "2026-10-08T00:00:00Z" });
        assert_eq!(movement_from_ledger(&row).unwrap().amount_pkn, -5.0);
        let row = json!({ "amountPkn": 5, "type": "sale", "createdAt": "2026-10-08T00:00:00Z" });
        assert_eq!(movement_from_ledger(&row).unwrap().amount_pkn, 5.0);
        // Zero, non-numeric and undated rows are not movements.
        assert!(movement_from_ledger(&json!({ "amountPkn": 0 })).is_none());
        assert!(movement_from_ledger(&json!({ "amountPkn": "abc" })).is_none());
        assert!(movement_from_ledger(&json!({ "amountPkn": 5 })).is_none());
    }
}
