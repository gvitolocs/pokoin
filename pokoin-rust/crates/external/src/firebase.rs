//! Native Firebase access: ID-token verification via Google's public JWKS,
//! Firestore and Auth over the Google REST APIs, plus an in-memory fake for
//! tests. This is reqwest + RS256 — no Node, no firebase-admin SDK.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde_json::{json, Map, Value};
use tokio::sync::RwLock;

use crate::error::{ApiError, ApiResult};

/// The decoded shape every handler reads off a Firebase ID token.
#[derive(Clone, Debug)]
pub struct DecodedToken {
    pub uid: String,
    pub email: Option<String>,
    /// `email_verified`, or the `pok_email_verified` custom claim that
    /// verify-email-signup sets after the code check.
    pub email_verified: bool,
    pub name: Option<String>,
    pub picture: Option<String>,
}

impl DecodedToken {
    /// The lowercased email only when the token proves the user owns it. Any
    /// check that grants access by email must use this, never `email`.
    pub fn verified_email(&self) -> Option<String> {
        if !self.email_verified {
            return None;
        }
        self.email
            .as_deref()
            .map(|email| email.trim().to_ascii_lowercase())
            .filter(|email| !email.is_empty())
    }
}

pub const JWKS_URL: &str =
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const ISSUER_PREFIX: &str = "https://securetoken.google.com/";

/// Verifies Firebase bearer ID tokens. Production implementation fetches
/// Google's public JWKS (cached, refreshed on unknown kid) and checks RS256
/// signature, audience (project id), issuer, and expiry — the same checks
/// firebase-admin makes.
pub struct FirebaseJwksVerifier {
    project_id: String,
    http: reqwest::Client,
    keys: RwLock<HashMap<String, Value>>,
    /// Last refetch an unknown `kid` triggered: random kids must not turn every
    /// request into a Google round trip.
    last_unknown_kid_fetch: std::sync::Mutex<Option<std::time::Instant>>,
}

/// At most one unknown-`kid` JWKS refetch per this interval.
pub const UNKNOWN_KID_REFETCH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// True (and the stamp moved to now) when an unknown-`kid` refetch may run.
fn take_refetch_slot(last: &std::sync::Mutex<Option<std::time::Instant>>) -> bool {
    let mut last = last.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = std::time::Instant::now();
    match *last {
        Some(at) if now.duration_since(at) < UNKNOWN_KID_REFETCH_INTERVAL => false,
        _ => {
            *last = Some(now);
            true
        }
    }
}

impl FirebaseJwksVerifier {
    pub fn new(project_id: String) -> Self {
        Self {
            project_id,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
            keys: RwLock::new(HashMap::new()),
            last_unknown_kid_fetch: std::sync::Mutex::new(None),
        }
    }

    async fn load_keys(&self) -> ApiResult<HashMap<String, Value>> {
        let payload: Value = self
            .http
            .get(JWKS_URL)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let mut map = HashMap::new();
        if let Some(keys) = payload.get("keys").and_then(Value::as_array) {
            for key in keys {
                if let Some(kid) = key.get("kid").and_then(Value::as_str) {
                    map.insert(kid.to_string(), key.clone());
                }
            }
        }
        Ok(map)
    }

    async fn decode(&self, token: &str) -> ApiResult<DecodedToken> {
        let header = jsonwebtoken::decode_header(token)
            .map_err(|_| ApiError::new(401, "Invalid or expired sign-in token.").with_code("auth/invalid-token"))?;
        let kid = header.kid.ok_or_else(|| ApiError::new(401, "Invalid or expired sign-in token.").with_code("auth/invalid-token"))?;
        {
            let keys = self.keys.read().await;
            // An empty map is the first load; an unknown kid refetches at most
            // once per UNKNOWN_KID_REFETCH_INTERVAL (Google rotates keys daily).
            let refetch = keys.is_empty()
                || (!keys.contains_key(&kid) && take_refetch_slot(&self.last_unknown_kid_fetch));
            drop(keys);
            if refetch {
                let fresh = self.load_keys().await?;
                *self.keys.write().await = fresh;
            }
        }
        let key_json = {
            let keys = self.keys.read().await;
            keys.get(&kid).cloned()
        };
        let jwk = key_json.ok_or_else(|| ApiError::new(401, "Invalid or expired sign-in token.").with_code("auth/invalid-token"))?;
        let decoding_key = DecodingKey::from_jwk(&serde_json::from_value::<jsonwebtoken::jwk::Jwk>(jwk.clone()).map_err(|_| ApiError::new(401, "Invalid or expired sign-in token.").with_code("auth/invalid-token"))?)
            .map_err(|_| ApiError::new(401, "Invalid or expired sign-in token.").with_code("auth/invalid-token"))?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[&self.project_id]);
        validation.iss = Some(HashSet::from([format!("{ISSUER_PREFIX}{}", self.project_id)]));
        let claims = jsonwebtoken::decode::<Map<String, Value>>(token, &decoding_key, &validation)
            .map_err(|_| ApiError::new(401, "Invalid or expired sign-in token.").with_code("auth/invalid-token"))?
            .claims;
        let uid = claims
            .get("sub")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ApiError::new(401, "Invalid or expired sign-in token.").with_code("auth/invalid-token"))?
            .to_string();
        let pick = |key: &str| claims.get(key).and_then(Value::as_str).map(str::to_string);
        let flag = |key: &str| claims.get(key).and_then(Value::as_bool) == Some(true);
        Ok(DecodedToken {
            uid,
            email: pick("email"),
            email_verified: flag("email_verified") || flag("pok_email_verified"),
            name: pick("name"),
            picture: pick("picture"),
        })
    }
}

/// Verifier seam so tests inject identities without network.
pub trait TokenVerifier: Send + Sync {
    fn verify<'a>(&'a self, authorization: Option<&'a str>) -> futures_util::future::BoxFuture<'a, ApiResult<DecodedToken>>;
}

impl TokenVerifier for FirebaseJwksVerifier {
    fn verify<'a>(&'a self, authorization: Option<&'a str>) -> futures_util::future::BoxFuture<'a, ApiResult<DecodedToken>> {
        Box::pin(async move {
            let header = authorization.unwrap_or_default();
            let token = header
                .strip_prefix("Bearer ")
                .unwrap_or_default()
                .trim()
                .to_string();
            if token.is_empty() {
                return Err(ApiError::new(401, "Missing Pokoin bearer token.").with_code("auth/missing-token"));
            }
            self.decode(&token).await
})
    }
}

/// Test verifier: any "Bearer test-<uid>" decodes. `uid_email` emails are
/// verified, `unverified_uid_email` ones are not. Compiled only for tests and
/// the `test-util` feature, so no production build can accept a forged token.
#[cfg(any(test, feature = "test-util"))]
#[derive(Clone, Default)]
pub struct StaticVerifier {
    pub uid_email: Arc<HashMap<String, String>>,
    pub unverified_uid_email: Arc<HashMap<String, String>>,
}

#[cfg(any(test, feature = "test-util"))]
impl TokenVerifier for StaticVerifier {
    fn verify<'a>(&'a self, authorization: Option<&'a str>) -> futures_util::future::BoxFuture<'a, ApiResult<DecodedToken>> {
        let header = authorization.unwrap_or_default().to_string();
        let map = self.uid_email.clone();
        let unverified = self.unverified_uid_email.clone();
        Box::pin(async move {
            let token = header.strip_prefix("Bearer ").unwrap_or_default().trim().to_string();
            if token.is_empty() {
                return Err(ApiError::new(401, "Missing Pokoin bearer token.").with_code("auth/missing-token"));
            }
            let uid = token.strip_prefix("test-").unwrap_or(&token).to_string();
            let (email, email_verified) = match map.get(&uid) {
                Some(email) => (Some(email.clone()), true),
                None => (unverified.get(&uid).cloned(), false),
            };
            Ok(DecodedToken {
                uid,
                email,
                email_verified,
                name: None,
                picture: None,
            })
})
    }
}

/// Firestore-style document: id + data, with an `exists` notion.
#[derive(Clone, Debug, Default)]
pub struct FirestoreDoc {
    pub exists: bool,
    pub data: Value,
}

/// The Firestore surface the external domain touches, as a trait:
/// seller_integrations, cardtrader_webhook_events, marketplace_sales,
/// users. Production talks to the Firestore REST API; tests use Memory.
pub trait FirestoreStore: Send + Sync {
    fn get_doc<'a>(&'a self, collection: &'a str, id: &'a str) -> futures_util::future::BoxFuture<'a, ApiResult<FirestoreDoc>>;
    /// Several docs of one collection, in `ids` order (a missing doc has
    /// `exists: false`). REST answers with one `documents:batchGet` per
    /// [`BATCH_GET_MAX`] ids instead of a round trip per doc.
    fn get_docs<'a>(&'a self, collection: &'a str, ids: &'a [String]) -> futures_util::future::BoxFuture<'a, ApiResult<Vec<FirestoreDoc>>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                out.push(self.get_doc(collection, id).await?);
            }
            Ok(out)
        })
    }
    /// set(..., {merge: true})
    fn merge_doc<'a>(&'a self, collection: &'a str, id: &'a str, fields: Value) -> futures_util::future::BoxFuture<'a, ApiResult<()>>;
    /// doc.create() — fails with 409-style AlreadyExists when present.
    fn create_doc<'a>(&'a self, collection: &'a str, id: &'a str, fields: Value) -> futures_util::future::BoxFuture<'a, ApiResult<()>>;
    fn delete_doc<'a>(&'a self, collection: &'a str, id: &'a str) -> futures_util::future::BoxFuture<'a, ApiResult<()>>;
    /// runTransaction-style read-then-conditional-merge used by the webhook
    /// cancel-restore path. `fields` may inspect the current doc.
    fn merge_doc_if<'a>(
        &'a self,
        collection: &'a str,
        id: &'a str,
        predicate: &'static (dyn Fn(&Value) -> bool + Send + Sync),
        fields: Value,
    ) -> futures_util::future::BoxFuture<'a, ApiResult<bool>>;

    /// False only for the in-memory test store. Production [`crate::state::DomainState`]
    /// construction refuses a non-durable store, so no handler can answer a
    /// credential-less MemoryFirestore "success" in production.
    fn durable(&self) -> bool {
        true
    }
}

/// In-memory Firestore for tests (and the no-Firestore degraded mode).
#[derive(Clone, Default)]
pub struct MemoryFirestore {
    docs: Arc<RwLock<HashMap<(String, String), Value>>>,
}

impl MemoryFirestore {
    pub fn new() -> Self {
        Self::default()
    }
    pub async fn seed(&self, collection: &str, id: &str, fields: Value) {
        self.docs.write().await.insert((collection.into(), id.into()), fields);
    }
}

fn deep_merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                match target.get_mut(key) {
                    Some(slot) if slot.is_object() && value.is_object() => deep_merge(slot, value),
                    _ => {
                        target.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (slot, patch) => *slot = patch.clone(),
    }
}

impl FirestoreStore for MemoryFirestore {
    fn durable(&self) -> bool {
        false
    }

    fn get_doc<'a>(&'a self, collection: &'a str, id: &'a str) -> futures_util::future::BoxFuture<'a, ApiResult<FirestoreDoc>> {
        let collection = collection.to_string();
        let id = id.to_string();
        let docs = self.docs.clone();
        Box::pin(async move {
            let guard = docs.read().await;
            match guard.get(&(collection, id)) {
                Some(data) => Ok(FirestoreDoc { exists: true, data: data.clone() }),
                None => Ok(FirestoreDoc { exists: false, data: json!({}) }),
            }
})
    }

    fn merge_doc<'a>(&'a self, collection: &'a str, id: &'a str, fields: Value) -> futures_util::future::BoxFuture<'a, ApiResult<()>> {
        let collection = collection.to_string();
        let id = id.to_string();
        let docs = self.docs.clone();
        Box::pin(async move {
            let mut guard = docs.write().await;
            let entry = guard.entry((collection, id)).or_insert_with(|| json!({}));
            deep_merge(entry, &fields);
            Ok(())
})
    }

    fn create_doc<'a>(&'a self, collection: &'a str, id: &'a str, fields: Value) -> futures_util::future::BoxFuture<'a, ApiResult<()>> {
        let collection = collection.to_string();
        let id = id.to_string();
        let docs = self.docs.clone();
        Box::pin(async move {
            let mut guard = docs.write().await;
            if guard.contains_key(&(collection.clone(), id.clone())) {
                return Err(ApiError::new(409, "already exists"));
            }
            guard.insert((collection, id), fields);
            Ok(())
})
    }

    fn delete_doc<'a>(&'a self, collection: &'a str, id: &'a str) -> futures_util::future::BoxFuture<'a, ApiResult<()>> {
        let collection = collection.to_string();
        let id = id.to_string();
        let docs = self.docs.clone();
        Box::pin(async move {
            docs.write().await.remove(&(collection, id));
            Ok(())
})
    }

    fn merge_doc_if(
        &self,
        collection: &str,
        id: &str,
        predicate: &'static (dyn Fn(&Value) -> bool + Send + Sync),
        fields: Value,
    ) -> futures_util::future::BoxFuture<'_, ApiResult<bool>> {
        let collection = collection.to_string();
        let id = id.to_string();
        let docs = self.docs.clone();
        Box::pin(async move {
            let mut guard = docs.write().await;
            let current = guard.get(&(collection.clone(), id.clone())).cloned().unwrap_or(Value::Null);
            if !predicate(&current) {
                return Ok(false);
            }
            let entry = guard.entry((collection, id)).or_insert_with(|| json!({}));
            deep_merge(entry, &fields);
            Ok(true)
})
    }
}

/// Firestore over the Google REST API. Auth is a service-account JWT
/// (RS256-signed with FIREBASE_PRIVATE_KEY) exchanged for an access token.
pub struct FirestoreRest {
    project_id: String,
    http: reqwest::Client,
    token: RwLock<Option<(String, i64)>>, // token, expires_at_ms
    client_email: String,
    private_key: String,
}

const FIRESTORE_SCOPE: &str = "https://www.googleapis.com/auth/datastore";

/// Documents per `documents:batchGet` request.
pub const BATCH_GET_MAX: usize = 100;

/// A `documents:batchGet` answer (`[{found: doc} | {missing: name}]`, any
/// order) back in `ids` order. `root` is `projects/<p>/databases/(default)/documents`.
fn batch_get_docs(root: &str, collection: &str, ids: &[String], entries: &[Value]) -> Vec<FirestoreDoc> {
    let found: HashMap<&str, &Value> = entries
        .iter()
        .filter_map(|entry| entry.get("found"))
        .filter_map(|doc| Some((doc.get("name")?.as_str()?, doc)))
        .collect();
    ids.iter()
        .map(|id| match found.get(format!("{root}/{collection}/{id}").as_str()) {
            Some(doc) => FirestoreDoc { exists: true, data: FirestoreRest::unflatten(doc) },
            None => FirestoreDoc { exists: false, data: json!({}) },
        })
        .collect()
}

/// Percent-encode a query parameter value (everything outside RFC 3986
/// unreserved characters — field names are plain identifiers today, this keeps
/// any future `.`/space oddity safe).
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

impl FirestoreRest {
    pub fn from_env() -> Option<Self> {
        let project_id = std::env::var("FIREBASE_PROJECT_ID").ok()?.trim().to_string();
        let client_email = std::env::var("FIREBASE_CLIENT_EMAIL").ok()?.trim().to_string();
        let private_key = std::env::var("FIREBASE_PRIVATE_KEY").ok()?.replace("\\n", "\n");
        if project_id.is_empty() || client_email.is_empty() || private_key.is_empty() {
            return None;
        }
        Some(Self {
            project_id,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(8))
                .build()
                .ok()?,
            token: RwLock::new(None),
            client_email,
            private_key,
        })
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    async fn access_token(&self) -> ApiResult<String> {
        if let Some((token, expires_at)) = self.token.read().await.clone() {
            if crate::time_util::now_ms() < expires_at - 60_000 {
                return Ok(token);
            }
        }
        let now = crate::time_util::now_ms();
        let claims = json!({
            "iss": self.client_email,
            "scope": FIRESTORE_SCOPE,
            "aud": "https://oauth2.googleapis.com/token",
            "iat": now / 1000,
            "exp": now / 1000 + 3600,
        });
        let key = jsonwebtoken::EncodingKey::from_rsa_pem(self.private_key.as_bytes())
            .map_err(|e| ApiError::new(500, format!("FIREBASE_PRIVATE_KEY is not usable: {e}")))?;
        let assertion = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
            &claims,
            &key,
        )
        .map_err(|e| ApiError::new(500, format!("token signing failed: {e}")))?;
        let response: Value = self
            .http
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let token = response
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::new(500, "Google token endpoint returned no access token."))?
            .to_string();
        let expires_in = response.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);
        *self.token.write().await = Some((token.clone(), now + expires_in * 1000));
        Ok(token)
    }

    fn doc_url(&self, collection: &str, id: &str) -> String {
        format!(
            "https://firestore.googleapis.com/v1/projects/{}/databases/(default)/documents/{}/{}",
            self.project_id, collection, id
        )
    }

    /// Body + update mask for a merge/patch write.
    ///
    /// The mask names whole top-level fields and the body carries each one as a
    /// full nested `mapValue` document. Dotted leaf keys in the body do NOT
    /// work: Firestore resolves only the mask paths against nested body fields,
    /// and a body keyed by literal dotted names silently clears every masked
    /// nested field to an empty map instead of writing it (this destroyed
    /// stored CardTrader tokens on reconnect, 2026-10-14). Callers pass
    /// complete sub-objects, so replacing whole top-level fields keeps merge
    /// semantics.
    fn patch_body(fields: &Value) -> (Value, String) {
        let mut body = Map::new();
        let mut paths = Vec::new();
        if let Some(map) = fields.as_object() {
            for (key, value) in map {
                body.insert(key.clone(), firestore_value(value));
                paths.push(format!("updateMask.fieldPaths={}", urlencode(key)));
            }
        }
        (json!({ "fields": Value::Object(body) }), paths.join("&"))
    }

    /// REST GET responses carry each field as a typed wrapper (nested
    /// `mapValue`s included); `plain_value` decodes them per top-level field.
    fn unflatten(raw: &Value) -> Value {
        let Some(fields) = raw.get("fields").and_then(Value::as_object) else {
            return json!({});
        };
        Value::Object(
            fields
                .iter()
                .map(|(key, wrapper)| (key.clone(), plain_value(wrapper)))
                .collect(),
        )
    }
}

fn firestore_value(value: &Value) -> Value {
    match value {
        Value::Null => json!({ "nullValue": null }),
        Value::Bool(b) => json!({ "booleanValue": b }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                json!({ "integerValue": i.to_string() })
            } else if let Some(u) = n.as_u64() {
                json!({ "integerValue": u.to_string() })
            } else {
                json!({ "doubleValue": n.as_f64().unwrap_or(0.0) })
            }
        }
        Value::String(s) => json!({ "stringValue": s }),
        Value::Array(items) => json!({
            "arrayValue": { "values": items.iter().map(firestore_value).collect::<Vec<_>>() }
        }),
        Value::Object(map) => {
            let mut fields = Map::new();
            for (key, item) in map {
                fields.insert(key.clone(), firestore_value(item));
            }
            json!({ "mapValue": { "fields": Value::Object(fields) } })
        }
    }
}

fn plain_value(wrapper: &Value) -> Value {
    if let Some(text) = wrapper.get("stringValue") {
        return text.clone();
    }
    if let Some(number) = wrapper.get("integerValue") {
        if let Some(text) = number.as_str() {
            if let Ok(value) = text.parse::<i64>() {
                return Value::from(value);
            }
            if let Ok(value) = text.parse::<u64>() {
                return Value::from(value);
            }
        }
        return number.clone();
    }
    if let Some(number) = wrapper.get("doubleValue") {
        if let Some(value) = number.as_f64() {
            if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
                return Value::from(value as i64);
            }
            return Value::from(value);
        }
        return number.clone();
    }
    if let Some(boolean) = wrapper.get("booleanValue") {
        return boolean.clone();
    }
    if wrapper.get("nullValue").is_some() {
        return Value::Null;
    }
    if let Some(array) = wrapper.get("arrayValue").and_then(|a| a.get("values")) {
        return Value::Array(array.as_array().map(|rows| rows.iter().map(plain_value).collect()).unwrap_or_default());
    }
    if let Some(map) = wrapper.get("mapValue").and_then(|m| m.get("fields")) {
        let mut out = Map::new();
        if let Some(fields) = map.as_object() {
            for (key, wrapper) in fields {
                out.insert(key.clone(), plain_value(wrapper));
            }
        }
        return Value::Object(out);
    }
    if let Some(stamp) = wrapper.get("timestampValue") {
        return stamp.clone();
    }
    Value::Null
}

impl FirestoreStore for FirestoreRest {
    fn get_doc<'a>(&'a self, collection: &'a str, id: &'a str) -> futures_util::future::BoxFuture<'a, ApiResult<FirestoreDoc>> {
        Box::pin(async move {
            let token = self.access_token().await?;
            let response = self
                .http
                .get(self.doc_url(collection, id))
                .bearer_auth(token)
                .send()
                .await?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(FirestoreDoc { exists: false, data: json!({}) });
            }
            let response = response.error_for_status()?;
            let payload: Value = response.json().await?;
            Ok(FirestoreDoc { exists: true, data: Self::unflatten(&payload) })
})
    }

    fn get_docs<'a>(&'a self, collection: &'a str, ids: &'a [String]) -> futures_util::future::BoxFuture<'a, ApiResult<Vec<FirestoreDoc>>> {
        Box::pin(async move {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            let token = self.access_token().await?;
            let root = format!("projects/{}/databases/(default)/documents", self.project_id);
            let url = format!("https://firestore.googleapis.com/v1/{root}:batchGet");
            let requests = ids.chunks(BATCH_GET_MAX).map(|chunk| {
                let body = json!({ "documents": chunk.iter().map(|id| format!("{root}/{collection}/{id}")).collect::<Vec<_>>() });
                let request = self.http.post(&url).bearer_auth(&token).json(&body);
                async move {
                    let entries: Vec<Value> = request.send().await?.error_for_status()?.json().await?;
                    Ok::<_, ApiError>(entries)
                }
            });
            let mut entries = Vec::new();
            for answer in futures_util::future::join_all(requests).await {
                entries.extend(answer?);
            }
            Ok(batch_get_docs(&root, collection, ids, &entries))
        })
    }

    fn merge_doc<'a>(&'a self, collection: &'a str, id: &'a str, fields: Value) -> futures_util::future::BoxFuture<'a, ApiResult<()>> {
        Box::pin(async move {
            let token = self.access_token().await?;
            let (body, mask) = Self::patch_body(&fields);
            let url = format!("{}?{}", self.doc_url(collection, id), mask);
            let response = self
                .http
                .patch(&url)
                .bearer_auth(token)
                .json(&body)
                .send()
                .await?
                .error_for_status()?;
            let _ = response;
            Ok(())
})
    }

    fn create_doc<'a>(&'a self, collection: &'a str, id: &'a str, fields: Value) -> futures_util::future::BoxFuture<'a, ApiResult<()>> {
        Box::pin(async move {
            let token = self.access_token().await?;
            let (body, _) = Self::patch_body(&fields);
            let url = format!("{}?currentDocument.exists=false", self.doc_url(collection, id));
            let status = self
                .http
                .post(&url)
                .bearer_auth(token)
                .json(&body)
                .send()
                .await?
                .status();
            if status == reqwest::StatusCode::CONFLICT || status.as_u16() == 409 {
                return Err(ApiError::new(409, "already exists"));
            }
            Ok(())
})
    }

    fn delete_doc<'a>(&'a self, collection: &'a str, id: &'a str) -> futures_util::future::BoxFuture<'a, ApiResult<()>> {
        Box::pin(async move {
            let token = self.access_token().await?;
            self.http
                .delete(self.doc_url(collection, id))
                .bearer_auth(token)
                .send()
                .await?
                .error_for_status()?;
            Ok(())
})
    }

    fn merge_doc_if<'a>(
        &'a self,
        collection: &'a str,
        id: &'a str,
        predicate: &'static (dyn Fn(&Value) -> bool + Send + Sync),
        fields: Value,
    ) -> futures_util::future::BoxFuture<'a, ApiResult<bool>> {
        Box::pin(async move {
            // Read-then-write is acceptable for the single cancel-restore path:
            // the operation is idempotent via the restoredAt flag.
            let doc = self.get_doc(collection, id).await?;
            if !doc.exists || !predicate(&doc.data) {
                return Ok(false);
            }
            self.merge_doc(collection, id, fields).await?;
            Ok(true)
})
    }
}

/// Decode a JWT payload without verifying (CardTrader token fingerprints).
pub fn decode_jwt_segment(segment: &str) -> Option<Value> {
    let bytes = URL_SAFE_NO_PAD.decode(segment).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_firestore_merge_semantics() {
        let fs = MemoryFirestore::new();
        fs.merge_doc("seller_integrations", "u1__cardtrader", json!({"enabled": true, "metadata": {"a": 1}}))
            .await
            .unwrap();
        fs.merge_doc("seller_integrations", "u1__cardtrader", json!({"metadata": {"b": 2}}))
            .await
            .unwrap();
        let doc = fs.get_doc("seller_integrations", "u1__cardtrader").await.unwrap();
        assert!(doc.exists);
        assert_eq!(doc.data["enabled"], true);
        assert_eq!(doc.data["metadata"]["a"], 1);
        assert_eq!(doc.data["metadata"]["b"], 2);

        let created = fs.create_doc("cardtrader_webhook_events", "u1_1_1", json!({"x": 1})).await;
        assert!(created.is_ok());
        let dup = fs.create_doc("cardtrader_webhook_events", "u1_1_1", json!({"x": 1})).await;
        assert_eq!(dup.unwrap_err().status, 409);
    }

    #[tokio::test]
    async fn merge_doc_if_only_writes_on_predicate() {
        let fs = MemoryFirestore::new();
        fs.merge_doc("e", "1", json!({"listingId": "L", "quantity": 2})).await.unwrap();
        fn predicate(data: &Value) -> bool {
            !data.get("restoredAt").is_some_and(|v| !v.is_null()) && data.get("listingId").is_some()
        }
        let wrote = fs.merge_doc_if("e", "1", &predicate as &(dyn Fn(&Value) -> bool + Send + Sync), json!({"restoredAt": "now"})).await.unwrap();
        assert!(wrote);
        let again = fs.merge_doc_if("e", "1", &predicate as &(dyn Fn(&Value) -> bool + Send + Sync), json!({"restoredAt": "later"})).await.unwrap();
        assert!(!again);
        let doc = fs.get_doc("e", "1").await.unwrap();
        assert_eq!(doc.data["restoredAt"], "now");
    }

    #[test]
    fn firestore_value_round_trip() {
        let value = json!({"a": 1, "b": "x", "c": [1, "y"], "d": {"e": true}});
        let wrapped = firestore_value(&value);
        assert_eq!(plain_value(&wrapped), value);
    }

    #[test]
    fn patch_body_writes_nested_fields_not_dotted_keys() {
        // The exact payload store_connected_integration sends for a reconnect.
        // The old writer keyed the body with literal dotted paths; Firestore
        // ignored them and cleared every masked nested field to an empty map,
        // which destroyed stored tokens ("CardTrader is not connected for this
        // seller" while status still said connected). The body must nest
        // mapValues and the mask must name top-level fields only.
        let fields = json!({
            "uid": "u1",
            "enabled": true,
            "metadata": {
                "app": { "id": "7", "name": "App" },
                "user": { "id": "5", "username": "sel" },
                "scopes": ["openid"],
                "seller": { "id": "9", "name": "Sel Shop" },
                "oneDayReady": false,
            },
            "encryptedToken": {
                "version": 1,
                "algorithm": "aes-256-gcm",
                "iv": "IVIVIVIVIVIVIVIV",
                "tag": "TA==",
                "ciphertext": "CIPHERTEXT",
            },
            "encryptedSharedSecret": Value::Null,
        });
        let (body, mask) = FirestoreRest::patch_body(&fields);
        let body_fields = body.get("fields").and_then(Value::as_object).expect("body fields");
        for key in body_fields.keys() {
            assert!(!key.contains('.'), "body key {key} must not be a dotted path");
        }
        let token = body_fields
            .get("encryptedToken")
            .and_then(|w| w.get("mapValue"))
            .and_then(|m| m.get("fields"))
            .and_then(Value::as_object)
            .expect("encryptedToken stored as a nested mapValue");
        assert_eq!(token.len(), 5, "envelope fields must survive the write body");
        assert_eq!(token["ciphertext"]["stringValue"], "CIPHERTEXT");

        let mask_paths: Vec<&str> = mask.split("&").collect();
        assert_eq!(mask_paths.len(), 5, "one mask path per top-level field");
        assert!(mask_paths.contains(&"updateMask.fieldPaths=encryptedToken"));
        assert!(mask_paths.contains(&"updateMask.fieldPaths=metadata"));
        for path in &mask_paths {
            let name = path.split('=').nth(1).expect("mask path=value");
            assert!(!name.contains('.'), "mask path {name} must be top-level");
        }

        // The stored body reads back to the same data plain_value hands to the
        // API layer — the write shape and the read shape agree.
        let read_back: Map<String, Value> = body_fields
            .iter()
            .map(|(key, wrapper)| (key.clone(), plain_value(wrapper)))
            .collect();
        assert_eq!(read_back["metadata"]["user"]["username"], "sel");
        assert_eq!(read_back["encryptedToken"]["ciphertext"], "CIPHERTEXT");
        assert_eq!(read_back["encryptedSharedSecret"], Value::Null);
    }

    #[test]
    fn static_verifier() {
        let verifier = StaticVerifier::default();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let decoded = runtime.block_on(verifier.verify(Some("Bearer test-user1"))).unwrap();
        assert_eq!(decoded.uid, "user1");
        let err = runtime.block_on(verifier.verify(None)).unwrap_err();
        assert_eq!(err.status, 401);
    }

    #[test]
    fn verified_email_requires_the_verified_claim() {
        let mut token = DecodedToken {
            uid: "u".into(),
            email: Some(" Admin@Example.com ".into()),
            email_verified: false,
            name: None,
            picture: None,
        };
        assert_eq!(token.verified_email(), None);
        token.email_verified = true;
        assert_eq!(token.verified_email().as_deref(), Some("admin@example.com"));
        token.email = Some("  ".into());
        assert_eq!(token.verified_email(), None);
    }

    #[test]
    fn unknown_kid_refetch_is_throttled() {
        let last = std::sync::Mutex::new(None);
        assert!(take_refetch_slot(&last), "the first unknown kid refetches");
        assert!(!take_refetch_slot(&last), "a second one inside the interval does not");
        *last.lock().unwrap() = Some(std::time::Instant::now() - UNKNOWN_KID_REFETCH_INTERVAL);
        assert!(take_refetch_slot(&last), "after the interval it may refetch again");
    }

    #[tokio::test]
    async fn unknown_kid_tokens_do_not_hammer_google() {
        // A verifier with keys loaded, then a burst of tokens with random kids:
        // only the first may refetch, the rest fail on the cached map.
        let verifier = FirebaseJwksVerifier::new("proj".into());
        verifier.keys.write().await.insert("known".into(), json!({"kid": "known"}));
        *verifier.last_unknown_kid_fetch.lock().unwrap() = Some(std::time::Instant::now());
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","kid":"random-kid","typ":"JWT"}"#);
        let token = format!("{header}.e30.c2ln");
        for _ in 0..20 {
            let error = verifier.decode(&token).await.unwrap_err();
            assert_eq!(error.status, 401);
        }
        // No refetch happened: the cached map is untouched.
        assert_eq!(verifier.keys.read().await.len(), 1);
    }

    #[test]
    fn batch_get_answers_come_back_in_id_order() {
        let root = "projects/p/databases/(default)/documents";
        let entries = vec![
            json!({ "missing": format!("{root}/events/b") }),
            json!({ "found": { "name": format!("{root}/events/c"), "fields": { "n": { "integerValue": "3" } } } }),
            json!({ "found": { "name": format!("{root}/events/a"), "fields": { "n": { "integerValue": "1" } } } }),
        ];
        let ids = vec!["a".to_string(), "b".to_string(), "c".to_string(), "a".to_string()];
        let docs = batch_get_docs(root, "events", &ids, &entries);
        assert_eq!(docs.iter().map(|d| d.exists).collect::<Vec<_>>(), vec![true, false, true, true]);
        assert_eq!(docs[0].data["n"], 1);
        assert_eq!(docs[2].data["n"], 3);
        assert_eq!(docs[3].data["n"], 1);
    }

    #[tokio::test]
    async fn default_get_docs_reads_each_doc() {
        let store = MemoryFirestore::new();
        store.seed("c", "x", json!({ "v": 1 })).await;
        let docs = store.get_docs("c", &["x".to_string(), "y".to_string()]).await.unwrap();
        assert!(docs[0].exists && !docs[1].exists);
        assert_eq!(docs[0].data["v"], 1);
    }
}
