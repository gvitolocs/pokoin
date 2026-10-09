//! Poko personal marketplace context — a port of `_poko_personal_context.js`.
//!
//! Builds a compact personal snapshot for Poko intent: recents, inventory
//! listings, the collection summary and the synced cart/watchlist/desk. The
//! client may overlay fresh cart/watchlist/desk on a `sync` turn, which is then
//! persisted into `public.poko_user_personal_snapshot`.
//!
//! Every SQL read tolerates a missing relation (`42P01`) or column (`42703`) by
//! returning an empty section, exactly like Node, so a pre-migration Pi cannot
//! break the assistant.

use serde_json::{json, Map, Value as Json};

use crate::error::{ApiError, Result};
use crate::firestore::Firestore;
use crate::sql::{row_i64, row_text, MarketplaceDb, SqlParam};

pub const RECENT_LIMIT: usize = 12;
pub const WATCH_LIMIT: usize = 24;
pub const CART_LIMIT: usize = 24;
pub const INVENTORY_SAMPLE: i64 = 12;
pub const NAME_HYDRATE_LIMIT: usize = 40;

/// `cleanText(value, max)`.
pub fn clean_text(value: &str, max: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// `parseCardId`: a positive integer, or `None`.
pub fn parse_card_id(value: &Json) -> Option<i64> {
    let number = match value {
        Json::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.fract() == 0.0)
                .map(|value| value as i64)
        }),
        Json::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }?;
    if number <= 0 {
        None
    } else {
        Some(number)
    }
}

/// `normalizeCardIds(values, limit)` — positive, de-duplicated, capped.
pub fn normalize_card_ids(values: &[Json], limit: usize) -> Vec<i64> {
    let mut out: Vec<i64> = Vec::new();
    for value in values {
        let Some(id) = parse_card_id(value) else {
            continue;
        };
        if out.contains(&id) {
            continue;
        }
        out.push(id);
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn first_present<'a>(row: &'a Json, keys: &[&str]) -> Option<&'a Json> {
    keys.iter().find_map(|key| row.get(*key))
}

/// `cleanCartItems(raw)` — the public cart lines.
pub fn clean_cart_items(raw: Option<&Json>) -> Vec<Json> {
    let Some(list) = raw.and_then(Json::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in list.iter().take(CART_LIMIT) {
        let card_id = first_present(
            row,
            &["cardId", "card_id"],
        )
        .or_else(|| row.get("card").and_then(|card| card.get("id")))
        .and_then(parse_card_id);
        let qty = row
            .get("qty")
            .and_then(Json::as_f64)
            .map(|value| value.trunc() as i64)
            .unwrap_or(0)
            .clamp(0, 99);
        let price_pkn = first_present(row, &["pricePkn", "price_pkn"])
            .and_then(Json::as_f64)
            .map(|value| value.trunc() as i64)
            .unwrap_or(0)
            .max(0);
        let Some(card_id) = card_id else {
            continue;
        };
        if qty < 1 {
            continue;
        }
        let name = {
            let cleaned = first_present(row, &["name", "cardName"])
                .or_else(|| row.get("card").and_then(|card| card.get("name")))
                .and_then(Json::as_str)
                .map(|value| clean_text(value, 120))
                .unwrap_or_default();
            if cleaned.is_empty() {
                format!("card {card_id}")
            } else {
                cleaned
            }
        };
        out.push(json!({
            "cardId": card_id.to_string(),
            "name": name,
            "qty": qty,
            "pricePkn": price_pkn,
            "sellerName": first_present(row, &["sellerName", "seller_name"])
                .and_then(Json::as_str)
                .map(|value| clean_text(value, 80))
                .unwrap_or_default(),
            "condition": row.get("condition").and_then(Json::as_str)
                .map(|value| clean_text(value, 20)).unwrap_or_default(),
            "language": row.get("language").and_then(Json::as_str)
                .map(|value| clean_text(value, 12)).unwrap_or_default(),
        }));
    }
    out
}

/// `cleanDesk(raw)` — the open card desk, or `None`.
pub fn clean_desk(raw: Option<&Json>) -> Option<Json> {
    let raw = raw?;
    if !raw.is_object() {
        return None;
    }
    let card_id = first_present(raw, &["cardId", "deskCardId", "desk_card_id"])
        .and_then(parse_card_id);
    let name = first_present(raw, &["name", "deskCardName", "desk_card_name"])
        .and_then(Json::as_str)
        .map(|value| clean_text(value, 120))
        .unwrap_or_default();
    let set_name = first_present(raw, &["setName", "deskSetName", "desk_set_name"])
        .and_then(Json::as_str)
        .map(|value| clean_text(value, 120))
        .unwrap_or_default();
    if card_id.is_none() && name.is_empty() {
        return None;
    }
    Some(json!({
        "cardId": card_id.map(|id| id.to_string()).unwrap_or_default(),
        "name": name,
        "setName": set_name,
    }))
}

/// `labelCards(ids, labels)` — hydrate each id, falling back to an empty label.
pub fn label_cards(ids: &[i64], labels: &Map<String, Json>) -> Vec<Json> {
    normalize_card_ids(
        &ids.iter().map(|id| json!(id)).collect::<Vec<_>>(),
        NAME_HYDRATE_LIMIT,
    )
    .into_iter()
    .map(|id| {
        labels
            .get(&id.to_string())
            .cloned()
            .unwrap_or_else(|| json!({ "cardId": id.to_string(), "name": "", "setName": "" }))
    })
    .collect()
}

fn is_tolerated(error: &crate::sql::SqlError) -> bool {
    error.undefined_table() || error.code.as_deref() == Some("42703")
}

/// `hydrateCardLabels(query, ids)`.
async fn hydrate_card_labels(db: &MarketplaceDb, ids: &[i64]) -> Map<String, Json> {
    let wanted = normalize_card_ids(
        &ids.iter().map(|id| json!(id)).collect::<Vec<_>>(),
        NAME_HYDRATE_LIMIT,
    );
    let mut map = Map::new();
    if wanted.is_empty() {
        return map;
    }
    match db
        .query_json(
            "select card_id::text as id, name, set_name from marketplace_search_candidates \
             where card_id = any($1::bigint[])",
            &[SqlParam::IntArray(wanted)],
        )
        .await
    {
        Ok(rows) => {
            for row in rows {
                let id = row_text(&row, "id");
                map.insert(
                    id.clone(),
                    json!({
                        "cardId": id,
                        "name": clean_text(&row_text(&row, "name"), 120),
                        "setName": clean_text(&row_text(&row, "set_name"), 120),
                    }),
                );
            }
        }
        Err(error) => {
            if !is_tolerated(&error) {
                tracing::error!(%error, "card label hydration failed");
            }
        }
    }
    map
}

async fn read_recents(db: &MarketplaceDb, uid: &str) -> Vec<i64> {
    match db
        .query_json(
            "select card_ids from public.marketplace_user_recents \
             where user_uid = $1 and game = 'pokemon' limit 1",
            &[SqlParam::Text(uid.to_string())],
        )
        .await
    {
        Ok(rows) => rows
            .first()
            .and_then(|row| row.get("card_ids"))
            .and_then(Json::as_array)
            .map(|values| normalize_card_ids(values, RECENT_LIMIT))
            .unwrap_or_default(),
        Err(error) => {
            if !is_tolerated(&error) {
                tracing::error!(%error, "recents read failed");
            }
            Vec::new()
        }
    }
}

async fn read_inventory(db: &MarketplaceDb, uid: &str) -> Json {
    let empty = json!({ "listingCount": 0, "quantity": 0, "samples": [] });
    let summary = db
        .query_json(
            "select count(*)::int as listing_count, \
                    coalesce(sum(quantity_available), 0)::int as quantity \
               from public.marketplace_user_listings \
              where seller_uid = $1 and status in ('active','paused') \
                and quantity_available > 0",
            &[SqlParam::Text(uid.to_string())],
        )
        .await;
    let summary = match summary {
        Ok(rows) => rows,
        Err(error) => {
            if !is_tolerated(&error) {
                tracing::error!(%error, "inventory summary read failed");
            }
            return empty;
        }
    };
    let samples = db
        .query_json(
            "select card_id::text as card_id, card_name, set_name, quantity_available, \
                    price_pkn, condition, language, status \
               from public.marketplace_user_listings \
              where seller_uid = $1 and status in ('active','paused') \
                and quantity_available > 0 \
              order by updated_at desc nulls last, created_at desc nulls last \
              limit $2",
            &[SqlParam::Text(uid.to_string()), SqlParam::Int(INVENTORY_SAMPLE)],
        )
        .await
        .unwrap_or_default();

    let row = summary.first().cloned().unwrap_or(Json::Null);
    json!({
        "listingCount": row_i64(&row, "listing_count"),
        "quantity": row_i64(&row, "quantity"),
        "samples": samples
            .iter()
            .map(|item| json!({
                "cardId": clean_text(&row_text(item, "card_id"), 40),
                "name": clean_text(&row_text(item, "card_name"), 120),
                "setName": clean_text(&row_text(item, "set_name"), 120),
                "qty": row_i64(item, "quantity_available"),
                "pricePkn": item.get("price_pkn").and_then(Json::as_f64).unwrap_or(0.0),
                "condition": clean_text(&row_text(item, "condition"), 20),
                "language": clean_text(&row_text(item, "language"), 12),
                "status": clean_text(&row_text(item, "status"), 20),
            }))
            .collect::<Vec<_>>(),
    })
}

/// `readCollectionSummary` — the Firestore ownership totals.
async fn read_collection_summary(firestore: Option<&Firestore>, uid: &str) -> Json {
    let empty = json!({ "cardsOwned": 0, "items": 0, "physicalOwned": 0, "nftOwned": 0 });
    let Some(firestore) = firestore else {
        return empty;
    };
    match crate::domain::collection::summarize_owned_collection(firestore, uid).await {
        Ok(summary) => json!({
            "cardsOwned": summary.cards_owned,
            "items": summary.item_count,
            "physicalOwned": summary.physical_owned,
            "nftOwned": summary.nft_owned,
        }),
        Err(error) => {
            tracing::warn!(%error, "poko personal collection summary failed");
            empty
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
    pub watchlist_ids: Vec<i64>,
    pub cart: Vec<Json>,
    pub desk: Option<Json>,
    pub updated_at: Option<Json>,
}

async fn read_snapshot(db: &MarketplaceDb, uid: &str) -> Snapshot {
    let rows = match db
        .query_json(
            "select watchlist_card_ids, cart_items, desk_card_id, desk_card_name, \
                    desk_set_name, updated_at \
               from public.poko_user_personal_snapshot \
              where firebase_uid = $1 limit 1",
            &[SqlParam::Text(uid.to_string())],
        )
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            if !is_tolerated(&error) {
                tracing::error!(%error, "personal snapshot read failed");
            }
            return Snapshot::default();
        }
    };
    let Some(row) = rows.first() else {
        return Snapshot::default();
    };
    Snapshot {
        watchlist_ids: row
            .get("watchlist_card_ids")
            .and_then(Json::as_array)
            .map(|values| normalize_card_ids(values, WATCH_LIMIT))
            .unwrap_or_default(),
        cart: clean_cart_items(row.get("cart_items")),
        desk: clean_desk(Some(&json!({
            "cardId": row.get("desk_card_id").cloned().unwrap_or(Json::Null),
            "name": row.get("desk_card_name").cloned().unwrap_or(Json::Null),
            "setName": row.get("desk_set_name").cloned().unwrap_or(Json::Null),
        }))),
        updated_at: row.get("updated_at").cloned(),
    }
}

/// `writeSnapshot(writeQuery, uid, {watchlistIds, cart, desk})`.
async fn write_snapshot(
    db: &MarketplaceDb,
    uid: &str,
    watchlist_ids: &[i64],
    cart: &[Json],
    desk: Option<&Json>,
) -> Result<()> {
    let desk_card_id = desk
        .and_then(|desk| desk.get("cardId"))
        .and_then(parse_card_id);
    let desk_name = desk
        .and_then(|desk| desk.get("name"))
        .and_then(Json::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let desk_set_name = desk
        .and_then(|desk| desk.get("setName"))
        .and_then(Json::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    db.query_json(
        "insert into public.poko_user_personal_snapshot \
           (firebase_uid, watchlist_card_ids, cart_items, desk_card_id, desk_card_name, \
            desk_set_name, updated_at) \
         values ($1, $2::bigint[], $3::jsonb, $4, $5, $6, now()) \
         on conflict (firebase_uid) do update set \
           watchlist_card_ids = excluded.watchlist_card_ids, \
           cart_items = excluded.cart_items, \
           desk_card_id = excluded.desk_card_id, \
           desk_card_name = excluded.desk_card_name, \
           desk_set_name = excluded.desk_set_name, \
           updated_at = now()",
        &[
            SqlParam::Text(uid.to_string()),
            SqlParam::IntArray(watchlist_ids.to_vec()),
            SqlParam::Json(Json::Array(cart.to_vec())),
            SqlParam::OptInt(desk_card_id),
            SqlParam::OptText(desk_name),
            SqlParam::OptText(desk_set_name),
        ],
    )
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Default)]
pub struct Overlay {
    pub watchlist_ids: Option<Vec<i64>>,
    pub cart: Option<Vec<Json>>,
    pub desk: Option<Json>,
}

/// `overlayFromBody(body)` — which client facts this turn carries.
pub fn overlay_from_body(body: &Json) -> Overlay {
    let watchlist = if body.get("watchlistIds").map(|v| !v.is_null()).unwrap_or(false)
        || body.get("watchlist").map(|v| !v.is_null()).unwrap_or(false)
    {
        let source = body
            .get("watchlistIds")
            .filter(|value| !value.is_null())
            .or_else(|| body.get("watchlist"))
            .and_then(Json::as_array)
            .cloned()
            .unwrap_or_default();
        Some(normalize_card_ids(&source, WATCH_LIMIT))
    } else {
        None
    };
    let cart = body
        .get("cart")
        .filter(|value| !value.is_null())
        .map(|value| clean_cart_items(Some(value)));
    let desk = if body.get("desk").map(|v| !v.is_null()).unwrap_or(false)
        || body.get("deskCardId").map(|v| !v.is_null()).unwrap_or(false)
        || body.get("pageContext").map(|v| !v.is_null()).unwrap_or(false)
    {
        let source = body
            .get("desk")
            .filter(|value| !value.is_null())
            .or_else(|| body.get("pageContext").filter(|value| !value.is_null()))
            .cloned()
            .unwrap_or_else(|| body.clone());
        clean_desk(Some(&source))
    } else {
        None
    };
    Overlay {
        watchlist_ids: watchlist,
        cart,
        desk,
    }
}

/// `buildPersonalContext(...)`.
pub async fn build_personal_context(
    db: &MarketplaceDb,
    firestore: Option<&Firestore>,
    uid: &str,
    overlay: &Overlay,
    persist_overlay: bool,
) -> Result<Json> {
    let user_id = clean_text(uid, 160);
    if user_id.is_empty() {
        return Err(ApiError::unauthorized("Missing Pokoin user."));
    }

    let stored = read_snapshot(db, &user_id).await;
    let watchlist_ids = overlay
        .watchlist_ids
        .clone()
        .unwrap_or_else(|| stored.watchlist_ids.clone());
    let cart = overlay
        .cart
        .clone()
        .unwrap_or_else(|| stored.cart.clone());
    let desk = overlay.desk.clone().or_else(|| stored.desk.clone());

    if persist_overlay
        && (overlay.watchlist_ids.is_some() || overlay.cart.is_some() || overlay.desk.is_some())
    {
        // A missing snapshot table (pre-migration) must not fail the turn.
        if let Err(error) = write_snapshot(db, &user_id, &watchlist_ids, &cart, desk.as_ref()).await
        {
            let tolerated = error
                .message()
                .contains("does not exist")
                || error.message().contains("42P01");
            if !tolerated {
                return Err(error);
            }
        }
    }

    let (recent_ids, inventory, collection) = tokio::join!(
        read_recents(db, &user_id),
        read_inventory(db, &user_id),
        read_collection_summary(firestore, &user_id),
    );

    let mut label_ids: Vec<i64> = recent_ids.clone();
    label_ids.extend(watchlist_ids.iter().copied());
    label_ids.extend(
        cart.iter()
            .filter_map(|row| row.get("cardId").and_then(parse_card_id)),
    );
    if let Some(card_id) = desk.as_ref().and_then(|desk| desk.get("cardId")).and_then(parse_card_id)
    {
        label_ids.push(card_id);
    }
    let labels = hydrate_card_labels(db, &label_ids).await;

    let cart_labeled: Vec<Json> = cart
        .iter()
        .map(|row| {
            let card_id = row
                .get("cardId")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string();
            let hit = labels.get(&card_id);
            let own_name = row.get("name").and_then(Json::as_str).unwrap_or("");
            let name = if !own_name.is_empty() {
                own_name.to_string()
            } else {
                hit.and_then(|hit| hit.get("name"))
                    .and_then(Json::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("card {card_id}"))
            };
            let set_name = hit
                .and_then(|hit| hit.get("setName"))
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string();
            let mut out = row.clone();
            if let Some(object) = out.as_object_mut() {
                object.insert("name".into(), json!(name));
                object.insert("setName".into(), json!(set_name));
            }
            out
        })
        .collect();

    let mut desk_out = desk.clone();
    if let Some(desk) = desk_out.clone() {
        let card_id = desk.get("cardId").and_then(Json::as_str).unwrap_or("");
        let name = desk.get("name").and_then(Json::as_str).unwrap_or("");
        let set_name = desk.get("setName").and_then(Json::as_str).unwrap_or("");
        if !card_id.is_empty() && (name.is_empty() || set_name.is_empty()) {
            if let Some(hit) = labels.get(card_id) {
                desk_out = Some(json!({
                    "cardId": card_id,
                    "name": if name.is_empty() {
                        hit.get("name").and_then(Json::as_str).unwrap_or("")
                    } else {
                        name
                    },
                    "setName": if set_name.is_empty() {
                        hit.get("setName").and_then(Json::as_str).unwrap_or("")
                    } else {
                        set_name
                    },
                }));
            }
        }
    }

    Ok(json!({
        "desk": desk_out,
        "recents": label_cards(&recent_ids, &labels),
        "watchlist": label_cards(&watchlist_ids, &labels),
        "cart": cart_labeled,
        "inventory": inventory,
        "collection": collection,
        "syncedAt": stored.updated_at,
    }))
}

/// `formatPersonalIntent(personal)` — the compact planner block.
pub fn format_personal_intent(personal: &Json) -> String {
    if !personal.is_object() {
        return String::new();
    }
    let mut lines: Vec<String> = vec![
        "Personal marketplace context (verified Pokoin account — personalize; never invent ownership):".to_string(),
    ];
    let desk = personal.get("desk").filter(|value| !value.is_null());
    if let Some(desk) = desk {
        let card_id = desk.get("cardId").and_then(Json::as_str).unwrap_or("");
        let name = desk.get("name").and_then(Json::as_str).unwrap_or("");
        if !card_id.is_empty() || !name.is_empty() {
            let set_name = desk.get("setName").and_then(Json::as_str).unwrap_or("");
            let mut bits: Vec<String> = Vec::new();
            bits.push(if name.is_empty() { "card".to_string() } else { name.to_string() });
            if !set_name.is_empty() {
                bits.push(format!("({set_name})"));
            }
            if !card_id.is_empty() {
                bits.push(format!("cardId={card_id}"));
            }
            lines.push(format!("- Open desk: {}", bits.join(" ")));
        }
    }
    let array_of = |key: &str| -> Vec<Json> {
        personal
            .get(key)
            .and_then(Json::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let recents = array_of("recents");
    if !recents.is_empty() {
        let rendered = recents
            .iter()
            .take(8)
            .map(|row| {
                let name = row.get("name").and_then(Json::as_str).unwrap_or("");
                let set_name = row.get("setName").and_then(Json::as_str).unwrap_or("");
                let card_id = row.get("cardId").and_then(Json::as_str).unwrap_or("");
                if !name.is_empty() {
                    if set_name.is_empty() {
                        format!("{name}#{card_id}")
                    } else {
                        format!("{name} [{set_name}]#{card_id}")
                    }
                } else {
                    format!("#{card_id}")
                }
            })
            .collect::<Vec<_>>()
            .join("; ");
        lines.push(format!("- Recently seen ({}): {rendered}", recents.len()));
    }
    let watchlist = array_of("watchlist");
    if !watchlist.is_empty() {
        let rendered = watchlist
            .iter()
            .take(8)
            .map(|row| {
                let name = row.get("name").and_then(Json::as_str).unwrap_or("");
                let card_id = row.get("cardId").and_then(Json::as_str).unwrap_or("");
                if name.is_empty() {
                    format!("#{card_id}")
                } else {
                    format!("{name}#{card_id}")
                }
            })
            .collect::<Vec<_>>()
            .join("; ");
        lines.push(format!("- Watchlist ({}): {rendered}", watchlist.len()));
    }
    let cart = array_of("cart");
    if !cart.is_empty() {
        let total: i64 = cart
            .iter()
            .map(|row| {
                row.get("pricePkn").and_then(Json::as_i64).unwrap_or(0)
                    * row.get("qty").and_then(Json::as_i64).unwrap_or(0)
            })
            .sum();
        let rendered = cart
            .iter()
            .take(8)
            .map(|row| {
                let name = row
                    .get("name")
                    .and_then(Json::as_str)
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| {
                        row.get("cardId").and_then(Json::as_str).unwrap_or("")
                    });
                let qty = row.get("qty").and_then(Json::as_i64).unwrap_or(0);
                let price = row.get("pricePkn").and_then(Json::as_i64).unwrap_or(0);
                if price != 0 {
                    format!("{name}×{qty}@{price}")
                } else {
                    format!("{name}×{qty}")
                }
            })
            .collect::<Vec<_>>()
            .join("; ");
        lines.push(format!("- Cart ({} lines, ~{total} PKN): {rendered}", cart.len()));
    }
    let inventory = personal.get("inventory").filter(|value| !value.is_null());
    if let Some(inventory) = inventory {
        let listing_count = inventory
            .get("listingCount")
            .and_then(Json::as_i64)
            .unwrap_or(0);
        let quantity = inventory.get("quantity").and_then(Json::as_i64).unwrap_or(0);
        if listing_count > 0 || quantity > 0 {
            let samples = inventory
                .get("samples")
                .and_then(Json::as_array)
                .map(|samples| {
                    samples
                        .iter()
                        .take(6)
                        .map(|row| {
                            let name = row
                                .get("name")
                                .and_then(Json::as_str)
                                .filter(|value| !value.is_empty())
                                .unwrap_or_else(|| {
                                    row.get("cardId").and_then(Json::as_str).unwrap_or("")
                                });
                            let qty = row.get("qty").and_then(Json::as_i64).unwrap_or(0);
                            let price = row.get("pricePkn").and_then(Json::as_i64).unwrap_or(0);
                            if price != 0 {
                                format!("{name}×{qty}@{price}PKN")
                            } else {
                                format!("{name}×{qty}")
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .unwrap_or_default();
            lines.push(format!(
                "- Selling inventory: {listing_count} listings / {quantity} qty{}",
                if samples.is_empty() {
                    String::new()
                } else {
                    format!(" — {samples}")
                }
            ));
        }
    }
    let collection = personal.get("collection").filter(|value| !value.is_null());
    if let Some(collection) = collection {
        let cards_owned = collection
            .get("cardsOwned")
            .and_then(Json::as_i64)
            .unwrap_or(0);
        let items = collection.get("items").and_then(Json::as_i64).unwrap_or(0);
        if cards_owned > 0 || items > 0 {
            let physical = collection
                .get("physicalOwned")
                .and_then(Json::as_i64)
                .unwrap_or(0);
            let nft = collection
                .get("nftOwned")
                .and_then(Json::as_i64)
                .unwrap_or(0);
            lines.push(format!(
                "- Collection: {cards_owned} cards owned ({physical} physical, {nft} NFT)"
            ));
        }
    }
    if lines.len() == 1 {
        return String::new();
    }
    lines.push(
        "- Prefer these facts when the user says \"my cart\", \"my watchlist\", \"what I was looking at\", or \"my stock\"."
            .to_string(),
    );
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_ids_must_be_positive_integers() {
        assert_eq!(parse_card_id(&json!(7)), Some(7));
        assert_eq!(parse_card_id(&json!(" 8 ")), Some(8));
        assert_eq!(parse_card_id(&json!(9.0)), Some(9));
        assert_eq!(parse_card_id(&json!(0)), None);
        assert_eq!(parse_card_id(&json!(-1)), None);
        assert_eq!(parse_card_id(&json!(1.5)), None);
        assert_eq!(parse_card_id(&json!("abc")), None);
        assert_eq!(parse_card_id(&Json::Null), None);
    }

    #[test]
    fn card_id_lists_are_deduped_and_capped() {
        let values = vec![json!(1), json!("1"), json!(2), json!(0), json!(3)];
        assert_eq!(normalize_card_ids(&values, 24), vec![1, 2, 3]);
        assert_eq!(normalize_card_ids(&values, 2), vec![1, 2]);
        assert!(normalize_card_ids(&[], 24).is_empty());
    }

    #[test]
    fn cart_items_are_cleaned_and_dropped_when_unusable() {
        let raw = json!([
            { "cardId": 5, "name": "  Pikachu  ", "qty": 2, "pricePkn": 12.7,
              "sellerName": "ash", "condition": "NM", "language": "EN" },
            { "card_id": "6", "card": { "name": "Eevee" }, "qty": 0 },
            { "qty": 3 },
            { "cardId": 7, "qty": 200, "pricePkn": -4 }
        ]);
        let items = clean_cart_items(Some(&raw));
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["cardId"], json!("5"));
        assert_eq!(items[0]["name"], json!("Pikachu"));
        assert_eq!(items[0]["qty"], json!(2));
        assert_eq!(items[0]["pricePkn"], json!(12));
        assert_eq!(items[0]["sellerName"], json!("ash"));
        // qty 0 and a missing card id are dropped; qty caps at 99 and price at 0.
        assert_eq!(items[1]["cardId"], json!("7"));
        assert_eq!(items[1]["qty"], json!(99));
        assert_eq!(items[1]["pricePkn"], json!(0));
        assert_eq!(items[1]["name"], json!("card 7"));
        assert!(clean_cart_items(None).is_empty());
    }

    #[test]
    fn at_most_twenty_four_cart_lines_are_kept() {
        let raw = Json::Array(
            (0..40)
                .map(|index| json!({ "cardId": index + 1, "qty": 1 }))
                .collect(),
        );
        assert_eq!(clean_cart_items(Some(&raw)).len(), CART_LIMIT);
    }

    #[test]
    fn desk_requires_an_id_or_a_name() {
        let desk = clean_desk(Some(&json!({ "cardId": 9, "name": "Pikachu", "setName": "Base" })))
            .unwrap();
        assert_eq!(desk["cardId"], json!("9"));
        assert_eq!(desk["name"], json!("Pikachu"));
        assert_eq!(desk["setName"], json!("Base"));
        // A name-only desk has an empty card id.
        let desk = clean_desk(Some(&json!({ "deskCardName": "Eevee" }))).unwrap();
        assert_eq!(desk["cardId"], json!(""));
        assert_eq!(desk["name"], json!("Eevee"));
        assert!(clean_desk(Some(&json!({}))).is_none());
        assert!(clean_desk(Some(&json!({ "cardId": 0 }))).is_none());
        assert!(clean_desk(None).is_none());
        assert!(clean_desk(Some(&json!("string"))).is_none());
    }

    #[test]
    fn overlay_detection_matches_overlay_from_body() {
        // No cart/watchlist/desk keys: every overlay is absent.
        let overlay = overlay_from_body(&json!({ "action": "get" }));
        assert!(overlay.watchlist_ids.is_none());
        assert!(overlay.cart.is_none());
        assert!(overlay.desk.is_none());

        // watchlist alias, cart and desk are all detected.
        let overlay = overlay_from_body(&json!({
            "watchlist": [1, 2],
            "cart": [ { "cardId": 3, "qty": 1 } ],
            "deskCardId": 4
        }));
        assert_eq!(overlay.watchlist_ids, Some(vec![1, 2]));
        assert_eq!(overlay.cart.as_ref().unwrap().len(), 1);
        assert_eq!(overlay.desk.as_ref().unwrap()["cardId"], json!("4"));

        // An explicit empty cart is an overlay that clears the cart.
        let overlay = overlay_from_body(&json!({ "cart": [] }));
        assert_eq!(overlay.cart, Some(Vec::new()));
        // An explicit null is not an overlay at all.
        let overlay = overlay_from_body(&json!({ "cart": Json::Null }));
        assert!(overlay.cart.is_none());
    }

    #[test]
    fn labels_fall_back_to_an_empty_card() {
        let mut labels = Map::new();
        labels.insert(
            "1".to_string(),
            json!({ "cardId": "1", "name": "Pikachu", "setName": "Base" }),
        );
        let labelled = label_cards(&[1, 2], &labels);
        assert_eq!(labelled.len(), 2);
        assert_eq!(labelled[0]["name"], json!("Pikachu"));
        assert_eq!(labelled[1]["name"], json!(""));
        assert_eq!(labelled[1]["cardId"], json!("2"));
        // The hydrate limit caps the list.
        let many: Vec<i64> = (1..=60).collect();
        assert_eq!(label_cards(&many, &labels).len(), NAME_HYDRATE_LIMIT);
    }

    #[test]
    fn intent_is_empty_without_facts() {
        assert_eq!(format_personal_intent(&json!({})), "");
        assert_eq!(
            format_personal_intent(&json!({
                "desk": Json::Null, "recents": [], "watchlist": [], "cart": [],
                "inventory": { "listingCount": 0, "quantity": 0, "samples": [] },
                "collection": { "cardsOwned": 0, "items": 0 }
            })),
            ""
        );
        assert_eq!(format_personal_intent(&Json::Null), "");
    }

    #[test]
    fn intent_renders_every_section() {
        let personal = json!({
            "desk": { "cardId": "9", "name": "Pikachu", "setName": "Base" },
            "recents": [
                { "cardId": "1", "name": "Eevee", "setName": "Jungle" },
                { "cardId": "2", "name": "", "setName": "" }
            ],
            "watchlist": [ { "cardId": "3", "name": "Mew", "setName": "" } ],
            "cart": [ { "cardId": "4", "name": "Snorlax", "qty": 2, "pricePkn": 5 } ],
            "inventory": { "listingCount": 3, "quantity": 7, "samples": [
                { "cardId": "5", "name": "Psyduck", "qty": 1, "pricePkn": 4 } ] },
            "collection": { "cardsOwned": 10, "items": 4, "physicalOwned": 6, "nftOwned": 4 }
        });
        let text = format_personal_intent(&personal);
        assert!(text.starts_with("Personal marketplace context (verified Pokoin account"));
        assert!(text.contains("- Open desk: Pikachu (Base) cardId=9"));
        assert!(text.contains("- Recently seen (2): Eevee [Jungle]#1; #2"));
        assert!(text.contains("- Watchlist (1): Mew#3"));
        assert!(text.contains("- Cart (1 lines, ~10 PKN): Snorlax×2@5"));
        assert!(text.contains("- Selling inventory: 3 listings / 7 qty — Psyduck×1@4PKN"));
        assert!(text.contains("- Collection: 10 cards owned (6 physical, 4 NFT)"));
        assert!(text.contains("Prefer these facts when the user says"));
    }

    #[test]
    fn text_cleaning_matches_the_node_helper() {
        assert_eq!(clean_text("  a   b  ", 120), "a b");
        assert_eq!(clean_text("a\nb", 120), "a b");
        assert_eq!(clean_text(&"x".repeat(200), 120).len(), 120);
    }
}
