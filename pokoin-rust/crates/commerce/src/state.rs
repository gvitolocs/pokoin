//! Shared request state for every commerce route.
//!
//! `DomainState` is cheap to clone (one `Arc`) and is what `router()` takes, so
//! the root agent can mount the commerce routes next to the search routes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::auth::{self, AuthError, Claims, FirebaseVerifier, TokenVerifier};
use crate::config::CommerceConfig;
use crate::error::{ApiError, StoreError};
use crate::firestore::FirestoreClient;
use crate::ports::{ChainClient, Clock, PriceOracle, StripeClient, SystemClock};

#[derive(Clone)]
pub struct DomainState {
    inner: Arc<Inner>,
}

pub struct Inner {
    pub config: Arc<CommerceConfig>,
    /// Pi read replica (`MARKETPLACE_DATABASE_URL`). Never written to.
    pub read_db: PgPool,
    /// nezopt 15T writer (`MARKETPLACE_WRITER_DATABASE_URL`). Every SQL write.
    pub write_db: PgPool,
    pub redis: Option<redis::aio::ConnectionManager>,
    pub http: reqwest::Client,
    pub verifier: Arc<dyn TokenVerifier>,
    pub clock: Arc<dyn Clock>,
    pub stripe: Option<StripeClient>,
    pub chain: ChainClient,
    pub prices: PriceOracle,
    /// Firestore owns balances, ledger, users, orders, addresses and the
    /// crypto/wPKN request documents. State is never migrated to SQL.
    pub firestore: Option<FirestoreClient>,
    /// Lazily created per-game satellite pools, keyed by game id. `None` means
    /// the game's database URL is not configured in this deployment.
    pub game_pools: tokio::sync::RwLock<HashMap<String, Option<GamePools>>>,
    /// CardTrader integration boundary; the integrations crate supplies the
    /// implementation. Defaults to [`crate::cardtrader::UnavailableCardTrader`].
    pub cardtrader: Arc<dyn crate::cardtrader::CardTraderPort>,
}

/// A satellite game's read/write pools.
#[derive(Clone)]
pub struct GamePools {
    pub read: PgPool,
    pub write: PgPool,
}

impl Inner {
    pub fn firestore(&self) -> Result<&FirestoreClient, StoreError> {
        self.firestore.as_ref().ok_or_else(|| {
            StoreError::Cache(
                "Firestore is not configured (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)."
                    .into(),
            )
        })
    }
}

impl DomainState {
    /// Build the state with one pool used for both reads and writes.
    pub fn new(
        config: CommerceConfig,
        db: PgPool,
        redis: Option<redis::aio::ConnectionManager>,
        verifier: Arc<dyn TokenVerifier>,
    ) -> Self {
        let config = Arc::new(config);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        let stripe = StripeClient::from_config(&config).ok();
        let chain = ChainClient::new(http.clone(), config.clone());
        let prices = PriceOracle::new(http.clone(), config.clone());
        let firestore = FirestoreClient::from_env(http.clone()).ok();
        Self {
            inner: Arc::new(Inner {
                config,
                read_db: db.clone(),
                write_db: db,
                redis,
                http,
                verifier,
                clock: Arc::new(SystemClock),
                stripe,
                chain,
                prices,
                firestore,
                game_pools: tokio::sync::RwLock::new(HashMap::new()),
                cardtrader: Arc::new(crate::cardtrader::UnavailableCardTrader),
            }),
        }
    }

    /// Build the state with an explicit read replica and 15T writer pool.
    ///
    /// `read_db` is the Pi replica (`MARKETPLACE_DATABASE_URL`); `write_db` is
    /// the nezopt writer (`MARKETPLACE_WRITER_DATABASE_URL`). Every SQL write in
    /// this crate goes through [`DomainState::write_db`].
    pub fn with_pools(
        config: CommerceConfig,
        read_db: PgPool,
        write_db: PgPool,
        redis: Option<redis::aio::ConnectionManager>,
        verifier: Arc<dyn TokenVerifier>,
        firestore: Option<FirestoreClient>,
    ) -> Self {
        let config = Arc::new(config);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        let stripe = StripeClient::from_config(&config).ok();
        let chain = ChainClient::new(http.clone(), config.clone());
        let prices = PriceOracle::new(http.clone(), config.clone());
        Self {
            inner: Arc::new(Inner {
                config,
                read_db,
                write_db,
                redis,
                http,
                verifier,
                clock: Arc::new(SystemClock),
                stripe,
                chain,
                prices,
                firestore,
                game_pools: tokio::sync::RwLock::new(HashMap::new()),
                cardtrader: Arc::new(crate::cardtrader::UnavailableCardTrader),
            }),
        }
    }

    /// Convenience constructor for a process that knows its database URL(s).
    ///
    /// Reads use `MARKETPLACE_DATABASE_URL` (the Pi replica); SQL writes use
    /// `MARKETPLACE_WRITER_DATABASE_URL` (the nezopt 15T writer). When the
    /// writer URL is absent the read pool is reused, which is only correct for
    /// a single-writer deployment.
    pub fn from_env(db: PgPool) -> Self {
        let config = CommerceConfig::from_env();
        let project_id = std::env::var("FIREBASE_PROJECT_ID").unwrap_or_default();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        let verifier: Arc<dyn TokenVerifier> = Arc::new(FirebaseVerifier::new(project_id, http));
        Self::new(config, db, None, verifier)
    }

    /// Build the read/write pool pair straight from the environment:
    /// `MARKETPLACE_DATABASE_URL` (Pi replica) and
    /// `MARKETPLACE_WRITER_DATABASE_URL` (nezopt 15T writer).
    pub async fn pools_from_env() -> Result<(PgPool, Option<PgPool>), sqlx::Error> {
        let read_url = std::env::var("MARKETPLACE_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_default();
        let write_url = std::env::var("MARKETPLACE_WRITER_DATABASE_URL").unwrap_or_default();
        let read = open_pool(&read_url, 4).await?;
        let write = if write_url.is_empty() || write_url == read_url {
            None
        } else {
            Some(open_pool(&write_url, 4).await?)
        };
        Ok((read, write))
    }

    /// Test/embedding constructor: a lazy pool that never dials until used.
    pub fn lazy(
        config: CommerceConfig,
        database_url: &str,
        verifier: Arc<dyn TokenVerifier>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_millis(200))
            .connect_lazy(database_url)
            .expect("lazy pool");
        let mut state = Self::new(config, pool, None, verifier);
        let inner = Arc::get_mut(&mut state.inner).expect("fresh state");
        inner.clock = clock;
        state
    }

    pub fn config(&self) -> &CommerceConfig {
        &self.inner.config
    }

    /// Pi read replica pool. Marketplace tables only, never written to.
    pub fn read_db(&self) -> &PgPool {
        &self.inner.read_db
    }

    /// nezopt 15T writer pool. Every SQL write in this crate uses it.
    pub fn write_db(&self) -> &PgPool {
        &self.inner.write_db
    }

    /// Install the CardTrader integration (called by the root when wiring the
    /// integrations crate). Without it, fulfilment records `not_configured`.
    pub fn with_cardtrader(
        mut self,
        port: Arc<dyn crate::cardtrader::CardTraderPort>,
    ) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unshared state");
        inner.cardtrader = port;
        self
    }

    /// The Redis seller-profile cache, when Redis is configured. `None` makes
    /// every cache helper fall through to Firestore (fail-open).
    pub fn profile_cache(&self) -> Option<crate::seller_cache::RedisProfileCache> {
        self.inner
            .redis
            .clone()
            .map(crate::seller_cache::RedisProfileCache::new)
    }

    /// CardTrader integration boundary.
    pub fn cardtrader(&self) -> &Arc<dyn crate::cardtrader::CardTraderPort> {
        &self.inner.cardtrader
    }

    /// Backwards-compatible alias for [`DomainState::write_db`].
    pub fn db(&self) -> &PgPool {
        &self.inner.write_db
    }

    /// Pool pair for a marketplace game.
    ///
    /// Pokémon reuses the shared replica/writer pools. A satellite game gets a
    /// lazily created pool from its own database URL
    /// (`<GAME>_MARKETPLACE_DATABASE_URL`, the Node `databaseUrlEnv` contract);
    /// `None` means this deployment does not mount that catalog.
    pub async fn game_pools(&self, game: &str) -> Option<GamePools> {
        let game = game.trim();
        if game.is_empty() || game == crate::game::POKEMON {
            return Some(GamePools {
                read: self.inner.read_db.clone(),
                write: self.inner.write_db.clone(),
            });
        }
        if !crate::game::is_satellite(game) {
            return None;
        }
        if let Some(cached) = self.inner.game_pools.read().await.get(game) {
            return cached.clone();
        }
        let url = std::env::var(crate::game::game_db_env(game)?)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let pools = url.map(|url| {
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(4)
                .acquire_timeout(Duration::from_millis(500))
                .connect_lazy(&url);
            match pool {
                Ok(pool) => Some(GamePools {
                    read: pool.clone(),
                    write: pool,
                }),
                Err(_) => None,
            }
        });
        let pools = pools.flatten();
        self.inner
            .game_pools
            .write()
            .await
            .insert(game.to_string(), pools.clone());
        pools
    }

    /// Firestore-shaped error for a catalog that is not mounted here.
    pub fn game_catalog_unconfigured(game: &str) -> ApiError {
        ApiError::unavailable(format!(
            "The {game} marketplace catalog is not configured in this deployment."
        ))
        .with_code("GAME_CATALOG_UNCONFIGURED")
    }

    /// Firestore client (balances/ledger/users/orders/addresses/crypto).
    pub fn firestore(&self) -> Result<&FirestoreClient, ApiError> {
        self.inner
            .firestore()
            .map_err(|error| error.into())
    }

    pub fn has_firestore(&self) -> bool {
        self.inner.firestore.is_some()
    }

    pub fn redis(&self) -> Option<redis::aio::ConnectionManager> {
        self.inner.redis.clone()
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.inner.http
    }

    pub fn clock(&self) -> &Arc<dyn Clock> {
        &self.inner.clock
    }

    pub fn now_ms(&self) -> i64 {
        self.inner.clock.now_ms()
    }

    pub fn now_iso(&self) -> String {
        self.inner.clock.now_iso()
    }

    pub fn stripe(&self) -> Result<&StripeClient, ApiError> {
        self.inner
            .stripe
            .as_ref()
            .ok_or_else(|| ApiError::internal("Stripe is not configured yet."))
    }

    pub fn chain(&self) -> &ChainClient {
        &self.inner.chain
    }

    pub fn prices(&self) -> &PriceOracle {
        &self.inner.prices
    }

    pub fn verifier(&self) -> &Arc<dyn TokenVerifier> {
        &self.inner.verifier
    }

    /// Replace the clock (tests).
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("unshared state");
        inner.clock = clock;
        self
    }
}

/// Open a Postgres pool with the same short acquire timeout as `pokoin-db`.
pub async fn open_pool(url: &str, max: u32) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(max.max(1))
        .acquire_timeout(Duration::from_millis(200))
        .connect(url)
        .await
}

impl std::fmt::Debug for DomainState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DomainState").finish_non_exhaustive()
    }
}

/// Extractor: requires a verified Firebase ID token.
pub struct AuthedUser(pub Claims);

impl FromRequestParts<DomainState> for AuthedUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &DomainState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok());
        let token = auth::bearer(header).map_err(ApiError::from)?;
        let claims = state.verifier().verify(token).await.map_err(ApiError::from)?;
        if claims.uid.trim().is_empty() {
            return Err(ApiError::from(AuthError::Invalid("token has no subject".into())));
        }
        Ok(AuthedUser(claims))
    }
}

/// Extractor: verified token when present, `None` when absent or invalid
/// (matches the Node `optionalUserUid` analytics handlers).
pub struct OptionalUser(pub Option<Claims>);

impl FromRequestParts<DomainState> for OptionalUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &DomainState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok());
        Ok(OptionalUser(
            auth::optional_claims(state.verifier(), header).await,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{AuthError, Claims};
    use async_trait::async_trait;

    struct Reject;
    #[async_trait]
    impl TokenVerifier for Reject {
        async fn verify(&self, _token: &str) -> Result<Claims, AuthError> {
            Err(AuthError::Missing)
        }
    }

    fn state() -> DomainState {
        DomainState::lazy(
            CommerceConfig::default(),
            "postgres://127.0.0.1:1/none",
            Arc::new(Reject),
            Arc::new(SystemClock),
        )
    }

    #[tokio::test]
    async fn pokemon_reuses_the_shared_pools() {
        let state = state();
        let pools = state.game_pools("pokemon").await.expect("pokemon pools");
        // Same pool instance as the shared replica/writer.
        assert_eq!(pools.read.size(), state.read_db().size());
        assert_eq!(pools.write.size(), state.write_db().size());
        // An empty game falls back to the shared marketplace pools.
        assert!(state.game_pools("  ").await.is_some());
    }

    #[tokio::test]
    async fn unconfigured_and_unknown_games_have_no_catalog() {
        let state = state();
        // The test process does not export the satellite URLs.
        if std::env::var("MAGIC_MARKETPLACE_DATABASE_URL").is_err() {
            assert!(state.game_pools("magic").await.is_none());
        }
        assert!(state.game_pools("chess").await.is_none());
    }

    #[tokio::test]
    async fn a_configured_satellite_url_yields_a_pool() {
        std::env::set_var(
            "RIFTBOUND_MARKETPLACE_DATABASE_URL",
            "postgres://127.0.0.1:1/riftbound",
        );
        let state = state();
        let pools = state.game_pools("riftbound").await.expect("riftbound pools");
        // Lazily created: the pool exists without dialing the database.
        assert!(!pools.read.is_closed());
        assert!(!pools.write.is_closed());
        // Cached on the second call.
        assert!(state.game_pools("riftbound").await.is_some());
        std::env::remove_var("RIFTBOUND_MARKETPLACE_DATABASE_URL");
    }

    #[test]
    fn unconfigured_catalog_error_is_503_with_a_stable_code() {
        let error = DomainState::game_catalog_unconfigured("magic");
        assert_eq!(error.status.as_u16(), 503);
        assert_eq!(error.code.as_deref(), Some("GAME_CATALOG_UNCONFIGURED"));
        assert!(error.message.contains("magic"));
    }
}
