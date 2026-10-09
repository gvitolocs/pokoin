//! Poko website chat core — a port of `poko-chat.js` and `_poko_reply_cards.js`.
//!
//! The website Poko chat is a BFF: Hermes (the Poko service) produces the reply,
//! and this crate owns the attachment context, the reply-card resolution against
//! the catalog, the per-IP comfort limit and the `poko_conversations/{uid}/events`
//! transcript.
//!
//! Everything in this module is pure or takes an injected client, so the
//! prompt-building and card-resolution rules are unit-tested without a network.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value as Json};

use crate::sql::{row_text, MarketplaceDb, SqlParam};

pub const EVENT_PAGE: i64 = 20;
pub const MAX_REPLY_CARDS: usize = 6;
pub const MAX_ATTACHED_CARDS: usize = 12;
pub const MAX_ATTACHED_IMAGES: usize = 8;
pub const PHOTO_SCORE_FLOOR: f64 = 0.42;

/// The hidden marker line Poko is asked to end its reply with.
pub const REPLY_CARDS_DIRECTIVE: &str = "When your reply names specific Pokémon cards, end it with one extra line exactly like [[cards: Card Name | Card Name]] (at most 6, exact card names or Pokoin cardIds from the tools). The website hides that line and shows those cards as images. Omit it when you name no card.";

pub const HERMES_UNAVAILABLE: &str = "I don’t know the answer yet, but I’m always improving ✨ Ask me another way, or try a cute card question while my tiny brain levels up.";
pub const HERMES_UNAVAILABLE_ERROR: &str =
    "Poko could not reach the assistant in time. Try again in a moment.";

/// `cleanText(value, max)`.
pub fn clean_text(value: &str, max: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// `String(row?.key || '')` — numbers and booleans stringify like JavaScript.
fn field_str(row: &Json, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| row.get(*key))
        .map(|value| match value {
            Json::String(text) => text.clone(),
            Json::Number(number) => number.to_string(),
            Json::Bool(flag) => flag.to_string(),
            _ => String::new(),
        })
        .unwrap_or_default()
}

/// `cleanCards(raw)` — the attached-card shape the chat renders.
pub fn clean_cards(raw: Option<&Json>) -> Vec<Json> {
    let Some(list) = raw.and_then(Json::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in list.iter().take(MAX_ATTACHED_CARDS) {
        let card_id = clean_text(&field_str(row, &["cardId", "id"]), 40);
        let path = {
            let raw_path = clean_text(&field_str(row, &["path", "canonicalPath", "href"]), 200);
            if raw_path.is_empty() && !card_id.is_empty() {
                format!("/marketplace/en/cards/{card_id}")
            } else {
                raw_path
            }
        };
        let name = clean_text(&field_str(row, &["cardName", "name"]), 120);
        if card_id.is_empty() && name.is_empty() {
            continue;
        }
        let price = row
            .get("pricePkn")
            .or_else(|| row.get("minAsk"))
            .and_then(Json::as_f64)
            .unwrap_or(0.0);
        out.push(json!({
            "kind": "card",
            "cardId": card_id,
            "name": name,
            "cardName": name,
            "setName": clean_text(&field_str(row, &["setName", "set"]), 120),
            "condition": clean_text(&field_str(row, &["condition"]), 20),
            "language": clean_text(&field_str(row, &["language"]), 12),
            "canonicalPath": path,
            "path": path,
            "imageUrl": clean_text(&field_str(row, &["imageUrl", "cardImageUrl"]), 500),
            "pricePkn": num(price),
        }));
    }
    out
}

/// `cleanImages(raw)` — http(s) only, at most eight.
pub fn clean_images(raw: Option<&Json>) -> Vec<String> {
    raw.and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .map(|value| clean_text(value.as_str().unwrap_or(""), 500))
                .filter(|url| {
                    let lower = url.to_ascii_lowercase();
                    lower.starts_with("http://") || lower.starts_with("https://")
                })
                .take(MAX_ATTACHED_IMAGES)
                .collect()
        })
        .unwrap_or_default()
}

/// `cleanPageContext(raw, cards, images)`.
pub fn clean_page_context(
    raw: Option<&Json>,
    cards: &[Json],
    images: &[String],
) -> Json {
    let empty = Json::Object(Map::new());
    let src = raw.filter(|value| value.is_object()).unwrap_or(&empty);
    let desk = cards.first().cloned().unwrap_or_else(|| json!({}));
    let watchlist = crate::domain::personal_context::normalize_card_ids(
        src.get("watchlistIds")
            .or_else(|| src.get("watchlist"))
            .and_then(Json::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        crate::domain::personal_context::WATCH_LIMIT,
    );
    let cart = crate::domain::personal_context::clean_cart_items(src.get("cart"));
    let channel = {
        let raw_channel = clean_text(&field_str(src, &["channel"]), 40);
        if raw_channel.is_empty() {
            "website-messages".to_string()
        } else {
            raw_channel
        }
    };
    let desk_card_id = {
        let raw = clean_text(&field_str(src, &["deskCardId"]), 40);
        if raw.is_empty() {
            field_str(&desk, &["cardId"])
        } else {
            raw
        }
    };
    let desk_card_name = {
        let raw = clean_text(&field_str(src, &["deskCardName"]), 120);
        if raw.is_empty() {
            field_str(&desk, &["name"])
        } else {
            raw
        }
    };
    let desk_set_name = {
        let raw = clean_text(&field_str(src, &["deskSetName"]), 120);
        if raw.is_empty() {
            field_str(&desk, &["setName"])
        } else {
            raw
        }
    };
    json!({
        "channel": channel,
        "path": clean_text(&field_str(src, &["path"]), 300),
        "deskCardId": desk_card_id,
        "deskCardName": desk_card_name,
        "deskSetName": desk_set_name,
        "watchlistIds": watchlist.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
        "cart": cart,
        "attachedCards": cards,
        "attachedImages": images,
    })
}

/// `cardsContext(cards)`.
pub fn cards_context(cards: &[Json]) -> String {
    if cards.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = cards
        .iter()
        .enumerate()
        .map(|(index, card)| {
            let name = field_str(card, &["name"]);
            let bits: Vec<String> = vec![
                format!("#{}", index + 1),
                if name.is_empty() {
                    "card".to_string()
                } else {
                    name
                },
                {
                    let set = field_str(card, &["setName"]);
                    if set.is_empty() {
                        String::new()
                    } else {
                        format!("({set})")
                    }
                },
                {
                    let id = field_str(card, &["cardId"]);
                    if id.is_empty() {
                        String::new()
                    } else {
                        format!("id={id}")
                    }
                },
                field_str(card, &["condition"]),
                field_str(card, &["language"]),
            ];
            format!(
                "- {}",
                bits.into_iter()
                    .filter(|bit| !bit.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        })
        .collect();
    format!("Attached cards:\n{}", lines.join("\n"))
}

/// `imagesContext(images)`.
pub fn images_context(images: &[String]) -> String {
    if images.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = images
        .iter()
        .enumerate()
        .map(|(index, url)| format!("- #{} {url}", index + 1))
        .collect();
    format!(
        "Attached photos ({}):\n{}",
        images.len(),
        lines.join("\n")
    )
}

/// `isUserPhotoUrl` — chat photos live on our R2 bucket; nothing else is fetched.
pub fn is_user_photo_url(value: &str) -> bool {
    let raw = value.trim();
    let Some(rest) = raw.strip_prefix("https://") else {
        return false;
    };
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let host = authority
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    host.ends_with(".r2.dev") && path.starts_with("/user-photos/")
}

/// `hitToPhotoCard(hit)`.
pub fn hit_to_photo_card(hit: &Json) -> Option<Json> {
    if !hit.is_object() {
        return None;
    }
    let score = hit.get("score").and_then(Json::as_f64)?;
    if !score.is_finite() || score < PHOTO_SCORE_FLOOR {
        return None;
    }
    let name = clean_text(&field_str(hit, &["name"]), 120);
    if name.is_empty() {
        return None;
    }
    let card_id = clean_text(&field_str(hit, &["public_id", "publicId"]), 40);
    let path = if card_id.is_empty() {
        String::new()
    } else {
        format!("/marketplace/en/cards/{card_id}")
    };
    Some(json!({
        "kind": "card",
        "cardId": card_id,
        "name": name,
        "cardName": name,
        "setName": clean_text(&field_str(hit, &["set", "set_name", "expansion"]), 120),
        "number": clean_text(&field_str(hit, &["collector_number", "number"]), 20),
        "score": num((score * 1000.0).round() / 1000.0),
        "path": path,
        "canonicalPath": path,
    }))
}

fn photo_card_key(card: &Json) -> String {
    let card_id = field_str(card, &["cardId"]);
    if !card_id.is_empty() {
        return card_id;
    }
    format!(
        "{}|{}|{}",
        field_str(card, &["name"]),
        field_str(card, &["setName"]),
        field_str(card, &["number"])
    )
}

/// `photoCardsFromIdentify(payload)`. `uniqueHits` is the multi-card result; a
/// lone `top1` is the single-card lookup.
pub fn photo_cards_from_identify(payload: &Json) -> Vec<Json> {
    let unique: Vec<&Json> = payload
        .get("uniqueHits")
        .and_then(Json::as_array)
        .map(|rows| rows.iter().collect())
        .unwrap_or_default();
    let boxes: Vec<&Json> = payload
        .get("cards")
        .and_then(Json::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.get("top1").filter(|value| !value.is_null()))
                .collect()
        })
        .unwrap_or_default();
    let rows = if unique.is_empty() { boxes } else { unique };

    let mut out: Vec<Json> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for hit in rows {
        let Some(card) = hit_to_photo_card(hit) else {
            continue;
        };
        let key = photo_card_key(&card);
        if !seen.insert(key) {
            continue;
        }
        out.push(card);
        if out.len() >= 8 {
            break;
        }
    }
    out
}

/// `photoCardLine(card, index)`.
pub fn photo_card_line(card: &Json, index: usize) -> String {
    let score = card.get("score").and_then(Json::as_f64);
    let bits: Vec<String> = vec![
        format!("#{}", index + 1),
        field_str(card, &["name"]),
        {
            let set = field_str(card, &["setName"]);
            if set.is_empty() {
                String::new()
            } else {
                format!("({set})")
            }
        },
        field_str(card, &["number"]),
        {
            let id = field_str(card, &["cardId"]);
            if id.is_empty() {
                String::new()
            } else {
                format!("cardId={id}")
            }
        },
        match score {
            Some(score) if score.is_finite() => format!("score={score}"),
            _ => String::new(),
        },
    ];
    bits.into_iter()
        .filter(|bit| !bit.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `photoSearchContext(photoCards)`.
pub fn photo_search_context(photo_cards: &[Json]) -> String {
    if photo_cards.is_empty() {
        return String::new();
    }
    let mut lines = vec![format!(
        "Multi-card search of the attached photo ({} printings; not a single-card lookup):",
        photo_cards.len()
    )];
    for (index, card) in photo_cards.iter().enumerate() {
        lines.push(format!("- {}", photo_card_line(card, index)));
    }
    lines.join("\n")
}

/// `marketFirstDirective(cards, pageContext, photoCards)`.
pub fn market_first_directive(
    cards: &[Json],
    page_context: &Json,
    photo_cards: &[Json],
) -> String {
    if !photo_cards.is_empty() {
        let mut lines = vec![
            "Operator directive for this turn:".to_string(),
            "- The attached photo was identified with multi-card search (every detected card), not a single-card lookup.".to_string(),
            "- Identified printings, in reading order:".to_string(),
        ];
        for (index, card) in photo_cards.iter().enumerate() {
            lines.push(format!("- {}", photo_card_line(card, index)));
        }
        lines.push("- Quote Pokoin analytics for every identified printing via market_query multipath including card_quote (use each cardId). Do not answer as if the photo contains only one card.".to_string());
        lines.push("- card_quote.priceSources includes dated CardTrader lowest listed asks in PKN and separate TCGplayer aggregate market quotes in USD. Cite the source and observation date; asks are not sales, aggregate quotes are not condition-specific, and zero sold comps does not erase price analytics. Never convert USD to PKN implicitly.".to_string());
        lines.push("- For attacks, abilities, HP, or printed rules, include card_ocr in that card's multipath (western leftover OCR; approximate).".to_string());
        lines.push("- A weak score is a guess: say so. Never invent a card that is not in this list.".to_string());
        lines.push("- The open desk card is separate from the photo. Mention it only if the user also asked about the page.".to_string());
        return lines.join("\n");
    }
    let card = cards.first();
    let id = {
        let from_card = card.map(|card| field_str(card, &["cardId"])).unwrap_or_default();
        if from_card.is_empty() {
            field_str(page_context, &["deskCardId"])
        } else {
            from_card
        }
    };
    let name = {
        let from_card = card.map(|card| field_str(card, &["name"])).unwrap_or_default();
        if !from_card.is_empty() {
            from_card
        } else {
            let desk = field_str(page_context, &["deskCardName"]);
            if desk.is_empty() {
                "this card".to_string()
            } else {
                desk
            }
        }
    };
    if id.is_empty() && name == "this card" {
        return String::new();
    }
    let set = {
        let from_card = card.map(|card| field_str(card, &["setName"])).unwrap_or_default();
        if !from_card.is_empty() {
            from_card
        } else {
            field_str(page_context, &["deskSetName"])
        }
    };
    let bits: Vec<String> = vec![
        name,
        if set.is_empty() {
            String::new()
        } else {
            format!("({set})")
        },
        if id.is_empty() {
            String::new()
        } else {
            format!("cardId={id}")
        },
    ];
    let bits = bits
        .into_iter()
        .filter(|bit| !bit.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    [
        "Operator directive for this turn:".to_string(),
        format!("- The user is on the Pokoin marketplace looking at {bits}."),
        "- First purpose: Pokoin card analytics (sold median, asks, liquidity) via market_query multipath including card_quote (use the given cardId when present).".to_string(),
        "- card_quote.priceSources includes dated CardTrader lowest listed asks in PKN and separate TCGplayer aggregate market quotes in USD. Cite the source and observation date; asks are not sales, aggregate quotes are not condition-specific, and zero sold comps does not erase price analytics. Never convert USD to PKN implicitly.".to_string(),
        "- For attacks, abilities, HP, or printed rules on this card, include card_ocr in the same multipath with the same cardId (western leftover OCR; approximate).".to_string(),
        "- Never invent a different card name, set, HP, or attack. If tools fail, say you do not know yet.".to_string(),
        "- Lore/flavor only after quoting site numbers, and only if it matches the same cardId.".to_string(),
    ]
    .join("\n")
}

/// `resolveHermesChatUrl(env)` — base …/api/poko + /chat.
pub fn resolve_hermes_chat_url(chat_url: Option<&str>, service_url: Option<&str>) -> String {
    let raw = chat_url
        .or(service_url)
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .unwrap_or_default();
    if raw.is_empty() {
        return String::new();
    }
    if raw.to_ascii_lowercase().ends_with("/chat") {
        return raw;
    }
    format!("{raw}/chat")
}

/// `hermesToken(env)`.
pub fn hermes_token(poko_api_token: Option<&str>, service_token: Option<&str>) -> String {
    poko_api_token
        .or(service_token)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
}

/// `firestoreTimeIso(value)` for a plain-JSON field.
pub fn firestore_time_iso(value: Option<&Json>) -> Option<String> {
    match value? {
        Json::Null => None,
        Json::String(text) => {
            if text.is_empty() {
                None
            } else {
                Some(text.clone())
            }
        }
        Json::Number(number) => number
            .as_i64()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        Json::Object(fields) => {
            let seconds = fields
                .get("_seconds")
                .or_else(|| fields.get("seconds"))
                .and_then(Json::as_i64)?;
            chrono::DateTime::from_timestamp(seconds, 0)
                .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        }
        _ => None,
    }
}

/// `serializeEvent(doc)`.
pub fn serialize_event(document: &crate::firestore::Document) -> Json {
    let plain = document.to_plain_json();
    let role = if field_str(&plain, &["role"]) == "assistant" {
        "assistant"
    } else {
        "user"
    };
    let cards = plain
        .get("cards")
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    let images = plain
        .get("images")
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    json!({
        "id": document.id(),
        "role": role,
        "mine": role == "user",
        "text": field_str(&plain, &["text"]),
        "cards": cards,
        "listings": cards,
        "images": images,
        "source": field_str(&plain, &["source"]),
        "turnId": field_str(&plain, &["turnId"]),
        "clientTurnId": field_str(&plain, &["clientTurnId"]),
        "createdAt": firestore_time_iso(plain.get("createdAt")),
    })
}

/// `cleanClientTurnId(value)`.
pub fn clean_client_turn_id(value: &str) -> String {
    let text = clean_text(value, 80);
    let valid = (1..=80).contains(&text.len())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if valid {
        text
    } else {
        String::new()
    }
}

/// `withoutOpenCards(replyCards, {pageContext, cards, byName})` — never echo the
/// card the user already has open or attached.
pub fn without_open_cards(
    reply_cards: &[Json],
    page_context: &Json,
    cards: &[Json],
    by_name: bool,
) -> Vec<Json> {
    let mut ids: HashSet<String> = HashSet::new();
    if let Some(desk) = page_context.get("deskCardId").and_then(Json::as_str) {
        if !desk.is_empty() {
            ids.insert(desk.to_string());
        }
    }
    for card in cards {
        let id = field_str(card, &["cardId"]);
        if !id.is_empty() {
            ids.insert(id);
        }
    }
    let mut names: HashSet<String> = HashSet::new();
    if let Some(desk) = page_context.get("deskCardName").and_then(Json::as_str) {
        if !desk.is_empty() {
            names.insert(desk.to_ascii_lowercase());
        }
    }
    for card in cards {
        let name = field_str(card, &["name"]);
        if !name.is_empty() {
            names.insert(name.to_ascii_lowercase());
        }
    }
    reply_cards
        .iter()
        .filter(|card| {
            let id = field_str(card, &["cardId"]);
            if !id.is_empty() && ids.contains(&id) {
                return false;
            }
            if by_name {
                let name = {
                    let primary = field_str(card, &["name"]);
                    if primary.is_empty() {
                        field_str(card, &["cardName"])
                    } else {
                        primary
                    }
                };
                if !name.is_empty() && names.contains(&name.to_ascii_lowercase()) {
                    return false;
                }
            }
            true
        })
        .cloned()
        .collect()
}

/// A JS number renders without a decimal point when integral.
pub fn num(value: f64) -> Json {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

// ---------------------------------------------------------------------------
// Reply cards (`_poko_reply_cards.js`)
// ---------------------------------------------------------------------------

fn marker_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\[\[\s*cards?\s*:\s*([^\]]*)\]\]").expect("marker regex")
    })
}

fn bullet_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*(?:[-*•]|\d+[.)])\s+(.+)$").expect("bullet regex"))
}

fn inline_bullet_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:^|[\s:])[-•]\s+([^—–(\n]{3,60}?)\s+(?:[—–]|\()")
            .expect("inline bullet regex")
    })
}

fn bold_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\*\*([^*]{3,60})\*\*").expect("bold regex"))
}

/// `plausibleName(raw)` — a name worth looking up: short, has letters, not a
/// sentence.
pub fn plausible_name(raw: &str) -> String {
    let cleaned = clean_text(raw, 80);
    let leading = Regex::new(r"^[-*•\d.)\s]+").expect("leading regex");
    let decorations = Regex::new(r#"[*_`"“”]+"#).expect("decorations regex");
    let trailing = Regex::new(r"[:,.;!?]+$").expect("trailing regex");
    let name = trailing
        .replace_all(
            &decorations.replace_all(&leading.replace(&cleaned, ""), ""),
            "",
        )
        .trim()
        .to_string();
    if name.chars().count() < 3 || name.chars().count() > 60 {
        return String::new();
    }
    if !name.chars().any(|character| character.is_alphabetic()) {
        return String::new();
    }
    if name.split(' ').count() > 7 {
        return String::new();
    }
    name
}

fn uniq(values: Vec<String>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let key = value.to_ascii_lowercase();
        if value.is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(value);
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplyCardMentions {
    /// The display text with the marker line removed.
    pub text: String,
    pub ids: Vec<String>,
    pub names: Vec<String>,
    pub tagged: bool,
}

/// `extractReplyCardMentions(reply)`.
pub fn extract_reply_card_mentions(reply: &str) -> ReplyCardMentions {
    let mut marked: Vec<String> = Vec::new();
    let stripped = marker_regex()
        .replace_all(reply, |captures: &regex::Captures| {
            if let Some(list) = captures.get(1) {
                // The closure cannot borrow `marked` mutably through `replace_all`,
                // so the parts are collected by a second pass below.
                let _ = list;
            }
            ""
        })
        .to_string();
    // Collect the marker list separately (the regex is cheap to re-run).
    for captures in marker_regex().captures_iter(reply) {
        if let Some(list) = captures.get(1) {
            for part in list.as_str().split(['|', ',']) {
                marked.push(clean_text(part, 80));
            }
        }
    }
    let collapsed = {
        let triple = Regex::new(r"\n{3,}").expect("newline regex");
        triple.replace_all(&stripped, "\n\n").trim().to_string()
    };

    let mut listed: Vec<String> = Vec::new();
    for line in collapsed.split('\n') {
        let Some(captures) = bullet_regex().captures(line) else {
            continue;
        };
        let Some(body) = captures.get(1) else { continue };
        // "- Jessie & James (Team Rocket) — le due icone…" -> "Jessie & James"
        let splitter = Regex::new(r"\s[—–-]\s|\s\(|:\s").expect("split regex");
        let head = splitter.split(body.as_str()).next().unwrap_or("");
        listed.push(head.to_string());
    }
    for captures in inline_bullet_regex().captures_iter(&collapsed) {
        if let Some(name) = captures.get(1) {
            listed.push(name.as_str().to_string());
        }
    }
    for captures in bold_regex().captures_iter(&collapsed) {
        if let Some(name) = captures.get(1) {
            listed.push(name.as_str().to_string());
        }
    }

    let mut ids: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for raw in &marked {
        if is_card_id(raw) {
            ids.push(raw.clone());
        } else {
            let name = plausible_name(raw);
            if !name.is_empty() {
                names.push(name);
            }
        }
    }
    let mut all_names = names;
    all_names.extend(listed.iter().map(|raw| plausible_name(raw)).filter(|n| !n.is_empty()));
    ReplyCardMentions {
        text: collapsed,
        ids: uniq(ids),
        tagged: !marked.is_empty(),
        names: uniq(all_names),
    }
}

fn is_card_id(value: &str) -> bool {
    (3..=12).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// `cardRow(row)`.
pub fn card_row(row: &Json) -> Json {
    let card_id = {
        let raw = row
            .get("card_id")
            .or_else(|| row.get("cardId"))
            .map(|value| match value {
                Json::String(text) => text.clone(),
                Json::Number(number) => number.to_string(),
                _ => String::new(),
            })
            .unwrap_or_default();
        raw
    };
    let name = row_text(row, "name");
    json!({
        "cardId": card_id,
        "id": card_id,
        "cardName": name,
        "name": name,
        "setName": row_text(row, "set_name"),
        "source": "poko",
    })
}

/// `attachReplyCards(reply, {query})` — resolve the cards Poko names against the
/// catalog. Nothing is invented; unresolved names are dropped.
pub async fn attach_reply_cards(
    db: &MarketplaceDb,
    reply: &str,
    hermes_cards: &[Json],
) -> (String, Vec<Json>) {
    let mentions = extract_reply_card_mentions(reply);
    let mut structured_ids: Vec<String> = hermes_cards
        .iter()
        .map(|row| match row {
            Json::Object(_) => {
                let id = field_str(row, &["cardId", "id"]);
                clean_text(&id, 20)
            }
            other => clean_text(other.as_str().unwrap_or(""), 20),
        })
        .filter(|id| is_card_id(id))
        .collect();
    structured_ids.extend(mentions.ids.clone());

    let mut cards: Vec<Json> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let push = |card: Json, cards: &mut Vec<Json>, seen: &mut HashSet<String>| {
        let id = field_str(&card, &["cardId"]);
        if id.is_empty() || seen.contains(&id) || cards.len() >= MAX_REPLY_CARDS {
            return;
        }
        seen.insert(id);
        cards.push(card);
    };

    let ids = uniq(structured_ids);
    if !ids.is_empty() {
        match resolve_by_ids(db, &ids).await {
            Ok(rows) => {
                for row in rows {
                    push(row, &mut cards, &mut seen);
                }
            }
            Err(error) => tracing::warn!(%error, "poko reply cards: id lookup failed"),
        }
    }
    if cards.len() < MAX_REPLY_CARDS && !mentions.names.is_empty() {
        let names: Vec<String> = mentions.names.iter().take(12).cloned().collect();
        match resolve_by_names(db, &names).await {
            Ok(rows) => {
                for row in rows {
                    push(row, &mut cards, &mut seen);
                }
            }
            Err(error) => tracing::warn!(%error, "poko reply cards: name lookup failed"),
        }
    }
    (mentions.text, cards)
}

/// `resolveByIds(ids, query)`.
pub async fn resolve_by_ids(db: &MarketplaceDb, ids: &[String]) -> crate::error::Result<Vec<Json>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let wanted: Vec<String> = ids.iter().take(MAX_REPLY_CARDS).cloned().collect();
    let rows = db
        .query_json(
            "select s.card_id, s.name, s.set_name from marketplace_search_candidates s \
             where s.card_id::text = any($1::text[]) and s.item_kind <> 'product'",
            &[SqlParam::TextArray(wanted.clone())],
        )
        .await?;
    let mut by_id: std::collections::HashMap<String, Json> = std::collections::HashMap::new();
    for row in rows {
        let id = {
            let raw = row.get("card_id").cloned().unwrap_or(Json::Null);
            match raw {
                Json::String(text) => text,
                Json::Number(number) => number.to_string(),
                _ => String::new(),
            }
        };
        by_id.insert(id, row);
    }
    Ok(wanted
        .iter()
        .filter_map(|id| by_id.get(id).map(card_row))
        .collect())
}

/// `resolveByNames(names, query)` — exact case-insensitive names only, the
/// most-traded printing per name.
pub async fn resolve_by_names(
    db: &MarketplaceDb,
    names: &[String],
) -> crate::error::Result<Vec<Json>> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let wanted: Vec<String> = names.iter().map(|name| name.to_ascii_lowercase()).collect();
    let rows = db
        .query_json(
            "select s.card_id, s.name, s.set_name, s.search_weight \
             from marketplace_search_candidates s \
             where lower(s.name) = any($1::text[]) and s.item_kind <> 'product' \
             order by s.search_weight desc nulls last, s.card_id",
            &[SqlParam::TextArray(wanted.clone())],
        )
        .await?;
    let mut best: std::collections::HashMap<String, Json> = std::collections::HashMap::new();
    for row in rows {
        let key = row_text(&row, "name").to_ascii_lowercase();
        best.entry(key).or_insert(row);
    }
    Ok(wanted
        .iter()
        .filter_map(|key| best.get(key).map(card_row))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attached_cards_are_cleaned_and_bounded() {
        let raw = json!([
            { "cardId": 12345, "name": "Pikachu", "setName": "Base",
              "condition": "NM", "language": "EN", "pricePkn": 12.5 },
            { "id": "99", "cardName": "Eevee" },
            { "name": "" },
            { "cardId": "" }
        ]);
        let cards = clean_cards(Some(&raw));
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0]["cardId"], json!("12345"));
        assert_eq!(cards[0]["name"], json!("Pikachu"));
        assert_eq!(cards[0]["cardName"], json!("Pikachu"));
        assert_eq!(cards[0]["path"], json!("/marketplace/en/cards/12345"));
        assert_eq!(cards[0]["pricePkn"], json!(12.5));
        assert_eq!(cards[1]["cardId"], json!("99"));
        // A card with neither id nor name is dropped.
        assert!(clean_cards(None).is_empty());
        // The 12-card cap.
        let many = Json::Array(
            (0..20)
                .map(|index| json!({ "cardId": index + 1, "name": "x" }))
                .collect(),
        );
        assert_eq!(clean_cards(Some(&many)).len(), MAX_ATTACHED_CARDS);
    }

    #[test]
    fn attached_images_are_http_only_and_bounded() {
        let raw = json!([
            "https://a.r2.dev/user-photos/chat/u/1.jpg",
            "http://insecure.example/x.jpg",
            "ftp://nope",
            "not a url"
        ]);
        let images = clean_images(Some(&raw));
        assert_eq!(images.len(), 2);
        assert!(images[0].starts_with("https://a.r2.dev/"));
        let many = Json::Array((0..20).map(|i| json!(format!("https://x/{i}.jpg"))).collect());
        assert_eq!(clean_images(Some(&many)).len(), MAX_ATTACHED_IMAGES);
        assert!(clean_images(None).is_empty());
    }

    #[test]
    fn page_context_falls_back_to_the_attached_desk_card() {
        let cards = vec![json!({
            "cardId": "7", "name": "Pikachu", "setName": "Base"
        })];
        let context = clean_page_context(Some(&json!({})), &cards, &[]);
        assert_eq!(context["channel"], json!("website-messages"));
        assert_eq!(context["deskCardId"], json!("7"));
        assert_eq!(context["deskCardName"], json!("Pikachu"));
        assert_eq!(context["deskSetName"], json!("Base"));
        assert_eq!(context["attachedCards"].as_array().unwrap().len(), 1);

        // An explicit page context wins over the attached card.
        let context = clean_page_context(
            Some(&json!({
                "channel": " discord ", "path": "/marketplace",
                "deskCardId": 9, "deskCardName": "Eevee", "deskSetName": "Jungle",
                "watchlist": ["1", "1", "2", "x"], "cart": [{ "cardId": 3, "qty": 1 }]
            })),
            &cards,
            &[],
        );
        assert_eq!(context["channel"], json!("discord"));
        assert_eq!(context["deskCardId"], json!("9"));
        assert_eq!(context["deskCardName"], json!("Eevee"));
        assert_eq!(context["watchlistIds"], json!(["1", "2"]));
        assert_eq!(context["cart"].as_array().unwrap().len(), 1);
        // A non-object page context is treated as empty.
        let context = clean_page_context(Some(&json!("nope")), &[], &[]);
        assert_eq!(context["channel"], json!("website-messages"));
    }

    #[test]
    fn contexts_render_the_prompt_blocks() {
        let cards = clean_cards(Some(&json!([
            { "cardId": "12345", "name": "Pikachu", "setName": "Base", "condition": "NM", "language": "EN" }
        ])));
        let rendered = cards_context(&cards);
        assert!(rendered.starts_with("Attached cards:\n"));
        assert!(rendered.contains("- #1 Pikachu (Base) id=12345 NM EN"));
        assert_eq!(cards_context(&[]), "");

        let images = vec!["https://a.r2.dev/user-photos/chat/u/1.jpg".to_string()];
        let rendered = images_context(&images);
        assert!(rendered.starts_with("Attached photos (1):\n"));
        assert!(rendered.contains("- #1 https://a.r2.dev/user-photos/chat/u/1.jpg"));
        assert_eq!(images_context(&[]), "");
    }

    #[test]
    fn only_our_r2_user_photos_are_fetched() {
        assert!(is_user_photo_url(
            "https://abc.r2.dev/user-photos/chat/uid/1.jpg"
        ));
        assert!(!is_user_photo_url(
            "https://abc.r2.dev/other/1.jpg"
        ));
        assert!(!is_user_photo_url("http://abc.r2.dev/user-photos/1.jpg"));
        assert!(!is_user_photo_url(
            "https://evil.com/user-photos/chat/uid/1.jpg"
        ));
        assert!(!is_user_photo_url("not a url"));
        assert!(!is_user_photo_url(""));
    }

    #[test]
    fn photo_hits_need_a_name_and_a_score_floor() {
        let hit = json!({
            "score": 0.87, "name": "Pikachu ex", "public_id": "12345",
            "set": "Base", "collector_number": "1/102"
        });
        let card = hit_to_photo_card(&hit).unwrap();
        assert_eq!(card["cardId"], json!("12345"));
        assert_eq!(card["name"], json!("Pikachu ex"));
        assert_eq!(card["score"], json!(0.87));
        assert_eq!(card["path"], json!("/marketplace/en/cards/12345"));

        // Below the floor, or no name, or no score: not a card.
        assert!(hit_to_photo_card(&json!({ "score": 0.4, "name": "x" })).is_none());
        assert!(hit_to_photo_card(&json!({ "score": 0.9, "name": "" })).is_none());
        assert!(hit_to_photo_card(&json!({ "name": "x" })).is_none());
        assert!(hit_to_photo_card(&json!("nope")).is_none());
    }

    #[test]
    fn identify_payloads_prefer_unique_hits_and_dedupe() {
        let payload = json!({
            "uniqueHits": [
                { "score": 0.9, "name": "Pikachu", "public_id": "1" },
                { "score": 0.8, "name": "Pikachu", "public_id": "1" },
                { "score": 0.5, "name": "Eevee", "set_name": "Jungle", "number": "5" }
            ],
            "cards": [ { "top1": { "score": 0.99, "name": "Ignored", "public_id": "9" } } ]
        });
        let cards = photo_cards_from_identify(&payload);
        assert_eq!(cards.len(), 2, "uniqueHits win and duplicates collapse");
        assert_eq!(cards[0]["cardId"], json!("1"));
        assert_eq!(cards[1]["name"], json!("Eevee"));

        // Without uniqueHits the per-box top1 rows are used.
        let payload = json!({
            "cards": [ { "top1": { "score": 0.7, "name": "Snorlax", "public_id": "3" } } ]
        });
        let cards = photo_cards_from_identify(&payload);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["name"], json!("Snorlax"));
        // An empty payload yields nothing.
        assert!(photo_cards_from_identify(&json!({})).is_empty());
    }

    #[test]
    fn photo_lines_and_search_context_render() {
        let card = json!({
            "cardId": "1", "name": "Pikachu", "setName": "Base",
            "number": "58/102", "score": 0.87
        });
        assert_eq!(
            photo_card_line(&card, 0),
            "#1 Pikachu (Base) 58/102 cardId=1 score=0.87"
        );
        let context = photo_search_context(std::slice::from_ref(&card));
        assert!(context.starts_with("Multi-card search of the attached photo (1 printings"));
        assert!(context.contains("- #1 Pikachu (Base) 58/102 cardId=1 score=0.87"));
        assert_eq!(photo_search_context(&[]), "");
    }

    #[test]
    fn the_market_first_directive_prefers_the_photo_branch() {
        let photo_cards = vec![json!({ "cardId": "1", "name": "Pikachu", "score": 0.9 })];
        let directive = market_first_directive(&[], &json!({}), &photo_cards);
        assert!(directive.contains("multi-card search (every detected card)"));
        assert!(directive.contains("Identified printings, in reading order:"));
        assert!(directive.contains("Do not answer as if the photo contains only one card"));

        let cards = vec![json!({ "cardId": "7", "name": "Eevee", "setName": "Jungle" })];
        let directive = market_first_directive(&cards, &json!({}), &[]);
        assert!(directive.contains("looking at Eevee (Jungle) cardId=7"));
        assert!(directive.contains("Never invent a different card name"));

        // The desk card alone is enough.
        let directive =
            market_first_directive(&[], &json!({ "deskCardId": "9", "deskCardName": "Mew" }), &[]);
        assert!(directive.contains("looking at Mew cardId=9"));

        // Nothing to direct at all.
        assert_eq!(market_first_directive(&[], &json!({}), &[]), "");
    }

    #[test]
    fn hermes_url_and_token_resolution() {
        assert_eq!(
            resolve_hermes_chat_url(Some("http://127.0.0.1:18150/api/poko"), None),
            "http://127.0.0.1:18150/api/poko/chat"
        );
        assert_eq!(
            resolve_hermes_chat_url(Some("http://x/api/poko/chat"), None),
            "http://x/api/poko/chat"
        );
        assert_eq!(resolve_hermes_chat_url(None, Some("  http://y/base/  ")), "http://y/base/chat");
        assert_eq!(resolve_hermes_chat_url(None, None), "");
        assert_eq!(hermes_token(Some(" a "), Some("b")), "a");
        assert_eq!(hermes_token(None, Some(" b ")), "b");
        assert_eq!(hermes_token(None, None), "");
    }

    #[test]
    fn client_turn_ids_are_bounded_slugs() {
        assert_eq!(clean_client_turn_id("abc-123_XY"), "abc-123_XY");
        assert_eq!(clean_client_turn_id("has space"), "");
        assert_eq!(clean_client_turn_id(""), "");
        // cleanText truncates to 80 first, so the slug rule then accepts it.
        assert_eq!(clean_client_turn_id(&"a".repeat(81)).len(), 80);
    }

    #[test]
    fn reply_cards_never_echo_the_open_or_attached_card() {
        let page_context = json!({ "deskCardId": "7", "deskCardName": "Pikachu" });
        let cards = vec![json!({ "cardId": "8", "name": "Eevee" })];
        let reply_cards = vec![
            json!({ "cardId": "7", "name": "Pikachu" }),
            json!({ "cardId": "8", "name": "Eevee" }),
            json!({ "cardId": "9", "name": "Mew" }),
        ];
        let kept = without_open_cards(&reply_cards, &page_context, &cards, false);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["cardId"], json!("9"));

        // Name matching only applies to by-name resolutions.
        let reply_cards = vec![json!({ "cardId": "77", "name": "Pikachu" })];
        assert_eq!(
            without_open_cards(&reply_cards, &page_context, &[], false).len(),
            1
        );
        assert_eq!(
            without_open_cards(&reply_cards, &page_context, &[], true).len(),
            0
        );
        // cardName is used when name is absent.
        let reply_cards = vec![json!({ "cardId": "78", "cardName": "Eevee" })];
        let cards = vec![json!({ "cardId": "8", "name": "Eevee" })];
        assert!(without_open_cards(&reply_cards, &json!({}), &cards, true).is_empty());
    }

    // ---- reply cards ----

    #[test]
    fn plausible_names_reject_sentences_and_non_letters() {
        assert_eq!(plausible_name("- Pikachu"), "Pikachu");
        assert_eq!(plausible_name("**Eevee**"), "Eevee");
        assert_eq!(plausible_name("\"Mew\""), "Mew");
        assert_eq!(plausible_name("Pikachu:"), "Pikachu");
        assert_eq!(plausible_name("ab"), "");
        assert_eq!(plausible_name("123456"), "");
        assert_eq!(plausible_name("one two three four five six seven eight"), "");
        assert_eq!(plausible_name(""), "");
    }

    #[test]
    fn the_marker_line_is_stripped_and_its_names_win() {
        let reply = "Here you go!\n\n[[cards: Pikachu | 12345]]\n\nThat is it.";
        let mentions = extract_reply_card_mentions(reply);
        assert!(mentions.tagged);
        assert_eq!(mentions.ids, vec!["12345"]);
        assert_eq!(mentions.names, vec!["Pikachu"]);
        assert!(!mentions.text.contains("[[cards"));
        assert!(mentions.text.contains("Here you go!"));
        assert!(mentions.text.contains("That is it."));

        // No marker: not tagged, and nothing extracted.
        let mentions = extract_reply_card_mentions("Just a sentence.");
        assert!(!mentions.tagged);
        assert!(mentions.ids.is_empty());
        assert!(mentions.names.is_empty());
    }

    #[test]
    fn names_are_collected_from_bullets_bold_and_markers() {
        let reply = [
            "Ecco alcune carte:",
            "- Jessie & James (Team Rocket) — le due icone",
            "1. Raikou ex — fulmine",
            "**Snorlax** is great",
            "* Mew",
        ]
        .join("\n");
        let mentions = extract_reply_card_mentions(&reply);
        for expected in ["Jessie & James", "Raikou ex", "Snorlax", "Mew"] {
            assert!(
                mentions.names.iter().any(|name| name == expected),
                "missing {expected} in {:?}",
                mentions.names
            );
        }
        // The bullet head drops the parenthetical and the em-dash tail.
        assert!(!mentions.names.iter().any(|name| name.contains("Team Rocket")));
    }

    #[test]
    fn three_or_more_blank_lines_collapse() {
        let mentions = extract_reply_card_mentions("a\n\n\n\nb");
        assert_eq!(mentions.text, "a\n\nb");
    }

    #[test]
    fn card_rows_render_the_poko_source_shape() {
        let row = json!({ "card_id": 12345, "name": "Pikachu", "set_name": "Base" });
        let card = card_row(&row);
        assert_eq!(card["cardId"], json!("12345"));
        assert_eq!(card["id"], json!("12345"));
        assert_eq!(card["cardName"], json!("Pikachu"));
        assert_eq!(card["name"], json!("Pikachu"));
        assert_eq!(card["setName"], json!("Base"));
        assert_eq!(card["source"], json!("poko"));
    }

    #[test]
    fn card_ids_must_be_three_to_twelve_digits() {
        assert!(is_card_id("123"));
        assert!(is_card_id("123456789012"));
        assert!(!is_card_id("12"));
        assert!(!is_card_id("1234567890123"));
        assert!(!is_card_id("12a"));
        assert!(!is_card_id(""));
    }

    #[test]
    fn uniq_is_case_insensitive_and_keeps_the_first() {
        assert_eq!(
            uniq(vec![
                "Pikachu".into(),
                "pikachu".into(),
                "Eevee".into(),
                "".into()
            ]),
            vec!["Pikachu".to_string(), "Eevee".to_string()]
        );
    }

    #[test]
    fn event_serialization_matches_the_node_shape() {
        let document = crate::firestore::Document {
            name: "projects/p/databases/(default)/documents/poko_conversations/u/events/e1".into(),
            create_time: None,
            update_time: None,
            fields: serde_json::from_value(json!({
                "role": { "stringValue": "assistant" },
                "text": { "stringValue": "hello" },
                "source": { "stringValue": "hermes" },
                "turnId": { "stringValue": "t1" },
                "createdAt": { "timestampValue": "2026-10-08T00:00:00Z" },
                "cards": { "arrayValue": { "values": [
                    { "mapValue": { "fields": { "cardId": { "stringValue": "1" } } } }] } }
            }))
            .ok(),
        };
        let event = serialize_event(&document);
        assert_eq!(event["id"], json!("e1"));
        assert_eq!(event["role"], json!("assistant"));
        assert_eq!(event["mine"], json!(false));
        assert_eq!(event["text"], json!("hello"));
        assert_eq!(event["listings"], event["cards"]);
        assert_eq!(event["images"], json!([]));
        assert_eq!(event["source"], json!("hermes"));
        assert_eq!(event["clientTurnId"], json!(""));
        assert_eq!(event["createdAt"], json!("2026-10-08T00:00:00.000000Z"));

        // A user row is `mine` and defaults its role.
        let document = crate::firestore::Document {
            name: "projects/p/databases/(default)/documents/poko_conversations/u/events/e2".into(),
            create_time: None,
            update_time: None,
            fields: serde_json::from_value(json!({ "text": { "stringValue": "hi" } })).ok(),
        };
        let event = serialize_event(&document);
        assert_eq!(event["role"], json!("user"));
        assert_eq!(event["mine"], json!(true));
        assert_eq!(event["createdAt"], Json::Null);
    }

    #[test]
    fn firestore_times_accept_every_stored_shape() {
        assert_eq!(
            firestore_time_iso(Some(&json!("2026-10-08T00:00:00Z"))),
            Some("2026-10-08T00:00:00Z".to_string())
        );
        assert_eq!(
            firestore_time_iso(Some(&json!({ "_seconds": 1_791_417_600 }))),
            Some("2026-10-08T00:00:00.000Z".to_string())
        );
        assert_eq!(
            firestore_time_iso(Some(&json!({ "seconds": 1_791_417_600 }))),
            Some("2026-10-08T00:00:00.000Z".to_string())
        );
        assert_eq!(
            firestore_time_iso(Some(&json!(1_791_417_600_000i64))),
            Some("2026-10-08T00:00:00.000Z".to_string())
        );
        assert_eq!(firestore_time_iso(Some(&json!(""))), None);
        assert_eq!(firestore_time_iso(Some(&Json::Null)), None);
        assert_eq!(firestore_time_iso(None), None);
    }

    #[test]
    fn integral_numbers_render_without_a_decimal_point() {
        assert_eq!(num(0.5), json!(0.5));
        assert_eq!(num(3.0), json!(3));
        assert_eq!(num(0.87), json!(0.87));
    }
}
