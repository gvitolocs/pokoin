//! The cloneable state every accounts route receives.
//!
//! `DomainState` is one `Arc`, so cloning it per request is free. It holds the
//! transport, the token verifier, and the optional Firebase/Firestore/Supabase/
//! email/rate-limit clients. Optional clients are `Option`s on purpose: a
//! missing credential must produce a truthful error from the one route that
//! needs it, never a panic at boot and never a fake success.

use std::sync::Arc;
use std::time::Duration;

use crate::config::AccountsConfig;
use crate::email::{EmailConfig, EmailSender, NullEmailSender, ResendEmailSender};
use crate::firebase::{FirebaseVerifier, ServiceAccount, TokenVerifier};
use crate::firestore::Firestore;
use crate::http::{ReqwestTransport, RetryPolicy, SharedTransport};
use crate::identity::FirebaseAuth;
use crate::r2::{MediaStore, R2MediaStore, UnconfiguredMediaStore};
use crate::sql::MarketplaceDb;
use crate::rate_limit::{self, RateLimiter};
use crate::supabase::SupabaseClient;

/// Injectable clock, so expiry/cooldown logic is testable without sleeping.
pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> chrono::DateTime<chrono::Utc>;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
    }
}

#[derive(Clone)]
pub struct DomainState {
    inner: Arc<DomainStateInner>,
}

pub struct DomainStateInner {
    pub config: AccountsConfig,
    pub email_config: EmailConfig,
    pub transport: SharedTransport,
    pub verifier: Arc<dyn TokenVerifier>,
    pub service_account: Option<Arc<ServiceAccount>>,
    pub firestore: Option<Firestore>,
    pub auth: Option<FirebaseAuth>,
    pub supabase: Option<SupabaseClient>,
    pub emails: Arc<dyn EmailSender>,
    pub limiter: Arc<dyn RateLimiter>,
    pub clock: Arc<dyn Clock>,
    pub media_store: Option<Arc<dyn MediaStore>>,
    /// Postgres connection to the existing marketplace read model. `None` when
    /// no database URL is configured; the SQL-backed routes then report that
    /// truthfully instead of starting a broken half-state.
    pub marketplace_db: Option<MarketplaceDb>,
    /// The chat/listing user-photos bucket (separate env from forum media).
    pub photo_store: Option<R2MediaStore>,
}

impl DomainState {
    /// Production constructor: everything from the environment.
    ///
    /// Never panics. When `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` /
    /// `FIREBASE_PRIVATE_KEY` are absent, the Firebase-backed routes answer a
    /// truthful `500 Sign-in verification is not configured.` instead of
    /// starting in a broken half-state.
    pub fn from_env() -> Self {
        let config = AccountsConfig::from_env();
        let transport: SharedTransport =
            Arc::new(ReqwestTransport::new(config.http_timeout));
        Self::with_transport(config, transport)
    }

    /// Test/DI constructor: supply the config and an explicit transport.
    pub fn with_transport(config: AccountsConfig, transport: SharedTransport) -> Self {
        let verifier: Arc<dyn TokenVerifier> =
            Arc::new(FirebaseVerifier::new(&config, transport.clone()));

        let service_account = if config.has_service_account() {
            match ServiceAccount::new(&config, transport.clone()) {
                Ok(account) => Some(Arc::new(account)),
                Err(error) => {
                    tracing::error!(%error, "Firebase service account is unusable; Firestore routes will report it");
                    None
                }
            }
        } else {
            None
        };

        let firestore = service_account.as_ref().map(|account| {
            Firestore::new(
                &config,
                transport.clone(),
                account.clone(),
                RetryPolicy::default(),
            )
        });
        let auth = service_account.as_ref().map(|account| {
            FirebaseAuth::new(
                &config,
                transport.clone(),
                account.clone(),
                RetryPolicy::default(),
            )
        });

        let supabase = SupabaseClient::from_env(transport.clone());
        let media_store: Option<Arc<dyn MediaStore>> = R2MediaStore::from_env(transport.clone())
            .map(|store| Arc::new(store) as Arc<dyn MediaStore>);
        let photo_store = R2MediaStore::for_user_photos(transport.clone());
        let marketplace_db = std::env::var("MARKETPLACE_DATABASE_URL")
            .ok()
            .or_else(|| std::env::var("DATABASE_URL").ok())
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())
            .and_then(|url| match MarketplaceDb::connect_lazy(&url, 4) {
                Ok(db) => Some(db),
                Err(error) => {
                    tracing::error!(%error, "marketplace read model pool could not be created");
                    None
                }
            });
        let emails: Arc<dyn EmailSender> = Arc::new(ResendEmailSender::new(
            std::env::var("RESEND_API_KEY").ok(),
            transport.clone(),
        ));
        let valkey_url = std::env::var("VALKEY_URL")
            .ok()
            .or_else(|| std::env::var("REDIS_URL").ok());
        let limiter = rate_limit::from_url(valkey_url.as_deref());

        Self {
            inner: Arc::new(DomainStateInner {
                email_config: EmailConfig::from_env(),
                config,
                transport,
                verifier,
                service_account,
                firestore,
                auth,
                supabase,
                emails,
                limiter,
                clock: Arc::new(SystemClock),
                media_store,
                marketplace_db,
                photo_store,
            }),
        }
    }

    // -- accessors ---------------------------------------------------------

    pub fn config(&self) -> &AccountsConfig {
        &self.inner.config
    }

    pub fn email_config(&self) -> &EmailConfig {
        &self.inner.email_config
    }

    pub fn transport(&self) -> &SharedTransport {
        &self.inner.transport
    }

    pub fn verifier(&self) -> &Arc<dyn TokenVerifier> {
        &self.inner.verifier
    }

    pub fn emails(&self) -> &Arc<dyn EmailSender> {
        &self.inner.emails
    }

    pub fn limiter(&self) -> &Arc<dyn RateLimiter> {
        &self.inner.limiter
    }

    pub fn clock(&self) -> &Arc<dyn Clock> {
        &self.inner.clock
    }

    /// Cloudflare R2 media store, or `None` when it is not configured.
    pub fn media_store(&self) -> Option<Arc<dyn MediaStore>> {
        self.inner.media_store.clone()
    }

    /// The chat/listing user-photos bucket, or `None` when not configured.
    pub fn photo_store(&self) -> Option<R2MediaStore> {
        self.inner.photo_store.clone()
    }

    /// The marketplace read-model pool, or a truthful "not configured" error.
    pub fn marketplace_db(&self) -> crate::error::Result<MarketplaceDb> {
        self.inner.marketplace_db.clone().ok_or_else(|| {
            crate::error::ApiError::internal("Marketplace database is not configured.")
        })
    }

    pub fn service_account(&self) -> Option<&Arc<ServiceAccount>> {
        self.inner.service_account.as_ref()
    }

    /// Firestore, or a truthful "not configured" error.
    pub fn firestore(&self) -> Result<Firestore, crate::error::ApiError> {
        self.inner.firestore.clone().ok_or_else(|| {
            tracing::error!("Firestore requested but the Firebase service account is not configured");
            crate::error::ApiError::internal("Firestore is not configured.")
        })
    }

    /// Firebase Auth admin client, or a truthful "not configured" error.
    pub fn auth(&self) -> Result<FirebaseAuth, crate::error::ApiError> {
        self.inner.auth.clone().ok_or_else(|| {
            tracing::error!("Firebase Auth requested but the service account is not configured");
            crate::error::ApiError::internal("Firebase Auth is not configured.")
        })
    }

    /// Supabase PostgREST, or a truthful "not configured" error.
    pub fn supabase(&self) -> Result<SupabaseClient, crate::error::ApiError> {
        self.inner
            .supabase
            .clone()
            .ok_or_else(|| crate::error::ApiError::internal("Supabase is not configured."))
    }

    /// The secret used to encrypt pending-signup passwords, following the Node
    /// fallback order.
    pub fn pending_signup_secret(&self) -> Result<String, crate::error::ApiError> {
        crate::domain::pending_signup::resolve_secret(
            self.inner.config.pending_signup_key.as_deref(),
            Some(self.inner.config.private_key_pem.as_str()),
            std::env::var("RESEND_API_KEY").ok().as_deref(),
        )
    }

    // -- test/DI builders --------------------------------------------------

    pub fn with_verifier(mut self, verifier: Arc<dyn TokenVerifier>) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unique state");
        inner.verifier = verifier;
        self
    }

    pub fn with_firestore(mut self, firestore: Option<Firestore>) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unique state");
        inner.firestore = firestore;
        self
    }

    pub fn with_auth(mut self, auth: Option<FirebaseAuth>) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unique state");
        inner.auth = auth;
        self
    }

    pub fn with_supabase(mut self, supabase: Option<SupabaseClient>) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unique state");
        inner.supabase = supabase;
        self
    }

    pub fn with_emails(mut self, emails: Arc<dyn EmailSender>) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unique state");
        inner.emails = emails;
        self
    }

    pub fn with_limiter(mut self, limiter: Arc<dyn RateLimiter>) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unique state");
        inner.limiter = limiter;
        self
    }

    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unique state");
        inner.clock = clock;
        self
    }

    pub fn with_photo_store(mut self, photo_store: Option<R2MediaStore>) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unique state");
        inner.photo_store = photo_store;
        self
    }

    pub fn with_marketplace_db(mut self, marketplace_db: Option<MarketplaceDb>) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unique state");
        inner.marketplace_db = marketplace_db;
        self
    }

    pub fn with_media_store(mut self, media_store: Option<Arc<dyn MediaStore>>) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unique state");
        inner.media_store = media_store;
        self
    }

    pub fn with_email_config(mut self, email_config: EmailConfig) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unique state");
        inner.email_config = email_config;
        self
    }
}

impl Default for DomainState {
    fn default() -> Self {
        let config = AccountsConfig::default();
        let transport: SharedTransport = Arc::new(ReqwestTransport::new(Duration::from_secs(4)));
        // Default has no credentials at all: routes report that truthfully.
        let mut state = Self::with_transport(config, transport);
        {
            let inner = Arc::get_mut(&mut state.inner).expect("unique state");
            inner.emails = Arc::new(NullEmailSender);
            inner.media_store = Some(Arc::new(UnconfiguredMediaStore));
        }
        state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_state_is_cloneable_and_reports_missing_credentials() {
        let state = DomainState::default();
        let clone = state.clone();
        assert!(state.firestore().is_err());
        assert!(clone.auth().is_err());
        assert!(clone.supabase().is_err());
        assert!(clone.service_account().is_none());
        // The error is a truthful 500, not a fake success.
        match state.firestore() {
            Err(error) => {
                assert_eq!(error.status(), axum::http::StatusCode::INTERNAL_SERVER_ERROR);
                assert_eq!(error.message(), "Firestore is not configured.");
            }
            Ok(_) => panic!("an unconfigured state must not hand out a Firestore client"),
        }
    }

    #[test]
    fn default_email_sender_skips_instead_of_pretending() {
        let state = DomainState::default();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let delivery = runtime.block_on(state.emails().send(crate::email::EmailMessage {
            from: "a".into(),
            to: "b".into(),
            subject: "s".into(),
            html: String::new(),
            text: String::new(),
        }));
        let delivery = delivery.unwrap();
        assert!(!delivery.ok);
        assert!(delivery.skipped);
    }

    #[test]
    fn default_clock_is_utc_now() {
        let state = DomainState::default();
        let now = state.clock().now();
        let delta = (chrono::Utc::now() - now).num_seconds().abs();
        assert!(delta < 5);
    }
}
