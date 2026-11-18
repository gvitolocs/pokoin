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

/// The listing events that decide the `pokoin` line of one card: the last change
/// of every listing before the start of the range — the state its first day
/// begins in — and every change up to the end of the range. Each half is a
/// `card_id` equality plus an `occurred_at` bound, which is exactly
/// `marketplace_user_listing_events_card_day_idx (card_id, occurred_at desc)`, so
/// one statement reads the card's whole history and the day-by-day state is
/// folded from its rows below.
pub const POKOIN_EVENTS_SQL: &str = "with before_start as ( \
     select distinct on (e.listing_id) e.listing_id::text as listing_id, e.occurred_at, \
            e.status_after, e.quantity_after, e.price_pkn::float8 as price_pkn \
       from public.marketplace_user_listing_events e \
      where e.card_id = $1::text and e.occurred_at < $2::timestamptz \
      order by e.listing_id, e.occurred_at desc \
   ), in_range as ( \
     select e.listing_id::text as listing_id, e.occurred_at, e.status_after, \
            e.quantity_after, e.price_pkn::float8 as price_pkn \
       from public.marketplace_user_listing_events e \
      where e.card_id = $1::text and e.occurred_at >= $2::timestamptz \
        and e.occurred_at < $3::timestamptz \
   ) \
   select listing_id, \
          to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD') as day, \
          to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as at_utc, \
          status_after, quantity_after, price_pkn \
     from (select * from before_start union all select * from in_range) asked \
    order by at_utc, listing_id";

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

/// One row of `POKOIN_EVENTS_SQL`: a listing as it stands from `at` on.
#[derive(Clone, Debug, PartialEq)]
pub struct ListingEvent {
    /// The listing the change belongs to; rows without one share one state.
    pub listing: String,
    /// The UTC day of the change.
    pub day: String,
    /// The instant of the change, which orders the rows.
    pub at: String,
    pub status: String,
    pub quantity: Option<i64>,
    pub price: Option<f64>,
}

impl ListingEvent {
    /// The event of one row; a row without a day or an instant is not a change.
    fn from_row(row: &Value) -> Option<ListingEvent> {
        let day = day_of(row.get("day"));
        let at = js::string_or_empty(row.get("at_utc"));
        if day.len() != 10 || at.is_empty() {
            return None;
        }
        Some(ListingEvent {
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

/// The rows of `POKOIN_EVENTS_SQL` in the order the changes happened.
pub fn listing_events(rows: &[Value]) -> Vec<ListingEvent> {
    let mut events: Vec<ListingEvent> = rows.iter().filter_map(ListingEvent::from_row).collect();
    events.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.listing.cmp(&b.listing)));
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

/// The row with the most days among those `within` accepts, the first when
/// several tie; `None` when none is accepted.
fn most_days(series: &[Value], within: impl Fn(&Value) -> bool) -> Option<&Value> {
    let mut best: Option<(&Value, usize)> = None;
    for row in series.iter().filter(|row| within(row)) {
        let seen = row
            .get("days")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        if best.is_none_or(|(_, previous)| seen > previous) {
            best = Some((row, seen));
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
/// non-reverse one otherwise; among those the one with the most days, and of all
/// of them when none is in the preferred group.
pub fn chosen_series(series: &[Value], reverse: bool) -> Option<&Value> {
    most_days(series, |row| is_reverse_series(row) == reverse)
        .or_else(|| most_days(series, |_| true))
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

/// The `tcgplayer` block of the graph answer: the one plotted series.
fn tcgplayer_graph(block: &Value, reverse: bool, weekly: bool) -> Value {
    let series = block.get("series").and_then(Value::as_array);
    let kept: Vec<Value> = series
        .and_then(|rows| chosen_series(rows, reverse))
        .map(|row| {
            with_field(
                row,
                "days",
                Value::Array(graph_day_rows(
                    row.get("days").and_then(Value::as_array),
                    weekly,
                    tcg_graph_day,
                )),
            )
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
pub fn graph_answer(body: &Value, reverse: bool) -> Value {
    let Some(object) = body.as_object() else {
        return body.clone();
    };
    let weekly = graph_is_weekly(&day_of(object.get("from")), &day_of(object.get("to")));
    let mut out = Map::new();
    for (key, block) in object {
        let block = match key.as_str() {
            "cardtrader" | "pokoin" => ask_graph(block, weekly),
            "tcgplayer" => tcgplayer_graph(block, reverse, weekly),
            "cardmarket" => cardmarket_graph(block, weekly),
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
            "fx": { "base": "EUR", "quote": "USD", "firstDay": "2026-08-10", "lastDay": "2026-11-16" },
        })
    }

    /// One row of `POKOIN_EVENTS_SQL` as Postgres answers it: the listing, the UTC
    /// day and instant of its change, and how the listing stands from then on.
    fn event_row(listing: &str, at: &str, status: &str, quantity: Value, price: Value) -> Value {
        json!({
            "listing_id": listing, "day": &at[..10], "at_utc": at,
            "status_after": status, "quantity_after": quantity, "price_pkn": price,
        })
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
        assert!(!ListingEvent::from_row(&json!({ "day": "2026-10-01", "at_utc": "2026-10-01T00:00:00.000Z", "status_after": "removed", "quantity_after": 0, "price_pkn": null }))
            .expect("row")
            .is_live());
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
        let graph = graph_answer(&body, false);
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
        for block in ["cardtrader", "tcgplayer", "cardmarket", "pokoin"] {
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
        let reverse = graph_answer(&body, true);
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
        let weekly = graph_answer(&body, false);
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
}
