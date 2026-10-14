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
//! Either way, linked rows stay in sync both ways (webhook + reconcile on a
//! CardTrader sale, `increment -n` on a Pokoin sale).
//!
//! Also here: the Power Tools CSV location import (`powerToolsCsv` on
//! `POST /api/cardtrader-sync`), ported from the Node `cardtrader-sync.js`.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::cardtrader::client::CardTraderClient;
use crate::cardtrader::integration::{integration_doc_id, COLLECTION};
use crate::cardtrader::push::{self, PushOutcome};
use crate::cardtrader::sync::upsert_product_link;
use crate::cardtrader::sync_core::{facet_key, facet_key_of_row, marketplace_game_for_product, public_card_id_from_blueprint, NormalizedProduct};
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
            .filter(|row| !row.name.is_empty())
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
    for game in games {
        if samples.len() >= 3 {
            break;
        }
        let rows = &import.by_game[game];
        let game_products = by_game_products.get(game.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        let paired = pt::reconcile_power_tools_with_cardtrader(game_products, rows.clone());
        for (product, row) in paired.matched.iter().take(3) {
            if samples.len() >= 3 {
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
        }
        for row in rows.iter().take(3usize.saturating_sub(samples.len())) {
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

/// Listings pushed per reconcile run unless `CARDTRADER_PUSH_BATCH` says otherwise.
pub const DEFAULT_PUSH_BATCH: i64 = 100;

pub fn push_batch() -> i64 {
    std::env::var("CARDTRADER_PUSH_BATCH")
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_PUSH_BATCH)
        .clamp(0, 500)
}

/// Active Pokémon listings with stock and no CardTrader product yet, never
/// CardTrader's own imports. Oldest change first, so a listing CardTrader
/// refused (released with a fresh `updated_at`) waits behind the others.
const PUSH_CANDIDATES_SQL: &str = r#"
      select to_jsonb(listing) as listing
      from public.marketplace_user_listings as listing
      where listing.seller_uid = $1
        and listing.status = 'active'
        and listing.quantity_available > 0
        and coalesce(listing.source_listing_id, '') = ''
        and coalesce(listing.source, '') <> $2
        and coalesce(nullif(listing.marketplace_game, ''), 'pokemon') = 'pokemon'
        and listing.card_id ~ '^[0-9]+$'
      order by listing.updated_at asc, listing.id
      limit $3
"#;

/// Same compare-and-set as the outbox push: only one writer moves a listing
/// from no source to `ct:pending:…`, so a listing is never created twice.
const CLAIM_SQL: &str = r#"
      update public.marketplace_user_listings
      set source_listing_id = $2, updated_at = now()
      where id = $1::uuid and coalesce(source_listing_id, '') = ''
      returning id
"#;

const RELEASE_SQL: &str = r#"
      update public.marketplace_user_listings
      set source_listing_id = '', updated_at = now()
      where id = $1::uuid and source_listing_id = $2
      returning id
"#;

const LINK_SQL: &str = r#"
      update public.marketplace_user_listings
      set source_listing_id = $2, updated_at = now()
      where id = $1::uuid and source_listing_id = $3
      returning id, status, quantity_available, card_id
"#;

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

/// Facet keys (card, condition, language, finishes) of every product in a
/// CardTrader export.
pub fn export_facets(products: &[NormalizedProduct]) -> HashSet<String> {
    products
        .iter()
        .filter_map(|product| {
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
        })
        .collect()
}

/// List up to `limit` Pokoin-only listings on CardTrader and link them. A
/// listing whose exact card is already in the CardTrader export
/// (`on_cardtrader`) is left alone: the plan links a twin only when it is the
/// single match, so pushing the others would sell that card twice there.
pub async fn push_unlisted(
    db: &DbPools,
    ct: &CardTraderClient,
    token: &str,
    seller_uid: &str,
    limit: i64,
    on_cardtrader: &HashSet<String>,
) -> Value {
    let mut out = json!({ "candidates": 0, "pushed": 0, "failed": 0, "inDoubt": 0, "skipped": 0, "alreadyOnCardTrader": 0, "errorItems": [] });
    if limit <= 0 {
        return out;
    }
    let rows = match db.write("pokemon", PUSH_CANDIDATES_SQL, &[json!(seller_uid), json!(IMPORT_SOURCE), json!(limit)]).await {
        Ok(rows) => rows,
        Err(error) if error.is_table_missing() => return out,
        Err(error) => {
            note_error(&mut out, json!({ "reason": error.message }));
            return out;
        }
    };
    out["candidates"] = json!(rows.len());
    for row in rows {
        let listing = row.get("listing").cloned().unwrap_or(Value::Null);
        let id = clean_text_value(listing.get("id").unwrap_or(&Value::Null), 80);
        if id.is_empty() {
            continue;
        }
        if on_cardtrader.contains(&facet_key_of_row(&listing)) {
            bump(&mut out, "alreadyOnCardTrader");
            continue;
        }
        let pending = pending_source(crate::time_util::now_ms());
        match db.write("pokemon", CLAIM_SQL, &[json!(id), json!(pending)]).await {
            Ok(claimed) if !claimed.is_empty() => {}
            Ok(_) => {
                bump(&mut out, "skipped");
                continue;
            }
            Err(error) => {
                bump(&mut out, "failed");
                note_error(&mut out, json!({ "listingId": id, "reason": error.message }));
                continue;
            }
        }
        match push::create_with_token(ct, token, &listing).await {
            PushOutcome::Created(pushed) => {
                let product_id = clean_text_value(pushed.get("productId").unwrap_or(&Value::Null), 80);
                let source = clean_text_value(pushed.get("sourceListingId").unwrap_or(&Value::Null), 160);
                let linked = db
                    .write("pokemon", LINK_SQL, &[json!(id), json!(source), json!(pending)])
                    .await
                    .ok()
                    .and_then(|rows| rows.into_iter().next());
                let Some(linked) = linked else {
                    // The claim is gone (listing deleted meanwhile): take the
                    // product back off CardTrader rather than leave it unlinked.
                    let _ = ct.destroy_product(token, &product_id).await;
                    bump(&mut out, "skipped");
                    continue;
                };
                let card_id = clean_text_value(linked.get("card_id").unwrap_or(&Value::Null), 80);
                let blueprint = push::blueprint(&card_id).map(|n| n.to_string()).unwrap_or_default();
                let quantity = linked.get("quantity_available").and_then(Value::as_i64).unwrap_or(0);
                let _ = upsert_product_link(db, seller_uid, &product_id, &id, &blueprint, quantity, "push", false).await;
                if push::off_sale(&clean_text_value(linked.get("status").unwrap_or(&Value::Null), 20)) {
                    // Went off sale while CardTrader created it.
                    let _ = ct.destroy_product(token, &product_id).await;
                }
                bump(&mut out, "pushed");
            }
            PushOutcome::Rejected(error) => {
                // Nothing was created: free the claim for a later run.
                let _ = db.write("pokemon", RELEASE_SQL, &[json!(id), json!(pending)]).await;
                bump(&mut out, "failed");
                note_error(&mut out, json!({
                    "listingId": id,
                    "cardId": clean_text_value(listing.get("card_id").unwrap_or(&Value::Null), 80),
                    "reason": error.message,
                }));
            }
            // The product may exist: keep the claim; the next reconcile links
            // it by `user_data_field` and nothing pushes it again.
            PushOutcome::InDoubt(_) => bump(&mut out, "inDoubt"),
        }
    }
    out
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
    fn export_facets_match_listing_rows() {
        let facets = export_facets(&[product("11", "Pikachu", "58/102")]);
        let card_id = public_card_id_from_blueprint("100").unwrap();
        assert!(facets.contains(&facet_key_of_row(&json!({"card_id": card_id, "condition": "NM", "language": "EN"}))));
        assert!(!facets.contains(&facet_key_of_row(&json!({"card_id": card_id, "condition": "LP", "language": "EN"}))));
        assert!(!facets.contains(&facet_key_of_row(&json!({"card_id": card_id, "condition": "NM", "language": "EN", "reverse": true}))));
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
    fn pending_source_is_never_a_product_id() {
        let source = pending_source(1_700_000_000_000);
        assert!(push::is_pending_source(&source));
        assert_eq!(crate::cardtrader::sync_core::parse_ct_product_id(&source), "");
    }
}
