use std::sync::Arc;

use pokoin_accounts::poko_brain::{self, BrainDeps, BrainInput, Turn};
use pokoin_accounts::DomainState;

use crate::output::{cards_from_json, RunRecord};
use crate::question::Question;

#[derive(Clone)]
pub struct BrainContext {
    pub deps: Arc<BrainDeps>,
}

pub async fn run_brain(ctx: &BrainContext, question: &Question) -> RunRecord {
    let history = question
        .history
        .iter()
        .map(|turn| Turn {
            role: turn.role.clone(),
            text: turn.text.clone(),
        })
        .collect();
    let input = BrainInput {
        user_message: question.message.clone(),
        context_blocks: Vec::new(),
        history,
        game: question.game_id().to_string(),
        display_name: String::new(),
        user_id: "poko-eval".to_string(),
        session_id: format!("poko-eval-{}", question.id),
    };
    match poko_brain::reply(ctx.deps.as_ref(), input).await {
        Ok(reply) => RunRecord {
            id: question.id.clone(),
            kind: question.kind.clone(),
            lang: question.lang.clone(),
            system: "brain".into(),
            provider: reply.provider,
            model: reply.model,
            ms: reply.elapsed_ms,
            llm_calls: reply.llm_calls,
            tools: reply
                .tool_calls
                .iter()
                .map(|call| call.name.clone())
                .collect(),
            reply: reply.reply,
            cards: cards_from_json(&reply.cards),
            blocked: reply.blocked,
            error: None,
        },
        Err(error) => RunRecord {
            id: question.id.clone(),
            kind: question.kind.clone(),
            lang: question.lang.clone(),
            system: "brain".into(),
            provider: String::new(),
            model: String::new(),
            ms: 0,
            llm_calls: 0,
            tools: Vec::new(),
            reply: String::new(),
            cards: Vec::new(),
            blocked: false,
            error: Some(error.to_string()),
        },
    }
}

pub fn brain_context(providers: Option<&str>) -> Result<BrainContext, String> {
    if let Some(order) = providers {
        std::env::set_var("POKO_BRAIN_PROVIDERS", order);
    }
    let state = DomainState::from_env();
    if state.marketplace_db().is_err() {
        return Err(
            "marketplace DB not configured (set MARKETPLACE_DATABASE_URL or DATABASE_URL)".into(),
        );
    }
    Ok(BrainContext {
        deps: Arc::new(BrainDeps::production(&state)),
    })
}
