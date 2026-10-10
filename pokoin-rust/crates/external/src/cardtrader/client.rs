//! CardTrader API v2 client — native port of `_cardtrader_client.js`.
//! Token cleaning, the 401/403 error ladder, /info normalization, product
//! CRUD, seller-order paging, and app webhook updates.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use regex::Regex;
use reqwest::Method;
use serde_json::{json, Value};

use crate::error::{clean_text, ApiError, ApiResult};
use crate::firebase::decode_jwt_segment;

pub const CARDTRADER_API_BASE_URL: &str = "https://api.cardtrader.com/api/v2";
pub const PKN_USDT_PRICE: f64 = 0.005;

/// CardTrader names a 1-Day Ready app "<user> 1-Day Ready App <stamp>".
pub fn is_one_day_ready_name(name: &str) -> bool {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:1|one)[\s-]*day[\s-]*ready\b").expect("1dr regex")
    })
    .is_match(name)
}

/// `cleanToken` — strip copy noise (soft hyphen, ZWSP, quotes, BOM), find the
/// JWT inside wrapped text, or peel a pasted "Bearer " prefix.
pub fn clean_token(value: &str) -> String {
    static NOISE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static JWT: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static BEARER: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static QUOTES: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let noise = NOISE.get_or_init(|| {
        Regex::new(r"[\s\x{00AD}\x{200B}-\x{200D}\x{2060}\x{FEFF}]").expect("noise regex")
    });
    let jwt_re = JWT.get_or_init(|| Regex::new(r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").expect("jwt regex"));
    let compact: String = noise.replace_all(value, "").to_string();
    if let Some(found) = jwt_re.find(&compact) {
        return found.as_str().to_string();
    }
    let bearer = BEARER.get_or_init(|| Regex::new(r"(?i)^(?:authorization:)?bearer").expect("bearer regex"));
    let without_bearer = bearer.replace(&compact, "").to_string();
    let quotes = QUOTES.get_or_init(|| {
        Regex::new(r#"^["'`]+|["'`]+$"#).expect("quote regex")
    });
    quotes.replace_all(&without_bearer, "").to_string()
}

/// Non-secret token fingerprint for logs (`tokenFingerprint`).
pub fn token_fingerprint(token: &str) -> Value {
    let parts: Vec<&str> = token.split('.').collect();
    let header = if parts.len() == 3 { decode_jwt_segment(parts[0]) } else { None };
    let claims = header.as_ref().and_then(|_h| decode_jwt_segment(parts.get(1).copied().unwrap_or("")));
    let jwt = header.is_some() && claims.is_some();
    let alg = clean_text(header.as_ref().and_then(|h| h.get("alg")).and_then(Value::as_str), 20);
    let signature_bytes = if jwt { URL_SAFE_NO_PAD.decode(parts[2]).map(|b| b.len()).unwrap_or(0) } else { 0 };
    let rsa_alg = {
        static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
        RE.get_or_init(|| Regex::new(r"^(RS|PS)\d+$").expect("rsa alg regex"))
    };
    let complete = jwt && (if rsa_alg.is_match(&alg) { [256usize, 384, 512].contains(&signature_bytes) } else { signature_bytes > 0 });
    json!({
        "length": token.len(),
        "sha256": crate::crypto::sha256_hex(token.as_bytes()).get(..12).unwrap_or_default(),
        "jwt": jwt,
        "complete": complete,
        "alg": alg,
        "sub": clean_text(claims.as_ref().and_then(|c| c.get("sub")).and_then(Value::as_str), 80),
        "name": clean_text(claims.as_ref().and_then(|c| c.get("name")).and_then(Value::as_str), 160),
        "signatureBytes": signature_bytes,
    })
}

/// `normalizeInfo` — flat or nested /info payload into the stable shape.
pub fn normalize_info(info: &Value) -> Value {
    let user = info.get("user").filter(|v| v.is_object()).cloned().unwrap_or(json!({}));
    let app = info.get("app").filter(|v| v.is_object()).cloned().unwrap_or(json!({}));
    let pick = |keys: &[&str]| -> String {
        for key in keys {
            if let Some(value) = info.get(*key) {
                let text = clean_text(value.as_str(), 240);
                if !text.is_empty() {
                    return text;
                }
            }
        }
        String::new()
    };
    let app_name_source = app
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            ["app_name", "name"]
                .iter()
                .find_map(|key| info.get(*key).and_then(Value::as_str).map(str::to_string))
        })
        .unwrap_or_default();
    let app_name = clean_text(Some(&app_name_source), 160);
    let app_id_source = ["app_id", "id"]
        .iter()
        .find_map(|key| app.get(*key).or_else(|| info.get(*key)))
        .and_then(crate::error::scalar_text)
        .unwrap_or_default();
    let user_id_source = user
        .get("id")
        .or_else(|| info.get("user_id"))
        .and_then(crate::error::scalar_text)
        .unwrap_or_default();
    let email = user
        .get("email")
        .or_else(|| info.get("email"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let username = ["username", "name"]
        .iter()
        .find_map(|key| user.get(*key).and_then(Value::as_str))
        .filter(|s| !clean_text(Some(s), 160).is_empty())
        .or_else(|| info.get("username").and_then(Value::as_str))
        .unwrap_or_default();
    let scopes = info
        .get("scopes")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|s| clean_text(s.as_str(), 80))
                .filter(|s| !s.is_empty())
                .take(50)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let seller_id_text = info
        .get("seller_id")
        .filter(|v| !v.is_null())
        .or_else(|| user.get("seller_id"))
        .map(|v| crate::error::clean_text_value(v, 80))
        .unwrap_or_default();
    let seller_id = seller_id_text.as_str();
    let seller_name = info
        .get("seller_name")
        .and_then(Value::as_str)
        .or_else(|| user.get("seller_name").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "app": { "id": clean_text(Some(&app_id_source), 80), "name": app_name.clone() },
        "oneDayReady": is_one_day_ready_name(&app_name),
        "user": {
            "id": clean_text(Some(&user_id_source), 80),
            "email": clean_text(Some(&email), 320),
            "username": clean_text(Some(username), 160),
        },
        "scopes": scopes,
        "seller": {
            "id": clean_text(Some(seller_id), 80),
            "name": clean_text(Some(seller_name), 160),
        },
        "sharedSecret": pick(&["shared_secret"]),
    })
}

/// `safeInfoMetadata` — non-secret subset persisted on the integration doc.
pub fn safe_info_metadata(info: &Value) -> Value {
    json!({
        "app": info.get("app").cloned().unwrap_or(json!({})),
        "user": info.get("user").cloned().unwrap_or(json!({})),
        "scopes": info.get("scopes").and_then(Value::as_array).cloned().unwrap_or_default(),
        "seller": info.get("seller").cloned().unwrap_or(json!({})),
        "oneDayReady": info.get("oneDayReady") == Some(&Value::Bool(true)),
    })
}

#[derive(Clone)]
pub struct CardTraderClient {
    base: String,
    http: reqwest::Client,
}

impl Default for CardTraderClient {
    fn default() -> Self {
        Self::new()
    }
}

impl CardTraderClient {
    pub fn new() -> Self {
        let base = std::env::var("CARDTRADER_API_BASE_URL")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| CARDTRADER_API_BASE_URL.to_string());
        Self {
            base: base.trim_end_matches('/').to_string(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .expect("reqwest client"),
        }
    }

    /// Test seam: fixed base URL and transport.
    pub fn with_base(base: String) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .expect("reqwest client"),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// `cardTraderRequest` — one JSON call with the reference error ladder.
    pub async fn request(&self, path: &str, token: &str, method: Method, body: Option<Value>) -> ApiResult<Value> {
        let clean_path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };
        let token = clean_token(token);
        let mut request = self
            .http
            .request(method, format!("{}{}", self.base, clean_path))
            .header("Accept", "application/json")
            .header("Authorization", format!("Bearer {token}"));
        if let Some(payload) = body {
            request = request
                .header("Content-Type", "application/json")
                .json(&payload);
        }
        // No answer: CardTrader may still have applied a write (TRANSPORT_ERROR).
        let response = request
            .send()
            .await
            .map_err(|e| ApiError::new(502, format!("CardTrader request failed: {e}")).with_code(TRANSPORT_ERROR))?;
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        let payload: Option<Value> = if text.trim().is_empty() { None } else { serde_json::from_str(&text).ok() };
        if status >= 400 {
            return Err(cardtrader_response_error(status, payload.as_ref(), &clean_path, &token));
        }
        Ok(payload.unwrap_or(Value::Null))
    }

    pub async fn get(&self, path: &str, token: &str) -> ApiResult<Value> {
        self.request(path, token, Method::GET, None).await
    }

    pub async fn validate_token(&self, token: &str) -> ApiResult<Value> {
        let clean = clean_token(token);
        if clean.len() < 16 {
            return Err(ApiError::bad_request("Enter a valid CardTrader API token."));
        }
        let info = self.get("/info", &clean).await?;
        Ok(normalize_info(&info))
    }

    /// `fetchProductsExport` — never coerce a non-array into [].
    pub async fn fetch_products_export(&self, token: &str) -> ApiResult<Vec<Value>> {
        let payload = self.get("/products/export", token).await?;
        match payload {
            Value::Array(rows) => Ok(rows),
            _ => Err(ApiError::new(502, "CardTrader products/export did not return an array.")),
        }
    }

    pub async fn fetch_marketplace_products(&self, token: &str, params: &[(&str, &str)]) -> ApiResult<Value> {
        let query: Vec<String> = params.iter().map(|(k, v)| format!("{k}={v}")).collect();
        let suffix = if query.is_empty() { String::new() } else { format!("?{}", query.join("&")) };
        let payload = self.get(&format!("/marketplace/products{suffix}"), token).await?;
        Ok(if payload.is_object() { payload } else { json!({}) })
    }

    pub async fn fetch_seller_orders(
        &self,
        token: &str,
        from: &str,
        state: &str,
        page_size: u32,
        max_pages: u32,
    ) -> ApiResult<Vec<Value>> {
        let mut orders = Vec::new();
        for page in 1..=max_pages {
            let mut suffix = format!("?order_as=seller&sort=date.desc&limit={page_size}&page={page}");
            if !from.is_empty() {
                suffix.push_str(&format!("&from={from}"));
            }
            if !state.is_empty() {
                suffix.push_str(&format!("&state={state}"));
            }
            let payload = self.get(&format!("/orders{suffix}"), token).await?;
            let rows = match payload {
                Value::Array(rows) => rows,
                _ => return Err(ApiError::new(502, "CardTrader orders did not return an array.")),
            };
            let filled = rows.len();
            orders.extend(rows);
            if filled < page_size as usize {
                break;
            }
        }
        Ok(orders)
    }

    pub async fn update_app_webhook_url(&self, token: &str, webhook_url: &str) -> ApiResult<Value> {
        self.request(
            "/app",
            token,
            Method::PATCH,
            Some(json!({ "webhook_url": webhook_url })),
        )
        .await
    }

    pub async fn create_product(&self, token: &str, payload: Value) -> ApiResult<Value> {
        self.request("/products", token, Method::POST, Some(payload)).await
    }

    pub async fn update_product(&self, token: &str, product_id: &str, payload: Value) -> ApiResult<Value> {
        self.request(&format!("/products/{}", urlencode(product_id)), token, Method::PUT, Some(payload)).await
    }

    pub async fn increment_product(&self, token: &str, product_id: &str, delta: i64) -> ApiResult<Value> {
        self.request(
            &format!("/products/{}/increment", urlencode(product_id)),
            token,
            Method::POST,
            Some(json!({ "delta_quantity": delta })),
        )
        .await
    }

    pub async fn destroy_product(&self, token: &str, product_id: &str) -> ApiResult<Value> {
        self.request(&format!("/products/{}", urlencode(product_id)), token, Method::DELETE, None).await
    }

    pub async fn add_product_to_cart(&self, token: &str, payload: Value) -> ApiResult<Value> {
        self.request("/cart/add", token, Method::POST, Some(payload)).await
    }

    pub async fn purchase_cart(&self, token: &str) -> ApiResult<Value> {
        self.request("/cart/purchase", token, Method::POST, Some(json!({}))).await
    }

    pub async fn fetch_cart(&self, token: &str) -> ApiResult<Value> {
        let payload = self.get("/cart", token).await?;
        Ok(if payload.is_object() { payload } else { json!({}) })
    }
}

fn urlencode(value: &str) -> String {
    crate::crypto::uri_encode(value, true)
}

/// `cardTraderResponseError` — the exact status/hint ladder.
fn cardtrader_response_error(status: u16, payload: Option<&Value>, path: &str, token: &str) -> ApiError {
    let error_code = payload
        .and_then(|p| p.get("error_code"))
        .and_then(Value::as_str)
        .map(|s| clean_text(Some(s), 80))
        .unwrap_or_default();
    // 403 without a JSON error body is an edge block, not a token verdict.
    if status == 403 && error_code.is_empty() {
        return ApiError::new(
            502,
            "CardTrader blocked the request from Pokoin (HTTP 403). Try again in a few minutes.",
        )
        .with_code("cardtrader_blocked");
    }
    if status == 401 || status == 403 {
        let fingerprint = token_fingerprint(token);
        let complete = fingerprint.get("complete") == Some(&Value::Bool(true));
        let hint = if complete {
            "Copy the current token from your CardTrader settings; regenerating it there stops older tokens working."
        } else {
            "The pasted value is not a complete CardTrader token. Clear the field and paste it again with CardTrader's Copy button."
        };
        return ApiError::new(400, format!("CardTrader rejected this API token (HTTP {status}). {hint}"))
            .with_code("cardtrader_token_rejected");
    }
    tracing::warn!(path, status, "cardtrader request failed");
    ApiError::new(502, format!("CardTrader request failed with HTTP {status}.")).with_code(format!("{HTTP_ERROR_PREFIX}{status}"))
}

/// Error code of a request that got no HTTP answer.
pub const TRANSPORT_ERROR: &str = "cardtrader_transport";
/// Error code prefix of an HTTP error answer (`cardtrader_http_422`).
pub const HTTP_ERROR_PREFIX: &str = "cardtrader_http_";

/// Whether a failed write may still have happened on CardTrader: no answer at
/// all, or a 5xx. A 4xx answer, a rejected token or an edge block did nothing.
pub fn write_in_doubt(error: &ApiError) -> bool {
    match error.code.as_deref() {
        Some(TRANSPORT_ERROR) => true,
        Some(code) => code
            .strip_prefix(HTTP_ERROR_PREFIX)
            .and_then(|status| status.parse::<u16>().ok())
            .is_some_and(|status| status >= 500),
        None => false,
    }
}

/// `cardTraderWebhookUrlForUid`.
pub fn cardtrader_webhook_url_for_uid(uid: &str) -> String {
    let base = std::env::var("CARDTRADER_WEBHOOK_BASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "https://api.pokoin.com".into());
    let base = base.trim().trim_end_matches('/');
    let clean = clean_text(Some(uid), 160);
    if clean.is_empty() {
        return String::new();
    }
    format!("{}/api/cardtrader-webhook/{}", base, urlencode(&clean))
}

/// `importDryRunSummary`.
pub fn import_dry_run_summary(products: &[Value]) -> Value {
    json!({
        "productCount": products.len(),
        "sample": products.iter().take(10).map(safe_product_sample).collect::<Vec<_>>(),
    })
}

fn safe_product_sample(row: &Value) -> Value {
    let blueprint = row.get("blueprint").filter(|v| v.is_object()).cloned().unwrap_or_default();
    json!({
        "id": crate::error::clean_text_value(row.get("id").unwrap_or(&Value::Null), 80),
        "blueprintId": clean_text(
            Some(&crate::error::clean_text_value(row.get("blueprint_id").or_else(|| row.get("blueprintId")).unwrap_or(&Value::Null), 80)), 80),
        "name": clean_text(
            Some(
                row.get("name")
                    .and_then(Value::as_str)
                    .or_else(|| blueprint.get("name").and_then(Value::as_str))
                    .unwrap_or_default(),
            ),
            240),
        "quantity": crate::error::f64_field(row, &["quantity", "qty"]).unwrap_or(0.0),
        "priceCents": crate::error::f64_field(row, &["price_cents", "priceCents"]).unwrap_or(0.0),
        "state": clean_text(row.get("state").and_then(Value::as_str), 80),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_cleaning_matches_reference() {
        assert_eq!(clean_token("  eyJhbGciOi.eyJzdWIiOiJ9.sig  "), "eyJhbGciOi.eyJzdWIiOiJ9.sig");
        assert_eq!(clean_token("Bearer abc.def"), "abc.def");
        assert_eq!(clean_token(r#""tok""#), "tok");
        // Wrapped textarea copy keeps the inner JWT. The reference strips
        // whitespace/ZWSP first, so a base64url tail glued to the signature is
        // part of the greedy match (verified against _cardtrader_client.js).
        let wrapped = "blah eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP \u{200B}more";
        assert_eq!(clean_token(wrapped), "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmore");
        // A non-base64url boundary stops the match.
        let bounded = "blah eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP\"more";
        assert_eq!(clean_token(bounded), "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP");
        assert_eq!(clean_token(""), "");
    }

    #[test]
    fn one_day_ready_names() {
        assert!(is_one_day_ready_name("Test Seller 1-Day Ready App 262"));
        assert!(is_one_day_ready_name("one day ready app"));
        assert!(!is_one_day_ready_name("Test Seller App"));
    }

    #[test]
    fn normalize_info_flat_and_nested() {
        let flat = json!({"id": "77", "name": "Seller 1-Day Ready App x", "user_id": "u1", "shared_secret": "s3cr3t"});
        let normalized = normalize_info(&flat);
        assert_eq!(normalized["app"]["id"], "77");
        assert_eq!(normalized["oneDayReady"], true);
        assert_eq!(normalized["user"]["id"], "u1");
        assert_eq!(normalized["sharedSecret"], "s3cr3t");

        let nested = json!({"app": {"id": "9", "name": "Plain App"}, "user": {"id": "5", "email": "A@B.C", "username": "sel"}});
        let normalized = normalize_info(&nested);
        assert_eq!(normalized["oneDayReady"], false);
        assert_eq!(normalized["user"]["email"], "a@b.c");
        assert_eq!(normalized["user"]["username"], "sel");
    }

    #[test]
    fn fingerprint_shape() {
        let header = URL_SAFE_NO_PAD.encode(json!({"alg": "RS256"}).to_string());
        let claims = URL_SAFE_NO_PAD.encode(json!({"sub": "42", "name": "app"}).to_string());
        let signature = URL_SAFE_NO_PAD.encode(vec![0u8; 256]);
        let token = format!("{header}.{claims}.{signature}");
        let fingerprint = token_fingerprint(&token);
        assert_eq!(fingerprint["jwt"], true);
        assert_eq!(fingerprint["complete"], true);
        assert_eq!(fingerprint["signatureBytes"], 256);
    }

    #[test]
    fn webhook_url_shape() {
        std::env::set_var("CARDTRADER_WEBHOOK_BASE_URL", "https://api.pokoin.com/");
        assert_eq!(
            cardtrader_webhook_url_for_uid("uid 1"),
            "https://api.pokoin.com/api/cardtrader-webhook/uid%201"
        );
        assert_eq!(cardtrader_webhook_url_for_uid(""), "");
        std::env::remove_var("CARDTRADER_WEBHOOK_BASE_URL");
    }
}
