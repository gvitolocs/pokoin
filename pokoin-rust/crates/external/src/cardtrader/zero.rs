//! CardTrader Zero picking list — native port of `_cardtrader_zero.js` and
//! `cardtrader-zero.js`. CardTrader Orders API is the source of truth; Power
//! Tools is an optional overlay; picking order is location box then stock
//! numbers ascending.

use serde_json::{json, Value};

use crate::cardtrader::sync_core::{ct_condition_to_pokoin, ct_language_to_pokoin};
use crate::error::{clean_text, clean_text_value, i64_field, truthy, ApiResult};

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

/// `zeroItemRow` — one CT order item as a picking-list line.
pub fn zero_item_row(order: &Value, item: &Value) -> Value {
    let props = props_of(item);
    let product_id = clean_text(
        item.get("product_id")
            .or_else(|| item.get("productId"))
            .or_else(|| item.pointer("/product/id"))
            .and_then(Value::as_str),
        80,
    );
    let blueprint_id = clean_text(
        item.get("blueprint_id")
            .or_else(|| item.get("blueprintId"))
            .and_then(Value::as_str),
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

/// `attachPokoinListings` — seller's own rows add location/card id.
pub fn attach_pokoin_listings(list: &mut Value, rows: &[Value]) -> Value {
    let mut by_product: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut by_id: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for row in rows {
        let source = clean_text_value(row.get("source_listing_id").unwrap_or(&Value::Null), 160).to_lowercase();
        let product = source
            .strip_prefix("ct:")
            .or_else(|| source.strip_prefix("cardtrader:"))
            .filter(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
            .map(str::to_string);
        if let Some(product) = product {
            by_product.insert(product, row.clone());
        }
        let id = clean_text_value(row.get("id").unwrap_or(&Value::Null), 80);
        if !id.is_empty() {
            by_id.insert(id, row.clone());
        }
    }
    for order_key in ["weekly"] {
        if let Some(orders) = list.get_mut(order_key).and_then(Value::as_array_mut) {
            for order in orders.iter_mut() {
                if let Some(items) = order.get_mut("items").and_then(Value::as_array_mut) {
                    for item in items.iter_mut() {
                        attach_row(item, &by_product, &by_id);
                    }
                }
            }
        }
    }
    if let Some(items) = list.pointer_mut("/pending/items").and_then(Value::as_array_mut) {
        for item in items.iter_mut() {
            attach_row(item, &by_product, &by_id);
        }
    }
    list.clone()
}

fn attach_row(item: &mut Value, by_product: &std::collections::HashMap<String, Value>, by_id: &std::collections::HashMap<String, Value>) {
    let product_id = clean_text_value(item.get("productId").unwrap_or(&Value::Null), 80);
    let listing_id = clean_text_value(item.get("listingId").unwrap_or(&Value::Null), 80);
    let row = by_product
        .get(&product_id)
        .cloned()
        .or_else(|| if listing_id.is_empty() { None } else { by_id.get(&listing_id).cloned() });
    let Some(row) = row else { return };
    item["listingId"] = json!(clean_text_value(row.get("id").unwrap_or(&Value::Null), 80));
    item["location"] = json!(clean_text_value(row.get("location").unwrap_or(&Value::Null), 64));
    let card_id = clean_text_value(row.get("card_id").unwrap_or(&Value::Null), 80);
    if !card_id.is_empty() {
        item["cardId"] = json!(card_id);
    }
    let collector = clean_text_value(item.get("collectorNumber").unwrap_or(&Value::Null), 40);
    if collector.is_empty() {
        let row_collector = clean_text_value(row.get("collector_number").unwrap_or(&Value::Null), 40);
        if !row_collector.is_empty() {
            item["collectorNumber"] = json!(row_collector);
        }
    }
    let image = clean_text_value(row.get("card_image_url").unwrap_or(&Value::Null), 800);
    if !image.is_empty() {
        item["imageUrl"] = json!(image);
    }
}

/// Power Tools location names as its UI shows them.
pub fn pt_display_location(name: &str) -> String {
    let value = clean_text(Some(name), 120);
    if value.is_empty() || value.to_lowercase().starts_with("unknown") {
        return String::new();
    }
    value
}

/// `attachPowerToolsOrders` — overlay PT order state on CT lines.
pub fn attach_power_tools_orders(list: &mut Value, pt_orders: &[Value]) -> (i64, i64, usize) {
    let mut orders: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for order in pt_orders {
        let source = clean_text(order.get("source").and_then(Value::as_str), 40).to_lowercase();
        if source != "cardtrader" {
            continue;
        }
        let id = clean_text(order.get("sourceOrderId").and_then(Value::as_str), 40);
        if !id.is_empty() {
            orders.insert(id, order.clone());
        }
    }
    let order_count = orders.len();
    let mut matched_orders = std::collections::HashSet::new();
    let mut matched_items = 0i64;
    let mut visit = |item: &mut Value| {
        let order_id = clean_text_value(item.get("orderId").unwrap_or(&Value::Null), 40);
        let hub = clean_text_value(item.get("hubPendingOrderId").unwrap_or(&Value::Null), 40);
        let order = orders
            .get(&order_id)
            .or_else(|| if hub.is_empty() { None } else { orders.get(&hub) })
            .cloned();
        let Some(order) = order else { return };
        let source_order_id = clean_text(order.get("sourceOrderId").and_then(Value::as_str), 40).to_string();
        if matched_orders.insert(source_order_id) {
            // counted below via len
        }
        let item_id = clean_text_value(item.get("itemId").unwrap_or(&Value::Null), 40);
        let product_id = clean_text_value(item.get("productId").unwrap_or(&Value::Null), 80);
        let articles = order.get("articles").and_then(Value::as_array).cloned().unwrap_or_default();
        let index = articles
            .iter()
            .position(|row| clean_text(row.get("sourceArticleId").and_then(Value::as_str), 40) == item_id)
            .or_else(|| {
                if product_id.is_empty() {
                    None
                } else {
                    articles
                        .iter()
                        .position(|row| clean_text(row.get("sourceArticleId").and_then(Value::as_str), 40) == product_id)
                }
            });
        let article = index.map(|i| &articles[i]);
        if article.is_some() {
            matched_items += 1;
        }
        let article_json = article.cloned().unwrap_or(Value::Null);
        item["powerTools"] = json!({
            "orderState": clean_text(
                order.pointer("/state/state").or_else(|| order.get("state")).and_then(Value::as_str),
                40,
            ),
            "isCtZeroClosing": order.get("isCtZeroClosing") == Some(&Value::Bool(true)),
            "articleState": clean_text(
                Some(
                    article_json
                        .get("articleState")
                        .or_else(|| article_json.pointer("/state/state"))
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ),
                40,
            ),
            "pickedQuantity": article
                .map(|a| json!(a.get("pickedQuantity").and_then(Value::as_f64).unwrap_or(0.0).max(0.0) as i64))
                .unwrap_or(Value::Null),
            "location": article
                .map(|a| json!(pt_display_location(&pt_location_name(a))))
                .unwrap_or(json!("")),
            "bin": clean_text(article_json.get("pickingId").and_then(Value::as_str), 40),
            "position": article
                .map(|a| json!(pt_article_position(a, index.unwrap_or(0))))
                .unwrap_or(Value::Null),
        });
    };
    if let Some(orders_value) = list.get_mut("weekly").and_then(Value::as_array_mut) {
        for order in orders_value.iter_mut() {
            if let Some(items) = order.get_mut("items").and_then(Value::as_array_mut) {
                for item in items.iter_mut() {
                    visit(item);
                }
            }
        }
    }
    if let Some(items) = list.pointer_mut("/pending/items").and_then(Value::as_array_mut) {
        for item in items.iter_mut() {
            visit(item);
        }
    }
    (matched_orders.len() as i64, matched_items, order_count)
}

fn pt_location_name(article: &Value) -> String {
    let info = clean_text(article.pointer("/locationInfo/name").and_then(Value::as_str), 120);
    if !info.is_empty() {
        return info;
    }
    article
        .get("locations")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|loc| {
                    let quantity = loc.get("quantity").and_then(Value::as_f64).unwrap_or(0.0);
                    let delta = loc.get("deltaQuantity").and_then(Value::as_f64).unwrap_or(0.0);
                    quantity > 0.0 || delta < 0.0
                })
                .map(|loc| clean_text(loc.get("name").and_then(Value::as_str), 120))
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn pt_article_position(article: &Value, index: usize) -> i64 {
    if let Some(pos) = article.get("pos").and_then(Value::as_f64) {
        if pos >= 0.0 {
            return pos as i64 + 1;
        }
    }
    for key in ["position", "pickingPosition", "sortIndex"] {
        if let Some(explicit) = article.get(key).and_then(Value::as_f64) {
            if explicit > 0.0 {
                return explicit as i64;
            }
        }
    }
    index as i64 + 1
}

/// Box name, then each stock number from smaller to bigger.
pub fn location_rank(value: &str) -> (String, Vec<i64>) {
    let raw = value.trim();
    let mut nums = Vec::new();
    let mut name = String::new();
    let mut current = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_digit() {
            current.push(ch);
            continue;
        }
        if !current.is_empty() {
            nums.push(current.parse::<i64>().unwrap_or(0));
            current.clear();
        }
        name.push(ch);
    }
    if !current.is_empty() {
        nums.push(current.parse::<i64>().unwrap_or(0));
    }
    let name: String = name
        .chars()
        .map(|c| if matches!(c, '·' | '.' | '•') { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    (name, nums)
}

pub fn compare_locations(a: &str, b: &str) -> std::cmp::Ordering {
    let (name_a, nums_a) = location_rank(a);
    let (name_b, nums_b) = location_rank(b);
    use std::cmp::Ordering;
    match name_a.cmp(&name_b) {
        Ordering::Equal => {}
        other => return other,
    }
    let len = nums_a.len().max(nums_b.len());
    for index in 0..len {
        let da = nums_a.get(index);
        let db = nums_b.get(index);
        match (da, db) {
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x != y => return x.cmp(y),
            _ => {}
        }
    }
    Ordering::Equal
}

fn pick_location(item: &Value) -> String {
    let direct = clean_text_value(item.get("location").unwrap_or(&Value::Null), 120);
    if !direct.is_empty() {
        return direct;
    }
    clean_text(Some(item.pointer("/powerTools/location").and_then(Value::as_str).unwrap_or_default()), 120)
}

/// Picking order: location box, then stock numbers, then set/number/name.
pub fn compare_picking_lines(a: &Value, b: &Value) -> std::cmp::Ordering {
    let la = pick_location(a);
    let lb = pick_location(b);
    use std::cmp::Ordering;
    let presence = match (la.is_empty(), lb.is_empty()) {
        (false, true) => return Ordering::Less,
        (true, false) => return Ordering::Greater,
        _ => Ordering::Equal,
    };
    let _ = presence;
    compare_locations(&la, &lb)
        .then_with(|| {
            let ea = clean_text_value(a.get("expansion").unwrap_or(&Value::Null), 160);
            let eb = clean_text_value(b.get("expansion").unwrap_or(&Value::Null), 160);
            ea.cmp(&eb)
        })
        .then_with(|| {
            let na = clean_text_value(a.get("collectorNumber").unwrap_or(&Value::Null), 40);
            let nb = clean_text_value(b.get("collectorNumber").unwrap_or(&Value::Null), 40);
            na.cmp(&nb)
        })
        .then_with(|| {
            let na = clean_text_value(a.get("name").unwrap_or(&Value::Null), 240);
            let nb = clean_text_value(b.get("name").unwrap_or(&Value::Null), 240);
            na.cmp(&nb)
        })
        .then_with(|| {
            let ia = clean_text_value(a.get("itemId").unwrap_or(&Value::Null), 40);
            let ib = clean_text_value(b.get("itemId").unwrap_or(&Value::Null), 40);
            ia.cmp(&ib)
        })
}

pub fn sort_for_picking(list: &mut Value) -> Value {
    if let Some(orders) = list.get_mut("weekly").and_then(Value::as_array_mut) {
        for order in orders.iter_mut() {
            if let Some(items) = order.get_mut("items").and_then(Value::as_array_mut) {
                items.sort_by(compare_picking_lines);
            }
        }
    }
    if let Some(items) = list.pointer_mut("/pending/items").and_then(Value::as_array_mut) {
        items.sort_by(compare_picking_lines);
    }
    list.clone()
}

/// Full zeroList composition used by the route.
pub async fn zero_list(
    ct: &crate::cardtrader::client::CardTraderClient,
    firestore: &dyn crate::firebase::FirestoreStore,
    db: &crate::db::DbPools,
    powertools: &crate::powertools::PowerToolsClient,
    uid: &str,
) -> ApiResult<Value> {
    // Zero orders are few; page far enough behind direct paid orders.
    let token = crate::cardtrader::integration::decrypt_integration_token(firestore, uid).await
        .map_err(|mut error| {
            if error.status == 404 {
                error.code = Some("cardtrader_not_connected".into());
            }
            error
        })?;
    let (weekly, pending) = tokio::join!(
        ct.fetch_seller_orders(&token, "", WEEKLY_STATE, 100, 10),
        ct.fetch_seller_orders(&token, "", PENDING_STATE, 100, 10),
    );
    let mut combined = weekly.unwrap_or_default();
    combined.extend(pending.unwrap_or_default());
    let mut list = build_zero_list(&combined);
    let source_ids = linked_source_ids(&list);
    let rows = if source_ids.is_empty() {
        Vec::new()
    } else {
        db.query(
            "pokemon",
            "select id, card_id, source_listing_id, location, collector_number, card_image_url \
             from public.marketplace_user_listings \
             where seller_uid = $1 and source_listing_id = any($2::text[])",
            &[json!(uid), json!(source_ids)],
        )
        .await
        .unwrap_or_default()
    };
    attach_pokoin_listings(&mut list, &rows);

    // Power Tools overlay; never fails the CardTrader list.
    let mut power_tools = json!({ "connected": false });
    let doc = crate::powertools::read_power_tools_doc(firestore, uid).await.unwrap_or_default();
    let status = crate::powertools::safe_power_tools_status(&doc);
    if status["connected"] == json!(true) {
        let username = status.pointer("/account/username").and_then(Value::as_str).unwrap_or_default().to_string();
        match crate::powertools::decrypt_power_tools_session(firestore, uid).await {
            Ok(jwt) if !jwt.is_empty() => match powertools.fetch_orders(&jwt).await {
                Ok(pt_orders) => {
                    let (matched_orders, matched_items, pt_order_count) =
                        attach_power_tools_orders(&mut list, &pt_orders);
                    power_tools = json!({
                        "connected": true,
                        "ok": true,
                        "username": username,
                        "matchedOrders": matched_orders,
                        "matchedItems": matched_items,
                        "ptOrderCount": pt_order_count,
                    });
                }
                Err(error) => {
                    if error.code.as_deref() == Some("powertools_session_expired") {
                        crate::powertools::mark_session_expired(firestore, uid).await;
                    }
                    power_tools = json!({
                        "connected": true,
                        "ok": false,
                        "username": username,
                        "code": error.code.unwrap_or_default(),
                        "error": error.message,
                    });
                }
            },
            _ => {
                power_tools = json!({ "connected": true, "ok": false, "username": username, "code": "", "error": "Power Tools orders failed." });
            }
        }
    }
    sort_for_picking(&mut list);
    let ct_doc = crate::cardtrader::integration::read_integration_doc(firestore, uid).await?;
    let ct_user = ct_doc.data.pointer("/metadata/user").cloned().unwrap_or(json!({}));
    Ok(json!({
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
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }

    #[test]
    fn item_row_shape() {
        let order = zero_order("9", "paid", vec![]);
        let row = zero_item_row(&order, &item("77", "555", 3, 120));
        assert_eq!(row["productId"], "555");
        assert_eq!(row["quantity"], 3);
        assert_eq!(row["unitCents"], 120);
        assert_eq!(row["lineCents"], 360);
        assert_eq!(row["currency"], "EUR");
        assert_eq!(row["condition"], "NM");
        assert_eq!(row["language"], "EN");
    }

    #[test]
    fn blank_language_stays_blank() {
        let order = json!({ "id": "9", "order_items": [] });
        let mut raw = item("1", "2", 1, 1);
        raw["properties"] = json!({});
        let row = zero_item_row(&order, &raw);
        assert_eq!(row["language"], "");
        assert_eq!(row["condition"], "");
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
    fn pokoin_rows_attach_location_and_card() {
        let orders = vec![zero_order("1", "paid", vec![item("11", "101", 1, 1)])];
        let mut list = build_zero_list(&orders);
        let rows = vec![json!({
            "id": "l1", "card_id": "202", "source_listing_id": "ct:101",
            "location": "BOX·7", "collector_number": "5/100", "card_image_url": "https://x/1.jpg",
        })];
        attach_pokoin_listings(&mut list, &rows);
        assert_eq!(list["weekly"][0]["items"][0]["listingId"], "l1");
        assert_eq!(list["weekly"][0]["items"][0]["location"], "BOX·7");
        assert_eq!(list["weekly"][0]["items"][0]["cardId"], "202");
        assert_eq!(list["weekly"][0]["items"][0]["collectorNumber"], "5/100");
    }

    #[test]
    fn picking_sort_box_then_numbers() {
        let mut list = build_zero_list(&[zero_order("1", "paid", vec![
            item("a", "1", 1, 1),
            item("b", "2", 1, 1),
            item("c", "3", 1, 1),
        ])]);
        let items = list["weekly"][0]["items"].as_array().unwrap().clone();
        let mut mutable: Vec<Value> = items.clone();
        {
            let slot = list["weekly"][0].get_mut("items").unwrap();
            let arr = slot.as_array_mut().unwrap();
            arr[0]["location"] = json!("box2·10");
            arr[1]["location"] = json!("box2·2");
            arr[2]["location"] = json!("box1·30");
        }
        mutable = list["weekly"][0]["items"].as_array().unwrap().clone();
        let _ = mutable;
        let sorted = sort_for_picking(&mut list);
        let locations: Vec<String> = sorted["weekly"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["location"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(locations, vec!["box1·30", "box2·2", "box2·10"]);
    }

    #[test]
    fn location_rank_extraction() {
        assert_eq!(location_rank("Box A 12 5"), ("box a".to_string(), vec![12, 5]));
        assert_eq!(location_rank("box2·10"), ("box".to_string(), vec![2, 10]));
    }

    #[test]
    fn pt_location_display_drops_unknown() {
        assert_eq!(pt_display_location("unknown*"), "");
        assert_eq!(pt_display_location("Bin 4"), "Bin 4");
        assert_eq!(pt_display_location(""), "");
    }

    use crate::error::ApiError as _ApiError;
    fn _assert_error_type(_: &_ApiError) {}
}
