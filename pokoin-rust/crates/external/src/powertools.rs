//! Power Tools integration — native port of `_powertools_session.js`,
//! `_powertools_ct_match.js`, and the Power Tools slice of `_stock_csv.js`.
//! Outseta password login → jwt session cookie (password never stored),
//! AES-GCM encrypted session on Firestore `seller_integrations/{uid}__powertools`,
//! CSV location mapping, and the CT↔PT stock matcher.

use std::collections::HashMap;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::cardtrader::client::CardTraderClient;
use crate::cardtrader::sync_core::{marketplace_game_for_product, NormalizedProduct};
use crate::crypto::{decrypt_secret, encrypt_secret};
use crate::error::{clean_text, clean_text_value, ApiError, ApiResult};
use crate::firebase::{FirestoreDoc, FirestoreStore};

pub const COLLECTION: &str = "seller_integrations";
pub const PROVIDER: &str = "powertools";
pub const MAX_FAILED_LOGINS: i64 = 5;
const LOGIN_WINDOW_MS: i64 = 3_600_000;

fn powertools_base_url() -> String {
    std::env::var("POWERTOOLS_BASE_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "https://new.tcgpowertools.com".into())
}

fn outseta_base_url() -> String {
    std::env::var("POWERTOOLS_OUTSETA_API_BASE_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "https://mtg-powertools.outseta.com/api/v1".into())
}

fn encryption_key() -> Option<String> {
    std::env::var("CARDTRADER_TOKEN_ENCRYPTION_KEY").ok().filter(|v| !v.trim().is_empty())
}

pub fn integration_doc_id(uid: &str) -> String {
    format!("{uid}__{PROVIDER}")
}

pub async fn read_power_tools_doc(firestore: &dyn FirestoreStore, uid: &str) -> ApiResult<FirestoreDoc> {
    firestore.get_doc(COLLECTION, &integration_doc_id(uid)).await
}

/// `cleanSessionToken` — bare jwt or pasted cookie string.
pub fn clean_session_token(value: &str) -> ApiResult<String> {
    let mut raw = clean_text(Some(value), 4096);
    static COOKIE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let cookie = COOKIE.get_or_init(|| Regex::new(r"(?:^|;\s*)jwt=([^;\s]+)").expect("jwt cookie regex"));
    if let Some(captures) = cookie.captures(&raw) {
        raw = captures.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
    }
    static QUOTES: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let quotes = QUOTES.get_or_init(|| Regex::new(r#"^["']|["']$"#).expect("quote regex"));
    let raw = quotes.replace(&raw, "").to_string();
    static JWT: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let jwt = JWT.get_or_init(|| Regex::new(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$").expect("jwt shape regex"));
    if !jwt.is_match(&raw) {
        return Err(ApiError::bad_request("Paste the Power Tools session (the jwt cookie value).")
            .with_code("powertools_session_invalid"));
    }
    Ok(raw)
}

/// `jwtFromSetCookie` — jwt= value from any Set-Cookie line.
pub fn jwt_from_set_cookie(lines: &[String]) -> String {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?:^|[,;]\s*)jwt=([^;,\s]+)").expect("set-cookie jwt regex"));
    for line in lines {
        if let Some(captures) = re.captures(line) {
            if let Some(value) = captures.get(1) {
                if value.as_str() != "deleted" {
                    return value.as_str().to_string();
                }
            }
        }
    }
    String::new()
}

#[derive(Clone)]
pub struct PowerToolsClient {
    http: reqwest::Client,
    base: String,
    outseta: String,
}

impl Default for PowerToolsClient {
    fn default() -> Self {
        Self::new()
    }
}

impl PowerToolsClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("reqwest client"),
            base: powertools_base_url(),
            outseta: outseta_base_url(),
        }
    }

    /// Override the API base (tests / non-default deployments).
    pub fn with_base(mut self, base: String) -> Self {
        self.base = base.trim_end_matches('/').to_string();
        self
    }

    /// Current API base (non-secret diagnostics).
    pub fn base(&self) -> &str {
        &self.base
    }

    /// Outseta password login → access token (2FA rejected with 409).
    pub async fn outseta_access_token(&self, email: &str, password: &str) -> ApiResult<String> {
        let username = clean_text(Some(email), 320);
        if username.is_empty() || password.is_empty() {
            return Err(ApiError::bad_request("Enter your Power Tools email and password.")
                .with_code("powertools_credentials_missing"));
        }
        let response = self
            .http
            .post(format!("{}/tokens", self.outseta))
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
            .body(format!(
                "username={}&password={}",
                crate::crypto::uri_encode(&username, true),
                crate::crypto::uri_encode(password, true)
            ))
            .send()
            .await
            .map_err(|e| ApiError::new(502, format!("Power Tools sign-in is unavailable ({e}).")).with_code("powertools_login_unavailable"))?;
        let status = response.status().as_u16();
        let payload: Value = response.json().await.unwrap_or(Value::Null);
        if matches!(status, 400 | 401 | 403) {
            return Err(ApiError::new(401, "Power Tools did not accept that email and password.")
                .with_code("powertools_invalid_credentials"));
        }
        if !(200..300).contains(&status) {
            return Err(ApiError::new(502, format!("Power Tools sign-in is unavailable ({status})."))
                .with_code("powertools_login_unavailable"));
        }
        if payload.get("two_factor_required") == Some(&Value::Bool(true))
            || payload.get("two_factor_enrollment_required") == Some(&Value::Bool(true))
        {
            return Err(ApiError::new(409, "This Power Tools account uses two-factor sign-in. Paste your Power Tools session instead.")
                .with_code("powertools_two_factor"));
        }
        let access_token = clean_text(payload.get("access_token").and_then(Value::as_str), 8192);
        if access_token.is_empty() {
            return Err(ApiError::new(502, "Power Tools sign-in returned no access token.")
                .with_code("powertools_login_unavailable"));
        }
        Ok(access_token)
    }

    /// Exchange the Outseta token for the Power Tools session jwt cookie.
    pub async fn exchange_access_token(&self, access_token: &str) -> ApiResult<String> {
        let response = self
            .http
            .post(format!("{}/api/auth/login", self.base))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&json!({ "accessToken": access_token }))
            .send()
            .await
            .map_err(|e| ApiError::new(502, format!("Power Tools sign-in failed ({e}).")).with_code("powertools_login_unavailable"))?;
        let status = response.status().as_u16();
        if matches!(status, 401 | 403 | 404) {
            let payload: Value = response.json().await.unwrap_or(Value::Null);
            let message = clean_text(payload.get("message").and_then(Value::as_str), 200);
            return Err(ApiError::new(
                401,
                if message.is_empty() { "Power Tools has no account for that sign-in.".into() } else { message },
            )
            .with_code("powertools_invalid_credentials"));
        }
        if !(200..300).contains(&status) {
            return Err(ApiError::new(502, format!("Power Tools sign-in failed ({status})."))
                .with_code("powertools_login_unavailable"));
        }
        let cookies: Vec<String> = response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok().map(str::to_string))
            .collect();
        let jwt = jwt_from_set_cookie(&cookies);
        if jwt.is_empty() {
            return Err(ApiError::new(502, "Power Tools sign-in returned no session.")
                .with_code("powertools_login_unavailable"));
        }
        Ok(jwt)
    }

    /// Email + password → session jwt (the password is never kept).
    pub async fn login_with_password(&self, email: &str, password: &str) -> ApiResult<String> {
        let access_token = self.outseta_access_token(email, password).await?;
        self.exchange_access_token(&access_token).await
    }

    async fn request(&self, jwt: &str, path: &str) -> ApiResult<Value> {
        let response = self
            .http
            .get(format!("{}/api/{}", self.base, path.trim_start_matches('/')))
            .header("Accept", "application/json")
            .header("Cookie", format!("jwt={jwt}"))
            .send()
            .await
            .map_err(|e| ApiError::new(502, format!("Power Tools {path} failed ({e}).")).with_code("powertools_unavailable"))?;
        let status = response.status().as_u16();
        if matches!(status, 401 | 403) {
            return Err(ApiError::new(409, "Your Power Tools session expired. Sign in to Power Tools again.")
                .with_code("powertools_session_expired"));
        }
        if !(200..300).contains(&status) {
            return Err(ApiError::new(502, format!("Power Tools {path} failed ({status})."))
                .with_code("powertools_unavailable"));
        }
        let text = response.text().await.unwrap_or_default();
        if text.trim().is_empty() {
            return Err(ApiError::new(502, format!("Power Tools {path} returned no JSON."))
                .with_code("powertools_unavailable"));
        }
        serde_json::from_str(&text)
            .map_err(|_| ApiError::new(502, format!("Power Tools {path} returned no JSON.")).with_code("powertools_unavailable"))
    }

    /// Non-secret identity from GET /api/user.
    pub async fn fetch_user(&self, jwt: &str) -> ApiResult<Value> {
        let user = self.request(jwt, "user").await?;
        let safe = safe_power_tools_user(&user);
        if safe["userId"].as_str().unwrap_or_default().is_empty() && safe["username"].as_str().unwrap_or_default().is_empty() {
            return Err(ApiError::new(502, "Power Tools returned no account for that session.")
                .with_code("powertools_unavailable"));
        }
        Ok(safe)
    }

    pub async fn fetch_orders(&self, jwt: &str) -> ApiResult<Vec<Value>> {
        let orders = self.request(jwt, "user/order").await?;
        match orders {
            Value::Array(rows) => Ok(rows),
            _ => Err(ApiError::new(502, "Power Tools orders did not return a list.").with_code("powertools_unavailable")),
        }
    }
}

/// `safePowerToolsUser` — drops CardTrader tokens and everything secret.
pub fn safe_power_tools_user(user: &Value) -> Value {
    let ct = user.get("assignedCardtraderUser").filter(|v| v.is_object());
    json!({
        "userId": clean_text(user.get("_id").and_then(Value::as_str), 80),
        "username": clean_text(user.get("username").and_then(Value::as_str), 320),
        "cardtraderUserId": match ct.and_then(|c| c.get("cardtraderUserId")) {
            None | Some(Value::Null) => String::new(),
            Some(value) => clean_text_value(value, 40),
        },
        "cardtraderUserName": clean_text(ct.and_then(|c| c.get("cardtraderUserName")).and_then(Value::as_str), 160),
    })
}

/// `safePowerToolsStatus`.
pub fn safe_power_tools_status(doc: &FirestoreDoc) -> Value {
    let data = if doc.exists { &doc.data } else { &Value::Null };
    let enabled = data.get("enabled") == Some(&Value::Bool(true));
    let has_session = data.get("encryptedSession").map(|v| !v.is_null()).unwrap_or(false);
    let connected = enabled && has_session;
    json!({
        "connected": connected,
        "provider": PROVIDER,
        "account": if connected { data.get("metadata").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null) } else { Value::Null },
        "connectedAt": data.get("connectedAt").cloned().unwrap_or(Value::Null),
        "lastValidatedAt": data.get("lastValidatedAt").cloned().unwrap_or(Value::Null),
        "disconnectedAt": data.get("disconnectedAt").cloned().unwrap_or(Value::Null),
        "sessionExpiredAt": data.get("sessionExpiredAt").cloned().unwrap_or(Value::Null),
    })
}

/// `loginThrottle` — 5 failed password sign-ins per hour per Pokoin user.
pub fn login_throttle(data: &Value, now_ms: i64) -> (bool, i64, i64) {
    let attempts = data.get("loginAttempts").cloned().unwrap_or(json!({}));
    let start = attempts.get("windowStartMs").and_then(Value::as_i64).unwrap_or(0);
    let failed = attempts.get("failed").and_then(Value::as_i64).unwrap_or(0);
    let in_window = now_ms - start < LOGIN_WINDOW_MS;
    let blocked = in_window && failed >= MAX_FAILED_LOGINS;
    let (next_start, next_failed) = if in_window { (start, failed) } else { (now_ms, 0) };
    (blocked, next_start, next_failed)
}

pub async fn record_failed_login(firestore: &dyn FirestoreStore, uid: &str, window_start_ms: i64, failed: i64) {
    let _ = firestore
        .merge_doc(
            COLLECTION,
            &integration_doc_id(uid),
            json!({
                "uid": uid,
                "provider": PROVIDER,
                "loginAttempts": { "windowStartMs": window_start_ms, "failed": failed + 1 },
            }),
        )
        .await;
}

pub async fn store_power_tools_session(firestore: &dyn FirestoreStore, uid: &str, jwt: &str, account: &Value) -> ApiResult<()> {
    let prior = firestore.get_doc(COLLECTION, &integration_doc_id(uid)).await.unwrap_or_default();
    let prior_data = if prior.exists { prior.data } else { json!({}) };
    let now = crate::time_util::iso_from_ms(crate::time_util::now_ms());
    let connected_at = if prior_data.get("enabled") == Some(&Value::Bool(true)) {
        prior_data.get("connectedAt").cloned().filter(|v| !v.is_null()).unwrap_or(json!(now.clone()))
    } else {
        json!(now.clone())
    };
    firestore
        .merge_doc(
            COLLECTION,
            &integration_doc_id(uid),
            json!({
                "uid": uid,
                "provider": PROVIDER,
                "enabled": true,
                "metadata": account,
                "encryptedSession": encrypt_secret(jwt, encryption_key().as_deref()),
                "connectedAt": connected_at,
                "lastValidatedAt": now.clone(),
                "updatedAt": now,
                "disconnectedAt": Value::Null,
                "sessionExpiredAt": Value::Null,
                "loginAttempts": { "windowStartMs": 0, "failed": 0 },
            }),
        )
        .await
}

pub async fn disconnect_power_tools(firestore: &dyn FirestoreStore, uid: &str) -> ApiResult<()> {
    let now = crate::time_util::iso_from_ms(crate::time_util::now_ms());
    firestore
        .merge_doc(
            COLLECTION,
            &integration_doc_id(uid),
            json!({ "enabled": false, "encryptedSession": Value::Null, "disconnectedAt": now.clone(), "updatedAt": now }),
        )
        .await
}

/// Session jwt for a connected seller, or '' when not connected.
pub async fn decrypt_power_tools_session(firestore: &dyn FirestoreStore, uid: &str) -> ApiResult<String> {
    let doc = read_power_tools_doc(firestore, uid).await?;
    if !doc.exists || doc.data.get("enabled") != Some(&Value::Bool(true)) {
        return Ok(String::new());
    }
    let encrypted = doc.data.get("encryptedSession").cloned().unwrap_or(Value::Null);
    if encrypted.is_null() {
        return Ok(String::new());
    }
    decrypt_secret(&encrypted, encryption_key().as_deref())
}

pub async fn mark_session_expired(firestore: &dyn FirestoreStore, uid: &str) {
    let now = crate::time_util::iso_from_ms(crate::time_util::now_ms());
    let _ = firestore
        .merge_doc(COLLECTION, &integration_doc_id(uid), json!({ "sessionExpiredAt": now.clone(), "updatedAt": now }))
        .await;
}

/// Does the PT account mirror the same CardTrader seller Pokoin is connected to?
pub async fn cardtrader_match(firestore: &dyn FirestoreStore, uid: &str, account: &Value) -> ApiResult<Value> {
    let doc = crate::cardtrader::integration::read_integration_doc(firestore, uid).await.unwrap_or_default();
    let data = if doc.exists { doc.data } else { json!({}) };
    let pokoin_ct_user = if data.get("enabled") == Some(&Value::Bool(true)) {
        data.pointer("/metadata/user/id").cloned().unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let pokoin_ct_user = clean_text_value(&pokoin_ct_user, 80).trim().to_string();
    let pt_ct_user = clean_text_value(account.get("cardtraderUserId").unwrap_or(&Value::Null), 40).trim().to_string();
    if pokoin_ct_user.is_empty() || pt_ct_user.is_empty() {
        return Ok(Value::Null);
    }
    Ok(Value::Bool(pokoin_ct_user == pt_ct_user))
}

// ---------------------------------------------------------------- stock CSV

/// Power Tools condition scale → Pokoin conditions.
pub fn map_condition_from_cm(raw: &str) -> &'static str {
    match raw.trim().to_lowercase().as_str() {
        "mt" | "mint" | "nm" | "near mint" => "NM",
        "ex" | "excellent" | "sp" | "slightly played" => "SP",
        "gd" | "good" | "mp" | "moderately played" | "lp" | "lightly played" => "MP",
        "pl" | "played" | "hp" | "heavily played" => "PL",
        "po" | "poor" => "Poor",
        _ => "NM",
    }
}

pub fn map_language_from_name(raw: &str) -> String {
    let key = raw.trim().to_lowercase();
    if key.len() <= 3 && key.chars().all(|c| c.is_ascii_alphabetic()) {
        let upper = key.to_uppercase();
        let known = ["EN", "IT", "DE", "FR", "ES", "PT", "JP", "KO", "ZH", "ZHT", "NL", "PL", "RU", "ID", "TH", "VI"];
        if known.contains(&upper.as_str()) {
            return upper;
        }
    }
    match key.as_str() {
        "english" => "EN",
        "italian" => "IT",
        "german" => "DE",
        "french" => "FR",
        "spanish" => "ES",
        "portuguese" => "PT",
        "japanese" => "JP",
        "korean" => "KO",
        "chinese (trad.)" | "chinese traditional" => "ZHT",
        "chinese" => "ZH",
        "dutch" => "NL",
        "polish" => "PL",
        "russian" => "RU",
        "indonesian" => "ID",
        "thai" => "TH",
        "vietnamese" => "VI",
        _ => "EN",
    }
    .to_string()
}

pub fn truthy_flag(value: &str) -> bool {
    matches!(value.trim().to_lowercase().as_str(), "true" | "1" | "yes" | "y" | "x")
}

/// `mapFinishFromPowerTools` — finishType/isReverseHolo → foil facets.
pub fn map_finish_from_power_tools(finish_type: &str, is_reverse_holo: &str) -> (&'static str, bool) {
    let finish = finish_type.trim();
    let reverse_flag = truthy_flag(is_reverse_holo) || finish.to_lowercase().contains("reverse");
    let lower = finish.to_lowercase();
    if lower.contains("master") && lower.contains("ball") {
        return (if reverse_flag { "reverse" } else { "holo" }, reverse_flag);
    }
    if lower.contains("poke") && lower.contains("ball") {
        return (if reverse_flag { "reverse" } else { "holo" }, reverse_flag);
    }
    if lower.contains("cosmos") {
        return ("holo", false);
    }
    if lower.contains("ice") && lower.contains("crack") {
        return ("holo", false);
    }
    if lower.contains("stamp") {
        return ("stamped", false);
    }
    if lower.contains("promo") {
        return ("promo", false);
    }
    if reverse_flag || lower == "reverseholo" {
        return ("reverse", true);
    }
    if lower.contains("holo") {
        return ("holo", false);
    }
    ("standard", false)
}

/// Minimal RFC4180 CSV parse (commas, quotes, CRLF, BOM).
pub fn parse_csv(text: &str) -> (Vec<String>, Vec<Map<String, Value>>) {
    let src = text.trim_start_matches('\u{FEFF}');
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut chars = src.chars().peekable();
    let mut in_quotes = false;
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    cell.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                cell.push(ch);
            }
            continue;
        }
        match ch {
            '"' => in_quotes = true,
            ',' => {
                row.push(std::mem::take(&mut cell));
            }
            '\n' | '\r' => {
                if ch == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut cell));
                if row.iter().any(|c| !c.is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            other => cell.push(other),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        if row.iter().any(|c| !c.is_empty()) {
            rows.push(row);
        }
    }
    if rows.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let headers: Vec<String> = rows[0].iter().map(|h| clean_text(Some(h), 80)).collect();
    let records = rows[1..]
        .iter()
        .map(|cols| {
            let mut object = Map::new();
            for (index, header) in headers.iter().enumerate() {
                object.insert(header.clone(), json!(cols.get(index).cloned().unwrap_or_default()));
            }
            Value::Object(object)
        })
        .map(|value| match value {
            Value::Object(map) => map,
            _ => unreachable!(),
        })
        .collect();
    (headers, records)
}

fn field<'a>(raw: &'a Map<String, Value>, names: &[&str]) -> &'a str {
    for name in names {
        if let Some(value) = raw.get(*name) {
            let text = clean_text_value(value, 240);
            if !text.is_empty() {
                // Leak-free: return via the original string when possible.
                return match value {
                    Value::String(s) => s.as_str(),
                    _ => "",
                };
            }
        }
    }
    // Fuzzy header match (spacing/underscores fold away).
    let wanted: Vec<String> = names.iter().map(|n| n.trim().to_lowercase().replace([' ', '_'], "")).collect();
    for (key, value) in raw {
        let folded = key.trim().to_lowercase().replace([' ', '_'], "");
        if wanted.contains(&folded) {
            if let Value::String(s) = value {
                if !s.trim().is_empty() {
                    return s.as_str();
                }
            }
        }
    }
    ""
}

/// One Power Tools CSV row as the Pokoin reconcile sees it.
#[derive(Clone, Debug)]
pub struct PowerToolsRow {
    pub name: String,
    pub set_name: String,
    pub collector_number: String,
    pub condition: String,
    pub language: String,
    pub reverse: bool,
    pub first_edition: bool,
    pub quantity: i64,
    pub price_pkn: Option<f64>,
    pub seller_comment: String,
    pub location: String,
    pub box_name: String,
    pub stack: i64,
    pub position: i64,
    pub source_location: String,
}

pub fn power_tools_row(raw: &Map<String, Value>) -> PowerToolsRow {
    let (foil_state, reverse) = map_finish_from_power_tools(field(raw, &["finishType"]), field(raw, &["isReverseHolo"]));
    let price_raw = field(raw, &["price"]).replace(',', ".");
    let price: f64 = price_raw.parse().unwrap_or(0.0);
    PowerToolsRow {
        name: clean_text(Some(field(raw, &["name"])), 240),
        set_name: clean_text(Some(field(raw, &["set"])), 240),
        collector_number: clean_text(Some(field(raw, &["cn"])), 40),
        condition: map_condition_from_cm(field(raw, &["condition"])).to_string(),
        language: map_language_from_name(field(raw, &["language"])),
        reverse: reverse || foil_state == "reverse",
        first_edition: truthy_flag(field(raw, &["isFirstEd"])),
        quantity: {
            let n = field(raw, &["quantity"]).parse::<f64>().unwrap_or(1.0);
            n.trunc().clamp(1.0, 99.0) as i64
        },
        price_pkn: (price > 0.0).then(|| price * 200.0),
        seller_comment: clean_text(Some(field(raw, &["comment"])), 500),
        location: clean_text(Some(field(raw, &["location"])), 120),
        box_name: String::new(),
        stack: 1,
        position: 1,
        source_location: String::new(),
    }
}

/// `parsePowerToolsLocation` — as_is / trailing_stack / structured.
pub fn parse_power_tools_location(raw: &str, location_parse: &str) -> (String, i64, i64, bool) {
    let text = clean_text(Some(raw), 120);
    if text.is_empty() {
        return (String::new(), 1, 1, false);
    }
    let structured_marker = {
        static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
        RE.get_or_init(|| Regex::new(r"[·•]\d+").expect("mid dot regex")).is_match(&text)
    };
    if location_parse == "structured" || structured_marker {
        // box·stack or box·stack·pos
        static MID: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
        let mid = MID.get_or_init(|| Regex::new(r"^(.+?)[·•](\d+)(?:[·•](\d+))?$").expect("mid regex"));
        if let Some(captures) = mid.captures(&text) {
            let box_name = clean_text(Some(captures.get(1).map(|m| m.as_str()).unwrap_or_default()), 64);
            let stack: i64 = captures.get(2).map(|m| m.as_str()).unwrap_or("1").parse().unwrap_or(1).clamp(1, 9999);
            let position: i64 = captures.get(3).map(|m| m.as_str()).unwrap_or("1").parse().unwrap_or(1).clamp(1, 9999);
            return (box_name, stack, position, true);
        }
        return (text, 1, 1, false);
    }
    if location_parse == "trailing_stack" {
        static DASH: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
        let dash = DASH.get_or_init(|| Regex::new(r"^(.+?)\s+-\s+(\d+)$").expect("dash regex"));
        if let Some(captures) = dash.captures(&text) {
            let box_name = clean_text(Some(captures.get(1).map(|m| m.as_str()).unwrap_or_default()), 64);
            let stack: i64 = captures.get(2).map(|m| m.as_str()).unwrap_or("1").parse().unwrap_or(1).clamp(1, 9999);
            return (box_name, stack, 1, true);
        }
        static SPACE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
        let space = SPACE.get_or_init(|| Regex::new(r"^(.+?)[\s_]+(\d+)$").expect("space regex"));
        if let Some(captures) = space.captures(&text) {
            let head = captures.get(1).map(|m| m.as_str()).unwrap_or_default();
            if head.chars().any(|c| c.is_ascii_alphabetic()) {
                let box_name = clean_text(Some(head), 64);
                let stack: i64 = captures.get(2).map(|m| m.as_str()).unwrap_or("1").parse().unwrap_or(1).clamp(1, 9999);
                return (box_name, stack, 1, true);
            }
        }
    }
    (text, 1, 1, false)
}

/// `formatListingLocation` for Power Tools rows.
pub fn format_listing_location(box_name: &str, stack: i64, position: i64, stack_size: i64, numbered_in_stack: bool, include_stack: bool) -> String {
    let loc = clean_text(Some(box_name), 64);
    if loc.is_empty() {
        return String::new();
    }
    let size = stack_size.max(1);
    let s = stack.max(1);
    let p = position.max(1);
    if !numbered_in_stack {
        if include_stack || s > 1 {
            return format!("{loc}·{s}");
        }
        return loc;
    }
    if size == 1 {
        return format!("{loc}·{s}");
    }
    format!("{loc}·{s}·{p}")
}

/// `assignPowerToolsLocations` — rows + overflows + occupancy + suggested size.
pub fn assign_power_tools_locations(rows: Vec<PowerToolsRow>, stack_size: i64, numbered_in_stack: bool, location_parse: &str) -> AssignLocations {
    let stack_size = stack_size.max(1);
    let mut counts: HashMap<(String, i64), i64> = HashMap::new();
    let mut pos_counters: HashMap<(String, i64), i64> = HashMap::new();
    let mut out = Vec::new();
    for mut row in rows {
        let raw_loc = if row.location.is_empty() { row.box_name.clone() } else { row.location.clone() };
        let raw_loc = clean_text(Some(&raw_loc), 120);
        let (parsed_box, parsed_stack, parsed_position, structured) = parse_power_tools_location(&raw_loc, location_parse);
        let box_name = if parsed_box.is_empty() { if raw_loc.is_empty() { "box".to_string() } else { raw_loc.clone() } } else { parsed_box };
        let mut stack = parsed_stack.max(1);
        let mut position = 1;
        let key = (box_name.clone(), stack);
        *counts.entry(key.clone()).or_insert(0) += 1;
        if numbered_in_stack {
            if structured {
                position = parsed_position;
            } else {
                let abs = pos_counters.entry(key).and_modify(|v| *v += 1).or_insert(1);
                let spill_stack = stack + (*abs - 1) / stack_size;
                position = (*abs - 1) % stack_size + 1;
                stack = spill_stack;
            }
        }
        let include_stack = structured || location_parse == "trailing_stack" || stack > 1;
        row.box_name = box_name;
        row.stack = stack;
        row.position = position;
        row.location = format_listing_location(&row.box_name, stack, position, stack_size, numbered_in_stack, include_stack || numbered_in_stack);
        row.source_location = raw_loc;
        out.push(row);
    }
    let mut occupancy = Vec::new();
    let mut suggested = 1i64;
    for ((box_name, stack), count) in &counts {
        let label = format!(
            "{box_name}{}",
            if *stack > 1 || location_parse == "trailing_stack" { format!("·{stack}") } else { String::new() }
        );
        occupancy.push(json!({ "box": box_name, "stack": stack, "count": count, "label": label }));
        suggested = suggested.max(*count);
    }
    occupancy.sort_by(|a, b| {
        let count = b["count"].as_i64().cmp(&a["count"].as_i64());
        count.then_with(|| a["label"].as_str().unwrap_or("").cmp(b["label"].as_str().unwrap_or("")))
    });
    let overflows = occupancy
        .iter()
        .filter(|row| row["count"].as_i64().unwrap_or(0) > stack_size)
        .map(|row| {
            json!({
                "box": row["box"], "stack": row["stack"], "count": row["count"], "stackSize": stack_size,
                "label": row["label"],
                "message": format!("{}: {} cards in this stack, but capacity is set to {}", row["label"], row["count"], stack_size),
            })
        })
        .collect();
    AssignLocations { rows: out, overflows, occupancy, suggested_stack_size: suggested.max(1) }
}

pub struct AssignLocations {
    pub rows: Vec<PowerToolsRow>,
    pub overflows: Vec<Value>,
    pub occupancy: Vec<Value>,
    pub suggested_stack_size: i64,
}

// ---------------------------------------------------------------- CT match

pub fn compact_key(value: &str) -> String {
    let lower = clean_text(Some(value), 240).to_lowercase();
    let mut out = String::new();
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        }
    }
    out
}

/// Collector numbers like 069/101, 69/101, and bare 69 compare equal.
pub fn compact_collector(value: &str) -> String {
    let raw = clean_text(Some(value), 40).to_lowercase();
    if raw.is_empty() {
        return String::new();
    }
    let stripped = raw.split('|').next_back().unwrap_or("").trim();
    static SLASH: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let slash = SLASH.get_or_init(|| Regex::new(r"^0*(\d+)\s*/\s*0*\d+").expect("slash collector regex"));
    if let Some(captures) = slash.captures(stripped) {
        return captures.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
    }
    static BARE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let bare = BARE.get_or_init(|| Regex::new(r"^0*(\d+)\b").expect("bare collector regex"));
    if let Some(captures) = bare.captures(stripped) {
        return captures.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
    }
    stripped.trim_start_matches('0').to_string()
}

fn facet_bits(condition: &str, language: &str, reverse: bool, first_edition: bool) -> String {
    let mut condition = clean_text(Some(condition), 20).to_uppercase();
    if condition.is_empty() {
        condition = "NM".into();
    }
    let condition = match condition.as_str() {
        "LP" => "SP".to_string(),
        "HP" => "PL".to_string(),
        _ => condition,
    };
    let lang = if language.is_empty() { "EN".to_string() } else { clean_text(Some(language), 10).to_uppercase() };
    format!("{condition}|{lang}|{}|{}", if reverse { "1" } else { "0" }, if first_edition { "1" } else { "0" })
}

pub fn stock_match_key(name: &str, collector: &str, condition: &str, language: &str, reverse: bool, first_edition: bool) -> String {
    let name = compact_key(name);
    if name.is_empty() {
        return String::new();
    }
    format!("{}|{}|{}", name, compact_collector(collector), facet_bits(condition, language, reverse, first_edition))
}

/// Pair CT products with PT rows (`reconcilePowerToolsWithCardTrader`).
pub struct CtMatch {
    pub matched: Vec<(NormalizedProduct, PowerToolsRow)>,
    pub ct_only: Vec<NormalizedProduct>,
    pub pt_only: Vec<PowerToolsRow>,
}

pub fn reconcile_power_tools_with_cardtrader(products: &[NormalizedProduct], pt_rows: Vec<PowerToolsRow>) -> CtMatch {
    let mut by_key: HashMap<String, Vec<PowerToolsRow>> = HashMap::new();
    for row in pt_rows {
        let key = stock_match_key(&row.name, &row.collector_number, &row.condition, &row.language, row.reverse, row.first_edition);
        if key.is_empty() {
            continue;
        }
        by_key.entry(key).or_default().push(row);
    }
    let mut matched = Vec::new();
    let mut ct_only = Vec::new();
    for product in products {
        if product.id.is_empty() {
            continue;
        }
        let key = stock_match_key(&product.name, &product.collector_number, product.condition, product.language, product.reverse, product.first_edition);
        if key.is_empty() {
            ct_only.push(product.clone());
            continue;
        }
        let set_hint = compact_key(&product.expansion_name);
        let bucket = by_key.get_mut(&key);
        let hit = match bucket {
            None => None,
            Some(bucket) if bucket.is_empty() => None,
            Some(bucket) => {
                let mut index = 0;
                if !set_hint.is_empty() {
                    if let Some(found) = bucket
                        .iter()
                        .position(|entry| !compact_key(&entry.set_name).is_empty() && compact_key(&entry.set_name) == set_hint)
                    {
                        index = found;
                    }
                }
                Some(bucket.remove(index))
            }
        };
        match hit {
            Some(pt) => matched.push((product.clone(), pt)),
            None => ct_only.push(product.clone()),
        }
    }
    let mut pt_only = Vec::new();
    for bucket in by_key.into_values() {
        pt_only.extend(bucket);
    }
    CtMatch { matched, ct_only, pt_only }
}

/// Distinct marketplace games in a CT export, most first.
pub fn games_from_cardtrader_products(products: &[NormalizedProduct]) -> Vec<Value> {
    let mut counts: HashMap<String, i64> = HashMap::new();
    for product in products {
        let game = marketplace_game_for_product(product);
        if game.is_empty() {
            continue;
        }
        *counts.entry(game.to_string()).or_insert(0) += 1;
    }
    let mut rows: Vec<(String, i64)> = counts.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    rows.into_iter().map(|(id, count)| json!({ "id": id, "count": count })).collect()
}

/// Caller-supplied CT client type for the sync path.
pub type CtClient = CardTraderClient;

#[cfg(test)]
mod tests {
    use crate::error::truthy;
    use super::*;

    #[test]
    fn session_token_cleaning() {
        assert_eq!(clean_session_token("abc.def.ghi").unwrap(), "abc.def.ghi");
        assert_eq!(clean_session_token("jwt=abc.def.ghi; other=1").unwrap(), "abc.def.ghi");
        assert!(clean_session_token("not a jwt").is_err());
        assert!(clean_session_token("").is_err());
    }

    #[test]
    fn set_cookie_extraction() {
        let lines = vec![
            "something=1; Path=/".to_string(),
            "jwt=the.jwt.value; Path=/; HttpOnly".to_string(),
            "jwt=deleted".to_string(),
        ];
        assert_eq!(jwt_from_set_cookie(&lines), "the.jwt.value");
        assert_eq!(jwt_from_set_cookie(&[]), "");
    }

    #[test]
    fn safe_user_drops_ct_tokens() {
        let user = json!({
            "_id": "u1",
            "username": "seller",
            "assignedCardtraderUser": {
                "cardtraderUserId": "42",
                "cardtraderUserName": "Seller CT",
                "cardtraderOAuthToken": "SECRET",
                "refreshToken": "SECRET",
            }
        });
        let safe = safe_power_tools_user(&user);
        assert_eq!(safe["userId"], "u1");
        assert_eq!(safe["cardtraderUserId"], "42");
        assert!(safe.to_string().find("SECRET").is_none());
    }

    #[test]
    fn throttle_blocks_after_five_failures_in_window() {
        let now = 1_000_000_000_i64;
        let data = json!({ "loginAttempts": { "windowStartMs": now - 1000, "failed": 5 } });
        assert!(login_throttle(&data, now).0);
        let fresh = json!({ "loginAttempts": { "windowStartMs": now - 3_700_000, "failed": 5 } });
        assert!(!login_throttle(&fresh, now).0);
        let none = json!({});
        assert!(!login_throttle(&none, now).0);
    }

    #[test]
    fn condition_and_language_maps() {
        assert_eq!(map_condition_from_cm("EX"), "SP");
        assert_eq!(map_condition_from_cm("GD"), "MP");
        assert_eq!(map_condition_from_cm(""), "NM");
        assert_eq!(map_language_from_name("English"), "EN");
        assert_eq!(map_language_from_name("Chinese (Trad.)"), "ZHT");
        assert_eq!(map_language_from_name("EN"), "EN");
        assert_eq!(map_language_from_name("Martian"), "EN");
    }

    #[test]
    fn finish_mapping() {
        assert_eq!(map_finish_from_power_tools("ReverseHolo", ""), ("reverse", true));
        assert_eq!(map_finish_from_power_tools("MasterballHolo", "true"), ("reverse", true));
        assert_eq!(map_finish_from_power_tools("CosmosHolo", ""), ("holo", false));
        assert_eq!(map_finish_from_power_tools("StampedHolo", ""), ("stamped", false));
        assert_eq!(map_finish_from_power_tools("Regular", ""), ("standard", false));
    }

    #[test]
    fn csv_parse_handles_quotes_and_crlf() {
        let text = "cardmarketId,name,location\r\n1,\"Charizard, Base\",\"box 1\"\r\n2,Bulbasaur,\r\n";
        let (headers, records) = parse_csv(text);
        assert_eq!(headers, vec!["cardmarketId", "name", "location"]);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["name"], "Charizard, Base");
        assert_eq!(records[1]["name"], "Bulbasaur");
    }

    #[test]
    fn location_parsing_modes() {
        // as_is keeps the whole string as the box.
        let (box_name, _, _, structured) = parse_power_tools_location("FUOCOBOMBA 006 - 16", "as_is");
        assert_eq!(box_name, "FUOCOBOMBA 006 - 16");
        assert!(!structured);
        // trailing_stack splits the trailing number as the stack index.
        let (box_name, stack, _, structured) = parse_power_tools_location("FUOCOBOMBA 006 - 16", "trailing_stack");
        assert_eq!(box_name, "FUOCOBOMBA 006");
        assert_eq!(stack, 16);
        assert!(structured);
        // structured ·stack·pos.
        let (box_name, stack, position, structured) = parse_power_tools_location("box·2·5", "auto");
        assert_eq!(box_name, "box");
        assert_eq!(stack, 2);
        assert_eq!(position, 5);
        assert!(structured);
    }

    #[test]
    fn location_assignment_overflow_and_suggestion() {
        let rows = vec![
            PowerToolsRow { name: "A".into(), location: "BOX1 5".into(), ..pt_row_defaults() },
            PowerToolsRow { name: "B".into(), location: "BOX1 5".into(), ..pt_row_defaults() },
            PowerToolsRow { name: "C".into(), location: "BOX1 5".into(), ..pt_row_defaults() },
        ];
        let assigned = assign_power_tools_locations(rows, 2, false, "trailing_stack");
        assert_eq!(assigned.rows.len(), 3);
        assert_eq!(assigned.suggested_stack_size, 3);
        assert_eq!(assigned.overflows.len(), 1);
        assert_eq!(assigned.overflows[0]["count"], 3);
        assert_eq!(assigned.overflows[0]["stackSize"], 2);
        assert_eq!(assigned.occupancy[0]["label"], "BOX1·5");
        // Locations carry box·stack.
        assert!(assigned.rows[0].location.starts_with("BOX1·5"));
    }

    fn pt_row_defaults() -> PowerToolsRow {
        PowerToolsRow {
            name: String::new(),
            set_name: String::new(),
            collector_number: String::new(),
            condition: "NM".into(),
            language: "EN".into(),
            reverse: false,
            first_edition: false,
            quantity: 1,
            price_pkn: None,
            seller_comment: String::new(),
            location: String::new(),
            box_name: String::new(),
            stack: 1,
            position: 1,
            source_location: String::new(),
        }
    }

    #[test]
    fn compact_collector_normalizes() {
        assert_eq!(compact_collector("069/101"), "69");
        assert_eq!(compact_collector("69/101"), "69");
        assert_eq!(compact_collector("Rare | 070/131"), "70");
        assert_eq!(compact_collector("07"), "7");
        assert_eq!(compact_collector(""), "");
    }

    #[test]
    fn ct_match_pairs_by_identity_and_facets() {
        let ct_product = crate::cardtrader::sync_core::normalize_product(&json!({
            "id": "1", "blueprint_id": "100", "game_id": 5, "quantity": 2, "price": 1.0,
            "name": "Pikachu",
            "properties": {"condition": "Near Mint", "pokemon_language": "en", "collector_number": "025/102"},
        }));
        let pt = PowerToolsRow {
            name: "Pikachu".into(),
            set_name: "Base Set".into(),
            collector_number: "25/102".into(),
            condition: "NM".into(),
            language: "EN".into(),
            reverse: false,
            first_edition: false,
            quantity: 2,
            price_pkn: Some(200.0),
            seller_comment: String::new(),
            location: "BOX·3".into(),
            box_name: String::new(),
            stack: 1,
            position: 1,
            source_location: String::new(),
        };
        let unmatched = PowerToolsRow { name: "Mew".into(), collector_number: "151".into(), ..pt_row_defaults() };
        let result = reconcile_power_tools_with_cardtrader(&[ct_product], vec![pt.clone(), unmatched]);
        assert_eq!(result.matched.len(), 1);
        assert_eq!(result.matched[0].1.location, "BOX·3");
        assert_eq!(result.ct_only.len(), 0);
        assert_eq!(result.pt_only.len(), 1);
        assert_eq!(result.pt_only[0].name, "Mew");
    }

    #[test]
    fn truthy_flag_shapes() {
        assert!(truthy_flag("TRUE"));
        assert!(truthy_flag("x"));
        assert!(!truthy_flag("false"));
        assert!(truthy(&json!(true)));
    }
}
