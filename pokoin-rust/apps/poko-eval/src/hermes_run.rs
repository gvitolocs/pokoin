use std::time::Instant;

use pokoin_accounts::domain::poko_chat::clean_cards;
use pokoin_accounts::http::HttpRequest;
use pokoin_accounts::DomainState;
use serde_json::{json, Value as Json};

use crate::output::{cards_from_json, RunRecord};
use crate::question::Question;

const HERMES_TIMEOUT_MS: u64 = 95_000;

#[derive(Clone)]
pub struct HermesContext {
    pub state: DomainState,
    pub url: String,
    pub token: String,
}

pub async fn run_hermes(ctx: &HermesContext, question: &Question) -> RunRecord {
    let started = Instant::now();
    let messages: Vec<Json> = question
        .history
        .iter()
        .map(|turn| {
            json!({
                "role": turn.role,
                "text": turn.text,
            })
        })
        .collect();
    let payload = json!({
        "message": question.message,
        "userId": "poko-eval",
        "sessionId": format!("poko-eval-{}", question.id),
        "deferMemory": true,
        "messages": messages,
    });
    let request = match HttpRequest::new("POST", ctx.url.clone())
        .header("authorization", format!("Bearer {}", ctx.token))
        .timeout(std::time::Duration::from_millis(HERMES_TIMEOUT_MS))
        .json(&payload)
    {
        Ok(request) => request,
        Err(error) => {
            return error_record(question, started, error.to_string());
        }
    };
    let response = match ctx.state.transport().execute(request).await {
        Ok(response) => response,
        Err(error) => {
            return error_record(question, started, error.to_string());
        }
    };
    let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let data = response.json_value().unwrap_or(Json::Null);
    if !response.is_success() {
        let message = data
            .get("message")
            .or_else(|| data.get("error"))
            .and_then(Json::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("HTTP {}", response.status));
        return RunRecord {
            id: question.id.clone(),
            kind: question.kind.clone(),
            lang: question.lang.clone(),
            system: "hermes".into(),
            provider: String::new(),
            model: String::new(),
            ms,
            llm_calls: 0,
            tools: Vec::new(),
            reply: String::new(),
            cards: Vec::new(),
            blocked: false,
            error: Some(message),
        };
    }
    let reply = data
        .get("reply")
        .or_else(|| data.get("text"))
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_string();
    let cards = clean_cards(data.get("cards"));
    RunRecord {
        id: question.id.clone(),
        kind: question.kind.clone(),
        lang: question.lang.clone(),
        system: "hermes".into(),
        provider: text_field(&data, "provider"),
        model: text_field(&data, "model"),
        ms,
        llm_calls: data
            .get("llm_calls")
            .or_else(|| data.get("llmCalls"))
            .and_then(Json::as_u64)
            .map(|value| u32::try_from(value).unwrap_or(0))
            .unwrap_or(0),
        tools: Vec::new(),
        reply,
        cards: cards_from_json(&cards),
        blocked: false,
        error: None,
    }
}

fn error_record(question: &Question, started: Instant, message: String) -> RunRecord {
    RunRecord {
        id: question.id.clone(),
        kind: question.kind.clone(),
        lang: question.lang.clone(),
        system: "hermes".into(),
        provider: String::new(),
        model: String::new(),
        ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        llm_calls: 0,
        tools: Vec::new(),
        reply: String::new(),
        cards: Vec::new(),
        blocked: false,
        error: Some(message),
    }
}

fn text_field(value: &Json, key: &str) -> String {
    value
        .get(key)
        .and_then(Json::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .unwrap_or_default()
}

pub fn hermes_context(url: &str) -> Result<HermesContext, String> {
    let token = match std::env::var("POKO_EVAL_HERMES_TOKEN") {
        Ok(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => return Err("POKO_EVAL_HERMES_TOKEN is not set".to_string()),
    };
    let url = url.trim();
    if url.is_empty() {
        return Err("--hermes-url must be non-empty".to_string());
    }
    Ok(HermesContext {
        state: DomainState::from_env(),
        url: url.to_string(),
        token,
    })
}
