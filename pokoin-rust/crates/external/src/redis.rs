//! Redis helpers: the cross-instance reconcile lock and the best-effort
//! fixed-window rate limiter. Both mirror `_cardtrader_inventory_async.js`
//! and `_rate_limit.js` — degrade to "allow / no lock" when Redis is down.

use std::time::Duration;

use crate::error::ApiResult;

/// `lockKey` from `_redis_ns.js` — `pokoin:lock:v1:{scope}:{id}`.
pub fn lock_key(scope: &str, id: &str) -> String {
    format!("pokoin:lock:v1:{}:{}", scope, id)
}

/// Namespace for shared counters (`_redis_ns.js` marketplaceKey).
pub fn marketplace_key(parts: &[&str]) -> String {
    let mut key = String::from("pokoin:marketplace:v1:");
    key.push_str(&parts.join(":"));
    key
}

#[derive(Clone)]
pub struct RedisCache {
    client: redis::Client,
}

/// Lock handle: empty owner means "degraded" (Redis down) — the caller
/// proceeds on the in-process guard only, like the Node code.
pub struct Lock {
    pub key: String,
    pub owner: String,
}

impl RedisCache {
    pub fn from_env() -> Option<Self> {
        let host = std::env::var("REDIS_HOST").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "127.0.0.1".into());
        let port = std::env::var("REDIS_PORT")
            .or_else(|_| std::env::var("POKOIN_REDIS_PORT"))
            .ok()
            .and_then(|v| v.trim().parse::<u16>().ok())
            .unwrap_or(6380);
        let url = format!("redis://{host}:{port}");
        redis::Client::open(url).ok().map(|client| Self { client })
    }

    pub async fn ping(&self) -> bool {
        let mut connection = match self.client.get_connection_manager().await {
            Ok(connection) => connection,
            Err(_) => return false,
        };
        let pong: Result<String, _> = redis::cmd("PING").query_async(&mut connection).await;
        matches!(pong, Ok(value) if value == "PONG")
    }

    /// `acquireLock(key, owner, ttl)` — SET key owner NX EX ttl.
    pub async fn acquire_lock(&self, key: &str, owner: &str, ttl_sec: u64) -> ApiResult<bool> {
        let mut connection = self
            .client
            .get_connection_manager()
            .await
            .map_err(|e| crate::error::ApiError::new(500, e.to_string()))?;
        let result: Result<bool, _> = redis::cmd("SET")
            .arg(key)
            .arg(owner)
            .arg("NX")
            .arg("EX")
            .arg(ttl_sec)
            .query_async(&mut connection)
            .await;
        Ok(result.unwrap_or(false))
    }

    /// Owner-checked release (Lua compare-and-delete).
    pub async fn release_lock(&self, key: &str, owner: &str) {
        let Ok(mut connection) = self.client.get_connection_manager().await else {
            return;
        };
        let script = redis::Script::new(
            r#"if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end"#,
        );
        let _: Result<i64, _> = script
            .key(key)
            .arg(owner)
            .invoke_async(&mut connection)
            .await;
    }

    /// Fixed-window counter used by `limitBestEffort` (image-log POST).
    /// Returns the hit count for this window (incrementing first).
    pub async fn bump_window(&self, scope: &str, identity: &str, limit: u64, window_seconds: u64) -> u64 {
        let Ok(mut connection) = self.client.get_connection_manager().await else {
            return 0;
        };
        let key = marketplace_key(&["ratelimit", scope, identity]);
        let window = crate::time_util::now_ms() as u64 / (window_seconds * 1000);
        let key = format!("{key}:{window}");
        let count: Result<i64, _> = redis::Script::new("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n")
            .key(&key)
            .arg(window_seconds)
            .invoke_async(&mut connection)
            .await;
        // Redis down or error → 0 means "unknown, allow" (best effort).
        match count {
            Ok(hits) if hits as u64 > limit => hits as u64,
            _ => 0,
        }
    }

    /// GET/SET passthrough for the L2 live-listings cache.
    pub async fn get_json(&self, key: &str) -> Option<serde_json::Value> {
        let mut connection = self.client.get_connection_manager().await.ok()?;
        let raw: Result<Option<String>, _> = redis::cmd("GET").arg(key).query_async(&mut connection).await;
        raw.ok()?.and_then(|text| serde_json::from_str(&text).ok())
    }

    pub async fn set_json(&self, key: &str, value: &serde_json::Value, ttl: Duration) {
        let Ok(mut connection) = self.client.get_connection_manager().await else {
            return;
        };
        let payload = value.to_string();
        let _: Result<(), _> = redis::cmd("SETEX")
            .arg(key)
            .arg(ttl.as_secs())
            .arg(payload)
            .query_async(&mut connection)
            .await;
    }

    /// Atomic GET+DELETE for cache takeout.
    pub async fn take_json(&self, key: &str) -> Option<serde_json::Value> {
        let mut connection = self.client.get_connection_manager().await.ok()?;
        let script = redis::Script::new(r#"local v = redis.call("GET", KEYS[1]); if v then redis.call("DEL", KEYS[1]) end; return v"#);
        let raw: Result<Option<String>, _> = script.key(key).invoke_async(&mut connection).await;
        raw.ok()?.and_then(|text| serde_json::from_str(&text).ok())
    }

    /// LRU-ish bounded cache for the in-process L1 of live listings: the Rust
    /// port keeps an L1 map with the same 60 s TTL as the Redis L2 so the two
    /// layers can never disagree about freshness.
    pub async fn del(&self, key: &str) {
        let Ok(mut connection) = self.client.get_connection_manager().await else {
            return;
        };
        let _: Result<(), _> = redis::cmd("DEL").arg(key).query_async(&mut connection).await;
    }
}
