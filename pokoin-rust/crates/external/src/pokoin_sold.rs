//! Pokoin's own sold prices (Firestore `marketplace_sales`) as a price source
//! of the price-check comp (`sources.pokoin.sold`).
//!
//! Sale docs are written by `sale_docs_from_order` (commerce): `cardId` (the
//! public card id, unique across games), `condition`, `language`, `quantity`,
//! `unitPricePkn`, `unitPriceEURCents` (EUR orders), `soldAt` (ISO string) and
//! `voided`. A sale is a comp only while it is not voided and not older than
//! [`WINDOW_DAYS`] days; its price is `unitPricePkn`, else `unitPriceEURCents`
//! × 2 (200 PKN = €1) for EUR orders.
//!
//! The last 90 days' sales are cached process-wide and refreshed at most once
//! per [`REFRESH_AFTER`] through one Firestore query (`soldAt >= now-90d`,
//! limit [`MAX_SALES`]); concurrent callers share one refresh, and a failed
//! refresh keeps serving the previous load.

use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::error::ApiResult;
use crate::firebase::FirestoreStore;
use crate::price_check::condition_key;

/// The Firestore collection the order flow writes sale docs to.
pub const SALES_COLLECTION: &str = "marketplace_sales";
/// Only sales of the last 90 days are comps.
pub const WINDOW_DAYS: i64 = 90;
/// One refresh query reads at most this many docs.
pub const MAX_SALES: u32 = 50_000;
/// The cache is refreshed when the last load is older than this.
pub const REFRESH_AFTER: Duration = Duration::from_secs(600);

const DAY_MS: i64 = 86_400_000;

/// One parsed sale doc: the facets a comp is keyed by and its price in PKN.
#[derive(Clone, Debug, PartialEq)]
pub struct PokoinSale {
    pub card_id: String,
    pub condition: String,
    pub language: String,
    pub price_pkn: f64,
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|n| n.is_finite())
}

/// One `marketplace_sales` doc as a [`PokoinSale`], or `None` when it is not a
/// comp: voided, `soldAt` unparsable or older than 90 days, no card id, or no
/// positive price (`unitPricePkn`, else `unitPriceEURCents` × 2).
pub fn sale_from_doc(doc: &Value, now_ms: i64) -> Option<PokoinSale> {
    if doc.get("voided").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let sold_at = doc.get("soldAt").and_then(Value::as_str)?;
    let sold_ms = crate::time_util::ms_from_iso(sold_at)?;
    if now_ms - sold_ms > WINDOW_DAYS * DAY_MS {
        return None;
    }
    let card_id = doc
        .get("cardId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())?
        .to_string();
    let price_pkn = match number(doc.get("unitPricePkn")).filter(|v| *v > 0.0) {
        Some(pkn) => pkn,
        None => number(doc.get("unitPriceEURCents")).filter(|v| *v > 0.0).map(|cents| cents * 2.0)?,
    };
    let condition = condition_key(doc.get("condition").and_then(Value::as_str).unwrap_or(""));
    let language = doc
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_uppercase();
    Some(PokoinSale { card_id, condition, language, price_pkn })
}

/// `now - 90 days` as the ISO string the `soldAt >= …` query filters on.
pub fn window_start_iso() -> String {
    crate::time_util::iso_from_ms(crate::time_util::now_ms() - WINDOW_DAYS * DAY_MS)
}

#[derive(Default)]
struct Cache {
    sales: Vec<PokoinSale>,
    loaded_at: Option<Instant>,
}

fn cache() -> &'static RwLock<Cache> {
    static CACHE: OnceLock<RwLock<Cache>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
}

fn fresh(guard: &Cache) -> bool {
    guard.loaded_at.is_some_and(|at| at.elapsed() < REFRESH_AFTER)
}

/// The outcome of a load: the sales to price with, or that there never was a
/// load (the source is then `unavailable`).
pub enum SoldFeed {
    Available(Vec<PokoinSale>),
    Unavailable,
}

impl SoldFeed {
    pub fn as_slice(&self) -> Option<&[PokoinSale]> {
        match self {
            SoldFeed::Available(sales) => Some(sales),
            SoldFeed::Unavailable => None,
        }
    }
}

/// Parse docs into sales and make them the current load. Returns how many
/// docs became sales.
pub fn absorb(docs: &[Value]) -> usize {
    let now = crate::time_util::now_ms();
    let sales: Vec<PokoinSale> = docs.iter().filter_map(|doc| sale_from_doc(doc, now)).collect();
    let count = sales.len();
    let mut guard = cache().write().unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.sales = sales;
    guard.loaded_at = Some(Instant::now());
    count
}

/// The cached sales when the last load is still fresh, else `None`.
pub fn cached_fresh() -> Option<Vec<PokoinSale>> {
    let guard = cache().read().unwrap_or_else(|poisoned| poisoned.into_inner());
    fresh(&guard).then(|| guard.sales.clone())
}

/// Load the last 90 days' sales through `load` (one query returning the raw
/// docs), unless the cache is fresh. Concurrent callers share one refresh
/// (the lock is held across the query); on error the previous load keeps
/// serving, and with no previous load the feed is `Unavailable`.
pub async fn recent_from<Fut>(load: Fut) -> SoldFeed
where
    Fut: std::future::Future<Output = ApiResult<Vec<Value>>>,
{
    if let Some(sales) = cached_fresh() {
        return SoldFeed::Available(sales);
    }
    let _guard = refresh_lock().lock().await;
    if let Some(sales) = cached_fresh() {
        return SoldFeed::Available(sales);
    }
    match load.await {
        Ok(docs) => {
            absorb(&docs);
            match cached_fresh() {
                Some(sales) => SoldFeed::Available(sales),
                None => SoldFeed::Unavailable,
            }
        }
        Err(error) => {
            tracing::warn!(error = %error, "pokoin sold feed refresh failed; serving the previous load");
            let guard = cache().read().unwrap_or_else(|poisoned| poisoned.into_inner());
            if guard.loaded_at.is_some() {
                SoldFeed::Available(guard.sales.clone())
            } else {
                SoldFeed::Unavailable
            }
        }
    }
}

/// Load through the external Firestore store: one `soldAt >= now-90d` query
/// over `marketplace_sales`.
pub async fn recent(store: &dyn FirestoreStore) -> SoldFeed {
    let since = window_start_iso();
    recent_from(async move {
        let docs = store
            .query_where_gte(SALES_COLLECTION, "soldAt", &since, MAX_SALES)
            .await?;
        Ok(docs.into_iter().map(|doc| doc.data).collect::<Vec<_>>())
    })
    .await
}

#[cfg(test)]
pub fn clear_cache_for_test() {
    let mut guard = cache().write().unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Cache::default();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_780_000_000_000; // fixed "now" for the parsing tests

    fn doc(fields: Value) -> Value {
        fields
    }

    #[test]
    fn sale_docs_parse_to_sales() {
        let sale = sale_from_doc(
            &doc(json!({
                "cardId": "633380", "condition": "NM", "language": "it",
                "quantity": 2, "unitPricePkn": 300.0, "soldAt": "2026-10-08T10:00:00.000Z",
                "voided": false,
            })),
            NOW,
        )
        .unwrap();
        assert_eq!(sale.card_id, "633380");
        assert_eq!(sale.condition, "NM");
        assert_eq!(sale.language, "IT", "the language key is uppercase");
        assert_eq!(sale.price_pkn, 300.0);
        // LP is CardTrader's SP.
        let lp = sale_from_doc(
            &doc(json!({"cardId": "1", "condition": "LP", "language": "EN", "unitPricePkn": 10, "soldAt": "2026-10-08T10:00:00.000Z"})),
            NOW,
        )
        .unwrap();
        assert_eq!(lp.condition, "SP");
    }

    #[test]
    fn voided_old_and_priceless_docs_are_not_sales() {
        let base = json!({"cardId": "1", "condition": "NM", "language": "EN", "unitPricePkn": 100, "soldAt": "2026-10-08T10:00:00.000Z"});
        let mut voided = base.clone();
        voided["voided"] = json!(true);
        assert!(sale_from_doc(&voided, NOW).is_none(), "voided");
        let mut old = base.clone();
        old["soldAt"] = json!("2026-01-01T00:00:00.000Z");
        assert!(sale_from_doc(&old, NOW).is_none(), "older than 90 days");
        let mut no_date = base.clone();
        no_date["soldAt"] = json!("not a date");
        assert!(sale_from_doc(&no_date, NOW).is_none(), "unparsable soldAt");
        let mut zero = base.clone();
        zero["unitPricePkn"] = json!(0);
        assert!(sale_from_doc(&zero, NOW).is_none(), "no positive price");
        let mut no_card = base.clone();
        no_card["cardId"] = json!("  ");
        assert!(sale_from_doc(&no_card, NOW).is_none());
        // A sale exactly 90 days old is still in the window.
        let mut edge = base.clone();
        edge["soldAt"] = json!(crate::time_util::iso_from_ms(NOW - WINDOW_DAYS * DAY_MS));
        assert!(sale_from_doc(&edge, NOW).is_some());
        let mut just_over = base.clone();
        just_over["soldAt"] = json!(crate::time_util::iso_from_ms(NOW - WINDOW_DAYS * DAY_MS - 1));
        assert!(sale_from_doc(&just_over, NOW).is_none());
    }

    #[test]
    fn eur_orders_fall_back_to_cents_times_two() {
        let sale = sale_from_doc(
            &doc(json!({"cardId": "7", "condition": "NM", "language": "EN", "unitPriceEURCents": 149, "soldAt": "2026-10-08T10:00:00.000Z"})),
            NOW,
        )
        .unwrap();
        assert_eq!(sale.price_pkn, 298.0);
        // unitPricePkn wins when both are set.
        let both = sale_from_doc(
            &doc(json!({"cardId": "7", "unitPricePkn": 50, "unitPriceEURCents": 149, "soldAt": "2026-10-08T10:00:00.000Z"})),
            NOW,
        )
        .unwrap();
        assert_eq!(both.price_pkn, 50.0);
        // String numbers parse too (Firestore integerValue decodes to a number, but be lenient).
        let text = sale_from_doc(
            &doc(json!({"cardId": "7", "unitPricePkn": "42.5", "soldAt": "2026-10-08T10:00:00.000Z"})),
            NOW,
        )
        .unwrap();
        assert_eq!(text.price_pkn, 42.5);
    }

    #[tokio::test]
    async fn the_cache_serves_one_load_and_survives_a_failed_refresh() {
        clear_cache_for_test();
        assert!(cached_fresh().is_none());
        assert!(matches!(recent_from(async { Err(crate::error::ApiError::new(500, "boom")) }).await, SoldFeed::Unavailable));
        let docs = vec![
            json!({"cardId": "1", "condition": "NM", "language": "EN", "unitPricePkn": 100, "soldAt": crate::time_util::iso_from_ms(crate::time_util::now_ms())}),
            json!({"cardId": "2", "voided": true, "unitPricePkn": 100, "soldAt": crate::time_util::iso_from_ms(crate::time_util::now_ms())}),
        ];
        let feed = recent_from(async move { Ok(docs.clone()) }).await;
        let SoldFeed::Available(sales) = feed else { panic!("available") };
        assert_eq!(sales.len(), 1, "the voided doc is not a sale");
        assert_eq!(sales[0].card_id, "1");
        // Fresh now: a load that would fail still serves the previous one.
        let feed = recent_from(async { Err(crate::error::ApiError::new(500, "boom")) }).await;
        let SoldFeed::Available(sales) = feed else { panic!("previous load") };
        assert_eq!(sales.len(), 1);
        // absorb replaces the load.
        assert_eq!(absorb(&[json!({"cardId": "9", "unitPricePkn": 5, "soldAt": crate::time_util::iso_from_ms(crate::time_util::now_ms())})]), 1);
        let sales = cached_fresh().unwrap();
        assert_eq!(sales.len(), 1);
        assert_eq!(sales[0].card_id, "9");
        clear_cache_for_test();
    }

    #[tokio::test]
    async fn the_memory_store_answers_query_where_gte() {
        let store = crate::firebase::MemoryFirestore::new();
        store
            .seed("marketplace_sales", "a", json!({"soldAt": "2026-10-01T00:00:00.000Z", "cardId": "1"}))
            .await;
        store
            .seed("marketplace_sales", "b", json!({"soldAt": "2026-10-09T00:00:00.000Z", "cardId": "2"}))
            .await;
        store.seed("other", "c", json!({"soldAt": "2026-10-10T00:00:00.000Z"})).await;
        let docs = store
            .query_where_gte("marketplace_sales", "soldAt", "2026-10-05T00:00:00.000Z", 10)
            .await
            .unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].data["cardId"], "2");
        let docs = store
            .query_where_gte("marketplace_sales", "soldAt", "2026-10-01T00:00:00.000Z", 1)
            .await
            .unwrap();
        assert_eq!(docs.len(), 1, "the limit applies");
    }
}
