//! Native port of the live p2 `src/x-client.js`. Never Debug-print credentials.
use anyhow::{bail, Context};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

#[derive(Clone)]
pub struct Credentials {
    pub api_key: String,
    pub api_secret: String,
    pub access_token: String,
    pub access_token_secret: String,
}

impl Credentials {
    pub fn configured(&self) -> bool {
        [
            &self.api_key,
            &self.api_secret,
            &self.access_token,
            &self.access_token_secret,
        ]
        .iter()
        .all(|v| !v.is_empty())
    }

    pub fn from_env() -> Self {
        Self {
            api_key: env_alias(&["X_API_KEY", "Consumer_Key_X"]),
            api_secret: env_alias(&["X_API_SECRET", "Consumer_Key_Secret_X"]),
            access_token: env_alias(&["X_ACCESS_TOKEN", "Access_Token_X"]),
            access_token_secret: env_alias(&["X_ACCESS_TOKEN_SECRET", "Access_Token_Secret_X"]),
        }
    }
}

pub(crate) fn env_alias(names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

fn mac(key: &str, value: &[u8]) -> Hmac<Sha256> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts any key size");
    mac.update(value);
    mac
}

pub fn crc_response_token(token: &str, secret: &str) -> String {
    format!(
        "sha256={}",
        STANDARD.encode(mac(secret, token.as_bytes()).finalize().into_bytes())
    )
}

pub fn verify_webhook_signature(signature: &str, body: &[u8], secret: &str) -> bool {
    let Some(value) = signature.strip_prefix("sha256=") else {
        return false;
    };
    // Node accepts only the canonical base64 representation.
    let Ok(bytes) = STANDARD.decode(value) else {
        return false;
    };
    STANDARD.encode(&bytes) == value && mac(secret, body).verify_slice(&bytes).is_ok()
}

pub fn oauth1_authorization_header(
    method: &str,
    url: &Url,
    c: &Credentials,
    nonce: &str,
    timestamp: &str,
) -> anyhow::Result<String> {
    if !c.configured() {
        bail!("OAuth 1.0a user-context credentials are incomplete");
    }
    let mut oauth = vec![
        ("oauth_consumer_key".to_string(), c.api_key.clone()),
        ("oauth_nonce".into(), nonce.into()),
        ("oauth_signature_method".into(), "HMAC-SHA256".into()),
        ("oauth_timestamp".into(), timestamp.into()),
        ("oauth_token".into(), c.access_token.clone()),
        ("oauth_version".into(), "1.0".into()),
    ];
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    pairs.extend(oauth.clone());
    // Stable key-only sort deliberately preserves Node's duplicate-query order.
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let parameters = pairs
        .iter()
        .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let base_url = format!("{}{}", url.origin().ascii_serialization(), url.path());
    let base = format!(
        "{}&{}&{}",
        method.to_uppercase(),
        percent_encode(&base_url),
        percent_encode(&parameters)
    );
    let key = format!(
        "{}&{}",
        percent_encode(&c.api_secret),
        percent_encode(&c.access_token_secret)
    );
    oauth.push((
        "oauth_signature".into(),
        STANDARD.encode(mac(&key, base.as_bytes()).finalize().into_bytes()),
    ));
    oauth.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(format!(
        "OAuth {}",
        oauth
            .iter()
            .map(|(k, v)| format!("{}=\"{}\"", percent_encode(k), percent_encode(v)))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

#[derive(Clone)]
pub struct XClient {
    http: reqwest::Client,
    base: Url,
    credentials: Credentials,
}

impl XClient {
    pub fn new(http: reqwest::Client, base: Url, credentials: Credentials) -> Self {
        Self {
            http,
            base,
            credentials,
        }
    }

    pub async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> anyhow::Result<Value> {
        let mut url = self.base.join(path)?;
        url.query_pairs_mut()
            .extend_pairs(query.iter().map(|(k, v)| (*k, v.as_str())));
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|_| anyhow::anyhow!("X OAuth nonce entropy unavailable"))?;
        let nonce = random
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_secs()
            .to_string();
        let authorization = oauth1_authorization_header(
            method.as_str(),
            &url,
            &self.credentials,
            &nonce,
            &timestamp,
        )?;
        let mut request = self
            .http
            .request(method.clone(), url)
            .header("authorization", authorization)
            .header("user-agent", "Hermes-Poko/1.0");
        if let Some(body) = body {
            request = request.json(&body);
        }
        // Do not propagate reqwest errors: they can contain a credential-bearing URL.
        let response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("X API transport failed"))?;
        let status = response.status();
        let data: Value = response.json().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            bail!("X API {method} {path} failed {}", status.as_u16());
        }
        Ok(data)
    }

    pub async fn post_tweet(&self, text: &str, reply_id: Option<&str>) -> anyhow::Result<Value> {
        let mut body = json!({"text": crate::social_text::js_slice(text, 280)});
        if let Some(id) = reply_id.filter(|id| !id.is_empty()) {
            body["reply"] = json!({"in_reply_to_tweet_id":id});
        }
        self.request(reqwest::Method::POST, "/2/tweets", &[], Some(body))
            .await
    }

    pub async fn authenticated_user(&self) -> anyhow::Result<Value> {
        self.request(
            reqwest::Method::GET,
            "/2/users/me",
            &[("user.fields", "username,name,id".into())],
            None,
        )
        .await?
        .get("data")
        .cloned()
        .context("X response missing user data")
    }

    pub async fn user_by_username(&self, username: &str) -> anyhow::Result<Value> {
        let handle = username.strip_prefix('@').unwrap_or(username);
        if handle.is_empty()
            || handle.len() > 15
            || !handle
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            bail!("X username is not valid");
        }
        self.request(
            reqwest::Method::GET,
            &format!("/2/users/by/username/{handle}"),
            &[("user.fields", "username,name,id,description".into())],
            None,
        )
        .await?
        .get("data")
        .cloned()
        .context("X response missing user data")
    }

    pub async fn user_tweets(&self, id: &str, max: usize) -> anyhow::Result<Vec<Value>> {
        let data = self
            .request(
                reqwest::Method::GET,
                &format!("/2/users/{}/tweets", percent_encode(id)),
                &[
                    ("max_results", max.clamp(5, 100).to_string()),
                    ("exclude", "retweets,replies".into()),
                    (
                        "tweet.fields",
                        "created_at,text,conversation_id,public_metrics".into(),
                    ),
                ],
                None,
            )
            .await?;
        Ok(data["data"].as_array().cloned().unwrap_or_default())
    }

    pub async fn search_recent(&self, query: &str, max: usize) -> anyhow::Result<Vec<Value>> {
        let data = self
            .request(
                reqwest::Method::GET,
                "/2/tweets/search/recent",
                &[
                    ("query", query.into()),
                    ("max_results", max.clamp(10, 100).to_string()),
                    (
                        "tweet.fields",
                        "created_at,text,author_id,conversation_id,public_metrics".into(),
                    ),
                    ("expansions", "author_id".into()),
                    ("user.fields", "username,name".into()),
                ],
                None,
            )
            .await?;
        let users = data["includes"]["users"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        Ok(data["data"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut tweet| {
                tweet["username"] = users
                    .iter()
                    .find(|u| u["id"] == tweet["author_id"])
                    .and_then(|u| u.get("username"))
                    .cloned()
                    .unwrap_or(json!(""));
                tweet
            })
            .collect())
    }

    pub async fn follow_user(&self, source: &str, target: &str) -> anyhow::Result<Value> {
        self.request(
            reqwest::Method::POST,
            &format!("/2/users/{}/following", percent_encode(source)),
            &[],
            Some(json!({"target_user_id":target})),
        )
        .await
    }
}
