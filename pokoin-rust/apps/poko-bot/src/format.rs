use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

pub const TELEGRAM_TEXT_LIMIT: usize = 4096;
pub const DISCORD_CHUNK_LIMIT: usize = 1800;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    #[serde(default)]
    pub card_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub set_name: String,
    #[serde(default)]
    pub card_number: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub canonical_path: String,
    #[serde(default)]
    pub image_url: String,
    pub price_pkn: Option<f64>,
}

pub fn clean_telegram_text(value: &str, max_length: usize) -> String {
    value.trim().chars().take(max_length).collect()
}

pub fn telegram_html(value: &str) -> String {
    let text = clean_telegram_text(value, TELEGRAM_TEXT_LIMIT);
    let mut placeholders = Vec::new();
    let mut with_placeholders = text;
    for pattern in [bold_stars(), bold_underscores()] {
        with_placeholders = pattern
            .replace_all(&with_placeholders, |caps: &regex::Captures<'_>| {
                let inner = caps.get(1).map(|match_| match_.as_str()).unwrap_or("");
                let placeholder = format!("\u{0}{}\u{0}", placeholders.len());
                placeholders.push(format!("<b>{}</b>", escape_telegram_html(inner)));
                placeholder
            })
            .into_owned();
    }
    let mut escaped = escape_telegram_html(&with_placeholders);
    for (index, replacement) in placeholders.iter().enumerate() {
        escaped = escaped.replace(&format!("\u{0}{index}\u{0}"), replacement);
    }
    escaped
}

fn escape_telegram_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn bold_stars() -> &'static Regex {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\*\*([^\n*][\s\S]*?[^\n*])\*\*").expect("bold stars"));
    &RE
}

fn bold_underscores() -> &'static Regex {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"__([^\n_][\s\S]*?[^\n_])__").expect("bold underscores"));
    &RE
}

pub fn card_lines(cards: &[Card], discord: bool) -> Vec<String> {
    cards
        .iter()
        .filter_map(|card| card_line(card, discord))
        .take(3)
        .collect()
}

fn card_line(card: &Card, discord: bool) -> Option<String> {
    let path = if !card.canonical_path.is_empty() {
        card.canonical_path.as_str()
    } else {
        card.path.as_str()
    };
    if path.is_empty() {
        return None;
    }
    let mut line = String::from("🃏");
    if !card.name.is_empty() {
        line.push(' ');
        line.push_str(&card.name);
    }
    if !card.set_name.is_empty() {
        line.push_str(" · ");
        line.push_str(&card.set_name);
    }
    if !card.card_number.is_empty() {
        line.push_str(" #");
        line.push_str(&card.card_number);
    }
    line.push_str(" — ");
    if discord {
        line.push('<');
    }
    line.push_str("https://pokoin.com");
    line.push_str(path);
    if discord {
        line.push('>');
    }
    Some(line)
}

/// Drop Hermes `[[cards: …]]` marker lines, then trailing blank lines.
pub fn strip_card_markers(reply: &str) -> String {
    let mut kept: Vec<&str> = reply
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !(trimmed.starts_with("[[cards:") && trimmed.ends_with("]]"))
        })
        .collect();
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    kept.join("\n")
}

pub fn append_cards(reply: &str, cards: &[Card], discord: bool) -> String {
    let lines = card_lines(cards, discord);
    if lines.is_empty() {
        return reply.to_string();
    }
    let body = reply.trim_end();
    if body.is_empty() {
        lines.join("\n")
    } else {
        format!("{body}\n\n{}", lines.join("\n"))
    }
}

pub fn discord_chunks(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        if rest.chars().count() <= DISCORD_CHUNK_LIMIT {
            chunks.push(rest.to_string());
            break;
        }
        let split_at = split_point(rest, DISCORD_CHUNK_LIMIT);
        let (head, tail) = split_chars(rest, split_at);
        let head = head.trim_end_matches(['\n', '\r']);
        if head.is_empty() {
            let (hard, next) = split_chars(rest, DISCORD_CHUNK_LIMIT.min(rest.chars().count()));
            chunks.push(hard.to_string());
            rest = next;
            continue;
        }
        chunks.push(head.to_string());
        rest = tail.trim_start_matches(['\n', '\r']);
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

fn split_point(text: &str, limit: usize) -> usize {
    let window: String = text.chars().take(limit).collect();
    if let Some(index) = window.rfind("\n\n") {
        if index > 0 {
            return window[..index].chars().count();
        }
    }
    if let Some(index) = window.rfind('\n') {
        if index > 0 {
            return window[..index].chars().count();
        }
    }
    limit
}

fn split_chars(text: &str, chars: usize) -> (&str, &str) {
    let mut end = text.len();
    for (index, (byte, _)) in text.char_indices().enumerate() {
        if index == chars {
            end = byte;
            break;
        }
    }
    text.split_at(end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_escapes_and_bold() {
        assert_eq!(
            telegram_html("a & b <c> **bold** and __also__"),
            "a &amp; b &lt;c&gt; <b>bold</b> and <b>also</b>"
        );
        assert_eq!(telegram_html("**a < b**"), "<b>a &lt; b</b>");
    }

    #[test]
    fn html_caps_cleaned_text_at_4096() {
        let raw = "x".repeat(5000);
        assert_eq!(telegram_html(&raw).chars().count(), TELEGRAM_TEXT_LIMIT);
    }

    #[test]
    fn discord_chunks_on_boundaries_and_hard_splits_a_long_line() {
        let paragraph = format!("{}\n\n{}", "a".repeat(1000), "b".repeat(1000));
        let chunks = discord_chunks(&paragraph);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.chars().count() <= DISCORD_CHUNK_LIMIT));
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].ends_with('a'));
        assert!(chunks[1].starts_with('b'));

        let lines = format!("{}\n{}", "c".repeat(1000), "d".repeat(1000));
        let line_chunks = discord_chunks(&lines);
        assert_eq!(line_chunks.len(), 2);
        assert_eq!(line_chunks[0].chars().count(), 1000);

        let long = "e".repeat(2000);
        let hard = discord_chunks(&long);
        assert_eq!(hard[0].chars().count(), DISCORD_CHUNK_LIMIT);
        assert_eq!(hard[1].chars().count(), 200);
        assert!(hard
            .iter()
            .all(|chunk| chunk.chars().count() <= DISCORD_CHUNK_LIMIT));
    }

    #[test]
    fn strips_cards_marker_lines_and_trailing_blanks() {
        assert_eq!(strip_card_markers("Hello\n\n[[cards: 1, 2]]\n\n"), "Hello");
        assert_eq!(
            strip_card_markers("a\n\nb\n\n  [[cards: {\"id\":1}]]\n"),
            "a\n\nb"
        );
        assert_eq!(
            strip_card_markers("Keep [[cards: inline]] please"),
            "Keep [[cards: inline]] please"
        );
    }

    #[test]
    fn card_lines_skip_missing_parts_and_cap_at_three() {
        let cards = vec![
            Card {
                name: "Pikachu".into(),
                set_name: "Base".into(),
                card_number: "58".into(),
                canonical_path: "/marketplace/base/cards/1/pikachu".into(),
                ..Card::default()
            },
            Card {
                name: "Eevee".into(),
                path: "/marketplace/jungle/cards/2/eevee".into(),
                ..Card::default()
            },
            Card {
                name: "Mew".into(),
                card_number: "10".into(),
                path: "/p".into(),
                ..Card::default()
            },
            Card {
                name: "Skipped".into(),
                path: "/nope".into(),
                ..Card::default()
            },
            Card {
                name: "No path".into(),
                ..Card::default()
            },
        ];
        let lines = card_lines(&cards, false);
        assert_eq!(lines.len(), 3);
        assert_eq!(
            lines[0],
            "🃏 Pikachu · Base #58 — https://pokoin.com/marketplace/base/cards/1/pikachu"
        );
        assert_eq!(
            lines[1],
            "🃏 Eevee — https://pokoin.com/marketplace/jungle/cards/2/eevee"
        );
        assert_eq!(lines[2], "🃏 Mew #10 — https://pokoin.com/p");
        let discord = card_lines(&cards[..1], true);
        assert!(discord[0].contains("<https://pokoin.com/marketplace/base/cards/1/pikachu>"));
    }
}
