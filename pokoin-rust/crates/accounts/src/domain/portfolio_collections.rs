//! Custom collections — the seller's own named lists of cards and the value
//! series of each one.
//!
//! A collection is a list the seller writes by hand: it may hold cards they do
//! not own, and it keeps no record of when anything was acquired, so its daily
//! series is a backtest of one basket. The pricing rules are therefore *the same
//! functions* the main graph uses — [`crate::domain::portfolio_history`]'s slice
//! keys, sold price book and carry-forward — fed with rows shaped like the stock
//! rows of [`crate::domain::portfolio_history::HOLDINGS_SQL`] rather than database
//! rows. Nothing here queries a database or speaks HTTP;
//! [`crate::handlers::portfolio_collections`] does.
//!
//! Stored one document per collection in Firestore `portfolio_collections`, read
//! back by a `uid` equality query, so no composite index is needed.

use std::collections::HashMap;

use serde_json::{json, Map, Value as Json};

use crate::error::{ApiError, Result};
use crate::firestore::{DocData, Document, Firestore, Query as FirestoreQuery, Value};

use super::collection::iso_timestamp;
use super::marketplace_game::normalize_game;
use super::portfolio_history::{
    add_utc_days, condition_key, holding_slices, language_key, last_sold_for, num, round2,
    sold_slice_key, value_holdings_on, PricePoint, HISTORY_DAYS, PRICE_BASIS,
};

/// Firestore collection of the seller's own card lists: one document per
/// collection, found by `uid`.
pub const COLLECTION: &str = "portfolio_collections";

/// How many lists one seller keeps. Past this the dashboard draws more lines than
/// a screen shows and the graph stops being readable.
pub const MAX_COLLECTIONS: usize = 20;
/// How many cards one list holds — the ceiling an active seller's whole stock is
/// expected to stay inside.
pub const MAX_ITEMS: usize = 300;
/// How many copies of one card, the same ceiling a listing carries.
pub const MAX_QUANTITY: i64 = 999;
/// How long a collection name is.
pub const MAX_NAME_LEN: usize = 40;
/// How long a card or set title stored for display is.
pub const MAX_DISPLAY_LEN: usize = 120;

/// The `group` every collection def carries, so the client draws the lists as one
/// block beside the era and set blocks.
pub const GROUP: &str = "collection";

/// One query for a seller's collections. [`MAX_COLLECTIONS`] is the real ceiling;
/// the headroom keeps a document written under an older, looser limit readable.
const READ_LIMIT: i64 = 64;

/// The facet a saved item takes when the client leaves it out. Both are stored as
/// their own key, and the `*_key` functions are idempotent, so the round trip is
/// the slice the price book is filed under either way.
const DEFAULT_CONDITION: &str = "Near Mint";
const DEFAULT_LANGUAGE: &str = "English";

/// Every slice's sold medians, oldest first — the one book the main series and
/// all of this seller's collections are priced out of.
pub type Book = HashMap<String, Vec<PricePoint>>;

/// The segment key one collection draws under, beside the era and set keys of
/// [`crate::domain::portfolio_segments`].
pub fn segment_key(id: &str) -> String {
    format!("collection:{id}")
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

fn name_missing_error() -> ApiError {
    ApiError::bad_request(format!(
        "A collection needs a name of 1–{MAX_NAME_LEN} characters."
    ))
    .with_code("collection_name_required")
}

fn limit_error() -> ApiError {
    ApiError::bad_request(format!(
        "You can keep {MAX_COLLECTIONS} collections. Delete one first."
    ))
    .with_code("collection_limit")
}

fn items_limit_error() -> ApiError {
    ApiError::bad_request(format!("A collection holds at most {MAX_ITEMS} cards."))
        .with_code("collection_items_limit")
}

/// The refused card is named by its position in the request, which is the only
/// way a seller finds it in a list of 300.
fn item_error(index: usize) -> ApiError {
    ApiError::bad_request(format!(
        "Collection card {} needs a card id of 1–12 digits and a quantity of \
         1–{MAX_QUANTITY}.",
        index + 1
    ))
    .with_code("collection_item_invalid")
}

fn items_shape_error() -> ApiError {
    ApiError::bad_request("The cards of a collection must be a list.")
        .with_code("collection_item_invalid")
}

/// An unknown id, an already-deleted id and another seller's id answer this, so a
/// collection id never leaks through an error.
fn missing_error() -> ApiError {
    ApiError::not_found("Collection not found.").with_code("collection_not_found")
}

fn name_taken_error() -> ApiError {
    ApiError::conflict("You already have a collection with that name.")
        .with_code("collection_name_taken")
}

// ---------------------------------------------------------------------------
// Text and fields
// ---------------------------------------------------------------------------

/// Control characters out, ends trimmed, inner whitespace runs collapsed to one
/// space, so a pasted title draws the way the seller typed it. A line break between
/// two words is a space, not a glue: `Charizard\n  ex` is "Charizard ex".
pub fn clean_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_whitespace() || !character.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn text_of(value: Option<&Json>) -> String {
    match value {
        Some(Json::String(text)) => text.clone(),
        Some(Json::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

fn bool_of(object: &Map<String, Json>, key: &str) -> bool {
    object.get(key).and_then(Json::as_bool).unwrap_or(false)
}

/// A collection name: cleaned, and 1 to [`MAX_NAME_LEN`] characters.
pub fn sanitize_name(value: Option<&Json>) -> Result<String> {
    let name = clean_text(&text_of(value));
    if name.is_empty() || name.chars().count() > MAX_NAME_LEN {
        return Err(name_missing_error());
    }
    Ok(name)
}

/// Display-only text (a card or a set title): cleaned and capped, never refused.
pub fn sanitize_display(value: Option<&Json>) -> String {
    clean_text(&text_of(value))
        .chars()
        .take(MAX_DISPLAY_LEN)
        .collect()
}

/// A public `card_id`: 1–12 ASCII digits, and not zero.
fn sanitize_card_id(value: Option<&Json>) -> Option<String> {
    let text = text_of(value);
    let text = text.trim();
    if text.is_empty()
        || text.len() > 12
        || !text.bytes().all(|byte| byte.is_ascii_digit())
        || text.bytes().all(|byte| byte == b'0')
    {
        return None;
    }
    Some(text.to_string())
}

/// An owned quantity: a whole number 1..=[`MAX_QUANTITY`], or one when the field
/// is absent.
fn sanitize_quantity(value: Option<&Json>) -> Option<i64> {
    let quantity = match value {
        None | Some(Json::Null) => 1,
        Some(Json::Number(number)) => match number.as_i64() {
            Some(whole) => whole,
            None => {
                let float = number.as_f64()?;
                if float.fract() != 0.0 {
                    return None;
                }
                float as i64
            }
        },
        Some(Json::String(text)) => text.trim().parse().ok()?,
        Some(_) => return None,
    };
    (1..=MAX_QUANTITY).contains(&quantity).then_some(quantity)
}

/// A facet as its price-book key, [`DEFAULT_CONDITION`] and [`DEFAULT_LANGUAGE`]
/// when the client left it out.
fn sanitize_facet(value: Option<&Json>, default_value: &str, key: fn(&str) -> String) -> String {
    let text = text_of(value);
    if clean_text(&text).is_empty() {
        key(default_value)
    } else {
        key(&text)
    }
}

/// What [`crate::firestore::new_document_id`] writes: an id outside that shape
/// cannot exist, and sending it to the REST API would answer a 400 that reads as
/// a server failure.
pub fn is_collection_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/// One card of one collection, as stored: what the card *is*, never what it is
/// worth. Every price is computed on the read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub game: String,
    pub card_id: String,
    pub condition: String,
    pub language: String,
    pub reverse: bool,
    pub first_edition: bool,
    pub graded: bool,
    pub quantity: i64,
    /// Display only: stored and answered, never used to find a price.
    pub name: String,
    pub set_name: String,
}

impl Item {
    /// A client or stored item, or the error naming which one was refused.
    pub fn from_input(value: &Json, index: usize) -> Result<Self> {
        let object = value.as_object().ok_or_else(|| item_error(index))?;
        let quantity =
            sanitize_quantity(object.get("quantity")).ok_or_else(|| item_error(index))?;
        Ok(Self {
            game: normalize_game(&text_of(object.get("game"))),
            card_id: sanitize_card_id(object.get("cardId").or_else(|| object.get("card_id")))
                .ok_or_else(|| item_error(index))?,
            condition: sanitize_facet(object.get("condition"), DEFAULT_CONDITION, condition_key),
            language: sanitize_facet(object.get("language"), DEFAULT_LANGUAGE, language_key),
            reverse: bool_of(object, "reverse"),
            first_edition: bool_of(object, "firstEdition") || bool_of(object, "first_edition"),
            graded: bool_of(object, "graded"),
            quantity,
            name: sanitize_display(object.get("name")),
            set_name: sanitize_display(object.get("setName").or_else(|| object.get("set_name"))),
        })
    }

    /// The stored and answered shape. Every key here is one [`Item::from_input`]
    /// reads, so a document round-trips through the sanitiser unchanged.
    pub fn to_json(&self) -> Json {
        json!({
            "game": self.game,
            "cardId": self.card_id,
            "condition": self.condition,
            "language": self.language,
            "reverse": self.reverse,
            "firstEdition": self.first_edition,
            "graded": self.graded,
            "quantity": self.quantity,
            "name": self.name,
            "setName": self.set_name,
        })
    }

    /// The same item plus its price on the reported day. `null` when its slice has
    /// never sold — the gap the `cardsPriced` count of the series misses.
    pub fn to_priced_json(&self, price_pkn: Option<f64>) -> Json {
        let mut item = self.to_json();
        if let Some(object) = item.as_object_mut() {
            object.insert("pricePkn".into(), price_pkn.map_or(Json::Null, num));
        }
        item
    }

    /// A row in the shape `HOLDINGS_SQL` answers, so the sold machinery prices a
    /// collection unchanged. `blueprint_id` is empty until the handler resolves it
    /// out of the card's own game.
    pub fn row(&self) -> Json {
        json!({
            "game": self.game,
            "card_id": self.card_id,
            "blueprint_id": "",
            "condition": self.condition,
            "language": self.language,
            "reverse": self.reverse,
            "first_edition": self.first_edition,
            "graded": self.graded,
            "quantity": self.quantity,
        })
    }

    /// Two items of one slice sell for one price, so they are one line.
    fn is_same_slice(&self, other: &Item) -> bool {
        self.game == other.game
            && self.card_id == other.card_id
            && self.condition == other.condition
            && self.language == other.language
            && self.reverse == other.reverse
            && self.first_edition == other.first_edition
            && self.graded == other.graded
    }
}

/// Items of the same slice merge into the first of them: quantities add, capped
/// at [`MAX_QUANTITY`], position kept.
pub fn merge_items(items: Vec<Item>) -> Vec<Item> {
    let mut merged: Vec<Item> = Vec::with_capacity(items.len());
    for item in items {
        match merged.iter_mut().find(|kept| kept.is_same_slice(&item)) {
            Some(kept) => {
                kept.quantity = kept
                    .quantity
                    .saturating_add(item.quantity)
                    .min(MAX_QUANTITY);
            }
            None => merged.push(item),
        }
    }
    merged
}

/// Every card of a save, each refused by its own index, then merged by slice.
pub fn sanitize_items(values: &[Json]) -> Result<Vec<Item>> {
    if values.len() > MAX_ITEMS {
        return Err(items_limit_error());
    }
    let mut items = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        items.push(Item::from_input(value, index)?);
    }
    Ok(merge_items(items))
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/// One stored collection, with the timestamps it was written with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub items: Vec<Item>,
    /// ISO 8601 UTC, empty when the document carries no timestamp.
    pub created_at: String,
    pub updated_at: String,
}

impl Collection {
    pub fn key(&self) -> String {
        segment_key(&self.id)
    }
}

fn stored_iso(document: &Document, field: &str) -> String {
    document
        .get(field)
        .and_then(|value| iso_timestamp(&value))
        .unwrap_or_default()
}

/// A stored document as a collection. A card the sanitiser refuses is dropped one
/// by one rather than failing the read: a document written before a limit existed
/// must still show the seller the cards in it that are fine.
pub fn collection_from_document(document: &Document) -> Collection {
    let items = match document.get("items") {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|value| Item::from_input(&value.to_plain_json(), 0).ok())
            .collect(),
        _ => Vec::new(),
    };
    Collection {
        id: document.id(),
        name: clean_text(&document.get_str("name"))
            .chars()
            .take(MAX_NAME_LEN)
            .collect(),
        items,
        created_at: stored_iso(document, "createdAt"),
        updated_at: stored_iso(document, "updatedAt"),
    }
}

/// The document a collection is stored as. The whole document is written on every
/// save, so a field an earlier write set and this one dropped cannot linger.
pub fn doc_data(
    uid: &str,
    name: &str,
    items: &[Item],
    created_at_ms: i64,
    updated_at_ms: i64,
) -> DocData {
    DocData::new()
        .string("uid", uid)
        .string("name", name)
        .array(
            "items",
            items
                .iter()
                .map(|item| Value::from_plain_json(&item.to_json()))
                .collect(),
        )
        .timestamp("createdAt", created_at_ms)
        .timestamp("updatedAt", updated_at_ms)
}

/// The document, but only when it is this seller's. A Firestore miss (`Ok(None)`)
/// and another seller's document answer the same way, so an id never leaks.
pub fn owned_document<'a>(document: Option<&'a Document>, uid: &str) -> Option<&'a Document> {
    document.filter(|document| document.get_str("uid") == uid)
}

/// What a `?action=save` body asks for: the list to write, already cleaned and
/// merged, and the id it replaces when the client sent one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Save {
    pub id: Option<String>,
    pub name: String,
    pub items: Vec<Item>,
}

impl Save {
    pub fn from_body(body: &Json) -> Result<Self> {
        let name = sanitize_name(body.get("name"))?;
        let id = match body.get("id") {
            None | Some(Json::Null) => None,
            Some(value) => {
                let text = clean_text(&text_of(Some(value)));
                if text.is_empty() {
                    None
                } else if is_collection_id(&text) {
                    Some(text)
                } else {
                    // An id outside the shape Firestore writes cannot exist, and
                    // asking for it must read as "not yours", not as a bad request.
                    return Err(missing_error());
                }
            }
        };
        let items = match body.get("items") {
            None | Some(Json::Null) => Vec::new(),
            Some(Json::Array(values)) => sanitize_items(values)?,
            Some(_) => return Err(items_shape_error()),
        };
        Ok(Self { id, name, items })
    }
}

/// What a `?action=delete` body names. An id that is absent or not a string gets
/// the same 404 every other seller's id answers with: the request cannot say which
/// list it means, and saying so must not distinguish it from a list that is not
/// yours.
pub fn delete_body_id(body: &Json) -> Result<String> {
    let text = match body.get("id") {
        None | Some(Json::Null) => String::new(),
        Some(value @ Json::String(_)) => clean_text(&text_of(Some(value))),
        Some(_) => return Err(missing_error()),
    };
    if text.is_empty() {
        return Err(missing_error());
    }
    Ok(text)
}

/// Two names the seller would read as one list. The compare is case-insensitive
/// because the dashboard draws names as titles, so `Vault` and `VAULT` are the same
/// line to whoever looks at the graph.
pub fn names_collide(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// This seller's collections, oldest first — the order the graph draws them in.
/// Firestore answers a `where_eq` query in document-id order and the auto ids are
/// not monotonic, so the stored creation time is what orders them.
pub async fn list_collections(firestore: &Firestore, uid: &str) -> Result<Vec<Collection>> {
    let documents = firestore
        .run_query(
            &FirestoreQuery::collection(COLLECTION)
                .where_eq("uid", uid)
                .limit(READ_LIMIT),
        )
        .await?;
    let mut collections: Vec<Collection> = documents
        .iter()
        .map(collection_from_document)
        .filter(|collection| !collection.id.is_empty())
        .collect();
    collections.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(collections)
}

/// Write one collection, answering its id. `id` replaces in place, keeping the
/// creation time it was written with.
pub async fn apply_save(
    firestore: &Firestore,
    uid: &str,
    save: &Save,
    now_ms: i64,
) -> Result<String> {
    let existing: Option<Document> = match save.id.as_deref() {
        None => None,
        Some(id) => Some(
            owned_document(
                firestore
                    .collection_doc(COLLECTION, id)
                    .get()
                    .await?
                    .as_ref(),
                uid,
            )
            .cloned()
            .ok_or_else(missing_error)?,
        ),
    };
    let collections = list_collections(firestore, uid).await?;
    let replaced = existing.as_ref().map(Document::id);
    for collection in &collections {
        if replaced.as_deref() == Some(collection.id.as_str()) {
            continue;
        }
        if names_collide(&collection.name, &save.name) {
            return Err(name_taken_error());
        }
    }
    if existing.is_none() && collections.len() >= MAX_COLLECTIONS {
        return Err(limit_error());
    }
    let created_at_ms = existing
        .as_ref()
        .and_then(|document| document.get_timestamp_millis("createdAt"))
        .unwrap_or(now_ms);
    let data = doc_data(uid, &save.name, &save.items, created_at_ms, now_ms);
    match existing {
        Some(document) => {
            let id = document.id();
            firestore
                .collection_doc(COLLECTION, &id)
                .set(data, false)
                .await?;
            Ok(id)
        }
        None => Ok(firestore.collection(COLLECTION).add(data).await?.id()),
    }
}

/// Delete one collection. An id that is not this seller's answers the same 404 as
/// an id that never was.
pub async fn delete_collection(firestore: &Firestore, uid: &str, id: &str) -> Result<()> {
    if !is_collection_id(id) {
        return Err(missing_error());
    }
    let reference = firestore.collection_doc(COLLECTION, id);
    if owned_document(reference.get().await?.as_ref(), uid).is_none() {
        return Err(missing_error());
    }
    reference.delete().await
}

// ---------------------------------------------------------------------------
// The backtest
// ---------------------------------------------------------------------------

/// Every item of every collection as one row list, each collection keeping its
/// range inside it. The handler resolves blueprints into the flat list once — that
/// is what a non-Pokémon card's own database is asked for, and one pass over all
/// the rows is what keeps the per-game caps and timeouts of the main series — and
/// the series and the answered prices read the ranges back out.
#[derive(Debug, Clone, Default)]
pub struct Rows {
    all: Vec<Json>,
    ranges: Vec<(String, usize, usize)>,
}

impl Rows {
    pub fn new(collections: &[Collection]) -> Self {
        let mut all: Vec<Json> = Vec::new();
        let mut ranges: Vec<(String, usize, usize)> = Vec::with_capacity(collections.len());
        for collection in collections {
            let start = all.len();
            for item in &collection.items {
                all.push(item.row());
            }
            ranges.push((collection.id.clone(), start, all.len() - start));
        }
        Self { all, ranges }
    }

    /// Every row, for the blueprint resolution and the sold query.
    pub fn rows(&self) -> &[Json] {
        &self.all
    }

    pub fn rows_mut(&mut self) -> &mut Vec<Json> {
        &mut self.all
    }

    /// `(collection id, its rows)` in the order the collections came in.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &[Json])> {
        self.ranges
            .iter()
            .map(|(id, start, len)| (id.as_str(), &self.all[*start..*start + *len]))
    }

    /// The segment keys, in the same order.
    pub fn keys(&self) -> Vec<String> {
        self.ranges
            .iter()
            .map(|(id, _, _)| segment_key(id))
            .collect()
    }
}

/// Write a resolved blueprint onto a row. Empty is an answer too: a card of a game
/// whose catalog could not be read holds unpriced rather than borrowing a Pokémon
/// price off a colliding id.
pub fn set_blueprint(row: &mut Json, blueprint: &str) {
    if let Some(object) = row.as_object_mut() {
        object.insert("blueprint_id".into(), json!(blueprint));
    }
}

/// The day the series is drawn from: the earliest sold print of any slice of any
/// collection, never older than the window the dashboard draws, and `today` when
/// nothing has ever sold.
pub fn series_start(rows: &Rows, book: &Book, today: &str) -> String {
    let floor = add_utc_days(today, -(HISTORY_DAYS - 1));
    let mut start = today.to_string();
    for row in rows.rows() {
        let day = book
            .get(&sold_slice_key(row))
            .and_then(|points| points.first())
            .map(|point| point.day.as_str())
            .unwrap_or("");
        if !day.is_empty() {
            let day = day.max(floor.as_str());
            if day < start.as_str() {
                start = day.to_string();
            }
        }
    }
    start
}

/// What every collection held on `day`, as one `segments` map, or nothing when no
/// collection held anything.
pub fn day_segments(rows: &Rows, book: &Book, day: &str) -> Option<Json> {
    let mut segments = Map::new();
    for (id, item_rows) in rows.iter() {
        if let Some(value) = value_holdings_on(&holding_slices(item_rows), book, day) {
            segments.insert(
                segment_key(id),
                json!([
                    num(round2(value.cards_value_pkn)),
                    value.cards_priced,
                    value.cards_held,
                ]),
            );
        }
    }
    (!segments.is_empty()).then(|| json!({ "date": day, "segments": segments }))
}

/// The daily series of every collection at once, from [`series_start`] to `today`.
///
/// Nothing of it is stored: a list changes the moment the seller edits it, and a
/// stored copy of a basket the seller deleted is a graph of nothing. A day no
/// collection appears in is left out, and an empty collection never enters
/// `segments` while keeping its def.
pub fn collection_days(rows: &Rows, book: &Book, today: &str) -> Vec<Json> {
    let mut days = Vec::new();
    let mut day = series_start(rows, book, today);
    for _ in 0..=HISTORY_DAYS {
        if day.as_str() > today {
            break;
        }
        if let Some(entry) = day_segments(rows, book, &day) {
            days.push(entry);
        }
        let next = add_utc_days(&day, 1);
        if next.is_empty() || next.as_str() <= day.as_str() {
            break;
        }
        day = next;
    }
    days
}

/// The day the answer reports prices as of: the last day of the series, or `today`
/// when there is no series at all.
pub fn last_day(days: &[Json], today: &str) -> String {
    days.last()
        .and_then(|day| day.get("date"))
        .and_then(Json::as_str)
        .unwrap_or(today)
        .to_string()
}

fn iso_or_null(value: &str) -> Json {
    value
        .is_empty()
        .then_some(Json::Null)
        .unwrap_or(json!(value))
}

/// The `collections` array: what each list holds, each card with its price on
/// `day`.
pub fn collections_json(
    collections: &[Collection],
    rows: &Rows,
    book: &Book,
    day: &str,
) -> Vec<Json> {
    collections
        .iter()
        .zip(rows.iter())
        .map(|(collection, (_, item_rows))| {
            let items = collection
                .items
                .iter()
                .zip(item_rows.iter())
                .map(|(saved, row)| {
                    saved.to_priced_json(last_sold_for(row, book, day).map(|point| point.pkn))
                })
                .collect::<Vec<_>>();
            json!({
                "id": collection.id,
                "name": collection.name,
                "createdAt": iso_or_null(&collection.created_at),
                "updatedAt": iso_or_null(&collection.updated_at),
                "items": items,
            })
        })
        .collect()
}

/// The ordered list the client draws: one def per collection, in creation order,
/// whether or not any day carries it.
pub fn collection_defs(collections: &[Collection]) -> Vec<Json> {
    collections
        .iter()
        .map(|collection| {
            json!({
                "key": collection.key(),
                "group": GROUP,
                "label": collection.name,
            })
        })
        .collect()
}

/// What the client is held to, so its own form can bound the same numbers.
pub fn limits() -> Json {
    json!({
        "collections": MAX_COLLECTIONS,
        "items": MAX_ITEMS,
        "quantity": MAX_QUANTITY,
        "name": MAX_NAME_LEN,
    })
}

/// The whole answer body, keys in the order the contract lists them. `day` is what
/// each item's `pricePkn` is read as of — the last day of `days`.
pub fn answer_body(
    collections: &[Collection],
    rows: &Rows,
    book: &Book,
    days: &[Json],
    day: &str,
    saved: Option<&str>,
) -> Json {
    let mut body = Map::new();
    body.insert("priceBasis".into(), json!(PRICE_BASIS));
    body.insert("limits".into(), limits());
    if let Some(saved) = saved {
        body.insert("saved".into(), json!(saved));
    }
    body.insert(
        "collections".into(),
        json!(collections_json(collections, rows, book, day)),
    );
    body.insert("segmentDefs".into(), json!(collection_defs(collections)));
    body.insert("days".into(), json!(days));
    Json::Object(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::portfolio_history::sold_price_book;
    use crate::domain::portfolio_segments::POKEMON;
    use crate::firestore::FieldValue;

    fn input(card: &str, quantity: i64) -> Json {
        json!({ "cardId": card, "quantity": quantity })
    }

    fn item(card: &str) -> Item {
        Item::from_input(&input(card, 1), 0).unwrap()
    }

    fn collection(id: &str, name: &str, created_at: &str, items: Vec<Item>) -> Collection {
        Collection {
            id: id.into(),
            name: name.into(),
            items,
            created_at: created_at.into(),
            updated_at: created_at.into(),
        }
    }

    /// A sold row of one blueprint and facet, the shape `sold_price_book` reads.
    fn sold_row(card: &str, blueprint: &str, graded: bool, day: &str, pkn: f64) -> Json {
        json!({
            "game": "pokemon",
            "card_id": card,
            "blueprint_id": blueprint,
            "condition": "NM",
            "language": "ENGLISH",
            "reverse": false,
            "first_edition": false,
            "graded": graded,
            "observed_day": day,
            "median_pkn": pkn,
        })
    }

    fn book_of(sold: &[Json]) -> Book {
        sold_price_book(sold)
    }

    /// A `Rows` whose Pokémon cards resolved to the blueprints given, so a test
    /// writes exactly what the handler writes after its catalog reads.
    fn resolved(collections: &[Collection], blueprints: &[(&str, &str)]) -> Rows {
        let mut rows = Rows::new(collections);
        for row in rows.rows_mut() {
            let card = row
                .get("card_id")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string();
            if let Some((_, blueprint)) = blueprints.iter().find(|(id, _)| *id == card) {
                set_blueprint(row, blueprint);
            }
        }
        rows
    }

    fn document(uid: &str, name: &str, created: &str, items: Vec<Json>) -> Document {
        let mut fields = Map::new();
        fields.insert("uid".into(), json!({ "stringValue": uid }));
        fields.insert("name".into(), json!({ "stringValue": name }));
        fields.insert(
            "createdAt".into(),
            json!({ "stringValue": format!("{created}.000Z") }),
        );
        fields.insert(
            "updatedAt".into(),
            json!({ "stringValue": format!("{created}.000Z") }),
        );
        fields.insert("items".into(), json!({ "arrayValue": { "values": items } }));
        Document {
            name: format!("projects/p/databases/(default)/documents/{COLLECTION}/c{created}"),
            create_time: None,
            update_time: None,
            fields: Some(fields),
        }
    }

    fn stored_item(card: &str, quantity: i64) -> Json {
        json!({
            "mapValue": {
                "fields": {
                    "cardId": { "stringValue": card },
                    "quantity": { "integerValue": quantity.to_string() },
                    "condition": { "stringValue": "NM" },
                    "language": { "stringValue": "ENGLISH" },
                    "reverse": { "booleanValue": false },
                    "firstEdition": { "booleanValue": false },
                    "graded": { "booleanValue": false },
                    "game": { "stringValue": "pokemon" },
                    "name": { "stringValue": "  Charizard  " },
                    "setName": { "stringValue": "Base Set" }
                }
            }
        })
    }

    // -- the sanitiser ------------------------------------------------------

    #[test]
    fn names_are_cleaned_and_bounded() {
        assert_eq!(
            sanitize_name(Some(&json!("  Dawn   Runs  "))).unwrap(),
            "Dawn Runs"
        );
        assert_eq!(
            sanitize_name(Some(&json!("a\u{1}b\u{7f}c"))).unwrap(),
            "abc"
        );
        assert_eq!(
            sanitize_name(Some(&json!("Newline\nTitle"))).unwrap(),
            "Newline Title"
        );
        assert_eq!(
            sanitize_name(Some(&json!("x".repeat(MAX_NAME_LEN))))
                .unwrap()
                .chars()
                .count(),
            MAX_NAME_LEN
        );
        let too_long = sanitize_name(Some(&json!("x".repeat(MAX_NAME_LEN + 1)))).unwrap_err();
        assert_eq!(too_long.code(), Some("collection_name_required"));
        assert_eq!(too_long.status(), axum::http::StatusCode::BAD_REQUEST);
        for missing in [
            None,
            Some(&json!("")),
            Some(&json!("   ")),
            Some(&json!("\n\t")),
        ] {
            assert_eq!(
                sanitize_name(missing).unwrap_err().code(),
                Some("collection_name_required")
            );
        }
    }

    #[test]
    fn display_text_is_capped_never_refused() {
        assert_eq!(
            sanitize_display(Some(&json!("a".repeat(MAX_DISPLAY_LEN + 40))))
                .chars()
                .count(),
            MAX_DISPLAY_LEN
        );
        assert_eq!(sanitize_display(Some(&json!("  Girafarig  "))), "Girafarig");
        assert_eq!(sanitize_display(Some(&json!(12))), "12");
        assert_eq!(sanitize_display(None), "");
    }

    #[test]
    fn items_take_their_facet_defaults_and_ids() {
        let saved = Item::from_input(&json!({ "cardId": "42" }), 0).unwrap();
        assert_eq!(saved.card_id, "42");
        assert_eq!(saved.condition, condition_key(DEFAULT_CONDITION));
        assert_eq!(saved.language, language_key(DEFAULT_LANGUAGE));
        assert_eq!(saved.quantity, 1);
        assert_eq!(saved.game, POKEMON);
        assert!(!(saved.reverse || saved.first_edition || saved.graded));
        assert_eq!(saved.name, "");

        // A stored facet key read back is the same key, so the item prices as the
        // fresh one did.
        assert_eq!(saved.condition, condition_key(&saved.condition));
        assert_eq!(saved.language, language_key(&saved.language));

        let explicit = Item::from_input(
            &json!({
                "cardId": 42,
                "game": "One Piece",
                "condition": "lightly played",
                "language": "ja",
                "reverse": true,
                "firstEdition": true,
                "graded": true,
                "quantity": 3,
                "name": " Luffy ",
                "setName": "OP-01"
            }),
            0,
        )
        .unwrap();
        assert_eq!(explicit.card_id, "42");
        assert_eq!(explicit.game, "one_piece");
        assert_eq!(explicit.condition, "SP");
        assert_eq!(explicit.language, "JP");
        assert!(explicit.reverse && explicit.first_edition && explicit.graded);
        assert_eq!(explicit.quantity, 3);
        assert_eq!(explicit.name, "Luffy");
        assert_eq!(explicit.set_name, "OP-01");
        assert!(
            Item::from_input(
                &json!({ "card_id": "7", "quantity": "5", "first_edition": true }),
                0
            )
            .unwrap()
            .first_edition
        );
    }

    #[test]
    fn bad_items_are_refused_by_position() {
        let cases = vec![
            json!({}),
            json!({ "cardId": "" }),
            json!({ "cardId": "0" }),
            json!({ "cardId": "00" }),
            json!({ "cardId": "4a" }),
            json!({ "cardId": "-7" }),
            json!({ "cardId": "1.5" }),
            json!({ "cardId": "1234567890123" }),
            json!({ "cardId": "42", "quantity": 0 }),
            json!({ "cardId": "42", "quantity": -3 }),
            json!({ "cardId": "42", "quantity": MAX_QUANTITY + 1 }),
            json!({ "cardId": "42", "quantity": 1.5 }),
            json!({ "cardId": "42", "quantity": "many" }),
            json!({ "cardId": "42", "quantity": true }),
            json!("42"),
            Json::Null,
        ];
        for case in cases {
            let error = Item::from_input(&case, 2).unwrap_err();
            assert_eq!(error.code(), Some("collection_item_invalid"), "{case}");
            assert!(
                error.message().contains("3"),
                "the position must be named: {}",
                error.message()
            );
        }
        assert_eq!(
            sanitize_items(&[input("1", 1), json!({ "condition": "NM" })])
                .unwrap_err()
                .message(),
            item_error(1).message()
        );
    }

    #[test]
    fn a_twelve_digit_id_and_a_quantity_at_the_cap_are_kept() {
        let saved = Item::from_input(
            &json!({ "cardId": "123456789012", "quantity": MAX_QUANTITY }),
            0,
        )
        .unwrap();
        assert_eq!(saved.card_id, "123456789012");
        assert_eq!(saved.quantity, MAX_QUANTITY);
    }

    #[test]
    fn items_of_one_slice_merge_into_the_first() {
        let merged = sanitize_items(&[
            input("7", 2),
            input("9", 1),
            json!({ "cardId": "7", "graded": true, "quantity": 4 }),
            input("7", 5),
            json!({ "cardId": "7", "language": "ja", "quantity": 1 }),
        ])
        .unwrap();
        assert_eq!(merged.len(), 4);
        assert_eq!(merged[0].card_id, "7");
        assert_eq!(merged[0].quantity, 7, "the two loose copies are one line");
        assert_eq!(merged[1].card_id, "9");
        assert!(merged[2].graded, "a graded copy is another slice");
        assert_eq!(merged[2].quantity, 4);
        assert_eq!(merged[3].language, "JP");
        assert_eq!(merge_items(Vec::new()), Vec::new());

        let capped = sanitize_items(&[input("7", 600), input("7", 600)]).unwrap();
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0].quantity, MAX_QUANTITY);
    }

    #[test]
    fn a_list_is_bounded_by_its_own_count() {
        assert_eq!(
            sanitize_items(&vec![input("1", 1); MAX_ITEMS + 1])
                .unwrap_err()
                .code(),
            Some("collection_items_limit")
        );
        assert_eq!(
            sanitize_items(&vec![input("2", 1); MAX_ITEMS])
                .unwrap()
                .len(),
            1
        );
        assert_eq!(sanitize_items(&[]).unwrap().len(), 0);
    }

    #[test]
    fn ids_are_firestore_ids() {
        assert!(is_collection_id("Ab3dEfGhIjKlMnOpQrSt"));
        assert!(is_collection_id("my-collection_1"));
        assert!(!is_collection_id(""));
        assert!(!is_collection_id("has space"));
        assert!(!is_collection_id("a/b"));
        assert!(!is_collection_id(&"x".repeat(33)));
    }

    #[test]
    fn a_name_is_taken_whatever_its_case() {
        assert!(names_collide("Vault", "vault"));
        assert!(names_collide("Dawn Runs", "dawn runs"));
        assert!(!names_collide("Vault", "Vaults"));
        assert!(
            !names_collide("Vault", "Vault "),
            "a stored name is already trimmed"
        );
    }

    #[test]
    fn a_save_body_names_its_list_and_its_cards() {
        let save = Save::from_body(&json!({
            "id": " Ab3_ ",
            "name": "  Vault \u{1} ",
            "items": [input("11", 1), input("11", 2)],
        }))
        .unwrap();
        assert_eq!(save.id.as_deref(), Some("Ab3_"));
        assert_eq!(save.name, "Vault");
        assert_eq!(save.items.len(), 1, "the save merges as the list does");
        assert_eq!(save.items[0].quantity, 3);

        // A write of a list nobody can have created reads as "not yours".
        for id in [json!("has space"), json!("a/b"), json!("x".repeat(33))] {
            let error = Save::from_body(&json!({ "name": "A", "id": id })).unwrap_err();
            assert_eq!(error.code(), Some("collection_not_found"), "{id}");
            assert_eq!(error.status(), axum::http::StatusCode::NOT_FOUND);
        }

        // An absent id, name or list is still a save: a new empty list.
        let bare = Save::from_body(&json!({ "name": "Wishlist" })).unwrap();
        assert_eq!(bare.id, None);
        assert!(bare.items.is_empty());
        for body in [
            json!({ "name": "A", "id": Json::Null }),
            json!({ "name": "A", "items": Json::Null }),
        ] {
            assert_eq!(Save::from_body(&body).unwrap().items.len(), 0);
        }

        assert_eq!(
            Save::from_body(&json!({ "items": [] })).unwrap_err().code(),
            Some("collection_name_required")
        );
        assert_eq!(
            Save::from_body(&json!({ "name": "A", "items": json!("11") }))
                .unwrap_err()
                .code(),
            Some("collection_item_invalid")
        );
        assert_eq!(
            Save::from_body(&json!({ "name": "A", "items": { "cardId": "11" } }))
                .unwrap_err()
                .code(),
            Some("collection_item_invalid")
        );
    }

    // -- documents and ownership -------------------------------------------

    #[test]
    fn a_stored_document_round_trips_and_skips_broken_cards() {
        let source = document(
            "seller-1",
            "  Vault \u{0}  ",
            "2026-09-01T10:00:00",
            vec![
                stored_item("11", 2),
                json!({ "mapValue": { "fields": { "condition": { "stringValue": "NM" } } } }),
                stored_item("12", 1),
            ],
        );
        let collection = collection_from_document(&source);
        assert_eq!(collection.id, "c2026-09-01T10:00:00");
        assert_eq!(collection.name, "Vault");
        assert_eq!(collection.created_at, "2026-09-01T10:00:00.000Z");
        assert_eq!(collection.items.len(), 2, "the card with no id is skipped");
        assert_eq!(collection.items[0].quantity, 2);
        assert_eq!(collection.items[0].name, "Charizard");
        assert_eq!(collection.items[1].card_id, "12");
        assert_eq!(collection.key(), format!("collection:{}", collection.id));

        // What is written is what reads back as the same list.
        let data = doc_data("seller-1", "Vault", &collection.items, 1, 2);
        let keys: Vec<&String> = data.fields.keys().collect();
        assert_eq!(keys, ["uid", "name", "items", "createdAt", "updatedAt"]);
        let mut written_fields = Map::new();
        for (key, value) in &data.fields {
            if let FieldValue::Value(value) = value {
                written_fields.insert(key.clone(), value.to_json());
            }
        }
        let written = collection_from_document(&Document {
            name: source.name.clone(),
            create_time: None,
            update_time: None,
            fields: Some(written_fields),
        });
        assert_eq!(written.items, collection.items);
        assert_eq!(written.name, "Vault");
        assert!(
            !written.created_at.is_empty(),
            "the timestamps written by [`doc_data`] read back as timestamps"
        );
    }

    #[test]
    fn only_the_owner_reads_a_document() {
        let source = document("seller-1", "Vault", "2026-09-01T10:00:00", vec![]);
        assert!(owned_document(Some(&source), "seller-1").is_some());
        // Another seller's id and a deleted id are the same answer: no document.
        assert!(owned_document(Some(&source), "seller-2").is_none());
        assert!(owned_document(None, "seller-1").is_none());
        let missing = missing_error();
        assert_eq!(missing.status(), axum::http::StatusCode::NOT_FOUND);
        assert_eq!(missing.code(), Some("collection_not_found"));
        assert_eq!(
            missing.body(),
            json!({ "error": "Collection not found.", "code": "collection_not_found" })
        );
    }

    #[test]
    fn a_delete_body_names_its_list() {
        assert_eq!(
            delete_body_id(&json!({ "id": " Ab3_ " })).unwrap(),
            "Ab3_",
            "the id is cleaned the way every other text field is"
        );
        for body in [
            json!({}),
            json!({ "id": Json::Null }),
            json!({ "id": "   " }),
            json!({ "id": 42 }),
            json!({ "id": { "v": 1 } }),
        ] {
            let error = delete_body_id(&body).unwrap_err();
            assert_eq!(error.code(), Some("collection_not_found"), "{body}");
            assert_eq!(error.status(), axum::http::StatusCode::NOT_FOUND);
        }
    }

    #[test]
    fn limit_and_conflict_errors_carry_their_codes() {
        assert_eq!(limit_error().code(), Some("collection_limit"));
        assert_eq!(limit_error().status(), axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(
            name_taken_error().status(),
            axum::http::StatusCode::CONFLICT
        );
        assert_eq!(name_taken_error().code(), Some("collection_name_taken"));
        assert_eq!(items_shape_error().code(), Some("collection_item_invalid"));
        assert_eq!(items_limit_error().code(), Some("collection_items_limit"));
        assert_eq!(
            limits(),
            json!({ "collections": 20, "items": 300, "quantity": 999, "name": 40 })
        );
    }

    // -- the series ---------------------------------------------------------

    #[test]
    fn rows_keep_every_collection_in_its_own_range() {
        let collections = vec![
            collection("a", "First", "", vec![item("11"), item("12")]),
            collection("b", "Second", "", Vec::new()),
            collection(
                "c",
                "Third",
                "",
                vec![Item::from_input(&input("11", 3), 0).unwrap()],
            ),
        ];
        let rows = Rows::new(&collections);
        assert_eq!(rows.rows().len(), 3);
        assert_eq!(
            rows.keys(),
            vec!["collection:a", "collection:b", "collection:c"]
        );
        let sizes: Vec<usize> = rows.iter().map(|(_, item_rows)| item_rows.len()).collect();
        assert_eq!(sizes, vec![2, 0, 1]);
        assert_eq!(
            rows.iter().next().unwrap().1[0]
                .get("blueprint_id")
                .and_then(Json::as_str),
            Some(""),
            "an item starts unpriced"
        );
        assert_eq!(
            holding_slices(rows.iter().nth(2).unwrap().1)[0].qty,
            3,
            "the same card in two collections is two holdings"
        );
    }

    #[test]
    fn holdings_ignore_when_a_card_was_acquired() {
        // No `since` on a collection row, so the holding counts on the first day
        // of the series: that is the backtest.
        let collections = vec![collection(
            "a",
            "A",
            "",
            vec![Item::from_input(&input("11", 2), 0).unwrap()],
        )];
        let rows = resolved(&collections, &[("11", "500")]);
        let book = book_of(&[sold_row("11", "500", false, "2026-01-05", 10.0)]);
        let days = collection_days(&rows, &book, "2026-02-01");
        assert_eq!(days.len(), 28, "one entry per day of the sale history");
        assert_eq!(days[0]["date"], json!("2026-01-05"));
        assert_eq!(days[0]["segments"]["collection:a"], json!([20, 2, 2]));
        assert_eq!(days[27]["segments"]["collection:a"], json!([20, 2, 2]));
        assert_eq!(
            holding_slices(rows.iter().next().unwrap().1)[0].since,
            "",
            "nothing carries a start date"
        );
    }

    #[test]
    fn the_series_starts_at_the_earliest_sale_and_no_older() {
        let collections = vec![collection("a", "A", "", vec![item("11"), item("12")])];
        let rows = resolved(&collections, &[("11", "500"), ("12", "600")]);
        let today = "2026-10-08";
        let floor = add_utc_days(today, -(HISTORY_DAYS - 1));
        // 11 sold years ago, 12 recently: the graph spans the whole window.
        let book = book_of(&[
            sold_row("11", "500", false, "2020-01-01", 10.0),
            sold_row("12", "600", false, "2026-10-01", 5.0),
        ]);
        assert_eq!(series_start(&rows, &book, today), floor);
        let days = collection_days(&rows, &book, today);
        assert_eq!(days.len(), HISTORY_DAYS as usize);
        assert_eq!(days[0]["date"], json!(floor));
        assert_eq!(days.last().unwrap()["date"], json!(today));
        assert_eq!(
            days[0]["segments"]["collection:a"],
            json!([10, 1, 2]),
            "the window opens held and half-priced: the 2020 sale carries across \
             the whole window, the 2026-10-01 one has not happened yet"
        );
        assert_eq!(
            days.last().unwrap()["segments"]["collection:a"],
            json!([15, 2, 2])
        );

        // Nothing has ever sold: today alone, held and unpriced.
        let empty: Book = HashMap::new();
        assert_eq!(series_start(&rows, &empty, today), today);
        let days = collection_days(&rows, &empty, today);
        assert_eq!(
            days,
            vec![json!({ "date": today, "segments": { "collection:a": [0, 0, 2] } })]
        );
    }

    #[test]
    fn price_carries_forward_between_sales() {
        let collections = vec![collection("a", "A", "", vec![item("11")])];
        let rows = resolved(&collections, &[("11", "500")]);
        let book = book_of(&[
            sold_row("11", "500", false, "2026-10-01", 100.0),
            sold_row("11", "500", false, "2026-10-05", 140.0),
        ]);
        let days = collection_days(&rows, &book, "2026-10-07");
        let value_of = |date: &str| {
            days.iter()
                .find(|day| day["date"] == json!(date))
                .map(|day| day["segments"]["collection:a"].clone())
        };
        assert_eq!(days.first().unwrap()["date"], json!("2026-10-01"));
        assert_eq!(days.len(), 7);
        assert_eq!(value_of("2026-10-02"), Some(json!([100, 1, 1])));
        assert_eq!(
            value_of("2026-10-04"),
            Some(json!([100, 1, 1])),
            "carried forward"
        );
        assert_eq!(value_of("2026-10-05"), Some(json!([140, 1, 1])));
        assert_eq!(value_of("2026-10-07"), Some(json!([140, 1, 1])));
        assert_eq!(last_day(&days, "2026-10-09"), "2026-10-07");
        assert_eq!(last_day(&[], "2026-10-09"), "2026-10-09");
    }

    #[test]
    fn facets_price_apart_and_an_empty_list_keeps_its_def() {
        let collections = vec![
            collection(
                "raw",
                "Raw",
                "",
                vec![Item::from_input(&input("11", 2), 0).unwrap()],
            ),
            collection(
                "slab",
                "Slabs",
                "",
                vec![Item::from_input(
                    &json!({ "cardId": "11", "graded": true, "quantity": 1 }),
                    0,
                )
                .unwrap()],
            ),
            collection("wish", "Wishlist", "", Vec::new()),
        ];
        let rows = resolved(&collections, &[("11", "500")]);
        let book = book_of(&[sold_row("11", "500", false, "2026-10-02", 50.0)]);
        let days = collection_days(&rows, &book, "2026-10-03");
        assert_eq!(days[0]["segments"]["collection:raw"], json!([100, 2, 2]));
        assert_eq!(
            days[0]["segments"]["collection:slab"],
            json!([0, 0, 1]),
            "the graded slice is held and unpriced beside the raw one"
        );
        assert_eq!(
            days[0]["segments"].get("collection:wish"),
            None,
            "an empty collection holds nothing"
        );
        assert_eq!(
            collection_defs(&collections),
            vec![
                json!({ "key": "collection:raw", "group": "collection", "label": "Raw" }),
                json!({ "key": "collection:slab", "group": "collection", "label": "Slabs" }),
                json!({ "key": "collection:wish", "group": "collection", "label": "Wishlist" }),
            ],
            "a def for every collection, in creation order"
        );
        assert_eq!(iso_or_null(""), Json::Null);
    }

    #[test]
    fn a_never_sold_card_is_held_and_not_priced() {
        let collections = vec![collection("a", "A", "", vec![item("11"), item("13")])];
        let rows = resolved(&collections, &[("11", "500")]);
        // 13 has a blueprint but no sale of its own; both are held.
        let book = book_of(&[sold_row("11", "500", false, "2026-10-04", 30.0)]);
        let days = collection_days(&rows, &book, "2026-10-06");
        assert_eq!(days[0]["segments"]["collection:a"], json!([30, 1, 2]));
        let answered = collections_json(&collections, &rows, &book, "2026-10-06");
        assert_eq!(answered[0]["items"][0]["pricePkn"], json!(30));
        assert_eq!(
            answered[0]["items"][1]["pricePkn"],
            json!(null),
            "a card that never sold answers unpriced, not zero"
        );
    }

    #[test]
    fn an_unresolved_game_card_holds_without_pricing() {
        // A card of another game whose own database failed: its blueprint is
        // cleared, so a Pokémon sold price of the same public id cannot reach it.
        let foreign = Item::from_input(&json!({ "cardId": "11", "game": "riftbound" }), 0).unwrap();
        let collections = vec![collection("a", "A", "", vec![foreign, item("11")])];
        let mut rows = Rows::new(&collections);
        for row in rows.rows_mut() {
            let pokemon = row.get("game").and_then(Json::as_str) == Some(POKEMON);
            set_blueprint(row, if pokemon { "500" } else { "" });
        }
        let book = book_of(&[sold_row("11", "500", false, "2026-10-04", 30.0)]);
        let days = collection_days(&rows, &book, "2026-10-05");
        assert_eq!(
            days[0]["segments"]["collection:a"],
            json!([30, 1, 2]),
            "the Riftbound card is held and unpriced beside the Pokémon one"
        );
        let answered = collections_json(&collections, &rows, &book, "2026-10-05");
        assert_eq!(
            answered[0]["items"][0]["pricePkn"],
            json!(null),
            "and it answers unpriced too, not at the Pokémon price"
        );
    }

    #[test]
    fn the_answer_body_keeps_the_contract_key_order() {
        let collections = vec![collection(
            "a",
            "A",
            "2026-09-01T00:00:00.000Z",
            vec![item("11")],
        )];
        let rows = resolved(&collections, &[("11", "500")]);
        let book = book_of(&[sold_row("11", "500", false, "2026-10-02", 61.5)]);
        let days = collection_days(&rows, &book, "2026-10-03");
        let body = answer_body(
            &collections,
            &rows,
            &book,
            &days,
            &last_day(&days, "2026-10-03"),
            Some("a"),
        );
        let keys: Vec<&String> = body.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "priceBasis",
                "limits",
                "saved",
                "collections",
                "segmentDefs",
                "days"
            ]
        );
        assert_eq!(body["priceBasis"], json!("ct-last-sold"));
        assert_eq!(body["saved"], json!("a"));
        assert_eq!(body["days"], json!(days));
        assert_eq!(body["collections"][0]["items"][0]["pricePkn"], json!(61.5));
        assert_eq!(
            body["collections"][0]["createdAt"],
            json!("2026-09-01T00:00:00.000Z")
        );
        assert_eq!(body["segmentDefs"][0]["key"], json!("collection:a"));

        // A document written without a timestamp answers null, not "".
        let undated = vec![collection("a", "A", "", vec![item("11")])];
        let undated_rows = Rows::new(&undated);
        let body = answer_body(
            &undated,
            &undated_rows,
            &HashMap::new(),
            &[],
            "2026-10-03",
            None,
        );
        assert_eq!(body["collections"][0]["createdAt"], Json::Null);
        assert_eq!(body["collections"][0]["updatedAt"], Json::Null);
        assert_eq!(body["collections"][0]["items"][0]["pricePkn"], Json::Null);

        // A read has no `saved`.
        let read = answer_body(&collections, &rows, &book, &days, "2026-10-03", None);
        let keys: Vec<&String> = read.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            ["priceBasis", "limits", "collections", "segmentDefs", "days"]
        );
    }

    #[test]
    fn no_collection_answers_an_empty_graph() {
        let rows = Rows::new(&[]);
        let book: Book = HashMap::new();
        assert_eq!(
            collection_days(&rows, &book, "2026-10-08"),
            Vec::<Json>::new()
        );
        assert_eq!(rows.keys(), Vec::<String>::new());
        assert_eq!(
            collections_json(&[], &rows, &book, "2026-10-08"),
            Vec::<Json>::new(),
            "a read of no collections answers no lists"
        );
        assert_eq!(collection_defs(&[]), Vec::<Json>::new());
        let body = answer_body(&[], &rows, &book, &[], "2026-10-08", None);
        assert_eq!(body["days"], json!([]));
        assert_eq!(body["collections"], json!([]));
    }
}
