//! In-process listing event bus of `marketplace-live.js` (`publishListing` /
//! `subscribe`). Writers (the listing sync engine) publish; the SSE route
//! fans frames out to subscribers filtered by card and seller.

use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::broadcast;

static BUS: LazyLock<broadcast::Sender<Value>> = LazyLock::new(|| broadcast::channel(1024).0);

fn text(value: Option<&str>) -> String {
    value.unwrap_or("").to_owned()
}

/// `publishListing(event)` — returns the payload like the JS.
pub fn publish_listing(card_id: Option<&str>, listing_id: Option<&str>, seller_uid: Option<&str>, quantity_available: Option<f64>, status: Option<&str>) -> Value {
    let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let quantity = quantity_available.filter(|q| q.is_finite()).map(|q| json!(q)).unwrap_or(Value::Null);
    let payload = json!({
        "type": "listing",
        "cardId": text(card_id),
        "listingId": text(listing_id),
        "sellerUid": text(seller_uid),
        "quantityAvailable": quantity,
        "status": text(status),
        "at": at,
    });
    let _ = BUS.send(payload.clone());
    payload
}

pub fn subscribe() -> broadcast::Receiver<Value> {
    BUS.subscribe()
}

pub fn client_count() -> usize {
    BUS.receiver_count()
}
