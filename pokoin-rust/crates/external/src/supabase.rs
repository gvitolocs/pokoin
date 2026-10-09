//! Minimal Supabase REST client (service role) for the forum media table.
//! Native reqwest; no Node SDK.

use serde_json::Value;

use crate::error::{ApiError, ApiResult};

#[derive(Clone)]
pub struct SupabaseConfig {
    pub base_url: String,
    service_role_key: String,
    http: reqwest::Client,
}

impl std::fmt::Debug for SupabaseConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SupabaseConfig")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl SupabaseConfig {
    /// `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
    pub fn from_env() -> Option<Self> {
        let base_url = std::env::var("SUPABASE_URL").ok()?.trim().trim_end_matches('/').to_string();
        let service_role_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY").ok()?;
        if base_url.is_empty() || service_role_key.trim().is_empty() {
            return None;
        }
        Some(Self {
            base_url,
            service_role_key,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .expect("reqwest client"),
        })
    }

    /// `supabaseFetch(path, {method, serviceRole, headers, body})` for inserts
    /// that return the created row(s).
    pub async fn insert(&self, path: &str, body: &Value) -> ApiResult<Value> {
        if !path.starts_with('/') {
            return Err(ApiError::bad_request("Supabase path must start with '/'."));
        }
        let response = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .header("apikey", &self.service_role_key)
            .header("Authorization", format!("Bearer {}", self.service_role_key))
            .header("Content-Type", "application/json")
            .header("Prefer", "return=representation")
            .json(body)
            .send()
            .await?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(ApiError::upstream(format!(
                "Supabase insert failed ({}).",
                status.as_u16()
            )));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|_| ApiError::upstream("Supabase returned invalid JSON."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_requires_both_env_vars() {
        std::env::remove_var("SUPABASE_URL");
        std::env::remove_var("SUPABASE_SERVICE_ROLE_KEY");
        assert!(SupabaseConfig::from_env().is_none());
    }
}
