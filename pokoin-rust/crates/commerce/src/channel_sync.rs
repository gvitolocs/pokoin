//! TCGplayer channel sync: the seller's device, the job queue, and orders.
//!
//! Listing changes already land in the outbox. [`enqueue_for_event`] turns an
//! eligible Pokémon single into absolute jobs (`push_listing`, `set_qty`,
//! `set_price`). The box claims them, writes the Seller Portal, and completes
//! with the lease token it was given. This module never talks to TCGplayer
//! and never sees a portal password or cookie.
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::listing_live::{field, number};
use crate::listing_sync;
use crate::seller_api::{self, Grant};
use crate::{error::ApiError, state::DomainState};

use pokoin_external::cardtrader::sync_core::PKN_USDT_PRICE;

pub const CHANNEL_TCGPLAYER: &str = "tcgplayer";
pub const MAX_ATTEMPTS: i32 = 8;
pub const LEASE_SECONDS: i64 = 300;
pub const MAX_CLAIM: i64 = 20;
pub const ONLINE_SECONDS: i64 = 90;
pub const PULL_ORDERS_EVERY_SECONDS: i64 = 600;
pub const MAX_ORDERS_PER_POST: usize = 200;
const POLL_AFTER_MS: u64 = 30_000;
const MAX_ERROR_CHARS: usize = 500;
const MAX_ORDER_ID_CHARS: usize = 80;
const MAX_BUYER_CHARS: usize = 120;
const MAX_STATUS_CHARS: usize = 40;
const MAX_METHOD_CHARS: usize = 80;
const MAX_LINES: usize = 100;
const MAX_LINE_KEY_CHARS: usize = 80;
const MAX_EXTERNAL_ID_CHARS: usize = 80;
const MAX_NAME_CHARS: usize = 160;
const MAX_LINE_QTY: i64 = 999;
const MAX_TOTAL_CENTS: i64 = 1_000_000_000;

/// `set local pokoin.listing_change_source = 'channel:tcgplayer'`.
/// `set_config`'s third argument is is_local, so the audit trigger sees the
/// source only inside this transaction. A prepared `SET` is not reliable
/// through sqlx.
const LISTING_CHANGE_SOURCE_SQL: &str =
    "select set_config('pokoin.listing_change_source', 'channel:tcgplayer', true)";

pub const ENQUEUE_SQL: &str = "insert into public.channel_sync_jobs \
 (seller_uid, channel, kind, listing_key, status, available_at) \
 values ($1, $2, $3, $4, 'pending', now()) \
 on conflict (seller_uid, channel, kind, listing_key) where status = 'pending' \
 do update set available_at = now(), updated_at = now()";

pub const ENQUEUE_SKIPPED_SQL: &str = "insert into public.channel_sync_jobs \
 (seller_uid, channel, kind, listing_key, status, skip_reason, skip_count, available_at, finished_at) \
 values ($1, $2, $3, $4, 'skipped', 'device_not_enabled', 1, now(), now()) \
 on conflict (seller_uid, channel, kind, listing_key) where status = 'skipped' and skip_reason = 'device_not_enabled' \
 do update set skip_count = channel_sync_jobs.skip_count + 1, updated_at = now()";

/// Built from [`LEASE_SECONDS`] and [`MAX_ATTEMPTS`]. Claim counts an attempt
/// and never hands out `full_resync`.
pub static CLAIM_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "update public.channel_sync_jobs as job \
 set status = 'claimed', attempts = job.attempts + 1, claimed_kind = job.kind, \
 lease_token = gen_random_uuid(), \
 lease_until = now() + make_interval(secs => {LEASE_SECONDS}), claimed_by = $3, updated_at = now() \
 where job.id in ( \
   select id from public.channel_sync_jobs \
   where seller_uid = $1 and channel = $2 and available_at <= now() and attempts < {MAX_ATTEMPTS} \
     and kind <> 'full_resync' \
     and (status = 'pending' or (status = 'claimed' and lease_until <= now())) \
   order by available_at, id \
   for update skip locked \
   limit $4) \
 returning id, kind, listing_key, lease_token, attempts"
    )
});

/// `$4` refunds the claim's attempt (`needs_sign_in`). A `skipped` finish is
/// `superseded`: the in-flight row lost to a newer pending twin.
pub const COMPLETE_SQL: &str = "update public.channel_sync_jobs set \
 status = $3, \
 attempts = case when $4 then greatest(attempts - 1, 0) else attempts end, \
 skip_reason = case when $3 = 'skipped' then 'superseded' else skip_reason end, \
 available_at = case when $3 = 'pending' then now() + make_interval(secs => $5) else available_at end, \
 last_error = $6, result = $7, \
 finished_at = case when $3 in ('done', 'failed', 'dead', 'skipped') then now() else null end, \
 lease_token = null, lease_until = null, updated_at = now() \
 where id = $1 and lease_token = $2 and status = 'claimed' and seller_uid = $8 \
 returning id, kind, listing_key";

const PENDING_TWIN_SQL: &str = "select exists(select 1 from public.channel_sync_jobs \
 where seller_uid = $1 and channel = $2 and kind = $3 and listing_key = $4 \
 and status = 'pending' and id <> $5)";

/// One open pull: pending or claimed. The pending partial index is not enough,
/// because a claimed pull would not conflict with a new pending row.
pub const PULL_ORDERS_HEARTBEAT_SQL: &str = "insert into public.channel_sync_jobs \
 (seller_uid, channel, kind, listing_key, status, available_at) \
 select $1, $2, 'pull_orders', '', 'pending', coalesce( \
   (select max(finished_at) + make_interval(secs => $3) from public.channel_sync_jobs \
     where seller_uid = $1 and channel = $2 and kind = 'pull_orders' and status = 'done'), \
   now()) \
 where not exists (select 1 from public.channel_sync_jobs \
   where seller_uid = $1 and channel = $2 and kind = 'pull_orders' and status in ('pending', 'claimed'))";

pub const PULL_ORDERS_SYNC_NOW_SQL: &str = "with pulled as ( \
 update public.channel_sync_jobs set available_at = now(), updated_at = now() \
 where seller_uid = $1 and channel = $2 and kind = 'pull_orders' and status = 'pending' \
 returning id) \
 insert into public.channel_sync_jobs (seller_uid, channel, kind, listing_key, status, available_at) \
 select $1, $2, 'pull_orders', '', 'pending', now() \
 where not exists (select 1 from public.channel_sync_jobs \
   where seller_uid = $1 and channel = $2 and kind = 'pull_orders' and status in ('pending', 'claimed'))";

pub const ENABLE_SET_QTY_SQL: &str = "insert into public.channel_sync_jobs \
 (seller_uid, channel, kind, listing_key, status, available_at) \
 select $1, $2, 'set_qty', l.id::text, 'pending', now() \
 from public.marketplace_user_listings l \
 where l.seller_uid = $1 \
   and coalesce(nullif(l.marketplace_game, ''), 'pokemon') = 'pokemon' \
   and not coalesce(l.sealed, false) \
   and not coalesce(l.graded, false) \
   and ( \
     exists (select 1 from public.channel_listing_links link \
       where link.channel = $2 and link.listing_id = l.id and link.seller_uid = l.seller_uid) \
     or (l.status = 'active' and l.quantity_available > 0)) \
 on conflict (seller_uid, channel, kind, listing_key) where status = 'pending' \
 do update set available_at = now(), updated_at = now()";

pub const ENABLE_RESYNC_RECORD_SQL: &str = "insert into public.channel_sync_jobs \
 (seller_uid, channel, kind, listing_key, status, result, finished_at) \
 values ($1, $2, 'full_resync', '', 'done', jsonb_build_object('queued', $3), now())";

const SHARED_SKU_SQL: &str = "select listing_id::text from public.channel_listing_links \
 where seller_uid = $1 and channel = $2 and external_id = $3 and listing_id <> $4 limit 1";

const LINK_UPSERT_SQL: &str = "insert into public.channel_listing_links \
 (channel, listing_id, seller_uid, external_id, last_qty, last_price_cents, updated_at) \
 values ($1, $2, $3, $4, $5, $6, now()) \
 on conflict (channel, listing_id) do update set \
 external_id = excluded.external_id, seller_uid = excluded.seller_uid, \
 last_qty = excluded.last_qty, last_price_cents = excluded.last_price_cents, updated_at = now()";

const SKIP_OPEN_SQL: &str = "with open as ( \
 delete from public.channel_sync_jobs \
 where seller_uid = $1 and channel = $2 and status in ('pending', 'claimed') \
 returning seller_uid, channel, kind, listing_key) \
 insert into public.channel_sync_jobs \
 (seller_uid, channel, kind, listing_key, status, skip_reason, skip_count, finished_at) \
 select seller_uid, channel, kind, listing_key, 'skipped', 'device_not_enabled', 1, now() from open \
 on conflict (seller_uid, channel, kind, listing_key) \
 where status = 'skipped' and skip_reason = 'device_not_enabled' \
 do update set skip_count = channel_sync_jobs.skip_count + 1, updated_at = now()";

const LISTING_TARGET_SQL: &str = "select l.id::text as listing_id, \
 coalesce(l.card_id, '') as card_id, coalesce(l.card_name, '') as card_name, \
 coalesce(l.set_name, '') as set_name, coalesce(l.collector_number, '') as collector_number, \
 coalesce(l.condition, '') as condition, coalesce(l.language, '') as language, \
 coalesce(l.reverse, false) as reverse, coalesce(l.first_edition, false) as first_edition, \
 coalesce(l.sealed, false) as sealed, coalesce(l.graded, false) as graded, \
 coalesce(l.status, '') as status, coalesce(l.quantity_available, 0) as quantity_available, \
 coalesce(l.price_pkn, 0)::float8 as price_pkn, \
 coalesce(nullif(l.marketplace_game, ''), 'pokemon') as game, \
 link.external_id as external_id, rule.percent_bp as percent_bp, \
 rule.fixed_cents as fixed_cents, rule.round_mode as round_mode \
 from public.marketplace_user_listings l \
 left join public.channel_listing_links link \
   on link.listing_id = l.id and link.channel = $2 and link.seller_uid = l.seller_uid \
 left join public.channel_price_rules rule \
   on rule.seller_uid = l.seller_uid and rule.channel = $2 \
 where l.id = $1 and l.seller_uid = $3";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    PushListing,
    SetQty,
    SetPrice,
    PullOrders,
    FullResync,
}

impl JobKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PushListing => "push_listing",
            Self::SetQty => "set_qty",
            Self::SetPrice => "set_price",
            Self::PullOrders => "pull_orders",
            Self::FullResync => "full_resync",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Retry,
    Failed,
    NeedsSignIn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundMode {
    Cent,
    UpCent,
    Charm99,
}

impl RoundMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "cent" => Some(Self::Cent),
            "up_cent" => Some(Self::UpCent),
            "charm_99" => Some(Self::Charm99),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cent => "cent",
            Self::UpCent => "up_cent",
            Self::Charm99 => "charm_99",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PriceRule {
    pub percent_bp: i32,
    pub fixed_cents: i32,
    pub round_mode: RoundMode,
}

impl Default for PriceRule {
    fn default() -> Self {
        Self {
            percent_bp: 0,
            fixed_cents: 0,
            round_mode: RoundMode::Cent,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DeviceRow {
    pub enabled: bool,
    pub running: bool,
    pub signed_in: bool,
    pub revoked_at: Option<DateTime<Utc>>,
    pub last_heartbeat_at: Option<DateTime<Utc>>,
}

pub fn is_missing_table(error: &sqlx::Error) -> bool {
    error.as_database_error().and_then(|e| e.code()).as_deref() == Some("42P01")
}

fn is_unique(error: &sqlx::Error) -> bool {
    error.as_database_error().and_then(|e| e.code()).as_deref() == Some("23505")
}

/// Migration 126 is not applied yet. Routes answer 503 instead of a generic 500.
pub fn store_error(error: sqlx::Error) -> ApiError {
    if is_missing_table(&error) {
        return ApiError::unavailable("Channel sync is not enabled yet.").with_code("channel_sync_disabled");
    }
    error.into()
}

fn cap_text(raw: &str, max: usize) -> String {
    raw.trim().chars().take(max).collect()
}

fn json_i64(body: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        let Some(value) = body.get(*key) else { continue };
        if let Some(n) = value.as_i64() {
            return Some(n);
        }
        if let Some(n) = value.as_u64() {
            return i64::try_from(n).ok();
        }
        if let Some(text) = value.as_str() {
            if let Ok(n) = text.trim().parse::<i64>() {
                return Some(n);
            }
        }
    }
    None
}

fn json_bool(body: &Value, key: &str) -> bool {
    match body.get(key) {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => matches!(text.trim(), "true" | "1"),
        Some(Value::Number(n)) => n.as_i64() == Some(1),
        _ => false,
    }
}

fn text_of(body: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(Value::String(text)) = body.get(*key) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

/// Pokémon single, from the listing.changed payload. An empty product type is
/// a single: `marketplace_user_listings` does not store one, and the catalogue
/// word for a single is `card`.
pub fn eligible(payload: &Value) -> bool {
    let game = payload["game"].as_str().unwrap_or("").trim();
    if !game.is_empty() && !game.eq_ignore_ascii_case("pokemon") {
        return false;
    }
    let listing = &payload["merchantListing"];
    if listing["sealed"] == true || listing["graded"] == true {
        return false;
    }
    let product = listing["productType"].as_str().unwrap_or("").trim();
    product.is_empty() || matches!(product.to_ascii_lowercase().as_str(), "single" | "card")
}

/// Mutation → job kinds. Link vs push is decided at claim, not here.
pub fn jobs_for_event(payload: &Value) -> Vec<JobKind> {
    if !eligible(payload) {
        return Vec::new();
    }
    match payload["mutation"].as_str().unwrap_or("") {
        "LISTING_CREATED" | "LISTING_REACTIVATED" => vec![JobKind::PushListing],
        "LISTING_SOLD" | "LISTING_QUANTITY_CHANGED" | "LISTING_DELETED" | "LISTING_DEACTIVATED" => {
            vec![JobKind::SetQty]
        }
        "LISTING_PRICE_CHANGED" => vec![JobKind::SetPrice],
        "LISTING_UPDATED" => vec![JobKind::SetQty, JobKind::SetPrice],
        _ => Vec::new(),
    }
}

fn stabilize(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn charm_99(cents: f64) -> f64 {
    let cents = stabilize(cents);
    let rounded = cents.round();
    if (cents - rounded).abs() < 1e-6 {
        let whole = rounded as i64;
        if whole % 100 == 99 {
            return whole as f64;
        }
    }
    let floor = cents.floor() as i64;
    let rem = floor.rem_euclid(100);
    let target = floor - rem + 99;
    if cents > target as f64 + 1e-6 {
        (target + 100) as f64
    } else {
        target as f64
    }
}

/// USD cents for a channel. `None` when the price is not a positive finite PKN
/// amount, or the rule drives the result to zero or below.
pub fn channel_cents(price_pkn: f64, rule: &PriceRule) -> Option<i64> {
    if !price_pkn.is_finite() || price_pkn <= 0.0 {
        return None;
    }
    let base = price_pkn * PKN_USDT_PRICE * 100.0;
    if !base.is_finite() || base <= 0.0 {
        return None;
    }
    let adjusted = base * (1.0 + f64::from(rule.percent_bp) / 10_000.0) + f64::from(rule.fixed_cents);
    if !adjusted.is_finite() || adjusted <= 0.0 {
        return None;
    }
    let cents = match rule.round_mode {
        RoundMode::Cent => stabilize(adjusted).round(),
        RoundMode::UpCent => stabilize(adjusted).ceil(),
        RoundMode::Charm99 => charm_99(adjusted),
    };
    if !cents.is_finite() || cents <= 0.0 || cents >= i64::MAX as f64 {
        return None;
    }
    Some(cents as i64)
}

/// SortSwift's status chips. `running` and `signedIn` are only true while the
/// last heartbeat is inside [`ONLINE_SECONDS`].
pub fn badges(device: Option<&DeviceRow>, now: DateTime<Utc>) -> Value {
    let Some(device) = device.filter(|row| row.revoked_at.is_none()) else {
        return json!({"usingSync": false, "online": false, "running": false, "signedIn": false});
    };
    let online = device.last_heartbeat_at.is_some_and(|at| {
        let age = now.signed_duration_since(at).num_seconds();
        (0..=ONLINE_SECONDS).contains(&age)
    });
    json!({
        "usingSync": device.enabled,
        "online": online,
        "running": online && device.running,
        "signedIn": online && device.signed_in,
    })
}

/// `30 * 4^min(attempts, 6)`, matching the seller-webhook delivery backoff.
pub fn next_backoff_seconds(attempts: i32) -> i64 {
    let exp = attempts.clamp(0, 6) as u32;
    30 * 4i64.pow(exp)
}

/// `(status, retry_after_secs, refund_attempt)`.
///
/// `attempts` is the value after claim incremented it. A retry at
/// [`MAX_ATTEMPTS`] is dead. `needs_sign_in` goes back to pending and the
/// caller subtracts the claim's attempt.
pub fn apply_outcome(attempts: i32, outcome: Outcome) -> (&'static str, i64, bool) {
    match outcome {
        Outcome::Done => ("done", 0, false),
        Outcome::Failed => ("failed", 0, false),
        Outcome::NeedsSignIn => ("pending", 0, true),
        Outcome::Retry if attempts >= MAX_ATTEMPTS => ("dead", 0, false),
        Outcome::Retry => ("pending", next_backoff_seconds(attempts), false),
    }
}

/// A pending twin already holds the newer edit. Putting this lease back to
/// pending would violate the pending unique index, so the in-flight row is
/// `skipped` / `superseded`.
pub fn collide_pending(status: &'static str, pending_twin: bool) -> (&'static str, Option<&'static str>) {
    if pending_twin && status == "pending" {
        ("skipped", Some("superseded"))
    } else {
        (status, None)
    }
}

/// A push handed out with no link has to come back with the TCGplayer id.
pub fn push_requires_external_id(claimed_kind: Option<&str>, outcome: Outcome, external_id: &str) -> bool {
    outcome == Outcome::Done && claimed_kind == Some("push_listing") && external_id.is_empty()
}

/// Whether one order line may lower Pokoin stock. `linked_at` is ignored when
/// the order has no `placedAt`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineStock {
    Apply,
    BeforeLink,
    NoDate,
}

pub fn line_stock(placed_at: Option<DateTime<Utc>>, linked_at: DateTime<Utc>) -> LineStock {
    let Some(placed_at) = placed_at else {
        return LineStock::NoDate;
    };
    if placed_at >= linked_at {
        LineStock::Apply
    } else {
        LineStock::BeforeLink
    }
}

/// Cancelled and refunded orders are not Pokoin stock changes.
pub fn order_skips_stock(status: &str) -> bool {
    let status = status.to_ascii_lowercase();
    status.contains("cancel") || status.contains("refund")
}

fn rule_from(percent_bp: Option<i32>, fixed_cents: Option<i32>, round_mode: Option<String>) -> PriceRule {
    PriceRule {
        percent_bp: percent_bp.unwrap_or(0),
        fixed_cents: fixed_cents.unwrap_or(0),
        round_mode: round_mode.as_deref().and_then(RoundMode::parse).unwrap_or(RoundMode::Cent),
    }
}

fn rule_json(rule: &PriceRule) -> Value {
    json!({
        "percentBp": rule.percent_bp,
        "fixedCents": rule.fixed_cents,
        "roundMode": rule.round_mode.as_str(),
    })
}

fn stamp(at: Option<DateTime<Utc>>) -> Value {
    at.map(|t| json!(t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)))
        .unwrap_or(Value::Null)
}

fn require_channel(raw: &str) -> Result<&'static str, ApiError> {
    if raw.trim().eq_ignore_ascii_case(CHANNEL_TCGPLAYER) {
        Ok(CHANNEL_TCGPLAYER)
    } else {
        Err(ApiError::bad_request("Unsupported channel.").with_code("channel_sync/unknown-channel"))
    }
}

pub fn channel_of(query: &str, body: Option<&Value>) -> Result<&'static str, ApiError> {
    let from_body = body.map(|value| text_of(value, &["channel"])).unwrap_or_default();
    let raw = if !query.trim().is_empty() {
        query.trim()
    } else if !from_body.is_empty() {
        from_body.as_str()
    } else {
        CHANNEL_TCGPLAYER
    };
    require_channel(raw)
}

/// Queue the jobs for one listing.changed payload. No live device → nothing.
/// A switched-off device counts the edit on one skipped row.
pub async fn enqueue_for_event(state: &DomainState, payload: &Value) -> Result<(), ApiError> {
    let kinds = jobs_for_event(payload);
    if kinds.is_empty() {
        return Ok(());
    }
    let seller = field(payload, "sellerUid", 160);
    let listing_key = field(payload, "listingId", 80);
    if seller.is_empty() || listing_key.is_empty() {
        return Ok(());
    }
    let enabled = sqlx::query_scalar::<_, bool>(
        "select enabled from public.seller_channel_devices \
         where seller_uid = $1 and channel = $2 and revoked_at is null",
    )
    .bind(&seller)
    .bind(CHANNEL_TCGPLAYER)
    .fetch_optional(state.write_db())
    .await
    .map_err(store_error)?;
    let Some(enabled) = enabled else {
        return Ok(());
    };
    let sql = if enabled { ENQUEUE_SQL } else { ENQUEUE_SKIPPED_SQL };
    let mut tx = state.write_db().begin().await.map_err(store_error)?;
    for kind in kinds {
        sqlx::query(sql)
            .bind(&seller)
            .bind(CHANNEL_TCGPLAYER)
            .bind(kind.as_str())
            .bind(&listing_key)
            .execute(&mut *tx)
            .await
            .map_err(store_error)?;
    }
    tx.commit().await.map_err(store_error)?;
    Ok(())
}

struct LiveDevice {
    id: Uuid,
    enabled: bool,
    signed_in: bool,
    running: bool,
    label: String,
    worker_version: String,
    last_error: Option<String>,
    last_heartbeat_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

fn no_device() -> ApiError {
    ApiError::not_found("Sync box is not registered.").with_code("channel_sync/no-device")
}

async fn seller_device(state: &DomainState, seller: &str, channel: &str) -> Result<Option<LiveDevice>, ApiError> {
    let row = sqlx::query(
        "select id, label, enabled, signed_in, running, worker_version, last_error, \
         last_heartbeat_at, created_at from public.seller_channel_devices \
         where seller_uid = $1 and channel = $2 and revoked_at is null",
    )
    .bind(seller)
    .bind(channel)
    .fetch_optional(state.write_db())
    .await
    .map_err(store_error)?;
    row.map(|row| device_from_row(&row)).transpose()
}

fn device_from_row(row: &sqlx::postgres::PgRow) -> Result<LiveDevice, ApiError> {
    Ok(LiveDevice {
        id: row.try_get("id").map_err(store_error)?,
        label: row.try_get("label").map_err(store_error)?,
        enabled: row.try_get("enabled").map_err(store_error)?,
        signed_in: row.try_get("signed_in").map_err(store_error)?,
        running: row.try_get("running").map_err(store_error)?,
        worker_version: row.try_get("worker_version").map_err(store_error)?,
        last_error: row.try_get("last_error").map_err(store_error)?,
        last_heartbeat_at: row.try_get("last_heartbeat_at").map_err(store_error)?,
        created_at: row.try_get("created_at").map_err(store_error)?,
    })
}

fn device_json(device: &LiveDevice) -> Value {
    json!({
        "id": device.id.to_string(),
        "label": device.label,
        "enabled": device.enabled,
        "signedIn": device.signed_in,
        "running": device.running,
        "workerVersion": device.worker_version,
        "lastHeartbeatAt": stamp(device.last_heartbeat_at),
        "lastError": device.last_error,
        "createdAt": stamp(Some(device.created_at)),
    })
}

fn device_badges(device: Option<&LiveDevice>, now: DateTime<Utc>) -> Value {
    let row = device.map(|device| DeviceRow {
        enabled: device.enabled,
        running: device.running,
        signed_in: device.signed_in,
        revoked_at: None,
        last_heartbeat_at: device.last_heartbeat_at,
    });
    badges(row.as_ref(), now)
}

async fn load_rule(state: &DomainState, seller: &str, channel: &str) -> Result<PriceRule, ApiError> {
    let row = sqlx::query(
        "select percent_bp, fixed_cents, round_mode from public.channel_price_rules \
         where seller_uid = $1 and channel = $2",
    )
    .bind(seller)
    .bind(channel)
    .fetch_optional(state.write_db())
    .await
    .map_err(store_error)?;
    Ok(match row {
        Some(row) => rule_from(
            row.try_get("percent_bp").ok(),
            row.try_get("fixed_cents").ok(),
            row.try_get("round_mode").ok(),
        ),
        None => PriceRule::default(),
    })
}

pub async fn status(state: &DomainState, seller: &str, channel: &str) -> Result<Value, ApiError> {
    let device = seller_device(state, seller, channel).await?;
    let counts = sqlx::query(
        "select status, count(*)::bigint as n from public.channel_sync_jobs \
         where seller_uid = $1 and channel = $2 group by status",
    )
    .bind(seller)
    .bind(channel)
    .fetch_all(state.write_db())
    .await
    .map_err(store_error)?;
    let mut queue = json!({"pending": 0, "claimed": 0, "done": 0, "skipped": 0, "failed": 0, "dead": 0});
    for row in &counts {
        let status: String = row.try_get("status").map_err(store_error)?;
        let n: i64 = row.try_get("n").map_err(store_error)?;
        if queue.get(&status).is_some() {
            queue[status] = json!(n);
        }
    }
    let recent_rows = sqlx::query(
        "select status, skip_reason, last_error, kind, listing_key, skip_count, updated_at \
         from public.channel_sync_jobs \
         where seller_uid = $1 and channel = $2 and status in ('skipped', 'failed', 'dead') \
         order by updated_at desc limit 20",
    )
    .bind(seller)
    .bind(channel)
    .fetch_all(state.write_db())
    .await
    .map_err(store_error)?;
    let mut recent = Vec::with_capacity(recent_rows.len());
    for row in &recent_rows {
        recent.push(json!({
            "status": row.try_get::<String, _>("status").map_err(store_error)?,
            "skipReason": row.try_get::<Option<String>, _>("skip_reason").map_err(store_error)?,
            "lastError": row.try_get::<Option<String>, _>("last_error").map_err(store_error)?,
            "kind": row.try_get::<String, _>("kind").map_err(store_error)?,
            "listingKey": row.try_get::<String, _>("listing_key").map_err(store_error)?,
            "skipCount": row.try_get::<i32, _>("skip_count").map_err(store_error)?,
            "updatedAt": stamp(row.try_get("updated_at").map_err(store_error)?),
        }));
    }
    let rule = load_rule(state, seller, channel).await?;
    let now = DateTime::<Utc>::from_timestamp_millis(state.now_ms()).unwrap_or_else(Utc::now);
    Ok(json!({
        "channel": channel,
        "device": device.as_ref().map(device_json),
        "badges": device_badges(device.as_ref(), now),
        "enabled": device.as_ref().is_some_and(|row| row.enabled),
        "queue": queue,
        "recent": recent,
        "priceRule": rule_json(&rule),
    }))
}

async fn revoke_grant(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, grant_id: Uuid) -> Result<(), ApiError> {
    sqlx::query("update public.seller_api_grants set revoked_at = now(), webhook_url = '' where id = $1 and revoked_at is null")
        .bind(grant_id)
        .execute(&mut **tx)
        .await
        .map_err(store_error)?;
    Ok(())
}

/// Revoke the live device and its grant. `Ok(None)` when there isn't one.
async fn revoke_live(state: &DomainState, seller: &str, channel: &str) -> Result<Option<Uuid>, ApiError> {
    let mut tx = state.write_db().begin().await.map_err(store_error)?;
    let row = sqlx::query(
        "update public.seller_channel_devices set revoked_at = now(), enabled = false, updated_at = now() \
         where seller_uid = $1 and channel = $2 and revoked_at is null returning id, grant_id",
    )
    .bind(seller)
    .bind(channel)
    .fetch_optional(&mut *tx)
    .await
    .map_err(store_error)?;
    let Some(row) = row else {
        tx.commit().await.map_err(store_error)?;
        return Ok(None);
    };
    let id: Uuid = row.try_get("id").map_err(store_error)?;
    let grant_id: Uuid = row.try_get("grant_id").map_err(store_error)?;
    revoke_grant(&mut tx, grant_id).await?;
    sqlx::query(SKIP_OPEN_SQL)
        .bind(seller)
        .bind(channel)
        .execute(&mut *tx)
        .await
        .map_err(store_error)?;
    tx.commit().await.map_err(store_error)?;
    Ok(Some(id))
}

pub async fn register_device(state: &DomainState, seller: &str, channel: &str, label: &str) -> Result<Value, ApiError> {
    let channel = require_channel(channel)?;
    revoke_live(state, seller, channel).await?;
    let label = cap_text(label, 80);
    let issued = seller_api::issue_grant(state, seller, seller_api::CLIENT_TCGPLAYER_BOX, &label).await?;
    let inserted = sqlx::query_scalar::<_, Uuid>(
        "insert into public.seller_channel_devices (seller_uid, channel, grant_id, label) \
         values ($1, $2, $3, $4) returning id",
    )
    .bind(seller)
    .bind(channel)
    .bind(issued.id)
    .bind(&label)
    .fetch_one(state.write_db())
    .await;
    let device_id = match inserted {
        Ok(id) => id,
        Err(error) => {
            let _ = sqlx::query("update public.seller_api_grants set revoked_at = now() where id = $1")
                .bind(issued.id)
                .execute(state.write_db())
                .await;
            if is_unique(&error) {
                return Err(ApiError::conflict("A sync box is already registered.").with_code("channel_sync/device-exists"));
            }
            return Err(store_error(error));
        }
    };
    Ok(json!({
        "deviceId": device_id.to_string(),
        "channel": channel,
        "enabled": false,
        "grantId": issued.id.to_string(),
        "tokenPrefix": issued.token_prefix,
        // Shown once. Pokoin keeps only the token's hash.
        "token": issued.token,
    }))
}

pub async fn revoke_device(state: &DomainState, seller: &str, channel: &str) -> Result<Value, ApiError> {
    let channel = require_channel(channel)?;
    let id = revoke_live(state, seller, channel).await?.ok_or_else(no_device)?;
    Ok(json!({"ok": true, "revoked": id.to_string()}))
}

pub async fn enable(state: &DomainState, seller: &str, channel: &str) -> Result<Value, ApiError> {
    let channel = require_channel(channel)?;
    let mut tx = state.write_db().begin().await.map_err(store_error)?;
    let turned = sqlx::query(
        "update public.seller_channel_devices set enabled = true, updated_at = now() \
         where seller_uid = $1 and channel = $2 and revoked_at is null",
    )
    .bind(seller)
    .bind(channel)
    .execute(&mut *tx)
    .await
    .map_err(store_error)?
    .rows_affected();
    if turned == 0 {
        return Err(no_device());
    }
    // Open per-listing jobs are replaced by the fan-out below. pull_orders stays.
    sqlx::query(
        "update public.channel_sync_jobs set status = 'skipped', skip_reason = 'superseded', \
         finished_at = now(), lease_token = null, lease_until = null, updated_at = now() \
         where seller_uid = $1 and channel = $2 and status in ('pending', 'claimed') \
           and kind in ('push_listing', 'set_qty', 'set_price')",
    )
    .bind(seller)
    .bind(channel)
    .execute(&mut *tx)
    .await
    .map_err(store_error)?;
    let queued = sqlx::query(ENABLE_SET_QTY_SQL)
        .bind(seller)
        .bind(channel)
        .execute(&mut *tx)
        .await
        .map_err(store_error)?
        .rows_affected();
    sqlx::query(ENABLE_RESYNC_RECORD_SQL)
        .bind(seller)
        .bind(channel)
        .bind(i64::try_from(queued).unwrap_or(i64::MAX))
        .execute(&mut *tx)
        .await
        .map_err(store_error)?;
    tx.commit().await.map_err(store_error)?;
    Ok(json!({"ok": true, "enabled": true}))
}

pub async fn disable(state: &DomainState, seller: &str, channel: &str) -> Result<Value, ApiError> {
    let channel = require_channel(channel)?;
    let mut tx = state.write_db().begin().await.map_err(store_error)?;
    let turned = sqlx::query(
        "update public.seller_channel_devices set enabled = false, updated_at = now() \
         where seller_uid = $1 and channel = $2 and revoked_at is null",
    )
    .bind(seller)
    .bind(channel)
    .execute(&mut *tx)
    .await
    .map_err(store_error)?
    .rows_affected();
    if turned == 0 {
        return Err(no_device());
    }
    sqlx::query(SKIP_OPEN_SQL)
        .bind(seller)
        .bind(channel)
        .execute(&mut *tx)
        .await
        .map_err(store_error)?;
    tx.commit().await.map_err(store_error)?;
    Ok(json!({"ok": true, "enabled": false}))
}

pub async fn set_price_rule(state: &DomainState, seller: &str, channel: &str, body: &Value) -> Result<Value, ApiError> {
    let channel = require_channel(channel)?;
    let percent = json_i64(body, &["percentBp", "percent_bp"]).unwrap_or(0);
    let fixed = json_i64(body, &["fixedCents", "fixed_cents"]).unwrap_or(0);
    let mode_raw = text_of(body, &["roundMode", "round_mode"]);
    let mode_raw = if mode_raw.is_empty() { "cent".to_string() } else { mode_raw };
    let Some(mode) = RoundMode::parse(&mode_raw) else {
        return Err(ApiError::bad_request("Unknown round mode.").with_code("channel_sync/round-mode"));
    };
    if !(-5000..=20_000).contains(&percent) || !(-100_000..=100_000).contains(&fixed) {
        return Err(ApiError::bad_request("Price rule is out of range.").with_code("channel_sync/price-rule"));
    }
    let rule = PriceRule {
        percent_bp: percent as i32,
        fixed_cents: fixed as i32,
        round_mode: mode,
    };
    sqlx::query(
        "insert into public.channel_price_rules (seller_uid, channel, percent_bp, fixed_cents, round_mode, updated_at) \
         values ($1, $2, $3, $4, $5, now()) \
         on conflict (seller_uid, channel) do update set \
           percent_bp = excluded.percent_bp, fixed_cents = excluded.fixed_cents, \
           round_mode = excluded.round_mode, updated_at = now()",
    )
    .bind(seller)
    .bind(channel)
    .bind(rule.percent_bp)
    .bind(rule.fixed_cents)
    .bind(rule.round_mode.as_str())
    .execute(state.write_db())
    .await
    .map_err(store_error)?;
    Ok(json!({"ok": true, "priceRule": rule_json(&rule)}))
}

pub async fn sync_now(state: &DomainState, seller: &str, channel: &str) -> Result<Value, ApiError> {
    let channel = require_channel(channel)?;
    let device = seller_device(state, seller, channel).await?.ok_or_else(no_device)?;
    if !device.enabled {
        return Err(ApiError::conflict("Turn sync on first.").with_code("channel_sync/disabled"));
    }
    sqlx::query(PULL_ORDERS_SYNC_NOW_SQL)
        .bind(seller)
        .bind(channel)
        .execute(state.write_db())
        .await
        .map_err(store_error)?;
    Ok(json!({"ok": true, "queued": true}))
}

pub async fn list_orders(state: &DomainState, seller: &str, channel: &str, limit: i64) -> Result<Value, ApiError> {
    let channel = require_channel(channel)?;
    let limit = limit.clamp(1, 200);
    let rows = sqlx::query(
        "select external_order_id, status, placed_at, buyer_name, lines, total_cents, currency \
         from public.channel_orders where seller_uid = $1 and channel = $2 \
         order by placed_at desc nulls last, created_at desc limit $3",
    )
    .bind(seller)
    .bind(channel)
    .bind(limit)
    .fetch_all(state.write_db())
    .await
    .map_err(store_error)?;
    let mut orders = Vec::with_capacity(rows.len());
    for row in &rows {
        orders.push(json!({
            "channel": channel,
            "orderId": row.try_get::<String, _>("external_order_id").map_err(store_error)?,
            "status": row.try_get::<String, _>("status").map_err(store_error)?,
            "placedAt": stamp(row.try_get("placed_at").map_err(store_error)?),
            "buyerName": row.try_get::<String, _>("buyer_name").map_err(store_error)?,
            "lines": row.try_get::<Value, _>("lines").map_err(store_error)?,
            "totalCents": row.try_get::<Option<i64>, _>("total_cents").map_err(store_error)?,
            "currency": row.try_get::<String, _>("currency").map_err(store_error)?,
        }));
    }
    Ok(json!({"channel": channel, "orders": orders}))
}

async fn device_for_grant(state: &DomainState, grant: &Grant) -> Result<LiveDevice, ApiError> {
    let row = sqlx::query(
        "select id, label, enabled, signed_in, running, worker_version, last_error, \
         last_heartbeat_at, created_at from public.seller_channel_devices \
         where grant_id = $1 and seller_uid = $2 and channel = $3 and revoked_at is null",
    )
    .bind(grant.id)
    .bind(&grant.seller_uid)
    .bind(CHANNEL_TCGPLAYER)
    .fetch_optional(state.write_db())
    .await
    .map_err(store_error)?
    .ok_or_else(no_device)?;
    device_from_row(&row)
}

pub async fn heartbeat(state: &DomainState, grant: &Grant, body: &Value) -> Result<Value, ApiError> {
    let device = device_for_grant(state, grant).await?;
    let signed_in = json_bool(body, "signedIn");
    let running = json_bool(body, "running");
    let version = cap_text(&text_of(body, &["version", "workerVersion"]), 40);
    let error = {
        let text = cap_text(&text_of(body, &["error", "lastError"]), MAX_ERROR_CHARS);
        if text.is_empty() { None } else { Some(text) }
    };
    let enabled: bool = sqlx::query_scalar(
        "update public.seller_channel_devices set signed_in = $2, running = $3, worker_version = $4, \
         last_error = $5, last_heartbeat_at = now(), updated_at = now() \
         where id = $1 and revoked_at is null returning enabled",
    )
    .bind(device.id)
    .bind(signed_in)
    .bind(running)
    .bind(&version)
    .bind(error.as_deref())
    .fetch_one(state.write_db())
    .await
    .map_err(store_error)?;
    // One open pull, due a full interval after the last finished one.
    // A claimed pull must block this insert: the pending index would not.
    sqlx::query(PULL_ORDERS_HEARTBEAT_SQL)
    .bind(&grant.seller_uid)
    .bind(CHANNEL_TCGPLAYER)
    .bind(PULL_ORDERS_EVERY_SECONDS as f64)
    .execute(state.write_db())
    .await
    .map_err(store_error)?;
    Ok(json!({"enabled": enabled, "pollAfterMs": POLL_AFTER_MS}))
}

struct TargetParts {
    listing_id: String,
    card_id: String,
    card_name: String,
    set_name: String,
    collector_number: String,
    condition: String,
    language: String,
    reverse: bool,
    first_edition: bool,
    quantity: i64,
    price_cents: Option<i64>,
    external_id: Option<String>,
    eligible: bool,
}

fn parts_from_row(row: &sqlx::postgres::PgRow) -> Result<TargetParts, ApiError> {
    let status: String = row.try_get("status").map_err(store_error)?;
    let quantity_available: i32 = row.try_get("quantity_available").map_err(store_error)?;
    let price_pkn: f64 = row.try_get("price_pkn").map_err(store_error)?;
    let game: String = row.try_get("game").map_err(store_error)?;
    let sealed: bool = row.try_get("sealed").map_err(store_error)?;
    let graded: bool = row.try_get("graded").map_err(store_error)?;
    let rule = rule_from(
        row.try_get("percent_bp").ok(),
        row.try_get("fixed_cents").ok(),
        row.try_get("round_mode").ok(),
    );
    let external: Option<String> = row.try_get("external_id").map_err(store_error)?;
    let eligible = game.eq_ignore_ascii_case("pokemon") && !sealed && !graded;
    Ok(TargetParts {
        listing_id: row.try_get("listing_id").map_err(store_error)?,
        card_id: row.try_get("card_id").map_err(store_error)?,
        card_name: row.try_get("card_name").map_err(store_error)?,
        set_name: row.try_get("set_name").map_err(store_error)?,
        collector_number: row.try_get("collector_number").map_err(store_error)?,
        condition: row.try_get("condition").map_err(store_error)?,
        language: row.try_get("language").map_err(store_error)?,
        reverse: row.try_get("reverse").map_err(store_error)?,
        first_edition: row.try_get("first_edition").map_err(store_error)?,
        quantity: if status == "active" { i64::from(quantity_available.max(0)) } else { 0 },
        price_cents: channel_cents(price_pkn, &rule),
        external_id: external.filter(|value| !value.is_empty()),
        eligible,
    })
}

fn target_json(kind: &str, parts: &TargetParts) -> Value {
    let kind = if parts.external_id.is_none() && matches!(kind, "set_qty" | "set_price" | "push_listing") {
        "push_listing"
    } else {
        kind
    };
    json!({
        "kind": kind,
        "listingId": parts.listing_id,
        "externalId": parts.external_id,
        "quantity": parts.quantity,
        "priceCents": parts.price_cents,
        "cardId": parts.card_id,
        "cardName": parts.card_name,
        "setName": parts.set_name,
        "collectorNumber": parts.collector_number,
        "condition": parts.condition,
        "language": parts.language,
        "reverse": parts.reverse,
        "firstEdition": parts.first_edition,
    })
}

async fn load_target(
    db: &sqlx::PgPool,
    listing_id: Uuid,
    seller: &str,
    channel: &str,
) -> Result<Option<TargetParts>, ApiError> {
    let row = sqlx::query(LISTING_TARGET_SQL)
        .bind(listing_id)
        .bind(channel)
        .bind(seller)
        .fetch_optional(db)
        .await
        .map_err(store_error)?;
    row.map(|row| parts_from_row(&row)).transpose()
}

async fn skip_job(db: &sqlx::PgPool, job_id: i64, lease: Uuid, reason: &str) -> Result<(), ApiError> {
    sqlx::query(
        "update public.channel_sync_jobs set status = 'skipped', skip_reason = $3, finished_at = now(), \
         lease_token = null, lease_until = null, updated_at = now() \
         where id = $1 and lease_token = $2 and status = 'claimed'",
    )
    .bind(job_id)
    .bind(lease)
    .bind(reason)
    .execute(db)
    .await
    .map_err(store_error)?;
    Ok(())
}

pub async fn claim(state: &DomainState, grant: &Grant, body: &Value) -> Result<Value, ApiError> {
    let device = device_for_grant(state, grant).await?;
    if !device.enabled || !device.signed_in {
        return Ok(json!({"jobs": []}));
    }
    let max = json_i64(body, &["max"]).unwrap_or(MAX_CLAIM).clamp(1, MAX_CLAIM);
    let rows = sqlx::query(CLAIM_SQL.as_str())
        .bind(&grant.seller_uid)
        .bind(CHANNEL_TCGPLAYER)
        .bind(device.id)
        .bind(max)
        .fetch_all(state.write_db())
        .await
        .map_err(store_error)?;
    let mut jobs = Vec::with_capacity(rows.len());
    for row in &rows {
        let job_id: i64 = row.try_get("id").map_err(store_error)?;
        let kind: String = row.try_get("kind").map_err(store_error)?;
        let listing_key: String = row.try_get("listing_key").map_err(store_error)?;
        let lease: Uuid = row.try_get("lease_token").map_err(store_error)?;
        if kind == "pull_orders" {
            let since: Option<DateTime<Utc>> = sqlx::query_scalar(
                "select max(placed_at) from public.channel_orders where seller_uid = $1 and channel = $2",
            )
            .bind(&grant.seller_uid)
            .bind(CHANNEL_TCGPLAYER)
            .fetch_one(state.write_db())
            .await
            .map_err(store_error)?;
            jobs.push(json!({
                "jobId": job_id,
                "leaseToken": lease.to_string(),
                "kind": kind,
                "since": stamp(since),
            }));
            continue;
        }
        let Ok(listing_id) = Uuid::parse_str(&listing_key) else {
            skip_job(state.write_db(), job_id, lease, "listing_missing").await?;
            continue;
        };
        let Some(parts) = load_target(state.write_db(), listing_id, &grant.seller_uid, CHANNEL_TCGPLAYER).await? else {
            skip_job(state.write_db(), job_id, lease, "listing_missing").await?;
            continue;
        };
        if !parts.eligible {
            skip_job(state.write_db(), job_id, lease, "not_eligible").await?;
            continue;
        }
        let mut job = target_json(&kind, &parts);
        let handed = job["kind"].as_str().unwrap_or(kind.as_str()).to_string();
        if handed != kind && !stamp_claimed_kind(state.write_db(), job_id, lease, &handed).await? {
            continue;
        }
        job["jobId"] = json!(job_id);
        job["leaseToken"] = json!(lease.to_string());
        jobs.push(job);
    }
    Ok(json!({"jobs": jobs}))
}

fn parse_outcome(raw: &str) -> Result<Outcome, ApiError> {
    match raw {
        "done" => Ok(Outcome::Done),
        "retry" => Ok(Outcome::Retry),
        "failed" => Ok(Outcome::Failed),
        "needs_sign_in" => Ok(Outcome::NeedsSignIn),
        _ => Err(ApiError::bad_request("Unknown outcome.").with_code("channel_sync/unknown-outcome")),
    }
}

async fn upsert_link(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    seller: &str,
    channel: &str,
    listing_id: Uuid,
    external_id: &str,
    last_qty: Option<i32>,
    last_price: Option<i32>,
) -> Result<(), ApiError> {
    sqlx::query(LINK_UPSERT_SQL)
        .bind(channel)
        .bind(listing_id)
        .bind(seller)
        .bind(external_id)
        .bind(last_qty)
        .bind(last_price)
        .execute(&mut **tx)
        .await
        .map_err(store_error)?;
    Ok(())
}

async fn live_link_numbers(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    seller: &str,
    channel: &str,
    listing_id: Uuid,
) -> Result<(Option<i32>, Option<i32>), ApiError> {
    let row = sqlx::query(
        "select coalesce(l.status, '') as status, coalesce(l.quantity_available, 0) as quantity_available, \
         coalesce(l.price_pkn, 0)::float8 as price_pkn, rule.percent_bp, rule.fixed_cents, rule.round_mode \
         from public.marketplace_user_listings l \
         left join public.channel_price_rules rule \
           on rule.seller_uid = l.seller_uid and rule.channel = $3 \
         where l.id = $1 and l.seller_uid = $2",
    )
    .bind(listing_id)
    .bind(seller)
    .bind(channel)
    .fetch_optional(&mut **tx)
    .await
    .map_err(store_error)?;
    let Some(row) = row else {
        return Ok((None, None));
    };
    let status: String = row.try_get("status").map_err(store_error)?;
    let qty: i32 = row.try_get("quantity_available").map_err(store_error)?;
    let price: f64 = row.try_get("price_pkn").map_err(store_error)?;
    let rule = rule_from(
        row.try_get("percent_bp").ok(),
        row.try_get("fixed_cents").ok(),
        row.try_get("round_mode").ok(),
    );
    let last_qty = if status == "active" { qty.max(0) } else { 0 };
    let last_price = channel_cents(price, &rule).and_then(|cents| i32::try_from(cents).ok());
    Ok((Some(last_qty), last_price))
}

async fn stamp_claimed_kind(db: &sqlx::PgPool, job_id: i64, lease: Uuid, kind: &str) -> Result<bool, ApiError> {
    let stamped = sqlx::query(
        "update public.channel_sync_jobs set claimed_kind = $3 \
         where id = $1 and lease_token = $2 and status = 'claimed'",
    )
    .bind(job_id)
    .bind(lease)
    .bind(kind)
    .execute(db)
    .await
    .map_err(store_error)?
    .rows_affected();
    Ok(stamped == 1)
}

async fn write_complete(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    job_id: i64,
    lease: Uuid,
    status: &str,
    refund: bool,
    retry_after: f64,
    error: &Option<String>,
    result: &Value,
    seller: &str,
) -> Result<(Option<sqlx::postgres::PgRow>, &'static str), ApiError> {
    sqlx::query("savepoint channel_sync_complete").execute(&mut **tx).await.map_err(store_error)?;
    let first = sqlx::query(COMPLETE_SQL)
        .bind(job_id)
        .bind(lease)
        .bind(status)
        .bind(refund)
        .bind(retry_after)
        .bind(error)
        .bind(result)
        .bind(seller)
        .fetch_optional(&mut **tx)
        .await;
    let (row, written) = match first {
        Ok(row) => (row, None),
        Err(db_error) if is_unique(&db_error) && status == "pending" => {
            sqlx::query("rollback to savepoint channel_sync_complete")
                .execute(&mut **tx)
                .await
                .map_err(store_error)?;
            let row = sqlx::query(COMPLETE_SQL)
                .bind(job_id)
                .bind(lease)
                .bind("skipped")
                .bind(refund)
                .bind(retry_after)
                .bind(error)
                .bind(result)
                .bind(seller)
                .fetch_optional(&mut **tx)
                .await
                .map_err(store_error)?;
            (row, Some("skipped"))
        }
        Err(db_error) => return Err(store_error(db_error)),
    };
    sqlx::query("release savepoint channel_sync_complete").execute(&mut **tx).await.map_err(store_error)?;
    let written = written.unwrap_or(if status == "skipped" { "skipped" } else { status_static(status) });
    Ok((row, written))
}

fn status_static(status: &str) -> &'static str {
    match status {
        "done" => "done",
        "pending" => "pending",
        "failed" => "failed",
        "dead" => "dead",
        "skipped" => "skipped",
        _ => "done",
    }
}

pub async fn complete(state: &DomainState, grant: &Grant, body: &Value) -> Result<Value, ApiError> {
    let _device = device_for_grant(state, grant).await?;
    let job_id = json_i64(body, &["jobId", "job_id"])
        .ok_or_else(|| ApiError::bad_request("Missing job id.").with_code("channel_sync/job"))?;
    let lease = Uuid::parse_str(&text_of(body, &["leaseToken", "lease_token"]))
        .map_err(|_| ApiError::bad_request("Missing lease token.").with_code("channel_sync/lease"))?;
    let outcome = parse_outcome(&text_of(body, &["outcome"]))?;
    let held = sqlx::query(
        "select attempts, kind, listing_key, claimed_kind, status, lease_token \
         from public.channel_sync_jobs where id = $1 and seller_uid = $2",
    )
    .bind(job_id)
    .bind(&grant.seller_uid)
    .fetch_optional(state.write_db())
    .await
    .map_err(store_error)?
    .ok_or_else(|| ApiError::not_found("Job not found.").with_code("channel_sync/job"))?;
    let held_status: String = held.try_get("status").map_err(store_error)?;
    let held_lease: Option<Uuid> = held.try_get("lease_token").map_err(store_error)?;
    if held_status != "claimed" || held_lease != Some(lease) {
        return Err(ApiError::conflict("This job was claimed again.").with_code("channel_sync/lease-lost"));
    }
    let attempts: i32 = held.try_get("attempts").map_err(store_error)?;
    let kind: String = held.try_get("kind").map_err(store_error)?;
    let listing_key: String = held.try_get("listing_key").map_err(store_error)?;
    let claimed_kind: Option<String> = held.try_get("claimed_kind").map_err(store_error)?;
    let external_id = cap_text(&text_of(body, &["externalId", "external_id"]), MAX_EXTERNAL_ID_CHARS);
    if push_requires_external_id(claimed_kind.as_deref(), outcome, &external_id) {
        return Err(ApiError::bad_request("A push needs the TCGplayer id.").with_code("channel_sync/external-id"));
    }
    let (planned, retry_after, refund) = apply_outcome(attempts, outcome);
    let error = {
        let text = cap_text(&text_of(body, &["error", "lastError"]), MAX_ERROR_CHARS);
        if text.is_empty() || outcome == Outcome::Done { None } else { Some(text) }
    };
    let mut result = body.get("result").cloned().filter(|value| value.is_object()).unwrap_or_else(|| json!({}));
    if !external_id.is_empty() {
        result["externalId"] = json!(external_id);
    }
    let mut shared_sku = false;
    let mut tx = state.write_db().begin().await.map_err(store_error)?;
    let pending_twin: bool = if planned == "pending" {
        sqlx::query_scalar(PENDING_TWIN_SQL)
            .bind(&grant.seller_uid)
            .bind(CHANNEL_TCGPLAYER)
            .bind(&kind)
            .bind(&listing_key)
            .bind(job_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(store_error)?
    } else {
        false
    };
    let (status, _) = collide_pending(planned, pending_twin);
    if outcome == Outcome::Done && status == "done" && !external_id.is_empty() {
        if let Ok(listing_id) = Uuid::parse_str(&listing_key) {
            let other: Option<String> = sqlx::query_scalar(SHARED_SKU_SQL)
                .bind(&grant.seller_uid)
                .bind(CHANNEL_TCGPLAYER)
                .bind(&external_id)
                .bind(listing_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(store_error)?;
            if let Some(other_listing) = other {
                shared_sku = true;
                tracing::warn!(
                    seller = %grant.seller_uid,
                    %listing_id,
                    %external_id,
                    %other_listing,
                    "two Pokoin listings share one TCGplayer SKU; quantities are not summed"
                );
                result["sharedSku"] = json!(true);
            }
        }
    }
    let (updated, written) = write_complete(
        &mut tx,
        job_id,
        lease,
        status,
        refund,
        retry_after as f64,
        &error,
        &result,
        &grant.seller_uid,
    )
    .await?;
    let Some(row) = updated else {
        return Err(ApiError::conflict("This job was claimed again.").with_code("channel_sync/lease-lost"));
    };
    if outcome == Outcome::Done && written == "done" && !external_id.is_empty() {
        let listing_key: String = row.try_get("listing_key").map_err(store_error)?;
        if let Ok(listing_id) = Uuid::parse_str(&listing_key) {
            let (qty, price) = live_link_numbers(&mut tx, &grant.seller_uid, CHANNEL_TCGPLAYER, listing_id).await?;
            upsert_link(&mut tx, &grant.seller_uid, CHANNEL_TCGPLAYER, listing_id, &external_id, qty, price).await?;
        }
    }
    tx.commit().await.map_err(store_error)?;
    let mut response = json!({"ok": true, "status": written});
    if shared_sku {
        response["sharedSku"] = json!(true);
    }
    Ok(response)
}

#[derive(Debug, Clone)]
struct NormalizedLine {
    line_key: String,
    external_id: String,
    quantity: i32,
    name: String,
    price_cents: Option<i64>,
}

#[derive(Debug, Clone)]
struct NormalizedOrder {
    external_order_id: String,
    status: String,
    placed_at: Option<DateTime<Utc>>,
    buyer_name: String,
    ship_to: Value,
    shipping_method: String,
    total_cents: i64,
    currency: String,
    lines: Vec<NormalizedLine>,
}

fn cap_ship_to(value: &Value) -> Value {
    let Some(obj) = value.as_object() else {
        return json!({});
    };
    let mut out = serde_json::Map::new();
    for (key, val) in obj.iter().take(20) {
        let key = cap_text(key, 40);
        if key.is_empty() {
            continue;
        }
        let text = match val {
            Value::String(text) => cap_text(text, 200),
            Value::Number(n) => n.to_string(),
            Value::Bool(flag) => flag.to_string(),
            _ => continue,
        };
        out.insert(key, Value::String(text));
    }
    Value::Object(out)
}

fn normalize_line(line: &Value, index: usize) -> NormalizedLine {
    let mut line_key = cap_text(&text_of(line, &["lineKey", "line_key", "id"]), MAX_LINE_KEY_CHARS);
    let external_id = cap_text(&text_of(line, &["externalId", "external_id", "sku"]), MAX_EXTERNAL_ID_CHARS);
    if line_key.is_empty() {
        line_key = if external_id.is_empty() {
            format!("line:{index}")
        } else {
            cap_text(&format!("ext:{external_id}"), MAX_LINE_KEY_CHARS)
        };
    }
    let quantity = json_i64(line, &["quantity", "qty"]).unwrap_or(0).clamp(0, MAX_LINE_QTY);
    let price = json_i64(line, &["priceCents", "price_cents"]).filter(|cents| *cents >= 0);
    NormalizedLine {
        line_key,
        external_id,
        quantity: quantity as i32,
        name: cap_text(&text_of(line, &["name", "title"]), MAX_NAME_CHARS),
        price_cents: price,
    }
}

/// Validate one device `orders` post. Identifiers that do not fit are refused;
/// display fields and quantities are capped.
fn normalize_orders(raw: &Value) -> Result<Vec<NormalizedOrder>, ApiError> {
    let Some(orders) = raw.as_array() else {
        return Err(ApiError::bad_request("Orders must be a list.").with_code("channel_sync/orders"));
    };
    if orders.len() > MAX_ORDERS_PER_POST {
        return Err(ApiError::bad_request("Too many orders.").with_code("channel_sync/orders"));
    }
    let mut out = Vec::with_capacity(orders.len());
    for order in orders {
        let external_order_id = text_of(order, &["externalOrderId", "orderId", "id"]);
        if external_order_id.is_empty() {
            return Err(ApiError::bad_request("Order is missing an id.").with_code("channel_sync/orders"));
        }
        if external_order_id.chars().count() > MAX_ORDER_ID_CHARS {
            return Err(ApiError::bad_request("Order id is too long.").with_code("channel_sync/orders"));
        }
        let lines_in: Vec<Value> = match order.get("lines") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(lines)) => lines.clone(),
            Some(_) => {
                return Err(ApiError::bad_request("Order lines must be a list.").with_code("channel_sync/orders"));
            }
        };
        if lines_in.len() > MAX_LINES {
            return Err(ApiError::bad_request("Too many lines on an order.").with_code("channel_sync/orders"));
        }
        let mut lines = Vec::with_capacity(lines_in.len());
        let mut seen = std::collections::HashSet::new();
        for (index, line) in lines_in.iter().enumerate() {
            let mut normalized = normalize_line(line, index);
            if !seen.insert(normalized.line_key.clone()) {
                normalized.line_key = cap_text(&format!("{}:{index}", normalized.line_key), MAX_LINE_KEY_CHARS);
                seen.insert(normalized.line_key.clone());
            }
            lines.push(normalized);
        }
        let currency = {
            let raw = text_of(order, &["currency"]).to_ascii_uppercase();
            let letters: String = raw.chars().filter(|ch| ch.is_ascii_alphabetic()).take(8).collect();
            if letters.is_empty() { "USD".to_string() } else { letters }
        };
        let total = json_i64(order, &["totalCents", "total_cents"]).unwrap_or(0).clamp(0, MAX_TOTAL_CENTS);
        let placed = text_of(order, &["placedAt", "placed_at"]);
        let placed_at = chrono::DateTime::parse_from_rfc3339(&placed).ok().map(|at| at.with_timezone(&Utc));
        let status = {
            let raw = text_of(order, &["status"]);
            if raw.is_empty() { "open".to_string() } else { cap_text(&raw, MAX_STATUS_CHARS) }
        };
        out.push(NormalizedOrder {
            external_order_id,
            status,
            placed_at,
            buyer_name: cap_text(&text_of(order, &["buyerName", "buyer_name"]), MAX_BUYER_CHARS),
            ship_to: cap_ship_to(order.get("shipTo").or_else(|| order.get("ship_to")).unwrap_or(&Value::Null)),
            shipping_method: cap_text(&text_of(order, &["shippingMethod", "shipping_method"]), MAX_METHOD_CHARS),
            total_cents: total,
            currency,
            lines,
        });
    }
    Ok(out)
}

fn lines_json(lines: &[NormalizedLine]) -> Value {
    Value::Array(
        lines
            .iter()
            .map(|line| {
                json!({
                    "lineKey": line.line_key,
                    "externalId": line.external_id,
                    "quantity": line.quantity,
                    "name": line.name,
                    "priceCents": line.price_cents,
                })
            })
            .collect(),
    )
}

pub async fn ingest_orders(state: &DomainState, grant: &Grant, body: &Value) -> Result<Value, ApiError> {
    let _device = device_for_grant(state, grant).await?;
    let orders = normalize_orders(body.get("orders").unwrap_or(&Value::Null))?;
    let mut tx = state.write_db().begin().await.map_err(store_error)?;
    sqlx::query(LISTING_CHANGE_SOURCE_SQL)
        .execute(&mut *tx)
        .await
        .map_err(store_error)?;
    let ids: Vec<String> = orders.iter().map(|order| order.external_order_id.clone()).collect();
    let existing: Vec<String> = sqlx::query_scalar(
        "select external_order_id from public.channel_orders \
         where channel = $1 and seller_uid = $2 and external_order_id = any($3)",
    )
    .bind(CHANNEL_TCGPLAYER)
    .bind(&grant.seller_uid)
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(store_error)?;
    let mut seen: std::collections::HashSet<String> = existing.into_iter().collect();
    let mut inserted = 0i64;
    let mut updated = 0i64;
    for order in &orders {
        if seen.insert(order.external_order_id.clone()) {
            inserted += 1;
        } else {
            updated += 1;
        }
        sqlx::query(
            "insert into public.channel_orders \
             (seller_uid, channel, external_order_id, status, placed_at, buyer_name, ship_to, \
              shipping_method, total_cents, currency, lines) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) \
             on conflict (channel, seller_uid, external_order_id) do update set \
               status = excluded.status, \
               placed_at = coalesce(excluded.placed_at, channel_orders.placed_at), \
               buyer_name = excluded.buyer_name, ship_to = excluded.ship_to, \
               shipping_method = excluded.shipping_method, total_cents = excluded.total_cents, \
               currency = excluded.currency, lines = excluded.lines, updated_at = now()",
        )
        .bind(&grant.seller_uid)
        .bind(CHANNEL_TCGPLAYER)
        .bind(&order.external_order_id)
        .bind(&order.status)
        .bind(order.placed_at)
        .bind(&order.buyer_name)
        .bind(&order.ship_to)
        .bind(&order.shipping_method)
        .bind(order.total_cents)
        .bind(&order.currency)
        .bind(lines_json(&order.lines))
        .execute(&mut *tx)
        .await
        .map_err(store_error)?;
    }
    let mut stock_applied = 0i64;
    let mut unmatched = 0i64;
    let mut skipped_cancelled = 0i64;
    let mut skipped_before_link = 0i64;
    let mut skipped_no_date = 0i64;
    for order in &orders {
        if order_skips_stock(&order.status) {
            skipped_cancelled += i64::try_from(order.lines.len()).unwrap_or(0);
            continue;
        }
        for line in &order.lines {
            if line.external_id.is_empty() || line.quantity <= 0 {
                if !line.external_id.is_empty() {
                    unmatched += 1;
                }
                continue;
            }
            let link = sqlx::query(
                "select listing_id, created_at from public.channel_listing_links \
                 where seller_uid = $1 and channel = $2 and external_id = $3 limit 1",
            )
            .bind(&grant.seller_uid)
            .bind(CHANNEL_TCGPLAYER)
            .bind(&line.external_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(store_error)?;
            let created_at = match &link {
                Some(row) => Some(row.try_get("created_at").map_err(store_error)?),
                None => None,
            };
            if link.is_none() && order.placed_at.is_some() {
                unmatched += 1;
                continue;
            }
            let decision = line_stock(order.placed_at, created_at.unwrap_or(DateTime::<Utc>::UNIX_EPOCH));
            match decision {
                LineStock::NoDate => {
                    skipped_no_date += 1;
                    continue;
                }
                LineStock::BeforeLink => {
                    skipped_before_link += 1;
                    continue;
                }
                LineStock::Apply => {}
            }
            let Some(link) = link else {
                unmatched += 1;
                continue;
            };
            let listing_id: Uuid = link.try_get("listing_id").map_err(store_error)?;
            let applied: Option<String> = sqlx::query_scalar(
                "insert into public.channel_order_stock_applied \
                 (channel, seller_uid, external_order_id, line_key, listing_id, quantity) \
                 values ($1, $2, $3, $4, $5, $6) on conflict do nothing returning line_key",
            )
            .bind(CHANNEL_TCGPLAYER)
            .bind(&grant.seller_uid)
            .bind(&order.external_order_id)
            .bind(&line.line_key)
            .bind(listing_id)
            .bind(line.quantity)
            .fetch_optional(&mut *tx)
            .await
            .map_err(store_error)?;
            if applied.is_none() {
                continue;
            }
            stock_applied += 1;
            let row: Option<Value> = sqlx::query_scalar(
                "update public.marketplace_user_listings as listing set \
                   quantity_available = greatest(listing.quantity_available - $3, 0), \
                   status = case when greatest(listing.quantity_available - $3, 0) = 0 then 'sold_out' else listing.status end, \
                   updated_at = now() \
                 where listing.id = $1 and listing.seller_uid = $2 \
                 returning to_jsonb(listing.*)",
            )
            .bind(listing_id)
            .bind(&grant.seller_uid)
            .bind(line.quantity)
            .fetch_optional(&mut *tx)
            .await
            .map_err(store_error)?;
            if let Some(row) = row {
                let game = row["marketplace_game"].as_str().filter(|game| !game.is_empty()).unwrap_or("pokemon");
                let qty_after = number(&row["quantity_available"]);
                let mutation = if qty_after <= 0.0 { "LISTING_SOLD" } else { "LISTING_QUANTITY_CHANGED" };
                let event = listing_sync::event(
                    &row,
                    &json!({"game": game, "sellerUid": grant.seller_uid, "mutation": mutation}),
                    state.now_ms(),
                );
                listing_sync::enqueue(&mut tx, event).await?;
            }
        }
    }
    tx.commit().await.map_err(store_error)?;
    Ok(json!({
        "orders": orders.len(),
        "inserted": inserted,
        "updated": updated,
        "stockApplied": stock_applied,
        "unmatched": unmatched,
        "skippedCancelled": skipped_cancelled,
        "skippedBeforeLink": skipped_before_link,
        "skippedNoDate": skipped_no_date,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn payload(mutation: &str, extra: Value) -> Value {
        let mut body = json!({
            "mutation": mutation,
            "game": "pokemon",
            "merchantListing": {"sealed": false, "graded": false, "productType": "single"},
        });
        if let (Some(obj), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                obj.insert(key.clone(), value.clone());
            }
        }
        body
    }

    #[test]
    fn jobs_follow_the_listing_mutation() {
        let cases = [
            ("LISTING_CREATED", vec![JobKind::PushListing]),
            ("LISTING_REACTIVATED", vec![JobKind::PushListing]),
            ("LISTING_SOLD", vec![JobKind::SetQty]),
            ("LISTING_QUANTITY_CHANGED", vec![JobKind::SetQty]),
            ("LISTING_DELETED", vec![JobKind::SetQty]),
            ("LISTING_DEACTIVATED", vec![JobKind::SetQty]),
            ("LISTING_PRICE_CHANGED", vec![JobKind::SetPrice]),
            ("LISTING_UPDATED", vec![JobKind::SetQty, JobKind::SetPrice]),
            ("LISTING_SHIPPING_ELIGIBILITY_CHANGED", vec![]),
            ("", vec![]),
        ];
        for (mutation, kinds) in cases {
            assert_eq!(jobs_for_event(&payload(mutation, json!({}))), kinds, "{mutation}");
        }
    }

    #[test]
    fn ineligible_listings_enqueue_nothing() {
        assert!(jobs_for_event(&payload("LISTING_CREATED", json!({"game": "riftbound"}))).is_empty());
        assert!(jobs_for_event(&payload(
            "LISTING_CREATED",
            json!({"merchantListing": {"sealed": true, "productType": "single"}})
        ))
        .is_empty());
        assert!(jobs_for_event(&payload(
            "LISTING_CREATED",
            json!({"merchantListing": {"graded": true, "productType": "single"}})
        ))
        .is_empty());
        assert!(jobs_for_event(&payload(
            "LISTING_CREATED",
            json!({"merchantListing": {"productType": "jumbo"}})
        ))
        .is_empty());
        assert_eq!(
            jobs_for_event(&payload("LISTING_CREATED", json!({"merchantListing": {"productType": "card"}}))),
            vec![JobKind::PushListing]
        );
        assert_eq!(
            jobs_for_event(&payload("LISTING_CREATED", json!({"merchantListing": {}}))),
            vec![JobKind::PushListing]
        );
        assert_eq!(
            jobs_for_event(&payload("LISTING_SOLD", json!({"game": ""}))),
            vec![JobKind::SetQty]
        );
    }

    #[test]
    fn channel_cents_matches_the_panel_examples() {
        let rule = |percent, mode| PriceRule { percent_bp: percent, fixed_cents: 0, round_mode: mode };
        assert_eq!(channel_cents(74036.0, &rule(365, RoundMode::Cent)), Some(38369));
        assert_eq!(channel_cents(74036.0, &rule(-500, RoundMode::UpCent)), Some(35168));
        assert_eq!(channel_cents(74036.0, &rule(650, RoundMode::Charm99)), Some(39499));
        assert_eq!(channel_cents(74036.0, &PriceRule::default()), Some(37018));
        // An exact x.99 stays on that cent.
        assert_eq!(channel_cents(20198.0, &rule(0, RoundMode::Charm99)), Some(10099));
        assert_eq!(channel_cents(0.0, &PriceRule::default()), None);
        assert_eq!(channel_cents(-5.0, &PriceRule::default()), None);
        assert_eq!(channel_cents(f64::NAN, &PriceRule::default()), None);
        assert_eq!(channel_cents(f64::INFINITY, &PriceRule::default()), None);
    }

    #[test]
    fn badges_follow_the_heartbeat_window() {
        let now = Utc.with_ymd_and_hms(2026, 10, 15, 12, 0, 0).unwrap();
        assert_eq!(
            badges(None, now),
            json!({"usingSync": false, "online": false, "running": false, "signedIn": false})
        );
        let fresh = DeviceRow {
            enabled: true,
            running: true,
            signed_in: true,
            revoked_at: None,
            last_heartbeat_at: Some(now - chrono::Duration::seconds(90)),
        };
        assert_eq!(
            badges(Some(&fresh), now),
            json!({"usingSync": true, "online": true, "running": true, "signedIn": true})
        );
        let stale = DeviceRow {
            last_heartbeat_at: Some(now - chrono::Duration::seconds(91)),
            ..fresh.clone()
        };
        assert_eq!(
            badges(Some(&stale), now),
            json!({"usingSync": true, "online": false, "running": false, "signedIn": false})
        );
        let quiet = DeviceRow { running: false, signed_in: false, ..fresh.clone() };
        assert_eq!(badges(Some(&quiet), now)["running"], false);
        assert_eq!(badges(Some(&quiet), now)["signedIn"], false);
        assert_eq!(badges(Some(&quiet), now)["online"], true);
        let off = DeviceRow { enabled: false, ..fresh.clone() };
        assert_eq!(badges(Some(&off), now)["usingSync"], false);
        let revoked = DeviceRow { revoked_at: Some(now), ..fresh };
        assert_eq!(badges(Some(&revoked), now)["usingSync"], false);
    }

    #[test]
    fn outcomes_back_off_and_die_after_eight_attempts() {
        assert_eq!(next_backoff_seconds(0), 30);
        assert_eq!(next_backoff_seconds(1), 120);
        assert_eq!(next_backoff_seconds(6), 30 * 4i64.pow(6));
        assert_eq!(next_backoff_seconds(7), 30 * 4i64.pow(6));
        assert_eq!(apply_outcome(0, Outcome::Retry), ("pending", 30, false));
        assert_eq!(apply_outcome(3, Outcome::Done), ("done", 0, false));
        assert_eq!(apply_outcome(3, Outcome::Failed), ("failed", 0, false));
        assert!(CLAIM_SQL.contains("for update skip locked"));
        assert!(CLAIM_SQL.contains(&format!("attempts < {MAX_ATTEMPTS}")) && MAX_ATTEMPTS == 8);
        assert!(CLAIM_SQL.contains("attempts = job.attempts + 1"));
        assert!(CLAIM_SQL.contains("claimed_kind = job.kind"));
        assert!(COMPLETE_SQL.contains("lease_token = $2"), "complete is fenced on the lease token");
        assert!(COMPLETE_SQL.contains("greatest(attempts - 1, 0)"));
        assert!(!COMPLETE_SQL.contains("attempts +"));
        assert!(ENQUEUE_SQL.contains("on conflict (seller_uid, channel, kind, listing_key) where status = 'pending'"));
        assert!(!ENQUEUE_SQL.contains("claimed"));
        assert!(ENQUEUE_SQL.contains("available_at = now()"));
        assert!(ENQUEUE_SKIPPED_SQL.contains("skip_count = channel_sync_jobs.skip_count + 1"));
    }

    #[test]
    fn a_claimed_job_keeps_a_newer_pending_edit() {
        assert_eq!(collide_pending("pending", true), ("skipped", Some("superseded")));
        assert_eq!(collide_pending("pending", false), ("pending", None));
        assert_eq!(collide_pending("done", true), ("done", None));
        assert_eq!(collide_pending("dead", true), ("dead", None));
        assert!(PENDING_TWIN_SQL.contains("status = 'pending' and id <> $5"));
        assert!(PULL_ORDERS_HEARTBEAT_SQL.contains("where not exists"));
        assert!(PULL_ORDERS_HEARTBEAT_SQL.contains("status in ('pending', 'claimed')"));
        assert!(!PULL_ORDERS_HEARTBEAT_SQL.contains("on conflict"));
        assert!(PULL_ORDERS_SYNC_NOW_SQL.contains("where not exists"));
        assert!(PULL_ORDERS_SYNC_NOW_SQL.contains("status in ('pending', 'claimed')"));
        assert!(PULL_ORDERS_SYNC_NOW_SQL.contains("status = 'pending'"));
    }

    #[test]
    fn the_eighth_claim_is_dead_and_sign_in_returns_the_attempt() {
        assert_eq!(apply_outcome(7, Outcome::Retry).0, "pending");
        assert_eq!(apply_outcome(7, Outcome::Retry).2, false);
        assert_eq!(apply_outcome(8, Outcome::Retry), ("dead", 0, false));
        assert_eq!(apply_outcome(8, Outcome::NeedsSignIn), ("pending", 0, true));
        assert!(CLAIM_SQL.contains("attempts = job.attempts + 1"));
        assert!(COMPLETE_SQL.contains("greatest(attempts - 1, 0)"));
    }

    #[test]
    fn the_lease_covers_a_short_claim_batch() {
        assert_eq!(LEASE_SECONDS, 300);
        assert_eq!(MAX_CLAIM, 20);
        assert!(CLAIM_SQL.contains(&format!("make_interval(secs => {LEASE_SECONDS})")));
        assert!(!CLAIM_SQL.contains("120"));
    }

    #[test]
    fn enable_fans_listings_out_as_set_qty() {
        assert!(ENABLE_SET_QTY_SQL.contains("coalesce(nullif(l.marketplace_game, ''), 'pokemon') = 'pokemon'"));
        assert!(ENABLE_SET_QTY_SQL.contains("not coalesce(l.sealed, false)"));
        assert!(ENABLE_SET_QTY_SQL.contains("not coalesce(l.graded, false)"));
        assert!(ENABLE_SET_QTY_SQL.contains("l.status = 'active' and l.quantity_available > 0"));
        assert!(ENABLE_SET_QTY_SQL.contains("channel_listing_links"));
        assert!(ENABLE_SET_QTY_SQL.contains("on conflict (seller_uid, channel, kind, listing_key) where status = 'pending'"));
        assert!(ENABLE_RESYNC_RECORD_SQL.contains("'full_resync'"));
        assert!(ENABLE_RESYNC_RECORD_SQL.contains("'done'"));
        assert!(ENABLE_RESYNC_RECORD_SQL.contains("jsonb_build_object('queued', $3)"));
        assert!(CLAIM_SQL.contains("kind <> 'full_resync'"));
    }

    #[test]
    fn a_push_done_needs_the_external_id() {
        assert!(push_requires_external_id(Some("push_listing"), Outcome::Done, ""));
        assert!(!push_requires_external_id(Some("push_listing"), Outcome::Done, "sku-1"));
        assert!(!push_requires_external_id(Some("set_qty"), Outcome::Done, ""));
        assert!(!push_requires_external_id(Some("push_listing"), Outcome::Retry, ""));
        assert!(!push_requires_external_id(None, Outcome::Done, ""));
        assert!(CLAIM_SQL.contains("claimed_kind = job.kind"));
        assert!(SHARED_SKU_SQL.contains("external_id = $3"));
        assert!(SHARED_SKU_SQL.contains("listing_id <> $4"));
        let update = LINK_UPSERT_SQL.split("do update set").nth(1).expect("update");
        assert!(!update.contains("created_at"));
    }

    #[test]
    fn stock_follows_the_link_clock() {
        let linked = Utc.with_ymd_and_hms(2026, 10, 16, 12, 0, 0).unwrap();
        let before = Utc.with_ymd_and_hms(2026, 10, 16, 11, 59, 59).unwrap();
        let after = Utc.with_ymd_and_hms(2026, 10, 16, 12, 0, 1).unwrap();
        assert_eq!(line_stock(None, linked), LineStock::NoDate);
        assert_eq!(line_stock(Some(before), linked), LineStock::BeforeLink);
        assert_eq!(line_stock(Some(linked), linked), LineStock::Apply);
        assert_eq!(line_stock(Some(after), linked), LineStock::Apply);
    }

    #[test]
    fn cancelled_and_refunded_orders_skip_stock() {
        assert!(order_skips_stock("Cancelled"));
        assert!(order_skips_stock("CANCELLED"));
        assert!(order_skips_stock("partially_refunded"));
        assert!(order_skips_stock("Refund"));
        assert!(!order_skips_stock("paid"));
        assert!(!order_skips_stock("open"));
        let orders = normalize_orders(&json!([{
            "externalOrderId": "c-1",
            "status": "Cancelled",
            "lines": [{"externalId": "sku", "quantity": 2}, {"externalId": "sku-2", "quantity": 1}]
        }]))
        .unwrap();
        assert!(order_skips_stock(&orders[0].status));
        assert_eq!(orders[0].lines.len(), 2);
    }

    #[test]
    fn order_posts_are_capped() {
        let mut too_many = Vec::new();
        for index in 0..201 {
            too_many.push(json!({"externalOrderId": format!("o{index}"), "lines": []}));
        }
        assert_eq!(
            normalize_orders(&Value::Array(too_many)).unwrap_err().code.as_deref(),
            Some("channel_sync/orders")
        );
        assert!(normalize_orders(&json!({"externalOrderId": "x"})).is_err());
        assert!(normalize_orders(&json!([{"lines": []}])).is_err());
        let long_id = "o".repeat(81);
        assert!(normalize_orders(&json!([{"externalOrderId": long_id, "lines": []}])).is_err());
        let orders = normalize_orders(&json!([{
            "externalOrderId": " ord-1 ",
            "buyerName": "x".repeat(500),
            "status": "paid",
            "totalCents": 50_000_000_000i64,
            "currency": "usd!",
            "shipTo": {"name": "y".repeat(400), "n": 1, "skip": {"a": 1}},
            "lines": [
                {"externalId": "sku-9", "quantity": 50_000, "name": "n".repeat(400)},
                {"quantity": 0}
            ]
        }]))
        .unwrap();
        assert_eq!(orders.len(), 1);
        assert_eq!(orders[0].external_order_id, "ord-1");
        assert_eq!(orders[0].buyer_name.chars().count(), MAX_BUYER_CHARS);
        assert_eq!(orders[0].total_cents, MAX_TOTAL_CENTS);
        assert_eq!(orders[0].currency, "USD");
        assert_eq!(orders[0].ship_to["name"].as_str().unwrap().chars().count(), 200);
        assert!(orders[0].ship_to.get("skip").is_none());
        assert_eq!(orders[0].lines[0].quantity, MAX_LINE_QTY as i32);
        assert_eq!(orders[0].lines[0].name.chars().count(), MAX_NAME_CHARS);
        assert_eq!(orders[0].lines[0].external_id, "sku-9");
        assert!(orders[0].lines[1].external_id.is_empty());
        let lines = {
            let mut lines = Vec::new();
            for _ in 0..=MAX_LINES {
                lines.push(json!({"externalId": "sku", "quantity": 1}));
            }
            lines
        };
        assert!(normalize_orders(&json!([{"externalOrderId": "o", "lines": lines}])).is_err());
    }
}
