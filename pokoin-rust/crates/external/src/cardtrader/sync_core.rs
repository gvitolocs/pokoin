//! Pure CardTrader ↔ Pokoin inventory sync rules — native port of
//! `_cardtrader_inventory_sync_core.js`. No I/O in this module so every
//! invariant is unit-testable. Invariant: CardTrader inventory ⊆ Pokoin
//! inventory for a connected seller; incomplete/failed exports never
//! destroy linked stock.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::error::{clean_text, clean_text_value, f64_field, i64_field, truthy, ValueExt};

pub const POKEMON_GAME_ID: i64 = 5;
pub const SOURCE_IMPORT: &str = "cardtrader_seller_import";
pub const CT_PREFIX: &str = "ct:";
pub const PKN_USDT_PRICE: f64 = 0.005;
/// Sale evidence window for products that left the export between reconciles.
pub const SALE_EVIDENCE_DAYS: i64 = 30;

pub fn marketplace_game_by_cardtrader_id(game_id: i64) -> &'static str {
    match game_id {
        1 => "magic",
        4 => "yugioh",
        5 => "pokemon",
        6 => "flesh_and_blood",
        8 => "digimon",
        9 => "dragon_ball_super",
        10 => "vanguard",
        15 => "one_piece",
        18 => "lorcana",
        20 => "star_wars",
        21 => "union_arena",
        22 => "riftbound",
        23 => "gundam",
        24 => "sorcery",
        26 => "palworld",
        27 => "cyberpunk",
        _ => "",
    }
}

pub fn ct_condition_to_pokoin(raw: &str) -> &'static str {
    match raw.trim().to_lowercase().as_str() {
        "mint" | "near mint" | "nm" => "NM",
        "slightly played" | "sp" | "lp" => "SP",
        "lightly played" | "moderately played" | "mp" => "MP",
        "played" | "heavily played" | "hp" | "pl" => "PL",
        "poor" | "po" => "Poor",
        _ => "NM",
    }
}

pub fn ct_language_to_pokoin(raw: &str) -> &'static str {
    match raw.trim().to_lowercase().as_str() {
        "en" => "EN",
        "it" => "IT",
        "de" => "DE",
        "fr" => "FR",
        "es" => "ES",
        "pt" => "PT",
        "jp" | "ja" => "JP",
        "kr" | "ko" => "KO",
        "zh" | "zh-cn" => "ZH",
        "zh-tw" | "zht" => "ZHT",
        "id" => "ID",
        "th" => "TH",
        "vi" => "VI",
        _ => "EN",
    }
}

pub fn empty_summary() -> Value {
    json!({
        "inventory": 0,
        "supportedInventory": 0,
        "pokemonInventory": 0,
        "alreadyLinked": 0,
        "matchedExisting": 0,
        "imported": 0,
        "updated": 0,
        "removed": 0,
        "unresolved": 0,
        "skippedNonPokemon": 0,
        "errors": 0,
        "unresolvedItems": [],
        "errorItems": [],
    })
}

fn properties_of(product: &Value) -> Value {
    product
        .get("properties_hash")
        .filter(|v| v.is_object())
        .or_else(|| product.get("properties").filter(|v| v.is_object()))
        .cloned()
        .unwrap_or(json!({}))
}

/// `eurPriceFromProduct` — EUR number, price_cents object (EUR first), cents.
pub fn eur_price_from_product(product: &Value) -> Option<f64> {
    if let Some(price) = f64_field(product, &["price"]) {
        return Some(price);
    }
    if let Some(cents) = product.get("price_cents") {
        if let Some(map) = cents.as_object() {
            let eur = map.get("EUR").or_else(|| map.get("eur"));
            if let Some(eur) = eur.and_then(Value::as_f64) {
                return Some(eur / 100.0);
            }
            let first = map.values().find_map(Value::as_f64);
            if let Some(first) = first {
                return Some(first / 100.0);
            }
        }
        if let Some(cents) = cents.as_f64() {
            return Some(cents / 100.0);
        }
    }
    None
}

pub fn pkn_from_product(product: &Value) -> Option<f64> {
    let eur = eur_price_from_product(product)?;
    if eur <= 0.0 {
        return None;
    }
    Some((eur / PKN_USDT_PRICE * 100.0).round() / 100.0)
}

/// CT blueprint id → Pokoin public card_id (ct_id × 2).
pub fn public_card_id_from_blueprint(blueprint_id: &str) -> Option<String> {
    let raw = clean_text(Some(blueprint_id), 80);
    if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let value: u128 = raw.parse().ok()?;
    if value == 0 || value > u64::MAX as u128 {
        return None;
    }
    Some((value * 2).to_string())
}

pub fn ct_source_listing_id(product_id: &str) -> String {
    let id = clean_text(Some(product_id), 80);
    if id.is_empty() { String::new() } else { format!("{CT_PREFIX}{id}") }
}

pub fn parse_ct_product_id(source_listing_id: &str) -> String {
    let raw = clean_text(Some(source_listing_id), 160).to_lowercase();
    for prefix in ["ct:", "cardtrader:"] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
                return rest.to_string();
            }
        }
    }
    String::new()
}

/// `pokoin:<uuid>` user_data_field → listing id.
pub fn parse_pokoin_listing_id(user_data_field: &str) -> String {
    let raw = clean_text(Some(user_data_field), 160);
    if let Some(rest) = raw.strip_prefix("pokoin:") {
        if rest.len() == 36 {
            let ok = rest
                .chars()
                .enumerate()
                .all(|(index, c)| {
                    if matches!(index, 8 | 13 | 18 | 23) {
                        c == '-'
                    } else {
                        c.is_ascii_hexdigit()
                    }
                });
            if ok {
                return rest.to_lowercase();
            }
        }
    }
    String::new()
}

/// The normalized product the reconcile works with (`normalizeProduct`).
#[derive(Clone, Debug)]
pub struct NormalizedProduct {
    pub id: String,
    pub blueprint_id: String,
    pub game_id: Option<i64>,
    pub quantity: i64,
    pub name: String,
    pub condition: &'static str,
    pub language: &'static str,
    pub reverse: bool,
    pub first_edition: bool,
    pub signed: bool,
    pub altered: bool,
    pub graded: bool,
    pub price_pkn: Option<f64>,
    pub user_data_field: String,
    pub description: String,
    pub raw: Value,
}

pub fn normalize_product(product: &Value) -> NormalizedProduct {
    let props = properties_of(product);
    // CardTrader sends ids as JSON numbers: Node read them with String(value).
    let id = crate::error::clean_text_value(product.get("id").unwrap_or(&Value::Null), 80);
    let blueprint_id = crate::error::clean_text_value(
        product.get("blueprint_id").or_else(|| product.get("blueprintId")).unwrap_or(&Value::Null),
        80,
    );
    let game_id = i64_field(product, &["game_id", "gameId"]);
    let quantity = i64_field(product, &["quantity", "qty"]).unwrap_or(0).max(0);
    let name = clean_text(
        product
            .get("name_en")
            .and_then(Value::as_str)
            .or_else(|| product.get("name").and_then(Value::as_str))
            .or_else(|| product.pointer("/blueprint/name").and_then(Value::as_str)),
        240,
    );
    let condition = ct_condition_to_pokoin(
        props.get("condition").and_then(Value::as_str).unwrap_or_default(),
    );
    let language_raw = props
        .get("pokemon_language")
        .or_else(|| props.get("mtg_language"))
        .or_else(|| props.get("language"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let language = ct_language_to_pokoin(language_raw);
    let reverse = props.get("pokemon_reverse").map(truthy).unwrap_or(false)
        || props.get("mtg_foil").map(truthy).unwrap_or(false)
        || props.get("foil").map(truthy).unwrap_or(false);
    let first_edition = props.get("pokemon_first_edition").map(truthy).unwrap_or(false)
        || props.get("first_edition").map(truthy).unwrap_or(false);
    let graded = product.get("graded").map(truthy).unwrap_or(false);
    NormalizedProduct {
        id,
        blueprint_id,
        game_id,
        quantity,
        name,
        condition,
        language,
        reverse,
        first_edition,
        signed: props.get("signed").map(truthy).unwrap_or(false),
        altered: props.get("altered").map(truthy).unwrap_or(false),
        graded,
        price_pkn: pkn_from_product(product),
        user_data_field: clean_text(
            product.get("user_data_field").or_else(|| product.get("userDataField")).and_then(Value::as_str),
            160,
        ),
        description: clean_text(product.get("description").and_then(Value::as_str), 500),
        raw: product.clone(),
    }
}

pub fn is_pokemon_product(product: &NormalizedProduct) -> bool {
    match product.game_id {
        None => {
            let props = properties_of(&product.raw);
            props.get("pokemon_language").is_some() || props.get("pokemon_reverse").is_some()
                || !product.blueprint_id.is_empty()
        }
        Some(id) => id == POKEMON_GAME_ID,
    }
}

pub fn marketplace_game_for_product(product: &NormalizedProduct) -> &'static str {
    match product.game_id {
        None => {
            if is_pokemon_product(product) {
                "pokemon"
            } else {
                ""
            }
        }
        Some(id) => marketplace_game_by_cardtrader_id(id),
    }
}

/// `facetKey` — card + condition + language + boolean facet columns.
pub fn facet_key(card_id: &str, condition: &str, language: &str, reverse: bool, first_edition: bool, signed: bool, altered: bool, graded: bool) -> String {
    [
        clean_text(Some(card_id), 80),
        if condition.trim().is_empty() { "NM".to_string() } else { clean_text(Some(condition), 20).to_uppercase() },
        if language.trim().is_empty() { "EN".to_string() } else { clean_text(Some(language), 10).to_uppercase() },
        (if reverse { "1" } else { "0" }).to_string(),
        (if first_edition { "1" } else { "0" }).to_string(),
        (if signed { "1" } else { "0" }).to_string(),
        (if altered { "1" } else { "0" }).to_string(),
        (if graded { "1" } else { "0" }).to_string(),
    ]
    .join("|")
}

pub fn is_ct_linked_source(source_listing_id: &str) -> bool {
    clean_text(Some(source_listing_id), 160).starts_with(CT_PREFIX)
}

/// One seller listing row as the planner sees it (a
/// `marketplace_user_listings` row in JS-object form).
#[derive(Clone, Debug, PartialEq)]
pub struct ListingRow {
    pub id: String,
    pub card_id: String,
    pub quantity_available: i64,
    pub status: String,
    pub source_listing_id: String,
}

pub fn listing_row(value: &Value) -> ListingRow {
    ListingRow {
        id: clean_text_value(value.get("id").unwrap_or(&Value::Null), 80),
        card_id: clean_text_value(value.get("card_id").unwrap_or(&Value::Null), 80),
        quantity_available: i64_field(value, &["quantity_available"]).unwrap_or(0),
        status: clean_text_value(value.get("status").unwrap_or(&Value::Null), 40),
        source_listing_id: clean_text_value(value.get("source_listing_id").unwrap_or(&Value::Null), 160),
    }
}

/// `destructiveReconcileGate`.
pub fn destructive_reconcile_gate(complete: bool, export_ok: bool, products_array: bool) -> (bool, &'static str) {
    if !export_ok {
        return (false, "export_failed");
    }
    if !complete {
        return (false, "incomplete_snapshot");
    }
    if !products_array {
        return (false, "invalid_products");
    }
    (true, "complete_ok")
}

/// How one CT product attaches given existing seller listings (`resolveProductAttachment`).
#[derive(Clone, Debug, PartialEq)]
pub enum Attachment {
    AlreadyLinked { listing: ListingRow },
    LinkExisting { listing: ListingRow, facet_key: Option<String> },
    Unresolved { reason: &'static str, candidates: usize },
    Import,
}

pub struct AttachmentIndex {
    pub by_source_id: HashMap<String, ListingRow>,
    pub by_listing_id: HashMap<String, ListingRow>,
    pub unlinked_by_facet: HashMap<String, Vec<ListingRow>>,
}

impl AttachmentIndex {
    pub fn build(listings: &[Value]) -> Self {
        let mut by_source_id = HashMap::new();
        let mut by_listing_id = HashMap::new();
        let mut unlinked_by_facet: HashMap<String, Vec<ListingRow>> = HashMap::new();
        for value in listings {
            let row = listing_row(value);
            by_listing_id.insert(row.id.clone(), row.clone());
            if is_ct_linked_source(&row.source_listing_id) {
                by_source_id.insert(row.source_listing_id.clone(), row);
            } else if row.status == "active" || row.status == "paused" || row.status.is_empty() {
                let facet = listing_facet(&row);
                unlinked_by_facet.entry(facet).or_default().push(row);
            }
        }
        Self { by_source_id, by_listing_id, unlinked_by_facet }
    }
}

fn listing_facet(row: &ListingRow) -> String {
    facet_key(&row.card_id, "", "", false, false, false, false, false)
}

fn row_bool(value: &Value, key: &str) -> bool {
    match value.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "t",
        _ => false,
    }
}

/// facet key computed from a full listing JS row (uses stored facet columns).
pub fn facet_key_of_row(row: &Value) -> String {
    facet_key(
        &clean_text_value(row.get("card_id").or_else(|| row.get("cardId")).unwrap_or(&Value::Null), 80),
        &clean_text_value(row.get("condition").unwrap_or(&Value::Null), 20),
        &clean_text_value(row.get("language").unwrap_or(&Value::Null), 10),
        row_bool(row, "reverse"),
        row_bool(row, "first_edition") || row_bool(row, "firstEdition"),
        row_bool(row, "signed"),
        row_bool(row, "altered"),
        row_bool(row, "graded"),
    )
}

pub fn resolve_product_attachment(product: &NormalizedProduct, index: &mut AttachmentIndex) -> Attachment {
    let source_id = ct_source_listing_id(&product.id);
    let card_id = public_card_id_from_blueprint(&product.blueprint_id);

    if let Some(listing) = index.by_source_id.get(&source_id).cloned() {
        return Attachment::AlreadyLinked { listing };
    }

    let pokoin_id = parse_pokoin_listing_id(&product.user_data_field);
    if !pokoin_id.is_empty() {
        if let Some(listing) = index.by_listing_id.get(&pokoin_id).cloned() {
            return Attachment::LinkExisting { listing, facet_key: None };
        }
    }

    if let Some(ref card_id) = card_id {
        let facet = facet_key(
            card_id,
            product.condition,
            product.language,
            product.reverse,
            product.first_edition,
            product.signed,
            product.altered,
            product.graded,
        );
        let candidates = index.unlinked_by_facet.get(&facet).cloned().unwrap_or_default();
        if candidates.len() == 1 {
            return Attachment::LinkExisting { listing: candidates[0].clone(), facet_key: Some(facet) };
        }
        if candidates.len() > 1 {
            return Attachment::Unresolved { reason: "ambiguous_facet_match", candidates: candidates.len() };
        }
    }

    if card_id.is_none() {
        return Attachment::Unresolved { reason: "unmapped_blueprint", candidates: 0 };
    }

    Attachment::Import
}

/// Planned action for one reconcile pass (`planInventoryReconcile`).
#[derive(Clone, Debug)]
pub enum PlannedAction {
    Noop { product_id: String, listing_id: String },
    UpdateQty { product_id: String, listing_id: String, quantity: i64 },
    Link { product_id: String, listing_id: String },
    Import { product_id: String, card_id: String, listing_id: String },
    Remove { product_id: String, listing_id: String, source_id: String },
    Unresolved { product_id: String, reason: &'static str },
}

pub struct ReconcilePlan {
    pub allow_destructive: bool,
    pub gate_reason: &'static str,
    pub summary: Value,
    pub actions: Vec<PlannedAction>,
    pub pokoin_only_ids: Vec<String>,
}

pub fn plan_inventory_reconcile(products: &[Value], listings: &[Value], export_complete: bool, export_ok: bool) -> ReconcilePlan {
    let (allow_destructive, gate_reason) = destructive_reconcile_gate(export_complete, export_ok, true);
    let mut summary = empty_summary();
    let mut set_count = |key: &str, value: i64| {
        summary[key] = json!(value);
    };
    set_count("inventory", products.len() as i64);

    let mut index = AttachmentIndex::build(listings);
    let mut pokoin_only_ids: HashSet<String> = HashSet::new();
    for value in listings {
        let row = listing_row(value);
        if !is_ct_linked_source(&row.source_listing_id) {
            pokoin_only_ids.insert(row.id);
        }
    }

    let mut actions = Vec::new();
    let mut seen_product_ids: HashSet<String> = HashSet::new();
    let normalized: Vec<NormalizedProduct> = products
        .iter()
        .map(normalize_product)
        .filter(|p| !p.id.is_empty())
        .collect();
    set_count("inventory", normalized.len() as i64);

    for product in &normalized {
        let game = marketplace_game_for_product(product);
        if game.is_empty() {
            summary["skippedNonPokemon"].incr(1);
            continue;
        }
        summary["supportedInventory"].incr(1);
        if game == "pokemon" {
            summary["pokemonInventory"].incr(1);
        }
        seen_product_ids.insert(product.id.clone());
        let source_id = ct_source_listing_id(&product.id);
        let decision = resolve_product_attachment(product, &mut index);
        match decision {
            Attachment::Unresolved { reason, candidates } => {
                summary["unresolved"].incr(1);
                let mut item = json!({ "ctProductId": product.id, "reason": reason });
                if candidates > 0 {
                    item["candidates"] = json!(candidates);
                }
                summary["unresolvedItems"].as_array_mut().unwrap().push(item);
                actions.push(PlannedAction::Unresolved { product_id: product.id.clone(), reason });
            }
            Attachment::AlreadyLinked { listing } => {
                summary["alreadyLinked"].incr(1);
                if listing.quantity_available != product.quantity {
                    summary["updated"].incr(1);
                    actions.push(PlannedAction::UpdateQty {
                        product_id: product.id.clone(),
                        listing_id: listing.id.clone(),
                        quantity: product.quantity,
                    });
                } else {
                    actions.push(PlannedAction::Noop { product_id: product.id.clone(), listing_id: listing.id.clone() });
                }
            }
            Attachment::LinkExisting { listing, facet_key } => {
                summary["matchedExisting"].incr(1);
                if let Some(facet) = facet_key {
                    index.unlinked_by_facet.insert(facet, Vec::new());
                }
                index.by_source_id.insert(source_id.clone(), listing.clone());
                pokoin_only_ids.remove(&listing.id);
                actions.push(PlannedAction::Link { product_id: product.id.clone(), listing_id: listing.id.clone() });
            }
            Attachment::Import => {
                summary["imported"].incr(1);
                let card_id = public_card_id_from_blueprint(&product.blueprint_id).unwrap_or_default();
                let synthetic = format!("import:{}", product.id);
                index.by_source_id.insert(
                    source_id.clone(),
                    ListingRow {
                        id: synthetic.clone(),
                        card_id: String::new(),
                        quantity_available: 0,
                        status: String::new(),
                        source_listing_id: source_id.clone(),
                    },
                );
                actions.push(PlannedAction::Import {
                    product_id: product.id.clone(),
                    card_id,
                    listing_id: synthetic,
                });
            }
        }
    }

    // Safety beyond Node: an export that is non-empty but yields no products
    // was not understood, so nothing may be removed because of it.
    let mut allow_destructive = allow_destructive;
    let mut gate_reason = gate_reason;
    if !products.is_empty() && normalized.is_empty() {
        allow_destructive = false;
        gate_reason = "unparsed_export";
    }
    if allow_destructive {
        let linked: Vec<(String, ListingRow)> = index
            .by_source_id
            .iter()
            .map(|(source_id, row)| (source_id.clone(), row.clone()))
            .collect();
        for (source_id, listing) in linked {
            let product_id = parse_ct_product_id(&source_id);
            if product_id.is_empty() || seen_product_ids.contains(&product_id) {
                continue;
            }
            if !is_ct_linked_source(if listing.source_listing_id.is_empty() { &source_id } else { &listing.source_listing_id }) {
                continue;
            }
            summary["removed"].incr(1);
            actions.push(PlannedAction::Remove {
                product_id,
                listing_id: listing.id.clone(),
                source_id,
            });
        }
    }

    // Safety beyond Node: one run never removes most of a seller's linked
    // listings. A real mass delisting needs a second look, not a timer.
    let removals = actions.iter().filter(|a| matches!(a, PlannedAction::Remove { .. })).count();
    let linked_total = index.by_source_id.len();
    if removals > MASS_REMOVAL_MIN && removals * 2 > linked_total {
        tracing::error!(removals, linked_total, "cardtrader reconcile mass removal blocked");
        actions.retain(|a| !matches!(a, PlannedAction::Remove { .. }));
        summary["removed"] = json!(0);
        summary["massRemovalBlocked"] = json!(removals);
        allow_destructive = false;
        gate_reason = "mass_removal_guard";
    }

    ReconcilePlan {
        allow_destructive,
        gate_reason,
        summary,
        actions,
        pokoin_only_ids: pokoin_only_ids.into_iter().collect(),
    }
}

/// Above this many removals in one run, removing more than half of a seller's
/// linked listings is refused (`mass_removal_guard`).
pub const MASS_REMOVAL_MIN: usize = 100;

/// Order states that are not a completed sale.
pub fn order_is_sale(order: &Value) -> bool {
    let state = clean_text(order.get("state").and_then(Value::as_str), 40).to_lowercase();
    !matches!(state.as_str(), "pending" | "canceled" | "cancelled" | "request_for_cancel_accepted")
}

/// productId → [{order, item}] for every real CardTrader seller sale.
pub fn sale_items_by_product(orders: &[Value]) -> HashMap<String, Vec<(Value, Value)>> {
    let mut by_product: HashMap<String, Vec<(Value, Value)>> = HashMap::new();
    for order in orders {
        if !order_is_sale(order) {
            continue;
        }
        for item in order.get("order_items").and_then(Value::as_array).unwrap_or(&Vec::new()) {
            let product_id = crate::error::clean_text_value(
                item.get("product_id")
                    .or_else(|| item.get("productId"))
                    .or_else(|| item.pointer("/product/id"))
                    .unwrap_or(&Value::Null),
                80,
            );
            if product_id.is_empty() {
                continue;
            }
            by_product.entry(product_id).or_default().push((order.clone(), item.clone()));
        }
    }
    by_product
}

/// `classifyVanishedProduct` — sold only with sale evidence after linking.
#[derive(Clone, Debug, PartialEq)]
pub enum VanishedVerdict {
    Sold { sales: Vec<(Value, Value)> },
    Delisted,
    Unknown,
}

pub fn classify_vanished_product(product_id: &str, listing_created_at: Option<i64>, sales: Option<&HashMap<String, Vec<(Value, Value)>>>) -> VanishedVerdict {
    let Some(sales) = sales else {
        return VanishedVerdict::Unknown;
    };
    let matches = sales
        .get(product_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, item)| match (listing_created_at, item.get("created_at").and_then(Value::as_str).and_then(crate::time_util::ms_from_iso)) {
            (Some(listed), Some(sold)) => sold >= listed,
            _ => true,
        })
        .collect::<Vec<_>>();
    if matches.is_empty() {
        VanishedVerdict::Delisted
    } else {
        VanishedVerdict::Sold { sales: matches }
    }
}

/// `oneDayReadyAssetRow`.
pub fn one_day_ready_asset_row(product: &NormalizedProduct, card_id: &str, meta: &Value) -> Value {
    let clean_meta = |key: &str| clean_text_value(meta.get(key).unwrap_or(&Value::Null), 240);
    json!({
        "ctProductId": product.id.clone(),
        "blueprintId": product.blueprint_id.clone(),
        "cardId": clean_text(Some(card_id), 80),
        "cardName": if product.name.is_empty() { clean_meta("card_name") } else { product.name.clone() },
        "setName": clean_text_value(meta.get("set_name").unwrap_or(&Value::Null), 240),
        "collectorNumber": clean_text_value(meta.get("collector_number").unwrap_or(&Value::Null), 80),
        "cardImageUrl": clean_text_value(meta.get("card_image_url").unwrap_or(&Value::Null), 800),
        "condition": product.condition,
        "language": product.language,
        "reverse": product.reverse,
        "firstEdition": product.first_edition,
        "signed": product.signed,
        "altered": product.altered,
        "graded": product.graded,
        "quantity": product.quantity.clamp(0, 999_999),
        "pricePkn": product.price_pkn.filter(|p| *p > 0.0).unwrap_or(0.0),
    })
}

/// `marketPricePkn` — only a real sold median is a price.
pub fn market_price_pkn(row: &Value) -> Option<f64> {
    let market = f64_field(row, &["market_pkn", "marketPkn"])?;
    if market <= 0.0 {
        return None;
    }
    Some((market * 100.0).round() / 100.0)
}

/// `oneDayReadyTotals`.
pub fn one_day_ready_totals(rows: &[Value]) -> Value {
    let mut products = 0i64;
    let mut cards = 0i64;
    let mut priced_cards = 0i64;
    let mut value_pkn = 0.0;
    for row in rows {
        let qty = i64_field(row, &["quantity"]).unwrap_or(0).max(0);
        if qty == 0 {
            continue;
        }
        products += 1;
        cards += qty;
        let price = f64_field(row, &["pricePkn", "price_pkn"]).unwrap_or(0.0).max(0.0);
        if price > 0.0 {
            priced_cards += qty;
        }
        value_pkn += qty as f64 * price;
    }
    json!({
        "products": products,
        "cards": cards,
        "pricedCards": priced_cards,
        "valuePkn": (value_pkn * 100.0).round() / 100.0,
    })
}

/// `quantityVisibleAfterSync` — CT quantity minus units an open checkout holds.
pub fn quantity_visible_after_sync(ct_quantity: i64, reserved_quantity: i64) -> i64 {
    (ct_quantity.clamp(0, 999_999) - reserved_quantity.max(0)).max(0)
}

/// `productLinkNeedsRefresh` — avoid rewriting links on safety syncs.
pub fn product_link_needs_refresh(link: Option<&Value>, listing_id: &str, blueprint_id: &str, quantity: i64, missing_from_ct: bool) -> bool {
    let Some(link) = link else { return true };
    let link_listing = clean_text_value(link.get("listing_id").unwrap_or(&Value::Null), 80);
    if link_listing != listing_id {
        return true;
    }
    let link_blueprint = clean_text_value(link.get("blueprint_id").unwrap_or(&Value::Null), 80);
    if link_blueprint != clean_text(Some(blueprint_id), 80) {
        return true;
    }
    let link_qty = i64_field(link, &["last_ct_quantity"]).unwrap_or(0);
    if link_qty != quantity {
        return true;
    }
    let link_missing = link.get("missing_from_ct").map(truthy).unwrap_or(false);
    link_missing != missing_from_ct
}

#[cfg(test)]
mod tests {
    use super::*;

    fn product(id: &str, blueprint: &str, qty: i64, price: f64) -> Value {
        json!({
            "id": id,
            "blueprint_id": blueprint,
            "game_id": 5,
            "quantity": qty,
            "price": price,
            "price_currency": "EUR",
            "properties": {"condition": "Near Mint", "pokemon_language": "en"},
        })
    }

    fn listing(id: &str, card_id: &str, qty: i64, source: &str, status: &str) -> Value {
        json!({
            "id": id, "card_id": card_id, "quantity_available": qty,
            "source_listing_id": source, "status": status,
            "condition": "NM", "language": "EN",
            "reverse": false, "first_edition": false, "signed": false, "altered": false, "graded": false,
        })
    }

    #[test]
    fn condition_and_language_maps() {
        assert_eq!(ct_condition_to_pokoin("Near Mint"), "NM");
        assert_eq!(ct_condition_to_pokoin("Slightly Played"), "SP");
        assert_eq!(ct_condition_to_pokoin("lightly played"), "MP");
        assert_eq!(ct_condition_to_pokoin("Heavily Played"), "PL");
        assert_eq!(ct_condition_to_pokoin("weird"), "NM");
        assert_eq!(ct_language_to_pokoin("jp"), "JP");
        assert_eq!(ct_language_to_pokoin("zh-tw"), "ZHT");
        assert_eq!(ct_language_to_pokoin(""), "EN");
    }

    #[test]
    fn card_id_math_is_blueprint_times_two() {
        assert_eq!(public_card_id_from_blueprint("1234").as_deref(), Some("2468"));
        assert_eq!(public_card_id_from_blueprint("0"), None);
        assert_eq!(public_card_id_from_blueprint("12a"), None);
        assert_eq!(public_card_id_from_blueprint(""), None);
        // u64::MAX blueprint stays in range for u128 math.
        assert!(public_card_id_from_blueprint(&u64::MAX.to_string()).is_some());
    }

    #[test]
    fn eur_price_variants() {
        assert_eq!(eur_price_from_product(&json!({"price": 3.5})), Some(3.5));
        assert_eq!(eur_price_from_product(&json!({"price_cents": {"EUR": 350}})), Some(3.5));
        assert_eq!(eur_price_from_product(&json!({"price_cents": {"USD": 200}})), Some(2.0));
        assert_eq!(eur_price_from_product(&json!({"price_cents": 199})), Some(1.99));
        assert_eq!(eur_price_from_product(&json!({})), None);
        assert_eq!(pkn_from_product(&json!({"price": 1.0})).map(|p| p as i64), Some(200));
        assert_eq!(pkn_from_product(&json!({"price": 0.0})), None);
    }

    #[test]
    fn source_id_parsing_round_trips() {
        assert_eq!(ct_source_listing_id("42"), "ct:42");
        assert_eq!(parse_ct_product_id("ct:42"), "42");
        assert_eq!(parse_ct_product_id("CARDTRADER:7"), "7");
        assert_eq!(parse_ct_product_id("scan:1"), "");
        assert_eq!(parse_pokoin_listing_id("pokoin:9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d"), "9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d");
        assert_eq!(parse_pokoin_listing_id("pokoin:short"), "");
    }

    #[test]
    fn gate_blocks_destructive_on_incomplete_or_failed_exports() {
        assert_eq!(destructive_reconcile_gate(true, true, true), (true, "complete_ok"));
        assert_eq!(destructive_reconcile_gate(false, true, true), (false, "incomplete_snapshot"));
        assert_eq!(destructive_reconcile_gate(true, false, true), (false, "export_failed"));
        assert_eq!(destructive_reconcile_gate(true, true, false), (false, "invalid_products"));
    }

    fn removes(plan: &ReconcilePlan) -> usize {
        plan.actions.iter().filter(|a| matches!(a, PlannedAction::Remove { .. })).count()
    }

    #[test]
    fn numeric_cardtrader_ids_keep_every_linked_listing() {
        // The real /products/export sends ids as JSON numbers (2026-10-09
        // incident: as_str() emptied them and 12,918 listings were removed).
        let products: Vec<Value> = (1..=150)
            .map(|i| json!({
                "id": i, "blueprint_id": 100 + i, "game_id": 5, "quantity": 1,
                "price": 2.0, "price_currency": "EUR",
                "properties": {"condition": "Near Mint", "pokemon_language": "en"},
            }))
            .collect();
        let first = normalize_product(&products[0]);
        assert_eq!((first.id.as_str(), first.blueprint_id.as_str()), ("1", "101"));
        let listings: Vec<Value> = (1..=150)
            .map(|i| listing(&format!("l{i}"), &((100 + i) * 2).to_string(), 1, &format!("ct:{i}"), "active"))
            .collect();
        let plan = plan_inventory_reconcile(&products, &listings, true, true);
        assert_eq!(removes(&plan), 0);
        assert_eq!(plan.gate_reason, "complete_ok");
    }

    #[test]
    fn unparsed_exports_and_mass_removals_never_remove() {
        let listings: Vec<Value> = (1..=150)
            .map(|i| listing(&format!("l{i}"), "200", 1, &format!("ct:{i}"), "active"))
            .collect();
        let garbage = vec![json!({"unexpected": true})];
        let plan = plan_inventory_reconcile(&garbage, &listings, true, true);
        assert_eq!((plan.gate_reason, plan.allow_destructive, removes(&plan)), ("unparsed_export", false, 0));

        let few: Vec<Value> = (1..=10).map(|i| product(&i.to_string(), "100", 1, 2.0)).collect();
        let plan = plan_inventory_reconcile(&few, &listings, true, true);
        assert_eq!((plan.gate_reason, plan.allow_destructive, removes(&plan)), ("mass_removal_guard", false, 0));
        assert_eq!(plan.summary["massRemovalBlocked"], json!(140));
    }

    #[test]
    fn plan_imports_updates_links_and_removes() {
        let products = vec![
            product("1", "100", 3, 2.0), // import: no listing matches
            product("2", "101", 5, 2.0), // already linked, qty changed 2 → 5
            product("3", "102", 7, 2.0), // facet-matches an unlinked pokoin listing
            product("4", "103", 1, 2.0), // matches nothing and blueprint unmapped? no — import
        ];
        let listings = vec![
            listing("l2", "202", 2, "ct:2", "active"),
            listing("l4", "208", 2, "ct:9", "active"), // linked but absent from export → removed
            listing("l3", "204", 7, "", "active"),      // unlinked, facet == card 204 NM EN
        ];
        let plan = plan_inventory_reconcile(&products, &listings, true, true);
        assert!(plan.allow_destructive);
        assert_eq!(plan.summary["imported"], 2);
        assert_eq!(plan.summary["alreadyLinked"], 1);
        assert_eq!(plan.summary["updated"], 1);
        assert_eq!(plan.summary["matchedExisting"], 1);
        assert_eq!(plan.summary["removed"], 1);
        assert!(plan.actions.iter().any(|a| matches!(a, PlannedAction::Remove { product_id, .. } if product_id == "9")));
        assert!(!plan.pokoin_only_ids.contains(&"l3".to_string()), "facet-matched listing leaves pokoin-only set");
    }

    #[test]
    fn plan_never_removes_without_complete_export() {
        let products = vec![product("1", "100", 3, 2.0)];
        let listings = vec![listing("l4", "208", 2, "ct:9", "active")];
        let plan = plan_inventory_reconcile(&products, &listings, false, true);
        assert!(!plan.allow_destructive);
        assert_eq!(plan.gate_reason, "incomplete_snapshot");
        assert!(!plan.actions.iter().any(|a| matches!(a, PlannedAction::Remove { .. })));
    }

    #[test]
    fn ambiguous_facet_match_stays_unresolved() {
        let products = vec![product("1", "100", 1, 2.0)];
        let listings = vec![
            listing("la", "200", 1, "", "active"),
            listing("lb", "200", 1, "", "active"),
        ];
        let plan = plan_inventory_reconcile(&products, &listings, true, true);
        assert_eq!(plan.summary["unresolved"], 1);
        let unresolved = plan
            .summary["unresolvedItems"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["ctProductId"] == "1")
            .unwrap()
            .clone();
        assert_eq!(unresolved["reason"], "ambiguous_facet_match");
    }

    #[test]
    fn non_supported_game_is_skipped() {
        let products = vec![product("1", "100", 1, 2.0)];
        let mut products = products;
        products[0]["game_id"] = json!(2); // unsupported game id
        let plan = plan_inventory_reconcile(&products, &[], true, true);
        assert_eq!(plan.summary["skippedNonPokemon"], 1);
        assert_eq!(plan.summary["supportedInventory"], 0);
    }

    #[test]
    fn vanished_classification_needs_sale_evidence() {
        let mut sales: HashMap<String, Vec<(Value, Value)>> = HashMap::new();
        sales.insert(
            "7".into(),
            vec![(json!({"id": 55, "state": "paid"}), json!({"product_id": "7", "quantity": 1, "created_at": "2026-10-01T00:00:00.000Z"}))],
        );
        // Sold: linked before the sale.
        assert!(matches!(
            classify_vanished_product("7", Some(crate::time_util::ms_from_iso("2026-09-01T00:00:00.000Z").unwrap()), Some(&sales)),
            VanishedVerdict::Sold { .. }
        ));
        // Delisted: sale happened before the listing existed.
        assert_eq!(
            classify_vanished_product("7", Some(crate::time_util::ms_from_iso("2026-10-05T00:00:00.000Z").unwrap()), Some(&sales)),
            VanishedVerdict::Delisted
        );
        // Unknown: no order data (API failure) — take it down, claim nothing.
        assert_eq!(classify_vanished_product("7", None, None), VanishedVerdict::Unknown);
        // No sale at all.
        assert_eq!(
            classify_vanished_product("8", None, Some(&HashMap::new())),
            VanishedVerdict::Delisted
        );
    }

    #[test]
    fn order_state_filtering() {
        assert!(order_is_sale(&json!({"state": "paid"})));
        assert!(!order_is_sale(&json!({"state": "pending"})));
        assert!(!order_is_sale(&json!({"state": "canceled"})));
        assert!(!order_is_sale(&json!({"state": "request_for_cancel_accepted"})));
        let orders = vec![json!({
            "state": "paid",
            "order_items": [{"product_id": "1", "quantity": 2}, {"product_id": "", "quantity": 1}]
        })];
        let sales = sale_items_by_product(&orders);
        assert_eq!(sales.len(), 1);
        assert_eq!(sales["1"].len(), 1);
    }

    #[test]
    fn one_day_ready_totals_skip_empty_stacks() {
        let rows = vec![
            json!({"quantity": 3, "pricePkn": 10.0}),
            json!({"quantity": 0, "pricePkn": 99.0}),
            json!({"quantity": 2, "pricePkn": 0.0}),
        ];
        let totals = one_day_ready_totals(&rows);
        assert_eq!(totals["products"], 2);
        assert_eq!(totals["cards"], 5);
        assert_eq!(totals["pricedCards"], 3);
        assert_eq!(totals["valuePkn"], 30.0);
    }

    #[test]
    fn quantity_visible_subtracts_holds() {
        assert_eq!(quantity_visible_after_sync(5, 2), 3);
        assert_eq!(quantity_visible_after_sync(1, 5), 0);
        assert_eq!(quantity_visible_after_sync(-3, 0), 0);
    }

    #[test]
    fn link_refresh_avoids_rewrite_noise() {
        let link = json!({"listing_id": "l1", "blueprint_id": "9", "last_ct_quantity": 4, "missing_from_ct": false});
        assert!(!product_link_needs_refresh(Some(&link), "l1", "9", 4, false));
        assert!(product_link_needs_refresh(Some(&link), "l1", "9", 5, false));
        assert!(product_link_needs_refresh(Some(&link), "l2", "9", 4, false));
        assert!(product_link_needs_refresh(None, "l1", "9", 4, false));
    }

    #[test]
    fn marketplace_game_mapping() {
        assert_eq!(marketplace_game_by_cardtrader_id(5), "pokemon");
        assert_eq!(marketplace_game_by_cardtrader_id(1), "magic");
        assert_eq!(marketplace_game_by_cardtrader_id(15), "one_piece");
        assert_eq!(marketplace_game_by_cardtrader_id(99), "");
    }
}
