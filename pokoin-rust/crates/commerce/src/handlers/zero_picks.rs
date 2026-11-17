//! CardTrader Zero picks that move inventory (docs/CARDTRADER_ZERO.md
//! "Pick → inventory"). A Zero sale already took the stock through the
//! CardTrader webhook; picking never takes it twice. It records which copy
//! left the box (`public.cardtrader_zero_picks`) and, when the seller took
//! another identical copy than the one the sale took, moves the stock from
//! that copy to the allocated one in one transaction with both outbox events.
//! Issue reports and unlinked lines stay on Firestore (pokoin-external).
use super::listings::{apply_stock_delta, finish_write, lock_listing, set_location};
use super::private_json;
use crate::error::ApiError;
use crate::listing_live as live;
use crate::state::{AuthedUser, DomainState};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use pokoin_external::cardtrader::zero as ct_zero;
use pokoin_external::powertools::id_text;
use serde_json::{json, Value};

const MAX_QUANTITY: i64 = 999;
const PAGE: i64 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Pick,
    Undo,
}

/// A validated inventory pick (`action` present, a listing named).
#[derive(Clone, Debug, PartialEq)]
pub struct InventoryPick {
    pub action: Action,
    pub order_id: String,
    pub order_code: String,
    pub item_id: String,
    pub line_key: String,
    /// The copy physically picked.
    pub listing_id: uuid::Uuid,
    /// The copy the sale took; None when the line had no allocation.
    pub allocated_listing_id: Option<uuid::Uuid>,
    pub quantity: i64,
    pub unit_cents: Option<i64>,
    pub currency: String,
}

/// What a `POST /api/cardtrader-zero-pick` body asks for.
#[derive(Clone, Debug, PartialEq)]
pub enum PickBody {
    /// Moves (or records) inventory: `action` with a `listingId`.
    Inventory(InventoryPick),
    /// PR A's Firestore store: issues, `reset`, `picked` counts, and picks of
    /// lines with no Pokoin listing.
    Firestore(Value),
}

fn bad(message: &str, code: &str) -> ApiError {
    ApiError::bad_request(message).with_code(code)
}

fn uuid_field(body: &Value, key: &str) -> Result<Option<uuid::Uuid>, ApiError> {
    let raw = id_text(body.get(key).unwrap_or(&Value::Null));
    if raw.is_empty() {
        return Ok(None);
    }
    uuid::Uuid::parse_str(&raw).map(Some).map_err(|_| bad(&format!("{key} is not a listing id."), "invalid_listing"))
}

pub fn parse_pick_body(body: &Value) -> Result<PickBody, ApiError> {
    if !body.is_object() {
        return Err(bad("Send a JSON object.", "invalid_body"));
    }
    let action = match body.get("action").and_then(Value::as_str) {
        None => return Ok(PickBody::Firestore(body.clone())),
        Some("pick") => Action::Pick,
        Some("undo") => Action::Undo,
        Some(_) => return Err(bad("action must be pick or undo.", "invalid_action")),
    };
    let order_id = id_text(body.get("orderId").unwrap_or(&Value::Null));
    if order_id.is_empty() || order_id.len() > 40 || !order_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(bad("orderId must be a CardTrader order id.", "invalid_order"));
    }
    let item_id = id_text(body.get("itemId").unwrap_or(&Value::Null));
    if item_id.is_empty() || item_id.len() > 40 || !item_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(bad("itemId must be a CardTrader item id.", "invalid_item"));
    }
    let line_key = body.get("lineKey").and_then(Value::as_str).unwrap_or_default().to_string();
    let key_ok = !line_key.is_empty()
        && line_key.len() <= 120
        && line_key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '_' | ':' | '.' | '-'));
    if !key_ok {
        return Err(bad("lineKey is not a picking line key.", "invalid_line"));
    }
    let quantity = match body.get("quantity") {
        None | Some(Value::Null) => 1,
        Some(value) => match value.as_i64() {
            Some(n) if (1..=MAX_QUANTITY).contains(&n) => n,
            _ => return Err(bad("quantity must be 1 to 999.", "invalid_quantity")),
        },
    };
    let Some(listing_id) = uuid_field(body, "listingId")? else {
        // No Pokoin listing on the line: nothing to move, the tick is a
        // Firestore picked count as before.
        let picked = if action == Action::Pick { quantity } else { 0 };
        return Ok(PickBody::Firestore(json!({ "orderId": order_id, "lineKey": line_key, "picked": picked })));
    };
    let allocated_listing_id = uuid_field(body, "allocatedListingId")?;
    let unit_cents = body.get("unitCents").and_then(Value::as_i64).filter(|c| (0..=i32::MAX as i64).contains(c));
    let clean = |key: &str, max: usize| live::field(body, key, max);
    Ok(PickBody::Inventory(InventoryPick {
        action,
        order_id,
        order_code: clean("orderCode", 80),
        item_id,
        line_key,
        listing_id,
        allocated_listing_id,
        quantity,
        unit_cents,
        currency: clean("currency", 8).to_uppercase(),
    }))
}

// ------------------------------------------------------------ planning

/// The facets that make two copies the same card for a buyer.
pub fn identity(row: &Value) -> (String, String, String, bool, bool, bool, bool) {
    let upper = |key: &str| live::field(row, key, 40).trim().to_uppercase();
    let flag = |key: &str| row[key] == true;
    (
        live::field(row, "card_id", 80),
        upper("condition"),
        upper("language"),
        flag("reverse"),
        flag("first_edition"),
        flag("signed"),
        flag("graded"),
    )
}

fn quantity_of(row: &Value) -> i64 {
    let n = live::number(&row["quantity_available"]);
    if n.is_finite() { n as i64 } else { 0 }
}

fn holds_no_copy(row: &Value) -> bool {
    quantity_of(row) <= 0 || live::field(row, "status", 20) == "sold_out"
}

/// What a pick or an undo does, decided from the locked rows.
#[derive(Clone, Debug, PartialEq)]
pub enum Plan {
    /// The same pick is already recorded: change nothing, answer that row.
    Replay,
    /// The copy the sale took left its box. `clear_location` when it holds
    /// no copy any more (its location is cleared and kept on the row).
    Finalize { clear_location: bool },
    /// Another identical copy left: picked −quantity, allocated +quantity.
    /// `clear_location` when the picked copy is then empty.
    Swap { quantity: i64, clear_location: bool },
    /// Restore the finalized copy's location (when it is still blank).
    UndoFinalize { restore_location: Option<String> },
    /// Picked +quantity, allocated −quantity, location restored when blank.
    UndoSwap { quantity: i64, restore_location: Option<String> },
    /// Nothing live to undo.
    Nothing,
}

/// Plan a pick. `picked` / `allocated` are the locked listing rows
/// (`allocated` None when the line had no allocation or names the same copy);
/// `live` is the existing live pick of this (order, item, copy).
pub fn plan_pick(request: &InventoryPick, picked: &Value, allocated: Option<&Value>, live_pick: Option<&Value>) -> Result<Plan, ApiError> {
    if live_pick.is_some() {
        return Ok(Plan::Replay);
    }
    let Some(allocated) = allocated.filter(|_| request.allocated_listing_id.is_some_and(|id| id != request.listing_id)) else {
        return Ok(Plan::Finalize { clear_location: holds_no_copy(picked) });
    };
    if identity(picked) != identity(allocated) {
        return Err(ApiError::conflict("That copy is not the same card, condition, language, and finish as the one sold.")
            .with_code("not_identical"));
    }
    let available = quantity_of(picked);
    if available < request.quantity {
        return Err(ApiError::conflict("That copy has fewer copies than you picked.").with_code("insufficient_quantity"));
    }
    Ok(Plan::Swap { quantity: request.quantity, clear_location: available - request.quantity <= 0 })
}

/// Plan the undo of `row` (the live pick, if any).
pub fn plan_undo(row: Option<&Value>, picked: &Value, allocated: Option<&Value>) -> Result<Plan, ApiError> {
    let Some(row) = row else { return Ok(Plan::Nothing) };
    let location_from = live::field(row, "location_from", 120);
    let restore = (!location_from.is_empty() && live::field(picked, "location", 120).is_empty()).then_some(location_from);
    match live::field(row, "kind", 20).as_str() {
        "swap" => {
            let quantity = live::number(&row["quantity"]) as i64;
            if allocated.map(quantity_of).unwrap_or(0) < quantity {
                return Err(ApiError::conflict("The copy the sale took no longer has those copies: it was sold or edited since.")
                    .with_code("allocated_copy_gone"));
            }
            Ok(Plan::UndoSwap { quantity, restore_location: restore })
        }
        _ => Ok(Plan::UndoFinalize { restore_location: restore }),
    }
}

// ------------------------------------------------------------ storage

const ROW_COLUMNS: &str = "id, seller_uid, order_id, order_code, item_id, line_key, listing_id::text as listing_id, \
     coalesce(allocated_listing_id::text, '') as allocated_listing_id, quantity, kind, state, location_from, card_id, \
     marketplace_game, unit_cents, currency, \
     to_char(picked_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as picked_at, \
     to_char(undone_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as undone_at";

fn live_pick_sql() -> String {
    format!(
        "select to_jsonb(v) from (select {ROW_COLUMNS} from public.cardtrader_zero_picks \
         where seller_uid = $1 and order_id = $2 and item_id = $3 and listing_id = $4 and state = 'picked' for update) v"
    )
}

fn insert_sql() -> String {
    format!(
        "with written as (insert into public.cardtrader_zero_picks \
           (seller_uid, order_id, order_code, item_id, line_key, listing_id, allocated_listing_id, quantity, kind, \
            location_from, card_id, marketplace_game, unit_cents, currency) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) \
         on conflict (seller_uid, order_id, item_id, listing_id) where state = 'picked' do nothing returning *) \
         select to_jsonb(v) from (select {ROW_COLUMNS} from written) v"
    )
}

fn undo_sql() -> String {
    format!(
        "with written as (update public.cardtrader_zero_picks set state = 'undone', undone_at = now() \
         where id = $1 and state = 'picked' returning *) select to_jsonb(v) from (select {ROW_COLUMNS} from written) v"
    )
}

/// A pick row in the API's shape.
pub fn pick_json(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "orderId": live::field(row, "order_id", 40),
        "orderCode": live::field(row, "order_code", 80),
        "itemId": live::field(row, "item_id", 40),
        "lineKey": live::field(row, "line_key", 120),
        "listingId": live::field(row, "listing_id", 80),
        "allocatedListingId": live::field(row, "allocated_listing_id", 80),
        "quantity": row["quantity"],
        "kind": live::field(row, "kind", 20),
        "state": live::field(row, "state", 20),
        "locationFrom": live::field(row, "location_from", 120),
        "cardId": live::field(row, "card_id", 80),
        "game": live::field(row, "marketplace_game", 40),
        "unitCents": row["unit_cents"],
        "currency": live::field(row, "currency", 8),
        "pickedAt": row["picked_at"],
        "undoneAt": row["undone_at"],
    })
}

/// Rows changed in the transaction, for the post-commit cache work.
struct Changed {
    rows: Vec<(Value, bool)>,
}

impl Changed {
    fn push(&mut self, row: (Value, bool)) {
        let id = live::field(&row.0, "id", 80);
        self.rows.retain(|(r, _)| live::field(r, "id", 80) != id);
        self.rows.push(row);
    }
}

async fn lock_pair(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    seller: &str,
    picked: uuid::Uuid,
    allocated: Option<uuid::Uuid>,
) -> Result<(Value, Option<Value>), ApiError> {
    let not_found = || ApiError::not_found("Listing not found for this seller.").with_code("listing_not_found");
    // Lock in id order so two picks of the same pair never deadlock.
    let other = allocated.filter(|id| *id != picked);
    let mut ids = vec![picked];
    ids.extend(other);
    ids.sort();
    let mut locked = Vec::new();
    for id in &ids {
        locked.push((*id, lock_listing(tx, seller, *id).await?));
    }
    let take = |id: uuid::Uuid| locked.iter().find(|(lid, _)| *lid == id).and_then(|(_, row)| row.clone());
    let picked_row = take(picked).ok_or_else(not_found)?;
    let allocated_row = match other {
        Some(id) => Some(take(id).ok_or_else(not_found)?),
        None => None,
    };
    Ok((picked_row, allocated_row))
}

/// Run one inventory pick or undo in a single transaction. Returns
/// `(pick row, changed listing rows with their queued flag, inventory)`.
async fn run_inventory_pick(
    state: &DomainState,
    seller: &str,
    request: &InventoryPick,
) -> Result<(Value, Vec<(Value, bool)>, &'static str), ApiError> {
    let now = state.now_ms();
    let mut tx = state.write_db().begin().await?;
    let mut changed = Changed { rows: Vec::new() };
    let live_row: Option<Value> = sqlx::query_scalar(&live_pick_sql())
        .bind(seller)
        .bind(&request.order_id)
        .bind(&request.item_id)
        .bind(request.listing_id)
        .fetch_optional(&mut *tx)
        .await?;
    // An undo reverses the copies the row recorded: the stored allocated
    // copy, never a client-sent one (an empty stored id restores nothing).
    let allocated_id = match request.action {
        Action::Undo => live_row.as_ref().and_then(|row| uuid::Uuid::parse_str(&live::field(row, "allocated_listing_id", 80)).ok()),
        Action::Pick => request.allocated_listing_id,
    };
    let (picked, allocated) = lock_pair(&mut tx, seller, request.listing_id, allocated_id).await?;
    let inventory;
    let pick_row;
    match request.action {
        Action::Pick => {
            let plan = plan_pick(request, &picked, allocated.as_ref(), live_row.as_ref())?;
            let (kind, clear) = match plan {
                Plan::Replay => {
                    tx.commit().await?;
                    return Ok((live_row.unwrap_or(Value::Null), Vec::new(), "unchanged"));
                }
                Plan::Finalize { clear_location } => ("finalize", clear_location),
                Plan::Swap { clear_location, .. } => ("swap", clear_location),
                _ => return Err(ApiError::internal("Unexpected pick plan.")),
            };
            let location = live::field(&picked, "location", 120);
            let inserted: Option<Value> = sqlx::query_scalar(&insert_sql())
                .bind(seller)
                .bind(&request.order_id)
                .bind(&request.order_code)
                .bind(&request.item_id)
                .bind(&request.line_key)
                .bind(request.listing_id)
                .bind(request.allocated_listing_id)
                .bind(request.quantity as i32)
                .bind(kind)
                .bind(if clear { location.as_str() } else { "" })
                .bind(live::field(&picked, "card_id", 80))
                .bind(live::field(&picked, "marketplace_game", 40))
                .bind(request.unit_cents.map(|c| c as i32))
                .bind(&request.currency)
                .fetch_optional(&mut *tx)
                .await?;
            let Some(row) = inserted else {
                // A concurrent click recorded it first: answer that row.
                tx.rollback().await?;
                let existing: Option<Value> = sqlx::query_scalar(&live_pick_sql().replace(" for update", ""))
                    .bind(seller)
                    .bind(&request.order_id)
                    .bind(&request.item_id)
                    .bind(request.listing_id)
                    .fetch_optional(state.write_db())
                    .await?;
                return Ok((existing.unwrap_or(Value::Null), Vec::new(), "unchanged"));
            };
            if kind == "swap" {
                let allocated_uuid = allocated_id.ok_or_else(|| ApiError::internal("Swap without an allocated copy."))?;
                changed.push(apply_stock_delta(&mut tx, seller, request.listing_id, -request.quantity, now).await?);
                changed.push(apply_stock_delta(&mut tx, seller, allocated_uuid, request.quantity, now).await?);
            }
            if clear && !location.is_empty() {
                changed.push(set_location(&mut tx, seller, request.listing_id, "", now).await?);
            }
            inventory = match (kind, clear && !location.is_empty()) {
                ("swap", _) => "swapped",
                (_, true) => "removed",
                _ => "unchanged",
            };
            pick_row = row;
        }
        Action::Undo => {
            let plan = plan_undo(live_row.as_ref(), &picked, allocated.as_ref())?;
            let Some(row) = live_row else {
                tx.commit().await?;
                return Ok((Value::Null, Vec::new(), "unchanged"));
            };
            let restore = match &plan {
                Plan::UndoSwap { quantity, restore_location } => {
                    let allocated_uuid = allocated_id.ok_or_else(|| ApiError::internal("Swap pick without its allocated copy."))?;
                    changed.push(apply_stock_delta(&mut tx, seller, request.listing_id, *quantity, now).await?);
                    changed.push(apply_stock_delta(&mut tx, seller, allocated_uuid, -*quantity, now).await?);
                    restore_location.clone()
                }
                Plan::UndoFinalize { restore_location } => restore_location.clone(),
                _ => None,
            };
            if let Some(location) = &restore {
                changed.push(set_location(&mut tx, seller, request.listing_id, location, now).await?);
            }
            let undone: Option<Value> = sqlx::query_scalar(&undo_sql()).bind(&row["id"].as_i64()).fetch_optional(&mut *tx).await?;
            pick_row = undone.unwrap_or(row);
            inventory = if matches!(plan, Plan::UndoSwap { .. }) || restore.is_some() { "restored" } else { "unchanged" };
        }
    }
    tx.commit().await?;
    Ok((pick_row, changed.rows, inventory))
}

fn firestore() -> Result<pokoin_external::firebase::FirestoreRest, ApiError> {
    pokoin_external::firebase::FirestoreRest::from_env()
        .ok_or_else(|| ApiError::unavailable("Firebase Admin credentials are not configured."))
}

fn external(error: pokoin_external::ApiError) -> ApiError {
    let mut out = ApiError::new(StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_GATEWAY), error.message);
    out.code = error.code;
    out
}

/// `POST /api/cardtrader-zero-pick` — `{orderId, itemId, lineKey, listingId,
/// allocatedListingId, quantity, action: "pick" | "undo"}` moves inventory;
/// PR A's `{orderId, lineKey, picked?, issue?}` / `{orderId, reset}` stay on
/// Firestore and never touch stock.
pub async fn zero_pick(State(state): State<DomainState>, AuthedUser(claims): AuthedUser, body: Bytes) -> Response {
    let result = async {
        let payload: Value = serde_json::from_slice(&body).map_err(|_| bad("Send a JSON object.", "invalid_body"))?;
        match parse_pick_body(&payload)? {
            PickBody::Firestore(body) => {
                let request = ct_zero::parse_pick_request(&body).map_err(external)?;
                ct_zero::save_pick(&firestore()?, &claims.uid, &request).await.map_err(external)
            }
            PickBody::Inventory(request) => {
                let (pick, changed, inventory) = run_inventory_pick(&state, &claims.uid, &request).await?;
                let mut listings = Vec::new();
                for (row, queued) in changed {
                    let game = live::field(&row, "marketplace_game", 40);
                    let game = if game.is_empty() { "pokemon".to_string() } else { game };
                    listings.push(finish_write(&state, &row, queued, &game, &claims.uid).await?);
                }
                Ok(json!({
                    "ok": true,
                    "pick": if pick.is_null() { Value::Null } else { pick_json(&pick) },
                    "listings": listings,
                    "inventory": inventory,
                }))
            }
        }
    }
    .await;
    match result {
        Ok(value) => private_json(value),
        Err(error) => error.into_response(),
    }
}

const PICKED_SQL: &str = "select to_jsonb(v) from (select p.id, p.order_id, p.order_code, p.item_id, p.line_key, \
       p.listing_id::text as listing_id, coalesce(p.allocated_listing_id::text, '') as allocated_listing_id, p.kind, p.quantity, p.location_from, p.card_id, p.marketplace_game, p.unit_cents, \
       p.currency, to_char(p.picked_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as picked_at, \
       l.card_name, l.set_name, l.collector_number, l.condition, l.language, l.reverse, l.first_edition, l.card_image_url \
     from public.cardtrader_zero_picks p \
     left join public.marketplace_user_listings l on l.id = p.listing_id \
     where p.seller_uid = $1 and p.state = 'picked' \
     order by p.picked_at desc, p.id desc limit $2 offset $3) v";

pub fn picked_json(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "orderId": live::field(row, "order_id", 40),
        "orderCode": live::field(row, "order_code", 80),
        "itemId": live::field(row, "item_id", 40),
        "lineKey": live::field(row, "line_key", 120),
        "listingId": live::field(row, "listing_id", 80),
        "allocatedListingId": live::field(row, "allocated_listing_id", 80),
        "kind": live::field(row, "kind", 20),
        "quantity": row["quantity"],
        "locationFrom": live::field(row, "location_from", 120),
        "cardId": live::field(row, "card_id", 80),
        "name": live::field(row, "card_name", 240),
        "expansion": live::field(row, "set_name", 240),
        "collectorNumber": live::field(row, "collector_number", 80),
        "condition": live::field(row, "condition", 20),
        "language": live::field(row, "language", 10),
        "reverse": row["reverse"] == true,
        "firstEdition": row["first_edition"] == true,
        "imageUrl": live::field(row, "card_image_url", 800),
        "game": live::field(row, "marketplace_game", 40),
        "unitCents": row["unit_cents"],
        "currency": live::field(row, "currency", 8),
        "pickedAt": row["picked_at"],
    })
}

/// `GET /api/cardtrader-zero-picked?offset=` — the seller's picked copies,
/// newest first, 100 a page. Not listings: never stock, never pushed.
pub async fn zero_picked(State(state): State<DomainState>, AuthedUser(claims): AuthedUser, uri: Uri) -> Response {
    let offset = pokoin_api_common::http::Query::from_uri(&uri)
        .first("offset")
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|n| *n > 0)
        .map(|n| n.min(50_000))
        .unwrap_or(0);
    let result: Result<Value, ApiError> = async {
        let rows: Vec<Value> = sqlx::query_scalar(PICKED_SQL)
            .bind(&claims.uid)
            .bind(PAGE + 1)
            .bind(offset)
            .fetch_all(state.read_db())
            .await?;
        let more = rows.len() as i64 > PAGE;
        let rows: Vec<Value> = rows.iter().take(PAGE as usize).map(picked_json).collect();
        Ok(json!({ "rows": rows, "nextOffset": if more { json!(offset + PAGE) } else { Value::Null } }))
    }
    .await;
    match result {
        Ok(value) => private_json(value),
        Err(error) => error.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000b";

    fn listing(qty: i64, status: &str, location: &str) -> Value {
        json!({
            "id": A, "card_id": "202", "condition": "NM", "language": "EN", "reverse": false,
            "first_edition": false, "signed": false, "graded": false,
            "quantity_available": qty, "status": status, "location": location,
        })
    }

    fn request(action: &str, allocated: Option<&str>, quantity: i64) -> InventoryPick {
        let mut body = json!({ "action": action, "orderId": "9001", "itemId": "502", "lineKey": "502@a", "listingId": A, "quantity": quantity });
        if let Some(id) = allocated {
            body["allocatedListingId"] = json!(id);
        }
        match parse_pick_body(&body).unwrap() {
            PickBody::Inventory(request) => request,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn bodies_route_to_inventory_or_firestore() {
        // PR A bodies (issues, counts, reset) never reach the inventory.
        for body in [
            json!({ "orderId": "1", "lineKey": "2", "issue": { "type": "missing" } }),
            json!({ "orderId": "1", "lineKey": "2", "picked": 1 }),
            json!({ "orderId": "1", "reset": true }),
        ] {
            assert_eq!(parse_pick_body(&body).unwrap(), PickBody::Firestore(body.clone()));
        }
        // An unlinked line: a Firestore picked count.
        assert_eq!(
            parse_pick_body(&json!({ "action": "pick", "orderId": "1", "itemId": "2", "lineKey": "2", "quantity": 3 })).unwrap(),
            PickBody::Firestore(json!({ "orderId": "1", "lineKey": "2", "picked": 3 }))
        );
        assert_eq!(
            parse_pick_body(&json!({ "action": "undo", "orderId": "1", "itemId": "2", "lineKey": "2" })).unwrap(),
            PickBody::Firestore(json!({ "orderId": "1", "lineKey": "2", "picked": 0 }))
        );
        let pick = request("pick", Some(B), 2);
        assert_eq!(pick.allocated_listing_id, Some(uuid::Uuid::parse_str(B).unwrap()));
        assert_eq!(pick.quantity, 2);
        for (body, code) in [
            (json!({ "action": "take", "orderId": "1", "itemId": "2", "lineKey": "2", "listingId": A }), "invalid_action"),
            (json!({ "action": "pick", "orderId": "x", "itemId": "2", "lineKey": "2", "listingId": A }), "invalid_order"),
            (json!({ "action": "pick", "orderId": "1", "itemId": "", "lineKey": "2", "listingId": A }), "invalid_item"),
            (json!({ "action": "pick", "orderId": "1", "itemId": "2", "lineKey": "a b", "listingId": A }), "invalid_line"),
            (json!({ "action": "pick", "orderId": "1", "itemId": "2", "lineKey": "2", "listingId": "nope" }), "invalid_listing"),
            (json!({ "action": "pick", "orderId": "1", "itemId": "2", "lineKey": "2", "listingId": A, "quantity": 0 }), "invalid_quantity"),
            (json!({ "action": "pick", "orderId": "1", "itemId": "2", "lineKey": "2", "listingId": A, "quantity": 1000 }), "invalid_quantity"),
        ] {
            assert_eq!(parse_pick_body(&body).unwrap_err().code.as_deref(), Some(code), "{body}");
        }
    }

    #[test]
    fn finalize_clears_only_an_empty_copy() {
        let sold = listing(0, "sold_out", "box·1");
        assert_eq!(plan_pick(&request("pick", Some(A), 1), &sold, None, None).unwrap(), Plan::Finalize { clear_location: true });
        assert_eq!(plan_pick(&request("pick", None, 1), &sold, None, None).unwrap(), Plan::Finalize { clear_location: true });
        let multi = listing(2, "active", "box·1");
        assert_eq!(plan_pick(&request("pick", None, 1), &multi, None, None).unwrap(), Plan::Finalize { clear_location: false });
    }

    #[test]
    fn swap_needs_an_identical_copy_with_enough_stock() {
        let picked = listing(3, "active", "box·2");
        let mut allocated = listing(0, "sold_out", "box·1");
        allocated["id"] = json!(B);
        assert_eq!(
            plan_pick(&request("pick", Some(B), 2), &picked, Some(&allocated), None).unwrap(),
            Plan::Swap { quantity: 2, clear_location: false }
        );
        assert_eq!(
            plan_pick(&request("pick", Some(B), 3), &picked, Some(&allocated), None).unwrap(),
            Plan::Swap { quantity: 3, clear_location: true }
        );
        let error = plan_pick(&request("pick", Some(B), 4), &picked, Some(&allocated), None).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("insufficient_quantity"));
        for (key, value) in [
            ("card_id", json!("203")),
            ("condition", json!("SP")),
            ("language", json!("IT")),
            ("reverse", json!(true)),
            ("first_edition", json!(true)),
            ("signed", json!(true)),
            ("graded", json!(true)),
        ] {
            let mut other = allocated.clone();
            other[key] = value;
            let error = plan_pick(&request("pick", Some(B), 1), &picked, Some(&other), None).unwrap_err();
            assert_eq!(error.code.as_deref(), Some("not_identical"), "{key}");
        }
        // Case and blanks do not make copies different.
        let mut lower = allocated.clone();
        lower["condition"] = json!(" nm ");
        assert!(plan_pick(&request("pick", Some(B), 1), &picked, Some(&lower), None).is_ok());
    }

    #[test]
    fn a_replay_changes_nothing() {
        let picked = listing(3, "active", "box·2");
        let live_pick = json!({ "id": 1, "kind": "swap", "quantity": 1 });
        assert_eq!(plan_pick(&request("pick", Some(B), 1), &picked, None, Some(&live_pick)).unwrap(), Plan::Replay);
    }

    #[test]
    fn undo_reverses_the_recorded_row() {
        let blank = listing(0, "sold_out", "");
        let finalize = json!({ "id": 1, "kind": "finalize", "quantity": 1, "location_from": "box·1" });
        assert_eq!(plan_undo(Some(&finalize), &blank, None).unwrap(), Plan::UndoFinalize { restore_location: Some("box·1".into()) });
        // The seller set another location since: keep it.
        let moved = listing(0, "sold_out", "box·9");
        assert_eq!(plan_undo(Some(&finalize), &moved, None).unwrap(), Plan::UndoFinalize { restore_location: None });

        let swap = json!({ "id": 2, "kind": "swap", "quantity": 2, "location_from": "" });
        let picked = listing(1, "active", "box·2");
        let allocated = listing(2, "active", "box·1");
        assert_eq!(plan_undo(Some(&swap), &picked, Some(&allocated)).unwrap(), Plan::UndoSwap { quantity: 2, restore_location: None });
        let sold_again = listing(1, "active", "box·1");
        assert_eq!(plan_undo(Some(&swap), &picked, Some(&sold_again)).unwrap_err().code.as_deref(), Some("allocated_copy_gone"));
        assert_eq!(plan_undo(None, &picked, None).unwrap(), Plan::Nothing);
    }

    #[test]
    fn stock_delta_events_carry_the_change() {
        use super::super::listings::stock_delta_event;
        let before = json!({ "id": A, "card_id": "202", "seller_uid": "s", "source_listing_id": "ct:77", "price_pkn": 10, "quantity_available": 3, "status": "active", "marketplace_game": "pokemon" });
        let mut after = before.clone();
        after["quantity_available"] = json!(2);
        let event = stock_delta_event(&before, &after, "s", -1, false, 0).unwrap();
        assert_eq!(event["payload"]["mutation"], "LISTING_QUANTITY_CHANGED");
        assert_eq!(event["payload"]["cardtraderEdit"], json!({ "productId": "77", "quantityDelta": -1 }));
        assert_eq!(event["payload"]["destroyCardtrader"], false);

        // To 0: sold, the product goes (unless another copy shares it).
        let mut empty = before.clone();
        empty["quantity_available"] = json!(0);
        empty["status"] = json!("sold_out");
        let event = stock_delta_event(&before, &empty, "s", -3, false, 0).unwrap();
        assert_eq!(event["payload"]["mutation"], "LISTING_SOLD");
        assert_eq!(event["payload"]["destroyCardtrader"], true);
        assert_eq!(event["payload"]["cardtraderEdit"], Value::Null);
        let shared = stock_delta_event(&before, &empty, "s", -3, true, 0).unwrap();
        assert_eq!(shared["payload"]["destroyCardtrader"], false);
        assert_eq!(shared["payload"]["cardtraderEdit"], json!({ "productId": "77", "quantityDelta": -3 }));

        // Back from sold_out: reactivated, +n on its product like a board edit.
        let mut back = empty.clone();
        back["quantity_available"] = json!(2);
        back["status"] = json!("active");
        let event = stock_delta_event(&empty, &back, "s", 2, false, 0).unwrap();
        assert_eq!(event["payload"]["mutation"], "LISTING_REACTIVATED");
        assert_eq!(event["payload"]["cardtraderEdit"], json!({ "productId": "77", "quantityDelta": 2 }));
    }
}
