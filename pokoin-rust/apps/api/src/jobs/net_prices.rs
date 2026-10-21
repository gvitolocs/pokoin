//! `job cardtrader-net-prices --seller=<uid> [--apply] [--csv=<path>]`
//!
//! Sets one connected seller's CardTrader-linked Pokoin listings (`ct:<product
//! id>`) to their CardTrader ask net of the commission the seller pays on it
//! (`ct_fees`: 7 % + VAT for a CardTrader Zero seller, 5 % + VAT otherwise;
//! `resolve_seller_channel` reads the Zero flag from the seller's own offers in the market book),
//! the price the reconcile now gives every import and link
//! (docs/PRICING.md "Net of CardTrader's commission").
//!
//! The ask comes from one complete `GET /products/export` (one CardTrader
//! read; nothing is written to CardTrader), never from the Pokoin price, so a
//! second run sets the same prices and changes nothing. A dry run unless
//! `--apply`; each listing is set with a compare-and-set on the price the plan
//! read and queues `LISTING_PRICE_CHANGED` on the listing outbox without a
//! CardTrader edit (caches, price summary, seller API events).
use super::Options;
use anyhow::{bail, Context, Result};
use pokoin_external::cardtrader::{integration, sync_core};
use pokoin_external::ct_fees;
use serde_json::{json, Value};
use std::collections::HashMap;

const LINKED_SQL: &str = r#"
  select listing.id::text as id, listing.card_name, listing.set_name, listing.collector_number,
         listing.condition, listing.language, listing.price_pkn::float8 as price_pkn,
         listing.quantity_available, listing.source_listing_id,
         coalesce(nullif(listing.marketplace_game, ''), 'pokemon') as game
  from public.marketplace_user_listings as listing
  where listing.seller_uid = $1
    and listing.source_listing_id ~ '^ct:[0-9]+$'
    and listing.status in ('active', 'paused')
    and listing.quantity_available > 0
  order by listing.price_pkn desc, listing.id
"#;

/// Compare-and-set on the price and the link the plan read.
pub const SET_PRICE_SQL: &str = r#"
  update public.marketplace_user_listings
  set price_pkn = $2, updated_at = now()
  where id = $1::uuid and price_pkn = $3 and source_listing_id = $4 and status in ('active', 'paused')
  returning to_jsonb(marketplace_user_listings) as listing
"#;

/// The price a linked listing should have: its product's ask net of the
/// commission, whole PKN. `None`: no product or no price in the export.
pub fn target_pkn(gross: Option<f64>, rule: ct_fees::FeeRule, channel: ct_fees::Channel) -> Option<f64> {
    gross.and_then(|pkn| rule.net_pkn(pkn, channel)).map(|net| net.round().max(1.0))
}

pub fn changes(current: f64, target: f64) -> bool {
    (current - target).abs() >= 0.5
}

pub(super) async fn run(options: &Options) -> Result<()> {
    let seller = options.seller.clone().context("--seller=<uid> is required")?;
    let state = pokoin_external::DomainState::from_env(2).await?;
    let doc = integration::read_integration_doc(state.firestore.as_ref(), &seller).await?;
    if integration::is_one_day_ready_integration(&doc) {
        bail!("1-Day Ready accounts are priced by CardTrader; nothing to do.");
    }
    let channel = ct_fees::resolve_seller_channel(&state.db, &doc.data).await;
    let rule = ct_fees::rule();
    let token = integration::decrypt_integration_token(state.firestore.as_ref(), &seller).await?;
    let export = state.cardtrader.fetch_products_export(&token).await?;
    if export.unparsed_rows > 0 {
        bail!("the CardTrader export had {} rows it could not read; nothing changed", export.unparsed_rows);
    }
    let asks: HashMap<String, Option<f64>> =
        export.products.iter().map(|product| (sync_core::ct_source_listing_id(&product.id), product.price_pkn)).collect();
    let rows = state.db.query("pokemon", LINKED_SQL, &[json!(seller)]).await?;

    let mut summary = json!({
        "seller": seller, "apply": options.apply, "channel": rule.describe(channel), "linked": rows.len(),
        "exported": export.products.len(), "notInExport": 0, "changes": 0, "unchanged": 0,
        "eurBefore": 0.0, "eurAfter": 0.0, "updated": 0, "skipped": 0, "games": {},
    });
    let bump = |summary: &mut Value, key: &str| summary[key] = json!(summary[key].as_i64().unwrap_or(0) + 1);
    let mut plans: Vec<(&Value, f64, f64)> = Vec::new();
    let (mut before, mut after) = (0.0, 0.0);
    for row in &rows {
        let source = row["source_listing_id"].as_str().unwrap_or("");
        let current = row["price_pkn"].as_f64().unwrap_or(0.0);
        let qty = row["quantity_available"].as_f64().unwrap_or(1.0).max(1.0);
        let Some(target) = asks.get(source).and_then(|gross| target_pkn(*gross, rule, channel)) else {
            bump(&mut summary, "notInExport");
            continue;
        };
        before += current * qty / 200.0;
        after += target * qty / 200.0;
        if changes(current, target) {
            bump(&mut summary, "changes");
            let game = row["game"].as_str().unwrap_or("pokemon").to_string();
            let entry = &mut summary["games"][game.as_str()];
            *entry = json!(entry.as_i64().unwrap_or(0) + 1);
            plans.push((row, current, target));
        } else {
            bump(&mut summary, "unchanged");
        }
    }
    summary["eurBefore"] = json!((before * 100.0).round() / 100.0);
    summary["eurAfter"] = json!((after * 100.0).round() / 100.0);
    summary["sample"] = json!(plans
        .iter()
        .take(10)
        .map(|(row, current, target)| json!({
            "card": row["card_name"], "set": row["set_name"], "number": row["collector_number"],
            "condition": row["condition"], "language": row["language"], "from": current, "to": target,
        }))
        .collect::<Vec<_>>());

    if let Some(path) = &options.csv {
        let mut out = String::from("listing_id,game,card_name,set_name,collector_number,condition,language,quantity,old_pkn,new_pkn,source_listing_id\n");
        for (row, current, target) in &plans {
            let cell = |key: &str| {
                let text = match &row[key] {
                    Value::String(text) => text.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                };
                if text.contains([',', '"', '\n']) { format!("\"{}\"", text.replace('"', "\"\"")) } else { text }
            };
            out.push_str(&[
                cell("id"), cell("game"), cell("card_name"), cell("set_name"), cell("collector_number"),
                cell("condition"), cell("language"), cell("quantity_available"),
                current.to_string(), target.to_string(), cell("source_listing_id"),
            ].join(","));
            out.push('\n');
        }
        std::fs::write(path, out).with_context(|| format!("writing {path}"))?;
        summary["csv"] = json!(path);
    }

    if options.apply {
        let writer = state.db.writer()?;
        for (row, current, target) in &plans {
            let mut tx = writer.begin().await?;
            let updated: Option<Value> = sqlx::query_scalar(SET_PRICE_SQL)
                .bind(row["id"].as_str().unwrap_or(""))
                .bind(*target)
                .bind(*current)
                .bind(row["source_listing_id"].as_str().unwrap_or(""))
                .fetch_optional(&mut *tx)
                .await?;
            let Some(listing) = updated else {
                tx.rollback().await?;
                bump(&mut summary, "skipped");
                continue;
            };
            let event = pokoin_commerce::listing_sync::event(
                &listing,
                &json!({ "game": row["game"], "sellerUid": seller, "mutation": "LISTING_PRICE_CHANGED" }),
                super::now_ms(),
            );
            pokoin_commerce::listing_sync::enqueue(&mut tx, event).await?;
            tx.commit().await?;
            bump(&mut summary, "updated");
        }
    }
    println!("cardtrader net prices {summary}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_target_comes_from_the_ask_so_a_rerun_changes_nothing() {
        let rule = ct_fees::FeeRule::DEFAULT;
        // €10.00 ask: Zero seller nets 1829 PKN, direct 1878.
        assert_eq!(target_pkn(Some(2000.0), rule, ct_fees::Channel::Zero), Some(1829.0));
        assert_eq!(target_pkn(Some(2000.0), rule, ct_fees::Channel::Direct), Some(1878.0));
        assert_eq!(target_pkn(None, rule, ct_fees::Channel::Zero), None);
        // First run: 2000 → 1829. A second run reads the same ask: no change.
        assert!(changes(2000.0, 1829.0));
        assert!(!changes(1829.0, target_pkn(Some(2000.0), rule, ct_fees::Channel::Zero).unwrap()));
        assert!(SET_PRICE_SQL.contains("price_pkn = $3 and source_listing_id = $4"), "compare-and-set on what the plan read");
        assert!(LINKED_SQL.contains("'^ct:[0-9]+$'"), "never a pending claim or another channel's source");
    }
}
