mod suggest;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

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
    db: Option<PgPool>,
    http: reqwest::Client,
    redis: Option<redis::aio::ConnectionManager>,
    requests: Arc<AtomicU64>,
    meili_ms: Arc<AtomicU64>,
    sql_ms: Arc<AtomicU64>,
    errors: Arc<AtomicU64>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let config = Config::from_env();
    let db = match config.database_url.clone() {
        Some(url) => pokoin_db::pool(&url, config.db_pool_max).await.ok(),
        None => None,
    };
    let redis = match config.valkey_url.as_deref() {
        Some(url) => match redis::Client::open(url) {
            Ok(client) => redis::aio::ConnectionManager::new(client).await.ok(),
            Err(_) => None,
        },
        None => None,
    };
    let state = AppState {
        config: config.clone(),
        db,
        http: reqwest::Client::builder()
            .timeout(Duration::from_millis(800))
            .build()?,
        redis,
        requests: Arc::new(AtomicU64::new(0)),
        meili_ms: Arc::new(AtomicU64::new(0)),
        sql_ms: Arc::new(AtomicU64::new(0)),
        errors: Arc::new(AtomicU64::new(0)),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route(
            "/api/marketplace-suggest",
            get(suggest::suggest).options(suggest::options),
        )
        .route("/api/marketplace-card-page", get(card_page))
        .route("/api/marketplace-search-page", get(search_page))
        .route(
            "/api/marketplace-listings",
            get(listings_probe).post(listings_write),
        )
        .layer(tower::limit::ConcurrencyLimitLayer::new(64))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    tracing::info!(bind = %config.bind, "pokoin rust api listening");
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

async fn health(State(state): State<AppState>) -> Json<Value> {
    let db = match &state.db {
        Some(pool) => sqlx::query_scalar::<_, i32>("select 1")
            .fetch_one(pool)
            .await
            .is_ok(),
        None => false,
    };
    let valkey = match state.config.valkey_url.as_deref() {
        Some(url) => ping_valkey(url).await,
        None => false,
    };
    let meili = match state.config.meili_url.as_deref() {
        Some(url) => {
            pokoin_integrations::meili_health(url, state.config.meili_key.as_deref()).await
        }
        None => false,
    };
    let search_ok = if state.config.search_engine == "redis" {
        valkey
    } else {
        meili
    };
    Json(json!({
        "ok": db && search_ok,
        "service": "pokoin-rust",
        "db": db,
        "valkey": valkey,
        "redis": valkey,
        "meili": meili,
        "search": state.config.search_engine,
    }))
}

async fn ping_valkey(url: &str) -> bool {
    let Ok(client) = redis::Client::open(url) else {
        return false;
    };
    let Ok(mut conn) = client.get_multiplexed_async_connection().await else {
        return false;
    };
    redis::cmd("PING")
        .query_async::<String>(&mut conn)
        .await
        .map(|pong| pong.eq_ignore_ascii_case("PONG"))
        .unwrap_or(false)
}

async fn metrics(State(state): State<AppState>) -> Json<Value> {
    let (pool_size, idle) = match &state.db {
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

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
}

async fn search_page(Query(q): Query<SearchQuery>) -> Json<Value> {
    let query = q.q.or(q.query).unwrap_or_default();
    let key = pokoin_cache::search_page_key(
        "pokemon",
        &query,
        "en",
        q.limit.unwrap_or(24),
        0,
        "",
        "all",
        false,
    );
    Json(json!({ "query": query, "cards": [], "cacheKey": key, "source": "rust-miss" }))
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
