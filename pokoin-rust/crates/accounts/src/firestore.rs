//! Firestore REST client: typed values, documents, queries and transactions.
//!
//! The Node runtime used the Firebase Admin SDK's Firestore API. This module
//! reproduces the parts that surface uses, natively over the documented REST
//! API:
//!
//! * [`Value`] / [`DocData`] — the typed-value encoding (`stringValue`,
//!   `integerValue`, `mapValue`, …) and the write-time transforms
//!   (`serverTimestamp` → `REQUEST_TIME`, `increment`, array union/remove).
//! * [`Document`] / [`DocumentRef`] — `get`, `set(merge)`, `create`, `update`,
//!   `delete` and generated-id `add`.
//! * [`Query`] — structured queries with field filters, ordering and limits.
//! * [`Transaction`] / [`Firestore::run_transaction`] — `beginTransaction` /
//!   `commit` / `rollback` with a retry on `ABORTED`, so a lost race re-runs
//!   the whole body instead of silently half-applying writes.
//!
//! Every call goes through [`HttpTransport`], so the encoding, retry and
//! transaction logic is unit-testable with a scripted transport and no network.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

use crate::error::{ApiError, Result};
use crate::firebase::{google_error_message, ServiceAccount};
use crate::http::{send_with_retry, HttpRequest, HttpResponse, RetryPolicy, SharedTransport};

// ---------------------------------------------------------------------------
// Ordered map
// ---------------------------------------------------------------------------

/// Small insertion-ordered string-keyed map.
///
/// `serde_json::Map` can only hold `serde_json::Value`, so the typed layers
/// carry their own map. Insertion order matters: it keeps the encoded
/// documents byte-stable, which makes the REST tests deterministic.
#[derive(Debug, Clone, PartialEq)]
pub struct OrderedMap<T> {
    entries: Vec<(String, T)>,
}

// Hand-written so `DocData` can derive `Default` without requiring
// `FieldValue: Default` (there is no sensible default transform).
impl<T> Default for OrderedMap<T> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}

impl<T> OrderedMap<T> {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn from_entries(entries: Vec<(String, T)>) -> Self {
        Self { entries }
    }

    /// Insert, replacing an existing key in place (keeping its position).
    pub fn insert(&mut self, key: String, value: T) -> Option<T> {
        if let Some(slot) = self.entries.iter_mut().find(|(name, _)| *name == key) {
            return Some(std::mem::replace(&mut slot.1, value));
        }
        self.entries.push((key, value));
        None
    }

    pub fn get(&self, key: &str) -> Option<&T> {
        self.entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut T> {
        self.entries
            .iter_mut()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn remove(&mut self, key: &str) -> Option<T> {
        let index = self.entries.iter().position(|(name, _)| name == key)?;
        Some(self.entries.remove(index).1)
    }

    pub fn iter(&self) -> std::slice::Iter<'_, (String, T)> {
        self.entries.iter()
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.entries.iter().map(|(key, _)| key)
    }

    pub fn values(&self) -> impl Iterator<Item = &T> {
        self.entries.iter().map(|(_, value)| value)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl<T> FromIterator<(String, T)> for OrderedMap<T> {
    fn from_iter<I: IntoIterator<Item = (String, T)>>(iter: I) -> Self {
        Self {
            entries: iter.into_iter().collect(),
        }
    }
}

impl<T> IntoIterator for OrderedMap<T> {
    type Item = (String, T);
    type IntoIter = std::vec::IntoIter<(String, T)>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

impl<'a, T> IntoIterator for &'a OrderedMap<T> {
    type Item = &'a (String, T);
    type IntoIter = std::slice::Iter<'a, (String, T)>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.iter()
    }
}

// ---------------------------------------------------------------------------
// Typed values
// ---------------------------------------------------------------------------

/// A Firestore field value.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Boolean(bool),
    Integer(i64),
    Double(f64),
    Timestamp(chrono::DateTime<chrono::Utc>),
    String(String),
    Bytes(Vec<u8>),
    Reference(String),
    GeoPoint { latitude: f64, longitude: f64 },
    Array(Vec<Value>),
    Map(OrderedMap<Value>),
}

impl Default for Value {
    fn default() -> Self {
        Value::Null
    }
}

impl From<String> for Value {
    fn from(value: String) -> Self {
        Value::String(value)
    }
}

impl From<&str> for Value {
    fn from(value: &str) -> Self {
        Value::String(value.to_string())
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Value::Boolean(value)
    }
}

impl From<i64> for Value {
    fn from(value: i64) -> Self {
        Value::Integer(value)
    }
}

impl From<f64> for Value {
    fn from(value: f64) -> Self {
        Value::Double(value)
    }
}

impl Value {
    pub fn string(value: impl Into<String>) -> Self {
        Value::String(value.into())
    }

    pub fn timestamp_from_millis(millis: i64) -> Self {
        Value::Timestamp(
            chrono::DateTime::from_timestamp_millis(millis)
                .unwrap_or_else(|| chrono::DateTime::from_timestamp_millis(0).expect("epoch")),
        )
    }

    pub fn map(entries: impl IntoIterator<Item = (String, Value)>) -> Self {
        Value::Map(entries.into_iter().collect())
    }

    pub fn to_json(&self) -> Json {
        match self {
            Value::Null => json!({ "nullValue": Json::Null }),
            Value::Boolean(value) => json!({ "booleanValue": value }),
            // Firestore transports int64 as a string.
            Value::Integer(value) => json!({ "integerValue": value.to_string() }),
            Value::Double(value) => json!({ "doubleValue": value }),
            Value::Timestamp(value) => json!({ "timestampValue": rfc3339(value) }),
            Value::String(value) => json!({ "stringValue": value }),
            Value::Bytes(value) => json!({ "bytesValue": base64_encode(value) }),
            Value::Reference(value) => json!({ "referenceValue": value }),
            Value::GeoPoint {
                latitude,
                longitude,
            } => json!({
                "geoPointValue": { "latitude": latitude, "longitude": longitude }
            }),
            Value::Array(values) => json!({
                "arrayValue": { "values": values.iter().map(Value::to_json).collect::<Vec<_>>() }
            }),
            Value::Map(fields) => {
                let mut encoded = serde_json::Map::new();
                for (key, value) in fields.iter() {
                    encoded.insert(key.clone(), value.to_json());
                }
                json!({ "mapValue": { "fields": encoded } })
            }
        }
    }

    pub fn from_json(value: &Json) -> Self {
        let Some(object) = value.as_object() else {
            return Value::Null;
        };
        if object.contains_key("nullValue") {
            return Value::Null;
        }
        if let Some(inner) = object.get("booleanValue").and_then(Json::as_bool) {
            return Value::Boolean(inner);
        }
        if let Some(inner) = object.get("integerValue") {
            // Admin SDK accepts both a string and a bare number.
            if let Some(text) = inner.as_str() {
                if let Ok(parsed) = text.parse::<i64>() {
                    return Value::Integer(parsed);
                }
                if let Ok(parsed) = text.parse::<f64>() {
                    return Value::Double(parsed);
                }
            }
            if let Some(number) = inner.as_i64() {
                return Value::Integer(number);
            }
        }
        if let Some(inner) = object.get("doubleValue") {
            if let Some(number) = inner.as_f64() {
                return Value::Double(number);
            }
            if let Some(text) = inner.as_str() {
                // `"NaN"`, `"Infinity"` and `"-Infinity"` are legal doubles.
                match text {
                    "NaN" => return Value::Double(f64::NAN),
                    "Infinity" => return Value::Double(f64::INFINITY),
                    "-Infinity" => return Value::Double(f64::NEG_INFINITY),
                    other => {
                        if let Ok(number) = other.parse::<f64>() {
                            return Value::Double(number);
                        }
                    }
                }
            }
        }
        if let Some(inner) = object.get("timestampValue").and_then(Json::as_str) {
            if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(inner) {
                return Value::Timestamp(parsed.with_timezone(&chrono::Utc));
            }
            return Value::Null;
        }
        if let Some(inner) = object.get("stringValue").and_then(Json::as_str) {
            return Value::String(inner.to_string());
        }
        if let Some(inner) = object.get("bytesValue").and_then(Json::as_str) {
            return Value::Bytes(base64_decode(inner).unwrap_or_default());
        }
        if let Some(inner) = object.get("referenceValue").and_then(Json::as_str) {
            return Value::Reference(inner.to_string());
        }
        if let Some(point) = object.get("geoPointValue").and_then(Json::as_object) {
            return Value::GeoPoint {
                latitude: point.get("latitude").and_then(Json::as_f64).unwrap_or(0.0),
                longitude: point
                    .get("longitude")
                    .and_then(Json::as_f64)
                    .unwrap_or(0.0),
            };
        }
        if let Some(array) = object.get("arrayValue").and_then(Json::as_object) {
            let values = array
                .get("values")
                .and_then(Json::as_array)
                .map(|values| values.iter().map(Value::from_json).collect())
                .unwrap_or_default();
            return Value::Array(values);
        }
        if let Some(map) = object.get("mapValue").and_then(Json::as_object) {
            let fields = map
                .get("fields")
                .and_then(Json::as_object)
                .map(|fields| {
                    fields
                        .iter()
                        .map(|(key, value)| (key.clone(), Value::from_json(value)))
                        .collect::<OrderedMap<Value>>()
                })
                .unwrap_or_default();
            return Value::Map(fields);
        }
        Value::Null
    }

    /// Decode **plain** JSON (not the Firestore typed wire shape) into typed
    /// values. This is what Node `docRef.set({...})` did with a JS object.
    pub fn from_plain_json(value: &Json) -> Self {
        match value {
            Json::Null => Value::Null,
            Json::Bool(inner) => Value::Boolean(*inner),
            Json::Number(inner) => {
                if let Some(integer) = inner.as_i64() {
                    Value::Integer(integer)
                } else {
                    Value::Double(inner.as_f64().unwrap_or(0.0))
                }
            }
            Json::String(inner) => Value::String(inner.clone()),
            Json::Array(items) => Value::Array(items.iter().map(Value::from_plain_json).collect()),
            Json::Object(map) => Value::Map(
                map.iter()
                    .map(|(key, value)| (key.clone(), Value::from_plain_json(value)))
                    .collect(),
            ),
        }
    }

    /// Plain JSON view (used when a handler returns a document to the client).
    pub fn to_plain_json(&self) -> Json {
        match self {
            Value::Null => Json::Null,
            Value::Boolean(value) => json!(value),
            Value::Integer(value) => json!(value),
            Value::Double(value) => json!(value),
            Value::Timestamp(value) => json!(rfc3339(value)),
            Value::String(value) => json!(value),
            Value::Bytes(value) => json!(base64_encode(value)),
            Value::Reference(value) => json!(value),
            Value::GeoPoint {
                latitude,
                longitude,
            } => json!({ "latitude": latitude, "longitude": longitude }),
            Value::Array(values) => Json::Array(values.iter().map(Value::to_plain_json).collect()),
            Value::Map(fields) => {
                let mut object = serde_json::Map::new();
                for (key, value) in fields.iter() {
                    object.insert(key.clone(), value.to_plain_json());
                }
                Json::Object(object)
            }
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Boolean(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Integer(value) => Some(*value),
            Value::Double(value) => Some(*value as i64),
            Value::String(value) => value.parse().ok(),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Integer(value) => Some(*value as f64),
            Value::Double(value) => Some(*value),
            Value::String(value) => value.parse().ok(),
            _ => None,
        }
    }

    /// Milliseconds since epoch, matching Node `Timestamp.toMillis()`.
    pub fn as_timestamp_millis(&self) -> Option<i64> {
        match self {
            Value::Timestamp(value) => Some(value.timestamp_millis()),
            Value::Integer(value) => Some(*value),
            Value::Double(value) => Some(*value as i64),
            Value::String(value) => chrono::DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|parsed| parsed.timestamp_millis()),
            _ => None,
        }
    }

    pub fn as_map(&self) -> Option<&OrderedMap<Value>> {
        match self {
            Value::Map(fields) => Some(fields),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Array(values) => Some(values),
            _ => None,
        }
    }

    /// `Value::String` or empty, mirroring `String(x || '')` on the Node side.
    pub fn as_str_or_empty(&self) -> &str {
        self.as_str().unwrap_or("")
    }

    /// Truthiness used by the Node `Boolean(x)` and `x === true` checks.
    pub fn is_true(&self) -> bool {
        self.as_bool().unwrap_or(false)
    }
}

fn rfc3339(value: &chrono::DateTime<chrono::Utc>) -> String {
    // Firestore wants microsecond precision and a trailing Z.
    value.to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

// ---------------------------------------------------------------------------
// Write-time transforms
// ---------------------------------------------------------------------------

/// A field value plus the write-time transforms the Admin SDK exposes.
#[derive(Debug, Clone, PartialEq)]
pub enum FieldValue {
    Value(Value),
    /// `FieldValue.serverTimestamp()` → `REQUEST_TIME` transform.
    ServerTimestamp,
    /// `FieldValue.increment(n)`.
    Increment(Value),
    /// `FieldValue.arrayUnion(...)`.
    ArrayUnion(Vec<Value>),
    /// `FieldValue.arrayRemove(...)`.
    ArrayRemove(Vec<Value>),
}

impl From<Value> for FieldValue {
    fn from(value: Value) -> Self {
        FieldValue::Value(value)
    }
}

impl From<&str> for FieldValue {
    fn from(value: &str) -> Self {
        FieldValue::Value(Value::String(value.to_string()))
    }
}

impl From<String> for FieldValue {
    fn from(value: String) -> Self {
        FieldValue::Value(Value::String(value))
    }
}

impl From<bool> for FieldValue {
    fn from(value: bool) -> Self {
        FieldValue::Value(Value::Boolean(value))
    }
}

impl From<i64> for FieldValue {
    fn from(value: i64) -> Self {
        FieldValue::Value(Value::Integer(value))
    }
}

impl From<f64> for FieldValue {
    fn from(value: f64) -> Self {
        FieldValue::Value(Value::Double(value))
    }
}

/// Document data for a write: fields plus their transforms.
#[derive(Debug, Clone, Default)]
pub struct DocData {
    pub fields: OrderedMap<FieldValue>,
}

impl DocData {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build from **plain** JSON, the way Node `docRef.set({...})` encoded a JS
    /// object. `null` stays a null field. Use [`DocData::set`] with
    /// [`FieldValue::ServerTimestamp`]/[`FieldValue::Increment`] for transforms.
    pub fn from_json(value: &Json) -> Self {
        let mut data = DocData::new();
        if let Some(object) = value.as_object() {
            for (key, value) in object {
                data = data.set(key.clone(), FieldValue::Value(Value::from_plain_json(value)));
            }
        }
        data
    }

    /// Decode the Firestore **typed** wire shape (e.g. `{"stringValue": "x"}`).
    pub fn from_typed_json(value: &Json) -> Self {
        let mut data = DocData::new();
        if let Some(object) = value.as_object() {
            for (key, value) in object {
                data = data.set(key.clone(), FieldValue::Value(Value::from_json(value)));
            }
        }
        data
    }

    pub fn set(mut self, key: impl Into<String>, value: impl Into<FieldValue>) -> Self {
        self.fields.insert(key.into(), value.into());
        self
    }

    pub fn string(self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.set(key, value.into())
    }

    pub fn optional_string(self, key: impl Into<String>, value: Option<String>) -> Self {
        match value {
            Some(value) => self.set(key, value),
            None => self.set(key, Value::Null),
        }
    }

    pub fn bool(self, key: impl Into<String>, value: bool) -> Self {
        self.set(key, value)
    }

    pub fn int(self, key: impl Into<String>, value: i64) -> Self {
        self.set(key, value)
    }

    pub fn double(self, key: impl Into<String>, value: f64) -> Self {
        self.set(key, value)
    }

    pub fn server_timestamp(self, key: impl Into<String>) -> Self {
        self.set(key, FieldValue::ServerTimestamp)
    }

    pub fn increment(self, key: impl Into<String>, delta: i64) -> Self {
        self.set(key, FieldValue::Increment(Value::Integer(delta)))
    }

    pub fn increment_double(self, key: impl Into<String>, delta: f64) -> Self {
        self.set(key, FieldValue::Increment(Value::Double(delta)))
    }

    pub fn array(self, key: impl Into<String>, values: Vec<Value>) -> Self {
        self.set(key, Value::Array(values))
    }

    pub fn map(self, key: impl Into<String>, fields: OrderedMap<Value>) -> Self {
        self.set(key, Value::Map(fields))
    }

    pub fn timestamp(self, key: impl Into<String>, millis: i64) -> Self {
        self.set(key, Value::timestamp_from_millis(millis))
    }

    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }

    /// Field paths present in this write, used to build an `updateMask` for a
    /// merge write.
    pub fn field_paths(&self) -> Vec<String> {
        self.fields.keys().cloned().collect()
    }

    fn plain_fields(&self) -> serde_json::Map<String, Json> {
        let mut encoded = serde_json::Map::new();
        for (key, value) in self.fields.iter() {
            if let FieldValue::Value(value) = value {
                encoded.insert(key.clone(), value.to_json());
            }
        }
        encoded
    }

    fn transforms(&self) -> Vec<Json> {
        let mut transforms = Vec::new();
        for (key, value) in self.fields.iter() {
            let transform = match value {
                FieldValue::Value(_) => continue,
                FieldValue::ServerTimestamp => {
                    json!({ "fieldPath": key, "setToServerValue": "REQUEST_TIME" })
                }
                FieldValue::Increment(amount) => {
                    json!({ "fieldPath": key, "increment": amount.to_json() })
                }
                FieldValue::ArrayUnion(values) => json!({
                    "fieldPath": key,
                    "appendMissingElements": {
                        "values": values.iter().map(Value::to_json).collect::<Vec<_>>()
                    }
                }),
                FieldValue::ArrayRemove(values) => json!({
                    "fieldPath": key,
                    "removeAllFromArray": {
                        "values": values.iter().map(Value::to_json).collect::<Vec<_>>()
                    }
                }),
            };
            transforms.push(transform);
        }
        transforms
    }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Document {
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "createTime")]
    pub create_time: Option<String>,
    #[serde(default, rename = "updateTime")]
    pub update_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<serde_json::Map<String, Json>>,
}

impl Document {
    /// Typed view of `fields`.
    pub fn values(&self) -> OrderedMap<Value> {
        self.fields
            .as_ref()
            .map(|fields| {
                fields
                    .iter()
                    .map(|(key, value)| (key.clone(), Value::from_json(value)))
                    .collect::<OrderedMap<Value>>()
            })
            .unwrap_or_default()
    }

    pub fn get(&self, field: &str) -> Option<Value> {
        self.fields
            .as_ref()
            .and_then(|fields| fields.get(field))
            .map(Value::from_json)
    }

    pub fn get_str(&self, field: &str) -> String {
        self.get(field)
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default()
    }

    pub fn get_i64(&self, field: &str) -> Option<i64> {
        self.get(field).and_then(|value| value.as_i64())
    }

    pub fn get_bool(&self, field: &str) -> Option<bool> {
        self.get(field).and_then(|value| value.as_bool())
    }

    pub fn get_timestamp_millis(&self, field: &str) -> Option<i64> {
        self.get(field).and_then(|value| value.as_timestamp_millis())
    }

    pub fn get_map(&self, field: &str) -> Option<OrderedMap<Value>> {
        self.get(field)
            .and_then(|value| value.as_map().cloned())
    }

    /// Plain JSON view of every field (timestamps as ISO strings, integers as
    /// numbers). Handy for the pure domain modules, which mirror the Node code
    /// that worked on `doc.data()`.
    pub fn to_plain_json(&self) -> Json {
        let mut object = serde_json::Map::new();
        for (key, value) in self.values().iter() {
            object.insert(key.clone(), value.to_plain_json());
        }
        Json::Object(object)
    }

    /// Document id (last path segment of `name`).
    pub fn id(&self) -> String {
        self.name.rsplit('/').next().unwrap_or("").to_string()
    }
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RunQueryResult {
    #[serde(default)]
    document: Option<Document>,
}

#[derive(Debug, Deserialize)]
struct BatchGetResult {
    #[serde(default)]
    found: Option<Document>,
}

#[derive(Debug, Deserialize)]
struct CommitResponse {
    #[serde(default, rename = "writeResults")]
    #[allow(dead_code)]
    write_results: Vec<Json>,
}

#[derive(Debug, Deserialize)]
struct OperationError {
    #[serde(default)]
    code: Option<i64>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BeginTransactionResponse {
    transaction: String,
}

/// How a Firestore REST call failed, so callers can branch on `NOT_FOUND`,
/// `ALREADY_EXISTS` and `ABORTED` the way the Node code branched on
/// `error.code`.
#[derive(Debug, Clone)]
pub struct FirestoreError {
    pub status: u16,
    pub code: Option<String>,
    pub message: String,
}

impl FirestoreError {
    pub fn not_found(&self) -> bool {
        self.status == 404 || self.code.as_deref() == Some("NOT_FOUND")
    }

    pub fn already_exists(&self) -> bool {
        self.code.as_deref() == Some("ALREADY_EXISTS")
            || (self.status == 409 && self.code.as_deref() != Some("ABORTED"))
    }

    pub fn aborted(&self) -> bool {
        (self.status == 409 && self.code.as_deref() == Some("ABORTED")) || self.status == 503
    }
}

impl std::fmt::Display for FirestoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Firestore request failed {}: {}",
            self.status, self.message
        )
    }
}

impl std::error::Error for FirestoreError {}

impl From<FirestoreError> for ApiError {
    fn from(error: FirestoreError) -> Self {
        // Keep the client-visible status the same as the Node runtime (500) but
        // mark transaction conflicts so `run_transaction` can retry them.
        if error.aborted() {
            ApiError::internal(format!("Firestore transaction aborted: {}", error.message))
        } else {
            ApiError::internal(error.message)
        }
    }
}

// ---------------------------------------------------------------------------
// References and queries
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Ascending,
    Descending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterOp {
    Equal,
    NotEqual,
    LessThan,
    LessThanOrEqual,
    GreaterThan,
    GreaterThanOrEqual,
    ArrayContains,
    ArrayContainsAny,
    In,
    NotIn,
}

impl FilterOp {
    fn as_str(&self) -> &'static str {
        match self {
            FilterOp::Equal => "EQUAL",
            FilterOp::NotEqual => "NOT_EQUAL",
            FilterOp::LessThan => "LESS_THAN",
            FilterOp::LessThanOrEqual => "LESS_THAN_OR_EQUAL",
            FilterOp::GreaterThan => "GREATER_THAN",
            FilterOp::GreaterThanOrEqual => "GREATER_THAN_OR_EQUAL",
            FilterOp::ArrayContains => "ARRAY_CONTAINS",
            FilterOp::ArrayContainsAny => "ARRAY_CONTAINS_ANY",
            FilterOp::In => "IN",
            FilterOp::NotIn => "NOT_IN",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Filter {
    pub field: String,
    pub op: FilterOp,
    pub value: Value,
}

fn filter_json(filter: &Filter) -> Json {
    json!({
        "fieldFilter": {
            "field": { "fieldPath": filter.field },
            "op": filter.op.as_str(),
            "value": filter.value.to_json(),
        }
    })
}

/// A structured query over one collection (optionally a subcollection).
#[derive(Debug, Clone, Default)]
pub struct Query {
    pub collection_path: String,
    pub filters: Vec<Filter>,
    pub order_by: Vec<(String, Direction)>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub start_after: Option<Vec<Value>>,
    /// `startAt(values, before)` — `before=true` is inclusive-at-start, which is
    /// what the Node `startAt()` prefix scans used.
    pub start_at: Option<(Vec<Value>, bool)>,
    /// `endAt(values, before)` — `before=false` makes the bound inclusive.
    pub end_at: Option<(Vec<Value>, bool)>,
}

impl Query {
    pub fn collection(path: impl Into<String>) -> Self {
        Self {
            collection_path: path.into(),
            ..Default::default()
        }
    }

    pub fn where_eq(mut self, field: impl Into<String>, value: impl Into<Value>) -> Self {
        self.filters.push(Filter {
            field: field.into(),
            op: FilterOp::Equal,
            value: value.into(),
        });
        self
    }

    pub fn where_op(
        mut self,
        field: impl Into<String>,
        op: FilterOp,
        value: impl Into<Value>,
    ) -> Self {
        self.filters.push(Filter {
            field: field.into(),
            op,
            value: value.into(),
        });
        self
    }

    pub fn order_by(mut self, field: impl Into<String>, direction: Direction) -> Self {
        self.order_by.push((field.into(), direction));
        self
    }

    pub fn limit(mut self, limit: i64) -> Self {
        self.limit = Some(limit);
        self
    }

    pub fn offset(mut self, offset: i64) -> Self {
        self.offset = Some(offset);
        self
    }

    pub fn start_after(mut self, values: Vec<Value>) -> Self {
        self.start_after = Some(values);
        self
    }

    /// `startAt(...)`. `before = true` makes the bound inclusive.
    pub fn start_at(mut self, values: Vec<Value>, before: bool) -> Self {
        self.start_at = Some((values, before));
        self
    }

    /// `endAt(...)`. `before = false` makes the bound inclusive.
    pub fn end_at(mut self, values: Vec<Value>, before: bool) -> Self {
        self.end_at = Some((values, before));
        self
    }

    /// Node `startAt(v)` — the bound is included.
    pub fn start_at_inclusive(self, values: Vec<Value>) -> Self {
        self.start_at(values, true)
    }

    /// Node `startAfter(v)` — the bound is excluded.
    pub fn start_after_exclusive(self, values: Vec<Value>) -> Self {
        self.start_at(values, false)
    }

    /// Node `endAt(v)` — the bound is included.
    pub fn end_at_inclusive(self, values: Vec<Value>) -> Self {
        self.end_at(values, false)
    }

    /// Node `endBefore(v)` — the bound is excluded.
    pub fn end_before_exclusive(self, values: Vec<Value>) -> Self {
        self.end_at(values, true)
    }

    /// The `\uf8ff` sentinel Node appended to build a Firestore prefix range.
    pub fn prefix_end(prefix: &str) -> String {
        format!("{prefix}\u{f8ff}")
    }

    /// Split `a/b/c` into `(parent = "a/b", collection = "c")`, the shape the
    /// REST `runQuery` call needs.
    pub fn parent_and_collection(&self) -> (String, String) {
        let mut segments: Vec<&str> = self
            .collection_path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect();
        let collection = segments.pop().unwrap_or("").to_string();
        (segments.join("/"), collection)
    }

    pub fn to_structured_query(&self) -> Json {
        let (_, collection) = self.parent_and_collection();
        let mut query = serde_json::Map::new();
        query.insert("from".into(), json!([{ "collectionId": collection }]));

        // One filter is a plain fieldFilter; several become an AND composite,
        // which is what chaining `.where()` in the Admin SDK produced.
        match self.filters.len() {
            0 => {}
            1 => {
                query.insert("where".into(), filter_json(&self.filters[0]));
            }
            _ => {
                query.insert(
                    "where".into(),
                    json!({
                        "compositeFilter": {
                            "op": "AND",
                            "filters": self.filters.iter().map(filter_json).collect::<Vec<_>>(),
                        }
                    }),
                );
            }
        }

        if !self.order_by.is_empty() {
            query.insert(
                "orderBy".into(),
                Json::Array(
                    self.order_by
                        .iter()
                        .map(|(field, direction)| {
                            json!({
                                "field": { "fieldPath": field },
                                "direction": match direction {
                                    Direction::Ascending => "ASCENDING",
                                    Direction::Descending => "DESCENDING",
                                }
                            })
                        })
                        .collect(),
                ),
            );
        }

        if let Some(limit) = self.limit {
            query.insert("limit".into(), json!(limit));
        }
        if let Some(offset) = self.offset {
            query.insert("offset".into(), json!(offset));
        }
        if let Some(values) = &self.start_after {
            query.insert(
                "startAt".into(),
                json!({
                    "values": values.iter().map(Value::to_json).collect::<Vec<_>>(),
                    "before": false,
                }),
            );
        }
        if let Some((values, before)) = &self.start_at {
            query.insert(
                "startAt".into(),
                json!({
                    "values": values.iter().map(Value::to_json).collect::<Vec<_>>(),
                    "before": before,
                }),
            );
        }
        if let Some((values, before)) = &self.end_at {
            query.insert(
                "endAt".into(),
                json!({
                    "values": values.iter().map(Value::to_json).collect::<Vec<_>>(),
                    "before": before,
                }),
            );
        }

        Json::Object(query)
    }

    fn run_query_url(&self, base: &str) -> String {
        let (parent, _) = self.parent_and_collection();
        if parent.is_empty() {
            format!("{base}:runQuery")
        } else {
            format!("{base}/{parent}:runQuery")
        }
    }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// Firestore REST client. Cheap to clone (one `Arc` inside).
#[derive(Clone)]
pub struct Firestore {
    inner: Arc<FirestoreInner>,
}

struct FirestoreInner {
    /// `.../projects/{p}/databases/(default)/documents`
    base: String,
    transport: SharedTransport,
    auth: Arc<ServiceAccount>,
    retry: RetryPolicy,
}

impl Firestore {
    pub fn new(
        config: &crate::config::AccountsConfig,
        transport: SharedTransport,
        auth: Arc<ServiceAccount>,
        retry: RetryPolicy,
    ) -> Self {
        Self {
            inner: Arc::new(FirestoreInner {
                base: config.firestore_base.trim_end_matches('/').to_string(),
                transport,
                auth,
                retry,
            }),
        }
    }

    pub fn base(&self) -> &str {
        &self.inner.base
    }

    /// Full resource name for a document path (`users/abc`).
    pub fn document_name(&self, path: &str) -> String {
        format!("{}/{}", self.inner.base, path.trim_matches('/'))
    }

    pub fn doc(&self, path: impl Into<String>) -> DocumentRef {
        DocumentRef {
            firestore: self.clone(),
            path: path.into(),
        }
    }

    pub fn collection(&self, path: impl Into<String>) -> CollectionRef {
        CollectionRef {
            firestore: self.clone(),
            path: path.into(),
        }
    }

    /// `collection('users').doc(uid)` convenience.
    pub fn collection_doc(&self, collection: &str, id: &str) -> DocumentRef {
        self.doc(format!("{collection}/{id}"))
    }

    async fn authorized_send(
        &self,
        request: HttpRequest,
    ) -> std::result::Result<HttpResponse, FirestoreError> {
        let token =
            self.inner
                .auth
                .access_token()
                .await
                .map_err(|error| FirestoreError {
                    status: 500,
                    code: Some("UNAUTHENTICATED".into()),
                    message: error.to_string(),
                })?;
        let request = request.header("Authorization", format!("Bearer {token}"));
        let response = send_with_retry(&self.inner.transport, request, self.inner.retry)
            .await
            .map_err(|error| FirestoreError {
                status: 503,
                code: Some("UNAVAILABLE".into()),
                message: error.to_string(),
            })?;
        if response.status == 401 {
            // One stale cached token must not wedge the worker.
            self.inner.auth.invalidate_access_token().await;
        }
        Ok(response)
    }

    fn error_from(response: &HttpResponse) -> FirestoreError {
        let parsed: Option<OperationError> = response
            .json_value()
            .and_then(|value| value.get("error").cloned())
            .and_then(|value| serde_json::from_value(value).ok());
        let code = parsed
            .as_ref()
            .and_then(|error| error.code)
            .map(|code| match code {
                5 => "NOT_FOUND".to_string(),
                6 => "ALREADY_EXISTS".to_string(),
                10 => "ABORTED".to_string(),
                other => other.to_string(),
            })
            .or_else(|| {
                response.json_value().and_then(|value| {
                    value
                        .get("error")
                        .and_then(|error| error.get("status"))
                        .and_then(|status| status.as_str())
                        .map(str::to_string)
                })
            });
        let message = google_error_message(response);
        let message = parsed
            .as_ref()
            .and_then(|error| error.message.clone())
            .filter(|message| !message.is_empty())
            .unwrap_or(message);
        FirestoreError {
            status: response.status,
            code,
            message,
        }
    }

    /// `firestore.getAll(...refs)` — one RPC for many documents. Missing
    /// documents come back as `None`, in the order requested.
    pub async fn get_all(&self, references: &[DocumentRef]) -> Result<Vec<Option<Document>>> {
        if references.is_empty() {
            return Ok(Vec::new());
        }
        let url = format!("{}:batchGet", self.inner.base);
        let request = HttpRequest::new("POST", url)
            .json(&json!({
                "documents": references.iter().map(DocumentRef::name).collect::<Vec<_>>(),
            }))
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let response = self.authorized_send(request).await?;
        if !response.is_success() {
            return Err(Self::error_from(&response).into());
        }
        let rows: Vec<BatchGetResult> = serde_json::from_slice(&response.body)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(rows.into_iter().map(|row| row.found).collect())
    }

    /// Run a structured query, returning documents in Firestore's order.
    pub async fn run_query(&self, query: &Query) -> Result<Vec<Document>> {
        self.run_query_at(&query.run_query_url(&self.inner.base), query, None)
            .await
    }

    async fn run_query_at(
        &self,
        url: &str,
        query: &Query,
        transaction: Option<&str>,
    ) -> Result<Vec<Document>> {
        let mut payload = serde_json::Map::new();
        payload.insert("structuredQuery".into(), query.to_structured_query());
        if let Some(transaction) = transaction {
            payload.insert("transaction".into(), json!(transaction));
        }
        let request = HttpRequest::new("POST", url.to_string())
            .json(&Json::Object(payload))
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let response = self.authorized_send(request).await?;
        if !response.is_success() {
            return Err(Self::error_from(&response).into());
        }
        let rows: Vec<RunQueryResult> = serde_json::from_slice(&response.body)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(rows.into_iter().filter_map(|row| row.document).collect())
    }

    /// Begin a read-write transaction, run `body`, then commit. `ABORTED`
    /// (and transient contention) re-runs the whole body, matching the Admin SDK.
    pub async fn run_transaction<T, F>(&self, body: F) -> Result<T>
    where
        F: for<'a> Fn(
            &'a mut Transaction,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T>> + Send + 'a>>,
    {
        let mut attempt = 0u32;
        loop {
            let mut transaction = self.begin_transaction().await?;
            let outcome = body(&mut transaction).await;
            match outcome {
                Ok(value) => match transaction.commit().await {
                    Ok(()) => return Ok(value),
                    Err(error) => {
                        // A conflict at commit time is retried from the top, so
                        // the body re-reads and re-applies its writes.
                        transaction.rollback().await;
                        if attempt < 4 && Self::is_abort_error(&error) {
                            attempt += 1;
                            tokio::time::sleep(Duration::from_millis(20 * u64::from(attempt)))
                                .await;
                            continue;
                        }
                        return Err(error);
                    }
                },
                Err(error) => {
                    transaction.rollback().await;
                    // A conflict is retried; a domain error is returned as-is.
                    if attempt < 4 && Self::is_abort_error(&error) {
                        attempt += 1;
                        tokio::time::sleep(Duration::from_millis(20 * u64::from(attempt))).await;
                        continue;
                    }
                    return Err(error);
                }
            }
        }
    }

    fn is_abort_error(error: &ApiError) -> bool {
        let message = error.message().to_ascii_lowercase();
        message.contains("aborted")
            || message.contains("conflict")
            || message.contains("too much contention")
    }

    pub async fn begin_transaction(&self) -> Result<Transaction> {
        let url = format!("{}:beginTransaction", self.inner.base);
        let request = HttpRequest::new("POST", url)
            .json(&json!({ "options": { "readWrite": {} } }))
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let response = self.authorized_send(request).await?;
        if !response.is_success() {
            return Err(Self::error_from(&response).into());
        }
        let parsed: BeginTransactionResponse = serde_json::from_slice(&response.body)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(Transaction {
            firestore: self.clone(),
            id: parsed.transaction,
            writes: Vec::new(),
            finished: false,
        })
    }

    async fn rollback_transaction(&self, id: &str) {
        let url = format!("{}:rollback", self.inner.base);
        let Ok(request) = HttpRequest::new("POST", url).json(&json!({ "transaction": id })) else {
            return;
        };
        let _ = self.authorized_send(request).await;
    }

    /// `batch().commit()` — one atomic commit of many writes, outside any
    /// transaction. Used where Node used `firestore.batch()`.
    pub async fn commit_batch(&self, writes: Vec<Json>) -> Result<()> {
        if writes.is_empty() {
            return Ok(());
        }
        let url = format!("{}:commit", self.inner.base);
        let request = HttpRequest::new("POST", url)
            .json(&json!({ "writes": writes }))
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let response = self.authorized_send(request).await?;
        if !response.is_success() {
            return Err(Self::error_from(&response).into());
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Document references
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct DocumentRef {
    firestore: Firestore,
    path: String,
}

impl DocumentRef {
    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn name(&self) -> String {
        self.firestore.document_name(&self.path)
    }

    pub fn id(&self) -> String {
        self.path.rsplit('/').next().unwrap_or("").to_string()
    }

    /// `get()` — `None` when the document does not exist.
    pub async fn get(&self) -> Result<Option<Document>> {
        let url = format!(
            "{}/{}",
            self.firestore.inner.base,
            self.path.trim_matches('/')
        );
        let response = self
            .firestore
            .authorized_send(HttpRequest::new("GET", url))
            .await?;
        if response.status == 404 {
            return Ok(None);
        }
        if !response.is_success() {
            return Err(Firestore::error_from(&response).into());
        }
        let document: Document = serde_json::from_slice(&response.body)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(Some(document))
    }

    /// `set(data)` / `set(data, { merge: true })`. Upserts.
    pub async fn set(&self, data: DocData, merge: bool) -> Result<()> {
        let writes = self.set_writes(&data, merge)?;
        self.commit_writes(writes).await
    }

    /// `create()` — fails when the document already exists.
    pub async fn create(&self, data: DocData) -> Result<()> {
        let writes = self.create_writes(&data)?;
        self.commit_writes(writes).await
    }

    /// `update()` — fails when the document does not exist.
    pub async fn update(&self, data: DocData) -> Result<()> {
        let writes = self.update_writes(&data)?;
        self.commit_writes(writes).await
    }

    pub async fn delete(&self) -> Result<()> {
        self.commit_writes(vec![self.delete_write()]).await
    }

    /// The ordered write list for a set/update: the field update followed by
    /// the transform write, if any.
    fn writes_for(
        &self,
        data: &DocData,
        merge: bool,
        precondition: Option<Json>,
    ) -> Result<Vec<Json>> {
        let mut write = serde_json::Map::new();
        write.insert(
            "update".into(),
            json!({ "name": self.name(), "fields": data.plain_fields() }),
        );
        if merge {
            write.insert(
                "updateMask".into(),
                json!({ "fieldPaths": data.field_paths() }),
            );
        }
        if let Some(precondition) = precondition {
            write.insert("currentDocument".into(), precondition);
        }
        let mut writes = vec![Json::Object(write)];
        let transforms = data.transforms();
        if !transforms.is_empty() {
            writes.push(json!({
                "transform": { "document": self.name(), "fieldTransforms": transforms }
            }));
        }
        Ok(writes)
    }

    pub(crate) fn set_writes(&self, data: &DocData, merge: bool) -> Result<Vec<Json>> {
        self.writes_for(data, merge, None)
    }

    pub(crate) fn create_writes(&self, data: &DocData) -> Result<Vec<Json>> {
        self.writes_for(data, false, Some(json!({ "exists": false })))
    }

    pub(crate) fn update_writes(&self, data: &DocData) -> Result<Vec<Json>> {
        self.writes_for(data, false, Some(json!({ "exists": true })))
    }

    pub(crate) fn delete_write(&self) -> Json {
        json!({ "delete": self.name() })
    }

    pub(crate) async fn commit_writes(&self, writes: Vec<Json>) -> Result<()> {
        if writes.is_empty() {
            return Ok(());
        }
        let url = format!("{}:commit", self.firestore.inner.base);
        let request = HttpRequest::new("POST", url)
            .json(&json!({ "writes": writes }))
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let response = self.firestore.authorized_send(request).await?;
        if !response.is_success() {
            return Err(Firestore::error_from(&response).into());
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct CollectionRef {
    firestore: Firestore,
    path: String,
}

impl CollectionRef {
    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn doc(&self, id: &str) -> DocumentRef {
        self.firestore.doc(format!("{}/{}", self.path, id))
    }

    /// `add()` — server-generated id, returns the new reference.
    pub async fn add(&self, data: DocData) -> Result<DocumentRef> {
        let id = new_document_id();
        let reference = self.doc(&id);
        reference.set(data, false).await?;
        Ok(reference)
    }

    pub fn query(&self) -> Query {
        Query::collection(self.path.clone())
    }
}

/// Firestore-compatible 20-character document id (the Admin SDK's
/// `autoId()` shape): timestamp prefix + random suffix over the same alphabet.
pub fn new_document_id() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let millis = chrono::Utc::now().timestamp_millis().max(0) as u64;
    let mut bytes = [0u8; 20];
    let mut timestamp = millis;
    // 8 characters of timestamp, most significant first.
    for index in (0..8).rev() {
        bytes[index] = ALPHABET[(timestamp % 62) as usize];
        timestamp /= 62;
    }
    for byte in bytes.iter_mut().skip(8) {
        *byte = ALPHABET[rand::random::<usize>() % 62];
    }
    String::from_utf8(bytes.to_vec()).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

pub struct Transaction {
    firestore: Firestore,
    id: String,
    writes: Vec<Json>,
    finished: bool,
}

impl Transaction {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Build a document reference bound to this transaction's client, so a
    /// transaction body can address documents without holding a `Firestore`.
    pub fn doc(&self, path: &str) -> DocumentRef {
        self.firestore.doc(path)
    }

    pub fn collection(&self, path: &str) -> CollectionRef {
        self.firestore.collection(path)
    }

    /// `transaction.get(docRef)` inside the transaction snapshot.
    pub async fn get_doc(&mut self, reference: &DocumentRef) -> Result<Option<Document>> {
        let url = format!("{}:batchGet", self.firestore.inner.base);
        let request = HttpRequest::new("POST", url)
            .json(&json!({
                "documents": [reference.name()],
                "transaction": self.id,
            }))
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let response = self.firestore.authorized_send(request).await?;
        if !response.is_success() {
            return Err(Firestore::error_from(&response).into());
        }
        let rows: Vec<BatchGetResult> = serde_json::from_slice(&response.body)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(rows.into_iter().next().and_then(|row| row.found))
    }

    /// `transaction.get(query)` inside the transaction snapshot.
    pub async fn get_query(&mut self, query: &Query) -> Result<Vec<Document>> {
        let url = query.run_query_url(&self.firestore.inner.base);
        let mut payload = serde_json::Map::new();
        payload.insert("structuredQuery".into(), query.to_structured_query());
        payload.insert("transaction".into(), json!(self.id));
        let request = HttpRequest::new("POST", url)
            .json(&Json::Object(payload))
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let response = self.firestore.authorized_send(request).await?;
        if !response.is_success() {
            return Err(Firestore::error_from(&response).into());
        }
        let rows: Vec<RunQueryResult> = serde_json::from_slice(&response.body)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(rows.into_iter().filter_map(|row| row.document).collect())
    }

    pub fn set(&mut self, reference: &DocumentRef, data: DocData, merge: bool) -> Result<()> {
        let mut writes = reference.set_writes(&data, merge)?;
        self.writes.append(&mut writes);
        Ok(())
    }

    pub fn update(&mut self, reference: &DocumentRef, data: DocData) -> Result<()> {
        let mut writes = reference.update_writes(&data)?;
        self.writes.append(&mut writes);
        Ok(())
    }

    pub fn create(&mut self, reference: &DocumentRef, data: DocData) -> Result<()> {
        let mut writes = reference.create_writes(&data)?;
        self.writes.append(&mut writes);
        Ok(())
    }

    pub fn delete(&mut self, reference: &DocumentRef) {
        self.writes.push(reference.delete_write());
    }

    pub fn write_count(&self) -> usize {
        self.writes.len()
    }

    /// `commit()`. A transaction with no writes is rolled back instead, which
    /// releases the read locks immediately.
    ///
    /// Takes `&mut self` so a failed commit (for example `ABORTED`) can still be
    /// rolled back and retried by [`Firestore::run_transaction`].
    pub async fn commit(&mut self) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        if self.writes.is_empty() {
            self.finished = true;
            self.firestore.rollback_transaction(&self.id).await;
            return Ok(());
        }
        let writes = std::mem::take(&mut self.writes);
        let url = format!("{}:commit", self.firestore.inner.base);
        let request = HttpRequest::new("POST", url)
            .json(&json!({ "transaction": self.id, "writes": writes }))
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let response = self.firestore.authorized_send(request).await?;
        if !response.is_success() {
            // `finished` stays false so the caller can still roll back.
            return Err(Firestore::error_from(&response).into());
        }
        self.finished = true;
        // Decoding the response validates its shape even though the domain
        // paths do not consume `writeResults`.
        let _: CommitResponse = serde_json::from_slice(&response.body)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn rollback(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.firestore.rollback_transaction(&self.id).await;
    }
}

// ---------------------------------------------------------------------------
// Encoding tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_round_trips_every_typed_shape() {
        let cases = vec![
            Value::Null,
            Value::Boolean(true),
            Value::Integer(9_007_199_254_740_993),
            Value::Double(1.5),
            Value::String("hi".into()),
            Value::Bytes(vec![1, 2, 3]),
            Value::Reference("projects/p/databases/(default)/documents/users/u1".into()),
            Value::GeoPoint {
                latitude: 1.0,
                longitude: 2.0,
            },
            Value::Array(vec![Value::Integer(1), Value::String("two".into())]),
            Value::map([("k".to_string(), Value::Boolean(false))]),
        ];
        for case in cases {
            let encoded = case.to_json();
            let decoded = Value::from_json(&encoded);
            assert_eq!(decoded, case, "mismatch for {encoded}");
        }
    }

    #[test]
    fn integer_values_transport_as_strings() {
        let encoded = Value::Integer(42).to_json();
        assert_eq!(encoded["integerValue"], json!("42"));
        assert_eq!(Value::from_json(&encoded), Value::Integer(42));
        // Admin SDK also emits bare numbers; accept those too.
        assert_eq!(
            Value::from_json(&json!({ "integerValue": 7 })),
            Value::Integer(7)
        );
    }

    #[test]
    fn timestamp_round_trips_with_microseconds() {
        let value = Value::timestamp_from_millis(1_700_000_000_123);
        let encoded = value.to_json();
        let text = encoded["timestampValue"].as_str().unwrap();
        assert!(text.ends_with('Z'));
        assert_eq!(
            Value::from_json(&encoded).as_timestamp_millis(),
            Some(1_700_000_000_123)
        );
    }

    #[test]
    fn special_doubles_decode() {
        assert!(matches!(
            Value::from_json(&json!({ "doubleValue": "NaN" })),
            Value::Double(value) if value.is_nan()
        ));
        assert_eq!(
            Value::from_json(&json!({ "doubleValue": "-Infinity" })),
            Value::Double(f64::NEG_INFINITY)
        );
    }

    #[test]
    fn server_timestamp_and_increment_become_transforms() {
        let data = DocData::new()
            .string("email", "a@b.c")
            .server_timestamp("createdAt")
            .increment("availablePkn", 0)
            .array("tags", vec![Value::String("x".into())]);
        assert_eq!(
            data.field_paths(),
            vec!["email", "createdAt", "availablePkn", "tags"]
        );
        // Two transforms: createdAt and availablePkn. `email` and `tags` are
        // plain values and must not appear in the transform list.
        let transforms = data.transforms();
        assert_eq!(transforms.len(), 2);
        assert_eq!(transforms[0]["fieldPath"], json!("createdAt"));
        assert_eq!(transforms[0]["setToServerValue"], json!("REQUEST_TIME"));
        assert_eq!(transforms[1]["fieldPath"], json!("availablePkn"));
        assert_eq!(transforms[1]["increment"], json!({ "integerValue": "0" }));
        // Plain fields never leak into the transform list.
        assert!(transforms.iter().all(|t| t["fieldPath"] != json!("email")));
    }

    #[test]
    fn plain_fields_exclude_transform_fields() {
        let data = DocData::new()
            .string("a", "1")
            .server_timestamp("b")
            .increment("c", 5);
        let plain = data.plain_fields();
        assert_eq!(plain.len(), 1);
        assert!(plain.contains_key("a"));
    }

    #[test]
    fn plain_json_and_typed_json_decode_separately() {
        // Plain JSON (Node `set({...})` semantics).
        let plain = DocData::from_json(&json!({ "n": 1, "s": "x" }));
        assert_eq!(
            plain.fields.get("n"),
            Some(&FieldValue::Value(Value::Integer(1)))
        );
        assert_eq!(
            plain.fields.get("s"),
            Some(&FieldValue::Value(Value::String("x".into())))
        );

        // Firestore typed wire shape.
        let typed = DocData::from_typed_json(&json!({
            "n": { "integerValue": "1" },
            "s": { "stringValue": "x" }
        }));
        assert_eq!(typed.fields, plain.fields);
    }

    #[test]
    fn doc_data_from_json_preserves_nulls_and_nesting() {
        let data = DocData::from_json(&json!({
            "email": "a@b.c",
            "displayName": null,
            "nested": { "deep": 1 },
            "list": [1, "two", true]
        }));
        let fields = &data.fields;
        assert_eq!(
            fields.get("email"),
            Some(&FieldValue::Value(Value::String("a@b.c".into())))
        );
        assert!(matches!(
            fields.get("displayName"),
            Some(FieldValue::Value(Value::Null))
        ));
        assert!(matches!(
            fields.get("nested"),
            Some(FieldValue::Value(Value::Map(_)))
        ));
        assert!(matches!(
            fields.get("list"),
            Some(FieldValue::Value(Value::Array(_)))
        ));
        // Insertion order is preserved.
        assert_eq!(
            fields.keys().cloned().collect::<Vec<_>>(),
            vec!["email", "displayName", "nested", "list"]
        );
    }

    #[test]
    fn nested_maps_keep_their_own_typed_values() {
        let data = DocData::new().map(
            "counts",
            [
                ("a".to_string(), Value::Integer(1)),
                ("b".to_string(), Value::String("two".into())),
            ]
            .into_iter()
            .collect(),
        );
        let encoded = data.plain_fields();
        let nested = encoded["counts"]["mapValue"]["fields"]["a"]["integerValue"].clone();
        assert_eq!(nested, json!("1"));
    }

    #[test]
    fn multiple_filters_become_an_and_composite() {
        let query = Query::collection("orders")
            .where_op("createdAt", FilterOp::GreaterThanOrEqual, Value::timestamp_from_millis(1))
            .where_op("createdAt", FilterOp::LessThanOrEqual, Value::timestamp_from_millis(2));
        let encoded = query.to_structured_query();
        assert_eq!(encoded["where"]["compositeFilter"]["op"], json!("AND"));
        let filters = encoded["where"]["compositeFilter"]["filters"].as_array().unwrap();
        assert_eq!(filters.len(), 2);
        assert_eq!(filters[0]["fieldFilter"]["op"], json!("GREATER_THAN_OR_EQUAL"));
        assert_eq!(filters[1]["fieldFilter"]["op"], json!("LESS_THAN_OR_EQUAL"));
        // A single filter stays a plain fieldFilter.
        let single = Query::collection("orders").where_eq("uid", Value::String("u".into()));
        assert!(single.to_structured_query()["where"].get("fieldFilter").is_some());
    }

    #[test]
    fn documents_render_as_plain_json() {
        let document = Document {
            name: "projects/p/databases/(default)/documents/orders/o1".into(),
            create_time: None,
            update_time: None,
            fields: Some(
                serde_json::from_value(json!({
                    "paymentStatus": { "stringValue": "paid" },
                    "subtotalPkn": { "integerValue": "120" },
                    "createdAt": { "timestampValue": "2026-10-08T00:00:00Z" },
                    "sellerUids": { "arrayValue": { "values": [{ "stringValue": "u1" }] } }
                }))
                .unwrap(),
            ),
        };
        let plain = document.to_plain_json();
        assert_eq!(plain["paymentStatus"], json!("paid"));
        assert_eq!(plain["subtotalPkn"], json!(120));
        // Timestamps round-trip with Firestore's microsecond precision.
        assert_eq!(plain["createdAt"], json!("2026-10-08T00:00:00.000000Z"));
        assert_eq!(plain["sellerUids"], json!(["u1"]));
    }

    #[test]
    fn structured_query_encodes_filters_order_and_limit() {
        let query = Query::collection("usernames")
            .where_eq("uid", Value::String("u1".into()))
            .order_by("updatedAt", Direction::Descending)
            .limit(2);
        let encoded = query.to_structured_query();
        assert_eq!(encoded["from"][0]["collectionId"], json!("usernames"));
        assert_eq!(
            encoded["where"]["fieldFilter"]["field"]["fieldPath"],
            json!("uid")
        );
        assert_eq!(encoded["where"]["fieldFilter"]["op"], json!("EQUAL"));
        assert_eq!(
            encoded["where"]["fieldFilter"]["value"],
            json!({ "stringValue": "u1" })
        );
        assert_eq!(encoded["orderBy"][0]["direction"], json!("DESCENDING"));
        assert_eq!(encoded["limit"], json!(2));
    }

    #[test]
    fn subcollection_paths_split_parent_and_collection() {
        let query = Query::collection("users/u1/sessions");
        assert_eq!(
            query.parent_and_collection(),
            ("users/u1".to_string(), "sessions".to_string())
        );
        let query = Query::collection("users");
        assert_eq!(
            query.parent_and_collection(),
            (String::new(), "users".to_string())
        );
    }

    #[test]
    fn run_query_url_targets_the_parent_collection() {
        let base = "https://fs.test/v1/projects/p/databases/(default)/documents";
        assert_eq!(
            Query::collection("users").run_query_url(base),
            format!("{base}:runQuery")
        );
        assert_eq!(
            Query::collection("users/u1/sessions").run_query_url(base),
            format!("{base}/users/u1:runQuery")
        );
    }

    #[test]
    fn generated_document_ids_are_twenty_chars_and_unique() {
        let first = new_document_id();
        let second = new_document_id();
        assert_eq!(first.len(), 20);
        assert_eq!(second.len(), 20);
        assert_ne!(first, second);
        assert!(first.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn document_helpers_read_typed_fields() {
        let document = Document {
            name: "projects/p/databases/(default)/documents/users/u1".into(),
            create_time: None,
            update_time: None,
            fields: Some(
                serde_json::from_value(json!({
                    "username": { "stringValue": "ash" },
                    "availablePkn": { "integerValue": "1200" },
                    "active": { "booleanValue": true },
                    "lastLoginAt": { "timestampValue": "2026-10-08T00:00:00Z" }
                }))
                .unwrap(),
            ),
        };
        assert_eq!(document.id(), "u1");
        assert_eq!(document.get_str("username"), "ash");
        assert_eq!(document.get_i64("availablePkn"), Some(1200));
        assert_eq!(document.get_bool("active"), Some(true));
        assert_eq!(document.get_str("missing"), "");
        assert!(document.get_timestamp_millis("lastLoginAt").is_some());
        // Typed view preserves the field order from the wire document.
        assert_eq!(
            document.values().keys().cloned().collect::<Vec<_>>(),
            vec!["username", "availablePkn", "active", "lastLoginAt"]
        );
    }

    #[test]
    fn firestore_error_classification_matches_node_codes() {
        let not_found = FirestoreError {
            status: 404,
            code: Some("NOT_FOUND".into()),
            message: "missing".into(),
        };
        assert!(not_found.not_found());
        assert!(!not_found.aborted());

        let aborted = FirestoreError {
            status: 409,
            code: Some("ABORTED".into()),
            message: "conflict".into(),
        };
        assert!(aborted.aborted());
        assert!(!aborted.already_exists());

        let exists = FirestoreError {
            status: 409,
            code: Some("ALREADY_EXISTS".into()),
            message: "exists".into(),
        };
        assert!(exists.already_exists());
        assert!(!exists.aborted());
    }

    #[test]
    fn ordered_map_replaces_in_place() {
        let mut map: OrderedMap<i64> = OrderedMap::new();
        map.insert("a".into(), 1);
        map.insert("b".into(), 2);
        assert_eq!(map.insert("a".into(), 3), Some(1));
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("a"), Some(&3));
        assert_eq!(
            map.keys().cloned().collect::<Vec<_>>(),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(map.remove("a"), Some(3));
        assert!(!map.contains_key("a"));
    }
}
