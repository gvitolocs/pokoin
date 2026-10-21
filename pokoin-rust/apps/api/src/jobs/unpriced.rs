//! `job price-unpriced-listings --seller=<uid> [--game=<slug>] [--apply] [--csv=<path>]`
//!
//! Prices one seller's listings that are paused only because they have no
//! price (Card Rails lists a copy it could not quote as `paused` at 0 PKN) at
//! Pokoin's CardTrader reference price from the price store
//! (`facet_store::listing_price`), and puts them on sale. A listing with no
//! matching CardTrader offer stays paused at 0.
//!
//! A dry run unless `--apply`: it prints how many listings get a price and
//! the stock value, and `--csv` lists every listing with its new price. With
//! `--apply` each listing is set with a compare-and-set on "still paused at
//! 0 with stock" (a seller's own price or pause meanwhile wins) and queues
//! `LISTING_REACTIVATED` on the listing outbox (price summary, caches, seller
//! API events, Card Rails sees the price on its next pull). Repeating the run
//! changes nothing: an applied listing is no longer paused at 0.
//!
//! CardTrader is not called here. In link direction `pokoin_to_ct` or `both`
//! the seller reconcile lists the now active listings on CardTrader, once each
//! (docs/CARDTRADER_SELLER_SYNC.md).
use super::Options;
use anyhow::{Context, Result};
use pokoin_external::facet_store;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const UNPRICED_SQL: &str = r#"
  select listing.id::text as id, listing.card_id, listing.card_name, listing.set_name,
         listing.collector_number, listing.condition, listing.language, listing.foil_state,
         listing.reverse, listing.first_edition, listing.graded, listing.signed, listing.altered,
         listing.quantity_available, listing.location,
         coalesce(nullif(listing.marketplace_game, ''), 'pokemon') as marketplace_game
  from public.marketplace_user_listings as listing
  where listing.seller_uid = $1
    and listing.status = 'paused'
    and listing.price_pkn <= 0
    and listing.quantity_available > 0
    and listing.card_id ~ '^[0-9]+$'
    and ($2::text = '' or coalesce(nullif(listing.marketplace_game, ''), 'pokemon') = $2::text)
  order by listing.created_at, listing.id
"#;

/// Only a listing still paused at 0 with stock is priced and put on sale.
pub const ACTIVATE_SQL: &str = r#"
  update public.marketplace_user_listings
  set price_pkn = $2, status = 'active', updated_at = now()
  where id = $1::uuid and status = 'paused' and price_pkn <= 0 and quantity_available > 0
  returning to_jsonb(marketplace_user_listings) as listing
"#;

pub(super) async fn run(options: &Options) -> Result<()> {
    let seller = options.seller.clone().context("--seller=<uid> is required")?;
    // Only Postgres: no Firestore, no CardTrader.
    let db = pokoin_external::db::DbPools::from_env(2).await?;
    let game_filter = options.game.clone().unwrap_or_default();
    let rows = db.query("pokemon", UNPRICED_SQL, &[json!(seller), json!(game_filter)]).await?;

    let mut by_game: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for row in &rows {
        let game = row["marketplace_game"].as_str().unwrap_or("pokemon").to_string();
        if let Some(id) = row["card_id"].as_str().and_then(|id| id.parse::<i64>().ok()) {
            by_game.entry(game).or_default().push(id);
        }
    }
    let mut hits = BTreeMap::new();
    for (game, ids) in &mut by_game {
        ids.sort_unstable();
        ids.dedup();
        hits.insert(game.clone(), facet_store::lookup(&db, game, ids).await?);
    }

    let plans: Vec<(&Value, Option<f64>)> = rows
        .iter()
        .map(|row| {
            let game = row["marketplace_game"].as_str().unwrap_or("pokemon");
            let price = hits.get(game).and_then(Option::as_ref).and_then(|hit| facet_store::listing_price(hit, row));
            (row, price)
        })
        .collect();
    let mut summary = json!({
        "seller": seller, "apply": options.apply, "unpriced": plans.len(),
        "priced": 0, "noOffer": 0, "noStore": [], "eurStock": 0.0,
        "activated": 0, "skipped": 0, "games": {},
    });
    let no_store: Vec<&String> = hits.iter().filter(|(_, hit)| hit.is_none()).map(|(game, _)| game).collect();
    summary["noStore"] = json!(no_store);
    let mut eur = 0.0;
    for (row, price) in &plans {
        let game = row["marketplace_game"].as_str().unwrap_or("pokemon").to_string();
        let key = if price.is_some() { "priced" } else { "noOffer" };
        summary[key] = json!(summary[key].as_i64().unwrap_or(0) + 1);
        let entry = &mut summary["games"][&game];
        entry[key] = json!(entry[key].as_i64().unwrap_or(0) + 1);
        if let Some(pkn) = price {
            eur += pkn / 200.0 * row["quantity_available"].as_f64().unwrap_or(1.0).max(1.0);
        }
    }
    summary["eurStock"] = json!((eur * 100.0).round() / 100.0);

    if let Some(path) = &options.csv {
        let mut out = String::from("listing_id,game,card_id,card_name,set_name,collector_number,language,condition,foil_state,quantity,location,new_pkn,new_eur\n");
        for (row, price) in &plans {
            let cell = |key: &str| csv_cell(&match &row[key] {
                Value::String(text) => text.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            });
            let cells = [
                cell("id"), cell("marketplace_game"), cell("card_id"), cell("card_name"), cell("set_name"),
                cell("collector_number"), cell("language"), cell("condition"), cell("foil_state"),
                cell("quantity_available"), cell("location"),
                price.map(|pkn| pkn.to_string()).unwrap_or_default(),
                price.map(|pkn| format!("{:.2}", pkn / 200.0)).unwrap_or_default(),
            ];
            out.push_str(&cells.join(","));
            out.push('\n');
        }
        std::fs::write(path, out).with_context(|| format!("writing {path}"))?;
        summary["csv"] = json!(path);
    }

    if options.apply {
        let writer = db.writer()?;
        for (row, price) in &plans {
            let Some(pkn) = price else { continue };
            let id = row["id"].as_str().unwrap_or("");
            let mut tx = writer.begin().await?;
            let updated: Option<Value> =
                sqlx::query_scalar(ACTIVATE_SQL).bind(id).bind(*pkn).fetch_optional(&mut *tx).await?;
            let Some(listing) = updated else {
                tx.rollback().await?;
                summary["skipped"] = json!(summary["skipped"].as_i64().unwrap_or(0) + 1);
                continue;
            };
            let event = pokoin_commerce::listing_sync::event(
                &listing,
                &json!({
                    "game": row["marketplace_game"], "sellerUid": seller,
                    "mutation": "LISTING_REACTIVATED",
                }),
                super::now_ms(),
            );
            pokoin_commerce::listing_sync::enqueue(&mut tx, event).await?;
            tx.commit().await?;
            summary["activated"] = json!(summary["activated"].as_i64().unwrap_or(0) + 1);
        }
    }
    println!("price unpriced listings {summary}");
    Ok(())
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

    #[test]
    fn only_a_listing_still_paused_at_zero_is_activated() {
        // Compare-and-set: a seller's own price, pause or sale meanwhile wins,
        // and a second run finds nothing to do.
        assert!(ACTIVATE_SQL.contains("status = 'paused' and price_pkn <= 0 and quantity_available > 0"));
        assert!(UNPRICED_SQL.contains("listing.status = 'paused'") && UNPRICED_SQL.contains("price_pkn <= 0"));
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
    }
}
