//! Pokoin Associates desk core — a port of `marketplace-associate.js`.
//!
//! Role-scoped revenue-share partners (distributor, ambassador, …) read their
//! live campaign earnings from here. The royalty pool is the platform checkout
//! commission; each row in `public.marketplace_associates` carries that
//! associate's share of the pool and the campaign window the promise covers.
//!
//! A sale qualifies when the seller ships **from** Italy and the buyer ships
//! **to** Italy: the buyer country is the order's `shippingAddressCountryCode`
//! (EUR orders) or the shipments' `toCountry`; the seller country is the
//! shipment's `fromCountry` or the listing row's `seller_country`. Orders with
//! unresolvable countries are reported as **unverified**, never guessed into
//! the pool.
//!
//! Everything is pure over plain JSON plus the two injected clients, so the
//! money math is unit-testable without a database.

use std::collections::{BTreeMap, HashMap, HashSet, HashSet as Set};

use serde_json::{json, Map, Value as Json};

use crate::error::{ApiError, Result};
use crate::firestore::{Direction, Firestore, Query as FirestoreQuery, Value};
use crate::sql::{row_text, MarketplaceDb, SqlParam};

pub const RECENT_MAX: usize = 30;
pub const ORDER_SCAN_MAX: i64 = 5000;
pub const PAID_STATUSES: [&str; 3] = ["paid", "escrow", "released"];
pub const DEAD_STATUSES: [&str; 4] = ["cancelled", "failed", "expired", "void"];
pub const QUALIFYING_COUNTRY: &str = "IT";
const DAY_MS: f64 = 86_400_000.0;

/// `Math.round((Number(value) || 0) * 100) / 100`.
pub fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// A JS number renders without a decimal point when it is integral
/// (`JSON.stringify(0)` is `0`, not `0.0`), so the money fields go through here.
pub fn num(value: f64) -> Json {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

pub fn number_value(value: Option<&Json>) -> f64 {
    value
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        })
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn field_number(data: &Json, key: &str) -> f64 {
    number_value(data.get(key))
}

fn field_string(data: &Json, key: &str) -> String {
    data.get(key).and_then(Json::as_str).unwrap_or("").to_string()
}

fn field_array<'a>(data: &'a Json, key: &str) -> &'a [Json] {
    data.get(key)
        .and_then(Json::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

pub fn clean_email(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

/// `maskEmail`: first character, 2-5 stars, then the untouched domain.
pub fn mask_email(value: &str) -> String {
    let email = clean_email(value);
    let Some(at) = email.find('@') else {
        return "hidden".to_string();
    };
    if at == 0 {
        return "hidden".to_string();
    }
    let name = &email[..at];
    let stars = name
        .chars()
        .count()
        .saturating_sub(1)
        .clamp(2, 5);
    format!(
        "{}{}{}",
        name.chars().next().unwrap_or('*'),
        "*".repeat(stars),
        &email[at..]
    )
}

/// `tsToMillis` for a plain-JSON value (ISO string, number or `{seconds}`).
pub fn ts_to_millis(value: Option<&Json>) -> i64 {
    match value {
        None | Some(Json::Null) => 0,
        Some(Json::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Json::String(text)) => chrono::DateTime::parse_from_rfc3339(text)
            .map(|parsed| parsed.timestamp_millis())
            .unwrap_or(0),
        Some(Json::Object(fields)) => fields
            .get("seconds")
            .and_then(Json::as_i64)
            .map(|seconds| seconds * 1000)
            .or_else(|| {
                fields
                    .get("_seconds")
                    .and_then(Json::as_i64)
                    .map(|seconds| seconds * 1000)
            })
            .unwrap_or(0),
        _ => 0,
    }
}

/// `utcDayKey(millis)` → `yyyy-mm-dd`.
pub fn utc_day_key(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|value| value.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// One `public.marketplace_associates` row.
#[derive(Debug, Clone, PartialEq)]
pub struct Associate {
    pub email: String,
    pub role: String,
    pub display_name: String,
    pub share_pct: f64,
    pub royalty_pct: f64,
    pub window_start: String,
    pub window_end: String,
    pub active: bool,
    pub city: String,
}

impl Associate {
    /// `serializeAssociateRow(row)`.
    pub fn from_row(row: &Json) -> Self {
        Self {
            email: clean_email(&row_text(row, "email")),
            role: {
                let role = row_text(row, "role");
                if role.trim().is_empty() {
                    "associate".to_string()
                } else {
                    role.trim().to_ascii_lowercase()
                }
            },
            display_name: row_text(row, "display_name").trim().to_string(),
            share_pct: number_value(row.get("share_pct")),
            royalty_pct: number_value(row.get("royalty_pct")),
            window_start: iso_or_text(row.get("window_start")),
            window_end: iso_or_text(row.get("window_end")),
            active: row.get("active").and_then(Json::as_bool).unwrap_or(false),
            city: row_text(row, "city").trim().to_string(),
        }
    }

    pub fn to_json(&self) -> Json {
        json!({
            "email": self.email,
            "role": self.role,
            "displayName": self.display_name,
            "sharePct": self.share_pct,
            "royaltyPct": self.royalty_pct,
            "windowStart": self.window_start,
            "windowEnd": self.window_end,
            "active": self.active,
            "city": self.city,
        })
    }
}

/// A `Date` becomes an ISO string; anything else is stringified, like Node.
fn iso_or_text(value: Option<&Json>) -> String {
    match value {
        None | Some(Json::Null) => String::new(),
        Some(Json::String(text)) => {
            // A Postgres timestamp decodes to an ISO string already; keep the
            // `Date.toISOString()` shape so clients can parse it.
            match chrono::DateTime::parse_from_rfc3339(text) {
                Ok(parsed) => parsed
                    .with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                Err(_) => text.clone(),
            }
        }
        Some(other) => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Order classification
// ---------------------------------------------------------------------------

/// `orderIsPaidish`: the money actually moved and the order is not dead.
pub fn order_is_paidish(data: &Json) -> bool {
    let payment_status = {
        let raw = field_string(data, "paymentStatus");
        if raw.is_empty() {
            field_string(data, "status")
        } else {
            raw
        }
        .to_ascii_lowercase()
    };
    let status = field_string(data, "status").to_ascii_lowercase();
    if DEAD_STATUSES.contains(&status.as_str()) || DEAD_STATUSES.contains(&payment_status.as_str()) {
        return false;
    }
    PAID_STATUSES.contains(&payment_status.as_str()) || PAID_STATUSES.contains(&status.as_str())
}

pub fn is_eur_order(data: &Json) -> bool {
    field_string(data, "currency").to_ascii_uppercase() == "EUR"
        || field_string(data, "paymentMethod").to_ascii_lowercase() == "stripe"
        || field_number(data, "totalEURCents") > 0.0
}

/// `orderSubtotal`: the card subtotal for the royalty base, netted by refunds.
pub fn order_subtotal(data: &Json) -> f64 {
    let items = field_array(data, "items");
    let eur = is_eur_order(data);
    let explicit = if eur {
        field_number(data, "itemsSubtotalCents")
    } else {
        field_number(data, "subtotalPkn")
    };
    let mut subtotal = explicit;
    if subtotal == 0.0 {
        for item in items {
            let total = if eur {
                field_number(item, "totalPriceEURCents")
            } else {
                field_number(item, "totalPricePkn")
            };
            subtotal += if total != 0.0 {
                total
            } else {
                let unit = if eur {
                    field_number(item, "unitPriceEURCents")
                } else {
                    field_number(item, "unitPricePkn")
                };
                unit * field_number(item, "quantity").max(1.0)
            };
        }
    }
    let total = if eur {
        field_number(data, "totalEURCents")
    } else {
        field_number(data, "totalPkn")
    };
    let refunded = field_number(data, "refundedTotal");
    if total > 0.0 && refunded > 0.0 {
        if refunded >= total {
            return 0.0;
        }
        subtotal *= 1.0 - refunded / total;
    }
    subtotal.max(0.0)
}

/// `shipmentSellerCountries`: sellerId → uppercase `fromCountry`.
pub fn shipment_seller_countries(data: &Json) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for shipment in field_array(data, "shipments") {
        let seller_id = field_string(shipment, "sellerId").trim().to_string();
        let from = field_string(shipment, "fromCountry")
            .trim()
            .to_ascii_uppercase();
        if !seller_id.is_empty() && !from.is_empty() && !out.contains_key(&seller_id) {
            out.insert(seller_id, from);
        }
    }
    out
}

/// `buyerCountryOf`: the direct field, else the single distinct `toCountry`.
pub fn buyer_country_of(data: &Json) -> String {
    let direct = field_string(data, "shippingAddressCountryCode")
        .trim()
        .to_ascii_uppercase();
    if !direct.is_empty() {
        return direct;
    }
    let mut tos: Set<String> = HashSet::new();
    for shipment in field_array(data, "shipments") {
        let to = field_string(shipment, "toCountry")
            .trim()
            .to_ascii_uppercase();
        if !to.is_empty() {
            tos.insert(to);
        }
    }
    if tos.len() == 1 {
        tos.into_iter().next().unwrap_or_default()
    } else {
        String::new()
    }
}

/// `missingSellerUids(data, known)`.
pub fn missing_seller_uids(data: &Json, known: &HashMap<String, String>) -> Vec<String> {
    let mut uids: Vec<String> = Vec::new();
    for seller_uid in field_array(data, "sellerUids") {
        let uid = seller_uid.as_str().unwrap_or("").trim().to_string();
        if !uid.is_empty() && !known.contains_key(&uid) && !uids.contains(&uid) {
            uids.push(uid);
        }
    }
    uids
}

#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub qualifying: bool,
    pub unverified: bool,
    pub volume: f64,
    pub currency: String,
}

/// `classifyOrder(data, sellerCountries)`. `None` for orders that never count.
pub fn classify_order(
    data: &Json,
    seller_countries: &HashMap<String, String>,
) -> Option<Verdict> {
    if !order_is_paidish(data) {
        return None;
    }
    let shipments = shipment_seller_countries(data);
    let buyer_country = buyer_country_of(data);
    let seller_uids: Vec<String> = field_array(data, "sellerUids")
        .iter()
        .map(|uid| uid.as_str().unwrap_or("").trim().to_string())
        .filter(|uid| !uid.is_empty())
        .collect();
    let seller_set: Vec<String> = if !seller_uids.is_empty() {
        seller_uids
    } else {
        // Fall back to the per-item seller uids, de-duplicated in order.
        let mut seen: Vec<String> = Vec::new();
        for item in field_array(data, "items") {
            let uid = field_string(item, "sellerUid").trim().to_string();
            if !uid.is_empty() && !seen.contains(&uid) {
                seen.push(uid);
            }
        }
        seen
    };

    let countries: Vec<String> = seller_set
        .iter()
        .map(|uid| {
            seller_countries
                .get(uid)
                .cloned()
                .or_else(|| shipments.get(uid).cloned())
                .unwrap_or_default()
        })
        .collect();
    let seller_missing = countries.iter().any(|country| country.is_empty());
    let seller_italian = !countries.is_empty()
        && countries
            .iter()
            .all(|country| country == QUALIFYING_COUNTRY);
    let volume = order_subtotal(data);
    let currency = if is_eur_order(data) { "EUR" } else { "PKN" };

    // A fully refunded order nets to zero volume: no commission, no accrual.
    if volume <= 0.0 {
        return Some(Verdict {
            qualifying: false,
            unverified: false,
            volume,
            currency: currency.to_string(),
        });
    }
    if buyer_country == QUALIFYING_COUNTRY && seller_italian {
        return Some(Verdict {
            qualifying: true,
            unverified: false,
            volume,
            currency: currency.to_string(),
        });
    }
    if buyer_country == QUALIFYING_COUNTRY && !seller_missing && !seller_italian {
        return Some(Verdict {
            qualifying: false,
            unverified: false,
            volume,
            currency: currency.to_string(),
        });
    }
    if !buyer_country.is_empty() && !seller_missing {
        return Some(Verdict {
            qualifying: false,
            unverified: false,
            volume,
            currency: currency.to_string(),
        });
    }
    Some(Verdict {
        qualifying: false,
        unverified: true,
        volume,
        currency: currency.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/// `emptyEarnings()`.
pub fn empty_earnings() -> Json {
    json!({
        "qualifyingOrders": 0,
        "unverifiedOrders": 0,
        "grossPkn": 0,
        "royaltyPkn": 0,
        "earningPkn": 0,
        "grossEurCents": 0,
        "royaltyEurCents": 0,
        "earningEurCents": 0,
        "daily": [],
        "orders": [],
    })
}

/// One classified order, ready to summarize.
#[derive(Debug, Clone)]
pub struct OrderEntry {
    pub id: String,
    pub data: Json,
    pub seller_countries: HashMap<String, String>,
    pub created_at_millis: i64,
}

#[derive(Debug, Clone, Default)]
struct Totals {
    gross: f64,
    royalty: f64,
    earning: f64,
}

/// `summarizeOrders(entries, {royaltyPct, sharePct})`.
pub fn summarize_orders(entries: &[OrderEntry], royalty_pct: f64, share_pct: f64) -> Json {
    let mut earnings = empty_earnings();
    let mut daily: BTreeMap<String, Json> = BTreeMap::new();
    let mut recent: Vec<Json> = Vec::new();
    let mut totals = Totals::default();

    let mut qualifying_orders = 0i64;
    let mut unverified_orders = 0i64;
    let (mut gross_pkn, mut royalty_pkn, mut earning_pkn) = (0.0f64, 0.0f64, 0.0f64);
    let (mut gross_eur, mut royalty_eur, mut earning_eur) = (0.0f64, 0.0f64, 0.0f64);

    for entry in entries {
        let Some(verdict) = classify_order(&entry.data, &entry.seller_countries) else {
            continue;
        };
        if verdict.unverified {
            unverified_orders += 1;
        }
        if !verdict.qualifying {
            continue;
        }

        let royalty = round2(verdict.volume * (royalty_pct / 100.0));
        let share = round2(royalty * (share_pct / 100.0));
        let eur = verdict.currency == "EUR";

        // EUR totals are integer cents; PKN carries two decimals.
        let fixed = if eur {
            (
                verdict.volume.round(),
                royalty.round(),
                share.round(),
            )
        } else {
            (round2(verdict.volume), royalty, share)
        };

        if eur {
            totals.gross = round2(gross_eur + fixed.0);
            totals.royalty = round2(royalty_eur + fixed.1);
            totals.earning = round2(earning_eur + fixed.2);
            gross_eur = totals.gross;
            royalty_eur = totals.royalty;
            earning_eur = totals.earning;
        } else {
            totals.gross = round2(gross_pkn + fixed.0);
            totals.royalty = round2(royalty_pkn + fixed.1);
            totals.earning = round2(earning_pkn + fixed.2);
            gross_pkn = totals.gross;
            royalty_pkn = totals.royalty;
            earning_pkn = totals.earning;
        }
        qualifying_orders += 1;

        let day = utc_day_key(entry.created_at_millis);
        let bucket = daily.entry(day.clone()).or_insert_with(|| {
            json!({ "date": day, "orders": 0, "earningPkn": 0, "earningEurCents": 0 })
        });
        if let Some(object) = bucket.as_object_mut() {
            let orders = object.get("orders").and_then(Json::as_i64).unwrap_or(0) + 1;
            object.insert("orders".into(), json!(orders));
            if eur {
                let current = object
                    .get("earningEurCents")
                    .and_then(Json::as_f64)
                    .unwrap_or(0.0);
                object.insert("earningEurCents".into(), num((current + fixed.2).round()));
            } else {
                let current = object
                    .get("earningPkn")
                    .and_then(Json::as_f64)
                    .unwrap_or(0.0);
                object.insert("earningPkn".into(), num(round2(current + fixed.2)));
            }
        }

        let sellers = {
            let listed = field_array(&entry.data, "sellerUids").len();
            if listed > 0 {
                listed
            } else {
                let items = field_array(&entry.data, "items").len();
                if items > 0 {
                    items
                } else {
                    1
                }
            }
        };
        recent.push(json!({
            "orderId": entry.id,
            "date": day,
            "buyer": mask_email(&field_string(&entry.data, "buyerEmail")),
            "sellers": sellers,
            "currency": verdict.currency,
            "gross": num(fixed.0),
            "royalty": num(fixed.1),
            "earning": num(fixed.2),
        }));
    }

    earnings["qualifyingOrders"] = json!(qualifying_orders);
    earnings["unverifiedOrders"] = json!(unverified_orders);
    earnings["grossPkn"] = num(gross_pkn);
    earnings["royaltyPkn"] = num(royalty_pkn);
    earnings["earningPkn"] = num(earning_pkn);
    earnings["grossEurCents"] = num(gross_eur);
    earnings["royaltyEurCents"] = num(royalty_eur);
    earnings["earningEurCents"] = num(earning_eur);
    earnings["daily"] = Json::Array(daily.into_values().collect());
    recent.sort_by(|a, b| {
        let key = |value: &Json| {
            (
                value.get("date").and_then(Json::as_str).unwrap_or("").to_string(),
                value
                    .get("orderId")
                    .and_then(Json::as_str)
                    .unwrap_or("")
                    .to_string(),
            )
        };
        key(b).cmp(&key(a))
    });
    recent.truncate(RECENT_MAX);
    earnings["orders"] = Json::Array(recent);
    earnings
}

/// `windowProgress(windowStartIso, windowEndIso, nowMs)`.
pub fn window_progress(window_start_iso: &str, window_end_iso: &str, now_ms: i64) -> Json {
    let start = chrono::DateTime::parse_from_rfc3339(window_start_iso)
        .map(|parsed| parsed.timestamp_millis())
        .unwrap_or(0);
    let end = chrono::DateTime::parse_from_rfc3339(window_end_iso)
        .map(|parsed| parsed.timestamp_millis())
        .unwrap_or(0);
    let days_total = (((end - start) as f64) / DAY_MS).round().max(1.0) as i64;
    let clamped = now_ms.clamp(start, end.max(start));
    let days_elapsed = (((clamped - start) as f64) / DAY_MS)
        .round()
        .max(0.0)
        .min(days_total as f64) as i64;
    let days_remaining = (((end - clamped) as f64) / DAY_MS).round().max(0.0) as i64;
    json!({
        "start": window_start_iso,
        "end": window_end_iso,
        "daysTotal": days_total,
        "daysElapsed": days_elapsed,
        "daysRemaining": days_remaining,
        "live": now_ms >= start && now_ms <= end,
    })
}

// ---------------------------------------------------------------------------
// SQL + Firestore orchestration
// ---------------------------------------------------------------------------

const ASSOCIATE_COLUMNS: &str = "email, role, display_name, share_pct, royalty_pct, \
                                 window_start, window_end, active, city";

/// `associateRowForEmail(email)`.
pub async fn associate_row_for_email(db: &MarketplaceDb, email: &str) -> Result<Option<Associate>> {
    let rows = db
        .query_json(
            &format!(
                "select {ASSOCIATE_COLUMNS} from public.marketplace_associates \
                 where lower(btrim(email)) = $1 limit 1"
            ),
            &[SqlParam::Text(clean_email(email))],
        )
        .await?;
    Ok(rows.first().map(Associate::from_row))
}

/// `associateRowsAll()`.
pub async fn associate_rows_all(db: &MarketplaceDb) -> Result<Vec<Associate>> {
    let rows = db
        .query_json(
            &format!(
                "select {ASSOCIATE_COLUMNS} from public.marketplace_associates \
                 order by active desc, lower(coalesce(display_name, email)), email"
            ),
            &[],
        )
        .await?;
    Ok(rows.iter().map(Associate::from_row).collect())
}

/// `listingSellerCountries(uids)` — the newest listing country per seller.
pub async fn listing_seller_countries(
    db: &MarketplaceDb,
    uids: &[String],
) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    if uids.is_empty() {
        return Ok(out);
    }
    let rows = db
        .query_json(
            "select distinct on (seller_uid) seller_uid, seller_country \
               from public.marketplace_user_listings \
              where seller_uid = any($1::text[]) \
                and coalesce(btrim(seller_country), '') <> '' \
              order by seller_uid, updated_at desc nulls last, created_at desc nulls last",
            &[SqlParam::TextArray(uids.to_vec())],
        )
        .await?;
    for row in rows {
        let country: String = row_text(&row, "seller_country")
            .trim()
            .to_ascii_uppercase()
            .chars()
            .take(2)
            .collect();
        let uid = row_text(&row, "seller_uid");
        if !uid.is_empty() && !country.is_empty() {
            out.insert(uid, country);
        }
    }
    Ok(out)
}

/// `loadWindowOrders(firestore, windowStartIso, windowEndIso)`.
pub async fn load_window_orders(
    db: &MarketplaceDb,
    firestore: &Firestore,
    window_start_iso: &str,
    window_end_iso: &str,
    now_ms: i64,
) -> Result<Vec<OrderEntry>> {
    let start = chrono::DateTime::parse_from_rfc3339(window_start_iso)
        .map(|parsed| parsed.with_timezone(&chrono::Utc))
        .map_err(|_| {
            ApiError::internal("Associate campaign window is invalid.")
        })?;
    let end = chrono::DateTime::parse_from_rfc3339(window_end_iso)
        .map(|parsed| parsed.with_timezone(&chrono::Utc))
        .map_err(|_| {
            ApiError::internal("Associate campaign window is invalid.")
        })?;

    let documents = firestore
        .run_query(
            &FirestoreQuery::collection("orders")
                .where_op(
                    "createdAt",
                    crate::firestore::FilterOp::GreaterThanOrEqual,
                    Value::Timestamp(start),
                )
                .where_op(
                    "createdAt",
                    crate::firestore::FilterOp::LessThanOrEqual,
                    Value::Timestamp(end),
                )
                .order_by("createdAt", Direction::Descending)
                .limit(ORDER_SCAN_MAX),
        )
        .await?;

    let mut entries: Vec<OrderEntry> = Vec::new();
    let mut needs_lookup: Vec<String> = Vec::new();
    for document in documents {
        let data = document.to_plain_json();
        let seller_countries = shipment_seller_countries(&data);
        for uid in missing_seller_uids(&data, &seller_countries) {
            if !needs_lookup.contains(&uid) {
                needs_lookup.push(uid);
            }
        }
        let created_at_millis = {
            let parsed = ts_to_millis(data.get("createdAt"));
            if parsed == 0 {
                now_ms
            } else {
                parsed
            }
        };
        entries.push(OrderEntry {
            id: document.id(),
            data,
            seller_countries,
            created_at_millis,
        });
    }

    let from_listings = listing_seller_countries(db, &needs_lookup).await?;
    if !from_listings.is_empty() {
        for entry in entries.iter_mut() {
            for (uid, country) in &from_listings {
                entry
                    .seller_countries
                    .entry(uid.clone())
                    .or_insert_with(|| country.clone());
            }
        }
    }
    Ok(entries)
}

/// `readAssociateForClient(firestore, associate, {nowMs})`.
pub async fn read_associate_for_client(
    db: &MarketplaceDb,
    firestore: &Firestore,
    associate: &Associate,
    now_ms: i64,
) -> Result<Json> {
    let progress = window_progress(&associate.window_start, &associate.window_end, now_ms);
    let mut earnings = empty_earnings();
    let window_valid = !associate.window_start.is_empty() && !associate.window_end.is_empty();
    if associate.active && window_valid {
        let entries = load_window_orders(
            db,
            firestore,
            &associate.window_start,
            &associate.window_end,
            now_ms,
        )
        .await?;
        earnings = summarize_orders(&entries, associate.royalty_pct, associate.share_pct);
    }
    Ok(json!({
        "associate": associate.to_json(),
        "window": progress,
        "earnings": earnings,
    }))
}

/// `overviewForAdmin(firestore, {nowMs})` — one load per distinct window.
pub async fn overview_for_admin(
    db: &MarketplaceDb,
    firestore: &Firestore,
    now_ms: i64,
) -> Result<Vec<Json>> {
    let rows = associate_rows_all(db).await?;
    let mut by_window: HashMap<String, Vec<OrderEntry>> = HashMap::new();
    let mut overview = Vec::new();
    for associate in rows {
        let key = format!("{}|{}", associate.window_start, associate.window_end);
        if !by_window.contains_key(&key) {
            let entries = if associate.active
                && !associate.window_start.is_empty()
                && !associate.window_end.is_empty()
            {
                load_window_orders(
                    db,
                    firestore,
                    &associate.window_start,
                    &associate.window_end,
                    now_ms,
                )
                .await?
            } else {
                Vec::new()
            };
            by_window.insert(key.clone(), entries);
        }
        // A read-only view of the cached entries for this window.
        let entries = by_window.get(&key).cloned().unwrap_or_default();
        let earnings = if associate.active {
            summarize_orders(&entries, associate.royalty_pct, associate.share_pct)
        } else {
            empty_earnings()
        };
        overview.push(json!({
            "associate": associate.to_json(),
            "window": window_progress(&associate.window_start, &associate.window_end, now_ms),
            "earnings": earnings,
        }));
    }
    Ok(overview)
}

/// `callerIsAdmin(firestore, decoded)` — the decoded claim, else the profile.
pub async fn caller_is_admin(
    firestore: &Firestore,
    uid: &str,
    admin_claim: bool,
) -> bool {
    if admin_claim {
        return true;
    }
    let uid = uid.trim();
    if uid.is_empty() {
        return false;
    }
    let profile = match firestore.doc(format!("users/{uid}")).get().await {
        Ok(Some(document)) => document.to_plain_json(),
        Ok(None) => return false,
        Err(error) => {
            tracing::warn!(%error, "marketplace-associate admin lookup failed");
            return false;
        }
    };
    if profile.get("admin").and_then(Json::as_bool).unwrap_or(false)
        || profile
            .get("isAdmin")
            .and_then(Json::as_bool)
            .unwrap_or(false)
    {
        return true;
    }
    if field_string(&profile, "role").trim().to_ascii_lowercase() == "admin" {
        return true;
    }
    let roles: Vec<String> = match profile.get("roles") {
        Some(Json::Array(values)) => values
            .iter()
            .map(|value| value.as_str().unwrap_or("").trim().to_ascii_lowercase())
            .collect(),
        Some(Json::String(text)) => text
            .split(',')
            .map(|value| value.trim().to_ascii_lowercase())
            .collect(),
        _ => Vec::new(),
    };
    roles.iter().any(|role| role == "admin")
}

/// `readAssociatePayload(firestore, decoded, {nowMs})`.
pub async fn read_associate_payload(
    db: &MarketplaceDb,
    firestore: &Firestore,
    uid: &str,
    email: &str,
    admin_claim: bool,
    now_ms: i64,
) -> Result<Json> {
    let admin = caller_is_admin(firestore, uid, admin_claim).await;
    let email = clean_email(email);
    let associate = if email.is_empty() {
        None
    } else {
        associate_row_for_email(db, &email).await?
    };
    if associate.is_none() && !admin {
        return Err(ApiError::forbidden("Not a Pokoin associate."));
    }
    let mut payload = json!({
        "associate": Json::Null,
        "window": Json::Null,
        "earnings": empty_earnings(),
    });
    if let Some(associate) = &associate {
        let own = read_associate_for_client(db, firestore, associate, now_ms).await?;
        payload["associate"] = own["associate"].clone();
        payload["window"] = own["window"].clone();
        payload["earnings"] = own["earnings"].clone();
    }
    if admin {
        payload["admin"] = json!(true);
        payload["overview"] = Json::Array(overview_for_admin(db, firestore, now_ms).await?);
    }
    Ok(payload)
}

/// The distinct seller uids across entries (used by tests and diagnostics).
pub fn seller_uid_set(entries: &[OrderEntry]) -> HashSet<String> {
    let mut set = HashSet::new();
    for entry in entries {
        for uid in field_array(&entry.data, "sellerUids") {
            let uid = uid.as_str().unwrap_or("").trim().to_string();
            if !uid.is_empty() {
                set.insert(uid);
            }
        }
    }
    set
}

/// Keep the `Map` import meaningful for the JSON builders above.
#[allow(dead_code)]
fn _json_map(entries: Vec<(String, Json)>) -> Json {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key, value);
    }
    Json::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(fields: Json) -> Json {
        fields
    }

    #[test]
    fn rounding_and_number_coercion_match_javascript() {
        assert_eq!(round2(1.005), 1.0);
        assert_eq!(round2(1.234), 1.23);
        assert_eq!(round2(-1.005), -1.0);
        assert_eq!(round2(0.0), 0.0);
        assert_eq!(number_value(Some(&json!(2))), 2.0);
        assert_eq!(number_value(Some(&json!("2.5"))), 2.5);
        assert_eq!(number_value(Some(&json!("abc"))), 0.0);
        assert_eq!(number_value(None), 0.0);
    }

    #[test]
    fn emails_are_cleaned_and_masked() {
        assert_eq!(clean_email("  Ash@Pokoin.COM "), "ash@pokoin.com");
        assert_eq!(mask_email("a@b.co"), "a**@b.co");
        // name.length - 1 = 2, clamped to [2, 5].
        assert_eq!(mask_email("ash@pokoin.com"), "a**@pokoin.com");
        assert_eq!(mask_email("raffaella@pokoin.com"), "r*****@pokoin.com");
        assert_eq!(mask_email("raffaella@pokoin.com"), "r*****@pokoin.com");
        assert_eq!(mask_email("ab@x.co"), "a**@x.co");
        assert_eq!(mask_email("@x.co"), "hidden");
        assert_eq!(mask_email("no-at-sign"), "hidden");
        assert_eq!(mask_email(""), "hidden");
    }

    #[test]
    fn timestamps_and_day_keys_cover_every_shape() {
        assert_eq!(
            ts_to_millis(Some(&json!("2026-10-08T00:00:00Z"))),
            1_791_417_600_000
        );
        assert_eq!(ts_to_millis(Some(&json!(1_791_417_600_000i64))), 1_791_417_600_000);
        assert_eq!(ts_to_millis(Some(&json!({ "seconds": 2 }))), 2000);
        assert_eq!(ts_to_millis(Some(&json!("bad"))), 0);
        assert_eq!(ts_to_millis(None), 0);
        assert_eq!(utc_day_key(1_791_417_600_000), "2026-10-08");
    }

    #[test]
    fn paidish_orders_exclude_dead_statuses() {
        assert!(order_is_paidish(&order(json!({ "paymentStatus": "paid" }))));
        assert!(order_is_paidish(&order(json!({ "status": "escrow" }))));
        assert!(!order_is_paidish(&order(json!({ "paymentStatus": "pending" }))));
        assert!(!order_is_paidish(&order(json!({ "paymentStatus": "paid", "status": "cancelled" }))));
        assert!(!order_is_paidish(&order(json!({ "paymentStatus": "void", "status": "paid" }))));
        assert!(!order_is_paidish(&order(json!({}))));
    }

    #[test]
    fn eur_detection_covers_all_three_signals() {
        assert!(is_eur_order(&order(json!({ "currency": "eur" }))));
        assert!(is_eur_order(&order(json!({ "paymentMethod": "Stripe" }))));
        assert!(is_eur_order(&order(json!({ "totalEURCents": 100 }))));
        assert!(!is_eur_order(&order(json!({ "currency": "PKN" }))));
    }

    #[test]
    fn order_subtotal_uses_the_eur_or_pkn_fields_and_nets_refunds() {
        // Explicit subtotal wins.
        assert_eq!(
            order_subtotal(&order(json!({ "subtotalPkn": 120, "items": [ { "totalPricePkn": 999 } ] }))),
            120.0
        );
        // Otherwise the items sum, preferring totalPricePkn over unit*qty.
        assert_eq!(
            order_subtotal(&order(json!({
                "items": [
                    { "totalPricePkn": 50 },
                    { "unitPricePkn": 10, "quantity": 3 },
                    { "unitPricePkn": 7 }
                ]
            }))),
            87.0
        );
        // EUR orders read the cents fields.
        assert_eq!(
            order_subtotal(&order(json!({
                "currency": "EUR",
                "items": [ { "unitPriceEURCents": 250, "quantity": 2 } ]
            }))),
            500.0
        );
        // Refunds net the subtotal down proportionally.
        assert_eq!(
            order_subtotal(&order(json!({ "subtotalPkn": 100, "totalPkn": 200, "refundedTotal": 50 }))),
            75.0
        );
        // A full refund is zero, never negative.
        assert_eq!(
            order_subtotal(&order(json!({ "subtotalPkn": 100, "totalPkn": 200, "refundedTotal": 200 }))),
            0.0
        );
        assert_eq!(order_subtotal(&order(json!({ "subtotalPkn": -5 }))), 0.0);
    }

    #[test]
    fn seller_and_buyer_countries_are_read_defensively() {
        let data = order(json!({
            "shipments": [
                { "sellerId": "u1", "fromCountry": "it", "toCountry": "IT" },
                { "sellerId": "u1", "fromCountry": "DE", "toCountry": "DE" },
                { "sellerId": "u2", "fromCountry": "" },
                { "sellerId": "", "fromCountry": "FR" }
            ]
        }));
        let countries = shipment_seller_countries(&data);
        assert_eq!(countries.get("u1").map(String::as_str), Some("IT"));
        assert!(!countries.contains_key("u2"));
        // Two distinct destinations are ambiguous -> empty.
        assert_eq!(buyer_country_of(&data), "");
        // The direct field wins.
        let data = order(json!({ "shippingAddressCountryCode": "it" }));
        assert_eq!(buyer_country_of(&data), "IT");
        // A single distinct destination is usable.
        let data = order(json!({
            "shipments": [
                { "toCountry": "it" }, { "toCountry": "IT" }, { "toCountry": "" }
            ]
        }));
        assert_eq!(buyer_country_of(&data), "IT");
    }

    #[test]
    fn missing_seller_uids_skip_known_ones_and_dedupe() {
        let data = order(json!({ "sellerUids": ["u1", "u2", "u2", "", "u3"] }));
        let mut known = HashMap::new();
        known.insert("u2".to_string(), "IT".to_string());
        assert_eq!(missing_seller_uids(&data, &known), vec!["u1", "u3"]);
    }

    #[test]
    fn classification_follows_the_it_to_it_rule() {
        let italian = {
            let mut map = HashMap::new();
            map.insert("u1".to_string(), "IT".to_string());
            map
        };
        let german = {
            let mut map = HashMap::new();
            map.insert("u1".to_string(), "DE".to_string());
            map
        };
        let it_order = json!({
            "paymentStatus": "paid",
            "shippingAddressCountryCode": "IT",
            "sellerUids": ["u1"],
            "subtotalPkn": 100
        });

        // IT -> IT qualifies.
        let verdict = classify_order(&it_order, &italian).unwrap();
        assert!(verdict.qualifying);
        assert!(!verdict.unverified);
        assert_eq!(verdict.volume, 100.0);
        assert_eq!(verdict.currency, "PKN");

        // IT -> DE does not qualify, and is not unverified.
        let verdict = classify_order(&it_order, &german).unwrap();
        assert!(!verdict.qualifying);
        assert!(!verdict.unverified);

        // An unknown seller country with a known buyer country is unverified.
        let verdict = classify_order(&it_order, &HashMap::new()).unwrap();
        assert!(!verdict.qualifying);
        assert!(verdict.unverified);

        // An unpaid order never counts at all.
        let unpaid = json!({ "paymentStatus": "pending", "sellerUids": ["u1"] });
        assert!(classify_order(&unpaid, &italian).is_none());

        // A fully refunded order is a zero-volume non-qualifying verdict.
        let refunded = json!({
            "paymentStatus": "paid",
            "shippingAddressCountryCode": "IT",
            "sellerUids": ["u1"],
            "subtotalPkn": 100,
            "totalPkn": 100,
            "refundedTotal": 100
        });
        let verdict = classify_order(&refunded, &italian).unwrap();
        assert!(!verdict.qualifying);
        assert!(!verdict.unverified);
        assert_eq!(verdict.volume, 0.0);

        // Items-only seller uids are used when sellerUids is absent.
        let items_only = json!({
            "paymentStatus": "paid",
            "shippingAddressCountryCode": "IT",
            "items": [ { "sellerUid": "u1" } ],
            "subtotalPkn": 10
        });
        assert!(classify_order(&items_only, &italian).unwrap().qualifying);

        // A non-IT seller country with a known buyer country is a clean refusal.
        let de_buyer = json!({
            "paymentStatus": "paid",
            "shippingAddressCountryCode": "DE",
            "sellerUids": ["u1"],
            "subtotalPkn": 10
        });
        let verdict = classify_order(&de_buyer, &german).unwrap();
        assert!(!verdict.qualifying);
        assert!(!verdict.unverified);
    }

    fn entry(id: &str, data: Json, countries: &[(&str, &str)], at_ms: i64) -> OrderEntry {
        OrderEntry {
            id: id.to_string(),
            data,
            seller_countries: countries
                .iter()
                .map(|(uid, country)| (uid.to_string(), country.to_string()))
                .collect(),
            created_at_millis: at_ms,
        }
    }

    #[test]
    fn summary_applies_royalty_then_share_and_splits_currencies() {
        let entries = vec![
            entry(
                "o1",
                json!({
                    "paymentStatus": "paid",
                    "shippingAddressCountryCode": "IT",
                    "sellerUids": ["u1"],
                    "subtotalPkn": 100,
                    "buyerEmail": "buyer@pokoin.com",
                    "createdAt": "2026-10-08T00:00:00Z"
                }),
                &[("u1", "IT")],
                1_791_417_600_000,
            ),
            entry(
                "o2",
                json!({
                    "paymentStatus": "escrow",
                    "currency": "EUR",
                    "shippingAddressCountryCode": "IT",
                    "sellerUids": ["u1"],
                    "subtotalPkn": 0,
                    "itemsSubtotalCents": 250,
                    "createdAt": "2026-10-09T00:00:00Z"
                }),
                &[("u1", "IT")],
                1_791_504_000_000,
            ),
            entry(
                "o3",
                json!({
                    "paymentStatus": "paid",
                    "shippingAddressCountryCode": "DE",
                    "sellerUids": ["u1"],
                    "subtotalPkn": 999
                }),
                &[("u1", "DE")],
                1_791_504_000_000,
            ),
            entry(
                "o4",
                json!({ "paymentStatus": "pending" }),
                &[],
                1_791_504_000_000,
            ),
        ];
        // 10% royalty, 50% share.
        let summary = summarize_orders(&entries, 10.0, 50.0);
        assert_eq!(summary["qualifyingOrders"], json!(2));
        // o4 is unpaid (null verdict) so it is not unverified either.
        assert_eq!(summary["unverifiedOrders"], json!(0));
        // Integral JS numbers serialize without a decimal point.
        assert_eq!(summary["grossPkn"], json!(100));
        assert_eq!(summary["royaltyPkn"], json!(10));
        assert_eq!(summary["earningPkn"], json!(5));
        assert_eq!(summary["grossEurCents"], json!(250));
        assert_eq!(summary["royaltyEurCents"], json!(25));
        assert_eq!(summary["earningEurCents"], json!(13));
        // Daily buckets are oldest-first and keep both currencies separate.
        let daily = summary["daily"].as_array().unwrap();
        assert_eq!(daily.len(), 2);
        assert_eq!(daily[0]["date"], json!("2026-10-08"));
        assert_eq!(daily[0]["orders"], json!(1));
        assert_eq!(daily[0]["earningPkn"], json!(5));
        assert_eq!(daily[1]["date"], json!("2026-10-09"));
        assert_eq!(daily[1]["earningEurCents"], json!(13));
        // Recent orders are newest-first and mask the buyer.
        let orders = summary["orders"].as_array().unwrap();
        assert_eq!(orders.len(), 2);
        assert_eq!(orders[0]["orderId"], json!("o2"));
        assert_eq!(orders[0]["currency"], json!("EUR"));
        assert_eq!(orders[0]["sellers"], json!(1));
        assert_eq!(orders[1]["buyer"], json!("b****@pokoin.com"));
    }

    #[test]
    fn summary_marks_unverified_orders_without_earning_from_them() {
        let entries = vec![entry(
            "o1",
            json!({
                "paymentStatus": "paid",
                "shippingAddressCountryCode": "IT",
                "sellerUids": ["u1"],
                "subtotalPkn": 100
            }),
            &[],
            1_791_417_600_000,
        )];
        let summary = summarize_orders(&entries, 10.0, 50.0);
        assert_eq!(summary["unverifiedOrders"], json!(1));
        assert_eq!(summary["qualifyingOrders"], json!(0));
        assert_eq!(summary["earningPkn"], json!(0));
        assert_eq!(summary["orders"], json!([]));
    }

    #[test]
    fn integral_money_serializes_without_a_decimal_point() {
        // Mirrors `JSON.stringify(0)` in the Node handler.
        assert_eq!(num(0.0), json!(0));
        assert_eq!(num(5.0), json!(5));
        assert_eq!(num(-3.0), json!(-3));
        assert_eq!(num(12.5), json!(12.5));
        assert_eq!(num(0.01), json!(0.01));
        assert_eq!(num(f64::NAN), Json::Null);
        assert_eq!(num(1e18), json!(1e18));
    }

    #[test]
    fn recent_orders_are_capped_at_thirty() {
        let entries: Vec<OrderEntry> = (0..40)
            .map(|index| {
                entry(
                    &format!("o{index:02}"),
                    json!({
                        "paymentStatus": "paid",
                        "shippingAddressCountryCode": "IT",
                        "sellerUids": ["u1"],
                        "subtotalPkn": 1
                    }),
                    &[("u1", "IT")],
                    1_791_417_600_000 + i64::from(index) * 1000,
                )
            })
            .collect();
        let summary = summarize_orders(&entries, 10.0, 50.0);
        assert_eq!(summary["qualifyingOrders"], json!(40));
        assert_eq!(summary["orders"].as_array().unwrap().len(), RECENT_MAX);
        // Newest first.
        assert_eq!(summary["orders"][0]["orderId"], json!("o39"));
    }

    #[test]
    fn empty_earnings_has_the_documented_shape() {
        let earnings = empty_earnings();
        assert_eq!(earnings["qualifyingOrders"], json!(0));
        assert_eq!(earnings["unverifiedOrders"], json!(0));
        assert_eq!(earnings["grossPkn"], json!(0));
        assert_eq!(earnings["grossEurCents"], json!(0));
        assert_eq!(earnings["daily"], json!([]));
        assert_eq!(earnings["orders"], json!([]));
    }

    #[test]
    fn window_progress_clamps_and_reports_liveness() {
        let start = "2026-10-01T00:00:00.000Z";
        let end = "2026-10-11T00:00:00.000Z";
        let start_ms = 1_790_812_800_000i64;
        let end_ms = start_ms + 10 * 86_400_000;

        // Before the window.
        let progress = window_progress(start, end, start_ms - 86_400_000);
        assert_eq!(progress["daysTotal"], json!(10));
        assert_eq!(progress["daysElapsed"], json!(0));
        assert_eq!(progress["daysRemaining"], json!(10));
        assert_eq!(progress["live"], json!(false));

        // Inside the window.
        let progress = window_progress(start, end, start_ms + 3 * 86_400_000);
        assert_eq!(progress["daysElapsed"], json!(3));
        assert_eq!(progress["daysRemaining"], json!(7));
        assert_eq!(progress["live"], json!(true));

        // After the window.
        let progress = window_progress(start, end, end_ms + 86_400_000);
        assert_eq!(progress["daysElapsed"], json!(10));
        assert_eq!(progress["daysRemaining"], json!(0));
        assert_eq!(progress["live"], json!(false));
    }

    #[test]
    fn associate_rows_serialize_like_the_node_helper() {
        let row = json!({
            "email": "  Ash@Pokoin.COM ",
            "role": "  Ambassador ",
            "display_name": "  Ash Ketchum ",
            "share_pct": "50",
            "royalty_pct": 10,
            "window_start": "2026-10-01T00:00:00Z",
            "window_end": "2026-10-11T00:00:00Z",
            "active": true,
            "city": " Milan "
        });
        let associate = Associate::from_row(&row);
        assert_eq!(associate.email, "ash@pokoin.com");
        assert_eq!(associate.role, "ambassador");
        assert_eq!(associate.display_name, "Ash Ketchum");
        assert_eq!(associate.share_pct, 50.0);
        assert_eq!(associate.royalty_pct, 10.0);
        assert!(associate.active);
        assert_eq!(associate.city, "Milan");
        let json = associate.to_json();
        assert_eq!(json["windowStart"], json!("2026-10-01T00:00:00.000Z"));
        assert_eq!(json["role"], json!("ambassador"));

        // Missing role defaults to associate and active defaults to false.
        let minimal = Associate::from_row(&json!({ "email": "a@b.co" }));
        assert_eq!(minimal.role, "associate");
        assert!(!minimal.active);
        assert_eq!(minimal.window_start, "");
    }

    #[test]
    fn seller_uid_set_collects_distinct_uids() {
        let entries = vec![
            entry("a", json!({ "sellerUids": ["u1", "u2"] }), &[], 0),
            entry("b", json!({ "sellerUids": ["u2", ""] }), &[], 0),
        ];
        let set = seller_uid_set(&entries);
        assert_eq!(set.len(), 2);
        assert!(set.contains("u1"));
        assert!(set.contains("u2"));
    }
}
