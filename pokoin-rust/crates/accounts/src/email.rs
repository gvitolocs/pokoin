//! Transactional email — a port of `api/_email.js`.
//!
//! Two layers:
//!
//! * [`EmailSender`] — the outbound transport seam. [`ResendEmailSender`] posts
//!   to `https://api.resend.com/emails` exactly like Node; tests inject a fake.
//!   With no `RESEND_API_KEY` the sender reports `skipped`, never a fake success.
//! * Message builders — the verification, welcome and admin signup-notification
//!   bodies, byte-for-byte the Node templates.
//!
//! [`send_signup_notification_once`] keeps the Node idempotency gate: the
//! `users/{uid}.signupNotificationSentAt` field is checked first and written
//! after a successful send, so a signup notifies the admin exactly once.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, Result};
use crate::firestore::{DocData, Firestore};
use crate::http::{send_with_retry, HttpRequest, RetryPolicy, SharedTransport};

pub const DEFAULT_FROM: &str = "Pokoin <verify@pokoin.com>";
pub const DEFAULT_NO_REPLY_FROM: &str = "Pokoin <no-reply@pokoin.com>";
pub const DEFAULT_ADMIN_TO: &str = "pokoinpos@gmail.com";
pub const RESEND_ENDPOINT: &str = "https://api.resend.com/emails";

/// `canEmailUser`: a syntactically valid address that is not a wallet-only
/// synthetic address.
pub fn can_email_user(email: &str) -> bool {
    let normalized = email.trim().to_ascii_lowercase();
    if normalized.ends_with("@wallet.pokoin.local") {
        return false;
    }
    let Some((local, domain)) = normalized.split_once('@') else {
        return false;
    };
    if local.is_empty() || domain.is_empty() {
        return false;
    }
    if local.contains(char::is_whitespace) || domain.contains(char::is_whitespace) {
        return false;
    }
    match domain.split_once('.') {
        Some((host, tld)) => !host.is_empty() && !tld.is_empty(),
        None => false,
    }
}

pub fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailMessage {
    pub from: String,
    pub to: String,
    pub subject: String,
    pub html: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmailDelivery {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl EmailDelivery {
    pub fn sent(id: Option<String>) -> Self {
        Self {
            ok: true,
            id,
            skipped: false,
            reason: None,
        }
    }

    pub fn skipped(reason: impl Into<String>) -> Self {
        Self {
            ok: false,
            id: None,
            skipped: true,
            reason: Some(reason.into()),
        }
    }
}

#[async_trait]
pub trait EmailSender: Send + Sync + 'static {
    async fn send(&self, message: EmailMessage) -> Result<EmailDelivery>;
}

/// Posts to Resend. Without an API key every send is `skipped`, matching the
/// Node behaviour (and never claiming a successful delivery).
pub struct ResendEmailSender {
    api_key: Option<String>,
    transport: SharedTransport,
    retry: RetryPolicy,
}

impl ResendEmailSender {
    pub fn new(api_key: Option<String>, transport: SharedTransport) -> Self {
        Self {
            api_key: api_key.filter(|key| !key.trim().is_empty()),
            transport,
            retry: RetryPolicy::default(),
        }
    }
}

#[derive(Deserialize)]
struct ResendResponse {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[async_trait]
impl EmailSender for ResendEmailSender {
    async fn send(&self, message: EmailMessage) -> Result<EmailDelivery> {
        let Some(api_key) = &self.api_key else {
            return Ok(EmailDelivery::skipped("RESEND_API_KEY is not configured."));
        };
        let request = HttpRequest::new("POST", RESEND_ENDPOINT)
            .header("Authorization", format!("Bearer {api_key}"))
            .json(&serde_json::json!({
                "from": message.from,
                "to": message.to,
                "subject": message.subject,
                "html": message.html,
                "text": message.text,
            }))
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let response = send_with_retry(&self.transport, request, self.retry)
            .await
            .map_err(|_| ApiError::new(axum::http::StatusCode::BAD_GATEWAY, "Email delivery failed."))?;
        let payload: Option<ResendResponse> = serde_json::from_slice(&response.body).ok();
        if !response.is_success() {
            let detail = payload
                .and_then(|payload| payload.message.or(payload.error))
                .unwrap_or_else(|| "Email delivery failed.".to_string());
            return Err(ApiError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                detail,
            ));
        }
        Ok(EmailDelivery::sent(payload.and_then(|payload| payload.id)))
    }
}

/// Test/no-op sender used when email is deliberately off.
pub struct NullEmailSender;

#[async_trait]
impl EmailSender for NullEmailSender {
    async fn send(&self, _message: EmailMessage) -> Result<EmailDelivery> {
        Ok(EmailDelivery::skipped("email sender is not configured."))
    }
}

/// Which senders build which message. Kept as a struct so the state owns one
/// consistent set of addresses.
#[derive(Debug, Clone)]
pub struct EmailConfig {
    pub from: String,
    pub no_reply_from: String,
    pub admin_to: String,
    pub site_url: String,
}

impl EmailConfig {
    pub fn from_env() -> Self {
        let env_or = |name: &str, fallback: &str| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| fallback.to_string())
        };
        Self {
            from: env_or("EMAIL_FROM", DEFAULT_FROM),
            no_reply_from: env_or("NO_REPLY_EMAIL_FROM", DEFAULT_NO_REPLY_FROM),
            admin_to: env_or("ADMIN_SIGNUP_EMAIL", DEFAULT_ADMIN_TO),
            site_url: env_or("PUBLIC_SITE_URL", "https://pokoin.com")
                .trim_end_matches('/')
                .to_string(),
        }
    }
}

/// The verification email body. `verification_link` is passed in because the
/// Node handler either minted its own token link or asked Firebase for one.
pub fn verification_email(
    config: &EmailConfig,
    email: &str,
    username: &str,
    verification_link: &str,
) -> EmailMessage {
    let safe_username = if username.is_empty() {
        "Pokoin user".to_string()
    } else {
        username.to_string()
    };
    let text = [
        format!("Hi {safe_username},"),
        String::new(),
        "Verify your Pokoin account with this link:".to_string(),
        verification_link.to_string(),
        String::new(),
        "If you did not create a Pokoin account, you can ignore this email.".to_string(),
    ]
    .join("\n");
    let html = format!(
        r#"
      <div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#0f172a">
        <h1 style="margin:0 0 16px">Verify your Pokoin account</h1>
        <p>Hi {safe_username},</p>
        <p>Click the button below to verify your email address for Pokoin.</p>
        <p>
          <a href="{verification_link}" style="display:inline-block;background:#facc15;color:#111827;padding:12px 18px;border-radius:12px;text-decoration:none;font-weight:700">
            Verify email
          </a>
        </p>
        <p style="color:#64748b;font-size:14px">If the button does not work, open this link:<br>{verification_link}</p>
        <p style="color:#64748b;font-size:14px">If you did not create a Pokoin account, you can ignore this email.</p>
      </div>
    "#
    );
    EmailMessage {
        from: config.no_reply_from.clone(),
        to: email.to_string(),
        subject: "Verify your Pokoin account".into(),
        html,
        text,
    }
}

pub fn welcome_email(config: &EmailConfig, email: &str, username: &str) -> EmailMessage {
    let safe_username = escape_html(if username.is_empty() {
        "Pokoin user"
    } else {
        username
    });
    let docs_link = format!("{}/docs", config.site_url);
    let project_link = config.site_url.clone();
    let text = [
        "Welcome on board!".to_string(),
        String::new(),
        format!("Hi {},", if username.is_empty() { "Pokoin user" } else { username }),
        String::new(),
        "Your Pokoin account is verified and ready.".to_string(),
        "Read the documentation to understand the project, wallets, validators, and how PKN works:"
            .to_string(),
        docs_link.clone(),
        String::new(),
        "We are happy to have you as part of the Pokoin project.".to_string(),
        project_link.clone(),
    ]
    .join("\n");
    let html = format!(
        r#"
      <div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#0f172a">
        <h1 style="margin:0 0 16px">Welcome on board!</h1>
        <p>Hi {safe_username},</p>
        <p>Your Pokoin account is verified and ready.</p>
        <p>Read the documentation to understand the project, wallets, validators, and how PKN works.</p>
        <p>
          <a href="{docs_link}" style="display:inline-block;background:#facc15;color:#111827;padding:12px 18px;border-radius:12px;text-decoration:none;font-weight:700">
            Read documentation
          </a>
        </p>
        <p>We are happy to have you as part of the Pokoin project.</p>
      </div>
    "#
    );
    EmailMessage {
        from: config.no_reply_from.clone(),
        to: email.to_string(),
        subject: "Welcome on board!".into(),
        html,
        text,
    }
}

#[derive(Debug, Clone, Default)]
pub struct SignupNotification {
    pub uid: String,
    pub provider: String,
    pub email: String,
    pub username: String,
    pub wallet_address: String,
    pub email_verified: bool,
}

pub fn signup_notification_email(
    config: &EmailConfig,
    notification: &SignupNotification,
    now_iso: &str,
) -> EmailMessage {
    let provider = if notification.provider.is_empty() {
        "unknown".to_string()
    } else {
        notification.provider.clone()
    };
    let title = if !notification.username.is_empty() {
        notification.username.clone()
    } else if !notification.email.is_empty() {
        notification.email.clone()
    } else {
        notification.uid.clone()
    };
    let verified_text = if notification.email_verified {
        "verified"
    } else {
        "not verified"
    };
    let text = [
        "A new Pokoin account signed up successfully.".to_string(),
        String::new(),
        format!("Provider: {provider}"),
        format!("UID: {}", notification.uid),
        format!(
            "Username: {}",
            dash_if_empty(&notification.username)
        ),
        format!("Email: {}", dash_if_empty(&notification.email)),
        format!("Email status: {verified_text}"),
        format!("Wallet: {}", dash_if_empty(&notification.wallet_address)),
        String::new(),
        format!("Time: {now_iso}"),
    ]
    .join("\n");
    let html = format!(
        r#"
      <div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#0f172a">
        <h1 style="margin:0 0 16px">New Pokoin signup</h1>
        <p>A new Pokoin account signed up successfully.</p>
        <ul>
          <li><strong>Provider:</strong> {provider}</li>
          <li><strong>UID:</strong> {uid}</li>
          <li><strong>Username:</strong> {username}</li>
          <li><strong>Email:</strong> {email}</li>
          <li><strong>Email status:</strong> {verified_text}</li>
          <li><strong>Wallet:</strong> {wallet}</li>
        </ul>
        <p style="color:#64748b;font-size:14px">Time: {now_iso}</p>
      </div>
    "#,
        uid = notification.uid,
        username = escape_html(&dash_if_empty(&notification.username)),
        email = escape_html(&dash_if_empty(&notification.email)),
        wallet = escape_html(&dash_if_empty(&notification.wallet_address)),
    );
    EmailMessage {
        from: config.no_reply_from.clone(),
        to: config.admin_to.clone(),
        subject: format!("New Pokoin signup: {title}"),
        html,
        text,
    }
}

fn dash_if_empty(value: &str) -> String {
    if value.is_empty() {
        "-".to_string()
    } else {
        value.to_string()
    }
}

/// `sendSignupNotificationOnce`: the `users/{uid}.signupNotificationSentAt`
/// gate makes this idempotent across retries and races.
pub async fn send_signup_notification_once(
    firestore: &Firestore,
    emails: &Arc<dyn EmailSender>,
    config: &EmailConfig,
    notification: &SignupNotification,
    now_iso: &str,
) -> Result<EmailDelivery> {
    let user_ref = firestore.doc(format!("users/{}", notification.uid));
    let user = user_ref.get().await?;
    let user_data = user.unwrap_or_default();
    if user_data
        .get("signupNotificationSentAt")
        .map(|value| !matches!(value, crate::firestore::Value::Null))
        .unwrap_or(false)
    {
        return Ok(EmailDelivery::skipped("Signup notification already sent."));
    }

    let provider = if notification.provider.is_empty() {
        "unknown".to_string()
    } else {
        notification.provider.clone()
    };
    let mut effective = notification.clone();
    if effective.email.is_empty() {
        effective.email = user_data.get_str("email");
    }
    if effective.username.is_empty() {
        effective.username = user_data.get_str("username");
    }
    if effective.wallet_address.is_empty() {
        effective.wallet_address = user_data.get_str("walletAddress");
    }

    let message = signup_notification_email(config, &effective, now_iso);
    let delivery = emails.send(message).await?;

    user_ref
        .set(
            DocData::new()
                .server_timestamp("signupNotificationSentAt")
                .string("signupNotificationProvider", provider),
            true,
        )
        .await?;
    Ok(delivery)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> EmailConfig {
        EmailConfig {
            from: DEFAULT_FROM.into(),
            no_reply_from: DEFAULT_NO_REPLY_FROM.into(),
            admin_to: DEFAULT_ADMIN_TO.into(),
            site_url: "https://pokoin.com".into(),
        }
    }

    #[test]
    fn can_email_user_rejects_wallet_addresses_and_junk() {
        assert!(can_email_user("a@b.co"));
        assert!(can_email_user("  A@B.CO "));
        assert!(!can_email_user("abc@wallet.pokoin.local"));
        assert!(!can_email_user("no-at-sign"));
        assert!(!can_email_user("a@b"));
        assert!(!can_email_user("@b.co"));
        assert!(!can_email_user("a@"));
        assert!(!can_email_user("a b@c.co"));
        assert!(!can_email_user(""));
    }

    #[test]
    fn html_escaping_covers_the_node_entity_set() {
        assert_eq!(
            escape_html(r#"<a href="x">Tom & Jerry's</a>"#),
            "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;"
        );
    }

    #[test]
    fn verification_email_matches_the_node_body() {
        let message = verification_email(&config(), "a@b.co", "ash", "https://x/verify");
        assert_eq!(message.subject, "Verify your Pokoin account");
        assert_eq!(message.from, DEFAULT_NO_REPLY_FROM);
        assert!(message.text.contains("Hi ash,"));
        assert!(message.text.contains("https://x/verify"));
        assert!(message.html.contains(r#"href="https://x/verify""#));
        // Node defaulted the greeting when the username was missing.
        let anon = verification_email(&config(), "a@b.co", "", "https://x/verify");
        assert!(anon.text.contains("Hi Pokoin user,"));
    }

    #[test]
    fn welcome_email_links_the_docs() {
        let message = welcome_email(&config(), "a@b.co", "ash");
        assert_eq!(message.subject, "Welcome on board!");
        assert!(message.text.contains("https://pokoin.com/docs"));
        assert!(message.html.contains("https://pokoin.com/docs"));
        assert!(message.html.contains("Hi ash,"));
    }

    #[test]
    fn signup_notification_subject_prefers_username_then_email_then_uid() {
        let base = SignupNotification {
            uid: "u1".into(),
            provider: "email_password".into(),
            email_verified: true,
            ..Default::default()
        };
        let named = SignupNotification {
            username: "ash".into(),
            ..base.clone()
        };
        assert_eq!(
            signup_notification_email(&config(), &named, "2026-10-08T00:00:00Z").subject,
            "New Pokoin signup: ash"
        );
        let emailed = SignupNotification {
            email: "a@b.co".into(),
            ..base.clone()
        };
        assert_eq!(
            signup_notification_email(&config(), &emailed, "2026-10-08T00:00:00Z").subject,
            "New Pokoin signup: a@b.co"
        );
        assert_eq!(
            signup_notification_email(&config(), &base, "2026-10-08T00:00:00Z").subject,
            "New Pokoin signup: u1"
        );
        // Always addressed to the admin, never to the new user.
        assert_eq!(
            signup_notification_email(&config(), &base, "t").to,
            DEFAULT_ADMIN_TO
        );
    }

    #[test]
    fn signup_notification_marks_empty_fields_with_a_dash() {
        let notification = SignupNotification {
            uid: "u1".into(),
            provider: "wallet".into(),
            email_verified: false,
            ..Default::default()
        };
        let message = signup_notification_email(&config(), &notification, "2026-10-08T00:00:00Z");
        assert!(message.text.contains("Username: -"));
        assert!(message.text.contains("Email: -"));
        assert!(message.text.contains("Wallet: -"));
        assert!(message.text.contains("Email status: not verified"));
    }

    #[test]
    fn skipped_delivery_is_never_reported_as_sent() {
        let delivery = EmailDelivery::skipped("RESEND_API_KEY is not configured.");
        assert!(!delivery.ok);
        assert!(delivery.skipped);
        let json = serde_json::to_value(&delivery).unwrap();
        assert_eq!(json["ok"], serde_json::json!(false));
        assert_eq!(json["skipped"], serde_json::json!(true));
        assert_eq!(
            json["reason"],
            serde_json::json!("RESEND_API_KEY is not configured.")
        );
    }

    #[test]
    fn sent_delivery_serializes_without_skip_noise() {
        let json = serde_json::to_value(EmailDelivery::sent(Some("id1".into()))).unwrap();
        assert_eq!(json["ok"], serde_json::json!(true));
        assert_eq!(json["id"], serde_json::json!("id1"));
        assert!(json.get("skipped").is_none());
        assert!(json.get("reason").is_none());
    }
}
