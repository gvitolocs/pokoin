mod body_validation;
mod card_identity;
mod ct_deals;
mod jobs;
mod lists;
mod catalog_api;
mod rails;
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
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("job") {
        // `pokoin-api job <name> [--dry-run] [--since=...]`: one-shot timer job,
        // no listeners; a failure exits non-zero for systemd.
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
            )
            .init();
        let name = args.get(2).cloned().unwrap_or_default();
        let result = if name == "build-lists" {
            build_lists(&args[3.min(args.len())..]).await
        } else {
            jobs::run(&name).await
        };
        if let Err(error) = result {
            tracing::error!(job = %name, error = %format!("{error:#}"), "job failed");
            std::process::exit(1);
        }
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
    let state = new_state(config.clone(), booted)?;
    let warm = state.clone();
    tokio::spawn(async move {
        warm_dependencies(warm).await;
    });
    let app = build_full_router(state.clone()).await;
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    let (stop, stopping) = tokio::sync::watch::channel(false);
    let mut servers = tokio::task::JoinSet::new();
    spawn_edge_listeners(app.clone(), &mut servers, &stopping).await?;
    tracing::info!(
        phase = "bind",
        bind = %config.bind,
        elapsed_ms = elapsed_ms(booted),
        "startup"
    );
    servers.spawn(serve_listener("api", listener, app, stopping));
    shutdown_signal().await;
    tracing::info!("shutdown");
    let _ = stop.send(true);
    // Every listener stops accepting and finishes its in-flight requests, but an
    // open stream or a stuck request must not hold the stop until systemd's
    // TimeoutStopSec SIGKILL.
    if !drain(&mut servers, SHUTDOWN_DRAIN).await {
        tracing::warn!(
            listeners = servers.len(),
            drain_s = SHUTDOWN_DRAIN.as_secs(),
            "shutdown drain deadline passed; dropping open connections"
        );
    }
    // Returning would drop the runtime, which waits for every blocking-pool task
    // (a CDN read on a stalled disk) without a deadline.
    std::process::exit(0);
}

/// How long a stop waits for in-flight requests (the unit's TimeoutStopSec is 20 s).
const SHUTDOWN_DRAIN: Duration = Duration::from_secs(10);

/// Wait up to `deadline` for every listener to finish its graceful stop;
/// `false` when some are still open.
async fn drain(servers: &mut tokio::task::JoinSet<()>, deadline: Duration) -> bool {
    tokio::time::timeout(deadline, async { while servers.join_next().await.is_some() {} })
        .await
        .is_ok()
}

/// SIGTERM (systemd stop) or Ctrl-C.
async fn shutdown_signal() {
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
}

/// Serve until `stopping` turns true, then drain gracefully. A listener that
/// fails is fatal, so health can never claim a cutover a dead port cannot serve.
async fn serve_listener(
    name: &'static str,
    listener: tokio::net::TcpListener,
    app: Router,
    mut stopping: tokio::sync::watch::Receiver<bool>,
) {
    let stop = async move {
        let _ = stopping.wait_for(|stop| *stop).await;
    };
    if let Err(error) = axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(stop)
        .await
    {
        tracing::error!(listener = name, %error, "required listener stopped");
        std::process::exit(1);
    }
}

fn new_state(config: Config, booted: Instant) -> anyhow::Result<AppState> {
    Ok(AppState {
        config,
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
    })
}

/// `pokoin-api job build-lists ...`: the list builder calls the full API
/// router in-process, so it needs the server state with its pools connected.
async fn build_lists(args: &[String]) -> anyhow::Result<()> {
    let mut config = Config::from_env();
    // A batch job, not a server: few connections per game database.
    config.db_pool_max = config.db_pool_max.min(3);
    let state = new_state(config, Instant::now())?;
    if let Some(url) = state.config.database_url.clone() {
        *state.db.write().await = Some(pokoin_db::pool(&url, state.config.db_pool_max).await?);
    }
    if let Some(url) = state.config.valkey_url.clone() {
        if let Ok(Ok(conn)) = tokio::time::timeout(Duration::from_secs(3), connect_redis(&url)).await {
            *state.redis.write().await = Some(conn);
        }
    }
    let app = build_full_router(state.clone()).await;
    lists::build(app, state, args).await
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
        .route(
            "/api/marketplace-home/new-cards",
            get(rails::new_cards).options(rails::options),
        )
        .route(
            "/api/marketplace-home/best-sellers",
            get(rails::best_sellers).options(rails::options),
        )
        .route(
            "/api/marketplace-home/spotlight",
            get(rails::spotlight).options(rails::options),
        )
        .route("/api/marketplace-list", get(lists::list).options(rails::options))
        .route("/api/marketplace-daily-medians", get(lists::daily_medians).options(rails::options))
        .route("/api/client-error", axum::routing::post(request_log::client_error).options(rails::options))
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
        .unwrap_or(12)
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
                    // Paid-order fulfilment drives CardTrader inline like Node's
                    // webhook; without credentials the steps stay retryable.
                    let commerce_state = match pokoin_commerce::cardtrader_adapter::NativeCardTrader::from_env() {
                        Ok(adapter) => commerce_state.with_cardtrader(Arc::new(adapter)),
                        Err(error) => {
                            tracing::warn!(error = %error.message, "CardTrader fulfilment adapter not configured");
                            commerce_state
                        }
                    };
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

    let security_api = api_state.as_ref().ok().cloned();
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

    let core = router(state.clone());
    let mut inner = core
        .merge(routes)
        .merge(accounts)
        .merge(commerce)
        .merge(external)
        .merge(system::router(state.clone()))
        .fallback(system::fallback)
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
        // A panicking handler answers 500 (logged with its path) instead of
        // unwinding the connection task.
        .layer(axum::middleware::from_fn(pokoin_api_common::panic::catch_panic))
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
async fn spawn_edge_listeners(api: Router, servers: &mut tokio::task::JoinSet<()>, stopping: &tokio::sync::watch::Receiver<bool>) -> anyhow::Result<()> {
    let env=|key:&str|std::env::var(key).ok().filter(|v|!v.trim().is_empty());
    let edge_bind=env("POKOIN_EDGE_BIND");let cdn_bind=env("POKOIN_CDN_BIND");
    // Bind every requested listener before announcing startup. A failed edge/CDN
    // must fail the service, so health can never claim a successful cutover.
    let mut listeners=Vec::new();
    if edge_bind.is_some()||cdn_bind.is_some(){
        let cdn=pokoin_edge::Cdn::start(pokoin_edge::CdnConfig::from_env()).await;
        if let Some(bind)=cdn_bind{let listener=tokio::net::TcpListener::bind(&bind).await?;listeners.push(("cdn",bind,listener,cdn.router()));}
        if let Some(bind)=edge_bind{let listener=tokio::net::TcpListener::bind(&bind).await?;let edge=pokoin_edge::edge_router(pokoin_edge::EdgeConfig::from_env(),api.clone(),cdn.router());listeners.push(("edge",bind,listener,edge));}
    }
    if let Some(bind)=env("POKOIN_CT_DEALS_BIND"){
        let listener=tokio::net::TcpListener::bind(&bind).await?;listeners.push(("ct-deals",bind,listener,ct_deals::router(api)));
    }
    for (name,bind,listener,app) in listeners{
        tracing::info!(phase="bind",listener=name,%bind,"startup");
        servers.spawn(serve_listener(name,listener,app,stopping.clone()));
    }
    Ok(())
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn get_over(stream: &mut tokio::net::TcpStream, path: &str) {
        let request = format!("GET {path} HTTP/1.1\r\nhost: test\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
    }

    /// Start `app` on an ephemeral port under `serve_listener`.
    async fn listen(app: Router) -> (std::net::SocketAddr, tokio::sync::watch::Sender<bool>, tokio::task::JoinSet<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopping) = tokio::sync::watch::channel(false);
        let mut servers = tokio::task::JoinSet::new();
        servers.spawn(serve_listener("test", listener, app, stopping));
        (addr, stop, servers)
    }

    #[tokio::test]
    async fn stop_drains_idle_connections_and_bounds_hung_requests() {
        let app = || {
            Router::new()
                .route("/ok", get(|| async { "ok" }))
                .route("/hang", get(|| std::future::pending::<&'static str>()))
        };
        // An idle keep-alive connection does not hold the stop.
        let (addr, stop, mut servers) = listen(app()).await;
        let mut idle = tokio::net::TcpStream::connect(addr).await.unwrap();
        get_over(&mut idle, "/ok").await;
        let mut buf = [0u8; 64];
        let n = idle.read(&mut buf).await.unwrap();
        assert!(buf[..n].starts_with(b"HTTP/1.1 200"));
        stop.send(true).unwrap();
        assert!(drain(&mut servers, Duration::from_secs(5)).await);
        // A request stuck in its handler would hold it forever; the deadline ends the wait.
        let (addr, stop, mut servers) = listen(app()).await;
        let mut hung = tokio::net::TcpStream::connect(addr).await.unwrap();
        get_over(&mut hung, "/hang").await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        stop.send(true).unwrap();
        let started = Instant::now();
        assert!(!drain(&mut servers, Duration::from_millis(300)).await);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

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
