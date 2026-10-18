//! GET /api/extension-download: the Pokoin Chrome extension zip, for signed-in
//! Silver accounts only.
//!
//! The zip is never a public asset (not the Cloudflare static assets, not the
//! CDN). It lives in a private directory on the API host,
//! `POKOIN_EXTENSION_DIR` (default `/srv/pokoin/extension`), as
//! `pokoin-extension-<version>.zip`; the highest version is served. The nezopt
//! overflow pods mount an rsynced copy of the Pi's directory at the same path
//! (`scripts/nezopt-k3s.sh`).
//!
//! 401 without a valid Firebase ID token, 403 when the account is not Silver
//! (the site rule, `market/src/auth-profile.js` `profileFrom`: admin, role
//! `silver`, or `silverUntil` in the future), 404 while no zip is published.

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use serde_json::Value;
use tokio_util::io::ReaderStream;

use crate::error::ApiError;
use crate::state::{AuthedUser, DomainState};
use crate::store;

pub const DEFAULT_EXTENSION_DIR: &str = "/srv/pokoin/extension";
const ZIP_PREFIX: &str = "pokoin-extension-";
const ZIP_SUFFIX: &str = ".zip";

/// The private directory the zips are read from.
pub fn extension_dir() -> PathBuf {
    std::env::var("POKOIN_EXTENSION_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_EXTENSION_DIR))
}

/// A Firestore date as epoch ms: the decoded RFC 3339 string, epoch ms, or
/// `{seconds}` (`readDate` in auth-profile.js).
fn date_ms(value: &Value) -> Option<i64> {
    match value {
        Value::String(text) => chrono::DateTime::parse_from_rfc3339(text.trim())
            .ok()
            .map(|date| date.timestamp_millis()),
        Value::Number(number) => number.as_f64().map(|ms| ms as i64),
        Value::Object(object) => object
            .get("seconds")
            .and_then(Value::as_f64)
            .map(|seconds| (seconds * 1000.0) as i64),
        _ => None,
    }
}

/// `profileFrom(users/{uid}).silver`: admin, role `silver`, or an unexpired
/// `silverUntil`.
pub fn profile_is_silver(profile: &Value, now_ms: i64) -> bool {
    let role = profile
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let roles_admin = profile
        .get("roles")
        .and_then(Value::as_array)
        .map(|roles| {
            roles
                .iter()
                .filter_map(Value::as_str)
                .any(|row| row.eq_ignore_ascii_case("admin"))
        })
        .unwrap_or(false);
    let admin = profile.get("admin") == Some(&Value::Bool(true))
        || profile.get("isAdmin") == Some(&Value::Bool(true))
        || role == "admin"
        || roles_admin;
    let until = profile.get("silverUntil").and_then(date_ms);
    admin || role == "silver" || until.map(|ms| ms > now_ms).unwrap_or(false)
}

/// `12.0.72` from `pokoin-extension-12.0.72.zip`, as comparable parts.
fn zip_version(name: &str) -> Option<(Vec<u64>, String)> {
    let version = name.strip_prefix(ZIP_PREFIX)?.strip_suffix(ZIP_SUFFIX)?;
    let parts = version
        .split('.')
        .map(|part| part.parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    if parts.is_empty() {
        return None;
    }
    Some((parts, version.to_string()))
}

/// The highest-version `pokoin-extension-<version>.zip` file in `dir`.
pub fn latest_zip(dir: &Path) -> Option<(String, PathBuf)> {
    let entries = std::fs::read_dir(dir).ok()?;
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            zip_version(&name).map(|(parts, version)| (parts, version, entry.path()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, version, path)| (version, path))
}

pub async fn extension_download(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
) -> Result<Response, ApiError> {
    let silver = claims.has_admin_access() || {
        let profile = store::read_user(state.firestore()?, &claims.uid).await?;
        profile_is_silver(&profile, state.now_ms())
    };
    if !silver {
        return Err(ApiError::forbidden("Pokoin Silver is required to download the extension.")
            .with_code("extension/silver-required"));
    }
    let dir = extension_dir();
    let (version, path) = tokio::task::spawn_blocking(move || latest_zip(&dir))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| ApiError::not_found("The extension download is not published yet."))?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError::not_found("The extension download is not published yet."))?;
    let length = file.metadata().await.map(|meta| meta.len()).ok();

    let mut response = Response::new(Body::from_stream(ReaderStream::new(file)));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/zip"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    if let Ok(value) = HeaderValue::from_str(&format!(
        "attachment; filename=\"pokoin-extension-{version}.zip\""
    )) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    if let Ok(value) = HeaderValue::from_str(&version) {
        headers.insert("x-pokoin-extension-version", value);
    }
    if let Some(length) = length {
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn silver_follows_the_site_profile_rule() {
        assert!(!profile_is_silver(&json!({}), NOW));
        assert!(!profile_is_silver(&json!({"role": "member"}), NOW));
        assert!(profile_is_silver(&json!({"role": "Silver"}), NOW));
        assert!(profile_is_silver(&json!({"admin": true}), NOW));
        assert!(profile_is_silver(&json!({"isAdmin": true}), NOW));
        assert!(profile_is_silver(&json!({"role": "admin"}), NOW));
        assert!(profile_is_silver(&json!({"roles": ["user", "ADMIN"]}), NOW));
        assert!(!profile_is_silver(&json!({"admin": "yes"}), NOW));
    }

    #[test]
    fn silver_until_must_be_in_the_future() {
        let future = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(NOW + 60_000)
            .unwrap()
            .to_rfc3339();
        let past = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(NOW - 60_000)
            .unwrap()
            .to_rfc3339();
        assert!(profile_is_silver(&json!({"silverUntil": future}), NOW));
        assert!(!profile_is_silver(&json!({"silverUntil": past}), NOW));
        assert!(profile_is_silver(&json!({"silverUntil": NOW + 1}), NOW));
        assert!(profile_is_silver(&json!({"silverUntil": {"seconds": NOW / 1000 + 60}}), NOW));
        assert!(!profile_is_silver(&json!({"silverUntil": "not a date"}), NOW));
    }

    #[test]
    fn latest_zip_picks_the_highest_version() {
        let dir = std::env::temp_dir().join(format!("pokoin-ext-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "pokoin-extension-12.0.9.zip",
            "pokoin-extension-12.0.72.zip",
            "pokoin-extension-12.0.10.zip",
            "pokoin-extension-latest.zip",
            "other.zip",
        ] {
            std::fs::write(dir.join(name), b"zip").unwrap();
        }
        let (version, path) = latest_zip(&dir).unwrap();
        assert_eq!(version, "12.0.72");
        assert!(path.ends_with("pokoin-extension-12.0.72.zip"));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(latest_zip(&dir).is_none());
    }
}
