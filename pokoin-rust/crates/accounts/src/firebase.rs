//! Firebase auth infrastructure, native.
//!
//! Three capabilities live here, all shared by the rest of the crate (and
//! public for the commerce worker):
//!
//! 1. **ID token verification.** RS256 signature checked against Google's
//!    published JWKS (cached, with a forced refetch on an unknown `kid`), plus
//!    `exp` / `iat` / `aud` / `iss` / `sub` validation and the Node
//!    `assertActivePasswordAccount` gate (`email_verified` or the
//!    `pok_email_verified` custom claim for `sign_in_provider === "password"`).
//! 2. **Service-account OAuth 2.0.** A signed RS256 assertion is exchanged at
//!    the token endpoint for an access token, cached until shortly before it
//!    expires so Firestore/Identity calls do not re-mint one per request.
//! 3. **Custom token minting.** The `createCustomToken(uid, claims)` used by
//!    the wallet flows, signed with the same service-account key.
//!
//! No Node process, no Admin SDK, no JS engine.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::config::AccountsConfig;
use crate::error::ApiError;
use crate::http::{send_with_retry, HttpRequest, HttpResponse, RetryPolicy, SharedTransport};

/// Identity Toolkit audience used by Firebase custom tokens.
pub const CUSTOM_TOKEN_AUDIENCE: &str =
    "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";

/// Scopes the accounts domain needs: Firestore reads/writes, Identity Toolkit
/// user administration, and Firebase itself.
pub const DEFAULT_SCOPES: &str =
    "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase";

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("Missing Pokoin bearer token.")]
    Missing,
    #[error("Invalid sign-in token: {0}")]
    Invalid(String),
    #[error("Sign-in verification is not configured: {0}")]
    Unconfigured(String),
    #[error("Sign-in verification is temporarily unavailable.")]
    Unavailable,
}

impl From<AuthError> for ApiError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Missing => ApiError::unauthorized("Missing Pokoin bearer token."),
            AuthError::Invalid(message) => {
                // Node (_firebase.verifyBearerToken since the 2026-10-08 security release)
                // never echoes the decoder reason; it is logged instead.
                tracing::warn!(reason = %message.chars().take(80).collect::<String>(), "pokoin auth token rejected");
                ApiError::unauthorized("Invalid or expired sign-in token.")
            }
            AuthError::Unconfigured(message) => {
                tracing::error!(%message, "auth not configured");
                ApiError::internal("Sign-in verification is not configured.")
            }
            AuthError::Unavailable => {
                ApiError::unavailable("Sign-in could not be checked right now.")
            }
        }
    }
}

/// Firebase `sign_in_provider` values, kept as a string because custom
/// providers (wallet) use `custom`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FirebaseInfo {
    #[serde(default, rename = "sign_in_provider")]
    pub sign_in_provider: String,
    #[serde(default)]
    pub identities: serde_json::Map<String, serde_json::Value>,
}

/// A verified Firebase ID token, decoded the way the Node
/// `verifyIdToken()` result is consumed across the codebase.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Claims {
    #[serde(default)]
    pub uid: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub email_verified: bool,
    #[serde(default)]
    pub pok_email_verified: bool,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub picture: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub exp: i64,
    #[serde(default)]
    pub iat: i64,
    #[serde(default)]
    pub auth_time: i64,
    #[serde(default)]
    pub firebase: FirebaseInfo,
    /// Any other custom claims, preserved for callers that read them.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Claims {
    /// The `admin` / `isAdmin` custom claim the SPA reads off the profile.
    pub fn admin_claim(&self) -> bool {
        self.extra
            .get("admin")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
            || self
                .extra
                .get("isAdmin")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
    }

    /// Exactly the Node `passwordAccountRequiresVerification` predicate.
    pub fn password_account_requires_verification(&self) -> bool {
        if self.firebase.sign_in_provider != "password" {
            return false;
        }
        !self.email_verified && !self.pok_email_verified
    }

    /// Node `assertActivePasswordAccount(decoded, { requireVerified })`.
    pub fn assert_active_password_account(&self, require_verified: bool) -> Result<(), ApiError> {
        if !require_verified || !self.password_account_requires_verification() {
            return Ok(());
        }
        Err(
            ApiError::forbidden("Verify your email address to continue.")
                .with_code("auth/pokoin-email-not-verified"),
        )
    }
}

#[async_trait]
pub trait TokenVerifier: Send + Sync + 'static {
    async fn verify(&self, token: &str) -> Result<Claims, AuthError>;
}

/// Extract a bearer token from an `Authorization` header value.
pub fn bearer(header: Option<&str>) -> Result<&str, AuthError> {
    let header = header.ok_or(AuthError::Missing)?;
    header
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or(AuthError::Missing)
}

#[derive(Deserialize)]
struct RawClaims {
    #[serde(default)]
    sub: String,
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    email_verified: bool,
    #[serde(default)]
    pok_email_verified: bool,
    #[serde(default)]
    name: String,
    #[serde(default)]
    picture: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    exp: i64,
    #[serde(default)]
    iat: i64,
    #[serde(default)]
    auth_time: i64,
    #[serde(default)]
    firebase: FirebaseInfo,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Deserialize, Clone)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}

struct JwksCache {
    fetched_at: Instant,
    keys: HashMap<String, (String, String)>,
}

/// Native Firebase ID token verifier (RS256 against Google's JWKS).
pub struct FirebaseVerifier {
    project_id: String,
    transport: SharedTransport,
    jwks_url: String,
    cache: RwLock<Option<JwksCache>>,
    ttl: Duration,
    leeway_secs: u64,
    retry: RetryPolicy,
}

impl FirebaseVerifier {
    pub fn new(config: &AccountsConfig, transport: SharedTransport) -> Self {
        Self {
            project_id: config.project_id.clone(),
            transport,
            jwks_url: config.jwks_url.clone(),
            cache: RwLock::new(None),
            ttl: Duration::from_secs(6 * 60 * 60),
            leeway_secs: 60,
            retry: RetryPolicy::default(),
        }
    }

    pub fn with_ttl(mut self, ttl: Duration) -> Self {
        self.ttl = ttl;
        self
    }

    pub fn with_retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    /// Fetch (or reuse) the JWKS key map. `force` refetches, which is what an
    /// unknown `kid` triggers — Google rotates signing keys.
    async fn keys(&self, force: bool) -> Result<HashMap<String, (String, String)>, AuthError> {
        if !force {
            let cache = self.cache.read().await;
            if let Some(cache) = cache.as_ref() {
                if cache.fetched_at.elapsed() < self.ttl {
                    return Ok(cache.keys.clone());
                }
            }
        }
        let response = send_with_retry(
            &self.transport,
            HttpRequest::new("GET", self.jwks_url.clone()),
            self.retry,
        )
        .await
        .map_err(|_| AuthError::Unavailable)?;
        if !response.is_success() {
            return Err(AuthError::Unavailable);
        }
        let jwks: Jwks = serde_json::from_slice(&response.body).map_err(|_| AuthError::Unavailable)?;
        let keys: HashMap<String, (String, String)> = jwks
            .keys
            .into_iter()
            .map(|key| (key.kid, (key.n, key.e)))
            .collect();
        if keys.is_empty() {
            return Err(AuthError::Unavailable);
        }
        *self.cache.write().await = Some(JwksCache {
            fetched_at: Instant::now(),
            keys: keys.clone(),
        });
        Ok(keys)
    }

    /// Decode and verify without touching the JWKS cache policy: used by tests
    /// to verify a signature against a supplied key.
    fn decode_with(&self, token: &str, n: &str, e: &str) -> Result<Claims, AuthError> {
        let mut validation = Validation::new(Algorithm::RS256);
        validation.leeway = self.leeway_secs;
        validation.set_audience(&[self.project_id.as_str()]);
        validation.set_issuer(&[format!(
            "https://securetoken.google.com/{}",
            self.project_id
        )]);
        validation.set_required_spec_claims(&["exp", "iat", "aud", "iss", "sub"]);
        // A missing `sub` must not fall back to an empty uid.
        validation.sub = None;

        let key = DecodingKey::from_rsa_components(n, e)
            .map_err(|error| AuthError::Invalid(error.to_string()))?;
        let data = decode::<RawClaims>(token, &key, &validation)
            .map_err(|error| AuthError::Invalid(error.to_string()))?;

        let now = chrono::Utc::now().timestamp();
        if data.claims.iat > now + self.leeway_secs as i64 {
            return Err(AuthError::Invalid("token was issued in the future".into()));
        }
        if data.claims.exp <= now - self.leeway_secs as i64 {
            return Err(AuthError::Invalid("token expired".into()));
        }

        let uid = if !data.claims.sub.trim().is_empty() {
            data.claims.sub.trim().to_string()
        } else {
            data.claims.user_id.trim().to_string()
        };
        if uid.is_empty() {
            return Err(AuthError::Invalid("token has no subject".into()));
        }

        Ok(Claims {
            uid,
            email: data.claims.email.trim().to_ascii_lowercase(),
            email_verified: data.claims.email_verified,
            pok_email_verified: data.claims.pok_email_verified,
            name: data.claims.name,
            picture: data.claims.picture,
            role: data.claims.role,
            exp: data.claims.exp,
            iat: data.claims.iat,
            auth_time: data.claims.auth_time,
            firebase: data.claims.firebase,
            extra: data.claims.extra,
        })
    }
}

#[async_trait]
impl TokenVerifier for FirebaseVerifier {
    async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        if self.project_id.trim().is_empty() {
            return Err(AuthError::Unconfigured("FIREBASE_PROJECT_ID is empty".into()));
        }
        let header = decode_header(token).map_err(|error| AuthError::Invalid(error.to_string()))?;
        if header.alg != Algorithm::RS256 {
            return Err(AuthError::Invalid(format!(
                "unexpected algorithm {:?}",
                header.alg
            )));
        }
        let kid = header
            .kid
            .clone()
            .ok_or_else(|| AuthError::Invalid("token has no key id".into()))?;

        let keys = self.keys(false).await?;
        let (n, e) = match keys.get(&kid) {
            Some(pair) => pair.clone(),
            None => self
                .keys(true)
                .await?
                .get(&kid)
                .cloned()
                .ok_or_else(|| AuthError::Invalid("unknown signing key".into()))?,
        };
        self.decode_with(token, &n, &e)
    }
}

/// Optional-auth helper: a missing or malformed token yields `None`, exactly
/// like the Node `optionalUserUid` on the cart/watchlist paths.
pub async fn optional_claims(
    verifier: &Arc<dyn TokenVerifier>,
    header: Option<&str>,
) -> Option<Claims> {
    let raw = header?;
    if !raw.starts_with("Bearer ") {
        return None;
    }
    let token = bearer(Some(raw)).ok()?;
    verifier.verify(token).await.ok()
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: i64,
}

#[derive(Serialize)]
struct OAuthAssertion<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

struct CachedAccessToken {
    token: String,
    expires_at: Instant,
}

/// Service-account credential holder: OAuth access tokens and custom tokens.
pub struct ServiceAccount {
    project_id: String,
    client_email: String,
    encoding_key: EncodingKey,
    transport: SharedTransport,
    token_url: String,
    scopes: String,
    cache: RwLock<Option<CachedAccessToken>>,
    retry: RetryPolicy,
}

impl ServiceAccount {
    pub fn new(config: &AccountsConfig, transport: SharedTransport) -> Result<Self, AuthError> {
        if !config.has_service_account() {
            return Err(AuthError::Unconfigured(
                "Firebase service-account env vars are missing.".into(),
            ));
        }
        let encoding_key = EncodingKey::from_rsa_pem(config.private_key_pem.as_bytes())
            .map_err(|error| AuthError::Unconfigured(format!("private key is unusable: {error}")))?;
        Ok(Self {
            project_id: config.project_id.clone(),
            client_email: config.client_email.clone(),
            encoding_key,
            transport,
            token_url: config.oauth_token_url.clone(),
            scopes: DEFAULT_SCOPES.to_string(),
            cache: RwLock::new(None),
            retry: RetryPolicy::default(),
        })
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn client_email(&self) -> &str {
        &self.client_email
    }

    pub fn with_scopes(mut self, scopes: impl Into<String>) -> Self {
        self.scopes = scopes.into();
        self
    }

    /// Sign an arbitrary claims set with the service-account key (RS256).
    pub fn sign<T: Serialize>(&self, claims: &T) -> Result<String, AuthError> {
        jsonwebtoken::encode(
            &Header::new(Algorithm::RS256),
            claims,
            &self.encoding_key,
        )
        .map_err(|error| AuthError::Invalid(error.to_string()))
    }

    /// The signed JWT assertion used for the OAuth 2.0 bearer exchange.
    pub fn oauth_assertion(&self) -> Result<String, AuthError> {
        let now = chrono::Utc::now().timestamp();
        let assertion = OAuthAssertion {
            iss: &self.client_email,
            scope: &self.scopes,
            aud: &self.token_url,
            iat: now,
            // Google rejects assertions valid for more than an hour.
            exp: now + 3600,
        };
        self.sign(&assertion)
    }

    /// Cached OAuth 2.0 access token for Firestore / Identity Toolkit.
    pub async fn access_token(&self) -> Result<String, AuthError> {
        {
            let cache = self.cache.read().await;
            if let Some(cached) = cache.as_ref() {
                if Instant::now() < cached.expires_at {
                    return Ok(cached.token.clone());
                }
            }
        }

        let assertion = self.oauth_assertion()?;
        let body = format!(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={}",
            urlencode(&assertion)
        );
        let request = HttpRequest::new("POST", self.token_url.clone())
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json");
        let mut request = request;
        request.body = body.into_bytes();

        let response = send_with_retry(&self.transport, request, self.retry)
            .await
            .map_err(|_| AuthError::Unavailable)?;
        if !response.is_success() {
            return Err(AuthError::Unavailable);
        }
        let parsed: OAuthTokenResponse = serde_json::from_slice(&response.body)
            .map_err(|error| AuthError::Invalid(error.to_string()))?;
        if parsed.access_token.trim().is_empty() {
            return Err(AuthError::Unavailable);
        }
        // Refresh a minute early so a token never expires mid-request.
        let ttl = (parsed.expires_in.max(120) - 60) as u64;
        *self.cache.write().await = Some(CachedAccessToken {
            token: parsed.access_token.clone(),
            expires_at: Instant::now() + Duration::from_secs(ttl),
        });
        Ok(parsed.access_token)
    }

    /// Firebase `createCustomToken(uid, claims)`. The custom claims are nested
    /// under `claims`, exactly like the Admin SDK.
    pub fn create_custom_token(
        &self,
        uid: &str,
        custom_claims: Option<serde_json::Value>,
    ) -> Result<String, AuthError> {
        if uid.trim().is_empty() {
            return Err(AuthError::Invalid("custom token needs a uid".into()));
        }
        let now = chrono::Utc::now().timestamp();
        let mut payload = serde_json::Map::new();
        payload.insert("iss".into(), serde_json::json!(self.client_email));
        payload.insert("sub".into(), serde_json::json!(self.client_email));
        payload.insert("aud".into(), serde_json::json!(CUSTOM_TOKEN_AUDIENCE));
        payload.insert("iat".into(), serde_json::json!(now));
        payload.insert("exp".into(), serde_json::json!(now + 3600));
        payload.insert("uid".into(), serde_json::json!(uid));
        if let Some(claims) = custom_claims {
            payload.insert("claims".into(), claims);
        }
        self.sign(&serde_json::Value::Object(payload))
    }

    /// Invalidate the cached access token (used by the Firestore layer after a
    /// 401, so one stale token cannot wedge the worker).
    pub async fn invalidate_access_token(&self) {
        *self.cache.write().await = None;
    }
}

/// Percent-encode a form value (RFC 3986 unreserved set kept literal).
pub fn urlencode(value: &str) -> String {
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

/// Read a JSON error `message` from a Google API response, if present.
pub fn google_error_message(response: &HttpResponse) -> String {
    response
        .json_value()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(|message| message.as_str())
                        .map(str::to_string)
                        .or_else(|| error.as_str().map(str::to_string))
                })
                .or_else(|| {
                    value
                        .get("error_description")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                })
        })
        .unwrap_or_else(|| response.text())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Always(Claims);

    #[async_trait]
    impl TokenVerifier for Always {
        async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
            if token == "good" {
                Ok(self.0.clone())
            } else {
                Err(AuthError::Invalid("bad token".into()))
            }
        }
    }

    #[test]
    fn bearer_requires_scheme_and_value() {
        assert!(matches!(bearer(None), Err(AuthError::Missing)));
        assert!(matches!(bearer(Some("token")), Err(AuthError::Missing)));
        assert!(matches!(bearer(Some("Bearer ")), Err(AuthError::Missing)));
        assert_eq!(bearer(Some("Bearer abc")).unwrap(), "abc");
        assert_eq!(bearer(Some("Bearer  abc ")).unwrap(), "abc");
    }

    #[test]
    fn password_gate_matches_node_predicate() {
        let mut claims = Claims {
            email_verified: false,
            ..Default::default()
        };
        claims.firebase.sign_in_provider = "password".into();
        assert!(claims.password_account_requires_verification());

        claims.email_verified = true;
        assert!(!claims.password_account_requires_verification());

        claims.email_verified = false;
        claims.pok_email_verified = true;
        assert!(!claims.password_account_requires_verification());

        claims.pok_email_verified = false;
        claims.firebase.sign_in_provider = "google.com".into();
        assert!(!claims.password_account_requires_verification());
    }

    #[test]
    fn admin_claim_reads_both_spellings() {
        let mut claims = Claims::default();
        assert!(!claims.admin_claim());
        claims.extra.insert("admin".into(), serde_json::json!(true));
        assert!(claims.admin_claim());
        let mut claims = Claims::default();
        claims.extra.insert("isAdmin".into(), serde_json::json!(true));
        assert!(claims.admin_claim());
        let mut claims = Claims::default();
        claims.extra.insert("admin".into(), serde_json::json!("yes"));
        assert!(!claims.admin_claim());
    }

    #[test]
    fn assert_active_password_account_is_403_with_node_code() {
        let mut claims = Claims::default();
        claims.firebase.sign_in_provider = "password".into();
        let error = claims.assert_active_password_account(true).unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::FORBIDDEN);
        assert_eq!(error.code(), Some("auth/pokoin-email-not-verified"));
        // Gate disabled entirely when the flag is off.
        assert!(claims.assert_active_password_account(false).is_ok());
    }

    #[tokio::test]
    async fn optional_claims_swallows_bad_tokens() {
        let verifier: Arc<dyn TokenVerifier> = Arc::new(Always(Claims {
            uid: "u1".into(),
            ..Default::default()
        }));
        assert!(optional_claims(&verifier, None).await.is_none());
        assert!(optional_claims(&verifier, Some("nope")).await.is_none());
        assert!(optional_claims(&verifier, Some("Bearer bad")).await.is_none());
        let claims = optional_claims(&verifier, Some("Bearer good")).await.unwrap();
        assert_eq!(claims.uid, "u1");
    }

    #[test]
    fn urlencode_keeps_unreserved_and_escapes_jwt_dots() {
        assert_eq!(urlencode("abc-_.~"), "abc-_.~");
        assert_eq!(urlencode("a.b"), "a.b");
        assert_eq!(urlencode("a+b/c="), "a%2Bb%2Fc%3D");
    }

    #[test]
    fn google_error_message_reads_nested_message() {
        let response = HttpResponse::json(
            400,
            serde_json::json!({ "error": { "message": "EMAIL_EXISTS" } }),
        );
        assert_eq!(google_error_message(&response), "EMAIL_EXISTS");
        let response = HttpResponse::json(400, serde_json::json!({ "error": "plain" }));
        assert_eq!(google_error_message(&response), "plain");
    }
}
