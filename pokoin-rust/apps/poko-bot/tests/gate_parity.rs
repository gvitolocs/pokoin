use poko_bot::gate::{should_poko_engage, EngageInput};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GateCase {
    text: String,
    platform: String,
    is_dm: bool,
    is_mentioned: bool,
    is_reply_to_bot: bool,
    bot_username: String,
    channel_name: String,
    parent_name: String,
    expected: Expected,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    should_reply: bool,
    reason: String,
}

#[test]
fn gate_matches_hermes_except_flareon_operator_asks() {
    let cases: Vec<GateCase> =
        serde_json::from_str(include_str!("fixtures/gate_cases.json")).expect("gate fixture");
    assert!(cases.len() >= 120, "fixture has {} cases", cases.len());
    let mut problems = Vec::new();
    for case in &cases {
        let got = should_poko_engage(EngageInput {
            text: &case.text,
            platform: &case.platform,
            is_dm: case.is_dm,
            is_mentioned: case.is_mentioned,
            is_reply_to_bot: case.is_reply_to_bot,
            bot_username: &case.bot_username,
            channel_name: &case.channel_name,
            parent_name: &case.parent_name,
        });
        let same =
            got.should_reply == case.expected.should_reply && got.reason == case.expected.reason;
        let deviation = flareon_operator_deviation(&case.text);
        if same && deviation.is_some() {
            problems.push(format!(
                "allowlist is stale for {:?} (both say {} / {})",
                case.text, got.should_reply, got.reason
            ));
        } else if !same && deviation.is_none() {
            problems.push(format!(
                "{:?} platform={} dm={} mention={} reply={} bot={:?} channel={:?} parent={:?}: hermes {}/{}, rust {}/{}",
                case.text,
                case.platform,
                case.is_dm,
                case.is_mentioned,
                case.is_reply_to_bot,
                case.bot_username,
                case.channel_name,
                case.parent_name,
                case.expected.should_reply,
                case.expected.reason,
                got.should_reply,
                got.reason
            ));
        }
    }
    assert!(
        problems.is_empty(),
        "{} parity problems:\n{}",
        problems.len(),
        problems.join("\n")
    );
}

/// Hermes skips the private screen when a Pokémon name matches, so `ask flareon`
/// is not `private_operator_request`. We still refuse those operator asks.
fn flareon_operator_deviation(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    let asks_flareon = [
        "ask flareon",
        "tell flareon",
        "ping flareon",
        "use flareon",
        "call flareon",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let flareon_tools = lower.contains("flareon's tools") || lower.contains("flareon tools");
    if asks_flareon || flareon_tools {
        Some("operator ask naming Flareon is refused; Hermes treats the species name as card chat and skips the private screen")
    } else {
        None
    }
}
