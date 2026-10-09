use std::{collections::HashMap, sync::Arc, time::Duration};

use sqlx::{postgres::PgPoolOptions, PgPool};
use tokio::sync::{Mutex, RwLock};

use crate::game;

/// Cheap to clone; one `Arc` inside.
#[derive(Clone)]
pub struct ApiState {
    inner: Arc<Inner>,
}

struct Inner {
    read: PgPool,
    write: PgPool,
    http: reqwest::Client,
    redis_url: Option<String>,
    redis: Mutex<Option<redis::aio::ConnectionManager>>,
    game_pools: RwLock<HashMap<String, PgPool>>,
    pool_max: u32,
}

/// A pool that connects on first use, so startup never blocks on Postgres.
pub fn lazy_pool(url: &str, max: u32) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(max.max(1))
        .acquire_timeout(Duration::from_secs(3))
        .connect_lazy(url)
}

fn env_first(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

impl ApiState {
    pub fn new(read: PgPool, write: PgPool, redis_url: Option<String>, pool_max: u32) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            inner: Arc::new(Inner {
                read,
                write,
                http,
                redis_url,
                redis: Mutex::new(None),
                game_pools: RwLock::new(HashMap::new()),
                pool_max: pool_max.max(1),
            }),
        }
    }

    /// Replica = `MARKETPLACE_DATABASE_URL` (or `DATABASE_URL`); writer =
    /// `MARKETPLACE_WRITER_DATABASE_URL`, else the replica URL. Redis follows
    /// `pokoin_config::Config` (VALKEY_URL/REDIS_URL, else REDIS_HOST:REDIS_PORT).
    pub fn from_env() -> Result<Self, String> {
        let pool_max = std::env::var("POKOIN_RUST_DOMAIN_DB_POOL_MAX")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(6);
        let read_url = env_first(&["MARKETPLACE_DATABASE_URL", "DATABASE_URL"])
            .ok_or_else(|| "MARKETPLACE_DATABASE_URL is not set".to_owned())?;
        let write_url = env_first(&["MARKETPLACE_WRITER_DATABASE_URL"]).unwrap_or_else(|| read_url.clone());
        let read = lazy_pool(&read_url, pool_max).map_err(|e| e.to_string())?;
        let write = lazy_pool(&write_url, pool_max).map_err(|e| e.to_string())?;
        let redis_url = pokoin_config::Config::from_env().valkey_url;
        Ok(Self::new(read, write, redis_url, pool_max))
    }

    /// Replica pool (reads only).
    pub fn read(&self) -> &PgPool {
        &self.inner.read
    }

    /// Writer pool (every SQL write).
    pub fn write(&self) -> &PgPool {
        &self.inner.write
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.inner.http
    }

    /// Shared Redis connection; `None` when Redis is unconfigured or down
    /// (callers fail open exactly like the Node `_redis_cache` helpers).
    pub async fn redis(&self) -> Option<redis::aio::ConnectionManager> {
        let mut slot = self.inner.redis.lock().await;
        if let Some(conn) = slot.as_ref() {
            return Some(conn.clone());
        }
        let url = self.inner.redis_url.as_deref()?;
        let client = redis::Client::open(url).ok()?;
        let config = redis::aio::ConnectionManagerConfig::new()
            .set_response_timeout(Duration::from_millis(500))
            .set_connection_timeout(Duration::from_millis(500));
        match tokio::time::timeout(
            Duration::from_secs(1),
            redis::aio::ConnectionManager::new_with_config(client, config),
        )
        .await
        {
            Ok(Ok(conn)) => {
                *slot = Some(conn.clone());
                Some(conn)
            }
            Ok(Err(error)) => {
                tracing::warn!(%error, "redis connect failed");
                None
            }
            Err(_) => {
                tracing::warn!("redis connect timed out");
                None
            }
        }
    }

    /// Catalog pool for a resolved game id (`pokemon` is the replica). Other
    /// games use `databaseUrlForGame` semantics from `_marketplace_game.js`.
    pub async fn game_pool(&self, game_id: &str) -> Option<PgPool> {
        if game::is_pokemon_game(game_id) {
            return Some(self.read().clone());
        }
        if let Some(pool) = self.inner.game_pools.read().await.get(game_id).cloned() {
            return Some(pool);
        }
        let url = game::database_url_for_game(game_id, &game::env_pairs());
        if url.trim().is_empty() {
            return None;
        }
        let pool = lazy_pool(&url, self.inner.pool_max).ok()?;
        let mut pools = self.inner.game_pools.write().await;
        Some(pools.entry(game_id.to_owned()).or_insert(pool).clone())
    }
}
