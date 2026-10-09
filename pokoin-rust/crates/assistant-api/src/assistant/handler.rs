//! The `/api/pokoin-assistant` POST handler — a direct port of the
//! `module.exports` pipeline of `api/pokoin-assistant.js`, ending in
//! `sendPokontactResponse` (which appends `conversationMemory`).

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};

use pokoin_api_common::RouteState;

use crate::assistant::context::{
    clean_page_context, enriched_page_card_context, page_url_from_context,
};
use crate::assistant::external::{
    assistant_rate_limited, call_pokontact_service, fetch_community_sentiment, forward_to_team,
    identity_from_headers, record_pokontact_turn, user_from_request,
};
use crate::assistant::grounding::{
    card_suggestion, contextual_card_opinion_reply, deck_advisor_reply, grounded_marketplace_reply,
    query_card_recommendations, query_deck_advisor_data, recommendation_reply,
    resolve_marketplace_cards, rewrite_card_suggestion_links, safe_assistant_actions,
};
use crate::assistant::intent::{
    classify_intent, deck_advisor_intent_from_message, infer_user_preferences, is_italian_message,
    marketplace_request_from_message, pending_market_clarification_reply,
    recommendation_intent_from_message, should_bypass_peer_service,
};
use crate::assistant::text::{clean_text, sanitize_poko_emoji};
use pokoin_api_common::http::{json_with, parse_body};

/// `sessionIdFromRequest`.
fn session_id_from_request(body: &Value, headers: &HeaderMap) -> String {
    let from_body = body.get("sessionId").cloned().unwrap_or(Value::Null);
    let body_session = from_body.as_str().unwrap_or("");
    if !body_session.is_empty() {
        return clean_text(&json!(body_session), 120);
    }
    let from_header = headers
        .get("x-pokoin-session-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    clean_text(&json!(from_header), 120)
}

/// `res.status(200).json({...body, conversationMemory})`.
async fn send_pokontact_response(
    state: &RouteState,
    body: Map<String, Value>,
    message: &str,
    user: &Map<String, Value>,
    page_context: &Map<String, Value>,
) -> Response {
    let intent = body
        .get("intent")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let reply = body
        .get("reply")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let service_delivery = body.get("serviceDelivery").cloned();
    let conversation_memory = record_pokontact_turn(
        state,
        message,
        &reply,
        user,
        page_context,
        &intent,
        service_delivery.as_ref(),
    )
    .await;
    let mut response = body;
    response.insert("conversationMemory".into(), conversation_memory);
    json_with(StatusCode::OK, Value::Object(response), &[])
}

/// `currentCardOpinionDelivery`.
async fn current_card_opinion_delivery(
    state: &RouteState,
    message: &str,
    page: &Value,
    page_context: &Map<String, Value>,
) -> Option<Value> {
    if !crate::assistant::intent::looks_like_current_card_opinion_value_question(
        message,
        page,
        page_context,
    ) {
        return None;
    }
    let card = enriched_page_card_context(page, page_context);
    let language = crate::assistant::intent::language_for_request(page, page_context);
    let italian = is_italian_message(message) || language == "it";
    let title = card.get("title").and_then(Value::as_str).unwrap_or("");
    let card_id = card.get("cardId").and_then(Value::as_str).unwrap_or("");
    let cards = resolve_marketplace_cards(state.api.read(), title, card_id, &language, 1.0)
        .await
        .unwrap_or_default();
    let marketplace_card = cards.first().cloned();
    let market_field = |key: &str| {
        marketplace_card
            .as_ref()
            .and_then(|card| card.get(key))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let mut sentiment_input = card.clone();
    let title = if title.is_empty() {
        market_field("name")
    } else {
        title.to_owned()
    };
    let set_name = {
        let card_set = card.get("setName").and_then(Value::as_str).unwrap_or("");
        if card_set.is_empty() {
            market_field("setName")
        } else {
            card_set.to_owned()
        }
    };
    let collector = {
        let card_collector = card
            .get("collectorNumber")
            .and_then(Value::as_str)
            .unwrap_or("");
        if card_collector.is_empty() {
            market_field("collectorNumber")
        } else {
            card_collector.to_owned()
        }
    };
    sentiment_input.insert("title".into(), json!(title));
    sentiment_input.insert("setName".into(), json!(set_name));
    sentiment_input.insert("collectorNumber".into(), json!(collector));
    let sentiment = fetch_community_sentiment(
        state,
        &crate::assistant::intent::community_sentiment_query_for_card(&sentiment_input),
    )
    .await;
    let reply = contextual_card_opinion_reply(
        &Value::Object(card.clone()),
        marketplace_card.as_ref(),
        &sentiment,
        italian,
    );
    let path = marketplace_card
        .as_ref()
        .and_then(|card| card.get("path"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let name = market_field("name");
    let actions = if path.is_empty() {
        json!([])
    } else {
        let label_name: &str = if name.is_empty() { "carta" } else { &name };
        let label = if italian {
            format!("Apri {label_name}")
        } else {
            let fallback: &str = if name.is_empty() { "card" } else { &name };
            format!("Open {fallback}")
        };
        json!([{
            "type": "navigate",
            "path": path,
            "label": label,
            "reason": "current_card_context",
            "data": {
                "cardId": marketplace_card.as_ref().and_then(|card| card.get("cardId")).cloned().unwrap_or(json!("")),
                "grounded": true,
            },
        }])
    };
    Some(json!({
        "reply": reply,
        "intent": "card-context-opinion",
        "source": "current-card-context",
        "actions": actions,
        "marketplaceContext": {
            "type": "current_card_opinion",
            "card": Value::Object(card),
            "cardMatch": marketplace_card.unwrap_or(Value::Null),
            "communitySentiment": sentiment,
        },
    }))
}

/// `deckAdvisorDelivery`.
async fn deck_advisor_delivery(
    state: &RouteState,
    message: &str,
    chat_record: &[(String, String)],
    user_preferences: &Map<String, Value>,
) -> Option<Value> {
    let intent = deck_advisor_intent_from_message(message, chat_record)?;
    let data = query_deck_advisor_data(state.api.read(), &intent)
        .await
        .unwrap_or(json!({ "decks": [] }));
    let decks_empty = data
        .get("decks")
        .and_then(Value::as_array)
        .is_none_or(|decks| decks.is_empty());
    let response = deck_advisor_reply(&intent, &data, user_preferences);
    Some(json!({
        "reply": response.get("reply").cloned().unwrap_or(Value::Null),
        "intent": "deck-advisor",
        "source": if decks_empty { "deck-advisor-fallback" } else { "peer4-readonly-limitless" },
        "actions": response.get("actions").cloned().unwrap_or(json!([])),
        "grounding": {
            "type": "deck_advisor",
            "intent": {
                "deckName": intent.deck_name,
                "wantsExplanation": intent.wants_explanation,
                "budget": intent.budget,
                "beginner": intent.beginner,
                "playstyle": intent.playstyle,
                "language": intent.language,
            },
            "decks": data.get("decks").cloned().unwrap_or(json!([])),
            "readOnly": true,
        },
    }))
}

/// `recommendationGroundedDelivery`.
async fn recommendation_grounded_delivery(
    state: &RouteState,
    message: &str,
    chat_record: &[(String, String)],
    page: &Value,
    page_context: &Map<String, Value>,
    user_preferences: &Map<String, Value>,
) -> Option<Value> {
    let intent = recommendation_intent_from_message(message, chat_record)?;
    if intent.explicit_subject && intent.theme_id.is_empty() && intent.styles.is_empty() {
        return None;
    }
    let language = crate::assistant::intent::language_for_request(page, page_context);
    let favorites: Vec<String> = user_preferences
        .get("favoritePokemon")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let cards = query_card_recommendations(
        state.api.read(),
        &intent.subject,
        &intent.theme_id,
        &intent.styles,
        &intent.budget,
        &language,
        &favorites,
        5.0,
    )
    .await
    .ok()?;
    if cards.is_empty() && !intent.subject.is_empty() {
        return None;
    }
    let intent_json = json!({
        "subject": intent.subject,
        "themeId": intent.theme_id,
        "themeLabel": intent.theme_label,
        "styles": intent.styles,
        "budget": intent.budget,
        "explicitSubject": intent.explicit_subject,
    });
    let response = recommendation_reply(&intent_json, &cards, &language, user_preferences);
    Some(json!({
        "reply": response.get("reply").cloned().unwrap_or(Value::Null),
        "intent": "card-recommendation",
        "source": "peer4-readonly-recommendation",
        "actions": response.get("actions").cloned().unwrap_or(json!([])),
        "grounding": {
            "type": "card_recommendation",
            "intent": intent_json,
            "cards": cards,
            "readOnly": true,
        },
    }))
}

/// `marketplaceGroundedDelivery`.
async fn marketplace_grounded_delivery(
    state: &RouteState,
    message: &str,
    chat_record: &[(String, String)],
    page: &Value,
    page_context: &Map<String, Value>,
) -> Option<Value> {
    let request = marketplace_request_from_message(message, chat_record, page, page_context)?;
    let language = crate::assistant::intent::language_for_request(page, page_context);
    let grounding = if request.kind == "active_listing" {
        crate::assistant::grounding::active_listing_grounding(
            state.api.read(),
            &request.query,
            &request.card_id,
            request.mode,
            &language,
        )
        .await
    } else if request.kind == "analytics" {
        crate::assistant::grounding::analytics_grounding(
            state.api.read(),
            &request.query,
            &request.card_id,
            &language,
        )
        .await
    } else {
        crate::assistant::grounding::card_lookup_grounding(
            state.api.read(),
            &request.query,
            &request.card_id,
            &language,
        )
        .await
    };
    let grounding = match grounding {
        Ok(grounding) => grounding,
        Err(_) => return None,
    };
    let response = grounded_marketplace_reply(&grounding, &language);
    let intent = if request.kind == "analytics" {
        "marketplace-analytics"
    } else {
        "marketplace"
    };
    // `listing: {...listing, price_pkn: Number(listing.price_pkn || 0)}`
    let mut grounding_object = grounding.as_object().cloned().unwrap_or_default();
    let price = grounding_object
        .get("listing")
        .and_then(|listing| listing.get("price_pkn"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if let Some(listing) = grounding_object.get_mut("listing") {
        if let Some(listing_object) = listing.as_object_mut() {
            listing_object.insert("price_pkn".into(), json!(price));
        }
    }
    Some(json!({
        "reply": response.get("reply").cloned().unwrap_or(Value::Null),
        "intent": intent,
        "source": "marketplace-grounding",
        "actions": response.get("actions").cloned().unwrap_or(json!([])),
        "grounding": Value::Object(grounding_object),
    }))
}

/// The `/api/pokoin-assistant` handler (all methods; the Node handler 405s
/// everything but POST itself).
pub async fn pokoin_assistant(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let allow = [("allow", "POST")];
    if method != Method::POST {
        return json_with(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
            &allow,
        );
    }
    if assistant_rate_limited(&identity_from_headers(&headers)) {
        return json_with(
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "error": "Too many Pokontact messages." }),
            &[],
        );
    }

    let parsed = match parse_body(&headers, &body) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let body_value = parsed.json();
    let message = clean_text(body_value.get("message").unwrap_or(&Value::Null), 3000);
    let chat_record = crate::assistant::intent::clean_chat_record(
        body_value.get("messages").unwrap_or(&Value::Null),
    );
    let page_context = clean_page_context(body_value.get("pageContext").unwrap_or(&Value::Null));
    let page_raw = clean_text(body_value.get("page").unwrap_or(&Value::Null), 500);
    let page = json!(page_url_from_context(&json!(page_raw), &page_context));
    let session_id = session_id_from_request(&body_value, &headers);
    // JS `message.length` counts UTF-16 code units.
    if message.encode_utf16().count() < 2 {
        return json_with(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Write a message for Pokontact." }),
            &[],
        );
    }

    let mut user = user_from_request(&state, &headers, &body_value).await;
    user.insert("sessionId".into(), json!(session_id));
    let uid = user
        .get("uid")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    user.insert(
        "identityKey".into(),
        json!(if !uid.is_empty() {
            uid
        } else if !session_id.is_empty() {
            session_id
        } else {
            "guest".to_owned()
        }),
    );

    let user_preferences = infer_user_preferences(&message, &chat_record);
    let local_intent = classify_intent(&message);

    macro_rules! respond {
        ($body:expr) => {
            send_pokontact_response(&state, $body, &message, &user, &page_context).await
        };
    }

    let mut body = Map::new();
    if local_intent == "unsafe-cyber" || local_intent == "navigation" {
        body.insert(
            "reply".into(),
            json!(sanitize_poko_emoji(&if local_intent == "unsafe-cyber" {
                crate::assistant::intent::unsafe_cyber_reply(&message)
            } else {
                crate::assistant::intent::navigation_reply(&message)
            })),
        );
        body.insert("intent".into(), json!(local_intent));
        body.insert("forwarded".into(), json!(false));
        body.insert("emailDelivery".into(), Value::Null);
        body.insert("actions".into(), json!([]));
        body.insert("pageContext".into(), Value::Object(page_context.clone()));
        body.insert(
            "serviceDelivery".into(),
            json!({
                "ok": true,
                "source": if local_intent == "unsafe-cyber" { "local-safety" } else { "local-navigation" },
                "provider": if local_intent == "unsafe-cyber" {
                    "pokoin-assistant-guardrail"
                } else {
                    "pokoin-assistant-navigation"
                },
                "model": "deterministic",
            }),
        );
        body.insert("assistant".into(), json!("Pokontact"));
        return respond!(body);
    }
    let continuity_reply =
        pending_market_clarification_reply(&message, &chat_record, &page_context);
    if !continuity_reply.is_empty() {
        body.insert(
            "reply".into(),
            json!(sanitize_poko_emoji(&continuity_reply)),
        );
        body.insert("intent".into(), json!("marketplace"));
        body.insert("forwarded".into(), json!(false));
        body.insert("emailDelivery".into(), Value::Null);
        body.insert("actions".into(), json!([]));
        body.insert("pageContext".into(), Value::Object(page_context.clone()));
        body.insert(
            "serviceDelivery".into(),
            json!({
                "ok": true,
                "source": "local-conversation-continuity",
                "provider": "pokoin-conversation-guardrail",
                "model": "deterministic",
            }),
        );
        body.insert("assistant".into(), json!("Pokontact"));
        return respond!(body);
    }
    let card_opinion = current_card_opinion_delivery(&state, &message, &page, &page_context).await;
    if let Some(delivery) = card_opinion {
        body.insert(
            "reply".into(),
            json!(sanitize_poko_emoji(
                delivery.get("reply").and_then(Value::as_str).unwrap_or("")
            )),
        );
        body.insert(
            "intent".into(),
            delivery.get("intent").cloned().unwrap_or(Value::Null),
        );
        body.insert("forwarded".into(), json!(false));
        body.insert("emailDelivery".into(), Value::Null);
        body.insert(
            "actions".into(),
            Value::Array(safe_assistant_actions(
                &delivery.get("actions").cloned().unwrap_or(json!([])),
            )),
        );
        body.insert("pageContext".into(), Value::Object(page_context.clone()));
        body.insert(
            "serviceDelivery".into(),
            json!({
                "ok": true,
                "source": delivery.get("source").cloned().unwrap_or(Value::Null),
                "provider": "pokoin-current-card-context",
                "model": "deterministic",
            }),
        );
        body.insert(
            "marketplaceContext".into(),
            delivery
                .get("marketplaceContext")
                .cloned()
                .unwrap_or(Value::Null),
        );
        body.insert("assistant".into(), json!("Pokontact"));
        return respond!(body);
    }

    if !matches!(local_intent, "project" | "crypto" | "greeting" | "casual") {
        let grounded: Option<(&str, Value)> = if let Some(delivery) =
            deck_advisor_delivery(&state, &message, &chat_record, &user_preferences).await
        {
            Some(("pokoin-deck-advisor", delivery))
        } else if let Some(delivery) = recommendation_grounded_delivery(
            &state,
            &message,
            &chat_record,
            &page,
            &page_context,
            &user_preferences,
        )
        .await
        {
            Some(("pokoin-card-recommendation", delivery))
        } else if let Some(delivery) =
            marketplace_grounded_delivery(&state, &message, &chat_record, &page, &page_context)
                .await
        {
            Some(("pokoin-marketplace-tool", delivery))
        } else {
            None
        };
        if let Some((provider, delivery)) = grounded {
            body.insert(
                "reply".into(),
                json!(sanitize_poko_emoji(
                    delivery.get("reply").and_then(Value::as_str).unwrap_or("")
                )),
            );
            body.insert(
                "intent".into(),
                delivery.get("intent").cloned().unwrap_or(Value::Null),
            );
            body.insert("forwarded".into(), json!(false));
            body.insert("emailDelivery".into(), Value::Null);
            body.insert(
                "actions".into(),
                Value::Array(safe_assistant_actions(
                    &delivery.get("actions").cloned().unwrap_or(json!([])),
                )),
            );
            body.insert("pageContext".into(), Value::Object(page_context.clone()));
            body.insert(
                "serviceDelivery".into(),
                json!({
                    "ok": true,
                    "source": delivery.get("source").cloned().unwrap_or(Value::Null),
                    "provider": provider,
                    "model": "deterministic",
                }),
            );
            body.insert(
                "marketplaceContext".into(),
                delivery.get("grounding").cloned().unwrap_or(Value::Null),
            );
            body.insert("userMemory".into(), Value::Object(user_preferences.clone()));
            body.insert("assistant".into(), json!("Pokontact"));
            return respond!(body);
        }
    }

    let service_delivery = if should_bypass_peer_service(&local_intent, &message, &chat_record) {
        json!({
            "ok": false,
            "skipped": true,
            "reason": format!("local_{local_intent}"),
        })
    } else {
        match call_pokontact_service(
            &state,
            &message,
            &chat_record,
            &user,
            page.as_str().unwrap_or(""),
            &page_context,
            &user_preferences,
        )
        .await
        {
            Ok(value) => value,
            Err(error) => error.to_error_value(),
        }
    };
    let service_reply = if service_delivery
        .get("reply")
        .and_then(Value::as_str)
        .is_some_and(|reply| !reply.is_empty())
    {
        Some(service_delivery.clone())
    } else {
        None
    };
    let intent = service_reply
        .as_ref()
        .and_then(|delivery| delivery.get("intent"))
        .and_then(Value::as_str)
        .unwrap_or(local_intent)
        .to_owned();

    let mut forwarded = false;
    let mut email_delivery = Value::Null;
    let reply: String;
    let mut actions: Value = json!([]);

    if intent == "inquiry" {
        email_delivery = forward_to_team(
            &state,
            &message,
            &chat_record,
            &user,
            page.as_str().unwrap_or(""),
        )
        .await;
        forwarded = email_delivery
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        reply = crate::assistant::intent::inquiry_reply(forwarded).to_owned();
    } else if let Some(service) = &service_reply {
        let rewritten =
            rewrite_card_suggestion_links(state.api.read(), service, page.as_str().unwrap_or(""))
                .await
                .unwrap_or_else(|_| service.clone());
        reply = rewritten
            .get("reply")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        actions = Value::Array(safe_assistant_actions(
            &rewritten.get("actions").cloned().unwrap_or(json!([])),
        ));
    } else if intent == "greeting" {
        reply = crate::assistant::intent::greeting_reply(&message);
    } else if intent == "casual" {
        reply = crate::assistant::intent::casual_reply(&message);
    } else if intent == "card" {
        let suggestion = card_suggestion(
            state.api.read(),
            page.as_str().unwrap_or(""),
            &message,
            &chat_record,
        )
        .await;
        reply = suggestion
            .get("reply")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        actions = suggestion.get("actions").cloned().unwrap_or(json!([]));
    } else if intent == "project" {
        reply = crate::assistant::intent::project_reply();
    } else if intent == "earn" {
        reply = crate::assistant::intent::earn_reply(&message);
    } else if intent == "crypto" {
        reply = crate::assistant::intent::crypto_reply();
    } else {
        reply = crate::assistant::intent::general_reply().to_owned();
    }
    let reply = sanitize_poko_emoji(&reply);

    body.insert("reply".into(), json!(reply));
    body.insert("intent".into(), json!(intent));
    body.insert("forwarded".into(), json!(forwarded));
    body.insert("emailDelivery".into(), email_delivery);
    body.insert(
        "actions".into(),
        Value::Array(safe_assistant_actions(&actions)),
    );
    body.insert("pageContext".into(), Value::Object(page_context.clone()));
    body.insert("userMemory".into(), Value::Object(user_preferences.clone()));
    let final_service_delivery = if service_reply.is_some() {
        json!({
            "ok": true,
            "source": service_reply.as_ref().and_then(|delivery| delivery.get("source")).cloned().unwrap_or(Value::Null),
            "provider": service_reply.as_ref().and_then(|delivery| delivery.get("provider")).cloned().unwrap_or(Value::Null),
            "model": service_reply.as_ref().and_then(|delivery| delivery.get("model")).cloned().unwrap_or(Value::Null),
        })
    } else if !service_delivery.is_null() {
        service_delivery
    } else {
        json!({
            "ok": false,
            "skipped": true,
            "reason": "POKONTACT_SERVICE_TOKEN is not configured.",
        })
    };
    body.insert("serviceDelivery".into(), final_service_delivery);
    body.insert("assistant".into(), json!("Pokontact"));
    respond!(body)
}
