//! State handed to native route crates: the shared pools plus the accounts
//! domain (Firebase ID-token verifier, Firestore, service account).

use axum::{
    http::{header, HeaderMap, StatusCode},
    response::Response,
};
use pokoin_accounts::firebase::{AuthError, Claims};
use serde_json::json;

use crate::{http, ApiState};

#[derive(Clone)]
pub struct RouteState {
    pub api: ApiState,
    pub accounts: pokoin_accounts::DomainState,
}

/// Operator emails of `_search_debug_auth.js` (`ALLOWED_EMAILS`).
const DEBUG_EMAILS: [&str; 2] = ["vitologiuseppe17@gmail.com", "pokoinpos@gmail.com"];

impl RouteState {
    pub fn new(api: ApiState, accounts: pokoin_accounts::DomainState) -> Self {
        Self { api, accounts }
    }

    pub fn from_env() -> Result<Self, String> {
        Ok(Self::new(ApiState::from_env()?, pokoin_accounts::DomainState::from_env()))
    }

    /// `verifyBearerToken(req)`: 401 `Missing Pokoin bearer token.` without a
    /// `Bearer ` header, 401 for an invalid token, then the password-account
    /// gate (`POKOIN_REQUIRE_VERIFIED_PASSWORD=1`).
    pub async fn require_user(&self, headers: &HeaderMap) -> Result<Claims, Response> {
        let raw = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
        let token = match pokoin_accounts::firebase::bearer(raw) {
            Ok(token) => token,
            Err(error) => return Err(auth_error(error)),
        };
        let claims = self.accounts.verifier().verify(token).await.map_err(auth_error)?;
        let require_verified = std::env::var("POKOIN_REQUIRE_VERIFIED_PASSWORD").as_deref() == Ok("1");
        if let Err(error) = claims.assert_active_password_account(require_verified) {
            return Err(error.into_response());
        }
        Ok(claims)
    }

    /// Optional auth: `None` for a missing or invalid token.
    pub async fn optional_user(&self, headers: &HeaderMap) -> Option<Claims> {
        let raw = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
        pokoin_accounts::firebase::optional_claims(self.accounts.verifier(), raw).await
    }

    /// `authorizeSearchDebugRequest(req)` of `_search_debug_auth.js`.
    pub async fn require_debug_admin(&self, headers: &HeaderMap) -> Result<Claims, Response> {
        let claims = self.require_user(headers).await?;
        let trusted = if claims.email_verified { claims.email.trim().to_ascii_lowercase() } else { String::new() };
        let configured: Vec<String> = ["MARKETPLACE_ADMIN_EMAILS", "MARKETPLACE_DEBUG_EMAILS", "ADMIN_SIGNUP_EMAIL"]
            .iter()
            .map(|k| std::env::var(k).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(",")
            .split(',')
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        let admin_flag = |key: &str| claims.extra.get(key).and_then(|v| v.as_bool()) == Some(true);
        let has_admin = admin_flag("admin")
            || admin_flag("isAdmin")
            || admin_flag("hasAdminAccess")
            || claims.role.trim().eq_ignore_ascii_case("admin");
        if (!trusted.is_empty() && (DEBUG_EMAILS.contains(&trusted.as_str()) || configured.contains(&trusted))) || has_admin {
            return Ok(claims);
        }
        Err(http::json(
            StatusCode::FORBIDDEN,
            json!({ "error": "Search debug is not enabled for this account." }),
        ))
    }
}

fn auth_error(error: AuthError) -> Response {
    pokoin_accounts::error::ApiError::from(error).into_response()
}
