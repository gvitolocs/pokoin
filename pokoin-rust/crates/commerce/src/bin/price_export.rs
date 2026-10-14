//! Writes the daily `PKP2` headline-price file the CardRails camera dictionary
//! ships (`docs/PRICE_EXPORT.md`, format + price rule documented there).
//!
//! READ-ONLY: the only statement this binary ever runs is the single SELECT
//! inside [`pokoin_commerce::price_export::collect_price_rows`], and the
//! connection is opened with `default_transaction_read_only = on` so even a
//! future accidental write fails at the session level. There is no writer
//! pool, no webhook, no side effect on the database.
//!
//! ```text
//! MARKETPLACE_DATABASE_URL=postgres://… price-export /srv/export/headline-prices.pkp2
//! ```
//!
//! `MARKETPLACE_DATABASE_URL` wins over `DATABASE_URL` — point it at the read
//! replica, the same pool the API reads with. Writes `<path>` plus a
//! `<path>.sha256` sidecar (`sha256sum -c` ready).

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;

use pokoin_commerce::price_export::{self, SOURCE_CARDTRADER, SOURCE_SOLD_30D};

/// Read-replica pool. The startup option makes the session refuse writes even
/// if a query somewhere below ever stops being a SELECT.
async fn read_only_pool(url: &str) -> Result<PgPool, sqlx::Error> {
    let options: PgConnectOptions = url.parse()?;
    let options = options.options([("default_transaction_read_only", "on")]);
    PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(30))
        .connect_with(options)
        .await
}

fn database_url() -> Result<String, String> {
    let url = std::env::var("MARKETPLACE_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| "Set MARKETPLACE_DATABASE_URL (or DATABASE_URL) to the read replica.".to_string())?;
    Ok(url)
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let Some(path) = std::env::args().nth(1) else {
        return Err("usage: price-export <output-file.pkp2>".into());
    };
    let pool = read_only_pool(&database_url()?).await?;
    let rows = price_export::collect_price_rows(&pool).await?;
    pool.close().await;

    let as_of = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let bytes = price_export::encode(as_of, &rows);

    std::fs::write(&path, &bytes)?;
    let digest = hex::encode(Sha256::digest(&bytes));
    let sidecar = format!("{path}.sha256");
    // `sha256sum -c` form: digest, two spaces, the bare file name.
    let name = Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    std::fs::write(&sidecar, format!("{digest}  {name}\n"))?;

    let cards: HashSet<u32> = rows.iter().map(|row| row.card_id).collect();
    let sold = rows.iter().filter(|row| row.source == SOURCE_SOLD_30D).count();
    let trader = rows.iter().filter(|row| row.source == SOURCE_CARDTRADER).count();
    println!(
        "price-export: {} rows over {} cards (sold-30d {sold}, cardtrader {trader}), as_of {as_of}",
        rows.len(),
        cards.len()
    );
    println!("wrote {path}");
    println!("wrote {sidecar} ({digest})");
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("price-export: {error}");
        std::process::exit(1);
    }
}
