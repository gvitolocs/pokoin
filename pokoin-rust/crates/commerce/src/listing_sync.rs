//! Durable native listing outbox, read-model invalidation and CardTrader writes.
use crate::listing_live::{field, first, json_number, number};
use crate::{error::ApiError, state::DomainState};
use pokoin_external::{
    cardtrader::{
        client::CardTraderClient,
        integration,
        push::{self as ct_push, PushOutcome},
    },
    firebase::{FirestoreRest, FirestoreStore},
};
use serde_json::{json, Value};
use sqlx::{Postgres, Row, Transaction};
use std::sync::atomic::{AtomicBool, Ordering};
pub const INSERT_SQL:&str="insert into public.marketplace_outbox (event_type, aggregate_id, payload, idempotency_key) values ($1, $2, $3::jsonb, $4) on conflict (idempotency_key) where processed_at is null and idempotency_key is not null do nothing returning id";
/// CLAIM_SQL's `attempts < 8`.
pub const MAX_ATTEMPTS: i32 = 8;
pub const CLAIM_SQL:&str="update public.marketplace_outbox as outbox set attempts = outbox.attempts + 1, available_at = now() + interval '30 seconds' where outbox.id = (select id from public.marketplace_outbox where processed_at is null and available_at <= now() and attempts < 8 order by id for update skip locked limit 1) returning id, event_type, aggregate_id, payload, attempts";
fn external_error(e: pokoin_external::ApiError) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::from_u16(e.status).unwrap_or(axum::http::StatusCode::BAD_GATEWAY),
        e.message,
    )
}
pub fn targets(raw: &Value) -> Value {
    let pokoin = raw["pokoin"] != false && raw["pokoin"] != "false" && raw["pokoin"] != 0;
    let ct = raw["cardtrader"] == true || raw["cardtrader"] == "true" || raw["cardtrader"] == 1;
    if !pokoin && !ct {
        json!({"pokoin":true,"cardtrader":false})
    } else {
        json!({"pokoin":pokoin,"cardtrader":ct})
    }
}
pub fn blueprint(card: &str) -> Option<i64> {
    pokoin_external::cardtrader::push::blueprint(card)
}
pub fn product_body(listing: &Value) -> Result<Value, ApiError> {
    pokoin_external::cardtrader::push::product_body(listing).map_err(external_error)
}
pub async fn push_product(
    fs: &dyn FirestoreStore,
    ct: &CardTraderClient,
    uid: &str,
    listing: &Value,
) -> Result<Value, ApiError> {
    pokoin_external::cardtrader::push::push_product(fs, ct, uid, listing)
        .await
        .map_err(external_error)
}
pub async fn push_listing(
    state: &DomainState,
    uid: &str,
    listing: &Value,
    link: bool,
) -> Result<Value, ApiError> {
    let fs = FirestoreRest::from_env()
        .ok_or_else(|| ApiError::internal("Firebase Admin credentials are not configured."))?;
    let ct = CardTraderClient::new();
    let result = if link {
        pokoin_external::cardtrader::push::push_and_link(&fs, &ct, state.write_db(), uid, listing).await
    } else {
        pokoin_external::cardtrader::push::push_product(&fs, &ct, uid, listing).await
    };
    result.map_err(external_error)
}
pub async fn destroy_product(
    _state: &DomainState,
    uid: &str,
    source: &str,
    quantity: f64,
) -> Result<Value, ApiError> {
    let Some((prefix, id)) = source.split_once(':') else {
        return Ok(json!({"skipped":true,"reason":"not_linked"}));
    };
    if !["ct", "cardtrader"].contains(&prefix.to_lowercase().as_str())
        || id.is_empty()
        || !id.chars().all(|c| c.is_ascii_digit())
    {
        return Ok(json!({"skipped":true,"reason":"not_linked"}));
    }
    let fs = FirestoreRest::from_env()
        .ok_or_else(|| ApiError::internal("Firebase Admin credentials are not configured."))?;
    let doc = integration::read_integration_doc(&fs, uid)
        .await
        .map_err(external_error)?;
    if !doc.exists || doc.data["enabled"] != true {
        return Ok(json!({"skipped":true,"reason":"not_connected"}));
    }
    let token = integration::decrypt_integration_token(&fs, uid)
        .await
        .map_err(external_error)?;
    let ct = CardTraderClient::new();
    if quantity.is_finite() && quantity > 0.0 {
        let _ = ct.update_product(&token, id, json!({"quantity":0})).await;
    }
    destroy_result(id, ct.destroy_product(&token, id).await)
}

/// A product CardTrader no longer has (404) is destroyed; any other failure
/// is an error so the outbox retries it. Reporting it as done (Node did) left
/// a deactivated listing for sale on CardTrader for good: the reconcile finds
/// the inactive row by its source and leaves it alone
/// (specs/tla/listing-outbox bugs/ghost-destroy-failure.cfg).
pub fn destroy_result(id: &str, result: Result<Value, pokoin_external::ApiError>) -> Result<Value, ApiError> {
    let gone = format!("{}404", pokoin_external::cardtrader::client::HTTP_ERROR_PREFIX);
    match result {
        Ok(_) => Ok(json!({"ok":true,"productId":id})),
        Err(e) if e.code.as_deref() == Some(gone.as_str()) => Ok(json!({"ok":true,"productId":id,"alreadyGone":true})),
        Err(e) => Err(external_error(e)),
    }
}
pub fn mutation(existing: &Value, body: &Value, status: &str) -> &'static str {
    let qty = body.get("quantityAvailable");
    let next = qty
        .map(number)
        .unwrap_or_else(|| number(&existing["quantity_available"]));
    if status == "sold_out" || (qty.is_some() && next <= 0.0) {
        return "LISTING_SOLD";
    }
    if status == "inactive" {
        return "LISTING_DELETED";
    }
    if status == "paused" {
        return "LISTING_DEACTIVATED";
    }
    if !field(existing, "status", 20).is_empty()
        && existing["status"] != "active"
        && status == "active"
    {
        return "LISTING_REACTIVATED";
    }
    if body.get("pricePkn").is_some() && number(&body["pricePkn"]) != number(&existing["price_pkn"])
    {
        return "LISTING_PRICE_CHANGED";
    }
    if qty.is_some() && next != number(&existing["quantity_available"]) {
        return "LISTING_QUANTITY_CHANGED";
    }
    if body.get("shippingAvailable").is_some() {
        return "LISTING_SHIPPING_ELIGIBILITY_CHANGED";
    }
    "LISTING_UPDATED"
}
pub fn merchant_snapshot(row: &Value) -> Value {
    let mut v = json!({});
    for (dest, keys) in [
        ("id", vec!["id"]),
        ("cardId", vec!["cardId", "card_id"]),
        ("sellerUid", vec!["sellerUid", "seller_uid"]),
        ("sellerName", vec!["sellerName", "seller_name"]),
        ("sellerCountry", vec!["sellerCountry", "seller_country"]),
        ("condition", vec!["condition"]),
        ("language", vec!["language"]),
        ("status", vec!["status"]),
        ("cardName", vec!["cardName", "card_name"]),
        ("cardImageUrl", vec!["cardImageUrl", "card_image_url"]),
        ("setName", vec!["setName", "set_name"]),
        (
            "collectorNumber",
            vec!["collectorNumber", "collector_number"],
        ),
        ("canonicalPath", vec!["canonicalPath", "canonical_path"]),
        ("source", vec!["source"]),
    ] {
        v[dest] = json!(first(row, &keys, 800));
    }
    v["sellerCountry"] = json!(field(&v, "sellerCountry", 40).to_uppercase());
    if v["condition"] == "" {
        v["condition"] = json!("NM");
    }
    if v["status"] == "" {
        v["status"] = json!("active");
    }
    for (dest, keys) in [
        ("pricePkn", ["pricePkn", "price_pkn"]),
        (
            "quantityAvailable",
            ["quantityAvailable", "quantity_available"],
        ),
    ] {
        let n = number(
            row.get(keys[0])
                .or_else(|| row.get(keys[1]))
                .unwrap_or(&Value::Null),
        );
        v[dest] = json_number(if n.is_finite() { n } else { 0.0 });
    }
    for key in ["sealed", "graded"] {
        v[key] = json!(row[key] == true);
    }
    v["shippingAvailable"] =
        json!(row["shippingAvailable"] != false && row["shipping_available"] != false);
    v["reserveAvailable"] =
        json!(row["reserveAvailable"] == true || row["reserve_available"] == true);
    let meta = &row["source_metadata"];
    let gtin = first(meta, &["gtin", "ean", "upc"], 240);
    v["gtin"] = json!(if gtin.is_empty() {
        field(row, "gtin", 240)
    } else {
        gtin
    });
    v["productType"] = json!(first(row, &["productType", "product_type"], 240));
    if v["productType"] == "" {
        v["productType"] = json!(field(meta, "productType", 240));
    }
    v
}
pub fn event(row: &Value, extra: &Value, now: i64) -> Option<Value> {
    let id = field(row, "id", 80);
    if id.is_empty() {
        return None;
    }
    let stamp = first(row, &["updatedAt", "updated_at"], 120);
    let stamp = if stamp.is_empty() {
        now.to_string()
    } else {
        stamp
    };
    let game = first(extra, &["game"], 40);
    let game = if game.is_empty() {
        "pokemon".to_string()
    } else {
        game
    };
    let seller = first(extra, &["sellerUid"], 160);
    let seller = if seller.is_empty() {
        first(row, &["sellerUid", "seller_uid"], 160)
    } else {
        seller
    };
    let mutation = first(extra, &["mutation"], 80);
    let mutation = if mutation.is_empty() {
        "LISTING_UPDATED".to_string()
    } else {
        mutation
    };
    Some(
        json!({"type":"listing.changed","aggregateId":id,"idempotencyKey":format!("listing.changed:{id}:{stamp}"),"payload":{"cardId":first(row,&["cardId","card_id"],80),"game":game,"sellerUid":seller,"listingId":id,"quantityAvailable":row.get("quantityAvailable").or_else(||row.get("quantity_available")).cloned().unwrap_or(Value::Null),"status":field(row,"status",20),"mutation":mutation,"merchantListing":merchant_snapshot(row),"wantsCardtrader":extra["wantsCardtrader"]==true,"destroyCardtrader":extra["destroyCardtrader"]==true,"sourceListingId":if field(extra,"sourceListingId",160).is_empty(){first(row,&["sourceListingId","source_listing_id"],160)}else{field(extra,"sourceListingId",160)},"listing":extra.get("cardtraderListing").cloned().unwrap_or(Value::Null),"steps":{}}}),
    )
}
fn is_missing_table(error: &sqlx::Error) -> bool {
    error.as_database_error().and_then(|e| e.code()).as_deref() == Some("42P01")
}
pub async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    event: Option<Value>,
) -> Result<bool, ApiError> {
    let Some(event) = event else { return Ok(false) };
    sqlx::query("savepoint pokoin_outbox")
        .execute(&mut **tx)
        .await?;
    let inserted = sqlx::query_scalar::<_, i64>(INSERT_SQL)
        .bind(field(&event, "type", 80))
        .bind(field(&event, "aggregateId", 160))
        .bind(&event["payload"])
        .bind(field(&event, "idempotencyKey", 240))
        .fetch_optional(&mut **tx)
        .await;
    match inserted {
        Ok(id) => {
            if let Some(id) = id {
                sqlx::query("select pg_notify('pokoin_outbox', $1)")
                    .bind(id.to_string())
                    .execute(&mut **tx)
                    .await?;
            }
            Ok(true)
        }
        Err(e) => {
            sqlx::query("rollback to savepoint pokoin_outbox")
                .execute(&mut **tx)
                .await?;
            if is_missing_table(&e) {
                Ok(false)
            } else {
                Err(e.into())
            }
        }
    }
}
pub async fn refresh_price(state: &DomainState, card: &str) -> Result<(), ApiError> {
    if !card.trim().is_empty() {
        sqlx::query("select public.refresh_marketplace_blueprint_price_summary($1)")
            .bind(card)
            .execute(state.write_db())
            .await?;
    }
    Ok(())
}
pub fn cache_keys(game: &str, card: &str, seller: &str) -> (Vec<String>, String) {
    let game = if game.is_empty() { "pokemon" } else { game };
    let mut scopes = vec![format!("search:{game}"), format!("home:{game}")];
    if !card.is_empty() {
        scopes.push(format!("card:{game}:{card}"));
    }
    if !seller.is_empty() {
        scopes.push(format!("seller-shop:{seller}"));
    }
    let keys = scopes
        .into_iter()
        .map(|s| format!("pokoin:marketplace:v1:gen:{s}"))
        .collect();
    let home = if game == "pokemon" {
        "pokoin:marketplace:v1:home:react".into()
    } else {
        format!("pokoin:marketplace:v1:home:react:game:{game}")
    };
    (keys, home)
}
pub async fn invalidate(state: &DomainState, game: &str, card: &str, seller: &str) {
    if std::env::var("POKOIN_READ_CACHE").as_deref() == Ok("0") {
        return;
    }
    let Some(mut redis) = state.redis() else {
        return;
    };
    let (keys, home) = cache_keys(game, card, seller);
    for key in keys {
        let _ = redis::cmd("INCR")
            .arg(key)
            .query_async::<i64>(&mut redis)
            .await;
    }
    let _ = redis::cmd("DEL")
        .arg(home)
        .query_async::<i64>(&mut redis)
        .await;
}
/// How long the consumer waits for the read replica before bumping anyway.
pub const REPLICA_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Wait until the read replica has replayed the writer's current WAL position
/// (the event's commit and its price refresh). A generation bumped earlier
/// lets a reader re-cache the replica's old row under the new generation
/// (specs/tla/listing-outbox NoStaleCacheAfterSync). Gives up after
/// REPLICA_WAIT; a read pool that is the writer itself has nothing to wait for.
pub async fn await_replica(state: &DomainState) -> bool {
    let target = match sqlx::query_scalar::<_, String>("select pg_current_wal_lsn()::text")
        .fetch_one(state.write_db())
        .await
    {
        Ok(lsn) => lsn,
        Err(_) => return false,
    };
    let deadline = std::time::Instant::now() + REPLICA_WAIT;
    loop {
        match sqlx::query_scalar::<_, Option<bool>>("select pg_last_wal_replay_lsn() >= $1::pg_lsn")
            .bind(&target)
            .fetch_one(state.read_db())
            .await
        {
            Ok(Some(true)) | Ok(None) => return true,
            Ok(Some(false)) => {}
            Err(_) => return false,
        }
        if std::time::Instant::now() >= deadline {
            tracing::warn!(lsn = %target, "listing sync: replica still behind; bumping read generations anyway");
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// What the CardTrader step does once the push claim was attempted.
#[derive(Debug, PartialEq, Eq)]
pub enum PushPlan {
    /// The row had no source and is now `ct:pending:<event>`: create it.
    Push,
    /// Linked already. Its product is destroyed by whoever saw it off sale:
    /// the deactivation's own event, or the destroy event the link enqueued.
    AlreadyLinked,
    /// Another push of this listing is in doubt; the reconcile links it.
    InDoubt,
    /// The listing row is gone.
    Missing,
}

/// Decide from the claim result and the row's source as it is now.
pub fn push_plan(claimed: bool, current_source: Option<&str>) -> PushPlan {
    match (claimed, current_source) {
        (true, _) => PushPlan::Push,
        (false, None) => PushPlan::Missing,
        (false, Some(source)) if ct_push::is_pending_source(source) => PushPlan::InDoubt,
        (false, Some(_)) => PushPlan::AlreadyLinked,
    }
}

const LINK_PUSH_SQL: &str = "with written as (update public.marketplace_user_listings set source_listing_id = $2, updated_at = now() where id = $1 and source_listing_id = $3 returning *) select to_jsonb(written) as listing from written";

const CLAIM_PUSH_SQL: &str = "update public.marketplace_user_listings set source_listing_id = $2, updated_at = now() where id = $1 and source_listing_id = '' returning id";
const RELEASE_PUSH_SQL: &str = "update public.marketplace_user_listings set source_listing_id = '', updated_at = now() where id = $1 and source_listing_id = $2";

/// The CardTrader push of a listing.changed event, at most once per listing:
/// the row moves from no source to `ct:pending:<event>` before CardTrader is
/// called (two workers, a lease that expired under a slow worker, or a retry
/// after a crash all lose that compare-and-set), and the product is linked over
/// that claim only. A listing deactivated while its push was in flight gets a
/// destroy event (specs/tla/listing-outbox AtMostOncePush, NoGhostProduct).
fn card_of(payload: &Value) -> String {
    field(payload, "cardId", 80)
}

async fn push_cardtrader(state: &DomainState, event_id: i64, seller: &str, payload: &mut Value) -> Result<(), ApiError> {
    let Ok(listing_id) = uuid::Uuid::parse_str(&field(payload, "listingId", 80)) else {
        // No row to claim (never produced by the handlers): the old push.
        let pushed = push_listing(state, seller, &payload["listing"], true).await?;
        payload["sourceListingId"] = json!(field(&pushed, "sourceListingId", 160));
        payload["steps"]["cardtrader"] = json!("pushed");
        return Ok(());
    };
    let pending = ct_push::pending_source(event_id);
    let claimed = sqlx::query_scalar::<_, uuid::Uuid>(CLAIM_PUSH_SQL)
        .bind(listing_id)
        .bind(&pending)
        .fetch_optional(state.write_db())
        .await?
        .is_some();
    let current = if claimed {
        None
    } else {
        sqlx::query_scalar::<_, String>("select source_listing_id from public.marketplace_user_listings where id = $1")
            .bind(listing_id)
            .fetch_optional(state.write_db())
            .await?
    };
    let plan = push_plan(claimed, current.as_deref());
    if plan != PushPlan::Push {
        payload["sourceListingId"] = json!(current.unwrap_or_default());
        payload["steps"]["cardtrader"] = json!(match plan {
            PushPlan::InDoubt => "push_in_doubt",
            PushPlan::Missing => "listing_missing",
            _ => "already_linked",
        });
        return Ok(());
    }
    let fs = FirestoreRest::from_env()
        .ok_or_else(|| ApiError::internal("Firebase Admin credentials are not configured."))?;
    let ct = CardTraderClient::new();
    match ct_push::push_product_outcome(&fs, &ct, seller, &payload["listing"]).await {
        PushOutcome::Created(pushed) => {
            let source = field(&pushed, "sourceListingId", 160);
            // Link over our claim and, when the listing went off sale while
            // CardTrader created it (or the claim is gone), queue its destroy
            // in the same transaction: an event of its own, retried by the
            // outbox, so it outlives this worker and its lease.
            let mut tx = state.write_db().begin().await?;
            let linked: Option<Value> = sqlx::query_scalar(LINK_PUSH_SQL)
                .bind(listing_id)
                .bind(&source)
                .bind(&pending)
                .fetch_optional(&mut *tx)
                .await?;
            let off_sale = linked.as_ref().is_none_or(|row| ct_push::off_sale(&field(row, "status", 20)));
            if off_sale {
                let row = linked.clone().unwrap_or_else(|| json!({"id": listing_id.to_string(), "card_id": card_of(payload), "seller_uid": seller}));
                let destroy = event(
                    &row,
                    &json!({"game": field(payload, "game", 40), "sellerUid": seller, "mutation": "LISTING_DELETED",
                            "destroyCardtrader": true, "sourceListingId": source}),
                    state.now_ms(),
                );
                enqueue(&mut tx, destroy).await?;
            }
            tx.commit().await?;
            if let Some(row) = &linked {
                let qty = row["quantity_available"].as_i64().unwrap_or(0) as i32;
                ct_push::upsert_push_link(state.write_db(), seller, &payload["listing"], &pushed, listing_id, seller, qty)
                    .await
                    .map_err(external_error)?;
            }
            payload["sourceListingId"] = json!(source);
            payload["steps"]["cardtrader"] = json!(if off_sale { "pushed_destroy_queued" } else { "pushed" });
            Ok(())
        }
        PushOutcome::Rejected(error) => {
            // Nothing was created: free the claim so a retry pushes again.
            sqlx::query(RELEASE_PUSH_SQL)
                .bind(listing_id)
                .bind(&pending)
                .execute(state.write_db())
                .await?;
            Err(external_error(error))
        }
        // The product may exist: keep ct:pending:<event>. The reconcile links
        // it by user_data_field; a retry never pushes a second one.
        PushOutcome::InDoubt(error) => Err(external_error(error)),
    }
}

pub async fn apply_event(state: &DomainState, event_id: i64, payload: &mut Value) -> Result<(), ApiError> {
    let card = field(payload, "cardId", 80);
    let game = field(payload, "game", 40);
    let seller = field(payload, "sellerUid", 160);
    if payload["steps"]["price"] != true && !card.is_empty() {
        refresh_price(state, &card).await?;
        payload["steps"]["price"] = json!(true);
    }
    // The outbox consumer only bumps card/search; the request already bumped
    // home and seller-shop generations when it committed the mutation.
    if std::env::var("POKOIN_READ_CACHE").as_deref() != Ok("0") {
        if let Some(mut redis) = state.redis() {
            await_replica(state).await;
            let game = if game.is_empty() { "pokemon" } else { &game };
            for scope in [format!("card:{game}:{card}"), format!("search:{game}")] {
                let _ = redis::cmd("INCR")
                    .arg(format!("pokoin:marketplace:v1:gen:{scope}"))
                    .query_async::<i64>(&mut redis)
                    .await;
            }
        }
    }
    pokoin_api_common::live::publish_listing(
        Some(&card),
        payload["listingId"].as_str(),
        Some(&seller),
        payload["quantityAvailable"].as_f64(),
        payload["status"].as_str(),
    );
    payload["steps"]["publishedAt"] = json!(state.now_ms());
    if payload["wantsCardtrader"] == true && payload["steps"]["cardtrader"].is_null() {
        if field(payload, "sourceListingId", 160).is_empty() {
            push_cardtrader(state, event_id, &seller, payload).await?;
        } else {
            payload["steps"]["cardtrader"] = json!("already_linked");
        }
    }
    if payload["destroyCardtrader"] == true
        && !field(payload, "sourceListingId", 160).is_empty()
        && payload["steps"]["destroyed"] != true
    {
        let _ = destroy_product(
            state,
            &seller,
            &field(payload, "sourceListingId", 160),
            number(&payload["quantityAvailable"]),
        )
        .await?;
        payload["steps"]["destroyed"] = json!(true);
    }
    Ok(())
}
static DRAINING: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);
struct DrainGuard;
impl Drop for DrainGuard {
    fn drop(&mut self) {
        DRAINING.store(false, Ordering::Release);
    }
}
pub async fn drain_once(state: &DomainState) -> Result<bool, ApiError> {
    if DRAINING.swap(true, Ordering::AcqRel) {
        return Ok(false);
    }
    let _guard = DrainGuard;
    let row = sqlx::query(CLAIM_SQL)
        .fetch_optional(state.write_db())
        .await?;
    let Some(row) = row else { return Ok(false) };
    let id: i64 = row.try_get("id")?;
    let attempts: i32 = row.try_get("attempts").unwrap_or(0);
    let mut payload: Value = row.try_get("payload")?;
    let result = if row.try_get::<String, _>("event_type")? == "listing.changed" {
        apply_event(state, id, &mut payload).await
    } else {
        Ok(())
    };
    match result {
        Ok(()) => {
            sqlx::query("update public.marketplace_outbox set processed_at = now(), last_error = null, payload = coalesce($2::jsonb, payload) where id = $1").bind(id).bind(payload).execute(state.write_db()).await?;
            Ok(true)
        }
        Err(e) => {
            if attempts >= MAX_ATTEMPTS {
                // CLAIM_SQL never picks it again (Node logged the same line).
                tracing::warn!(msg = "pokoin_sync_dead_letter", id, attempts, error = %e.message);
            }
            sqlx::query("update public.marketplace_outbox set last_error = $2, payload = coalesce($3::jsonb, payload) where id = $1").bind(id).bind(e.message.chars().take(500).collect::<String>()).bind(row.try_get::<Value,_>("payload")?).execute(state.write_db()).await?;
            Ok(false)
        }
    }
}
pub fn kick(state: &DomainState) {
    if std::env::var("POKOIN_LISTING_SYNC_WORKER").as_deref() == Ok("0") {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = drain_once(&state).await {
            tracing::warn!(error=%e,"listing sync failed");
        }
    });
}
pub fn start(state: &DomainState) {
    if cfg!(test)
        || std::env::var("POKOIN_LISTING_SYNC_WORKER").as_deref() == Ok("0")
        || std::env::var("NODE_TEST_CONTEXT").is_ok()
        || std::env::var("POKOIN_SYNC_CONSUMER").as_deref() == Ok("0")
        || STARTED.swap(true, Ordering::AcqRel)
    {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
        loop {
            interval.tick().await;
            let _ = drain_once(&state).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn targets_preserve_boolean_string_numeric_aliases() {
        assert_eq!(
            targets(&json!({})),
            json!({"pokoin":true,"cardtrader":false})
        );
        assert_eq!(
            targets(&json!({"pokoin":"false","cardtrader":1})),
            json!({"pokoin":false,"cardtrader":true})
        );
        assert_eq!(
            targets(&json!({"pokoin":0,"cardtrader":false})),
            json!({"pokoin":true,"cardtrader":false})
        );
    }
    #[test]
    fn product_body_converts_price_printing_and_facets() {
        let p=product_body(&json!({"id":"a","cardId":"220962","pricePkn":"200","quantityAvailable":"3","condition":"LP","language":"JA","reverse":true,"signed":true,"altered":true,"firstEdition":true,"sellerComment":"corner crease"})).unwrap();
        assert_eq!(
            p,
            json!({"blueprint_id":110481,"price":1,"quantity":3,"graded":false,"properties":{"condition":"Slightly Played","pokemon_language":"jp","signed":true,"altered":true,"pokemon_reverse":true,"pokemon_first_edition":true},"user_data_field":"pokoin:a","description":"corner crease"})
        );
        assert_eq!(blueprint("7"), Some(7));
        assert_eq!(blueprint("0"), None);
        assert!(product_body(&json!({"cardId":"abc","pricePkn":200})).is_err());
        assert!(product_body(&json!({"cardId":"20","pricePkn":0.1})).is_err());
    }
    #[test]
    fn mutation_priority_matches_node() {
        let e = json!({"quantity_available":5,"price_pkn":50,"status":"paused"});
        assert_eq!(
            mutation(&e, &json!({"quantityAvailable":0,"pricePkn":55}), ""),
            "LISTING_SOLD"
        );
        assert_eq!(
            mutation(&e, &json!({"pricePkn":55}), "active"),
            "LISTING_REACTIVATED"
        );
        assert_eq!(
            mutation(&e, &json!({"quantityAvailable":6,"pricePkn":55}), ""),
            "LISTING_PRICE_CHANGED"
        );
        assert_eq!(
            mutation(&e, &json!({"shippingAvailable":false}), ""),
            "LISTING_SHIPPING_ELIGIBILITY_CHANGED"
        );
    }
    #[test]
    fn event_contains_retryable_native_steps_and_snapshot() {
        let e=event(&json!({"id":"l1","card_id":"22","seller_uid":"u1","quantity_available":2,"status":"active","updated_at":"time"}),&json!({"game":"riftbound","sellerUid":"u1","mutation":"LISTING_CREATED","wantsCardtrader":true,"cardtraderListing":{"cardId":"22"}}),1).unwrap();
        assert_eq!(e["idempotencyKey"], "listing.changed:l1:time");
        assert_eq!(e["payload"]["steps"], json!({}));
        assert_eq!(e["payload"]["listing"]["cardId"], "22");
        assert_eq!(e["payload"]["merchantListing"]["quantityAvailable"], 2);
        assert!(event(&json!({}), &json!({}), 0).is_none());
    }
    #[test]
    fn push_claim_is_decided_from_the_row_as_it_is_now() {
        // specs/tla/listing-outbox: one push per listing, in-doubt pushes
        // left to the reconcile, off-sale listings lose their product.
        assert_eq!(push_plan(true, None), PushPlan::Push);
        assert_eq!(push_plan(false, None), PushPlan::Missing);
        assert_eq!(push_plan(false, Some("ct:pending:41")), PushPlan::InDoubt);
        assert_eq!(push_plan(false, Some("ct:444")), PushPlan::AlreadyLinked);
        assert!(LINK_PUSH_SQL.contains("source_listing_id = $3"), "link only over our own claim");
        assert_eq!(ct_push::pending_source(41), "ct:pending:41");
        // A pending marker is never a product id for removal, destroy or sync.
        assert_eq!(pokoin_external::cardtrader::sync_core::parse_ct_product_id("ct:pending:41"), "");
        assert!(CLAIM_SQL.contains("attempts < 8") && MAX_ATTEMPTS == 8);
    }
    #[test]
    fn destroy_failures_are_retried_unless_the_product_is_gone() {
        let gone = pokoin_external::ApiError::new(502, "CardTrader request failed with HTTP 404.").with_code("cardtrader_http_404");
        assert_eq!(destroy_result("7", Err(gone)).unwrap()["alreadyGone"], true);
        let down = pokoin_external::ApiError::new(502, "CardTrader request failed with HTTP 503.").with_code("cardtrader_http_503");
        assert!(destroy_result("7", Err(down)).is_err());
        let timeout = pokoin_external::ApiError::new(502, "CardTrader request failed: timeout").with_code("cardtrader_transport");
        assert!(destroy_result("7", Err(timeout)).is_err());
        assert_eq!(destroy_result("7", Ok(json!({}))).unwrap()["ok"], true);
    }
    #[test]
    fn mutation_cache_keys_match_shared_node_namespace() {
        let (keys, home) = cache_keys("riftbound", "801170", "u1");
        assert_eq!(
            keys,
            vec![
                "pokoin:marketplace:v1:gen:search:riftbound",
                "pokoin:marketplace:v1:gen:home:riftbound",
                "pokoin:marketplace:v1:gen:card:riftbound:801170",
                "pokoin:marketplace:v1:gen:seller-shop:u1"
            ]
        );
        assert_eq!(home, "pokoin:marketplace:v1:home:react:game:riftbound");
        assert_eq!(
            cache_keys("pokemon", "", "").1,
            "pokoin:marketplace:v1:home:react"
        );
    }
    #[tokio::test]
    async fn one_day_ready_rejected_before_any_http_write() {
        let fs = pokoin_external::firebase::MemoryFirestore::new();
        fs.seed(
            "seller_integrations",
            &integration::integration_doc_id("u1"),
            json!({"enabled":true,"metadata":{"oneDayReady":true}}),
        )
        .await;
        let err = push_product(
            &fs,
            &CardTraderClient::with_base("http://127.0.0.1:1".into()),
            "u1",
            &json!({"cardId":"22","pricePkn":200}),
        )
        .await
        .unwrap_err();
        assert_eq!(err.status.as_u16(), 409);
        assert!(err.message.contains("1-Day Ready"));
    }
    #[tokio::test]
    async fn native_cardtrader_push_decrypts_and_sends_real_product() {
        use axum::{extract::State, routing::post, Json, Router};
        use std::sync::Arc;
        let received = Arc::new(tokio::sync::Mutex::new(Value::Null));
        let app = Router::new()
            .route(
                "/products",
                post(
                    |State(got): State<Arc<tokio::sync::Mutex<Value>>>,
                     headers: axum::http::HeaderMap,
                     Json(body): Json<Value>| async move {
                        assert_eq!(headers["authorization"], "Bearer test-native-token");
                        *got.lock().await = body;
                        Json(json!({"resource":{"id":444}}))
                    },
                ),
            )
            .with_state(received.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let prior = std::env::var("CARDTRADER_TOKEN_ENCRYPTION_KEY").ok();
        std::env::set_var("CARDTRADER_TOKEN_ENCRYPTION_KEY", key);
        let fs = pokoin_external::firebase::MemoryFirestore::new();
        fs.seed("seller_integrations",&integration::integration_doc_id("u1"),json!({"enabled":true,"encryptedToken":pokoin_external::crypto::encrypt_secret("test-native-token",Some(key))})).await;
        let pushed = push_product(
            &fs,
            &CardTraderClient::with_base(format!("http://{address}")),
            "u1",
            &json!({"cardId":"220962","pricePkn":200,"quantityAvailable":2}),
        )
        .await
        .unwrap();
        server.abort();
        if let Some(v) = prior {
            std::env::set_var("CARDTRADER_TOKEN_ENCRYPTION_KEY", v);
        } else {
            std::env::remove_var("CARDTRADER_TOKEN_ENCRYPTION_KEY");
        }
        assert_eq!(
            pushed,
            json!({"productId":"444","sourceListingId":"ct:444"})
        );
        assert_eq!(received.lock().await["blueprint_id"], 110481);
    }
}
