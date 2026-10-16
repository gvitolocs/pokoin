//! Social autopost routes — native port of social-autopost.js,
//! social-autopost-hot-card.js and social-post-agent.js.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::Uri;
use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::{json, Value};

use crate::error::{clean_text, header_value, json_response, ApiError, ApiResult};
use crate::routes::util::{body_json, preflight as shared_preflight, query_first, require_token};
use crate::social::{self, SocialConfig};
use crate::state::DomainState;

async fn config(_state: &DomainState) -> ApiResult<SocialConfig> {
    // Production `DomainState::from_env` already refuses a non-durable
    // Firestore, so this only builds the env-driven provider wiring.
    Ok(SocialConfig::from_env())
}

fn configured_admins() -> Vec<String> {
    let mut admins = Vec::new();
    for name in ["SEARCH_DEBUG_ADMINS", "POKOIN_ADMIN_EMAILS", "SOCIAL_AUTOPOST_ADMINS"] {
        let raw = std::env::var(name).unwrap_or_default();
        for value in raw.split(',') {
            let lowered = value.trim().to_lowercase();
            if !lowered.is_empty() {
                admins.push(lowered);
            }
        }
    }
    admins
}

/// A Firebase identity is a social admin only by a *verified* email on the
/// configured list: an unverified token can carry any address.
fn is_admin_identity(identity: &crate::firebase::DecodedToken, admins: &[String]) -> bool {
    identity
        .verified_email()
        .is_some_and(|email| admins.iter().any(|admin| admin == &email))
}

/// `authorizeSocialRequest` — shared secret / CRON secret / Firebase admin.
async fn authorize(
    state: &DomainState,
    headers: &HeaderMap,
) -> ApiResult<(String, Option<String>)> {
    let config = SocialConfig::from_env();
    let supplied_secret = header_value(headers, "x-pokoin-social-secret");
    let supplied_secret = if supplied_secret.is_empty() {
        header_value(headers, "x-social-autopost-secret")
    } else {
        supplied_secret
    };
    let supplied_secret = if supplied_secret.is_empty() {
        header_value(headers, "x-social-autopst-secret")
    } else {
        supplied_secret
    };
    let authorization = header_value(headers, "authorization");
    let bearer = authorization
        .strip_prefix("Bearer ")
        .or_else(|| authorization.strip_prefix("bearer "))
        .map(|value| value.trim().to_string())
        .unwrap_or_default();

    let secret_match = !config.social_secret.is_empty()
        && (crate::crypto::constant_time_eq(supplied_secret.as_bytes(), config.social_secret.as_bytes())
            || crate::crypto::constant_time_eq(bearer.as_bytes(), config.social_secret.as_bytes()));
    if secret_match {
        return Ok(("shared_secret".to_string(), None));
    }
    if !config.cron_secret.is_empty()
        && crate::crypto::constant_time_eq(bearer.as_bytes(), config.cron_secret.as_bytes())
    {
        return Ok(("cron_secret".to_string(), None));
    }

    match require_token(state, headers).await {
        Ok(identity) => {
            if is_admin_identity(&identity, &configured_admins()) {
                return Ok(("firebase_admin".to_string(), Some(identity.uid)));
            }
            Err(ApiError::new(403, "Social autoposter access denied."))
        }
        Err(_) => Err(ApiError::new(401, "Social autoposter access denied.")),
    }
}

/// `OPTIONS` preflight for the social routes.
pub async fn preflight() -> Response {
    shared_preflight().await
}

/// `POST /api/social-autopost`.
pub async fn autopost(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let (authorized_by, _uid) = authorize(&state, &headers).await?;
    let config = config(&state).await?;
    let payload = body_json(&body).await?;
    let targets = social::clean_targets(payload.get("targets").or_else(|| payload.get("target")))?;
    let use_agent = social::bool_value(payload.get("useAgent").or_else(|| payload.get("agent")), true);
    let content = resolve_manual_post_input(&state, &config, &payload, &targets, use_agent).await?;
    let dry_run = social::bool_value(payload.get("dryRun"), false);
    let send_photo = social::bool_value(payload.get("sendPhoto"), true);
    let silent = social::bool_value(payload.get("silent"), false);
    let post_result = social::post_to_targets(&config, &targets, &content, dry_run, send_photo, silent).await;
    let ok = post_result.get("ok") == Some(&Value::Bool(true));
    Ok(json_response(
        if ok { 200 } else { 502 },
        json!({
            "ok": ok,
            "dryRun": dry_run,
            "authorizedBy": authorized_by,
            "targets": targets,
            "post": {
                "text": content.get("text"),
                "xText": content.get("xText"),
                "cardUrl": content.get("cardUrl"),
                "imageUrl": content.get("imageUrl"),
            },
            "agent": content.get("agent"),
            "results": post_result.get("results"),
        }),
    ))
}

/// `GET|POST /api/social-autopost/hot-card`.
pub async fn hot_card(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> ApiResult<Response> {
    let (authorized_by, _uid) = authorize(&state, &headers).await?;
    let config = config(&state).await?;
    let payload = if body.is_empty() { json!({}) } else { body_json(&body).await? };
    let query = |key: &str| -> Option<Value> { query_first(&uri, key).map(Value::String) };
    let source = |key: &str| -> Option<Value> {
        payload.get(key).cloned().or_else(|| query(key))
    };
    let targets_value = source("targets").or_else(|| source("target"));
    let targets = social::clean_targets(targets_value.as_ref())?;
    let window = source("window").and_then(|value| value.as_str().map(|s| s.to_string())).unwrap_or_default();
    let limit = source("limit").and_then(|value| match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.parse::<i64>().ok(),
        _ => None,
    });
    let Some(card) = social::select_hot_card(&state.db, &window, limit).await? else {
        return Err(ApiError::not_found(
            "No hot marketplace card is available for autoposting.",
        ));
    };
    let hook = source("hook")
        .and_then(|value| value.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "Hot on Pokoin right now:".to_string());
    let message = source("message").or_else(|| source("text"));
    let hashtags = source("hashtags");
    let agent_value = source("useAgent").or_else(|| source("agent"));
    let use_agent = social::bool_value(agent_value.as_ref(), true);
    let input = json!({
        "hook": hook,
        "message": message,
        "hashtags": hashtags,
        "card": card,
        "context": { "source": "hot-card", "window": social::clean_window(&window) },
    });
    let content = social::content_with_optional_agent(&config, &input, &targets, use_agent).await;
    let dry_run = social::bool_value(source("dryRun").as_ref(), false);
    let send_photo = social::bool_value(source("sendPhoto").as_ref(), true);
    let silent = social::bool_value(source("silent").as_ref(), false);
    let post_result = social::post_to_targets(&config, &targets, &content, dry_run, send_photo, silent).await;
    let ok = post_result.get("ok") == Some(&Value::Bool(true));
    Ok(json_response(
        if ok { 200 } else { 502 },
        json!({
            "ok": ok,
            "dryRun": dry_run,
            "authorizedBy": authorized_by,
            "window": social::clean_window(&window),
            "targets": targets,
            "card": card,
            "post": {
                "text": content.get("text"),
                "xText": content.get("xText"),
                "cardUrl": content.get("cardUrl"),
                "imageUrl": content.get("imageUrl"),
            },
            "agent": content.get("agent"),
            "results": post_result.get("results"),
        }),
    ))
}

/// `POST /api/social-post-agent` — generate copy, never post.
pub async fn post_agent(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let (authorized_by, _uid) = authorize(&state, &headers).await?;
    let config = config(&state).await?;
    let payload = body_json(&body).await?;
    let targets = social::clean_targets(payload.get("targets").or_else(|| payload.get("target")))?;
    let input = json!({
        "message": payload.get("message").or_else(|| payload.get("text")),
        "hook": payload.get("hook"),
        "hashtags": payload.get("hashtags"),
        "card": payload.get("card").cloned().unwrap_or(json!({})),
        "cardUrl": payload.get("cardUrl"),
        "imageUrl": payload.get("imageUrl"),
        "context": { "source": "social-post-agent", "prompt": clean_text(payload.get("prompt").and_then(Value::as_str), 1000) },
    });
    let fallback = social::build_post_content(&input, &config.site_url);
    let content = social::content_with_optional_agent(&config, &input, &targets, true).await;
    let _ = fallback;
    Ok(json_response(
        200,
        json!({
            "ok": true,
            "authorizedBy": authorized_by,
            "agent": content.get("agent"),
            "telegramText": content.get("telegramText"),
            "xText": content.get("xText"),
            "cardUrl": content.get("cardUrl"),
            "imageUrl": content.get("imageUrl"),
        }),
    ))
}

async fn resolve_manual_post_input(
    state: &DomainState,
    config: &SocialConfig,
    payload: &Value,
    targets: &[String],
    use_agent: bool,
) -> ApiResult<Value> {
    let supplied = social::card_from_body(payload);
    let lookup_id = supplied
        .get("cardId")
        .or_else(|| supplied.get("blueprintId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let fetched = if lookup_id.is_empty() {
        None
    } else {
        social::fetch_card_by_id(&state.db, &lookup_id).await.unwrap_or(None)
    };
    let mut card = fetched.unwrap_or_else(|| json!({}));
    if let (Some(target), Some(source)) = (card.as_object_mut(), supplied.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    let input = json!({
        "message": payload.get("message").or_else(|| payload.get("text")),
        "hook": payload.get("hook"),
        "hashtags": payload.get("hashtags"),
        "card": card,
        "cardUrl": payload.get("cardUrl").or_else(|| payload.get("listingUrl")).or_else(|| card.get("cardUrl")),
        "imageUrl": payload.get("imageUrl").or_else(|| card.get("imageUrl")),
        "context": { "source": "manual" },
    });
    let content = social::content_with_optional_agent(config, &input, targets, use_agent).await;
    let text = content.get("text").and_then(Value::as_str).unwrap_or_default();
    if text.is_empty() {
        return Err(ApiError::bad_request("A post message or card payload is required."));
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unverified_admin_email_is_not_an_admin() {
        let admins = vec!["boss@pokoin.com".to_string()];
        let mut identity = crate::firebase::DecodedToken {
            uid: "u1".into(),
            email: Some("Boss@Pokoin.com".into()),
            email_verified: false,
            name: None,
            picture: None,
        };
        assert!(!is_admin_identity(&identity, &admins));
        identity.email_verified = true;
        assert!(is_admin_identity(&identity, &admins));
        identity.email = Some("other@pokoin.com".into());
        assert!(!is_admin_identity(&identity, &admins));
    }

    #[tokio::test]
    async fn unverified_admin_email_token_is_denied_by_the_route() {
        // Only this test sets SEARCH_DEBUG_ADMINS, so the env write cannot
        // change another test's admin list.
        std::env::set_var("SEARCH_DEBUG_ADMINS", "route-admin@pokoin.test");
        let email = "route-admin@pokoin.test".to_string();
        let verifier = crate::firebase::StaticVerifier {
            uid_email: std::sync::Arc::new([("verified1".to_string(), email.clone())].into()),
            unverified_uid_email: std::sync::Arc::new([("unverified1".to_string(), email)].into()),
        };
        let state = DomainState::for_test_with_verifier(verifier);
        let bearer = |uid: &str| {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", format!("Bearer test-{uid}").parse().unwrap());
            headers
        };
        let error = authorize(&state, &bearer("unverified1")).await.unwrap_err();
        assert_eq!(error.status, 403);
        let (by, uid) = authorize(&state, &bearer("verified1")).await.unwrap();
        assert_eq!((by.as_str(), uid.as_deref()), ("firebase_admin", Some("verified1")));
    }

    #[test]
    fn admin_allow_list_is_env_driven() {
        std::env::set_var("SOCIAL_AUTOPOST_ADMINS", "a@x.y, B@x.Y");
        let admins = configured_admins();
        assert!(admins.contains(&"a@x.y".to_string()));
        assert!(admins.contains(&"b@x.y".to_string()));
        std::env::remove_var("SOCIAL_AUTOPOST_ADMINS");
    }
}
