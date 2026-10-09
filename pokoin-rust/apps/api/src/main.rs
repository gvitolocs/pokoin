mod body_validation;
mod card_identity;
mod catalog_api;
mod read_cache;
mod request_log;
mod search_page;
mod suggest;
mod system;
mod visual_theme;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{any, get};
use axum::{Json, Router};
use pokoin_config::Config;
use serde_json::{json, Value};
use sqlx::PgPool;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) config: Config,
    pub(crate) commerce: Arc<RwLock<Option<pokoin_commerce::DomainState>>>,
    pub(crate) db: Arc<RwLock<Option<PgPool>>>,
    pub(crate) http: reqwest::Client,
    pub(crate) game_dbs: Arc<RwLock<std::collections::HashMap<String, PgPool>>>,
    pub(crate) redis: Arc<RwLock<Option<redis::aio::ConnectionManager>>>,
    pub(crate) read_cache: Arc<read_cache::Coordinator>,
    pub(crate) requests: Arc<AtomicU64>,
    pub(crate) meili_ms: Arc<AtomicU64>,
    pub(crate) sql_ms: Arc<AtomicU64>,
    pub(crate) errors: Arc<AtomicU64>,
    pub(crate) booted: Instant,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|s| s == "--version") {
        println!(
            "{}",
            json!({"service":"pokoin-rust","commit":env!("POKOIN_BUILD_COMMIT"),"dirty":env!("POKOIN_BUILD_DIRTY")=="true"})
        );
        return Ok(());
    }
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let booted = Instant::now();
    tracing::info!(phase = "process", elapsed_ms = 0, "startup");
    let config = Config::from_env();
    tracing::info!(phase = "config", elapsed_ms = elapsed_ms(booted), "startup");
    let state = AppState {
        config: config.clone(),
        commerce: Arc::new(RwLock::new(None)),
        db: Arc::new(RwLock::new(None)),
        game_dbs: Arc::new(RwLock::new(std::collections::HashMap::new())),
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?,
        redis: Arc::new(RwLock::new(None)),
        read_cache: Arc::new(read_cache::Coordinator::default()),
        requests: Arc::new(AtomicU64::new(0)),
        meili_ms: Arc::new(AtomicU64::new(0)),
        sql_ms: Arc::new(AtomicU64::new(0)),
        errors: Arc::new(AtomicU64::new(0)),
        booted,
    };
    let warm = state.clone();
    tokio::spawn(async move {
        warm_dependencies(warm).await;
    });
    let app = build_full_router(state.clone()).await;
    spawn_edge_listeners(app.clone()).await;
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    tracing::info!(
        phase = "bind",
        bind = %config.bind,
        elapsed_ms = elapsed_ms(booted),
        "startup"
    );
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(async {
            let ctrl_c = tokio::signal::ctrl_c();
            #[cfg(unix)]
            {
                let mut terminate =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("install SIGTERM handler");
                tokio::select! {
                    _ = ctrl_c => {}
                    _ = terminate.recv() => {}
                }
            }
            #[cfg(not(unix))]
            {
                let _ = ctrl_c.await;
            }
            tracing::info!("shutdown");
        })
        .await?;
    Ok(())
}

fn elapsed_ms(booted: Instant) -> u64 {
    booted.elapsed().as_millis() as u64
}

async fn warm_dependencies(state: AppState) {
    loop {
        if state.db.read().await.is_none() {
            if let Some(url) = state.config.database_url.clone() {
                match tokio::time::timeout(
                    Duration::from_secs(2),
                    pokoin_db::pool(&url, state.config.db_pool_max),
                )
                .await
                {
                    Ok(Ok(pool)) => {
                        *state.db.write().await = Some(pool);
                        tracing::info!(
                            phase = "postgres",
                            elapsed_ms = elapsed_ms(state.booted),
                            "startup"
                        );
                    }
                    Ok(Err(error)) => {
                        tracing::warn!(phase = "postgres", %error, "startup");
                    }
                    Err(_) => {
                        tracing::warn!(phase = "postgres", error = "timeout", "startup");
                    }
                }
            }
        }
        if state.redis.read().await.is_none() {
            if let Some(url) = state.config.valkey_url.clone() {
                match tokio::time::timeout(Duration::from_secs(2), connect_redis(&url)).await {
                    Ok(Ok(conn)) => {
                        *state.redis.write().await = Some(conn);
                        tracing::info!(
                            phase = "redis",
                            elapsed_ms = elapsed_ms(state.booted),
                            "startup"
                        );
                    }
                    Ok(Err(error)) => {
                        tracing::warn!(phase = "redis", %error, "startup");
                    }
                    Err(_) => {
                        tracing::warn!(phase = "redis", error = "timeout", "startup");
                    }
                }
            }
        }
        let ready = state.db.read().await.is_some() && state.redis.read().await.is_some();
        if ready {
            tracing::info!(
                phase = "ready",
                elapsed_ms = elapsed_ms(state.booted),
                "startup"
            );
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn connect_redis(url: &str) -> Result<redis::aio::ConnectionManager, redis::RedisError> {
    let client = redis::Client::open(url)?;
    let config = redis::aio::ConnectionManagerConfig::new()
        .set_number_of_retries(1)
        .set_connection_timeout(Duration::from_millis(500));
    redis::aio::ConnectionManager::new_with_config(client, config).await
}

async fn metrics(State(state): State<AppState>) -> Json<Value> {
    let (pool_size, idle) = match state.db.read().await.as_ref() {
        Some(pool) => (pool.size(), pool.num_idle() as u32),
        None => (0, 0),
    };
    Json(json!({
        "requests": state.requests.load(Ordering::Relaxed),
        "errors": state.errors.load(Ordering::Relaxed),
        "meiliMsTotal": state.meili_ms.load(Ordering::Relaxed),
        "sqlMsTotal": state.sql_ms.load(Ordering::Relaxed),
        "dbPoolSize": pool_size,
        "dbPoolIdle": idle,
        "dbPoolMax": state.config.db_pool_max,
    }))
}

async fn health(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    let db = match state.db.read().await.clone() {
        Some(pool) => sqlx::query_scalar::<_, i32>("select 1")
            .fetch_one(&pool)
            .await
            .is_ok(),
        None => false,
    };
    let redis_ok = match state.redis.read().await.clone() {
        Some(mut conn) => redis::cmd("PING")
            .query_async::<String>(&mut conn)
            .await
            .map(|pong| pong.eq_ignore_ascii_case("PONG"))
            .unwrap_or(false),
        None => false,
    };
    let ok = db && redis_ok;
    (
        if ok {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({
            "ok": ok,
            "ready": ok,
            "service": "pokoin-rust",
            "db": db,
            "redis": redis_ok,
            "search": state.config.search_engine,
            "release": state.config.release,
            "retired": ["meili", "valkey"],
        })),
    )
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route(
            "/api/marketplace-suggest",
            get(suggest::suggest).options(suggest::options),
        )
        .route(
            "/api/marketplace-card-page",
            get(catalog_api::card_page).options(search_page::options),
        )
        .route(
            "/api/marketplace-card-tiles",
            get(catalog_api::card_tiles).options(search_page::options),
        )
        .route(
            "/api/marketplace-search-page",
            get(search_page::search_page).options(search_page::options),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            read_cache::read_cache,
        ))
        .layer(axum::middleware::from_fn(card_identity::guard))
        .layer(tower::limit::ConcurrencyLimitLayer::new(64))
        .with_state(state)
}

async fn build_full_router(state: AppState) -> Router {
    let pool_max = std::env::var("POKOIN_RUST_DOMAIN_DB_POOL_MAX")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(6)
        .max(1);
    let read_url = std::env::var("MARKETPLACE_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()
        .filter(|value| !value.trim().is_empty());

    // One shared runtime for the route crates; accounts counts its limits in the
    // global store like Node's limitGlobal.
    let api_state = pokoin_api_common::ApiState::from_env();
    let mut accounts_state = pokoin_accounts::DomainState::from_env();
    if let Ok(api) = &api_state {
        accounts_state = accounts_state.with_limiter(Arc::new(pokoin_api_common::limits::GlobalRateLimiter::new(api.clone())));
    }
    let accounts = pokoin_accounts::router(accounts_state.clone());
    let commerce_redis = match state.config.valkey_url.as_deref() {
        Some(url) => tokio::time::timeout(Duration::from_secs(2), connect_redis(url)).await.ok().and_then(Result::ok),
        None => None,
    };
    let (commerce, external) = match read_url {
        Some(read_url) => {
            let write_url = std::env::var("MARKETPLACE_WRITER_DATABASE_URL")
                .unwrap_or_else(|_| read_url.clone());
            match (
                lazy_pool(&read_url, pool_max),
                lazy_pool(&write_url, pool_max),
            ) {
                (Ok(read_db), Ok(write_db)) => {
                    let commerce_state = pokoin_commerce::DomainState::with_pools(
                            pokoin_commerce::CommerceConfig::from_env(),
                            read_db.clone(),
                            write_db.clone(),
                            commerce_redis,
                            Arc::new(pokoin_commerce::FirebaseVerifier::new(
                                std::env::var("FIREBASE_PROJECT_ID").unwrap_or_default(),
                                reqwest::Client::new(),
                            )),
                            pokoin_commerce::FirestoreClient::from_env(reqwest::Client::new()).ok(),
                        );
                    *state.commerce.write().await = Some(commerce_state.clone());
                    let commerce = pokoin_commerce::router(commerce_state);
                    let external = match build_external_router(&read_db, &write_db) {
                        Ok(router) => router,
                        Err(error) => {
                            tracing::error!(domain = "external", %error, "domain disabled");
                            external_fallback_router()
                        }
                    };
                    (commerce, external)
                }
                (Err(error), _) | (_, Err(error)) => {
                    tracing::error!(domain = "commerce", %error, "domain disabled");
                    (commerce_fallback_router(), external_fallback_router())
                }
            }
        }
        None => {
            let error = "MARKETPLACE_DATABASE_URL is not configured";
            tracing::error!(domain = "commerce", %error, "domain disabled");
            (commerce_fallback_router(), external_fallback_router())
        }
    };

    let routes = match api_state.map(|api| pokoin_api_common::RouteState::new(api, accounts_state)) {
        Ok(route_state) => Router::new()
            .merge(pokoin_catalog_api::router(route_state.clone()))
            .merge(pokoin_search_api::router(route_state.clone()))
            .merge(pokoin_admin_api::router(route_state.clone()))
            .merge(pokoin_assistant_api::router(route_state)),
        Err(error) => {
            tracing::error!(domain = "routes", %error, "domain disabled");
            Router::new()
        }
    };

    let security_api = pokoin_api_common::ApiState::from_env().ok();
    let core = router(state.clone());
    let mut inner = core
        .merge(routes)
        .merge(accounts)
        .merge(commerce)
        .merge(external)
        .merge(system::router(state.clone()))
        .fallback(system::not_found)
        .layer(axum::extract::DefaultBodyLimit::max(
            pokoin_api_common::http::JSON_LIMIT_BYTES,
        ))
        .layer(axum::middleware::from_fn(
            pokoin_api_common::public_error::sanitize_layer,
        ));
    inner = inner.layer(axum::middleware::from_fn(body_validation::validate));
    // _http_security.prepareRequest + _route_limits: trusted client IP, preflight,
    // the authoritative CORS pass and the global route limits wrap every route.
    if let Some(api) = security_api {
        inner = inner.layer(axum::middleware::from_fn_with_state(api, security_middleware));
    }
    // Node normalised the path (trailing slash, `/api/x.js`, `:params` -> query)
    // before routing, so the normaliser wraps the whole router.
    let normalized = tower::Layer::layer(&axum::middleware::from_fn(system::normalize_request), inner);
    Router::new()
        .fallback_service(normalized)
        .layer(axum::middleware::from_fn_with_state(state, request_log::log_request))
}

async fn security_middleware(
    State(api): State<pokoin_api_common::ApiState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    pokoin_api_common::security::security_layer(api, req, next).await
}

/// The public edge (api.pokoin.com origin, `POKOIN_EDGE_BIND`, Pi :18079) and the
/// disk CDN (cdn.pokoin.com origin, `POKOIN_CDN_BIND`, Pi :18081). Both are off
/// unless their bind variable is set, so the binary can run beside the Node edge.
async fn spawn_edge_listeners(api: Router) {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let (edge_bind, cdn_bind) = (env("POKOIN_EDGE_BIND"), env("POKOIN_CDN_BIND"));
    if edge_bind.is_none() && cdn_bind.is_none() {
        return;
    }
    let cdn = pokoin_edge::Cdn::start(pokoin_edge::CdnConfig::from_env()).await;
    if let Some(bind) = cdn_bind {
        match tokio::net::TcpListener::bind(&bind).await {
            Ok(listener) => {
                tracing::info!(phase = "bind", listener = "cdn", %bind, "startup");
                let app = cdn.router();
                tokio::spawn(async move {
                    if let Err(error) = axum::serve(listener, app).await {
                        tracing::error!(%error, "cdn listener stopped");
                    }
                });
            }
            Err(error) => tracing::error!(%error, %bind, "cdn bind failed"),
        }
    }
    if let Some(bind) = edge_bind {
        match tokio::net::TcpListener::bind(&bind).await {
            Ok(listener) => {
                tracing::info!(phase = "bind", listener = "edge", %bind, "startup");
                let app = pokoin_edge::edge_router(pokoin_edge::EdgeConfig::from_env(), api, cdn.router());
                tokio::spawn(async move {
                    let service = app.into_make_service_with_connect_info::<std::net::SocketAddr>();
                    if let Err(error) = axum::serve(listener, service).await {
                        tracing::error!(%error, "edge listener stopped");
                    }
                });
            }
            Err(error) => tracing::error!(%error, %bind, "edge bind failed"),
        }
    }
}

fn lazy_pool(url: &str, max: u32) -> anyhow::Result<PgPool> {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(max)
        .acquire_timeout(Duration::from_secs(3))
        .connect_lazy(url)
        .map_err(Into::into)
}

fn build_external_router(read_db: &PgPool, write_db: &PgPool) -> anyhow::Result<Router> {
    use pokoin_external::firebase::{
        FirebaseJwksVerifier, FirestoreRest, FirestoreStore, TokenVerifier,
    };
    let project_id = std::env::var("FIREBASE_PROJECT_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("FIREBASE_PROJECT_ID is not configured"))?;
    let firestore = FirestoreRest::from_env()
        .ok_or_else(|| anyhow::anyhow!("Firebase Admin credentials are not configured"))?;
    let db = pokoin_external::db::DbPools::lazy(read_db.clone(), write_db.clone());
    let state = pokoin_external::DomainState::new(
        Arc::new(firestore) as Arc<dyn FirestoreStore>,
        Arc::new(FirebaseJwksVerifier::new(project_id)) as Arc<dyn TokenVerifier>,
        db,
        None,
    );
    Ok(pokoin_external::router(state))
}

fn fallback_router(paths: &[&str]) -> Router {
    paths.iter().fold(Router::new(), |router, path| {
        router.route(path, any(domain_unavailable))
    })
}

fn external_fallback_router() -> Router {
    fallback_router(&[
        "/api/cardtrader-connect",
        "/api/cardtrader-status",
        "/api/cardtrader-disconnect",
        "/api/cardtrader-import-dry-run",
        "/api/cardtrader-sync",
        "/api/cardtrader-assets",
        "/api/cardtrader-zero",
        "/api/cardtrader-clean-listings",
        "/api/cardtrader-webhook/{uid}",
        "/api/cardtrader-blueprint-listings",
        "/api/cardtrader-live-listings",
        "/api/cardtrader-daily-listings-refresh",
        "/api/cardtrader-game-ingest",
        "/api/powertools-connect",
        "/api/marketplace-pricing-strategies",
        "/api/marketplace-price-check",
        "/api/scan/identify",
        "/api/scan/identify-album",
        "/api/scan/print",
        "/api/scan/catalogs",
        "/api/scan/health",
        "/api/scan-batch",
        "/api/scan-pair",
        "/api/scan-phone",
        "/api/scan-session",
        "/api/scan-stream",
        "/api/user-photos/{kind}/{uid}/{file}",
        "/api/upload-profile-picture",
        "/api/remove-profile-picture",
        "/api/cache-google-profile-picture",
        "/api/cardtrader-redirect",
        "/api/tcgplayer-redirect",
        "/api/cardmarket-redirect",
        "/api/social-autopost",
        "/api/social-autopost/hot-card",
        "/api/social-post-agent",
        "/api/client-country",
    ])
}

fn commerce_fallback_router() -> Router {
    fallback_router(&[
        "/api/marketplace-listings",
        "/api/marketplace-listings-csv",
        "/api/marketplace-cart",
        "/api/marketplace-watchlist",
        "/api/marketplace-cart-sync",
        "/api/marketplace-recents",
        "/api/marketplace-event",
        "/api/marketplace-seller-shop",
        "/api/marketplace-seller-settings",
        "/api/account-addresses",
        "/api/marketplace-shipping-options",
        "/api/marketplace-checkout-quote",
        "/api/marketplace-orders",
        "/api/marketplace-native-sales",
        "/api/stripe-connect-onboard",
        "/api/create-order-checkout-session",
        "/api/create-pkn-checkout-session",
        "/api/stripe-webhook",
        "/api/crypto-pkn-purchase/{action}",
        "/api/crypto-pkn-sale/{action}",
        "/api/wpkn-exchange/{action}",
        "/api/wpkn-pkn-quote",
        "/api/top-up-account-balance",
        "/api/transfer-account-balance",
        "/api/request-pkn-withdraw",
        "/api/unlock-silver",
        "/api/money-request",
        "/api/earn-pkn",
    ])
}

async fn domain_unavailable() -> axum::response::Response {
    let mut response = (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error": "Service temporarily unavailable."})),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn full_router_builds() {
        let read = lazy_pool("postgres://test@127.0.0.1:1/test", 6).unwrap();
        let write = lazy_pool("postgres://test@127.0.0.1:1/test", 6).unwrap();
        let commerce = pokoin_commerce::router(pokoin_commerce::DomainState::with_pools(
            pokoin_commerce::CommerceConfig::default(),
            read.clone(),
            write,
            None,
            Arc::new(pokoin_commerce::FirebaseVerifier::new(
                String::new(),
                reqwest::Client::new(),
            )),
            None,
        ));
        let external = pokoin_external::router(pokoin_external::DomainState::for_test());
        let _app = router(AppState {
            config: Config::from_env(),
            db: Arc::new(RwLock::new(None)),
            http: reqwest::Client::new(),
            game_dbs: Arc::new(RwLock::new(std::collections::HashMap::new())),
            redis: Arc::new(RwLock::new(None)),
            read_cache: Arc::new(read_cache::Coordinator::default()),
            commerce: Arc::new(RwLock::new(None)),
            requests: Arc::new(AtomicU64::new(0)),
            meili_ms: Arc::new(AtomicU64::new(0)),
            sql_ms: Arc::new(AtomicU64::new(0)),
            errors: Arc::new(AtomicU64::new(0)),
            booted: Instant::now(),
        })
        .merge(pokoin_accounts::router(
            pokoin_accounts::DomainState::default(),
        ))
        .merge(commerce)
        .merge(external)
        ;
    }
}
