//! Applying the pricer: a pricing group (or a strategy on chosen listings)
//! priced from the market comps the web's price check shows
//! (`pokoin_external::price_check::read_prices`, net of the seller's own
//! CardTrader commission), by the rules in `pokoin_external::pricing`, and
//! written through the seller's own listing update (`update_listing`: the
//! same path as an edit on the board, so CardTrader links, caches and
//! seller-API events follow).
//!
//! Used by `POST /api/marketplace-pricing-groups/apply` (the Pricer tab's
//! dry run and Apply), the daily job (`job pricing-groups-daily`) and a batch
//! that arrives with a group or strategy (Card Rails `list`, the Scan desk).

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::{json, Value};
use uuid::Uuid;

use pokoin_external::firebase::FirestoreRest;
use pokoin_external::pokoin_sold::{self, SoldFeed};
use pokoin_external::pricing::{self, PlanOutcome};
use pokoin_external::{facet_store, price_check, pricing_store};

use crate::error::ApiError;
use crate::state::DomainState;

/// The price check reads at most this many items a call.
const CHUNK: usize = 100;
/// One apply prices at most this many listings.
pub const MAX_APPLY: usize = 5_000;

pub(crate) fn from_external(error: pokoin_external::ApiError) -> ApiError {
    let status = axum::http::StatusCode::from_u16(error.status).unwrap_or(axum::http::StatusCode::BAD_GATEWAY);
    let out = ApiError::new(status, error.message);
    match error.code {
        Some(code) => out.with_code(code),
        None => out,
    }
}

fn external_pools(state: &DomainState) -> pokoin_external::db::DbPools {
    pokoin_external::db::DbPools::lazy(state.read_db().clone(), state.write_db().clone())
}

/// The seller's strategies (upgraded as the strategies route reads them).
pub async fn seller_strategies(uid: &str) -> Result<Vec<Value>, ApiError> {
    let fs = FirestoreRest::from_env().ok_or_else(|| ApiError::internal("Firebase Admin credentials are not configured."))?;
    let doc = pokoin_external::firebase::FirestoreStore::get_doc(&fs, "users", uid).await.map_err(from_external)?;
    let mut strategies: Vec<Value> = Vec::new();
    let now = pokoin_external::time_util::iso_from_ms(pokoin_external::time_util::now_ms());
    if doc.exists {
        for row in doc.data.get("pricingStrategies").and_then(Value::as_array).into_iter().flatten() {
            let upgraded = pricing::upgrade_stored_strategy(row, &strategies, &now);
            strategies.push(upgraded);
        }
    }
    Ok(strategies)
}

/// What the seller nets on CardTrader, when connected: comps are netted at
/// that rate, as the board's price check does.
async fn seller_channel(state: &DomainState, uid: &str) -> Option<pokoin_external::ct_fees::Channel> {
    let fs = FirestoreRest::from_env()?;
    let doc = pokoin_external::cardtrader::integration::read_integration_doc(&fs, uid).await.ok()?;
    if !doc.exists {
        return None;
    }
    Some(pokoin_external::ct_fees::resolve_seller_channel_pool(state.read_db(), &doc.data).await)
}

/// Pokoin's own sold feed (the last 90 days of `marketplace_sales`), through
/// the shared cache: one Firestore query per 10 minutes, the cached sales
/// otherwise. Never fails the pricing — no client or a failed query just
/// leaves the `pokoin` source `unavailable`.
async fn pokoin_sales(state: &DomainState) -> SoldFeed {
    if let Some(sales) = pokoin_sold::cached_fresh() {
        return SoldFeed::Available(sales);
    }
    let fs = match state.firestore() {
        Ok(fs) => fs,
        Err(error) => {
            tracing::warn!(error = %error, "pokoin sold feed: no Firestore client");
            return SoldFeed::Unavailable;
        }
    };
    let since = pokoin_sold::window_start_iso();
    let query = crate::firestore::StructuredQuery::collection(pokoin_sold::SALES_COLLECTION)
        .where_filter(crate::firestore::Filter::new(
            "soldAt",
            crate::firestore::FilterOp::GreaterThanOrEqual,
            json!(since),
        ))
        .limit(pokoin_sold::MAX_SALES);
    pokoin_sold::recent_from(async move {
        fs.run_query(&query)
            .await
            .map_err(|error| pokoin_external::ApiError::new(500, error.to_string()))
    })
    .await
}

/// The comp of every row, by listing id: the price check of each game, the
/// row's own facet key first, else the bare card id (as the web's
/// `compFor`). A row with no numeric card id has none.
pub async fn comps_for(state: &DomainState, uid: &str, rows: &[Value]) -> Result<HashMap<String, Value>, ApiError> {
    let pools = external_pools(state);
    let channel = seller_channel(state, uid).await;
    let sales = pokoin_sales(state).await;
    let mut by_game: HashMap<String, Vec<(&Value, price_check::PriceItem)>> = HashMap::new();
    for row in rows {
        let item = facet_store::item_from_listing(row);
        if item.card_id.is_empty() || !item.card_id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let game = row["marketplace_game"].as_str().unwrap_or("pokemon").to_string();
        by_game.entry(game).or_default().push((row, item));
    }
    let mut out = HashMap::new();
    for (game, entries) in by_game {
        for chunk in entries.chunks(CHUNK) {
            let items: Vec<price_check::PriceItem> = chunk.iter().map(|(_, item)| item.clone()).collect();
            let mut prices = price_check::read_prices(&pools, &game, &items, uid, sales.as_slice()).await.map_err(from_external)?;
            if let (Some(channel), Some(map)) = (channel, prices.as_object_mut()) {
                for comp in map.values_mut() {
                    price_check::renet(comp, channel);
                }
            }
            for (row, item) in chunk {
                let comp = prices
                    .get(price_check::price_check_key(item))
                    .or_else(|| prices.get(&item.card_id))
                    .filter(|comp| comp.is_object());
                if let (Some(comp), Some(id)) = (comp, row["id"].as_str()) {
                    out.insert(id.to_string(), comp.clone());
                }
            }
        }
    }
    Ok(out)
}

/// The plan for `rows` under `strategy`, and with `apply` its changes
/// written. Returns `{ plan, scoped, noComp, unchanged, applied, failed }`.
/// `group`: the group being applied. Each write then holds only while the
/// listing is still in it (a manual price that took it out meanwhile wins:
/// PO2 ManualPriceKept); such a listing is counted in `left`.
pub async fn run_plan(state: &DomainState, uid: &str, rows: &[Value], strategy: &Value, apply: bool, group: Option<&str>) -> Result<Value, ApiError> {
    let comps = comps_for(state, uid, rows).await?;
    let mut plan = Vec::new();
    let (mut no_comp, mut unchanged, mut scoped) = (0, 0, 0);
    for row in rows.iter().take(MAX_APPLY) {
        let id = row["id"].as_str().unwrap_or("");
        let comp = comps.get(id);
        match pricing::plan_row(row, comp, strategy) {
            PlanOutcome::Skipped => continue,
            PlanOutcome::NoComp => no_comp += 1,
            PlanOutcome::Unchanged => unchanged += 1,
            PlanOutcome::Change { current, comp_pkn, target, activate } => plan.push(json!({
                "listingId": id, "cardId": row["card_id"], "cardName": row["card_name"], "setName": row["set_name"],
                "collectorNumber": row["collector_number"], "condition": row["condition"], "language": row["language"],
                "game": row["marketplace_game"], "status": row["status"],
                "current": current, "compPkn": comp_pkn,
                "askPkn": comp.and_then(|comp| comp["ctMatchedGrossPkn"].as_f64()),
                "target": target, "activate": activate,
            })),
        }
        scoped += 1;
    }
    let mut applied = 0;
    let mut left = 0;
    let mut failed = Vec::new();
    if apply {
        for entry in &plan {
            let id = entry["listingId"].as_str().unwrap_or("");
            let update = pricing::plan_update(entry["target"].as_f64().unwrap_or(0.0), entry["activate"] == true);
            match write_run_price(state, uid, group, id, &update).await {
                Ok(true) => applied += 1,
                Ok(false) => left += 1,
                Err(error) => failed.push(json!({ "listingId": id, "error": error.message })),
            }
        }
    }
    let activated = plan.iter().filter(|entry| entry["activate"] == true).count();
    Ok(json!({
        "plan": plan, "scoped": scoped, "noComp": no_comp, "unchanged": unchanged,
        "activated": activated, "applied": applied, "left": left, "failed": failed, "dryRun": !apply,
    }))
}

/// Apply a group: its strategy over its live and paused listings, and the
/// summary kept on the group. `only` narrows it to some of its listings
/// (a batch that just joined it).
pub async fn apply_group(state: &DomainState, uid: &str, group_id: &str, only: Option<&[Uuid]>, apply: bool, trigger: &str) -> Result<Value, ApiError> {
    let db = state.write_db();
    let group = pricing_store::group(db, uid, group_id)
        .await
        .map_err(from_external)?
        .ok_or_else(|| ApiError::not_found("Pricing group not found.").with_code("pricing_group_unknown"))?;
    let strategies = seller_strategies(uid).await?;
    let strategy = strategies
        .iter()
        .find(|s| s["id"] == group["strategyId"])
        .cloned()
        .ok_or_else(|| ApiError::conflict("This group's strategy was deleted. Pick another one.").with_code("pricing_strategy_unknown"))?;
    let mut rows = pricing_store::group_rows(db, uid, group_id).await.map_err(from_external)?;
    if let Some(only) = only {
        let keep: std::collections::HashSet<String> = only.iter().map(Uuid::to_string).collect();
        rows.retain(|row| row["id"].as_str().is_some_and(|id| keep.contains(id)));
    }
    let mut out = run_plan(state, uid, &rows, &strategy, apply, Some(group_id)).await?;
    if apply {
        let count = |key: &str| out[key].as_u64().unwrap_or(0) as usize;
        let summary = pricing_store::applied_summary(
            out["applied"].as_u64().unwrap_or(0) as usize,
            count("activated"),
            count("noComp"),
            count("unchanged"),
            out["failed"].as_array().map_or(0, Vec::len),
            trigger,
        );
        pricing_store::record_applied(db, uid, group_id, &summary).await.map_err(from_external)?;
    }
    out["groupId"] = json!(group_id);
    out["strategyId"] = strategy["id"].clone();
    Ok(out)
}

/// A strategy on chosen listings, outside any group.
pub async fn apply_strategy(state: &DomainState, uid: &str, strategy_id: &str, ids: &[Uuid], apply: bool) -> Result<Value, ApiError> {
    let strategies = seller_strategies(uid).await?;
    let strategy = strategies
        .iter()
        .find(|s| s["id"] == strategy_id)
        .cloned()
        .ok_or_else(|| ApiError::bad_request("Pick one of your strategies.").with_code("pricing_strategy_unknown"))?;
    let rows = pricing_store::listing_rows(state.write_db(), uid, ids).await.map_err(from_external)?;
    let mut out = run_plan(state, uid, &rows, &strategy, apply, None).await?;
    out["strategyId"] = json!(strategy_id);
    Ok(out)
}

/// What a batch upload asked for: a group (its listings join it and are
/// priced by its strategy) or a strategy alone (priced once). Unknown ids
/// are refused before anything is created.
#[derive(Clone, Debug, PartialEq)]
pub enum BatchPricing {
    None,
    Group(String),
    Strategy(String),
}

impl BatchPricing {
    /// From `pricingGroupId` / `pricingStrategyId` (the group wins).
    pub fn from_fields(value: &Value) -> Self {
        let text = |key: &str| value[key].as_str().map(str::trim).unwrap_or("").chars().take(40).collect::<String>();
        let (group, strategy) = (text("pricingGroupId"), text("pricingStrategyId"));
        if !group.is_empty() {
            BatchPricing::Group(group)
        } else if !strategy.is_empty() {
            BatchPricing::Strategy(strategy)
        } else {
            BatchPricing::None
        }
    }

    /// Refuse an id that is not the seller's.
    pub async fn check(&self, state: &DomainState, uid: &str) -> Result<(), ApiError> {
        match self {
            BatchPricing::None => Ok(()),
            BatchPricing::Group(id) => match pricing_store::group(state.write_db(), uid, id).await.map_err(from_external)? {
                Some(_) => Ok(()),
                None => Err(ApiError::bad_request("Unknown pricing group.").with_code("pricing_group_unknown")),
            },
            BatchPricing::Strategy(id) => {
                if seller_strategies(uid).await?.iter().any(|s| s["id"] == id.as_str()) {
                    Ok(())
                } else {
                    Err(ApiError::bad_request("Unknown pricing strategy.").with_code("pricing_strategy_unknown"))
                }
            }
        }
    }

    /// The listings just created join the group and get their price.
    pub async fn price_new_listings(&self, state: &DomainState, uid: &str, ids: &[Uuid]) -> Result<Value, ApiError> {
        match self {
            BatchPricing::None => Ok(json!({ "applied": 0 })),
            BatchPricing::Group(group_id) => {
                pricing_store::add_members(state.write_db(), uid, group_id, ids).await.map_err(from_external)?;
                apply_group(state, uid, group_id, Some(ids), true, "batch").await
            }
            BatchPricing::Strategy(strategy_id) => apply_strategy(state, uid, strategy_id, ids, true).await,
        }
    }
}

/// One write of a run (`RunWrite` in specs/tla/price-ownership): the planned
/// `update` of a listing, through the seller's own listing update. With a
/// `group`, it holds only while the listing is still in that group, checked
/// under the row lock; `Ok(false)` when the listing left it (PO2
/// ManualPriceKept: a manual price that took it out meanwhile wins).
pub async fn write_run_price(state: &DomainState, uid: &str, group: Option<&str>, listing_id: &str, update: &Value) -> Result<bool, ApiError> {
    let claims = crate::Claims { uid: uid.to_string(), ..Default::default() };
    let guard = group.map_or(GroupGuard::None, |g| GroupGuard::Run(g.to_string()));
    match super::listings::update_listing_guarded(state, &claims, listing_id, update, &guard).await {
        Ok(_) => Ok(true),
        Err(error) if error.code.as_deref() == Some("pricing_group_left") => Ok(false),
        Err(error) => Err(error),
    }
}

/// A price the seller set by hand: positive, and not the price the listing
/// already has. A write that resends the price it read (a whole-form edit, a
/// tool resending its mirror) is not one. Prices compare to the cent of a PKN.
pub fn is_manual_price(stored_pkn: f64, new_pkn: Option<f64>) -> bool {
    match new_pkn {
        Some(pkn) if pkn.is_finite() && pkn > 0.0 => !(stored_pkn.is_finite() && (stored_pkn - pkn).abs() < 0.005),
        _ => false,
    }
}

/// The group a listing write names in `pricingGroupId`: `None` when the key
/// is absent, `Some("")` for an explicit `null` or empty id ("price it
/// myself"), else the trimmed id.
pub fn named_group(item: &Value) -> Option<String> {
    match item.get("pricingGroupId")? {
        Value::Null => Some(String::new()),
        Value::String(id) => Some(id.trim().chars().take(40).collect()),
        _ => None,
    }
}

/// What a listing write does to the listing's pricing group.
#[derive(Clone, Debug, PartialEq)]
pub enum GroupMove {
    Keep,
    /// Out of its group: the price is the seller's from now on.
    Leave,
    /// Into this group (out of any other).
    Join(String),
}

/// One rule for every hand-made write (a Card Rails `update`, an edit in
/// MyPokoin): a manual price takes the listing out of its group, or the next
/// Apply or the daily `pricing-groups-daily` run overwrites it, unless the
/// same write names that group. Naming another group moves the listing there;
/// naming none (`pricingGroupId: null`) takes it out at any price.
pub fn group_move(current: Option<&str>, named: Option<&str>, manual_price: bool) -> GroupMove {
    match named {
        Some("") if current.is_some() => GroupMove::Leave,
        Some("") => GroupMove::Keep,
        Some(id) if current == Some(id) => GroupMove::Keep,
        Some(id) => GroupMove::Join(id.to_string()),
        None if manual_price && current.is_some() => GroupMove::Leave,
        None => GroupMove::Keep,
    }
}

/// What a listing write does about the listing's pricing group. It is
/// decided and applied in the write's own transaction, under the listing's
/// row lock, so a run, a hand-made price and a board move on one listing
/// never interleave (specs/tla/price-ownership: `GuardedRun`, `AtomicManual`).
#[derive(Clone, Debug, PartialEq)]
pub enum GroupGuard {
    /// Not about groups (stock, unlist, CardTrader sync).
    None,
    /// A group run's price: written only while the listing is still in that
    /// group (PO2 ManualPriceKept). Otherwise the write is refused with
    /// `pricing_group_left` and the run counts it as left.
    Run(String),
    /// A hand-made write (MyPokoin edit, Card Rails `update`): the group it
    /// names (`named_group`), and whether naming another group joins it.
    Manual { named: Option<String>, may_join: bool },
}

/// What a [`GroupGuard`] did: the group (`id`, `name`) the listing left, and
/// whether its membership changed at all.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GroupOutcome {
    pub left: Option<(String, String)>,
    pub moved: bool,
}

/// Apply `guard` to listing `id` inside a transaction that already holds the
/// listing's row lock; `stored_pkn` is its price read under that lock.
pub async fn apply_guard(
    tx: &mut sqlx::PgConnection,
    uid: &str,
    id: Uuid,
    stored_pkn: f64,
    body: &Value,
    guard: &GroupGuard,
) -> Result<GroupOutcome, ApiError> {
    let (named, may_join) = match guard {
        GroupGuard::None => return Ok(GroupOutcome::default()),
        GroupGuard::Run(group) => {
            let still: bool = sqlx::query_scalar(
                "select exists(select 1 from public.seller_pricing_group_members \
                 where listing_id = $1 and group_id = $2 and seller_uid = $3)",
            )
            .bind(id)
            .bind(group)
            .bind(uid)
            .fetch_one(&mut *tx)
            .await?;
            if !still {
                return Err(ApiError::conflict("This listing left the pricing group.").with_code("pricing_group_left"));
            }
            return Ok(GroupOutcome::default());
        }
        GroupGuard::Manual { named, may_join } => (named.clone(), *may_join),
    };
    let price = body.get("pricePkn").map(crate::listing_live::number).filter(|pkn| pkn.is_finite() && *pkn > 0.0);
    if named.is_none() && price.is_none() {
        // No price and no group named: nothing to decide (PO3).
        return Ok(GroupOutcome::default());
    }
    // A database without the pricing tables (a test of another feature) has no groups.
    let grouped: bool = sqlx::query_scalar("select to_regclass('public.seller_pricing_group_members') is not null")
        .fetch_one(&mut *tx)
        .await?;
    if !grouped {
        return Ok(GroupOutcome::default());
    }
    let current: Option<(String, String)> = sqlx::query_as(
        "select m.group_id, g.name from public.seller_pricing_group_members m \
         join public.seller_pricing_groups g on g.id = m.group_id and g.seller_uid = m.seller_uid \
         where m.listing_id = $1 and m.seller_uid = $2",
    )
    .bind(id)
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await?;
    let movement = group_move(current.as_ref().map(|(g, _)| g.as_str()), named.as_deref(), is_manual_price(stored_pkn, price));
    match movement {
        GroupMove::Keep => Ok(GroupOutcome::default()),
        GroupMove::Join(_) if !may_join => Ok(GroupOutcome::default()),
        GroupMove::Leave => {
            sqlx::query("delete from public.seller_pricing_group_members where listing_id = $1 and seller_uid = $2")
                .bind(id)
                .bind(uid)
                .execute(&mut *tx)
                .await?;
            Ok(GroupOutcome { left: current, moved: true })
        }
        GroupMove::Join(group) => {
            let joined = sqlx::query(
                "insert into public.seller_pricing_group_members (listing_id, group_id, seller_uid) \
                 select $1, g.id, $3 from public.seller_pricing_groups g where g.id = $2 and g.seller_uid = $3 \
                 on conflict (listing_id) do update set group_id = excluded.group_id, added_at = now() \
                   where seller_pricing_group_members.seller_uid = excluded.seller_uid",
            )
            .bind(id)
            .bind(&group)
            .bind(uid)
            .execute(&mut *tx)
            .await?;
            if joined.rows_affected() == 0 {
                return Err(ApiError::bad_request("Unknown pricing group.").with_code("pricing_group_unknown"));
            }
            Ok(GroupOutcome { left: None, moved: true })
        }
    }
}

/// `POST /api/marketplace-pricing-groups/apply` — `{ groupId | strategyId,
/// listingIds?, dryRun }`. A dry run returns the plan; otherwise the plan is
/// written and the result says what was applied and what failed.
pub async fn apply_post(State(state): State<DomainState>, headers: HeaderMap, bytes: Bytes) -> Response {
    let result = async {
        let claims = super::listings::auth(&state, &headers).await?;
        let body = super::listings::parse_body(&headers, &bytes)?;
        let apply = body["dryRun"] != true;
        let ids = pricing_store::listing_ids(&body["listingIds"]);
        match BatchPricing::from_fields(&json!({ "pricingGroupId": body["groupId"], "pricingStrategyId": body["strategyId"] })) {
            BatchPricing::Group(group_id) => {
                let only = (!ids.is_empty()).then_some(ids.as_slice());
                apply_group(&state, &claims.uid, &group_id, only, apply, "apply").await
            }
            BatchPricing::Strategy(strategy_id) => {
                if ids.is_empty() {
                    return Err(ApiError::bad_request("listingIds are required with a strategy."));
                }
                apply_strategy(&state, &claims.uid, &strategy_id, &ids, apply).await
            }
            BatchPricing::None => Err(ApiError::bad_request("groupId or strategyId is required.")),
        }
    }
    .await;
    super::listings::response(result, true)
}

/// The daily run: every group with `autoDaily`, oldest apply first. One
/// group's failure is counted and the run goes on.
pub async fn run_daily(state: &DomainState, apply: bool) -> Result<Value, ApiError> {
    let groups = pricing_store::daily_groups(state.write_db()).await.map_err(from_external)?;
    let (mut done, mut failed, mut changed) = (0, Vec::new(), 0);
    for (uid, group_id) in &groups {
        match apply_group(state, uid, group_id, None, apply, "daily").await {
            Ok(out) => {
                done += 1;
                changed += if apply { out["applied"].as_u64().unwrap_or(0) } else { out["plan"].as_array().map_or(0, |p| p.len() as u64) };
            }
            Err(error) => failed.push(json!({ "groupId": group_id, "error": error.message })),
        }
    }
    Ok(json!({ "groups": groups.len(), "done": done, "changed": changed, "failed": failed, "apply": apply }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_batch_names_a_group_or_a_strategy() {
        assert_eq!(BatchPricing::from_fields(&json!({})), BatchPricing::None);
        assert_eq!(BatchPricing::from_fields(&json!({"pricingStrategyId": " st_1 "})), BatchPricing::Strategy("st_1".into()));
        assert_eq!(
            BatchPricing::from_fields(&json!({"pricingGroupId": "pg_1", "pricingStrategyId": "st_1"})),
            BatchPricing::Group("pg_1".into()),
            "the group wins"
        );
        assert_eq!(BatchPricing::from_fields(&json!({"pricingGroupId": null, "pricingStrategyId": ""})), BatchPricing::None);
    }

    /// Conformance with the TLA+ model: every row TLC printed from the
    /// model's rule (specs/tla/price-ownership/Rules.tla, via MoveTable.tla)
    /// is what `group_move` and `is_manual_price` answer.
    #[test]
    fn group_move_matches_the_model_table() {
        let table = include_str!("../../../../../specs/tla/price-ownership/conformance/move-table.txt");
        let model = include_str!("../../../../../specs/tla/price-ownership/Model.tla");
        assert!(model.contains("EXTENDS Naturals, TLC, Rules"), "Model.tla checks this same rule");
        let (mut moves, mut manuals) = (0, 0);
        for line in table.lines().filter(|line| line.starts_with("<<")) {
            let cells: Vec<&str> = line
                .trim_start_matches("<<")
                .trim_end_matches(">>")
                .split(", ")
                .map(|cell| cell.trim_matches('"'))
                .collect();
            match cells[0] {
                "move" => {
                    let current = (cells[1] != "none").then_some(cells[1]);
                    let named = match cells[2] {
                        "absent" => None,
                        "null" => Some(""),
                        group => Some(group),
                    };
                    let expected = match cells[4] {
                        "keep" => GroupMove::Keep,
                        "leave" => GroupMove::Leave,
                        "join" => GroupMove::Join(cells[2].to_string()),
                        other => panic!("unknown move {other}"),
                    };
                    assert_eq!(group_move(current, named, cells[3] == "TRUE"), expected, "{line}");
                    moves += 1;
                }
                "manual" => {
                    let (p, stored): (f64, f64) = (cells[1].parse().unwrap(), cells[2].parse().unwrap());
                    assert_eq!(is_manual_price(stored, Some(p)), cells[3] == "TRUE", "{line}");
                    manuals += 1;
                }
                other => panic!("unknown row {other}"),
            }
        }
        assert_eq!((moves, manuals), (24, 16), "the whole table was read");
    }

    #[test]
    fn po3_only_a_new_positive_price_is_a_manual_price() {
        assert!(is_manual_price(400.0, Some(500.0)));
        assert!(is_manual_price(0.0, Some(20.0)), "pricing an unpriced listing by hand");
        assert!(!is_manual_price(400.0, Some(400.0)), "the same price resent");
        assert!(!is_manual_price(400.0, Some(400.001)));
        assert!(!is_manual_price(400.0, None), "no price in the write");
        assert!(!is_manual_price(400.0, Some(0.0)), "0 pauses, it is not a price");
        assert!(!is_manual_price(400.0, Some(f64::NAN)));
    }

    #[test]
    fn po5_a_write_names_a_group_null_or_nothing() {
        assert_eq!(named_group(&json!({})), None);
        assert_eq!(named_group(&json!({"pricingGroupId": null})), Some(String::new()));
        assert_eq!(named_group(&json!({"pricingGroupId": " pg_1 "})), Some("pg_1".into()));
        assert_eq!(named_group(&json!({"pricingGroupId": 7})), None);
    }

    #[test]
    fn po1_po5_a_manual_price_leaves_the_group_unless_the_write_names_it() {
        // A manual price on a grouped listing: out of the group.
        assert_eq!(group_move(Some("pg_1"), None, true), GroupMove::Leave);
        // No price, or the same price: the group stays.
        assert_eq!(group_move(Some("pg_1"), None, false), GroupMove::Keep);
        // The write names the group it is in: it stays, whatever the price.
        assert_eq!(group_move(Some("pg_1"), Some("pg_1"), true), GroupMove::Keep);
        // Another group: it moves there.
        assert_eq!(group_move(Some("pg_1"), Some("pg_2"), true), GroupMove::Join("pg_2".into()));
        assert_eq!(group_move(None, Some("pg_2"), false), GroupMove::Join("pg_2".into()));
        // `pricingGroupId: null`: out, even without a price.
        assert_eq!(group_move(Some("pg_1"), Some(""), false), GroupMove::Leave);
        assert_eq!(group_move(None, Some(""), true), GroupMove::Keep);
        // Not grouped: nothing to leave.
        assert_eq!(group_move(None, None, true), GroupMove::Keep);
    }
}
