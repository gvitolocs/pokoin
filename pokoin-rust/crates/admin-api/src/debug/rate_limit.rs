//! Port of `api/_rate_limit.js` — the best-effort class only, which is what
//! every route in this crate uses (`limitBestEffort`: shared Redis counter,
//! bounded in-process fixed window on Redis outage, fail-open by design).
//!
//! Keys follow `_redis_ns.js` / `_redis_cache.js`:
//! `pokoin:rl:v1:{scope}:{sha256(identity)[0:32]}`, incremented by the same
//! Lua script (`INCR` + `EXPIRE` on the first hit).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use pokoin_api_common::ApiState;

use super::truncate_utf16;

/// Bound on the local fallback table (~10k identities).
const LOCAL_MAX_IDENTITIES: usize = 10_000;

const INCR_WINDOW_SCRIPT: &str = r"
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
";

#[allow(dead_code)] // `backend`/`count`/`retry_after_sec` mirror the Node verdict shape
pub(crate) struct BestEffortVerdict {
    pub allowed: bool,
    pub backend: &'static str,
    pub count: i64,
    pub retry_after_sec: i64,
}

/// `cleanScope(scope)`.
pub(crate) fn clean_scope(scope: &str) -> String {
    let mapped: String = scope
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    // `/[^a-z0-9_-]+/g` collapses runs into a single dash.
    let mut cleaned = String::new();
    let mut last_was_dash = false;
    for ch in mapped.chars() {
        if ch == '-' && last_was_dash {
            continue;
        }
        last_was_dash = ch == '-';
        cleaned.push(ch);
    }
    let cleaned = truncate_utf16(&cleaned, 40);
    if cleaned.is_empty() {
        "scope".to_owned()
    } else {
        cleaned
    }
}

/// `identityHash(identity)`: first 32 hex chars of sha256.
pub(crate) fn identity_hash(identity: &str) -> String {
    let digest = Sha256::digest(identity.as_bytes());
    let hex = hex::encode(digest);
    hex[..32].to_owned()
}

/// `rateLimitBucket(scope, identity)` (`_redis_ns.rateLimitKey`).
pub(crate) fn rate_limit_bucket(scope: &str, identity: &str) -> String {
    format!(
        "pokoin:rl:v1:{}:{}",
        clean_scope(scope),
        identity_hash(identity)
    )
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}

// --- Bounded in-process fallback (Node `localWindows`) -----------------------

fn local_windows() -> &'static Mutex<HashMap<String, (i64, i64)>> {
    static WINDOWS: std::sync::OnceLock<Mutex<HashMap<String, (i64, i64)>>> =
        std::sync::OnceLock::new();
    WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn local_consume(bucket: &str, window_seconds: i64) -> i64 {
    let window_millis = window_seconds.max(1) as u128 * 1000;
    let window_start = (now_millis() / window_millis) as i64;
    let mut windows = match local_windows().lock() {
        Ok(windows) => windows,
        Err(poisoned) => poisoned.into_inner(),
    };
    let count = {
        let entry = windows.get(bucket);
        match entry {
            Some((start, count)) if *start == window_start => count + 1,
            _ => 1,
        }
    };
    windows.insert(bucket.to_owned(), (window_start, count));

    if windows.len() >= LOCAL_MAX_IDENTITIES {
        windows.retain(|_, (start, _)| *start >= window_start);
        while windows.len() >= LOCAL_MAX_IDENTITIES {
            let oldest = match windows.keys().next().cloned() {
                Some(key) => key,
                None => break,
            };
            windows.remove(&oldest);
        }
    }
    count
}

/// `limitBestEffort({ scope, identity, limit, windowSeconds })`: never fails;
/// a Redis outage degrades to the bounded local window.
pub(crate) async fn limit_best_effort(
    state: &ApiState,
    scope: &str,
    identity: &str,
    limit: i64,
    window_seconds: i64,
) -> BestEffortVerdict {
    let bucket = rate_limit_bucket(scope, identity);
    let window = window_seconds.max(1);
    let max = limit.max(1);

    if let Some(mut conn) = state.redis().await {
        let script = redis::Script::new(INCR_WINDOW_SCRIPT);
        let result: Result<Option<i64>, _> = script
            .key(&bucket)
            .arg(window.to_string())
            .invoke_async(&mut conn)
            .await;
        if let Ok(Some(count)) = result {
            return BestEffortVerdict {
                allowed: count <= max,
                backend: "redis",
                count,
                retry_after_sec: if count <= max { 0 } else { window },
            };
        }
    }

    let count = local_consume(&bucket, window);
    BestEffortVerdict {
        allowed: count <= max,
        backend: "local",
        count,
        retry_after_sec: if count <= max { 0 } else { window },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_scope_matches_node() {
        assert_eq!(clean_scope("Image Log"), "image-log");
        assert_eq!(clean_scope("  news-event "), "news-event");
        assert_eq!(clean_scope(""), "scope");
        assert_eq!(clean_scope("a/b//c"), "a-b-c");
        let long = clean_scope("0123456789012345678901234567890123456789");
        assert_eq!(long.len(), 40);
    }

    #[test]
    fn identity_hash_is_the_truncated_sha256() {
        let digest = Sha256::digest(b"203.0.113.9");
        assert_eq!(identity_hash("203.0.113.9"), &hex::encode(digest)[..32]);
        assert_eq!(identity_hash("").len(), 32);
    }

    #[test]
    fn bucket_uses_the_shared_namespace() {
        assert_eq!(
            rate_limit_bucket("image-log", "1.2.3.4"),
            format!("pokoin:rl:v1:image-log:{}", identity_hash("1.2.3.4"))
        );
    }

    #[tokio::test]
    async fn local_fallback_counts_and_allows_under_the_limit() {
        let state = ApiState::new(
            pokoin_api_common::state::lazy_pool("postgres://x@127.0.0.1:1/x", 1).unwrap(),
            pokoin_api_common::state::lazy_pool("postgres://x@127.0.0.1:1/x", 1).unwrap(),
            None,
            1,
        );
        let scope = format!("test-{}", std::process::id());
        let first = limit_best_effort(&state, &scope, "ident-a", 2, 60).await;
        assert_eq!(first.backend, "local");
        assert_eq!(first.count, 1);
        assert!(first.allowed);
        let second = limit_best_effort(&state, &scope, "ident-a", 2, 60).await;
        assert_eq!(second.count, 2);
        assert!(second.allowed);
        let third = limit_best_effort(&state, &scope, "ident-a", 2, 60).await;
        assert_eq!(third.count, 3);
        assert!(!third.allowed);
        assert_eq!(third.retry_after_sec, 60);
    }
}
