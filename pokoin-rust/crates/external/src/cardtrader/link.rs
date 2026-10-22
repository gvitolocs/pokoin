//! The inventory link between a seller's CardTrader account and Pokoin.
//!
//! Connecting CardTrader links the two inventories; the seller picks which way
//! new stock is copied (`inventorySync.direction` on the integration doc):
//!
//! - `ct_to_pokoin` (default, the behavior before the setting existed): the
//!   reconcile imports CardTrader products into Pokoin and keeps them in sync.
//! - `pokoin_to_ct`: the reconcile lists the seller's Pokoin-only listings on
//!   CardTrader (a capped batch per run) and imports nothing.
//! - `both`: both of the above.
//!
//! Either way, linked rows stay in sync both ways on a sale (webhook +
//! reconcile on a CardTrader sale, `increment -n` on a Pokoin sale). A seller's
//! price or quantity edit on Pokoin reaches CardTrader in the push directions
//! only ([`edit_skip_reason`]; the outbox step is `listing_sync::edit_cardtrader`).
//!
//! Also here: the Power Tools CSV location import (`powerToolsCsv` on
//! `POST /api/cardtrader-sync`), ported from the Node `cardtrader-sync.js`.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::cardtrader::client::CardTraderClient;
use crate::cardtrader::group;
use crate::cardtrader::integration::{integration_doc_id, COLLECTION};
use crate::cardtrader::push::{self, PushOutcome};
use crate::cardtrader::sync::upsert_product_link;
use crate::cardtrader::sync_core::{ct_source_listing_id, facet_key, facet_key_of_row, marketplace_game_for_product, public_card_id_from_blueprint, NormalizedProduct};
use crate::db::DbPools;
use crate::error::{clean_text, clean_text_value, ApiError, ApiResult};
use crate::firebase::{FirestoreDoc, FirestoreStore};
use crate::powertools::{self as pt, PowerToolsRow};

/// Which way new stock is copied between CardTrader and Pokoin.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Direction {
    #[default]
    CtToPokoin,
    PokoinToCt,
    Both,
}

impl Direction {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "ct_to_pokoin" => Some(Self::CtToPokoin),
            "pokoin_to_ct" => Some(Self::PokoinToCt),
            "both" => Some(Self::Both),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::CtToPokoin => "ct_to_pokoin",
            Self::PokoinToCt => "pokoin_to_ct",
            Self::Both => "both",
        }
    }

    /// CardTrader products the seller has not on Pokoin are imported.
    pub fn imports(self) -> bool {
        matches!(self, Self::CtToPokoin | Self::Both)
    }

    /// Pokoin listings the seller has not on CardTrader are listed there.
    pub fn pushes(self) -> bool {
        matches!(self, Self::PokoinToCt | Self::Both)
    }
}

pub fn direction_from_data(data: &Value) -> Direction {
    data.pointer("/inventorySync/direction")
        .and_then(Value::as_str)
        .and_then(Direction::parse)
        .unwrap_or_default()
}

pub fn direction_from_doc(doc: &FirestoreDoc) -> Direction {
    if doc.exists { direction_from_data(&doc.data) } else { Direction::default() }
}

/// Why a seller's Pokoin edit of a linked listing is not sent to CardTrader;
/// `None` when it is: connected, not 1-Day Ready (CardTrader stocks those),
/// and the seller chose `pokoin_to_ct` or `both`. In `ct_to_pokoin`
/// CardTrader stays the source of truth and the reconcile copies its quantity
/// back onto the listing.
pub fn edit_skip_reason(doc: &FirestoreDoc) -> Option<&'static str> {
    if !doc.exists || doc.data.get("enabled") != Some(&Value::Bool(true)) {
        return Some("not_connected");
    }
    if crate::cardtrader::integration::is_one_day_ready_integration(doc) {
        return Some("one_day_ready");
    }
    if !direction_from_doc(doc).pushes() {
        return Some("ct_to_pokoin");
    }
    None
}

/// The stored direction; an unreadable doc is the default (import only), which
/// never writes to CardTrader.
pub async fn read_direction(firestore: &dyn FirestoreStore, uid: &str) -> Direction {
    match firestore.get_doc(COLLECTION, &integration_doc_id(uid)).await {
        Ok(doc) => direction_from_doc(&doc),
        Err(_) => Direction::default(),
    }
}

pub async fn store_direction(firestore: &dyn FirestoreStore, uid: &str, direction: Direction) -> ApiResult<()> {
    let now = crate::time_util::iso_from_ms(crate::time_util::now_ms());
    firestore
        .merge_doc(
            COLLECTION,
            &integration_doc_id(uid),
            json!({
                "inventorySync": { "direction": direction.as_str(), "updatedAt": now.clone() },
                "updatedAt": now,
            }),
        )
        .await
}

// ------------------------------------------------------- Power Tools import

/// Power Tools rows per marketplace game, locations already assigned.
pub type PowerToolsByGame = HashMap<String, Vec<PowerToolsRow>>;

const LOCATION_PARSES: [&str; 4] = ["as_is", "trailing_stack", "structured", "auto"];

/// Capacity used to read a CSV before the seller confirmed one: high enough
/// that no stack spills, so occupancy shows the real stack sizes.
const UNCONFIRMED_STACK_SIZE: i64 = 9999;

/// A parsed `powerToolsCsv` request body.
pub struct PowerToolsImport {
    pub by_game: PowerToolsByGame,
    pub overflows: Vec<Value>,
    pub occupancy: Vec<Value>,
    pub suggested_stack_size: i64,
    pub stack_size: i64,
    pub numbered_in_stack: bool,
    /// The mode the rows were read with (never `auto`).
    pub location_parse: String,
    pub location_detection: Value,
}

impl PowerToolsImport {
    pub fn total_rows(&self) -> usize {
        self.by_game.values().map(Vec::len).sum()
    }
}

/// `detectPowerToolsLocationStyle`: which location mode most rows look like.
pub fn detect_location_style(locations: &[String]) -> Value {
    let mut examples: Vec<String> = Vec::new();
    let (mut structured, mut trailing, mut as_is) = (0i64, 0i64, 0i64);
    for raw in locations {
        let text = clean_text(Some(raw), 120);
        if text.is_empty() {
            continue;
        }
        if examples.len() < 6 && !examples.contains(&text) {
            examples.push(text.clone());
        }
        if text.contains('·') || text.contains('•') || text.contains('#') {
            structured += 1;
            continue;
        }
        let digit_suffix = text
            .rfind([' ', '_'])
            .map(|i| {
                let tail = &text[i + 1..];
                !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit())
            })
            .unwrap_or(false);
        if digit_suffix {
            trailing += 1;
            continue;
        }
        as_is += 1;
    }
    let total = structured + trailing + as_is;
    let location_parse = if total > 0 && structured > 0 && structured >= trailing && structured >= as_is {
        "structured"
    } else if total > 0 && trailing > as_is {
        "trailing_stack"
    } else {
        "as_is"
    };
    json!({
        "locationParse": location_parse,
        "locationExamples": examples,
        "counts": { "structured": structured, "trailing": trailing, "asIs": as_is, "total": total },
    })
}

/// `parsePowerToolsByGame`: `powerToolsCsv` (`{ game: csvText }`) read with the
/// body's `stackSize` / `numberedInStack` / `locationParse`. `None` when the
/// body carries no CSV.
pub fn parse_power_tools_body(body: &Value) -> ApiResult<Option<PowerToolsImport>> {
    let Some(raw) = body.get("powerToolsCsv").or_else(|| body.get("powerToolsByGame")) else {
        return Ok(None);
    };
    let Some(raw) = raw.as_object() else {
        if raw.is_null() {
            return Ok(None);
        }
        return Err(ApiError::bad_request("powerToolsCsv must map each game to its CSV text.").with_code("powertools_csv"));
    };
    let requested = body.get("locationParse").and_then(Value::as_str).unwrap_or("auto");
    let requested = if LOCATION_PARSES.contains(&requested) { requested } else { "auto" };
    let stack_size = body.get("stackSize").and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0).map(|n| (n.trunc() as i64).clamp(1, 500)).unwrap_or(0);
    let numbered_in_stack = body.get("numberedInStack") == Some(&Value::Bool(true));

    // Rows per game first: the location style is detected across every file.
    let mut parsed: Vec<(String, Vec<PowerToolsRow>)> = Vec::new();
    let mut locations: Vec<String> = Vec::new();
    for (game, text) in raw {
        let text = text.as_str().unwrap_or_default();
        if text.trim().is_empty() {
            continue;
        }
        let game = clean_text(Some(game), 40).to_lowercase();
        if game.is_empty() {
            continue;
        }
        let (_, records) = pt::parse_csv(text);
        let rows: Vec<PowerToolsRow> = records
            .iter()
            .map(pt::power_tools_row)
            .filter(|row| !row.name.is_empty() && row.quantity > 0)
            .collect();
        locations.extend(rows.iter().map(|row| row.location.clone()));
        if !rows.is_empty() {
            parsed.push((game, rows));
        }
    }
    if parsed.is_empty() {
        return Ok(None);
    }
    let detection = detect_location_style(&locations);
    let location_parse = if requested == "auto" {
        detection["locationParse"].as_str().unwrap_or("as_is").to_string()
    } else {
        requested.to_string()
    };

    let capacity = if stack_size > 0 { stack_size } else { UNCONFIRMED_STACK_SIZE };
    let mut by_game = PowerToolsByGame::new();
    let mut overflows = Vec::new();
    let mut occupancy = Vec::new();
    let mut suggested = 1i64;
    for (game, rows) in parsed {
        let assigned = pt::assign_power_tools_locations(rows, capacity, numbered_in_stack, &location_parse);
        if stack_size > 0 {
            overflows.extend(assigned.overflows.into_iter().map(|row| with_game(row, &game)));
        }
        occupancy.extend(assigned.occupancy.into_iter().map(|row| with_game(row, &game)));
        suggested = suggested.max(assigned.suggested_stack_size);
        by_game.entry(game).or_default().extend(assigned.rows);
    }
    occupancy.sort_by(|a, b| {
        b["count"].as_i64().cmp(&a["count"].as_i64()).then_with(|| a["label"].as_str().unwrap_or("").cmp(b["label"].as_str().unwrap_or("")))
    });
    Ok(Some(PowerToolsImport {
        by_game,
        overflows,
        occupancy,
        suggested_stack_size: suggested.max(1),
        stack_size,
        numbered_in_stack,
        location_parse,
        location_detection: detection,
    }))
}

fn with_game(mut row: Value, game: &str) -> Value {
    row["game"] = json!(game);
    row
}

fn products_by_game(products: &[NormalizedProduct]) -> HashMap<&'static str, Vec<NormalizedProduct>> {
    let mut by_game: HashMap<&'static str, Vec<NormalizedProduct>> = HashMap::new();
    for product in products {
        let game = marketplace_game_for_product(product);
        if !game.is_empty() {
            by_game.entry(game).or_default().push(product.clone());
        }
    }
    by_game
}

/// `previewPowerToolsMatch`: what the import would do, without writing.
pub fn power_tools_preview(import: &PowerToolsImport, products: &[NormalizedProduct]) -> Value {
    let by_game_products = products_by_game(products);
    let mut games: Vec<&String> = import.by_game.keys().collect();
    games.sort();
    let mut samples: Vec<Value> = Vec::new();
    const MAX_SAMPLES: usize = 9;
    // One game keeps the old three examples; a mixed file shows each game.
    let per_game = if games.len() > 1 { 2 } else { 3 };
    for game in games {
        if samples.len() >= MAX_SAMPLES {
            break;
        }
        let rows = &import.by_game[game];
        let game_products = by_game_products.get(game.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        let paired = pt::reconcile_power_tools_with_cardtrader(game_products, rows.clone());
        let mut added = 0usize;
        for (product, row) in paired.matched.iter() {
            if samples.len() >= MAX_SAMPLES || added >= per_game {
                break;
            }
            samples.push(json!({
                "game": game,
                "name": if product.name.is_empty() { row.name.clone() } else { product.name.clone() },
                "condition": product.condition,
                "language": product.language,
                "reverse": product.reverse,
                "sourceLocation": row.source_location,
                "location": row.location,
                "matched": true,
            }));
            added += 1;
        }
        for row in rows.iter() {
            if samples.len() >= MAX_SAMPLES || added >= per_game {
                break;
            }
            samples.push(json!({
                "game": game,
                "name": row.name,
                "condition": row.condition,
                "language": row.language,
                "reverse": row.reverse,
                "sourceLocation": row.source_location,
                "location": row.location,
                "matched": false,
                "note": if game_products.is_empty() { "CardTrader export unavailable for match preview" } else { "No CardTrader twin yet" },
            }));
            added += 1;
        }
    }
    json!({
        "ok": true,
        "previewPowerTools": true,
        "stackSize": if import.stack_size > 0 { import.stack_size } else { import.suggested_stack_size },
        "numberedInStack": import.numbered_in_stack,
        "locationParse": import.location_parse,
        "totalPowerToolsRows": import.total_rows(),
        "samples": samples,
        "overflows": import.overflows,
        "occupancy": import.occupancy.iter().take(20).cloned().collect::<Vec<_>>(),
        "suggestedStackSize": import.suggested_stack_size,
        "locationDetection": import.location_detection,
        "locationExamples": import.location_detection["locationExamples"],
        "games": pt::games_from_cardtrader_products(products),
    })
}

fn ct_only_entry(game: &str, product: &NormalizedProduct) -> Value {
    json!({
        "game": game,
        "ctProductId": product.id,
        "cardId": public_card_id_from_blueprint(&product.blueprint_id).unwrap_or_default(),
        "name": product.name,
        "condition": product.condition,
        "language": product.language,
        "reverse": product.reverse,
        "quantity": product.quantity,
        "pricePkn": product.price_pkn,
    })
}

fn pt_only_entry(game: &str, row: &PowerToolsRow) -> Value {
    json!({
        "game": game,
        "name": row.name,
        "setName": row.set_name,
        "collectorNumber": row.collector_number,
        "condition": row.condition,
        "language": row.language,
        "reverse": row.reverse,
        "firstEdition": row.first_edition,
        "quantity": row.quantity,
        "location": row.location,
        "pricePkn": row.price_pkn.map(|p| p.trunc() as i64).unwrap_or(0),
    })
}

/// Review rows kept per side (the Sync review page reads them).
const REVIEW_CAP: usize = 500;

/// The Power Tools half of a reconcile: the `powerToolsReconcile` summary
/// (Sync review page) and the location for each matched CardTrader product.
pub fn power_tools_reconcile(products: &[NormalizedProduct], by_game: &PowerToolsByGame) -> (Value, Vec<(String, String)>) {
    let by_game_products = products_by_game(products);
    let mut locations: Vec<(String, String)> = Vec::new();
    let (mut matched, mut ct_only, mut pt_only, mut games) = (0i64, Vec::new(), Vec::new(), Vec::new());
    let mut product_games: Vec<&&str> = by_game_products.keys().collect();
    product_games.sort();
    for game in product_games {
        let game_products = &by_game_products[*game];
        let rows = by_game.get(*game).cloned().unwrap_or_default();
        if rows.is_empty() {
            ct_only.extend(game_products.iter().map(|product| ct_only_entry(game, product)));
            continue;
        }
        let paired = pt::reconcile_power_tools_with_cardtrader(game_products, rows.clone());
        games.push(json!({
            "id": game, "ct": game_products.len(), "pt": rows.len(),
            "matched": paired.matched.len(), "ctOnly": paired.ct_only.len(), "ptOnly": paired.pt_only.len(),
        }));
        for (product, row) in &paired.matched {
            matched += 1;
            if !row.location.is_empty() {
                locations.push((product.id.clone(), row.location.clone()));
            }
        }
        ct_only.extend(paired.ct_only.iter().map(|product| ct_only_entry(game, product)));
        pt_only.extend(paired.pt_only.iter().map(|row| pt_only_entry(game, row)));
    }
    let mut pt_games: Vec<&String> = by_game.keys().filter(|game| !by_game_products.contains_key(game.as_str())).collect();
    pt_games.sort();
    for game in pt_games {
        pt_only.extend(by_game[game].iter().map(|row| pt_only_entry(game, row)));
    }
    ct_only.truncate(REVIEW_CAP);
    pt_only.truncate(REVIEW_CAP);
    let summary = json!({
        "matched": matched,
        "locationsApplied": 0,
        "ctOnly": ct_only,
        "ptOnly": pt_only,
        "games": games,
    });
    (summary, locations)
}

const APPLY_LOCATIONS_SQL: &str = r#"
      update public.marketplace_user_listings as listing
      set location = located.location, updated_at = now()
      from unnest($2::text[], $3::text[]) as located(source_listing_id, location)
      where listing.seller_uid = $1
        and listing.source_listing_id = located.source_listing_id
        and listing.location is distinct from located.location
      returning listing.id
"#;

/// Write each matched product's Power Tools location onto its linked Pokoin
/// listing. Returns how many listings changed.
pub async fn apply_power_tools_locations(db: &DbPools, seller_uid: &str, locations: &[(String, String)]) -> ApiResult<i64> {
    if locations.is_empty() {
        return Ok(0);
    }
    let sources: Vec<Value> = locations.iter().map(|(id, _)| json!(crate::cardtrader::sync_core::ct_source_listing_id(id))).collect();
    let values: Vec<Value> = locations.iter().map(|(_, location)| json!(location)).collect();
    let rows = db
        .write("pokemon", APPLY_LOCATIONS_SQL, &[json!(seller_uid), Value::Array(sources), Value::Array(values)])
        .await?;
    Ok(rows.len() as i64)
}

// --------------------------------------------------- Pokoin → CardTrader push

/// Most listings one run lists on CardTrader (`CARDTRADER_PUSH_PER_RUN`).
pub const DEFAULT_PUSH_PER_RUN: i64 = 2000;
/// Seconds one run may spend creating products (`CARDTRADER_PUSH_SECONDS`):
/// with the export and plan it stays inside the 15-minute reconcile lock.
pub const DEFAULT_PUSH_SECONDS: i64 = 480;
/// Candidates read per query.
const PUSH_PAGE: i64 = 200;
/// At most five creates a second, well under CardTrader's request limits.
const PUSH_MIN_INTERVAL_MS: u64 = 200;

/// How much one run may push.
#[derive(Clone, Copy, Debug)]
pub struct PushBudget {
    pub per_run: i64,
    pub seconds: i64,
}

impl PushBudget {
    pub fn from_env() -> Self {
        let read = |key: &str, default: i64, max: i64| {
            std::env::var(key)
                .ok()
                .and_then(|raw| raw.trim().parse::<i64>().ok())
                .unwrap_or(default)
                .clamp(0, max)
        };
        Self {
            per_run: read("CARDTRADER_PUSH_PER_RUN", DEFAULT_PUSH_PER_RUN, 10_000),
            seconds: read("CARDTRADER_PUSH_SECONDS", DEFAULT_PUSH_SECONDS, 600),
        }
    }
}

/// Active listings of every CardTrader game with stock and no CardTrader
/// product yet, never CardTrader's own imports. "No CardTrader product" is any
/// source that is not `ct:…`: empty, or another channel's id such as a Scan
/// Connect item (`scan:<id>`), which Scan's own CardTrader push also replaces.
/// Until 2026-10-20 only Pokémon listings were candidates, so a Card Rails
/// Riftbound listing never reached CardTrader; the other games are created
/// from their blueprint's own properties (`push::product_body_for_blueprint`).
const PUSH_CANDIDATES_WHERE: &str = r#"
      from public.marketplace_user_listings as listing
      where listing.seller_uid = $1
        and listing.status = 'active'
        and listing.quantity_available > 0
        and coalesce(listing.source_listing_id, '') not like 'ct:%'
        and coalesce(listing.source, '') <> $2
        and listing.card_id ~ '^[0-9]+$'
"#;

/// `editable_properties` of these blueprints in a game's own database. The
/// schema name comes from the API's game table, never from a request.
fn blueprint_properties_sql(game: &str) -> Option<String> {
    let known = crate::db::INGEST_GAMES.iter().any(|(id, _, _)| *id == game);
    known.then(|| {
        format!(
            "select id::text as id, editable_properties from marketplace_{game}.cardtrader_blueprints \
             where id = any($1::bigint[])"
        )
    })
}

/// Blueprint id → `editable_properties` for the page's listings of games
/// other than Pokémon. A game whose database cannot be read leaves its
/// listings without properties: they are refused, never created wrongly.
async fn page_blueprint_properties(db: &DbPools, rows: &[Value]) -> HashMap<(String, i64), Vec<Value>> {
    let mut by_game: HashMap<String, Vec<i64>> = HashMap::new();
    for row in rows {
        let listing = row.get("listing").unwrap_or(&Value::Null);
        let game = push::listing_game(listing);
        if game == "pokemon" {
            continue;
        }
        let card = clean_text_value(listing.get("card_id").unwrap_or(&Value::Null), 80);
        if let Some(blueprint) = push::blueprint(&card) {
            by_game.entry(game).or_default().push(blueprint);
        }
    }
    let mut out = HashMap::new();
    for (game, mut ids) in by_game {
        ids.sort_unstable();
        ids.dedup();
        let Some(sql) = blueprint_properties_sql(&game) else { continue };
        match db.query(&game, &sql, &[json!(ids)]).await {
            Ok(found) => {
                for row in found {
                    let id = clean_text_value(row.get("id").unwrap_or(&Value::Null), 40).parse::<i64>().ok();
                    let properties = row.get("editable_properties").and_then(Value::as_array).cloned();
                    if let (Some(id), Some(properties)) = (id, properties) {
                        out.insert((game.clone(), id), properties);
                    }
                }
            }
            Err(error) => tracing::warn!(game, error = %error.message, "blueprint properties unavailable"),
        }
    }
    out
}

/// A page of candidates, never one this run already tried (`$4`): a listing
/// CardTrader refused goes back to its old source and must not come round
/// again in the same run.
fn push_candidates_sql() -> String {
    format!(
        "select to_jsonb(listing) as listing {PUSH_CANDIDATES_WHERE} and not (listing.id::text = any($4::text[])) order by listing.updated_at asc, listing.id limit $3"
    )
}

fn push_remaining_sql() -> String {
    format!("select count(*)::bigint as remaining {PUSH_CANDIDATES_WHERE}")
}

/// Unlisted candidates of one card (`$3`): a candidate's identical copies are
/// among them (cardtrader::group).
fn sibling_candidates_sql() -> String {
    format!("select to_jsonb(listing) as listing {PUSH_CANDIDATES_WHERE} and listing.card_id = $3 order by listing.created_at, listing.id")
}

/// The seller's listings on CardTrader by Pokoin (never CardTrader's own
/// imports), for the groups a new copy joins.
const LINKED_GROUPS_SQL: &str = r#"
      select to_jsonb(listing) as listing from public.marketplace_user_listings as listing
      where listing.seller_uid = $1
        and listing.source_listing_id ~ '^ct:[0-9]+$'
        and listing.status in ('active', 'paused')
        and coalesce(listing.source, '') <> $2
"#;

/// Every copy a group's claim holds moves to its product (`$3`).
const LINK_GROUP_SQL: &str = r#"
      update public.marketplace_user_listings
      set source_listing_id = $3, updated_at = now()
      where seller_uid = $1 and source_listing_id = $2
      returning id::text as id, status, quantity_available, card_id, price_pkn::float8 as price_pkn
"#;

/// Members that left the group while CardTrader answered: they are pushed
/// again into the group of what they are now.
const DETACH_SQL: &str = r#"
      update public.marketplace_user_listings
      set source_listing_id = '', updated_at = now()
      where seller_uid = $1 and source_listing_id = $2 and id::text = any($3::text[])
      returning id::text as id
"#;

fn row_id(row: &Value) -> String {
    clean_text_value(row.get("id").unwrap_or(&Value::Null), 80)
}

/// Group key → the CardTrader product its listed copies hold, for products
/// still in this export.
async fn existing_groups(db: &DbPools, seller_uid: &str, export: &[NormalizedProduct]) -> HashMap<String, String> {
    let exported: HashSet<&str> = export.iter().map(|product| product.id.as_str()).collect();
    let mut groups = HashMap::new();
    let Ok(rows) = db.write("pokemon", LINKED_GROUPS_SQL, &[json!(seller_uid), json!(IMPORT_SOURCE)]).await else {
        return groups;
    };
    for row in rows {
        let Some(listing) = row.get("listing") else { continue };
        let source = clean_text_value(listing.get("source_listing_id").unwrap_or(&Value::Null), 160);
        let product_id = crate::cardtrader::sync_core::parse_ct_product_id(&source);
        if !product_id.is_empty() && exported.contains(product_id.as_str()) {
            groups.entry(group::listing_group_key(listing)).or_insert(product_id);
        }
    }
    groups
}

/// After linking a group's claim: detach the copies that left it meanwhile and
/// bring the product's quantity to what its members hold (an increment; a
/// product left with no copy (`created` total known) is deleted).
#[allow(clippy::too_many_arguments)]
async fn settle_group(
    db: &DbPools,
    ct: &CardTraderClient,
    token: &str,
    seller_uid: &str,
    product_id: &str,
    sent: &[group::Sent],
    linked: &[Value],
    created: Option<i64>,
    out: &mut Value,
) {
    let (delta, detach) = group::settle_after_link(sent, linked);
    if !detach.is_empty() {
        let _ = db
            .write("pokemon", DETACH_SQL, &[json!(seller_uid), json!(ct_source_listing_id(product_id)), json!(detach)])
            .await;
        out["detachedAfterPush"] = json!(out["detachedAfterPush"].as_i64().unwrap_or(0) + detach.len() as i64);
    }
    if delta == 0 {
        return;
    }
    if created.is_some_and(|total| total + delta <= 0) {
        let _ = ct.destroy_product(token, product_id).await;
    } else if ct.increment_product(token, product_id, delta).await.is_ok() {
        bump(out, "quantityCaughtUp");
    }
}

/// Every CardTrader source a listing of the seller holds, any status.
const LINKED_SOURCES_SQL: &str = r#"
      select source_listing_id from public.marketplace_user_listings
      where seller_uid = $1 and source_listing_id like 'ct:%'
"#;

/// Same compare-and-set as the outbox push: only one writer moves a listing
/// from the source it was read with to `ct:pending:…`, so a listing is never
/// created twice.
const CLAIM_SQL: &str = r#"
      update public.marketplace_user_listings
      set source_listing_id = $2, updated_at = now()
      where id = $1::uuid and coalesce(source_listing_id, '') = $3
      returning id
"#;

/// Undo a claim: the listing gets back the source it had.
const RELEASE_SQL: &str = r#"
      update public.marketplace_user_listings
      set source_listing_id = $3, updated_at = now()
      where id = $1::uuid and source_listing_id = $2
      returning id
"#;

/// Link a listing to a product over the source it was read with (a claim, or
/// its old source when it takes over an unclaimed CardTrader twin).
const LINK_SQL: &str = r#"
      update public.marketplace_user_listings
      set source_listing_id = $2, updated_at = now()
      where id = $1::uuid and coalesce(source_listing_id, '') = $3
      returning id, status, quantity_available, card_id, price_pkn::float8 as price_pkn
"#;

/// An in-doubt create (no answer, a 5xx) keeps its `ct:pending:…` claim so
/// nothing creates it twice, and the reconcile links it by `user_data_field`
/// once CardTrader's export shows it. A create that never happened left the
/// listing pending for ever: never listed on CardTrader, never a candidate
/// again. A claim older than this when a complete export was taken, whose
/// listing no exported product names, is released: that export would show
/// the product if CardTrader had made it (specs/tla/listing-ct-sync).
pub const STALE_CLAIM_GRACE_SECS: i64 = 15 * 60;

/// Stale claims of one seller (`$2` the export's start on the writer clock,
/// `$3` the grace in seconds, `$4` listing ids the export names).
pub const STALE_CLAIMS_SQL: &str = r#"
      select id::text as id, source_listing_id from public.marketplace_user_listings
      where seller_uid = $1
        and source_listing_id like 'ct:pending:%'
        and updated_at < $2::timestamptz - make_interval(secs => $3::int)
        and not (id::text = any($4::text[]))
        and source_listing_id not in (
          select coalesce(named.source_listing_id, '') from public.marketplace_user_listings as named
          where named.seller_uid = $1 and named.id::text = any($4::text[])
        )
"#;

/// Release them, re-checked under the same conditions (`$5`: the ids).
pub const RELEASE_STALE_CLAIMS_SQL: &str = r#"
      update public.marketplace_user_listings
      set source_listing_id = '', updated_at = now()
      where seller_uid = $1
        and source_listing_id like 'ct:pending:%'
        and updated_at < $2::timestamptz - make_interval(secs => $3::int)
        and not (id::text = any($4::text[]))
        and source_listing_id not in (
          select coalesce(named.source_listing_id, '') from public.marketplace_user_listings as named
          where named.seller_uid = $1 and named.id::text = any($4::text[])
        )
        and id::text = any($5::text[])
      returning id::text as id
"#;

/// A stale claim a seller order names sold on CardTrader before any export
/// showed its product: settle it sold out (`ct:pending:` rows are CardTrader
/// mirrors to the audit trigger, so this is `cardtrader_synced`, never a
/// native sale), so it is neither left for sale on Pokoin nor created again.
pub const SETTLE_SOLD_CLAIMS_SQL: &str = r#"
      update public.marketplace_user_listings
      set quantity_available = 0, status = 'sold_out', updated_at = now()
      where seller_uid = $1
        and source_listing_id like 'ct:pending:%'
        and updated_at < $2::timestamptz - make_interval(secs => $3::int)
        and not (id::text = any($4::text[]))
        and source_listing_id not in (
          select coalesce(named.source_listing_id, '') from public.marketplace_user_listings as named
          where named.seller_uid = $1 and named.id::text = any($4::text[])
        )
        and id::text = any($5::text[])
        and status in ('active', 'paused')
      returning id::text as id
"#;

/// Days of seller orders read before releasing a claim: a product made by
/// an in-doubt create and sold before any export saw it is only in orders.
pub const STALE_CLAIM_ORDER_DAYS: i64 = 2;

/// Listing ids CardTrader seller orders name (`user_data_field`
/// `pokoin:<id>`, on the item or its product).
pub fn ordered_listing_ids(orders: &[Value]) -> HashSet<String> {
    orders
        .iter()
        .filter_map(|order| order.get("order_items").and_then(Value::as_array))
        .flatten()
        .map(|item| crate::cardtrader::sync_core::parse_pokoin_listing_id(&crate::cardtrader::webhook::item_user_data_field(item)))
        .filter(|id| !id.is_empty())
        .collect()
}

/// A group's copies share one claim and its product names only the primary
/// (cardtrader::group): an order naming one copy of a claim names them all.
pub fn claim_members(stale: &[(String, String)], ordered: &HashSet<String>) -> HashSet<String> {
    let sold: HashSet<&str> = stale.iter().filter(|(id, _)| ordered.contains(id)).map(|(_, claim)| claim.as_str()).collect();
    let mut out = ordered.clone();
    out.extend(stale.iter().filter(|(_, claim)| sold.contains(claim.as_str())).map(|(id, _)| id.clone()));
    out
}

/// Of the stale claims, the ones safe to release: none when the orders could
/// not be read, never one an order names (it sold on CardTrader).
pub fn releasable(stale: &[String], orders: Option<&HashSet<String>>) -> Vec<String> {
    match orders {
        None => Vec::new(),
        Some(ordered) => stale.iter().filter(|id| !ordered.contains(*id)).cloned().collect(),
    }
}

/// Of the stale claims, the ones an order names: sold on CardTrader.
pub fn sold_claims(stale: &[String], orders: Option<&HashSet<String>>) -> Vec<String> {
    match orders {
        None => Vec::new(),
        Some(ordered) => stale.iter().filter(|id| ordered.contains(*id)).cloned().collect(),
    }
}

/// Listing ids the export's products name in `user_data_field` (`pokoin:<id>`).
pub fn exported_listing_ids(export: &[NormalizedProduct]) -> Vec<String> {
    let mut ids: Vec<String> = export
        .iter()
        .map(|product| crate::cardtrader::sync_core::parse_pokoin_listing_id(&product.user_data_field))
        .filter(|id| !id.is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// `source_listing_id` while the reconcile's own push is in flight. Starts with
/// `ct:pending:` like the outbox's, so nothing treats it as a product id, and
/// an in-doubt create is linked later by its `user_data_field`.
pub fn pending_source(stamp: i64) -> String {
    format!("ct:pending:link-{stamp}")
}

/// The source CardTrader imports carry (`create_imported_listing`).
pub const IMPORT_SOURCE: &str = "cardtrader_seller_import";

fn note_error(out: &mut Value, item: Value) {
    if let Some(items) = out["errorItems"].as_array_mut() {
        if items.len() < 10 {
            items.push(item);
        }
    }
}

fn bump(out: &mut Value, key: &str) {
    out[key] = json!(out[key].as_i64().unwrap_or(0) + 1);
}

fn product_facet(product: &NormalizedProduct) -> Option<String> {
    let card_id = public_card_id_from_blueprint(&product.blueprint_id)?;
    Some(facet_key(
        &card_id,
        product.condition,
        product.language,
        product.reverse,
        product.first_edition,
        product.signed,
        product.altered,
        product.graded,
    ))
}

/// CardTrader products no Pokoin listing holds yet, by facet key (card,
/// condition, language, finishes). Such a product is a candidate's twin.
#[derive(Debug, Default)]
pub struct Twins {
    by_facet: HashMap<String, Vec<String>>,
}

impl Twins {
    pub fn new(products: &[NormalizedProduct], linked_sources: &HashSet<String>) -> Self {
        let mut by_facet: HashMap<String, Vec<String>> = HashMap::new();
        for product in products {
            if product.id.is_empty() || linked_sources.contains(&ct_source_listing_id(&product.id)) {
                continue;
            }
            if let Some(facet) = product_facet(product) {
                by_facet.entry(facet).or_default().push(product.id.clone());
            }
        }
        Self { by_facet }
    }

    /// Hand out each unclaimed twin once.
    fn take(&mut self, facet: &str) -> Option<String> {
        let ids = self.by_facet.get_mut(facet)?;
        if ids.is_empty() {
            None
        } else {
            Some(ids.remove(0))
        }
    }
}

/// What the push does with one candidate.
#[derive(Debug, PartialEq, Eq)]
pub enum PushStep {
    /// The same card is on CardTrader with no listing: link it, create nothing.
    Link(String),
    /// Create its own product. CardTrader takes several products of the same
    /// card from one seller (on 2026-10-14 one seller's 12,923 linked products
    /// covered 12,792 facets), so a second copy is a second product.
    Create,
}

pub fn push_step(twins: &mut Twins, listing: &Value) -> PushStep {
    match twins.take(&facet_key_of_row(listing)) {
        Some(product_id) => PushStep::Link(product_id),
        None => PushStep::Create,
    }
}

fn rate_limited(error: &ApiError) -> bool {
    error.code.as_deref() == Some(format!("{}429", crate::cardtrader::client::HTTP_ERROR_PREFIX).as_str())
}

/// List every Pokoin-only listing on CardTrader and link it, page after page,
/// until none is left or the run's budget (count, time, a CardTrader 429) is
/// spent; the next run carries on. Every candidate is linked, created, put
/// back with a fresh `updated_at`, or left in doubt under a pending source, so
/// none can hold up the queue.
pub async fn push_unlisted(
    db: &DbPools,
    ct: &CardTraderClient,
    token: &str,
    seller_uid: &str,
    budget: PushBudget,
    export: &[NormalizedProduct],
    export_started_at: Option<&str>,
    channel: crate::ct_fees::Channel,
) -> Value {
    let mut out = json!({
        "candidates": 0, "pushed": 0, "linkedToExisting": 0, "failed": 0, "inDoubt": 0,
        "skipped": 0, "remaining": 0, "releasedStaleClaims": 0, "stoppedBy": "done", "errorItems": [],
    });
    // Claims whose create never reached CardTrader become candidates again.
    // The caller passed the push gate: this export is complete.
    if let Some(started) = export_started_at {
        release_stale_claims(db, ct, token, seller_uid, started, export, &mut out).await;
    }
    if budget.per_run <= 0 {
        out["stoppedBy"] = json!("per_run_cap");
        return out;
    }
    let linked_sources: HashSet<String> = match db.write("pokemon", LINKED_SOURCES_SQL, &[json!(seller_uid)]).await {
        Ok(rows) => rows
            .iter()
            .map(|row| clean_text_value(row.get("source_listing_id").unwrap_or(&Value::Null), 160))
            .collect(),
        Err(error) if error.is_table_missing() => return out,
        Err(error) => {
            out["error"] = json!(error.message);
            note_error(&mut out, json!({ "reason": error.message }));
            return out;
        }
    };
    let mut twins = Twins::new(export, &linked_sources);
    let mut groups = existing_groups(db, seller_uid, export).await;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(budget.seconds.max(0) as u64);
    let mut attempted: Vec<String> = Vec::new();
    'pages: loop {
        let room = budget.per_run - attempted.len() as i64;
        if room <= 0 {
            out["stoppedBy"] = json!("per_run_cap");
            break;
        }
        let params = [json!(seller_uid), json!(IMPORT_SOURCE), json!(room.min(PUSH_PAGE)), json!(attempted)];
        let rows = match db.write("pokemon", &push_candidates_sql(), &params).await {
            Ok(rows) => rows,
            Err(error) if error.is_table_missing() => break,
            Err(error) => {
                // A database that cannot be read is a failed sync, never "nothing to list".
                out["error"] = json!(error.message);
                note_error(&mut out, json!({ "reason": error.message }));
                break;
            }
        };
        if rows.is_empty() {
            break;
        }
        let properties = page_blueprint_properties(db, &rows).await;
        for row in rows {
            if std::time::Instant::now() >= deadline {
                out["stoppedBy"] = json!("time_budget");
                break 'pages;
            }
            let mut listing = row.get("listing").cloned().unwrap_or(Value::Null);
            // The product is listed at the ask that nets the Pokoin price
            // after this seller's commission (push::ct_ask_eur).
            if listing.is_object() {
                listing["ctChannel"] = json!(channel.as_str());
            }
            let id = clean_text_value(listing.get("id").unwrap_or(&Value::Null), 80);
            if id.is_empty() {
                continue;
            }
            attempted.push(id.clone());
            bump(&mut out, "candidates");
            let read_source = clean_text_value(listing.get("source_listing_id").unwrap_or(&Value::Null), 160);
            if let PushStep::Link(product_id) = push_step(&mut twins, &listing) {
                let source = ct_source_listing_id(&product_id);
                match db.write("pokemon", LINK_SQL, &[json!(id), json!(source), json!(read_source)]).await {
                    Ok(rows) if !rows.is_empty() => {
                        let card_id = clean_text_value(listing.get("card_id").unwrap_or(&Value::Null), 80);
                        let blueprint = push::blueprint(&card_id).map(|n| n.to_string()).unwrap_or_default();
                        let quantity = listing.get("quantity_available").and_then(Value::as_i64).unwrap_or(0);
                        let _ = upsert_product_link(db, seller_uid, &product_id, &id, &blueprint, quantity, "match", false).await;
                        bump(&mut out, "linkedToExisting");
                    }
                    Ok(_) => bump(&mut out, "skipped"),
                    Err(error) => {
                        bump(&mut out, "failed");
                        out["error"] = json!(error.message);
                        note_error(&mut out, json!({ "listingId": id, "reason": error.message }));
                    }
                }
                continue;
            }
            // One CardTrader product for every identical copy (game, card,
            // condition, language, finishes, price): the candidate and its
            // unlisted twins on Pokoin, claimed together (cardtrader::group).
            let key = group::listing_group_key(&listing);
            let card_id = clean_text_value(listing.get("card_id").unwrap_or(&Value::Null), 80);
            let mut copies: Vec<Value> = match db.write("pokemon", &sibling_candidates_sql(), &[json!(seller_uid), json!(IMPORT_SOURCE), json!(card_id)]).await {
                Ok(rows) => rows
                    .into_iter()
                    .filter_map(|row| row.get("listing").cloned())
                    .filter(|copy| row_id(copy) != id && !attempted.contains(&row_id(copy)) && group::listing_group_key(copy) == key)
                    .collect(),
                Err(_) => Vec::new(),
            };
            copies.insert(0, listing.clone());
            let pending = pending_source(crate::time_util::now_ms());
            let mut sent: Vec<group::Sent> = Vec::new();
            let mut reads: Vec<(String, String)> = Vec::new();
            for copy in &copies {
                let copy_id = row_id(copy);
                if copy_id != id {
                    attempted.push(copy_id.clone());
                    bump(&mut out, "candidates");
                }
                let read = clean_text_value(copy.get("source_listing_id").unwrap_or(&Value::Null), 160);
                match db.write("pokemon", CLAIM_SQL, &[json!(copy_id), json!(pending), json!(read)]).await {
                    Ok(claimed) if !claimed.is_empty() => {
                        sent.push(group::Sent {
                            id: copy_id.clone(),
                            quantity: copy.get("quantity_available").and_then(Value::as_i64).unwrap_or(0).max(0),
                            price_pkn: copy.get("price_pkn").and_then(Value::as_f64).unwrap_or(0.0),
                        });
                        reads.push((copy_id, read));
                    }
                    Ok(_) => bump(&mut out, "skipped"),
                    Err(error) => {
                        bump(&mut out, "failed");
                        out["error"] = json!(error.message);
                        note_error(&mut out, json!({ "listingId": copy_id, "reason": error.message }));
                    }
                }
            }
            if sent.is_empty() {
                continue;
            }
            let total: i64 = sent.iter().map(|copy| copy.quantity).sum();
            let started = std::time::Instant::now();
            let release = |reads: Vec<(String, String)>, pending: String| async move {
                for (copy_id, read) in reads {
                    let _ = db.write("pokemon", RELEASE_SQL, &[json!(copy_id), json!(pending), json!(read)]).await;
                }
            };
            if let Some(product_id) = groups.get(&key).cloned() {
                // The group is on CardTrader already: add these copies to it.
                // An increment is never sent twice: one in doubt is taken as
                // applied (a lost increment under-lists, a repeated one would
                // over-list; D00008U).
                match ct.increment_product(token, &product_id, total).await {
                    Ok(_) => {}
                    Err(error) if crate::cardtrader::client::write_in_doubt(&error) => bump(&mut out, "inDoubt"),
                    Err(error) => {
                        release(reads, pending.clone()).await;
                        if rate_limited(&error) {
                            out["stoppedBy"] = json!("rate_limited");
                            break 'pages;
                        }
                        groups.remove(&key);
                        bump(&mut out, "failed");
                        note_error(&mut out, json!({ "listingId": id, "ctProductId": product_id, "reason": error.message }));
                        continue;
                    }
                }
                let linked = db
                    .write("pokemon", LINK_GROUP_SQL, &[json!(seller_uid), json!(pending), json!(ct_source_listing_id(&product_id))])
                    .await
                    .unwrap_or_default();
                settle_group(db, ct, token, seller_uid, &product_id, &sent, &linked, None, &mut out).await;
                out["joined"] = json!(out["joined"].as_i64().unwrap_or(0) + linked.len() as i64);
            } else {
                let primary = copies.iter().find(|copy| row_id(copy) == sent[0].id).cloned().unwrap_or_else(|| listing.clone());
                let mut body_listing = primary.clone();
                body_listing["ctChannel"] = json!(channel.as_str());
                body_listing["quantity_available"] = json!(total);
                let game = push::listing_game(&body_listing);
                let editable = push::blueprint(&card_id)
                    .and_then(|blueprint| properties.get(&(game, blueprint)))
                    .map(Vec::as_slice);
                match push::create_with_token_for(ct, token, &body_listing, editable).await {
                    PushOutcome::Created(pushed) => {
                        let product_id = clean_text_value(pushed.get("productId").unwrap_or(&Value::Null), 80);
                        let source = ct_source_listing_id(&product_id);
                        let linked = db
                            .write("pokemon", LINK_GROUP_SQL, &[json!(seller_uid), json!(pending), json!(source)])
                            .await
                            .unwrap_or_default();
                        if linked.is_empty() {
                            // Every claim is gone (deleted meanwhile): take the
                            // product back off CardTrader rather than leave it unlinked.
                            let _ = ct.destroy_product(token, &product_id).await;
                            bump(&mut out, "skipped");
                        } else {
                            let blueprint = push::blueprint(&card_id).map(|n| n.to_string()).unwrap_or_default();
                            let _ = upsert_product_link(db, seller_uid, &product_id, &sent[0].id, &blueprint, total, "push", false).await;
                            settle_group(db, ct, token, seller_uid, &product_id, &sent, &linked, Some(total), &mut out).await;
                            groups.insert(key.clone(), product_id.clone());
                            bump(&mut out, "pushed");
                            out["pushedCopies"] = json!(out["pushedCopies"].as_i64().unwrap_or(0) + linked.len() as i64);
                        }
                    }
                    PushOutcome::Rejected(error) => {
                        // Nothing was created: free the claims for a later run.
                        release(reads, pending.clone()).await;
                        if rate_limited(&error) {
                            out["stoppedBy"] = json!("rate_limited");
                            break 'pages;
                        }
                        bump(&mut out, "failed");
                        note_error(&mut out, json!({ "listingId": id, "cardId": card_id, "reason": error.message }));
                    }
                    // The product may exist: every copy keeps the shared claim; the
                    // next reconcile links them all by the primary's
                    // `user_data_field` and nothing pushes them again.
                    PushOutcome::InDoubt(_) => bump(&mut out, "inDoubt"),
                }
            }
            let spent = started.elapsed();
            let floor = std::time::Duration::from_millis(PUSH_MIN_INTERVAL_MS);
            if spent < floor {
                tokio::time::sleep(floor - spent).await;
            }
        }
    }
    // What the next runs still have to list.
    if let Ok(rows) = db.write("pokemon", &push_remaining_sql(), &[json!(seller_uid), json!(IMPORT_SOURCE)]).await {
        out["remaining"] = rows.first().and_then(|row| row.get("remaining")).cloned().unwrap_or(json!(0));
    }
    out
}

/// Free the claims of creates that never reached CardTrader (see
/// [`STALE_CLAIM_GRACE_SECS`]): only after a complete export, only claims
/// older than the export minus the grace that no exported product and no
/// recent seller order names. One orders read, and only when there is a
/// stale claim at all.
async fn release_stale_claims(
    db: &DbPools,
    ct: &CardTraderClient,
    token: &str,
    seller_uid: &str,
    started: &str,
    export: &[NormalizedProduct],
    out: &mut Value,
) {
    let named = exported_listing_ids(export);
    let base = [json!(seller_uid), json!(started), json!(STALE_CLAIM_GRACE_SECS), json!(named)];
    let stale: Vec<(String, String)> = match db.write("pokemon", STALE_CLAIMS_SQL, &base).await {
        Ok(rows) => rows
            .iter()
            .map(|row| {
                (
                    clean_text_value(row.get("id").unwrap_or(&Value::Null), 80),
                    clean_text_value(row.get("source_listing_id").unwrap_or(&Value::Null), 160),
                )
            })
            .collect(),
        Err(error) => {
            if !error.is_table_missing() {
                note_error(out, json!({ "reason": error.message }));
            }
            return;
        }
    };
    if stale.is_empty() {
        return;
    }
    let from = crate::time_util::utc_day_key_from_ms(crate::time_util::now_ms() - STALE_CLAIM_ORDER_DAYS * 86_400_000);
    let ordered = ct
        .fetch_seller_sale_orders(token, &from, 100, 5)
        .await
        .ok()
        .map(|orders| claim_members(&stale, &ordered_listing_ids(&orders)));
    let stale: Vec<String> = stale.into_iter().map(|(id, _)| id).collect();
    out["staleClaims"] = json!(stale.len());
    for (sql, ids, counter) in [
        (SETTLE_SOLD_CLAIMS_SQL, sold_claims(&stale, ordered.as_ref()), "staleClaimsSold"),
        (RELEASE_STALE_CLAIMS_SQL, releasable(&stale, ordered.as_ref()), "releasedStaleClaims"),
    ] {
        if ids.is_empty() {
            continue;
        }
        let mut params = base.to_vec();
        params.push(json!(ids));
        match db.write("pokemon", sql, &params).await {
            Ok(rows) => out[counter] = json!(rows.len()),
            Err(error) => note_error(out, json!({ "reason": error.message })),
        }
    }
}

/// Why the push pass must not run this time, if it must not. It writes to the
/// seller's CardTrader account, so it needs an export the plan trusted (its
/// facets are the duplicate check) and the shared reconcile lock (two runs
/// at once read exports that miss each other's creates).
pub fn push_gate(export_complete: bool, exclusive: bool) -> Option<&'static str> {
    if !export_complete {
        Some("incomplete_export")
    } else if !exclusive {
        Some("no_shared_lock")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firebase::MemoryFirestore;

    #[test]
    fn direction_parses_and_defaults_to_import() {
        assert_eq!(Direction::parse("pokoin_to_ct"), Some(Direction::PokoinToCt));
        assert_eq!(Direction::parse(" both "), Some(Direction::Both));
        assert_eq!(Direction::parse("sideways"), None);
        assert_eq!(direction_from_data(&json!({})), Direction::CtToPokoin);
        assert_eq!(direction_from_data(&json!({"inventorySync": {"direction": "both"}})), Direction::Both);
        assert!(Direction::CtToPokoin.imports() && !Direction::CtToPokoin.pushes());
        assert!(!Direction::PokoinToCt.imports() && Direction::PokoinToCt.pushes());
        assert!(Direction::Both.imports() && Direction::Both.pushes());
    }

    #[test]
    fn edits_reach_cardtrader_only_in_the_push_directions() {
        let doc = |data: Value| FirestoreDoc { exists: true, data };
        assert_eq!(edit_skip_reason(&FirestoreDoc { exists: false, data: json!({}) }), Some("not_connected"));
        assert_eq!(edit_skip_reason(&doc(json!({"enabled": false, "inventorySync": {"direction": "both"}}))), Some("not_connected"));
        assert_eq!(edit_skip_reason(&doc(json!({"enabled": true}))), Some("ct_to_pokoin"));
        assert_eq!(edit_skip_reason(&doc(json!({"enabled": true, "inventorySync": {"direction": "ct_to_pokoin"}}))), Some("ct_to_pokoin"));
        assert_eq!(edit_skip_reason(&doc(json!({"enabled": true, "inventorySync": {"direction": "pokoin_to_ct"}}))), None);
        assert_eq!(edit_skip_reason(&doc(json!({"enabled": true, "inventorySync": {"direction": "both"}}))), None);
        // A 1-Day Ready account never gets a write, whatever the doc says.
        let one_day = json!({"enabled": true, "metadata": {"oneDayReady": true}, "inventorySync": {"direction": "both"}});
        assert_eq!(edit_skip_reason(&doc(one_day)), Some("one_day_ready"));
    }

    #[tokio::test]
    async fn stored_direction_reads_back() {
        let firestore = MemoryFirestore::new();
        assert_eq!(read_direction(&firestore, "u1").await, Direction::CtToPokoin);
        store_direction(&firestore, "u1", Direction::PokoinToCt).await.unwrap();
        assert_eq!(read_direction(&firestore, "u1").await, Direction::PokoinToCt);
    }

    const CSV: &str = "name,set,cn,condition,language,quantity,price,location\n\
        Pikachu,Base Set,58/102,NM,English,1,2.50,Binder A 3\n\
        Charmander,Base Set,46/102,LP,English,2,1.00,Binder A 3\n\
        Squirtle,Base Set,63/102,NM,English,1,1.00,Binder B 1\n";

    #[test]
    fn power_tools_body_reads_rows_and_detects_trailing_stacks() {
        assert!(parse_power_tools_body(&json!({})).unwrap().is_none());
        assert!(parse_power_tools_body(&json!({"powerToolsCsv": "x"})).is_err());
        let import = parse_power_tools_body(&json!({"powerToolsCsv": {"pokemon": CSV}})).unwrap().unwrap();
        assert_eq!(import.total_rows(), 3);
        assert_eq!(import.location_parse, "trailing_stack");
        assert_eq!(import.suggested_stack_size, 2);
        assert!(import.overflows.is_empty(), "no capacity confirmed yet");
        let rows = &import.by_game["pokemon"];
        assert_eq!(rows[0].location, "Binder A·3");
        assert_eq!(rows[0].source_location, "Binder A 3");

        let confirmed = parse_power_tools_body(&json!({"powerToolsCsv": {"pokemon": CSV}, "stackSize": 1, "locationParse": "as_is"})).unwrap().unwrap();
        assert_eq!(confirmed.location_parse, "as_is");
        assert_eq!(confirmed.overflows.len(), 1);
        assert_eq!(confirmed.overflows[0]["game"], "pokemon");
    }

    #[test]
    fn power_tools_body_skips_zero_quantity_rows() {
        let csv = "name,set,cn,condition,language,quantity,price,location\n\
            Pikachu,Base Set,58/102,NM,English,0,2.50,Binder A\n\
            Charmander,Base Set,46/102,LP,English,2,1.00,Binder B\n";
        let import = parse_power_tools_body(&json!({"powerToolsCsv": {"pokemon": csv}})).unwrap().unwrap();
        assert_eq!(import.total_rows(), 1);
        assert_eq!(import.by_game["pokemon"][0].name, "Charmander");
    }

    fn product(id: &str, name: &str, collector: &str) -> NormalizedProduct {
        crate::cardtrader::sync_core::normalize_product(&json!({
            "id": id.parse::<i64>().unwrap(), "blueprint_id": 100, "game_id": 5, "quantity": 1,
            "name_en": name, "price_cents": 250,
            "properties_hash": { "condition": "Near Mint", "pokemon_language": "en", "collector_number": collector },
        }))
    }

    #[test]
    fn reconcile_matches_rows_to_products_and_reports_both_sides() {
        let import = parse_power_tools_body(&json!({"powerToolsCsv": {"pokemon": CSV}})).unwrap().unwrap();
        let products = vec![product("11", "Pikachu", "58/102"), product("12", "Mewtwo", "10/102")];
        let (summary, locations) = power_tools_reconcile(&products, &import.by_game);
        assert_eq!(summary["matched"], 1);
        assert_eq!(locations, vec![("11".to_string(), "Binder A·3".to_string())]);
        assert_eq!(summary["ctOnly"].as_array().unwrap().len(), 1);
        assert_eq!(summary["ctOnly"][0]["ctProductId"], "12");
        assert_eq!(summary["ptOnly"].as_array().unwrap().len(), 2);
        assert_eq!(summary["games"][0]["matched"], 1);
        let preview = power_tools_preview(&import, &products);
        assert_eq!(preview["ok"], true);
        assert_eq!(preview["totalPowerToolsRows"], 3);
        assert_eq!(preview["samples"].as_array().unwrap().len(), 3);
        assert_eq!(preview["locationExamples"][0], "Binder A 3");
    }

    #[test]
    fn a_second_copy_gets_its_own_product_and_a_twin_is_linked() {
        // CardTrader: 11 (Pikachu NM EN) is linked, 12 is the same card with no
        // listing, 13 is another card (blueprint 101) with no listing.
        let mewtwo = crate::cardtrader::sync_core::normalize_product(&json!({
            "id": 13, "blueprint_id": 101, "game_id": 5, "quantity": 1, "name_en": "Mewtwo", "price_cents": 250,
            "properties_hash": { "condition": "Near Mint", "pokemon_language": "en" },
        }));
        let products = vec![product("11", "Pikachu", "58/102"), product("12", "Pikachu", "58/102"), mewtwo];
        let linked: HashSet<String> = ["ct:11".to_string()].into_iter().collect();
        let mut twins = Twins::new(&products, &linked);
        let row = |blueprint: &str, condition: &str| {
            json!({"card_id": public_card_id_from_blueprint(blueprint).unwrap(), "condition": condition, "language": "EN"})
        };
        // The 2026-10-14 regression: 76 of 100 candidates matched a linked
        // product, were skipped, and stayed first in the queue every run.
        assert_eq!(push_step(&mut twins, &row("100", "NM")), PushStep::Link("12".into()), "an unclaimed twin is linked, not duplicated");
        assert_eq!(push_step(&mut twins, &row("100", "NM")), PushStep::Create, "a further copy gets its own product, never a skip");
        assert_eq!(push_step(&mut twins, &row("100", "LP")), PushStep::Create);
        assert_eq!(push_step(&mut twins, &row("101", "NM")), PushStep::Link("13".into()));
        assert_eq!(push_step(&mut twins, &row("101", "NM")), PushStep::Create, "each twin is handed out once");
    }

    #[test]
    fn location_style_detection() {
        let style = |rows: &[&str]| detect_location_style(&rows.iter().map(|s| s.to_string()).collect::<Vec<_>>())["locationParse"].clone();
        assert_eq!(style(&["A·1", "A·2"]), "structured");
        assert_eq!(style(&["Box 1", "Box 2", "Shelf"]), "trailing_stack");
        assert_eq!(style(&["Shelf", "Drawer"]), "as_is");
        assert_eq!(style(&[]), "as_is");
    }

    #[test]
    fn push_needs_a_trusted_export_and_the_shared_lock() {
        assert_eq!(push_gate(true, true), None);
        assert_eq!(push_gate(false, true), Some("incomplete_export"));
        assert_eq!(push_gate(true, false), Some("no_shared_lock"));
        assert_eq!(push_gate(false, false), Some("incomplete_export"));
        assert!(DEFAULT_PUSH_PER_RUN >= 1500, "a 1,463-listing shop fits in one run");
        assert!(DEFAULT_PUSH_SECONDS * 1000 / PUSH_MIN_INTERVAL_MS as i64 >= 2000, "the time budget allows the per-run cap");
    }

    #[test]
    fn push_candidates_include_other_channel_sources() {
        let sql = push_candidates_sql();
        assert!(sql.contains("not like 'ct:%'"), "scan:<id> and empty sources are candidates");
        assert!(sql.contains("limit $3"));
        assert!(sql.contains("any($4::text[])"), "rows this run tried never come round again");
        assert!(!push_remaining_sql().contains("limit"));
    }

    #[test]
    fn push_candidates_cover_every_game_and_properties_come_from_known_games() {
        let sql = push_candidates_sql();
        assert!(!sql.contains("= 'pokemon'"), "Riftbound, Magic, … listings are candidates too");
        assert_eq!(
            blueprint_properties_sql("riftbound").as_deref().map(|sql| sql.contains("marketplace_riftbound.cardtrader_blueprints")),
            Some(true)
        );
        assert!(blueprint_properties_sql("pokemon").is_none());
        assert!(blueprint_properties_sql("x; drop table y").is_none());
    }

    #[test]
    fn only_stale_unnamed_claims_are_released() {
        // Released only with order data, and never a listing an order names.
        let (a, b, c) = (
            "0a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
            "1b8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
            "2c8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
        );
        let stale = vec![a.to_string(), b.to_string()];
        assert!(releasable(&stale, None).is_empty(), "orders unreadable: release nothing");
        let orders = vec![json!({"id": 1, "order_items": [
            {"id": 7, "product_id": 99, "user_data_field": format!("pokoin:{a}")},
            {"id": 8, "product": {"id": 100, "user_data_field": format!("pokoin:{c}")}},
        ]})];
        let ordered = ordered_listing_ids(&orders);
        assert_eq!(releasable(&stale, Some(&ordered)), vec![b.to_string()]);
        assert_eq!(sold_claims(&stale, Some(&ordered)), vec![a.to_string()], "sold on CardTrader: settled, not relisted");
        assert!(sold_claims(&stale, None).is_empty());
        // A group's copies share the claim; the order names only the primary.
        let claims = [
            ("p".to_string(), "ct:pending:link-1".to_string()),
            ("q".to_string(), "ct:pending:link-1".to_string()),
            ("r".to_string(), "ct:pending:link-2".to_string()),
        ];
        let named_in_order: HashSet<String> = ["p".to_string()].into();
        let expanded = claim_members(&claims, &named_in_order);
        let ids: Vec<String> = claims.iter().map(|(id, _)| id.clone()).collect();
        assert_eq!(sold_claims(&ids, Some(&expanded)), vec!["p".to_string(), "q".to_string()]);
        assert_eq!(releasable(&ids, Some(&expanded)), vec!["r".to_string()]);
        assert!(STALE_CLAIMS_SQL.contains("coalesce(named.source_listing_id"), "a claim the export names through its primary is not stale");
        assert!(SETTLE_SOLD_CLAIMS_SQL.contains("status = 'sold_out'") && SETTLE_SOLD_CLAIMS_SQL.contains("like 'ct:pending:%'"));
        assert!(ordered.contains(c));
        // The slim sale order keeps the item's user_data_field.
        let slim = crate::cardtrader::sync_core::slim_sale_order(orders[0].clone());
        assert_eq!(ordered_listing_ids(&[slim]).len(), 2);
        assert!(STALE_CLAIMS_SQL.contains("like 'ct:pending:%'"));
        let sql = RELEASE_STALE_CLAIMS_SQL;
        assert!(sql.contains("id::text = any($5::text[])"));
        assert!(sql.contains("like 'ct:pending:%'"), "never a linked ct:<id> or another channel's source");
        assert!(sql.contains("updated_at < $2::timestamptz - make_interval"), "only claims older than the export minus the grace");
        assert!(sql.contains("not (id::text = any($4::text[]))"), "a listing the export names is linked, not released");
        assert!(STALE_CLAIM_GRACE_SECS >= 600, "longer than any CardTrader create can stay in flight");
        let product = |id: &str, udf: &str| crate::cardtrader::sync_core::normalize_product(&json!({
            "id": id, "blueprint_id": 400553, "quantity": 1, "user_data_field": udf,
            "properties_hash": {"condition": "Near Mint", "riftbound_language": "fr", "riftbound_foil": true}
        }));
        let export = [
            product("1", "pokoin:9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d"),
            product("2", ""),
            product("3", "pokoin:9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d"),
        ];
        assert_eq!(exported_listing_ids(&export), vec!["9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d".to_string()]);
        // Other games' facets are read from their own properties.
        assert_eq!((export[1].language, export[1].reverse), ("FR", true));
    }

    #[test]
    fn a_copy_that_changed_during_the_create_is_caught_up_or_pushed_again() {
        use crate::cardtrader::group::{settle_after_link, Sent};
        let sent = [
            Sent { id: "a".into(), quantity: 1, price_pkn: 26.0 },
            Sent { id: "b".into(), quantity: 1, price_pkn: 26.0 },
            Sent { id: "c".into(), quantity: 2, price_pkn: 26.0 },
            Sent { id: "d".into(), quantity: 1, price_pkn: 26.0 },
        ];
        let linked = [
            json!({"id": "a", "status": "active", "quantity_available": 1, "price_pkn": 26.0}),
            // Repriced while CardTrader created the product: it leaves the group.
            json!({"id": "b", "status": "active", "quantity_available": 1, "price_pkn": 40.0}),
            // One more copy scanned in.
            json!({"id": "c", "status": "active", "quantity_available": 3, "price_pkn": 26.0}),
            // "d" was deleted meanwhile.
        ];
        let (delta, detach) = settle_after_link(&sent, &linked);
        assert_eq!(delta, -1 - 1 + 1);
        assert_eq!(detach, vec!["b".to_string()]);
        assert!(LINK_GROUP_SQL.contains("source_listing_id = $2"));
        assert!(DETACH_SQL.contains("source_listing_id = $2") && DETACH_SQL.contains("set source_listing_id = ''"));
        assert!(sibling_candidates_sql().contains("listing.card_id = $3") && sibling_candidates_sql().contains("not like 'ct:%'"));
    }

    #[test]
    fn pending_source_is_never_a_product_id() {
        let source = pending_source(1_700_000_000_000);
        assert!(push::is_pending_source(&source));
        assert_eq!(crate::cardtrader::sync_core::parse_ct_product_id(&source), "");
    }
}
