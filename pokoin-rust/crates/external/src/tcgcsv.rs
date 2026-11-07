//! The TCGCSV store (TCGplayer prices) as a price source of the price-check
//! comp (`sources.tcgplayer`). Same store as
//! `crates/catalog-api/src/sales/tcgcsv.rs`, with its own lazy pool: env
//! `TCGCSV_DATABASE_URL` (`TCGCSV_DATABASE_SSL=0` disables TLS),
//! `statement_timeout` 5000, 2 connections. No URL → the source is
//! `unconfigured`.
//!
//! `pokoin_product_links.card_id` is the public card id (unique across
//! games), so no blueprint mapping is needed here; `game` is the normalized
//! slug.

use std::str::FromStr;
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::PgPool;

use crate::error::{ApiError, ApiResult};

/// The lazy TCGCSV pool, built once per process. `None` when
/// `TCGCSV_DATABASE_URL` is unset (the source is then `unconfigured`).
pub fn pool() -> Option<PgPool> {
    static POOL: OnceLock<Option<PgPool>> = OnceLock::new();
    POOL.get_or_init(|| {
        let url = std::env::var("TCGCSV_DATABASE_URL").ok().filter(|v| !v.trim().is_empty())?;
        let mut options = PgConnectOptions::from_str(&url).ok()?;
        options = if std::env::var("TCGCSV_DATABASE_SSL").as_deref() == Ok("0") {
            options.ssl_mode(PgSslMode::Disable)
        } else {
            options.ssl_mode(PgSslMode::VerifyFull)
        };
        options = options
            .options([("statement_timeout", "5000")])
            .application_name("pokoin-tcgcsv-pricer");
        Some(
            PgPoolOptions::new()
                .max_connections(2)
                .acquire_timeout(Duration::from_secs(5))
                .connect_lazy_with(options),
        )
    })
    .clone()
}

/// One bulk query per page: the active product links of these public card ids
/// of one game, joined with their latest prices.
pub const QUERY_SQL: &str = "select l.card_id, p.product_id, p.category_id, p.subtype, \
       p.market_price::float8 as market_price, p.low_price::float8 as low_price, \
       p.mid_price::float8 as mid_price, p.snapshot_timestamp \
     from pokoin_product_links l join latest_prices p using (product_id) \
     where l.active and l.game = $1 and l.card_id = any($2::bigint[])";

/// The finish facets a TCGplayer `subtype` string names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Subtype {
    pub reverse: bool,
    pub foil: bool,
    pub first_edition: bool,
}

/// Classify a TCGplayer subtype: `reverse` when it contains "reverse",
/// `foil` when it is reverse or contains "foil"/"holo", `first_edition` when
/// it starts with "1st edition" (all case-insensitive).
pub fn classify_subtype(subtype: &str) -> Subtype {
    let text = subtype.trim().to_lowercase();
    let reverse = text.contains("reverse");
    let foil = reverse || text.contains("foil") || text.contains("holo");
    let first_edition = text.starts_with("1st edition");
    Subtype { reverse, foil, first_edition }
}

/// One row of [`QUERY_SQL`].
#[derive(Clone, Debug, PartialEq)]
pub struct TcgRow {
    pub card_id: i64,
    pub product_id: i64,
    pub category_id: i64,
    pub subtype: String,
    pub market: Option<f64>,
    pub low: Option<f64>,
    pub mid: Option<f64>,
    /// The snapshot day (`snapshot_timestamp[..10]`).
    pub as_of: String,
}

impl TcgRow {
    /// The USD price of one basis: `market`, `low` or `mid`.
    pub fn price(&self, basis: &str) -> Option<f64> {
        match basis {
            "market" => self.market,
            "low" => self.low,
            "mid" => self.mid,
            _ => None,
        }
    }
}

fn int(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => n.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn float(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|n| n.is_finite())
}

/// The rows of one page, one bulk query. `Err` when the store is configured
/// but cannot answer (the caller then reports the source `unavailable`).
#[allow(clippy::result_large_err)]
pub async fn fetch(game: &str, card_ids: &[i64]) -> ApiResult<Vec<TcgRow>> {
    let pool = pool().ok_or_else(|| ApiError::new(503, "TCGCSV_DATABASE_URL is not configured."))?;
    let rows = sqlx::query(QUERY_SQL)
        .bind(game)
        .bind(card_ids.to_vec())
        .fetch_all(&pool)
        .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let value = pokoin_api_common::pg::row_to_node_json(row);
            TcgRow {
                card_id: int(value.get("card_id")).unwrap_or(0),
                product_id: int(value.get("product_id")).unwrap_or(0),
                category_id: int(value.get("category_id")).unwrap_or(0),
                subtype: value.get("subtype").and_then(Value::as_str).unwrap_or("").to_string(),
                market: float(value.get("market_price")),
                low: float(value.get("low_price")),
                mid: float(value.get("mid_price")),
                as_of: value
                    .get("snapshot_timestamp")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .get(..10)
                    .unwrap_or("")
                    .to_string(),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtype_classification() {
        let cases: [(&str, Subtype); 8] = [
            ("Normal", Subtype { reverse: false, foil: false, first_edition: false }),
            ("Holofoil", Subtype { reverse: false, foil: true, first_edition: false }),
            ("Reverse Holofoil", Subtype { reverse: true, foil: true, first_edition: false }),
            ("1st Edition Holofoil", Subtype { reverse: false, foil: true, first_edition: true }),
            ("Foil", Subtype { reverse: false, foil: true, first_edition: false }),
            ("Cold Foil", Subtype { reverse: false, foil: true, first_edition: false }),
            ("1st Edition", Subtype { reverse: false, foil: false, first_edition: true }),
            ("Unlimited", Subtype { reverse: false, foil: false, first_edition: false }),
        ];
        for (subtype, expected) in cases {
            assert_eq!(classify_subtype(subtype), expected, "{subtype}");
        }
        // Case-insensitive, and "1st edition" must be a prefix.
        assert!(classify_subtype("REVERSE HOLO").reverse);
        assert!(classify_subtype("1ST EDITION HOLO").first_edition);
        assert!(!classify_subtype("2nd Edition").first_edition);
        assert!(!classify_subtype("Holo").reverse, "holo alone is not reverse");
    }

    #[test]
    fn no_url_means_unconfigured() {
        // The test process never sets TCGCSV_DATABASE_URL.
        std::env::remove_var("TCGCSV_DATABASE_URL");
        assert!(pool().is_none());
    }
}
