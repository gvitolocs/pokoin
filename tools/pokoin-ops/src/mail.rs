//! Same delivery path as scripts/pokoin-uptime-mail.sh: Resend HTTP API with the key
//! from the uptime-mail env file. The recipient and the sender come from configuration only.

use crate::env;
use anyhow::{anyhow, Result};
use std::time::Duration;

pub const FROM_KEY: &str = "POKOIN_ALERT_MAIL_FROM";
pub const TO_KEY: &str = "POKOIN_ALERT_MAIL_TO";
pub const TO_FALLBACK_KEY: &str = "POKOIN_UPTIME_MAIL_TO";

// Resend sits behind Cloudflare; the uptime mailer sends a browser-like UA for the same reason.
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) pokoin-ops/1";

pub fn subject(text: &str) -> String {
    format!("[pokoin {}] {}", env::hostname(), text)
        .split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect()
}

/// The recipient comes only from configuration; there is no built-in address.
fn recipient() -> Result<String> {
    env::get(TO_KEY)
        .or_else(|| env::get(TO_FALLBACK_KEY))
        .ok_or_else(|| anyhow!("mail recipient not configured: set POKOIN_ALERT_MAIL_TO (or POKOIN_UPTIME_MAIL_TO)"))
}

/// The sender comes only from configuration; there is no built-in address.
fn sender() -> Result<String> {
    env::get(FROM_KEY)
        .ok_or_else(|| anyhow!("mail sender not configured: set POKOIN_ALERT_MAIL_FROM"))
}

pub fn send(subject: &str, body: &str) -> Result<()> {
    let to = recipient()?;
    let from = sender()?;
    if env::get("POKOIN_OPS_DRY_RUN").is_some() {
        eprintln!("[dry-run mail] to={to} subject={subject}\n{body}");
        return Ok(());
    }
    let key = env::get("POKOIN_UPTIME_RESEND_API_KEY")
        .or_else(|| env::get("RESEND_API_KEY"))
        .ok_or_else(|| anyhow!("no RESEND_API_KEY in the environment or uptime-mail.env"))?;
    let url = env::get_or("POKOIN_RESEND_URL", "https://api.resend.com/emails");
    let payload = serde_json::json!({
        "from": from,
        "to": [to],
        "subject": subject,
        "text": truncate(body, 60_000),
    });
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).user_agent(UA).build();
    let mut last = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(3 * attempt));
        }
        match agent
            .post(&url)
            .set("Authorization", &format!("Bearer {key}"))
            .send_json(payload.clone())
        {
            Ok(_) => return Ok(()),
            Err(ureq::Error::Status(code, resp)) => {
                last = format!("HTTP {code}: {}", truncate(&resp.into_string().unwrap_or_default(), 300));
                if (400..500).contains(&code) && code != 429 {
                    break;
                }
            }
            Err(err) => last = err.to_string(),
        }
    }
    Err(anyhow!("resend failed: {last}"))
}

pub fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (truncated)", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subject_collapses_whitespace_and_caps_unicode() {
        let s = subject("  check\n\r detail\t  with\u{2003}spaces  ");
        assert!(s.ends_with(" check detail with spaces"), "{s}");
        assert!(!s.chars().any(|c| c.is_whitespace() && c != ' '));
        let s = subject(&"é".repeat(300));
        assert_eq!(s.chars().count(), 200);
        assert!(s.ends_with('é'));
    }

    // One test owns every mail key: tests share the process environment.
    #[test]
    fn recipient_and_sender_come_only_from_configuration() {
        for k in [TO_KEY, TO_FALLBACK_KEY, FROM_KEY, "POKOIN_OPS_DRY_RUN"] {
            std::env::remove_var(k);
        }
        let err = recipient().unwrap_err().to_string();
        assert!(err.contains("not configured"), "{err}");
        assert!(err.contains(TO_KEY), "{err}");
        assert!(!err.contains('@'), "error must not name an address: {err}");
        let err = sender().unwrap_err().to_string();
        assert!(err.contains("not configured"), "{err}");
        assert!(err.contains(FROM_KEY), "{err}");
        assert!(!err.contains('@'), "error must not name an address: {err}");

        std::env::set_var(TO_FALLBACK_KEY, "alerts@example.invalid");
        assert_eq!(recipient().unwrap(), "alerts@example.invalid");
        std::env::remove_var(TO_FALLBACK_KEY);
        std::env::set_var(TO_KEY, "alerts@example.invalid");
        assert_eq!(recipient().unwrap(), "alerts@example.invalid");
        std::env::set_var(FROM_KEY, "Alerts <alerts@example.invalid>");
        assert_eq!(sender().unwrap(), "Alerts <alerts@example.invalid>");

        // The only send() call: dry-run returns before any network access.
        std::env::set_var("POKOIN_OPS_DRY_RUN", "1");
        assert!(send("s", "b").is_ok());

        for k in [TO_KEY, FROM_KEY, "POKOIN_OPS_DRY_RUN"] {
            std::env::remove_var(k);
        }
    }
}
