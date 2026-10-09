//! Transactional email through Resend, ported from `_email.js`.
//!
//! `sendEmail` posts to `https://api.resend.com/emails`. Without
//! `RESEND_API_KEY` it reports `skipped` with the Node reason string instead of
//! pretending a message was delivered.

use serde_json::{json, Value};

use crate::error::ApiError;

pub const DEFAULT_FROM: &str = "Pokoin <verify@pokoin.com>";
pub const DEFAULT_NO_REPLY_FROM: &str = "Pokoin <no-reply@pokoin.com>";
pub const MARKETPLACE_FROM: &str = "market@pokoin.com";
pub const DEFAULT_EARN_PKN_FROM: &str = "Pokoin <no-reply@pokoin.com>";
pub const DEFAULT_EARN_PKN_TO: &str = "contact@pokoin.com";

pub fn email_from() -> String {
    std::env::var("EMAIL_FROM")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_FROM.to_string())
}

pub fn no_reply_email_from() -> String {
    std::env::var("NO_REPLY_EMAIL_FROM")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_NO_REPLY_FROM.to_string())
}

/// `earnPknEmailFrom`.
pub fn earn_pkn_email_from() -> String {
    std::env::var("EARN_PKN_EMAIL_FROM")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            std::env::var("NO_REPLY_EMAIL_FROM")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_EARN_PKN_FROM.to_string())
        })
}

/// `earnPknEmailTo`.
pub fn earn_pkn_email_to() -> String {
    std::env::var("EARN_PKN_EMAIL_TO")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_EARN_PKN_TO.to_string())
}

pub fn resend_api_key() -> Option<String> {
    std::env::var("RESEND_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// `canEmailUser`: a deliverable address that is not a wallet alias.
pub fn can_email_user(email: &str) -> bool {
    let normalized = email.trim().to_ascii_lowercase();
    if normalized.ends_with("@wallet.pokoin.local") {
        return false;
    }
    let mut parts = normalized.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !normalized.contains(char::is_whitespace)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailDelivery {
    pub skipped: bool,
    pub id: Option<String>,
    pub reason: Option<String>,
}

impl EmailDelivery {
    pub fn skipped(reason: impl Into<String>) -> Self {
        Self {
            skipped: true,
            id: None,
            reason: Some(reason.into()),
        }
    }
}

/// `sendEmail({ from, to, subject, html, text })`.
pub async fn send_email(
    http: &reqwest::Client,
    from: &str,
    to: &str,
    subject: &str,
    text: &str,
    html: &str,
) -> Result<EmailDelivery, ApiError> {
    let Some(api_key) = resend_api_key() else {
        return Ok(EmailDelivery::skipped("RESEND_API_KEY is not configured."));
    };
    let body = json!({
        "from": from,
        "to": to,
        "subject": subject,
        "html": html,
        "text": text,
    });
    let response = http
        .post("https://api.resend.com/emails")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|_| ApiError::unavailable("Email delivery failed."))?;
    let status = response.status();
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let message = payload
            .get("message")
            .or_else(|| payload.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("Email delivery failed.");
        return Err(ApiError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            message.to_string(),
        )
        .with_code("email_delivery_failed"));
    }
    Ok(EmailDelivery {
        skipped: false,
        id: payload
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value.to_string()),
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallet_aliases_and_malformed_addresses_are_not_deliverable() {
        assert!(can_email_user("seller@example.com"));
        assert!(can_email_user("  Seller@Example.COM "));
        assert!(!can_email_user("seller@wallet.pokoin.local"));
        assert!(!can_email_user(""));
        assert!(!can_email_user("no-at-sign"));
        assert!(!can_email_user("a@b"));
        assert!(!can_email_user("@example.com"));
        assert!(!can_email_user("a@.com"));
        assert!(!can_email_user("a@b."));
        assert!(!can_email_user("a b@example.com"));
        assert!(!can_email_user("a@b@example.com"));
    }

    #[test]
    fn the_marketplace_sender_is_the_node_constant() {
        assert_eq!(MARKETPLACE_FROM, "market@pokoin.com");
    }

    #[test]
    fn a_missing_key_is_reported_as_skipped_not_sent() {
        let delivery = EmailDelivery::skipped("RESEND_API_KEY is not configured.");
        assert!(delivery.skipped);
        assert!(delivery.id.is_none());
        assert_eq!(
            delivery.reason.as_deref(),
            Some("RESEND_API_KEY is not configured.")
        );
    }
}
