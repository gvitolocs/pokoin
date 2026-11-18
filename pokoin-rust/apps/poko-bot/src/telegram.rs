use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use frankenstein::client_reqwest::Bot;
use frankenstein::methods::{
    DeleteWebhookParams, GetFileParams, GetUpdatesParams, SendChatActionParams, SendMessageParams,
    SetMyCommandsParams,
};
use frankenstein::types::{
    AllowedUpdate, BotCommand, ChatAction, ChatType, LinkPreviewOptions, Message, PhotoSize,
    ReplyParameters,
};
use frankenstein::updates::UpdateContent;
use frankenstein::ParseMode;
use frankenstein::{AsyncTelegramApi, Error};
use tokio::sync::watch;

use crate::format::telegram_html;
use crate::history::now_ms;
use crate::media::{audio_too_long_text, classify_voice_transcription_error, voice_failure_text};
use crate::redact::redact;
use crate::turn::{
    apply_record, handle_turn, ChatLocks, Deps, Incoming, IncomingImage, Platform, Scope, Typing,
};

const PHOTO_MAX: u64 = 4_000_000;
const POLL_TIMEOUT: u32 = 50;

pub async fn run(token: String, deps: Deps, mut shutdown: watch::Receiver<bool>) {
    let client = frankenstein::reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(70))
        .build()
        .unwrap_or_else(|_| frankenstein::reqwest::Client::new());
    let bot = Bot::builder()
        .api_url(format!("https://api.telegram.org/bot{token}"))
        .client(client)
        .build();
    let me = loop {
        if *shutdown.borrow() {
            return;
        }
        match startup(&bot, &token).await {
            Ok(user) => break user,
            Err(error) => {
                tracing::warn!(error = %redact(&error.to_string(), &token), "telegram startup failed");
                if !sleep_or_stop(&mut shutdown, 5).await {
                    return;
                }
            }
        }
    };
    let bot_id = me.id;
    let bot_username = me.username.unwrap_or_default();
    tracing::info!(bot_id, username = %bot_username, "telegram polling");
    deps.metrics
        .telegram_polling
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let mut params = GetUpdatesParams::builder()
        .timeout(POLL_TIMEOUT)
        .allowed_updates(vec![AllowedUpdate::Message])
        .build();
    let locks = Arc::new(ChatLocks::new());
    loop {
        if *shutdown.borrow() {
            break;
        }
        let result = tokio::select! {
            _ = shutdown.changed() => break,
            result = bot.get_updates(&params) => result,
        };
        match result {
            Ok(response) => {
                for update in response.result {
                    let next = i64::from(update.update_id) + 1;
                    params.offset = Some(next);
                    deps.metrics
                        .telegram_last_update_ms
                        .store(now_ms(), std::sync::atomic::Ordering::Relaxed);
                    let UpdateContent::Message(message) = update.content else {
                        continue;
                    };
                    let deps = deps.clone();
                    let bot = bot.clone();
                    let token = token.clone();
                    let locks = locks.clone();
                    let username = bot_username.clone();
                    tokio::spawn(async move {
                        let key = message.chat.id.to_string();
                        locks
                            .run(
                                &key,
                                handle_message(deps, bot, token, username, bot_id, *message),
                            )
                            .await;
                    });
                }
            }
            Err(error) => {
                if is_conflict(&error) {
                    tracing::warn!("telegram getUpdates conflict; another poller is running");
                    if !sleep_or_stop(&mut shutdown, 30).await {
                        break;
                    }
                } else {
                    tracing::warn!(error = %redact(&error.to_string(), &token), "telegram getUpdates failed");
                    if !sleep_or_stop(&mut shutdown, 5).await {
                        break;
                    }
                }
            }
        }
    }
    deps.metrics
        .telegram_polling
        .store(false, std::sync::atomic::Ordering::Relaxed);
}

async fn startup(bot: &Bot, token: &str) -> Result<frankenstein::types::User, Error> {
    if let Err(error) = bot
        .delete_webhook(
            &DeleteWebhookParams::builder()
                .drop_pending_updates(false)
                .build(),
        )
        .await
    {
        tracing::warn!(error = %redact(&error.to_string(), token), "telegram deleteWebhook failed");
    }
    let me = bot.get_me().await?.result;
    let commands = vec![
        command("start", "Welcome — meet Poko ✨"),
        command("connect", "Link your Pokoin profile: /connect CODE"),
        command("whoami", "Show your Pokoin link status"),
        command("disconnect", "Unlink your Pokoin profile"),
        command("help", "What Poko can do"),
    ];
    if let Err(error) = bot
        .set_my_commands(&SetMyCommandsParams::builder().commands(commands).build())
        .await
    {
        tracing::warn!(error = %redact(&error.to_string(), token), "telegram setMyCommands failed");
    }
    Ok(me)
}

fn command(name: &str, description: &str) -> BotCommand {
    BotCommand::builder()
        .command(name)
        .description(description)
        .build()
}

fn is_conflict(error: &Error) -> bool {
    matches!(error, Error::Api(body) if body.error_code == 409)
}

async fn sleep_or_stop(shutdown: &mut watch::Receiver<bool>, seconds: u64) -> bool {
    tokio::select! {
        _ = shutdown.changed() => false,
        _ = tokio::time::sleep(Duration::from_secs(seconds)) => !*shutdown.borrow(),
    }
}

async fn handle_message(
    deps: Deps,
    bot: Bot,
    token: String,
    bot_username: String,
    bot_id: u64,
    message: Message,
) {
    if message.chat.type_field == ChatType::Channel {
        return;
    }
    let Some(from) = message.from.as_ref() else {
        return;
    };
    if from.is_bot || too_old(message.date) || message.edit_date.is_some() {
        return;
    }
    let scope = if message.chat.type_field == ChatType::Private {
        Scope::Dm
    } else {
        Scope::Group
    };
    let display = [
        from.first_name.as_str(),
        from.last_name.as_deref().unwrap_or(""),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    let chat_id = message.chat.id;
    let user_id = from.id.to_string();
    let username = from.username.clone().unwrap_or_default();
    let typing = Arc::new(TelegramTyping {
        bot: bot.clone(),
        chat_id,
        token: token.clone(),
    });
    let base = Incoming {
        platform: Platform::Telegram,
        chat_id: chat_id.to_string(),
        message_id: message.message_id.to_string(),
        user_id,
        username,
        display_name: display,
        scope,
        text: String::new(),
        caption: None,
        is_mentioned: false,
        is_reply_to_bot: message
            .reply_to_message
            .as_ref()
            .and_then(|reply| reply.from.as_ref())
            .is_some_and(|author| author.id == bot_id),
        bot_username: bot_username.clone(),
        channel_name: String::new(),
        parent_name: String::new(),
        in_guild: false,
        guild_id: None,
        image: None,
        server_context: None,
    };

    if let Some(text) = message.text.clone() {
        let mut incoming = base;
        incoming.text = text;
        incoming.is_mentioned = crate::gate::mentions_bot_username(&incoming.text, &bot_username);
        deliver(
            &deps,
            &bot,
            chat_id,
            message.message_id,
            incoming,
            Some(typing),
            &token,
        )
        .await;
        return;
    }

    if message.photo.is_some()
        || message.voice.is_some()
        || message.audio.is_some()
        || message.video_note.is_some()
    {
        // media below
    } else {
        return;
    }

    if let Some(photos) = message.photo.as_ref() {
        let caption = message.caption.clone().unwrap_or_default();
        let gate_text = if caption.trim().is_empty() {
            "[photo]".to_string()
        } else {
            caption.trim().to_string()
        };
        let mut probe = base.clone_probe(&gate_text);
        probe.is_mentioned = crate::gate::mentions_bot_username(&gate_text, &bot_username);
        if !pre_gate(&deps, &probe) {
            return;
        }
        let Some(photo) = pick_photo(photos) else {
            tracing::debug!("telegram photo over size limit");
            return;
        };
        match download(&bot, &token, &deps, &photo.file_id, PHOTO_MAX).await {
            Ok(bytes) => {
                let mut incoming = probe;
                incoming.caption = Some(caption.trim().to_string());
                incoming.image = Some(IncomingImage {
                    mime: "image/jpeg".into(),
                    bytes,
                });
                deliver(
                    &deps,
                    &bot,
                    chat_id,
                    message.message_id,
                    incoming,
                    Some(typing),
                    &token,
                )
                .await;
            }
            Err(error) => {
                tracing::warn!(error = %redact(&error, &token), "telegram photo download failed")
            }
        }
        return;
    }

    let (kind, file_id, duration, mime, file_size) = if let Some(voice) = message.voice.as_ref() {
        (
            "voice",
            voice.file_id.clone(),
            voice.duration,
            voice
                .mime_type
                .clone()
                .unwrap_or_else(|| "audio/ogg".into()),
            voice.file_size,
        )
    } else if let Some(audio) = message.audio.as_ref() {
        (
            "audio",
            audio.file_id.clone(),
            audio.duration,
            audio
                .mime_type
                .clone()
                .unwrap_or_else(|| "audio/mpeg".into()),
            audio.file_size,
        )
    } else if let Some(note) = message.video_note.as_ref() {
        (
            "video_note",
            note.file_id.clone(),
            note.duration,
            "video/mp4".into(),
            note.file_size,
        )
    } else {
        return;
    };
    let caption = message.caption.clone().unwrap_or_default();
    let gate_text = if caption.trim().is_empty() {
        format!("[{kind}]")
    } else {
        caption.trim().to_string()
    };
    let mut probe = base.clone_probe(&gate_text);
    probe.is_mentioned = crate::gate::mentions_bot_username(&gate_text, &bot_username);
    if !pre_gate(&deps, &probe) {
        return;
    }
    if u64::from(duration) > deps.config.max_audio_duration_seconds {
        let text = audio_too_long_text(u64::from(duration), deps.config.max_audio_duration_seconds);
        let _ = send_text(
            &bot,
            chat_id,
            message.message_id,
            &text,
            scope == Scope::Group,
            false,
        )
        .await;
        return;
    }
    if file_size.unwrap_or(0) > deps.config.max_audio_bytes {
        let text = voice_failure_text("generic");
        let _ = send_text(
            &bot,
            chat_id,
            message.message_id,
            &text,
            scope == Scope::Group,
            false,
        )
        .await;
        return;
    }
    let bytes = match download(&bot, &token, &deps, &file_id, deps.config.max_audio_bytes).await {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(error = %redact(&error, &token), kind, "telegram audio download failed");
            let reason = classify_voice_transcription_error(&error);
            let _ = send_text(
                &bot,
                chat_id,
                message.message_id,
                &voice_failure_text(reason),
                scope == Scope::Group,
                false,
            )
            .await;
            return;
        }
    };
    let Some(gemini) = deps.gemini.clone() else {
        let _ = send_text(
            &bot,
            chat_id,
            message.message_id,
            &voice_failure_text("generic"),
            scope == Scope::Group,
            false,
        )
        .await;
        return;
    };
    match gemini.transcribe(&bytes, &mime, caption.trim(), kind).await {
        Ok(transcript) => {
            let text = if caption.trim().is_empty() {
                format!("[transcript:{kind}] {transcript}")
            } else {
                format!(
                    "Caption: {}\n[transcript:{kind}] {transcript}",
                    caption.trim()
                )
            };
            let mut incoming = base;
            incoming.text = text;
            incoming.is_mentioned =
                crate::gate::mentions_bot_username(&incoming.text, &bot_username);
            deliver(
                &deps,
                &bot,
                chat_id,
                message.message_id,
                incoming,
                Some(typing),
                &token,
            )
            .await;
        }
        Err(error) => {
            let reason = classify_voice_transcription_error(&error.to_string());
            tracing::warn!(error = %redact(&error.to_string(), &token), kind, reason, "telegram transcription failed");
            let _ = send_text(
                &bot,
                chat_id,
                message.message_id,
                &voice_failure_text(reason),
                scope == Scope::Group,
                false,
            )
            .await;
        }
    }
}

trait Probe {
    fn clone_probe(&self, text: &str) -> Incoming;
}

impl Probe for Incoming {
    fn clone_probe(&self, text: &str) -> Incoming {
        Incoming {
            text: text.to_string(),
            ..self.shallow()
        }
    }
}

impl Incoming {
    fn shallow(&self) -> Self {
        Self {
            platform: self.platform,
            chat_id: self.chat_id.clone(),
            message_id: self.message_id.clone(),
            user_id: self.user_id.clone(),
            username: self.username.clone(),
            display_name: self.display_name.clone(),
            scope: self.scope,
            text: self.text.clone(),
            caption: self.caption.clone(),
            is_mentioned: self.is_mentioned,
            is_reply_to_bot: self.is_reply_to_bot,
            bot_username: self.bot_username.clone(),
            channel_name: self.channel_name.clone(),
            parent_name: self.parent_name.clone(),
            in_guild: self.in_guild,
            guild_id: self.guild_id.clone(),
            image: None,
            server_context: None,
        }
    }
}

fn pre_gate(deps: &Deps, incoming: &Incoming) -> bool {
    if !crate::turn::allowed(incoming, &deps.config) {
        return false;
    }
    let gate = crate::gate::should_poko_engage(crate::gate::EngageInput {
        text: &incoming.text,
        platform: "telegram",
        is_dm: incoming.scope == Scope::Dm,
        is_mentioned: incoming.is_mentioned,
        is_reply_to_bot: incoming.is_reply_to_bot,
        bot_username: &incoming.bot_username,
        channel_name: "",
        parent_name: "",
    });
    if !gate.should_reply {
        tracing::debug!(reason = %gate.reason, "telegram media skipped");
        false
    } else {
        true
    }
}

fn pick_photo(photos: &[PhotoSize]) -> Option<&PhotoSize> {
    photos
        .iter()
        .rev()
        .find(|photo| photo.file_size.unwrap_or(0) <= PHOTO_MAX)
}

async fn download(
    bot: &Bot,
    token: &str,
    deps: &Deps,
    file_id: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let file = bot
        .get_file(&GetFileParams::builder().file_id(file_id).build())
        .await
        .map_err(|_| "telegram getFile failed".to_string())?;
    if file.result.file_size.unwrap_or(0) > max_bytes {
        return Err("file too large".into());
    }
    let path = file
        .result
        .file_path
        .ok_or_else(|| "telegram file has no path".to_string())?;
    let url = format!("https://api.telegram.org/file/bot{token}/{path}");
    let response = deps
        .http
        .get(url)
        .send()
        .await
        .map_err(|_| "telegram file download failed".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "telegram file download failed {}",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "telegram file download failed".to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("downloaded file too large".into());
    }
    Ok(bytes.to_vec())
}

async fn deliver(
    deps: &Deps,
    bot: &Bot,
    chat_id: i64,
    message_id: i32,
    incoming: Incoming,
    typing: Option<Arc<dyn Typing>>,
    token: &str,
) {
    let mut deps_typing = deps.clone();
    deps_typing.typing = typing;
    let outcome = handle_turn(&incoming, &deps_typing).await;
    if outcome.texts.is_empty() {
        return;
    }
    let reply = outcome.reply;
    let mut html = outcome.html;
    for (index, text) in outcome.texts.iter().enumerate() {
        let use_html = html && index == 0;
        match send_text(
            bot,
            chat_id,
            message_id,
            text,
            reply && index == 0,
            use_html,
        )
        .await
        {
            Ok(()) => {
                if index == 0 {
                    apply_record(&deps.history, &outcome, now_ms());
                }
            }
            Err(error) if html && is_parse_error(&error) => {
                html = false;
                if send_text(bot, chat_id, message_id, text, reply && index == 0, false)
                    .await
                    .is_ok()
                {
                    apply_record(&deps.history, &outcome, now_ms());
                }
            }
            Err(error) => {
                tracing::warn!(error = %redact(&error.to_string(), token), "telegram send failed")
            }
        }
    }
}

async fn send_text(
    bot: &Bot,
    chat_id: i64,
    message_id: i32,
    text: &str,
    reply: bool,
    html: bool,
) -> Result<(), Error> {
    let rendered = if html {
        telegram_html(text)
    } else {
        text.to_string()
    };
    let mut params = SendMessageParams::builder()
        .chat_id(chat_id)
        .text(rendered)
        .build();
    params.link_preview_options = Some(LinkPreviewOptions::DISABLED);
    if html {
        params.parse_mode = Some(ParseMode::Html);
    }
    if reply {
        let mut reply_to = ReplyParameters::builder().message_id(message_id).build();
        reply_to.allow_sending_without_reply = Some(true);
        params.reply_parameters = Some(reply_to);
    }
    bot.send_message(&params).await.map(|_| ())
}

fn is_parse_error(error: &Error) -> bool {
    match error {
        Error::Api(body) if body.error_code == 400 => {
            let description = body.description.to_ascii_lowercase();
            description.contains("parse") || description.contains("entit")
        }
        _ => false,
    }
}

fn too_old(date: u64) -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    now.saturating_sub(date) > 600
}

struct TelegramTyping {
    bot: Bot,
    chat_id: i64,
    token: String,
}

#[async_trait]
impl Typing for TelegramTyping {
    fn interval(&self) -> Duration {
        Duration::from_secs(4)
    }

    async fn pulse(&self) {
        let params = SendChatActionParams::builder()
            .chat_id(self.chat_id)
            .action(ChatAction::Typing)
            .build();
        if let Err(error) = self.bot.send_chat_action(&params).await {
            tracing::debug!(error = %redact(&error.to_string(), &self.token), "telegram typing failed");
        }
    }
}
