//! The extra sources of `GET /api/marketplace-card-price-history`: the Cardmarket
//! price guide and the EUR→USD rates that put the TCGplayer USD quotes on the
//! same PKN scale. Every block degrades alone, so the SQL lives here and the
//! handlers pass their rows to the pure builders below.

use std::collections::HashMap;
use std::future::Future;

use pokoin_api_common::pg::{self, Bind};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::shared::js;
use crate::shared::table_presence::{self, Presence};

/// PKN per euro, the same 200 the token's reference price uses
/// (`reads::blueprint_price::PKN_USD_REFERENCE_PRICE` is `1 / 200` USD).
pub const PKN_PER_EUR: f64 = 200.0;

/// The Cardmarket products of one blueprint. `card_market_ids` is a jsonb array
/// of numeric strings, so anything that is not an array reads as no products.
pub const CM_PRODUCT_IDS_SQL: &str = "select cm.id as id_product \
     from public.cardtrader_pokemon_blueprints b \
     cross join lateral jsonb_array_elements_text(\
         case when jsonb_typeof(b.card_market_ids) = 'array' \
              then b.card_market_ids else '[]'::jsonb end\
       ) cm(id) \
     where b.id = $1::bigint";

/// Each price-guide run day of the range carrying every product's newest guide
/// row at or before it. `cardmarket_price_guide` is change-only, so the carried
/// row can predate `from`; a product with no such row yields no day.
pub const CM_GUIDE_HISTORY_SQL: &str = "select r.day::text as day, p.id_product::text as product_id, \
     g.guide_day::text as guide_day, \
     g.trend::float8 as trend, g.low::float8 as low, g.avg1::float8 as avg1, \
     g.avg7::float8 as avg7, g.avg30::float8 as avg30, \
     g.trend_foil::float8 as trend_foil, g.low_foil::float8 as low_foil, \
     g.avg1_foil::float8 as avg1_foil, g.avg7_foil::float8 as avg7_foil, g.avg30_foil::float8 as avg30_foil \
   from public.cardmarket_price_guide_runs r \
   cross join unnest($1::bigint[]) p(id_product) \
   cross join lateral ( \
     select guide.day as guide_day, guide.trend, guide.low, guide.avg1, guide.avg7, guide.avg30, \
            guide.trend_foil, guide.low_foil, guide.avg1_foil, guide.avg7_foil, guide.avg30_foil \
     from public.cardmarket_price_guide guide \
     where guide.game = 'pokemon' and guide.id_product = p.id_product and guide.day <= r.day \
     order by guide.day desc limit 1 \
   ) g \
   where r.game = 'pokemon' and r.day between $2::date and $3::date \
   order by p.id_product, r.day";

/// The stored EUR→USD rates up to the end of the range, oldest first.
pub const FX_RATES_SQL: &str =
    "select day::text as day, rate::float8 as rate from public.fx_rates_daily \
     where base = 'EUR' and quote = 'USD' and day <= $1::date order by day";

/// The table of `FX_RATES_SQL`, which only the Pokémon database has.
pub const FX_TABLE: &str = "public.fx_rates_daily";

/// The tables `CM_PRODUCT_IDS_SQL` and `CM_GUIDE_HISTORY_SQL` read, none of
/// which a satellite game's database has.
pub const CARDMARKET_TABLES: [&str; 3] = [
    "public.cardtrader_pokemon_blueprints",
    "public.cardmarket_price_guide_runs",
    "public.cardmarket_price_guide",
];

/// `YYYY-MM-DD` of a day cell (a `date` without the `::text` cast still arrives
/// as the node-pg timestamp string).
fn day_of(value: Option<&Value>) -> String {
    js::string_or_empty(value).chars().take(10).collect()
}

/// A numeric cell as `f64`; `None` for null, absent or non-finite (`0` is `0`).
fn number_of(value: Option<&Value>) -> Option<f64> {
    let value = value.filter(|value| !value.is_null())?;
    let number = js::number(Some(value));
    if number.is_finite() {
        Some(number)
    } else {
        None
    }
}

/// `Math.round(x * 100) / 100`; `None` when the value is not finite.
fn round2(value: f64) -> Option<f64> {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded.is_finite() {
        Some(rounded)
    } else {
        None
    }
}

/// The PKN of an EUR price (`trend × 200`); `None` for null, non-finite or ≤ 0.
pub fn pkn_of_eur(eur: Option<f64>) -> Option<f64> {
    round2(eur.filter(|eur| eur.is_finite() && eur > &0.0)? * PKN_PER_EUR)
}

/// The PKN of a USD price on an EUR→USD rate (`usd / rate × 200`); `None` for a
/// null or ≤ 0 price, or a missing/non-positive rate.
pub fn pkn_of_usd(usd: Option<f64>, rate: Option<f64>) -> Option<f64> {
    let usd = usd.filter(|usd| usd.is_finite() && usd > &0.0)?;
    let rate = rate.filter(|rate| rate.is_finite() && rate > &0.0)?;
    round2(usd / rate * PKN_PER_EUR)
}

/// The PKN of an amount in euro cents — the unit `cardmarket_offer_daily.min_cents`
/// stores — as a whole number, because `PKN_PER_EUR` cents per cent is exactly 2
/// and a price is never quoted in fractions of a PKN. `None` for a null,
/// non-finite or ≤ 0 cent amount.
pub fn pkn_of_cents(cents: Option<f64>) -> Option<f64> {
    let cents = cents.filter(|cents| cents.is_finite() && cents > &0.0)?;
    Some((cents * 2.0).round())
}

fn pkn_json(pkn: Option<f64>) -> Value {
    pkn.map(pg::js_number).unwrap_or(Value::Null)
}

/// One stored EUR→USD rate.
#[derive(Clone, Debug, PartialEq)]
pub struct FxRate {
    pub day: String,
    pub rate: f64,
}

/// A rate chosen for an entry day.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChosenRate {
    pub rate: f64,
    /// The entry is older than the first stored rate, so the oldest rate stands in.
    pub approx: bool,
}

/// The EUR→USD rates behind the PKN scale, oldest first.
#[derive(Clone, Debug, Default)]
pub struct FxRates {
    rates: Vec<FxRate>,
}

impl FxRates {
    /// The rates of `FX_RATES_SQL` rows; unreadable days and rates drop out, so a
    /// missing table or an empty result is simply "no rates".
    pub fn from_rows(rows: &[Value]) -> FxRates {
        let mut rates = Vec::new();
        for row in rows {
            let day = day_of(row.get("day"));
            let Some(rate) = number_of(row.get("rate")).filter(|rate| *rate > 0.0) else {
                continue;
            };
            if !day.is_empty() {
                rates.push(FxRate { day, rate });
            }
        }
        FxRates { rates }
    }

    /// The newest rate with `day <=` the asked day; the first stored rate (marked
    /// `approx`) for a day that predates the stored history; `None` without rates.
    pub fn rate_for(&self, day: &str) -> Option<ChosenRate> {
        let first = self.rates.first()?;
        let newest = self.rates.iter().rfind(|rate| rate.day.as_str() <= day);
        match newest {
            Some(rate) => Some(ChosenRate {
                rate: rate.rate,
                approx: false,
            }),
            None => Some(ChosenRate {
                rate: first.rate,
                approx: true,
            }),
        }
    }
}

/// The top-level `fx` block; `null` when no rate was stored.
pub fn fx_json(rates: &FxRates) -> Value {
    let (Some(first), Some(last)) = (rates.rates.first(), rates.rates.last()) else {
        return Value::Null;
    };
    json!({ "base": "EUR", "quote": "USD", "firstDay": first.day, "lastDay": last.day })
}

/// Add `marketPkn` to one TCGplayer day entry, plus `"fxApprox": true` when the
/// entry predates the first stored rate. `marketPkn` is `null` without a usable
/// price or without any rate.
pub fn add_market_pkn(entry: &mut Value, market_price: Option<&Value>, day: &str, rates: &FxRates) {
    let Some(object) = entry.as_object_mut() else {
        return;
    };
    let chosen = rates.rate_for(day);
    let pkn = pkn_of_usd(number_of(market_price), chosen.map(|rate| rate.rate));
    object.insert("marketPkn".to_owned(), pkn_json(pkn));
    if pkn.is_some() && chosen.is_some_and(|rate| rate.approx) {
        object.insert("fxApprox".to_owned(), json!(true));
    }
}

/// One carried guide row of a product, in the shape the desk plots.
fn guide_day_entry(row: &Value) -> Value {
    json!({
        "day": day_of(row.get("day")),
        "guideDay": day_of(row.get("guide_day")),
        "trend": row["trend"], "low": row["low"], "avg1": row["avg1"], "avg7": row["avg7"], "avg30": row["avg30"],
        "trendFoil": row["trend_foil"], "lowFoil": row["low_foil"], "avg1Foil": row["avg1_foil"],
        "avg7Foil": row["avg7_foil"], "avg30Foil": row["avg30_foil"],
        "trendPkn": pkn_json(pkn_of_eur(number_of(row.get("trend")))),
        "trendFoilPkn": pkn_json(pkn_of_eur(number_of(row.get("trend_foil")))),
    })
}

/// The `cardmarket` block: the guide days grouped per product, in row order.
/// `status` overrides the derived one (a failed query is `unavailable`).
pub fn cardmarket_source(rows: &[Value], status: Option<&str>) -> Value {
    let mut order: Vec<String> = Vec::new();
    let mut by: HashMap<String, Vec<Value>> = HashMap::new();
    for row in rows {
        let product = js::string_or_empty(row.get("product_id"));
        let entry = by.entry(product.clone()).or_insert_with(|| {
            order.push(product.clone());
            Vec::new()
        });
        entry.push(guide_day_entry(row));
    }
    json!({
        "source": "cardmarket_price_guide", "currency": "EUR", "metric": "trend",
        "status": status.unwrap_or(if rows.is_empty() { "empty" } else { "available" }),
        "conditionSpecific": false, "languageSpecific": false,
        "products": order.into_iter().filter_map(|product| by.remove(&product).map(|days| json!({ "productId": product, "days": days }))).collect::<Vec<_>>(),
    })
}

/// The `cardmarket` block of a game whose price guide we do not load.
pub fn unsupported_cardmarket() -> Value {
    json!({ "source": "cardmarket_price_guide", "status": "unsupported_game", "currency": "EUR", "metric": "trend", "products": [] })
}

/// The card's Cardmarket products, in `card_market_ids` order.
pub async fn cm_product_ids(pool: &PgPool, ct_id: &str) -> Result<Vec<i64>, sqlx::Error> {
    let rows = pg::pool_rows(pool, CM_PRODUCT_IDS_SQL, &[Bind::Text(ct_id.to_owned())]).await?;
    let mut products: Vec<i64> = Vec::new();
    for row in &rows {
        if let Some(id) = js::string_or_empty(row.get("id_product"))
            .parse::<i64>()
            .ok()
            .filter(|id| *id > 0)
        {
            if !products.contains(&id) {
                products.push(id);
            }
        }
    }
    Ok(products)
}

/// The guide rows carried onto every run day of the range.
pub async fn cm_guide_rows(
    pool: &PgPool,
    products: &[i64],
    from: &str,
    to: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    if products.is_empty() {
        return Ok(Vec::new());
    }
    pg::pool_rows(
        pool,
        CM_GUIDE_HISTORY_SQL,
        &[
            Bind::BigIntArray(products.to_vec()),
            Bind::Text(from.to_owned()),
            Bind::Text(to.to_owned()),
        ],
    )
    .await
}

/// The `cardmarket` block of one blueprint: its products, then the guide rows
/// carried onto the run days. A failed query fails this block alone.
async fn cardmarket_block(pool: &PgPool, ct_id: &str, from: &str, to: &str) -> Value {
    let products = match cm_product_ids(pool, ct_id).await {
        Ok(products) => products,
        Err(error) => return failed_cardmarket(&error),
    };
    match cm_guide_rows(pool, &products, from, to).await {
        Ok(rows) => cardmarket_source(&rows, None),
        Err(error) => failed_cardmarket(&error),
    }
}

/// The `cardmarket` block with the probe already answered. `read` runs the two
/// Cardmarket queries and is reached only when `presence` says their tables are
/// there, so a database without them answers `empty` and logs no Postgres error
/// (PH-02).
pub async fn cardmarket_leg<R, Fut>(presence: Presence, read: R) -> Value
where
    R: FnOnce() -> Fut,
    Fut: Future<Output = Value>,
{
    table_presence::guarded(
        presence,
        read,
        || cardmarket_source(&[], None),
        || cardmarket_source(&[], Some("unavailable")),
    )
    .await
}

/// The `cardmarket` block of the response. Only Pokémon has a guide; every other
/// game gets the stub without a query, and a database without the guide tables
/// answers `empty` without one either.
pub async fn cardmarket_history(
    pool: &PgPool,
    game: &str,
    ct_id: Option<&str>,
    from: &str,
    to: &str,
) -> Value {
    if game != "pokemon" {
        return unsupported_cardmarket();
    }
    let Some(ct_id) = ct_id.filter(|ct_id| !ct_id.is_empty()) else {
        return cardmarket_source(&[], None);
    };
    let presence = table_presence::presence_all(pool, &CARDMARKET_TABLES).await;
    cardmarket_leg(presence, || cardmarket_block(pool, ct_id, from, to)).await
}

/// The cheapest offer of every condition floor of one Cardmarket product and one
/// language, per day. Every value is a bind. `condition <> '*'` because that row
/// is Cardmarket's own aggregate over the floors rather than a floor the graph
/// can plot; `finish` and `first_edition` keep the exact and the `'*'` rows so
/// that a day whose facet page was not asked can still be answered by its
/// aggregate row, which [`facet_or_star`] then prefers to use only as a fallback.
pub const CM_OFFER_HISTORY_SQL: &str = "select o.day::text as day, o.condition, o.seller_type, \
       o.min_cents::float8 as min_cents, o.asked, o.finish, o.first_edition \
   from public.cardmarket_offer_daily o \
   where o.cm_product_id = $1::bigint \
     and o.language = $2 \
     and o.condition <> '*' \
     and (o.finish = $3 or o.finish = '*') \
     and (o.first_edition = $4 or o.first_edition = '*') \
     and o.day between $5::date and $6::date \
   order by o.condition, o.day, o.min_cents, o.seller_type";

/// The table of `CM_OFFER_HISTORY_SQL`.
pub const CM_OFFER_TABLE: &str = "public.cardmarket_offer_daily";

/// The tables this leg reads: the blueprints that turn a card into a Cardmarket
/// product and the daily offer table itself. Neither exists on a satellite game's
/// database, and the offer table is not migrated on production yet — the probe
/// then answers this leg `empty` without a query (PH-02).
pub const CM_OFFER_TABLES: [&str; 2] = ["public.cardtrader_pokemon_blueprints", CM_OFFER_TABLE];

/// The condition floors of the answer, in the order the graph lists them. `Poor`
/// is Cardmarket's own spelling; `'*'` is its aggregate over the floors and is
/// never a series of its own.
pub const CM_OFFER_FLOORS: [&str; 5] = ["NM", "SP", "MP", "PL", "Poor"];

/// The language keys `cardmarket_offer_daily` stores, `'*'` included: every
/// language of the product in one line.
pub const CM_OFFER_LANGUAGES: [&str; 14] = [
    "EN", "FR", "DE", "ES", "IT", "ZH", "JP", "PT", "RU", "KO", "ZHT", "NL", "PL", "*",
];

/// The default facet of the leg: near mint, English.
pub const CM_OFFER_DEFAULT_CONDITION: &str = "NM";
pub const CM_OFFER_DEFAULT_LANGUAGE: &str = "EN";

/// The printing the daily table is read for: Cardmarket's language plus the two
/// flags that say which rows of that language are this card. They always travel
/// together — a request has one of them, and the block it answers names them
/// back — so they are one argument rather than three.
#[derive(Debug, Clone, Copy)]
pub struct CmOfferPrinting<'a> {
    pub language: &'a str,
    pub finish: &'a str,
    pub first_edition: &'a str,
}

/// `value` as one of the floors, case-insensitively, or `None`; an empty asked
/// value is the default floor, because the desk's "Any condition" is no filter.
pub fn cm_offer_condition(value: Option<&str>) -> Option<&'static str> {
    let value = value.map(str::trim).unwrap_or("");
    if value.is_empty() {
        return Some(CM_OFFER_DEFAULT_CONDITION);
    }
    CM_OFFER_FLOORS
        .iter()
        .find(|floor| floor.eq_ignore_ascii_case(value))
        .copied()
}

/// `value` as one of the stored language keys, case-insensitively, or `None`.
pub fn cm_offer_language(value: Option<&str>) -> Option<&'static str> {
    let value = value.map(str::trim).unwrap_or("");
    if value.is_empty() {
        return Some(CM_OFFER_DEFAULT_LANGUAGE);
    }
    CM_OFFER_LANGUAGES
        .iter()
        .find(|key| key.eq_ignore_ascii_case(value))
        .copied()
}

/// One `CM_OFFER_HISTORY_SQL` row: the cheapest offer of one seller type of one
/// floor on one day, under one facet.
#[derive(Clone, Debug, PartialEq)]
pub struct OfferRow {
    pub day: String,
    pub condition: String,
    pub seller_type: String,
    /// The offer price in euro cents; `None` when the cell is not readable, which
    /// [`cm_offer_series`] leaves out rather than plotting as a price of zero.
    pub min_cents: Option<f64>,
    /// Whether the day's facet page was asked for, as the loader recorded it.
    pub asked: bool,
    pub finish: String,
    pub first_edition: String,
}

impl OfferRow {
    /// The row of `CM_OFFER_HISTORY_SQL`; a day that is not a day, a floor that
    /// is not a floor and an absent seller type are not offers at all.
    fn from_row(row: &Value) -> Option<OfferRow> {
        let day = day_of(row.get("day"));
        let condition = js::string_or_empty(row.get("condition"));
        if day.is_empty() || condition.is_empty() {
            return None;
        }
        Some(OfferRow {
            day,
            condition,
            seller_type: js::string_or_empty(row.get("seller_type")),
            min_cents: number_of(row.get("min_cents")),
            asked: row.get("asked").and_then(Value::as_bool).unwrap_or(false),
            finish: js::string_or_empty(row.get("finish")),
            first_edition: js::string_or_empty(row.get("first_edition")),
        })
    }
}

/// The rows of one day that answer the asked facet value: those naming it
/// exactly, and only when the day carries no such row the `'*'` aggregate the
/// loader writes for a day whose facet page was not fetched. Asking `'*'` is
/// asking the aggregate, so then every row of the day counts.
fn facet_rows<'a>(
    rows: &[&'a OfferRow],
    asked: &str,
    cell: impl Fn(&OfferRow) -> &str,
) -> Vec<&'a OfferRow> {
    if asked == "*" {
        return rows.to_vec();
    }
    let exact: Vec<&'a OfferRow> = rows
        .iter()
        .copied()
        .filter(|row| cell(row) == asked)
        .collect();
    if !exact.is_empty() {
        return exact;
    }
    rows.iter()
        .copied()
        .filter(|row| cell(row) == "*")
        .collect()
}

/// The place in [`CM_OFFER_FLOORS`] of a row's condition; `None` for anything
/// else, which is not a floor the graph has a line for.
fn cm_offer_floor_index(condition: &str) -> Option<usize> {
    CM_OFFER_FLOORS.iter().position(|floor| *floor == condition)
}

/// Price first, its seller type inside it; a row whose cents cannot be read
/// stands last, so it never wins a day it cannot price.
fn by_offer_price(a: &OfferRow, b: &OfferRow) -> std::cmp::Ordering {
    a.min_cents
        .unwrap_or(f64::MAX)
        .partial_cmp(&b.min_cents.unwrap_or(f64::MAX))
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| a.seller_type.cmp(&b.seller_type))
}

/// The series of the answer, one per floor that has a day, in
/// [`CM_OFFER_FLOORS`] order. Every floor's days are oldest first and each day
/// carries the cheapest offer across the seller types of the facet asked:
/// `finish` and `first_edition`, each falling back to that day's `'*'` row only
/// when the day has no row naming the asked value.
pub fn cm_offer_series(rows: &[Value], finish: &str, first_edition: &str) -> Vec<Value> {
    let owned: Vec<OfferRow> = rows
        .iter()
        .filter_map(OfferRow::from_row)
        .filter(|row| cm_offer_floor_index(&row.condition).is_some())
        .collect();
    let mut parsed: Vec<&OfferRow> = owned.iter().collect();
    parsed.sort_by(|a, b| {
        cm_offer_floor_index(&a.condition)
            .cmp(&cm_offer_floor_index(&b.condition))
            .then_with(|| a.day.cmp(&b.day))
            .then_with(|| by_offer_price(a, b))
    });
    CM_OFFER_FLOORS
        .iter()
        .enumerate()
        .filter_map(|(index, floor)| {
            let cells: Vec<&OfferRow> = parsed
                .iter()
                .copied()
                .filter(|row| cm_offer_floor_index(&row.condition) == Some(index))
                .collect();
            let mut days: Vec<Value> = Vec::new();
            let mut next = 0usize;
            while next < cells.len() {
                let day = cells[next].day.as_str();
                let mut end = next;
                while end < cells.len() && cells[end].day == day {
                    end += 1;
                }
                let cell = &cells[next..end];
                next = end;
                let asked = facet_rows(
                    &facet_rows(cell, finish, |row| row.finish.as_str()),
                    first_edition,
                    |row| row.first_edition.as_str(),
                );
                let Some(offer) = asked.first() else {
                    continue;
                };
                let Some(pkn) = pkn_of_cents(offer.min_cents) else {
                    continue;
                };
                days.push(json!({
                    "day": day,
                    "lowestPkn": pkn_json(Some(pkn)),
                    "sellerType": offer.seller_type,
                    "asked": offer.asked,
                }));
            }
            if days.is_empty() {
                return None;
            }
            Some(json!({ "condition": floor, "days": days }))
        })
        .collect()
}

/// The `cardmarketOffers` block: the floors of the product in `product` that the
/// daily table has offers for. `status` overrides the derived one (a failed query
/// is `unavailable`).
pub fn cardmarket_offers_source(
    rows: &[Value],
    status: Option<&str>,
    product: Option<i64>,
    language: &str,
    finish: &str,
    first_edition: &str,
) -> Value {
    json!({
        "source": "cardmarket_offers", "currency": "PKN", "metric": "lowestOffer",
        "status": status.unwrap_or(if rows.is_empty() { "empty" } else { "available" }),
        "idProduct": product, "language": language,
        "finish": finish, "firstEdition": first_edition, "conditionIsFloor": true,
        "series": cm_offer_series(rows, finish, first_edition),
    })
}

/// The `cardmarketOffers` block of a game whose offers we do not collect.
pub fn unsupported_cardmarket_offers(language: &str) -> Value {
    json!({
        "source": "cardmarket_offers", "status": "unsupported_game", "currency": "PKN",
        "metric": "lowestOffer", "idProduct": Value::Null, "language": language,
        "conditionIsFloor": true, "series": [],
    })
}

/// The offer rows of one product, language and facet of the range.
pub async fn cm_offer_rows(
    pool: &PgPool,
    product: i64,
    language: &str,
    finish: &str,
    first_edition: &str,
    from: &str,
    to: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    pg::pool_rows(
        pool,
        CM_OFFER_HISTORY_SQL,
        &[
            Bind::Int(product),
            Bind::Text(language.to_owned()),
            Bind::Text(finish.to_owned()),
            Bind::Text(first_edition.to_owned()),
            Bind::Text(from.to_owned()),
            Bind::Text(to.to_owned()),
        ],
    )
    .await
}

fn failed_cardmarket_offers(error: &sqlx::Error, language: &str) -> Value {
    warn_query(CM_OFFER_TABLE, error);
    cardmarket_offers_source(&[], Some("unavailable"), None, language, "", "")
}

/// The `cardmarketOffers` block of one blueprint: its first product, then
/// `CM_OFFER_HISTORY_SQL`. A failure of either query fails this block alone.
async fn cardmarket_offers_block(
    pool: &PgPool,
    ct_id: &str,
    from: &str,
    to: &str,
    language: &str,
    finish: &str,
    first_edition: &str,
) -> Value {
    let products = match cm_product_ids(pool, ct_id).await {
        Ok(products) => products,
        Err(error) => return failed_cardmarket_offers(&error, language),
    };
    let Some(product) = products.first().copied() else {
        return cardmarket_offers_source(&[], None, None, language, finish, first_edition);
    };
    match cm_offer_rows(pool, product, language, finish, first_edition, from, to).await {
        Ok(rows) => {
            cardmarket_offers_source(&rows, None, Some(product), language, finish, first_edition)
        }
        Err(error) => failed_cardmarket_offers(&error, language),
    }
}

/// The `cardmarketOffers` block with the probe already answered. `read` runs the
/// two queries and is reached only when `presence` says their tables are there,
/// so a database without the daily table answers `empty` and logs no Postgres
/// error (PH-02).
pub async fn cardmarket_offers_leg<R, Fut>(presence: Presence, read: R) -> Value
where
    R: FnOnce() -> Fut,
    Fut: Future<Output = Value>,
{
    table_presence::guarded(
        presence,
        read,
        || cardmarket_offers_source(&[], None, None, CM_OFFER_DEFAULT_LANGUAGE, "", ""),
        || {
            cardmarket_offers_source(
                &[],
                Some("unavailable"),
                None,
                CM_OFFER_DEFAULT_LANGUAGE,
                "",
                "",
            )
        },
    )
    .await
}

/// The `cardmarketOffers` block of the response. Only Pokémon has collected
/// offers; every other game is the stub without a query, a card without a
/// blueprint is `empty` without one, and a database without the daily table is
/// `empty` from the probe without one either.
pub async fn cardmarket_offers_history(
    pool: &PgPool,
    game: &str,
    ct_id: Option<&str>,
    from: &str,
    to: &str,
    printing: CmOfferPrinting<'_>,
) -> Value {
    let CmOfferPrinting {
        language,
        finish,
        first_edition,
    } = printing;
    if game != "pokemon" {
        return unsupported_cardmarket_offers(language);
    }
    let Some(ct_id) = ct_id.filter(|ct_id| !ct_id.is_empty()) else {
        return cardmarket_offers_source(&[], None, None, language, finish, first_edition);
    };
    let presence = table_presence::presence_all(pool, &CM_OFFER_TABLES).await;
    cardmarket_offers_leg(presence, || {
        cardmarket_offers_block(pool, ct_id, from, to, language, finish, first_edition)
    })
    .await
}

/// The graph day of the offers leg: the plotted price of the day alone, as the
/// brief shapes it. Nothing without a PKN price.
fn cm_offer_graph_day(day: &Value) -> Option<Value> {
    let price = day.get("lowestPkn").filter(|price| !price.is_null())?;
    Some(json!({ "day": day_of(day.get("day")), "lowestPkn": price }))
}

/// The listing events that decide the `pokoin` line of one card: the last change
/// of every listing before the start of the range — the state its first day
/// begins in — and every change up to the end of the range. Each half is a
/// `card_id` equality plus an `occurred_at` bound, which is exactly
/// `marketplace_user_listing_events_card_day_idx (card_id, occurred_at desc)`, so
/// one statement reads the card's whole history and the day-by-day state is
/// folded from its rows below.
///
/// The event `id` is read with them and is what orders the rows: the audit
/// trigger writes `occurred_at = now()`, the transaction timestamp, so two
/// changes of one listing inside one transaction — a decrement per order line —
/// share an instant exactly, and only the id says which of them is the listing's
/// last state (`scripts/sql/listing-pipeline.sql`).
pub const POKOIN_EVENTS_SQL: &str = "with before_start as ( \
     select distinct on (e.listing_id) e.listing_id::text as listing_id, e.id, e.occurred_at, \
            e.status_after, e.quantity_after, e.price_pkn::float8 as price_pkn \
       from public.marketplace_user_listing_events e \
      where e.card_id = $1::text and e.occurred_at < $2::timestamptz \
      order by e.listing_id, e.occurred_at desc, e.id desc \
   ), in_range as ( \
     select e.listing_id::text as listing_id, e.id, e.occurred_at, e.status_after, \
            e.quantity_after, e.price_pkn::float8 as price_pkn \
       from public.marketplace_user_listing_events e \
      where e.card_id = $1::text and e.occurred_at >= $2::timestamptz \
        and e.occurred_at < $3::timestamptz \
   ) \
   select listing_id, id, \
          to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD') as day, \
          to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as at_utc, \
          status_after, quantity_after, price_pkn \
     from (select * from before_start union all select * from in_range) asked \
    order by occurred_at, id";

/// The one table of `POKOIN_EVENTS_SQL`. The marketplace database writes it from
/// the listings audit trigger, which a satellite game's catalog database does not
/// have, so the leg is probed like the other single-database sources (PH-02).
pub const POKOIN_EVENTS_TABLE: &str = "public.marketplace_user_listing_events";

/// `YYYY-MM-DD` as the UTC instant that starts that day. Binding the bounds as
/// instants rather than comparing `occurred_at at time zone` keeps the statement
/// independent of the session zone and index-usable.
fn day_start_utc(day: &str) -> String {
    format!("{day}T00:00:00+00:00")
}

fn naive_day(day: &str) -> Option<chrono::NaiveDate> {
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()
}

/// The UTC instant that starts the day after `day`: the exclusive end of a range
/// whose last plotted day is `day`.
fn day_after_utc(day: &str) -> String {
    naive_day(day)
        .and_then(|day| day.succ_opt())
        .map(|next| day_start_utc(&next.format("%Y-%m-%d").to_string()))
        .unwrap_or_else(|| day_start_utc(day))
}

/// The event `id` as a row carries it: `row_to_node_json` renders a `bigint` as a
/// string, so the tie-breaker of two same-instant changes is read from the text.
/// `None` for a cell that is absent, null or not a whole number — an id that
/// cannot be read orders nothing, and a fold that guesses one plots a state the
/// market never had.
fn event_id(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::String(id) => id.trim().parse::<i64>().ok(),
        Value::Number(id) => id.as_i64(),
        _ => None,
    }
}

/// One row of `POKOIN_EVENTS_SQL`: a listing as it stands from `at` on.
#[derive(Clone, Debug, PartialEq)]
pub struct ListingEvent {
    /// The listing the change belongs to; rows without one share one state.
    pub listing: String,
    /// The event's own `id`, which orders two changes of one listing that share
    /// the instant — the transaction timestamp the audit trigger writes.
    pub id: i64,
    /// The UTC day of the change.
    pub day: String,
    /// The instant of the change, which orders the rows.
    pub at: String,
    pub status: String,
    pub quantity: Option<i64>,
    pub price: Option<f64>,
}

impl ListingEvent {
    /// The event of one row; a row without a day, an instant or a readable event
    /// id is not a change.
    fn from_row(row: &Value) -> Option<ListingEvent> {
        let day = day_of(row.get("day"));
        let at = js::string_or_empty(row.get("at_utc"));
        let id = event_id(row.get("id"))?;
        if day.len() != 10 || at.is_empty() {
            return None;
        }
        Some(ListingEvent {
            id,
            listing: js::string_or_empty(row.get("listing_id")),
            day,
            at,
            status: js::string_or_empty(row.get("status_after")),
            quantity: number_of(row.get("quantity_after")).map(|quantity| quantity as i64),
            price: number_of(row.get("price_pkn")),
        })
    }

    /// The change leaves the listing sellable: active, something in stock and a
    /// price above zero. Anything else takes it off the market.
    fn is_live(&self) -> bool {
        self.status == "active"
            && self.quantity.is_some_and(|quantity| quantity > 0)
            && self.price.is_some_and(|price| price > 0.0)
    }
}

/// The rows of `POKOIN_EVENTS_SQL` in the order the changes happened: the instant
/// first, and the event id inside it, because two changes written by one
/// transaction carry that transaction's timestamp and nothing else separates them.
pub fn listing_events(rows: &[Value]) -> Vec<ListingEvent> {
    let mut events: Vec<ListingEvent> = rows.iter().filter_map(ListingEvent::from_row).collect();
    events.sort_by(|a, b| {
        a.at.cmp(&b.at)
            .then_with(|| a.id.cmp(&b.id))
            .then_with(|| a.listing.cmp(&b.listing))
    });
    events
}

/// The `pokoin` line's days: for every UTC day of `from`..=`to`, the cheapest
/// price a live listing of the card has reached by the end of that day. A day
/// without a live listing yields no entry, and a day before the card's first
/// event yields none either because the state is empty until then.
pub fn pokoin_price_days(events: &[ListingEvent], from: &str, to: &str) -> Vec<Value> {
    let (Some(mut day), Some(last)) = (naive_day(from), naive_day(to)) else {
        return Vec::new();
    };
    // Each live listing as it stands at the end of the day in hand; a listing
    // that exists twice has one state, the last event's.
    let mut live: HashMap<&str, f64> = HashMap::new();
    let mut days = Vec::new();
    let mut next = 0usize;
    while day <= last {
        let label = day.format("%Y-%m-%d").to_string();
        while next < events.len() && events[next].day <= label {
            let event = &events[next];
            if event.is_live() {
                live.insert(event.listing.as_str(), event.price.unwrap_or_default());
            } else {
                live.remove(event.listing.as_str());
            }
            next += 1;
        }
        if let Some(cheapest) = live
            .values()
            .cloned()
            .reduce(|cheap, price| cheap.min(price))
        {
            days.push(json!({
                "day": label,
                "lowestAskPkn": pg::js_number(cheapest),
                "listingCount": live.len(),
            }));
        }
        let Some(following) = day.succ_opt() else {
            break;
        };
        day = following;
    }
    days
}

/// The `pokoin` block of the days in `rows`. `status` overrides the derived one
/// (a failed query is `unavailable`).
pub fn pokoin_source(rows: &[Value], status: Option<&str>, from: &str, to: &str) -> Value {
    let days = pokoin_price_days(&listing_events(rows), from, to);
    json!({
        "source": "pokoin_listings", "currency": "PKN", "metric": "lowestAsk",
        "status": status.unwrap_or(if days.is_empty() { "empty" } else { "available" }),
        "days": days,
    })
}

/// The event rows of one card between the start of `from` and the end of `to`.
pub async fn pokoin_event_rows(
    pool: &PgPool,
    card_id: &str,
    from: &str,
    to: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    pg::pool_rows(
        pool,
        POKOIN_EVENTS_SQL,
        &[
            Bind::Text(card_id.to_owned()),
            Bind::Text(day_start_utc(from)),
            Bind::Text(day_after_utc(to)),
        ],
    )
    .await
}

/// The `pokoin` block with the probe already answered. `read` queries the events
/// table and is reached only when `presence` says it is there, so a database
/// without it answers `empty` and logs no Postgres error (PH-02).
pub async fn pokoin_leg<R, Fut>(presence: Presence, from: &str, to: &str, read: R) -> Value
where
    R: FnOnce() -> Fut,
    Fut: Future<Output = Value>,
{
    table_presence::guarded(
        presence,
        read,
        || pokoin_source(&[], None, from, to),
        || pokoin_source(&[], Some("unavailable"), from, to),
    )
    .await
}

async fn pokoin_block(pool: &PgPool, card_id: &str, from: &str, to: &str) -> Value {
    match pokoin_event_rows(pool, card_id, from, to).await {
        Ok(rows) => pokoin_source(&rows, None, from, to),
        Err(error) => {
            warn_query(POKOIN_EVENTS_TABLE, &error);
            pokoin_source(&[], Some("unavailable"), from, to)
        }
    }
}

/// The `pokoin` block of one card: the cached probe of the listing-events table,
/// then `POKOIN_EVENTS_SQL`. The table lives in the marketplace database, which
/// is the pool a Pokémon request reads and which the listings of every game are
/// tagged in; a satellite game's own database does not have it and is answered
/// `empty` from the probe without a query.
pub async fn pokoin_history(pool: &PgPool, card_id: &str, from: &str, to: &str) -> Value {
    let presence = table_presence::presence(pool, POKOIN_EVENTS_TABLE).await;
    pokoin_leg(presence, from, to, || pokoin_block(pool, card_id, from, to)).await
}

/// The rates of `FX_RATES_SQL`; a failed query is no rates, exactly as before.
async fn fx_rows(pool: &PgPool, to: &str) -> FxRates {
    match pg::pool_rows(pool, FX_RATES_SQL, &[Bind::Text(to.to_owned())]).await {
        Ok(rows) => FxRates::from_rows(&rows),
        Err(error) => {
            warn_query(FX_TABLE, &error);
            FxRates::default()
        }
    }
}

/// The rates with the probe already answered: no rates — and no query — when the
/// database has no `fx_rates_daily` (PH-02).
pub async fn fx_rates_leg<R, Fut>(presence: Presence, read: R) -> FxRates
where
    R: FnOnce() -> Fut,
    Fut: Future<Output = FxRates>,
{
    table_presence::guarded(presence, read, FxRates::default, FxRates::default).await
}

/// The EUR→USD rates up to `to`; no rates when the table is missing or empty.
pub async fn read_fx_rates(pool: &PgPool, to: &str) -> FxRates {
    fx_rates_leg(table_presence::presence(pool, FX_TABLE).await, || {
        fx_rows(pool, to)
    })
    .await
}

/// A span longer than this many days answers the graph with one point per week.
pub const GRAPH_WEEK_SPAN_DAYS: i64 = 400;

/// The `fields` value that asks for the graph shape (PH-06).
pub const GRAPH_FIELDS: &str = "graph";

/// `true` when the span is long enough that the graph is answered per week.
pub fn graph_is_weekly(from: &str, to: &str) -> bool {
    match (naive_day(from), naive_day(to)) {
        (Some(from), Some(to)) => to.signed_duration_since(from).num_days() > GRAPH_WEEK_SPAN_DAYS,
        _ => false,
    }
}

/// The ISO week (`YYYY-Www`) a day falls in; `None` for anything but a day.
fn iso_week(day: &str) -> Option<String> {
    use chrono::Datelike;
    let week = naive_day(day)?.iso_week();
    Some(format!("{}-W{:02}", week.year(), week.week()))
}

/// One point per ISO week: of the days of a week, the last one that carries a
/// value. Rows must be in ascending `day` order and carry valued days only; a day
/// that is not a date is kept as its own point rather than folded into a week.
pub fn thin_weekly(days: &[Value]) -> Vec<Value> {
    let mut weeks: Vec<Value> = Vec::new();
    for day in days {
        let label = day_of(day.get("day"));
        let same_week = weeks
            .last()
            .and_then(|last| iso_week(&day_of(last.get("day"))))
            .zip(iso_week(&label))
            .is_some_and(|(seen, week)| seen == week);
        if same_week {
            if let Some(last) = weeks.last_mut() {
                *last = day.clone();
            }
        } else {
            weeks.push(day.clone());
        }
    }
    weeks
}

/// The graph day of an ask series (CardTrader or Pokoin): nothing without a price.
fn ask_graph_day(day: &Value) -> Option<Value> {
    let price = day.get("lowestAskPkn").filter(|price| !price.is_null())?;
    Some(json!({ "day": day_of(day.get("day")), "lowestAskPkn": price }))
}

/// The graph day of a TCGplayer observation: only the PKN price, plus the flag
/// that says the rate behind it is approximate. A day TCGplayer has no price for
/// draws nothing and is left out.
fn tcg_graph_day(day: &Value) -> Option<Value> {
    let price = day.get("marketPkn").filter(|price| !price.is_null())?;
    let mut out = Map::new();
    out.insert("day".to_owned(), json!(day_of(day.get("day"))));
    out.insert("marketPkn".to_owned(), price.clone());
    if day
        .get("fxApprox")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        out.insert("fxApprox".to_owned(), json!(true));
    }
    Some(Value::Object(out))
}

/// The graph day of a Cardmarket product: the trend and its foil counterpart,
/// neither of which the other can stand in for. Nothing when both are absent.
fn cardmarket_graph_day(day: &Value) -> Option<Value> {
    let trend = day
        .get("trendPkn")
        .filter(|trend| !trend.is_null())
        .cloned();
    let foil = day
        .get("trendFoilPkn")
        .filter(|foil| !foil.is_null())
        .cloned();
    if trend.is_none() && foil.is_none() {
        return None;
    }
    let mut out = Map::new();
    out.insert("day".to_owned(), json!(day_of(day.get("day"))));
    out.insert("trendPkn".to_owned(), trend.unwrap_or(Value::Null));
    out.insert("trendFoilPkn".to_owned(), foil.unwrap_or(Value::Null));
    Some(Value::Object(out))
}

/// `block` with `key` replaced by `value`, every other field in its own place.
fn with_field(block: &Value, key: &str, value: Value) -> Value {
    let Some(object) = block.as_object() else {
        return block.clone();
    };
    let mut out = Map::new();
    for (name, field) in object {
        out.insert(
            name.clone(),
            if name == key {
                value.clone()
            } else {
                field.clone()
            },
        );
    }
    Value::Object(out)
}

/// The plotted days of one block: `pick` applied to every row that has them, then
/// the weekly thinning when the span asks for it.
fn graph_day_rows<F>(rows: Option<&Vec<Value>>, weekly: bool, pick: F) -> Vec<Value>
where
    F: Fn(&Value) -> Option<Value>,
{
    let kept: Vec<Value> = rows
        .map(|rows| rows.iter().filter_map(&pick).collect())
        .unwrap_or_default();
    if weekly {
        thin_weekly(&kept)
    } else {
        kept
    }
}

/// The days of a series the graph can draw: TCGplayer keeps answering a product
/// whose market price has gone, and those days are not a line.
fn tcg_priced_days(row: &Value) -> usize {
    row.get("days")
        .and_then(Value::as_array)
        .map(|days| {
            days.iter()
                .filter(|day| day.get("marketPkn").is_some_and(|price| !price.is_null()))
                .count()
        })
        .unwrap_or(0)
}

/// The row with the most priced days among those `within` accepts, the most rows
/// when several tie, and the first of those that tie on both; `None` when none is
/// accepted.
fn most_days(series: &[Value], within: impl Fn(&Value) -> bool) -> Option<&Value> {
    let mut best: Option<(&Value, (usize, usize))> = None;
    for row in series.iter().filter(|row| within(row)) {
        let seen = row
            .get("days")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        let rank = (tcg_priced_days(row), seen);
        if best.is_none_or(|(_, best_rank)| rank > best_rank) {
            best = Some((row, rank));
        }
    }
    best.map(|(row, _)| row)
}

fn is_reverse_series(series: &Value) -> bool {
    js::string_or_empty(series.get("subtype"))
        .to_lowercase()
        .contains("reverse")
}

/// The TCGplayer series the graph plots: a reverse-holo one when `reverse`, a
/// non-reverse one otherwise; among those the one with the most priced days, and
/// of all of them when none is in the preferred group.
pub fn chosen_series(series: &[Value], reverse: bool) -> Option<&Value> {
    most_days(series, |row| is_reverse_series(row) == reverse)
        .or_else(|| most_days(series, |_| true))
}

/// Where a series stopped being priced, as the two fields of its graph entry.
/// TCGplayer goes on answering the days of a product that has no market price,
/// and a line that simply ends cannot tell that apart from a source that stopped;
/// `last_observed_day` is the last day it answered at all, when that is later than
/// its last priced day, and `last_listing` the newest such later day whose ask
/// reaches a PKN amount — an ask of zero or one the rates cannot convert is passed
/// over for the older day that is neither, so one dead quote does not silence the
/// source. Nothing for a series priced through its last day.
fn tcg_tail_fields(days: &[Value], currency: &str, rates: &FxRates) -> Vec<(String, Value)> {
    let day = |row: &Value| day_of(row.get("day"));
    let is_priced = |row: &&Value| row.get("marketPkn").is_some_and(|price| !price.is_null());
    let priced_until = days.iter().filter(is_priced).map(day).max();
    let Some(observed) = days.iter().map(day).filter(|row| !row.is_empty()).max() else {
        return Vec::new();
    };
    if priced_until.as_deref() == Some(observed.as_str()) {
        return Vec::new();
    }
    let listing = days
        .iter()
        .filter(|row| day(row).as_str() > priced_until.as_deref().unwrap_or(""))
        .filter_map(|row| {
            let low_day = day(row);
            let low_pkn = pkn_of_usd(
                number_of(row.get("lowPrice")),
                Some(rates.rate_for(&low_day)?.rate),
            )?;
            Some((low_day, low_pkn, row["lowPrice"].clone()))
        })
        .max_by_key(|(low_day, _, _)| low_day.clone());
    let mut out = vec![("lastObservedDay".to_owned(), json!(observed))];
    if let Some((low_day, low_pkn, low)) = listing {
        out.push((
            "lastListing".to_owned(),
            json!({
                "day": low_day,
                "lowPkn": pg::js_number(low_pkn),
                "low": low,
                "currency": currency,
            }),
        ));
    }
    out
}

/// The `cardtrader` and `pokoin` blocks of the graph answer: the cheapest ask of
/// each day, which is the one number both lines plot.
fn ask_graph(block: &Value, weekly: bool) -> Value {
    with_field(
        block,
        "days",
        Value::Array(graph_day_rows(
            block.get("days").and_then(Value::as_array),
            weekly,
            ask_graph_day,
        )),
    )
}

/// The `tcgplayer` block of the graph answer: the one plotted series, told where
/// its price stopped.
fn tcgplayer_graph(block: &Value, reverse: bool, weekly: bool, rates: &FxRates) -> Value {
    let series = block.get("series").and_then(Value::as_array);
    let currency = js::string_or_empty(block.get("currency"));
    let kept: Vec<Value> = series
        .and_then(|rows| chosen_series(rows, reverse))
        .map(|row| {
            let days = row.get("days").and_then(Value::as_array);
            let mut graphed = with_field(
                row,
                "days",
                Value::Array(graph_day_rows(days, weekly, tcg_graph_day)),
            );
            let tail = days.map(|days| tcg_tail_fields(days, &currency, rates));
            if let (Some(object), Some(tail)) = (graphed.as_object_mut(), tail) {
                for (field, value) in tail {
                    object.insert(field, value);
                }
            }
            graphed
        })
        .into_iter()
        .collect();
    with_field(block, "series", Value::Array(kept))
}

/// The `cardmarket` block of the graph answer: the first product, which is the
/// only one the graph plots.
fn cardmarket_graph(block: &Value, weekly: bool) -> Value {
    let kept: Vec<Value> = block
        .get("products")
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .map(|row| {
            with_field(
                row,
                "days",
                Value::Array(graph_day_rows(
                    row.get("days").and_then(Value::as_array),
                    weekly,
                    cardmarket_graph_day,
                )),
            )
        })
        .into_iter()
        .collect();
    with_field(block, "products", Value::Array(kept))
}

/// The `fields=graph` answer of a full price-history body: the same top-level
/// keys, in the same order, each block keeping its status, everything trimmed to
/// the numbers the desk graph draws and thinned per ISO week over a long span
/// (PH-06).
/// The `cardmarketOffers` block of the graph answer: the one series of the
/// `cmCondition` that was asked, which is the only line the graph plots. The
/// other floors are left out entirely, so a `1m` window of five floors goes out
/// as the one floor the desk shows.
fn cardmarket_offers_graph(block: &Value, condition: &str, weekly: bool) -> Value {
    let wanted = condition.trim();
    let kept: Vec<Value> = block
        .get("series")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|row| {
                    js::string_or_empty(row.get("condition")).eq_ignore_ascii_case(wanted)
                })
                .map(|row| {
                    with_field(
                        row,
                        "days",
                        Value::Array(graph_day_rows(
                            row.get("days").and_then(Value::as_array),
                            weekly,
                            cm_offer_graph_day,
                        )),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    with_field(block, "series", Value::Array(kept))
}

/// The `fields=graph` answer of a full price-history body: the same top-level
/// keys, in the same order, each block keeping its status, everything trimmed to
/// the numbers the desk graph draws and thinned per ISO week over a long span
/// (PH-06). `cm_condition` is the `cmCondition` the request asked, which is the
/// one floor the offers line plots.
/// `rates` is the same EUR→USD table the answer's PKN prices were read with: a
/// TCGplayer series that stopped being priced is only quoted in PKN, so the tail
/// needs them too.
pub fn graph_answer_with_fx(
    body: &Value,
    reverse: bool,
    cm_condition: &str,
    rates: &FxRates,
) -> Value {
    let Some(object) = body.as_object() else {
        return body.clone();
    };
    let weekly = graph_is_weekly(&day_of(object.get("from")), &day_of(object.get("to")));
    let mut out = Map::new();
    for (key, block) in object {
        let block = match key.as_str() {
            "cardtrader" | "pokoin" => ask_graph(block, weekly),
            "tcgplayer" => tcgplayer_graph(block, reverse, weekly, rates),
            "cardmarket" => cardmarket_graph(block, weekly),
            "cardmarketOffers" => cardmarket_offers_graph(block, cm_condition, weekly),
            _ => block.clone(),
        };
        out.insert(key.clone(), block);
        if key == "to" {
            out.insert(
                "bucket".to_owned(),
                json!(if weekly { "week" } else { "day" }),
            );
        }
    }
    Value::Object(out)
}

/// `graph_answer_with_fx` without rates: the shape of a body whose tail cannot be
/// converted, which is every body that has no `fx` to read.
pub fn graph_answer(body: &Value, reverse: bool, cm_condition: &str) -> Value {
    graph_answer_with_fx(body, reverse, cm_condition, &FxRates::default())
}

fn failed_cardmarket(error: &sqlx::Error) -> Value {
    warn_query("cardmarket_price_guide", error);
    cardmarket_source(&[], Some("unavailable"))
}

fn warn_query(table: &str, error: &sqlx::Error) {
    if error
        .as_database_error()
        .is_some_and(|db| db.code().as_deref() == Some("42P01"))
    {
        tracing::warn!("{table} is not migrated; price history source unavailable");
    } else {
        tracing::warn!(table, error = %error, "price history query failed; source unavailable");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rates() -> FxRates {
        FxRates::from_rows(&[
            json!({ "day": "2026-08-10", "rate": 1.1 }),
            json!({ "day": "2026-09-01", "rate": 1.15 }),
            json!({ "day": "2026-11-16", "rate": 1.2 }),
        ])
    }

    #[test]
    fn rate_lookup() {
        let rates = rates();
        let before = rates.rate_for("2026-05-01");
        assert_eq!(
            before,
            Some(ChosenRate {
                rate: 1.1,
                approx: true
            })
        );
        assert_eq!(
            rates.rate_for("2026-08-20"),
            Some(ChosenRate {
                rate: 1.1,
                approx: false
            })
        );
        assert_eq!(
            rates.rate_for("2026-09-01"),
            Some(ChosenRate {
                rate: 1.15,
                approx: false
            })
        );
        assert_eq!(
            rates.rate_for("2026-12-31"),
            Some(ChosenRate {
                rate: 1.2,
                approx: false
            })
        );
        assert_eq!(FxRates::default().rate_for("2026-09-01"), None);
    }

    #[test]
    fn pkn_conversion_and_rounding() {
        assert_eq!(pkn_of_usd(Some(0.85), Some(1.1014)), Some(154.35));
        assert_eq!(pkn_of_eur(Some(0.78)), Some(156.0));
        assert_eq!(pkn_of_eur(Some(0.005)), Some(1.0));
        assert_eq!(pkn_of_usd(None, Some(1.1)), None);
        assert_eq!(pkn_of_usd(Some(0.0), Some(1.1)), None);
        assert_eq!(pkn_of_usd(Some(-2.0), Some(1.1)), None);
        assert_eq!(pkn_of_usd(Some(1.0), None), None);
        assert_eq!(pkn_of_usd(Some(1.0), Some(0.0)), None);
        assert_eq!(pkn_of_eur(Some(-0.1)), None);
    }

    #[test]
    fn fx_block() {
        assert_eq!(
            fx_json(&rates()),
            json!({ "base": "EUR", "quote": "USD", "firstDay": "2026-08-10", "lastDay": "2026-11-16" })
        );
        assert_eq!(fx_json(&FxRates::default()), Value::Null);
        let usable = FxRates::from_rows(&[
            json!({ "day": "2026-08-10T00:00:00.000Z", "rate": "1.1" }),
            json!({ "day": "", "rate": 1.2 }),
            json!({ "day": "2026-08-12", "rate": null }),
        ]);
        assert_eq!(usable.rates.len(), 1);
    }

    /// A TCGplayer row whose only read field is `market_price`.
    fn price_row(price: Value) -> Value {
        json!({ "market_price": price })
    }

    #[test]
    fn market_pkn_stamping() {
        let rates = rates();
        let mut recent = json!({ "day": "2026-09-05", "marketPrice": 0.85 });
        add_market_pkn(
            &mut recent,
            price_row(json!(0.85)).get("market_price"),
            "2026-09-05",
            &rates,
        );
        assert_eq!(recent["marketPkn"], json!(147.83));
        assert!(recent.get("fxApprox").is_none());
        assert_eq!(recent["day"], json!("2026-09-05"));

        let mut before_history = json!({ "day": "2026-01-05", "marketPrice": 0.85 });
        add_market_pkn(
            &mut before_history,
            price_row(json!(0.85)).get("market_price"),
            "2026-01-05",
            &rates,
        );
        assert_eq!(before_history["marketPkn"], json!(154.55));
        assert_eq!(before_history["fxApprox"], json!(true));

        let mut zero = json!({ "day": "2026-09-05", "marketPrice": 0 });
        add_market_pkn(
            &mut zero,
            price_row(json!(0)).get("market_price"),
            "2026-09-05",
            &rates,
        );
        assert_eq!(zero["marketPkn"], Value::Null);
        assert!(zero.get("fxApprox").is_none());

        let mut missing = json!({ "day": "2026-09-05", "marketPrice": null });
        add_market_pkn(
            &mut missing,
            price_row(Value::Null).get("market_price"),
            "2026-09-05",
            &rates,
        );
        assert_eq!(missing["marketPkn"], Value::Null);
        assert!(missing.get("fxApprox").is_none());

        let mut no_rates = json!({ "day": "2026-01-05", "marketPrice": 0.85 });
        add_market_pkn(
            &mut no_rates,
            price_row(json!(0.85)).get("market_price"),
            "2026-01-05",
            &FxRates::default(),
        );
        assert_eq!(no_rates["marketPkn"], Value::Null);
        assert!(no_rates.get("fxApprox").is_none());
    }

    #[test]
    fn cardmarket_block_shapes() {
        assert_eq!(cardmarket_source(&[], None)["status"], "empty");
        assert_eq!(
            cardmarket_source(&[], Some("unavailable"))["status"],
            "unavailable"
        );
        assert_eq!(unsupported_cardmarket()["status"], "unsupported_game");

        let rows = [
            json!({ "day": "2026-11-07", "product_id": 794461, "guide_day": "2026-11-07", "trend": 0.78, "low": 0.05,
                    "avg1": 1.2, "avg7": 0.79, "avg30": 0.84, "trend_foil": null, "low_foil": null, "avg1_foil": null,
                    "avg7_foil": null, "avg30_foil": null }),
            json!({ "day": "2026-11-08", "product_id": "794461", "guide_day": "2026-11-08", "trend": 0.80, "low": 0.05,
                    "avg1": 1.0, "avg7": 0.79, "avg30": 0.84, "trend_foil": 2.5, "low_foil": 2.0, "avg1_foil": 2.5,
                    "avg7_foil": 2.4, "avg30_foil": 2.3 }),
            json!({ "day": "2026-11-07", "product_id": "900000", "guide_day": "2026-10-30", "trend": null, "low": null,
                    "avg1": null, "avg7": null, "avg30": null, "trend_foil": null, "low_foil": null, "avg1_foil": null,
                    "avg7_foil": null, "avg30_foil": null }),
        ];
        let block = cardmarket_source(&rows, None);
        assert_eq!(block["status"], "available");
        assert_eq!(block["source"], "cardmarket_price_guide");
        assert_eq!(block["currency"], "EUR");
        assert_eq!(block["metric"], "trend");
        assert_eq!(block["conditionSpecific"], json!(false));
        assert_eq!(block["languageSpecific"], json!(false));
        let products = block["products"].as_array().expect("products");
        assert_eq!(products.len(), 2);
        assert_eq!(products[0]["productId"], json!("794461"));
        assert_eq!(products[0]["days"].as_array().expect("days").len(), 2);
        assert_eq!(products[1]["productId"], json!("900000"));

        let day = &products[0]["days"][0];
        assert_eq!(day["day"], json!("2026-11-07"));
        assert_eq!(day["guideDay"], json!("2026-11-07"));
        assert_eq!(day["trend"], json!(0.78));
        assert_eq!(day["trendPkn"], json!(156));
        assert_eq!(day["trendFoilPkn"], Value::Null);
        assert_eq!(day["avg1Foil"], Value::Null);
        assert_eq!(day["low"], json!(0.05));

        let foil = &products[0]["days"][1];
        assert_eq!(foil["trendPkn"], json!(160));
        assert_eq!(foil["trendFoilPkn"], json!(500));
        assert_eq!(products[1]["days"][0]["trendPkn"], Value::Null);
    }

    /// PH-02: the FX read reaches Postgres only when the probe found
    /// `fx_rates_daily`; otherwise it answers "no rates" and `fx` stays `null`.
    #[tokio::test]
    async fn fx_leg_queries_only_a_present_table() {
        for (presence, expected_calls) in [
            (Presence::Present, 1usize),
            (Presence::Missing, 0),
            (Presence::ProbeFailed, 0),
        ] {
            let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = std::sync::Arc::clone(&calls);
            let got = fx_rates_leg(presence, move || {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async { rates() }
            })
            .await;
            if presence == Presence::Present {
                assert_eq!(
                    got.rate_for("2026-09-15"),
                    Some(ChosenRate {
                        rate: 1.15,
                        approx: false
                    }),
                    "a present table is read"
                );
            } else {
                // `FxRates` has no equality of its own; what the leg must give
                // back is a reader that finds no rate and an `fx` block of null.
                assert_eq!(got.rate_for("2026-09-15"), None, "{presence:?}");
                assert_eq!(fx_json(&got), Value::Null, "{presence:?}");
            }
            assert_eq!(
                calls.load(std::sync::atomic::Ordering::SeqCst),
                expected_calls,
                "{presence:?}"
            );
        }
    }

    /// PH-02: a game database without the guide tables answers the Cardmarket
    /// block as `empty` and sends no query; a probe that itself failed stays
    /// `unavailable` as today's failed query does.
    #[tokio::test]
    async fn cardmarket_leg_queries_only_a_present_table() {
        for (presence, expected_status, expected_calls) in [
            (Presence::Present, "available", 1usize),
            (Presence::Missing, "empty", 0),
            (Presence::ProbeFailed, "unavailable", 0),
        ] {
            let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = std::sync::Arc::clone(&calls);
            let block = cardmarket_leg(presence, move || {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async {
                    cardmarket_source(
                        &[json!({ "product_id": "794461", "day": "2026-11-07", "trend": 0.78 })],
                        None,
                    )
                }
            })
            .await;
            assert_eq!(block["status"], expected_status, "{presence:?}");
            assert_eq!(block["source"], "cardmarket_price_guide", "{presence:?}");
            assert_eq!(
                calls.load(std::sync::atomic::Ordering::SeqCst),
                expected_calls,
                "{presence:?}"
            );
        }
    }

    /// A game with no Cardmarket guide keeps the `unsupported_game` stub, which
    /// is answered before the probe: even a pool that cannot be reached is never
    /// touched.
    #[tokio::test]
    async fn other_games_stay_unsupported_before_any_probe() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_millis(50))
            .connect_lazy("postgres://pokoin_test@127.0.0.1:1/pokoin_magic")
            .expect("lazy pool");
        let block =
            cardmarket_history(&pool, "magic", Some("239324"), "2026-10-01", "2026-11-01").await;
        assert_eq!(block["status"], "unsupported_game");
        assert!(block["products"].as_array().expect("products").is_empty());
    }

    /// A full price-history body of the shape the handler answers, with every
    /// field the graph answer is asked to drop or keep.
    fn graph_body() -> Value {
        json!({
            "game": "pokemon", "cardId": "612376", "ctId": "119662",
            "from": "2026-08-18", "to": "2026-11-16",
            "printing": { "name": "Charizard", "setName": "Base Set", "number": "4/102" },
            "cardtrader": {
                "source": "cardtrader_listed", "currency": "PKN", "metric": "lowestAsk", "status": "available",
                "days": [
                    { "day": "2026-11-15", "dumpDay": "2026-11-16", "lowestAskPkn": 278,
                      "listingCount": 3, "listedQuantity": 5, "sellerCount": 2, "sourceTimestamp": "2026-11-16T06:00:00.000Z" },
                    { "day": "2026-11-16", "dumpDay": "2026-11-16", "lowestAskPkn": Value::Null,
                      "listingCount": 0, "listedQuantity": 0, "sellerCount": 0, "sourceTimestamp": Value::Null },
                ],
            },
            "tcgplayer": {
                "source": "tcgplayer_pricehistory", "currency": "USD", "metric": "market", "status": "available",
                "series": [
                    { "productId": "589965", "categoryId": 1, "groupId": "g-1", "subtype": "Holofoil",
                      "days": [
                          { "day": "2026-11-01", "marketPrice": "0.8000", "marketPkn": 145 },
                          { "day": "2026-11-07", "marketPrice": Value::Null, "marketPkn": Value::Null },
                          { "day": "2026-11-14", "marketPrice": "0.8500", "marketPkn": 154.35, "fxApprox": true },
                      ] },
                    { "productId": "589965", "categoryId": 1, "groupId": "g-1", "subtype": "Reverse Holofoil",
                      "days": [
                          { "day": "2026-11-13", "marketPrice": "1.0000", "marketPkn": 180 },
                          { "day": "2026-11-14", "marketPrice": "1.0000", "marketPkn": 182 },
                      ] },
                ],
            },
            "cardmarket": {
                "source": "cardmarket_price_guide", "currency": "EUR", "metric": "trend", "status": "available",
                "conditionSpecific": false, "languageSpecific": false,
                "products": [
                    { "productId": "794461", "days": [
                        { "day": "2026-11-09", "guideDay": "2026-11-09", "trend": 0.71, "low": 0.05,
                          "trendPkn": 142, "trendFoilPkn": Value::Null },
                        { "day": "2026-11-16", "guideDay": "2026-11-16", "trend": 0.725, "low": 0.05,
                          "trendPkn": 145, "trendFoilPkn": 168 },
                    ] },
                    { "productId": "794462", "days": [{ "day": "2026-11-16", "trendPkn": 999, "trendFoilPkn": Value::Null }] },
                ],
            },
            "pokoin": {
                "source": "pokoin_listings", "currency": "PKN", "metric": "lowestAsk", "status": "available",
                "days": [{ "day": "2026-11-15", "lowestAskPkn": 260, "listingCount": 2 }],
            },
            "cardmarketOffers": {
                "source": "cardmarket_offers", "currency": "PKN", "metric": "lowestOffer", "status": "available",
                "idProduct": 794461, "language": "EN", "finish": "N", "firstEdition": "N", "conditionIsFloor": true,
                "series": [
                    { "condition": "NM", "days": [
                        { "day": "2026-11-09", "lowestPkn": 1840, "sellerType": "private", "asked": true },
                        { "day": "2026-11-16", "lowestPkn": 1900, "sellerType": "pro", "asked": false },
                    ] },
                    { "condition": "SP", "days": [
                        { "day": "2026-11-16", "lowestPkn": 1500, "sellerType": "private", "asked": true },
                    ] },
                ],
            },
            "fx": { "base": "EUR", "quote": "USD", "firstDay": "2026-08-10", "lastDay": "2026-11-16" },
        })
    }

    /// One row of `POKOIN_EVENTS_SQL` as Postgres answers it: the listing, the
    /// event id — `row_to_node_json` sends a `bigint` as a string — the UTC day
    /// and instant of its change, and how the listing stands from then on. That id
    /// is always the same here, so it says nothing about which of two rows of one
    /// instant came last; a row whose order matters comes from `event_row_id`.
    fn event_row(listing: &str, at: &str, status: &str, quantity: Value, price: Value) -> Value {
        json!({
            "listing_id": listing, "id": "1", "day": &at[..10], "at_utc": at,
            "status_after": status, "quantity_after": quantity, "price_pkn": price,
        })
    }

    /// `event_row` with the event id that orders two changes written at one
    /// instant: the higher id is the one that happened last.
    fn event_row_id(
        id: &str,
        listing: &str,
        at: &str,
        status: &str,
        quantity: Value,
        price: Value,
    ) -> Value {
        let mut row = event_row(listing, at, status, quantity, price);
        row["id"] = json!(id);
        row
    }

    /// The days of `rows` folded over the range, the way the block builder does.
    fn pokoin_days(rows: &[Value], from: &str, to: &str) -> Vec<Value> {
        pokoin_price_days(&listing_events(rows), from, to)
    }

    #[test]
    fn pokoin_days_fold_the_listing_states() {
        // Rows arrive in the order the changes happened; these do not, so the
        // fold cannot depend on that order.
        let rows = [
            // `a` was listed before the range and is still live when it starts.
            event_row(
                "a",
                "2026-09-28T10:00:00.000Z",
                "active",
                json!(1),
                json!(300),
            ),
            event_row(
                "b",
                "2026-10-02T08:00:00.000Z",
                "active",
                json!(2),
                json!(250),
            ),
            event_row(
                "a",
                "2026-10-03T09:00:00.000Z",
                "active",
                json!(1),
                json!(200),
            ),
            // The cheapest listing sells out and is back two days later.
            event_row(
                "a",
                "2026-10-04T12:00:00.000Z",
                "sold_out",
                json!(0),
                json!(200),
            ),
            event_row(
                "a",
                "2026-10-05T12:00:00.000Z",
                "active",
                json!(1),
                json!(220),
            ),
            // A zero price and a paused listing are not an ask, whatever the day.
            event_row(
                "b",
                "2026-10-06T06:00:00.000Z",
                "active",
                json!(1),
                json!(0),
            ),
            event_row(
                "c",
                "2026-10-06T07:00:00.000Z",
                "paused",
                json!(1),
                json!(90),
            ),
        ];
        assert_eq!(
            pokoin_days(&rows, "2026-10-01", "2026-10-06"),
            vec![
                json!({ "day": "2026-10-01", "lowestAskPkn": 300, "listingCount": 1 }),
                json!({ "day": "2026-10-02", "lowestAskPkn": 250, "listingCount": 2 }),
                json!({ "day": "2026-10-03", "lowestAskPkn": 200, "listingCount": 2 }),
                json!({ "day": "2026-10-04", "lowestAskPkn": 250, "listingCount": 1 }),
                json!({ "day": "2026-10-05", "lowestAskPkn": 220, "listingCount": 2 }),
                json!({ "day": "2026-10-06", "lowestAskPkn": 220, "listingCount": 1 }),
            ],
            "the live listings of the end of each day, cheapest first"
        );
    }

    #[test]
    fn pokoin_days_invent_nothing_before_the_first_event() {
        let rows = [
            event_row(
                "a",
                "2026-10-03T09:00:00.000Z",
                "active",
                json!(1),
                json!(200),
            ),
            // Gone for two days: a day without a live listing is not a point.
            event_row(
                "a",
                "2026-10-04T09:00:00.000Z",
                "cancelled",
                json!(0),
                json!(200),
            ),
            event_row(
                "b",
                "2026-10-06T09:00:00.000Z",
                "active",
                json!(1),
                json!(180),
            ),
        ];
        assert_eq!(
            pokoin_days(&rows, "2026-10-01", "2026-10-07"),
            vec![
                json!({ "day": "2026-10-03", "lowestAskPkn": 200, "listingCount": 1 }),
                json!({ "day": "2026-10-06", "lowestAskPkn": 180, "listingCount": 1 }),
                json!({ "day": "2026-10-07", "lowestAskPkn": 180, "listingCount": 1 }),
            ],
            "the line starts at the first event and carries a listing to the end of the range"
        );
        // Nothing at all before the card was ever listed.
        assert!(pokoin_days(&rows, "2026-01-01", "2026-01-31").is_empty());
        // A sold listing that is never relisted ends the line; a day with no ask
        // is a gap, not a zero.
        let sold = [
            event_row(
                "a",
                "2026-10-01T09:00:00.000Z",
                "active",
                json!(1),
                json!(200),
            ),
            event_row(
                "a",
                "2026-10-02T09:00:00.000Z",
                "sold",
                json!(0),
                json!(200),
            ),
        ];
        assert_eq!(
            pokoin_days(&sold, "2026-10-01", "2026-10-03"),
            vec![json!({ "day": "2026-10-01", "lowestAskPkn": 200, "listingCount": 1 })]
        );
        // A missing price, a missing quantity and an unknown status are no ask.
        for (quantity, price, status) in [
            (Value::Null, json!(200), "active"),
            (json!(1), Value::Null, "active"),
            (json!(1), json!(-5), "active"),
            (json!(1), json!(200), ""),
        ] {
            let rows = [event_row(
                "a",
                "2026-10-02T09:00:00.000Z",
                status,
                quantity.clone(),
                price.clone(),
            )];
            assert!(
                pokoin_days(&rows, "2026-10-01", "2026-10-03").is_empty(),
                "{status:?} qty {quantity} price {price} is not a live listing"
            );
        }
        // Rows without a day or an instant are not changes; a half range and a
        // reversed one answer nothing.
        assert!(pokoin_days(
            &[json!({ "status_after": "active", "price_pkn": 200 })],
            "2026-10-01",
            "2026-10-03"
        )
        .is_empty());
        assert!(pokoin_days(&[], "2026-10-01", "2026-10-03").is_empty());
        assert!(pokoin_days(&[], "not-a-day", "2026-10-03").is_empty());
        assert!(pokoin_days(&[], "2026-10-05", "2026-10-01").is_empty());
    }

    #[test]
    fn pokoin_block_reports_its_own_days() {
        let rows = [event_row(
            "a",
            "2026-10-02T09:00:00.000Z",
            "active",
            json!(1),
            json!(183),
        )];
        let block = pokoin_source(&rows, None, "2026-10-01", "2026-10-03");
        assert_eq!(block["source"], "pokoin_listings");
        assert_eq!(block["currency"], "PKN");
        assert_eq!(block["metric"], "lowestAsk");
        assert_eq!(block["status"], "available");
        assert_eq!(
            block["days"],
            json!([
                { "day": "2026-10-02", "lowestAskPkn": 183, "listingCount": 1 },
                { "day": "2026-10-03", "lowestAskPkn": 183, "listingCount": 1 },
            ])
        );
        // No events, and a query that failed, are different answers.
        assert_eq!(
            pokoin_source(&[], None, "2026-10-01", "2026-10-03")["status"],
            "empty"
        );
        let failed = pokoin_source(&[], Some("unavailable"), "2026-10-01", "2026-10-03");
        assert_eq!(failed["status"], "unavailable");
        assert!(failed["days"].as_array().expect("days").is_empty());
        // A day the events say nothing about, and a card with one event only.
        assert_eq!(
            pokoin_source(
                &[event_row(
                    "a",
                    "2026-10-02T09:00:00.000Z",
                    "active",
                    json!(1),
                    json!(300.5)
                )],
                None,
                "2026-10-02",
                "2026-10-02"
            )["days"][0]["lowestAskPkn"],
            json!(300.5),
            "a fractional price stays as it is"
        );
    }

    /// The rows of `event_row` reach the fold in the order they happened, and a
    /// second listing id is its own state.
    #[test]
    fn listing_events_are_ordered_and_separated() {
        let rows = [
            event_row(
                "b",
                "2026-10-02T09:00:00.000Z",
                "active",
                json!(1),
                json!(250),
            ),
            event_row(
                "a",
                "2026-10-02T09:00:00.000Z",
                "active",
                json!(1),
                json!(200),
            ),
            event_row(
                "a",
                "2026-10-01T09:00:00.000Z",
                "active",
                json!(1),
                json!(300),
            ),
        ];
        let events = listing_events(&rows);
        assert_eq!(
            events
                .iter()
                .map(|event| (event.listing.as_str(), event.day.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("a", "2026-10-01"),
                ("a", "2026-10-02"),
                ("b", "2026-10-02")
            ],
            "same instant: the listing id breaks the tie, so the fold is deterministic"
        );
        assert!(events.iter().all(|event| event.is_live()));
        assert!(!ListingEvent::from_row(&json!({ "id": "7", "day": "2026-10-01", "at_utc": "2026-10-01T00:00:00.000Z", "status_after": "removed", "quantity_after": 0, "price_pkn": null }))
            .expect("row")
            .is_live());
    }

    /// Two writes of one listing inside one transaction share the transaction
    /// timestamp the audit trigger writes, so the event id is the only thing that
    /// says which of them the listing stands in from that instant on.
    #[test]
    fn pokoin_days_order_two_changes_of_one_instant_by_the_event_id() {
        let listed = || {
            event_row_id(
                "10",
                "a",
                "2026-10-04T12:00:00.000Z",
                "active",
                json!(1),
                json!(200),
            )
        };
        let sold = || {
            event_row_id(
                "11",
                "a",
                "2026-10-04T12:00:00.000Z",
                "sold_out",
                json!(0),
                json!(200),
            )
        };
        // Both arrival orders of the pair, because the fold must not care which
        // row the read happened to hand over first.
        for rows in [vec![listed(), sold()], vec![sold(), listed()]] {
            assert!(
                pokoin_days(&rows, "2026-10-04", "2026-10-05").is_empty(),
                "the listing is off the market from its higher id on, whatever the row order"
            );
        }
        // The same with a price tie: 300 then 180 in one instant is an ask of 180.
        let dear = || {
            event_row_id(
                "10",
                "a",
                "2026-10-04T12:00:00.000Z",
                "active",
                json!(1),
                json!(300),
            )
        };
        let cheap = || {
            event_row_id(
                "11",
                "a",
                "2026-10-04T12:00:00.000Z",
                "active",
                json!(1),
                json!(180),
            )
        };
        let priced = vec![
            json!({ "day": "2026-10-04", "lowestAskPkn": 180, "listingCount": 1 }),
            json!({ "day": "2026-10-05", "lowestAskPkn": 180, "listingCount": 1 }),
        ];
        for rows in [vec![dear(), cheap()], vec![cheap(), dear()]] {
            assert_eq!(
                pokoin_days(&rows, "2026-10-04", "2026-10-05"),
                priced,
                "the higher id is the price the listing has from that instant"
            );
        }
        // And the other way round: a listing sold and relisted in one transaction
        // stands live, at the higher id's price.
        let rows = [
            event_row_id(
                "10",
                "a",
                "2026-10-04T12:00:00.000Z",
                "sold_out",
                json!(0),
                json!(200),
            ),
            event_row_id(
                "11",
                "a",
                "2026-10-04T12:00:00.000Z",
                "active",
                json!(1),
                json!(210),
            ),
        ];
        assert_eq!(
            pokoin_days(&rows, "2026-10-04", "2026-10-04"),
            vec![json!({ "day": "2026-10-04", "lowestAskPkn": 210, "listingCount": 1 })],
            "a relist at the higher id is an ask again"
        );
    }

    /// The id is read from the string Postgres sends, it orders a tie as a number
    /// and a row without a readable one is not a change.
    #[test]
    fn listing_events_reads_the_event_id_and_drops_a_row_without_one() {
        let events = listing_events(&[
            event_row_id(
                "11",
                "a",
                "2026-10-02T09:00:00.000Z",
                "sold_out",
                json!(0),
                json!(200),
            ),
            event_row_id(
                "9",
                "a",
                "2026-10-02T09:00:00.000Z",
                "active",
                json!(1),
                json!(200),
            ),
        ]);
        assert_eq!(
            events
                .iter()
                .map(|event| event.id)
                .collect::<Vec<_>>()
                .as_slice(),
            [9, 11],
            "the ids of one instant order as numbers, not as their text"
        );

        // A cell that is not a whole number id cannot order anything, so the row
        // is left out the way a row without a day or an instant is.
        for id in [
            Value::Null,
            json!(""),
            json!("abc"),
            json!("1e3"),
            json!(1.5),
            json!("12 listing"),
        ] {
            let mut row = event_row(
                "a",
                "2026-10-02T09:00:00.000Z",
                "active",
                json!(1),
                json!(200),
            );
            row["id"] = id.clone();
            assert!(
                ListingEvent::from_row(&row).is_none(),
                "event id {id} is not a change"
            );
        }
        let mut no_id = event_row(
            "a",
            "2026-10-02T09:00:00.000Z",
            "active",
            json!(1),
            json!(200),
        );
        no_id
            .as_object_mut()
            .expect("object")
            .remove("id")
            .expect("id");
        assert!(
            ListingEvent::from_row(&no_id).is_none(),
            "a row that did not read an id is not a change"
        );
        // A row whose id is a plain JSON number is a change too.
        let numeric = ListingEvent::from_row(&json!({
            "listing_id": "a", "id": 12, "day": "2026-10-02",
            "at_utc": "2026-10-02T09:00:00.000Z", "status_after": "active",
            "quantity_after": 1, "price_pkn": 200,
        }))
        .expect("row");
        assert_eq!(numeric.id, 12);
        assert!(numeric.is_live());
    }

    /// One statement reads both halves of the card's events, and a same-instant
    /// pair is decided by the event id in the read and in the order it arrives.
    #[test]
    fn pokoin_sql_orders_a_tie_by_the_event_id() {
        assert_eq!(
            POKOIN_EVENTS_SQL.matches("e.id").count(),
            3,
            "both halves select the id and the state before the window orders by it: {POKOIN_EVENTS_SQL}"
        );
        assert!(POKOIN_EVENTS_SQL.contains("order by e.listing_id, e.occurred_at desc, e.id desc"));
        assert!(
            POKOIN_EVENTS_SQL.contains("order by occurred_at, id"),
            "the rows arrive by the timestamp itself, not by its millisecond text: {POKOIN_EVENTS_SQL}"
        );
        assert!(
            !POKOIN_EVENTS_SQL.contains("order by at_utc"),
            "the rendered instant is not the tie-breaker"
        );
        // The bounds the index of the events table offers, unchanged by the fix.
        assert!(POKOIN_EVENTS_SQL.contains("e.card_id = $1::text"));
        assert!(POKOIN_EVENTS_SQL.contains("distinct on (e.listing_id)"));
    }

    /// The `pokoin` leg reaches Postgres only when the probe found the events
    /// table; otherwise it answers its own no-data or unavailable block (PH-02).
    #[tokio::test]
    async fn pokoin_leg_queries_only_a_present_table() {
        for (presence, expected_status, expected_calls) in [
            (Presence::Present, "available", 1usize),
            (Presence::Missing, "empty", 0),
            (Presence::ProbeFailed, "unavailable", 0),
        ] {
            let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = std::sync::Arc::clone(&calls);
            let block = pokoin_leg(presence, "2026-10-01", "2026-10-03", move || {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async move {
                    pokoin_source(
                        &[event_row(
                            "a",
                            "2026-10-02T08:00:00.000Z",
                            "active",
                            json!(1),
                            json!(300),
                        )],
                        None,
                        "2026-10-01",
                        "2026-10-03",
                    )
                }
            })
            .await;
            assert_eq!(block["status"], expected_status, "{presence:?}");
            assert_eq!(block["source"], "pokoin_listings", "{presence:?}");
            assert_eq!(
                block["days"].as_array().expect("days").len(),
                usize::from(presence == Presence::Present) * 2,
                "{presence:?}: the 2 Oct listing is live on both days of the range"
            );
            assert_eq!(
                calls.load(std::sync::atomic::Ordering::SeqCst),
                expected_calls,
                "{presence:?}"
            );
        }
    }

    /// A card whose pool cannot be reached at all is `unavailable`, and the probe
    /// answers that without a query for the events table.
    #[tokio::test]
    async fn pokoin_history_of_an_unreachable_pool_is_unavailable() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_millis(50))
            .connect_lazy("postgres://pokoin_test@127.0.0.1:1/pokoin_magic")
            .expect("lazy pool");
        let block = pokoin_history(&pool, "239324", "2026-10-01", "2026-11-01").await;
        assert_eq!(block["status"], "unavailable");
        assert_eq!(block["source"], "pokoin_listings");
        assert!(block["days"].as_array().expect("days").is_empty());
    }

    #[test]
    fn pokoin_sql_binds_every_value() {
        // No value reaches Postgres inside the statement text: the card id, both
        // time bounds and every date of the row are binds or column names.
        assert!(!POKOIN_EVENTS_SQL.contains('{'), "{POKOIN_EVENTS_SQL}");
        assert!(!POKOIN_EVENTS_SQL.contains('}'), "{POKOIN_EVENTS_SQL}");
        for value in ["239324", "4152", "2026-10-01", "2026-11-16", "active"] {
            assert!(
                !POKOIN_EVENTS_SQL.contains(value),
                "{value} is interpolated into {POKOIN_EVENTS_SQL}"
            );
        }
        for index in 1..=3 {
            let bind = format!("${index}");
            assert!(
                POKOIN_EVENTS_SQL.contains(&bind),
                "{POKOIN_EVENTS_SQL} does not bind {bind}"
            );
        }
        assert_eq!(
            POKOIN_EVENTS_SQL.matches('$').count(),
            5,
            "the card id and the start bind each half of the read, the end once"
        );
        for placeholder in POKOIN_EVENTS_SQL
            .match_indices('$')
            .map(|(at, _)| &POKOIN_EVENTS_SQL[at + 1..at + 2])
        {
            assert!(
                ("123").contains(placeholder),
                "unknown placeholder ${placeholder} in {POKOIN_EVENTS_SQL}"
            );
        }
        // Bounded by the card and ordered so that one read folds every day: the
        // shape of `marketplace_user_listing_events_card_day_idx`.
        assert!(POKOIN_EVENTS_SQL.contains("e.card_id = $1::text"));
        assert!(POKOIN_EVENTS_SQL.contains("e.occurred_at < $2::timestamptz"));
        assert!(POKOIN_EVENTS_SQL.contains("e.occurred_at >= $2::timestamptz"));
        assert!(POKOIN_EVENTS_SQL.contains("e.occurred_at < $3::timestamptz"));
        assert!(POKOIN_EVENTS_SQL.contains("distinct on (e.listing_id)"));
        assert_eq!(
            POKOIN_EVENTS_SQL
                .matches("marketplace_user_listing_events")
                .count(),
            2,
            "one statement, both halves of the card's events"
        );
        assert!(POKOIN_EVENTS_SQL.matches("select").count() <= 6);
    }

    #[test]
    fn pokoin_sql_answers_the_graph_without_an_extra_query() {
        // The day bounds are instants, so the session zone cannot move a day and
        // the last day of the range is included by its exclusive end.
        assert_eq!(day_start_utc("2026-10-01"), "2026-10-01T00:00:00+00:00");
        assert_eq!(day_after_utc("2026-10-01"), "2026-10-02T00:00:00+00:00");
        assert_eq!(day_after_utc("2026-12-31"), "2027-01-01T00:00:00+00:00");
        assert_eq!(day_after_utc("not-a-day"), "not-a-dayT00:00:00+00:00");
    }

    #[test]
    fn graph_answer_trims_every_block_to_the_plotted_numbers() {
        let body = graph_body();
        let graph = graph_answer(&body, false, CM_OFFER_DEFAULT_CONDITION);
        let keys = |value: &Value| {
            value
                .as_object()
                .expect("object")
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        };
        let mut expected = keys(&body);
        expected.insert(
            expected.iter().position(|key| key == "to").unwrap() + 1,
            "bucket".to_owned(),
        );
        assert_eq!(
            keys(&graph),
            expected,
            "same top-level keys in the same order"
        );
        assert_eq!(graph["bucket"], json!("day"));
        assert_eq!(graph["game"], body["game"]);
        assert_eq!(graph["printing"], body["printing"]);
        assert_eq!(graph["fx"], body["fx"]);

        // Statuses and every block header survive; only the days are trimmed.
        for block in [
            "cardtrader",
            "tcgplayer",
            "cardmarket",
            "cardmarketOffers",
            "pokoin",
        ] {
            assert_eq!(graph[block]["status"], body[block]["status"], "{block}");
            assert_eq!(graph[block]["source"], body[block]["source"], "{block}");
        }
        assert_eq!(
            graph["cardtrader"]["days"],
            json!([{ "day": "2026-11-15", "lowestAskPkn": 278 }]),
            "the ask day keeps day and price only, and the day without a price goes"
        );
        assert_eq!(
            graph["pokoin"]["days"],
            json!([{ "day": "2026-11-15", "lowestAskPkn": 260 }]),
            "listingCount is not plotted"
        );
        let series = graph["tcgplayer"]["series"].as_array().expect("series");
        assert_eq!(series.len(), 1, "exactly the plotted series");
        assert_eq!(series[0]["subtype"], json!("Holofoil"));
        assert_eq!(series[0]["productId"], json!("589965"));
        assert_eq!(
            series[0]["days"],
            json!([
                { "day": "2026-11-01", "marketPkn": 145 },
                { "day": "2026-11-14", "marketPkn": 154.35, "fxApprox": true },
            ]),
            "days without marketPkn are left out"
        );
        let products = graph["cardmarket"]["products"]
            .as_array()
            .expect("products");
        assert_eq!(products.len(), 1, "only the first product");
        assert_eq!(products[0]["productId"], json!("794461"));
        assert_eq!(
            products[0]["days"],
            json!([
                { "day": "2026-11-09", "trendPkn": 142, "trendFoilPkn": Value::Null },
                { "day": "2026-11-16", "trendPkn": 145, "trendFoilPkn": 168 },
            ])
        );

        // `reverse=1` asks for the reverse-holo series instead.
        let reverse = graph_answer(&body, true, CM_OFFER_DEFAULT_CONDITION);
        assert_eq!(
            reverse["tcgplayer"]["series"][0]["subtype"],
            json!("Reverse Holofoil")
        );
        assert_eq!(
            reverse["tcgplayer"]["series"][0]["days"],
            json!([
                { "day": "2026-11-13", "marketPkn": 180 },
                { "day": "2026-11-14", "marketPkn": 182 },
            ]),
            "the reverse series, two priced days"
        );

        // A block that has nothing to plot stays as empty as it was.
        let empty = graph_answer(
            &json!({ "from": "2026-10-01", "to": "2026-11-01", "pokoin": pokoin_source(&[], None, "2026-10-01", "2026-11-01") }),
            false,
            CM_OFFER_DEFAULT_CONDITION,
        );
        assert_eq!(empty["pokoin"]["status"], "empty");
        assert!(empty["pokoin"]["days"].as_array().expect("days").is_empty());
    }

    #[test]
    fn long_spans_answer_one_point_per_iso_week() {
        assert!(!graph_is_weekly("2025-01-01", "2026-02-05"), "400 days");
        assert!(graph_is_weekly("2025-01-01", "2026-02-06"), "401 days");
        assert!(!graph_is_weekly("2026-11-16", "2026-11-16"), "one day");
        assert!(!graph_is_weekly("nonsense", "2026-11-16"));

        // W45 is 2–8 Nov 2026, W46 9–15 and W47 starts 16; W44 has 1 Nov only.
        let days: Vec<Value> = [
            ("2026-11-01", 10),
            ("2026-11-02", 11),
            ("2026-11-07", 12),
            ("2026-11-09", 13),
            ("2026-11-15", 14),
            ("2026-11-16", 15),
        ]
        .into_iter()
        .map(|(day, price)| json!({ "day": day, "lowestAskPkn": price }))
        .collect();
        assert_eq!(
            thin_weekly(&days),
            vec![
                json!({ "day": "2026-11-01", "lowestAskPkn": 10 }),
                json!({ "day": "2026-11-07", "lowestAskPkn": 12 }),
                json!({ "day": "2026-11-15", "lowestAskPkn": 14 }),
                json!({ "day": "2026-11-16", "lowestAskPkn": 15 }),
            ],
            "the first week, the last day of each week and the last day of all"
        );
        assert!(thin_weekly(&[]).is_empty(), "an empty source stays empty");

        // A whole week without a value simply does not appear; the day before it
        // and the day after it are that week's neighbours' points.
        let with_a_hole: Vec<Value> = ["2026-10-25", "2026-11-15"]
            .into_iter()
            .map(|day| json!({ "day": day, "lowestAskPkn": 20 }))
            .collect();
        assert_eq!(
            thin_weekly(&with_a_hole),
            with_a_hole,
            "W43 and W46 are two weeks apart: nothing to fold"
        );

        // The thinning runs on the trimmed days, so a week whose last day has no
        // price is represented by the last day of it that does.
        let mut body = graph_body();
        body["from"] = json!("2025-01-01");
        body["cardtrader"]["days"] = json!([
            { "day": "2026-11-02", "lowestAskPkn": 278 },
            { "day": "2026-11-07", "lowestAskPkn": Value::Null },
            { "day": "2026-11-08", "lowestAskPkn": 260 },
            { "day": "2026-11-16", "lowestAskPkn": 255 },
        ]);
        let weekly = graph_answer(&body, false, CM_OFFER_DEFAULT_CONDITION);
        assert_eq!(weekly["bucket"], json!("week"));
        assert_eq!(
            weekly["cardtrader"]["days"],
            json!([
                { "day": "2026-11-08", "lowestAskPkn": 260 },
                { "day": "2026-11-16", "lowestAskPkn": 255 },
            ]),
            "2, 7 and 8 Nov are one week (W45: 2–8 Nov): its last priced day, the 8th, stands, and the price-less 7th never enters"
        );
        assert_eq!(
            weekly["pokoin"]["days"],
            json!([{ "day": "2026-11-15", "lowestAskPkn": 260 }]),
            "the ask day of W46 (9–15 Nov) is that week's only point"
        );
    }

    #[test]
    fn tcgplayer_series_choice() {
        let series = || match graph_body()["tcgplayer"]["series"].as_array() {
            Some(rows) => rows.clone(),
            None => Vec::new(),
        };
        let rows = series();
        // Non-reverse with three days beats the two-day reverse group; reverse is
        // the reverse series even though it has fewer days.
        assert_eq!(
            chosen_series(&rows, false).expect("one")["subtype"],
            json!("Holofoil")
        );
        assert_eq!(
            chosen_series(&rows, true).expect("one")["subtype"],
            json!("Reverse Holofoil")
        );
        // Among several of the preferred group the one with the most days, and the
        // first of those that tie.
        let many = vec![
            json!({ "subtype": "Normal", "days": [{ "day": "2026-11-16" }] }),
            json!({ "subtype": "Holofoil", "days": [{ "day": "2026-11-15" }, { "day": "2026-11-16" }] }),
            json!({ "subtype": "1st Edition Holofoil", "days": [{ "day": "2026-11-15" }, { "day": "2026-11-16" }] }),
        ];
        assert_eq!(
            chosen_series(&many, false).expect("one")["subtype"],
            json!("Holofoil")
        );
        assert_eq!(
            chosen_series(&many, true).expect("one")["subtype"],
            json!("Holofoil"),
            "no reverse series: the whole group"
        );
        // The subtype test is case-insensitive, as the client's is.
        let lowercase = vec![json!({ "subtype": "reverse holofoil", "days": [] })];
        assert_eq!(
            chosen_series(&lowercase, true).expect("one")["subtype"],
            json!("reverse holofoil")
        );
        assert_eq!(chosen_series(&[], false), None);
        assert_eq!(
            chosen_series(&[json!({ "subtype": "Normal" })], false).expect("one")["subtype"],
            json!("Normal"),
            "a series without days is still the only one to plot"
        );
    }

    /// TCGplayer keeps publishing a series after its market price stops, so a
    /// count of its rows is not a count of the days the graph can draw.
    #[test]
    fn tcgplayer_series_choice_counts_priced_days() {
        let priced = |day: &str, pkn: f64| json!({ "day": day, "marketPkn": pkn });
        let unpriced = |day: &str| json!({ "day": day, "marketPkn": Value::Null });
        let rows = vec![
            json!({
                "subtype": "Holofoil",
                "days": [
                    priced("2026-10-20", 154.35),
                    unpriced("2026-11-10"),
                    unpriced("2026-11-11"),
                    unpriced("2026-11-12"),
                ],
            }),
            json!({
                "subtype": "Normal",
                "days": [priced("2026-11-05", 36.0), priced("2026-11-06", 37.0)],
            }),
        ];
        assert_eq!(
            chosen_series(&rows, false).expect("one")["subtype"],
            json!("Normal"),
            "four days of which one is priced is less series than two priced days"
        );
        // A day that carries no `marketPkn` at all is as unpriced as a null one.
        let holes = vec![
            json!({ "subtype": "Holofoil", "days": [unpriced("2026-11-01"), { "day": "2026-11-02" }, { "day": "2026-11-03" }] }),
            json!({ "subtype": "Normal", "days": [unpriced("2026-11-04"), priced("2026-11-05", 36.0)] }),
        ];
        assert_eq!(
            chosen_series(&holes, false).expect("one")["subtype"],
            json!("Normal"),
            "the group's one priced day beats three days without any price field"
        );
    }

    /// TCGplayer keeps a series alive after its market price stops: the graph
    /// answer says where the observation really ended, and quotes the newest
    /// listing that had a price to stand under it.
    #[test]
    fn graph_answer_reports_where_a_series_stopped_being_priced() {
        let body = {
            let mut body = graph_body();
            body["tcgplayer"]["series"] = json!([
                {
                    "productId": "589965",
                    "categoryId": "1",
                    "groupId": "2",
                    "subtype": "Unlimited Holofoil",
                    "days": [
                        { "day": "2026-11-14", "marketPrice": "0.9200", "marketPkn": 154.35,
                          "lowPrice": "0.7900", "fxApprox": true },
                        { "day": "2026-11-15", "marketPrice": null, "lowPrice": "0.8100" },
                        { "day": "2026-11-16", "marketPrice": null, "lowPrice": "0.8000" },
                    ],
                },
            ]);
            body
        };
        let answer = graph_answer_with_fx(&body, false, "NM", &rates());
        let chosen = &answer["tcgplayer"]["series"][0];
        // The days the graph draws are unchanged: only priced days, as before.
        assert_eq!(
            chosen["days"],
            json!([{ "day": "2026-11-14", "marketPkn": 154.35, "fxApprox": true }]),
        );
        assert_eq!(
            chosen["lastObservedDay"],
            json!("2026-11-16"),
            "the last day TCGplayer answered, priced or not"
        );
        let fields = chosen.as_object().expect("object");
        let keys: Vec<&str> = fields.keys().map(String::as_str).collect();
        assert_eq!(
            keys.join(","),
            "productId,categoryId,groupId,subtype,days,lastObservedDay,lastListing",
            "the two fields ride at the end of the series they belong to",
        );
        assert_eq!(
            chosen["lastListing"],
            json!({ "day": "2026-11-16", "lowPkn": 133.33, "low": "0.8000", "currency": "USD" }),
            "0.80 USD at the 2026-11-16 rate of 1.2",
        );
        // A tail day with no listing price of its own falls back to the newest one.
        let mut stale = body.clone();
        stale["tcgplayer"]["series"][0]["days"] = json!([
            { "day": "2026-11-14", "marketPkn": 154.35, "lowPrice": "0.7900" },
            { "day": "2026-11-15", "lowPrice": "0.8100" },
            { "day": "2026-11-16" },
        ]);
        let ended = graph_answer_with_fx(&stale, false, "NM", &rates());
        assert_eq!(
            ended["tcgplayer"]["series"][0]["lastListing"],
            json!({ "day": "2026-11-15", "lowPkn": 140.87, "low": "0.8100", "currency": "USD" }),
            "0.81 USD at the 2026-11-15 rate of 1.15",
        );
        // No rates: the low price cannot be converted, so nothing is quoted.
        let blind = graph_answer_with_fx(&body, false, "NM", &FxRates::default());
        let blind_chosen = &blind["tcgplayer"]["series"][0];
        assert_eq!(blind_chosen["lastObservedDay"], json!("2026-11-16"));
        assert!(
            blind_chosen.get("lastListing").is_none(),
            "an unconvertible listing price is not sent as a bare source number"
        );
        // A series priced through its last day carries neither field.
        let healthy = graph_answer(&graph_body(), false, "NM");
        let kept = healthy["tcgplayer"]["series"].as_array().expect("series");
        for row in kept {
            assert!(row.get("lastObservedDay").is_none(), "{row}");
            assert!(row.get("lastListing").is_none(), "{row}");
        }
    }

    /// TCGplayer writes `0.0000` for a day it has no ask for, which is not the
    /// source going quiet: the newest tail day that reaches a PKN amount is the one
    /// quoted, and only a tail with nothing to quote sends no listing at all.
    #[test]
    fn graph_answer_quotes_the_newest_usable_tail_listing() {
        let tail = |older: &str, newer: &str| {
            let mut body = graph_body();
            body["tcgplayer"]["series"] = json!([
                {
                    "subtype": "Unlimited Holofoil",
                    "days": [
                        { "day": "2026-11-14", "marketPkn": 154.35, "lowPrice": "0.7900" },
                        { "day": "2026-11-15", "marketPrice": null, "lowPrice": older },
                        { "day": "2026-11-16", "marketPrice": null, "lowPrice": newer },
                    ],
                },
            ]);
            graph_answer_with_fx(&body, false, "NM", &rates())
        };
        assert_eq!(
            tail("0.8100", "0.0000")["tcgplayer"]["series"][0]["lastListing"],
            json!({ "day": "2026-11-15", "lowPkn": 140.87, "low": "0.8100", "currency": "USD" }),
            "a zero ask passes the quote to the older day that has one"
        );
        let answer = tail("0.0000", "0.0000");
        let chosen = &answer["tcgplayer"]["series"][0];
        assert_eq!(chosen["lastObservedDay"], json!("2026-11-16"));
        assert!(
            chosen.get("lastListing").is_none(),
            "a tail of nothing but zero asks quotes nothing: {chosen}"
        );
    }

    #[test]
    fn sql_binds_every_value() {
        for sql in [CM_PRODUCT_IDS_SQL, CM_GUIDE_HISTORY_SQL, FX_RATES_SQL] {
            assert!(!sql.contains('{'), "no format interpolation in {sql}");
            for value in [
                "239324",
                "119662",
                "794461",
                "2024-02-08",
                "2026-11-07",
                "2026-11-16",
            ] {
                assert!(!sql.contains(value), "{value} is interpolated into {sql}");
            }
        }
        // Every value reaches Postgres as a positional bind, never as inlined text.
        for (sql, params) in [
            (CM_PRODUCT_IDS_SQL, 1usize),
            (CM_GUIDE_HISTORY_SQL, 3),
            (FX_RATES_SQL, 1),
        ] {
            assert_eq!(sql.matches('$').count(), params, "{sql}");
            for index in 1..=params {
                assert!(sql.contains(&format!("${index}")), "{sql} binds ${index}");
            }
        }
    }

    /// One `CM_OFFER_HISTORY_SQL` row as Postgres answers it: the floor and the
    /// day, the seller type and its cents, and the facet the row was stored under.
    fn offer_row(
        day: &str,
        condition: &str,
        seller_type: &str,
        cents: i64,
        finish: &str,
        first_edition: &str,
        asked: bool,
    ) -> Value {
        json!({
            "day": day, "condition": condition, "seller_type": seller_type,
            "min_cents": cents, "finish": finish, "first_edition": first_edition,
            "asked": asked,
        })
    }

    /// The same row with no readable cents, which is what a damaged dump leaves.
    fn offer_row_without_price(day: &str, condition: &str, seller_type: &str) -> Value {
        let mut row = offer_row(day, condition, seller_type, 0, "N", "N", true);
        row["min_cents"] = Value::Null;
        row
    }

    /// The field names of an object, in the order the answer put them.
    fn field_order(value: &Value) -> String {
        value
            .as_object()
            .map(|map| map.keys().cloned().collect::<Vec<_>>().join(","))
            .unwrap_or_default()
    }

    /// `day lowestPkn sellerType asked` of every day of one floor, so that one
    /// assertion reads like the answer it checks.
    fn offer_days(block: &Value, floor: &str) -> Vec<String> {
        block["series"]
            .as_array()
            .map(|series| {
                series
                    .iter()
                    .filter(|row| row["condition"] == json!(floor))
                    .flat_map(|row| row["days"].as_array().cloned().unwrap_or_default())
                    .map(|day| {
                        format!(
                            "{} {} {} {}",
                            day["day"].as_str().unwrap_or_default(),
                            day["lowestPkn"],
                            day["sellerType"].as_str().unwrap_or_default(),
                            day["asked"],
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn cm_offer_cents_are_whole_pkn() {
        // Two PKN per euro cent: 9.20 EUR is 1840, and one cent is two. The scale
        // is PKN_PER_EUR per euro in an integer, because a cent is the smallest
        // money Cardmarket quotes and a PKN is never quoted in fractions.
        for (cents, pkn) in [
            (1.0, 2.0),
            (99.0, 198.0),
            (920.0, 1840.0),
            (25000.0, 50000.0),
        ] {
            assert_eq!(pkn_of_cents(Some(cents)), Some(pkn), "{cents} cents");
        }
        for cents in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(pkn_of_cents(Some(cents)), None, "{cents} is not an offer");
        }
        assert_eq!(pkn_of_cents(None), None);
        // The answer prints it without a decimal point, like every other PKN field.
        assert_eq!(pkn_json(pkn_of_cents(Some(920.0))), json!(1840));
    }

    #[test]
    fn cm_offer_facet_defaults_and_vocabularies() {
        assert_eq!(cm_offer_condition(None), Some("NM"));
        assert_eq!(cm_offer_condition(Some("")), Some("NM"));
        assert_eq!(cm_offer_condition(Some(" mp ")), Some("MP"));
        assert_eq!(cm_offer_condition(Some("poor")), Some("Poor"));
        assert_eq!(cm_offer_condition(Some("Mint")), None);
        assert_eq!(cm_offer_language(None), Some("EN"));
        assert_eq!(cm_offer_language(Some("")), Some("EN"));
        assert_eq!(cm_offer_language(Some("jp")), Some("JP"));
        assert_eq!(cm_offer_language(Some("ZHT")), Some("ZHT"));
        assert_eq!(cm_offer_language(Some("*")), Some("*"));
        // The desk's Indonesian, Thai and Vietnamese are not Cardmarket facets, and
        // nothing that is not one of the stored keys reaches the bind.
        for code in ["ID", "TH", "VI", "EN;", "NLX", "*;drop"] {
            assert_eq!(
                cm_offer_language(Some(code)),
                None,
                "{code} is not a stored key"
            );
        }
        // Everything each vocabulary holds is accepted by its own parser.
        for floor in CM_OFFER_FLOORS {
            assert_eq!(cm_offer_condition(Some(floor)), Some(floor), "{floor}");
        }
        for key in CM_OFFER_LANGUAGES {
            assert_eq!(cm_offer_language(Some(key)), Some(key), "{key}");
        }
    }

    #[test]
    fn cm_offer_series_takes_the_cheapest_seller_type_of_every_day() {
        let rows = [
            // Two pro offers and one private on 9 Nov: the private 9.20 EUR is the
            // day, and its own `asked` flag is what the day reports.
            offer_row("2026-11-09", "NM", "pro", 1500, "N", "N", true),
            offer_row("2026-11-09", "NM", "private", 920, "N", "N", true),
            offer_row("2026-11-09", "NM", "pro", 950, "N", "N", false),
            // The same floor a week later, cheapest from a pro this time.
            offer_row("2026-11-16", "NM", "pro", 1000, "N", "N", false),
            offer_row("2026-11-16", "NM", "private", 1200, "N", "N", true),
            // A second floor, one day.
            offer_row("2026-11-16", "SP", "private", 700, "N", "N", true),
        ];
        let block = cardmarket_offers_source(&rows, None, Some(279646), "EN", "N", "N");
        assert_eq!(
            field_order(&block),
            "source,currency,metric,status,idProduct,language,finish,firstEdition,conditionIsFloor,series"
        );
        assert_eq!(block["source"], json!("cardmarket_offers"));
        assert_eq!(block["currency"], json!("PKN"));
        assert_eq!(block["metric"], json!("lowestOffer"));
        assert_eq!(block["status"], json!("available"));
        assert_eq!(block["idProduct"], json!(279646));
        assert_eq!(block["language"], json!("EN"));
        assert_eq!(block["conditionIsFloor"], json!(true));
        assert_eq!(
            offer_days(&block, "NM"),
            ["2026-11-09 1840 private true", "2026-11-16 2000 pro false"],
            "the cheapest offer of the day across the seller types, in PKN"
        );
        assert_eq!(offer_days(&block, "SP"), ["2026-11-16 1400 private true"]);
        assert_eq!(
            field_order(&block["series"][0]["days"][0]),
            "day,lowestPkn,sellerType,asked"
        );
    }

    #[test]
    fn cm_offer_series_falls_back_to_the_aggregate_row_of_a_day() {
        let rows = [
            // 1 Nov carries the asked facet exactly.
            offer_row("2026-11-01", "NM", "private", 1000, "N", "N", true),
            // 2 Nov was never asked as a non-reverse facet: only its Y row and the
            // day's '*' aggregate exist, so the aggregate prices the N ask.
            offer_row("2026-11-02", "NM", "private", 800, "Y", "N", true),
            offer_row("2026-11-02", "NM", "private", 1500, "*", "*", true),
            // 3 Nov has both first-edition facets and no aggregate: the exact N
            // wins and the cheaper '*' row never enters.
            offer_row("2026-11-03", "NM", "private", 700, "N", "N", true),
            offer_row("2026-11-03", "NM", "private", 300, "N", "*", true),
            // 4 Nov has nothing but the aggregate rows of both facets.
            offer_row("2026-11-04", "NM", "private", 400, "*", "*", false),
        ];
        assert_eq!(
            offer_days(
                &cardmarket_offers_source(&rows, None, Some(7), "EN", "N", "N"),
                "NM"
            ),
            [
                "2026-11-01 2000 private true",
                "2026-11-02 3000 private true",
                "2026-11-03 1400 private true",
                "2026-11-04 800 private false",
            ],
            "the exact facet where the day has one, its aggregate only where it has none"
        );
        // The reverse ask reads the Y facet instead, and a day that has neither a Y
        // nor an aggregate finish row is simply not a day of that line.
        assert_eq!(
            offer_days(
                &cardmarket_offers_source(&rows, None, Some(7), "EN", "Y", "N"),
                "NM"
            ),
            [
                "2026-11-02 1600 private true",
                "2026-11-04 800 private false"
            ],
            "1 Nov and 3 Nov have no Y-finish row to read"
        );
        // Asked for the aggregate outright, every row of the day counts, cheapest wins.
        assert_eq!(
            offer_days(
                &cardmarket_offers_source(&rows, None, Some(7), "EN", "*", "*"),
                "NM"
            ),
            [
                "2026-11-01 2000 private true",
                "2026-11-02 1600 private true",
                "2026-11-03 600 private true",
                "2026-11-04 800 private false",
            ],
            "an aggregate ask is the cheapest row of the day whatever facet it was stored under"
        );
    }

    #[test]
    fn cm_offer_series_orders_the_floors_and_leaves_out_what_is_not_one() {
        let rows = [
            offer_row("2026-11-16", "Poor", "private", 100, "N", "N", true),
            offer_row("2026-11-16", "PL", "private", 200, "N", "N", true),
            offer_row("2026-11-16", "MP", "private", 300, "N", "N", true),
            offer_row("2026-11-16", "NM", "private", 400, "N", "N", true),
            offer_row("2026-11-15", "NM", "private", 500, "N", "N", true),
            // Not floors: the table's own aggregate over the conditions, and a code
            // nobody collects.
            offer_row("2026-11-16", "*", "private", 50, "N", "N", true),
            offer_row("2026-11-16", "Mint", "private", 60, "N", "N", true),
        ];
        let block = cardmarket_offers_source(&rows, None, Some(7), "EN", "N", "N");
        let floors = block["series"]
            .as_array()
            .expect("series")
            .iter()
            .map(|row| row["condition"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            floors,
            ["NM", "MP", "PL", "Poor"],
            "the floor order of the answer; SP has no day, so it is not a series"
        );
        assert_eq!(
            offer_days(&block, "NM"),
            [
                "2026-11-15 1000 private true",
                "2026-11-16 800 private true"
            ],
            "oldest first, whatever order the rows came in"
        );
    }

    #[test]
    fn cm_offer_series_has_no_day_it_cannot_price() {
        let rows = [
            // A floor whose only row has unreadable cents is not a series at all.
            offer_row_without_price("2026-11-09", "SP", "private"),
            // A day whose only row has unreadable cents is not a day.
            offer_row_without_price("2026-11-09", "NM", "private"),
            // A day where a priced offer wins over the unreadable one, however the
            // rows are ordered.
            offer_row_without_price("2026-11-10", "NM", "private"),
            offer_row("2026-11-10", "NM", "pro", 900, "N", "N", false),
            offer_row("2026-11-11", "NM", "private", 800, "N", "N", true),
        ];
        let block = cardmarket_offers_source(&rows, None, Some(7), "EN", "N", "N");
        assert_eq!(
            block["series"].as_array().expect("series").len(),
            1,
            "SP has no priced day, so the answer has one floor"
        );
        assert_eq!(
            offer_days(&block, "NM"),
            ["2026-11-10 1800 pro false", "2026-11-11 1600 private true"],
            "the unreadable 9 Nov is left out and never drawn as a price of zero"
        );
    }

    #[test]
    fn cm_offer_sql_binds_every_value() {
        assert!(
            !CM_OFFER_HISTORY_SQL.contains('{'),
            "no format interpolation in the statement"
        );
        // Neither the product, the facet nor the window is ever inlined, so a value
        // that is not a key of the vocabulary cannot reach Postgres as SQL.
        for value in [
            "279646",
            "EN",
            "ZHT",
            "NM",
            "Poor",
            "2024-02-08",
            "2026-11-16",
            "'; drop table public.cardmarket_offer_daily; --",
        ] {
            assert!(
                !CM_OFFER_HISTORY_SQL.contains(value),
                "{value} is interpolated into {CM_OFFER_HISTORY_SQL}"
            );
        }
        assert_eq!(
            CM_OFFER_HISTORY_SQL.matches('$').count(),
            6,
            "product, language, finish, first edition and the two day bounds"
        );
        for index in 1..=6 {
            assert!(
                CM_OFFER_HISTORY_SQL.contains(&format!("${index}")),
                "{CM_OFFER_HISTORY_SQL} binds ${index}"
            );
        }
        assert_eq!(
            CM_OFFER_TABLES.to_vec(),
            vec!["public.cardtrader_pokemon_blueprints", CM_OFFER_TABLE],
            "the probe covers both tables the statement reads"
        );
    }

    #[tokio::test]
    async fn cm_offer_leg_queries_only_a_present_table() {
        for (presence, expected_status, expected_calls) in [
            (Presence::Present, "empty", 1usize),
            (Presence::Missing, "empty", 0),
            (Presence::ProbeFailed, "unavailable", 0),
        ] {
            let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = std::sync::Arc::clone(&calls);
            let block = cardmarket_offers_leg(presence, move || {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async { cardmarket_offers_source(&[], None, None, "EN", "N", "N") }
            })
            .await;
            assert_eq!(block["status"], expected_status, "{presence:?}");
            assert_eq!(block["source"], json!("cardmarket_offers"), "{presence:?}");
            assert_eq!(
                block["series"].as_array().expect("series").len(),
                0,
                "{presence:?}"
            );
            assert_eq!(
                calls.load(std::sync::atomic::Ordering::SeqCst),
                expected_calls,
                "{presence:?}"
            );
        }
    }

    #[tokio::test]
    async fn other_games_stay_unsupported_for_the_offers_leg_too() {
        // A pool that cannot be reached at all: the stub is answered before the
        // probe, so nothing here ever acquires a connection.
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_millis(50))
            .connect_lazy("postgres://pokoin_test@127.0.0.1:1/pokoin_magic")
            .expect("lazy pool");
        let block = cardmarket_offers_history(
            &pool,
            "magic",
            Some("239324"),
            "2026-10-01",
            "2026-11-01",
            CmOfferPrinting {
                language: "JP",
                finish: "N",
                first_edition: "N",
            },
        )
        .await;
        assert_eq!(block["status"], json!("unsupported_game"));
        assert_eq!(block["source"], json!("cardmarket_offers"));
        assert_eq!(
            block["language"],
            json!("JP"),
            "the facet asked is still what the block names"
        );
        assert_eq!(block["idProduct"], Value::Null);
        assert!(block["series"].as_array().expect("series").is_empty());
    }

    #[test]
    fn cm_offer_graph_answer_keeps_only_the_asked_floor() {
        let body = graph_body();
        let graph = graph_answer(&body, false, "SP");
        assert_eq!(
            field_order(&graph["cardmarketOffers"]),
            "source,currency,metric,status,idProduct,language,finish,firstEdition,conditionIsFloor,series",
            "the header of the block is the full one, field for field"
        );
        let series = graph["cardmarketOffers"]["series"]
            .as_array()
            .expect("series");
        assert_eq!(series.len(), 1, "the one floor the desk plots");
        assert_eq!(series[0]["condition"], json!("SP"));
        assert_eq!(
            series[0]["days"],
            json!([{ "day": "2026-11-16", "lowestPkn": 1500 }]),
            "a graph day is the day and its price, nothing else"
        );
        assert!(
            graph_answer(&body, false, "Poor")["cardmarketOffers"]["series"]
                .as_array()
                .expect("series")
                .is_empty(),
            "a floor the table never had is not a line"
        );
    }

    #[test]
    fn cm_offer_graph_answer_thins_a_long_span_to_weeks() {
        let mut body = graph_body();
        body["from"] = json!("2025-01-01");
        body["cardmarketOffers"]["series"][0]["days"] = json!([
            { "day": "2026-11-09", "lowestPkn": 1800, "sellerType": "private", "asked": true },
            { "day": "2026-11-12", "lowestPkn": 1840, "sellerType": "pro", "asked": true },
            { "day": "2026-11-16", "lowestPkn": 1900, "sellerType": "private", "asked": false },
        ]);
        let weekly = graph_answer(&body, false, "NM");
        assert_eq!(weekly["bucket"], json!("week"));
        assert_eq!(
            weekly["cardmarketOffers"]["series"][0]["days"],
            json!([
                { "day": "2026-11-12", "lowestPkn": 1840 },
                { "day": "2026-11-16", "lowestPkn": 1900 },
            ]),
            "9 and 12 Nov are one week (W46: 9–15 Nov): its last priced day stands"
        );
    }
}
