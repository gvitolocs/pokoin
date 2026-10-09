//! Shared, cloneable domain state for the external-integrations router.
//!
//! The root worker mounts [`crate::router`] behind its own listener; this
//! crate never opens a socket. Every collaborator is either cheap to clone
//! (`Arc`, `PgPool`) or explicitly constructed by the integrator:
//!
//! ```ignore
//! let state = DomainState::new(firestore, verifier, DbPools::from_env(8).await?);
//! let app = pokoin_external::router(state);
//! ```

use std::sync::Arc;

use crate::cardtrader::async_sync::SyncJobs;
use crate::cardtrader::client::CardTraderClient;
use crate::db::DbPools;
use crate::firebase::{FirestoreStore, StaticVerifier, TokenVerifier};
use crate::powertools::PowerToolsClient;
use crate::r2::R2Client;
use crate::redis::RedisCache;
use crate::scan::RecognitionClient;

/// Non-secret route configuration read from the environment once at boot.
#[derive(Clone, Debug)]
pub struct DomainConfig {
    /// `CARDTRADER_DAILY_REFRESH_SECRET` / `CARDTRADER_DAILY_LISTINGS_SECRET` / `CRON_SECRET`.
    pub daily_refresh_secrets: Vec<String>,
    /// `CARDTRADER_GAME_INGEST_SECRET`.
    pub game_ingest_secret: Option<String>,
    /// `CARDTRADER_WEBHOOK_BASE_URL` (defaults to `https://api.pokoin.com`).
    pub webhook_base_url: String,
}

impl Default for DomainConfig {
    fn default() -> Self {
        Self::from_env()
    }
}

impl DomainConfig {
    pub fn from_env() -> Self {
        let secrets = [
            "CARDTRADER_DAILY_LISTINGS_SECRET",
            "CARDTRADER_DAILY_REFRESH_SECRET",
            "CRON_SECRET",
        ]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
        let webhook_base_url = std::env::var("CARDTRADER_WEBHOOK_BASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "https://api.pokoin.com".to_string());
        Self {
            daily_refresh_secrets: secrets,
            game_ingest_secret: std::env::var("CARDTRADER_GAME_INGEST_SECRET")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            webhook_base_url: webhook_base_url.trim().trim_end_matches('/').to_string(),
        }
    }

    /// Constant-time check of an admin/cron secret against every configured value.
    pub fn secret_matches(&self, provided: &str) -> bool {
        if provided.is_empty() {
            return false;
        }
        self.daily_refresh_secrets
            .iter()
            .any(|secret| crate::crypto::constant_time_eq(secret.as_bytes(), provided.as_bytes()))
    }

    pub fn game_secret_matches(&self, provided: &str) -> bool {
        match &self.game_ingest_secret {
            Some(secret) => {
                !provided.is_empty()
                    && crate::crypto::constant_time_eq(secret.as_bytes(), provided.as_bytes())
            }
            None => false,
        }
    }
}

/// Everything a handler needs. Cloning is cheap and shares the pools.
#[derive(Clone)]
pub struct DomainState {
    pub firestore: Arc<dyn FirestoreStore>,
    pub verifier: Arc<dyn TokenVerifier>,
    pub db: DbPools,
    pub redis: Option<RedisCache>,
    pub cardtrader: CardTraderClient,
    pub powertools: PowerToolsClient,
    pub recognition: RecognitionClient,
    pub sync_jobs: Arc<SyncJobs>,
    pub r2_user_photos: Option<R2Client>,
    pub r2_profile_pictures: Option<R2Client>,
    pub r2_forum_media: Option<R2Client>,
    /// Accounts-owned Firestore collection writer used by scan submit.
    pub scan_ownership: Arc<dyn crate::scan_store::ScanOwnership>,
    pub config: Arc<DomainConfig>,
}

impl DomainState {
    /// Build production state. `redis` is optional (single-instance degraded
    /// mode); everything else must be supplied by the integrator.
    pub fn new(
        firestore: Arc<dyn FirestoreStore>,
        verifier: Arc<dyn TokenVerifier>,
        db: DbPools,
        redis: Option<RedisCache>,
    ) -> Self {
        let sync_jobs = Arc::new(SyncJobs::new(redis.clone()));
        Self {
            firestore,
            verifier,
            db,
            redis,
            cardtrader: CardTraderClient::new(),
            powertools: PowerToolsClient::new(),
            recognition: RecognitionClient::from_env(),
            sync_jobs,
            r2_user_photos: R2Client::from_env("R2_USER_PHOTOS_BUCKET"),
            r2_profile_pictures: R2Client::from_env("R2_PROFILE_PICTURES_BUCKET"),
            r2_forum_media: R2Client::from_env("R2_FORUM_MEDIA_BUCKET"),
            scan_ownership: Arc::new(crate::scan_store::UnconfiguredOwnership),
            config: Arc::new(DomainConfig::from_env()),
        }
    }

    /// Production constructor. Fails closed when Firebase Admin credentials or
    /// the marketplace database are missing; it never falls back to
    /// [`crate::firebase::MemoryFirestore`].
    pub async fn from_env(pool_max: u32) -> crate::error::ApiResult<Self> {
        use crate::error::ApiError;
        let project_id = std::env::var("FIREBASE_PROJECT_ID")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ApiError::new(500, "FIREBASE_PROJECT_ID is not configured.")
                    .with_code("firebase_not_configured")
            })?;
        let firestore = crate::firebase::FirestoreRest::from_env().ok_or_else(|| {
            ApiError::new(500, "Firebase Admin credentials are not configured.")
                .with_code("firebase_not_configured")
        })?;
        let verifier = Arc::new(crate::firebase::FirebaseJwksVerifier::new(project_id));
        let db = DbPools::from_env(pool_max).await?;
        let redis = RedisCache::from_env();
        Ok(Self {
            firestore: Arc::new(firestore),
            verifier,
            db,
            redis: redis.clone(),
            cardtrader: CardTraderClient::new(),
            powertools: PowerToolsClient::new(),
            recognition: RecognitionClient::from_env(),
            sync_jobs: Arc::new(SyncJobs::new(redis)),
            r2_user_photos: R2Client::from_env("R2_USER_PHOTOS_BUCKET"),
            r2_profile_pictures: R2Client::from_env("R2_PROFILE_PICTURES_BUCKET"),
            r2_forum_media: R2Client::from_env("R2_FORUM_MEDIA_BUCKET"),
            scan_ownership: Arc::new(crate::scan_store::UnconfiguredOwnership),
            config: Arc::new(DomainConfig::from_env()),
        })
    }

    /// True when the Firestore binding can actually persist (production REST).
    pub fn is_durable(&self) -> bool {
        self.firestore.durable()
    }

    /// Guard for handlers that must never answer from the in-memory test store.
    pub fn require_durable_firestore(&self) -> crate::error::ApiResult<()> {
        if self.firestore.durable() {
            Ok(())
        } else {
            Err(crate::error::ApiError::new(503, "Durable Firestore is not configured.")
                .with_code("firestore_not_configured"))
        }
    }

    /// Deterministic state for route/db-less tests: in-memory Firestore,
    /// `Bearer test-<uid>` tokens, no pools, no workers.
    pub fn for_test() -> Self {
        let firestore: Arc<dyn FirestoreStore> = Arc::new(crate::firebase::MemoryFirestore::new());
        let verifier: Arc<dyn TokenVerifier> = Arc::new(StaticVerifier::default());
        let db = DbPools::disconnected();
        let sync_jobs = Arc::new(SyncJobs::new(None));
        Self {
            firestore,
            verifier,
            db,
            redis: None,
            cardtrader: CardTraderClient::with_base("http://127.0.0.1:9".into()),
            powertools: PowerToolsClient::new().with_base("http://127.0.0.1:9".into()),
            recognition: RecognitionClient::disabled(),
            sync_jobs,
            r2_user_photos: None,
            r2_profile_pictures: None,
            r2_forum_media: None,
            scan_ownership: Arc::new(crate::scan_store::MemoryScanOwnership::default()),
            config: Arc::new(DomainConfig {
                daily_refresh_secrets: vec!["test-cron".to_string()],
                game_ingest_secret: Some("test-game".to_string()),
                webhook_base_url: "https://api.pokoin.com".to_string(),
            }),
        }
    }

    /// `cardTraderWebhookUrlForUid` using the configured base.
    pub fn webhook_url_for_uid(&self, uid: &str) -> String {
        let clean = crate::error::clean_text(Some(uid), 160);
        if clean.is_empty() {
            return String::new();
        }
        format!(
            "{}/api/cardtrader-webhook/{}",
            self.config.webhook_base_url,
            crate::crypto::uri_encode(&clean, true)
        )
    }

    /// Enqueue the background CardTrader reconcile for a verified seller.
    pub async fn enqueue_cardtrader_sync(&self, uid: &str) -> crate::error::ApiResult<(bool, bool)> {
        crate::cardtrader::async_sync::enqueue_with_stored_token(
            &self.sync_jobs,
            self.firestore.clone(),
            self.db.clone(),
            self.cardtrader.clone(),
            uid,
        )
        .await
    }

    /// Integration doc + decrypted token, mapping "not connected" to the
    /// documented `cardtrader_not_connected` code.
    pub async fn require_cardtrader_token(&self, uid: &str) -> crate::error::ApiResult<String> {
        crate::cardtrader::integration::decrypt_integration_token(self.firestore.as_ref(), uid)
            .await
            .map_err(|mut error| {
                if error.status == 404 {
                    error.code = Some("cardtrader_not_connected".into());
                    error.message = "CardTrader is not connected for this seller.".into();
                }
                error
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_url_shape() {
        let state = DomainState::for_test();
        assert_eq!(
            state.webhook_url_for_uid("abc 123"),
            "https://api.pokoin.com/api/cardtrader-webhook/abc%20123"
        );
        assert_eq!(state.webhook_url_for_uid(""), "");
    }

    #[test]
    fn memory_store_is_not_durable() {
        let state = DomainState::for_test();
        assert!(!state.is_durable(), "test state must not look production-durable");
        let error = state.require_durable_firestore().unwrap_err();
        assert_eq!(error.status, 503);
        assert_eq!(error.code.as_deref(), Some("firestore_not_configured"));
    }

    #[test]
    fn admin_secret_is_constant_time_and_exact() {
        let state = DomainState::for_test();
        assert!(state.config.secret_matches("test-cron"));
        assert!(!state.config.secret_matches("test-cro"));
        assert!(!state.config.secret_matches(""));
        assert!(state.config.game_secret_matches("test-game"));
        assert!(!state.config.game_secret_matches("nope"));
    }
}
