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
    pub name: Option<String>,
    pub picture: Option<String>,
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
            if !keys.contains_key(&kid) {
                drop(keys);
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
        Ok(DecodedToken { uid, email: pick("email"), name: pick("name"), picture: pick("picture") })
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

/// Test verifier: any "Bearer test-<uid>" (or configured map) decodes.
#[derive(Clone, Default)]
pub struct StaticVerifier {
    pub uid_email: Arc<HashMap<String, String>>,
}

impl TokenVerifier for StaticVerifier {
    fn verify<'a>(&'a self, authorization: Option<&'a str>) -> futures_util::future::BoxFuture<'a, ApiResult<DecodedToken>> {
        let header = authorization.unwrap_or_default().to_string();
        let map = self.uid_email.clone();
        Box::pin(async move {
            let token = header.strip_prefix("Bearer ").unwrap_or_default().trim().to_string();
            if token.is_empty() {
                return Err(ApiError::new(401, "Missing Pokoin bearer token.").with_code("auth/missing-token"));
            }
            let uid = token.strip_prefix("test-").unwrap_or(&token).to_string();
            let email = map.get(&uid).cloned();
            Ok(DecodedToken {
                uid,
                email,
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

    /// REST documents use dot paths; we flatten objects into dot paths.
    fn flatten(fields: &Value, prefix: &str, out: &mut Map<String, Value>) {
        match fields {
            Value::Object(map) => {
                for (key, value) in map {
                    let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
                    if value.is_object() {
                        Self::flatten(value, &path, out);
                    } else {
                        out.insert(path, firestore_value(value));
                    }
                }
            }
            other => {
                out.insert(prefix.to_string(), firestore_value(other));
            }
        }
    }

    fn unflatten(raw: &Value) -> Value {
        let mut root = Map::new();
        let Some(fields) = raw.get("fields").and_then(Value::as_object) else {
            return json!({});
        };
        for (path, wrapper) in fields {
            let segments: Vec<&str> = path.split('.').collect();
            let mut cursor = &mut root;
            for segment in &segments[..segments.len().saturating_sub(1)] {
                cursor = cursor
                    .entry(segment.to_string())
                    .or_insert_with(|| Value::Object(Map::new()))
                    .as_object_mut()
                    .expect("flattening only creates objects");
            }
            cursor.insert(segments[segments.len() - 1].to_string(), plain_value(wrapper));
        }
        Value::Object(root)
    }

    fn update_mask(fields: &Value) -> String {
        let mut flattened = Map::new();
        Self::flatten(fields, "", &mut flattened);
        flattened
            .keys()
            .map(|path| format!("updateMask.fieldPaths={path}"))
            .collect::<Vec<_>>()
            .join("&")
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

    fn merge_doc<'a>(&'a self, collection: &'a str, id: &'a str, fields: Value) -> futures_util::future::BoxFuture<'a, ApiResult<()>> {
        Box::pin(async move {
            let token = self.access_token().await?;
            let mut flattened = Map::new();
            Self::flatten(&fields, "", &mut flattened);
            let mask = Self::update_mask(&fields);
            let url = format!("{}?{}", self.doc_url(collection, id), mask);
            let response = self
                .http
                .patch(&url)
                .bearer_auth(token)
                .json(&json!({ "fields": Value::Object(flattened) }))
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
            let mut flattened = Map::new();
            Self::flatten(&fields, "", &mut flattened);
            let url = format!("{}?currentDocument.exists=false", self.doc_url(collection, id));
            let status = self
                .http
                .post(&url)
                .bearer_auth(token)
                .json(&json!({ "fields": Value::Object(flattened) }))
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
    fn static_verifier() {
        let verifier = StaticVerifier::default();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let decoded = runtime.block_on(verifier.verify(Some("Bearer test-user1"))).unwrap();
        assert_eq!(decoded.uid, "user1");
        let err = runtime.block_on(verifier.verify(None)).unwrap_err();
        assert_eq!(err.status, 401);
    }
}
