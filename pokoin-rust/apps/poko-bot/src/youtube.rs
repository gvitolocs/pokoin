//! Poko OAuth and YouTube REST client; no Google SDK/Node process at runtime.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use axum::{
    extract::{Query, State},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use url::Url;

use crate::x_client::env_alias;

const SCOPES: &str = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl";

#[derive(Clone)]
pub struct YoutubeConfig {
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub login_hint: String,
    pub channel_handle: String,
    pub token_path: PathBuf,
    pub token_url: Url,
    pub authorize_url: Url,
    pub api_base: Url,
}

impl YoutubeConfig {
    pub fn from_env(data_dir: &Path) -> anyhow::Result<Self> {
        let redirect = env_alias(&["CITYHOP_YOUTUBE_REDIRECT_URI", "GMAIL_REDIRECT_URI"]);
        let hint = env_alias(&[
            "CITYHOP_YOUTUBE_LOGIN_HINT",
            "GMAIL_HINT_PERSONAL",
            "GOOGLE_OAUTH_LOGIN_HINT",
        ]);
        let path = env_alias(&["POKO_YOUTUBE_TOKEN_PATH"]);
        let handle = env_alias(&["POKO_YOUTUBE_CHANNEL_HANDLE"]);
        Ok(Self {
            client_id: env_alias(&[
                "CITYHOP_YOUTUBE_CLIENT_ID",
                "GMAIL_CLIENT_ID",
                "GOOGLE_OAUTH_CLIENT_ID",
            ]),
            client_secret: env_alias(&[
                "CITYHOP_YOUTUBE_CLIENT_SECRET",
                "GMAIL_CLIENT_SECRET",
                "GOOGLE_OAUTH_CLIENT_SECRET",
            ]),
            // Preserve the live config's Cityhop redirect precedence, including its default.
            redirect_uri: if redirect.is_empty() {
                "http://127.0.0.1:8788/oauth2callback".into()
            } else {
                redirect
            },
            login_hint: if hint.is_empty() {
                "vitologiuseppe17@gmail.com".into()
            } else {
                hint
            },
            channel_handle: if handle.is_empty() {
                "pokoinpos".into()
            } else {
                handle.strip_prefix('@').unwrap_or(&handle).into()
            },
            token_path: if path.is_empty() {
                data_dir.join("youtube-poko-token.json")
            } else {
                std::path::absolute(path)?
            },
            token_url: Url::parse("https://oauth2.googleapis.com/token")?,
            authorize_url: Url::parse("https://accounts.google.com/o/oauth2/v2/auth")?,
            api_base: Url::parse("https://www.googleapis.com/youtube/v3/")?,
        })
    }

    fn validate(&self) -> anyhow::Result<()> {
        if self.client_id.is_empty() || self.client_secret.is_empty() {
            bail!("Poko YouTube OAuth: missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET in Hermes private/cityhop/.env.local");
        }
        if self.redirect_uri.is_empty() {
            bail!("Poko YouTube OAuth: missing redirect URI (set GOOGLE_OAUTH_REDIRECT_URI or CITYHOP_YOUTUBE_REDIRECT_URI, e.g. http://127.0.0.1:8788/oauth2callback)");
        }
        Ok(())
    }

    pub fn authorize_url(&self) -> anyhow::Result<Url> {
        self.validate()?;
        let mut url = self.authorize_url.clone();
        url.query_pairs_mut().extend_pairs([
            ("access_type", "offline"),
            ("prompt", "consent select_account"),
            ("scope", SCOPES),
            ("state", "poko"),
            ("response_type", "code"),
            ("client_id", &self.client_id),
            ("redirect_uri", &self.redirect_uri),
        ]);
        if !self.login_hint.is_empty() {
            url.query_pairs_mut()
                .append_pair("login_hint", &self.login_hint);
        }
        Ok(url)
    }
}

/// Same on-disk JSON as google-auth-library, with owner-only permissions even on replacement.
pub async fn write_token(path: &Path, tokens: &Value) -> anyhow::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = path.to_path_buf();
    let bytes = format!("{}\n", serde_json::to_string_pretty(tokens)?);
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let parent = path.parent().context("token path has no parent")?;
        std::fs::create_dir_all(parent)?;
        // Unique temp file, same filesystem, no symlink-following of the destination.
        let mut entropy = [0u8; 16];
        getrandom::fill(&mut entropy)
            .map_err(|_| anyhow::anyhow!("token file entropy unavailable"))?;
        let suffix = entropy
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let temp = parent.join(format!(".youtube-token-{suffix}.tmp"));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        let result = (|| -> anyhow::Result<()> {
            file.write_all(bytes.as_bytes())?;
            file.sync_all()?;
            std::fs::rename(&temp, &path)?;
            std::fs::File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result
    })
    .await??;
    Ok(())
}

pub async fn read_token(path: &Path) -> anyhow::Result<Option<Value>> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = match tokio::fs::metadata(path).await {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => bail!("Cannot read Poko token at {}", path.display()),
    };
    if metadata.permissions().mode() & 0o077 != 0 {
        bail!("Poko token must have mode 0600: {}", path.display());
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| anyhow::anyhow!("Cannot read Poko token at {}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| anyhow::anyhow!("Cannot read Poko token at {}: invalid JSON", path.display()))
}

pub fn verify_channel(data: &Value, handle: &str) -> anyhow::Result<Value> {
    let items = data["items"].as_array().cloned().unwrap_or_default();
    let handle = handle.to_lowercase();
    let matched = if handle.is_empty() {
        items.first()
    } else {
        items.iter().find(|c| {
            c["snippet"]["customUrl"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains(&handle)
        })
    };
    if !handle.is_empty() && matched.is_none() {
        let names = items
            .iter()
            .map(|c| {
                format!(
                    "{} ({})",
                    c["snippet"]["title"].as_str().unwrap_or("undefined"),
                    c["snippet"]["customUrl"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("no handle")
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        bail!("OAuth token is not @{handle}. Connected channel(s): {}. Re-auth and select the Poko brand account.",if names.is_empty(){"(none)"}else{&names});
    }
    Ok(json!({"channel":matched,"items":items}))
}

pub fn format_oauth_error(message: &str, step: &str, path: &Path, handle: &str) -> String {
    let mut lines = vec![
        format!("Step: {step}"),
        format!("Error: {message}"),
        format!("Token path: {}", path.display()),
    ];
    if !handle.is_empty() {
        lines.push(format!("Channel expected: @{handle}"));
    }
    let lower = message.to_lowercase();
    if lower.contains("insufficient authentication scopes") {
        lines.push("Hint: You may have approved the wrong channel or reused an old code. Run a fresh auth link with state=poko.".into());
    }
    if lower.contains("invalid_grant") {
        lines.push("Hint: Authorization code expired or was used twice. Open a new auth URL and complete login once.".into());
    }
    lines.join("\n")
}

#[derive(Clone)]
pub struct Youtube {
    pub config: YoutubeConfig,
    http: reqwest::Client,
    // Serialize refresh+merge+save across all client clones.
    token_lock: Arc<Mutex<()>>,
}

impl Youtube {
    pub fn new(http: reqwest::Client, config: YoutubeConfig) -> Self {
        Self {
            config,
            http,
            token_lock: Arc::new(Mutex::new(())),
        }
    }

    async fn token_request(&self, fields: &[(&str, &str)]) -> anyhow::Result<Value> {
        self.config.validate()?;
        let response = self
            .http
            .post(self.config.token_url.clone())
            .form(fields)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Google token request transport failed"))?;
        let status = response.status();
        let mut data: Value = response
            .json()
            .await
            .map_err(|_| anyhow::anyhow!("Google token response is not JSON"))?;
        if !status.is_success() {
            // Never include provider body, request URL, authorization code or token in errors.
            let kind = match data["error"].as_str() {
                Some("invalid_grant") => "invalid_grant",
                Some("invalid_client") => "invalid_client",
                _ => "oauth_error",
            };
            bail!("Google OAuth {kind} ({})", status.as_u16());
        }
        if !data["access_token"].as_str().is_some_and(|s| !s.is_empty()) {
            bail!("Google token response missing access_token");
        }
        if let Some(seconds) = data["expires_in"].as_u64() {
            data["expiry_date"] =
                json!(crate::history::now_ms().saturating_add(seconds.saturating_mul(1000)));
            data.as_object_mut()
                .context("Google token response is not an object")?
                .remove("expires_in");
        }
        Ok(data)
    }

    pub async fn exchange_code(&self, code: &str) -> anyhow::Result<Value> {
        let code = code.trim();
        if code.is_empty() {
            bail!("Missing OAuth authorization code");
        }
        let _guard = self.token_lock.lock().await;
        let tokens = self
            .token_request(&[
                ("code", code),
                ("client_id", &self.config.client_id),
                ("client_secret", &self.config.client_secret),
                ("redirect_uri", &self.config.redirect_uri),
                ("grant_type", "authorization_code"),
            ])
            .await
            .context("Google token exchange failed")?;
        write_token(&self.config.token_path, &tokens)
            .await
            .context("Saving Poko token failed")?;
        // Save before verification, just as the live Node does.
        let data = self
            .raw_request(
                Method::GET,
                "channels",
                &[
                    ("part", "snippet,id"),
                    ("mine", "true"),
                    ("maxResults", "50"),
                ],
                None,
                tokens["access_token"].as_str().unwrap_or(""),
            )
            .await
            .context("YouTube channel check failed")?;
        let verified = verify_channel(&data, &self.config.channel_handle)
            .context("YouTube channel check failed")?;
        let channel = &verified["channel"];
        let channels: Vec<_> = verified["items"].as_array().into_iter().flatten().map(|c|json!({"id":c["id"],"title":c["snippet"]["title"],"customUrl":c["snippet"]["customUrl"]})).collect();
        Ok(
            json!({"channelId":channel["id"],"title":channel["snippet"]["title"],"customUrl":channel["snippet"]["customUrl"],"channels":channels,"tokenPath":self.config.token_path}),
        )
    }

    async fn access_token(&self, force_refresh: bool) -> anyhow::Result<String> {
        let _guard = self.token_lock.lock().await;
        let mut tokens = read_token(&self.config.token_path)
            .await?
            .with_context(|| {
                format!(
                    "Poko YouTube not connected (no token at {}). Run: poko-bot youtube-auth",
                    self.config.token_path.display()
                )
            })?;
        let access = tokens["access_token"].as_str().unwrap_or("");
        let expiring = tokens["expiry_date"]
            .as_u64()
            .is_some_and(|at| at <= crate::history::now_ms().saturating_add(300_000));
        if !force_refresh && !access.is_empty() && !expiring {
            return Ok(access.into());
        }
        let refresh = tokens["refresh_token"]
            .as_str()
            .context("Poko YouTube token has no refresh_token")?;
        let fresh = self
            .token_request(&[
                ("refresh_token", refresh),
                ("client_id", &self.config.client_id),
                ("client_secret", &self.config.client_secret),
                ("grant_type", "refresh_token"),
            ])
            .await?;
        tokens = merge_tokens(&tokens, &fresh)?;
        write_token(&self.config.token_path, &tokens).await?;
        tokens["access_token"]
            .as_str()
            .map(str::to_string)
            .context("Poko token missing access_token")
    }

    async fn raw_request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
        token: &str,
    ) -> anyhow::Result<Value> {
        let mut req = self
            .http
            .request(method, self.config.api_base.join(path)?)
            .query(query)
            .bearer_auth(token)
            .timeout(Duration::from_secs(60));
        if let Some(body) = body {
            req = req.json(body);
        }
        let response = req
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("YouTube transport failed"))?;
        let status = response.status();
        let data: Value = response
            .json()
            .await
            .map_err(|_| anyhow::anyhow!("YouTube response is not JSON"))?;
        if !status.is_success() {
            let reason = data["error"]["errors"][0]["reason"]
                .as_str()
                .unwrap_or("unknown");
            // Return only an allowlisted reason, never an arbitrary body that might echo credentials.
            let safe = match reason {
                "commentsDisabled"
                | "quotaExceeded"
                | "forbidden"
                | "videoNotFound"
                | "insufficientPermissions" => reason,
                _ => "api_error",
            };
            return Err(YoutubeError {
                status: status.as_u16(),
                reason: safe.into(),
            }
            .into());
        }
        Ok(data)
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> anyhow::Result<Value> {
        let token = self.access_token(false).await?;
        let result = self
            .raw_request(method.clone(), path, query, body, &token)
            .await;
        if result
            .as_ref()
            .err()
            .and_then(|e| e.downcast_ref::<YoutubeError>())
            .is_some_and(|e| e.status == 401)
        {
            let token = self.access_token(true).await?;
            return self.raw_request(method, path, query, body, &token).await;
        }
        result
    }
}

#[derive(Debug, thiserror::Error)]
#[error("YouTube API failed {status}: {reason}")]
pub struct YoutubeError {
    pub status: u16,
    pub reason: String,
}

/// Used by the native poller to isolate the production failure to its video.
pub fn comments_unavailable(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<YoutubeError>()
        .is_some_and(|e| e.reason == "commentsDisabled" || e.reason == "videoNotFound")
}

pub fn router(youtube: Arc<Youtube>) -> Router {
    Router::new()
        .route("/oauth2callback", get(callback))
        .with_state(youtube)
}

fn error_html(config: &YoutubeConfig, title: &str, message: &str, step: &str) -> String {
    let detail = format_oauth_error(message, step, &config.token_path, &config.channel_handle);
    [
        "<html><body style=\"font-family:sans-serif;max-width:42rem;margin:2rem\">".to_string(),
        format!("<h1>{title}</h1>"),
        "<pre style=\"background:#f4f4f4;padding:1rem;white-space:pre-wrap\">".into(),
        detail.replace('<', "&lt;"),
        "</pre>".into(),
        "<p>CLI fallback (paste code from address bar):</p>".into(),
        "<pre style=\"background:#f4f4f4;padding:1rem\">".into(),
        "poko-bot youtube-auth --code-file /path/to/0600-code-file".into(),
        "</pre>".into(),
        "</body></html>".into(),
    ]
    .join("\n")
}

async fn callback(
    State(youtube): State<Arc<Youtube>>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let config = &youtube.config;
    let error = |status, title, message: &str, step| {
        (status, Html(error_html(config, title, message, step))).into_response()
    };
    if let Some(state) = query.get("state").filter(|s| !s.is_empty() && *s != "poko") {
        return error(
            StatusCode::BAD_REQUEST,
            "Wrong OAuth state",
            &format!("Expected state=poko, got state={state}"),
            "callback",
        );
    }
    if let Some(denied) = query.get("error").filter(|s| !s.is_empty()) {
        // Google errors are public callback parameters, not token response bodies.
        return error(
            StatusCode::BAD_REQUEST,
            "Poko YouTube auth denied",
            denied,
            "callback",
        );
    }
    let Some(code) = query.get("code").filter(|s| !s.is_empty()) else {
        let start_url = config
            .authorize_url()
            .map(|u| u.to_string())
            .unwrap_or_default();
        return (StatusCode::BAD_REQUEST,Html([
            "<html><body>".to_string(),"<h1>Poko YouTube auth — start here</h1>".into(),
            "<p>This page only works <strong>after</strong> Google redirects you here with <code>?code=...</code> in the URL.</p>".into(),
            if start_url.is_empty(){String::new()}else{format!("<p><a href=\"{start_url}\">Start YouTube login for Poko</a></p>")},
            "<p>When Google asks, choose the <strong>Poko</strong> channel (not Cityhop or Griffin).</p>".into(),"</body></html>".into()].join(""))).into_response();
    };
    match youtube.exchange_code(code).await {
        Ok(result) => {
            let s = |v: &Value| v.as_str().unwrap_or("no handle").to_string();
            let channels = result["channels"].as_array().cloned().unwrap_or_default();
            let list = channels
                .iter()
                .map(|c| format!("<li>{} ({})</li>", s(&c["title"]), s(&c["customUrl"])))
                .collect::<String>();
            Html(["<html><body style=\"font-family:sans-serif;max-width:42rem;margin:2rem\">".to_string(),"<h1>Poko YouTube connected</h1>".into(),
                format!("<p>Connected channel: <strong>{}</strong> ({})</p>",s(&result["title"]),s(&result["customUrl"])),
                if channels.len()>1{format!("<p>Channels on this account:<ul>{list}</ul></p>")}else{String::new()},
                "<p>Poko will use this OAuth token for reading and replying to comments. If this is the wrong channel, re-run <code>poko-bot youtube-auth</code> and pick the Poko channel.</p>".into(),"</body></html>".into()].join("")).into_response()
        }
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Poko YouTube auth failed",
            &format!("{e:#}"),
            "exchangePokoYoutubeCode",
        ),
    }
}

/// Shared by the daemon's opt-in listener and the standalone OAuth command.
pub fn listener_addr(raw: &str) -> anyhow::Result<std::net::SocketAddr> {
    let addr: std::net::SocketAddr = raw.parse().context("invalid POKO_BOT_OAUTH_ADDR")?;
    anyhow::ensure!(
        addr.ip().is_loopback(),
        "POKO_BOT_OAUTH_ADDR must bind loopback"
    );
    Ok(addr)
}

/// google-auth-library emits partial token updates; preserve a usable refresh
/// credential when an update omits it or supplies an empty value.
pub fn merge_tokens(previous: &Value, fresh: &Value) -> anyhow::Result<Value> {
    let mut merged = previous
        .as_object()
        .context("Poko token is not an object")?
        .clone();
    for (key, value) in fresh
        .as_object()
        .context("Google token response is not an object")?
    {
        if key == "refresh_token" && value.as_str().is_none_or(|s| s.is_empty()) {
            continue;
        }
        merged.insert(key.clone(), value.clone());
    }
    Ok(Value::Object(merged))
}
