mod search_page;
mod suggest;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use pokoin_auth::bearer_token;
use pokoin_config::Config;
use pokoin_listings::{DecrementOutcome, DECREMENT_SQL};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

#[derive(Clone)]
struct AppState {
    config: Config,
    db: Arc<RwLock<Option<PgPool>>>,
    http: reqwest::Client,
    redis: Arc<RwLock<Option<redis::aio::ConnectionManager>>>,
    requests: Arc<AtomicU64>,
    meili_ms: Arc<AtomicU64>,
    sql_ms: Arc<AtomicU64>,
    errors: Arc<AtomicU64>,
    booted: Instant,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let booted = Instant::now();
    tracing::info!(phase = "process", elapsed_ms = 0, "startup");
    let config = Config::from_env();
    tracing::info!(
        phase = "config",
        elapsed_ms = elapsed_ms(booted),
        "startup"
    );
    let state = AppState {
        config: config.clone(),
        db: Arc::new(RwLock::new(None)),
        http: reqwest::Client::builder()
            .timeout(Duration::from_millis(800))
            .build()?,
        redis: Arc::new(RwLock::new(None)),
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
    let app = Router::new()
        .route("/livez", get(livez))
        .route("/readyz", get(readyz))
        .route("/health", get(readyz))
        .route("/metrics", get(metrics))
        .route(
            "/api/marketplace-suggest",
            get(suggest::suggest).options(suggest::options),
        )
        .route("/api/marketplace-card-page", get(card_page))
        .route(
            "/api/marketplace-search-page",
            get(search_page::search_page).options(search_page::options),
        )
        .route(
            "/api/marketplace-listings",
            get(listings_probe).post(listings_write),
        )
        .layer(tower::limit::ConcurrencyLimitLayer::new(64))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    tracing::info!(
        phase = "bind",
        bind = %config.bind,
        elapsed_ms = elapsed_ms(booted),
        "startup"
    );
    axum::serve(listener, app)
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

async fn livez() -> Json<Value> {
    Json(json!({
        "ok": true,
        "live": true,
        "service": "pokoin-rust",
    }))
}

async fn readyz(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
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
        if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE },
        Json(json!({
            "ok": ok,
            "ready": ok,
            "service": "pokoin-rust",
            "db": db,
            "redis": redis_ok,
            "search": state.config.search_engine,
            "retired": ["meili", "valkey"],
        })),
    )
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

#[derive(Deserialize)]
struct CardQuery {
    #[serde(rename = "cardId")]
    card_id: Option<String>,
    lang: Option<String>,
}

async fn card_page(Query(q): Query<CardQuery>) -> Json<Value> {
    let card_id = q.card_id.unwrap_or_default();
    let lang = q.lang.unwrap_or_else(|| "en".into());
    let key = pokoin_marketplace::card_cache_key("pokemon", &card_id, &lang);
    Json(json!({
        "card": { "id": card_id },
        "lookup": { "cardId": card_id, "lang": lang },
        "cacheKey": key,
        "source": "rust-miss",
    }))
}

async fn listings_probe() -> Json<Value> {
    Json(json!({ "listings": [], "source": "rust" }))
}

async fn listings_write(headers: HeaderMap) -> (StatusCode, Json<Value>) {
    if bearer_token(headers.get("authorization").and_then(|v| v.to_str().ok())).is_err() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "bearer token required" })),
        );
    }
    let _sql = DECREMENT_SQL;
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "Quantity must be a positive integer." })),
    )
}

impl AppState {
    fn count_request(&self) {
        self.requests.fetch_add(1, Ordering::Relaxed);
    }
}

#[allow(dead_code)]
fn _outcome() -> u16 {
    DecrementOutcome::Invalid.http_status()
}
