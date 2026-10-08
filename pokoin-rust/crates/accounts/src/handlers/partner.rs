//! `pokoin-partner` — the API contract for the future Pokoin Partner store app
//! (intake / bag / handoff) plus the public Flex store directory.
//!
//! Public today: `GET ?action=directory` and `GET ?action=contract`.
//! The partner-authenticated mutations (`intake`, `bag`, `receive-hub`,
//! `handoff`) and `pending` answer **501 `coming_soon`**, which is exactly what
//! the live Node handler does — the Partner app is not launched yet, so this is
//! the real contract, not a stub of ours. Unknown actions answer 400 with the
//! action list, so a client can discover the surface.

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Value as Json};

use crate::state::DomainState;

use super::{json_cached, json_with_cors, parse_body, string_field};

/// Placeholder shops for layout; live partners replace this list at Flex launch.
pub const PLACEHOLDER_STORES: [(&str, &str, &str, &str, &str, &str, &str); 4] = [
    (
        "milan-ace",
        "Ace Hobby",
        "Milan",
        "Italy",
        "IT",
        "drop-off + pick-up",
        "placeholder",
    ),
    (
        "berlin-deck",
        "Deck & Dice",
        "Berlin",
        "Germany",
        "DE",
        "drop-off + pick-up",
        "placeholder",
    ),
    (
        "lisbon-cardforge",
        "Cardforge",
        "Lisbon",
        "Portugal",
        "PT",
        "drop-off + pick-up",
        "placeholder",
    ),
    (
        "copenhagen-tabletop",
        "Tabletop North",
        "Copenhagen",
        "Denmark",
        "DK",
        "pick-up",
        "placeholder",
    ),
];

/// `cleanAction`: lowercase, trimmed, 40 characters.
pub fn clean_action(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .take(40)
        .collect()
}

pub fn placeholder_stores() -> Json {
    Json::Array(
        PLACEHOLDER_STORES
            .iter()
            .map(|(id, name, city, country, code, role, status)| {
                json!({
                    "id": id,
                    "name": name,
                    "city": city,
                    "country": country,
                    "countryCode": code,
                    "role": role,
                    "status": status,
                })
            })
            .collect(),
    )
}

/// The machine-readable action list the Partner app reads.
pub fn partner_actions() -> Json {
    json!([
        {
            "action": "directory",
            "method": "GET",
            "auth": "public",
            "purpose": "List partner stores for pokoin.com/flex and checkout Flex picker.",
        },
        {
            "action": "contract",
            "method": "GET",
            "auth": "public",
            "purpose": "Describe Partner app endpoints and QR payload shapes.",
        },
        {
            "action": "intake",
            "method": "POST",
            "auth": "partner",
            "purpose": "Scan seller drop-off QR; accept an already-packed seller parcel into the store (shop does not pack cards).",
            "body": ["storeId", "parcelQr", "orderId?"],
        },
        {
            "action": "bag",
            "method": "POST",
            "auth": "partner",
            "purpose": "Load accepted parcels into the shared Pokoin bag (~20 kg target) bound for the sorting center.",
            "body": ["storeId", "bagId", "parcelIds"],
        },
        {
            "action": "receive-hub",
            "method": "POST",
            "auth": "partner",
            "purpose": "Receive sorted packets from the Pokoin sorting center for local buyer pickup.",
            "body": ["storeId", "bagQr"],
        },
        {
            "action": "handoff",
            "method": "POST",
            "auth": "partner",
            "purpose": "Scan buyer pickup QR/code; release only that packet.",
            "body": ["storeId", "pickupQr"],
        },
        {
            "action": "pending",
            "method": "GET",
            "auth": "partner",
            "purpose": "Parcels at this store awaiting pickup or awaiting outbound bag.",
            "query": ["storeId"],
        }
    ])
}

/// The public action names, in contract order (for the 400 fallback).
pub fn action_names() -> Vec<&'static str> {
    vec![
        "directory",
        "contract",
        "intake",
        "bag",
        "receive-hub",
        "handoff",
        "pending",
    ]
}

/// `comingSoon(action)` — the honest 501 body the live handler returns.
pub fn coming_soon(action: &str) -> Json {
    json!({
        "ok": false,
        "code": "coming_soon",
        "action": action,
        "message": "Pokoin Partner app mutations are not live yet. Directory and contract are public.",
    })
}

pub fn partner_contract() -> Json {
    json!({
        "ok": true,
        "product": "pokoin_flex",
        "partnerApp": "pokoin-partner",
        "status": "scaffolding",
        "vision": {
            "summary": "Seller packs in Flex equipment → partner drop-off → shared ~20 kg Pokoin bag → Pokoin sorting center → partner pickup or home. Cheaper than solo shipping; fewer half-empty parcels.",
            "not": "Not CardTrader Zero door-to-warehouse alone: fill the paid weight bracket with many seller packs before the trunk moves.",
            "environment": "Fewer packets on the road; less shipping overall.",
            "equipment": "Sturdy Flex boxes padded on the inside for high-quality travel.",
        },
        "bag": {
            "targetKg": 20,
            "filler": "partner_store",
            "destination": "pokoin_sorting_center",
            "lastMile": ["flex_partner_pickup", "home"],
            "parcelEquipment": {
                "kind": "pokoin_flex_box",
                "shell": "sturdy",
                "interior": "padded",
                "purpose": "high_quality_travel",
            },
        },
        "qr": {
            "sellerIntake": { "type": "pokoin.flex.intake", "fields": ["orderId", "sellerUid", "exp"] },
            "buyerPickup": { "type": "pokoin.flex.handoff", "fields": ["orderId", "buyerUid", "code", "exp"] },
            "sharedBag": { "type": "pokoin.flex.bag", "fields": ["bagId", "routeId", "fromStoreId", "toStoreId"] },
        },
        "actions": partner_actions(),
    })
}

/// `GET|POST /api/pokoin-partner`.
pub async fn pokoin_partner(
    State(_state): State<DomainState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    method: axum::http::Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let _ = &headers;
    let body = parse_body(&body);
    // Node picked the first *truthy raw* value and only then cleaned it:
    // `cleanAction(query || body || 'directory')`. A whitespace query value is
    // therefore truthy, wins, and cleans to "" rather than falling through.
    let from_query = query.get("action").cloned().unwrap_or_default();
    let from_body = string_field(&body, "action");
    let raw = if !from_query.is_empty() {
        from_query
    } else if !from_body.is_empty() {
        from_body
    } else {
        "directory".to_string()
    };
    let action = clean_action(&raw);

    if method == axum::http::Method::GET && (action == "directory" || action.is_empty()) {
        return json_cached(
            StatusCode::OK,
            json!({
                "ok": true,
                "status": "placeholder",
                "product": "pokoin_flex",
                "stores": placeholder_stores(),
                "note": "Placeholder shops for layout. Live partners replace this list at Flex launch.",
            }),
            "public, max-age=60",
        );
    }

    if method == axum::http::Method::GET && action == "contract" {
        return json_cached(StatusCode::OK, partner_contract(), "public, max-age=300");
    }

    if method == axum::http::Method::GET && action == "pending" {
        return json_with_cors(StatusCode::NOT_IMPLEMENTED, coming_soon("pending"));
    }

    if method == axum::http::Method::POST
        && ["intake", "bag", "receive-hub", "handoff"].contains(&action.as_str())
    {
        return json_with_cors(StatusCode::NOT_IMPLEMENTED, coming_soon(&action));
    }

    json_with_cors(
        StatusCode::BAD_REQUEST,
        json!({
            "ok": false,
            "error": format!(
                "Unknown pokoin-partner action: {}",
                if action.is_empty() { "(empty)" } else { action.as_str() }
            ),
            "actions": action_names(),
        }),
    )
}

/// `Allow: GET, POST`.
pub async fn pokoin_partner_other() -> Response {
    super::method_not_allowed("GET, POST")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_resolution_matches_the_node_or_chain() {
        // A whitespace raw value is truthy, so it cleans to empty rather than
        // defaulting to directory.
        assert_eq!(clean_action(" "), "");
        assert_eq!(clean_action("  "), "");
        assert_eq!(clean_action("DIRECTORY"), "directory");
    }

    #[test]
    fn actions_are_normalized() {
        assert_eq!(clean_action("  Directory "), "directory");
        assert_eq!(clean_action("RECEIVE-HUB"), "receive-hub");
        assert_eq!(clean_action(&"a".repeat(60)).len(), 40);
        assert_eq!(clean_action(""), "");
    }

    #[test]
    fn placeholder_stores_match_the_node_seed() {
        let stores = placeholder_stores();
        let rows = stores.as_array().unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0]["id"], json!("milan-ace"));
        assert_eq!(rows[0]["countryCode"], json!("IT"));
        assert_eq!(rows[0]["role"], json!("drop-off + pick-up"));
        assert_eq!(rows[3]["id"], json!("copenhagen-tabletop"));
        assert_eq!(rows[3]["role"], json!("pick-up"));
    }

    #[test]
    fn the_contract_describes_both_qr_payloads_and_the_bag() {
        let contract = partner_contract();
        assert_eq!(contract["ok"], json!(true));
        assert_eq!(contract["product"], json!("pokoin_flex"));
        assert_eq!(contract["status"], json!("scaffolding"));
        assert_eq!(contract["bag"]["targetKg"], json!(20));
        assert_eq!(
            contract["bag"]["destination"],
            json!("pokoin_sorting_center")
        );
        assert_eq!(
            contract["qr"]["sellerIntake"]["fields"],
            json!(["orderId", "sellerUid", "exp"])
        );
        assert_eq!(
            contract["qr"]["buyerPickup"]["fields"],
            json!(["orderId", "buyerUid", "code", "exp"])
        );
        assert_eq!(
            contract["qr"]["sharedBag"]["fields"],
            json!(["bagId", "routeId", "fromStoreId", "toStoreId"])
        );
        assert_eq!(contract["actions"].as_array().unwrap().len(), 7);
    }

    #[test]
    fn coming_soon_is_the_honest_501_body() {
        let body = coming_soon("intake");
        assert_eq!(body["ok"], json!(false));
        assert_eq!(body["code"], json!("coming_soon"));
        assert_eq!(body["action"], json!("intake"));
        assert!(body["message"].as_str().unwrap().contains("not live yet"));
    }

    #[test]
    fn action_names_match_the_contract_order() {
        assert_eq!(
            action_names(),
            vec![
                "directory",
                "contract",
                "intake",
                "bag",
                "receive-hub",
                "handoff",
                "pending"
            ]
        );
        // Every name appears in the contract's action list.
        let contract = partner_contract();
        let listed: Vec<String> = contract["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["action"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(listed, action_names());
    }
}
