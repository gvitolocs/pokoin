//! PKN money-request state machine, ported from `_money_request_core.js`.
//!
//! Financial invariants live here, never in the client: only `to_uid` may pay
//! or decline, only `from_uid` may cancel, and a pending request past its TTL
//! reads as `expired`.

use regex::Regex;
use serde_json::Value;

use crate::domain::squash_text;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_PAID: &str = "paid";
pub const STATUS_DECLINED: &str = "declined";
pub const STATUS_CANCELLED: &str = "cancelled";
pub const STATUS_EXPIRED: &str = "expired";
/// 14 days.
pub const TTL_MS: i64 = 14 * 24 * 60 * 60 * 1000;
pub const MAX_AMOUNT_PKN: i64 = 1_000_000_000;

pub fn username_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9]{3,32}$").expect("valid regex"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateRequest {
    pub to_username: String,
    pub amount_pkn: i64,
    pub note: String,
    pub client_token: String,
}

pub fn validate_amount_pkn(value: Option<f64>) -> Result<i64, String> {
    let Some(amount) = value else {
        return Err("Enter a whole PKN amount greater than zero.".into());
    };
    if !amount.is_finite() || amount.fract() != 0.0 || amount <= 0.0 {
        return Err("Enter a whole PKN amount greater than zero.".into());
    }
    let amount = amount as i64;
    if amount > MAX_AMOUNT_PKN {
        return Err("That amount is too large.".into());
    }
    Ok(amount)
}

pub fn validate_create(input: &Value) -> Result<CreateRequest, String> {
    let to_username = input
        .get("recipientUsername")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !username_re().is_match(&to_username) {
        return Err("Enter a valid recipient username.".into());
    }
    let amount = validate_amount_pkn(crate::domain::js_number(input.get("amountPkn")))?;
    let note = squash_text(
        input.get("note").and_then(Value::as_str).unwrap_or_default(),
        140,
    );
    let client_token = input
        .get("clientToken")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(80)
        .collect();
    Ok(CreateRequest {
        to_username,
        amount_pkn: amount,
        note,
        client_token,
    })
}

/// `requestDocId`: `req_{fromUid}_{clientToken}` with non-word chars stripped.
pub fn request_doc_id(from_uid: &str, client_token: &str) -> String {
    static STRIP: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let strip = STRIP.get_or_init(|| Regex::new(r"[^a-zA-Z0-9_]").expect("valid regex"));
    strip
        .replace_all(&format!("req_{from_uid}_{client_token}"), "")
        .to_string()
}

/// `effectiveStatus`: pending past the TTL reads as expired.
pub fn effective_status(status: &str, created_at_ms: i64, now_ms: i64) -> String {
    if status == STATUS_PENDING && now_ms - created_at_ms > TTL_MS {
        return STATUS_EXPIRED.to_string();
    }
    status.to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guard {
    pub ok: bool,
    pub error: String,
}

fn ok() -> Guard {
    Guard {
        ok: true,
        error: String::new(),
    }
}

fn deny(message: impl Into<String>) -> Guard {
    Guard {
        ok: false,
        error: message.into(),
    }
}

/// `canPay`.
pub fn can_pay(
    status: &str,
    from_uid: &str,
    to_uid: &str,
    created_at_ms: i64,
    uid: &str,
    now_ms: i64,
) -> Guard {
    let status = effective_status(status, created_at_ms, now_ms);
    if status != STATUS_PENDING {
        return deny(format!("This request is {status}."));
    }
    if to_uid != uid {
        return deny("Only the request recipient can pay it.");
    }
    if from_uid == uid {
        return deny("You cannot pay your own request.");
    }
    ok()
}

/// `canRespond` for `decline` / `cancel`.
pub fn can_respond(
    status: &str,
    from_uid: &str,
    to_uid: &str,
    created_at_ms: i64,
    uid: &str,
    action: &str,
    now_ms: i64,
) -> Guard {
    if effective_status(status, created_at_ms, now_ms) != STATUS_PENDING {
        return deny("Only pending requests can be updated.");
    }
    if action == "decline" && to_uid == uid {
        return ok();
    }
    if action == "cancel" && from_uid == uid {
        return ok();
    }
    deny(if action == "decline" {
        "Only the request recipient can decline it."
    } else {
        "Only the requester can cancel it."
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn create_validation_normalizes_input() {
        let request = validate_create(&json!({
            "recipientUsername": "  RedShakkio ",
            "amountPkn": 250,
            "note": "  thanks   mate ",
            "clientToken": "abc/def",
        }))
        .unwrap();
        assert_eq!(request.to_username, "redshakkio");
        assert_eq!(request.amount_pkn, 250);
        assert_eq!(request.note, "thanks mate");
        assert_eq!(request.client_token, "abc/def");
    }

    #[test]
    fn create_validation_rejects_bad_usernames_and_amounts() {
        assert!(validate_create(&json!({ "recipientUsername": "ab", "amountPkn": 1 })).is_err());
        assert!(validate_create(&json!({ "recipientUsername": "abc", "amountPkn": 0 })).is_err());
        assert!(validate_create(&json!({ "recipientUsername": "abc", "amountPkn": 1.5 })).is_err());
        assert!(validate_create(&json!({
            "recipientUsername": "abc",
            "amountPkn": MAX_AMOUNT_PKN + 1
        }))
        .is_err());
    }

    #[test]
    fn request_doc_id_is_deterministic_and_sanitized() {
        assert_eq!(request_doc_id("uid1", "tok-1"), "req_uid1_tok1");
        assert_eq!(request_doc_id("u", ""), "req_u_");
    }

    #[test]
    fn pending_requests_expire_after_fourteen_days() {
        let created = 1_000_000_000_000;
        assert_eq!(effective_status(STATUS_PENDING, created, created + TTL_MS), "pending");
        assert_eq!(
            effective_status(STATUS_PENDING, created, created + TTL_MS + 1),
            "expired"
        );
        // Terminal states never re-expire.
        assert_eq!(effective_status(STATUS_PAID, created, created + TTL_MS + 1), "paid");
    }

    #[test]
    fn only_the_recipient_can_pay() {
        let guard = can_pay(STATUS_PENDING, "from", "to", 0, "to", 0);
        assert!(guard.ok);
        let guard = can_pay(STATUS_PENDING, "from", "to", 0, "other", 0);
        assert!(!guard.ok);
        assert!(guard.error.contains("recipient"));
        // The recipient check fires before the self-pay check, exactly like Node.
        let guard = can_pay(STATUS_PENDING, "from", "to", 0, "from", 0);
        assert!(!guard.ok);
        assert!(guard.error.contains("recipient"));
        let guard = can_pay(STATUS_PENDING, "sameto", "sameto", 0, "sameto", 0);
        assert!(!guard.ok);
        assert!(guard.error.contains("cannot pay your own"));
        let guard = can_pay(STATUS_PAID, "from", "to", 0, "to", 0);
        assert!(!guard.ok);
        assert!(guard.error.contains("paid"));
    }

    #[test]
    fn only_the_recipient_declines_and_only_the_requester_cancels() {
        assert!(can_respond(STATUS_PENDING, "from", "to", 0, "to", "decline", 0).ok);
        assert!(!can_respond(STATUS_PENDING, "from", "to", 0, "from", "decline", 0).ok);
        assert!(can_respond(STATUS_PENDING, "from", "to", 0, "from", "cancel", 0).ok);
        assert!(!can_respond(STATUS_PENDING, "from", "to", 0, "to", "cancel", 0).ok);
        assert!(!can_respond(STATUS_CANCELLED, "from", "to", 0, "from", "cancel", 0).ok);
    }
}
