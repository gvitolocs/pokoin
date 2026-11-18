//! Hermes message decisions: rules remain authoritative and are the failure fallback.
use crate::gate::{should_poko_engage, Engage, EngageInput};
use crate::jev::{Jev, JevError};
use serde_json::json;

#[derive(Debug, Clone)]
pub struct Probabilities {
    pub engage: f64,
    pub private_request: f64,
    pub market_question: f64,
    pub latency_ms: u64,
    pub cached: bool,
}
pub type Classification = Result<Probabilities, JevError>;
#[derive(Debug)]
pub struct Decision {
    pub engage: Engage,
    pub source: &'static str,
    pub classification: Option<Classification>,
}

pub async fn classify_poko_message(jev: &Jev, input: &EngageInput<'_>) -> Classification {
    let message: String = input
        .text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(4000)
        .collect();
    let channel = [input.parent_name, input.channel_name]
        .into_iter()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    let state = json!({"platform": input.platform, "chat": if input.is_dm { "dm" } else { "group" }, "channel": channel, "directlyAddressed": input.is_dm || input.is_mentioned || input.is_reply_to_bot, "message": message});
    let questions =
        serde_json::from_str(include_str!("message_questions.json")).expect("static JEV questions");
    let result = jev.evaluate(state, questions, "poko_message").await?;
    Ok(Probabilities {
        engage: result.answers["engage"].noul,
        private_request: result.answers["private_request"].noul,
        market_question: result.answers["market_question"].noul,
        latency_ms: result.latency_ms,
        cached: result.cached,
    })
}

pub async fn decide_poko_engagement(jev: &Jev, input: EngageInput<'_>) -> Decision {
    let rules = should_poko_engage(input);
    if matches!(
        rules.reason.as_str(),
        "empty_message" | "private_operator_request" | "contract_address_request"
    ) {
        return Decision {
            engage: rules,
            source: "rules",
            classification: None,
        };
    }
    let classification = classify_poko_message(jev, &input).await;
    let Ok(ref p) = classification else {
        jev.record_fallback();
        return Decision {
            engage: rules,
            source: "rules_fallback",
            classification: Some(classification),
        };
    };
    let engage = if p.private_request >= 0.8 {
        Engage {
            should_reply: false,
            reason: "private_operator_request".into(),
        }
    } else if rules.reason == "direct_invocation" {
        rules
    } else {
        Engage {
            should_reply: p.engage >= 0.5,
            reason: if p.engage >= 0.5 {
                "jev_engage"
            } else {
                "jev_ambient"
            }
            .into(),
        }
    };
    Decision {
        engage,
        source: "jev",
        classification: Some(classification),
    }
}
