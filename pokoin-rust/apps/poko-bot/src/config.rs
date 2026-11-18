use std::collections::HashSet;
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrainMode {
    Hermes,
    Canary,
    Rust,
}

impl BrainMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hermes => "hermes",
            Self::Canary => "canary",
            Self::Rust => "rust",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub telegram_enabled: bool,
    pub discord_enabled: bool,
    pub telegram_token: Option<String>,
    pub discord_token: Option<String>,
    pub api_base: String,
    pub service_token: Option<String>,
    pub hermes_url: String,
    pub hermes_token: Option<String>,
    pub brain_mode: BrainMode,
    pub canary_uids: HashSet<String>,
    pub canary_telegram_ids: HashSet<String>,
    pub canary_discord_ids: HashSet<String>,
    pub telegram_chat_ids: Vec<String>,
    pub discord_channel_ids: Vec<String>,
    pub discord_user_ids: Vec<String>,
    pub gemini_api_key: Option<String>,
    pub gemini_model: String,
    pub max_audio_bytes: u64,
    pub max_audio_duration_seconds: u64,
    pub state_dir: PathBuf,
    pub health_addr: SocketAddr,
    /// Host-wide gateway singleton lock (same record format as Hermes Node).
    pub gateway_lock_enabled: bool,
    pub gateway_lock_dir: PathBuf,
    /// Bounded wait-out cycles when every route failed transiently.
    pub transient_wait_ms: Vec<u64>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let health_addr = env_or("POKO_BOT_HEALTH_ADDR", "127.0.0.1:8790")
            .parse()
            .map_err(|error| anyhow::anyhow!("POKO_BOT_HEALTH_ADDR: {error}"))?;
        let mode_raw = env_or("POKO_BOT_BRAIN_MODE", "canary");
        let brain_mode = match mode_raw.to_ascii_lowercase().as_str() {
            "hermes" => BrainMode::Hermes,
            "rust" => BrainMode::Rust,
            "canary" => BrainMode::Canary,
            other => {
                tracing::warn!(value = other, "unknown POKO_BOT_BRAIN_MODE, using canary");
                BrainMode::Canary
            }
        };
        let max_audio_bytes = parse_u64("TELEGRAM_MAX_AUDIO_BYTES", 25 * 1024 * 1024)?;
        let max_audio_duration_seconds = parse_u64("TELEGRAM_MAX_AUDIO_DURATION_SECONDS", 900)?;
        Ok(Self {
            telegram_enabled: flag("POKO_BOT_TELEGRAM"),
            discord_enabled: flag("POKO_BOT_DISCORD"),
            telegram_token: nonempty("TELEGRAM_BOT_TOKEN_POKO"),
            discord_token: nonempty("DISCORD_BOT_TOKEN_POKO"),
            api_base: env_or("POKO_BOT_API_BASE", "https://api.pokoin.com")
                .trim_end_matches('/')
                .to_string(),
            service_token: nonempty("POKO_SERVICE_TOKEN")
                .or_else(|| nonempty("POKO_MARKET_API_TOKEN"))
                .or_else(|| nonempty("POKO_API_TOKEN")),
            hermes_url: env_or("POKO_BOT_HERMES_URL", "http://127.0.0.1:8789/api/poko/chat"),
            hermes_token: nonempty("POKO_BOT_HERMES_TOKEN").or_else(|| nonempty("POKO_API_TOKEN")),
            brain_mode,
            canary_uids: csv_set("POKO_BOT_CANARY_UIDS"),
            canary_telegram_ids: csv_set("POKO_BOT_CANARY_TELEGRAM_IDS"),
            canary_discord_ids: csv_set("POKO_BOT_CANARY_DISCORD_IDS"),
            telegram_chat_ids: csv_list("TELEGRAM_CHAT_ID_POKO"),
            discord_channel_ids: csv_list("DISCORD_ALLOWED_CHANNEL_IDS_POKO"),
            discord_user_ids: csv_list("DISCORD_ALLOWED_USER_IDS_POKO"),
            gemini_api_key: nonempty("GEMINI_API_KEY"),
            gemini_model: env_or("POKO_BOT_GEMINI_MODEL", "gemini-2.5-flash-lite"),
            max_audio_bytes,
            max_audio_duration_seconds,
            gateway_lock_enabled: !matches!(
                env_or("HERMES_GATEWAY_LOCK", "true")
                    .to_ascii_lowercase()
                    .as_str(),
                "false" | "off" | "0"
            ),
            gateway_lock_dir: PathBuf::from(env_or(
                "HERMES_GATEWAY_LOCK_DIR",
                &format!(
                    "{}/gateway-locks",
                    env_or("POKO_BOT_STATE_DIR", "/var/lib/poko-bot")
                ),
            )),
            transient_wait_ms: parse_ms_list("POKO_BOT_TRANSIENT_WAIT_MS", &[4_000, 12_000])?,
            state_dir: PathBuf::from(env_or("POKO_BOT_STATE_DIR", "/var/lib/poko-bot")),
            health_addr,
        })
    }

    pub fn test(mode: BrainMode) -> Self {
        Self {
            telegram_enabled: false,
            discord_enabled: false,
            telegram_token: None,
            discord_token: None,
            api_base: "http://api.test".into(),
            service_token: Some("svc".into()),
            hermes_url: "http://hermes.test/api/poko/chat".into(),
            hermes_token: Some("hermes".into()),
            brain_mode: mode,
            canary_uids: HashSet::new(),
            canary_telegram_ids: HashSet::new(),
            canary_discord_ids: HashSet::new(),
            telegram_chat_ids: Vec::new(),
            discord_channel_ids: Vec::new(),
            discord_user_ids: Vec::new(),
            gemini_api_key: None,
            gemini_model: "gemini-2.5-flash-lite".into(),
            max_audio_bytes: 25 * 1024 * 1024,
            max_audio_duration_seconds: 900,
            state_dir: PathBuf::from("/tmp/poko-bot-test"),
            health_addr: "127.0.0.1:9".parse().expect("addr"),
            gateway_lock_enabled: false,
            gateway_lock_dir: PathBuf::from("/tmp/poko-bot-test/gateway-locks"),
            transient_wait_ms: Vec::new(),
        }
    }

    pub fn log_effective(&self) {
        tracing::info!(
            telegram = on_off(self.telegram_enabled),
            discord = on_off(self.discord_enabled),
            telegram_token = presence(&self.telegram_token),
            discord_token = presence(&self.discord_token),
            api_base = %self.api_base,
            service_token = presence(&self.service_token),
            hermes_url = %self.hermes_url,
            hermes_token = presence(&self.hermes_token),
            brain_mode = self.brain_mode.as_str(),
            canary_uids = self.canary_uids.len(),
            canary_telegram_ids = self.canary_telegram_ids.len(),
            canary_discord_ids = self.canary_discord_ids.len(),
            telegram_chats = self.telegram_chat_ids.len(),
            discord_channels = self.discord_channel_ids.len(),
            discord_users = self.discord_user_ids.len(),
            gemini_key = presence(&self.gemini_api_key),
            gemini_model = %self.gemini_model,
            max_audio_bytes = self.max_audio_bytes,
            max_audio_duration_seconds = self.max_audio_duration_seconds,
            state_dir = %self.state_dir.display(),
            health = %self.health_addr,
            gateway_lock = on_off(self.gateway_lock_enabled),
            gateway_lock_dir = %self.gateway_lock_dir.display(),
            transient_wait_ms = ?self.transient_wait_ms,
            "poko-bot config"
        );
    }
}

pub fn flag(name: &str) -> bool {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "on" | "true" | "1"))
}

fn on_off(value: bool) -> &'static str {
    if value {
        "on"
    } else {
        "off"
    }
}

pub fn presence(value: &Option<String>) -> &'static str {
    if value.as_ref().is_some_and(|item| !item.is_empty()) {
        "set"
    } else {
        "missing"
    }
}

fn nonempty(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_or(name: &str, default: &str) -> String {
    nonempty(name).unwrap_or_else(|| default.to_string())
}

fn csv_list(name: &str) -> Vec<String> {
    nonempty(name)
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn csv_set(name: &str) -> HashSet<String> {
    csv_list(name).into_iter().collect()
}

fn parse_u64(name: &str, default: u64) -> anyhow::Result<u64> {
    match nonempty(name) {
        None => Ok(default),
        Some(value) => value
            .parse()
            .map_err(|error| anyhow::anyhow!("{name}: {error}")),
    }
}

/// Comma-separated millisecond delays ("4000,12000"); empty disables.
fn parse_ms_list(name: &str, default: &[u64]) -> anyhow::Result<Vec<u64>> {
    match env::var(name) {
        Err(_) => Ok(default.to_vec()),
        Ok(raw) => raw
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|item| {
                item.parse()
                    .map_err(|error| anyhow::anyhow!("{name}: {error}"))
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_wait_list_parses_and_can_be_disabled() {
        let _lock = ENV_LOCK.lock().unwrap();
        env::remove_var("POKO_BOT_TRANSIENT_WAIT_MS");
        assert_eq!(
            parse_ms_list("POKO_BOT_TRANSIENT_WAIT_MS", &[4_000, 12_000]).unwrap(),
            vec![4_000, 12_000]
        );
        env::set_var("POKO_BOT_TRANSIENT_WAIT_MS", " 100, 250 ");
        assert_eq!(
            parse_ms_list("POKO_BOT_TRANSIENT_WAIT_MS", &[1]).unwrap(),
            vec![100, 250]
        );
        env::set_var("POKO_BOT_TRANSIENT_WAIT_MS", "");
        assert!(parse_ms_list("POKO_BOT_TRANSIENT_WAIT_MS", &[1])
            .unwrap()
            .is_empty());
        env::set_var("POKO_BOT_TRANSIENT_WAIT_MS", "soon");
        assert!(parse_ms_list("POKO_BOT_TRANSIENT_WAIT_MS", &[1]).is_err());
        env::remove_var("POKO_BOT_TRANSIENT_WAIT_MS");
    }

    #[test]
    fn off_values_are_anything_but_on_true_one() {
        let _lock = ENV_LOCK.lock().unwrap();
        env::set_var("POKO_BOT_TELEGRAM", "yes");
        env::set_var("POKO_BOT_DISCORD", "ON");
        assert!(!flag("POKO_BOT_TELEGRAM"));
        assert!(flag("POKO_BOT_DISCORD"));
        env::remove_var("POKO_BOT_TELEGRAM");
        env::remove_var("POKO_BOT_DISCORD");
    }

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
}
