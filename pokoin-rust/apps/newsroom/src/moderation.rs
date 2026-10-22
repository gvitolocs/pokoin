use crate::{array, iso, model::Budget, text, timestamp};
use anyhow::{bail, Context, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::time::Duration;

pub const PROMPT: &str = include_str!("../assets/moderation-system.txt");
fn matches(pattern: &str, value: &str) -> bool {
    Regex::new(pattern).is_ok_and(|re| re.is_match(value))
}
pub fn precheck(body: &str) -> Option<Value> {
    if matches(r"(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", body)
        || matches(r"(?:\+?\d[\s-]?){9,}", body)
    {
        return Some(
            json!({"decision":"hold","reason":"contains contact details","categories":["personal_data"]}),
        );
    }
    if Regex::new(r"(?i)\b(?:https?://|www\.)\S+").is_ok_and(|re| re.find_iter(body).count() > 1) {
        return Some(json!({"decision":"hold","reason":"several links","categories":["links"]}));
    }
    None
}
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => v.to_string(),
    }
}
pub fn parse_decision(raw: &Value) -> Option<Value> {
    let parsed;
    let v = if let Some(s) = raw.as_str() {
        parsed = serde_json::from_str::<Value>(s).ok()?;
        &parsed
    } else {
        raw
    };
    let decision = js_string(v.get("decision").unwrap_or(&Value::Null)).to_lowercase();
    if !["publish", "hold", "reject"].contains(&decision.as_str()) {
        return None;
    }
    let reason = v
        .get("reason")
        .filter(|v| !v.is_null() && **v != false && **v != 0)
        .map(js_string)
        .unwrap_or_default();
    Some(
        json!({"decision":decision,"reason":reason.chars().take(200).collect::<String>(),"categories":array(&v["categories"]).iter().take(6).map(js_string).collect::<Vec<_>>()}),
    )
}
pub fn clean_env(value: &str) -> String {
    let s = value.trim();
    let re = Regex::new(r#"^(?:\\*["'])+|(?:\\*["'])+$"#);
    re.map(|re| re.replace_all(s, "").trim().to_owned())
        .unwrap_or_else(|_| s.into())
}
pub fn normalize_private_key(value: &str) -> String {
    let Ok(re) = Regex::new(r"-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END ([A-Z ]+)-----") else {
        return value.trim().into();
    };
    let Some(m) = re.captures(value) else {
        return value.trim().into();
    };
    if m[1] != m[3] {
        return value.trim().into();
    }
    let body = Regex::new(r"\\+n")
        .map(|r| r.replace_all(&m[2], "\n").to_string())
        .unwrap_or_default();
    let body: String = body
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "+/=".contains(*c))
        .collect();
    let lines = body
        .as_bytes()
        .chunks(64)
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "-----BEGIN {}-----\n{lines}\n-----END {}-----\n",
        &m[1], &m[1]
    )
}
pub fn field_value(value: &Value) -> Value {
    match value {
        Value::Null => json!({"nullValue":null}),
        Value::String(v) => json!({"stringValue":v}),
        Value::Bool(v) => json!({"booleanValue":v}),
        Value::Number(v) => {
            if v.is_i64() || v.is_u64() {
                json!({"integerValue":v.to_string()})
            } else {
                json!({"doubleValue":v})
            }
        }
        Value::Array(a) => {
            json!({"arrayValue":{"values":a.iter().map(field_value).collect::<Vec<_>>()}})
        }
        Value::Object(o) => {
            json!({"mapValue":{"fields":o.iter().map(|(k,v)|(k.clone(),field_value(v))).collect::<serde_json::Map<_,_>>()}})
        }
    }
}
pub fn plain_value(value: &Value) -> Value {
    for key in [
        "stringValue",
        "doubleValue",
        "booleanValue",
        "timestampValue",
    ] {
        if let Some(v) = value.get(key) {
            return v.clone();
        }
    }
    if let Some(v) = value.get("integerValue") {
        return v
            .as_str()
            .and_then(|s| s.parse::<i64>().ok())
            .map_or(Value::Null, |i| json!(i));
    }
    if let Some(v) = value.get("mapValue") {
        return json!(v["fields"]
            .as_object()
            .map(|o| o
                .iter()
                .map(|(k, v)| (k.clone(), plain_value(v)))
                .collect::<serde_json::Map<_, _>>())
            .unwrap_or_default());
    }
    if let Some(v) = value.get("arrayValue") {
        return json!(array(&v["values"])
            .iter()
            .map(plain_value)
            .collect::<Vec<_>>());
    }
    Value::Null
}
pub fn moderation_request(comment: &Value) -> Value {
    let mut user = serde_json::Map::new();
    for (from, to) in [
        ("articlePath", "article"),
        ("authorName", "author"),
        ("body", "comment"),
    ] {
        if let Some(v) = comment.get(from) {
            user.insert(to.into(), v.clone());
        }
    }
    json!({"model":"deepseek-flash","response_format":{"type":"json_object"},"max_tokens":4000,
        "messages":[{"role":"system","content":PROMPT},{"role":"user","content":Value::Object(user).to_string()}]})
}
pub fn moderation_update(
    comment: &Value,
    verdict: Option<Value>,
    now: i64,
    prechecked: bool,
) -> Option<Value> {
    let (verdict, model) = if let Some(v) = verdict {
        (
            v,
            if prechecked {
                "precheck"
            } else {
                "deepseek-flash"
            },
        )
    } else {
        let created = text(comment, "createdAt");
        let age = if created.is_empty() {
            Some(0)
        } else {
            timestamp(created).map(|t| now - t)
        };
        if age.is_some_and(|a| a < 24 * 3_600_000) {
            return None;
        }
        (
            json!({"decision":"hold","reason":"moderation unavailable for 24 h","categories":[]}),
            "timeout",
        )
    };
    let status = match text(&verdict, "decision") {
        "publish" => "visible",
        "hold" => "held",
        "reject" => "rejected",
        _ => return None,
    };
    Some(
        json!({"status":status,"moderation":{"model":model,"decision":verdict["decision"],"reason":verdict["reason"],"categories":verdict["categories"]},"moderatedAt":iso(now)}),
    )
}
pub async fn service_account_token(client: &reqwest::Client) -> Result<String> {
    let email = clean_env(&std::env::var("FIREBASE_CLIENT_EMAIL").unwrap_or_default());
    let key = normalize_private_key(&std::env::var("FIREBASE_PRIVATE_KEY").unwrap_or_default());
    let now = chrono::Utc::now().timestamp();
    let claims = json!({"iss":email,"scope":"https://www.googleapis.com/auth/datastore","aud":"https://oauth2.googleapis.com/token","iat":now,"exp":now+3600});
    let encoding = jsonwebtoken::EncodingKey::from_rsa_pem(key.as_bytes())
        .map_err(|_| anyhow::anyhow!("invalid Firebase signing key"))?;
    let jwt = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &encoding,
    )
    .map_err(|_| anyhow::anyhow!("Firebase signing failed"))?;
    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &jwt),
        ])
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Firebase token connection failed"))?;
    if !response.status().is_success() {
        bail!("Firebase token HTTP {}", response.status().as_u16());
    }
    let v: Value = response.json().await?;
    Ok(v["access_token"]
        .as_str()
        .context("Firebase access token missing")?
        .into())
}
pub struct Firestore {
    client: reqwest::Client,
    base: String,
    token: String,
}
impl Firestore {
    pub fn new(project: &str, token: String) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()?,
            base: format!(
                "https://firestore.googleapis.com/v1/projects/{}/databases/(default)/documents",
                clean_env(project)
            ),
            token,
        })
    }
    pub async fn pending_comments(&self, limit: usize) -> Result<Vec<Value>> {
        let response=self.client.post(format!("{}:runQuery",self.base)).bearer_auth(&self.token).json(&json!({"structuredQuery":{
            "from":[{"collectionId":"news_comments"}],"where":{"fieldFilter":{"field":{"fieldPath":"status"},"op":"EQUAL","value":{"stringValue":"pending"}}},"limit":limit}}))
            .send().await.map_err(|_|anyhow::anyhow!("firestore query connection failed"))?;
        if !response.status().is_success() {
            bail!("firestore runQuery {}", response.status().as_u16());
        }
        let rows: Value = response.json().await?;
        Ok(array(&rows)
            .iter()
            .filter_map(|row| {
                let doc = row.get("document")?;
                let mut value = plain_value(&json!({"mapValue":{"fields":doc["fields"]}}));
                let name = text(doc, "name");
                value["name"] = json!(name);
                value["id"] = json!(name.rsplit('/').next().unwrap_or(""));
                Some(value)
            })
            .collect())
    }
    pub async fn set_moderation(&self, name: &str, update: &Value) -> Result<()> {
        let expected = self
            .base
            .strip_prefix("https://firestore.googleapis.com/v1/")
            .context("invalid firestore base")?;
        if !name.starts_with(&format!("{expected}/news_comments/")) || name.contains('?') {
            bail!("unexpected Firestore comment name");
        }
        let fields = update
            .as_object()
            .context("invalid update")?
            .iter()
            .map(|(k, v)| (k.clone(), field_value(v)))
            .collect::<serde_json::Map<_, _>>();
        let response=self.client.patch(format!("https://firestore.googleapis.com/v1/{name}?updateMask.fieldPaths=status&updateMask.fieldPaths=moderation&updateMask.fieldPaths=moderatedAt&currentDocument.exists=true"))
            .bearer_auth(&self.token).json(&json!({"fields":fields})).send().await.map_err(|_|anyhow::anyhow!("firestore patch connection failed"))?;
        if !response.status().is_success() {
            bail!("firestore patch {}", response.status().as_u16());
        }
        Ok(())
    }
}
pub async fn moderate_with_flash(
    client: &reqwest::Client,
    comment: &Value,
    key: &str,
    budget: &Budget,
) -> Option<Value> {
    if key.is_empty() || budget.take().is_err() {
        return None;
    }
    let response = client
        .post("https://api.deepseek.com/chat/completions")
        .timeout(Duration::from_secs(30))
        .bearer_auth(key)
        .json(&moderation_request(comment))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let data: Value = response.json().await.ok()?;
    parse_decision(&data["choices"][0]["message"]["content"])
}
