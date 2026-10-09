//! The CardTrader boundary.
//!
//! CardTrader HTTP (token handling, product export, buy-through calls) is owned
//! by the external integrations worker. This module is the *interface* the
//! commerce crate needs, so EUR fulfilment can drive it without duplicating any
//! HTTP: the integrations crate implements [`CardTraderPort`] and the root wires
//! it into [`DomainState`](crate::state::DomainState).
//!
//! The default is [`UnavailableCardTrader`], which answers
//! [`CardTraderOutcome::NotConfigured`] rather than pretending a sync happened.
//! Fulfilment records that outcome explicitly and stays `partial`.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::error::ApiError;

/// One seller's portion of a paid order, for post-sale inventory sync.
#[derive(Debug, Clone, PartialEq)]
pub struct CardTraderSaleSync {
    pub order_id: String,
    pub seller_uid: String,
    /// Order lines for this seller: `listingId`, `cardId`, `quantity`.
    pub items: Vec<Value>,
}

/// An external-sale buy-through request.
#[derive(Debug, Clone, PartialEq)]
pub struct CardTraderBuyThrough {
    pub order_id: String,
    pub listing_id: String,
    pub quantity: i64,
    /// `unitPricePkn * quantity`, as the order recorded it.
    pub total_pkn: f64,
}

/// What the integration reports back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardTraderOutcome {
    /// The integration performed the work; `detail` is its own report.
    Applied { detail: Value },
    /// The integration deliberately did nothing (nothing to sync, already done).
    Skipped { reason: String },
    /// No CardTrader integration is configured for this deployment or seller.
    NotConfigured { reason: String },
}

impl CardTraderOutcome {
    pub fn status(&self) -> &'static str {
        match self {
            Self::Applied { .. } => "applied",
            Self::Skipped { .. } => "skipped",
            Self::NotConfigured { .. } => "not_configured",
        }
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Applied { .. } => None,
            Self::Skipped { reason } | Self::NotConfigured { reason } => Some(reason),
        }
    }

    /// Only [`CardTraderOutcome::Applied`] and an explicit skip clear a step.
    pub fn is_complete(&self) -> bool {
        matches!(self, Self::Applied { .. } | Self::Skipped { .. })
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Applied { detail } => json!({ "status": "applied", "detail": detail }),
            Self::Skipped { reason } => json!({ "status": "skipped", "reason": reason }),
            Self::NotConfigured { reason } => {
                json!({ "status": "not_configured", "reason": reason })
            }
        }
    }
}

/// The commerce side of the CardTrader integration boundary.
///
/// Implementations live in the integrations crate. Both calls must be
/// idempotent per `order_id` (+ seller/listing), because fulfilment retries.
#[async_trait]
pub trait CardTraderPort: Send + Sync {
    /// Push the sold quantities to the seller's CardTrader inventory.
    async fn sync_after_sale(
        &self,
        request: &CardTraderSaleSync,
    ) -> Result<CardTraderOutcome, ApiError>;

    /// Buy the sold listing through so the external platform sees the sale.
    async fn buy_through(
        &self,
        request: &CardTraderBuyThrough,
    ) -> Result<CardTraderOutcome, ApiError>;
}

/// The default port used until the integrations crate is wired in.
pub struct UnavailableCardTrader;

#[async_trait]
impl CardTraderPort for UnavailableCardTrader {
    async fn sync_after_sale(
        &self,
        request: &CardTraderSaleSync,
    ) -> Result<CardTraderOutcome, ApiError> {
        Ok(CardTraderOutcome::NotConfigured {
            reason: format!(
                "No CardTrader integration is wired for seller {}.",
                request.seller_uid
            ),
        })
    }

    async fn buy_through(
        &self,
        request: &CardTraderBuyThrough,
    ) -> Result<CardTraderOutcome, ApiError> {
        Ok(CardTraderOutcome::NotConfigured {
            reason: format!(
                "No CardTrader integration is wired for listing {}.",
                request.listing_id
            ),
        })
    }
}

/// Split a paid order into per-seller CardTrader sync requests.
///
/// Only physical lines with a listing and a seller participate; NFT-only lines
/// never reach an inventory sync.
pub fn sale_sync_requests(order_id: &str, order: &Value) -> Vec<CardTraderSaleSync> {
    let mut requests: Vec<CardTraderSaleSync> = Vec::new();
    let Some(items) = order.get("items").and_then(Value::as_array) else {
        return requests;
    };
    for item in items {
        let seller_uid = item
            .get("sellerUid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let listing_id = item
            .get("listingId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let quantity = item.get("quantity").and_then(Value::as_i64).unwrap_or(0);
        if seller_uid.is_empty() || listing_id.is_empty() || quantity < 1 {
            continue;
        }
        if item.get("fulfillmentMode").and_then(Value::as_str) == Some("nft_only") {
            continue;
        }
        let line = json!({
            "listingId": listing_id,
            "cardId": item.get("cardId").cloned().unwrap_or(Value::Null),
            "quantity": quantity,
        });
        match requests
            .iter_mut()
            .find(|request| request.seller_uid == seller_uid)
        {
            Some(request) => request.items.push(line),
            None => requests.push(CardTraderSaleSync {
                order_id: order_id.to_string(),
                seller_uid,
                items: vec![line],
            }),
        }
    }
    requests
}

/// Buy-through requests for an order, one per line that carries a listing.
pub fn buy_through_requests(order_id: &str, order: &Value) -> Vec<CardTraderBuyThrough> {
    let mut requests = Vec::new();
    let Some(items) = order.get("items").and_then(Value::as_array) else {
        return requests;
    };
    for item in items {
        let listing_id = item
            .get("listingId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let quantity = item.get("quantity").and_then(Value::as_i64).unwrap_or(0);
        if listing_id.is_empty() || quantity < 1 {
            continue;
        }
        let unit = item
            .get("unitPricePkn")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .unwrap_or(0.0);
        requests.push(CardTraderBuyThrough {
            order_id: order_id.to_string(),
            listing_id,
            quantity,
            total_pkn: unit * quantity as f64,
        });
    }
    requests
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcomes_report_their_status_and_completeness() {
        let applied = CardTraderOutcome::Applied {
            detail: json!({ "updated": 2 }),
        };
        assert_eq!(applied.status(), "applied");
        assert!(applied.is_complete());
        assert!(applied.reason().is_none());

        let skipped = CardTraderOutcome::Skipped {
            reason: "nothing to sync".into(),
        };
        assert_eq!(skipped.status(), "skipped");
        assert!(skipped.is_complete());

        // Not configured is never complete: the step stays open.
        let missing = CardTraderOutcome::NotConfigured {
            reason: "no token".into(),
        };
        assert_eq!(missing.status(), "not_configured");
        assert!(!missing.is_complete());
        assert_eq!(missing.reason(), Some("no token"));
        assert_eq!(missing.to_json()["reason"], json!("no token"));
    }

    #[tokio::test]
    async fn the_default_port_says_not_configured_instead_of_faking_a_sync() {
        let port = UnavailableCardTrader;
        let sync = port
            .sync_after_sale(&CardTraderSaleSync {
                order_id: "o1".into(),
                seller_uid: "s1".into(),
                items: vec![json!({ "listingId": "l1", "quantity": 1 })],
            })
            .await
            .unwrap();
        assert!(!sync.is_complete());
        assert!(sync.reason().unwrap().contains("s1"));

        let buy = port
            .buy_through(&CardTraderBuyThrough {
                order_id: "o1".into(),
                listing_id: "l1".into(),
                quantity: 1,
                total_pkn: 100.0,
            })
            .await
            .unwrap();
        assert!(!buy.is_complete());
        assert!(buy.reason().unwrap().contains("l1"));
    }

    #[test]
    fn sync_requests_group_physical_lines_by_seller() {
        let order = json!({
            "items": [
                { "sellerUid": "s1", "listingId": "l1", "cardId": "c1", "quantity": 2 },
                { "sellerUid": "s1", "listingId": "l2", "quantity": 1 },
                { "sellerUid": "s2", "listingId": "l3", "quantity": 1 },
                // Skipped: NFT-only, no listing, no seller, zero quantity.
                { "sellerUid": "s1", "listingId": "l4", "quantity": 1,
                  "fulfillmentMode": "nft_only" },
                { "sellerUid": "s2", "quantity": 1 },
                { "listingId": "l5", "quantity": 1 },
                { "sellerUid": "s3", "listingId": "l6", "quantity": 0 },
            ],
        });
        let requests = sale_sync_requests("order-1", &order);
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].seller_uid, "s1");
        assert_eq!(requests[0].items.len(), 2);
        assert_eq!(requests[0].items[0]["quantity"], json!(2));
        assert_eq!(requests[1].seller_uid, "s2");
        assert_eq!(requests[1].items.len(), 1);
        assert_eq!(requests[0].order_id, "order-1");
    }

    #[test]
    fn buy_through_requests_carry_the_recorded_total() {
        let order = json!({
            "items": [
                { "listingId": "l1", "quantity": 2, "unitPricePkn": 150 },
                { "listingId": "l2", "quantity": 1 },
                { "quantity": 1 },
            ],
        });
        let requests = buy_through_requests("order-1", &order);
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].listing_id, "l1");
        assert_eq!(requests[0].quantity, 2);
        assert_eq!(requests[0].total_pkn, 300.0);
        // A missing unit price is zero, never a fabricated number.
        assert_eq!(requests[1].total_pkn, 0.0);
    }

    #[test]
    fn empty_orders_produce_no_requests() {
        assert!(sale_sync_requests("o", &json!({})).is_empty());
        assert!(buy_through_requests("o", &json!({ "items": [] })).is_empty());
    }
}
