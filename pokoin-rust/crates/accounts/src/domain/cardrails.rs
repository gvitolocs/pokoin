//! Card Rails sign-in ("Sign in with Pokoin") domain logic.
//!
//! Card Rails (`com.pokoin.cardrails`) signs its users in through this
//! account: the app opens `https://pokoin.com/connect/cardrails` in the
//! system browser, the signed-in user taps consent, and `/api/cardrails-authorize`
//! mints a one-time code that redirects to `cardrails://auth/pokoin?code=…`.
//! The Card Rails API then exchanges code + PKCE verifier on
//! `/api/cardrails-token` for the Pokoin identity. OAuth authorization-code
//! with PKCE S256; the code is a bearer secret, so it is stored only as its
//! SHA-256 hash with a 120 second lifetime.

use base64::Engine;
use serde_json::Value as Json;
use sha2::{Digest, Sha256};

/// `^[A-Za-z0-9_-]{43}$` — base64url of 32 SHA-256 bytes, no padding.
pub const CODE_CHALLENGE_LEN: usize = 43;
/// `^[A-Za-z0-9_-]{16,128}$`.
pub const STATE_MIN_LEN: usize = 16;
pub const STATE_MAX_LEN: usize = 128;
/// How long a minted code may sit between the consent tap and the token call.
pub const CODE_TTL_SECONDS: i64 = 120;
/// Consent taps per uid per minute.
pub const AUTHORIZE_RATE_LIMIT: i64 = 10;
pub const AUTHORIZE_RATE_WINDOW_SECONDS: u64 = 60;

/// The app scheme the browser hands the code back to.
pub const REDIRECT_SCHEME: &str = "cardrails://auth/pokoin";

/// base64url without padding, the Firebase/`pending_signup` alphabet.
pub fn b64url() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

/// Every character of `value` must be in the base64url alphabet.
fn is_base64url(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// `^[A-Za-z0-9_-]{43}$`: exactly [`CODE_CHALLENGE_LEN`] base64url characters.
pub fn is_valid_code_challenge(value: &str) -> bool {
    value.len() == CODE_CHALLENGE_LEN && is_base64url(value)
}

/// `^[A-Za-z0-9_-]{16,128}$`.
pub fn is_valid_state(value: &str) -> bool {
    (STATE_MIN_LEN..=STATE_MAX_LEN).contains(&value.len()) && is_base64url(value)
}

/// Only `S256` is spoken; `plain` is never accepted.
pub fn is_valid_code_challenge_method(value: &str) -> bool {
    value == "S256"
}

/// `base64url_nopad(sha256(code_verifier))` — the PKCE S256 challenge.
pub fn pkce_challenge(code_verifier: &str) -> String {
    b64url().encode(Sha256::digest(code_verifier.as_bytes()))
}

/// The one-time code: 32 random bytes, base64url without padding (43 chars).
pub fn new_code() -> String {
    let bytes: [u8; 32] = rand::random();
    b64url().encode(bytes)
}

/// `sha256(code)`, hex — the only form of a code that is ever stored.
pub fn code_hash(code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(code.as_bytes());
    hex::encode(hasher.finalize())
}

/// Percent-encode exactly like `firebase::urlencode` (unreserved characters
/// stay literal), so `code`/`state` are safe inside the deep-link query.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// `cardrails://auth/pokoin?code=<code>&state=<state>`.
pub fn redirect_url(code: &str, state: &str) -> String {
    format!(
        "{}?code={}&state={}",
        REDIRECT_SCHEME,
        urlencode(code),
        urlencode(state)
    )
}

/// `cardrails://auth/pokoin?error=access_denied&state=<state>`.
pub fn cancel_url(state: &str) -> String {
    format!("{}?error=access_denied&state={}", REDIRECT_SCHEME, urlencode(state))
}

// ---------------------------------------------------------------------------
// Code storage
// ---------------------------------------------------------------------------

/// A minted authorization code, ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCardRailsCode {
    pub code_hash: String,
    pub uid: String,
    pub email: String,
    pub email_verified: bool,
    pub code_challenge: String,
    /// Absolute wall-clock deadline (now + [`CODE_TTL_SECONDS`] in production).
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

/// A consumed record. `live` is false when the record was already past its
/// `expires_at` when consumed: the caller answers `invalid_grant` either way,
/// but the distinction keeps the single-use semantics explicit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumedCardRailsCode {
    pub uid: String,
    pub email: String,
    pub email_verified: bool,
    pub code_challenge: String,
    pub live: bool,
}

/// The store shared by every API instance. Codes are single-use: `consume`
/// removes the record atomically, so a second caller always loses — even when
/// the first caller failed its PKCE check. Postgres in production
/// (`cardrails_auth_codes`, writer database), in-memory under test.
#[async_trait::async_trait]
pub trait CardRailsCodeStore: Send + Sync + 'static {
    async fn insert(&self, code: NewCardRailsCode) -> crate::error::Result<()>;
    async fn consume(&self, code_hash: &str)
        -> crate::error::Result<Option<ConsumedCardRailsCode>>;
}

/// Postgres backing store. The consume statement is the whole contract: one
/// `DELETE … RETURNING` is atomic under concurrency and takes the expired row
/// with it, so single-use and expiry never race.
pub struct PostgresCardRailsCodeStore {
    db: crate::sql::MarketplaceDb,
}

impl PostgresCardRailsCodeStore {
    pub fn new(db: crate::sql::MarketplaceDb) -> Self {
        Self { db }
    }
}

#[async_trait::async_trait]
impl CardRailsCodeStore for PostgresCardRailsCodeStore {
    async fn insert(&self, code: NewCardRailsCode) -> crate::error::Result<()> {
        // Cheap hygiene: rows whose token step never came are swept once they
        // are an hour stale, so the table stays small without a timer job.
        self.db
            .query_json(
                "delete from cardrails_auth_codes where expires_at < now() - interval '1 hour'",
                &[],
            )
            .await?;
        self.db
            .query_json(
                "insert into cardrails_auth_codes \
                 (code_hash, firebase_uid, email, email_verified, code_challenge, created_at, expires_at) \
                 values ($1, $2, $3, $4, $5, now(), $6::timestamptz) \
                 on conflict (code_hash) do nothing",
                &[
                    crate::sql::SqlParam::Text(code.code_hash),
                    crate::sql::SqlParam::Text(code.uid),
                    crate::sql::SqlParam::Text(code.email),
                    crate::sql::SqlParam::Bool(code.email_verified),
                    crate::sql::SqlParam::Text(code.code_challenge),
                    crate::sql::SqlParam::Text(
                        code.expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    ),
                ],
            )
            .await?;
        Ok(())
    }

    async fn consume(
        &self,
        code_hash: &str,
    ) -> crate::error::Result<Option<ConsumedCardRailsCode>> {
        let rows = self
            .db
            .query_json(
                "delete from cardrails_auth_codes where code_hash = $1 \
                 returning firebase_uid, email, email_verified, code_challenge, \
                 (expires_at > now()) as live",
                &[crate::sql::SqlParam::Text(code_hash.to_string())],
            )
            .await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        Ok(Some(ConsumedCardRailsCode {
            uid: crate::sql::row_text(row, "firebase_uid"),
            email: crate::sql::row_text(row, "email"),
            email_verified: row.get("email_verified").and_then(Json::as_bool).unwrap_or(false),
            code_challenge: crate::sql::row_text(row, "code_challenge"),
            live: row.get("live").and_then(Json::as_bool).unwrap_or(false),
        }))
    }
}

/// In-process store for tests: same single-use/expiry contract, no database.
#[derive(Default)]
pub struct MemoryCardRailsCodeStore {
    codes: std::sync::Mutex<std::collections::HashMap<String, NewCardRailsCode>>,
}

impl MemoryCardRailsCodeStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.codes.lock().expect("code map").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[async_trait::async_trait]
impl CardRailsCodeStore for MemoryCardRailsCodeStore {
    async fn insert(&self, code: NewCardRailsCode) -> crate::error::Result<()> {
        self.codes
            .lock()
            .expect("code map")
            .insert(code.code_hash.clone(), code);
        Ok(())
    }

    async fn consume(
        &self,
        code_hash: &str,
    ) -> crate::error::Result<Option<ConsumedCardRailsCode>> {
        let Some(code) = self.codes.lock().expect("code map").remove(code_hash) else {
            return Ok(None);
        };
        Ok(Some(ConsumedCardRailsCode {
            uid: code.uid,
            email: code.email,
            email_verified: code.email_verified,
            code_challenge: code.code_challenge,
            live: chrono::Utc::now() < code.expires_at,
        }))
    }
}

#[cfg(test)]
mod store_tests {
    use super::*;

    fn record(expires_in_seconds: i64) -> NewCardRailsCode {
        NewCardRailsCode {
            code_hash: code_hash(&new_code()),
            uid: "user-1".into(),
            email: "ash@pokoin.com".into(),
            email_verified: true,
            code_challenge: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into(),
            expires_at: chrono::Utc::now() + chrono::Duration::seconds(expires_in_seconds),
        }
    }

    #[tokio::test]
    async fn a_code_is_consumed_exactly_once() {
        let store = MemoryCardRailsCodeStore::new();
        let record = record(120);
        let hash = record.code_hash.clone();
        store.insert(record).await.unwrap();
        assert_eq!(store.len(), 1);

        let first = store.consume(&hash).await.unwrap().expect("first consume wins");
        assert!(first.live);
        assert_eq!(first.uid, "user-1");
        assert_eq!(first.email, "ash@pokoin.com");
        assert!(first.email_verified);
        assert_eq!(store.len(), 0);
        // The loser of the race — or any retry — finds nothing.
        assert!(store.consume(&hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn an_expired_code_is_consumed_but_not_live() {
        let store = MemoryCardRailsCodeStore::new();
        let record = record(-1);
        let hash = record.code_hash.clone();
        store.insert(record).await.unwrap();
        let consumed = store.consume(&hash).await.unwrap().expect("the row existed");
        assert!(!consumed.live, "expired rows never grant an identity");
        assert!(store.consume(&hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn an_unknown_hash_consumes_nothing() {
        let store = MemoryCardRailsCodeStore::new();
        assert!(store.consume("deadbeef").await.unwrap().is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_challenge_validation_matches_the_contract_regex() {
        assert!(is_valid_code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
        assert!(!is_valid_code_challenge("short"));
        assert!(!is_valid_code_challenge(
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXkx"
        ));
        // `+` and `/` are base64, not base64url; `=` padding is rejected too.
        assert!(!is_valid_code_challenge(
            "dBjftJeZ4CVP+mB92K27uhbUJU1p1r/wW1gFWFOEjXk"
        ));
        assert!(!is_valid_code_challenge(
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjX="
        ));
        assert!(!is_valid_code_challenge(""));
    }

    #[test]
    fn state_validation_matches_the_contract_regex() {
        assert!(is_valid_state("0123456789abcdef"));
        assert!(is_valid_state(&"a".repeat(128)));
        assert!(!is_valid_state("0123456789abcde"));
        assert!(!is_valid_state(&"a".repeat(129)));
        assert!(!is_valid_state("has space inside the middle"));
        assert!(!is_valid_state("semicolon;here12345"));
    }

    #[test]
    fn only_s256_is_accepted() {
        assert!(is_valid_code_challenge_method("S256"));
        assert!(!is_valid_code_challenge_method("plain"));
        assert!(!is_valid_code_challenge_method("s256"));
        assert!(!is_valid_code_challenge_method(""));
    }

    #[test]
    fn pkce_challenge_is_the_sha256_of_the_verifier() {
        // RFC 7636 appendix B.
        let challenge = pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        // No padding, and the same verifier hashes to the same challenge.
        assert!(!challenge.contains('='));
        assert_eq!(pkce_challenge("x"), pkce_challenge("x"));
        assert_ne!(pkce_challenge("x"), pkce_challenge("y"));
    }

    #[test]
    fn minted_codes_are_43_base64url_characters() {
        let code = new_code();
        assert_eq!(code.len(), 43);
        assert!(is_valid_code_challenge(&code), "{code}");
        assert_ne!(code, new_code(), "codes are random");
    }

    #[test]
    fn code_hash_is_sha256_hex_of_the_raw_code() {
        let code = new_code();
        let hash = code_hash(&code);
        assert_eq!(hash.len(), 64);
        assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(code_hash(&code), code_hash(&code));
        assert_ne!(code_hash(&code), code_hash("other"));
    }

    #[test]
    fn redirect_and_cancel_urls_carry_the_query() {
        let code = new_code();
        let state = "0123456789abcdef";
        assert_eq!(
            redirect_url(&code, state),
            format!("{REDIRECT_SCHEME}?code={code}&state={state}")
        );
        assert_eq!(
            cancel_url(state),
            format!("{REDIRECT_SCHEME}?error=access_denied&state={state}")
        );
    }
}
