//! Environment-driven configuration for the accounts domain.
//!
//! Nothing here is a placeholder: a missing value either disables exactly the
//! feature that needs it (and that route answers a truthful error) or fails
//! construction loudly. There is no "pretend it worked" path.

use std::time::Duration;

#[derive(Debug, Clone)]
pub struct AccountsConfig {
    /// Firebase/GCP project id. Also the ID-token audience.
    pub project_id: String,
    /// Service-account client email (`...@<project>.iam.gserviceaccount.com`).
    pub client_email: String,
    /// Service-account private key, PEM, `\n` escapes already resolved.
    pub private_key_pem: String,
    /// Public Firebase Web API key, used by the Identity Toolkit REST calls.
    pub firebase_api_key: Option<String>,
    /// Public site URL used to build verification links.
    pub public_site_url: String,
    /// `POKOIN_REQUIRE_VERIFIED_PASSWORD === "1"`.
    pub require_verified_password: bool,
    /// Key used to encrypt the pending-signup password payload (AES-256-GCM).
    /// Falls back to the service-account key when unset, exactly like Node.
    pub pending_signup_key: Option<String>,
    /// Google JWKS endpoint (overridable for tests and private deploys).
    pub jwks_url: String,
    /// OAuth 2.0 token endpoint.
    pub oauth_token_url: String,
    /// Firestore documents root.
    pub firestore_base: String,
    /// Identity Toolkit base.
    pub identity_base: String,
    /// `<account-id>.r2.cloudflarestorage.com` bucket endpoint for forum media.
    pub r2_endpoint: Option<String>,
    pub r2_bucket: Option<String>,
    pub r2_access_key_id: Option<String>,
    pub r2_secret_access_key: Option<String>,
    pub r2_public_url: Option<String>,
    pub http_timeout: Duration,
}

fn env_first(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

/// Firebase stores the PEM with literal `\n` sequences in env vars.
pub fn resolve_private_key(raw: &str) -> String {
    raw.replace("\\n", "\n")
}

impl AccountsConfig {
    pub fn from_env() -> Self {
        let project_id = env_first(&["FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"])
            .unwrap_or_default();
        let client_email = env_first(&["FIREBASE_CLIENT_EMAIL"]).unwrap_or_default();
        let private_key_pem = env_first(&["FIREBASE_PRIVATE_KEY"])
            .map(|raw| resolve_private_key(&raw))
            .unwrap_or_default();

        let firestore_base = env_first(&["POKOIN_FIRESTORE_BASE"]).unwrap_or_else(|| {
            format!(
                "https://firestore.googleapis.com/v1/projects/{}/databases/(default)/documents",
                project_id
            )
        });

        Self {
            project_id,
            client_email,
            private_key_pem,
            firebase_api_key: env_first(&["FIREBASE_API_KEY", "POKOIN_FIREBASE_WEB_API_KEY"]),
            public_site_url: env_first(&["PUBLIC_SITE_URL"])
                .unwrap_or_else(|| "https://pokoin.com".into()),
            require_verified_password: env_first(&["POKOIN_REQUIRE_VERIFIED_PASSWORD"])
                .map(|value| value == "1")
                .unwrap_or(false),
            pending_signup_key: env_first(&["POKOIN_PENDING_SIGNUP_KEY", "PENDING_SIGNUP_KEY"]),
            jwks_url: env_first(&["POKOIN_FIREBASE_JWKS_URL"]).unwrap_or_else(|| {
                "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
                    .into()
            }),
            oauth_token_url: env_first(&["POKOIN_OAUTH_TOKEN_URL"])
                .unwrap_or_else(|| "https://oauth2.googleapis.com/token".into()),
            firestore_base,
            identity_base: env_first(&["POKOIN_IDENTITY_BASE"])
                .unwrap_or_else(|| "https://identitytoolkit.googleapis.com/v1".into()),
            r2_endpoint: env_first(&["R2_FORUM_MEDIA_ENDPOINT"]),
            r2_bucket: env_first(&["R2_FORUM_MEDIA_BUCKET"]),
            r2_access_key_id: env_first(&["R2_FORUM_MEDIA_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID"]),
            r2_secret_access_key: env_first(&[
                "R2_FORUM_MEDIA_SECRET_ACCESS_KEY",
                "R2_SECRET_ACCESS_KEY",
            ]),
            r2_public_url: env_first(&["R2_FORUM_MEDIA_PUBLIC_URL"]),
            http_timeout: Duration::from_millis(
                env_first(&["POKOIN_ACCOUNTS_HTTP_TIMEOUT_MS"])
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(4000),
            ),
        }
    }

    /// True when service-account credentials are complete enough to mint
    /// custom tokens, exchange OAuth access tokens and reach Firestore.
    pub fn has_service_account(&self) -> bool {
        !self.project_id.is_empty()
            && !self.client_email.is_empty()
            && !self.private_key_pem.is_empty()
    }

    pub fn identity_url(&self, path: &str) -> String {
        format!("{}/{}", self.identity_base.trim_end_matches('/'), path)
    }

    pub fn site_url(&self) -> String {
        self.public_site_url.trim_end_matches('/').to_string()
    }

    pub fn r2_configured(&self) -> bool {
        self.r2_endpoint.is_some()
            && self.r2_bucket.is_some()
            && self.r2_access_key_id.is_some()
            && self.r2_secret_access_key.is_some()
            && self.r2_public_url.is_some()
    }
}

impl Default for AccountsConfig {
    fn default() -> Self {
        Self {
            project_id: String::new(),
            client_email: String::new(),
            private_key_pem: String::new(),
            firebase_api_key: None,
            public_site_url: "https://pokoin.com".into(),
            require_verified_password: false,
            pending_signup_key: None,
            jwks_url:
                "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
                    .into(),
            oauth_token_url: "https://oauth2.googleapis.com/token".into(),
            firestore_base: String::new(),
            identity_base: "https://identitytoolkit.googleapis.com/v1".into(),
            r2_endpoint: None,
            r2_bucket: None,
            r2_access_key_id: None,
            r2_secret_access_key: None,
            r2_public_url: None,
            http_timeout: Duration::from_millis(4000),
        }
    }
}

/// Test/CI configuration with explicit endpoints.
impl AccountsConfig {
    pub fn for_project(project_id: &str, client_email: &str, private_key_pem: &str) -> Self {
        Self {
            project_id: project_id.into(),
            client_email: client_email.into(),
            private_key_pem: private_key_pem.into(),
            firestore_base: format!(
                "https://firestore.googleapis.com/v1/projects/{}/databases/(default)/documents",
                project_id
            ),
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_key_escapes_are_resolved() {
        let raw = "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n";
        let resolved = resolve_private_key(raw);
        assert!(resolved.contains('\n'));
        assert!(!resolved.contains("\\n"));
        assert_eq!(resolved.lines().count(), 3);
    }

    #[test]
    fn service_account_requires_all_three_parts() {
        let mut config = AccountsConfig::default();
        assert!(!config.has_service_account());
        config.project_id = "p".into();
        config.client_email = "e".into();
        assert!(!config.has_service_account());
        config.private_key_pem = "k".into();
        assert!(config.has_service_account());
    }

    #[test]
    fn site_url_trims_trailing_slash() {
        let config = AccountsConfig {
            public_site_url: "https://pokoin.com/".into(),
            ..Default::default()
        };
        assert_eq!(config.site_url(), "https://pokoin.com");
    }
}
