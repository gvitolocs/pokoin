//! Pokoin social autoposter — native port of `_social_autoposter.js`.
//!
//! Pure composition + SQL card selection + Telegram/X transport. Live sends
//! only happen when the matching credentials are configured; `dryRun` never
//! touches a provider. No Node, no JS engine.

use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use regex::Regex;
use serde_json::{json, Map, Value};
use sha1::Sha1;

use crate::db::DbPools;
use crate::error::{clean_text, ApiError, ApiResult};

pub const DEFAULT_SITE_URL: &str = "https://pokoin.com";
pub const DEFAULT_SOCIAL_AGENT_ENDPOINT: &str = "http://130.162.242.213:8787/social-post";
pub const DEFAULT_HASHTAGS: [&str; 3] = ["#Pokoin", "#PokemonCards", "#TradingCards"];
pub const TELEGRAM_MESSAGE_LIMIT: usize = 4096;
pub const TELEGRAM_CAPTION_LIMIT: usize = 1024;
pub const X_POST_LIMIT: usize = 280;
pub const SOCIAL_AGENT_TIMEOUT_MS: u64 = 6000;
pub const SOCIAL_IMAGE_MAX_BYTES: usize = 5 * 1024 * 1024;

/// All environment-driven social wiring.
#[derive(Clone)]
pub struct SocialConfig {
    pub site_url: String,
    pub telegram_bot_token: String,
    pub telegram_channel_id: String,
    pub social_secret: String,
    pub cron_secret: String,
    pub agent_endpoint: String,
    pub agent_token: String,
    pub image_max_bytes: usize,
    pub x_bearer_token: String,
    pub x_api_key: String,
    pub x_api_secret: String,
    pub x_access_token: String,
    pub x_access_token_secret: String,
    pub x_media_upload_url: String,
    pub x_tweet_url: String,
    pub http: reqwest::Client,
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default().trim().to_string()
}

fn env_any(names: &[&str]) -> String {
    names.iter().map(|name| env(name)).find(|value| !value.is_empty()).unwrap_or_default()
}

impl std::fmt::Debug for SocialConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SocialConfig")
            .field("site_url", &self.site_url)
            .field("telegram_configured", &!self.telegram_bot_token.is_empty())
            .field("x_configured", &!self.x_bearer_token.is_empty())
            .finish_non_exhaustive()
    }
}

impl SocialConfig {
    pub fn from_env() -> Self {
        Self {
            site_url: site_origin(&env("PUBLIC_SITE_URL")),
            telegram_bot_token: env("TELEGRAM_BOT_TOKEN"),
            telegram_channel_id: env("TELEGRAM_CHANNEL_ID"),
            social_secret: env_any(&[
                "SOCIAL_AUTOPOST_SECRET",
                "SOCIAL_AUTOPST_SECRET",
                "POKOIN_SOCIAL_AUTOPOST_SECRET",
            ]),
            cron_secret: env("CRON_SECRET"),
            agent_endpoint: social_agent_endpoint(&env_any(&[
                "ORACLE_SOCIAL_AGENT_URL",
                "SOCIAL_AGENT_ENDPOINT",
                "SOCIAL_AGENT_URL",
            ])),
            agent_token: env_any(&[
                "SOCIAL_AGENT_TOKEN",
                "ORACLE_SOCIAL_AGENT_TOKEN",
                "POKOIN_SOCIAL_AGENT_TOKEN",
            ]),
            image_max_bytes: env("SOCIAL_IMAGE_MAX_BYTES")
                .parse::<usize>()
                .ok()
                .filter(|value| *value > 0)
                .unwrap_or(SOCIAL_IMAGE_MAX_BYTES),
            x_bearer_token: env_any(&[
                "X_BEARER_TOKEN",
                "X_OAUTH2_ACCESS_TOKEN",
                "X_ACCESS_TOKEN",
                "X_USER_ACCESS_TOKEN",
            ]),
            x_api_key: env_any(&["X_API_KEY", "X_CONSUMER_KEY", "TWITTER_API_KEY"]),
            x_api_secret: env_any(&[
                "X_API_SECRET",
                "X_API_KEY_SECRET",
                "X_CONSUMER_SECRET",
                "TWITTER_API_SECRET",
                "TWITTER_API_KEY_SECRET",
            ]),
            x_access_token: env_any(&[
                "X_ACCESS_TOKEN",
                "X_OAUTH1_ACCESS_TOKEN",
                "TWITTER_ACCESS_TOKEN",
            ]),
            x_access_token_secret: env_any(&[
                "X_OAUTH1_ACCESS_TOKEN_SECRET",
                "X_ACCESS_TOKEN_SECRET",
                "TWITTER_ACCESS_TOKEN_SECRET",
            ]),
            x_media_upload_url: env("X_MEDIA_UPLOAD_URL"),
            x_tweet_url: env("X_TWEET_URL"),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .expect("reqwest client"),
        }
    }

    /// OAuth1.0a is usable only with a full key/secret/token set.
    pub fn x_oauth1(&self) -> Option<[String; 4]> {
        if self.x_api_key.is_empty()
            || self.x_api_secret.is_empty()
            || self.x_access_token.is_empty()
            || self.x_access_token_secret.is_empty()
        {
            return None;
        }
        Some([
            self.x_api_key.clone(),
            self.x_api_secret.clone(),
            self.x_access_token.clone(),
            self.x_access_token_secret.clone(),
        ])
    }
}

/// `cleanText` — collapse CRLF/trailing spaces/blank runs, trim, cap.
pub fn clean_social_text(value: &str, max_length: usize) -> String {
    static CRLF: OnceLock<Regex> = OnceLock::new();
    static TRAILING: OnceLock<Regex> = OnceLock::new();
    static BLANKS: OnceLock<Regex> = OnceLock::new();
    let crlf = CRLF.get_or_init(|| Regex::new(r"\r\n").expect("crlf"));
    let trailing = TRAILING.get_or_init(|| Regex::new(r"[ \t]+\n").expect("trailing"));
    let blanks = BLANKS.get_or_init(|| Regex::new(r"\n{4,}").expect("blanks"));
    let text = crlf.replace_all(value, "\n");
    let text = trailing.replace_all(&text, "\n");
    let text = blanks.replace_all(&text, "\n\n\n");
    crate::error::clean_text(Some(&text), max_length)
}

/// `boolValue` — accepts JS-style truthy strings.
pub fn bool_value(value: Option<&Value>, fallback: bool) -> bool {
    match value {
        None | Some(Value::Null) => fallback,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().map(|n| n != 0.0).unwrap_or(fallback),
        Some(Value::String(text)) => {
            let lowered = text.trim().to_lowercase();
            if lowered.is_empty() {
                return fallback;
            }
            ["1", "true", "yes", "on"].contains(&lowered.as_str())
        }
        Some(_) => fallback,
    }
}

pub fn site_origin(configured: &str) -> String {
    let candidate = if configured.trim().is_empty() { DEFAULT_SITE_URL } else { configured.trim() };
    match url::Url::parse(candidate) {
        Ok(parsed) => format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or("pokoin.com"))
            .trim_end_matches('/')
            .to_string(),
        Err(_) => DEFAULT_SITE_URL.to_string(),
    }
}

/// `absoluteUrl` — absolute passthrough, otherwise joined to the site origin.
pub fn absolute_url(value: &str, site: &str) -> String {
    let raw = clean_text(Some(value), 1000);
    if raw.is_empty() {
        return String::new();
    }
    if let Ok(parsed) = url::Url::parse(&raw) {
        return parsed.to_string();
    }
    let joined = if raw.starts_with('/') { raw.clone() } else { format!("/{raw}") };
    url::Url::parse(site)
        .and_then(|base| base.join(&joined))
        .map(|parsed| parsed.to_string())
        .unwrap_or_default()
}

pub fn slug_part(value: &str) -> String {
    static NON: OnceLock<Regex> = OnceLock::new();
    static EDGES: OnceLock<Regex> = OnceLock::new();
    let non = NON.get_or_init(|| Regex::new(r"[^a-z0-9]+").expect("non"));
    let edges = EDGES.get_or_init(|| Regex::new(r"^-+|-+$").expect("edges"));
    let text = non.replace_all(&value.trim().to_lowercase(), "-").to_string();
    edges.replace_all(&text, "").to_string()
}

pub fn clean_numeric_id(value: &str) -> String {
    let text = clean_text(Some(value), 80);
    if text.is_empty() || !text.chars().all(|c| c.is_ascii_digit()) {
        return String::new();
    }
    // Reject leading-zero-only ids and u64 overflow.
    match text.parse::<u64>() {
        Ok(number) if number > 0 => number.to_string(),
        _ => String::new(),
    }
}

fn value_str<'a>(card: &'a Value, keys: &[&str]) -> &'a str {
    for key in keys {
        if let Some(text) = card.get(*key).and_then(Value::as_str) {
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    ""
}

pub fn canonical_card_path(card: &Value) -> String {
    let catalog_id = clean_numeric_id(value_str(card, &["cardId", "card_id", "id"]));
    let blueprint_id = clean_numeric_id(value_str(card, &["blueprintId", "blueprint_id"]));
    let card_id = if !catalog_id.is_empty() {
        catalog_id
    } else if !blueprint_id.is_empty() {
        (blueprint_id.parse::<u64>().unwrap_or(0) * 2).to_string()
    } else {
        String::new()
    };
    if card_id.is_empty() {
        return String::new();
    }
    let numeric = card_id.parse::<u64>().unwrap_or(0);
    let our_id = if numeric % 2 == 1 { numeric * 2 } else { numeric };
    let slug = [
        value_str(card, &["rarity"]),
        value_str(card, &["name", "cardName", "title"]),
        value_str(card, &["collectorNumber", "collector_number", "cardNumber", "card_number"]),
        value_str(card, &["setName", "set_name", "expansionName", "expansion_name"]),
    ]
    .iter()
    .map(|part| slug_part(part))
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("-");
    if slug.is_empty() {
        String::new()
    } else {
        format!("/marketplace/en/cards/{our_id}/{slug}")
    }
}

pub fn public_card_url(card: &Value, site: &str) -> String {
    absolute_url(
        value_str(card, &["cardUrl", "card_url", "listingUrl", "listing_url"]),
        site,
    )
    .or_else_nonempty(|| absolute_url(&canonical_card_path(card), site))
}

/// Small helper: use the canonical path when no explicit card URL exists.
trait OrElseNonEmpty {
    fn or_else_nonempty(self, fallback: impl FnOnce() -> String) -> String;
}
impl OrElseNonEmpty for String {
    fn or_else_nonempty(self, fallback: impl FnOnce() -> String) -> String {
        if self.is_empty() {
            fallback()
        } else {
            self
        }
    }
}

pub fn public_image_url(card: &Value, site: &str) -> String {
    let raw = clean_text(
        Some(value_str(
            card,
            &[
                "cdnImageUrl",
                "cdn_image_url",
                "imageUrl",
                "image_url",
                "previewImageUrl",
                "preview_image_url",
                "homepageImageUrl",
                "homepage_image_url",
            ],
        )),
        1000,
    );
    if raw.is_empty() {
        return String::new();
    }
    if let Ok(parsed) = url::Url::parse(&raw) {
        if parsed.host_str() == Some("cdn.pokoin.com") {
            if let Ok(base) = url::Url::parse(site) {
                if let Ok(rewritten) = base.join(&format!("/card-images{}{}", parsed.path(), parsed.query().map(|q| format!("?{q}")).unwrap_or_default())) {
                    return rewritten.to_string();
                }
            }
        }
        return parsed.to_string();
    }
    absolute_url(&raw, site)
}

pub fn hashtags_from_input(value: Option<&Value>) -> Vec<String> {
    let mut values: Vec<String> = Vec::new();
    match value {
        Some(Value::Array(items)) => {
            for item in items {
                values.push(clean_text(item.as_str(), 40));
            }
        }
        Some(Value::String(text)) => {
            for item in text.split(|c: char| c == ',' || c.is_whitespace()) {
                values.push(clean_text(Some(item), 40));
            }
        }
        _ => {}
    }
    let mut tags: Vec<String> = Vec::new();
    for value in values.into_iter().filter(|value| !value.is_empty()) {
        let tag = if value.starts_with('#') {
            value
        } else {
            format!("#{}", value.trim_start_matches('#'))
        };
        if tag.len() >= 3 && tag.len() <= 40 && tag[1..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
    }
    if tags.is_empty() {
        DEFAULT_HASHTAGS.iter().map(|tag| tag.to_string()).collect()
    } else {
        tags
    }
}

pub fn format_pkn(value: Option<f64>) -> String {
    let Some(price) = value else {
        return String::new();
    };
    if !price.is_finite() || price <= 0.0 {
        return String::new();
    }
    let rounded = price.round() as i64;
    // en-US thousands separators, like Number.toLocaleString('en-US').
    let digits = rounded.abs().to_string();
    let mut out = String::new();
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if rounded < 0 {
        format!("-{out} PKN")
    } else {
        format!("{out} PKN")
    }
}

pub fn card_display_title(card: &Value) -> String {
    let name = {
        let raw = clean_text(
            Some(value_str(card, &["title", "cardTitle", "cardName", "name"])),
            180,
        );
        if raw.is_empty() { "Pokemon card".to_string() } else { raw }
    };
    let set_name = clean_text(
        Some(value_str(card, &["setName", "set_name", "expansionName", "expansion_name"])),
        120,
    );
    let number = clean_text(
        Some(value_str(
            card,
            &["collectorNumber", "collector_number", "cardNumber", "card_number"],
        )),
        80,
    );
    let suffix = [set_name, number]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if !suffix.is_empty() && !name.contains(&suffix) {
        format!("{name} ({suffix})")
    } else {
        name
    }
}

pub fn truncate_text(value: &str, max_length: usize) -> String {
    let clean = clean_social_text(value, max_length.saturating_mul(2).max(max_length));
    if clean.chars().count() <= max_length {
        return clean;
    }
    if max_length <= 3 {
        return clean.chars().take(max_length).collect();
    }
    let head: String = clean.chars().take(max_length - 3).collect();
    format!("{}...", head.trim_end())
}

pub fn compose_with_suffix(main: &str, suffix: &str, max_length: usize) -> String {
    let clean_main = clean_social_text(main, max_length.saturating_mul(2).max(max_length));
    let clean_suffix = clean_social_text(suffix, max_length.max(1000));
    if clean_suffix.is_empty() {
        return truncate_text(&clean_main, max_length);
    }
    let combined = format!("{clean_main}\n\n{clean_suffix}");
    if combined.chars().count() <= max_length {
        return combined.trim().to_string();
    }
    let suffix_len = clean_suffix.chars().count();
    if max_length > suffix_len + 2 {
        let available = max_length - suffix_len - 2;
        if available > 20 {
            return format!("{}\n\n{}", truncate_text(&clean_main, available), clean_suffix)
                .trim()
                .to_string();
        }
    }
    truncate_text(&combined, max_length)
}

pub fn ensure_text_includes_url(text: &str, url: &str, max_length: usize) -> String {
    let clean = clean_social_text(text, max_length);
    let canonical = clean_text(Some(url), 1000);
    if canonical.is_empty() || clean.contains(&canonical) {
        return truncate_text(&clean, max_length);
    }
    compose_with_suffix(&clean, &canonical, max_length)
}

/// `buildPostContent` — deterministic fallback copy.
pub fn build_post_content(input: &Value, site: &str) -> Value {
    let card = input.get("card").cloned().unwrap_or(json!({}));
    let card_url = absolute_url(
        &{
            let explicit = value_str(input, &["cardUrl"]);
            if explicit.is_empty() { public_card_url(&card, site) } else { explicit.to_string() }
        },
        site,
    );
    let image_url = absolute_url(
        &{
            let explicit = value_str(input, &["imageUrl"]);
            if explicit.is_empty() { public_image_url(&card, site) } else { explicit.to_string() }
        },
        site,
    );
    let hashtags = hashtags_from_input(input.get("hashtags"));
    let supplied_message = clean_social_text(value_str(input, &["message"]), TELEGRAM_MESSAGE_LIMIT);
    let title = card_display_title(&card);
    let price = format_pkn(card.get("pricePkn").and_then(Value::as_f64));
    let hook = {
        let raw = clean_social_text(value_str(input, &["hook"]), 120);
        if !raw.is_empty() {
            raw
        } else if !price.is_empty() {
            "Hot on Pokoin:".to_string()
        } else {
            "New Pokoin marketplace signal:".to_string()
        }
    };
    let artist = value_str(&card, &["artist", "illustrator"]);
    let details: Vec<String> = [
        if price.is_empty() { String::new() } else { format!("Floor from {price}") },
        value_str(&card, &["rarity"]).to_string(),
        if artist.is_empty() { String::new() } else { format!("Illustrated by {artist}") },
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect();
    let generated = [
        format!("{hook} {title}"),
        details.join(" - "),
        "Explore, list, or buy with PKN on Pokoin.".to_string(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    let base_message = if supplied_message.is_empty() { generated } else { supplied_message };
    let suffix = [card_url.clone(), hashtags.join(" ")]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let telegram_text = compose_with_suffix(&base_message, &suffix, TELEGRAM_MESSAGE_LIMIT);
    let x_text = compose_with_suffix(&base_message, &suffix, X_POST_LIMIT);
    json!({
        "text": telegram_text,
        "telegramText": telegram_text,
        "telegramCaption": truncate_text(&telegram_text, TELEGRAM_CAPTION_LIMIT),
        "xText": x_text,
        "cardUrl": card_url,
        "imageUrl": image_url,
        "hashtags": hashtags,
        "card": card,
    })
}

/// `cleanTargets` — default telegram+x, twitter→x, unknown rejected.
pub fn clean_targets(value: Option<&Value>) -> ApiResult<Vec<String>> {
    let source: Vec<String> = match value {
        None | Some(Value::Null) => vec!["telegram".into(), "x".into()],
        Some(Value::String(text)) if text.trim().is_empty() => {
            vec!["telegram".into(), "x".into()]
        }
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| clean_text(item.as_str(), 40).to_lowercase())
            .collect(),
        Some(Value::String(text)) => text
            .split(',')
            .map(|item| clean_text(Some(item), 40).to_lowercase())
            .collect(),
        _ => vec!["telegram".into(), "x".into()],
    };
    let mut targets: Vec<String> = Vec::new();
    for item in source {
        let item = item.trim().to_string();
        if item.is_empty() {
            continue;
        }
        let item = if item == "twitter" { "x".to_string() } else { item };
        if !targets.contains(&item) {
            targets.push(item);
        }
    }
    let unsupported: Vec<&String> = targets
        .iter()
        .filter(|target| target.as_str() != "telegram" && target.as_str() != "x")
        .collect();
    if !unsupported.is_empty() {
        let names = unsupported.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
        return Err(ApiError::bad_request(format!("Unsupported social target: {names}.")));
    }
    if targets.is_empty() {
        return Err(ApiError::bad_request("At least one social target is required."));
    }
    Ok(targets)
}

pub fn clean_window(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if ["1h", "24h", "7d"].contains(&normalized.as_str()) {
        normalized
    } else {
        "24h".to_string()
    }
}

fn score_column(window: &str) -> &'static str {
    match clean_window(window).as_str() {
        "1h" => "hot_score_1h",
        "7d" => "hot_score_7d",
        _ => "hot_score_24h",
    }
}

pub fn clean_limit(value: Option<i64>, fallback: i64) -> i64 {
    value.unwrap_or(fallback).clamp(1, 100)
}

/// `mapCardRow` — catalog/blueprint ids and public URLs.
pub fn map_card_row(row: &Value) -> Value {
    let catalog_id = clean_numeric_id(row.get("card_id").map(value_to_string).unwrap_or_default().as_str());
    let ct_id = clean_numeric_id(
        row.get("ct_id")
            .or_else(|| row.get("blueprint_id"))
            .map(value_to_string)
            .unwrap_or_default()
            .as_str(),
    );
    let our_id = if !catalog_id.is_empty() {
        let numeric = catalog_id.parse::<u64>().unwrap_or(0);
        if numeric % 2 == 1 { (numeric * 2).to_string() } else { catalog_id.clone() }
    } else if !ct_id.is_empty() {
        (ct_id.parse::<u64>().unwrap_or(0) * 2).to_string()
    } else {
        String::new()
    };
    let blueprint = if !ct_id.is_empty() {
        ct_id.clone()
    } else if !catalog_id.is_empty() {
        let numeric = catalog_id.parse::<u64>().unwrap_or(0);
        if numeric % 2 == 0 { (numeric / 2).to_string() } else { catalog_id.clone() }
    } else {
        String::new()
    };
    let card = json!({
        "cardId": our_id,
        "blueprintId": blueprint,
        "name": value_str(row, &["name", "card_name"]),
        "setName": value_str(row, &["set_name", "expansion_name"]),
        "cardNumber": value_str(row, &["card_number", "collector_number", "expansion_number"]),
        "rarity": value_str(row, &["rarity"]),
        "cardType": value_str(row, &["card_type"]),
        "productVariant": value_str(row, &["product_variant"]),
        "itemKind": if value_str(row, &["item_kind"]).is_empty() { "single" } else { value_str(row, &["item_kind"]) },
        "productType": if value_str(row, &["product_type"]).is_empty() { "card" } else { value_str(row, &["product_type"]) },
        "trainerName": value_str(row, &["trainer_name"]),
        "artist": value_str(row, &["artist", "illustrator"]),
        "illustrator": value_str(row, &["illustrator", "artist"]),
        "imageUrl": value_str(row, &["image_url"]),
        "cdnImageUrl": value_str(row, &["cdn_image_url"]),
        "previewImageUrl": value_str(row, &["preview_image_url"]),
        "homepageImageUrl": value_str(row, &["homepage_image_url"]),
        "pricePkn": row.get("lowest_ask_pkn").and_then(Value::as_f64),
        "listingCount": row.get("active_listing_count").and_then(Value::as_i64).unwrap_or(0),
        "listedQuantity": row.get("listed_quantity").and_then(Value::as_i64).unwrap_or(0),
        "hotScore1h": row.get("hot_score_1h").and_then(Value::as_f64).unwrap_or(0.0),
        "hotScore24h": row.get("hot_score_24h").and_then(Value::as_f64).unwrap_or(0.0),
        "hotScore7d": row.get("hot_score_7d").and_then(Value::as_f64).unwrap_or(0.0),
        "lastEventAt": row.get("last_event_at").cloned().unwrap_or(Value::Null),
    });
    card
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

pub const HOT_CARD_SQL: &str = "
      with hot as (
        select *
        from public.marketplace_hot_blueprints
        where {score} > 0
        order by {score} desc, last_event_at desc nulls last, blueprint_id desc
        limit $1
      )
      select
        hot.blueprint_id,
        hot.name,
        hot.set_name,
        hot.card_number,
        hot.rarity,
        hot.card_type,
        hot.item_kind,
        hot.product_type,
        hot.hot_score_1h,
        hot.hot_score_24h,
        hot.hot_score_7d,
        hot.last_event_at,
        c.product_variant,
        c.trainer_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.homepage_image_url,
        artist.artist,
        artist.illustrator,
        price.lowest_ask_pkn,
        price.active_listing_count,
        price.listed_quantity
      from hot
      left join public.marketplace_search_candidates c
        on c.ct_id = hot.blueprint_id
        or c.card_id = hot.blueprint_id * 2
      left join public.marketplace_blueprint_artists artist
        on artist.blueprint_id = hot.blueprint_id
      left join public.marketplace_blueprint_price_summary price
        on price.blueprint_id = hot.blueprint_id
      order by hot.{score} desc, hot.last_event_at desc nulls last, hot.blueprint_id desc
      limit 1
";

pub const FETCH_CARD_SQL: &str = "
      select
        c.card_id,
        c.name,
        c.set_name,
        c.card_number,
        c.rarity,
        c.card_type,
        c.product_variant,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.homepage_image_url,
        artist.artist,
        artist.illustrator,
        price.lowest_ask_pkn,
        price.active_listing_count,
        price.listed_quantity
      from public.marketplace_search_candidates c
      left join public.marketplace_blueprint_artists artist
        on artist.card_id = c.card_id
      left join public.marketplace_blueprint_price_summary price
        on price.blueprint_id = coalesce(c.ct_id, c.card_id)
      where c.card_id = $1::bigint or c.ct_id = $1::bigint
      limit 1
";

/// `selectHotCard` — top hot blueprint with candidate/artist/price overlay.
pub async fn select_hot_card(db: &DbPools, window: &str, limit: Option<i64>) -> ApiResult<Option<Value>> {
    let score = score_column(window);
    let sql = HOT_CARD_SQL.replace("{score}", score);
    let rows = db.query("pokemon", &sql, &[json!(clean_limit(limit, 12))]).await?;
    Ok(rows.first().map(map_card_row))
}

/// `fetchCardById` — public/leftover id lookup.
pub async fn fetch_card_by_id(db: &DbPools, card_id: &str) -> ApiResult<Option<Value>> {
    let id = clean_numeric_id(card_id);
    if id.is_empty() {
        return Ok(None);
    }
    let numeric: i64 = id.parse().unwrap_or(0);
    let rows = db.query("pokemon", FETCH_CARD_SQL, &[json!(numeric)]).await?;
    Ok(rows.first().map(map_card_row))
}

/// `cardFromBody` — keep only present, non-empty explicit card fields.
pub fn card_from_body(body: &Value) -> Value {
    let source = body
        .get("card")
        .filter(|value| value.is_object())
        .unwrap_or(body);
    let mut card = Map::new();
    let pick = |keys: &[&str]| -> Option<Value> {
        for key in keys {
            if let Some(value) = source.get(*key).or_else(|| body.get(*key)) {
                if !value.is_null() && value != &json!("") {
                    return Some(value.clone());
                }
            }
        }
        None
    };
    let fields: [(&str, &[&str]); 12] = [
        ("cardId", &["cardId", "card_id"]),
        ("blueprintId", &["blueprintId", "blueprint_id"]),
        ("title", &["title", "cardTitle"]),
        ("name", &["name", "cardName"]),
        ("setName", &["setName", "set_name"]),
        ("cardNumber", &["cardNumber", "card_number", "collectorNumber"]),
        ("rarity", &["rarity"]),
        ("artist", &["artist", "illustrator"]),
        ("imageUrl", &["imageUrl", "image_url"]),
        ("cdnImageUrl", &["cdnImageUrl", "cdn_image_url"]),
        ("pricePkn", &["pricePkn", "price_pkn"]),
        ("cardUrl", &["cardUrl", "card_url", "url"]),
    ];
    for (out, keys) in fields {
        if let Some(value) = pick(keys) {
            card.insert(out.to_string(), value);
        }
    }
    Value::Object(card)
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

pub fn social_agent_endpoint(configured: &str) -> String {
    let endpoint = if configured.trim().is_empty() {
        DEFAULT_SOCIAL_AGENT_ENDPOINT
    } else {
        configured.trim()
    };
    match url::Url::parse(endpoint) {
        Ok(mut parsed) => {
            if parsed.path().is_empty() || parsed.path() == "/" {
                parsed.set_path("/social-post");
            }
            parsed.to_string().trim_end_matches('/').to_string()
        }
        Err(_) => DEFAULT_SOCIAL_AGENT_ENDPOINT.to_string(),
    }
}

pub fn social_agent_instructions(targets: &[String], card_url: &str) -> String {
    [
        "You are the Pokoin social post agent, not the Pokontact support chatbot.".to_string(),
        "Write promotional marketplace social copy for Pokoin Card Reserve and the PKN card marketplace.".to_string(),
        "Voice: collector-friendly, confident, concise, playful but not support-chatty. Do not say \"I can help\" or ask follow-up questions.".to_string(),
        "Grounding: use only the supplied card, price, listing, hot-score, and URL data. Do not invent prices, active listings, stock, sales, rarity, or popularity.".to_string(),
        "If price/listing data is missing, talk about browsing or collecting the card without claiming it is available or cheap.".to_string(),
        "Always include the canonical Pokoin URL exactly once in each post when a URL is supplied.".to_string(),
        "X rules: max 280 characters, plain text, include the URL, no thread language, no unsupported claims.".to_string(),
        "Telegram rules: may be richer than X, can use line breaks, include the URL, stay under 1024 characters when it may be used as a photo caption.".to_string(),
        "Avoid financial-advice phrasing and avoid support chatbot phrasing.".to_string(),
        format!("Requested targets: {}.", targets.join(", ")),
        if card_url.is_empty() { String::new() } else { format!("Canonical URL that must be included: {card_url}") },
        "Return only JSON with string fields telegramText and xText, plus optional hashtags array.".to_string(),
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

pub fn normalize_agent_content(payload: &Value, fallback: &Value) -> Option<Value> {
    let telegram_text = clean_social_text(
        value_str(payload, &["telegramText", "telegram_text", "telegram", "text"]),
        TELEGRAM_MESSAGE_LIMIT,
    );
    let x_text = clean_social_text(
        value_str(payload, &["xText", "x_text", "x", "twitterText", "twitter"]),
        X_POST_LIMIT,
    );
    if telegram_text.is_empty() && x_text.is_empty() {
        return None;
    }
    let card_url = fallback.get("cardUrl").and_then(Value::as_str).unwrap_or_default();
    let telegram_with_url = ensure_text_includes_url(
        if telegram_text.is_empty() {
            fallback.get("telegramText").and_then(Value::as_str).unwrap_or_default()
        } else {
            &telegram_text
        },
        card_url,
        TELEGRAM_MESSAGE_LIMIT,
    );
    let x_with_url = ensure_text_includes_url(
        if x_text.is_empty() {
            fallback.get("xText").and_then(Value::as_str).unwrap_or_default()
        } else {
            &x_text
        },
        card_url,
        X_POST_LIMIT,
    );
    let mut content = fallback.clone();
    content["text"] = json!(telegram_with_url);
    content["telegramText"] = json!(telegram_with_url);
    content["xText"] = json!(x_with_url);
    content["telegramCaption"] = json!(truncate_text(&telegram_with_url, TELEGRAM_CAPTION_LIMIT));
    content["agent"] = json!({
        "ok": true,
        "source": if value_str(payload, &["source"]).is_empty() { "social-agent" } else { value_str(payload, &["source"]) },
        "provider": value_str(payload, &["provider"]),
        "model": value_str(payload, &["model"]),
    });
    Some(content)
}

pub async fn call_social_agent(
    config: &SocialConfig,
    input: &Value,
    targets: &[String],
    fallback: &Value,
) -> Option<Value> {
    if config.agent_token.is_empty() {
        return None;
    }
    let body = json!({
        "instructions": social_agent_instructions(targets, fallback.get("cardUrl").and_then(Value::as_str).unwrap_or_default()),
        "targets": targets,
        "card": fallback.get("card").cloned().unwrap_or(json!({})),
        "cardUrl": fallback.get("cardUrl"),
        "imageUrl": fallback.get("imageUrl"),
        "deterministic": {
            "telegramText": fallback.get("telegramText"),
            "xText": fallback.get("xText"),
            "hashtags": fallback.get("hashtags"),
        },
        "context": input.get("context").cloned().unwrap_or(json!({})),
    });
    let response = config
        .http
        .post(&config.agent_endpoint)
        .bearer_auth(&config.agent_token)
        .json(&body)
        .timeout(Duration::from_millis(SOCIAL_AGENT_TIMEOUT_MS))
        .send()
        .await
        .ok()?;
    let status = response.status();
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return None;
    }
    normalize_agent_content(&payload, fallback)
}

pub async fn content_with_optional_agent(
    config: &SocialConfig,
    input: &Value,
    targets: &[String],
    use_agent: bool,
) -> Value {
    let fallback = build_post_content(input, &config.site_url);
    if !use_agent {
        let mut content = fallback;
        content["agent"] = json!({ "ok": false, "skipped": true, "reason": "agent_disabled" });
        return content;
    }
    match call_social_agent(config, input, targets, &fallback).await {
        Some(content) => content,
        None => {
            let mut content = fallback;
            content["agent"] = json!({ "ok": false, "skipped": true, "reason": "agent_unavailable" });
            content
        }
    }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// One provider result. `ok` is false when at least one target failed.
pub async fn post_to_targets(
    config: &SocialConfig,
    targets: &[String],
    content: &Value,
    dry_run: bool,
    send_photo: bool,
    silent: bool,
) -> Value {
    let mut results = Map::new();
    let mut all_ok = true;
    for target in targets {
        let outcome = match target.as_str() {
            "telegram" => post_to_telegram(config, content, dry_run, send_photo, silent).await,
            "x" => post_to_x(config, content, dry_run, send_photo).await,
            other => Err(ApiError::bad_request(format!("Unsupported social target: {other}."))),
        };
        match outcome {
            Ok(value) => {
                results.insert(target.clone(), value);
            }
            Err(error) => {
                all_ok = false;
                results.insert(
                    target.clone(),
                    json!({ "ok": false, "platform": target, "error": error.message }),
                );
            }
        }
    }
    json!({ "ok": all_ok, "results": Value::Object(results) })
}

pub async fn post_to_telegram(
    config: &SocialConfig,
    content: &Value,
    dry_run: bool,
    send_photo: bool,
    silent: bool,
) -> ApiResult<Value> {
    let chat_id = config.telegram_channel_id.clone();
    if chat_id.is_empty() && !dry_run {
        return Err(ApiError::new(500, "TELEGRAM_CHANNEL_ID is not configured."));
    }
    let image_url = content.get("imageUrl").and_then(Value::as_str).unwrap_or_default();
    let use_photo = !image_url.is_empty() && send_photo;
    let telegram_text = content
        .get("telegramText")
        .or_else(|| content.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let caption = content
        .get("telegramCaption")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if dry_run {
        let method = if use_photo { "sendPhoto" } else { "sendMessage" };
        return Ok(json!({
            "ok": true,
            "dryRun": true,
            "platform": "telegram",
            "method": method,
            "payload": {
                "chat_id": if chat_id.is_empty() { "" } else { "[configured]" },
                "text": if use_photo { String::new() } else { truncate_text(telegram_text, TELEGRAM_MESSAGE_LIMIT) },
                "caption": if use_photo { caption } else { "" },
                "disable_notification": silent,
            }
        }));
    }
    if config.telegram_bot_token.is_empty() {
        return Err(ApiError::new(500, "TELEGRAM_BOT_TOKEN is not configured."));
    }
    let endpoint = format!("https://api.telegram.org/bot{}/sendMessage", config.telegram_bot_token);
    if use_photo {
        let image = download_social_image(config, image_url).await?;
        let form = reqwest::multipart::Form::new()
            .text("chat_id", chat_id.clone())
            .text("caption", caption.to_string())
            .text("disable_notification", if silent { "true" } else { "false" })
            .part(
                "photo",
                reqwest::multipart::Part::bytes(image.bytes)
                    .file_name(image.filename)
                    .mime_str(&image.content_type)
                    .map_err(|_| ApiError::new(500, "Telegram photo mime failed."))?,
            );
        let response = config
            .http
            .post(format!(
                "https://api.telegram.org/bot{}/sendPhoto",
                config.telegram_bot_token
            ))
            .multipart(form)
            .send()
            .await?;
        let status = response.status();
        let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() || payload.get("ok") == Some(&Value::Bool(false)) {
            return Err(ApiError::upstream(
                payload
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("Telegram sendPhoto failed."),
            ));
        }
        return Ok(json!({
            "ok": true,
            "platform": "telegram",
            "method": "sendPhoto",
            "messageId": payload.pointer("/result/message_id"),
            "uploadedImage": true,
        }));
    }
    let payload = json!({
        "chat_id": chat_id,
        "text": truncate_text(telegram_text, TELEGRAM_MESSAGE_LIMIT),
        "disable_notification": silent,
    });
    let response = config.http.post(&endpoint).json(&payload).send().await?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() || body.get("ok") == Some(&Value::Bool(false)) {
        return Err(ApiError::upstream(
            body.get("description")
                .and_then(Value::as_str)
                .unwrap_or("Telegram sendMessage failed."),
        ));
    }
    Ok(json!({
        "ok": true,
        "platform": "telegram",
        "method": "sendMessage",
        "messageId": body.pointer("/result/message_id"),
    }))
}

struct SocialImage {
    bytes: Vec<u8>,
    content_type: String,
    filename: String,
}

async fn download_social_image(config: &SocialConfig, image_url: &str) -> ApiResult<SocialImage> {
    let url = absolute_url(image_url, &config.site_url);
    if url.is_empty() {
        return Err(ApiError::bad_request("No public image URL is available for social media upload."));
    }
    let response = config
        .http
        .get(&url)
        .header("Accept", "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8")
        .header("User-Agent", "PokoinSocialBot/1.0 (+https://pokoin.com)")
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(ApiError::upstream(format!(
            "Failed to fetch social image: {}.",
            response.status().as_u16()
        )));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = response.bytes().await?.to_vec();
    if bytes.len() > config.image_max_bytes {
        return Err(ApiError::new(
            413,
            format!("Social image is too large ({} bytes).", bytes.len()),
        ));
    }
    if !content_type.to_lowercase().starts_with("image/") {
        return Err(ApiError::new(
            415,
            format!("Social image response is not an image ({content_type})."),
        ));
    }
    let extension = match content_type.split(';').next().unwrap_or("").trim() {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    };
    Ok(SocialImage {
        bytes,
        content_type,
        filename: format!("pokoin-card.{extension}"),
    })
}

pub async fn post_to_x(
    config: &SocialConfig,
    content: &Value,
    dry_run: bool,
    send_photo: bool,
) -> ApiResult<Value> {
    let x_text = truncate_text(
        content.get("xText").and_then(Value::as_str).unwrap_or_default(),
        X_POST_LIMIT,
    );
    let image_url = content.get("imageUrl").and_then(Value::as_str).unwrap_or_default();
    let attach_media = send_photo && !image_url.is_empty();
    if dry_run {
        return Ok(json!({
            "ok": true,
            "dryRun": true,
            "platform": "x",
            "method": "tweet",
            "payload": { "text": x_text, "attachMedia": attach_media },
        }));
    }
    if config.x_bearer_token.is_empty() && config.x_oauth1().is_none() {
        return Err(ApiError::new(500, "X posting credentials are not configured."));
    }

    let mut media_ids: Vec<String> = Vec::new();
    if attach_media && !config.x_bearer_token.is_empty() {
        if let Ok(media_id) = upload_x_media(config, image_url).await {
            media_ids.push(media_id);
        }
    }

    let tweet_url = if config.x_tweet_url.is_empty() {
        "https://api.x.com/2/tweets".to_string()
    } else {
        config.x_tweet_url.clone()
    };
    let body = if media_ids.is_empty() {
        json!({ "text": x_text })
    } else {
        json!({ "text": x_text, "media": { "media_ids": media_ids } })
    };
    let request = config.http.post(&tweet_url).json(&body);
    let request = if !config.x_bearer_token.is_empty() {
        request.bearer_auth(&config.x_bearer_token)
    } else {
        request.header("Authorization", oauth1_header(config, "POST", &tweet_url, &[]))
    };
    let response = request.send().await?;
    let status = response.status();
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return Err(ApiError::upstream(
            payload
                .pointer("/detail")
                .or_else(|| payload.get("title"))
                .or_else(|| payload.get("message"))
                .and_then(Value::as_str)
                .map(|text| text.to_string())
                .unwrap_or_else(|| format!("X tweet failed ({}).", status.as_u16())),
        ));
    }
    Ok(json!({
        "ok": true,
        "platform": "x",
        "method": "tweet",
        "tweetId": payload.pointer("/data/id"),
        "mediaIds": media_ids,
    }))
}

async fn upload_x_media(config: &SocialConfig, image_url: &str) -> ApiResult<String> {
    let image = download_social_image(config, image_url).await?;
    let endpoint = if config.x_media_upload_url.is_empty() {
        "https://api.x.com/2/media/upload".to_string()
    } else {
        config.x_media_upload_url.clone()
    };
    let init = config
        .http
        .post(&endpoint)
        .bearer_auth(&config.x_bearer_token)
        .json(&json!({
            "media_type": image.content_type.split(';').next().unwrap_or("image/jpeg").trim(),
            "media_category": "tweet_image",
            "total_bytes": image.bytes.len(),
        }))
        .send()
        .await?;
    let status = init.status();
    let payload: Value = init.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return Err(ApiError::upstream("X media INIT failed."));
    }
    let media_id = clean_text(
        payload
            .pointer("/data/id")
            .or_else(|| payload.get("media_id_string"))
            .or_else(|| payload.get("media_id"))
            .and_then(Value::as_str),
        120,
    );
    if media_id.is_empty() {
        return Err(ApiError::upstream("X media INIT did not return a media id."));
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&image.bytes);
    let append = config
        .http
        .post(format!("{endpoint}/{media_id}/append"))
        .bearer_auth(&config.x_bearer_token)
        .json(&json!({ "media": encoded }))
        .send()
        .await?;
    if !append.status().is_success() {
        return Err(ApiError::upstream("X media APPEND failed."));
    }
    let finalize = config
        .http
        .post(format!("{endpoint}/{media_id}/finalize"))
        .bearer_auth(&config.x_bearer_token)
        .send()
        .await?;
    if !finalize.status().is_success() {
        return Err(ApiError::upstream("X media FINALIZE failed."));
    }
    Ok(media_id)
}

/// OAuth1.0a Authorization header (HMAC-SHA1) for text posts when only the
/// OAuth1 key set is configured.
fn oauth1_header(config: &SocialConfig, method: &str, url: &str, extra: &[(&str, String)]) -> String {
    let Some([key, secret, token, token_secret]) = config.x_oauth1() else {
        return String::new();
    };
    let mut rng = rand::thread_rng();
    let nonce: String = {
        let mut bytes = [0u8; 16];
        rng.fill_bytes(&mut bytes);
        hex::encode(bytes)
    };
    let timestamp = crate::time_util::now_ms().max(0) as u64 / 1000;
    let mut params: Vec<(String, String)> = vec![
        ("oauth_consumer_key".into(), key.clone()),
        ("oauth_nonce".into(), nonce),
        ("oauth_signature_method".into(), "HMAC-SHA1".into()),
        ("oauth_timestamp".into(), timestamp.to_string()),
        ("oauth_token".into(), token),
        ("oauth_version".into(), "1.0".into()),
    ];
    params.extend(extra.iter().map(|(key, value)| (key.to_string(), value.clone())));
    params.sort();
    let encoded: Vec<String> = params
        .iter()
        .map(|(key, value)| format!("{}={}", crate::crypto::uri_encode(key, true), crate::crypto::uri_encode(value, true)))
        .collect();
    let base = format!(
        "{}&{}&{}",
        method.to_uppercase(),
        crate::crypto::uri_encode(url, true),
        crate::crypto::uri_encode(&encoded.join("&"), true)
    );
    let signing_key = format!(
        "{}&{}",
        crate::crypto::uri_encode(&secret, true),
        crate::crypto::uri_encode(&token_secret, true)
    );
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(signing_key.as_bytes()).expect("hmac key");
    mac.update(base.as_bytes());
    let signature = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    let mut header_params = params;
    header_params.retain(|(key, _)| key.starts_with("oauth_"));
    header_params.push(("oauth_signature".into(), signature));
    let header = header_params
        .iter()
        .map(|(key, value)| format!("{}={}", crate::crypto::uri_encode(key, true), crate::crypto::uri_encode(value, true)))
        .collect::<Vec<_>>()
        .join(", ");
    format!("OAuth {header}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> Value {
        json!({
            "message": "",
            "card": {
                "name": "Charizard",
                "setName": "Base Set",
                "cardNumber": "4/102",
                "rarity": "Rare",
                "artist": "Mitsuhiro Arita",
                "blueprintId": "123",
                "pricePkn": 1234.6,
                "cdnImageUrl": "https://cdn.pokoin.com/cards/1.jpg"
            }
        })
    }

    #[test]
    fn content_composition_matches_reference_shape() {
        let content = build_post_content(&input(), "https://pokoin.com");
        assert!(content["telegramText"].as_str().unwrap().contains("Floor from 1,235 PKN"));
        assert!(content["telegramText"].as_str().unwrap().contains("Charizard (Base Set 4/102)"));
        assert!(content["xText"].as_str().unwrap().chars().count() <= X_POST_LIMIT);
        assert_eq!(content["cardUrl"], "https://pokoin.com/marketplace/en/cards/246/rare-charizard-4-102-base-set");
        assert_eq!(content["imageUrl"], "https://pokoin.com/card-images/cards/1.jpg");
        assert!(content["hashtags"].as_array().unwrap().len() == 3);
    }

    #[test]
    fn text_helpers_match_reference() {
        assert_eq!(clean_social_text("a\r\n\r\n\r\n\r\nb", 100), "a\n\n\nb");
        assert_eq!(format_pkn(Some(2642.0)), "2,642 PKN");
        assert_eq!(format_pkn(Some(0.0)), "");
        assert_eq!(truncate_text("abcdefghij", 5), "ab...");
        assert_eq!(compose_with_suffix("hello", "https://x.y", 100), "hello\n\nhttps://x.y");
        let long = "x".repeat(300);
        let composed = compose_with_suffix(&long, "https://x.y", X_POST_LIMIT);
        assert!(composed.ends_with("https://x.y"));
        assert!(composed.chars().count() <= X_POST_LIMIT);
        assert_eq!(ensure_text_includes_url("no url", "https://x.y", 100), "no url\n\nhttps://x.y");
        assert_eq!(ensure_text_includes_url("has https://x.y", "https://x.y", 100), "has https://x.y");
    }

    #[test]
    fn targets_and_windows() {
        assert_eq!(clean_targets(None).unwrap(), vec!["telegram", "x"]);
        assert_eq!(clean_targets(Some(&json!("twitter,x,telegram"))).unwrap(), vec!["x", "telegram"]);
        assert!(clean_targets(Some(&json!("myspace"))).is_err());
        assert_eq!(clean_window("7D"), "7d");
        assert_eq!(clean_window("nope"), "24h");
        assert_eq!(clean_limit(Some(1000), 12), 100);
        assert_eq!(clean_limit(None, 12), 12);
    }

    #[test]
    fn card_ids_and_urls() {
        assert_eq!(clean_numeric_id("0012"), "12");
        assert_eq!(clean_numeric_id("abc"), "");
        assert_eq!(map_card_row(&json!({"card_id": "247", "name": "Mew"}))["cardId"], "494");
        assert_eq!(map_card_row(&json!({"blueprint_id": "55"}))["cardId"], "110");
        assert_eq!(slug_part("Base Set 4/102"), "base-set-4-102");
    }

    #[test]
    fn agent_normalization_keeps_the_url() {
        let fallback = build_post_content(&input(), "https://pokoin.com");
        let payload = json!({"telegramText": "Hello collectors", "xText": "Hi", "source": "agent"});
        let content = normalize_agent_content(&payload, &fallback).unwrap();
        assert!(content["telegramText"].as_str().unwrap().contains("Hello collectors"));
        assert!(content["telegramText"].as_str().unwrap().contains(&fallback["cardUrl"].as_str().unwrap().to_string()));
        assert_eq!(content["agent"]["source"], "agent");
        assert!(normalize_agent_content(&json!({}), &fallback).is_none());
    }

    #[test]
    fn dry_run_never_touches_providers() {
        let config = SocialConfig {
            site_url: "https://pokoin.com".into(),
            telegram_bot_token: String::new(),
            telegram_channel_id: String::new(),
            social_secret: String::new(),
            cron_secret: String::new(),
            agent_endpoint: DEFAULT_SOCIAL_AGENT_ENDPOINT.into(),
            agent_token: String::new(),
            image_max_bytes: SOCIAL_IMAGE_MAX_BYTES,
            x_bearer_token: String::new(),
            x_api_key: String::new(),
            x_api_secret: String::new(),
            x_access_token: String::new(),
            x_access_token_secret: String::new(),
            x_media_upload_url: String::new(),
            x_tweet_url: String::new(),
            http: reqwest::Client::new(),
        };
        let content = build_post_content(&input(), &config.site_url);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let telegram = runtime
            .block_on(post_to_telegram(&config, &content, true, true, false))
            .unwrap();
        assert_eq!(telegram["dryRun"], true);
        assert_eq!(telegram["payload"]["chat_id"], "");
        let x = runtime.block_on(post_to_x(&config, &content, true, true)).unwrap();
        assert_eq!(x["dryRun"], true);
    }
}
