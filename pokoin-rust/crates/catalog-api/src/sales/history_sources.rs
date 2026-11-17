//! The extra sources of `GET /api/marketplace-card-price-history`: the Cardmarket
//! price guide and the EUR→USD rates that put the TCGplayer USD quotes on the
//! same PKN scale. Every block degrades alone, so the SQL lives here and the
//! handlers pass their rows to the pure builders below.

use std::collections::HashMap;

use pokoin_api_common::pg::{self, Bind};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::shared::js;

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

    pub fn is_empty(&self) -> bool {
        self.rates.is_empty()
    }

    /// The newest rate with `day <=` the asked day; the first stored rate (marked
    /// `approx`) for a day that predates the stored history; `None` without rates.
    pub fn rate_for(&self, day: &str) -> Option<ChosenRate> {
        let first = self.rates.first()?;
        match self
            .rates
            .iter()
            .filter(|rate| rate.day.as_str() <= day)
            .next_back()
        {
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

/// The EUR→USD rates up to `to`; no rates when the table is missing or empty.
pub async fn read_fx_rates(pool: &PgPool, to: &str) -> FxRates {
    match pg::pool_rows(pool, FX_RATES_SQL, &[Bind::Text(to.to_owned())]).await {
        Ok(rows) => FxRates::from_rows(&rows),
        Err(error) => {
            warn_query("fx_rates_daily", &error);
            FxRates::default()
        }
    }
}

/// The `cardmarket` block of the response. Only Pokémon has a guide; every other
/// game gets the stub without a query, and a failed query fails this block alone.
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
    let products = match cm_product_ids(pool, ct_id).await {
        Ok(products) => products,
        Err(error) => return failed_cardmarket(&error),
    };
    match cm_guide_rows(pool, &products, from, to).await {
        Ok(rows) => cardmarket_source(&rows, None),
        Err(error) => failed_cardmarket(&error),
    }
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
        assert!(!usable.is_empty());
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
