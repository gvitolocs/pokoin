//! Bearer auth: Firebase ID token verification, ported natively.
//!
//! The Node handlers call `verifyBearerToken(req)` (Firebase Admin). The port
//! keeps the same contract — a valid Firebase ID token yields a decoded uid,
//! email and role claims — but verifies the RS256 JWT directly against
//! Google's published JWKS. No Node process and no Admin SDK are involved.
//!
//! `TokenVerifier` is a port so tests (and a future `pokoin-auth` crate) can
//! inject their own implementation. There is deliberately no "accept
//! everything" default.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::error::ApiError;

pub const GOOGLE_JWKS_URL: &str =
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Claims {
    #[serde(default)]
    pub uid: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub admin: bool,
    #[serde(default, rename = "isAdmin")]
    pub is_admin: bool,
    /// Verified custom claims used by reserve authorization and integration roles.
    #[serde(flatten)]
    pub custom: serde_json::Map<String, serde_json::Value>,
}

impl Claims {
    /// Same predicate as the Node `tokenHasAdminAccess`.
    pub fn has_admin_access(&self) -> bool {
        let email = self.email.trim().to_ascii_lowercase();
        if email == "vitologiuseppe17@gmail.com" || email == "pokoinpos@gmail.com" {
            return true;
        }
        self.admin || self.is_admin || self.role.trim().eq_ignore_ascii_case("admin")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("Missing Pokoin bearer token.")]
    Missing,
    #[error("Invalid or expired sign-in token.")]
    Invalid(String),
    #[error("Sign-in verification is not configured: {0}")]
    Unconfigured(String),
    #[error("Sign-in could not be checked right now.")]
    Unavailable,
}

impl From<AuthError> for ApiError {
    fn from(error: AuthError) -> Self {
        let message = error.to_string();
        match error {
            AuthError::Missing => ApiError::unauthorized(message).with_code("auth/missing-token"),
            AuthError::Invalid(reason) => {
                tracing::warn!(reason = %reason, "auth token rejected");
                ApiError::unauthorized(message).with_code("auth/invalid-token")
            }
            AuthError::Unavailable => ApiError::unavailable(message).with_code("auth/unavailable"),
            AuthError::Unconfigured(message) => {
                tracing::error!(%message, "auth not configured");
                ApiError::internal("Sign-in verification is not configured.")
            }
        }
    }
}

#[async_trait]
pub trait TokenVerifier: Send + Sync + 'static {
    async fn verify(&self, token: &str) -> Result<Claims, AuthError>;
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
    role: String,
    #[serde(default)]
    admin: bool,
    #[serde(default, rename = "isAdmin")]
    is_admin: bool,
    #[serde(flatten)]
    custom: serde_json::Map<String, serde_json::Value>,
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

/// Native Firebase ID token verifier (RS256 over Google's JWKS).
pub struct FirebaseVerifier {
    project_id: String,
    http: reqwest::Client,
    cache: RwLock<Option<JwksCache>>,
    ttl: Duration,
}

impl FirebaseVerifier {
    pub fn new(project_id: impl Into<String>, http: reqwest::Client) -> Self {
        Self {
            project_id: project_id.into(),
            http,
            cache: RwLock::new(None),
            ttl: Duration::from_secs(6 * 60 * 60),
        }
    }

    async fn keys(&self, force: bool) -> Result<HashMap<String, (String, String)>, AuthError> {
        if !force {
            let cache = self.cache.read().await;
            if let Some(cache) = cache.as_ref() {
                if cache.fetched_at.elapsed() < self.ttl {
                    return Ok(cache.keys.clone());
                }
            }
        }
        let response = self
            .http
            .get(GOOGLE_JWKS_URL)
            .timeout(Duration::from_secs(4))
            .send()
            .await
            .map_err(|_| AuthError::Unavailable)?;
        if !response.status().is_success() {
            return Err(AuthError::Unavailable);
        }
        let jwks: Jwks = response.json().await.map_err(|_| AuthError::Unavailable)?;
        let keys = jwks
            .keys
            .into_iter()
            .map(|key| (key.kid, (key.n, key.e)))
            .collect::<HashMap<_, _>>();
        if keys.is_empty() {
            return Err(AuthError::Unavailable);
        }
        *self.cache.write().await = Some(JwksCache {
            fetched_at: Instant::now(),
            keys: keys.clone(),
        });
        Ok(keys)
    }
}

#[async_trait]
impl TokenVerifier for FirebaseVerifier {
    async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        if self.project_id.trim().is_empty() {
            return Err(AuthError::Unconfigured("FIREBASE_PROJECT_ID is empty".into()));
        }
        let header = decode_header(token).map_err(|e| AuthError::Invalid(e.to_string()))?;
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

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[self.project_id.as_str()]);
        validation.set_issuer(&[format!(
            "https://securetoken.google.com/{}",
            self.project_id
        )]);
        validation.set_required_spec_claims(&["exp", "iat", "aud", "iss", "sub"]);

        let key = DecodingKey::from_rsa_components(&n, &e)
            .map_err(|e| AuthError::Invalid(e.to_string()))?;
        let data = decode::<RawClaims>(token, &key, &validation)
            .map_err(|e| AuthError::Invalid(e.to_string()))?;

        let uid = if !data.claims.sub.is_empty() {
            data.claims.sub.clone()
        } else {
            data.claims.user_id.clone()
        };
        if uid.is_empty() {
            return Err(AuthError::Invalid("token has no subject".into()));
        }
        Ok(Claims {
            uid,
            email: data.claims.email.trim().to_ascii_lowercase(),
            role: data.claims.role,
            admin: data.claims.admin,
            is_admin: data.claims.is_admin,
            custom: data.claims.custom,
        })
    }
}

/// Extract a bearer token from an `Authorization` header value.
pub fn bearer(header: Option<&str>) -> Result<&str, AuthError> {
    let header = header.ok_or(AuthError::Missing)?;
    header
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty())
        .ok_or(AuthError::Missing)
}

/// Optional-auth helper: a malformed token is ignored, exactly like the Node
/// `optionalUserUid` used by the cart/watchlist analytics handlers.
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
    fn signed_role_claims_survive_verification_mapping() {
        let raw: RawClaims = serde_json::from_value(serde_json::json!({
            "sub":"u", "email":"e", "role":"seller", "reserve":true,
            "roles":["reserve"], "customClaims":{"hasReserveAccess":true}
        })).unwrap();
        let claims = Claims { uid:raw.sub, email:raw.email, role:raw.role,
            admin:raw.admin,is_admin:raw.is_admin,custom:raw.custom };
        let value=serde_json::to_value(claims).unwrap();
        assert_eq!(value["reserve"],true);
        assert_eq!(value["roles"][0],"reserve");
        assert_eq!(value["customClaims"]["hasReserveAccess"],true);
    }

    #[test]
    fn bearer_requires_scheme_and_value() {
        assert!(bearer(None).is_err());
        assert!(bearer(Some("token")).is_err());
        assert!(bearer(Some("Bearer ")).is_err());
        assert_eq!(bearer(Some("Bearer abc")).unwrap(), "abc");
    }

    #[test]
    fn auth_errors_match_the_node_api_shape() {
        use axum::http::StatusCode;

        let missing: ApiError = AuthError::Missing.into();
        assert_eq!(missing.status, StatusCode::UNAUTHORIZED);
        assert_eq!(missing.message, "Missing Pokoin bearer token.");
        assert_eq!(missing.code.as_deref(), Some("auth/missing-token"));

        let invalid: ApiError = AuthError::Invalid("unknown signing key".into()).into();
        assert_eq!(invalid.status, StatusCode::UNAUTHORIZED);
        assert_eq!(invalid.message, "Invalid or expired sign-in token.");
        assert_eq!(invalid.code.as_deref(), Some("auth/invalid-token"));

        let unavailable: ApiError = AuthError::Unavailable.into();
        assert_eq!(unavailable.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(unavailable.message, "Sign-in could not be checked right now.");
        assert_eq!(unavailable.code.as_deref(), Some("auth/unavailable"));
    }

    #[test]
    fn admin_access_matches_node_predicate() {
        let email_admin = Claims {
            email: "VitoloGiuseppe17@gmail.com".into(),
            ..Default::default()
        };
        assert!(email_admin.has_admin_access());
        let role_admin = Claims {
            role: "Admin".into(),
            ..Default::default()
        };
        assert!(role_admin.has_admin_access());
        let silver = Claims {
            role: "silver".into(),
            ..Default::default()
        };
        assert!(!silver.has_admin_access());
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
}
