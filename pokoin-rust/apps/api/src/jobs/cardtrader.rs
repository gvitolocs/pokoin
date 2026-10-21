use super::{accounts_firestore, clipped, now_ms, redis_connection, text, Options};
use anyhow::{bail, Result};
use pokoin_external::cardtrader::{
    client::http_error_status,
    integration,
    sync::{reconcile_cardtrader_inventory, ReconcileArgs},
};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone)]
struct Lock {
    key: String,
    owner: String,
}
fn connected(row: &Value) -> bool {
    row.get("provider").and_then(Value::as_str) == Some("cardtrader")
        && row.get("enabled") == Some(&Value::Bool(true))
        && !text(row.get("uid")).is_empty()
}
fn seller_name(row: &Value) -> String {
    for path in [
        "/metadata/user/username",
        "/metadata/seller/name",
        "/userEmail",
    ] {
        let name = text(row.pointer(path));
        if !name.is_empty() {
            return clipped(&name, 160);
        }
    }
    "Pokoin seller".into()
}
fn one_day_ready(row: &Value) -> Option<bool> {
    row.pointer("/metadata/oneDayReady")
        .and_then(Value::as_bool)
}
fn registered_url(response: &Value) -> String {
    let app = response
        .get("app")
        .filter(|a| a.is_object())
        .unwrap_or(response);
    text(app.get("webhook_url").or_else(|| app.get("webhookUrl")))
        .trim()
        .into()
}
/// Why webhook re-registration failed. Only a CardTrader HTTP 5xx is
/// transient (2026-10-20 02:08 UTC: 503 on PUT /app for one seller); every
/// other failure — 4xx, rejected token, transport, missing URL, confirmation
/// mismatch — is final. The message stays the fixed client message.
enum WebhookError {
    Transient { status: u16, message: String },
    Failed(String),
}
impl std::fmt::Display for WebhookError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            WebhookError::Transient { message, .. } => message,
            WebhookError::Failed(message) => message,
        };
        f.write_str(message)
    }
}
trait Backend {
    async fn integrations(&mut self) -> Result<Vec<Value>>;
    async fn acquire(&mut self, uid: &str) -> Option<Lock>;
    async fn release(&mut self, lock: &Lock);
    async fn token(&mut self, uid: &str) -> Result<String>;
    async fn register(&mut self, uid: &str, token: &str) -> Result<(), WebhookError>;
    async fn reconcile(
        &mut self,
        uid: &str,
        name: String,
        token: String,
        ready: Option<bool>,
        exclusive: bool,
    ) -> Result<Value>;
}
async fn reconcile_all(
    backend: &mut impl Backend,
    dry_run: bool,
    webhook_retry_wait: Duration,
) -> Result<Value> {
    let integrations = backend.integrations().await?;
    if dry_run {
        return Ok(
            json!({"dryRun":true,"sellers":integrations.iter().filter(|r| connected(r)).count()}),
        );
    }
    let mut results = Vec::new();
    for integration in integrations.iter().filter(|r| connected(r)) {
        let uid = text(integration.get("uid")).trim().to_string();
        let mut row = json!({"uid":uid, "webhookOk":false, "syncOk":false});
        let Some(lock) = backend.acquire(&uid).await else {
            row["skipped"] = json!(true);
            row["syncError"] = json!("already reconciling on another instance");
            println!("cardtrader periodic seller reconcile {row}");
            results.push(row);
            continue;
        };
        let sync_result = async {
            let token = backend.token(&uid).await?;
            // One CardTrader HTTP 5xx on webhook registration is retried once
            // after a short wait; 4xx, rejected tokens and transport errors
            // are final.
            let register_outcome = match backend.register(&uid, &token).await {
                Err(WebhookError::Transient { status, .. }) => {
                    tokio::time::sleep(webhook_retry_wait).await;
                    tracing::warn!(status, "cardtrader webhook re-registration retry");
                    backend.register(&uid, &token).await
                }
                outcome => outcome,
            };
            match register_outcome {
                Ok(()) => row["webhookOk"] = json!(true),
                Err(error) => {
                    row["webhookError"] = json!(clipped(&error.to_string(), 500));
                    if matches!(&error, WebhookError::Transient { .. }) {
                        row["webhookTransient"] = json!(true);
                    }
                }
            }
            let sync = backend
                .reconcile(
                    &uid,
                    seller_name(integration),
                    token,
                    one_day_ready(integration),
                    // A degraded lock (Redis down) is not shared: no CardTrader writes.
                    !lock.owner.is_empty(),
                )
                .await?;
            let ok = sync["ok"] == true && sync["incomplete"] != true;
            row["syncOk"] = json!(ok);
            for key in ["removed", "updated", "inventory"] {
                let count = sync
                    .get("summary")
                    .and_then(|s| s.get(key))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                row[key] = json!(count);
            }
            if !ok {
                let error = text(sync.get("error"));
                row["syncError"] = json!(clipped(
                    if error.is_empty() {
                        "Incomplete inventory export."
                    } else {
                        &error
                    },
                    500
                ));
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = sync_result {
            row["syncError"] = json!(clipped(&error.to_string(), 500));
        }
        backend.release(&lock).await;
        println!("cardtrader periodic seller reconcile {row}");
        results.push(row);
    }
    let skipped = results.iter().filter(|r| r["skipped"] == true).count();
    // A transient-only webhook miss (both attempts 5xx, sync fine) is a
    // warning, not a failure; with a sync failure it still fails.
    let warnings = results
        .iter()
        .filter(|r| r["webhookTransient"] == true && r["syncOk"] == true)
        .count();
    let failed = results
        .iter()
        .filter(|r| {
            r["skipped"] != true
                && (r["syncOk"] != true
                    || (r["webhookOk"] != true && r["webhookTransient"] != true))
        })
        .count();
    Ok(
        json!({"ok":failed == 0, "sellers":results.len(), "failed":failed, "warnings":warnings, "skipped":skipped, "results":results}),
    )
}
struct Native {
    state: pokoin_external::DomainState,
    firestore: pokoin_accounts::firestore::Firestore,
}
impl Backend for Native {
    async fn integrations(&mut self) -> Result<Vec<Value>> {
        let docs = self
            .firestore
            .run_query(&pokoin_accounts::firestore::Query::collection(
                "seller_integrations",
            ))
            .await?;
        Ok(docs
            .iter()
            .map(|d| {
                let mut row = d.to_plain_json();
                if row.get("id").is_none() {
                    row["id"] = json!(d.id());
                }
                row
            })
            .collect())
    }
    async fn acquire(&mut self, uid: &str) -> Option<Lock> {
        let key = pokoin_external::redis::lock_key("ct-reconcile", &clipped(uid.trim(), 160));
        let owner = pokoin_accounts::firestore::new_document_id();
        let degraded = Lock {
            key: key.clone(),
            owner: String::new(),
        };
        let Ok(mut redis) = redis_connection().await else {
            return Some(degraded);
        };
        let ping: Result<String, _> = redis::cmd("PING").query_async(&mut redis).await;
        if !matches!(ping, Ok(ref v) if v == "PONG") {
            return Some(degraded);
        }
        match redis::cmd("SET")
            .arg(&key)
            .arg(&owner)
            .arg("NX")
            .arg("EX")
            .arg(900)
            .query_async::<Option<String>>(&mut redis)
            .await
        {
            Ok(Some(_)) => Some(Lock { key, owner }),
            Ok(None) => None,
            Err(_) => Some(degraded),
        }
    }
    async fn release(&mut self, lock: &Lock) {
        if lock.owner.is_empty() {
            return;
        }
        let Ok(mut redis) = redis_connection().await else {
            return;
        };
        let script = redis::Script::new(
            r#"if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end"#,
        );
        let _: Result<i64, _> = script
            .key(&lock.key)
            .arg(&lock.owner)
            .invoke_async(&mut redis)
            .await;
    }
    async fn token(&mut self, uid: &str) -> Result<String> {
        Ok(integration::decrypt_integration_token(self.state.firestore.as_ref(), uid).await?)
    }
    async fn register(&mut self, uid: &str, token: &str) -> Result<(), WebhookError> {
        let url = self.state.webhook_url_for_uid(uid);
        if url.is_empty() {
            return Err(WebhookError::Failed(
                "Missing CardTrader webhook URL.".into(),
            ));
        }
        let outcome = match self
            .state
            .cardtrader
            .update_app_webhook_url(token, &url)
            .await
        {
            Ok(response) if registered_url(&response) == url.trim() => Ok(()),
            Ok(_) => Err(WebhookError::Failed(
                "CardTrader did not confirm the requested webhook URL.".into(),
            )),
            Err(error) => Err(match http_error_status(&error) {
                Some(status) if (500..=599).contains(&status) => WebhookError::Transient {
                    status,
                    message: error.message,
                },
                _ => WebhookError::Failed(error.to_string()),
            }),
        };
        let at = pokoin_external::time_util::iso_from_ms(now_ms());
        let mut registration = json!({"ok":outcome.is_ok(),"url":clipped(&url,500),"error":outcome.as_ref().err().map(|e| clipped(&e.to_string(),500)).unwrap_or_default(),"lastAttemptAt":at});
        if outcome.is_ok() {
            registration["registeredAt"] = json!(at);
        }
        let written = self
            .state
            .firestore
            .merge_doc(
                "seller_integrations",
                &integration::integration_doc_id(uid),
                json!({"webhookRegistration":registration,"updatedAt":at}),
            )
            .await;
        outcome?;
        written.map_err(|error| WebhookError::Failed(error.to_string()))?;
        Ok(())
    }
    async fn reconcile(
        &mut self,
        uid: &str,
        name: String,
        token: String,
        ready: Option<bool>,
        exclusive: bool,
    ) -> Result<Value> {
        Ok(reconcile_cardtrader_inventory(ReconcileArgs {
            firestore: self.state.firestore.as_ref(),
            db: &self.state.db,
            ct: &self.state.cardtrader,
            uid,
            seller_name: name,
            token: Some(token),
            one_day_ready: ready,
            on_progress: None,
            power_tools_by_game: None,
            preview_games_only: false,
            direction: None,
            exclusive,
        })
        .await?)
    }
}
pub(super) async fn run(options: &Options) -> Result<()> {
    let mut backend = Native {
        state: pokoin_external::DomainState::from_env(2).await?,
        firestore: accounts_firestore()?,
    };
    let report = reconcile_all(&mut backend, options.dry_run, Duration::from_secs(2)).await?;
    println!("cardtrader periodic reconcile complete {report}");
    if !options.dry_run && report["ok"] != true {
        bail!(
            "CardTrader reconcile failed for {} sellers",
            report["failed"]
        );
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Mock {
        skip: bool,
        token_failure: bool,
        webhook_failure: bool,
        webhook_transient: usize,
        incomplete: bool,
        register_calls: usize,
        released: usize,
        synced: usize,
    }
    impl Backend for Mock {
        async fn integrations(&mut self) -> Result<Vec<Value>> {
            Ok(vec![
                json!({"provider":"cardtrader","enabled":true,"uid":" u1 ","metadata":{"user":{"username":"Seller"},"oneDayReady":false}}),
                json!({"provider":"cardtrader","enabled":false,"uid":"off"}),
            ])
        }
        async fn acquire(&mut self, _: &str) -> Option<Lock> {
            if self.skip {
                None
            } else {
                Some(Lock {
                    key: "key".into(),
                    owner: "owner".into(),
                })
            }
        }
        async fn release(&mut self, _: &Lock) {
            self.released += 1;
        }
        async fn token(&mut self, _: &str) -> Result<String> {
            if self.token_failure {
                bail!("cannot decrypt")
            };
            Ok("token".into())
        }
        async fn register(&mut self, _: &str, _: &str) -> Result<(), WebhookError> {
            self.register_calls += 1;
            if self.webhook_transient > 0 {
                self.webhook_transient -= 1;
                return Err(WebhookError::Transient {
                    status: 503,
                    message: "CardTrader request failed with HTTP 503.".into(),
                });
            }
            if self.webhook_failure {
                return Err(WebhookError::Failed("registration failed".into()));
            }
            Ok(())
        }
        async fn reconcile(
            &mut self,
            uid: &str,
            name: String,
            _: String,
            ready: Option<bool>,
            exclusive: bool,
        ) -> Result<Value> {
            assert_eq!(uid, "u1");
            assert_eq!(name, "Seller");
            assert_eq!(ready, Some(false));
            assert!(exclusive, "the mock lock has an owner");
            self.synced += 1;
            Ok(
                json!({"ok":true,"incomplete":self.incomplete,"summary":{"removed":1,"updated":2,"inventory":3}}),
            )
        }
    }
    #[test]
    fn names_ready_and_registration_match_reference() {
        assert_eq!(seller_name(&json!({})), "Pokoin seller");
        assert_eq!(
            seller_name(&json!({"metadata":{"seller":{"name":"name"}},"userEmail":"email"})),
            "name"
        );
        assert_eq!(
            one_day_ready(&json!({"metadata":{"oneDayReady":"true"}})),
            None
        );
        assert_eq!(
            registered_url(&json!({"app":{"webhook_url":" url "}})),
            "url"
        );
        assert_eq!(registered_url(&json!({"webhookUrl":"u"})), "u");
        assert!(!connected(&json!({"enabled":true,"uid":"u"})));
    }
    #[tokio::test]
    async fn lock_contention_is_skip_and_dry_run_is_read_only() {
        let mut backend = Mock {
            skip: true,
            ..Default::default()
        };
        let report = reconcile_all(&mut backend, false, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(report["ok"], true);
        assert_eq!(report["skipped"], 1);
        assert_eq!(backend.synced, 0);
        backend.skip = false;
        reconcile_all(&mut backend, true, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(backend.synced, 0);
        assert_eq!(backend.released, 0);
    }
    #[tokio::test]
    async fn webhook_failure_still_syncs_and_token_failure_releases_lock() {
        let mut backend = Mock {
            webhook_failure: true,
            ..Default::default()
        };
        let report = reconcile_all(&mut backend, false, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(report["ok"], false);
        assert_eq!(backend.synced, 1);
        assert_eq!(backend.released, 1);
        backend.token_failure = true;
        reconcile_all(&mut backend, false, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(backend.synced, 1);
        assert_eq!(backend.released, 2);
    }
    #[test]
    fn timer_waits_after_each_run_ends() {
        // OnUnitActiveSec counts from the start of a run: 7-minute runs every
        // 5 minutes chained back to back on the Pi (2026-10-10).
        let timer = include_str!(
            "../../../../../deploy/systemd/pokoin-rust-job-cardtrader-seller-reconcile.timer"
        );
        let settings: Vec<&str> = timer
            .lines()
            .map(str::trim)
            .filter(|line| !line.starts_with('#'))
            .collect();
        assert!(settings.contains(&"OnUnitInactiveSec=10min"));
        assert!(!settings
            .iter()
            .any(|line| line.starts_with("OnUnitActiveSec")));
        // The first run after boot still needs a start of its own.
        assert!(settings.contains(&"OnBootSec=2min"));
    }
    #[tokio::test]
    async fn incomplete_export_is_failure() {
        let mut backend = Mock {
            incomplete: true,
            ..Default::default()
        };
        let report = reconcile_all(&mut backend, false, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(report["failed"], 1);
        assert_eq!(
            report["results"][0]["syncError"],
            "Incomplete inventory export."
        );
    }
    #[tokio::test]
    async fn webhook_5xx_is_retried_once_and_then_ok() {
        let mut backend = Mock {
            webhook_transient: 1,
            ..Default::default()
        };
        let report = reconcile_all(&mut backend, false, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(backend.register_calls, 2);
        assert_eq!(report["results"][0]["webhookOk"], true);
        assert_eq!(report["results"][0].get("webhookTransient"), None);
        assert_eq!(report["ok"], true);
        assert_eq!(report["failed"], 0);
        assert_eq!(report["warnings"], 0);
    }
    #[tokio::test]
    async fn webhook_5xx_twice_with_sync_ok_is_warning_only() {
        // Two retries would mean the loop retries more than once.
        let mut backend = Mock {
            webhook_transient: 9,
            ..Default::default()
        };
        let report = reconcile_all(&mut backend, false, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(backend.register_calls, 2);
        assert_eq!(report["results"][0]["webhookOk"], false);
        assert_eq!(
            report["results"][0]["webhookError"],
            "CardTrader request failed with HTTP 503."
        );
        assert_eq!(report["results"][0]["webhookTransient"], true);
        assert_eq!(report["ok"], true);
        assert_eq!(report["failed"], 0);
        assert_eq!(report["warnings"], 1);
    }
    #[tokio::test]
    async fn webhook_5xx_twice_with_sync_failure_still_fails() {
        let mut backend = Mock {
            webhook_transient: 9,
            incomplete: true,
            ..Default::default()
        };
        let report = reconcile_all(&mut backend, false, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(backend.register_calls, 2);
        assert_eq!(report["ok"], false);
        assert_eq!(report["failed"], 1);
    }
    #[tokio::test]
    async fn webhook_non_5xx_is_not_retried() {
        let mut backend = Mock {
            webhook_failure: true,
            ..Default::default()
        };
        let report = reconcile_all(&mut backend, false, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(backend.register_calls, 1);
        assert_eq!(report["results"][0]["webhookOk"], false);
        assert_eq!(report["results"][0].get("webhookTransient"), None);
        assert_eq!(report["ok"], false);
        assert_eq!(report["failed"], 1);
        assert_eq!(report["warnings"], 0);
    }
}
