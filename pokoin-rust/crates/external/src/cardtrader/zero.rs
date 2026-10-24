//! CardTrader Zero picking list — native port of `_cardtrader_zero.js` and
//! `cardtrader-zero.js`. CardTrader Orders API is the source of truth; each
//! item becomes one line per box its copies leave (webhook allocations, else
//! the product's members); lines sort game, box, stack, position, then the
//! date the copy entered the inventory (docs/CARDTRADER_ZERO.md). Power Tools
//! is an optional read-only overlay of its own picking order; the seller's
//! sort is the Power Tools sort model (saved on `cardtrader_zero_settings`), and
//! Apply sort is the one user-triggered Power Tools write. Picked counts come
//! from Postgres `cardtrader_zero_picks` (pokoin-commerce moves the stock),
//! with Firestore picks as the fallback and the issue store.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::cardtrader::sync_core::{
    ct_condition_to_pokoin, ct_language_to_pokoin, marketplace_game_by_cardtrader_id, parse_ct_product_id,
};
use crate::cardtrader::webhook::{event_doc_id, EVENTS_COLLECTION};
use crate::error::{clean_text, clean_text_value, i64_field, truthy, ApiError, ApiResult};
use crate::powertools::id_text;

pub const WEEKLY_STATE: &str = "paid";
pub const PENDING_STATE: &str = "hub_pending";

pub fn is_zero_order(order: &Value) -> bool {
    order.get("via_cardtrader_zero") == Some(&Value::Bool(true))
}

pub fn order_state(order: &Value) -> String {
    clean_text(order.get("state").and_then(Value::as_str), 40).to_lowercase()
}

fn props_of(item: &Value) -> Value {
    item.get("properties_hash")
        .filter(|v| v.is_object())
        .or_else(|| item.get("properties").filter(|v| v.is_object()))
        .cloned()
        .unwrap_or(json!({}))
}

fn money_cents(money: &Value) -> Option<i64> {
    match money {
        Value::Null => None,
        Value::Object(map) => map.get("cents").and_then(Value::as_i64),
        Value::Number(n) => n.as_f64().map(|f| f.round() as i64),
        Value::String(s) => s.parse::<f64>().ok().map(|f| f.round() as i64),
        _ => None,
    }
}

fn money_currency(money: &Value) -> String {
    let currency = clean_text(money.get("currency").and_then(Value::as_str), 8).to_uppercase();
    if currency.is_empty() { "EUR".into() } else { currency }
}

fn quantity_of(item: &Value) -> i64 {
    i64_field(item, &["quantity"]).unwrap_or(0).max(0)
}

fn iso(value: &Value) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::String(text) => match crate::time_util::ms_from_iso(text) {
            Some(ms) => json!(crate::time_util::iso_from_ms(ms)),
            None => Value::Null,
        },
        _ => Value::Null,
    }
}

/// CardTrader game slug of an order item (`game_id`), or "".
fn item_game(item: &Value) -> String {
    i64_field(item, &["game_id", "gameId"])
        .or_else(|| item.get("blueprint").and_then(|b| i64_field(b, &["game_id", "gameId"])))
        .or_else(|| item.get("product").and_then(|p| i64_field(p, &["game_id", "gameId"])))
        .map(|id| marketplace_game_by_cardtrader_id(id).to_string())
        .unwrap_or_default()
}

/// Where a line's game came from, best first: the CardTrader item, the
/// blueprint catalogs, Power Tools, then the linked listing (whose column
/// defaults to 'pokemon', so it is the weakest answer).
fn game_source_rank(source: &str) -> u8 {
    match source {
        "cardtrader" => 0,
        "blueprint" => 1,
        "powertools" => 2,
        "listing" => 3,
        _ => 4,
    }
}

/// Take `game` when `source` beats the line's current answer.
fn offer_game(line: &mut Value, game: &str, source: &str) {
    let game = game.trim().to_lowercase();
    if game.is_empty() {
        return;
    }
    let current = text(line.get("gameSource"), 20);
    if text(line.get("game"), 40).is_empty() || game_source_rank(source) < game_source_rank(&current) {
        line["game"] = json!(game);
        line["gameSource"] = json!(source);
    }
}

/// Cardmarket game id (Power Tools `product.idGame`) → Pokoin game slug.
pub fn cardmarket_game(id: i64) -> &'static str {
    match id {
        1 => "magic",
        3 => "yugioh",
        6 => "pokemon",
        8 => "vanguard",
        13 => "dragon_ball_super",
        16 => "flesh_and_blood",
        17 => "digimon",
        18 => "one_piece",
        19 => "lorcana",
        21 => "star_wars",
        22 => "riftbound",
        23 => "cyberpunk",
        _ => "",
    }
}

fn article_game(article: &Value) -> &'static str {
    article
        .get("product")
        .and_then(|product| i64_field(product, &["idGame"]))
        .map(cardmarket_game)
        .unwrap_or("")
}

/// Rarity from the item or any `*rarity` property (pokemon_rarity, mtg_rarity, …).
fn item_rarity(item: &Value, props: &Value) -> String {
    let direct = clean_text(item.get("rarity").and_then(Value::as_str), 80);
    if !direct.is_empty() {
        return direct;
    }
    let Some(map) = props.as_object() else { return String::new() };
    let mut keys: Vec<&String> = map.keys().filter(|key| key.ends_with("rarity")).collect();
    keys.sort_by_key(|key| (key.as_str() != "rarity", key.as_str()));
    keys.into_iter()
        .map(|key| clean_text(map[key].as_str(), 80))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

/// `zeroItemRow` — one CT order item as a picking-list line.
pub fn zero_item_row(order: &Value, item: &Value) -> Value {
    let props = props_of(item);
    let product_id = clean_text(
        item.get("product_id")
            .or_else(|| item.get("productId"))
            .or_else(|| item.pointer("/product/id"))
            .and_then(crate::error::scalar_text).as_deref(),
        80,
    );
    let blueprint_id = clean_text(
        item.get("blueprint_id")
            .or_else(|| item.get("blueprintId"))
            .and_then(crate::error::scalar_text).as_deref(),
        80,
    );
    let unit_cents = money_cents(item.get("seller_price").unwrap_or(&Value::Null));
    let quantity = quantity_of(item);
    let language_raw = props
        .get("pokemon_language")
        .or_else(|| props.get("mtg_language"))
        .or_else(|| props.get("language"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    // Blank stays blank: an empty CardTrader language is the print language
    // (D00000F), never a defaulted EN on a picking list.
    let condition_raw = props.get("condition").and_then(Value::as_str).unwrap_or_default();
    let name = {
        let name = clean_text(item.get("name").and_then(Value::as_str), 240);
        if name.is_empty() {
            "Card".to_string()
        } else {
            name
        }
    };
    let expansion = {
        let raw = item.get("expansion").cloned().unwrap_or(Value::Null);
        match &raw {
            Value::Object(_) => clean_text_value(raw.get("name").unwrap_or(&Value::Null), 160),
            Value::String(_) => clean_text_value(&raw, 160),
            _ => String::new(),
        }
    };
    let listing_id = {
        let field = clean_text_value(
            item.get("user_data_field")
                .or_else(|| item.get("userDataField"))
                .unwrap_or(&Value::Null),
            160,
        );
        crate::cardtrader::sync_core::parse_pokoin_listing_id(&field)
    };
    let game = item_game(item);
    let game_source = if game.is_empty() { "" } else { "cardtrader" };
    let name_en = {
        let english = clean_text(
            item.get("name_en").or_else(|| item.get("nameEn")).or_else(|| item.get("en_name")).and_then(Value::as_str),
            240,
        );
        if english.to_lowercase() == name.to_lowercase() { String::new() } else { english }
    };
    json!({
        "orderId": clean_text_value(order.get("id").unwrap_or(&Value::Null), 40),
        "orderCode": clean_text_value(order.get("code").unwrap_or(&Value::Null), 80),
        "itemId": clean_text_value(item.get("id").unwrap_or(&Value::Null), 40),
        "productId": product_id,
        "blueprintId": blueprint_id,
        "cardId": crate::cardtrader::sync_core::public_card_id_from_blueprint(&blueprint_id).map(Value::String).unwrap_or(Value::Null),
        "hubPendingOrderId": clean_text_value(item.get("hub_pending_order_id").or_else(|| item.get("hubPendingOrderId")).unwrap_or(&Value::Null), 40),
        "name": name,
        "expansion": expansion,
        "collectorNumber": clean_text_value(props.get("collector_number").or_else(|| props.get("collectorNumber")).unwrap_or(&Value::Null), 40),
        "condition": if condition_raw.is_empty() { json!("") } else { json!(ct_condition_to_pokoin(condition_raw)) },
        "language": if language_raw.is_empty() { json!("") } else { json!(ct_language_to_pokoin(language_raw)) },
        "reverse": props.get("pokemon_reverse").map(truthy).unwrap_or(false)
            || props.get("mtg_foil").map(truthy).unwrap_or(false)
            || props.get("foil").map(truthy).unwrap_or(false),
        "firstEdition": props.get("pokemon_first_edition").map(truthy).unwrap_or(false)
            || props.get("first_edition").map(truthy).unwrap_or(false),
        "signed": props.get("signed").map(truthy).unwrap_or(false),
        "altered": props.get("altered").map(truthy).unwrap_or(false),
        "graded": item.get("graded").map(|v| truthy(v) || *v == json!(1)).unwrap_or(false) && item.get("graded") != Some(&json!("false")),
        "quantity": quantity,
        "unitCents": unit_cents.map(Value::from).unwrap_or(Value::Null),
        "lineCents": unit_cents.map(|cents| json!(cents * quantity)).unwrap_or(Value::Null),
        "currency": money_currency(item.get("seller_price").unwrap_or(&Value::Null)),
        "userDataField": clean_text_value(item.get("user_data_field").or_else(|| item.get("userDataField")).unwrap_or(&Value::Null), 160),
        "tag": clean_text_value(item.get("tag").unwrap_or(&Value::Null), 160),
        "soldAt": iso(item.get("created_at").filter(|v| !v.is_null()).or_else(|| order.get("paid_at")).or_else(|| order.get("created_at")).unwrap_or(&Value::Null)),
        "location": "",
        "listingId": listing_id,
        "game": game,
        "gameSource": game_source,
        "nameEn": name_en,
        "rarity": item_rarity(item, &props),
        "powerTools": Value::Null,
    })
}

fn order_summary(order: &Value) -> Value {
    let items: Vec<Value> = order
        .get("order_items")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|item| item.get("deleted_at").map(|v| v.is_null()).unwrap_or(true))
                .map(|item| zero_item_row(order, item))
                .collect()
        })
        .unwrap_or_default();
    json!({
        "orderId": clean_text_value(order.get("id").unwrap_or(&Value::Null), 40),
        "code": clean_text_value(order.get("code").unwrap_or(&Value::Null), 80),
        "state": order_state(order),
        "paidAt": iso(order.get("paid_at").unwrap_or(&Value::Null)),
        "createdAt": iso(order.get("created_at").unwrap_or(&Value::Null)),
        "packingNumber": order.get("packing_number").filter(|v| !v.is_null()).and_then(Value::as_i64),
        "presale": order.get("presale") == Some(&Value::Bool(true)),
        "sellerTotalCents": money_cents(order.get("seller_total").unwrap_or(&Value::Null)),
        "currency": money_currency(order.get("seller_total").unwrap_or(&Value::Null)),
        "items": items,
        "ptPicking": Value::Null,
        "pickedLines": 0,
        "issueCount": 0,
    })
}

fn totals_of(items: &[Value]) -> Value {
    let mut lines = 0i64;
    let mut units = 0i64;
    let mut cents = 0i64;
    for item in items {
        lines += 1;
        units += item.get("quantity").and_then(Value::as_i64).unwrap_or(0);
        cents += item.get("lineCents").and_then(Value::as_i64).unwrap_or(0);
    }
    json!({ "lines": lines, "units": units, "cents": cents })
}

/// `buildZeroList` — weekly merged paid order + pending hub_pending sales.
pub fn build_zero_list(orders: &[Value]) -> Value {
    let mut seen = std::collections::HashSet::new();
    let mut weekly = Vec::new();
    let mut pending_orders = Vec::new();
    for order in orders {
        if !is_zero_order(order) {
            continue;
        }
        let id = clean_text_value(order.get("id").unwrap_or(&Value::Null), 40);
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let state = order_state(order);
        if state == WEEKLY_STATE {
            weekly.push(order_summary(order));
        } else if state == PENDING_STATE {
            pending_orders.push(order_summary(order));
        }
    }
    weekly.sort_by(|a, b| {
        b.get("paidAt").and_then(Value::as_str).unwrap_or("").cmp(a.get("paidAt").and_then(Value::as_str).unwrap_or(""))
    });
    let weekly_items: Vec<Value> = weekly.iter().flat_map(|o| o["items"].as_array().cloned().unwrap_or_default()).collect();
    let pending_items: Vec<Value> = pending_orders.iter().flat_map(|o| o["items"].as_array().cloned().unwrap_or_default()).collect();
    json!({
        "weekly": weekly,
        "pending": { "orderCount": pending_orders.len(), "items": pending_items },
        "totals": { "weekly": totals_of(&weekly_items), "pending": totals_of(&pending_items) },
    })
}

fn all_items(list: &Value) -> Vec<Value> {
    let mut items: Vec<Value> = list
        .get("weekly")
        .and_then(Value::as_array)
        .map(|orders| orders.iter().flat_map(|o| o["items"].as_array().cloned().unwrap_or_default()).collect())
        .unwrap_or_default();
    items.extend(list.pointer("/pending/items").and_then(Value::as_array).cloned().unwrap_or_default());
    items
}

/// CT product ids → `ct:<id>` source ids of the linked Pokoin listings.
pub fn linked_source_ids(list: &Value) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in all_items(list) {
        let product_id = clean_text_value(item.get("productId").unwrap_or(&Value::Null), 80);
        if !product_id.is_empty() && seen.insert(product_id.clone()) {
            out.push(crate::cardtrader::sync_core::ct_source_listing_id(&product_id));
        }
    }
    out
}

// ------------------------------------------------------------ one line per box

/// Firestore collection of the server-side picked state.
pub const PICKS_COLLECTION: &str = "cardtrader_zero_picks";

fn text(value: Option<&Value>, max: usize) -> String {
    clean_text_value(value.unwrap_or(&Value::Null), max)
}

/// One `{listingId, quantity}` of a sale's webhook event doc.
#[derive(Clone, Debug, PartialEq)]
pub struct Allocation {
    pub listing_id: String,
    pub quantity: i64,
}

/// The `allocations` of a webhook event doc, or None when the doc carries no
/// array (1-Day Ready docs have none).
pub fn event_allocations(data: &Value) -> Option<Vec<Allocation>> {
    let rows = data.get("allocations")?.as_array()?;
    Some(
        rows.iter()
            .filter_map(|row| {
                let listing_id = id_text(row.get("listingId").unwrap_or(&Value::Null));
                if listing_id.is_empty() {
                    return None;
                }
                Some(Allocation { listing_id, quantity: i64_field(row, &["quantity"]).unwrap_or(1).max(0) })
            })
            .collect(),
    )
}

/// Event doc ids to try for one line: the hub_pending order (where Zero
/// decrements) first, then the line's own order.
fn event_doc_candidates(uid: &str, item: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let item_id = text(item.get("itemId"), 40);
    if item_id.is_empty() {
        return out;
    }
    for order_id in [text(item.get("hubPendingOrderId"), 40), text(item.get("orderId"), 40)] {
        if order_id.is_empty() {
            continue;
        }
        let id = event_doc_id(uid, &order_id, &item_id);
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Webhook allocations per CardTrader item id: every candidate event doc of
/// the pack in one batched read (a 135-line pack was ~270 sequential-ish
/// gets). Missing docs, or a failed read, leave the members fallback.
pub async fn read_allocations(
    firestore: &dyn crate::firebase::FirestoreStore,
    uid: &str,
    list: &Value,
) -> HashMap<String, Vec<Allocation>> {
    let jobs: Vec<(String, Vec<String>)> = all_items(list)
        .iter()
        .map(|item| (text(item.get("itemId"), 40), event_doc_candidates(uid, item)))
        .filter(|(item_id, ids)| !item_id.is_empty() && !ids.is_empty())
        .collect();
    let mut ids: Vec<String> = Vec::new();
    for id in jobs.iter().flat_map(|(_, candidates)| candidates) {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    let Ok(docs) = firestore.get_docs(EVENTS_COLLECTION, &ids).await else { return HashMap::new() };
    let by_id: HashMap<&String, &crate::firebase::FirestoreDoc> = ids.iter().zip(docs.iter()).collect();
    jobs.into_iter()
        .filter_map(|(item_id, candidates)| {
            candidates.iter().find_map(|id| {
                let doc = by_id.get(id).filter(|doc| doc.exists)?;
                event_allocations(&doc.data).filter(|rows| !rows.is_empty()).map(|rows| (item_id.clone(), rows))
            })
        })
        .collect()
}

/// Listing ids the lines name: webhook allocations plus `user_data_field`.
pub fn linked_listing_ids(list: &Value, allocations: &HashMap<String, Vec<Allocation>>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let named = all_items(list).iter().map(|item| text(item.get("listingId"), 80)).collect::<Vec<_>>();
    let allocated = allocations.values().flatten().map(|row| row.listing_id.clone());
    for id in named.into_iter().chain(allocated) {
        if !id.is_empty() && seen.insert(id.clone()) {
            out.push(id);
        }
    }
    out
}

/// The seller's rows by id and by CardTrader product (members oldest first).
struct ListingIndex<'a> {
    by_id: HashMap<String, &'a Value>,
    members: HashMap<String, Vec<&'a Value>>,
}

fn listed_ms(row: &Value) -> Option<i64> {
    row.get("created_at").and_then(Value::as_str).and_then(crate::time_util::ms_from_iso)
}

fn oldest_first(a: &&Value, b: &&Value) -> Ordering {
    option_first(listed_ms(a), listed_ms(b))
        .then_with(|| id_cmp(&text(a.get("id"), 80), &text(b.get("id"), 80)))
}

impl<'a> ListingIndex<'a> {
    fn new(rows: &'a [Value]) -> Self {
        let mut by_id = HashMap::new();
        let mut members: HashMap<String, Vec<&'a Value>> = HashMap::new();
        for row in rows {
            let id = text(row.get("id"), 80);
            if !id.is_empty() {
                by_id.insert(id, row);
            }
            let product = parse_ct_product_id(&text(row.get("source_listing_id"), 160));
            if !product.is_empty() {
                members.entry(product).or_default().push(row);
            }
        }
        for group in members.values_mut() {
            group.sort_by(oldest_first);
        }
        Self { by_id, members }
    }
}

fn slot_json(slot: &Slot) -> Value {
    json!({ "box": slot.box_name, "stack": slot.stack, "position": slot.position })
}

/// One picking line of `item`, tied to `row` / `listing_id` when given.
fn make_line(item: &Value, row: Option<&Value>, listing_id: &str, quantity: i64, allocation: &str, also_in: Vec<String>) -> Value {
    let mut line = item.clone();
    let item_id = text(item.get("itemId"), 40);
    let linked = !listing_id.is_empty() && (row.is_some() || allocation == "event");
    line["lineKey"] = json!(if linked { format!("{item_id}@{listing_id}") } else { item_id });
    line["quantity"] = json!(quantity);
    line["itemQuantity"] = json!(quantity_of(item));
    line["lineCents"] = item
        .get("unitCents")
        .and_then(Value::as_i64)
        .map(|cents| json!(cents * quantity))
        .unwrap_or(Value::Null);
    if linked {
        line["listingId"] = json!(listing_id);
    }
    let location = row.map(|r| text(r.get("location"), 120)).unwrap_or_default();
    if let Some(row) = row {
        let card_id = text(row.get("card_id"), 80);
        if !card_id.is_empty() {
            line["cardId"] = json!(card_id);
        }
        if text(line.get("collectorNumber"), 40).is_empty() {
            let collector = text(row.get("collector_number"), 40);
            if !collector.is_empty() {
                line["collectorNumber"] = json!(collector);
            }
        }
        let image = text(row.get("card_image_url"), 800);
        if !image.is_empty() {
            line["imageUrl"] = json!(image);
        }
        offer_game(&mut line, &text(row.get("marketplace_game"), 40), "listing");
        if text(line.get("nameEn"), 240).is_empty() {
            let english = text(row.get("card_name"), 240);
            let name = text(line.get("name"), 240);
            if !english.is_empty() && english.to_lowercase() != name.to_lowercase() {
                line["nameEn"] = json!(english);
            }
        }
    }
    // created_at is selected as UTC ISO text; anything unparseable is null.
    // The copy's own stock, for "(N available)"; null when unlinked.
    line["quantityAvailable"] = row
        .and_then(|r| i64_field(r, &["quantity_available"]))
        .map(Value::from)
        .unwrap_or(Value::Null);
    line["listedAt"] = row
        .filter(|r| listed_ms(r).is_some())
        .map(|r| json!(text(r.get("created_at"), 40)))
        .unwrap_or(Value::Null);
    line["slot"] = slot_json(&parse_slot(&location));
    line["locationSource"] = json!(if location.is_empty() { "" } else { "pokoin" });
    line["sortLocation"] = json!(location.clone());
    line["ptLocation"] = json!("");
    line["location"] = json!(location);
    line["allocation"] = json!(allocation);
    line["alsoIn"] = json!(also_in);
    line["picked"] = json!(0);
    line["issue"] = Value::Null;
    line
}

/// Allocations merged per listing, reconciled to the item quantity: a short
/// sum puts the remainder on the first line, an excess trims from the last.
fn reconcile_allocations(allocations: &[Allocation], quantity: i64) -> Vec<(String, i64)> {
    let mut merged: Vec<(String, i64)> = Vec::new();
    for row in allocations {
        match merged.iter_mut().find(|(id, _)| *id == row.listing_id) {
            Some(entry) => entry.1 += row.quantity,
            None => merged.push((row.listing_id.clone(), row.quantity)),
        }
    }
    let sum: i64 = merged.iter().map(|(_, q)| q).sum();
    if sum < quantity {
        merged[0].1 += quantity - sum;
    } else if sum > quantity {
        let mut excess = sum - quantity;
        for entry in merged.iter_mut().rev() {
            let cut = excess.min(entry.1);
            entry.1 -= cut;
            excess -= cut;
        }
        merged.retain(|(_, q)| *q > 0);
    }
    merged
}

/// One CardTrader item → its picking lines (one per box it is taken from).
/// Identical copies a line could also be picked from: the other members of
/// its CardTrader product (members fallback, or a grouped product), the
/// listing the item names first, then oldest; the line's own listing excluded;
/// only rows still holding copies (`quantity_available > 0`, active or paused).
fn line_candidates(line: &Value, index: &ListingIndex) -> Vec<Value> {
    let own = text(line.get("listingId"), 80);
    let named = text(line.get("namedListingId"), 80);
    let mut product = text(line.get("productId"), 80);
    if !index.members.contains_key(&product) {
        product = index
            .by_id
            .get(&own)
            .map(|row| parse_ct_product_id(&text(row.get("source_listing_id"), 160)))
            .unwrap_or_default();
    }
    let Some(members) = index.members.get(&product) else { return Vec::new() };
    let mut rows: Vec<&Value> = members
        .iter()
        .copied()
        .filter(|row| text(row.get("id"), 80) != own)
        .filter(|row| i64_field(row, &["quantity_available"]).unwrap_or(0) > 0)
        .filter(|row| matches!(text(row.get("status"), 20).as_str(), "active" | "paused"))
        .collect();
    // Stable: members are oldest first already.
    rows.sort_by_key(|row| named.is_empty() || text(row.get("id"), 80) != named);
    rows.into_iter()
        .map(|row| {
            json!({
                "listingId": text(row.get("id"), 80),
                "location": text(row.get("location"), 120),
                "quantityAvailable": i64_field(row, &["quantity_available"]).unwrap_or(0),
            })
        })
        .collect()
}

fn split_item(item: &Value, index: &ListingIndex, allocations: Option<&Vec<Allocation>>) -> Vec<Value> {
    let named = text(item.get("listingId"), 80);
    split_item_lines(item, index, allocations)
        .into_iter()
        .map(|mut line| {
            line["namedListingId"] = json!(named);
            line["candidates"] = json!(line_candidates(&line, index));
            if let Some(map) = line.as_object_mut() {
                map.remove("namedListingId");
            }
            line
        })
        .collect()
}

fn split_item_lines(item: &Value, index: &ListingIndex, allocations: Option<&Vec<Allocation>>) -> Vec<Value> {
    let quantity = quantity_of(item);
    let named = text(item.get("listingId"), 80);
    if let Some(allocations) = allocations.filter(|rows| !rows.is_empty()) {
        let lines: Vec<Value> = reconcile_allocations(allocations, quantity)
            .into_iter()
            .map(|(id, q)| make_line(item, index.by_id.get(&id).copied(), &id, q, "event", Vec::new()))
            .collect();
        if !lines.is_empty() {
            return lines;
        }
    }
    let product = text(item.get("productId"), 80);
    if let Some(members) = index.members.get(&product).filter(|rows| !rows.is_empty()) {
        if members.len() == 1 {
            let row = members[0];
            return vec![make_line(item, Some(row), &text(row.get("id"), 80), quantity, "listing", Vec::new())];
        }
        let primary = members
            .iter()
            .copied()
            .find(|row| !named.is_empty() && text(row.get("id"), 80) == named)
            .unwrap_or(members[0]);
        let primary_id = text(primary.get("id"), 80);
        let primary_location = text(primary.get("location"), 120);
        let mut also_in: Vec<String> = Vec::new();
        for row in members.iter().filter(|row| text(row.get("id"), 80) != primary_id) {
            let location = text(row.get("location"), 120);
            if !location.is_empty() && location != primary_location && !also_in.contains(&location) {
                also_in.push(location);
            }
        }
        return vec![make_line(item, Some(primary), &primary_id, quantity, "members", also_in)];
    }
    if let Some(row) = index.by_id.get(&named).filter(|_| !named.is_empty()) {
        return vec![make_line(item, Some(row), &named, quantity, "listing", Vec::new())];
    }
    vec![make_line(item, None, "", quantity, "none", Vec::new())]
}

/// Expand every CardTrader item into one line per box: webhook allocations
/// first, then the product's members, then the listing the item names.
/// Never last-row-wins.
/// `blueprint_games` maps a CardTrader blueprint id to the one game catalog
/// holding it (see [`blueprint_games`]).
pub fn split_lines(
    list: &mut Value,
    rows: &[Value],
    allocations: &HashMap<String, Vec<Allocation>>,
    blueprint_games: &HashMap<String, String>,
) {
    let index = ListingIndex::new(rows);
    let expand = |items: &mut Value| {
        let Some(rows) = items.as_array() else { return };
        let lines: Vec<Value> = rows
            .iter()
            .flat_map(|item| {
                let mut item = item.clone();
                if let Some(game) = blueprint_games.get(&text(item.get("blueprintId"), 80)) {
                    offer_game(&mut item, game, "blueprint");
                }
                split_item(&item, &index, allocations.get(&text(item.get("itemId"), 40)))
            })
            .collect();
        *items = Value::Array(lines);
    };
    if let Some(orders) = list.get_mut("weekly").and_then(Value::as_array_mut) {
        for order in orders.iter_mut() {
            if let Some(items) = order.get_mut("items") {
                expand(items);
            }
        }
    }
    if let Some(items) = list.pointer_mut("/pending/items") {
        expand(items);
    }
    let weekly_items: Vec<Value> = list["weekly"]
        .as_array()
        .map(|orders| orders.iter().flat_map(|o| o["items"].as_array().cloned().unwrap_or_default()).collect())
        .unwrap_or_default();
    let pending_items = list.pointer("/pending/items").and_then(Value::as_array).cloned().unwrap_or_default();
    list["totals"] = json!({ "weekly": totals_of(&weekly_items), "pending": totals_of(&pending_items) });
}

// ------------------------------------------------------------ picking order

/// Case-insensitive natural compare: digit runs compare by value (leading
/// zeros ignored, length then digits, so no run ever overflows).
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let a: Vec<char> = a.to_lowercase().chars().collect();
    let b: Vec<char> = b.to_lowercase().chars().collect();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let start_a = i;
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            let start_b = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let run_a: String = a[start_a..i].iter().collect();
            let run_b: String = b[start_b..j].iter().collect();
            match digits_cmp(&run_a, &run_b) {
                Ordering::Equal => continue,
                other => return other,
            }
        }
        match a[i].cmp(&b[j]) {
            Ordering::Equal => {
                i += 1;
                j += 1;
            }
            other => return other,
        }
    }
    (a.len() - i).cmp(&(b.len() - j))
}

fn digits_cmp(a: &str, b: &str) -> Ordering {
    let a = a.trim_start_matches('0');
    let b = b.trim_start_matches('0');
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

/// Ids compare numerically when both are all digits, else naturally.
pub fn id_cmp(a: &str, b: &str) -> Ordering {
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    if digits(a) && digits(b) {
        digits_cmp(a, b)
    } else {
        natural_cmp(a, b)
    }
}

/// Present values first, ascending.
fn option_first<T: Ord>(a: Option<T>, b: Option<T>) -> Ordering {
    match (a, b) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// A MyPokoin location as `parseListingLocation` reads it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Slot {
    pub box_name: String,
    pub stack: Option<i64>,
    pub position: Option<i64>,
}

/// JS `parseInt(part, 10)`: optional leading whitespace and sign, then the
/// leading digits; None when there are none.
fn js_parse_int(part: &str) -> Option<i64> {
    let trimmed = part.trim_start();
    let (negative, rest) = match trimmed.chars().next() {
        Some('-') => (true, &trimmed[1..]),
        Some('+') => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let value = digits.parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

/// Port of JS `parseListingLocation` (market/src/inventory-listings.js): box
/// before the first `·`/`•`; the tail's parts parsed like parseInt, keeping
/// n > 0; stack = first number, position = second.
pub fn parse_slot(location: &str) -> Slot {
    let text = location.trim();
    let Some(sep) = text.find(['·', '•']) else {
        return Slot { box_name: text.to_string(), stack: None, position: None };
    };
    let box_name = text[..sep].trim().to_string();
    let sep_len = text[sep..].chars().next().map(char::len_utf8).unwrap_or(1);
    let numbers: Vec<i64> = text[sep + sep_len..]
        .split(['·', '•'])
        .filter_map(js_parse_int)
        .filter(|n| *n > 0)
        .collect();
    Slot { box_name, stack: numbers.first().copied(), position: numbers.get(1).copied() }
}

/// magic, pokemon, yugioh, riftbound, every other known game, unknown last.
pub fn game_rank(game: &str) -> u8 {
    match game {
        "magic" => 0,
        "pokemon" => 1,
        "yugioh" => 2,
        "riftbound" => 3,
        "" => 5,
        _ => 4,
    }
}

/// The picking order of docs/CARDTRADER_ZERO.md: game, located first, box,
/// stack (bare box last), position, listed date, listing id, then the
/// CardTrader identity of unlinked lines.
pub fn compare_picking_lines(a: &Value, b: &Value) -> Ordering {
    let game_a = text(a.get("game"), 40).to_lowercase();
    let game_b = text(b.get("game"), 40).to_lowercase();
    let (location_a, source_a) = effective_location(a);
    let (location_b, source_b) = effective_location(b);
    let slot_a = rank_slot(&location_a, source_a);
    let slot_b = rank_slot(&location_b, source_b);
    game_rank(&game_a)
        .cmp(&game_rank(&game_b))
        .then_with(|| game_a.cmp(&game_b))
        .then_with(|| location_a.is_empty().cmp(&location_b.is_empty()))
        .then_with(|| natural_cmp(&slot_a.box_name, &slot_b.box_name))
        .then_with(|| option_first(slot_a.stack, slot_b.stack))
        .then_with(|| option_first(slot_a.position, slot_b.position))
        .then_with(|| option_first(line_listed_ms(a), line_listed_ms(b)))
        .then_with(|| {
            let (id_a, id_b) = (text(a.get("listingId"), 80), text(b.get("listingId"), 80));
            id_a.is_empty().cmp(&id_b.is_empty()).then_with(|| id_cmp(&id_a, &id_b))
        })
        .then_with(|| natural_cmp(&text(a.get("expansion"), 160), &text(b.get("expansion"), 160)))
        .then_with(|| natural_cmp(&text(a.get("collectorNumber"), 40), &text(b.get("collectorNumber"), 40)))
        .then_with(|| natural_cmp(&text(a.get("name"), 240), &text(b.get("name"), 240)))
        .then_with(|| id_cmp(&text(a.get("itemId"), 40), &text(b.get("itemId"), 40)))
        .then_with(|| text(a.get("lineKey"), 200).cmp(&text(b.get("lineKey"), 200)))
}

/// The location a line is ranked by: its Pokoin location, else the Power
/// Tools location the overlay gave it.
pub fn effective_location(line: &Value) -> (String, &'static str) {
    let pokoin = text(line.get("location"), 120);
    if !pokoin.is_empty() {
        return (pokoin, "pokoin");
    }
    let pt = pt_display_location(&text(line.get("ptLocation"), 120));
    if !pt.is_empty() {
        return (pt, "powertools");
    }
    (String::new(), "")
}

/// A Power Tools location name in the Pokoin slot model: `·`/`•` names parse
/// like Pokoin locations, others with the PT import grammar
/// (`trailing_stack`: "BOX 001 - 131" → box "BOX 001" stack 131).
pub fn pt_slot(name: &str) -> Slot {
    let name = name.trim();
    if name.contains(['·', '•']) {
        return parse_slot(name);
    }
    let (box_name, stack, _, matched) = crate::powertools::parse_power_tools_location(name, "trailing_stack");
    if matched {
        Slot { box_name, stack: Some(stack), position: None }
    } else {
        Slot { box_name: name.to_string(), stack: None, position: None }
    }
}

fn rank_slot(location: &str, source: &str) -> Slot {
    if source == "powertools" { pt_slot(location) } else { parse_slot(location) }
}

/// Stamp `locationSource`, `sortLocation`, and `slot` from the effective location.
pub fn stamp_sort_locations(list: &mut Value) {
    for_each_line(list, |line| {
        let (location, source) = effective_location(line);
        line["slot"] = slot_json(&rank_slot(&location, source));
        line["locationSource"] = json!(source);
        line["sortLocation"] = json!(location);
    });
}

fn line_listed_ms(line: &Value) -> Option<i64> {
    line.get("listedAt").and_then(Value::as_str).and_then(crate::time_util::ms_from_iso)
}

pub fn sort_for_picking(list: &mut Value) -> Value {
    let defaults = default_sorting_fields();
    sort_for_picking_with(list, &defaults)
}

/// [`sort_for_picking`] with the seller's sorting levels.
pub fn sort_for_picking_with(list: &mut Value, fields: &[String]) -> Value {
    stamp_sort_locations(list);
    let compare = |a: &Value, b: &Value| compare_with_fields(a, b, fields);
    if let Some(orders) = list.get_mut("weekly").and_then(Value::as_array_mut) {
        for order in orders.iter_mut() {
            if let Some(items) = order.get_mut("items").and_then(Value::as_array_mut) {
                items.sort_by(compare);
            }
        }
    }
    if let Some(items) = list.pointer_mut("/pending/items").and_then(Value::as_array_mut) {
        items.sort_by(compare);
    }
    list.clone()
}

// ------------------------------------------------------------ sort model

/// Power Tools' picking sort values (level 0, category, is locked and not
/// part of the list). Every value but `none` and `extras` takes `.asc`/`.desc`.
pub const SORT_VALUES: [&str; 18] = [
    "none",
    "extras",
    "game",
    "location",
    "cn",
    "condition",
    "language",
    "comment",
    "price",
    "orderBin",
    "color",
    "releaseDate",
    "set",
    "releaseExpCode",
    "product.expansion",
    "product.rarity",
    "product.enName",
    "product.locName",
];
pub const MAX_SORT_LEVELS: usize = 4;
/// Equal to PR A's fixed order: game, then location.
pub const DEFAULT_SORTING_FIELDS: [&str; MAX_SORT_LEVELS] = ["game.asc", "location.asc", "none", "none"];

pub fn default_sorting_fields() -> Vec<String> {
    DEFAULT_SORTING_FIELDS.iter().map(|field| field.to_string()).collect()
}

/// `(name, descending)` of one level; None for `none`.
fn sort_level(field: &str) -> Option<(&str, bool)> {
    if field == "none" {
        return None;
    }
    if field == "extras" {
        return Some(("extras", false));
    }
    let (name, direction) = field.rsplit_once('.')?;
    Some((name, direction == "desc"))
}

/// Validate a sorting list: at most four levels of known values, `none` only
/// after the last real level, no field twice (whatever its direction). The
/// answer is padded with `none` to four levels.
pub fn parse_sorting_fields(raw: &Value) -> ApiResult<Vec<String>> {
    let invalid = |message: &str| ApiError::bad_request(message).with_code("invalid_sorting_fields");
    let Some(entries) = raw.as_array() else {
        return Err(invalid("sortingFields must be a list."));
    };
    if entries.len() > MAX_SORT_LEVELS {
        return Err(invalid("At most four sorting levels."));
    }
    let mut out: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut ended = false;
    for entry in entries {
        let field = entry.as_str().map(str::trim).unwrap_or_default();
        let known = match field {
            "none" | "extras" => true,
            _ => field
                .rsplit_once('.')
                .map(|(name, direction)| {
                    matches!(direction, "asc" | "desc") && name != "none" && name != "extras" && SORT_VALUES.contains(&name)
                })
                .unwrap_or(false),
        };
        if !known {
            return Err(ApiError::bad_request(format!("Unknown sorting field: {}", clean_text(Some(field), 40)))
                .with_code("invalid_sorting_field"));
        }
        match sort_level(field) {
            None => ended = true,
            Some((name, _)) => {
                if ended {
                    return Err(invalid("none is only allowed after the last sorting level."));
                }
                if seen.iter().any(|done| done == name) {
                    return Err(ApiError::bad_request(format!("{name} is sorted twice."))
                        .with_code("duplicate_sorting_field"));
                }
                seen.push(name.to_string());
            }
        }
        out.push(field.to_string());
    }
    out.resize(MAX_SORT_LEVELS, "none".to_string());
    Ok(out)
}

/// Condition grade, NM first; unknown last.
fn condition_rank(condition: &str) -> Option<u8> {
    match condition.trim().to_lowercase().as_str() {
        "nm" | "mint" | "near mint" => Some(0),
        "sp" | "ex" | "slightly played" | "lp" => Some(1),
        "mp" | "gd" | "moderately played" => Some(2),
        "pl" | "lp-pl" | "played" | "hp" => Some(3),
        "poor" | "po" => Some(4),
        _ => None,
    }
}

/// Rarity, common to rare (Pokémon then MTG ladders share the scale); unknown last.
pub fn rarity_rank(rarity: &str) -> Option<u8> {
    match rarity.trim().to_lowercase().as_str() {
        "common" => Some(0),
        "uncommon" => Some(1),
        "rare" => Some(2),
        "holo rare" | "rare holo" => Some(3),
        "mythic" | "mythic rare" => Some(3),
        "reverse holo" | "reverse holo rare" => Some(4),
        "double rare" => Some(5),
        "ultra rare" => Some(6),
        "illustration rare" => Some(7),
        "special illustration rare" => Some(8),
        "hyper rare" | "secret rare" => Some(9),
        "promo" => Some(10),
        _ => None,
    }
}

/// Present values first; present values compare by `cmp`, reversed when `desc`.
fn present_first<T>(a: Option<T>, b: Option<T>, desc: bool, cmp: impl Fn(&T, &T) -> Ordering) -> Ordering {
    match (a, b) {
        (Some(x), Some(y)) => {
            let order = cmp(&x, &y);
            if desc { order.reverse() } else { order }
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn nonempty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

/// Natural compare of one text field, blanks last in both directions.
fn text_level(a: &Value, b: &Value, key: &str, desc: bool) -> Ordering {
    present_first(nonempty(text(a.get(key), 240)), nonempty(text(b.get(key), 240)), desc, |x, y| natural_cmp(x, y))
}

/// The location level: located first (both directions), then box, stack
/// (stacked before bare), position (positioned first), listed date, listing
/// id. `desc` reverses box, stack, and position values only.
fn location_level(a: &Value, b: &Value, desc: bool) -> Ordering {
    let (location_a, source_a) = effective_location(a);
    let (location_b, source_b) = effective_location(b);
    let slot_a = rank_slot(&location_a, source_a);
    let slot_b = rank_slot(&location_b, source_b);
    let flip = |order: Ordering| if desc { order.reverse() } else { order };
    location_a
        .is_empty()
        .cmp(&location_b.is_empty())
        .then_with(|| flip(natural_cmp(&slot_a.box_name, &slot_b.box_name)))
        .then_with(|| present_first(slot_a.stack, slot_b.stack, desc, |x, y| x.cmp(y)))
        .then_with(|| present_first(slot_a.position, slot_b.position, desc, |x, y| x.cmp(y)))
        .then_with(|| option_first(line_listed_ms(a), line_listed_ms(b)))
        .then_with(|| {
            let (id_a, id_b) = (text(a.get("listingId"), 80), text(b.get("listingId"), 80));
            id_a.is_empty().cmp(&id_b.is_empty()).then_with(|| id_cmp(&id_a, &id_b))
        })
}

fn game_level(a: &Value, b: &Value, desc: bool) -> Ordering {
    let game_a = text(a.get("game"), 40).to_lowercase();
    let game_b = text(b.get("game"), 40).to_lowercase();
    let order = game_rank(&game_a).cmp(&game_rank(&game_b)).then_with(|| game_a.cmp(&game_b));
    if desc { order.reverse() } else { order }
}

fn compare_level(a: &Value, b: &Value, name: &str, desc: bool) -> Ordering {
    match name {
        "game" => game_level(a, b, desc),
        "location" => location_level(a, b, desc),
        "cn" => text_level(a, b, "collectorNumber", desc),
        "condition" => present_first(
            condition_rank(&text(a.get("condition"), 20)),
            condition_rank(&text(b.get("condition"), 20)),
            desc,
            |x, y| x.cmp(y),
        ),
        "language" => text_level(a, b, "language", desc),
        "price" => present_first(
            a.get("unitCents").and_then(Value::as_i64),
            b.get("unitCents").and_then(Value::as_i64),
            desc,
            |x, y| x.cmp(y),
        ),
        "orderBin" => present_first(
            nonempty(text(a.pointer("/powerTools/bin"), 80)),
            nonempty(text(b.pointer("/powerTools/bin"), 80)),
            desc,
            |x, y| natural_cmp(x, y),
        ),
        "product.rarity" => present_first(
            rarity_rank(&text(a.get("rarity"), 80)),
            rarity_rank(&text(b.get("rarity"), 80)),
            desc,
            |x, y| x.cmp(y),
        ),
        "set" | "product.expansion" => text_level(a, b, "expansion", desc),
        "product.enName" => {
            let english = |line: &Value| nonempty(text(line.get("nameEn"), 240)).or_else(|| nonempty(text(line.get("name"), 240)));
            present_first(english(a), english(b), desc, |x, y| natural_cmp(x, y))
        }
        "product.locName" => text_level(a, b, "name", desc),
        // Lines carry these only when a source fills them; blanks go last.
        "comment" | "color" | "releaseDate" | "releaseExpCode" | "extras" => text_level(a, b, name, desc),
        _ => Ordering::Equal,
    }
}

/// The seller's levels in order, then PR A's full default comparator, so the
/// order is total.
pub fn compare_with_fields(a: &Value, b: &Value, fields: &[String]) -> Ordering {
    for field in fields {
        let Some((name, desc)) = sort_level(field) else { continue };
        let order = compare_level(a, b, name, desc);
        if order != Ordering::Equal {
            return order;
        }
    }
    compare_picking_lines(a, b)
}

// ------------------------------------------------------------ seller settings

/// Firestore `cardtrader_zero_settings/{uid}`: `sortingFields`,
/// `smartLocations`, `ptSortAt`, `updatedAt`.
pub const SETTINGS_COLLECTION: &str = "cardtrader_zero_settings";

#[derive(Clone, Debug, PartialEq)]
pub struct ZeroSettings {
    pub sorting_fields: Vec<String>,
    pub smart_locations: bool,
}

impl Default for ZeroSettings {
    fn default() -> Self {
        Self { sorting_fields: default_sorting_fields(), smart_locations: true }
    }
}

impl ZeroSettings {
    /// A stored doc; an invalid stored sort falls back to the default.
    pub fn from_doc(data: &Value) -> Self {
        let sorting_fields = data
            .get("sortingFields")
            .and_then(|raw| parse_sorting_fields(raw).ok())
            .unwrap_or_else(default_sorting_fields);
        let smart_locations = data.get("smartLocations").and_then(Value::as_bool).unwrap_or(true);
        Self { sorting_fields, smart_locations }
    }

    /// The `sorting` object of the API answers.
    pub fn sorting_json(&self) -> Value {
        json!({
            "fields": self.sorting_fields,
            "defaultFields": default_sorting_fields(),
            "smartLocations": self.smart_locations,
        })
    }
}

pub async fn read_settings(firestore: &dyn crate::firebase::FirestoreStore, uid: &str) -> (ZeroSettings, Value) {
    match firestore.get_doc(SETTINGS_COLLECTION, uid).await {
        Ok(doc) if doc.exists => (ZeroSettings::from_doc(&doc.data), doc.data),
        _ => (ZeroSettings::default(), json!({})),
    }
}

/// `POST /api/cardtrader-zero-sort` body → the settings to save. `{reset:
/// true}` restores the default sort; `fields` and `smartLocations` are each
/// optional, the other keeps its saved value.
pub fn parse_sort_request(body: &Value, current: &ZeroSettings) -> ApiResult<ZeroSettings> {
    if !body.is_object() {
        return Err(ApiError::bad_request("Send a JSON object.").with_code("invalid_body"));
    }
    let mut next = current.clone();
    if body.get("reset") == Some(&Value::Bool(true)) {
        next.sorting_fields = default_sorting_fields();
    } else if let Some(fields) = body.get("fields").or_else(|| body.get("sortingFields")) {
        next.sorting_fields = parse_sorting_fields(fields)?;
    }
    match body.get("smartLocations") {
        None | Some(Value::Null) => {}
        Some(Value::Bool(flag)) => next.smart_locations = *flag,
        Some(_) => return Err(ApiError::bad_request("smartLocations must be true or false.").with_code("invalid_body")),
    }
    let touched = body.get("reset") == Some(&Value::Bool(true))
        || body.get("fields").is_some()
        || body.get("sortingFields").is_some()
        || body.get("smartLocations").is_some_and(|v| !v.is_null());
    if !touched {
        return Err(ApiError::bad_request("Send fields, smartLocations, or reset.").with_code("invalid_body"));
    }
    Ok(next)
}

pub async fn save_settings(firestore: &dyn crate::firebase::FirestoreStore, uid: &str, settings: &ZeroSettings) -> ApiResult<Value> {
    let now = crate::time_util::iso_from_ms(crate::time_util::now_ms());
    firestore
        .merge_doc(
            SETTINGS_COLLECTION,
            uid,
            json!({
                "uid": uid,
                "sortingFields": settings.sorting_fields,
                "smartLocations": settings.smart_locations,
                "updatedAt": now,
            }),
        )
        .await?;
    Ok(json!({ "ok": true, "sorting": settings.sorting_json() }))
}

// ------------------------------------------------------------ Power Tools

/// Power Tools location names as its UI shows them, minus any
/// `": n (m available)"` tail; "" and "unknown…" are no location.
pub fn pt_display_location(name: &str) -> String {
    static TAIL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let tail = TAIL.get_or_init(|| {
        regex::Regex::new(r"(?i)\s*(?::\s*\d+\s*)?\(\s*\d+\s+available\s*\)\s*$").expect("pt location tail regex")
    });
    let value = clean_text(Some(name), 120);
    let value = tail.replace(&value, "").trim().trim_end_matches(':').trim().to_string();
    if value.is_empty() || value.to_lowercase().starts_with("unknown") {
        return String::new();
    }
    value
}

/// CardTrader-sourced Power Tools orders by `sourceOrderId`.
fn pt_orders_by_source(pt_orders: &[Value]) -> HashMap<String, &Value> {
    let mut out = HashMap::new();
    for order in pt_orders {
        if clean_text(order.get("source").and_then(Value::as_str), 40).to_lowercase() != "cardtrader" {
            continue;
        }
        let id = id_text(order.get("sourceOrderId").unwrap_or(&Value::Null));
        if !id.is_empty() {
            out.insert(id, order);
        }
    }
    out
}

fn pt_order_state(order: &Value) -> String {
    clean_text(order.pointer("/state/state").or_else(|| order.get("state")).and_then(Value::as_str), 40)
}

/// The open picking list holding `pt_order` (by ptOrderId, else by the
/// order's picking list name); a `cardtrader_zero` list wins.
pub fn picking_list_for<'a>(lists: &'a [Value], pt_order: &Value) -> Option<&'a Value> {
    let pt_id = id_text(pt_order.get("ptOrderId").unwrap_or(&Value::Null));
    let name = clean_text(pt_order.pointer("/picking/pickingList").and_then(Value::as_str), 200);
    let candidates: Vec<&Value> = lists
        .iter()
        .filter(|list| {
            let holds = !pt_id.is_empty()
                && list
                    .get("orders")
                    .and_then(Value::as_array)
                    .map(|orders| orders.iter().any(|o| id_text(o.get("ptOrderId").unwrap_or(&Value::Null)) == pt_id))
                    .unwrap_or(false);
            holds || (!name.is_empty() && clean_text(list.get("name").and_then(Value::as_str), 200) == name)
        })
        .collect();
    candidates
        .iter()
        .find(|list| list.get("variant").and_then(Value::as_str) == Some("cardtrader_zero"))
        .or_else(|| candidates.first())
        .copied()
}

/// Weekly CT order id → the picking list to read for it.
pub fn picking_targets<'a>(list: &Value, pt_orders: &[Value], lists: &'a [Value]) -> Vec<(String, &'a Value)> {
    let by_source = pt_orders_by_source(pt_orders);
    list.get("weekly")
        .and_then(Value::as_array)
        .map(|orders| {
            orders
                .iter()
                .filter_map(|order| {
                    let order_id = text(order.get("orderId"), 40);
                    let pt_order = by_source.get(&order_id)?;
                    Some((order_id, picking_list_for(lists, pt_order)?))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Does any weekly CT order have a Power Tools twin?
pub fn any_weekly_pt_match(list: &Value, pt_orders: &[Value]) -> bool {
    let by_source = pt_orders_by_source(pt_orders);
    list.get("weekly")
        .and_then(Value::as_array)
        .map(|orders| orders.iter().any(|order| by_source.contains_key(&text(order.get("orderId"), 40))))
        .unwrap_or(false)
}

/// One CardTrader item as Power Tools picks it.
#[derive(Debug, Default)]
struct PtItem {
    position: i64,
    delta: i64,
    article_quantity: i64,
    picked: i64,
    locations: Vec<String>,
    bin: String,
    article_state: String,
    game: &'static str,
}

fn article_by_id<'a>(articles_to_pick: &'a Value, id: &str) -> Option<&'a Value> {
    match articles_to_pick.get("articleMap") {
        Some(Value::Object(map)) => map.get(id).or_else(|| {
            map.values().find(|a| id_text(a.get("ptOrderArticleId").unwrap_or(&Value::Null)) == id)
        }),
        Some(Value::Array(rows)) => rows.iter().find(|a| id_text(a.get("ptOrderArticleId").unwrap_or(&Value::Null)) == id),
        _ => None,
    }
}

fn location_name(articles_to_pick: &Value, id: &str) -> String {
    let map = articles_to_pick.get("locationMap");
    let entry = match map {
        Some(Value::Object(map)) => map.get(id),
        Some(Value::Array(rows)) => rows.iter().find(|l| id_text(l.get("id").or_else(|| l.get("locationId")).unwrap_or(&Value::Null)) == id),
        _ => None,
    };
    pt_display_location(entry.and_then(|l| l.get("name")).and_then(Value::as_str).unwrap_or_default())
}

/// Walk `pickings` (already in Power Tools picking order) for one CT order:
/// CardTrader item id → its PT picking, ranked by first appearance.
fn pt_items_for_order(articles_to_pick: &Value, order_ids: &HashSet<String>) -> HashMap<String, PtItem> {
    let mut items: HashMap<String, PtItem> = HashMap::new();
    let pickings = articles_to_pick.get("pickings").and_then(Value::as_array).cloned().unwrap_or_default();
    for picking in &pickings {
        let article_id = id_text(picking.get("ptOrderArticleId").unwrap_or(&Value::Null));
        let Some(article) = article_by_id(articles_to_pick, &article_id) else { continue };
        if !order_ids.contains(&id_text(article.get("sourceOrderId").unwrap_or(&Value::Null))) {
            continue;
        }
        let item_id = id_text(article.get("sourceArticleId").unwrap_or(&Value::Null));
        if item_id.is_empty() {
            continue;
        }
        let next = items.len() as i64 + 1;
        let entry = items.entry(item_id).or_insert_with(|| PtItem {
            position: next,
            article_quantity: i64_field(article, &["quantity"]).unwrap_or(0).max(0),
            bin: id_text(article.get("pickingId").unwrap_or(&Value::Null)),
            article_state: clean_text(picking.get("articleState").and_then(Value::as_str), 40),
            game: article_game(article),
            ..PtItem::default()
        });
        entry.picked += i64_field(picking, &["pickedQuantity"]).unwrap_or(0).max(0);
        let location_id = id_text(picking.get("locationId").unwrap_or(&Value::Null));
        if !location_id.is_empty() {
            entry.delta += i64_field(picking, &["deltaQuantity"]).unwrap_or(0).abs();
            let name = location_name(articles_to_pick, &location_id);
            if !name.is_empty() && !entry.locations.contains(&name) {
                entry.locations.push(name);
            }
        }
    }
    items
}

/// Overlay Power Tools' picking order (getArticlesToPick, keyed by list id)
/// on the weekly orders. Lines of items Power Tools does not hold keep
/// `powerTools: null` for the orders fallback. Returns orders overlaid.
pub fn attach_power_tools_picking(list: &mut Value, pt_orders: &[Value], lists: &[Value], articles: &HashMap<String, Value>) -> usize {
    let by_source = pt_orders_by_source(pt_orders);
    let mut overlaid = 0;
    let Some(orders) = list.get_mut("weekly").and_then(Value::as_array_mut) else { return 0 };
    for order in orders.iter_mut() {
        let order_id = text(order.get("orderId"), 40);
        let Some(pt_order) = by_source.get(&order_id) else { continue };
        let Some(chosen) = picking_list_for(lists, pt_order) else { continue };
        let list_id = id_text(chosen.get("ptId").unwrap_or(&Value::Null));
        let Some(articles_to_pick) = articles.get(&list_id) else { continue };
        let mut order_ids: HashSet<String> = HashSet::from([order_id.clone()]);
        for line in order["items"].as_array().into_iter().flatten() {
            let hub = text(line.get("hubPendingOrderId"), 40);
            if !hub.is_empty() {
                order_ids.insert(hub);
            }
        }
        let pt_items = pt_items_for_order(articles_to_pick, &order_ids);
        let order_bin = id_text(pt_order.pointer("/picking/pickingId").unwrap_or(&Value::Null));
        let mut first_bin = String::new();
        let mut seen: HashMap<String, usize> = HashMap::new();
        for line in order.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
            let item_id = text(line.get("itemId"), 40);
            let Some(pt) = pt_items.get(&item_id) else { continue };
            assign_pt_location(line, &pt.locations, &mut seen, &item_id);
            offer_game(line, pt.game, "powertools");
            let item_quantity = line.get("itemQuantity").and_then(Value::as_i64).unwrap_or_else(|| quantity_of(line));
            let bin = if pt.bin.is_empty() { order_bin.clone() } else { pt.bin.clone() };
            if first_bin.is_empty() {
                first_bin = bin.clone();
            }
            line["powerTools"] = json!({
                "orderState": pt_order_state(pt_order),
                "isCtZeroClosing": pt_order.get("isCtZeroClosing") == Some(&Value::Bool(true)),
                "articleState": pt.article_state,
                "pickedQuantity": pt.picked.min(item_quantity),
                "location": pt.locations.join(", "),
                "bin": bin,
                "position": pt.position,
                "ptQuantity": if pt.delta > 0 { pt.delta } else { pt.article_quantity },
                "mismatch": false,
            });
        }
        let variant = clean_text(chosen.get("variant").and_then(Value::as_str), 60);
        let single_closing = chosen.get("orders").and_then(Value::as_array).map(Vec::len) == Some(1)
            && pt_order.get("isCtZeroClosing") == Some(&Value::Bool(true));
        order["ptPicking"] = json!({
            "listId": list_id,
            "listName": clean_text(chosen.get("name").and_then(Value::as_str), 200),
            "variant": variant,
            "ctZeroClosed": variant == "cardtrader_zero" || single_closing,
            "bin": if order_bin.is_empty() { first_bin } else { order_bin },
            "sortingFields": articles_to_pick
                .get("sortingFields")
                .filter(|v| !v.is_null())
                .or_else(|| chosen.get("sortingFields"))
                .cloned()
                .unwrap_or(Value::Null),
            "comparable": false,
            "mismatches": 0,
        });
        overlaid += 1;
    }
    overlaid
}

/// `attachPowerToolsOrders` — the `GET user/order` article overlay for lines
/// the picking list did not cover. Not a picking order: position stays null.
/// Returns the CardTrader-sourced PT order count.
pub fn attach_power_tools_orders(list: &mut Value, pt_orders: &[Value]) -> usize {
    let orders = pt_orders_by_source(pt_orders);
    let mut seen: HashMap<String, usize> = HashMap::new();
    let visit = |item: &mut Value| {
        if !item.get("powerTools").map(Value::is_null).unwrap_or(true) {
            return;
        }
        let order_id = text(item.get("orderId"), 40);
        let hub = text(item.get("hubPendingOrderId"), 40);
        let order = orders.get(&order_id).or_else(|| if hub.is_empty() { None } else { orders.get(&hub) });
        let Some(order) = order else { return };
        let item_id = text(item.get("itemId"), 40);
        let product_id = text(item.get("productId"), 80);
        let articles = order.get("articles").and_then(Value::as_array).cloned().unwrap_or_default();
        let source_article = |row: &Value| id_text(row.get("sourceArticleId").unwrap_or(&Value::Null));
        let article = articles
            .iter()
            .find(|row| !item_id.is_empty() && source_article(row) == item_id)
            .or_else(|| articles.iter().find(|row| !product_id.is_empty() && source_article(row) == product_id));
        let item_quantity = item.get("itemQuantity").and_then(Value::as_i64).unwrap_or_else(|| quantity_of(item));
        let locations = article.map(pt_location_names).unwrap_or_default();
        if let Some(article) = article {
            assign_pt_location(item, &locations, &mut seen, &format!("{order_id}/{item_id}"));
            offer_game(item, article_game(article), "powertools");
        }
        item["powerTools"] = json!({
            "orderState": pt_order_state(order),
            "isCtZeroClosing": order.get("isCtZeroClosing") == Some(&Value::Bool(true)),
            "articleState": article
                .and_then(|a| a.get("articleState").or_else(|| a.pointer("/state/state")))
                .and_then(Value::as_str)
                .map(|s| clean_text(Some(s), 40))
                .unwrap_or_default(),
            "pickedQuantity": article
                .map(|a| json!((a.get("pickedQuantity").and_then(Value::as_f64).unwrap_or(0.0).max(0.0) as i64).min(item_quantity)))
                .unwrap_or(Value::Null),
            "location": locations.join(", "),
            "bin": id_text(order.pointer("/picking/pickingId").unwrap_or(&Value::Null)),
            "position": Value::Null,
            "ptQuantity": article.and_then(|a| i64_field(a, &["quantity"])).map(Value::from).unwrap_or(Value::Null),
            "mismatch": false,
        });
    };
    for_each_line(list, visit);
    orders.len()
}

fn for_each_line(list: &mut Value, mut visit: impl FnMut(&mut Value)) {
    if let Some(orders) = list.get_mut("weekly").and_then(Value::as_array_mut) {
        for order in orders.iter_mut() {
            for item in order.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
                visit(item);
            }
        }
    }
    for item in list.pointer_mut("/pending/items").and_then(Value::as_array_mut).into_iter().flatten() {
        visit(item);
    }
}

/// A `user/order` article's Power Tools locations: `locationInfo.name`, else
/// the `locations[]` holding copies (quantity > 0 or deltaQuantity < 0).
fn pt_location_names(article: &Value) -> Vec<String> {
    let info = pt_display_location(article.pointer("/locationInfo/name").and_then(Value::as_str).unwrap_or_default());
    if !info.is_empty() {
        return vec![info];
    }
    let mut names: Vec<String> = Vec::new();
    for loc in article.get("locations").and_then(Value::as_array).into_iter().flatten() {
        let quantity = loc.get("quantity").and_then(Value::as_f64).unwrap_or(0.0);
        let delta = loc.get("deltaQuantity").and_then(Value::as_f64).unwrap_or(0.0);
        if !(quantity > 0.0 || delta < 0.0) {
            continue;
        }
        let name = pt_display_location(loc.get("name").and_then(Value::as_str).unwrap_or_default());
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// The k-th line of an item takes the k-th Power Tools location of that item
/// (the last one when the item has more lines than locations).
fn assign_pt_location(line: &mut Value, locations: &[String], seen: &mut HashMap<String, usize>, key: &str) {
    let k = seen.entry(key.to_string()).or_insert(0);
    line["ptLocation"] = json!(locations.get(*k).or_else(|| locations.last()).cloned().unwrap_or_default());
    *k += 1;
}

/// (matched orders, matched items): lines whose PT article was found.
pub fn power_tools_counts(list: &Value) -> (usize, usize) {
    let mut orders = HashSet::new();
    let mut items = HashSet::new();
    for line in all_items(list) {
        let Some(pt) = line.get("powerTools").filter(|v| v.is_object()) else { continue };
        let order_id = text(line.get("orderId"), 40);
        orders.insert(order_id.clone());
        if !pt["pickedQuantity"].is_null() {
            items.insert((order_id, text(line.get("itemId"), 40)));
        }
    }
    (orders.len(), items.len())
}

/// After [`sort_for_picking`]: flag items whose rank in our order differs
/// from their Power Tools rank, and fill each order's `comparable` /
/// `mismatches`. Both ranks count only items Power Tools placed.
pub fn mark_pt_mismatches(list: &mut Value) {
    let Some(orders) = list.get_mut("weekly").and_then(Value::as_array_mut) else { return };
    for order in orders.iter_mut() {
        if !order.get("ptPicking").map(Value::is_object).unwrap_or(false) {
            continue;
        }
        let mut ours: Vec<(String, Option<i64>)> = Vec::new();
        for line in order["items"].as_array().into_iter().flatten() {
            let item_id = text(line.get("itemId"), 40);
            if ours.iter().any(|(id, _)| *id == item_id) {
                continue;
            }
            ours.push((item_id, line.pointer("/powerTools/position").and_then(Value::as_i64)));
        }
        let comparable = !ours.is_empty() && ours.iter().all(|(_, position)| position.is_some());
        let placed: Vec<&(String, Option<i64>)> = ours.iter().filter(|(_, position)| position.is_some()).collect();
        let mut by_pt = placed.clone();
        by_pt.sort_by_key(|(_, position)| *position);
        let mismatched: HashSet<String> = placed
            .iter()
            .enumerate()
            .filter(|(rank, (id, _))| by_pt.iter().position(|(pt_id, _)| pt_id == id) != Some(*rank))
            .map(|(_, (id, _))| id.clone())
            .collect();
        for line in order.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
            let flagged = mismatched.contains(&text(line.get("itemId"), 40));
            if let Some(pt) = line.get_mut("powerTools").filter(|v| v.is_object()) {
                pt["mismatch"] = json!(flagged);
            }
        }
        order["ptPicking"]["comparable"] = json!(comparable);
        order["ptPicking"]["mismatches"] = json!(mismatched.len());
    }
}

// ------------------------------------------------------------ picked state

pub const ISSUE_TYPES: [&str; 6] = ["missing", "wrong_condition", "wrong_language", "wrong_foil", "wrong_first_edition", "other"];
const MAX_PICKED: i64 = 999;
const MAX_NOTE_CHARS: usize = 280;

pub fn picks_doc_id(uid: &str, order_id: &str) -> String {
    format!("{uid}_{order_id}")
}

/// Each line is its own top-level field (`l_<hex of lineKey>`): Firestore's
/// merge replaces a nested map wholesale.
pub fn pick_field_key(line_key: &str) -> String {
    let mut out = String::from("l_");
    for byte in line_key.as_bytes() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// A validated `POST /api/cardtrader-zero-pick` body.
#[derive(Clone, Debug, PartialEq)]
pub struct PickRequest {
    pub order_id: String,
    pub line_key: String,
    pub picked: Option<i64>,
    /// None = keep; Some(None) = clear; Some(Some({type, note})) = set.
    pub issue: Option<Option<Value>>,
    pub reset: bool,
}

pub fn parse_pick_request(body: &Value) -> ApiResult<PickRequest> {
    if !body.is_object() {
        return Err(ApiError::bad_request("Send a JSON object.").with_code("invalid_body"));
    }
    let order_id = id_text(body.get("orderId").unwrap_or(&Value::Null));
    if order_id.is_empty() || order_id.len() > 40 || !order_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::bad_request("orderId must be a CardTrader order id.").with_code("invalid_order"));
    }
    if body.get("reset") == Some(&Value::Bool(true)) {
        return Ok(PickRequest { order_id, line_key: String::new(), picked: None, issue: None, reset: true });
    }
    let line_key = body.get("lineKey").and_then(Value::as_str).unwrap_or_default().to_string();
    let key_ok = !line_key.is_empty()
        && line_key.len() <= 120
        && line_key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '_' | ':' | '.' | '-'));
    if !key_ok {
        return Err(ApiError::bad_request("lineKey is not a picking line key.").with_code("invalid_line"));
    }
    let picked = match body.get("picked") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => match n.as_f64() {
            Some(value) if value.is_finite() => Some((value.trunc() as i64).clamp(0, MAX_PICKED)),
            _ => return Err(ApiError::bad_request("picked must be a number.").with_code("invalid_picked")),
        },
        Some(_) => return Err(ApiError::bad_request("picked must be a number.").with_code("invalid_picked")),
    };
    let issue = match body.get("issue") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::Object(raw)) => {
            let kind = raw.get("type").and_then(Value::as_str).unwrap_or_default();
            if !ISSUE_TYPES.contains(&kind) {
                return Err(ApiError::bad_request("issue.type is not a known issue.").with_code("invalid_issue"));
            }
            let note = match raw.get("note") {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(note)) => note.trim().to_string(),
                Some(_) => return Err(ApiError::bad_request("issue.note must be text.").with_code("invalid_issue")),
            };
            if note.chars().count() > MAX_NOTE_CHARS {
                return Err(ApiError::bad_request("issue.note is longer than 280 characters.").with_code("invalid_issue"));
            }
            Some(Some(json!({ "type": kind, "note": note })))
        }
        Some(_) => return Err(ApiError::bad_request("issue must be an object or null.").with_code("invalid_issue")),
    };
    if picked.is_none() && issue.is_none() {
        return Err(ApiError::bad_request("Send picked, issue, or reset.").with_code("invalid_body"));
    }
    Ok(PickRequest { order_id, line_key, picked, issue, reset: false })
}

/// Store one line's picked count / issue (or forget the whole order).
pub async fn save_pick(firestore: &dyn crate::firebase::FirestoreStore, uid: &str, request: &PickRequest) -> ApiResult<Value> {
    let doc_id = picks_doc_id(uid, &request.order_id);
    if request.reset {
        firestore.delete_doc(PICKS_COLLECTION, &doc_id).await?;
        return Ok(json!({ "ok": true, "orderId": request.order_id, "reset": true }));
    }
    let field = pick_field_key(&request.line_key);
    let current = firestore.get_doc(PICKS_COLLECTION, &doc_id).await?;
    let prior = if current.exists { current.data.get(&field).cloned().unwrap_or(Value::Null) } else { Value::Null };
    let now = crate::time_util::iso_from_ms(crate::time_util::now_ms());
    let picked = request
        .picked
        .unwrap_or_else(|| prior.get("picked").and_then(Value::as_i64).unwrap_or(0).clamp(0, MAX_PICKED));
    let issue = match &request.issue {
        None => prior.get("issue").filter(|v| v.is_object()).cloned().unwrap_or(Value::Null),
        Some(None) => Value::Null,
        Some(Some(issue)) => {
            let mut issue = issue.clone();
            issue["at"] = json!(now.clone());
            issue
        }
    };
    let line = json!({ "lineKey": request.line_key, "picked": picked, "issue": issue, "updatedAt": now.clone() });
    let mut fields = serde_json::Map::new();
    fields.insert("uid".into(), json!(uid));
    fields.insert("orderId".into(), json!(request.order_id));
    fields.insert("updatedAt".into(), json!(now));
    fields.insert(field, line.clone());
    firestore.merge_doc(PICKS_COLLECTION, &doc_id, Value::Object(fields)).await?;
    Ok(json!({ "ok": true, "orderId": request.order_id, "line": line }))
}

/// Picks docs per weekly CT order id (missing / failed reads are absent).
pub async fn read_picks(firestore: &dyn crate::firebase::FirestoreStore, uid: &str, list: &Value) -> HashMap<String, Value> {
    let order_ids: Vec<String> = list
        .get("weekly")
        .and_then(Value::as_array)
        .map(|orders| orders.iter().map(|o| text(o.get("orderId"), 40)).filter(|id| !id.is_empty()).collect())
        .unwrap_or_default();
    let doc_ids: Vec<String> = order_ids.iter().map(|order_id| picks_doc_id(uid, order_id)).collect();
    let Ok(docs) = firestore.get_docs(PICKS_COLLECTION, &doc_ids).await else { return HashMap::new() };
    order_ids.into_iter().zip(docs).filter(|(_, doc)| doc.exists).map(|(order_id, doc)| (order_id, doc.data)).collect()
}

/// Server picked state onto the weekly lines (picked clamped to the line).
pub fn apply_picks(list: &mut Value, picks: &HashMap<String, Value>) {
    apply_picks_with(list, picks, &HashMap::new())
}

/// Postgres `cardtrader_zero_picks` rows (state picked) per order id, then
/// per line key.
pub type PgPicks = HashMap<String, HashMap<String, Vec<Value>>>;

const PICKS_SQL: &str = "select id, order_id, item_id, line_key, listing_id::text as listing_id, \
       coalesce(allocated_listing_id::text, '') as allocated_listing_id, kind, quantity \
     from public.cardtrader_zero_picks \
     where seller_uid = $1 and order_id = any($2::text[]) and state = 'picked' order by id";

/// Picked rows of the weekly orders. A missing table (migration not applied
/// yet) or a failed read is no rows: the Firestore picks answer instead.
pub async fn read_pg_picks(db: &crate::db::DbPools, uid: &str, list: &Value) -> PgPicks {
    let order_ids: Vec<String> = list
        .get("weekly")
        .and_then(Value::as_array)
        .map(|orders| orders.iter().map(|o| text(o.get("orderId"), 40)).filter(|id| !id.is_empty()).collect())
        .unwrap_or_default();
    if order_ids.is_empty() {
        return HashMap::new();
    }
    let rows = db.query("pokemon", PICKS_SQL, &[json!(uid), json!(order_ids)]).await.unwrap_or_default();
    group_pg_picks(&rows)
}

pub fn group_pg_picks(rows: &[Value]) -> PgPicks {
    let mut out: PgPicks = HashMap::new();
    for row in rows {
        let order_id = text(row.get("order_id"), 40);
        let line_key = text(row.get("line_key"), 200);
        let pick = json!({
            "id": row.get("id").cloned().unwrap_or(Value::Null),
            "itemId": text(row.get("item_id"), 40),
            "listingId": text(row.get("listing_id"), 80),
            "allocatedListingId": text(row.get("allocated_listing_id"), 80),
            "kind": text(row.get("kind"), 20),
            "quantity": i64_field(row, &["quantity"]).unwrap_or(0).max(0),
        });
        out.entry(order_id).or_default().entry(line_key).or_default().push(pick);
    }
    out
}

/// [`apply_picks`] with Postgres picks: an order with any Postgres pick takes
/// its picked counts from there (the line's `picks`); others keep the
/// Firestore counts of orders picked before the inventory picks shipped.
/// Issues always come from Firestore.
pub fn apply_picks_with(list: &mut Value, picks: &HashMap<String, Value>, pg: &PgPicks) {
    let Some(orders) = list.get_mut("weekly").and_then(Value::as_array_mut) else { return };
    for order in orders.iter_mut() {
        let order_id = text(order.get("orderId"), 40);
        let doc = picks.get(&order_id);
        let pg_order = pg.get(&order_id);
        let mut picked_lines = 0;
        let mut issue_count = 0;
        for line in order.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
            let quantity = line.get("quantity").and_then(Value::as_i64).unwrap_or(0);
            let line_key = text(line.get("lineKey"), 200);
            let entry = doc.and_then(|data| data.get(pick_field_key(&line_key)));
            let pg_rows = pg_order.and_then(|lines| lines.get(&line_key)).cloned().unwrap_or_default();
            let picked = match pg_order {
                Some(_) => pg_rows.iter().map(|row| row["quantity"].as_i64().unwrap_or(0)).sum::<i64>(),
                None => entry.and_then(|e| e.get("picked")).and_then(Value::as_i64).unwrap_or(0),
            }
            .clamp(0, quantity.max(0));
            line["picks"] = json!(pg_rows);
            let issue = entry.and_then(|e| e.get("issue")).filter(|v| v.is_object()).cloned().unwrap_or(Value::Null);
            if quantity > 0 && picked >= quantity {
                picked_lines += 1;
            }
            if !issue.is_null() {
                issue_count += 1;
            }
            line["picked"] = json!(picked);
            line["issue"] = issue;
        }
        order["pickedLines"] = json!(picked_lines);
        order["issueCount"] = json!(issue_count);
    }
}

// ------------------------------------------------------------ Apply sort (Power Tools write)

/// Seconds between two Power Tools sort writes of one seller.
pub const PT_SORT_THROTTLE_MS: i64 = 15_000;
const MAX_SEQUENCE: usize = 2_000;

/// A validated `POST /api/cardtrader-zero-pt-sort` body.
#[derive(Clone, Debug, PartialEq)]
pub struct PtSortRequest {
    pub order_id: String,
    /// The Power Tools picking list id, as the client got it (string or number).
    pub list_id: Value,
    /// CardTrader item ids (`sourceArticleId`) in the wanted order.
    pub sequence: Vec<String>,
    pub dry_run: bool,
    pub expect_count: Option<usize>,
}

pub fn parse_pt_sort_request(body: &Value) -> ApiResult<PtSortRequest> {
    if !body.is_object() {
        return Err(ApiError::bad_request("Send a JSON object.").with_code("invalid_body"));
    }
    let order_id = id_text(body.get("orderId").unwrap_or(&Value::Null));
    if order_id.is_empty() || order_id.len() > 40 || !order_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::bad_request("orderId must be a CardTrader order id.").with_code("invalid_order"));
    }
    let list_id = body.get("listId").cloned().unwrap_or(Value::Null);
    let list_text = id_text(&list_id);
    if list_text.is_empty() || list_text.len() > 80 || !list_text.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(ApiError::bad_request("listId must be a Power Tools picking list id.").with_code("invalid_list"));
    }
    let Some(raw) = body.get("sequence").and_then(Value::as_array) else {
        return Err(ApiError::bad_request("sequence must be a list of item ids.").with_code("invalid_sequence"));
    };
    if raw.len() > MAX_SEQUENCE {
        return Err(ApiError::bad_request("sequence is too long.").with_code("invalid_sequence"));
    }
    let mut sequence: Vec<String> = Vec::new();
    for entry in raw {
        let id = id_text(entry);
        if id.is_empty() || id.len() > 40 {
            return Err(ApiError::bad_request("sequence must be a list of item ids.").with_code("invalid_sequence"));
        }
        if !sequence.contains(&id) {
            sequence.push(id);
        }
    }
    let dry_run = body.get("dryRun") == Some(&Value::Bool(true));
    let expect_count = match body.get("expectCount") {
        None | Some(Value::Null) => None,
        Some(value) => match value.as_u64() {
            Some(n) => Some(n as usize),
            None => return Err(ApiError::bad_request("expectCount must be a count.").with_code("invalid_body")),
        },
    };
    if !dry_run && expect_count.is_none() {
        return Err(ApiError::bad_request("expectCount is required to apply a sort.").with_code("invalid_body"));
    }
    Ok(PtSortRequest { order_id, list_id, sequence, dry_run, expect_count })
}

/// One Power Tools article of a picking list, deduplicated over its pickings.
#[derive(Clone, Debug)]
struct PtSortArticle {
    key: String,
    item_id: String,
    picked: bool,
    updated_ms: Option<i64>,
    /// `{source, sourceArticleId, sourceOrderId}` exactly as Power Tools sent them.
    entry: Value,
}

/// The list's articles in Power Tools order, one per article. An article is
/// picked when every one of its pickings is `picked`.
fn pt_sort_articles(articles_to_pick: &Value) -> Vec<PtSortArticle> {
    let mut out: Vec<PtSortArticle> = Vec::new();
    for picking in articles_to_pick.get("pickings").and_then(Value::as_array).into_iter().flatten() {
        let article_id = id_text(picking.get("ptOrderArticleId").unwrap_or(&Value::Null));
        let Some(article) = article_by_id(articles_to_pick, &article_id) else { continue };
        let picked = clean_text(picking.get("articleState").and_then(Value::as_str), 40).eq_ignore_ascii_case("picked");
        let key = if article_id.is_empty() {
            format!(
                "{}/{}",
                id_text(article.get("sourceOrderId").unwrap_or(&Value::Null)),
                id_text(article.get("sourceArticleId").unwrap_or(&Value::Null))
            )
        } else {
            article_id
        };
        if let Some(existing) = out.iter_mut().find(|a| a.key == key) {
            existing.picked = existing.picked && picked;
            continue;
        }
        let pass = |name: &str| article.get(name).cloned().unwrap_or(Value::Null);
        out.push(PtSortArticle {
            key,
            item_id: id_text(article.get("sourceArticleId").unwrap_or(&Value::Null)),
            picked,
            updated_ms: article
                .get("updatedAt")
                .or_else(|| picking.get("updatedAt"))
                .and_then(Value::as_str)
                .and_then(crate::time_util::ms_from_iso),
            entry: json!({
                "source": pass("source"),
                "sourceArticleId": pass("sourceArticleId"),
                "sourceOrderId": pass("sourceOrderId"),
            }),
        });
    }
    out
}

/// The `items` Power Tools' own Apply sort would send: picked articles by
/// `updatedAt` ascending, then the to-pick articles in `sequence` order
/// (those `sequence` misses keep Power Tools' order after them). Item ids in
/// `sequence` that the list does not hold are a 409 `pt_sort_mismatch`.
/// `sequence = None` is Power Tools' current order.
pub fn pt_sort_items(articles_to_pick: &Value, sequence: Option<&[String]>) -> ApiResult<Vec<Value>> {
    let articles = pt_sort_articles(articles_to_pick);
    let mut picked: Vec<&PtSortArticle> = articles.iter().filter(|a| a.picked).collect();
    picked.sort_by(|a, b| option_first(a.updated_ms, b.updated_ms));
    let to_pick: Vec<&PtSortArticle> = articles.iter().filter(|a| !a.picked).collect();
    let mut ordered: Vec<&PtSortArticle> = Vec::new();
    if let Some(sequence) = sequence {
        let unknown: Vec<&String> = sequence.iter().filter(|id| !articles.iter().any(|a| a.item_id == **id)).collect();
        if !unknown.is_empty() {
            let mut error = ApiError::conflict("Power Tools' picking list changed: reload the list.").with_code("pt_sort_mismatch");
            error.problems = Some(json!({ "unknownIds": unknown }));
            return Err(error);
        }
        for id in sequence {
            for article in to_pick.iter().filter(|a| a.item_id == *id) {
                if !ordered.iter().any(|done| done.key == article.key) {
                    ordered.push(article);
                }
            }
        }
    }
    for article in &to_pick {
        if !ordered.iter().any(|done| done.key == article.key) {
            ordered.push(article);
        }
    }
    Ok(picked.into_iter().chain(ordered).map(|a| a.entry.clone()).collect())
}

/// Item ids of the list's to-pick articles, in Power Tools order.
pub fn pt_to_pick_ids(articles_to_pick: &Value) -> Vec<String> {
    pt_sort_articles(articles_to_pick).into_iter().filter(|a| !a.picked).map(|a| a.item_id).collect()
}

pub fn pt_item_ids(items: &[Value]) -> Vec<String> {
    items.iter().map(|item| id_text(item.get("sourceArticleId").unwrap_or(&Value::Null))).collect()
}

/// The sort the list already has (kept unchanged on the write).
pub fn pt_list_sorting_fields(articles_to_pick: &Value) -> Value {
    articles_to_pick.get("sortingFields").filter(|v| !v.is_null()).cloned().unwrap_or(json!([]))
}

/// `true` when the last write was less than [`PT_SORT_THROTTLE_MS`] ago.
pub fn pt_sort_throttled(settings_doc: &Value, now_ms: i64) -> bool {
    settings_doc
        .get("ptSortAt")
        .and_then(Value::as_str)
        .and_then(crate::time_util::ms_from_iso)
        .is_some_and(|at| now_ms - at < PT_SORT_THROTTLE_MS && now_ms >= at)
}

/// `POST /api/cardtrader-zero-pt-sort`: reorder the seller's Power Tools
/// picking list. User-triggered only; never retried.
pub async fn apply_pt_sort(
    firestore: &dyn crate::firebase::FirestoreStore,
    powertools: &crate::powertools::PowerToolsClient,
    uid: &str,
    request: &PtSortRequest,
) -> ApiResult<Value> {
    let (_, settings_doc) = read_settings(firestore, uid).await;
    let now = crate::time_util::now_ms();
    if !request.dry_run {
        if pt_sort_throttled(&settings_doc, now) {
            return Err(ApiError::new(429, "Wait a few seconds before applying the sort again.").with_code("pt_sort_throttled"));
        }
        firestore
            .merge_doc(SETTINGS_COLLECTION, uid, json!({ "uid": uid, "ptSortAt": crate::time_util::iso_from_ms(now) }))
            .await?;
    }
    let jwt = crate::powertools::decrypt_power_tools_session(firestore, uid).await?;
    if jwt.is_empty() {
        return Err(ApiError::conflict("Connect Power Tools first.").with_code("powertools_not_connected"));
    }
    let expired = |error: ApiError| async move {
        if error.code.as_deref() == Some("powertools_session_expired") {
            crate::powertools::mark_session_expired(firestore, uid).await;
        }
        error
    };
    let fresh = match powertools.fetch_articles_to_pick(&jwt, &request.list_id).await {
        Ok(payload) => payload,
        Err(error) => return Err(expired(error).await),
    };
    let before = pt_item_ids(&pt_sort_items(&fresh, None)?);
    let items = pt_sort_items(&fresh, Some(&request.sequence))?;
    let requested = pt_item_ids(&items);
    if let Some(expected) = request.expect_count {
        if expected != items.len() {
            let mut error = ApiError::conflict("Power Tools' picking list changed: reload the list.").with_code("pt_sort_count_changed");
            error.problems = Some(json!({ "expectCount": expected, "count": items.len() }));
            return Err(error);
        }
    }
    if request.dry_run {
        return Ok(json!({ "ok": true, "dryRun": true, "before": before, "items": requested }));
    }
    let sorting_fields = pt_list_sorting_fields(&fresh);
    if let Err(error) = powertools.update_sorting(&jwt, &request.list_id, &sorting_fields, &json!(items)).await {
        return Err(expired(error).await);
    }
    let after = match powertools.fetch_articles_to_pick(&jwt, &request.list_id).await {
        Ok(payload) => pt_item_ids(&pt_sort_items(&payload, None)?),
        Err(error) => return Err(expired(error).await),
    };
    Ok(json!({ "ok": true, "before": before, "after": after.clone(), "requested": requested.clone(), "applied": after == requested }))
}

// ------------------------------------------------------------ route

/// Blueprint id → game, for ids found in exactly one game catalog. One bulk
/// query per catalog, four at a time; a missing or failing catalog is skipped.
pub async fn blueprint_games(db: &crate::db::DbPools, list: &Value) -> HashMap<String, String> {
    let ids: Vec<String> = all_items(list)
        .iter()
        .map(|item| text(item.get("blueprintId"), 80))
        .filter(|id| !id.is_empty() && id.len() <= 18 && id.chars().all(|c| c.is_ascii_digit()))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return HashMap::new();
    }
    let ids = json!(ids);
    let results: Vec<(String, Vec<Value>)> = futures_util::stream::iter(crate::powertools_games::catalogs())
        .map(|(game, table)| {
            let ids = ids.clone();
            async move {
                let sql = format!("select id::text as id from {table} where id = any($1::text[]::bigint[])");
                let rows = db.query(&game, &sql, &[ids]).await.unwrap_or_default();
                (game, rows)
            }
        })
        .buffer_unordered(8)
        .collect()
        .await;
    let mut found: HashMap<String, HashSet<String>> = HashMap::new();
    for (game, rows) in results {
        for row in rows {
            let id = text(row.get("id"), 40);
            if !id.is_empty() {
                found.entry(id).or_default().insert(game.clone());
            }
        }
    }
    found
        .into_iter()
        .filter_map(|(id, games)| (games.len() == 1).then(|| (id, games.into_iter().next().unwrap_or_default())))
        .collect()
}

const LISTINGS_SQL: &str = "select id::text as id, card_id, source_listing_id, location, collector_number, card_image_url, \
       marketplace_game, status, quantity_available, card_name, \
       to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as created_at \
     from public.marketplace_user_listings \
     where seller_uid = $1 and (source_listing_id = any($2::text[]) or id::text = any($3::text[]))";

// ------------------------------------------------------------ speed

/// CardTrader orders newer than this many days. The weekly merged `paid`
/// order is at most a week old and `hub_pending` sales are this week's, so
/// 60 days leaves room for a late shipment while a seller with a long tail
/// of unshipped direct orders no longer pages through all of them.
pub const ZERO_ORDER_DAYS: i64 = 60;
/// How long one seller's CardTrader orders and Power Tools reads are reused.
pub const ZERO_CACHE_TTL: Duration = Duration::from_secs(60);
/// A `refresh=1` still reuses a read this young (the page's own duplicate).
pub const ZERO_REFRESH_REUSE: Duration = Duration::from_secs(3);
/// Sellers kept per cache; the oldest entry goes first.
const ZERO_CACHE_MAX: usize = 500;

/// Per-seller reads kept for a short time, in this process only. Never
/// Firestore picks, allocations or listing rows: those change on every pick
/// and sale.
pub struct TtlCache<T> {
    entries: Mutex<HashMap<String, (Instant, T)>>,
}

impl<T: Clone> Default for TtlCache<T> {
    fn default() -> Self {
        Self { entries: Mutex::new(HashMap::new()) }
    }
}

impl<T: Clone> TtlCache<T> {
    /// The entry of `key` when it is younger than `max_age` at `now`.
    pub fn get(&self, key: &str, now: Instant, max_age: Duration) -> Option<T> {
        let entries = self.entries.lock().ok()?;
        let (at, value) = entries.get(key)?;
        (now.saturating_duration_since(*at) < max_age).then(|| value.clone())
    }

    pub fn put(&self, key: &str, now: Instant, value: T) {
        let Ok(mut entries) = self.entries.lock() else { return };
        if entries.len() >= ZERO_CACHE_MAX && !entries.contains_key(key) {
            if let Some(oldest) = entries.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) {
                entries.remove(&oldest);
            }
        }
        entries.insert(key.to_string(), (now, value));
    }

    pub fn len(&self) -> usize {
        self.entries.lock().map(|e| e.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// One seller's Power Tools reads: `user/order`, the open picking lists and
/// the getArticlesToPick payloads by list id.
#[derive(Clone, Default)]
pub struct PtReads {
    pub orders: Arc<Vec<Value>>,
    pub lists: Arc<Vec<Value>>,
    pub articles: Arc<HashMap<String, Value>>,
}

fn ct_cache() -> &'static TtlCache<Arc<Vec<Value>>> {
    static CACHE: OnceLock<TtlCache<Arc<Vec<Value>>>> = OnceLock::new();
    CACHE.get_or_init(TtlCache::default)
}

fn pt_cache() -> &'static TtlCache<PtReads> {
    static CACHE: OnceLock<TtlCache<PtReads>> = OnceLock::new();
    CACHE.get_or_init(TtlCache::default)
}

/// One lock per seller around the CardTrader / Power Tools reads: concurrent
/// requests of one seller share a single fetch (the second finds the cache).
fn flight(uid: &str) -> Arc<tokio::sync::Mutex<()>> {
    static FLIGHTS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut flights = FLIGHTS.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if flights.len() >= ZERO_CACHE_MAX {
        flights.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    flights.entry(uid.to_string()).or_default().clone()
}

/// What `GET /api/cardtrader-zero` should do.
#[derive(Clone, Copy, Debug)]
pub struct ZeroOptions {
    /// false = `powertools=0`: no Power Tools call, the overlay comes later.
    pub power_tools: bool,
    /// `refresh=1`: skip the short cache (Refresh button).
    pub refresh: bool,
}

impl Default for ZeroOptions {
    fn default() -> Self {
        Self { power_tools: true, refresh: false }
    }
}

/// Wall time of each step, for `Server-Timing` and the `zero_list_timing` log.
#[derive(Clone, Debug, Default)]
pub struct ZeroTimings {
    pub steps: Vec<(&'static str, f64)>,
    pub ct_cached: bool,
    pub pt_cached: bool,
    pub lines: usize,
}

impl ZeroTimings {
    fn add(&mut self, name: &'static str, ms: f64) {
        self.steps.push((name, ms));
    }

    /// `Server-Timing` header value: `ct_orders;dur=812.4, …, total;dur=…`.
    pub fn header(&self) -> String {
        let mut parts: Vec<String> = self.steps.iter().map(|(name, ms)| format!("{name};dur={ms:.1}")).collect();
        if self.ct_cached {
            parts.push("ct_cache;desc=hit".into());
        }
        if self.pt_cached {
            parts.push("pt_cache;desc=hit".into());
        }
        parts.join(", ")
    }

    fn log(&self, deferred: bool) {
        let steps: serde_json::Map<String, Value> = self.steps.iter().map(|(name, ms)| (name.to_string(), json!((ms * 10.0).round() / 10.0))).collect();
        let steps = Value::Object(steps).to_string();
        tracing::info!(
            lines = self.lines,
            ct_cached = self.ct_cached,
            pt_cached = self.pt_cached,
            deferred,
            steps = %steps,
            "zero_list_timing"
        );
    }
}

async fn timed<T>(future: impl std::future::Future<Output = T>) -> (T, f64) {
    let start = Instant::now();
    let out = future.await;
    (out, start.elapsed().as_secs_f64() * 1000.0)
}

/// getArticlesToPick for every picking list the weekly orders sit in: cached
/// payloads are reused, the rest fetched at once. Returns (articles by list
/// id, the first failure).
async fn picking_articles(
    powertools: &crate::powertools::PowerToolsClient,
    jwt: &str,
    list: &Value,
    reads: &PtReads,
) -> (HashMap<String, Value>, Option<ApiError>) {
    if !any_weekly_pt_match(list, &reads.orders) {
        return (HashMap::new(), None);
    }
    let mut wanted: Vec<Value> = Vec::new();
    for (_, chosen) in picking_targets(list, &reads.orders, &reads.lists) {
        let id = chosen.get("ptId").cloned().unwrap_or(Value::Null);
        if !id_text(&id).is_empty() && !wanted.iter().any(|w| id_text(w) == id_text(&id)) {
            wanted.push(id);
        }
    }
    let mut articles = HashMap::new();
    let mut missing = Vec::new();
    for id in wanted {
        match reads.articles.get(&id_text(&id)) {
            Some(payload) => {
                articles.insert(id_text(&id), payload.clone());
            }
            None => missing.push(id),
        }
    }
    let fetched = futures_util::future::join_all(missing.iter().map(|id| powertools.fetch_articles_to_pick(jwt, id))).await;
    let mut error = None;
    for (id, answer) in missing.iter().zip(fetched) {
        match answer {
            Ok(payload) => {
                articles.insert(id_text(id), payload);
            }
            Err(failure) => error = Some(failure),
        }
    }
    (articles, error)
}

/// Full zeroList composition used by the route. Independent reads run at
/// once: the CardTrader and Power Tools integration docs, then the CardTrader
/// orders beside Power Tools `user/order` + picking lists, then the webhook
/// allocations, blueprint games, picks and getArticlesToPick, then the
/// listing rows. CardTrader and Power Tools reads are cached per seller for
/// [`ZERO_CACHE_TTL`]; `options.power_tools = false` skips Power Tools.
pub async fn zero_list(
    ct: &crate::cardtrader::client::CardTraderClient,
    firestore: &dyn crate::firebase::FirestoreStore,
    db: &crate::db::DbPools,
    powertools: &crate::powertools::PowerToolsClient,
    uid: &str,
    options: ZeroOptions,
) -> ApiResult<(Value, ZeroTimings)> {
    let started = Instant::now();
    let mut timings = ZeroTimings::default();
    let ((ct_doc, pt_doc), docs_ms) = timed(async {
        tokio::join!(
            crate::cardtrader::integration::read_integration_doc(firestore, uid),
            crate::powertools::read_power_tools_doc(firestore, uid),
        )
    })
    .await;
    timings.add("docs", docs_ms);
    let ct_doc = ct_doc?;
    let token = crate::cardtrader::integration::token_from_doc(&ct_doc).map_err(|mut error| {
        if error.status == 404 {
            error.code = Some("cardtrader_not_connected".into());
        }
        error
    })?;
    let pt_doc = pt_doc.unwrap_or_default();
    let pt_status = crate::powertools::safe_power_tools_status(&pt_doc);
    let pt_connected = pt_status["connected"] == json!(true);
    let username = pt_status.pointer("/account/username").and_then(Value::as_str).unwrap_or_default().to_string();
    let jwt = if pt_connected && options.power_tools {
        crate::powertools::session_from_doc(&pt_doc).unwrap_or_default()
    } else {
        String::new()
    };
    let want_pt = !jwt.is_empty();

    // Remote reads: one flight per seller, reused for ZERO_CACHE_TTL.
    let gate = flight(uid);
    let guard = gate.lock().await;
    let now = Instant::now();
    let max_age = if options.refresh { ZERO_REFRESH_REUSE } else { ZERO_CACHE_TTL };
    let cached_ct = ct_cache().get(uid, now, max_age);
    let cached_pt = if want_pt { pt_cache().get(uid, now, max_age) } else { None };
    timings.ct_cached = cached_ct.is_some();
    timings.pt_cached = cached_pt.is_some();
    let from = crate::time_util::utc_day_key_from_ms(crate::time_util::now_ms() - ZERO_ORDER_DAYS * 86_400_000);
    let ct_read = async {
        if let Some(orders) = cached_ct.clone() {
            return (orders, false);
        }
        let (weekly, pending) = tokio::join!(
            ct.fetch_seller_orders(&token, &from, WEEKLY_STATE, 100, 10),
            ct.fetch_seller_orders(&token, &from, PENDING_STATE, 100, 10),
        );
        let complete = weekly.is_ok() && pending.is_ok();
        let mut combined = weekly.unwrap_or_default();
        combined.extend(pending.unwrap_or_default());
        (Arc::new(combined), complete)
    };
    let pt_read = async {
        if !want_pt {
            return None;
        }
        if let Some(reads) = cached_pt.clone() {
            return Some(Ok((reads, None)));
        }
        let (orders, lists) = tokio::join!(powertools.fetch_orders(&jwt), powertools.fetch_picking_lists(&jwt));
        Some(orders.map(|orders| {
            let (lists, lists_error) = match lists {
                Ok(lists) => (lists, None),
                Err(error) => (Vec::new(), Some(error)),
            };
            (PtReads { orders: Arc::new(orders), lists: Arc::new(lists), articles: Arc::new(HashMap::new()) }, lists_error)
        }))
    };
    let (((ct_orders, ct_fresh), ct_ms), (pt_read, pt_ms)) = tokio::join!(timed(ct_read), timed(pt_read));
    timings.add("ct_orders", ct_ms);
    if want_pt {
        timings.add("pt_orders", pt_ms);
    }
    if ct_fresh {
        // Stamped when the read finished, so the overlay request right after
        // a slow refresh still reuses it.
        ct_cache().put(uid, Instant::now(), ct_orders.clone());
    }
    let mut list = build_zero_list(&ct_orders);

    let pt_reads = pt_read.as_ref().and_then(|answer| answer.as_ref().ok()).map(|(reads, _)| reads.clone());
    let articles_read = async {
        match &pt_reads {
            Some(reads) => Some(picking_articles(powertools, &jwt, &list, reads).await),
            None => None,
        }
    };
    let ((allocations, alloc_ms), (games, games_ms), ((picks, pg_picks, (settings, _)), picks_ms), (articles, articles_ms)) = tokio::join!(
        timed(read_allocations(firestore, uid, &list)),
        timed(blueprint_games(db, &list)),
        timed(async {
            tokio::join!(read_picks(firestore, uid, &list), read_pg_picks(db, uid, &list), read_settings(firestore, uid))
        }),
        timed(articles_read),
    );
    timings.add("allocations", alloc_ms);
    timings.add("games", games_ms);
    timings.add("picks", picks_ms);
    if articles.is_some() {
        timings.add("pt_articles", articles_ms);
    }
    let (articles, articles_error) = articles.unwrap_or_default();
    if let Some((reads, lists_error)) = pt_read.as_ref().and_then(|answer| answer.as_ref().ok()) {
        if lists_error.is_none() && articles_error.is_none() {
            let merged = PtReads { articles: Arc::new(articles.clone()), ..reads.clone() };
            pt_cache().put(uid, Instant::now(), merged);
        }
    }
    drop(guard);

    let source_ids = linked_source_ids(&list);
    let listing_ids = linked_listing_ids(&list, &allocations);
    // No status filter: a sold_out row still says which box the copy left.
    let (rows, listings_ms) = timed(async {
        if source_ids.is_empty() && listing_ids.is_empty() {
            Vec::new()
        } else {
            db.query("pokemon", LISTINGS_SQL, &[json!(uid), json!(source_ids), json!(listing_ids)])
                .await
                .unwrap_or_default()
        }
    })
    .await;
    timings.add("listings", listings_ms);
    split_lines(&mut list, &rows, &allocations, &games);

    // Power Tools overlay; never fails the CardTrader list.
    let mut power_tools = json!({ "connected": false });
    let mut picking = json!({ "ok": false, "source": "none", "error": Value::Null });
    if pt_connected && !options.power_tools {
        power_tools = json!({ "connected": true, "deferred": true, "username": username });
        picking["source"] = json!("deferred");
    } else if pt_connected {
        match pt_read {
            Some(Ok((reads, lists_error))) => {
                let overlaid = attach_power_tools_picking(&mut list, &reads.orders, &reads.lists, &articles);
                let pt_order_count = attach_power_tools_orders(&mut list, &reads.orders);
                let (matched_orders, matched_items) = power_tools_counts(&list);
                let failure = lists_error.or(articles_error);
                if let Some(error) = &failure {
                    if error.code.as_deref() == Some("powertools_session_expired") {
                        crate::powertools::mark_session_expired(firestore, uid).await;
                    }
                }
                picking = json!({
                    "ok": failure.is_none(),
                    "source": if overlaid > 0 { "articlesToPick" } else { "orders" },
                    "error": failure.map(|e| json!(e.message)).unwrap_or(Value::Null),
                });
                power_tools = json!({
                    "connected": true,
                    "ok": true,
                    "username": username,
                    "matchedOrders": matched_orders,
                    "matchedItems": matched_items,
                    "ptOrderCount": pt_order_count,
                });
            }
            Some(Err(error)) => {
                if error.code.as_deref() == Some("powertools_session_expired") {
                    crate::powertools::mark_session_expired(firestore, uid).await;
                }
                picking["error"] = json!(error.message.clone());
                power_tools = json!({
                    "connected": true,
                    "ok": false,
                    "username": username,
                    "code": error.code.unwrap_or_default(),
                    "error": error.message,
                });
            }
            None => {
                power_tools = json!({ "connected": true, "ok": false, "username": username, "code": "", "error": "Power Tools orders failed." });
            }
        }
    }
    power_tools["picking"] = picking;
    apply_picks_with(&mut list, &picks, &pg_picks);
    sort_for_picking_with(&mut list, &settings.sorting_fields);
    mark_pt_mismatches(&mut list);
    let ct_user = ct_doc.data.pointer("/metadata/user").cloned().unwrap_or(json!({}));
    timings.lines = all_items(&list).len();
    timings.add("total", started.elapsed().as_secs_f64() * 1000.0);
    timings.log(!options.power_tools);
    Ok((
        json!({
            "fetchedAt": crate::time_util::iso_from_ms(crate::time_util::now_ms()),
            "cardtrader": {
                "username": clean_text_value(ct_user.get("username").unwrap_or(&Value::Null), 160),
                "userId": clean_text_value(ct_user.get("id").unwrap_or(&Value::Null), 80),
            },
            "oneDayReady": ct_doc.exists && ct_doc.data.get("enabled") == Some(&Value::Bool(true)) && ct_doc.data.pointer("/metadata/oneDayReady") == Some(&Value::Bool(true)),
            "weekly": list["weekly"].clone(),
            "pending": list["pending"].clone(),
            "totals": list["totals"].clone(),
            "powerTools": power_tools,
            "sorting": settings.sorting_json(),
        }),
        timings,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firebase::{FirestoreStore, MemoryFirestore};

    fn zero_order(id: &str, state: &str, items: Vec<Value>) -> Value {
        json!({
            "id": id, "state": state, "via_cardtrader_zero": true, "code": format!("CT{id}"),
            "order_items": items,
            "seller_total": { "cents": 500, "currency": "EUR" },
        })
    }

    fn item(id: &str, product: &str, qty: i64, cents: i64) -> Value {
        json!({
            "id": id, "product_id": product, "quantity": qty,
            "seller_price": { "cents": cents, "currency": "EUR" },
            "properties": { "condition": "Near Mint", "pokemon_language": "en" },
            "created_at": "2026-10-01T10:00:00.000Z",
        })
    }

    fn row(id: &str, product: &str, location: &str, created: &str) -> Value {
        json!({
            "id": id, "card_id": "202", "source_listing_id": format!("ct:{product}"),
            "location": location, "collector_number": "5/100", "card_image_url": "https://x/1.jpg",
            "marketplace_game": "pokemon", "status": "active", "quantity_available": 1,
            "created_at": created,
        })
    }

    fn lines(list: &Value) -> Vec<Value> {
        list["weekly"][0]["items"].as_array().unwrap().clone()
    }

    fn field(lines: &[Value], key: &str) -> Vec<String> {
        lines.iter().map(|line| clean_text_value(&line[key], 200)).collect()
    }

    #[test]
    fn zero_list_splits_weekly_and_pending_and_ignores_direct() {
        let orders = vec![
            zero_order("1", "paid", vec![item("11", "101", 2, 100)]),
            zero_order("2", "hub_pending", vec![item("21", "102", 1, 150)]),
            json!({ "id": "3", "state": "paid", "order_items": [item("31", "103", 1, 90)] }), // direct
            zero_order("1", "paid", vec![]), // duplicate id
        ];
        let list = build_zero_list(&orders);
        assert_eq!(list["weekly"].as_array().unwrap().len(), 1);
        assert_eq!(list["pending"]["orderCount"], 1);
        assert_eq!(list["totals"]["weekly"]["units"], 2);
        assert_eq!(list["totals"]["weekly"]["cents"], 200);
        assert_eq!(list["totals"]["pending"]["cents"], 150);
        assert_eq!(list["weekly"][0]["ptPicking"], Value::Null);
        assert_eq!(list["weekly"][0]["pickedLines"], 0);
    }

    #[test]
    fn item_row_shape() {
        let order = zero_order("9", "paid", vec![]);
        let mut raw = item("77", "555", 3, 120);
        raw["game_id"] = json!(22);
        raw["name"] = json!("Pikachu");
        raw["name_en"] = json!("Pikachu");
        raw["properties"]["pokemon_rarity"] = json!("Rare Holo");
        let row = zero_item_row(&order, &raw);
        assert_eq!(row["productId"], "555");
        assert_eq!(row["quantity"], 3);
        assert_eq!(row["unitCents"], 120);
        assert_eq!(row["lineCents"], 360);
        assert_eq!(row["currency"], "EUR");
        assert_eq!(row["condition"], "NM");
        assert_eq!(row["language"], "EN");
        assert_eq!(row["game"], "riftbound");
        assert_eq!(row["nameEn"], "", "same as name");
        assert_eq!(row["rarity"], "Rare Holo");
    }

    #[test]
    fn blank_language_stays_blank() {
        let order = json!({ "id": "9", "order_items": [] });
        let mut raw = item("1", "2", 1, 1);
        raw["properties"] = json!({});
        let row = zero_item_row(&order, &raw);
        assert_eq!(row["language"], "");
        assert_eq!(row["condition"], "");
        assert_eq!(row["game"], "");
        assert_eq!(row["rarity"], "");
    }

    #[test]
    fn linked_source_ids_unique() {
        let orders = vec![
            zero_order("1", "paid", vec![item("11", "101", 1, 1), item("12", "101", 1, 1)]),
            zero_order("2", "hub_pending", vec![item("21", "102", 1, 1)]),
        ];
        let list = build_zero_list(&orders);
        assert_eq!(linked_source_ids(&list), vec!["ct:101", "ct:102"]);
    }

    #[test]
    fn single_member_attaches_location_and_card() {
        let mut list = build_zero_list(&[zero_order("1", "paid", vec![item("11", "101", 1, 1)])]);
        split_lines(&mut list, &[row("l1", "101", "BOX·7", "2026-09-01T00:00:00.000Z")], &HashMap::new(), &HashMap::new());
        let line = &list["weekly"][0]["items"][0];
        assert_eq!(line["listingId"], "l1");
        assert_eq!(line["lineKey"], "11@l1");
        assert_eq!(line["location"], "BOX·7");
        assert_eq!(line["cardId"], "202");
        assert_eq!(line["collectorNumber"], "5/100");
        assert_eq!(line["allocation"], "listing");
        assert_eq!(line["game"], "pokemon");
        assert_eq!(line["listedAt"], "2026-09-01T00:00:00.000Z");
        assert_eq!(line["slot"], json!({ "box": "BOX", "stack": 7, "position": null }));
        assert_eq!(line["itemQuantity"], 1);
    }

    #[test]
    fn several_members_never_last_row_wins() {
        // Five copies of one product in three boxes, no webhook allocation:
        // one line at the oldest member, the other boxes in alsoIn.
        let mut list = build_zero_list(&[zero_order("1", "paid", vec![item("11", "101", 5, 10)])]);
        let rows = vec![
            row("30", "101", "box3·1", "2026-09-03T00:00:00.000Z"),
            row("10", "101", "box1·1", "2026-09-01T00:00:00.000Z"),
            row("20", "101", "box2·1", "2026-09-02T00:00:00.000Z"),
            row("40", "101", "box1·1", "2026-09-04T00:00:00.000Z"),
        ];
        split_lines(&mut list, &rows, &HashMap::new(), &HashMap::new());
        let out = lines(&list);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["listingId"], "10");
        assert_eq!(out[0]["quantity"], 5);
        assert_eq!(out[0]["allocation"], "members");
        assert_eq!(out[0]["alsoIn"], json!(["box2·1", "box3·1"]));

        // The listing the item names wins as primary.
        let mut named = item("11", "101", 5, 10);
        named["user_data_field"] = json!("pokoin:00000000-0000-4000-8000-000000000030");
        let mut list = build_zero_list(&[zero_order("1", "paid", vec![named])]);
        let mut rows = rows.clone();
        rows[0]["id"] = json!("00000000-0000-4000-8000-000000000030");
        split_lines(&mut list, &rows, &HashMap::new(), &HashMap::new());
        let out = lines(&list);
        assert_eq!(out[0]["location"], "box3·1");
        assert_eq!(out[0]["alsoIn"], json!(["box1·1", "box2·1"]));
    }

    #[test]
    fn webhook_allocations_split_one_line_per_box() {
        let mut list = build_zero_list(&[zero_order("1", "paid", vec![item("11", "101", 5, 10)])]);
        let rows = vec![
            row("10", "101", "box1·1", "2026-09-01T00:00:00.000Z"),
            row("20", "101", "box2·4", "2026-09-02T00:00:00.000Z"),
        ];
        let allocations = HashMap::from([(
            "11".to_string(),
            vec![
                Allocation { listing_id: "20".into(), quantity: 1 },
                Allocation { listing_id: "10".into(), quantity: 1 },
                Allocation { listing_id: "20".into(), quantity: 1 },
                Allocation { listing_id: "99".into(), quantity: 1 },
            ],
        )]);
        split_lines(&mut list, &rows, &allocations, &HashMap::new());
        let out = lines(&list);
        assert_eq!(field(&out, "lineKey"), vec!["11@20", "11@10", "11@99"]);
        // Remainder (5 - 4) lands on the first line; lines sum to the item.
        assert_eq!(out.iter().map(|l| l["quantity"].as_i64().unwrap()).collect::<Vec<_>>(), vec![3, 1, 1]);
        assert_eq!(out[0]["lineCents"], 30);
        assert!(out.iter().all(|l| l["allocation"] == "event" && l["itemQuantity"] == 5));
        assert_eq!(out[2]["location"], "", "allocation to a row we no longer have");
        assert_eq!(list["totals"]["weekly"]["lines"], 3);
        assert_eq!(list["totals"]["weekly"]["units"], 5);

        // An excess trims from the last allocation.
        let trimmed = reconcile_allocations(
            &[Allocation { listing_id: "a".into(), quantity: 2 }, Allocation { listing_id: "b".into(), quantity: 2 }],
            3,
        );
        assert_eq!(trimmed, vec![("a".to_string(), 2), ("b".to_string(), 1)]);
    }

    #[test]
    fn named_listing_or_none() {
        let mut named = item("11", "999", 1, 10);
        named["user_data_field"] = json!("pokoin:00000000-0000-4000-8000-000000000001");
        let mut list = build_zero_list(&[zero_order("1", "paid", vec![named, item("12", "998", 1, 10)])]);
        let mut listing = row("00000000-0000-4000-8000-000000000001", "555", "x·1", "2026-09-01T00:00:00.000Z");
        listing["source_listing_id"] = json!("pokoin_user_listing");
        split_lines(&mut list, &[listing], &HashMap::new(), &HashMap::new());
        let out = lines(&list);
        assert_eq!(out[0]["allocation"], "listing");
        assert_eq!(out[0]["location"], "x·1");
        assert_eq!(out[1]["allocation"], "none");
        assert_eq!(out[1]["lineKey"], "12");
        assert_eq!(out[1]["listedAt"], Value::Null);
    }

    #[tokio::test]
    async fn allocations_read_hub_order_first_and_skip_1dr_docs() {
        let store = MemoryFirestore::new();
        let mut weekly_item = item("11", "101", 2, 1);
        weekly_item["hub_pending_order_id"] = json!(55);
        let list = build_zero_list(&[
            zero_order("1", "paid", vec![weekly_item, item("12", "102", 1, 1)]),
            zero_order("2", "hub_pending", vec![item("21", "103", 1, 1)]),
        ]);
        store.seed(EVENTS_COLLECTION, &event_doc_id("u1", "55", "11"),
            json!({ "allocations": [{ "listingId": "a", "quantity": 2 }] })).await;
        store.seed(EVENTS_COLLECTION, &event_doc_id("u1", "1", "11"),
            json!({ "allocations": [{ "listingId": "wrong", "quantity": 2 }] })).await;
        store.seed(EVENTS_COLLECTION, &event_doc_id("u1", "1", "12"), json!({ "channel": "1dr" })).await;
        store.seed(EVENTS_COLLECTION, &event_doc_id("u1", "2", "21"),
            json!({ "allocations": [{ "listingId": 7, "quantity": 1 }] })).await;
        let found = read_allocations(&store, "u1", &list).await;
        assert_eq!(found["11"], vec![Allocation { listing_id: "a".into(), quantity: 2 }]);
        assert!(!found.contains_key("12"));
        assert_eq!(found["21"][0].listing_id, "7");
        let mut ids = linked_listing_ids(&list, &found);
        ids.sort();
        assert_eq!(ids, vec!["7", "a"]);
    }

    #[test]
    fn natural_compare() {
        assert_eq!(natural_cmp("box2", "box10"), Ordering::Less);
        assert_eq!(natural_cmp("Box2", "box2"), Ordering::Equal);
        assert_eq!(natural_cmp("2/102", "10/102"), Ordering::Less);
        assert_eq!(natural_cmp("box", "box1"), Ordering::Less);
        assert_eq!(natural_cmp("a007", "a7"), Ordering::Equal);
        assert_eq!(natural_cmp("x99999999999999999999999999", "x100000000000000000000000000"), Ordering::Less);
        assert_eq!(id_cmp("9", "10"), Ordering::Less);
        assert_eq!(id_cmp("b", "a"), Ordering::Greater);
    }

    #[test]
    fn slot_parse_matches_parse_listing_location() {
        let slot = |s: &str| parse_slot(s);
        assert_eq!(slot("box·3·5-9"), Slot { box_name: "box".into(), stack: Some(3), position: Some(5) });
        assert_eq!(slot("box·2-4"), Slot { box_name: "box".into(), stack: Some(2), position: None });
        assert_eq!(slot("box·2–4"), Slot { box_name: "box".into(), stack: Some(2), position: None });
        assert_eq!(slot("box1·47"), Slot { box_name: "box1".into(), stack: Some(47), position: None });
        assert_eq!(slot("box·1·47"), Slot { box_name: "box".into(), stack: Some(1), position: Some(47) });
        assert_eq!(slot(" bare box "), Slot { box_name: "bare box".into(), stack: None, position: None });
        assert_eq!(slot("b • 0 • x • 4"), Slot { box_name: "b".into(), stack: Some(4), position: None });
        assert_eq!(slot(""), Slot::default());
    }

    fn line(game: &str, location: &str, listed: Option<&str>, listing: &str, item_id: &str) -> Value {
        json!({
            "game": game, "location": location, "listedAt": listed, "listingId": listing,
            "itemId": item_id, "lineKey": item_id, "expansion": "", "collectorNumber": "", "name": "",
        })
    }

    fn sorted_locations(mut rows: Vec<Value>) -> Vec<String> {
        rows.sort_by(compare_picking_lines);
        rows.iter().map(|l| format!("{}|{}", l["game"].as_str().unwrap(), l["location"].as_str().unwrap())).collect()
    }

    #[test]
    fn multi_game_seed_sorts_as_the_contract_lists() {
        let expected = vec![
            line("magic", "binder·1·1", None, "1", "1"),
            line("magic", "binder·1·4", None, "2", "2"),
            line("pokemon", "box2·1", None, "3", "3"),
            line("pokemon", "box10·1", None, "4", "4"),
            line("pokemon", "", None, "", "5"),
            line("yugioh", "ygo·3", None, "6", "6"),
            line("riftbound", "megaevoluzionietb-41-20·2", Some("2026-09-01T00:00:00.000Z"), "7", "7"),
            line("riftbound", "megaevoluzionietb-41-20·2", Some("2026-09-05T00:00:00.000Z"), "8", "8"),
            line("riftbound", "megaevoluzionietb-41-20", None, "9", "9"),
            line("one_piece", "op·1", None, "10", "10"),
            line("", "zz·1", None, "11", "11"),
        ];
        let mut shuffled = expected.clone();
        shuffled.reverse();
        shuffled.swap(0, 5);
        shuffled.swap(2, 9);
        let mut sorted = shuffled;
        sorted.sort_by(compare_picking_lines);
        assert_eq!(field(&sorted, "itemId"), field(&expected, "itemId"));
    }

    #[test]
    fn stacks_positions_and_bare_boxes() {
        let rows = vec![
            line("pokemon", "box·3·5-9", None, "1", "1"),
            line("pokemon", "box·2-4", None, "2", "2"),
            line("pokemon", "box1·47", None, "3", "3"),
            line("pokemon", "box·1·47", None, "4", "4"),
        ];
        assert_eq!(
            sorted_locations(rows),
            vec!["pokemon|box·1·47", "pokemon|box·2-4", "pokemon|box·3·5-9", "pokemon|box1·47"]
        );
        let bare = vec![
            line("riftbound", "megaevoluzionietb-41-20", None, "1", "1"),
            line("riftbound", "megaevoluzionietb-41-20·12", None, "2", "2"),
            line("riftbound", "megaevoluzionietb-41-20·1·3", None, "3", "3"),
        ];
        assert_eq!(
            sorted_locations(bare),
            vec![
                "riftbound|megaevoluzionietb-41-20·1·3",
                "riftbound|megaevoluzionietb-41-20·12",
                "riftbound|megaevoluzionietb-41-20",
            ]
        );
        let boxes = vec![line("pokemon", "box10·1·1", None, "1", "1"), line("pokemon", "box2·9·9", None, "2", "2")];
        assert_eq!(sorted_locations(boxes), vec!["pokemon|box2·9·9", "pokemon|box10·1·1"]);
        // Position present before absent in the same stack.
        let positions = vec![line("pokemon", "b·1", None, "1", "1"), line("pokemon", "b·1·2", None, "2", "2")];
        assert_eq!(sorted_locations(positions), vec!["pokemon|b·1·2", "pokemon|b·1"]);
    }

    #[test]
    fn listed_date_then_numeric_ids_then_collector() {
        let mut rows = vec![
            line("pokemon", "b·1", Some("2026-09-05T00:00:00.000Z"), "1", "1"),
            line("pokemon", "b·1", Some("2026-09-01T00:00:00.000Z"), "2", "2"),
            line("pokemon", "b·1", None, "3", "3"),
        ];
        rows.sort_by(compare_picking_lines);
        assert_eq!(field(&rows, "listingId"), vec!["2", "1", "3"]);

        let mut same_date = vec![
            line("pokemon", "b·1", Some("2026-09-01T00:00:00.000Z"), "10", "1"),
            line("pokemon", "b·1", Some("2026-09-01T00:00:00.000Z"), "9", "2"),
        ];
        same_date.sort_by(compare_picking_lines);
        assert_eq!(field(&same_date, "listingId"), vec!["9", "10"]);

        let mut unlinked = vec![line("pokemon", "", None, "", "10"), line("pokemon", "", None, "", "9")];
        unlinked.sort_by(compare_picking_lines);
        assert_eq!(field(&unlinked, "itemId"), vec!["9", "10"]);

        let mut collectors = vec![line("pokemon", "", None, "", "1"), line("pokemon", "", None, "", "2")];
        collectors[0]["collectorNumber"] = json!("10/102");
        collectors[1]["collectorNumber"] = json!("2/102");
        collectors.sort_by(compare_picking_lines);
        assert_eq!(field(&collectors, "collectorNumber"), vec!["2/102", "10/102"]);
    }

    #[test]
    fn unlocated_last_within_a_game_but_game_first() {
        let rows = vec![
            line("riftbound", "a·1", None, "1", "1"),
            line("pokemon", "", None, "", "2"),
            line("pokemon", "z·9", None, "3", "3"),
        ];
        assert_eq!(sorted_locations(rows), vec!["pokemon|z·9", "pokemon|", "riftbound|a·1"]);
    }

    fn fixture(name: &str) -> Value {
        let raw = match name {
            "articles" => include_str!("fixtures/zero_pt_articles_to_pick.json"),
            "lists" => include_str!("fixtures/zero_pt_picking_lists.json"),
            _ => include_str!("fixtures/zero_pt_orders.json"),
        };
        serde_json::from_str(raw).unwrap()
    }

    /// CT order 9001: 501 (1), 502 (3, two boxes), 503 (1), sorted by us
    /// 501, 502, 503 while Power Tools picks 503, 502, 501.
    fn picking_list() -> Value {
        let mut list = build_zero_list(&[zero_order("9001", "paid", vec![
            item("501", "1", 1, 10),
            item("502", "2", 3, 10),
            item("503", "3", 1, 10),
        ])]);
        let rows = vec![
            row("1", "1", "a·1", "2026-09-01T00:00:00.000Z"),
            row("2", "2", "b·1", "2026-09-01T00:00:00.000Z"),
            row("4", "2", "b·2", "2026-09-02T00:00:00.000Z"),
            row("3", "3", "c·1", "2026-09-01T00:00:00.000Z"),
        ];
        let allocations = HashMap::from([(
            "502".to_string(),
            vec![Allocation { listing_id: "2".into(), quantity: 2 }, Allocation { listing_id: "4".into(), quantity: 1 }],
        )]);
        split_lines(&mut list, &rows, &allocations, &HashMap::new());
        list
    }

    #[test]
    fn picking_list_choice_prefers_cardtrader_zero() {
        let lists: Vec<Value> = fixture("lists").as_array().unwrap().clone();
        let orders = fixture("orders");
        let chosen = picking_list_for(&lists, &orders[0]).unwrap();
        assert_eq!(id_text(&chosen["ptId"]), "301");
        // Without the Zero list, the list holding the PT order by id.
        let chosen = picking_list_for(&lists[..1], &orders[0]).unwrap();
        assert_eq!(id_text(&chosen["ptId"]), "300");
        let targets = picking_targets(&picking_list(), orders.as_array().unwrap(), &lists);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].0, "9001");
    }

    #[test]
    fn power_tools_picking_order_overlay() {
        let lists: Vec<Value> = fixture("lists").as_array().unwrap().clone();
        let pt_orders: Vec<Value> = fixture("orders").as_array().unwrap().clone();
        let articles = HashMap::from([("301".to_string(), fixture("articles"))]);
        let mut list = picking_list();
        assert_eq!(attach_power_tools_picking(&mut list, &pt_orders, &lists, &articles), 1);
        attach_power_tools_orders(&mut list, &pt_orders);
        sort_for_picking(&mut list);
        mark_pt_mismatches(&mut list);
        let out = lines(&list);
        assert_eq!(field(&out, "lineKey"), vec!["501@1", "502@2", "502@4", "503@3"]);
        let pt = |i: usize| out[i]["powerTools"].clone();
        // Positions follow the pickings array order, not sortIndex; the other
        // order's article is ignored.
        assert_eq!(pt(0)["position"], 3);
        assert_eq!(pt(1)["position"], 2);
        assert_eq!(pt(3)["position"], 1);
        // 502: both lines carry the same object, picked summed over pickings.
        assert_eq!(pt(1), pt(2));
        assert_eq!(pt(1)["pickedQuantity"], 1);
        assert_eq!(pt(1)["ptQuantity"], 3);
        assert_eq!(pt(1)["location"], "Binder A, Box 3");
        assert_eq!(pt(1)["articleState"], "picked");
        assert_eq!(pt(0)["ptQuantity"], 1, "no location: article quantity");
        assert_eq!(pt(0)["location"], "");
        // Bin is the article's pickingId (string or number).
        assert_eq!(pt(1)["bin"], "B-12");
        assert_eq!(pt(3)["bin"], "12");
        assert_eq!(pt(0)["mismatch"], true);
        assert_eq!(pt(1)["mismatch"], false);
        assert_eq!(pt(3)["mismatch"], true);
        let picking = &list["weekly"][0]["ptPicking"];
        assert_eq!(picking["listId"], "301");
        assert_eq!(picking["listName"], "Zero 42");
        assert_eq!(picking["variant"], "cardtrader_zero");
        assert_eq!(picking["ctZeroClosed"], true);
        assert_eq!(picking["bin"], "B-12");
        assert_eq!(picking["comparable"], true);
        assert_eq!(picking["mismatches"], 2);
        assert_eq!(picking["sortingFields"][0]["field"], "location");
        assert_eq!(power_tools_counts(&list), (1, 3));
    }

    #[test]
    fn closing_single_order_list_is_ct_zero_closed() {
        let lists = vec![json!({ "ptId": 5, "name": "Mine", "variant": "default", "orders": [{ "ptOrderId": 81 }] })];
        let pt_orders: Vec<Value> = fixture("orders").as_array().unwrap().clone();
        let articles = HashMap::from([("5".to_string(), fixture("articles"))]);
        let mut list = build_zero_list(&[zero_order("9002", "paid", vec![item("601", "6", 1, 10)])]);
        split_lines(&mut list, &[], &HashMap::new(), &HashMap::new());
        attach_power_tools_picking(&mut list, &pt_orders, &lists, &articles);
        assert_eq!(list["weekly"][0]["ptPicking"]["ctZeroClosed"], true);
        assert_eq!(list["weekly"][0]["items"][0]["powerTools"]["position"], 1);
    }

    #[test]
    fn orders_fallback_reads_ids_as_text_and_order_bin() {
        let pt_orders: Vec<Value> = fixture("orders").as_array().unwrap().clone();
        let mut list = picking_list();
        assert_eq!(attach_power_tools_orders(&mut list, &pt_orders), 2);
        sort_for_picking(&mut list);
        mark_pt_mismatches(&mut list);
        let out = lines(&list);
        assert!(out.iter().all(|l| l["powerTools"]["position"].is_null()));
        assert!(out.iter().all(|l| l["powerTools"]["bin"] == "B-12"));
        assert_eq!(out[1]["powerTools"]["pickedQuantity"], 1, "sourceArticleId 502 as a number");
        assert_eq!(out[1]["powerTools"]["location"], "Binder A");
        assert_eq!(list["weekly"][0]["ptPicking"], Value::Null);
        assert_eq!(power_tools_counts(&list), (1, 3));
    }

    #[test]
    fn pt_location_display_drops_unknown() {
        assert_eq!(pt_display_location("unknown*"), "");
        assert_eq!(pt_display_location("Bin 4"), "Bin 4");
        assert_eq!(pt_display_location(""), "");
    }

    #[test]
    fn pick_body_validation() {
        let ok = parse_pick_request(&json!({ "orderId": 9001, "lineKey": "502@ab-1", "picked": 1200 })).unwrap();
        assert_eq!(ok.order_id, "9001");
        assert_eq!(ok.picked, Some(999));
        assert_eq!(ok.issue, None);
        let negative = parse_pick_request(&json!({ "orderId": "9001", "lineKey": "1", "picked": -3 })).unwrap();
        assert_eq!(negative.picked, Some(0));
        let reset = parse_pick_request(&json!({ "orderId": "9001", "reset": true })).unwrap();
        assert!(reset.reset);
        let clear = parse_pick_request(&json!({ "orderId": "1", "lineKey": "1", "issue": null })).unwrap();
        assert_eq!(clear.issue, Some(None));
        let issue = parse_pick_request(&json!({ "orderId": "1", "lineKey": "1", "issue": { "type": "missing", "note": " gone " } })).unwrap();
        assert_eq!(issue.issue, Some(Some(json!({ "type": "missing", "note": "gone" }))));

        let code = |body: Value| parse_pick_request(&body).unwrap_err().code.unwrap();
        assert_eq!(code(json!({ "orderId": "12a", "lineKey": "1", "picked": 1 })), "invalid_order");
        assert_eq!(code(json!({ "orderId": "1".repeat(41), "lineKey": "1", "picked": 1 })), "invalid_order");
        assert_eq!(code(json!({ "lineKey": "1", "picked": 1 })), "invalid_order");
        assert_eq!(code(json!({ "orderId": "1", "lineKey": "a b", "picked": 1 })), "invalid_line");
        assert_eq!(code(json!({ "orderId": "1", "lineKey": "x".repeat(121), "picked": 1 })), "invalid_line");
        assert_eq!(code(json!({ "orderId": "1", "lineKey": "1", "picked": "2" })), "invalid_picked");
        assert_eq!(code(json!({ "orderId": "1", "lineKey": "1", "issue": { "type": "lost" } })), "invalid_issue");
        assert_eq!(code(json!({ "orderId": "1", "lineKey": "1", "issue": { "type": "other", "note": "n".repeat(281) } })), "invalid_issue");
        assert_eq!(code(json!({ "orderId": "1", "lineKey": "1" })), "invalid_body");
        assert_eq!(code(json!([1])), "invalid_body");
        assert_eq!(parse_pick_request(&json!({ "orderId": "x", "lineKey": "1", "picked": 1 })).unwrap_err().status, 400);
    }

    #[test]
    fn pick_field_key_is_hex_of_line_key() {
        assert_eq!(pick_field_key("502@ab"), "l_353032406162");
        assert_eq!(pick_field_key("A.-_:"), "l_412e2d5f3a");
        assert_eq!(picks_doc_id("u1", "9001"), "u1_9001");
    }

    #[tokio::test]
    async fn picks_round_trip_onto_lines() {
        let store = MemoryFirestore::new();
        let mut list = picking_list();
        let save = |body: Value| parse_pick_request(&body).unwrap();
        save_pick(&store, "u1", &save(json!({ "orderId": "9001", "lineKey": "502@2", "picked": 5 }))).await.unwrap();
        let out = save_pick(&store, "u1", &save(json!({ "orderId": "9001", "lineKey": "502@2", "issue": { "type": "wrong_condition", "note": "LP" } })))
            .await
            .unwrap();
        assert_eq!(out["line"]["picked"], 5, "issue-only update keeps picked");
        assert_eq!(out["line"]["issue"]["type"], "wrong_condition");
        save_pick(&store, "u1", &save(json!({ "orderId": "9001", "lineKey": "501@1", "picked": 1 }))).await.unwrap();
        save_pick(&store, "u2", &save(json!({ "orderId": "9001", "lineKey": "503@3", "picked": 1 }))).await.unwrap();
        let doc = store.get_doc(PICKS_COLLECTION, "u1_9001").await.unwrap();
        assert!(doc.data.get(pick_field_key("502@2")).is_some(), "each line is a top-level field");

        let picks = read_picks(&store, "u1", &list).await;
        apply_picks(&mut list, &picks);
        let out = lines(&list);
        let by_key = |key: &str| out.iter().find(|l| l["lineKey"] == key).unwrap().clone();
        assert_eq!(by_key("502@2")["picked"], 2, "clamped to the line quantity");
        assert_eq!(by_key("502@2")["issue"]["note"], "LP");
        assert_eq!(by_key("501@1")["picked"], 1);
        assert_eq!(by_key("503@3")["picked"], 0, "another seller's picks never leak");
        assert_eq!(list["weekly"][0]["pickedLines"], 2);
        assert_eq!(list["weekly"][0]["issueCount"], 1);

        let reset = save_pick(&store, "u1", &save(json!({ "orderId": "9001", "reset": true }))).await.unwrap();
        assert_eq!(reset, json!({ "ok": true, "orderId": "9001", "reset": true }));
        assert!(!store.get_doc(PICKS_COLLECTION, "u1_9001").await.unwrap().exists);
    }

    fn pt_line(game: &str, location: &str, pt_location: &str, item_id: &str) -> Value {
        let mut out = line(game, location, None, "", item_id);
        out["ptLocation"] = json!(pt_location);
        out
    }

    #[test]
    fn power_tools_location_names_rank_in_the_slot_model() {
        let slot = |box_name: &str, stack: Option<i64>| Slot { box_name: box_name.into(), stack, position: None };
        assert_eq!(pt_slot("FUOCOBOMBA 001 - 131"), slot("FUOCOBOMBA 001", Some(131)));
        assert_eq!(pt_slot("FUOCOBOMBA 001 - 1"), slot("FUOCOBOMBA 001", Some(1)));
        assert_eq!(pt_slot("BINDER 7"), slot("BINDER", Some(7)));
        assert_eq!(pt_slot("DANDANDECK"), slot("DANDANDECK", None));
        assert_eq!(pt_slot("box·2·4"), Slot { box_name: "box".into(), stack: Some(2), position: Some(4) });
        assert_eq!(pt_display_location("DANDANDECK: 1 (2 available)"), "DANDANDECK");
        assert_eq!(pt_display_location("DANDANDECK (2 available)"), "DANDANDECK");
        assert_eq!(pt_display_location("DANDANDECK:"), "DANDANDECK");
        assert_eq!(pt_display_location("unknown"), "");

        let mut rows = vec![
            pt_line("pokemon", "", "unknown", "1"),
            pt_line("pokemon", "", "FUOCOBOMBA 001 - 131", "2"),
            pt_line("pokemon", "", "DANDANDECK: 1 (2 available)", "3"),
            pt_line("pokemon", "", "FUOCOBOMBA 001 - 1", "4"),
            pt_line("pokemon", "", "DANDANDECK", "5"),
        ];
        rows.sort_by(compare_picking_lines);
        assert_eq!(field(&rows, "itemId"), vec!["3", "5", "4", "2", "1"]);
    }

    #[test]
    fn power_tools_only_lines_sit_between_pokoin_lines() {
        let mut list = json!({
            "weekly": [{ "orderId": "1", "items": [
                pt_line("pokemon", "zz·1", "AAA 1", "1"),
                pt_line("pokemon", "FUOCOBOMBA 001·3", "", "2"),
                pt_line("pokemon", "", "FUOCOBOMBA 001 - 2", "3"),
                pt_line("pokemon", "FUOCOBOMBA 001·1", "", "4"),
                pt_line("pokemon", "", "", "5"),
            ]}],
            "pending": { "items": [] },
        });
        sort_for_picking(&mut list);
        let out = lines(&list);
        assert_eq!(field(&out, "itemId"), vec!["4", "3", "2", "1", "5"]);
        assert_eq!(field(&out, "sortLocation"), vec!["FUOCOBOMBA 001·1", "FUOCOBOMBA 001 - 2", "FUOCOBOMBA 001·3", "zz·1", ""]);
        assert_eq!(field(&out, "locationSource"), vec!["pokoin", "powertools", "pokoin", "pokoin", ""]);
        assert_eq!(out[1]["slot"], json!({ "box": "FUOCOBOMBA 001", "stack": 2, "position": null }));
    }

    #[test]
    fn picking_overlay_locates_lines_without_a_pokoin_location() {
        // No Pokoin rows: 502's two event lines take Power Tools' two locations.
        let mut list = build_zero_list(&[zero_order("9001", "paid", vec![
            item("501", "1", 1, 10),
            item("502", "2", 3, 10),
            item("503", "3", 1, 10),
        ])]);
        let allocations = HashMap::from([(
            "502".to_string(),
            vec![Allocation { listing_id: "x".into(), quantity: 2 }, Allocation { listing_id: "y".into(), quantity: 1 }],
        )]);
        split_lines(&mut list, &[], &allocations, &HashMap::new());
        let lists: Vec<Value> = fixture("lists").as_array().unwrap().clone();
        let pt_orders: Vec<Value> = fixture("orders").as_array().unwrap().clone();
        let articles = HashMap::from([("301".to_string(), fixture("articles"))]);
        attach_power_tools_picking(&mut list, &pt_orders, &lists, &articles);
        attach_power_tools_orders(&mut list, &pt_orders);
        sort_for_picking(&mut list);
        let out = lines(&list);
        assert_eq!(field(&out, "lineKey"), vec!["502@x", "502@y", "503", "501"]);
        assert_eq!(field(&out, "sortLocation"), vec!["Binder A", "Box 3", "Box 3", ""]);
        assert_eq!(field(&out, "locationSource"), vec!["powertools", "powertools", "powertools", ""]);
        assert_eq!(out[0]["location"], "", "the Pokoin location stays empty");
        // PT idGame 6 (Cardmarket Pokémon) on 502's article.
        assert_eq!(out[0]["game"], "pokemon");
        assert_eq!(out[0]["gameSource"], "powertools");
    }

    #[test]
    fn orders_fallback_location_names() {
        let article = json!({ "locations": [
            { "name": "BINDER 7", "quantity": 0, "deltaQuantity": -1 },
            { "name": "unknown", "quantity": 3 },
            { "name": "EMPTY", "quantity": 0 },
            { "name": "DECK: 1 (2 available)", "quantity": 2 },
        ]});
        assert_eq!(pt_location_names(&article), vec!["BINDER 7", "DECK"]);
        let info = json!({ "locationInfo": { "name": "Box 9" }, "locations": [{ "name": "BINDER 7", "quantity": 1 }] });
        assert_eq!(pt_location_names(&info), vec!["Box 9"]);
    }

    #[test]
    fn games_resolve_without_game_id_and_listing_default_never_wins() {
        let mut with_game_id = item("c", "6", 1, 10);
        with_game_id["game_id"] = json!(1);
        let mut items = vec![
            item("p", "1", 1, 10),
            item("o", "2", 1, 10),
            item("r", "3", 1, 10),
            item("y", "4", 1, 10),
            item("m", "5", 1, 10),
            with_game_id,
        ];
        for (raw, blueprint) in items.iter_mut().zip(["1002", "2000", "3000", "4000", "1001", "1002"]) {
            raw["blueprint_id"] = json!(blueprint);
        }
        let mut list = build_zero_list(&[zero_order("9100", "paid", items)]);
        // Every listing says 'pokemon' (the column default).
        let rows: Vec<Value> = ["1", "2", "3", "4", "5", "6"]
            .iter()
            .map(|product| row(&format!("l{product}"), product, "", "2026-09-01T00:00:00.000Z"))
            .collect();
        let blueprints = HashMap::from([
            ("1001".to_string(), "magic".to_string()),
            ("1002".to_string(), "pokemon".to_string()),
        ]);
        split_lines(&mut list, &rows, &HashMap::new(), &blueprints);
        let pt_orders = vec![json!({
            "ptOrderId": 90, "source": "Cardtrader", "sourceOrderId": 9100,
            "articles": [
                { "sourceArticleId": "y", "product": { "idGame": 3 } },
                { "sourceArticleId": "r", "product": { "idGame": "22" } },
                { "sourceArticleId": "o", "product": { "idGame": 18 } },
                { "sourceArticleId": "m", "product": { "idGame": 3 } },
            ],
        })];
        attach_power_tools_orders(&mut list, &pt_orders);
        sort_for_picking(&mut list);
        let out = lines(&list);
        assert_eq!(field(&out, "itemId"), vec!["m", "c", "p", "y", "r", "o"]);
        assert_eq!(field(&out, "game"), vec!["magic", "magic", "pokemon", "yugioh", "riftbound", "one_piece"]);
        assert_eq!(
            field(&out, "gameSource"),
            vec!["blueprint", "cardtrader", "blueprint", "powertools", "powertools", "powertools"]
        );
        // With nothing better, the listing's game is used and says so.
        let mut lone = build_zero_list(&[zero_order("9200", "paid", vec![item("z", "7", 1, 10)])]);
        split_lines(&mut lone, &[row("l7", "7", "", "2026-09-01T00:00:00.000Z")], &HashMap::new(), &HashMap::new());
        assert_eq!(lone["weekly"][0]["items"][0]["gameSource"], "listing");
        assert_eq!(cardmarket_game(9), "");
        assert_eq!(cardmarket_game(13), "dragon_ball_super");
    }

    // ------------------------------------------------------------ sort model

    #[test]
    fn shared_sort_fixture_matches() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/zero-sort-cases.json")).unwrap();
        assert!(cases.len() >= 8);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let parsed = parse_sorting_fields(&case["fields"]);
            if let Some(code) = case.get("error").and_then(Value::as_str) {
                assert_eq!(parsed.unwrap_err().code.as_deref(), Some(code), "{name}");
                continue;
            }
            let fields = parsed.unwrap_or_else(|e| panic!("{name}: {}", e.message));
            let mut lines = case["lines"].as_array().unwrap().clone();
            lines.sort_by(|a, b| compare_with_fields(a, b, &fields));
            assert_eq!(field(&lines, "lineKey"), case["expected"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>(), "{name}");
            // Reversing the input changes nothing: the order is total.
            let mut reversed = case["lines"].as_array().unwrap().clone();
            reversed.reverse();
            reversed.sort_by(|a, b| compare_with_fields(a, b, &fields));
            assert_eq!(field(&reversed, "lineKey"), field(&lines, "lineKey"), "{name} reversed");
        }
    }

    #[test]
    fn default_fields_equal_the_fixed_comparator() {
        let fields = default_sorting_fields();
        let rows = vec![
            line("pokemon", "box2·1", None, "5", "1"),
            line("magic", "", Some("2026-09-01T00:00:00.000Z"), "", "2"),
            line("", "box1", None, "7", "3"),
            line("pokemon", "box2", Some("2026-09-01T00:00:00.000Z"), "8", "4"),
            line("riftbound", "z·1·2", None, "9", "5"),
            line("pokemon", "box2·1", Some("2026-08-01T00:00:00.000Z"), "10", "6"),
        ];
        for a in &rows {
            for b in &rows {
                assert_eq!(compare_with_fields(a, b, &fields), compare_picking_lines(a, b));
            }
        }
    }

    #[test]
    fn sorting_fields_validation() {
        assert_eq!(parse_sorting_fields(&json!([])).unwrap(), vec!["none"; 4]);
        assert_eq!(
            parse_sorting_fields(&json!(["product.rarity.desc", "extras"])).unwrap(),
            vec!["product.rarity.desc", "extras", "none", "none"]
        );
        assert_eq!(parse_sorting_fields(&json!(["cn.asc", "none", "none"])).unwrap()[0], "cn.asc");
        for (raw, code) in [
            (json!("cn.asc"), "invalid_sorting_fields"),
            (json!(["cn"]), "invalid_sorting_field"),
            (json!(["none.asc"]), "invalid_sorting_field"),
            (json!(["extras.asc"]), "invalid_sorting_field"),
            (json!(["cn.up"]), "invalid_sorting_field"),
            (json!([1]), "invalid_sorting_field"),
            (json!(["cn.asc", "none", "game.asc"]), "invalid_sorting_fields"),
            (json!(["game.asc", "game.desc"]), "duplicate_sorting_field"),
            (json!(["set.asc", "product.expansion.asc"]), "invalid_sorting_field_never"),
        ] {
            let result = parse_sorting_fields(&raw);
            if code == "invalid_sorting_field_never" {
                assert!(result.is_ok(), "set and product.expansion are different Power Tools fields");
                continue;
            }
            assert_eq!(result.unwrap_err().code.as_deref(), Some(code), "{raw}");
        }
        assert_eq!(rarity_rank("Common"), Some(0));
        assert!(rarity_rank("Hyper Rare") > rarity_rank("Special Illustration Rare"));
        assert_eq!(rarity_rank("Mythic"), Some(3));
        assert_eq!(rarity_rank(""), None);
    }

    #[test]
    fn sort_request_and_settings_doc() {
        let current = ZeroSettings::default();
        assert_eq!(current.sorting_fields, default_sorting_fields());
        assert!(current.smart_locations);
        let next = parse_sort_request(&json!({ "fields": ["price.desc"] }), &current).unwrap();
        assert_eq!(next.sorting_fields, vec!["price.desc", "none", "none", "none"]);
        assert!(next.smart_locations);
        let off = parse_sort_request(&json!({ "smartLocations": false }), &next).unwrap();
        assert_eq!(off.sorting_fields, next.sorting_fields);
        assert!(!off.smart_locations);
        let reset = parse_sort_request(&json!({ "reset": true }), &off).unwrap();
        assert_eq!(reset.sorting_fields, default_sorting_fields());
        assert!(!reset.smart_locations);
        assert_eq!(parse_sort_request(&json!({}), &current).unwrap_err().code.as_deref(), Some("invalid_body"));
        assert_eq!(
            parse_sort_request(&json!({ "smartLocations": "no" }), &current).unwrap_err().code.as_deref(),
            Some("invalid_body")
        );
        // A stored sort that no longer validates falls back to the default.
        let stored = ZeroSettings::from_doc(&json!({ "sortingFields": ["cn.asc", "cn.desc"], "smartLocations": false }));
        assert_eq!(stored.sorting_fields, default_sorting_fields());
        assert!(!stored.smart_locations);
        assert_eq!(
            stored.sorting_json(),
            json!({ "fields": DEFAULT_SORTING_FIELDS, "defaultFields": DEFAULT_SORTING_FIELDS, "smartLocations": false })
        );
    }

    #[test]
    fn saved_sort_orders_the_list() {
        let mut list = build_zero_list(&[zero_order("1", "paid", vec![item("11", "101", 1, 300), item("12", "102", 1, 100)])]);
        split_lines(&mut list, &[], &HashMap::new(), &HashMap::new());
        sort_for_picking_with(&mut list, &["price.asc".to_string()]);
        assert_eq!(field(&lines(&list), "itemId"), vec!["12", "11"]);
        sort_for_picking_with(&mut list, &["price.desc".to_string()]);
        assert_eq!(field(&lines(&list), "itemId"), vec!["11", "12"]);
    }

    #[test]
    fn candidates_on_every_line_with_other_copies() {
        const NAMED: &str = "00000000-0000-4000-8000-000000000030";
        let mut rows = vec![
            row(NAMED, "101", "box3·1", "2026-09-03T00:00:00.000Z"),
            row("10", "101", "box1·1", "2026-09-01T00:00:00.000Z"),
            row("20", "101", "box2·1", "2026-09-02T00:00:00.000Z"),
            row("40", "101", "box4·1", "2026-09-04T00:00:00.000Z"),
            row("50", "101", "box5·1", "2026-09-05T00:00:00.000Z"),
            row("60", "101", "box6·1", "2026-09-06T00:00:00.000Z"),
        ];
        rows[0]["quantity_available"] = json!(2);
        rows[3]["status"] = json!("paused");
        rows[4]["quantity_available"] = json!(0);
        rows[4]["status"] = json!("sold_out");
        rows[5]["status"] = json!("inactive");
        let mut named = item("11", "101", 2, 10);
        named["user_data_field"] = json!(format!("pokoin:{NAMED}"));

        // Members fallback: the line's own (named) copy excluded, then oldest;
        // sold-out and inactive rows are not candidates. alsoIn is unchanged.
        let mut list = build_zero_list(&[zero_order("1", "paid", vec![named.clone()])]);
        split_lines(&mut list, &rows, &HashMap::new(), &HashMap::new());
        let line = &lines(&list)[0];
        assert_eq!(line["allocation"], "members");
        assert_eq!(line["quantityAvailable"], 2);
        assert_eq!(
            line["candidates"],
            json!([
                { "listingId": "10", "location": "box1·1", "quantityAvailable": 1 },
                { "listingId": "20", "location": "box2·1", "quantityAvailable": 1 },
                { "listingId": "40", "location": "box4·1", "quantityAvailable": 1 },
            ])
        );
        assert_eq!(line["alsoIn"], json!(["box1·1", "box2·1", "box4·1", "box5·1", "box6·1"]));

        // An allocated (event) line of a grouped product: the named listing first.
        let allocations = HashMap::from([("11".to_string(), vec![Allocation { listing_id: "20".into(), quantity: 2 }])]);
        let mut event = build_zero_list(&[zero_order("1", "paid", vec![named])]);
        split_lines(&mut event, &rows, &allocations, &HashMap::new());
        let line = &lines(&event)[0];
        assert_eq!(line["allocation"], "event");
        assert_eq!(
            line["candidates"].as_array().unwrap().iter().map(|c| c["listingId"].as_str().unwrap()).collect::<Vec<_>>(),
            vec![NAMED, "10", "40"]
        );

        // A single copy has none; an unlinked line has no quantityAvailable.
        let mut single = build_zero_list(&[zero_order("1", "paid", vec![item("12", "102", 1, 10), item("13", "999", 1, 10)])]);
        split_lines(&mut single, &[row("70", "102", "box7", "2026-09-01T00:00:00.000Z")], &HashMap::new(), &HashMap::new());
        let out = lines(&single);
        assert_eq!(out[0]["candidates"], json!([]));
        assert_eq!(out[0]["quantityAvailable"], 1);
        assert_eq!(out[1]["quantityAvailable"], Value::Null);
    }

    #[tokio::test]
    async fn postgres_picks_win_per_order_and_firestore_stays_the_fallback() {
        let store = MemoryFirestore::new();
        let mut list = build_zero_list(&[
            zero_order("1", "paid", vec![item("11", "101", 2, 10)]),
            zero_order("2", "paid", vec![item("21", "201", 1, 10)]),
        ]);
        split_lines(&mut list, &[row("l1", "101", "a·1", "2026-09-01T00:00:00.000Z")], &HashMap::new(), &HashMap::new());
        // Order 1 was ticked in Firestore before the deploy and in Postgres since.
        store.seed(PICKS_COLLECTION, &picks_doc_id("u1", "1"), json!({ pick_field_key("11@l1"): { "picked": 2, "issue": { "type": "missing" } } })).await;
        store.seed(PICKS_COLLECTION, &picks_doc_id("u1", "2"), json!({ pick_field_key("21"): { "picked": 1 } })).await;
        let picks = read_picks(&store, "u1", &list).await;
        let pg = group_pg_picks(&[json!({
            "id": 7, "order_id": "1", "item_id": "11", "line_key": "11@l1", "listing_id": "l2",
            "allocated_listing_id": "l1", "kind": "swap", "quantity": 1,
        })]);
        apply_picks_with(&mut list, &picks, &pg);
        let first = &list["weekly"][0]["items"][0];
        assert_eq!(first["picked"], 1, "Postgres count, not the Firestore 2");
        assert_eq!(first["issue"]["type"], "missing", "issues stay in Firestore");
        assert_eq!(first["picks"][0]["listingId"], "l2");
        assert_eq!(first["picks"][0]["kind"], "swap");
        let second = &list["weekly"][1]["items"][0];
        assert_eq!(second["picked"], 1, "no Postgres rows: the Firestore count");
        assert_eq!(second["picks"], json!([]));
    }

    // ------------------------------------------------------------ Apply sort

    fn pt_list() -> Value {
        json!({
            "articleMap": {
                "1": { "ptOrderArticleId": 1, "source": "Cardtrader", "sourceOrderId": 9001, "sourceArticleId": "501", "updatedAt": "2026-10-20T10:00:00.000Z" },
                "2": { "ptOrderArticleId": 2, "source": "Cardtrader", "sourceOrderId": "9001", "sourceArticleId": 502 },
                "3": { "ptOrderArticleId": 3, "source": "Cardtrader", "sourceOrderId": 9001, "sourceArticleId": "503" },
                "4": { "ptOrderArticleId": 4, "source": "Cardtrader", "sourceOrderId": 9001, "sourceArticleId": "504", "updatedAt": "2026-10-20T09:00:00.000Z" },
                "5": { "ptOrderArticleId": 5, "source": "Cardtrader", "sourceOrderId": 9001, "sourceArticleId": "505" },
            },
            "pickings": [
                { "ptOrderArticleId": 3, "articleState": "toPick" },
                { "ptOrderArticleId": 1, "articleState": "picked" },
                { "ptOrderArticleId": 2, "articleState": "toPick" },
                { "ptOrderArticleId": 2, "articleState": "picked" },
                { "ptOrderArticleId": 4, "articleState": "picked" },
                { "ptOrderArticleId": 5, "articleState": "toPick" },
            ],
            "sortingFields": [{ "field": "location", "direction": "asc" }],
        })
    }

    #[test]
    fn pt_sort_items_picked_first_then_sequence() {
        let list = pt_list();
        let current = pt_sort_items(&list, None).unwrap();
        // Picked by updatedAt (504 then 501), then to-pick in PT order; 502
        // has a to-pick picking left, so it is to pick, once.
        assert_eq!(pt_item_ids(&current), vec!["504", "501", "503", "502", "505"]);
        assert_eq!(pt_to_pick_ids(&list), vec!["503", "502", "505"]);
        let items = pt_sort_items(&list, Some(&["505".into(), "502".into(), "502".into(), "501".into()])).unwrap();
        // Unlisted 503 keeps PT order after the sequence; picked 501 stays in the picked block.
        assert_eq!(pt_item_ids(&items), vec!["504", "501", "505", "502", "503"]);
        // Only the three keys, exactly as Power Tools sent them.
        assert_eq!(items[3], json!({ "source": "Cardtrader", "sourceArticleId": 502, "sourceOrderId": "9001" }));
        let error = pt_sort_items(&list, Some(&["505".into(), "999".into()])).unwrap_err();
        assert_eq!(error.status, 409);
        assert_eq!(error.code.as_deref(), Some("pt_sort_mismatch"));
        assert_eq!(error.problems, Some(json!({ "unknownIds": ["999"] })));
        assert_eq!(pt_list_sorting_fields(&list), json!([{ "field": "location", "direction": "asc" }]));
        assert_eq!(pt_list_sorting_fields(&json!({})), json!([]));
    }

    #[test]
    fn pt_sort_request_validation_and_throttle() {
        let ok = parse_pt_sort_request(&json!({ "orderId": 9001, "listId": 301, "sequence": ["1", 2, "1"], "expectCount": 3 })).unwrap();
        assert_eq!(ok.sequence, vec!["1", "2"]);
        assert_eq!(ok.list_id, json!(301));
        assert!(!ok.dry_run);
        assert!(parse_pt_sort_request(&json!({ "orderId": "1", "listId": "a", "sequence": [], "dryRun": true })).is_ok());
        for (body, code) in [
            (json!({ "orderId": "x", "listId": 1, "sequence": [], "expectCount": 0 }), "invalid_order"),
            (json!({ "orderId": "1", "listId": "a b", "sequence": [], "expectCount": 0 }), "invalid_list"),
            (json!({ "orderId": "1", "listId": 1, "sequence": "1", "expectCount": 0 }), "invalid_sequence"),
            (json!({ "orderId": "1", "listId": 1, "sequence": [null], "expectCount": 0 }), "invalid_sequence"),
            (json!({ "orderId": "1", "listId": 1, "sequence": [] }), "invalid_body"),
        ] {
            assert_eq!(parse_pt_sort_request(&body).unwrap_err().code.as_deref(), Some(code), "{body}");
        }
        let now = crate::time_util::ms_from_iso("2026-10-22T10:00:10.000Z").unwrap();
        assert!(pt_sort_throttled(&json!({ "ptSortAt": "2026-10-22T10:00:00.000Z" }), now));
        assert!(!pt_sort_throttled(&json!({ "ptSortAt": "2026-10-22T09:59:50.000Z" }), now));
        assert!(!pt_sort_throttled(&json!({}), now));
    }

    #[test]
    fn pt_write_errors_map_to_codes() {
        use crate::powertools::pt_write_error;
        let code = |status, text: &str| {
            let payload: Value = serde_json::from_str(text).unwrap_or(Value::Null);
            pt_write_error(status, text, &payload).map(|e| (e.status, e.code.unwrap_or_default()))
        };
        assert_eq!(code(200, ""), None);
        assert_eq!(code(200, r#"{"ok":true}"#), None);
        assert_eq!(code(401, ""), Some((409, "powertools_session_expired".into())));
        assert_eq!(code(403, ""), Some((409, "powertools_session_expired".into())));
        assert_eq!(code(400, r#"{"error":"Cardtrader token missing"}"#), Some((409, "powertools_cardtrader_not_connected".into())));
        assert_eq!(code(500, r#"{"message":"Invalid Picking List"}"#), Some((409, "pt_picking_list_missing".into())));
        assert_eq!(code(200, r#"{"error":"Invalid Picking List"}"#), Some((409, "pt_picking_list_missing".into())));
        assert_eq!(code(500, "boom"), Some((502, "powertools_unavailable".into())));
    }

    /// A fake Power Tools picking list. `getArticlesToPick` answers the list;
    /// `updateSorting` records its body and, when `keeps`, reorders the
    /// pickings as the items say. `update_status` != 200 answers that error.
    async fn fake_pt_list(
        list: Value,
        keeps: bool,
        update_status: u16,
        update_answer: Value,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>) {
        use axum::extract::Request;
        let state = std::sync::Arc::new(std::sync::Mutex::new(list));
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        let app = axum::Router::new().fallback(move |request: Request| {
            let state = state.clone();
            let log = log.clone();
            let update_answer = update_answer.clone();
            async move {
                let path = request.uri().path().to_string();
                let bytes = axum::body::to_bytes(request.into_body(), 1 << 20).await.unwrap_or_default();
                let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                log.lock().unwrap().push((path.clone(), body.clone()));
                if path.ends_with("updateSorting") {
                    if update_status != 200 {
                        return (axum::http::StatusCode::from_u16(update_status).unwrap(), axum::Json(update_answer));
                    }
                    if keeps {
                        let mut list = state.lock().unwrap();
                        let order: Vec<String> = pt_item_ids(body["items"].as_array().unwrap());
                        let map = list["articleMap"].clone();
                        let rank = |picking: &Value| {
                            let article = &map[id_text(&picking["ptOrderArticleId"])];
                            order.iter().position(|id| *id == id_text(&article["sourceArticleId"])).unwrap_or(usize::MAX)
                        };
                        let mut pickings = list["pickings"].as_array().unwrap().clone();
                        pickings.sort_by_key(rank);
                        list["pickings"] = json!(pickings);
                    }
                    return (axum::http::StatusCode::OK, axum::Json(json!({ "ok": true })));
                }
                (axum::http::StatusCode::OK, axum::Json(state.lock().unwrap().clone()))
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), seen)
    }

    const PT_KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    async fn connected_store() -> MemoryFirestore {
        std::env::set_var("CARDTRADER_TOKEN_ENCRYPTION_KEY", PT_KEY);
        let store = MemoryFirestore::new();
        crate::powertools::store_power_tools_session(&store, "u1", "a.b.c", &json!({ "username": "seller" })).await.unwrap();
        store
    }

    fn sort_request(sequence: &[&str], dry_run: bool, expect: Option<usize>) -> PtSortRequest {
        PtSortRequest {
            order_id: "9001".into(),
            list_id: json!(301),
            sequence: sequence.iter().map(|s| s.to_string()).collect(),
            dry_run,
            expect_count: expect,
        }
    }

    #[tokio::test]
    async fn apply_sort_dry_run_writes_nothing() {
        let store = connected_store().await;
        let (base, seen) = fake_pt_list(pt_list(), true, 200, json!({})).await;
        let client = crate::powertools::PowerToolsClient::new().with_base(base);
        let out = apply_pt_sort(&store, &client, "u1", &sort_request(&["505", "503", "502"], true, None)).await.unwrap();
        assert_eq!(out["dryRun"], true);
        assert_eq!(out["before"], json!(["504", "501", "503", "502", "505"]));
        assert_eq!(out["items"], json!(["504", "501", "505", "503", "502"]));
        let calls = seen.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].0.ends_with("getArticlesToPick"));
        assert_eq!(calls[0].1, json!({ "pickingListId": 301 }), "never sortingFields on the read");
        // A dry run is not throttled and sets no throttle.
        assert!(store.get_doc(SETTINGS_COLLECTION, "u1").await.unwrap().data.get("ptSortAt").is_none());
    }

    #[tokio::test]
    async fn apply_sort_writes_once_reads_back_and_throttles() {
        let store = connected_store().await;
        let (base, seen) = fake_pt_list(pt_list(), true, 200, json!({})).await;
        let client = crate::powertools::PowerToolsClient::new().with_base(base);
        let out = apply_pt_sort(&store, &client, "u1", &sort_request(&["505", "503", "502"], false, Some(5))).await.unwrap();
        assert_eq!(out["before"], json!(["504", "501", "503", "502", "505"]));
        assert_eq!(out["after"], json!(["504", "501", "505", "503", "502"]));
        assert_eq!(out["applied"], true);
        let calls = seen.lock().unwrap().clone();
        assert_eq!(calls.iter().map(|(p, _)| p.rsplit('/').next().unwrap().to_string()).collect::<Vec<_>>(),
            vec!["getArticlesToPick", "updateSorting", "getArticlesToPick"]);
        let write = &calls[1].1;
        assert_eq!(write["pickingListId"], 301);
        assert_eq!(write["sortingFields"], json!([{ "field": "location", "direction": "asc" }]), "the list's sort, unchanged");
        assert_eq!(write["items"].as_array().unwrap().len(), 5);
        assert!(write["items"].as_array().unwrap().iter().all(|i| i.as_object().unwrap().len() == 3));

        // A second write within 15 s is refused before any Power Tools call.
        let error = apply_pt_sort(&store, &client, "u1", &sort_request(&["503"], false, Some(5))).await.unwrap_err();
        assert_eq!(error.status, 429);
        assert_eq!(error.code.as_deref(), Some("pt_sort_throttled"));
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn apply_sort_reports_when_power_tools_recomputes() {
        let store = connected_store().await;
        let (base, _) = fake_pt_list(pt_list(), false, 200, json!({})).await;
        let client = crate::powertools::PowerToolsClient::new().with_base(base);
        let out = apply_pt_sort(&store, &client, "u1", &sort_request(&["505"], false, Some(5))).await.unwrap();
        assert_eq!(out["applied"], false);
        assert_eq!(out["after"], out["before"]);
    }

    #[tokio::test]
    async fn apply_sort_refuses_count_drift_and_maps_write_errors() {
        let store = connected_store().await;
        let (base, seen) = fake_pt_list(pt_list(), true, 200, json!({})).await;
        let client = crate::powertools::PowerToolsClient::new().with_base(base);
        let error = apply_pt_sort(&store, &client, "u1", &sort_request(&["505"], false, Some(4))).await.unwrap_err();
        assert_eq!(error.code.as_deref(), Some("pt_sort_count_changed"));
        assert!(!seen.lock().unwrap().iter().any(|(p, _)| p.ends_with("updateSorting")));

        for (status, answer, code) in [
            (400, json!({ "error": "no cardtrader token" }), "powertools_cardtrader_not_connected"),
            (400, json!({ "error": "Invalid Picking List" }), "pt_picking_list_missing"),
            (500, json!({ "error": "boom" }), "powertools_unavailable"),
            (401, json!({}), "powertools_session_expired"),
        ] {
            let store = connected_store().await;
            let (base, seen) = fake_pt_list(pt_list(), true, status, answer).await;
            let client = crate::powertools::PowerToolsClient::new().with_base(base);
            let error = apply_pt_sort(&store, &client, "u1", &sort_request(&["505"], false, Some(5))).await.unwrap_err();
            assert_eq!(error.code.as_deref(), Some(code));
            // Never retried: one write, no read-back.
            let calls = seen.lock().unwrap().clone();
            assert_eq!(calls.iter().filter(|(p, _)| p.ends_with("updateSorting")).count(), 1);
            assert_eq!(calls.len(), 2);
            if code == "powertools_session_expired" {
                let doc = crate::powertools::read_power_tools_doc(&store, "u1").await.unwrap();
                assert!(doc.data["sessionExpiredAt"].is_string());
            }
        }
    }

    #[tokio::test]
    async fn apply_sort_needs_a_power_tools_session() {
        let store = MemoryFirestore::new();
        let client = crate::powertools::PowerToolsClient::new().with_base("http://127.0.0.1:9".into());
        let error = apply_pt_sort(&store, &client, "u1", &sort_request(&[], true, None)).await.unwrap_err();
        assert_eq!(error.code.as_deref(), Some("powertools_not_connected"));
    }

    // ------------------------------------------------------------ speed

    #[test]
    fn ttl_cache_expires_and_caps() {
        let cache: TtlCache<i32> = TtlCache::default();
        let t0 = Instant::now();
        cache.put("a", t0, 1);
        assert_eq!(cache.get("a", t0 + Duration::from_secs(59), ZERO_CACHE_TTL), Some(1));
        assert_eq!(cache.get("a", t0 + Duration::from_secs(61), ZERO_CACHE_TTL), None);
        // A refresh only reuses a read a few seconds old.
        assert_eq!(cache.get("a", t0 + Duration::from_secs(2), ZERO_REFRESH_REUSE), Some(1));
        assert_eq!(cache.get("a", t0 + Duration::from_secs(4), ZERO_REFRESH_REUSE), None);
        for i in 0..ZERO_CACHE_MAX + 10 {
            cache.put(&format!("k{i}"), t0 + Duration::from_millis(i as u64), 0);
        }
        assert_eq!(cache.len(), ZERO_CACHE_MAX);
        assert_eq!(cache.get("a", t0, ZERO_CACHE_TTL), None, "the oldest entry went first");
    }

    #[test]
    fn server_timing_names_each_step() {
        let mut timings = ZeroTimings::default();
        timings.add("ct_orders", 812.44);
        timings.add("total", 900.0);
        timings.ct_cached = true;
        assert_eq!(timings.header(), "ct_orders;dur=812.4, total;dur=900.0, ct_cache;desc=hit");
    }

    struct FakeRemotes {
        ct: crate::cardtrader::client::CardTraderClient,
        pt: crate::powertools::PowerToolsClient,
        ct_calls: Arc<Mutex<Vec<String>>>,
        pt_calls: Arc<Mutex<Vec<String>>>,
    }

    async fn fake_remotes() -> FakeRemotes {
        let ct_calls = Arc::new(Mutex::new(Vec::new()));
        let pt_calls = Arc::new(Mutex::new(Vec::new()));
        let seen = ct_calls.clone();
        let ct_app = axum::Router::new().route(
            "/orders",
            axum::routing::get(move |uri: axum::http::Uri| {
                let query = uri.query().unwrap_or_default().to_string();
                seen.lock().unwrap().push(query.clone());
                async move {
                    // A small delay so concurrent requests overlap.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    if query.contains("state=paid") {
                        axum::Json(json!([zero_order("700", "paid", vec![item("71", "101", 1, 100)])]))
                    } else {
                        axum::Json(json!([]))
                    }
                }
            }),
        );
        let seen = pt_calls.clone();
        let pt_app = axum::Router::new().fallback(move |uri: axum::http::Uri| {
            seen.lock().unwrap().push(uri.path().to_string());
            async move { axum::Json(json!([])) }
        });
        let mut bases = Vec::new();
        for app in [ct_app, pt_app] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            bases.push(format!("http://{}", listener.local_addr().unwrap()));
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        }
        FakeRemotes {
            ct: crate::cardtrader::client::CardTraderClient::with_base(bases[0].clone()),
            pt: crate::powertools::PowerToolsClient::new().with_base(bases[1].clone()),
            ct_calls,
            pt_calls,
        }
    }

    async fn connected_seller(uid: &str) -> MemoryFirestore {
        std::env::set_var("CARDTRADER_TOKEN_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        let firestore = MemoryFirestore::new();
        let info = json!({ "user": { "id": "5", "username": "sel" } });
        crate::cardtrader::integration::store_connected_integration(&firestore, uid, "e@x.y", "ct-token", &info).await.unwrap();
        crate::powertools::store_power_tools_session(&firestore, uid, "a.b.c", &json!({ "username": "pt-sel" })).await.unwrap();
        firestore
    }

    #[tokio::test]
    async fn deferred_power_tools_then_cached_reads() {
        let remotes = fake_remotes().await;
        let firestore = connected_seller("speed-u1").await;
        let db = crate::db::DbPools::disconnected();
        let run = |power_tools: bool| {
            zero_list(&remotes.ct, &firestore, &db, &remotes.pt, "speed-u1", ZeroOptions { power_tools, refresh: false })
        };

        let (first, timings) = run(false).await.unwrap();
        assert_eq!(first["powerTools"]["deferred"], true);
        assert_eq!(first["weekly"][0]["items"][0]["itemId"], "71");
        assert!(remotes.pt_calls.lock().unwrap().is_empty(), "powertools=0 makes no Power Tools call");
        let ct_queries = remotes.ct_calls.lock().unwrap().clone();
        assert_eq!(ct_queries.len(), 2);
        assert!(ct_queries.iter().all(|q| q.contains("&from=20")), "CardTrader paging is bounded by date: {ct_queries:?}");
        assert!(timings.header().contains("ct_orders;dur="));

        // The overlay request reuses the CardTrader orders.
        let (second, timings) = run(true).await.unwrap();
        assert!(timings.ct_cached);
        assert_eq!(remotes.ct_calls.lock().unwrap().len(), 2);
        assert_eq!(second["powerTools"]["ok"], true);
        let pt_after_second = remotes.pt_calls.lock().unwrap().len();
        assert_eq!(pt_after_second, 2, "user/order + picking lists");

        // And a third within the TTL reuses the Power Tools reads too.
        let (_, timings) = run(true).await.unwrap();
        assert!(timings.pt_cached);
        assert_eq!(remotes.pt_calls.lock().unwrap().len(), pt_after_second);
    }

    #[tokio::test]
    async fn concurrent_requests_share_one_fetch() {
        let remotes = fake_remotes().await;
        let firestore = connected_seller("speed-u2").await;
        let db = crate::db::DbPools::disconnected();
        let options = ZeroOptions { power_tools: false, refresh: false };
        let (a, b) = tokio::join!(
            zero_list(&remotes.ct, &firestore, &db, &remotes.pt, "speed-u2", options),
            zero_list(&remotes.ct, &firestore, &db, &remotes.pt, "speed-u2", options),
        );
        assert_eq!(a.unwrap().0["weekly"], b.unwrap().0["weekly"]);
        assert_eq!(remotes.ct_calls.lock().unwrap().len(), 2, "one paid + one hub_pending fetch for both requests");
    }
}
