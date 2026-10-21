//! `job cardtrader-fee-once --seller=<uid> [--apply] [--csv=<path>]`
//!
//! Raises a connected seller's CardTrader asks that do not net their Pokoin
//! price after the seller's CardTrader commission. A Pokoin price is already
//! net of that commission; before 2026-10-21 the push listed it on CardTrader
//! unchanged, so CardTrader took its fee a second time (PeppeV's 1,440
//! Riftbound products: Spiderling 26 PKN at €0.13, which nets €0.1178). Each
//! such product is set to the smallest whole-cent ask that nets the Pokoin
//! price (`ct_fees::FeeRule::gross_cents`, `push::ct_ask_eur`).
//!
//! Never lowers an ask: a product whose ask already nets the Pokoin price
//! (every CardTrader import, priced from its own ask) is left alone, so a
//! rerun finds nothing to do. Only for sellers whose inventory link lets Pokoin
//! write to CardTrader (`pokoin_to_ct` or `both`); 1-Day Ready never. One
//! `/products/export` read, then `PUT /products/:id` at most 5 a second,
//! stopping at the first 429 (a rerun continues). A dry run unless `--apply`.
use super::Options;
use anyhow::{bail, Context, Result};
use pokoin_external::cardtrader::{integration, link, sync_core};
use pokoin_external::ct_fees;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const CT_MIN_INTERVAL: Duration = Duration::from_millis(200);

const LINKED_SQL: &str = r#"
  select listing.id::text as id, listing.card_name, listing.set_name, listing.collector_number,
         listing.condition, listing.language, listing.price_pkn::float8 as price_pkn,
         listing.source_listing_id, coalesce(nullif(listing.marketplace_game, ''), 'pokemon') as game
  from public.marketplace_user_listings as listing
  where listing.seller_uid = $1
    and listing.source_listing_id ~ '^ct:[0-9]+$'
    and listing.status = 'active'
    and listing.quantity_available > 0
    and listing.price_pkn > 0
  order by listing.price_pkn desc, listing.id
"#;

/// The ask to set, in cents, or `None` when the current ask already nets
/// the Pokoin price (never lowered).
pub fn raise_to(current_cents: i128, price_pkn: f64, rule: ct_fees::FeeRule, channel: ct_fees::Channel) -> Option<i128> {
    let price = price_pkn.round() as i128;
    if price < 1 {
        return None;
    }
    let rate = rule.rate_bps(channel);
    if current_cents > 0 && ct_fees::nets(current_cents, price, rate, rule.vat_bps, rule.min_fee_pkn) {
        return None;
    }
    let target = ct_fees::gross_cents(price, rate, rule.vat_bps, rule.min_fee_pkn);
    (target > current_cents).then_some(target)
}

pub(super) async fn run(options: &Options) -> Result<()> {
    let seller = options.seller.clone().context("--seller=<uid> is required")?;
    let state = pokoin_external::DomainState::from_env(2).await?;
    let doc = integration::read_integration_doc(state.firestore.as_ref(), &seller).await?;
    if let Some(reason) = link::edit_skip_reason(&doc) {
        bail!("Pokoin does not write this seller's CardTrader prices ({reason}); nothing to do.");
    }
    let channel = ct_fees::resolve_seller_channel(&state.db, &doc.data).await;
    let rule = ct_fees::rule();
    let token = integration::token_from_doc(&doc)?;
    let export = state.cardtrader.fetch_products_export(&token).await?;
    if export.unparsed_rows > 0 {
        bail!("the CardTrader export had {} rows it could not read; nothing changed", export.unparsed_rows);
    }
    // The export's ask of each product, in cents (PKN ÷ 2).
    let asks: HashMap<String, i128> = export
        .products
        .iter()
        .filter_map(|product| Some((sync_core::ct_source_listing_id(&product.id), (product.price_pkn? / 2.0).round() as i128)))
        .collect();
    let rows = state.db.query("pokemon", LINKED_SQL, &[json!(seller)]).await?;

    let mut summary = json!({
        "seller": seller, "apply": options.apply, "channel": rule.describe(channel), "linked": rows.len(),
        "notInExport": 0, "raise": 0, "alreadyNet": 0, "updated": 0, "failed": 0, "gone": 0,
        "stoppedBy": "done", "eurBefore": 0.0, "eurAfter": 0.0, "games": {}, "errors": [],
    });
    let bump = |summary: &mut Value, key: &str| summary[key] = json!(summary[key].as_i64().unwrap_or(0) + 1);
    let mut plans: Vec<(&Value, i128, i128)> = Vec::new();
    let (mut before, mut after) = (0i128, 0i128);
    // Identical copies share one product (cardtrader::group): one write each.
    let mut seen = std::collections::HashSet::new();
    for row in &rows {
        let source = row["source_listing_id"].as_str().unwrap_or("");
        if !seen.insert(source.to_string()) {
            bump(&mut summary, "sameProduct");
            continue;
        }
        let Some(current) = asks.get(source).copied() else {
            bump(&mut summary, "notInExport");
            continue;
        };
        let price = row["price_pkn"].as_f64().unwrap_or(0.0);
        match raise_to(current, price, rule, channel) {
            Some(target) => {
                bump(&mut summary, "raise");
                let game = row["game"].as_str().unwrap_or("pokemon").to_string();
                let entry = &mut summary["games"][game.as_str()];
                *entry = json!(entry.as_i64().unwrap_or(0) + 1);
                before += current;
                after += target;
                plans.push((row, current, target));
            }
            None => bump(&mut summary, "alreadyNet"),
        }
    }
    summary["eurBefore"] = json!(before as f64 / 100.0);
    summary["eurAfter"] = json!(after as f64 / 100.0);
    summary["sample"] = json!(plans
        .iter()
        .take(10)
        .map(|(row, current, target)| {
            let price = row["price_pkn"].as_f64().unwrap_or(0.0);
            json!({
                "card": row["card_name"], "number": row["collector_number"], "condition": row["condition"],
                "language": row["language"], "pokoinPkn": price, "askCents": current, "newAskCents": target,
                "worked": rule.breakdown(price, channel),
            })
        })
        .collect::<Vec<_>>());

    if let Some(path) = &options.csv {
        let mut out = String::from("listing_id,game,card_name,collector_number,condition,language,pokoin_pkn,ask_cents,new_ask_cents,source_listing_id\n");
        for (row, current, target) in &plans {
            let cell = |key: &str| match &row[key] {
                Value::String(text) if text.contains([',', '"', '\n']) => format!("\"{}\"", text.replace('"', "\"\"")),
                Value::String(text) => text.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            };
            out.push_str(&[
                cell("id"), cell("game"), cell("card_name"), cell("collector_number"), cell("condition"),
                cell("language"), cell("price_pkn"), current.to_string(), target.to_string(), cell("source_listing_id"),
            ].join(","));
            out.push('\n');
        }
        std::fs::write(path, out).with_context(|| format!("writing {path}"))?;
        summary["csv"] = json!(path);
    }

    if options.apply {
        for (row, _, target) in &plans {
            let started = Instant::now();
            let product = row["source_listing_id"].as_str().unwrap_or("").trim_start_matches("ct:");
            match state.cardtrader.update_product(&token, product, json!({ "price": *target as f64 / 100.0 })).await {
                Ok(_) => bump(&mut summary, "updated"),
                Err(error) if error.code.as_deref() == Some("cardtrader_http_404") => bump(&mut summary, "gone"),
                Err(error) if error.code.as_deref() == Some("cardtrader_http_429") => {
                    summary["stoppedBy"] = json!("rate_limited");
                    break;
                }
                Err(error) => {
                    bump(&mut summary, "failed");
                    if let Some(errors) = summary["errors"].as_array_mut() {
                        if errors.len() < 20 {
                            errors.push(json!({ "listingId": row["id"], "productId": product, "reason": error.message }));
                        }
                    }
                }
            }
            let spent = started.elapsed();
            if spent < CT_MIN_INTERVAL {
                tokio::time::sleep(CT_MIN_INTERVAL - spent).await;
            }
        }
    }
    println!("cardtrader fee once {summary}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ct_fees::Channel::{Direct, Zero};

    #[test]
    fn a_double_fee_ask_is_raised_and_a_netting_one_is_left_alone() {
        let rule = ct_fees::FeeRule::DEFAULT;
        // Spiderling: Pokoin 26 PKN, pushed at €0.13 (nets 23.56 PKN) → €0.14.
        assert_eq!(raise_to(13, 26.0, rule, Direct), Some(14));
        // Already €0.14: nets 25.56 → 26, nothing to do (a rerun changes nothing).
        assert_eq!(raise_to(14, 26.0, rule, Direct), None);
        // An import priced from its own €10.00 ask (Pokoin 1878 PKN direct): left alone.
        assert_eq!(raise_to(1000, 1878.0, rule, Direct), None);
        // A higher ask is never lowered.
        assert_eq!(raise_to(5000, 26.0, rule, Zero), None);
        assert_eq!(raise_to(0, 0.2, rule, Zero), None);
        assert!(LINKED_SQL.contains("'^ct:[0-9]+$'"), "never a pending claim");
    }
}
