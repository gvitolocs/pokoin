//! The wallet request id: the client's own name for one money intent.
//!
//! A wallet request that never reached the browser — the user never saw the
//! answer — is sent again with the id it was sent with the first time, and the
//! store applies that id once. The rule lives here, apart from the handlers, so
//! both values of the requirement are exercised without touching the network.

use serde_json::Value;

/// The body field that carries the id.
pub const FIELD: &str = "requestId";

/// A body's `requestId`, classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestId {
    /// A well-formed id: this request is applied once.
    Id(String),
    /// No id in the body, which is accepted while every client learns to send
    /// one; the request is applied as it was before request ids existed.
    Absent,
}

/// A body whose id cannot be honoured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    /// No id where the rule requires one.
    Required,
    /// An id that is not the canonical UUID text of one intent.
    Invalid,
}

impl Reject {
    pub fn code(self) -> &'static str {
        match self {
            Self::Required => "request_id_required",
            Self::Invalid => "request_id_invalid",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::Required => "This request was sent without a request id.",
            Self::Invalid => "This request id is not valid.",
        }
    }
}

/// One intent's id: the canonical 36-character UUID text.
pub fn is_request_id(text: &str) -> bool {
    text.len() == 36 && uuid::Uuid::parse_str(text).is_ok()
}

/// What one request id stands for: the same id carrying a different request is
/// a different intent, so it is refused rather than applied.
pub fn fingerprint(target: &str, amount_pkn: i64) -> String {
    format!("{target}:{amount_pkn}")
}

/// Whether the request sent under a key is the request the key was committed
/// with. A key recorded before fingerprints existed answers for anything.
pub fn same_request(stored: Option<&str>, current: &str) -> bool {
    match stored {
        Some(stored) => stored == current,
        None => true,
    }
}

/// Read the body's id. `require` is the wallet handlers' `REQUIRE_REQUEST_ID`:
/// while it is false an absent id is accepted, while a present id must be valid
/// either way.
pub fn resolve(body: &Value, require: bool) -> Result<RequestId, Reject> {
    let text = match body.get(FIELD) {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.trim().to_ascii_lowercase()),
        Some(_) => return Err(Reject::Invalid),
    };
    let Some(text) = text else {
        return if require {
            Err(Reject::Required)
        } else {
            Ok(RequestId::Absent)
        };
    };
    if !is_request_id(&text) {
        return Err(Reject::Invalid);
    }
    Ok(RequestId::Id(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ONE: &str = "6b1f2a34-0000-4c9d-8f1e-0a1b2c3d4e5f";

    #[test]
    fn a_wallet_request_id_is_applied_once_and_an_absent_one_is_still_accepted() {
        // The id the client generated for this intent is the key's id.
        assert_eq!(
            resolve(&json!({ "requestId": ONE }), false),
            Ok(RequestId::Id(ONE.into()))
        );
        // A client that has not learned request ids yet is served as before.
        for body in [json!({}), json!({ "requestId": null })] {
            assert_eq!(resolve(&body, false), Ok(RequestId::Absent), "{body}");
        }
        // Once every client sends one, the same bodies are refused.
        for body in [json!({}), json!({ "requestId": null })] {
            assert_eq!(resolve(&body, true), Err(Reject::Required), "{body}");
        }
        assert_eq!(
            resolve(&json!({ "requestId": ONE }), true),
            Ok(RequestId::Id(ONE.into()))
        );
    }

    #[test]
    fn a_malformed_wallet_request_id_is_refused_whatever_the_rule() {
        for value in [
            json!(""),
            json!("   "),
            json!("not-a-uuid"),
            json!("6b1f2a34-0000-4c9d-8f1e-0a1b2c3d4e5"), // one character short
            json!("6b1f2a34-0000-4c9d-8f1e-0a1b2c3d4e5ff"), // one character long
            json!("6b1f2a3400004c9d8f1e0a1b2c3d4e5f"),    // the same UUID without its hyphens
            json!("6b1f2a34-0000-4c9d-8f1e-0a1b2c3d4e5g"), // not hexadecimal
            json!("{6b1f2a34-0000-4c9d-8f1e-0a1b2c3d4e5f}"),
            json!(42),
            json!({ "id": ONE }),
        ] {
            for require in [false, true] {
                assert_eq!(
                    resolve(&json!({ "requestId": value }), require),
                    Err(Reject::Invalid),
                    "{value} with require={require}"
                );
            }
        }
        // The codes the API answers with.
        assert_eq!(Reject::Invalid.code(), "request_id_invalid");
        assert_eq!(Reject::Required.code(), "request_id_required");
    }

    #[test]
    fn one_intent_sends_the_same_id_whatever_its_case() {
        assert!(is_request_id(ONE));
        assert!(is_request_id(&ONE.to_ascii_uppercase()));
        // Keys and document ids are written in one case, so an id typed by hand
        // still reads as the intent it names.
        assert_eq!(
            resolve(&json!({ "requestId": ONE.to_ascii_uppercase() }), false),
            Ok(RequestId::Id(ONE.into()))
        );
    }

    #[test]
    fn a_fingerprint_tells_one_request_from_another() {
        let sent = fingerprint("recipient-1", 250);
        assert!(same_request(Some(&sent), &fingerprint("recipient-1", 250)));
        // A different recipient or a different amount is a different request,
        // so it never rides on the first request's id.
        assert!(!same_request(Some(&sent), &fingerprint("recipient-2", 250)));
        assert!(!same_request(Some(&sent), &fingerprint("recipient-1", 251)));
        // A key committed without a fingerprint answers for the request it holds.
        assert!(same_request(None, &fingerprint("recipient-2", 999)));
    }
}
