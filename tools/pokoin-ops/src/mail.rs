//! Same delivery path as scripts/pokoin-uptime-mail.sh: Resend HTTP API with the key
//! from the uptime-mail env file, to the same inbox.

use crate::env;
use anyhow::{anyhow, Result};
use std::time::Duration;

pub const DEFAULT_TO: &str = "vitologiuseppe17@gmail.com";
pub const DEFAULT_FROM: &str = "Pokoin alerts <no-reply@pokoin.com>";
// Resend sits behind Cloudflare; the uptime mailer sends a browser-like UA for the same reason.
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) pokoin-ops/1";

pub fn subject(text: &str) -> String {
    format!("[pokoin {}] {}", env::hostname(), text)
}

pub fn send(subject: &str, body: &str) -> Result<()> {
    let to = env::get("POKOIN_ALERT_MAIL_TO")
        .or_else(|| env::get("POKOIN_UPTIME_MAIL_TO"))
        .unwrap_or_else(|| DEFAULT_TO.into());
    let from = env::get_or("POKOIN_ALERT_MAIL_FROM", DEFAULT_FROM);
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
