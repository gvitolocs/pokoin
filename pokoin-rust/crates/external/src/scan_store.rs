//! Scan Connect persistence — native port of the Postgres half of
//! `_scan_store.js`.
//!
//! Every read and write goes to the **writer** pool (a replica would miss the
//! row it was just told about). SQL is transcribed from the reference; rows are
//! returned as `serde_json::Value` in snake_case so [`crate::scan_connect`]
//! view builders can serialize them.

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use time::OffsetDateTime;

use crate::db::DbPools;
use crate::error::{ApiError, ApiResult};
use crate::scan_connect as rules;

fn row_value(row: &sqlx::postgres::PgRow) -> Value {
    crate::db::rows_to_json(std::slice::from_ref(row))
        .into_iter()
        .next()
        .unwrap_or(Value::Null)
}

async fn writer(db: &DbPools) -> ApiResult<PgPool> {
    db.writer()
}

fn window_start(now_ms: i64, window_ms: i64) -> OffsetDateTime {
    let window = window_ms.max(1);
    let start = (now_ms / window) * window;
    OffsetDateTime::from_unix_timestamp_nanos(start as i128 * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

fn retry_after(limit: rules::Limit, now_ms: i64) -> u64 {
    let window = limit.window_ms.max(1);
    let start = (now_ms / window) * window;
    let remaining = start + window - now_ms;
    ((remaining.max(0) as f64 / 1000.0).ceil() as u64).max(1)
}

fn too_many(limit: rules::Limit, now_ms: i64) -> ApiError {
    let mut error = ApiError::new(429, "Too many attempts. Wait a moment and try again.")
        .with_code("rate_limited");
    error.retry_after_sec = Some(retry_after(limit, now_ms));
    error
}

async fn limit_hits(
    conn: &mut sqlx::PgConnection,
    bucket: &str,
    limit: rules::Limit,
    now_ms: i64,
) -> ApiResult<i64> {
    let row = sqlx::query("select hits from public.scan_rate_limits where bucket = $1 and window_start = $2")
        .bind(bucket)
        .bind(window_start(now_ms, limit.window_ms))
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row
        .and_then(|row| row.try_get::<i64, _>("hits").ok())
        .unwrap_or(0))
}

async fn limit_increment(
    conn: &mut sqlx::PgConnection,
    bucket: &str,
    limit: rules::Limit,
    now_ms: i64,
) -> ApiResult<i64> {
    let row = sqlx::query(
        "insert into public.scan_rate_limits (bucket, window_start, hits)
         values ($1, $2, 1)
         on conflict (bucket, window_start) do update set hits = public.scan_rate_limits.hits + 1
         returning hits",
    )
    .bind(bucket)
    .bind(window_start(now_ms, limit.window_ms))
    .fetch_one(&mut *conn)
    .await?;
    Ok(row.try_get::<i64, _>("hits").unwrap_or(0))
}

async fn enforce_limit(
    conn: &mut sqlx::PgConnection,
    bucket: &str,
    limit: rules::Limit,
    now_ms: i64,
) -> ApiResult<()> {
    let hits = limit_increment(conn, bucket, limit, now_ms).await?;
    if hits > limit.max {
        return Err(too_many(limit, now_ms));
    }
    Ok(())
}

/// `createPairing` — 20 attempts at a free 4-digit PIN.
pub async fn create_pairing(
    conn: &mut sqlx::PgConnection,
    session_id: &str,
    now: OffsetDateTime,
) -> ApiResult<Value> {
    sqlx::query("delete from public.scan_pairings where session_id = $1")
        .bind(session_id)
        .execute(&mut *conn)
        .await?;
    let expires_at = now + time::Duration::milliseconds(rules::PAIRING_TTL_MS);
    for _ in 0..20 {
        let pin = rules::random_pin();
        let qr_secret = rules::random_secret(24);
        sqlx::query("delete from public.scan_pairings where pin = $1 and expires_at <= now()")
            .bind(&pin)
            .execute(&mut *conn)
            .await?;
        let inserted = sqlx::query(
            "insert into public.scan_pairings (pin, session_id, qr_secret, expires_at)
             values ($1, $2, $3, $4)
             on conflict (pin) do nothing
             returning pin, qr_secret, expires_at",
        )
        .bind(&pin)
        .bind(session_id)
        .bind(&qr_secret)
        .bind(expires_at)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some(row) = inserted {
            let value = row_value(&row);
            return Ok(json!({
                "pin": value.get("pin").cloned().unwrap_or(json!(pin)),
                "qrSecret": value.get("qr_secret").cloned().unwrap_or(json!(qr_secret)),
                "expiresAt": value.get("expires_at").cloned().unwrap_or(json!(crate::time_util::iso_from_offset(expires_at))),
            }));
        }
    }
    Err(ApiError::unavailable("No free pairing code. Try again.").with_code("pin_exhausted"))
}

/// `pairingForSession`.
pub async fn pairing_for_session(conn: &mut sqlx::PgConnection, session_id: &str) -> ApiResult<Option<Value>> {
    let row = sqlx::query(
        "select pin, qr_secret, expires_at from public.scan_pairings where session_id = $1 and expires_at > now()",
    )
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|row| {
        let value = row_value(&row);
        json!({
            "pin": value.get("pin"),
            "qrSecret": value.get("qr_secret"),
            "expiresAt": value.get("expires_at"),
        })
    }))
}

/// `endSessionRow`.
pub async fn end_session_row(
    conn: &mut sqlx::PgConnection,
    session_id: &str,
    reason: &str,
) -> ApiResult<Option<Value>> {
    sqlx::query("delete from public.scan_pairings where session_id = $1")
        .bind(session_id)
        .execute(&mut *conn)
        .await?;
    let row = sqlx::query(
        "update public.scan_sessions
           set status = 'ended', end_reason = $2, ended_at = now(), phone_token_hash = null, version = version + 1
         where id = $1 and status <> 'ended'
         returning *",
    )
    .bind(session_id)
    .bind(reason)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.as_ref().map(row_value))
}

/// `disconnectPhoneRow` — drop the phone credential, keep the session + batch.
pub async fn disconnect_phone_row(
    conn: &mut sqlx::PgConnection,
    session_id: &str,
    now: OffsetDateTime,
) -> ApiResult<Option<Value>> {
    let row = sqlx::query(
        "update public.scan_sessions
           set status = 'waiting', phone_token_hash = null, phone_label = '', phone_connected_at = null,
               phone_last_seen_at = null, last_scan_at = null, last_activity_at = now(), version = version + 1
         where id = $1 and status = 'connected'
         returning *",
    )
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let value = row_value(&row);
    let _ = create_pairing(conn, session_id, now).await?;
    Ok(Some(value))
}

/// `liveSessionForBatch` — expire/disconnect stale sessions, keep at most one.
pub async fn live_session_for_batch(
    conn: &mut sqlx::PgConnection,
    seller_uid: &str,
    batch_id: &str,
    now_ms: i64,
    now: OffsetDateTime,
) -> ApiResult<Option<Value>> {
    let rows = sqlx::query(
        "select * from public.scan_sessions
         where seller_uid = $1 and batch_id = $2 and status <> 'ended'
         order by created_at desc
         for update",
    )
    .bind(seller_uid)
    .bind(batch_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut live: Option<Value> = None;
    for row in rows {
        let value = row_value(&row);
        let id = value.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        if rules::is_scan_idle_expired(&value, now_ms) {
            let dropped = disconnect_phone_row(conn, &id, now).await?;
            if live.is_none() {
                live = dropped.or(Some(value));
            }
        } else if rules::is_idle_expired(&value, now_ms) {
            let _ = end_session_row(conn, &id, "expired").await?;
        } else if live.is_none() {
            live = Some(value);
        } else {
            let _ = end_session_row(conn, &id, "replaced").await?;
        }
    }
    Ok(live)
}

/// `startSession` — resume or create the open batch + session (+ pairing).
pub async fn start_session(db: &DbPools, seller_uid: &str, batch_id: &str) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let now = OffsetDateTime::now_utc();
    let now_ms = crate::time_util::now_ms();

    let batch: Option<Value> = if !batch_id.is_empty() {
        if !rules::is_uuid(batch_id) {
            return Err(ApiError::not_found("Batch not found."));
        }
        let row = sqlx::query("select * from public.scan_batches where id = $1 and seller_uid = $2 for update")
            .bind(batch_id)
            .bind(seller_uid)
            .fetch_optional(&mut *tx)
            .await?;
        let value = row.as_ref().map(row_value);
        match value {
            None => return Err(ApiError::not_found("Batch not found.")),
            Some(value) if value.get("status").and_then(Value::as_str) != Some("open") => {
                return Err(ApiError::conflict("This batch is closed.").with_code("batch_closed"));
            }
            other => other,
        }
    } else {
        let row = sqlx::query(
            "select * from public.scan_batches where seller_uid = $1 and status = 'open'
             order by updated_at desc limit 1 for update",
        )
        .bind(seller_uid)
        .fetch_optional(&mut *tx)
        .await?;
        row.as_ref().map(row_value)
    };

    let batch = match batch {
        Some(batch) => batch,
        None => {
            let previous = sqlx::query(
                "select defaults from public.scan_batches
                  where seller_uid = $1 and coalesce(defaults->>'location', '') <> ''
                  order by updated_at desc limit 1",
            )
            .bind(seller_uid)
            .fetch_optional(&mut *tx)
            .await?;
            let last = previous.map(|row| row_value(&row)).and_then(|value| value.get("defaults").cloned());
            let defaults = match last {
                Some(last) => rules::normalize_defaults(
                    &json!({"location": last.get("location"), "stackSize": last.get("stackSize")}),
                    &rules::default_batch_defaults(),
                ),
                None => rules::default_batch_defaults(),
            };
            let history = rules::append_defaults(&json!([]), &defaults, 1, now_ms, 500);
            let created = sqlx::query(
                "insert into public.scan_batches (seller_uid, defaults, defaults_history)
                 values ($1, $2, $3) returning *",
            )
            .bind(seller_uid)
            .bind(sqlx::types::Json(&defaults))
            .bind(sqlx::types::Json(&history))
            .fetch_one(&mut *tx)
            .await?;
            row_value(&created)
        }
    };

    let mut session = live_session_for_batch(&mut tx, seller_uid, batch["id"].as_str().unwrap_or_default(), now_ms, now).await?;
    if session.is_none() {
        enforce_limit(&mut tx, &format!("start:{seller_uid}"), rules::LIMIT_SESSION_START_PER_SELLER, now_ms).await?;
        let inserted = sqlx::query(
            "insert into public.scan_sessions (seller_uid, batch_id) values ($1, $2) returning *",
        )
        .bind(seller_uid)
        .bind(batch["id"].as_str().unwrap_or_default())
        .fetch_one(&mut *tx)
        .await?;
        session = Some(row_value(&inserted));
    }
    let session = session.expect("session created above");
    let mut pairing = Value::Null;
    if session.get("status").and_then(Value::as_str) == Some("waiting") {
        let session_id = session["id"].as_str().unwrap_or_default();
        pairing = match pairing_for_session(&mut tx, session_id).await? {
            Some(pairing) => pairing,
            None => create_pairing(&mut tx, session_id, now).await?,
        };
    }
    tx.commit().await?;
    Ok(json!({
        "session": rules::session_view(&session, now_ms),
        "batch": rules::batch_view(&batch),
        "pairing": pairing,
        "serverTime": now_ms,
    }))
}

/// `lockSession`.
pub async fn lock_session(
    conn: &mut sqlx::PgConnection,
    seller_uid: &str,
    session_id: &str,
) -> ApiResult<Value> {
    if !rules::is_uuid(session_id) {
        return Err(ApiError::not_found("Session not found."));
    }
    let row = sqlx::query("select * from public.scan_sessions where id = $1 and seller_uid = $2 for update")
        .bind(session_id)
        .bind(seller_uid)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(row_value)
        .ok_or_else(|| ApiError::not_found("Session not found."))
}

/// `regeneratePairing`.
pub async fn regenerate_pairing(db: &DbPools, seller_uid: &str, session_id: &str) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let now = OffsetDateTime::now_utc();
    let now_ms = crate::time_util::now_ms();
    let session = lock_session(&mut tx, seller_uid, session_id).await?;
    if session.get("status").and_then(Value::as_str) != Some("waiting") {
        return Err(ApiError::conflict("A phone is already connected. Disconnect it first.")
            .with_code("not_waiting"));
    }
    if rules::is_idle_expired(&session, now_ms) {
        let _ = end_session_row(&mut tx, session_id, "expired").await?;
        tx.commit().await?;
        return Err(ApiError::new(410, "Session expired.").with_code("session_expired"));
    }
    enforce_limit(&mut tx, &format!("regen:{session_id}"), rules::LIMIT_PAIRING_REGEN_PER_SESSION, now_ms).await?;
    sqlx::query("update public.scan_sessions set last_activity_at = now() where id = $1")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
    let pairing = create_pairing(&mut tx, session_id, now).await?;
    tx.commit().await?;
    Ok(json!({ "pairing": pairing, "serverTime": now_ms }))
}

/// `getSession`.
pub async fn get_session(db: &DbPools, seller_uid: &str, session_id: &str) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let now = OffsetDateTime::now_utc();
    let now_ms = crate::time_util::now_ms();
    let session = lock_session(&mut tx, seller_uid, session_id).await?;
    let mut row = session.clone();
    let mut just_expired = false;
    let mut just_idle_disconnected = false;
    if rules::is_scan_idle_expired(&session, now_ms) {
        row = disconnect_phone_row(&mut tx, session_id, now).await?.unwrap_or(session);
        just_idle_disconnected = true;
    } else if rules::is_idle_expired(&session, now_ms) {
        row = end_session_row(&mut tx, session_id, "expired").await?.unwrap_or(session);
        just_expired = true;
    }
    let pairing = if row.get("status").and_then(Value::as_str) == Some("waiting") {
        pairing_for_session(&mut tx, row["id"].as_str().unwrap_or_default()).await?
    } else {
        None
    };
    tx.commit().await?;
    let _ = just_expired;
    Ok(json!({
        "session": rules::session_view(&row, now_ms),
        "pairing": pairing,
        "serverTime": now_ms,
        "justIdleDisconnected": just_idle_disconnected,
    }))
}

/// `updateSession` — pause / disconnect / end, then return the fresh session.
pub async fn update_session(
    db: &DbPools,
    seller_uid: &str,
    session_id: &str,
    action: &str,
    reason: &str,
    paused: bool,
) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let now = OffsetDateTime::now_utc();
    let session = lock_session(&mut tx, seller_uid, session_id).await?;
    if session.get("status").and_then(Value::as_str) == Some("ended") {
        tx.commit().await?;
        return get_session(db, seller_uid, session_id).await;
    }
    match action {
        "end" => {
            let clean = if reason == "completed" || reason == "logout" { reason } else { "completed" };
            let _ = end_session_row(&mut tx, session_id, clean).await?;
        }
        "disconnect" => {
            sqlx::query(
                "update public.scan_sessions
                   set status = 'waiting', phone_token_hash = null, phone_label = '', phone_connected_at = null,
                       phone_last_seen_at = null, last_scan_at = null, last_activity_at = now(), version = version + 1
                 where id = $1",
            )
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
            let _ = create_pairing(&mut tx, session_id, now).await?;
        }
        "pause" => {
            sqlx::query(
                "update public.scan_sessions set paused = $2, last_activity_at = now(), version = version + 1
                 where id = $1",
            )
            .bind(session_id)
            .bind(paused)
            .execute(&mut *tx)
            .await?;
        }
        _ => return Err(ApiError::bad_request("Unknown session action.")),
    }
    tx.commit().await?;
    get_session(db, seller_uid, session_id).await
}

async fn session_for_token(
    conn: &mut sqlx::PgConnection,
    token: &str,
    lock: bool,
) -> ApiResult<Option<Value>> {
    if token.len() < 30 || token.len() > 64 {
        return Ok(None);
    }
    let sql = format!(
        "select s.*, b.status as batch_status, b.defaults as batch_defaults
         from public.scan_sessions s join public.scan_batches b on b.id = s.batch_id
         where s.phone_token_hash = $1 {}",
        if lock { "for update of s" } else { "" }
    );
    let row = sqlx::query(&sql)
        .bind(rules::sha256(token))
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.as_ref().map(row_value))
}

fn session_gone(idle: bool) -> ApiError {
    if idle {
        ApiError::new(401, "Session expired after 10 minutes without a scan. Pair again.")
            .with_code("session_idle")
    } else {
        ApiError::new(401, "This scanner is no longer connected.").with_code("session_ended")
    }
}

/// `claimPairing` — phone claims PIN/QR and receives a phone token.
pub async fn claim_pairing(
    db: &DbPools,
    pin: &str,
    qr: &str,
    ip: &str,
    user_agent: &str,
    device: &str,
) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let now_ms = crate::time_util::now_ms();
    let code = if rules::is_pin(pin) { pin.to_string() } else { String::new() };
    let secret = if qr.len() >= 20 && qr.len() <= 64 && qr.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        qr.to_string()
    } else {
        String::new()
    };

    let ip_bucket = format!("pairfail:ip:{ip}");
    let global_bucket = "pairfail:global".to_string();
    if limit_hits(&mut tx, &global_bucket, rules::LIMIT_PAIR_FAIL_GLOBAL, now_ms).await?
        >= rules::LIMIT_PAIR_FAIL_GLOBAL.max
    {
        return Err(too_many(rules::LIMIT_PAIR_FAIL_GLOBAL, now_ms));
    }
    if limit_hits(&mut tx, &ip_bucket, rules::LIMIT_PAIR_FAIL_PER_IP, now_ms).await?
        >= rules::LIMIT_PAIR_FAIL_PER_IP.max
    {
        return Err(too_many(rules::LIMIT_PAIR_FAIL_PER_IP, now_ms));
    }
    let tries = limit_increment(&mut tx, &format!("pairtry:ip:{ip}"), rules::LIMIT_PAIR_TRY_PER_IP, now_ms).await?;
    if tries > rules::LIMIT_PAIR_TRY_PER_IP.max {
        return Err(too_many(rules::LIMIT_PAIR_TRY_PER_IP, now_ms));
    }

    let mut claimed_session_id: Option<String> = None;
    if !code.is_empty() || !secret.is_empty() {
        let row = sqlx::query(
            "delete from public.scan_pairings
              where expires_at > now()
                and (
                  ($1 <> '' and $2 <> '' and pin = $1 and qr_secret = $2)
                  or ($1 <> '' and $2 = '' and pin = $1)
                  or ($1 = '' and $2 <> '' and qr_secret = $2)
                )
              returning session_id",
        )
        .bind(&code)
        .bind(&secret)
        .fetch_optional(&mut *tx)
        .await?;
        claimed_session_id = row.and_then(|row| row.try_get::<String, _>("session_id").ok());
    }

    let mut session: Option<Value> = None;
    if let Some(session_id) = &claimed_session_id {
        let row = sqlx::query(
            "select s.* from public.scan_sessions s
             join public.scan_batches b on b.id = s.batch_id and b.status = 'open'
             where s.id = $1 for update of s",
        )
        .bind(session_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(row) = row {
            let value = row_value(&row);
            let ok = value.get("status").and_then(Value::as_str) == Some("waiting")
                && !rules::is_idle_expired(&value, now_ms);
            if ok {
                session = Some(value);
            }
        }
    }

    let Some(session) = session else {
        limit_increment(&mut tx, &ip_bucket, rules::LIMIT_PAIR_FAIL_PER_IP, now_ms).await?;
        limit_increment(&mut tx, &global_bucket, rules::LIMIT_PAIR_FAIL_GLOBAL, now_ms).await?;
        tx.commit().await?;
        return Err(ApiError::bad_request("Code not valid or expired.").with_code("invalid_code"));
    };

    let phone_token = rules::random_secret(32);
    let label = rules::device_label(user_agent, device);
    let session_id = session["id"].as_str().unwrap_or_default().to_string();
    let updated = sqlx::query(
        "update public.scan_sessions
           set status = 'connected', phone_token_hash = $2, phone_label = $3, phone_connected_at = now(),
               phone_last_seen_at = now(), last_scan_at = null, last_activity_at = now(), version = version + 1
         where id = $1 returning *",
    )
    .bind(&session_id)
    .bind(rules::sha256(&phone_token))
    .bind(&label)
    .fetch_one(&mut *tx)
    .await?;
    let updated = row_value(&updated);
    let batch_id = updated["batch_id"].as_str().unwrap_or_default().to_string();
    let batch_row = sqlx::query("select defaults from public.scan_batches where id = $1")
        .bind(&batch_id)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;

    let defaults = batch_row
        .map(|row| row_value(&row))
        .and_then(|value| value.get("defaults").cloned())
        .unwrap_or_else(rules::default_batch_defaults);
    let normalized = rules::normalize_defaults(&defaults, &rules::default_batch_defaults());
    let game = normalized.get("game").and_then(Value::as_str).unwrap_or("pokemon").to_string();
    Ok(json!({
        "phoneToken": phone_token,
        "sessionId": updated["id"],
        "serverTime": now_ms,
        "label": "Pokoin Dashboard",
        "defaultsLabel": rules::defaults_label(&defaults),
        "game": game,
        "scanCatalog": rules::scan_phone_catalog(&game),
    }))
}

/// `heartbeat`.
pub async fn heartbeat(db: &DbPools, token: &str) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let now = OffsetDateTime::now_utc();
    let now_ms = crate::time_util::now_ms();
    let Some(session) = session_for_token(&mut tx, token, true).await? else {
        tx.commit().await?;
        return Err(session_gone(false));
    };
    if rules::is_scan_idle_expired(&session, now_ms) {
        let _ = disconnect_phone_row(&mut tx, session["id"].as_str().unwrap_or_default(), now).await?;
        tx.commit().await?;
        return Err(session_gone(true));
    }
    if rules::is_idle_expired(&session, now_ms) {
        let _ = end_session_row(&mut tx, session["id"].as_str().unwrap_or_default(), "expired").await?;
        tx.commit().await?;
        return Err(session_gone(false));
    }
    let last_seen = session
        .get("phone_last_seen_at")
        .and_then(Value::as_str)
        .and_then(crate::time_util::ms_from_iso)
        .unwrap_or(0);
    let was_lost = last_seen == 0 || now_ms - last_seen >= rules::PHONE_LOST_MS;
    sqlx::query("update public.scan_sessions set phone_last_seen_at = now() where id = $1")
        .bind(session["id"].as_str().unwrap_or_default())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let batch_defaults = session
        .get("batch_defaults")
        .cloned()
        .unwrap_or_else(rules::default_batch_defaults);
    let normalized = rules::normalize_defaults(&batch_defaults, &rules::default_batch_defaults());
    let game = normalized.get("game").and_then(Value::as_str).unwrap_or("pokemon").to_string();
    Ok(json!({
        "sessionId": session["id"],
        "batchId": session["batch_id"],
        "status": session["status"],
        "paused": session.get("paused") == Some(&Value::Bool(true)),
        "serverTime": now_ms,
        "defaultsLabel": rules::defaults_label(&batch_defaults),
        "game": game,
        "scanCatalog": rules::scan_phone_catalog(&game),
        "received": session.get("phone_scans").and_then(Value::as_i64).unwrap_or(0),
        "wasLost": was_lost,
    }))
}

/// `leave`.
pub async fn leave(db: &DbPools, token: &str) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let now = OffsetDateTime::now_utc();
    let Some(session) = session_for_token(&mut tx, token, true).await? else {
        tx.commit().await?;
        return Ok(json!({ "ok": true }));
    };
    let session_id = session["id"].as_str().unwrap_or_default().to_string();
    sqlx::query(
        "update public.scan_sessions
           set status = 'waiting', phone_token_hash = null, phone_label = '', phone_connected_at = null,
               phone_last_seen_at = null, last_scan_at = null, version = version + 1
         where id = $1",
    )
    .bind(&session_id)
    .execute(&mut *tx)
    .await?;
    let _ = create_pairing(&mut tx, &session_id, now).await?;
    tx.commit().await?;
    Ok(json!({ "ok": true }))
}

/// `readBatchSnapshot` style: batch row + its items ordered by seq.
pub async fn read_batch_snapshot(db: &DbPools, seller_uid: &str, batch_id: &str) -> ApiResult<Value> {
    if !rules::is_uuid(batch_id) {
        return Err(ApiError::not_found("Batch not found."));
    }
    let pool = writer(db).await?;
    let batch = sqlx::query("select * from public.scan_batches where id = $1 and seller_uid = $2")
        .bind(batch_id)
        .bind(seller_uid)
        .fetch_optional(&pool)
        .await?
        .map(|row| row_value(&row))
        .ok_or_else(|| ApiError::not_found("Batch not found."))?;
    let items = sqlx::query("select * from public.scan_items where batch_id = $1 order by seq asc limit 10000")
        .bind(batch_id)
        .fetch_all(&pool)
        .await?;
    let items: Vec<Value> = items.iter().map(row_value).collect();
    Ok(json!({
        "batch": rules::batch_view(&batch),
        "items": items,
        "cursor": batch.get("item_seq").and_then(Value::as_i64).unwrap_or(0),
    }))
}

/// Items changed after `cursor` (stream replay).
pub async fn items_after(db: &DbPools, batch_id: &str, cursor: i64, limit: i64) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let rows = sqlx::query(
        "select * from public.scan_items where batch_id = $1 and seq > $2 order by seq asc limit $3",
    )
    .bind(batch_id)
    .bind(cursor)
    .bind(limit.clamp(1, 500))
    .fetch_all(&pool)
    .await?;
    Ok(Value::Array(rows.iter().map(row_value).collect()))
}

/// `latestSession` for a batch (stream header).
pub async fn latest_session(db: &DbPools, batch_id: &str) -> ApiResult<Option<Value>> {
    let pool = writer(db).await?;
    let row = sqlx::query(
        "select * from public.scan_sessions where batch_id = $1 order by created_at desc limit 1",
    )
    .bind(batch_id)
    .fetch_optional(&pool)
    .await?;
    Ok(row.as_ref().map(row_value))
}


/// `listOpenBatches`.
pub async fn list_open_batches(db: &DbPools, seller_uid: &str) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let rows = sqlx::query(
        "select * from public.scan_batches where seller_uid = $1 and status = 'open' order by updated_at desc limit 20",
    )
    .bind(seller_uid)
    .fetch_all(&pool)
    .await?;
    Ok(Value::Array(
        rows.iter()
            .map(|row| rules::batch_view(&row_value(row)))
            .collect(),
    ))
}

/// `readImage` — raw scan JPEG for a batch item owned by the seller.
pub async fn read_image(db: &DbPools, seller_uid: &str, item_id: &str) -> ApiResult<Option<Vec<u8>>> {
    if !rules::is_uuid(item_id) {
        return Ok(None);
    }
    let pool = writer(db).await?;
    let row = sqlx::query("select image from public.scan_items where id = $1 and seller_uid = $2")
        .bind(item_id)
        .bind(seller_uid)
        .fetch_optional(&pool)
        .await?;
    Ok(row.and_then(|row| row.try_get::<Option<Vec<u8>>, _>("image").ok().flatten()))
}

/// `bumpBatch` — item_seq / item_position counters.
pub async fn bump_batch(
    conn: &mut sqlx::PgConnection,
    batch_id: &str,
    positions: i64,
) -> ApiResult<(i64, i64)> {
    let row = sqlx::query(
        "update public.scan_batches
           set item_seq = item_seq + 1, item_position = item_position + $2, updated_at = now()
         where id = $1
         returning item_seq, item_position",
    )
    .bind(batch_id)
    .bind(positions)
    .fetch_one(&mut *conn)
    .await?;
    Ok((
        row.try_get::<i64, _>("item_seq").unwrap_or(0),
        row.try_get::<i64, _>("item_position").unwrap_or(0),
    ))
}

/// `purgeExpired` — old pairings/rate-limit windows.
pub async fn purge_expired(db: &DbPools) -> ApiResult<()> {
    let pool = writer(db).await?;
    sqlx::query("delete from public.scan_pairings where expires_at < now() - interval '5 minutes'")
        .execute(&pool)
        .await?;
    sqlx::query("delete from public.scan_rate_limits where window_start < now() - interval '1 hour'")
        .execute(&pool)
        .await?;
    Ok(())
}


/// `_scan_store.js` ITEM_COLUMNS — the returning list shared by ingest/merge.
pub const ITEM_COLUMNS: &str = "id, batch_id, seller_uid, scan_event_id, session_id, client_sequence, captured_at, received_at, \
recognition_state, recognition, defaults_version, defaults_snapshot, (image is not null) as has_image, timings, seq, position, \
status, merged_into, reviewed, card_id, card_name, set_name, collector_number, image_url, nationality, condition, language, \
foil_state, first_edition, signed, altered, graded, grading_company, grade, certification_id, location, quantity, price_pkn, \
price_suggested, seller_comment, listing_id, updated_at";

const MAX_BATCH_ROWS: i64 = 10_000;

fn ms_to_time(ms: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000).unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// `lookupCardsFromCatalog` — candidate metadata for the recognition hits.
pub async fn lookup_cards_from_catalog(db: &DbPools, card_ids: &[String]) -> ApiResult<std::collections::HashMap<String, Value>> {
    let mut ids: Vec<i64> = Vec::new();
    for id in card_ids {
        let clean = rules::clean_card_id(id);
        if clean.is_empty() {
            continue;
        }
        if let Ok(number) = clean.parse::<i64>() {
            if !ids.contains(&number) {
                ids.push(number);
            }
        }
    }
    let mut map = std::collections::HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let pool = writer(db).await?;
    let rows = sqlx::query(
        "select v.card_id::text as card_id, v.name, v.expansion_name, v.expansion_number,
                coalesce(nullif(v.cdn_image_url, ''), nullif(v.image_url, ''), '') as image_url,
                coalesce(e.nationality, '') as nationality
         from public.marketplace_card_versions v
         left join public.pokoin_pokemon_expansions e on lower(e.name) = lower(v.expansion_name)
         where v.card_id = any($1::bigint[])",
    )
    .bind(&ids)
    .fetch_all(&pool)
    .await?;
    for row in rows {
        let value = row_value(&row);
        let key = value.get("card_id").and_then(Value::as_str).unwrap_or_default().to_string();
        map.insert(
            key,
            json!({
                "name": value.get("name").cloned().unwrap_or(json!("")),
                "setName": value.get("expansion_name").cloned().unwrap_or(json!("")),
                "number": value.get("expansion_number").cloned().unwrap_or(json!("")),
                "imageUrl": value.get("image_url").cloned().unwrap_or(json!("")),
                "nationality": value.get("nationality").and_then(Value::as_str).unwrap_or("").to_lowercase(),
            }),
        );
    }
    Ok(map)
}

/// `ingestScan` — phone scan event → one `scan_items` row (merge-aware).
///
/// The printing-choice layer (`resolvePrintings`) is not ported yet, so the
/// reference's `printingRows.length ? … : null` fallback path is used: one
/// printing per artwork, exactly like the pre-printing-choice rule.
pub async fn ingest_scan(db: &DbPools, token: &str, body: &Value) -> ApiResult<Value> {
    let received_at_ms = crate::time_util::now_ms();
    let event = rules::parse_scan_event(body)?;
    let recognition = rules::classify_recognition(&event.hits);
    let candidate_ids: Vec<String> = recognition
        .get("candidates")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.get("cardId").and_then(Value::as_str).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let meta = lookup_cards_from_catalog(db, &candidate_ids).await.unwrap_or_default();
    let candidates: Vec<Value> = recognition
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|candidate| {
            let card_id = candidate.get("cardId").and_then(Value::as_str).unwrap_or_default().to_string();
            let mut merged = candidate.clone();
            if let Some(extra) = meta.get(&card_id) {
                merged["name"] = extra.get("name").cloned().unwrap_or(merged["name"].clone());
                merged["setName"] = extra.get("setName").cloned().unwrap_or(json!(""));
                merged["number"] = extra.get("number").cloned().unwrap_or(json!(""));
                merged["imageUrl"] = extra.get("imageUrl").cloned().unwrap_or(json!(""));
                merged["nationality"] = extra.get("nationality").cloned().unwrap_or(json!(""));
            } else {
                merged["setName"] = json!("");
                merged["number"] = json!("");
                merged["imageUrl"] = json!("");
                merged["nationality"] = json!("");
            }
            merged
        })
        .collect();

    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;

    let Some(session) = session_for_token(&mut tx, token, true).await? else {
        tx.commit().await?;
        return Err(session_gone(false));
    };

    let prior = sqlx::query(
        "select id, seller_uid, status, merged_into from public.scan_items where scan_event_id = $1",
    )
    .bind(&event.scan_event_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(prior) = prior {
        let prior = row_value(&prior);
        let prior_seller = prior.get("seller_uid").and_then(Value::as_str).unwrap_or_default();
        let session_seller = session.get("seller_uid").and_then(Value::as_str).unwrap_or_default();
        if prior_seller != session_seller {
            return Err(ApiError::conflict("Scan id already used.").with_code("scan_id_conflict"));
        }
        tx.commit().await?;
        return Ok(json!({
            "duplicate": true,
            "itemId": prior.get("id"),
            "merged": prior.get("status").and_then(Value::as_str) == Some("merged"),
            "serverTime": received_at_ms,
        }));
    }

    let connected_at_ms = session
        .get("phone_connected_at")
        .and_then(Value::as_str)
        .and_then(crate::time_util::ms_from_iso)
        .unwrap_or(0);
    let captured_ms = rules::captured_at_server(
        event.captured_at,
        event.clock_offset_ms,
        received_at_ms,
        if connected_at_ms > 0 { connected_at_ms - 5_000 } else { 0 },
    );
    let activity_ms = rules::scan_idle_activity_ms(&session);
    let expiry_ms = match activity_ms {
        Some(activity) => activity + rules::SCAN_IDLE_MS,
        None => session
            .get("last_activity_at")
            .and_then(Value::as_str)
            .and_then(crate::time_util::ms_from_iso)
            .unwrap_or(received_at_ms)
            + rules::SESSION_IDLE_MS,
    };
    let in_grace = captured_ms <= expiry_ms && received_at_ms - expiry_ms <= rules::EXPIRY_UPLOAD_GRACE_MS;
    match session.get("status").and_then(Value::as_str) {
        Some("ended") => {
            if session.get("end_reason").and_then(Value::as_str) != Some("expired") || !in_grace {
                tx.commit().await?;
                return Err(session_gone(false));
            }
        }
        Some("connected") => {
            if received_at_ms >= expiry_ms && !in_grace {
                let _ = disconnect_phone_row(&mut tx, session["id"].as_str().unwrap_or_default(), ms_to_time(received_at_ms)).await?;
                tx.commit().await?;
                return Err(session_gone(true));
            }
        }
        _ => {
            tx.commit().await?;
            return Err(session_gone(false));
        }
    }
    if session.get("paused") == Some(&Value::Bool(true)) {
        return Err(ApiError::conflict("Scanning is paused on the dashboard.").with_code("paused"));
    }
    let scan_bucket = format!("scan:{}", session["id"].as_str().unwrap_or_default());
    if limit_hits(&mut tx, &scan_bucket, rules::LIMIT_SCAN_PER_SESSION, received_at_ms).await?
        >= rules::LIMIT_SCAN_PER_SESSION.max
    {
        tx.commit().await?;
        return Err(too_many(rules::LIMIT_SCAN_PER_SESSION, received_at_ms));
    }
    limit_increment(&mut tx, &scan_bucket, rules::LIMIT_SCAN_PER_SESSION, received_at_ms).await?;
    if session.get("batch_status").and_then(Value::as_str) != Some("open") {
        return Err(ApiError::conflict("This batch is closed.").with_code("batch_closed"));
    }
    let batch_id = session["batch_id"].as_str().unwrap_or_default().to_string();
    let batch_row = sqlx::query("select * from public.scan_batches where id = $1 for update")
        .bind(&batch_id)
        .fetch_one(&mut *tx)
        .await?;
    let batch = row_value(&batch_row);
    if batch.get("item_position").and_then(Value::as_i64).unwrap_or(0) >= MAX_BATCH_ROWS {
        return Err(ApiError::conflict("This batch is full. Add it to inventory and start a new one.")
            .with_code("batch_full"));
    }
    let history = batch.get("defaults_history").cloned().unwrap_or(json!([]));
    let picked = rules::pick_defaults(&history, captured_ms);
    let snapshot = picked.get("defaults").cloned().unwrap_or_else(rules::default_batch_defaults);

    let scoped = rules::scope_candidates_to_print_family(&candidates, snapshot.get("language").and_then(Value::as_str).unwrap_or("EN"));
    let scoped_hits: Vec<Value> = scoped
        .iter()
        .map(|candidate| json!({
            "public_id": candidate.get("cardId"),
            "score": candidate.get("score"),
            "name": candidate.get("name"),
        }))
        .collect();
    let scoped_recognition = rules::classify_recognition(&scoped_hits);
    let decided = scoped_recognition.clone();
    let top: Option<Value> = match decided.get("state").and_then(Value::as_str) {
        Some("ambiguous") => rules::provisional_candidate(&scoped, snapshot.get("language").and_then(Value::as_str).unwrap_or("EN")),
        Some("matched") => scoped.first().cloned(),
        _ => None,
    };
    let listing_language = snapshot.get("language").and_then(Value::as_str).unwrap_or("EN").to_string();
    let mut listing_snapshot = snapshot.clone();
    listing_snapshot["language"] = json!(listing_language);

    let last_row = sqlx::query(
        "select * from public.scan_items where batch_id = $1 and status <> 'removed'
         order by position desc limit 1",
    )
    .bind(&batch_id)
    .fetch_optional(&mut *tx)
    .await?
    .map(|row| row_value(&row));
    let mut head: Option<Value> = None;
    if let Some(last) = &last_row {
        match last.get("status").and_then(Value::as_str) {
            Some("active") => head = Some(last.clone()),
            Some("merged") => {
                if let Some(merged_into) = last.get("merged_into").and_then(Value::as_str) {
                    head = sqlx::query("select * from public.scan_items where id = $1 and status = $2 for update")
                        .bind(merged_into)
                        .bind("active")
                        .fetch_optional(&mut *tx)
                        .await?
                        .map(|row| row_value(&row));
                }
            }
            _ => {}
        }
    }
    let last_event_id = sqlx::query("select id from public.scan_items where batch_id = $1 order by position desc limit 1")
        .bind(&batch_id)
        .fetch_optional(&mut *tx)
        .await?
        .and_then(|row| row.try_get::<String, _>("id").ok());
    let consecutive = head.is_some()
        && last_event_id.is_some()
        && last_row
            .as_ref()
            .and_then(|row| row.get("id").and_then(Value::as_str))
            .map(|id| Some(id.to_string()) == last_event_id)
            .unwrap_or(false);
    let head_quantity = head.as_ref().and_then(|row| row.get("quantity").and_then(Value::as_i64)).unwrap_or(0);
    let quantity = snapshot.get("quantity").and_then(Value::as_i64).unwrap_or(1);
    let merge = consecutive
        && top.is_some()
        && head
            .as_ref()
            .map(|head| {
                rules::should_merge(
                    head,
                    decided.get("state").and_then(Value::as_str).unwrap_or(""),
                    top.as_ref().and_then(|t| t.get("cardId")).and_then(Value::as_str).unwrap_or_default(),
                    &listing_snapshot,
                )
            })
            .unwrap_or(false)
        && head_quantity + quantity <= 99;

    let (seq, position) = bump_batch(&mut tx, &batch_id, 1).await?;
    let card_id = top
        .as_ref()
        .and_then(|t| t.get("cardId"))
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .unwrap_or_default();
    let card_meta = meta.get(&card_id).cloned().unwrap_or(json!({}));
    let recognition_json = json!({
        "state": decided.get("state"),
        "catalog": event.catalog,
        "topScore": decided.get("topScore"),
        "margin": decided.get("margin"),
        "candidates": decided.get("candidates"),
    });
    let inserted = sqlx::query(&format!(
        "insert into public.scan_items (
           batch_id, seller_uid, scan_event_id, session_id, client_sequence, captured_at, received_at,
           recognition_state, recognition, defaults_version, defaults_snapshot, image, timings,
           seq, position, status, merged_into, card_id, card_name, set_name, collector_number, image_url,
           nationality, condition, language, foil_state, first_edition, signed, altered, location, quantity
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
         ) returning {ITEM_COLUMNS}"
    ))
    .bind(&batch_id)
    .bind(session.get("seller_uid").and_then(Value::as_str).unwrap_or_default())
    .bind(&event.scan_event_id)
    .bind(session.get("id").and_then(Value::as_str).unwrap_or_default())
    .bind(event.client_sequence)
    .bind(ms_to_time(captured_ms))
    .bind(ms_to_time(received_at_ms))
    .bind(decided.get("state").and_then(Value::as_str).unwrap_or("unmatched"))
    .bind(sqlx::types::Json(&recognition_json))
    .bind(picked.get("version").and_then(Value::as_i64).unwrap_or(1))
    .bind(sqlx::types::Json(&snapshot))
    .bind(event.image.clone())
    .bind(sqlx::types::Json(&event.timings))
    .bind(seq)
    .bind(position)
    .bind(if merge { "merged" } else { "active" })
    .bind(if merge { head.as_ref().and_then(|h| h.get("id")).and_then(Value::as_str).map(|s| s.to_string()) } else { None })
    .bind(if card_id.is_empty() { None } else { Some(card_id.clone()) })
    .bind(card_meta.get("name").and_then(Value::as_str).unwrap_or(""))
    .bind(card_meta.get("setName").and_then(Value::as_str).unwrap_or(""))
    .bind(card_meta.get("number").and_then(Value::as_str).unwrap_or(""))
    .bind(card_meta.get("imageUrl").and_then(Value::as_str).unwrap_or(""))
    .bind(card_meta.get("nationality").and_then(Value::as_str).unwrap_or(""))
    .bind(snapshot.get("condition").and_then(Value::as_str).unwrap_or("NM"))
    .bind(&listing_language)
    .bind(snapshot.get("foilState").and_then(Value::as_str).unwrap_or("standard"))
    .bind(snapshot.get("firstEdition") == Some(&Value::Bool(true)))
    .bind(snapshot.get("signed") == Some(&Value::Bool(true)))
    .bind(snapshot.get("altered") == Some(&Value::Bool(true)))
    .bind(snapshot.get("location").and_then(Value::as_str).unwrap_or(""))
    .bind(quantity)
    .fetch_one(&mut *tx)
    .await?;
    let inserted = row_value(&inserted);

    let mut head_row: Option<Value> = None;
    if merge {
        let head_id = head.as_ref().and_then(|h| h.get("id")).and_then(Value::as_str).unwrap_or_default().to_string();
        let (head_seq, _) = bump_batch(&mut tx, &batch_id, 0).await?;
        let updated = sqlx::query(&format!(
            "update public.scan_items set quantity = quantity + $2, seq = $3, updated_at = now()
             where id = $1 returning {ITEM_COLUMNS}"
        ))
        .bind(&head_id)
        .bind(quantity)
        .bind(head_seq)
        .fetch_one(&mut *tx)
        .await?;
        head_row = Some(row_value(&updated));
    }
    sqlx::query(
        "update public.scan_sessions
           set phone_last_seen_at = now(), last_scan_at = now(), last_activity_at = now(),
               phone_scans = phone_scans + 1, version = version + 1
         where id = $1",
    )
    .bind(session.get("id").and_then(Value::as_str).unwrap_or_default())
    .execute(&mut *tx)
    .await?;
    let active_rows = sqlx::query(
        "select id, location, quantity, defaults_snapshot
           from public.scan_items
          where batch_id = $1 and status = 'active'
          order by position",
    )
    .bind(&batch_id)
    .fetch_all(&mut *tx)
    .await?;
    let active: Vec<Value> = active_rows.iter().map(row_value).collect();
    let slots = rules::box_slots(&active);
    let target_id = head_row
        .as_ref()
        .and_then(|row| row.get("id"))
        .or_else(|| inserted.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let stack_full = slots
        .get(&target_id)
        .and_then(|slot| slot.get("filledStack"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    tx.commit().await?;

    Ok(json!({
        "duplicate": false,
        "itemId": inserted.get("id"),
        "recognitionState": decided.get("state"),
        "merged": head_row.is_some(),
        "stackFull": stack_full,
        "headId": head_row.as_ref().and_then(|row| row.get("id")),
        "headQuantity": head_row.as_ref().and_then(|row| row.get("quantity")),
        "serverTime": received_at_ms,
        "received": session.get("phone_scans").and_then(Value::as_i64).unwrap_or(0) + 1,
    }))
}


// ---------------------------------------------------------------------------
// Batch mutations
// ---------------------------------------------------------------------------

/// Ownership seam: the accounts crate owns the Firestore collection writer.
/// Production must supply a real implementation; the default fails closed.
#[derive(Clone, Debug)]
pub struct ScanOwnershipArgs {
    pub uid: String,
    pub row: Value,
    pub batch_id: String,
    pub listing_id: Option<String>,
}

pub trait ScanOwnership: Send + Sync {
    fn upsert<'a>(
        &'a self,
        args: ScanOwnershipArgs,
    ) -> futures_util::future::BoxFuture<'a, ApiResult<Value>>;
}

/// Default: no ownership writer wired → submit fails closed (503).
pub struct UnconfiguredOwnership;

impl ScanOwnership for UnconfiguredOwnership {
    fn upsert<'a>(
        &'a self,
        _args: ScanOwnershipArgs,
    ) -> futures_util::future::BoxFuture<'a, ApiResult<Value>> {
        Box::pin(async {
            Err(ApiError::new(503, "Collection ownership write is not configured.")
                .with_code("ownership_write_failed"))
        })
    }
}

/// Test double: records ownership writes without Firestore.
#[derive(Default)]
pub struct MemoryScanOwnership {
    pub writes: std::sync::Mutex<Vec<Value>>,
}

impl ScanOwnership for MemoryScanOwnership {
    fn upsert<'a>(
        &'a self,
        args: ScanOwnershipArgs,
    ) -> futures_util::future::BoxFuture<'a, ApiResult<Value>> {
        let mut writes = self.writes.lock().expect("ownership lock");
        writes.push(json!({
            "uid": args.uid,
            "batchId": args.batch_id,
            "listingId": args.listing_id,
            "itemId": args.row.get("id"),
            "cardId": args.row.get("card_id"),
        }));
        Box::pin(async { Ok(json!({"ok": true})) })
    }
}

async fn lock_batch(
    conn: &mut sqlx::PgConnection,
    seller_uid: &str,
    batch_id: &str,
    open: bool,
) -> ApiResult<Value> {
    if !rules::is_uuid(batch_id) {
        return Err(ApiError::not_found("Batch not found."));
    }
    let row = sqlx::query("select * from public.scan_batches where id = $1 and seller_uid = $2 for update")
        .bind(batch_id)
        .bind(seller_uid)
        .fetch_optional(&mut *conn)
        .await?;
    let value = row
        .as_ref()
        .map(row_value)
        .ok_or_else(|| ApiError::not_found("Batch not found."))?;
    if open && value.get("status").and_then(Value::as_str) != Some("open") {
        return Err(ApiError::conflict("This batch is closed.").with_code("batch_closed"));
    }
    Ok(value)
}

async fn touch_sessions(conn: &mut sqlx::PgConnection, batch_id: &str) -> ApiResult<()> {
    sqlx::query("update public.scan_sessions set last_activity_at = now() where batch_id = $1 and status <> 'ended'")
        .bind(batch_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn lock_item(
    conn: &mut sqlx::PgConnection,
    seller_uid: &str,
    item_id: &str,
) -> ApiResult<(Value, String)> {
    if !rules::is_uuid(item_id) {
        return Err(ApiError::not_found("Row not found."));
    }
    let row = sqlx::query(
        "select i.*, b.status as batch_status from public.scan_items i
         join public.scan_batches b on b.id = i.batch_id
         where i.id = $1 and i.seller_uid = $2 for update of i, b",
    )
    .bind(item_id)
    .bind(seller_uid)
    .fetch_optional(&mut *conn)
    .await?;
    let value = row
        .as_ref()
        .map(row_value)
        .ok_or_else(|| ApiError::not_found("Row not found."))?;
    let batch_id = value.get("batch_id").and_then(Value::as_str).unwrap_or_default().to_string();
    Ok((value, batch_id))
}

fn require_open_batch(row: &Value) -> ApiResult<()> {
    if row.get("batch_status").and_then(Value::as_str) != Some("open") {
        return Err(ApiError::conflict("This batch is closed.").with_code("batch_closed"));
    }
    Ok(())
}

/// `setDefaults` — bump defaults_version, fan editable fields onto active rows.
pub async fn set_defaults(db: &DbPools, seller_uid: &str, batch_id: &str, defaults: &Value) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let now_ms = crate::time_util::now_ms();
    let locked = lock_batch(&mut tx, seller_uid, batch_id, true).await?;
    let prev = rules::normalize_defaults(locked.get("defaults").unwrap_or(&rules::default_batch_defaults()), &rules::default_batch_defaults());
    let next = rules::normalize_defaults(defaults, &prev);
    let version = locked.get("defaults_version").and_then(Value::as_i64).unwrap_or(1) + 1;
    let history = rules::append_defaults(
        locked.get("defaults_history").unwrap_or(&json!([])),
        &next,
        version,
        now_ms,
        500,
    );
    let updated = sqlx::query(
        "update public.scan_batches
           set defaults = $2, defaults_version = $3, defaults_history = $4, updated_at = now()
         where id = $1 returning *",
    )
    .bind(batch_id)
    .bind(sqlx::types::Json(&next))
    .bind(version)
    .bind(sqlx::types::Json(&history))
    .fetch_one(&mut *tx)
    .await?;
    touch_sessions(&mut tx, batch_id).await?;

    let row_fields: [(&str, &str); 7] = [
        ("language", "language"),
        ("condition", "condition"),
        ("foilState", "foil_state"),
        ("firstEdition", "first_edition"),
        ("signed", "signed"),
        ("altered", "altered"),
        ("location", "location"),
    ];
    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    for (key, column) in row_fields {
        if prev.get(key) == next.get(key) {
            continue;
        }
        values.push(next.get(key).cloned().unwrap_or(Value::Null));
        sets.push(format!("{column} = ${}", values.len()));
    }
    let mut items: Vec<Value> = Vec::new();
    if !sets.is_empty() {
        let _ = bump_batch(&mut tx, batch_id, 0).await?;
        values.push(json!(batch_id));
        let sql = format!(
            "update public.scan_items
                set {}, seq = seq + 1, updated_at = now()
              where batch_id = ${} and status = 'active'
              returning {}",
            sets.join(", "),
            values.len(),
            ITEM_COLUMNS
        );
        let mut query = sqlx::query(&sql);
        for value in &values {
            query = query.bind(value.clone());
        }
        let rows = query.fetch_all(&mut *tx).await?;
        items = rows.iter().map(row_value).collect();
    }
    tx.commit().await?;
    Ok(json!({
        "batch": rules::batch_view(&row_value(&updated)),
        "items": items.iter().map(rules::item_view).collect::<Vec<_>>(),
        "serverTime": now_ms,
    }))
}

/// `patchItem` — one desk row edit.
pub async fn patch_item(
    db: &DbPools,
    seller_uid: &str,
    item_id: &str,
    patch: &Value,
    only_if_empty_price: bool,
) -> ApiResult<Value> {
    let mut changes = rules::parse_item_patch(patch)?;
    let card_change = changes
        .iter()
        .find(|(column, _)| column == "card_id")
        .map(|(_, value)| value.as_str().unwrap_or_default().to_string());
    let meta = match &card_change {
        Some(card_id) => lookup_cards_from_catalog(db, std::slice::from_ref(card_id)).await.unwrap_or_default(),
        None => std::collections::HashMap::new(),
    };
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let (row, batch_id) = lock_item(&mut tx, seller_uid, item_id).await?;
    require_open_batch(&row)?;
    if row.get("status").and_then(Value::as_str) != Some("active") {
        return Err(ApiError::conflict("Only active rows can be edited.").with_code("not_active"));
    }
    if only_if_empty_price && row.get("price_pkn").map(|value| !value.is_null()).unwrap_or(false) {
        changes.retain(|(column, _)| column != "price_pkn" && column != "price_suggested");
    }
    if let Some(card_id) = &card_change {
        changes.retain(|(column, _)| column != "card_id");
        let extra = meta.get(card_id).cloned().unwrap_or(json!({}));
        changes.push(("card_id".into(), json!(card_id)));
        changes.push(("card_name".into(), extra.get("name").cloned().unwrap_or(json!(""))));
        changes.push(("set_name".into(), extra.get("setName").cloned().unwrap_or(json!(""))));
        changes.push(("collector_number".into(), extra.get("number").cloned().unwrap_or(json!(""))));
        changes.push(("image_url".into(), extra.get("imageUrl").cloned().unwrap_or(json!(""))));
        changes.push(("nationality".into(), extra.get("nationality").cloned().unwrap_or(json!(""))));
        changes.push(("reviewed".into(), json!(true)));
        let has_price = changes.iter().any(|(column, _)| column == "price_pkn");
        if !has_price && row.get("card_id").and_then(Value::as_str) != Some(card_id.as_str()) {
            changes.push(("price_pkn".into(), Value::Null));
            changes.push(("price_suggested".into(), json!(false)));
        }
    }
    if changes.is_empty() {
        tx.commit().await?;
        return Ok(json!({ "items": [rules::item_view(&row)] }));
    }
    let (seq, _) = bump_batch(&mut tx, &batch_id, 0).await?;
    let mut sets: Vec<String> = vec!["seq = $2".into(), "updated_at = now()".into()];
    let mut values: Vec<Value> = vec![json!(item_id), json!(seq)];
    for (column, value) in &changes {
        values.push(value.clone());
        sets.push(format!("{column} = ${}", values.len()));
    }
    let sql = format!("update public.scan_items set {} where id = $1 returning {}", sets.join(", "), ITEM_COLUMNS);
    let mut query = sqlx::query(&sql);
    for value in &values {
        query = query.bind(value.clone());
    }
    let updated = query.fetch_one(&mut *tx).await?;
    touch_sessions(&mut tx, &batch_id).await?;
    tx.commit().await?;
    Ok(json!({ "items": [rules::item_view(&row_value(&updated))] }))
}

/// `setStatus` — remove / restore.
pub async fn set_status(
    db: &DbPools,
    seller_uid: &str,
    item_id: &str,
    from: &str,
    to: &str,
) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let (row, batch_id) = lock_item(&mut tx, seller_uid, item_id).await?;
    require_open_batch(&row)?;
    if row.get("status").and_then(Value::as_str) != Some(from) {
        let current = row.get("status").and_then(Value::as_str).unwrap_or("unknown");
        return Err(ApiError::conflict(format!("Row is {current}.")).with_code("wrong_status"));
    }
    let (seq, _) = bump_batch(&mut tx, &batch_id, 0).await?;
    let updated = sqlx::query(&format!(
        "update public.scan_items set status = $2, seq = $3, updated_at = now() where id = $1 returning {}",
        ITEM_COLUMNS
    ))
    .bind(item_id)
    .bind(to)
    .bind(seq)
    .fetch_one(&mut *tx)
    .await?;
    touch_sessions(&mut tx, &batch_id).await?;
    tx.commit().await?;
    Ok(json!({ "items": [rules::item_view(&row_value(&updated))] }))
}

/// `duplicateItem`.
pub async fn duplicate_item(db: &DbPools, seller_uid: &str, item_id: &str) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let (row, batch_id) = lock_item(&mut tx, seller_uid, item_id).await?;
    require_open_batch(&row)?;
    if row.get("status").and_then(Value::as_str) != Some("active") {
        return Err(ApiError::conflict("Only active rows can be copied.").with_code("not_active"));
    }
    let position = row.get("position").and_then(Value::as_f64).unwrap_or(0.0);
    let next = sqlx::query(
        "select position from public.scan_items where batch_id = $1 and position > $2 order by position limit 1",
    )
    .bind(&batch_id)
    .bind(position)
    .fetch_optional(&mut *tx)
    .await?
    .and_then(|row| row.try_get::<f64, _>("position").ok());
    let new_position = match next {
        Some(next) => (position + next) / 2.0,
        None => position + 0.5,
    };
    let (seq, _) = bump_batch(&mut tx, &batch_id, 0).await?;
    let inserted = sqlx::query(&format!(
        "insert into public.scan_items (
           batch_id, seller_uid, recognition_state, recognition, defaults_snapshot, seq, position, status,
           reviewed, card_id, card_name, set_name, collector_number, image_url, nationality, condition, language,
           foil_state, first_edition, signed, altered, graded, grading_company, grade, certification_id, location,
           quantity, price_pkn, price_suggested, seller_comment
         )
         select batch_id, seller_uid, 'manual', jsonb_build_object('copiedFrom', id), defaults_snapshot, $2, $3, 'active',
           true, card_id, card_name, set_name, collector_number, image_url, nationality, condition, language,
           foil_state, first_edition, signed, altered, graded, grading_company, grade, certification_id, location,
           1, price_pkn, price_suggested, seller_comment
         from public.scan_items where id = $1
         returning {}",
        ITEM_COLUMNS
    ))
    .bind(item_id)
    .bind(seq)
    .bind(new_position)
    .fetch_one(&mut *tx)
    .await?;
    touch_sessions(&mut tx, &batch_id).await?;
    tx.commit().await?;
    Ok(json!({ "items": [rules::item_view(&row_value(&inserted))] }))
}

/// `unmergeItem`.
pub async fn unmerge_item(db: &DbPools, seller_uid: &str, item_id: &str) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let (row, batch_id) = lock_item(&mut tx, seller_uid, item_id).await?;
    require_open_batch(&row)?;
    if row.get("status").and_then(Value::as_str) != Some("merged")
        || row.get("merged_into").map(|value| value.is_null()).unwrap_or(true)
    {
        return Err(ApiError::conflict("Row is not merged.").with_code("not_merged"));
    }
    let mut out: Vec<Value> = Vec::new();
    let head_id = row.get("merged_into").and_then(Value::as_str).unwrap_or_default().to_string();
    let head = sqlx::query("select * from public.scan_items where id = $1 for update")
        .bind(&head_id)
        .fetch_optional(&mut *tx)
        .await?
        .map(|row| row_value(&row));
    if let Some(head) = head {
        if head.get("status").and_then(Value::as_str) == Some("active") {
            let (head_seq, _) = bump_batch(&mut tx, &batch_id, 0).await?;
            let updated = sqlx::query(&format!(
                "update public.scan_items set quantity = greatest(1, quantity - $2), seq = $3, updated_at = now()
                 where id = $1 returning {}",
                ITEM_COLUMNS
            ))
            .bind(&head_id)
            .bind(row.get("quantity").and_then(Value::as_i64).unwrap_or(1))
            .bind(head_seq)
            .fetch_one(&mut *tx)
            .await?;
            out.push(row_value(&updated));
        }
    }
    let (seq, _) = bump_batch(&mut tx, &batch_id, 0).await?;
    let updated = sqlx::query(&format!(
        "update public.scan_items set status = 'active', merged_into = null, seq = $2, updated_at = now()
         where id = $1 returning {}",
        ITEM_COLUMNS
    ))
    .bind(item_id)
    .bind(seq)
    .fetch_one(&mut *tx)
    .await?;
    out.push(row_value(&updated));
    touch_sessions(&mut tx, &batch_id).await?;
    tx.commit().await?;
    Ok(json!({ "items": out.iter().map(rules::item_view).collect::<Vec<_>>() }))
}

/// `addManual`.
pub async fn add_manual(db: &DbPools, seller_uid: &str, batch_id: &str, body: &Value) -> ApiResult<Value> {
    let card_id = rules::clean_card_id(body.get("cardId").and_then(Value::as_str).unwrap_or_default());
    if card_id.is_empty() {
        return Err(ApiError::bad_request("cardId must be a public card id."));
    }
    let meta = lookup_cards_from_catalog(db, std::slice::from_ref(&card_id)).await.unwrap_or_default();
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let batch = lock_batch(&mut tx, seller_uid, batch_id, true).await?;
    let base = rules::normalize_defaults(batch.get("defaults").unwrap_or(&rules::default_batch_defaults()), &rules::default_batch_defaults());
    let defaults = rules::normalize_defaults(body, &base);
    let (seq, position) = bump_batch(&mut tx, batch_id, 1).await?;
    let extra = meta.get(&card_id).cloned().unwrap_or(json!({}));
    let inserted = sqlx::query(&format!(
        "insert into public.scan_items (
           batch_id, seller_uid, recognition_state, defaults_version, defaults_snapshot, seq, position, status, reviewed,
           card_id, card_name, set_name, collector_number, image_url, nationality,
           condition, language, foil_state, first_edition, signed, altered, location, quantity
         ) values ($1,$2,'manual',$3,$4,$5,$6,'active',true,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         returning {}",
        ITEM_COLUMNS
    ))
    .bind(batch_id)
    .bind(seller_uid)
    .bind(batch.get("defaults_version").and_then(Value::as_i64).unwrap_or(1))
    .bind(sqlx::types::Json(&defaults))
    .bind(seq)
    .bind(position)
    .bind(&card_id)
    .bind(extra.get("name").and_then(Value::as_str).unwrap_or(""))
    .bind(extra.get("setName").and_then(Value::as_str).unwrap_or(""))
    .bind(extra.get("number").and_then(Value::as_str).unwrap_or(""))
    .bind(extra.get("imageUrl").and_then(Value::as_str).unwrap_or(""))
    .bind(extra.get("nationality").and_then(Value::as_str).unwrap_or(""))
    .bind(defaults.get("condition").and_then(Value::as_str).unwrap_or("NM"))
    .bind(defaults.get("language").and_then(Value::as_str).unwrap_or("EN"))
    .bind(defaults.get("foilState").and_then(Value::as_str).unwrap_or("standard"))
    .bind(defaults.get("firstEdition") == Some(&Value::Bool(true)))
    .bind(defaults.get("signed") == Some(&Value::Bool(true)))
    .bind(defaults.get("altered") == Some(&Value::Bool(true)))
    .bind(defaults.get("location").and_then(Value::as_str).unwrap_or(""))
    .bind(defaults.get("quantity").and_then(Value::as_i64).unwrap_or(1))
    .fetch_one(&mut *tx)
    .await?;
    touch_sessions(&mut tx, batch_id).await?;
    tx.commit().await?;
    Ok(json!({ "items": [rules::item_view(&row_value(&inserted))] }))
}

/// `discardBatch`.
pub async fn discard_batch(db: &DbPools, seller_uid: &str, batch_id: &str) -> ApiResult<Value> {
    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let _ = lock_batch(&mut tx, seller_uid, batch_id, true).await?;
    let sessions = sqlx::query("select id from public.scan_sessions where batch_id = $1 and status <> 'ended'")
        .bind(batch_id)
        .fetch_all(&mut *tx)
        .await?;
    for session in sessions {
        let id: String = session.try_get("id").unwrap_or_default();
        let _ = end_session_row(&mut tx, &id, "discarded").await?;
    }
    let updated = sqlx::query(
        "update public.scan_batches set status = 'discarded', updated_at = now() where id = $1 returning *",
    )
    .bind(batch_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json!({ "batch": rules::batch_view(&row_value(&updated)) }))
}

/// `submitBatch` — validate, upsert non-purchasable listings, ownership, then
/// activate + mark submitted in one transaction.
#[allow(clippy::too_many_arguments)]
pub async fn submit_batch(
    db: &DbPools,
    ownership: &dyn ScanOwnership,
    seller_uid: &str,
    batch_id: &str,
    submit_key: &str,
    seller_name: &str,
    intent: &str,
    targets: &Value,
) -> ApiResult<Value> {
    let intent = if intent == "collection" { "collection" } else { "list" };
    let targets = if intent == "collection" {
        json!({"pokoin": true, "cardtrader": false})
    } else {
        normalize_targets(targets)
    };
    let write_pokoin = intent == "list" && targets.get("pokoin") == Some(&Value::Bool(true));
    let key = rules::clean_scan_text(submit_key, 80);

    let pool = writer(db).await?;
    let mut tx = pool.begin().await?;
    let batch = lock_batch(&mut tx, seller_uid, batch_id, false).await?;
    if batch.get("status").and_then(Value::as_str) == Some("submitted") {
        tx.commit().await?;
        return Ok(json!({
            "batch": rules::batch_view(&batch),
            "result": batch.get("submit_result").cloned().unwrap_or(Value::Null),
            "alreadySubmitted": true,
        }));
    }
    if batch.get("status").and_then(Value::as_str) != Some("open") {
        return Err(ApiError::conflict("This batch is closed.").with_code("batch_closed"));
    }
    let rows = sqlx::query("select * from public.scan_items where batch_id = $1 and status = 'active' order by position for update")
        .bind(batch_id)
        .fetch_all(&mut *tx)
        .await?;
    let rows: Vec<Value> = rows.iter().map(row_value).collect();
    if rows.is_empty() {
        return Err(ApiError::conflict("Nothing to add.").with_code("empty_batch"));
    }
    let problems: Vec<Value> = rows
        .iter()
        .filter_map(|row| {
            let reason = rules::submit_problem(row, intent);
            if reason.is_empty() {
                None
            } else {
                Some(json!({ "itemId": row.get("id"), "reason": reason }))
            }
        })
        .collect();
    if !problems.is_empty() {
        return Err(ApiError::conflict(format!("{} row(s) need attention before adding.", problems.len()))
            .with_code("not_ready"));
    }

    let stock_rows: Vec<Value> = if write_pokoin
        && rows.iter().any(|row| !row.get("location").and_then(Value::as_str).unwrap_or("").trim().is_empty())
    {
        sqlx::query(
            "select location
               from public.marketplace_user_listings
              where seller_uid = $1
                and status in ('active', 'paused')
                and quantity_available > 0
                and nullif(location, '') is not null",
        )
        .bind(seller_uid)
        .fetch_all(&mut *tx)
        .await?
        .iter()
        .map(row_value)
        .collect()
    } else {
        Vec::new()
    };
    let _ = stock_rows;

    struct Created {
        item_id: String,
        listing_id: Option<String>,
        card_id: String,
        quantity: i64,
        row: Value,
    }
    let mut created: Vec<Created> = Vec::new();
    for row in &rows {
        let mut listing_id: Option<String> = None;
        if write_pokoin {
            let item_id = row.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            let source_listing_id = format!("scan:{item_id}");
            let location = scan_listing_location(db, row, &batch_id).await;
            let inserted = sqlx::query(
                "insert into public.marketplace_user_listings (
                   card_id, seller_uid, seller_name, condition, language, price_pkn, quantity_available, signed, reverse,
                   first_edition, foil_state, graded, grading_company, grade, certification_id, seller_comment, source,
                   source_listing_id, card_name, card_image_url, set_name, collector_number, location, altered, status
                 ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pokoin_scan_batch',$17,$18,$19,$20,$21,$22,$23,'inactive')
                 on conflict (source_listing_id) where source = 'pokoin_scan_batch'
                 do update set
                   card_id = excluded.card_id, seller_name = excluded.seller_name, condition = excluded.condition,
                   language = excluded.language, price_pkn = excluded.price_pkn, quantity_available = excluded.quantity_available,
                   signed = excluded.signed, reverse = excluded.reverse, first_edition = excluded.first_edition,
                   foil_state = excluded.foil_state, graded = excluded.graded, grading_company = excluded.grading_company,
                   grade = excluded.grade, certification_id = excluded.certification_id, seller_comment = excluded.seller_comment,
                   card_name = excluded.card_name, card_image_url = excluded.card_image_url, set_name = excluded.set_name,
                   collector_number = excluded.collector_number, location = excluded.location, altered = excluded.altered,
                   status = 'inactive', updated_at = now()
                 where public.marketplace_user_listings.status = 'inactive'
                 returning id, status",
            )
            .bind(row.get("card_id").and_then(Value::as_str).unwrap_or_default())
            .bind(seller_uid)
            .bind(if seller_name.trim().is_empty() { "Pokoin seller" } else { seller_name })
            .bind(row.get("condition").and_then(Value::as_str).unwrap_or("NM"))
            .bind(row.get("language").and_then(Value::as_str).unwrap_or("EN"))
            .bind(row.get("price_pkn").cloned().unwrap_or(Value::Null))
            .bind(row.get("quantity").and_then(Value::as_i64).unwrap_or(1))
            .bind(row.get("signed") == Some(&Value::Bool(true)))
            .bind(row.get("foil_state").and_then(Value::as_str) == Some("reverse"))
            .bind(row.get("first_edition") == Some(&Value::Bool(true)))
            .bind(row.get("foil_state").and_then(Value::as_str).unwrap_or("standard"))
            .bind(row.get("graded") == Some(&Value::Bool(true)))
            .bind(row.get("grading_company").cloned().unwrap_or(Value::Null))
            .bind(row.get("grade").cloned().unwrap_or(Value::Null))
            .bind(row.get("certification_id").cloned().unwrap_or(Value::Null))
            .bind(row.get("seller_comment").and_then(Value::as_str).unwrap_or(""))
            .bind(&source_listing_id)
            .bind(row.get("card_name").and_then(Value::as_str).unwrap_or(""))
            .bind(row.get("image_url").and_then(Value::as_str).unwrap_or(""))
            .bind(if row.get("set_name").and_then(Value::as_str).unwrap_or("").is_empty() { "Pokemon" } else { row.get("set_name").and_then(Value::as_str).unwrap_or("Pokemon") })
            .bind(if row.get("collector_number").and_then(Value::as_str).unwrap_or("").is_empty() { row.get("card_id").and_then(Value::as_str).unwrap_or("") } else { row.get("collector_number").and_then(Value::as_str).unwrap_or("") })
            .bind(&location)
            .bind(row.get("altered") == Some(&Value::Bool(true)))
            .fetch_optional(&mut *tx)
            .await?;
            let (id, status) = match inserted {
                Some(row) => (
                    row.try_get::<String, _>("id").ok(),
                    row.try_get::<String, _>("status").ok(),
                ),
                None => {
                    let existing = sqlx::query(
                        "select id, status from public.marketplace_user_listings
                          where source = 'pokoin_scan_batch' and source_listing_id = $1",
                    )
                    .bind(&source_listing_id)
                    .fetch_optional(&mut *tx)
                    .await?;
                    match existing {
                        Some(row) => (
                            row.try_get::<String, _>("id").ok(),
                            row.try_get::<String, _>("status").ok(),
                        ),
                        None => (None, None),
                    }
                }
            };
            listing_id = id.clone();
            if listing_id.is_none() {
                return Err(ApiError::new(500, "Listing insert did not return an id.").with_code("listing_missing"));
            }
            match status.as_deref() {
                Some("active") => {
                    return Err(ApiError::conflict("This scan listing is already live; refresh and retry if needed.")
                        .with_code("listing_already_active"))
                }
                Some("inactive") => {}
                other => {
                    return Err(ApiError::conflict(format!(
                        "Scan listing is {}; cannot finalize.",
                        other.unwrap_or("unknown")
                    ))
                    .with_code("listing_not_pending"))
                }
            }
        }
        created.push(Created {
            item_id: row.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            listing_id,
            card_id: row.get("card_id").and_then(Value::as_str).unwrap_or_default().to_string(),
            quantity: row.get("quantity").and_then(Value::as_i64).unwrap_or(0),
            row: row.clone(),
        });
    }
    tx.commit().await?;

    // Phase 2: ownership (Firestore) — accounts-owned writer via the seam.
    let mut ownership_count = 0usize;
    for entry in &created {
        ownership
            .upsert(ScanOwnershipArgs {
                uid: seller_uid.to_string(),
                row: entry.row.clone(),
                batch_id: batch_id.to_string(),
                listing_id: entry.listing_id.clone(),
            })
            .await?;
        ownership_count += 1;
    }

    // Phase 3: activate + mark submitted in one transaction.
    let mut tx = pool.begin().await?;
    let batch = lock_batch(&mut tx, seller_uid, batch_id, false).await?;
    if batch.get("status").and_then(Value::as_str) == Some("submitted") {
        tx.commit().await?;
        return Ok(json!({
            "batch": rules::batch_view(&batch),
            "result": batch.get("submit_result").cloned().unwrap_or(Value::Null),
            "alreadySubmitted": true,
        }));
    }
    if batch.get("status").and_then(Value::as_str) != Some("open") {
        return Err(ApiError::conflict("This batch is closed.").with_code("batch_closed"));
    }
    for entry in &created {
        if write_pokoin {
            if let Some(listing_id) = &entry.listing_id {
                let activated = sqlx::query(
                    "update public.marketplace_user_listings
                       set status = 'active', updated_at = now()
                     where id = $1 and source = 'pokoin_scan_batch' and source_listing_id = $2 and status = 'inactive'
                     returning id",
                )
                .bind(listing_id)
                .bind(format!("scan:{}", entry.item_id))
                .fetch_optional(&mut *tx)
                .await?;
                if activated.is_none() {
                    return Err(ApiError::conflict("Could not activate scan listing (not pending).")
                        .with_code("listing_activate_failed"));
                }
            }
        }
        let (seq, _) = bump_batch(&mut tx, batch_id, 0).await?;
        sqlx::query(
            "update public.scan_items set status = 'submitted', listing_id = $2, seq = $3, updated_at = now() where id = $1",
        )
        .bind(&entry.item_id)
        .bind(&entry.listing_id)
        .bind(seq)
        .execute(&mut *tx)
        .await?;
    }
    let result = json!({
        "intent": intent,
        "targets": targets,
        "listings": if write_pokoin { created.len() } else { 0 },
        "ownership": ownership_count,
        "cards": created.iter().map(|entry| entry.quantity).sum::<i64>(),
        "created": created.iter().map(|entry| json!({
            "itemId": entry.item_id,
            "listingId": entry.listing_id,
            "cardId": entry.card_id,
            "quantity": entry.quantity,
            "ownershipId": format!("scan:{}", entry.item_id),
        })).collect::<Vec<_>>(),
        "submitKey": key,
    });
    let updated = sqlx::query(
        "update public.scan_batches
           set status = 'submitted', submit_key = $2, submit_result = $3, submitted_at = now(), updated_at = now()
         where id = $1 returning *",
    )
    .bind(batch_id)
    .bind(&key)
    .bind(sqlx::types::Json(&result))
    .fetch_one(&mut *tx)
    .await?;
    let sessions = sqlx::query("select id from public.scan_sessions where batch_id = $1 and status <> 'ended'")
        .bind(batch_id)
        .fetch_all(&mut *tx)
        .await?;
    for session in sessions {
        let id: String = session.try_get("id").unwrap_or_default();
        let _ = end_session_row(&mut tx, &id, "completed").await?;
    }
    tx.commit().await?;

    Ok(json!({
        "batch": rules::batch_view(&row_value(&updated)),
        "result": result,
        "alreadySubmitted": false,
        "cardtrader": if targets.get("cardtrader") == Some(&Value::Bool(true)) {
            json!({"ok": true, "skipped": true, "reason": "commerce_not_ported"})
        } else {
            json!({"ok": true, "skipped": true, "reason": "not_requested"})
        },
    }))
}

/// Listing location with the box slot suffix (`listingLocationOf`).
async fn scan_listing_location(db: &DbPools, row: &Value, batch_id: &str) -> String {
    let location = row.get("location").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if location.is_empty() {
        return location;
    }
    let Ok(active) = active_items(db, batch_id).await else {
        return location;
    };
    let slots = rules::box_slots(&active);
    let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
    match slots.get(id) {
        Some(slot) => format!("{location}{}", rules::slot_text(slot, slot.get("stackSize").and_then(Value::as_i64).unwrap_or(1))),
        None => location,
    }
}

async fn active_items(db: &DbPools, batch_id: &str) -> ApiResult<Vec<Value>> {
    let pool = writer(db).await?;
    let rows = sqlx::query(
        "select id, location, quantity, defaults_snapshot from public.scan_items
          where batch_id = $1 and status = 'active' order by position",
    )
    .bind(batch_id)
    .fetch_all(&pool)
    .await?;
    Ok(rows.iter().map(row_value).collect())
}

/// `normalizeTargets`.
pub fn normalize_targets(raw: &Value) -> Value {
    let pokoin = match raw.get("pokoin") {
        Some(Value::Bool(false)) => false,
        Some(Value::String(text)) if text == "false" => false,
        Some(Value::Number(number)) if number.as_i64() == Some(0) => false,
        Some(_) => true,
        None => true,
    };
    let cardtrader = match raw.get("cardtrader") {
        Some(Value::Bool(true)) => true,
        Some(Value::String(text)) if text == "true" => true,
        Some(Value::Number(number)) if number.as_i64() == Some(1) => true,
        _ => false,
    };
    if !pokoin && !cardtrader {
        json!({"pokoin": true, "cardtrader": false})
    } else {
        json!({"pokoin": pokoin, "cardtrader": cardtrader})
    }
}

/// Dispatch one `/api/scan-batch` POST action.
pub async fn mutate_batch(
    db: &DbPools,
    ownership: &dyn ScanOwnership,
    seller_uid: &str,
    batch_id: &str,
    action: &str,
    payload: &Value,
) -> ApiResult<Value> {
    let item_id = payload.get("itemId").and_then(Value::as_str).unwrap_or_default();
    match action {
        "defaults" => {
            let defaults = payload.get("defaults").cloned().unwrap_or_else(|| payload.clone());
            set_defaults(db, seller_uid, batch_id, &defaults).await
        }
        "item" => {
            let patch = payload.get("patch").cloned().unwrap_or_else(|| payload.clone());
            patch_item(db, seller_uid, item_id, &patch, payload.get("onlyIfEmptyPrice") == Some(&Value::Bool(true))).await
        }
        "add" => add_manual(db, seller_uid, batch_id, payload).await,
        "remove" => set_status(db, seller_uid, item_id, "active", "removed").await,
        "restore" => set_status(db, seller_uid, item_id, "removed", "active").await,
        "duplicate" => duplicate_item(db, seller_uid, item_id).await,
        "unmerge" => unmerge_item(db, seller_uid, item_id).await,
        "discard" => discard_batch(db, seller_uid, batch_id).await,
        "submit" => {
            let submit_key = payload.get("submitKey").and_then(Value::as_str).unwrap_or_default();
            let seller_name = payload.get("sellerName").and_then(Value::as_str).unwrap_or("Pokoin seller");
            let intent = payload.get("intent").and_then(Value::as_str).unwrap_or("list");
            let targets = payload.get("targets").cloned().unwrap_or_else(|| json!({"pokoin": true, "cardtrader": false}));
            submit_batch(db, ownership, seller_uid, batch_id, submit_key, seller_name, intent, &targets).await
        }
        _ => Err(ApiError::bad_request("Unknown batch action.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_and_retry_math() {
        assert_eq!(window_start(1_000_123, 600_000).unix_timestamp(), 600);
        assert_eq!(retry_after(rules::Limit { max: 1, window_ms: 600_000 }, 601_000), 599);
        assert!(retry_after(rules::Limit { max: 1, window_ms: 600_000 }, 599_000) >= 1);
    }

    #[test]
    fn too_many_carries_retry_after() {
        let error = too_many(rules::LIMIT_PAIR_FAIL_PER_IP, 0);
        assert_eq!(error.status, 429);
        assert_eq!(error.code.as_deref(), Some("rate_limited"));
        assert!(error.retry_after_sec.unwrap() >= 1);
    }
}
