//! `POST /api/poko-bot-chat` — service-token chat for the Telegram/Discord bot.
//!
//! The bot holds `POKO_MARKET_SERVICE_TOKEN` and runs the in-process Poko brain
//! here. There is no Firebase session and no transcript write: the bot keeps
//! its own history. Personal marketplace data is loaded only for a private
//! `dm` whose `firebaseUid` the bot already resolved through `/api/poko-connect`.
//! The bot sends Hermes-compatible Honcho ids (`memoryPeerId`, `memorySessionId`)
//! so Telegram and Discord users keep the memories Hermes Poko built.

use std::collections::HashSet;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Value as Json};

use crate::domain::marketplace_game::parse_game_from_request;
use crate::domain::poko_chat::{attach_reply_cards, market_first_directive, photo_search_context};
use crate::poko_brain::{BrainError, Turn};
use crate::rate_limit::RateLimitRequest;
use crate::state::DomainState;

use super::poko::{is_service_authorized, service_token};
use super::{authorization, json_with_cors, method_not_allowed, parse_body, string_field};

const MESSAGE_CHARS: usize = 4_000;
const USER_KEY_CHARS: usize = 80;
const SESSION_CHARS: usize = 80;
const DISPLAY_NAME_CHARS: usize = 80;
const FIREBASE_UID_CHARS: usize = 128;
const MEMORY_ID_CHARS: usize = 160;
const HISTORY_TURNS: usize = 10;
const HISTORY_TEXT_CHARS: usize = 2_000;
const CONTEXT_BLOCKS: usize = 6;
const CONTEXT_BLOCK_CHARS: usize = 3_000;
const IMAGE_LIMIT: usize = 2;
const IMAGE_MIN_BYTES: usize = 32;
const IMAGE_MAX_BYTES: usize = 4_000_000;
const PHOTO_CARD_CAP: usize = 8;
const RESOLVED_CARD_CAP: usize = 4;
const REPLY_CARD_CAP: usize = 6;
const WEBSITE_TURNS: usize = 6;
const WEBSITE_LINE_CHARS: usize = 240;
const WEBSITE_BLOCK_CHARS: usize = 1_500;

const TELEGRAM_DM: &str = "[Telegram] You are Poko in a private Telegram chat with one user. Write plain text: no markdown, no headings. Cards you put on the [[cards: ...]] line are shown as links under your reply.";
const TELEGRAM_GROUP: &str = "[Telegram group] You are Poko in a public Telegram group: everyone in the group reads your reply. Never mention anyone's Pokoin profile, cart, watchlist, balances or private chats; for those, ask them to message you privately. Write plain text: no markdown, no headings. Cards you put on the [[cards: ...]] line are shown as links under your reply.";
const DISCORD_DM: &str = "[Discord] You are Poko in a private Discord direct message with one user. Write plain text: no markdown, no headings. Cards you put on the [[cards: ...]] line are shown as links under your reply.";
const DISCORD_GROUP: &str = "[Discord group] You are Poko in a public Discord server channel: everyone in the group reads your reply. Never mention anyone's Pokoin profile, cart, watchlist, balances or private chats; for those, ask them to message you privately. Write plain text: no markdown, no headings. Cards you put on the [[cards: ...]] line are shown as links under your reply.";

const NO_PRINTINGS: &str = "What can you tell me about the attached photo? Multi-card search found no printings; do not invent cards.";

#[derive(Debug)]
struct BotChatRequest {
    platform: String,
    scope: String,
    user_key: String,
    firebase_uid: Option<String>,
    session_id: String,
    display_name: String,
    message: String,
    history: Vec<Turn>,
    context_blocks: Vec<String>,
    images: Vec<Vec<u8>>,
    game: String,
    memory_peer_id: Option<String>,
    memory_session_id: Option<String>,
}

/// `POST /api/poko-bot-chat`.
pub async fn poko_bot_chat(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if service_token().is_empty() {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "poko-bot-chat not configured: POKO_MARKET_SERVICE_TOKEN missing",
        );
    }
    if !is_service_authorized(authorization(&headers)) {
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let body = parse_body(&body);
    let request = match parse_request(&body) {
        Ok(request) => request,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, &error),
    };
    let verdict = state
        .limiter()
        .check(RateLimitRequest {
            scope: "poko-bot-chat",
            identity: &request.user_key,
            limit: 30,
            window_seconds: 60,
        })
        .await;
    if !verdict.allowed {
        return error_response(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    run_turn(&state, request).await
}

/// Any verb other than POST.
pub async fn poko_bot_chat_other() -> Response {
    method_not_allowed("POST")
}

fn error_response(status: StatusCode, error: &str) -> Response {
    json_with_cors(status, json!({ "ok": false, "error": error }))
}

fn brain_failed(detail: &str) -> Response {
    json_with_cors(
        StatusCode::BAD_GATEWAY,
        json!({ "ok": false, "error": "brain_failed", "detail": detail }),
    )
}

fn parse_request(body: &Json) -> Result<BotChatRequest, String> {
    let platform = string_field(body, "platform").trim().to_string();
    if platform != "telegram" && platform != "discord" {
        return Err("platform must be telegram or discord".to_string());
    }
    let scope = if string_field(body, "scope").trim() == "dm" {
        "dm".to_string()
    } else {
        "group".to_string()
    };
    let user_key = string_field(body, "userKey").trim().to_string();
    if user_key.is_empty() || user_key.chars().count() > USER_KEY_CHARS {
        return Err("userKey must be 1-80 characters".to_string());
    }
    let firebase_uid = clean_id(body.get("firebaseUid"), FIREBASE_UID_CHARS);
    let session_raw = string_field(body, "sessionId").trim().to_string();
    let session_id = if session_raw.is_empty() {
        user_key.clone()
    } else {
        take_chars(&session_raw, SESSION_CHARS)
    };
    let display_name = take_chars(string_field(body, "displayName").trim(), DISPLAY_NAME_CHARS);
    let message = take_chars(string_field(body, "message").trim(), MESSAGE_CHARS);
    let history = clean_history(body.get("history"));
    let context_blocks = clean_context_blocks(body.get("contextBlocks"));
    let images = clean_images(body.get("images"));
    if message.is_empty() && images.is_empty() {
        return Err("message or images required".to_string());
    }
    let game = parse_game_from_request(&[], body.get("game").and_then(Json::as_str), None);
    Ok(BotChatRequest {
        platform,
        scope,
        user_key,
        firebase_uid,
        session_id,
        display_name,
        message,
        history,
        context_blocks,
        images,
        game,
        memory_peer_id: clean_id(body.get("memoryPeerId"), MEMORY_ID_CHARS),
        memory_session_id: clean_id(body.get("memorySessionId"), MEMORY_ID_CHARS),
    })
}

/// A trimmed `[A-Za-z0-9_-]{1,max}` id, else `None`.
fn clean_id(value: Option<&Json>, max: usize) -> Option<String> {
    let text = value.and_then(Json::as_str)?.trim();
    if (1..=max).contains(&text.len())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        Some(text.to_string())
    } else {
        None
    }
}

fn clean_history(value: Option<&Json>) -> Vec<Turn> {
    let Some(items) = value.and_then(Json::as_array) else {
        return Vec::new();
    };
    let mut turns = Vec::new();
    for item in items {
        let Some(object) = item.as_object() else {
            continue;
        };
        let role = object.get("role").and_then(Json::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = object
            .get("text")
            .and_then(Json::as_str)
            .unwrap_or("")
            .trim();
        if text.is_empty() {
            continue;
        }
        turns.push(Turn {
            role: role.to_string(),
            text: take_chars(text, HISTORY_TEXT_CHARS),
        });
    }
    if turns.len() > HISTORY_TURNS {
        turns = turns.split_off(turns.len() - HISTORY_TURNS);
    }
    turns
}

fn clean_context_blocks(value: Option<&Json>) -> Vec<String> {
    let Some(items) = value.and_then(Json::as_array) else {
        return Vec::new();
    };
    let mut blocks = Vec::new();
    for item in items {
        let Some(text) = item.as_str() else {
            continue;
        };
        let text = take_chars(text.trim(), CONTEXT_BLOCK_CHARS);
        if text.is_empty() {
            continue;
        }
        blocks.push(text);
        if blocks.len() == CONTEXT_BLOCKS {
            break;
        }
    }
    blocks
}

fn clean_images(value: Option<&Json>) -> Vec<Vec<u8>> {
    let Some(items) = value.and_then(Json::as_array) else {
        return Vec::new();
    };
    let mut images = Vec::new();
    for item in items {
        if images.len() == IMAGE_LIMIT {
            break;
        }
        let Some(bytes) = image_bytes(item) else {
            continue;
        };
        images.push(bytes);
    }
    images
}

fn image_bytes(item: &Json) -> Option<Vec<u8>> {
    let mime = item.get("mimeType").and_then(Json::as_str).unwrap_or("");
    if mime != "image/jpeg" && mime != "image/png" && mime != "image/webp" {
        return None;
    }
    let data = item.get("data").and_then(Json::as_str).unwrap_or("");
    let bytes = decode_standard_base64(data)?;
    if !(IMAGE_MIN_BYTES..=IMAGE_MAX_BYTES).contains(&bytes.len()) {
        return None;
    }
    Some(bytes)
}

fn decode_standard_base64(data: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

fn take_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn platform_block(platform: &str, scope: &str) -> &'static str {
    match (platform, scope) {
        ("discord", "dm") => DISCORD_DM,
        ("discord", _) => DISCORD_GROUP,
        (_, "dm") => TELEGRAM_DM,
        _ => TELEGRAM_GROUP,
    }
}

fn linked_profile_line(platform: &str) -> String {
    let channel = if platform == "discord" {
        "Discord"
    } else {
        "Telegram"
    };
    format!("[Pokoin profile] This user linked their Pokoin account to {channel}. Greet them naturally and never reveal the account id.")
}

/// Last six website turns, oldest first, each line ≤240 chars and the block ≤1,500.
fn website_messages_block(turns: &[Turn]) -> String {
    let start = turns.len().saturating_sub(WEBSITE_TURNS);
    let mut lines = Vec::new();
    for turn in &turns[start..] {
        let label = if turn.role == "assistant" {
            "Poko"
        } else if turn.role == "user" {
            "User"
        } else {
            continue;
        };
        lines.push(take_chars(
            &format!("{label}: {}", turn.text),
            WEBSITE_LINE_CHARS,
        ));
    }
    const HEADER: &str = "Recent website Messages with this user (oldest first):";
    while !lines.is_empty() {
        let mut block = String::from(HEADER);
        for line in &lines {
            block.push('\n');
            block.push_str(line);
        }
        if block.chars().count() <= WEBSITE_BLOCK_CHARS {
            return block;
        }
        lines.remove(0);
    }
    String::new()
}

fn turn_user_message(message: &str, photo_count: usize) -> String {
    if !message.is_empty() {
        return message.to_string();
    }
    if photo_count > 0 {
        format!("The attached photo was identified with multi-card search ({photo_count} printings). Quote Pokoin sold median, current asks, and liquidity for each one. Do not collapse the photo to a single card.")
    } else {
        NO_PRINTINGS.to_string()
    }
}

fn photo_identity(card: &Json) -> String {
    let id = card.get("cardId").and_then(Json::as_str).unwrap_or("");
    if !id.is_empty() {
        return id.to_string();
    }
    format!(
        "{}|{}|{}",
        card.get("name").and_then(Json::as_str).unwrap_or(""),
        card.get("setName").and_then(Json::as_str).unwrap_or(""),
        card.get("number").and_then(Json::as_str).unwrap_or("")
    )
}

fn card_id(card: &Json) -> &str {
    card.get("cardId").and_then(Json::as_str).unwrap_or("")
}

async fn identify_images(state: &DomainState, images: &[Vec<u8>]) -> Vec<Json> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let primary = super::poko_chat::scan_primary();
    let fallback = super::poko_chat::scan_fallback();
    for bytes in images {
        let cards =
            super::poko_chat::identify_photo_bytes(state, bytes.clone(), &primary, &fallback).await;
        for card in cards {
            if !seen.insert(photo_identity(&card)) {
                continue;
            }
            found.push(card);
            if found.len() >= PHOTO_CARD_CAP {
                return found;
            }
        }
    }
    found
}

fn assemble_context(
    platform: &str,
    extra: &[String],
    photo_cards: &[Json],
    personal_intent: &str,
    website: &str,
    linked: &str,
) -> Vec<String> {
    let mut blocks = Vec::new();
    blocks.push(platform.to_string());
    blocks.extend(extra.iter().cloned());
    blocks.push(market_first_directive(&[], &json!({}), photo_cards));
    blocks.push(personal_intent.to_string());
    blocks.push(website.to_string());
    blocks.push(linked.to_string());
    blocks.push(photo_search_context(photo_cards));
    blocks
        .into_iter()
        .filter(|block| !block.trim().is_empty())
        .collect()
}

/// Photo cards that have a cardId, then at most four resolved rows. Dedupe by
/// cardId and keep six.
fn reply_cards(photo_cards: &[Json], resolved: &[Json]) -> Vec<Json> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let photos = photo_cards.iter().filter(|card| !card_id(card).is_empty());
    for card in photos.chain(resolved.iter().take(RESOLVED_CARD_CAP)) {
        let id = card_id(card);
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        out.push(card.clone());
        if out.len() >= REPLY_CARD_CAP {
            break;
        }
    }
    out
}

async fn personal_context(
    state: &DomainState,
    request: &BotChatRequest,
) -> (String, String, String) {
    if request.scope != "dm" {
        return (String::new(), String::new(), String::new());
    }
    let Some(uid) = request.firebase_uid.as_deref() else {
        return (String::new(), String::new(), String::new());
    };
    let (_, intent) = super::poko_chat::load_personal_for_chat(state, uid, &json!({})).await;
    let website = match state.firestore() {
        Ok(firestore) => {
            let turns = super::poko_chat::recent_history(&firestore, uid).await;
            website_messages_block(&turns)
        }
        Err(_) => String::new(),
    };
    (intent, website, linked_profile_line(&request.platform))
}

async fn run_turn(state: &DomainState, request: BotChatRequest) -> Response {
    let photo_cards = identify_images(state, &request.images).await;
    let user_message = turn_user_message(&request.message, photo_cards.len());
    let (personal_intent, website, linked) = personal_context(state, &request).await;
    let personal = !personal_intent.is_empty() || !website.is_empty();
    let context_blocks = assemble_context(
        platform_block(&request.platform, &request.scope),
        &request.context_blocks,
        &photo_cards,
        &personal_intent,
        &website,
        &linked,
    );
    let user_id = request
        .firebase_uid
        .clone()
        .unwrap_or_else(|| request.user_key.clone());
    let brain = match crate::poko_brain::reply(
        &crate::poko_brain::BrainDeps::production(state),
        crate::poko_brain::BrainInput {
            user_message,
            context_blocks,
            history: request.history.clone(),
            game: request.game.clone(),
            display_name: request.display_name.clone(),
            user_id,
            session_id: request.session_id.clone(),
            memory_peer_id: request.memory_peer_id.clone(),
            memory_session_id: request.memory_session_id.clone(),
        },
    )
    .await
    {
        Ok(brain) if !brain.reply.trim().is_empty() => brain,
        Ok(_) => {
            tracing::warn!(
                platform = %request.platform,
                scope = %request.scope,
                detail = "empty",
                "poko-bot-chat brain failed"
            );
            return brain_failed("empty");
        }
        Err(error) => {
            let detail = match error {
                BrainError::Budget => "budget",
                BrainError::ProvidersFailed => "providers",
            };
            tracing::warn!(
                platform = %request.platform,
                scope = %request.scope,
                detail,
                "poko-bot-chat brain failed"
            );
            return brain_failed(detail);
        }
    };

    let (stripped, attached) = match state.marketplace_db() {
        Ok(db) => attach_reply_cards(&db, &brain.reply, &brain.cards).await,
        Err(_) => (String::new(), Vec::new()),
    };
    let reply = if stripped.is_empty() {
        brain.reply.clone()
    } else {
        stripped
    };
    let cards = reply_cards(&photo_cards, &attached);
    let tools: Vec<String> = brain
        .tool_calls
        .iter()
        .map(|call| call.name.clone())
        .collect();
    tracing::info!(
        platform = %request.platform,
        scope = %request.scope,
        provider = %brain.provider,
        model = %brain.model,
        elapsed_ms = brain.elapsed_ms,
        tool_count = tools.len(),
        photo_cards = photo_cards.len(),
        personal,
        blocked = brain.blocked,
        "poko-bot-chat"
    );
    json_with_cors(
        StatusCode::OK,
        json!({
            "ok": true,
            "reply": reply,
            "cards": cards,
            "provider": brain.provider,
            "model": brain.model,
            "elapsedMs": brain.elapsed_ms,
            "llmCalls": brain.llm_calls,
            "tools": tools,
            "blocked": brain.blocked,
            "photoCards": photo_cards.len(),
            "personal": personal,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn standard_b64(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn parsed(body: Json) -> Result<BotChatRequest, String> {
        parse_request(&body)
    }

    fn base_message() -> Json {
        json!({
            "platform": "telegram",
            "userKey": "telegram:12345",
            "message": "hi",
        })
    }

    #[test]
    fn memory_ids_keep_only_safe_honcho_ids() {
        for id in [
            "telegram_user_123",
            "telegram_chat_-100123",
            "discord_guild_user_1_2",
            "poko_user_abcDEF-_9",
        ] {
            let mut body = base_message();
            body["memoryPeerId"] = json!(format!(" {id} "));
            body["memorySessionId"] = json!(id);
            let request = parsed(body).unwrap();
            assert_eq!(request.memory_peer_id.as_deref(), Some(id));
            assert_eq!(request.memory_session_id.as_deref(), Some(id));
        }
        let absent = parsed(base_message()).unwrap();
        assert_eq!(absent.memory_peer_id, None);
        assert_eq!(absent.memory_session_id, None);
        let too_long = "a".repeat(161);
        for bad in [
            json!(""),
            json!("   "),
            json!("a:b"),
            json!("a b"),
            json!(too_long),
            json!(7),
        ] {
            let mut body = base_message();
            body["memoryPeerId"] = bad.clone();
            body["memorySessionId"] = bad;
            let request = parsed(body).unwrap();
            assert_eq!(request.memory_peer_id, None);
            assert_eq!(request.memory_session_id, None);
        }
        let mut body = base_message();
        body["memoryPeerId"] = json!("a".repeat(160));
        assert!(parsed(body).unwrap().memory_peer_id.is_some());
    }

    #[test]
    fn platform_must_be_telegram_or_discord() {
        let err = parsed(json!({
            "platform": "irc",
            "userKey": "telegram:1",
            "message": "hi",
        }))
        .unwrap_err();
        assert_eq!(err, "platform must be telegram or discord");
        assert!(parsed(json!({ "userKey": "telegram:1", "message": "hi" })).is_err());
        assert_eq!(parsed(base_message()).unwrap().platform, "telegram");
        let discord = parsed(json!({
            "platform": " discord ",
            "userKey": "discord:9",
            "message": "hi",
        }))
        .unwrap();
        assert_eq!(discord.platform, "discord");
    }

    #[test]
    fn scope_defaults_to_group_unless_dm() {
        assert_eq!(parsed(base_message()).unwrap().scope, "group");
        assert_eq!(
            parsed(json!({
                "platform": "telegram",
                "scope": "public",
                "userKey": "telegram:1",
                "message": "hi",
            }))
            .unwrap()
            .scope,
            "group"
        );
        assert_eq!(
            parsed(json!({
                "platform": "telegram",
                "scope": "DM",
                "userKey": "telegram:1",
                "message": "hi",
            }))
            .unwrap()
            .scope,
            "group"
        );
        assert_eq!(
            parsed(json!({
                "platform": "discord",
                "scope": " dm ",
                "userKey": "discord:1",
                "message": "hi",
            }))
            .unwrap()
            .scope,
            "dm"
        );
    }

    #[test]
    fn user_key_is_required_and_capped_at_80_chars() {
        let missing = parsed(json!({ "platform": "telegram", "message": "hi" })).unwrap_err();
        assert_eq!(missing, "userKey must be 1-80 characters");
        let blank = parsed(json!({
            "platform": "telegram",
            "userKey": "   ",
            "message": "hi",
        }))
        .unwrap_err();
        assert_eq!(blank, "userKey must be 1-80 characters");
        let long = "é".repeat(81);
        assert!(parsed(json!({
            "platform": "telegram",
            "userKey": long,
            "message": "hi",
        }))
        .is_err());
        let kept = parsed(json!({
            "platform": "telegram",
            "userKey": format!("  {}  ", "é".repeat(80)),
            "message": "hi",
        }))
        .unwrap();
        assert_eq!(kept.user_key.chars().count(), 80);
        assert_eq!(
            parsed(json!({
                "platform": "telegram",
                "userKey": "  telegram:12345  ",
                "message": "hi",
            }))
            .unwrap()
            .user_key,
            "telegram:12345"
        );
    }

    #[test]
    fn firebase_uid_must_match_the_token_alphabet() {
        let kept = parsed(json!({
            "platform": "telegram",
            "userKey": "telegram:1",
            "firebaseUid": " Ab_9-Z ",
            "message": "hi",
        }))
        .unwrap();
        assert_eq!(kept.firebase_uid.as_deref(), Some("Ab_9-Z"));
        for uid in ["bad uid", "abc.def", "", &"a".repeat(129), "üid"] {
            let request = parsed(json!({
                "platform": "telegram",
                "userKey": "telegram:1",
                "firebaseUid": uid,
                "message": "hi",
            }))
            .unwrap();
            assert_eq!(request.firebase_uid, None, "uid={uid}");
        }
        let maxed = parsed(json!({
            "platform": "telegram",
            "userKey": "telegram:1",
            "firebaseUid": "a".repeat(128),
            "message": "hi",
        }))
        .unwrap();
        assert_eq!(maxed.firebase_uid.unwrap().len(), 128);
    }

    #[test]
    fn message_keeps_newlines_and_images_can_stand_alone() {
        let request = parsed(json!({
            "platform": "telegram",
            "userKey": "telegram:1",
            "message": "  line one\nline two  ",
        }))
        .unwrap();
        assert_eq!(request.message, "line one\nline two");
        let capped = parsed(json!({
            "platform": "telegram",
            "userKey": "telegram:1",
            "message": "é".repeat(4_001),
        }))
        .unwrap();
        assert_eq!(capped.message.chars().count(), 4_000);

        let empty = parsed(json!({
            "platform": "telegram",
            "userKey": "telegram:1",
            "message": " \n ",
        }))
        .unwrap_err();
        assert_eq!(empty, "message or images required");

        let jpeg = standard_b64(&[7u8; 32]);
        let photo_only = parsed(json!({
            "platform": "telegram",
            "userKey": "telegram:1",
            "message": "",
            "images": [{ "mimeType": "image/jpeg", "data": jpeg }],
        }))
        .unwrap();
        assert!(photo_only.message.is_empty());
        assert_eq!(photo_only.images.len(), 1);
        assert_eq!(photo_only.images[0], vec![7u8; 32]);
    }

    #[test]
    fn history_keeps_the_last_ten_user_and_assistant_turns() {
        let mut history = Vec::new();
        history.push(json!({ "role": "assistant", "text": "   " }));
        for index in 0..12 {
            history.push(json!({ "role": "user", "text": format!("m{index}") }));
        }
        history.push(json!({ "role": "system", "text": "ignore me" }));
        history.push(json!({ "role": "tool", "text": "nope" }));
        history.push(json!({ "role": "user", "text": "é".repeat(2_001) }));
        history.push(json!("not-an-object"));
        let request = parsed(json!({
            "platform": "telegram",
            "userKey": "telegram:1",
            "message": "hi",
            "history": history,
        }))
        .unwrap();
        assert_eq!(request.history.len(), 10);
        assert_eq!(request.history[0].text, "m3");
        assert_eq!(request.history[8].text, "m11");
        assert_eq!(request.history[9].role, "user");
        assert_eq!(request.history[9].text.chars().count(), 2_000);
        assert!(request.history.iter().all(|turn| turn.role == "user"));
    }

    #[test]
    fn context_blocks_drop_empties_and_keep_six() {
        let blocks = vec![
            json!(""),
            json!("   "),
            json!("keep"),
            json!("x".repeat(3_001)),
            json!(5),
            json!("g1"),
            json!("g2"),
            json!("g3"),
            json!("g4"),
            json!("g5"),
        ];
        let request = parsed(json!({
            "platform": "telegram",
            "userKey": "telegram:1",
            "message": "hi",
            "contextBlocks": blocks,
        }))
        .unwrap();
        assert_eq!(request.context_blocks.len(), 6);
        assert_eq!(request.context_blocks[0], "keep");
        assert_eq!(request.context_blocks[1].chars().count(), 3_000);
        assert_eq!(request.context_blocks[5], "g4");
        assert!(!request.context_blocks.iter().any(|block| block == "g5"));
    }

    #[test]
    fn images_follow_mime_base64_and_size_rules() {
        let jpeg = standard_b64(&[1u8; 32]);
        let webp = standard_b64(&[2u8; 40]);
        let png = standard_b64(&[3u8; 50]);
        let tiny = standard_b64(&[4u8; 31]);
        let huge = standard_b64(&vec![5u8; IMAGE_MAX_BYTES + 1]);
        let url_safe = {
            use base64::Engine;
            base64::engine::general_purpose::URL_SAFE.encode(vec![0xffu8; 32])
        };
        let request = parsed(json!({
            "platform": "discord",
            "userKey": "discord:1",
            "message": "look",
            "images": [
                { "mimeType": "image/gif", "data": jpeg },
                { "mimeType": "image/jpeg", "data": "!!!!" },
                { "mimeType": "image/jpeg", "data": url_safe },
                { "mimeType": "image/jpeg", "data": tiny },
                { "mimeType": "image/png", "data": huge },
                { "mimeType": "image/jpeg", "data": jpeg },
                { "mimeType": "image/webp", "data": webp },
                { "mimeType": "image/png", "data": png },
            ],
        }))
        .unwrap();
        assert_eq!(request.images.len(), 2);
        assert_eq!(request.images[0], vec![1u8; 32]);
        assert_eq!(request.images[1], vec![2u8; 40]);

        let only_bad = parsed(json!({
            "platform": "telegram",
            "userKey": "telegram:1",
            "images": [{ "mimeType": "image/gif", "data": jpeg }],
        }))
        .unwrap_err();
        assert_eq!(only_bad, "message or images required");

        let maxed = standard_b64(&vec![9u8; IMAGE_MAX_BYTES]);
        let accepted = parsed(json!({
            "platform": "telegram",
            "userKey": "telegram:1",
            "images": [{ "mimeType": "image/webp", "data": maxed }],
        }))
        .unwrap();
        assert_eq!(accepted.images[0].len(), IMAGE_MAX_BYTES);
    }

    #[test]
    fn session_and_display_name_are_optional_and_capped() {
        let defaults = parsed(base_message()).unwrap();
        assert_eq!(defaults.session_id, "telegram:12345");
        assert!(defaults.display_name.is_empty());
        assert_eq!(defaults.game, "pokemon");

        let request = parsed(json!({
            "platform": "telegram",
            "userKey": "telegram:1",
            "message": "hi",
            "sessionId": format!("  {}  ", "s".repeat(90)),
            "displayName": format!("  {}  ", "n".repeat(90)),
            "game": "one-piece",
        }))
        .unwrap();
        assert_eq!(request.session_id.chars().count(), 80);
        assert_eq!(request.display_name.chars().count(), 80);
        assert_eq!(request.game, "one_piece");
    }

    #[test]
    fn website_messages_render_the_last_six_and_respect_caps() {
        assert!(website_messages_block(&[]).is_empty());
        let short = website_messages_block(&[
            Turn {
                role: "user".to_string(),
                text: "hi".to_string(),
            },
            Turn {
                role: "assistant".to_string(),
                text: "hello".to_string(),
            },
            Turn {
                role: "system".to_string(),
                text: "skip".to_string(),
            },
        ]);
        assert_eq!(
            short,
            "Recent website Messages with this user (oldest first):\nUser: hi\nPoko: hello"
        );

        let many: Vec<Turn> = (0..8)
            .map(|index| Turn {
                role: "user".to_string(),
                text: format!("t{index}"),
            })
            .collect();
        let recent = website_messages_block(&many);
        assert!(!recent.contains("User: t0\n") && !recent.contains("User: t1\n"));
        assert!(recent.contains("User: t2"));
        assert!(recent.contains("User: t7"));

        let long = website_messages_block(&[Turn {
            role: "user".to_string(),
            text: "y".repeat(300),
        }]);
        let line = long.lines().nth(1).unwrap();
        assert_eq!(line.chars().count(), 240);
        assert!(line.starts_with("User: y"));

        let wide: Vec<Turn> = (0..6)
            .map(|index| Turn {
                role: "user".to_string(),
                text: format!("{index}{}", "x".repeat(300)),
            })
            .collect();
        let capped = website_messages_block(&wide);
        assert!(
            capped.chars().count() <= 1_500,
            "{}",
            capped.chars().count()
        );
        assert!(capped.contains("User: 5"));
        assert!(capped.starts_with("Recent website Messages with this user (oldest first):\n"));
        // Six 240-char lines sit on the 1,500 cap. Anything over that drops the
        // oldest line first; the newest line always stays.
        let lines: Vec<&str> = capped.lines().skip(1).collect();
        assert!(!lines.is_empty());
        assert!(lines.len() <= 6);
        assert_eq!(lines.last().unwrap().chars().count(), 240);
        if lines.len() < 6 {
            assert!(!lines[0].starts_with("User: 0"));
        }
    }

    #[test]
    fn platform_block_follows_channel_and_privacy() {
        assert_eq!(platform_block("telegram", "dm"), TELEGRAM_DM);
        assert_eq!(platform_block("telegram", "group"), TELEGRAM_GROUP);
        assert_eq!(platform_block("discord", "dm"), DISCORD_DM);
        assert_eq!(platform_block("discord", "group"), DISCORD_GROUP);
        assert!(TELEGRAM_DM.contains("private Telegram chat"));
        assert!(TELEGRAM_GROUP.contains("public Telegram group"));
        assert!(DISCORD_DM.contains("Discord direct message"));
        assert!(DISCORD_GROUP.contains("Discord server channel"));
        assert!(TELEGRAM_GROUP.contains("message you privately"));
        assert!(!TELEGRAM_DM.contains("privately"));
        assert_eq!(
            linked_profile_line("telegram"),
            "[Pokoin profile] This user linked their Pokoin account to Telegram. Greet them naturally and never reveal the account id."
        );
        assert!(linked_profile_line("discord").contains("to Discord."));
    }

    #[test]
    fn reply_cards_prefer_photo_ids_then_four_resolved_rows() {
        let photos = vec![
            json!({ "cardId": "1", "name": "Photo" }),
            json!({ "name": "NoId" }),
            json!({ "cardId": "2", "name": "Second" }),
        ];
        let resolved: Vec<Json> = (1..8)
            .map(|id| json!({ "cardId": id.to_string() }))
            .collect();
        let cards = reply_cards(&photos, &resolved);
        let ids: Vec<&str> = cards
            .iter()
            .map(|card| card["cardId"].as_str().unwrap())
            .collect();
        // Photo ids 1 and 2, then resolved 1 (dup), 2 (dup), 3, 4 — cap 6 is not hit.
        assert_eq!(ids, vec!["1", "2", "3", "4"]);

        let many_photos: Vec<Json> = (0..8)
            .map(|id| json!({ "cardId": id.to_string() }))
            .collect();
        let capped = reply_cards(&many_photos, &resolved);
        assert_eq!(capped.len(), 6);
        assert_eq!(capped[0]["cardId"], json!("0"));
        assert_eq!(capped[5]["cardId"], json!("5"));
    }

    #[test]
    fn an_empty_photo_asks_not_to_invent_cards() {
        assert_eq!(
            turn_user_message("", 0),
            "What can you tell me about the attached photo? Multi-card search found no printings; do not invent cards."
        );
        assert_eq!(
            turn_user_message("", 2),
            "The attached photo was identified with multi-card search (2 printings). Quote Pokoin sold median, current asks, and liquidity for each one. Do not collapse the photo to a single card."
        );
        assert_eq!(
            turn_user_message("line one\nline two", 2),
            "line one\nline two"
        );
    }
}
