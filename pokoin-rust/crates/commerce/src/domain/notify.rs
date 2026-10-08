//! Seller sale notifications, ported from `_marketplace_sale_notifications.js`.
//!
//! The idempotency marker is the Firestore collection
//! `order_seller_sale_notifications`, claimed inside a transaction with the doc
//! id `encodeURIComponent(orderId)__encodeURIComponent(sellerUid)`. There is no
//! SQL queue: delivery state lives on that document.

use serde_json::{json, Value};

/// The real Firestore collection; see also
/// `store::ORDER_SELLER_SALE_NOTIFICATIONS`.
pub const NOTIFICATION_COLLECTION: &str = crate::store::ORDER_SELLER_SALE_NOTIFICATIONS;

/// `encodeURIComponent`: unreserved marks are kept, everything else is escaped.
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let character = *byte as char;
        if character.is_ascii_alphanumeric()
            || matches!(character, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
        {
            out.push(character);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `notificationMarkerId(orderId, sellerUid)`.
pub fn notification_marker_id(order_id: &str, seller_uid: &str) -> String {
    format!(
        "{}__{}",
        encode_uri_component(&clean_text(Some(&Value::String(order_id.to_string())), 300)),
        encode_uri_component(&clean_text(Some(&Value::String(seller_uid.to_string())), 300))
    )
}

fn clean_text(value: Option<&Value>, max: usize) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(max)
        .collect()
}

fn number_value(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

pub fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// `formatPkn`: integers stay bare, fractions round to two places.
pub fn format_pkn(value: f64) -> String {
    if value.fract() == 0.0 && value.is_finite() {
        format!("{} PKN", value as i64)
    } else {
        format!("{} PKN", (value * 100.0).round() / 100.0)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SellerGroup {
    pub seller_uid: String,
    pub seller_name: String,
    pub items: Vec<Value>,
    pub total_pkn: f64,
    pub quantity: i64,
}

pub fn seller_uid_for_item(item: &Value) -> String {
    let direct = clean_text(item.get("sellerUid"), 160);
    if !direct.is_empty() {
        return direct;
    }
    clean_text(item.get("seller_uid"), 160)
}

fn seller_name_for_item(item: &Value) -> String {
    let direct = clean_text(item.get("sellerName"), 120);
    if !direct.is_empty() {
        return direct;
    }
    let legacy = clean_text(item.get("seller_name"), 120);
    if !legacy.is_empty() {
        return legacy;
    }
    "Pokoin seller".to_string()
}

fn card_name_for_item(item: &Value) -> String {
    for key in ["cardName", "card_name"] {
        let value = clean_text(item.get(key), 240);
        if !value.is_empty() {
            return value;
        }
    }
    let nested = clean_text(item.get("card").and_then(|card| card.get("name")), 240);
    if !nested.is_empty() {
        return nested;
    }
    "Pokemon card".to_string()
}

pub fn item_quantity(item: &Value) -> i64 {
    let quantity = number_value(item.get("quantity"), 0.0) as i64;
    if quantity > 0 {
        quantity
    } else {
        1
    }
}

fn item_unit_price(item: &Value) -> f64 {
    for key in ["unitPricePkn", "pricePkn", "price_pkn"] {
        if let Some(value) = item.get(key).and_then(Value::as_f64) {
            if value.is_finite() {
                return value;
            }
        }
    }
    0.0
}

/// `itemTotalPrice`: an explicit positive total wins, else unit x quantity.
pub fn item_total_price(item: &Value) -> f64 {
    for key in ["totalPricePkn", "total_pkn"] {
        if let Some(value) = item.get(key).and_then(Value::as_f64) {
            if value.is_finite() && value > 0.0 {
                return value;
            }
        }
    }
    item_unit_price(item) * item_quantity(item) as f64
}

/// `groupOrderItemsBySeller`.
pub fn group_order_items_by_seller(items: &[Value]) -> Vec<SellerGroup> {
    let mut groups: Vec<SellerGroup> = Vec::new();
    for item in items {
        let seller_uid = seller_uid_for_item(item);
        if seller_uid.is_empty() {
            continue;
        }
        let quantity = item_quantity(item);
        let total = item_total_price(item);
        let name = seller_name_for_item(item);
        match groups.iter_mut().find(|group| group.seller_uid == seller_uid) {
            Some(group) => {
                group.items.push(item.clone());
                group.total_pkn += total;
                group.quantity += quantity;
                if group.seller_name.is_empty() || group.seller_name == "Pokoin seller" {
                    group.seller_name = name;
                }
            }
            None => groups.push(SellerGroup {
                seller_uid,
                seller_name: name,
                items: vec![item.clone()],
                total_pkn: total,
                quantity,
            }),
        }
    }
    groups
}

/// `itemDescription(item)`.
pub fn item_description(item: &Value) -> String {
    let mut details = vec![card_name_for_item(item)];
    let condition = clean_text(item.get("condition"), 40);
    if !condition.is_empty() {
        details.push(condition);
    }
    let language = clean_text(item.get("language"), 20);
    if !language.is_empty() {
        details.push(language);
    }
    if item.get("reverse").and_then(Value::as_bool) == Some(true) {
        details.push("Reverse".to_string());
    }
    if item.get("graded").and_then(Value::as_bool) == Some(true) {
        let mut graded = vec![];
        let company = clean_text(item.get("gradingCompany"), 80);
        graded.push(if company.is_empty() {
            "Graded".to_string()
        } else {
            company
        });
        let grade = clean_text(item.get("grade"), 40);
        if !grade.is_empty() {
            graded.push(grade);
        }
        details.push(graded.join(" "));
    }
    details.join(" - ")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailMessage {
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// `buildSellerSaleEmail({ orderId, sellerGroup })`.
pub fn build_seller_sale_email(order_id: &str, group: &SellerGroup) -> EmailMessage {
    let short_order_id: String = order_id.chars().take(80).collect();
    let seller_name = if group.seller_name.is_empty() {
        "Pokoin seller".to_string()
    } else {
        group.seller_name.clone()
    };
    let plural = if group.quantity == 1 { "" } else { "s" };
    let subject = format!("You sold {} card{plural} on Pokoin", group.quantity);

    let item_lines: Vec<String> = group
        .items
        .iter()
        .map(|item| {
            format!(
                "- {} x {} at {} each ({})",
                item_description(item),
                item_quantity(item),
                format_pkn(item_unit_price(item)),
                format_pkn(item_total_price(item)),
            )
        })
        .collect();
    let mut notes: Vec<String> = group
        .items
        .iter()
        .map(|item| clean_text(item.get("buyerNotes"), 500))
        .filter(|note| !note.is_empty())
        .collect();
    notes.dedup();

    let mut text_parts = vec![
        format!("Hi {seller_name},"),
        String::new(),
        format!(
            "Your card{} {} sold and the order is paid.",
            plural,
            if group.quantity == 1 { "has" } else { "have" }
        ),
        String::new(),
        format!("Order: {short_order_id}"),
        format!("Seller payout credited: {}", format_pkn(group.total_pkn)),
        String::new(),
        "Sold cards:".to_string(),
    ];
    text_parts.extend(item_lines.iter().cloned());
    if !notes.is_empty() {
        text_parts.push(String::new());
        text_parts.push("Buyer notes:".to_string());
        text_parts.extend(notes.iter().map(|note| format!("- {note}")));
    }
    text_parts.push(String::new());
    text_parts.push(
        "Next steps: open your Pokoin seller orders, confirm fulfillment, and prepare shipping if the listing included shipping."
            .to_string(),
    );
    let text = text_parts.join("\n");

    let html_items: String = group
        .items
        .iter()
        .map(|item| {
            format!(
                "\n    <li>\n      <strong>{}</strong><br>\n      Qty {} at {} each\n      ({})\n    </li>\n  ",
                escape_html(&item_description(item)),
                item_quantity(item),
                escape_html(&format_pkn(item_unit_price(item))),
                escape_html(&format_pkn(item_total_price(item))),
            )
        })
        .collect();
    let html_notes = if notes.is_empty() {
        String::new()
    } else {
        format!(
            "<h2 style=\"font-size:16px;margin:20px 0 8px\">Buyer notes</h2><ul>{}</ul>",
            notes
                .iter()
                .map(|note| format!("<li>{}</li>", escape_html(note)))
                .collect::<String>()
        )
    };
    let html = format!(
        "\n    <div style=\"font-family:Inter,Arial,sans-serif;line-height:1.6;color:#0f172a\">\n      <h1 style=\"margin:0 0 16px\">You made a sale on Pokoin</h1>\n      <p>Hi {},</p>\n      <p>Your card{} {} sold and the order is paid.</p>\n      <p><strong>Order:</strong> {}<br>\n      <strong>Seller payout credited:</strong> {}</p>\n      <h2 style=\"font-size:16px;margin:20px 0 8px\">Sold cards</h2>\n      <ul>{}</ul>\n      {}\n      <p style=\"margin-top:20px\">Next steps: open your Pokoin seller orders, confirm fulfillment, and prepare shipping if the listing included shipping.</p>\n      <p style=\"color:#64748b;font-size:14px\">Buyer private contact details are not included in this notification.</p>\n    </div>\n  ",
        escape_html(&seller_name),
        plural,
        if group.quantity == 1 { "has" } else { "have" },
        escape_html(&short_order_id),
        escape_html(&format_pkn(group.total_pkn)),
        html_items,
        html_notes,
    );

    EmailMessage {
        subject,
        text,
        html,
    }
}

/// `orderIsPaid`.
pub fn order_is_paid(order: &Value) -> bool {
    const PAID: [&str; 3] = ["paid", "completed", "fulfilled"];
    let payment_status = clean_text(order.get("paymentStatus"), 40).to_ascii_lowercase();
    let status = clean_text(order.get("status"), 40).to_ascii_lowercase();
    PAID.contains(&payment_status.as_str())
        || PAID.contains(&status.as_str())
        || order.get("paidAt").map(|value| !value.is_null()).unwrap_or(false)
}

/// The claim document written before any email is attempted.
pub fn notification_marker_body(
    order_id: &str,
    group: &SellerGroup,
    seller_email: &str,
    now_iso: &str,
) -> Value {
    json!({
        "orderId": order_id,
        "sellerUid": group.seller_uid,
        "sellerEmail": seller_email,
        "itemCount": group.items.len(),
        "quantity": group.quantity,
        "totalPkn": group.total_pkn,
        "status": "claimed",
        "createdAt": now_iso,
        "updatedAt": now_iso,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_ids_are_url_encoded_and_path_safe() {
        assert_eq!(
            notification_marker_id("order-1", "seller-1"),
            "order-1__seller-1"
        );
        // A slash must never appear in a document id.
        let id = notification_marker_id("a/b", "c d");
        assert_eq!(id, "a%2Fb__c%20d");
        assert!(!id.contains('/'));
        // Unreserved marks survive, like encodeURIComponent.
        assert_eq!(encode_uri_component("a-b_c.d!e~f*g'h(i)"), "a-b_c.d!e~f*g'h(i)");
    }

    #[test]
    fn pkn_formatting_matches_the_node_helper() {
        assert_eq!(format_pkn(2642.0), "2642 PKN");
        assert_eq!(format_pkn(12.5), "12.5 PKN");
        assert_eq!(format_pkn(1.234), "1.23 PKN");
        assert_eq!(format_pkn(0.0), "0 PKN");
        // Float rounding matches JS: 1.005 * 100 is 100.499…, so it rounds to 1.
        assert_eq!(format_pkn(1.005), "1 PKN");
    }

    #[test]
    fn paid_statuses_match_the_node_set() {
        for status in ["paid", "completed", "fulfilled", "PAID"] {
            assert!(order_is_paid(&json!({ "paymentStatus": status })), "{status}");
        }
        assert!(order_is_paid(&json!({ "status": "paid" })));
        assert!(order_is_paid(&json!({ "paidAt": "2026-10-08T00:00:00Z" })));
        assert!(!order_is_paid(&json!({ "paymentStatus": "pending_stripe" })));
        assert!(!order_is_paid(&json!({})));
    }

    #[test]
    fn seller_groups_aggregate_quantities_and_totals() {
        let groups = group_order_items_by_seller(&[
            json!({ "sellerUid": "s1", "cardName": "Pikachu", "quantity": 2,
                    "unitPricePkn": 100, "condition": "NM", "language": "EN" }),
            json!({ "sellerUid": "s1", "cardName": "Charizard", "quantity": 1,
                    "totalPricePkn": 250 }),
            json!({ "sellerUid": "s2", "cardName": "Mew", "quantity": 1, "unitPricePkn": 50 }),
            // No seller: skipped entirely.
            json!({ "cardName": "Orphan" }),
        ]);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].seller_uid, "s1");
        assert_eq!(groups[0].quantity, 3);
        assert_eq!(groups[0].total_pkn, 450.0);
        assert_eq!(groups[0].items.len(), 2);
        assert_eq!(groups[1].total_pkn, 50.0);
    }

    #[test]
    fn item_descriptions_follow_the_node_order() {
        let item = json!({
            "cardName": "Pikachu", "condition": "NM", "language": "EN",
            "reverse": true, "graded": true, "gradingCompany": "PSA", "grade": "10",
        });
        assert_eq!(item_description(&item), "Pikachu - NM - EN - Reverse - PSA 10");
        // Graded without a company still names the grade.
        let partial = json!({ "cardName": "Mew", "graded": true, "grade": "9" });
        assert_eq!(item_description(&partial), "Mew - Graded 9");
        // A nested card name is used when there is no flat one.
        let nested = json!({ "card": { "name": "Eevee" } });
        assert_eq!(item_description(&nested), "Eevee");
        // Fallbacks.
        assert_eq!(item_description(&json!({})), "Pokemon card");
    }

    #[test]
    fn item_totals_prefer_an_explicit_positive_total() {
        assert_eq!(item_total_price(&json!({ "unitPricePkn": 100, "quantity": 3 })), 300.0);
        assert_eq!(
            item_total_price(&json!({ "unitPricePkn": 100, "quantity": 3, "totalPricePkn": 250 })),
            250.0
        );
        // A non-positive explicit total is ignored.
        assert_eq!(
            item_total_price(&json!({ "unitPricePkn": 100, "quantity": 2, "totalPricePkn": 0 })),
            200.0
        );
    }

    #[test]
    fn the_sale_email_states_quantity_subject_and_payout() {
        let group = SellerGroup {
            seller_uid: "s1".into(),
            seller_name: "Alice".into(),
            items: vec![json!({ "cardName": "Pikachu", "quantity": 2, "unitPricePkn": 100 })],
            total_pkn: 200.0,
            quantity: 2,
        };
        let message = build_seller_sale_email("order-1", &group);
        assert_eq!(message.subject, "You sold 2 cards on Pokoin");
        assert!(message.text.contains("Hi Alice,"));
        assert!(message.text.contains("Order: order-1"));
        assert!(message.text.contains("Seller payout credited: 200 PKN"));
        assert!(message.text.contains("Your cards have sold"));
        assert!(message.html.contains("You made a sale on Pokoin"));
        assert!(message.html.contains("Pikachu"));
        assert!(message.html.contains("Buyer private contact details are not included"));
        assert!(!message.html.contains("buyerUid"));

        // A single card reads singular.
        let single = SellerGroup {
            quantity: 1,
            ..group
        };
        let message = build_seller_sale_email("order-2", &single);
        assert_eq!(message.subject, "You sold 1 card on Pokoin");
        assert!(message.text.contains("Your card has sold"));
    }

    #[test]
    fn escrow_marker_bodies_record_the_claim() {
        let group = SellerGroup {
            seller_uid: "s1".into(),
            seller_name: "Alice".into(),
            items: vec![json!({ "cardName": "Pikachu", "quantity": 1 })],
            total_pkn: 10.0,
            quantity: 1,
        };
        let body = notification_marker_body("order-1", &group, "a@example.com", "2026-10-08T00:00:00Z");
        assert_eq!(body["sellerUid"], json!("s1"));
        assert_eq!(body["sellerEmail"], json!("a@example.com"));
        assert_eq!(body["itemCount"], json!(1));
        assert_eq!(body["quantity"], json!(1));
        assert_eq!(body["totalPkn"], json!(10.0));
        assert_eq!(body["status"], json!("claimed"));
    }

    #[test]
    fn html_is_escaped() {
        assert_eq!(escape_html("<b>&\"'"), "&lt;b&gt;&amp;&quot;&#39;");
        let group = SellerGroup {
            seller_uid: "s1".into(),
            seller_name: "<script>".into(),
            items: vec![json!({ "cardName": "<img>", "quantity": 1, "unitPricePkn": 1 })],
            total_pkn: 1.0,
            quantity: 1,
        };
        let message = build_seller_sale_email("order-1", &group);
        assert!(!message.html.contains("<script>"));
        assert!(!message.html.contains("<img>"));
        assert!(message.html.contains("&lt;script&gt;"));
    }
}
