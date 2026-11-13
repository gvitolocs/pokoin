//! `job price-fallback-listings [--dry-run] [--seller=<uid>] [--game=<slug>] [--csv=<path>]`
//!
//! Reprices every listing still sitting at the scan desk's fallback price: a
//! scanned card whose printing has neither sold comps nor a listing defaults
//! to 10,000 EUR (`SCAN_FALLBACK_PRICE_EUR` in `market/src/scan-pricing.js`,
//! 2,000,000 PKN at the client's fixed 1 PKN = €0.005 parity) so the seller
//! can always upload. Nobody buys at that price: the fallback is a placeholder
//! that lets the row through, not an offer, and nothing else ever touched it
//! (`pricing-groups-daily` only works on grouped listings, `price-unpriced-listings`
//! only on paused listings at 0).
//!
//! The new price is Pokoin's CardTrader reference price of the listing's own
//! facets from the price store (`facet_store::listing_price`), net of the
//! seller's own CardTrader commission when they are connected (`ct_fees`). A
//! listing with no matching offer keeps the fallback and is counted in
//! `noOffer`; a game whose store cannot answer is listed in `noStore` and its
//! listings keep the fallback too.
//!
//! It writes by default (the 05:30 UTC timer passes no flags, an hour after
//! the price-store refill), `--dry-run` only reports. The status is never
//! touched: a paused listing stays paused and only its price moves. Each write
//! is a compare-and-set on "still at the fallback with stock", so a price the
//! seller set meanwhile wins (`skipped`), and repeating the run changes
//! nothing — a repriced listing is no longer at the fallback. The new price
//! reaches the price summary, the caches, the seller API events and Card Rails
//! through the listing outbox (`LISTING_PRICE_CHANGED`), the same write `job
//! cardtrader-pro-floor-reprice` does.
//!
//! Only Postgres and the sellers' Firestore integration docs: CardTrader is
//! not called here.
use super::Options;
use anyhow::{Context, Result};
use pokoin_external::ct_fees::Channel;
use pokoin_external::{db::DbPools, facet_store, firebase::FirestoreRest};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

/// The scan desk's fallback in PKN: 10,000 EUR at the fixed parity
/// (`PKN_USDT_PRICE` = €0.005), the value `scanFallbackPricePkn()` in
/// `market/src/scan-pricing.js` writes for a scanned row with no price.
pub const SCAN_FALLBACK_PRICE_PKN: f64 = 2_000_000.0;

/// PKN per euro, the same parity the fallback was priced with (1 PKN = €0.005).
const PKN_PER_EUR: f64 = SCAN_FALLBACK_PRICE_PKN / 10_000.0;

/// Every seller's listings still at the fallback, or one seller's with
/// `--seller`; `$1`/`$2` empty means no seller or game filter.
const SELECT_SQL: &str = r#"
  select listing.id::text as id, listing.seller_uid::text as seller_uid, listing.status,
         listing.card_id, listing.card_name, listing.set_name,
         listing.collector_number, listing.condition, listing.language, listing.foil_state,
         listing.reverse, listing.first_edition, listing.graded, listing.signed, listing.altered,
         listing.quantity_available, listing.location,
         coalesce(nullif(listing.marketplace_game, ''), 'pokemon') as marketplace_game
  from public.marketplace_user_listings as listing
  where listing.price_pkn = 2000000
    and listing.status in ('active', 'paused')
    and listing.quantity_available > 0
    and listing.card_id ~ '^[0-9]+$'
    and ($1::text = '' or listing.seller_uid = $1::text)
    and ($2::text = '' or coalesce(nullif(listing.marketplace_game, ''), 'pokemon') = $2::text)
  order by listing.seller_uid, listing.created_at, listing.id
"#;

/// Only a listing still at the fallback with stock is repriced, and only its
/// price moves: the seller's own price or a sale meanwhile wins, and a paused
/// listing stays paused.
const SET_PRICE_SQL: &str = r#"
  update public.marketplace_user_listings
  set price_pkn = $2, updated_at = now()
  where id = $1::uuid and price_pkn = 2000000 and quantity_available > 0
  returning to_jsonb(marketplace_user_listings) as listing
"#;

pub(super) async fn run(options: &Options) -> Result<()> {
    // Only Postgres and the integration docs: no CardTrader call.
    let db = DbPools::from_env(2).await?;
    let firestore = FirestoreRest::from_env();
    let seller_filter = options.seller.clone().unwrap_or_default();
    let game_filter = options.game.clone().unwrap_or_default();
    let rows = db
        .query(
            "pokemon",
            SELECT_SQL,
            &[json!(seller_filter), json!(game_filter)],
        )
        .await?;

    let mut by_game: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for row in &rows {
        let game = row["marketplace_game"]
            .as_str()
            .unwrap_or("pokemon")
            .to_string();
        if let Some(id) = row["card_id"]
            .as_str()
            .and_then(|id| id.parse::<i64>().ok())
        {
            by_game.entry(game).or_default().push(id);
        }
    }
    let mut hits = BTreeMap::new();
    for (game, ids) in &mut by_game {
        ids.sort_unstable();
        ids.dedup();
        hits.insert(game.clone(), facet_store::lookup(&db, game, ids).await?);
    }

    // One CardTrader commission per seller: the integration doc and its rate
    // are read once for each distinct seller of the batch, not per listing.
    let mut channels: HashMap<String, Option<Channel>> = HashMap::new();
    let mut plans: Vec<(&Value, Option<f64>)> = Vec::with_capacity(rows.len());
    for row in &rows {
        let game = row["marketplace_game"].as_str().unwrap_or("pokemon");
        let seller = row["seller_uid"].as_str().unwrap_or("");
        let channel = seller_channel(&db, firestore.as_ref(), &mut channels, seller).await;
        let price = hits
            .get(game)
            .and_then(Option::as_ref)
            .and_then(|hit| facet_store::listing_price(hit, row, channel));
        plans.push((row, price));
    }

    let sellers: HashSet<&str> = plans
        .iter()
        .map(|(row, _)| row["seller_uid"].as_str().unwrap_or(""))
        .collect();
    let mut summary = json!({
        "dryRun": options.dry_run, "sellers": sellers.len(), "candidates": plans.len(),
        "priced": 0, "noOffer": 0, "noStore": [], "repriced": 0, "skipped": 0, "games": {},
    });
    let no_store: Vec<&String> = hits
        .iter()
        .filter(|(_, hit)| hit.is_none())
        .map(|(game, _)| game)
        .collect();
    summary["noStore"] = json!(no_store);
    for (row, price) in &plans {
        let game = row["marketplace_game"].as_str().unwrap_or("pokemon");
        let key = if price.is_some() { "priced" } else { "noOffer" };
        bump(&mut summary, game, key);
    }

    if let Some(path) = &options.csv {
        let mut out = String::from(
            "listing_id,seller_uid,game,status,card_id,card_name,set_name,collector_number,language,condition,foil_state,quantity,location,new_pkn,new_eur\n",
        );
        for (row, price) in &plans {
            let cell = |key: &str| {
                csv_cell(&match &row[key] {
                    Value::String(text) => text.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                })
            };
            let cells = [
                cell("id"),
                cell("seller_uid"),
                cell("marketplace_game"),
                cell("status"),
                cell("card_id"),
                cell("card_name"),
                cell("set_name"),
                cell("collector_number"),
                cell("language"),
                cell("condition"),
                cell("foil_state"),
                cell("quantity_available"),
                cell("location"),
                price.map(|pkn| pkn.to_string()).unwrap_or_default(),
                price
                    .map(|pkn| format!("{:.2}", pkn / PKN_PER_EUR))
                    .unwrap_or_default(),
            ];
            out.push_str(&cells.join(","));
            out.push('\n');
        }
        std::fs::write(path, out).with_context(|| format!("writing {path}"))?;
        summary["csv"] = json!(path);
    }

    if !options.dry_run {
        let writer = db.writer()?;
        for (row, price) in &plans {
            let Some(pkn) = price else { continue };
            let game = row["marketplace_game"].as_str().unwrap_or("pokemon");
            let id = row["id"].as_str().unwrap_or("");
            let mut tx = writer.begin().await?;
            let updated: Option<Value> = sqlx::query_scalar(SET_PRICE_SQL)
                .bind(id)
                .bind(*pkn)
                .fetch_optional(&mut *tx)
                .await?;
            let Some(listing) = updated else {
                // The seller priced or sold it meanwhile: their price wins.
                tx.rollback().await?;
                bump(&mut summary, game, "skipped");
                continue;
            };
            let event = pokoin_commerce::listing_sync::event(
                &listing,
                &json!({
                    "game": game, "sellerUid": row["seller_uid"],
                    "mutation": "LISTING_PRICE_CHANGED",
                }),
                super::now_ms(),
            );
            pokoin_commerce::listing_sync::enqueue(&mut tx, event).await?;
            tx.commit().await?;
            bump(&mut summary, game, "repriced");
        }
    }
    println!("price fallback listings {summary}");
    Ok(())
}

/// The seller's own CardTrader commission, `None` for a seller with no
/// integration doc (the store's basis rate then prices the listing, as in
/// `job price-unpriced-listings`). Cached for the whole run.
async fn seller_channel(
    db: &DbPools,
    firestore: Option<&FirestoreRest>,
    cache: &mut HashMap<String, Option<Channel>>,
    seller: &str,
) -> Option<Channel> {
    if let Some(known) = cache.get(seller) {
        return *known;
    }
    let resolved = match firestore {
        Some(fs) => {
            match pokoin_external::cardtrader::integration::read_integration_doc(fs, seller).await {
                Ok(doc) if doc.exists => {
                    Some(pokoin_external::ct_fees::resolve_seller_channel(db, &doc.data).await)
                }
                _ => None,
            }
        }
        None => None,
    };
    cache.insert(seller.to_string(), resolved);
    resolved
}

/// Count one listing's outcome overall and inside its game.
fn bump(summary: &mut Value, game: &str, key: &str) {
    summary[key] = json!(summary[key].as_i64().unwrap_or(0) + 1);
    let entry = &mut summary["games"][game];
    entry[key] = json!(entry[key].as_i64().unwrap_or(0) + 1);
}

fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The client side of the parity, read from the web sources (repo root is
    /// five levels above this file).
    const SCAN_PRICING_JS: &str = include_str!("../../../../../market/src/scan-pricing.js");
    const PKN_JS: &str = include_str!("../../../../../market/src/pkn.js");

    #[test]
    fn the_select_only_takes_the_fallback_with_stock() {
        assert!(SELECT_SQL.contains("price_pkn = 2000000"));
        assert!(SELECT_SQL.contains("listing.status in ('active', 'paused')"));
        assert!(SELECT_SQL.contains("listing.quantity_available > 0"));
        assert!(SELECT_SQL.contains("listing.card_id ~ '^[0-9]+$'"));
        // Empty filters mean every seller and every game.
        assert!(SELECT_SQL.contains("($1::text = '' or listing.seller_uid = $1::text)"));
        assert!(SELECT_SQL.contains("($2::text = '' or coalesce(nullif(listing.marketplace_game, ''), 'pokemon') = $2::text)"));
    }

    #[test]
    fn the_write_compares_and_sets_on_the_fallback_and_never_touches_status() {
        assert!(SET_PRICE_SQL
            .contains("id = $1::uuid and price_pkn = 2000000 and quantity_available > 0"));
        assert!(
            !SET_PRICE_SQL.contains("status"),
            "a paused listing stays paused"
        );
    }

    #[test]
    fn the_fallback_is_the_scan_desk_parity() {
        assert!(SCAN_PRICING_JS.contains("SCAN_FALLBACK_PRICE_EUR = 10000"));
        assert!(PKN_JS.contains("PKN_USDT_PRICE = 0.005"));
        assert_eq!(10_000.0 / 0.005, SCAN_FALLBACK_PRICE_PKN);
        // The SQL literal is the number the client writes.
        assert!(SELECT_SQL.contains(&format!("price_pkn = {}", SCAN_FALLBACK_PRICE_PKN as i64)));
        assert!(SET_PRICE_SQL.contains(&format!("price_pkn = {}", SCAN_FALLBACK_PRICE_PKN as i64)));
    }

    #[test]
    fn the_summary_counts_every_candidate_of_its_game() {
        let mut summary =
            json!({ "priced": 0, "noOffer": 0, "repriced": 0, "skipped": 0, "games": {} });
        bump(&mut summary, "pokemon", "priced");
        bump(&mut summary, "pokemon", "repriced");
        bump(&mut summary, "riftbound", "noOffer");
        assert_eq!(summary["priced"], json!(1));
        assert_eq!(summary["games"]["pokemon"]["repriced"], json!(1));
        assert_eq!(summary["games"]["riftbound"]["noOffer"], json!(1));
        assert_eq!(
            summary["games"]["pokemon"]["noOffer"],
            Value::Null,
            "a game counts only what it had"
        );
    }

    #[test]
    fn csv_cells_quote_what_a_comma_or_a_quote_reaches() {
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("Pikachu \"V\""), "\"Pikachu \"\"V\"\"\"");
        assert_eq!(csv_cell("Charizard"), "Charizard");
    }

    #[test]
    fn the_timer_runs_the_job_an_hour_after_the_price_store_refill() {
        // No flag on the command line: the nightly run writes.
        let timer = include_str!(
            "../../../../../deploy/systemd/pokoin-rust-job-price-fallback-listings.timer"
        );
        assert!(timer.contains("OnCalendar=*-*-* 05:30:00 UTC"));
        assert!(timer.contains("Unit=pokoin-rust-job@price-fallback-listings.service"));
        assert!(!timer.contains("--dry-run"));
    }
}
