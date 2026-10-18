//! Shared Firestore ownership for the Pokoin collection — a port of
//! `api/_user_card_collection.js`.
//!
//! This is the one place that decides what a user owns. It is public so the
//! scan/listing workers can reuse the same ownership writes instead of
//! duplicating them (the commerce worker already reads the same semantics for
//! paid sales).
//!
//! Invariants preserved from Node:
//! * Documents are deterministic for scan items: `scan:{scan_item_id}`.
//! * Scan ownership is `set`/merge with an **absolute** quantity, never
//!   `increment`, so a retry cannot double-count.
//! * An existing scan ownership doc keeps its quantity — sales and corrections
//!   may have changed it.
//! * NFT rows are never removed here and never decremented for a paid sale.
//! * A doc owned by someone else answers 404, so item ids never leak.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value as Json};

use crate::error::{ApiError, Result};
use crate::firestore::{DocData, Document, Firestore, Query, Value};

pub const COLLECTION: &str = "user_card_collections";
pub const SOURCE_SCAN: &str = "pokoin_scan_batch";
pub const SOURCE_IMPORT: &str = "pokoin_collection_import";

/// Live listing totals for one seller: row count, copies, and listed PKN.
pub const LIVE_LISTINGS_SQL: &str = "\
select count(*)::bigint as listings, \
       coalesce(sum(quantity_available), 0)::bigint as copies, \
       coalesce(floor(sum(price_pkn * quantity_available)), 0)::bigint as listed_pkn \
from public.marketplace_user_listings \
where seller_uid = $1 and status in ('active', 'paused') and quantity_available > 0";

/// Live listings whose id a collection doc names (`listingId` / `sourceListingId`).
pub const LIVE_LISTINGS_LINKED_SQL: &str = "\
select id::text as id, quantity_available::bigint as quantity \
from public.marketplace_user_listings \
where seller_uid = $1 and status in ('active', 'paused') and quantity_available > 0 \
  and id::text = any($2)";

/// `scanOwnershipDocId`: `{id}` or `scan:{id}`.
pub fn scan_ownership_doc_id(scan_item_id: &str) -> Result<String> {
    let id = scan_item_id.trim();
    if id.is_empty() {
        return Err(ApiError::internal("scan ownership requires a scan item id"));
    }
    Ok(if id.starts_with("scan:") {
        id.to_string()
    } else {
        format!("scan:{id}")
    })
}

/// `isNftRow`: any of the three NFT markers.
pub fn is_nft_row(fields: &Map<String, Json>) -> bool {
    let marker = |key: &str, expected: &str| {
        fields
            .get(key)
            .and_then(Json::as_str)
            .map(|value| value == expected)
            .unwrap_or(false)
    };
    marker("ownershipType", "nft")
        || marker("fulfillmentMode", "nft_only")
        || marker("nftStatus", "owned")
}

/// Firestore Timestamp | ISO string -> ISO string (or null), so clients can keep
/// sorting holdings by `updatedAt` / `createdAt`.
pub fn iso_timestamp(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Timestamp(timestamp) => {
            Some(timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        }
        Value::String(text) => chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|parsed| {
                parsed
                    .with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            }),
        Value::Integer(millis) => chrono::DateTime::from_timestamp_millis(*millis).map(|parsed| {
            parsed.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        }),
        Value::Double(millis) => {
            chrono::DateTime::from_timestamp_millis(*millis as i64).map(|parsed| {
                parsed.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
        }
        _ => None,
    }
}

/// `String(row.x || '')` over a **typed** Firestore document.
fn doc_string(document: &Document, key: &str) -> String {
    document.get_str(key)
}

fn doc_bool(document: &Document, key: &str) -> bool {
    document.get_bool(key).unwrap_or(false)
}

fn doc_number(document: &Document, key: &str) -> f64 {
    document
        .get(key)
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0)
}

fn doc_nullable(document: &Document, key: &str) -> Json {
    match document.get(key) {
        Some(Value::String(value)) => Json::String(value),
        Some(Value::Integer(value)) => Json::Number(value.into()),
        Some(Value::Double(value)) => serde_json::Number::from_f64(value)
            .map(Json::Number)
            .unwrap_or(Json::Null),
        _ => Json::Null,
    }
}

/// `isNftRow` over a typed Firestore document.
pub fn is_nft_document(document: &Document) -> bool {
    let marker = |key: &str, expected: &str| document.get_str(key) == expected;
    marker("ownershipType", "nft")
        || marker("fulfillmentMode", "nft_only")
        || marker("nftStatus", "owned")
}

/// `publicCollectionItem(doc)` — the exact public shape.
pub fn public_collection_item(id: &str, document: &Document) -> Json {
    let card_name = doc_string(document, "cardName");
    let card_name_source = if card_name.is_empty() {
        doc_string(document, "name")
    } else {
        card_name
    };
    let raw_card_id = doc_string(document, "cardId");
    let raw_blueprint_id = doc_string(document, "blueprintId");
    let card_id = if raw_card_id.is_empty() {
        raw_blueprint_id.clone()
    } else {
        raw_card_id
    };
    let blueprint_id = if raw_blueprint_id.is_empty() {
        doc_string(document, "cardId")
    } else {
        raw_blueprint_id
    };
    // Node emitted a JS number, so integral quantities must serialize as `3`,
    // not `3.0`.
    let quantity = doc_number(document, "quantity").max(0.0);
    let quantity_json = if quantity.fract() == 0.0 && quantity.abs() < 9.0e15 {
        json!(quantity as i64)
    } else {
        json!(quantity)
    };
    json!({
        "id": id,
        "uid": doc_string(document, "uid"),
        "cardId": card_id,
        "blueprintId": blueprint_id,
        "quantity": quantity_json,
        "condition": doc_string(document, "condition"),
        "language": doc_string(document, "language"),
        "firstEdition": doc_bool(document, "firstEdition"),
        "holo": doc_bool(document, "holo"),
        "reverse": doc_bool(document, "reverse"),
        "graded": doc_bool(document, "graded"),
        "gradingCompany": doc_nullable(document, "gradingCompany"),
        "grade": doc_nullable(document, "grade"),
        "certificationId": doc_nullable(document, "certificationId"),
        "cardName": card_name_source,
        "name": card_name_source,
        "cardImageUrl": doc_string(document, "cardImageUrl"),
        "setName": doc_string(document, "setName"),
        "collectorNumber": doc_string(document, "collectorNumber"),
        "ownershipType": doc_string(document, "ownershipType"),
        "nftStatus": doc_string(document, "nftStatus"),
        "fulfillmentMode": doc_string(document, "fulfillmentMode"),
        "physicalShippingStatus": doc_string(document, "physicalShippingStatus"),
        "physicalShippingRequestId": doc_string(document, "physicalShippingRequestId"),
        "source": doc_string(document, "source"),
        "sourceOrderId": doc_string(document, "sourceOrderId"),
        "sourceListingId": doc_string(document, "sourceListingId"),
        "listingId": doc_nullable(document, "listingId"),
        "forTrade": doc_bool(document, "forTrade"),
        "createdAt": document.get("createdAt").as_ref().and_then(iso_timestamp),
        "updatedAt": document.get("updatedAt").as_ref().and_then(iso_timestamp),
    })
}

/// One collection doc, kept so the summary can avoid counting a live listing twice.
#[derive(Debug, Clone)]
struct OwnedDoc {
    quantity: i64,
    nft: bool,
    listing_ids: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct OwnedCollection {
    pub uid: String,
    pub items: Vec<Json>,
    pub cards_owned: i64,
    pub item_count: i64,
    pub physical_items: i64,
    pub nft_items: i64,
    pub physical_owned: i64,
    pub nft_owned: i64,
    docs: Vec<OwnedDoc>,
}

/// Live `marketplace_user_listings` totals for the summary merge.
///
/// `linked` holds only live listings whose id a collection doc references,
/// mapped to that row's `quantity_available`.
#[derive(Debug, Clone, Default)]
pub struct LiveListings {
    pub listings: i64,
    pub copies: i64,
    pub listed_pkn: i64,
    pub linked: HashMap<String, i64>,
}

impl OwnedCollection {
    /// The `/api/marketplace-collection` body.
    pub fn to_json(&self) -> Json {
        json!({
            "uid": self.uid,
            "items": self.items,
            "cardsOwned": self.cards_owned,
            "itemCount": self.item_count,
            "physicalItems": self.physical_items,
            "nftItems": self.nft_items,
        })
    }

    /// The `?limit=N` body: the first `limit` items in collection order, with
    /// the whole collection's totals.
    pub fn first_page_json(&self, limit: usize) -> Json {
        json!({
            "uid": self.uid,
            "items": self.items.iter().take(limit).collect::<Vec<_>>(),
            "cardsOwned": self.cards_owned,
            "itemCount": self.item_count,
            "physicalItems": self.physical_items,
            "nftItems": self.nft_items,
            "limit": limit,
        })
    }

    /// Summary when live listings are unknown: the collection sum, plus
    /// `collectionOwned` and `"listed": null`.
    pub fn to_summary_json(&self) -> Json {
        self.summary_json(self.cards_owned, self.physical_owned, self.nft_owned, Json::Null)
    }

    /// Listing ids named on collection docs. Empty when the linked-id query can be skipped.
    pub fn referenced_listing_ids(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut ids = Vec::new();
        for doc in &self.docs {
            for id in &doc.listing_ids {
                if seen.insert(id.clone()) {
                    ids.push(id.clone());
                }
            }
        }
        ids
    }

    fn summary_json(&self, cards_owned: i64, physical_owned: i64, nft_owned: i64, listed: Json) -> Json {
        json!({
            "uid": self.uid,
            "cardsOwned": cards_owned,
            "items": self.item_count,
            "physicalItems": self.physical_items,
            "nftItems": self.nft_items,
            "physicalOwned": physical_owned,
            "nftOwned": nft_owned,
            "collectionOwned": self.cards_owned,
            "listed": listed,
        })
    }
}

/// `listingId` and `sourceListingId`, trimmed, with empties dropped.
fn linked_listing_ids(document: &Document) -> Vec<String> {
    let mut ids = Vec::new();
    for key in ["listingId", "sourceListingId"] {
        let id = doc_string(document, key).trim().to_string();
        if id.is_empty() || ids.iter().any(|existing| existing == &id) {
            continue;
        }
        ids.push(id);
    }
    ids
}

/// Summary body once live listings are known.
///
/// A collection doc is linked when `listingId` or `sourceListingId` is the
/// `id::text` of one of this seller's live listings. Linked copies are counted
/// through the listing; a listing named by several docs counts once.
pub fn merge_live_listings(collection: &OwnedCollection, live: &LiveListings) -> Json {
    let mut unlinked_physical = 0i64;
    let mut unlinked_nft = 0i64;
    let mut nft_listing_ids = HashSet::new();
    for doc in &collection.docs {
        let mut linked = false;
        for id in &doc.listing_ids {
            if !live.linked.contains_key(id) {
                continue;
            }
            linked = true;
            if doc.nft {
                nft_listing_ids.insert(id.clone());
            }
        }
        if linked {
            continue;
        }
        if doc.nft {
            unlinked_nft += doc.quantity;
        } else {
            unlinked_physical += doc.quantity;
        }
    }
    let nft_copies = nft_listing_ids
        .iter()
        .map(|id| live.linked.get(id).copied().unwrap_or(0))
        .sum::<i64>();
    let cards_owned = live.copies + unlinked_physical + unlinked_nft;
    let nft_owned = unlinked_nft + nft_copies;
    let physical_owned = unlinked_physical + live.copies - nft_copies;
    collection.summary_json(
        cards_owned,
        physical_owned,
        nft_owned,
        json!({
            "listings": live.listings,
            "copies": live.copies,
            "listedPkn": live.listed_pkn,
        }),
    )
}

/// Totals and per-listing quantities from `query_json`.
///
/// BIGINT comes back as a JSON number; NUMERIC text and integer strings are
/// accepted too. Fractional values floor.
pub fn live_listings_from_rows(totals: &[Json], linked_rows: &[Json]) -> LiveListings {
    let totals = totals.first();
    let mut linked = HashMap::new();
    for row in linked_rows {
        let id = json_id(row.get("id"));
        if id.is_empty() {
            continue;
        }
        linked.insert(id, json_i64(row.get("quantity")));
    }
    LiveListings {
        listings: json_i64(totals.and_then(|row| row.get("listings"))),
        copies: json_i64(totals.and_then(|row| row.get("copies"))),
        listed_pkn: json_i64(totals.and_then(|row| row.get("listed_pkn"))),
        linked,
    }
}

fn json_i64(value: Option<&Json>) -> i64 {
    let Some(value) = value else {
        return 0;
    };
    if let Some(number) = value.as_i64() {
        return number;
    }
    if let Some(number) = value.as_u64().and_then(|number| i64::try_from(number).ok()) {
        return number;
    }
    if let Some(number) = value.as_f64() {
        return floor_f64(number);
    }
    let Some(text) = value.as_str().map(str::trim).filter(|text| !text.is_empty()) else {
        return 0;
    };
    if let Ok(number) = text.parse::<i64>() {
        return number;
    }
    text.parse::<f64>().map(floor_f64).unwrap_or(0)
}

fn floor_f64(number: f64) -> i64 {
    if number.is_finite() {
        number.floor() as i64
    } else {
        0
    }
}

fn json_id(value: Option<&Json>) -> String {
    match value {
        Some(Json::String(text)) => text.trim().to_string(),
        Some(Json::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

/// `listOwnedCollection` — admin read, `uid` must come from a verified bearer.
pub async fn list_owned_collection(firestore: &Firestore, uid: &str) -> Result<OwnedCollection> {
    let owner = uid.trim();
    if owner.is_empty() {
        return Err(ApiError::unauthorized("Authentication required."));
    }

    let query = Query::collection(COLLECTION).where_eq("uid", owner.to_string());
    let documents = firestore.run_query(&query).await?;

    let mut result = OwnedCollection {
        uid: owner.to_string(),
        ..Default::default()
    };
    for document in documents {
        // Defense in depth: never return another owner's doc even if a query drifts.
        if document.get_str("uid") != owner {
            continue;
        }
        let item = public_collection_item(&document.id(), &document);
        let quantity = item
            .get("quantity")
            .and_then(Json::as_i64)
            .unwrap_or(0)
            .max(0);
        let nft = is_nft_document(&document);
        result.cards_owned += quantity;
        if nft {
            result.nft_items += 1;
            result.nft_owned += quantity;
        } else {
            result.physical_items += 1;
            result.physical_owned += quantity;
        }
        result.docs.push(OwnedDoc {
            quantity,
            nft,
            listing_ids: linked_listing_ids(&document),
        });
        result.items.push(item);
    }
    result.item_count = result.items.len() as i64;

    result.items.sort_by(|a, b| {
        let name = |item: &Json| {
            let card_name = item.get("cardName").and_then(Json::as_str).unwrap_or("");
            if card_name.is_empty() {
                item.get("cardId")
                    .and_then(Json::as_str)
                    .unwrap_or("")
                    .to_ascii_lowercase()
            } else {
                card_name.to_ascii_lowercase()
            }
        };
        let an = name(a);
        let bn = name(b);
        if an != bn {
            return an.cmp(&bn);
        }
        let id = |item: &Json| item.get("id").and_then(Json::as_str).unwrap_or("").to_string();
        id(a).cmp(&id(b))
    });

    Ok(result)
}

/// `summarizeOwnedCollection`.
pub async fn summarize_owned_collection(
    firestore: &Firestore,
    uid: &str,
) -> Result<OwnedCollection> {
    list_owned_collection(firestore, uid).await
}

/// `removeOwnedCollectionItem` — the collection red-cross. One copy by default;
/// the doc is deleted at zero quantity. NFT rows are refused.
pub async fn remove_owned_collection_item(
    firestore: &Firestore,
    uid: &str,
    item_id: &str,
    quantity: Option<f64>,
) -> Result<Json> {
    let owner = uid.trim();
    if owner.is_empty() {
        return Err(ApiError::unauthorized("Authentication required."));
    }
    let id = item_id.trim();
    if id.is_empty() {
        return Err(ApiError::bad_request("Collection item id is required."));
    }
    let remove = quantity
        .filter(|value| value.is_finite())
        .map(|value| value.floor() as i64)
        .unwrap_or(1)
        .max(1);

    let reference = firestore.doc(format!("{COLLECTION}/{id}"));
    let document = reference
        .get()
        .await?
        .ok_or_else(|| ApiError::not_found("Collection item not found."))?;
    if document.get_str("uid") != owner {
        // Not the owner: behave exactly like a missing document.
        return Err(ApiError::not_found("Collection item not found."));
    }
    if is_nft_document(&document) {
        return Err(ApiError::bad_request(
            "NFT holdings cannot be removed from the collection.",
        ));
    }

    let current = document
        .get("quantity")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0)
        .max(0.0) as i64;
    let next = (current - remove).max(0);
    if next <= 0 {
        reference.delete().await?;
        return Ok(json!({
            "ok": true,
            "deleted": true,
            "itemId": id,
            "before": current,
            "after": 0,
        }));
    }
    reference
        .set(
            DocData::new()
                .int("quantity", next)
                .server_timestamp("updatedAt"),
            true,
        )
        .await?;
    Ok(json!({
        "ok": true,
        "deleted": false,
        "itemId": id,
        "before": current,
        "after": next,
    }))
}

/// `setOwnedCollectionTrade`.
pub async fn set_owned_collection_trade(
    firestore: &Firestore,
    uid: &str,
    item_id: &str,
    for_trade: bool,
) -> Result<Json> {
    let owner = uid.trim();
    if owner.is_empty() {
        return Err(ApiError::unauthorized("Authentication required."));
    }
    let id = item_id.trim();
    if id.is_empty() {
        return Err(ApiError::bad_request("Collection item id is required."));
    }
    let reference = firestore.doc(format!("{COLLECTION}/{id}"));
    let document = reference.get().await?;
    let Some(document) = document else {
        return Err(ApiError::not_found("Collection item not found."));
    };
    if document.get_str("uid") != owner {
        return Err(ApiError::not_found("Collection item not found."));
    }
    if is_nft_document(&document) {
        return Err(ApiError::bad_request(
            "NFT holdings are not listed for trade.",
        ));
    }
    reference
        .set(
            DocData::new()
                .bool("forTrade", for_trade)
                .server_timestamp("updatedAt"),
            true,
        )
        .await?;
    Ok(json!({ "ok": true, "itemId": id, "forTrade": for_trade }))
}

/// `physicalPayloadFromScanRow` result: deterministic doc id + payload.
pub struct ScanOwnershipPayload {
    pub doc_id: String,
    pub data: DocData,
    pub quantity: i64,
}

/// `physicalPayloadFromScanRow` — absolute quantity, `sourceListingId = docId`.
pub fn physical_payload_from_scan_row(
    uid: &str,
    row: &Map<String, Json>,
    batch_id: &str,
    listing_id: Option<&str>,
    existing: bool,
) -> Result<ScanOwnershipPayload> {
    let row_id = raw_string(row, "id");
    let doc_id = scan_ownership_doc_id(&row_id)?;
    let foil_state = raw_string(row, "foil_state").to_ascii_lowercase();
    let holo = foil_state == "holo";
    let reverse = foil_state == "reverse"
        || row.get("reverse").and_then(Json::as_bool).unwrap_or(false);

    let quantity = raw_number(row, "quantity").max(1.0) as i64;
    let mut data = DocData::new()
        .string("uid", uid.to_string())
        .string("cardId", raw_string(row, "card_id"))
        .string("blueprintId", raw_string(row, "card_id"))
        .int("quantity", quantity)
        .string(
            "condition",
            non_empty(&raw_string(row, "condition"), "NM"),
        )
        .string("language", non_empty(&raw_string(row, "language"), "EN"))
        .bool("firstEdition", row.get("first_edition").and_then(Json::as_bool).unwrap_or(false))
        .bool("holo", holo)
        .bool("reverse", reverse)
        .bool("graded", row.get("graded").and_then(Json::as_bool).unwrap_or(false))
        .optional_string("gradingCompany", nullable(row, "grading_company"))
        .optional_string("grade", nullable(row, "grade"))
        .optional_string("certificationId", nullable(row, "certification_id"))
        .string(
            "cardName",
            non_empty(&raw_string(row, "card_name"), &raw_string(row, "card_id")),
        )
        .string("cardImageUrl", raw_string(row, "image_url"))
        .string(
            "setName",
            non_empty(&raw_string(row, "set_name"), "Pokemon"),
        )
        .string("collectorNumber", raw_string(row, "collector_number"))
        .string("ownershipType", "physical")
        .string("nftStatus", "")
        .string("fulfillmentMode", "physical")
        .string("physicalShippingStatus", "")
        .string("physicalShippingRequestId", "")
        .string("source", SOURCE_SCAN)
        .string("sourceOrderId", "")
        .string("sourceListingId", doc_id.clone())
        .string("sourceScanBatchId", batch_id.to_string())
        .string("sourceScanItemId", row_id)
        .optional_string("listingId", listing_id.map(str::to_string))
        .server_timestamp("updatedAt");
    if !existing {
        data = data.server_timestamp("createdAt");
    }
    Ok(ScanOwnershipPayload {
        doc_id,
        data,
        quantity,
    })
}

fn raw_string(row: &Map<String, Json>, key: &str) -> String {
    row.get(key).and_then(Json::as_str).unwrap_or("").to_string()
}

fn raw_number(row: &Map<String, Json>, key: &str) -> f64 {
    row.get(key).and_then(Json::as_f64).unwrap_or(0.0)
}

fn non_empty(value: &str, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn nullable(row: &Map<String, Json>, key: &str) -> Option<String> {
    row.get(key).and_then(Json::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(fields: Json) -> Document {
        Document {
            name: "projects/p/databases/(default)/documents/user_card_collections/x".into(),
            create_time: None,
            update_time: None,
            fields: serde_json::from_value(fields).ok(),
        }
    }

    #[test]
    fn scan_doc_ids_are_deterministic_and_prefixed_once() {
        assert_eq!(scan_ownership_doc_id("abc").unwrap(), "scan:abc");
        assert_eq!(scan_ownership_doc_id("scan:abc").unwrap(), "scan:abc");
        assert_eq!(scan_ownership_doc_id("  abc  ").unwrap(), "scan:abc");
        assert!(scan_ownership_doc_id("   ").is_err());
    }

    #[test]
    fn nft_rows_are_recognised_by_any_marker() {
        for fields in [
            json!({ "ownershipType": "nft" }),
            json!({ "fulfillmentMode": "nft_only" }),
            json!({ "nftStatus": "owned" }),
        ] {
            let map = fields.as_object().unwrap().clone();
            assert!(is_nft_row(&map), "{fields}");
        }
        let physical = json!({ "ownershipType": "physical", "nftStatus": "" });
        assert!(!is_nft_row(physical.as_object().unwrap()));
    }

    #[test]
    fn public_item_maps_every_documented_field() {
        let doc = document(json!({
            "uid": { "stringValue": "u1" },
            "cardId": { "stringValue": "12345" },
            "quantity": { "integerValue": "3" },
            "condition": { "stringValue": "NM" },
            "language": { "stringValue": "EN" },
            "holo": { "booleanValue": true },
            "reverse": { "booleanValue": false },
            "graded": { "booleanValue": false },
            "cardName": { "stringValue": "Pikachu" },
            "setName": { "stringValue": "Base Set" },
            "ownershipType": { "stringValue": "physical" },
            "source": { "stringValue": "pokoin_scan_batch" },
            "createdAt": { "timestampValue": "2026-01-02T03:04:05Z" },
            "updatedAt": { "timestampValue": "2026-01-02T03:04:06Z" }
        }));
        let item = public_collection_item("scan:9", &doc);
        assert_eq!(item["id"], json!("scan:9"));
        assert_eq!(item["uid"], json!("u1"));
        assert_eq!(item["cardId"], json!("12345"));
        assert_eq!(item["quantity"], json!(3));
        assert_eq!(item["name"], json!("Pikachu"));
        assert_eq!(item["cardName"], json!("Pikachu"));
        assert_eq!(item["gradingCompany"], Json::Null);
        assert_eq!(item["listingId"], Json::Null);
        assert_eq!(item["createdAt"], json!("2026-01-02T03:04:05.000Z"));
        assert_eq!(item["updatedAt"], json!("2026-01-02T03:04:06.000Z"));
    }

    #[test]
    fn card_and_blueprint_ids_fall_back_to_each_other() {
        let only_blueprint = document(json!({
            "blueprintId": { "stringValue": "bp1" },
            "quantity": { "integerValue": "1" }
        }));
        let item = public_collection_item("a", &only_blueprint);
        assert_eq!(item["cardId"], json!("bp1"));
        assert_eq!(item["blueprintId"], json!("bp1"));

        let only_card = document(json!({
            "cardId": { "stringValue": "c1" },
            "quantity": { "integerValue": "1" }
        }));
        let item = public_collection_item("b", &only_card);
        assert_eq!(item["cardId"], json!("c1"));
        assert_eq!(item["blueprintId"], json!("c1"));
    }

    #[test]
    fn iso_timestamp_handles_every_input_shape() {
        assert_eq!(
            iso_timestamp(&Value::Timestamp(
                chrono::DateTime::parse_from_rfc3339("2026-01-02T03:04:05Z")
                    .unwrap()
                    .with_timezone(&chrono::Utc)
            )),
            Some("2026-01-02T03:04:05.000Z".to_string())
        );
        assert_eq!(
            iso_timestamp(&Value::String("2026-01-02T03:04:05Z".into())),
            Some("2026-01-02T03:04:05.000Z".to_string())
        );
        assert_eq!(iso_timestamp(&Value::String("not a date".into())), None);
        assert_eq!(iso_timestamp(&Value::Null), None);
        assert_eq!(iso_timestamp(&Value::Integer(0)), None.or(Some("1970-01-01T00:00:00.000Z".to_string())));
    }

    #[test]
    fn scan_payload_uses_absolute_quantity_and_foil_flags() {
        let row: Map<String, Json> = json!({
            "id": "item-1",
            "card_id": "12345",
            "quantity": 2,
            "condition": "LP",
            "language": "JP",
            "foil_state": "reverse",
            "first_edition": true,
            "graded": true,
            "grading_company": "PSA",
            "grade": "10",
            "card_name": "Charizard",
            "image_url": "https://img/x.jpg",
            "set_name": "Base Set",
            "collector_number": "4/102"
        })
        .as_object()
        .unwrap()
        .clone();

        let payload = physical_payload_from_scan_row("u1", &row, "batch-1", Some("list-9"), false)
            .unwrap();
        assert_eq!(payload.doc_id, "scan:item-1");
        assert_eq!(payload.quantity, 2);
        let fields = &payload.data.fields;
        use crate::firestore::FieldValue;
        assert_eq!(
            fields.get("quantity"),
            Some(&FieldValue::Value(Value::Integer(2)))
        );
        assert_eq!(
            fields.get("reverse"),
            Some(&FieldValue::Value(Value::Boolean(true)))
        );
        assert_eq!(
            fields.get("holo"),
            Some(&FieldValue::Value(Value::Boolean(false)))
        );
        assert_eq!(
            fields.get("source"),
            Some(&FieldValue::Value(Value::String(SOURCE_SCAN.into())))
        );
        assert_eq!(
            fields.get("sourceListingId"),
            Some(&FieldValue::Value(Value::String("scan:item-1".into())))
        );
        assert_eq!(
            fields.get("listingId"),
            Some(&FieldValue::Value(Value::String("list-9".into())))
        );
        // A new doc gets createdAt; an existing one must not be reset.
        assert!(fields.contains_key("createdAt"));
        let existing = physical_payload_from_scan_row("u1", &row, "b", None, true).unwrap();
        assert!(!existing.data.fields.contains_key("createdAt"));
    }

    #[test]
    fn scan_payload_defaults_and_quantity_floor() {
        let row: Map<String, Json> = json!({ "id": "x", "card_id": "9", "quantity": 0 })
            .as_object()
            .unwrap()
            .clone();
        let payload = physical_payload_from_scan_row("u1", &row, "b", None, false).unwrap();
        assert_eq!(payload.quantity, 1, "quantity floors at 1");
        let fields = &payload.data.fields;
        use crate::firestore::FieldValue;
        assert_eq!(
            fields.get("condition"),
            Some(&FieldValue::Value(Value::String("NM".into())))
        );
        assert_eq!(
            fields.get("language"),
            Some(&FieldValue::Value(Value::String("EN".into())))
        );
        assert_eq!(
            fields.get("setName"),
            Some(&FieldValue::Value(Value::String("Pokemon".into())))
        );
        assert_eq!(
            fields.get("cardName"),
            Some(&FieldValue::Value(Value::String("9".into())))
        );
        // Absent optional fields are explicit nulls, like Node.
        assert_eq!(
            fields.get("grade"),
            Some(&FieldValue::Value(Value::Null))
        );
    }

    #[test]
    fn collection_json_shapes_match_the_two_endpoints() {
        let collection = OwnedCollection {
            uid: "u1".into(),
            items: vec![json!({ "id": "a" })],
            cards_owned: 3,
            item_count: 1,
            physical_items: 1,
            nft_items: 0,
            physical_owned: 3,
            nft_owned: 0,
            ..OwnedCollection::default()
        };
        let full = collection.to_json();
        assert_eq!(full["cardsOwned"], json!(3));
        assert_eq!(full["itemCount"], json!(1));
        assert!(full.get("physicalOwned").is_none());

        let summary = collection.to_summary_json();
        assert_eq!(summary["items"], json!(1));
        assert_eq!(summary["physicalOwned"], json!(3));
        assert_eq!(summary["nftOwned"], json!(0));
        assert!(summary.get("itemCount").is_none());
    }

    fn owned_doc(quantity: i64, nft: bool, ids: &[&str]) -> OwnedDoc {
        OwnedDoc {
            quantity,
            nft,
            listing_ids: ids.iter().map(|id| (*id).to_string()).collect(),
        }
    }

    fn owned_from(docs: Vec<OwnedDoc>) -> OwnedCollection {
        let mut collection = OwnedCollection {
            uid: "u1".into(),
            ..OwnedCollection::default()
        };
        for doc in &docs {
            collection.cards_owned += doc.quantity;
            collection.item_count += 1;
            if doc.nft {
                collection.nft_items += 1;
                collection.nft_owned += doc.quantity;
            } else {
                collection.physical_items += 1;
                collection.physical_owned += doc.quantity;
            }
        }
        collection.docs = docs;
        collection
    }

    fn live(listings: i64, copies: i64, listed_pkn: i64, linked: &[(&str, i64)]) -> LiveListings {
        LiveListings {
            listings,
            copies,
            listed_pkn,
            linked: linked
                .iter()
                .map(|(id, quantity)| ((*id).to_string(), *quantity))
                .collect(),
        }
    }

    fn assert_owned_splits(body: &Json) {
        let cards = body["cardsOwned"].as_i64().unwrap();
        let physical = body["physicalOwned"].as_i64().unwrap();
        let nft = body["nftOwned"].as_i64().unwrap();
        assert_eq!(cards, physical + nft, "{body}");
    }

    #[test]
    fn merge_counts_unlinked_docs_and_live_copies() {
        let collection = owned_from(vec![
            owned_doc(4, false, &["L1"]),
            owned_doc(2, false, &[]),
        ]);
        let body = merge_live_listings(&collection, &live(3, 10, 100, &[("L1", 5)]));
        assert_eq!(body["cardsOwned"], json!(12));
        assert_eq!(body["physicalOwned"], json!(12));
        assert_eq!(body["nftOwned"], json!(0));
        assert_eq!(body["items"], json!(2));
        assert_eq!(body["physicalItems"], json!(2));
        assert_eq!(body["nftItems"], json!(0));
        assert_eq!(body["collectionOwned"], json!(6));
        assert_eq!(body["listed"]["listings"], json!(3));
        assert_eq!(body["listed"]["copies"], json!(10));
        assert_eq!(body["listed"]["listedPkn"], json!(100));
        assert_eq!(body["uid"], json!("u1"));
        assert_owned_splits(&body);
    }

    #[test]
    fn merge_counts_a_listing_linked_by_two_docs_once() {
        let collection = owned_from(vec![
            owned_doc(1, false, &["L1"]),
            owned_doc(9, false, &["L1"]),
        ]);
        let body = merge_live_listings(&collection, &live(1, 4, 20, &[("L1", 4)]));
        assert_eq!(body["cardsOwned"], json!(4));
        assert_eq!(body["physicalOwned"], json!(4));
        assert_eq!(body["nftOwned"], json!(0));
        assert_eq!(body["collectionOwned"], json!(10));
        assert_owned_splits(&body);
    }

    #[test]
    fn merge_puts_an_nft_linked_listing_on_nft_owned() {
        let collection = owned_from(vec![owned_doc(1, true, &["N1"]), owned_doc(3, false, &[])]);
        let body = merge_live_listings(&collection, &live(2, 8, 50, &[("N1", 5)]));
        assert_eq!(body["cardsOwned"], json!(11));
        assert_eq!(body["nftOwned"], json!(5));
        assert_eq!(body["physicalOwned"], json!(6));
        assert_eq!(body["collectionOwned"], json!(4));
        assert_eq!(body["nftItems"], json!(1));
        assert_eq!(body["physicalItems"], json!(1));
        assert_owned_splits(&body);

        let shared = owned_from(vec![owned_doc(1, true, &["N1"]), owned_doc(2, true, &["N1"])]);
        let body = merge_live_listings(&shared, &live(1, 5, 10, &[("N1", 5)]));
        assert_eq!(body["cardsOwned"], json!(5));
        assert_eq!(body["nftOwned"], json!(5));
        assert_eq!(body["physicalOwned"], json!(0));
        assert_owned_splits(&body);
    }

    #[test]
    fn merge_counts_a_doc_whose_listing_is_not_live() {
        let collection = owned_from(vec![owned_doc(7, false, &["gone"])]);
        let body = merge_live_listings(&collection, &live(1, 2, 9, &[]));
        assert_eq!(body["cardsOwned"], json!(9));
        assert_eq!(body["physicalOwned"], json!(9));
        assert_eq!(body["nftOwned"], json!(0));
        assert_eq!(body["collectionOwned"], json!(7));
        assert_owned_splits(&body);
    }

    #[test]
    fn merge_with_no_collection_docs_is_the_live_copies() {
        let collection = OwnedCollection {
            uid: "u1".into(),
            ..OwnedCollection::default()
        };
        let body = merge_live_listings(&collection, &live(5, 9, 40, &[]));
        assert_eq!(body["cardsOwned"], json!(9));
        assert_eq!(body["physicalOwned"], json!(9));
        assert_eq!(body["nftOwned"], json!(0));
        assert_eq!(body["items"], json!(0));
        assert_eq!(body["physicalItems"], json!(0));
        assert_eq!(body["nftItems"], json!(0));
        assert_eq!(body["collectionOwned"], json!(0));
        assert_eq!(body["listed"]["listings"], json!(5));
        assert_eq!(body["listed"]["copies"], json!(9));
        assert_eq!(body["listed"]["listedPkn"], json!(40));
        assert_owned_splits(&body);
    }

    #[test]
    fn summary_without_live_listings_keeps_the_collection_sum() {
        let collection = OwnedCollection {
            uid: "u1".into(),
            cards_owned: 3,
            item_count: 2,
            physical_items: 1,
            nft_items: 1,
            physical_owned: 2,
            nft_owned: 1,
            ..OwnedCollection::default()
        };
        let summary = collection.to_summary_json();
        assert_eq!(summary["cardsOwned"], json!(3));
        assert_eq!(summary["collectionOwned"], json!(3));
        assert_eq!(summary["physicalOwned"], json!(2));
        assert_eq!(summary["nftOwned"], json!(1));
        assert_eq!(summary["items"], json!(2));
        assert_eq!(summary["physicalItems"], json!(1));
        assert_eq!(summary["nftItems"], json!(1));
        assert!(summary["listed"].is_null());
        assert!(summary.get("itemCount").is_none());
    }

    #[test]
    fn live_listing_rows_accept_numbers_and_numeric_strings() {
        let totals = vec![json!({
            "listings": "3",
            "copies": 10,
            "listed_pkn": "18.9"
        })];
        let linked = vec![
            json!({ "id": "9", "quantity": "4" }),
            json!({ "id": 12, "quantity": 2.2 }),
        ];
        let live = live_listings_from_rows(&totals, &linked);
        assert_eq!(live.listings, 3);
        assert_eq!(live.copies, 10);
        assert_eq!(live.listed_pkn, 18);
        assert_eq!(live.linked.get("9"), Some(&4));
        assert_eq!(live.linked.get("12"), Some(&2));
    }

}
