//! Refuses credential fields, foreign origins, and bot challenges.
//!
//! `type_into` and `navigate` call these checks themselves. A portal method
//! cannot skip them by writing the field another way.

use crate::portal::PortalError;

#[derive(Debug, Clone, Default)]
pub struct FieldAttrs {
    pub type_name: String,
    pub autocomplete: String,
    pub name: String,
    pub id: String,
    pub aria_label: String,
}

/// Password, email, username, and one-time-code fields are never typed.
pub fn refuses_typing(field: &FieldAttrs) -> bool {
    let type_name = field.type_name.to_ascii_lowercase();
    if type_name == "password" || type_name == "email" {
        return true;
    }
    let autocomplete = field.autocomplete.to_ascii_lowercase();
    if ["password", "username", "email", "one-time-code"].iter().any(|word| autocomplete.contains(word)) {
        return true;
    }
    let label = format!("{} {} {}", field.name, field.id, field.aria_label);
    credential_word(&label)
}

fn credential_word(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    ["pass", "user", "login", "email", "otp", "2fa", "mfa", "code", "secret"]
        .iter()
        .any(|word| value.contains(word))
}

pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{}", host.to_ascii_lowercase()))
}

pub fn navigation_allowed(url: &str, allowed: &[String]) -> bool {
    let Some(origin) = origin_of(url) else {
        return false;
    };
    allowed.iter().any(|entry| origin_of(entry).as_deref() == Some(origin.as_str()) || entry.eq_ignore_ascii_case(&origin))
}

/// An iframe challenge, a configured captcha selector, or a challenge title.
pub fn challenge_reason(title: &str, frame_srcs: &[String], captcha_selector: bool) -> Option<String> {
    for src in frame_srcs {
        let lower = src.to_ascii_lowercase();
        for needle in ["recaptcha", "hcaptcha", "turnstile", "captcha", "challenges.cloudflare"] {
            if lower.contains(needle) {
                return Some(format!("captcha frame: {needle}"));
            }
        }
    }
    if captcha_selector {
        return Some("captcha selector".to_string());
    }
    let title = title.to_ascii_lowercase();
    for phrase in ["just a moment", "attention required", "access denied"] {
        if title.contains(phrase) {
            return Some(phrase.to_string());
        }
    }
    None
}

pub fn credential_error() -> PortalError {
    PortalError::Permanent("refusing to type into a credentials field".to_string())
}

pub fn origin_error() -> PortalError {
    PortalError::Permanent("refusing to navigate outside the allowed origins".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(type_name: &str, autocomplete: &str, name: &str, id: &str, aria: &str) -> FieldAttrs {
        FieldAttrs {
            type_name: type_name.to_string(),
            autocomplete: autocomplete.to_string(),
            name: name.to_string(),
            id: id.to_string(),
            aria_label: aria.to_string(),
        }
    }

    #[test]
    fn price_and_quantity_are_not_credential_fields() {
        assert!(!refuses_typing(&field("text", "off", "quantity", "qty", "Quantity")));
        assert!(!refuses_typing(&field("text", "", "price", "price", "Price")));
        assert!(!refuses_typing(&field("", "", "quantity", "", "")));
    }

    #[test]
    fn credential_fields_are_refused() {
        assert!(refuses_typing(&field("password", "", "", "", "")));
        assert!(refuses_typing(&field("email", "", "", "", "")));
        assert!(refuses_typing(&field("text", "current-password", "", "", "")));
        assert!(refuses_typing(&field("text", "username", "", "", "")));
        assert!(refuses_typing(&field("text", "one-time-code", "", "", "")));
        assert!(refuses_typing(&field("text", "", "username", "", "")));
        assert!(refuses_typing(&field("text", "", "", "otp", "")));
        assert!(refuses_typing(&field("text", "", "", "", "2FA code")));
    }

    #[test]
    fn only_listed_origins_can_be_opened() {
        let allowed = vec!["http://127.0.0.1:9".to_string()];
        assert!(navigation_allowed("http://127.0.0.1:9/sku/1", &allowed));
        assert!(!navigation_allowed("http://example.com/", &allowed));
        assert!(!navigation_allowed("javascript:alert(1)", &allowed));
    }

    #[test]
    fn challenge_pages_are_named() {
        let reason = challenge_reason("Home", &["https://example.test/recaptcha/api.js".to_string()], false).unwrap();
        assert!(reason.contains("recaptcha"));
        assert_eq!(challenge_reason("Just a moment...", &[], false).as_deref(), Some("just a moment"));
        assert_eq!(challenge_reason("Attention Required! | Cloudflare", &[], false).as_deref(), Some("attention required"));
        assert!(challenge_reason("Seller", &[], true).is_some());
        assert!(challenge_reason("Seller home", &[], false).is_none());
    }
}
