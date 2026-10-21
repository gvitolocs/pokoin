//! `job cardtrader-group-products --seller=<uid> [--apply] [--csv=<path>] [--log=<path>]`
//!
//! Folds a seller's identical CardTrader products into one (2026-10-21).
//! Until then every Pokoin listing became its own CardTrader product, so
//! Card Rails' 1× postings of one card stood on CardTrader as dozens of
//! "1 of 1" rows (PeppeV's Spiderling: one product per copy). Products with
//! the same blueprint, condition, language, finishes and ask that Pokoin made
//! or linked (`pokoin:` user data field, or a push/match link row) are folded
//! into the one with the most copies; hand-made products are never touched
//! (`cardtrader::group::plan_consolidation`).
//!
//! Per group, in this order, under the seller's reconcile lock:
//! 1. a `begin` line in the journal (`--log`, JSON lines: every product id,
//!    its copies, ask and characteristics, and the listings moved: enough to
//!    undo it);
//! 2. Pokoin: the deleted products' listings move to the kept product and
//!    their link rows go (one transaction);
//! 3. CardTrader: each deleted product is removed, then the kept product gains
//!    their copies (`POST /products/:id/increment`), so CardTrader never lists
//!    more copies than the seller has;
//! 4. an `end` line.
//!
//! A group whose CardTrader copies differ from its Pokoin copies is skipped
//! and reported (the reconcile settles it first). The run stops at any
//! CardTrader error or 429; a rerun first finishes a group the journal shows
//! begun and not ended (deletes what is still there, then raises the kept
//! product to its members' copies). At most 5 CardTrader writes a second.
//! A dry run unless `--apply`; the dry run needs no lock and writes nothing.
use super::Options;
use anyhow::{bail, Context, Result};
use pokoin_external::cardtrader::group::{self, LinkedListing, Merge};
use pokoin_external::cardtrader::{integration, link, sync_core};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::time::{Duration, Instant};

const CT_MIN_INTERVAL: Duration = Duration::from_millis(200);
const LOCK_SECONDS: u64 = 900;

const LINKED_SQL: &str = r#"
  select id::text as id, source_listing_id, quantity_available, status
  from public.marketplace_user_listings
  where seller_uid = $1 and source_listing_id ~ '^ct:[0-9]+$' and status in ('active', 'paused')
"#;

const OURS_SQL: &str = r#"
  select ct_product_id from public.marketplace_cardtrader_product_links
  where seller_uid = $1 and origin in ('push', 'match')
"#;

const RELINK_SQL: &str = r#"
  update public.marketplace_user_listings
  set source_listing_id = $3, updated_at = now()
  where seller_uid = $1 and source_listing_id = any($2::text[])
  returning id::text as id
"#;

const DROP_LINKS_SQL: &str = r#"
  delete from public.marketplace_cardtrader_product_links
  where seller_uid = $1 and ct_product_id = any($2::text[])
"#;

const MEMBERS_COPIES_SQL: &str = r#"
  select coalesce(sum(quantity_available), 0)::bigint as copies from public.marketplace_user_listings
  where seller_uid = $1 and source_listing_id = $2 and status in ('active', 'paused')
"#;

fn arg(prefix: &str) -> Option<String> {
    std::env::args().find_map(|a| a.strip_prefix(prefix).map(|v| v.trim().to_string())).filter(|v| !v.is_empty())
}

fn product_json(product: &sync_core::NormalizedProduct) -> Value {
    json!({
        "id": product.id, "blueprintId": product.blueprint_id, "name": product.name, "quantity": product.quantity,
        "askCents": product.price_pkn.map(|p| (p / 2.0).round() as i64), "condition": product.condition,
        "language": product.language, "reverse": product.reverse, "firstEdition": product.first_edition,
        "signed": product.signed, "altered": product.altered, "graded": product.graded,
        "userDataField": product.user_data_field, "expansion": product.expansion_name, "number": product.collector_number,
    })
}

struct Journal(Option<std::fs::File>);

impl Journal {
    fn line(&mut self, value: Value) -> Result<()> {
        if let Some(file) = self.0.as_mut() {
            writeln!(file, "{value}")?;
            file.sync_data()?;
        }
        Ok(())
    }
}

/// Groups a journal shows begun and not ended.
fn unfinished(path: &str) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let mut open: Vec<(String, Value)> = Vec::new();
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        let key = format!("{}", entry["keep"]);
        match entry["step"].as_str() {
            Some("begin") => open.push((key, entry)),
            Some("end") => open.retain(|(open_key, _)| *open_key != key),
            _ => {}
        }
    }
    open.into_iter().map(|(_, entry)| entry).collect()
}

struct Lock {
    redis: redis::aio::ConnectionManager,
    key: String,
    owner: String,
}

impl Lock {
    async fn acquire(seller: &str) -> Result<Self> {
        let mut redis = super::redis_connection().await.context("the reconcile lock needs Redis")?;
        let key = pokoin_external::redis::lock_key("ct-reconcile", seller);
        let owner = format!("group-products-{}", std::process::id());
        let set: Option<String> = redis::cmd("SET").arg(&key).arg(&owner).arg("NX").arg("EX").arg(LOCK_SECONDS).query_async(&mut redis).await?;
        if set.is_none() {
            bail!("a CardTrader reconcile of this seller is running; try again in a few minutes");
        }
        Ok(Self { redis, key, owner })
    }

    /// Keep the lock while the run is still ours.
    async fn renew(&mut self) -> Result<()> {
        let script = redis::Script::new(r#"if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end"#);
        let kept: i64 = script.key(&self.key).arg(&self.owner).arg(LOCK_SECONDS).invoke_async(&mut self.redis).await?;
        if kept != 1 {
            bail!("lost the reconcile lock; stopping");
        }
        Ok(())
    }

    async fn release(mut self) {
        let script = redis::Script::new(r#"if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end"#);
        let _: Result<i64, _> = script.key(&self.key).arg(&self.owner).invoke_async(&mut self.redis).await;
    }
}

async fn paced<T>(future: impl std::future::Future<Output = T>) -> T {
    let started = Instant::now();
    let out = future.await;
    let spent = started.elapsed();
    if spent < CT_MIN_INTERVAL {
        tokio::time::sleep(CT_MIN_INTERVAL - spent).await;
    }
    out
}

fn gone(error: &pokoin_external::ApiError) -> bool {
    error.code.as_deref() == Some("cardtrader_http_404")
}

pub(super) async fn run(options: &Options) -> Result<()> {
    let seller = options.seller.clone().context("--seller=<uid> is required")?;
    let state = pokoin_external::DomainState::from_env(2).await?;
    let doc = integration::read_integration_doc(state.firestore.as_ref(), &seller).await?;
    if !doc.exists || doc.data["enabled"] != true {
        bail!("seller {seller} has no connected CardTrader account");
    }
    if let Some(reason) = link::edit_skip_reason(&doc) {
        bail!("Pokoin does not write this seller's CardTrader products ({reason}); nothing to do.");
    }
    let token = integration::token_from_doc(&doc)?;
    let journal_path = arg("--log=").unwrap_or_else(|| format!("/var/tmp/pokoin-ct-group-products-{seller}.jsonl"));
    let mut lock = if options.apply { Some(Lock::acquire(&seller).await?) } else { None };
    let result = consolidate(&state, &seller, &token, options, &journal_path, lock.as_mut()).await;
    if let Some(lock) = lock {
        lock.release().await;
    }
    result
}

async fn consolidate(
    state: &pokoin_external::DomainState,
    seller: &str,
    token: &str,
    options: &Options,
    journal_path: &str,
    mut lock: Option<&mut Lock>,
) -> Result<()> {
    let ct = &state.cardtrader;
    let mut journal = Journal(if options.apply {
        Some(std::fs::OpenOptions::new().create(true).append(true).open(journal_path).with_context(|| format!("opening {journal_path}"))?)
    } else {
        None
    });
    let mut summary = json!({
        "seller": seller, "apply": options.apply, "journal": if options.apply { json!(journal_path) } else { Value::Null },
        "resumed": 0, "groups": 0, "productsInGroups": 0, "toDelete": 0, "deleted": 0, "incremented": 0,
        "relinked": 0, "mismatched": [], "stoppedBy": "done", "errors": [],
    });

    // A run that stopped between the steps of a group finishes it first.
    if options.apply {
        for entry in unfinished(journal_path) {
            let keep = entry["keep"].as_str().unwrap_or("").to_string();
            let delete: Vec<String> = entry["delete"].as_array().into_iter().flatten().filter_map(|p| p["id"].as_str().map(String::from)).collect();
            let export = ct.fetch_products_export(token).await?;
            let present: HashMap<&str, i64> = export.products.iter().map(|p| (p.id.as_str(), p.quantity)).collect();
            for id in delete.iter().filter(|id| present.contains_key(id.as_str())) {
                match paced(ct.destroy_product(token, id)).await {
                    Ok(_) => journal.line(json!({"step": "delete", "keep": keep, "product": id}))?,
                    Err(error) if gone(&error) => {}
                    Err(error) => bail!("resuming {keep}: deleting {id}: {}", error.message),
                }
            }
            let members: i64 = state
                .db
                .query("pokemon", MEMBERS_COPIES_SQL, &[json!(seller), json!(sync_core::ct_source_listing_id(&keep))])
                .await?
                .first()
                .and_then(|row| row["copies"].as_i64())
                .unwrap_or(0);
            let on_ct = present.get(keep.as_str()).copied().unwrap_or(0);
            if members > on_ct && present.contains_key(keep.as_str()) {
                paced(ct.increment_product(token, &keep, members - on_ct)).await.map_err(|e| anyhow::anyhow!("resuming {keep}: {}", e.message))?;
                journal.line(json!({"step": "increment", "keep": keep, "delta": members - on_ct}))?;
            }
            journal.line(json!({"step": "end", "keep": keep, "resumed": true}))?;
            summary["resumed"] = json!(summary["resumed"].as_i64().unwrap_or(0) + 1);
        }
    }

    let export = ct.fetch_products_export(token).await?;
    if export.unparsed_rows > 0 {
        bail!("the CardTrader export had {} rows it could not read; nothing changed", export.unparsed_rows);
    }
    let ours: HashSet<String> = state
        .db
        .query("pokemon", OURS_SQL, &[json!(seller)])
        .await?
        .iter()
        .filter_map(|row| row["ct_product_id"].as_str().map(String::from))
        .collect();
    let listings: Vec<LinkedListing> = state
        .db
        .query("pokemon", LINKED_SQL, &[json!(seller)])
        .await?
        .iter()
        .map(|row| LinkedListing {
            id: row["id"].as_str().unwrap_or("").to_string(),
            product_id: sync_core::parse_ct_product_id(row["source_listing_id"].as_str().unwrap_or("")),
            quantity: row["quantity_available"].as_i64().unwrap_or(0),
            status: row["status"].as_str().unwrap_or("").to_string(),
        })
        .collect();
    let (merges, mismatched) = group::plan_consolidation(&export.products, &ours, &listings);
    let by_id: HashMap<&str, &sync_core::NormalizedProduct> = export.products.iter().map(|p| (p.id.as_str(), p)).collect();

    let products_before = export.products.len();
    let to_delete: usize = merges.iter().map(|m| m.delete.len()).sum();
    summary["productsBefore"] = json!(products_before);
    summary["productsAfter"] = json!(products_before - to_delete);
    summary["groups"] = json!(merges.len());
    summary["productsInGroups"] = json!(merges.iter().map(|m| m.delete.len() + 1).sum::<usize>());
    summary["toDelete"] = json!(to_delete);
    summary["copiesInGroups"] = json!(merges.iter().map(|m| m.total).sum::<i64>());
    summary["copiesAfter"] = json!(merges.iter().map(|m| m.keep_quantity + m.increment()).sum::<i64>());
    summary["mismatched"] = json!(mismatched);
    let mut largest: Vec<&Merge> = merges.iter().collect();
    largest.sort_by(|a, b| b.delete.len().cmp(&a.delete.len()).then(a.keep.cmp(&b.keep)));
    summary["sample"] = json!(largest
        .iter()
        .take(10)
        .map(|m| {
            let kept = by_id.get(m.keep.as_str());
            json!({
                "card": kept.map(|p| p.name.clone()), "number": kept.map(|p| p.collector_number.clone()),
                "askCents": kept.and_then(|p| p.price_pkn).map(|p| (p / 2.0).round() as i64),
                "products": m.delete.len() + 1, "keep": m.keep, "copiesBefore": m.total,
                "copiesAfter": m.keep_quantity + m.increment(), "pokoinCopies": m.pokoin_total,
            })
        })
        .collect::<Vec<_>>());

    if let Some(path) = &options.csv {
        let mut out = String::from("keep_product,delete_products,card,number,ask_cents,products,copies_before,copies_after,pokoin_copies\n");
        for m in &merges {
            let kept = by_id.get(m.keep.as_str());
            let name = kept.map(|p| p.name.replace('"', "\"\"")).unwrap_or_default();
            out.push_str(&format!(
                "{},{},\"{}\",{},{},{},{},{},{}\n",
                m.keep,
                m.delete.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>().join(" "),
                name,
                kept.map(|p| p.collector_number.clone()).unwrap_or_default(),
                kept.and_then(|p| p.price_pkn).map(|p| ((p / 2.0).round() as i64).to_string()).unwrap_or_default(),
                m.delete.len() + 1,
                m.total,
                m.keep_quantity + m.increment(),
                m.pokoin_total,
            ));
        }
        std::fs::write(path, out).with_context(|| format!("writing {path}"))?;
        summary["csv"] = json!(path);
    }

    if options.apply {
        let writer = state.db.writer()?;
        'groups: for merge in &merges {
            if merge.keep_quantity + merge.increment() != merge.total {
                summary["stoppedBy"] = json!("mismatch");
                break;
            }
            if let Some(lock) = lock.as_deref_mut() {
                lock.renew().await?;
            }
            journal.line(json!({
                "step": "begin", "at": pokoin_external::time_util::iso_from_ms(pokoin_external::time_util::now_ms()),
                "keep": merge.keep, "keepProduct": by_id.get(merge.keep.as_str()).map(|p| product_json(p)),
                "delete": merge.delete.iter().map(|(id, _)| by_id.get(id.as_str()).map(|p| product_json(p)).unwrap_or(json!({"id": id}))).collect::<Vec<_>>(),
                "relink": merge.relink, "copies": merge.total,
            }))?;
            let sources: Vec<String> = merge.delete.iter().map(|(id, _)| sync_core::ct_source_listing_id(id)).collect();
            let deleted: Vec<String> = merge.delete.iter().map(|(id, _)| id.clone()).collect();
            let mut tx = writer.begin().await?;
            let moved: Vec<String> = sqlx::query_scalar(RELINK_SQL)
                .bind(seller)
                .bind(&sources)
                .bind(sync_core::ct_source_listing_id(&merge.keep))
                .fetch_all(&mut *tx)
                .await?;
            sqlx::query(DROP_LINKS_SQL).bind(seller).bind(&deleted).execute(&mut *tx).await?;
            tx.commit().await?;
            summary["relinked"] = json!(summary["relinked"].as_i64().unwrap_or(0) + moved.len() as i64);
            journal.line(json!({"step": "relink", "keep": merge.keep, "listings": moved}))?;
            let mut removed = 0;
            for (id, quantity) in &merge.delete {
                match paced(ct.destroy_product(token, id)).await {
                    Ok(_) => {}
                    Err(error) if gone(&error) => {}
                    Err(error) => {
                        summary["stoppedBy"] = json!(if error.code.as_deref() == Some("cardtrader_http_429") { "rate_limited" } else { "error" });
                        summary["errors"].as_array_mut().unwrap().push(json!({"keep": merge.keep, "delete": id, "reason": error.message}));
                        // The kept product still gains the copies already taken off.
                        if removed > 0 {
                            if paced(ct.increment_product(token, &merge.keep, removed)).await.is_ok() {
                                journal.line(json!({"step": "increment", "keep": merge.keep, "delta": removed}))?;
                            }
                        }
                        break 'groups;
                    }
                }
                removed += quantity;
                journal.line(json!({"step": "delete", "keep": merge.keep, "product": id, "copies": quantity}))?;
                summary["deleted"] = json!(summary["deleted"].as_i64().unwrap_or(0) + 1);
            }
            if removed > 0 {
                if let Err(error) = paced(ct.increment_product(token, &merge.keep, removed)).await {
                    summary["stoppedBy"] = json!("error");
                    summary["errors"].as_array_mut().unwrap().push(json!({"keep": merge.keep, "increment": removed, "reason": error.message}));
                    break;
                }
                journal.line(json!({"step": "increment", "keep": merge.keep, "delta": removed}))?;
                summary["incremented"] = json!(summary["incremented"].as_i64().unwrap_or(0) + 1);
            }
            journal.line(json!({"step": "end", "keep": merge.keep}))?;
        }
    }
    println!("cardtrader group products {summary}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rerun_finishes_the_groups_the_journal_left_open() {
        let path = std::env::temp_dir().join(format!("group-products-test-{}.jsonl", std::process::id()));
        std::fs::write(
            &path,
            [
                json!({"step": "begin", "keep": "1", "delete": [{"id": "2"}]}),
                json!({"step": "relink", "keep": "1", "listings": ["a"]}),
                json!({"step": "end", "keep": "1"}),
                json!({"step": "begin", "keep": "5", "delete": [{"id": "6"}, {"id": "7"}]}),
                json!({"step": "delete", "keep": "5", "product": "6"}),
            ]
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        )
        .unwrap();
        let open = unfinished(path.to_str().unwrap());
        assert_eq!(open.len(), 1);
        assert_eq!(open[0]["keep"], "5");
        let _ = std::fs::remove_file(path);
        assert!(RELINK_SQL.contains("source_listing_id = any($2::text[])"));
        assert!(OURS_SQL.contains("'push', 'match'"), "hand-made (import) products are never folded");
    }
}
