//! `/start`, `/connect`, `/whoami`, `/disconnect`, `/help` for Telegram and Discord.
//! Slash commands and PKN bets stay in Hermes.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

const LINK_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const REDEEM_WINDOW: Duration = Duration::from_secs(10 * 60);
const REDEEM_MAX: usize = 5;
pub const LINKED_PREFIX: &str = "✨ Linked!";
pub const CONNECT_ERROR: &str =
    "Hmm, that didn't work on my side. Please try again in a moment. 🛠️";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Telegram,
    Discord,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Telegram => "telegram",
            Self::Discord => "discord",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Telegram => "Telegram",
            Self::Discord => "Discord",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub command: String,
    pub arg: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TelegramParse {
    Command(Command),
    /// `/cmd@SomeOtherBot` — ignore the message, do not fall through.
    OtherBot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedProfile {
    pub firebase_uid: String,
    pub channel: Channel,
    pub telegram_username: String,
    pub discord_username: String,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    at_ms: u64,
    profile: Option<LinkedProfile>,
}

pub struct ConnectState {
    cache: Mutex<HashMap<String, CacheEntry>>,
    attempts: Mutex<HashMap<String, Vec<u64>>>,
}

impl ConnectState {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            attempts: Mutex::new(HashMap::new()),
        }
    }

    pub fn take_redeem_attempt(&self, key: &str, now_ms: u64) -> bool {
        let window = REDEEM_WINDOW.as_millis() as u64;
        let mut attempts = self.attempts.lock().expect("redeem attempts");
        let recent = attempts.entry(key.to_string()).or_default();
        recent.retain(|at| now_ms.saturating_sub(*at) < window);
        if recent.len() >= REDEEM_MAX {
            return false;
        }
        recent.push(now_ms);
        true
    }

    fn cached(&self, key: &str, now_ms: u64) -> Option<Option<LinkedProfile>> {
        let cache = self.cache.lock().expect("link cache");
        let entry = cache.get(key)?;
        if now_ms.saturating_sub(entry.at_ms) < LINK_CACHE_TTL.as_millis() as u64 {
            Some(entry.profile.clone())
        } else {
            None
        }
    }

    fn store(&self, key: &str, now_ms: u64, profile: Option<LinkedProfile>) {
        self.cache.lock().expect("link cache").insert(
            key.to_string(),
            CacheEntry {
                at_ms: now_ms,
                profile,
            },
        );
    }

    pub fn invalidate(&self, channel: Channel, user_id: &str) {
        self.cache
            .lock()
            .expect("link cache")
            .remove(&cache_key(channel, user_id));
    }

    pub async fn status(
        &self,
        api: &dyn ConnectApi,
        channel: Channel,
        user_id: &str,
        now_ms: u64,
    ) -> Option<LinkedProfile> {
        if user_id.is_empty() {
            return None;
        }
        let key = cache_key(channel, user_id);
        if let Some(hit) = self.cached(&key, now_ms) {
            return hit;
        }
        let profile = match api.request(status_body(channel, user_id)).await {
            Ok(body) => profile_from_status(channel, &body),
            Err(error) => {
                tracing::warn!(channel = channel.as_str(), error = %error, "poko-connect status lookup failed");
                None
            }
        };
        self.store(&key, now_ms, profile.clone());
        profile
    }
}

impl Default for ConnectState {
    fn default() -> Self {
        Self::new()
    }
}

fn cache_key(channel: Channel, user_id: &str) -> String {
    format!("{}:{user_id}", channel.as_str())
}

#[async_trait]
pub trait ConnectApi: Send + Sync {
    async fn request(&self, body: Value) -> Result<Value, String>;
}

pub fn normalize_link_code(raw: &str) -> String {
    let code = raw.trim().to_ascii_uppercase();
    if code.len() >= 6 && code.len() <= 12 && code.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        code
    } else {
        String::new()
    }
}

pub fn parse_telegram_command(raw: &str, bot_username: &str) -> Option<TelegramParse> {
    let text = raw.trim();
    let caps = telegram_command().captures(text)?;
    let named = caps.get(2).map(|m| m.as_str()).unwrap_or("");
    if !named.is_empty() {
        let ours = bot_username.trim().trim_start_matches('@');
        if !ours.eq_ignore_ascii_case(named) {
            return Some(TelegramParse::OtherBot);
        }
    }
    Some(TelegramParse::Command(Command {
        command: caps[1].to_ascii_lowercase(),
        arg: caps.get(3).map(|m| m.as_str()).unwrap_or("").to_string(),
    }))
}

pub fn parse_discord_command(raw: &str) -> Option<Command> {
    let caps = discord_command().captures(raw.trim())?;
    Some(Command {
        command: caps[1].to_ascii_lowercase(),
        arg: caps.get(2).map(|m| m.as_str()).unwrap_or("").to_string(),
    })
}

pub fn leaked_guild_code(text: &str) -> bool {
    leaked_code().is_match(text.trim())
}

pub fn poko_welcome_text() -> String {
    [
        "Hey hey! ✨ I'm Poko — an AI assistant living inside Pokoin: part tour guide, part TCG nerd.",
        "",
        "What I can do:",
        "• Card prices, market chatter, set lore",
        "• Marketplace and wallet questions",
        "• A private chat that belongs to just you — nothing you say here is shared",
        "",
        "Link your Pokoin profile to get the most out of me:",
        "• /connect CODE — grab the code at https://pokoin.com/profile",
        "• /whoami — check your link",
        "• /disconnect — unlink anytime",
        "• /help — this message",
    ]
    .join("\n")
}

fn connect_help_text(channel: Channel) -> String {
    let where_line = if channel == Channel::Discord {
        "Send it here like: /connect ABCD1234"
    } else {
        "Send it here like: /connect ABCD1234 (or use the Telegram deep link from the profile page)"
    };
    [
        "To connect your Pokoin profile:",
        "1. Sign in and open https://pokoin.com/profile",
        "2. In the Poko Connect panel, press \"Get link code\".",
        &format!("3. {where_line}"),
        "",
        "The code expires in 15 minutes and works once. Same code works on Telegram or Discord. ✨",
    ]
    .join("\n")
}

pub fn linked_profile_context_line(profile: Option<&LinkedProfile>) -> String {
    let Some(profile) = profile else {
        return String::new();
    };
    let handle = if !profile.discord_username.is_empty() {
        format!(" (@{})", profile.discord_username)
    } else if !profile.telegram_username.is_empty() {
        format!(" (@{})", profile.telegram_username)
    } else {
        String::new()
    };
    format!(
        "[Pokoin profile] This user verified and linked their Pokoin account to {}{handle}. You may greet them naturally; never reveal the raw account id. Their chat memory is the same private peer as website Messages.",
        profile.channel.label()
    )
}

pub fn status_body(channel: Channel, user_id: &str) -> Value {
    match channel {
        Channel::Telegram => json!({ "action": "status", "telegramUserId": user_id }),
        Channel::Discord => json!({ "action": "status", "discordUserId": user_id }),
    }
}

pub fn unlink_body(channel: Channel, user_id: &str) -> Value {
    match channel {
        Channel::Telegram => json!({ "action": "unlink", "telegramUserId": user_id }),
        Channel::Discord => json!({ "action": "unlink", "discordUserId": user_id }),
    }
}

pub fn redeem_body(
    channel: Channel,
    user_id: &str,
    username: &str,
    display_name: &str,
    code: &str,
) -> Value {
    match channel {
        Channel::Telegram => json!({
            "action": "redeem",
            "code": code,
            "telegramUserId": user_id,
            "telegramUsername": username,
            "telegramDisplayName": display_name,
        }),
        Channel::Discord => json!({
            "action": "redeem",
            "code": code,
            "discordUserId": user_id,
            "discordUsername": username,
            "discordDisplayName": display_name,
        }),
    }
}

#[derive(Clone, Copy)]
pub struct Identity<'a> {
    pub channel: Channel,
    pub user_id: &'a str,
    pub username: &'a str,
    pub display_name: &'a str,
}

pub async fn run_command(
    state: &ConnectState,
    api: &dyn ConnectApi,
    command: &str,
    arg: &str,
    identity: Identity<'_>,
    now_ms: u64,
) -> String {
    let result = async {
        match command {
            "start" => {
                if let Some(code) = deep_link_code(arg) {
                    redeem_reply(state, api, &code, identity, now_ms).await
                } else {
                    Ok(poko_welcome_text())
                }
            }
            "help" => Ok(poko_welcome_text()),
            "connect" => {
                if arg.is_empty() {
                    Ok(connect_help_text(identity.channel))
                } else {
                    redeem_reply(state, api, arg, identity, now_ms).await
                }
            }
            "whoami" => Ok(whoami(state, api, identity, now_ms).await),
            "disconnect" => disconnect(state, api, identity).await,
            _ => Ok(String::new()),
        }
    }
    .await;
    match result {
        Ok(text) => text,
        Err(error) => {
            tracing::warn!(command, channel = identity.channel.as_str(), error = %error, "poko connect command failed");
            CONNECT_ERROR.to_string()
        }
    }
}

async fn whoami(
    state: &ConnectState,
    api: &dyn ConnectApi,
    identity: Identity<'_>,
    now_ms: u64,
) -> String {
    let profile = state
        .status(api, identity.channel, identity.user_id, now_ms)
        .await;
    let Some(profile) = profile else {
        return "You haven't linked a Pokoin profile yet. Send /connect CODE — get the code from your profile page on pokoin.com ✨".to_string();
    };
    let handle = if !profile.discord_username.is_empty() || !profile.telegram_username.is_empty() {
        format!(
            " (@{})",
            if !profile.discord_username.is_empty() {
                &profile.discord_username
            } else {
                &profile.telegram_username
            }
        )
    } else {
        String::new()
    };
    format!(
        "Your {} is linked to a Pokoin profile{handle}. Memories stay private to you and match website Messages 😊",
        identity.channel.label()
    )
}

async fn disconnect(
    state: &ConnectState,
    api: &dyn ConnectApi,
    identity: Identity<'_>,
) -> Result<String, String> {
    api.request(unlink_body(identity.channel, identity.user_id))
        .await?;
    state.invalidate(identity.channel, identity.user_id);
    Ok(format!(
        "Done — your Pokoin profile is unlinked from {}. Your conversations with me stay in your own private memory. 💛",
        identity.channel.label()
    ))
}

async fn redeem_reply(
    state: &ConnectState,
    api: &dyn ConnectApi,
    raw_code: &str,
    identity: Identity<'_>,
    now_ms: u64,
) -> Result<String, String> {
    let code = normalize_link_code(raw_code);
    if code.is_empty() {
        return Ok("That doesn't look like a link code (6-12 letters/numbers). Grab one from your profile page on pokoin.com and send /connect CODE 😊".to_string());
    }
    let key = cache_key(identity.channel, identity.user_id);
    if !state.take_redeem_attempt(&key, now_ms) {
        return Ok(
            "Too many link attempts — wait 10 minutes, then use a fresh code from your profile page. 🛡️"
                .to_string(),
        );
    }
    let result = api
        .request(redeem_body(
            identity.channel,
            identity.user_id,
            identity.username,
            identity.display_name,
            &code,
        ))
        .await?;
    if result.get("linked").and_then(|value| value.as_bool()) != Some(true) {
        let error = result
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown reason");
        return Ok(format!(
            "That code didn't work ({error}). Codes last 15 minutes and work once — grab a fresh one from your profile page on pokoin.com and send /connect CODE 😊"
        ));
    }
    state.invalidate(identity.channel, identity.user_id);
    Ok(format!(
        "{LINKED_PREFIX} Your Pokoin profile is now connected to {}.\n\nI'll remember our conversations here privately — same persona as website Messages. Ask me anything about cards or the marketplace — /help shows what I can do. 😊",
        identity.channel.label()
    ))
}

fn profile_from_status(channel: Channel, body: &Value) -> Option<LinkedProfile> {
    if body.get("linked").and_then(|value| value.as_bool()) != Some(true) {
        return None;
    }
    Some(LinkedProfile {
        firebase_uid: body
            .get("firebaseUid")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        channel,
        telegram_username: body
            .get("telegramUsername")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        discord_username: body
            .get("discordUsername")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

fn deep_link_code(arg: &str) -> Option<String> {
    let caps = deep_link().captures(arg.trim())?;
    let code = normalize_link_code(&caps[1]);
    if code.is_empty() {
        None
    } else {
        Some(code)
    }
}

pub fn guild_notice(user_id: &str, linked: bool) -> String {
    let status = if linked {
        "✅ Profilo Pokoin collegato. "
    } else {
        "❌ Codice non valido o scaduto. "
    };
    format!(
        "<@{user_id}> {status}Ho cancellato il messaggio col codice: la prossima volta usa il comando **/connect** (la risposta la vedi solo tu) o scrivimi in DM."
    )
}

fn telegram_command() -> &'static regex::Regex {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)^/(start|connect|disconnect|whoami|help)(?:@([A-Za-z0-9_]+))?(?:\s+(\S+))?\s*$",
        )
        .expect("telegram command")
    });
    &RE
}

fn discord_command() -> &'static regex::Regex {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)^/?(start|connect|disconnect|whoami|help)(?:\s+(\S+))?\s*$")
            .expect("discord command")
    });
    &RE
}

fn leaked_code() -> &'static regex::Regex {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)^/?(connect\s+\S+|start\s+connect[_-]\S+)").expect("leaked code")
    });
    &RE
}

fn deep_link() -> &'static regex::Regex {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)^connect[_-]([A-Za-z0-9]{6,12})$").expect("deep link")
    });
    &RE
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    type ConnectHandler = Box<dyn Fn(&Value) -> Result<Value, String> + Send + Sync>;

    struct Fake {
        calls: Mutex<Vec<Value>>,
        handler: ConnectHandler,
    }

    #[async_trait]
    impl ConnectApi for Fake {
        async fn request(&self, body: Value) -> Result<Value, String> {
            self.calls.lock().unwrap().push(body.clone());
            (self.handler)(&body)
        }
    }

    fn fake(handler: impl Fn(&Value) -> Result<Value, String> + Send + Sync + 'static) -> Fake {
        Fake {
            calls: Mutex::new(Vec::new()),
            handler: Box::new(handler),
        }
    }

    #[test]
    fn telegram_commands_parse_including_deep_links_and_bot_suffix() {
        assert_eq!(
            parse_telegram_command("/start", "Poko"),
            Some(TelegramParse::Command(Command {
                command: "start".into(),
                arg: String::new()
            }))
        );
        assert_eq!(
            parse_telegram_command("/connect ABCD2345", "Poko"),
            Some(TelegramParse::Command(Command {
                command: "connect".into(),
                arg: "ABCD2345".into()
            }))
        );
        assert_eq!(
            parse_telegram_command("/start connect_ABCD2345", "Poko"),
            Some(TelegramParse::Command(Command {
                command: "start".into(),
                arg: "connect_ABCD2345".into()
            }))
        );
        assert_eq!(
            parse_telegram_command("/WHOAMI", "Poko"),
            Some(TelegramParse::Command(Command {
                command: "whoami".into(),
                arg: String::new()
            }))
        );
        assert_eq!(parse_telegram_command("hello /connect", "Poko"), None);
        assert_eq!(
            parse_telegram_command("/connect", "Poko"),
            Some(TelegramParse::Command(Command {
                command: "connect".into(),
                arg: String::new()
            }))
        );
        assert_eq!(parse_telegram_command("/drop table", "Poko"), None);
        assert_eq!(
            parse_telegram_command("/connect@PokoBot ABCD2345", "PokoBot"),
            Some(TelegramParse::Command(Command {
                command: "connect".into(),
                arg: "ABCD2345".into()
            }))
        );
        assert_eq!(
            parse_telegram_command("/help@OtherBot", "PokoBot"),
            Some(TelegramParse::OtherBot)
        );
        assert_eq!(
            parse_discord_command("connect ABCD2345"),
            Some(Command {
                command: "connect".into(),
                arg: "ABCD2345".into()
            })
        );
        assert_eq!(parse_discord_command("hello"), None);
    }

    #[test]
    fn welcome_text_introduces_the_assistant() {
        let text = poko_welcome_text();
        assert!(text.contains("AI assistant"));
        assert!(text.contains("private chat"));
        assert!(text.contains("/connect CODE"));
        assert!(text.contains("/disconnect"));
    }

    #[test]
    fn link_codes_normalize() {
        assert_eq!(normalize_link_code(" abcd1234 "), "ABCD1234");
        assert_eq!(normalize_link_code("abc"), "");
        assert_eq!(normalize_link_code("ABCD-1234"), "");
    }

    #[tokio::test]
    async fn connect_without_a_code_explains_where_to_get_one() {
        let api = fake(|_| panic!("should not be called"));
        let state = ConnectState::new();
        let reply = run_command(
            &state,
            &api,
            "connect",
            "",
            Identity {
                channel: Channel::Telegram,
                user_id: "555",
                username: "",
                display_name: "",
            },
            0,
        )
        .await;
        assert!(reply.contains("https://pokoin.com/profile"));
        assert!(reply.contains("Get link code"));
        assert!(api.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn connect_redeems_and_disconnect_unlinks() {
        let api = fake(|body| {
            Ok(match body["action"].as_str() {
                Some("redeem") => {
                    json!({ "ok": true, "action": "redeem", "linked": true, "firebaseUid": "fb-9" })
                }
                Some("unlink") => json!({ "ok": true, "action": "unlink", "linked": false }),
                _ => json!({ "ok": true, "linked": false }),
            })
        });
        let state = ConnectState::new();
        let linked = run_command(
            &state,
            &api,
            "connect",
            "ABCD2345",
            Identity {
                channel: Channel::Telegram,
                user_id: "555000111",
                username: "raichu_fan",
                display_name: "Raichu Fan",
            },
            0,
        )
        .await;
        assert!(linked.contains("Linked"));
        assert_eq!(
            api.calls.lock().unwrap()[0],
            json!({
                "action": "redeem",
                "code": "ABCD2345",
                "telegramUserId": "555000111",
                "telegramUsername": "raichu_fan",
                "telegramDisplayName": "Raichu Fan",
            })
        );
        let gone = run_command(
            &state,
            &api,
            "disconnect",
            "",
            Identity {
                channel: Channel::Telegram,
                user_id: "555000111",
                username: "",
                display_name: "",
            },
            0,
        )
        .await;
        assert!(gone.contains("unlinked"));
        let calls = api.calls.lock().unwrap();
        assert_eq!(calls.last().unwrap()["action"], "unlink");
    }

    #[tokio::test]
    async fn bad_code_is_honest_and_malformed_codes_never_hit_the_api() {
        let api = fake(|_| {
            Ok(json!({
                "ok": true,
                "action": "redeem",
                "linked": false,
                "error": "code invalid, expired, or already used"
            }))
        });
        let state = ConnectState::new();
        let reply = run_command(
            &state,
            &api,
            "connect",
            "DEADCODE",
            Identity {
                channel: Channel::Telegram,
                user_id: "555000111",
                username: "",
                display_name: "",
            },
            0,
        )
        .await;
        assert!(reply.contains("didn't work"));
        assert!(reply.contains("15 minutes"));
        let malformed = run_command(
            &state,
            &api,
            "connect",
            "../../etc",
            Identity {
                channel: Channel::Discord,
                user_id: "42",
                username: "ann",
                display_name: "Ann",
            },
            0,
        )
        .await;
        assert!(malformed.contains("doesn't look like a link code"));
        assert_eq!(api.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn deep_link_start_redeems() {
        let api = fake(|_| Ok(json!({ "ok": true, "linked": true, "firebaseUid": "fb-1" })));
        let state = ConnectState::new();
        let reply = run_command(
            &state,
            &api,
            "start",
            "connect_ABCD2345",
            Identity {
                channel: Channel::Telegram,
                user_id: "555000111",
                username: "",
                display_name: "",
            },
            0,
        )
        .await;
        assert!(reply.contains("Linked"));
        assert_eq!(api.calls.lock().unwrap()[0]["action"], "redeem");
        assert_eq!(api.calls.lock().unwrap()[0]["code"], "ABCD2345");
    }

    #[tokio::test]
    async fn linked_profile_lookup_caches_and_renders_a_context_line() {
        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = hits.clone();
        let api = fake(move |_| {
            hits2.fetch_add(1, Ordering::SeqCst);
            Ok(json!({
                "ok": true,
                "linked": true,
                "firebaseUid": "fb-9",
                "telegramUsername": "raichu_fan"
            }))
        });
        let state = ConnectState::new();
        let profile = state
            .status(&api, Channel::Telegram, "555000111", 0)
            .await
            .unwrap();
        assert_eq!(profile.telegram_username, "raichu_fan");
        state
            .status(&api, Channel::Telegram, "555000111", 1_000)
            .await;
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let line = linked_profile_context_line(Some(&profile));
        assert!(line.contains("@raichu_fan"));
        assert!(line.contains("never reveal"));
        assert_eq!(linked_profile_context_line(None), "");
        let later = state
            .status(&api, Channel::Telegram, "555000111", 5 * 60 * 1000 + 1)
            .await;
        assert!(later.is_some());
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn redeem_attempts_are_rate_limited_per_account() {
        let state = ConnectState::new();
        let now = 1_000_000;
        for index in 0..5 {
            assert!(state.take_redeem_attempt("discord:1", now + index));
        }
        assert!(!state.take_redeem_attempt("discord:1", now + 10));
        assert!(state.take_redeem_attempt("discord:2", now + 10));
        assert!(state.take_redeem_attempt("discord:1", now + 10 * 60_000 + 10));
    }

    #[tokio::test]
    async fn api_errors_use_the_fixed_reply() {
        let api = fake(|_| Err("nope".into()));
        let state = ConnectState::new();
        let reply = run_command(
            &state,
            &api,
            "disconnect",
            "",
            Identity {
                channel: Channel::Discord,
                user_id: "9",
                username: "",
                display_name: "",
            },
            0,
        )
        .await;
        assert_eq!(reply, CONNECT_ERROR);
    }

    #[test]
    fn guild_notice_matches_hermes() {
        let linked = guild_notice("42", true);
        assert!(linked.starts_with("<@42> ✅ Profilo Pokoin collegato. "));
        assert!(linked.contains("**/connect**"));
        assert!(guild_notice("42", false).contains("❌ Codice non valido o scaduto. "));
    }
}
