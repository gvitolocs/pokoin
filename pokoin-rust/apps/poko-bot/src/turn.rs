use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine;
use serde_json::Value;

use crate::api::{
    ApiClient, ApiError, BrainRequest, BrainResponse, HistoryItem, ImagePart, HERMES_TIMEOUT,
};
use crate::config::{BrainMode, Config};
use crate::connect::{
    guild_notice, leaked_guild_code, parse_discord_command, parse_telegram_command, run_command,
    Channel, ConnectApi, ConnectState, Identity, TelegramParse, LINKED_PREFIX,
};
use crate::format::{append_cards, discord_chunks, strip_card_markers, Card};
use crate::gate::{should_poko_engage, EngageInput};
use crate::health::Metrics;
use crate::hermes::{self, HermesRequest, HermesResponse, HermesUser};
use crate::history::{now_ms, History};
use crate::media::Gemini;
use crate::{contract_address_reply, APOLOGY};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Telegram,
    Discord,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Telegram => "telegram",
            Self::Discord => "discord",
        }
    }

    fn channel(self) -> Channel {
        match self {
            Self::Telegram => Channel::Telegram,
            Self::Discord => Channel::Discord,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Dm,
    Group,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dm => "dm",
            Self::Group => "group",
        }
    }
}

#[derive(Clone)]
pub struct IncomingImage {
    pub mime: String,
    pub bytes: Vec<u8>,
}

#[async_trait]
pub trait ServerContext: Send + Sync {
    async fn load(&self) -> String;
}

#[async_trait]
pub trait Typing: Send + Sync {
    fn interval(&self) -> Duration;
    async fn pulse(&self);
}

pub struct Incoming {
    pub platform: Platform,
    pub chat_id: String,
    pub message_id: String,
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub scope: Scope,
    pub text: String,
    /// Set for photo turns. The brain receives this caption, which may be empty.
    pub caption: Option<String>,
    pub is_mentioned: bool,
    pub is_reply_to_bot: bool,
    pub bot_username: String,
    pub channel_name: String,
    pub parent_name: String,
    pub in_guild: bool,
    /// Discord guild id. Telegram and Discord DMs leave this empty.
    pub guild_id: Option<String>,
    pub image: Option<IncomingImage>,
    pub server_context: Option<Arc<dyn ServerContext>>,
}

impl Incoming {
    pub fn text(
        platform: Platform,
        scope: Scope,
        user_id: &str,
        chat_id: &str,
        text: &str,
    ) -> Self {
        Self {
            platform,
            chat_id: chat_id.to_string(),
            message_id: "1".into(),
            user_id: user_id.to_string(),
            username: String::new(),
            display_name: String::new(),
            scope,
            text: text.to_string(),
            caption: None,
            is_mentioned: false,
            is_reply_to_bot: false,
            bot_username: String::new(),
            channel_name: String::new(),
            parent_name: String::new(),
            in_guild: scope == Scope::Group && platform == Platform::Discord,
            guild_id: None,
            image: None,
            server_context: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub session_key: String,
    pub user_text: String,
    pub assistant_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub texts: Vec<String>,
    pub delete_original: bool,
    pub reply: bool,
    pub html: bool,
    pub record: Option<Record>,
}

#[async_trait]
pub trait Services: Send + Sync {
    async fn brain_chat(&self, body: &BrainRequest) -> Result<BrainResponse, ApiError>;
    async fn hermes_chat(&self, body: &HermesRequest) -> Result<HermesResponse, ApiError>;
    async fn connect_status(&self, body: &Value) -> Result<Value, ApiError>;
    async fn connect_redeem(&self, body: &Value) -> Result<Value, ApiError>;
    async fn connect_unlink(&self, body: &Value) -> Result<Value, ApiError>;
}

#[derive(Clone)]
pub struct Deps {
    pub services: Arc<dyn Services>,
    pub connect: Arc<ConnectState>,
    pub history: Arc<History>,
    pub metrics: Arc<Metrics>,
    pub config: Arc<Config>,
    pub gemini: Option<Arc<Gemini>>,
    pub typing: Option<Arc<dyn Typing>>,
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub http: reqwest::Client,
}

pub struct HttpServices {
    pub api: ApiClient,
    pub http: reqwest::Client,
    pub hermes_url: String,
    pub hermes_token: String,
}

#[async_trait]
impl Services for HttpServices {
    async fn brain_chat(&self, body: &BrainRequest) -> Result<BrainResponse, ApiError> {
        self.api.brain(body).await
    }

    async fn hermes_chat(&self, body: &HermesRequest) -> Result<HermesResponse, ApiError> {
        hermes::chat(
            &self.http,
            &self.hermes_url,
            &self.hermes_token,
            body,
            HERMES_TIMEOUT,
        )
        .await
    }

    async fn connect_status(&self, body: &Value) -> Result<Value, ApiError> {
        self.api.connect(body).await
    }

    async fn connect_redeem(&self, body: &Value) -> Result<Value, ApiError> {
        self.api.connect(body).await
    }

    async fn connect_unlink(&self, body: &Value) -> Result<Value, ApiError> {
        self.api.connect(body).await
    }
}

struct ConnectBridge<'a> {
    services: &'a dyn Services,
}

#[async_trait]
impl ConnectApi for ConnectBridge<'_> {
    async fn request(&self, body: Value) -> Result<Value, String> {
        let action = body
            .get("action")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let result = match action {
            "status" => self.services.connect_status(&body).await,
            "redeem" => self.services.connect_redeem(&body).await,
            "unlink" => self.services.connect_unlink(&body).await,
            other => return Err(format!("unknown connect action {other}")),
        };
        result.map_err(|error| error.to_string())
    }
}

pub fn session_key(incoming: &Incoming) -> String {
    match incoming.platform {
        Platform::Telegram => format!("telegram_chat_{}", incoming.chat_id),
        Platform::Discord if incoming.scope == Scope::Dm => {
            format!("discord_dm_{}", incoming.user_id)
        }
        Platform::Discord => format!("discord_channel_{}", incoming.chat_id),
    }
}

pub fn user_key(incoming: &Incoming) -> String {
    format!("{}:{}", incoming.platform.as_str(), incoming.user_id)
}

/// Hermes `safeId`: `prefix + "_" + value`, with every character outside
/// `[A-Za-z0-9_-]` replaced by `_`.
pub fn safe_id(prefix: &str, value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    format!("{prefix}_{cleaned}")
}

/// Honcho ids the brain uses to keep the memories Hermes already built.
/// Discord servers always use the guild peer, even when the author is linked.
pub fn memory_ids(incoming: &Incoming, firebase_uid: Option<&str>) -> (String, String) {
    let linked = firebase_uid.map(str::trim).filter(|uid| !uid.is_empty());
    match incoming.platform {
        Platform::Telegram => {
            let peer = match linked {
                Some(uid) => safe_id("poko_user", uid),
                None => safe_id("telegram_user", &incoming.user_id),
            };
            (peer, safe_id("telegram_chat", &incoming.chat_id))
        }
        Platform::Discord if incoming.in_guild => {
            let guild = incoming.guild_id.as_deref().unwrap_or("");
            let peer = safe_id(
                "discord_guild_user",
                &format!("{guild}_{}", incoming.user_id),
            );
            (peer, safe_id("discord_channel", &incoming.chat_id))
        }
        Platform::Discord => {
            let peer = match linked {
                Some(uid) => safe_id("poko_user", uid),
                None => safe_id("discord_user", &incoming.user_id),
            };
            (peer, safe_id("discord_channel", &incoming.chat_id))
        }
    }
}

fn keeps_history(incoming: &Incoming) -> bool {
    incoming.platform == Platform::Telegram || incoming.scope == Scope::Dm
}

pub async fn handle_turn(incoming: &Incoming, deps: &Deps) -> Outcome {
    let started = Instant::now();
    deps.metrics
        .total
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if !allowed(incoming, &deps.config) {
        return skip(deps, "not_allowed");
    }
    let photo = incoming.image.is_some();
    if !photo
        && incoming.platform == Platform::Telegram
        && incoming.text.trim_start().starts_with('/')
    {
        match parse_telegram_command(&incoming.text, &incoming.bot_username) {
            Some(TelegramParse::OtherBot) => return skip(deps, "other_bot"),
            Some(TelegramParse::Command(command)) => {
                return command_outcome(incoming, deps, &command.command, &command.arg, false)
                    .await;
            }
            None => {}
        }
    }

    let gate = should_poko_engage(EngageInput {
        text: &incoming.text,
        platform: incoming.platform.as_str(),
        is_dm: incoming.scope == Scope::Dm,
        is_mentioned: incoming.is_mentioned,
        is_reply_to_bot: incoming.is_reply_to_bot,
        bot_username: &incoming.bot_username,
        channel_name: &incoming.channel_name,
        parent_name: &incoming.parent_name,
    });
    if incoming.platform == Platform::Discord {
        if !gate.should_reply {
            return skip(deps, &gate.reason);
        }
        if !photo {
            if let Some(command) = parse_discord_command(&incoming.text) {
                let leaked = incoming.in_guild && leaked_guild_code(&incoming.text);
                return command_outcome(incoming, deps, &command.command, &command.arg, leaked)
                    .await;
            }
        }
    } else if !gate.should_reply {
        return skip(deps, &gate.reason);
    }

    if crate::gate::is_poko_contract_address_request(&incoming.text) {
        let text = contract_address_reply();
        return finish(
            incoming,
            deps,
            started,
            Built {
                texts: vec![text],
                delete_original: false,
                record: None,
                route: "contract",
                provider: "",
                model: "",
                cards: 0,
            },
        );
    }

    answer(incoming, deps, started).await
}

async fn command_outcome(
    incoming: &Incoming,
    deps: &Deps,
    command: &str,
    arg: &str,
    leaked: bool,
) -> Outcome {
    deps.metrics
        .commands
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let reply = run_command(
        &deps.connect,
        &ConnectBridge {
            services: deps.services.as_ref(),
        },
        command,
        arg,
        Identity {
            channel: incoming.platform.channel(),
            user_id: &incoming.user_id,
            username: &incoming.username,
            display_name: &incoming.display_name,
        },
        (deps.now_ms)(),
    )
    .await;
    if leaked {
        let linked = reply.starts_with(LINKED_PREFIX);
        return Outcome {
            texts: vec![guild_notice(&incoming.user_id, linked)],
            delete_original: true,
            reply: false,
            html: false,
            record: None,
        };
    }
    let html = incoming.platform == Platform::Telegram;
    let texts = if html {
        vec![reply]
    } else {
        discord_chunks(&reply)
    };
    Outcome {
        texts,
        delete_original: false,
        reply: reply_to_user(incoming),
        html,
        record: None,
    }
}

async fn answer(incoming: &Incoming, deps: &Deps, started: Instant) -> Outcome {
    let _typing = spawn_typing(deps.typing.clone());
    let now = (deps.now_ms)();
    let profile = deps
        .connect
        .status(
            &ConnectBridge {
                services: deps.services.as_ref(),
            },
            incoming.platform.channel(),
            &incoming.user_id,
            now,
        )
        .await;
    let firebase_uid = profile
        .as_ref()
        .map(|profile| profile.firebase_uid.clone())
        .filter(|uid| !uid.is_empty());
    let brain = route_brain(&deps.config, firebase_uid.as_deref(), incoming);
    let mut blocks = Vec::new();
    if incoming.in_guild {
        if let Some(loader) = &incoming.server_context {
            let context = loader.load().await;
            if !context.is_empty() {
                blocks.push(context);
            }
        }
    }
    let caption = incoming
        .caption
        .clone()
        .unwrap_or_else(|| incoming.text.clone());
    let mut visual = None;
    if let (Some(image), Some(gemini)) = (&incoming.image, &deps.gemini) {
        visual = gemini.describe(&image.bytes, &image.mime, &caption).await;
        if let Some(description) = &visual {
            blocks.push(format!(
                "Visual context of the user's photo:\n{description}"
            ));
        }
    }
    let images = incoming
        .image
        .as_ref()
        .map(|image| {
            vec![ImagePart {
                mime_type: image.mime.clone(),
                data: base64::engine::general_purpose::STANDARD.encode(&image.bytes),
            }]
        })
        .unwrap_or_default();
    let session = session_key(incoming);
    let history = if keeps_history(incoming) {
        deps.history
            .recent(&session, now)
            .into_iter()
            .map(|turn| HistoryItem {
                role: turn.role,
                text: turn.text,
            })
            .collect()
    } else {
        Vec::new()
    };
    let model_message = if incoming.caption.is_some() {
        caption.clone()
    } else {
        incoming.text.clone()
    };

    let (memory_peer_id, memory_session_id) = memory_ids(incoming, firebase_uid.as_deref());
    if brain {
        let request = BrainRequest {
            platform: incoming.platform.as_str().to_string(),
            scope: incoming.scope.as_str().to_string(),
            user_key: user_key(incoming),
            firebase_uid: firebase_uid.clone(),
            session_id: session.clone(),
            display_name: incoming.display_name.clone(),
            message: model_message.clone(),
            history,
            context_blocks: blocks.clone(),
            images,
            game: "pokemon".into(),
            memory_peer_id: Some(memory_peer_id.clone()),
            memory_session_id: Some(memory_session_id.clone()),
        };
        let call_started = Instant::now();
        match deps.services.brain_chat(&request).await {
            Ok(response) => {
                deps.metrics
                    .push_brain_latency(call_started.elapsed().as_millis() as u64);
                if response.blocked {
                    deps.metrics
                        .blocked
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    tracing::debug!(platform = incoming.platform.as_str(), "turn blocked");
                    return Outcome {
                        texts: Vec::new(),
                        delete_original: false,
                        reply: false,
                        html: false,
                        record: None,
                    };
                }
                if response.ok && !response.reply.trim().is_empty() {
                    deps.metrics
                        .brain_ok
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    return deliver(
                        incoming,
                        deps,
                        started,
                        Delivered {
                            reply: &response.reply,
                            cards: &response.cards,
                            session: &session,
                            user_text: &model_message,
                            meta: RouteMeta {
                                route: "brain",
                                provider: &response.provider,
                                model: &response.model,
                            },
                        },
                    );
                }
                deps.metrics
                    .brain_fail
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            Err(error) => {
                deps.metrics
                    .push_brain_latency(call_started.elapsed().as_millis() as u64);
                deps.metrics
                    .brain_fail
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                tracing::warn!(error = %error, "brain chat failed");
            }
        }
    }

    let hermes_message = hermes_message(incoming, &blocks, &visual, &model_message);
    let user_id = firebase_uid
        .clone()
        .filter(|uid| !uid.is_empty())
        .unwrap_or_else(|| memory_peer_id.clone());
    let request = HermesRequest {
        message: hermes_message,
        user_message: model_message.clone(),
        user_id: user_id.clone(),
        session_id: session.clone(),
        user: HermesUser {
            id: user_id,
            display_name: incoming.display_name.clone(),
        },
        platform: incoming.platform.as_str().to_string(),
    };
    match deps.services.hermes_chat(&request).await {
        Ok(response) if !response.reply_text().is_empty() => {
            deps.metrics
                .hermes_ok
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let provider = if response.provider.is_empty() {
                "hermes".to_string()
            } else {
                response.provider.clone()
            };
            let reply = response.reply_text();
            deliver(
                incoming,
                deps,
                started,
                Delivered {
                    reply: &reply,
                    cards: &response.cards,
                    session: &session,
                    user_text: &model_message,
                    meta: RouteMeta {
                        route: "hermes",
                        provider: &provider,
                        model: &response.model,
                    },
                },
            )
        }
        Ok(_) => apology(incoming, deps, started),
        Err(error) => {
            tracing::warn!(error = %error, "hermes chat failed");
            apology(incoming, deps, started)
        }
    }
}

fn hermes_message(
    incoming: &Incoming,
    blocks: &[String],
    visual: &Option<String>,
    model_message: &str,
) -> String {
    if incoming.image.is_some() {
        let caption = if model_message.trim().is_empty() {
            "(nessuna didascalia)"
        } else {
            model_message.trim()
        };
        let platform_name = match incoming.platform {
            Platform::Telegram => "Telegram",
            Platform::Discord => "Discord",
        };
        let mut photo = format!("The user sent a {platform_name} photo.\n\nCaption: {caption}");
        if let Some(description) = visual {
            photo.push_str("\n\nVisual context:\n");
            photo.push_str(description);
        }
        let extra: Vec<&str> = blocks
            .iter()
            .filter(|block| !block.starts_with("Visual context of the user's photo:"))
            .map(String::as_str)
            .collect();
        if extra.is_empty() {
            photo
        } else {
            format!("{}\n\n{photo}", extra.join("\n\n"))
        }
    } else if blocks.is_empty() {
        model_message.to_string()
    } else {
        format!("{}\n\n{model_message}", blocks.join("\n\n"))
    }
}

struct RouteMeta<'a> {
    route: &'a str,
    provider: &'a str,
    model: &'a str,
}

struct Built<'a> {
    texts: Vec<String>,
    delete_original: bool,
    record: Option<Record>,
    route: &'a str,
    provider: &'a str,
    model: &'a str,
    cards: usize,
}

struct Delivered<'a> {
    reply: &'a str,
    cards: &'a [Card],
    session: &'a str,
    user_text: &'a str,
    meta: RouteMeta<'a>,
}

fn deliver(
    incoming: &Incoming,
    deps: &Deps,
    started: Instant,
    delivered: Delivered<'_>,
) -> Outcome {
    let reply = strip_card_markers(delivered.reply);
    let card_count = delivered
        .cards
        .iter()
        .filter(|card| !card.canonical_path.is_empty() || !card.path.is_empty())
        .take(3)
        .count();
    finish(
        incoming,
        deps,
        started,
        Built {
            texts: present(incoming.platform, &reply, delivered.cards),
            delete_original: false,
            record: Some(Record {
                session_key: delivered.session.to_string(),
                user_text: delivered.user_text.to_string(),
                assistant_text: reply,
            }),
            route: delivered.meta.route,
            provider: delivered.meta.provider,
            model: delivered.meta.model,
            cards: card_count,
        },
    )
}

fn apology(incoming: &Incoming, deps: &Deps, started: Instant) -> Outcome {
    deps.metrics
        .hermes_fail
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    deps.metrics
        .apologies
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    finish(
        incoming,
        deps,
        started,
        Built {
            texts: vec![APOLOGY.to_string()],
            delete_original: false,
            record: None,
            route: "apology",
            provider: "",
            model: "",
            cards: 0,
        },
    )
}

fn finish(incoming: &Incoming, deps: &Deps, started: Instant, built: Built<'_>) -> Outcome {
    let html_mode = incoming.platform == Platform::Telegram;
    let formatted = if html_mode || built.route == "contract" {
        built.texts
    } else {
        built
            .texts
            .iter()
            .flat_map(|text| discord_chunks(text))
            .collect::<Vec<_>>()
    };
    if matches!(built.route, "brain" | "hermes" | "apology" | "contract") {
        let latency_ms = started.elapsed().as_millis() as u64;
        deps.metrics.push_reply_latency(latency_ms);
        tracing::info!(
            platform = incoming.platform.as_str(),
            scope = incoming.scope.as_str(),
            route = built.route,
            provider = built.provider,
            model = built.model,
            latency_ms,
            cards = built.cards,
            "poko turn answered"
        );
    }
    Outcome {
        texts: formatted,
        delete_original: built.delete_original,
        reply: reply_to_user(incoming),
        html: html_mode,
        record: built.record,
    }
}

fn present(platform: Platform, reply: &str, cards: &[Card]) -> Vec<String> {
    match platform {
        Platform::Telegram => vec![append_cards(reply, cards, false)],
        Platform::Discord => discord_chunks(&append_cards(reply, cards, true)),
    }
}

fn reply_to_user(incoming: &Incoming) -> bool {
    match incoming.platform {
        Platform::Telegram => incoming.scope == Scope::Group,
        Platform::Discord => true,
    }
}

fn route_brain(config: &Config, uid: Option<&str>, incoming: &Incoming) -> bool {
    match config.brain_mode {
        BrainMode::Hermes => false,
        BrainMode::Rust => true,
        BrainMode::Canary => {
            uid.is_some_and(|id| config.canary_uids.contains(id))
                || match incoming.platform {
                    Platform::Telegram => config.canary_telegram_ids.contains(&incoming.user_id),
                    Platform::Discord => config.canary_discord_ids.contains(&incoming.user_id),
                }
        }
    }
}

pub fn allowed(incoming: &Incoming, config: &Config) -> bool {
    match incoming.platform {
        Platform::Telegram => {
            config.telegram_chat_ids.is_empty()
                || config
                    .telegram_chat_ids
                    .iter()
                    .any(|id| id == &incoming.chat_id)
        }
        Platform::Discord => {
            let channel_ok = config.discord_channel_ids.is_empty()
                || config
                    .discord_channel_ids
                    .iter()
                    .any(|id| id == &incoming.chat_id);
            let user_ok = config.discord_user_ids.is_empty()
                || config
                    .discord_user_ids
                    .iter()
                    .any(|id| id == &incoming.user_id);
            channel_ok && user_ok
        }
    }
}

fn skip(deps: &Deps, reason: &str) -> Outcome {
    deps.metrics
        .skipped
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    tracing::debug!(reason, "turn skipped");
    Outcome {
        texts: Vec::new(),
        delete_original: false,
        reply: false,
        html: false,
        record: None,
    }
}

fn spawn_typing(typing: Option<Arc<dyn Typing>>) -> AbortOnDrop {
    let Some(typing) = typing else {
        return AbortOnDrop(None);
    };
    let handle = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(typing.interval());
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            typing.pulse().await;
        }
    });
    AbortOnDrop(Some(handle))
}

struct AbortOnDrop(Option<tokio::task::JoinHandle<()>>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

pub struct ChatLocks {
    inner: tokio::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl ChatLocks {
    pub fn new() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    pub async fn run<T>(&self, key: &str, fut: impl std::future::Future<Output = T>) -> T {
        let arc = {
            let mut map = self.inner.lock().await;
            map.entry(key.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _guard = arc.lock().await;
        let result = fut.await;
        drop(_guard);
        drop(arc);
        let mut map = self.inner.lock().await;
        if map
            .get(key)
            .is_some_and(|existing| Arc::strong_count(existing) == 1)
        {
            map.remove(key);
        }
        result
    }
}

impl Default for ChatLocks {
    fn default() -> Self {
        Self::new()
    }
}

pub fn apply_record(history: &History, outcome: &Outcome, at: u64) {
    if let Some(record) = &outcome.record {
        history.push(&record.session_key, "user", &record.user_text, at);
        history.push(&record.session_key, "assistant", &record.assistant_text, at);
    }
}

pub fn system_now() -> u64 {
    now_ms()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    struct Fake {
        brain: Mutex<Vec<BrainRequest>>,
        hermes: Mutex<Vec<HermesRequest>>,
        connect: Mutex<Vec<Value>>,
        brain_result: Mutex<Result<BrainResponse, String>>,
        hermes_result: Mutex<Result<HermesResponse, String>>,
    }

    #[async_trait]
    impl Services for Fake {
        async fn brain_chat(&self, body: &BrainRequest) -> Result<BrainResponse, ApiError> {
            self.brain.lock().unwrap().push(body.clone());
            self.brain_result
                .lock()
                .unwrap()
                .clone()
                .map_err(ApiError::Message)
        }
        async fn hermes_chat(&self, body: &HermesRequest) -> Result<HermesResponse, ApiError> {
            self.hermes.lock().unwrap().push(body.clone());
            self.hermes_result
                .lock()
                .unwrap()
                .clone()
                .map_err(ApiError::Message)
        }
        async fn connect_status(&self, body: &Value) -> Result<Value, ApiError> {
            self.connect.lock().unwrap().push(body.clone());
            Ok(json!({ "ok": true, "linked": false }))
        }
        async fn connect_redeem(&self, body: &Value) -> Result<Value, ApiError> {
            self.connect.lock().unwrap().push(body.clone());
            Ok(json!({ "ok": true, "linked": true }))
        }
        async fn connect_unlink(&self, body: &Value) -> Result<Value, ApiError> {
            self.connect.lock().unwrap().push(body.clone());
            Ok(json!({ "ok": true }))
        }
    }

    fn brain_ok(reply: &str) -> BrainResponse {
        BrainResponse {
            ok: true,
            reply: reply.into(),
            ..BrainResponse::default()
        }
    }

    fn hermes_ok(reply: &str) -> HermesResponse {
        HermesResponse {
            reply: reply.into(),
            ..HermesResponse::default()
        }
    }

    struct Harness {
        deps: Deps,
        fake: Arc<Fake>,
    }

    fn harness(mode: BrainMode) -> Harness {
        let fake = Arc::new(Fake {
            brain: Mutex::new(Vec::new()),
            hermes: Mutex::new(Vec::new()),
            connect: Mutex::new(Vec::new()),
            brain_result: Mutex::new(Ok(brain_ok("from-brain"))),
            hermes_result: Mutex::new(Ok(hermes_ok("from-hermes"))),
        });
        let deps = Deps {
            services: fake.clone(),
            connect: Arc::new(ConnectState::new()),
            history: Arc::new(History::new()),
            metrics: Arc::new(Metrics::new()),
            config: Arc::new(Config::test(mode)),
            gemini: None,
            typing: None,
            now_ms: Arc::new(|| 1_700_000_000_000),
            http: reqwest::Client::new(),
        };
        Harness { deps, fake }
    }

    #[tokio::test]
    async fn command_short_circuits_before_the_gate() {
        let h = harness(BrainMode::Rust);
        let incoming = Incoming::text(Platform::Telegram, Scope::Group, "5", "9", "/help");
        let outcome = handle_turn(&incoming, &h.deps).await;
        assert!(outcome.texts[0].contains("AI assistant"));
        assert!(outcome.record.is_none());
        assert!(h.fake.brain.lock().unwrap().is_empty());
        assert!(h.fake.hermes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn gate_skip_sends_nothing() {
        let h = harness(BrainMode::Rust);
        let incoming = Incoming::text(
            Platform::Telegram,
            Scope::Group,
            "5",
            "9",
            "random chatter about lunch",
        );
        let outcome = handle_turn(&incoming, &h.deps).await;
        assert!(outcome.texts.is_empty());
        assert!(h.fake.brain.lock().unwrap().is_empty());
        assert_eq!(
            h.deps
                .metrics
                .skipped
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }

    #[tokio::test]
    async fn contract_address_skips_the_llm() {
        let h = harness(BrainMode::Rust);
        let mut incoming = Incoming::text(Platform::Discord, Scope::Group, "5", "9", "ca");
        incoming.is_mentioned = true;
        incoming.in_guild = true;
        let outcome = handle_turn(&incoming, &h.deps).await;
        assert!(outcome.texts[0].contains("0x91A17E2bddfF839078BD395482B38e4AC15276f4"));
        assert!(outcome.record.is_none());
        assert!(h.fake.brain.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn canary_by_uid_and_by_platform_id() {
        let linked = LinkedFake::new(Ok(brain_ok("brain")), Ok(hermes_ok("hermes")));
        *linked.status.lock().unwrap() = json!({
            "ok": true, "linked": true, "firebaseUid": "fb-9"
        });
        let mut config = Config::test(BrainMode::Canary);
        config.canary_uids.insert("fb-9".into());
        let deps = linked_deps(linked.clone(), config);
        let incoming = Incoming::text(Platform::Telegram, Scope::Dm, "5", "9", "hey poko");
        handle_turn(&incoming, &deps).await;
        assert_eq!(linked.brain_calls.lock().unwrap().len(), 1);
        assert_eq!(
            linked.brain_calls.lock().unwrap()[0]
                .firebase_uid
                .as_deref(),
            Some("fb-9")
        );

        let by_id = LinkedFake::new(Ok(brain_ok("brain")), Ok(hermes_ok("hermes")));
        let mut config = Config::test(BrainMode::Canary);
        config.canary_telegram_ids.insert("5".into());
        let deps = linked_deps(by_id.clone(), config);
        let incoming = Incoming::text(Platform::Telegram, Scope::Dm, "5", "9", "hey poko");
        handle_turn(&incoming, &deps).await;
        assert_eq!(by_id.brain_calls.lock().unwrap().len(), 1);
        assert!(by_id.brain_calls.lock().unwrap()[0].firebase_uid.is_none());
    }

    #[tokio::test]
    async fn modes_hermes_and_rust() {
        let hermes_fake = LinkedFake::new(Ok(brain_ok("brain")), Ok(hermes_ok("hermes-reply")));
        let deps = linked_deps(hermes_fake.clone(), Config::test(BrainMode::Hermes));
        let incoming = Incoming::text(Platform::Telegram, Scope::Dm, "5", "9", "hey poko");
        let outcome = handle_turn(&incoming, &deps).await;
        assert!(hermes_fake.brain_calls.lock().unwrap().is_empty());
        assert_eq!(hermes_fake.hermes_calls.lock().unwrap().len(), 1);
        assert!(outcome.texts[0].contains("hermes-reply"));

        let rust_fake = LinkedFake::new(Ok(brain_ok("brain-reply")), Ok(hermes_ok("no")));
        let deps = linked_deps(rust_fake.clone(), Config::test(BrainMode::Rust));
        let outcome = handle_turn(&incoming, &deps).await;
        assert_eq!(rust_fake.brain_calls.lock().unwrap().len(), 1);
        assert!(rust_fake.hermes_calls.lock().unwrap().is_empty());
        assert!(outcome.texts[0].contains("brain-reply"));
    }

    #[tokio::test]
    async fn brain_error_falls_back_and_both_fail_apologise() {
        let fake = LinkedFake::new(Err("boom".into()), Ok(hermes_ok("saved")));
        let deps = linked_deps(fake.clone(), Config::test(BrainMode::Rust));
        let incoming = Incoming::text(Platform::Telegram, Scope::Dm, "5", "9", "hey poko");
        let outcome = handle_turn(&incoming, &deps).await;
        assert!(outcome.texts[0].contains("saved"));
        assert!(outcome.record.is_some());
        assert_eq!(
            deps.metrics
                .brain_fail
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        assert_eq!(
            deps.metrics
                .hermes_ok
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );

        let fake = LinkedFake::new(Err("boom".into()), Err("also".into()));
        let deps = linked_deps(fake, Config::test(BrainMode::Rust));
        let outcome = handle_turn(&incoming, &deps).await;
        assert_eq!(outcome.texts, vec![APOLOGY.to_string()]);
        assert!(outcome.record.is_none());
        assert_eq!(
            deps.metrics
                .apologies
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }

    #[tokio::test]
    async fn blocked_is_silent() {
        let mut blocked = brain_ok("nope");
        blocked.blocked = true;
        let fake = LinkedFake::new(Ok(blocked), Ok(hermes_ok("no")));
        let deps = linked_deps(fake.clone(), Config::test(BrainMode::Rust));
        let incoming = Incoming::text(Platform::Telegram, Scope::Dm, "5", "9", "hey poko");
        let outcome = handle_turn(&incoming, &deps).await;
        assert!(outcome.texts.is_empty());
        assert!(outcome.record.is_none());
        assert!(fake.hermes_calls.lock().unwrap().is_empty());
        assert_eq!(
            deps.metrics
                .blocked
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }

    #[tokio::test]
    async fn discord_guild_leaked_code_deletes_and_posts_a_notice() {
        let fake = LinkedFake::new(Ok(brain_ok("no")), Ok(hermes_ok("no")));
        let deps = linked_deps(fake.clone(), Config::test(BrainMode::Rust));
        let mut incoming = Incoming::text(
            Platform::Discord,
            Scope::Group,
            "42",
            "channel",
            "/connect ABCD2345",
        );
        incoming.is_mentioned = true;
        incoming.in_guild = true;
        incoming.username = "ann".into();
        incoming.display_name = "Ann".into();
        let outcome = handle_turn(&incoming, &deps).await;
        assert!(outcome.delete_original);
        assert!(!outcome.reply);
        assert!(outcome.texts[0].starts_with("<@42> ✅ Profilo Pokoin collegato. "));
        assert!(outcome.texts[0].contains("**/connect**"));
        assert!(outcome.record.is_none());
        assert!(fake.brain_calls.lock().unwrap().is_empty());
        let body = fake.connect_calls.lock().unwrap()[0].clone();
        assert_eq!(body["action"], "redeem");
        assert_eq!(body["discordUserId"], "42");
        assert_eq!(body["code"], "ABCD2345");
    }

    #[tokio::test]
    async fn history_is_recorded_only_for_real_replies_and_passed_on() {
        let fake = LinkedFake::new(Ok(brain_ok("first")), Ok(hermes_ok("no")));
        let deps = linked_deps(fake.clone(), Config::test(BrainMode::Rust));
        let incoming = Incoming::text(Platform::Telegram, Scope::Dm, "5", "9", "hey poko");
        let help = Incoming::text(Platform::Telegram, Scope::Dm, "5", "9", "/help");
        let skipped = handle_turn(&help, &deps).await;
        assert!(skipped.record.is_none());
        let first = handle_turn(&incoming, &deps).await;
        apply_record(&deps.history, &first, 1_700_000_000_000);
        assert_eq!(first.record.as_ref().unwrap().assistant_text, "first");
        let second = Incoming::text(Platform::Telegram, Scope::Dm, "5", "9", "and again poko");
        handle_turn(&second, &deps).await;
        let calls = fake.brain_calls.lock().unwrap();
        assert!(calls[0].history.is_empty());
        assert_eq!(calls[1].history.len(), 2);
        assert_eq!(calls[1].history[1].text, "first");
        assert!(!calls[1].history[1].text.contains("http"));
    }

    #[tokio::test]
    async fn group_scope_still_answers() {
        let fake = LinkedFake::new(Ok(brain_ok("group-ok")), Ok(hermes_ok("no")));
        let deps = linked_deps(fake.clone(), Config::test(BrainMode::Rust));
        let incoming = Incoming::text(Platform::Telegram, Scope::Group, "5", "-100", "hey poko");
        let outcome = handle_turn(&incoming, &deps).await;
        assert!(outcome.reply);
        assert!(outcome.texts[0].contains("group-ok"));
        assert_eq!(fake.brain_calls.lock().unwrap()[0].scope, "group");
        assert_eq!(
            fake.brain_calls.lock().unwrap()[0].session_id,
            "telegram_chat_-100"
        );
    }

    #[tokio::test]
    async fn guild_chatter_is_not_deleted() {
        let fake = LinkedFake::new(Ok(brain_ok("no")), Ok(hermes_ok("no")));
        let deps = linked_deps(fake, Config::test(BrainMode::Rust));
        let incoming = Incoming::text(
            Platform::Discord,
            Scope::Group,
            "5",
            "channel",
            "connect later guys",
        );
        let outcome = handle_turn(&incoming, &deps).await;
        assert!(outcome.texts.is_empty());
        assert!(!outcome.delete_original);
    }

    #[tokio::test]
    async fn mentioned_connect_later_is_not_a_command_and_is_not_deleted() {
        let fake = LinkedFake::new(Ok(brain_ok("still-here")), Ok(hermes_ok("no")));
        let deps = linked_deps(fake, Config::test(BrainMode::Rust));
        let mut incoming = Incoming::text(
            Platform::Discord,
            Scope::Group,
            "5",
            "channel",
            "connect later guys",
        );
        incoming.is_mentioned = true;
        let outcome = handle_turn(&incoming, &deps).await;
        assert!(!outcome.delete_original);
        assert!(outcome.texts[0].contains("still-here"));
    }

    #[test]
    fn honcho_ids_follow_hermes_safe_id() {
        let telegram = Incoming::text(Platform::Telegram, Scope::Group, "42", "-100123", "hi");
        let (peer, session) = memory_ids(&telegram, None);
        assert_eq!(peer, "telegram_user_42");
        assert_eq!(session, "telegram_chat_-100123");

        let (linked_peer, linked_session) = memory_ids(&telegram, Some("uid/1"));
        assert_eq!(linked_peer, "poko_user_uid_1");
        assert_eq!(linked_session, "telegram_chat_-100123");

        let mut guild = Incoming::text(Platform::Discord, Scope::Group, "99", "555", "hi");
        guild.guild_id = Some("777".into());
        guild.in_guild = true;
        let (guild_peer, guild_session) = memory_ids(&guild, Some("uid-9"));
        assert_eq!(guild_peer, "discord_guild_user_777_99");
        assert_eq!(guild_session, "discord_channel_555");

        let dm = Incoming::text(Platform::Discord, Scope::Dm, "99", "888", "hi");
        let (dm_peer, dm_session) = memory_ids(&dm, Some("uid-9"));
        assert_eq!(dm_peer, "poko_user_uid-9");
        assert_eq!(dm_session, "discord_channel_888");
        let (bare_peer, bare_session) = memory_ids(&dm, None);
        assert_eq!(bare_peer, "discord_user_99");
        assert_eq!(bare_session, "discord_channel_888");
    }

    #[tokio::test]
    async fn unlinked_hermes_user_id_is_the_memory_peer() {
        let fake = LinkedFake::new(Ok(brain_ok("no")), Ok(hermes_ok("hermes-reply")));
        let deps = linked_deps(fake.clone(), Config::test(BrainMode::Hermes));
        let mut incoming = Incoming::text(Platform::Discord, Scope::Group, "99", "555", "hey poko");
        incoming.guild_id = Some("777".into());
        incoming.is_mentioned = true;
        handle_turn(&incoming, &deps).await;
        let calls = fake.hermes_calls.lock().unwrap();
        assert_eq!(calls[0].user_id, "discord_guild_user_777_99");
        assert_eq!(calls[0].user.id, "discord_guild_user_777_99");
    }

    #[derive(Clone)]
    struct LinkedFake {
        brain_calls: Arc<Mutex<Vec<BrainRequest>>>,
        hermes_calls: Arc<Mutex<Vec<HermesRequest>>>,
        connect_calls: Arc<Mutex<Vec<Value>>>,
        brain_result: Arc<Mutex<Result<BrainResponse, String>>>,
        hermes_result: Arc<Mutex<Result<HermesResponse, String>>>,
        status: Arc<Mutex<Value>>,
    }

    impl LinkedFake {
        fn new(
            brain: Result<BrainResponse, String>,
            hermes: Result<HermesResponse, String>,
        ) -> Arc<Self> {
            Arc::new(Self {
                brain_calls: Arc::new(Mutex::new(Vec::new())),
                hermes_calls: Arc::new(Mutex::new(Vec::new())),
                connect_calls: Arc::new(Mutex::new(Vec::new())),
                brain_result: Arc::new(Mutex::new(brain)),
                hermes_result: Arc::new(Mutex::new(hermes)),
                status: Arc::new(Mutex::new(json!({ "ok": true, "linked": false }))),
            })
        }
    }

    #[async_trait]
    impl Services for LinkedFake {
        async fn brain_chat(&self, body: &BrainRequest) -> Result<BrainResponse, ApiError> {
            self.brain_calls.lock().unwrap().push(body.clone());
            self.brain_result
                .lock()
                .unwrap()
                .clone()
                .map_err(ApiError::Message)
        }
        async fn hermes_chat(&self, body: &HermesRequest) -> Result<HermesResponse, ApiError> {
            self.hermes_calls.lock().unwrap().push(body.clone());
            self.hermes_result
                .lock()
                .unwrap()
                .clone()
                .map_err(ApiError::Message)
        }
        async fn connect_status(&self, body: &Value) -> Result<Value, ApiError> {
            self.connect_calls.lock().unwrap().push(body.clone());
            Ok(self.status.lock().unwrap().clone())
        }
        async fn connect_redeem(&self, body: &Value) -> Result<Value, ApiError> {
            self.connect_calls.lock().unwrap().push(body.clone());
            Ok(json!({ "ok": true, "linked": true }))
        }
        async fn connect_unlink(&self, body: &Value) -> Result<Value, ApiError> {
            self.connect_calls.lock().unwrap().push(body.clone());
            Ok(json!({ "ok": true }))
        }
    }

    fn linked_deps(fake: Arc<LinkedFake>, config: Config) -> Deps {
        Deps {
            services: fake,
            connect: Arc::new(ConnectState::new()),
            history: Arc::new(History::new()),
            metrics: Arc::new(Metrics::new()),
            config: Arc::new(config),
            gemini: None,
            typing: None,
            now_ms: Arc::new(|| 1_700_000_000_000),
            http: reqwest::Client::new(),
        }
    }
}
