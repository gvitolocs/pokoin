//! The cloneable state every accounts route receives.
//!
//! `DomainState` is one `Arc`, so cloning it per request is free. It holds the
//! transport, the token verifier, and the optional Firebase/Firestore/Supabase/
//! email/rate-limit clients. Optional clients are `Option`s on purpose: a
//! missing credential must produce a truthful error from the one route that
//! needs it, never a panic at boot and never a fake success.

use std::sync::Arc;
use std::time::Duration;

use sqlx::postgres::{PgConnectOptions, PgSslMode};

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

/// Which database URL backs the Card Rails one-time codes: the writer URL
/// when set, else the read URL for single-database deployments. Inputs may be
/// raw env values; empty/whitespace counts as unset. `None` when neither is
/// configured (the store then reports "not configured" truthfully).
fn cardrails_database_url(writer_url: Option<&str>, read_url: Option<&str>) -> Option<String> {
    writer_url
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .or_else(|| read_url.map(str::trim).filter(|url| !url.is_empty()))
        .map(str::to_owned)
}

/// TLS mode for the writer pool, mirroring `external::game_ingest`'s handling
/// of the marketplace SSL envs: `MARKETPLACE_WRITER_DATABASE_SSL=0` (or
/// `sslmode=disable` in the URL) disables TLS,
/// `MARKETPLACE_WRITER_DATABASE_SSL_VERIFY=1` verifies the server certificate,
/// everything else still encrypts (`Require`).
fn writer_ssl_mode(ssl: Option<&str>, ssl_verify: Option<&str>, url: &str) -> PgSslMode {
    if ssl == Some("0") || url.to_ascii_lowercase().contains("sslmode=disable") {
        PgSslMode::Disable
    } else if ssl_verify == Some("1") {
        PgSslMode::VerifyFull
    } else {
        PgSslMode::Require
    }
}

/// Connect options for `MARKETPLACE_WRITER_DATABASE_URL` with the writer TLS
/// envs applied (see [`writer_ssl_mode`]).
fn writer_connect_options(url: &str) -> Result<PgConnectOptions, sqlx::Error> {
    let options: PgConnectOptions = url.parse()?;
    let ssl = std::env::var("MARKETPLACE_WRITER_DATABASE_SSL").ok();
    let ssl_verify = std::env::var("MARKETPLACE_WRITER_DATABASE_SSL_VERIFY").ok();
    Ok(options.ssl_mode(writer_ssl_mode(
        ssl.as_deref(),
        ssl_verify.as_deref(),
        url,
    )))
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
    /// Writer pool for the Card Rails one-time codes
    /// (`MARKETPLACE_WRITER_DATABASE_URL`). The Pi read pool is a hot standby
    /// where every INSERT fails read-only, and a code minted milliseconds
    /// earlier must be readable back, so these routes never share the read
    /// pool. `None` (no writer URL) falls back to `marketplace_db` — only
    /// correct when both URLs point at one writable database.
    pub marketplace_writer_db: Option<MarketplaceDb>,
    /// The chat/listing user-photos bucket (separate env from forum media).
    pub photo_store: Option<R2MediaStore>,
    /// Card Rails one-time sign-in codes. `None` resolves to the Postgres
    /// store over the marketplace writer database; tests inject the
    /// in-memory store.
    pub cardrails_store: Option<Arc<dyn crate::domain::cardrails::CardRailsCodeStore>>,
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
        let read_url = std::env::var("MARKETPLACE_DATABASE_URL")
            .ok()
            .or_else(|| std::env::var("DATABASE_URL").ok())
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty());
        let marketplace_db = read_url.clone().and_then(|url| {
            match MarketplaceDb::connect_lazy(&url, 4) {
                Ok(db) => Some(db),
                Err(error) => {
                    tracing::error!(%error, "marketplace read model pool could not be created");
                    None
                }
            }
        });
        let writer_url = std::env::var("MARKETPLACE_WRITER_DATABASE_URL")
            .ok()
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty());
        // The Card Rails codes are INSERTed and consumed within seconds, and
        // the read URL on the Pi is a hot standby: the pick is the writer URL
        // when set, else the read URL (single-database deployments). Pure and
        // unit-tested at the bottom of this file.
        let cardrails_url = cardrails_database_url(writer_url.as_deref(), read_url.as_deref());
        // Only the writer pick gets its own small pool, with the writer TLS
        // envs applied; the read-URL pick leaves `marketplace_writer_db`
        // empty so `cardrails_store()` reuses the existing read pool instead
        // of a second pool at the same address.
        let marketplace_writer_db = if writer_url.is_some() {
            cardrails_url.and_then(|url| match writer_connect_options(&url) {
                Ok(options) => Some(MarketplaceDb::connect_lazy_with(options, 2)),
                Err(error) => {
                    tracing::error!(%error, "marketplace writer pool could not be created");
                    None
                }
            })
        } else {
            None
        };
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
                marketplace_writer_db,
                photo_store,
                cardrails_store: None,
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

    /// The Card Rails one-time code store: an injected store (tests), else the
    /// Postgres store over the writer pool (`MARKETPLACE_WRITER_DATABASE_URL`).
    /// Both the insert and the consume go to the writer — the codes are read
    /// back milliseconds after they are minted, so replication lag on the
    /// read pool would fail live codes, and the standby cannot take the
    /// INSERT/DELETE at all. Falls back to the read-model pool only when no
    /// writer URL is configured (single writable database).
    pub fn cardrails_store(
        &self,
    ) -> crate::error::Result<Arc<dyn crate::domain::cardrails::CardRailsCodeStore>> {
        if let Some(store) = self.inner.cardrails_store.as_ref() {
            return Ok(store.clone());
        }
        let db = match self.inner.marketplace_writer_db.clone() {
            Some(db) => db,
            None => self.marketplace_db()?,
        };
        Ok(Arc::new(
            crate::domain::cardrails::PostgresCardRailsCodeStore::new(db),
        ))
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

    pub fn with_cardrails_store(
        mut self,
        cardrails_store: Option<Arc<dyn crate::domain::cardrails::CardRailsCodeStore>>,
    ) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unique state");
        inner.cardrails_store = cardrails_store;
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

    #[test]
    fn cardrails_codes_pick_the_writer_url_when_set_and_the_read_url_when_not() {
        assert_eq!(
            cardrails_database_url(Some("postgres://writer/db"), Some("postgres://replica/db")),
            Some("postgres://writer/db".to_string()),
            "the writer URL wins when it is set"
        );
        assert_eq!(
            cardrails_database_url(None, Some("postgres://replica/db")),
            Some("postgres://replica/db".to_string()),
            "no writer URL falls back to the read URL"
        );
        // An empty or whitespace writer URL counts as unset, too.
        assert_eq!(
            cardrails_database_url(Some("   "), Some("postgres://replica/db")),
            Some("postgres://replica/db".to_string())
        );
        // Neither configured: the store reports that truthfully.
        assert_eq!(cardrails_database_url(None, None), None);
        assert_eq!(cardrails_database_url(Some(""), Some("")), None);
    }

    #[test]
    fn writer_tls_envs_pick_the_ssl_mode() {
        // Production (k3s) exports SSL=1 + SSL_VERIFY=1: verify the server cert.
        assert!(matches!(
            writer_ssl_mode(Some("1"), Some("1"), "postgres://writer/db"),
            PgSslMode::VerifyFull
        ));
        // SSL_VERIFY=1 alone still verifies; unset envs keep encrypting.
        assert!(matches!(
            writer_ssl_mode(None, Some("1"), "postgres://writer/db"),
            PgSslMode::VerifyFull
        ));
        assert!(matches!(
            writer_ssl_mode(None, None, "postgres://writer/db"),
            PgSslMode::Require
        ));
        // SSL=0 turns TLS off; an sslmode=disable URL does the same even when
        // the verify flag is set.
        assert!(matches!(
            writer_ssl_mode(Some("0"), Some("1"), "postgres://writer/db"),
            PgSslMode::Disable
        ));
        assert!(matches!(
            writer_ssl_mode(None, Some("1"), "postgres://writer/db?sslmode=disable"),
            PgSslMode::Disable
        ));
    }
}
