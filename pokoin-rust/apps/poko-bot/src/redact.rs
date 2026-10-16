use std::sync::LazyLock;

use regex::Regex;

/// Hide a bot token before it reaches a log line.
///
/// Telegram request URLs look like `https://api.telegram.org/bot<id>:<secret>/…`.
/// The exact configured token is replaced first. A second pass covers the same
/// shape when the token value itself was not available to the caller.
pub fn redact(error_text: &str, token: &str) -> String {
    let replaced = if token.is_empty() {
        error_text.to_string()
    } else {
        error_text.replace(token, "<token>")
    };
    token_shape()
        .replace_all(&replaced, "bot<token>")
        .into_owned()
}

fn token_shape() -> &'static Regex {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"bot\d+:[A-Za-z0-9_-]{30,}").expect("token shape"));
    &RE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_configured_token_and_the_url_shape() {
        let token = "123456789:AAHabcdefghijklmnopqrstuvwxyz0123456789";
        let raw = format!("getUpdates https://api.telegram.org/bot{token}/getUpdates failed");
        let cleaned = redact(&raw, token);
        assert!(!cleaned.contains(token));
        assert!(cleaned.contains("bot<token>"));
        assert!(!cleaned.contains("AAHabc"));
    }

    #[test]
    fn regex_guard_covers_a_token_we_were_not_given() {
        let secret = "AAHabcdefghijklmnopqrstuvwxyz0123456789";
        let raw = format!("https://api.telegram.org/bot424242:{secret}/sendMessage");
        let cleaned = redact(&raw, "");
        assert_eq!(cleaned, "https://api.telegram.org/bot<token>/sendMessage");
        assert!(!cleaned.contains(secret));
    }
}
