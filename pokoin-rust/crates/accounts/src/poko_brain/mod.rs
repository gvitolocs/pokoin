//! In-process Poko chat brain.
//!
//! One OpenAI-compatible call with native tool calling. Market tools run here,
//! in parallel. A second call happens only when tools ran. `POKO_BRAIN_MODE`
//! decides whether the website chat uses this path; any error falls back to Hermes.

mod cards;
mod prompt;
mod providers;
mod safety;
mod sanitize;
mod tools;

use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value as Json};

pub use providers::{brain_enabled, parse_mode, BrainConfig, BrainMode, Provider, ProviderHealth};
pub use tools::{MarketToolRunner, ToolRunner};

use providers::{
    complete, complete_named, CompleteError, CompleteOptions, Completion, ToolChoice, TurnBudget,
};
use tools::ExecutedTool;

#[derive(Debug, Clone)]
pub struct Turn {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct BrainInput {
    pub user_message: String,
    pub context_blocks: Vec<String>,
    pub history: Vec<Turn>,
    pub game: String,
    pub display_name: String,
    pub user_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone)]
pub struct ToolCallLog {
    pub name: String,
    pub params: Json,
    pub ms: u64,
    pub ok: bool,
}

#[derive(Debug, Clone)]
pub struct BrainReply {
    pub reply: String,
    pub cards: Vec<Json>,
    pub provider: String,
    pub model: String,
    pub llm_calls: u32,
    pub tool_calls: Vec<ToolCallLog>,
    pub elapsed_ms: u64,
    pub blocked: bool,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BrainError {
    #[error("poko-brain budget exhausted")]
    Budget,
    #[error("poko-brain providers failed")]
    ProvidersFailed,
}

pub struct BrainDeps {
    pub transport: crate::http::SharedTransport,
    pub tools: Arc<dyn ToolRunner>,
    pub config: BrainConfig,
    pub health: Arc<ProviderHealth>,
}

impl BrainDeps {
    /// Production wiring: the shared HTTP client, live market tools, env config.
    pub fn production(state: &crate::state::DomainState) -> Self {
        Self {
            transport: state.transport().clone(),
            tools: Arc::new(MarketToolRunner::new(state.clone())),
            config: BrainConfig::from_env(),
            health: ProviderHealth::process_wide(),
        }
    }
}

const HISTORY_TURNS: usize = 10;
const HISTORY_CHARS: usize = 6_000;
const NO_TOOLS_RETRY_SYSTEM: &str =
    "Tools are not available now. Answer the user in plain text using only the tool results above. If they are not enough, ask one short question.";

pub async fn reply(deps: &BrainDeps, input: BrainInput) -> Result<BrainReply, BrainError> {
    let started = Instant::now();
    if safety::chat_blocked(&input.user_id, &input.user_message) {
        return Ok(finished(
            started,
            safety::ABUSE_REPLY,
            Vec::new(),
            String::new(),
            String::new(),
            0,
            Vec::new(),
            true,
        ));
    }
    if safety::input_unsafe(deps, &input.user_message).await {
        return Ok(finished(
            started,
            safety::GUARD_INPUT_REPLY,
            Vec::new(),
            "guard".to_string(),
            deps.config.guard_model.clone().unwrap_or_default(),
            0,
            Vec::new(),
            false,
        ));
    }

    let mut messages = base_messages(&input);
    let mut logs: Vec<ToolCallLog> = Vec::new();
    let mut payloads: Vec<Json> = Vec::new();
    let mut rounds = 0u32;
    let mut llm_calls = 0u32;
    let budget = TurnBudget::new(started, deps.config.budget);
    let max_rounds = deps.config.max_tool_rounds;
    let answer = loop {
        let choice = if rounds >= max_rounds {
            ToolChoice::None
        } else {
            ToolChoice::Auto
        };
        let step = match complete(
            deps,
            &budget,
            &messages,
            CompleteOptions::with_tools(choice),
        )
        .await
        {
            Ok(step) => step,
            Err(CompleteError::Budget) => return Err(BrainError::Budget),
            Err(CompleteError::Failed) => return Err(BrainError::ProvidersFailed),
        };
        llm_calls += step.attempts;
        let stop_for_answer = step.tool_calls.is_empty() || choice == ToolChoice::None;
        if stop_for_answer {
            let (fixed, extra_calls) =
                ensure_usable_answer(deps, &budget, &messages, step, rounds, max_rounds).await?;
            llm_calls += extra_calls;
            break fixed;
        }
        let ran = tools::run_round(deps, &input.game, &step.tool_calls).await;
        messages.push(step.assistant_message);
        for item in &ran {
            messages.push(tool_message(item));
            logs.push(ToolCallLog {
                name: item.name.clone(),
                params: item.arguments.clone(),
                ms: item.ms,
                ok: item.ok,
            });
            payloads.push(item.body.clone());
        }
        rounds += 1;
    };

    let mut text = sanitize::sanitize_poko_output(&answer.content);
    if sanitize::contains_tool_markup(&text) || text.trim().is_empty() {
        return Err(BrainError::ProvidersFailed);
    }
    if safety::output_unsafe(deps, &text).await {
        text = safety::GUARD_OUTPUT_REPLY.to_string();
        payloads.clear();
    }
    let cards = if payloads.is_empty() {
        Vec::new()
    } else {
        cards::from_results(&payloads, &text)
    };
    Ok(finished(
        started,
        &text,
        cards,
        answer.provider,
        answer.model,
        llm_calls,
        logs,
        false,
    ))
}

#[allow(clippy::too_many_arguments)]
fn finished(
    started: Instant,
    reply_text: &str,
    cards: Vec<Json>,
    provider: String,
    model: String,
    llm_calls: u32,
    tool_calls: Vec<ToolCallLog>,
    blocked: bool,
) -> BrainReply {
    BrainReply {
        reply: reply_text.to_string(),
        cards,
        provider,
        model,
        llm_calls,
        tool_calls,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        blocked,
    }
}

fn base_messages(input: &BrainInput) -> Vec<Json> {
    let mut messages = vec![json!({
        "role": "system",
        "content": prompt::system_prompt(&input.game),
    })];
    let mut blocks: Vec<String> = input
        .context_blocks
        .iter()
        .map(|block| block.trim().to_string())
        .filter(|block| !block.is_empty())
        .collect();
    if let Some(name) = public_display_name(&input.display_name) {
        blocks.push(format!("The signed-in display name is {name}."));
    }
    if !blocks.is_empty() {
        messages.push(json!({
            "role": "system",
            "content": blocks.join("\n\n"),
        }));
    }
    for turn in bound_history(&input.history) {
        messages.push(json!({ "role": turn.role, "content": turn.text }));
    }
    messages.push(json!({ "role": "user", "content": input.user_message }));
    messages
}

fn public_display_name(name: &str) -> Option<&str> {
    let name = name.trim();
    if name.is_empty() || name.contains('@') {
        None
    } else {
        Some(name)
    }
}

fn bound_history(history: &[Turn]) -> Vec<Turn> {
    let mut kept: Vec<Turn> = history
        .iter()
        .filter(|turn| turn.role == "user" || turn.role == "assistant")
        .cloned()
        .collect();
    if kept.len() > HISTORY_TURNS {
        kept = kept.split_off(kept.len() - HISTORY_TURNS);
    }
    while text_chars(&kept) > HISTORY_CHARS && kept.len() > 1 {
        kept.remove(0);
    }
    if let Some(turn) = kept.first_mut() {
        if turn.text.chars().count() > HISTORY_CHARS {
            turn.text = turn.text.chars().take(HISTORY_CHARS).collect();
        }
    }
    kept
}

fn text_chars(turns: &[Turn]) -> usize {
    turns.iter().map(|turn| turn.text.chars().count()).sum()
}

fn tool_message(item: &ExecutedTool) -> Json {
    json!({
        "role": "tool",
        "tool_call_id": item.id,
        "content": item.text,
    })
}

fn answer_unusable(raw: &str) -> bool {
    sanitize::contains_tool_markup(raw) || sanitize::sanitize_poko_output(raw).trim().is_empty()
}

async fn ensure_usable_answer(
    deps: &BrainDeps,
    budget: &TurnBudget,
    messages: &[Json],
    answer: Completion,
    rounds: u32,
    max_rounds: u32,
) -> Result<(Completion, u32), BrainError> {
    if !answer_unusable(&answer.content) {
        return Ok((answer, 0));
    }
    if rounds < max_rounds && !answer.tool_calls.is_empty() {
        return Err(BrainError::ProvidersFailed);
    }

    tracing::info!(
        provider = %answer.provider,
        model = %answer.model,
        recovery = "no_tools_retry",
        "poko-brain caught tool markup in assistant text"
    );

    let mut retry_messages = messages.to_vec();
    retry_messages.push(json!({
        "role": "system",
        "content": NO_TOOLS_RETRY_SYSTEM,
    }));

    let mut extra_calls = 0u32;
    if let Ok(retry) = complete_named(
        deps,
        budget,
        &answer.provider,
        &retry_messages,
        CompleteOptions::plain_text(),
    )
    .await
    {
        extra_calls += retry.attempts;
        if !answer_unusable(&retry.content) {
            tracing::info!(
                provider = %retry.provider,
                model = %retry.model,
                recovery = "no_tools_retry_ok",
                "poko-brain recovered from tool markup"
            );
            return Ok((retry, extra_calls));
        }
    }

    tracing::info!(
        provider = %answer.provider,
        model = %answer.model,
        recovery = "provider_fallback",
        "poko-brain tool markup retry failed; trying next provider"
    );

    let fallback = complete(deps, budget, &retry_messages, CompleteOptions::plain_text()).await;
    match fallback {
        Ok(step) if !answer_unusable(&step.content) => {
            extra_calls += step.attempts;
            tracing::info!(
                provider = %step.provider,
                model = %step.model,
                recovery = "provider_fallback_ok",
                "poko-brain recovered from tool markup"
            );
            Ok((step, extra_calls))
        }
        Ok(_) => Err(BrainError::ProvidersFailed),
        Err(CompleteError::Budget) => Err(BrainError::Budget),
        Err(CompleteError::Failed) => Err(BrainError::ProvidersFailed),
    }
}

#[cfg(test)]
mod reply_tests;
