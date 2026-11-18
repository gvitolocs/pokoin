use poko_bot::connect::{
    normalize_link_code, parse_discord_command, parse_telegram_command, TelegramParse,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectCase {
    #[serde(rename = "fn")]
    func: String,
    text: String,
    #[serde(default)]
    bot_username: String,
    expected: Value,
}

#[test]
fn connect_parsers_match_hermes_except_telegram_at_bot() {
    let cases: Vec<ConnectCase> =
        serde_json::from_str(include_str!("fixtures/connect_cases.json")).expect("connect fixture");
    assert!(cases.len() >= 30, "fixture has {} cases", cases.len());
    let mut problems = Vec::new();
    for case in &cases {
        let got = actual(case);
        let same = got == case.expected;
        let deviation = at_bot_deviation(case);
        if same && deviation.is_some() {
            problems.push(format!(
                "allowlist is stale for {} {:?}",
                case.func, case.text
            ));
        } else if !same && deviation.is_none() {
            problems.push(format!(
                "{} {:?}: hermes {}, rust {}",
                case.func, case.text, case.expected, got
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

fn actual(case: &ConnectCase) -> Value {
    match case.func.as_str() {
        "parseTelegramCommand" => match parse_telegram_command(&case.text, &case.bot_username) {
            None => Value::Null,
            Some(TelegramParse::OtherBot) => json!({ "otherBot": true }),
            Some(TelegramParse::Command(command)) => {
                json!({ "command": command.command, "arg": command.arg })
            }
        },
        "parseDiscordCommand" => match parse_discord_command(&case.text) {
            None => Value::Null,
            Some(command) => json!({ "command": command.command, "arg": command.arg }),
        },
        "normalizeLinkCode" => Value::String(normalize_link_code(&case.text)),
        other => panic!("unknown fixture fn {other}"),
    }
}

/// Hermes `parseTelegramCommand` has no `@Bot` group, so `/cmd@Name` is null.
/// We accept `/cmd@OurBot` and ignore `/cmd@OtherBot`.
fn at_bot_deviation(case: &ConnectCase) -> Option<&'static str> {
    if case.func != "parseTelegramCommand" {
        return None;
    }
    let trimmed = case.text.trim();
    let after_slash = trimmed.strip_prefix('/')?;
    let command = after_slash.split_whitespace().next().unwrap_or("");
    let (_, bot) = command.split_once('@')?;
    if bot.is_empty() {
        return None;
    }
    Some("Telegram /cmd@Bot is accepted for our username and ignored for another bot; Hermes returns null")
}
