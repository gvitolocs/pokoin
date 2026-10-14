//! Seller API: grant management for the signed-in seller, and the connector
//! an inventory tool calls with its grant.
//!
//! `GET|POST /api/seller-api-grants` — Firebase sign-in. List, create, revoke,
//! set a webhook URL, send a test webhook.
//!
//! `POST /api/cardrails/connector` and `POST /api/seller-api/v1` — `Bearer
//! pkn_…`. One body `{ action, … }`: `connect`, `locations`, `webhook`,
//! `listings`, `stock`, `list`, `sales`, `events`. The Card Rails path only
//! accepts a `cardrails:stock` grant; the generic path accepts any grant.
use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::{json, Value};
use sqlx::Row;

use super::{parse_json_body, private_json, text_field};
use crate::domain::money::PKN_PER_EUR_CENT;
use crate::error::ApiError;
use crate::listing_live as live;
use crate::seller_api::{self as api, Grant};
use crate::state::{AuthedUser, DomainState};

const GRANT_COLUMNS: &str = "id, client, label, scope, token_prefix, webhook_url, created_at, last_used_at";

fn grant_json(row: &sqlx::postgres::PgRow) -> Result<Value, sqlx::Error> {
    let stamp = |column: &str| -> Value {
        row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(column)
            .ok()
            .flatten()
            .map(|at| json!(at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)))
            .unwrap_or(Value::Null)
    };
    Ok(json!({
        "id": row.try_get::<uuid::Uuid, _>("id")?.to_string(),
        "client": row.try_get::<String, _>("client")?,
        "label": row.try_get::<String, _>("label")?,
        "scope": row.try_get::<String, _>("scope")?,
        "tokenPrefix": row.try_get::<String, _>("token_prefix")?,
        "webhookUrl": row.try_get::<String, _>("webhook_url")?,
        "createdAt": stamp("created_at"),
        "lastUsedAt": stamp("last_used_at"),
    }))
}

async fn list_grants(state: &DomainState, uid: &str) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(&format!(
        "select {GRANT_COLUMNS} from public.seller_api_grants where seller_uid = $1 and revoked_at is null order by created_at"
    ))
    .bind(uid)
    .fetch_all(state.write_db())
    .await
    .map_err(api::store_error)?;
    rows.iter().map(|row| grant_json(row).map_err(api::store_error)).collect()
}

/// `GET /api/seller-api-grants`
pub async fn seller_api_grants_get(State(state): State<DomainState>, AuthedUser(claims): AuthedUser) -> Result<Response, ApiError> {
    Ok(private_json(json!({ "grants": list_grants(&state, &claims.uid).await? })))
}

fn grant_id(body: &Value) -> Result<uuid::Uuid, ApiError> {
    uuid::Uuid::parse_str(&text_field(body, &["id", "grantId"], 80))
        .map_err(|_| ApiError::bad_request("Missing grant id."))
}

async fn create_grant(state: &DomainState, uid: &str, body: &Value) -> Result<Value, ApiError> {
    let client = api::clean_client(&text_field(body, &["client"], 80));
    if client.is_empty() {
        return Err(ApiError::bad_request("Name the app this token is for."));
    }
    let label = text_field(body, &["label"], 80);
    let token = api::new_token();
    let secret = api::new_shared_secret();
    let sealed = api::seal_secret(&secret)?;
    // The limit and the insert are one statement: two tabs cannot both pass it.
    let row = sqlx::query(&format!(
        "insert into public.seller_api_grants (seller_uid, client, label, scope, token_hash, token_prefix, shared_secret) \
         select $1, $2, $3, $4, $5, $6, $7 where (select count(*) from public.seller_api_grants \
         where seller_uid = $1 and revoked_at is null) < $8 returning {GRANT_COLUMNS}"
    ))
    .bind(uid)
    .bind(&client)
    .bind(&label)
    .bind(api::scope_for(&client))
    .bind(api::token_hash(&token))
    .bind(api::token_prefix(&token))
    .bind(sealed)
    .bind(api::MAX_GRANTS)
    .fetch_optional(state.write_db())
    .await
    .map_err(api::store_error)?
    .ok_or_else(|| ApiError::conflict("Revoke a token before creating another.").with_code("grant_limit"))?;
    Ok(json!({
        "grant": grant_json(&row).map_err(api::store_error)?,
        // Shown once. Pokoin keeps only the token's hash.
        "token": token,
        "sharedSecret": secret,
    }))
}

async fn revoke_grant(state: &DomainState, uid: &str, body: &Value) -> Result<Value, ApiError> {
    let id = grant_id(body)?;
    let mut tx = state.write_db().begin().await.map_err(api::store_error)?;
    let revoked = sqlx::query(
        "update public.seller_api_grants set revoked_at = now(), webhook_url = '' \
         where id = $1 and seller_uid = $2 and revoked_at is null",
    )
    .bind(id)
    .bind(uid)
    .execute(&mut *tx)
    .await
    .map_err(api::store_error)?
    .rows_affected();
    if revoked == 0 {
        return Err(ApiError::not_found("Token not found."));
    }
    sqlx::query("delete from public.seller_webhook_deliveries where grant_id = $1 and delivered_at is null")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(api::store_error)?;
    tx.commit().await.map_err(api::store_error)?;
    Ok(json!({ "ok": true, "revoked": id.to_string() }))
}

async fn set_webhook(state: &DomainState, grant: uuid::Uuid, uid: &str, raw: &str) -> Result<String, ApiError> {
    let url = api::clean_webhook_url(raw)?;
    let updated = sqlx::query(
        "update public.seller_api_grants set webhook_url = $3 where id = $1 and seller_uid = $2 and revoked_at is null",
    )
    .bind(grant)
    .bind(uid)
    .bind(&url)
    .execute(state.write_db())
    .await
    .map_err(api::store_error)?
    .rows_affected();
    if updated == 0 {
        return Err(ApiError::not_found("Token not found."));
    }
    Ok(url)
}

/// Queue a `webhook.test` event for one grant only.
async fn test_webhook(state: &DomainState, uid: &str, body: &Value) -> Result<Value, ApiError> {
    let id = grant_id(body)?;
    let event_id = format!("webhook.test:{}", uuid::Uuid::new_v4());
    let envelope = api::envelope(&event_id, "webhook.test", "Grant", &id.to_string(), json!({"grant_id": id.to_string()}), state.now_ms());
    let queued = sqlx::query(
        "with ev as (insert into public.seller_api_events (seller_uid, event_id, cause, body) \
         select $1, $2, 'webhook.test', $3 where exists (select 1 from public.seller_api_grants \
         where id = $4 and seller_uid = $1 and revoked_at is null and webhook_url <> '') returning id) \
         insert into public.seller_webhook_deliveries (grant_id, event_pk) select $4, id from ev",
    )
    .bind(uid)
    .bind(&event_id)
    .bind(envelope)
    .bind(id)
    .execute(state.write_db())
    .await
    .map_err(api::store_error)?
    .rows_affected();
    if queued == 0 {
        return Err(ApiError::conflict("Set a webhook URL on this token first.").with_code("webhook_url_missing"));
    }
    Ok(json!({ "ok": true, "eventId": event_id }))
}

/// `POST /api/seller-api-grants` — `{ action: create | revoke | webhook | test }`
pub async fn seller_api_grants_post(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    bytes: Bytes,
) -> Result<Response, ApiError> {
    let body = parse_json_body(&bytes)?;
    let out = match text_field(&body, &["action"], 20).as_str() {
        "create" => create_grant(&state, &claims.uid, &body).await?,
        "revoke" => revoke_grant(&state, &claims.uid, &body).await?,
        "webhook" => {
            let url = set_webhook(&state, grant_id(&body)?, &claims.uid, &text_field(&body, &["url", "webhookUrl"], 600)).await?;
            json!({ "ok": true, "webhookUrl": url })
        }
        "test" => test_webhook(&state, &claims.uid, &body).await?,
        _ => return Err(ApiError::bad_request("Unknown action.")),
    };
    Ok(private_json(out))
}

// ---------------------------------------------------------------------------
// Connector (grant bearer)
// ---------------------------------------------------------------------------

/// Storage locations on the seller's live stock, as the tool's shelf labels.
async fn locations(state: &DomainState, uid: &str) -> Result<Vec<Value>, ApiError> {
    let labels: Vec<String> = sqlx::query_scalar(
        "select distinct btrim(location) as label from public.marketplace_user_listings \
         where seller_uid = $1 and status in ('active', 'paused') and quantity_available > 0 \
         and btrim(coalesce(location, '')) <> '' order by 1 limit 2000",
    )
    .bind(uid)
    .fetch_all(state.read_db())
    .await?;
    Ok(labels
        .into_iter()
        .filter(|label| label.chars().count() <= 64)
        .map(|label| json!({ "label": label }))
        .collect())
}

/// The seller's public handle, their ship-from country, and the name their
/// listings carry.
async fn seller_profile(state: &DomainState, uid: &str) -> (String, String) {
    let mut name = String::new();
    let mut country = String::new();
    if let Ok(firestore) = state.firestore() {
        if let Ok(user) = crate::store::read_user(firestore, uid).await {
            name = live::first(&user, &["username", "displayName"], 120);
            country = live::first(&user, &["shipFromCountry", "ship_from_country"], 40).to_uppercase();
        }
    }
    if name.is_empty() || country.is_empty() {
        let row = sqlx::query(
            "select seller_name, seller_country from public.marketplace_user_listings \
             where seller_uid = $1 order by updated_at desc limit 1",
        )
        .bind(uid)
        .fetch_optional(state.read_db())
        .await
        .ok()
        .flatten();
        if let Some(row) = row {
            if name.is_empty() {
                name = row.try_get::<Option<String>, _>("seller_name").ok().flatten().unwrap_or_default();
            }
            if country.is_empty() {
                country = row.try_get::<Option<String>, _>("seller_country").ok().flatten().unwrap_or_default().to_uppercase();
            }
        }
    }
    (name, country)
}

async fn connect(state: &DomainState, grant: &Grant) -> Result<Value, ApiError> {
    let (name, _) = seller_profile(state, &grant.seller_uid).await;
    Ok(json!({
        "ok": true,
        "scope": grant.scope,
        "client": grant.client,
        "accountRef": grant.seller_uid,
        "accountName": if name.is_empty() { "Pokoin seller".to_string() } else { name },
        // Pokoin has no Cardmarket account link; a tool must not write there.
        "cardmarketLinked": false,
        "webhookUrl": grant.webhook_url,
        "sharedSecret": grant.shared_secret()?,
        "locations": locations(state, &grant.seller_uid).await?,
    }))
}

/// Read-only defaults for this grant's seller, using the same normalization
/// as Scan Connect. Never creates a batch or changes the seller's defaults.
async fn scan_settings(state: &DomainState, grant: &Grant) -> Result<Value, ApiError> {
    use pokoin_external::scan_connect as rules;
    let row = sqlx::query(
        "select id::text as id, defaults from public.scan_batches where seller_uid = $1 \
         and status <> 'discarded' order by (status = 'open') desc, updated_at desc, id desc limit 1"
    )
    .bind(&grant.seller_uid)
    .fetch_optional(state.write_db())
    .await?;
    let raw = row.as_ref().and_then(|r| r.try_get::<Value, _>("defaults").ok())
        .unwrap_or_else(rules::default_batch_defaults);
    let defaults = rules::normalize_defaults(&raw, &rules::default_batch_defaults());
    let batch_id = row.as_ref().and_then(|r| r.try_get::<String, _>("id").ok());
    Ok(json!({ "batchId": batch_id, "scanSettings": cardrails_settings(&defaults) }))
}

fn cardrails_settings(defaults: &Value) -> Value {
    let printing = match defaults["foilState"].as_str().unwrap_or("standard") {
        "standard" => "Standard", "holo" => "Holo", "reverse" => "Reverse Holo",
        other => other,
    };
    let condition = if defaults["condition"] == "Poor" { json!("PO") } else { defaults["condition"].clone() };
    json!({
        "game": defaults["game"], "language": defaults["language"], "condition": condition,
        "printing": printing, "firstEdition": defaults["firstEdition"], "signed": defaults["signed"],
        "altered": defaults["altered"], "storageLabel": defaults["location"],
        "stackSize": defaults["stackSize"], "stack": defaults["stack"],
        "startPosition": defaults["startPosition"], "quantity": defaults["quantity"],
        "mergeRepeats": defaults["mergeRepeats"], "paused": false,
        "locationConfigured": defaults["location"].as_str().is_some_and(|s| !s.is_empty()),
    })
}

/// Exact-variant key into `cardtrader_sold_daily`: blueprint, condition,
/// language, reverse, first edition. Never graded (a raw card is never a
/// comp for a graded slab) and never mixed across any of these.
type SoldVariantKey = (i64, String, String, bool, bool);

/// Pokoin's own card id is twice the CardTrader blueprint id (the low bit
/// marks the Card Rails/market variant split) — the same mapping the Poko
/// market tools use (`poko-market.js`'s `card_id / 2`).
fn blueprint_id_of(card_id: &Value) -> Option<i64> {
    let id = match card_id {
        Value::String(s) => s.parse::<i64>().ok(),
        Value::Number(n) => n.as_i64(),
        _ => None,
    }?;
    Some(id / 2)
}

const LAST_SOLD_WINDOW_DAYS: i32 = 30;

/// The minimum confirmed Pokoin sale price (EUR cents) for each exact
/// card version/printing a listing in `rows` is, over the last
/// [`LAST_SOLD_WINDOW_DAYS`] days: `cardtrader_sold_daily` is Pokoin's own
/// sanitized, per-day aggregate of confirmed sales (schema 042; see
/// `docs/CARDTRADER_SELLER_SYNC.md` and the Poko market tools). A listing
/// with no matching row in the window is left out of the map — never a
/// guessed figure.
async fn last_sold_minimums(state: &DomainState, rows: &[Value]) -> HashMap<SoldVariantKey, i64> {
    let blueprint_ids: Vec<i64> = {
        let mut ids: Vec<i64> = rows.iter().filter_map(|r| blueprint_id_of(&r["card_id"])).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    if blueprint_ids.is_empty() {
        return HashMap::new();
    }
    let sold: Result<Vec<(i64, String, String, bool, bool, f64)>, _> = sqlx::query_as(
        "select blueprint_id, condition, language, reverse, first_edition, min(min_pkn)::float8 \
           from cardtrader_sold_daily \
          where blueprint_id = any($1::bigint[]) and graded = false and sold_qty > 0 \
            and observed_day >= current_date - $2::int \
          group by blueprint_id, condition, language, reverse, first_edition",
    )
    .bind(&blueprint_ids)
    .bind(LAST_SOLD_WINDOW_DAYS)
    .fetch_all(state.read_db())
    .await;
    match sold {
        Ok(rows) => rows
            .into_iter()
            .filter(|(_, _, _, _, _, min_pkn)| min_pkn.is_finite() && *min_pkn >= 0.0)
            .map(|(blueprint_id, condition, language, reverse, first_edition, min_pkn)| {
                let cents = (min_pkn / PKN_PER_EUR_CENT as f64).round() as i64;
                ((blueprint_id, condition, language, reverse, first_edition), cents)
            })
            .collect(),
        Err(err) => {
            // Never fails the connector call over this: the field is just
            // omitted, same as a printing with no sold data yet.
            tracing::warn!(error = %err, "last-sold-minimum lookup failed for a cardrails listings page");
            HashMap::new()
        }
    }
}

fn tool_listing(row: &Value, sold: &HashMap<SoldVariantKey, i64>) -> Value {
    let price_pkn = live::number(&row["price_pkn"]);
    let last_sold_min_eur_cents = blueprint_id_of(&row["card_id"]).and_then(|blueprint_id| {
        let key = (
            blueprint_id,
            live::field(row, "condition", 20),
            live::field(row, "language", 8),
            row["reverse"] == true,
            row["first_edition"] == true,
        );
        sold.get(&key).copied()
    });
    json!({
        "listingId": row["id"],
        "cardId": row["card_id"],
        "game": if live::field(row, "marketplace_game", 40).is_empty() { json!("pokemon") } else { row["marketplace_game"].clone() },
        "name": row["card_name"],
        "setName": row["set_name"],
        "collectorNumber": row["collector_number"],
        "condition": row["condition"],
        "language": row["language"],
        "quantity": row["quantity_available"],
        "status": row["status"],
        "pricePkn": live::json_number(if price_pkn.is_finite() { price_pkn } else { 0.0 }),
        "priceEurCents": live::json_number(if price_pkn.is_finite() { (price_pkn / PKN_PER_EUR_CENT as f64).round() } else { 0.0 }),
        "reverse": row["reverse"] == true,
        "firstEdition": row["first_edition"] == true,
        "foilState": row["foil_state"],
        "location": row["location"],
        "updatedAt": row["updated_at"],
        // The minimum confirmed Pokoin sale price for this exact card
        // version/printing over the last 30 days, in EUR cents; absent when
        // Pokoin never sold a copy of it in that window.
        "lastSoldMinEurCents": last_sold_min_eur_cents,
    })
}

/// The seller's live and sold-out listings, keyset-paged by id.
async fn listings(state: &DomainState, grant: &Grant, body: &Value) -> Result<Value, ApiError> {
    let cursor = uuid::Uuid::parse_str(&text_field(body, &["cursor"], 80)).ok();
    let limit = live::number(&body["limit"]);
    let limit = if limit.is_finite() { (limit as i64).clamp(1, 500) } else { 200 };
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from public.marketplace_user_listings l where seller_uid = $1 \
         and status in ('active', 'paused', 'sold_out') and ($2::uuid is null or id > $2) order by id limit $3",
    )
    .bind(&grant.seller_uid)
    .bind(cursor)
    .bind(limit)
    .fetch_all(state.write_db())
    .await?;
    let next = if rows.len() as i64 == limit { rows.last().map(|row| row["id"].clone()) } else { None };
    let sold = last_sold_minimums(state, &rows).await;
    Ok(json!({
        "listings": rows.iter().map(|row| tool_listing(row, &sold)).collect::<Vec<_>>(),
        "cursor": next.unwrap_or(Value::Null),
    }))
}

fn seller_claims(grant: &Grant) -> crate::Claims {
    crate::Claims { uid: grant.seller_uid.clone(), ..Default::default() }
}

fn only_pokoin(body: &Value) -> Result<(), ApiError> {
    match text_field(body, &["channel"], 40).as_str() {
        "" | "pokoin" => Ok(()),
        "cardmarket" => Err(ApiError::conflict("This Pokoin account has no linked Cardmarket account.").with_code("cardmarket_unlinked")),
        _ => Err(ApiError::bad_request("Unknown channel.")),
    }
}

/// What a `stock` call writes for the listing as it is now. `None`: nothing.
pub fn stock_patch(current: i64, status: &str, target: i64) -> Result<Option<Value>, ApiError> {
    match status {
        "active" | "paused" | "sold_out" => {}
        _ => return Err(ApiError::conflict("This listing was removed on Pokoin.").with_code("listing_removed")),
    }
    // Stock returning to a listing that ran out puts it back on sale. A
    // listing the seller paused with stock on it stays paused.
    let revive = target > 0 && (status == "sold_out" || (status == "paused" && current <= 0));
    if target == current && !revive {
        return Ok(None);
    }
    let mut patch = json!({ "quantityAvailable": target });
    if revive {
        patch["status"] = json!("active");
    }
    Ok(Some(patch))
}

/// Set a listing's absolute quantity. Repeating the call changes nothing.
async fn stock(state: &DomainState, grant: &Grant, body: &Value) -> Result<Value, ApiError> {
    only_pokoin(body)?;
    let id = text_field(body, &["listingId"], 80);
    let uuid = uuid::Uuid::parse_str(&id).map_err(|_| ApiError::bad_request("Listing id invalid."))?;
    let target = live::number(&body["targetQuantity"]);
    if !target.is_finite() || target.fract() != 0.0 || !(0.0..=99.0).contains(&target) {
        return Err(ApiError::bad_request("targetQuantity must be between 0 and 99."));
    }
    let row = sqlx::query(
        "select quantity_available, status, price_pkn::float8 AS price_pkn from public.marketplace_user_listings where id = $1 and seller_uid = $2",
    )
    .bind(uuid)
    .bind(&grant.seller_uid)
    .fetch_optional(state.write_db())
    .await?
    .ok_or_else(|| ApiError::not_found("Listing not found for this seller."))?;
    let current = i64::from(row.try_get::<i32, _>("quantity_available")?);
    let status: String = row.try_get("status")?;
    let Some(mut patch) = stock_patch(current, &status, target as i64)? else {
        return Ok(json!({ "confirmed": true, "listingId": id, "quantity": current, "status": status, "changed": false }));
    };
    if row.try_get::<f64, _>("price_pkn")? <= 0.0 && patch["status"] == "active" { patch["status"] = json!("paused"); }
    let listing = super::listings::update_listing(state, &seller_claims(grant), &uuid.to_string(), &patch).await?;
    let quantity = live::number(&listing["quantityAvailable"]);
    if !quantity.is_finite() {
        return Err(ApiError::internal("Pokoin did not confirm the stock update."));
    }
    Ok(json!({
        "confirmed": true,
        "listingId": id,
        "quantity": quantity as i64,
        "status": listing["status"],
        "changed": true,
    }))
}

/// The Pokoin listing body for a tool's inventory item.
pub fn listing_body(item: &Value, seller_name: &str, country: &str) -> Result<Value, ApiError> {
    let identity = &item["identity"];
    let card = live::first(identity, &["publicId", "pokoinId", "cardId"], 80);
    let card = if card.is_empty() { live::field(item, "cardId", 80) } else { card };
    if card.is_empty() {
        return Err(ApiError::bad_request("This item has no Pokoin card id (identity.publicId).").with_code("card_unmapped"));
    }
    let price_pkn = if item.get("pricePkn").is_some() {
        live::number(&item["pricePkn"])
    } else {
        let currency = live::field(item, "currency", 8).to_uppercase();
        if !currency.is_empty() && currency != "EUR" {
            return Err(ApiError::bad_request("Prices must be in EUR or PKN.").with_code("currency_unsupported"));
        }
        (if item.get("priceEurCents").is_some() { live::number(&item["priceEurCents"]) } else { live::number(&item["price"]) * 100.0 } * PKN_PER_EUR_CENT as f64).round()
    };
    let paused = item["status"] == "paused";
    if !price_pkn.is_finite() || price_pkn < 0.0 || (price_pkn == 0.0 && !paused) {
        return Err(ApiError::bad_request("This item has no valid price."));
    }
    let finish = live::first(item, &["finish", "printing"], 40).to_lowercase().replace([' ', '-'], "_");
    let location = match &item["location"] {
        Value::String(label) => label.trim().to_string(),
        _ => live::first(item, &["locationLabel", "locationCode"], 64),
    };
    let mut body = json!({
        "cardId": card,
        "pricePkn": price_pkn,
        "quantityAvailable": item["quantity"],
        "condition": live::field(item, "condition", 20).to_uppercase(),
        "language": live::field(item, "language", 10).to_uppercase(),
        "reverse": finish == "reverse" || finish == "reverse_holo",
        "firstEdition": item["firstEdition"] == true || finish == "first_edition",
        "foilState": if finish == "reverse" || finish == "reverse_holo" { "reverse" } else if finish == "holo" { "holo" } else { "standard" },
        "signed": item["signed"] == true, "altered": item["altered"] == true,
        "status": if paused { "paused" } else { "active" },
        "shippingAvailable": price_pkn > 0.0,
        "sellerName": seller_name,
        "sellerCountry": country,
        "location": location.chars().take(64).collect::<String>(),
        "targets": { "pokoin": true, "cardtrader": false },
    });
    // CardRails already resolved the printing. Keep its verified metadata even
    // when the generic marketplace versions view has not indexed that card yet.
    for (destination, source, maximum) in [
        ("cardName", "name", 240),
        ("setName", "setName", 240),
        ("collectorNumber", "number", 80),
        ("cardImageUrl", "art", 800),
    ] {
        let value = live::field(identity, source, maximum);
        if !value.is_empty() { body[destination] = json!(value); }
    }
    let game = live::field(identity, "game", 40);
    if !game.is_empty() {
        body["marketplaceGame"] = json!(game);
    }
    Ok(body)
}

/// Quote new inventory with the same exact facets used for existing listings.
async fn sold_prices(state:&DomainState,body:&Value)->Result<Value,ApiError> {
    let items=body["items"].as_array().ok_or_else(||ApiError::bad_request("items is required"))?;
    if items.len()>500 {return Err(ApiError::bad_request("At most 500 inventory items per quote"));}
    let rows:Vec<Value>=items.iter().map(|item| {
      let finish=live::first(item,&["printing","finish"],40).to_lowercase().replace([' ','-'],"_");
      let condition=live::field(item,"condition",20).to_uppercase();
      json!({"card_id":item["identity"]["publicId"],"condition":if condition=="PO" {"Poor"}else{condition.as_str()},
        "language":live::field(item,"language",10).to_uppercase(),"reverse":finish=="reverse_holo"||finish=="reverse",
        "first_edition":item["firstEdition"]==true})
    }).collect();
    let sold=last_sold_minimums(state,&rows).await;
    let ids:Vec<i64>=rows.iter().filter_map(|r|blueprint_id_of(&r["card_id"])).collect();
    let fallback:HashMap<i64,f64>=sqlx::query_as::<_,(i64,f64)>("SELECT blueprint_id,min(cheapest_price_pkn)::float8 FROM cheapest_homepage_cache_blueprint WHERE blueprint_id=ANY($1) AND provider='cardtrader' AND cheapest_price_pkn>0 GROUP BY blueprint_id").bind(&ids).fetch_all(state.read_db()).await.unwrap_or_default().into_iter().collect();
    let prices:Vec<Value>=items.iter().zip(&rows).map(|(item,row)| {
      let price=blueprint_id_of(&row["card_id"]).and_then(|id| sold.get(&(id,live::field(row,"condition",20),live::field(row,"language",10),row["reverse"]==true,row["first_edition"]==true))).copied();
      let tile=blueprint_id_of(&row["card_id"]).and_then(|id|fallback.get(&id)).filter(|v|v.is_finite()&&**v>0.0).map(|v|(v/PKN_PER_EUR_CENT as f64).round()as i64);
      json!({"itemId":item["id"],"publicId":row["card_id"],"minEurCents":price.or(tile),"priceSource":if price.is_some(){"sold_exact_30d"}else if tile.is_some(){"cardtrader_tile_minimum"}else{"unavailable"}})
    }).collect();
    Ok(json!({"prices":prices,"windowDays":LAST_SOLD_WINDOW_DAYS}))
}

/// Create a listing from a tool's item, at most once per idempotency key.
async fn list(state: &DomainState, grant: &Grant, body: &Value) -> Result<Value, ApiError> {
    only_pokoin(body)?;
    let key = text_field(body, &["idempotencyKey"], 200);
    if key.is_empty() {
        return Err(ApiError::bad_request("idempotencyKey is required."));
    }
    let db = state.write_db();
    let claimed = sqlx::query(
        "insert into public.seller_api_listing_keys (grant_id, idempotency_key) values ($1, $2) \
         on conflict (grant_id, idempotency_key) do nothing",
    )
    .bind(grant.id)
    .bind(&key)
    .execute(db)
    .await
    .map_err(api::store_error)?
    .rows_affected()
        == 1;
    if !claimed {
        let existing: Option<uuid::Uuid> = sqlx::query_scalar(
            "select listing_id from public.seller_api_listing_keys where grant_id = $1 and idempotency_key = $2",
        )
        .bind(grant.id)
        .bind(&key)
        .fetch_optional(db)
        .await
        .map_err(api::store_error)?
        .flatten();
        // A claim with no listing: an earlier attempt may or may not have
        // created it. The tool reads `listings` rather than create a second.
        let id = existing.ok_or_else(|| {
            ApiError::conflict("An earlier attempt with this key is unresolved. Read listings before retrying.")
                .with_code("list_in_doubt")
        })?;
        return Ok(json!({ "confirmed": true, "listingId": id.to_string(), "stockMode": "absolute", "created": false }));
    }
    let release = || async {
        let _ = sqlx::query("delete from public.seller_api_listing_keys where grant_id = $1 and idempotency_key = $2 and listing_id is null")
            .bind(grant.id)
            .bind(&key)
            .execute(db)
            .await;
    };
    let (name, country) = seller_profile(state, &grant.seller_uid).await;
    let listing_body = match listing_body(&body["item"], if name.is_empty() { "Pokoin seller" } else { &name }, &country) {
        Ok(listing_body) => listing_body,
        Err(error) => {
            release().await;
            return Err(error);
        }
    };
    let game = live::field(&listing_body, "marketplaceGame", 40);
    let created = super::listings::create_listing(state, &seller_claims(grant), &listing_body, if game.is_empty() { "pokemon" } else { &game }).await;
    let listing = match created {
        Ok(listing) => listing,
        // Rejected before or by the insert: nothing exists, the key is free.
        Err(error) if error.status.is_client_error() => {
            release().await;
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    let id = uuid::Uuid::parse_str(&live::field(&listing, "id", 80))
        .map_err(|_| ApiError::internal("Pokoin did not confirm the listing."))?;
    sqlx::query("update public.seller_api_listing_keys set listing_id = $3 where grant_id = $1 and idempotency_key = $2")
        .bind(grant.id)
        .bind(&key)
        .bind(id)
        .execute(db)
        .await
        .map_err(api::store_error)?;
    Ok(json!({
        "confirmed": true,
        "listingId": id.to_string(),
        "stockMode": "absolute",
        "created": true,
        "quantity": listing["quantityAvailable"],
    }))
}

/// A paid order as the flat sale lines an inventory tool records: the listing
/// it mapped (`externalId`) and the references it dedupes on.
pub fn sale_lines(order: &Value) -> Vec<Value> {
    let reference = live::first(order, &["code", "id"], 160);
    order["order_items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    json!({
                        "channel": "pokoin",
                        "externalId": item["listing_id"],
                        "quantity": item["quantity"],
                        "orderRef": reference,
                        "lineId": item["id"],
                        "occurredAt": order["paid_at"],
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The seller's event log after `cursor`. `orders_only` is the `sales` view:
/// each order event's `data` as an order, and the paid ones again as flat
/// `sales` lines.
async fn events(state: &DomainState, grant: &Grant, body: &Value, orders_only: bool) -> Result<Value, ApiError> {
    let cursor = match &body["cursor"] {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(text) => text.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    };
    let rows = sqlx::query(
        "select id, cause, body from public.seller_api_events where seller_uid = $1 and id > $2 \
         and ($3 = false or cause in ('order.create', 'order.destroy')) order by id limit 100",
    )
    .bind(&grant.seller_uid)
    .bind(cursor.max(0))
    .bind(orders_only)
    .fetch_all(state.write_db())
    .await
    .map_err(api::store_error)?;
    let mut next = cursor.max(0);
    let mut out = Vec::with_capacity(rows.len());
    let mut sales = Vec::new();
    for row in &rows {
        next = row.try_get::<i64, _>("id")?;
        let Ok(event) = serde_json::from_str::<Value>(&row.try_get::<String, _>("body")?) else {
            continue;
        };
        if orders_only {
            let mut order = event["data"].clone();
            let cancelled = row.try_get::<String, _>("cause")? == "order.destroy";
            order["cancelled"] = json!(cancelled);
            if !cancelled {
                sales.extend(sale_lines(&order));
            }
            out.push(order);
        } else {
            out.push(event);
        }
    }
    let mut page = json!({ "cursor": next.to_string(), "more": rows.len() == 100 });
    page[if orders_only { "orders" } else { "events" }] = json!(out);
    if orders_only {
        page["sales"] = json!(sales);
    }
    Ok(page)
}

async fn connector(state: &DomainState, headers: &HeaderMap, bytes: &Bytes, cardrails: bool) -> Result<Response, ApiError> {
    let grant = api::authenticate(state, headers).await?;
    if cardrails && grant.scope != api::SCOPE_CARDRAILS {
        return Err(ApiError::forbidden("This token is not a Card Rails grant.").with_code("seller_api/wrong-scope"));
    }
    let body = parse_json_body(bytes)?;
    let out = match text_field(&body, &["action"], 20).as_str() {
        "connect" | "info" => connect(state, &grant).await?,
        "scan-settings" => scan_settings(state, &grant).await?,
        "locations" => json!({ "locations": locations(state, &grant.seller_uid).await? }),
        "webhook" => {
            let url = set_webhook(state, grant.id, &grant.seller_uid, &text_field(&body, &["url", "webhookUrl"], 600)).await?;
            json!({ "ok": true, "webhookUrl": url, "sharedSecret": grant.shared_secret()? })
        }
        "listings" => listings(state, &grant, &body).await?,
        "stock" => stock(state, &grant, &body).await?,
        "list" => list(state, &grant, &body).await?,
        "sold-prices" => sold_prices(state,&body).await?,
        "sales" => events(state, &grant, &body, true).await?,
        "events" => events(state, &grant, &body, false).await?,
        _ => return Err(ApiError::bad_request("Unknown action.").with_code("seller_api/unknown-action")),
    };
    Ok(private_json(out))
}

/// `POST /api/cardrails/connector`
pub async fn cardrails_connector(State(state): State<DomainState>, headers: HeaderMap, bytes: Bytes) -> Result<Response, ApiError> {
    connector(&state, &headers, &bytes, true).await
}

/// `POST /api/seller-api/v1`
pub async fn seller_api_v1(State(state): State<DomainState>, headers: HeaderMap, bytes: Bytes) -> Result<Response, ApiError> {
    connector(&state, &headers, &bytes, false).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventory_keeps_prices_printing_and_flags_without_publishing_unpriced_stock() {
        let item=json!({"identity":{"publicId":"741592"},"quantity":1,"priceEurCents":19,
          "language":"IT","condition":"SP","printing":"Reverse Holo","firstEdition":true,
          "signed":true,"altered":true,"location":"box·3·41"});
        let body=listing_body(&item,"seller","IT").unwrap();
        assert_eq!(body["pricePkn"],38.0); assert_eq!(body["reverse"],true);
        assert_eq!(body["firstEdition"],true); assert_eq!(body["signed"],true);
        assert_eq!(body["altered"],true); assert_eq!(body["location"],"box·3·41");
        let mut item=item;item["priceEurCents"]=json!(0);assert!(listing_body(&item,"seller","IT").is_err());
        item["status"]=json!("paused");let body=listing_body(&item,"seller","IT").unwrap();
        assert_eq!(body["pricePkn"],0.0);assert_eq!(body["status"],"paused");assert_eq!(body["shippingAvailable"],false);
        item["priceEurCents"]=json!(-1);assert!(listing_body(&item,"seller","IT").is_err());
    }


    #[test]
    fn stock_patch_is_absolute_idempotent_and_revives_only_what_ran_out() {
        assert_eq!(stock_patch(3, "active", 3).unwrap(), None);
        assert_eq!(stock_patch(3, "active", 1).unwrap(), Some(json!({"quantityAvailable":1})));
        assert_eq!(stock_patch(3, "active", 0).unwrap(), Some(json!({"quantityAvailable":0})));
        assert_eq!(stock_patch(0, "sold_out", 2).unwrap(), Some(json!({"quantityAvailable":2,"status":"active"})));
        assert_eq!(stock_patch(0, "paused", 2).unwrap(), Some(json!({"quantityAvailable":2,"status":"active"})));
        // Paused by the seller with stock on it: the quantity moves, the pause stays.
        assert_eq!(stock_patch(4, "paused", 2).unwrap(), Some(json!({"quantityAvailable":2})));
        assert_eq!(stock_patch(0, "sold_out", 0).unwrap(), None);
        assert_eq!(stock_patch(1, "inactive", 1).unwrap_err().code.as_deref(), Some("listing_removed"));
    }

    #[test]
    fn blueprint_id_halves_the_card_id_from_either_json_shape() {
        assert_eq!(blueprint_id_of(&json!("798728")), Some(399364));
        assert_eq!(blueprint_id_of(&json!(633412)), Some(316706));
        assert_eq!(blueprint_id_of(&json!(null)), None);
        assert_eq!(blueprint_id_of(&json!("not-a-number")), None);
    }

    #[test]
    fn tool_listing_attaches_the_matching_last_sold_minimum_only() {
        let row = json!({
            "id": "l1", "card_id": "798728", "marketplace_game": "pokemon", "card_name": "Popplio",
            "set_name": "Pitch Black", "collector_number": "018/084", "condition": "NM", "language": "EN",
            "quantity_available": 1, "status": "active", "price_pkn": 38.0, "reverse": false,
            "first_edition": false, "foil_state": "standard", "location": "box·1", "updated_at": "2026-10-13T00:00:00Z",
        });
        // Exact facet match: picked up.
        let sold: HashMap<SoldVariantKey, i64> =
            HashMap::from([((399364, "NM".to_string(), "EN".to_string(), false, false), 1250)]);
        assert_eq!(tool_listing(&row, &sold)["lastSoldMinEurCents"], 1250);
        // No row for this exact variant (e.g. only a reverse sold): omitted, not guessed.
        let other: HashMap<SoldVariantKey, i64> =
            HashMap::from([((399364, "NM".to_string(), "EN".to_string(), true, false), 1250)]);
        assert_eq!(tool_listing(&row, &other)["lastSoldMinEurCents"], Value::Null);
        assert_eq!(tool_listing(&row, &HashMap::new())["lastSoldMinEurCents"], Value::Null);
    }

    #[test]
    fn listing_body_maps_a_card_rails_item() {
        let item = json!({"id":"cr_1","identity":{"game":"pokemon","name":"Espurr","setName":"BREAKpoint","number":"059/122","art":"https://cdn.pokoin.com/espurr.jpg","publicId":"220962"},"language":"en","condition":"nm","finish":"reverse","quantity":3,"price":12.5,"currency":"EUR","location":"BIN-07"});
        let body = listing_body(&item, "alice", "IT").unwrap();
        assert_eq!(body["cardId"], "220962");
        assert_eq!(body["cardName"], "Espurr");
        assert_eq!(body["setName"], "BREAKpoint");
        assert_eq!(body["collectorNumber"], "059/122");
        assert_eq!(body["cardImageUrl"], "https://cdn.pokoin.com/espurr.jpg");
        // 200 PKN per euro.
        assert_eq!(body["pricePkn"], 2500.0);
        assert_eq!(body["quantityAvailable"], 3);
        assert_eq!(body["condition"], "NM");
        assert_eq!(body["language"], "EN");
        assert_eq!(body["reverse"], true);
        assert_eq!(body["firstEdition"], false);
        assert_eq!(body["sellerCountry"], "IT");
        assert_eq!(body["location"], "BIN-07");
        assert_eq!(body["targets"], json!({"pokoin":true,"cardtrader":false}));
        assert_eq!(body["marketplaceGame"], "pokemon");
    }

    #[test]
    fn listing_body_refuses_unmapped_cards_and_foreign_currencies() {
        let unmapped = json!({"identity":{"name":"Espurr"},"quantity":1,"price":1});
        assert_eq!(listing_body(&unmapped, "a", "IT").unwrap_err().code.as_deref(), Some("card_unmapped"));
        let usd = json!({"identity":{"publicId":"1"},"quantity":1,"price":1,"currency":"USD"});
        assert_eq!(listing_body(&usd, "a", "IT").unwrap_err().code.as_deref(), Some("currency_unsupported"));
        let free = json!({"identity":{"publicId":"1"},"quantity":1,"price":0});
        assert!(listing_body(&free, "a", "IT").is_err());
        let pkn = json!({"identity":{"publicId":"1"},"quantity":1,"pricePkn":400,"currency":"USD"});
        assert_eq!(listing_body(&pkn, "a", "IT").unwrap()["pricePkn"], 400.0);
    }

    #[test]
    fn sale_lines_name_the_listing_and_the_dedupe_references() {
        let order = json!({"id":"o1","code":"o1","paid_at":"2026-10-11T00:00:00Z","order_items":[
            {"id":"o1:l1:0","listing_id":"l1","quantity":2},{"id":"o1:l2:1","listing_id":"l2","quantity":1}]});
        assert_eq!(sale_lines(&order), vec![
            json!({"channel":"pokoin","externalId":"l1","quantity":2,"orderRef":"o1","lineId":"o1:l1:0","occurredAt":"2026-10-11T00:00:00Z"}),
            json!({"channel":"pokoin","externalId":"l2","quantity":1,"orderRef":"o1","lineId":"o1:l2:1","occurredAt":"2026-10-11T00:00:00Z"}),
        ]);
        assert!(sale_lines(&json!({"id":"o1","state":"canceled"})).is_empty());
    }

    #[test]
    fn only_the_pokoin_channel_is_writable() {
        assert!(only_pokoin(&json!({})).is_ok());
        assert!(only_pokoin(&json!({"channel":"pokoin"})).is_ok());
        assert_eq!(only_pokoin(&json!({"channel":"cardmarket"})).unwrap_err().code.as_deref(), Some("cardmarket_unlinked"));
        assert!(only_pokoin(&json!({"channel":"ebay"})).is_err());
    }
}
