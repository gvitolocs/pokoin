//! Port of `_tcgcsv_prices.js` (TCGCSV Postgres at `TCGCSV_DATABASE_URL`).

use std::str::FromStr;
use std::sync::OnceLock;
use std::time::Duration;

use pokoin_api_common::pg::{self, Bind};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::PgPool;

/// Failures carry the Node `statusCode` (503 = unconfigured).
pub enum TcgError {
    Unconfigured,
    Db(sqlx::Error),
}

fn pool(history: bool) -> Option<PgPool> {
    static CURRENT: OnceLock<Option<PgPool>> = OnceLock::new();
    static HISTORY: OnceLock<Option<PgPool>> = OnceLock::new();
    let cell = if history { &HISTORY } else { &CURRENT };
    cell.get_or_init(|| {
        let url = std::env::var("TCGCSV_DATABASE_URL").ok().filter(|v| !v.trim().is_empty())?;
        let mut options = PgConnectOptions::from_str(&url).ok()?;
        options = if std::env::var("TCGCSV_DATABASE_SSL").as_deref() == Ok("0") { options.ssl_mode(PgSslMode::Disable) } else { options.ssl_mode(PgSslMode::VerifyFull) };
        let timeout = if history { "15000" } else { "5000" };
        options = options
            .options([("statement_timeout", timeout)])
            .application_name(if history { "pokoin-tcgcsv-history" } else { "pokoin-tcgcsv-prices" });
        Some(
            PgPoolOptions::new()
                .max_connections(if history { 1 } else { 2 })
                .acquire_timeout(Duration::from_secs(5))
                .connect_lazy_with(options),
        )
    })
    .clone()
}

/// `readTcgplayerHistory(game, cardId, from, to)`.
pub async fn read_tcgplayer_history(game: &str, card_id: &str, from: &str, to: &str) -> Result<Value, TcgError> {
    let Some(pool) = pool(true) else { return Err(TcgError::Unconfigured) };
    let id: i64 = card_id.parse().unwrap_or(0);
    let mapped = pg::pool_rows(
        &pool,
        "SELECT DISTINCT l.product_id,p.category_id
    FROM pokoin_product_links l LEFT JOIN latest_prices p USING(product_id)
    WHERE l.active AND l.game=$1 AND l.card_id=$2::bigint",
        &[Bind::Text(game.to_owned()), Bind::Int(id)],
    )
    .await
    .map_err(TcgError::Db)?;
    let mut products: Vec<i64> = Vec::new();
    let mut categories: Vec<i64> = vec![3, 85];
    for row in &mapped {
        if let Some(p) = crate::shared::js::js_string(&row["product_id"]).parse::<i64>().ok() {
            if !products.contains(&p) {
                products.push(p);
            }
        }
        let c = crate::shared::js::number(row.get("category_id"));
        if c.is_finite() && c != 0.0 && !categories.contains(&(c as i64)) {
            categories.push(c as i64);
        }
    }
    let observations = if products.is_empty() {
        Vec::new()
    } else {
        let cats: Vec<String> = categories.iter().map(|c| c.to_string()).collect();
        pg::pool_rows(
            &pool,
            "SELECT p.* FROM all_daily_prices p
    WHERE product_id=ANY($1::bigint[]) AND category_id=ANY($2::text[]::integer[])
      AND observed_on BETWEEN $3::date AND $4::date
    ORDER BY observed_on,category_id,product_id,subtype",
            &[Bind::BigIntArray(products), Bind::TextArray(cats), Bind::Text(from.to_owned()), Bind::Text(to.to_owned())],
        )
        .await
        .map_err(TcgError::Db)?
    };
    Ok(json!({
        "source": "tcgcsv/tcgplayer", "currency": "USD", "conditionSpecific": false, "languageSpecific": false,
        "game": game, "cardId": card_id, "from": from, "to": to, "observations": observations,
    }))
}
