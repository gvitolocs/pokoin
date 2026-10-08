//! Best-effort rate limiting.
//!
//! Node used `limitBestEffort({ scope, identity, limit, windowSeconds })`:
//! a Redis fixed-window counter that always allows the request when the store
//! is unavailable, because rate limiting must never take a route down. The
//! same contract is kept here behind [`RateLimiter`], with a Redis
//! implementation and an explicit allow-all used when Redis is not configured.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use redis::AsyncCommands;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimitVerdict {
    pub allowed: bool,
    pub retry_after_sec: Option<u64>,
    pub remaining: Option<i64>,
}

impl RateLimitVerdict {
    pub fn allowed() -> Self {
        Self {
            allowed: true,
            retry_after_sec: None,
            remaining: None,
        }
    }

    pub fn denied(retry_after_sec: u64) -> Self {
        Self {
            allowed: false,
            retry_after_sec: Some(retry_after_sec),
            remaining: Some(0),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RateLimitRequest<'a> {
    pub scope: &'a str,
    pub identity: &'a str,
    pub limit: i64,
    pub window_seconds: u64,
}

#[async_trait]
pub trait RateLimiter: Send + Sync + 'static {
    async fn check(&self, request: RateLimitRequest<'_>) -> RateLimitVerdict;
}

/// Used when Redis is not configured: `limitBestEffort` semantics, always allow.
pub struct AllowAllRateLimiter;

#[async_trait]
impl RateLimiter for AllowAllRateLimiter {
    async fn check(&self, _request: RateLimitRequest<'_>) -> RateLimitVerdict {
        RateLimitVerdict::allowed()
    }
}

/// Redis fixed-window limiter (`INCR` + `EXPIRE`, key includes the window).
pub struct RedisRateLimiter {
    client: redis::Client,
}

impl RedisRateLimiter {
    pub fn new(url: &str) -> Result<Self, redis::RedisError> {
        Ok(Self {
            client: redis::Client::open(url)?,
        })
    }
}

fn window_key(scope: &str, identity: &str, window_seconds: u64) -> (String, u64) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let window = now / window_seconds.max(1);
    let reset_in = window_seconds.max(1) - (now % window_seconds.max(1));
    (
        format!("pokoin:ratelimit:{scope}:{identity}:{window}"),
        reset_in,
    )
}

#[async_trait]
impl RateLimiter for RedisRateLimiter {
    async fn check(&self, request: RateLimitRequest<'_>) -> RateLimitVerdict {
        // Best effort: any Redis problem allows the request.
        let Ok(connection) = self.client.get_multiplexed_async_connection().await else {
            return RateLimitVerdict::allowed();
        };
        let mut connection = connection;
        let (key, reset_in) = window_key(
            request.scope,
            request.identity,
            request.window_seconds,
        );
        let count: Result<i64, _> = connection.incr(&key, 1).await;
        let Ok(count) = count else {
            return RateLimitVerdict::allowed();
        };
        if count == 1 {
            let _: Result<(), _> = connection.expire(&key, reset_in as i64).await;
        }
        if count > request.limit {
            RateLimitVerdict::denied(reset_in)
        } else {
            RateLimitVerdict {
                allowed: true,
                retry_after_sec: None,
                remaining: Some((request.limit - count).max(0)),
            }
        }
    }
}

/// Build the limiter from an optional Redis/Valkey URL.
pub fn from_url(url: Option<&str>) -> Arc<dyn RateLimiter> {
    match url.filter(|url| !url.is_empty()) {
        Some(url) => match RedisRateLimiter::new(url) {
            Ok(limiter) => Arc::new(limiter),
            Err(error) => {
                tracing::warn!(%error, "rate limiter falling back to allow-all");
                Arc::new(AllowAllRateLimiter)
            }
        },
        None => Arc::new(AllowAllRateLimiter),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn allow_all_allows_everything() {
        let limiter = AllowAllRateLimiter;
        let verdict = limiter
            .check(RateLimitRequest {
                scope: "news-comments",
                identity: "uid1",
                limit: 5,
                window_seconds: 600,
            })
            .await;
        assert!(verdict.allowed);
        assert_eq!(verdict.retry_after_sec, None);
    }

    #[test]
    fn window_key_is_stable_inside_a_window() {
        let (key, reset) = window_key("news-comments", "uid1", 600);
        assert!(key.starts_with("pokoin:ratelimit:news-comments:uid1:"));
        assert!((1..=600).contains(&reset));
        let (again, _) = window_key("news-comments", "uid1", 600);
        assert_eq!(key, again);
        // A different identity is a different bucket.
        let (other, _) = window_key("news-comments", "uid2", 600);
        assert_ne!(key, other);
    }

    #[test]
    fn denied_verdict_carries_retry_after() {
        let verdict = RateLimitVerdict::denied(120);
        assert!(!verdict.allowed);
        assert_eq!(verdict.retry_after_sec, Some(120));
        assert_eq!(verdict.remaining, Some(0));
    }

    #[test]
    fn from_url_without_a_url_is_allow_all() {
        let limiter = from_url(None);
        // The trait object has no downcast, so verify behaviour instead.
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let verdict = runtime.block_on(limiter.check(RateLimitRequest {
            scope: "s",
            identity: "i",
            limit: 1,
            window_seconds: 60,
        }));
        assert!(verdict.allowed);
    }
}
