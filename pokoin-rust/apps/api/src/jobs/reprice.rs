//! `job cardtrader-pro-floor-reprice --seller=<uid> [--apply] [--csv=<path>]`
//!
//! Reprices one seller's active Pokémon listings to Pokoin's CardTrader
//! reference price net of CardTrader's commission (`ct_fees`; a linked
//! CardTrader product is set to the floor itself): the cheapest current offer of a professional CardTrader
//! seller of the same printing, condition, language, reverse and first
//! edition (`price_check::pro_floors`), leaving the seller's own CardTrader
//! offers out. A listing with no such offer keeps its price.
//!
//! A dry run unless `--apply`. With `--apply` a CardTrader-linked listing is
//! repriced on CardTrader first (`PUT /products/:id`, at most 5 a second,
//! stopping at a 429), then on Pokoin through the listing outbox
//! (`LISTING_PRICE_CHANGED`: price summary, caches, seller API events). A
//! listing whose CardTrader update failed keeps its Pokoin price, so a rerun
//! picks it up. `--csv` writes every listing's old and new price, the list a
//! Cardmarket update works from.
use super::Options;
use anyhow::{bail, Context, Result};
use pokoin_external::cardtrader::integration;
use pokoin_external::price_check::{condition_key, pick_matched_ct, pro_floors};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// PKN per euro (1 PKN = €0.005).
const PKN_PER_EUR: f64 = 200.0;
const CT_MIN_INTERVAL: Duration = Duration::from_millis(200);

const LISTINGS_SQL: &str = r#"
  select listing.id::text as id, listing.card_id, listing.card_name, listing.set_name,
         listing.collector_number, listing.condition, listing.language,
         coalesce(listing.reverse, false) or lower(coalesce(listing.foil_state, '')) = 'reverse' as reverse,
         coalesce(listing.first_edition, false) as first_edition,
         listing.price_pkn::float8 as price_pkn, listing.quantity_available,
         coalesce(listing.source_listing_id, '') as source_listing_id
  from public.marketplace_user_listings as listing
  where listing.seller_uid = $1
    and listing.status = 'active'
    and listing.quantity_available > 0
    and coalesce(nullif(listing.marketplace_game, ''), 'pokemon') = 'pokemon'
    and listing.card_id ~ '^[0-9]+$'
  order by listing.card_name, listing.id
"#;

/// Compare-and-set on the price the plan read, so a seller's own edit in the
/// meantime wins.
const SET_PRICE_SQL: &str = r#"
  update public.marketplace_user_listings
  set price_pkn = $2, updated_at = now()
  where id = $1::uuid and price_pkn = $3 and status = 'active'
  returning to_jsonb(marketplace_user_listings) as listing
"#;

/// One listing's plan.
#[derive(Debug, Clone, PartialEq)]
pub struct Repricing {
    pub id: String,
    pub old_pkn: f64,
    /// `None`: no professional offer of the same printing and facets.
    pub new_pkn: Option<f64>,
    /// The professional floor itself (the CardTrader ask), whole PKN: the
    /// price a linked CardTrader product is set to. `new_pkn` is that ask net
    /// of CardTrader's commission (`ct_fees`), what the seller nets there.
    pub ct_pkn: Option<f64>,
}

impl Repricing {
    pub fn changes(&self) -> bool {
        self.new_pkn.is_some_and(|new| (new - self.old_pkn).abs() >= 0.5)
    }
}

/// The new price of one listing row against its blueprint's pro-floor groups:
/// whole PKN (prices are shown as digits only), at least 1.
pub fn plan_row(row: &Value, groups: &[Value]) -> Repricing {
    let condition = condition_key(row["condition"].as_str().unwrap_or("NM"));
    let language = row["language"].as_str().unwrap_or("").trim().to_uppercase();
    let (_, matched) = pick_matched_ct(
        groups,
        if condition.is_empty() { "NM" } else { &condition },
        &language,
        row["reverse"] == true,
        row["first_edition"] == true,
    );
    let rule = pokoin_external::ct_fees::rule();
    Repricing {
        id: row["id"].as_str().unwrap_or("").to_string(),
        old_pkn: row["price_pkn"].as_f64().unwrap_or(0.0),
        new_pkn: matched
            .and_then(|pkn| rule.net_pkn(pkn, pokoin_external::ct_fees::Channel::Direct))
            .map(|pkn| pkn.round().max(1.0)),
        ct_pkn: matched.map(|pkn| pkn.round().max(1.0)),
    }
}

fn eur(pkn: f64) -> f64 {
    (pkn / PKN_PER_EUR * 100.0).round() / 100.0
}

/// `ct:<digits>` → the CardTrader product id.
fn ct_product_id(source: &str) -> Option<&str> {
    source
        .strip_prefix("ct:")
        .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
}

fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

pub(super) async fn run(options: &Options) -> Result<()> {
    let seller = options.seller.clone().context("--seller=<uid> is required")?;
    let state = pokoin_external::DomainState::from_env(2).await?;
    let doc = integration::read_integration_doc(state.firestore.as_ref(), &seller).await?;
    if integration::is_one_day_ready_integration(&doc) {
        bail!("1-Day Ready accounts are priced by CardTrader; nothing to reprice.");
    }
    // The seller's own CardTrader offers never set their own floor.
    let own_ct_seller: Vec<String> = doc
        .data
        .pointer("/metadata/user/id")
        .map(|id| match id {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .filter(|id| !id.is_empty() && id != "null")
        .into_iter()
        .collect();

    let rows = state.db.query("pokemon", LISTINGS_SQL, &[json!(seller)]).await?;
    let mut card_ids: Vec<i64> = rows.iter().filter_map(|row| row["card_id"].as_str()?.parse().ok()).collect();
    card_ids.sort_unstable();
    card_ids.dedup();
    let mapping = state
        .db
        .query(
            "pokemon",
            "select card_id::text as card_id, ct_id::text as ct_id from public.marketplace_search_candidates where card_id = any($1::bigint[]) and ct_id is not null",
            &[json!(card_ids)],
        )
        .await?;
    let ct_by_card: HashMap<String, i64> = mapping
        .iter()
        // int8 cells arrive as strings from the shared row decoder.
        .filter_map(|row| Some((row["card_id"].as_str()?.to_string(), row["ct_id"].as_str()?.trim().parse::<i64>().ok()?)))
        .collect();
    let mut ct_ids: Vec<i64> = ct_by_card.values().copied().collect();
    ct_ids.sort_unstable();
    ct_ids.dedup();
    let floors = pro_floors(&state.db, &ct_ids, &own_ct_seller).await?;

    let plans: Vec<(Value, Repricing)> = rows
        .into_iter()
        .map(|row| {
            let groups = row["card_id"]
                .as_str()
                .and_then(|card_id| ct_by_card.get(card_id))
                .and_then(|ct_id| floors.get(&ct_id.to_string()))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let plan = plan_row(&row, &groups);
            (row, plan)
        })
        .collect();

    let mut summary = json!({
        "seller": seller, "apply": options.apply, "listings": plans.len(),
        "withProOffer": 0, "noProOffer": 0, "changes": 0, "up": 0, "down": 0,
        "eurBefore": 0.0, "eurAfter": 0.0,
        "ctUpdated": 0, "ctFailed": 0, "ctGone": 0, "pokoinUpdated": 0, "pokoinSkipped": 0,
        "stoppedBy": "done", "errors": [],
    });
    let bump = |summary: &mut Value, key: &str| summary[key] = json!(summary[key].as_i64().unwrap_or(0) + 1);
    let mut eur_before = 0.0;
    let mut eur_after = 0.0;
    for (row, plan) in &plans {
        let quantity = row["quantity_available"].as_f64().unwrap_or(1.0).max(1.0);
        eur_before += eur(plan.old_pkn) * quantity;
        eur_after += eur(plan.new_pkn.unwrap_or(plan.old_pkn)) * quantity;
        match plan.new_pkn {
            None => bump(&mut summary, "noProOffer"),
            Some(new) => {
                bump(&mut summary, "withProOffer");
                if plan.changes() {
                    bump(&mut summary, "changes");
                    bump(&mut summary, if new > plan.old_pkn { "up" } else { "down" });
                }
            }
        }
    }
    summary["eurBefore"] = json!((eur_before * 100.0).round() / 100.0);
    summary["eurAfter"] = json!((eur_after * 100.0).round() / 100.0);

    if let Some(path) = &options.csv {
        let mut out = String::from(
            "listing_id,card_name,set_name,collector_number,language,condition,reverse,first_edition,quantity,old_pkn,new_pkn,old_eur,new_eur,cardtrader_product_id,status\n",
        );
        for (row, plan) in &plans {
            let status = match plan.new_pkn {
                None => "no_pro_offer",
                Some(_) if plan.changes() => "changed",
                Some(_) => "unchanged",
            };
            let new_pkn = plan.new_pkn.unwrap_or(plan.old_pkn);
            let cells = [
                plan.id.clone(),
                csv_cell(row["card_name"].as_str().unwrap_or("")),
                csv_cell(row["set_name"].as_str().unwrap_or("")),
                csv_cell(row["collector_number"].as_str().unwrap_or("")),
                csv_cell(row["language"].as_str().unwrap_or("")),
                csv_cell(row["condition"].as_str().unwrap_or("")),
                (row["reverse"] == true).to_string(),
                (row["first_edition"] == true).to_string(),
                row["quantity_available"].to_string(),
                format!("{}", plan.old_pkn),
                format!("{new_pkn}"),
                format!("{:.2}", eur(plan.old_pkn)),
                format!("{:.2}", eur(new_pkn)),
                ct_product_id(row["source_listing_id"].as_str().unwrap_or("")).unwrap_or("").to_string(),
                status.to_string(),
            ];
            out.push_str(&cells.join(","));
            out.push('\n');
        }
        std::fs::write(path, out).with_context(|| format!("writing {path}"))?;
        summary["csv"] = json!(path);
    }

    if options.apply {
        apply(&state, &seller, &plans, &mut summary).await?;
    }
    println!("cardtrader pro-floor reprice {summary}");
    Ok(())
}

async fn apply(
    state: &pokoin_external::DomainState,
    seller: &str,
    plans: &[(Value, Repricing)],
    summary: &mut Value,
) -> Result<()> {
    let bump = |summary: &mut Value, key: &str| summary[key] = json!(summary[key].as_i64().unwrap_or(0) + 1);
    let note = |summary: &mut Value, item: Value| {
        if let Some(items) = summary["errors"].as_array_mut() {
            if items.len() < 20 {
                items.push(item);
            }
        }
    };
    let token = if plans.iter().any(|(row, plan)| plan.changes() && ct_product_id(row["source_listing_id"].as_str().unwrap_or("")).is_some()) {
        Some(integration::decrypt_integration_token(state.firestore.as_ref(), seller).await?)
    } else {
        None
    };
    let writer = state.db.writer()?;
    let mut cards: HashSet<String> = HashSet::new();
    // Identical copies share one product (cardtrader::group) and get the same
    // floor: CardTrader is written once per product.
    let mut written: HashSet<String> = HashSet::new();
    for (row, plan) in plans.iter().filter(|(_, plan)| plan.changes()) {
        let Some(new_pkn) = plan.new_pkn else { continue };
        let source = row["source_listing_id"].as_str().unwrap_or("");
        let first_write = ct_product_id(source).is_some_and(|product_id| written.insert(product_id.to_string()));
        if let (Some(product_id), Some(token), true) = (ct_product_id(source), token.as_deref(), first_write) {
            let started = Instant::now();
            // CardTrader keeps the floor itself; only Pokoin takes the net price.
            match state.cardtrader.update_product(token, product_id, json!({ "price": eur(plan.ct_pkn.unwrap_or(new_pkn)) })).await {
                Ok(_) => bump(summary, "ctUpdated"),
                // Gone from CardTrader: the reconcile settles the link; the
                // Pokoin price still follows the rule.
                Err(error) if error.code.as_deref() == Some("cardtrader_http_404") => bump(summary, "ctGone"),
                Err(error) if error.code.as_deref() == Some("cardtrader_http_429") => {
                    summary["stoppedBy"] = json!("rate_limited");
                    break;
                }
                Err(error) => {
                    bump(summary, "ctFailed");
                    note(summary, json!({ "listingId": plan.id, "ctProductId": product_id, "reason": error.message }));
                    continue;
                }
            }
            let spent = started.elapsed();
            if spent < CT_MIN_INTERVAL {
                tokio::time::sleep(CT_MIN_INTERVAL - spent).await;
            }
        }
        let mut tx = writer.begin().await?;
        let updated: Option<Value> = sqlx::query_scalar(SET_PRICE_SQL)
            .bind(&plan.id)
            .bind(new_pkn)
            .bind(plan.old_pkn)
            .fetch_optional(&mut *tx)
            .await?;
        let Some(listing) = updated else {
            // The seller changed it meanwhile: their price wins.
            tx.rollback().await?;
            bump(summary, "pokoinSkipped");
            continue;
        };
        let event = pokoin_commerce::listing_sync::event(
            &listing,
            &json!({ "game": "pokemon", "sellerUid": seller, "mutation": "LISTING_PRICE_CHANGED" }),
            super::now_ms(),
        );
        pokoin_commerce::listing_sync::enqueue(&mut tx, event).await?;
        tx.commit().await?;
        cards.insert(row["card_id"].as_str().unwrap_or("").to_string());
        bump(summary, "pokoinUpdated");
    }
    summary["cards"] = json!(cards.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn groups() -> Vec<Value> {
        vec![
            json!({"condition": "NM", "language": "IT", "reverse": false, "firstEdition": false, "minPkn": 22.0}),
            json!({"condition": "SP", "language": "IT", "reverse": false, "firstEdition": false, "minPkn": 24.4}),
            json!({"condition": "NM", "language": "IT", "reverse": true, "firstEdition": false, "minPkn": 618.0}),
        ]
    }

    #[test]
    fn a_listing_takes_the_pro_floor_of_its_own_facets() {
        let plain = json!({"id": "a", "condition": "NM", "language": "IT", "reverse": false, "first_edition": false, "price_pkn": 118.0});
        let plan = plan_row(&plain, &groups());
        // The €0.11 floor nets €0.0978 after the 1-cent minimum commission + VAT.
        assert_eq!((plan.new_pkn, plan.ct_pkn), (Some(20.0), Some(22.0)));
        assert!(plan.changes());
        let reverse = json!({"id": "b", "condition": "NM", "language": "IT", "reverse": true, "first_edition": false, "price_pkn": 40.0});
        // €3.09 less 5 % (15.45 c) and its VAT: €2.9015.
        let plan = plan_row(&reverse, &groups());
        assert_eq!((plan.new_pkn, plan.ct_pkn), (Some(580.0), Some(618.0)));
        // Pokoin LP is CardTrader Slightly Played; rounded to whole PKN.
        let lp = json!({"id": "c", "condition": "LP", "language": "IT", "reverse": false, "first_edition": false, "price_pkn": 22.0});
        let plan = plan_row(&lp, &groups());
        assert_eq!(plan.new_pkn, Some(22.0));
        assert!(!plan.changes());
    }

    #[test]
    fn no_professional_offer_keeps_the_price() {
        let row = json!({"id": "d", "condition": "MP", "language": "IT", "reverse": false, "first_edition": false, "price_pkn": 50.0});
        let plan = plan_row(&row, &groups());
        assert_eq!(plan.new_pkn, None);
        assert!(!plan.changes());
        let first = json!({"id": "e", "condition": "NM", "language": "IT", "reverse": false, "first_edition": true, "price_pkn": 50.0});
        assert_eq!(plan_row(&first, &groups()).new_pkn, None, "a first edition never takes the unlimited floor");
    }

    #[test]
    fn helpers() {
        assert_eq!(eur(22.0), 0.11);
        assert_eq!(eur(8520.0), 42.6);
        assert_eq!(ct_product_id("ct:460787033"), Some("460787033"));
        assert_eq!(ct_product_id("ct:pending:link-1"), None);
        assert_eq!(ct_product_id("scan:abc"), None);
        assert_eq!(csv_cell("Pikachu, \"V\""), "\"Pikachu, \"\"V\"\"\"");
    }
}
