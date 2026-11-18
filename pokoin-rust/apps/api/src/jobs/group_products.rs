//! `job cardtrader-group-products --seller=<uid> [--apply] [--csv=<path>] [--log=<path>]`
//!
//! Folds a seller's identical CardTrader products into one (2026-10-21).
//! Until then every Pokoin listing became its own CardTrader product, so
//! Card Rails' 1× postings of one card stood on CardTrader as dozens of
//! "1 of 1" rows (PeppeV's Spiderling: one product per copy). Only products
//! Pokoin pushed are touched (a `push` link row or a `pokoin:` user data
//! field); they are grouped by blueprint, CardTrader's own properties as
//! sent, description and ask (`group::product_group_key`), and folded into
//! the one with the most copies (`group::plan_consolidation`).
//!
//! Per group, under the seller's reconcile lock:
//! 1. the kept product gets an open row in
//!    `marketplace_cardtrader_consolidations` (migration 134): until it is
//!    closed the reconcile leaves its quantity alone, so a stop between the
//!    steps below never loses copies (group::distribute would otherwise copy
//!    CardTrader's lower quantity onto the members);
//! 2. per duplicate, one at a time: its Pokoin listings move to the kept
//!    product (one transaction), then it is deleted on CardTrader. Its copies
//!    count only when the delete succeeded, at the quantity CardTrader
//!    returned for it (else the export's); a 404 or a refused delete moves
//!    its listings back and counts nothing;
//! 3. the kept product gains the counted copies (`increment`), so CardTrader
//!    never lists more copies than the seller has;
//! 4. the row is closed.
//!
//! A group with a seller order in the last two days is skipped (its export
//! counts may predate a sale), and so is one whose CardTrader copies differ
//! from its Pokoin copies. Every step is a line in the journal (`--log`, JSON
//! lines, default `$POKOIN_STATE_DIR` or `~/.local/state/pokoin`): product ids,
//! copies, asks and properties, enough to undo a run. A rerun first finishes
//! the groups the journal left open. At most 5 CardTrader writes a second;
//! the run stops at any CardTrader error or 429. A dry run unless `--apply`
//! (no lock, no writes, the same plan and skips). `--keep=<product id>` runs
//! only the group that product is in; `--max-groups=N` stops after N groups
//! (a group is always finished: journal and marker closed).
use super::Options;
use anyhow::{bail, Context, Result};
use pokoin_external::cardtrader::group::{self, LinkedListing, Merge};
use pokoin_external::cardtrader::{integration, link, sync_core, webhook};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::time::{Duration, Instant};

const CT_MIN_INTERVAL: Duration = Duration::from_millis(200);
const LOCK_SECONDS: u64 = 900;
/// Days of seller orders that make a group wait for a later run.
const RECENT_ORDER_DAYS: i64 = 2;

const LINKED_SQL: &str = r#"
  select id::text as id, source_listing_id, quantity_available, status
  from public.marketplace_user_listings
  where seller_uid = $1 and source_listing_id ~ '^ct:[0-9]+$' and status in ('active', 'paused')
"#;

/// Products Pokoin pushed. `match` and `import` rows are products the seller
/// made on CardTrader: never folded.
const OURS_SQL: &str = r#"
  select ct_product_id from public.marketplace_cardtrader_product_links
  where seller_uid = $1 and origin = 'push'
"#;

const RELINK_SQL: &str = r#"
  update public.marketplace_user_listings
  set source_listing_id = $3, updated_at = now()
  where seller_uid = $1 and source_listing_id = $2
  returning id::text as id
"#;

/// Move listings back to the duplicate they came from (its delete failed).
const UNLINK_SQL: &str = r#"
  update public.marketplace_user_listings
  set source_listing_id = $2, updated_at = now()
  where seller_uid = $1 and source_listing_id = $3 and id::text = any($4::text[])
"#;

const DROP_LINK_SQL: &str = r#"
  delete from public.marketplace_cardtrader_product_links
  where seller_uid = $1 and ct_product_id = $2
"#;

const OPEN_SQL: &str = r#"
  insert into public.marketplace_cardtrader_consolidations (seller_uid, kept_product_id)
  values ($1, $2)
  on conflict (seller_uid, kept_product_id) do update set opened_at = now(), closed_at = null
"#;

const CLOSE_SQL: &str = r#"
  update public.marketplace_cardtrader_consolidations set closed_at = now()
  where seller_uid = $1 and kept_product_id = $2 and closed_at is null
"#;

const OPEN_MARKERS_SQL: &str = r#"
  select kept_product_id from public.marketplace_cardtrader_consolidations
  where seller_uid = $1 and closed_at is null
"#;

const MEMBERS_COPIES_SQL: &str = r#"
  select coalesce(sum(quantity_available), 0)::bigint as copies from public.marketplace_user_listings
  where seller_uid = $1 and source_listing_id = $2 and status in ('active', 'paused')
"#;

/// The groups this run takes: the one a product id names (kept or deleted),
/// then at most `max` of them, in plan order.
pub(crate) fn select(merges: Vec<Merge>, keep: Option<&str>, max: Option<usize>) -> Vec<Merge> {
    let mut merges: Vec<Merge> = match keep {
        Some(id) => merges.into_iter().filter(|m| m.keep == id || m.delete.iter().any(|(d, _)| d == id)).collect(),
        None => merges,
    };
    if let Some(max) = max {
        merges.truncate(max);
    }
    merges
}

fn max_groups() -> Result<Option<usize>> {
    match arg("--max-groups=") {
        None => Ok(None),
        Some(n) => n.parse::<usize>().map(Some).map_err(|_| anyhow::anyhow!("--max-groups must be a number, not {n:?}")),
    }
}

fn arg(prefix: &str) -> Option<String> {
    std::env::args().find_map(|a| a.strip_prefix(prefix).map(|v| v.trim().to_string())).filter(|v| !v.is_empty())
}

/// The journal lives on persistent disk: a run interrupted by a reboot must
/// still find its open groups.
fn journal_path(seller: &str) -> String {
    if let Some(path) = arg("--log=") {
        return path;
    }
    let dir = std::env::var("POKOIN_STATE_DIR")
        .ok()
        .filter(|dir| !dir.trim().is_empty())
        .unwrap_or_else(|| format!("{}/.local/state/pokoin", std::env::var("HOME").unwrap_or_else(|_| ".".into())));
    format!("{dir}/ct-group-products-{seller}.jsonl")
}

fn product_json(product: &sync_core::NormalizedProduct) -> Value {
    json!({
        "id": product.id, "blueprintId": product.blueprint_id, "name": product.name, "quantity": product.quantity,
        "askCents": product.price_pkn.map(|p| (p / 2.0).round() as i64), "properties": product.properties_key,
        "description": product.description, "graded": product.graded,
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

/// A group the journal shows begun and not ended, as its steps say.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct OpenGroup {
    pub keep: String,
    /// Duplicates whose listings moved and whose delete is not recorded:
    /// (product id, the listings moved).
    pub moved: Vec<(String, Vec<String>)>,
    /// Copies of deleted duplicates the kept product has not gained yet.
    pub owed: i64,
}

pub(crate) fn unfinished(text: &str) -> Vec<OpenGroup> {
    let mut open: Vec<OpenGroup> = Vec::new();
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        let keep = entry["keep"].as_str().unwrap_or("").to_string();
        let product = entry["product"].as_str().unwrap_or("").to_string();
        let find = |open: &mut Vec<OpenGroup>| open.iter().position(|g| g.keep == keep);
        match entry["step"].as_str() {
            Some("begin") => {
                if let Some(i) = find(&mut open) {
                    open.remove(i);
                }
                open.push(OpenGroup { keep: keep.clone(), ..Default::default() });
            }
            Some("relink") => {
                if let Some(i) = find(&mut open) {
                    let ids = entry["listings"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
                    open[i].moved.push((product, ids));
                }
            }
            Some("delete") => {
                if let Some(i) = find(&mut open) {
                    open[i].moved.retain(|(id, _)| *id != product);
                    open[i].owed += entry["copies"].as_i64().unwrap_or(0);
                }
            }
            Some("gone") | Some("unlinked") => {
                if let Some(i) = find(&mut open) {
                    open[i].moved.retain(|(id, _)| *id != product);
                }
            }
            Some("increment") => {
                if let Some(i) = find(&mut open) {
                    open[i].owed -= entry["delta"].as_i64().unwrap_or(0);
                }
            }
            Some("end") => {
                if let Some(i) = find(&mut open) {
                    open.remove(i);
                }
            }
            _ => {}
        }
    }
    open
}

/// The quantity CardTrader returned with a deleted product, when it did.
fn deleted_quantity(response: &Value) -> Option<i64> {
    response
        .pointer("/resource/quantity")
        .or_else(|| response.pointer("/product/quantity"))
        .or_else(|| response.get("quantity"))
        .and_then(Value::as_i64)
}

struct Lock {
    redis: redis::aio::ConnectionManager,
    key: String,
    owner: String,
}

impl Lock {
    async fn acquire(seller: &str) -> Result<Self> {
        let mut redis = super::redis_connection().await.context("the reconcile lock needs Valkey/Redis")?;
        let key = pokoin_external::redis::lock_key("ct-reconcile", seller);
        let owner = format!("group-products-{}", std::process::id());
        let set: Option<String> = redis::cmd("SET").arg(&key).arg(&owner).arg("NX").arg("EX").arg(LOCK_SECONDS).query_async(&mut redis).await?;
        if set.is_none() {
            bail!("a CardTrader reconcile of this seller is running; try again in a few minutes");
        }
        Ok(Self { redis, key, owner })
    }

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

/// Product ids named by the seller's orders of the last days.
async fn recently_ordered(ct: &pokoin_external::cardtrader::client::CardTraderClient, token: &str) -> Result<HashSet<String>> {
    let from = pokoin_external::time_util::utc_day_key_from_ms(pokoin_external::time_util::now_ms() - RECENT_ORDER_DAYS * 86_400_000);
    let orders = ct
        .fetch_seller_sale_orders(token, &from, 100, 20)
        .await
        .map_err(|e| anyhow::anyhow!("seller orders unreadable ({}); nothing changed", e.message))?;
    Ok(orders
        .iter()
        .filter_map(|order| order.get("order_items").and_then(Value::as_array))
        .flatten()
        .map(webhook::item_product_id)
        .filter(|id| !id.is_empty())
        .collect())
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
    let path = journal_path(&seller);
    let mut lock = if options.apply { Some(Lock::acquire(&seller).await?) } else { None };
    let result = consolidate(&state, &seller, &token, options, &path, lock.as_mut()).await;
    if let Some(lock) = lock {
        lock.release().await;
    }
    result
}

struct Ctx<'a> {
    state: &'a pokoin_external::DomainState,
    writer: sqlx::PgPool,
    seller: &'a str,
    token: &'a str,
}

impl Ctx<'_> {
    async fn mark(&self, sql: &str, keep: &str) -> Result<()> {
        sqlx::query(sql).bind(self.seller).bind(keep).execute(&self.writer).await?;
        Ok(())
    }

    /// Move a duplicate's listings back to it (its delete did not happen).
    async fn unlink(&self, keep: &str, product: &str, ids: &[String]) -> Result<()> {
        sqlx::query(UNLINK_SQL)
            .bind(self.seller)
            .bind(sync_core::ct_source_listing_id(product))
            .bind(sync_core::ct_source_listing_id(keep))
            .bind(ids)
            .execute(&self.writer)
            .await?;
        Ok(())
    }

    async fn members(&self, keep: &str) -> Result<i64> {
        let copies: i64 = sqlx::query_scalar(MEMBERS_COPIES_SQL)
            .bind(self.seller)
            .bind(sync_core::ct_source_listing_id(keep))
            .fetch_one(&self.writer)
            .await?;
        Ok(copies)
    }

    /// Delete one duplicate whose listings already moved. `Ok(Some(copies))`
    /// deleted, `Ok(None)` gone already (listings moved back), `Err` refused
    /// (listings moved back; the run stops).
    async fn delete(&self, journal: &mut Journal, keep: &str, product: &str, ids: &[String], export_copies: i64) -> Result<Option<i64>> {
        match paced(self.state.cardtrader.destroy_product(self.token, product)).await {
            Ok(response) => {
                let copies = deleted_quantity(&response).unwrap_or(export_copies).max(0);
                journal.line(json!({"step": "delete", "keep": keep, "product": product, "copies": copies,
                                    "returned": deleted_quantity(&response)}))?;
                Ok(Some(copies))
            }
            Err(error) if gone(&error) => {
                self.unlink(keep, product, ids).await?;
                journal.line(json!({"step": "gone", "keep": keep, "product": product}))?;
                Ok(None)
            }
            Err(error) => {
                self.unlink(keep, product, ids).await?;
                journal.line(json!({"step": "unlinked", "keep": keep, "product": product, "reason": error.message}))?;
                bail!("deleting {product}: {}", error.message)
            }
        }
    }

    /// Give the kept product the copies its deleted duplicates held.
    async fn gain(&self, journal: &mut Journal, keep: &str, copies: i64) -> Result<()> {
        if copies <= 0 {
            return Ok(());
        }
        paced(self.state.cardtrader.increment_product(self.token, keep, copies))
            .await
            .map_err(|e| anyhow::anyhow!("adding {copies} copies to {keep}: {} (the group stays open; rerun)", e.message))?;
        journal.line(json!({"step": "increment", "keep": keep, "delta": copies}))
    }
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
    let ctx = Ctx { state, writer: state.db.writer()?.clone(), seller, token };
    let mut journal = Journal(if options.apply {
        if let Some(dir) = std::path::Path::new(journal_path).parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        Some(std::fs::OpenOptions::new().create(true).append(true).open(journal_path).with_context(|| format!("opening {journal_path}"))?)
    } else {
        None
    });
    let mut summary = json!({
        "seller": seller, "apply": options.apply, "journal": if options.apply { json!(journal_path) } else { Value::Null },
        "resumed": 0, "groups": 0, "productsInGroups": 0, "toDelete": 0, "deleted": 0, "gone": 0, "incremented": 0,
        "relinked": 0, "skippedRecentOrders": [], "mismatched": [], "afterCheck": [], "stoppedBy": "done", "errors": [],
    });

    let open_markers: HashSet<String> = sqlx::query_scalar::<_, String>(OPEN_MARKERS_SQL)
        .bind(seller)
        .fetch_all(&ctx.writer)
        .await
        .unwrap_or_default()
        .into_iter()
        .collect();
    let open_groups = unfinished(&std::fs::read_to_string(journal_path).unwrap_or_default());
    let journaled: HashSet<&str> = open_groups.iter().map(|g| g.keep.as_str()).collect();
    let orphaned: Vec<&String> = open_markers.iter().filter(|keep| !journaled.contains(keep.as_str())).collect();
    if !orphaned.is_empty() {
        // An open product with no journal: someone else's run, or a lost
        // journal. Its quantity stays frozen until a person looks.
        summary["openWithoutJournal"] = json!(orphaned);
    }

    let export = ct.fetch_products_export(token).await?;
    if export.unparsed_rows > 0 {
        bail!("the CardTrader export had {} rows it could not read; nothing changed", export.unparsed_rows);
    }
    let by_id: HashMap<&str, &sync_core::NormalizedProduct> = export.products.iter().map(|p| (p.id.as_str(), p)).collect();

    // A run that stopped inside a group finishes it first.
    if options.apply {
        for open in &open_groups {
            let mut owed = open.owed;
            for (product, ids) in &open.moved {
                let copies = if by_id.contains_key(product.as_str()) {
                    ctx.delete(&mut journal, &open.keep, product, ids, by_id.get(product.as_str()).map(|p| p.quantity).unwrap_or(0)).await?
                } else {
                    // Not on CardTrader any more: its listings go back, and
                    // the reconcile settles them as the vanished product's.
                    ctx.unlink(&open.keep, product, ids).await?;
                    journal.line(json!({"step": "gone", "keep": open.keep, "product": product}))?;
                    None
                };
                owed += copies.unwrap_or(0);
            }
            ctx.gain(&mut journal, &open.keep, owed).await?;
            ctx.mark(CLOSE_SQL, &open.keep).await?;
            journal.line(json!({"step": "end", "keep": open.keep, "resumed": true}))?;
            summary["resumed"] = json!(summary["resumed"].as_i64().unwrap_or(0) + 1);
        }
    }

    let ours: HashSet<String> = sqlx::query_scalar::<_, String>(OURS_SQL).bind(seller).fetch_all(&ctx.writer).await?.into_iter().collect();
    let listings: Vec<LinkedListing> = sqlx::query_as::<_, (String, String, i32, String)>(LINKED_SQL)
        .bind(seller)
        .fetch_all(&ctx.writer)
        .await?
        .into_iter()
        .map(|(id, source, quantity, status)| LinkedListing {
            id,
            product_id: sync_core::parse_ct_product_id(&source),
            quantity: quantity as i64,
            status,
        })
        .collect();
    let (planned, mismatched) = group::plan_consolidation(&export.products, &ours, &listings);
    let recent = recently_ordered(ct, token).await?;
    let (merges, skipped): (Vec<Merge>, Vec<Merge>) = planned
        .into_iter()
        .partition(|m| !recent.contains(&m.keep) && m.delete.iter().all(|(id, _)| !recent.contains(id)));
    summary["skippedRecentOrders"] = json!(skipped.iter().map(|m| json!({"keep": m.keep, "products": m.delete.len() + 1})).collect::<Vec<_>>());
    // `--keep=<product>` / `--max-groups=N`: this run touches only these
    // groups (the dry run with the same flags lists exactly them).
    summary["plannedGroups"] = json!(merges.len());
    let merges = select(merges, arg("--keep=").as_deref(), max_groups()?);
    if merges.is_empty() && (arg("--keep=").is_some()) {
        summary["keepNotFound"] = json!(arg("--keep="));
    }

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
        for merge in &merges {
            if let Some(lock) = lock.as_deref_mut() {
                lock.renew().await?;
            }
            let outcome = fold(&ctx, &mut journal, merge, &by_id, &mut summary).await;
            if let Err(error) = outcome {
                summary["stoppedBy"] = json!(if error.to_string().contains("429") { "rate_limited" } else { "error" });
                summary["errors"].as_array_mut().unwrap().push(json!({"keep": merge.keep, "reason": error.to_string()}));
                break;
            }
        }
    }
    println!("cardtrader group products {summary}");
    Ok(())
}

/// One group, end to end (see the module doc).
async fn fold(
    ctx: &Ctx<'_>,
    journal: &mut Journal,
    merge: &Merge,
    by_id: &HashMap<&str, &sync_core::NormalizedProduct>,
    summary: &mut Value,
) -> Result<()> {
    let keep = merge.keep.as_str();
    ctx.mark(OPEN_SQL, keep).await?;
    journal.line(json!({
        "step": "begin", "at": pokoin_external::time_util::iso_from_ms(pokoin_external::time_util::now_ms()),
        "keep": keep, "keepProduct": by_id.get(keep).map(|p| product_json(p)),
        "delete": merge.delete.iter().map(|(id, _)| by_id.get(id.as_str()).map(|p| product_json(p)).unwrap_or(json!({"id": id}))).collect::<Vec<_>>(),
        "copies": merge.total,
    }))?;
    let mut gained = 0;
    let mut failed = None;
    for (product, export_copies) in &merge.delete {
        let mut tx = ctx.writer.begin().await?;
        let moved: Vec<String> = sqlx::query_scalar(RELINK_SQL)
            .bind(ctx.seller)
            .bind(sync_core::ct_source_listing_id(product))
            .bind(sync_core::ct_source_listing_id(keep))
            .fetch_all(&mut *tx)
            .await?;
        sqlx::query(DROP_LINK_SQL).bind(ctx.seller).bind(product).execute(&mut *tx).await?;
        tx.commit().await?;
        journal.line(json!({"step": "relink", "keep": keep, "product": product, "listings": moved}))?;
        summary["relinked"] = json!(summary["relinked"].as_i64().unwrap_or(0) + moved.len() as i64);
        match ctx.delete(journal, keep, product, &moved, *export_copies).await {
            Ok(Some(copies)) => {
                gained += copies;
                summary["deleted"] = json!(summary["deleted"].as_i64().unwrap_or(0) + 1);
            }
            Ok(None) => summary["gone"] = json!(summary["gone"].as_i64().unwrap_or(0) + 1),
            Err(error) => {
                failed = Some(error);
                break;
            }
        }
    }
    // The copies already taken off CardTrader go to the kept product even
    // when a later delete failed; until then the group stays open.
    ctx.gain(journal, keep, gained).await?;
    if gained > 0 {
        summary["incremented"] = json!(summary["incremented"].as_i64().unwrap_or(0) + 1);
    }
    let expected = by_id.get(keep).map(|p| p.quantity).unwrap_or(0) + gained;
    let members = ctx.members(keep).await?;
    if members != expected {
        // A sale or an edit since the export: the reconcile settles it once
        // the group is closed. Reported, never guessed.
        summary["afterCheck"].as_array_mut().unwrap().push(json!({"keep": keep, "cardtraderExpected": expected, "pokoinCopies": members}));
    }
    ctx.mark(CLOSE_SQL, keep).await?;
    journal.line(json!({"step": "end", "keep": keep}))?;
    match failed {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(entries: &[Value]) -> String {
        entries.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn a_rerun_knows_what_each_open_group_still_owes() {
        let text = lines(&[
            json!({"step": "begin", "keep": "1"}),
            json!({"step": "relink", "keep": "1", "product": "2", "listings": ["a"]}),
            json!({"step": "delete", "keep": "1", "product": "2", "copies": 1}),
            json!({"step": "increment", "keep": "1", "delta": 1}),
            json!({"step": "end", "keep": "1"}),
            // Stopped after two deletes (3 copies), before the increment, with
            // a third duplicate moved and not deleted.
            json!({"step": "begin", "keep": "5"}),
            json!({"step": "relink", "keep": "5", "product": "6", "listings": ["b"]}),
            json!({"step": "delete", "keep": "5", "product": "6", "copies": 1}),
            json!({"step": "relink", "keep": "5", "product": "7", "listings": ["c", "d"]}),
            json!({"step": "delete", "keep": "5", "product": "7", "copies": 2}),
            json!({"step": "relink", "keep": "5", "product": "8", "listings": ["e"]}),
            // A 404 counts nothing.
            json!({"step": "begin", "keep": "9"}),
            json!({"step": "relink", "keep": "9", "product": "10", "listings": ["f"]}),
            json!({"step": "gone", "keep": "9", "product": "10"}),
        ]);
        let open = unfinished(&text);
        assert_eq!(open.len(), 2);
        assert_eq!(open[0], OpenGroup { keep: "5".into(), moved: vec![("8".into(), vec!["e".into()])], owed: 3 });
        assert_eq!(open[1], OpenGroup { keep: "9".into(), moved: vec![], owed: 0 });
    }

    #[test]
    fn one_chosen_group_or_the_first_n() {
        let merge = |keep: &str, delete: &[&str]| Merge {
            key: keep.into(), keep: keep.into(), keep_quantity: 1,
            delete: delete.iter().map(|d| (d.to_string(), 1)).collect(),
            total: 1 + delete.len() as i64, pokoin_total: 1 + delete.len() as i64, relink: vec![],
        };
        let all = || vec![merge("1", &["2", "3"]), merge("4", &["5"]), merge("6", &["7"])];
        assert_eq!(select(all(), None, None).len(), 3);
        assert_eq!(select(all(), None, Some(1)).iter().map(|m| m.keep.clone()).collect::<Vec<_>>(), vec!["1"]);
        assert_eq!(select(all(), Some("5"), None).iter().map(|m| m.keep.clone()).collect::<Vec<_>>(), vec!["4"], "a deleted product names its group");
        assert_eq!(select(all(), Some("6"), Some(5)).len(), 1);
        assert!(select(all(), Some("99"), None).is_empty());
        assert!(select(all(), None, Some(0)).is_empty());
    }

    #[test]
    fn only_a_real_delete_counts_and_at_the_quantity_cardtrader_returned() {
        assert_eq!(deleted_quantity(&json!({"resource": {"id": 6, "quantity": 0}})), Some(0), "sold since the export: nothing to move");
        assert_eq!(deleted_quantity(&json!({"result": "ok"})), None);
        assert_eq!(deleted_quantity(&json!({"quantity": 2})), Some(2));
        assert!(OURS_SQL.contains("origin = 'push'") && !OURS_SQL.contains("match"), "the seller's own products are never folded");
        assert!(UNLINK_SQL.contains("source_listing_id = $3") && UNLINK_SQL.contains("any($4::text[])"));
        assert!(OPEN_SQL.contains("closed_at = null") && CLOSE_SQL.contains("closed_at is null"));
        let _ = std::env::var("HOME");
        assert!(journal_path("u1").ends_with("/ct-group-products-u1.jsonl"));
        assert!(!journal_path("u1").starts_with("/var/tmp"), "a reboot keeps the journal");
    }
}
