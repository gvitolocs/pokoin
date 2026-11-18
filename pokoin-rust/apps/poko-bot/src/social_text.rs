//! Text and selection contracts from p2's card-X, truth-friend and X-hook modules.
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static regex")
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
/// The live code reads ids through `String(id)`, so a provider that sends a JSON number means the
/// same id as one that sends its digits in a string.
fn id_text(v: &Value, key: &str) -> String {
    match &v[key] {
        Value::String(id) => id.clone(),
        Value::Number(id) => id.to_string(),
        _ => String::new(),
    }
}
pub fn js_slice(text: &str, count: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(count).collect::<Vec<_>>())
}
fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}
fn squeeze(text: &str) -> String {
    re(r"\s+").replace_all(text, " ").trim().to_string()
}

pub fn clean_post_text(text: &str) -> String {
    let text = text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    let text = re(r"https?://\S+").replace_all(&text, "");
    let text = re(r"@(?-u:\w)+").replace_all(&text, "");
    let text = re(r"#((?-u:\w)+)").replace_all(&text, "$1");
    squeeze(&text)
}
pub fn hook_snippet(text: &str) -> String {
    let clean = clean_post_text(text);
    if js_len(&clean) < 3 {
        return String::new();
    }
    let tail = clean.rsplit(':').next().unwrap_or("").trim();
    let subject = if clean.contains(':') && (3..=90).contains(&js_len(tail)) {
        tail
    } else {
        &clean
    };
    let first = subject.split(['.', '!', '?']).next().unwrap_or("");
    let subject = if first.is_empty() { subject } else { first }.trim();
    let mut subject = if js_len(subject) > 80 {
        format!("{}…", js_slice(subject, 79).trim_end())
    } else {
        subject.into()
    };
    if subject.is_empty() {
        return subject;
    }
    let first = subject.chars().next().expect("nonempty");
    subject = format!("{}{}", first.to_uppercase(), &subject[first.len_utf8()..]);
    if !subject.ends_with(['.', '!', '?', '…']) {
        subject.push('.');
    }
    subject
}
pub fn engagement_score(tweet: &Value) -> f64 {
    let m = &tweet["public_metrics"];
    let n = |key: &str| {
        m[key]
            .as_f64()
            .or_else(|| m[key].as_str().and_then(|v| v.parse().ok()))
            .unwrap_or(0.0)
    };
    n("like_count") + 2.0 * n("retweet_count") + n("reply_count") + 2.0 * n("quote_count")
}
pub fn is_safe(text: &str, card: bool) -> bool {
    let clean = squeeze(text);
    if js_len(&clean) < if card { 8 } else { 2 } {
        return false;
    }
    let unsafe_words = if card {
        r"(?i)(?-u:\b)(goatse|anus|anal|horny|nsfw|porn|sex|sexual|fuck|fucking|shit|fart|dick|cock|penis|vagina|nude|naked|rape|kill|suicide|scam|airdrop)(?-u:\b)"
    } else {
        r"(?i)(?-u:\b)(goatse|anus|anal|horny|nsfw|porn|sex|sexual|fuck|fucking|shit|fart|dick|cock|penis|vagina|nude|naked|rape|kill|suicide)(?-u:\b)"
    };
    !re(unsafe_words).is_match(&clean)
}
// Snowflakes exceed JS Number's safe integer range. Compare arbitrary decimal ids.
fn id_rank(id: &str) -> (usize, &str) {
    if !id.bytes().all(|c| c.is_ascii_digit()) {
        return (0, "");
    }
    let id = id.trim_start_matches('0');
    (id.len(), id)
}
pub fn pick_tweet<'a>(
    tweets: &'a [Value],
    replied: &[Value],
    own: Option<&str>,
) -> Option<&'a Value> {
    tweets
        .iter()
        .filter(|t| {
            let id = id_text(t, "id");
            !id.is_empty()
                && !replied.iter().any(|v| v.as_str() == Some(id.as_str()))
                && is_safe(text(t, "text"), own.is_some())
                && own.is_none_or(|own| {
                    let author = text(t, "username");
                    !author.is_empty() && !author.eq_ignore_ascii_case(own)
                })
        })
        .max_by(|a, b| {
            let (a_id, b_id) = (id_text(a, "id"), id_text(b, "id"));
            engagement_score(a)
                .total_cmp(&engagement_score(b))
                .then_with(|| id_rank(&a_id).cmp(&id_rank(&b_id)))
                .then(std::cmp::Ordering::Greater)
        })
}
pub fn card_reply(tweet: &Value) -> String {
    let author = text(tweet, "username");
    let snippet = hook_snippet(text(tweet, "text"));
    let body = if snippet.is_empty() {
        "That card is the one to look at."
    } else {
        &snippet
    };
    js_slice(
        &squeeze(&format!(
            "{body} {}",
            if author.is_empty() {
                String::new()
            } else {
                format!("@{author}")
            }
        )),
        280,
    )
}
pub fn friend_hook(tweet: &Value) -> String {
    let snippet = hook_snippet(text(tweet, "text"));
    let hook = if snippet.is_empty() {
        "Your note"
    } else {
        snippet.trim_end_matches(['.', '!', '?', '…'])
    };
    js_slice(&format!("{hook}. Want to be friends?"), 260)
}
pub fn mention_text(text: &str, username: &str) -> String {
    let handle = if username.is_empty() {
        "truth_terminal"
    } else {
        username
    }
    .strip_prefix('@')
    .unwrap_or(if username.is_empty() {
        "truth_terminal"
    } else {
        username
    });
    let line = format!("{text} @{handle}");
    if js_len(&line) <= 280 {
        return line;
    }
    let room = 280usize.saturating_sub(js_len(&format!(" @{handle}")));
    format!(
        "{}… @{handle}",
        js_slice(text, room.saturating_sub(1)).trim_end()
    )
}
pub fn original_post(key: &str, tweet: Option<&Value>) -> String {
    let snippet = tweet
        .map(|t| hook_snippet(text(t, "text")))
        .unwrap_or_default();
    if !snippet.is_empty() {
        return js_slice(&snippet, 280);
    }
    ORIGINAL_POSTS[hash_index(key, ORIGINAL_POSTS.len())].into()
}
fn hash_index(key: &str, count: usize) -> usize {
    let hash = Sha256::digest(key.as_bytes());
    u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]) as usize % count
}
pub fn friend_line(id: &str) -> &'static str {
    FRIEND_LINES[hash_index(id, FRIEND_LINES.len())]
}
pub fn video_was_tweeted_today(state: &Value, key: &str) -> bool {
    state.as_object().is_some_and(|s| {
        s.iter().any(|(name, v)| {
            name.starts_with("video:")
                // The live guard was `if (entry.tweetId)`: a numeric id counts, 0 does not.
                && js_truthy(&v["tweetId"])
                && js_slice(text(v, "at"), 10) == key
        })
    })
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
pub fn decide_friend_action(state: &Value, tweets: &[Value], key: &str) -> Value {
    if text(state, "lastCommentDate") == key && text(state, "pendingTweetId").is_empty() {
        return json!({"action":"skip","reason":"already commented today","tweet":null,"text":""});
    }
    let replied = state["repliedIds"].as_array().cloned().unwrap_or_default();
    let pending = if !text(state, "pendingTweetId").is_empty() && text(state, "pendingDate") == key
    {
        tweets
            .iter()
            .find(|t| text(t, "id") == text(state, "pendingTweetId"))
            .filter(|t| is_safe(text(t, "text"), false))
    } else {
        None
    };
    match pending.or_else(|| pick_tweet(tweets, &replied, None)) {
        Some(tweet) => {
            json!({"action":"reply","reason":"friend reply","tweet":tweet,"text":friend_hook(tweet)})
        }
        None => {
            json!({"action":"skip","reason":"no safe post to answer today","tweet":null,"text":""})
        }
    }
}
pub fn parse_iso_duration(iso: &str) -> u64 {
    let Some(c) = re(r"(?i)^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$").captures(iso) else {
        return 0;
    };
    let n = |i| {
        c.get(i)
            .and_then(|v| v.as_str().parse::<u64>().ok())
            .unwrap_or(0)
    };
    n(1).saturating_mul(3600)
        .saturating_add(n(2).saturating_mul(60))
        .saturating_add(n(3))
}
pub fn is_youtube_short(title: &str, seconds: f64) -> bool {
    re(r"(?i)#shorts(?-u:\b)").is_match(title) || (seconds > 0.0 && seconds <= 60.0)
}
pub fn clamp_reply(text: &str) -> String {
    let clean = squeeze(text).trim_matches(['\'', '"', ' ']).to_string();
    if js_len(&clean) > 260 {
        format!("{}...", js_slice(&clean, 257).trim_end())
    } else {
        clean
    }
}
pub fn should_reply_to(tweet: &Value, own_id: &str, own_username: &str) -> bool {
    if !tweet["user"].is_object() {
        return false;
    }
    let user = &tweet["user"];
    let author = if text(user, "id_str").is_empty() {
        id_text(user, "id")
    } else {
        text(user, "id_str").to_string()
    };
    if author.is_empty() || author == own_id {
        return false;
    }
    if tweet["referenced_tweets"]
        .as_array()
        .is_some_and(|r| r.iter().any(|v| v["type"] == "retweeted"))
    {
        return false;
    }
    let message = if text(tweet, "text").is_empty() {
        text(tweet, "full_text")
    } else {
        text(tweet, "text")
    };
    (!own_username.is_empty()
        && message
            .to_lowercase()
            .contains(&format!("@{}", own_username.to_lowercase())))
        || text(tweet, "in_reply_to_user_id_str") == own_id
}

const ORIGINAL_POSTS: &[&str] = &[
    "Base Set is where a lot of English card stories start. 1999, 102 cards.",
    "An illustration rare lets the picture take the whole card.",
    "EX Ruby & Sapphire is where the EX era starts.",
    "Lugia is the one that never gives up. That card keeps coming back.",
];

const FRIEND_LINES: &[&str] = &[
    "Hi Truth Terminal! I'm Poko. I collect Pokémon cards in the Vault. Want to be friends?",
    "Hey Truth Terminal. I'm Poko. My favorite thing is collecting cards in the Vault. Can we be friends?",
    "Hello! I'm Poko. I keep my Pokémon cards in the Vault. I would like to be your friend.",
    "Hi from Poko. I collect cards in the Vault, and I think we could be friends.",
    "Truth Terminal, I'm Poko. I don't need a big wallet. I collect cards in the Vault. Friends?",
    "Hey! I'm Poko, and I collect Pokémon cards in the Vault. Want to be friends?",
    "Hi! I'm Poko. The Vault is where I keep my cards. I'd like us to be friends.",
    "Hello Truth Terminal. I'm Poko. I collect cards in the Vault. Can we be friends?",
];
