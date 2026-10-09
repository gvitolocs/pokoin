//! External calls of `pokoin-assistant.js` and `trainingai-card-classify.js`:
//! the Pokontact peer service (`/chat`, `/observe`), the Reddit community
//! sentiment lookup, the team email handoff (Resend via
//! `pokoin_accounts::email`), the in-memory assistant rate limit and the
//! `limitBestEffort` Redis limiter of `api/_rate_limit.js`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::assistant::context::page_context_for_prompt;
use crate::assistant::intent::classify_intent;
use crate::assistant::text::{clean_text, escape_html};
use pokoin_api_common::RouteState;

pub const DEFAULT_POKONTACT_SERVICE_URL: &str = "http://10.0.0.170:8789/api/poko";

/// `resolvePokontactServiceUrl`.
pub fn resolve_pokontact_service_url() -> String {
    let configured = std::env::var("POKONTACT_SERVICE_URL")
        .unwrap_or_default()
        .trim()
        .to_owned();
    let url = if configured.is_empty() {
        DEFAULT_POKONTACT_SERVICE_URL.to_owned()
    } else {
        configured
    };
    url.trim_end_matches('/').to_owned()
}

/// `POKONTACT_SERVICE_TOKEN || HERMES_POKO_API_TOKEN || POKO_API_TOKEN`.
pub fn pokontact_service_token() -> String {
    [
        "POKONTACT_SERVICE_TOKEN",
        "HERMES_POKO_API_TOKEN",
        "POKO_API_TOKEN",
    ]
    .iter()
    .find_map(|key| std::env::var(key).ok())
    .unwrap_or_default()
    .trim()
    .to_owned()
}

/// `POKONTACT_SERVICE_TIMEOUT_MS` (`0` = no budget for `/chat`).
pub fn pokontact_service_timeout_ms() -> u64 {
    std::env::var("POKONTACT_SERVICE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| value.max(0.0) as u64)
        .unwrap_or(0)
}

/// `ADMIN_TO` / `ASSISTANT_FROM` of the email handoff.
pub fn admin_to() -> String {
    std::env::var("POKOIN_ASSISTANT_EMAIL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "pokoinpos@gmail.com".to_owned())
}

pub fn assistant_from() -> String {
    std::env::var("POKOIN_ASSISTANT_FROM")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Poko <poko@pokoin.com>".to_owned())
}

/// `userFromRequest`: bearer -> Firebase verify + Firestore profile, else guest.
pub async fn user_from_request(
    state: &RouteState,
    headers: &axum::http::HeaderMap,
    body: &Value,
) -> Map<String, Value> {
    let fallback = |username: String| {
        let mut user = Map::new();
        user.insert("uid".into(), json!(""));
        user.insert(
            "username".into(),
            json!(if username.is_empty() {
                "guest".to_owned()
            } else {
                username
            }),
        );
        user.insert("email".into(), json!(""));
        user
    };
    let Some(token) = pokoin_api_common::http::bearer(headers) else {
        return fallback(clean_text(
            &body.get("username").cloned().unwrap_or(Value::Null),
            80,
        ));
    };
    let claims = match state.accounts.verifier().verify(&token).await {
        Ok(claims) => claims,
        Err(_) => {
            return fallback(clean_text(
                &body.get("username").cloned().unwrap_or(Value::Null),
                80,
            ))
        }
    };
    let profile = match state.accounts.firestore() {
        Ok(firestore) => firestore
            .collection_doc("users", &claims.uid)
            .get()
            .await
            .ok()
            .flatten()
            .map(|document| document.to_plain_json())
            .unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    let profile_username = profile.get("username").cloned().unwrap_or(Value::Null);
    let username_source = if !profile_username.is_null() && profile_username.as_str().is_some() {
        profile_username
    } else {
        let claims_name = claims.name.trim();
        if claims_name.is_empty() {
            body.get("username").cloned().unwrap_or(Value::Null)
        } else {
            json!(claims_name)
        }
    };
    let username = clean_text(&username_source, 80);
    let profile_email = profile.get("email").cloned().unwrap_or(Value::Null);
    let email_source = if !profile_email.is_null() && profile_email.as_str().is_some() {
        profile_email
    } else {
        json!(claims.email.trim())
    };
    let email = clean_text(&email_source, 160);
    let mut user = Map::new();
    user.insert("uid".into(), json!(claims.uid));
    user.insert(
        "username".into(),
        json!(if username.is_empty() {
            "Pokoin user".to_owned()
        } else {
            username
        }),
    );
    user.insert("email".into(), json!(email));
    user
}

/// `assistantRateLimited`: in-process sliding window, 20 messages / 60 s / IP.
pub fn assistant_rate_limited(ip: &str) -> bool {
    static HITS: OnceLock<Mutex<HashMap<String, Vec<i64>>>> = OnceLock::new();
    let hits = HITS.get_or_init(|| Mutex::new(HashMap::new()));
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let mut guard = match hits.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let fresh: Vec<i64> = guard
        .get(ip)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|stamp| now_ms - stamp < 60_000)
        .collect();
    if fresh.len() >= 20 {
        guard.insert(ip.to_owned(), fresh);
        return true;
    }
    let mut updated = fresh;
    updated.push(now_ms);
    guard.insert(ip.to_owned(), updated);
    false
}

/// `x-forwarded-for` first hop, else the Node `unknown` fallback.
pub fn identity_from_headers(headers: &axum::http::HeaderMap) -> String {
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let first = forwarded.split(',').next().unwrap_or("").trim();
    if first.is_empty() {
        "unknown".to_owned()
    } else {
        first.to_owned()
    }
}

/// Failure of the Pokontact `/chat` call: the Node code maps aborts to a
/// dedicated message and everything else to `error.message`.
pub enum PokontactError {
    Timeout,
    Message(String),
}

impl PokontactError {
    /// `{ok: false, error: ...}` of the handler catch.
    pub fn to_error_value(&self) -> Value {
        match self {
            Self::Timeout => json!({ "ok": false, "error": "Pokontact service timed out." }),
            Self::Message(message) => json!({ "ok": false, "error": message }),
        }
    }
}

/// `callPokontactService` — `Ok(Value::Null)` when the token is missing.
pub async fn call_pokontact_service(
    state: &RouteState,
    message: &str,
    chat_record: &[(String, String)],
    user: &Map<String, Value>,
    page: &str,
    page_context: &Map<String, Value>,
    user_preferences: &Map<String, Value>,
) -> Result<Value, PokontactError> {
    let token = pokontact_service_token();
    if token.is_empty() {
        return Ok(Value::Null);
    }
    let user_json = Value::Object(user.clone());
    let payload = json!({
        "message": message,
        "messages": crate::assistant::intent::chat_record_json(chat_record),
        "deferMemory": true,
        "userId": user.get("uid").and_then(Value::as_str).unwrap_or(""),
        "sessionId": user.get("sessionId").and_then(Value::as_str).unwrap_or(""),
        "user": user_json,
        "page": page,
        "pageContext": Value::Object(page_context.clone()),
        "context": page_context_for_prompt(page_context),
        "marketplaceContext": { "userPreferences": Value::Object(user_preferences.clone()) },
    });
    let url = format!("{}/chat", resolve_pokontact_service_url());
    let request = state
        .api
        .http()
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .json(&payload);
    let response = match pokontact_service_timeout_ms() {
        0 => request.send().await,
        budget => match tokio::time::timeout(Duration::from_millis(budget), request.send()).await {
            Ok(result) => result,
            Err(_) => return Err(PokontactError::Timeout),
        },
    };
    let response = response.map_err(|error| PokontactError::Message(error.to_string()))?;
    let status = response.status();
    let payload: Value = response.json().await.unwrap_or(json!({}));
    if !status.is_success() {
        let message = payload
            .get("error")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or(&format!("Pokontact service returned {}.", status.as_u16()))
            .to_owned();
        return Err(PokontactError::Message(message));
    }
    let Some(reply) = payload.get("reply").and_then(Value::as_str) else {
        return Err(PokontactError::Message(
            "Pokontact service returned an invalid reply.".to_owned(),
        ));
    };
    let intent = clean_text(payload.get("intent").unwrap_or(&Value::Null), 40);
    let source = clean_text(payload.get("source").unwrap_or(&Value::Null), 80);
    Ok(json!({
        "reply": clean_text(&json!(reply), 5000),
        "intent": if intent.is_empty() { json!(classify_intent(message)) } else { json!(intent) },
        "provider": clean_text(payload.get("provider").unwrap_or(&Value::Null), 80),
        "model": clean_text(payload.get("model").unwrap_or(&Value::Null), 120),
        "source": if source.is_empty() { json!("poko-peer1") } else { json!(source) },
        "actions": crate::assistant::grounding::safe_assistant_actions(
            &payload.get("actions").cloned().unwrap_or(Value::Null),
        ),
    }))
}

/// `recordPokontactTurn` — the `/observe` conversation-memory write.
pub async fn record_pokontact_turn(
    state: &RouteState,
    message: &str,
    reply: &str,
    user: &Map<String, Value>,
    page_context: &Map<String, Value>,
    intent: &str,
    service_delivery: Option<&Value>,
) -> Value {
    let token = pokontact_service_token();
    if token.is_empty() {
        return json!({
            "ok": false,
            "skipped": true,
            "reason": "POKONTACT_SERVICE_TOKEN is not configured.",
        });
    }
    let configured_timeout = {
        let value = pokontact_service_timeout_ms();
        if value > 0 {
            value
        } else {
            4000
        }
    };
    let budget = configured_timeout.min(4000);
    let service_source = service_delivery
        .and_then(|delivery| delivery.get("source"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let service_provider = service_delivery
        .and_then(|delivery| delivery.get("provider"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let page_kind = clean_text(page_context.get("kind").unwrap_or(&Value::Null), 80);
    let page_path = clean_text(&context_or(page_context, "internalUri", "path"), 300);
    let payload = json!({
        "message": clean_text(&json!(message), 3000),
        "reply": clean_text(&json!(reply), 5000),
        "userId": user.get("uid").and_then(Value::as_str).unwrap_or(""),
        "sessionId": user.get("sessionId").and_then(Value::as_str).unwrap_or(""),
        "user": {
            "uid": clean_text(user.get("uid").unwrap_or(&Value::Null), 160),
            "identityKey": clean_text(user.get("identityKey").unwrap_or(&Value::Null), 160),
            "sessionId": clean_text(user.get("sessionId").unwrap_or(&Value::Null), 160),
        },
        "metadata": {
            "intent": clean_text(&json!(intent), 80),
            "source": if service_source.is_empty() { json!("pokoin-web-gateway") } else { json!(service_source) },
            "provider": json!(service_provider),
            "pageKind": json!(page_kind),
            "pagePath": json!(page_path),
        },
    });
    let url = format!("{}/observe", resolve_pokontact_service_url());
    let request = state
        .api
        .http()
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .json(&payload);
    let response = match tokio::time::timeout(Duration::from_millis(budget), request.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return json!({
                "ok": false,
                "saved": false,
                "error": clean_text(&json!(error.to_string()), 160),
            });
        }
        Err(_) => {
            return json!({
                "ok": false,
                "saved": false,
                "error": "conversation save timed out",
            });
        }
    };
    let status = response.status();
    let payload: Value = response.json().await.unwrap_or(json!({}));
    if status.is_success() && payload.get("saved").and_then(Value::as_bool) == Some(true) {
        json!({ "ok": true, "saved": true, "source": "poko-honcho" })
    } else {
        let error = clean_text(payload.get("error").unwrap_or(&Value::Null), 160);
        json!({
            "ok": false,
            "saved": false,
            "status": status.as_u16(),
            "error": if error.is_empty() { json!("conversation save failed") } else { json!(error) },
        })
    }
}

fn context_or(context: &Map<String, Value>, first: &str, second: &str) -> Value {
    let first_value = context.get(first).cloned().unwrap_or(Value::Null);
    let truthy = !first_value.is_null()
        && first_value
            .as_str()
            .map(|text| !text.is_empty())
            .unwrap_or(true);
    if truthy {
        first_value
    } else {
        context.get(second).cloned().unwrap_or(Value::Null)
    }
}

/// `forwardToTeam` — the inquiry email through the Resend provider of
/// `_email.js` (via `pokoin_accounts::email`).
pub async fn forward_to_team(
    state: &RouteState,
    message: &str,
    chat_record: &[(String, String)],
    user: &Map<String, Value>,
    page: &str,
) -> Value {
    let username = user.get("username").and_then(Value::as_str).unwrap_or("");
    let uid = user.get("uid").and_then(Value::as_str).unwrap_or("");
    let email = user.get("email").and_then(Value::as_str).unwrap_or("");
    let subject = format!(
        "Pokontact {} from {}",
        classify_intent(message),
        if username.is_empty() {
            "guest"
        } else {
            username
        }
    );
    let transcript = if !chat_record.is_empty() {
        chat_record
            .iter()
            .map(|(role, text)| {
                format!(
                    "{}: {}",
                    if role == "user" { "User" } else { "Pokontact" },
                    text
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    } else {
        format!("User: {message}")
    };
    let now_iso = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let lines = [
        "Pokontact detected a likely inquiry or bug report.".to_owned(),
        String::new(),
        format!(
            "Username: {}",
            if username.is_empty() {
                "guest"
            } else {
                username
            }
        ),
        format!("UID: {}", if uid.is_empty() { "-" } else { uid }),
        format!("Email: {}", if email.is_empty() { "-" } else { email }),
        format!("Page: {}", if page.is_empty() { "-" } else { page }),
        String::new(),
        "Latest message:".to_owned(),
        message.to_owned(),
        String::new(),
        "Chat record:".to_owned(),
        transcript.clone(),
        String::new(),
        format!("Time: {now_iso}"),
    ];
    let text = lines.join("\n");
    let html = format!(
        r#"
      <div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#0f172a">
        <h1 style="margin:0 0 16px">Pokontact user message</h1>
        <ul>
          <li><strong>Username:</strong> {}</li>
          <li><strong>UID:</strong> {}</li>
          <li><strong>Email:</strong> {}</li>
          <li><strong>Page:</strong> {}</li>
        </ul>
        <h2 style="margin:20px 0 8px">Latest message</h2>
        <pre style="white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:12px">{}</pre>
        <h2 style="margin:20px 0 8px">Chat record</h2>
        <pre style="white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:12px">{}</pre>
      </div>
    "#,
        escape_html(if username.is_empty() {
            "guest"
        } else {
            username
        }),
        escape_html(if uid.is_empty() { "-" } else { uid }),
        escape_html(if email.is_empty() { "-" } else { email }),
        escape_html(if page.is_empty() { "-" } else { page }),
        escape_html(message),
        escape_html(&transcript),
    );
    let delivery = state
        .accounts
        .emails()
        .send(pokoin_accounts::email::EmailMessage {
            from: assistant_from(),
            to: admin_to(),
            subject,
            html,
            text,
        })
        .await;
    match delivery {
        Ok(sent) => {
            let mut value = Map::new();
            value.insert("ok".into(), json!(sent.ok));
            if let Some(id) = sent.id {
                value.insert("id".into(), json!(id));
            }
            if sent.skipped {
                value.insert("skipped".into(), json!(true));
            }
            if let Some(reason) = sent.reason {
                value.insert("reason".into(), json!(reason));
            }
            Value::Object(value)
        }
        Err(error) => json!({ "ok": false, "error": error.message() }),
    }
}

const COMMUNITY_SENTIMENT_TTL: Duration = Duration::from_secs(10 * 60);
const COMMUNITY_SENTIMENT_TIMEOUT_MS: u64 = 1800;

fn community_sentiment_cache() -> &'static Mutex<Vec<(String, std::time::Instant, Value)>> {
    static CACHE: OnceLock<Mutex<Vec<(String, std::time::Instant, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

fn sentiment_unavailable() -> Value {
    json!({ "available": false, "limited": true, "signal": "" })
}

/// `fetchCommunitySentiment` — Reddit search with a 10-minute process cache.
pub async fn fetch_community_sentiment(state: &RouteState, query: &str) -> Value {
    if query.is_empty() {
        return sentiment_unavailable();
    }
    let cache_key = crate::assistant::text::normalize_intent_text(query);
    {
        let cache = match community_sentiment_cache().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some((_, created, value)) = cache.iter().find(|(key, _, _)| *key == cache_key) {
            if created.elapsed() < COMMUNITY_SENTIMENT_TTL {
                return value.clone();
            }
        }
    }
    let url = format!(
        "https://www.reddit.com/search.json?q={}&sort=relevance&t=year&limit=8",
        crate::assistant::context::form_encode_component(query)
    );
    let request = state
        .api
        .http()
        .get(&url)
        .header("accept", "application/json")
        .header(
            "user-agent",
            "PokoinAssistant/1.0 (public collector sentiment lookup)",
        );
    let result = tokio::time::timeout(
        Duration::from_millis(COMMUNITY_SENTIMENT_TIMEOUT_MS),
        request.send(),
    )
    .await;
    let value = match result {
        Ok(Ok(response)) if response.status().is_success() => {
            let payload: Value = response.json().await.unwrap_or(json!({}));
            let posts = payload
                .get("data")
                .and_then(|data| data.get("children"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let (available, limited, signal) =
                crate::assistant::intent::summarize_community_sentiment(&posts);
            json!({ "available": available, "limited": limited, "signal": signal })
        }
        _ => sentiment_unavailable(),
    };
    let mut cache = match community_sentiment_cache().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(entry) = cache.iter_mut().find(|(key, _, _)| *key == cache_key) {
        entry.1 = std::time::Instant::now();
        entry.2 = value.clone();
    } else {
        cache.push((cache_key, std::time::Instant::now(), value.clone()));
    }
    while cache.len() > 40 {
        cache.remove(0);
    }
    value
}

// ---------------------------------------------------------------------------
// api/_rate_limit.js — limitBestEffort (used by trainingai-card-classify)
// ---------------------------------------------------------------------------

/// `cleanScope`.
pub fn clean_scope(scope: &str) -> String {
    let lowered = scope.trim().to_lowercase();
    let mut cleaned = String::with_capacity(lowered.len());
    let mut last_dash = false;
    for c in lowered.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
            cleaned.push(c);
            last_dash = false;
        } else if !last_dash {
            // `[^a-z0-9_-]+` collapses to a single '-'.
            cleaned.push('-');
            last_dash = true;
        }
    }
    let trimmed: String = cleaned.chars().take(40).collect();
    if trimmed.is_empty() {
        "scope".to_owned()
    } else {
        trimmed
    }
}

/// `identityHash`: first 32 hex chars of sha256.
pub fn identity_hash(identity: &str) -> String {
    let digest = Sha256::digest(identity.as_bytes());
    let hex = hex::encode(digest);
    hex.chars().take(32).collect()
}

/// `rateLimitBucket` with the `_redis_ns.js` `pokoin:rl:v1` prefix.
pub fn rate_limit_bucket(scope: &str, identity: &str) -> String {
    format!(
        "pokoin:rl:v1:{}:{}",
        clean_scope(scope),
        identity_hash(identity)
    )
}

const INCR_WINDOW_SCRIPT: &str = r"
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
";

fn local_rate_windows() -> &'static Mutex<HashMap<String, (i64, i64)>> {
    static WINDOWS: OnceLock<Mutex<HashMap<String, (i64, i64)>>> = OnceLock::new();
    WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `localConsume`: bounded in-process fixed window fallback.
fn local_consume(bucket: &str, limit: i64, window_seconds: u64) -> i64 {
    let window_ms = window_seconds.max(1) * 1000;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let window_start = now_ms / window_ms as i64;
    let mut guard = match local_rate_windows().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let count = {
        let entry = guard.get(bucket);
        match entry {
            Some((start, count)) if *start == window_start => count + 1,
            _ => 1,
        }
    };
    guard.insert(bucket.to_owned(), (window_start, count));
    // Keep the fallback table bounded like the Node helper.
    if guard.len() >= 10_000 {
        guard.retain(|_, (start, _)| *start >= window_start);
        while guard.len() >= 10_000 {
            let oldest = guard.keys().next().cloned();
            match oldest {
                Some(key) => {
                    guard.remove(&key);
                }
                None => break,
            }
        }
    }
    let _ = limit;
    count
}

/// `limitBestEffort`: Redis fixed window, fail-open to the local fallback.
pub async fn limit_best_effort(
    state: &RouteState,
    scope: &str,
    identity: &str,
    limit: i64,
    window_seconds: u64,
) -> Value {
    let bucket = rate_limit_bucket(scope, identity);
    let window = window_seconds.max(1);
    let max = limit.max(1);
    if let Some(mut connection) = state.api.redis().await {
        let count: Option<i64> = redis::cmd("EVAL")
            .arg(INCR_WINDOW_SCRIPT)
            .arg(1)
            .arg(&bucket)
            .arg(window.to_string())
            .query_async(&mut connection)
            .await
            .ok();
        if let Some(count) = count {
            let allowed = count <= max;
            return json!({
                "allowed": allowed,
                "backend": "redis",
                "count": count,
                "retryAfterSec": if allowed { 0 } else { window },
            });
        }
    }
    let local_count = local_consume(&bucket, max, window);
    let allowed = local_count <= max;
    json!({
        "allowed": allowed,
        "backend": "local",
        "count": local_count,
        "retryAfterSec": if allowed { 0 } else { window },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pokontact_url_and_token_envs() {
        std::env::remove_var("POKONTACT_SERVICE_URL");
        assert_eq!(
            resolve_pokontact_service_url(),
            DEFAULT_POKONTACT_SERVICE_URL
        );
        std::env::set_var("POKONTACT_SERVICE_URL", "http://example:1234/api/poko///");
        assert_eq!(
            resolve_pokontact_service_url(),
            "http://example:1234/api/poko"
        );
        std::env::remove_var("POKONTACT_SERVICE_URL");
    }

    #[test]
    fn timeout_default_is_zero() {
        std::env::remove_var("POKONTACT_SERVICE_TIMEOUT_MS");
        assert_eq!(pokontact_service_timeout_ms(), 0);
        std::env::set_var("POKONTACT_SERVICE_TIMEOUT_MS", "2500");
        assert_eq!(pokontact_service_timeout_ms(), 2500);
        std::env::set_var("POKONTACT_SERVICE_TIMEOUT_MS", "0");
        assert_eq!(pokontact_service_timeout_ms(), 0);
        std::env::remove_var("POKONTACT_SERVICE_TIMEOUT_MS");
    }

    #[test]
    fn admin_and_from_fallbacks() {
        std::env::remove_var("POKOIN_ASSISTANT_EMAIL");
        std::env::remove_var("POKOIN_ASSISTANT_FROM");
        assert_eq!(admin_to(), "pokoinpos@gmail.com");
        assert_eq!(assistant_from(), "Poko <poko@pokoin.com>");
    }

    #[test]
    fn scope_and_identity_hashing() {
        assert_eq!(clean_scope("trainingai-classify"), "trainingai-classify");
        assert_eq!(clean_scope("Weird Scope!!"), "weird-scope-");
        assert_eq!(clean_scope(""), "scope");
        let hash = identity_hash("1.2.3.4");
        assert_eq!(hash.len(), 32);
        assert_eq!(hash, identity_hash("1.2.3.4"));
        assert_ne!(hash, identity_hash("1.2.3.5"));
        let bucket = rate_limit_bucket("trainingai-classify", "1.2.3.4");
        assert!(bucket.starts_with("pokoin:rl:v1:trainingai-classify:"));
        assert_eq!(
            bucket.len(),
            "pokoin:rl:v1:".len() + "trainingai-classify".len() + 1 + 32
        );
    }

    #[test]
    fn forwarded_identity() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-forwarded-for", "1.1.1.1, 10.0.0.1".parse().unwrap());
        assert_eq!(identity_from_headers(&headers), "1.1.1.1");
        assert_eq!(
            identity_from_headers(&axum::http::HeaderMap::new()),
            "unknown"
        );
    }

    #[test]
    fn rate_window_is_sliding_per_ip() {
        let ip = format!("test-{}", std::process::id());
        for _ in 0..20 {
            assert!(!assistant_rate_limited(&ip));
        }
        assert!(assistant_rate_limited(&ip));
        // A different IP is a separate bucket.
        assert!(!assistant_rate_limited(&format!("{ip}-other")));
    }
}
