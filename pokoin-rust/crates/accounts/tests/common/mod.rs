//! Shared test harness: a scripted HTTP transport and a fixed RSA test key.
//!
//! The key is a throwaway 2048-bit RSA key generated for these tests only. It
//! is embedded (never loaded from the environment) so the suite is hermetic and
//! deterministic, and it signs the JWTs and JWKS responses the verifier checks.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pokoin_accounts::config::AccountsConfig;
use pokoin_accounts::http::{HttpRequest, HttpResponse, HttpTransport, SharedTransport, TransportError};
use pokoin_accounts::state::DomainState;

/// Test RSA private key (PKCS#8 PEM), 2048-bit. Tests only.
pub const TEST_PRIVATE_KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD20tACvD+3DEGA\nqHkHYQpdv92ol7BRMlRdpeLkHRKrAbXWJTQhQh0JzjHgpXf2/M5I94tRjzu6UQiA\nKtuCiHlKQGBXmqCoD3n/8Kuqy+4VPx4Q3sT8OJ2tfDWFO5/NClAn2v5mq1hOqL43\nBu/ji706tPZXg3EeI5uVXJCBEeJzdctOUyTlmnWzN7EMx2vu9KdT/eD1qUCShfuD\nw5ZMQ0BpI8+aD64pYed30YvhdO19brPjVEoJRaeV4YnbejyPlary2EeJESSs+k1w\nGxqNXtmyrpyQxlSfjx+83mKeEtl5HrwjAKZsutaGxq9om2MYLFll+Xwzb3Ua0vNt\nms3fnK8nAgMBAAECggEAdcnyKbQDpgvLwKXlqC9XvpifI+NL6dveZhiRuDHlpEU7\nLThw8cQ2zmSf6eidYPmRSkIUMvZrVwVvzJZnThpp45ToRTZOIBXOr2T/z5DljC8k\nXoGpOQKdwNprQitLnhKjYPnB+WYgzNz7dZAycAFSa09L1kSseWkdyQA1F9tcmaM3\n0/7w6xmxuCVVwHgjmYPoBBEJjxR6if4qiWfEYth6ic0zSSO7DeE52zpGoyzEnrKN\nXJEI71Wv3szo+bIwQeF4f/5xoeBHEFlK2Ujq46SCD4LT04JyKUWYTv1XGuvSepOc\npWjFLPkXy/Par55z9NSJ2Y+0Rwzm1ifYWBFFdavafQKBgQD+bPKmVwz4/2oLKk7t\nF20XjWEWTJ31a83kP0MVJ8mXnnj1R2qW9RCqcFotVCs4VSF8zTlsjADDm477RWTv\n+zcmejiCbfmiT9E+wLIjgIkeKCqmQlPcUWC1cBF9AmtHPX70yYa2E/cOiI2zEb+Q\nbgS0gYuam9NvE3JbTHjstz0ZFQKBgQD4WdJcbpFPptM187W5pvUyD/PXbKPmUx9v\nNchDRdb2+sqBNvMgvlLaYle8/6ZgFnGlxoUZLo3Q48cfMxWhiunNz9wP3jCPlyFH\nmeeuOY9xjcYuxjI3xk6WREpffUmiGdnLYGO3CxzOgQ0rJbNapBf64u9Zia9NCCt4\ntfYDoGZ+SwKBgFTjMMqC/NcPEOiMwyyjxkg3aY8xHPrHbziaSt2CGua1fxIHM+8N\n8POM7Ol2zbzL2pJzPpeS1qZs/nWjn5vaK3pxCO2rl8Cp9NyFGmpx9k3ThPdX5fb6\nR9QBgjQ9XGG2iOdPXdzeKG327aAzacDclEFNf7CkERVcXalMiIQiVwZJAoGBAJLY\nkZED87n0O4j4PKi0tuDOG/FyFIuY9MpOM8bLYesRqXGz6xieUOE+KwDe7SJ9wt8x\nvfuA0mwEcvXYv96QA+UlFcrwJyiQRSZQM3SKJm4PVXLM0F64TDl/0bYan9JQlL4z\nlWJjGLpmBkJP/XgH9QHs83eu+M+EmCe89+V3D4N3AoGAdBWaPAF/MwK/ciXe8RfS\neEbhd8VKbFW6ndq6GNulc3WSMoEJTq07xxp1pacMfq7bf5Xwg1S12JvDZ0jImZ8w\njR0IIu2C5oK1Lnw3ezrT7PhFGDat2WwpYnIU+jONSiHfbr+Wsc033X/IapF/qgnL\ngsdyWp4uB9OkddMPoWfVR0M=\n-----END PRIVATE KEY-----";

/// base64url modulus of [`TEST_PRIVATE_KEY_PEM`].
pub const TEST_KEY_N: &str = "9tLQArw_twxBgKh5B2EKXb_dqJewUTJUXaXi5B0SqwG11iU0IUIdCc4x4KV39vzOSPeLUY87ulEIgCrbgoh5SkBgV5qgqA95__CrqsvuFT8eEN7E_DidrXw1hTufzQpQJ9r-ZqtYTqi-Nwbv44u9OrT2V4NxHiOblVyQgRHic3XLTlMk5Zp1szexDMdr7vSnU_3g9alAkoX7g8OWTENAaSPPmg-uKWHnd9GL4XTtfW6z41RKCUWnleGJ23o8j5Wq8thHiREkrPpNcBsajV7Zsq6ckMZUn48fvN5inhLZeR68IwCmbLrWhsavaJtjGCxZZfl8M291GtLzbZrN35yvJw";

/// base64url exponent of [`TEST_PRIVATE_KEY_PEM`].
pub const TEST_KEY_E: &str = "AQAB";

/// A signing key id; the verifier must look it up in the JWKS.
pub const TEST_KID: &str = "test-key-1";

pub const TEST_PROJECT: &str = "pokoin-test";
pub const TEST_CLIENT_EMAIL: &str = "test@pokoin-test.iam.gserviceaccount.com";

type Handler = Box<dyn Fn(&HttpRequest) -> HttpResponse + Send + Sync>;

struct Route {
    url_contains: String,
    method: Option<String>,
    handler: Handler,
}

/// A transport that answers from an in-process routing table. Every request is
/// recorded so tests can assert on the exact wire call.
pub struct ScriptedTransport {
    routes: Mutex<Vec<Route>>,
    requests: Mutex<Vec<HttpRequest>>,
    fallback: Mutex<Option<Handler>>,
}

impl ScriptedTransport {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            routes: Mutex::new(Vec::new()),
            requests: Mutex::new(Vec::new()),
            fallback: Mutex::new(None),
        })
    }

    pub fn on<F>(&self, url_contains: &str, handler: F) -> &Self
    where
        F: Fn(&HttpRequest) -> HttpResponse + Send + Sync + 'static,
    {
        self.routes.lock().unwrap().push(Route {
            url_contains: url_contains.to_string(),
            method: None,
            handler: Box::new(handler),
        });
        self
    }

    pub fn on_method<F>(&self, method: &str, url_contains: &str, handler: F) -> &Self
    where
        F: Fn(&HttpRequest) -> HttpResponse + Send + Sync + 'static,
    {
        self.routes.lock().unwrap().push(Route {
            url_contains: url_contains.to_string(),
            method: Some(method.to_ascii_uppercase()),
            handler: Box::new(handler),
        });
        self
    }

    pub fn on_json(&self, url_contains: &str, status: u16, body: serde_json::Value) -> &Self {
        self.on(url_contains, move |_| HttpResponse::json(status, body.clone()))
    }

    pub fn set_fallback<F>(&self, handler: F) -> &Self
    where
        F: Fn(&HttpRequest) -> HttpResponse + Send + Sync + 'static,
    {
        *self.fallback.lock().unwrap() = Some(Box::new(handler));
        self
    }

    pub fn requests(&self) -> Vec<HttpRequest> {
        self.requests.lock().unwrap().clone()
    }

    pub fn requests_to(&self, url_contains: &str) -> Vec<HttpRequest> {
        self.requests()
            .into_iter()
            .filter(|request| request.url.contains(url_contains))
            .collect()
    }

    pub fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    pub fn clear_requests(&self) {
        self.requests.lock().unwrap().clear();
    }

    pub fn as_transport(self: &Arc<Self>) -> SharedTransport {
        self.clone()
    }
}

#[async_trait::async_trait]
impl HttpTransport for ScriptedTransport {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let response = {
            let routes = self.routes.lock().unwrap();
            routes
                .iter()
                .find(|route| {
                    request.url.contains(&route.url_contains)
                        && route
                            .method
                            .as_ref()
                            .map(|method| method.eq_ignore_ascii_case(&request.method))
                            .unwrap_or(true)
                })
                .map(|route| (route.handler)(&request))
        };
        self.requests.lock().unwrap().push(request.clone());
        if let Some(response) = response {
            return Ok(response);
        }
        if let Some(fallback) = self.fallback.lock().unwrap().as_ref() {
            return Ok(fallback(&request));
        }
        Ok(HttpResponse::json(
            599,
            serde_json::json!({
                "error": { "message": format!("unscripted request: {} {}", request.method, request.url) }
            }),
        ))
    }
}

pub fn oauth_response(token: &str, expires_in: i64) -> HttpResponse {
    HttpResponse::json(
        200,
        serde_json::json!({ "access_token": token, "expires_in": expires_in, "token_type": "Bearer" }),
    )
}

pub fn jwks_response() -> HttpResponse {
    HttpResponse::json(
        200,
        serde_json::json!({
            "keys": [{ "kty": "RSA", "alg": "RS256", "use": "sig", "kid": TEST_KID, "n": TEST_KEY_N, "e": TEST_KEY_E }]
        }),
    )
}

pub fn test_config() -> AccountsConfig {
    AccountsConfig {
        project_id: TEST_PROJECT.into(),
        client_email: TEST_CLIENT_EMAIL.into(),
        private_key_pem: TEST_PRIVATE_KEY_PEM.to_string(),
        jwks_url: "https://test.local/jwks".into(),
        oauth_token_url: "https://test.local/oauth".into(),
        firestore_base: format!(
            "https://test.local/v1/projects/{TEST_PROJECT}/databases/(default)/documents"
        ),
        identity_base: "https://test.local/v1".into(),
        public_site_url: "https://pokoin.test".into(),
        ..Default::default()
    }
}

/// A `DomainState` over the scripted transport, with the OAuth exchange and
/// JWKS pre-scripted so any Firebase-backed route can run.
pub fn test_state(transport: &Arc<ScriptedTransport>) -> DomainState {
    transport.on_json(
        "https://test.local/oauth",
        200,
        serde_json::json!({ "access_token": "test-access-token", "expires_in": 3600 }),
    );
    transport.on("https://test.local/jwks", |_| jwks_response());
    DomainState::with_transport(test_config(), transport.as_transport())
}

pub fn unconfigured_state() -> DomainState {
    let transport = ScriptedTransport::new();
    let mut config = test_config();
    config.project_id = String::new();
    config.client_email = String::new();
    config.private_key_pem = String::new();
    DomainState::with_transport(config, transport.as_transport())
}

/// Sign a Firebase-shaped ID token with the test key.
pub fn sign_id_token(claims: serde_json::Value) -> String {
    use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(TEST_KID.to_string());
    encode(
        &header,
        &claims,
        &EncodingKey::from_rsa_pem(TEST_PRIVATE_KEY_PEM.as_bytes()).expect("test key parses"),
    )
    .expect("signing works")
}

pub fn id_token_claims(sub: &str, email: &str, now: i64) -> serde_json::Value {
    serde_json::json!({
        "iss": format!("https://securetoken.google.com/{TEST_PROJECT}"),
        "aud": TEST_PROJECT,
        "sub": sub,
        "user_id": sub,
        "email": email,
        "email_verified": true,
        "iat": now,
        "exp": now + 3600,
        "auth_time": now,
        "firebase": { "sign_in_provider": "password", "identities": {} }
    })
}

pub fn auth_header(token: &str) -> HashMap<String, String> {
    HashMap::from([("authorization".to_string(), format!("Bearer {token}"))])
}

pub fn test_timeout() -> Duration {
    Duration::from_secs(2)
}

/// A `DomainState` whose Postgres read model is *lazily* configured, so the
/// SQL-backed routes get past the "not configured" guard without a server.
/// A test that never reaches a SQL query needs no database at all.
pub fn test_state_with_db(transport: &Arc<ScriptedTransport>) -> DomainState {
    let state = test_state(transport);
    let db = pokoin_accounts::sql::MarketplaceDb::connect_lazy(
        "postgres://127.0.0.1:1/pokoin_test",
        1,
    )
    .expect("a lazy pool never connects");
    state.with_marketplace_db(Some(db))
}
