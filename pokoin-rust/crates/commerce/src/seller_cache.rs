//! Shared read-through cache for PUBLIC seller profile fields.
//!
//! Ports `_seller_profile_cache.js`. This is display enrichment only: never use
//! a cached value to authorise a seller, check ownership or establish payment
//! identity — checkout and webhook paths read Firestore live. Firestore stays
//! the source of truth; the cache only saves a per-request fan-out.
//!
//! Redis keys (TTL-only, plus best-effort DEL on server-side profile writes):
//!   `pokoin:seller:v1:{uid}:profile`            -> `{displayName,username,acceptsPkn}`
//!   `pokoin:seller:v1:slug:{sha256(name)[0:32]}:uid` -> `{uid,displayName}`
//!
//! Names are user-controlled, so they are hashed and never appear raw in a key.
//! Fail-open: with Redis down every helper falls straight through to Firestore.

use std::collections::HashMap;

use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::StoreError;
use crate::firestore::FirestoreClient;
use crate::store;

/// Versioned Redis namespace (`_redis_ns.js`).
pub const SELLER_NS: &str = "pokoin:seller:v1";
/// `PUBLIC_PROFILE_TTL_SEC`.
pub const PUBLIC_PROFILE_TTL_SEC: i64 = 6 * 60 * 60;

/// `cleanText(value, maxLength)`.
pub fn clean_text(value: &str, max_length: usize) -> String {
    value.trim().chars().take(max_length).collect()
}

/// `join(prefix, parts)`: empty parts are dropped, the rest are trimmed.
pub fn join_key(prefix: &str, parts: &[&str]) -> String {
    let body: Vec<String> = parts
        .iter()
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect();
    if body.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}:{}", body.join(":"))
    }
}

pub fn seller_profile_key(uid: &str) -> String {
    join_key(SELLER_NS, &[&clean_text(uid, 160), "profile"])
}

/// `slugKey`: sha256 of the lowercased name, first 32 hex characters.
pub fn seller_slug_key(normalized_name: &str) -> String {
    let digest = Sha256::digest(normalized_name.trim().to_ascii_lowercase().as_bytes());
    let hash = hex::encode(&digest[..16]);
    join_key(SELLER_NS, &["slug", &hash, "uid"])
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PublicSellerProfile {
    pub display_name: String,
    pub username: String,
    pub accepts_pkn: bool,
}

impl PublicSellerProfile {
    /// `publicProfileFromDoc`: `acceptsPkn` defaults to true unless explicitly false.
    pub fn from_doc(user: &Value) -> Self {
        let username = {
            let direct = clean_text(
                user.get("username").and_then(Value::as_str).unwrap_or_default(),
                120,
            );
            if direct.is_empty() {
                clean_text(
                    user
                        .get("usernameLower")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    120,
                )
            } else {
                direct
            }
        };
        Self {
            display_name: clean_text(
                user
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                120,
            ),
            username,
            accepts_pkn: user.get("acceptsPkn").and_then(Value::as_bool) != Some(false),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "displayName": self.display_name,
            "username": self.username,
            "acceptsPkn": self.accepts_pkn,
        })
    }

    /// A malformed or partial cache entry reads as a miss, never as a half-profile.
    pub fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if !object.contains_key("displayName") && !object.contains_key("username") {
            return None;
        }
        Some(Self {
            display_name: clean_text(
                value.get("displayName").and_then(Value::as_str).unwrap_or_default(),
                120,
            ),
            username: clean_text(
                value.get("username").and_then(Value::as_str).unwrap_or_default(),
                120,
            ),
            accepts_pkn: value.get("acceptsPkn").and_then(Value::as_bool) != Some(false),
        })
    }
}

/// The disposable key/value surface the cache needs.
#[async_trait]
pub trait ProfileCache: Send + Sync {
    async fn get(&self, key: &str) -> Option<String>;
    async fn set_ex(&self, key: &str, value: &str, ttl_seconds: i64);
    async fn del(&self, key: &str);
}

/// The real Redis cache (Pi Redis :6380).
pub struct RedisProfileCache {
    connection: redis::aio::ConnectionManager,
}

impl RedisProfileCache {
    pub fn new(connection: redis::aio::ConnectionManager) -> Self {
        Self { connection }
    }
}

#[async_trait]
impl ProfileCache for RedisProfileCache {
    async fn get(&self, key: &str) -> Option<String> {
        let mut connection = self.connection.clone();
        redis::cmd("GET")
            .arg(key)
            .query_async::<Option<String>>(&mut connection)
            .await
            .ok()
            .flatten()
    }
    async fn set_ex(&self, key: &str, value: &str, ttl_seconds: i64) {
        let mut connection = self.connection.clone();
        let _ = redis::cmd("SETEX")
            .arg(key)
            .arg(ttl_seconds.max(1))
            .arg(value)
            .query_async::<String>(&mut connection)
            .await;
    }
    async fn del(&self, key: &str) {
        let mut connection = self.connection.clone();
        let _ = redis::cmd("DEL")
            .arg(key)
            .query_async::<i64>(&mut connection)
            .await;
    }
}

/// Read public profiles for `uids`, cache-first.
///
/// Fail-open by design: any cache problem simply falls through to Firestore.
pub async fn read_public_profiles(
    cache: Option<&dyn ProfileCache>,
    firestore: &FirestoreClient,
    uids: &[String],
) -> Result<HashMap<String, PublicSellerProfile>, StoreError> {
    let mut profiles: HashMap<String, PublicSellerProfile> = HashMap::new();
    let mut missing: Vec<String> = Vec::new();
    for uid in uids {
        if uid.trim().is_empty() || profiles.contains_key(uid) {
            continue;
        }
        let mut hit = None;
        if let Some(cache) = cache {
            if let Some(raw) = cache.get(&seller_profile_key(uid)).await {
                hit = serde_json::from_str::<Value>(&raw)
                    .ok()
                    .and_then(|value| PublicSellerProfile::from_json(&value));
            }
        }
        match hit {
            Some(profile) => {
                profiles.insert(uid.clone(), profile);
            }
            None => missing.push(uid.clone()),
        }
    }
    if missing.is_empty() {
        return Ok(profiles);
    }
    for uid in missing {
        // Missing user documents are skipped, never cached as empty.
        let user = store::read_user(firestore, &uid).await?;
        if user.as_object().map(|object| object.is_empty()).unwrap_or(true) {
            continue;
        }
        let profile = PublicSellerProfile::from_doc(&user);
        if let Some(cache) = cache {
            cache
                .set_ex(
                    &seller_profile_key(&uid),
                    &profile.to_json().to_string(),
                    PUBLIC_PROFILE_TTL_SEC,
                )
                .await;
        }
        profiles.insert(uid, profile);
    }
    Ok(profiles)
}

/// `invalidateSellerProfile`: best-effort DEL of the cached profile and slug.
pub async fn invalidate_seller_profile(
    cache: Option<&dyn ProfileCache>,
    uid: &str,
    username: &str,
) {
    let Some(cache) = cache else { return };
    cache.del(&seller_profile_key(uid)).await;
    if !username.trim().is_empty() {
        cache.del(&seller_slug_key(username)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn namespace_helpers_match_the_node_keys() {
        assert_eq!(
            join_key("pokoin:seller:v1", &["uid1", "profile"]),
            "pokoin:seller:v1:uid1:profile"
        );
        // Empty parts collapse, like the Node `join`.
        assert_eq!(join_key("pokoin:rl:v1", &["scope", ""]), "pokoin:rl:v1:scope");
        assert_eq!(join_key("pokoin:rl:v1", &[]), "pokoin:rl:v1");
        assert_eq!(
            seller_profile_key("uid1"),
            "pokoin:seller:v1:uid1:profile"
        );
        let slug = seller_slug_key("Alice");
        assert!(slug.starts_with("pokoin:seller:v1:slug:"));
        assert!(slug.ends_with(":uid"));
        // Names are hashed, never raw, and case-insensitive.
        assert!(!slug.contains("alice"));
        assert!(!slug.contains("Alice"));
        assert_eq!(slug, seller_slug_key("ALICE"));
        assert_eq!(slug, seller_slug_key(" alice "));
        assert_ne!(slug, seller_slug_key("bob"));
        // sha256 hex, first 32 chars.
        let parts: Vec<&str> = slug.split(':').collect();
        // pokoin:seller:v1:slug:{hash}:uid
        assert_eq!(parts[4].len(), 32);
    }

    #[test]
    fn profiles_default_accepts_pkn_to_true() {
        let profile = PublicSellerProfile::from_doc(&json!({ "displayName": "Al" }));
        assert!(profile.accepts_pkn);
        assert_eq!(profile.display_name, "Al");
        // An explicit opt-out is honoured.
        let opted_out = PublicSellerProfile::from_doc(&json!({ "acceptsPkn": false }));
        assert!(!opted_out.accepts_pkn);
        // usernameLower is the fallback.
        let lower = PublicSellerProfile::from_doc(&json!({ "usernameLower": "al" }));
        assert_eq!(lower.username, "al");
    }

    #[test]
    fn cache_entries_round_trip_and_reject_junk() {
        let profile = PublicSellerProfile {
            display_name: "Alice".into(),
            username: "alice".into(),
            accepts_pkn: false,
        };
        let encoded = profile.to_json();
        assert_eq!(PublicSellerProfile::from_json(&encoded), Some(profile));
        // Junk is a miss, never a half-profile.
        assert!(PublicSellerProfile::from_json(&json!({})).is_none());
        assert!(PublicSellerProfile::from_json(&json!("nope")).is_none());
        assert!(PublicSellerProfile::from_json(&json!([1, 2])).is_none());
    }

    #[derive(Default)]
    struct FakeCache {
        rows: Mutex<HashMap<String, String>>,
        gets: Mutex<Vec<String>>,
        deletes: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl ProfileCache for FakeCache {
        async fn get(&self, key: &str) -> Option<String> {
            self.gets.lock().unwrap().push(key.to_string());
            self.rows.lock().unwrap().get(key).cloned()
        }
        async fn set_ex(&self, key: &str, value: &str, _ttl: i64) {
            self.rows
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
        }
        async fn del(&self, key: &str) {
            self.deletes.lock().unwrap().push(key.to_string());
            self.rows.lock().unwrap().remove(key);
        }
    }

    #[tokio::test]
    async fn invalidation_deletes_the_profile_and_slug_keys() {
        let cache = FakeCache::default();
        cache
            .set_ex(&seller_profile_key("u1"), "{}", 10)
            .await;
        cache
            .set_ex(&seller_slug_key("Alice"), "{}", 10)
            .await;
        invalidate_seller_profile(Some(&cache), "u1", "Alice").await;
        assert!(cache
            .rows
            .lock()
            .unwrap()
            .get(&seller_profile_key("u1"))
            .is_none());
        assert!(cache
            .rows
            .lock()
            .unwrap()
            .get(&seller_slug_key("Alice"))
            .is_none());
        // An empty username skips the slug delete instead of nuking a shared key.
        invalidate_seller_profile(Some(&cache), "u1", "  ").await;
        let deletes = cache.deletes.lock().unwrap().clone();
        assert_eq!(
            deletes,
            vec![
                seller_profile_key("u1"),
                seller_slug_key("Alice"),
                seller_profile_key("u1"),
            ]
        );
        // Without a cache the helper is a no-op, not a panic.
        invalidate_seller_profile(None, "u1", "Alice").await;
    }

    #[tokio::test]
    async fn a_cache_hit_avoids_firestore_entirely() {
        // No Firestore client is reachable here: a hit must not touch it.
        let cache = FakeCache::default();
        cache
            .set_ex(
                &seller_profile_key("u1"),
                &json!({ "displayName": "Cached", "username": "cached" }).to_string(),
                10,
            )
            .await;
        // A dead Firestore client is fine because the lookup never runs.
        let firestore = FirestoreClient::with_static_token(
            reqwest::Client::new(),
            "pokoin-test",
            "http://127.0.0.1:1/none",
            "token",
        );
        let profiles =
            read_public_profiles(Some(&cache), &firestore, &["u1".to_string()])
                .await
                .unwrap();
        assert_eq!(profiles.get("u1").unwrap().display_name, "Cached");
        assert!(profiles.get("u1").unwrap().accepts_pkn);
    }
}
