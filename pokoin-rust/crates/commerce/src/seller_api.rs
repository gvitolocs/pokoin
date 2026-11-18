//! Seller API grants, the seller event log and signed outbound webhooks.
//!
//! A grant is a revocable token a seller hands to an inventory tool (Card
//! Rails, or any other platform) in place of their sign-in. It works like a
//! CardTrader API application: the tool reads its shared secret and sets its
//! webhook URL through the API, and Pokoin posts every stock and order event
//! there with `Signature: base64(HMAC-SHA256(raw body, shared secret))`.
//!
//! Events are logged per seller before they are delivered, so a tool that
//! missed a webhook reads the same events back with a cursor.
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::http::HeaderMap;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::{PgPool, Row};

use crate::{error::ApiError, state::DomainState};

pub const TOKEN_PREFIX: &str = "pkn_";
pub const SCOPE_CARDRAILS: &str = "cardrails:stock";
pub const SCOPE_STOCK: &str = "seller:stock";
/// The TCGplayer sync box. Not a stock connector: it cannot call seller-api/v1.
pub const SCOPE_CHANNEL_TCGPLAYER: &str = "channel:tcgplayer";
pub const CLIENT_CARDRAILS: &str = "cardrails";
pub const CLIENT_TCGPLAYER_BOX: &str = "tcgplayer-sync-box";
/// Live grants one seller can hold.
pub const MAX_GRANTS: i64 = 10;
/// CLAIM_SQL's `attempts < 8`.
pub const MAX_ATTEMPTS: i32 = 8;
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);
const EVENT_RETENTION_DAYS: i32 = 90;

const CLAIM_SQL: &str = "update public.seller_webhook_deliveries as d set attempts = d.attempts + 1, \
     available_at = now() + interval '30 seconds' * power(4, least(d.attempts, 6)) \
     where d.id = (select id from public.seller_webhook_deliveries where delivered_at is null \
     and available_at <= now() and attempts < 8 order by id for update skip locked limit 1) \
     returning d.id, d.grant_id, d.event_pk, d.attempts";

const LOG_SQL: &str = "with ev as (insert into public.seller_api_events (seller_uid, event_id, cause, body) \
     select $1, $2, $3, $4 where exists (select 1 from public.seller_api_grants \
     where seller_uid = $1 and revoked_at is null) \
     on conflict (seller_uid, event_id) do nothing returning id) \
     insert into public.seller_webhook_deliveries (grant_id, event_pk) \
     select g.id, ev.id from ev, public.seller_api_grants g \
     where g.seller_uid = $1 and g.revoked_at is null and g.webhook_url <> '' \
     on conflict (grant_id, event_pk) do nothing";

#[derive(Debug, Clone)]
pub struct Grant {
    pub id: uuid::Uuid,
    pub seller_uid: String,
    pub client: String,
    pub label: String,
    pub scope: String,
    pub webhook_url: String,
    shared_secret: Value,
}

impl Grant {
    /// The webhook signing secret, decrypted.
    pub fn shared_secret(&self) -> Result<String, ApiError> {
        open_secret(&self.shared_secret)
    }
}

pub fn is_missing_table(error: &sqlx::Error) -> bool {
    error.as_database_error().and_then(|e| e.code()).as_deref() == Some("42P01")
}

/// A database error on a grant route. The tables arrive with migration 115;
/// before it the routes answer 503 instead of a generic 500.
pub fn store_error(error: sqlx::Error) -> ApiError {
    if is_missing_table(&error) {
        return ApiError::unavailable("The seller API is not enabled yet.").with_code("seller_api_disabled");
    }
    error.into()
}

fn encryption_key() -> Option<String> {
    std::env::var("CARDTRADER_TOKEN_ENCRYPTION_KEY").ok().filter(|v| !v.trim().is_empty())
}

pub fn seal_secret(secret: &str) -> Result<Value, ApiError> {
    pokoin_external::crypto::encrypt_secret(secret, encryption_key().as_deref())
        .ok_or_else(|| ApiError::internal("Seller API secrets cannot be stored: no encryption key."))
}

pub fn open_secret(sealed: &Value) -> Result<String, ApiError> {
    pokoin_external::crypto::decrypt_secret(sealed, encryption_key().as_deref())
        .map_err(|_| ApiError::internal("Seller API secret could not be read."))
}

/// `pkn_` plus 32 random bytes, base64url.
pub fn new_token() -> String {
    format!("{TOKEN_PREFIX}{}", pokoin_external::crypto::random_secret(32, &mut rand::thread_rng()))
}

pub fn new_shared_secret() -> String {
    pokoin_external::crypto::random_secret(32, &mut rand::thread_rng())
}

pub fn token_hash(token: &str) -> String {
    pokoin_external::crypto::sha256_hex(token.as_bytes())
}

/// What the seller sees in their list of grants: enough to tell tokens apart.
pub fn token_prefix(token: &str) -> String {
    token.chars().take(TOKEN_PREFIX.len() + 6).collect()
}

/// `card rails` → `card-rails`; letters, digits and dashes only.
pub fn clean_client(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    match out.as_str() {
        "card-rails" | "cardrail" | "card-rail" => CLIENT_CARDRAILS.into(),
        _ => out,
    }
}

pub fn scope_for(client: &str) -> &'static str {
    if client == CLIENT_CARDRAILS {
        SCOPE_CARDRAILS
    } else if client == CLIENT_TCGPLAYER_BOX {
        SCOPE_CHANNEL_TCGPLAYER
    } else {
        SCOPE_STOCK
    }
}

/// Stock connectors refuse a channel-sync box token. Card Rails still requires
/// its own scope; the generic connector still accepts every other grant.
pub fn connector_scope_ok(scope: &str, cardrails: bool) -> bool {
    if scope == SCOPE_CHANNEL_TCGPLAYER {
        return false;
    }
    !cardrails || scope == SCOPE_CARDRAILS
}

/// A grant just created. `token` and `shared_secret` are shown once; the row
/// keeps the hash and the sealed secret.
pub struct IssuedGrant {
    pub id: uuid::Uuid,
    pub client: String,
    pub label: String,
    pub scope: String,
    pub token_prefix: String,
    pub webhook_url: String,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_used_at: Option<chrono::DateTime<chrono::Utc>>,
    pub token: String,
    pub shared_secret: String,
}

impl IssuedGrant {
    /// The JSON `POST /api/seller-api-grants` returns for `action: create`.
    pub fn public_json(&self) -> Value {
        let stamp = |at: Option<chrono::DateTime<chrono::Utc>>| {
            at.map(|t| json!(t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)))
                .unwrap_or(Value::Null)
        };
        json!({
            "grant": {
                "id": self.id.to_string(),
                "client": self.client,
                "label": self.label,
                "scope": self.scope,
                "tokenPrefix": self.token_prefix,
                "webhookUrl": self.webhook_url,
                "createdAt": stamp(self.created_at),
                "lastUsedAt": stamp(self.last_used_at),
            },
            "token": self.token,
            "sharedSecret": self.shared_secret,
        })
    }
}

/// Insert one live grant for `client`, or 409 when the seller is at the cap.
/// The caller has already cleaned `client`.
pub async fn issue_grant(state: &DomainState, uid: &str, client: &str, label: &str) -> Result<IssuedGrant, ApiError> {
    let token = new_token();
    let secret = new_shared_secret();
    let sealed = seal_secret(&secret)?;
    let row = sqlx::query(
        "insert into public.seller_api_grants (seller_uid, client, label, scope, token_hash, token_prefix, shared_secret) \
         select $1, $2, $3, $4, $5, $6, $7 where (select count(*) from public.seller_api_grants \
         where seller_uid = $1 and revoked_at is null) < $8 \
         returning id, client, label, scope, token_prefix, webhook_url, created_at, last_used_at",
    )
    .bind(uid)
    .bind(client)
    .bind(label)
    .bind(scope_for(client))
    .bind(token_hash(&token))
    .bind(token_prefix(&token))
    .bind(sealed)
    .bind(MAX_GRANTS)
    .fetch_optional(state.write_db())
    .await
    .map_err(store_error)?
    .ok_or_else(|| ApiError::conflict("Revoke a token before creating another.").with_code("grant_limit"))?;
    Ok(IssuedGrant {
        id: row.try_get("id").map_err(store_error)?,
        client: row.try_get("client").map_err(store_error)?,
        label: row.try_get("label").map_err(store_error)?,
        scope: row.try_get("scope").map_err(store_error)?,
        token_prefix: row.try_get("token_prefix").map_err(store_error)?,
        webhook_url: row.try_get("webhook_url").map_err(store_error)?,
        created_at: row.try_get("created_at").map_err(store_error)?,
        last_used_at: row.try_get("last_used_at").map_err(store_error)?,
        token,
        shared_secret: secret,
    })
}

/// `Signature` header value: base64 HMAC-SHA256 of the exact bytes posted.
pub fn sign(body: &[u8], secret: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret.as_bytes()).expect("hmac takes any key length");
    mac.update(body);
    B64.encode(mac.finalize().into_bytes())
}

/// An address Pokoin may post to: not this host, not a private network.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (64..128).contains(&o[1]))
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 198 && (18..20).contains(&o[1]))
                || o[0] >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

/// A webhook URL a grant may register. Empty clears it. HTTPS on the default
/// port to a named public host: no IP literals, credentials or local names.
pub fn clean_webhook_url(raw: &str) -> Result<String, ApiError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(String::new());
    }
    let refuse = |message: &str| ApiError::bad_request(message).with_code("webhook_url_invalid");
    if raw.len() > 500 {
        return Err(refuse("Webhook URL is too long."));
    }
    let url = reqwest::Url::parse(raw).map_err(|_| refuse("Webhook URL is not a valid URL."))?;
    if url.scheme() != "https" {
        return Err(refuse("Webhook URL must use https."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(refuse("Webhook URL must not contain credentials."));
    }
    if url.port().is_some_and(|port| port != 443) {
        return Err(refuse("Webhook URL must use the default https port."));
    }
    let host = url.host_str().unwrap_or_default().trim_end_matches('.').to_lowercase();
    if host.starts_with('[') || host.parse::<IpAddr>().is_ok() {
        return Err(refuse("Webhook URL must name a host, not an IP address."));
    }
    if !host.contains('.')
        || ["localhost", "local", "internal", "lan", "home", "test", "invalid"]
            .iter()
            .any(|tld| host == *tld || host.ends_with(&format!(".{tld}")))
    {
        return Err(refuse("Webhook URL must be a public host."));
    }
    Ok(url.to_string())
}

fn grant_from_row(row: &sqlx::postgres::PgRow) -> Result<Grant, sqlx::Error> {
    Ok(Grant {
        id: row.try_get("id")?,
        seller_uid: row.try_get("seller_uid")?,
        client: row.try_get("client")?,
        label: row.try_get("label")?,
        scope: row.try_get("scope")?,
        webhook_url: row.try_get("webhook_url")?,
        shared_secret: row.try_get("shared_secret")?,
    })
}

/// The live grant behind a `Bearer pkn_…` header. Read on the writer so a
/// revoked token stops working at once.
pub async fn authenticate(state: &DomainState, headers: &HeaderMap) -> Result<Grant, ApiError> {
    let header = headers.get("authorization").and_then(|h| h.to_str().ok());
    let token = crate::auth::bearer(header).map_err(|_| {
        ApiError::unauthorized("Missing Pokoin API token.").with_code("seller_api/missing-token")
    })?;
    let refused = || ApiError::unauthorized("Invalid or revoked Pokoin API token.").with_code("seller_api/invalid-token");
    let token = token.trim();
    if !token.starts_with(TOKEN_PREFIX) || token.len() > 200 {
        return Err(refused());
    }
    let row = sqlx::query(
        "select id, seller_uid, client, label, scope, webhook_url, shared_secret, \
         (last_used_at is null or last_used_at < now() - interval '5 minutes') as stale \
         from public.seller_api_grants where token_hash = $1 and revoked_at is null",
    )
    .bind(token_hash(token))
    .fetch_optional(state.write_db())
    .await
    .map_err(store_error)?
    .ok_or_else(refused)?;
    let grant = grant_from_row(&row).map_err(store_error)?;
    if row.try_get::<bool, _>("stale").unwrap_or(false) {
        let _ = sqlx::query("update public.seller_api_grants set last_used_at = now() where id = $1")
            .bind(grant.id)
            .execute(state.write_db())
            .await;
    }
    Ok(grant)
}

/// The JSON a webhook carries and the event log stores. Same envelope as a
/// CardTrader webhook: `id`, `time`, `cause`, `object_class`, `object_id`,
/// `mode`, `data`.
pub fn envelope(event_id: &str, cause: &str, object_class: &str, object_id: &str, data: Value, now_ms: i64) -> String {
    json!({
        "id": event_id,
        "time": now_ms / 1000,
        "cause": cause,
        "object_class": object_class,
        "object_id": object_id,
        "mode": "live",
        "data": data,
    })
    .to_string()
}

/// Log an event for a seller and queue it for every grant with a webhook.
/// Sellers without a live grant log nothing. Repeating an `event_id` is a
/// no-op, so callers that retry never deliver twice.
pub async fn log_event(
    db: &PgPool,
    seller_uid: &str,
    event_id: &str,
    cause: &str,
    object_class: &str,
    object_id: &str,
    data: Value,
    now_ms: i64,
) -> Result<u64, sqlx::Error> {
    if seller_uid.trim().is_empty() || event_id.is_empty() {
        return Ok(0);
    }
    let body = envelope(event_id, cause, object_class, object_id, data, now_ms);
    match sqlx::query(LOG_SQL).bind(seller_uid).bind(event_id).bind(cause).bind(body).execute(db).await {
        Ok(done) => Ok(done.rows_affected()),
        Err(error) if is_missing_table(&error) => Ok(0),
        Err(error) => Err(error),
    }
}

/// `listing.changed` outbox mutation → webhook cause.
pub fn listing_cause(mutation: &str) -> &'static str {
    match mutation {
        "LISTING_CREATED" => "listing.create",
        "LISTING_DELETED" => "listing.destroy",
        _ => "listing.update",
    }
}

/// The listing a `listing.*` event describes, from the outbox payload.
pub fn listing_data(payload: &Value) -> Value {
    let listing = &payload["merchantListing"];
    json!({
        "listing_id": payload["listingId"],
        "card_id": payload["cardId"],
        "game": payload["game"],
        "quantity": payload["quantityAvailable"],
        "status": payload["status"],
        "mutation": payload["mutation"],
        "price_pkn": listing["pricePkn"],
        "condition": listing["condition"],
        "language": listing["language"],
        "name": listing["cardName"],
        "set_name": listing["setName"],
        "collector_number": listing["collectorNumber"],
    })
}

/// Log the listing event of one outbox row.
pub async fn log_listing_event(state: &DomainState, outbox_id: i64, payload: &Value) -> Result<u64, sqlx::Error> {
    let seller = crate::listing_live::field(payload, "sellerUid", 160);
    let listing = crate::listing_live::field(payload, "listingId", 80);
    let cause = listing_cause(payload["mutation"].as_str().unwrap_or_default());
    log_event(
        state.write_db(),
        &seller,
        &format!("listing:{outbox_id}"),
        cause,
        "Listing",
        &listing,
        listing_data(payload),
        state.now_ms(),
    )
    .await
}

/// One seller's part of a paid order, shaped like a CardTrader order: the
/// lines carry the Pokoin listing id a tool mapped its stock to.
pub fn order_data(order_id: &str, state_label: &str, at: &str, lines: &[&Value]) -> Value {
    let currency = lines.first().map(|line| line["currency"].clone()).unwrap_or(Value::Null);
    json!({
        "id": order_id,
        "code": order_id,
        "state": state_label,
        "paid_at": at,
        "placed_at": at,
        "currency": currency,
        "order_items": lines.iter().enumerate().map(|(index, line)| json!({
            "id": format!("{order_id}:{}:{index}", line["listingId"].as_str().unwrap_or_default()),
            "listing_id": line["listingId"],
            "card_id": line["cardId"],
            "name": line["cardName"],
            "quantity": line["quantity"],
            "unit_price_pkn": line["unitPricePkn"],
            "condition": line["condition"],
            "language": line["language"],
        })).collect::<Vec<_>>(),
    })
}

/// `order.create` for every seller on a paid order. `sales` are the
/// `marketplace_sales` documents just written for it. Best effort: the sale
/// is already recorded, and a failure here is logged, not returned.
pub async fn log_order_paid(state: &DomainState, order_id: &str, sales: &[Value]) {
    let mut sellers: Vec<&str> = sales.iter().filter_map(|sale| sale["sellerUid"].as_str()).collect();
    sellers.sort_unstable();
    sellers.dedup();
    let at = state.now_iso();
    for seller in sellers {
        let lines: Vec<&Value> = sales.iter().filter(|sale| sale["sellerUid"] == seller).collect();
        let logged = log_event(
            state.write_db(),
            seller,
            &format!("order.create:{order_id}"),
            "order.create",
            "Order",
            order_id,
            order_data(order_id, "paid", &at, &lines),
            state.now_ms(),
        )
        .await;
        if let Err(error) = logged {
            tracing::warn!(%error, order_id, "seller api: order.create not logged");
        }
    }
}

/// `order.destroy`: the seller refunded the order and its sales were voided.
pub async fn log_order_cancelled(state: &DomainState, order_id: &str, seller_uid: &str) {
    let at = state.now_iso();
    let data = json!({"id": order_id, "code": order_id, "state": "canceled", "cancelled_at": at});
    let logged = log_event(
        state.write_db(),
        seller_uid,
        &format!("order.destroy:{order_id}"),
        "order.destroy",
        "Order",
        order_id,
        data,
        state.now_ms(),
    )
    .await;
    if let Err(error) = logged {
        tracing::warn!(%error, order_id, "seller api: order.destroy not logged");
    }
}

/// Where a webhook is posted: the host and one public address it resolves
/// to. The request is pinned to that address, so a name that later resolves
/// to a private network is never followed.
async fn resolve_target(url: &reqwest::Url) -> Result<(String, SocketAddr), String> {
    let host = url.host_str().ok_or("webhook url has no host")?.to_string();
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 443))
        .await
        .map_err(|error| format!("dns: {error}"))?
        .collect();
    if addresses.is_empty() {
        return Err("dns: no address".into());
    }
    if let Some(private) = addresses.iter().find(|address| !public_ip(address.ip())) {
        return Err(format!("refused: {host} resolves to non-public {}", private.ip()));
    }
    Ok((host, addresses[0]))
}

/// Post one signed body. `Ok(status)` is whatever the receiver answered.
pub async fn post_signed(url: &str, body: &str, secret: &str, cause: &str, delivery: &str) -> Result<u16, String> {
    let url = reqwest::Url::parse(url).map_err(|_| "webhook url invalid".to_string())?;
    let (host, address) = resolve_target(&url).await?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(DELIVERY_TIMEOUT)
        .resolve(&host, address)
        .build()
        .map_err(|error| format!("client: {error}"))?;
    let response = client
        .post(url)
        .header("content-type", "application/json")
        .header("user-agent", "Pokoin-Webhooks/1")
        .header("signature", sign(body.as_bytes(), secret))
        .header("x-pokoin-event", cause)
        .header("x-pokoin-delivery", delivery)
        .body(body.to_string())
        .send()
        .await
        .map_err(|error| if error.is_timeout() { "timeout".to_string() } else { format!("send: {error}") })?;
    Ok(response.status().as_u16())
}

/// Deliver one due webhook. `Ok(true)` when a row was claimed, whatever the
/// receiver answered; the claim already pushed its next attempt back.
pub async fn deliver_once(state: &DomainState) -> Result<bool, sqlx::Error> {
    let db = state.write_db();
    let Some(claim) = sqlx::query(CLAIM_SQL).fetch_optional(db).await? else {
        return Ok(false);
    };
    let id: i64 = claim.try_get("id")?;
    let attempts: i32 = claim.try_get("attempts").unwrap_or(0);
    let target = sqlx::query(
        "select g.webhook_url, g.shared_secret, g.revoked_at is not null as revoked, e.cause, e.body \
         from public.seller_api_grants g, public.seller_api_events e where g.id = $1 and e.id = $2",
    )
    .bind(claim.try_get::<uuid::Uuid, _>("grant_id")?)
    .bind(claim.try_get::<i64, _>("event_pk")?)
    .fetch_optional(db)
    .await?;
    let outcome: Result<u16, String> = match &target {
        None => Err("skipped: grant or event gone".into()),
        Some(row) if row.try_get::<bool, _>("revoked").unwrap_or(true) => Err("skipped: grant revoked".into()),
        Some(row) => {
            let url: String = row.try_get("webhook_url")?;
            let cause: String = row.try_get("cause")?;
            let body: String = row.try_get("body")?;
            match open_secret(&row.try_get::<Value, _>("shared_secret")?) {
                _ if url.is_empty() => Err("skipped: no webhook url".into()),
                Err(_) => Err("skipped: secret unreadable".into()),
                Ok(secret) => post_signed(&url, &body, &secret, &cause, &id.to_string()).await,
            }
        }
    };
    let (delivered, status, error) = match outcome {
        Ok(status) if (200..300).contains(&status) => (true, Some(i32::from(status)), None),
        Ok(status) => (false, Some(i32::from(status)), Some(format!("http {status}"))),
        // Nothing to retry: the grant, its URL or the event is gone.
        Err(reason) if reason.starts_with("skipped") => (true, None, Some(reason)),
        Err(reason) => (false, None, Some(reason)),
    };
    if !delivered && attempts >= MAX_ATTEMPTS {
        tracing::warn!(msg = "seller_webhook_dead_letter", id, attempts, error = error.as_deref().unwrap_or(""));
    }
    sqlx::query(
        "update public.seller_webhook_deliveries set delivered_at = case when $2 then now() else null end, \
         last_status = $3, last_error = $4 where id = $1",
    )
    .bind(id)
    .bind(delivered)
    .bind(status)
    .bind(error.map(|text| text.chars().take(300).collect::<String>()))
    .execute(db)
    .await?;
    Ok(true)
}

async fn prune(db: &PgPool) {
    let _ = sqlx::query("delete from public.seller_api_events where created_at < now() - make_interval(days => $1)")
        .bind(EVENT_RETENTION_DAYS)
        .execute(db)
        .await;
}

static STARTED: AtomicBool = AtomicBool::new(false);

/// The delivery worker: one webhook at a time, off the request path. Several
/// API instances share the queue through `for update skip locked`.
pub fn start(state: &DomainState) {
    if cfg!(test)
        || std::env::var("POKOIN_SELLER_WEBHOOK_WORKER").as_deref() == Ok("0")
        || std::env::var("NODE_TEST_CONTEXT").is_ok()
        || STARTED.swap(true, Ordering::AcqRel)
    {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        let mut last_prune = std::time::Instant::now();
        loop {
            let idle = match deliver_once(&state).await {
                Ok(true) => continue,
                Ok(false) => Duration::from_secs(2),
                // Migration 115 not applied yet: look again in a minute.
                Err(error) if is_missing_table(&error) => Duration::from_secs(60),
                Err(error) => {
                    tracing::warn!(%error, "seller webhook delivery failed");
                    Duration::from_secs(10)
                }
            };
            if last_prune.elapsed() > Duration::from_secs(3600) {
                last_prune = std::time::Instant::now();
                prune(state.write_db()).await;
            }
            tokio::time::sleep(idle).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_matches_the_cardtrader_scheme_receivers_verify() {
        // The same check Card Rails and Pokoin's own CardTrader receiver run.
        let body = br#"{"id":"order.create:o1","cause":"order.create"}"#;
        let signature = sign(body, "shared");
        assert!(pokoin_external::crypto::verify_webhook_signature(body, &signature, "shared"));
        assert!(!pokoin_external::crypto::verify_webhook_signature(body, &signature, "other"));
        assert!(!pokoin_external::crypto::verify_webhook_signature(b"{}", &signature, "shared"));
    }

    #[test]
    fn tokens_are_prefixed_unique_and_stored_only_as_a_hash() {
        let (a, b) = (new_token(), new_token());
        assert!(a.starts_with("pkn_") && a.len() == 4 + 43);
        assert_ne!(a, b);
        assert_eq!(token_hash(&a).len(), 64);
        assert_ne!(token_hash(&a), token_hash(&b));
        assert_eq!(token_prefix(&a).len(), 10);
    }

    #[test]
    fn client_names_normalize_and_pick_their_scope() {
        assert_eq!(clean_client(" Card Rails "), "cardrails");
        assert_eq!(clean_client("CardRails"), "cardrails");
        assert_eq!(clean_client("My Tool!! v2"), "my-tool-v2");
        assert_eq!(clean_client("***"), "");
        assert_eq!(scope_for("cardrails"), SCOPE_CARDRAILS);
        assert_eq!(scope_for("my-tool"), SCOPE_STOCK);
        assert_eq!(scope_for(CLIENT_TCGPLAYER_BOX), SCOPE_CHANNEL_TCGPLAYER);
    }

    #[test]
    fn channel_box_scope_cannot_call_the_stock_connector() {
        assert!(!connector_scope_ok(SCOPE_CHANNEL_TCGPLAYER, false));
        assert!(!connector_scope_ok(SCOPE_CHANNEL_TCGPLAYER, true));
        assert!(connector_scope_ok(SCOPE_STOCK, false));
        assert!(connector_scope_ok(SCOPE_CARDRAILS, false));
        assert!(connector_scope_ok(SCOPE_CARDRAILS, true));
        assert!(!connector_scope_ok(SCOPE_STOCK, true));
    }

    #[test]
    fn webhook_urls_must_be_https_on_a_public_named_host() {
        assert_eq!(clean_webhook_url("  ").unwrap(), "");
        assert_eq!(
            clean_webhook_url("https://cardrails.vercel.app/api/v1/hooks?workspace=w1").unwrap(),
            "https://cardrails.vercel.app/api/v1/hooks?workspace=w1"
        );
        for refused in [
            "http://example.com/hook",
            "https://127.0.0.1/hook",
            "https://[::1]/hook",
            "https://192.168.178.55/hook",
            "https://localhost/hook",
            "https://nezopt/hook",
            "https://printer.local/hook",
            "https://db.internal/hook",
            "https://user:pass@example.com/hook",
            "https://example.com:8443/hook",
            "ftp://example.com/hook",
            "not a url",
        ] {
            assert!(clean_webhook_url(refused).is_err(), "{refused} must be refused");
        }
    }

    #[test]
    fn only_public_addresses_are_posted_to() {
        for private in [
            "127.0.0.1", "10.0.0.5", "192.168.178.55", "172.16.3.1", "169.254.169.254", "100.64.0.1",
            "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "198.18.0.1", "240.0.0.1",
        ] {
            assert!(!public_ip(private.parse().unwrap()), "{private} must be refused");
        }
        for public in ["1.1.1.1", "76.76.21.21", "2606:4700:4700::1111"] {
            assert!(public_ip(public.parse().unwrap()), "{public} must be allowed");
        }
    }

    #[test]
    fn envelope_has_the_cardtrader_webhook_fields() {
        let body: Value = serde_json::from_str(&envelope("e1", "order.create", "Order", "o1", json!({"id":"o1"}), 1_700_000_000_500)).unwrap();
        assert_eq!(body, json!({"id":"e1","time":1_700_000_000,"cause":"order.create","object_class":"Order","object_id":"o1","mode":"live","data":{"id":"o1"}}));
    }

    #[test]
    fn listing_events_carry_the_absolute_quantity() {
        let payload = json!({"listingId":"l1","cardId":"220962","game":"pokemon","sellerUid":"u1","quantityAvailable":2,"status":"active","mutation":"LISTING_QUANTITY_CHANGED","merchantListing":{"pricePkn":400,"condition":"NM","language":"EN","cardName":"Espurr","setName":"Set","collectorNumber":"1/2"}});
        assert_eq!(listing_cause("LISTING_QUANTITY_CHANGED"), "listing.update");
        assert_eq!(listing_cause("LISTING_SOLD"), "listing.update");
        assert_eq!(listing_cause("LISTING_CREATED"), "listing.create");
        assert_eq!(listing_cause("LISTING_DELETED"), "listing.destroy");
        let data = listing_data(&payload);
        assert_eq!(data["listing_id"], "l1");
        assert_eq!(data["quantity"], 2);
        assert_eq!(data["price_pkn"], 400);
    }

    #[test]
    fn order_data_keeps_only_the_lines_given_and_names_each_line() {
        let a = json!({"listingId":"l1","cardId":"1","cardName":"A","quantity":2,"unitPricePkn":400,"currency":"PKN","sellerUid":"u1"});
        let b = json!({"listingId":"l2","cardId":"2","cardName":"B","quantity":1,"unitPricePkn":200,"currency":"PKN","sellerUid":"u1"});
        let data = order_data("o1", "paid", "2026-10-11T00:00:00Z", &[&a, &b]);
        assert_eq!(data["code"], "o1");
        assert_eq!(data["order_items"].as_array().unwrap().len(), 2);
        assert_eq!(data["order_items"][0]["id"], "o1:l1:0");
        assert_eq!(data["order_items"][1]["listing_id"], "l2");
        assert_eq!(data["order_items"][1]["quantity"], 1);
        // Never the buyer.
        assert!(data.get("buyer").is_none());
    }
}
