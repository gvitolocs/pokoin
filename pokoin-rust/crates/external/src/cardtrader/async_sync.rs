//! Background CardTrader inventory sync jobs — native port of
//! `_cardtrader_inventory_async.js`. Connect/sync return immediately; the
//! reconcile runs on a tokio task guarded twice: an in-process map plus the
//! shared Redis lock (`pokoin:lock:v1:ct-reconcile:{uid}`, 15 min TTL,
//! owner-checked release) so Pi and k3s overflow instances never reconcile
//! the same seller twice. Redis down degrades to the in-process guard only.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::cardtrader::client::CardTraderClient;
use crate::cardtrader::integration as ct_integration;
use crate::cardtrader::link::PowerToolsByGame;
use crate::cardtrader::sync::{read_seller_sync, record_seller_sync, reconcile_cardtrader_inventory, ReconcileArgs};
use crate::db::DbPools;
use crate::error::{clean_text, ApiResult};
use crate::firebase::FirestoreStore;
use crate::redis::{lock_key, RedisCache};

const RECONCILE_LOCK_TTL_SEC: u64 = 15 * 60;

pub struct SyncJobs {
    running: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    /// The error of each seller's last job on this instance that failed, kept
    /// in memory because recording it may have failed with the database.
    failures: Mutex<HashMap<String, String>>,
    redis: Option<RedisCache>,
}

/// A stored "running" sync older than this died without recording its end
/// (the reconcile lock lives 15 minutes).
const STALE_RUN_MS: i64 = 20 * 60 * 1000;

impl SyncJobs {
    pub fn new(redis: Option<RedisCache>) -> Self {
        Self { running: Mutex::new(HashMap::new()), failures: Mutex::new(HashMap::new()), redis }
    }

    pub async fn is_running(&self, uid: &str) -> bool {
        let mut running = self.running.lock().await;
        let uid = clean_text(Some(uid), 160);
        Self::prune(&mut running);
        running.contains_key(&uid)
    }

    fn prune(running: &mut HashMap<String, tokio::task::JoinHandle<()>>) {
        running.retain(|_, handle| !handle.is_finished());
    }

    /// `acquireReconcileLock` — None when another instance holds it; a
    /// degraded handle (empty owner) when Redis is unreachable.
    async fn acquire(&self, uid: &str) -> Option<(String, String)> {
        let Some(redis) = &self.redis else {
            return Some((lock_key("ct-reconcile", uid), String::new()));
        };
        if !redis.ping().await {
            return Some((lock_key("ct-reconcile", uid), String::new()));
        }
        let key = lock_key("ct-reconcile", uid);
        let owner = crate::crypto::random_secret(16, &mut rand::thread_rng());
        match redis.acquire_lock(&key, &owner, RECONCILE_LOCK_TTL_SEC).await {
            Ok(true) => Some((key, owner)),
            _ => None,
        }
    }

    async fn release(&self, key: &str, owner: &str) {
        if !owner.is_empty() {
            if let Some(redis) = &self.redis {
                redis.release_lock(key, owner).await;
            }
        }
    }

    /// Start a background reconcile. Safe to call twice — the second call is
    /// a no-op. Returns (started, already_running).
    #[allow(clippy::too_many_arguments)]
    pub async fn enqueue(
        self: &Arc<Self>,
        firestore: Arc<dyn FirestoreStore>,
        db: DbPools,
        ct: CardTraderClient,
        uid: &str,
        seller_name: String,
        token: Option<String>,
        one_day_ready: Option<bool>,
    ) -> ApiResult<(bool, bool)> {
        self.enqueue_with_power_tools(firestore, db, ct, uid, seller_name, token, one_day_ready, None).await
    }

    /// [`Self::enqueue`] carrying Power Tools rows whose locations the
    /// reconcile writes onto the matched listings.
    #[allow(clippy::too_many_arguments)]
    pub async fn enqueue_with_power_tools(
        self: &Arc<Self>,
        firestore: Arc<dyn FirestoreStore>,
        db: DbPools,
        ct: CardTraderClient,
        uid: &str,
        seller_name: String,
        token: Option<String>,
        one_day_ready: Option<bool>,
        power_tools_by_game: Option<PowerToolsByGame>,
    ) -> ApiResult<(bool, bool)> {
        let seller_uid = clean_text(Some(uid), 160);
        if seller_uid.is_empty() {
            return Err(crate::error::ApiError::bad_request("Missing seller uid."));
        }
        {
            let mut running = self.running.lock().await;
            Self::prune(&mut running);
            if running.contains_key(&seller_uid) {
                return Ok((false, true));
            }
        }
        let Some((lock_key, lock_owner)) = self.acquire(&seller_uid).await else {
            tracing::warn!(uid = %seller_uid, "cardtrader inventory sync already running on another instance");
            return Ok((false, true));
        };
        // Without Redis there is no other instance to share a lock with; with
        // Redis down the lock is only in-process, so CardTrader writes wait.
        let exclusive = self.redis.is_none() || !lock_owner.is_empty();
        self.failures.lock().await.remove(&seller_uid);

        let jobs = Arc::clone(self);
        let uid_for_task = seller_uid.clone();
        let handle = tokio::spawn(async move {
            let result = async {
                let _ = record_seller_sync(
                    &db,
                    &uid_for_task,
                    false,
                    true,
                    "",
                    &json!({ "running": true, "phase": "starting", "processed": 0, "total": 0 }),
                    0,
                    false,
                )
                .await;
                reconcile_cardtrader_inventory(ReconcileArgs {
                    firestore: firestore.as_ref(),
                    db: &db,
                    ct: &ct,
                    uid: &uid_for_task,
                    seller_name,
                    token,
                    one_day_ready,
                    on_progress: None,
                    power_tools_by_game,
                    preview_games_only: false,
                    direction: None,
                    exclusive,
                })
                .await
            }
            .await;
            let failure = match &result {
                Err(error) => Some(error.message.clone()),
                Ok(outcome) if outcome["ok"] == false => Some(crate::error::clean_text_value(outcome.get("error").unwrap_or(&Value::Null), 500)),
                Ok(_) => None,
            };
            if let Some(message) = failure {
                let message = if message.is_empty() { "CardTrader sync failed.".to_string() } else { message };
                jobs.failures.lock().await.insert(uid_for_task.clone(), message);
            }
            if let Err(error) = result {
                tracing::error!(uid = %uid_for_task, "cardtrader inventory sync job failed: {}", error.message);
                let _ = record_seller_sync(
                    &db,
                    &uid_for_task,
                    false,
                    true,
                    &error.message,
                    &json!({ "running": false, "phase": "failed", "processed": 0, "total": 0 }),
                    0,
                    false,
                )
                .await;
            }
            jobs.release(&lock_key, &lock_owner).await;
            jobs.running.lock().await.remove(&uid_for_task);
        });
        self.running.lock().await.insert(seller_uid, handle);
        Ok((true, false))
    }

    /// `readInventorySyncProgress`.
    pub async fn progress(&self, db: &DbPools, uid: &str) -> ApiResult<Value> {
        let uid = clean_text(Some(uid), 160);
        let row = read_seller_sync(db, &uid).await?;
        let summary = row
            .as_ref()
            .and_then(|row| row.get("last_sync_summary").cloned())
            .filter(|v| v.is_object())
            .unwrap_or(json!({}));
        let live = self.is_running(&uid).await;
        let started_ms = row
            .as_ref()
            .and_then(|row| row.get("last_sync_at"))
            .and_then(Value::as_str)
            .and_then(crate::time_util::ms_from_iso);
        let (flagged, stale) = run_flags(&summary, live, started_ms, crate::time_util::now_ms());
        let last_error = if live { None } else { self.failures.lock().await.get(&uid).cloned() };
        let phase = summary
            .get("phase")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.is_empty() && !stale)
            .or_else(|| if live { Some("running".into()) } else if stale { Some("failed".into()) } else { None });
        Ok(json!({
            "row": row,
            "running": live || flagged,
            "phase": phase,
            "processed": summary.get("processed").and_then(Value::as_i64).unwrap_or(0),
            "total": summary.get("total").and_then(Value::as_i64).unwrap_or(0),
            "summary": summary,
            "stale": stale,
            "lastError": last_error,
        }))
    }
}

/// (`running` as stored and still believable, `stale`): a stored run that no
/// instance finished within [`STALE_RUN_MS`] died (a restart, or the database
/// failing under it) and is reported as failed, not polled forever.
fn run_flags(summary: &Value, live: bool, started_ms: Option<i64>, now_ms: i64) -> (bool, bool) {
    let stored = summary.get("running") == Some(&Value::Bool(true));
    if !stored || live {
        return (stored, false);
    }
    match started_ms {
        Some(started) if now_ms - started > STALE_RUN_MS => (false, true),
        _ => (true, false),
    }
}

/// Tokenless enqueue used by webhook fallbacks: decrypts the stored token.
pub async fn enqueue_with_stored_token(
    jobs: &Arc<SyncJobs>,
    firestore: Arc<dyn FirestoreStore>,
    db: DbPools,
    ct: CardTraderClient,
    uid: &str,
) -> ApiResult<(bool, bool)> {
    enqueue_stored_with_power_tools(jobs, firestore, db, ct, uid, None).await
}

/// [`enqueue_with_stored_token`] carrying Power Tools rows (manual sync).
pub async fn enqueue_stored_with_power_tools(
    jobs: &Arc<SyncJobs>,
    firestore: Arc<dyn FirestoreStore>,
    db: DbPools,
    ct: CardTraderClient,
    uid: &str,
    power_tools_by_game: Option<PowerToolsByGame>,
) -> ApiResult<(bool, bool)> {
    let token = ct_integration::decrypt_integration_token(firestore.as_ref(), uid).await?;
    jobs.enqueue_with_power_tools(firestore, db, ct, uid, "Pokoin seller".into(), Some(token), None, power_tools_by_game)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_run_nobody_finished_turns_stale() {
        let running = json!({ "running": true, "phase": "starting" });
        let now = 10_000_000_000i64;
        assert_eq!(run_flags(&running, true, Some(0), now), (true, false), "a live job is never stale");
        assert_eq!(run_flags(&running, false, Some(now - 60_000), now), (true, false), "another instance may run it");
        assert_eq!(run_flags(&running, false, Some(now - STALE_RUN_MS - 1), now), (false, true));
        assert_eq!(run_flags(&json!({ "running": false }), false, Some(0), now), (false, false));
    }

    #[tokio::test]
    async fn enqueue_is_idempotent_per_seller() {
        // No Redis configured → in-process guard only. The job body needs the
        // CT client; it will fail fast against the real base URL but the
        // guard behavior is what is under test here.
        let jobs = Arc::new(SyncJobs::new(None));
        let firestore = Arc::new(crate::firebase::MemoryFirestore::new());
        let started = jobs
            .enqueue(
                firestore.clone(),
                DbPools::disconnected(),
                CardTraderClient::with_base("http://127.0.0.1:9".into()),
                "seller-1",
                "Seller".into(),
                Some("tok".into()),
                Some(false),
            )
            .await
            .unwrap();
        assert_eq!(started, (true, false));
        let again = jobs
            .enqueue(
                firestore,
                DbPools::disconnected(),
                CardTraderClient::with_base("http://127.0.0.1:9".into()),
                "seller-1",
                "Seller".into(),
                Some("tok".into()),
                Some(false),
            )
            .await
            .unwrap();
        assert_eq!(again, (false, true));
        // A different seller is not blocked.
        let other = jobs
            .enqueue(
                Arc::new(crate::firebase::MemoryFirestore::new()),
                DbPools::disconnected(),
                CardTraderClient::with_base("http://127.0.0.1:9".into()),
                "seller-2",
                "Seller".into(),
                Some("tok".into()),
                Some(false),
            )
            .await
            .unwrap();
        assert_eq!(other, (true, false));
        // Empty uid is rejected.
        assert!(jobs
            .enqueue(
                Arc::new(crate::firebase::MemoryFirestore::new()),
                DbPools::disconnected(),
                CardTraderClient::with_base("http://127.0.0.1:9".into()),
                "",
                "Seller".into(),
                None,
                None,
            )
            .await
            .is_err());
    }
}
