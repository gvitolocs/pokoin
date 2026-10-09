//! CardTrader integration doc on Firestore `seller_integrations/{uid}__cardtrader`
//! — native port of `_cardtrader_integration.js`.

use serde_json::{json, Value};

use crate::crypto::{decrypt_secret, encrypt_secret};
use crate::error::{clean_text, ApiError, ApiResult};
use crate::firebase::{FirestoreStore, FirestoreDoc};

pub const COLLECTION: &str = "seller_integrations";
pub const PROVIDER: &str = "cardtrader";

pub fn integration_doc_id(uid: &str) -> String {
    format!("{uid}__{PROVIDER}")
}

fn encryption_key() -> Option<String> {
    std::env::var("CARDTRADER_TOKEN_ENCRYPTION_KEY").ok().filter(|v| !v.trim().is_empty())
}

fn stamp_day(value: Option<&Value>) -> String {
    let Some(value) = value else { return String::new() };
    if let Some(text) = value.as_str() {
        return text.get(..10).unwrap_or("").to_string();
    }
    String::new()
}

/// `safeStatusFromDoc`.
pub fn safe_status_from_doc(doc: &FirestoreDoc) -> Value {
    if !doc.exists {
        return json!({
            "connected": false,
            "provider": PROVIDER,
            "metadata": Value::Null,
            "connectedAt": Value::Null,
            "updatedAt": Value::Null,
            "lastValidatedAt": Value::Null,
            "disconnectedAt": Value::Null,
            "webhook": Value::Null,
        });
    }
    let data = &doc.data;
    let enabled = data.get("enabled") == Some(&Value::Bool(true));
    json!({
        "connected": enabled,
        "provider": PROVIDER,
        "metadata": if enabled { data.get("metadata").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null) } else { Value::Null },
        "connectedAt": data.get("connectedAt").cloned().unwrap_or(Value::Null),
        "updatedAt": data.get("updatedAt").cloned().unwrap_or(Value::Null),
        "lastValidatedAt": data.get("lastValidatedAt").cloned().unwrap_or(Value::Null),
        "disconnectedAt": data.get("disconnectedAt").cloned().unwrap_or(Value::Null),
        "webhook": data.get("webhookRegistration").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null),
    })
}

pub async fn read_integration_doc(firestore: &dyn FirestoreStore, uid: &str) -> ApiResult<FirestoreDoc> {
    firestore.get_doc(COLLECTION, &integration_doc_id(uid)).await
}

/// `storeConnectedIntegration` — merge prior metadata, keep first connectedAt.
pub async fn store_connected_integration(
    firestore: &dyn FirestoreStore,
    uid: &str,
    email: &str,
    token: &str,
    info: &Value,
) -> ApiResult<()> {
    let doc = read_integration_doc(firestore, uid).await.unwrap_or_default();
    let prior = if doc.exists { doc.data } else { json!({}) };
    let mut metadata = prior.get("metadata").cloned().unwrap_or(json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }
    let safe = crate::cardtrader::client::safe_info_metadata(info);
    if let (Some(target), Some(source)) = (metadata.as_object_mut(), safe.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    if metadata.get("firstSyncAt").and_then(Value::as_str).unwrap_or_default().is_empty() {
        let day = stamp_day(prior.get("connectedAt").as_deref());
        let day = if day.is_empty() { crate::time_util::utc_day_key_from_ms(crate::time_util::now_ms()) } else { day };
        metadata["firstSyncAt"] = json!(day);
    }
    let now = crate::time_util::iso_from_ms(crate::time_util::now_ms());
    let payload = json!({
        "uid": uid,
        "provider": PROVIDER,
        "userEmail": email,
        "enabled": true,
        "metadata": metadata,
        "encryptedToken": encrypt_secret(token, encryption_key().as_deref()),
        "encryptedSharedSecret": encrypt_secret(info.get("sharedSecret").and_then(Value::as_str).unwrap_or_default(), encryption_key().as_deref()),
        "connectedAt": prior.get("connectedAt").cloned().filter(|v| !v.is_null()).unwrap_or(json!(now.clone())),
        "updatedAt": now.clone(),
        "lastValidatedAt": now,
        "disconnectedAt": Value::Null,
    });
    firestore.merge_doc(COLLECTION, &integration_doc_id(uid), payload).await
}

/// `markOneDayReady` — record the account type a sync detected.
pub async fn mark_one_day_ready(firestore: &dyn FirestoreStore, uid: &str, one_day_ready: bool) -> ApiResult<()> {
    let doc = read_integration_doc(firestore, uid).await.unwrap_or_default();
    let mut metadata = if doc.exists { doc.data.get("metadata").cloned().unwrap_or(json!({})) } else { json!({}) };
    if !metadata.is_object() {
        metadata = json!({});
    }
    metadata["oneDayReady"] = json!(one_day_ready);
    if metadata.get("firstSyncAt").and_then(Value::as_str).unwrap_or_default().is_empty() {
        let day = stamp_day(doc.data.get("connectedAt").as_deref());
        if !day.is_empty() {
            metadata["firstSyncAt"] = json!(day);
        }
    }
    firestore
        .merge_doc(COLLECTION, &integration_doc_id(uid), json!({ "metadata": metadata }))
        .await
}

/// `recordWebhookRegistration` — non-secret webhook health only.
pub async fn record_webhook_registration(
    firestore: &dyn FirestoreStore,
    uid: &str,
    webhook_url: &str,
    ok: bool,
    error: &str,
) {
    let now = crate::time_util::iso_from_ms(crate::time_util::now_ms());
    let mut payload = json!({
        "ok": ok,
        "url": clean_text(Some(webhook_url), 500),
        "error": if ok { String::new() } else { clean_text(Some(if error.is_empty() { "Webhook registration failed." } else { error }), 500) },
        "lastAttemptAt": now.clone(),
    });
    if ok {
        payload["registeredAt"] = json!(now.clone());
    }
    let _ = firestore
        .merge_doc(
            COLLECTION,
            &integration_doc_id(uid),
            json!({ "webhookRegistration": payload, "updatedAt": now }),
        )
        .await;
}

pub fn is_one_day_ready_integration(doc: &FirestoreDoc) -> bool {
    doc.exists
        && doc.data.get("enabled") == Some(&Value::Bool(true))
        && doc.data.pointer("/metadata/oneDayReady") == Some(&Value::Bool(true))
}

pub async fn disconnect_integration(firestore: &dyn FirestoreStore, uid: &str) -> ApiResult<()> {
    let now = crate::time_util::iso_from_ms(crate::time_util::now_ms());
    firestore
        .merge_doc(
            COLLECTION,
            &integration_doc_id(uid),
            json!({
                "enabled": false,
                "encryptedToken": Value::Null,
                "encryptedSharedSecret": Value::Null,
                "disconnectedAt": now.clone(),
                "updatedAt": now,
            }),
        )
        .await
}

fn require_secret(doc: &FirestoreDoc, field: &str, message: &str) -> ApiResult<String> {
    if !doc.exists || doc.data.get("enabled") != Some(&Value::Bool(true)) {
        return Err(ApiError::new(404, message));
    }
    let encrypted = doc.data.get(field).cloned().unwrap_or(Value::Null);
    if encrypted.is_null() {
        return Err(ApiError::new(404, message));
    }
    decrypt_secret(&encrypted, encryption_key().as_deref())
}

pub async fn decrypt_integration_token(firestore: &dyn FirestoreStore, uid: &str) -> ApiResult<String> {
    let doc = read_integration_doc(firestore, uid).await?;
    require_secret(&doc, "encryptedToken", "CardTrader is not connected for this seller.")
}

pub async fn decrypt_integration_shared_secret(firestore: &dyn FirestoreStore, uid: &str) -> ApiResult<String> {
    let doc = read_integration_doc(firestore, uid).await?;
    require_secret(&doc, "encryptedSharedSecret", "CardTrader webhook secret is not available for this seller.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firebase::MemoryFirestore;

    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[tokio::test]
    async fn connect_disconnect_status_cycle() {
        std::env::set_var("CARDTRADER_TOKEN_ENCRYPTION_KEY", KEY);
        let firestore = MemoryFirestore::new();
        let info = json!({"app": {"id": "7", "name": "App"}, "user": {"id": "5", "username": "sel"}, "sharedSecret": "ssh"});

        store_connected_integration(&firestore, "u1", "e@x.y", "tok-value", &info).await.unwrap();
        let doc = read_integration_doc(&firestore, "u1").await.unwrap();
        assert!(is_one_day_ready_integration(&doc) == false);
        let status = safe_status_from_doc(&doc);
        assert_eq!(status["connected"], true);
        assert_eq!(status["metadata"]["user"]["username"], "sel");
        assert_eq!(status["provider"], "cardtrader");

        // Token round trip through the AES envelope.
        assert_eq!(decrypt_integration_token(&firestore, "u1").await.unwrap(), "tok-value");
        assert_eq!(decrypt_integration_shared_secret(&firestore, "u1").await.unwrap(), "ssh");

        mark_one_day_ready(&firestore, "u1", true).await.unwrap();
        let doc = read_integration_doc(&firestore, "u1").await.unwrap();
        assert!(is_one_day_ready_integration(&doc));

        // Webhook failure bookkeeping stays visible.
        record_webhook_registration(&firestore, "u1", "https://api.pokoin.com/api/cardtrader-webhook/u1", false, "boom").await;
        let doc = read_integration_doc(&firestore, "u1").await.unwrap();
        assert_eq!(doc.data["webhookRegistration"]["ok"], false);
        assert_eq!(doc.data["webhookRegistration"]["error"], "boom");

        disconnect_integration(&firestore, "u1").await.unwrap();
        let doc = read_integration_doc(&firestore, "u1").await.unwrap();
        let status = safe_status_from_doc(&doc);
        assert_eq!(status["connected"], false);
        let err = decrypt_integration_token(&firestore, "u1").await.unwrap_err();
        assert_eq!(err.status, 404);
        // NOTE: the key is intentionally never removed here: lib tests run in
        // parallel and other modules set it once via their own guard.
    }

    #[tokio::test]
    async fn missing_doc_is_not_connected() {
        let firestore = MemoryFirestore::new();
        let doc = read_integration_doc(&firestore, "nobody").await.unwrap();
        assert!(!doc.exists);
        assert_eq!(safe_status_from_doc(&doc)["connected"], false);
    }
}
