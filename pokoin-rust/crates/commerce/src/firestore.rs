//! Native Google Firestore client — OAuth (service account JWT), documents,
//! structured queries and transactions — plus the public `FirebaseVerifier`
//! re-export from [`crate::auth`].
//!
//! The Pokoin wallet, accounts, orders, addresses and crypto bookkeeping live
//! in Firestore. This module speaks the Firestore v1 REST API directly: no Node
//! runtime, no Admin SDK and no state migration. Field names, document ids and
//! collection names match the Node writers exactly.
//!
//! Public reusable surface:
//!   * [`FirestoreClient::from_env`] / [`FirestoreClient::new`]
//!   * [`FirestoreClient::get_document`] / `list_documents`
//!   * [`FirestoreClient::run_query`] with [`Filter`] / [`OrderBy`]
//!   * [`FirestoreClient::set_document`] / `create_document` / `update_document`
//!   * [`FirestoreClient::delete_document`]
//!   * [`FirestoreClient::run_transaction`] with [`FirestoreWrite`]
//!   * [`encode_value`] / [`decode_value`] / [`DocumentTransform`]
//!
//! Everything that shapes a request or a document is pure and unit-tested;
//! only the transport touches the network.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::RwLock;

use crate::error::{ApiError, StoreError};

pub const DATASTORE_SCOPE: &str = "https://www.googleapis.com/auth/datastore";
pub const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
pub const TOKEN_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/// Service-account credentials, straight from the Firebase Admin env contract.
#[derive(Debug, Clone)]
pub struct ServiceAccount {
    pub project_id: String,
    pub client_email: String,
    pub private_key_pem: String,
}

impl ServiceAccount {
    /// `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`.
    pub fn from_env() -> Result<Self, StoreError> {
        let project_id = std::env::var("FIREBASE_PROJECT_ID")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let client_email = std::env::var("FIREBASE_CLIENT_EMAIL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let private_key = std::env::var("FIREBASE_PRIVATE_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty());
        match (project_id, client_email, private_key) {
            (Some(project_id), Some(client_email), Some(private_key)) => Ok(Self {
                project_id,
                client_email,
                private_key_pem: normalize_pem(&private_key),
            }),
            _ => Err(StoreError::Cache(
                "Firestore is not configured (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)."
                    .into(),
            )),
        }
    }
}

/// Environment variables often carry the PEM with literal `\n` escapes.
pub fn normalize_pem(raw: &str) -> String {
    raw.replace("\\n", "\n")
}

#[derive(Debug, Serialize)]
struct JwtClaims {
    iss: String,
    scope: String,
    aud: String,
    iat: i64,
    exp: i64,
}

/// The OAuth assertion the service-account flow sends. Pure and testable.
pub fn oauth_assertion(account: &ServiceAccount, issued_at: i64, ttl_seconds: i64) -> Result<String, StoreError> {
    let claims = JwtClaims {
        iss: account.client_email.clone(),
        scope: DATASTORE_SCOPE.to_string(),
        aud: TOKEN_ENDPOINT.to_string(),
        iat: issued_at,
        exp: issued_at + ttl_seconds,
    };
    let mut header = Header::new(Algorithm::RS256);
    header.kid = None;
    let key = EncodingKey::from_rsa_pem(account.private_key_pem.as_bytes())
        .map_err(|error| StoreError::Cache(format!("invalid Firebase private key: {error}")))?;
    encode(&header, &claims, &key)
        .map_err(|error| StoreError::Cache(format!("could not sign the OAuth assertion: {error}")))
}

#[derive(Debug, Clone)]
struct CachedToken {
    token: String,
    expires_at_ms: i64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: i64,
}

/// Firestore v1 REST client.
#[derive(Clone)]
pub struct FirestoreClient {
    http: reqwest::Client,
    account: ServiceAccount,
    base: String,
    token: Arc<RwLock<Option<CachedToken>>>,
    /// Set only by [`FirestoreClient::with_static_token`] (tests/emulator).
    static_token: Option<String>,
}

impl FirestoreClient {
    pub fn new(http: reqwest::Client, account: ServiceAccount) -> Self {
        let base = format!(
            "https://firestore.googleapis.com/v1/projects/{}/databases/(default)/documents",
            account.project_id
        );
        Self {
            http,
            account,
            base,
            token: Arc::new(RwLock::new(None)),
            static_token: None,
        }
    }

    pub fn from_env(http: reqwest::Client) -> Result<Self, StoreError> {
        Ok(Self::new(http, ServiceAccount::from_env()?))
    }

    /// Test/embedding constructor pointing at a fake Firestore host.
    pub fn with_base(http: reqwest::Client, account: ServiceAccount, base: impl Into<String>) -> Self {
        let mut client = Self::new(http, account);
        client.base = base.into();
        client
    }

    /// Test / Firestore-emulator constructor with a pre-issued access token.
    ///
    /// The OAuth service-account flow is skipped, so tests (and a local
    /// emulator) can exercise documents, queries and transactions without
    /// Google credentials. Production code must use [`FirestoreClient::new`]
    /// or [`FirestoreClient::from_env`].
    pub fn with_static_token(
        http: reqwest::Client,
        project_id: impl Into<String>,
        base: impl Into<String>,
        token: impl Into<String>,
    ) -> Self {
        let account = ServiceAccount {
            project_id: project_id.into(),
            client_email: String::new(),
            private_key_pem: String::new(),
        };
        let mut client = Self::new(http, account);
        client.base = base.into();
        client.static_token = Some(token.into());
        client
    }

    pub fn project_id(&self) -> &str {
        &self.account.project_id
    }

    pub fn document_path(&self, collection: &str, id: &str) -> String {
        format!("{}/{collection}/{id}", self.base)
    }

    pub fn nested_path(&self, parent: (&str, &str), collection: &str, id: &str) -> String {
        format!(
            "{}/{}/{}/{collection}/{id}",
            self.base, parent.0, parent.1
        )
    }

    pub fn collection_url(&self, collection: &str) -> String {
        format!("{}/{collection}", self.base)
    }

    /// Cached OAuth access token (or the injected test/emulator token).
    pub async fn access_token(&self) -> Result<String, StoreError> {
        if let Some(token) = &self.static_token {
            return Ok(token.clone());
        }
        let now = chrono::Utc::now().timestamp_millis();
        {
            let cache = self.token.read().await;
            if let Some(cached) = cache.as_ref() {
                if cached.expires_at_ms - 60_000 > now {
                    return Ok(cached.token.clone());
                }
            }
        }
        let issued_at = chrono::Utc::now().timestamp();
        let assertion = oauth_assertion(&self.account, issued_at, 3600)?;
        let response = self
            .http
            .post(TOKEN_ENDPOINT)
            .form(&[
                ("grant_type", TOKEN_GRANT_TYPE),
                ("assertion", assertion.as_str()),
            ])
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore OAuth failed: {error}")))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore OAuth failed: {error}")))?;
        if !status.is_success() {
            return Err(StoreError::Cache(format!(
                "Firestore OAuth rejected ({status}): {body}"
            )));
        }
        let parsed: TokenResponse = serde_json::from_str(&body)
            .map_err(|error| StoreError::Cache(format!("Firestore OAuth response invalid: {error}")))?;
        let ttl = if parsed.expires_in > 0 { parsed.expires_in } else { 3600 };
        *self.token.write().await = Some(CachedToken {
            token: parsed.access_token.clone(),
            expires_at_ms: now + ttl * 1000,
        });
        Ok(parsed.access_token)
    }

    async fn authorized(&self, request: reqwest::RequestBuilder) -> Result<reqwest::RequestBuilder, StoreError> {
        let token = self.access_token().await?;
        Ok(request.bearer_auth(token))
    }

    /// Read a document; `Ok(None)` on 404.
    pub async fn get_document(&self, path: &str) -> Result<Option<Value>, StoreError> {
        let request = self.authorized(self.http.get(path)).await?;
        let response = request
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore read failed: {error}")))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore read failed: {error}")))?;
        if !status.is_success() {
            return Err(StoreError::Cache(format!(
                "Firestore read failed ({status}): {body}"
            )));
        }
        Ok(Some(document_to_value(&body)))
    }

    /// Read a document inside an open transaction.
    pub async fn get_document_in_transaction(
        &self,
        path: &str,
        transaction: &str,
    ) -> Result<Option<Value>, StoreError> {
        let url = format!("{}/../documents:batchGet", self.base);
        let request = self.authorized(self.http.post(&url)).await?;
        let response = request
            .json(&json!({ "documents": [resource_name(path)], "transaction": transaction }))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore read failed: {error}")))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore read failed: {error}")))?;
        if !status.is_success() {
            return Err(StoreError::Cache(format!(
                "Firestore read failed ({status}): {body}"
            )));
        }
        let empty = Vec::new();
        let entries = body.as_array().unwrap_or(&empty);
        for entry in entries {
            if let Some(found) = entry.get("found") {
                return Ok(Some(document_to_value(found)));
            }
        }
        Ok(None)
    }

    /// `list_documents` (whole collection, optional page size).
    pub async fn list_documents(&self, collection: &str, page_size: u32) -> Result<Vec<Value>, StoreError> {
        let request = self.authorized(self.http.get(self.collection_url(collection))).await?;
        let response = request
            .query(&[("pageSize", page_size.to_string())])
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore list failed: {error}")))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore list failed: {error}")))?;
        if !status.is_success() {
            return Err(StoreError::Cache(format!(
                "Firestore list failed ({status}): {body}"
            )));
        }
        Ok(body
            .get("documents")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().map(document_to_value).collect())
            .unwrap_or_default())
    }

    /// Structured query: `runQuery`.
    pub async fn run_query(&self, query: &StructuredQuery) -> Result<Vec<Value>, StoreError> {
        let url = format!("{}/../documents:runQuery", self.base);
        let request = self.authorized(self.http.post(&url)).await?;
        let mut body = json!({ "structuredQuery": query.to_json() });
        if let Some(parent) = &query.parent_document {
            body["parent"] = Value::String(parent.clone());
        }
        let response = request
            .json(&body)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore query failed: {error}")))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore query failed: {error}")))?;
        if !status.is_success() {
            return Err(StoreError::Cache(format!(
                "Firestore query failed ({status}): {body}"
            )));
        }
        let empty = Vec::new();
        let rows = body.as_array().unwrap_or(&empty);
        Ok(rows
            .iter()
            .filter_map(|row| row.get("document"))
            .map(document_to_value)
            .collect())
    }

    /// Create a document (`createDocument`), failing on an existing id.
    pub async fn create_document(&self, collection: &str, id: &str, value: &Value) -> Result<Value, StoreError> {
        let url = format!("{}?documentId={id}", self.collection_url(collection));
        let request = self.authorized(self.http.post(&url)).await?;
        let response = request
            .json(&json!({ "fields": value_to_fields(value) }))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore create failed: {error}")))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore create failed: {error}")))?;
        if !status.is_success() {
            return Err(StoreError::Conflict(if status == reqwest::StatusCode::CONFLICT {
                "document already exists".to_string()
            } else {
                format!("Firestore create failed ({status}): {body}")
            }));
        }
        Ok(document_to_value(&body))
    }

    /// Create a document inside a parent document's sub-collection.
    pub async fn create_document_in_parent(
        &self,
        parent: &str,
        collection: &str,
        id: &str,
        value: &Value,
    ) -> Result<Value, StoreError> {
        let url = format!("{parent}/{collection}?documentId={id}");
        let request = self.authorized(self.http.post(&url)).await?;
        let response = request
            .json(&json!({ "fields": value_to_fields(value) }))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore create failed: {error}")))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore create failed: {error}")))?;
        if !status.is_success() {
            return Err(StoreError::Conflict(if status == reqwest::StatusCode::CONFLICT {
                "document already exists".to_string()
            } else {
                format!("Firestore create failed ({status}): {body}")
            }));
        }
        Ok(document_to_value(&body))
    }

    /// `patch` with an optional update mask (`updateMask.fieldPaths`).
    ///
    /// Like Firestore's own PATCH (and Node `.set(..., { merge: true })`), a
    /// missing document is created; the fields in the mask are merged into an
    /// existing one. Use [`FirestoreClient::create_document`] when the write
    /// must fail if the document already exists.
    pub async fn update_document(
        &self,
        path: &str,
        value: &Value,
        update_mask: Option<&[&str]>,
    ) -> Result<Value, StoreError> {
        let request = self.authorized(self.http.patch(path)).await?;
        let mut request = request;
        if let Some(mask) = update_mask {
            for field in mask {
                request = request.query(&[("updateMask.fieldPaths", *field)]);
            }
        }
        let response = request
            .json(&json!({ "fields": value_to_fields(value) }))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore write failed: {error}")))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore write failed: {error}")))?;
        if !status.is_success() {
            return Err(StoreError::Cache(format!(
                "Firestore write failed ({status}): {body}"
            )));
        }
        Ok(document_to_value(&body))
    }

    /// Merge-write a document (what `.set(..., { merge: true })` does).
    pub async fn set_document(&self, path: &str, value: &Value) -> Result<Value, StoreError> {
        let fields = value_to_fields(value);
        let mask: Vec<&str> = fields.keys().map(|key| key.as_str()).collect();
        self.update_document(path, value, Some(&mask)).await
    }

    pub async fn upsert_document(&self, path: &str, value: &Value) -> Result<Value, StoreError> {
        let request = self.authorized(self.http.patch(path)).await?;
        let response = request
            .json(&json!({ "fields": value_to_fields(value) }))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore write failed: {error}")))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore write failed: {error}")))?;
        if !status.is_success() {
            return Err(StoreError::Cache(format!(
                "Firestore write failed ({status}): {body}"
            )));
        }
        Ok(document_to_value(&body))
    }

    pub async fn delete_document(&self, path: &str) -> Result<bool, StoreError> {
        let request = self.authorized(self.http.delete(path)).await?;
        let response = request
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore delete failed: {error}")))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(false);
        }
        if !response.status().is_success() {
            return Err(StoreError::Cache(format!(
                "Firestore delete failed ({})",
                response.status()
            )));
        }
        Ok(true)
    }

    /// Begin a Firestore transaction and return its id.
    pub async fn begin_transaction(&self) -> Result<String, StoreError> {
        let url = format!("{}/../documents:beginTransaction", self.base);
        let request = self.authorized(self.http.post(&url)).await?;
        let response = request
            .json(&json!({ "options": { "readWrite": {} } }))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore transaction failed: {error}")))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore transaction failed: {error}")))?;
        if !status.is_success() {
            return Err(StoreError::Cache(format!(
                "Firestore transaction failed ({status}): {body}"
            )));
        }
        body.get("transaction")
            .and_then(Value::as_str)
            .map(|value| value.to_string())
            .ok_or_else(|| StoreError::Cache("Firestore returned no transaction id".into()))
    }

    pub async fn rollback(&self, transaction: &str) {
        let url = format!("{}/../documents:rollback", self.base);
        if let Ok(request) = self.authorized(self.http.post(&url)).await {
            let _ = request
                .json(&json!({ "transaction": transaction }))
                .send()
                .await;
        }
    }

    /// Commit a set of writes (optionally inside a transaction).
    pub async fn commit(
        &self,
        transaction: Option<&str>,
        writes: &[FirestoreWrite],
    ) -> Result<Value, StoreError> {
        let url = format!("{}/../documents:commit", self.base);
        let body = commit_body(transaction, writes);
        let request = self.authorized(self.http.post(&url)).await?;
        let response = request
            .json(&body)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore commit failed: {error}")))?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .map_err(|error| StoreError::Cache(format!("Firestore commit failed: {error}")))?;
        if !status.is_success() {
            return Err(StoreError::Cache(format!(
                "Firestore commit failed ({status}): {payload}"
            )));
        }
        Ok(payload)
    }

    /// Run a read-then-write transaction with one retry on a Firestore abort.
    pub async fn run_transaction<F>(&self, mut body: F) -> Result<Value, StoreError>
    where
        F: FnMut(String) -> futures_util::future::BoxFuture<'static, Result<Vec<FirestoreWrite>, StoreError>>,
    {
        for attempt in 0..2 {
            let transaction = self.begin_transaction().await?;
            let writes = match body(transaction.clone()).await {
                Ok(writes) => writes,
                Err(error) => {
                    self.rollback(&transaction).await;
                    return Err(error);
                }
            };
            match self.commit(Some(&transaction), &writes).await {
                Ok(result) => return Ok(result),
                Err(error) if attempt == 0 => {
                    tracing::warn!(%error, "Firestore transaction aborted; retrying once");
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        Err(StoreError::Cache("Firestore transaction retry exhausted".into()))
    }
}

impl std::fmt::Debug for FirestoreClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FirestoreClient")
            .field("project_id", &self.account.project_id)
            .finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------------------
// Value encoding
// ---------------------------------------------------------------------------

/// Encode a plain JSON object into Firestore `fields`.
pub fn value_to_fields(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object
            .iter()
            .map(|(key, entry)| (key.clone(), encode_value(entry)))
            .collect(),
        _ => Map::new(),
    }
}

/// Encode a single JSON value into a Firestore REST `Value`.
pub fn encode_value(value: &Value) -> Value {
    match value {
        Value::Null => json!({ "nullValue": null }),
        Value::Bool(flag) => json!({ "booleanValue": flag }),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                json!({ "integerValue": int.to_string() })
            } else if let Some(unsigned) = number.as_u64() {
                json!({ "integerValue": unsigned.to_string() })
            } else {
                json!({ "doubleValue": number.as_f64().unwrap_or(0.0) })
            }
        }
        // ISO-8601 strings are written as Firestore timestamps, matching the
        // Node writers that store `new Date().toISOString()` values.
        Value::String(text) if is_iso_timestamp(text) => json!({ "timestampValue": text }),
        Value::String(text) => json!({ "stringValue": text }),
        Value::Array(rows) => json!({
            "arrayValue": { "values": rows.iter().map(encode_value).collect::<Vec<_>>() }
        }),
        Value::Object(object) => json!({ "mapValue": { "fields": value_to_fields(&Value::Object(object.clone())) } }),
    }
}

fn is_iso_timestamp(text: &str) -> bool {
    text.len() >= 20
        && text.as_bytes().get(4) == Some(&b'-')
        && text.as_bytes().get(10) == Some(&b'T')
        && (text.ends_with('Z') || text.contains('+'))
        && chrono::DateTime::parse_from_rfc3339(text).is_ok()
}

/// Decode Firestore `fields` into a plain JSON object.
pub fn fields_to_value(fields: Option<&Value>) -> Value {
    let Some(Value::Object(object)) = fields else {
        return Value::Object(Map::new());
    };
    let mut out = Map::new();
    for (key, entry) in object {
        out.insert(key.clone(), decode_value(entry));
    }
    Value::Object(out)
}

/// Decode one Firestore REST `Value` into a plain JSON value.
pub fn decode_value(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return Value::Null;
    };
    if object.contains_key("nullValue") {
        return Value::Null;
    }
    if let Some(flag) = object.get("booleanValue").and_then(Value::as_bool) {
        return Value::Bool(flag);
    }
    if let Some(text) = object.get("integerValue").and_then(Value::as_str) {
        if let Ok(int) = text.parse::<i64>() {
            return json!(int);
        }
        if let Ok(unsigned) = text.parse::<u64>() {
            return json!(unsigned);
        }
        return json!(text);
    }
    if let Some(number) = object.get("doubleValue") {
        if let Some(value) = number.as_f64() {
            return json!(value);
        }
        if let Some(text) = number.as_str() {
            if let Ok(parsed) = text.parse::<f64>() {
                return json!(parsed);
            }
        }
    }
    if let Some(text) = object.get("timestampValue").and_then(Value::as_str) {
        return Value::String(text.to_string());
    }
    if let Some(text) = object.get("stringValue").and_then(Value::as_str) {
        return Value::String(text.to_string());
    }
    if let Some(text) = object.get("bytesValue").and_then(Value::as_str) {
        return Value::String(text.to_string());
    }
    if let Some(text) = object.get("referenceValue").and_then(Value::as_str) {
        return Value::String(text.to_string());
    }
    if let Some(array) = object.get("arrayValue") {
        let empty = Vec::new();
        let rows = array
            .get("values")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        return Value::Array(rows.iter().map(decode_value).collect());
    }
    if object.contains_key("mapValue") {
        return fields_to_value(object.get("mapValue").and_then(|map| map.get("fields")));
    }
    Value::Null
}

/// Turn a Firestore document resource into `{ id, ...fields }`.
pub fn document_to_value(document: &Value) -> Value {
    let mut payload = fields_to_value(document.get("fields"));
    if let Some(name) = document.get("name").and_then(Value::as_str) {
        if let Some(id) = name.rsplit('/').next() {
            if let Some(object) = payload.as_object_mut() {
                object.insert("id".into(), Value::String(id.to_string()));
            }
        }
    }
    let create_time = document.get("createTime").and_then(Value::as_str);
    let update_time = document.get("updateTime").and_then(Value::as_str);
    if let Some(object) = payload.as_object_mut() {
        if let Some(create) = create_time {
            object.insert("createTime".into(), Value::String(create.to_string()));
        }
        if let Some(update) = update_time {
            object.insert("updateTime".into(), Value::String(update.to_string()));
        }
    }
    payload
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum FilterOp {
    Equal,
    NotEqual,
    LessThan,
    LessThanOrEqual,
    GreaterThan,
    GreaterThanOrEqual,
    ArrayContains,
    In,
    NotIn,
    IsNull,
}

impl FilterOp {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Equal => "EQUAL",
            Self::NotEqual => "NOT_EQUAL",
            Self::LessThan => "LESS_THAN",
            Self::LessThanOrEqual => "LESS_THAN_OR_EQUAL",
            Self::GreaterThan => "GREATER_THAN",
            Self::GreaterThanOrEqual => "GREATER_THAN_OR_EQUAL",
            Self::ArrayContains => "ARRAY_CONTAINS",
            Self::In => "IN",
            Self::NotIn => "NOT_IN",
            Self::IsNull => "IS_NULL",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Filter {
    pub field: String,
    pub op: FilterOp,
    pub value: Value,
}

impl Filter {
    pub fn new(field: impl Into<String>, op: FilterOp, value: Value) -> Self {
        Self {
            field: field.into(),
            op,
            value,
        }
    }
    pub fn equal(field: impl Into<String>, value: Value) -> Self {
        Self::new(field, FilterOp::Equal, value)
    }
    pub fn to_json(&self) -> Value {
        json!({
            "fieldFilter": {
                "field": { "fieldPath": self.field },
                "op": self.op.as_str(),
                "value": encode_value(&self.value),
            }
        })
    }
}

#[derive(Debug, Clone)]
pub struct OrderBy {
    pub field: String,
    pub descending: bool,
}

impl OrderBy {
    pub fn new(field: impl Into<String>, descending: bool) -> Self {
        Self {
            field: field.into(),
            descending,
        }
    }
    pub fn to_json(&self) -> Value {
        json!({
            "field": { "fieldPath": self.field },
            "direction": if self.descending { "DESCENDING" } else { "ASCENDING" },
        })
    }
}

#[derive(Debug, Clone)]
pub struct StructuredQuery {
    pub collection: String,
    pub filters: Vec<Filter>,
    pub order_by: Vec<OrderBy>,
    pub limit: Option<u32>,
    pub parent_document: Option<String>,
}

impl StructuredQuery {
    pub fn collection(collection: impl Into<String>) -> Self {
        Self {
            collection: collection.into(),
            filters: Vec::new(),
            order_by: Vec::new(),
            limit: None,
            parent_document: None,
        }
    }

    pub fn where_eq(mut self, field: impl Into<String>, value: Value) -> Self {
        self.filters.push(Filter::equal(field, value));
        self
    }

    pub fn where_filter(mut self, filter: Filter) -> Self {
        self.filters.push(filter);
        self
    }

    pub fn order_by(mut self, field: impl Into<String>, descending: bool) -> Self {
        self.order_by.push(OrderBy::new(field, descending));
        self
    }

    pub fn limit(mut self, limit: u32) -> Self {
        self.limit = Some(limit);
        self
    }

    /// Sub-collection scope: `parent` is the full document path.
    pub fn parent(mut self, parent: impl Into<String>) -> Self {
        self.parent_document = Some(parent.into());
        self
    }

    /// Whether this query is scoped to a parent document's sub-collection.
    pub fn is_subcollection(&self) -> bool {
        self.parent_document.is_some()
    }

    pub fn to_json(&self) -> Value {
        let mut query = Map::new();
        query.insert(
            "from".into(),
            json!([{ "collectionId": self.collection }]),
        );
        if let Some(filter) = self.composite_filter() {
            query.insert("where".into(), filter);
        }
        if !self.order_by.is_empty() {
            query.insert(
                "orderBy".into(),
                Value::Array(self.order_by.iter().map(OrderBy::to_json).collect()),
            );
        }
        if let Some(limit) = self.limit {
            query.insert("limit".into(), json!(limit));
        }
        Value::Object(query)
    }

    /// Firestore requires a composite filter when more than one filter exists.
    pub fn composite_filter(&self) -> Option<Value> {
        match self.filters.len() {
            0 => None,
            1 => Some(self.filters[0].to_json()),
            _ => Some(json!({
                "compositeFilter": {
                    "op": "AND",
                    "filters": self.filters.iter().map(Filter::to_json).collect::<Vec<_>>(),
                }
            })),
        }
    }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/// A field transform applied inside a commit (`FieldValue.increment` /
/// `FieldValue.serverTimestamp()`).
#[derive(Debug, Clone)]
pub enum FieldTransform {
    ServerTimestamp(String),
    Increment { field: String, amount: i64 },
}

impl FieldTransform {
    fn to_json(&self, document: &str) -> Value {
        let field_transforms = match self {
            Self::ServerTimestamp(field) => json!([{
                "fieldPath": field,
                "setToServerValue": "REQUEST_TIME",
            }]),
            Self::Increment { field, amount } => json!([{
                "fieldPath": field,
                "increment": { "integerValue": amount.to_string() },
            }]),
        };
        json!({ "document": resource_name(document), "fieldTransforms": field_transforms })
    }
}

/// One Firestore write inside a commit.
#[derive(Debug, Clone)]
pub enum FirestoreWrite {
    /// Merge-write specific fields.
    Update {
        path: String,
        value: Value,
        update_mask: Option<Vec<String>>,
    },
    /// Full write, creating the document if needed.
    Set { path: String, value: Value },
    /// Create-only write (fails if the document exists).
    Create { path: String, value: Value },
    Delete { path: String },
    Transform { path: String, transform: FieldTransform },
}

impl FirestoreWrite {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Update {
                path,
                value,
                update_mask,
            } => {
                let mut write = Map::new();
                write.insert(
                    "update".into(),
                    json!({ "name": resource_name(path), "fields": value_to_fields(value) }),
                );
                if let Some(mask) = update_mask {
                    write.insert(
                        "updateMask".into(),
                        json!({ "fieldPaths": mask }),
                    );
                }
                Value::Object(write)
            }
            Self::Set { path, value } => json!({
                "update": { "name": resource_name(path), "fields": value_to_fields(value) }
            }),
            Self::Create { path, value } => json!({
                "update": { "name": resource_name(path), "fields": value_to_fields(value) },
                "currentDocument": { "exists": false },
            }),
            Self::Delete { path } => json!({ "delete": resource_name(path) }),
            Self::Transform { path, transform } => transform.to_json(path),
        }
    }
}

/// Firestore resource name for a document path: commit writes, transform
/// targets and transactional batchGet need `projects/{p}/databases/(default)/
/// documents/...`, never the REST URL that `document_path` builds for GETs.
pub fn resource_name(path: &str) -> String {
    match path.find("/projects/") {
        Some(at) if path.starts_with("http") => path[at + 1..].to_string(),
        _ => path.trim_start_matches('/').to_string(),
    }
}

pub fn commit_body(transaction: Option<&str>, writes: &[FirestoreWrite]) -> Value {
    let mut body = Map::new();
    body.insert(
        "writes".into(),
        Value::Array(writes.iter().map(FirestoreWrite::to_json).collect()),
    );
    if let Some(transaction) = transaction {
        body.insert("transaction".into(), Value::String(transaction.to_string()));
    }
    Value::Object(body)
}

/// Convenience: balance document fields for a wallet.
pub fn balance_document(available: i64, locked: i64, updated_at: &str) -> Value {
    json!({
        "availablePkn": available,
        "lockedPkn": locked,
        "updatedAt": updated_at,
    })
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FirestoreBalance {
    pub available_pkn: i64,
    pub locked_pkn: i64,
}

impl FirestoreBalance {
    pub fn from_document(document: &Value) -> Self {
        Self {
            available_pkn: document
                .get("availablePkn")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            locked_pkn: document.get("lockedPkn").and_then(Value::as_i64).unwrap_or(0),
        }
    }
}

/// Firestore transaction write limit is 500 per commit.
pub const MAX_WRITES_PER_COMMIT: usize = 500;

impl StoreError {
    pub fn as_api(&self) -> ApiError {
        match self {
            StoreError::Cache(message) => ApiError::unavailable(message.clone()),
            other => ApiError::from(other.clone()),
        }
    }
}

impl Clone for StoreError {
    fn clone(&self) -> Self {
        match self {
            StoreError::Database(error) => StoreError::Cache(format!("database error: {error}")),
            StoreError::Cache(message) => StoreError::Cache(message.clone()),
            StoreError::Upstream(message) => StoreError::Upstream(message.clone()),
            StoreError::Conflict(message) => StoreError::Conflict(message.clone()),
            StoreError::NotFound(message) => StoreError::NotFound(message.clone()),
            StoreError::Insufficient => StoreError::Insufficient,
            StoreError::Forbidden(message) => StoreError::Forbidden(message.clone()),
            StoreError::Invalid(message) => StoreError::Invalid(message.clone()),
        }
    }
}

/// Small helper for callers that want a `HashMap` view of a document.
pub fn document_fields(document: &Value) -> HashMap<String, Value> {
    document
        .as_object()
        .map(|object| object.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> ServiceAccount {
        ServiceAccount {
            project_id: "pokoin-test".into(),
            client_email: "svc@pokoin-test.iam.gserviceaccount.com".into(),
            private_key_pem: String::new(),
        }
    }

    #[test]
    fn pem_normalization_restores_newlines() {
        assert_eq!(normalize_pem("a\\nb\\nc"), "a\nb\nc");
        assert_eq!(normalize_pem("already\nfine"), "already\nfine");
    }

    #[test]
    fn document_paths_match_the_firestore_contract() {
        let client = FirestoreClient::with_base(
            reqwest::Client::new(),
            account(),
            "https://example.test/v1/projects/p/databases/(default)/documents",
        );
        assert_eq!(
            client.document_path("balances", "uid-1"),
            "https://example.test/v1/projects/p/databases/(default)/documents/balances/uid-1"
        );
        assert_eq!(
            client.nested_path(("users", "uid-1"), "shipping_addresses", "addr-1"),
            "https://example.test/v1/projects/p/databases/(default)/documents/users/uid-1/shipping_addresses/addr-1"
        );
        assert_eq!(client.project_id(), "pokoin-test");
    }

    #[test]
    fn values_round_trip_through_the_firestore_encoding() {
        let value = json!({
            "availablePkn": 250,
            "lockedPkn": 0,
            "ratio": 1.5,
            "active": true,
            "note": "hello",
            "nothing": null,
            "tags": ["a", "b"],
            "nested": { "uid": "u1", "amountPkn": -5 },
        });
        let fields = value_to_fields(&value);
        assert_eq!(fields["availablePkn"], json!({ "integerValue": "250" }));
        assert_eq!(fields["ratio"], json!({ "doubleValue": 1.5 }));
        assert_eq!(fields["active"], json!({ "booleanValue": true }));
        assert_eq!(fields["note"], json!({ "stringValue": "hello" }));
        assert_eq!(fields["nothing"], json!({ "nullValue": null }));

        let decoded = fields_to_value(Some(&Value::Object(fields)));
        assert_eq!(decoded, value);
    }

    #[test]
    fn iso_strings_become_firestore_timestamps() {
        let fields = value_to_fields(&json!({
            "updatedAt": "2026-10-08T10:00:00.000Z",
            "plain": "2026-10-08",
        }));
        assert_eq!(
            fields["updatedAt"],
            json!({ "timestampValue": "2026-10-08T10:00:00.000Z" })
        );
        assert_eq!(fields["plain"], json!({ "stringValue": "2026-10-08" }));
    }

    #[test]
    fn documents_decode_with_their_document_id() {
        let document = json!({
            "name": "projects/p/databases/(default)/documents/balances/uid-1",
            "fields": { "availablePkn": { "integerValue": "7" } },
            "updateTime": "2026-10-08T10:00:00Z",
        });
        let decoded = document_to_value(&document);
        assert_eq!(decoded["id"], json!("uid-1"));
        assert_eq!(decoded["availablePkn"], json!(7));
        assert_eq!(decoded["updateTime"], json!("2026-10-08T10:00:00Z"));
    }

    #[test]
    fn balance_documents_use_the_node_field_names() {
        let document = json!({ "availablePkn": 42, "lockedPkn": 8 });
        let balance = FirestoreBalance::from_document(&document);
        assert_eq!(balance.available_pkn, 42);
        assert_eq!(balance.locked_pkn, 8);
        assert_eq!(
            balance_document(42, 8, "2026-10-08T10:00:00Z"),
            json!({
                "availablePkn": 42,
                "lockedPkn": 8,
                "updatedAt": "2026-10-08T10:00:00Z",
            })
        );
    }

    #[test]
    fn single_and_composite_queries_are_shaped_correctly() {
        let single = StructuredQuery::collection("orders").where_eq("buyerUid", json!("u1"));
        assert_eq!(
            single.to_json()["where"],
            json!({
                "fieldFilter": {
                    "field": { "fieldPath": "buyerUid" },
                    "op": "EQUAL",
                    "value": { "stringValue": "u1" },
                }
            })
        );

        let composite = StructuredQuery::collection("money_requests")
            .where_eq("toUid", json!("u1"))
            .where_eq("status", json!("pending"))
            .order_by("createdAt", true)
            .limit(50);
        let json = composite.to_json();
        assert_eq!(json["where"]["compositeFilter"]["op"], json!("AND"));
        assert_eq!(json["where"]["compositeFilter"]["filters"].as_array().unwrap().len(), 2);
        assert_eq!(json["orderBy"][0]["direction"], json!("DESCENDING"));
        assert_eq!(json["limit"], json!(50));
        assert_eq!(json["from"][0]["collectionId"], json!("money_requests"));

        let in_filter = Filter::new("uid", FilterOp::In, json!(["a", "b"]));
        assert_eq!(in_filter.to_json()["fieldFilter"]["op"], json!("IN"));
        assert!(StructuredQuery::collection("x").composite_filter().is_none());
    }

    #[test]
    fn transaction_writes_cover_set_create_delete_and_transforms() {
        let path = "projects/p/databases/(default)/documents/balances/u1";
        let update = FirestoreWrite::Update {
            path: path.into(),
            value: json!({ "availablePkn": 10 }),
            update_mask: Some(vec!["availablePkn".into()]),
        };
        let json = update.to_json();
        assert_eq!(json["update"]["fields"]["availablePkn"], json!({ "integerValue": "10" }));
        assert_eq!(json["updateMask"]["fieldPaths"][0], json!("availablePkn"));

        let create = FirestoreWrite::Create {
            path: path.into(),
            value: json!({ "uid": "u1" }),
        };
        assert_eq!(create.to_json()["currentDocument"]["exists"], json!(false));

        let delete = FirestoreWrite::Delete { path: path.into() };
        assert_eq!(delete.to_json()["delete"], json!(path));

        let stamp = FirestoreWrite::Transform {
            path: path.into(),
            transform: FieldTransform::ServerTimestamp("updatedAt".into()),
        };
        assert_eq!(
            stamp.to_json()["fieldTransforms"][0]["setToServerValue"],
            json!("REQUEST_TIME")
        );

        let increment = FirestoreWrite::Transform {
            path: path.into(),
            transform: FieldTransform::Increment {
                field: "availablePkn".into(),
                amount: 5,
            },
        };
        assert_eq!(
            increment.to_json()["fieldTransforms"][0]["increment"]["integerValue"],
            json!("5")
        );
    }

    #[test]
    fn commit_body_carries_the_transaction_id() {
        let writes = vec![FirestoreWrite::Delete {
            path: "projects/p/databases/(default)/documents/x/1".into(),
        }];
        let body = commit_body(Some("txn-1"), &writes);
        assert_eq!(body["transaction"], json!("txn-1"));
        assert_eq!(body["writes"].as_array().unwrap().len(), 1);
        assert!(commit_body(None, &writes).get("transaction").is_none());
    }

    #[test]
    fn oauth_assertion_requires_a_real_private_key() {
        let account = account();
        let error = oauth_assertion(&account, 1_700_000_000, 3600).unwrap_err();
        assert!(error.to_string().contains("private key"));
    }

    #[test]
    fn the_commit_write_limit_matches_firestore() {
        assert_eq!(MAX_WRITES_PER_COMMIT, 500);
    }
}

#[cfg(test)]
mod resource_name_tests {
    use super::resource_name;

    #[test]
    fn rest_urls_become_resource_names() {
        assert_eq!(
            resource_name("https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/orders/o1"),
            "projects/p/databases/(default)/documents/orders/o1"
        );
        assert_eq!(
            resource_name("projects/p/databases/(default)/documents/orders/o1"),
            "projects/p/databases/(default)/documents/orders/o1"
        );
    }
}
