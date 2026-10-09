//! Native CardTrader effects for paid orders. HTTP uses the external crate;
//! Firestore claims share the reference collections and survive process restarts.
use crate::cardtrader::{
    CardTraderBuyThrough, CardTraderOutcome, CardTraderPort, CardTraderSaleSync,
};
use crate::error::ApiError;
use async_trait::async_trait;
use pokoin_accounts::firestore::{DocData, Firestore};
use pokoin_external::cardtrader::{client::CardTraderClient, integration};
use pokoin_external::firebase::{FirestoreRest, FirestoreStore};
use serde_json::{json, Value};
use std::sync::Arc;

fn external_error(error: impl std::fmt::Display) -> ApiError {
    ApiError::unavailable(error.to_string())
}
fn value_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}
fn ct_product(source: &str) -> String {
    let lower = source.trim().to_ascii_lowercase();
    let id = lower
        .strip_prefix("ct:")
        .or_else(|| lower.strip_prefix("cardtrader:"))
        .unwrap_or("");
    if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) {
        id.into()
    } else {
        String::new()
    }
}
fn live_item(item: &Value) -> bool {
    value_text(item.get("source"))
        .trim()
        .eq_ignore_ascii_case("cardtrader_live")
        || value_text(item.get("sourceListingId"))
            .trim()
            .to_ascii_lowercase()
            .starts_with("cardtrader:live:")
}
fn live_product(item: &Value) -> String {
    for path in [
        "/sourceMetadata/cardtraderProductId",
        "/sourceMetadata/externalProductId",
        "/sourceMetadata/externalListingId",
    ] {
        let id = value_text(item.pointer(path)).trim().to_string();
        if !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return id;
        }
    }
    let source = value_text(item.get("sourceListingId"));
    if source.to_lowercase().starts_with("cardtrader:live:") {
        let id = source.get("cardtrader:live:".len()..).unwrap_or("");
        if !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return id.into();
        }
    }
    String::new()
}
fn cart_items(cart: &Value) -> Vec<Value> {
    if let Some(items) = cart.as_array() {
        return items.clone();
    }
    for key in [
        "order_items",
        "orderItems",
        "items",
        "products",
        "cart_items",
    ] {
        if let Some(items) = cart.get(key).and_then(Value::as_array) {
            return items.clone();
        }
    }
    cart.get("cart").map(cart_items).unwrap_or_default()
}
fn original_line(order: &Value, listing_id: &str) -> Option<Value> {
    for path in ["/inventory/lines", "/items"] {
        if let Some(items) = order.pointer(path).and_then(Value::as_array) {
            if let Some(item) = items
                .iter()
                .find(|i| value_text(i.get("listingId")).trim() == listing_id)
            {
                return Some(item.clone());
            }
        }
    }
    None
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum Claim {
    Acquired,
    Complete,
    Busy,
}
#[async_trait]
trait Store: Send + Sync {
    async fn order(&self, id: &str) -> Result<Value, ApiError>;
    async fn integration_token(&self, uid: &str) -> Result<Option<String>, ApiError>;
    async fn claim(&self, collection: &str, id: &str, payload: Value) -> Result<Claim, ApiError>;
    async fn mark(&self, collection: &str, id: &str, payload: Value) -> Result<(), ApiError>;
}
struct NativeStore {
    accounts: Firestore,
    external: Arc<dyn FirestoreStore>,
}
#[async_trait]
impl Store for NativeStore {
    async fn order(&self, id: &str) -> Result<Value, ApiError> {
        let doc = self
            .external
            .get_doc("orders", id)
            .await
            .map_err(external_error)?;
        if !doc.exists {
            return Err(ApiError::not_found(format!("Order {id} not found.")));
        }
        Ok(doc.data)
    }
    async fn integration_token(&self, uid: &str) -> Result<Option<String>, ApiError> {
        let doc = integration::read_integration_doc(self.external.as_ref(), uid)
            .await
            .map_err(external_error)?;
        if !doc.exists || doc.data["enabled"] != true {
            return Ok(None);
        }
        Ok(Some(
            integration::decrypt_integration_token(self.external.as_ref(), uid)
                .await
                .map_err(external_error)?,
        ))
    }
    async fn claim(&self, collection: &str, id: &str, payload: Value) -> Result<Claim, ApiError> {
        let path = format!("{collection}/{id}");
        self.accounts
            .run_transaction(move |tx| {
                let path = path.clone();
                let payload = payload.clone();
                Box::pin(async move {
                    let reference = tx.doc(&path);
                    let old = tx.get_doc(&reference).await?;
                    let status = old.map(|d| d.get_str("status")).unwrap_or_default();
                    if matches!(status.as_str(), "purchased" | "applied" | "skipped") {
                        return Ok(Claim::Complete);
                    }
                    if matches!(status.as_str(), "claimed" | "cart_added") {
                        return Ok(Claim::Busy);
                    }
                    tx.set(
                        &reference,
                        DocData::from_json(&payload)
                            .string("status", "claimed")
                            .server_timestamp("createdAt")
                            .server_timestamp("updatedAt"),
                        true,
                    )?;
                    Ok(Claim::Acquired)
                })
            })
            .await
            .map_err(external_error)
    }
    async fn mark(&self, collection: &str, id: &str, payload: Value) -> Result<(), ApiError> {
        self.accounts
            .collection_doc(collection, id)
            .set(
                DocData::from_json(&payload).server_timestamp("updatedAt"),
                true,
            )
            .await
            .map_err(external_error)
    }
}
#[async_trait]
trait Http: Send + Sync {
    async fn increment(&self, token: &str, id: &str, delta: i64) -> Result<Value, ApiError>;
    async fn destroy(&self, token: &str, id: &str) -> Result<(), ApiError>;
    async fn cart(&self, token: &str) -> Result<Value, ApiError>;
    async fn add(&self, token: &str, payload: Value) -> Result<(), ApiError>;
    async fn purchase(&self, token: &str) -> Result<Value, ApiError>;
}
#[async_trait]
impl Http for CardTraderClient {
    async fn increment(&self, token: &str, id: &str, delta: i64) -> Result<Value, ApiError> {
        self.increment_product(token, id, delta)
            .await
            .map_err(external_error)
    }
    async fn destroy(&self, token: &str, id: &str) -> Result<(), ApiError> {
        self.destroy_product(token, id)
            .await
            .map_err(external_error)?;
        Ok(())
    }
    async fn cart(&self, token: &str) -> Result<Value, ApiError> {
        self.fetch_cart(token).await.map_err(external_error)
    }
    async fn add(&self, token: &str, payload: Value) -> Result<(), ApiError> {
        self.add_product_to_cart(token, payload)
            .await
            .map_err(external_error)?;
        Ok(())
    }
    async fn purchase(&self, token: &str) -> Result<Value, ApiError> {
        self.purchase_cart(token).await.map_err(external_error)
    }
}
#[derive(Clone)]
struct BuyConfig {
    dry_run: bool,
    token: String,
}
impl BuyConfig {
    fn from_env() -> Self {
        let enabled = std::env::var("CARDTRADER_BUY_ENABLED")
            .unwrap_or_default()
            .trim()
            .eq_ignore_ascii_case("true");
        let dry_run = std::env::var("CARDTRADER_BUY_DRY_RUN")
            .unwrap_or_default()
            .trim()
            .eq_ignore_ascii_case("true")
            || !enabled;
        let token = [
            "CARDTRADER_AUTH_TOKEN",
            "CARDTRADER_BUY_API_TOKEN",
            "CARDTRADER_PURCHASE_API_TOKEN",
            "CARDTRADER_API_TOKEN",
        ]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|s| !s.is_empty()))
        .unwrap_or_default()
        .trim()
        .chars()
        .take(500)
        .collect();
        Self { dry_run, token }
    }
}
/// Wire the same durable adapter into HTTP commerce and the EUR timer.
pub struct NativeCardTrader {
    store: Arc<dyn Store>,
    http: Arc<dyn Http>,
    buy: BuyConfig,
}
impl NativeCardTrader {
    pub fn from_env() -> Result<Self, ApiError> {
        let accounts = pokoin_accounts::DomainState::from_env()
            .firestore()
            .map_err(external_error)?;
        let external = FirestoreRest::from_env().ok_or_else(|| {
            ApiError::unavailable("Firebase Admin credentials are not configured.")
        })?;
        Ok(Self {
            store: Arc::new(NativeStore {
                accounts,
                external: Arc::new(external),
            }),
            http: Arc::new(CardTraderClient::new()),
            buy: BuyConfig::from_env(),
        })
    }
    async fn sync_line(&self, order_id: &str, uid: &str, item: &Value) -> Result<Value, ApiError> {
        let listing = value_text(item.get("listingId"));
        let product = ct_product(&value_text(item.get("sourceListingId")));
        if item["external"] == true || product.is_empty() {
            return Ok(json!({"listingId":listing,"skipped":true,"reason":"not_linked"}));
        }
        let Some(token) = self.store.integration_token(uid).await? else {
            return Ok(json!({"listingId":listing,"skipped":true,"reason":"not_connected"}));
        };
        let sold = item
            .get("quantity")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .max(1);
        let id = format!("{order_id}__{listing}");
        let fields = json!({"orderId":order_id,"listingId":listing,"sellerUid":uid,"productId":product,"quantity":sold});
        match self
            .store
            .claim("cardtrader_sale_sync_markers", &id, fields)
            .await?
        {
            Claim::Complete => {
                return Ok(
                    json!({"listingId":listing,"ok":true,"productId":product,"duplicate":true}),
                )
            }
            Claim::Busy => return Err(ApiError::conflict(
                "CardTrader decrement is already claimed; reconcile its result before retrying.",
            )),
            Claim::Acquired => {}
        }
        let result = self.http.increment(&token, &product, -sold).await;
        match result {
            Ok(payload) => {
                let resource = payload
                    .get("resource")
                    .or_else(|| payload.get("product"))
                    .unwrap_or(&payload);
                let left = resource.get("quantity").and_then(Value::as_f64);
                let destroyed = left.is_some_and(|v| v <= 0.0);
                if destroyed {
                    let _ = self.http.destroy(&token, &product).await;
                }
                self.store
                    .mark(
                        "cardtrader_sale_sync_markers",
                        &id,
                        json!({"status":"applied","remaining":left,"destroyed":destroyed}),
                    )
                    .await?;
                Ok(
                    json!({"listingId":listing,"ok":true,"productId":product,"sold":sold,"remaining":left,"destroyed":destroyed}),
                )
            }
            Err(error) => {
                // An API error remains pending in fulfilment; never mark done.
                let _ = self
                    .store
                    .mark(
                        "cardtrader_sale_sync_markers",
                        &id,
                        json!({"status":"failed","error":error.message}),
                    )
                    .await;
                Err(error)
            }
        }
    }
}
#[async_trait]
impl CardTraderPort for NativeCardTrader {
    async fn sync_after_sale(
        &self,
        request: &CardTraderSaleSync,
    ) -> Result<CardTraderOutcome, ApiError> {
        let order = self.store.order(&request.order_id).await?;
        let mut items = Vec::new();
        for requested in &request.items {
            let listing = value_text(requested.get("listingId"));
            let item = original_line(&order, &listing).unwrap_or_else(|| requested.clone());
            items.push(
                self.sync_line(&request.order_id, &request.seller_uid, &item)
                    .await?,
            );
        }
        Ok(CardTraderOutcome::Applied {
            detail: json!({"ok":true,"items":items}),
        })
    }
    async fn buy_through(
        &self,
        request: &CardTraderBuyThrough,
    ) -> Result<CardTraderOutcome, ApiError> {
        let order = self.store.order(&request.order_id).await?;
        // Metadata lives on order.items; inventory.lines does not contain shippingMode.
        let item = order
            .get("items")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|i| value_text(i.get("listingId")) == request.listing_id)
            })
            .cloned()
            .unwrap_or(json!({}));
        if !live_item(&item) {
            return Ok(CardTraderOutcome::Skipped {
                reason: "No CardTrader live items.".into(),
            });
        }
        let product = live_product(&item);
        if product.is_empty() || !product.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ApiError::conflict(
                "CardTrader listing metadata is incomplete.",
            ));
        }
        let marker = format!("{}__{product}", request.order_id);
        let payload = json!({"orderId":request.order_id,"productId":product,"listingId":request.listing_id,"quantity":request.quantity});
        if self.buy.dry_run {
            self.store.mark("cardtrader_purchase_markers",&marker,json!({"orderId":request.order_id,"productId":product,"listingId":request.listing_id,"quantity":request.quantity,"status":"dry_run","dryRun":true,"reason":"CARDTRADER_BUY_ENABLED is not true."})).await?;
            return Ok(CardTraderOutcome::Applied {
                detail: json!({"ok":true,"dryRun":true,"attempted":0,"productId":product}),
            });
        }
        if self.buy.token.is_empty() {
            return Err(
                ApiError::unavailable("CardTrader buy token is not configured.")
                    .with_code("CARDTRADER_BUY_TOKEN_MISSING"),
            );
        }
        match self
            .store
            .claim("cardtrader_purchase_markers", &marker, payload)
            .await?
        {
            Claim::Complete => {
                return Ok(CardTraderOutcome::Skipped {
                    reason: "Purchase already claimed.".into(),
                })
            }
            Claim::Busy => {
                return Err(ApiError::conflict(
                    "CardTrader purchase is already claimed; reconcile its result before retrying.",
                ))
            }
            Claim::Acquired => {}
        }
        let result=async {
            let cart=self.http.cart(&self.buy.token).await?;
            if !cart_items(&cart).is_empty() {
                return Err(ApiError::conflict("CardTrader cart is not empty; refusing automatic purchase.").with_code("CARDTRADER_CART_NOT_EMPTY"));
            }
            let product_id=product.parse::<u64>().map_err(|_|ApiError::conflict("CardTrader listing metadata is incomplete."))?;
            let zero=item.pointer("/sourceMetadata/shippingMode").and_then(Value::as_str)==Some("zero");
            self.http.add(&self.buy.token,json!({"product_id":product_id,"quantity":request.quantity,"via_cardtrader_zero":zero})).await?;
            self.store.mark("cardtrader_purchase_markers",&marker,json!({"status":"cart_added","viaCardTraderZero":zero})).await?;
            let purchase=self.http.purchase(&self.buy.token).await?;
            let order_id=value_text(purchase.get("id").or_else(||purchase.get("order_id")).or_else(||purchase.get("uuid")));
            self.store.mark("cardtrader_purchase_markers",&marker,json!({"status":"purchased","purchasedAt":crate::store::now_iso(),"cardtraderOrderId":order_id.chars().take(160).collect::<String>()})).await?;
            Ok::<_,ApiError>(CardTraderOutcome::Applied{detail:json!({"ok":true,"status":"purchased","productId":product,"quantity":request.quantity})})
        }.await;
        if let Err(error) = &result {
            let status = if error.code.as_deref() == Some("CARDTRADER_CART_NOT_EMPTY") {
                "blocked_non_empty_cart"
            } else {
                "failed"
            };
            let _ = self
                .store
                .mark(
                    "cardtrader_purchase_markers",
                    &marker,
                    json!({"status":status,"error":error.message}),
                )
                .await;
        }
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tokio::sync::Mutex;
    #[derive(Default)]
    struct Memory {
        order: Value,
        markers: Mutex<HashMap<String, Value>>,
    }
    #[async_trait]
    impl Store for Memory {
        async fn order(&self, _: &str) -> Result<Value, ApiError> {
            Ok(self.order.clone())
        }
        async fn integration_token(&self, _: &str) -> Result<Option<String>, ApiError> {
            Ok(Some("token".into()))
        }
        async fn claim(
            &self,
            collection: &str,
            id: &str,
            mut payload: Value,
        ) -> Result<Claim, ApiError> {
            let key = format!("{collection}/{id}");
            let mut rows = self.markers.lock().await;
            let status = rows
                .get(&key)
                .and_then(|v| v.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if matches!(status, "purchased" | "applied" | "skipped") {
                return Ok(Claim::Complete);
            }
            if matches!(status, "claimed" | "cart_added") {
                return Ok(Claim::Busy);
            }
            payload["status"] = json!("claimed");
            rows.insert(key, payload);
            Ok(Claim::Acquired)
        }
        async fn mark(&self, collection: &str, id: &str, payload: Value) -> Result<(), ApiError> {
            let key = format!("{collection}/{id}");
            let mut rows = self.markers.lock().await;
            let entry = rows.entry(key).or_insert(json!({}));
            for (k, v) in payload.as_object().unwrap() {
                entry[k] = v.clone();
            }
            Ok(())
        }
    }
    #[derive(Default)]
    struct MockHttp {
        calls: Mutex<Vec<String>>,
        fail: Mutex<bool>,
        cart: Value,
    }
    #[async_trait]
    impl Http for MockHttp {
        async fn increment(&self, _: &str, id: &str, delta: i64) -> Result<Value, ApiError> {
            self.calls
                .lock()
                .await
                .push(format!("increment:{id}:{delta}"));
            if *self.fail.lock().await {
                return Err(ApiError::unavailable("CT down"));
            }
            Ok(json!({"quantity":0}))
        }
        async fn destroy(&self, _: &str, _: &str) -> Result<(), ApiError> {
            self.calls.lock().await.push("destroy".into());
            Ok(())
        }
        async fn cart(&self, _: &str) -> Result<Value, ApiError> {
            Ok(self.cart.clone())
        }
        async fn add(&self, _: &str, payload: Value) -> Result<(), ApiError> {
            self.calls.lock().await.push(format!("add:{payload}"));
            Ok(())
        }
        async fn purchase(&self, _: &str) -> Result<Value, ApiError> {
            self.calls.lock().await.push("purchase".into());
            Ok(json!({"id":123}))
        }
    }
    fn adapter(order: Value) -> (NativeCardTrader, Arc<Memory>, Arc<MockHttp>) {
        let store = Arc::new(Memory {
            order,
            ..Default::default()
        });
        let http = Arc::new(MockHttp::default());
        (
            NativeCardTrader {
                store: store.clone(),
                http: http.clone(),
                buy: BuyConfig {
                    dry_run: false,
                    token: "token".into(),
                },
            },
            store,
            http,
        )
    }
    #[test]
    fn parsers_keep_reference_source_and_nested_cart_rules() {
        assert_eq!(ct_product("CardTrader:123"), "123");
        assert_eq!(ct_product("cardtrader:live:123"), "");
        assert_eq!(
            live_product(&json!({"sourceMetadata":{"externalProductId":123}})),
            "123"
        );
        assert_eq!(
            cart_items(&json!({"cart":{"orderItems":[1]}})),
            vec![json!(1)]
        );
        assert!(live_item(&json!({"source":"CARDTRADER_LIVE"})));
    }
    #[tokio::test]
    async fn sync_success_replays_without_decrement_and_failure_retries() {
        let (adapter, _, http) = adapter(
            json!({"inventory":{"lines":[{"listingId":"l","sourceListingId":"ct:7","quantity":2}]}}),
        );
        let request = CardTraderSaleSync {
            order_id: "o".into(),
            seller_uid: "s".into(),
            items: vec![json!({"listingId":"l"})],
        };
        *http.fail.lock().await = true;
        assert!(adapter.sync_after_sale(&request).await.is_err());
        *http.fail.lock().await = false;
        assert!(adapter
            .sync_after_sale(&request)
            .await
            .unwrap()
            .is_complete());
        assert!(adapter
            .sync_after_sale(&request)
            .await
            .unwrap()
            .is_complete());
        assert_eq!(
            http.calls
                .lock()
                .await
                .iter()
                .filter(|s| s.starts_with("increment"))
                .count(),
            2
        );
    }
    #[tokio::test]
    async fn purchased_marker_prevents_duplicate_purchase_and_busy_is_error() {
        let (adapter, store, http) = adapter(
            json!({"items":[{"listingId":"l","source":"cardtrader_live","sourceMetadata":{"cardtraderProductId":7,"shippingMode":"zero"}}]}),
        );
        let request = CardTraderBuyThrough {
            order_id: "o".into(),
            listing_id: "l".into(),
            quantity: 2,
            total_pkn: 10.0,
        };
        assert!(adapter.buy_through(&request).await.unwrap().is_complete());
        assert!(adapter.buy_through(&request).await.unwrap().is_complete());
        assert_eq!(
            http.calls
                .lock()
                .await
                .iter()
                .filter(|s| *s == "purchase")
                .count(),
            1
        );
        store
            .mark(
                "cardtrader_purchase_markers",
                "o__7",
                json!({"status":"cart_added"}),
            )
            .await
            .unwrap();
        assert!(adapter.buy_through(&request).await.is_err());
    }
    #[tokio::test]
    async fn disabled_buy_records_explicit_dry_run_and_does_not_call_http() {
        let (mut adapter, store, http) = adapter(
            json!({"items":[{"listingId":"l","source":"cardtrader_live","sourceListingId":"cardtrader:live:7"}]}),
        );
        adapter.buy.dry_run = true;
        let request = CardTraderBuyThrough {
            order_id: "o".into(),
            listing_id: "l".into(),
            quantity: 1,
            total_pkn: 1.0,
        };
        let outcome = adapter.buy_through(&request).await.unwrap();
        assert_eq!(outcome.to_json()["detail"]["dryRun"], true);
        assert!(http.calls.lock().await.is_empty());
        assert_eq!(
            store.markers.lock().await["cardtrader_purchase_markers/o__7"]["status"],
            "dry_run"
        );
    }
}
