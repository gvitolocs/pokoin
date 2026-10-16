use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serenity::all::{
    Channel, Client, Context, EventHandler, GatewayIntents, GetMessages, GuildId, Message,
    MessageId, Ready, ResumedEvent, Settings, UserId,
};
use tokio::sync::{watch, RwLock};

use crate::discord_context::{assemble_server_context, AttachmentKind, DiscordLine, HISTORY_LIMIT};
use crate::gate::mentions_bot_username;
use crate::history::now_ms;
use crate::redact::redact;
use crate::turn::{
    apply_record, handle_turn, ChatLocks, Deps, Incoming, IncomingImage, Platform, Scope,
    ServerContext, Typing,
};

const IMAGE_MAX: u64 = 4_000_000;

pub async fn run(token: String, deps: Deps, mut shutdown: watch::Receiver<bool>) {
    let intents = GatewayIntents::GUILDS
        | GatewayIntents::GUILD_MESSAGES
        | GatewayIntents::DIRECT_MESSAGES
        | GatewayIntents::MESSAGE_CONTENT;
    let bot_id = Arc::new(RwLock::new(None));
    let locks = Arc::new(ChatLocks::new());
    loop {
        if *shutdown.borrow() {
            break;
        }
        deps.metrics
            .discord_connected
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let mut cache = Settings::default();
        cache.max_messages = 0;
        let handler = Handler {
            deps: deps.clone(),
            token: token.clone(),
            bot_id: bot_id.clone(),
            locks: locks.clone(),
        };
        let mut client = match Client::builder(&token, intents)
            .cache_settings(cache)
            .event_handler(handler)
            .await
        {
            Ok(client) => client,
            Err(error) => {
                tracing::error!(
                    error = %redact(&error.to_string(), &token),
                    "discord client setup failed"
                );
                if !sleep_or_stop(&mut shutdown, 30).await {
                    break;
                }
                continue;
            }
        };
        tokio::select! {
            _ = shutdown.changed() => break,
            result = client.start() => {
                deps.metrics
                    .discord_connected
                    .store(false, std::sync::atomic::Ordering::Relaxed);
                match result {
                    Ok(()) => tracing::error!("discord gateway stopped"),
                    Err(error) => tracing::error!(
                        error = %redact(&error.to_string(), &token),
                        "discord gateway stopped"
                    ),
                }
                if !sleep_or_stop(&mut shutdown, 30).await {
                    break;
                }
            }
        }
    }
    deps.metrics
        .discord_connected
        .store(false, std::sync::atomic::Ordering::Relaxed);
}

async fn sleep_or_stop(shutdown: &mut watch::Receiver<bool>, seconds: u64) -> bool {
    tokio::select! {
        _ = shutdown.changed() => false,
        _ = tokio::time::sleep(Duration::from_secs(seconds)) => !*shutdown.borrow(),
    }
}

struct Handler {
    deps: Deps,
    token: String,
    bot_id: Arc<RwLock<Option<UserId>>>,
    locks: Arc<ChatLocks>,
}

#[async_trait]
impl EventHandler for Handler {
    async fn ready(&self, _: Context, ready: Ready) {
        *self.bot_id.write().await = Some(ready.user.id);
        self.deps
            .metrics
            .discord_connected
            .store(true, std::sync::atomic::Ordering::Relaxed);
        tracing::info!(user = %ready.user.name, id = %ready.user.id, "discord ready");
    }

    async fn resume(&self, _: Context, _: ResumedEvent) {
        self.deps
            .metrics
            .discord_connected
            .store(true, std::sync::atomic::Ordering::Relaxed);
        tracing::info!("discord resume");
    }

    async fn message(&self, ctx: Context, msg: Message) {
        if msg.author.bot {
            return;
        }
        let bot_id = *self.bot_id.read().await;
        if bot_id.is_some_and(|id| id == msg.author.id) {
            return;
        }
        let deps = self.deps.clone();
        let locks = self.locks.clone();
        let bot_id_slot = self.bot_id.clone();
        let token = self.token.clone();
        let key = format!("{}:{}", msg.channel_id, msg.author.id);
        tokio::spawn(async move {
            locks
                .run(&key, handle_message(ctx, msg, deps, bot_id_slot, token))
                .await;
        });
    }
}

async fn handle_message(
    ctx: Context,
    msg: Message,
    deps: Deps,
    bot_id_slot: Arc<RwLock<Option<UserId>>>,
    token: String,
) {
    let bot_id = *bot_id_slot.read().await;
    let raw = strip_mention(&msg.content, bot_id);
    if raw.is_empty() && !has_image(&msg) {
        return;
    }
    let (channel_name, parent_name, guild_name) = channel_names(&ctx, &msg).await;
    let is_dm = msg.guild_id.is_none();
    let mentioned = bot_id.is_some_and(|id| msg.mentions.iter().any(|user| user.id == id));
    let reply_to_bot = msg
        .referenced_message
        .as_ref()
        .is_some_and(|referenced| bot_id.is_some_and(|id| referenced.author.id == id));
    let text = if raw.is_empty() && has_image(&msg) {
        "[photo]".to_string()
    } else {
        raw
    };
    let mut incoming = Incoming {
        platform: Platform::Discord,
        chat_id: msg.channel_id.to_string(),
        message_id: msg.id.to_string(),
        user_id: msg.author.id.to_string(),
        username: msg.author.name.clone(),
        display_name: msg
            .author
            .global_name
            .clone()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| msg.author.name.clone()),
        scope: if is_dm { Scope::Dm } else { Scope::Group },
        text,
        caption: None,
        is_mentioned: mentioned || mentions_bot_username(&msg.content, ""),
        is_reply_to_bot: reply_to_bot,
        bot_username: String::new(),
        channel_name,
        parent_name,
        in_guild: !is_dm,
        guild_id: msg.guild_id.map(|id| id.to_string()),
        image: None,
        server_context: None,
    };
    if has_image(&msg) {
        let caption = msg.content.trim();
        let gate_text = if caption.is_empty() {
            "[photo]".to_string()
        } else {
            strip_mention(caption, bot_id)
        };
        incoming.text = if gate_text.is_empty() {
            "[photo]".into()
        } else {
            gate_text
        };
        incoming.caption = Some(strip_mention(caption, bot_id));
        if !crate::turn::allowed(&incoming, &deps.config) {
            return;
        }
        let gate = crate::gate::should_poko_engage(crate::gate::EngageInput {
            text: &incoming.text,
            platform: "discord",
            is_dm,
            is_mentioned: incoming.is_mentioned,
            is_reply_to_bot: reply_to_bot,
            bot_username: "",
            channel_name: &incoming.channel_name,
            parent_name: &incoming.parent_name,
        });
        if !gate.should_reply {
            tracing::debug!(reason = %gate.reason, "discord photo skipped");
            return;
        }
        if let Some((mime, bytes)) = download_image(&deps, &msg).await {
            incoming.image = Some(IncomingImage { mime, bytes });
        }
    }
    if !is_dm {
        let http = ctx.http.clone();
        let channel_id = msg.channel_id;
        let message_id = msg.id;
        let guild_name = guild_name.clone();
        let channel_name = incoming.channel_name.clone();
        let bot = bot_id.unwrap_or(UserId::new(1));
        let referenced = msg.referenced_message.clone();
        let reference_id = msg
            .message_reference
            .as_ref()
            .and_then(|reference| reference.message_id);
        incoming.server_context = Some(Arc::new(LazyContext {
            http,
            channel_id,
            message_id,
            guild_name,
            channel_name,
            bot_id: bot,
            referenced,
            reference_id,
            token: token.clone(),
        }));
    }
    let typing = Arc::new(DiscordTyping {
        http: ctx.http.clone(),
        channel_id: msg.channel_id,
        token: token.clone(),
    });
    let mut deps = deps;
    deps.typing = Some(typing);
    let outcome = handle_turn(&incoming, &deps).await;
    if outcome.delete_original {
        if let Err(error) = msg.delete(&ctx.http).await {
            tracing::debug!(error = %redact(&error.to_string(), &token), "discord delete failed");
        }
    }
    if outcome.texts.is_empty() {
        return;
    }
    let mut sent = false;
    for (index, text) in outcome.texts.iter().enumerate() {
        let result = if index == 0 && outcome.reply && !outcome.delete_original {
            msg.reply(&ctx.http, text).await.map(|_| ())
        } else {
            msg.channel_id.say(&ctx.http, text).await.map(|_| ())
        };
        if let Err(error) = result {
            tracing::warn!(error = %redact(&error.to_string(), &token), "discord send failed");
        } else {
            sent = true;
        }
    }
    if sent {
        apply_record(&deps.history, &outcome, now_ms());
    }
}

fn strip_mention(content: &str, bot_id: Option<UserId>) -> String {
    let Some(bot_id) = bot_id else {
        return content.trim().to_string();
    };
    let id = bot_id.get();
    content
        .replace(&format!("<@{id}>"), "")
        .replace(&format!("<@!{id}>"), "")
        .trim()
        .to_string()
}

fn has_image(msg: &Message) -> bool {
    msg.attachments.iter().any(|attachment| {
        attachment
            .content_type
            .as_deref()
            .unwrap_or("")
            .starts_with("image/")
            && u64::from(attachment.size) <= IMAGE_MAX
    })
}

async fn download_image(deps: &Deps, msg: &Message) -> Option<(String, Vec<u8>)> {
    let attachment = msg.attachments.iter().find(|attachment| {
        attachment
            .content_type
            .as_deref()
            .unwrap_or("")
            .starts_with("image/")
            && u64::from(attachment.size) <= IMAGE_MAX
    })?;
    let mime = attachment
        .content_type
        .clone()
        .unwrap_or_else(|| "image/jpeg".into());
    let response = deps.http.get(&attachment.url).send().await.ok()?;
    if !response.status().is_success() {
        tracing::warn!(status = %response.status(), "discord attachment download failed");
        return None;
    }
    let bytes = response.bytes().await.ok()?.to_vec();
    if bytes.len() as u64 > IMAGE_MAX {
        return None;
    }
    Some((mime, bytes))
}

async fn channel_names(ctx: &Context, msg: &Message) -> (String, String, String) {
    let Some(guild_id) = msg.guild_id else {
        return (String::new(), String::new(), String::new());
    };
    let guild_name = ctx
        .cache
        .guild(guild_id)
        .map(|guild| guild.name.clone())
        .unwrap_or_else(|| "server".into());
    if let Some(channel) = cached_channel(ctx, guild_id, msg.channel_id) {
        let parent = channel
            .parent_id
            .and_then(|id| cached_channel(ctx, guild_id, id))
            .map(|parent| parent.name)
            .unwrap_or_default();
        return (channel.name, parent, guild_name);
    }
    match msg.channel_id.to_channel(ctx).await {
        Ok(Channel::Guild(channel)) => {
            let parent = channel
                .parent_id
                .and_then(|id| cached_channel(ctx, guild_id, id))
                .map(|parent| parent.name)
                .unwrap_or_default();
            (channel.name, parent, guild_name)
        }
        _ => (String::new(), String::new(), guild_name),
    }
}

fn cached_channel(
    ctx: &Context,
    guild_id: GuildId,
    channel_id: serenity::all::ChannelId,
) -> Option<serenity::all::GuildChannel> {
    ctx.cache
        .guild(guild_id)
        .and_then(|guild| guild.channels.get(&channel_id).cloned())
}

struct LazyContext {
    http: Arc<serenity::http::Http>,
    channel_id: serenity::all::ChannelId,
    message_id: MessageId,
    guild_name: String,
    channel_name: String,
    bot_id: UserId,
    referenced: Option<Box<Message>>,
    reference_id: Option<MessageId>,
    token: String,
}

#[async_trait]
impl ServerContext for LazyContext {
    async fn load(&self) -> String {
        let history = match self
            .channel_id
            .messages(
                &self.http,
                GetMessages::new()
                    .before(self.message_id)
                    .limit(HISTORY_LIMIT as u8),
            )
            .await
        {
            Ok(mut messages) => {
                messages.reverse();
                Ok(messages
                    .iter()
                    .map(|message| line_from(message, self.bot_id))
                    .collect())
            }
            Err(error) => {
                tracing::debug!(error = %redact(&error.to_string(), &self.token), "discord history unavailable");
                Err(())
            }
        };
        let referenced = if let Some(message) = &self.referenced {
            Some(line_from(message, self.bot_id))
        } else if let Some(id) = self.reference_id {
            match self.http.get_message(self.channel_id, id).await {
                Ok(message) => Some(line_from(&message, self.bot_id)),
                Err(_) => None,
            }
        } else {
            None
        };
        assemble_server_context(
            Some("guild"),
            &self.guild_name,
            &self.channel_name,
            history,
            referenced,
            &self.bot_id.to_string(),
        )
    }
}

fn line_from(msg: &Message, bot_id: UserId) -> DiscordLine {
    let is_bot = msg.author.id == bot_id;
    let author_name = if is_bot {
        "Poko".to_string()
    } else if let Some(nick) = msg
        .member
        .as_ref()
        .and_then(|member| member.nick.clone())
        .filter(|nick| !nick.is_empty())
    {
        nick
    } else if let Some(global) = msg
        .author
        .global_name
        .clone()
        .filter(|name| !name.is_empty())
    {
        global
    } else if !msg.author.name.is_empty() {
        msg.author.name.clone()
    } else {
        "utente".to_string()
    };
    let attachments = msg
        .attachments
        .iter()
        .map(|attachment| {
            if attachment
                .content_type
                .as_deref()
                .unwrap_or("")
                .starts_with("image/")
            {
                AttachmentKind::Image
            } else {
                AttachmentKind::File
            }
        })
        .collect();
    DiscordLine {
        author_id: msg.author.id.to_string(),
        author_name,
        content: msg.content.clone(),
        attachments,
        is_bot,
    }
}

struct DiscordTyping {
    http: Arc<serenity::http::Http>,
    channel_id: serenity::all::ChannelId,
    token: String,
}

#[async_trait]
impl Typing for DiscordTyping {
    fn interval(&self) -> Duration {
        Duration::from_secs(8)
    }

    async fn pulse(&self) {
        if let Err(error) = self.channel_id.broadcast_typing(&self.http).await {
            tracing::debug!(error = %redact(&error.to_string(), &self.token), "discord typing failed");
        }
    }
}
