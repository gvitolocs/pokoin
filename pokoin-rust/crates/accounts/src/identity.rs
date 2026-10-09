//! Firebase Auth (Identity Toolkit) administration over REST.
//!
//! Node used `admin.auth()`: `getUser`, `getUserByEmail`, `createUser`,
//! `updateUser`, `deleteUser` and `setCustomUserClaims`. Those are exactly the
//! project-scoped Identity Toolkit admin endpoints, authenticated with the
//! service-account OAuth token, so this is a faithful native replacement.
//!
//! Error codes are mapped back to the Admin SDK strings the Node handlers
//! branched on (`auth/user-not-found`, `auth/email-already-exists`), because
//! `register-email` and `verify-email-signup` depend on that distinction.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value as Json};

use crate::config::AccountsConfig;
use crate::firebase::{google_error_message, ServiceAccount};
use crate::http::{send_with_retry, HttpRequest, RetryPolicy, SharedTransport};

pub const USER_NOT_FOUND: &str = "auth/user-not-found";
pub const EMAIL_ALREADY_EXISTS: &str = "auth/email-already-exists";
pub const USER_ALREADY_EXISTS: &str = "auth/uid-already-exists";
pub const INVALID_PASSWORD: &str = "auth/invalid-password";
pub const INVALID_EMAIL: &str = "auth/invalid-email";
pub const INVALID_ARGUMENT: &str = "auth/invalid-argument";

#[derive(Debug, Clone)]
pub struct IdentityError {
    /// Admin-SDK-shaped code, e.g. `auth/user-not-found`.
    pub code: String,
    pub status: u16,
    pub message: String,
}

impl IdentityError {
    pub fn user_not_found() -> Self {
        Self {
            code: USER_NOT_FOUND.into(),
            status: 404,
            message: "There is no user record corresponding to the provided identifier.".into(),
        }
    }

    pub fn is(&self, code: &str) -> bool {
        self.code == code
    }

    pub fn not_found(&self) -> bool {
        self.is(USER_NOT_FOUND)
    }
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for IdentityError {}

/// Map an Identity Toolkit error message onto the Admin SDK code the Node code
/// expects.
pub fn map_error_code(raw: &str) -> String {
    let upper = raw.to_ascii_uppercase();
    if upper.contains("EMAIL_EXISTS") {
        return EMAIL_ALREADY_EXISTS.into();
    }
    if upper.contains("USER_NOT_FOUND") || upper.contains("NO_USER_RECORD") {
        return USER_NOT_FOUND.into();
    }
    if upper.contains("DUPLICATE_LOCAL_ID") || upper.contains("UID_ALREADY_EXISTS") {
        return USER_ALREADY_EXISTS.into();
    }
    if upper.contains("PASSWORD") {
        return INVALID_PASSWORD.into();
    }
    if upper.contains("INVALID_EMAIL") || upper.contains("EMAIL_NOT_FOUND") {
        return INVALID_EMAIL.into();
    }
    INVALID_ARGUMENT.into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderUserInfo {
    #[serde(default, rename = "providerId")]
    pub provider_id: String,
    #[serde(default, rename = "federatedId")]
    pub federated_id: String,
    #[serde(default, rename = "rawId")]
    pub raw_id: String,
    #[serde(default, rename = "email")]
    pub email: String,
    #[serde(default, rename = "displayName")]
    pub display_name: String,
    #[serde(default, rename = "photoUrl")]
    pub photo_url: String,
}

/// The subset of the Admin SDK `UserRecord` this domain consumes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UserRecord {
    #[serde(default, rename = "localId")]
    pub uid: String,
    #[serde(default)]
    pub email: String,
    #[serde(default, rename = "emailVerified")]
    pub email_verified: bool,
    #[serde(default, rename = "displayName")]
    pub display_name: String,
    #[serde(default, rename = "photoUrl")]
    pub photo_url: String,
    #[serde(default)]
    pub disabled: bool,
    /// `customAttributes` is a JSON **string** in the REST payload.
    #[serde(default, rename = "customAttributes")]
    pub custom_attributes: Option<String>,
    #[serde(default, rename = "providerUserInfo", alias = "providerUserInfo")]
    pub provider_user_info: Vec<ProviderUserInfo>,
    #[serde(default)]
    pub metadata: UserMetadata,
}

/// `UserRecord.metadata` — `creationTime` / `lastSignInTime` ISO strings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UserMetadata {
    #[serde(default, rename = "creationTime")]
    pub creation_time: String,
    #[serde(default, rename = "lastSignInTime")]
    pub last_sign_in_time: String,
}

impl UserRecord {
    /// `Date.parse(user.metadata.creationTime)` — 0 when absent or unparsable,
    /// which the referral claim window treats as "unknown".
    pub fn created_at_millis(&self) -> i64 {
        chrono::DateTime::parse_from_rfc3339(self.metadata.creation_time.trim())
            .ok()
            .map(|parsed| parsed.timestamp_millis())
            .unwrap_or(0)
    }

    pub fn custom_claims(&self) -> Map<String, Json> {
        self.custom_attributes
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Json>(raw).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    }
}

#[derive(Debug, Deserialize)]
struct LookupResponse {
    #[serde(default)]
    users: Vec<UserRecord>,
}

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    #[serde(default)]
    message: Option<String>,
}

/// Firebase Auth admin client.
#[derive(Clone)]
pub struct FirebaseAuth {
    inner: Arc<FirebaseAuthInner>,
}

struct FirebaseAuthInner {
    /// `https://identitytoolkit.googleapis.com/v1`
    base: String,
    project_id: String,
    transport: SharedTransport,
    auth: Arc<ServiceAccount>,
    retry: RetryPolicy,
}

impl FirebaseAuth {
    pub fn new(
        config: &AccountsConfig,
        transport: SharedTransport,
        auth: Arc<ServiceAccount>,
        retry: RetryPolicy,
    ) -> Self {
        Self {
            inner: Arc::new(FirebaseAuthInner {
                base: config.identity_base.trim_end_matches('/').to_string(),
                project_id: config.project_id.clone(),
                transport,
                auth,
                retry,
            }),
        }
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}/projects/{}/{}",
            self.inner.base, self.inner.project_id, path
        )
    }

    async fn send(&self, request: HttpRequest) -> Result<Json, IdentityError> {
        let token = self.inner.auth.access_token().await.map_err(|error| {
            IdentityError {
                code: INVALID_ARGUMENT.into(),
                status: 500,
                message: error.to_string(),
            }
        })?;
        let request = request.header("Authorization", format!("Bearer {token}"));
        let response = send_with_retry(&self.inner.transport, request, self.inner.retry)
            .await
            .map_err(|error| IdentityError {
                code: "auth/network-request-failed".into(),
                status: 503,
                message: error.to_string(),
            })?;

        let body = response.json_value().unwrap_or(Json::Null);
        if !response.is_success() {
            if response.status == 401 {
                self.inner.auth.invalidate_access_token().await;
            }
            // Identity Toolkit reports `{"error":{"message":"EMAIL_EXISTS"}}`.
            let raw = body
                .get("error")
                .and_then(|error| serde_json::from_value::<ApiErrorBody>(error.clone()).ok())
                .and_then(|error| error.message)
                .unwrap_or_else(|| google_error_message(&response));
            return Err(IdentityError {
                code: map_error_code(&raw),
                status: response.status,
                message: raw,
            });
        }
        Ok(body)
    }

    /// `getUser(uid)`.
    pub async fn get_user(&self, uid: &str) -> Result<UserRecord, IdentityError> {
        let request = HttpRequest::new("POST", self.url("accounts:lookup"))
            .json(&json!({ "localId": [uid] }))
            .map_err(|error| IdentityError {
                code: INVALID_ARGUMENT.into(),
                status: 500,
                message: error.to_string(),
            })?;
        let body = self.send(request).await?;
        let parsed: LookupResponse =
            serde_json::from_value(body).map_err(|error| IdentityError {
                code: INVALID_ARGUMENT.into(),
                status: 500,
                message: error.to_string(),
            })?;
        parsed.users.into_iter().next().ok_or_else(IdentityError::user_not_found)
    }

    /// `getUserByEmail(email)`. Throws `auth/user-not-found` when absent, like
    /// the Admin SDK.
    pub async fn get_user_by_email(&self, email: &str) -> Result<UserRecord, IdentityError> {
        let request = HttpRequest::new("POST", self.url("accounts:lookup"))
            .json(&json!({ "email": [email] }))
            .map_err(|error| IdentityError {
                code: INVALID_ARGUMENT.into(),
                status: 500,
                message: error.to_string(),
            })?;
        let body = self.send(request).await?;
        let parsed: LookupResponse =
            serde_json::from_value(body).map_err(|error| IdentityError {
                code: INVALID_ARGUMENT.into(),
                status: 500,
                message: error.to_string(),
            })?;
        parsed.users.into_iter().next().ok_or_else(IdentityError::user_not_found)
    }

    /// `createUser({ email, password, displayName, emailVerified })`.
    pub async fn create_user(&self, request: CreateUser) -> Result<UserRecord, IdentityError> {
        let mut payload = Map::new();
        if let Some(uid) = &request.uid {
            payload.insert("localId".into(), json!(uid));
        }
        if !request.email.is_empty() {
            payload.insert("email".into(), json!(request.email));
        }
        if let Some(password) = &request.password {
            payload.insert("password".into(), json!(password));
        }
        if let Some(display_name) = &request.display_name {
            payload.insert("displayName".into(), json!(display_name));
        }
        if let Some(photo_url) = &request.photo_url {
            payload.insert("photoUrl".into(), json!(photo_url));
        }
        payload.insert("emailVerified".into(), json!(request.email_verified));

        let http = HttpRequest::new("POST", self.url("accounts"))
            .json(&Json::Object(payload))
            .map_err(|error| IdentityError {
                code: INVALID_ARGUMENT.into(),
                status: 500,
                message: error.to_string(),
            })?;
        let body = self.send(http).await?;
        // `accounts` returns the created record directly.
        serde_json::from_value(body).map_err(|error| IdentityError {
            code: INVALID_ARGUMENT.into(),
            status: 500,
            message: error.to_string(),
        })
    }

    /// `updateUser(uid, { displayName, email, password, emailVerified })`.
    pub async fn update_user(&self, uid: &str, update: UpdateUser) -> Result<UserRecord, IdentityError> {
        let mut payload = Map::new();
        payload.insert("localId".into(), json!(uid));
        if let Some(display_name) = &update.display_name {
            payload.insert("displayName".into(), json!(display_name));
        }
        if let Some(email) = &update.email {
            payload.insert("email".into(), json!(email));
        }
        if let Some(password) = &update.password {
            payload.insert("password".into(), json!(password));
        }
        if let Some(photo_url) = &update.photo_url {
            payload.insert("photoUrl".into(), json!(photo_url));
        }
        if let Some(email_verified) = update.email_verified {
            payload.insert("emailVerified".into(), json!(email_verified));
        }
        if let Some(custom_attributes) = &update.custom_attributes {
            payload.insert("customAttributes".into(), json!(custom_attributes));
        }

        let http = HttpRequest::new("POST", self.url("accounts:update"))
            .json(&Json::Object(payload))
            .map_err(|error| IdentityError {
                code: INVALID_ARGUMENT.into(),
                status: 500,
                message: error.to_string(),
            })?;
        let body = self.send(http).await?;
        serde_json::from_value(body).map_err(|error| IdentityError {
            code: INVALID_ARGUMENT.into(),
            status: 500,
            message: error.to_string(),
        })
    }

    /// `setCustomUserClaims(uid, claims)`. Passing `None` clears all claims,
    /// which is the Admin SDK behaviour for `null`.
    pub async fn set_custom_user_claims(
        &self,
        uid: &str,
        claims: Option<&Map<String, Json>>,
    ) -> Result<(), IdentityError> {
        let serialized = match claims {
            Some(claims) => serde_json::to_string(&Json::Object(claims.clone())).map_err(|error| {
                IdentityError {
                    code: INVALID_ARGUMENT.into(),
                    status: 500,
                    message: error.to_string(),
                }
            })?,
            None => String::new(),
        };
        self.update_user(
            uid,
            UpdateUser {
                custom_attributes: Some(serialized),
                ..Default::default()
            },
        )
        .await
        .map(|_| ())
    }

    /// `deleteUser(uid)`.
    pub async fn delete_user(&self, uid: &str) -> Result<(), IdentityError> {
        let http = HttpRequest::new("POST", self.url("accounts:delete"))
            .json(&json!({ "localId": uid }))
            .map_err(|error| IdentityError {
                code: INVALID_ARGUMENT.into(),
                status: 500,
                message: error.to_string(),
            })?;
        self.send(http).await.map(|_| ())
    }
}

#[derive(Debug, Clone, Default)]
pub struct CreateUser {
    pub uid: Option<String>,
    pub email: String,
    pub password: Option<String>,
    pub display_name: Option<String>,
    pub photo_url: Option<String>,
    pub email_verified: bool,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateUser {
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub password: Option<String>,
    pub photo_url: Option<String>,
    pub email_verified: Option<bool>,
    pub custom_attributes: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_map_to_admin_sdk_strings() {
        assert_eq!(map_error_code("EMAIL_EXISTS"), EMAIL_ALREADY_EXISTS);
        assert_eq!(map_error_code("email_exists"), EMAIL_ALREADY_EXISTS);
        assert_eq!(map_error_code("USER_NOT_FOUND"), USER_NOT_FOUND);
        assert_eq!(map_error_code("DUPLICATE_LOCAL_ID"), USER_ALREADY_EXISTS);
        assert_eq!(map_error_code("WEAK_PASSWORD"), INVALID_PASSWORD);
        assert_eq!(map_error_code("INVALID_EMAIL"), INVALID_EMAIL);
        assert_eq!(map_error_code("SOMETHING_ELSE"), INVALID_ARGUMENT);
    }

    #[test]
    fn custom_claims_parse_from_json_string() {
        let record = UserRecord {
            custom_attributes: Some(r#"{"pok_email_verified":true,"tier":"gold"}"#.into()),
            ..Default::default()
        };
        let claims = record.custom_claims();
        assert_eq!(claims.get("pok_email_verified"), Some(&json!(true)));
        assert_eq!(claims.get("tier"), Some(&json!("gold")));
    }

    #[test]
    fn missing_or_broken_custom_attributes_yield_no_claims() {
        let record = UserRecord::default();
        assert!(record.custom_claims().is_empty());
        let record = UserRecord {
            custom_attributes: Some("not json".into()),
            ..Default::default()
        };
        assert!(record.custom_claims().is_empty());
    }

    #[test]
    fn creation_time_parses_like_date_parse() {
        let record = UserRecord {
            metadata: UserMetadata {
                creation_time: "2026-10-08T00:00:00Z".into(),
                last_sign_in_time: String::new(),
            },
            ..Default::default()
        };
        assert_eq!(record.created_at_millis(), 1_791_417_600_000);
        let record = UserRecord::default();
        assert_eq!(record.created_at_millis(), 0);
        let record = UserRecord {
            metadata: UserMetadata {
                creation_time: "not a date".into(),
                last_sign_in_time: String::new(),
            },
            ..Default::default()
        };
        assert_eq!(record.created_at_millis(), 0);
    }

    #[test]
    fn user_not_found_helper_has_the_admin_code() {
        let error = IdentityError::user_not_found();
        assert!(error.not_found());
        assert!(error.is(USER_NOT_FOUND));
    }
}
